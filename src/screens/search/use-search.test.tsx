import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useLayoutEffect, type ReactNode } from 'react';

import { fetchDanbooruSearchPage } from '@/features/danbooru/danbooru-client';
import { fetchNekosSearchPage } from '@/features/nekos/nekos-client';
import { fetchSafebooruSearchPage } from '@/features/safebooru/safebooru-client';
import { fetchYandereSearchPage } from '@/features/yandere/yandere-client';
import { fetchKonachanSearchPage } from '@/features/konachan/konachan-client';
import { fetchE621SearchPage } from '@/features/e621/e621-client';
import { fetchE926SearchPage } from '@/features/e926/e926-client';
import { fetchGelbooruSearchPage } from '@/features/gelbooru/gelbooru-client';
import { fetchRule34SearchPage } from '@/features/rule34/rule34-client';
import { searchFilterIdentity } from '@/features/search/search-query';
import type {
  ProviderCursor,
  ProviderSearchPage,
  SearchHit,
  SearchRequest,
} from '@/features/search/types';
import { fetchWaifuSearchPage } from '@/features/waifu/waifu-client';
import type {
  ImageCandidate,
  ImageProviderKey,
  ImageProviderSettings,
} from '@/features/waifu/types';
import i18n from '@/i18n';

import { useSearch, type UseSearchResult, SEARCH_FIRST_PAINT_MS } from './use-search';

jest.mock('@/features/danbooru/danbooru-client', () => ({
  fetchDanbooruSearchPage: jest.fn(),
}));
jest.mock('@/features/nekos/nekos-client', () => ({
  fetchNekosSearchPage: jest.fn(),
}));
jest.mock('@/features/safebooru/safebooru-client', () => ({
  fetchSafebooruSearchPage: jest.fn(),
}));
jest.mock('@/features/yandere/yandere-client', () => ({
  fetchYandereSearchPage: jest.fn(),
}));
jest.mock('@/features/konachan/konachan-client', () => ({
  fetchKonachanSearchPage: jest.fn(),
}));
jest.mock('@/features/e621/e621-client', () => ({
  fetchE621SearchPage: jest.fn(),
}));
jest.mock('@/features/e926/e926-client', () => ({
  fetchE926SearchPage: jest.fn(),
}));
jest.mock('@/features/gelbooru/gelbooru-client', () => ({
  fetchGelbooruSearchPage: jest.fn(),
}));
jest.mock('@/features/rule34/rule34-client', () => ({
  fetchRule34SearchPage: jest.fn(),
}));
jest.mock('@/features/waifu/waifu-client', () => ({
  fetchWaifuSearchPage: jest.fn(),
}));

type ProviderPage<K extends ImageProviderKey> = Extract<
  ProviderSearchPage,
  { providerKey: K }
>;

const REQUEST: SearchRequest = {
  tags: ['blue_archive'],
  excludedTags: ['guro'],
  nsfwMode: 'sfw',
  orientation: 'portrait',
  animationMode: 'exclude',
  minWidth: 720,
  maxBytes: 5_000_000,
};

const ALL_PROVIDERS: ImageProviderSettings = {
  waifu_im: true,
  nekos_api: true,
  danbooru: true,
  safebooru: false,
  yandere: false,
  konachan: false,
  e621: false,
  e926: false,
  gelbooru: false, rule34: false,
};

const NO_PROVIDERS: ImageProviderSettings = {
  waifu_im: false,
  nekos_api: false,
  danbooru: false,
  safebooru: false,
  yandere: false,
  konachan: false,
  e621: false,
  e926: false,
  gelbooru: false, rule34: false,
};

const E926_ONLY: ImageProviderSettings = { ...NO_PROVIDERS, e926: true };
const KONACHAN_ONLY: ImageProviderSettings = { ...NO_PROVIDERS, konachan: true };
const E926_AND_KONACHAN: ImageProviderSettings = {
  ...NO_PROVIDERS,
  konachan: true,
  e926: true,
};

const fetchWaifu = jest.mocked(fetchWaifuSearchPage);
const fetchNekos = jest.mocked(fetchNekosSearchPage);
const fetchDanbooru = jest.mocked(fetchDanbooruSearchPage);
const fetchSafebooru = jest.mocked(fetchSafebooruSearchPage);
const fetchYandere = jest.mocked(fetchYandereSearchPage);
const fetchKonachan = jest.mocked(fetchKonachanSearchPage);
const fetchE621 = jest.mocked(fetchE621SearchPage);
const fetchE926 = jest.mocked(fetchE926SearchPage);
const fetchGelbooru = jest.mocked(fetchGelbooruSearchPage);
const fetchRule34 = jest.mocked(fetchRule34SearchPage);

function candidate(
  providerKey: ImageProviderKey,
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): ImageCandidate {
  return {
    providerKey,
    providerItemId,
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${providerKey}/${providerItemId}.webp`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 768,
    height: 1152,
    byteSize: 100,
    extension: '.webp',
    dominantColor: '#abcdef',
    isNsfw: false,
    isAnimated: false,
    tags: [],
    ...overrides,
  };
}

function hit(
  providerKey: ImageProviderKey,
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): SearchHit {
  const image = candidate(providerKey, providerItemId, overrides);
  return {
    key: `${providerKey}:${providerItemId}`,
    previewUrl: image.remoteUrl,
    image,
  };
}

function waifuPage(
  items: SearchHit[],
  nextCursor: ProviderCursor['waifu_im'] | null,
  unsupportedQuery = false,
): ProviderPage<'waifu_im'> {
  return {
    providerKey: 'waifu_im',
    items,
    nextCursor,
    ...(unsupportedQuery ? { unsupportedQuery: true } : {}),
  };
}

function nekosPage(
  items: SearchHit[],
  nextCursor: ProviderCursor['nekos_api'] | null,
  unsupportedQuery = false,
): ProviderPage<'nekos_api'> {
  return {
    providerKey: 'nekos_api',
    items,
    nextCursor,
    ...(unsupportedQuery ? { unsupportedQuery: true } : {}),
  };
}

function danbooruPage(
  items: SearchHit[],
  nextCursor: ProviderCursor['danbooru'] | null,
): ProviderPage<'danbooru'> {
  return { providerKey: 'danbooru', items, nextCursor };
}

function safebooruPage(
  items: SearchHit[],
  nextCursor: ProviderCursor['safebooru'] | null,
): ProviderPage<'safebooru'> {
  return { providerKey: 'safebooru', items, nextCursor };
}

function yanderePage(
  items: SearchHit[],
  nextCursor: ProviderCursor['yandere'] | null,
): ProviderPage<'yandere'> {
  return { providerKey: 'yandere', items, nextCursor };
}

function gelbooruPage(
  items: SearchHit[],
  nextCursor: ProviderCursor['gelbooru'] | null,
): ProviderPage<'gelbooru'> {
  return { providerKey: 'gelbooru', items, nextCursor };
}

function rule34Page(
  items: SearchHit[],
  nextCursor: ProviderCursor['rule34'] | null,
): ProviderPage<'rule34'> {
  return { providerKey: 'rule34', items, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function providerError(code: string, privateMessage: string): Error {
  return Object.assign(new Error(privateMessage), {
    code,
    stack: `private stack: ${privateMessage}`,
  });
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe('useSearch', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-Hans');
    jest.clearAllMocks();
  });

  test('keeps an empty submitted request idle and disables every provider', async () => {
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(null, ALL_PROVIDERS), {
      wrapper: wrapper(queryClient),
    });

    expect(hook.result.current).toMatchObject({
      hits: [],
      failures: [],
      enabledProviderCount: 3,
      status: 'idle',
      isFetchingNextPage: false,
      hasNextPage: false,
    });
    await act(async () => {
      await hook.result.current.fetchNextPage();
      await hook.result.current.refetch();
    });
    expect(fetchWaifu).not.toHaveBeenCalled();
    expect(fetchNekos).not.toHaveBeenCalled();
    expect(fetchDanbooru).not.toHaveBeenCalled();
    expect(fetchSafebooru).not.toHaveBeenCalled();
    expect(fetchYandere).not.toHaveBeenCalled();
    expect(fetchKonachan).not.toHaveBeenCalled();
    expect(fetchE621).not.toHaveBeenCalled();
    expect(fetchE926).not.toHaveBeenCalled();
  });

  test('queries Safebooru when it is the enabled search source', async () => {
    fetchSafebooru.mockResolvedValue(
      safebooruPage([hit('safebooru', 's1')], null),
    );
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(REQUEST, {
      waifu_im: false,
      nekos_api: false,
      danbooru: false,
      safebooru: true,
      yandere: false,
      konachan: false,
      e621: false,
      e926: false,
      gelbooru: false, rule34: false,
    }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual([
      'safebooru:s1',
    ]);
    expect(fetchSafebooru).toHaveBeenCalledWith(expect.objectContaining({
      request: REQUEST,
    }));
  });

  test('a 仅 SFW search does not ask Rule34', async () => {
    const rule34Credential = { apiKey: 'fake-key', userId: 'fake-user' };
    fetchRule34.mockResolvedValue(rule34Page([], null));
    fetchDanbooru.mockResolvedValue(danbooruPage([hit('danbooru', 'd1')], null));
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(REQUEST, {
      ...NO_PROVIDERS,
      danbooru: true,
      rule34: true,
    }, undefined, { rule34: rule34Credential }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchRule34).not.toHaveBeenCalled();
    expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ nsfwMode: 'sfw' }),
    }));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual(['danbooru:d1']);
  });

  test('a 混合 search still asks Rule34', async () => {
    const mixedRequest: SearchRequest = { ...REQUEST, nsfwMode: 'mixed' };
    const rule34Credential = { apiKey: 'fake-key', userId: 'fake-user' };
    fetchRule34.mockResolvedValue(rule34Page([hit('rule34', 'r1')], null));
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(mixedRequest, {
      ...NO_PROVIDERS,
      rule34: true,
    }, undefined, { rule34: rule34Credential }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchRule34).toHaveBeenCalledTimes(1);
    expect(fetchRule34).toHaveBeenCalledWith(expect.objectContaining({
      request: mixedRequest,
      credential: rule34Credential,
    }));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual(['rule34:r1']);
  });

  test('a 仅 NSFW search does not ask e926', async () => {
    const nsfwRequest: SearchRequest = { ...REQUEST, nsfwMode: 'nsfw', orientation: 'any' };
    fetchE926.mockResolvedValue({ providerKey: 'e926', items: [], nextCursor: null });
    fetchDanbooru.mockResolvedValue(danbooruPage([hit('danbooru', 'd1')], null));
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(nsfwRequest, { ...E926_ONLY, danbooru: true }), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchE926).not.toHaveBeenCalled();
    expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ nsfwMode: 'nsfw' }),
    }));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual(['danbooru:d1']);
  });

  test('a 仅 NSFW search does not ask Konachan', async () => {
    const nsfwRequest: SearchRequest = { ...REQUEST, nsfwMode: 'nsfw', orientation: 'any' };
    fetchKonachan.mockResolvedValue({ providerKey: 'konachan', items: [], nextCursor: null });
    fetchDanbooru.mockResolvedValue(danbooruPage([hit('danbooru', 'd1')], null));
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(nsfwRequest, { ...KONACHAN_ONLY, danbooru: true }), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchKonachan).not.toHaveBeenCalled();
    expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ nsfwMode: 'nsfw' }),
    }));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual(['danbooru:d1']);
  });

  test('a 混合 search still asks both e926 and Konachan', async () => {
    const mixedRequest: SearchRequest = { ...REQUEST, nsfwMode: 'mixed', orientation: 'any' };
    fetchE926.mockResolvedValue({ providerKey: 'e926', items: [hit('e926', 'e1')], nextCursor: null });
    fetchKonachan.mockResolvedValue({ providerKey: 'konachan', items: [hit('konachan', 'k1')], nextCursor: null });
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(mixedRequest, E926_AND_KONACHAN), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchE926).toHaveBeenCalledTimes(1);
    expect(fetchKonachan).toHaveBeenCalledTimes(1);
    expect(hook.result.current.hits.map((item) => item.key).sort()).toEqual([
      'e926:e1',
      'konachan:k1',
    ]);
  });

  test('a portrait search still asks Konachan', async () => {
    fetchKonachan.mockResolvedValue({ providerKey: 'konachan', items: [hit('konachan', 'k1')], nextCursor: null });
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(REQUEST, KONACHAN_ONLY), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchKonachan).toHaveBeenCalledTimes(1);
    expect(fetchKonachan).toHaveBeenCalledWith(expect.objectContaining({ request: REQUEST }));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual(['konachan:k1']);
  });

  test('R8.23: a furry-excluding request still searches e621/e926 (search never reads availabilityFor)', async () => {
    // R8.23 skips e621/e926 in DISCOVER when `furry` is blocked, via the
    // registry's `availabilityFor` admission gate. Search is source-scoped and
    // deliberately does not consult that gate: the user picked the source, and
    // R8.22 ruling (e) already keeps home exclusions out of the search request
    // (`search-screen-model.ts` builds it with `excludedTags: []`). This pins
    // that separation — wiring the Discover gate into search would break it.
    fetchE621.mockResolvedValue({
      providerKey: 'e621',
      items: [hit('e621', 'f1')],
      nextCursor: null,
    });
    fetchE926.mockResolvedValue({
      providerKey: 'e926',
      items: [hit('e926', 'f2')],
      nextCursor: null,
    });
    const furryExcludingRequest: SearchRequest = { ...REQUEST, excludedTags: ['furry'] };
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(furryExcludingRequest, {
      waifu_im: false,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false,
      e621: true,
      e926: true,
      gelbooru: false, rule34: false,
    }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchE621).toHaveBeenCalledWith(expect.objectContaining({
      request: furryExcludingRequest,
    }));
    expect(fetchE926).toHaveBeenCalledWith(expect.objectContaining({
      request: furryExcludingRequest,
    }));
    expect(hook.result.current.hits.map((item) => item.key).sort())
      .toEqual(['e621:f1', 'e926:f2']);
  });

  test('forwards the gelbooru credential into its search context, and only to gelbooru', async () => {
    fetchGelbooru.mockResolvedValue(gelbooruPage([hit('gelbooru', 'g1')], null));
    fetchSafebooru.mockResolvedValue(safebooruPage([hit('safebooru', 's1')], null));
    const cred = { apiKey: 'k', userId: 'u' };
    const queryClient = createQueryClient();
    const hook = await renderHook(() => useSearch(
      REQUEST,
      { ...NO_PROVIDERS, safebooru: true, gelbooru: true },
      undefined,
      { gelbooru: cred },
    ), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchGelbooru).toHaveBeenCalledWith(expect.objectContaining({
      credential: cred,
    }));
    // A keyless enabled source gets no credential key in its context.
    expect(fetchSafebooru.mock.calls[0]![0]).not.toHaveProperty('credential');
  });

  test('queries Yande.re, forwards tags, merges pages, and refetches only when enabled', async () => {
    fetchYandere.mockImplementation(({ cursor }) => Promise.resolve(
      cursor === undefined
        ? yanderePage([hit('yandere', 'y1')], { page: 2 })
        : yanderePage([hit('yandere', 'y2')], null),
    ));
    const queryClient = createQueryClient();
    const providers: ImageProviderSettings = {
      ...NO_PROVIDERS,
      yandere: true,
    };
    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(queryClient),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(fetchYandere).toHaveBeenCalledWith(expect.objectContaining({
      request: REQUEST,
    }));
    expect(hook.result.current.enabledProviderCount).toBe(1);
    expect(hook.result.current.hasNextPage).toBe(true);

    await act(async () => hook.result.current.fetchNextPage());
    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['yandere:y1', 'yandere:y2']));
    expect(fetchYandere.mock.calls[1][0].cursor).toEqual({ page: 2 });

    await act(async () => hook.result.current.refetch());
    expect(fetchYandere).toHaveBeenCalledTimes(4);
  });

  test('does not query Yande.re when disabled', async () => {
    const hook = await renderHook(() => useSearch(REQUEST, NO_PROVIDERS), {
      wrapper: wrapper(createQueryClient()),
    });

    expect(hook.result.current.status).toBe('idle');
    await act(async () => {
      await hook.result.current.fetchNextPage();
      await hook.result.current.refetch();
    });
    expect(fetchYandere).not.toHaveBeenCalled();
    expect(fetchKonachan).not.toHaveBeenCalled();
    expect(fetchE621).not.toHaveBeenCalled();
    expect(fetchE926).not.toHaveBeenCalled();
  });

  test('queries only enabled providers and removes disabled provider data', async () => {
    fetchNekos.mockResolvedValue(nekosPage([hit('nekos_api', 'n1')], null));
    const queryClient = createQueryClient();
    const hook = await renderHook<
      UseSearchResult,
      { providers: ImageProviderSettings }
    >(
      ({ providers }) => useSearch(REQUEST, providers),
      {
        initialProps: {
          providers: {
            waifu_im: false,
            nekos_api: true,
            danbooru: false,
            safebooru: false,
            yandere: false,
            konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
          },
        },
        wrapper: wrapper(queryClient),
      },
    );

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(hook.result.current.hits.map((item) => item.key)).toEqual([
      'nekos_api:n1',
    ]);
    expect(hook.result.current.enabledProviderCount).toBe(1);
    expect(fetchWaifu).not.toHaveBeenCalled();
    expect(fetchNekos).toHaveBeenCalledTimes(1);
    expect(fetchDanbooru).not.toHaveBeenCalled();

    await hook.rerender({ providers: NO_PROVIDERS });
    expect(hook.result.current).toMatchObject({
      hits: [],
      failures: [],
      enabledProviderCount: 0,
      status: 'idle',
    });
    await act(async () => {
      await hook.result.current.fetchNextPage();
      await hook.result.current.refetch();
    });
    expect(fetchWaifu).not.toHaveBeenCalled();
    expect(fetchNekos).toHaveBeenCalledTimes(1);
    expect(fetchDanbooru).not.toHaveBeenCalled();
  });

  test('uses independent provider query keys, caches, and AbortSignals', async () => {
    const signals = new Map<ImageProviderKey, AbortSignal | undefined>();
    fetchWaifu.mockImplementation(async ({ signal }) => {
      signals.set('waifu_im', signal);
      return waifuPage([], null);
    });
    fetchNekos.mockImplementation(async ({ signal }) => {
      signals.set('nekos_api', signal);
      return nekosPage([], null);
    });
    fetchDanbooru.mockImplementation(async ({ signal }) => {
      signals.set('danbooru', signal);
      return danbooruPage([], null);
    });
    const queryClient = createQueryClient();

    const hook = await renderHook(() => useSearch(REQUEST, ALL_PROVIDERS), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(hook.result.current.status).toBe('empty'));

    const identity = searchFilterIdentity(REQUEST);
    expect(queryClient.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([
      ['search', 'waifu_im', identity],
      ['search', 'nekos_api', identity],
      ['search', 'danbooru', identity],
      ['search', 'safebooru', identity],
      ['search', 'yandere', identity],
      ['search', 'konachan', identity],
      ['search', 'e621', identity],
      ['search', 'e926', identity],
      ['search', 'gelbooru', identity],
      ['search', 'rule34', identity],
    ]);
    expect(new Set(signals.values()).size).toBe(3);
    for (const signal of signals.values()) {
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
    }

    const cachedProviders = queryClient.getQueryCache().getAll().flatMap((query) => {
      const data = query.state.data as InfiniteData<ProviderSearchPage> | undefined;
      return data ? [data.pages[0].providerKey] : [];
    });
    expect(cachedProviders).toEqual(['waifu_im', 'nekos_api', 'danbooru']);
  });

  test('keeps fair, deduplicated hits when one provider fails', async () => {
    fetchWaifu.mockRejectedValue(
      providerError('network', 'secret Waifu upstream failure'),
    );
    fetchNekos.mockResolvedValue(nekosPage([
      hit('nekos_api', 'n1', { canonicalSourceKey: 'pixiv:shared' }),
      hit('nekos_api', 'n2'),
    ], null));
    fetchDanbooru.mockResolvedValue(danbooruPage([
      hit('danbooru', 'd1'),
      hit('danbooru', 'duplicate', { canonicalSourceKey: 'pixiv:shared' }),
    ], null));
    const queryClient = createQueryClient();

    const hook = await renderHook(() => useSearch(REQUEST, ALL_PROVIDERS), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => {
      expect(hook.result.current.failures).toHaveLength(1);
      expect(hook.result.current.status).toBe('success');
    });

    expect(hook.result.current.hits.map((item) => item.key)).toEqual([
      'nekos_api:n1',
      'danbooru:d1',
      'nekos_api:n2',
    ]);
    expect(hook.result.current.failures).toEqual([{
      providerKey: 'waifu_im',
      code: 'network',
    }]);
    // The upstream text carried 'secret'. A failure has no free-text field at
    // all, so there is no channel for it to reach a rendered surface.
    expect(Object.keys(hook.result.current.failures[0]).sort())
      .toEqual(['code', 'providerKey']);
    expect(JSON.stringify(hook.result.current.failures)).not.toContain('secret');
  });

  test('keeps the emitted prefix stable across staggered initial and next pages', async () => {
    const initialNekos = deferred<ProviderPage<'nekos_api'>>();
    const nextWaifu = deferred<ProviderPage<'waifu_im'>>();
    const nextNekos = deferred<ProviderPage<'nekos_api'>>();
    fetchWaifu.mockImplementation(({ cursor }) => cursor === undefined
      ? Promise.resolve(waifuPage(
        [hit('waifu_im', 'w1'), hit('waifu_im', 'w2')],
        { page: 2 },
      ))
      : nextWaifu.promise);
    fetchNekos.mockImplementation(({ cursor }) => cursor === undefined
      ? initialNekos.promise
      : nextNekos.promise);
    const providers: ImageProviderSettings = {
      waifu_im: true,
      nekos_api: true,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    };
    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual(['waifu_im:w1']));

    await act(async () => initialNekos.resolve(nekosPage(
      [hit('nekos_api', 'n1'), hit('nekos_api', 'n2')],
      { offset: 2 },
    )));
    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      'waifu_im:w1',
      'nekos_api:n1',
      'waifu_im:w2',
      'nekos_api:n2',
    ]));
    const stablePrefix = hook.result.current.hits.map((item) => item.key);

    let loadingMore!: Promise<void>;
    await act(async () => {
      loadingMore = hook.result.current.fetchNextPage();
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.isFetchingNextPage).toBe(true));
    await act(async () => nextWaifu.resolve(waifuPage(
      [hit('waifu_im', 'w3'), hit('waifu_im', 'w4')],
      null,
    )));
    await waitFor(() => expect(fetchWaifu).toHaveBeenCalledTimes(2));
    // §3.1 per-provider un-freeze: waifu's page-2 hits append AS SOON AS they
    // land — the grid no longer freezes globally while nekos is still fetching.
    // The prefix is unchanged (never reordered); nekos keeps its prior slice
    // until it settles, then fills in (asserted below). Before §3.1 this
    // asserted `toEqual(stablePrefix)` — that was the global freeze this cut deletes.
    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([...stablePrefix, 'waifu_im:w3', 'waifu_im:w4']));
    expect(hook.result.current.hits.slice(0, stablePrefix.length)
      .map((item) => item.key)).toEqual(stablePrefix);

    await act(async () => {
      nextNekos.resolve(nekosPage(
        [hit('nekos_api', 'n3'), hit('nekos_api', 'n4')],
        null,
      ));
      await loadingMore;
    });
    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      ...stablePrefix,
      // No grid geometry report was made in this hook-only test, so the
      // seen line is still zero. The new fair order interleaves the newly settled
      // provider below the existing prefix instead of appending its whole page.
      'waifu_im:w3',
      'nekos_api:n3',
      'waifu_im:w4',
      'nekos_api:n4',
    ]));
  });

  test('reports error only when every enabled provider fails', async () => {
    fetchWaifu.mockRejectedValue(providerError('network', 'waifu private'));
    fetchNekos.mockRejectedValue(providerError('rate_limited', 'nekos private'));
    fetchDanbooru.mockRejectedValue(providerError('database_password', 'db private'));
    const queryClient = createQueryClient();

    const hook = await renderHook(() => useSearch(REQUEST, ALL_PROVIDERS), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(hook.result.current.status).toBe('error'));

    expect(hook.result.current.hits).toEqual([]);
    expect(hook.result.current.failures).toEqual([
      { providerKey: 'waifu_im', code: 'network' },
      { providerKey: 'nekos_api', code: 'rate_limited' },
      { providerKey: 'danbooru', code: 'provider' },
    ]);
    expect(JSON.stringify(hook.result.current.failures))
      .not.toMatch(/private|password|stack/i);
  });

  test('reports unsupported when every responding provider rejects the tag', async () => {
    fetchWaifu.mockResolvedValue(waifuPage([], null, true));
    fetchNekos.mockResolvedValue(nekosPage([], null, true));
    const providers: ImageProviderSettings = {
      waifu_im: true,
      nekos_api: true,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    };

    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('unsupported'));
    expect(hook.result.current.hits).toEqual([]);
    expect(hook.result.current.failures).toEqual([]);
  });

  test('keeps mixed provider outcomes distinct', async () => {
    fetchWaifu.mockResolvedValue(waifuPage([hit('waifu_im', 'w1')], null));
    fetchNekos.mockResolvedValue(nekosPage([], null, true));
    const providers: ImageProviderSettings = {
      waifu_im: true,
      nekos_api: true,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false,
      e621: false,
      e926: false,
      gelbooru: false,
      rule34: false,
    };

    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    // A source that cannot answer this query must not degrade the aggregate:
    // the supporting source's hits still surface, and nothing is reported as a
    // failure the user could act on.
    expect(hook.result.current.hits).toEqual([
      expect.objectContaining({ key: 'waifu_im:w1' }),
    ]);
    expect(hook.result.current.failures).toEqual([]);
  });

  test('keeps an unavailable searchable source distinct from unsupported sources', async () => {
    fetchWaifu.mockResolvedValue(waifuPage([], null, true));
    fetchNekos.mockResolvedValue(nekosPage([], null, true));
    fetchDanbooru.mockRejectedValue(providerError('network', 'private'));

    const hook = await renderHook(() => useSearch(REQUEST, ALL_PROVIDERS), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(hook.result.current.failures).toEqual([
      expect.objectContaining({ providerKey: 'danbooru', code: 'network' }),
    ]);
  });

  test('round-trips provider cursors while preserving another provider success', async () => {
    const waifuNext = deferred<ProviderPage<'waifu_im'>>();
    const danbooruNext = deferred<ProviderPage<'danbooru'>>();
    const waifuCursor: ProviderCursor['waifu_im'] = { page: 2 };
    fetchWaifu.mockImplementation(({ cursor }) => cursor === undefined
      ? Promise.resolve(waifuPage([hit('waifu_im', 'w1')], waifuCursor))
      : waifuNext.promise);
    fetchNekos.mockResolvedValue(nekosPage(
      [hit('nekos_api', 'n1')],
      null,
    ));
    fetchDanbooru.mockImplementation(({ cursor }) => cursor === undefined
      ? Promise.resolve(danbooruPage(
        [hit('danbooru', 'd1')],
        { beforeId: 90 },
      ))
      : danbooruNext.promise);
    const queryClient = createQueryClient();

    const hook = await renderHook(() => useSearch(REQUEST, ALL_PROVIDERS), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    expect(hook.result.current.hasNextPage).toBe(true);

    let loadingMore!: Promise<void>;
    await act(async () => {
      loadingMore = hook.result.current.fetchNextPage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(fetchWaifu).toHaveBeenCalledTimes(2);
      expect(fetchDanbooru).toHaveBeenCalledTimes(2);
      expect(hook.result.current.isFetchingNextPage).toBe(true);
    });
    expect(fetchNekos).toHaveBeenCalledTimes(1);
    expect(fetchWaifu.mock.calls[1][0].cursor).toBe(waifuCursor);
    expect(fetchDanbooru.mock.calls[1][0].cursor).toEqual({ beforeId: 90 });

    await act(async () => {
      await hook.result.current.fetchNextPage();
    });
    expect(fetchWaifu).toHaveBeenCalledTimes(2);
    expect(fetchDanbooru).toHaveBeenCalledTimes(2);

    await act(async () => {
      waifuNext.reject(providerError('network', 'next page private'));
      danbooruNext.resolve(danbooruPage([hit('danbooru', 'd2')], null));
      await loadingMore;
    });
    await waitFor(() => expect(hook.result.current.isFetchingNextPage).toBe(false));

    expect(hook.result.current.hits.map((item) => item.key)).toEqual([
      'waifu_im:w1',
      'nekos_api:n1',
      'danbooru:d1',
      'danbooru:d2',
    ]);
    expect(hook.result.current.failures).toEqual([{
      providerKey: 'waifu_im',
      code: 'network',
    }]);
    expect(hook.result.current.status).toBe('success');
    expect(hook.result.current.hasNextPage).toBe(true);
  });

  test('keeps a settled source visible while another source refetches', async () => {
    const nextWaifu = deferred<ProviderPage<'waifu_im'>>();
    fetchWaifu
      .mockResolvedValueOnce(waifuPage([hit('waifu_im', 'w1')], null))
      .mockImplementationOnce(() => nextWaifu.promise);
    fetchNekos.mockResolvedValue(nekosPage([hit('nekos_api', 'n1')], null));
    const providers: ImageProviderSettings = {
      ...NO_PROVIDERS,
      waifu_im: true,
      nekos_api: true,
    };
    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(createQueryClient()),
    });
    await waitFor(() => expect(hook.result.current.status).toBe('success'));

    let refetching!: Promise<void>;
    await act(async () => {
      refetching = hook.result.current.refetch();
      await Promise.resolve();
    });
    // waifu is in flight again; nekos already settled. The settled source's hit
    // must stay on screen instead of blanking out until the slow one returns.
    await waitFor(() => expect(fetchWaifu).toHaveBeenCalledTimes(2));
    expect(hook.result.current.hits.map((item) => item.key)).toContain('nekos_api:n1');
    expect(hook.result.current.status).toBe('success');

    await act(async () => {
      nextWaifu.resolve(waifuPage([hit('waifu_im', 'w1')], null));
      await refetching;
    });
    expect(hook.result.current.hits.map((item) => item.key)).toEqual([
      'waifu_im:w1',
      'nekos_api:n1',
    ]);
    expect(hook.result.current.failures).toEqual([]);
  });

  test('S7 §3.1: resolved providers paint before a slow provider settles', async () => {
    // waifu + danbooru resolve page 1 immediately; nekos stays pending. The grid
    // must show the resolved providers instead of freezing empty on first paint.
    const pendingNekos = deferred<ProviderPage<'nekos_api'>>();
    fetchWaifu.mockResolvedValue(waifuPage(
      [hit('waifu_im', 'w1'), hit('waifu_im', 'w2')], null,
    ));
    fetchDanbooru.mockResolvedValue(danbooruPage(
      [hit('danbooru', 'd1')], null,
    ));
    fetchNekos.mockImplementation(() => pendingNekos.promise);

    const hook = await renderHook(() => useSearch(REQUEST, ALL_PROVIDERS), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(hook.result.current.status).toBe('success'));
    const keysWhilePending = hook.result.current.hits.map((item) => item.key);
    expect(keysWhilePending).toContain('waifu_im:w1');
    expect(keysWhilePending).toContain('danbooru:d1');
    expect(keysWhilePending.some((k) => k.startsWith('nekos_api:'))).toBe(false);

    // When the slow provider lands it appends without moving the shown prefix.
    await act(async () => pendingNekos.resolve(nekosPage(
      [hit('nekos_api', 'n1')], null,
    )));
    await waitFor(() => expect(
      hook.result.current.hits.some((h) => h.key === 'nekos_api:n1'),
    ).toBe(true));
    const after = hook.result.current.hits.map((item) => item.key);
    // Every previously-shown key kept its relative order (no reorder jank).
    expect(after.filter((k) => keysWhilePending.includes(k))).toEqual(keysWhilePending);
  });

  test('S3.2: first-paint clamp releases after the deadline with a provider still pending', async () => {
    jest.useFakeTimers();
    try {
      const pendingNekos = deferred<ProviderPage<'nekos_api'>>();
      // waifu returns MANY hits on page 1; the clamp should show only 1 until the
      // deadline, then release waifu's full page even though nekos never settles.
      fetchWaifu.mockResolvedValue(waifuPage(
        [
          hit('waifu_im', 'w1'), hit('waifu_im', 'w2'),
          hit('waifu_im', 'w3'), hit('waifu_im', 'w4'),
        ],
        null,
      ));
      fetchNekos.mockImplementation(() => pendingNekos.promise);

      const providers: ImageProviderSettings = {
        waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
        yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
      };
      const hook = await renderHook(() => useSearch(REQUEST, providers), {
        wrapper: wrapper(createQueryClient()),
      });

      // Before the deadline: clamped to one waifu item (nekos still pending).
      await waitFor(() => expect(
        hook.result.current.hits.filter((h) => h.image.providerKey === 'waifu_im'),
      ).toHaveLength(1));

      await act(async () => {
        jest.advanceTimersByTime(SEARCH_FIRST_PAINT_MS + 1);
        await Promise.resolve();
      });

      // After the deadline: waifu's full landed page is released, not pinned by nekos.
      await waitFor(() => expect(
        hook.result.current.hits.filter((h) => h.image.providerKey === 'waifu_im').length,
      ).toBeGreaterThan(1));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a source that lands after the first paint appears right below the seen line, not at the end", async () => {
    jest.useFakeTimers();
    try {
      const pendingNekos = deferred<ProviderPage<'nekos_api'>>();
      fetchWaifu.mockResolvedValue(waifuPage([
        hit('waifu_im', 'w1'),
        hit('waifu_im', 'w2'),
        hit('waifu_im', 'w3'),
      ], null));
      fetchNekos.mockImplementation(() => pendingNekos.promise);
      const providers: ImageProviderSettings = {
        waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
        yandere: false, konachan: false, e621: false, e926: false,
        gelbooru: false, rule34: false,
      };
      const hook = await renderHook(() => useSearch(REQUEST, providers), {
        wrapper: wrapper(createQueryClient()),
      });

      await waitFor(() => expect(hook.result.current.hits).toHaveLength(1));
      await act(async () => {
        jest.advanceTimersByTime(SEARCH_FIRST_PAINT_MS + 1);
        await Promise.resolve();
      });
      await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));
      await act(async () => {
        hook.result.current.noteSeen(3);
        await Promise.resolve();
      });

      await act(async () => pendingNekos.resolve(nekosPage([
        hit('nekos_api', 'n1'),
        hit('nekos_api', 'n2'),
      ], null)));
      await waitFor(() => expect(
        hook.result.current.hits.map((item) => item.key),
      ).toEqual([
        'waifu_im:w1',
        'waifu_im:w2',
        'waifu_im:w3',
        'nekos_api:n1',
        'nekos_api:n2',
      ]));
    } finally {
      jest.useRealTimers();
    }
  });

  test("a report counts for the search it was made in, even in a new search's first commit", async () => {
    const pendingWaifu = deferred<ProviderPage<'waifu_im'>>();
    fetchWaifu
      .mockResolvedValueOnce(waifuPage([hit('waifu_im', 'a')], null))
      .mockImplementationOnce(() => pendingWaifu.promise);
    fetchNekos
      .mockResolvedValueOnce(nekosPage([hit('nekos_api', 'a')], null))
      .mockResolvedValueOnce(nekosPage([hit('nekos_api', 'b')], null));
    fetchDanbooru
      .mockResolvedValueOnce(danbooruPage([hit('danbooru', 'a')], null))
      .mockResolvedValueOnce(danbooruPage([hit('danbooru', 'b')], null));
    const providers: ImageProviderSettings = {
      waifu_im: true, nekos_api: true, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false,
      gelbooru: false, rule34: false,
    };
    const nextRequest: SearchRequest = { ...REQUEST, tags: ['layout-b'] };
    const hook = await renderHook(
      ({ request }: { request: SearchRequest }) => {
        const result = useSearch(request, providers);
        const { noteSeen } = result;
        useLayoutEffect(() => {
          if (request === nextRequest) noteSeen(2);
        }, [request, noteSeen]);
        return result;
      },
      {
        initialProps: { request: REQUEST },
        wrapper: wrapper(createQueryClient()),
      },
    );

    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['waifu_im:a', 'nekos_api:a', 'danbooru:a']));
    await hook.rerender({ request: nextRequest });
    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['nekos_api:b', 'danbooru:b']));
    await act(async () => pendingWaifu.resolve(waifuPage([
      hit('waifu_im', 'b'),
    ], null)));

    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['nekos_api:b', 'danbooru:b', 'waifu_im:b']));
  });

  test('seen hits keep their positions across a late arrival', async () => {
    const pendingWaifu = deferred<ProviderPage<'waifu_im'>>();
    fetchWaifu.mockImplementation(() => pendingWaifu.promise);
    fetchNekos.mockResolvedValue(nekosPage([
      hit('nekos_api', 'n1'), hit('nekos_api', 'n2'),
    ], null));
    fetchDanbooru.mockResolvedValue(danbooruPage([
      hit('danbooru', 'd1'), hit('danbooru', 'd2'),
    ], null));
    const providers: ImageProviderSettings = {
      waifu_im: true, nekos_api: true, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false,
      gelbooru: false, rule34: false,
    };
    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual(['nekos_api:n1', 'danbooru:d1']));
    await act(async () => {
      hook.result.current.noteSeen(2);
      await Promise.resolve();
    });
    await act(async () => pendingWaifu.resolve(waifuPage([
      hit('waifu_im', 'w1'), hit('waifu_im', 'w2'),
    ], null)));
    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      'nekos_api:n1',
      'danbooru:d1',
      'waifu_im:w1',
      'nekos_api:n2',
      'danbooru:d2',
      'waifu_im:w2',
    ]));
  });

  test('a refetch whose page window moved keeps every seen tile in place', async () => {
    const nextPage = deferred<ProviderPage<'gelbooru'>>();
    fetchGelbooru
      .mockResolvedValueOnce(gelbooruPage([
        hit('gelbooru', 'g1'),
        hit('gelbooru', 'g2'),
        hit('gelbooru', 'g3'),
      ], null))
      .mockImplementationOnce(() => nextPage.promise);
    const providers: ImageProviderSettings = {
      ...NO_PROVIDERS,
      gelbooru: true,
    };
    const hook = await renderHook(() => useSearch(REQUEST, providers), {
      wrapper: wrapper(createQueryClient()),
    });

    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      'gelbooru:g1',
      'gelbooru:g2',
      'gelbooru:g3',
    ]));
    await act(async () => {
      hook.result.current.noteSeen(2);
      await Promise.resolve();
    });

    let refetching!: Promise<void>;
    await act(async () => {
      refetching = hook.result.current.refetch();
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchGelbooru).toHaveBeenCalledTimes(2));

    await act(async () => {
      nextPage.resolve(gelbooruPage([
        hit('gelbooru', 'g2'),
        hit('gelbooru', 'g3'),
        hit('gelbooru', 'g4'),
        hit('gelbooru', 'g5'),
      ], null));
      await refetching;
    });

    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      'gelbooru:g1',
      'gelbooru:g2',
      'gelbooru:g3',
      'gelbooru:g4',
      'gelbooru:g5',
    ]));
    expect(hook.result.current.hits.slice(0, 2).map((item) => item.key)).toEqual([
      'gelbooru:g1',
      'gelbooru:g2',
    ]);
    expect(hook.result.current.hits.slice(2).map((item) => item.key)).toEqual([
      'gelbooru:g3',
      'gelbooru:g4',
      'gelbooru:g5',
    ]);
  });

  test('a re-submitted cached query keeps every seen tile when its background refetch moves the window', async () => {
    const requestB: SearchRequest = { ...REQUEST, tags: ['cached-b'] };
    const pendingARefetch = deferred<ProviderPage<'gelbooru'>>();
    fetchGelbooru
      .mockResolvedValueOnce(gelbooruPage([
        hit('gelbooru', 'g1'),
        hit('gelbooru', 'g2'),
        hit('gelbooru', 'g3'),
      ], null))
      .mockResolvedValueOnce(gelbooruPage([
        hit('gelbooru', 'b1'),
      ], null))
      .mockImplementationOnce(() => pendingARefetch.promise);
    const providers: ImageProviderSettings = {
      ...NO_PROVIDERS,
      gelbooru: true,
    };
    const queryClient = createQueryClient();
    const hook = await renderHook(
      ({ request }: { request: SearchRequest }) => useSearch(request, providers),
      {
        initialProps: { request: REQUEST },
        wrapper: wrapper(queryClient),
      },
    );

    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      'gelbooru:g1',
      'gelbooru:g2',
      'gelbooru:g3',
    ]));
    await hook.rerender({ request: requestB });
    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual(['gelbooru:b1']));

    await hook.rerender({ request: REQUEST });
    await waitFor(() => expect(fetchGelbooru).toHaveBeenCalledTimes(3));
    expect(fetchGelbooru.mock.calls.map(([context]) => context.request.tags)).toEqual([
      REQUEST.tags,
      requestB.tags,
      REQUEST.tags,
    ]);
    expect(hook.result.current.hits.map((item) => item.key)).toEqual([
      'gelbooru:g1',
      'gelbooru:g2',
      'gelbooru:g3',
    ]);
    await act(async () => {
      hook.result.current.noteSeen(2);
      await Promise.resolve();
    });

    await act(async () => {
      pendingARefetch.resolve(gelbooruPage([
        hit('gelbooru', 'g2'),
        hit('gelbooru', 'g3'),
        hit('gelbooru', 'g4'),
        hit('gelbooru', 'g5'),
      ], null));
      await Promise.resolve();
    });
    await waitFor(() => expect(
      hook.result.current.hits.map((item) => item.key),
    ).toEqual([
      'gelbooru:g1',
      'gelbooru:g2',
      'gelbooru:g3',
      'gelbooru:g4',
      'gelbooru:g5',
    ]));
    expect(hook.result.current.hits[0]!.key).toBe('gelbooru:g1');
    expect(hook.result.current.hits[1]!.key).toBe('gelbooru:g2');
  });

  test('the seen line only moves down', async () => {
    jest.useFakeTimers();
    try {
      let renderCount = 0;
      const pendingNekos = deferred<ProviderPage<'nekos_api'>>();
      fetchWaifu.mockResolvedValue(waifuPage([
        hit('waifu_im', 'w1'), hit('waifu_im', 'w2'),
        hit('waifu_im', 'w3'), hit('waifu_im', 'w4'),
      ], null));
      fetchNekos.mockImplementation(() => pendingNekos.promise);
      const providers: ImageProviderSettings = {
        waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
        yandere: false, konachan: false, e621: false, e926: false,
        gelbooru: false, rule34: false,
      };
      const hook = await renderHook(() => {
        renderCount += 1;
        return useSearch(REQUEST, providers);
      }, {
        wrapper: wrapper(createQueryClient()),
      });
      await waitFor(() => expect(hook.result.current.hits).toHaveLength(1));
      await act(async () => {
        jest.advanceTimersByTime(SEARCH_FIRST_PAINT_MS + 1);
        await Promise.resolve();
      });
      await waitFor(() => expect(hook.result.current.hits).toHaveLength(4));
      await act(async () => {
        hook.result.current.noteSeen(3);
        await Promise.resolve();
      });
      const rendersAfterRaise = renderCount;
      await act(async () => {
        hook.result.current.noteSeen(2);
        await Promise.resolve();
      });
      expect(renderCount).toBe(rendersAfterRaise);
      await act(async () => pendingNekos.resolve(nekosPage([
        hit('nekos_api', 'n1'),
      ], null)));
      await waitFor(() => expect(
        hook.result.current.hits.map((item) => item.key),
      ).toEqual([
        'waifu_im:w1', 'waifu_im:w2', 'waifu_im:w3', 'nekos_api:n1', 'waifu_im:w4',
      ]));
    } finally {
      jest.useRealTimers();
    }
  });

  test('a new query starts the seen line at 0', async () => {
    jest.useFakeTimers();
    try {
      const nextNekos = deferred<ProviderPage<'nekos_api'>>();
      fetchWaifu.mockResolvedValue(waifuPage([
        hit('waifu_im', 'w1'), hit('waifu_im', 'w2'),
      ], null));
      fetchNekos
        .mockResolvedValueOnce(nekosPage([hit('nekos_api', 'n1')], null))
        .mockImplementationOnce(() => nextNekos.promise);
      const providers: ImageProviderSettings = {
        waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
        yandere: false, konachan: false, e621: false, e926: false,
        gelbooru: false, rule34: false,
      };
      const nextRequest: SearchRequest = { ...REQUEST, tags: ['new_query'] };
      const hook = await renderHook(
        ({ request }: { request: SearchRequest }) => useSearch(request, providers),
        {
          initialProps: { request: REQUEST },
          wrapper: wrapper(createQueryClient()),
        },
      );
      await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));
      await act(async () => {
        hook.result.current.noteSeen(2);
        await Promise.resolve();
      });
      const oldNoteSeen = hook.result.current.noteSeen;

      await hook.rerender({ request: nextRequest });
      await waitFor(() => expect(hook.result.current.hits).toHaveLength(1));
      await act(async () => {
        jest.advanceTimersByTime(SEARCH_FIRST_PAINT_MS + 1);
        await Promise.resolve();
      });
      await waitFor(() => expect(hook.result.current.hits).toHaveLength(2));
      await act(async () => {
        oldNoteSeen(99);
        await Promise.resolve();
      });
      await act(async () => nextNekos.resolve(nekosPage([
        hit('nekos_api', 'n2'),
      ], null)));
      await waitFor(() => expect(
        hook.result.current.hits.map((item) => item.key),
      ).toEqual(['waifu_im:w1', 'nekos_api:n2', 'waifu_im:w2']));
    } finally {
      jest.useRealTimers();
    }
  });

  test('a stale noteSeen from an older query does not change the current line', async () => {
    const pendingWaifu = deferred<ProviderPage<'waifu_im'>>();
    fetchWaifu
      .mockResolvedValueOnce(waifuPage([hit('waifu_im', 'a')], null))
      .mockImplementationOnce(() => pendingWaifu.promise);
    fetchNekos
      .mockResolvedValueOnce(nekosPage([hit('nekos_api', 'a')], null))
      .mockResolvedValueOnce(nekosPage([hit('nekos_api', 'b')], null));
    fetchDanbooru
      .mockResolvedValueOnce(danbooruPage([hit('danbooru', 'a')], null))
      .mockResolvedValueOnce(danbooruPage([hit('danbooru', 'b')], null));
    const providers: ImageProviderSettings = {
      waifu_im: true, nekos_api: true, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false,
      gelbooru: false, rule34: false,
    };
    const nextRequest: SearchRequest = { ...REQUEST, tags: ['stale-b'] };
    const hook = await renderHook(
      ({ request }: { request: SearchRequest }) => useSearch(request, providers),
      {
        initialProps: { request: REQUEST },
        wrapper: wrapper(createQueryClient()),
      },
    );

    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['waifu_im:a', 'nekos_api:a', 'danbooru:a']));
    await act(async () => hook.result.current.noteSeen(2));
    const staleNoteSeen = hook.result.current.noteSeen;

    await hook.rerender({ request: nextRequest });
    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['nekos_api:b', 'danbooru:b']));
    await act(async () => hook.result.current.noteSeen(2));
    await act(async () => staleNoteSeen(99));
    await act(async () => pendingWaifu.resolve(waifuPage([
      hit('waifu_im', 'b'),
    ], null)));

    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['nekos_api:b', 'danbooru:b', 'waifu_im:b']));
  });

  test('returning to an earlier query starts its seen line at 0 even after a stale callback', async () => {
    const pendingLateWaifu = deferred<ProviderPage<'waifu_im'>>();
    let waifuCalls = 0;
    fetchWaifu.mockImplementation(() => {
      waifuCalls += 1;
      if (waifuCalls === 1) return Promise.resolve(waifuPage([], null));
      if (waifuCalls === 2) {
        return Promise.resolve(waifuPage([hit('waifu_im', 'b')], null));
      }
      return pendingLateWaifu.promise;
    });
    fetchNekos.mockResolvedValue(nekosPage([hit('nekos_api', 'n')], null));
    fetchDanbooru.mockResolvedValue(danbooruPage([hit('danbooru', 'd')], null));
    const providers: ImageProviderSettings = {
      waifu_im: true, nekos_api: true, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false,
      gelbooru: false, rule34: false,
    };
    const earlierRequest = REQUEST;
    const laterRequest: SearchRequest = { ...REQUEST, tags: ['stale-b'] };
    const hook = await renderHook(
      ({ request }: { request: SearchRequest }) => useSearch(request, providers),
      {
        initialProps: { request: earlierRequest },
        wrapper: wrapper(createQueryClient()),
      },
    );

    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['nekos_api:n', 'danbooru:d']));
    const staleNoteSeen = hook.result.current.noteSeen;
    await act(async () => staleNoteSeen(2));

    await hook.rerender({ request: laterRequest });
    await waitFor(() => expect(hook.result.current.hits).toHaveLength(3));
    await act(async () => staleNoteSeen(99));

    await hook.rerender({ request: earlierRequest });
    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['nekos_api:n', 'danbooru:d']));
    let refetching!: Promise<void>;
    await act(async () => {
      refetching = hook.result.current.refetch();
      await Promise.resolve();
    });
    await waitFor(() => expect(waifuCalls).toBeGreaterThan(2));
    await act(async () => {
      pendingLateWaifu.resolve(waifuPage([hit('waifu_im', 'late')], null));
      await refetching;
    });

    await waitFor(() => expect(hook.result.current.hits.map((item) => item.key))
      .toEqual(['waifu_im:late', 'nekos_api:n', 'danbooru:d']));
  });
});
