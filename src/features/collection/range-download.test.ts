import {
  LIBRARY_RANGE_DOWNLOAD_MAX_PARTS,
  LIBRARY_RANGE_DOWNLOAD_MIN_BYTES,
  parseRangeProbe,
  planRanges,
  shouldUseRanges,
} from '@/features/collection/range-download';

describe('planRanges', () => {
  test('splits the measured 4.25 MB wallpaper into the max windows that tile the file exactly', () => {
    const total = 4_250_693;
    const windows = planRanges(total);

    // ~512 KB target parts, capped at LIBRARY_RANGE_DOWNLOAD_MAX_PARTS (8):
    // ceil(4.25 MB / 512 KB) = 9 → 8. Eight streams beat the source's per-stream
    // throttle instead of the old four.
    expect(windows).toHaveLength(8);
    expect(windows[0][0]).toBe(0);
    expect(windows[windows.length - 1][1]).toBe(total - 1);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index][0]).toBe(windows[index - 1][1] + 1);
    }
    const covered = windows.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
    expect(covered).toBe(total);
  });

  test('leaves a file smaller than one part whole', () => {
    expect(planRanges(500_000)).toEqual([[0, 499_999]]);
  });

  test('keeps every window at least one part wide and never exceeds the part ceiling', () => {
    const total = 64 * LIBRARY_RANGE_DOWNLOAD_MIN_BYTES;
    const windows = planRanges(total);

    expect(windows).toHaveLength(LIBRARY_RANGE_DOWNLOAD_MAX_PARTS);
    for (const [start, end] of windows) {
      expect(end - start + 1).toBeGreaterThanOrEqual(LIBRARY_RANGE_DOWNLOAD_MIN_BYTES);
    }
  });

  test('refuses to plan a download of nothing', () => {
    expect(planRanges(0)).toEqual([]);
  });
});

describe('shouldUseRanges', () => {
  const big = 4_250_693;

  test('splits a large file the host serves by range when the native module is linked', () => {
    expect(shouldUseRanges(big, true, true)).toBe(true);
  });

  test('leaves a small file on the single-stream path', () => {
    expect(shouldUseRanges(500_000, true, true)).toBe(false);
  });

  test('leaves a host that does not serve ranges alone', () => {
    expect(shouldUseRanges(big, false, true)).toBe(false);
  });

  test('falls back when the native module is not linked', () => {
    expect(shouldUseRanges(big, true, false)).toBe(false);
  });

  test('does not take the parallel path for a file below the split floor', () => {
    // A file at or under one target part plans to a single window — no probe.
    expect(shouldUseRanges(LIBRARY_RANGE_DOWNLOAD_MIN_BYTES, true, true)).toBe(false);
    expect(shouldUseRanges(LIBRARY_RANGE_DOWNLOAD_MIN_BYTES - 1, true, true)).toBe(false);
  });

  test('splits once a file exceeds one target part', () => {
    expect(shouldUseRanges(LIBRARY_RANGE_DOWNLOAD_MIN_BYTES + 1, true, true)).toBe(true);
    expect(planRanges(2 * LIBRARY_RANGE_DOWNLOAD_MIN_BYTES)).toHaveLength(2);
  });
});

describe('parseRangeProbe', () => {
  test('reads the total and range support from a 206 content-range', () => {
    expect(parseRangeProbe(206, { 'content-range': 'bytes 0-0/4250693' })).toEqual({
      kind: 'probe',
      totalBytes: 4_250_693,
      acceptsRanges: true,
    });
  });

  test('accepts a 200 that advertises byte ranges with a length', () => {
    expect(parseRangeProbe(200, {
      'accept-ranges': 'bytes',
      'content-length': '4250693',
    })).toEqual({ kind: 'probe', totalBytes: 4_250_693, acceptsRanges: true });
  });

  test('reports no range support when the host says none', () => {
    expect(parseRangeProbe(200, {
      'accept-ranges': 'none',
      'content-length': '4250693',
    })).toEqual({ kind: 'probe', totalBytes: 4_250_693, acceptsRanges: false });
  });

  test('is unusable without a size', () => {
    expect(parseRangeProbe(200, { 'accept-ranges': 'bytes' })).toBeNull();
  });

  test('is unusable when the host answers with an error', () => {
    expect(parseRangeProbe(403, { 'content-range': 'bytes 0-0/4250693' })).toBeNull();
  });

  // Board #5. A 404/410 is the one non-2xx answer worth keeping: it says the
  // source deleted the file, so it must reach the failure classifier instead of
  // being flattened into the same `null` as "this host cannot serve windows".
  test('keeps a 404 as the source having deleted the image', () => {
    expect(parseRangeProbe(404, {})).toEqual({ kind: 'gone', status: 404 });
  });

  test('keeps a 410 as the source having deleted the image', () => {
    expect(parseRangeProbe(410, { 'content-length': '0' })).toEqual({
      kind: 'gone',
      status: 410,
    });
  });
});
