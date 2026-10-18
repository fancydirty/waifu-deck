import type { S3UploadFilePort } from './s3-transport';

/**
 * The production `S3UploadFilePort`: `expo-file-system`'s native upload task.
 *
 * K6-2 (spec §2 G3). SDK 56's `expo/fetch` — the client every other S3 request
 * in this app uses — exposes no upload-progress event, so the owner's
 * percentage ring has no honest byte source on that channel. `File`'s
 * `createUploadTask` is the supported SDK 56 API that does: it streams the file
 * from disk and calls `onProgress` with `{ bytesSent, totalBytes }` reported by
 * the platform's own HTTP stack.
 *
 * `uploadType` is `BINARY_CONTENT` (the default, spelled out here because it is
 * load-bearing): the file's bytes are the raw request body, with no multipart
 * framing, which is the only shape an S3 PUT — and the SigV4 signature over the
 * payload hash — can accept.
 *
 * `uploadAsync()` resolves for non-2xx responses too, so the HTTP status is
 * returned to the transport rather than thrown here; only a transport-level
 * failure (unreadable file, dead socket, abort) rejects. That keeps the status
 * -> `S3FailureCategory` mapping in exactly one place.
 *
 * The module is required lazily, inside the call, for the same reason
 * `library-expo-file-store.ts` does it: web and the Node integration gate must
 * be able to import this file without pulling in a native module they do not
 * have. Neither ever calls this function — both inject their own port.
 */
export const expoUploadFile: S3UploadFilePort = async (request) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File, UploadType } = require('expo-file-system') as typeof import('expo-file-system');
  const task = new File(request.fileUri).createUploadTask(request.url, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: request.headers,
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const result = await task.uploadAsync();
  return { status: result.status, headers: result.headers };
};

/**
 * The slice of `modules/waifu-sync-service` this file needs. Structural rather
 * than an import of the module's own type so the fallback path — and every test
 * — can stand one up without the native module existing.
 */
export type NativeUploader = Readonly<{
  uploadFile(
    taskId: string,
    url: string,
    filePath: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  cancelUpload(taskId: string): Promise<void>;
  addListener(
    name: 'onUploadProgress',
    listener: (event: { taskId: string; bytesSent: number; totalBytes: number }) => void,
  ): { remove(): void };
}>;

let nextTaskId = 0;

/**
 * K6-1g. The same port, on the app's own OkHttp client instead of the one
 * `expo-file-system` builds for itself.
 *
 * K7 finding #36, verified by the controller: `expo-file-system`'s upload task
 * calls `OkHttpClientProvider.createClientBuilder()` and then sets 60 s connect,
 * read and write timeouts. That does two things this app cannot afford — it
 * throws away the K6-1d client factory (IPv4-first DNS on a network whose IPv6
 * path stalls, and a 10-connection/10-minute pool that keeps a save off the
 * cold-handshake path), and it kills an upload that is transferring perfectly
 * well but takes longer than a minute. The native module's `uploadFile` uses
 * `createClient()` — the factory-built client — and sets no timeout at all,
 * because the transport's own stall detector (K5) is the only thing that knows
 * whether "slow" means "dead".
 *
 * Everything else is deliberately identical to {@link expoUploadFile}: a non-2xx
 * status is returned rather than thrown, so the status → `S3FailureCategory`
 * mapping stays in exactly one place in the transport.
 */
export function createNativeUploadFile(native: NativeUploader): S3UploadFilePort {
  return async (request) => {
    nextTaskId += 1;
    const taskId = `upload-${nextTaskId}`;
    // Subscribed before the call starts: the first bytes can be written before
    // `uploadFile` has even returned its promise to us.
    const subscription = native.addListener('onUploadProgress', (event) => {
      if (event.taskId !== taskId) return;
      request.onProgress?.({ bytesSent: event.bytesSent, totalBytes: event.totalBytes });
    });
    const onAbort = (): void => {
      void native.cancelUpload(taskId).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', onAbort);
    try {
      const result = await native.uploadFile(
        taskId, request.url, request.fileUri, request.headers,
      );
      return { status: result.status, headers: result.headers };
    } finally {
      subscription.remove();
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/**
 * The native port where it exists, `expo-file-system` where it does not.
 *
 * The fallback is not a nicety: Jest, web and the Node integration gate have no
 * linked Android module, and the expo path is a working (if 60 s-capped)
 * upload, so a missing module degrades rather than breaks.
 */
export function selectUploadFilePort(native: NativeUploader | null): S3UploadFilePort {
  return native === null ? expoUploadFile : createNativeUploadFile(native);
}
