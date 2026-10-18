import { S3DownloadError } from '@/features/byos/s3-file-download';
import { LIBRARY_MAX_OBJECT_ENVELOPE_BYTES } from '@/features/library/library-limits';

import { CloudStoreError } from './cloud-object-store';
import { downloadWithStallWatchdog, raceStep, readAllBytes, readFailureBody, uploadWithStallWatchdog } from './cloud-store-http';

const stall = (label: string) => () => new CloudStoreError(0, 'network', `${label} stalled.`, false);

describe('raceStep', () => {
  test('resolves the step when it settles inside the window', async () => {
    const controller = new AbortController();
    await expect(raceStep(async () => 7, 1000, controller, stall('x'))).resolves.toBe(7);
    expect(controller.signal.aborted).toBe(false);
  });
  test('aborts the controller and rejects with the caller-made error when the window elapses', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const p = raceStep(() => new Promise<never>(() => {}), 500, controller, stall('GET a'));
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', message: 'GET a stalled.' });
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
      expect(controller.signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

describe('readAllBytes', () => {
  test('streams chunks, reports monotone progress with the announced total, and returns the concatenation', async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    let i = 0;
    const res = {
      headers: new Headers({ 'content-length': '3' }),
      body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
    } as unknown as Response;
    const seen: { sent: number; total: number | null }[] = [];
    const out = await readAllBytes(res, new AbortController(), 1000, 'GET a', (p) => seen.push({ ...p }));
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(seen).toEqual([{ sent: 2, total: 3 }, { sent: 3, total: 3 }]);
  });
  test('without a stream it buffers once under one stall window and reports sent = total = the real byte count when the server announced none', async () => {
    const res = { headers: new Headers(), arrayBuffer: async () => new Uint8Array([9, 9]).buffer } as unknown as Response;
    const seen: { sent: number; total: number | null }[] = [];
    const out = await readAllBytes(res, new AbortController(), 1000, 'GET a', (p) => seen.push({ ...p }));
    expect(Array.from(out)).toEqual([9, 9]);
    expect(seen).toEqual([{ sent: 2, total: 2 }]);
  });
});

describe('readFailureBody', () => {
  test('parses a JSON error body; a non-JSON or empty body is null', async () => {
    const controller = new AbortController();
    await expect(readFailureBody(new Response('{"error":{"code":"x"}}', { status: 503 }), controller, 1000)).resolves.toEqual({ error: { code: 'x' } });
    await expect(readFailureBody(new Response('<html>proxy</html>', { status: 502 }), controller, 1000)).resolves.toBeNull();
    await expect(readFailureBody(new Response(null, { status: 500 }), controller, 1000)).resolves.toBeNull();
    expect(controller.signal.aborted).toBe(false);
  });
  test('a body that never completes is null after stallMs, and the caller\'s (the request\'s) controller is aborted', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const p = readFailureBody(new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 }), controller, 500);
      const assertion = expect(p).resolves.toBeNull();
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
      expect(controller.signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  }, 5000);
});

describe('uploadWithStallWatchdog', () => {
  test('re-arms on every progress report and resolves with the port status', async () => {
    jest.useFakeTimers();
    try {
      const seen: number[] = [];
      const p = uploadWithStallWatchdog({
        stallMs: 1000,
        label: 'PUT b',
        request: { url: 'https://x/y', fileUri: 'file:///f', headers: {} },
        uploadFile: (req) => new Promise((resolve) => {
          // Progress at 900ms re-arms the 1000ms window to a new deadline at
          // 1900ms; the port then resolves at 1700ms — after the ORIGINAL
          // deadline, but inside the re-armed one. Only the re-arm saves it.
          setTimeout(() => req.onProgress?.({ bytesSent: 5, totalBytes: 10 }), 900);
          setTimeout(() => resolve({ status: 201, headers: {} }), 1700);
        }),
        onProgress: (sent) => seen.push(sent),
      });
      const assertion = expect(p).resolves.toBe(201);
      await jest.advanceTimersByTimeAsync(900);
      await jest.advanceTimersByTimeAsync(800);
      await assertion;
      expect(seen).toEqual([5]);
    } finally { jest.useRealTimers(); }
  });
  test('silence for stallMs aborts the port and rejects network/outcome-unknown; a report before the abort is forwarded and a late one is dropped', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false; let late: (() => void) | null = null; const seen: number[] = [];
      const p = uploadWithStallWatchdog({
        stallMs: 1000, label: 'PUT b',
        request: { url: 'https://x/y', fileUri: 'file:///f', headers: {} },
        uploadFile: (req) => new Promise((_, reject) => {
          setTimeout(() => req.onProgress?.({ bytesSent: 1, totalBytes: 2 }), 500);
          late = () => req.onProgress?.({ bytesSent: 1, totalBytes: 2 });
          req.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        }),
        onProgress: (sent) => seen.push(sent),
      });
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: 'PUT b stalled.' });
      await jest.advanceTimersByTimeAsync(500);
      expect(seen).toEqual([1]);
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(aborted).toBe(true);
      late!();
      expect(seen).toEqual([1]);
    } finally { jest.useRealTimers(); }
  });
  test('an unreadable staging file is a client error (nothing left the device); any other throw is network/unknown', async () => {
    await expect(uploadWithStallWatchdog({ stallMs: 1000, label: 'PUT b', request: { url: 'u', fileUri: 'file:///missing', headers: {} }, uploadFile: async () => { throw new Error('ENOENT: no such file'); } }))
      .rejects.toMatchObject({ category: 'client', outcomeKnown: true });
    await expect(uploadWithStallWatchdog({ stallMs: 1000, label: 'PUT b', request: { url: 'u', fileUri: 'file:///f', headers: {} }, uploadFile: async () => { throw new Error('socket reset'); } }))
      .rejects.toMatchObject({ category: 'network', outcomeKnown: false });
  });
});

describe('downloadWithStallWatchdog', () => {
  const request = { url: 'https://x/y', fileUri: 'file:///f', headers: { authorization: 'x' } };
  const response = (status: number) => ({ status, headers: {}, redirected: false, errorBody: '', bytesWritten: status >= 200 && status < 300 ? 3 : 0 });

  test.each([200, 404])('passes status %s through as data', async (status) => {
    await expect(downloadWithStallWatchdog({ connectMs: 100, stallMs: 100, label: 'GET x', request, downloadFile: async () => response(status) })).resolves.toMatchObject({ status });
  });

  test('uses connectMs until the first progress report, then re-arms stallMs for every report', async () => {
    jest.useFakeTimers();
    try {
      let report: ((progress: { bytesReceived: number; total: number | null }) => void) | undefined;
      const seen: { sent: number; total: number | null }[] = [];
      const watched = downloadWithStallWatchdog({
        connectMs: 1000,
        stallMs: 500,
        label: 'GET x',
        request,
        downloadFile: async (req) => new Promise((resolve) => {
          report = req.onProgress;
          setTimeout(() => report?.({ bytesReceived: 1, total: null }), 900);
          setTimeout(() => report?.({ bytesReceived: 2, total: null }), 1300);
          setTimeout(() => resolve(response(200)), 1600);
        }),
        onProgress: (progress) => seen.push(progress),
      });
      await jest.advanceTimersByTimeAsync(899);
      expect(seen).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      await jest.advanceTimersByTimeAsync(400);
      expect(seen).toEqual([{ sent: 1, total: null }, { sent: 2, total: null }]);
      await jest.advanceTimersByTimeAsync(300);
      await expect(watched).resolves.toMatchObject({ status: 200 });
      expect(seen).toEqual([{ sent: 1, total: null }, { sent: 2, total: null }]);
    } finally { jest.useRealTimers(); }
  });

  test('silence before first progress aborts at connectMs and rejects as network; late port rejection is contained', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const p = downloadWithStallWatchdog({
        connectMs: 1000,
        stallMs: 500,
        label: 'GET x',
        request,
        downloadFile: (req) => new Promise((_, reject) => {
          req.signal?.addEventListener('abort', () => { aborted = true; setTimeout(() => reject(new Error('aborted')), 10); });
        }),
      });
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: 'GET x stalled.' });
      await jest.advanceTimersByTimeAsync(999);
      expect(aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await assertion;
      expect(aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(10);
    } finally { jest.useRealTimers(); }
  });

  test('after the first progress report, stallMs is the active deadline and re-arms on each report', async () => {
    jest.useFakeTimers();
    try {
      let report: ((progress: { bytesReceived: number; total: number | null }) => void) | undefined;
      let aborted = false;
      const p = downloadWithStallWatchdog({
        connectMs: 5000,
        stallMs: 1000,
        label: 'GET x',
        request,
        downloadFile: (req) => new Promise((_, reject) => {
          report = req.onProgress;
          req.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
        }),
      });
      await Promise.resolve();
      report?.({ bytesReceived: 1, total: null });
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', message: 'GET x stalled.' });
      await jest.advanceTimersByTimeAsync(999);
      expect(aborted).toBe(false);
      report?.({ bytesReceived: 2, total: null });
      await jest.advanceTimersByTimeAsync(999);
      expect(aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await assertion;
      expect(aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });

  test('drops a progress report after settlement', async () => {
    let late: ((progress: { bytesReceived: number; total: number | null }) => void) | undefined;
    const seen: { sent: number; total: number | null }[] = [];
    await downloadWithStallWatchdog({
      connectMs: 100,
      stallMs: 100,
      label: 'GET x',
      request,
      downloadFile: async (req) => { late = req.onProgress; return response(200); },
      onProgress: (progress) => seen.push(progress),
    });
    late?.({ bytesReceived: 9, total: 9 });
    expect(seen).toEqual([]);
  });

  test.each([
    ['network', new S3DownloadError('network', 'offline'), 'CloudStoreError', 'network'],
    ['cancelled', new S3DownloadError('cancelled', 'stopped'), 'CloudStoreError', 'network'],
    ['duplicate', new S3DownloadError('duplicate', 'duplicate'), 'CloudStoreError', 'network'],
    ['plain error', new Error('socket reset'), 'CloudStoreError', 'network'],
  ])('%s maps to a network CloudStoreError', async (_name, error, errorName, category) => {
    await expect(downloadWithStallWatchdog({ connectMs: 100, stallMs: 100, label: 'GET x', request, downloadFile: async () => { throw error; } }))
      .rejects.toMatchObject({ name: errorName, category, status: 0, outcomeKnown: false, message: expect.stringContaining('failed before completing:') });
  });

  test('maps too_large to a known client error and local_io to CloudStoreLocalWriteError', async () => {
    await expect(downloadWithStallWatchdog({ connectMs: 100, stallMs: 100, label: 'GET x', request, downloadFile: async () => { throw new S3DownloadError('too_large', 'too big'); } }))
      .rejects.toMatchObject({ name: 'CloudStoreError', category: 'client', outcomeKnown: true, message: `GET x exceeds ${LIBRARY_MAX_OBJECT_ENVELOPE_BYTES} bytes.` });
    await expect(downloadWithStallWatchdog({ connectMs: 100, stallMs: 100, label: 'GET x', request, downloadFile: async () => { throw new S3DownloadError('local_io', 'disk full'); } }))
      .rejects.toMatchObject({ name: 'CloudStoreLocalWriteError', message: 'GET x: disk full' });
  });

  test('passes the bounded size to the port', async () => {
    let maxBytes = 0;
    await downloadWithStallWatchdog({ connectMs: 100, stallMs: 100, label: 'GET x', request, downloadFile: async (req) => { maxBytes = req.maxBytes; return response(200); } });
    expect(maxBytes).toBe(LIBRARY_MAX_OBJECT_ENVELOPE_BYTES);
  });
});
