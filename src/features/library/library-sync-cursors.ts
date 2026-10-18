import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibrarySyncCursor } from '@/features/library/library-sync-types';

/**
 * BYOS has no server-side change cursor: every cycle rediscovers change by
 * listing `assets/` and reconciling per-asset state (protocol spec, "变更发现").
 * So `library_sync_state` is logically retired to a single watermark —
 * `last_synced_at`, "when this device last completed a reconcile" (P3C
 * decision #19).
 *
 * `change_cursor`, `min_base_cursor`, `latest_revision`, and `resync_pending`
 * are physically retained and semantically dead: written once as defaults on
 * insert, never read, never updated. No schema migration is introduced for a
 * pure subtraction; dropping the columns is left to the P6 sweep.
 */
const COLUMNS = `
  account_scope, change_cursor, min_base_cursor, latest_revision,
  resync_pending, last_synced_at, updated_at
`;

type CursorRow = {
  account_scope: string;
  last_synced_at: number | null;
  updated_at: number;
};

export type LibrarySyncCursorStore = Readonly<{
  /** Never null: an unknown scope reads as a never-synced watermark. */
  read(accountScope: string): Promise<LibrarySyncCursor>;
  /**
   * Records that this device just completed a full reconcile. An UPSERT, not
   * an UPDATE: the retired `write()` was the only path that ever inserted a
   * row, so without the insert half here a first-ever cycle would update zero
   * rows and the watermark would never persist.
   */
  markSynced(accountScope: string): Promise<void>;
}>;

export type LibrarySyncCursorStoreDependencies = Readonly<{
  database: SqlDatabasePort;
  clock?: () => number;
}>;

export function zeroedLibrarySyncCursor(
  accountScope: string,
): LibrarySyncCursor {
  return { accountScope, lastSyncedAt: null, updatedAt: 0 };
}

export function createLibrarySyncCursorStore({
  database,
  clock = Date.now,
}: LibrarySyncCursorStoreDependencies): LibrarySyncCursorStore {
  return {
    async read(accountScope) {
      const row = await database.getFirst<CursorRow>(
        `SELECT account_scope, last_synced_at, updated_at
           FROM library_sync_state WHERE account_scope = ?`,
        [accountScope],
      );
      return row === null
        ? zeroedLibrarySyncCursor(accountScope)
        : {
            accountScope: row.account_scope,
            lastSyncedAt: row.last_synced_at,
            updatedAt: row.updated_at,
          };
    },

    async markSynced(accountScope) {
      const at = clock();
      await database.run(
        `INSERT INTO library_sync_state (${COLUMNS})
         VALUES (?, 0, 0, 0, 0, ?, ?)
         ON CONFLICT(account_scope) DO UPDATE SET
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
        [accountScope, at, at],
      );
    },
  };
}
