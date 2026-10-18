import type { ImageCandidate } from '@/features/waifu/types';

import type { SearchHit } from './types';

/**
 * Build a search hit from a provider candidate, deriving the stable per-hit key
 * from the provider identity. Dedup and merging operate on `hit.image`.
 *
 * R8.24: the preview is the provider's medium sample when it publishes one.
 * A booru original is a 3-16 MB wallpaper (Konachan/Yande.re); pulling it for a
 * ~140 dp grid tile stalled the fetch and left the tile on its dominant colour.
 * Saving to the collection still downloads `image.remoteUrl`.
 */
export function toSearchHit(image: ImageCandidate): SearchHit {
  return {
    key: `${image.providerKey}:${image.providerItemId}`,
    previewUrl: image.sampleUrl ?? image.remoteUrl,
    image,
  };
}
