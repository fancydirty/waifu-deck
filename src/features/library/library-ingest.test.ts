/**
 * Ingest hashes every collected image, and after K6-1f that hash is
 * `expo-crypto`'s native digest. Under `jest-expo` the unmocked native module
 * answers `digest` with a 32-byte ZERO buffer, so every asset here would be
 * named `0000…` and collide; map `expo-crypto` onto the double's genuine
 * SHA-256 (K6-1e's idiom).
 */
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

/**
 * Counts every `sha256PlaintextHex` call made through the real module during a
 * test. K6-1f: ingest is on the critical path of every single collected image,
 * and on Hermes (no JIT) the pure-JS @noble hash cost ~1.4 s of JS thread for
 * one 6.5 MB PNG — one uninterruptible task that also delayed a neighbouring
 * image's commit by 2 s and froze the UI. Zero calls from ingest, not "fewer".
 * The wrapper delegates to the real implementation, so every other consumer
 * (including this file's own expected-value computations) keeps its behaviour.
 */
const mockShaCalls = { count: 0 };
jest.mock('@/features/library/library-identity', () => {
  const actual = jest.requireActual('@/features/library/library-identity');
  return {
    ...actual,
    sha256PlaintextHex: (plaintext: Uint8Array): string => {
      mockShaCalls.count += 1;
      return actual.sha256PlaintextHex(plaintext);
    },
  };
});

import {
  createLibraryIngestService,
  type LibraryAccountPort,
} from '@/features/library/library-ingest';
import {
  deriveLibraryAccountScope,
  deriveLibraryAssetId,
  sha256PlaintextHex,
} from '@/features/library/library-identity';
import {
  CORRUPT_JPEG_FIXTURE,
  createLibraryTestHarness,
  GIF_FIXTURE,
  JPEG_FIXTURE,
  LOCAL_ONLY_ACCOUNT_PORT,
  NOT_AN_IMAGE_FIXTURE,
  PNG_FIXTURE,
  type LibraryTestHarness,
} from '@/features/library/library-test-support';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import { seedDeviceLibraryAsset } from '@/features/library/library-view-test-support';

function serviceFor(
  harness: LibraryTestHarness,
  account: LibraryAccountPort = harness.signedInAccount,
) {
  return createLibraryIngestService({
    files: harness.files,
    repository: harness.repository,
    decodeGate: harness.decodeGate,
    account,
    newMutationId: harness.newMutationId,
    clock: harness.clock,
  });
}

describe('library ingest layer A (no account, no network)', () => {
  test('makes bytes durable with no account and writes no account state', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const outcome = await ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
      });

      const digest = sha256PlaintextHex(JPEG_FIXTURE);

      expect(outcome.status).toBe('ingested');
      expect(outcome.enrollment).toEqual({
        status: 'skipped',
        reason: 'no_account',
      });
      expect(outcome.asset).toMatchObject({
        plaintextSha256: digest,
        format: 'jpeg',
        canonicalExtension: 'jpg',
        byteSize: JPEG_FIXTURE.byteLength,
        origin: 'import',
        sourceImageId: null,
        localOriginalUri: `${harness.port.originalsRootUri}/${digest}.jpg`,
        residency: 'local-original',
        protectEligible: true,
        missingOriginalSince: null,
        localThumbnailUri: null,
      });
      // Board #27 S2: a new asset names no thumbnail until one is ensured.
      await expect(harness.repository.findLocalAsset(digest)).resolves.toMatchObject({
        localThumbnailUri: null,
      });

      expect(await harness.port.readBytes(outcome.asset.localOriginalUri!))
        .toEqual(JPEG_FIXTURE);
      expect(await harness.port.listTemp()).toEqual([]);
      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(1);
      await expect(
        harness.database.getAll<{ mutation_id: string }>(
          'SELECT mutation_id FROM library_outbox',
        ),
      ).resolves.toEqual([]);
      await expect(
        harness.database.getAll<{ asset_id: string }>(
          'SELECT asset_id FROM library_account_assets',
        ),
      ).resolves.toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('skips Layer B when a session exists without a registered device', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, {
        async vaultMasterKey() {
          return harness.masterKey;
        },
        async deviceId() {
          return null;
        },
        async accountScope() {
          return deriveLibraryAccountScope(harness.masterKey);
        },
      });

      const outcome = await ingest.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'import',
      });

      expect(outcome.status).toBe('ingested');
      expect(outcome.enrollment).toEqual({
        status: 'skipped',
        reason: 'no_device',
      });
      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(1);
      await expect(
        harness.database.getAll<{ mutation_id: string }>(
          'SELECT mutation_id FROM library_outbox',
        ),
      ).resolves.toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('is idempotent for the same plaintext on the device', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const first = await ingest.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'import',
      });
      const second = await ingest.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'import',
      });

      expect(first.status).toBe('ingested');
      expect(second.status).toBe('duplicate');
      expect(second.asset.plaintextSha256).toBe(first.asset.plaintextSha256);
      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(1);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('rejects a file whose extension lies about its bytes', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      harness.port.files.set(
        'content://picker/vacation.jpg',
        NOT_AN_IMAGE_FIXTURE,
      );

      await expect(ingest.ingestUri({
        sourceUri: 'content://picker/vacation.jpg',
        origin: 'import',
      })).rejects.toMatchObject({ code: 'unsupported_format' });

      expect(await harness.port.listTemp()).toEqual([]);
      expect(await harness.port.listOriginals()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('rejects an empty file and a corrupt image', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness);

      await expect(ingest.ingestBytes({
        bytes: new Uint8Array(),
        origin: 'import',
      })).rejects.toMatchObject({ code: 'empty_file' });

      await expect(ingest.ingestBytes({
        bytes: CORRUPT_JPEG_FIXTURE,
        origin: 'import',
      })).rejects.toMatchObject({ code: 'decode_failed' });

      expect(await harness.port.listTemp()).toEqual([]);
      expect(await harness.port.listOriginals()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('stores an oversize original but marks it not protect eligible', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const oversize = new Uint8Array(
        LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES + 1,
      );
      oversize.set(GIF_FIXTURE);

      const outcome = await ingest.ingestBytes({
        bytes: oversize,
        origin: 'import',
      });

      expect(outcome.status).toBe('ingested');
      expect(outcome.asset.protectEligible).toBe(false);
      expect(outcome.asset.residency).toBe('local-original');
      expect(outcome.asset.localOriginalUri).not.toBeNull();
    } finally {
      harness.close();
    }
  });

  test('removes a promoted original when the Layer A commit fails', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: {
          ...harness.repository,
          commitLocalAsset: async () => {
            throw new Error('database is locked');
          },
        },
        decodeGate: harness.decodeGate,
        account: harness.signedInAccount,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
      });

      await expect(ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
      })).rejects.toMatchObject({ code: 'database_failed' });

      expect(await harness.port.listOriginals()).toEqual([]);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('reconciles temporary leftovers, orphan files, and missing originals', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const kept = await ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
      });

      const orphanUri = `${harness.port.originalsRootUri}/${'d'.repeat(64)}.png`;
      harness.port.files.set(orphanUri, PNG_FIXTURE);
      const staleTempUri =
        `${harness.port.tempRootUri}/wd-lib-1-99${'.tmp'}`;
      harness.port.files.set(staleTempUri, PNG_FIXTURE);

      const second = await ingest.ingestBytes({
        bytes: GIF_FIXTURE,
        origin: 'import',
      });
      harness.port.files.delete(second.asset.localOriginalUri!);

      const summary = await ingest.reconcileStorage();

      expect(summary.deletedTemporary).toEqual([staleTempUri]);
      expect(summary.deletedOrphanOriginals).toEqual([orphanUri]);
      expect(summary.missingOriginals).toEqual([
        second.asset.localOriginalUri,
      ]);
      expect(summary.flaggedDigests).toEqual([second.asset.plaintextSha256]);
      expect(await harness.port.exists(kept.asset.localOriginalUri!)).toBe(true);
      await expect(
        harness.repository.findLocalAsset(second.asset.plaintextSha256),
      ).resolves.toMatchObject({ missingOriginalSince: expect.any(Number) });
    } finally {
      harness.close();
    }
  });

  test('notifies the save-policy observer only for a newly committed collection', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const seen: string[] = [];
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        onIngestOutcome: (outcome) => {
          seen.push(outcome.status);
        },
      });

      const first = await ingest.ingestBytes({
        bytes: GIF_FIXTURE,
        origin: 'import',
      });
      const second = await ingest.ingestBytes({
        bytes: GIF_FIXTURE,
        origin: 'import',
      });

      expect(first.status).toBe('ingested');
      expect(second.status).toBe('duplicate');
      // A duplicate is an existing asset. A changed save policy must not reach
      // it: that would be the silent migration the design forbids.
      expect(seen).toEqual(['ingested']);

      // Board #27 S1b (spec §5.6, OQ-7): a heal adopts fresh bytes for an
      // asset the device already has a row for. It is no new collection.
      harness.port.files.delete(first.asset.localOriginalUri!);
      const third = await ingest.ingestBytes({
        bytes: GIF_FIXTURE,
        origin: 'import',
      });

      expect(third.status).toBe('duplicate');
      expect(harness.port.files.get(first.asset.localOriginalUri!))
        .toEqual(GIF_FIXTURE);
      expect(seen).toEqual(['ingested']);
    } finally {
      harness.close();
    }
  });
});

/**
 * Board #27 S1b Task 3. A duplicate ingest is "already local" only when its
 * row has a usable original: `local-original`, a uri inside this device's
 * originals directory, no missing flag, and the file on disk. Otherwise the
 * fresh bytes are adopted — except by a device-trashed (`cached`) row.
 */
describe('board #27 S1b: a duplicate ingest heals (spec §5.6)', () => {
  const FOREIGN_ORIGINALS =
    'file:///data/user/10/app.waifudeck.mobile/files/library/originals/';

  /** Image 5's ingest: one `local-original` row whose file is on disk. */
  async function firstIngest(harness: LibraryTestHarness) {
    const outcome = await serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT)
      .ingestBytes({ bytes: JPEG_FIXTURE, origin: 'provider', sourceImageId: 5 });
    const digest = outcome.asset.plaintextSha256;
    return { digest, uri: harness.files.originalUriFor(digest, 'jpg') };
  }

  /** What the second ingest's clock answers; a heal stamps the row with it. */
  const HEAL_AT = 9_000;

  /** The second ingest's service; `repository` can swap in a failing write. */
  function secondService(
    harness: LibraryTestHarness,
    repository: LibraryTestHarness['repository'] = harness.repository,
  ) {
    return createLibraryIngestService({
      files: harness.files,
      repository,
      decodeGate: harness.decodeGate,
      account: LOCAL_ONLY_ACCOUNT_PORT,
      newMutationId: harness.newMutationId,
      clock: () => HEAL_AT,
    });
  }

  /** Image 6 saves the same bytes. */
  function secondIngest(
    harness: LibraryTestHarness,
    ingest = secondService(harness),
  ) {
    return ingest.ingestBytes({
      bytes: JPEG_FIXTURE,
      origin: 'provider',
      sourceImageId: 6,
    });
  }

  async function flag(harness: LibraryTestHarness, digest: string) {
    await harness.database.run(
      `UPDATE device_library_assets SET missing_original_since = 7
        WHERE plaintext_sha256 = ?`,
      [digest],
    );
  }

  /** The row names Android user 10's path, where the port holds the bytes. */
  async function pointAtForeignPath(harness: LibraryTestHarness, digest: string) {
    const foreignUri = `${FOREIGN_ORIGINALS}${digest}.jpg`;
    await harness.database.run(
      `UPDATE device_library_assets SET local_original_uri = ?
        WHERE plaintext_sha256 = ?`,
      [foreignUri, digest],
    );
    // Held, so only the directory rule refuses it.
    harness.port.files.set(foreignUri, Uint8Array.from(JPEG_FIXTURE));
  }

  // Each removes the file from the Map directly: `port.delete` would itself
  // be recorded in `deletedFiles`.
  const setups = {
    async flagged(harness: LibraryTestHarness, digest: string, uri: string) {
      harness.port.files.delete(uri);
      await flag(harness, digest);
    },
    async vanished(harness: LibraryTestHarness, _digest: string, uri: string) {
      harness.port.files.delete(uri);
    },
    async 'cloud-only'(harness: LibraryTestHarness, digest: string, uri: string) {
      await harness.database.run(
        `UPDATE device_library_assets
            SET residency = 'cloud-only', local_original_uri = NULL
          WHERE plaintext_sha256 = ?`,
        [digest],
      );
      harness.port.files.delete(uri);
    },
    async foreign(harness: LibraryTestHarness, digest: string, uri: string) {
      await pointAtForeignPath(harness, digest);
      harness.port.files.delete(uri);
    },
    // This device's own file for the digest stays at `uri`, as a crashed
    // earlier heal (a promote no adoption followed) leaves it. Unflagged, so
    // the file check is reached: it must read the row's own uri, not the
    // digest's path on this device.
    async 'foreign, own file kept'(
      harness: LibraryTestHarness,
      digest: string,
      _uri: string,
    ) {
      await pointAtForeignPath(harness, digest);
    },
  };

  test.each([
    'flagged',
    'vanished',
    'cloud-only',
    'foreign',
    'foreign, own file kept',
  ] as const)(
    '%s: the fresh bytes become the original and the flag clears',
    async (setup) => {
      const harness = await createLibraryTestHarness();
      try {
        const { digest, uri } = await firstIngest(harness);
        await setups[setup](harness, digest, uri);

        const outcome = await secondIngest(harness);

        expect(outcome.status).toBe('duplicate');
        // `updatedAt` is the adoption's own stamp: the missing pass's guard
        // skips a row healed after its SELECT only because `updated_at` moved.
        await expect(harness.repository.findLocalAsset(digest)).resolves.toMatchObject({
          residency: 'local-original', localOriginalUri: uri, missingOriginalSince: null, sourceImageId: 5,
          updatedAt: HEAL_AT,
        });
        expect(outcome.asset).toMatchObject({
          localOriginalUri: uri, missingOriginalSince: null, updatedAt: HEAL_AT,
        });
        expect(harness.port.files.get(uri)).toEqual(JPEG_FIXTURE);
      } finally {
        harness.close();
      }
    },
  );

  test('a device-trashed asset is never adopted and no original is written', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const { digest, uri } = await firstIngest(harness);
      await harness.database.run(
        `UPDATE device_library_assets
            SET residency = 'cached', local_original_uri = NULL
          WHERE plaintext_sha256 = ?`,
        [digest],
      );
      harness.port.files.delete(uri);
      const before = await harness.repository.findLocalAsset(digest);

      const outcome = await secondIngest(harness);

      expect(outcome.status).toBe('duplicate');
      await expect(harness.repository.findLocalAsset(digest)).resolves.toEqual(before);
      await expect(harness.port.listOriginals()).resolves.toEqual([]);
      // Nothing was promoted, so nothing had to be rolled back.
      expect(harness.port.deletedFiles.filter(
        (deleted) => deleted.startsWith(harness.port.originalsRootUri),
      )).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('an original on disk stays a plain duplicate and is not rewritten', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const { digest } = await firstIngest(harness);
      const before = await harness.repository.findLocalAsset(digest);

      const outcome = await secondIngest(harness);

      expect(outcome.status).toBe('duplicate');
      await expect(harness.repository.findLocalAsset(digest)).resolves.toEqual(before);
    } finally {
      harness.close();
    }
  });

  test('a heal whose row vanished leaves no original behind', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const { digest, uri } = await firstIngest(harness);
      await setups.flagged(harness, digest, uri);
      // Purged or device-trashed between the lookup and the adoption.
      const ingest = secondService(harness, {
        ...harness.repository,
        adoptLocalOriginal: async () => null,
      });

      const outcome = await secondIngest(harness, ingest);

      expect(outcome.status).toBe('duplicate');
      await expect(harness.port.listOriginals()).resolves.toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a heal whose database write fails removes the promoted original', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const { digest, uri } = await firstIngest(harness);
      await setups.flagged(harness, digest, uri);
      const ingest = secondService(harness, {
        ...harness.repository,
        adoptLocalOriginal: async () => {
          throw new Error('database is locked');
        },
      });

      await expect(secondIngest(harness, ingest))
        .rejects.toMatchObject({ code: 'database_failed' });
      await expect(harness.port.listOriginals()).resolves.toEqual([]);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('a failed heal keeps an original that was on disk before its promote', async () => {
    // The flag is stale: the content-addressed file is still there, so the
    // promote reuses it (`reused: true`). A rollback removes only a file its
    // own promote created.
    const harness = await createLibraryTestHarness();
    try {
      const { digest, uri } = await firstIngest(harness);
      await flag(harness, digest);
      const ingest = secondService(harness, {
        ...harness.repository,
        adoptLocalOriginal: async () => {
          throw new Error('database is locked');
        },
      });

      await expect(secondIngest(harness, ingest))
        .rejects.toMatchObject({ code: 'database_failed' });
      expect(harness.port.files.get(uri)).toEqual(JPEG_FIXTURE);
      expect(harness.port.deletedFiles).not.toContain(uri);
    } finally {
      harness.close();
    }
  });
});

/**
 * Board #27 S1b Task 6: two ingests of the same bytes (spec R12) promote to one
 * content-addressed path. When the one that created the file rolls back after
 * the other committed a row naming it, the file stays: that row's image may
 * already have handed its collection file to the library.
 */
describe('board #27 S1b: a rollback never deletes a named original', () => {
  const digest = sha256PlaintextHex(JPEG_FIXTURE);

  /** Its promote creates U; `beforeThrow` runs, then the Layer A commit throws. */
  function failingCommit(
    harness: LibraryTestHarness,
    beforeThrow: () => Promise<void>,
    isOriginalNamed = harness.repository.isOriginalNamed,
  ) {
    return createLibraryIngestService({
      files: harness.files,
      repository: {
        ...harness.repository,
        isOriginalNamed,
        commitLocalAsset: async () => {
          await beforeThrow();
          throw new Error('database is locked');
        },
      },
      decodeGate: harness.decodeGate,
      account: LOCAL_ONLY_ACCOUNT_PORT,
      newMutationId: harness.newMutationId,
      clock: harness.clock,
    }).ingestBytes({ bytes: JPEG_FIXTURE, origin: 'provider', sourceImageId: 8 });
  }

  async function otherIngestsRow(
    harness: LibraryTestHarness,
    over: Readonly<{ missingOriginalSince?: number | null }> = {},
  ) {
    await seedDeviceLibraryAsset(harness.database, {
      plaintextSha256: digest,
      sourceImageId: 7,
      residency: 'local-original',
      localOriginalUri: harness.files.originalUriFor(digest, 'jpg'),
      byteSize: JPEG_FIXTURE.byteLength,
      missingOriginalSince: over.missingOriginalSince ?? null,
    });
  }

  test('a rollback keeps an original another ingest\'s row now names', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const uri = harness.files.originalUriFor(digest, 'jpg');
      await expect(failingCommit(harness, () => otherIngestsRow(harness)))
        .rejects.toMatchObject({ code: 'database_failed' });
      expect(harness.port.files.get(uri)).toEqual(JPEG_FIXTURE);
      expect(harness.port.deletedFiles).not.toContain(uri);
    } finally {
      harness.close();
    }
  });

  test('with no row naming it, the rollback still deletes the promoted original', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const uri = harness.files.originalUriFor(digest, 'jpg');
      await expect(failingCommit(harness, async () => undefined))
        .rejects.toMatchObject({ code: 'database_failed' });
      expect(harness.port.files.has(uri)).toBe(false);
      expect(harness.port.deletedFiles).toContain(uri);
    } finally {
      harness.close();
    }
  });

  test('a flagged row naming it does not keep the file (the hand-over never trusts it)', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const uri = harness.files.originalUriFor(digest, 'jpg');
      await expect(failingCommit(
        harness,
        () => otherIngestsRow(harness, { missingOriginalSince: 7 }),
      )).rejects.toMatchObject({ code: 'database_failed' });
      expect(harness.port.files.has(uri)).toBe(false);
    } finally {
      harness.close();
    }
  });

  test('a check that fails keeps the file (an orphan only costs disk)', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const uri = harness.files.originalUriFor(digest, 'jpg');
      await expect(failingCommit(harness, async () => undefined, async () => {
        throw new Error('database is locked');
      })).rejects.toMatchObject({ code: 'database_failed' });
      expect(harness.port.files.get(uri)).toEqual(JPEG_FIXTURE);
      expect(harness.port.deletedFiles).not.toContain(uri);
    } finally {
      harness.close();
    }
  });
});

describe('library ingest layer B (signed-in enrichment)', () => {
  test('derives the keyed asset id and writes the collect intent with the device id', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness);
      const outcome = await ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'provider',
        sourceImageId: 42,
      });

      const digest = sha256PlaintextHex(JPEG_FIXTURE);
      const assetId = deriveLibraryAssetId(harness.masterKey, digest);
      const scope = deriveLibraryAccountScope(harness.masterKey);

      expect(outcome.status).toBe('ingested');
      expect(outcome.enrollment.status).toBe('enrolled');
      // The durable file keeps the plaintext digest name, not the keyed id.
      expect(outcome.asset.localOriginalUri)
        .toBe(`${harness.port.originalsRootUri}/${digest}.jpg`);
      await expect(harness.repository.findAccountAsset(scope, digest))
        .resolves.toMatchObject({
          assetId,
          deviceId: harness.deviceId,
        });

      const outbox = await harness.repository.listOutbox(scope);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        assetId,
        deviceId: harness.deviceId,
        kind: 'collect',
        state: 'pending',
        localMetadata: {
          assetId,
          plaintextSha256: digest,
          format: 'jpeg',
          byteSize: JPEG_FIXTURE.byteLength,
          width: 320,
          height: 240,
          origin: 'provider',
          sourceImageId: 42,
        },
      });
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('enriches an asset that was collected while signed out', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const offline = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const local = await offline.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'import',
      });
      expect(local.enrollment).toEqual({
        status: 'skipped',
        reason: 'no_account',
      });

      // The user signs in later. Nothing is re-downloaded or re-decoded.
      const signedIn = serviceFor(harness);
      const enrollment = await signedIn.enrichLocalAssetForAccount(
        local.asset.plaintextSha256,
      );

      const digest = sha256PlaintextHex(PNG_FIXTURE);
      const scope = deriveLibraryAccountScope(harness.masterKey);
      expect(enrollment.status).toBe('enrolled');
      await expect(harness.repository.findAccountAsset(scope, digest))
        .resolves.toMatchObject({
          assetId: deriveLibraryAssetId(harness.masterKey, digest),
          deviceId: harness.deviceId,
        });
      const outbox = await harness.repository.listOutbox(scope);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.deviceId).toBe(harness.deviceId);
      // Layer A metadata is reused verbatim; the local row is untouched.
      await expect(harness.repository.findLocalAsset(digest))
        .resolves.toEqual(local.asset);

      const repeated = await signedIn.enrichLocalAssetForAccount(digest);
      expect(repeated.status).toBe('already-enrolled');
      await expect(harness.repository.listOutbox(scope)).resolves.toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  test('enrolls every unenrolled local asset in one batch after login', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const offline = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      await offline.ingestBytes({ bytes: JPEG_FIXTURE, origin: 'import' });
      await offline.ingestBytes({ bytes: PNG_FIXTURE, origin: 'import' });
      await offline.ingestBytes({ bytes: GIF_FIXTURE, origin: 'provider' });

      const signedIn = serviceFor(harness);
      const first = await signedIn.enrichLocalAssetsForAccount();
      expect(first).toEqual({
        enrolled: 3,
        alreadyEnrolled: 0,
        skipped: 0,
        failed: [],
      });

      const scope = deriveLibraryAccountScope(harness.masterKey);
      const outbox = await harness.repository.listOutbox(scope);
      expect(outbox).toHaveLength(3);
      expect(outbox.every((entry) => entry.deviceId === harness.deviceId))
        .toBe(true);
      expect(new Set(outbox.map((entry) => entry.mutationId)).size).toBe(3);

      const second = await signedIn.enrichLocalAssetsForAccount();
      expect(second.enrolled).toBe(0);
      await expect(harness.repository.listOutbox(scope)).resolves.toHaveLength(3);
    } finally {
      harness.close();
    }
  });

  test('reports a batch skip instead of failing when no account is present', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const offline = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      await offline.ingestBytes({ bytes: JPEG_FIXTURE, origin: 'import' });

      await expect(offline.enrichLocalAssetsForAccount()).resolves.toEqual({
        enrolled: 0,
        alreadyEnrolled: 0,
        skipped: 1,
        failed: [],
      });
      await expect(
        offline.enrichLocalAssetForAccount(sha256PlaintextHex(JPEG_FIXTURE)),
      ).resolves.toEqual({ status: 'skipped', reason: 'no_account' });
    } finally {
      harness.close();
    }
  });

  test('keeps the durable local asset when Layer B fails', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: {
          ...harness.repository,
          commitCollect: async () => {
            throw new Error('database is locked');
          },
        },
        decodeGate: harness.decodeGate,
        account: harness.signedInAccount,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
      });

      const outcome = await ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
      });

      expect(outcome.status).toBe('ingested');
      expect(outcome.enrollment).toEqual({
        status: 'failed',
        code: 'database_failed',
      });
      expect(await harness.port.exists(outcome.asset.localOriginalUri!))
        .toBe(true);
      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(1);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('enrolls a plaintext that two accounts hold under unrelated ids', async () => {
    const harness = await createLibraryTestHarness();
    const otherKey = new Uint8Array(32).fill(9);
    try {
      const first = serviceFor(harness);
      const local = await first.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
      });

      const second = serviceFor(harness, {
        async vaultMasterKey() {
          return otherKey;
        },
        async deviceId() {
          return harness.deviceId;
        },
        async accountScope() {
          return deriveLibraryAccountScope(otherKey);
        },
      });
      await second.enrichLocalAssetForAccount(local.asset.plaintextSha256);

      const digest = local.asset.plaintextSha256;
      const scopeA = deriveLibraryAccountScope(harness.masterKey);
      const scopeB = deriveLibraryAccountScope(otherKey);
      expect(scopeA).not.toBe(scopeB);
      await expect(harness.repository.findAccountAsset(scopeA, digest))
        .resolves.toMatchObject({
          assetId: deriveLibraryAssetId(harness.masterKey, digest),
        });
      await expect(harness.repository.findAccountAsset(scopeB, digest))
        .resolves.toMatchObject({
          assetId: deriveLibraryAssetId(otherKey, digest),
        });
      // One plaintext, one durable file, two unrelated keyed identities.
      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  test('N6-A2 (spec §4.4): same-digest admission gate serializes import-first vs provider-first races and preserves both members under import-first', async () => {
    const harness = await createLibraryTestHarness();
    try {
      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state
         ) VALUES (55, 'danbooru', '55', 'https://example.test/55.jpg', 1, 1, ?, 'jpg', '#112233', 'explicit', 1, 0, '[]', 'saved', 1, 2, 1, 1, 'file:///collection/55.jpg', 'ready')`,
        [JPEG_FIXTURE.byteLength],
      );

      const order: string[] = [];
      let releaseImport!: () => void;
      const holdImport = new Promise<void>((res) => {
        releaseImport = res;
      });
      let notifyImportEntered!: () => void;
      const importEntered = new Promise<void>((res) => {
        notifyImportEntered = res;
      });

      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        onBeforeDigestCommit: async (_sha, origin) => {
          order.push(`enter:${origin}`);
          if (origin === 'import') {
            notifyImportEntered();
            await holdImport;
          }
          order.push(`commit:${origin}`);
        },
      });

      // Import enters the same-digest gate first; provider starts while import
      // is inside the gate and must wait until the import commits.
      const importPromise = ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
        importClassification: 'safe',
        strictImportDuplicate: true,
      });
      await importEntered;

      const providerPromise = ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'provider',
        sourceImageId: 55,
      });
      // Give microtasks a chance: provider must still be waiting on the gate.
      await new Promise((res) => setTimeout(res, 5));
      expect(order).toEqual(['enter:import']);

      releaseImport();
      const [importOutcome, providerOutcome] = await Promise.all([
        importPromise,
        providerPromise,
      ]);

      expect(order).toEqual([
        'enter:import',
        'commit:import',
        'enter:provider',
        'commit:provider',
      ]);
      expect(importOutcome.status).toBe('ingested');
      expect(importOutcome.asset).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'safe',
      });
      expect(providerOutcome.status).toBe('duplicate');

      // Both members are recorded: the digest row stays `origin = 'import'`,
      // and `library_provider_image_assets` records provider #55's association.
      const membership = await harness.repository.inspectDigestMembership(
        importOutcome.asset.plaintextSha256,
        null,
      );
      expect(membership).toMatchObject({
        hasActiveImportMember: true,
        hasActiveProviderMember: true,
      });
    } finally {
      harness.close();
    }
  });

  test('N6-A2 (spec §4.4): applyCrossDeviceCollisionAuthority converges both collision directions while preserving own saved provider member and usable bytes', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);

      // Direction 1: Local import loses to cloud provider record -> digest row
      // becomes origin='provider', source_image_id=77, import_classification='unknown',
      // created_at=cloud original time, and import membership ends.
      const imp = await ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
        importClassification: 'adult',
        strictImportDuplicate: true,
      });
      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state
         ) VALUES (77, 'danbooru', '77', 'https://example.test/77.jpg', 1, 1, ?, 'jpg', '#112233', 'safe', 0, 0, '[]', 'saved', 1, 555, 1, 1, NULL, 'mirrored')`,
        [JPEG_FIXTURE.byteLength],
      );
      const convergedToProvider =
        await harness.repository.applyCrossDeviceCollisionAuthority({
          plaintextSha256: imp.asset.plaintextSha256,
          origin: 'provider',
          sourceImageId: 77,
          importClassification: 'unknown',
          collectedAt: 555,
          at: 2_000,
        });
      expect(convergedToProvider).toMatchObject({
        origin: 'provider',
        sourceImageId: 77,
        importClassification: 'unknown',
        createdAt: 555,
      });
      const afterDir1 = await harness.repository.inspectDigestMembership(
        imp.asset.plaintextSha256,
        null,
      );
      expect(afterDir1).toMatchObject({
        hasActiveImportMember: false,
        hasActiveProviderMember: true,
      });
      expect(await harness.port.exists(imp.asset.localOriginalUri!)).toBe(true);

      // Direction 2: Local provider save loses to cloud import record -> digest
      // row takes import's classification and original time with source_image_id=NULL,
      // while this phone retains its own provider member (#78) in
      // `library_provider_image_assets` and shows BOTH members.
      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state
         ) VALUES (78, 'danbooru', '78', 'https://example.test/78.png', 1, 1, ?, 'png', '#112233', 'explicit', 1, 0, '[]', 'saved', 1, 666, 2, 2, 'file:///collection/78.png', 'ready')`,
        [PNG_FIXTURE.byteLength],
      );
      const prov = await ingest.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'provider',
        sourceImageId: 78,
      });
      // Simulate a legacy row where `library_provider_image_assets` was cleared
      // before convergence so `applyCrossDeviceCollisionAuthority` itself must
      // preserve `existing.sourceImageId` in `library_provider_image_assets`.
      await harness.database.run(
        'DELETE FROM library_provider_image_assets WHERE image_id = 78',
      );
      const convergedToImport =
        await harness.repository.applyCrossDeviceCollisionAuthority({
          plaintextSha256: prov.asset.plaintextSha256,
          origin: 'import',
          sourceImageId: null,
          importClassification: 'safe',
          collectedAt: 333,
          at: 3_000,
        });
      expect(convergedToImport).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        importClassification: 'safe',
        createdAt: 333,
      });
      const afterDir2 = await harness.repository.inspectDigestMembership(
        prov.asset.plaintextSha256,
        null,
      );
      expect(afterDir2).toMatchObject({
        hasActiveImportMember: true,
        hasActiveProviderMember: true,
      });
      expect(await harness.port.exists(prov.asset.localOriginalUri!)).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('N6-A2 (spec §4.9): ingestTempFile with strictImportDuplicate rejects temp.byteSize > maxProtectablePlaintextBytes before readTemp', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const readTempSpy = jest.spyOn(harness.files, 'readTemp');
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        maxProtectablePlaintextBytes: 100,
      });
      let discarded = false;
      await expect(
        ingest.ingestTempFile({
          temp: {
            uri: 'file:///temp/over-cap.jpg',
            byteSize: 101,
            discard: async () => {
              discarded = true;
            },
          },
          origin: 'import',
          importClassification: 'safe',
          strictImportDuplicate: true,
        }),
      ).rejects.toMatchObject({ code: 'file_too_large' });
      expect(readTempSpy).not.toHaveBeenCalled();
      expect(discarded).toBe(true);
    } finally {
      harness.close();
    }
  });
});

describe('library ingest hashes off the JS thread (K6-1f)', () => {
  test('names a collected original with the native digest, not the JS hash', async () => {
    const harness = await createLibraryTestHarness();
    try {
      // No `digest` injected: this is the production default.
      const ingest = serviceFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const expected = sha256PlaintextHex(PNG_FIXTURE);

      mockShaCalls.count = 0;
      const outcome = await ingest.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'import',
      });

      // Same id, same durable file name — only the engine changed.
      expect(outcome.asset.plaintextSha256).toBe(expected);
      expect(outcome.asset.localOriginalUri)
        .toBe(`${harness.port.originalsRootUri}/${expected}.png`);
      // A correct digest with zero @noble calls can only have come from the
      // native port.
      expect(mockShaCalls.count).toBe(0);
    } finally {
      harness.close();
    }
  });

  test('hashes the collected bytes exactly once, through the injected port', async () => {
    const harness = await createLibraryTestHarness();
    const digestSpy = jest.fn(async (bytes: Uint8Array) =>
      sha256PlaintextHex(bytes));
    try {
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        digest: digestSpy,
      });

      const outcome = await ingest.ingestBytes({
        bytes: JPEG_FIXTURE,
        origin: 'import',
      });

      expect(outcome.status).toBe('ingested');
      expect(digestSpy).toHaveBeenCalledTimes(1);
      expect(digestSpy).toHaveBeenCalledWith(JPEG_FIXTURE);
      expect(outcome.asset.plaintextSha256)
        .toBe(sha256PlaintextHex(JPEG_FIXTURE));
    } finally {
      harness.close();
    }
  });

  test('streams SHA-256 and header sniff via fileDigest + readTempPrefix without calling readTemp on full file bytes', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const staged = await harness.files.acquireFromBytes(PNG_FIXTURE);
      const readTempSpy = jest.spyOn(harness.files, 'readTemp');
      const readPrefixSpy = jest.spyOn(harness.files, 'readTempPrefix');
      const expectedSha = sha256PlaintextHex(PNG_FIXTURE);
      const fileDigestSpy = jest.fn(async (uri: string, destUri: string) => ({
        byteSize: PNG_FIXTURE.byteLength,
        plaintextSha256: expectedSha,
      }));

      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        fileDigest: fileDigestSpy,
      });

      const outcome = await ingest.ingestTempFile({
        temp: staged,
        origin: 'import',
        importClassification: 'safe',
        strictImportDuplicate: true,
      });

      expect(outcome.status).toBe('ingested');
      expect(outcome.asset.plaintextSha256).toBe(expectedSha);
      expect(fileDigestSpy).toHaveBeenCalledTimes(1);
      expect(readPrefixSpy).toHaveBeenCalledWith(staged, 16);
      expect(readTempSpy).not.toHaveBeenCalled();
    } finally {
      harness.close();
    }
  });
});
