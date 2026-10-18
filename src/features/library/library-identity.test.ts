import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  deriveLibraryAccountScope,
  deriveLibraryAssetId,
  LIBRARY_ASSET_ID_PATTERN,
  sha256PlaintextHex,
} from '@/features/library/library-identity';

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const plaintext = Uint8Array.from([1, 2, 3, 4, 5]);

describe('library asset identity', () => {
  test('computes a lowercase hex plaintext digest', () => {
    const digest = sha256PlaintextHex(plaintext);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe(
      Array.from(sha256(plaintext), (byte) =>
        byte.toString(16).padStart(2, '0')).join(''),
    );
  });

  test('derives the keyed asset id as HMAC-SHA256 over the raw digest bytes', () => {
    const digest = sha256PlaintextHex(plaintext);
    const assetId = deriveLibraryAssetId(key(7), digest);

    expect(assetId).toMatch(LIBRARY_ASSET_ID_PATTERN);
    expect(assetId).toBe(
      Array.from(hmac(sha256, key(7), sha256(plaintext)), (byte) =>
        byte.toString(16).padStart(2, '0')).join(''),
    );
  });

  test('is idempotent inside one account', () => {
    const digest = sha256PlaintextHex(plaintext);
    expect(deriveLibraryAssetId(key(7), digest))
      .toBe(deriveLibraryAssetId(key(7), digest));
  });

  test('cannot be correlated across accounts', () => {
    const digest = sha256PlaintextHex(plaintext);
    expect(deriveLibraryAssetId(key(7), digest))
      .not.toBe(deriveLibraryAssetId(key(8), digest));
    expect(deriveLibraryAccountScope(key(7)))
      .not.toBe(deriveLibraryAccountScope(key(8)));
  });

  test('derives a stable 32-hex local account scope', () => {
    const scope = deriveLibraryAccountScope(key(7));
    expect(scope).toMatch(/^[0-9a-f]{32}$/u);
    expect(scope).toBe(deriveLibraryAccountScope(key(7)));
  });

  test('rejects a master key that is not 32 bytes and a malformed digest', () => {
    expect(() => deriveLibraryAssetId(new Uint8Array(16), 'a'.repeat(64)))
      .toThrow('Invalid Vault master key length.');
    expect(() => deriveLibraryAccountScope(new Uint8Array(31)))
      .toThrow('Invalid Vault master key length.');
    expect(() => deriveLibraryAssetId(key(7), 'zz'))
      .toThrow('Invalid plaintext digest.');
    expect(() => deriveLibraryAssetId(key(7), 'A'.repeat(64)))
      .toThrow('Invalid plaintext digest.');
  });
});
