jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { createImageRepository } from '@/features/images/image-repository';
import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  TEST_DEVICE_ID,
  TEST_MASTER_KEY,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import { createLibraryAccountMetadataSummaryRepository } from '@/features/library/library-account-metadata-summary';
import {
  attachAssetStateKey,
  encodeAssetState,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import { createLibraryCollectedPurge } from '@/features/library/library-collected-purge';
import { createLibraryEviction } from '@/features/library/library-eviction';
import { createLibraryImportService } from '@/features/library/library-import';
import { createLibraryIngestService } from '@/features/library/library-ingest';
import { encodeNoteName } from '@/features/library/library-note-name';
import { createLibraryReaddAuthorityLookup } from '@/features/library/library-readd-authority';
import { createAppendLibraryReconciliationPort } from '@/features/library/library-reconciliation-append';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { buildLibraryEncryptedMetadata } from '@/features/library/library-source-metadata';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import { createLibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import { createLibrarySyncEngine } from '@/features/library/library-sync-engine';
import { createLibrarySyncOutbox } from '@/features/library/library-sync-outbox';
import { createLibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import { projectAssetStateRecord } from '@/features/library/library-sync-projection';
import { PNG_FIXTURE } from '@/features/library/library-test-support';
import { readLibraryEntries } from '@/features/library/library-view-model';
import type { ImageCandidate } from '@/features/waifu/types';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const DIGEST_IMPORT = 'a'.repeat(64);
const DIGEST_PROVIDER = 'b'.repeat(64);
const ULID_OLDER = '01J8Z3M9A5N6P7Q8R9S0T1V2W1';
const ULID_NEWER = '01J8Z3M9A5N6P7Q8R9S0T1V2W9';

const PROVIDER_CANDIDATE: ImageCandidate = {
  providerKey: 'danbooru',
  providerItemId: '777001',
  canonicalSourceKey: 'danbooru:777001',
  perceptualHash: null,
  md5: '0123456789abcdef0123456789abcdef',
  remoteUrl: 'https://example.test/777001.png',
  sampleUrl: 'https://example.test/777001-sample.png',
  sourceUrl: 'https://example.test/posts/777001',
  artistName: 'artist-a3',
  artistUrl: 'https://example.test/artists/a3',
  width: 320,
  height: 240,
  byteSize: PNG_FIXTURE.byteLength,
  extension: 'png',
  dominantColor: '#223344',
  contentRating: 'explicit',
  nativeRating: 'e',
  isNsfw: true,
  isAnimated: false,
  tags: ['tag_a', 'tag_b'],
};

let harness: ActionsHarness;

beforeEach(async () => {
  resetExpoCryptoDouble();
  harness = await createActionsHarness();
});

afterEach(() => {
  harness.close();
});

async function sealImportMeta(
  assetId: string,
  digest: string,
  classification: 'safe' | 'adult' | 'unknown',
  collectedAt = 1_700_000_000_000,
): Promise<string> {
  const metadata = buildLibraryEncryptedMetadata(
    {
      plaintextSha256: digest,
      format: 'png',
      canonicalExtension: 'png',
      byteSize: PNG_FIXTURE.byteLength,
      width: 320,
      height: 240,
      origin: 'import',
      sourceImageId: null,
      collectedAt,
      importClassification: classification,
    },
    null,
  );
  return harness.cipher.sealMetadata({
    masterKey: TEST_MASTER_KEY,
    assetId,
    metadata,
  });
}

async function sealProviderMeta(
  assetId: string,
  digest: string,
  collectedAt = 1_650_000_000_000,
): Promise<string> {
  const metadata: LibraryEncryptedMetadata = buildLibraryEncryptedMetadata(
    {
      plaintextSha256: digest,
      format: 'png',
      canonicalExtension: 'png',
      byteSize: PNG_FIXTURE.byteLength,
      width: 320,
      height: 240,
      origin: 'provider',
      sourceImageId: 99,
      collectedAt,
      importClassification: 'unknown',
    },
    {
      providerKey: PROVIDER_CANDIDATE.providerKey,
      providerItemId: PROVIDER_CANDIDATE.providerItemId,
      canonicalSourceKey: PROVIDER_CANDIDATE.canonicalSourceKey,
      perceptualHash: PROVIDER_CANDIDATE.perceptualHash,
      md5: PROVIDER_CANDIDATE.md5,
      remoteUrl: PROVIDER_CANDIDATE.remoteUrl,
      sampleUrl: PROVIDER_CANDIDATE.sampleUrl ?? null,
      sourceUrl: PROVIDER_CANDIDATE.sourceUrl,
      artistName: PROVIDER_CANDIDATE.artistName,
      artistUrl: PROVIDER_CANDIDATE.artistUrl,
      extension: PROVIDER_CANDIDATE.extension,
      dominantColor: PROVIDER_CANDIDATE.dominantColor,
      contentRating: PROVIDER_CANDIDATE.contentRating ?? 'safe',
      nativeRating: PROVIDER_CANDIDATE.nativeRating ?? null,
      isNsfw: PROVIDER_CANDIDATE.isNsfw,
      isAnimated: PROVIDER_CANDIDATE.isAnimated,
      tags: PROVIDER_CANDIDATE.tags,
    },
  );
  return harness.cipher.sealMetadata({
    masterKey: TEST_MASTER_KEY,
    assetId,
    metadata,
  });
}

describe('N6-A3 whole-winning-state authority and convergence', () => {
  it('applies an append greater-ULID winner at equal or lower numeric revision for both import and provider assets, clearing absent refs and invalidating verification', async () => {
    const images = createImageRepository(harness.database);
    const writer = createLibrarySyncApplyWriter({
      database: harness.database,
      cipher: harness.cipher,
      clock: () => 5_000,
      restoreImage: async (candidate, savedAt) =>
        (await images.saveMirroredCandidate(candidate, savedAt)).id,
    });

    const importAssetId = harness.assetIdFor(DIGEST_IMPORT);
    const providerAssetId = harness.assetIdFor(DIGEST_PROVIDER);

    // 1. Apply an older append note at revision 2 that is protected with all three refs and verified.
    const olderImportNote = `state/${encodeNoteName({
      assetId: importAssetId,
      mutationId: ULID_OLDER,
      writer: 'dev-a',
    })}`;
    const olderProviderNote = `state/${encodeNoteName({
      assetId: providerAssetId,
      mutationId: ULID_OLDER,
      writer: 'dev-a',
    })}`;

    const olderImportMeta = await sealImportMeta(
      importAssetId,
      DIGEST_IMPORT,
      'safe',
      1_000,
    );
    const olderProviderMeta = await sealProviderMeta(
      providerAssetId,
      DIGEST_PROVIDER,
      2_000,
    );

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: importAssetId,
              revision: 2,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: ULID_OLDER,
              trashedAt: null,
              generations: {
                original: 'orig-old',
                thumbnail: 'thumb-old',
                preview: 'prev-old',
              },
              meta: olderImportMeta,
            },
            olderImportNote,
          ),
        )!,
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: providerAssetId,
              revision: 2,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: ULID_OLDER,
              trashedAt: null,
              generations: {
                original: 'orig-prov-old',
                thumbnail: 'thumb-prov-old',
                preview: 'prev-prov-old',
              },
              meta: olderProviderMeta,
            },
            olderProviderNote,
          ),
        )!,
      ],
    });

    // Stamp local verification on both revision-2 protected rows.
    await harness.protection.markVerified(
      TEST_ACCOUNT_SCOPE,
      importAssetId,
      DIGEST_IMPORT,
      5_100,
    );
    await harness.protection.markVerified(
      TEST_ACCOUNT_SCOPE,
      providerAssetId,
      DIGEST_PROVIDER,
      5_100,
    );

    // 2. Now a newer-ULID append note at revision 1 arrives (e.g. a concurrent
    //    device wrote a revision-1 unprotected collect or partial-ref state with
    //    a newer ULID). Whole-winning-state apply MUST accept the revision-1
    //    greater-ULID winner, clear absent refs, and clear `verified_at`.
    const newerImportNote = `state/${encodeNoteName({
      assetId: importAssetId,
      mutationId: ULID_NEWER,
      writer: 'dev-b',
    })}`;
    const newerProviderNote = `state/${encodeNoteName({
      assetId: providerAssetId,
      mutationId: ULID_NEWER,
      writer: 'dev-b',
    })}`;
    const newerImportMeta = await sealImportMeta(
      importAssetId,
      DIGEST_IMPORT,
      'adult',
      1_500,
    );

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: importAssetId,
              revision: 1, // Lower revision, greater ULID!
              generation: 1,
              lifecycle: 'active',
              protection: 'unprotected',
              lastMutationId: ULID_NEWER,
              trashedAt: null,
              generations: {},
              meta: newerImportMeta,
            },
            newerImportNote,
          ),
        )!,
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: providerAssetId,
              revision: 1, // Lower revision, greater ULID, protected with only original (no derived refs) and different original gen!
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: ULID_NEWER,
              trashedAt: null,
              generations: {
                original: 'orig-prov-new',
              },
              meta: olderProviderMeta,
            },
            newerProviderNote,
          ),
        )!,
      ],
    });

    const importProt = await harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      importAssetId,
    );
    expect(importProt).toMatchObject({
      revision: 1,
      protection: 'unprotected',
      originalGenerationId: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      appliedStateKey: newerImportNote,
    });

    const importDeviceRow = await harness.repository.findLocalAsset(DIGEST_IMPORT);
    expect(importDeviceRow).toMatchObject({
      origin: 'import',
      importClassification: 'adult',
      createdAt: 1_500,
    });

    const providerProt = await harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      providerAssetId,
    );
    expect(providerProt).toMatchObject({
      revision: 1,
      protection: 'protected',
      originalGenerationId: 'orig-prov-new',
      // Absent derived refs in the winning note cleared the old refs!
      thumbnailGenerationId: null,
      previewGenerationId: null,
      // Different originalGenerationId cleared verifiedAt!
      verifiedAt: null,
      appliedStateKey: newerProviderNote,
    });

    // 3. Replaying the older ULID note (even though its revision 2 > 1) MUST be rejected.
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: importAssetId,
              revision: 2,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: ULID_OLDER,
              trashedAt: null,
              generations: { original: 'orig-old' },
              meta: olderImportMeta,
            },
            olderImportNote,
          ),
        )!,
      ],
    });

    const afterReplay = await harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      importAssetId,
    );
    expect(afterReplay).toMatchObject({
      revision: 1,
      protection: 'unprotected',
      appliedStateKey: newerImportNote,
    });
    expect(
      (await harness.repository.findLocalAsset(DIGEST_IMPORT))
        ?.importClassification,
    ).toBe('adult');
  });

  it('converges §4.4 Direction 1 (local import loses to cloud provider record) and Direction 2 (local provider save loses to cloud import record)', async () => {
    const images = createImageRepository(harness.database);
    const writer = createLibrarySyncApplyWriter({
      database: harness.database,
      cipher: harness.cipher,
      clock: () => 8_000,
      restoreImage: async (candidate, savedAt) =>
        (await images.saveMirroredCandidate(candidate, savedAt)).id,
    });

    // --- Direction 1: Local import on this phone loses to cloud provider record ---
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_IMPORT,
      bytes: PNG_FIXTURE,
      importClassification: 'adult',
    });
    const assetId1 = harness.assetIdFor(DIGEST_IMPORT);
    await harness.database.run(
      `INSERT OR IGNORE INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
       ) VALUES (?, ?, ?, ?, 1000, 1000)`,
      [TEST_ACCOUNT_SCOPE, assetId1, DIGEST_IMPORT, TEST_DEVICE_ID],
    );

    const cloudProviderMeta = await sealProviderMeta(
      assetId1,
      DIGEST_IMPORT,
      1_600_000_000_000,
    );
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: assetId1,
              revision: 1,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: 'm1',
              trashedAt: null,
              generations: { original: 'gen-1' },
              meta: cloudProviderMeta,
            },
            's3:1',
          ),
        )!,
      ],
    });

    const convergedDir1 = await harness.repository.findLocalAsset(DIGEST_IMPORT);
    expect(convergedDir1).toMatchObject({
      origin: 'provider',
      importClassification: 'unknown',
      createdAt: 1_600_000_000_000,
      residency: 'local-original',
    });
    expect(convergedDir1?.sourceImageId).not.toBeNull();
    const restoredImg = await harness.database.getFirst<{
      provider_key: string;
      provider_item_id: string;
    }>(
      'SELECT provider_key, provider_item_id FROM images WHERE id = ?',
      [convergedDir1!.sourceImageId!],
    );
    expect(restoredImg?.provider_key).toBe('danbooru');
    expect(restoredImg?.provider_item_id).toBe('777001');

    // --- Direction 2: Local provider save loses to cloud import record ---
    const localSaved = await images.saveCandidate(
      {
        ...PROVIDER_CANDIDATE,
        providerItemId: '888002',
        canonicalSourceKey: 'danbooru:888002',
        md5: 'fedcba9876543210fedcba9876543210',
        remoteUrl: 'https://example.test/888002.png',
        sampleUrl: 'https://example.test/888002-sample.png',
        sourceUrl: 'https://example.test/posts/888002',
      },
      1_680_000_000_000,
    );
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_PROVIDER,
      bytes: PNG_FIXTURE,
    });
    await harness.database.run(
      `UPDATE device_library_assets
          SET origin = 'provider', source_image_id = ?
        WHERE plaintext_sha256 = ?`,
      [localSaved.id, DIGEST_PROVIDER],
    );
    const assetId2 = harness.assetIdFor(DIGEST_PROVIDER);
    await harness.database.run(
      `INSERT OR IGNORE INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
       ) VALUES (?, ?, ?, ?, 2000, 2000)`,
      [TEST_ACCOUNT_SCOPE, assetId2, DIGEST_PROVIDER, TEST_DEVICE_ID],
    );

    const cloudImportMeta = await sealImportMeta(
      assetId2,
      DIGEST_PROVIDER,
      'safe',
      1_610_000_000_000,
    );
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId: assetId2,
              revision: 1,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: 'm2',
              trashedAt: null,
              generations: { original: 'gen-2' },
              meta: cloudImportMeta,
            },
            's3:1',
          ),
        )!,
      ],
    });

    const convergedDir2 = await harness.repository.findLocalAsset(DIGEST_PROVIDER);
    expect(convergedDir2).toMatchObject({
      origin: 'import',
      sourceImageId: null,
      importClassification: 'safe',
      createdAt: 1_610_000_000_000,
      residency: 'local-original',
    });
    // And this phone's own saved `images` member is preserved in `library_provider_image_assets`!
    const assoc = await harness.database.getFirst<{
      image_id: number;
      plaintext_sha256: string;
    }>(
      'SELECT image_id, plaintext_sha256 FROM library_provider_image_assets WHERE image_id = ?',
      [localSaved.id],
    );
    expect(assoc).toEqual({
      image_id: localSaved.id,
      plaintext_sha256: DIGEST_PROVIDER,
    });
    const savedRow = await harness.database.getFirst<{ decision: string }>(
      'SELECT decision FROM images WHERE id = ?',
      [localSaved.id],
    );
    expect(savedRow?.decision).toBe('saved');
  });

  it('keeps device-deleted import membership suppressed during sync while learning summary, and restores library classification/time on explicit re-add', async () => {
    const digest = sha256OfFixture();
    await harness.seedLocalAsset({
      plaintextSha256: digest,
      bytes: PNG_FIXTURE,
      importClassification: 'safe',
    });
    const assetId = harness.assetIdFor(digest);
    await harness.database.run(
      `INSERT OR IGNORE INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
       ) VALUES (?, ?, ?, ?, 1000, 1000)`,
      [TEST_ACCOUNT_SCOPE, assetId, digest, TEST_DEVICE_ID],
    );

    const purge = createLibraryCollectedPurge({
      database: harness.database,
      files: harness.files,
      collect: { settled: async () => {}, drain: async () => {} },
    });
    await expect(purge.purgeImportedAsset(digest)).resolves.toBe(true);
    expect(await readLibraryEntries(harness.database, TEST_ACCOUNT_SCOPE)).toEqual([]);

    // Sync arrives with an active protected import record in the cloud ('safe', collectedAt = 123_456).
    const writer = createLibrarySyncApplyWriter({
      database: harness.database,
      cipher: harness.cipher,
      clock: () => 9_000,
    });
    const sealed = await sealImportMeta(assetId, digest, 'safe', 123_456);
    const openSpy = jest.spyOn(harness.cipher, 'openMetadata');

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId,
              revision: 2,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: 'm1',
              trashedAt: null,
              generations: { original: 'gen-1' },
              meta: sealed,
            },
            's3:2',
          ),
        )!,
      ],
    });
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Routine sync MUST NOT resurrect the deleted local membership:
    expect(await readLibraryEntries(harness.database, TEST_ACCOUNT_SCOPE)).toEqual([]);

    // Re-applying the same unchanged envelope does NOT call openMetadata again:
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projectAssetStateRecord(
          attachAssetStateKey(
            {
              assetId,
              revision: 3,
              generation: 1,
              lifecycle: 'active',
              protection: 'protected',
              lastMutationId: 'm2',
              trashedAt: null,
              generations: { original: 'gen-1' },
              meta: sealed,
            },
            's3:3',
          ),
        )!,
      ],
    });
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Summary row WAS learned:
    const summaryRepo = createLibraryAccountMetadataSummaryRepository({
      database: harness.database,
    });
    const summary = await summaryRepo.findByDigest(TEST_ACCOUNT_SCOPE, digest);
    expect(summary).toMatchObject({
      origin: 'import',
      importClassification: 'safe',
      collectedAt: 123_456,
    });

    // Now the user explicitly re-imports the same bytes from the picker with the OPPOSITE choice ('adult') — even offline!
    const lookup = createLibraryReaddAuthorityLookup({
      database: harness.database,
      session: null, // Offline / no live session needed because summary is already validated!
    });
    const ingest = createLibraryIngestService({
      files: harness.files,
      repository: harness.repository,
      decodeGate: {
        validate: async () => ({ width: 320, height: 240 }),
      },
      account: {
        accountScope: async () => TEST_ACCOUNT_SCOPE,
        vaultMasterKey: async () => TEST_MASTER_KEY,
        deviceId: async () => TEST_DEVICE_ID,
      },
      newMutationId: () => 'mut-readd',
      lookupReaddAuthority: lookup,
      clock: () => 20_000,
    });
    const importService = createLibraryImportService({
      picker: { pickImages: async () => [] },
      files: harness.files,
      ingest,
    });

    const pickerUri = 'file:///cache/ImagePicker/readd.png';
    harness.port.files.set(pickerUri, PNG_FIXTURE);
    const batchResult = await importService.importConfirmedFiles({
      uris: [pickerUri],
      classification: 'adult',
    });

    expect(batchResult).toMatchObject({
      selected: 1,
      ingested: 1,
      duplicates: 0,
      rejected: [],
      retainedClassificationCount: 1,
    });

    const restoredAsset = await harness.repository.findLocalAsset(digest);
    expect(restoredAsset).toMatchObject({
      origin: 'import',
      importClassification: 'safe', // Retained library's 'safe' over batch's 'adult'
      createdAt: 123_456, // Retained library's original time
      importDeletedAt: null,
    });
  });

  it('distinguishes network, password_locked, reauth_required, and integrity when re-add lacks a validated summary', async () => {
    const digest = sha256OfFixture();
    const assetId = harness.assetIdFor(digest);
    await harness.database.run(
      `INSERT OR IGNORE INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
       ) VALUES (?, ?, ?, ?, 1000, 1000)`,
      [TEST_ACCOUNT_SCOPE, assetId, digest, TEST_DEVICE_ID],
    );

    const netLookup = createLibraryReaddAuthorityLookup({
      database: harness.database,
      byosStatus: {
        status: 'locked',
        reason: 'vault_unreachable',
        detail: 'network',
      },
    });
    await expect(netLookup(digest)).resolves.toEqual({
      status: 'unavailable',
      reason: 'network',
    });

    const pwLookup = createLibraryReaddAuthorityLookup({
      database: harness.database,
      byosStatus: {
        status: 'locked',
        reason: 'password_required',
      },
    });
    await expect(pwLookup(digest)).resolves.toEqual({
      status: 'unavailable',
      reason: 'password_locked',
    });

    const reauthLookup = createLibraryReaddAuthorityLookup({
      database: harness.database,
      byosStatus: {
        status: 'locked',
        reason: 'vault_unreachable',
        detail: 'reauth_required',
        provider: 'gdrive',
      },
    });
    await expect(reauthLookup(digest)).resolves.toEqual({
      status: 'unavailable',
      reason: 'reauth_required',
    });

    const corruptLookup = createLibraryReaddAuthorityLookup({
      database: harness.database,
      byosStatus: {
        status: 'locked',
        reason: 'meta_corrupt',
        detail: 'malformed',
      },
    });
    await expect(corruptLookup(digest)).resolves.toEqual({
      status: 'unavailable',
      reason: 'integrity',
    });
  });

  it('performs one-time upgrade backfill from library_remote_state_cache and retries failed apply by invalidating the asset index entry', async () => {
    const store = createMemoryCloudObjectStore();
    const cacheRepo = createLibraryRemoteStateCacheRepository({
      database: harness.database,
    });
    const remoteIndex = bindLibraryRemoteStateIndex(
      cacheRepo,
      async () => TEST_ACCOUNT_SCOPE,
    );
    const reconciliation = createAppendLibraryReconciliationPort(
      store,
      remoteIndex,
      { writer: TEST_DEVICE_ID, now: () => 10_000 },
    );

    const digest = sha256OfFixture();
    const assetId = harness.assetIdFor(digest);
    await harness.seedLocalAsset({
      plaintextSha256: digest,
      bytes: PNG_FIXTURE,
      importClassification: 'unknown',
    });
    await harness.database.run(
      `INSERT OR IGNORE INTO library_account_assets (
         account_scope, asset_id, plaintext_sha256, device_id, enrolled_at, updated_at
       ) VALUES (?, ?, ?, ?, 1000, 1000)`,
      [TEST_ACCOUNT_SCOPE, assetId, digest, TEST_DEVICE_ID],
    );

    // Pre-populate the remote state cache + store with a valid v3 'adult' note,
    // simulating an app upgrade where the note was already indexed before v23.
    const noteName = encodeNoteName({
      assetId,
      mutationId: ULID_NEWER,
      writer: 'dev-b',
    });
    const sealed = await sealImportMeta(assetId, digest, 'adult', 777_000);
    const record: LibraryAssetStateRecord = {
      assetId,
      revision: 1,
      generation: 1,
      lifecycle: 'active',
      protection: 'protected',
      lastMutationId: ULID_NEWER,
      trashedAt: null,
      generations: { original: 'gen-1' },
      meta: sealed,
    };
    await store.put(`state/${noteName}`, encodeAssetState(record), 'application/json');
    await cacheRepo.upsertMany(TEST_ACCOUNT_SCOPE, [
      { key: `state/${noteName}`, etag: 'note', record },
    ]);

    let failRestoreOnce = false;
    const applyWriter = createLibrarySyncApplyWriter({
      database: harness.database,
      cipher: harness.cipher,
      clock: () => 12_000,
      restoreImage: async () => {
        if (failRestoreOnce) {
          failRestoreOnce = false;
          throw new Error('transient restore failure');
        }
        return 101;
      },
    });
    const engine = createLibrarySyncEngine({
      session: harness.session,
      cloud: {
        submitMutations: async () => ({
          cursor: 0 as const,
          minBaseCursor: 0 as const,
          results: [],
        }),
      },
      reconciliation,
      cipher: harness.cipher,
      cursors: createLibrarySyncCursorStore({ database: harness.database }),
      apply: applyWriter,
      reconciler: createLibrarySyncReconciler({
        database: harness.database,
        protection: harness.protection,
        files: harness.files,
      }),
      outbox: createLibrarySyncOutbox({
        database: harness.database,
        newMutationId: () => 'm-1',
      }),
      database: harness.database,
    });

    const openSpy = jest.spyOn(harness.cipher, 'openMetadata');
    // First sync: discoverChanges() sees 0 misses (note is already indexed),
    // but the one-time upgrade backfill opens the cached record and populates
    // the summary + updates the local asset to 'adult'!
    await engine.sync();
    expect(openSpy).toHaveBeenCalledTimes(1);
    const summaryRepo = createLibraryAccountMetadataSummaryRepository({
      database: harness.database,
    });
    expect(
      (await summaryRepo.findByAssetId(TEST_ACCOUNT_SCOPE, assetId))
        ?.importClassification,
    ).toBe('adult');
    expect(
      (await harness.repository.findLocalAsset(digest))?.importClassification,
    ).toBe('adult');

    // Second sync: unchanged store and backfill already completed -> 0 openMetadata calls!
    await engine.sync();
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Now test failed apply retry: a new provider asset arrives, its Phase 3
    // `restoreImage` fails on the first sync, so `reconciliation.invalidateAsset`
    // evicts its index entry and the second sync retries and succeeds!
    const provAssetId = harness.assetIdFor(DIGEST_PROVIDER);
    const provNoteName = encodeNoteName({
      assetId: provAssetId,
      mutationId: ULID_NEWER,
      writer: 'dev-b',
    });
    const provMeta = await sealProviderMeta(provAssetId, DIGEST_PROVIDER, 888_000);
    await store.put(
      `state/${provNoteName}`,
      encodeAssetState({
        assetId: provAssetId,
        revision: 1,
        generation: 1,
        lifecycle: 'active',
        protection: 'protected',
        lastMutationId: ULID_NEWER,
        trashedAt: null,
        generations: { original: 'gen-p' },
        meta: provMeta,
      }),
      'application/json',
    );

    failRestoreOnce = true;
    await engine.sync();
    expect(
      (await harness.repository.findLocalAsset(DIGEST_PROVIDER))?.sourceImageId,
    ).toBeNull();
    expect(failRestoreOnce).toBe(false);

    // Next sync: because the failed asset was invalidated in the index,
    // discoverChanges() re-emits it and Phase 3 succeeds!
    await engine.sync();
    expect(
      (await harness.repository.findLocalAsset(DIGEST_PROVIDER))?.sourceImageId,
    ).toBe(101);
  });

  it('blocks eviction when a newer discovered winner is unverified or pending apply', async () => {
    const digest = sha256OfFixture();
    const assetId = harness.assetIdFor(digest);
    await harness.seedLocalAsset({
      plaintextSha256: digest,
      bytes: PNG_FIXTURE,
      importClassification: 'safe',
    });
    await harness.repository.setLocalThumbnail(
      digest,
      `file:///data/library/thumbnails/${digest}.webp`,
    );

    const store = createMemoryCloudObjectStore();
    const cacheRepo = createLibraryRemoteStateCacheRepository({
      database: harness.database,
    });
    const remoteIndex = bindLibraryRemoteStateIndex(
      cacheRepo,
      async () => TEST_ACCOUNT_SCOPE,
    );
    const appendPort = createAppendLibraryReconciliationPort(
      store,
      remoteIndex,
      { writer: TEST_DEVICE_ID, now: () => 10_000 },
    );

    const oldNoteName = encodeNoteName({
      assetId,
      mutationId: ULID_OLDER,
      writer: 'dev-a',
    });
    const oldRecord: LibraryAssetStateRecord = {
      assetId,
      revision: 2,
      generation: 1,
      lifecycle: 'active',
      protection: 'protected',
      lastMutationId: ULID_OLDER,
      trashedAt: null,
      generations: {
        original: 'gen-orig-1',
        thumbnail: 'gen-thumb-1',
        preview: 'gen-prev-1',
      },
    };
    await store.put(`state/${oldNoteName}`, encodeAssetState(oldRecord), 'application/json');
    await appendPort.discoverChanges();

    await harness.protection.markProtectedAndVerified({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: digest,
      lifecycle: 'active',
      generation: 1,
      revision: 2,
      originalGenerationId: 'gen-orig-1',
      originalCiphertextBytes: 100,
      thumbnailGenerationId: 'gen-thumb-1',
      previewGenerationId: 'gen-prev-1',
      verifiedAt: 5_000,
      appliedStateKey: `state/${oldNoteName}`,
    });

    // Now a newer append note arrives in `appendPort` (e.g. discovery indexed
    // it, or it is unprotected / different original generation, before apply
    // or verification has completed).
    const newNoteName = encodeNoteName({
      assetId,
      mutationId: ULID_NEWER,
      writer: 'dev-b',
    });
    const newRecord: LibraryAssetStateRecord = {
      assetId,
      revision: 1,
      generation: 1,
      lifecycle: 'active',
      protection: 'unprotected',
      lastMutationId: ULID_NEWER,
      trashedAt: null,
      generations: {},
    };
    await store.put(`state/${newNoteName}`, encodeAssetState(newRecord), 'application/json');
    await appendPort.discoverChanges();

    const eviction = createLibraryEviction({
      database: harness.database,
      files: harness.files,
      port: harness.port,
      repository: harness.repository,
      thumbnails: {
        ensureLocalThumbnail: async () => ({
          status: 'ensured',
          uri: `file:///data/library/thumbnails/${digest}.webp`,
          source: 'existing',
        }),
      },
      fillDerived: async () => ({ status: 'complete' }),
      isCloudOnly: async () => true,
      isAuthorityCurrent: async (accountScope, sha) => {
        const proj = await harness.protection.findByDigest(accountScope, sha);
        if (proj === null || proj.verifiedAt === null) return false;
        const head = await appendPort.getAssetHead(proj.assetId);
        if (head === null) return true;
        return proj.appliedStateKey === `state/${newNoteName}`;
      },
      changes: { emit: () => {} },
    });

    const res = await eviction.evict(TEST_ACCOUNT_SCOPE);
    expect(res).toEqual({ reclaimed: 0, evicted: 0, kept: 1 });
    expect((await harness.repository.findLocalAsset(digest))?.residency).toBe(
      'local-original',
    );
  });
});

function sha256OfFixture(): string {
  const { sha256PlaintextHex } = require('@/features/library/library-identity');
  return sha256PlaintextHex(PNG_FIXTURE);
}
