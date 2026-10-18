import type { LibrarySessionPort } from '@/features/library/library-actions-types';
import type { LibraryBatchOrchestrator } from '@/features/library/library-batch-orchestrator';
import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import type {
  LibraryPermanentDeleteIntentResult,
  LibraryRestoreIntentResult,
} from '@/features/library/library-sync-types';

export type LibraryEmptyTrashResult = Readonly<{
  purged: number;
  failures: number;
  /** Items not yet purged or failed -- a halted/paused batch's remainder. */
  pending: number;
}>;

export type LibraryTrashActions = Readonly<{
  restore(plaintextSha256: string): Promise<LibraryRestoreIntentResult>;
  permanentDelete(
    plaintextSha256: string,
  ): Promise<LibraryPermanentDeleteIntentResult>;
  emptyTrash(): Promise<
    | LibraryEmptyTrashResult
    | Readonly<{ status: 'not-applicable'; reason: 'no_account' }>
  >;
}>;

export function createLibraryTrashActions(deps: {
  session: LibrarySessionPort;
  batches: Pick<LibraryBatchOrchestrator, 'start'>;
  sync: Pick<
    LibrarySyncController,
    'enqueueRestoreIntent' | 'enqueuePermanentDeleteIntent' | 'sync'
  >;
}): LibraryTrashActions {
  return {
    async restore(digest) {
      const queued = await deps.sync.enqueueRestoreIntent(digest);
      if (queued.status === 'queued' || queued.status === 'already-queued') {
        await deps.sync.sync();
      }
      return queued;
    },
    async permanentDelete(digest) {
      const queued = await deps.sync.enqueuePermanentDeleteIntent(digest);
      if (queued.status === 'queued' || queued.status === 'already-queued') {
        await deps.sync.sync();
      }
      return queued;
    },
    async emptyTrash() {
      const context = await deps.session.current();
      if (context === null) {
        return { status: 'not-applicable', reason: 'no_account' };
      }
      // Protocol spec § emptyTrash: no more single-RPC purge. Instead, one
      // permanent-delete outbox row is durably queued per trashed asset
      // through the existing batch machinery (`'empty-trash'` kind — see
      // library-batch-orchestrator.ts), then a single sync cycle sends
      // everything queued. `done`/`failed` are the orchestrator's per-item
      // enqueue outcome, not a cloud-commit confirmation: exactly the same
      // "queued, not yet confirmed" contract `permanentDelete` above already
      // returns for a single asset (its own `status: 'queued'`, never
      // `'purged'`). A batch that pauses partway (e.g. a lost session mid
      // drain) simply leaves its remaining items `pending` — neither purged
      // nor failed — and is resumable later; that resumption is P4/P3C-3's
      // concern, not this call's.
      const progress = await deps.batches.start('empty-trash');
      // `start` admits only one open batch per account scope. A busy refusal
      // hands back the pre-existing open batch's own progress with
      // `startRefused: 'busy'` set -- see LibraryBatchProgress.startRefused.
      // Key off that exact signal, not `kind`: a paused/halted *empty-trash*
      // batch already owning the scope also refuses (same `kind`), and
      // returning its stale counters as a fresh run would misreport e.g.
      // "purged 500" having purged nothing this call.
      if (progress.startRefused === 'busy') {
        throw new Error(
          'Cannot empty trash: another library batch is already in progress.',
        );
      }
      await deps.sync.sync();
      return {
        purged: progress.done,
        failures: progress.failed,
        pending: progress.total - progress.done - progress.failed,
      };
    },
  };
}
