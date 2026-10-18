import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryActionIntent,
  LibraryFailureCategory,
} from '@/features/library/library-actions-types';
import type { LibraryCollectMetadata } from '@/features/library/library-types';

export type LibraryActionOutboxKind =
  | 'protect'
  | 'trash'
  | 'stop-protection'
  | 'restore';

export type LibraryActionOutboxRow = Readonly<{
  mutationId: string;
  accountScope: string;
  deviceId: string;
  assetId: string;
  kind: LibraryActionOutboxKind;
  baseRevision: number | null;
  observedGeneration: number | null;
  state: 'pending' | 'sending' | 'sent' | 'failed';
  attemptCount: number;
  lastErrorCode: string | null;
  payload: LibraryActionIntent;
}>;

export type LibraryCollectIntent = Readonly<{
  mutationId: string;
  deviceId: string;
  assetId: string;
  metadata: LibraryCollectMetadata;
}>;

export type LibraryActionOutboxEnqueue = Readonly<{
  accountScope: string;
  deviceId: string;
  assetId: string;
  kind: LibraryActionOutboxKind;
  baseRevision: number | null;
  observedGeneration: number | null;
  payload: LibraryActionIntent;
}>;

export type LibraryActionOutbox = Readonly<{
  enqueue(input: LibraryActionOutboxEnqueue): Promise<Readonly<{
    status: 'queued' | 'already-queued';
    mutationId: string;
  }>>;
  list(accountScope: string): Promise<readonly LibraryActionOutboxRow[]>;
  find(
    accountScope: string,
    assetId: string,
    kind: LibraryActionOutboxKind,
  ): Promise<LibraryActionOutboxRow | null>;
  /** Only for a *known* committed outcome: this deletes the intent. */
  markSent(mutationId: string): Promise<void>;
  markFailed(
    mutationId: string,
    category: LibraryFailureCategory,
  ): Promise<void>;
  /** Dispatched, outcome never learned: keep the stable mutation for replay. */
  markOutcomeUnknown(
    mutationId: string,
    category: LibraryFailureCategory,
  ): Promise<void>;
  findCollectIntent(
    accountScope: string,
    assetId: string,
  ): Promise<LibraryCollectIntent | null>;
}>;

export type LibraryActionOutboxDependencies = Readonly<{
  database: SqlDatabasePort;
  newMutationId: () => string;
  clock?: () => number;
}>;

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
  last_error_code: string | null;
  local_metadata_json: string;
};

const SELECT_COLUMNS = `
  mutation_id, account_scope, device_id, asset_id, kind, base_revision,
  observed_generation, state, attempt_count, last_error_code, local_metadata_json
`;

/**
 * A `sending` row was dispatched to the Worker and never confirmed. It may
 * already have changed account state, so no local eviction may assume the
 * pre-request projection is still true.
 */
export function hasUnknownOutcome(
  row: LibraryActionOutboxRow | null,
): boolean {
  return row !== null && row.state === 'sending';
}

function toRow(row: OutboxRow): LibraryActionOutboxRow {
  return {
    mutationId: row.mutation_id,
    accountScope: row.account_scope,
    deviceId: row.device_id,
    assetId: row.asset_id,
    kind: row.kind as LibraryActionOutboxKind,
    baseRevision: row.base_revision,
    observedGeneration: row.observed_generation,
    state: row.state as LibraryActionOutboxRow['state'],
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    payload: JSON.parse(row.local_metadata_json) as LibraryActionIntent,
  };
}

/**
 * SP7's reader and writer for non-`collect` `library_outbox` rows. SP6's
 * `LibraryRepository.listOutbox` keeps owning `collect`; SP8 unifies the two.
 */
export function createLibraryActionOutbox({
  database,
  newMutationId,
  clock = Date.now,
}: LibraryActionOutboxDependencies): LibraryActionOutbox {
  const find: LibraryActionOutbox['find'] = async (
    accountScope,
    assetId,
    kind,
  ) => {
    const row = await database.getFirst<OutboxRow>(
      `SELECT ${SELECT_COLUMNS} FROM library_outbox
        WHERE account_scope = ? AND asset_id = ? AND kind = ?`,
      [accountScope, assetId, kind],
    );
    return row === null ? null : toRow(row);
  };

  return {
    async enqueue(input) {
      const at = clock();
      const mutationId = newMutationId();
      // The v9 UNIQUE(account_scope, kind, asset_id) index is the idempotency
      // guarantee: a repeated intent reuses the original stable mutationId.
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
      const existing = await find(
        input.accountScope,
        input.assetId,
        input.kind,
      );
      return {
        status: 'already-queued',
        mutationId: existing?.mutationId ?? mutationId,
      };
    },

    async list(accountScope) {
      const rows = await database.getAll<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ? AND kind <> 'collect'
          ORDER BY created_at ASC, mutation_id ASC`,
        [accountScope],
      );
      return rows.map(toRow);
    },

    find,

    async markSent(mutationId) {
      // A committed intent is removed: the authoritative state now lives in
      // `library_asset_protection`, so SP8 must not resubmit it. Callers may
      // only reach this after a *known* outcome; an unconfirmed dispatch uses
      // `markOutcomeUnknown` instead.
      await database.run(
        `DELETE FROM library_outbox WHERE mutation_id = ? AND kind <> 'collect'`,
        [mutationId],
      );
    },

    async markFailed(mutationId, category) {
      const at = clock();
      await database.run(
        `UPDATE library_outbox
            SET state = 'failed', attempt_count = attempt_count + 1,
                last_error_code = ?, updated_at = ?
          WHERE mutation_id = ? AND kind <> 'collect'`,
        [category, at, mutationId],
      );
    },

    async markOutcomeUnknown(mutationId, category) {
      const at = clock();
      // `sending` is the durable "dispatched, unconfirmed" state. The row keeps
      // its stable mutationId so re-submitting it replays the Worker's stored
      // terminal result instead of applying a second destructive mutation.
      await database.run(
        `UPDATE library_outbox
            SET state = 'sending', attempt_count = attempt_count + 1,
                last_error_code = ?, updated_at = ?
          WHERE mutation_id = ? AND kind <> 'collect'`,
        [category, at, mutationId],
      );
    },

    async findCollectIntent(accountScope, assetId) {
      const row = await database.getFirst<OutboxRow>(
        `SELECT ${SELECT_COLUMNS} FROM library_outbox
          WHERE account_scope = ? AND asset_id = ? AND kind = 'collect'`,
        [accountScope, assetId],
      );
      if (row === null) return null;
      return {
        mutationId: row.mutation_id,
        // Never rewritten: SP6 stored the registered device that created it.
        deviceId: row.device_id,
        assetId: row.asset_id,
        metadata: JSON.parse(row.local_metadata_json) as LibraryCollectMetadata,
      };
    },
  };
}
