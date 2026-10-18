import { bytesToHex } from '@noble/hashes/utils.js';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';

import {
  S3DownloadError,
  type S3DownloadFilePort,
} from './s3-file-download';
import { expoUploadFile } from './s3-file-transfer';
import { signRequest } from './s3-sigv4';
import {
  S3LocalWriteError,
  S3TransportError,
  type S3Credentials,
  type S3FailureCategory,
} from './s3-transport-types';
import { LIBRARY_MAX_OBJECT_ENVELOPE_BYTES } from '../library/library-limits';

export type PutOptions = Readonly<{
  ifMatch?: string;       // conditional CAS overwrite
  ifNoneMatch?: string;   // '*' for create-only
  contentType?: string;
}>;

export type S3GetResult = Readonly<{ body: Uint8Array; etag: string }>;

/**
 * K6-2 (spec §2 G5: 下凡 gets the same real ring as 上云). Reports bytes as they
 * arrive off the response stream — the same channel every other GET in this app
 * already uses, so nothing about status handling, ETags, or the stall watchdog
 * changes just because someone is watching.
 */
export type GetOptions = Readonly<{
  onProgress?: (progress: S3TransferProgress) => void;
}>;
export type GetObjectToFileOptions = Readonly<{
  onProgress?: (progress: S3FileDownloadProgress) => void;
  maxBytes?: number;
}>;
export type S3FileDownloadProgress = Readonly<{ sent: number; total: number | null }>;
export type S3ListItem = Readonly<{
  key: string;
  etag: string;
  lastModified: string;
  size: number;
}>;
export type S3ListPage = Readonly<{
  objects: readonly S3ListItem[];
  nextToken: string | undefined;
}>;

export type S3FetchPort = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * K6-2 (spec §2 G3): bytes this transfer has actually handed to (or taken
 * from) the server. `total` is normalized — a native task that does not yet
 * know the length reports `-1`/`0` and the transport substitutes the length
 * the caller already knows.
 */
export type S3TransferProgress = Readonly<{ sent: number; total: number }>;

export type S3UploadFileRequest = Readonly<{
  url: string;
  fileUri: string;
  headers: Record<string, string>;
  onProgress?: (progress: Readonly<{ bytesSent: number; totalBytes: number }>) => void;
  signal?: AbortSignal;
}>;

export type S3UploadFileResponse = Readonly<{
  status: number;
  headers: Record<string, string>;
}>;

/**
 * Uploads a file already on disk and reports real byte progress.
 *
 * A port rather than a direct `expo-file-system` call because two environments
 * have no native module: Jest (where the double in
 * `src/test/expo-file-system-double.ts` stands in) and the MinIO integration
 * gate (which runs in plain Node and injects an `fs`+`fetch` implementation, so
 * the S3 wire path is still proven end to end). Production omits it and gets
 * `expoUploadFile`.
 */
export type S3UploadFilePort = (
  request: S3UploadFileRequest,
) => Promise<S3UploadFileResponse>;

export type PutFromFileOptions = Readonly<{
  /**
   * Lowercase hex SHA-256 of the file's bytes. Passed in rather than computed
   * here because the caller already holds the ciphertext in memory (see
   * `library-cloud-client-s3.ts`'s `writeBlob`), and re-reading a multi-megabyte
   * blob off disk purely to hash it would put a second full read on exactly the
   * critical path K6-1e shortened.
   */
  contentSha256: string;
  /** Ciphertext length; the progress total when the native task reports none. */
  byteLength: number;
  contentType?: string;
  onProgress?: (progress: S3TransferProgress) => void;
}>;

/**
 * Max time to establish a connection and receive response headers. A bad
 * proxy handshake measured up to 10.7s (spec §1 F4), so this is generous
 * enough to let a slow-but-real connect through and only cuts off a truly
 * hung socket that never answers.
 */
export const S3_CONNECT_TIMEOUT_MS = 30_000;
/**
 * Max time a body read may make NO progress before the request is abandoned.
 * A slow-but-steady transfer resets this window on every chunk, so a large
 * wallpaper-grade object downloads for as long as it keeps moving; only an
 * actually-stalled stream (no bytes for this long) is treated as dead.
 */
export const S3_STALL_TIMEOUT_MS = 20_000;

/** Lowercase hex SHA-256 of the empty byte string — AWS's documented digest
 * for a bodyless signed request. A GET/DELETE/LIST never hashes anything. */
export const S3_EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Lowercase hex SHA-256 of a request body, for `x-amz-content-sha256`. */
export type S3HashPayloadPort = (bytes: Uint8Array) => Promise<string>;

/**
 * Production default: `expo-crypto`'s native SHA-256.
 *
 * K6-1e (spec §2's five-second bar). SigV4 must cover the payload digest, so
 * every PUT hashes its ciphertext — but doing it with the pure-JS @noble
 * sha256 on Hermes measured ~1.3 s per 6 MB blob, ×3 blobs per protected
 * image, on the critical path to the bucket. The native digest is ~10 ms/MB
 * and, being off the JS heap, does not block the UI thread either. This is not
 * a security weakening: the signature still commits to the real body hash
 * (never `UNSIGNED-PAYLOAD`), and MinIO/R2 verify it on every write.
 */
const nativeHashPayload: S3HashPayloadPort = async (bytes) => {
  // TypeScript models `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which does
  // not satisfy `BufferSource`'s `ArrayBufferView<ArrayBuffer>` even though
  // every body this transport is handed is ArrayBuffer-backed. Copying the
  // bytes to narrow the type would memcpy the whole blob on exactly the
  // critical path this cut exists to shorten, so narrow by assertion.
  const source = bytes as unknown as BufferSource;
  return bytesToHex(
    new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, source)),
  );
};

export type S3TransportDeps = Readonly<{
  fetchImpl?: S3FetchPort;
  now?: () => string; // YYYYMMDDTHHMMSSZ
  /** Connect + headers deadline. Default 30s. */
  connectMs?: number;
  /** Per-read no-progress (stall) deadline. Default 20s. */
  stallMs?: number;
  /** SHA-256 of a request body. Default: `expo-crypto`'s native digest. */
  hashPayload?: S3HashPayloadPort;
  /**
   * File-backed PUT with byte progress. Default: `expoUploadFile`, the
   * `expo-file-system` upload task (see `./s3-file-transfer`).
   */
  uploadFile?: S3UploadFilePort;
  /** Native or Node stream-to-file port. Absent outside Android/integration. */
  downloadFile?: S3DownloadFilePort;
}>;

function amzNow(): string {
  // Non-injected default; tests always inject `now`.
  const d = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return d.endsWith('Z') ? d : `${d}Z`;
}

function categorize(status: number): S3FailureCategory {
  if (status === 401 || status === 403) return 'credential';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'precondition';
  if (status === 429 || status === 503) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * A 5xx or 429 answer to a write may come from an edge that already forwarded
 * the mutation, so the caller must keep its durable intent.
 */
function writeOutcomeKnown(status: number): boolean {
  return status < 500 && status !== 429;
}

/** Percent-encodes the sub-delims that encodeURIComponent leaves literal. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * RFC 3986-encodes an object key for use in a URI path: each `/`-separated
 * segment is strictly encoded (the same encoder the canonical query uses, so
 * `!*'()` become uppercase hex), and the `/` separators stay literal. The
 * result feeds BOTH the signed canonical URI and the fetch URL, so signature
 * and wire agree — a raw path is rejected as SignatureDoesNotMatch by S3
 * backends that canonicalize these characters (proven against MinIO).
 */
function encodeKeyPath(key: string): string {
  return key.split('/').map(rfc3986).join('/');
}

function canonicalQueryString(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** fetch derives Host from the URL; WHATWG forbids setting it explicitly. */
function withoutHost(headers: Record<string, string>): Record<string, string> {
  const { host: _host, ...rest } = headers;
  return rest;
}

const hostOf = (endpoint: string): string => new URL(endpoint).host;

/** Case-insensitive lookup over a plain header record (HTTP names are not). */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | null {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

export function createS3Transport(
  credentials: S3Credentials,
  deps: S3TransportDeps = {},
) {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as S3FetchPort);
  const now = deps.now ?? amzNow;
  const base = credentials.endpoint.replace(/\/+$/, '');
  const connectMs = deps.connectMs ?? S3_CONNECT_TIMEOUT_MS;
  const stallMs = deps.stallMs ?? S3_STALL_TIMEOUT_MS;
  const hashPayload = deps.hashPayload ?? nativeHashPayload;
  const uploadFile = deps.uploadFile ?? expoUploadFile;
  const downloadFile = deps.downloadFile;

  // Races one step against a deadline. On timeout it aborts the shared
  // controller (best-effort native-socket cleanup — RN's OkHttp has no timeout
  // and a buffered body read does not reject on abort) and rejects with the
  // step's error. Used twice: once to bound connect+headers, and once PER body
  // chunk so the window resets on every scrap of progress. A slow-but-steady
  // transfer is therefore never a timeout; only true silence is.
  async function raceStep<T>(
    run: () => Promise<T>,
    ms: number,
    controller: AbortController,
    makeError: () => S3TransportError,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<T>([
        run(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(makeError());
          }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  type BodyStream = {
    getReader: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
    };
  };

  /**
   * Reads a whole body under a per-chunk stall watchdog. When the response
   * exposes a stream (`res.body.getReader`, the real path on device and in
   * Node), each `read()` resets the stall window, so a large object downloads
   * for as long as it keeps moving. When it doesn't (a fake, or an environment
   * without a stream), the single buffered read is wrapped in one stall window.
   */
  async function readAllBytes(
    res: Response,
    controller: AbortController,
    label: string,
    onProgress?: (progress: S3TransferProgress) => void,
  ): Promise<Uint8Array> {
    const stallError = (): S3TransportError =>
      new S3TransportError(0, 'network', `${label} stalled.`, false);
    // K6-2 (spec §2 G5): the download half of the ring. `content-length` is
    // what the server says it is sending; when it sends none (a chunked
    // answer), "as much as has arrived" is the only honest denominator — never
    // 0 (a divide-by-zero ring) and never a guess.
    const announced = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    const stream = (res as unknown as { body?: BodyStream | null }).body;
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await raceStep(
          () => reader.read(), stallMs, controller, stallError,
        );
        if (done) break;
        if (value !== undefined) {
          chunks.push(value);
          total += value.byteLength;
          onProgress?.({
            sent: total,
            total: Number.isNaN(announced) ? total : announced,
          });
        }
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }
    const buffered = await raceStep(
      () => res.arrayBuffer(), stallMs, controller, stallError,
    );
    const out = new Uint8Array(buffered);
    // No stream to count: the body arrived in one piece, and saying so once is
    // still a real report — it is just a report with one step in it.
    onProgress?.({ sent: out.byteLength, total: out.byteLength });
    return out;
  }

  async function readAllText(
    res: Response,
    controller: AbortController,
    label: string,
  ): Promise<string> {
    const stream = (res as unknown as { body?: BodyStream | null }).body;
    if (stream && typeof stream.getReader === 'function') {
      return new TextDecoder().decode(await readAllBytes(res, controller, label));
    }
    const stallError = (): S3TransportError =>
      new S3TransportError(0, 'network', `${label} stalled.`, false);
    return raceStep(() => res.text(), stallMs, controller, stallError);
  }

  /**
   * Runs a signed request: bounds connect+headers by `connectMs`, then hands
   * the response and the shared abort controller to `consume`, which reads the
   * body (if any) under the stall watchdog. One controller spans both phases,
   * so a timeout in either aborts the same underlying socket.
   */
  async function send<T>(
    method: string,
    key: string,
    body: Uint8Array | undefined,
    extraHeaders: Record<string, string>,
    query: string,
    consume: (res: Response, controller: AbortController) => Promise<T>,
  ): Promise<T> {
    const uri = `/${credentials.bucket}/${encodeKeyPath(key)}`;
    const payloadHashHex = body === undefined
      ? S3_EMPTY_PAYLOAD_SHA256
      : await hashPayload(body);
    const headers = signRequest({
      method, host: hostOf(base),
      canonicalUri: uri, canonicalQuery: query,
      extraHeaders, payloadHashHex,
      credentials, amzDate: now(),
    });
    const url = `${base}${uri}${query ? `?${query}` : ''}`;
    const controller = new AbortController();
    const res = await raceStep(
      async () => {
        try {
          return await doFetch(url, {
            method, headers: withoutHost(headers),
            body: body as unknown as BodyInit, signal: controller.signal,
          });
        } catch {
          throw new S3TransportError(0, 'network',
            `S3 ${method} ${key} failed before a response.`, false);
        }
      },
      connectMs,
      controller,
      () => new S3TransportError(0, 'network', `S3 ${method} ${key} timed out.`, false),
    );
    return consume(res, controller);
  }

  async function putObject(
    key: string, body: Uint8Array, options: PutOptions,
  ): Promise<{ etag: string | null }> {
    const extra: Record<string, string> = {};
    if (options.contentType) extra['content-type'] = options.contentType;
    if (options.ifMatch) extra['if-match'] = options.ifMatch;
    if (options.ifNoneMatch) extra['if-none-match'] = options.ifNoneMatch;
    return send('PUT', key, body, extra, '', async (res) => {
      if (!res.ok) {
        throw new S3TransportError(res.status, categorize(res.status),
          `S3 PUT ${key} rejected (${res.status}).`, writeOutcomeKnown(res.status));
      }
      return { etag: res.headers.get('etag') };
    });
  }

  /**
   * K6-2 (spec §2 G3: 「不是假百分比，必须得是实际的真实百分比」): the same
   * signed PUT as `putObject`, driven by a native upload task reading the body
   * off disk, because that is the only channel in SDK 56 that reports
   * `bytesSent` — `expo/fetch` has no upload progress event at all.
   *
   * Identical on the wire: same canonical URI, same SigV4 headers over the same
   * payload hash, same `S3TransportError` categories and `outcomeKnown` rule as
   * `putObject` (proven byte-for-byte in `s3-transport.test.ts`). The only
   * difference is where the bytes come from and that progress is observable.
   *
   * The stall watchdog is NOT a new timeout: `putObject` already abandons a
   * request that makes no progress for `stallMs` (K5), and dropping that on the
   * upload-task path would have made a hung native socket hang forever. Each
   * progress report resets the window, so a slow-but-steady upload runs as long
   * as it keeps moving.
   */
  async function putObjectFromFile(
    key: string,
    fileUri: string,
    options: PutFromFileOptions,
  ): Promise<{ etag: string | null }> {
    const uri = `/${credentials.bucket}/${encodeKeyPath(key)}`;
    const extra: Record<string, string> = {};
    if (options.contentType) extra['content-type'] = options.contentType;
    const headers = signRequest({
      method: 'PUT', host: hostOf(base),
      canonicalUri: uri, canonicalQuery: '',
      extraHeaders: extra, payloadHashHex: options.contentSha256,
      credentials, amzDate: now(),
    });
    const controller = new AbortController();

    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let onStall: () => void = () => {};
    const armStall = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (settled) return;
      stallTimer = setTimeout(() => onStall(), stallMs);
    };
    const stalled = new Promise<never>((_, reject) => {
      onStall = () => {
        if (settled) return;
        controller.abort();
        reject(new S3TransportError(
          0, 'network', `S3 PUT ${key} stalled.`, false,
        ));
      };
    });
    armStall();

    const run = (async (): Promise<S3UploadFileResponse> => {
      try {
        return await uploadFile({
          url: `${base}${uri}`,
          fileUri,
          headers: withoutHost(headers),
          signal: controller.signal,
          onProgress: (progress) => {
            armStall();
            if (options.onProgress === undefined) return;
            const total = progress.totalBytes > 0
              ? progress.totalBytes
              : options.byteLength;
            options.onProgress({ sent: progress.bytesSent, total });
          },
        });
      } catch (error) {
        if (error instanceof S3TransportError) throw error;
        throw new S3TransportError(
          0, 'network', `S3 PUT ${key} failed before a response.`, false,
        );
      }
    })();

    let response: S3UploadFileResponse;
    try {
      response = await Promise.race([run, stalled]);
    } finally {
      settled = true;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      // A losing `run` that rejects later must not surface as an unhandled
      // rejection once the stall watchdog has already won the race.
      run.catch(() => {});
    }

    if (response.status < 200 || response.status >= 300) {
      throw new S3TransportError(
        response.status, categorize(response.status),
        `S3 PUT ${key} rejected (${response.status}).`,
        writeOutcomeKnown(response.status),
      );
    }
    return { etag: headerValue(response.headers, 'etag') };
  }

  async function getObject(
    key: string,
    options: GetOptions = {},
  ): Promise<S3GetResult | null> {
    // An S3 object is opaque bytes: never let the HTTP stack negotiate a
    // content-coding for it. Node's fetch adds `Accept-Encoding: gzip, deflate,
    // br` when the caller sets none; the production client, `expo/fetch`, adds
    // `zstd, br, gzip` on Android (TransparentCompressionInterceptor.kt) and
    // forwards an explicit header verbatim. A store that compresses on the fly
    // (Bunny, 2026-09-16 gate) answers with a WEAK ETag (`W/"…"`) for the
    // encoded representation — refused by If-Match (412 on every CAS overwrite)
    // and never equal to the listing ETag (every state object re-read each
    // cycle). Signed, so a proxy cannot alter it unseen.
    return send('GET', key, undefined, { 'accept-encoding': 'identity' }, '', async (res, controller) => {
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new S3TransportError(res.status, categorize(res.status),
          `S3 GET ${key} failed (${res.status}).`, true);
      }
      const buf = await readAllBytes(res, controller, `S3 GET ${key}`, options.onProgress);
      return { body: buf, etag: res.headers.get('etag') ?? '' };
    });
  }

  async function getObjectToFile(
    key: string,
    fileUri: string,
    options: GetObjectToFileOptions = {},
  ): Promise<{ etag: string; bytesWritten: number } | null> {
    if (downloadFile === undefined) {
      throw new Error('S3 getObjectToFile requires a download file port');
    }
    const uri = `/${credentials.bucket}/${encodeKeyPath(key)}`;
    const signedHeaders = signRequest({
      method: 'GET',
      host: hostOf(base),
      canonicalUri: uri,
      canonicalQuery: '',
      extraHeaders: { 'accept-encoding': 'identity' },
      payloadHashHex: S3_EMPTY_PAYLOAD_SHA256,
      credentials,
      amzDate: now(),
    });
    const url = `${base}${uri}`;
    const headers = {
      ...withoutHost(signedHeaders),
      // cloudFetch adds this header for fetch-backed requests. File ports do
      // not pass through cloudFetch, and it is deliberately outside SigV4.
      'cache-control': 'no-cache, no-store',
    };
    const controller = new AbortController();
    const maxBytes = options.maxBytes ?? LIBRARY_MAX_OBJECT_ENVELOPE_BYTES;
    let settled = false;
    let progressSeen = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectStall!: (error: S3TransportError) => void;
    const armStall = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (settled) return;
      stallTimer = setTimeout(() => {
        if (settled) return;
        controller.abort();
        rejectStall(new S3TransportError(0, 'network', `S3 GET ${key} stalled.`, false));
      }, progressSeen ? stallMs : connectMs);
    };
    const stalled = new Promise<never>((_, reject) => {
      rejectStall = reject;
      armStall();
    });
    const run = (async () => {
      try {
        return await downloadFile({
          url,
          fileUri,
          headers,
          maxBytes,
          signal: controller.signal,
          onProgress: (progress) => {
            progressSeen = true;
            armStall();
            options.onProgress?.({ sent: progress.bytesReceived, total: progress.total });
          },
        });
      } catch (error) {
        if (error instanceof S3DownloadError) throw error;
        throw new S3DownloadError('network', `S3 GET ${key} failed before a response.`);
      }
    })();

    let response: Awaited<typeof run>;
    try {
      response = await Promise.race([run, stalled]);
    } catch (error) {
      if (error instanceof S3TransportError || error instanceof S3LocalWriteError) {
        throw error;
      }
      if (error instanceof S3DownloadError) {
        if (error.kind === 'local_io') {
          throw new S3LocalWriteError(error.message);
        }
        if (error.kind === 'too_large') {
          throw new S3TransportError(0, 'client', error.message, true);
        }
        if (error.kind === 'duplicate') {
          throw new S3TransportError(0, 'client', error.message, true);
        }
        throw new S3TransportError(0, 'network', error.message, false);
      }
      throw new S3TransportError(0, 'network', `S3 GET ${key} failed before a response.`, false);
    } finally {
      settled = true;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      run.catch(() => undefined);
    }

    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) {
      const detail = response.errorBody.slice(0, 64 * 1024);
      throw new S3TransportError(
        response.status,
        categorize(response.status),
        `S3 GET ${key} failed (${response.status})${detail ? `: ${detail}` : '.'}`,
        true,
      );
    }
    return {
      etag: headerValue(response.headers, 'etag') ?? '',
      bytesWritten: response.bytesWritten,
    };
  }

  async function deleteObject(key: string): Promise<void> {
    return send('DELETE', key, undefined, {}, '', async (res) => {
      if (!res.ok && res.status !== 404) {
        throw new S3TransportError(res.status, categorize(res.status),
          `S3 DELETE ${key} failed (${res.status}).`, writeOutcomeKnown(res.status));
      }
    });
  }

  async function listObjects(
    prefix: string, continuationToken: string | undefined,
  ): Promise<S3ListPage> {
    const params: (readonly [string, string])[] = [
      ['list-type', '2'],
      ['prefix', prefix],
    ];
    if (continuationToken) params.push(['continuation-token', continuationToken]);
    const query = canonicalQueryString(params);
    // List is a bucket-level GET: key segment empty.
    const uri = `/${credentials.bucket}`;
    const headers = signRequest({
      method: 'GET', host: hostOf(base),
      canonicalUri: uri, canonicalQuery: query,
      extraHeaders: {}, payloadHashHex: S3_EMPTY_PAYLOAD_SHA256,
      credentials, amzDate: now(),
    });
    const controller = new AbortController();
    const res = await raceStep(
      async () => {
        try {
          return await doFetch(`${base}${uri}?${query}`, {
            method: 'GET', headers: withoutHost(headers), signal: controller.signal,
          });
        } catch {
          throw new S3TransportError(0, 'network', 'S3 LIST failed before a response.', false);
        }
      },
      connectMs,
      controller,
      () => new S3TransportError(0, 'network', `S3 LIST ${prefix} timed out.`, false),
    );
    if (!res.ok) {
      throw new S3TransportError(res.status, categorize(res.status),
        `S3 LIST ${prefix} failed (${res.status}).`, true);
    }
    return parseListXml(await readAllText(res, controller, `S3 LIST ${prefix}`));
  }

  return {
    putObject,
    putObjectFromFile,
    getObject,
    getObjectToFile,
    deleteObject,
    listObjects,
    hashPayload,
    downloadFileAvailable: downloadFile !== undefined,
  };
}

/** Minimal ListBucketResult parser (no XML dependency). */
export function parseListXml(xml: string): S3ListPage {
  const objects: S3ListItem[] = [];
  const contentsOpen = '<Contents>';
  const contentsClose = '</Contents>';
  let scanAt = 0;
  while (true) {
    const contentsAt = xml.indexOf(contentsOpen, scanAt);
    if (contentsAt < 0) break;
    const blockStart = contentsAt + contentsOpen.length;
    const blockEnd = xml.indexOf(contentsClose, blockStart);
    // Match the old lazy regex: an unfinished final Contents block ends the scan.
    if (blockEnd < 0) break;
    const block = xml.slice(blockStart, blockEnd);
    const key = firstXmlTagValue(block, '<Key>', '</Key>') ?? '';
    const rawEtag = firstXmlTagValue(block, '<ETag>', '</ETag>') ?? '';
    // AWS wraps the ETag in &quot;; MinIO uses the numeric entity &#34; for the
    // same double quote. Decode both so a listing ETag equals the header ETag.
    const etag = decodeXml(rawEtag);
    const lastModified = firstXmlTagValue(block, '<LastModified>', '</LastModified>') ?? '';
    const rawSize = firstXmlTagValue(block, '<Size>', '</Size>');
    const size = rawSize === undefined ? 0 : Number.parseInt(rawSize, 10);
    const decodedKey = decodeXml(key);
    scanAt = blockEnd + contentsClose.length;
    // A size-0 key ending in `/` is a directory placeholder (console-created
    // "folders"; Bunny lists one per prefix beside the real objects). The
    // protocol never writes such a key, so it is never a BYOS object.
    if (decodedKey.endsWith('/') && (Number.isNaN(size) || size === 0)) continue;
    objects.push({
      key: decodedKey, etag, lastModified,
      size: Number.isNaN(size) ? 0 : size,
    });
  }
  const truncated = xml.indexOf('<IsTruncated>true</IsTruncated>') >= 0;
  const nextToken = truncated
    ? firstXmlTagValue(xml, '<NextContinuationToken>', '</NextContinuationToken>')
    : undefined;
  return { objects, nextToken };
}

function firstXmlTagValue(source: string, openTag: string, closeTag: string): string | undefined {
  const openAt = source.indexOf(openTag);
  if (openAt < 0) return undefined;
  const valueStart = openAt + openTag.length;
  const closeAt = source.indexOf(closeTag, valueStart);
  return closeAt < 0 ? undefined : source.slice(valueStart, closeAt);
}

const NAMED_XML_ENTITIES: Readonly<Record<string, string>> = {
  quot: '"', apos: "'", lt: '<', gt: '>', amp: '&',
};

/**
 * Decodes the XML character references S3 backends emit inside text nodes.
 * Handles the five named entities plus decimal (`&#34;`) and hexadecimal
 * (`&#x22;`) numeric references — MinIO uses `&#34;` where AWS uses `&quot;`
 * for the double quote that wraps an ETag. `&amp;` is resolved in the same
 * pass as every other reference (a single left-to-right scan), so an already
 * literal `&` in decoded output is never re-interpreted.
 */
/** XML character references → text: named (`&amp;`) and numeric (`&#38;`, `&#x26;`) in one left-to-right pass. Exported for the WebDAV adapter's PROPFIND parser (board #12). */
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_XML_ENTITIES[body] ?? match;
  });
}
