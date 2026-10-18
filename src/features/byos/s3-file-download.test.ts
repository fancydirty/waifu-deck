import {
  createNativeDownloadFile,
  selectDownloadFilePort,
  type NativeDownloader,
} from './s3-file-download';

type DownloadFn = NativeDownloader['downloadToFile'];
type NativeDouble = NativeDownloader & {
  downloadToFile: jest.MockedFunction<DownloadFn>;
  cancelDownload: jest.MockedFunction<NativeDownloader['cancelDownload']>;
  addListener: jest.MockedFunction<NativeDownloader['addListener']>;
  emit: (event: { taskId: string; bytesReceived: number; totalBytes: number }) => void;
};

function nativeDouble(downloadImpl?: DownloadFn): NativeDouble {
  const listeners: ((event: {
    taskId: string;
    bytesReceived: number;
    totalBytes: number;
  }) => void)[] = [];
  const downloadToFile = jest.fn<
    ReturnType<NativeDownloader['downloadToFile']>,
    Parameters<NativeDownloader['downloadToFile']>
  >(downloadImpl ?? (async () => ({
      status: 200,
      headers: { etag: '"e1"' },
      redirected: false,
      errorBody: '',
      bytesWritten: 3,
    })));
  const cancelDownload = jest.fn<
    ReturnType<NativeDownloader['cancelDownload']>,
    Parameters<NativeDownloader['cancelDownload']>
  >(async () => undefined);
  const addListener = jest.fn((_name: 'onDownloadProgress', listener: (event: {
      taskId: string;
      bytesReceived: number;
      totalBytes: number;
    }) => void) => {
      listeners.push(listener);
      return { remove: jest.fn(() => undefined) };
    });
  const native = {
    downloadToFile,
    cancelDownload,
    addListener,
    emit(event: { taskId: string; bytesReceived: number; totalBytes: number }) {
      for (const listener of listeners) listener(event);
    },
  } as NativeDouble;
  return native;
}

test('selectDownloadFilePort returns null without a native module', () => {
  expect(selectDownloadFilePort(null)).toBeNull();
});

test('attaches before the call, filters progress, maps unknown totals, and removes on success', async () => {
  const native = nativeDouble();
  const seen: { bytesReceived: number; total: number | null }[] = [];
  native.downloadToFile.mockImplementation(async (taskId) => {
    native.emit({ taskId: 'other', bytesReceived: 99, totalBytes: 100 });
    native.emit({ taskId, bytesReceived: 3, totalBytes: -1 });
    return {
      status: 200, headers: {}, redirected: false, errorBody: '', bytesWritten: 3,
    };
  });

  const port = createNativeDownloadFile(native);
  const response = await port({
    url: 'https://s3.example/object',
    fileUri: 'file:///tmp/object',
    headers: { authorization: 'signed' },
    maxBytes: 100,
    onProgress: (progress) => seen.push(progress),
  });

  expect(native.addListener.mock.invocationCallOrder[0]).toBeLessThan(
    native.downloadToFile.mock.invocationCallOrder[0]!,
  );
  expect(native.downloadToFile).toHaveBeenCalledWith(
    expect.stringMatching(/^stream-/),
    'https://s3.example/object',
    'file:///tmp/object',
    { authorization: 'signed' },
    100,
  );
  expect(seen).toEqual([{ bytesReceived: 3, total: null }]);
  expect(response.bytesWritten).toBe(3);
  expect(native.addListener.mock.results[0]!.value.remove).toHaveBeenCalledTimes(1);
});

test('abort cancels the native task and removes listeners after failure', async () => {
  const native = nativeDouble(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const error = new Error('cancelled') as Error & { code: string };
      error.code = 'ERR_DOWNLOAD_CANCELLED';
      throw error;
  });
  const controller = new AbortController();
  const port = createNativeDownloadFile(native);
  const pending = port({
    url: 'https://s3.example/object', fileUri: 'file:///tmp/object', headers: {},
    maxBytes: 100, signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'S3DownloadError', kind: 'cancelled' });
  expect(native.cancelDownload).toHaveBeenCalledWith(expect.stringMatching(/^stream-/));
  expect(native.addListener.mock.results[0]!.value.remove).toHaveBeenCalledTimes(1);
});

test.each([
  ['ERR_DOWNLOAD_NETWORK', 'network'],
  ['ERR_DOWNLOAD_CANCELLED', 'cancelled'],
  ['ERR_LIBRARY_CANCELLED', 'cancelled'],
  ['ERR_LIBRARY_IO', 'local_io'],
  ['ERR_LIBRARY_FORMAT', 'too_large'],
  ['ERR_TASK_DUPLICATE', 'duplicate'],
] as const)('maps native %s to %s', async (code, kind) => {
  const native = nativeDouble(async () => {
      const error = new Error(code) as Error & { code: string };
      error.code = code;
      throw error;
  });
  await expect(createNativeDownloadFile(native)({
    url: 'https://s3.example/object', fileUri: 'file:///tmp/object', headers: {}, maxBytes: 100,
  })).rejects.toMatchObject({ name: 'S3DownloadError', kind });
});
