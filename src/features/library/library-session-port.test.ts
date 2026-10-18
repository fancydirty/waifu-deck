import { sha256 } from '@noble/hashes/sha2.js';

import { createByosLibrarySessionPort } from './library-session-port';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';

const encoder = new TextEncoder();

function fixtureMeta(vaultId: string): VaultMeta {
  return {
    format: 'waifu-deck-byos',
    protocolVersion: 1,
    encryption: 'aes-gcm',
    vaultId,
    kdf: {
      algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'AAAA',
    },
    keyCheckB64: '',
    createdAt: '2026-08-28T00:00:00.000Z',
  };
}

const VAULT_ID_A = '00000000-0000-4000-8000-000000000001';
const VAULT_ID_B = '00000000-0000-4000-8000-000000000002';

describe('createByosLibrarySessionPort', () => {
  it('aes-gcm vault yields a complete session context', async () => {
    const masterKey = new Uint8Array(32).fill(7);
    const port = createByosLibrarySessionPort({
      vault: { meta: fixtureMeta(VAULT_ID_A), masterKey, deviceId: 'device-1' },
    });
    const context = await port.current();
    expect(context).not.toBeNull();
    expect(context!.deviceId).toBe('device-1');
    expect(Buffer.from(context!.masterKey).equals(Buffer.from(masterKey))).toBe(true);
    expect(context!.accountScope).toMatch(/^[0-9a-f]{32}$/);
  });

  it('encryption:none vault still yields a valid session with a vaultId-derived pseudo masterKey', async () => {
    const meta = { ...fixtureMeta(VAULT_ID_A), encryption: 'none' as const };
    const port = createByosLibrarySessionPort({
      vault: { meta, masterKey: null, deviceId: 'device-1' },
    });
    const context = await port.current();
    expect(context).not.toBeNull();
    expect(context!.masterKey.byteLength).toBe(32);
    expect(Buffer.from(context!.masterKey).equals(
      Buffer.from(sha256(encoder.encode(VAULT_ID_A))),
    )).toBe(true);
    expect(context!.accountScope).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accountScope and pseudo masterKey are deterministic across instances and differ across vaultIds', async () => {
    const noneMeta = (vaultId: string) => (
      { ...fixtureMeta(vaultId), encryption: 'none' as const }
    );
    const portOne = createByosLibrarySessionPort({
      vault: { meta: noneMeta(VAULT_ID_A), masterKey: null, deviceId: 'device-1' },
    });
    const portTwo = createByosLibrarySessionPort({
      vault: { meta: noneMeta(VAULT_ID_A), masterKey: null, deviceId: 'device-2' },
    });
    const portDifferentVault = createByosLibrarySessionPort({
      vault: { meta: noneMeta(VAULT_ID_B), masterKey: null, deviceId: 'device-1' },
    });

    const contextOne = (await portOne.current())!;
    const contextTwo = (await portTwo.current())!;
    const contextDifferentVault = (await portDifferentVault.current())!;

    expect(contextTwo.accountScope).toBe(contextOne.accountScope);
    expect(Buffer.from(contextTwo.masterKey).equals(Buffer.from(contextOne.masterKey))).toBe(true);

    expect(contextDifferentVault.accountScope).not.toBe(contextOne.accountScope);
    expect(Buffer.from(contextDifferentVault.masterKey).equals(
      Buffer.from(contextOne.masterKey),
    )).toBe(false);
  });
});
