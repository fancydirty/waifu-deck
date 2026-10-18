import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ProviderCursorValue } from '@/features/providers/provider-adapter';
import type { ProviderCredentialMap } from '@/features/providers/provider-credentials';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import type { ProviderRequestGovernor } from '@/features/providers/provider-resilience';
import {
  interleaveProviderSearchHits,
  mergeProviderSearchStates,
  reconcileStableSearchHits,
} from '@/features/search/search-merge';
import {
  normalizeSearchRequest,
  searchFilterIdentity,
} from '@/features/search/search-query';
import type {
  ProviderSearchFailure,
  ProviderSearchPage,
  ProviderSearchState,
  SearchHit,
  SearchRequest,
} from '@/features/search/types';
import type {
  AppSettings,
  ImageProviderKey,
} from '@/features/waifu/types';

type SearchStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'empty'
  | 'unsupported'
  | 'error';

export type UseSearchResult = {
  hits: SearchHit[];
  failures: ProviderSearchFailure[];
  enabledProviderCount: number;
  status: SearchStatus;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<void>;
  refetch: () => Promise<void>;
  noteSeen: (count: number) => void;
};

type ProviderPage<K extends ImageProviderKey> = Extract<
  ProviderSearchPage,
  { providerKey: K }
>;

type ProviderQueryKey<K extends ImageProviderKey> = readonly [
  'search',
  K,
  string | null,
];

const SAFE_ERROR_CODES = new Set([
  'aborted',
  'http',
  'invalid_response',
  'network',
  'rate_limited',
  'timeout',
]);

/**
 * §3.2 — release the first-paint one-item-per-provider clamp after this long.
 * `isInitialLoading` is OR'd across providers, so without a deadline one slow
 * provider's 12 s request deadline would pin the whole grid to one row each. Once
 * elapsed, providers that have landed release their full page via the normal
 * reconcile path.
 */
export const SEARCH_FIRST_PAINT_MS = 2500;

function providerQueryKey<K extends ImageProviderKey>(
  providerKey: K,
  requestIdentity: string | null,
): ProviderQueryKey<K> {
  return ['search', providerKey, requestIdentity];
}

function requireSearchRequest(request: SearchRequest | null): SearchRequest {
  if (request === null) throw new Error('Search query is disabled');
  return request;
}

/**
 * Reduce a thrown provider error to a whitelisted code.
 *
 * The whitelist is what keeps a provider's raw error text — which can embed a
 * request URL and therefore an API key — out of app state entirely. There is
 * deliberately no message field to populate: failures are only ever counted,
 * never shown per source.
 */
function safeProviderFailure(
  providerKey: ImageProviderKey,
  error: unknown,
): ProviderSearchFailure {
  const rawCode = error !== null && typeof error === 'object' &&
      'code' in error && typeof error.code === 'string'
    ? error.code
    : 'provider';
  return {
    providerKey,
    code: SAFE_ERROR_CODES.has(rawCode) ? rawCode : 'provider',
  };
}

function aggregateProviderPages<K extends ImageProviderKey>(
  providerKey: K,
  pages: readonly ProviderPage<K>[] | undefined,
): ProviderPage<K> | null {
  if (pages === undefined || pages.length === 0) return null;

  let total: number | undefined;
  for (const page of pages) {
    if (page.total !== undefined) total = page.total;
  }
  const lastPage = pages[pages.length - 1];
  return {
    providerKey,
    items: pages.flatMap((page) => page.items),
    nextCursor: lastPage.nextCursor,
    ...(total === undefined ? {} : { total }),
    ...(pages.every((page) => page.unsupportedQuery === true)
      ? { unsupportedQuery: true }
      : {}),
  } as ProviderPage<K>;
}

function appendProviderStates<K extends ImageProviderKey>(
  states: ProviderSearchState[],
  providerKey: K,
  pages: readonly ProviderPage<K>[] | undefined,
  error: Error | null,
): void {
  const page = aggregateProviderPages(providerKey, pages);
  if (page !== null) states.push({ status: 'ok', page });
  if (error !== null) {
    states.push({
      status: 'failed',
      failure: safeProviderFailure(providerKey, error),
    });
  }
}

export function useSearch(
  submittedRequest: SearchRequest | null,
  providers: AppSettings['providers'],
  governor?: ProviderRequestGovernor,
  credentials?: ProviderCredentialMap,
): UseSearchResult {
  const request = submittedRequest === null
    ? null
    : normalizeSearchRequest(submittedRequest);
  const requestIdentity = request === null
    ? null
    : searchFilterIdentity(request);
  const enabledByKey = (key: ImageProviderKey): boolean =>
    request !== null && providers[key];

  // PROVIDER_REGISTRY is a fixed-length module constant, never reassigned, so
  // the hook count and order are invariant across renders — calling
  // useInfiniteQuery inside .map is safe. Each query is gated by `enabled`,
  // never by a conditional hook call.
  const queries = PROVIDER_REGISTRY.map((adapter) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed-length registry keeps hook order/count invariant
    useInfiniteQuery({
      queryKey: providerQueryKey(adapter.key, requestIdentity),
      enabled: enabledByKey(adapter.key),
      initialPageParam: undefined as ProviderCursorValue | undefined,
      queryFn: ({ pageParam, signal }) =>
        adapter.fetchSearchPage(
          requireSearchRequest(request),
          pageParam,
          {
            signal,
            governor,
            // G4 — the per-user credential for this source, absent for keyless
            // ones (spec §2.2). Read per query from the passed snapshot.
            ...(credentials?.[adapter.key]
              ? { credential: credentials[adapter.key] }
              : {}),
          },
        ),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );

  const states: ProviderSearchState[] = [];
  // Registry iteration widens the per-provider ProviderPage<K> typing to the
  // ProviderSearchPage union (the old per-literal narrowing is intentionally
  // traded away). Runtime key/page correlation still holds because each adapter
  // and its query share the same PROVIDER_REGISTRY index.
  PROVIDER_REGISTRY.forEach((adapter, index) => {
    if (!enabledByKey(adapter.key)) return;
    appendProviderStates(
      states,
      adapter.key,
      queries[index].data?.pages,
      queries[index].error,
    );
  });
  const merged = mergeProviderSearchStates(states);
  const isInitialLoading = PROVIDER_REGISTRY.some((adapter, index) =>
    enabledByKey(adapter.key) &&
    queries[index].data === undefined &&
    queries[index].isPending);
  const isFetchingNextPage = PROVIDER_REGISTRY.some((adapter, index) =>
    enabledByKey(adapter.key) && queries[index].isFetchingNextPage);
  // §3.1 reads each query's isFetchingNextPage / isRefetching directly in the
  // per-provider un-freeze below; there is no longer a global refetch freeze.
  const providerSessionKey = requestIdentity === null
    ? 'idle'
    : `${requestIdentity}:${PROVIDER_REGISTRY
      .map((adapter) => Number(enabledByKey(adapter.key)))
      .join('')}`;
  const providerSessionKeyRef = useRef(providerSessionKey);
  const [seenState, setSeenState] = useState({
    sessionKey: providerSessionKey,
    count: 0,
  });
  const seenCount = seenState.sessionKey === providerSessionKey
    ? seenState.count
    : 0;
  const noteSeen = useCallback((count: number) => {
    const nextCount = Math.max(0, count);
    setSeenState((current) => {
      if (
        providerSessionKeyRef.current !== providerSessionKey ||
        current.sessionKey !== providerSessionKey
      ) return current;
      return nextCount > current.count
        ? { sessionKey: providerSessionKey, count: nextCount }
        : current;
    });
  }, [providerSessionKey]);
  useLayoutEffect(() => {
    const previousSessionKey = providerSessionKeyRef.current;
    providerSessionKeyRef.current = providerSessionKey;
    if (previousSessionKey !== providerSessionKey) {
      // This must run before child passive effects can report the new grid's
      // first geometry; a passive reset would let that report be discarded.
      setSeenState({ sessionKey: providerSessionKey, count: 0 });
    }
  }, [providerSessionKey]);
  const [stableSnapshot, setStableSnapshot] = useState<{
    sessionKey: string;
    hits: SearchHit[];
  }>({ sessionKey: providerSessionKey, hits: [] });

  // §3.2 — first-paint clamp deadline, per request identity. Storing the
  // identity the deadline elapsed FOR (rather than a bare boolean reset in an
  // effect) means a new request is treated as not-yet-elapsed with no
  // synchronous setState-in-effect. The timer only sets state when it fires.
  const [firstPaintElapsedFor, setFirstPaintElapsedFor] = useState<string | null>(null);
  useEffect(() => {
    if (requestIdentity === null) return undefined;
    const timer = setTimeout(
      () => setFirstPaintElapsedFor(requestIdentity),
      SEARCH_FIRST_PAINT_MS,
    );
    return () => clearTimeout(timer);
  }, [requestIdentity]);
  const firstPaintElapsed = firstPaintElapsedFor === requestIdentity &&
    requestIdentity !== null;

  // §3.1 — per-provider un-freeze. Instead of freezing the WHOLE grid to the
  // prior snapshot while any provider paginates or refetches, each provider
  // contributes either its freshly-resolved page or, if THAT provider is still
  // in flight, its previously-shown slice. `reconcileStableSearchHits` keeps
  // prior positions, so a slow provider only appends when it lands.
  const priorByProvider = new Map<ImageProviderKey, SearchHit[]>();
  if (stableSnapshot.sessionKey === providerSessionKey) {
    for (const hit of stableSnapshot.hits) {
      const bucket = priorByProvider.get(hit.image.providerKey) ?? [];
      bucket.push(hit);
      priorByProvider.set(hit.image.providerKey, bucket);
    }
  }
  const unfrozenStates: ProviderSearchState[] = PROVIDER_REGISTRY.flatMap(
    (adapter, index) => {
      if (!enabledByKey(adapter.key)) return [];
      const query = queries[index];
      const live = states.find(
        (state) => state.status === 'ok' &&
          state.page.providerKey === adapter.key,
      );
      // In flight for this provider (next page or refetch) and we have a prior
      // slice → reuse it, so this provider does not blink out while it fetches.
      if (
        (query.isFetchingNextPage || query.isRefetching) &&
        priorByProvider.has(adapter.key)
      ) {
        return [{
          status: 'ok',
          page: {
            providerKey: adapter.key,
            items: priorByProvider.get(adapter.key)!,
            nextCursor: null,
          },
        } as ProviderSearchState];
      }
      return live ? [live] : [];
    },
  );
  const currentOrder = interleaveProviderSearchHits(unfrozenStates);
  const stableInput = isInitialLoading && !firstPaintElapsed
    ? currentOrder.filter((hit, index) => currentOrder.findIndex(
      (candidate) => candidate.image.providerKey === hit.image.providerKey,
    ) === index)
    : currentOrder;
  const stableHits = reconcileStableSearchHits(
    stableSnapshot.sessionKey === providerSessionKey ? stableSnapshot.hits : [],
    stableInput,
    seenCount,
  );
  useEffect(() => {
    // The previous emitted prefix is temporal state, not derivable from one provider snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStableSnapshot((current) => {
      const sameSession = current.sessionKey === providerSessionKey;
      const sameHits = sameSession && current.hits.length === stableHits.length &&
        current.hits.every((hit, index) => hit === stableHits[index]);
      return sameHits
        ? current
        : { sessionKey: providerSessionKey, hits: stableHits };
    });
  }, [providerSessionKey, stableHits]);

  const enabledProviderCount = PROVIDER_REGISTRY.reduce(
    (total, adapter) => total + Number(providers[adapter.key]),
    0,
  );
  const successfulProviderCount = PROVIDER_REGISTRY.reduce(
    (total, adapter, index) =>
      total + Number(enabledByKey(adapter.key) && queries[index].data !== undefined),
    0,
  );
  const unsupportedProviderCount = states.filter(
    (state) => state.status === 'ok' && state.page.unsupportedQuery === true,
  ).length;
  const searchableProviderCount = successfulProviderCount - unsupportedProviderCount;
  let status: SearchStatus;
  if (request === null || enabledProviderCount === 0) {
    status = 'idle';
  } else if (stableHits.length > 0) {
    status = 'success';
  } else if (isInitialLoading) {
    status = 'loading';
  } else if (
    searchableProviderCount === 0 &&
    merged.failures.length > 0
  ) {
    status = 'error';
  } else if (searchableProviderCount > 0) {
    status = 'empty';
  } else if (unsupportedProviderCount > 0) {
    status = 'unsupported';
  } else {
    status = 'loading';
  }

  const paginationLocks = useRef(new Set<string>());
  const fetchNextPage = useCallback(async (): Promise<void> => {
    const requests: Promise<unknown>[] = [];
    const start = (
      providerKey: ImageProviderKey,
      fetchPage: () => Promise<unknown>,
    ) => {
      const lockKey = `${providerKey}:${requestIdentity ?? 'idle'}`;
      if (paginationLocks.current.has(lockKey)) return;
      paginationLocks.current.add(lockKey);
      requests.push(
        fetchPage().finally(() => paginationLocks.current.delete(lockKey)),
      );
    };

    PROVIDER_REGISTRY.forEach((adapter, index) => {
      const query = queries[index];
      if (
        request !== null && providers[adapter.key] &&
        query.hasNextPage && !query.isFetchingNextPage
      ) {
        start(adapter.key, query.fetchNextPage);
      }
    });
    await Promise.allSettled(requests);
  }, [providers, queries, request, requestIdentity]);

  const refetch = useCallback(async (): Promise<void> => {
    const requests: Promise<unknown>[] = [];
    PROVIDER_REGISTRY.forEach((adapter, index) => {
      if (request !== null && providers[adapter.key]) {
        requests.push(queries[index].refetch());
      }
    });
    await Promise.allSettled(requests);
  }, [providers, queries, request]);

  return {
    hits: stableHits,
    failures: merged.failures,
    enabledProviderCount,
    status,
    isFetchingNextPage,
    hasNextPage: PROVIDER_REGISTRY.some((adapter, index) =>
      enabledByKey(adapter.key) && Boolean(queries[index].hasNextPage)),
    fetchNextPage,
    refetch,
    noteSeen,
  };
}
