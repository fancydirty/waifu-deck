jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import { sha256 } from '@noble/hashes/sha2.js';

import {
  createLibraryObjectCipher,
  LIBRARY_OBJECT_ENVELOPE_MAGIC,
  type LibraryObjectCipher,
} from '@/features/library/library-object-crypto';
import { LIBRARY_OBJECT_ENVELOPE_OVERHEAD_BYTES } from '@/features/library/library-limits';
import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import { decodeBase64Url } from '@/features/vault/base64url';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const ASSET = 'a'.repeat(64);
const OTHER_ASSET = 'b'.repeat(64);
const masterKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const otherKey = new Uint8Array(32).fill(9);
const plaintext = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

let cipher: LibraryObjectCipher;

beforeEach(() => {
  resetExpoCryptoDouble();
  cipher = createLibraryObjectCipher();
});

describe('library object crypto', () => {
  it('round-trips an original with the documented envelope shape', async () => {
    const envelope = await cipher.seal({
      masterKey,
      assetId: ASSET,
      scope: 'original',
      plaintext,
    });
    expect(envelope.byteLength).toBe(
      plaintext.byteLength + LIBRARY_OBJECT_ENVELOPE_OVERHEAD_BYTES,
    );
    expect(
      new TextDecoder().decode(envelope.slice(0, 8)),
    ).toBe(LIBRARY_OBJECT_ENVELOPE_MAGIC);
    const opened = await cipher.open({
      masterKey,
      assetId: ASSET,
      scope: 'original',
      envelope,
    });
    expect([...opened]).toEqual([...plaintext]);
  });

  it('binds the envelope to the account key, the asset, and the role', async () => {
    const envelope = await cipher.seal({
      masterKey,
      assetId: ASSET,
      scope: 'original',
      plaintext,
    });
    await expect(
      cipher.open({ masterKey: otherKey, assetId: ASSET, scope: 'original', envelope }),
    ).rejects.toThrow();
    await expect(
      cipher.open({ masterKey, assetId: OTHER_ASSET, scope: 'original', envelope }),
    ).rejects.toThrow();
    await expect(
      cipher.open({ masterKey, assetId: ASSET, scope: 'preview', envelope }),
    ).rejects.toThrow();
  });

  it('rejects a truncated, tampered, or foreign envelope', async () => {
    const envelope = await cipher.seal({
      masterKey,
      assetId: ASSET,
      scope: 'original',
      plaintext,
    });
    await expect(
      cipher.open({
        masterKey,
        assetId: ASSET,
        scope: 'original',
        envelope: envelope.slice(0, envelope.byteLength - 1),
      }),
    ).rejects.toThrow();

    const tampered = Uint8Array.from(envelope);
    tampered[tampered.byteLength - 20] ^= 0xff;
    await expect(
      cipher.open({ masterKey, assetId: ASSET, scope: 'original', envelope: tampered }),
    ).rejects.toThrow();

    const foreign = Uint8Array.from(envelope);
    foreign[0] = 0x00;
    await expect(
      cipher.open({ masterKey, assetId: ASSET, scope: 'original', envelope: foreign }),
    ).rejects.toThrow('Unsupported library object envelope.');
  });

  it('uses a fresh data key per object so equal plaintext differs', async () => {
    const first = await cipher.seal({
      masterKey, assetId: ASSET, scope: 'original', plaintext,
    });
    const second = await cipher.seal({
      masterKey, assetId: ASSET, scope: 'original', plaintext,
    });
    expect([...first]).not.toEqual([...second]);
    expect([
      ...(await cipher.open({ masterKey, assetId: ASSET, scope: 'original', envelope: second })),
    ]).toEqual([...plaintext]);
  });

  it('refuses plaintext that cannot fit the protocol envelope limit', async () => {
    await expect(
      cipher.seal({
        masterKey,
        assetId: ASSET,
        scope: 'original',
        plaintext: new Uint8Array(0),
      }),
    ).rejects.toThrow('Library object plaintext is empty.');
  });

  it('seals account metadata as url-safe base64 the Worker accepts', async () => {
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
      tags: [],
    };
    const sealed = await cipher.sealMetadata({ masterKey, assetId: ASSET, metadata });
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/u);
    const opened = await cipher.openMetadata({
      masterKey,
      assetId: ASSET,
      sealed,
    });
    expect(opened).toEqual(metadata);
    expect(decodeBase64Url(sealed).byteLength).toBeLessThan(8 * 1024);
  });

  it('lets a caller prove decrypt-and-hash identity against the plaintext digest', async () => {
    const envelope = await cipher.seal({
      masterKey, assetId: ASSET, scope: 'original', plaintext,
    });
    const opened = await cipher.open({
      masterKey, assetId: ASSET, scope: 'original', envelope,
    });
    const digest = Array.from(sha256(opened), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe(
      Array.from(sha256(plaintext), (byte) =>
        byte.toString(16).padStart(2, '0')).join(''),
    );
  });
});
