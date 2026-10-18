// Factory removed in P2; P3 provides a BYOS-backed implementation of this
// port. This file is P3C-2 Task 3: `createByosLibraryAccountPort`.
import type { LibraryAccountPort } from '@/features/library/library-ingest';
import type { LibrarySessionPort } from '@/features/library/library-actions-types';

/**
 * BYOS-backed `LibraryAccountPort`, thin over a `LibrarySessionPort`.
 *
 * `vaultMasterKey()` passes `LibrarySessionContext.masterKey` straight
 * through whenever a session exists. Per decision #21,
 * `encryption:'none'` sessions carry a `sha256(utf8(vaultId))` pseudo
 * masterKey there (never `null`), so `library-ingest.ts`'s Layer B
 * enrollment is not skipped just because encryption is off — "no
 * encryption" must not silently become "no sync". `null` is returned
 * strictly for "no session" (`sessionPort.current()` resolved null), never
 * for a valid `encryption:'none'` vault.
 *
 * **The pseudo masterKey is not a real key**: it must never be used to
 * encrypt or decrypt object bytes. The cipher for `encryption:'none'` is a
 * passthrough cipher the P3C-3 composition layer injects based on
 * `meta.encryption`, independent of this value (decisions #14, #21).
 */
export function createByosLibraryAccountPort(
  sessionPort: LibrarySessionPort,
): LibraryAccountPort {
  return {
    async vaultMasterKey() {
      const session = await sessionPort.current();
      return session === null ? null : session.masterKey;
    },
    async deviceId() {
      const session = await sessionPort.current();
      return session === null ? null : session.deviceId;
    },
    async accountScope() {
      const session = await sessionPort.current();
      return session === null ? null : session.accountScope;
    },
  };
}
