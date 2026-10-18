import type { SearchRequest } from './types';

const DEFAULT_FILTER: Omit<SearchRequest, 'tags' | 'excludedTags'> = {
  nsfwMode: 'sfw',
  orientation: 'any',
  animationMode: 'exclude',
  minWidth: 0,
  maxBytes: 0,
};

function normalizeTagList(values: readonly string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const tag = value.trim();
    if (tag.length > 0) unique.add(tag);
  }
  return [...unique];
}

/**
 * Normalize a search filter without interpreting provider-owned tag strings.
 * Only outer whitespace, empty terms, and exact duplicates are removed.
 */
export function normalizeSearchRequest(
  input: Partial<SearchRequest>,
): SearchRequest {
  return {
    tags: normalizeTagList(input.tags),
    excludedTags: normalizeTagList(input.excludedTags),
    nsfwMode: input.nsfwMode ?? DEFAULT_FILTER.nsfwMode,
    orientation: input.orientation ?? DEFAULT_FILTER.orientation,
    animationMode: input.animationMode ?? DEFAULT_FILTER.animationMode,
    minWidth: input.minWidth ?? DEFAULT_FILTER.minWidth,
    maxBytes: input.maxBytes ?? DEFAULT_FILTER.maxBytes,
  };
}

/**
 * A stable key for a search filter. Two requests that normalize to the same
 * exact raw terms and filters produce the same identity, so callers can detect
 * when a filter actually changed and reset pagination. Fields are serialized
 * in a fixed order so the key depends only on values.
 */
export function searchFilterIdentity(input: Partial<SearchRequest>): string {
  const request = normalizeSearchRequest(input);
  return JSON.stringify([
    request.tags,
    request.excludedTags,
    request.nsfwMode,
    request.orientation,
    request.animationMode,
    request.minWidth,
    request.maxBytes,
  ]);
}
