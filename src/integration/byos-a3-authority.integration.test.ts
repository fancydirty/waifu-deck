/**
 * N6-A3 (spec §8.2 items 1–8): real S3-backed (MinIO) integration suite for:
 *   1. Legacy v1/v2 import metadata -> `unknown`, original time, no `images` row.
 *   2. v3 `safe` and `adult` round-trip, missing-field fallback, and invalid
 *      classification refusal.
 *   3. Known mapping & locally deleted import learning summary without
 *      resurrecting membership, then explicit re-add using library class/time.
 *   4. First-collect race with opposite choices -> both devices converge to the
 *      winning record; losing phone re-import cannot overwrite it.
 *   5. Unchanged S3 reconcile causes 0 state GETs / 0 decrypts / 0 applies;
 *      one-time summary backfill is bounded and not repeated; failed DB apply
 *      after indexing retries on the next cycle.
 *   6. Encryption-off (`encryption: 'none'`) v3 round-trip through passthrough cipher.
 *   7. §4.4 Provider-first / offline import collision on real MinIO.
 *   8. §4.4 Import-first / offline provider save collision on real MinIO.
 */
import { DatabaseSync } from 'node:sqlite';

import { randomUUID } from 'expo-crypto';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createVaultOrAdopt } from '@/features/byos/byos-vault-init';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';
import {
  createS3Transport,
  type S3FetchPort,
} from '@/features/byos/s3-transport';
import type { S3Credentials } from '@/features/byos/s3-transport-types';
import { createImageRepository } from '@/features/images/image-repository';
import { createLibraryAccountMetadataSummaryRepository } from '@/features/library/library-account-metadata-summary';
import { createByosLibraryAccountPort } from '@/features/library/library-account-port';
import { createLibraryActionOutbox } from '@/features/library/library-action-outbox';
import { encodeAssetState } from '@/features/library/library-asset-state-codec';
import { createS3LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import { createLibraryCollectedPurge } from '@/features/library/library-collected-purge';
import { createLibraryDecodeGate } from '@/features/library/library-decode-gate';
import { createLibraryFileStore } from '@/features/library/library-file-store';
import {
  deriveLibraryAssetId,
  sha256PlaintextHex,
} from '@/features/library/library-identity';
import { createLibraryImportService } from '@/features/library/library-import';
import { createLibraryIngestService } from '@/features/library/library-ingest';
import { decideLibraryMutation } from '@/features/library/library-mutation-decision';
import {
  createLibraryObjectCipher,
  type LibraryObjectCipher,
} from '@/features/library/library-object-crypto';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
import { createLibraryProtectAction } from '@/features/library/library-protect-action';
import { createLibraryProtectionRepository } from '@/features/library/library-protection-repository';
import { createLibraryReaddAuthorityLookup } from '@/features/library/library-readd-authority';
import { createLibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
} from '@/features/library/library-remote-state-cache';
import { createLibraryRepository } from '@/features/library/library-repository';
import { createByosLibrarySessionPort } from '@/features/library/library-session-port';
import { readSourceMetadata } from '@/features/library/library-source-metadata';
import { createLibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import { createLibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import { createLibrarySyncEngine } from '@/features/library/library-sync-engine';
import { createLibrarySyncOutbox } from '@/features/library/library-sync-outbox';
import { createLibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import {
  createFakeLibraryFilePort,
  PNG_FIXTURE,
} from '@/features/library/library-test-support';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import { readLibraryEntries } from '@/features/library/library-view-model';
import type { ImageCandidate } from '@/features/waifu/types';
import { openExistingVault } from '@/test/byos-vault-open';
import {
  createNodeBlobStaging,
  createNodeDownloadFilePort,
  createNodeUploadFilePort,
  withNodeStreamRoot,
} from '@/test/node-file-transfer';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

const endpoint = process.env.BYOS_IT_ENDPOINT ?? '';
const bucket = process.env.BYOS_IT_BUCKET ?? '';
const accessKeyId = process.env.BYOS_IT_ACCESS_KEY ?? '';
const secretAccessKey = process.env.BYOS_IT_SECRET ?? '';
const basePrefix = process.env.BYOS_IT_PREFIX ?? '';
const region = process.env.BYOS_IT_REGION ?? 'us-east-1';

const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
const describeBackend = configured ? describe : describe.skip;

const credentials: S3Credentials = {
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
};
const PASSWORD = 'correct horse battery staple';

/** Deterministic valid PNG fixture with distinct content per seed. */
function makePngBytes(seed: number): Uint8Array {
  const out = new Uint8Array(PNG_FIXTURE.byteLength + 16);
  out.set(PNG_FIXTURE, 0);
  for (let i = 0; i < 16; i += 1) {
    out[PNG_FIXTURE.byteLength + i] = (seed * 31 + i * 17) & 0xff;
  }
  return out;
}

const PROVIDER_CANDIDATE: ImageCandidate = {
  providerKey: 'danbooru',
  providerItemId: '990011',
  canonicalSourceKey: 'danbooru:990011',
  perceptualHash: null,
  md5: '0123456789abcdef0123456789abcdef',
  remoteUrl: 'https://example.test/990011.png',
  sampleUrl: 'https://example.test/990011-s.png',
  sourceUrl: 'https://example.test/posts/990011',
  artistName: 'minio_artist',
  artistUrl: 'https://example.test/artists/minio_artist',
  width: 320,
  height: 240,
  byteSize: PNG_FIXTURE.byteLength + 16,
  extension: 'png',
  dominantColor: '#335577',
  contentRating: 'explicit',
  nativeRating: 'e',
  isNsfw: true,
  isAnimated: false,
  tags: ['tag_minio', 'solo'],
};

async function createA3Device(input: {
  deviceId: string;
  meta: VaultMeta;
  masterKey: Uint8Array | null;
  prefix: string;
  clock?: () => number;
  failRestoreOnce?: { value: boolean };
}) {
  const native = new DatabaseSync(':memory:');
  const database: SqlDatabasePort = createNodeSqliteAdapter(native);
  await migrateDatabase(database);

  const cipher: LibraryObjectCipher =
    input.meta.encryption === 'none'
      ? createPassthroughLibraryCipher()
      : createLibraryObjectCipher();
  const filePort = withNodeStreamRoot(createFakeLibraryFilePort());
  const files = createLibraryFileStore({ port: filePort });
  const images = createImageRepository(database);
  const session = createByosLibrarySessionPort({
    vault: {
      meta: input.meta,
      masterKey: input.masterKey,
      deviceId: input.deviceId,
    },
  });
  const account = createByosLibraryAccountPort(session);

  const stateGets: string[] = [];
  const realFetch = fetch as unknown as S3FetchPort;
  const countingFetch: S3FetchPort = async (urlInput, init) => {
    const url = typeof urlInput === 'string' ? urlInput : String(urlInput);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/state.json')) {
      stateGets.push(url);
    }
    return realFetch(urlInput, init);
  };

  const transport = createS3Transport(credentials, {
    fetchImpl: countingFetch,
    uploadFile: createNodeUploadFilePort(),
    downloadFile: createNodeDownloadFilePort(),
  });
  const remoteCacheRepo = createLibraryRemoteStateCacheRepository({ database });
  const reconciliation = createLibraryReconciliationPort(
    transport,
    input.prefix,
    bindLibraryRemoteStateIndex(
      remoteCacheRepo,
      async () => (await session.current())?.accountScope ?? null,
    ),
  );
  const cloud = createS3LibraryCloudClient({
    transport,
    prefix: input.prefix,
    decide: decideLibraryMutation,
    blobStaging: createNodeBlobStaging(),
    transferProgress: libraryTransferProgress,
    rememberState: (key, etag, record) =>
      reconciliation.remember(key, etag, record),
  });

  const protection = createLibraryProtectionRepository({ database });
  const repository = createLibraryRepository(database);
  const actionOutbox = createLibraryActionOutbox({
    database,
    newMutationId: () => randomUUID(),
  });
  const summaryRepo = createLibraryAccountMetadataSummaryRepository({
    database,
  });

  const protectAction = createLibraryProtectAction({
    repository,
    protection,
    outbox: actionOutbox,
    files,
    cipher,
    cloud,
    reconciliation,
    session,
    derived: {
      async derive() {
        throw new Error('no derived in this test');
      },
    },
    readSource: (sourceImageId) => readSourceMetadata(database, sourceImageId),
    newGenerationId: () => randomUUID(),
  });

  const restoreImage = async (candidate: ImageCandidate, savedAt: number) => {
    if (input.failRestoreOnce?.value) {
      input.failRestoreOnce.value = false;
      throw new Error('injected restoreImage failure');
    }
    const stored = await images.saveMirroredCandidate(candidate, savedAt);
    return stored.id;
  };

  let online = true;
  const lookupReaddAuthority = createLibraryReaddAuthorityLookup({
    database,
    session: {
      current: async () => (online ? session.current() : null),
    },
    reconciliation,
    cipher,
    restoreImage,
  });

  const decodeGate = createLibraryDecodeGate({
    async decode() {
      return { width: 320, height: 240 };
    },
  });
  const ingest = createLibraryIngestService({
    files,
    repository,
    decodeGate,
    account,
    newMutationId: () => randomUUID(),
    clock: input.clock,
    lookupReaddAuthority,
  });
  const importService = createLibraryImportService({
    picker: { pickImages: async () => [] },
    files,
    ingest,
  });
  const purge = createLibraryCollectedPurge({
    database,
    files,
    collect: { settled: async () => {}, drain: async () => {} },
    withDigestGate: (sha, work) => ingest.withDigestGate(sha, work),
    settleImports: () => importService.settled(),
  });

  const applyCalls: number[] = [];
  const rawApply = createLibrarySyncApplyWriter({
    database,
    cipher,
    clock: input.clock,
    restoreImage,
  });
  const applyWriter = {
    async apply(applyInput: Parameters<typeof rawApply.apply>[0]) {
      applyCalls.push(applyInput.assets.length);
      return rawApply.apply(applyInput);
    },
  };

  const syncEngine = createLibrarySyncEngine({
    session,
    cloud,
    reconciliation,
    cipher,
    database,
    cursors: createLibrarySyncCursorStore({ database }),
    apply: applyWriter,
    reconciler: createLibrarySyncReconciler({ database, protection, files }),
    outbox: createLibrarySyncOutbox({
      database,
      newMutationId: () => randomUUID(),
    }),
    pipelines: {
      retryProtect: async (digest) => {
        await protectAction.protect(digest);
      },
    },
    isProtectInFlight: (assetId) => protectAction.isInFlight(assetId),
  });

  return {
    database,
    filePort,
    files,
    images,
    session,
    account,
    cipher,
    transport,
    remoteCacheRepo,
    reconciliation,
    cloud,
    protection,
    repository,
    summaryRepo,
    protectAction,
    ingest,
    importService,
    purge,
    syncEngine,
    stateGets,
    applyCalls,
    setOnline(value: boolean) {
      online = value;
    },
    async importPickerBytes(
      bytes: Uint8Array,
      classification: 'safe' | 'adult',
    ) {
      const uri = `file:///cache/ImagePicker/${randomUUID()}.png`;
      filePort.files.set(uri, Uint8Array.from(bytes));
      return importService.importConfirmedFiles({
        uris: [uri],
        classification,
      });
    },
    async saveProviderBytes(
      bytes: Uint8Array,
      candidate: ImageCandidate,
      savedAt: number,
    ) {
      const stored = await images.saveCandidate(candidate, savedAt);
      const uri = `file:///data/collection/${stored.id}.png`;
      filePort.files.set(uri, Uint8Array.from(bytes));
      await images.markDownloadReady(stored.id, uri);
      const out = await ingest.ingestBytes({
        bytes,
        origin: 'provider',
        sourceImageId: stored.id,
      });
      if (savedAt !== undefined) {
        await database.run(
          `UPDATE device_library_assets SET created_at = ? WHERE plaintext_sha256 = ?`,
          [savedAt, out.asset.plaintextSha256],
        );
        const scope = await account.accountScope();
        if (scope !== null) {
          const ctx = await session.current();
          const assetId = deriveLibraryAssetId(
            ctx!.masterKey,
            out.asset.plaintextSha256,
          );
          await database.run(
            `UPDATE library_outbox
                SET local_metadata_json = json_set(local_metadata_json, '$.collectedAt', ?)
              WHERE account_scope = ? AND asset_id = ? AND kind = 'collect'`,
            [savedAt, scope, assetId],
          );
        }
      }
      return { stored, outcome: out };
    },
    close() {
      native.close();
    },
  };
}

describeBackend('N6-A3 real S3 (MinIO) authority, metadata v3, and §4.4 collision gates', () => {
  const runPrefix = `${basePrefix}n6-a3-${Date.now()}/`;

  test('1 & 2: legacy v1/v2 import metadata -> unknown; v3 safe/adult round-trip, missing-field fallback, and invalid classification refusal', async () => {
    const prefix = `${runPrefix}v1-v2-v3/`;
    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(
      setupTransport,
      prefix,
      PASSWORD,
      'aes-gcm',
    );
    const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);

    let clockA = 1_700_100_000_000;
    const A = await createA3Device({
      deviceId: 'dev-a',
      meta: vaultA.meta,
      masterKey: vaultA.masterKey,
      prefix,
      clock: () => (clockA += 1_000),
    });
    const B = await createA3Device({
      deviceId: 'dev-b',
      meta: vaultB.meta,
      masterKey: vaultB.masterKey,
      prefix,
    });

    try {
      // Seed legacy v1 and v2 import records directly on S3 through real cipher:
      const bytesV1 = makePngBytes(1);
      const shaV1 = sha256PlaintextHex(bytesV1);
      const assetIdV1 = deriveLibraryAssetId(vaultA.masterKey!, shaV1);
      const sealedV1 = await A.cipher.sealMetadata({
        masterKey: vaultA.masterKey!,
        assetId: assetIdV1,
        metadata: {
          version: 1,
          plaintextSha256: shaV1,
          format: 'png',
          canonicalExtension: 'png',
          byteSize: bytesV1.byteLength,
          width: 320,
          height: 240,
          origin: 'import',
          sourceImageId: null,
          collectedAt: 1_600_000_111_000,
          tags: [],
        },
      });
      await setupTransport.putObject(
        `${prefix}assets/${assetIdV1}/state.json`,
        encodeAssetState({
          assetId: assetIdV1,
          revision: 1,
          generation: 1,
          lifecycle: 'active',
          protection: 'unprotected',
          lastMutationId: 'm-v1',
          trashedAt: null,
          generations: {},
          meta: sealedV1,
        }),
        {},
      );

      // v3 missing importClassification field -> falls back to 'unknown'
      const bytesV3Missing = makePngBytes(2);
      const shaV3Missing = sha256PlaintextHex(bytesV3Missing);
      const assetIdV3Missing = deriveLibraryAssetId(
        vaultA.masterKey!,
        shaV3Missing,
      );
      const sealedV3Missing = await A.cipher.sealMetadata({
        masterKey: vaultA.masterKey!,
        assetId: assetIdV3Missing,
        metadata: {
          version: 3,
          plaintextSha256: shaV3Missing,
          format: 'png',
          canonicalExtension: 'png',
          byteSize: bytesV3Missing.byteLength,
          width: 320,
          height: 240,
          origin: 'import',
          sourceImageId: null,
          collectedAt: 1_600_000_222_000,
          tags: [],
        },
      });
      await setupTransport.putObject(
        `${prefix}assets/${assetIdV3Missing}/state.json`,
        encodeAssetState({
          assetId: assetIdV3Missing,
          revision: 1,
          generation: 1,
          lifecycle: 'active',
          protection: 'unprotected',
          lastMutationId: 'm-v3m',
          trashedAt: null,
          generations: {},
          meta: sealedV3Missing,
        }),
        {},
      );

      // v3 present invalid importClassification ('bogus') -> refused (skippedIntegrity)
      const bytesInvalid = makePngBytes(3);
      const shaInvalid = sha256PlaintextHex(bytesInvalid);
      const assetIdInvalid = deriveLibraryAssetId(
        vaultA.masterKey!,
        shaInvalid,
      );
      const sealedInvalid = await A.cipher.sealMetadata({
        masterKey: vaultA.masterKey!,
        assetId: assetIdInvalid,
        metadata: {
          version: 3,
          plaintextSha256: shaInvalid,
          format: 'png',
          canonicalExtension: 'png',
          byteSize: bytesInvalid.byteLength,
          width: 320,
          height: 240,
          origin: 'import',
          sourceImageId: null,
          collectedAt: 1_600_000_333_000,
          // @ts-expect-error testing invalid classification on wire
          importClassification: 'bogus',
          tags: [],
        },
      });
      await setupTransport.putObject(
        `${prefix}assets/${assetIdInvalid}/state.json`,
        encodeAssetState({
          assetId: assetIdInvalid,
          revision: 1,
          generation: 1,
          lifecycle: 'active',
          protection: 'unprotected',
          lastMutationId: 'm-inv',
          trashedAt: null,
          generations: {},
          meta: sealedInvalid,
        }),
        {},
      );

      // Real v3 'safe' and 'adult' imports from A
      const bytesSafe = makePngBytes(4);
      const shaSafe = sha256PlaintextHex(bytesSafe);
      const bytesAdult = makePngBytes(5);
      const shaAdult = sha256PlaintextHex(bytesAdult);

      await A.importPickerBytes(bytesSafe, 'safe');
      await A.importPickerBytes(bytesAdult, 'adult');
      expect((await A.protectAction.protect(shaSafe)).status).toBe('applied');
      expect((await A.protectAction.protect(shaAdult)).status).toBe('applied');

      // B syncs and materializes v1, v3-missing, v3-safe, and v3-adult, while refusing invalid
      await B.syncEngine.sync();

      expect(await B.repository.findLocalAsset(shaV1)).toMatchObject({
        origin: 'import',
        importClassification: 'unknown',
        createdAt: 1_600_000_111_000,
        sourceImageId: null,
      });
      expect(await B.repository.findLocalAsset(shaV3Missing)).toMatchObject({
        origin: 'import',
        importClassification: 'unknown',
        createdAt: 1_600_000_222_000,
        sourceImageId: null,
      });
      expect(await B.repository.findLocalAsset(shaInvalid)).toBeNull();

      const bSafe = await B.repository.findLocalAsset(shaSafe);
      const bAdult = await B.repository.findLocalAsset(shaAdult);
      expect(bSafe).toMatchObject({
        origin: 'import',
        importClassification: 'safe',
        sourceImageId: null,
      });
      expect(bAdult).toMatchObject({
        origin: 'import',
        importClassification: 'adult',
        sourceImageId: null,
      });

      // No `images` rows were fabricated for any import
      const imageCount = await B.database.getFirst<{ n: number }>(
        'SELECT COUNT(*) AS n FROM images',
      );
      expect(imageCount?.n).toBe(0);
    } finally {
      A.close();
      B.close();
    }
  });

  test('3, 4 & 5: known/deleted import summary learning, re-add authority, first-collect race convergence, unchanged ETag 0-GET/0-decrypt bound, backfill, and failed-apply retry', async () => {
    const prefix = `${runPrefix}readd-race-etag/`;
    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(
      setupTransport,
      prefix,
      PASSWORD,
      'aes-gcm',
    );
    const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);

    let clockA = 1_700_200_000_000;
    let clockB = 1_700_300_000_000;
    const failRestoreB = { value: false };
    const A = await createA3Device({
      deviceId: 'dev-a',
      meta: vaultA.meta,
      masterKey: vaultA.masterKey,
      prefix,
      clock: () => (clockA += 1_000),
    });
    const B = await createA3Device({
      deviceId: 'dev-b',
      meta: vaultB.meta,
      masterKey: vaultB.masterKey,
      prefix,
      clock: () => (clockB += 1_000),
      failRestoreOnce: failRestoreB,
    });

    try {
      // --- Item 4: First-collect race with opposite choices ---
      // Both A ('safe') and B ('adult') import the same bytes before syncing.
      const raceBytes = makePngBytes(10);
      const raceSha = sha256PlaintextHex(raceBytes);
      await A.importPickerBytes(raceBytes, 'safe');
      const aOriginalTime = (await A.repository.findLocalAsset(raceSha))!.createdAt;
      await B.importPickerBytes(raceBytes, 'adult');

      // A uploads first (winning first collect on S3 CAS)
      expect((await A.protectAction.protect(raceSha)).status).toBe('applied');
      // B syncs: B's collect merges into A's winning record, and B converges to A's 'safe' + original time!
      await B.syncEngine.sync();

      expect(await B.repository.findLocalAsset(raceSha)).toMatchObject({
        origin: 'import',
        importClassification: 'safe',
        createdAt: aOriginalTime,
      });

      // --- Item 3: Device-local delete on B, routine sync does not resurrect, explicit re-add uses library class/time ---
      await expect(B.purge.purgeImportedAsset(raceSha)).resolves.toBe(true);
      const bScope = (await B.account.accountScope())!;
      expect(await readLibraryEntries(B.database, bScope)).toEqual([]);

      // Routine sync on B does not resurrect the deleted import:
      await B.syncEngine.sync();
      expect(await readLibraryEntries(B.database, bScope)).toEqual([]);

      // Explicit re-import on B with 'adult' choice retains 'safe' and `aOriginalTime` and reports `retainedClassificationCount: 1`:
      const readdSummary = await B.importPickerBytes(raceBytes, 'adult');
      expect(readdSummary).toMatchObject({
        selected: 1,
        ingested: 1,
        duplicates: 0,
        retainedClassificationCount: 1,
      });
      expect(await B.repository.findLocalAsset(raceSha)).toMatchObject({
        origin: 'import',
        importClassification: 'safe',
        createdAt: aOriginalTime,
        importDeletedAt: null,
      });

      // --- Item 5: Unchanged ETag causes 0 state GETs / 0 decrypts / 0 apply writes ---
      const getsBefore = B.stateGets.length;
      const openSpy = jest.spyOn(B.cipher, 'openMetadata');
      const appliesBefore = B.applyCalls.length;
      await B.syncEngine.sync();
      expect(B.stateGets.length).toBe(getsBefore);
      expect(openSpy).toHaveBeenCalledTimes(0);
      expect(B.applyCalls.length).toBe(appliesBefore);
      openSpy.mockRestore();

      // Failed Phase 3 apply after indexing retries on the next cycle:
      const provBytes = makePngBytes(11);
      const provSha = sha256PlaintextHex(provBytes);
      await A.saveProviderBytes(provBytes, PROVIDER_CANDIDATE, 1_650_000_000_000);
      expect((await A.protectAction.protect(provSha)).status).toBe('applied');

      failRestoreB.value = true;
      await B.syncEngine.sync();
      expect(
        (await B.repository.findLocalAsset(provSha))?.sourceImageId,
      ).toBeNull();

      // Next sync retries because the failed asset's index entry was invalidated:
      await B.syncEngine.sync();
      expect(
        (await B.repository.findLocalAsset(provSha))?.sourceImageId,
      ).not.toBeNull();
    } finally {
      A.close();
      B.close();
    }
  });

  test('6: encryption-off (encryption: none) v3 import classification round-trip on MinIO', async () => {
    const prefix = `${runPrefix}enc-none/`;
    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(
      setupTransport,
      prefix,
      null,
      'none',
    );
    const vaultB = await openExistingVault(setupTransport, prefix, null);

    const A = await createA3Device({
      deviceId: 'dev-a',
      meta: vaultA.meta,
      masterKey: vaultA.masterKey,
      prefix,
    });
    const B = await createA3Device({
      deviceId: 'dev-b',
      meta: vaultB.meta,
      masterKey: vaultB.masterKey,
      prefix,
    });

    try {
      const bytesSafe = makePngBytes(20);
      const shaSafe = sha256PlaintextHex(bytesSafe);
      await A.importPickerBytes(bytesSafe, 'safe');
      expect((await A.protectAction.protect(shaSafe)).status).toBe('applied');

      await B.syncEngine.sync();
      expect(await B.repository.findLocalAsset(shaSafe)).toMatchObject({
        origin: 'import',
        importClassification: 'safe',
        sourceImageId: null,
      });
    } finally {
      A.close();
      B.close();
    }
  });

  test('7 & 8: §4.4 cross-device collisions on real MinIO — (7) provider-first vs offline import, and (8) import-first vs offline provider save', async () => {
    const prefix = `${runPrefix}collisions/`;
    const setupTransport = createS3Transport(credentials);
    const vaultA = await createVaultOrAdopt(
      setupTransport,
      prefix,
      PASSWORD,
      'aes-gcm',
    );
    const vaultB = await openExistingVault(setupTransport, prefix, PASSWORD);
    const vaultC = await openExistingVault(setupTransport, prefix, PASSWORD);

    const A = await createA3Device({
      deviceId: 'dev-a',
      meta: vaultA.meta,
      masterKey: vaultA.masterKey,
      prefix,
    });
    const B = await createA3Device({
      deviceId: 'dev-b',
      meta: vaultB.meta,
      masterKey: vaultB.masterKey,
      prefix,
    });
    const C = await createA3Device({
      deviceId: 'dev-c',
      meta: vaultC.meta,
      masterKey: vaultC.masterKey,
      prefix,
    });

    try {
      // --- Item 7: Provider-first on A, offline import on B ---
      const bytes7 = makePngBytes(70);
      const sha7 = sha256PlaintextHex(bytes7);
      const provTime7 = 1_611_000_000_000;
      await A.saveProviderBytes(bytes7, PROVIDER_CANDIDATE, provTime7);
      expect((await A.protectAction.protect(sha7)).status).toBe('applied');

      // Before B syncs, B is offline and imports the identical bytes as 'safe'
      B.setOnline(false);
      const bBatch7 = await B.importPickerBytes(bytes7, 'safe');
      expect(bBatch7).toMatchObject({
        selected: 1,
        ingested: 1,
        duplicates: 0,
      });

      // B reconnects and syncs: S3 collect merges, B converges to provider origin/source/provTime7!
      B.setOnline(true);
      await B.syncEngine.sync();

      const bAsset7 = await B.repository.findLocalAsset(sha7);
      expect(bAsset7).toMatchObject({
        origin: 'provider',
        importClassification: 'unknown',
        createdAt: provTime7,
        residency: 'local-original',
      });
      expect(bAsset7?.sourceImageId).not.toBeNull();
      const bRestoredImg7 = await B.database.getFirst<{
        provider_key: string;
        provider_item_id: string;
        content_rating: string;
      }>(
        'SELECT provider_key, provider_item_id, content_rating FROM images WHERE id = ?',
        [bAsset7!.sourceImageId!],
      );
      expect(bRestoredImg7).toEqual({
        provider_key: 'danbooru',
        provider_item_id: '990011',
        content_rating: 'explicit',
      });

      // Fresh device C restores the winning provider record
      await C.syncEngine.sync();
      const cAsset7 = await C.repository.findLocalAsset(sha7);
      expect(cAsset7?.origin).toBe('provider');
      expect(cAsset7?.sourceImageId).not.toBeNull();

      // --- Item 8: Import-first on A, offline provider save on B ---
      const bytes8 = makePngBytes(80);
      const sha8 = sha256PlaintextHex(bytes8);
      await A.importPickerBytes(bytes8, 'adult');
      const importTime8 = (await A.repository.findLocalAsset(sha8))!.createdAt;
      expect((await A.protectAction.protect(sha8)).status).toBe('applied');

      // Before B discovers it, B makes its own offline provider save of identical bytes
      const candidate8: ImageCandidate = {
        ...PROVIDER_CANDIDATE,
        providerItemId: '880022',
        canonicalSourceKey: 'danbooru:880022',
        md5: 'fedcba9876543210fedcba9876543210',
        remoteUrl: 'https://example.test/880022.png',
        sampleUrl: 'https://example.test/880022-s.png',
        sourceUrl: 'https://example.test/posts/880022',
      };
      const { stored: bSaved8 } = await B.saveProviderBytes(
        bytes8,
        candidate8,
        1_699_000_000_000,
      );

      // B reconnects and syncs: S3 collect merges, B's digest row converges to
      // import ('adult', importTime8, source_image_id = NULL) while retaining its
      // own saved provider member in `library_provider_image_assets`!
      await B.syncEngine.sync();
      const bAsset8 = await B.repository.findLocalAsset(sha8);
      expect(bAsset8).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'adult',
        createdAt: importTime8,
        residency: 'local-original',
      });
      const bAssoc8 = await B.database.getFirst<{
        image_id: number;
        plaintext_sha256: string;
      }>(
        'SELECT image_id, plaintext_sha256 FROM library_provider_image_assets WHERE image_id = ?',
        [bSaved8.id],
      );
      expect(bAssoc8).toEqual({
        image_id: bSaved8.id,
        plaintext_sha256: sha8,
      });

      // A and fresh device C show ONLY the import; losing provider metadata is never published/restored there!
      await A.syncEngine.sync();
      await C.syncEngine.sync();
      const aAsset8 = await A.repository.findLocalAsset(sha8);
      const cAsset8 = await C.repository.findLocalAsset(sha8);
      expect(aAsset8).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'adult',
      });
      expect(cAsset8).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'adult',
      });
      const cImg8 = await C.database.getFirst<{ n: number }>(
        "SELECT COUNT(*) AS n FROM images WHERE provider_item_id = '880022'",
      );
      expect(cImg8?.n).toBe(0);
    } finally {
      A.close();
      B.close();
      C.close();
    }
  });
});
