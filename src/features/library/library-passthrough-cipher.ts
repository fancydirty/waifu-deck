import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import { decodeBase64Url, encodeBase64Url } from '@/features/vault/base64url';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `LibraryObjectCipher` for vaults created with `meta.encryption === 'none'`.
 *
 * `seal`/`open` are the identity function on the object bytes: nothing is
 * encrypted, so what goes up to the remote is exactly what was collected.
 * `sealMetadata`/`openMetadata` base64url-encode/decode the
 * `LibraryEncryptedMetadata` JSON with no encryption layer underneath, so a
 * `'none'` vault's `state.json.meta` is plaintext-but-encoded, matching the
 * wire shape (an opaque string) the protocol expects from every vault
 * regardless of `encryption`.
 *
 * `masterKey`, `assetId`, and `scope` are accepted only to satisfy
 * `LibraryObjectCipher`'s signature (so the composition layer in P3C-3 can
 * dispatch on `meta.encryption` without a special-cased call shape) — this
 * cipher never reads them.
 *
 * Per-vault encryption is fixed at vault creation (decisions #20/#23) and is
 * never mixed within one vault: a vault is either `'none'` end to end (this
 * cipher) or `'aes-gcm'` end to end (`createLibraryObjectCipher`). A `'none'`
 * session's `masterKey` is a pseudo key, `sha256(utf8(vaultId))` (decision
 * #21), that exists solely so ingest/identity can derive account scope and
 * asset ids without a real key — it must never be used to encrypt anything.
 * Because this cipher ignores `masterKey` entirely, wiring it for `'none'`
 * vaults is what guarantees that pseudo-key can never reach real encryption,
 * even if a future refactor accidentally threads it further down.
 *
 * Malformed-input handling deliberately reuses the exact primitives
 * `createLibraryObjectCipher` uses — `decodeBase64Url` and `JSON.parse` — so
 * a corrupted or foreign-cipher payload fails with the identical error
 * class/message the real cipher would produce for the same bytes. Neither
 * cipher wraps these in a bespoke corruption error type, so staying
 * unwrapped here is the alignment, not a divergence.
 */
export function createPassthroughLibraryCipher(): LibraryObjectCipher {
  return {
    async seal({ plaintext }) {
      return plaintext;
    },

    async open({ envelope }) {
      return envelope;
    },

    async sealMetadata({ metadata }) {
      return encodeBase64Url(encoder.encode(JSON.stringify(metadata)));
    },

    async openMetadata({ sealed }) {
      const plaintext = decodeBase64Url(sealed);
      return JSON.parse(decoder.decode(plaintext)) as LibraryEncryptedMetadata;
    },
  };
}
