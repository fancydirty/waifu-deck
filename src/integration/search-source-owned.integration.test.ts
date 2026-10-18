import { fetchDanbooruSearchPage } from '@/features/danbooru/danbooru-client';
import { fetchNekosSearchPage } from '@/features/nekos/nekos-client';
import type { SearchRequest } from '@/features/search/types';
import { fetchWaifuSearchPage } from '@/features/waifu/waifu-client';

jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));

const request: SearchRequest = {
  tags: [],
  excludedTags: [],
  nsfwMode: 'sfw',
  orientation: 'any',
  animationMode: 'include',
  minWidth: 0,
  maxBytes: 0,
};

function liveFetcher() {
  const urls: URL[] = [];
  return {
    urls,
    fetcher: async (url: string, init?: RequestInit) => {
      urls.push(new URL(url));
      return fetch(url, init);
    },
  };
}

// These are real API gates. Network, auth, and schema failures fail the run;
// none are relabeled as "unsupported" or silently skipped.
test('Danbooru itself rejects an over-limit query while every term reaches the wire', async () => {
  const { fetcher, urls } = liveFetcher();
  const result = await fetchDanbooruSearchPage({
    request: { ...request, tags: ['blue_hair solo smile'] },
    limit: 1,
    fetcher,
  });
  expect(urls[0]?.searchParams.get('tags')).toBe('rating:general blue_hair solo smile');
  expect(result.unsupportedQuery).toBe(true);
  expect(result.items).toEqual([]);
});

test('Chinese text reaches each source and its own response defines empty versus unsupported', async () => {
  const danbooru = liveFetcher();
  const waifu = liveFetcher();
  const nekos = liveFetcher();
  const query = { ...request, tags: ['福瑞'] };
  const danbooruPage = await fetchDanbooruSearchPage({ request: query, limit: 1, fetcher: danbooru.fetcher });
  const waifuPage = await fetchWaifuSearchPage({ request: query, limit: 1, fetcher: waifu.fetcher });
  const nekosPage = await fetchNekosSearchPage({ request: query, limit: 1, fetcher: nekos.fetcher });

  expect(danbooru.urls[0]?.searchParams.get('tags')).toBe('rating:general 福瑞');
  expect(waifu.urls[0]?.searchParams.getAll('IncludedTags')).toEqual(['福瑞']);
  expect(nekos.urls[0]?.searchParams.getAll('tag')).toEqual(['福瑞']);
  expect(danbooruPage.unsupportedQuery).not.toBe(true);
  expect(waifuPage.unsupportedQuery).toBe(true);
  expect(nekosPage.unsupportedQuery).not.toBe(true);
});

test('Nekos reports its five-tag limit instead of executing a silently truncated request', async () => {
  const { fetcher, urls } = liveFetcher();
  const tags = ['Girl', 'Boy', 'School Uniform', 'Maid', 'Glasses', 'Catgirl'];
  const result = await fetchNekosSearchPage({
    request: { ...request, tags },
    limit: 1,
    fetcher,
  });
  expect(urls[0]?.searchParams.getAll('tag')).toEqual(tags);
  expect(result.unsupportedQuery).toBe(true);
});

test('Nekos native tag names survive image metadata and can be searched unchanged', async () => {
  const { fetcher, urls } = liveFetcher();
  const first = await fetchNekosSearchPage({
    request: { ...request, tags: ['School Uniform'] },
    limit: 1,
    fetcher,
  });
  expect(first.items.length).toBeGreaterThan(0);
  const nativeTag = first.items[0]!.image.tags.find((tag) => tag === 'School Uniform');
  expect(nativeTag).toBe('School Uniform');
  expect(first.items[0]!.image.tags).not.toContain('uniform');

  const roundTrip = await fetchNekosSearchPage({
    request: { ...request, tags: [nativeTag!] },
    limit: 1,
    fetcher,
  });
  const queries = urls.filter((url) => url.hostname === 'api.nekosapi.com');
  expect(queries.map((url) => url.searchParams.getAll('tag')))
    .toEqual([['School Uniform'], ['School Uniform']]);
  expect(roundTrip.items[0]?.image.providerItemId).toBe(first.items[0]?.image.providerItemId);
});

test('Danbooru source ordering remains numbered and does not silently become ID ordering', async () => {
  const { fetcher, urls } = liveFetcher();
  const query = { ...request, tags: ['order:id_asc'] };
  const first = await fetchDanbooruSearchPage({ request: query, limit: 2, fetcher });
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.nextCursor).toEqual({ page: 2 });
  const second = await fetchDanbooruSearchPage({
    request: query, cursor: first.nextCursor, limit: 2, fetcher,
  });
  expect(urls[1]?.searchParams.get('page')).toBe('2');
  expect(urls[1]?.searchParams.get('tags')).toBe('rating:general order:id_asc');
  expect(second.items.length).toBeGreaterThan(0);
  expect(second.items.some(({ key }) => first.items.some((hit) => hit.key === key))).toBe(false);
  expect(Math.min(...second.items.map(({ image }) => Number(image.providerItemId))))
    .toBeGreaterThan(Math.max(...first.items.map(({ image }) => Number(image.providerItemId))));
});

test('Waifu uses stable source ordering across numbered search pages', async () => {
  const { fetcher, urls } = liveFetcher();
  const query = { ...request, tags: ['waifu'] };
  const first = await fetchWaifuSearchPage({ request: query, limit: 2, fetcher });
  expect(first.items.length).toBeGreaterThan(0);
  expect(first.nextCursor).toEqual({ page: 2 });
  const second = await fetchWaifuSearchPage({
    request: query, cursor: first.nextCursor, limit: 2, fetcher,
  });
  expect(urls.map((url) => url.searchParams.get('OrderBy'))).toEqual(['UploadedAt', 'UploadedAt']);
  expect(urls[1]?.searchParams.get('Page')).toBe('2');
  expect(second.items.length).toBeGreaterThan(0);
  expect(second.items.some(({ key }) => first.items.some((hit) => hit.key === key))).toBe(false);
});
