import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import { LIBRARY_TRASH_RETENTION_MS } from '@/features/library/library-trash-deadline';
import {
  createLibraryViewModel,
  type LibraryViewModel,
} from '@/features/library/library-view-model';
import {
  seedDeviceAssetState,
  seedDeviceLibraryAsset,
  seedLibraryProtection,
  VIEW_TEST_ACCOUNT_SCOPE,
  viewDigest,
} from '@/features/library/library-view-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const MASTER_KEY = new Uint8Array(32).fill(7);

type Harness = {
  native: DatabaseSync;
  database: SqlDatabasePort;
  session: LibrarySessionPort & {
    value: LibrarySessionContext | null;
  };
  model: LibraryViewModel;
  close(): void;
};

async function createHarness(): Promise<Harness> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  const session: LibrarySessionPort & {
    value: LibrarySessionContext | null;
  } = {
    value: {
      deviceId: 'device-view',
      masterKey: MASTER_KEY,
      accountScope: VIEW_TEST_ACCOUNT_SCOPE,
    },
    async current() {
      return session.value;
    },
  };
  return {
    native,
    database,
    session,
    model: createLibraryViewModel({ database, session }),
    close() {
      native.close();
    },
  };
}

describe('library view model', () => {
  test('local-original asset with source_image_id reports sourceImageId', async () => {
    const harness = await createHarness();
    try {
      const digest = viewDigest('local-src');
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: digest,
        sourceImageId: 42,
        residency: 'local-original',
      });

      const entry = await harness.model.findEntry(digest);
      expect(entry).toMatchObject({
        plaintextSha256: digest,
        sourceImageId: 42,
        residency: 'local-original',
        hasLocalOriginal: true,
        originalGenerationId: null,
      });
    } finally {
      harness.close();
    }
  });

  test('localOriginalUri is the original only while it is usable', async () => {
    const harness = await createHarness();
    try {
      const local = viewDigest('uri-local');
      const flagged = viewDigest('uri-flagged');
      const cloud = viewDigest('uri-cloud');
      const uri = 'file:///data/library/originals/uri-local.jpg';
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: local,
        residency: 'local-original',
        localOriginalUri: uri,
        createdAt: 3_000,
      });
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: flagged,
        residency: 'local-original',
        localOriginalUri: 'file:///data/library/originals/uri-flagged.jpg',
        missingOriginalSince: 7,
        createdAt: 2_000,
      });
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: cloud,
        residency: 'cloud-only',
        createdAt: 1_000,
      });

      expect(await harness.model.findEntry(local)).toMatchObject({
        hasLocalOriginal: true,
        localOriginalUri: uri,
      });
      expect(await harness.model.findEntry(flagged)).toMatchObject({
        hasLocalOriginal: false,
        localOriginalUri: null,
      });
      expect(await harness.model.findEntry(cloud)).toMatchObject({
        hasLocalOriginal: false,
        localOriginalUri: null,
      });
      expect(
        (await harness.model.listEntries()).map((entry) => entry.localOriginalUri),
      ).toEqual([uri, null, null]);
    } finally {
      harness.close();
    }
  });

  test('board #16: an entry carries the original\'s byte size', async () => {
    const harness = await createHarness();
    try {
      const digest = viewDigest('huge-gif');
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: digest,
        sourceImageId: null,
        format: 'gif',
        byteSize: 50_278_178,
        residency: 'local-original',
      });

      expect(await harness.model.findEntry(digest)).toMatchObject({
        format: 'gif',
        byteSize: 50_278_178,
      });
      expect((await harness.model.listEntries())[0]?.byteSize).toBe(50_278_178);
    } finally {
      harness.close();
    }
  });

  test('materialized cloud-only asset with no images row is still listed', async () => {
    const harness = await createHarness();
    try {
      const digest = viewDigest('cloud-only');
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: digest,
        sourceImageId: null,
        residency: 'cloud-only',
        localOriginalUri: null,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: digest,
        protection: 'protected',
        originalGenerationId: 'gen-orig-1',
      });

      const entries = await harness.model.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        plaintextSha256: digest,
        sourceImageId: null,
        residency: 'cloud-only',
        hasLocalOriginal: false,
        originalGenerationId: 'gen-orig-1',
      });
    } finally {
      harness.close();
    }
  });

  test('trash, purged, and device-trashed rows are excluded', async () => {
    const harness = await createHarness();
    try {
      const visible = viewDigest('visible');
      const trashed = viewDigest('trashed');
      const purged = viewDigest('purged');
      const deviceTrashed = viewDigest('device-trash');

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: visible,
        createdAt: 400,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: visible,
        lifecycle: 'active',
        protection: 'unprotected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: trashed,
        createdAt: 300,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: trashed,
        lifecycle: 'trash',
        protection: 'protected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: purged,
        createdAt: 200,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: purged,
        lifecycle: 'purged',
        protection: 'protected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: deviceTrashed,
        createdAt: 100,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: deviceTrashed,
        lifecycle: 'active',
        protection: 'unprotected',
      });
      await seedDeviceAssetState(harness.database, {
        plaintextSha256: deviceTrashed,
        deviceTrashedAt: 50,
        deviceTrashUri: 'file:///data/library/trash/device-trash.jpg',
      });

      const entries = await harness.model.listEntries();
      expect(entries.map((entry) => entry.plaintextSha256)).toEqual([visible]);
    } finally {
      harness.close();
    }
  });

  test('ordering is created_at DESC, plaintext_sha256 ASC', async () => {
    const harness = await createHarness();
    try {
      const olderA = viewDigest('order-a');
      const olderB = viewDigest('order-b');
      const newer = viewDigest('order-new');
      // Same created_at: ASC by digest.
      const sameEarly = '1'.repeat(64);
      const sameLate = '2'.repeat(64);

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: olderB,
        createdAt: 100,
      });
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: olderA,
        createdAt: 100,
      });
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: sameLate,
        createdAt: 200,
      });
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: sameEarly,
        createdAt: 200,
      });
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: newer,
        createdAt: 300,
      });

      const digests = (await harness.model.listEntries())
        .map((entry) => entry.plaintextSha256);
      expect(digests).toEqual([
        newer,
        sameEarly,
        sameLate,
        olderA < olderB ? olderA : olderB,
        olderA < olderB ? olderB : olderA,
      ]);
    } finally {
      harness.close();
    }
  });

  test('signed-out session returns empty list and null find', async () => {
    const harness = await createHarness();
    try {
      const digest = viewDigest('signed-out');
      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: digest,
      });
      harness.session.value = null;

      await expect(harness.model.listEntries()).resolves.toEqual([]);
      await expect(harness.model.findEntry(digest)).resolves.toBeNull();
    } finally {
      harness.close();
    }
  });

  test('listTrashEntries returns only lifecycle=trash rows with deadlines', async () => {
    const harness = await createHarness();
    try {
      const activeDigest = viewDigest('trash-list-active');
      const trashDigest = viewDigest('trash-list-trash');
      const purgedDigest = viewDigest('trash-list-purged');
      const deviceTrashDigest = viewDigest('trash-list-device');
      const trashedAt = Date.UTC(2026, 6, 1, 0, 0, 0);

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: activeDigest,
        createdAt: 400,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: activeDigest,
        lifecycle: 'active',
        protection: 'unprotected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: trashDigest,
        createdAt: 300,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: trashDigest,
        lifecycle: 'trash',
        protection: 'protected',
        trashedAt,
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: purgedDigest,
        createdAt: 200,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: purgedDigest,
        lifecycle: 'purged',
        protection: 'protected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: deviceTrashDigest,
        createdAt: 100,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: deviceTrashDigest,
        lifecycle: 'active',
        protection: 'unprotected',
      });
      await seedDeviceAssetState(harness.database, {
        plaintextSha256: deviceTrashDigest,
        deviceTrashedAt: trashedAt,
        deviceTrashUri: 'file:///data/library/trash/device.jpg',
      });

      const entries = await harness.model.listTrashEntries();
      expect(entries.map((e) => e.plaintextSha256)).toEqual([trashDigest]);
      expect(entries[0]?.lifecycle).toBe('trash');
      expect(entries[0]?.trashedAt).toBe(trashedAt);
      expect(entries[0]?.purgeDeadlineAt).toBe(
        trashedAt + LIBRARY_TRASH_RETENTION_MS,
      );
    } finally {
      harness.close();
    }
  });

  test('listEntries still excludes trash and purged', async () => {
    const harness = await createHarness();
    try {
      const activeDigest = viewDigest('still-active');
      const trashDigest = viewDigest('still-trash');
      const purgedDigest = viewDigest('still-purged');
      const trashedAt = Date.UTC(2026, 6, 1, 0, 0, 0);

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: activeDigest,
        createdAt: 300,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: activeDigest,
        lifecycle: 'active',
        protection: 'unprotected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: trashDigest,
        createdAt: 200,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: trashDigest,
        lifecycle: 'trash',
        protection: 'protected',
        trashedAt,
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: purgedDigest,
        createdAt: 100,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: purgedDigest,
        lifecycle: 'purged',
        protection: 'protected',
      });

      const entries = await harness.model.listEntries();
      expect(entries.every((e) => e.lifecycle === 'active')).toBe(true);
      expect(entries.map((e) => e.plaintextSha256)).toEqual([activeDigest]);
    } finally {
      harness.close();
    }
  });

  test('projects origin and importClassification and excludes import rows with import_deleted_at set (N6-A1)', async () => {
    const harness = await createHarness();
    try {
      const safeDigest = viewDigest('import-safe');
      const adultDigest = viewDigest('import-adult');
      const deletedImportDigest = viewDigest('import-deleted');

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: safeDigest,
        origin: 'import',
        importClassification: 'safe',
        createdAt: 300,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: safeDigest,
        lifecycle: 'active',
        protection: 'unprotected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: adultDigest,
        origin: 'import',
        importClassification: 'adult',
        createdAt: 200,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: adultDigest,
        lifecycle: 'active',
        protection: 'unprotected',
      });

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: deletedImportDigest,
        origin: 'import',
        importClassification: 'safe',
        importDeletedAt: 999,
        createdAt: 100,
      });
      await seedLibraryProtection(harness.database, {
        plaintextSha256: deletedImportDigest,
        lifecycle: 'active',
        protection: 'unprotected',
      });

      const entries = await harness.model.listEntries();
      expect(
        entries.map((e) => ({
          plaintextSha256: e.plaintextSha256,
          origin: e.origin,
          importClassification: e.importClassification,
        })),
      ).toEqual([
        {
          plaintextSha256: safeDigest,
          origin: 'import',
          importClassification: 'safe',
        },
        {
          plaintextSha256: adultDigest,
          origin: 'import',
          importClassification: 'adult',
        },
      ]);
      await expect(harness.model.findEntry(deletedImportDigest)).resolves.toBeNull();
    } finally {
      harness.close();
    }
  });

  test('N6-B1: two-member digest projects both sourceImageId (from library_provider_image_assets) and hasImportMembership', async () => {
    const harness = await createHarness();
    try {
      const twoMemberDigest = viewDigest('two-member-both');
      const deletedImportWithProvider = viewDigest('two-member-provider-only');

      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height,
           byte_size, extension, dominant_color, content_rating, is_nsfw,
           is_animated, tags_json, decision, presented_at, decided_at,
           queue_ordinal, decision_ordinal, taste_signal, taste_recorded_at,
           local_uri, download_state
         ) VALUES (
           71, 'danbooru', '71', 'https://cdn.example.com/71.jpg', 800, 1200,
           500000, '.jpg', '#111111', 'safe', 0, 0, '[]', 'saved', 1000, 1000,
           1, 1, 'saved', 1000, 'file:///collection/71.jpg', 'ready'
         ), (
           72, 'danbooru', '72', 'https://cdn.example.com/72.jpg', 800, 1200,
           500000, '.jpg', '#111111', 'safe', 0, 0, '[]', 'saved', 1000, 1000,
           2, 2, 'saved', 1000, 'file:///collection/72.jpg', 'ready'
         )`,
      );

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: twoMemberDigest,
        origin: 'import',
        sourceImageId: null,
        importClassification: 'adult',
        createdAt: 500,
      });
      await harness.database.run(
        `INSERT INTO library_provider_image_assets (image_id, plaintext_sha256, updated_at)
         VALUES (71, ?, 600)`,
        [twoMemberDigest],
      );

      await seedDeviceLibraryAsset(harness.database, {
        plaintextSha256: deletedImportWithProvider,
        origin: 'import',
        sourceImageId: null,
        importClassification: 'safe',
        importDeletedAt: 700,
        createdAt: 400,
      });
      await harness.database.run(
        `INSERT INTO library_provider_image_assets (image_id, plaintext_sha256, updated_at)
         VALUES (72, ?, 800)`,
        [deletedImportWithProvider],
      );

      const entries = await harness.model.listEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        plaintextSha256: twoMemberDigest,
        sourceImageId: 71,
        associatedProviderImageIds: [71],
        origin: 'import',
        importClassification: 'adult',
        importDeletedAt: null,
        hasImportMembership: true,
      });
      expect(entries[1]).toMatchObject({
        plaintextSha256: deletedImportWithProvider,
        sourceImageId: 72,
        associatedProviderImageIds: [72],
        origin: 'import',
        importClassification: 'safe',
        importDeletedAt: 700,
        hasImportMembership: false,
      });

      // Multiple saved provider images associated with the same digest are all
      // projected in associatedProviderImageIds (newest first).
      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height,
           byte_size, extension, dominant_color, content_rating, is_nsfw,
           is_animated, tags_json, decision, presented_at, decided_at,
           queue_ordinal, decision_ordinal, taste_signal, taste_recorded_at,
           local_uri, download_state
         ) VALUES (
           73, 'danbooru', '73', 'https://cdn.example.com/73.jpg', 800, 1200,
           500000, '.jpg', '#111111', 'safe', 0, 0, '[]', 'saved', 1000, 1000,
           3, 3, 'saved', 1000, 'file:///collection/73.jpg', 'ready'
         )`,
      );
      await harness.database.run(
        `INSERT INTO library_provider_image_assets (image_id, plaintext_sha256, updated_at)
         VALUES (73, ?, 900)`,
        [twoMemberDigest],
      );
      const updated = await harness.model.findEntry(twoMemberDigest);
      expect(updated?.associatedProviderImageIds).toEqual([73, 71]);
    } finally {
      harness.close();
    }
  });
});
