import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

async function migrated(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

describe('schema v13', () => {
  it('adds exported_at on library_device_asset_state at v13', async () => {
    const { native, database } = await migrated();
    expect(DATABASE_VERSION).toBeGreaterThanOrEqual(13);
    const cols = await database.getAll<{ name: string }>(
      'PRAGMA table_info(library_device_asset_state)',
    );
    expect(cols.map((c) => c.name)).toContain('exported_at');
    const row = await database.getFirst<{ user_version: number }>(
      'PRAGMA user_version',
    );
    expect(row?.user_version).toBe(DATABASE_VERSION);
    native.close();
  });

  it('adds exported_at when upgrading from v12', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    native.exec('PRAGMA user_version = 0');
    await migrateDatabase(database);
    // Simulate a v12 database that already has device state rows.
    native.exec('PRAGMA user_version = 12');
    const digest = 'a'.repeat(64);
    await database.run(
      `INSERT INTO library_device_asset_state (
         plaintext_sha256, cached_roles_json, last_verified_at,
         device_trash_uri, device_trashed_at, updated_at
       ) VALUES (?, '[]', NULL, NULL, NULL, 1)`,
      [digest],
    );
    await migrateDatabase(database);

    const cols = await database.getAll<{ name: string }>(
      'PRAGMA table_info(library_device_asset_state)',
    );
    expect(cols.map((c) => c.name)).toContain('exported_at');
    const row = await database.getFirst<{ exported_at: number | null }>(
      'SELECT exported_at FROM library_device_asset_state WHERE plaintext_sha256 = ?',
      [digest],
    );
    expect(row?.exported_at ?? null).toBeNull();
    native.close();
  });
});
