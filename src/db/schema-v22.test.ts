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

const columns = async (db: SqlDatabasePort, table: string) =>
  (
    await db.getAll<{ name: string }>(`PRAGMA table_info(${table})`)
  ).map(({ name }) => name);

describe('schema v22 (N6-A1)', () => {
  test('a fresh database is at v22 with import_classification, import_deleted_at, and library_provider_image_assets', async () => {
    const { native, database } = await migrated();
    try {
      expect(DATABASE_VERSION).toBeGreaterThanOrEqual(22);
      await expect(database.getFirst('PRAGMA user_version')).resolves.toEqual({
        user_version: DATABASE_VERSION,
      });
      const assetCols = await columns(database, 'device_library_assets');
      expect(assetCols).toContain('import_classification');
      expect(assetCols).toContain('import_deleted_at');

      const assocCols = await columns(database, 'library_provider_image_assets');
      expect(assocCols).toEqual(['image_id', 'plaintext_sha256', 'updated_at']);

      const indexes = await database.getAll<{ name: string }>(
        "PRAGMA index_list('library_provider_image_assets')",
      );
      expect(
        indexes.some(({ name }) => name === 'library_provider_image_assets_digest'),
      ).toBe(true);
    } finally {
      native.close();
    }
  });

  test('upgrades a v21 database preserving bytes, digest, residency, created_at, source_image_id, local_thumbnail_uri, and account mappings, setting import_classification to unknown and backfilling library_provider_image_assets', async () => {
    const { native, database } = await migrated();
    try {
      await database.exec(`
        DROP TABLE IF EXISTS library_provider_image_assets;
        ALTER TABLE device_library_assets DROP COLUMN import_classification;
        ALTER TABLE device_library_assets DROP COLUMN import_deleted_at;
        PRAGMA user_version = 21;
      `);

      const importDigest = 'a'.repeat(64);
      const cloudOnlyDigest = 'b'.repeat(64);
      const providerOlderDigest = 'd'.repeat(64);
      const providerNewerDigest = 'c'.repeat(64);
      const providerSingleDigest = 'e'.repeat(64);

      await database.run(
        `INSERT INTO device_library_assets (
           plaintext_sha256, format, canonical_extension, byte_size, width, height,
           origin, source_image_id, local_original_uri, residency, protect_eligible,
           missing_original_since, local_thumbnail_uri, created_at, updated_at
         ) VALUES
           (?, 'jpeg', 'jpg', 1234, 800, 600, 'import', NULL, 'file:///o/a.jpg', 'local-original', 1, NULL, 'file:///t/a.webp', 1000, 1005),
           (?, 'png', 'png', 5678, 1024, 768, 'import', NULL, NULL, 'cloud-only', 1, NULL, NULL, 2000, 2005),
           (?, 'jpeg', 'jpg', 2222, 500, 500, 'provider', 42, 'file:///o/d.jpg', 'local-original', 1, NULL, NULL, 3000, 3005),
           (?, 'jpeg', 'jpg', 3333, 500, 500, 'provider', 42, 'file:///o/c.jpg', 'local-original', 1, NULL, NULL, 4000, 4005),
           (?, 'webp', 'webp', 4444, 600, 600, 'provider', 99, 'file:///o/e.webp', 'local-original', 1, NULL, 'file:///t/e.webp', 5000, 5005)`,
        [
          importDigest,
          cloudOnlyDigest,
          providerOlderDigest,
          providerNewerDigest,
          providerSingleDigest,
        ],
      );

      await database.run(
        `INSERT INTO library_account_assets (
           account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
         ) VALUES ('scope-1', ?, ?, 'dev-1', 1000, 1005)`,
        ['f'.repeat(64), importDigest],
      );

      await migrateDatabase(database);

      await expect(database.getFirst('PRAGMA user_version')).resolves.toEqual({
        user_version: DATABASE_VERSION,
      });

      const migratedAssets = await database.getAll<{
        plaintext_sha256: string;
        byte_size: number;
        origin: string;
        source_image_id: number | null;
        local_original_uri: string | null;
        residency: string;
        local_thumbnail_uri: string | null;
        created_at: number;
        updated_at: number;
        import_classification: string;
        import_deleted_at: number | null;
      }>(
        `SELECT plaintext_sha256, byte_size, origin, source_image_id,
                local_original_uri, residency, local_thumbnail_uri,
                created_at, updated_at, import_classification, import_deleted_at
           FROM device_library_assets
          ORDER BY created_at ASC`,
      );

      expect(migratedAssets).toEqual([
        {
          plaintext_sha256: importDigest,
          byte_size: 1234,
          origin: 'import',
          source_image_id: null,
          local_original_uri: 'file:///o/a.jpg',
          residency: 'local-original',
          local_thumbnail_uri: 'file:///t/a.webp',
          created_at: 1000,
          updated_at: 1005,
          import_classification: 'unknown',
          import_deleted_at: null,
        },
        {
          plaintext_sha256: cloudOnlyDigest,
          byte_size: 5678,
          origin: 'import',
          source_image_id: null,
          local_original_uri: null,
          residency: 'cloud-only',
          local_thumbnail_uri: null,
          created_at: 2000,
          updated_at: 2005,
          import_classification: 'unknown',
          import_deleted_at: null,
        },
        {
          plaintext_sha256: providerOlderDigest,
          byte_size: 2222,
          origin: 'provider',
          source_image_id: 42,
          local_original_uri: 'file:///o/d.jpg',
          residency: 'local-original',
          local_thumbnail_uri: null,
          created_at: 3000,
          updated_at: 3005,
          import_classification: 'unknown',
          import_deleted_at: null,
        },
        {
          plaintext_sha256: providerNewerDigest,
          byte_size: 3333,
          origin: 'provider',
          source_image_id: 42,
          local_original_uri: 'file:///o/c.jpg',
          residency: 'local-original',
          local_thumbnail_uri: null,
          created_at: 4000,
          updated_at: 4005,
          import_classification: 'unknown',
          import_deleted_at: null,
        },
        {
          plaintext_sha256: providerSingleDigest,
          byte_size: 4444,
          origin: 'provider',
          source_image_id: 99,
          local_original_uri: 'file:///o/e.webp',
          residency: 'local-original',
          local_thumbnail_uri: 'file:///t/e.webp',
          created_at: 5000,
          updated_at: 5005,
          import_classification: 'unknown',
          import_deleted_at: null,
        },
      ]);

      await expect(
        database.getAll(
          'SELECT account_scope, asset_id, plaintext_sha256 FROM library_account_assets',
        ),
      ).resolves.toEqual([
        {
          account_scope: 'scope-1',
          asset_id: 'f'.repeat(64),
          plaintext_sha256: importDigest,
        },
      ]);

      await expect(
        database.getAll(
          'SELECT image_id, plaintext_sha256, updated_at FROM library_provider_image_assets ORDER BY image_id ASC',
        ),
      ).resolves.toEqual([
        {
          image_id: 42,
          plaintext_sha256: providerNewerDigest,
          updated_at: 4005,
        },
        {
          image_id: 99,
          plaintext_sha256: providerSingleDigest,
          updated_at: 5005,
        },
      ]);
    } finally {
      native.close();
    }
  });

  test('CHECK constraint on import_classification accepts safe, adult, unknown and rejects invalid values', async () => {
    const { native, database } = await migrated();
    try {
      for (const [index, classification] of ['safe', 'adult', 'unknown'].entries()) {
        const digest = (index + 1).toString().repeat(64);
        await expect(
          database.run(
            `INSERT INTO device_library_assets (
               plaintext_sha256, format, canonical_extension, byte_size, width, height,
               origin, source_image_id, local_original_uri, residency, protect_eligible,
               missing_original_since, import_classification, created_at, updated_at
             ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, NULL, 'cloud-only', 1, NULL, ?, 1, 1)`,
            [digest, classification],
          ),
        ).resolves.toBeDefined();
      }

      for (const invalid of ['nsfw', '', 'SAFE', 'questionable']) {
        await expect(
          database.run(
            `INSERT INTO device_library_assets (
               plaintext_sha256, format, canonical_extension, byte_size, width, height,
               origin, source_image_id, local_original_uri, residency, protect_eligible,
               missing_original_since, import_classification, created_at, updated_at
             ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, NULL, 'cloud-only', 1, NULL, ?, 1, 1)`,
            ['9'.repeat(64), invalid],
          ),
        ).rejects.toThrow();
      }
    } finally {
      native.close();
    }
  });

  test('re-running the v22 migration step is idempotent', async () => {
    const { native, database } = await migrated();
    try {
      await database.exec('PRAGMA user_version = 21;');
      await expect(migrateDatabase(database)).resolves.toBeUndefined();
      await expect(database.getFirst('PRAGMA user_version')).resolves.toEqual({
        user_version: DATABASE_VERSION,
      });
    } finally {
      native.close();
    }
  });
});
