import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-A';
const DIGEST = 'a'.repeat(64);
const BATCH = '00000000-0000-4000-8000-000000000001';

async function migrated(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

describe('schema v14', () => {
  it('reports the current schema version after the ladder runs', async () => {
    const { native, database } = await migrated();
    expect(DATABASE_VERSION).toBeGreaterThanOrEqual(14);
    const row = await database.getFirst<{ user_version: number }>(
      'PRAGMA user_version',
    );
    expect(row?.user_version).toBe(DATABASE_VERSION);
    native.close();
  });

  it('admits empty-trash in library_batch_operations and still rejects unknown kinds', async () => {
    const { native, database } = await migrated();
    const insert = (kind: string, batchId: string) => database.run(
      `INSERT INTO library_batch_operations (
         batch_id, account_scope, kind, state, created_at, updated_at
       ) VALUES (?, ?, ?, 'paused', 1, 1)`,
      [batchId, SCOPE, kind],
    );
    await expect(insert('empty-trash', BATCH)).resolves.toBeDefined();
    await expect(
      insert('nonsense', '99999999-0000-4000-8000-000000000002'),
    ).rejects.toThrow();
    native.close();
  });

  it('preserves every v13 batch operation and its items across the rebuild', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    // This does NOT seed genuinely v13-shaped tables: the first
    // migrateDatabase call already runs the full ladder, so
    // library_batch_operations/items already have v14 shape by the time the
    // pragma below is rewound. Rewinding only `user_version` to 13 makes the
    // second migrateDatabase call (below) replay the v14 rebuild step
    // against already-v14 tables -- still a real exercise of the
    // rename/copy/drop/rename path and the library_batch_items backup +
    // restore, proving the rebuild is data-preserving and idempotent, not a
    // migration from a true pre-v14 column set.
    native.exec('PRAGMA user_version = 0');
    await migrateDatabase(database);
    native.exec('PRAGMA user_version = 13');
    await database.run(
      `INSERT INTO library_batch_operations (
         batch_id, account_scope, kind, state, created_at, updated_at
       ) VALUES (?, ?, 'protect-all', 'paused', 100, 200)`,
      [BATCH, SCOPE],
    );
    await database.run(
      `INSERT INTO library_batch_items (
         batch_id, plaintext_sha256, position, state, failure_category,
         updated_at
       ) VALUES (?, ?, 0, 'pending', NULL, 300)`,
      [BATCH, DIGEST],
    );
    native.exec('PRAGMA user_version = 13');
    await migrateDatabase(database);

    const operation = await database.getFirst<{
      batch_id: string;
      account_scope: string;
      kind: string;
      state: string;
      created_at: number;
      updated_at: number;
    }>('SELECT * FROM library_batch_operations WHERE batch_id = ?', [BATCH]);
    expect(operation).toEqual({
      batch_id: BATCH,
      account_scope: SCOPE,
      kind: 'protect-all',
      state: 'paused',
      created_at: 100,
      updated_at: 200,
    });

    const item = await database.getFirst<{
      batch_id: string;
      plaintext_sha256: string;
      position: number;
      state: string;
      failure_category: string | null;
      updated_at: number;
    }>(
      'SELECT * FROM library_batch_items WHERE batch_id = ? AND plaintext_sha256 = ?',
      [BATCH, DIGEST],
    );
    expect(item).toEqual({
      batch_id: BATCH,
      plaintext_sha256: DIGEST,
      position: 0,
      state: 'pending',
      failure_category: null,
      updated_at: 300,
    });

    // The FK cascade still works post-rebuild: deleting the operation clears
    // its item, proving library_batch_items still references the renamed
    // table rather than a stale/orphaned one.
    await database.run(
      'DELETE FROM library_batch_operations WHERE batch_id = ?',
      [BATCH],
    );
    expect(
      await database.getAll('SELECT batch_id FROM library_batch_items'),
    ).toEqual([]);

    const indexes = await database.getAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'library_batch_operations'",
    );
    expect(indexes.map((index) => index.name)).toContain(
      'library_batch_operations_open',
    );
    native.close();
  });
});
