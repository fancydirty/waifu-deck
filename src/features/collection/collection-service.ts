import {
  CollectionServiceError,
  issueFromError,
  type CollectionFileRepository,
  type CollectionServiceIssue,
  type FileDeleteAllResult,
} from '@/features/collection/file-repository';
import type {
  DataResetCoordinator,
  DataResetLease,
} from '@/features/data-reset/data-reset-coordinator';
import {
  APP_DISTRIBUTION_POLICY,
  isImageAllowedByDistribution,
} from '@/features/distribution/distribution-policy';
import type {
  DownloadAttemptSnapshot,
  ImageRepository,
  StoredImage,
} from '@/features/images/image-repository';
import type { ImageCandidate } from '@/features/waifu/types';

export type CollectionDownloadResult =
  | { status: 'ready'; uri: string; reused: boolean }
  | { status: 'failed'; error: CollectionServiceIssue }
  | { status: 'stale' };

export type DeleteStageResult = {
  status: 'deleted' | 'failed' | 'skipped';
  deletedRows: number;
  error: CollectionServiceIssue | null;
};

export type SettingsDeleteStageResult = {
  status: 'deleted' | 'failed' | 'skipped';
  error: CollectionServiceIssue | null;
};

/** Board #27 (spec §5.4): what 删除全部应用数据's library half reports. */
export type LibraryResetOutcome = Readonly<{
  rows: 'deleted' | 'failed';
  failedFiles: readonly string[];
  cloud: 'deleted' | 'failed' | 'skipped';
  disconnected: boolean;
  error: unknown;
}>;

export type LibraryDeleteStageResult = {
  status: 'deleted' | 'failed' | 'skipped';
  cloud: 'deleted' | 'failed' | 'skipped';
  disconnected: boolean;
  error: CollectionServiceIssue | null;
};

type LibraryResetHold = Readonly<{
  finish(): Promise<LibraryResetOutcome>;
  /** Ends the hold without the library half unless `finish()` has run. */
  abandon(): void;
}>;

export type DeleteAllDataResult = {
  ok: boolean;
  files: FileDeleteAllResult;
  database: DeleteStageResult;
  settings: SettingsDeleteStageResult;
  library: LibraryDeleteStageResult;
  remaining: ('files' | 'database' | 'settings' | 'cloud')[];
};

export type CollectionOriginalReadyEvent = Readonly<{
  imageId: number;
  localUri: string;
}>;

export interface CollectionService {
  saveCandidate(candidate: ImageCandidate): Promise<{
    image: StoredImage;
    backgroundDownload: Promise<CollectionDownloadResult>;
  }>;
  resumePendingDownloads(): Promise<CollectionDownloadResult[]>;
  retryDownload(imageId: number): Promise<CollectionDownloadResult>;
  repairDownload(imageId: number): Promise<CollectionDownloadResult>;
  /**
   * The automatic repair of a local file a screen failed to load: repairs only
   * while the row still holds that `ready` URI; otherwise `{ status: 'stale' }`,
   * and the screen re-reads (spec §5.5 rule 3).
   */
  repairMissingFile(imageId: number, observedUri: string): Promise<CollectionDownloadResult>;
  deleteSaved(imageId: number): Promise<StoredImage>;
  returnToDiscovery(imageId: number): Promise<StoredImage>;
  revertPendingSave(image: StoredImage): Promise<void>;
  share(imageId: number): Promise<void>;
  exportToPhotos(imageId: number): Promise<void>;
  /** K2: share/export a file the private library owns (no images row lookup). */
  shareFile(uri: string): Promise<void>;
  exportFile(uri: string): Promise<void>;
  getCollectionBytes(): Promise<number>;
  deleteAllData(): Promise<DeleteAllDataResult>;
  /**
   * K6-5 B: how many provider downloads are running right now. Published
   * synchronously whenever the in-flight map changes and never otherwise — no
   * timer, no polling, no second store. The sync foreground guard treats a
   * nonzero count exactly as it treats a cloud transfer in flight, because a
   * download frozen by the lock screen breaks the same promise an upload does.
   * Returns its own unsubscribe.
   */
  subscribeActiveDownloads(listener: (count: number) => void): () => void;
}

type ResettableSettings = {
  reset(): Promise<void>;
};

type CollectionServiceDependencies = {
  repository: ImageRepository;
  files: CollectionFileRepository;
  coordinator: DataResetCoordinator;
  settings?: ResettableSettings;
  onOriginalReady?: (event: CollectionOriginalReadyEvent) => void;
  /**
   * K6-5 C: the resume sweep has finished walking the collection. The private
   * library uses it to re-ingest collected originals it never received — a
   * `ready` row with a local file and no library asset, which before K6-5 was
   * a blank tile with no badge, no retry, and no record of why.
   *
   * Deliberately a bare signal rather than a list: deciding which rows the
   * library is missing needs the library's own tables, which this service does
   * not and should not know about.
   */
  onCollectionResumed?: () => void;
  /**
   * N10 T1: the library's one query for `mirrored` rows whose original bytes
   * exist on neither the device nor the bucket (the 「需修复」 rows). The
   * sweep hands each to the exact path `repairDownload` uses, once per pass.
   * Optional: absent, the sweep never touches mirrored rows, exactly as
   * before this selector existed.
   */
  listMirrorDeadSavedImageIds?: () => Promise<readonly number[]>;
  /**
   * A saved row has just left the collection; the library removes this phone's
   * copy. Fire-and-forget: the change is durable and the recovery rule finishes
   * the job if the app dies first.
   */
  onSavedRowRemoved?: (imageId: number) => void;
  /**
   * Called before anything is deleted — no sync round runs after it resolves; its `finish`
   * runs after the collection's files, rows and settings are gone, and never throws.
   */
  libraryReset?: () => Promise<LibraryResetHold>;
  /**
   * Bytes of this phone's library directory. 收藏占用 is the collection
   * directory plus this; absent means the collection directory alone.
   */
  libraryBytes?: () => Promise<number>;
  allowsAdultContent?: boolean;
  clock?: () => number;
  downloadStallMs?: number;
  downloadConcurrency?: number;
};

type ActiveDownload = {
  controller: AbortController;
  promise: Promise<CollectionDownloadResult>;
  snapshot: DownloadAttemptSnapshot | null;
};

const DEFAULT_DOWNLOAD_STALL_MS = 30_000;

/**
 * K6-4b: process-wide ceiling on how many provider downloads run at once.
 * The user's own S3 bucket is never rate-limited (K7 first-principles), but a
 * booru is a third party's public API — firing dozens of parallel GETs both
 * splits the pipe (even the first images crawl) and invites 429/IP bans. Six
 * lanes keep the first saves fast while staying polite to the source.
 */
// Measured 2026-09-14 (konachan via the owner's network): the source serves
// ~150 KB/s PER STREAM regardless of count, so aggregate scales with streams —
// 6 → 0.6 MB/s, 12 → 2.1, 24 → 2.4 (saturation). 6 was 4x too low; 16 sits at
// saturation while staying well under a burst that could look like abuse.
const LIBRARY_DOWNLOAD_CONCURRENCY = 16;

type DownloadSemaphore = {
  acquire(signal: AbortSignal): Promise<void>;
  release(): void;
};

/**
 * A minimal streaming semaphore: `acquire` resolves immediately while a slot is
 * free, otherwise parks a waiter until `release` wakes exactly one. A download
 * aborted while still queued (before it acquires) removes its waiter and
 * rejects, so it relinquishes its place and never runs.
 */
function createDownloadSemaphore(max: number): DownloadSemaphore {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : LIBRARY_DOWNLOAD_CONCURRENCY;
  let active = 0;
  const waiters: { grant: () => void; onAbort: () => void; signal: AbortSignal }[] = [];
  const cancelledError = () => new CollectionServiceError(
    'download_failed',
    'This image download was cancelled.',
  );

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(cancelledError());
      if (active < limit) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          grant: resolve,
          signal,
          onAbort: () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(cancelledError());
          },
        };
        waiters.push(waiter);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      });
    },
    release() {
      active -= 1;
      const next = waiters.shift();
      if (next) {
        active += 1;
        next.signal.removeEventListener('abort', next.onAbort);
        next.grant();
      }
    },
  };
}

type StallGuard = {
  readonly signal: AbortSignal;
  readonly stalled: boolean;
  start(): void;
  pause(): void;
  resume(): void;
  reportProgress(receivedBytes: number): void;
  dispose(): void;
};

/**
 * K6-4d: a progress-driven stall detector with no fixed wall clock. Armed when
 * the download starts its network work (before the range probe), paused only
 * while the range-window budget is queued, and re-armed on every byte of
 * progress. If `stallMs` passes with no new bytes it aborts `signal`; a
 * download that keeps moving, however slowly, is never aborted. Linked to
 * `parent` so a user or lifecycle abort still cancels the transfer, leaving
 * `stalled` false so the caller can tell the two apart.
 */
function createStallGuard(parent: AbortSignal, stallMs: number): StallGuard {
  const controller = new AbortController();
  let stalled = false;
  let paused = false;
  let received = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  const onParentAbort = (): void => {
    clear();
    controller.abort();
  };

  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener('abort', onParentAbort, { once: true });
    arm();
  }

  return {
    get signal() {
      return controller.signal;
    },
    get stalled() {
      return stalled;
    },
    start() {
      if (paused && !controller.signal.aborted) {
        paused = false;
        arm();
      }
    },
    pause() {
      if (paused) return;
      paused = true;
      clear();
    },
    resume() {
      if (!paused || controller.signal.aborted) return;
      paused = false;
      arm();
    },
    reportProgress(receivedBytes) {
      if (!Number.isFinite(receivedBytes) || receivedBytes <= received) return;
      received = receivedBytes;
      if (!paused && !controller.signal.aborted) arm();
    },
    dispose() {
      clear();
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * K6-4d: internal signal that a stalled first attempt should be requeued once
 * through the download semaphore rather than marked failed. Never leaves the
 * module.
 */
class StallRequeue {}

class TransientRetry {
  constructor(
    readonly imageId: number,
    readonly image: StoredImage,
    readonly attempt: DownloadAttemptSnapshot,
    readonly issue: CollectionServiceIssue,
  ) {}
}

const TRANSIENT_RETRY_DELAY_MS = 2_000;

function downloadSnapshot(
  image: Pick<StoredImage, 'remoteUrl' | 'extension'>,
): DownloadAttemptSnapshot {
  return { remoteUrl: image.remoteUrl, extension: image.extension };
}

function sameDownloadSnapshot(
  left: DownloadAttemptSnapshot | null,
  right: DownloadAttemptSnapshot,
): boolean {
  return left?.remoteUrl === right.remoteUrl && left.extension === right.extension;
}

/**
 * Board #27 (spec §5.5 rule 3): the row still holds the file a screen failed
 * to load — saved, `ready`, and at the URI the screen saw.
 */
function holdsReadyFile(image: StoredImage | null, uri: string): boolean {
  return (
    image !== null &&
    image.decision === 'saved' &&
    image.downloadState === 'ready' &&
    image.localUri === uri
  );
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller has already started `promise`; unobserved, its rejection would go unhandled.
    void promise.catch(() => undefined);
    return Promise.reject(new CollectionServiceError(
      'download_failed',
      'This image download was cancelled.',
    ));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CollectionServiceError(
      'download_failed',
      'This image download was cancelled.',
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function libraryStage(
  reset: CollectionServiceDependencies['libraryReset'],
  outcome: LibraryResetOutcome | null,
  startError: unknown,
): LibraryDeleteStageResult {
  if (!reset) {
    return { status: 'skipped', cloud: 'skipped', disconnected: false, error: null };
  }
  if (outcome === null) {
    return {
      status: 'failed',
      cloud: 'skipped',
      disconnected: false,
      error: issueFromError(
        startError,
        'database_failed',
        'Library records could not be deleted.',
      ),
    };
  }
  const rowsFailed = outcome.rows === 'failed';
  return {
    status: outcome.rows,
    cloud: outcome.cloud,
    disconnected: outcome.disconnected,
    error: outcome.error == null
      ? null
      : issueFromError(
        outcome.error,
        rowsFailed ? 'database_failed' : 'delete_failed',
        rowsFailed
          ? 'Library records could not be deleted.'
          : 'The cloud library connection could not be removed.',
      ),
  };
}

export function createCollectionService({
  repository,
  files,
  coordinator,
  settings,
  onOriginalReady,
  onCollectionResumed,
  listMirrorDeadSavedImageIds,
  onSavedRowRemoved,
  libraryReset,
  libraryBytes,
  allowsAdultContent = APP_DISTRIBUTION_POLICY.allowsAdultContent,
  clock = Date.now,
  downloadStallMs = DEFAULT_DOWNLOAD_STALL_MS,
  downloadConcurrency = LIBRARY_DOWNLOAD_CONCURRENCY,
}: CollectionServiceDependencies): CollectionService {
  const downloads = new Map<number, ActiveDownload>();
  const downloadAttempts = new Set<ActiveDownload>();
  const attemptsByImage = new Map<number, Set<ActiveDownload>>();
  const boundedDownloadStallMs =
    Number.isFinite(downloadStallMs) && downloadStallMs > 0
      ? downloadStallMs
      : DEFAULT_DOWNLOAD_STALL_MS;
  const downloadSemaphore = createDownloadSemaphore(downloadConcurrency);
  const cleanupQueue = new Map<number, Set<string>>();
  const cleanupErrors = new Map<string, CollectionServiceIssue>();
  const imageBlockCounts = new Map<number, number>();
  const destructiveTails = new Map<number, Promise<unknown>>();
  const destructiveOperations = new Set<Promise<unknown>>();
  let downloadsGloballyBlocked = false;
  // K7 ㉓: while a sweep is listing the directory, every download registered
  // adds its image id here, and the sweep reads the set only after the
  // listing resolved. Ids are never removed during the sweep, so a download
  // that starts and finishes inside the window is still protected.
  let sweepClaims: Set<number> | null = null;
  let resumeInFlight: Promise<CollectionDownloadResult[]> | null = null;
  let resetInFlight: Promise<DeleteAllDataResult> | null = null;
  let resetGeneration = 0;

  const activeDownloadListeners = new Set<(count: number) => void>();
  let publishedDownloadCount = 0;

  const publishActiveDownloads = (): void => {
    const count = downloads.size;
    if (count === publishedDownloadCount) return;
    publishedDownloadCount = count;
    // Copy first: a listener may unsubscribe itself while being notified.
    for (const listener of [...activeDownloadListeners]) {
      try {
        listener(count);
      } catch {
        // A notification consumer can never fail a download.
      }
    }
  };

  const notifyOriginalReady = (event: CollectionOriginalReadyEvent): void => {
    try {
      onOriginalReady?.(event);
    } catch {
      // The local download is durable; optional library work cannot undo it.
    }
  };

  const notifySavedRowRemoved = (imageId: number): void => {
    try {
      onSavedRowRemoved?.(imageId);
    } catch {
      // The row has already left; the recovery rule finishes this phone's copy.
    }
  };

  coordinator.registerResetParticipant(async () => {
    resetGeneration += 1;
    const activeDownloads = [...downloadAttempts];
    if (downloadsGloballyBlocked) {
      for (const active of activeDownloads) active.controller.abort();
    }
    await Promise.allSettled(
      activeDownloads.map(({ promise }) => promise),
    );
    await flushCleanupQueue();
  });

  const blockedError = () => new CollectionServiceError(
    'operation_blocked',
    'A collection data operation is already in progress.',
  );

  const databaseError = (error: unknown) => new CollectionServiceError(
    'database_failed',
    'Saved image data could not be updated.',
    { cause: error },
  );

  const blockImage = (imageId: number): void => {
    imageBlockCounts.set(imageId, (imageBlockCounts.get(imageId) ?? 0) + 1);
  };

  const unblockImage = (imageId: number): void => {
    const next = (imageBlockCounts.get(imageId) ?? 1) - 1;
    if (next <= 0) imageBlockCounts.delete(imageId);
    else imageBlockCounts.set(imageId, next);
  };

  const untrackDownload = (imageId: number, active: ActiveDownload): void => {
    downloadAttempts.delete(active);
    const attempts = attemptsByImage.get(imageId);
    attempts?.delete(active);
    if (attempts?.size === 0) attemptsByImage.delete(imageId);
  };

  const cancelImageDownloads = async (imageId: number): Promise<void> => {
    const attempts = [...(attemptsByImage.get(imageId) ?? [])];
    for (const active of attempts) active.controller.abort();
    await Promise.allSettled(attempts.map(({ promise }) => promise));
  };

  const enqueueCleanup = (image: StoredImage): void => {
    const queued = cleanupQueue.get(image.id) ?? new Set<string>();
    for (const uri of files.cleanupUrisFor(image)) queued.add(uri);
    cleanupQueue.set(image.id, queued);
  };

  const flushCleanupQueue = async (imageId?: number): Promise<void> => {
    const tasks = [...cleanupQueue.entries()]
      .filter(([id]) => imageId === undefined || id === imageId);
    for (const [id, uris] of tasks) {
      for (const uri of [...uris]) {
        try {
          await files.deleteUri(uri);
          uris.delete(uri);
          cleanupErrors.delete(uri);
        } catch (error) {
          cleanupErrors.set(uri, issueFromError(
            error,
            'delete_failed',
            'A saved file could not be cleaned up.',
          ));
        }
      }
      if (uris.size === 0) cleanupQueue.delete(id);
    }
  };

  const remainingCleanupFailures = async (): Promise<FileDeleteAllResult['failed']> => {
    const failed: FileDeleteAllResult['failed'] = [];
    for (const [id, uris] of [...cleanupQueue.entries()]) {
      for (const uri of [...uris]) {
        try {
          if (!(await files.exists(uri))) {
            uris.delete(uri);
            cleanupErrors.delete(uri);
            continue;
          }
        } catch (error) {
          cleanupErrors.set(uri, issueFromError(
            error,
            'delete_failed',
            'A saved file could not be inspected after cleanup.',
          ));
        }
        failed.push({
          uri,
          error: cleanupErrors.get(uri) ?? {
            code: 'delete_failed',
            message: 'A saved file could not be cleaned up.',
          },
        });
      }
      if (uris.size === 0) cleanupQueue.delete(id);
    }
    return failed;
  };

  const cleanupWithoutThrowing = async (image: StoredImage): Promise<void> => {
    enqueueCleanup(image);
    await flushCleanupQueue(image.id);
  };

  const requireSaved = async (imageId: number): Promise<StoredImage> => {
    const image = await repository.getById(imageId);
    if (!image || image.decision !== 'saved') {
      throw new CollectionServiceError('not_saved', 'This image is not in the collection.');
    }
    return image;
  };

  const requireReady = async (imageId: number): Promise<StoredImage> => {
    const image = await requireSaved(imageId);
    if (image.downloadState !== 'ready' || !image.localUri) {
      throw new CollectionServiceError('not_ready', 'This image is not available offline yet.');
    }
    return image;
  };

  const recordDownloadFailure = async (
    imageId: number,
    image: StoredImage,
    attempt: DownloadAttemptSnapshot,
    issue: CollectionServiceIssue,
  ): Promise<CollectionDownloadResult> => {
    let accepted: boolean;
    try {
      // Board #5: carry the classification onto the row. `issue.kind` is only
      // ever absent when the code is not `download_failed`, and the
      // repository then falls back to its own `'transient'` default — the
      // safe answer, because a retry that cannot work costs one request and a
      // wrongly stranded image costs the user the image.
      accepted = await repository.markDownloadFailed(
        imageId,
        issue.code,
        attempt,
        issue.kind,
      );
    } catch (databaseFailure) {
      await cleanupWithoutThrowing(image);
      throw databaseError(databaseFailure);
    }
    if (!accepted) {
      // K6-5 A: this attempt no longer owns the row, so it no longer owns the
      // file either. `cleanupUrisFor` names the *id-derived* final and partial
      // paths, which every attempt on this image shares — deleting them here
      // destroys whatever the winning attempt already downloaded and ingested,
      // leaving the row `ready` with nothing behind it (owner phone
      // 2026-09-14: complete in the bucket, missing on the device, tile
      // 「需修复」). A genuinely orphaned file is reclaimed by `reconcile`
      // during the next resume, which is the sweep that already owns that job.
      return { status: 'stale' };
    }
    await cleanupWithoutThrowing(image);
    return { status: 'failed', error: issue };
  };

  const runDownload = async (
    imageId: number,
    signal: AbortSignal,
    setSnapshot: (snapshot: DownloadAttemptSnapshot) => void,
    canRequeue: boolean,
    canRetryTransient: boolean,
  ): Promise<CollectionDownloadResult> => {
    let image = await requireSaved(imageId);
    if (image.downloadState === 'ready' && image.localUri) {
      if (await files.exists(image.localUri)) {
        return { status: 'ready', uri: image.localUri, reused: true };
      }
      let markedMissing: boolean;
      try {
        markedMissing = await repository.markFileMissing(imageId, 'file_missing');
      } catch (error) {
        throw databaseError(error);
      }
      if (!markedMissing) return { status: 'stale' };
      image = (await repository.getById(imageId)) ?? image;
    }

    if (image.downloadState === 'failed') {
      let pending: StoredImage | null;
      try {
        pending = await repository.decide(imageId, 'saved', clock());
      } catch (error) {
        throw databaseError(error);
      }
      if (!pending) return { status: 'stale' };
      image = pending;
    }
    if (image.downloadState !== 'pending') {
      throw new CollectionServiceError('not_ready', 'This download cannot be started.');
    }

    const attempt = downloadSnapshot(image);
    setSnapshot(attempt);
    let downloaded: Awaited<ReturnType<CollectionFileRepository['download']>>;
    // K6-4d: the stall guard is created after acquiring the image slot, before
    // the range probe. Its clock pauses only while the range-window budget is
    // queued, and re-arms on every progress report.
    const guard = createStallGuard(signal, boundedDownloadStallMs);
    try {
      downloaded = await waitForAbort(
        files.download(image, {
          signal: guard.signal,
          onTransferStart: () => guard.start(),
          onLeaseWait: () => guard.pause(),
          onLeaseAcquired: () => guard.resume(),
          onProgress: (receivedBytes) => guard.reportProgress(receivedBytes),
        }),
        guard.signal,
      );
    } catch (error) {
      // A first stall is not a failure: throw so the caller requeues this image
      // once through the same semaphore. A later stall is transient and can use
      // the one same-save retry; a user/lifecycle abort is terminal.
      if (guard.stalled && !signal.aborted && canRequeue) {
        throw new StallRequeue();
      }
      const issue = issueFromError(
        error,
        'download_failed',
        'This image could not be saved offline.',
      );
      if (issue.kind === 'transient' && canRetryTransient && !signal.aborted) {
        guard.dispose();
        throw new TransientRetry(imageId, image, attempt, issue);
      }
      return await recordDownloadFailure(imageId, image, attempt, issue);
    } finally {
      guard.dispose();
    }

    let accepted: boolean;
    try {
      let downloadedByteSize: number | undefined;
      if (image.byteSize === 0) {
        try {
          const size = await files.fileSize(downloaded.uri);
          if (Number.isSafeInteger(size) && size > 0) downloadedByteSize = size;
        } catch {
          // A size read is supplementary metadata; a completed download remains ready.
        }
      }
      accepted = await repository.markDownloadReady(
        imageId,
        downloaded.uri,
        attempt,
        downloadedByteSize,
      );
    } catch (error) {
      await cleanupWithoutThrowing(image);
      throw databaseError(error);
    }
    if (!accepted) {
      // K6-5 A, same rule on the success path: the row moved on while this
      // transfer was running, so the bytes now at the shared final path belong
      // to the attempt that did win — and may already be in the library and the
      // bucket. Leave them.
      return { status: 'stale' };
    }
    notifyOriginalReady({ imageId, localUri: downloaded.uri });
    return { status: 'ready', uri: downloaded.uri, reused: downloaded.reused };
  };

  const beginDownload = (
    imageId: number,
    expectedSnapshot: DownloadAttemptSnapshot | null = null,
    previous: ActiveDownload | null = null,
  ): ActiveDownload => {
    const controller = new AbortController();
    const active: ActiveDownload = {
      controller,
      snapshot: expectedSnapshot,
      promise: Promise.resolve({ status: 'stale' }),
    };

    const operation = (async () => {
      const setSnapshot = (snapshot: DownloadAttemptSnapshot): void => {
        active.snapshot = snapshot;
      };
      let acquired = false;
      let canRequeue = true;
      let canRetryTransient = true;
      try {
        if (previous) {
          await waitForAbort(
            previous.promise.then(() => undefined, () => undefined),
            controller.signal,
          );
        }
        if (downloadsGloballyBlocked || (imageBlockCounts.get(imageId) ?? 0) > 0) {
          throw blockedError();
        }
        // K6-4b: hold a shared slot only around the actual provider fetch, so a
        // burst of saves cannot open more than LIBRARY_DOWNLOAD_CONCURRENCY GETs
        // against the source at once. Placed after the blocked-check so that
        // still short-circuits without consuming a slot.
        await downloadSemaphore.acquire(controller.signal);
        acquired = true;
        while (true) {
          try {
            return await runDownload(
              imageId,
              controller.signal,
              setSnapshot,
              canRequeue,
              canRetryTransient,
            );
          } catch (error) {
            if (error instanceof TransientRetry) {
              canRetryTransient = false;
              downloadSemaphore.release();
              acquired = false;
              const waited = await waitForDelay(
                TRANSIENT_RETRY_DELAY_MS,
                controller.signal,
              );
              if (!waited || controller.signal.aborted) {
                return await recordDownloadFailure(
                  error.imageId,
                  error.image,
                  error.attempt,
                  error.issue,
                );
              }
              try {
                await downloadSemaphore.acquire(controller.signal);
                acquired = true;
              } catch {
                return await recordDownloadFailure(
                  error.imageId,
                  error.image,
                  error.attempt,
                  error.issue,
                );
              }
              continue;
            }
            if (!(error instanceof StallRequeue)) throw error;
            // K6-4d: a first stall is not a failure. Release the slot, rejoin the
            // back of the queue through the same semaphore, and try once more.
            // The stall budget is consumed; the transient retry budget remains
            // available for a later non-cancelled transient failure.
            canRequeue = false;
            downloadSemaphore.release();
            acquired = false;
            await downloadSemaphore.acquire(controller.signal);
            acquired = true;
            // Keep both attempt budgets across the stall requeue.
            continue;
          }
        }
      } finally {
        if (acquired) downloadSemaphore.release();
      }
    })();
    downloadAttempts.add(active);
    const imageAttempts = attemptsByImage.get(imageId) ?? new Set<ActiveDownload>();
    imageAttempts.add(active);
    attemptsByImage.set(imageId, imageAttempts);
    active.promise = operation.finally(() => {
      if (downloads.get(imageId) === active) downloads.delete(imageId);
      untrackDownload(imageId, active);
      publishActiveDownloads();
    });
    sweepClaims?.add(imageId);
    downloads.set(imageId, active);
    publishActiveDownloads();
    return active;
  };

  const startDownload = (
    imageId: number,
    expectedSnapshot: DownloadAttemptSnapshot | null = null,
  ): Promise<CollectionDownloadResult> => {
    if (downloadsGloballyBlocked || (imageBlockCounts.get(imageId) ?? 0) > 0) {
      return Promise.reject(blockedError());
    }
    const existing = downloads.get(imageId);
    if (!existing) return beginDownload(imageId, expectedSnapshot).promise;
    if (!expectedSnapshot || sameDownloadSnapshot(existing.snapshot, expectedSnapshot)) {
      return existing.promise;
    }

    existing.controller.abort();
    return beginDownload(imageId, expectedSnapshot, existing).promise;
  };

  const retryDownload = (imageId: number): Promise<CollectionDownloadResult> => {
    if (downloadsGloballyBlocked) return Promise.reject(blockedError());
    const retryGeneration = resetGeneration;

    return coordinator.runMutation(() => {
      if (downloadsGloballyBlocked || retryGeneration !== resetGeneration) {
        throw blockedError();
      }
      return startDownload(imageId);
    });
  };

  const saveCandidate = (candidate: ImageCandidate): Promise<{
    image: StoredImage;
    backgroundDownload: Promise<CollectionDownloadResult>;
  }> => {
    if (downloadsGloballyBlocked) return Promise.reject(blockedError());
    if (!isImageAllowedByDistribution(candidate, {
      variant: allowsAdultContent ? 'direct' : 'store',
      allowsAdultContent,
    })) {
      return Promise.reject(new CollectionServiceError(
        'operation_blocked',
        'Adult content is unavailable in this distribution.',
      ));
    }
    const saveGeneration = resetGeneration;

    return coordinator.runMutation(async () => {
      if (downloadsGloballyBlocked || saveGeneration !== resetGeneration) {
        throw blockedError();
      }

      let image: StoredImage;
      try {
        image = await repository.saveCandidate(candidate, clock());
      } catch (error) {
        throw databaseError(error);
      }

      const backgroundDownload = startDownload(image.id, downloadSnapshot(image));
      void backgroundDownload.catch(() => undefined);
      return { image, backgroundDownload };
    });
  };

  const resumePendingDownloads = (): Promise<CollectionDownloadResult[]> => {
    if (downloadsGloballyBlocked) return Promise.reject(blockedError());
    if (resumeInFlight) return resumeInFlight;
    const resumeGeneration = resetGeneration;
    const activeDownloads = [...downloads.values()].map(({ promise }) => promise);
    // K7 ㉓: no barrier. Downloads keep starting; the sweep protects them by
    // id (seeded with everything in flight now, grown by every registration
    // until the listing has been read) instead of waiting for them.
    const claims = new Set<number>(downloads.keys());
    sweepClaims = claims;

    let current!: Promise<CollectionDownloadResult[]>;
    current = coordinator.runMutation(async () => {
      const repairIds: number[] = [];
      try {
        if (downloadsGloballyBlocked || resumeGeneration !== resetGeneration) {
          throw blockedError();
        }
        await flushCleanupQueue();
        const collection = await repository.listCollection();
        const swept = await files.sweep(
          collection
            .filter((image) => image.downloadState === 'ready' && image.localUri)
            .map((image) => image.localUri!),
          claims,
        );
        const missing = new Set(swept.missing);
        for (const image of collection) {
          // K7 ㉓: the sweep no longer waits for in-flight downloads, so it now
          // reads rows those downloads still own. It must not judge such a row
          // any more than it judges that id's files: the live attempt reports
          // itself (through `activeResults`, or through the caller that started
          // it mid-sweep), and re-entering it here would either duplicate the
          // result or fail the whole resume on a download the sweep never began.
          if (claims.has(image.id)) continue;
          if (image.downloadState === 'pending') {
            repairIds.push(image.id);
          } else if (
            image.downloadState === 'ready' &&
            image.localUri &&
            missing.has(image.localUri)
          ) {
            repairIds.push(image.id);
          } else if (
            image.downloadState === 'failed' &&
            image.downloadErrorKind !== 'source_gone'
          ) {
            // Board #5 §6: a transient failure — and a pre-v20 row that carries
            // no classification — is retried on every sweep (cold app start and
            // the user's pull-to-refresh; a tab tap deliberately starts no
            // work, see P-tab-freeze cut 1) until it succeeds or the source
            // proves it is gone. No timers and no extra requests: this rides
            // the sweep that already runs, once per row per pass, through the
            // same semaphore.
            repairIds.push(image.id);
          }
        }
      } finally {
        if (sweepClaims === claims) sweepClaims = null;
      }

      // N10 T1: a dead mirrored row matches none of the passes above — the
      // library names them, once per pass, and each walks `repairMirrored`
      // (the row's own repair button). Optional chaining: no dependency, no
      // mirrored-row work.
      const mirrorDeadIds = [
        ...new Set((await listMirrorDeadSavedImageIds?.()) ?? []),
      ];

      // Board #27 S1b (§5.5): settled, never `all`. One download's rejection
      // is that download's outcome, not the pass's: the caller that started it
      // still receives it, the sweep reports `stale` (it no longer owns that
      // row's outcome, and a result makes the startup snapshot re-publish), and
      // the pass still reaches `onCollectionResumed` below.
      const settledResults = (
        outcomes: PromiseSettledResult<CollectionDownloadResult>[],
      ): CollectionDownloadResult[] => outcomes.map((outcome): CollectionDownloadResult => (
        outcome.status === 'fulfilled' ? outcome.value : { status: 'stale' }
      ));
      // The listing is a snapshot. A row handed over to the library since it
      // was read is `mirrored` now, which `runDownload` refuses with
      // `not_ready` — so each row is re-read right before its repair, and one
      // that is gone, no longer saved, or no longer ready, pending or failed
      // starts no attempt.
      const repair = async (imageId: number): Promise<CollectionDownloadResult> => {
        const image = await repository.getById(imageId);
        if (
          !image ||
          image.decision !== 'saved' ||
          (image.downloadState !== 'ready' &&
            image.downloadState !== 'pending' &&
            image.downloadState !== 'failed')
        ) {
          return { status: 'stale' };
        }
        return startDownload(imageId);
      };
      const repairMirrorDead = async (
        imageId: number,
      ): Promise<CollectionDownloadResult> => {
        // The listing is a snapshot (same rule as `repair` above): re-read
        // the row, and repair it only while it is still saved and mirrored.
        const image = await repository.getById(imageId);
        if (
          !image ||
          image.decision !== 'saved' ||
          image.downloadState !== 'mirrored'
        ) {
          return { status: 'stale' };
        }
        return repairMirrored(imageId);
      };
      const activeResults = settledResults(await Promise.allSettled(activeDownloads));
      const repairResults = settledResults(await Promise.allSettled(repairIds.map(repair)));
      const mirrorDeadResults = settledResults(
        await Promise.allSettled(mirrorDeadIds.map(repairMirrorDead)),
      );
      // 删除全部应用数据, begun during the pass, cancels its downloads and
      // refuses its repairs, and the settles above report those as results.
      // So the pass checks for it again here, as it does at its start: it owns
      // the collection now, and the library hook must not start work while it
      // runs.
      if (downloadsGloballyBlocked || resumeGeneration !== resetGeneration) {
        throw blockedError();
      }
      // K6-5 C: last, and never able to fail the sweep — every download this
      // pass started already reports itself through `onOriginalReady`, so the
      // library only has to look for what nothing is downloading.
      try {
        onCollectionResumed?.();
      } catch {
        // The collection is reconciled; an optional library pass cannot undo it.
      }
      return [...activeResults, ...repairResults, ...mirrorDeadResults];
    }).finally(() => {
      if (resumeInFlight === current) resumeInFlight = null;
    });
    resumeInFlight = current;
    return current;
  };

  const runDestructive = <T>(
    imageId: number,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (downloadsGloballyBlocked) return Promise.reject(blockedError());
    const destructiveGeneration = resetGeneration;

    return coordinator.runMutation(() => {
      if (downloadsGloballyBlocked || destructiveGeneration !== resetGeneration) {
        throw blockedError();
      }

      blockImage(imageId);
      const previous = destructiveTails.get(imageId) ?? Promise.resolve();
      let current!: Promise<T>;
      current = previous
        .catch(() => undefined)
        .then(async () => {
          await cancelImageDownloads(imageId);
          await flushCleanupQueue(imageId);
          return operation();
        })
        .finally(() => {
          unblockImage(imageId);
          destructiveOperations.delete(current);
          if (destructiveTails.get(imageId) === current) destructiveTails.delete(imageId);
        });
      destructiveTails.set(imageId, current);
      destructiveOperations.add(current);
      return current;
    });
  };

  /**
   * The forced re-download `repairDownload` runs on a row it read inside its
   * lease, shared with `repairMissingFile`, which only ever hands it a `ready`
   * row. A `ready` row's file is marked corrupt first; a hand-over that landed
   * since the read has made the row `mirrored`, which `markFileMissing` does
   * not take, so the repair answers `stale` and never reaches the provider.
   */
  const forceRepair = async (image: StoredImage): Promise<CollectionDownloadResult> => {
    if (image.downloadState === 'ready') {
      let markedMissing: boolean;
      try {
        markedMissing = await repository.markFileMissing(image.id, 'file_corrupt');
      } catch (error) {
        throw databaseError(error);
      }
      if (!markedMissing) return { status: 'stale' };
    }

    await files.deleteImage(image);
    const controller = new AbortController();
    // K6-4d: no wall clock — runDownload's own stall guard aborts a repair
    // that stops making progress. A repair holds no shared slot, so it does
    // not requeue; a stall marks it failed and the user can retry.
    return await runDownload(image.id, controller.signal, () => undefined, false, false);
  };

  const repairAfterDeletedFile = async (imageId: number): Promise<void> => {
    try {
      await repository.markFileMissing(imageId, 'file_missing');
    } catch {
      // The original database failure remains the reported cause.
    }
  };

  /**
   * K2b: the repair of a row the library cannot serve — reclaim a `mirrored`
   * row to the provider download under the image's destructive lease, then
   * force the repair. N10 T1: the resume sweep's mirror-dead pass walks this
   * exact function too, so an automatic repair is the manual one.
   */
  const repairMirrored = (imageId: number): Promise<CollectionDownloadResult> =>
    runDestructive(imageId, async () => {
      const image = await requireSaved(imageId);
      if (image.downloadState === 'mirrored') {
        // The library could not serve this row's bytes, so hand it back to
        // the provider download path.
        let reclaimed: boolean;
        try {
          reclaimed = await repository.reclaimMirroredForDownload(imageId);
        } catch (error) {
          throw databaseError(error);
        }
        if (!reclaimed) return { status: 'stale' };
      }
      return forceRepair(image);
    });

  const safeDeleteAllFiles = async (): Promise<FileDeleteAllResult> => {
    try {
      return await files.deleteAll();
    } catch (error) {
      return {
        deleted: [],
        failed: [{
          uri: 'collection',
          error: issueFromError(
            error,
            'delete_failed',
            'The private collection could not be deleted.',
          ),
        }],
      };
    }
  };

  const mergeFileAttempts = (
    first: FileDeleteAllResult,
    final: FileDeleteAllResult,
    cleanup: FileDeleteAllResult['failed'] = [],
  ): FileDeleteAllResult => ({
    deleted: [...new Set([...first.deleted, ...final.deleted])]
      .filter((uri) => !final.failed.some((failure) => failure.uri === uri) &&
        !cleanup.some((failure) => failure.uri === uri)),
    failed: [...new Map(
      [...final.failed, ...cleanup].map((failure) => [failure.uri, failure]),
    ).values()],
  });

  const repairMissingReadyFile = async (
    imageId: number,
    uri: string,
    error: unknown,
  ): Promise<never> => {
    let fileMissing = error instanceof CollectionServiceError && error.code === 'file_missing';
    if (!fileMissing) {
      try {
        fileMissing = !(await files.exists(uri));
      } catch {
        throw error;
      }
    }
    if (!fileMissing) throw error;
    try {
      await repository.markFileMissing(imageId, 'file_missing');
    } catch (databaseFailure) {
      throw databaseError(databaseFailure);
    }
    throw error;
  };

  return {
    saveCandidate,
    resumePendingDownloads,
    retryDownload,
    subscribeActiveDownloads(listener) {
      activeDownloadListeners.add(listener);
      return () => {
        activeDownloadListeners.delete(listener);
      };
    },
    repairDownload: repairMirrored,
    async repairMissingFile(imageId, observedUri) {
      // Spec §5.5 rule 3: the screen's snapshot may predate a hand-over. A
      // plain read first, outside any lease, so a stale request never reaches
      // `runDestructive`, which cancels the image's running downloads.
      if (!holdsReadyFile(await repository.getById(imageId), observedUri)) {
        return { status: 'stale' };
      }
      // A running download re-downloads a missing file itself. A present file that failed to load
      // is repaired here; cancelling that download is harmless, as it finds the file present.
      if (attemptsByImage.has(imageId) && !(await files.exists(observedUri))) {
        return { status: 'stale' };
      }
      return runDestructive(imageId, async () => {
        const image = await requireSaved(imageId);
        // The row may have changed while this waited for the lease.
        if (!holdsReadyFile(image, observedUri)) return { status: 'stale' };
        return forceRepair(image);
      });
    },
    deleteSaved(imageId) {
      return runDestructive(imageId, async () => {
        const image = await requireSaved(imageId);
        await files.deleteImage(image);
        let deleted: StoredImage | null;
        try {
          deleted = await repository.deleteFromCollection(imageId);
        } catch (error) {
          await repairAfterDeletedFile(imageId);
          throw databaseError(error);
        }
        if (!deleted) {
          throw new CollectionServiceError('not_saved', 'This image is not in the collection.');
        }
        notifySavedRowRemoved(imageId);
        return deleted;
      });
    },
    returnToDiscovery(imageId) {
      return runDestructive(imageId, async () => {
        const image = await requireSaved(imageId);
        await files.deleteImage(image);
        let removed: StoredImage | null;
        try {
          removed = await repository.returnToDiscovery(imageId);
        } catch (error) {
          await repairAfterDeletedFile(imageId);
          throw databaseError(error);
        }
        if (!removed) {
          throw new CollectionServiceError('not_saved', 'This image is not in the collection.');
        }
        notifySavedRowRemoved(imageId);
        return removed;
      });
    },
    async revertPendingSave(image) {
      enqueueCleanup(image);
      if (downloadsGloballyBlocked) return;
      await runDestructive(image.id, async () => {
        await flushCleanupQueue(image.id);
      });
    },
    share(imageId) {
      return coordinator.runMutation(async () => {
        const image = await requireReady(imageId);
        const uri = image.localUri!;
        try {
          await files.share(uri);
        } catch (error) {
          await repairMissingReadyFile(imageId, uri, error);
        }
      });
    },
    exportToPhotos(imageId) {
      return coordinator.runMutation(async () => {
        const image = await requireReady(imageId);
        const uri = image.localUri!;
        try {
          await files.exportToPhotos(uri);
        } catch (error) {
          await repairMissingReadyFile(imageId, uri, error);
        }
      });
    },
    shareFile(uri) {
      return coordinator.runMutation(() => files.share(uri));
    },
    exportFile(uri) {
      return coordinator.runMutation(() => files.exportToPhotos(uri));
    },
    async getCollectionBytes() {
      const [collection, library] = await Promise.all([
        files.getCollectionBytes(),
        libraryBytes?.() ?? 0,
      ]);
      return collection + library;
    },
    deleteAllData() {
      if (resetInFlight) return resetInFlight;
      downloadsGloballyBlocked = true;

      let current!: Promise<DeleteAllDataResult>;
      current = (async () => {
        let lease: DataResetLease | null = null;
        // The sync lease is process-wide and survives reloadAppServices, so a
        // throw anywhere between libraryReset() and finish() still releases it.
        let libraryHold: LibraryResetHold | null = null;
        try {
          for (const active of [...downloadAttempts]) {
            active.controller.abort();
          }
          lease = await coordinator.beginReset();
          const activeDownloads = [...downloadAttempts];
          for (const active of activeDownloads) active.controller.abort();
          await Promise.allSettled([
            ...activeDownloads.map(({ promise }) => promise),
            ...destructiveOperations,
          ]);
          await flushCleanupQueue();

          let libraryStartError: unknown = null;
          if (libraryReset) {
            try {
              libraryHold = await libraryReset();
            } catch (error) {
              libraryStartError = error;
            }
          }

          const firstFileAttempt = await safeDeleteAllFiles();

          let database: DeleteStageResult;
          try {
            const deletedRows = await repository.deleteAll();
            database = { status: 'deleted', deletedRows, error: null };
          } catch (error) {
            database = {
              status: 'failed',
              deletedRows: 0,
              error: issueFromError(
                error,
                'database_failed',
                'Saved image data could not be deleted.',
              ),
            };
          }

          let settingsResult: SettingsDeleteStageResult;
          if (!settings) {
            settingsResult = { status: 'skipped', error: null };
          } else {
            try {
              await settings.reset();
              settingsResult = { status: 'deleted', error: null };
            } catch (error) {
              settingsResult = {
                status: 'failed',
                error: issueFromError(
                  error,
                  'settings_failed',
                  'Settings could not be deleted.',
                ),
              };
            }
          }

          let libraryOutcome: LibraryResetOutcome | null = null;
          if (libraryHold) libraryOutcome = await libraryHold.finish();

          await flushCleanupQueue();
          let finalFileAttempt: FileDeleteAllResult;
          try {
            finalFileAttempt = await files.reconcile([]);
          } catch (error) {
            finalFileAttempt = {
              deleted: [],
              failed: [{
                uri: 'collection',
                error: issueFromError(
                  error,
                  'delete_failed',
                  'The private collection could not be reconciled.',
                ),
              }],
            };
          }
          await flushCleanupQueue();
          const cleanupFailures = await remainingCleanupFailures();
          const libraryFileFailures = (libraryOutcome?.failedFiles ?? []).map((uri) => ({
            uri,
            error: {
              code: 'delete_failed' as const,
              message: 'A private library file could not be deleted.',
            },
          }));
          const fileResult = mergeFileAttempts(
            firstFileAttempt,
            finalFileAttempt,
            [...cleanupFailures, ...libraryFileFailures],
          );
          const library = libraryStage(libraryReset, libraryOutcome, libraryStartError);

          const remaining: DeleteAllDataResult['remaining'] = [];
          if (fileResult.failed.length > 0) {
            remaining.push('files');
          }
          if (database.status === 'failed' || library.status === 'failed') remaining.push('database');
          if (settingsResult.status === 'failed') remaining.push('settings');
          if (library.cloud === 'failed') remaining.push('cloud');
          return {
            ok: remaining.length === 0,
            files: fileResult,
            database,
            settings: settingsResult,
            library,
            remaining,
          };
        } finally {
          downloadsGloballyBlocked = false;
          if (resetInFlight === current) resetInFlight = null;
          libraryHold?.abandon();
          lease?.release();
        }
      })();
      resetInFlight = current;
      return current;
    },
  };
}
