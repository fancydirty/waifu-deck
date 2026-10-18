import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

async function createVersionEightSchema(database: SqlDatabasePort): Promise<void> {
  await database.exec(`
    CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_key TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      canonical_source_key TEXT,
      perceptual_hash TEXT,
      remote_url TEXT NOT NULL,
      source_url TEXT,
      artist_name TEXT,
      artist_url TEXT,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      byte_size INTEGER NOT NULL,
      extension TEXT NOT NULL,
      dominant_color TEXT NOT NULL,
      is_nsfw INTEGER NOT NULL CHECK (is_nsfw IN (0, 1)),
      is_animated INTEGER NOT NULL CHECK (is_animated IN (0, 1)),
      tags_json TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('queued', 'active', 'dismissed', 'saved')),
      presented_at INTEGER,
      decided_at INTEGER,
      queue_ordinal INTEGER NOT NULL,
      decision_ordinal INTEGER,
      local_uri TEXT,
      download_state TEXT NOT NULL CHECK (download_state IN ('none', 'pending', 'ready', 'failed')),
      download_error TEXT,
      content_rating TEXT NOT NULL DEFAULT 'safe'
        CHECK (content_rating IN (
          'safe', 'suggestive', 'nsfw_unspecified', 'explicit', 'unknown'
        )),
      native_rating TEXT,
      taste_signal TEXT CHECK (taste_signal IN ('saved', 'dismissed')),
      taste_recorded_at INTEGER
    );

    CREATE UNIQUE INDEX images_provider_identity
      ON images(provider_key, provider_item_id);
    CREATE INDEX images_decision_decided_at
      ON images(decision, decided_at DESC);
    CREATE INDEX images_download_state
      ON images(download_state);
    CREATE INDEX images_queue_ordinal
      ON images(queue_ordinal);

    PRAGMA user_version = 8;
  `);
}

async function tableNames(database: SqlDatabasePort): Promise<string[]> {
  const rows = await database.getAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map(({ name }) => name);
}

describe('database schema version 9', () => {
  test('exposes version 9 tables after the ladder migrates a fresh database idempotently', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(9);
      await migrateDatabase(database);
      await migrateDatabase(database);

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      const names = await tableNames(database);
      expect(names).toContain('device_library_assets');
      expect(names).toContain('library_account_assets');
      expect(names).toContain('library_outbox');
      expect(names).toContain('images');
    } finally {
      nativeDatabase.close();
    }
  });

  test('upgrades a real version 8 install without touching saved images', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);

    try {
      await createVersionEightSchema(database);
      await database.run(
        `INSERT INTO images (
          id, provider_key, provider_item_id, canonical_source_key, perceptual_hash,
          remote_url, source_url, artist_name, artist_url, width, height, byte_size,
          extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
          presented_at, decided_at, queue_ordinal, decision_ordinal, local_uri,
          download_state, download_error, content_rating, native_rating,
          taste_signal, taste_recorded_at
        ) VALUES (
          7, 'waifu_im', '7', NULL, NULL,
          'https://example.com/7.jpg', NULL, NULL, NULL, 100, 200, 1234,
          'jpg', '#112233', 0, 0, '[]', 'saved',
          1, 2, 1, 1, 'file:///collection/7.jpg',
          'ready', NULL, 'safe', NULL, 'saved', 2
        )`,
      );

      await migrateDatabase(database);

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      await expect(
        database.getFirst<{ id: number; local_uri: string; decision: string }>(
          'SELECT id, local_uri, decision FROM images WHERE id = 7',
        ),
      ).resolves.toEqual({
        id: 7,
        local_uri: 'file:///collection/7.jpg',
        decision: 'saved',
      });
      await expect(
        database.getAll<{ count: number }>(
          'SELECT COUNT(*) AS count FROM device_library_assets',
        ),
      ).resolves.toEqual([{ count: 0 }]);
      await expect(
        database.getAll<{ count: number }>(
          'SELECT COUNT(*) AS count FROM library_account_assets',
        ),
      ).resolves.toEqual([{ count: 0 }]);
      await expect(
        database.getAll<{ count: number }>(
          'SELECT COUNT(*) AS count FROM library_outbox',
        ),
      ).resolves.toEqual([{ count: 0 }]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('stores a local asset row with no account columns at all', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);
    const digest = 'b'.repeat(64);

    try {
      await migrateDatabase(database);
      // Layer A: a signed-out device must be able to store this row.
      await database.run(
        `INSERT INTO device_library_assets (
          plaintext_sha256, format, canonical_extension, byte_size, width,
          height, origin, source_image_id, local_original_uri, residency,
          protect_eligible, missing_original_since, created_at, updated_at
        ) VALUES (?, 'jpeg', 'jpg', 10, 320, 240, 'import', NULL,
          'file:///library/originals/${'b'.repeat(64)}.jpg',
          'local-original', 1, NULL, 1, 1)`,
        [digest],
      );

      const columns = await database.getAll<{ name: string }>(
        "SELECT name FROM pragma_table_info('device_library_assets')",
      );
      const columnNames = columns.map(({ name }) => name);
      expect(columnNames).not.toContain('asset_id');
      expect(columnNames).not.toContain('account_scope');

      // One local row per distinct plaintext on the device.
      await expect(database.run(
        `INSERT INTO device_library_assets (
          plaintext_sha256, format, canonical_extension, byte_size, width,
          height, origin, source_image_id, local_original_uri, residency,
          protect_eligible, missing_original_since, created_at, updated_at
        ) VALUES (?, 'png', 'png', 10, 320, 240, 'import', NULL, NULL,
          'local-original', 1, NULL, 2, 2)`,
        [digest],
      )).rejects.toThrow();

      await expect(database.run(
        `INSERT INTO device_library_assets (
          plaintext_sha256, format, canonical_extension, byte_size, width,
          height, origin, source_image_id, local_original_uri, residency,
          protect_eligible, missing_original_since, created_at, updated_at
        ) VALUES (?, 'tiff', 'jpg', 10, 320, 240, 'import', NULL, NULL,
          'local-original', 1, NULL, 1, 1)`,
        ['d'.repeat(64)],
      )).rejects.toThrow();
    } finally {
      nativeDatabase.close();
    }
  });

  test('enforces the account asset and outbox constraints, including device_id', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(nativeDatabase);
    const assetId = 'a'.repeat(64);
    const otherAssetId = 'c'.repeat(64);
    const digest = 'b'.repeat(64);
    const deviceId = 'device-1';

    try {
      await migrateDatabase(database);
      await database.run(
        `INSERT INTO library_account_assets (
          account_scope, asset_id, plaintext_sha256, device_id,
          enrolled_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 1)`,
        ['scope-1', assetId, digest, deviceId],
      );

      // One account row per (scope, plaintext): re-enrolling is idempotent.
      await expect(database.run(
        `INSERT INTO library_account_assets (
          account_scope, asset_id, plaintext_sha256, device_id,
          enrolled_at, updated_at
        ) VALUES (?, ?, ?, ?, 2, 2)`,
        ['scope-1', otherAssetId, digest, deviceId],
      )).rejects.toThrow();

      // A second account on the same device keeps its own keyed identity.
      await database.run(
        `INSERT INTO library_account_assets (
          account_scope, asset_id, plaintext_sha256, device_id,
          enrolled_at, updated_at
        ) VALUES (?, ?, ?, ?, 3, 3)`,
        ['scope-2', otherAssetId, digest, deviceId],
      );

      await expect(database.run(
        `INSERT INTO library_account_assets (
          account_scope, asset_id, plaintext_sha256, device_id,
          enrolled_at, updated_at
        ) VALUES (?, ?, ?, '', 4, 4)`,
        ['scope-3', 'e'.repeat(64), digest],
      )).rejects.toThrow();

      await database.run(
        `INSERT INTO library_outbox (
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL, NULL,
          '{}', NULL, 1, 1)`,
        [
          '11111111-1111-4111-8111-111111111111',
          'scope-1',
          deviceId,
          assetId,
        ],
      );

      await expect(
        database.getFirst<{ device_id: string }>(
          'SELECT device_id FROM library_outbox WHERE asset_id = ?',
          [assetId],
        ),
      ).resolves.toEqual({ device_id: deviceId });

      // One pending intent per (scope, kind, asset).
      await expect(database.run(
        `INSERT INTO library_outbox (
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL, NULL,
          '{}', NULL, 1, 1)`,
        [
          '22222222-2222-4222-8222-222222222222',
          'scope-1',
          deviceId,
          assetId,
        ],
      )).rejects.toThrow();

      // The design mutation identity requires a real device id.
      await expect(database.run(
        `INSERT INTO library_outbox (
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        ) VALUES (?, ?, NULL, ?, 'collect', NULL, NULL, 'pending', 0, NULL,
          NULL, '{}', NULL, 1, 1)`,
        [
          '33333333-3333-4333-8333-333333333333',
          'scope-9',
          'f'.repeat(64),
        ],
      )).rejects.toThrow();

      await expect(database.run(
        `INSERT INTO library_outbox (
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        ) VALUES (?, ?, '', ?, 'collect', NULL, NULL, 'pending', 0, NULL,
          NULL, '{}', NULL, 1, 1)`,
        [
          '44444444-4444-4444-8444-444444444444',
          'scope-9',
          'f'.repeat(64),
        ],
      )).rejects.toThrow();
    } finally {
      nativeDatabase.close();
    }
  });
});
