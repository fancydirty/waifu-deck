import { hexToBytes } from '@noble/hashes/utils.js';

import { encodeBase64 } from './base64';
import { computeKeyCheck, DEFAULT_SCRYPT_PARAMS, deriveVaultKey } from './byos-keys';
import { createStoreVaultOrAdopt, createVaultOrAdopt } from './byos-vault-init';
import { APPEND_PROTOCOL_VERSION, buildVaultMeta, parseVaultMeta, type VaultMeta } from './byos-vault-meta';
import { S3TransportError } from './s3-transport-types';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import type { CloudObjectStore } from '@/features/cloud-store/cloud-object-store';

type Obj = { body: Uint8Array; etag: string };

function fakeTransport(initial: Record<string, Obj> = {}) {
  const store: Record<string, Obj> = { ...initial };
  let seq = 0;
  return {
    store,
    async getObject(key: string) {
      const o = store[key];
      return o ? { body: o.body, etag: o.etag } : null;
    },
    async putObject(key: string, body: Uint8Array, options?: {
      ifNoneMatch?: string;
    }) {
      if (options?.ifNoneMatch === '*' && store[key]) {
        throw new S3TransportError(412, 'precondition', 'precondition failed', true);
      }
      const etag = `etag-${seq++}`;
      store[key] = { body, etag };
      return { etag };
    },
  };
}

const enc = new TextEncoder();

function loggingTransport(initial: Record<string, Obj> = {}) {
  const inner = fakeTransport(initial);
  const calls: string[] = [];
  return {
    calls,
    store: inner.store,
    async getObject(key: string) { calls.push(`GET ${key}`); return inner.getObject(key); },
    async putObject(key: string, body: Uint8Array, options?: { ifNoneMatch?: string }) {
      calls.push(`PUT ${key} ${options?.ifNoneMatch ?? ''}`.trim());
      return inner.putObject(key, body, options);
    },
  };
}

describe('createVaultOrAdopt', () => {
  it('creates a new vault with one conditional PUT and no read before it', async () => {
    const t = loggingTransport();
    const { meta, masterKey } = await createVaultOrAdopt(t as never, 'p/', 'pw', 'aes-gcm');
    expect(meta.format).toBe('waifu-deck-byos');
    expect(masterKey).toHaveLength(32);
    expect(t.store['p/vault-meta.json']).toBeDefined();
    expect(t.calls).toEqual(['PUT p/vault-meta.json *']);
  });

  it('adopts the vault another device created first: PUT refused, one GET, same identity and key', async () => {
    const built = await buildVaultMeta('pw', 'aes-gcm');
    const t = loggingTransport({
      'p/vault-meta.json': { body: enc.encode(JSON.stringify(built.meta)), etag: 'e0' },
    });
    const { meta, masterKey } = await createVaultOrAdopt(t as never, 'p/', 'pw', 'aes-gcm');
    expect(meta.vaultId).toBe(built.meta.vaultId);
    expect(Buffer.from(masterKey!).equals(Buffer.from(built.masterKey!))).toBe(true);
    expect(t.calls).toEqual(['PUT p/vault-meta.json *', 'GET p/vault-meta.json']);
  });

  it('refuses a wrong password on adopt with the wrong-password code', async () => {
    const built = await buildVaultMeta('pw', 'aes-gcm');
    const t = loggingTransport({
      'p/vault-meta.json': { body: enc.encode(JSON.stringify(built.meta)), etag: 'e0' },
    });
    await expect(createVaultOrAdopt(t as never, 'p/', 'nope', 'aes-gcm'))
      .rejects.toMatchObject({ name: 'VaultMetaError', code: 'wrong-password' });
  });

  it('requires a password for an encrypted vault before touching the bucket', async () => {
    const t = loggingTransport();
    await expect(createVaultOrAdopt(t as never, 'p/', null, 'aes-gcm'))
      .rejects.toMatchObject({ name: 'VaultMetaError' });
    expect(t.calls).toEqual([]);
  });
});

describe('createStoreVaultOrAdopt (P12-B, spec §3.4 + §6)', () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const readMeta = (store: ReturnType<typeof createMemoryCloudObjectStore>) =>
    parseVaultMeta(dec.decode(store.objects().get('vault-meta.json')!), APPEND_PROTOCOL_VERSION);

  it('creates an aes-gcm protocolVersion-2 vault in an empty store (read, write, read back) and returns the derived key', async () => {
    const store = createMemoryCloudObjectStore();
    const { meta, masterKey } = await createStoreVaultOrAdopt(store, 'pw');
    expect(meta.encryption).toBe('aes-gcm');
    expect(meta.protocolVersion).toBe(APPEND_PROTOCOL_VERSION);
    expect(masterKey).toHaveLength(32);
    expect(store.calls.map((c) => c.op)).toEqual(['get', 'put', 'get']);
    expect(store.calls[1]).toMatchObject({ op: 'put', path: 'vault-meta.json', contentType: 'application/json' });
    expect(readMeta(store).vaultId).toBe(meta.vaultId);
  });

  /**
   * A vault-meta another device could have written: its OWN salt (the
   * expo-crypto automock hands every `buildVaultMeta` the same all-zero salt,
   * so a hand-built one is the only way to make "re-derived from the winner's
   * salt" observable) and a keyCheck that opens with `password`.
   */
  async function foreignVault(vaultId: string, password: string, saltByte: number): Promise<{ meta: VaultMeta; masterKey: Uint8Array }> {
    const salt = new Uint8Array(16).fill(saltByte);
    const masterKey = await deriveVaultKey(password, salt, DEFAULT_SCRYPT_PARAMS);
    return {
      masterKey,
      meta: {
        format: 'waifu-deck-byos',
        protocolVersion: APPEND_PROTOCOL_VERSION,
        encryption: 'aes-gcm',
        vaultId,
        kdf: { algo: 'scrypt', ...DEFAULT_SCRYPT_PARAMS, saltB64: encodeBase64(salt) },
        keyCheckB64: encodeBase64(hexToBytes(computeKeyCheck(masterKey))),
        createdAt: '2026-09-19T00:00:00.000Z',
      },
    };
  }

  it('adopts an existing vault when the password opens it, without writing', async () => {
    const store = createMemoryCloudObjectStore();
    const first = await createStoreVaultOrAdopt(store, 'pw');
    const before = store.calls.length;
    const second = await createStoreVaultOrAdopt(store, 'pw');
    expect(second.meta.vaultId).toBe(first.meta.vaultId);
    expect(Array.from(second.masterKey)).toEqual(Array.from(first.masterKey));
    expect(store.calls.slice(before).map((c) => c.op)).toEqual(['get']);
  });

  it('rejects a wrong password on an existing vault with VaultMetaError wrong-password', async () => {
    const store = createMemoryCloudObjectStore();
    await createStoreVaultOrAdopt(store, 'pw');
    await expect(createStoreVaultOrAdopt(store, 'nope')).rejects.toMatchObject({ name: 'VaultMetaError', code: 'wrong-password' });
  });

  /** A store whose `put` lets `theirs` land right after ours: same name, later write wins. */
  function racingStore(store: ReturnType<typeof createMemoryCloudObjectStore>, theirs: unknown): CloudObjectStore {
    let intercepted = false;
    return {
      ...store,
      async put(path, body, ct) {
        await store.put(path, body, ct);
        if (!intercepted) { intercepted = true; await store.put('vault-meta.json', enc.encode(JSON.stringify(theirs)), 'application/json'); }
      },
    };
  }

  it('when another device wrote between our read and our write, the read-back body wins and our key is re-derived from ITS salt', async () => {
    const store = createMemoryCloudObjectStore();
    const mine = await buildVaultMeta('pw', 'aes-gcm', undefined, APPEND_PROTOCOL_VERSION);
    const theirs = await foreignVault('other-device-vault', 'pw', 7);
    const { meta, masterKey } = await createStoreVaultOrAdopt(racingStore(store, theirs.meta), 'pw');
    expect(meta.vaultId).toBe('other-device-vault');
    expect(Array.from(masterKey)).toEqual(Array.from(theirs.masterKey));
    expect(Array.from(masterKey)).not.toEqual(Array.from(mine.masterKey!));
    expect(readMeta(store).vaultId).toBe('other-device-vault');
  });

  it('a read-back written by a device with a DIFFERENT password is wrong-password (the join prompt), never a silent key mismatch', async () => {
    const store = createMemoryCloudObjectStore();
    const theirs = await foreignVault('other-device-vault', 'their-password', 9);
    await expect(createStoreVaultOrAdopt(racingStore(store, theirs.meta), 'pw'))
      .rejects.toMatchObject({ name: 'VaultMetaError', code: 'wrong-password' });
  });

  it('a garbage read-back body is malformed, never our own built meta', async () => {
    const store = createMemoryCloudObjectStore();
    const garbage: CloudObjectStore = { ...store, async get() { return (store.calls.some((c) => c.op === 'put')) ? enc.encode('{ not json') : null; } };
    await expect(createStoreVaultOrAdopt(garbage, 'pw')).rejects.toMatchObject({ name: 'VaultMetaError', code: 'malformed' });
  });

  it('a protocolVersion-1 (S3 CAS layout) vault-meta inside a store folder is refused as malformed, not adopted', async () => {
    const store = createMemoryCloudObjectStore();
    const v1 = await buildVaultMeta('pw', 'aes-gcm');
    await store.put('vault-meta.json', enc.encode(JSON.stringify(v1.meta)), 'application/json');
    await expect(createStoreVaultOrAdopt(store, 'pw')).rejects.toMatchObject({ name: 'VaultMetaError', code: 'malformed' });
  });

  it('refuses to adopt an unencrypted vault on a store backend (spec §6) as malformed, and never writes over it', async () => {
    const store = createMemoryCloudObjectStore();
    const plain = await buildVaultMeta(null, 'none', undefined, APPEND_PROTOCOL_VERSION);
    await store.put('vault-meta.json', enc.encode(JSON.stringify(plain.meta)), 'application/json');
    await expect(createStoreVaultOrAdopt(store, 'pw')).rejects.toMatchObject({ name: 'VaultMetaError', code: 'malformed' });
    expect(store.calls.filter((c) => c.op === 'put')).toHaveLength(1);
  });

  it('refuses a protocolVersion above 2 as unsupported-version', async () => {
    const store = createMemoryCloudObjectStore();
    const future = { ...(await buildVaultMeta('pw', 'aes-gcm', undefined, APPEND_PROTOCOL_VERSION)).meta, protocolVersion: 3 };
    await store.put('vault-meta.json', enc.encode(JSON.stringify(future)), 'application/json');
    await expect(createStoreVaultOrAdopt(store, 'pw')).rejects.toMatchObject({ name: 'VaultMetaError', code: 'unsupported-version' });
  });

  it('a vault-meta that vanishes right after the write is malformed (never silently creates a keyless session)', async () => {
    const store = createMemoryCloudObjectStore();
    const vanishing: CloudObjectStore = { ...store, async get() { return null; } };
    await expect(createStoreVaultOrAdopt(vanishing, 'pw')).rejects.toMatchObject({ name: 'VaultMetaError', code: 'malformed' });
  });
});
