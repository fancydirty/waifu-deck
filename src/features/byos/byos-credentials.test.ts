import {
  BYOS_CREDENTIALS_KEY, createByosCredentialStore, parseBinding,
  type ByosCredentials, type SecureStorePort,
} from './byos-credentials';
import { ensureValidKey } from '@/test/expo-secure-store-double';

// expo-secure-store requires keys to match /^[\w.-]+$/ and throws "Invalid
// key" otherwise (node_modules/expo-secure-store/build/SecureStore.js:147).
// A slash-delimited key throws on every real-device read/write.
const SECURE_STORE_KEY_PATTERN = /^[\w.-]+$/;

function memoryStore(): SecureStorePort {
  const map = new Map<string, string>();
  return {
    getItemAsync: async (k) => { ensureValidKey(k); return map.get(k) ?? null; },
    setItemAsync: async (k, v) => { ensureValidKey(k); map.set(k, v); },
    deleteItemAsync: async (k) => { ensureValidKey(k); map.delete(k); },
  };
}

const sample: ByosCredentials = {
  kind: 's3', endpoint: 'https://s3.example.com', region: 'auto', bucket: 'b',
  accessKeyId: 'AK', secretAccessKey: 'SK', prefix: 'waifu-deck/',
};

/** A pre-#12 stored payload: the S3 fields with no `kind` discriminator. */
function withoutKind({ kind: _kind, ...rest }: ByosCredentials): Omit<ByosCredentials, 'kind'> {
  return rest;
}

describe('byos credential store', () => {
  it('BYOS_CREDENTIALS_KEY is a valid SecureStore key (no slashes)', () => {
    expect(BYOS_CREDENTIALS_KEY).toMatch(SECURE_STORE_KEY_PATTERN);
  });

  it('returns null when nothing stored', async () => {
    const store = createByosCredentialStore(memoryStore());
    expect(await store.load()).toBeNull();
  });

  it('round-trips saved credentials', async () => {
    const store = createByosCredentialStore(memoryStore());
    await store.save(sample);
    expect(await store.load()).toEqual(sample);
  });

  it('clear removes credentials', async () => {
    const backing = memoryStore();
    const store = createByosCredentialStore(backing);
    await store.save(sample);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('returns null on corrupted stored json rather than throwing', async () => {
    const backing = memoryStore();
    await backing.setItemAsync(BYOS_CREDENTIALS_KEY, '{not json');
    const store = createByosCredentialStore(backing);
    expect(await store.load()).toBeNull();
  });
});

describe('board #12 — binding kinds', () => {
  it('a stored JSON without `kind` (every pre-#12 device) loads as an s3 binding', async () => {
    const port = memoryStore();
    const legacyStr = JSON.stringify(withoutKind(sample));
    // The pre-#12 payload genuinely carries no discriminator — a post-#12
    // fixture that already had `kind:"s3"` would never exercise the legacy arm.
    expect(legacyStr).not.toContain('"kind"');
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, legacyStr);
    const store = createByosCredentialStore(port);
    expect(await store.load()).toEqual(sample);
    expect(await store.loadBinding()).toEqual(sample);
  });

  it('load()/loadBinding() never rewrite the stored JSON (no silent migration)', async () => {
    const port = memoryStore();
    const store = createByosCredentialStore(port);

    // A pre-#12 payload (no `kind`) is left byte-for-byte after a read.
    const legacyStr = JSON.stringify(withoutKind(sample));
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, legacyStr);
    await store.load();
    await store.loadBinding();
    expect(await port.getItemAsync(BYOS_CREDENTIALS_KEY)).toBe(legacyStr);

    // A `kind`-carrying payload is likewise untouched.
    const kindStr = JSON.stringify(sample);
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, kindStr);
    await store.load();
    await store.loadBinding();
    expect(await port.getItemAsync(BYOS_CREDENTIALS_KEY)).toBe(kindStr);
  });

  it('a legacy JSON with an unknown extra key loads as exactly the six s3 fields + kind', async () => {
    const port = memoryStore();
    await port.setItemAsync(
      BYOS_CREDENTIALS_KEY,
      JSON.stringify({ ...withoutKind(sample), sessionToken: 'leak-me' }),
    );
    const store = createByosCredentialStore(port);
    const loaded = await store.loadBinding();
    expect(loaded).toEqual(sample);
    expect(loaded && Object.keys(loaded).sort()).toEqual(
      ['accessKeyId', 'bucket', 'endpoint', 'kind', 'prefix', 'region', 'secretAccessKey'],
    );
  });

  it('round-trips a webdav binding', async () => {
    const store = createByosCredentialStore(memoryStore());
    const webdav = { kind: 'webdav' as const, baseUrl: 'https://webdav.123pan.cn/webdav', username: 'u', password: 'p', rootPath: '/' };
    await store.saveBinding(webdav);
    expect(await store.loadBinding()).toEqual(webdav);
    expect(await store.load()).toBeNull(); // the S3-shaped view hides a non-S3 binding
  });

  it('round-trips onedrive and gdrive bindings', async () => {
    const store = createByosCredentialStore(memoryStore());
    const od = { kind: 'onedrive' as const, refreshToken: 'r', accountEmail: 'a@b', rootFolderId: 'x', stateFolderId: 'y', blobsFolderId: 'z' };
    await store.saveBinding(od);
    expect(await store.loadBinding()).toEqual(od);
    const gd = { kind: 'gdrive' as const, refreshToken: 'r', accountEmail: 'a@b', rootFolderId: 'x', stateFolderId: 'y', blobsFolderId: 'z' };
    await store.saveBinding(gd);
    expect(await store.loadBinding()).toEqual(gd);
  });

  it('save() stamps kind:"s3" into the raw stored JSON even when the caller omits it', async () => {
    const port = memoryStore();
    const store = createByosCredentialStore(port);
    // The `Omit<…,'kind'>` arm: a caller that never supplies a discriminator.
    await store.save(withoutKind(sample));
    const raw = await port.getItemAsync(BYOS_CREDENTIALS_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).kind).toBe('s3');
    // …and the stamp makes loadBinding and the s3-shaped load agree.
    expect(await store.loadBinding()).toEqual(sample);
    expect(await store.load()).toEqual(sample);
  });

  it('rejects a malformed binding as null (unknown kind, missing fields)', async () => {
    const port = memoryStore();
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, JSON.stringify({ kind: 'dropbox', token: 't' }));
    const store = createByosCredentialStore(port);
    expect(await store.loadBinding()).toBeNull();
    await port.setItemAsync(BYOS_CREDENTIALS_KEY, JSON.stringify({ kind: 'webdav', baseUrl: 'x' }));
    expect(await store.loadBinding()).toBeNull();
  });
});

describe('parseBinding (direct)', () => {
  it('returns null for null and for a stored literal null', () => {
    expect(parseBinding(null)).toBeNull();
    expect(parseBinding(JSON.parse('null'))).toBeNull();
  });

  it('rejects each backend arm when a required field is missing', () => {
    // s3 (the legacy default) without `bucket`.
    expect(parseBinding({
      kind: 's3', endpoint: 'e', region: 'r', accessKeyId: 'a', secretAccessKey: 's', prefix: 'p',
    })).toBeNull();
    // onedrive without `blobsFolderId`.
    expect(parseBinding({
      kind: 'onedrive', refreshToken: 'r', accountEmail: 'a@b', rootFolderId: 'x', stateFolderId: 'y',
    })).toBeNull();
    // gdrive without `refreshToken`.
    expect(parseBinding({
      kind: 'gdrive', accountEmail: 'a@b', rootFolderId: 'x', stateFolderId: 'y', blobsFolderId: 'z',
    })).toBeNull();
  });

  it('returns a valid onedrive binding as-is', () => {
    const od = {
      kind: 'onedrive' as const, refreshToken: 'r', accountEmail: 'a@b',
      rootFolderId: 'x', stateFolderId: 'y', blobsFolderId: 'z',
    };
    expect(parseBinding(od)).toEqual(od);
  });
});
