import type { S3FetchPort, S3UploadFilePort } from '@/features/byos/s3-transport';
import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';
import { getRandomValues } from 'expo-crypto';

import {
  CloudStoreError,
  type CloudGetProgress,
  type CloudObjectListEntry,
  type CloudObjectStore,
  type CloudStoreFailureCategory,
} from './cloud-object-store';
import { downloadWithStallWatchdog, raceStep, readAllBytes, readFailureBody, uploadWithStallWatchdog } from './cloud-store-http';
import type { GoogleTokenSource } from './google-token-source';

/** Google Drive v3 endpoints used by the adapter (spec §4.3, 补裁 5/6/8). */
export const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GDRIVE_CONNECT_TIMEOUT_MS = 30_000;
export const GDRIVE_STALL_TIMEOUT_MS = 20_000;
export const GDRIVE_MULTIPART_LIMIT = 5 * 1024 * 1024;
export type GoogleDriveFolderIds = Readonly<{
  rootFolderId: string;
  stateFolderId: string;
  blobsFolderId: string;
}>;

export type GoogleDriveStoreDeps = Readonly<{
  tokens: GoogleTokenSource;
  fetchImpl?: S3FetchPort;
  downloadFile?: S3DownloadFilePort;
  /** Kept in the adapter dependency shape for Task 6's native upload path. */
  uploadFile: S3UploadFilePort;
  /** Kept in the adapter dependency shape for Task 6's staged-file path. */
  statFile: (fileUri: string) => Promise<number | null>;
  connectMs?: number;
  stallMs?: number;
}>;

type DriveErrorBody = {
  error?: {
    code?: number;
    message?: string;
    errors?: readonly { reason?: string; message?: string }[];
  };
};

type DriveFileRow = { id?: string; createdTime?: string };
type DriveListRow = { name?: string; size?: string; mimeType?: string };

function parseNativeErrorBody(errorBody: string): unknown {
  if (errorBody === '') return null;
  try {
    return JSON.parse(errorBody) as unknown;
  } catch {
    return null;
  }
}

/**
 * Maps Drive's reason/status envelope to the CloudObjectStore error contract.
 * Drive documents exponential backoff rather than Retry-After, so this helper
 * deliberately never reads that header (补裁 8). `controller` is the one of
 * the request whose response this is: a stalled body aborts that request and
 * falls back to the status (board #9).
 */
export function classifyDriveFailure(input: Readonly<{ status: number; body: unknown }>, label: string, write: boolean): CloudStoreError {
  // A missing, non-JSON or stalled error body still gets a status-based classification.
  const body = (input.body as DriveErrorBody | null) ?? {};
  const reason = body.error?.errors?.[0]?.reason ?? '';
  const detail = body.error?.message ?? body.error?.errors?.[0]?.message ?? '';
  let category: CloudStoreFailureCategory;
  let outcomeKnown: boolean;
  if (input.status === 403 && reason === 'storageQuotaExceeded') {
    category = 'quota_full';
    outcomeKnown = true;
  } else if ((input.status === 403 || input.status === 429) && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')) {
    category = 'rate_limited';
    outcomeKnown = false;
  } else if (input.status === 403 && reason === 'forbidden') {
    category = 'auth';
    outcomeKnown = true;
  } else if (input.status === 400 && reason === 'badRequest') {
    category = 'client';
    outcomeKnown = true;
  } else if (input.status >= 500) {
    category = 'server';
    outcomeKnown = false;
  } else if (input.status === 401) {
    category = 'auth';
    outcomeKnown = true;
  } else if (input.status === 404) {
    category = 'not_found';
    outcomeKnown = true;
  } else if (input.status === 429) {
    category = 'rate_limited';
    outcomeKnown = false;
  } else if (input.status >= 400) {
    category = 'client';
    outcomeKnown = true;
  } else {
    category = 'network';
    outcomeKnown = write ? false : true;
  }
  const suffix = [reason, detail].filter(Boolean).join(': ');
  return new CloudStoreError(
    input.status,
    category,
    `Google Drive ${label} failed (${input.status}${suffix ? ` ${suffix}` : ''}).`,
    outcomeKnown,
  );
}

export async function driveFailure(res: Response, controller: AbortController, stallMs: number, label: string, write: boolean): Promise<CloudStoreError> {
  return classifyDriveFailure({ status: res.status, body: await readFailureBody(res, controller, stallMs) }, label, write);
}

/** A 2xx response with an invalid JSON body is transport trouble, not SyntaxError. */
function decodeJson<T>(bytes: Uint8Array, status: number, label: string, write: boolean): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new CloudStoreError(
      status,
      'network',
      `Google Drive ${label}: response body could not be parsed as JSON.`,
      write ? false : true,
    );
  }
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function containsBytes(bytes: Uint8Array, value: Uint8Array): boolean {
  outer: for (let i = 0; i <= bytes.length - value.length; i += 1) {
    for (let j = 0; j < value.length; j += 1) if (bytes[i + j] !== value[j]) continue outer;
    return true;
  }
  return false;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Assemble Drive's two-part multipart/related create request. */
export function multipartBody(
  metadata: Readonly<{ name: string; parents: readonly string[] }>,
  media: Uint8Array,
  contentType: string,
): { body: Uint8Array; boundary: string } {
  const encoder = new TextEncoder();
  let boundary: string;
  let marker: Uint8Array;
  let collision = 0;
  do {
    const random = getRandomValues(new Uint8Array(24));
    boundary = `gdrive-${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}${collision === 0 ? '' : `-${collision}`}`;
    marker = encoder.encode(boundary);
    collision += 1;
  } while (containsBytes(media, marker));
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}` +
      `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  return { body: concatBytes(head, media, tail), boundary };
}

export function createGoogleDriveCloudObjectStore(
  ids: GoogleDriveFolderIds,
  deps: GoogleDriveStoreDeps,
): CloudObjectStore {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as S3FetchPort);
  const downloadFile = deps.downloadFile;
  const connectMs = deps.connectMs ?? GDRIVE_CONNECT_TIMEOUT_MS;
  const stallMs = deps.stallMs ?? GDRIVE_STALL_TIMEOUT_MS;
  const idCache = new Map<string, string>();

  function locate(path: string): { folderId: string; name: string } {
    const slash = path.indexOf('/');
    if (slash === -1) {
      if (path === '') throw new CloudStoreError(0, 'client', `Google Drive: unsupported object path ${path}.`, true);
      return { folderId: ids.rootFolderId, name: path };
    }
    const folder = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (name === '' || name.includes('/')) throw new CloudStoreError(0, 'client', `Google Drive: unsupported object path ${path}.`, true);
    if (folder === 'state') return { folderId: ids.stateFolderId, name };
    if (folder === 'blobs') return { folderId: ids.blobsFolderId, name };
    throw new CloudStoreError(0, 'client', `Google Drive: unsupported object path ${path}.`, true);
  }

  const cacheKey = (folderId: string, name: string) => `${folderId}\u0000${name}`;
  const evict = (folderId: string, name: string) => { idCache.delete(cacheKey(folderId, name)); };

  async function request(
    method: string,
    target: string,
    label: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<{ res: Response; controller: AbortController }> {
    for (let attempt = 1; ; attempt += 1) {
      const token = await deps.tokens.getAccessToken();
      const controller = new AbortController();
      const res = await raceStep(
        async () => {
          try {
            return await doFetch(target, {
              method,
              headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
              ...(init.body === undefined ? {} : { body: init.body }),
              signal: controller.signal,
            });
          } catch (error) {
            throw new CloudStoreError(0, 'network', `Google Drive ${label} failed before a response: ${error instanceof Error ? error.message : String(error)}`, false);
          }
        },
        connectMs,
        controller,
        () => new CloudStoreError(0, 'network', `Google Drive ${label} timed out.`, false),
      );
      if (res.status === 401 && attempt === 1) {
        deps.tokens.invalidate();
        continue;
      }
      return { res, controller };
    }
  }

  async function resolveId(folderId: string, name: string): Promise<string | null> {
    const key = cacheKey(folderId, name);
    const cached = idCache.get(key);
    if (cached !== undefined) return cached;
    const query = `${quote(folderId)} in parents and name = ${quote(name)} and trashed = false`;
    const url = `${DRIVE_BASE}/files?${new URLSearchParams({
      q: query,
      fields: 'files(id,createdTime)',
      orderBy: 'createdTime',
      pageSize: '1000',
    }).toString()}`;
    const { res, controller } = await request('GET', url, `resolve ${name}`);
    if (!res.ok) throw await driveFailure(res, controller, stallMs, `resolve ${name}`, false);
    const body = decodeJson<{ files?: DriveFileRow[] }>(await readAllBytes(res, controller, stallMs, `Google Drive resolve ${name}`), res.status, `resolve ${name}`, false);
    const winner = (body.files ?? []).reduce<DriveFileRow | null>((best, row) => {
      if (typeof row.id !== 'string') return best;
      if (best === null) return row;
      const created = row.createdTime ?? '';
      const bestCreated = best.createdTime ?? '';
      return created < bestCreated || (created === bestCreated && row.id < best.id!) ? row : best;
    }, null);
    if (winner?.id === undefined) return null;
    idCache.set(key, winner.id);
    return winner.id;
  }

  async function listFolder(folderId: string, label: string): Promise<readonly CloudObjectListEntry[]> {
    const rows: CloudObjectListEntry[] = [];
    let pageToken: string | null = null;
    for (let page = 1; ; page += 1) {
      if (page > 1000) throw new CloudStoreError(0, 'server', `Google Drive ${label}: paging did not terminate after 1000 pages.`, false);
      const params = new URLSearchParams({
        q: `${quote(folderId)} in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,size,mimeType)',
        pageSize: '1000',
      });
      if (pageToken !== null) params.set('pageToken', pageToken);
      const { res, controller } = await request('GET', `${DRIVE_BASE}/files?${params.toString()}`, label);
      if (!res.ok) throw await driveFailure(res, controller, stallMs, label, false);
      const body = decodeJson<{ files?: DriveListRow[]; nextPageToken?: string }>(await readAllBytes(res, controller, stallMs, `Google Drive ${label}`), res.status, label, false);
      for (const file of body.files ?? []) {
        if (file.mimeType === DRIVE_FOLDER_MIME || typeof file.name !== 'string') continue;
        const size = typeof file.size === 'string' && /^\d+$/.test(file.size) ? Number(file.size) : null;
        rows.push({ name: file.name, size });
      }
      if (typeof body.nextPageToken !== 'string') return rows;
      pageToken = body.nextPageToken;
    }
  }

  async function classifyUploadForbidden(size: number, path: string): Promise<CloudStoreError> {
    // The native upload port exposes only a bare status, so ask Drive once on this failure path to distinguish quota from auth.
    try {
      const current = await store.quota();
      if (current !== null && current.totalBytes !== null && current.usedBytes + size > current.totalBytes) {
        return new CloudStoreError(403, 'quota_full', `Google Drive PUT ${path} cannot fit in the available storage quota.`, true);
      }
    } catch {
      // A failed probe cannot establish quota exhaustion; keep the honest fallback below.
    }
    return new CloudStoreError(403, 'auth', `Google Drive PUT ${path} was forbidden; check the Google account authorization.`, true);
  }

  let store: CloudObjectStore;

  const getToFile = downloadFile === undefined ? undefined : async (
    path: string,
    fileUri: string,
    onProgress?: (progress: CloudGetProgress) => void,
  ): Promise<{ bytesWritten: number } | null> => {
    const { folderId, name } = locate(path);
    const id = await resolveId(folderId, name);
    if (id === null) return null;
    const url = `${DRIVE_BASE}/files/${encodeURIComponent(id)}?alt=media`;
    for (let attempt = 1; ; attempt += 1) {
      const token = await deps.tokens.getAccessToken();
      const response = await downloadWithStallWatchdog({
        connectMs,
        stallMs,
        label: `Google Drive GET ${path}`,
        request: { url, fileUri, headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' } },
        downloadFile,
        onProgress,
      });
      if (response.status === 401 && attempt === 1) {
        deps.tokens.invalidate();
        continue;
      }
      if (response.status >= 200 && response.status < 300) return { bytesWritten: response.bytesWritten };
      if (response.status === 404) {
        evict(folderId, name);
        return null;
      }
      throw classifyDriveFailure({ status: response.status, body: parseNativeErrorBody(response.errorBody) }, `GET ${path}`, false);
    }
  };

  store = {
    kind: 'gdrive',

    ...(getToFile === undefined ? {} : { getToFile }),

    async ensureLayout() {
      for (const id of [ids.rootFolderId, ids.stateFolderId, ids.blobsFolderId]) {
        const { res, controller } = await request('GET', `${DRIVE_BASE}/files/${encodeURIComponent(id)}?fields=id`, `layout ${id}`);
        if (res.status === 404) throw new CloudStoreError(404, 'client', 'Google Drive app folder is missing (deleted in Drive?): disconnect this device and connect again.', true);
        if (!res.ok) throw await driveFailure(res, controller, stallMs, `layout ${id}`, false);
      }
    },

    async get(path, onProgress) {
      const { folderId, name } = locate(path);
      const id = await resolveId(folderId, name);
      if (id === null) return null;
      const { res, controller } = await request('GET', `${DRIVE_BASE}/files/${encodeURIComponent(id)}?alt=media`, `GET ${path}`, { headers: { 'accept-encoding': 'identity' } });
      if (res.status === 404) {
        evict(folderId, name);
        return null;
      }
      if (!res.ok) throw await driveFailure(res, controller, stallMs, `GET ${path}`, false);
      return readAllBytes(res, controller, stallMs, `Google Drive GET ${path}`, onProgress);
    },

    async list(folder) {
      return listFolder(folder === '' ? ids.rootFolderId : ids.stateFolderId, folder === '' ? 'list /' : 'list state');
    },

    async delete(path) {
      const { folderId, name } = locate(path);
      const id = await resolveId(folderId, name);
      if (id === null) return;
      const { res, controller } = await request('DELETE', `${DRIVE_BASE}/files/${encodeURIComponent(id)}`, `DELETE ${path}`);
      evict(folderId, name);
      if (res.ok || res.status === 404) return;
      throw await driveFailure(res, controller, stallMs, `DELETE ${path}`, true);
    },

    async quota() {
      const { res, controller } = await request('GET', `${DRIVE_BASE}/about?fields=storageQuota`, 'quota');
      if (res.status === 401 || res.status === 403) throw await driveFailure(res, controller, stallMs, 'quota', false);
      if (!res.ok) throw await driveFailure(res, controller, stallMs, 'quota', false);
      const body = decodeJson<{ storageQuota?: { usage?: string; limit?: string } }>(await readAllBytes(res, controller, stallMs, 'Google Drive quota'), res.status, 'quota', false);
      const usage = body.storageQuota?.usage;
      if (typeof usage !== 'string' || !/^\d+$/.test(usage)) return null;
      const limit = body.storageQuota?.limit;
      return { usedBytes: Number(usage), totalBytes: typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : null };
    },

    async put(path, body, contentType) {
      if (body.byteLength > GDRIVE_MULTIPART_LIMIT) {
        throw new CloudStoreError(0, 'client', `Google Drive PUT ${path} exceeds the 5 MiB multipart limit; use putFromFile for blobs.`, true);
      }
      const { folderId, name } = locate(path);
      const multipart = multipartBody({ name, parents: [folderId] }, body, contentType);
      const { res, controller } = await request(
        'POST',
        `${DRIVE_UPLOAD_BASE}?uploadType=multipart&fields=id`,
        `PUT ${path}`,
        { headers: { 'content-type': `multipart/related; boundary=${multipart.boundary}` }, body: multipart.body as unknown as BodyInit },
      );
      if (!res.ok) throw await driveFailure(res, controller, stallMs, `PUT ${path}`, true);
      const response = decodeJson<{ id?: string }>(await readAllBytes(res, controller, stallMs, `Google Drive PUT ${path}`), res.status, `PUT ${path}`, true);
      if (typeof response.id !== 'string') throw new CloudStoreError(res.status, 'network', `Google Drive PUT ${path}: create response had no file id.`, false);
    },
    async putFromFile(path, fileUri, contentType, onProgress) {
      const size = await deps.statFile(fileUri);
      if (size === null) throw new CloudStoreError(0, 'client', `Google Drive PUT ${path}: cannot read ${fileUri}.`, true);
      if (size <= 0) throw new CloudStoreError(0, 'client', `Google Drive PUT ${path}: staged file is empty.`, true);
      const { folderId, name } = locate(path);
      const { res, controller } = await request('POST', `${DRIVE_UPLOAD_BASE}?uploadType=resumable`, `start upload ${path}`, {
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-length': String(size),
          'x-upload-content-type': contentType,
        },
        body: JSON.stringify({ name, parents: [folderId] }),
      });
      if (!res.ok) throw await driveFailure(res, controller, stallMs, `start upload ${path}`, true);
      const location = res.headers.get('location');
      let sessionUrl: URL;
      try {
        if (location === null) throw new Error('missing location');
        sessionUrl = new URL(location);
      } catch {
        throw new CloudStoreError(res.status, 'client', `Google Drive PUT ${path}: resumable session returned an unusable Location.`, true);
      }
      if (sessionUrl.protocol !== 'https:') {
        throw new CloudStoreError(res.status, 'client', `Google Drive PUT ${path}: resumable session Location must use HTTPS.`, true);
      }
      const status = await uploadWithStallWatchdog({
        stallMs,
        label: `Google Drive PUT ${path}`,
        request: { url: sessionUrl.href, fileUri, headers: { 'content-length': String(size) } },
        uploadFile: deps.uploadFile,
        onProgress,
      });
      if (status === 200 || status === 201) return;
      if (status === 308) throw new CloudStoreError(308, 'server', `Google Drive PUT ${path} is incomplete; retry the whole file upload.`, false);
      if (status === 404) throw new CloudStoreError(404, 'server', `Google Drive PUT ${path} upload session expired; start a new upload.`, false);
      if (status === 403) throw await classifyUploadForbidden(size, path);
      // A bare status from the native port: no body, no socket, so the controller has nothing to abort.
      throw await driveFailure(new Response(null, { status }), new AbortController(), stallMs, `PUT ${path}`, true);
    },
  };
  return store;
}
