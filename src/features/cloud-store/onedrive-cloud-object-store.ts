import { expoUploadFile } from '@/features/byos/s3-file-transfer';
import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';
import type { S3FetchPort, S3UploadFilePort } from '@/features/byos/s3-transport';

import { CloudStoreError, type CloudGetProgress, type CloudObjectListEntry, type CloudObjectStore, type CloudStoreFailureCategory } from './cloud-object-store';
import { downloadWithStallWatchdog, raceStep, readAllBytes, readFailureBody, uploadWithStallWatchdog } from './cloud-store-http';
import type { MicrosoftTokenSource } from './microsoft-token-source';

/**
 * Board #12 P12-C (spec §4.2 + 2026-09-20 补裁): `CloudObjectStore` over
 * Microsoft Graph v1.0 for a personal OneDrive. Everything is id-anchored
 * (`/me/drive/items/{folderId}:/{name}:`): the three folder ids come from the
 * binding (bootstrapped once at sign-in through `/me/drive/special/approot`),
 * so the localized "Apps/应用" path name is never spelled anywhere.
 * `putFromFile` splits on size: one native streaming PUT for real progress
 * below the single-PUT limit, sequential fragments above it, because Graph
 * refuses any single upload request at or above 60 MiB.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
/** The origin `@odata.nextLink` must stay on: a rewritten paging link must never carry the bearer off-host. */
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
export const ONEDRIVE_CONNECT_TIMEOUT_MS = 30_000;
export const ONEDRIVE_STALL_TIMEOUT_MS = 20_000;
/** `put` is for notes and vault-meta (a few KB): anything above this belongs to `putFromFile`. */
export const ONEDRIVE_SMALL_PUT_LIMIT = 4 * 1024 * 1024;
/** Graph: upload-session fragments MUST be multiples of 320 KiB and < 60 MiB per request. */
export const GRAPH_FRAGMENT_UNIT = 320 * 1024;
export const ONEDRIVE_SINGLE_PUT_LIMIT = 60 * 1024 * 1024;
/** 64 × 320 KiB: the fragment size for files at or above the single-PUT limit. */
export const ONEDRIVE_FRAGMENT_BYTES = 64 * GRAPH_FRAGMENT_UNIT;
/** A 20 MiB fragment goes through `fetch` (no progress events), so its bound is time, not silence. */
export const ONEDRIVE_FRAGMENT_TIMEOUT_MS = 10 * 60_000;

export type OneDriveFolderIds = Readonly<{ rootFolderId: string; stateFolderId: string; blobsFolderId: string }>;

export type OneDriveStoreDeps = Readonly<{
  tokens: MicrosoftTokenSource;
  fetchImpl?: S3FetchPort;
  uploadFile?: S3UploadFilePort;
  downloadFile?: S3DownloadFilePort;
  /**
   * Byte length of a staged file, or null when it does not exist. Required —
   * a caller that forgets it must fail to compile, not silently turn every
   * `putFromFile` into a `client` "cannot read" error at runtime.
   */
  statFile: (fileUri: string) => Promise<number | null>;
  /**
   * Sequential slices of `fragmentBytes` (the last one shorter), for files ≥
   * the single-PUT limit. Required for the same reason as `statFile`: a
   * missing port used to default to an empty generator, which read as an
   * honest-looking `client` "yielded 0 bytes" failure instead of a
   * construction mistake.
   */
  readFragments: (fileUri: string, fragmentBytes: number) => AsyncIterable<Uint8Array>;
  connectMs?: number;
  stallMs?: number;
  fragmentMs?: number;
  /** Test knobs; production uses the Graph constants. */
  singlePutLimit?: number;
  fragmentBytes?: number;
}>;

export function onedriveItemUrl(folderId: string, name: string): string {
  return `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(name)}:`;
}

function parseNativeErrorBody(errorBody: string): unknown {
  if (errorBody === '') return null;
  try {
    return JSON.parse(errorBody) as unknown;
  } catch {
    return null;
  }
}

function categorize(status: number): CloudStoreFailureCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 507) return 'quota_full';
  if (status === 429 || status === 503) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}
/** Same rule as WebDAV: a 5xx/429 may have applied before the answer; 507 and every other 4xx are definite refusals. */
const writeOutcomeKnown = (status: number): boolean => status === 507 || (status < 500 && status !== 429);

type GraphErrorBody = { error?: { code?: string; message?: string } };

/**
 * One Graph failure → one `CloudStoreError` (spec §4.2 补裁 6). The body's
 * `error.code` rides in the message (so `quotaLimitReached` on a 4xx still
 * reads as `quota_full`, and a 429's `Retry-After` is visible to the log
 * without the adapter sleeping on it). A read applies nothing, so its outcome
 * is always known; a write follows the status rule. Exported for the
 * sign-in-time bootstrap (`onedrive-layout.ts`), which speaks Graph too.
 * `controller` is the one of the request whose response this is: a stalled
 * body aborts that request and falls back to the status (board #9).
 */
export function classifyGraphFailure(
  input: Readonly<{ status: number; retryAfter: string | null; body: unknown }>,
  label: string,
  write: boolean,
): CloudStoreError {
  const body = input.body as GraphErrorBody | null;
  const code = body?.error?.code ?? '';
  const detail = body?.error?.message ?? '';
  const quotaCode = /quotaLimitReached|insufficientStorage/i.test(code);
  const category: CloudStoreFailureCategory = quotaCode ? 'quota_full' : categorize(input.status);
  const message = `OneDrive ${label} failed (${input.status}${code ? ` ${code}` : ''}${input.retryAfter !== null ? `, Retry-After ${input.retryAfter}` : ''})${detail ? `: ${detail}` : ''}.`;
  return new CloudStoreError(input.status, category, message, write ? (quotaCode || writeOutcomeKnown(input.status)) : true);
}

export async function graphFailure(res: Response, controller: AbortController, stallMs: number, label: string, write: boolean): Promise<CloudStoreError> {
  const body = await readFailureBody(res, controller, stallMs);
  return classifyGraphFailure({ status: res.status, retryAfter: res.headers.get('retry-after'), body }, label, write);
}

/**
 * A Graph 2xx whose body will not parse (a captive portal, a proxy error page, a
 * truncated read) is transport trouble, not a contract answer: it becomes a
 * `network` CloudStoreError instead of a raw SyntaxError escaping the adapter. A
 * read applied nothing, so its outcome is known; a write's is not.
 */
function decodeJson<T>(bytes: Uint8Array, status: number, label: string, write: boolean): T {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CloudStoreError(status, 'network', `OneDrive ${label}: response body could not be parsed as JSON.`, write ? false : true);
  }
}

export function createOneDriveCloudObjectStore(ids: OneDriveFolderIds, deps: OneDriveStoreDeps): CloudObjectStore {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as S3FetchPort);
  const connectMs = deps.connectMs ?? ONEDRIVE_CONNECT_TIMEOUT_MS;
  const stallMs = deps.stallMs ?? ONEDRIVE_STALL_TIMEOUT_MS;
  const uploadFile = deps.uploadFile ?? expoUploadFile;
  const downloadFile = deps.downloadFile;
  const { statFile, readFragments } = deps;
  const fragmentMs = deps.fragmentMs ?? ONEDRIVE_FRAGMENT_TIMEOUT_MS;
  const singlePutLimit = deps.singlePutLimit ?? ONEDRIVE_SINGLE_PUT_LIMIT;
  const fragmentBytes = deps.fragmentBytes ?? ONEDRIVE_FRAGMENT_BYTES;

  /**
   * A slash-free name — vault-meta.json, or any other root-level object a
   * caller (including the contract suite) writes — lives in the root folder;
   * `state/<name>` → state; `blobs/<name>` → blobs. `''`, a trailing slash,
   * or a nested path under state/blobs are the only shapes this refuses.
   */
  function locate(path: string): { folderId: string; name: string } {
    const slash = path.indexOf('/');
    if (slash === -1) {
      if (path === '') throw new CloudStoreError(0, 'client', `OneDrive: unsupported object path ${path}.`, true);
      return { folderId: ids.rootFolderId, name: path };
    }
    const folder = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (name === '' || name.includes('/')) throw new CloudStoreError(0, 'client', `OneDrive: unsupported object path ${path}.`, true);
    if (folder === 'state') return { folderId: ids.stateFolderId, name };
    if (folder === 'blobs') return { folderId: ids.blobsFolderId, name };
    throw new CloudStoreError(0, 'client', `OneDrive: unsupported object path ${path}.`, true);
  }
  const itemUrl = (path: string): string => { const { folderId, name } = locate(path); return onedriveItemUrl(folderId, name); };

  /**
   * One authorized Graph request under the connect deadline. A 401 means the
   * bearer is bad regardless of what the clock says (spec 补裁 6): the token
   * is dropped, refreshed once, and the request retried once; a second 401 is
   * the caller's `auth` failure. A refresh that fails (revoked sign-in →
   * `reauth_required`, or transport trouble) propagates as the token source's
   * own CloudStoreError.
   */
  async function graph(method: string, target: string, init: { body?: BodyInit; headers?: Record<string, string> }, label: string): Promise<{ res: Response; controller: AbortController }> {
    for (let attempt = 1; ; attempt += 1) {
      const token = await deps.tokens.getAccessToken();
      const controller = new AbortController();
      const res = await raceStep(
        async () => {
          try {
            return await doFetch(target, { method, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, body: init.body, signal: controller.signal });
          } catch (error) {
            throw new CloudStoreError(0, 'network', `OneDrive ${label} failed before a response: ${error instanceof Error ? error.message : String(error)}`, false);
          }
        },
        connectMs, controller,
        () => new CloudStoreError(0, 'network', `OneDrive ${label} timed out.`, false),
      );
      // The retry re-sends `init.body` verbatim; safe only because every body here
      // is an in-memory Uint8Array or small JSON, never a one-shot stream the first
      // attempt would have drained.
      if (res.status === 401 && attempt === 1) {
        deps.tokens.invalidate();
        continue;
      }
      return { res, controller };
    }
  }

  async function listChildren(folderId: string, label: string): Promise<readonly CloudObjectListEntry[]> {
    const rows: CloudObjectListEntry[] = [];
    let next: string | null = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(folderId)}/children?$select=id,name,size,folder&$top=1000`;
    // Graph pages with an absolute `@odata.nextLink` that carries the bearer, so
    // it is followed only while it stays on graph.microsoft.com (a rewritten link
    // must never exfiltrate the token), and the loop is bounded so a server that
    // pages forever fails loudly instead of hanging.
    for (let page = 1; next !== null; page += 1) {
      // A relative or otherwise unparseable nextLink must not escape as a raw
      // TypeError from `new URL` — it is Graph misbehaving, not our bug.
      let nextOrigin: string;
      try {
        nextOrigin = new URL(next).origin;
      } catch {
        throw new CloudStoreError(0, 'client', `OneDrive ${label}: unusable nextLink (not a parseable absolute URL): ${next}.`, true);
      }
      if (nextOrigin !== GRAPH_ORIGIN) throw new CloudStoreError(0, 'client', `OneDrive ${label}: refusing to follow a nextLink off graph.microsoft.com (${next}).`, true);
      if (page > 1000) throw new CloudStoreError(0, 'server', `OneDrive ${label}: paging did not terminate after 1000 pages.`, false);
      const { res, controller } = await graph('GET', next, {}, label);
      if (!res.ok) throw await graphFailure(res, controller, stallMs, label, false);
      const body = decodeJson<{ value?: { name?: string; size?: number; folder?: unknown }[]; '@odata.nextLink'?: string }>(await readAllBytes(res, controller, stallMs, `OneDrive ${label}`), res.status, label, false);
      for (const item of body.value ?? []) {
        // Subfolders (state/blobs under the root) are layout, not objects (spec 补裁 5).
        if (item.folder !== undefined || typeof item.name !== 'string') continue;
        rows.push({ name: item.name, size: typeof item.size === 'number' ? item.size : null });
      }
      next = typeof body['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : null;
    }
    return rows;
  }

  const getToFile = downloadFile === undefined ? undefined : async (
    path: string,
    fileUri: string,
    onProgress?: (progress: CloudGetProgress) => void,
  ): Promise<{ bytesWritten: number } | null> => {
    const url = `${itemUrl(path)}/content`;
    for (let attempt = 1; ; attempt += 1) {
      const token = await deps.tokens.getAccessToken();
      const response = await downloadWithStallWatchdog({
        connectMs,
        stallMs,
        label: `OneDrive GET ${path}`,
        request: { url, fileUri, headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' } },
        downloadFile,
        onProgress,
      });
      if (response.status === 401 && attempt === 1) {
        deps.tokens.invalidate();
        continue;
      }
      if (response.status >= 200 && response.status < 300) return { bytesWritten: response.bytesWritten };
      if (response.status === 404) return null;
      throw classifyGraphFailure(
        { status: response.status, retryAfter: response.headers['retry-after'] ?? null, body: parseNativeErrorBody(response.errorBody) },
        `GET ${path}`,
        false,
      );
    }
  };

  return {
    kind: 'onedrive',

    ...(getToFile === undefined ? {} : { getToFile }),

    async ensureLayout() {
      // The ids were bootstrapped at sign-in; a 404 on any of them means the
      // user deleted the app folder. That is their decision — recreating it
      // behind their back would silently overwrite it (spec 补裁 5).
      for (const id of [ids.rootFolderId, ids.stateFolderId, ids.blobsFolderId]) {
        const { res, controller } = await graph('GET', `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(id)}?$select=id`, {}, `layout ${id}`);
        if (res.status === 404) throw new CloudStoreError(404, 'client', 'OneDrive app folder is missing (deleted in OneDrive?): disconnect this device and connect again.', true);
        if (!res.ok) throw await graphFailure(res, controller, stallMs, `layout ${id}`, false);
      }
    },

    async put(path, body, contentType) {
      if (body.byteLength > ONEDRIVE_SMALL_PUT_LIMIT) {
        throw new CloudStoreError(0, 'client', `OneDrive PUT ${path}: ${body.byteLength} bytes exceeds the simple-upload limit (${ONEDRIVE_SMALL_PUT_LIMIT}); blobs go through putFromFile.`, true);
      }
      const { res, controller } = await graph('PUT', `${itemUrl(path)}/content`, { body: body as unknown as BodyInit, headers: { 'content-type': contentType } }, `PUT ${path}`);
      if (res.ok) return;
      throw await graphFailure(res, controller, stallMs, `PUT ${path}`, true);
    },

    async putFromFile(path, fileUri, contentType, onProgress) {
      // The upload host takes raw ranges: no content-type on those PUTs (Graph
      // docs show Content-Length + Content-Range only). The item's type is
      // whatever OneDrive infers; the bytes are opaque ciphertext anyway.
      void contentType;
      const size = await statFile(fileUri);
      if (size === null) throw new CloudStoreError(0, 'client', `OneDrive PUT ${path}: cannot read ${fileUri}.`, true);
      if (size === 0) throw new CloudStoreError(0, 'client', `OneDrive PUT ${path}: ${fileUri} is empty.`, true);
      const label = `PUT ${path}`;
      // `fileSize` up front: OneDrive (personal) refuses the session with 507
      // when it would not fit, so a full drive costs zero upload bytes.
      const { res, controller } = await graph(
        'POST', `${itemUrl(path)}/createUploadSession`,
        { body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' }, fileSize: size }), headers: { 'content-type': 'application/json' } },
        `createUploadSession ${path}`,
      );
      if (!res.ok) throw await graphFailure(res, controller, stallMs, `createUploadSession ${path}`, true);
      const session = decodeJson<{ uploadUrl?: string }>(await readAllBytes(res, controller, stallMs, `OneDrive createUploadSession ${path}`), res.status, `createUploadSession ${path}`, true);
      if (typeof session.uploadUrl !== 'string') throw new CloudStoreError(res.status, 'server', `OneDrive createUploadSession ${path}: no uploadUrl in the answer.`, false);
      // Graph's upload hosts are deliberately off graph.microsoft.com (the
      // session answer names a per-upload host on a domain Microsoft does not
      // document or promise to keep stable), so an origin allowlist like
      // `nextLink`'s above is not possible here. A scheme check is the one
      // thing we can still enforce before streaming ciphertext at a URL Graph
      // handed back: refuse anything that is not parseable or not https.
      let uploadScheme: string;
      try {
        uploadScheme = new URL(session.uploadUrl).protocol;
      } catch {
        throw new CloudStoreError(res.status, 'client', `OneDrive createUploadSession ${path}: unusable uploadUrl (not a parseable URL).`, true);
      }
      if (uploadScheme !== 'https:') throw new CloudStoreError(res.status, 'client', `OneDrive createUploadSession ${path}: unusable uploadUrl (not https).`, true);
      const uploadUrl = session.uploadUrl;

      if (size < singlePutLimit) {
        // One streaming PUT through the native uploader: real byte progress,
        // K5 silence watchdog, no JS copy of the file. The upload URL is
        // pre-authorized — sending the bearer would be refused/ignored.
        const status = await uploadWithStallWatchdog({
          stallMs, label: `OneDrive ${label}`, uploadFile, onProgress,
          request: { url: uploadUrl, fileUri, headers: { 'content-range': `bytes 0-${size - 1}/${size}` } },
        });
        if (status === 200 || status === 201) return;
        if (status === 202) throw new CloudStoreError(202, 'server', `OneDrive ${label}: the upload session did not commit after the whole file (202).`, false);
        if (status === 404) throw new CloudStoreError(404, 'server', `OneDrive ${label}: upload session expired or was cancelled (404).`, false);
        // The watchdog resolves with a bare status — no body/headers (it
        // wraps the native uploader, which surfaces neither) — so, unlike the
        // fragment path below (which reads the JSON body through
        // `graphFailure`), a 403 `quotaLimitReached` here reads as plain
        // `auth` and a 429's `Retry-After` is never logged. Accepted
        // asymmetry: fixing it would mean parsing a body the native uploader
        // does not give us.
        throw new CloudStoreError(status, categorize(status), `OneDrive ${label} rejected (${status}).`, writeOutcomeKnown(status));
      }

      // ≥ the limit: sequential fragments of 64 × 320 KiB over fetch. fetch
      // reports no upload progress, so the ring advances per fragment and
      // each fragment is bounded by time rather than by silence.
      let offset = 0;
      for await (const fragment of readFragments(fileUri, fragmentBytes)) {
        // The file grew between `statFile()` and this read: `size` (and thus
        // the session we committed to) is already spoken for. Stop instead of
        // PUTting leftover bytes into a session Graph may already be closing.
        if (offset === size) break;
        const end = offset + fragment.byteLength - 1;
        const isFinalFragment = end === size - 1;
        const fragmentLabel = `${label} fragment ${offset}-${end}/${size}`;
        const fc = new AbortController();
        const fr = await raceStep(
          async () => {
            try {
              return await doFetch(uploadUrl, { method: 'PUT', headers: { 'content-range': `bytes ${offset}-${end}/${size}` }, body: fragment as unknown as BodyInit, signal: fc.signal });
            } catch (error) {
              throw new CloudStoreError(0, 'network', `OneDrive ${fragmentLabel} failed before a response: ${error instanceof Error ? error.message : String(error)}`, false);
            }
          },
          fragmentMs, fc,
          () => new CloudStoreError(0, 'network', `OneDrive ${fragmentLabel} timed out.`, false),
        );
        if (fr.status === 404) throw new CloudStoreError(404, 'server', `OneDrive ${label}: upload session expired or was cancelled (404).`, false);
        // A non-final fragment that reports 200/201 means Graph committed the
        // session before the file was fully sent: a contract violation, not
        // a status this loop can shrug off and keep PUTting past.
        if (!isFinalFragment && (fr.status === 200 || fr.status === 201)) {
          throw new CloudStoreError(fr.status, 'server', `OneDrive ${label}: the upload session committed early after fragment ${offset}-${end}/${size} (contract violation).`, false);
        }
        if (fr.status !== 202 && fr.status !== 200 && fr.status !== 201) throw await graphFailure(fr, fc, stallMs, fragmentLabel, true);
        if (isFinalFragment && fr.status === 202) throw new CloudStoreError(202, 'server', `OneDrive ${label}: the upload session did not commit after the last fragment (202).`, false);
        offset = end + 1;
        onProgress?.(offset);
      }
      if (offset !== size) throw new CloudStoreError(0, 'client', `OneDrive ${label}: ${fileUri} yielded ${offset} bytes, expected ${size}.`, true);
    },

    async get(path, onProgress) {
      // Graph answers 302 to a pre-authorized download host; the HTTP client
      // follows it (OkHttp/undici drop the bearer on the cross-host hop).
      // `identity` so content-length describes the real bytes (the Bunny lesson).
      const { res, controller } = await graph('GET', `${itemUrl(path)}/content`, { headers: { 'accept-encoding': 'identity' } }, `GET ${path}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await graphFailure(res, controller, stallMs, `GET ${path}`, false);
      return readAllBytes(res, controller, stallMs, `OneDrive GET ${path}`, onProgress);
    },

    async list(folder) {
      return folder === '' ? listChildren(ids.rootFolderId, 'list /') : listChildren(ids.stateFolderId, 'list state');
    },

    async delete(path) {
      const { res, controller } = await graph('DELETE', itemUrl(path), {}, `DELETE ${path}`);
      if (res.ok || res.status === 404) return;
      throw await graphFailure(res, controller, stallMs, `DELETE ${path}`, true);
    },

    async quota() {
      const { res, controller } = await graph('GET', `${GRAPH_BASE}/me/drive?$select=quota`, {}, 'quota');
      if (res.status === 401 || res.status === 403) throw await graphFailure(res, controller, stallMs, 'quota', false);
      if (!res.ok) return null;
      const body = decodeJson<{ quota?: { used?: number; total?: number } }>(await readAllBytes(res, controller, stallMs, 'OneDrive quota'), res.status, 'quota', false);
      if (typeof body.quota?.used !== 'number') return null;
      return { usedBytes: body.quota.used, totalBytes: typeof body.quota.total === 'number' ? body.quota.total : null };
    },
  };
}
