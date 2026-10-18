import { DatabaseSync } from 'node:sqlite';

import { DATABASE_VERSION, migrateDatabase } from '@/db/schema';
import {
  clearAccountProjection,
  forgetEveryAccount,
} from '@/features/library/library-account-projection';
import { createLibraryAccountMetadataSummaryRepository } from '@/features/library/library-account-metadata-summary';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const ASSET_A = '1'.repeat(64);
const ASSET_B = '2'.repeat(64);

describe('schema v23 migration (N6-A3)', () => {
  it('migrates a fresh database to version 23 with applied_state_key and library_account_metadata_summary', async () => {
    const native = new DatabaseSync(':memory:');
    const db = createNodeSqliteAdapter(native);
    try {
      await migrateDatabase(db);
      const version = await db.getFirst<{ user_version: number }>(
        'PRAGMA user_version',
      );
      expect(version?.user_version).toBe(23);
      expect(DATABASE_VERSION).toBe(23);

      const protectionColumns = await db.getAll<{ name: string }>(
        'PRAGMA table_info(library_asset_protection)',
      );
      expect(protectionColumns.map((col) => col.name)).toContain(
        'applied_state_key',
      );

      const summaryColumns = await db.getAll<{ name: string }>(
        'PRAGMA table_info(library_account_metadata_summary)',
      );
      expect(summaryColumns.map((col) => col.name)).toEqual([
        'account_scope',
        'asset_id',
        'plaintext_sha256',
        'origin',
        'collected_at',
        'import_classification',
        'source_json',
        'state_key',
        'sealed_meta',
        'updated_at',
      ]);
    } finally {
      native.close();
    }
  });

  it('upgrades a populated v22 database preserving protection rows and adding summary CRUD + clearAccountProjection / forgetEveryAccount cleanup', async () => {
    const native = new DatabaseSync(':memory:');
    const db = createNodeSqliteAdapter(native);
    try {
      await migrateDatabase(db);
      // Simulate a v22 state before v23 ran by dropping the v23 table and setting user_version = 22.
      await db.exec(`
        DROP TABLE library_account_metadata_summary;
        PRAGMA user_version = 22;
      `);
      await db.run(
        `INSERT INTO library_asset_protection (
           account_scope, asset_id, plaintext_sha256, lifecycle, protection,
           generation, revision, original_generation_id, original_ciphertext_bytes,
           thumbnail_generation_id, preview_generation_id, verified_at,
           failure_category, trashed_at, updated_at
         ) VALUES ('scope-1', ?, ?, 'active', 'protected', 1, 3, 'gen-1', 100, NULL, NULL, 1000, NULL, NULL, 1000)`,
        [ASSET_A, DIGEST_A],
      );

      await migrateDatabase(db);
      const version = await db.getFirst<{ user_version: number }>(
        'PRAGMA user_version',
      );
      expect(version?.user_version).toBe(23);

      const summaryRepo = createLibraryAccountMetadataSummaryRepository({
        database: db,
        clock: () => 2000,
      });

      await summaryRepo.upsert({
        accountScope: 'scope-1',
        assetId: ASSET_A,
        plaintextSha256: DIGEST_A,
        origin: 'import',
        collectedAt: 1500,
        importClassification: 'safe',
        source: null,
        stateKey: 's3:3',
        sealedMeta: 'sealed-a',
      });
      await summaryRepo.upsert({
        accountScope: 'scope-2',
        assetId: ASSET_B,
        plaintextSha256: DIGEST_B,
        origin: 'provider',
        collectedAt: 1600,
        importClassification: 'unknown',
        source: {
          providerKey: 'danbooru',
          providerItemId: '42',
          canonicalSourceKey: 'danbooru:42',
          remoteUrl: 'https://example.com/42.jpg',
          sampleUrl: null,
          sourceUrl: null,
          artistName: 'artist',
          artistUrl: null,
          extension: '.jpg',
          dominantColor: '#112233',
          isNsfw: false,
          isAnimated: false,
          contentRating: 'safe',
          nativeRating: 's',
          perceptualHash: null,
          md5: null,
          tags: ['tag1'],
        },
        stateKey: 'state/note-b',
        sealedMeta: 'sealed-b',
      });

      expect(await summaryRepo.findByAssetId('scope-1', ASSET_A)).toEqual({
        accountScope: 'scope-1',
        assetId: ASSET_A,
        plaintextSha256: DIGEST_A,
        origin: 'import',
        collectedAt: 1500,
        importClassification: 'safe',
        source: null,
        stateKey: 's3:3',
        sealedMeta: 'sealed-a',
        updatedAt: 2000,
      });

      const byDigest = await summaryRepo.findByDigest('scope-2', DIGEST_B);
      expect(byDigest?.origin).toBe('provider');
      expect(byDigest?.source?.providerItemId).toBe('42');

      // Reject invalid import_classification at the SQLite CHECK boundary
      await expect(
        db.run(
          `INSERT INTO library_account_metadata_summary (
             account_scope, asset_id, plaintext_sha256, origin, collected_at,
             import_classification, source_json, state_key, sealed_meta, updated_at
           ) VALUES ('scope-1', ?, ?, 'import', 1000, 'bogus', NULL, 's3:1', 'meta', 1000)`,
          [ASSET_B, DIGEST_B],
        ),
      ).rejects.toThrow();

      await clearAccountProjection(db, 'scope-1');
      expect(await summaryRepo.findByAssetId('scope-1', ASSET_A)).toBeNull();
      expect(await summaryRepo.findByAssetId('scope-2', ASSET_B)).not.toBeNull();

      await forgetEveryAccount(db);
      expect(await summaryRepo.findByAssetId('scope-2', ASSET_B)).toBeNull();
    } finally {
      native.close();
    }
  });
});
