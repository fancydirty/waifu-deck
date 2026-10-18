import Storage from 'expo-sqlite/kv-store';

import type { KeyValueStorage } from '@/features/settings/settings-repository';

/**
 * Board #27 S3 (spec §5.8): this phone's 本机存储 choice. Per phone, never in
 * `AppSettings`, so no backup carries it to another phone; tagged with the
 * vault it was made for, so joining a different library reads 本地+云端.
 */
export const LIBRARY_STORAGE_MODE_KEY = 'waifu-deck/library/storage-mode/v1';
export type LibraryStorageMode = 'both' | 'cloud-only';
export type LibraryStorageModeStore = Readonly<{
  /** 'cloud-only' only for a stored choice naming `vaultId`. Rejects when storage cannot be read. */
  read(vaultId: string): Promise<LibraryStorageMode>;
  write(vaultId: string, mode: LibraryStorageMode): Promise<void>;
  clear(): Promise<void>;
}>;

export function createLibraryStorageModeStore(
  storage: KeyValueStorage = Storage,
): LibraryStorageModeStore {
  return {
    async read(vaultId) {
      const stored = await storage.getItem(LIBRARY_STORAGE_MODE_KEY);
      if (stored === null) return 'both';
      try {
        const value = JSON.parse(stored) as { vaultId?: unknown; mode?: unknown } | null;
        return value?.vaultId === vaultId && value.mode === 'cloud-only' ? 'cloud-only' : 'both';
      } catch {
        return 'both';
      }
    },
    write: (vaultId, mode) => storage.setItem(
      LIBRARY_STORAGE_MODE_KEY, JSON.stringify({ vaultId, mode }),
    ),
    clear: () => storage.removeItem(LIBRARY_STORAGE_MODE_KEY),
  };
}
