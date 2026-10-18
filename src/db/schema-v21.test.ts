import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { seedDeviceLibraryAsset } from '@/features/library/library-view-test-support';
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

const columns = async (db: SqlDatabasePort) =>
  (
    await db.getAll<{ name: string }>(
      'PRAGMA table_info(device_library_assets)',
    )
  ).map(({ name }) => name);

/**
 * Board #27 S2 (spec §5.9): the durable thumbnail this device keeps, so 收藏
 * renders offline once an original has left the phone.
 */
describe('schema v21', () => {
  test('a fresh database is at v21 with local_thumbnail_uri', async () => {
    const { native, database } = await migrated();
    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(21);
      await expect(database.getFirst('PRAGMA user_version')).resolves.toEqual({
        user_version: DATABASE_VERSION,
      });
      expect(await columns(database)).toContain('local_thumbnail_uri');
    } finally {
      native.close();
    }
  });

  test('a v20 library migrates in place and reads no thumbnail', async () => {
    const { native, database } = await migrated();
    try {
      await database.exec(
        'ALTER TABLE device_library_assets DROP COLUMN local_thumbnail_uri; PRAGMA user_version = 20;',
      );
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: 'a'.repeat(64),
        localOriginalUri: 'file:///o/a.jpg',
      });
      await migrateDatabase(database);
      await expect(
        database.getAll(
          'SELECT local_original_uri, local_thumbnail_uri FROM device_library_assets',
        ),
      ).resolves.toEqual([
        { local_original_uri: 'file:///o/a.jpg', local_thumbnail_uri: null },
      ]);
      await expect(database.getFirst('PRAGMA user_version')).resolves.toEqual({
        user_version: DATABASE_VERSION,
      });
    } finally {
      native.close();
    }
  });

  test('re-running the step over a database that has the column is harmless', async () => {
    const { native, database } = await migrated();
    try {
      await database.exec('PRAGMA user_version = 20;');
      await expect(migrateDatabase(database)).resolves.toBeUndefined();
    } finally {
      native.close();
    }
  });
});
