import type { AppSettings, ImageCandidate } from '@/features/waifu/types';
import {
  candidateContentRating,
  matchesContentMode,
} from '@/features/content/content-taxonomy';

export function normalizeProviderTag(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function matchesCandidateSettings(
  image: ImageCandidate,
  settings: AppSettings,
): boolean {
  const tags = new Set(image.tags.map(normalizeProviderTag));
  const included = image.providerKey === 'waifu_im'
    ? settings.includedTags
        .filter((tag) => tag !== 'waifu')
        .map(normalizeProviderTag)
    : [];
  const excluded = settings.excludedTags.map(normalizeProviderTag);
  if (!included.every((tag) => tags.has(tag))) return false;
  if (excluded.some((tag) => tags.has(tag))) return false;
  if (!matchesContentMode(candidateContentRating(image), settings.nsfwMode)) return false;
  if (settings.orientation === 'portrait' && image.width >= image.height) return false;
  if (settings.orientation === 'landscape' && image.width <= image.height) return false;
  if (settings.animationMode === 'exclude' && image.isAnimated) return false;
  if (settings.animationMode === 'only' && !image.isAnimated) return false;
  if (settings.minWidth !== 0 && image.width < settings.minWidth) return false;
  if (settings.maxBytes !== 0 && image.byteSize > settings.maxBytes) return false;
  return true;
}
