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

const insert = (
  database: SqlDatabasePort,
  over: Partial<{
    scope: string;
    key: string;
    etag: string;
    recordJson: string;
  }> = {},
) => database.run(
  `INSERT INTO library_remote_state_cache (
     account_scope, key, etag, record_json, updated_at
   ) VALUES (?, ?, ?, ?, 1)`,
  [
    over.scope ?? 'scope-a',
    over.key ?? 'waifu-deck/assets/a1/state.json',
    over.etag ?? '"etag-a1"',
    over.recordJson ?? '{"assetId":"a1"}',
  ],
);

describe('schema v18 — library_remote_state_cache', () => {
  test('the table exists and the object key is its primary key', async () => {
    const { native, database } = await migrated();
    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(18);
      await expect(insert(database)).resolves.toBeDefined();
      // One row per object key: a second write for the same key must conflict,
      // which is what makes the repository's UPSERT the only update path.
      await expect(insert(database, { etag: '"etag-a1-2"' })).rejects.toThrow();
    } finally {
      native.close();
    }
  });

  test('rows are scope-indexed so a prewarm reads one vault, not every vault', async () => {
    const { native, database } = await migrated();
    try {
      const indexes = await database.getAll<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'library_remote_state_cache'
            AND sql IS NOT NULL`,
      );
      expect(indexes.map((row) => row.name))
        .toEqual(['library_remote_state_cache_scope']);
    } finally {
      native.close();
    }
  });

  test('an empty etag is refused: it proves nothing about freshness', async () => {
    const { native, database } = await migrated();
    try {
      // The port evicts rather than caches when a backend omits the header
      // (`remember`); the CHECK makes that invariant unbreakable at rest, so a
      // persisted row can never suppress a real read.
      await expect(insert(database, { etag: '' })).rejects.toThrow();
      await expect(insert(database, { scope: '' })).rejects.toThrow();
    } finally {
      native.close();
    }
  });

  test('two vaults cache the same asset id independently', async () => {
    const { native, database } = await migrated();
    try {
      await insert(database, { scope: 'scope-a', key: 'a/assets/x/state.json' });
      await insert(database, { scope: 'scope-b', key: 'b/assets/x/state.json' });
      await expect(database.getAll<{ account_scope: string }>(
        'SELECT account_scope FROM library_remote_state_cache ORDER BY account_scope',
      )).resolves.toEqual([
        { account_scope: 'scope-a' },
        { account_scope: 'scope-b' },
      ]);
    } finally {
      native.close();
    }
  });

  test('re-running the ladder is idempotent and keeps existing rows', async () => {
    const { native, database } = await migrated();
    try {
      await insert(database);
      await expect(migrateDatabase(database)).resolves.toBeUndefined();
      await expect(database.getFirst<{ n: number }>(
        'SELECT COUNT(*) AS n FROM library_remote_state_cache',
      )).resolves.toEqual({ n: 1 });
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
    } finally {
      native.close();
    }
  });
});
