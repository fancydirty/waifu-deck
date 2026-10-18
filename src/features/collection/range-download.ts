/**
 * K6-4c. How a large image is split into parallel HTTP `Range` requests.
 *
 * Measured on the owner's network (2026-09-14) against the booru file host —
 * Cloudflare-fronted, `accept-ranges: bytes`, cache HIT: the host serves about
 * 150 KB/s *per stream* and the aggregate scales with the number of streams, so
 * the limit is per-connection rather than per-IP. A 4.25 MB wallpaper took 29 s
 * on one stream and 9.5 s as four simultaneous windows. Splitting is therefore
 * the only app-side move that lowers the latency of a *single* large save; the
 * K6-4b task semaphore only helps when there are many saves in flight.
 *
 * Everything here is pure so the thresholds are testable without a network, a
 * native module, or a device.
 */

/** 1 MiB. Below this a second connection costs more handshake than it saves. */
// Split threshold: below this a single stream is fine and a probe would only
// add a round trip.
export const LIBRARY_RANGE_DOWNLOAD_MIN_BYTES = 512 * 1024;
// Target bytes per window. The source (measured) throttles ~150 KB/s PER
// STREAM, so throughput scales with window count; ~512 KB windows give a
// 4 MB image 8 parts (~1.2 MB/s ≈ 3.5 s) instead of 4 (~29 s single-stream).
export const LIBRARY_RANGE_TARGET_PART_BYTES = 512 * 1024;

/**
 * Eight windows at ~150 KB/s each is ~1.2 MB/s, which puts a 4 MB image around
 * 3.5 s — inside the owner's 5 s bar. More windows would keep adding streams,
 * but each one is another connection to a third party's public CDN for a single
 * user action, and the returns past 8 are already below the per-save variance.
 */
export const LIBRARY_RANGE_DOWNLOAD_MAX_PARTS = 8;

/**
 * The process-wide ceiling on simultaneous window requests, counted across
 * every image. The K6-4b semaphore in `collection-service.ts` bounds *tasks*
 * (16), and a task may open up to {@link LIBRARY_RANGE_DOWNLOAD_MAX_PARTS}
 * windows, so without a second bound a burst of saves would reach 128 sockets
 * against one third-party CDN. 32 keeps two full-width images and change in
 * flight — well past the ~2.4 MB/s the source saturates at — while staying a
 * number a booru operator would not read as abuse.
 */
export const LIBRARY_RANGE_SEGMENT_CONCURRENCY = 32;

export type RangeWindow = readonly [start: number, end: number];

export type RangeProbe = {
  kind: 'probe';
  totalBytes: number;
  acceptsRanges: boolean;
};

/**
 * Board #5. The source answered that this file is gone. It is kept apart from
 * `null` — "this answer is unusable, fall back to one stream" — because a 404
 * on the probe is a 404 on the file: falling back would spend another round
 * trip and lose the status the failure classifier needs.
 */
export type RangeProbeGone = { kind: 'gone'; status: 404 | 410 };

export type RangeProbeResult = RangeProbe | RangeProbeGone | null;

/**
 * Tiles `[0, total - 1]` into contiguous windows of at least `minPart` bytes,
 * capped at `maxParts`. The windows are handed to the native downloader, which
 * writes each one at its own offset in a pre-sized file — so they must cover the
 * file exactly once, with no gap and no overlap.
 */
export function planRanges(
  total: number,
  minPart: number = LIBRARY_RANGE_TARGET_PART_BYTES,
  maxParts: number = LIBRARY_RANGE_DOWNLOAD_MAX_PARTS,
): RangeWindow[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  // Number of windows: aim for `minPart`-sized parts, floor at 1 (no split),
  // ceil so a 2.7 MB file at 512 KB parts becomes 6, not 5.
  const parts = Math.max(1, Math.min(maxParts, Math.ceil(total / minPart)));
  const size = Math.floor(total / parts);
  return Array.from({ length: parts }, (_unused, index) => {
    const start = index * size;
    const end = index === parts - 1 ? total - 1 : start + size - 1;
    return [start, end] as RangeWindow;
  });
}

/**
 * Whether this download should go down the parallel path at all.
 *
 * The size test is {@link planRanges} itself: a file it tiles into one window
 * gains nothing from the parallel path and would only pay for the probe. Since
 * every window must be at least {@link LIBRARY_RANGE_DOWNLOAD_MIN_BYTES} wide,
 * that puts the real threshold at two parts — 2 MiB — rather than at 1 MiB.
 */
export function shouldUseRanges(
  total: number,
  acceptRanges: boolean,
  nativeAvailable: boolean,
): boolean {
  if (!acceptRanges || !nativeAvailable) return false;
  return planRanges(total).length > 1;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const match = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

/**
 * Reads the size and range support out of the probe response — a
 * `Range: bytes=0-0` GET, which costs one byte and, unlike HEAD, is answered by
 * every host that can actually serve windows.
 *
 * A 206 is the strongest possible answer: the host just served a window, and
 * `content-range` carries the full size. A 200 is only trusted when it both
 * advertises `accept-ranges: bytes` and declares a length — without the length
 * there is nothing to split, and a chunked or unknown-size response would make
 * the last window's end a guess.
 *
 * Board #5: a 404 or 410 is reported rather than discarded, so the caller can
 * fail the save with the status instead of retrying on the single-stream path.
 */
export function parseRangeProbe(
  status: number,
  headers: Readonly<Record<string, string>>,
): RangeProbeResult {
  if (status === 404 || status === 410) return { kind: 'gone', status };
  if (status !== 200 && status !== 206) return null;
  const contentRange = headerValue(headers, 'content-range');
  const fromRange = contentRange?.match(/\/(\d+)\s*$/)?.[1];
  if (status === 206) {
    if (fromRange === undefined) return null;
    return { kind: 'probe', totalBytes: Number(fromRange), acceptsRanges: true };
  }
  const length = headerValue(headers, 'content-length');
  if (length === undefined || !/^\d+$/.test(length.trim())) return null;
  const total = Number(length.trim());
  if (total <= 0) return null;
  const acceptRanges = headerValue(headers, 'accept-ranges')?.trim().toLowerCase();
  return { kind: 'probe', totalBytes: total, acceptsRanges: acceptRanges === 'bytes' };
}
