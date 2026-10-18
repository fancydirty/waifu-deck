import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type {
  LibraryFailureCategory,
  LibraryRenderIntent,
} from '@/features/library/library-actions-types';
import {
  createLocalLibraryRenderResolver,
  createLocalLibraryViewModel,
  localUnavailableCategoryFor,
} from '@/features/library/library-local-view';
import { isOriginalUnrecoverable } from '@/features/library/library-render-availability';
import { createLibraryRepository } from '@/features/library/library-repository';
import {
  JPEG_FIXTURE,
  createFakeLibraryFilePort,
} from '@/features/library/library-test-support';
import {
  seedDeviceAssetState,
  seedDeviceLibraryAsset,
  seedLibraryProtection,
  viewDigest,
} from '@/features/library/library-view-test-support';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

async function withDatabase<T>(
  run: (database: SqlDatabasePort) => Promise<T>,
): Promise<T> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  try {
    return await run(database);
  } finally {
    native.close();
  }
}

function resolverFor(
  database: SqlDatabasePort,
  files: ReturnType<typeof createFakeLibraryFilePort>,
  unavailableCategory: LibraryFailureCategory,
) {
  const model = createLocalLibraryViewModel({ database });
  return {
    model,
    resolver: createLocalLibraryRenderResolver({
      repository: createLibraryRepository(database),
      model,
      files,
      unavailableCategory,
    }),
  };
}

describe('local library view', () => {
  test('lists every untrashed device row, joined to the projection of the scope updated last', async () => {
    await withDatabase(async (database) => {
      const local = viewDigest('local');
      const cloud = viewDigest('cloud');
      const deviceTrashed = viewDigest('deviceTrashed');
      const accountTrashed = viewDigest('accountTrashed');

      await seedDeviceLibraryAsset(database, {
        plaintextSha256: local,
        createdAt: 400,
      });
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: cloud,
        residency: 'cloud-only',
        createdAt: 300,
      });
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: deviceTrashed,
        residency: 'cached',
      });
      await seedDeviceAssetState(database, {
        plaintextSha256: deviceTrashed,
        deviceTrashedAt: 5,
      });
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: accountTrashed,
        createdAt: 100,
      });

      await seedLibraryProtection(database, {
        plaintextSha256: local,
        accountScope: 'scope-old',
        originalGenerationId: 'gen-old',
        updatedAt: 10,
      });
      await seedLibraryProtection(database, {
        plaintextSha256: local,
        accountScope: 'scope-new',
        originalGenerationId: 'gen-local',
        updatedAt: 20,
      });
      await seedLibraryProtection(database, {
        plaintextSha256: cloud,
        accountScope: 'scope-new',
        originalGenerationId: 'gen-cloud',
        updatedAt: 20,
      });
      await seedLibraryProtection(database, {
        plaintextSha256: accountTrashed,
        accountScope: 'scope-new',
        lifecycle: 'trash',
        updatedAt: 20,
      });

      const model = createLocalLibraryViewModel({ database });
      await expect(model.listEntries()).resolves.toEqual([
        expect.objectContaining({
          plaintextSha256: local,
          hasLocalOriginal: true,
          localOriginalUri: `file:///data/library/originals/${local}.jpg`,
          originalGenerationId: 'gen-local',
        }),
        expect.objectContaining({
          plaintextSha256: cloud,
          hasLocalOriginal: false,
          localOriginalUri: null,
          originalGenerationId: 'gen-cloud',
        }),
      ]);
      await expect(model.findEntry(deviceTrashed)).resolves.toBeNull();
      await expect(model.listTrashEntries()).resolves.toEqual([]);
    });
  });

  test('serves an original that is on disk for grid, detail, and full, with no session', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('local-original');
      const uri = `file:///library/originals/${digest}.jpg`;
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: uri,
      });
      const files = createFakeLibraryFilePort();
      files.files.set(uri, JPEG_FIXTURE);
      const { resolver } = resolverFor(database, files, 'auth_attention');

      for (const intent of ['grid', 'detail', 'full'] as const satisfies readonly LibraryRenderIntent[]) {
        await expect(resolver.resolve(digest, intent)).resolves.toEqual({
          kind: 'file',
          uri,
          tier: 'local-original',
          role: 'original',
        });
      }
      await expect(resolver.repairDerived(digest)).resolves.toBe(false);
    });
  });

  test('a row that still says local-original is not served once its file is gone', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('unflagged-gone');
      const uri = `file:///library/originals/${digest}.jpg`;
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: uri,
        missingOriginalSince: null,
      });
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        protection: 'protected',
        originalGenerationId: 'gen-1',
      });
      const { resolver } = resolverFor(
        database,
        createFakeLibraryFilePort(),
        'offline',
      );

      await expect(resolver.resolve(digest, 'grid')).resolves.toEqual({
        kind: 'unavailable',
        category: 'offline',
      });
    });
  });

  test('a flagged row is not served when its file is back on the phone', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('flagged-back');
      const uri = `file:///library/originals/${digest}.jpg`;
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: uri,
        missingOriginalSince: 7,
      });
      const files = createFakeLibraryFilePort();
      files.files.set(uri, JPEG_FIXTURE);
      // No projection, and the composition's category is `offline`: the
      // per-row rule still answers `object_missing`.
      const { model, resolver } = resolverFor(database, files, 'offline');

      await expect(resolver.resolve(digest, 'detail')).resolves.toEqual({
        kind: 'unavailable',
        category: 'object_missing',
      });
      await expect(model.findEntry(digest)).resolves.toMatchObject({
        hasLocalOriginal: false,
      });
    });
  });

  test('S2: a named thumbnail on the phone is the second tier for grid and detail, never for full', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('thumbnail-second-tier');
      const thumbnailUri = `file:///library/thumbnails/${digest}.webp`;
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'cloud-only',
      });
      await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
      const files = createFakeLibraryFilePort();
      files.files.set(thumbnailUri, JPEG_FIXTURE);
      const { resolver } = resolverFor(database, files, 'offline');

      for (const intent of ['grid', 'detail'] as const) {
        await expect(resolver.resolve(digest, intent)).resolves.toEqual({
          kind: 'file',
          uri: thumbnailUri,
          tier: 'local-thumbnail',
          role: 'thumbnail',
        });
      }
      await expect(resolver.resolve(digest, 'full')).resolves.toEqual({
        kind: 'unavailable',
        category: 'object_missing',
      });

      files.files.delete(thumbnailUri);
      await expect(resolver.resolve(digest, 'grid')).resolves.toEqual({
        kind: 'unavailable',
        category: 'object_missing',
      });
    });
  });

  test('S2: a local original on the phone still comes before a named thumbnail', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('original-before-thumbnail');
      const files = createFakeLibraryFilePort();
      const originalUri = files.resolveOriginal(`${digest}.jpg`);
      const thumbnailUri = files.resolveThumbnail(`${digest}.webp`);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: originalUri,
      });
      await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
      files.files.set(originalUri, JPEG_FIXTURE);
      files.files.set(thumbnailUri, JPEG_FIXTURE);
      const { resolver } = resolverFor(database, files, 'offline');

      for (const intent of ['grid', 'detail'] as const) {
        await expect(resolver.resolve(digest, intent)).resolves.toMatchObject({
          kind: 'file',
          uri: originalUri,
          tier: 'local-original',
        });
      }
    });
  });

  test('placeholder returns the local thumbnail even when the original is on disk', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('placeholder-thumbnail-first');
      const files = createFakeLibraryFilePort();
      const originalUri = files.resolveOriginal(`${digest}.jpg`);
      const thumbnailUri = files.resolveThumbnail(`${digest}.webp`);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: originalUri,
      });
      await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
      files.files.set(originalUri, JPEG_FIXTURE);
      files.files.set(thumbnailUri, JPEG_FIXTURE);
      const { resolver } = resolverFor(database, files, 'offline');

      await expect(resolver.resolve(digest, 'placeholder')).resolves.toEqual({
        kind: 'file',
        uri: thumbnailUri,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      });
      // Pins: grid and detail still prefer the original.
      await expect(resolver.resolve(digest, 'grid')).resolves.toEqual({
        kind: 'file',
        uri: originalUri,
        tier: 'local-original',
        role: 'original',
      });
      await expect(resolver.resolve(digest, 'detail')).resolves.toEqual({
        kind: 'file',
        uri: originalUri,
        tier: 'local-original',
        role: 'original',
      });
    });
  });

  test('placeholder is unavailable when the thumbnail file is missing, even though the original is on disk', async () => {
    await withDatabase(async (database) => {
      const digest = viewDigest('placeholder-thumbnail-missing');
      const files = createFakeLibraryFilePort();
      const originalUri = files.resolveOriginal(`${digest}.jpg`);
      const thumbnailUri = files.resolveThumbnail(`${digest}.webp`);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: originalUri,
      });
      await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
      files.files.set(originalUri, JPEG_FIXTURE);
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        protection: 'protected',
        originalGenerationId: 'gen-1',
      });
      const { resolver } = resolverFor(database, files, 'offline');

      await expect(resolver.resolve(digest, 'placeholder')).resolves.toEqual({
        kind: 'unavailable',
        category: 'offline',
      });
    });
  });

  test.each(['offline', 'auth_attention'] as const)(
    'placeholder serves the durable thumbnail of a cloud-only row (%s)',
    async (unavailableCategory) => {
      await withDatabase(async (database) => {
        const digest = viewDigest(`placeholder-cloud-only-${unavailableCategory}`);
        const thumbnailUri = `file:///library/thumbnails/${digest}.webp`;
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: digest,
          residency: 'cloud-only',
        });
        await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
        const files = createFakeLibraryFilePort();
        files.files.set(thumbnailUri, JPEG_FIXTURE);
        const { resolver } = resolverFor(database, files, unavailableCategory);

        await expect(resolver.resolve(digest, 'placeholder')).resolves.toEqual({
          kind: 'file',
          uri: thumbnailUri,
          tier: 'local-thumbnail',
          role: 'thumbnail',
        });
      });
    },
  );

  test.each(['offline', 'auth_attention'] as const)(
    'placeholder on a cloud-only row is unavailable with the composition category when the thumbnail file is gone (%s)',
    async (unavailableCategory) => {
      await withDatabase(async (database) => {
        const digest = viewDigest(`placeholder-cloud-gone-${unavailableCategory}`);
        const thumbnailUri = `file:///library/thumbnails/${digest}.webp`;
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: digest,
          residency: 'cloud-only',
        });
        await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
        await seedLibraryProtection(database, {
          plaintextSha256: digest,
          protection: 'protected',
          originalGenerationId: 'gen-1',
        });
        const { resolver } = resolverFor(
          database,
          createFakeLibraryFilePort(),
          unavailableCategory,
        );

        await expect(resolver.resolve(digest, 'placeholder')).resolves.toEqual({
          kind: 'unavailable',
          category: unavailableCategory,
        });
      });
    },
  );

  test.each(['offline', 'auth_attention'] as const)(
    'placeholder on a cloud-only row is object_missing when the thumbnail file is gone and no original generation is known (%s)',
    async (unavailableCategory) => {
      await withDatabase(async (database) => {
        const digest = viewDigest(`placeholder-cloud-unknown-${unavailableCategory}`);
        const thumbnailUri = `file:///library/thumbnails/${digest}.webp`;
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: digest,
          residency: 'cloud-only',
        });
        await createLibraryRepository(database).setLocalThumbnail(digest, thumbnailUri);
        const { resolver } = resolverFor(
          database,
          createFakeLibraryFilePort(),
          unavailableCategory,
        );

        await expect(resolver.resolve(digest, 'placeholder')).resolves.toEqual({
          kind: 'unavailable',
          category: 'object_missing',
        });
      });
    },
  );

  test.each([
    ['never bound, on the phone', 'none', true, 'auth_attention', 'file', false],
    ['never bound, gone', 'none', false, 'auth_attention', 'object_missing', true],
    ['disconnected or locked, the cloud holds it, gone', 'protected', false, 'auth_attention', 'auth_attention', false],
    ['unreachable at start, the cloud holds it, gone', 'protected', false, 'offline', 'offline', false],
    ['any lock, the cloud never had it, gone', 'unprotected', false, 'offline', 'object_missing', true],
    ['any lock, the cloud holds it, on the phone', 'protected', true, 'offline', 'file', false],
  ] as const)('§5.2a: %s', async (
    _cell,
    projection,
    onPhone,
    given,
    answer,
    repair,
  ) => {
    await withDatabase(async (database) => {
      const digest = viewDigest(_cell);
      const uri = `file:///library/originals/${digest}.jpg`;
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        residency: 'local-original',
        localOriginalUri: uri,
        missingOriginalSince: onPhone ? null : 7,
      });
      if (projection !== 'none') {
        await seedLibraryProtection(database, {
          plaintextSha256: digest,
          protection: projection,
          originalGenerationId: projection === 'protected' ? 'gen-1' : null,
        });
      }
      const files = createFakeLibraryFilePort();
      if (onPhone) files.files.set(uri, JPEG_FIXTURE);
      const { model, resolver } = resolverFor(database, files, given);

      const source = await resolver.resolve(digest, 'detail');
      const entry = await model.findEntry(digest);
      expect(entry).not.toBeNull();
      if (entry === null) return;

      expect(source.kind === 'file' ? 'file' : source.category).toBe(answer);
      expect(isOriginalUnrecoverable({
        hasLocalOriginal: entry.hasLocalOriginal,
        originalGenerationId: entry.originalGenerationId,
        resolved: source,
      })).toBe(repair);
    });
  });

  test.each<[string, ByosStatus | undefined, LibraryFailureCategory]>([
    ['no status', undefined, 'auth_attention'],
    ['unconfigured', { status: 'unconfigured' }, 'auth_attention'],
    ['locked vault_unreachable/network', {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'network',
    }, 'offline'],
    ['locked vault_unreachable/credential_rejected', {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'credential_rejected',
    }, 'auth_attention'],
    ['locked vault_unreachable/reauth_required/gdrive', {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'reauth_required',
      provider: 'gdrive',
    }, 'auth_attention'],
    ['locked password_required', {
      status: 'locked',
      reason: 'password_required',
    }, 'auth_attention'],
  ])('the category of a row the cloud holds: %s', (_label, status, category) => {
    expect(localUnavailableCategoryFor(status)).toBe(category);
  });
});
