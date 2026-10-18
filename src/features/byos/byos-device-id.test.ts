jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createDeviceIdStore, BYOS_DEVICE_ID_KEY, type SecureStorePort,
} from './byos-device-id';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';
import { ensureValidKey } from '@/test/expo-secure-store-double';

// expo-secure-store requires keys to match /^[\w.-]+$/ and throws "Invalid
// key" otherwise (node_modules/expo-secure-store/build/SecureStore.js:147).
// A slash-delimited key throws on every real-device read/write.
const SECURE_STORE_KEY_PATTERN = /^[\w.-]+$/;

beforeEach(() => {
  resetExpoCryptoDouble();
});

function memoryStore(): SecureStorePort {
  const map = new Map<string, string>();
  return {
    getItemAsync: async (k) => { ensureValidKey(k); return map.get(k) ?? null; },
    setItemAsync: async (k, v) => { ensureValidKey(k); map.set(k, v); },
    deleteItemAsync: async (k) => { ensureValidKey(k); map.delete(k); },
  };
}

function spyStore(backing: SecureStorePort) {
  const calls = { setItemAsync: 0 };
  const port: SecureStorePort = {
    getItemAsync: (k) => backing.getItemAsync(k),
    setItemAsync: (k, v) => {
      calls.setItemAsync += 1;
      return backing.setItemAsync(k, v);
    },
    deleteItemAsync: (k) => backing.deleteItemAsync(k),
  };
  return { port, calls };
}

describe('byos device-id store', () => {
  it('BYOS_DEVICE_ID_KEY is a valid SecureStore key (no slashes)', () => {
    expect(BYOS_DEVICE_ID_KEY).toMatch(SECURE_STORE_KEY_PATTERN);
  });

  it('first get() generates a UUID and persists it under the device-id key', async () => {
    const backing = memoryStore();
    const store = createDeviceIdStore(backing);
    const id = await store.get();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await backing.getItemAsync(BYOS_DEVICE_ID_KEY)).toBe(id);
  });

  it('second get() call returns the same stored id rather than regenerating', async () => {
    const backing = memoryStore();
    const store = createDeviceIdStore(backing);
    const first = await store.get();
    const second = await store.get();
    expect(second).toBe(first);
  });

  it('reset() then get() deletes the stored id and mints a fresh one', async () => {
    const backing = memoryStore();
    const store = createDeviceIdStore(backing);
    const first = await store.get();
    await store.reset();
    expect(await backing.getItemAsync(BYOS_DEVICE_ID_KEY)).toBeNull();
    const second = await store.get();
    expect(second).not.toBe(first);
  });

  it('injected port is read/written under the BYOS_DEVICE_ID_KEY key', async () => {
    const backing = memoryStore();
    const { port, calls } = spyStore(backing);
    const store = createDeviceIdStore(port);
    await store.get();
    expect(calls.setItemAsync).toBe(1);
    expect(await backing.getItemAsync(BYOS_DEVICE_ID_KEY)).not.toBeNull();
  });

  it('two racing get() calls do not mint two different persisted ids', async () => {
    const backing = memoryStore();
    const { port, calls } = spyStore(backing);
    const store = createDeviceIdStore(port);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect(a).toBe(b);
    expect(calls.setItemAsync).toBe(1);
    expect(await backing.getItemAsync(BYOS_DEVICE_ID_KEY)).toBe(a);
  });
});
