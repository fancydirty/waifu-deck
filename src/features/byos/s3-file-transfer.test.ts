// The production adapter's whole job is to call `expo-file-system`'s upload
// task correctly. Under `jest-expo` the unmocked native module answers with
// silently wrong values (K6-1e's hazard: `expo-crypto`'s digest returns 32 zero
// bytes), and an auto-mocked `createUploadTask` would return `undefined`, so
// every assertion below would be vacuous. Map the module to the explicit
// double, which records exactly what was asked for.
jest.mock('expo-file-system', () => require('../../test/expo-file-system-double'));

import {
  recordedUploads,
  resetExpoFileSystemDouble,
  setUploadPlan,
} from '@/test/expo-file-system-double';

import {
  createNativeUploadFile,
  expoUploadFile,
  selectUploadFilePort,
  type NativeUploader,
} from './s3-file-transfer';

beforeEach(() => {
  resetExpoFileSystemDouble();
});

test('uploads the file as a raw binary PUT body with the signed headers', async () => {
  setUploadPlan({ result: { status: 200, headers: { etag: '"abc"' }, body: '' } });
  const response = await expoUploadFile({
    url: 'https://s3.example.com/b/blobs/g1',
    fileUri: 'file:///cache/library-temp/g1.bin',
    headers: {
      authorization: 'AWS4-HMAC-SHA256 x',
      'x-amz-content-sha256': 'abc123',
      'x-amz-date': '20150830T123600Z',
    },
  });

  const [call] = recordedUploads();
  expect(call!.fileUri).toBe('file:///cache/library-temp/g1.bin');
  expect(call!.url).toBe('https://s3.example.com/b/blobs/g1');
  expect(call!.options!.httpMethod).toBe('PUT');
  // BINARY_CONTENT (0), never MULTIPART: an S3 PUT body is the bytes
  // themselves, and the SigV4 payload hash covers exactly those bytes.
  expect(call!.options!.uploadType).toBe(0);
  expect(call!.options!.headers).toEqual({
    authorization: 'AWS4-HMAC-SHA256 x',
    'x-amz-content-sha256': 'abc123',
    'x-amz-date': '20150830T123600Z',
  });
  expect(response).toEqual({ status: 200, headers: { etag: '"abc"' } });
});

test('forwards every native progress report to the caller', async () => {
  const seen: { bytesSent: number; totalBytes: number }[] = [];
  setUploadPlan({
    progress: [
      { bytesSent: 0, totalBytes: 900 },
      { bytesSent: 450, totalBytes: 900 },
      { bytesSent: 900, totalBytes: 900 },
    ],
    result: { status: 200, headers: {}, body: '' },
  });
  await expoUploadFile({
    url: 'https://s3.example.com/b/blobs/g1',
    fileUri: 'file:///cache/g1.bin',
    headers: {},
    onProgress: (progress) => seen.push(progress),
  });
  expect(seen).toEqual([
    { bytesSent: 0, totalBytes: 900 },
    { bytesSent: 450, totalBytes: 900 },
    { bytesSent: 900, totalBytes: 900 },
  ]);
});

test('a non-2xx answer is returned, not thrown — the transport maps the status', async () => {
  setUploadPlan({ result: { status: 403, headers: {}, body: '<Error/>' } });
  await expect(
    expoUploadFile({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: {},
    }),
  ).resolves.toEqual({ status: 403, headers: {} });
});

test('a task failure propagates so the transport can call it a network error', async () => {
  setUploadPlan({ failWith: new Error('stream closed') });
  await expect(
    expoUploadFile({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: {},
    }),
  ).rejects.toThrow('stream closed');
});

test('an abort signal is handed to the native task, not dropped', async () => {
  const controller = new AbortController();
  setUploadPlan({ result: { status: 200, headers: {}, body: '' } });
  await expoUploadFile({
    url: 'https://s3.example.com/b/blobs/g1',
    fileUri: 'file:///cache/g1.bin',
    headers: {},
    signal: controller.signal,
  });
  expect(recordedUploads()[0]!.options!.signal).toBe(controller.signal);
});

test('omitted callbacks are omitted, never passed as undefined', async () => {
  setUploadPlan({ result: { status: 200, headers: {}, body: '' } });
  await expoUploadFile({
    url: 'https://s3.example.com/b/blobs/g1',
    fileUri: 'file:///cache/g1.bin',
    headers: {},
  });
  const options = recordedUploads()[0]!.options!;
  expect('onProgress' in options).toBe(false);
  expect('signal' in options).toBe(false);
});

/**
 * K6-1g (K7 finding #36, controller-verified): `expo-file-system`'s upload task
 * builds its own OkHttp client with `createClientBuilder()` and hardcoded 60 s
 * timeouts, so it bypasses the K6-1d IPv4-first pooled factory and cuts off a
 * slow-but-live upload. The native port in `modules/waifu-sync-service` exists
 * to avoid that; these tests pin what the adapter around it must preserve.
 */
describe('createNativeUploadFile', () => {
  function nativeDouble(overrides: Partial<NativeUploader> = {}): NativeUploader & {
    emit: (event: { taskId: string; bytesSent: number; totalBytes: number }) => void;
  } {
    const listeners: ((event: {
      taskId: string; bytesSent: number; totalBytes: number;
    }) => void)[] = [];
    return {
      uploadFile: jest.fn(async () => ({ status: 200, headers: {}, body: '' })),
      cancelUpload: jest.fn(async () => undefined),
      addListener: jest.fn((_name: string, listener: (event: {
        taskId: string; bytesSent: number; totalBytes: number;
      }) => void) => {
        listeners.push(listener);
        return { remove: jest.fn() };
      }),
      emit: (event) => {
        for (const listener of listeners) listener(event);
      },
      ...overrides,
    } as NativeUploader & { emit: (event: {
      taskId: string; bytesSent: number; totalBytes: number;
    }) => void };
  }

  test('PUTs the file with the signed headers and returns the status', async () => {
    const native = nativeDouble();
    const response = await createNativeUploadFile(native)({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: { authorization: 'AWS4-HMAC-SHA256 x' },
    });
    expect(native.uploadFile).toHaveBeenCalledWith(
      expect.any(String),
      'https://s3.example.com/b/blobs/g1',
      'file:///cache/g1.bin',
      { authorization: 'AWS4-HMAC-SHA256 x' },
    );
    expect(response).toEqual({ status: 200, headers: {} });
  });

  test('a non-2xx answer is returned, not thrown — same rule as the expo port', async () => {
    const native = nativeDouble({
      uploadFile: jest.fn(async () => ({ status: 403, headers: {}, body: '<Error/>' })),
    });
    await expect(createNativeUploadFile(native)({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: {},
    })).resolves.toEqual({ status: 403, headers: {} });
  });

  test('forwards only this upload\'s progress events', async () => {
    const seen: { bytesSent: number; totalBytes: number }[] = [];
    const native = nativeDouble();
    let taskId = '';
    (native.uploadFile as jest.Mock).mockImplementation(async (id: string) => {
      taskId = id;
      native.emit({ taskId: 'some-other-upload', bytesSent: 10, totalBytes: 20 });
      native.emit({ taskId: id, bytesSent: 450, totalBytes: 900 });
      return { status: 200, headers: {}, body: '' };
    });
    await createNativeUploadFile(native)({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: {},
      onProgress: (progress) => seen.push(progress),
    });
    expect(taskId).not.toBe('');
    expect(seen).toEqual([{ bytesSent: 450, totalBytes: 900 }]);
  });

  test('removes its progress listener even when the upload throws', async () => {
    const remove = jest.fn();
    const native = nativeDouble({
      uploadFile: jest.fn(async () => {
        throw new Error('socket died');
      }),
      addListener: jest.fn(() => ({ remove })),
    });
    await expect(createNativeUploadFile(native)({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: {},
    })).rejects.toThrow('socket died');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('an aborted signal cancels the native call', async () => {
    const controller = new AbortController();
    const native = nativeDouble();
    (native.uploadFile as jest.Mock).mockImplementation(async () => {
      controller.abort();
      return { status: 200, headers: {}, body: '' };
    });
    await createNativeUploadFile(native)({
      url: 'https://s3.example.com/b/blobs/g1',
      fileUri: 'file:///cache/g1.bin',
      headers: {},
      signal: controller.signal,
    });
    expect(native.cancelUpload).toHaveBeenCalledTimes(1);
  });
});

describe('selectUploadFilePort', () => {
  test('prefers the native port when the module is linked in', async () => {
    const uploadFile = jest.fn(async () => ({ status: 200, headers: {}, body: '' }));
    const port = selectUploadFilePort({
      uploadFile,
      cancelUpload: jest.fn(async () => undefined),
      addListener: jest.fn(() => ({ remove: jest.fn() })),
    } as unknown as NativeUploader);
    await port({ url: 'https://s3.example.com/b/k', fileUri: 'file:///c/g1.bin', headers: {} });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(recordedUploads()).toHaveLength(0);
  });

  test('falls back to expo-file-system when the module is absent (jest, web)', async () => {
    setUploadPlan({ result: { status: 200, headers: {}, body: '' } });
    const port = selectUploadFilePort(null);
    await port({ url: 'https://s3.example.com/b/k', fileUri: 'file:///c/g1.bin', headers: {} });
    expect(recordedUploads()).toHaveLength(1);
  });
});
