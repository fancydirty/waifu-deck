jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import { createLibraryObjectCipher } from '@/features/library/library-object-crypto';
import { createPassthroughLibraryCipher } from '@/features/library/library-passthrough-cipher';
import {
  buildLibraryEncryptedMetadata,
  resolveEnvelopeImportClassification,
} from '@/features/library/library-source-metadata';
import { encodeBase64Url } from '@/features/vault/base64url';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const ASSET = 'a'.repeat(64);
// Deliberately not a 32-byte real key and not a valid hex asset id — the
// passthrough cipher must ignore both, unlike the real cipher which would
// reject them.
const junkMasterKey = Uint8Array.from([1, 2, 3]);
const junkAssetId = 'not-a-real-asset-id';

const metadata: LibraryEncryptedMetadata = {
  version: 1,
  plaintextSha256: ASSET,
  format: 'jpeg',
  canonicalExtension: 'jpg',
  byteSize: 8,
  width: 10,
  height: 20,
  origin: 'import',
  sourceImageId: null,
  collectedAt: 1_700_000_000,
  tags: ['a', 'b'],
};

describe('passthrough library cipher (encryption: none)', () => {
  beforeEach(() => {
    resetExpoCryptoDouble();
  });

  it('seal/open round-trip object bytes as an identity function', async () => {
    const cipher = createPassthroughLibraryCipher();
    const plaintext = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1]);

    const envelope = await cipher.seal({
      masterKey: junkMasterKey,
      assetId: junkAssetId,
      scope: 'original',
      plaintext,
    });
    expect([...envelope]).toEqual([...plaintext]);

    const opened = await cipher.open({
      masterKey: junkMasterKey,
      assetId: junkAssetId,
      scope: 'original',
      envelope,
    });
    expect([...opened]).toEqual([...plaintext]);
  });

  it('sealMetadata/openMetadata round-trip preserving every field', async () => {
    const cipher = createPassthroughLibraryCipher();

    const sealed = await cipher.sealMetadata({
      masterKey: junkMasterKey,
      assetId: junkAssetId,
      metadata,
    });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/u);

    const opened = await cipher.openMetadata({
      masterKey: junkMasterKey,
      assetId: junkAssetId,
      sealed,
    });
    expect(opened).toEqual(metadata);
  });

  it('rejects a malformed base64url metadata string', async () => {
    const cipher = createPassthroughLibraryCipher();

    await expect(
      cipher.openMetadata({
        masterKey: junkMasterKey,
        assetId: junkAssetId,
        sealed: 'not valid base64url!!',
      }),
    ).rejects.toThrow('Invalid base64url value.');
  });

  it('rejects well-formed base64url that does not decode to JSON', async () => {
    const cipher = createPassthroughLibraryCipher();
    const notJson = encodeBase64Url(new TextEncoder().encode('this is not json'));

    await expect(
      cipher.openMetadata({
        masterKey: junkMasterKey,
        assetId: junkAssetId,
        sealed: notJson,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('cannot be opened by the real cipher — foreign envelope is rejected', async () => {
    const passthrough = createPassthroughLibraryCipher();
    const real = createLibraryObjectCipher();
    const realMasterKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

    const sealedByPassthrough = await passthrough.sealMetadata({
      masterKey: junkMasterKey,
      assetId: junkAssetId,
      metadata,
    });

    await expect(
      real.openMetadata({
        masterKey: realMasterKey,
        assetId: ASSET,
        sealed: sealedByPassthrough,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('cannot open the real cipher\'s output — encrypted envelope is not JSON', async () => {
    const passthrough = createPassthroughLibraryCipher();
    const real = createLibraryObjectCipher();
    const realMasterKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

    const sealedByReal = await real.sealMetadata({
      masterKey: realMasterKey,
      assetId: ASSET,
      metadata,
    });

    await expect(
      passthrough.openMetadata({
        masterKey: junkMasterKey,
        assetId: junkAssetId,
        sealed: sealedByReal,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it.each(['safe', 'adult', 'unknown'] as const)(
    'round-trips v3 metadata with importClassification=%s in encryption-off mode',
    async (importClassification) => {
      const cipher = createPassthroughLibraryCipher();
      const v3 = buildLibraryEncryptedMetadata(
        {
          plaintextSha256: ASSET,
          format: 'jpeg',
          canonicalExtension: 'jpg',
          byteSize: 8,
          width: 10,
          height: 20,
          origin: 'import',
          sourceImageId: null,
          collectedAt: 1_700_000_000,
          importClassification,
        },
        null,
      );

      const sealed = await cipher.sealMetadata({
        masterKey: junkMasterKey,
        assetId: junkAssetId,
        metadata: v3,
      });
      const opened = await cipher.openMetadata({
        masterKey: junkMasterKey,
        assetId: junkAssetId,
        sealed,
      });

      expect(opened).toEqual(v3);
      expect(opened.version).toBe(3);
      expect(resolveEnvelopeImportClassification(opened)).toBe(importClassification);
    },
  );
});
