import type { KeyValueStorage } from '@/features/settings/settings-repository';

import {
  createLibraryStorageModeStore,
  LIBRARY_STORAGE_MODE_KEY,
} from './library-storage-mode';

const V = 'vault-1';

function mapStorage(): { map: Map<string, string>; storage: KeyValueStorage } {
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

describe('library storage mode store', () => {
  it('no choice reads 本地+云端', async () => {
    const { storage } = mapStorage();
    expect(await createLibraryStorageModeStore(storage).read(V)).toBe('both');
  });

  it('a choice reads back for its vault only', async () => {
    const { map, storage } = mapStorage();
    const store = createLibraryStorageModeStore(storage);

    await store.write(V, 'cloud-only');

    expect(await store.read(V)).toBe('cloud-only');
    expect(await store.read('vault-2')).toBe('both');
    expect(JSON.parse(map.get(LIBRARY_STORAGE_MODE_KEY) as string)).toEqual({
      vaultId: V, mode: 'cloud-only',
    });

    // The choice follows the vault it names, whichever vault that is.
    await store.write('vault-2', 'cloud-only');
    expect(await store.read('vault-2')).toBe('cloud-only');
    expect(await store.read(V)).toBe('both');
  });

  it('switching back reads 本地+云端', async () => {
    const { storage } = mapStorage();
    const store = createLibraryStorageModeStore(storage);

    await store.write(V, 'cloud-only');
    await store.write(V, 'both');

    expect(await store.read(V)).toBe('both');
  });

  it.each([
    ['{'],
    ['null'],
    ['{"vaultId":"vault-1","mode":"weird"}'],
  ])('a malformed or foreign value reads 本地+云端: %s', async (stored) => {
    const { map, storage } = mapStorage();
    map.set(LIBRARY_STORAGE_MODE_KEY, stored);

    expect(await createLibraryStorageModeStore(storage).read(V)).toBe('both');
  });

  it('clear forgets it', async () => {
    const { map, storage } = mapStorage();
    const store = createLibraryStorageModeStore(storage);
    await store.write(V, 'cloud-only');

    await store.clear();

    expect(map.has(LIBRARY_STORAGE_MODE_KEY)).toBe(false);
    expect(await store.read(V)).toBe('both');
  });

  it('a storage that cannot be read rejects', async () => {
    const storage: KeyValueStorage = {
      getItem: async () => { throw new Error('kv unavailable'); },
      setItem: async () => {},
      removeItem: async () => {},
    };

    await expect(createLibraryStorageModeStore(storage).read(V))
      .rejects.toThrow('kv unavailable');
  });
});
