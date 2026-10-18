/**
 * P12-B (spec §8): the append-only protocol's two-device convergence over a
 * REAL WebDAV server — the same production stack the composition root binds
 * (`createAppendDevice` from the shared harness), with the memory store swapped
 * for `createWebdavCloudObjectStore` against the backend `verify:byos-webdav`
 * selected. The scenario is the unit suite's first test; the only change is
 * that "the listing caught up" is observed by polling the real backend instead
 * of advancing a fake clock.
 */
import { sha256PlaintextHex } from '@/features/library/library-identity';
import {
  encodeAssetState,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import { buildLibraryEncryptedMetadata } from '@/features/library/library-source-metadata';
import {
  encodeNoteName,
  nextMutationId,
} from '@/features/library/library-note-name';
import {
  APPEND_TEST_MASTER_KEY,
  assetIdOf,
  createAppendDevice,
  headOf,
  imageBytes,
  listedNotesIn,
  type AppendDevice,
} from '@/test/append-two-device-harness';

import { bindingFor, configured, createRunFolder, deleteRunFolder, label, storeFor } from './webdav-test-support';

const describeBackend = configured ? describe : describe.skip;

/** Sync `device` until `predicate` holds (a real listing may lag a write by seconds). */
async function syncUntil(device: AppendDevice, predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await device.sync();
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`gave up waiting for: ${what}`);
}

describeBackend(`append-only protocol v2 over a real WebDAV store — ${label}`, () => {
  jest.setTimeout(300_000);

  test('A collects+protects, B trashes after seeing it, A restores after seeing that — both end on the same head, one note survives', async () => {
    const run = `d${Date.now().toString(36)}`;
    const binding = bindingFor(run);
    await createRunFolder(binding);
    const store = storeFor(binding);
    await store.ensureLayout();
    const calls: string[] = [];
    // The harness's own per-device recorder answers "did THIS device re-read its
    // own note"; this one only pins that the streaming blob path was exercised.
    const recorded = { ...store, putFromFile: async (...args: Parameters<typeof store.putFromFile>) => { calls.push('putFromFile'); return store.putFromFile(...args); } };
    const A = await createAppendDevice({ deviceId: 'device-A-uuid', store: recorded, clock: Date.now });
    const B = await createAppendDevice({ deviceId: 'device-B-uuid', store: recorded, clock: Date.now });
    try {
      const plaintext = imageBytes(4096, 3);
      const digest = sha256PlaintextHex(plaintext);

      await A.ingest(digest, plaintext);
      expect((await A.protect(digest)).status).toBe('applied');
      expect((await A.recordOf(digest))?.lifecycle).toBe('active');

      await syncUntil(B, async () => (await B.recordOf(digest))?.protection === 'protected', 'B discovers A\'s protect');

      expect((await B.removeFromLibrary(digest)).status).toBe('applied');
      await B.sync();
      const midNotes = await listedNotesIn(store);
      expect(midNotes.filter((n) => n.writer === 'device-B')).toHaveLength(1);
      expect(headOf(midNotes).writer).toBe('device-B');

      await syncUntil(A, async () => (await A.recordOf(digest))?.lifecycle === 'trash', 'A discovers B\'s trash');

      await A.restore(digest);
      await A.sync();
      await syncUntil(B, async () => (await B.recordOf(digest))?.lifecycle === 'active', 'B discovers A\'s restore');

      const [ra, rb] = [await A.recordOf(digest), await B.recordOf(digest)];
      expect(ra?.lifecycle).toBe('active');
      expect(rb?.lifecycle).toBe('active');
      expect(ra?.revision).toBe(4);
      expect(rb?.revision).toBe(4);
      expect(ra?.originalGenerationId).toEqual(expect.any(String));
      expect(ra?.originalGenerationId).toBe(rb?.originalGenerationId);

      // Converged: after both devices have swept, exactly one note survives
      // for the asset and it is A's restore (the greatest ULID).
      await syncUntil(A, async () => (await listedNotesIn(store)).length === 1, 'the superseded notes are swept');
      const notes = await listedNotesIn(store);
      expect(notes).toHaveLength(1);
      expect(headOf(notes).writer).toBe('device-A');
      expect(notes[0]!.assetId).toBe(assetIdOf(digest));

      const [ha, hb] = [await A.head(digest), await B.head(digest)];
      expect(ha?.mutationId).toBe(hb?.mutationId);
      expect(ha?.record.lifecycle).toBe('active');
      expect(ha?.record.revision).toBe(4);

      expect(A.ownStateGets()).toEqual([]);
      expect(B.ownStateGets()).toEqual([]);
      expect(calls).toContain('putFromFile');
    } finally {
      A.close();
      B.close();
      await deleteRunFolder(binding);
    }
  });

  test('N6-A3: greater-ULID append note at lower revision replaces whole winning state, clears verified_at, and converges both §4.4 collision directions', async () => {
    const run = `a3${Date.now().toString(36)}`;
    const binding = bindingFor(run);
    await createRunFolder(binding);
    const store = storeFor(binding);
    await store.ensureLayout();
    const A = await createAppendDevice({ deviceId: 'device-A-uuid', store, clock: Date.now });
    const B = await createAppendDevice({ deviceId: 'device-B-uuid', store, clock: Date.now });
    try {
      // 1. Direction 2 collision + whole-winning-state replacement:
      // Device A collects as provider (t = 1_700_000_020_000) and protects (revision 2).
      // Device B imports the same bytes as adult (t = 1_700_000_010_000).
      const plaintext1 = imageBytes(2048, 41);
      const digest1 = sha256PlaintextHex(plaintext1);
      const assetId1 = assetIdOf(digest1);

      await A.ingestCollected(
        digest1,
        plaintext1,
        {
          providerKey: 'danbooru',
          providerItemId: '910001',
          canonicalSourceKey: 'https://danbooru.donmai.us/posts/910001',
          perceptualHash: null,
          md5: null,
          remoteUrl: 'https://cdn.example/910001-full.jpg',
          sampleUrl: 'https://cdn.example/910001-preview.jpg',
          sourceUrl: 'https://danbooru.donmai.us/posts/910001',
          artistName: 'artist_webdav',
          artistUrl: null,
          width: 64,
          height: 64,
          byteSize: 2048,
          extension: '.jpg',
          dominantColor: '#1a202c',
          contentRating: 'safe',
          nativeRating: 'g',
          isNsfw: false,
          isAnimated: false,
          tags: ['solo', 'umbrella'],
        },
        1_700_000_020_000,
      );
      expect((await A.protect(digest1)).status).toBe('applied');

      // Device B holds a local import at earlier timestamp 1_700_000_010_000.
      await B.ingest(digest1, plaintext1, {
        importClassification: 'adult',
        collectedAt: 1_700_000_010_000,
      });
      await B.database.run(`DELETE FROM library_outbox`);

      await syncUntil(
        B,
        async () => (await B.deviceAssetOf(digest1))?.origin === 'provider',
        'B upgrades local import to provider on remote provider state',
      );
      const bAssetAfterProvider = await B.deviceAssetOf(digest1);
      expect(bAssetAfterProvider?.origin).toBe('provider');
      expect(bAssetAfterProvider?.source_image_id).toEqual(expect.any(Number));
      expect(bAssetAfterProvider?.import_classification).toBe('unknown');
      expect(bAssetAfterProvider?.created_at).toBe(1_700_000_020_000);
      expect((await B.recordOf(digest1))?.protection).toBe('protected');
      expect((await B.recordOf(digest1))?.revision).toBe(2);
      expect((await B.recordOf(digest1))?.verifiedAt).toBeNull();

      // When B runs protect(digest1) with local original bytes matching the remote
      // committed generation, it adopts verification without re-uploading.
      expect((await B.protect(digest1)).status).toBe('applied');
      expect((await B.recordOf(digest1))?.verifiedAt).toEqual(expect.any(Number));

      // Now write a greater-ULID append note at LOWER revision 1 with protection='unprotected'
      // and null object refs (simulating a concurrent uncoordinated collect note that won LWW).
      const lateNoteName = encodeNoteName({
        assetId: assetId1,
        mutationId: nextMutationId(null, { now: () => Date.now() + 10_000 }),
        writer: 'deviceC0',
      });
      const sealedImportMeta = await A.cipher.sealMetadata({
        masterKey: APPEND_TEST_MASTER_KEY,
        assetId: assetId1,
        metadata: buildLibraryEncryptedMetadata(
          {
            plaintextSha256: digest1,
            format: 'jpeg',
            canonicalExtension: 'jpg',
            byteSize: plaintext1.byteLength,
            width: 64,
            height: 64,
            origin: 'import',
            sourceImageId: null,
            collectedAt: 1_700_000_005_000,
            importClassification: 'safe',
          },
          null,
        ),
      });
      const winningUnprotectedRecord: LibraryAssetStateRecord = {
        assetId: assetId1,
        lifecycle: 'active',
        protection: 'unprotected',
        generation: 1,
        revision: 1,
        lastMutationId: 'mut-unprotected-winner',
        trashedAt: null,
        generations: {},
        meta: sealedImportMeta,
      };
      await store.put(
        `state/${lateNoteName}`,
        encodeAssetState(winningUnprotectedRecord),
        'application/json',
      );

      await syncUntil(
        B,
        async () => (await B.recordOf(digest1))?.appliedStateKey === `state/${lateNoteName}`,
        'B applies greater-ULID revision-1 note over revision-2 projection',
      );
      const bRecAfterLowerRevWinner = await B.recordOf(digest1);
      expect(bRecAfterLowerRevWinner).toMatchObject({
        lifecycle: 'active',
        protection: 'unprotected',
        generation: 1,
        revision: 1,
        originalGenerationId: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        appliedStateKey: `state/${lateNoteName}`,
      });
      // And Direction 1 (winning remote import over local provider save) retains the saved
      // provider row in library_provider_image_assets while switching device_library_assets to import:
      expect(await B.deviceAssetOf(digest1)).toMatchObject({
        origin: 'import',
        source_image_id: null,
        import_classification: 'safe',
        created_at: 1_700_000_005_000,
      });
      const retainedProviderLink = await B.database.getFirst<{ plaintext_sha256: string }>(
        `SELECT plaintext_sha256 FROM library_provider_image_assets WHERE image_id = ?`,
        [bAssetAfterProvider!.source_image_id],
      );
      expect(retainedProviderLink?.plaintext_sha256).toBe(digest1);
      // And because the winning note is unprotected (verifiedAt cleared), B refuses to evict local original bytes:
      expect((await B.freeDeviceSpace(digest1)).status).toBe('blocked');
      expect((await B.deviceAssetOf(digest1))?.residency).toBe('local-original');

      // 2. Direction 1 collision: both devices import same digest with different classification.
      const plaintext2 = imageBytes(2048, 42);
      const digest2 = sha256PlaintextHex(plaintext2);
      await A.ingest(digest2, plaintext2, {
        importClassification: 'safe',
        collectedAt: 1_700_000_030_000,
      });
      expect((await A.protect(digest2)).status).toBe('applied');

      await B.ingest(digest2, plaintext2, {
        importClassification: 'adult',
        collectedAt: 1_700_000_050_000,
      });
      await B.database.run(`DELETE FROM library_outbox`);

      await syncUntil(
        B,
        async () => (await B.deviceAssetOf(digest2))?.import_classification === 'safe',
        'B converges import classification to winning remote safe note and min timestamp',
      );
      expect(await B.deviceAssetOf(digest2)).toMatchObject({
        origin: 'import',
        source_image_id: null,
        import_classification: 'safe',
        created_at: 1_700_000_030_000,
      });
    } finally {
      A.close();
      B.close();
      await deleteRunFolder(binding);
    }
  });
});
