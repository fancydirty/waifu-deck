import {
  createByosSessionCache, BYOS_SESSION_CACHE_KEY, type CachedByosSession, type SecureStorePort,
} from './byos-session-cache';
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

const KEY = BYOS_SESSION_CACHE_KEY;

const aesSession: CachedByosSession = {
  masterKeyB64: 'base64keymaterial==', vaultId: 'vault-1', encryption: 'aes-gcm',
};

const noneSession: CachedByosSession = {
  masterKeyB64: null, vaultId: 'vault-2', encryption: 'none',
};

describe('byos session cache', () => {
  it('BYOS_SESSION_CACHE_KEY is a valid SecureStore key (no slashes)', () => {
    expect(BYOS_SESSION_CACHE_KEY).toMatch(SECURE_STORE_KEY_PATTERN);
  });

  it('returns null when nothing stored', async () => {
    const cache = createByosSessionCache(memoryStore());
    expect(await cache.load()).toBeNull();
  });

  it('round-trips a saved aes-gcm session', async () => {
    const cache = createByosSessionCache(memoryStore());
    await cache.save(aesSession);
    expect(await cache.load()).toEqual(aesSession);
  });

  it('round-trips a saved none-encryption session with a null masterKeyB64', async () => {
    const cache = createByosSessionCache(memoryStore());
    await cache.save(noneSession);
    expect(await cache.load()).toEqual(noneSession);
  });

  it('clear removes the cached session', async () => {
    const backing = memoryStore();
    const cache = createByosSessionCache(backing);
    await cache.save(aesSession);
    await cache.clear();
    expect(await cache.load()).toBeNull();
  });

  it('self-heals malformed stored json: returns null and deletes the entry', async () => {
    const backing = memoryStore();
    await backing.setItemAsync(KEY, '{not json');
    const cache = createByosSessionCache(backing);
    expect(await cache.load()).toBeNull();
    expect(await backing.getItemAsync(KEY)).toBeNull();
  });

  it('self-heals an aes-gcm session missing its masterKeyB64: returns null and deletes the entry', async () => {
    const backing = memoryStore();
    await backing.setItemAsync(KEY, JSON.stringify({
      masterKeyB64: null, vaultId: 'vault-3', encryption: 'aes-gcm',
    }));
    const cache = createByosSessionCache(backing);
    expect(await cache.load()).toBeNull();
    expect(await backing.getItemAsync(KEY)).toBeNull();
  });
});
