import {
  S3DownloadError,
  type S3DownloadFilePort,
} from '@/features/byos/s3-file-download';
import type { S3UploadFilePort, S3UploadFileRequest } from '@/features/byos/s3-transport';
import { LIBRARY_MAX_OBJECT_ENVELOPE_BYTES } from '@/features/library/library-limits';

import {
  CloudStoreError,
  CloudStoreLocalWriteError,
  type CloudGetProgress,
} from './cloud-object-store';

/** The subset of a streaming body both adapters read. */
export type BodyStream = { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };

/**
 * Races one step against a deadline; on timeout aborts the shared controller
 * and rejects with the caller-made error. Used once to bound connect+headers
 * and once PER body chunk, so a slow-but-steady transfer never times out —
 * only true silence does (K5).
 */
export async function raceStep<T>(
  run: () => Promise<T>,
  ms: number,
  controller: AbortController,
  makeError: () => CloudStoreError,
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

/**
 * Reads a whole body under the per-chunk stall watchdog, reporting bytes as
 * they arrive. `total` is the announced `content-length`, or `null` when the
 * server sent none — the honest answer that draws the indeterminate ring
 * (spec §4 补裁), never a guess. Every report happens before this resolves:
 * the client clears the ring in its `finally`, so a late report would leak.
 */
export async function readAllBytes(
  res: Response,
  controller: AbortController,
  stallMs: number,
  label: string,
  onProgress?: (progress: CloudGetProgress) => void,
): Promise<Uint8Array> {
  const stallError = (): CloudStoreError => new CloudStoreError(0, 'network', `${label} stalled.`, false);
  const announced = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  const total = Number.isNaN(announced) ? null : announced;
  const stream = (res as unknown as { body?: BodyStream | null }).body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await raceStep(() => reader.read(), stallMs, controller, stallError);
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        received += value.byteLength;
        onProgress?.({ sent: received, total });
      }
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  }
  // No stream (a fake, or a runtime without one): one buffered read under one
  // stall window, and one report that is still a real byte count.
  const buffered = await raceStep(() => res.arrayBuffer(), stallMs, controller, stallError);
  const out = new Uint8Array(buffered);
  onProgress?.({ sent: out.byteLength, total: total ?? out.byteLength });
  return out;
}

/**
 * The JSON body of a non-ok response, read under the same per-chunk stall
 * watchdog as `readAllBytes` on the request's OWN controller: the device
 * fetch has no read timeout, and a bound that raced a fresh controller would
 * leave the real socket open forever (board #9, spec §5.2). `null` on a stall,
 * an empty body, or anything that is not JSON — the caller then classifies by
 * status alone, exactly as it did for an unparseable body.
 */
export async function readFailureBody(res: Response, controller: AbortController, stallMs: number): Promise<unknown> {
  try {
    const bytes = await readAllBytes(res, controller, stallMs, `HTTP ${res.status} error body`);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export type StallWatchdogDownload = Readonly<{
  connectMs: number;
  stallMs: number;
  label: string;
  request: Readonly<{ url: string; fileUri: string; headers: Record<string, string> }>;
  downloadFile: S3DownloadFilePort;
  onProgress?: (progress: CloudGetProgress) => void;
}>;

type NativeDownloadResult = Awaited<ReturnType<S3DownloadFilePort>>;

/**
 * Bounds one native file GET from connection through the last byte. Before
 * the first progress event the connect window applies; after that, each event
 * re-arms the stall window. The port's status is data for the adapter.
 */
export async function downloadWithStallWatchdog(input: StallWatchdogDownload): Promise<NativeDownloadResult> {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStall: () => void = () => {};
  const arm = (ms: number): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (settled) return;
    timer = setTimeout(() => onStall(), ms);
  };
  const stalled = new Promise<never>((_, reject) => {
    onStall = () => {
      if (settled) return;
      controller.abort();
      reject(new CloudStoreError(0, 'network', `${input.label} stalled.`, false));
    };
  });
  arm(input.connectMs);
  const run = (async (): Promise<NativeDownloadResult> => {
    try {
      return await input.downloadFile({
        ...input.request,
        maxBytes: LIBRARY_MAX_OBJECT_ENVELOPE_BYTES,
        signal: controller.signal,
        onProgress: (progress) => {
          if (settled) return;
          arm(input.stallMs);
          input.onProgress?.({ sent: progress.bytesReceived, total: progress.total });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof S3DownloadError && error.kind === 'too_large') {
        throw new CloudStoreError(0, 'client', `${input.label} exceeds ${LIBRARY_MAX_OBJECT_ENVELOPE_BYTES} bytes.`, true);
      }
      if (error instanceof S3DownloadError && error.kind === 'local_io') {
        throw new CloudStoreLocalWriteError(`${input.label}: ${message}`);
      }
      throw new CloudStoreError(0, 'network', `${input.label} failed before completing: ${message}`, false);
    }
  })();
  try {
    return await Promise.race([run, stalled]);
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    // The watchdog may win while the native promise rejects on abort. Consume
    // that losing rejection so it cannot surface as an unhandled rejection.
    run.catch(() => {});
  }
}

export type StallWatchdogUpload = Readonly<{
  stallMs: number;
  /** For messages: `WebDAV PUT blobs/x`, `OneDrive fragment 2/5 of blobs/x`. */
  label: string;
  request: Omit<S3UploadFileRequest, 'onProgress' | 'signal'>;
  uploadFile: S3UploadFilePort;
  onProgress?: (bytesSent: number) => void;
}>;

/**
 * The K5 stall watchdog around one upload-port call: the native task reports
 * bytes as they leave, every report re-arms the window, only true silence
 * aborts the socket. A report that lands after the abort is dropped — it
 * would repopulate a ring the caller already cleared. Resolves with the port's
 * status (non-2xx is data for the caller's status → category map). Port
 * throws are classified here: an unreadable file is `client` (outcome
 * known), anything else `network` (outcome unknown).
 */
export async function uploadWithStallWatchdog(input: StallWatchdogUpload): Promise<number> {
  const controller = new AbortController();
  let settled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let onStall: () => void = () => {};
  const armStall = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    if (settled) return;
    stallTimer = setTimeout(() => onStall(), input.stallMs);
  };
  const stalled = new Promise<never>((_, reject) => {
    onStall = () => {
      if (settled) return;
      controller.abort();
      reject(new CloudStoreError(0, 'network', `${input.label} stalled.`, false));
    };
  });
  armStall();
  const run = (async (): Promise<{ status: number }> => {
    try {
      return await input.uploadFile({
        ...input.request,
        signal: controller.signal,
        onProgress: (progress) => {
          if (settled) return;
          armStall();
          input.onProgress?.(progress.bytesSent);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An unreadable staging file is the caller's fault, not the network's:
      // nothing left this device (contract: `client`).
      if (/ENOENT|no such file|does not exist|not found/i.test(message)) {
        throw new CloudStoreError(0, 'client', `${input.label}: cannot read ${input.request.fileUri} (${message}).`, true);
      }
      throw new CloudStoreError(0, 'network', `${input.label} failed before a response: ${message}`, false);
    }
  })();
  let response: { status: number };
  try {
    response = await Promise.race([run, stalled]);
  } finally {
    settled = true;
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    // A losing `run` that rejects later must not become an unhandled rejection
    // once the watchdog has already won the race.
    run.catch(() => {});
  }
  return response.status;
}
