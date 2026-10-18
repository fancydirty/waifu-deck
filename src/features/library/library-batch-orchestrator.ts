import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryActionResult,
  LibraryBatchFailure,
  LibraryBatchKind,
  LibraryBatchProgress,
  LibraryBatchState,
  LibraryFailureCategory,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';

export type LibraryBatchRunner = Readonly<{
  protect(plaintextSha256: string): Promise<LibraryActionResult>;
  download(plaintextSha256: string): Promise<LibraryActionResult>;
  freeDeviceSpace(plaintextSha256: string): Promise<LibraryActionResult>;
  permanentDelete(plaintextSha256: string): Promise<LibraryActionResult>;
}>;

export type LibraryBatchOrchestrator = Readonly<{
  start(kind: LibraryBatchKind): Promise<LibraryBatchProgress>;
  /** Enqueue the itemized work without running it; used by tests and resume. */
  startPaused(kind: LibraryBatchKind): Promise<LibraryBatchProgress>;
  pause(batchId: string): Promise<LibraryBatchProgress>;
  resume(batchId: string): Promise<LibraryBatchProgress>;
  retryFailed(batchId: string): Promise<LibraryBatchProgress>;
  /**
   * Current-session scoped. Returns null when signed out, missing, or the
   * row's `account_scope` does not match — never foreign metadata.
   */
  progress(batchId: string): Promise<LibraryBatchProgress | null>;
  recover(): Promise<readonly LibraryBatchProgress[]>;
}>;

export type LibraryBatchOrchestratorDependencies = Readonly<{
  protection: LibraryProtectionRepository;
  session: LibrarySessionPort;
  runner: LibraryBatchRunner;
  database: SqlDatabasePort;
  newBatchId: () => string;
  clock?: () => number;
}>;

/** Design § Error And Retry Policy: these stop the queue until state changes. */
const HALTING_CATEGORIES: readonly LibraryFailureCategory[] = [
  'auth_attention',
  'quota_full',
];

const EMPTY_PROGRESS = (kind: LibraryBatchKind): LibraryBatchProgress => ({
  batchId: '',
  kind,
  state: 'completed',
  total: 0,
  done: 0,
  failed: 0,
  pending: 0,
  pausedCategory: null,
  failures: [],
});

export function createLibraryBatchOrchestrator({
  protection,
  session,
  runner,
  database,
  newBatchId,
  clock = Date.now,
}: LibraryBatchOrchestratorDependencies): LibraryBatchOrchestrator {
  let pauseRequested = new Set<string>();

  /**
   * Build progress for a batch only when its durable `account_scope` equals
   * `requiredScope`. Used by public session-scoped reads and by drain when it
   * must return the owning account's snapshot after a live session switch
   * (public `readProgress` would be null under B).
   */
  const loadProgressForScope = async (
    batchId: string,
    requiredScope: string,
  ): Promise<LibraryBatchProgress | null> => {
    const operation = await database.getFirst<{
      batch_id: string;
      kind: string;
      state: string;
      account_scope: string;
    }>(
      `SELECT batch_id, kind, state, account_scope
         FROM library_batch_operations WHERE batch_id = ?`,
      [batchId],
    );
    if (operation === null) return null;
    if (operation.account_scope !== requiredScope) return null;
    const items = await database.getAll<{
      plaintext_sha256: string;
      state: string;
      failure_category: string | null;
    }>(
      `SELECT plaintext_sha256, state, failure_category FROM library_batch_items
        WHERE batch_id = ? ORDER BY position ASC`,
      [batchId],
    );
    const failures: LibraryBatchFailure[] = items
      .filter((item) => item.state === 'failed')
      .map((item) => ({
        plaintextSha256: item.plaintext_sha256,
        category: (item.failure_category ?? 'retryable_transfer') as LibraryFailureCategory,
      }));
    const haltingFailure = failures.find((failure) =>
      HALTING_CATEGORIES.includes(failure.category));
    return {
      batchId,
      kind: operation.kind as LibraryBatchKind,
      state: operation.state as LibraryBatchState,
      total: items.length,
      done: items.filter((item) => item.state === 'done').length,
      failed: failures.length,
      pending: items.filter(
        (item) => item.state === 'pending' || item.state === 'running',
      ).length,
      pausedCategory: operation.state === 'paused'
        ? (haltingFailure?.category ?? null)
        : null,
      failures,
    };
  };

  const readProgress = async (
    batchId: string,
  ): Promise<LibraryBatchProgress | null> => {
    // Public progress is current-session scoped. Missing row, signed-out, and
    // foreign-scope `batch_id` all return `null` so pollers and facade
    // resume/retry pre-reads cannot leak another account's item/failure
    // metadata. Mutating ops map that null to `Unknown library batch` via
    // `requireOwnedBatch` (same throw surface as a missing id).
    const context = await session.current();
    if (context === null) return null;
    return loadProgressForScope(batchId, context.accountScope);
  };

  const setState = async (
    batchId: string,
    state: LibraryBatchState,
  ): Promise<void> => {
    await database.run(
      'UPDATE library_batch_operations SET state = ?, updated_at = ? WHERE batch_id = ?',
      [state, clock(), batchId],
    );
  };

  const candidatesFor = async (
    kind: LibraryBatchKind,
    accountScope: string,
  ): Promise<readonly string[]> => {
    if (kind === 'protect-all') {
      return protection.listProtectCandidates(accountScope);
    }
    if (kind === 'download-all') {
      return protection.listDownloadCandidates(accountScope);
    }
    if (kind === 'empty-trash') {
      return protection.listTrashCandidates(accountScope);
    }
    return protection.listFreeCandidates(accountScope);
  };

  const performFor = (
    kind: LibraryBatchKind,
  ): ((plaintextSha256: string) => Promise<LibraryActionResult>) => {
    if (kind === 'protect-all') return runner.protect;
    if (kind === 'download-all') return runner.download;
    if (kind === 'empty-trash') return runner.permanentDelete;
    return runner.freeDeviceSpace;
  };

  const findOpenBatch = async (
    accountScope: string,
  ): Promise<LibraryBatchProgress | null> => {
    // Single open unfinished batch **per account scope**: `running` or
    // `paused` (manual or auto quota/auth pause). `completed` is the only
    // terminal state. Other accounts' unfinished rows are invisible here.
    const row = await database.getFirst<{ batch_id: string }>(
      `SELECT batch_id FROM library_batch_operations
        WHERE account_scope = ? AND state <> 'completed'
        ORDER BY created_at ASC LIMIT 1`,
      [accountScope],
    );
    if (row === null) return null;
    return readProgress(row.batch_id);
  };

  /**
   * Refuse pause/resume/retry on a batch that does not belong to the current
   * session scope (same surface as a missing id — no cross-account leak).
   * Ownership is enforced by scoped `readProgress` (null → throw).
   */
  const requireOwnedBatch = async (
    batchId: string,
  ): Promise<LibraryBatchProgress> => {
    const current = await readProgress(batchId);
    if (current === null) {
      throw new Error(`Unknown library batch ${batchId}.`);
    }
    return current;
  };

  const enqueue = async (
    kind: LibraryBatchKind,
  ): Promise<LibraryBatchProgress> => {
    // Resolve the current session scope *before* any open-batch guard so a
    // signed-out device and account B never consult account A's unfinished
    // rows.
    const context = await session.current();
    if (context === null) return EMPTY_PROGRESS(kind);
    const candidates = await candidatesFor(kind, context.accountScope);
    const batchId = newBatchId();
    const at = clock();
    // Atomic admission within this account scope: exclusive/IMMEDIATE
    // transaction rechecks open rows then inserts only if none. Candidate
    // selection and progress reads stay outside so they never nest behind
    // the open write lock. Empty candidate sets still recheck so a zero-
    // candidate kind cannot bypass an unfinished open batch for this scope.
    // No UNIQUE partial on open state — pre-existing plurality within one
    // scope must stay recoverable.
    const admission = await database.transaction(async (transaction) => {
      const openRow = await transaction.getFirst<{ batch_id: string }>(
        `SELECT batch_id FROM library_batch_operations
          WHERE account_scope = ? AND state <> 'completed'
          ORDER BY created_at ASC LIMIT 1`,
        [context.accountScope],
      );
      if (openRow !== null) {
        return { outcome: 'busy' as const, batchId: openRow.batch_id };
      }
      if (candidates.length === 0) {
        return { outcome: 'empty' as const };
      }
      await transaction.run(
        `INSERT INTO library_batch_operations (
           batch_id, account_scope, kind, state, created_at, updated_at
         ) VALUES (?, ?, ?, 'paused', ?, ?)`,
        [batchId, context.accountScope, kind, at, at],
      );
      let position = 0;
      for (const plaintextSha256 of candidates) {
        await transaction.run(
          `INSERT INTO library_batch_items (
             batch_id, plaintext_sha256, position, state, failure_category,
             updated_at
           ) VALUES (?, ?, ?, 'pending', NULL, ?)`,
          [batchId, plaintextSha256, position, at],
        );
        position += 1;
      }
      return { outcome: 'created' as const, batchId };
    });
    if (admission.outcome === 'busy') {
      const refused = (await readProgress(admission.batchId))
        ?? (await findOpenBatch(context.accountScope));
      if (refused === null) return EMPTY_PROGRESS(kind);
      return { ...refused, startRefused: 'busy' };
    }
    if (admission.outcome === 'empty') {
      return EMPTY_PROGRESS(kind);
    }
    return (await readProgress(admission.batchId))!;
  };

  const drain = async (batchId: string): Promise<LibraryBatchProgress> => {
    // Pin ownership from the durable row at drain start. Live session alone is
    // not enough: each later item must re-check against this same stored scope
    // so a mid-drain A→B switch cannot run A's remaining digests through B.
    const pinned = await database.getFirst<{
      account_scope: string;
      kind: string;
    }>(
      `SELECT account_scope, kind FROM library_batch_operations WHERE batch_id = ?`,
      [batchId],
    );
    if (pinned === null) {
      throw new Error(`Unknown library batch ${batchId}.`);
    }
    const owningScope = pinned.account_scope;

    const sessionOwnsPinnedScope = async (): Promise<boolean> => {
      const context = await session.current();
      return context !== null && context.accountScope === owningScope;
    };

    // Refuse to start drain under a foreign or signed-out session even when
    // the batch id is known (same surface as a missing id for callers).
    if (!(await sessionOwnsPinnedScope())) {
      throw new Error(`Unknown library batch ${batchId}.`);
    }

    const ownedSnapshot = async (): Promise<LibraryBatchProgress> => {
      const snapshot = await loadProgressForScope(batchId, owningScope);
      if (snapshot === null) {
        throw new Error(`Unknown library batch ${batchId}.`);
      }
      return snapshot;
    };

    const pauseOwned = async (): Promise<LibraryBatchProgress> => {
      await setState(batchId, 'paused');
      return ownedSnapshot();
    };

    const perform = performFor(pinned.kind as LibraryBatchKind);
    await setState(batchId, 'running');
    for (;;) {
      if (pauseRequested.has(batchId)) {
        pauseRequested.delete(batchId);
        return pauseOwned();
      }
      // Re-validate before selecting the next item.
      if (!(await sessionOwnsPinnedScope())) {
        return pauseOwned();
      }
      const item = await database.getFirst<{ plaintext_sha256: string }>(
        `SELECT plaintext_sha256 FROM library_batch_items
          WHERE batch_id = ? AND state = 'pending'
          ORDER BY position ASC LIMIT 1`,
        [batchId],
      );
      if (item === null) break;
      const digest = item.plaintext_sha256;
      await database.run(
        `UPDATE library_batch_items SET state = 'running', updated_at = ?
          WHERE batch_id = ? AND plaintext_sha256 = ?`,
        [clock(), batchId, digest],
      );
      // Re-validate immediately before perform so a switch after mark-running
      // cannot execute cloud/local work under B. Reset the item to pending so
      // A's recover/resume sees unfinished work, not a stuck running row.
      if (!(await sessionOwnsPinnedScope())) {
        await database.run(
          `UPDATE library_batch_items
              SET state = 'pending', updated_at = ?
            WHERE batch_id = ? AND plaintext_sha256 = ? AND state = 'running'`,
          [clock(), batchId, digest],
        );
        return pauseOwned();
      }
      let result: LibraryActionResult;
      try {
        result = await perform(digest);
      } catch {
        result = { status: 'blocked', category: 'retryable_transfer' };
      }
      // Every asset commits independently; a failure never rolls back the
      // items that already succeeded.
      if (result.status === 'applied' || result.status === 'noop') {
        await database.run(
          `UPDATE library_batch_items
              SET state = 'done', failure_category = NULL, updated_at = ?
            WHERE batch_id = ? AND plaintext_sha256 = ?`,
          [clock(), batchId, digest],
        );
        continue;
      }
      await database.run(
        `UPDATE library_batch_items
            SET state = 'failed', failure_category = ?, updated_at = ?
          WHERE batch_id = ? AND plaintext_sha256 = ?`,
        [result.category, clock(), batchId, digest],
      );
      if (HALTING_CATEGORIES.includes(result.category)) {
        // Do not loop through the whole library while quota or authentication
        // makes progress impossible.
        return pauseOwned();
      }
    }
    await setState(batchId, 'completed');
    return ownedSnapshot();
  };

  return {
    async start(kind) {
      const enqueued = await enqueue(kind);
      if (enqueued.startRefused === 'busy' || enqueued.total === 0) {
        return enqueued;
      }
      return drain(enqueued.batchId);
    },

    startPaused: enqueue,

    async pause(batchId) {
      await requireOwnedBatch(batchId);
      pauseRequested.add(batchId);
      return (await readProgress(batchId))!;
    },

    async resume(batchId) {
      const current = await requireOwnedBatch(batchId);
      if (current.pending === 0) {
        await setState(batchId, 'completed');
        return (await readProgress(batchId))!;
      }
      return drain(batchId);
    },

    async retryFailed(batchId) {
      await requireOwnedBatch(batchId);
      const at = clock();
      await database.run(
        `UPDATE library_batch_items
            SET state = 'pending', failure_category = NULL, updated_at = ?
          WHERE batch_id = ? AND state = 'failed'`,
        [at, batchId],
      );
      return drain(batchId);
    },

    progress: readProgress,

    async recover() {
      // A process death leaves `running` rows behind. They are retryable work,
      // not failures, and the batch stays paused until the user resumes it.
      // Returns only unfinished batches for the **current session account
      // scope**, oldest-`created_at` first, so a pre-existing plurality within
      // that scope stays reachable and another account's unfinished rows are
      // never shown, blocking, or executable. `start` / `startPaused` refuse
      // new work for this scope while any of these remain open.
      const context = await session.current();
      if (context === null) return [];
      const at = clock();
      await database.run(
        `UPDATE library_batch_items SET state = 'pending', updated_at = ?
          WHERE state = 'running'
            AND batch_id IN (
              SELECT batch_id FROM library_batch_operations
               WHERE account_scope = ?
            )`,
        [at, context.accountScope],
      );
      await database.run(
        `UPDATE library_batch_operations SET state = 'paused', updated_at = ?
          WHERE account_scope = ? AND state = 'running'`,
        [at, context.accountScope],
      );
      pauseRequested = new Set();
      const open = await database.getAll<{ batch_id: string }>(
        `SELECT batch_id FROM library_batch_operations
          WHERE account_scope = ? AND state <> 'completed'
          ORDER BY created_at ASC`,
        [context.accountScope],
      );
      const progresses: LibraryBatchProgress[] = [];
      for (const row of open) {
        const current = await readProgress(row.batch_id);
        if (current !== null) progresses.push(current);
      }
      return progresses;
    },
  };
}
