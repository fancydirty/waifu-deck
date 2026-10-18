// Factories removed in P2; P3 provides BYOS-backed implementations of these
// ports. This file is P3C-2 Task 3: `createByosLibrarySessionPort`.
import { sha256 } from '@noble/hashes/sha2.js';

import type {
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import { deriveLibraryAccountScope } from '@/features/library/library-identity';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';

const encoder = new TextEncoder();

/**
 * BYOS accountScope derivation (decision #20) and the `encryption:'none'`
 * pseudo masterKey (decision #21) share one root:
 * `sha256(utf8(meta.vaultId))`.
 *
 * accountScope: fed into the existing `deriveLibraryAccountScope`
 * (library-identity.ts, unmodified by this task) — written for the
 * pre-BYOS masterKey-scoped identity and reused as-is here, rather than
 * duplicating a second scope formula, so the format (32 lowercase hex
 * chars) stays byte-for-byte identical to every other caller. Deterministic
 * across devices sharing the same vault-meta (same `vaultId` in, same scope
 * out), independent of whether a real masterKey exists.
 *
 * pseudo masterKey: `LibrarySessionContext.masterKey`
 * (library-actions-types.ts, out of scope for this task) is a required
 * `Uint8Array`, so `encryption:'none'` — which by design has no real key —
 * cannot leave it null. Decision #21 rules that in that case masterKey is
 * this same `sha256(utf8(vaultId))` digest: a deterministic 32-byte value
 * usable for identity/scope/asset-id derivation (ingest/identity's HMAC
 * calls need *some* 32-byte input, and plaintext-mode derived values have
 * no confidentiality requirement anyway — see decision #21's ingest/identity
 * rationale), reusing the exact bytes computed for accountScope rather than
 * a second derivation. Null is reserved strictly for "no session" at the
 * `LibrarySessionPort.current()` / `LibraryAccountPort.vaultMasterKey()`
 * level (library-account-port.ts, same Task).
 *
 * **This pseudo-key must never be used to actually encrypt or decrypt
 * object bytes.** The cipher for `encryption:'none'` is a passthrough
 * cipher the P3C-3 composition layer injects based on `meta.encryption`,
 * entirely independent of this value (decisions #14, #21).
 */
function vaultIdIdentityDigest(vaultId: string): Uint8Array {
  return sha256(encoder.encode(vaultId));
}

/**
 * Fully-resolved BYOS vault handle. Resolving `meta`/`masterKey` (network
 * GET of vault-meta + scrypt) and `deviceId` (SecureStore) is async
 * orchestration owed by the P3C-3 composition layer
 * (`createVaultOrAdopt` / the join path + the device-id store); this factory does no I/O and
 * accepts the already-resolved result.
 */
export type ByosLibrarySessionVault = Readonly<{
  meta: VaultMeta;
  masterKey: Uint8Array | null;
  deviceId: string;
}>;

/** BYOS-backed `LibrarySessionPort`. `current()` never returns null: every
 * injected vault (including `encryption:'none'`) is a usable session. */
export function createByosLibrarySessionPort(
  { vault }: { vault: ByosLibrarySessionVault },
): LibrarySessionPort {
  const identityDigest = vaultIdIdentityDigest(vault.meta.vaultId);
  const context: LibrarySessionContext = {
    deviceId: vault.deviceId,
    // Decision #21: encryption:'none' has no real key; the vaultId digest
    // stands in as a pseudo masterKey for identity/scope derivation only
    // (never for real encryption — see vaultIdIdentityDigest above).
    masterKey: vault.masterKey ?? identityDigest,
    accountScope: deriveLibraryAccountScope(identityDigest),
  };
  return {
    async current() {
      return context;
    },
  };
}
