import { sha256 } from '@noble/hashes/sha2.js';

import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';
import type { S3FetchPort, S3UploadFilePort } from '@/features/byos/s3-transport';
import { base64Url, MICROSOFT_TOKEN_URL } from '@/features/cloud-store/microsoft-oauth';

import { createNodeDownloadFilePort } from './node-file-transfer';

/**
 * P12-C: an in-memory Microsoft Graph v1.0 + identity token endpoint the
 * OneDrive adapter's unit tests run against, so those tests fail for the same
 * protocol reasons the real backend would. The rules it ENFORCES — 320 KiB
 * upload-fragment unit, 60 MiB single-PUT ceiling, in-order fragments, NO
 * Authorization on the pre-authorized upload URL, refresh-token rotation on
 * every refresh, `invalid_grant` after revocation, and 507 at session creation
 * when the file exceeds remaining quota — were verified against the real Graph
 * endpoints and their docs on 2026-09-20.
 */
/** The Graph origin the adapter talks to; the fake answers only this host, the token host and its own upload host. */
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const UPLOAD_ORIGIN = 'https://fake.up.1drv.com';

type Item = { id: string; name: string; parentId: string | null; folder: boolean; bytes: Uint8Array };
type Session = { folderId: string; name: string; fileSize: number; parts: Uint8Array[]; next: number };
type Override = { status: number; body: unknown; headers: Record<string, string>; match: RegExp };

export type FakeGraphOptions = Readonly<{
  /** Graph's real unit is 320 KiB; tests shrink it so a "large" file stays small. */
  fragmentUnit?: number;
  /** Graph's real limit is 60 MiB per request. */
  singlePutLimit?: number;
  pageSize?: number;
  quotaTotal?: number;
  now?: () => number;
}>;

export type FakeGraphCall = Readonly<{ method: string; url: string; headers: Record<string, string> }>;

export type FakeGraph = Readonly<{
  fetch: S3FetchPort;
  /** The native download port's stand-in: reads the fake Graph response into an exclusive file. */
  downloadFile: S3DownloadFilePort;
  /** The native upload port's stand-in: reads the staged file from disk and PUTs it through `fetch`. */
  uploadFile: S3UploadFilePort;
  ids: Readonly<{ rootFolderId: string; stateFolderId: string; blobsFolderId: string }>;
  accountEmail: string;
  calls: FakeGraphCall[];
  issueRefreshToken(): string;
  issueAccessToken(ttlMs?: number): string;
  revokeRefreshTokens(): void;
  /** One-shot: the next Graph request whose URL matches answers this instead. */
  failNext(status: number, body?: unknown, headers?: Record<string, string>, match?: RegExp): void;
  authCode(challenge: string): string;
  fileNames(folderId: string): string[];
  fileBytes(folderId: string, name: string): Uint8Array | null;
  usedBytes(): number;
  sessions(): number;
  /** Drops every non-folder item and every upload session (models switching to a fresh account view without re-creating the graph). */
  clearFiles(): void;
  /** Drops the pre-created `state`/`blobs` folders so a first sign-in can be modelled; `ids.stateFolderId`/`blobsFolderId` then dangle. */
  clearFolders(): void;
  folderNames(folderId: string): string[];
}>;

const lower = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else if (h) for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
};
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const graphError = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  reply(status, { error: { code, message: code } }, headers);
const toBytes = async (body: BodyInit | null | undefined): Promise<Uint8Array> => {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
};

export function createFakeGraph(options: FakeGraphOptions = {}): FakeGraph {
  const fragmentUnit = options.fragmentUnit ?? 320 * 1024;
  const singlePutLimit = options.singlePutLimit ?? 60 * 1024 * 1024;
  const pageSize = options.pageSize ?? 1000;
  const quotaTotal = options.quotaTotal ?? 5 * 1024 ** 3;
  const now = options.now ?? Date.now;
  let seq = 0;
  const nextId = (p: string) => `${p}${(seq += 1).toString(36).padStart(4, '0')}`;
  const items = new Map<string, Item>();
  const mk = (name: string, parentId: string | null, folder: boolean, bytes: Uint8Array = new Uint8Array(0)): Item => {
    const item = { id: nextId(folder ? 'F' : 'f'), name, parentId, folder, bytes };
    items.set(item.id, item);
    return item;
  };
  const root = mk('Waifu Deck', null, true);
  const state = mk('state', root.id, true);
  const blobs = mk('blobs', root.id, true);
  const childOf = (parentId: string, name: string) => [...items.values()].find((i) => i.parentId === parentId && i.name === name) ?? null;
  const used = () => [...items.values()].reduce((n, i) => n + i.bytes.byteLength, 0);
  const refreshTokens = new Set<string>();
  const accessTokens = new Map<string, number>();
  const codes = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const overrides: Override[] = [];
  const calls: FakeGraphCall[] = [];
  const accountEmail = 'owner@example.com';
  const deleteTree = (id: string): void => {
    for (const child of [...items.values()].filter((c) => c.parentId === id)) deleteTree(child.id);
    items.delete(id);
  };
  const takeOverride = (href: string): Response | null => {
    const oi = overrides.findIndex((o) => o.match.test(href));
    if (oi === -1) return null;
    const [o] = overrides.splice(oi, 1);
    return reply(o!.status, o!.body, o!.headers);
  };
  const issueAccessToken = (ttlMs = 3600_000) => { const t = nextId('AT-'); accessTokens.set(t, now() + ttlMs); return t; };
  const issueRefreshToken = () => { const t = nextId('RT-'); refreshTokens.add(t); return t; };
  const tokenSet = () => ({ token_type: 'Bearer', scope: 'Files.ReadWrite.AppFolder offline_access User.Read', expires_in: 3599, access_token: issueAccessToken(), refresh_token: issueRefreshToken() });

  async function token(init: RequestInit): Promise<Response> {
    const f = new URLSearchParams(String(init.body ?? ''));
    const grant = f.get('grant_type');
    if (grant === 'refresh_token') {
      const rt = f.get('refresh_token') ?? '';
      if (!refreshTokens.has(rt)) return reply(400, { error: 'invalid_grant', error_description: 'AADSTS70000: refresh token revoked or expired' });
      refreshTokens.delete(rt); // rotation: the old token dies the moment the new one is issued
      return reply(200, tokenSet());
    }
    if (grant === 'authorization_code') {
      const challenge = codes.get(f.get('code') ?? '');
      const verifier = f.get('code_verifier') ?? '';
      if (challenge === undefined || base64Url(sha256(new TextEncoder().encode(verifier))) !== challenge) {
        return reply(400, { error: 'invalid_grant', error_description: 'AADSTS50148: code verifier mismatch' });
      }
      codes.delete(f.get('code')!);
      return reply(200, tokenSet());
    }
    return reply(400, { error: 'unsupported_grant_type' });
  }

  function upload(url: URL, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    return (async () => {
      const session = sessions.get(url.pathname.slice('/up/'.length));
      if (headers.authorization !== undefined) return graphError(401, 'uploadUrlIsPreauthorized');
      const ov = takeOverride(url.href);
      if (ov) return ov;
      if (session === undefined) return graphError(404, 'uploadSessionNotFound');
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] ?? '');
      if (m === null) return graphError(400, 'invalidRange');
      const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const body = await toBytes(init.body);
      const length = end - start + 1;
      if (total !== session.fileSize || body.byteLength !== length) return graphError(400, 'invalidRange');
      if (length >= singlePutLimit) return graphError(400, 'fragmentTooLarge');
      if (start !== session.next) return graphError(416, 'invalidRange');
      const final = end === total - 1;
      if (!final && length % fragmentUnit !== 0) return graphError(400, 'fragmentNotMultipleOf320KiB');
      session.parts.push(body);
      session.next = end + 1;
      if (!final) return reply(202, { nextExpectedRanges: [`${end + 1}-`] });
      const merged = new Uint8Array(total);
      let o = 0;
      for (const p of session.parts) { merged.set(p, o); o += p.byteLength; }
      const existing = childOf(session.folderId, session.name);
      if (existing) items.delete(existing.id);
      const item = mk(session.name, session.folderId, false, merged);
      sessions.delete(url.pathname.slice('/up/'.length));
      return reply(201, { id: item.id, name: item.name, size: total });
    })();
  }

  async function graph(url: URL, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1];
    const exp = bearer === undefined ? undefined : accessTokens.get(bearer);
    if (exp === undefined || exp <= now()) return graphError(401, 'InvalidAuthenticationToken');
    const ov = takeOverride(url.href);
    if (ov) return ov;
    const method = (init.method ?? 'GET').toUpperCase();
    const p = decodeURIComponent(url.pathname);
    if (p === '/v1.0/me') return reply(200, { id: 'user-1', mail: accountEmail, userPrincipalName: accountEmail });
    if (p === '/v1.0/me/drive') return reply(200, { id: 'drive-1', quota: { used: used(), total: quotaTotal, remaining: quotaTotal - used(), deleted: 0, state: 'normal' } });
    if (p === '/v1.0/me/drive/special/approot') return reply(200, { id: root.id, name: root.name, folder: {} });
    const children = /^\/v1\.0\/me\/drive\/items\/([^/:]+)\/children$/.exec(p);
    if (children) {
      const folder = items.get(children[1]!);
      if (!folder?.folder) return graphError(404, 'itemNotFound');
      if (method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string; folder?: object };
        if (childOf(folder.id, body.name)) return graphError(409, 'nameAlreadyExists');
        const item = mk(body.name, folder.id, body.folder !== undefined);
        return reply(201, { id: item.id, name: item.name, ...(item.folder ? { folder: {} } : { size: 0 }) });
      }
      const all = [...items.values()].filter((i) => i.parentId === folder.id).sort((a, b) => a.name.localeCompare(b.name));
      const skip = Number(url.searchParams.get('$skip') ?? '0');
      const page = all.slice(skip, skip + pageSize).map((i) => (i.folder ? { id: i.id, name: i.name, folder: { childCount: 0 } } : { id: i.id, name: i.name, size: i.bytes.byteLength }));
      const next = skip + pageSize < all.length ? { '@odata.nextLink': `${GRAPH_ORIGIN}/v1.0/me/drive/items/${folder.id}/children?$skip=${skip + pageSize}` } : {};
      return reply(200, { value: page, ...next });
    }
    const byId = /^\/v1\.0\/me\/drive\/items\/([^/:]+)$/.exec(p);
    if (byId) {
      const id = byId[1]!;
      const i = items.get(id);
      if (method === 'DELETE') { if (!i) return graphError(404, 'itemNotFound'); deleteTree(id); return new Response(null, { status: 204 }); }
      if (method !== 'GET') return graphError(405, 'methodNotAllowed');
      return i ? reply(200, { id: i.id, name: i.name }) : graphError(404, 'itemNotFound');
    }
    const addressed = /^\/v1\.0\/me\/drive\/items\/([^/:]+):\/([^/:]+):(\/content|\/createUploadSession)?$/.exec(p);
    if (!addressed) return graphError(400, 'invalidRequest');
    const folder = items.get(addressed[1]!);
    if (!folder?.folder) return graphError(404, 'itemNotFound');
    const name = addressed[2]!;
    const action = addressed[3] ?? '';
    const existing = childOf(folder.id, name);
    if (action === '/createUploadSession' && method === 'POST') {
      const body = JSON.parse(String(init.body)) as { fileSize?: number };
      const fileSize = body.fileSize ?? 0;
      if (fileSize > quotaTotal - (used() - (existing?.bytes.byteLength ?? 0))) return graphError(507, 'insufficientStorage');
      const sid = nextId('S');
      sessions.set(sid, { folderId: folder.id, name, fileSize, parts: [], next: 0 });
      return reply(200, { uploadUrl: `${UPLOAD_ORIGIN}/up/${sid}`, expirationDateTime: new Date(now() + 86_400_000).toISOString() });
    }
    if (action === '/content' && method === 'PUT') {
      const bytes = await toBytes(init.body);
      if (bytes.byteLength > quotaTotal - (used() - (existing?.bytes.byteLength ?? 0))) return graphError(507, 'insufficientStorage');
      const item = existing ?? mk(name, folder.id, false, bytes);
      if (existing) existing.bytes = bytes;
      return reply(existing ? 200 : 201, { id: item.id, name, size: bytes.byteLength });
    }
    if (action === '/content' && method === 'GET') {
      if (!existing || existing.folder) return graphError(404, 'itemNotFound');
      const res = new Response(existing.bytes as unknown as BodyInit, { status: 200, headers: { 'content-length': String(existing.bytes.byteLength), 'content-type': 'application/octet-stream' } });
      // What fetch hands back after following Graph's 302 to the download host.
      return Object.defineProperty(res, 'redirected', { value: true });
    }
    if (action === '' && method === 'DELETE') {
      if (!existing) return graphError(404, 'itemNotFound');
      items.delete(existing.id);
      return new Response(null, { status: 204 });
    }
    return graphError(405, 'methodNotAllowed');
  }

  const fetchImpl: S3FetchPort = async (input, init = {}) => {
    const url = new URL(input);
    const headers = lower(init.headers);
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), url: url.href, headers });
    if (url.href === MICROSOFT_TOKEN_URL) return token(init);
    if (url.origin === UPLOAD_ORIGIN) return upload(url, init, headers);
    if (url.origin === GRAPH_ORIGIN) return graph(url, init, headers);
    return new Response(null, { status: 502 });
  };

  return {
    fetch: fetchImpl,
    downloadFile: createNodeDownloadFilePort(fetchImpl as unknown as typeof fetch),
    uploadFile: async (req) => {
      const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
      const { fileURLToPath } = jest.requireActual('node:url') as typeof import('node:url');
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(fileURLToPath(req.fileUri)));
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') throw new Error(`ENOENT: ${String(e)}`);
        throw e;
      }
      const totalBytes = bytes.byteLength;
      req.onProgress?.({ bytesSent: 0, totalBytes });
      const res = await fetchImpl(req.url, { method: 'PUT', headers: req.headers, body: bytes as unknown as BodyInit, signal: req.signal });
      if (res.status >= 200 && res.status < 300) req.onProgress?.({ bytesSent: totalBytes, totalBytes });
      return { status: res.status, headers: lower(res.headers) };
    },
    ids: { rootFolderId: root.id, stateFolderId: state.id, blobsFolderId: blobs.id },
    accountEmail,
    calls,
    issueRefreshToken,
    issueAccessToken,
    revokeRefreshTokens: () => refreshTokens.clear(),
    failNext: (status, body = { error: { code: 'generalException', message: 'failNext' } }, headers = {}, match = /graph\.microsoft\.com/) => { overrides.push({ status, body, headers, match }); },
    authCode: (challenge) => { const c = nextId('C'); codes.set(c, challenge); return c; },
    fileNames: (folderId) => [...items.values()].filter((i) => i.parentId === folderId && !i.folder).map((i) => i.name).sort(),
    fileBytes: (folderId, name) => { const i = childOf(folderId, name); return i && !i.folder ? i.bytes : null; },
    usedBytes: used,
    sessions: () => sessions.size,
    clearFiles: () => { for (const i of [...items.values()]) if (!i.folder) items.delete(i.id); sessions.clear(); },
    clearFolders: () => { deleteTree(state.id); deleteTree(blobs.id); },
    folderNames: (folderId) => [...items.values()].filter((i) => i.parentId === folderId && i.folder).map((i) => i.name).sort(),
  };
}
