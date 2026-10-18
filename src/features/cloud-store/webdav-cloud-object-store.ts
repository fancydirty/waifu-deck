import { encodeBase64 } from '@/features/byos/base64';
import type { WebdavBinding } from '@/features/byos/byos-credentials';
import { expoUploadFile } from '@/features/byos/s3-file-transfer';
import { decodeXml, type S3FetchPort, type S3UploadFilePort } from '@/features/byos/s3-transport';
import type { S3DownloadFilePort } from '@/features/byos/s3-file-download';

import {
  CloudStoreError,
  type CloudGetProgress,
  type CloudObjectListEntry,
  type CloudObjectStore,
  type CloudStoreFailureCategory,
} from './cloud-object-store';
import { downloadWithStallWatchdog, raceStep, readAllBytes, uploadWithStallWatchdog } from './cloud-store-http';

/**
 * Board #12 P12-B (spec §4.1): `CloudObjectStore` over plain WebDAV — Basic
 * auth over https, five verbs, no locking, no ETags, no conditional writes.
 *
 * Measured on 2026-09-19 against three real servers, and every shape below is
 * one of their actual answers: hacdias/webdav v5 (Docker), Synology DSM 7.2
 * Apache mod_dav behind cloudflared, and 123 云盘's official
 * WebDAV. They disagree on the namespace prefix in PROPFIND bodies (`D:`,
 * `lp1:`/`g0:`), on what MKCOL answers for an existing collection (405 vs 201),
 * and on whether a GET redirects to a CDN (123 does) — the code here is the
 * intersection that works on all three.
 */

export const WEBDAV_ROOT_FOLDER = 'Waifu Deck';
/** Same K5 budgets as the S3 transport: bound connect+headers, then per-chunk silence. */
export const WEBDAV_CONNECT_TIMEOUT_MS = 30_000;
export const WEBDAV_STALL_TIMEOUT_MS = 20_000;

export type WebdavStoreDeps = Readonly<{
  fetchImpl?: S3FetchPort;
  /** The blob path: `expo-file-system`'s task by default, the native module's port on device. */
  uploadFile?: S3UploadFilePort;
  /** Optional native blob GET port; when absent, the adapter keeps its fetch-based `get`. */
  downloadFile?: S3DownloadFilePort;
  connectMs?: number;
  stallMs?: number;
  /** Pause between the bounded retries of a 404 that arrived THROUGH a redirect (see `get`). */
  redirectRetryMs?: number;
}>;

/**
 * How many times `get` re-asks for an object whose 404 came back through a
 * redirect. 123 云盘 answers GET with a 302 to a CDN, and that CDN can lag the
 * origin by about a second after a PUT or DELETE (measured 2026-09-20: a
 * fresh object 404s once, a deleted one serves once more). Five tries at the
 * default pause bound the wait at ~2 s — long enough for the measured window,
 * short enough that a truly absent object is still a quick `null`.
 */
const REDIRECT_404_ATTEMPTS = 5;
const REDIRECT_404_RETRY_MS = 500;

function responseArrivedThroughRedirect(requestedUrl: string, res: Pick<Response, 'redirected' | 'url'>): boolean {
  if (res.redirected === true) return true;
  if (res.url === '') return false;
  try {
    return new URL(res.url).origin !== new URL(requestedUrl).origin;
  } catch {
    return false;
  }
}

const encodeSegment = (segment: string): string => encodeURIComponent(segment);

/** `/seg/seg/` with each segment percent-encoded; `''` and `/` are the server root. */
function normalizeRootPath(rootPath: string): string {
  const trimmed = rootPath.trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed.split('/').map(encodeSegment).join('/')}/`;
}

/**
 * `<base><rootPath>Waifu Deck/<path>`. `''` is the bind root itself, WITH its
 * trailing slash — WebDAV servers 301 a collection URL that lacks one, and a
 * redirect on MKCOL/PROPFIND is exactly the ambiguity this avoids.
 */
export function webdavObjectUrl(
  binding: Pick<WebdavBinding, 'baseUrl' | 'rootPath'>,
  path: string,
): string {
  const base = binding.baseUrl.trim().replace(/\/+$/, '');
  const root = `${base}${normalizeRootPath(binding.rootPath)}${encodeSegment(WEBDAV_ROOT_FOLDER)}/`;
  if (path === '') return root;
  return root + path.split('/').map(encodeSegment).join('/');
}

function categorize(status: number): CloudStoreFailureCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 507) return 'quota_full';
  if (status === 429 || status === 503) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * Whether a write's status proves nothing landed. A 5xx/429 may have been
 * applied before the gateway answered (the S3 transport's rule) — except 507:
 * "insufficient storage" is the server refusing to store the representation
 * at all (RFC 4918 §11.5), the one 5xx that is a definite no, and the port's
 * own default for `quota_full` already says so.
 */
const writeOutcomeKnown = (status: number): boolean =>
  status === 507 || (status < 500 && status !== 429);

/**
 * `<(prefix:)?name …>inner</(prefix:)?name>`, prefix-agnostic: servers bind
 * the DAV: namespace to different prefixes (`D:`, `lp1:`, `g0:`), and Hermes
 * has no DOMParser, so a regex over the local name is the portable parser.
 */
const tag = (name: string): RegExp =>
  new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g');
const firstTag = (name: string, xml: string): string | null => {
  const match = tag(name).exec(xml);
  return match === null ? null : match[1]!;
};
const isCollection = (responseBody: string): boolean => /<(?:[\w-]+:)?collection\b/.test(responseBody);

/**
 * A stray `%` in a foreign filename makes `decodeURIComponent` throw; one such
 * file must not take the whole listing (and every other note) down with it,
 * so the raw segment is listed instead — it is never one of ours anyway.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * One flat listing: every non-collection response in a PROPFIND Depth:1 body.
 * The self entry (href ending in `/`) and sub-collections are skipped; a name
 * is the decoded last path segment, whether the href is a path (`/webdav/…`,
 * `/share/…` — servers prefix their own mount) or an absolute URL.
 */
export function parsePropfindListing(xml: string): readonly CloudObjectListEntry[] {
  const rows: CloudObjectListEntry[] = [];
  for (const match of xml.matchAll(tag('response'))) {
    const body = match[1]!;
    const rawHref = firstTag('href', body);
    if (rawHref === null) continue;
    // Two encodings stack on an href: XML character references (named AND
    // numeric — `&#38;` is how some servers spell `&`), then percent-encoding.
    let href = decodeXml(rawHref.trim());
    if (/^https?:\/\//i.test(href)) href = new URL(href).pathname;
    if (href.endsWith('/') || isCollection(body)) continue;
    const name = decodeSegment(href.slice(href.lastIndexOf('/') + 1));
    if (name === '') continue;
    const length = firstTag('getcontentlength', body);
    const parsed = length === null || length.trim() === '' ? NaN : Number.parseInt(length.trim(), 10);
    rows.push({ name, size: Number.isNaN(parsed) ? null : parsed });
  }
  return rows;
}

const PROPFIND_LIST_BODY =
  '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>';
const PROPFIND_QUOTA_BODY =
  '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:quota-available-bytes/><D:quota-used-bytes/></D:prop></D:propfind>';

export function createWebdavCloudObjectStore(
  binding: WebdavBinding,
  deps: WebdavStoreDeps = {},
): CloudObjectStore {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as S3FetchPort);
  const uploadFile = deps.uploadFile ?? expoUploadFile;
  const downloadFile = deps.downloadFile;
  const connectMs = deps.connectMs ?? WEBDAV_CONNECT_TIMEOUT_MS;
  const stallMs = deps.stallMs ?? WEBDAV_STALL_TIMEOUT_MS;
  const redirectRetryMs = deps.redirectRetryMs ?? REDIRECT_404_RETRY_MS;
  // Device-safe base64: `Buffer` does not exist on Hermes (the K-line lesson —
  // Node globals pass Jest and crash on the phone).
  const authorization = `Basic ${encodeBase64(new TextEncoder().encode(`${binding.username}:${binding.password}`))}`;
  const url = (path: string): string => webdavObjectUrl(binding, path);
  /** Collections carry a trailing slash; `''` already has one. */
  const folderUrl = (folder: 'state' | 'blobs' | ''): string => (folder === '' ? url('') : `${url(folder)}/`);

  async function send(
    method: string,
    target: string,
    init: { body?: BodyInit; headers?: Record<string, string> },
    label: string,
  ): Promise<{ res: Response; controller: AbortController }> {
    const controller = new AbortController();
    const res = await raceStep(
      async () => {
        try {
          return await doFetch(target, {
            method,
            headers: { authorization, ...(init.headers ?? {}) },
            body: init.body,
            signal: controller.signal,
          });
        } catch (error) {
          // No response at all: offline, DNS, TLS, or an abort. The request may
          // still have reached the server, so a write's outcome is unknown.
          throw new CloudStoreError(
            0,
            'network',
            `WebDAV ${label} failed before a response: ${error instanceof Error ? error.message : String(error)}`,
            false,
          );
        }
      },
      connectMs,
      controller,
      () => new CloudStoreError(0, 'network', `WebDAV ${label} timed out.`, false),
    );
    return { res, controller };
  }

  async function readText(res: Response, controller: AbortController, label: string): Promise<string> {
    return new TextDecoder().decode(await readAllBytes(res, controller, stallMs, `WebDAV ${label}`));
  }

  async function mkcol(folder: 'state' | 'blobs' | ''): Promise<void> {
    const label = `MKCOL ${folder || '/'}`;
    const { res } = await send('MKCOL', folderUrl(folder), {}, label);
    // 201 = created. 405 (hacdias, Synology) and 301 = it already exists —
    // the outcome ensureLayout wants. 123 云盘 answers 201 for an existing
    // collection too, and lenient servers 200/204; all of these are "exists".
    if (res.status === 201 || res.status === 405 || res.status === 301 || res.status === 200 || res.status === 204) {
      return;
    }
    if (res.status === 409) {
      // A missing PARENT: the user's root path is not on the server. Naming it
      // beats a generic failure — and creating parents behind their back would
      // scatter folders wherever a typo pointed.
      throw new CloudStoreError(
        409,
        'client',
        `WebDAV root path ${normalizeRootPath(binding.rootPath)} does not exist on the server (MKCOL 409).`,
        true,
      );
    }
    throw new CloudStoreError(
      res.status,
      categorize(res.status),
      `WebDAV ${label} failed (${res.status}).`,
      writeOutcomeKnown(res.status),
    );
  }

  const getToFile = downloadFile === undefined ? undefined : async (
    path: string,
    fileUri: string,
    onProgress?: (progress: CloudGetProgress) => void,
  ): Promise<{ bytesWritten: number } | null> => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await downloadWithStallWatchdog({
        connectMs,
        stallMs,
        label: `WebDAV GET ${path}`,
        request: {
          url: url(path),
          fileUri,
          headers: { authorization, 'accept-encoding': 'identity' },
        },
        downloadFile,
        onProgress,
      });
      if (response.status >= 200 && response.status < 300) return { bytesWritten: response.bytesWritten };
      if (response.status === 404) {
        if (response.redirected === true && attempt < REDIRECT_404_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, redirectRetryMs));
          continue;
        }
        return null;
      }
      throw new CloudStoreError(
        response.status,
        categorize(response.status),
        `WebDAV GET ${path} failed (${response.status}).`,
        true,
      );
    }
  };

  return {
    kind: 'webdav',

    ...(getToFile === undefined ? {} : { getToFile }),

    async ensureLayout() {
      await mkcol('');
      await mkcol('state');
      await mkcol('blobs');
    },

    async put(path, body, contentType) {
      const { res } = await send(
        'PUT',
        url(path),
        { body: body as unknown as BodyInit, headers: { 'content-type': contentType } },
        `PUT ${path}`,
      );
      if (res.ok) return;
      throw new CloudStoreError(
        res.status,
        categorize(res.status),
        `WebDAV PUT ${path} rejected (${res.status}).`,
        writeOutcomeKnown(res.status),
      );
    },

    async putFromFile(path, fileUri, contentType, onProgress) {
      const status = await uploadWithStallWatchdog({
        stallMs,
        label: `WebDAV PUT ${path}`,
        request: { url: url(path), fileUri, headers: { authorization, 'content-type': contentType } },
        uploadFile,
        onProgress,
      });
      if (status < 200 || status >= 300) {
        throw new CloudStoreError(status, categorize(status), `WebDAV PUT ${path} rejected (${status}).`, writeOutcomeKnown(status));
      }
    },

    async get(path, onProgress) {
      // Opaque bytes: never let the HTTP stack negotiate a content-coding, or
      // `content-length` describes the encoded body and the ring lies (the
      // Bunny lesson from the S3 gate). Redirects (123's CDN hop) are followed
      // by the client itself.
      for (let attempt = 1; ; attempt += 1) {
        const { res, controller } = await send('GET', url(path), { headers: { 'accept-encoding': 'identity' } }, `GET ${path}`);
        if (res.status === 404) {
          // The origin's own 404 is the answer. A 404 that arrived through a
          // redirect is the CDN's answer, which can trail the origin by about
          // a second (123 云盘, measured) — so it is retried, bounded, before
          // being believed.
          if (!responseArrivedThroughRedirect(url(path), res) || attempt >= REDIRECT_404_ATTEMPTS) return null;
          await new Promise((resolve) => setTimeout(resolve, redirectRetryMs));
          continue;
        }
        if (!res.ok) {
          // A read cannot have applied anything: the outcome is known.
          throw new CloudStoreError(res.status, categorize(res.status), `WebDAV GET ${path} failed (${res.status}).`, true);
        }
        return readAllBytes(res, controller, stallMs, `WebDAV GET ${path}`, onProgress);
      }
    },

    async list(folder) {
      const label = `PROPFIND ${folder || '/'}`;
      const { res, controller } = await send(
        'PROPFIND',
        folderUrl(folder),
        { body: PROPFIND_LIST_BODY, headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' } },
        label,
      );
      if (res.status !== 207 && !res.ok) {
        throw new CloudStoreError(res.status, categorize(res.status), `WebDAV ${label} failed (${res.status}).`, true);
      }
      return parsePropfindListing(await readText(res, controller, label));
    },

    async delete(path) {
      const { res } = await send('DELETE', url(path), {}, `DELETE ${path}`);
      // Idempotent by contract: an absent object is the state delete wanted.
      if (res.ok || res.status === 404) return;
      throw new CloudStoreError(
        res.status,
        categorize(res.status),
        `WebDAV DELETE ${path} failed (${res.status}).`,
        writeOutcomeKnown(res.status),
      );
    },

    async quota() {
      // RFC 4331 on the bind root. Quota is a courtesy: a server that refuses
      // the request (405 on hacdias, 404 propstat on all three measured) simply
      // reports no quota rather than failing the caller.
      const { res, controller } = await send(
        'PROPFIND',
        url(''),
        { body: PROPFIND_QUOTA_BODY, headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' } },
        'PROPFIND quota',
      );
      if (res.status === 401 || res.status === 403) {
        // Rejected credentials are never "no quota": a settings refresh that
        // hit this must say "reconnect", the same as every other verb.
        throw new CloudStoreError(res.status, 'auth', `WebDAV PROPFIND quota failed (${res.status}).`, true);
      }
      if (res.status !== 207 && !res.ok) return null;
      const xml = await readText(res, controller, 'PROPFIND quota');
      // Only a 200 propstat carries values; a 404 propstat lists the props the
      // server does not know, as empty elements.
      const okBlocks = [...xml.matchAll(tag('propstat'))]
        .map((m) => m[1]!)
        .filter((block) => /<(?:[\w-]+:)?status>[^<]*\b200\b/.test(block));
      const num = (name: string): number | null => {
        for (const block of okBlocks) {
          const value = firstTag(name, block);
          if (value !== null && value.trim() !== '') {
            const n = Number.parseInt(value.trim(), 10);
            if (!Number.isNaN(n)) return n;
          }
        }
        return null;
      };
      const used = num('quota-used-bytes');
      const available = num('quota-available-bytes');
      if (used === null) return null;
      // Nextcloud and friends answer a NEGATIVE available (-3 = unlimited);
      // adding that to the usage would draw a capacity below what is used.
      const capacity = available === null || available < 0 ? null : used + available;
      return { usedBytes: used, totalBytes: capacity };
    },
  };
}
