import { createLibraryStorageModeStore, LIBRARY_STORAGE_MODE_KEY } from '@/features/library/library-storage-mode';
import type { KeyValueStorage } from '@/features/settings/settings-repository';

const mockKv = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockKv.get(key) ?? null,
    setItem: async (key: string, value: string) => { mockKv.set(key, value); },
    removeItem: async (key: string) => { mockKv.delete(key); },
  },
}));
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));
jest.mock('@/features/cloud-store/onedrive-store-production', () => ({ createProductionOneDriveStore: jest.fn() }));
jest.mock('@/features/cloud-store/gdrive-store-production', () => ({ createProductionGoogleDriveStore: jest.fn() }));

import {
  connectGdrive, connectOneDrive, connectToBucket, connectWebdav, disconnectDevice, probeBucket, probeGdrive, probeOneDrive, probeWebdav,
  reauthGdrive, reauthOneDrive, signInWithGoogle, signInWithMicrosoft,
  type ByosConnectFields, type ByosTransportPort, type ConnectableProbe, type GdriveSource, type OneDriveSource, type WebdavConnectFields,
} from './byos-connect-flow';
import {
  createByosCredentialStore, type ByosCredentials, type GoogleDriveBinding, type OneDriveBinding,
  type SecureStorePort, type WebdavBinding,
} from './byos-credentials';
import { createByosSessionCache, BYOS_SESSION_CACHE_KEY } from './byos-session-cache';
import {
  buildVaultMeta, openVaultWithPassword, parseVaultMeta,
} from './byos-vault-meta';
import { S3TransportError, type S3FailureCategory } from './s3-transport-types';
import { CloudStoreError, type CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { createGoogleDriveCloudObjectStore } from '@/features/cloud-store/gdrive-cloud-object-store';
import { bootstrapGoogleDriveLayout } from '@/features/cloud-store/gdrive-layout';
import { createProductionGoogleDriveStore } from '@/features/cloud-store/gdrive-store-production';
import { createGoogleTokenSource } from '@/features/cloud-store/google-token-source';
import { bootstrapOneDriveLayout } from '@/features/cloud-store/onedrive-layout';
import { createProductionOneDriveStore } from '@/features/cloud-store/onedrive-store-production';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';
import { ensureValidKey } from '@/test/expo-secure-store-double';
import { createFakeDrive, type FakeDrive } from '@/test/fake-drive-server';
import { createFakeGraph } from '@/test/fake-graph-server';

beforeEach(() => {
  mockKv.clear();
  resetExpoCryptoDouble();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FIELDS: ByosConnectFields = {
  endpoint: 'https://s3.example.com',
  bucket: 'my-bucket',
  accessKey: 'AK',
  secret: 'SK',
  prefix: 'waifu-deck/',
};
const META_PATH = 'waifu-deck/vault-meta.json';

type StoredObject = { body: Uint8Array; etag: string };

function fakeTransport(initial: Record<string, StoredObject> = {}) {
  const store: Record<string, StoredObject> = { ...initial };
  let seq = 0;
  return {
    store,
    async getObject(key: string): Promise<StoredObject | null> {
      const found = store[key];
      return found ? { body: found.body, etag: found.etag } : null;
    },
    async putObject(
      key: string,
      body: Uint8Array,
      options: { ifMatch?: string; ifNoneMatch?: string },
    ): Promise<{ etag: string | null }> {
      if (options.ifNoneMatch === '*' && store[key]) {
        throw new S3TransportError(412, 'precondition', 'exists', true);
      }
      const etag = `etag-${(seq += 1)}`;
      store[key] = { body, etag };
      return { etag };
    },
  };
}

function throwingTransport(error: unknown): ByosTransportPort {
  return {
    async getObject() { throw error; },
    async putObject() { throw error; },
  };
}

function memoryPort(): SecureStorePort {
  const map = new Map<string, string>();
  return {
    getItemAsync: async (k) => { ensureValidKey(k); return map.get(k) ?? null; },
    setItemAsync: async (k, v) => { ensureValidKey(k); map.set(k, v); },
    deleteItemAsync: async (k) => { ensureValidKey(k); map.delete(k); },
  };
}

function stores(port: SecureStorePort = memoryPort()) {
  return {
    port,
    credentialStore: createByosCredentialStore(port),
    sessionCache: createByosSessionCache(port),
  };
}

function metaObject(body: string): StoredObject {
  return { body: encoder.encode(body), etag: 'e0' };
}

describe('probeBucket', () => {
  it('reports an empty bucket when vault-meta.json is absent', async () => {
    const transport = fakeTransport();
    const result = await probeBucket(FIELDS, {
      createTransport: () => transport,
    });
    expect(result).toEqual({ kind: 'empty' });
  });

  it('reports an existing encrypted vault and carries its meta', async () => {
    const { meta } = await buildVaultMeta('pw', 'aes-gcm');
    const transport = fakeTransport({
      [META_PATH]: metaObject(JSON.stringify(meta)),
    });
    const result = await probeBucket(FIELDS, {
      createTransport: () => transport,
    });
    expect(result).toEqual({ kind: 'existing-encrypted', meta });
  });

  it('reports an existing plaintext vault', async () => {
    const { meta } = await buildVaultMeta(null, 'none');
    const transport = fakeTransport({
      [META_PATH]: metaObject(JSON.stringify(meta)),
    });
    const result = await probeBucket(FIELDS, {
      createTransport: () => transport,
    });
    expect(result).toEqual({ kind: 'existing-plain', meta });
  });

  it.each<[S3FailureCategory, string]>([
    ['network', 'network'],
    ['rate_limited', 'network'],
    ['credential', 'credential_rejected'],
    ['client', 'not_s3'],
    ['server', 'not_s3'],
    ['precondition', 'not_s3'],
  ])('maps an S3 %s failure to %s', async (category, expected) => {
    const result = await probeBucket(FIELDS, {
      createTransport: () => throwingTransport(
        new S3TransportError(500, category, 'boom'),
      ),
    });
    expect(result).toMatchObject({ kind: 'error', category: expected });
  });

  it('maps a non-S3 failure (malformed endpoint URL) to not_s3', async () => {
    const result = await probeBucket(FIELDS, {
      createTransport: () => throwingTransport(new TypeError('Invalid URL')),
    });
    expect(result).toMatchObject({ kind: 'error', category: 'not_s3' });
  });

  it('maps unreadable and too-new vault-meta.json to meta_corrupt', async () => {
    const corrupt = await probeBucket(FIELDS, {
      createTransport: () => fakeTransport({ [META_PATH]: metaObject('{not json') }),
    });
    expect(corrupt).toMatchObject({ kind: 'error', category: 'meta_corrupt' });

    const { meta } = await buildVaultMeta('pw', 'aes-gcm');
    const future = await probeBucket(FIELDS, {
      createTransport: () => fakeTransport({
        [META_PATH]: metaObject(JSON.stringify({ ...meta, protocolVersion: 99 })),
      }),
    });
    expect(future).toMatchObject({ kind: 'error', category: 'meta_corrupt' });
  });
});

// U4-design (owner ruling 2026-10-12): the form no longer collects a folder
// prefix or a WebDAV root path. Both fields sent '' when empty, and an absent
// value must resolve exactly as the field's empty value did — `waifu-deck/` for
// the S3 prefix (toCredentials output) and `/` for the WebDAV root
// (toWebdavBinding output).
describe('U4-design: the removed prefix / root-path fields keep their defaults', () => {
  it('a connect with no prefix field targets waifu-deck/ (toCredentials output)', async () => {
    const seen: ByosCredentials[] = [];
    const capture = (credentials: ByosCredentials) => {
      seen.push(credentials);
      return fakeTransport();
    };
    const noPrefix: ByosConnectFields = {
      endpoint: 'https://s3.example.com', bucket: 'my-bucket', accessKey: 'AK', secret: 'SK',
    };
    await expect(probeBucket(noPrefix, { createTransport: capture })).resolves.toEqual({ kind: 'empty' });
    // The empty value the removed field used to send resolves identically.
    await expect(probeBucket({ ...FIELDS, prefix: '' }, { createTransport: capture })).resolves.toEqual({ kind: 'empty' });
    expect(seen.map((c) => c.prefix)).toEqual(['waifu-deck/', 'waifu-deck/']);
  });

  it('a create with no prefix field stores the vault under waifu-deck/ (connectToBucket)', async () => {
    const seen: ByosCredentials[] = [];
    const result = await connectToBucket({
      fields: { endpoint: 'https://s3.example.com', bucket: 'my-bucket', accessKey: 'AK', secret: 'SK' },
      probe: { kind: 'empty' },
      encryption: 'none',
    }, {
      createTransport: (credentials) => { seen.push(credentials); return fakeTransport(); },
      ...stores(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(seen.map((c) => c.prefix)).toEqual(['waifu-deck/']);
  });

  it('the WebDAV binding root stays "/" for an absent or empty rootPath (toWebdavBinding output)', async () => {
    const bindings: WebdavBinding[] = [];
    const capture = (binding: WebdavBinding) => {
      bindings.push(binding);
      return createMemoryCloudObjectStore();
    };
    const base = { baseUrl: 'https://dav.example.com', username: 'u', password: 'p' };
    await expect(probeWebdav(base, { createStore: capture })).resolves.toEqual({ kind: 'empty' });
    await expect(probeWebdav({ ...base, rootPath: '' }, { createStore: capture })).resolves.toEqual({ kind: 'empty' });
    expect(bindings.map((b) => b.rootPath)).toEqual(['/', '/']);
  });
});

describe('connectToBucket — create on an empty bucket', () => {
  it('creates an encrypted vault and persists credentials and session', async () => {
    const transport = fakeTransport();
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS,
      probe: { kind: 'empty' },
      encryption: 'aes-gcm',
      password: 'pw',
      passwordConfirm: 'pw',
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result.ok).toBe(true);
    const written = parseVaultMeta(decoder.decode(transport.store[META_PATH]!.body));
    expect(written.encryption).toBe('aes-gcm');

    expect(await credentialStore.load()).toEqual({
      kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'my-bucket',
      accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'waifu-deck/',
    });
    const session = await sessionCache.load();
    expect(session).toMatchObject({
      vaultId: written.vaultId, encryption: 'aes-gcm',
    });
    const expected = await openVaultWithPassword(written, 'pw');
    expect(Buffer.from(session!.masterKeyB64!, 'base64').equals(
      Buffer.from(expected!),
    )).toBe(true);
  });

  it('creates a plaintext vault without a password and caches a null key', async () => {
    const transport = fakeTransport();
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS, probe: { kind: 'empty' }, encryption: 'none',
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result.ok).toBe(true);
    const written = parseVaultMeta(decoder.decode(transport.store[META_PATH]!.body));
    expect(written.encryption).toBe('none');
    expect(await sessionCache.load()).toEqual({
      masterKeyB64: null, vaultId: written.vaultId, encryption: 'none',
    });
    expect(await credentialStore.load()).not.toBeNull();
  });

  it('rejects mismatched password confirmation before touching the bucket', async () => {
    const transport = fakeTransport();
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS, probe: { kind: 'empty' }, encryption: 'aes-gcm',
      password: 'pw', passwordConfirm: 'typo',
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result).toMatchObject({ ok: false, category: 'password_mismatch' });
    expect(transport.store[META_PATH]).toBeUndefined();
    expect(await credentialStore.load()).toBeNull();
    expect(await sessionCache.load()).toBeNull();
  });

  it('rejects an empty password when encryption is on', async () => {
    const transport = fakeTransport();
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS, probe: { kind: 'empty' }, encryption: 'aes-gcm',
      password: '', passwordConfirm: '',
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result).toMatchObject({
      ok: false, category: 'password_mismatch', detail: 'password_required',
    });
    expect(transport.store[META_PATH]).toBeUndefined();
    expect(await credentialStore.load()).toBeNull();
  });

  it('leaves the device configured-but-locked, not orphaned, when the session save fails after credentials persist', async () => {
    // Pins the persistence order documented on connectToBucket: credentials
    // are saved first, then the session. If the session save rejects, the
    // failure must propagate (no honest ByosConnectError member for a local
    // secure-storage fault) but the credential write must already have
    // landed, so the device is recoverable via re-entering the password
    // rather than left without credentials for a vault it half-joined.
    const transport = fakeTransport();
    const { credentialStore } = stores();
    const sessionCache = {
      load: async () => null,
      save: async () => { throw new Error('secure store unavailable'); },
      clear: async () => {},
    };

    await expect(connectToBucket({
      fields: FIELDS,
      probe: { kind: 'empty' },
      encryption: 'aes-gcm',
      password: 'pw',
      passwordConfirm: 'pw',
    }, { createTransport: () => transport, credentialStore, sessionCache }))
      .rejects.toThrow('secure store unavailable');

    expect(await credentialStore.load()).not.toBeNull();
  });

  it('K7 ㉟: creates with one PUT and no read; adopts a vault created between probe and create', async () => {
    const calls: string[] = [];
    const base = fakeTransport();
    const transport = {
      store: base.store,
      async getObject(key: string) { calls.push(`GET ${key}`); return base.getObject(key); },
      async putObject(key: string, body: Uint8Array, options: { ifMatch?: string; ifNoneMatch?: string }) {
        calls.push(`PUT ${key}`); return base.putObject(key, body, options);
      },
    };
    const { credentialStore, sessionCache } = stores();

    const created = await connectToBucket({
      fields: FIELDS, probe: { kind: 'empty' }, encryption: 'aes-gcm', password: 'pw', passwordConfirm: 'pw',
    }, { createTransport: () => transport, credentialStore, sessionCache });
    expect(created.ok).toBe(true);
    expect(calls).toEqual([`PUT ${META_PATH}`]);

    // A second device races the same empty probe: its PUT is refused and it adopts.
    calls.length = 0;
    const other = stores();
    const adopted = await connectToBucket({
      fields: FIELDS, probe: { kind: 'empty' }, encryption: 'aes-gcm', password: 'pw', passwordConfirm: 'pw',
    }, { createTransport: () => transport, credentialStore: other.credentialStore, sessionCache: other.sessionCache });
    expect(adopted.ok).toBe(true);
    expect(calls).toEqual([`PUT ${META_PATH}`, `GET ${META_PATH}`]);
    const stored = parseVaultMeta(decoder.decode(transport.store[META_PATH]!.body));
    expect((await other.sessionCache.load())?.vaultId).toBe(stored.vaultId);
  });
});

describe('connectToBucket — join an existing vault', () => {
  it('joins an encrypted vault with the right password', async () => {
    const built = await buildVaultMeta('pw', 'aes-gcm');
    const transport = fakeTransport({
      [META_PATH]: metaObject(JSON.stringify(built.meta)),
    });
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS,
      probe: { kind: 'existing-encrypted', meta: built.meta },
      password: 'pw',
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result).toEqual({
      ok: true, vaultId: built.meta.vaultId, encryption: 'aes-gcm',
    });
    const session = await sessionCache.load();
    expect(Buffer.from(session!.masterKeyB64!, 'base64').equals(
      Buffer.from(built.masterKey!),
    )).toBe(true);
    expect(await credentialStore.load()).not.toBeNull();
  });

  it('rejects a wrong password and persists nothing', async () => {
    const built = await buildVaultMeta('pw', 'aes-gcm');
    const transport = fakeTransport({
      [META_PATH]: metaObject(JSON.stringify(built.meta)),
    });
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS,
      probe: { kind: 'existing-encrypted', meta: built.meta },
      password: 'nope',
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result).toMatchObject({ ok: false, category: 'wrong_password' });
    expect(await credentialStore.load()).toBeNull();
    expect(await sessionCache.load()).toBeNull();
  });

  it('joins a plaintext vault with no password at all', async () => {
    const built = await buildVaultMeta(null, 'none');
    const transport = fakeTransport({
      [META_PATH]: metaObject(JSON.stringify(built.meta)),
    });
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: FIELDS, probe: { kind: 'existing-plain', meta: built.meta },
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result).toEqual({
      ok: true, vaultId: built.meta.vaultId, encryption: 'none',
    });
    expect(await sessionCache.load()).toEqual({
      masterKeyB64: null, vaultId: built.meta.vaultId, encryption: 'none',
    });
  });

  it('normalizes the four fields into stored credentials', async () => {
    const built = await buildVaultMeta(null, 'none');
    const transport = fakeTransport({
      ['team/photos/vault-meta.json']: metaObject(JSON.stringify(built.meta)),
    });
    const { credentialStore, sessionCache } = stores();

    const result = await connectToBucket({
      fields: {
        endpoint: '  https://s3.example.com/  ', bucket: ' my-bucket ',
        accessKey: ' AK ', secret: 'SK', prefix: ' /team/photos ',
      },
      probe: { kind: 'existing-plain', meta: built.meta },
    }, { createTransport: () => transport, credentialStore, sessionCache });

    expect(result.ok).toBe(true);
    expect(await credentialStore.load()).toEqual({
      kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'my-bucket',
      accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'team/photos/',
    });
  });
});

function modeStorage(): { map: Map<string, string>; storage: KeyValueStorage } {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: async (key) => map.get(key) ?? null,
      setItem: async (key, value) => { map.set(key, value); },
      removeItem: async (key) => { map.delete(key); },
    },
  };
}

describe('disconnectDevice', () => {
  it('clears the credentials, the cached session and the storage mode', async () => {
    const { port, credentialStore, sessionCache } = stores();
    const { map, storage } = modeStorage();
    const storageMode = createLibraryStorageModeStore(storage);
    await storageMode.write('v1', 'cloud-only');
    expect(map.has(LIBRARY_STORAGE_MODE_KEY)).toBe(true);
    await connectToBucket({
      fields: FIELDS, probe: { kind: 'empty' }, encryption: 'none',
    }, {
      createTransport: () => fakeTransport(), credentialStore, sessionCache,
    });
    expect(await credentialStore.load()).not.toBeNull();

    await disconnectDevice({ credentialStore, sessionCache, storageMode });

    expect(await credentialStore.load()).toBeNull();
    expect(await sessionCache.load()).toBeNull();
    expect(await port.getItemAsync(BYOS_SESSION_CACHE_KEY)).toBeNull();
    expect(map.has(LIBRARY_STORAGE_MODE_KEY)).toBe(false);
  });

  it("board #27 S3b: a real 断开此设备 clears the mode the composition's default store wrote", async () => {
    await createLibraryStorageModeStore().write('v1', 'cloud-only');
    expect(mockKv.has(LIBRARY_STORAGE_MODE_KEY)).toBe(true);
    const { credentialStore, sessionCache } = stores();

    await disconnectDevice({ credentialStore, sessionCache });

    expect(mockKv.has(LIBRARY_STORAGE_MODE_KEY)).toBe(false);
    await expect(createLibraryStorageModeStore().read('v1')).resolves.toBe('both');
  });

  it('a mode that cannot be cleared still clears credentials and session, and is reported', async () => {
    const { credentialStore, sessionCache } = stores();
    await sessionCache.save({
      masterKeyB64: null, vaultId: 'v1', encryption: 'none',
    });
    await credentialStore.save({
      kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'my-bucket',
      accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'waifu-deck/',
    });
    const storageMode = { clear: async () => { throw new Error('kv unavailable'); } };

    await expect(disconnectDevice({ credentialStore, sessionCache, storageMode }))
      .rejects.toThrow('kv unavailable');
    expect(await credentialStore.load()).toBeNull();
    expect(await sessionCache.load()).toBeNull();
  });

  it('still clears the session when clearing credentials fails', async () => {
    const { sessionCache } = stores();
    await sessionCache.save({
      masterKeyB64: null, vaultId: 'v1', encryption: 'none',
    });
    const credentialStore = {
      load: async () => null,
      save: async () => {},
      clear: async () => { throw new Error('secure store unavailable'); },
      loadBinding: async () => null,
      saveBinding: async () => {},
    };

    const mode = modeStorage();
    const storageMode = createLibraryStorageModeStore(mode.storage);
    await storageMode.write('v1', 'cloud-only');

    await expect(disconnectDevice({ credentialStore, sessionCache, storageMode }))
      .rejects.toThrow('secure store unavailable');
    expect(await sessionCache.load()).toBeNull();
    // All three are attempted even when one rejects: the mode is gone too.
    await expect(storageMode.read('v1')).resolves.toBe('both');
  });
});

describe('WebDAV connect (P12-B)', () => {
  const FIELDS: WebdavConnectFields = {
    baseUrl: ' https://dav.example.com/ ', username: 'alice', password: 'pw', rootPath: '',
  };

  it('refuses http:// before touching the network (insecure_url)', async () => {
    let built = 0;
    const r = await probeWebdav({ ...FIELDS, baseUrl: 'http://192.168.1.2:5005' }, {
      createStore: () => { built += 1; return createMemoryCloudObjectStore(); },
    });
    expect(r).toEqual({ kind: 'error', category: 'insecure_url' });
    expect(built).toBe(0);
  });

  it('a non-URL is insecure_url too', async () => {
    const r = await probeWebdav({ ...FIELDS, baseUrl: 'dav.example.com' }, {
      createStore: () => createMemoryCloudObjectStore(),
    });
    expect(r).toMatchObject({ kind: 'error', category: 'insecure_url' });
  });

  it('probe: ensureLayout then meta GET — empty store → empty; existing v2 encrypted vault → existing-encrypted', async () => {
    const store = createMemoryCloudObjectStore();
    expect(await probeWebdav(FIELDS, { createStore: () => store })).toEqual({ kind: 'empty' });
    expect(store.calls.map((c) => c.op)).toEqual(['ensureLayout', 'get']);

    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    expect(await probeWebdav(FIELDS, { createStore: () => store })).toEqual({ kind: 'existing-encrypted', meta });
  });

  it('probe: a plaintext vault on a store is meta_corrupt (spec §6), never existing-plain', async () => {
    const store = createMemoryCloudObjectStore();
    const { meta } = await buildVaultMeta(null, 'none', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    const result = await probeWebdav(FIELDS, { createStore: () => store });
    expect(result).toMatchObject({ kind: 'error', category: 'meta_corrupt' });
  });

  it.each([
    // N9: a WebDAV 401/403 reads as network (暂时连不上) — 123 云盘's transient
    // 401 must never accuse the stored credentials. The drive providers keep
    // credential_rejected (their it.each tables below).
    [401, 'auth', 'network'],
    [0, 'network', 'network'],
    [409, 'client', 'not_webdav'],
    [500, 'server', 'not_webdav'],
  ] as const)('probe maps store %s/%s to %s', async (status, category, expected) => {
    const store: CloudObjectStore = {
      ...createMemoryCloudObjectStore(),
      ensureLayout: async () => { throw new CloudStoreError(status, category, 'x'); },
    };
    const result = await probeWebdav(FIELDS, { createStore: () => store });
    expect(result).toMatchObject({ kind: 'error', category: expected });
  });

  it('connect (empty): validates the password pair, creates a v2 aes-gcm vault, persists the trimmed binding and the session', async () => {
    const store = createMemoryCloudObjectStore();
    const { credentialStore, sessionCache } = stores();

    const r = await connectWebdav({
      fields: FIELDS, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw',
    }, { createStore: () => store, credentialStore, sessionCache });

    expect(r).toMatchObject({ ok: true, encryption: 'aes-gcm' });
    expect(await credentialStore.loadBinding()).toEqual({
      kind: 'webdav', baseUrl: 'https://dav.example.com', username: 'alice',
      password: 'pw', rootPath: '/',
    });
    const written = parseVaultMeta(decoder.decode(store.objects().get('vault-meta.json')!), 2);
    expect(written.protocolVersion).toBe(2);
    expect((await sessionCache.load())?.vaultId).toBe(written.vaultId);
  });

  it('connect (empty) with a mismatched confirmation is password_mismatch and writes nothing', async () => {
    const store = createMemoryCloudObjectStore();
    const result = await connectWebdav({
      fields: FIELDS, probe: { kind: 'empty' }, password: 'a', passwordConfirm: 'b',
    }, { createStore: () => store, ...stores() });

    expect(result).toEqual({ ok: false, category: 'password_mismatch', detail: 'confirmation_mismatch' });
    expect(store.objects().size).toBe(0);
  });

  it('connect (existing): joins with the right password; wrong password is wrong_password', async () => {
    const store = createMemoryCloudObjectStore();
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');

    const wrongStores = stores();
    const wrong = await connectWebdav({
      fields: FIELDS, probe: { kind: 'existing-encrypted', meta }, password: 'nope',
    }, { createStore: () => store, ...wrongStores });
    expect(wrong).toMatchObject({ ok: false, category: 'wrong_password' });
    // Persists nothing: a rejected join must not leave a binding or a session
    // behind (the S3 sibling pins the same rule).
    expect(await wrongStores.credentialStore.loadBinding()).toBeNull();
    expect(await wrongStores.sessionCache.load()).toBeNull();

    const right = await connectWebdav({
      fields: FIELDS, probe: { kind: 'existing-encrypted', meta }, password: 'pw',
    }, { createStore: () => store, ...stores() });
    expect(right).toMatchObject({ ok: true, vaultId: meta.vaultId });
  });

  it('rootPath collapses repeated slashes inside the path (a doubled slash would land in every object path)', async () => {
    const store = createMemoryCloudObjectStore();
    const { credentialStore, sessionCache } = stores();
    await connectWebdav({
      fields: { ...FIELDS, rootPath: '//photos//lib//' },
      probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw',
    }, { createStore: () => store, credentialStore, sessionCache });
    expect(await credentialStore.loadBinding()).toMatchObject({ rootPath: '/photos/lib/' });
  });

  it('rootPath is normalized to /segments/ and the password is never trimmed', async () => {
    const store = createMemoryCloudObjectStore();
    const { credentialStore } = stores();

    await connectWebdav({
      fields: { ...FIELDS, rootPath: ' photos/lib ', password: ' sp ' },
      probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw',
    }, { createStore: () => store, credentialStore, sessionCache: stores().sessionCache });

    expect(await credentialStore.loadBinding()).toMatchObject({
      rootPath: '/photos/lib/', password: ' sp ',
    });
  });
});

describe('OneDrive connect (P12-C)', () => {
  const BINDING: OneDriveBinding = { kind: 'onedrive', refreshToken: 'RT-signin', accountEmail: 'o@example.com', rootFolderId: 'F0001', stateFolderId: 'F0002', blobsFolderId: 'F0003' };
  const SOURCE: OneDriveSource = { binding: BINDING, accessToken: 'AT', expiresAt: Date.now() + 3600_000 };
  const okSignIn = (refreshToken = 'RT-signin') => async () => ({ ok: true as const, tokens: { accessToken: 'AT', refreshToken, expiresAt: Date.now() + 3600_000 } });

  it('signInWithMicrosoft: sign-in → bootstrap over the real fake Graph → a source whose binding carries the refresh token, the e-mail and the three ids', async () => {
    const graph = createFakeGraph();
    const at = graph.issueAccessToken();
    const r = await signInWithMicrosoft({ signIn: async () => ({ ok: true, tokens: { accessToken: at, refreshToken: 'RT-x', expiresAt: 9 } }), bootstrap: (token) => bootstrapOneDriveLayout(graph.fetch, token) });
    expect(r).toEqual({ ok: true, source: { binding: { kind: 'onedrive', refreshToken: 'RT-x', accountEmail: 'owner@example.com', ...graph.ids }, accessToken: at, expiresAt: 9 } });
  });
  it('signInWithMicrosoft: a cancelled sign-in passes through; a 403 bootstrap (AppFolder provisioning) is credential_rejected; a 5xx is not_onedrive', async () => {
    expect(await signInWithMicrosoft({ signIn: async () => ({ ok: false, category: 'sign_in_cancelled', detail: 'cancel' }) })).toEqual({ ok: false, category: 'sign_in_cancelled', detail: 'cancel' });
    const graph = createFakeGraph();
    graph.failNext(403, { error: { code: 'accessDenied' } });
    expect(await signInWithMicrosoft({ signIn: okSignIn(), bootstrap: () => bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken()) })).toMatchObject({ ok: false, category: 'credential_rejected' });
    graph.failNext(500);
    expect(await signInWithMicrosoft({ signIn: okSignIn(), bootstrap: () => bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken()) })).toMatchObject({ ok: false, category: 'not_onedrive' });
  });
  it('signInWithMicrosoft: never persists — no credentialStore or sessionCache write, even on a successful sign-in', async () => {
    const graph = createFakeGraph();
    const { credentialStore, sessionCache } = stores();
    const r = await signInWithMicrosoft({ signIn: okSignIn(), bootstrap: () => bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken()), credentialStore, sessionCache });
    expect(r).toMatchObject({ ok: true });
    expect(await credentialStore.loadBinding()).toBeNull();
    expect(await sessionCache.load()).toBeNull();
  });
  it('probe: ensureLayout then meta GET — empty → empty; v2 encrypted → existing-encrypted; plaintext → meta_corrupt; store failures map with the OneDrive vocabulary', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    expect(await probeOneDrive(SOURCE, { createStore: () => store })).toEqual({ kind: 'empty' });
    expect(store.calls.map((c) => c.op)).toEqual(['ensureLayout', 'get']);
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    expect(await probeOneDrive(SOURCE, { createStore: () => store })).toEqual({ kind: 'existing-encrypted', meta });
    const { meta: plainMeta } = await buildVaultMeta(null, 'none', undefined, 2);
    const plainStore = createMemoryCloudObjectStore({ kind: 'onedrive' });
    await plainStore.put('vault-meta.json', encoder.encode(JSON.stringify(plainMeta)), 'application/json');
    expect(await probeOneDrive(SOURCE, { createStore: () => plainStore })).toEqual({ kind: 'error', category: 'meta_corrupt', detail: 'unencrypted_store_vault' });
    for (const [status, category, message, expected] of [[401, 'auth', 'x', 'credential_rejected'], [401, 'auth', 'reauth_required: revoked', 'reauth_required'], [0, 'network', 'x', 'network'], [404, 'client', 'app folder missing', 'not_onedrive'], [500, 'server', 'x', 'not_onedrive']] as const) {
      const failing: CloudObjectStore = { ...store, ensureLayout: async () => { throw new CloudStoreError(status, category, message); } };
      expect(await probeOneDrive(SOURCE, { createStore: () => failing })).toMatchObject({ kind: 'error', category: expected });
    }
  });
  it('probeOneDrive: with no deps, the production store factory still gets a resolved credentialStore (never undefined) — this is what wires rotation write-back on the no-deps path', async () => {
    const factory = createProductionOneDriveStore as jest.Mock;
    factory.mockClear();
    factory.mockReturnValue(createMemoryCloudObjectStore({ kind: 'onedrive' }));

    await probeOneDrive(SOURCE);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(BINDING, expect.objectContaining({ credentialStore: expect.anything() }));

    factory.mockClear();
    const { credentialStore } = stores();
    await probeOneDrive(SOURCE, { credentialStore });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(BINDING, expect.objectContaining({ credentialStore }));
  });
  it('connect: a directly-constructed plaintext probe is refused as meta_corrupt (the encryption guard runs even when a caller hands connectOneDrive a probe object it did not get from probeOneDrive) — nothing persisted', async () => {
    const { meta: plainMeta } = await buildVaultMeta(null, 'none', undefined, 2);
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    const s = stores();
    const r = await connectOneDrive({ source: SOURCE, probe: { kind: 'existing-encrypted', meta: plainMeta }, password: 'x' }, { createStore: () => store, ...s });
    expect(r).toEqual({ ok: false, category: 'meta_corrupt', detail: 'unencrypted_store_vault' });
    expect(await s.credentialStore.loadBinding()).toBeNull();
    expect(await s.sessionCache.load()).toBeNull();
  });
  it('connectOneDrive: with no deps, the production store factory still gets a resolved credentialStore, and connectOneDrive reuses that SAME instance for its own saveBinding', async () => {
    const factory = createProductionOneDriveStore as jest.Mock;
    factory.mockClear();
    factory.mockReturnValue(createMemoryCloudObjectStore({ kind: 'onedrive' }));

    const r = await connectOneDrive({ source: SOURCE, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw' });
    expect(r).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(BINDING, expect.objectContaining({ credentialStore: expect.anything() }));

    factory.mockClear();
    factory.mockReturnValue(createMemoryCloudObjectStore({ kind: 'onedrive' }));
    const { credentialStore } = stores();
    const r2 = await connectOneDrive({ source: SOURCE, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw' }, { credentialStore });
    expect(r2).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(BINDING, expect.objectContaining({ credentialStore }));
  });
  it('connect (empty): validates the password pair, creates a v2 aes-gcm vault, persists the binding with the SIGN-IN refresh token and the session', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    const { credentialStore, sessionCache } = stores();
    const r = await connectOneDrive({ source: SOURCE, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw' }, { createStore: () => store, credentialStore, sessionCache });
    expect(r).toMatchObject({ ok: true, encryption: 'aes-gcm' });
    expect(await credentialStore.loadBinding()).toEqual(BINDING);
    const written = parseVaultMeta(decoder.decode(store.objects().get('vault-meta.json')!), 2);
    expect(written.protocolVersion).toBe(2);
    expect((await sessionCache.load())?.vaultId).toBe(written.vaultId);
  });
  it('connect (unlock path): when a binding for the same app folder is already stored, its (possibly rotated) refresh token wins over the source copy; a binding stored for a DIFFERENT app folder never leaks its token in', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding({ ...BINDING, refreshToken: 'RT-rotated-during-probe' });
    const r = await connectOneDrive({ source: { binding: BINDING, accessToken: null, expiresAt: 0 }, probe: { kind: 'existing-encrypted', meta }, password: 'pw' }, { createStore: () => store, credentialStore, sessionCache });
    expect(r).toMatchObject({ ok: true, vaultId: meta.vaultId });
    expect((await credentialStore.loadBinding())).toMatchObject({ refreshToken: 'RT-rotated-during-probe' });

    // Negative half: a stored binding for ANOTHER rootFolderId (drive A) must
    // never leak its refresh token into a connect for a different drive (B) —
    // the saved binding must carry drive B's OWN refresh token.
    const otherStore = createMemoryCloudObjectStore({ kind: 'onedrive' });
    const { meta: otherMeta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await otherStore.put('vault-meta.json', encoder.encode(JSON.stringify(otherMeta)), 'application/json');
    const s2 = stores();
    const driveA: OneDriveBinding = { ...BINDING, rootFolderId: 'F-drive-A', refreshToken: 'RT-drive-A' };
    const driveB: OneDriveBinding = { ...BINDING, rootFolderId: 'F-drive-B', refreshToken: 'RT-drive-B' };
    await s2.credentialStore.saveBinding(driveA);
    const r2 = await connectOneDrive({ source: { binding: driveB, accessToken: null, expiresAt: 0 }, probe: { kind: 'existing-encrypted', meta: otherMeta }, password: 'pw' }, { createStore: () => otherStore, credentialStore: s2.credentialStore, sessionCache: s2.sessionCache });
    expect(r2).toMatchObject({ ok: true, vaultId: otherMeta.vaultId });
    expect(await s2.credentialStore.loadBinding()).toMatchObject({ rootFolderId: 'F-drive-B', refreshToken: 'RT-drive-B' });
  });
  it('connect: a wrong password or a mismatched confirmation persists nothing', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    const s = stores();
    expect(await connectOneDrive({ source: SOURCE, probe: { kind: 'existing-encrypted', meta }, password: 'nope' }, { createStore: () => store, ...s })).toMatchObject({ ok: false, category: 'wrong_password' });
    expect(await connectOneDrive({ source: SOURCE, probe: { kind: 'empty' }, password: 'a', passwordConfirm: 'b' }, { createStore: () => createMemoryCloudObjectStore(), ...s })).toEqual({ ok: false, category: 'password_mismatch', detail: 'confirmation_mismatch' });
    expect(await s.credentialStore.loadBinding()).toBeNull();
    expect(await s.sessionCache.load()).toBeNull();
  });
  it('reauth: replaces ONLY the refresh token of the stored onedrive binding (ids, e-mail, session untouched); a different account is refused; no stored onedrive binding is credential_rejected', async () => {
    const graph = createFakeGraph();
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding({ ...BINDING, refreshToken: 'RT-dead' });
    await sessionCache.save({ masterKeyB64: 'AAAA', vaultId: 'v', encryption: 'aes-gcm' });
    const r = await reauthOneDrive({ signIn: okSignIn('RT-new'), bootstrap: () => bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken()), credentialStore, sessionCache });
    expect(r).toEqual({ ok: true });
    expect(await credentialStore.loadBinding()).toEqual({ ...BINDING, refreshToken: 'RT-new', accountEmail: 'owner@example.com' });
    expect((await sessionCache.load())?.vaultId).toBe('v');
    // Another Microsoft account = another drive = another approot id.
    const other = await reauthOneDrive({ signIn: okSignIn('RT-other'), bootstrap: async () => ({ ids: { ...graph.ids, rootFolderId: 'F-other-drive' }, accountEmail: 'someone-else@example.com' }), credentialStore, sessionCache });
    expect(other).toMatchObject({ ok: false, category: 'credential_rejected', detail: 'account_mismatch' });
    expect((await credentialStore.loadBinding())).toMatchObject({ refreshToken: 'RT-new' });
    expect(await reauthOneDrive({ signIn: okSignIn(), ...stores() })).toMatchObject({ ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' });
  });
  it('reauth: masterKeyB64 is left untouched; a cancelled sign-in passes through; a 5xx bootstrap is not_onedrive with the stored binding unchanged; a stored WEBDAV binding has no onedrive credentials to reauth', async () => {
    const graph = createFakeGraph();
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding({ ...BINDING, refreshToken: 'RT-dead' });
    await sessionCache.save({ masterKeyB64: 'MASTER-KEY-UNTOUCHED', vaultId: 'v', encryption: 'aes-gcm' });

    expect(await reauthOneDrive({ signIn: async () => ({ ok: false, category: 'sign_in_cancelled', detail: 'cancel' }), credentialStore, sessionCache }))
      .toEqual({ ok: false, category: 'sign_in_cancelled', detail: 'cancel' });
    expect(await credentialStore.loadBinding()).toMatchObject({ refreshToken: 'RT-dead' });

    graph.failNext(500);
    expect(await reauthOneDrive({ signIn: okSignIn('RT-should-not-land'), bootstrap: () => bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken()), credentialStore, sessionCache }))
      .toMatchObject({ ok: false, category: 'not_onedrive' });
    expect(await credentialStore.loadBinding()).toMatchObject({ refreshToken: 'RT-dead' });
    expect((await sessionCache.load())?.masterKeyB64).toBe('MASTER-KEY-UNTOUCHED');

    const webdav = stores();
    await webdav.credentialStore.saveBinding({ kind: 'webdav', baseUrl: 'https://dav.example.com', username: 'u', password: 'p', rootPath: '/' });
    expect(await reauthOneDrive({ signIn: okSignIn(), credentialStore: webdav.credentialStore, sessionCache: webdav.sessionCache }))
      .toEqual({ ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' });
  });
});

describe('Google Drive connect (P12-D)', () => {
  const BINDING: GoogleDriveBinding = { kind: 'gdrive', refreshToken: '1//RT-signin', accountEmail: 'g@example.com', rootFolderId: 'D-root', stateFolderId: 'D-state', blobsFolderId: 'D-blobs' };
  const SOURCE: GdriveSource = { binding: BINDING, accessToken: 'ya29.AT', expiresAt: Date.now() + 3600_000 };
  const okSignIn = (refreshToken = '1//RT-signin', accessToken = 'ya29.AT') => async () => ({ ok: true as const, tokens: { accessToken, refreshToken, expiresAt: Date.now() + 3600_000 } });
  /** A real Drive adapter over the fake Drive v3 REST (Tasks 4–7), with the sign-in's access token as its seed. */
  const realDriveStore = (drive: FakeDrive, ids: GdriveSource['binding'] = { ...BINDING, ...drive.ids }) => createGoogleDriveCloudObjectStore(
    { rootFolderId: ids.rootFolderId, stateFolderId: ids.stateFolderId, blobsFolderId: ids.blobsFolderId },
    {
      tokens: createGoogleTokenSource({
        seed: { accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 },
        refresh: async () => ({ accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 }),
      }),
      fetchImpl: drive.fetch, uploadFile: drive.uploadFile, statFile: async () => null,
    },
  );

  it('signInWithGoogle: sign-in → bootstrap over the fake Drive (empty) → {ok, source:{binding:{kind:gdrive, refresh token, e-mail, the three created folder ids}, accessToken, expiresAt}}', async () => {
    const drive = createFakeDrive({ emptyLayout: true });
    const at = drive.issueAccessToken();
    const r = await signInWithGoogle({ signIn: async () => ({ ok: true, tokens: { accessToken: at, refreshToken: '1//RT-x', expiresAt: 9 } }), bootstrap: (token) => bootstrapGoogleDriveLayout(drive.fetch, token) });
    if (!r.ok) throw new Error(`sign-in failed: ${r.category}`);
    expect(r).toEqual({ ok: true, source: { binding: { kind: 'gdrive', refreshToken: '1//RT-x', accountEmail: drive.accountEmail, rootFolderId: expect.any(String), stateFolderId: expect.any(String), blobsFolderId: expect.any(String) }, accessToken: at, expiresAt: 9 } });
    expect(drive.fileById(r.source.binding.rootFolderId)).toMatchObject({ name: 'Waifu Deck', folder: true, parentId: null });
    expect(drive.fileById(r.source.binding.stateFolderId)).toMatchObject({ name: 'state', parentId: r.source.binding.rootFolderId });
    expect(drive.fileById(r.source.binding.blobsFolderId)).toMatchObject({ name: 'blobs', parentId: r.source.binding.rootFolderId });
  });
  it('signInWithGoogle: persists NOTHING — no credentialStore or sessionCache write, even on a successful sign-in', async () => {
    const drive = createFakeDrive();
    const { credentialStore, sessionCache, port } = stores();
    const writes = jest.spyOn(port, 'setItemAsync');
    const r = await signInWithGoogle({ signIn: okSignIn(), bootstrap: () => bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken()), credentialStore, sessionCache });
    expect(r).toMatchObject({ ok: true });
    expect(writes).not.toHaveBeenCalled();
    expect(await credentialStore.loadBinding()).toBeNull();
    expect(await sessionCache.load()).toBeNull();
  });
  it('signInWithGoogle: a failed sign-in passes through untouched with no bootstrap; a bootstrap 5xx / 400 is not_gdrive, a 401 credential_rejected, no response network', async () => {
    let bootstraps = 0;
    for (const category of ['sign_in_cancelled', 'network', 'credential_rejected'] as const) {
      expect(await signInWithGoogle({ signIn: async () => ({ ok: false, category, detail: 'd' }), bootstrap: async () => { bootstraps += 1; throw new Error('unreachable'); } }))
        .toEqual({ ok: false, category, detail: 'd' });
    }
    expect(bootstraps).toBe(0);
    for (const [status, expected] of [[500, 'not_gdrive'], [503, 'not_gdrive'], [400, 'not_gdrive'], [401, 'credential_rejected']] as const) {
      const drive = createFakeDrive({ emptyLayout: true });
      drive.failNext(status);
      expect(await signInWithGoogle({ signIn: okSignIn(), bootstrap: () => bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken()) })).toMatchObject({ ok: false, category: expected });
    }
    const offline = await signInWithGoogle({ signIn: okSignIn(), bootstrap: () => bootstrapGoogleDriveLayout(async () => { throw new TypeError('Network request failed'); }, 'ya29.x') });
    expect(offline).toMatchObject({ ok: false, category: 'network' });
  });

  it('probeGdrive: ensureLayout then meta GET — empty → empty; v2 encrypted → existing-encrypted; store failures map with the Drive vocabulary', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'gdrive' });
    expect(await probeGdrive(SOURCE, { createStore: () => store })).toEqual({ kind: 'empty' });
    expect(store.calls.map((c) => c.op)).toEqual(['ensureLayout', 'get']);
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    expect(await probeGdrive(SOURCE, { createStore: () => store })).toEqual({ kind: 'existing-encrypted', meta });
    for (const [status, category, message, expected] of [[401, 'auth', 'x', 'credential_rejected'], [401, 'auth', 'reauth_required: revoked', 'reauth_required'], [0, 'network', 'x', 'network'], [0, 'rate_limited', 'x', 'network'], [404, 'client', 'app folder missing', 'not_gdrive'], [500, 'server', 'x', 'not_gdrive']] as const) {
      const failing: CloudObjectStore = { ...store, ensureLayout: async () => { throw new CloudStoreError(status, category, message); } };
      expect(await probeGdrive(SOURCE, { createStore: () => failing })).toMatchObject({ kind: 'error', category: expected });
    }
    const tooNew = createMemoryCloudObjectStore({ kind: 'gdrive' });
    await tooNew.put('vault-meta.json', encoder.encode(JSON.stringify({ ...meta, protocolVersion: 3 })), 'application/json');
    expect(await probeGdrive(SOURCE, { createStore: () => tooNew })).toMatchObject({ kind: 'error', category: 'meta_corrupt' });
  });
  it('probeGdrive over a REAL Drive adapter: actual plaintext vault-meta bytes in the Waifu Deck folder are meta_corrupt/unencrypted_store_vault (spec §6), never existing-plain', async () => {
    const drive = createFakeDrive();
    const { meta: plainMeta } = await buildVaultMeta(null, 'none', undefined, 2);
    const plainBytes = encoder.encode(JSON.stringify(plainMeta));
    // The bytes are a VALID plaintext meta — so the refusal below is the encryption rule, not a parse failure.
    expect(parseVaultMeta(decoder.decode(plainBytes), 2)).toMatchObject({ encryption: 'none', protocolVersion: 2 });
    await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', plainBytes);
    const source: GdriveSource = { binding: { ...BINDING, ...drive.ids }, accessToken: null, expiresAt: 0 };
    expect(await probeGdrive(source, { createStore: () => realDriveStore(drive) })).toEqual({ kind: 'error', category: 'meta_corrupt', detail: 'unencrypted_store_vault' });
    // And a caller that hands connectGdrive that meta directly still cannot join it.
    const s = stores();
    expect(await connectGdrive({ source, probe: { kind: 'existing-plain', meta: plainMeta }, password: 'pw' }, { createStore: () => realDriveStore(drive), ...s }))
      .toEqual({ ok: false, category: 'meta_corrupt', detail: 'unencrypted_store_vault' });
    expect(await connectGdrive({ source, probe: { kind: 'existing-encrypted', meta: plainMeta }, password: 'pw' }, { createStore: () => realDriveStore(drive), ...s }))
      .toEqual({ ok: false, category: 'meta_corrupt', detail: 'unencrypted_store_vault' });
    expect(await s.credentialStore.loadBinding()).toBeNull();
    expect(await s.sessionCache.load()).toBeNull();
  });
  it('end to end over the fake Drive: sign in → probe empty → connect creates a v2 aes-gcm vault-meta.json in the Waifu Deck folder → a second probe sees existing-encrypted and joins with the password', async () => {
    const drive = createFakeDrive({ emptyLayout: true });
    const signedIn = await signInWithGoogle({ signIn: okSignIn('1//RT-e2e'), bootstrap: () => bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken()) });
    if (!signedIn.ok) throw new Error(signedIn.category);
    const createStore = (source: GdriveSource) => realDriveStore(drive, source.binding);
    expect(await probeGdrive(signedIn.source, { createStore })).toEqual({ kind: 'empty' });
    const { credentialStore, sessionCache } = stores();
    const created = await connectGdrive({ source: signedIn.source, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw' }, { createStore, credentialStore, sessionCache });
    expect(created).toMatchObject({ ok: true, encryption: 'aes-gcm' });
    const written = parseVaultMeta(decoder.decode(drive.fileBytes(signedIn.source.binding.rootFolderId, 'vault-meta.json')!), 2);
    expect(written).toMatchObject({ protocolVersion: 2, encryption: 'aes-gcm' });
    expect(await credentialStore.loadBinding()).toEqual(signedIn.source.binding);
    expect(await sessionCache.load()).toMatchObject({ vaultId: written.vaultId, encryption: 'aes-gcm', masterKeyB64: expect.any(String) });

    const probed = await probeGdrive(signedIn.source, { createStore });
    expect(probed).toEqual({ kind: 'existing-encrypted', meta: written });
    const joined = await connectGdrive({ source: signedIn.source, probe: probed as ConnectableProbe, password: 'pw' }, { createStore, ...stores() });
    expect(joined).toEqual({ ok: true, vaultId: written.vaultId, encryption: 'aes-gcm' });
  });
  it('connectGdrive (empty): validates the password pair, creates a v2 aes-gcm vault, persists the source binding (Google does not rotate, so nothing to reconcile) and the session', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'gdrive' });
    const { credentialStore, sessionCache } = stores();
    const r = await connectGdrive({ source: SOURCE, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw' }, { createStore: () => store, credentialStore, sessionCache });
    expect(r).toMatchObject({ ok: true, encryption: 'aes-gcm' });
    expect(await credentialStore.loadBinding()).toEqual(BINDING);
    const written = parseVaultMeta(decoder.decode(store.objects().get('vault-meta.json')!), 2);
    expect(written).toMatchObject({ protocolVersion: 2, encryption: 'aes-gcm' });
    expect(await sessionCache.load()).toMatchObject({ vaultId: written.vaultId, encryption: 'aes-gcm' });
  });
  it('connectGdrive: a wrong password, an empty password, or a mismatched confirmation persists nothing and writes nothing to Drive', async () => {
    const store = createMemoryCloudObjectStore({ kind: 'gdrive' });
    const { meta } = await buildVaultMeta('pw', 'aes-gcm', undefined, 2);
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(meta)), 'application/json');
    const s = stores();
    expect(await connectGdrive({ source: SOURCE, probe: { kind: 'existing-encrypted', meta }, password: 'nope' }, { createStore: () => store, ...s })).toMatchObject({ ok: false, category: 'wrong_password' });
    const empty = createMemoryCloudObjectStore({ kind: 'gdrive' });
    expect(await connectGdrive({ source: SOURCE, probe: { kind: 'empty' }, password: 'a', passwordConfirm: 'b' }, { createStore: () => empty, ...s })).toEqual({ ok: false, category: 'password_mismatch', detail: 'confirmation_mismatch' });
    expect(await connectGdrive({ source: SOURCE, probe: { kind: 'empty' }, password: '', passwordConfirm: '' }, { createStore: () => empty, ...s })).toEqual({ ok: false, category: 'password_mismatch', detail: 'password_required' });
    expect(empty.objects().size).toBe(0);
    expect(await s.credentialStore.loadBinding()).toBeNull();
    expect(await s.sessionCache.load()).toBeNull();
  });
  it('probeGdrive / connectGdrive with no createStore: the production Drive store gets the binding AND the sign-in\'s access token as its seed (no needless refresh before the binding exists)', async () => {
    const factory = createProductionGoogleDriveStore as jest.Mock;
    factory.mockClear();
    factory.mockReturnValue(createMemoryCloudObjectStore({ kind: 'gdrive' }));
    await probeGdrive(SOURCE);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(BINDING, { accessToken: 'ya29.AT', expiresAt: SOURCE.expiresAt });

    factory.mockClear();
    factory.mockReturnValue(createMemoryCloudObjectStore({ kind: 'gdrive' }));
    const r = await connectGdrive({ source: { binding: BINDING, accessToken: null, expiresAt: 0 }, probe: { kind: 'empty' }, password: 'pw', passwordConfirm: 'pw' }, stores());
    expect(r).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledWith(BINDING, { accessToken: undefined, expiresAt: 0 });
  });

  it('reauthGdrive: replaces ONLY the refresh token of the stored gdrive binding (folder ids, e-mail, password session untouched)', async () => {
    const drive = createFakeDrive();
    const stored: GoogleDriveBinding = { ...BINDING, ...drive.ids, accountEmail: drive.accountEmail, refreshToken: '1//RT-dead' };
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding(stored);
    await sessionCache.save({ masterKeyB64: 'MASTER-KEY-UNTOUCHED', vaultId: 'v', encryption: 'aes-gcm' });
    const r = await reauthGdrive({ signIn: okSignIn('1//RT-new'), bootstrap: () => bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken()), credentialStore, sessionCache });
    expect(r).toEqual({ ok: true });
    expect(await credentialStore.loadBinding()).toEqual({ ...stored, refreshToken: '1//RT-new' });
    expect(await sessionCache.load()).toEqual({ masterKeyB64: 'MASTER-KEY-UNTOUCHED', vaultId: 'v', encryption: 'aes-gcm' });
  });
  it('reauthGdrive keeps the STORED folder ids and e-mail even when the fresh bootstrap reports different ones for the same root', async () => {
    // The fake's bootstrap would return exactly the stored values, so a reauth that
    // copied layout.ids / layout.accountEmail into the binding would still pass the
    // test above. Here only the root matches: everything else the bootstrap says
    // must be ignored, because the stored ids are what the library's objects live under.
    const stored: GoogleDriveBinding = { ...BINDING, refreshToken: '1//RT-dead' };
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding(stored);
    const r = await reauthGdrive({
      signIn: okSignIn('1//RT-new'),
      bootstrap: async () => ({ ids: { rootFolderId: stored.rootFolderId, stateFolderId: 'D-state-other', blobsFolderId: 'D-blobs-other' }, accountEmail: 'renamed@example.com' }),
      credentialStore,
      sessionCache,
    });
    expect(r).toEqual({ ok: true });
    expect(await credentialStore.loadBinding()).toEqual({ ...stored, refreshToken: '1//RT-new' });
  });
  it('reauthGdrive: a DIFFERENT Google account (its Drive bootstraps a different Waifu Deck folder id) is credential_rejected/account_mismatch and the stored binding is unchanged', async () => {
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding({ ...BINDING, refreshToken: '1//RT-dead' });
    const otherAccount = createFakeDrive();
    const other = await reauthGdrive({ signIn: okSignIn('1//RT-other'), bootstrap: () => bootstrapGoogleDriveLayout(otherAccount.fetch, otherAccount.issueAccessToken()), credentialStore, sessionCache });
    expect(other).toEqual({ ok: false, category: 'credential_rejected', detail: 'account_mismatch' });
    expect(await credentialStore.loadBinding()).toEqual({ ...BINDING, refreshToken: '1//RT-dead' });
    // Same e-mail is not enough either: identity is the folder id, not the address.
    const sameEmail = await reauthGdrive({ signIn: okSignIn('1//RT-other'), bootstrap: async () => ({ ids: { rootFolderId: 'D-other', stateFolderId: BINDING.stateFolderId, blobsFolderId: BINDING.blobsFolderId }, accountEmail: BINDING.accountEmail }), credentialStore, sessionCache });
    expect(sameEmail).toEqual({ ok: false, category: 'credential_rejected', detail: 'account_mismatch' });
    expect(await credentialStore.loadBinding()).toMatchObject({ refreshToken: '1//RT-dead' });
  });
  it('reauthGdrive: no stored binding, or a stored OneDrive / WebDAV binding, is credential_rejected/no_stored_credentials without opening a browser; a cancelled sign-in passes through with the binding unchanged', async () => {
    let signIns = 0;
    const counting = async () => { signIns += 1; return { ok: false as const, category: 'sign_in_cancelled' as const, detail: 'cancel' }; };
    expect(await reauthGdrive({ signIn: counting, ...stores() })).toEqual({ ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' });
    const onedrive = stores();
    await onedrive.credentialStore.saveBinding({ ...BINDING, kind: 'onedrive' });
    expect(await reauthGdrive({ signIn: counting, ...onedrive })).toEqual({ ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' });
    const webdav = stores();
    await webdav.credentialStore.saveBinding({ kind: 'webdav', baseUrl: 'https://dav.example.com', username: 'u', password: 'p', rootPath: '/' });
    expect(await reauthGdrive({ signIn: counting, ...webdav })).toEqual({ ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' });
    expect(signIns).toBe(0);
    const { credentialStore, sessionCache } = stores();
    await credentialStore.saveBinding({ ...BINDING, refreshToken: '1//RT-dead' });
    expect(await reauthGdrive({ signIn: counting, credentialStore, sessionCache })).toEqual({ ok: false, category: 'sign_in_cancelled', detail: 'cancel' });
    expect(await credentialStore.loadBinding()).toMatchObject({ refreshToken: '1//RT-dead' });
  });

  describe('(Task 9 spec review) a Drive client/server failure is not_gdrive — side by side with the OneDrive twins, which stay not_onedrive', () => {
    const FAILURES = [
      ['client', new CloudStoreError(400, 'client', 'x')],
      ['server', new CloudStoreError(500, 'server', 'x')],
      ['not_found', new CloudStoreError(404, 'not_found', 'x')],
      ['a non-store error', new Error('boom')],
    ] as const;
    const ONEDRIVE: OneDriveBinding = { ...BINDING, kind: 'onedrive' };
    const failingStore = (error: unknown, op: 'ensureLayout' | 'get' | 'put'): CloudObjectStore => ({
      ...createMemoryCloudObjectStore(),
      [op]: async () => { throw error; },
    });

    it.each(FAILURES)('sign-in bootstrap: %s', async (_label, error) => {
      const bootstrap = async () => { throw error; };
      expect(await signInWithGoogle({ signIn: okSignIn(), bootstrap })).toMatchObject({ ok: false, category: 'not_gdrive' });
      expect(await signInWithMicrosoft({ signIn: okSignIn(), bootstrap })).toMatchObject({ ok: false, category: 'not_onedrive' });
    });
    it.each(FAILURES)('probe (ensureLayout): %s', async (_label, error) => {
      expect(await probeGdrive(SOURCE, { createStore: () => failingStore(error, 'ensureLayout') })).toMatchObject({ kind: 'error', category: 'not_gdrive' });
      expect(await probeOneDrive({ binding: ONEDRIVE, accessToken: 'AT', expiresAt: 0 }, { createStore: () => failingStore(error, 'ensureLayout') })).toMatchObject({ kind: 'error', category: 'not_onedrive' });
    });
    it.each(FAILURES)('probe (meta GET): %s', async (_label, error) => {
      expect(await probeGdrive(SOURCE, { createStore: () => failingStore(error, 'get') })).toMatchObject({ kind: 'error', category: 'not_gdrive' });
      expect(await probeOneDrive({ binding: ONEDRIVE, accessToken: 'AT', expiresAt: 0 }, { createStore: () => failingStore(error, 'get') })).toMatchObject({ kind: 'error', category: 'not_onedrive' });
    });
    it('probe (meta parse): a vault-meta.json body that is JSON `null` throws a non-VaultMetaError inside parseVaultMeta and falls through to the provider fallback', async () => {
      const nullMeta = async () => {
        const store = createMemoryCloudObjectStore();
        await store.put('vault-meta.json', encoder.encode('null'), 'application/json');
        return store;
      };
      const gStore = await nullMeta();
      expect(await probeGdrive(SOURCE, { createStore: () => gStore })).toMatchObject({ kind: 'error', category: 'not_gdrive' });
      const oStore = await nullMeta();
      expect(await probeOneDrive({ binding: ONEDRIVE, accessToken: 'AT', expiresAt: 0 }, { createStore: () => oStore })).toMatchObject({ kind: 'error', category: 'not_onedrive' });
    });
    it.each(FAILURES)('connect (create write): %s', async (_label, error) => {
      const input = { probe: { kind: 'empty' } as const, password: 'pw', passwordConfirm: 'pw' };
      expect(await connectGdrive({ ...input, source: SOURCE }, { createStore: () => failingStore(error, 'put'), ...stores() })).toMatchObject({ ok: false, category: 'not_gdrive' });
      expect(await connectOneDrive({ ...input, source: { binding: ONEDRIVE, accessToken: 'AT', expiresAt: 0 } }, { createStore: () => failingStore(error, 'put'), ...stores() })).toMatchObject({ ok: false, category: 'not_onedrive' });
    });
    it.each(FAILURES)('reauth bootstrap: %s', async (_label, error) => {
      const bootstrap = async () => { throw error; };
      const g = stores();
      await g.credentialStore.saveBinding(BINDING);
      expect(await reauthGdrive({ signIn: okSignIn(), bootstrap, ...g })).toMatchObject({ ok: false, category: 'not_gdrive' });
      expect(await g.credentialStore.loadBinding()).toEqual(BINDING);
      const o = stores();
      await o.credentialStore.saveBinding(ONEDRIVE);
      expect(await reauthOneDrive({ signIn: okSignIn(), bootstrap, ...o })).toMatchObject({ ok: false, category: 'not_onedrive' });
    });
  });
});
