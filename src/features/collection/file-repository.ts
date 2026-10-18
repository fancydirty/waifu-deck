import type { DownloadErrorKind, StoredImage } from '@/features/images/image-repository';
import { providerImageHeaders } from '@/features/providers/provider-image-source';
import type { WaifuImage } from '@/features/waifu/types';

export type CollectionServiceErrorCode =
  | 'not_saved'
  | 'not_ready'
  | 'file_missing'
  | 'download_failed'
  | 'delete_failed'
  | 'share_unavailable'
  | 'share_failed'
  | 'permission_denied'
  | 'export_unavailable'
  | 'database_failed'
  | 'settings_failed'
  | 'operation_blocked'
  | 'platform_unavailable'
  | 'cloud_only_offline'
  | 'cloud_only_disconnected';

export class CollectionServiceError extends Error {
  readonly code: CollectionServiceErrorCode;

  /**
   * Board #5. The HTTP status the failing path actually observed, or `null`
   * when the failure carried none (a socket error, a stall, a cancellation).
   * It exists so a 404/410 survives the trip from the transport to
   * {@link classifyDownloadFailure} instead of being flattened into one
   * generic `download_failed`.
   */
  readonly httpStatus: number | null;

  constructor(
    code: CollectionServiceErrorCode,
    message: string,
    options: { cause?: unknown; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = 'CollectionServiceError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, CollectionServiceError.prototype);
  }
}

export type CollectionServiceIssue = {
  code: CollectionServiceErrorCode;
  message: string;
  /**
   * Board #5. Whether retrying this failure could ever work. Only carried on a
   * `download_failed` issue — nothing else asks the question, and filling it
   * elsewhere would put a meaningless value on issues that never reach the
   * retry classifier.
   */
  kind?: DownloadErrorKind;
};

export type CollectionDownloadOptions = {
  signal?: AbortSignal;
  /** Called when a range or single-stream transfer starts. */
  onTransferStart?: () => void;
  /** Pauses the stall clock while the range-window budget is queued. */
  onLeaseWait?: () => void;
  /** Resumes the stall clock after the range-window budget is acquired. */
  onLeaseAcquired?: () => void;
  /**
   * R8.28 — HTTP headers the source requires to serve its image bytes (only
   * Gelbooru declares any today). Absent for every other source, so their
   * download options object is unchanged.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * K6-4c — the size the booru's listing claimed, when it claimed one. Only
   * ever used to skip work: a file the source already calls small cannot be
   * worth a parallel-download probe, so that round trip is not spent. The
   * authoritative size still comes from the probe, so a wrong or missing claim
   * costs speed on one save rather than correctness.
   */
  declaredBytes?: number;
  /**
   * K6-4d — invoked with the cumulative bytes written so far, as often as the
   * transport reports progress. Lets the caller's stall detector re-arm on real
   * movement instead of a fixed wall clock. Absent for callers that do not
   * track progress; a transport that cannot report it simply never calls it.
   */
  onProgress?: (receivedBytes: number) => void;
};

export type CollectionFilePort = {
  readonly rootUri: string;
  resolve(name: string): string;
  ensureDirectory(): Promise<void>;
  exists(uri: string): Promise<boolean>;
  download(
    remoteUrl: string,
    destinationUri: string,
    options?: CollectionDownloadOptions,
  ): Promise<void>;
  move(sourceUri: string, destinationUri: string): Promise<void>;
  delete(uri: string): Promise<void>;
  size(uri: string): Promise<number>;
  list(): Promise<string[]>;
  /** K7 ㉖. One native recursive byte count for the whole collection directory. */
  directorySize(): Promise<number>;
  isSharingAvailable(): Promise<boolean>;
  share(uri: string): Promise<void>;
  requestPhotoPermission(): Promise<boolean>;
  exportToPhotos(uri: string): Promise<void>;
};

export type DownloadedCollectionFile = {
  uri: string;
  reused: boolean;
};

export type FileDeleteFailure = {
  uri: string;
  error: CollectionServiceIssue;
};

export type FileDeleteAllResult = {
  deleted: string[];
  failed: FileDeleteFailure[];
};

/**
 * K7 ㉓. What the startup/refresh sweep needs from one directory listing:
 * the deletions it made and which referenced finals were not on disk — so the
 * caller never stats a file the listing already visited.
 */
export type CollectionSweepResult = FileDeleteAllResult & {
  missing: string[];
};

export interface CollectionFileRepository {
  pathFor(image: Pick<WaifuImage, 'id' | 'extension'>): string;
  partialPathFor(image: Pick<WaifuImage, 'id' | 'extension'>): string;
  cleanupUrisFor(
    image: Pick<StoredImage, 'id' | 'extension' | 'localUri'>,
  ): string[];
  exists(uri: string): Promise<boolean>;
  download(
    image: WaifuImage,
    options?: CollectionDownloadOptions,
  ): Promise<DownloadedCollectionFile>;
  deleteUri(uri: string): Promise<void>;
  deleteImage(image: Pick<StoredImage, 'id' | 'extension' | 'localUri'>): Promise<void>;
  fileSize(uri: string): Promise<number>;
  getCollectionBytes(): Promise<number>;
  reconcile(referencedFinalUris: Iterable<string>): Promise<FileDeleteAllResult>;
  /**
   * K7 ㉓. One listing; deletes every file that is neither a referenced final
   * nor owned by a protected image id (`<id>.<ext>` and `<id>.<ext>.partial`
   * alike); reports which referenced finals were absent. `protectedImageIds`
   * is read AFTER the listing resolves, so a caller may pass a live set that
   * keeps growing while the listing runs.
   */
  sweep(
    referencedFinalUris: Iterable<string>,
    protectedImageIds: Iterable<number>,
  ): Promise<CollectionSweepResult>;
  deleteAll(): Promise<FileDeleteAllResult>;
  share(uri: string): Promise<void>;
  exportToPhotos(uri: string): Promise<void>;
}

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

function safeExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase().replace(/^\.+/, '');
  return ALLOWED_EXTENSIONS.has(normalized) ? normalized : 'jpg';
}

/**
 * Board #5. Every message the error itself carries: its own, plus the one on
 * the cause it wraps. expo-file-system's native task rejects with
 * `Unable to download a file: HTTP <code>`, and by the time the repository is
 * done that message is usually a cause rather than the outer error.
 *
 * One level of cause is all this needs to walk. It is the only depth the
 * repository ever builds — a port error is wrapped exactly once on its way out
 * — and every wrap that actually observed a status also records it in
 * `httpStatus`, so the message is a fallback for errors that carried no status
 * field, not the primary channel a deeper chain would have to be mined for.
 */
function messagesOf(error: unknown): string[] {
  const messages: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') messages.push(value);
    else if (value instanceof Error) messages.push(value.message);
  };
  push(error);
  if (typeof error === 'object' && error !== null && 'cause' in error) push(error.cause);
  return messages;
}

/**
 * Board #5. The HTTP status an error's message reports, if any. `\b` after the
 * three digits keeps `HTTP 4040` from reading as a 404.
 */
export function parseHttpStatus(error: unknown): number | undefined {
  for (const message of messagesOf(error)) {
    const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
    if (status !== undefined) return Number(status);
  }
  return undefined;
}

/**
 * Board #5. Whether retrying this download could ever work.
 *
 * Only a 404 or a 410 proves it cannot: the source deleted the image, so every
 * later attempt buys the same answer. Everything else — a socket error, a
 * timeout, a stall, a lifecycle abort, a 5xx, a 429, a 403, an unknown error
 * shape — is `transient`, because guessing "gone" on a failure that is merely
 * temporary would strand an image the user could otherwise still get.
 *
 * A status the failing path recorded on the error decides outright. Reading the
 * message is the fallback for a failure that carried no status field at all, so
 * it must never overturn one that did — a 503 with some older 404 still in its
 * cause chain is a 503.
 */
export function classifyDownloadFailure(error: unknown): DownloadErrorKind {
  const status = error instanceof CollectionServiceError && error.httpStatus !== null
    ? error.httpStatus
    : parseHttpStatus(error);
  return status === 404 || status === 410 ? 'source_gone' : 'transient';
}

export function issueFromError(
  error: unknown,
  fallbackCode: CollectionServiceErrorCode,
  fallbackMessage: string,
): CollectionServiceIssue {
  const isService = error instanceof CollectionServiceError;
  const code = isService ? error.code : fallbackCode;
  const message = isService ? error.message : fallbackMessage;
  return {
    code,
    message,
    ...(code === 'download_failed' ? { kind: classifyDownloadFailure(error) } : {}),
  };
}

function serviceError(
  error: unknown,
  fallbackCode: CollectionServiceErrorCode,
  fallbackMessage: string,
): CollectionServiceError {
  // An inner CollectionServiceError already carries whatever status the failing
  // path observed, so returning it unchanged is what propagates `httpStatus`.
  if (error instanceof CollectionServiceError) return error;
  // Board #5. Defence in depth for a port that rejects with a raw HTTP error:
  // no port does today (the Expo one already wraps its own statuses), so this
  // only keeps a future or third-party port from silently losing a 404.
  const httpStatus = parseHttpStatus(error);
  return new CollectionServiceError(fallbackCode, fallbackMessage, {
    cause: error,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The caller has already started `promise`; unobserved, its rejection would go unhandled.
    void promise.catch(() => undefined);
    return Promise.reject(new CollectionServiceError(
      'download_failed',
      'This image download was cancelled.',
    ));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new CollectionServiceError(
        'download_failed',
        'This image download was cancelled.',
      ));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function createCollectionFileRepository(
  port: CollectionFilePort,
): CollectionFileRepository {
  const pathFor = (image: Pick<WaifuImage, 'id' | 'extension'>) =>
    port.resolve(`${image.id}.${safeExtension(image.extension)}`);
  const partialPathFor = (image: Pick<WaifuImage, 'id' | 'extension'>) =>
    `${pathFor(image)}.partial`;
  const cleanupUrisFor = (
    image: Pick<StoredImage, 'id' | 'extension' | 'localUri'>,
  ): string[] => {
    const uris = new Set([pathFor(image), partialPathFor(image)]);
    if (image.localUri) uris.add(image.localUri);
    return [...uris];
  };

  const deleteUri = async (uri: string): Promise<void> => {
    try {
      await port.delete(uri);
    } catch (error) {
      throw serviceError(error, 'delete_failed', 'The saved file could not be deleted.');
    }
  };

  const deleteImage = async (
    image: Pick<StoredImage, 'id' | 'extension' | 'localUri'>,
  ): Promise<void> => {
    for (const uri of cleanupUrisFor(image)) await deleteUri(uri);
  };

  const sweep = async (
    referencedFinalUris: Iterable<string>,
    protectedImageIds: Iterable<number>,
  ): Promise<CollectionSweepResult> => {
    let uris: string[];
    try {
      uris = await port.list();
    } catch (error) {
      return {
        deleted: [],
        failed: [{
          uri: port.rootUri,
          error: issueFromError(
            error,
            'delete_failed',
            'The private collection could not be inspected.',
          ),
        }],
        missing: [],
      };
    }

    // Both sets are built only now, after the listing: a download registered
    // while `port.list()` was running is in `protectedImageIds` by the time it
    // is read (collection-service adds to the live set at registration).
    const referenced = new Set(referencedFinalUris);
    const protectedPrefixes = [...protectedImageIds].map((id) => port.resolve(`${id}.`));
    const listed = new Set(uris);
    const result: CollectionSweepResult = { deleted: [], failed: [], missing: [] };
    for (const uri of uris) {
      if (protectedPrefixes.some((prefix) => uri.startsWith(prefix))) continue;
      if (!uri.endsWith('.partial') && referenced.has(uri)) continue;
      try {
        await port.delete(uri);
        result.deleted.push(uri);
      } catch (error) {
        result.failed.push({
          uri,
          error: issueFromError(
            error,
            'delete_failed',
            'A private collection file could not be deleted.',
          ),
        });
      }
    }
    for (const uri of referenced) {
      if (!listed.has(uri)) result.missing.push(uri);
    }
    return result;
  };

  const reconcile = async (
    referencedFinalUris: Iterable<string>,
  ): Promise<FileDeleteAllResult> => {
    const { deleted, failed } = await sweep(referencedFinalUris, []);
    return { deleted, failed };
  };

  return {
    pathFor,
    partialPathFor,
    cleanupUrisFor,
    async exists(uri) {
      try {
        return await port.exists(uri);
      } catch (error) {
        throw serviceError(error, 'platform_unavailable', 'File storage is unavailable.');
      }
    },
    async download(image, options = {}) {
      const finalUri = pathFor(image);
      const partialUri = partialPathFor(image);
      try {
        if (options.signal?.aborted) {
          throw new CollectionServiceError(
            'download_failed',
            'This image download was cancelled.',
          );
        }
        await port.ensureDirectory();
        await port.delete(partialUri);
        if (await port.exists(finalUri)) return { uri: finalUri, reused: true };

        // R8.28: the durable save fetches remoteUrl itself, outside expo-image,
        // so it needs the same headers the render uses — otherwise Gelbooru
        // hands back hotlink.php HTML and we durably store that. A source with
        // no declared headers keeps the caller's options object as-is.
        const headers = providerImageHeaders(image.providerKey);
        await waitForAbort(
          port.download(
            image.remoteUrl,
            partialUri,
            {
              ...options,
              ...(headers ? { headers } : {}),
              // K6-4c: lets the port skip the range probe for an image the
              // source already sized below the split threshold.
              ...(image.byteSize > 0 ? { declaredBytes: image.byteSize } : {}),
            },
          ),
          options.signal,
        );
        await port.move(partialUri, finalUri);
        return { uri: finalUri, reused: false };
      } catch (error) {
        try {
          await port.delete(partialUri);
        } catch {
          // The primary download error remains the actionable result.
        }
        throw serviceError(error, 'download_failed', 'This image could not be saved offline.');
      }
    },
    deleteUri,
    deleteImage,
    async fileSize(uri) {
      try {
        const size = await port.size(uri);
        return Number.isFinite(size) && size > 0 ? size : 0;
      } catch (error) {
        throw serviceError(error, 'platform_unavailable', 'File storage is unavailable.');
      }
    },
    async getCollectionBytes() {
      try {
        return await port.directorySize();
      } catch (error) {
        throw serviceError(error, 'platform_unavailable', 'File storage is unavailable.');
      }
    },
    reconcile,
    sweep,
    deleteAll() {
      return reconcile([]);
    },
    async share(uri) {
      try {
        if (!(await port.exists(uri))) {
          throw new CollectionServiceError('file_missing', 'The saved file is missing.');
        }
        if (!(await port.isSharingAvailable())) {
          throw new CollectionServiceError(
            'share_unavailable',
            'Sharing is unavailable on this device.',
          );
        }
        await port.share(uri);
      } catch (error) {
        throw serviceError(error, 'share_failed', 'This image could not be shared.');
      }
    },
    async exportToPhotos(uri) {
      try {
        if (!(await port.exists(uri))) {
          throw new CollectionServiceError('file_missing', 'The saved file is missing.');
        }
        if (!(await port.requestPhotoPermission())) {
          throw new CollectionServiceError(
            'permission_denied',
            'Photo access is required to export this image.',
          );
        }
        await port.exportToPhotos(uri);
      } catch (error) {
        throw serviceError(
          error,
          'export_unavailable',
          'Export to the photo library is unavailable.',
        );
      }
    },
  };
}
