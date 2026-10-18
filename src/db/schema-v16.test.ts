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

async function insertImage(
  database: SqlDatabasePort,
  id: number,
): Promise<void> {
  await database.run(
    `INSERT INTO images (
       id, provider_key, provider_item_id, canonical_source_key,
       perceptual_hash, md5, remote_url, width, height, byte_size, extension,
       dominant_color, is_nsfw, is_animated, tags_json, decision,
       queue_ordinal, download_state
     ) VALUES (?, 'danbooru', ?, NULL, NULL, NULL, ?, 1, 1, 1, '.webp',
               '#000000', 0, 0, '[]', 'queued', ?, 'none')`,
    [id, `danbooru-${id}`, `https://cdn.example.com/${id}.webp`, id],
  );
}

describe('schema v16', () => {
  test('adds the sample_url column on a fresh database', async () => {
    const { native, database } = await migrated();

    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(16);
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });

      const columns = await database.getAll<{ name: string; type: string }>(
        'PRAGMA table_info(images)',
      );
      expect(columns).toContainEqual(
        expect.objectContaining({ name: 'sample_url', type: 'TEXT' }),
      );
    } finally {
      native.close();
    }
  });

  test('re-running the ladder is idempotent and keeps one sample_url column', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);

    try {
      await migrateDatabase(database);
      await migrateDatabase(database);
      await migrateDatabase(database);

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      const columns = await database.getAll<{ name: string }>(
        'PRAGMA table_info(images)',
      );
      expect(columns.filter(({ name }) => name === 'sample_url')).toHaveLength(1);
    } finally {
      native.close();
    }
  });

  test('replaying the v16 step preserves existing rows and leaves old sample_url null', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);

    try {
      // Like the v15 test: the first migrate ran the whole ladder, so the
      // column already exists before the pragma is rewound. Rewinding proves
      // the v16 step is replay-safe (guarded ALTER) and does not rewrite rows.
      await migrateDatabase(database);
      await insertImage(database, 21);
      await insertImage(database, 22);
      native.exec('PRAGMA user_version = 15');

      await expect(migrateDatabase(database)).resolves.toBeUndefined();

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      await expect(
        database.getAll<{ id: number; sample_url: string | null }>(
          'SELECT id, sample_url FROM images ORDER BY id',
        ),
      ).resolves.toEqual([
        { id: 21, sample_url: null },
        { id: 22, sample_url: null },
      ]);
    } finally {
      native.close();
    }
  });
});
