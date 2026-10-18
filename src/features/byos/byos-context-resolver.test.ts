jest.mock('@/features/cloud-store/onedrive-store-production', () => ({ createProductionOneDriveStore: jest.fn() }));
jest.mock('@/features/cloud-store/gdrive-store-production', () => ({ createProductionGoogleDriveStore: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

import { sha256 } from '@noble/hashes/sha2.js';

import { CloudStoreError, type CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import { createGoogleDriveCloudObjectStore } from '@/features/cloud-store/gdrive-cloud-object-store';
import { createProductionGoogleDriveStore } from '@/features/cloud-store/gdrive-store-production';
import { GoogleAuthError } from '@/features/cloud-store/google-oauth';
import { createGoogleTokenSource } from '@/features/cloud-store/google-token-source';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { createProductionOneDriveStore } from '@/features/cloud-store/onedrive-store-production';

import {
  resolveByosContext, resolveByosStatus,
  type ByosLockedReason, type ByosResolveDeps, type ByosResolverTransportPort, type ByosStatus,
  type ByosUnreachableDetail, type StoreBackedBinding,
} from './byos-context-resolver';
import {
  BYOS_CREDENTIALS_KEY, createByosCredentialStore,
  type ByosCredentials, type GoogleDriveBinding, type OneDriveBinding, type SecureStorePort,
} from './byos-credentials';
import type { DeviceIdStore } from './byos-device-id';
import {
  createByosSessionCache,
  type ByosSessionCache, type CachedByosSession,
} from './byos-session-cache';
import type { VaultEncryption, VaultMeta } from './byos-vault-meta';
import { S3TransportError, type S3FailureCategory } from './s3-transport-types';

const encoder = new TextEncoder();

const CREDENTIALS: ByosCredentials = {
  kind: 's3',
  endpoint: 'https://s3.example.com',
  region: 'auto',
  bucket: 'my-bucket',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  prefix: 'waifu-deck/',
};
const META_PATH = 'waifu-deck/vault-meta.json';
const DEVICE_ID = 'device-abc';

/**
 * A hand-written vault-meta rather than `buildVaultMeta`: the resolver never
 * verifies a password or runs scrypt (that is the connect flow's job), so
 * these tests stay crypto-free and each case can pin its own vaultId, which
 * the cache-mismatch cases need.
 */
function metaFor(vaultId: string, encryption: VaultEncryption): VaultMeta {
  return {
    format: 'waifu-deck-byos',
    protocolVersion: 1,
    encryption,
    vaultId,
    kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA==' },
    keyCheckB64: encryption === 'aes-gcm' ? 'a2V5Q2hlY2s=' : '',
    createdAt: '2026-08-30T00:00:00.000Z',
  };
}

/** A store-backed (append protocol 2) vault-meta — P12-B webdav, P12-C onedrive. */
const v2meta = (id: string, encryption: VaultEncryption = 'aes-gcm') => ({ ...metaFor(id, encryption), protocolVersion: 2 });

function memoryPort(): SecureStorePort {
  const map = new Map<string, string>();
  return {
    getItemAsync: async (k) => map.get(k) ?? null,
    setItemAsync: async (k, v) => { map.set(k, v); },
    deleteItemAsync: async (k) => { map.delete(k); },
  };
}

function fakeTransport(objects: Record<string, string>) {
  const reads: string[] = [];
  const port: ByosResolverTransportPort = {
    async getObject(key) {
      reads.push(key);
      const body = objects[key];
      return body === undefined ? null : { body: encoder.encode(body), etag: 'e0' };
    },
  };
  return { port, reads };
}

function throwingTransport(error: unknown) {
  const reads: string[] = [];
  const port: ByosResolverTransportPort = {
    async getObject(key) {
      reads.push(key);
      throw error;
    },
  };
  return { port, reads };
}

const deviceIdStore: DeviceIdStore = {
  async get() { return DEVICE_ID; },
  async reset() { /* unused by the resolver */ },
};

type HarnessOptions = {
  credentials?: ByosCredentials | null;
  /** Bucket contents by full key; absent META_PATH models a wiped bucket. */
  objects?: Record<string, string>;
  transportError?: unknown;
  session?: CachedByosSession | null;
  sessionCache?: ByosSessionCache;
};

async function harness(options: HarnessOptions = {}) {
  const port = memoryPort();
  const credentialStore = createByosCredentialStore(port);
  if (options.credentials !== null) {
    await credentialStore.save(options.credentials ?? CREDENTIALS);
  }
  const sessionCache = options.sessionCache ?? createByosSessionCache(port);
  if (options.session) await sessionCache.save(options.session);

  const transport = options.transportError !== undefined
    ? throwingTransport(options.transportError)
    : fakeTransport(options.objects ?? {});
  let transportBuilds = 0;

  const deps: ByosResolveDeps = {
    credentialStore,
    sessionCache,
    deviceIdStore,
    createTransport: () => {
      transportBuilds += 1;
      return transport.port;
    },
  };
  return {
    deps,
    sessionCache,
    reads: transport.reads,
    builds: () => transportBuilds,
  };
}

function bucketWith(meta: VaultMeta): Record<string, string> {
  return { [META_PATH]: JSON.stringify(meta) };
}

describe('resolveByosStatus — unconfigured', () => {
  it('reports unconfigured and touches no network when no credentials are stored', async () => {
    const h = await harness({ credentials: null });

    expect(await resolveByosStatus(h.deps)).toEqual({ status: 'unconfigured' });
    expect(h.builds()).toBe(0);
    expect(h.reads).toEqual([]);
  });
});

describe('resolveByosStatus — vault_unreachable', () => {
  const cases: readonly [S3FailureCategory, number, string][] = [
    ['network', 0, 'network'],
    ['rate_limited', 503, 'network'],
    ['credential', 403, 'credential_rejected'],
    ['client', 400, 'not_s3'],
  ];

  it.each(cases)(
    'maps a %s transport failure on the meta GET to detail %s',
    async (category, status, detail) => {
      const h = await harness({
        transportError: new S3TransportError(status, category, 'boom'),
      });

      expect(await resolveByosStatus(h.deps)).toEqual({
        status: 'locked', reason: 'vault_unreachable', detail,
      });
    },
  );

  it('treats a non-transport throw (e.g. an unparseable stored endpoint) as not_s3', async () => {
    const h = await harness({ transportError: new TypeError('Invalid URL') });

    expect(await resolveByosStatus(h.deps)).toEqual({
      status: 'locked', reason: 'vault_unreachable', detail: 'not_s3',
    });
  });
});

describe('resolveByosStatus — meta_corrupt', () => {
  it('reports meta_absent when the bucket answers but has no vault-meta', async () => {
    const h = await harness({ objects: {} });

    expect(await resolveByosStatus(h.deps)).toEqual({
      status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent',
    });
    expect(h.reads).toEqual([META_PATH]);
  });

  it('reports malformed when vault-meta cannot be parsed', async () => {
    const h = await harness({ objects: { [META_PATH]: '{ not json' } });

    expect(await resolveByosStatus(h.deps)).toEqual({
      status: 'locked', reason: 'meta_corrupt', detail: 'malformed',
    });
  });

  it('reports unsupported-version when the vault is newer than this app', async () => {
    const meta = { ...metaFor('v1', 'aes-gcm'), protocolVersion: 99 };
    const h = await harness({ objects: bucketWith(meta) });

    expect(await resolveByosStatus(h.deps)).toEqual({
      status: 'locked', reason: 'meta_corrupt', detail: 'unsupported-version',
    });
  });
});

describe('resolveByosStatus — ready', () => {
  it('assembles the context from a matching cached session (aes-gcm)', async () => {
    const meta = metaFor('vault-1', 'aes-gcm');
    const masterKey = new Uint8Array(32).fill(7);
    const h = await harness({
      objects: bucketWith(meta),
      session: {
        masterKeyB64: Buffer.from(masterKey).toString('base64'),
        vaultId: 'vault-1',
        encryption: 'aes-gcm',
      },
    });

    const result = await resolveByosStatus(h.deps);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.context).toMatchObject({ kind: 's3', credentials: CREDENTIALS });
    expect(result.context.meta).toEqual(meta);
    expect(result.context.deviceId).toBe(DEVICE_ID);
    expect(Array.from(result.context.masterKey ?? [])).toEqual(Array.from(masterKey));
  });

  it('still performs the meta GET on a cache hit — liveness is the lock check', async () => {
    const meta = metaFor('vault-1', 'aes-gcm');
    const h = await harness({
      objects: bucketWith(meta),
      session: { masterKeyB64: 'AAAA', vaultId: 'vault-1', encryption: 'aes-gcm' },
    });

    await resolveByosStatus(h.deps);

    expect(h.builds()).toBe(1);
    expect(h.reads).toEqual([META_PATH]);
  });

  it('derives the decision #21 pseudo key for a none vault and backfills the cache', async () => {
    const meta = metaFor('vault-none', 'none');
    const h = await harness({ objects: bucketWith(meta) });

    const result = await resolveByosStatus(h.deps);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    // sha256(utf8('vault-none')) — the same digest library-session-port
    // derives, so identity/scope stay stable with encryption off.
    expect(result.context.masterKey).toEqual(sha256(encoder.encode('vault-none')));
    expect(await h.sessionCache.load()).toEqual({
      masterKeyB64: null, vaultId: 'vault-none', encryption: 'none',
    });
  });

  it('stays ready when the none-vault cache backfill fails', async () => {
    const failing: ByosSessionCache = {
      async load() { return null; },
      async save() { throw new Error('SecureStore unavailable'); },
      async clear() { /* unused */ },
    };
    const h = await harness({
      objects: bucketWith(metaFor('vault-none', 'none')),
      sessionCache: failing,
    });

    expect((await resolveByosStatus(h.deps)).status).toBe('ready');
  });
});

describe('resolveByosStatus — password_required', () => {
  it('locks when an encrypted vault has no cached session', async () => {
    const h = await harness({ objects: bucketWith(metaFor('vault-1', 'aes-gcm')) });

    expect(await resolveByosStatus(h.deps)).toEqual({
      status: 'locked', reason: 'password_required',
    });
  });

  it('locks when the cached session belongs to a different vault', async () => {
    const h = await harness({
      objects: bucketWith(metaFor('vault-2', 'aes-gcm')),
      session: { masterKeyB64: 'AAAA', vaultId: 'vault-1', encryption: 'aes-gcm' },
    });

    expect(await resolveByosStatus(h.deps)).toEqual({
      status: 'locked', reason: 'password_required',
    });
  });
});

describe('resolveByosContext', () => {
  it('returns the context when the status is ready', async () => {
    const h = await harness({ objects: bucketWith(metaFor('vault-none', 'none')) });

    const context = await resolveByosContext(h.deps);

    expect(context?.deviceId).toBe(DEVICE_ID);
    expect(context?.meta.vaultId).toBe('vault-none');
  });

  it('returns null for every non-ready status', async () => {
    const locked = await harness({ objects: bucketWith(metaFor('v', 'aes-gcm')) });
    const unconfigured = await harness({ credentials: null });

    expect(await resolveByosContext(locked.deps)).toBeNull();
    expect(await resolveByosContext(unconfigured.deps)).toBeNull();
  });
});

describe('board #12 — binding kinds', () => {
  it('an s3 binding resolves exactly as before (regression pin)', async () => {
    const h = await harness({ objects: bucketWith(metaFor('vault-none', 'none')) });
    const status = await resolveByosStatus(h.deps);
    expect(status.status).toBe('ready');
  });

  it('a non-S3 binding performs no network call (no transport is built)', async () => {
    const port = memoryPort();
    await createByosCredentialStore(port).saveBinding({ kind: 'gdrive', refreshToken: 'r', accountEmail: 'a@b', rootFolderId: 'x', stateFolderId: 'y', blobsFolderId: 'z' });
    let builds = 0;
    await resolveByosStatus({ credentialStore: createByosCredentialStore(port), createTransport: () => { builds += 1; throw new Error('must not be called'); } });
    expect(builds).toBe(0);
  });
});

describe('board #12 — pre-#12 stored S3 JSON (the real upgrade path)', () => {
  it('a legacy credentials JSON with no `kind` resolves to ready and is read without being rewritten', async () => {
    // Written by the pre-#12 `save()`, which knew nothing of `kind`. Bypasses
    // the store's `save()` on purpose: today's `save()` stamps `kind: 's3'`,
    // so going through it would not exercise the upgrade read at all.
    const legacyJson = {
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'my-bucket',
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
      prefix: 'waifu-deck/',
    };
    const port = memoryPort();
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, JSON.stringify(legacyJson));
    const transport = fakeTransport(bucketWith(metaFor('vault-none', 'none')));

    const status = await resolveByosStatus({
      credentialStore: createByosCredentialStore(port),
      sessionCache: createByosSessionCache(port),
      deviceIdStore,
      createTransport: () => transport.port,
    });

    expect(status.status).toBe('ready');
    if (status.status !== 'ready') throw new Error('unreachable');
    expect(status.context).toMatchObject({ kind: 's3', credentials: { ...legacyJson, kind: 's3' } });
    expect(status.context.deviceId).toBe(DEVICE_ID);
    expect(transport.reads).toEqual([META_PATH]);
    // Zero-migration promise (byos-credentials.ts): reading the old shape
    // never rewrites it.
    expect(JSON.parse((await port.getItemAsync(BYOS_CREDENTIALS_KEY))!)).toEqual(legacyJson);
  });
});

describe('resolveByosStatus — webdav binding (P12-B)', () => {
  const WEBDAV = { kind: 'webdav' as const, baseUrl: 'https://dav.example', username: 'u', password: 'p', rootPath: '/' };

  async function webdavHarness(objects: Record<string, string>, session?: CachedByosSession, storeError?: CloudStoreError) {
    const port = memoryPort();
    await createByosCredentialStore(port).saveBinding(WEBDAV);
    const sessionCache = createByosSessionCache(port);
    if (session) await sessionCache.save(session);
    const store = createMemoryCloudObjectStore();
    for (const [k, v] of Object.entries(objects)) await store.put(k, encoder.encode(v), 'application/json');
    const failing: CloudObjectStore = { ...store, async get() { throw storeError; } };
    let builds = 0;
    const deps: ByosResolveDeps = {
      credentialStore: createByosCredentialStore(port),
      sessionCache,
      deviceIdStore,
      createStore: () => { builds += 1; return storeError ? failing : store; },
      createTransport: () => { throw new Error('S3 transport must not be built for a webdav binding'); },
    };
    return { deps, store, builds: () => builds };
  }

  it('ready: a cached session for the store vault yields a kind:store context carrying the binding, the store and the key', async () => {
    const key = new Uint8Array(32).fill(9);
    const h = await webdavHarness({ 'vault-meta.json': JSON.stringify(v2meta('vw')) }, { masterKeyB64: Buffer.from(key).toString('base64'), vaultId: 'vw', encryption: 'aes-gcm' });
    const r = await resolveByosStatus(h.deps);
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') throw new Error('unreachable');
    expect(r.context).toMatchObject({ kind: 'store', binding: WEBDAV, deviceId: DEVICE_ID });
    expect(r.context.kind === 'store' && r.context.store).toBe(h.store);
    expect(Array.from(r.context.masterKey ?? [])).toEqual(Array.from(key));
    expect(h.builds()).toBe(1);
  });
  it('locks password_required without a cached session, and when the cached session is for another vault', async () => {
    const h1 = await webdavHarness({ 'vault-meta.json': JSON.stringify(v2meta('vw')) });
    expect(await resolveByosStatus(h1.deps)).toEqual({ status: 'locked', reason: 'password_required' });
    const h2 = await webdavHarness({ 'vault-meta.json': JSON.stringify(v2meta('vw')) }, { masterKeyB64: 'AAAA', vaultId: 'other', encryption: 'aes-gcm' });
    expect(await resolveByosStatus(h2.deps)).toEqual({ status: 'locked', reason: 'password_required' });
  });
  it('locks meta_corrupt/meta_absent when the store has no vault-meta', async () => {
    const h = await webdavHarness({});
    expect(await resolveByosStatus(h.deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' });
  });
  it('an unencrypted vault-meta on a store binding is malformed (spec §6), never ready', async () => {
    const h = await webdavHarness({ 'vault-meta.json': JSON.stringify(v2meta('vw', 'none')) }, { masterKeyB64: null, vaultId: 'vw', encryption: 'none' });
    expect(await resolveByosStatus(h.deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'malformed' });
  });
  it('a protocolVersion-1 vault-meta on a store binding is malformed (the S3 layout), a newer one unsupported-version', async () => {
    const v1 = await webdavHarness({ 'vault-meta.json': JSON.stringify(metaFor('vw', 'aes-gcm')) }, { masterKeyB64: 'AAAA', vaultId: 'vw', encryption: 'aes-gcm' });
    expect(await resolveByosStatus(v1.deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'malformed' });
    const v9 = await webdavHarness({ 'vault-meta.json': JSON.stringify({ ...v2meta('vw'), protocolVersion: 9 }) });
    expect(await resolveByosStatus(v9.deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'unsupported-version' });
  });
  // N9: webdav auth locks network (暂时连不上), not credential_rejected.
  it.each([['network', 'network'], ['rate_limited', 'network'], ['auth', 'network'], ['server', 'not_webdav'], ['client', 'not_webdav']] as const)(
    'a %s store failure on the meta GET locks vault_unreachable/%s', async (category, detail) => {
      const h = await webdavHarness({}, undefined, new CloudStoreError(500, category, 'boom'));
      expect(await resolveByosStatus(h.deps)).toEqual({ status: 'locked', reason: 'vault_unreachable', detail });
    });
  it('builds exactly one store per resolve and no S3 transport (the harness makes createTransport throw)', async () => {
    const h = await webdavHarness({});
    await resolveByosStatus(h.deps);
    expect(h.builds()).toBe(1);
  });
  it('a store factory that throws (e.g. a corrupt stored baseUrl) locks vault_unreachable/not_webdav instead of escaping', async () => {
    const h = await webdavHarness({});
    const deps: ByosResolveDeps = { ...h.deps, createStore: () => { throw new TypeError('Invalid URL'); } };
    expect(await resolveByosStatus(deps)).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'not_webdav' });
  });
});

const ONEDRIVE: OneDriveBinding = { kind: 'onedrive', refreshToken: 'RT-stored', accountEmail: 'o@example.com', rootFolderId: 'F0001', stateFolderId: 'F0002', blobsFolderId: 'F0003' };

describe('resolveByosStatus — onedrive binding (board #12 P12-C)', () => {
  async function onedriveHarness(objects: Record<string, string>, session?: CachedByosSession, storeError?: CloudStoreError) {
    const port = memoryPort();
    await createByosCredentialStore(port).saveBinding(ONEDRIVE);
    const sessionCache = createByosSessionCache(port);
    if (session) await sessionCache.save(session);
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    for (const [k, v] of Object.entries(objects)) await store.put(k, encoder.encode(v), 'application/json');
    const failing: CloudObjectStore = { ...store, async get() { throw storeError; } };
    const seen: StoreBackedBinding[] = [];
    const deps: ByosResolveDeps = {
      credentialStore: createByosCredentialStore(port), sessionCache, deviceIdStore,
      createStore: (binding) => { seen.push(binding); return storeError ? failing : store; },
      createTransport: () => { throw new Error('S3 transport must not be built for a onedrive binding'); },
    };
    return { deps, store, seen };
  }

  it('ready: a cached session for the store vault yields a kind:store context carrying the onedrive binding and the store', async () => {
    const key = new Uint8Array(32).fill(5);
    const h = await onedriveHarness({ 'vault-meta.json': JSON.stringify(v2meta('vo')) }, { masterKeyB64: Buffer.from(key).toString('base64'), vaultId: 'vo', encryption: 'aes-gcm' });
    const r = await resolveByosStatus(h.deps);
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') throw new Error('unreachable');
    expect(r.context).toMatchObject({ kind: 'store', binding: ONEDRIVE, deviceId: DEVICE_ID });
    expect(r.context.kind === 'store' && r.context.store).toBe(h.store);
    expect(h.seen).toEqual([ONEDRIVE]);
  });
  it('locks password_required without a session, meta_corrupt/meta_absent without a meta, malformed for v1 or unencrypted metas', async () => {
    expect(await resolveByosStatus((await onedriveHarness({ 'vault-meta.json': JSON.stringify(v2meta('vo')) })).deps)).toEqual({ status: 'locked', reason: 'password_required' });
    expect(await resolveByosStatus((await onedriveHarness({})).deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' });
    expect(await resolveByosStatus((await onedriveHarness({ 'vault-meta.json': JSON.stringify(metaFor('vo', 'aes-gcm')) })).deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'malformed' });
  });
  it.each([
    ['network', 'x', 'network'], ['rate_limited', 'x', 'network'], ['auth', 'x', 'credential_rejected'],
    ['auth', 'reauth_required: AADSTS70000 revoked', 'reauth_required'], ['server', 'x', 'not_onedrive'], ['client', 'x', 'not_onedrive'],
  ] as const)('a %s store failure ("%s") on the meta GET locks vault_unreachable/%s', async (category, message, detail) => {
    const h = await onedriveHarness({}, undefined, new CloudStoreError(500, category, message));
    expect(await resolveByosStatus(h.deps)).toEqual(detail === 'reauth_required'
      ? { status: 'locked', reason: 'vault_unreachable', detail, provider: 'onedrive' }
      : { status: 'locked', reason: 'vault_unreachable', detail });
  });
  it('a store factory that throws locks vault_unreachable/not_onedrive', async () => {
    const h = await onedriveHarness({});
    expect(await resolveByosStatus({ ...h.deps, createStore: () => { throw new TypeError('bad ids'); } })).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'not_onedrive' });
  });
});

const GDRIVE: GoogleDriveBinding = { kind: 'gdrive', refreshToken: 'RT-google', accountEmail: 'g@example.com', rootFolderId: 'G-root', stateFolderId: 'G-state', blobsFolderId: 'G-blobs' };

describe('resolveByosStatus — gdrive binding (board #12 P12-D)', () => {
  // The same harness shape as the onedrive block: the store branch is meant to
  // be kind-agnostic, so the gdrive assertions are the onedrive ones retargeted.
  async function gdriveHarness(objects: Record<string, string>, session?: CachedByosSession, storeError?: unknown) {
    const port = memoryPort();
    await createByosCredentialStore(port).saveBinding(GDRIVE);
    const sessionCache = createByosSessionCache(port);
    if (session) await sessionCache.save(session);
    const store = createMemoryCloudObjectStore({ kind: 'gdrive' });
    for (const [k, v] of Object.entries(objects)) await store.put(k, encoder.encode(v), 'application/json');
    const failing: CloudObjectStore = { ...store, async get() { throw storeError; } };
    const seen: StoreBackedBinding[] = [];
    const deps: ByosResolveDeps = {
      credentialStore: createByosCredentialStore(port), sessionCache, deviceIdStore,
      createStore: (binding) => { seen.push(binding); return storeError === undefined ? store : failing; },
      createTransport: () => { throw new Error('S3 transport must not be built for a gdrive binding'); },
    };
    return { deps, store, seen };
  }

  it('ready: a cached session for the store vault yields a kind:store context carrying the gdrive binding, the store, the key and the deviceId', async () => {
    const key = new Uint8Array(32).fill(3);
    const h = await gdriveHarness({ 'vault-meta.json': JSON.stringify(v2meta('vg')) }, { masterKeyB64: Buffer.from(key).toString('base64'), vaultId: 'vg', encryption: 'aes-gcm' });
    const r = await resolveByosStatus(h.deps);
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') throw new Error('unreachable');
    expect(r.context).toMatchObject({ kind: 'store', binding: GDRIVE, deviceId: DEVICE_ID });
    expect(r.context.meta.vaultId).toBe('vg');
    expect(r.context.kind === 'store' && r.context.store).toBe(h.store);
    expect(Array.from(r.context.masterKey ?? [])).toEqual(Array.from(key));
    expect(h.seen).toEqual([GDRIVE]);
  });
  it('locks password_required without a session or with another vault\'s session, meta_corrupt/meta_absent without a meta, malformed for v1 or unencrypted metas', async () => {
    expect(await resolveByosStatus((await gdriveHarness({ 'vault-meta.json': JSON.stringify(v2meta('vg')) })).deps)).toEqual({ status: 'locked', reason: 'password_required' });
    expect(await resolveByosStatus((await gdriveHarness({ 'vault-meta.json': JSON.stringify(v2meta('vg')) }, { masterKeyB64: 'AAAA', vaultId: 'other', encryption: 'aes-gcm' })).deps)).toEqual({ status: 'locked', reason: 'password_required' });
    expect(await resolveByosStatus((await gdriveHarness({})).deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' });
    expect(await resolveByosStatus((await gdriveHarness({ 'vault-meta.json': JSON.stringify(metaFor('vg', 'aes-gcm')) }, { masterKeyB64: 'AAAA', vaultId: 'vg', encryption: 'aes-gcm' })).deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'malformed' });
    expect(await resolveByosStatus((await gdriveHarness({ 'vault-meta.json': JSON.stringify(v2meta('vg', 'none')) }, { masterKeyB64: null, vaultId: 'vg', encryption: 'none' })).deps)).toEqual({ status: 'locked', reason: 'meta_corrupt', detail: 'malformed' });
  });
  it.each([
    ['network', 'x', 'network'], ['rate_limited', 'x', 'network'], ['auth', 'x', 'credential_rejected'],
    ['auth', 'reauth_required: invalid_grant', 'reauth_required'], ['server', 'x', 'not_gdrive'], ['client', 'x', 'not_gdrive'],
  ] as const)('a %s store failure ("%s") on the meta GET locks vault_unreachable/%s', async (category, message, detail) => {
    const h = await gdriveHarness({}, undefined, new CloudStoreError(500, category, message));
    expect(await resolveByosStatus(h.deps)).toEqual(detail === 'reauth_required'
      ? { status: 'locked', reason: 'vault_unreachable', detail, provider: 'gdrive' }
      : { status: 'locked', reason: 'vault_unreachable', detail });
  });
  it('a store factory that throws locks vault_unreachable/not_gdrive', async () => {
    const h = await gdriveHarness({});
    expect(await resolveByosStatus({ ...h.deps, createStore: () => { throw new TypeError('bad ids'); } })).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'not_gdrive' });
  });
  it('the same client failure reads not_gdrive for a gdrive binding and not_onedrive for a onedrive one (side by side, so a copy-paste cannot cross them)', async () => {
    const failure = () => new CloudStoreError(400, 'client', 'bad request');
    const onPort = memoryPort();
    await createByosCredentialStore(onPort).saveBinding(ONEDRIVE);
    const gPort = memoryPort();
    await createByosCredentialStore(gPort).saveBinding(GDRIVE);
    const failingStore = (): CloudObjectStore => ({ ...createMemoryCloudObjectStore(), async get() { throw failure(); } });
    const onedrive = await resolveByosStatus({ credentialStore: createByosCredentialStore(onPort), sessionCache: createByosSessionCache(onPort), deviceIdStore, createStore: failingStore });
    const gdrive = await resolveByosStatus({ credentialStore: createByosCredentialStore(gPort), sessionCache: createByosSessionCache(gPort), deviceIdStore, createStore: failingStore });
    expect(onedrive).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'not_onedrive' });
    expect(gdrive).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'not_gdrive' });
  });
  it('reauth_required: the real Drive store over the real Google token source, whose refresh answers invalid_grant, locks vault_unreachable/reauth_required (no password lock)', async () => {
    // The Task 3 error end to end: the token source turns GoogleAuthError
    // invalid_grant into CloudStoreError('auth', 'reauth_required: …'), and the
    // adapter's meta GET surfaces it before any Drive request is sent.
    const driveFetch = jest.fn();
    const tokens = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: GDRIVE.refreshToken, expiresAt: 0 },
      refresh: async () => { throw new GoogleAuthError('Token endpoint 400: invalid_grant Token has been expired or revoked.', 'invalid_grant'); },
    });
    const store = createGoogleDriveCloudObjectStore(GDRIVE, {
      tokens, fetchImpl: driveFetch, uploadFile: jest.fn(), statFile: async () => null,
    });
    const h = await gdriveHarness({}, { masterKeyB64: 'AAAA', vaultId: 'vg', encryption: 'aes-gcm' });
    const status = await resolveByosStatus({ ...h.deps, createStore: () => store });
    expect(status).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' });
    expect(driveFetch).not.toHaveBeenCalled();
  });
  it('the reauth_required lock names the provider that is bound — gdrive for a Drive binding, onedrive for a OneDrive one (side by side; P12-D Task 11: the settings row offers that provider\'s sign-in)', async () => {
    const revoked = () => new CloudStoreError(401, 'auth', 'reauth_required: revoked');
    const failingStore = (): CloudObjectStore => ({ ...createMemoryCloudObjectStore(), async get() { throw revoked(); } });
    const onPort = memoryPort();
    await createByosCredentialStore(onPort).saveBinding(ONEDRIVE);
    const gPort = memoryPort();
    await createByosCredentialStore(gPort).saveBinding(GDRIVE);
    const onedrive = await resolveByosStatus({ credentialStore: createByosCredentialStore(onPort), sessionCache: createByosSessionCache(onPort), deviceIdStore, createStore: failingStore });
    const gdrive = await resolveByosStatus({ credentialStore: createByosCredentialStore(gPort), sessionCache: createByosSessionCache(gPort), deviceIdStore, createStore: failingStore });
    expect(onedrive).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' });
    expect(gdrive).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' });
  });
  it('a WebDAV server has no sign-in to redo: an auth failure whose message happens to say reauth_required still locks network (N9), never a provider-less re-sign-in lock', async () => {
    const port = memoryPort();
    await createByosCredentialStore(port).saveBinding({ kind: 'webdav', baseUrl: 'https://dav.example.com', username: 'u', password: 'p', rootPath: '/' });
    const store: CloudObjectStore = { ...createMemoryCloudObjectStore(), async get() { throw new CloudStoreError(401, 'auth', 'reauth_required: x'); } };
    expect(await resolveByosStatus({ credentialStore: createByosCredentialStore(port), sessionCache: createByosSessionCache(port), deviceIdStore, createStore: () => store }))
      .toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'network' });
  });
  it('type level: a reauth_required lock must name its sign-in provider, and only a sign-in provider', () => {
    // @ts-expect-error the settings row cannot offer a sign-in without knowing whose
    const bare: ByosStatus = { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required' };
    // @ts-expect-error WebDAV has no sign-in
    const webdav: ByosStatus = { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'webdav' };
    const named: ByosStatus = { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' };
    expect([bare.status, webdav.status, named.status]).toEqual(['locked', 'locked', 'locked']);
  });
});

describe('board #12 — backend_unavailable is deleted (P12-D Task 9)', () => {
  it('type level: no status, lock reason or detail can name backend_unavailable; not_gdrive is an unreachable detail', () => {
    // `tsc --noEmit` is the assertion here (jest does not type-check): each
    // expect-error line becomes an "unused directive" compile error the day
    // the variant or member comes back.
    // @ts-expect-error backend_unavailable was deleted: every binding kind resolves
    const status: ByosStatus = { status: 'locked', reason: 'backend_unavailable', detail: 'gdrive' };
    // @ts-expect-error backend_unavailable is no longer a lock reason
    const reason: ByosLockedReason = 'backend_unavailable';
    // Derived from ByosStatus itself, with nothing else on the line: if a locked
    // variant with this reason returns under ANY detail type, this directive goes unused.
    // @ts-expect-error no locked ByosStatus carries reason backend_unavailable
    const statusReason: Extract<ByosStatus, { status: 'locked' }>['reason'] = 'backend_unavailable';
    // Added by hand: ByosUnreachableDetail is an Extract<> over a wider union,
    // so tsc would not have flagged its absence.
    const detail: ByosUnreachableDetail = 'not_gdrive';
    expect([status.status, reason, statusReason, detail]).toEqual(['locked', 'backend_unavailable', 'backend_unavailable', 'not_gdrive']);
  });

  it('a stored binding of a kind this build cannot name (hand-written kind:"dropbox") reads as unconfigured and builds nothing', async () => {
    // This is the replacement for the deleted branch, not a gap: parseBinding
    // returns null for an unknown kind, and an unparseable stored binding has
    // always resolved `unconfigured`. Nothing was stored that this build can
    // name, so there is nothing to lock. A future backend gets a real adapter
    // and a real `kind` in ByosBinding — do not reintroduce a "known but
    // unavailable" lock for it.
    const port = memoryPort();
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, JSON.stringify({ kind: 'dropbox', refreshToken: 'r', accountEmail: 'd@example.com', rootFolderId: 'x', stateFolderId: 'y', blobsFolderId: 'z' }));
    const createStore = jest.fn();
    const createTransport = jest.fn();
    expect(await resolveByosStatus({ credentialStore: createByosCredentialStore(port), sessionCache: createByosSessionCache(port), deviceIdStore, createStore, createTransport })).toEqual({ status: 'unconfigured' });
    expect(createStore).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe('resolveByosStatus — onedrive dispatch reaches the production factory (P12-C review, board #12b)', () => {
  beforeEach(() => {
    jest.mocked(createProductionOneDriveStore).mockReset();
    jest.mocked(createProductionGoogleDriveStore).mockReset();
  });

  it('passes its own credential store into the production OneDrive store (the rotation write-back target)', async () => {
    const port = memoryPort();
    const credentialStore = createByosCredentialStore(port);
    await credentialStore.saveBinding(ONEDRIVE);
    const sessionCache = createByosSessionCache(port);
    const key = new Uint8Array(32).fill(7);
    await sessionCache.save({
      masterKeyB64: Buffer.from(key).toString('base64'), vaultId: 'vo2', encryption: 'aes-gcm',
    });
    const store = createMemoryCloudObjectStore({ kind: 'onedrive' });
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(v2meta('vo2'))), 'application/json');
    jest.mocked(createProductionOneDriveStore).mockReturnValue(store);

    const deps: ByosResolveDeps = { credentialStore, sessionCache, deviceIdStore };
    const result = await resolveByosStatus(deps);

    expect(result.status).toBe('ready');
    expect(jest.mocked(createProductionOneDriveStore)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createProductionOneDriveStore)).toHaveBeenCalledWith(ONEDRIVE, { credentialStore: deps.credentialStore });
  });

  it('never calls the OneDrive factory for a webdav binding', async () => {
    const port = memoryPort();
    const credentialStore = createByosCredentialStore(port);
    const webdav = { kind: 'webdav' as const, baseUrl: 'https://dav.example', username: 'u', password: 'p', rootPath: '/' };
    await credentialStore.saveBinding(webdav);
    const sessionCache = createByosSessionCache(port);

    const deps: ByosResolveDeps = { credentialStore, sessionCache, deviceIdStore };
    const result = await resolveByosStatus(deps);

    // The real WebDAV factory runs unmocked; with `expo/fetch` stubbed to a
    // bare jest.fn(), its meta GET fails fast (TypeError on an undefined
    // response) with no real network call — enough to prove dispatch never
    // reached the OneDrive branch, without hanging on the 30s connect budget.
    expect(result).toEqual({ status: 'locked', reason: 'vault_unreachable', detail: 'not_webdav' });
    expect(jest.mocked(createProductionOneDriveStore)).not.toHaveBeenCalled();
  });
});

describe('resolveByosStatus — gdrive dispatch reaches the production factory (P12-D Task 9)', () => {
  beforeEach(() => {
    jest.mocked(createProductionOneDriveStore).mockReset();
    jest.mocked(createProductionGoogleDriveStore).mockReset();
  });

  it('hands the stored gdrive binding, and nothing else, to createProductionGoogleDriveStore', async () => {
    const port = memoryPort();
    const credentialStore = createByosCredentialStore(port);
    await credentialStore.saveBinding(GDRIVE);
    const sessionCache = createByosSessionCache(port);
    await sessionCache.save({ masterKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'), vaultId: 'vg2', encryption: 'aes-gcm' });
    const store = createMemoryCloudObjectStore({ kind: 'gdrive' });
    await store.put('vault-meta.json', encoder.encode(JSON.stringify(v2meta('vg2'))), 'application/json');
    jest.mocked(createProductionGoogleDriveStore).mockReturnValue(store);

    const result = await resolveByosStatus({ credentialStore, sessionCache, deviceIdStore });

    expect(result.status).toBe('ready');
    expect(jest.mocked(createProductionGoogleDriveStore)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createProductionGoogleDriveStore)).toHaveBeenCalledWith(GDRIVE);
    // No credential store is threaded, unlike OneDrive: Google refresh tokens
    // do not rotate (spec 补裁 3), so there is no write-back target to pass.
    // Its absence is deliberate — do not "fix" it.
    expect(jest.mocked(createProductionGoogleDriveStore).mock.calls[0]).toHaveLength(1);
    expect(jest.mocked(createProductionOneDriveStore)).not.toHaveBeenCalled();
  });

  it('never calls the Google Drive factory for a onedrive binding', async () => {
    const port = memoryPort();
    const credentialStore = createByosCredentialStore(port);
    await credentialStore.saveBinding(ONEDRIVE);
    jest.mocked(createProductionOneDriveStore).mockReturnValue(createMemoryCloudObjectStore({ kind: 'onedrive' }));

    await resolveByosStatus({ credentialStore, sessionCache: createByosSessionCache(port), deviceIdStore });

    expect(jest.mocked(createProductionOneDriveStore)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(createProductionGoogleDriveStore)).not.toHaveBeenCalled();
  });
});
