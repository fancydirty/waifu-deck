import type { LibraryEncryptedMetadata } from '@/features/library/library-actions-types';
import { restorableImageFrom } from '@/features/library/library-source-metadata';
import type { ImageCandidate } from '@/features/waifu/types';

export type LibraryRestoreCandidate = Readonly<{
  candidate: ImageCandidate;
  /**
   * The original collect time, not now. The collection sorts by `decidedAt`,
   * so stamping the restore moment would float every restored image to the
   * top of the user's collection and silently reorder it.
   */
  savedAt: number;
}>;

/**
 * Project an opened v2 envelope into the candidate `imageRepository`
 * already knows how to insert. `null` for an envelope that carries no usable
 * `source` block: a v1 envelope from an older build, or an `origin: 'import'`
 * asset that never had provider identity. A null return keeps the asset on the
 * cloud-only tile path — it is never a reason to invent provider data.
 */
export function restoreCandidateFrom(
  metadata: LibraryEncryptedMetadata,
): LibraryRestoreCandidate | null {
  if (metadata.origin !== 'provider') return null;
  const source = restorableImageFrom(metadata);
  if (source === null) return null;
  const candidate: ImageCandidate = {
    providerKey: source.providerKey,
    providerItemId: source.providerItemId,
    canonicalSourceKey: source.canonicalSourceKey,
    perceptualHash: source.perceptualHash,
    md5: source.md5,
    remoteUrl: source.remoteUrl,
    // `sampleUrl` is optional-absent on a candidate but nullable in the
    // envelope; spreading a `null` would fail the row mapper's fallback to
    // `remoteUrl`, so omit the key entirely instead.
    ...(source.sampleUrl === null ? {} : { sampleUrl: source.sampleUrl }),
    sourceUrl: source.sourceUrl,
    artistName: source.artistName,
    artistUrl: source.artistUrl,
    width: source.width,
    height: source.height,
    byteSize: source.byteSize,
    extension: source.extension,
    dominantColor: source.dominantColor,
    contentRating: source.contentRating,
    nativeRating: source.nativeRating,
    isNsfw: source.isNsfw,
    isAnimated: source.isAnimated,
    // A fresh mutable copy: the envelope's array is `readonly` and shared.
    tags: [...source.tags],
  };
  return { candidate, savedAt: metadata.collectedAt };
}
