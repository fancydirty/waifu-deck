import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  createLibraryRepository,
  type LibraryRepository,
} from '@/features/library/library-repository';
import type {
  DeviceLibraryAsset,
  LibraryCollectMetadata,
} from '@/features/library/library-types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const scope = 'f'.repeat(32);
const assetId = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const deviceId = 'device-abc';
const originalUri = `file:///library/originals/${digest}.jpg`;

function asset(overrides: Partial<DeviceLibraryAsset> = {}): DeviceLibraryAsset {
  return {
    plaintextSha256: digest,
    format: 'jpeg',
    canonicalExtension: 'jpg',
    byteSize: 2048,
    width: 800,
    height: 600,
    origin: 'provider',
    sourceImageId: 42,
    localOriginalUri: originalUri,
    residency: 'local-original',
    protectEligible: true,
    missingOriginalSince: null,
    localThumbnailUri: null,
    importClassification: 'unknown',
    importDeletedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function metadata(
  overrides: Partial<LibraryCollectMetadata> = {},
): LibraryCollectMetadata {
  return {
    assetId,
    plaintextSha256: digest,
    format: 'jpeg',
    byteSize: 2048,
    width: 800,
    height: 600,
    origin: 'provider',
    sourceImageId: 42,
    collectedAt: 1_000,
    ...overrides,
  };
}

async function openRepository(): Promise<{
  nativeDatabase: DatabaseSync;
  database: SqlDatabasePort;
  repository: LibraryRepository;
}> {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);
  return {
    nativeDatabase,
    database,
    repository: createLibraryRepository(database),
  };
}

describe('library repository layer A', () => {
  test('commits a local asset with no account row and no outbox row', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      const result = await repository.commitLocalAsset({ asset: asset() });

      expect(result).toEqual({ status: 'committed', asset: asset() });
      await expect(repository.findLocalAsset(digest)).resolves.toEqual(asset());
      await expect(repository.listLocalAssets()).resolves.toEqual([asset()]);
      await expect(
        database.getAll<{ asset_id: string }>(
          'SELECT asset_id FROM library_account_assets',
        ),
      ).resolves.toEqual([]);
      await expect(
        database.getAll<{ mutation_id: string }>(
          'SELECT mutation_id FROM library_outbox',
        ),
      ).resolves.toEqual([]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('is idempotent for the same plaintext digest', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset() });
      const second = await repository.commitLocalAsset({
        asset: asset({ createdAt: 9_000, updatedAt: 9_000, origin: 'import' }),
      });

      expect(second.status).toBe('duplicate');
      expect(second.asset.createdAt).toBe(1_000);
      expect(second.asset.origin).toBe('provider');
      await expect(repository.listLocalAssets()).resolves.toHaveLength(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('lists referenced originals and flags rows whose file disappeared', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset() });

      await expect(repository.listReferencedOriginalUris())
        .resolves.toEqual([originalUri]);

      await repository.markOriginalMissing(digest, 7_777);
      await expect(repository.findLocalAsset(digest)).resolves.toMatchObject({
        missingOriginalSince: 7_777,
        localOriginalUri: originalUri,
        residency: 'local-original',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('isOriginalNamed answers only for a usable row naming the uri', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await expect(repository.isOriginalNamed(originalUri)).resolves.toBe(false);
      await repository.commitLocalAsset({ asset: asset() });
      await expect(repository.isOriginalNamed(originalUri)).resolves.toBe(true);
      await expect(repository.isOriginalNamed(`${originalUri}.other`))
        .resolves.toBe(false);

      await repository.markOriginalMissing(digest, 7_777);
      await expect(repository.isOriginalNamed(originalUri)).resolves.toBe(false);

      await database.run(
        `UPDATE device_library_assets
            SET missing_original_since = NULL, residency = 'cached'`,
      );
      await expect(repository.isOriginalNamed(originalUri)).resolves.toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('adoptLocalOriginal adopts a flagged or cloud-only row, never a cached one', async () => {
    // Board #27 S1b Task 3 (spec §5.6): a duplicate ingest's fresh bytes
    // become the original of a row that has no usable one. The first image
    // keeps its pointer; a device-trashed row is never adopted.
    const { nativeDatabase, repository } = await openRepository();
    const flagged = '1'.repeat(64);
    const cloud = '2'.repeat(64);
    const trashed = '3'.repeat(64);
    const uriF = `file:///library/originals/${flagged}.jpg`;
    const uriC = `file:///library/originals/${cloud}.jpg`;
    const uriT = `file:///library/originals/${trashed}.jpg`;
    try {
      await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: flagged,
          localOriginalUri: uriF,
          missingOriginalSince: 7,
          sourceImageId: 5,
        }),
      });
      await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: cloud,
          residency: 'cloud-only',
          localOriginalUri: null,
          sourceImageId: 6,
        }),
      });
      await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: trashed,
          residency: 'cached',
          localOriginalUri: null,
          sourceImageId: 7,
        }),
      });

      await expect(repository.adoptLocalOriginal({ plaintextSha256: flagged, localOriginalUri: uriF, at: 99 })).resolves
        .toMatchObject({ residency: 'local-original', localOriginalUri: uriF, missingOriginalSince: null, updatedAt: 99, sourceImageId: 5 });
      await expect(repository.adoptLocalOriginal({ plaintextSha256: cloud, localOriginalUri: uriC, at: 99 })).resolves
        .toMatchObject({ residency: 'local-original', localOriginalUri: uriC, sourceImageId: 6 });
      await expect(repository.adoptLocalOriginal({ plaintextSha256: trashed, localOriginalUri: uriT, at: 99 })).resolves.toBeNull();
      await expect(repository.findLocalAsset(trashed)).resolves.toMatchObject({ residency: 'cached', localOriginalUri: null });
      await expect(repository.adoptLocalOriginal({ plaintextSha256: 'f'.repeat(64), localOriginalUri: uriF, at: 99 })).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('board #27 S2: setLocalThumbnail', () => {
  const thumbnailUri = `file:///data/library/thumbnails/${digest}.webp`;

  test('names the thumbnail and changes nothing else, updated_at included', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      const otherDigest = 'c'.repeat(64);
      await repository.commitLocalAsset({ asset: asset() });
      await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: otherDigest,
          sourceImageId: 43,
          localOriginalUri: `file:///library/originals/${otherDigest}.jpg`,
        }),
      });
      const before = await repository.findLocalAsset(digest);
      expect(before).toEqual(asset());
      expect(before?.localThumbnailUri).toBeNull();

      await expect(
        repository.setLocalThumbnail(digest, thumbnailUri),
      ).resolves.toBe(true);

      const after = await repository.findLocalAsset(digest);
      expect(after?.localThumbnailUri).toBe(thumbnailUri);
      expect(after).toEqual({ ...before, localThumbnailUri: thumbnailUri });
      // Only the named row: the other asset still names no thumbnail.
      await expect(repository.findLocalAsset(otherDigest)).resolves.toMatchObject({
        localThumbnailUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a committed asset keeps the thumbnail it names', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset({ localThumbnailUri: thumbnailUri }) });
      await expect(repository.findLocalAsset(digest)).resolves.toEqual(
        asset({ localThumbnailUri: thumbnailUri }),
      );
    } finally {
      nativeDatabase.close();
    }
  });

  test('answers false when no row has the digest', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await expect(
        repository.setLocalThumbnail('f'.repeat(64), thumbnailUri),
      ).resolves.toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('library repository layer B', () => {
  test('commits the account asset and the collect intent with a device id', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset() });
      const result = await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '11111111-1111-4111-8111-111111111111',
        metadata: metadata(),
        at: 1_000,
      });

      expect(result).toEqual({
        status: 'committed',
        accountAsset: {
          accountScope: scope,
          assetId,
          plaintextSha256: digest,
          deviceId,
          enrolledAt: 1_000,
          updatedAt: 1_000,
        },
      });
      await expect(repository.findAccountAsset(scope, digest)).resolves.toEqual({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        enrolledAt: 1_000,
        updatedAt: 1_000,
      });
      await expect(repository.listOutbox(scope)).resolves.toEqual([{
        mutationId: '11111111-1111-4111-8111-111111111111',
        accountScope: scope,
        deviceId,
        assetId,
        kind: 'collect',
        baseRevision: null,
        observedGeneration: null,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        localMetadata: metadata(),
        createdAt: 1_000,
        updatedAt: 1_000,
      }]);
      await expect(
        database.getAll<{ device_id: string; encrypted_payload: unknown }>(
          'SELECT device_id, encrypted_payload FROM library_outbox',
        ),
      ).resolves.toEqual([{ device_id: deviceId, encrypted_payload: null }]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('never enrolls one plaintext twice inside one account', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset() });
      await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '11111111-1111-4111-8111-111111111111',
        metadata: metadata(),
        at: 1_000,
      });
      const second = await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId: 'device-later',
        mutationId: '22222222-2222-4222-8222-222222222222',
        metadata: metadata({ collectedAt: 9_000 }),
        at: 9_000,
      });

      expect(second.status).toBe('duplicate');
      // The durable intent keeps the device that actually created it.
      expect(second.accountAsset.deviceId).toBe(deviceId);
      expect(second.accountAsset.enrolledAt).toBe(1_000);
      await expect(repository.listOutbox(scope)).resolves.toHaveLength(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('restores a collect intent that went missing under an enrolled asset', async () => {
    // K6-3a: `library-protect-action.ts` needs the durable `collect` intent to
    // create the asset remotely, and without it `ensureCollected` records the
    // terminal `object_missing` and the image is retried and re-failed every
    // round forever. An enrolled asset whose intent is gone is therefore a
    // repairable state, not a duplicate to shrug at — this is the one place
    // that owns the account row and the intent together, so it is the one
    // place that can restore the pair.
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset() });
      await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '11111111-1111-4111-8111-111111111111',
        metadata: metadata(),
        at: 1_000,
      });
      // Whatever destroyed it — the K6-3a drain race, an interrupted purge —
      // the asset stays enrolled while its intent is gone.
      await database.run(`DELETE FROM library_outbox WHERE kind = 'collect'`);
      await expect(repository.listOutbox(scope)).resolves.toEqual([]);

      const repaired = await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '44444444-4444-4444-8444-444444444444',
        metadata: metadata({ collectedAt: 9_000 }),
        at: 9_000,
      });

      expect(repaired.status).toBe('duplicate');
      // The enrolment itself is untouched: it still records the device and
      // moment this asset actually entered the account.
      expect(repaired.accountAsset.deviceId).toBe(deviceId);
      expect(repaired.accountAsset.enrolledAt).toBe(1_000);
      // But the intent the account needs exists again.
      const outbox = await repository.listOutbox(scope);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        mutationId: '44444444-4444-4444-8444-444444444444',
        kind: 'collect',
        state: 'pending',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('rolls Layer B back without touching the local asset', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    try {
      await repository.commitLocalAsset({ asset: asset() });
      await database.run(
        `INSERT INTO library_outbox (
          mutation_id, account_scope, device_id, asset_id, kind, base_revision,
          observed_generation, state, attempt_count, next_attempt_at,
          last_error_code, local_metadata_json, encrypted_payload,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'collect', NULL, NULL, 'pending', 0, NULL, NULL,
          '{}', NULL, 1, 1)`,
        ['33333333-3333-4333-8333-333333333333', scope, deviceId, assetId],
      );

      await expect(repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '44444444-4444-4444-8444-444444444444',
        metadata: metadata(),
        at: 2_000,
      })).rejects.toMatchObject({ code: 'database_failed' });

      await expect(repository.findAccountAsset(scope, digest))
        .resolves.toBeNull();
      await expect(repository.findLocalAsset(digest)).resolves.toEqual(asset());
    } finally {
      nativeDatabase.close();
    }
  });

  test('gives two accounts on one device unrelated keyed identities', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const otherScope = 'e'.repeat(32);
    const otherAssetId = 'c'.repeat(64);
    try {
      await repository.commitLocalAsset({ asset: asset() });
      await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '11111111-1111-4111-8111-111111111111',
        metadata: metadata(),
        at: 1_000,
      });
      await repository.commitCollect({
        accountScope: otherScope,
        assetId: otherAssetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '55555555-5555-4555-8555-555555555555',
        metadata: metadata({ assetId: otherAssetId }),
        at: 2_000,
      });

      await expect(repository.listOutbox(scope)).resolves.toHaveLength(1);
      await expect(repository.listOutbox(otherScope)).resolves.toHaveLength(1);
      await expect(repository.findAccountAsset(otherScope, digest))
        .resolves.toMatchObject({ assetId: otherAssetId });
      // Both accounts share the one durable local original.
      await expect(repository.listLocalAssets()).resolves.toHaveLength(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('reports local assets that this account has not enrolled yet', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const otherDigest = 'd'.repeat(64);
    try {
      await repository.commitLocalAsset({ asset: asset() });
      await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: otherDigest,
          localOriginalUri: `file:///library/originals/${otherDigest}.jpg`,
          createdAt: 2_000,
          updatedAt: 2_000,
        }),
      });

      await expect(repository.listLocalAssetsMissingEnrollment(scope))
        .resolves.toHaveLength(2);

      await repository.commitCollect({
        accountScope: scope,
        assetId,
        plaintextSha256: digest,
        deviceId,
        mutationId: '11111111-1111-4111-8111-111111111111',
        metadata: metadata(),
        at: 1_000,
      });

      const pending = await repository.listLocalAssetsMissingEnrollment(scope);
      expect(pending.map((row) => row.plaintextSha256)).toEqual([otherDigest]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('commits provider association into library_provider_image_assets and preserves existing importClassification on duplicate', async () => {
    const { nativeDatabase, database, repository } = await openRepository();
    const importDigest = 'e'.repeat(64);
    try {
      await repository.commitLocalAsset({
        asset: asset({ origin: 'provider', sourceImageId: 42 }),
      });
      await expect(
        database.getAll(
          'SELECT image_id, plaintext_sha256 FROM library_provider_image_assets',
        ),
      ).resolves.toEqual([
        { image_id: 42, plaintext_sha256: digest },
      ]);

      await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: importDigest,
          origin: 'import',
          sourceImageId: null,
          importClassification: 'adult',
          localOriginalUri: `file:///library/originals/${importDigest}.jpg`,
        }),
      });
      const dup = await repository.commitLocalAsset({
        asset: asset({
          plaintextSha256: importDigest,
          origin: 'import',
          sourceImageId: null,
          importClassification: 'safe',
          localOriginalUri: `file:///library/originals/${importDigest}.jpg`,
        }),
      });
      expect(dup.status).toBe('duplicate');
      expect(dup.asset.importClassification).toBe('adult');
    } finally {
      nativeDatabase.close();
    }
  });
});
