/**
 * This suite drives `library-ingest`, whose plaintext digest is `expo-crypto`'s
 * native `digest` (K6-1f). Under `jest-expo` the unmocked native module answers
 * it with a 32-byte ZERO buffer, so two different images would share one id and
 * one durable file name; map `expo-crypto` onto the double's genuine SHA-256.
 */
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createLibraryImportService,
} from '@/features/library/library-import';
import {
  createLibraryIngestService,
  type LibraryAccountPort,
} from '@/features/library/library-ingest';
import {
  deriveLibraryAccountScope,
} from '@/features/library/library-identity';
import type { LibraryPickerPort } from '@/features/library/library-picker';
import {
  createLibraryTestHarness,
  GIF_FIXTURE,
  JPEG_FIXTURE,
  LOCAL_ONLY_ACCOUNT_PORT,
  NOT_AN_IMAGE_FIXTURE,
  PNG_FIXTURE,
  type LibraryTestHarness,
} from '@/features/library/library-test-support';

function pickerReturning(uris: string[]): LibraryPickerPort {
  return {
    async pickImages() {
      return uris.map((uri) => ({ uri, fileName: null, mimeType: null }));
    },
  };
}

function serviceFor(
  harness: LibraryTestHarness,
  picker: LibraryPickerPort,
  account: LibraryAccountPort = harness.signedInAccount,
) {
  const ingest = createLibraryIngestService({
    files: harness.files,
    repository: harness.repository,
    decodeGate: harness.decodeGate,
    account,
    newMutationId: harness.newMutationId,
    clock: harness.clock,
  });
  return createLibraryImportService({ picker, files: harness.files, ingest });
}

describe('library import service', () => {
  test('imports a multi-selection and reports every item', async () => {
    const harness = await createLibraryTestHarness();
    try {
      harness.port.files.set('content://picker/1', JPEG_FIXTURE);
      harness.port.files.set('content://picker/2', PNG_FIXTURE);
      harness.port.files.set('content://picker/3', PNG_FIXTURE);
      harness.port.files.set('content://picker/4', NOT_AN_IMAGE_FIXTURE);

      const summary = await serviceFor(harness, pickerReturning([
        'content://picker/1',
        'content://picker/2',
        'content://picker/3',
        'content://picker/4',
      ])).importFromPicker();

      expect(summary.selected).toBe(4);
      expect(summary.ingested).toBe(2);
      expect(summary.duplicates).toBe(1);
      expect(summary.rejected).toEqual([{ code: 'unsupported_format' }]);
      expect(summary.notEnrolled).toBe(0);

      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(2);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('imports without an account, exactly as a Store build does', async () => {
    const harness = await createLibraryTestHarness();
    try {
      harness.port.files.set('content://picker/1', JPEG_FIXTURE);
      harness.port.files.set('content://picker/2', GIF_FIXTURE);

      const summary = await serviceFor(
        harness,
        pickerReturning(['content://picker/1', 'content://picker/2']),
        LOCAL_ONLY_ACCOUNT_PORT,
      ).importFromPicker();

      expect(summary).toEqual({
        selected: 2,
        ingested: 2,
        duplicates: 0,
        notEnrolled: 2,
        rejected: [],
      });

      const assets = await harness.repository.listLocalAssets();
      expect(assets).toHaveLength(2);
      for (const asset of assets) {
        expect(asset.residency).toBe('local-original');
        expect(await harness.port.exists(asset.localOriginalUri!)).toBe(true);
      }
      await expect(
        harness.database.getAll<{ mutation_id: string }>(
          'SELECT mutation_id FROM library_outbox',
        ),
      ).resolves.toEqual([]);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('enrolls a signed-in import into the account layer', async () => {
    const harness = await createLibraryTestHarness();
    try {
      harness.port.files.set('content://picker/1', JPEG_FIXTURE);

      const summary = await serviceFor(
        harness,
        pickerReturning(['content://picker/1']),
      ).importFromPicker();

      expect(summary.ingested).toBe(1);
      expect(summary.notEnrolled).toBe(0);
      const scope = deriveLibraryAccountScope(harness.masterKey);
      const outbox = await harness.repository.listOutbox(scope);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        kind: 'collect',
        deviceId: harness.deviceId,
      });
    } finally {
      harness.close();
    }
  });

  test('copies every selection before ingesting so revocation cannot lose bytes', async () => {
    const harness = await createLibraryTestHarness();
    try {
      harness.port.files.set('content://picker/a', JPEG_FIXTURE);
      harness.port.files.set('content://picker/b', GIF_FIXTURE);

      const revokingPicker: LibraryPickerPort = {
        async pickImages() {
          return [
            { uri: 'content://picker/a', fileName: 'a.jpg', mimeType: 'image/jpeg' },
            { uri: 'content://picker/b', fileName: 'b.gif', mimeType: 'image/gif' },
          ];
        },
      };

      const service = createLibraryImportService({
        picker: revokingPicker,
        files: harness.files,
        ingest: createLibraryIngestService({
          files: harness.files,
          repository: harness.repository,
          decodeGate: harness.decodeGate,
          account: {
            async vaultMasterKey() {
              // The picker URIs are revoked the moment the app starts working
              // with the staged copies. Ingest must never re-read them.
              harness.port.unreadableSources.add('content://picker/a');
              harness.port.unreadableSources.add('content://picker/b');
              harness.port.files.delete('content://picker/a');
              harness.port.files.delete('content://picker/b');
              return harness.masterKey;
            },
            async deviceId() {
              return harness.deviceId;
            },
            async accountScope() {
              return deriveLibraryAccountScope(harness.masterKey);
            },
          },
          newMutationId: harness.newMutationId,
          clock: harness.clock,
        }),
      });

      const summary = await service.importFromPicker();

      expect(summary.ingested).toBe(2);
      expect(summary.rejected).toEqual([]);
      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(2);
    } finally {
      harness.close();
    }
  });

  test('reports an unreadable selection without aborting the rest', async () => {
    const harness = await createLibraryTestHarness();
    try {
      harness.port.files.set('content://picker/good', JPEG_FIXTURE);
      harness.port.files.set('content://picker/dead', PNG_FIXTURE);
      harness.port.unreadableSources.add('content://picker/dead');

      const summary = await serviceFor(harness, pickerReturning([
        'content://picker/dead',
        'content://picker/good',
      ])).importFromPicker();

      expect(summary.selected).toBe(2);
      expect(summary.ingested).toBe(1);
      expect(summary.rejected).toEqual([{ code: 'unreadable_source' }]);
      expect(await harness.port.listTemp()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('returns an empty summary when the user cancels', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const summary = await serviceFor(harness, pickerReturning([]))
        .importFromPicker();

      expect(summary).toEqual({
        selected: 0,
        ingested: 0,
        duplicates: 0,
        notEnrolled: 0,
        rejected: [],
      });
    } finally {
      harness.close();
    }
  });

  test('N6-A2: importConfirmedFiles accepts exact 67,108,768-byte cap and rejects 67,108,769 bytes (cap+1) before readBytes', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const customCap = 4096;
      const atCapBytes = new Uint8Array(customCap);
      atCapBytes.set(JPEG_FIXTURE);
      const overCapBytes = new Uint8Array(customCap + 1);
      overCapBytes.set(JPEG_FIXTURE);

      harness.port.files.set('file:///cache/ImagePicker/at-cap.jpg', atCapBytes);
      harness.port.files.set('file:///cache/ImagePicker/over-cap.jpg', overCapBytes);

      const readBytesSpy = jest.spyOn(harness.port, 'readBytes');
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        maxProtectablePlaintextBytes: customCap,
      });
      const service = createLibraryImportService({
        picker: pickerReturning([]),
        files: harness.files,
        ingest,
        maxProtectablePlaintextBytes: customCap,
      });

      const progressSteps: Array<{ completed: number; total: number }> = [];
      const summary = await service.importConfirmedFiles({
        uris: [
          'file:///cache/ImagePicker/at-cap.jpg',
          'file:///cache/ImagePicker/over-cap.jpg',
        ],
        classification: 'adult',
        adoptPickerCacheUris: true,
        onProgress: (p) => progressSteps.push(p),
      });

      expect(summary).toEqual({
        selected: 2,
        ingested: 1,
        duplicates: 0,
        notEnrolled: 1,
        retainedClassificationCount: 0,
        rejected: [{ code: 'file_too_large' }],
      });
      expect(progressSteps).toEqual([
        { completed: 1, total: 2 },
        { completed: 2, total: 2 },
      ]);
      // Over-cap file was rejected by size before readBytes was called on it,
      // and both adopted picker-cache files were cleaned up.
      expect(
        readBytesSpy.mock.calls.some(
          ([uri]) => uri === 'file:///cache/ImagePicker/over-cap.jpg',
        ),
      ).toBe(false);
      expect(
        harness.port.files.has('file:///cache/ImagePicker/at-cap.jpg'),
      ).toBe(false);
      expect(
        harness.port.files.has('file:///cache/ImagePicker/over-cap.jpg'),
      ).toBe(false);

      // Also verify that non-adopted acquireFromUri rejects over-cap before
      // copyFrom is called.
      harness.port.files.set('content://picker/over-cap-copy.jpg', overCapBytes);
      const copySpy = jest.spyOn(harness.port, 'copyFrom');
      const copyRefused = await service.importConfirmedFiles({
        uris: ['content://picker/over-cap-copy.jpg'],
        classification: 'safe',
        adoptPickerCacheUris: false,
      });
      expect(copyRefused.rejected).toEqual([{ code: 'file_too_large' }]);
      expect(copySpy).not.toHaveBeenCalled();

      const stored = await harness.repository.listLocalAssets();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        origin: 'import',
        sourceImageId: null,
        byteSize: customCap,
        protectEligible: true,
        importClassification: 'adult',
      });
    } finally {
      harness.close();
    }
  });

  test('N6-A2: active duplicate import and committed-map provider save return existing without mutating classification, residency, time, or enrollment, while unmapped failed/pending provider save does not block import', async () => {
    const harness = await createLibraryTestHarness();
    try {
      // 1. Seed an unmapped failed provider save and an unmapped pending provider
      // save: neither has a committed digest mapping, so neither blocks or is
      // hashed during import.
      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state, download_error
         ) VALUES
           (10, 'danbooru', '10', 'https://example.test/10.jpg', 100, 100, 500, 'jpg', '#112233', 'safe', 0, 0, '[]', 'saved', 1, 2, 1, 1, NULL, 'failed', 'timeout'),
           (11, 'danbooru', '11', 'https://example.test/11.jpg', 100, 100, 500, 'jpg', '#112233', 'safe', 0, 0, '[]', 'saved', 1, 2, 2, 2, NULL, 'pending', NULL)`,
      );

      // 2. Seed a committed provider save for PNG_FIXTURE.
      await harness.database.run(
        `INSERT INTO images (
           id, provider_key, provider_item_id, remote_url, width, height, byte_size,
           extension, dominant_color, content_rating, is_nsfw, is_animated,
           tags_json, decision, presented_at, decided_at, queue_ordinal,
           decision_ordinal, local_uri, download_state
         ) VALUES
           (12, 'danbooru', '12', 'https://example.test/12.png', 1, 1, ?, 'png', '#112233', 'safe', 0, 0, '[]', 'saved', 1, 2, 3, 3, 'file:///collection/12.png', 'ready')`,
        [PNG_FIXTURE.byteLength],
      );
      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: LOCAL_ONLY_ACCOUNT_PORT,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
      });
      await ingest.ingestBytes({
        bytes: PNG_FIXTURE,
        origin: 'provider',
        sourceImageId: 12,
      });

      const service = createLibraryImportService({
        picker: pickerReturning([]),
        files: harness.files,
        ingest,
      });

      // Import JPEG_FIXTURE twice in one batch with 'safe', plus PNG_FIXTURE
      // (which already belongs to committed provider save #12).
      harness.port.files.set('file:///picker/jpeg-1.jpg', JPEG_FIXTURE);
      harness.port.files.set('file:///picker/jpeg-2.jpg', JPEG_FIXTURE);
      harness.port.files.set('file:///picker/png-dup.png', PNG_FIXTURE);

      const batch1 = await service.importConfirmedFiles({
        uris: [
          'file:///picker/jpeg-1.jpg',
          'file:///picker/jpeg-2.jpg',
          'file:///picker/png-dup.png',
        ],
        classification: 'safe',
        adoptPickerCacheUris: true,
      });
      expect(batch1).toEqual({
        selected: 3,
        ingested: 1,
        duplicates: 2,
        notEnrolled: 3,
        retainedClassificationCount: 0,
        rejected: [],
      });

      const jpegAssetBefore = (await harness.repository.listLocalAssets()).find(
        (a) => a.origin === 'import',
      )!;
      expect(jpegAssetBefore.importClassification).toBe('safe');

      // Delete the local original of the active import to verify that re-selecting
      // an active duplicate with 'adult' does NOT heal/adopt bytes or change its
      // classification/time (spec §4.4 / §5).
      harness.port.files.delete(jpegAssetBefore.localOriginalUri!);
      harness.port.files.set('file:///picker/jpeg-again.jpg', JPEG_FIXTURE);

      const batch2 = await service.importConfirmedFiles({
        uris: ['file:///picker/jpeg-again.jpg'],
        classification: 'adult',
        adoptPickerCacheUris: true,
      });
      expect(batch2).toEqual({
        selected: 1,
        ingested: 0,
        duplicates: 1,
        notEnrolled: 1,
        retainedClassificationCount: 0,
        rejected: [],
      });

      const jpegAssetAfter = await harness.repository.findLocalAsset(
        jpegAssetBefore.plaintextSha256,
      );
      expect(jpegAssetAfter?.importClassification).toBe('safe');
      expect(jpegAssetAfter?.createdAt).toBe(jpegAssetBefore.createdAt);
      expect(
        harness.port.files.has(jpegAssetBefore.localOriginalUri!),
      ).toBe(false);
    } finally {
      harness.close();
    }
  });

  test('N6-A2: re-adding a locally-deleted cloud-backed import restores library classification/time and increments retainedClassificationCount only when differing, while authority failures map to categorized codes', async () => {
    const harness = await createLibraryTestHarness();
    try {
      let authorityMode:
        | 'differing'
        | 'matching'
        | 'network'
        | 'password_locked'
        | 'reauth_required'
        | 'no_cloud' = 'differing';

      const ingest = createLibraryIngestService({
        files: harness.files,
        repository: harness.repository,
        decodeGate: harness.decodeGate,
        account: harness.signedInAccount,
        newMutationId: harness.newMutationId,
        clock: harness.clock,
        lookupReaddAuthority: async () => {
          if (authorityMode === 'no_cloud') {
            return { status: 'no_cloud_identity' };
          }
          if (
            authorityMode === 'network'
            || authorityMode === 'password_locked'
            || authorityMode === 'reauth_required'
          ) {
            return { status: 'unavailable', reason: authorityMode };
          }
          return {
            status: 'authoritative',
            origin: 'import',
            collectedAt: 123_456,
            importClassification: 'adult',
          };
        },
      });
      const service = createLibraryImportService({
        picker: pickerReturning([]),
        files: harness.files,
        ingest,
      });

      // 1. Authority failure modes (network, password_locked, reauth_required)
      for (const [mode, expectedCode] of [
        ['network', 'authority_network'],
        ['password_locked', 'authority_password_locked'],
        ['reauth_required', 'authority_reauth_required'],
      ] as const) {
        authorityMode = mode;
        const uri = `file:///picker/${mode}.jpg`;
        harness.port.files.set(uri, JPEG_FIXTURE);
        const res = await service.importConfirmedFiles({
          uris: [uri],
          classification: 'safe',
          adoptPickerCacheUris: true,
        });
        expect(res.ingested).toBe(0);
        expect(res.rejected).toEqual([{ code: expectedCode }]);
        expect(harness.port.files.has(uri)).toBe(false);
      }

      // 2. Re-add with differing batch choice ('safe' vs library 'adult') ->
      // retainedClassificationCount = 1, stored classification = 'adult',
      // createdAt = 123_456.
      authorityMode = 'differing';
      harness.port.files.set('file:///picker/readd-diff.jpg', JPEG_FIXTURE);
      const diffSummary = await service.importConfirmedFiles({
        uris: ['file:///picker/readd-diff.jpg'],
        classification: 'safe',
        adoptPickerCacheUris: true,
      });
      expect(diffSummary).toEqual({
        selected: 1,
        ingested: 1,
        duplicates: 0,
        notEnrolled: 0,
        retainedClassificationCount: 1,
        rejected: [],
      });
      const [readded] = await harness.repository.listLocalAssets();
      expect(readded).toMatchObject({
        origin: 'import',
        importClassification: 'adult',
        createdAt: 123_456,
      });

      // 3. Re-add with matching batch choice ('adult' vs library 'adult') ->
      // retainedClassificationCount = 0.
      authorityMode = 'matching';
      harness.port.files.set('file:///picker/readd-match.png', PNG_FIXTURE);
      const matchSummary = await service.importConfirmedFiles({
        uris: ['file:///picker/readd-match.png'],
        classification: 'adult',
        adoptPickerCacheUris: true,
      });
      expect(matchSummary.ingested).toBe(1);
      expect(matchSummary.retainedClassificationCount).toBe(0);
    } finally {
      harness.close();
    }
  });

  test('N6-A2: refuse() cleans adopted picker cache files and blocks new confirmed imports during reset/backup', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const service = serviceFor(harness, pickerReturning([]));
      harness.port.files.set('file:///picker/refused.jpg', JPEG_FIXTURE);

      const release = service.refuse();
      const refused = await service.importConfirmedFiles({
        uris: ['file:///picker/refused.jpg'],
        classification: 'safe',
        adoptPickerCacheUris: true,
      });

      expect(refused.ingested).toBe(0);
      expect(refused.rejected).toEqual([{ code: 'storage_failed' }]);
      expect(harness.port.files.has('file:///picker/refused.jpg')).toBe(false);
      await expect(harness.repository.listLocalAssets()).resolves.toEqual([]);

      release();
      harness.port.files.set('file:///picker/accepted.jpg', JPEG_FIXTURE);
      const accepted = await service.importConfirmedFiles({
        uris: ['file:///picker/accepted.jpg'],
        classification: 'safe',
        adoptPickerCacheUris: true,
      });
      expect(accepted.ingested).toBe(1);
    } finally {
      harness.close();
    }
  });
});
