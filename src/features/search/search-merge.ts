import { dedupeByCandidateIdentity } from '@/features/providers/candidate-dedupe';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import type { ProviderCursorValue } from '@/features/providers/provider-adapter';
import type { ImageProviderKey } from '@/features/waifu/types';

import type {
  ProviderSearchFailure,
  ProviderSearchState,
  SearchCursor,
  SearchHit,
} from './types';

/** Registry key order — the §3.3 survivor tie-break. search-merge is not a
 *  registry dependency, so it may import PROVIDER_REGISTRY directly. */
const PROVIDER_ORDER = PROVIDER_REGISTRY.map((adapter) => adapter.key);

/** The failures collected while querying providers for one search page. */
export type SearchResultPage = {
  failures: ProviderSearchFailure[];
};

/**
 * Fold per-provider outcomes into the next cursor. Successful providers adopt
 * their new position (or `null` when exhausted); failed providers retain their
 * previous position so a retry resumes where it left off; providers absent from
 * `states` are left untouched. Does not mutate `previous`.
 */
export function aggregateSearchCursor(
  previous: SearchCursor,
  states: readonly ProviderSearchState[],
): SearchCursor {
  const cursor: SearchCursor = { ...previous };
  for (const state of states) {
    if (state.status !== 'ok') continue;
    // page.providerKey and page.nextCursor are runtime-correlated, but TS cannot
    // prove the correlated assignment across the discriminated union, so narrow
    // with one cast (behavior-equivalent; adding a source needs no change here).
    (cursor as Record<ImageProviderKey, ProviderCursorValue | null | undefined>)[
      state.page.providerKey
    ] = state.page.nextCursor;
  }
  return cursor;
}

export function interleaveProviderSearchHits(
  states: readonly ProviderSearchState[],
): SearchHit[] {
  const pages = states.flatMap((state) =>
    state.status === 'ok' ? [state.page.items] : [],
  );
  const hits: SearchHit[] = [];
  const maxLength = Math.max(0, ...pages.map((items) => items.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const items of pages) {
      const hit = items[index];
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

function sameImageCandidate(
  left: SearchHit['image'],
  right: SearchHit['image'],
): boolean {
  const primitiveKeys = [
    'providerKey',
    'providerItemId',
    'canonicalSourceKey',
    'perceptualHash',
    'remoteUrl',
    'sourceUrl',
    'artistName',
    'artistUrl',
    'width',
    'height',
    'byteSize',
    'extension',
    'dominantColor',
    'contentRating',
    'nativeRating',
    'isNsfw',
    'isAnimated',
  ] as const;
  return primitiveKeys.every((key) => left[key] === right[key]) &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag, index) => tag === right.tags[index]);
}

function reuseEquivalentHits(
  previous: readonly SearchHit[],
  current: readonly SearchHit[],
): SearchHit[] {
  const previousByKey = new Map(previous.map((hit) => [hit.key, hit]));
  return current.map((hit) => {
    const stable = previousByKey.get(hit.key);
    return stable && stable.previewUrl === hit.previewUrl &&
      sameImageCandidate(stable.image, hit.image)
      ? stable
      : hit;
  });
}

function fairOrderBelowSeenLine(
  rest: readonly SearchHit[],
  pinned: readonly SearchHit[],
): SearchHit[] {
  const queues = new Map<ImageProviderKey, SearchHit[]>();
  for (const hit of rest) {
    const queue = queues.get(hit.image.providerKey) ?? [];
    queue.push(hit);
    queues.set(hit.image.providerKey, queue);
  }
  const seen = new Map<ImageProviderKey, number>();
  for (const hit of pinned) {
    seen.set(hit.image.providerKey, (seen.get(hit.image.providerKey) ?? 0) + 1);
  }
  const order = [...queues.keys()].sort((left, right) =>
    (seen.get(left) ?? 0) - (seen.get(right) ?? 0) ||
    PROVIDER_ORDER.indexOf(left) - PROVIDER_ORDER.indexOf(right));
  const out: SearchHit[] = [];
  for (let round = 0; out.length < rest.length; round += 1) {
    for (const key of order) {
      const hit = queues.get(key)![round];
      if (hit) out.push(hit);
    }
  }
  return out;
}

export function reconcileStableSearchHits(
  previous: readonly SearchHit[],
  currentOrder: readonly SearchHit[],
  seenCount: number,
): SearchHit[] {
  const currentByKey = new Map(currentOrder.map((hit) => [hit.key, hit]));
  const pinned = previous.slice(0, Math.max(0, seenCount)).map(
    (hit) => currentByKey.get(hit.key) ?? hit,
  );
  const pinnedKeys = new Set(pinned.map((hit) => hit.key));
  const fairRest = fairOrderBelowSeenLine(
    currentOrder.filter((hit) => !pinnedKeys.has(hit.key)),
    pinned,
  );
  const reconciled = dedupeByCandidateIdentity(
    [
      ...pinned,
      ...fairRest,
    ],
    (hit) => hit.image,
    (hit, image) => image === hit.image ? hit : { ...hit, image },
    PROVIDER_ORDER,
    // Only hits above the seen line are pinned: a late duplicate may merge its
    // rating up but must never flip a visible tile's identity.
    (hit) => pinnedKeys.has(hit.key),
  );
  return reuseEquivalentHits(previous, reconciled);
}

/**
 * Collect the providers that could not be queried for the current page. The
 * hits/cursor folding lives in the hook, which calls `interleaveProviderSearchHits`,
 * `reconcileStableSearchHits` and `aggregateSearchCursor` directly; this is the
 * one remaining merge helper (§3.4 deleted the unread hits/cursor path this
 * function used to also compute).
 */
export function mergeProviderSearchStates(
  states: readonly ProviderSearchState[],
): SearchResultPage {
  return {
    failures: states.flatMap((state) =>
      state.status === 'failed' ? [state.failure] : [],
    ),
  };
}
