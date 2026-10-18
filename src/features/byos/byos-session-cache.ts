import * as SecureStore from 'expo-secure-store';

import type { SecureStorePort } from './byos-credentials';

export type { SecureStorePort };

// expo-secure-store keys must match /^[\w.-]+$/ (no slashes) — see
// node_modules/expo-secure-store/build/SecureStore.js:145-151.
export const BYOS_SESSION_CACHE_KEY = 'waifu-deck.byos.session.v1';

const defaultPort: SecureStorePort = {
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItemAsync: SecureStore.deleteItemAsync,
};

/**
 * A cached BYOS session: the vault identity plus the key material needed to
 * assemble a ready resolver context without re-deriving anything from a
 * password on every app start.
 *
 * `masterKeyB64` is null for `encryption: 'none'` vaults. Decision #21
 * (docs/superpowers/specs/2026-08-28-byos-p3c-decisions.md) gives 'none'
 * vaults a pseudo master key of `sha256(utf8(vaultId))` so identity/scope/
 * asset-id derivation still has a key to work with even though the vault
 * itself is unencrypted. That pseudo-key is fully *derivable* from
 * `vaultId` alone, so it is deliberately never persisted here — the
 * resolver re-derives it on load instead. Caching a derivable value would
 * misrepresent it as a secret and create a second place it could drift
 * from `vaultId`.
 */
export type CachedByosSession = {
  /**
   * Standard base64 (`encodeBase64` from `./base64`), NOT base64url — decode
   * with `decodeBase64`. Uses the Hermes-safe helper rather than Node's
   * `Buffer` (undefined on device). Matches the `saltB64`/`keyCheckB64`
   * convention in `byos-vault-meta.ts`.
   */
  readonly masterKeyB64: string | null;
  readonly vaultId: string;
  readonly encryption: 'aes-gcm' | 'none';
};

export type ByosSessionCache = {
  save(session: CachedByosSession): Promise<void>;
  load(): Promise<CachedByosSession | null>;
  clear(): Promise<void>;
};

function isValidSession(v: unknown): v is CachedByosSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<CachedByosSession>;
  if (typeof s.vaultId !== 'string' || s.vaultId.length === 0) return false;
  if (s.encryption !== 'aes-gcm' && s.encryption !== 'none') return false;
  if (s.masterKeyB64 !== null && typeof s.masterKeyB64 !== 'string') return false;
  // aes-gcm sessions must carry the key that makes them usable; a null key
  // here means the entry can never produce a working ready context and is
  // therefore treated as malformed rather than a legitimate locked-forever
  // session.
  if (s.encryption === 'aes-gcm' && s.masterKeyB64 === null) return false;
  return true;
}

export function createByosSessionCache(
  port: SecureStorePort = defaultPort,
): ByosSessionCache {
  return {
    async save(session) {
      await port.setItemAsync(BYOS_SESSION_CACHE_KEY, JSON.stringify(session));
    },
    /**
     * Self-healing read: if the stored value is not valid JSON, or does not
     * match the expected shape (including the aes-gcm/masterKeyB64
     * consistency rule above), the corrupt entry is deleted before this
     * returns null. Callers can treat a null result as simply "no usable
     * cached session" and fall through to the normal locked/unconfigured
     * flow, without a poisoned SecureStore entry surviving to poison the
     * next read too.
     */
    async load() {
      const stored = await port.getItemAsync(BYOS_SESSION_CACHE_KEY);
      if (stored === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stored);
      } catch {
        await port.deleteItemAsync(BYOS_SESSION_CACHE_KEY);
        return null;
      }
      if (!isValidSession(parsed)) {
        await port.deleteItemAsync(BYOS_SESSION_CACHE_KEY);
        return null;
      }
      return parsed;
    },
    async clear() {
      await port.deleteItemAsync(BYOS_SESSION_CACHE_KEY);
    },
  };
}
