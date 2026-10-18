import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import {
  createLibraryActionOutbox,
  hasUnknownOutcome,
  type LibraryActionOutbox,
} from '@/features/library/library-action-outbox';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import {
  createLibraryProtectionRepository,
  DOWNLOAD_TERMINAL_CATEGORIES,
  UPLOAD_TERMINAL_CATEGORIES,
  type LibraryProtectionRepository,
} from '@/features/library/library-protection-repository';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const SCOPE = 'scope-1';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const ASSET_A = 'c'.repeat(64);
const ASSET_B = 'd'.repeat(64);
const GENERATION = '11111111-1111-4111-8111-111111111111';

type Harness = {
  native: DatabaseSync;
  database: SqlDatabasePort;
  protection: LibraryProtectionRepository;
  outbox: LibraryActionOutbox;
};

async function insertLocal(
  database: SqlDatabasePort,
  digest: string,
  byteSize = 100,
  eligible = 1,
): Promise<void> {
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', ?, 10, 10, 'import', NULL, ?,
       'local-original', ?, NULL, 1, 1)`,
    [digest, byteSize, `file:///data/library/originals/${digest}.jpg`, eligible],
  );
}

/** Same row as `insertLocal` but with a caller-chosen residency. */
async function insertWithResidency(
  database: SqlDatabasePort,
  digest: string,
  residency: 'local-original' | 'cached' | 'cloud-only',
): Promise<void> {
  const uri = residency === 'cloud-only'
    ? null
    : `file:///data/library/originals/${digest}.jpg`;
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, ?, ?, 1, NULL, 1, 1)`,
    [digest, uri, residency],
  );
}

/** Active, protected account projection for `digest`, keyed by the digest. */
async function markProtected(
  protection: LibraryProtectionRepository,
  digest: string,
  originalCiphertextBytes: number | null = 100,
): Promise<void> {
  await protection.upsertProtection({
    accountScope: SCOPE,
    assetId: digest,
    plaintextSha256: digest,
    lifecycle: 'active',
    protection: 'protected',
    generation: 1,
    revision: 1,
    originalGenerationId: GENERATION,
    originalCiphertextBytes,
    thumbnailGenerationId: null,
    previewGenerationId: null,
    verifiedAt: null,
    failureCategory: null,
    trashedAt: null,
  });
}

/** Protected, but with no sealed original object for a device to fetch. */
async function markProtectedWithoutOriginal(
  protection: LibraryProtectionRepository,
  digest: string,
): Promise<void> {
  await protection.upsertProtection({
    accountScope: SCOPE,
    assetId: digest,
    plaintextSha256: digest,
    lifecycle: 'active',
    protection: 'protected',
    generation: 1,
    revision: 1,
    originalGenerationId: null,
    originalCiphertextBytes: null,
    thumbnailGenerationId: null,
    previewGenerationId: null,
    verifiedAt: null,
    failureCategory: null,
    trashedAt: null,
  });
}

/**
 * One `device_library_assets` row with control over every column the mirror
 * counts and the two transfer pools read. `insertLocal` and
 * `insertWithResidency` cannot express a missing original, an absent uri, or
 * an ineligible row — and those are exactly the states where a count and the
 * pool that is supposed to drain it can disagree.
 */
async function insertAsset(
  database: SqlDatabasePort,
  digest: string,
  options: Readonly<{
    residency: 'local-original' | 'cached' | 'cloud-only';
    protectEligible?: number;
    missingOriginalSince?: number | null;
    localOriginalUri?: string | null;
    byteSize?: number;
  }>,
): Promise<void> {
  const {
    residency, protectEligible = 1, missingOriginalSince = null, byteSize = 100,
  } = options;
  const defaultUri = residency === 'cloud-only'
    ? null
    : `file:///data/library/originals/${digest}.jpg`;
  const uri = options.localOriginalUri === undefined
    ? defaultUri
    : options.localOriginalUri;
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, 'jpeg', 'jpg', ?, 10, 10, 'import', NULL, ?, ?, ?, ?, 1, 1)`,
    [digest, byteSize, uri, residency, protectEligible, missingOriginalSince],
  );
}

async function harness(): Promise<Harness> {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  await migrateDatabase(database);
  let ticks = 1_000;
  const clock = () => (ticks += 1);
  let sequence = 0;
  return {
    native,
    database,
    protection: createLibraryProtectionRepository({ database, clock }),
    outbox: createLibraryActionOutbox({
      database,
      clock,
      newMutationId: () => {
        sequence += 1;
        return `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`;
      },
    }),
  };
}

describe('library protection repository', () => {
  it('upserts an account projection and reads it by digest or asset id', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    const byDigest = await protection.findByDigest(SCOPE, DIGEST_A);
    expect(byDigest).toMatchObject({ assetId: ASSET_A, protection: 'protected' });
    expect(await protection.findByAssetId(SCOPE, ASSET_A)).toEqual(byDigest);
    expect(await protection.findByDigest('other-scope', DIGEST_A)).toBeNull();
    native.close();
  });

  it('records verification separately from protection', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    expect((await protection.findByDigest(SCOPE, DIGEST_A))?.verifiedAt).toBeNull();
    await protection.markVerified(SCOPE, ASSET_A, DIGEST_A, 7_777);
    const verified = await protection.findByDigest(SCOPE, DIGEST_A);
    expect(verified?.verifiedAt).toBe(7_777);
    expect((await protection.readDeviceState(DIGEST_A))?.lastVerifiedAt).toBe(7_777);
    native.close();
  });

  it('markCommittedVerified verifies the row it read and nothing else', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'pending',
      generation: 3,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: null,
      thumbnailGenerationId: 'thumb-1',
      previewGenerationId: 'preview-1',
      verifiedAt: null,
      failureCategory: 'retryable_transfer',
      trashedAt: 8_888,
    });

    expect(await protection.markCommittedVerified({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      protection: 'pending',
      lifecycle: 'active',
      generation: 3,
      revision: 4,
      originalGenerationId: GENERATION,
      at: 9_001,
    })).toBe(true);

    expect(await protection.findByAssetId(SCOPE, ASSET_A)).toMatchObject({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 3,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: null,
      thumbnailGenerationId: 'thumb-1',
      previewGenerationId: 'preview-1',
      verifiedAt: 9_001,
      failureCategory: null,
      trashedAt: null,
    });
    expect((await protection.readDeviceState(DIGEST_A))?.lastVerifiedAt)
      .toBe(9_001);
    native.close();
  });

  it('markCommittedVerified matches a row whose revision is NULL', async () => {
    // A resumed K6 commit can carry no revision; `revision IS ?` must still
    // match it, or such a row would never be verified and never evicted.
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'pending',
      generation: 3,
      revision: null,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 128,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });

    expect(await protection.markCommittedVerified({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      protection: 'pending',
      lifecycle: 'active',
      generation: 3,
      revision: null,
      originalGenerationId: GENERATION,
      at: 9_002,
    })).toBe(true);

    expect(await protection.findByAssetId(SCOPE, ASSET_A)).toMatchObject({
      protection: 'protected',
      generation: 3,
      revision: null,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 128,
      verifiedAt: 9_002,
    });
    expect((await protection.readDeviceState(DIGEST_A))?.lastVerifiedAt)
      .toBe(9_002);
    native.close();
  });

  it.each([
    ['protection', { protection: 'protected' as const }, null],
    ['lifecycle', { lifecycle: 'trash' as const }, null],
    ['generation', { generation: 2 }, null],
    ['revision', { revision: null }, null],
    ['original generation', { originalGenerationId: 'other-generation' }, null],
    ['already verified', {}, 9_000],
  ] as const)('markCommittedVerified returns false when %s differs', async (
    _label,
    override,
    rowVerifiedAt,
  ) => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'pending',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: null,
      thumbnailGenerationId: 'thumb-1',
      previewGenerationId: 'preview-1',
      verifiedAt: rowVerifiedAt,
      failureCategory: null,
      trashedAt: null,
    });
    const before = await protection.findByAssetId(SCOPE, ASSET_A);

    expect(await protection.markCommittedVerified({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      protection: 'pending',
      lifecycle: 'active',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      at: 9_001,
      ...override,
    })).toBe(false);

    expect(await protection.findByAssetId(SCOPE, ASSET_A)).toEqual(before);
    expect(await protection.readDeviceState(DIGEST_A)).toBeNull();
    native.close();
  });

  it('promotes pending to protected with verifiedAt in one transaction', async () => {
    const { native, database } = await harness();
    await insertLocal(database, DIGEST_A);
    await database.run(
      `INSERT INTO library_asset_protection (
         account_scope, asset_id, plaintext_sha256, lifecycle, protection,
         generation, revision, original_generation_id, original_ciphertext_bytes,
         verified_at, failure_category, trashed_at, updated_at
       ) VALUES (?, ?, ?, 'active', 'pending', 1, 4, ?, 200, NULL, NULL, NULL, 1)`,
      [SCOPE, ASSET_A, DIGEST_A, GENERATION],
    );

    type Observation = { protection: string; verified_at: number | null };
    const observations: Observation[] = [];
    const observing: SqlDatabasePort = {
      exec: (source) => database.exec(source),
      getFirst: (source, params) => database.getFirst(source, params),
      getAll: (source, params) => database.getAll(source, params),
      run: async (source, params) => database.run(source, params),
      transaction: async (task) => database.transaction(async (tx) => {
        const wrapped: SqlDatabasePort = {
          exec: (source) => tx.exec(source),
          getFirst: (source, params) => tx.getFirst(source, params),
          getAll: (source, params) => tx.getAll(source, params),
          transaction: (nested) => tx.transaction(nested),
          run: async (source, params) => {
            const result = await tx.run(source, params);
            const row = await tx.getFirst<Observation>(
              `SELECT protection, verified_at FROM library_asset_protection
                WHERE account_scope = ? AND asset_id = ?`,
              [SCOPE, ASSET_A],
            );
            if (row !== null) observations.push(row);
            return result;
          },
        };
        return task(wrapped);
      }),
    };

    const protection = createLibraryProtectionRepository({
      database: observing,
      clock: () => 9_001,
    });
    await protection.markProtectedAndVerified({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 9_001,
    });

    expect(observations.length).toBeGreaterThan(0);
    expect(observations.some(
      (row) => row.protection === 'protected' && row.verified_at === null,
    )).toBe(false);
    expect(observations.some(
      (row) => row.protection === 'protected' && row.verified_at === 9_001,
    )).toBe(true);
    const final = await database.getFirst<Observation>(
      `SELECT protection, verified_at FROM library_asset_protection
        WHERE account_scope = ? AND asset_id = ?`,
      [SCOPE, ASSET_A],
    );
    expect(final).toEqual({ protection: 'protected', verified_at: 9_001 });
    native.close();
  });

  it('changes residency and the local original together', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.setResidency(DIGEST_A, 'cloud-only', null);
    const row = await database.getFirst<{ residency: string; local_original_uri: string | null }>(
      'SELECT residency, local_original_uri FROM device_library_assets WHERE plaintext_sha256 = ?',
      [DIGEST_A],
    );
    expect(row).toEqual({ residency: 'cloud-only', local_original_uri: null });
    native.close();
  });

  it('lists the three batch candidate sets without overlap', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await insertLocal(database, DIGEST_B);
    await protection.upsertProtection({
      accountScope: SCOPE, assetId: ASSET_B, plaintextSha256: DIGEST_B,
      lifecycle: 'active', protection: 'protected', generation: 1, revision: 2,
      originalGenerationId: GENERATION, originalCiphertextBytes: 10,
      thumbnailGenerationId: null, previewGenerationId: null,
      verifiedAt: 5, failureCategory: null, trashedAt: null,
    });
    expect(await protection.listProtectCandidates(SCOPE)).toEqual([DIGEST_A]);
    expect(await protection.listFreeCandidates(SCOPE)).toEqual([DIGEST_B]);
    expect(await protection.listDownloadCandidates(SCOPE)).toEqual([]);
    await protection.setResidency(DIGEST_B, 'cloud-only', null);
    expect(await protection.listDownloadCandidates(SCOPE)).toEqual([DIGEST_B]);
    expect(await protection.listFreeCandidates(SCOPE)).toEqual([]);

    const uri = `file:///data/library/originals/${DIGEST_B}.jpg`;
    await protection.setResidency(DIGEST_B, 'local-original', uri);
    await database.run(
      `UPDATE device_library_assets
          SET missing_original_since = 7
        WHERE plaintext_sha256 = ?`,
      [DIGEST_B],
    );
    expect(await protection.listDownloadCandidates(SCOPE)).toEqual([DIGEST_B]);
    expect(await protection.listFreeCandidates(SCOPE)).toEqual([]);
    await expect(protection.countMirrorState(SCOPE)).resolves.toMatchObject({
      downloaded: 0,
      downloadedTotal: 1,
    });

    await protection.setResidency(DIGEST_B, 'local-original', uri);
    const row = await database.getFirst<{ missing_original_since: number | null }>(
      `SELECT missing_original_since FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [DIGEST_B],
    );
    expect(row?.missing_original_since).toBeNull();
    expect(await protection.listDownloadCandidates(SCOPE)).toEqual([]);
    await expect(protection.countMirrorState(SCOPE)).resolves.toMatchObject({
      downloaded: 1,
      downloadedTotal: 1,
    });
    native.close();
  });

  it('an adopted protected row without verification is a protect candidate', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await markProtected(protection, DIGEST_A, null);

    expect(await protection.listProtectCandidates(SCOPE)).toEqual([DIGEST_A]);
    native.close();
  });

  it('a verified protected row is not', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await markProtected(protection, DIGEST_A);
    await protection.markVerified(SCOPE, DIGEST_A, DIGEST_A, 7);

    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    native.close();
  });

  it('a protected row with no original generation is not', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await markProtectedWithoutOriginal(protection, DIGEST_A);

    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    native.close();
  });

  it('a cloud-only adopted row is not', async () => {
    const { native, database, protection } = await harness();
    await insertWithResidency(database, DIGEST_A, 'cloud-only');
    await markProtected(protection, DIGEST_A);

    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    native.close();
  });

  it('lists trashed assets as empty-trash candidates, oldest-trashed first', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await insertLocal(database, DIGEST_B);
    await protection.upsertProtection({
      accountScope: SCOPE, assetId: ASSET_A, plaintextSha256: DIGEST_A,
      lifecycle: 'active', protection: 'unprotected', generation: 1, revision: 1,
      originalGenerationId: null, originalCiphertextBytes: null,
      thumbnailGenerationId: null, previewGenerationId: null,
      verifiedAt: null, failureCategory: null, trashedAt: null,
    });
    expect(await protection.listTrashCandidates(SCOPE)).toEqual([]);

    await protection.upsertProtection({
      accountScope: SCOPE, assetId: ASSET_B, plaintextSha256: DIGEST_B,
      lifecycle: 'trash', protection: 'protected', generation: 1, revision: 2,
      originalGenerationId: GENERATION, originalCiphertextBytes: 10,
      thumbnailGenerationId: null, previewGenerationId: null,
      verifiedAt: 5, failureCategory: null, trashedAt: 2_000,
    });
    expect(await protection.listTrashCandidates(SCOPE)).toEqual([DIGEST_B]);

    await protection.upsertProtection({
      accountScope: SCOPE, assetId: ASSET_A, plaintextSha256: DIGEST_A,
      lifecycle: 'trash', protection: 'unprotected', generation: 1, revision: 1,
      originalGenerationId: null, originalCiphertextBytes: null,
      thumbnailGenerationId: null, previewGenerationId: null,
      verifiedAt: null, failureCategory: null, trashedAt: 1_000,
    });
    expect(await protection.listTrashCandidates(SCOPE)).toEqual([DIGEST_A, DIGEST_B]);
    expect(await protection.listTrashCandidates('other-scope')).toEqual([]);
    native.close();
  });

  it('stores device trash pointers and never treats them as originals', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.setDeviceTrash(
      DIGEST_A, `file:///data/library/trash/${DIGEST_A}.jpg`, 9_000,
    );
    const state = await protection.readDeviceState(DIGEST_A);
    expect(state?.deviceTrashUri).toBe(`file:///data/library/trash/${DIGEST_A}.jpg`);
    expect(state?.deviceTrashedAt).toBe(9_000);
    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    native.close();
  });

  it('round-trips derived generation ids and clears them on null upsert', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    const thumbId = '22222222-2222-4222-8222-222222222222';
    const previewId = '33333333-3333-4333-8333-333333333333';
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: thumbId,
      previewGenerationId: previewId,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    expect(await protection.findByDigest(SCOPE, DIGEST_A)).toMatchObject({
      thumbnailGenerationId: thumbId,
      previewGenerationId: previewId,
      objectRefsRevision: null,
    });

    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    expect(await protection.findByDigest(SCOPE, DIGEST_A)).toMatchObject({
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
    native.close();
  });

  it('leaves object_refs_revision unchanged across upsertProtection', async () => {
    const { native, database, protection } = await harness();
    await insertLocal(database, DIGEST_A);
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 4,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    await database.run(
      `UPDATE library_asset_protection
          SET object_refs_revision = 42
        WHERE account_scope = ? AND asset_id = ?`,
      [SCOPE, ASSET_A],
    );
    expect((await protection.findByDigest(SCOPE, DIGEST_A))?.objectRefsRevision)
      .toBe(42);

    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: ASSET_A,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'protected',
      generation: 2,
      revision: 5,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 200,
      thumbnailGenerationId: '44444444-4444-4444-8444-444444444444',
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });
    const after = await protection.findByDigest(SCOPE, DIGEST_A);
    expect(after?.objectRefsRevision).toBe(42);
    expect(after?.generation).toBe(2);
    expect(after?.thumbnailGenerationId).toBe(
      '44444444-4444-4444-8444-444444444444',
    );
    native.close();
  });

  it('counts backed-up and downloaded assets against their totals', async () => {
    const { database, protection } = await harness();
    const backedUp = 'a'.repeat(64);
    const waiting = 'b'.repeat(64);
    const notPulled = 'c'.repeat(64);
    await insertWithResidency(database, backedUp, 'local-original');
    await insertWithResidency(database, waiting, 'local-original');
    await insertWithResidency(database, notPulled, 'cloud-only');
    // Two protected rows; `waiting` stays unprotected (still to upload).
    await markProtected(protection, backedUp);
    await markProtected(protection, notPulled);

    expect(await protection.countMirrorState(SCOPE)).toEqual({
      backedUp: 1,
      backedUpTotal: 2,
      downloaded: 1,
      downloadedTotal: 2,
      inCloud: 1,
      inCloudBytes: 100,
      pending: 1,
      totalBytes: 200,
    });
  });

  it('counts what sits only in the cloud, its bytes and the uploads still to go', async () => {
    // Board #27 S3 (spec §5.13, §5.15): `inCloud`/`inCloudBytes` are the
    // download half's not-done rows (what switching back downloads) and
    // `pending` is the upload half's not-done rows.
    const { database, protection } = await harness();
    const [L, C, F, U, U2, T, O, U3, E] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => c.repeat(64));
    await insertAsset(database, L, { residency: 'local-original', byteSize: 10 });
    await insertAsset(database, C, { residency: 'cloud-only', byteSize: 100 });
    await insertAsset(database, F, {
      residency: 'local-original', missingOriginalSince: 555, byteSize: 50,
    });
    await insertAsset(database, U, { residency: 'local-original', byteSize: 7 });
    await insertAsset(database, U2, { residency: 'local-original', byteSize: 3 });
    // A third upload still to go, so `pending` (3) and `inCloud` (2) differ.
    await insertAsset(database, U3, { residency: 'local-original', byteSize: 4 });
    // Local and protected but not upload-eligible: it is in `downloaded` and
    // not in `backedUp`, so `inCloud` cannot be read off the upload half.
    await insertAsset(database, E, { residency: 'local-original', protectEligible: 0, byteSize: 20 });
    await insertAsset(database, T, { residency: 'cloud-only', byteSize: 1000 });
    await insertAsset(database, O, { residency: 'cloud-only', byteSize: 500 });
    for (const digest of [L, C, F, E]) {
      await markProtected(protection, digest);
    }
    const projection = (accountScope: string, digest: string, lifecycle: 'active' | 'trash') => ({
      accountScope,
      assetId: digest,
      plaintextSha256: digest,
      lifecycle,
      protection: 'protected' as const,
      generation: 1,
      revision: 1,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 100,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: lifecycle === 'trash' ? 5 : null,
    });
    await protection.upsertProtection(projection(SCOPE, T, 'trash'));
    await protection.upsertProtection(projection('scope-2', O, 'active'));

    expect(await protection.countMirrorState(SCOPE)).toEqual({
      backedUp: 1,
      backedUpTotal: 4,
      downloaded: 2,
      downloadedTotal: 4,
      inCloud: 2,
      inCloudBytes: 150,
      pending: 3,
      totalBytes: 180,
    });
  });

  it('sums total bytes over the whole download pool, not the rows other pools own', async () => {
    // The card's 原图大小 (spec §4.2) is the plaintext size of exactly the
    // pool `downloadedTotal` counts — eligibility and missing-local presence
    // stay out of the filter. Cached, trash, other-account, unprotected,
    // failed (generated but not `protected`) and generation-less rows belong
    // to other pools and must stay out of the sum even at sizes that would
    // shout in a total.
    const { database, protection } = await harness();
    const [LOCAL, CLOUD, MISSING] = ['a', 'b', 'c'].map((c) => c.repeat(64));
    const [CACHED, TRASHED, FOREIGN, UNPROTECTED, NO_GENERATION] =
      ['d', 'e', 'f', 'g', 'h'].map((c) => c.repeat(64));
    const FAILED = 'i'.repeat(64);
    await insertAsset(database, LOCAL, { residency: 'local-original', byteSize: 600 });
    await insertAsset(database, CLOUD, { residency: 'cloud-only', byteSize: 400 });
    await insertAsset(database, MISSING, {
      residency: 'local-original', missingOriginalSince: 555, byteSize: 300,
    });
    await insertAsset(database, CACHED, { residency: 'cached', byteSize: 90_000 });
    await insertAsset(database, TRASHED, { residency: 'cloud-only', byteSize: 60_000 });
    await insertAsset(database, FOREIGN, { residency: 'cloud-only', byteSize: 50_000 });
    await insertAsset(database, UNPROTECTED, { residency: 'cloud-only', byteSize: 80_000 });
    await insertAsset(database, NO_GENERATION, { residency: 'cloud-only', byteSize: 70_000 });
    await insertAsset(database, FAILED, { residency: 'cloud-only', byteSize: 40_000 });
    for (const digest of [LOCAL, CLOUD, MISSING, CACHED]) {
      await markProtected(protection, digest);
    }
    await markProtectedWithoutOriginal(protection, NO_GENERATION);
    // Every pool filter except `protection = 'protected'` would admit this
    // row: active lifecycle, a sealed original generation, in-pool residency.
    await protection.upsertProtection({
      accountScope: SCOPE,
      assetId: FAILED,
      plaintextSha256: FAILED,
      lifecycle: 'active',
      protection: 'failed',
      generation: 1,
      revision: 1,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 100,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: 'quota_full',
      trashedAt: null,
    });
    const projection = (accountScope: string, digest: string, lifecycle: 'active' | 'trash') => ({
      accountScope,
      assetId: digest,
      plaintextSha256: digest,
      lifecycle,
      protection: 'protected' as const,
      generation: 1,
      revision: 1,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 100,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: lifecycle === 'trash' ? 5 : null,
    });
    await protection.upsertProtection(projection(SCOPE, TRASHED, 'trash'));
    await protection.upsertProtection(projection('scope-2', FOREIGN, 'active'));

    const counts = await protection.countMirrorState(SCOPE);
    expect(counts.totalBytes).toBe(1_300);
    expect(counts.downloadedTotal).toBe(3);
  });

  it('does not double-count a digest that a second account also projects', async () => {
    // A digest has one `device_library_assets` row; the account lives on the
    // protection projection. Dropping the scope from the JOIN would sum the
    // same bytes once per projecting account.
    const { database, protection } = await harness();
    const SHARED = 'a'.repeat(64);
    await insertAsset(database, SHARED, { residency: 'cloud-only', byteSize: 250 });
    await markProtected(protection, SHARED);
    await protection.upsertProtection({
      accountScope: 'scope-2',
      assetId: SHARED,
      plaintextSha256: SHARED,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 1,
      originalGenerationId: GENERATION,
      originalCiphertextBytes: 100,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
    });

    expect((await protection.countMirrorState(SCOPE)).totalBytes).toBe(250);
    expect((await protection.countMirrorState('scope-2')).totalBytes).toBe(250);
  });

  it('reports zeros for an account with no assets', async () => {
    const { protection } = await harness();
    expect(await protection.countMirrorState('other-scope')).toEqual({
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0,
      inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    });
  });

  it('excludes a device-trashed asset from both totals', async () => {
    // C4a: a trashed original is residency 'cached' and is deliberately not a
    // download candidate. It must not inflate the denominator either, or the
    // status line would never reach X/X.
    const { database, protection } = await harness();
    const trashed = 'e'.repeat(64);
    await insertWithResidency(database, trashed, 'cached');
    await markProtected(protection, trashed);
    expect(await protection.countMirrorState(SCOPE)).toEqual({
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0,
      inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    });
  });

  it('counts adopted unverified rows as backed up while the protect pool drains verification', async () => {
    // The real invariant is that each denominator equals work done plus what
    // its pool can drain, except an adopted protected row: it is already backed
    // up and is still drained by verification only. Every row below is a state
    // the app reaches on its own, and each is a chance for the two to disagree.
    const { database, protection } = await harness();
    await insertAsset(database, 'a'.repeat(64), { residency: 'local-original' });
    await insertAsset(database, 'b'.repeat(64), { residency: 'local-original' });
    await insertAsset(database, 'c'.repeat(64), { residency: 'cloud-only' });
    await insertAsset(database, 'd'.repeat(64), { residency: 'cloud-only' });
    await insertAsset(database, 'e'.repeat(64), { residency: 'cached' });
    await insertAsset(database, 'f'.repeat(64), {
      residency: 'local-original', missingOriginalSince: 555,
    });
    await insertAsset(database, '1'.repeat(64), {
      residency: 'local-original', localOriginalUri: null,
    });
    await insertAsset(database, '2'.repeat(64), {
      residency: 'cloud-only', protectEligible: 0,
    });
    await insertAsset(database, '3'.repeat(64), { residency: 'local-original' });
    for (const digest of ['a', 'c', 'd', 'e', 'f', '2']) {
      await markProtected(protection, digest.repeat(64));
    }
    // Keep the existing verified row on the completed side of the boundary.
    await protection.markVerified(SCOPE, 'a'.repeat(64), 'a'.repeat(64), 778);
    // An adopted protected row is already backed up but remains in the protect
    // pool until this device records its verification.
    await markProtected(protection, '3'.repeat(64));
    await protection.setDeviceTrash('b'.repeat(64), 'file:///trash/b.jpg', 777);

    const counts = await protection.countMirrorState(SCOPE);
    const upload = await protection.listProtectCandidates(SCOPE);
    const download = await protection.listDownloadCandidates(SCOPE);
    expect(upload.length).toBe(counts.backedUpTotal - counts.backedUp + 1);
    expect(counts.downloadedTotal - counts.downloaded).toBe(download.length);
  });

  it('excludes an asset whose local original went missing from both halves', async () => {
    // Reachable without any cloud involvement: `reconcileStorage()` calls
    // `markOriginalMissing`, which sets `missing_original_since` and leaves
    // residency 'local-original'. The upload pool then skips the row forever,
    // so counting it pins the settings line at "backed up 0/1" for good.
    const { database, protection } = await harness();
    await insertAsset(database, DIGEST_A, {
      residency: 'local-original', missingOriginalSince: 555,
    });
    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    expect(await protection.countMirrorState(SCOPE)).toEqual({
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0,
      inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    });
  });

  it('excludes a local original with no file on disk from the backed-up total', async () => {
    const { database, protection } = await harness();
    await insertAsset(database, DIGEST_A, {
      residency: 'local-original', localOriginalUri: null,
    });
    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    expect((await protection.countMirrorState(SCOPE)).backedUpTotal).toBe(0);
  });

  it('excludes a device-trashed local original from the backed-up total', async () => {
    // Device trash is recorded in `library_device_asset_state`, which the
    // upload pool joins and the count must too.
    const { database, protection } = await harness();
    await insertAsset(database, DIGEST_A, { residency: 'local-original' });
    await protection.setDeviceTrash(DIGEST_A, 'file:///trash/a.jpg', 777);
    expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
    expect((await protection.countMirrorState(SCOPE)).backedUpTotal).toBe(0);
  });

  it('counts an oversize cloud-only asset the download pool will still fetch', async () => {
    // A materialized asset over the protect limit carries protect_eligible = 0,
    // but `listDownloadCandidates` never reads that column, so the pool does
    // fetch it. Gating the count on protect_eligible hides real pending work —
    // and gating `totalBytes` on it would hide real stored size (spec §4.2).
    const { database, protection } = await harness();
    await insertAsset(database, DIGEST_A, {
      residency: 'cloud-only', protectEligible: 0, byteSize: 12345,
    });
    await markProtected(protection, DIGEST_A);
    expect(await protection.listDownloadCandidates(SCOPE)).toEqual([DIGEST_A]);
    const counts = await protection.countMirrorState(SCOPE);
    expect(counts.downloaded).toBe(0);
    expect(counts.downloadedTotal).toBe(1);
    expect(counts.totalBytes).toBe(12_345);
  });

  /**
   * K7 ①: a row whose last failure is terminal — the cloud object is gone, the
   * bytes are corrupt, the image cannot be decoded, the session needs the user
   * — comes back as a candidate every single round. Every round then re-reads
   * it, re-seals it, fails it the same way and reports the round non-clean,
   * which used to arm an immediate retry. Nothing about that row can change
   * without user action, so it does not belong in an automatic pool.
   */
  describe('K7 ①: terminal failures are not automatic candidates', () => {
    // Imported, never re-listed: a hand-copied second literal is exactly how
    // the SQL and its parity test drifted apart before.
    const UPLOAD_TERMINAL = UPLOAD_TERMINAL_CATEGORIES;
    const DOWNLOAD_TERMINAL = DOWNLOAD_TERMINAL_CATEGORIES;

    /**
     * Every member of the union, written out once. `satisfies` makes this
     * exhaustive: adding a category to `LibraryFailureCategory` without
     * listing it here fails to compile, which forces the author to decide
     * whether it is terminal or retryable rather than letting it default into
     * an untested gap.
     */
    const ALL_CATEGORIES = Object.keys({
      offline: true,
      local_space: true,
      auth_attention: true,
      unsupported_image: true,
      retryable_transfer: true,
      integrity: true,
      stale_client: true,
      quota_full: true,
      object_missing: true,
    } satisfies Record<LibraryFailureCategory, true>) as LibraryFailureCategory[];

    /**
     * The complement, derived rather than listed: whatever is not terminal for
     * EITHER pool must still be a candidate for both. `object_missing` sits in
     * `DOWNLOAD_TERMINAL` only, so it is excluded here and gets its own
     * upload-side test below.
     */
    const RETRYABLE: readonly LibraryFailureCategory[] = ALL_CATEGORIES
      .filter((category) => !DOWNLOAD_TERMINAL.includes(category));

    async function markFailed(
      protection: LibraryProtectionRepository,
      digest: string,
      category: LibraryFailureCategory,
      originalGenerationId: string | null = null,
    ): Promise<void> {
      await protection.upsertProtection({
        accountScope: SCOPE,
        assetId: digest,
        plaintextSha256: digest,
        lifecycle: 'active',
        protection: originalGenerationId === null ? 'failed' : 'protected',
        generation: 1,
        revision: 1,
        originalGenerationId,
        originalCiphertextBytes: originalGenerationId === null ? null : 100,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: category,
        trashedAt: null,
      });
    }

    test.each(UPLOAD_TERMINAL)('a %s upload failure is not a protect candidate', async (category) => {
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'local-original' });
      await markFailed(protection, DIGEST_A, category);
      expect(await protection.listProtectCandidates(SCOPE)).toEqual([]);
      native.close();
    });

    test.each(RETRYABLE)('a %s upload failure IS still a protect candidate', async (category) => {
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'local-original' });
      await markFailed(protection, DIGEST_A, category);
      expect(await protection.listProtectCandidates(SCOPE)).toEqual([DIGEST_A]);
      native.close();
    });

    test.each(DOWNLOAD_TERMINAL)('a %s download failure is not a download candidate', async (category) => {
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'cloud-only' });
      await markFailed(protection, DIGEST_A, category, GENERATION);
      expect(await protection.listDownloadCandidates(SCOPE)).toEqual([]);
      native.close();
    });

    test.each(RETRYABLE)('a %s download failure IS still a download candidate', async (category) => {
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'cloud-only' });
      await markFailed(protection, DIGEST_A, category, GENERATION);
      expect(await protection.listDownloadCandidates(SCOPE)).toEqual([DIGEST_A]);
      native.close();
    });

    /**
     * K1 backfill (`byos-assembled-upload.integration.test.ts`): the real phone
     * carried `failed/object_missing` protect rows left by the two-scope bug.
     * K6-3a's `reenroll` rebuilds the missing collect intent, so those rows DO
     * upload once the scope is fixed — excluding them would have silently
     * stranded every one of them. A protect candidate whose local original is
     * genuinely gone is already filtered out by the residency predicates.
     */
    it('an object_missing UPLOAD failure is still a protect candidate (reenroll repairs it)', async () => {
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'local-original' });
      await markFailed(protection, DIGEST_A, 'object_missing');
      expect(await protection.listProtectCandidates(SCOPE)).toEqual([DIGEST_A]);
      native.close();
    });

    it('a row with no failure at all is untouched by the exclusion', async () => {
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'local-original' });
      await insertAsset(database, DIGEST_B, { residency: 'cloud-only' });
      await markProtected(protection, DIGEST_B);
      expect(await protection.listProtectCandidates(SCOPE)).toEqual([DIGEST_A]);
      expect(await protection.listDownloadCandidates(SCOPE)).toEqual([DIGEST_B]);
      native.close();
    });

    it('a terminal failure that later succeeds becomes a candidate again', async () => {
      // `markProtectedAndVerified` clears failure_category, so a user-driven
      // repair or a re-upload puts the row straight back in the pool.
      const { native, database, protection } = await harness();
      await insertAsset(database, DIGEST_A, { residency: 'cloud-only' });
      await markFailed(protection, DIGEST_A, 'object_missing', GENERATION);
      expect(await protection.listDownloadCandidates(SCOPE)).toEqual([]);

      await markProtected(protection, DIGEST_A);
      expect(await protection.listDownloadCandidates(SCOPE)).toEqual([DIGEST_A]);
      native.close();
    });
  });

  it('excludes a protected asset with no sealed original from the download total', async () => {
    // Without an `original_generation_id` there is no object to fetch, so the
    // pool skips it and the denominator must skip it as well.
    const { database, protection } = await harness();
    await insertAsset(database, DIGEST_A, { residency: 'cloud-only' });
    await markProtectedWithoutOriginal(protection, DIGEST_A);
    expect(await protection.listDownloadCandidates(SCOPE)).toEqual([]);
    expect((await protection.countMirrorState(SCOPE)).downloadedTotal).toBe(0);
  });

  describe('countFailureCategory', () => {
    async function upsertFailed(
      protection: LibraryProtectionRepository,
      accountScope: string,
      digest: string,
      category: LibraryFailureCategory,
    ): Promise<void> {
      await protection.upsertProtection({
        accountScope,
        assetId: digest,
        plaintextSha256: digest,
        lifecycle: 'active',
        protection: 'failed',
        generation: 1,
        revision: 1,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: category,
        trashedAt: null,
      });
    }

    it('counts rows matching both the account scope and the failure category', async () => {
      const { protection } = await harness();
      await upsertFailed(protection, SCOPE, DIGEST_A, 'quota_full');
      await upsertFailed(protection, SCOPE, DIGEST_B, 'quota_full');
      await upsertFailed(protection, SCOPE, ASSET_A, 'offline');
      await upsertFailed(protection, 'other-scope', ASSET_B, 'quota_full');

      expect(await protection.countFailureCategory(SCOPE, 'quota_full')).toBe(2);
      expect(await protection.countFailureCategory(SCOPE, 'offline')).toBe(1);
      expect(
        await protection.countFailureCategory('other-scope', 'quota_full'),
      ).toBe(1);
    });

    it('reports zero for a scope with no matching rows', async () => {
      const { protection } = await harness();
      expect(
        await protection.countFailureCategory('empty-scope', 'quota_full'),
      ).toBe(0);
    });
  });
});

describe('library action outbox', () => {
  it('enqueues one durable intent per kind and asset, idempotently', async () => {
    const { native, outbox } = await harness();
    const first = await outbox.enqueue({
      accountScope: SCOPE, deviceId: 'device-1', assetId: ASSET_A, kind: 'protect',
      baseRevision: 3, observedGeneration: 1,
      payload: {
        assetId: ASSET_A, plaintextSha256: DIGEST_A, kind: 'protect',
        reservationId: null, originalGenerationId: null,
        originalCiphertextBytes: null, queuedAt: 1,
      },
    });
    expect(first.status).toBe('queued');
    const second = await outbox.enqueue({
      accountScope: SCOPE, deviceId: 'device-1', assetId: ASSET_A, kind: 'protect',
      baseRevision: 3, observedGeneration: 1,
      payload: {
        assetId: ASSET_A, plaintextSha256: DIGEST_A, kind: 'protect',
        reservationId: null, originalGenerationId: null,
        originalCiphertextBytes: null, queuedAt: 2,
      },
    });
    expect(second).toEqual({ status: 'already-queued', mutationId: first.mutationId });
    expect((await outbox.list(SCOPE)).length).toBe(1);
    native.close();
  });

  it('records failure categories and clears sent rows', async () => {
    const { native, outbox } = await harness();
    const queued = await outbox.enqueue({
      accountScope: SCOPE, deviceId: 'device-1', assetId: ASSET_A, kind: 'trash',
      baseRevision: null, observedGeneration: null,
      payload: {
        assetId: ASSET_A, plaintextSha256: DIGEST_A, kind: 'trash',
        reservationId: null, originalGenerationId: null,
        originalCiphertextBytes: null, queuedAt: 1,
      },
    });
    await outbox.markFailed(queued.mutationId, 'offline');
    expect((await outbox.list(SCOPE))[0]).toMatchObject({
      state: 'failed', lastErrorCode: 'offline',
    });
    await outbox.markSent(queued.mutationId);
    expect(await outbox.list(SCOPE)).toEqual([]);
    native.close();
  });

  it('keeps a dispatched intent whose outcome was never confirmed', async () => {
    const { native, outbox } = await harness();
    const queued = await outbox.enqueue({
      accountScope: SCOPE, deviceId: 'device-1', assetId: ASSET_A,
      kind: 'stop-protection', baseRevision: 4, observedGeneration: 1,
      payload: {
        assetId: ASSET_A, plaintextSha256: DIGEST_A, kind: 'stop-protection',
        reservationId: null, originalGenerationId: GENERATION,
        originalCiphertextBytes: null, queuedAt: 1,
      },
    });
    await outbox.markOutcomeUnknown(queued.mutationId, 'offline');
    const row = await outbox.find(SCOPE, ASSET_A, 'stop-protection');
    expect(row).toMatchObject({
      mutationId: queued.mutationId, state: 'sending', lastErrorCode: 'offline',
    });
    expect(hasUnknownOutcome(row)).toBe(true);
    // The stable mutation survives so a replay can resolve it idempotently.
    expect(await outbox.enqueue({
      accountScope: SCOPE, deviceId: 'device-1', assetId: ASSET_A,
      kind: 'stop-protection', baseRevision: 4, observedGeneration: 1,
      payload: {
        assetId: ASSET_A, plaintextSha256: DIGEST_A, kind: 'stop-protection',
        reservationId: null, originalGenerationId: GENERATION,
        originalCiphertextBytes: null, queuedAt: 2,
      },
    })).toEqual({ status: 'already-queued', mutationId: queued.mutationId });
    await outbox.markFailed(queued.mutationId, 'stale_client');
    expect(hasUnknownOutcome(
      await outbox.find(SCOPE, ASSET_A, 'stop-protection'),
    )).toBe(false);
    native.close();
  });

  it('finds the SP6 collect intent without changing its stored device id', async () => {
    const { native, database, outbox } = await harness();
    await database.run(
      `INSERT INTO library_outbox (
         mutation_id, account_scope, device_id, asset_id, kind, base_revision,
         observed_generation, state, attempt_count, next_attempt_at,
         last_error_code, local_metadata_json, encrypted_payload,
         created_at, updated_at
       ) VALUES (?, ?, 'device-collect', ?, 'collect', NULL, NULL, 'pending',
         0, NULL, NULL, ?, NULL, 1, 1)`,
      [
        '00000000-0000-4000-8000-000000000099',
        SCOPE,
        ASSET_A,
        JSON.stringify({
          assetId: ASSET_A, plaintextSha256: DIGEST_A, format: 'jpeg',
          byteSize: 100, width: 10, height: 10, origin: 'import',
          sourceImageId: null, collectedAt: 1,
        }),
      ],
    );
    const collect = await outbox.findCollectIntent(SCOPE, ASSET_A);
    expect(collect).toMatchObject({
      mutationId: '00000000-0000-4000-8000-000000000099',
      deviceId: 'device-collect',
    });
    expect(collect?.metadata.plaintextSha256).toBe(DIGEST_A);
    native.close();
  });
});
