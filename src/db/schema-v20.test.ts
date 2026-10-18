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

/**
 * Board #5 (2026-09-18). `download_error` held one generic code, so the app
 * could not tell "the source deleted this image" (404/410, retrying is
 * pointless) from "the network dropped" (retrying works). Both sat forever as a
 * manual 「需修复」. The kind lets the resume sweep self-heal the transient ones
 * and the tile tell the truth about the gone ones — without ever deleting a row.
 */
describe('schema v20 — images.download_error_kind', () => {
  test('a failed row can record whether its source is gone or the failure was transient', async () => {
    const { native, database } = await migrated();
    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(20);
      const columns = await database.getAll<{ name: string }>('PRAGMA table_info(images)');
      expect(columns.some(({ name }) => name === 'download_error_kind')).toBe(true);
    } finally {
      native.close();
    }
  });

  test('existing rows migrate in place with no kind (read as transient)', async () => {
    const { native, database } = await migrated();
    try {
      await database.run(
        `INSERT INTO images (
           provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state, download_error
         ) VALUES ('waifu_im', '1', 'https://cdn.example.com/1.jpg', 10, 10, 100,
                   '.jpg', '#aabbcc', 'safe', 0, 0, '[]', 'saved', 1, 2, 1, 1,
                   NULL, 'failed', 'download_failed')`,
      );
      await expect(database.getAll<{ download_error_kind: string | null }>(
        'SELECT download_error_kind FROM images',
      )).resolves.toEqual([{ download_error_kind: null }]);
    } finally {
      native.close();
    }
  });
});
