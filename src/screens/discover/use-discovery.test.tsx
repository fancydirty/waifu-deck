import { DatabaseSync } from 'node:sqlite';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';

import type { CollectionService } from '@/features/collection/collection-service';
import { collectionQueryKey } from '@/features/collection/collection-query';
import { migrateDatabase } from '@/db/schema';
import { createDataResetCoordinator } from '@/features/data-reset/data-reset-coordinator';
import type {
  DecisionResult,
  DiscoveryService,
  RefillResult,
  RewindResult,
} from '@/features/discovery/discovery-service';
import { createDiscoveryService } from '@/features/discovery/discovery-service';
import {
  createImageRepository,
} from '@/features/images/image-repository';
import type {
  RestoredDeck,
  StoredImage,
} from '@/features/images/image-repository';
import {
  DEFAULT_SETTINGS,
  discoverySettingsIdentity,
} from '@/features/settings/settings';
import { DiscoveryProviderError } from '@/features/providers/provider-client';
import { WaifuApiError } from '@/features/waifu/waifu-client';
import { DanbooruApiError } from '@/features/danbooru/danbooru-client';
import type { WaifuImage } from '@/features/waifu/types';
import {
  AppServicesContextProvider,
  createAppQueryClient,
  type AppServicesContextValue,
} from '@/providers/app-services';
import {
  useDiscovery,
  type DiscoverViewModel,
} from '@/screens/discover/use-discovery';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

jest.mock('expo-image', () => ({
  Image: { prefetch: jest.fn() },
}));

function image(id: number, decision: 'active' | 'queued'): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 1000,
    height: 1500,
    byteSize: 100,
    extension: 'jpg',
    dominantColor: '#555555',
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision,
    presentedAt: decision === 'active' ? 1 : null,
    decidedAt: null,
    queueOrdinal: id,
    decisionOrdinal: null,
    localUri: null,
    downloadState: 'none',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
  };
}

function candidate(id: number): WaifuImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 1000,
    height: 1500,
    byteSize: 100,
    extension: '.jpg',
    dominantColor: '#555555',
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
  };
}

const emptyDeck: RestoredDeck = { active: null, queued: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function services(
  discovery: DiscoveryService,
  collectionOverrides: Partial<CollectionService> = {},
  settings: AppServicesContextValue['settings'] = DEFAULT_SETTINGS,
): AppServicesContextValue {
  const collectionService = {
    resumePendingDownloads: jest.fn().mockResolvedValue([]),
    ...collectionOverrides,
  } as unknown as CollectionService;
  return {
    settings,
    dataRevision: 0,
    discoveryService: discovery,
    collectionService,
    imageRepository: {
      listCollection: jest.fn().mockResolvedValue([]),
      getById: jest.fn().mockResolvedValue(null),
    },
  } as unknown as AppServicesContextValue;
}

function discovery(overrides: Partial<DiscoveryService> = {}): DiscoveryService {
  return {
    restore: jest.fn().mockResolvedValue(emptyDeck),
    refill: jest.fn().mockResolvedValue({
      status: 'exhausted',
      inserted: 0,
      deck: emptyDeck,
    } satisfies RefillResult),
    warmReserve: jest.fn().mockResolvedValue({
      status: 'ready',
      inserted: 0,
      deck: emptyDeck,
    } satisfies RefillResult),
    getDeck: jest.fn(() => emptyDeck),
    decide: jest.fn().mockResolvedValue(null),
    rewind: jest.fn().mockResolvedValue({ status: 'empty', deck: emptyDeck } satisfies RewindResult),
    rewindDepth: jest.fn(() => 0),
    subscribeRewindDepth: jest.fn(() => () => undefined),
    invalidateQueuedCandidates: jest.fn().mockResolvedValue(0),
    dropQueuedCandidate: jest.fn().mockResolvedValue(null),
    subscribe: jest.fn(() => () => undefined),
    ...overrides,
  };
}

function wrapper(
  value: AppServicesContextValue,
  queryClient = createAppQueryClient(),
) {
  queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: Infinity },
  });
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AppServicesContextProvider value={value}>
          {children}
        </AppServicesContextProvider>
      </QueryClientProvider>
    );
  };
}

// Backlog #11: the pipeline advances the deck synchronously and drains the
// durable write in the background. This commits and then waits for that drain
// to settle (`isDeciding` back to false) — the point the removed
// `publishDecision()` call used to mark: the refill invalidation is queued.
// Only for real-timer tests whose `decide` mock resolves on its own;
// fake-timer / deferred-decide tests drive the drain explicitly.
async function commitAndDrain(
  result: { current: DiscoverViewModel },
  decision: 'saved' | 'dismissed',
) {
  await act(async () => {
    result.current.commitDecision(decision);
  });
  await waitFor(() => expect(result.current.isDeciding).toBe(false));
}

describe('useDiscovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Image.prefetch).mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('restores SQLite before refill without owning collection recovery', async () => {
    const restore = deferred<RestoredDeck>();
    const service = discovery({
      restore: jest.fn(() => restore.promise),
      refill: jest.fn().mockResolvedValue({
        status: 'exhausted', inserted: 0, deck: emptyDeck,
      }),
    });
    const resumePendingDownloads = jest.fn().mockResolvedValue([]);
    const value = services(service, { resumePendingDownloads });

    await renderHook(() => useDiscovery(), { wrapper: wrapper(value) });

    expect(service.restore).toHaveBeenCalledTimes(1);
    expect(service.refill).not.toHaveBeenCalled();
    expect(resumePendingDownloads).not.toHaveBeenCalled();

    await act(async () => restore.resolve(emptyDeck));
    await waitFor(() => expect(service.refill).toHaveBeenCalledTimes(1));
  });

  test('refills when candidate depth reaches the low-water mark', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued')],
    };
    const service = discovery({ restore: jest.fn().mockResolvedValue(deck) });

    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(service.refill).toHaveBeenCalledTimes(1));
  });

  test('first-card streaming: a deck published mid-refill shows the card before the refill settles', async () => {
    const refill = deferred<RefillResult>();
    let listener: ((deck: RestoredDeck) => void) | null = null;
    const service = discovery({
      refill: jest.fn(() => refill.promise),
      subscribe: jest.fn((next: (deck: RestoredDeck) => void) => {
        listener = next;
        return () => { listener = null; };
      }),
    });

    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });
    await waitFor(() => expect(service.refill).toHaveBeenCalledTimes(1));
    expect(result.current.state.kind).toBe('loading');
    expect(service.subscribe).toHaveBeenCalledTimes(1);

    // The fastest source landed: the service publishes a deck with an active
    // card while the refill promise is still pending.
    // Every publish is driven through `await act(async () => ...)` — this
    // file's convention (:175/:319/:405/:1235). A bare synchronous `act()`
    // inside an async test leaves React's act queue open and every later test
    // in the file stops seeing its updates.
    await act(async () => {
      listener?.({ active: image(1, 'active'), queued: [] });
    });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(result.current.state.deck.active?.id).toBe(1);

    // A later, deeper snapshot replaces it; a shallower one never does.
    await act(async () => {
      listener?.({ active: image(1, 'active'), queued: [image(2, 'queued')] });
    });
    await waitFor(() => expect(result.current.state.deck.queued).toHaveLength(1));
    await act(async () => {
      listener?.({ active: image(1, 'active'), queued: [] });
    });
    expect(result.current.state.deck.queued).toHaveLength(1);

    await act(async () => refill.resolve({
      status: 'ready',
      inserted: 6,
      deck: { active: image(1, 'active'), queued: [image(2, 'queued')] },
    }));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
  });

  test('warms metadata in the background after a usable foreground deck is restored', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [2, 3, 4, 5, 6].map((id) => image(id, 'queued')),
    };
    const warmedDeck = {
      active: deck.active,
      queued: [...deck.queued, ...Array.from({ length: 9 }, (_, index) => (
        image(20 + index, 'queued')
      ))],
    };
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      warmReserve: jest.fn().mockResolvedValue({
        status: 'ready', inserted: 9, deck: warmedDeck,
      }),
    });
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(service.warmReserve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.result.current.state.deck.queued).toHaveLength(14));
    expect(service.refill).not.toHaveBeenCalled();
  });

  test('keeps a usable card ready when background reserve warming fails', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [2, 3, 4, 5, 6].map((id) => image(id, 'queued')),
    };
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      warmReserve: jest.fn().mockRejectedValue(
        new WaifuApiError('rate_limited', 'slow down', { retryAfterMs: 5_000 }),
      ),
    });
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(service.warmReserve).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    expect(hook.result.current.state.deck.active?.id).toBe(1);
  });

  test('board #19: a rejected refill leaves the active + queued cards swipeable', async () => {
    // A refill failure while cards are still on the deck must never hide
    // them: `deck.active !== null` wins over `refillQuery.isError` in the
    // state memo. Pinned so the provider error-policy change cannot regress it.
    const deck = { active: image(1, 'active'), queued: [image(2, 'queued')] };
    const failure = new DiscoveryProviderError([
      { providerKey: 'safebooru', code: 'invalid_response', message: 'Safebooru returned invalid JSON' },
    ]);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      refill: jest.fn().mockRejectedValue(failure),
      warmReserve: jest.fn().mockRejectedValue(failure),
      getDeck: jest.fn(() => deck),
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(service.refill).toHaveBeenCalled());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(result.current.state.deck.active?.id).toBe(1);
    expect(result.current.state.deck.queued.map((queued) => queued.id)).toEqual([2]);
  });

  test('does not abort in-flight reserve warming when a decision is published', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [2, 3, 4, 5, 6].map((id) => image(id, 'queued')),
    };
    const nextDeck = {
      active: image(2, 'active'),
      queued: [3, 4, 5, 6].map((id) => image(id, 'queued')),
    };
    const reserve = deferred<RefillResult>();
    let reserveSignal: AbortSignal | undefined;
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      warmReserve: jest.fn((_settings, signal) => {
        reserveSignal = signal;
        return reserve.promise;
      }),
      decide: jest.fn().mockResolvedValue({
        imageId: 1,
        decision: 'dismissed',
        deck: nextDeck,
      }),
    });
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(service.warmReserve).toHaveBeenCalledTimes(1));
    await commitAndDrain(hook.result, 'dismissed');

    expect(reserveSignal?.aborted).toBe(false);
    await act(async () => reserve.resolve({
      status: 'ready',
      inserted: 0,
      deck: nextDeck,
    }));
  });

  test('cancels the stale refill and uses the new context settings snapshot', async () => {
    const staleRefill = deferred<RefillResult>();
    const nekosCard = {
      ...image(2, 'active'),
      providerKey: 'nekos_api' as const,
      providerItemId: 'nekos-2',
    };
    const refill = jest.fn()
      .mockImplementationOnce(() => staleRefill.promise)
      .mockResolvedValue({
        status: 'ready',
        inserted: 1,
        deck: { active: nekosCard, queued: [] },
      });
    const service = discovery({ refill });
    const value = services(service);
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value),
    });
    await waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    const staleSignal = refill.mock.calls[0][1] as AbortSignal;

    value.settings = {
      ...DEFAULT_SETTINGS,
      providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    };
    await hook.rerender(undefined);

    await waitFor(() => expect(staleSignal.aborted).toBe(true));
    await waitFor(() => expect(refill).toHaveBeenCalledTimes(2));
    expect(refill.mock.calls[1][0]).toEqual(value.settings);
    await act(async () => staleRefill.reject(
      new DiscoveryProviderError([{
        providerKey: 'waifu_im',
        code: 'network',
        message: 'stale Waifu failure',
      }]),
    ));
    await waitFor(() => expect(hook.result.current.state).toMatchObject({
      kind: 'ready',
      deck: { active: { providerKey: 'nekos_api' } },
    }));
  });

  test('partial delete-all publication synchronizes an empty service deck before refilling with preserved settings', async () => {
    const cachedDeck = {
      active: image(1, 'active'),
      queued: [2, 3, 4].map((id) => image(id, 'queued')),
    };
    const refillResult = deferred<RefillResult>();
    const refilledDeck = {
      active: image(1, 'active'),
      queued: [image(9, 'queued')],
    };
    const refill = jest.fn((_settings: AppServicesContextValue['settings']) => (
      refillResult.promise
    ));
    const service = discovery({
      restore: jest.fn().mockResolvedValue(cachedDeck),
      getDeck: jest.fn(() => emptyDeck),
      refill,
    });
    const value = services(service) as AppServicesContextValue & {
      dataRevision: number;
    };
    value.dataRevision = 0;
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value),
    });
    await waitFor(() => expect(hook.result.current.state.deck.queued).toHaveLength(3));
    expect(refill).toHaveBeenCalledTimes(1);

    value.dataRevision += 1;
    await hook.rerender(undefined);

    await waitFor(() => expect(service.getDeck).toHaveBeenCalled());
    await waitFor(() => expect(hook.result.current.state.deck).toEqual(emptyDeck));
    await waitFor(() => expect(refill).toHaveBeenCalledTimes(1));
    expect(refill.mock.calls[0][0]).toBe(value.settings);
    await act(async () => refillResult.resolve({
      status: 'ready', inserted: 1, deck: refilledDeck,
    }));
    await waitFor(() => expect(hook.result.current.state.deck.queued[0]?.id).toBe(9));
  });

  test('R8.16-C: a prefetch failure swaps the dead queued card out before it surfaces', async () => {
    // TWO snapshots, not one shared mutable object: the query cache keeps the
    // restore-time snapshot by reference, so ONLY the hook's publish (the code
    // under test) can make the dropped card disappear from the cache. A shared
    // object would let the assertion pass with the publish deleted (verified
    // non-discriminating by the 2026-09-08 re-review).
    const restoredDeck: RestoredDeck = {
      active: image(1, 'active'),
      queued: [2, 3, 4].map((id) => image(id, 'queued')),
    };
    const postDropDeck: RestoredDeck = {
      active: restoredDeck.active,
      queued: restoredDeck.queued.filter((item) => item.id !== 3),
    };
    const dropQueuedCandidate = jest.fn().mockResolvedValue(postDropDeck);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(restoredDeck),
      dropQueuedCandidate,
    });

    // URL for card 2 prefetches fine; card 3's URL is dead.
    jest.mocked(Image.prefetch).mockImplementation(
      (urls: string | string[]) => Promise.resolve(
        !(urls as string[]).includes('https://cdn.example.com/3.jpg'),
      ),
    );

    const client = createAppQueryClient();
    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(
        services(service, {}, DEFAULT_SETTINGS),
        client,
      ),
    });

    // The dead queued card (id 3) is dropped; the healthy ones are not.
    await waitFor(() => expect(dropQueuedCandidate).toHaveBeenCalledWith(3));
    expect(dropQueuedCandidate).toHaveBeenCalledTimes(1);

    // Drift finding 2: the post-drop deck must be PUBLISHED so the depth
    // guard can react (a drop invisible to the query cache leaves needsRefill
    // blind until the next decide).
    await waitFor(() => {
      const published = client.getQueryData<RestoredDeck>(['discovery', 'deck']);
      expect(published).toMatchObject({ active: { id: 1 } });
      const queuedIds = (published?.queued ?? []).map((item) => item.id);
      expect(queuedIds).toContain(2);
      expect(queuedIds).toContain(4);
      expect(queuedIds).not.toContain(3);
    });
  });

  test('prefetches every queued card up to prefetchDepth once with memory-disk policy', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [2, 3, 4, 5].map((id) => image(id, 'queued')),
    };
    const service = discovery({ restore: jest.fn().mockResolvedValue(deck) });
    const { rerender } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, { ...DEFAULT_SETTINGS, prefetchDepth: 30 })),
    });

    // R8.16-C: prefetch is one call per URL (single-URL attribution), not a
    // batched array, so failures map to a specific queued card. R8.20: the
    // window is prefetchDepth (30+), so all four queued cards are warmed.
    await waitFor(() => expect(Image.prefetch).toHaveBeenCalledTimes(4));
    for (const item of deck.queued) {
      expect(Image.prefetch).toHaveBeenCalledWith(item.remoteUrl, { cachePolicy: 'memory-disk' });
    }
    await rerender(undefined);
    expect(Image.prefetch).toHaveBeenCalledTimes(4);
  });

  test('R8.20: a deck shift prefetches only the newly queued url, never re-issues warmed ones', async () => {
    const first = {
      active: image(1, 'active'),
      queued: [2, 3, 4].map((id) => image(id, 'queued')),
    };
    const shifted = {
      active: image(2, 'active'),
      queued: [3, 4, 5].map((id) => image(id, 'queued')),
    };
    const restore = jest.fn().mockResolvedValue(first);
    const service = discovery({ restore, getDeck: jest.fn().mockReturnValue(shifted) });
    const client = createAppQueryClient();
    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, { ...DEFAULT_SETTINGS, prefetchDepth: 30 }), client),
    });
    await waitFor(() => expect(Image.prefetch).toHaveBeenCalledTimes(3));

    // Advance the deck one card (what a decision publish does).
    await act(async () => {
      client.setQueryData(['discovery', 'deck'], shifted);
    });

    // With a 30-deep window every swipe re-slices the whole queue; without a
    // per-session dedupe that meant ~30 redundant Glide loads per swipe.
    await waitFor(() => expect(Image.prefetch).toHaveBeenCalledWith(
      image(5, 'queued').remoteUrl, { cachePolicy: 'memory-disk' },
    ));
    expect(Image.prefetch).toHaveBeenCalledTimes(4);
  });

  test('R8.20: the prefetch window follows prefetchDepth when more cards are queued than the window', async () => {
    const queued = Array.from({ length: 70 }, (_, index) => {
      const id = index + 2;
      return {
        ...image(id, 'queued'),
        sampleUrl: `https://cdn.example.com/${id}-sample.jpg`,
      };
    });
    const deck = { active: image(1, 'active'), queued };
    const service = discovery({ restore: jest.fn().mockResolvedValue(deck) });

    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, {
        ...DEFAULT_SETTINGS,
        prefetchDepth: 60,
      })),
    });

    // The prefetch window is settings.prefetchDepth (60), not the much
    // smaller first-paint batch: exactly the first 60 queued sample urls are
    // warmed, in queue order.
    await waitFor(() => expect(Image.prefetch).toHaveBeenCalledTimes(60));
    queued.slice(0, 60).forEach((card, index) => {
      expect(Image.prefetch).toHaveBeenNthCalledWith(
        index + 1,
        card.sampleUrl,
        { cachePolicy: 'memory-disk' },
      );
    });
    expect(Image.prefetch).not.toHaveBeenCalledWith(
      queued[60]?.sampleUrl,
      { cachePolicy: 'memory-disk' },
    );
  });

  test('R8.20: increasing prefetchDepth reserves to a new target instead of reusing the stale reserve cache', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [2, 3, 4, 5, 6].map((id) => image(id, 'queued')),
    };
    const warmReserve = jest.fn().mockResolvedValue({
      status: 'ready',
      inserted: 0,
      deck,
    } satisfies RefillResult);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      getDeck: jest.fn(() => deck),
      warmReserve,
    });
    const value = services(service, {}, { ...DEFAULT_SETTINGS, prefetchDepth: 40 });
    const hook = await renderHook(() => useDiscovery(), { wrapper: wrapper(value) });

    await waitFor(() => expect(warmReserve).toHaveBeenCalledTimes(1));

    // discoverySettingsIdentity does not include prefetchDepth, so only the
    // reserve query key's own reserveTarget component can distinguish 40 from
    // 60 and trigger a fresh warm at the new target — a stale cached reserve
    // at 40 would otherwise never be topped up to 60.
    value.settings = { ...value.settings, prefetchDepth: 60 };
    await hook.rerender(undefined);

    await waitFor(() => expect(warmReserve).toHaveBeenCalledTimes(2));
    expect(warmReserve.mock.calls[1][0]).toMatchObject({ prefetchDepth: 60 });
  });

  test('deck jank: a swipe that leaves the reserve above its low-water mark warms nothing', async () => {
    // Owner report 2026-09-17 「发现tab 左滑右滑又开始卡了」. Measured on the
    // emulator with the deck at the reserve target (40): EVERY swipe dropped
    // depth to 39 < 40, which re-armed the reserve query and fired a whole
    // multi-source network round (~2 KB egress, 1 row inserted, a Hermes
    // microtask burst that queued behind touch handling — 54.82% of JS time in
    // performMicrotaskCheckpoint). The reserve only needs to refill when it
    // has genuinely drained: below half the target.
    const queued = Array.from({ length: 39 }, (_, index) => image(index + 2, 'queued'));
    const deck = { active: image(1, 'active'), queued };
    const afterSwipe = { active: image(2, 'active'), queued: queued.slice(1) };
    const warmReserve = jest.fn().mockResolvedValue({
      status: 'ready',
      inserted: 0,
      deck,
    } satisfies RefillResult);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      getDeck: jest.fn(() => deck),
      warmReserve,
      decide: jest.fn().mockResolvedValue({
        imageId: 1,
        decision: 'dismissed',
        deck: afterSwipe,
      }),
    });
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, { ...DEFAULT_SETTINGS, prefetchDepth: 40 })),
    });
    await waitFor(() => expect(hook.result.current.state.kind).toBe('ready'));
    // 40 cards on hand = at target: nothing to warm.
    expect(warmReserve).not.toHaveBeenCalled();

    await commitAndDrain(hook.result, 'dismissed');

    // 39 on hand is still far above the low-water mark (20): no network round.
    expect(warmReserve).not.toHaveBeenCalled();
  });

  test('deck jank: the reserve warms once depth drains to the low-water mark', async () => {
    const queued = Array.from({ length: 19 }, (_, index) => image(index + 2, 'queued'));
    const deck = { active: image(1, 'active'), queued };
    const warmReserve = jest.fn().mockResolvedValue({
      status: 'ready',
      inserted: 0,
      deck,
    } satisfies RefillResult);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      getDeck: jest.fn(() => deck),
      warmReserve,
    });
    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, { ...DEFAULT_SETTINGS, prefetchDepth: 40 })),
    });
    // 20 on hand = exactly the low-water mark for a 40 target: warm now.
    await waitFor(() => expect(warmReserve).toHaveBeenCalledTimes(1));
    expect(warmReserve.mock.calls[0][0]).toMatchObject({ prefetchDepth: 40 });
  });

  test('R8.18: prefetches the sample url, not the full-resolution original', async () => {
    const deck = {
      active: image(1, 'active'),
      queued: [2, 3].map((id) => ({
        ...image(id, 'queued'),
        remoteUrl: `https://cdn.example.com/${id}-original.png`,
        sampleUrl: `https://cdn.example.com/${id}-sample.jpg`,
      })),
    };
    const service = discovery({ restore: jest.fn().mockResolvedValue(deck) });
    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, DEFAULT_SETTINGS)),
    });

    await waitFor(() => expect(Image.prefetch).toHaveBeenCalledTimes(2));
    expect(Image.prefetch).toHaveBeenCalledWith('https://cdn.example.com/2-sample.jpg', { cachePolicy: 'memory-disk' });
    expect(Image.prefetch).toHaveBeenCalledWith('https://cdn.example.com/3-sample.jpg', { cachePolicy: 'memory-disk' });
    expect(Image.prefetch).not.toHaveBeenCalledWith('https://cdn.example.com/2-original.png', { cachePolicy: 'memory-disk' });
  });

  test('R8.28: the prefetch carries each provider\'s required image headers', async () => {
    // The deck warms urls through Image.prefetch, so a hotlink-protected CDN
    // needs its Referer here too — otherwise the warm caches Gelbooru's
    // hotlink.php HTML and the card renders solid from cache.
    const deck = {
      active: image(1, 'active'),
      queued: [
        {
          ...image(2, 'queued'),
          providerKey: 'gelbooru' as const,
          sampleUrl: 'https://img4.gelbooru.com/samples/a/b/sample_2.jpg',
        },
        {
          ...image(3, 'queued'),
          providerKey: 'danbooru' as const,
          sampleUrl: 'https://cdn.donmai.us/sample/3.jpg',
        },
      ],
    };
    const service = discovery({ restore: jest.fn().mockResolvedValue(deck) });
    await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service, {}, DEFAULT_SETTINGS)),
    });

    await waitFor(() => expect(Image.prefetch).toHaveBeenCalledTimes(2));
    expect(Image.prefetch).toHaveBeenCalledWith(
      'https://img4.gelbooru.com/samples/a/b/sample_2.jpg',
      { cachePolicy: 'memory-disk', headers: { Referer: 'https://gelbooru.com/' } },
    );
    // A headerless source keeps the exact options object it had before R8.28.
    expect(Image.prefetch).toHaveBeenCalledWith(
      'https://cdn.donmai.us/sample/3.jpg',
      { cachePolicy: 'memory-disk' },
    );
  });

  test('preserves a restored card as usable offline when refill fails', async () => {
    const deck = { active: image(1, 'active'), queued: [] };
    const service = discovery({
      restore: jest.fn().mockResolvedValue(deck),
      refill: jest.fn().mockRejectedValue(new WaifuApiError('network', 'offline')),
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(result.current.state.deck.active?.id).toBe(1);
  });

  // R8.13: the owner swiped the deck empty and the screen stuck on
  // 「正在加载，请稍候」forever. A refill that returns `invalidated` (or any
  // non-exhausted result with an empty deck) fell through the state machine
  // to `{ kind: 'loading' }` with no query left enabled to change it.
  test('R8.13: an invalidated refill on an empty deck retries instead of loading forever', async () => {
    let calls = 0;
    const service = discovery({
      restore: jest.fn().mockResolvedValue(emptyDeck),
      refill: jest.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          return { status: 'invalidated', inserted: 0, deck: emptyDeck } satisfies RefillResult;
        }
        return { status: 'exhausted', inserted: 0, deck: emptyDeck } satisfies RefillResult;
      }),
    });

    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    // First refill came back invalidated with no cards anywhere: the screen
    // must NOT park on a dead loading state — it retries the refill.
    await waitFor(() => expect(service.refill).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.state.kind).toBe('exhausted'));
  });

  test('R8.13: a ready-but-empty refill converges to exhausted rather than loading forever', async () => {
    const service = discovery({
      restore: jest.fn().mockResolvedValue(emptyDeck),
      // Real shape observed when insertCandidates suppresses everything yet
      // the service still reports the deck it saw: status 'ready', deck empty.
      refill: jest.fn().mockResolvedValue({
        status: 'ready', inserted: 0, deck: emptyDeck,
      } satisfies RefillResult),
    });

    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(hook.result.current.state.kind).toBe('exhausted'));
  });

  test('distinguishes offline-empty from bounded exhaustion', async () => {
    const offline = discovery({
      refill: jest.fn().mockRejectedValue(new WaifuApiError('network', 'offline')),
    });
    const offlineHook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(offline)),
    });
    await waitFor(() => expect(offlineHook.result.current.state.kind).toBe('offline'));
    await offlineHook.unmount();

    const exhausted = discovery();
    const exhaustedHook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(exhausted)),
    });
    await waitFor(() => expect(exhaustedHook.result.current.state.kind).toBe('exhausted'));
    expect(exhaustedHook.result.current.state.deck.active).toBeNull();
    expect(exhaustedHook.result.current.state.message).toContain('调整筛选');
  });

  test('exposes provider names when every enabled source is unreachable', async () => {
    const failure = new DiscoveryProviderError([
      { providerKey: 'nekos_api', code: 'network', message: 'offline' },
      { providerKey: 'danbooru', code: 'timeout', message: 'timed out' },
    ]);
    const service = discovery({ refill: jest.fn().mockRejectedValue(failure) });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(result.current.state).toMatchObject({
      kind: 'offline',
      message: 'Nekos API、Danbooru 当前无法连接，请检查网络后重试',
    }));
  });

  test('recognizes a Danbooru network failure as offline', async () => {
    const offline = discovery({
      refill: jest.fn().mockRejectedValue(
        new DanbooruApiError('network', 'offline'),
      ),
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(offline)),
    });

    await waitFor(() => expect(result.current.state.kind).toBe('offline'));
  });

  test('advances the visible deck the instant a swipe commits, persisting in the background', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const nextDeck = {
      active: image(2, 'active'),
      queued: [image(3, 'queued'), image(4, 'queued')],
    };
    const pending = deferred<DecisionResult | null>();
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide: jest.fn(() => pending.promise),
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });
    await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

    let accepted!: boolean;
    await act(async () => {
      accepted = result.current.commitDecision('saved');
    });

    // The advance is optimistic: the deck shows card 2 before decide() resolves.
    expect(accepted).toBe(true);
    expect(result.current.state.deck.active?.id).toBe(2);
    expect(service.decide).toHaveBeenCalledTimes(1);
    expect(result.current.isDeciding).toBe(true);

    await act(async () => {
      pending.resolve({ imageId: 1, decision: 'saved', deck: nextDeck });
      await pending.promise;
    });

    // The durable write landed; the deck is unchanged (advance already applied)
    // and the queue is idle.
    expect(result.current.state.deck.active?.id).toBe(2);
    expect(result.current.isDeciding).toBe(false);
  });

  test('keeps canDecide true while a decide drains and queues the next card', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const gates = [deferred<DecisionResult | null>(), deferred<DecisionResult | null>()];
    const decide = jest.fn()
      .mockImplementationOnce(() => gates[0].promise)
      .mockImplementationOnce(() => gates[1].promise);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide,
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });
    await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

    await act(async () => {
      expect(result.current.canDecide).toBe(true);
      expect(result.current.commitDecision('saved')).toBe(true);
    });
    expect(result.current.isDeciding).toBe(true);
    expect(result.current.canDecide).toBe(true);

    await act(async () => {
      expect(result.current.commitDecision('dismissed')).toBe(true);
    });
    expect(result.current.canDecide).toBe(true);
    expect(result.current.state.deck.active?.id).toBe(3);
    expect(decide).toHaveBeenCalledTimes(1);

    await act(async () => {
      gates[0].resolve({ imageId: 1, decision: 'saved', deck: firstDeck });
      await Promise.resolve();
    });
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide.mock.calls[1][0]).toBe(2);

    await act(async () => {
      gates[1].resolve({ imageId: 2, decision: 'dismissed', deck: firstDeck });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isDeciding).toBe(false));
  });

  test('canDecide is false without an active card', async () => {
    const service = discovery({ restore: jest.fn().mockResolvedValue(emptyDeck) });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });

    await waitFor(() => expect(result.current.state.kind).toBe('exhausted'));
    expect(result.current.canDecide).toBe(false);
  });

  test('accepts back-to-back fast swipes, advancing one card each and deciding in FIFO order', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued'), image(4, 'queued')],
    };
    const gate = [deferred<DecisionResult | null>(), deferred<DecisionResult | null>()];
    const decide = jest.fn()
      .mockImplementationOnce(() => gate[0].promise)
      .mockImplementationOnce(() => gate[1].promise);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide,
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });
    await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

    await act(async () => {
      expect(result.current.commitDecision('saved')).toBe(true);
      expect(result.current.commitDecision('dismissed')).toBe(true);
    });

    // Both swipes advanced the visible deck; neither was dropped.
    expect(result.current.state.deck.active?.id).toBe(3);
    // The consumer is serial: only the first decision is in flight.
    expect(decide).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate[0].resolve({
        imageId: 1,
        decision: 'saved',
        deck: firstDeck,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide.mock.calls[0][0]).toBe(1);
    expect(decide.mock.calls[0][1]).toBe('saved');
    expect(decide.mock.calls[1][0]).toBe(2);
    expect(decide.mock.calls[1][1]).toBe('dismissed');

    await act(async () => {
      gate[1].resolve({
        imageId: 2,
        decision: 'dismissed',
        deck: firstDeck,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isDeciding).toBe(false));
  });

  test('two fast swipes keep each decision on the card that was on screen', async () => {
    const nativeDatabase = new DatabaseSync(':memory:');
    try {
      const database = createNodeSqliteAdapter(nativeDatabase);
      await migrateDatabase(database);
      const repository = createImageRepository(database);
      await repository.insertCandidates([1, 2, 3].map(candidate));
      const originalDecide = repository.decide.bind(repository);
      const decide = jest.spyOn(repository, 'decide')
        .mockImplementationOnce(async () => null)
        .mockImplementation((imageId, decision, decidedAt) => (
          originalDecide(imageId, decision, decidedAt)
        ));
      const service = createDiscoveryService({
        repository,
        coordinator: createDataResetCoordinator(),
        fetchBatch: async () => ({ items: [], totalCount: 0 }),
        clock: () => 1_000,
      });
      const { result } = await renderHook(() => useDiscovery(), {
        wrapper: wrapper(services(service)),
      });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      await act(async () => {
        expect(result.current.commitDecision('saved')).toBe(true);
        expect(result.current.commitDecision('dismissed')).toBe(true);
      });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));

      expect(decide.mock.calls.map(([imageId]) => imageId)).toEqual([1, 2]);
      expect(result.current.state.deck.active?.id).toBe(3);
      expect(result.current.decisionError).toBe('未能完成操作，请重试');
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'queued' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a data-revision republish never clobbers the deck under an in-flight commit', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const pending = deferred<DecisionResult | null>();
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      // Republishing THIS mid-drain would blank the deck the user is looking at.
      getDeck: jest.fn(() => emptyDeck),
      decide: jest.fn(() => pending.promise),
    });
    const value = services(service) as AppServicesContextValue & {
      dataRevision: number;
    };
    value.dataRevision = 0;
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    await act(async () => {
      hook.result.current.commitDecision('saved');
    });
    // The optimistic advance is already applied; the durable write is draining.
    expect(hook.result.current.state.deck.active?.id).toBe(2);

    // A collection mutation bumps dataRevision mid-drain. Republishing the
    // service deck (empty) while the queue is busy would clobber the advance.
    value.dataRevision += 1;
    await hook.rerender(undefined);

    expect(hook.result.current.state.deck.active?.id).toBe(2);

    await act(async () => {
      pending.resolve({
        imageId: 1,
        decision: 'saved',
        deck: firstDeck,
      });
      await Promise.resolve();
    });

    // Drain settled; the advance stands.
    expect(hook.result.current.state.deck.active?.id).toBe(2);
  });

  /**
   * K7 cut 5b (audit ⑧): a right swipe used to re-read and re-map the WHOLE
   * collection twice — once on the decision, once when the background download
   * finished. The saved row is the only row that changed, so it is the only
   * row that gets read. `listCollection` must stay at zero on the warm path.
   */
  test('patches the saved row into the collection snapshot without re-reading the collection', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [2, 3, 4].map((id) => image(id, 'queued')),
    };
    const olderSaved = {
      ...image(9, 'active'),
      decision: 'saved' as const,
      decidedAt: 1_000,
      localUri: 'file:///collection/9.jpg',
      downloadState: 'ready' as const,
    };
    const pendingSaved = {
      ...image(1, 'active'),
      decision: 'saved' as const,
      decidedAt: 2_000,
      localUri: null,
      downloadState: 'pending' as const,
    };
    const readySaved = {
      ...pendingSaved,
      localUri: 'file:///collection/1.jpg',
      downloadState: 'ready' as const,
    };
    const backgroundDownload = deferred<{ status: 'ready' }>();
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide: jest.fn().mockResolvedValue({
        imageId: 1,
        decision: 'saved',
        deck: { active: image(2, 'active'), queued: [] },
        backgroundDownload: backgroundDownload.promise,
      }),
    });
    const value = services(service);
    const listCollection = jest.fn().mockResolvedValue([olderSaved]);
    const getById = jest.fn()
      .mockResolvedValueOnce(pendingSaved)
      .mockResolvedValue(readySaved);
    value.imageRepository = {
      listCollection,
      getById,
    } as unknown as AppServicesContextValue['imageRepository'];
    const queryClient = createAppQueryClient();
    // gcTime Infinity before seeding, so the collection query built here shares
    // the wrapper's no-gc policy instead of scheduling a 5-minute gc timer that
    // outlives the test (the patch path never observes this key).
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    // The collection tab is already mounted: a snapshot exists to patch.
    queryClient.setQueryData(collectionQueryKey(), [olderSaved]);
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value, queryClient),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    await act(async () => hook.result.current.commitDecision('saved'));

    await waitFor(() => {
      expect(queryClient.getQueryData(collectionQueryKey()))
        .toEqual([pendingSaved, olderSaved]);
    });
    expect(getById).toHaveBeenCalledWith(1);
    expect(listCollection).not.toHaveBeenCalled();

    value.dataRevision = 1;
    await hook.rerender(undefined);

    await act(async () => backgroundDownload.resolve({ status: 'ready' }));
    await waitFor(() => {
      expect(queryClient.getQueryData(collectionQueryKey()))
        .toEqual([readySaved, olderSaved]);
    });
    // Two single-row reads for the whole save: the decision and the download.
    expect(getById).toHaveBeenCalledTimes(2);
    expect(listCollection).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('row24: without a collection snapshot a save neither reads the collection nor seeds a snapshot', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued')],
    };
    const backgroundDownload = deferred<{ status: 'ready' }>();
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide: jest.fn().mockResolvedValue({
        imageId: 1,
        decision: 'saved',
        deck: { active: image(2, 'active'), queued: [] },
        backgroundDownload: backgroundDownload.promise,
      }),
    });
    const value = services(service);
    const listCollection = jest.fn().mockResolvedValue([]);
    const getById = jest.fn().mockResolvedValue(null);
    value.imageRepository = {
      listCollection,
      getById,
    } as unknown as AppServicesContextValue['imageRepository'];
    const queryClient = createAppQueryClient();
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value, queryClient),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    await commitAndDrain(hook.result, 'saved');
    await act(async () => backgroundDownload.resolve({ status: 'ready' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The 收藏 tab reads the database itself when it mounts. A Discover save
    // never seeds that snapshot — and never writes an empty one that
    // `staleTime: Infinity` would then show as an empty 收藏.
    expect(queryClient.getQueryData(collectionQueryKey())).toBeUndefined();
    expect(listCollection).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });

  test('a dismissed swipe touches the collection snapshot not at all', async () => {
    const service = discovery({
      restore: jest.fn().mockResolvedValue({
        active: image(1, 'active'),
        queued: [image(2, 'queued')],
      }),
      decide: jest.fn().mockResolvedValue({
        imageId: 1,
        decision: 'dismissed',
        deck: { active: image(2, 'active'), queued: [] },
      }),
    });
    const value = services(service);
    const listCollection = jest.fn().mockResolvedValue([]);
    const getById = jest.fn().mockResolvedValue(null);
    value.imageRepository = {
      listCollection,
      getById,
    } as unknown as AppServicesContextValue['imageRepository'];
    const queryClient = createAppQueryClient();
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value, queryClient),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    await commitAndDrain(hook.result, 'dismissed');

    expect(hook.result.current.state.deck.active?.id).toBe(2);
    expect(listCollection).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(collectionQueryKey())).toBeUndefined();
  });

  test('a slow collection snapshot never holds the decision lock past the write', async () => {
    // Owner report: "多次快速右滑会卡住". Right swipe is the saved path, and it
    // awaited publishCollectionSnapshot while still holding committing.current.
    // Left swipe never ran that await, so only right swipe stalled — an
    // asymmetry no symmetric animation constant could explain. Board #24: the
    // saved path publishes one row now; the same rule holds for a slow row read.
    const slowRow = deferred<StoredImage | null>();
    const service = discovery({
      restore: jest.fn().mockResolvedValue({
        active: image(1, 'active'),
        queued: [image(2, 'queued'), image(3, 'queued')],
      }),
      decide: jest.fn()
        .mockResolvedValueOnce({
          imageId: 1,
          decision: 'saved',
          deck: { active: image(2, 'active'), queued: [image(3, 'queued')] },
        })
        .mockResolvedValueOnce({
          imageId: 2,
          decision: 'saved',
          deck: { active: image(3, 'active'), queued: [] },
        }),
    });
    const value = services(service);
    value.imageRepository = {
      listCollection: jest.fn().mockResolvedValue([]),
      getById: jest.fn().mockReturnValue(slowRow.promise),
    } as unknown as AppServicesContextValue['imageRepository'];
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    queryClient.setQueryData(collectionQueryKey(), []);
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(value, queryClient),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    let first!: boolean;
    await act(async () => {
      first = hook.result.current.commitDecision('saved');
    });
    expect(first).toBe(true);
    await waitFor(() => expect(value.imageRepository.getById).toHaveBeenCalledWith(1));

    // The saved snapshot is fire-and-forget, so a slow one must never block the
    // next decision from draining: the second commit's decide still runs.
    let second!: boolean;
    await act(async () => {
      second = hook.result.current.commitDecision('saved');
    });
    expect(second).toBe(true);
    await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(2));

    await act(async () => {
      slowRow.resolve(null);
      await Promise.resolve();
    });
  });

  test('a refill that settles mid-burst never resurrects an optimistically-swiped card', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued')],
    };
    // The service's own refill result still lists card 1 as active (its durable
    // write is draining behind the burst); publishing it would drag the swiped
    // card back onscreen.
    const serviceDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(9, 'queued')],
    };
    const refill = deferred<RefillResult>();
    const decideGate = deferred<DecisionResult | null>();
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      refill: jest.fn(() => refill.promise),
      decide: jest.fn(() => decideGate.promise),
    });
    const queryClient = createAppQueryClient();
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service), queryClient),
    });
    await waitFor(() => expect(service.refill).toHaveBeenCalledTimes(1));

    await act(async () => {
      hook.result.current.commitDecision('saved');
    });
    expect(hook.result.current.state.deck.active?.id).toBe(2);

    await act(async () => refill.resolve({
      status: 'ready',
      inserted: 1,
      deck: serviceDeck,
    }));
    await waitFor(() => expect(queryClient.getQueryState([
      'discovery',
      'refill',
      discoverySettingsIdentity(DEFAULT_SETTINGS),
    ])?.fetchStatus).toBe('idle'));

    // Still card 2 — the refill publish was blocked while the queue drained.
    // (In production the service's own deck advances as each decide() runs, so a
    // post-drain refill carries the advanced deck; this mock returns a fixed
    // card-1 deck, so we only assert the mid-burst guard, then drain cleanly.)
    expect(hook.result.current.state.deck.active?.id).toBe(2);

    await act(async () => {
      decideGate.resolve({
        imageId: 1,
        decision: 'saved',
        deck: firstDeck,
      });
      await Promise.resolve();
    });
  });

  test('a background decide failure surfaces an error toast without resurrecting the card or wedging the queue', async () => {
    const d1 = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const decide = jest.fn()
      .mockResolvedValueOnce(null) // card 1's durable write fails
      .mockResolvedValueOnce({
        imageId: 2,
        decision: 'dismissed',
        deck: d1,
      });
    const service = discovery({
      restore: jest.fn().mockResolvedValue(d1),
      decide,
    });
    const { result } = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service)),
    });
    await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

    await act(async () => {
      result.current.commitDecision('saved');      // card 1 — its write will fail
      result.current.commitDecision('dismissed');  // card 2
    });
    // The failure did not wedge the queue: both decisions still ran.
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));

    // The deck kept advancing across the failure, and the error surfaced. The
    // failed card's SQLite row stays 'active' and reconciles on the next
    // restore/refill — it is not resurrected into the middle of the burst.
    expect(result.current.state.deck.active?.id).toBe(3);
    expect(result.current.decisionError).toBe('未能完成操作，请重试');
    await waitFor(() => expect(result.current.isDeciding).toBe(false));
  });

  describe('row24: rewind', () => {
    const d1 = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const rewound = (imageId: number, deck: RestoredDeck = d1): RewindResult => ({
      status: 'rewound',
      entry: { imageId, decision: 'dismissed', decidedAt: 5 },
      deck,
    });

    /** A fake service history: `push` is the service publishing a new depth. */
    function history(initial: number) {
      let depth = initial;
      const listeners = new Set<(depth: number) => void>();
      return {
        rewindDepth: jest.fn(() => depth),
        subscribeRewindDepth: jest.fn((listener: (depth: number) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
        push(next: number) {
          depth = next;
          for (const listener of [...listeners]) listener(next);
        },
      };
    }

    /** Renders the hook and records `canRewind` on every render. */
    async function renderRecording(service: DiscoveryService) {
      const seen: boolean[] = [];
      const hook = await renderHook(() => {
        const viewModel = useDiscovery();
        seen.push(viewModel.canRewind);
        return viewModel;
      }, { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));
      return { ...hook, seen };
    }

    test('a rewind tapped right after a swipe waits for that decide, then rewinds exactly it', async () => {
      const decideGate = deferred<DecisionResult | null>();
      let depth = 0;
      const service = discovery({
        restore: jest.fn().mockResolvedValue({ active: image(1, 'active'), queued: [image(2, 'queued')] }),
        decide: jest.fn(() => decideGate.promise),
        rewind: jest.fn().mockResolvedValue({
          status: 'rewound',
          entry: { imageId: 1, decision: 'dismissed', decidedAt: 5 },
          deck: { active: image(1, 'active'), queued: [image(2, 'queued')] },
        }),
        rewindDepth: jest.fn(() => depth),
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      await act(async () => { result.current.commitDecision('dismissed'); });
      expect(result.current.canRewind).toBe(true);                 // the unlanded decide counts
      await act(async () => { expect(result.current.rewind()).toBe(true); });
      expect(service.rewind).not.toHaveBeenCalled();               // FIFO: behind the decide

      await act(async () => {
        depth = 1;
        decideGate.resolve({ imageId: 1, decision: 'dismissed', deck: { active: image(2, 'active'), queued: [] } });
      });
      await waitFor(() => expect(service.rewind).toHaveBeenCalledWith({ imageId: 1 }));   // paired
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));
    });

    test('a rewind paired with a failing decide is cancelled, and the older save is NOT rewound', async () => {
      const decideGate = deferred<DecisionResult | null>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue({ active: image(1, 'active'), queued: [image(2, 'queued')] }),
        decide: jest.fn(() => decideGate.promise),
        rewind: jest.fn(),
        rewindDepth: jest.fn(() => 1),                              // an older save is in the history
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));
      await act(async () => { result.current.commitDecision('dismissed'); });
      await act(async () => { expect(result.current.rewind()).toBe(true); });   // paired with that decide
      await act(async () => { decideGate.resolve(null); });                      // its durable write fails
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(service.rewind).not.toHaveBeenCalled();
      expect(result.current.canRewind).toBe(true);                               // the older entry is untouched
    });

    test('canDecide is false while a rewind waits behind a decide, then true after it ends', async () => {
      const decideGate = deferred<DecisionResult | null>();
      const rewindGate = deferred<RewindResult>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn(() => decideGate.promise),
        rewind: jest.fn(() => rewindGate.promise),
        rewindDepth: jest.fn(() => 1),
      });
      const { result } = await renderHook(() => useDiscovery(), {
        wrapper: wrapper(services(service)),
      });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      await act(async () => {
        expect(result.current.commitDecision('dismissed')).toBe(true);
      });
      expect(result.current.canDecide).toBe(true);

      await act(async () => {
        expect(result.current.rewind()).toBe(true);
      });
      expect(result.current.canDecide).toBe(false);

      await act(async () => {
        decideGate.resolve({
          imageId: 1,
          decision: 'dismissed',
          deck: { active: image(2, 'active'), queued: [image(3, 'queued')] },
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(service.rewind).toHaveBeenCalledWith({ imageId: 1 }));
      expect(result.current.canDecide).toBe(false);

      await act(async () => { rewindGate.resolve(rewound(1)); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(result.current.canDecide).toBe(true);
    });

    test('a swipe is rejected while a rewind op is queued or running', async () => {
      const decideGate = deferred<DecisionResult | null>();
      const rewindGate = deferred<RewindResult>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn(() => decideGate.promise),
        rewind: jest.fn(() => rewindGate.promise),
        rewindDepth: jest.fn(() => 1),
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      // Queued: the rewind waits behind an unlanded swipe.
      await act(async () => { expect(result.current.commitDecision('dismissed')).toBe(true); });
      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await act(async () => { expect(result.current.commitDecision('dismissed')).toBe(false); });
      expect(service.decide).toHaveBeenCalledTimes(1);
      expect(result.current.state.deck.active?.id).toBe(2);        // the rejected swipe did not advance

      // Running: the decide landed and the rewind is in flight.
      await act(async () => {
        decideGate.resolve({ imageId: 1, decision: 'dismissed', deck: { active: image(2, 'active'), queued: [image(3, 'queued')] } });
      });
      await waitFor(() => expect(service.rewind).toHaveBeenCalledWith({ imageId: 1 }));
      await act(async () => { expect(result.current.commitDecision('saved')).toBe(false); });
      expect(service.decide).toHaveBeenCalledTimes(1);

      await act(async () => { rewindGate.resolve(rewound(1)); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(result.current.state.deck.active?.id).toBe(1);
      await act(async () => { expect(result.current.commitDecision('saved')).toBe(true); });
    });

    test.each([
      [0, false],
      [2, true],
    ])('on mount at depth %i canRewind is %s (a remount keeps the history)', async (depth, expected) => {
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        rewindDepth: jest.fn(() => depth),
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));
      expect(result.current.canRewind).toBe(expected);
    });

    test('canRewind never blinks to false while a rewind pops at depth 2', async () => {
      const fake = history(2);
      const rewindGate = deferred<RewindResult>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        rewind: jest.fn(() => rewindGate.promise),
        rewindDepth: fake.rewindDepth,
        subscribeRewindDepth: fake.subscribeRewindDepth,
      });
      const { result, seen } = await renderRecording(service);
      expect(result.current.canRewind).toBe(true);
      seen.length = 0;

      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await act(async () => { fake.push(1); });                    // the service popped, mid-op
      await act(async () => { rewindGate.resolve(rewound(9)); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));

      expect(seen.length).toBeGreaterThan(0);
      expect(seen).not.toContain(false);
      expect(result.current.canRewind).toBe(true);
    });

    test('canRewind never blinks to true while the last rewind pops at depth 1', async () => {
      const fake = history(1);
      const rewindGate = deferred<RewindResult>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        rewind: jest.fn(() => rewindGate.promise),
        rewindDepth: fake.rewindDepth,
        subscribeRewindDepth: fake.subscribeRewindDepth,
      });
      const { result, seen } = await renderRecording(service);
      expect(result.current.canRewind).toBe(true);

      await act(async () => {
        seen.length = 0;
        expect(result.current.rewind()).toBe(true);
      });
      await act(async () => { fake.push(0); });
      await act(async () => { rewindGate.resolve(rewound(9)); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));

      expect(seen.length).toBeGreaterThan(0);
      expect(seen).not.toContain(true);
      expect(result.current.canRewind).toBe(false);
    });

    test('a rewind paired with an unlanded swipe keeps canRewind false through the landing', async () => {
      const fake = history(0);
      const decideGate = deferred<DecisionResult | null>();
      const rewindGate = deferred<RewindResult>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn(() => decideGate.promise),
        rewind: jest.fn(() => rewindGate.promise),
        rewindDepth: fake.rewindDepth,
        subscribeRewindDepth: fake.subscribeRewindDepth,
      });
      const { result, seen } = await renderRecording(service);
      expect(result.current.canRewind).toBe(false);

      await act(async () => { result.current.commitDecision('dismissed'); });
      expect(result.current.canRewind).toBe(true);                 // enabled the instant the swipe commits

      await act(async () => {
        seen.length = 0;
        expect(result.current.rewind()).toBe(true);
      });
      await act(async () => { fake.push(1); });                    // the decide's entry, before it resolves
      await act(async () => {
        decideGate.resolve({ imageId: 1, decision: 'dismissed', deck: { active: image(2, 'active'), queued: [image(3, 'queued')] } });
      });
      await waitFor(() => expect(service.rewind).toHaveBeenCalledWith({ imageId: 1 }));
      await act(async () => { fake.push(0); });                    // the rewind's pop
      await act(async () => { rewindGate.resolve(rewound(1)); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));

      expect(seen.length).toBeGreaterThan(0);
      expect(seen).not.toContain(true);
      expect(result.current.canRewind).toBe(false);
    });

    test('canRewind goes false once the history is used up', async () => {
      const fake = history(2);
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        rewind: jest.fn(async () => {
          fake.push(fake.rewindDepth() - 1);                        // the service pops mid-op
          return rewound(9);
        }),
        rewindDepth: fake.rewindDepth,
        subscribeRewindDepth: fake.subscribeRewindDepth,
      });
      const { result } = await renderRecording(service);

      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(result.current.canRewind).toBe(true);
      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(result.current.canRewind).toBe(false);
      await act(async () => { expect(result.current.rewind()).toBe(false); });
      expect(service.rewind).toHaveBeenCalledTimes(2);
    });

    test('canRewind follows a depth the service publishes while nothing runs (a reset)', async () => {
      const fake = history(2);
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        rewindDepth: fake.rewindDepth,
        subscribeRewindDepth: fake.subscribeRewindDepth,
      });
      const { result } = await renderRecording(service);
      expect(result.current.canRewind).toBe(true);

      await act(async () => { fake.push(0); });
      expect(result.current.canRewind).toBe(false);
      await act(async () => { expect(result.current.rewind()).toBe(false); });
      expect(service.rewind).not.toHaveBeenCalled();
    });

    test('a double tap enqueues one rewind', async () => {
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        rewind: jest.fn().mockResolvedValue(rewound(9)),
        rewindDepth: jest.fn(() => 1),
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      let first!: boolean;
      let second!: boolean;
      await act(async () => {
        first = result.current.rewind();
        second = result.current.rewind();
      });
      expect(first).toBe(true);
      expect(second).toBe(false);
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(service.rewind).toHaveBeenCalledTimes(1);
    });

    test('a rewound save leaves the 收藏 snapshot, and its late download never brings it back', async () => {
      const olderSaved: StoredImage = {
        ...image(9, 'active'),
        decision: 'saved',
        decidedAt: 1_000,
        decisionOrdinal: 1,
        localUri: 'file:///collection/9.jpg',
        downloadState: 'ready',
      };
      const pendingSaved: StoredImage = {
        ...image(1, 'active'),
        decision: 'saved',
        decidedAt: 2_000,
        decisionOrdinal: 2,
        downloadState: 'pending',
      };
      const backgroundDownload = deferred<{ status: 'ready' }>();
      let depth = 0;
      let row: StoredImage = pendingSaved;
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn(async () => {
          depth = 1;
          return {
            imageId: 1,
            decision: 'saved' as const,
            deck: { active: image(2, 'active'), queued: [image(3, 'queued')] },
            backgroundDownload: backgroundDownload.promise,
          };
        }),
        rewind: jest.fn(async () => {
          depth = 0;
          row = image(1, 'active');                                // the row left 收藏
          return {
            status: 'rewound' as const,
            entry: { imageId: 1, decision: 'saved' as const, decidedAt: 2_000 },
            deck: d1,
          };
        }),
        rewindDepth: jest.fn(() => depth),
      });
      const value = services(service);
      const getById = jest.fn(async () => row);
      value.imageRepository = {
        listCollection: jest.fn().mockResolvedValue([]),
        getById,
      } as unknown as AppServicesContextValue['imageRepository'];
      const queryClient = createAppQueryClient();
      queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
      queryClient.setQueryData(collectionQueryKey(), [olderSaved]);
      const hook = await renderHook(() => useDiscovery(), { wrapper: wrapper(value, queryClient) });
      await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

      await act(async () => { hook.result.current.commitDecision('saved'); });
      await waitFor(() => expect(queryClient.getQueryData(collectionQueryKey()))
        .toEqual([pendingSaved, olderSaved]));

      await act(async () => { expect(hook.result.current.rewind()).toBe(true); });
      await waitFor(() => expect(queryClient.getQueryData(collectionQueryKey()))
        .toEqual([olderSaved]));
      expect(hook.result.current.state.deck.active?.id).toBe(1);

      await act(async () => backgroundDownload.resolve({ status: 'ready' }));
      await waitFor(() => expect(getById).toHaveBeenCalledTimes(3));  // the save, the rewind, the late download
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(queryClient.getQueryData(collectionQueryKey())).toEqual([olderSaved]);
    });

    test('a press clears the decision error, and a failing rewind shows the rewind error', async () => {
      const rewindGate = deferred<RewindResult>();
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn().mockResolvedValue(null),                  // the swipe's write fails
        rewind: jest.fn()
          .mockImplementationOnce(() => rewindGate.promise)
          .mockRejectedValueOnce(new Error('database is locked')),
        rewindDepth: jest.fn(() => 1),                              // an older entry is there
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      await commitAndDrain(result, 'dismissed');
      expect(result.current.decisionError).toBe('未能完成操作，请重试');

      await act(async () => { expect(result.current.rewind()).toBe(true); });
      expect(result.current.decisionError).toBeNull();             // cleared by the press itself
      await act(async () => { rewindGate.resolve(rewound(9)); });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(result.current.decisionError).toBeNull();

      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await waitFor(() => expect(result.current.decisionError).toBe('无法回退，请继续浏览'));
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
    });

    test('two presses behind two unlanded swipes pair newest-first, one swipe each (spec §5.3 claims)', async () => {
      const gateA = deferred<DecisionResult | null>();
      const gateB = deferred<DecisionResult | null>();
      let depth = 0;
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn()
          .mockImplementationOnce(() => gateA.promise)
          .mockImplementationOnce(() => gateB.promise),
        rewind: jest.fn(async (expect?: { imageId: number }) => {
          depth -= 1;
          return rewound(expect?.imageId ?? -1);
        }),
        rewindDepth: jest.fn(() => depth),
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));
      await act(async () => {
        expect(result.current.commitDecision('dismissed')).toBe(true);   // 1
        expect(result.current.commitDecision('dismissed')).toBe(true);   // 2
      });
      await act(async () => {
        expect(result.current.rewind()).toBe(true);
        expect(result.current.rewind()).toBe(true);
        expect(result.current.rewind()).toBe(false);                     // only two swipes to undo
      });
      await act(async () => {
        depth = 1;
        gateA.resolve({ imageId: 1, decision: 'dismissed', deck: { active: image(2, 'active'), queued: [image(3, 'queued')] } });
      });
      await act(async () => {
        depth = 2;
        gateB.resolve({ imageId: 2, decision: 'dismissed', deck: { active: image(3, 'active'), queued: [] } });
      });
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(service.rewind).toHaveBeenCalledTimes(2);
      expect(service.rewind).toHaveBeenNthCalledWith(1, { imageId: 2 });
      expect(service.rewind).toHaveBeenNthCalledWith(2, { imageId: 1 });
      expect(result.current.canRewind).toBe(false);
    });

    test('a swipe is accepted again after a rewind throws (never wedged)', async () => {
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn().mockResolvedValue({ imageId: 1, decision: 'dismissed', deck: d1 }),
        rewind: jest.fn().mockRejectedValue(new Error('database is locked')),
        rewindDepth: jest.fn(() => 1),
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));
      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await waitFor(() => expect(result.current.decisionError).toBe('无法回退，请继续浏览'));
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      await act(async () => { expect(result.current.commitDecision('dismissed')).toBe(true); });
      await waitFor(() => expect(service.decide).toHaveBeenCalledTimes(1));
    });

    test('only a rewound result reaches the visible deck', async () => {
      // Row 26: a failed decide leaves the service deck unadvanced, so the deck
      // an `empty` result carries can still show the card the user swiped past.
      const service = discovery({
        restore: jest.fn().mockResolvedValue(d1),
        decide: jest.fn().mockResolvedValue(null),
        rewind: jest.fn().mockResolvedValue({ status: 'empty', deck: d1 } satisfies RewindResult),
        rewindDepth: jest.fn(() => 1),                              // one entry, stale when it is popped
      });
      const { result } = await renderHook(() => useDiscovery(), { wrapper: wrapper(services(service)) });
      await waitFor(() => expect(result.current.state.deck.active?.id).toBe(1));

      await commitAndDrain(result, 'dismissed');
      expect(result.current.state.deck.active?.id).toBe(2);
      await act(async () => { expect(result.current.rewind()).toBe(true); });
      await waitFor(() => expect(service.rewind).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.isDeciding).toBe(false));
      expect(result.current.state.deck.active?.id).toBe(2);
    });
  });

  test('the deck advances synchronously and the durable write drains even after unmount', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const nextDeck = {
      active: image(2, 'active'),
      queued: [image(3, 'queued')],
    };
    const pending = deferred<DecisionResult | null>();
    const decide = jest.fn(() => pending.promise);
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide,
    });
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service), queryClient),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    await act(async () => {
      hook.result.current.commitDecision('saved');
      await Promise.resolve();
    });
    // The advance is optimistic and the durable write is already in flight.
    expect((queryClient.getQueryData(['discovery', 'deck']) as RestoredDeck).active?.id).toBe(2);
    expect(decide).toHaveBeenCalledTimes(1);

    await hook.unmount();
    // The detached consumer completes the durable write after unmount, without
    // throwing or a post-unmount state update.
    await act(async () => {
      pending.resolve({ imageId: 1, decision: 'saved', deck: nextDeck });
      await Promise.resolve();
    });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  test('an immediate commit advances the cache and that advance survives unmount', async () => {
    const firstDeck = {
      active: image(1, 'active'),
      queued: [image(2, 'queued'), image(3, 'queued')],
    };
    const nextDeck = {
      active: image(2, 'active'),
      queued: [image(3, 'queued')],
    };
    const decide = jest.fn().mockResolvedValue({
      imageId: 1,
      decision: 'saved',
      deck: nextDeck,
    });
    const service = discovery({
      restore: jest.fn().mockResolvedValue(firstDeck),
      decide,
    });
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    const hook = await renderHook(() => useDiscovery(), {
      wrapper: wrapper(services(service), queryClient),
    });
    await waitFor(() => expect(hook.result.current.state.deck.active?.id).toBe(1));

    await act(async () => hook.result.current.commitDecision('saved'));
    expect((queryClient.getQueryData(['discovery', 'deck']) as RestoredDeck).active?.id).toBe(2);
    expect(decide).toHaveBeenCalledTimes(1);

    await hook.unmount();
    expect((queryClient.getQueryData(['discovery', 'deck']) as RestoredDeck).active?.id).toBe(2);
  });
});

describe('discoverySettingsIdentity', () => {
  test('ignores display-only language and thumbnail blur preferences', () => {
    expect(discoverySettingsIdentity(DEFAULT_SETTINGS)).toBe(
      discoverySettingsIdentity({
        ...DEFAULT_SETTINGS,
        language: 'ja',
        blurNsfwThumbnails: false,
      }),
    );
  });

  test('changes when a discovery preference changes', () => {
    expect(discoverySettingsIdentity(DEFAULT_SETTINGS)).not.toBe(
      discoverySettingsIdentity({ ...DEFAULT_SETTINGS, minWidth: 1080 }),
    );
  });

  test('R8.23: blocking furry re-keys the refill/reserve queries', () => {
    // The reserve and refill queryKeys are `[...KEY, settingsKey]`, so a new
    // identity is what makes the next warm come from the new admission set
    // (e621/e926 now gated out by `availabilityFor`). Without this, the old
    // key would keep serving a reserve warmed while those sources were still
    // admitted.
    expect(discoverySettingsIdentity(DEFAULT_SETTINGS)).not.toBe(
      discoverySettingsIdentity({ ...DEFAULT_SETTINGS, excludedTags: ['furry'] }),
    );
  });
});
