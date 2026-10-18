jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  TEST_DEVICE_ID,
  TEST_MASTER_KEY,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
import {
  createLibrarySyncApplyWriter,
  type LibrarySyncApplyWriter,
  type LibrarySyncRestoreImage,
} from '@/features/library/library-sync-apply';
import type { LibraryProjectedAsset } from '@/features/library/library-sync-types';
import { createImageRepository } from '@/features/images/image-repository';
import type { ImageCandidate } from '@/features/waifu/types';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const DIGEST_REMOTE = 'c'.repeat(64);
const DIGEST_LOCAL = 'd'.repeat(64);
const GENERATION = '11111111-1111-4111-8111-111111111111';
const BYTES = Uint8Array.from([9, 9, 9, 9]);

let harness: ActionsHarness;
let writer: LibrarySyncApplyWriter;
let now: number;

function projected(
  overrides: Partial<LibraryProjectedAsset> & Pick<LibraryProjectedAsset, 'assetId'>,
): LibraryProjectedAsset {
  return {
    revision: 1,
    generation: 1,
    lifecycle: 'active',
    protection: 'unprotected',
    encryptedMetadata: null,
    trashedAtMs: null,
    originalGenerationId: null,
    originalCiphertextBytes: null,
    thumbnailGenerationId: null,
    previewGenerationId: null,
    ...overrides,
  };
}

function metadataFor(
  plaintextSha256: string,
  overrides: Partial<LibraryEncryptedMetadata> = {},
): LibraryEncryptedMetadata {
  return {
    version: 1,
    plaintextSha256,
    format: 'jpeg',
    canonicalExtension: 'jpg',
    byteSize: 4,
    width: 10,
    height: 10,
    origin: 'import',
    sourceImageId: 4321,
    collectedAt: 555,
    tags: [],
    ...overrides,
  };
}

/**
 * C3b: the `source` block a v2 envelope carries for a provider asset. Every
 * field `restorableImageFrom` treats as required is present, so this projects
 * into an insertable candidate.
 */
const V2_SOURCE = {
  providerKey: 'danbooru' as const,
  providerItemId: '12345',
  canonicalSourceKey: 'danbooru:12345',
  perceptualHash: null,
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  remoteUrl: 'https://example.test/o.jpg',
  sampleUrl: 'https://example.test/s.jpg',
  sourceUrl: 'https://example.test/post',
  artistName: 'someone',
  artistUrl: 'https://example.test/artist',
  extension: 'jpg',
  dominantColor: '#AABBCC',
  contentRating: 'explicit' as const,
  nativeRating: 'e',
  isNsfw: true,
  isAnimated: false,
  tags: ['maid', 'solo'] as readonly string[],
};

function v2MetadataFor(plaintextSha256: string): LibraryEncryptedMetadata {
  return metadataFor(plaintextSha256, {
    version: 2,
    origin: 'provider',
    tags: ['maid', 'solo'],
    source: V2_SOURCE,
  });
}

/** A writer that also owns the C3b rebuild port. */
function writerWithRestore(restoreImage: LibrarySyncRestoreImage): LibrarySyncApplyWriter {
  return createLibrarySyncApplyWriter({
    database: harness.database,
    cipher: harness.cipher,
    clock: () => now,
    restoreImage,
  });
}

/** Fails the Nth `run` inside a transaction so a partial batch can be proved. */
function failingAfter(
  database: SqlDatabasePort,
  successfulRuns: number,
): SqlDatabasePort {
  return {
    ...database,
    transaction: (task) => database.transaction(async (inner) => {
      let remaining = successfulRuns;
      return task({
        ...inner,
        run: async (source, params) => {
          if (remaining <= 0) throw new Error('injected mid-transaction failure');
          remaining -= 1;
          return inner.run(source, params);
        },
      });
    }),
  };
}

beforeEach(async () => {
  resetExpoCryptoDouble();
  harness = await createActionsHarness();
  now = 5_000;
  writer = createLibrarySyncApplyWriter({
    database: harness.database,
    cipher: harness.cipher,
    clock: () => now,
  });
});

afterEach(() => {
  harness.close();
});

describe('library sync apply writer', () => {
  it('materializes an asset this device has never held', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: metadataFor(DIGEST_REMOTE),
    });

    const report = await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 3,
        protection: 'protected',
        encryptedMetadata: sealed,
      })],
    });

    expect(report).toMatchObject({ written: 1, materialized: 1 });
    await expect(harness.database.getFirst(
      `SELECT residency, local_original_uri, protect_eligible, source_image_id,
              created_at
         FROM device_library_assets WHERE plaintext_sha256 = ?`,
      [DIGEST_REMOTE],
    )).resolves.toEqual({
      residency: 'cloud-only',
      local_original_uri: null,
      protect_eligible: 1,
      // The remote row's sourceImageId points at another device's images table.
      source_image_id: null,
      created_at: 555,
    });
    await expect(harness.database.getFirst(
      `SELECT device_id FROM library_account_assets
        WHERE account_scope = ? AND asset_id = ?`,
      [TEST_ACCOUNT_SCOPE, assetId],
    )).resolves.toEqual({ device_id: TEST_DEVICE_ID });
    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      plaintextSha256: DIGEST_REMOTE,
      protection: 'protected',
      revision: 3,
      verifiedAt: null,
    });
  });

  it('flags an oversize materialized asset as not protect-eligible', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: metadataFor(DIGEST_REMOTE, {
        byteSize: LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES + 1,
      }),
    });
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });
    await expect(harness.database.getFirst(
      'SELECT protect_eligible FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    )).resolves.toEqual({ protect_eligible: 0 });
  });

  it('commits every row of one batch, or none of them', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: metadataFor(DIGEST_REMOTE),
    });
    const brittle = createLibrarySyncApplyWriter({
      database: failingAfter(harness.database, 1),
      cipher: harness.cipher,
      clock: () => now,
    });

    await expect(brittle.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, revision: 8, encryptedMetadata: sealed })],
    })).rejects.toThrow('injected mid-transaction failure');

    await expect(harness.database.getAll(
      'SELECT plaintext_sha256 FROM device_library_assets',
    )).resolves.toEqual([]);
    await expect(harness.database.getAll(
      'SELECT asset_id FROM library_asset_protection',
    )).resolves.toEqual([]);
  });

  it('refuses to regress an asset with a late lower revision', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    const page = (revision: number, lifecycle: 'active' | 'trash') => ({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, revision, lifecycle })],
    });

    await writer.apply(page(20, 'trash'));
    await writer.apply(page(4, 'active'));

    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({ revision: 20, lifecycle: 'trash' });
  });

  it('skips an unopenable metadata envelope and destroys nothing', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const report = await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: 'not-an-envelope' })],
    });
    expect(report).toMatchObject({
      written: 0,
      materialized: 0,
      skippedIntegrity: 1,
    });
    await expect(harness.database.getAll(
      'SELECT asset_id FROM library_asset_protection',
    )).resolves.toEqual([]);
  });

  it('skips a purge for an asset this device never held', async () => {
    const report = await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId: harness.assetIdFor(DIGEST_REMOTE),
        revision: 77,
        lifecycle: 'purged',
        encryptedMetadata: null,
      })],
    });
    expect(report).toMatchObject({ written: 0, skippedUnknownAsset: 1 });
  });

  it('clears the original reference and verification when protection ends', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await harness.protection.markProtectedAndVerified({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: DIGEST_LOCAL,
      lifecycle: 'active',
      generation: 1,
      revision: 2,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 120,
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
      verifiedAt: 999,
    });

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 5,
        protection: 'protected',
        generation: 1,
      })],
    });
    // A feed row carries no object ids; a still-protected same-generation
    // asset keeps both its reference and its local verification.
    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 120,
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
      verifiedAt: 999,
    });

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 6,
        protection: 'unprotected',
        generation: 1,
      })],
    });
    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      protection: 'unprotected',
      originalGenerationId: null,
      originalCiphertextBytes: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
    });
  });

  it('projected null never clears stored non-null derived refs', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await harness.protection.markProtectedAndVerified({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: DIGEST_LOCAL,
      lifecycle: 'active',
      generation: 1,
      revision: 2,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 120,
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
      verifiedAt: 999,
    });

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 5,
        protection: 'protected',
        generation: 1,
        thumbnailGenerationId: null,
        previewGenerationId: null,
      })],
    });

    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
    });
  });

  it('projected non-null overwrites stored derived refs', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await harness.protection.markProtectedAndVerified({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: DIGEST_LOCAL,
      lifecycle: 'active',
      generation: 1,
      revision: 2,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 120,
      thumbnailGenerationId: 'old-thumb',
      previewGenerationId: 'old-preview',
      verifiedAt: 999,
    });

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 5,
        protection: 'protected',
        generation: 1,
        thumbnailGenerationId: 'thumb-gen',
        previewGenerationId: 'preview-gen',
      })],
    });

    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
    });
  });

  it('object_refs_revision written only by sweep, not by feed page apply', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await harness.protection.markProtectedAndVerified({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: DIGEST_LOCAL,
      lifecycle: 'active',
      generation: 1,
      revision: 2,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 120,
      thumbnailGenerationId: 'thumb-gen',
      previewGenerationId: 'preview-gen',
      verifiedAt: 999,
    });
    await harness.database.run(
      `UPDATE library_asset_protection
          SET object_refs_revision = 42
        WHERE account_scope = ? AND asset_id = ?`,
      [TEST_ACCOUNT_SCOPE, assetId],
    );

    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 9,
        protection: 'protected',
        generation: 1,
        thumbnailGenerationId: 'new-thumb',
        previewGenerationId: 'new-preview',
      })],
    });

    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      revision: 9,
      thumbnailGenerationId: 'new-thumb',
      previewGenerationId: 'new-preview',
      objectRefsRevision: 42,
    });
  });

  it('drops local verification when the generation advances', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await harness.protection.markProtectedAndVerified({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: DIGEST_LOCAL,
      lifecycle: 'active',
      generation: 1,
      revision: 2,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 120,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 999,
    });
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 9,
        protection: 'protected',
        generation: 2,
      })],
    });
    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({ generation: 2, verifiedAt: null });
  });

  it('tombstones on an explicit purged record without touching local bytes', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, revision: 2 })],
    });

    // Under BYOS the deletion signal is a *present* record that says
    // `purged` (the state object is never DELETEd), so it arrives as an
    // ordinary projected row. Absence from a listing means nothing here.
    const report = await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({
        assetId,
        revision: 40,
        lifecycle: 'purged',
        protection: 'unprotected',
      })],
    });

    expect(report).toMatchObject({ written: 1 });
    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({
      lifecycle: 'purged',
      protection: 'unprotected',
      revision: 40,
      verifiedAt: null,
    });
    // Invariant 3: the durable local original is still exactly where it was.
    await expect(harness.database.getFirst(
      'SELECT local_original_uri FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_LOCAL],
    )).resolves.toEqual({
      local_original_uri: `file:///data/library/originals/${DIGEST_LOCAL}.jpg`,
    });
    expect(
      harness.port.files.has(`file:///data/library/originals/${DIGEST_LOCAL}.jpg`),
    ).toBe(true);
  });

  it('leaves a local row alone when no record mentions the asset', async () => {
    await harness.seedLocalAsset({
      plaintextSha256: DIGEST_LOCAL,
      bytes: BYTES,
    });
    const assetId = harness.assetIdFor(DIGEST_LOCAL);
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, revision: 2 })],
    });

    // An empty batch is not a deletion. A remote state object that failed to
    // list, raced a concurrent write, or aged past tombstone retention must
    // never be read as "the account deleted this".
    await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [],
    });

    await expect(
      harness.protection.findByAssetId(TEST_ACCOUNT_SCOPE, assetId),
    ).resolves.toMatchObject({ lifecycle: 'active' });
  });
  it('rebuilds an images row for a restorable asset and links the soft pointer', async () => {
    // C3b: an asset another device collected must become an ordinary
    // collection item here, not a separate cloud-only tile. The collection
    // screen keys that entirely off `source_image_id` being non-NULL.
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const metadata = v2MetadataFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata,
    });
    const restored: number[] = [];
    const result = await writerWithRestore(async (_candidate, savedAt) => {
      restored.push(savedAt);
      return 4242;
    }).apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });

    expect(result.materialized).toBe(1);
    expect(restored).toEqual([metadata.collectedAt]);
    const row = await harness.database.getFirst<{ source_image_id: number | null }>(
      'SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    );
    expect(row?.source_image_id).toBe(4242);
  });

  it('leaves the pointer NULL for a v1 envelope so the cloud-only tile still shows it', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: metadataFor(DIGEST_REMOTE),
    });
    const restoreImage = jest.fn();
    const result = await writerWithRestore(restoreImage).apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });

    expect(result.materialized).toBe(1);
    expect(restoreImage).not.toHaveBeenCalled();
    const row = await harness.database.getFirst<{ source_image_id: number | null }>(
      'SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    );
    expect(row?.source_image_id).toBeNull();
  });

  it('still materializes the asset when the images insert fails', async () => {
    // The mirror row is the durable artifact; a rebuild failure must not lose
    // the asset or abort the whole reconciliation batch.
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: v2MetadataFor(DIGEST_REMOTE),
    });
    const result = await writerWithRestore(async () => {
      throw new Error('boom');
    }).apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });

    expect(result.materialized).toBe(1);
    const row = await harness.database.getFirst<{ source_image_id: number | null }>(
      'SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    );
    expect(row?.source_image_id).toBeNull();
  });

  it('does not re-run the rebuild for an asset already materialized', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: v2MetadataFor(DIGEST_REMOTE),
    });
    const restoreImage = jest.fn(async () => 4242);
    const restoringWriter = writerWithRestore(restoreImage);
    const input = {
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    };

    await restoringWriter.apply(input);
    await restoringWriter.apply(input);

    expect(restoreImage).toHaveBeenCalledTimes(1);
  });

  /**
   * The test above only proves the enrollment short-circuit: on a second apply
   * the asset is already in `library_account_assets`, so it never re-enters
   * `materializations` and Phase 3 iterates an empty list. That path cannot
   * distinguish a guarded rebuild from an unguarded one. This test forces a
   * genuine second materialization of an asset whose pointer is already set --
   * the exact state the NULL-pointer guard and the `AND source_image_id IS
   * NULL` clause on the UPDATE exist to defend -- by dropping only the
   * enrollment row and leaving the local mirror row, pointer intact.
   */
  it('does not rebuild a second images row when re-materializing a linked asset', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: v2MetadataFor(DIGEST_REMOTE),
    });
    let nextImageId = 4242;
    const restoreImage = jest.fn(async () => nextImageId++);
    const restoringWriter = writerWithRestore(restoreImage);
    const input = {
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    };

    const first = await restoringWriter.apply(input);
    expect(first.materialized).toBe(1);
    expect(restoreImage).toHaveBeenCalledTimes(1);

    // Forget the enrollment only. `device_library_assets` keeps its row and its
    // filled pointer, so the next apply really does re-materialize.
    await harness.database.run(
      'DELETE FROM library_account_assets WHERE account_scope = ? AND asset_id = ?',
      [TEST_ACCOUNT_SCOPE, assetId],
    );

    const second = await restoringWriter.apply(input);
    expect(second.materialized).toBe(1);

    // The pointer is already set, so the rebuild must not run a second time and
    // must not be overwritten with a fresh row id.
    expect(restoreImage).toHaveBeenCalledTimes(1);
    const row = await harness.database.getFirst<{ source_image_id: number | null }>(
      'SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    );
    expect(row?.source_image_id).toBe(4242);
  });

  it('a restored saved row is not duplicated when sync materializes the same asset', async () => {
    // Spec §5.4 E-row 32. The device row is inserted with a null pointer, so
    // phase 3 rebuilds; the restored ready file is the one that stays.
    const images = createImageRepository(harness.database);
    const candidate: ImageCandidate = {
      providerKey: V2_SOURCE.providerKey,
      providerItemId: V2_SOURCE.providerItemId,
      canonicalSourceKey: V2_SOURCE.canonicalSourceKey,
      perceptualHash: V2_SOURCE.perceptualHash,
      md5: V2_SOURCE.md5,
      remoteUrl: V2_SOURCE.remoteUrl,
      sampleUrl: V2_SOURCE.sampleUrl,
      sourceUrl: V2_SOURCE.sourceUrl,
      artistName: V2_SOURCE.artistName,
      artistUrl: V2_SOURCE.artistUrl,
      width: 10,
      height: 10,
      byteSize: 4,
      extension: V2_SOURCE.extension,
      dominantColor: V2_SOURCE.dominantColor,
      contentRating: V2_SOURCE.contentRating,
      nativeRating: V2_SOURCE.nativeRating,
      isNsfw: V2_SOURCE.isNsfw,
      isAnimated: V2_SOURCE.isAnimated,
      tags: [...V2_SOURCE.tags],
    };
    const restored = await images.saveCandidate(candidate, 1_000);
    await expect(
      images.markDownloadReady(restored.id, 'file:///documents/collection/1.jpg'),
    ).resolves.toBe(true);

    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: v2MetadataFor(DIGEST_REMOTE),
    });
    await writerWithRestore(async (restoredCandidate, savedAt) => {
      const stored = await images.saveMirroredCandidate(restoredCandidate, savedAt);
      return stored.id;
    }).apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });

    await expect(harness.database.getAll(
      `SELECT id, download_state, local_uri FROM images WHERE provider_key = 'danbooru' AND provider_item_id = '12345'`,
    )).resolves.toEqual([{
      id: restored.id,
      download_state: 'ready',
      local_uri: 'file:///documents/collection/1.jpg',
    }]);
    await expect(harness.database.getAll(
      'SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    )).resolves.toEqual([{ source_image_id: restored.id }]);
  });

  /**
   * Phase 3 runs after the write transaction commits, so its read of the
   * pointer and its UPDATE are not atomic with each other. If anything fills
   * the pointer in that window -- the user collecting the same image locally
   * while a sync is in flight is the ordinary way this happens -- the UPDATE
   * must not clobber it, or the concurrently created `images` row is orphaned
   * and the collection shows the wrong row. The `AND source_image_id IS NULL`
   * clause on the UPDATE is what makes the write lose that race safely; this
   * test drives the interleaving through the rebuild port itself.
   */
  it('does not clobber a pointer filled while the rebuild was in flight', async () => {
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: v2MetadataFor(DIGEST_REMOTE),
    });
    const result = await writerWithRestore(async () => {
      // Stand in for a concurrent local collect landing between Phase 3's
      // NULL-pointer read and its UPDATE.
      await harness.database.run(
        'UPDATE device_library_assets SET source_image_id = ? WHERE plaintext_sha256 = ?',
        [777, DIGEST_REMOTE],
      );
      return 4242;
    }).apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });

    expect(result.materialized).toBe(1);
    const row = await harness.database.getFirst<{ source_image_id: number | null }>(
      'SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_REMOTE],
    );
    expect(row?.source_image_id).toBe(777);
  });

  /**
   * Every other rebuild test injects a `jest.fn()` that never touches the
   * database, so none of them exercises the port the app actually binds. The
   * production binding is `images.saveCandidate`, which opens its own
   * `database.transaction` on the same serialized port this writer is already
   * holding — a nested acquire that can never be granted. This test uses the
   * real repository so that shape is covered rather than stubbed away.
   */
  it('rebuilds through the real repository binding without deadlocking', async () => {
    const images = createImageRepository(harness.database);
    const assetId = harness.assetIdFor(DIGEST_REMOTE);
    const sealed = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId,
      metadata: v2MetadataFor(DIGEST_REMOTE),
    });
    const restoringWriter = writerWithRestore(async (candidate, savedAt) => {
      const stored = await images.saveCandidate(candidate, savedAt);
      return stored.id;
    });

    await restoringWriter.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [projected({ assetId, encryptedMetadata: sealed })],
    });

    const row = await harness.database.getFirst<{ source_image_id: number | null }>(
      `SELECT source_image_id FROM device_library_assets WHERE plaintext_sha256 = ?`,
      [DIGEST_REMOTE],
    );
    const restoredId = row?.source_image_id ?? null;
    expect(restoredId).not.toBeNull();
    const stored = await harness.database.getFirst<{ provider_item_id: string }>(
      `SELECT provider_item_id FROM images WHERE id = ?`,
      [restoredId],
    );
    expect(stored?.provider_item_id).toBe('12345');
    await expect(
      harness.database.getFirst(
        `SELECT image_id, plaintext_sha256 FROM library_provider_image_assets WHERE image_id = ?`,
        [restoredId],
      ),
    ).resolves.toEqual({
      image_id: restoredId,
      plaintext_sha256: DIGEST_REMOTE,
    });
  });

  it.each(['safe', 'adult', 'unknown'] as const)(
    'materializes a v3 import envelope with import_classification=%s, source_image_id=null, and no images row even if a stray source block is attached',
    async (importClassification) => {
      const assetId = harness.assetIdFor(DIGEST_REMOTE);
      const sealed = await harness.cipher.sealMetadata({
        masterKey: TEST_MASTER_KEY,
        assetId,
        metadata: metadataFor(DIGEST_REMOTE, {
          version: 3,
          origin: 'import',
          sourceImageId: null,
          importClassification,
          source: V2_SOURCE,
        }),
      });
      const restoreImage = jest.fn(async () => 9999);
      const report = await writerWithRestore(restoreImage).apply({
        accountScope: TEST_ACCOUNT_SCOPE,
        deviceId: TEST_DEVICE_ID,
        masterKey: TEST_MASTER_KEY,
        assets: [
          projected({
            assetId,
            revision: 4,
            protection: 'protected',
            encryptedMetadata: sealed,
          }),
        ],
      });

      expect(report).toMatchObject({
        written: 1,
        materialized: 1,
        skippedIntegrity: 0,
      });
      expect(restoreImage).not.toHaveBeenCalled();
      await expect(
        harness.database.getFirst(
          `SELECT origin, source_image_id, import_classification, import_deleted_at
             FROM device_library_assets WHERE plaintext_sha256 = ?`,
          [DIGEST_REMOTE],
        ),
      ).resolves.toEqual({
        origin: 'import',
        source_image_id: null,
        import_classification: importClassification,
        import_deleted_at: null,
      });
      await expect(
        harness.database.getAll('SELECT id FROM images'),
      ).resolves.toEqual([]);
    },
  );

  it('materializes v1 and v2 import envelopes without importClassification as unknown', async () => {
    for (const [version, digest] of [
      [1, '1'.repeat(64)],
      [2, '2'.repeat(64)],
    ] as const) {
      const assetId = harness.assetIdFor(digest);
      const sealed = await harness.cipher.sealMetadata({
        masterKey: TEST_MASTER_KEY,
        assetId,
        metadata: metadataFor(digest, { version, origin: 'import' }),
      });
      const report = await writer.apply({
        accountScope: TEST_ACCOUNT_SCOPE,
        deviceId: TEST_DEVICE_ID,
        masterKey: TEST_MASTER_KEY,
        assets: [projected({ assetId, revision: 1, encryptedMetadata: sealed })],
      });
      expect(report).toMatchObject({ written: 1, materialized: 1 });
      await expect(
        harness.database.getFirst(
          'SELECT import_classification FROM device_library_assets WHERE plaintext_sha256 = ?',
          [digest],
        ),
      ).resolves.toEqual({ import_classification: 'unknown' });
    }
  });

  it('skips envelopes with invalid importClassification, unsupported version, or mismatched derived assetId as integrity failures', async () => {
    const digestInvalidClass = '3'.repeat(64);
    const assetIdInvalidClass = harness.assetIdFor(digestInvalidClass);
    const sealedInvalidClass = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: assetIdInvalidClass,
      metadata: {
        ...metadataFor(digestInvalidClass, { version: 3 }),
        importClassification: 'nsfw' as unknown as 'safe',
      },
    });

    const digestInvalidVersion = '4'.repeat(64);
    const assetIdInvalidVersion = harness.assetIdFor(digestInvalidVersion);
    const sealedInvalidVersion = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: assetIdInvalidVersion,
      metadata: {
        ...metadataFor(digestInvalidVersion),
        version: 4 as unknown as 3,
      },
    });

    const digestMismatched = '5'.repeat(64);
    const wrongAssetId = harness.assetIdFor('6'.repeat(64));
    const sealedMismatched = await harness.cipher.sealMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: wrongAssetId,
      metadata: metadataFor(digestMismatched, { version: 3 }),
    });

    const report = await writer.apply({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      masterKey: TEST_MASTER_KEY,
      assets: [
        projected({ assetId: assetIdInvalidClass, encryptedMetadata: sealedInvalidClass }),
        projected({ assetId: assetIdInvalidVersion, encryptedMetadata: sealedInvalidVersion }),
        projected({ assetId: wrongAssetId, encryptedMetadata: sealedMismatched }),
      ],
    });

    expect(report).toMatchObject({
      projected: 3,
      written: 0,
      materialized: 0,
      skippedIntegrity: 3,
    });
    await expect(
      harness.database.getAll('SELECT plaintext_sha256 FROM device_library_assets'),
    ).resolves.toEqual([]);
  });

  it.each(['safe', 'adult', 'unknown'] as const)(
    'materializes v3 importClassification=%s in encryption-off mode (createPassthroughLibraryCipher)',
    async (importClassification) => {
      const passthrough = createPassthroughLibraryCipher();
      const passthroughWriter = createLibrarySyncApplyWriter({
        database: harness.database,
        cipher: passthrough,
        clock: () => now,
      });
      const assetId = harness.assetIdFor(DIGEST_REMOTE);
      const sealed = await passthrough.sealMetadata({
        masterKey: TEST_MASTER_KEY,
        assetId,
        metadata: metadataFor(DIGEST_REMOTE, {
          version: 3,
          origin: 'import',
          sourceImageId: null,
          importClassification,
        }),
      });

      const report = await passthroughWriter.apply({
        accountScope: TEST_ACCOUNT_SCOPE,
        deviceId: TEST_DEVICE_ID,
        masterKey: TEST_MASTER_KEY,
        assets: [
          projected({
            assetId,
            revision: 2,
            protection: 'protected',
            encryptedMetadata: sealed,
          }),
        ],
      });

      expect(report).toMatchObject({
        written: 1,
        materialized: 1,
        skippedIntegrity: 0,
      });
      await expect(
        harness.database.getFirst(
          'SELECT origin, import_classification FROM device_library_assets WHERE plaintext_sha256 = ?',
          [DIGEST_REMOTE],
        ),
      ).resolves.toEqual({
        origin: 'import',
        import_classification: importClassification,
      });
    },
  );
});
