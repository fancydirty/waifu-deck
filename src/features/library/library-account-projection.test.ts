import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  clearAccountProjection,
  forgetEveryAccount,
} from '@/features/library/library-account-projection';
import { createLibraryRemoteStateCacheRepository } from '@/features/library/library-remote-state-cache';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-clear';
const OTHER = 'scope-other';
const DIGEST = 'a'.repeat(64);
const ASSET = 'b'.repeat(64);
async function count(
  database: SqlDatabasePort,
  table: string,
  scope?: string,
): Promise<number> {
  if (scope === undefined) {
    const row = await database.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return row?.n ?? 0;
  }
  const row = await database.getFirst<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE account_scope = ?`,
    [scope],
  );
  return row?.n ?? 0;
}

async function harness(): Promise<{
  native: DatabaseSync;
  database: SqlDatabasePort;
}> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

/** 36-character ids, distinct per scope. The device row is not account-scoped. */
function id36(scope: string, kind: string): string {
  return `${kind}.${scope}`.replace(/[^a-z0-9]/gi, '').padEnd(36, '0').slice(0, 36);
}

async function seedEveryTable(
  database: SqlDatabasePort,
  scope: string,
): Promise<void> {
  await database.run(
    `INSERT OR IGNORE INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', 10, 4, 4, 'import', NULL,
       'file:///data/library/originals/a.jpg', 'local-original', 1, NULL, 5, 5)`,
    [DIGEST],
  );
  await database.run(
    `INSERT OR IGNORE INTO library_device_asset_state (
       plaintext_sha256, cached_roles_json, last_verified_at,
       device_trash_uri, device_trashed_at, updated_at
     ) VALUES (?, '[]', NULL, NULL, NULL, 5)`,
    [DIGEST],
  );
  await database.run(
    `INSERT INTO library_account_assets (
       account_scope, asset_id, plaintext_sha256, device_id,
       enrolled_at, updated_at
     ) VALUES (?, ?, ?, 'device-1', 5, 5)`,
    [scope, ASSET, DIGEST],
  );
  await database.run(
    `INSERT INTO library_asset_protection (
       account_scope, asset_id, plaintext_sha256, lifecycle, protection,
       generation, revision, original_generation_id, original_ciphertext_bytes,
       verified_at, failure_category, trashed_at, updated_at
     ) VALUES (?, ?, ?, 'active', 'unprotected', 0, NULL, NULL, NULL,
       NULL, NULL, NULL, 5)`,
    [scope, ASSET, DIGEST],
  );
  await database.run(
    `INSERT INTO library_outbox (
       mutation_id, account_scope, device_id, asset_id, kind, base_revision,
       observed_generation, state, attempt_count, next_attempt_at,
       last_error_code, local_metadata_json, encrypted_payload,
       created_at, updated_at
     ) VALUES (?, ?, 'device-1', ?, 'protect', NULL, NULL, 'pending', 0, NULL,
       NULL, '{}', NULL, 5, 5)`,
    [id36(scope, 'mutation'), scope, ASSET],
  );
  await database.run(
    `INSERT INTO library_sync_state (
       account_scope, change_cursor, min_base_cursor, latest_revision,
       resync_pending, last_synced_at, updated_at
     ) VALUES (?, 1, 0, 1, 0, 5, 5)`,
    [scope],
  );
  await database.run(
    `INSERT INTO library_batch_operations (
       batch_id, account_scope, kind, state, created_at, updated_at
     ) VALUES (?, ?, 'protect-all', 'paused', 5, 5)`,
    [id36(scope, 'batch'), scope],
  );
  await database.run(
    `INSERT INTO library_batch_items (
       batch_id, plaintext_sha256, position, state, failure_category, updated_at
     ) VALUES (?, ?, 0, 'pending', NULL, 5)`,
    [id36(scope, 'batch'), DIGEST],
  );
  await database.run(
    `INSERT INTO library_cache_entries (
       account_scope, plaintext_sha256, role, uri, byte_size,
       generation_id, created_at, last_used_at
     ) VALUES (?, ?, 'thumbnail', 'file:///cache/a', 4, NULL, 5, 5)`,
    [scope, DIGEST],
  );
}

/** One remote-state row, the same shape as the scope-clear index test. */
async function seedIndexOnly(
  database: SqlDatabasePort,
  scope: string,
): Promise<void> {
  const cache = createLibraryRemoteStateCacheRepository({ database });
  const record = {
    assetId: ASSET,
    revision: 1,
    generation: 1,
    lifecycle: 'active' as const,
    protection: 'unprotected' as const,
    lastMutationId: null,
    trashedAt: null,
    generations: {},
  };
  await cache.upsertMany(scope, [
    { key: `${scope}/assets/${ASSET}/state.json`, etag: '"e1"', record },
  ]);
}

describe('clearAccountProjection', () => {
  it('deletes account-scoped projection rows and keeps device_library_assets', async () => {
    const { native, database } = await harness();
    await seedEveryTable(database, SCOPE);
    // Sibling scope must survive.
    await database.run(
      `INSERT INTO library_sync_state (
         account_scope, change_cursor, min_base_cursor, latest_revision,
         resync_pending, last_synced_at, updated_at
       ) VALUES (?, 9, 0, 9, 0, 5, 5)`,
      [OTHER],
    );

    await clearAccountProjection(database, SCOPE);

    expect(await count(database, 'device_library_assets')).toBe(1);
    expect(await count(database, 'library_device_asset_state')).toBe(1);
    expect(await count(database, 'library_account_assets')).toBe(0);
    expect(await count(database, 'library_asset_protection')).toBe(0);
    expect(await count(database, 'library_outbox')).toBe(0);
    expect(await count(database, 'library_sync_state', SCOPE)).toBe(0);
    expect(await count(database, 'library_sync_state', OTHER)).toBe(1);
    expect(await count(database, 'library_batch_operations')).toBe(0);
    expect(await count(database, 'library_batch_items')).toBe(0);
    expect(await count(database, 'library_cache_entries')).toBe(0);
    native.close();
  });

  it('drops this scope’s remote-state index and leaves the sibling scope’s alone', async () => {
    const { native, database } = await harness();
    const cache = createLibraryRemoteStateCacheRepository({ database });
    const record = {
      assetId: ASSET,
      revision: 1,
      generation: 1,
      lifecycle: 'active' as const,
      protection: 'unprotected' as const,
      lastMutationId: null,
      trashedAt: null,
      generations: {},
    };
    await cache.upsertMany(SCOPE, [
      { key: `waifu/assets/${ASSET}/state.json`, etag: '"e1"', record },
      { key: `waifu/assets/${DIGEST}/state.json`, etag: '"e2"', record },
    ]);
    await cache.upsertMany(OTHER, [
      { key: `other/assets/${ASSET}/state.json`, etag: '"e3"', record },
    ]);

    await clearAccountProjection(database, SCOPE);

    // K7 cut 3: the engine now projects only what the ETag diff says changed.
    // An index that outlived the projection it describes would report "nothing
    // changed" over a library this device no longer has rows for, and nothing
    // would ever rebuild them. Clearing both together is what keeps the next
    // cycle a full pass.
    expect(await count(database, 'library_remote_state_cache', SCOPE)).toBe(0);
    expect(await count(database, 'library_remote_state_cache', OTHER)).toBe(1);
    native.close();
  });
});

describe('forgetEveryAccount', () => {
  it('forgetEveryAccount forgets every scope, an index-only one included, and keeps device rows', async () => {
    const { native, database } = await harness();
    await seedEveryTable(database, SCOPE);
    await seedEveryTable(database, OTHER);
    await seedIndexOnly(database, 'scope-index-only');

    await forgetEveryAccount(database);

    for (const table of [
      'library_batch_items',
      'library_batch_operations',
      'library_outbox',
      'library_asset_protection',
      'library_account_assets',
      'library_sync_state',
      'library_cache_entries',
      'library_remote_state_cache',
    ]) {
      expect(await count(database, table)).toBe(0);
    }
    expect(await count(database, 'device_library_assets')).toBe(1);
    native.close();
  });
});
