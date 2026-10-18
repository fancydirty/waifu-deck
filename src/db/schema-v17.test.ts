import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const EXPECTED_IMAGE_INDEXES = [
  'images_canonical_source_key',
  'images_decision_decided_at',
  'images_decision_ordinal',
  'images_download_state',
  'images_md5',
  'images_one_active',
  'images_perceptual_hash',
  'images_provider_identity',
  'images_queue_ordinal',
  'images_taste_recorded_at',
];

async function migrated(): Promise<{ native: DatabaseSync; database: SqlDatabasePort }> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database };
}

async function insertSaved(
  database: SqlDatabasePort,
  id: number,
  downloadState: 'pending' | 'failed' | 'ready',
): Promise<void> {
  const localUri = downloadState === 'ready' ? `file:///collection/${id}.jpg` : null;
  const downloadError = downloadState === 'failed' ? 'download_failed' : null;
  await database.run(
    `INSERT INTO images (
       id, provider_key, provider_item_id, remote_url, width, height, byte_size,
       extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
       presented_at, decided_at, queue_ordinal, decision_ordinal,
       local_uri, download_state, download_error
     ) VALUES (?, 'danbooru', ?, ?, 1, 1, 1, 'jpg', '#000000', 0, 0, '[]', 'saved',
               1, 2, ?, ?, ?, ?, ?)`,
    [id, `d-${id}`, `https://cdn.example.com/${id}.jpg`, id, id, localUri, downloadState, downloadError],
  );
}

async function insertPointer(
  database: SqlDatabasePort,
  imageId: number,
  digestTag: string,
  missingSince: number | null = null,
): Promise<void> {
  const sha = digestTag.padEnd(64, '0');
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, width, height, byte_size,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', 1, 1, 1, 'provider', ?, 'file:///library/originals/x.jpg',
               'local-original', 1, ?, 1, 1)`,
    [sha, imageId, missingSince],
  );
}

describe('schema v17', () => {
  test('images.download_state accepts mirrored with a null local_uri', async () => {
    const { native, database } = await migrated();
    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(17);
      await expect(database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, is_nsfw, is_animated, tags_json, decision,
           presented_at, decided_at, queue_ordinal, decision_ordinal,
           local_uri, download_state, download_error
         ) VALUES (1, 'danbooru', 'd-1', 'https://cdn.example.com/1.jpg', 1, 1, 1, 'jpg',
                   '#000000', 0, 0, '[]', 'saved', 1, 2, 1, 1, NULL, 'mirrored', NULL)`,
      )).resolves.toBeDefined();
    } finally {
      native.close();
    }
  });

  test('keeps exactly the pre-v17 index set on the rebuilt images table', async () => {
    const { native, database } = await migrated();
    try {
      const rows = await database.getAll<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'images' AND sql IS NOT NULL
          ORDER BY name`,
      );
      expect(rows.map((r) => r.name)).toEqual(EXPECTED_IMAGE_INDEXES);
    } finally {
      native.close();
    }
  });

  test('replaying v17 converts only pointer-bearing pending/failed saved rows to mirrored', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    try {
      await migrateDatabase(database);
      await insertSaved(database, 1, 'pending');   // pointer → mirrored
      await insertSaved(database, 2, 'failed');    // pointer → mirrored
      await insertSaved(database, 3, 'ready');     // pointer, ready → untouched
      await insertSaved(database, 4, 'pending');   // NO pointer → untouched
      await insertPointer(database, 1, 'a1');
      await insertPointer(database, 2, 'a2');
      await insertPointer(database, 3, 'a3');
      native.exec('PRAGMA user_version = 16');

      await expect(migrateDatabase(database)).resolves.toBeUndefined();

      await expect(database.getAll<{ id: number; download_state: string; local_uri: string | null; download_error: string | null }>(
        'SELECT id, download_state, local_uri, download_error FROM images ORDER BY id',
      )).resolves.toEqual([
        { id: 1, download_state: 'mirrored', local_uri: null, download_error: null },
        { id: 2, download_state: 'mirrored', local_uri: null, download_error: null },
        { id: 3, download_state: 'ready', local_uri: 'file:///collection/3.jpg', download_error: null },
        { id: 4, download_state: 'pending', local_uri: null, download_error: null },
      ]);
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
    } finally {
      native.close();
    }
  });

  test('re-running the ladder is idempotent', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    try {
      await migrateDatabase(database);
      await migrateDatabase(database);
      const columns = await database.getAll<{ name: string }>('PRAGMA table_info(images)');
      expect(columns.filter(({ name }) => name === 'download_state')).toHaveLength(1);
      expect(columns.filter(({ name }) => name === 'sample_url')).toHaveLength(1);
    } finally {
      native.close();
    }
  });

  test('K2b: a pointer whose library original is known-missing does not make the row mirrored', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    try {
      await migrateDatabase(database);
      await insertSaved(database, 5, 'failed');
      await insertPointer(database, 5, 'a5', 1_700_000_000_000);   // missing_original_since set
      await insertSaved(database, 6, 'failed');
      await insertPointer(database, 6, 'a6');                       // healthy pointer → mirrored
      native.exec('PRAGMA user_version = 16');
      await migrateDatabase(database);
      await expect(database.getAll<{ id: number; download_state: string; download_error: string | null }>(
        'SELECT id, download_state, download_error FROM images WHERE id IN (5, 6) ORDER BY id',
      )).resolves.toEqual([
        { id: 5, download_state: 'failed', download_error: 'download_failed' },
        { id: 6, download_state: 'mirrored', download_error: null },
      ]);
    } finally {
      native.close();
    }
  });
});
