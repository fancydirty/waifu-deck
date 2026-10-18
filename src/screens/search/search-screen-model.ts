import type { StoredImage } from '@/features/images/image-repository';
import {
  APP_DISTRIBUTION_POLICY,
  applyDistributionToSearchRequest,
  type DistributionPolicy,
} from '@/features/distribution/distribution-policy';
import { normalizeSearchRequest } from '@/features/search/search-query';
import type { SearchHit, SearchRequest } from '@/features/search/types';
import type { AppSettings } from '@/features/waifu/types';

export type SearchInputResolution =
  | { kind: 'empty'; tags: []; }
  | {
      kind: 'ready';
      tags: string[];
    };

export function parseSearchTags(value: string): string[] {
  const query = value.trim();
  return query.length === 0 ? [] : [query];
}

export function resolveSearchInput(value: string): SearchInputResolution {
  const inputTags = parseSearchTags(value);
  if (inputTags.length === 0) {
    return { kind: 'empty', tags: [] };
  }
  return { kind: 'ready', tags: inputTags };
}

export function buildSearchRequest(
  value: string,
  settings: AppSettings,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): SearchRequest | null {
  const resolution = resolveSearchInput(value);
  if (resolution.kind === 'empty') return null;

  // R8.15: search must not inherit the discovery orientation filter.
  // `settings.orientation` is a home-feed deck preference (default
  // 'portrait'); leaking it into search silently zeroed every result from
  // landscape-heavy sources (Konachan is a wallpaper board — a portrait
  // filter discards essentially its whole corpus). The search surface has no
  // orientation control, so search always requests 'any'.
  return applyDistributionToSearchRequest(normalizeSearchRequest({
    tags: resolution.tags,
    excludedTags: [],
    nsfwMode: settings.nsfwMode,
    orientation: 'any',
    animationMode: settings.animationMode,
    minWidth: settings.minWidth,
    maxBytes: settings.maxBytes,
  }), policy);
}

/**
 * K7 cut 5b (audit ㉙): the three identity rules that decide whether a search
 * hit is already in the collection, precomputed once per collection.
 */
export type SavedIdentityIndex = {
  readonly providerItems: ReadonlySet<string>;
  readonly canonicalSourceKeys: ReadonlySet<string>;
  readonly perceptualHashes: ReadonlySet<string>;
};

function providerItemIdentity(
  providerKey: string,
  providerItemId: string,
): string {
  // Length-prefixed so a provider key containing the separator can never
  // collide with a different provider/item split.
  return `${providerKey.length}:${providerKey}:${providerItemId}`;
}

export function buildSavedIdentityIndex(
  collection: readonly StoredImage[],
): SavedIdentityIndex {
  const providerItems = new Set<string>();
  const canonicalSourceKeys = new Set<string>();
  const perceptualHashes = new Set<string>();
  for (const saved of collection) {
    providerItems.add(
      providerItemIdentity(saved.providerKey, saved.providerItemId),
    );
    // A null on the saved side is "unknown", never a value to match against:
    // the chain this replaces compared it only when the *hit* had one, and a
    // Set must not turn two unknowns into a match.
    if (saved.canonicalSourceKey !== null) {
      canonicalSourceKeys.add(saved.canonicalSourceKey);
    }
    if (saved.perceptualHash !== null) {
      perceptualHashes.add(saved.perceptualHash);
    }
  }
  return { providerItems, canonicalSourceKeys, perceptualHashes };
}

export function isSearchHitSaved(
  hit: SearchHit,
  index: SavedIdentityIndex,
): boolean {
  const candidate = hit.image;
  return index.providerItems.has(
    providerItemIdentity(candidate.providerKey, candidate.providerItemId),
  ) ||
    (candidate.canonicalSourceKey !== null &&
      index.canonicalSourceKeys.has(candidate.canonicalSourceKey)) ||
    (candidate.perceptualHash !== null &&
      index.perceptualHashes.has(candidate.perceptualHash));
}
