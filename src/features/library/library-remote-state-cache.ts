import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import {
  decodeAssetState,
  encodeAssetState,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';

/**
 * The durable half of BYOS change discovery's ETag index (K7 cut 3).
 *
 * `library-reconciliation-port.ts` diffs the listing's per-key ETag against
 * what it last read, and GETs only the keys that differ. Keeping that index in
 * an in-process Map made every cold start re-read the entire bucket. This
 * repository is the same index at rest, keyed by the full object key, so a
 * launch over an unchanged library costs one LIST and nothing else.
 *
 * An ETag is a server-side content hash: a stored (key, etag, record) triple
 * cannot be stale while the listing still reports that ETag, which is why the
 * decoded record is stored alongside it rather than only the ETag.
 */
export type LibraryRemoteStateCacheRow = Readonly<{
  /** Full object key, e.g. `waifu-deck/assets/<assetId>/state.json`. */
  key: string;
  /** The ETag of the bytes `record` was decoded from. Never empty. */
  etag: string;
  record: LibraryAssetStateRecord;
}>;

export type LibraryRemoteStateCacheRepository = Readonly<{
  /** Every indexed key for one vault, for the port's startup prewarm. */
  getAll(accountScope: string): Promise<readonly LibraryRemoteStateCacheRow[]>;
  /** Records freshly read states. Replaces any row at the same key. */
  upsertMany(
    accountScope: string,
    rows: readonly LibraryRemoteStateCacheRow[],
  ): Promise<void>;
  /** Drops every indexed key of this scope that the listing no longer reports. */
  deleteMissing(
    accountScope: string,
    presentKeys: readonly string[],
  ): Promise<void>;
  /** Drops named keys: a GET that found nothing, or a state read that did. */
  deleteKeys(accountScope: string, keys: readonly string[]): Promise<void>;
  /** Forgets one vault's whole index (disconnect / remove device data). */
  deleteAll(accountScope: string): Promise<void>;
}>;

/**
 * The scope-free face `library-reconciliation-port.ts` holds. The port knows a
 * bucket prefix, not an account scope — the scope is the session's, resolved
 * per call because a vault can be disconnected and replaced while the port
 * instance lives on. Binding it here keeps the port free of a session
 * dependency and keeps the scope with the one production source that owns it
 * (`library-session-port.ts`, pinned by `single-account-scope-source.test.ts`).
 */
export type LibraryRemoteStateIndex = Readonly<{
  getAll(): Promise<readonly LibraryRemoteStateCacheRow[]>;
  upsertMany(rows: readonly LibraryRemoteStateCacheRow[]): Promise<void>;
  deleteMissing(presentKeys: readonly string[]): Promise<void>;
  deleteKeys(keys: readonly string[]): Promise<void>;
}>;

/**
 * Binds a repository to whichever account scope the session currently reports.
 *
 * `readAccountScope` resolving to `null` means "no vault right now": every
 * operation becomes a no-op and `getAll` reads empty, so a port built before a
 * vault exists neither reads nor writes another vault's index.
 */
export function bindLibraryRemoteStateIndex(
  repository: LibraryRemoteStateCacheRepository,
  readAccountScope: () => Promise<string | null>,
): LibraryRemoteStateIndex {
  return {
    async getAll() {
      const scope = await readAccountScope();
      return scope === null ? [] : await repository.getAll(scope);
    },
    async upsertMany(rows) {
      if (rows.length === 0) return;
      const scope = await readAccountScope();
      if (scope !== null) await repository.upsertMany(scope, rows);
    },
    async deleteMissing(presentKeys) {
      const scope = await readAccountScope();
      if (scope !== null) await repository.deleteMissing(scope, presentKeys);
    },
    async deleteKeys(keys) {
      if (keys.length === 0) return;
      const scope = await readAccountScope();
      if (scope !== null) await repository.deleteKeys(scope, keys);
    },
  };
}

export type LibraryRemoteStateCacheDependencies = Readonly<{
  database: SqlDatabasePort;
  clock?: () => number;
}>;

/**
 * Both writes bind one parameter set per row, and a library is unbounded in
 * principle, so neither statement is allowed to grow with the library: SQLite
 * refuses a statement past `SQLITE_MAX_VARIABLE_NUMBER` (32766 in the version
 * expo-sqlite bundles, 999 in older builds) and that ceiling must not become
 * a library-size limit. 400 rows is two statements for the measured 450-asset
 * library and stays safe under either ceiling.
 */
const MAX_BOUND_KEYS = 400;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function createLibraryRemoteStateCacheRepository({
  database,
  clock = Date.now,
}: LibraryRemoteStateCacheDependencies): LibraryRemoteStateCacheRepository {
  async function deleteKeys(
    accountScope: string,
    keys: readonly string[],
  ): Promise<void> {
    if (keys.length === 0) return;
    await database.transaction(async (transaction) => {
      for (const batch of chunk(keys, MAX_BOUND_KEYS)) {
        await transaction.run(
          `DELETE FROM library_remote_state_cache
            WHERE account_scope = ? AND key IN (${batch.map(() => '?').join(', ')})`,
          [accountScope, ...batch],
        );
      }
    });
  }

  return {
    async getAll(accountScope) {
      const rows = await database.getAll<{
        key: string;
        etag: string;
        record_json: string;
      }>(
        `SELECT key, etag, record_json FROM library_remote_state_cache
          WHERE account_scope = ?`,
        [accountScope],
      );
      const decoded: LibraryRemoteStateCacheRow[] = [];
      for (const row of rows) {
        let record: LibraryAssetStateRecord;
        try {
          record = decodeAssetState(encoder.encode(row.record_json));
        } catch {
          // Corrupt at rest. Dropping it from the prewarm costs one GET for
          // that key and is the only safe reading: a row that cannot be
          // decoded must never be served as a cache hit, and a throw here
          // would turn one bad row into a sync that can never start.
          continue;
        }
        decoded.push({ key: row.key, etag: row.etag, record });
      }
      return decoded;
    },

    async upsertMany(accountScope, rows) {
      if (rows.length === 0) return;
      const at = clock();
      await database.transaction(async (transaction) => {
        for (const batch of chunk(rows, MAX_BOUND_KEYS)) {
          const values = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
          const params: SqlBindValue[] = [];
          for (const row of batch) {
            params.push(
              accountScope,
              row.key,
              row.etag,
              decoder.decode(encodeAssetState(row.record)),
              at,
            );
          }
          await transaction.run(
            `INSERT INTO library_remote_state_cache (
               account_scope, key, etag, record_json, updated_at
             ) VALUES ${values}
             ON CONFLICT(key) DO UPDATE SET
               account_scope = excluded.account_scope,
               etag = excluded.etag,
               record_json = excluded.record_json,
               updated_at = excluded.updated_at`,
            params,
          );
        }
      });
    },

    async deleteMissing(accountScope, presentKeys) {
      if (presentKeys.length === 0) {
        await database.run(
          'DELETE FROM library_remote_state_cache WHERE account_scope = ?',
          [accountScope],
        );
        return;
      }
      // Deleting by the complement of a chunked IN list would delete the keys
      // of every other chunk, so the surviving set is computed first and the
      // deletes are issued by key.
      const present = new Set(presentKeys);
      const stored = await database.getAll<{ key: string }>(
        'SELECT key FROM library_remote_state_cache WHERE account_scope = ?',
        [accountScope],
      );
      const gone = stored
        .map((row) => row.key)
        .filter((key) => !present.has(key));
      await deleteKeys(accountScope, gone);
    },

    deleteKeys,

    async deleteAll(accountScope) {
      await database.run(
        'DELETE FROM library_remote_state_cache WHERE account_scope = ?',
        [accountScope],
      );
    },
  };
}
