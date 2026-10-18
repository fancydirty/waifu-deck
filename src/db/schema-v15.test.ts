import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const MD5 = 'd5c7f0aa3b4e1926c0f9a7b28d3e415f';

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
  md5: string | null,
): Promise<void> {
  await database.run(
    `INSERT INTO images (
       id, provider_key, provider_item_id, canonical_source_key,
       perceptual_hash, md5, remote_url, width, height, byte_size, extension,
       dominant_color, is_nsfw, is_animated, tags_json, decision,
       queue_ordinal, download_state
     ) VALUES (?, 'danbooru', ?, NULL, NULL, ?, ?, 1, 1, 1, '.webp',
               '#000000', 0, 0, '[]', 'queued', ?, 'none')`,
    [id, `danbooru-${id}`, md5, `https://cdn.example.com/${id}.webp`, id],
  );
}

describe('schema v15', () => {
  test('adds the md5 column and its partial index on a fresh database', async () => {
    const { native, database } = await migrated();

    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(15);
      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });

      const columns = await database.getAll<{ name: string; type: string }>(
        'PRAGMA table_info(images)',
      );
      expect(columns).toContainEqual(
        expect.objectContaining({ name: 'md5', type: 'TEXT' }),
      );

      const index = await database.getFirst<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND name = 'images_md5'`,
      );
      expect(index?.name).toBe('images_md5');
      // Partial, exactly like images_perceptual_hash: null digests are not
      // indexed and can never be matched by the gate's md5 arm.
      expect(index?.sql).toContain('WHERE md5 IS NOT NULL');
    } finally {
      native.close();
    }
  });

  test('re-running the ladder is idempotent and keeps one md5 index', async () => {
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
      expect(columns.filter(({ name }) => name === 'md5')).toHaveLength(1);
      await expect(
        database.getAll<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'images_md5'`,
        ),
      ).resolves.toEqual([{ name: 'images_md5' }]);
    } finally {
      native.close();
    }
  });

  test('replaying the v15 step preserves existing rows and leaves old digests null', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);

    try {
      // As in the v13/v14 schema tests, this does NOT build a genuinely
      // v14-shaped table: the first migrateDatabase call already ran the whole
      // ladder, so `images` has its md5 column before the pragma is rewound.
      // Rewinding user_version makes the second call replay the v15 step
      // against an already-migrated table, which is what proves the step is
      // replay-safe (guarded ALTER + IF NOT EXISTS index) and does not rewrite
      // rows -- not that it upgrades a true pre-v15 column set.
      await migrateDatabase(database);
      await insertImage(database, 11, null);
      await insertImage(database, 12, MD5);
      native.exec('PRAGMA user_version = 14');

      await expect(migrateDatabase(database)).resolves.toBeUndefined();

      await expect(
        database.getFirst<{ user_version: number }>('PRAGMA user_version'),
      ).resolves.toEqual({ user_version: DATABASE_VERSION });
      await expect(
        database.getAll<{ id: number; md5: string | null }>(
          'SELECT id, md5 FROM images ORDER BY id',
        ),
      ).resolves.toEqual([
        { id: 11, md5: null },
        { id: 12, md5: MD5 },
      ]);
    } finally {
      native.close();
    }
  });
});
