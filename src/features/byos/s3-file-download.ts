import { randomUUID } from 'expo-crypto';

import type {
  NativeDownloadResponse,
} from '../../../modules/waifu-sync-service';

export type S3DownloadProgress = Readonly<{
  bytesReceived: number;
  total: number | null;
}>;

export type S3DownloadFileRequest = Readonly<{
  url: string;
  fileUri: string;
  headers: Record<string, string>;
  maxBytes: number;
  onProgress?: (progress: S3DownloadProgress) => void;
  signal?: AbortSignal;
}>;

export type S3DownloadFilePort = (
  request: S3DownloadFileRequest,
) => Promise<NativeDownloadResponse>;

export type S3DownloadErrorKind =
  | 'network'
  | 'cancelled'
  | 'local_io'
  | 'too_large'
  | 'duplicate';

export class S3DownloadError extends Error {
  constructor(
    readonly kind: S3DownloadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'S3DownloadError';
    Object.setPrototypeOf(this, S3DownloadError.prototype);
  }
}

export type NativeDownloader = Readonly<{
  downloadToFile(
    taskId: string,
    url: string,
    destPath: string,
    headers: Record<string, string>,
    maxBytes: number,
  ): Promise<NativeDownloadResponse>;
  cancelDownload(taskId: string): Promise<void>;
  addListener(
    name: 'onDownloadProgress',
    listener: (event: {
      taskId: string;
      bytesReceived: number;
      totalBytes: number;
    }) => void,
  ): { remove(): void };
}>;

type NativeError = Error & { code?: string };

function mapNativeError(error: unknown): S3DownloadError {
  const native = error as NativeError;
  switch (native.code) {
    case 'ERR_DOWNLOAD_CANCELLED':
    case 'ERR_LIBRARY_CANCELLED':
      return new S3DownloadError('cancelled', native.message);
    case 'ERR_LIBRARY_IO':
      return new S3DownloadError('local_io', native.message);
    case 'ERR_LIBRARY_FORMAT':
      return new S3DownloadError('too_large', native.message);
    case 'ERR_TASK_DUPLICATE':
      return new S3DownloadError('duplicate', native.message);
    case 'ERR_DOWNLOAD_NETWORK':
    default:
      return new S3DownloadError('network', native.message ?? String(error));
  }
}

export function createNativeDownloadFile(native: NativeDownloader): S3DownloadFilePort {
  return async (request) => {
    const taskId = `stream-${randomUUID()}`;
    const subscription = native.addListener('onDownloadProgress', (event) => {
      if (event.taskId !== taskId) return;
      request.onProgress?.({
        bytesReceived: event.bytesReceived,
        total: event.totalBytes === -1 ? null : event.totalBytes,
      });
    });
    const onAbort = (): void => {
      void native.cancelDownload(taskId).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', onAbort);
    try {
      return await native.downloadToFile(
        taskId,
        request.url,
        request.fileUri,
        request.headers,
        request.maxBytes,
      );
    } catch (error) {
      if (error instanceof S3DownloadError) throw error;
      throw mapNativeError(error);
    } finally {
      subscription.remove();
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

export function selectDownloadFilePort(native: NativeDownloader | null): S3DownloadFilePort | null {
  return native === null ? null : createNativeDownloadFile(native);
}
