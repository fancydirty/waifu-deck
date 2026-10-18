import Storage from 'expo-sqlite/kv-store';

import { normalizeSettings } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';

export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export interface SettingsRepository {
  load(): Promise<AppSettings>;
  save(value: unknown): Promise<AppSettings>;
  reset(): Promise<void>;
}

export const SETTINGS_STORAGE_KEY = 'waifu-deck/settings/v1';

export function createSettingsRepository(
  storage: KeyValueStorage = Storage,
): SettingsRepository {
  return {
    async load() {
      const stored = await storage.getItem(SETTINGS_STORAGE_KEY);
      if (stored === null) return normalizeSettings(undefined);

      try {
        return normalizeSettings(JSON.parse(stored));
      } catch {
        return normalizeSettings(undefined);
      }
    },
    async save(value) {
      const settings = normalizeSettings(value);
      await storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      return settings;
    },
    reset() {
      return storage.removeItem(SETTINGS_STORAGE_KEY);
    },
  };
}
