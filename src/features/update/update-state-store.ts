import Storage from 'expo-sqlite/kv-store';

import type { KeyValueStorage } from '@/features/settings/settings-repository';
import { parseAppRelease, type AppRelease } from './update-model';

export const UPDATE_STATE_STORAGE_KEY = 'waifu-deck/update-state/v1';

export type PersistedUpdateState = Readonly<{
  lastCheckAtMs: number;
  dismissedVersionCode: number;
  cachedRelease: AppRelease | null;
}>;

export const DEFAULT_UPDATE_STATE: PersistedUpdateState = {
  lastCheckAtMs: 0,
  dismissedVersionCode: 0,
  cachedRelease: null,
};

export interface UpdateStateStore {
  load(): Promise<PersistedUpdateState>;
  save(state: PersistedUpdateState): Promise<PersistedUpdateState>;
  reset(): Promise<void>;
}

function normalizeUpdateState(raw: unknown): PersistedUpdateState {
  if (raw === null || typeof raw !== 'object') return DEFAULT_UPDATE_STATE;
  const candidate = raw as Record<string, unknown>;
  const lastCheckAtMs =
    typeof candidate.lastCheckAtMs === 'number' &&
    Number.isFinite(candidate.lastCheckAtMs) &&
    candidate.lastCheckAtMs >= 0
      ? Math.floor(candidate.lastCheckAtMs)
      : 0;
  const dismissedVersionCode =
    typeof candidate.dismissedVersionCode === 'number' &&
    Number.isInteger(candidate.dismissedVersionCode) &&
    candidate.dismissedVersionCode >= 0
      ? candidate.dismissedVersionCode
      : 0;
  const cachedRelease = parseAppRelease(candidate.cachedRelease);
  return {
    lastCheckAtMs,
    dismissedVersionCode,
    cachedRelease,
  };
}

export function createUpdateStateStore(
  storage: KeyValueStorage = Storage,
): UpdateStateStore {
  return {
    async load() {
      const raw = await storage.getItem(UPDATE_STATE_STORAGE_KEY);
      if (raw === null) return DEFAULT_UPDATE_STATE;
      try {
        return normalizeUpdateState(JSON.parse(raw));
      } catch {
        return DEFAULT_UPDATE_STATE;
      }
    },
    async save(state) {
      const normalized = normalizeUpdateState(state);
      await storage.setItem(UPDATE_STATE_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    },
    async reset() {
      await storage.removeItem(UPDATE_STATE_STORAGE_KEY);
    },
  };
}
