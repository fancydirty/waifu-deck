jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  buildVaultMeta, parseVaultMeta, openVaultWithPassword, VaultMetaError, APPEND_PROTOCOL_VERSION,
} from './byos-vault-meta';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

beforeEach(() => {
  resetExpoCryptoDouble();
});

describe('byos vault-meta', () => {
  it('builds meta whose keyCheck verifies with the same password', async () => {
    const { meta, masterKey } = await buildVaultMeta('pw', 'aes-gcm');
    expect(meta.format).toBe('waifu-deck-byos');
    expect(meta.protocolVersion).toBe(1);
    expect(meta.encryption).toBe('aes-gcm');
    const opened = await openVaultWithPassword(meta, 'pw');
    expect(Buffer.from(opened!).equals(Buffer.from(masterKey!))).toBe(true);
  });

  it('rejects a wrong password with a wrong-password error', async () => {
    const { meta } = await buildVaultMeta('pw', 'aes-gcm');
    await expect(openVaultWithPassword(meta, 'nope')).rejects.toMatchObject({
      code: 'wrong-password',
    });
  });

  it('round-trips through parseVaultMeta and rejects malformed json', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      vaultId: '00000000-0000-4000-8000-000000000001',
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA' },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(parseVaultMeta(json).protocolVersion).toBe(1);
    expect(parseVaultMeta(json).vaultId).toBe('00000000-0000-4000-8000-000000000001');
    expect(() => parseVaultMeta('{')).toThrow(VaultMetaError);
    expect(() => parseVaultMeta('{"format":"nope"}')).toThrow(VaultMetaError);
  });

  it('rejects a higher protocolVersion fail-safe', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 999, encryption: 'none',
      vaultId: '00000000-0000-4000-8000-000000000001',
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA' },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
  });

  it('rejects meta missing a vaultId', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA' },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
    expect(() => parseVaultMeta(json)).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
  });

  it('rejects meta with an empty-string vaultId', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      vaultId: '',
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA' },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
  });

  it('rejects meta with a non-string vaultId', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      vaultId: 12345,
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA' },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
  });

  it('encryption:none needs no password', async () => {
    const { meta, masterKey } = await buildVaultMeta(null, 'none');
    expect(meta.encryption).toBe('none');
    expect(masterKey).toBeNull();
  });

  it('rejects out-of-range scrypt params (N too large)', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      vaultId: '00000000-0000-4000-8000-000000000001',
      kdf: {
        algo: 'scrypt', N: 2 ** 30, r: 8, p: 1, saltB64: 'AAAA',
      },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
  });

  it('rejects out-of-range scrypt params (r too small)', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      vaultId: '00000000-0000-4000-8000-000000000001',
      kdf: {
        algo: 'scrypt', N: 16384, r: 0, p: 1, saltB64: 'AAAA',
      },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
  });

  it('accepts a valid meta using the default scrypt params', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'none',
      vaultId: '00000000-0000-4000-8000-000000000001',
      kdf: {
        algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA',
      },
      keyCheckB64: '', createdAt: '2026-08-28T00:00:00.000Z',
    });
    expect(parseVaultMeta(json).kdf.N).toBe(16384);
  });

  it('gives each buildVaultMeta call its own vaultId', async () => {
    const first = await buildVaultMeta('pw', 'aes-gcm');
    const second = await buildVaultMeta('pw', 'aes-gcm');
    expect(first.meta.vaultId).toEqual(expect.any(String));
    expect(first.meta.vaultId.length).toBeGreaterThan(0);
    expect(second.meta.vaultId).not.toBe(first.meta.vaultId);
  });

  it('preserves vaultId through a build -> stringify -> parse round trip', async () => {
    const { meta } = await buildVaultMeta(null, 'none');
    const parsed = parseVaultMeta(JSON.stringify(meta));
    expect(parsed.vaultId).toBe(meta.vaultId);
  });

  it('buildVaultMeta stamps the requested protocolVersion (2 for append-only stores) and defaults to 1', async () => {
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, APPEND_PROTOCOL_VERSION);
    expect(meta.protocolVersion).toBe(2);
    expect((await buildVaultMeta('pw', 'aes-gcm')).meta.protocolVersion).toBe(1);
  });

  it('parseVaultMeta accepts protocolVersion 2 only when the caller allows it', () => {
    const json = JSON.stringify({
      format: 'waifu-deck-byos', protocolVersion: 2, encryption: 'aes-gcm', vaultId: 'v',
      kdf: {
        algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA==',
      },
      keyCheckB64: 'a2V5', createdAt: 'x',
    });
    expect(() => parseVaultMeta(json)).toThrow(VaultMetaError);
    expect(parseVaultMeta(json, APPEND_PROTOCOL_VERSION).protocolVersion).toBe(2);
  });
});
