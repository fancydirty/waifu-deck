import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';
import type { S3FetchPort, S3UploadFilePort } from '@/features/byos/s3-transport';
import { GOOGLE_SCOPE, GOOGLE_TOKEN_URL } from '@/features/cloud-store/google-oauth';

import { createNodeDownloadFilePort } from './node-file-transfer';

/**
 * P12-D: an in-memory Google Drive v3 REST + Google token endpoint the Drive
 * adapter's unit tests run against, so those tests fail for the same protocol
 * reasons the real backend would (spec §4.3 P12-D 补裁 3, 5, 7, 8, 9). It
 * ENFORCES rather than accepts: a live bearer on every REST call (the upload
 * session URL alone is pre-authorized); `q` parsed into exactly five clause
 * shapes, anything else 400; `fields` honoured — a field the caller did not
 * ask for is not sent, so a forgotten `nextPageToken` or `size` fails here as
 * it would on Drive; multipart bodies parsed per RFC 2046; a resumable session
 * that answers 308 until the announced length arrives, with the quota checked
 * on that content PUT and never at session creation; same-name files with
 * distinct `createdTime`; `size` and every quota count as STRING int64s, no
 * `size` on folders and no `limit` on an unlimited plan; a refresh answer that
 * carries no `refresh_token` (Google does not rotate); Drive's failure
 * envelope `{error:{code,message,errors:[{message,domain,reason}],status?}}`
 * (an unknown upload session alone is a plain-text 404 `Not Found`, as measured);
 * and, to a request without a usable credential, exactly what Drive answered
 * when measured on 2026-09-22 (a local log
 * "Task 4 fact check"; per endpoint in p12d-t4-auth-probe-2026-09-22.log).
 *
 * Where Drive leaves an order unspecified (no `orderBy`, or equal
 * `createdTime`s) the double answers newest-first: the order that breaks an
 * adapter relying on it instead of applying §3.4's earliest-then-smallest-id
 * rule itself.
 *
 * Not modelled, each refused with a loud 400 that names the double (never a
 * silent wrong answer, never a retryable-looking 5xx): metadata-only creates
 * other than the folder form used by layout bootstrap; every OAuth grant but
 * `refresh_token`; real Drive fields outside the modelled set and the
 * `files/id` fields form; the `'root'` parents alias; session metadata in any
 * encoding but `application/json; charset=UTF-8`; and any URL it does not serve.
 */
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';
const DRIVE_ORIGIN = 'https://www.googleapis.com';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** `bytes === null` marks a folder; `parentId === null` is the user's My Drive root. */
type Item = { id: string; name: string; parentId: string | null; mimeType: string; appProperties: Record<string, string>; bytes: Uint8Array | null; createdTime: string };
type Meta = { name: string; parentId: string | null; mimeType: string | undefined; appProperties: Record<string, string> };
type Session = { meta: Meta; announced: number | undefined; fields: string | null };
type Override = { status: number; body: unknown; headers: Record<string, string>; match: RegExp; repeat: boolean };

export type FakeDriveOptions = Readonly<{
  /** Capacity in bytes, reported by `about` and enforced on uploads; `null` = unlimited (no `limit`). Default 15 GiB. */
  quotaTotal?: number | null;
  /** A server-side page cap under the caller's `pageSize` (Drive may return partial pages). Default: Drive's own 1000. */
  pageSize?: number;
  /** Every listing answer carries a `nextPageToken`, so an adapter's page bound can be proved. */
  neverEndPaging?: boolean;
  now?: () => number;
  /** Start without the pre-seeded Waifu Deck/state/blobs layout (Task 7). */
  emptyLayout?: boolean;
}>;

export type FakeDriveCall = Readonly<{ method: string; url: string; headers: Record<string, string> }>;
export type FakeDriveFile = Readonly<{ id: string; name: string; parentId: string | null; mimeType: string; createdTime: string; folder: boolean }>;

export type FakeDrive = Readonly<{
  fetch: S3FetchPort;
  /** The native download port's stand-in: reads the fake Drive response into an exclusive file. */
  downloadFile: S3DownloadFilePort;
  /** The native upload port's stand-in: reads the staged file from disk and PUTs it through `fetch` in one request. */
  uploadFile: S3UploadFilePort;
  /** Throws under `emptyLayout`: there is no layout until the bootstrap creates one. */
  ids: Readonly<{ rootFolderId: string; stateFolderId: string; blobsFolderId: string }>;
  accountEmail: string;
  /** Google never rotates it (补裁 3): one grant, one refresh token, valid until `revoke()`. */
  refreshToken: string;
  calls: FakeDriveCall[];
  issueAccessToken(ttlMs?: number): string;
  /** The user revoked the app: the refresh token answers `invalid_grant` and every live access token stops working. */
  revoke(): void;
  /** One-shot: the next request whose URL matches answers this instead. */
  failNext(status: number, body?: unknown, headers?: Record<string, string>, match?: RegExp): void;
  /** Repeating sibling of `failNext`; keeps answering until the returned function clears it. */
  alwaysFail(status: number, body?: unknown, match?: RegExp): () => void;
  /** Seeds a file through the real multipart parser (not logged in `calls`, immune to the failure knobs); resolves its id. */
  putMultipart(parentFolderId: string, name: string, bytes: Uint8Array): Promise<string>;
  fileNames(folderId: string): string[];
  fileById(id: string): FakeDriveFile | null;
  /** The earliest-created file of that name (§3.4), or null. */
  fileBytes(folderId: string, name: string): Uint8Array | null;
  usedBytes(): number;
  sessions(): number;
  /** Drops every file and every upload session; folders stay. */
  clearFiles(): void;
  /** Deletes `state`/`blobs` (models a user deleting them in Drive); `ids.stateFolderId`/`blobsFolderId` then dangle. */
  clearFolders(): void;
  folderNames(folderId: string): string[];
  /** Runtime switch for the `neverEndPaging` option. */
  neverEndPaging(on?: boolean): void;
}>;

const lower = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else if (h) for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
};
const JSON_TYPE = 'application/json; charset=UTF-8';
const hasRetryAfter = (headers: Record<string, string>) => Object.keys(headers).some((h) => h.toLowerCase() === 'retry-after');
/**
 * Every answer the double gives is built here, so 补裁 8 ("Drive never sends Retry-After") holds by construction:
 * an answer that carries one is a bug in the double and fails the request loudly.
 */
const respond = (body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response => {
  if (hasRetryAfter(headers)) throw new Error('fake Drive: Drive never sends Retry-After (补裁 8)');
  return new Response(body, { status, headers });
};
const reply = (status: number, body: unknown): Response => respond(JSON.stringify(body), status, { 'content-type': JSON_TYPE });
/**
 * Drive's failure envelope (补裁 8), `{error:{code,message,errors:[{message,domain,reason,…}],status?}}`; callers
 * classify on `error.errors[0].reason` plus the HTTP status. `first` sets or overrides fields of `errors[0]`.
 */
const envelope = (code: number, message: string, first: Record<string, string>, status?: string): Response =>
  reply(code, { error: { code, message, errors: [{ message, domain: 'global', ...first }], ...(status === undefined ? {} : { status }) } });
const driveError = (code: number, reason: string, message: string, domain = 'global'): Response => envelope(code, message, { reason, domain });
// A request without a usable credential, answered exactly as Drive answered it when measured (2026-09-22, header).
const AUTH_HINT = 'Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.';
const IN_HEADER = { location: 'Authorization', locationType: 'header' };
/** No Authorization header, on a read method that also takes API keys (files.list, files.get). */
const unregisteredCaller = (): Response =>
  envelope(403, "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.", { reason: 'forbidden' }, 'PERMISSION_DENIED');
/** The same for `alt=media`, which answers in the API-key wording and without a `status`. */
const missingApiKey = (): Response => envelope(403, 'The request is missing a valid API key.', { reason: 'forbidden' });
/** No Authorization header anywhere else: about, delete, create, both uploads. */
const credentialMissing = (): Response =>
  envelope(401, `Request is missing required authentication credential. ${AUTH_HINT}`, { message: 'Login Required.', reason: 'required', ...IN_HEADER }, 'UNAUTHENTICATED');
/** An Authorization header that is not a live bearer: bogus, expired or revoked. */
const credentialInvalid = (): Response =>
  envelope(401, `Request had invalid authentication credentials. ${AUTH_HINT}`, { message: 'Invalid Credentials', reason: 'authError', ...IN_HEADER }, 'UNAUTHENTICATED');
/** A request the double cannot answer honestly fails loudly instead of looking like a real Drive answer. */
const notModelled = (what: string): Response => driveError(400, 'badRequest', `fake Drive does not model ${what}`);
const toBytes = async (body: BodyInit | null | undefined): Promise<Uint8Array> => {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
};

/** A parsed `fields` parameter: key → its sub-selection, or null for the whole value. */
type Selection = Map<string, Selection | null>;
/**
 * Per resource: every field real Drive has (listed from the v3 reference pages for File, About, User and files.list on
 * 2026-09-22) and the subset the double models. `fields` is checked up front, whatever the data: a name Drive does not
 * have is refused in Drive's words, a real field the double does not model is refused as not modelled.
 */
type Schema = Readonly<{ real: ReadonlySet<string>; modelled: Readonly<Record<string, Schema | true>> }>;
const schema = (real: string, modelled: Record<string, Schema | true>): Schema => ({ real: new Set(real.split(',')), modelled });
const FILE = schema(
  'kind,driveId,fileExtension,copyRequiresWriterPermission,md5Checksum,contentHints,writersCanShare,viewedByMe,' +
    'mimeType,exportLinks,parents,thumbnailLink,iconLink,shared,lastModifyingUser,owners,headRevisionId,' +
    'sharingUser,webViewLink,webContentLink,size,viewersCanCopyContent,permissions,hasThumbnail,spaces,' +
    'folderColorRgb,id,name,description,starred,trashed,explicitlyTrashed,createdTime,modifiedTime,' +
    'modifiedByMeTime,viewedByMeTime,sharedWithMeTime,quotaBytesUsed,version,originalFilename,ownedByMe,' +
    'fullFileExtension,properties,appProperties,isAppAuthorized,teamDriveId,capabilities,hasAugmentedPermissions,' +
    'trashingUser,thumbnailVersion,trashedTime,modifiedByMe,permissionIds,imageMediaMetadata,videoMediaMetadata,' +
    'shortcutDetails,contentRestrictions,resourceKey,linkShareMetadata,labelInfo,sha1Checksum,sha256Checksum,' +
    'inheritedPermissionsDisabled,downloadRestrictions,clientEncryptionDetails',
  { kind: true, id: true, name: true, mimeType: true, size: true, createdTime: true, trashed: true, appProperties: true },
);
const FILE_LIST = schema('files,nextPageToken,kind,incompleteSearch', { kind: true, nextPageToken: true, incompleteSearch: true, files: FILE });
const ABOUT = schema(
  'driveThemes,importFormats,exportFormats,folderColorPalette,maxImportSizes,teamDriveThemes,kind,storageQuota,' +
    'canCreateDrives,appInstalled,user,maxUploadSize,canCreateTeamDrives',
  {
    kind: true,
    storageQuota: schema('limit,usageInDrive,usageInDriveTrash,usage', { limit: true, usage: true, usageInDrive: true, usageInDriveTrash: true }),
    user: schema('displayName,kind,me,permissionId,emailAddress,photoLink', { kind: true, displayName: true, emailAddress: true }),
  },
);
/** Drive v3's answer when a request names no `fields`: a small default set, not the whole resource. */
const DEFAULT_FILE_FIELDS = 'kind,id,name,mimeType';
const DEFAULT_LIST_FIELDS = `kind,incompleteSearch,nextPageToken,files(${DEFAULT_FILE_FIELDS})`;

function parseSelection(spec: string): Selection | null {
  let at = 0;
  const skip = () => { while (spec[at] === ' ') at += 1; };
  const group = (close: string | null): Selection | null => {
    const out: Selection = new Map();
    for (;;) {
      skip();
      const key = /^(\*|[A-Za-z][A-Za-z0-9]*)/.exec(spec.slice(at))?.[1];
      if (key === undefined) return null;
      at += key.length;
      skip();
      let sub: Selection | null = null;
      if (spec[at] === '(') {
        at += 1;
        sub = group(')');
        if (sub === null) return null;
        skip();
      }
      out.set(key, sub);
      if (spec[at] === ',') { at += 1; continue; }
      if (close !== null && spec[at] === close) { at += 1; return out; }
      return close === null && at === spec.length ? out : null;
    }
  };
  return group(null);
}

/** The first field a selection names that the double cannot answer; `real` tells a real-but-unmodelled field from a name Drive lacks. */
function refusedField(selection: Selection, s: Schema): Readonly<{ key: string; real: boolean }> | null {
  for (const [key, sub] of selection) {
    if (key === '*') continue;
    const inner = Object.hasOwn(s.modelled, key) ? s.modelled[key] : undefined;
    if (inner === undefined) return { key, real: s.real.has(key) };
    if (sub === null) continue;
    if (inner === true) return { key: `${key}(…)`, real: true }; // a sub-selection the double does not model
    const deeper = refusedField(sub, inner);
    if (deeper !== null) return deeper;
  }
  return null;
}
/** Projects `value` onto a selection `refusedField` has accepted. */
function select(value: Record<string, unknown>, selection: Selection, s: Schema): Record<string, unknown> {
  if (selection.has('*')) return value;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of selection) {
    const v = value[key];
    if (v === undefined) continue; // absent on this instance: a folder's size, an unlimited plan's limit
    const inner = s.modelled[key];
    if (sub === null || inner === true) out[key] = v;
    else out[key] = Array.isArray(v) ? v.map((e) => select(e as Record<string, unknown>, sub, inner)) : select(v as Record<string, unknown>, sub, inner);
  }
  return out;
}
/** Renders `value` the way Drive would for this `fields` parameter (Drive's default set when it is absent). */
function shaped(value: Record<string, unknown>, fields: string | null, fallback: string, s: Schema): Response {
  const spec = fields || fallback;
  // Drive also takes the `files/id` sub-selection form; the double parses only the parenthesised one.
  if (spec.includes('/')) return notModelled(`the fields form "${spec}"`);
  const selection = parseSelection(spec);
  if (selection === null) return driveError(400, 'invalidParameter', `Invalid field selection ${spec}`);
  const refused = refusedField(selection, s);
  if (refused !== null) return refused.real ? notModelled(`the field ${refused.key}`) : driveError(400, 'invalidParameter', `Invalid field selection ${refused.key}`);
  return reply(200, select(value, selection, s));
}

/** One recognised `q` clause, compiled to a row test. */
type Predicate = (item: Item) => boolean;
/** A Drive query string literal: single-quoted, with `\'` and `\\` escaped. */
const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`;
const unquote = (s: string) => s.replace(/\\(.)/g, '$1');
/**
 * Exactly the five clause shapes the adapter's queries use (补裁 5, 7). Anything
 * else is refused with 400 rather than ignored: a double that silently drops a
 * clause would let the adapter ship a query the real API narrows differently.
 * A compiler answers null for a value it does not model — `'root'` is Drive's
 * My Drive alias, which the adapter never uses and the double cannot answer.
 */
const CLAUSES: readonly (readonly [RegExp, (m: RegExpExecArray) => Predicate | null])[] = [
  [new RegExp(String.raw`^${LITERAL}\s+in\s+parents$`), (m) => { const id = unquote(m[1]); return id === 'root' ? null : (i) => i.parentId === id; }],
  [/^trashed\s*=\s*(true|false)$/, (m) => { const trashed = m[1] === 'true'; return () => !trashed; }], // the double never trashes
  [new RegExp(String.raw`^name\s*=\s*${LITERAL}$`), (m) => { const name = unquote(m[1]); return (i) => i.name === name; }],
  [new RegExp(String.raw`^mimeType\s*=\s*${LITERAL}$`), (m) => { const type = unquote(m[1]); return (i) => i.mimeType === type; }],
  [new RegExp(String.raw`^appProperties\s+has\s*\{\s*key\s*=\s*${LITERAL}\s+and\s+value\s*=\s*${LITERAL}\s*\}$`), (m) => { const [k, v] = [unquote(m[1]), unquote(m[2])]; return (i) => i.appProperties[k] === v; }],
];

/** Splits a query on its top-level ` and `s — never inside a quoted literal or `{ … }`; null when unbalanced. */
function splitAnd(q: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i];
    if (quoted) {
      if (c === '\\') i += 1;
      else if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 0) {
      const sep = /^\s+and\s+/.exec(q.slice(i))?.[0];
      if (sep !== undefined) { parts.push(q.slice(start, i)); i += sep.length - 1; start = i + 1; }
    }
    if (depth < 0) return null;
  }
  if (quoted || depth !== 0) return null;
  parts.push(q.slice(start));
  return parts;
}

/** The compiled query, or the first clause the double does not recognise. */
function parseQuery(q: string): { ok: true; test: Predicate } | { ok: false; clause: string } {
  const parts = splitAnd(q);
  if (parts === null) return { ok: false, clause: q };
  const tests: Predicate[] = [];
  for (const raw of parts) {
    const clause = raw.trim();
    let test: Predicate | undefined;
    for (const [re, compile] of CLAUSES) {
      const m = re.exec(clause);
      if (m !== null) { test = compile(m) ?? undefined; break; }
    }
    if (test === undefined) return { ok: false, clause };
    tests.push(test);
  }
  return { ok: true, test: (item) => tests.every((t) => t(item)) };
}

const ascii = (s: string) => new TextEncoder().encode(s);
const startsAt = (hay: Uint8Array, needle: Uint8Array, i: number) => needle.every((b, j) => hay[i + j] === b);
const find = (hay: Uint8Array, needle: Uint8Array, from: number): number => {
  for (let i = from; i + needle.length <= hay.length; i += 1) if (startsAt(hay, needle, i)) return i;
  return -1;
};
/** `multipart/related; boundary=…` → the boundary, or null. */
const boundaryOf = (contentType: string): string | null => {
  if (!/^multipart\/related\s*;/i.test(contentType)) return null;
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m === null ? null : (m[1] ?? m[2]);
};
type Part = { headers: Record<string, string>; content: Uint8Array };
/**
 * An RFC 2046 multipart body (CRLF line breaks, as the RFC requires) → its
 * parts, or null when malformed: no opening delimiter, a header block without
 * its blank line, or no close delimiter. Byte-level, because the media part is
 * ciphertext and must survive untouched.
 */
function parseMultipart(body: Uint8Array, boundary: string): Part[] | null {
  const open = ascii(`--${boundary}`);
  const next = ascii(`\r\n--${boundary}`);
  const blank = ascii('\r\n\r\n');
  if (!startsAt(body, open, 0)) return null;
  const parts: Part[] = [];
  let i = open.length;
  for (;;) {
    if (body[i] === 0x2d && body[i + 1] === 0x2d) return parts; // "--": the close delimiter
    if (body[i] !== 0x0d || body[i + 1] !== 0x0a) return null;
    const headEnd = find(body, blank, i);
    if (headEnd === -1) return null;
    const headers: Record<string, string> = {};
    const text = new TextDecoder().decode(body.slice(i + 2, Math.max(i + 2, headEnd)));
    for (const line of text === '' ? [] : text.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon <= 0) return null;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const end = find(body, next, headEnd + 4);
    if (end === -1) return null;
    parts.push({ headers, content: body.slice(headEnd + 4, end) });
    i = end + next.length;
  }
}

export function createFakeDrive(options: FakeDriveOptions = {}): FakeDrive {
  const now = options.now ?? Date.now;
  const quotaTotal = options.quotaTotal === undefined ? 15 * 1024 ** 3 : options.quotaTotal;
  const pageCap = options.pageSize ?? 1000;
  let endless = options.neverEndPaging ?? false;
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${(seq += 1).toString(36).padStart(6, '0')}`;
  const items = new Map<string, Item>();
  const mk = (meta: Meta, bytes: Uint8Array | null): Item => {
    const item: Item = {
      id: nextId('1Df'),
      name: meta.name,
      parentId: meta.parentId,
      mimeType: meta.mimeType ?? (bytes === null ? DRIVE_FOLDER_MIME : 'application/octet-stream'),
      appProperties: meta.appProperties,
      bytes: bytes === null ? null : bytes.slice(), // own the bytes: a caller reusing its buffer must not rewrite the file
      createdTime: new Date(now()).toISOString(),
    };
    items.set(item.id, item);
    return item;
  };
  const folder = (name: string, parentId: string | null, appProperties: Record<string, string> = {}) =>
    mk({ name, parentId, mimeType: DRIVE_FOLDER_MIME, appProperties }, null);
  const root = options.emptyLayout ? null : folder('Waifu Deck', null, { waifuDeck: 'root' });
  const state = root === null ? null : folder('state', root.id);
  const blobs = root === null ? null : folder('blobs', root.id);
  const children = (parentId: string) => [...items.values()].filter((i) => i.parentId === parentId);
  const used = () => [...items.values()].reduce((n, i) => n + (i.bytes?.byteLength ?? 0), 0);
  const overQuota = (adding: number) => quotaTotal !== null && used() + adding > quotaTotal;
  const quotaExceeded = () => driveError(403, 'storageQuotaExceeded', "The user's Drive storage quota has been exceeded.", 'usageLimits');
  const deleteTree = (id: string): void => {
    for (const child of children(id)) deleteTree(child.id);
    items.delete(id);
  };
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Set<string>();
  const issueAccessToken = (ttlMs = 3_600_000) => { const t = nextId('ya29.fake-'); accessTokens.set(t, now() + ttlMs); return t; };
  const refreshToken = nextId('1//fake-refresh-');
  refreshTokens.add(refreshToken);
  const accountEmail = 'owner@example.com';
  const sessions = new Map<string, Session>();
  const overrides: Override[] = [];
  const calls: FakeDriveCall[] = [];
  const takeOverride = (href: string): Response | null => {
    const o = overrides.find((c) => c.match.test(href));
    if (o === undefined) return null;
    if (!o.repeat) overrides.splice(overrides.indexOf(o), 1);
    // A string body goes out verbatim: an HTML captive portal must not arrive JSON-encoded.
    const body = o.body === undefined ? null : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    return respond(body, o.status, { 'content-type': JSON_TYPE, ...o.headers });
  };
  const failure = (status: number) => ({ error: { errors: [{ domain: 'global', reason: 'failNext', message: 'failNext' }], code: status, message: 'failNext' } });

  function token(init: RequestInit): Response {
    const form = new URLSearchParams(String(init.body ?? ''));
    if (!form.get('client_id')) return reply(400, { error: 'invalid_request', error_description: 'Missing required parameter: client_id' });
    if (form.get('grant_type') !== 'refresh_token') return reply(400, { error: 'unsupported_grant_type', error_description: `fake Drive models only the refresh_token grant, not ${form.get('grant_type')}` });
    if (!refreshTokens.has(form.get('refresh_token') ?? '')) return reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    // 补裁 3: Google does not rotate, so the refresh answer carries NO refresh_token.
    return reply(200, { access_token: issueAccessToken(3_599_000), expires_in: 3599, scope: GOOGLE_SCOPE, token_type: 'Bearer' });
  }

  /**
   * Null for a live bearer; otherwise Drive's measured refusal. With NO Authorization header, GET on files.list or
   * files.get (the methods that also take API keys) is 403, anything else 401 required; any Authorization that is
   * not a live bearer is 401 authError.
   */
  const unauthorized = (method: string, url: URL, headers: Record<string, string>): Response | null => {
    if (headers.authorization === undefined) {
      if (method !== 'GET' || !/^\/drive\/v3\/files(\/[^/]+)?$/.test(url.pathname)) return credentialMissing();
      return url.searchParams.get('alt') === 'media' ? missingApiKey() : unregisteredCaller();
    }
    const bearer = /^Bearer (.+)$/.exec(headers.authorization)?.[1];
    const expiresAt = bearer === undefined ? undefined : accessTokens.get(bearer);
    return expiresAt === undefined || expiresAt <= now() ? credentialInvalid() : null;
  };

  const resource = (i: Item): Record<string, unknown> => ({
    kind: 'drive#file',
    id: i.id,
    name: i.name,
    mimeType: i.mimeType,
    // 补裁 5: `size` is a STRING int64, and a folder has no `size` field at all.
    ...(i.bytes === null ? {} : { size: String(i.bytes.byteLength) }),
    createdTime: i.createdTime,
    trashed: false,
    ...(Object.keys(i.appProperties).length === 0 ? {} : { appProperties: { ...i.appProperties } }),
  });
  const newestFirst = (a: Item, b: Item) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  function list(url: URL): Response {
    const q = url.searchParams.get('q');
    let rows = [...items.values()];
    if (q) {
      const query = parseQuery(q);
      if (!query.ok) return notModelled(`the q clause "${query.clause}"`);
      rows = rows.filter(query.test);
    }
    const orderBy = url.searchParams.get('orderBy');
    if (orderBy === 'createdTime') rows.sort((a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : newestFirst(a, b)));
    else if (orderBy === null) rows.sort(newestFirst);
    else return notModelled(`orderBy=${orderBy}`);
    const asked = url.searchParams.get('pageSize') ?? '100';
    if (!/^\d+$/.test(asked) || Number(asked) < 1) return driveError(400, 'invalid', `Invalid value '${asked}'. Values must be within the range: [1, 1000]`);
    // 补裁 5: a pageSize above 1000 is coerced to 1000; the pageSize option models a partial page below that.
    const size = Math.min(Number(asked), 1000, pageCap);
    const pageToken = url.searchParams.get('pageToken');
    const start = pageToken === null ? 0 : Number(/^p(\d+)$/.exec(pageToken)?.[1] ?? Number.NaN);
    if (Number.isNaN(start)) return driveError(400, 'invalid', 'Invalid Value');
    const end = Math.min(start + size, rows.length);
    const more = endless || end < rows.length;
    const page = { kind: 'drive#fileList', incompleteSearch: false, ...(more ? { nextPageToken: `p${end}` } : {}), files: rows.slice(start, end).map(resource) };
    return shaped(page, url.searchParams.get('fields'), DEFAULT_LIST_FIELDS, FILE_LIST);
  }

  function byId(url: URL, method: string, id: string): Response {
    const i = items.get(id);
    const missing = () => driveError(404, 'notFound', `File not found: ${id}.`);
    if (method === 'DELETE') {
      if (i === undefined) return missing();
      // 补裁 5: permanent, and "If the target is a folder, all descendants owned by the user are also deleted."
      deleteTree(id);
      return respond(null, 204);
    }
    if (method !== 'GET') return notModelled(`${method} on files/{fileId}`);
    if (i === undefined) return missing();
    const alt = url.searchParams.get('alt');
    if (alt === 'media') {
      if (i.bytes === null) return driveError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded. Use Export with Docs Editors files.');
      return respond(i.bytes.slice() as unknown as BodyInit, 200, { 'content-type': i.mimeType, 'content-length': String(i.bytes.byteLength) });
    }
    if (alt !== null && alt !== 'json') return notModelled(`alt=${alt}`);
    return shaped(resource(i), url.searchParams.get('fields'), DEFAULT_FILE_FIELDS, FILE);
  }

  /** Create metadata → the double's view of it, or Drive's answer refusing it. */
  const readMeta = (raw: unknown): Meta | Response => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return driveError(400, 'badRequest', 'Invalid metadata: expected a JSON object');
    const m = raw as Record<string, unknown>;
    const parents = m.parents ?? [];
    if (!Array.isArray(parents) || parents.length > 1) return notModelled('a create with other than zero or one parent id');
    // No parent = My Drive root. An empty-string id is just a missing parent (404 below), never root.
    const parentId = parents.length === 0 ? null : String(parents[0]);
    // Drive addresses by parent id: a missing (or non-folder) parent is refused, never silently re-homed.
    if (parentId !== null && items.get(parentId)?.bytes !== null) return driveError(404, 'notFound', `File not found: ${parentId}.`);
    return {
      name: typeof m.name === 'string' ? m.name : 'Untitled',
      parentId,
      mimeType: typeof m.mimeType === 'string' ? m.mimeType : undefined,
      appProperties: typeof m.appProperties === 'object' && m.appProperties !== null ? { ...(m.appProperties as Record<string, string>) } : {},
    };
  };

  async function multipartCreate(url: URL, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    const malformed = () => driveError(400, 'badRequest', 'Malformed multipart body.');
    const boundary = boundaryOf(headers['content-type'] ?? '');
    const parts = boundary === null ? null : parseMultipart(await toBytes(init.body), boundary);
    // Exactly two parts, metadata (JSON) first and then the media (补裁 5).
    if (parts === null || parts.length !== 2 || !/^application\/json\b/i.test(parts[0].headers['content-type'] ?? '')) return malformed();
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parts[0].content));
    } catch {
      return malformed();
    }
    const meta = readMeta(raw);
    if (meta instanceof Response) return meta;
    const media = parts[1];
    if (overQuota(media.content.byteLength)) return quotaExceeded();
    const item = mk({ ...meta, mimeType: meta.mimeType ?? media.headers['content-type'] }, media.content);
    return shaped(resource(item), url.searchParams.get('fields'), DEFAULT_FILE_FIELDS, FILE);
  }

  async function resumableInit(url: URL, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    // The adapter sends its session metadata exactly this way (Task 6); the double models no other encoding.
    const type = headers['content-type'];
    if (type?.replace(/\s+/g, '').toLowerCase() !== 'application/json;charset=utf-8') return notModelled(`session metadata sent as ${type === undefined ? 'no content-type' : `"${type}"`}`);
    const text = new TextDecoder().decode(await toBytes(init.body));
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return driveError(400, 'parseError', 'Parse Error');
      }
    }
    const meta = readMeta(raw);
    if (meta instanceof Response) return meta;
    const length = headers['x-upload-content-length'];
    if (length !== undefined && !/^\d+$/.test(length)) return driveError(400, 'badRequest', `Invalid X-Upload-Content-Length: ${length}`);
    const sid = nextId('up-');
    // 补裁 5/9: NO quota pre-check — the session is created happily; a full Drive shows only on the content PUT.
    sessions.set(sid, { meta: { ...meta, mimeType: meta.mimeType ?? headers['x-upload-content-type'] }, announced: length === undefined ? undefined : Number(length), fields: url.searchParams.get('fields') });
    // 补裁 5: 200, an EMPTY body, and the session URI in Location.
    return respond(null, 200, { location: `${DRIVE_UPLOAD_URL}?uploadType=resumable&upload_id=${sid}` });
  }

  async function sessionPut(url: URL, init: RequestInit, method: string): Promise<Response> {
    const sid = url.searchParams.get('upload_id') ?? '';
    const session = sessions.get(sid);
    // 补裁 5: 404 = the session expired or was already consumed; the caller must start over. Measured 2026-09-22
    // (p12d-t4-auth-probe log): the upload host says it in plain text, not in Drive's JSON envelope.
    if (session === undefined) return respond('Not Found', 404, { 'content-type': 'text/plain; charset=utf-8' });
    if (method !== 'PUT') return notModelled(`${method} on an upload session`);
    // The single-request form (补裁 5): the body is the file from byte 0, with no Content-Range.
    const bytes = await toBytes(init.body);
    if (session.announced !== undefined && bytes.byteLength < session.announced) {
      // 308 Resume Incomplete: Range names what arrived, and is absent when nothing did.
      return respond(null, 308, bytes.byteLength === 0 ? {} : { range: `bytes=0-${bytes.byteLength - 1}` });
    }
    if (session.announced !== undefined && bytes.byteLength > session.announced) return driveError(400, 'badRequest', `fake Drive: ${bytes.byteLength} bytes sent to a session announced at ${session.announced}`);
    // 补裁 9: a full Drive is refused here, on the content request.
    if (overQuota(bytes.byteLength)) return quotaExceeded();
    if (session.meta.parentId !== null && !items.has(session.meta.parentId)) return driveError(404, 'notFound', `File not found: ${session.meta.parentId}.`);
    const item = mk(session.meta, bytes);
    sessions.delete(sid);
    return shaped(resource(item), session.fields, DEFAULT_FILE_FIELDS, FILE);
  }

  function about(url: URL, method: string): Response {
    if (method !== 'GET') return notModelled(`${method} on about`);
    const fields = url.searchParams.get('fields');
    // 补裁 5: "Required: The fields parameter must be set." — no convenient default.
    if (!fields) return driveError(400, 'required', "The 'fields' parameter is required for this method.");
    const usage = String(used());
    const value = {
      kind: 'drive#about',
      // 补裁 5: string int64 byte counts, and no `limit` at all on an unlimited plan.
      storageQuota: { ...(quotaTotal === null ? {} : { limit: String(quotaTotal) }), usage, usageInDrive: usage, usageInDriveTrash: '0' },
      user: { kind: 'drive#user', displayName: 'Owner', emailAddress: accountEmail },
    };
    return shaped(value, fields, fields, ABOUT);
  }

  async function drive(url: URL, init: RequestInit, headers: Record<string, string>): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    // The session URI is pre-authorized and takes no bearer — the adapter relies on it, as with Graph's upload host.
    if (path === '/upload/drive/v3/files' && url.searchParams.has('upload_id')) return takeOverride(url.href) ?? sessionPut(url, init, method);
    const denied = unauthorized(method, url, headers);
    if (denied !== null) return denied;
    const override = takeOverride(url.href);
    if (override !== null) return override;
    if (path === '/upload/drive/v3/files') {
      const type = url.searchParams.get('uploadType');
      if (method === 'POST' && type === 'multipart') return multipartCreate(url, init, headers);
      if (method === 'POST' && type === 'resumable') return resumableInit(url, init, headers);
      return notModelled(`${method} ${path}?uploadType=${type}`);
    }
    if (path === '/drive/v3/files') {
      if (method === 'GET') return list(url);
      if (method === 'POST') {
        let raw: unknown;
        try { raw = JSON.parse(new TextDecoder().decode(await toBytes(init.body))); } catch { return driveError(400, 'badRequest', 'Invalid metadata JSON.'); }
        const meta = readMeta(raw);
        if (meta instanceof Response) return meta;
        if (meta.mimeType !== DRIVE_FOLDER_MIME) return notModelled('metadata-only creates other than the folder form');
        const item = mk(meta, null);
        return shaped(resource(item), url.searchParams.get('fields'), DEFAULT_FILE_FIELDS, FILE);
      }
      return notModelled(`${method} ${path}`);
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (one !== null) return byId(url, method, decodeURIComponent(one[1]));
    if (path === '/drive/v3/about') return about(url, method);
    return notModelled(`${method} ${path}`);
  }

  const fetchImpl: S3FetchPort = async (input, init = {}) => {
    const url = new URL(input);
    const headers = lower(init.headers);
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), url: url.href, headers });
    if (`${url.origin}${url.pathname}` === GOOGLE_TOKEN_URL) return takeOverride(url.href) ?? token(init);
    if (url.origin === DRIVE_ORIGIN) return drive(url, init, headers);
    // Loud, and not a 5xx: a bare 502 would look retryable to an adapter (e.g. the revoke endpoint, a foreign host).
    return notModelled(`${(init.method ?? 'GET').toUpperCase()} ${url.origin}${url.pathname}`);
  };

  async function putMultipart(parentFolderId: string, name: string, bytes: Uint8Array): Promise<string> {
    const b = 'fake-drive-seed-boundary';
    const head = new TextEncoder().encode(`--${b}\r\nContent-Type: ${JSON_TYPE}\r\n\r\n${JSON.stringify({ name, parents: [parentFolderId] })}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = ascii(`\r\n--${b}--`);
    const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);
    body.set(head);
    body.set(bytes, head.byteLength);
    body.set(tail, head.byteLength + bytes.byteLength);
    // The same parser the adapter's requests hit, but outside `calls` and the failure knobs: seeding is test setup.
    const res = await multipartCreate(new URL(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`), { method: 'POST', body: body as unknown as BodyInit }, { 'content-type': `multipart/related; boundary=${b}` });
    const out = (await res.json()) as { id?: string };
    if (res.status !== 200 || out.id === undefined) throw new Error(`fake Drive: seeding ${name} failed: ${res.status} ${JSON.stringify(out)}`);
    return out.id;
  }

  const earliest = (rows: Item[]) => rows.reduce<Item | null>((best, i) => (best === null || i.createdTime < best.createdTime || (i.createdTime === best.createdTime && i.id < best.id) ? i : best), null);

  return {
    fetch: fetchImpl,
    downloadFile: createNodeDownloadFilePort(fetchImpl as unknown as typeof fetch),
    uploadFile: async ({ url, fileUri, headers, onProgress, signal }) => {
      const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
      const { fileURLToPath } = jest.requireActual('node:url') as typeof import('node:url');
      // A missing staged file surfaces exactly as in createNodeUploadFilePort: the raw fs error
      // ("ENOENT: no such file or directory, open …", code ENOENT) propagates unwrapped. Read
      // synchronously so fake-timer suites are not left waiting on libuv (see createNodeFileStat).
      const body = new Uint8Array(readFileSync(fileURLToPath(fileUri)));
      onProgress?.({ bytesSent: 0, totalBytes: body.byteLength });
      const response = await fetchImpl(url, { method: 'PUT', headers, body: body as unknown as BodyInit, ...(signal === undefined ? {} : { signal }) });
      await response.arrayBuffer();
      onProgress?.({ bytesSent: body.byteLength, totalBytes: body.byteLength });
      return { status: response.status, headers: lower(response.headers) };
    },
    // Under emptyLayout the layout does not exist yet: throw rather than hand out '' ids a store would write into.
    get ids() {
      if (root === null || state === null || blobs === null) throw new Error('fake Drive: emptyLayout has no pre-seeded ids; use the ids bootstrapGoogleDriveLayout returns');
      return { rootFolderId: root.id, stateFolderId: state.id, blobsFolderId: blobs.id };
    },
    accountEmail,
    refreshToken,
    calls,
    issueAccessToken,
    revoke: () => { refreshTokens.clear(); accessTokens.clear(); },
    failNext: (status, body = failure(status), headers = {}, match = /www\.googleapis\.com/) => {
      // 补裁 8: Drive never sends Retry-After, so no knob may make the double claim otherwise.
      if (hasRetryAfter(headers)) throw new Error('fake Drive: Drive never sends Retry-After (补裁 8)');
      overrides.push({ status, body, headers, match, repeat: false });
    },
    alwaysFail: (status, body = failure(status), match = /www\.googleapis\.com/) => {
      const rule: Override = { status, body, headers: {}, match, repeat: true };
      overrides.push(rule);
      return () => { const at = overrides.indexOf(rule); if (at !== -1) overrides.splice(at, 1); };
    },
    putMultipart,
    fileNames: (folderId) => children(folderId).filter((i) => i.bytes !== null).map((i) => i.name).sort(),
    fileById: (id) => { const i = items.get(id); return i === undefined ? null : { id: i.id, name: i.name, parentId: i.parentId, mimeType: i.mimeType, createdTime: i.createdTime, folder: i.bytes === null }; },
    fileBytes: (folderId, name) => earliest(children(folderId).filter((i) => i.bytes !== null && i.name === name))?.bytes?.slice() ?? null,
    usedBytes: used,
    sessions: () => sessions.size,
    clearFiles: () => { for (const i of [...items.values()]) if (i.bytes !== null) items.delete(i.id); sessions.clear(); },
    clearFolders: () => { if (state !== null) deleteTree(state.id); if (blobs !== null) deleteTree(blobs.id); },
    folderNames: (folderId) => children(folderId).filter((i) => i.bytes === null).map((i) => i.name).sort(),
    neverEndPaging: (on = true) => { endless = on; },
  };
}
