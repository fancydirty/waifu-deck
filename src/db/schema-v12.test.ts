import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-A';
const DIGEST = 'a'.repeat(64);
const ASSET = 'b'.repeat(64);
const MUTATION = '11111111-2222-3333-4444-555555555555';

async function migrated(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

describe('schema v12', () => {
  it('reports the current schema version after the ladder runs', async () => {
    const { native, database } = await migrated();
    const row = await database.getFirst<{ user_version: number }>(
      'PRAGMA user_version',
    );
    expect(DATABASE_VERSION).toBeGreaterThanOrEqual(12);
    expect(row?.user_version).toBe(DATABASE_VERSION);
    native.close();
  });

  it('creates library_cache_entries with its guards and leaves it empty', async () => {
    const { native, database } = await migrated();
    const columns = await database.getAll<{ name: string }>(
      'PRAGMA table_info(library_cache_entries)',
    );
    expect(columns.map(({ name }) => name)).toEqual([
      'account_scope',
      'plaintext_sha256',
      'role',
      'uri',
      'byte_size',
      'generation_id',
      'created_at',
      'last_used_at',
    ]);
    await expect(
      database.getAll('SELECT account_scope FROM library_cache_entries'),
    ).resolves.toEqual([]);
    // `metadata` is not a cacheable role, and a zero-byte entry is meaningless.
    await expect(
      database.run(
        `INSERT INTO library_cache_entries (
           account_scope, plaintext_sha256, role, uri, byte_size,
           generation_id, created_at, last_used_at
         ) VALUES (?, ?, 'metadata', 'file:///c/x', 10, NULL, 1, 1)`,
        [SCOPE, DIGEST],
      ),
    ).rejects.toThrow();
    await expect(
      database.run(
        `INSERT INTO library_cache_entries (
           account_scope, plaintext_sha256, role, uri, byte_size,
           generation_id, created_at, last_used_at
         ) VALUES (?, ?, 'preview', 'file:///c/x', 0, NULL, 1, 1)`,
        [SCOPE, DIGEST],
      ),
    ).rejects.toThrow();
    native.close();
  });

  it('adds the derived object-reference columns as nullable', async () => {
    const { native, database } = await migrated();
    const columns = await database.getAll<{ name: string; dflt_value: unknown }>(
      'PRAGMA table_info(library_asset_protection)',
    );
    const byName = new Map(columns.map((column) => [column.name, column]));
    for (const name of [
      'thumbnail_generation_id',
      'preview_generation_id',
      'object_refs_revision',
    ]) {
      expect(byName.has(name)).toBe(true);
      expect(byName.get(name)?.dflt_value ?? null).toBeNull();
    }
    native.close();
  });

  it('admits permanent-delete in library_outbox and still rejects unknown kinds', async () => {
    const { native, database } = await migrated();
    const insert = (kind: string, mutationId: string) => database.run(
      `INSERT INTO library_outbox (
         mutation_id, account_scope, device_id, asset_id, kind, base_revision,
         observed_generation, state, attempt_count, next_attempt_at,
         last_error_code, local_metadata_json, encrypted_payload,
         created_at, updated_at
       ) VALUES (?, ?, 'device-1', ?, ?, NULL, NULL, 'pending', 0, NULL, NULL,
         '{}', NULL, 1, 1)`,
      [mutationId, SCOPE, ASSET, kind],
    );
    await expect(insert('permanent-delete', MUTATION)).resolves.toBeDefined();
    await expect(
      insert('nonsense', '99999999-2222-3333-4444-555555555555'),
    ).rejects.toThrow();
    native.close();
  });

  it('preserves every v11 outbox row, BLOB, and index across the rebuild', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    // Stop at v11, seed, then finish the ladder so the rebuild sees real rows.
    native.exec('PRAGMA user_version = 0');
    await migrateDatabase(database);
    native.exec('PRAGMA user_version = 11');
    await database.run('DELETE FROM library_outbox');
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await database.run(
      `INSERT INTO library_outbox (
         mutation_id, account_scope, device_id, asset_id, kind, base_revision,
         observed_generation, state, attempt_count, next_attempt_at,
         last_error_code, local_metadata_json, encrypted_payload,
         created_at, updated_at
       ) VALUES (?, ?, 'device-1', ?, 'protect', 7, 2, 'sending', 3, 900,
         'offline', '{"kind":"protect"}', ?, 100, 200)`,
      [MUTATION, SCOPE, ASSET, payload],
    );
    native.exec('PRAGMA user_version = 11');
    await migrateDatabase(database);

    const row = await database.getFirst<{
      mutation_id: string;
      kind: string;
      base_revision: number;
      observed_generation: number;
      state: string;
      attempt_count: number;
      next_attempt_at: number;
      last_error_code: string;
      local_metadata_json: string;
      encrypted_payload: Uint8Array;
      created_at: number;
      updated_at: number;
    }>('SELECT * FROM library_outbox WHERE mutation_id = ?', [MUTATION]);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe('protect');
    expect(row?.base_revision).toBe(7);
    expect(row?.observed_generation).toBe(2);
    expect(row?.state).toBe('sending');
    expect(row?.attempt_count).toBe(3);
    expect(row?.next_attempt_at).toBe(900);
    expect(row?.last_error_code).toBe('offline');
    expect(row?.local_metadata_json).toBe('{"kind":"protect"}');
    expect(row?.created_at).toBe(100);
    expect(row?.updated_at).toBe(200);
    expect([...(row?.encrypted_payload ?? [])]).toEqual([...payload]);

    const indexes = await database.getAll<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'library_outbox'",
    );
    const names = indexes.map((index) => index.name);
    expect(names).toContain('library_outbox_account_kind_asset');
    expect(names).toContain('library_outbox_ready');
    native.close();
  });
});
