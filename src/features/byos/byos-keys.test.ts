import { deriveVaultKey, computeKeyCheck, DEFAULT_SCRYPT_PARAMS } from './byos-keys';

describe('byos key derivation', () => {
  const salt = new Uint8Array(16).fill(7);

  it('derives a stable 32-byte key from a password + salt', async () => {
    const a = await deriveVaultKey('hunter2', salt, DEFAULT_SCRYPT_PARAMS);
    const b = await deriveVaultKey('hunter2', salt, DEFAULT_SCRYPT_PARAMS);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('produces different keys for different passwords', async () => {
    const a = await deriveVaultKey('hunter2', salt, DEFAULT_SCRYPT_PARAMS);
    const c = await deriveVaultKey('other', salt, DEFAULT_SCRYPT_PARAMS);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  it('keyCheck matches for the same key and differs for another', async () => {
    const a = await deriveVaultKey('hunter2', salt, DEFAULT_SCRYPT_PARAMS);
    const c = await deriveVaultKey('other', salt, DEFAULT_SCRYPT_PARAMS);
    const checkA = computeKeyCheck(a);
    expect(computeKeyCheck(a)).toBe(checkA);
    expect(computeKeyCheck(c)).not.toBe(checkA);
  });
});
