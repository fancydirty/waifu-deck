import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

type ColumnRow = { name: string; notnull: number; dflt_value: string | null };

async function migrated() {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

describe('schema v10', () => {
  it('reaches at least version 10 after the ladder runs', async () => {
    const { native, database } = await migrated();
    const row = await database.getFirst<{ user_version: number }>(
      'PRAGMA user_version',
    );
    expect(DATABASE_VERSION).toBeGreaterThanOrEqual(10);
    expect(row?.user_version).toBe(DATABASE_VERSION);
    native.close();
  });

  it('creates the save-policy singleton with the free-safe default', async () => {
    const { native, database } = await migrated();
    const rows = await database.getAll<{ id: number; save_policy: string; updated_at: number }>(
      'SELECT id, save_policy, updated_at FROM library_device_settings',
    );
    expect(rows).toEqual([
      { id: 1, save_policy: 'this-device-only', updated_at: 0 },
    ]);
    native.close();
  });

  it('rejects an unknown save policy and a second settings row', async () => {
    const { native, database } = await migrated();
    await expect(
      database.run(
        'UPDATE library_device_settings SET save_policy = ? WHERE id = 1',
        ['everywhere'],
      ),
    ).rejects.toThrow();
    await expect(
      database.run(
        `INSERT INTO library_device_settings (id, save_policy, updated_at)
         VALUES (2, 'cloud-only', 1)`,
      ),
    ).rejects.toThrow();
    native.close();
  });

  it('creates protection, device-state, and batch tables with their constraints', async () => {
    const { native, database } = await migrated();
    for (const table of [
      'library_asset_protection',
      'library_device_asset_state',
      'library_batch_operations',
      'library_batch_items',
    ]) {
      const columns = await database.getAll<ColumnRow>(
        `PRAGMA table_info(${table})`,
      );
      expect(columns.length).toBeGreaterThan(0);
    }
    await expect(
      database.run(
        `INSERT INTO library_asset_protection (
           account_scope, asset_id, plaintext_sha256, lifecycle, protection,
           generation, revision, original_generation_id,
           original_ciphertext_bytes, verified_at, failure_category,
           trashed_at, updated_at
         ) VALUES ('scope', ?, ?, 'exploded', 'unprotected', 1, NULL, NULL,
           NULL, NULL, NULL, NULL, 1)`,
        ['a'.repeat(64), 'b'.repeat(64)],
      ),
    ).rejects.toThrow();
    native.close();
  });

  it('cascades batch items when their operation is deleted', async () => {
    const { native, database } = await migrated();
    await database.run(
      `INSERT INTO library_batch_operations (
         batch_id, account_scope, kind, state, created_at, updated_at
       ) VALUES (?, 'scope', 'protect-all', 'running', 1, 1)`,
      ['00000000-0000-4000-8000-000000000001'],
    );
    await database.run(
      `INSERT INTO library_batch_items (
         batch_id, plaintext_sha256, position, state, failure_category, updated_at
       ) VALUES (?, ?, 0, 'pending', NULL, 1)`,
      ['00000000-0000-4000-8000-000000000001', 'c'.repeat(64)],
    );
    await database.run('DELETE FROM library_batch_operations WHERE batch_id = ?', [
      '00000000-0000-4000-8000-000000000001',
    ]);
    const items = await database.getAll('SELECT batch_id FROM library_batch_items');
    expect(items).toEqual([]);
    native.close();
  });

  it('recomputes protect eligibility against the library envelope overhead', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    await database.exec('PRAGMA user_version = 0');
    await migrateDatabase(database);
    // Simulate a v9 row that was flagged eligible under the old 36-byte rule.
    const overLimit = LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES + 1;
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, created_at, updated_at
       ) VALUES (?, 'jpeg', 'jpg', ?, 10, 10, 'import', NULL,
         'file:///data/library/originals/d.jpg', 'local-original', 1, NULL, 1, 1)`,
      ['d'.repeat(64), overLimit],
    );
    await database.exec('PRAGMA user_version = 9');
    await migrateDatabase(database);
    const row = await database.getFirst<{ protect_eligible: number }>(
      'SELECT protect_eligible FROM device_library_assets WHERE plaintext_sha256 = ?',
      ['d'.repeat(64)],
    );
    expect(row?.protect_eligible).toBe(0);
    expect(LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES).toBe(64 * 1024 * 1024 - 96);
    native.close();
  });
});
