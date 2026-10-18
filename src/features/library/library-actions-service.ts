import type {
  LibraryActionKind,
  LibraryActionResult,
  LibraryBatchKind,
  LibraryBatchProgress,
  LibraryFailureCategory,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import type { LibraryAccountActions } from '@/features/library/library-account-actions';
import type { LibraryBatchOrchestrator } from '@/features/library/library-batch-orchestrator';
import type { LibraryLocalActions } from '@/features/library/library-local-actions';
import type { LibraryProtectAction } from '@/features/library/library-protect-action';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';
import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import type {
  LibraryPermanentDeleteIntentResult,
  LibraryRestoreIntentResult,
  LibrarySyncReport,
} from '@/features/library/library-sync-types';
import type {
  LibraryEmptyTrashResult,
  LibraryTrashActions,
} from '@/features/library/library-trash-actions';

/** The single Direct-only surface SP9 and the settings UI consume. */
export type LibraryActionsController = Readonly<{
  protect(plaintextSha256: string): Promise<LibraryActionResult>;
  download(plaintextSha256: string): Promise<LibraryActionResult>;
  freeDeviceSpace(plaintextSha256: string): Promise<LibraryActionResult>;
  stopProtection(plaintextSha256: string): Promise<LibraryActionResult>;
  removeFromLibrary(plaintextSha256: string): Promise<LibraryActionResult>;
  availableActions(
    plaintextSha256: string,
  ): Promise<readonly LibraryActionKind[]>;
  /**
   * Enqueue and start draining without awaiting completion so the UI can call
   * `pauseBatch` mid-run. Returns a `running` (or empty `completed`) snapshot;
   * poll `batchProgress` for live totals and failures. If another unfinished
   * batch already exists for the current session `accountScope`, returns that
   * progress with `startRefused: 'busy'` and does not start a second drain.
   * Admission is atomic per scope (transactional recheck-then-insert).
   */
  startBatch(kind: LibraryBatchKind): Promise<LibraryBatchProgress>;
  pauseBatch(batchId: string): Promise<LibraryBatchProgress>;
  /** Fire-and-watch resume: returns a `running` snapshot; poll for completion. */
  resumeBatch(batchId: string): Promise<LibraryBatchProgress>;
  /** Fire-and-watch retry of failed items; returns a `running` snapshot. */
  retryFailedBatch(batchId: string): Promise<LibraryBatchProgress>;
  /**
   * Current-session scoped. Returns null when signed out, the id is missing,
   * or `account_scope` does not match the current session — never another
   * account's metadata. Facade resume/retry map null → `Unknown library batch`.
   */
  batchProgress(batchId: string): Promise<LibraryBatchProgress | null>;
  recoverBatches(): Promise<readonly LibraryBatchProgress[]>;
  /** Current session `accountScope`, or null when signed out / unusable. */
  getAccountScope(): Promise<string | null>;
  readMirrorCounts(): Promise<LibraryMirrorCounts>;
  /**
   * Board #12 (spec §4): count of protection rows halted with
   * `failure_category = 'quota_full'` for the current session's account
   * scope. The settings status line (Task 10b) surfaces this as "N uploads
   * are waiting: the cloud drive is full."
   */
  readQuotaFullCount(): Promise<number>;
  applySavePolicyAfterIngest(
    plaintextSha256: string,
  ): Promise<LibraryActionResult>;
  /**
   * One multi-device sync cycle. Direct-only; safe to call while signed out,
   * where it reports `skipped: 'no_account'` and touches nothing.
   */
  syncLibrary(): Promise<LibrarySyncReport>;
  /** SP9 trash-screen seam. Queues only; the next cycle sends it. */
  enqueueRestoreIntent(
    plaintextSha256: string,
  ): Promise<LibraryRestoreIntentResult>;
  /** Enqueue restore then run one sync cycle when queued|already-queued. */
  restoreFromTrash(
    plaintextSha256: string,
  ): Promise<LibraryRestoreIntentResult>;
  /** Enqueue permanent-delete then sync when queued|already-queued. */
  permanentlyDeleteFromTrash(
    plaintextSha256: string,
  ): Promise<LibraryPermanentDeleteIntentResult>;
  /** Session-gated empty-trash then one sync cycle. */
  emptyLibraryTrash(): Promise<
    | LibraryEmptyTrashResult
    | Readonly<{ status: 'not-applicable'; reason: 'no_account' }>
  >;
}>;

export type LibraryActionsServiceDependencies = Readonly<{
  protectAction: LibraryProtectAction;
  localActions: LibraryLocalActions;
  accountActions: LibraryAccountActions;
  trashActions: LibraryTrashActions;
  batches: LibraryBatchOrchestrator;
  session: LibrarySessionPort;
  sync: LibrarySyncController;
  /**
   * C4a: reads the mirror's durable counts for one account scope. A narrow
   * port rather than the protection repository, so the service keeps composing
   * action modules instead of gaining a second data-access surface.
   */
  readMirrorCounts: (accountScope: string) => Promise<LibraryMirrorCounts>;
  /**
   * Board #12: counts protection rows in one failure category for an account
   * scope. Mirrors `readMirrorCounts` as a narrow port so the service keeps
   * composing action modules instead of gaining a second data-access surface.
   */
  countFailureCategory: (
    accountScope: string,
    category: LibraryFailureCategory,
  ) => Promise<number>;
}>;

export function createLibraryActionsService({
  protectAction,
  localActions,
  accountActions,
  trashActions,
  batches,
  session,
  sync,
  readMirrorCounts,
  countFailureCategory,
}: LibraryActionsServiceDependencies): LibraryActionsController {
  /**
   * Task 10's `start`/`resume`/`retryFailed` await the full drain. The Direct
   * UI must be able to call `pause` while items are still running, so the
   * facade enqueues (or requeues) and fires the drain without awaiting it.
   */
  const watchDrain = (
    work: Promise<LibraryBatchProgress>,
  ): void => {
    void work.catch(() => undefined);
  };

  return {
    protect: (digest) => protectAction.protect(digest),
    download: (digest) => localActions.download(digest),
    freeDeviceSpace: (digest) => localActions.freeDeviceSpace(digest),
    stopProtection: (digest) => accountActions.stopProtection(digest),
    removeFromLibrary: (digest) => accountActions.removeFromLibrary(digest),
    availableActions: (digest) => localActions.availableActions(digest),
    async startBatch(kind) {
      const enqueued = await batches.startPaused(kind);
      // Single-open rule: startPaused returns the existing unfinished batch
      // with `startRefused: 'busy'` and must not kick off a drain/resume.
      if (
        enqueued.startRefused === 'busy'
        || enqueued.total === 0
        || enqueued.batchId.length === 0
      ) {
        return enqueued;
      }
      watchDrain(batches.resume(enqueued.batchId));
      return { ...enqueued, state: 'running' };
    },
    pauseBatch: (batchId) => batches.pause(batchId),
    async resumeBatch(batchId) {
      // Scoped `progress` returns null for foreign/missing ids before any
      // metadata is copied into the fire-and-watch snapshot.
      const current = await batches.progress(batchId);
      if (current === null) {
        throw new Error(`Unknown library batch ${batchId}.`);
      }
      if (current.pending === 0 && current.failed === 0) {
        return current;
      }
      watchDrain(batches.resume(batchId));
      return { ...current, state: 'running', pausedCategory: null };
    },
    async retryFailedBatch(batchId) {
      const current = await batches.progress(batchId);
      if (current === null) {
        throw new Error(`Unknown library batch ${batchId}.`);
      }
      watchDrain(batches.retryFailed(batchId));
      return {
        ...current,
        state: 'running',
        failed: 0,
        pending: current.pending + current.failed,
        failures: [],
        pausedCategory: null,
      };
    },
    batchProgress: (batchId) => batches.progress(batchId),
    recoverBatches: () => batches.recover(),
    async getAccountScope() {
      const context = await session.current();
      return context?.accountScope ?? null;
    },
    async readMirrorCounts() {
      const context = await session.current();
      const accountScope = context?.accountScope ?? null;
      // Signed out or locked is a fact — nothing is mirrored — never an
      // exception that would blank the settings screen.
      if (accountScope === null) {
        return {
          backedUp: 0,
          backedUpTotal: 0,
          downloaded: 0,
          downloadedTotal: 0,
          inCloud: 0,
          inCloudBytes: 0,
          pending: 0,
          totalBytes: 0,
        };
      }
      return readMirrorCounts(accountScope);
    },
    async readQuotaFullCount() {
      const context = await session.current();
      const accountScope = context?.accountScope ?? null;
      // Signed out or locked is a fact — nothing is halted — never an
      // exception that would blank the settings screen.
      if (accountScope === null) {
        return 0;
      }
      return countFailureCategory(accountScope, 'quota_full');
    },
    applySavePolicyAfterIngest: (digest) =>
      protectAction.applySavePolicyAfterIngest(digest),
    syncLibrary: () => sync.sync(),
    enqueueRestoreIntent: (digest) => sync.enqueueRestoreIntent(digest),
    restoreFromTrash: (digest) => trashActions.restore(digest),
    permanentlyDeleteFromTrash: (digest) => trashActions.permanentDelete(digest),
    emptyLibraryTrash: () => trashActions.emptyTrash(),
  };
}
