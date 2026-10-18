import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';

import type { SecureStorePort } from './byos-credentials';

export type { SecureStorePort };

// expo-secure-store keys must match /^[\w.-]+$/ (no slashes) — see
// node_modules/expo-secure-store/build/SecureStore.js:145-151.
export const BYOS_DEVICE_ID_KEY = 'waifu-deck.byos.device-id.v1';

const defaultPort: SecureStorePort = {
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItemAsync: SecureStore.deleteItemAsync,
};

export type DeviceIdStore = {
  get(): Promise<string>;
  reset(): Promise<void>;
};

/**
 * Local, per-install device identity used to attribute writes in the BYOS
 * sync protocol. First `get()` mints a UUID and persists it; every later
 * `get()` returns the same stored value.
 *
 * Concurrency: two `get()` calls racing on the same store instance (e.g.
 * two callers awaiting a cold start together) must not mint two different
 * ids. This is serialized with an in-flight promise: the first caller to
 * observe no stored value starts (and memoizes) the generate-and-persist
 * operation; any caller that arrives while it is pending is handed the
 * same promise instead of independently generating its own id.
 */
export function createDeviceIdStore(
  port: SecureStorePort = defaultPort,
): DeviceIdStore {
  let inFlight: Promise<string> | null = null;

  return {
    async get() {
      const stored = await port.getItemAsync(BYOS_DEVICE_ID_KEY);
      if (stored !== null) return stored;
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        const id = randomUUID();
        await port.setItemAsync(BYOS_DEVICE_ID_KEY, id);
        return id;
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
    async reset() {
      inFlight = null;
      await port.deleteItemAsync(BYOS_DEVICE_ID_KEY);
    },
  };
}
