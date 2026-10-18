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
 * K6-5 C. A collected original is downloaded, then ingested into the private
 * library. The ingest can throw (`empty_file`, `unreadable_source`,
 * `unsupported_format`, `decode_failed`, storage, database) and, before this
 * version, nothing recorded that: the row stayed `ready`, the library had no
 * entry for it, the tile showed no badge at all, and no later pass retried it.
 * Owner phone 2026-09-14 21:30 — a 1064x1216 Waifu.im image, blank tile, 82
 * saved in the grid against 42 in the bucket.
 */
describe('schema v19 — images.library_error', () => {
  test('a saved row can record which ingest error it hit, and how often', async () => {
    const { native, database } = await migrated();
    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(19);
      const columns = await database.getAll<{ name: string; dflt_value: unknown }>(
        'PRAGMA table_info(images)',
      );
      const byName = new Map(columns.map((column) => [column.name, column]));
      expect(byName.has('library_error')).toBe(true);
      expect(byName.has('library_error_attempts')).toBe(true);
      // Every pre-v19 row starts at zero attempts, so the terminal rule can be
      // evaluated without a NULL special case anywhere.
      expect(String(byName.get('library_error_attempts')?.dflt_value)).toBe('0');
    } finally {
      native.close();
    }
  });

  test('existing rows migrate in place with no error and no attempts', async () => {
    const native = new DatabaseSync(':memory:');
    const database = createNodeSqliteAdapter(native);
    try {
      await migrateDatabase(database);
      await database.run(
        `INSERT INTO images (
           provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state
         ) VALUES ('waifu_im', '1', 'https://cdn.example.com/1.jpg', 10, 10, 100,
                   '.jpg', '#aabbcc', 'safe', 0, 0, '[]', 'saved', 1, 2, 1, 1,
                   'file:///documents/collection/1.jpg', 'ready')`,
      );

      await expect(database.getAll<{
        library_error: string | null;
        library_error_attempts: number;
      }>('SELECT library_error, library_error_attempts FROM images')).resolves
        .toEqual([{ library_error: null, library_error_attempts: 0 }]);
    } finally {
      native.close();
    }
  });
});
