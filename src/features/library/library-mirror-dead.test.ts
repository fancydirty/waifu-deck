import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createImageRepository } from '@/features/images/image-repository';
import {
  listLocalMirrorDeadSavedImageIds,
  listMirrorDeadSavedImageIds,
  createMirrorDeadSavedImageIds,
} from '@/features/library/library-mirror-dead';
import {
  VIEW_TEST_ACCOUNT_SCOPE,
  seedDeviceAssetState,
  seedDeviceLibraryAsset,
  seedLibraryProtection,
  viewDigest,
} from '@/features/library/library-view-test-support';
import type { WaifuImage } from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const candidate = (id: number): WaifuImage => ({
  id,
  providerKey: 'waifu_im',
  providerItemId: String(id),
  canonicalSourceKey: null,
  perceptualHash: null,
  md5: null,
  remoteUrl: `https://cdn.example.com/${id}.webp`,
  sourceUrl: null,
  artistName: null,
  artistUrl: null,
  width: 1200,
  height: 1800,
  byteSize: 456_789,
  extension: '.webp',
  dominantColor: '#aabbcc',
  isNsfw: false,
  isAnimated: false,
  tags: [],
});

async function openDatabase(): Promise<Readonly<{
  native: DatabaseSync;
  database: SqlDatabasePort;
  repository: ReturnType<typeof createImageRepository>;
}>> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  return { native, database, repository: createImageRepository(database) };
}

/** A saved row sitting at the state a library hand-over leaves it in. */
async function saveMirrored(
  repository: ReturnType<typeof createImageRepository>,
  id: number,
) {
  return repository.saveMirroredCandidate(
    { ...candidate(id), id: undefined } as never,
    100 + id,
  );
}

describe('vault selector (listMirrorDeadSavedImageIds)', () => {
  test('picks a mirrored saved row whose only asset is cloud-only with no protection row', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const dead = await saveMirrored(repository, 11);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-dead'),
        sourceImageId: dead.id,
        residency: 'cloud-only',
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([dead.id]);
    } finally {
      native.close();
    }
  });

  test('skips a mirrored row whose asset holds a committed cloud original generation', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const healed = await saveMirrored(repository, 12);
      const digest = viewDigest('n10-healed');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        sourceImageId: healed.id,
        residency: 'cloud-only',
      });
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        accountScope: VIEW_TEST_ACCOUNT_SCOPE,
        protection: 'protected',
        originalGenerationId: 'gen-n10',
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('skips a mirrored row whose asset holds a usable local original', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const local = await saveMirrored(repository, 13);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-local'),
        sourceImageId: local.id,
        residency: 'local-original',
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('picks a mirrored row whose local original the missing pass has flagged', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const flagged = await saveMirrored(repository, 14);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-flagged'),
        sourceImageId: flagged.id,
        residency: 'local-original',
        missingOriginalSince: 500,
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([flagged.id]);
    } finally {
      native.close();
    }
  });

  test('skips ready, pending and failed rows however dead their asset is', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      await repository.insertCandidates([candidate(21), candidate(22), candidate(23)]);
      await repository.activateNext(100);
      await repository.decide(21, 'saved', 101);
      await repository.decide(22, 'saved', 102);
      await repository.decide(23, 'saved', 103);
      await repository.markDownloadReady(21, 'file:///documents/collection/21.webp', {
        remoteUrl: candidate(21).remoteUrl,
        extension: candidate(21).extension,
      });
      await repository.markDownloadFailed(
        22,
        'download_failed',
        { remoteUrl: candidate(22).remoteUrl, extension: candidate(22).extension },
        'transient',
      );
      for (const [id, digest] of [
        [21, 'n10-ready'],
        [22, 'n10-failed'],
        [23, 'n10-pending'],
      ] as const) {
        await seedDeviceLibraryAsset(database, {
          plaintextSha256: viewDigest(digest),
          sourceImageId: id,
          residency: 'cloud-only',
        });
      }

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('skips an image whose only asset is account-trashed', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const trashed = await saveMirrored(repository, 15);
      const digest = viewDigest('n10-trash');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        sourceImageId: trashed.id,
        residency: 'cloud-only',
      });
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        accountScope: VIEW_TEST_ACCOUNT_SCOPE,
        lifecycle: 'trash',
        protection: 'protected',
        originalGenerationId: 'gen-n10-trash',
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('skips an image whose only asset is device-trashed', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const trashed = await saveMirrored(repository, 16);
      const digest = viewDigest('n10-device-trash');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        sourceImageId: trashed.id,
        residency: 'cloud-only',
      });
      await seedDeviceAssetState(database, {
        plaintextSha256: digest,
        deviceTrashedAt: 5,
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('leaves an image with one dead and one usable asset alone (two-copies-safe)', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const mixed = await saveMirrored(repository, 17);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-mixed-dead'),
        sourceImageId: mixed.id,
        residency: 'cloud-only',
      });
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-mixed-alive'),
        sourceImageId: mixed.id,
        residency: 'local-original',
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('a trashed extra asset neither rescues nor blocks an otherwise dead image', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const dead = await saveMirrored(repository, 18);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-extra-dead'),
        sourceImageId: dead.id,
        residency: 'cloud-only',
      });
      const trashedDigest = viewDigest('n10-extra-trash');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: trashedDigest,
        sourceImageId: dead.id,
        residency: 'local-original',
      });
      await seedDeviceAssetState(database, {
        plaintextSha256: trashedDigest,
        deviceTrashedAt: 5,
      });

      await expect(
        listMirrorDeadSavedImageIds(database, VIEW_TEST_ACCOUNT_SCOPE),
      ).resolves.toEqual([dead.id]);
    } finally {
      native.close();
    }
  });
});

describe('session-gated vault member (createMirrorDeadSavedImageIds)', () => {
  test('answers [] while the session is null', async () => {
    const { native, database } = await openDatabase();
    try {
      const list = createMirrorDeadSavedImageIds({
        database,
        session: { current: async () => null },
      });

      await expect(list()).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });

  test('scopes the vault query by the session account scope', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const dead = await saveMirrored(repository, 19);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-session'),
        sourceImageId: dead.id,
        residency: 'cloud-only',
      });
      await seedLibraryProtection(database, {
        plaintextSha256: viewDigest('n10-session'),
        accountScope: 'scope-other',
        protection: 'protected',
        originalGenerationId: 'gen-other-scope',
      });
      const list = createMirrorDeadSavedImageIds({
        database,
        session: {
          current: async () => ({
            deviceId: 'device-n10',
            masterKey: new Uint8Array(32).fill(3),
            accountScope: VIEW_TEST_ACCOUNT_SCOPE,
          }),
        },
      });

      await expect(list()).resolves.toEqual([dead.id]);
    } finally {
      native.close();
    }
  });
});

describe('local selector (listLocalMirrorDeadSavedImageIds)', () => {
  test('picks the dead mirrored row with no protection table involvement', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const dead = await saveMirrored(repository, 31);
      const digest = viewDigest('n10-local-core');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: digest,
        sourceImageId: dead.id,
        residency: 'cloud-only',
      });
      // A vault-era projection row says nothing in local mode: there is no
      // cloud to serve the original from.
      await seedLibraryProtection(database, {
        plaintextSha256: digest,
        protection: 'protected',
        originalGenerationId: 'gen-leftover',
      });

      await expect(
        listLocalMirrorDeadSavedImageIds(database),
      ).resolves.toEqual([dead.id]);
    } finally {
      native.close();
    }
  });

  test('skips a usable local original and an all-device-trashed image', async () => {
    const { native, database, repository } = await openDatabase();
    try {
      const local = await saveMirrored(repository, 32);
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: viewDigest('n10-core-local'),
        sourceImageId: local.id,
        residency: 'local-original',
      });
      const trashed = await saveMirrored(repository, 33);
      const trashedDigest = viewDigest('n10-core-trash');
      await seedDeviceLibraryAsset(database, {
        plaintextSha256: trashedDigest,
        sourceImageId: trashed.id,
        residency: 'cloud-only',
      });
      await seedDeviceAssetState(database, {
        plaintextSha256: trashedDigest,
        deviceTrashedAt: 5,
      });

      await expect(listLocalMirrorDeadSavedImageIds(database)).resolves.toEqual([]);
    } finally {
      native.close();
    }
  });
});
