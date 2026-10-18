import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import type { LibraryRenderSource } from '@/features/library/library-render-source';

/**
 * K2c: failure categories after which nothing will ever serve this asset's
 * bytes without user action. Everything else (offline, session not restored,
 * a transfer that can be retried, a full disk, a client that needs updating)
 * is transient and must NOT be surfaced as "needs repair", because pressing
 * repair reclaims a healthy library-owned row back to the provider download.
 */
const PERMANENT: ReadonlySet<LibraryFailureCategory> = new Set([
  'object_missing',
  'integrity',
  'unsupported_image',
]);

export function isLibraryPermanentlyUnavailable(
  source: LibraryRenderSource | null | undefined,
): boolean {
  return source?.kind === 'unavailable' && PERMANENT.has(source.category);
}

/**
 * K3 G3: "needs repair" must judge the ORIGINAL, not whatever tier the calling
 * intent happened to render. The signal is role-gated:
 *
 * - A local original always wins → recoverable.
 * - No original generation in the cloud → the original is genuinely gone.
 * - Otherwise the resolver result only proves the original is gone when the
 *   failure it reports is pinned to the `original` role AND is a hard
 *   original-blob failure (`integrity`/`unsupported_image`). A grid (thumbnail)
 *   or detail (preview) integrity is a corrupted DERIVED blob over a healthy
 *   original and must NOT repair — that was the K3 reversal. `object_missing`
 *   on the original is the spec's accepted cost (§4.4 row 4): show the "could
 *   not be verified" placeholder at full intent, not a provider re-download.
 *
 * `detail` does reach the original tier for animated assets and for assets that
 * never got a preview generation (`library-render-tiers.ts`), so an
 * original-role integrity there is a real "original is corrupt" signal and must
 * repair (§4.4 row 5).
 */
export function isOriginalUnrecoverable(input: {
  hasLocalOriginal: boolean;
  originalGenerationId: string | null;
  resolved: LibraryRenderSource | null | undefined;
}): boolean {
  if (input.hasLocalOriginal) return false;
  if (input.originalGenerationId === null) return true;
  const resolved = input.resolved;
  return (
    resolved?.kind === 'unavailable'
    && resolved.role === 'original'
    && (resolved.category === 'integrity' || resolved.category === 'unsupported_image')
  );
}

/**
 * Board #27 S4 (spec §5.15): a saved row the phone holds no usable original
 * of, whose original the cloud holds — 「仅在云端」. A row that needs 修复 is
 * not.
 */
export function isOnlyInCloud(input: Parameters<typeof isOriginalUnrecoverable>[0]): boolean {
  return !input.hasLocalOriginal && !isOriginalUnrecoverable(input);
}
