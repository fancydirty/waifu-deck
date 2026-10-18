import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryActionIntent,
  LibraryFailureCategory,
} from '@/features/library/library-actions-types';
import type { LibraryCollectMetadata } from '@/features/library/library-types';

/** Every kind the v9 `library_outbox` CHECK constraint already admits. */
export type LibrarySyncOutboxKind =
  | 'collect'
  | 'protect'
  | 'trash'
  | 'restore'
  | 'stop-protection'
  | 'permanent-delete';

export type LibrarySyncOutboxRow = Readonly<{
  mutationId: string;
  accountScope: string;
  /** Never rewritten by SP8. Stored by the device that created the intent. */
  deviceId: string;
  assetId: string;
  kind: LibrarySyncOutboxKind;
  baseRevision: number | null;
  observedGeneration: number | null;
  state: 'pending' | 'sending' | 'sent' | 'failed';
  attemptCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  /** `LibraryCollectMetadata` for `collect`, `LibraryActionIntent` otherwise. */
  payloadJson: string;
  createdAt: number;
  updatedAt: number;
}>;

export type LibrarySyncOutboxEnqueue = Readonly<{
  accountScope: string;
  deviceId: string;
  assetId: string;
  kind: Exclude<LibrarySyncOutboxKind, 'collect'>;
  baseRevision: number | null;
  observedGeneration: number | null;
  payload: LibraryActionIntent;
}>;

export type LibrarySyncOutbox = Readonly<{
  enqueue(input: LibrarySyncOutboxEnqueue): Promise<Readonly<{
    status: 'queued' | 'already-queued';
    mutationId: string;
  }>>;
  /** Every kind, oldest first, so a `collect` precedes its own `protect`. */
  listAll(accountScope: string): Promise<readonly LibrarySyncOutboxRow[]>;
  /**
   * Submission candidates: everything that is not `sent` and not halted.
   *
   * K7 ⑬: there is no second condition. This used to also hide any row whose
   * `next_attempt_at` was still in the future — a 30 s → 1 h exponential
   * backoff aimed at the user's OWN single-tenant bucket, which nothing is
   * competing for. The loop is event-driven (a save, a foreground, a
   * reconnect, a session), so "try again on the next round" already IS the
   * retry schedule, and a stored wait only added dead time to a delete or a
   * restore the user had already asked for. The column is left unread so a
   * row an older build pushed an hour out is due immediately after upgrade.
   */
  listDue(accountScope: string): Promise<readonly LibrarySyncOutboxRow[]>;
  /** Rows dispatched whose outcome was never learned. Never discarded. */
  listUnknownOutcome(
    accountScope: string,
  ): Promise<readonly LibrarySyncOutboxRow[]>;
  find(
    accountScope: string,
    assetId: string,
    kind: LibrarySyncOutboxKind,
  ): Promise<LibrarySyncOutboxRow | null>;
  /**
   * Re-points a queued row at fresh authoritative values and clears its error
   * so `stale_client` is released. A `sending` row is refused: its dispatched
   * values must stay byte-stable so a replay returns the stored result.
   */
  rebase(
    mutationId: string,
    baseRevision: number | null,
    observedGeneration: number | null,
  ): Promise<boolean>;
  /** Called **before** the POST, so a process death lands in `sending`. */
  markDispatched(mutationIds: readonly string[]): Promise<void>;
  /**
   * Dispatched, outcome unknown: stays `sending` with its stable id.
   *
   * K7 ⑬: takes no retry time. The row is due on the next round (see
   * `listDue`), and any wait an older build stored is cleared.
   */
  markUnknownOutcome(
    mutationId: string,
    category: LibraryFailureCategory,
  ): Promise<void>;
  /**
   * A *known* refusal: it leaves `sending`, so eviction guards unblock. Takes
   * no retry time either, for the same reason as `markUnknownOutcome`.
   */
  markFailed(
    mutationId: string,
    category: LibraryFailureCategory,
  ): Promise<void>;
  /** A known committed outcome; the projection now holds the truth. */
  markCommitted(mutationId: string): Promise<void>;
  /** A terminal refusal that can never succeed (tombstone, trash-wins). */
  discard(mutationId: string): Promise<void>;
}>;

export type LibrarySyncOutboxDependencies = Readonly<{
  database: SqlDatabasePort;
  newMutationId: () => string;
  clock?: () => number;
}>;

/**
 * Design § Error And Retry Policy: these stop retrying until state changes or
 * the user acts. Everything else is simply due again on the next round (K7
 * ⑬ — see `listDue`); this list is the only reason a row is ever held back.
 */
export const LIBRARY_SYNC_HALTING_ERROR_CODES: readonly LibraryFailureCategory[] = [
  'auth_attention',
  'unsupported_image',
  'integrity',
  'quota_full',
];

export function isHaltingErrorCode(code: string | null): boolean {
  return code !== null
    && (LIBRARY_SYNC_HALTING_ERROR_CODES as readonly string[]).includes(code);
}

export function collectMetadataOf(
  row: LibrarySyncOutboxRow,
): LibraryCollectMetadata {
  return JSON.parse(row.payloadJson) as LibraryCollectMetadata;
}

export function actionIntentOf(
  row: LibrarySyncOutboxRow,
): LibraryActionIntent {
  return JSON.parse(row.payloadJson) as LibraryActionIntent;
}

const SELECT_COLUMNS = `
  mutation_id, account_scope, device_id, asset_id, kind, base_revision,
  observed_generation, state, attempt_count, next_attempt_at, last_error_code,
  local_metadata_json, created_at, updated_at
`;

type OutboxRow = {
  mutation_id: string;
  account_scope: string;
  device_id: string;
  asset_id: string;
  kind: string;
  base_revision: number | null;
  observed_generation: number | null;
  state: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  local_metadata_json: string;
  created_at: number;
  updated_at: number;
};

function toRow(row: OutboxRow): LibrarySyncOutboxRow {
  return {
    mutationId: row.mutation_id,
    accountScope: row.account_scope,
    deviceId: row.device_id,
    assetId: row.asset_id,
    kind: row.kind as LibrarySyncOutboxKind,
    baseRevision: row.base_revision,
    observedGeneration: row.observed_generation,
    state: row.state as LibrarySyncOutboxRow['state'],
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    payloadJson: row.local_metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const HALTING_PLACEHOLDERS = LIBRARY_SYNC_HALTING_ERROR_CODES
  .map(() => '?')
  .join(', ');

/**
 * SP8's reader/writer for the whole `library_outbox`. SP6 owns `collect`
 * creation and SP7 owns per-action enqueue; this module is the single place
 * that decides what is submitted, when, and what happens to the row afterwards.
 */
export function createLibrarySyncOutbox({
  database,
  newMutationId,
  clock = Date.now,
}: LibrarySyncOutboxDependencies): LibrarySyncOutbox {
  const remove = async (mutationId: string): Promise<void> => {
    await database.run('DELETE FROM library_outbox WHERE mutation_id = ?', [
      mutationId,
    ]);
  };

  return {
    async enqueue(input) {
      const at = clock();
      const mutationId = newMutationId();
      const result = await database.run(
        `INSERT INTO library_outbox (
           mutation_id, account_scope, device_id, asset_id, kind, base_revision,
           observed_generation, state, attempt_count, next_attempt_at,
           last_error_code, local_metadata_json, encrypted_payload,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL, ?, ?)
         ON CONFLICT(account_scope, kind, asset_id) DO NOTHING`,
        [
          mutationId,
          input.accountScope,
          input.deviceId,
          input.assetId,
          input.kind,
          input.baseRevision,
          input.observedGeneration,
          JSON.stringify(input.payload),
          at,
          at,
        ],
      );
      if (result.changes === 1) return { status: 'queued', mutationId };
      const existing = await database.getFirst<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ? AND asset_id = ? AND kind = ?`,
        [input.accountScope, input.assetId, input.kind],
      );
      return {
        status: 'already-queued',
        mutationId: existing?.mutation_id ?? mutationId,
      };
    },

    async listAll(accountScope) {
      const rows = await database.getAll<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ?
          ORDER BY created_at ASC, mutation_id ASC`,
        [accountScope],
      );
      return rows.map(toRow);
    },

    async listDue(accountScope) {
      // A `sending` row is exempt from the halting filter: its outcome is
      // unknown and only a replay can resolve it. This is not a hot loop —
      // the caller runs a round on a real event, never on a timer (K7 ①/⑬).
      const rows = await database.getAll<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ?
            AND state <> 'sent'
            AND (
              state = 'sending'
              OR last_error_code IS NULL
              OR last_error_code NOT IN (${HALTING_PLACEHOLDERS})
            )
          ORDER BY created_at ASC, mutation_id ASC`,
        [accountScope, ...LIBRARY_SYNC_HALTING_ERROR_CODES],
      );
      return rows.map(toRow);
    },

    async listUnknownOutcome(accountScope) {
      const rows = await database.getAll<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ? AND state = 'sending'
          ORDER BY created_at ASC, mutation_id ASC`,
        [accountScope],
      );
      return rows.map(toRow);
    },

    async find(accountScope, assetId, kind) {
      const row = await database.getFirst<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ? AND asset_id = ? AND kind = ?`,
        [accountScope, assetId, kind],
      );
      return row === null ? null : toRow(row);
    },

    async rebase(mutationId, baseRevision, observedGeneration) {
      const at = clock();
      const result = await database.run(
        `UPDATE library_outbox
            SET base_revision = ?, observed_generation = ?, state = 'pending',
                last_error_code = NULL, next_attempt_at = NULL, updated_at = ?
          WHERE mutation_id = ? AND state <> 'sending'`,
        [baseRevision, observedGeneration, at, mutationId],
      );
      return result.changes === 1;
    },

    async markDispatched(mutationIds) {
      if (mutationIds.length === 0) return;
      const at = clock();
      const placeholders = mutationIds.map(() => '?').join(', ');
      await database.run(
        `UPDATE library_outbox
            SET state = 'sending', attempt_count = attempt_count + 1,
                updated_at = ?
          WHERE mutation_id IN (${placeholders})`,
        [at, ...mutationIds],
      );
    },

    async markUnknownOutcome(mutationId, category) {
      const at = clock();
      // The attempt was already counted by markDispatched. The row keeps its
      // stable mutationId so re-submitting replays the stored result.
      // `next_attempt_at` is written NULL rather than left alone so a value an
      // older build stored can never outlive the backoff itself (K7 ⑬).
      await database.run(
        `UPDATE library_outbox
            SET state = 'sending', last_error_code = ?, next_attempt_at = NULL,
                updated_at = ?
          WHERE mutation_id = ?`,
        [category, at, mutationId],
      );
    },

    async markFailed(mutationId, category) {
      const at = clock();
      // Deliberately allowed to clear `sending`: the caller only reaches here
      // with a refusal or a 4xx, which proves nothing was applied. Same
      // `next_attempt_at = NULL` rule as above.
      await database.run(
        `UPDATE library_outbox
            SET state = 'failed', last_error_code = ?, next_attempt_at = NULL,
                updated_at = ?
          WHERE mutation_id = ?`,
        [category, at, mutationId],
      );
    },

    markCommitted: remove,
    discard: remove,
  };
}
