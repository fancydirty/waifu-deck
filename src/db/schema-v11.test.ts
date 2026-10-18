import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-A';

async function migrated(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

describe('schema v11', () => {
  it('reports version 11 after the ladder runs', async () => {
    const { native, database } = await migrated();
    const row = await database.getFirst<{ user_version: number }>(
      'PRAGMA user_version',
    );
    expect(row?.user_version).toBe(DATABASE_VERSION);
    native.close();
  });

  it('creates library_sync_state with its guards and leaves it empty', async () => {
    const { native, database } = await migrated();
    const columns = await database.getAll<{ name: string }>(
      'PRAGMA table_info(library_sync_state)',
    );
    expect(columns.map(({ name }) => name)).toEqual([
      'account_scope',
      'change_cursor',
      'min_base_cursor',
      'latest_revision',
      'resync_pending',
      'last_synced_at',
      'updated_at',
    ]);
    await expect(
      database.getAll('SELECT account_scope FROM library_sync_state'),
    ).resolves.toEqual([]);
    await expect(
      database.run(
        `INSERT INTO library_sync_state (
           account_scope, change_cursor, min_base_cursor, latest_revision,
           resync_pending, last_synced_at, updated_at
         ) VALUES (?, -1, 0, 0, 0, NULL, 1)`,
        [SCOPE],
      ),
    ).rejects.toThrow();
    await expect(
      database.run(
        `INSERT INTO library_sync_state (
           account_scope, change_cursor, min_base_cursor, latest_revision,
           resync_pending, last_synced_at, updated_at
         ) VALUES (?, 0, 0, 0, 2, NULL, 1)`,
        [SCOPE],
      ),
    ).rejects.toThrow();
    native.close();
  });

  it('preserves the v10 tables and rows across the v10 → v11 step', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    await database.exec('PRAGMA user_version = 0');
    await migrateDatabase(database);
    await database.run(
      `INSERT INTO library_asset_protection (
         account_scope, asset_id, plaintext_sha256, lifecycle, protection,
         generation, revision, original_generation_id,
         original_ciphertext_bytes, verified_at, failure_category,
         trashed_at, updated_at
       ) VALUES (?, ?, ?, 'active', 'protected', 1, 5, NULL, NULL, 7, NULL,
         NULL, 7)`,
      [SCOPE, 'a'.repeat(64), 'b'.repeat(64)],
    );
    await database.exec('PRAGMA user_version = 10');
    await migrateDatabase(database);
    await expect(
      database.getFirst<{ revision: number; verified_at: number }>(
        `SELECT revision, verified_at FROM library_asset_protection
          WHERE account_scope = ?`,
        [SCOPE],
      ),
    ).resolves.toEqual({ revision: 5, verified_at: 7 });
    native.close();
  });
});
