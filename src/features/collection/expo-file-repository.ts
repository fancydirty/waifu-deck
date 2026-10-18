import { Platform } from 'react-native';

import {
  CollectionServiceError,
  createCollectionFileRepository,
  parseHttpStatus,
  type CollectionFilePort,
  type CollectionFileRepository,
} from '@/features/collection/file-repository';
import {
  LIBRARY_RANGE_SEGMENT_CONCURRENCY,
  parseRangeProbe,
  planRanges,
  shouldUseRanges,
  type RangeProbeResult,
} from '@/features/collection/range-download';

import { WaifuSyncService } from '../../../modules/waifu-sync-service';

export type ExpoFileHandle = {
  readonly uri: string;
  readonly exists: boolean;
  readonly size: number;
  copy(destination: ExpoFileHandle): void | Promise<void>;
  delete(): void;
  move(destination: ExpoFileHandle): void | Promise<void>;
};

export type ExpoDirectoryHandle = {
  readonly uri: string;
  readonly exists: boolean;
  /** expo-file-system 56 `Directory.size`: a native recursive byte count. */
  readonly size: number | null;
  create(options: { idempotent: boolean; intermediates: boolean }): void;
  list(): unknown[];
};

export type RangeDownloadRequest = {
  url: string;
  destinationUri: string;
  headers?: Readonly<Record<string, string>>;
  totalBytes: number;
  parts: number;
  signal?: AbortSignal;
  /** K6-4d: cumulative bytes landed across every window, for the stall guard. */
  onProgress?: (receivedBytes: number) => void;
};

/**
 * K6-4c. The two native calls the parallel path needs, behind a port so the
 * thresholds and the fallback can be tested without a linked module.
 * `null` wherever `modules/waifu-sync-service` is not linked — Jest, web, Expo
 * Go — which is what keeps `createDownloadTask` the working default.
 */
export type ExpoRangeDownloader = {
  /**
   * A one-byte `Range` GET that reports the file's size and whether the host
   * will serve windows at all. `null` when the answer is unusable; board #5's
   * `{ kind: 'gone' }` when the source says the file no longer exists.
   */
  probe(
    url: string,
    headers?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<RangeProbeResult>;
  /** Resolves only when every window has landed in the destination file. */
  downloadRanges(request: RangeDownloadRequest): Promise<void>;
};

export type ExpoFileAdapter = {
  createCollectionDirectory(): ExpoDirectoryHandle;
  createFile(location: ExpoDirectoryHandle | string, name?: string): ExpoFileHandle;
  isFile(value: unknown): value is ExpoFileHandle;
  getCachedImagePath(cacheKey: string): Promise<string | null>;
  rangeDownloader: ExpoRangeDownloader | null;
  createDownloadTask(
    remoteUrl: string,
    destination: ExpoFileHandle,
    // R8.28: `headers` reaches expo-file-system's DownloadTaskOptions so a
    // hotlink-protected CDN serves bytes instead of its interstitial HTML.
    // K6-4d: `onProgress` reports cumulative bytes written for the stall guard.
    options?: {
      signal?: AbortSignal;
      headers?: Readonly<Record<string, string>>;
      onProgress?: (receivedBytes: number) => void;
    },
  ): {
    cancel(): void;
    downloadAsync(): Promise<ExpoFileHandle | null>;
  };
  isSharingAvailable(): Promise<boolean>;
  share(uri: string): Promise<void>;
  requestPhotoPermission(
    writeOnly: boolean,
    granularPermissions: string[],
  ): Promise<{ granted: boolean }>;
  createAsset(uri: string): Promise<unknown>;
};

type ExpoFileRepositoryOptions = {
  platform?: typeof Platform.OS;
  adapter?: ExpoFileAdapter;
  /**
   * K6-4c. Overrides the process-wide window budget with a private one of this
   * width. Mirrors `collection-service.ts`'s `downloadConcurrency`: the default
   * is the shared cap every repository in a running app draws on, and a caller
   * that needs its queueing to be independent — a test, or a second surface
   * with its own budget — states the width it wants.
   */
  segmentConcurrency?: number;
};

function asFileUri(pathOrUri: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(pathOrUri)) return pathOrUri;
  return `file://${pathOrUri.startsWith('/') ? '' : '/'}${pathOrUri}`;
}

function unavailableError(): CollectionServiceError {
  return new CollectionServiceError(
    'platform_unavailable',
    'Private file storage is unavailable on this platform.',
  );
}

function cancelledDownloadError(): CollectionServiceError {
  return new CollectionServiceError(
    'download_failed',
    'This image download was cancelled.',
  );
}

function throwIfDownloadAborted(
  signal: AbortSignal | undefined,
  destination?: ExpoFileHandle,
): void {
  if (!signal?.aborted) return;
  try {
    if (destination?.exists) destination.delete();
  } catch {
    // Cancellation is still the primary result when cleanup is best-effort.
  }
  throw cancelledDownloadError();
}

function loadLegacyMediaLibrary(): typeof import('expo-media-library/legacy') {
  // Expo Go 56 exposes this native module, unlike the new class-based API.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-media-library/legacy') as typeof import('expo-media-library/legacy');
}

type SegmentLease = { release(): void };

/**
 * K6-4c. The window budget: how many `Range` requests may be open at once,
 * counted across every image.
 *
 * It is a *second* bound, under the K6-4b task semaphore rather than instead of
 * it: that one asks "how many images may be downloading", this one asks "how
 * many sockets may be open against the source". Without it 16 concurrent tasks
 * × 8 windows would be 128 simultaneous GETs to one third-party CDN.
 *
 * An image that cannot get its full width waits rather than starting narrow: a
 * half-width download that later cannot widen would be slower than the wait,
 * and the queue drains in seconds.
 *
 * Grants are strictly in arrival order, including when the waiting image is
 * wider than the one behind it. Letting a narrower save take windows that a
 * queued wider one could not use would starve exactly the download this whole
 * path exists for — a burst of 2 MiB saves would stream past a wallpaper
 * indefinitely.
 */
function createSegmentBudget(limit: number) {
  let inUse = 0;
  const waiters: { parts: number; grant: () => void }[] = [];

  const drain = (): void => {
    while (waiters.length > 0 && inUse + waiters[0].parts <= limit) {
      const next = waiters.shift();
      if (!next) return;
      inUse += next.parts;
      next.grant();
    }
  };

  return {
    async acquire(parts: number, onWait?: () => void): Promise<SegmentLease> {
      const width = Math.max(1, Math.min(parts, limit));
      if (waiters.length === 0 && inUse + width <= limit) inUse += width;
      else {
        onWait?.();
        await new Promise<void>((resolve) => { waiters.push({ parts: width, grant: resolve }); });
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          inUse -= width;
          drain();
        },
      };
    },
  };
}

type SegmentBudget = ReturnType<typeof createSegmentBudget>;

/**
 * The process-wide budget. Module-level on purpose: `createExpoFileRepository`
 * is called more than once in a running app (app services and the library
 * integration each build one), and a per-repository budget would quietly
 * multiply the cap by the number of repositories.
 */
const sharedSegmentBudget = createSegmentBudget(LIBRARY_RANGE_SEGMENT_CONCURRENCY);


let nextRangeTaskId = 0;

/**
 * The production {@link ExpoRangeDownloader}, on `modules/waifu-sync-service`.
 *
 * `null` when the module is not linked, which is every environment that is not
 * a Direct Android build: the caller then stays on `createDownloadTask`, so a
 * missing module costs speed rather than saves.
 *
 * The probe is a `Range: bytes=0-0` GET rather than a HEAD. It costs one byte,
 * and unlike HEAD it is answered by exactly the hosts that can serve windows —
 * a 206 with `content-range` proves both the size and the capability in one
 * round trip, and a CDN that mishandles HEAD cannot mislead it.
 */
function createNativeRangeDownloader(): ExpoRangeDownloader | null {
  const native = WaifuSyncService;
  if (native === null) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fetch: expoFetch } = require('expo/fetch') as typeof import('expo/fetch');

  return {
    async probe(url, headers, signal) {
      const response = await expoFetch(url, {
        method: 'GET',
        headers: { ...(headers ?? {}), Range: 'bytes=0-0' },
        ...(signal === undefined ? {} : { signal }),
      });
      const received: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        received[name.toLowerCase()] = value;
      });
      return parseRangeProbe(response.status, received);
    },
    async downloadRanges(request) {
      nextRangeTaskId += 1;
      const taskId = `range-${nextRangeTaskId}`;
      const onAbort = (): void => {
        void native.cancelDownload(taskId).catch(() => undefined);
      };
      request.signal?.addEventListener('abort', onAbort);
      // K6-4d: forward the native per-window progress to the stall guard, so a
      // large parallel download that keeps landing bytes is never mistaken for
      // a stall.
      const progressSubscription = request.onProgress
        ? native.addListener('onDownloadProgress', (event) => {
          if (event.taskId === taskId) request.onProgress?.(event.bytesReceived);
        })
        : null;
      try {
        await native.downloadRanges(
          taskId,
          request.url,
          request.destinationUri,
          { ...(request.headers ?? {}) },
          request.totalBytes,
          request.parts,
        );
      } finally {
        progressSubscription?.remove();
        request.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}


export function createUnavailableCollectionFilePort(): CollectionFilePort {
  const rejectUnavailable = async (): Promise<never> => {
    throw unavailableError();
  };
  const rootUri = 'unavailable://collection';
  return {
    rootUri,
    resolve: (name) => `${rootUri}/${name}`,
    ensureDirectory: rejectUnavailable,
    exists: rejectUnavailable,
    download: rejectUnavailable,
    move: rejectUnavailable,
    delete: rejectUnavailable,
    size: rejectUnavailable,
    list: rejectUnavailable,
    directorySize: rejectUnavailable,
    isSharingAvailable: rejectUnavailable,
    share: rejectUnavailable,
    requestPhotoPermission: rejectUnavailable,
    exportToPhotos: rejectUnavailable,
  };
}

function createSdk56Adapter(): ExpoFileAdapter {
  // Lazy native imports keep the web repository independent of unavailable shims.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Directory, File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sharing = require('expo-sharing') as typeof import('expo-sharing');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Image } = require('expo-image') as typeof import('expo-image');

  return {
    createCollectionDirectory() {
      return new Directory(Paths.document, 'collection') as unknown as ExpoDirectoryHandle;
    },
    createFile(location, name) {
      if (typeof location === 'string') {
        return new File(location) as unknown as ExpoFileHandle;
      }
      return new File(
        location as unknown as import('expo-file-system').Directory,
        name ?? '',
      ) as unknown as ExpoFileHandle;
    },
    isFile(value): value is ExpoFileHandle {
      return value instanceof File;
    },
    getCachedImagePath(cacheKey) {
      return Image.getCachePathAsync(cacheKey);
    },
    rangeDownloader: createNativeRangeDownloader(),
    createDownloadTask(remoteUrl, destination, options) {
      const task = File.createDownloadTask(
        remoteUrl,
        destination as unknown as import('expo-file-system').File,
        {
          ...(options?.headers ? { headers: { ...options.headers } } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
          // K6-4d: map expo's DownloadProgress to the cumulative-bytes shape the
          // stall guard consumes, so the single-stream path re-arms on progress.
          ...(options?.onProgress
            ? {
              onProgress: ({ bytesWritten }: { bytesWritten: number }) =>
                options.onProgress?.(bytesWritten),
            }
            : {}),
        },
      );
      return {
        cancel() {
          task.cancel();
        },
        async downloadAsync() {
          return await task.downloadAsync() as unknown as ExpoFileHandle | null;
        },
      };
    },
    isSharingAvailable() {
      return Sharing.isAvailableAsync();
    },
    share(uri) {
      return Sharing.shareAsync(uri);
    },
    requestPhotoPermission(writeOnly, granularPermissions) {
      const { requestPermissionsAsync } = loadLegacyMediaLibrary();
      return requestPermissionsAsync(
        writeOnly,
        granularPermissions as import('expo-media-library/legacy').GranularPermission[],
      );
    },
    createAsset(uri) {
      const { createAssetAsync } = loadLegacyMediaLibrary();
      return createAssetAsync(uri);
    },
  };
}

/**
 * K6-4c. Downloads one image as parallel `Range` windows, or reports that it
 * did not so the caller runs its single-stream path.
 *
 * `false` — not an exception — is the answer for every reason the split does
 * not apply: no native module, an unusable or refused probe, a file too small
 * to be worth a second connection, a host that will not serve windows, and a
 * failed window. That is deliberate: the parallel path is an optimisation over
 * a download that already works, so its ordinary failure mode is "the old way,
 * once".
 *
 * Exactly two answers throw instead, because for both of them the single-stream
 * retry is not a cheaper way to the same result — it is a worse way to a result
 * already in hand:
 *
 * - Cancellation, which is the user's decision. Restarting the download on
 *   another path would ignore it.
 * - Board #5: a probe that came back 404/410. A 404 on the probe is a 404 on
 *   the file, so falling back would buy the identical status one round trip
 *   later, having thrown away the copy the probe already had — and a save that
 *   reached the failure classifier with no status is recorded as `transient`,
 *   which puts a deleted image into the retry rotation forever.
 */
async function downloadInWindows(
  adapter: ExpoFileAdapter,
  remoteUrl: string,
  destination: ExpoFileHandle,
  budget: SegmentBudget,
  options: {
    signal?: AbortSignal;
    headers?: Readonly<Record<string, string>>;
    declaredBytes?: number;
    onProgress?: (receivedBytes: number) => void;
    onTransferStart?: () => void;
    onLeaseWait?: () => void;
    onLeaseAcquired?: () => void;
  },
): Promise<boolean> {
  const downloader = adapter.rangeDownloader;
  if (downloader === null) return false;
  // The source's own listing is enough to rule the split out, and ruling it out
  // early is what keeps a burst of small saves at one round trip each.
  if (
    options.declaredBytes !== undefined
    && !shouldUseRanges(options.declaredBytes, true, true)
  ) {
    return false;
  }

  let probe: RangeProbeResult;
  try {
    probe = await downloader.probe(remoteUrl, options.headers, options.signal);
  } catch {
    probe = null;
  }
  throwIfDownloadAborted(options.signal, destination);
  if (probe?.kind === 'gone') {
    // Board #5. See this function's contract: the probe already holds the
    // status, and the fallback would only re-earn it a round trip later.
    throw new CollectionServiceError(
      'download_failed',
      'The source no longer has this image.',
      { httpStatus: probe.status },
    );
  }
  if (probe === null) return false;
  if (!shouldUseRanges(probe.totalBytes, probe.acceptsRanges, true)) return false;

  const parts = planRanges(probe.totalBytes).length;
  const lease = await budget.acquire(parts, options.onLeaseWait);
  try {
    throwIfDownloadAborted(options.signal, destination);
    options.onLeaseAcquired?.();
    options.onTransferStart?.();
    await downloader.downloadRanges({
      url: remoteUrl,
      destinationUri: destination.uri,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      totalBytes: probe.totalBytes,
      parts,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
  } catch {
    // The native side already deleted its partial file; a cancelled save must
    // not be quietly retried on the single-stream path.
    throwIfDownloadAborted(options.signal, destination);
    return false;
  } finally {
    lease.release();
  }
  throwIfDownloadAborted(options.signal, destination);
  return true;
}

export function createExpoFileRepository(
  options: ExpoFileRepositoryOptions = {},
): CollectionFileRepository {
  const platform = options.platform ?? Platform.OS;
  if (platform === 'web') {
    return createCollectionFileRepository(createUnavailableCollectionFilePort());
  }

  const budget = options.segmentConcurrency === undefined
    ? sharedSegmentBudget
    : createSegmentBudget(options.segmentConcurrency);
  let adapter: ExpoFileAdapter;
  let directory: ExpoDirectoryHandle;
  try {
    adapter = options.adapter ?? createSdk56Adapter();
    directory = adapter.createCollectionDirectory();
  } catch (error) {
    throw new CollectionServiceError(
      'platform_unavailable',
      'Private file storage is unavailable on this platform.',
      { cause: error },
    );
  }

  const port: CollectionFilePort = {
    rootUri: directory.uri,
    resolve(name) {
      return adapter.createFile(directory, name).uri;
    },
    async ensureDirectory() {
      directory.create({ idempotent: true, intermediates: true });
    },
    async exists(uri) {
      return adapter.createFile(uri).exists;
    },
    async download(remoteUrl, destinationUri, options = {}) {
      const destination = adapter.createFile(destinationUri);
      throwIfDownloadAborted(options.signal, destination);
      try {
        const cachedPath = await adapter.getCachedImagePath(remoteUrl);
        throwIfDownloadAborted(options.signal, destination);
        if (cachedPath !== null) {
          const cachedFile = adapter.createFile(asFileUri(cachedPath));
          if (cachedFile.exists) {
            await cachedFile.copy(destination);
            throwIfDownloadAborted(options.signal, destination);
            return;
          }
        }
      } catch {
        if (destination.exists) destination.delete();
        if (options.signal?.aborted) throw cancelledDownloadError();
      }

      throwIfDownloadAborted(options.signal, destination);
      if (await downloadInWindows(adapter, remoteUrl, destination, budget, options)) return;

      throwIfDownloadAborted(options.signal, destination);
      const task = adapter.createDownloadTask(remoteUrl, destination, options);
      const cancel = () => {
        try {
          task.cancel();
        } catch {
          // Cancellation remains best-effort after a native task reaches a terminal state.
        }
      };
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener('abort', cancel, { once: true });
      let downloaded: ExpoFileHandle | null;
      try {
        options.onTransferStart?.();
        downloaded = await task.downloadAsync();
      } catch (error) {
        // Board #5. The native task rejects with `Unable to download a file:
        // HTTP <code>`; keeping that status on the error is what lets the
        // classifier tell a deleted source from a dropped connection. An abort
        // still wins, so a cancelled save is never reported as a status.
        throwIfDownloadAborted(options.signal, destination);
        if (error instanceof CollectionServiceError) throw error;
        const httpStatus = parseHttpStatus(error);
        throw new CollectionServiceError(
          'download_failed',
          'This image could not be saved offline.',
          { cause: error, ...(httpStatus === undefined ? {} : { httpStatus }) },
        );
      } finally {
        options.signal?.removeEventListener('abort', cancel);
      }
      throwIfDownloadAborted(options.signal, destination);
      if (downloaded === null) {
        throw new CollectionServiceError(
          'download_failed',
          'This image could not be saved offline.',
        );
      }
    },
    async move(sourceUri, destinationUri) {
      await adapter.createFile(sourceUri).move(adapter.createFile(destinationUri));
    },
    async delete(uri) {
      const file = adapter.createFile(uri);
      if (file.exists) file.delete();
    },
    async size(uri) {
      const file = adapter.createFile(uri);
      return file.exists ? file.size : 0;
    },
    async list() {
      if (!directory.exists) return [];
      return directory
        .list()
        .filter(adapter.isFile)
        .map((file) => file.uri);
    },
    async directorySize() {
      // K7 ㉖: one native walk instead of N `File` handles + 2N property reads.
      if (!directory.exists) return 0;
      return directory.size ?? 0;
    },
    isSharingAvailable() {
      return adapter.isSharingAvailable();
    },
    share(uri) {
      return adapter.share(uri);
    },
    async requestPhotoPermission() {
      const permission = await adapter.requestPhotoPermission(true, ['photo']);
      return permission.granted;
    },
    async exportToPhotos(uri) {
      await adapter.createAsset(uri);
    },
  };

  return createCollectionFileRepository(port);
}
