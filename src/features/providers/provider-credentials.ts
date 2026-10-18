import * as SecureStore from 'expo-secure-store';

import { isImageProviderKey, type ImageProviderKey } from '@/features/waifu/types';

/**
 * G4 spec §2.1 — user-supplied API credentials for credentialed gallery
 * sources (Gelbooru; Rule34 in G4b). Device-local secure store ONLY: the key
 * must never enter AppSettings, the plaintext settings JSON, any log line, or
 * the dev round trace. One JSON map under a single entry, so a third
 * credentialed source later is a config change, not a new store.
 *
 * Key↔enable coupling (owner decision 2026-09-03) lives at the save call site
 * (settings screen → app-services), not here; this module is storage only.
 */
export type ProviderCredential = { readonly apiKey: string; readonly userId: string };

export type SecureStorePort = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

// expo-secure-store keys must match /^[\w.-]+$/ (no slashes).
export const PROVIDER_CREDENTIALS_KEY = 'waifu-deck.provider-credentials.v1';

const defaultPort: SecureStorePort = {
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItemAsync: SecureStore.deleteItemAsync,
};

export type ProviderCredentialMap = Partial<Record<ImageProviderKey, ProviderCredential>>;

export type ProviderCredentialStore = {
  load(): Promise<ProviderCredentialMap>;
  save(key: ImageProviderKey, credential: ProviderCredential): Promise<ProviderCredentialMap>;
  clear(key: ImageProviderKey): Promise<ProviderCredentialMap>;
};

function isCredential(value: unknown): value is ProviderCredential {
  const c = value as Partial<ProviderCredential> | null;
  return !!c && typeof c === 'object'
    && typeof c.apiKey === 'string' && c.apiKey.length > 0
    && typeof c.userId === 'string' && c.userId.length > 0;
}

/**
 * Per-entry validation: one corrupt entry must not discard every other
 * source's key (unlike BYOS's all-or-nothing isCredentials — a map has
 * independent entries).
 */
function sanitize(parsed: unknown): ProviderCredentialMap {
  if (parsed === null || typeof parsed !== 'object') return {};
  const map: ProviderCredentialMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isImageProviderKey(key) && isCredential(value)) map[key] = value;
  }
  return map;
}

export function createProviderCredentialStore(
  port: SecureStorePort = defaultPort,
): ProviderCredentialStore {
  const read = async (): Promise<ProviderCredentialMap> => {
    const stored = await port.getItemAsync(PROVIDER_CREDENTIALS_KEY);
    if (stored === null) return {};
    try {
      return sanitize(JSON.parse(stored));
    } catch {
      return {};
    }
  };
  // save/clear are read-modify-write on a shared map; serialize them behind a
  // promise-chain queue so overlapping calls don't clobber each other's
  // read() snapshot. Chained with .then(fn, fn) so a prior rejection doesn't
  // poison later writes. Each op RESOLVES to the map it just wrote (computed
  // inside the serialized block), so the caller's live ref is refreshed from
  // that exact write — never a separate, racing load() that could settle out
  // of order under concurrent saves for different keys.
  let writeQueue: Promise<ProviderCredentialMap> = Promise.resolve({});
  const enqueue = (
    mutate: (map: ProviderCredentialMap) => void,
  ): Promise<ProviderCredentialMap> => {
    const run = async (): Promise<ProviderCredentialMap> => {
      const map = await read();
      mutate(map);
      await port.setItemAsync(PROVIDER_CREDENTIALS_KEY, JSON.stringify(map));
      return map;
    };
    writeQueue = writeQueue.then(run, run);
    return writeQueue;
  };
  return {
    load: read,
    save(key, credential) {
      return enqueue((map) => {
        map[key] = credential;
      });
    },
    clear(key) {
      return enqueue((map) => {
        delete map[key];
      });
    },
  };
}
