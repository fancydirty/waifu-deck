import { moebooruContentRating } from '@/features/content/content-taxonomy';
import { DIRECT_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { SearchRequest } from '@/features/search/types';
import type { AppSettings } from '@/features/waifu/types';

import {
  createMoebooruEngine,
  MoebooruApiError,
  type MoebooruEngineConfig,
} from './moebooru-engine';

// A test-only Moebooru instance: a fake host/label/color proves the engine is
// driven entirely by its config, not by any hard-coded Yande.re constant. The
// key stays 'yandere' so it maps to a real provider union member (no governor is
// injected here, so the governor key is never exercised).
const TEST_CONFIG: MoebooruEngineConfig<'yandere'> = {
  key: 'yandere',
  label: 'Example-Moe',
  postUrl: 'https://example-moe.test/post.json',
  host: 'example-moe.test',
  headers: { Accept: 'application/json' },
  maxLimit: 100,
  dominantColor: '#123456',
  toContentRating: moebooruContentRating,
  hardExclusionTags: new Set(['cosplay', 'photo']),
};

const engine = createMoebooruEngine(TEST_CONFIG);

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

// A recorded Moebooru `post.json` element (only the fields the engine consumes).
function recordedPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    width: 1000,
    height: 1500,
    file_size: 250_000,
    file_ext: 'png',
    file_url: 'https://example-moe.test/image/a.png',
    preview_url: 'https://example-moe.test/preview/a.png',
    rating: 's',
    tags: '1girl solo blue_hair',
    source: 'https://www.pixiv.net/artworks/42',
    ...overrides,
  };
}

// Quality filters neutralized so the assertions isolate engine parse/rating/
// exclusion behaviour rather than settings filtering.
const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'mixed',
  nsfwConfirmed: true,
  orientation: 'any',
  animationMode: 'include',
  minWidth: 0,
  maxBytes: 0,
  includedTags: [],
  excludedTags: [],
};

const searchRequest: SearchRequest = {
  tags: [],
  excludedTags: [],
  nsfwMode: 'mixed',
  orientation: 'any',
  animationMode: 'include',
  minWidth: 0,
  maxBytes: 0,
};

test('parses a recorded post into an ImageCandidate using only config constants', async () => {
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost()])),
  });

  expect(batch.totalCount).toBe(1);
  expect(batch.items[0]).toMatchObject({
    providerKey: 'yandere',
    providerItemId: '42',
    remoteUrl: 'https://example-moe.test/image/a.png',
    sourceUrl: 'https://www.pixiv.net/artworks/42',
    width: 1000,
    height: 1500,
    byteSize: 250_000,
    extension: '.png',
    dominantColor: '#123456',
    contentRating: 'safe',
    nativeRating: 's',
    isNsfw: false,
    isAnimated: false,
    tags: ['1girl', 'solo', 'blue_hair'],
  });
});

test('reads and lowercases the post\'s md5, defaulting to null when absent or empty', async () => {
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 3,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([
      recordedPost({ id: 1, md5: 'ABCDEF0123456789ABCDEF0123456789' }),
      recordedPost({ id: 2, md5: '' }),
      recordedPost({ id: 3 }),
    ])),
  });

  expect(batch.items.map((item) => item.md5)).toEqual([
    'abcdef0123456789abcdef0123456789',
    null,
    null,
  ]);
});

test('falls back to the config host for the source url when source is missing', async () => {
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost({ source: undefined })])),
  });
  expect(batch.items[0]?.sourceUrl).toBe('https://example-moe.test/post/show/42');
});

test('maps every native rating through the injected toContentRating', async () => {
  for (const [rating, contentRating] of [
    ['s', 'safe'],
    ['q', 'nsfw_unspecified'],
    ['e', 'explicit'],
  ] as const) {
    const batch = await engine.fetchBatch({
      settings,
      excludedIds: [],
      count: 1,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost({ rating })])),
    });
    expect(batch.items[0]).toMatchObject({ nativeRating: rating, contentRating });
  }
});

test('injects rating:s into the query under SFW mode and targets config.postUrl', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([recordedPost()]));
  await engine.fetchBatch({
    settings: { ...settings, nsfwMode: 'sfw' },
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe('https://example-moe.test/post.json');
  expect(url.searchParams.get('tags')?.split(' ')).toContain('rating:s');
});

test('drops posts carrying a configured hard-exclusion tag', async () => {
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost({ tags: '1girl cosplay' })])),
  });
  expect(batch.items).toEqual([]);
});

test('queryExclusionTags subset drives the query while the full hardExclusionTags set still filters client-side', async () => {
  // Pins the safety-critical split behind the Konachan 7-tag-cap fix
  // (G2a-1 task4): queryExclusionTags is a STRICT SUBSET of hardExclusionTags.
  // Only the subset may go into the query URL; the FULL set must still bite
  // client-side in adaptPosts, so reducing what is sent query-side never
  // silently reduces content filtering.
  const splitConfig: MoebooruEngineConfig<'yandere'> = {
    ...TEST_CONFIG,
    hardExclusionTags: new Set(['photo', 'loli']),
    queryExclusionTags: new Set(['loli']),
  };
  const splitEngine = createMoebooruEngine(splitConfig);

  // (a) Query-side carries ONLY the subset: `-loli` is present, `-photo` is not.
  const url = new URL(splitEngine.buildUrl(settings, 4, DIRECT_DISTRIBUTION_POLICY));
  const queryTags = url.searchParams.get('tags')?.split(' ') ?? [];
  expect(queryTags).toContain('-loli');
  expect(queryTags).not.toContain('-photo');

  // (b) Client-side hasHardExcludedTag still uses the FULL set: a `photo`-tagged
  // post is dropped even though `photo` was never query-excluded, while a
  // control post with no excluded tags survives.
  const batch = await splitEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([
      recordedPost({ id: 100, tags: '1girl photo' }),
      recordedPost({ id: 200, tags: '1girl solo' }),
    ])),
  });
  expect(batch.items.map((item) => item.providerItemId)).toEqual(['200']);
});

test('search pagination: a full page advances the cursor, a short page ends it', async () => {
  const full = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: { page: 1 },
    limit: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([
      recordedPost({ id: 1 }),
      recordedPost({ id: 2, file_url: 'https://example-moe.test/image/b.png' }),
    ])),
  });
  expect(full.providerKey).toBe('yandere');
  expect(full.items.map((hit) => hit.key)).toEqual(['yandere:1', 'yandere:2']);
  expect(full.nextCursor).toEqual({ page: 2 });

  const short = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: { page: 1 },
    limit: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost({ id: 3 })])),
  });
  expect(short.nextCursor).toBeNull();
});

test('a null search cursor short-circuits to an empty exhausted page', async () => {
  const fetcher = jest.fn();
  const page = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: null,
    fetcher,
  });
  expect(page).toEqual({ providerKey: 'yandere', items: [], nextCursor: null });
  expect(fetcher).not.toHaveBeenCalled();
});

test('preserves Chinese and native query syntax and trusts provider-matched posts', async () => {
  const fetcher = jest.fn(async (_url: string) => jsonResponse([recordedPost()]));
  const page = await engine.fetchSearchPage({
    request: { ...searchRequest, tags: ['福瑞 id:1,2 -bar MiXeD-case'] },
    fetcher,
  });

  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('tags'))
    .toBe('福瑞 id:1,2 -bar MiXeD-case -cosplay -photo');
  expect(page.items).toHaveLength(1);
});

test('discoverySampleTag is appended to the discovery URL when configured', () => {
  const sampledEngine = createMoebooruEngine({ ...TEST_CONFIG, discoverySampleTag: 'order:random' });
  const tags = new URL(sampledEngine.buildUrl(settings, 4, DIRECT_DISTRIBUTION_POLICY)).searchParams.get('tags')?.split(' ');
  expect(tags).toContain('order:random');
});

test('discovery URL omits the sample tag when discoverySampleTag is not configured (regression)', () => {
  const tags = new URL(engine.buildUrl(settings, 4, DIRECT_DISTRIBUTION_POLICY)).searchParams.get('tags')?.split(' ');
  expect(tags).not.toContain('order:random');
});

test('discoverySampleTag never leaks into search pagination (contamination guard)', async () => {
  // Search is already correctly paginated via cursor.page; order:random would
  // break its stable ordering across pages, so this must stay empty even when
  // the config sets the tag for discovery.
  const sampledEngine = createMoebooruEngine({ ...TEST_CONFIG, discoverySampleTag: 'order:random' });
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([recordedPost()]));
  await sampledEngine.fetchSearchPage({
    request: searchRequest,
    cursor: { page: 1 },
    limit: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.searchParams.get('tags')?.split(' ')).not.toContain('order:random');
});

test('a raised discoveryLimitCap (12) allows a full 12-post discovery request', async () => {
  const cappedEngine = createMoebooruEngine({ ...TEST_CONFIG, discoveryLimitCap: 12 });
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([]));
  await cappedEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 12,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('limit')).toBe('12');
});

test('the default discoveryLimitCap (8) still caps a larger count (regression)', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([]));
  await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 12,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('limit')).toBe('8');
});

test('exposes MoebooruApiError and throws it on non-array payloads', async () => {
  expect(engine.ApiError).toBe(MoebooruApiError);
  await expect(engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse({ not: 'an array' })),
  })).rejects.toBeInstanceOf(MoebooruApiError);
});

test('R8.18: sample_url becomes the display sampleUrl, else it falls back to remoteUrl', async () => {
  const withSample = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(
      jsonResponse([recordedPost({ sample_url: 'https://example-moe.test/sample/a.jpg' })]),
    ),
  });
  expect(withSample.items[0]?.sampleUrl).toBe('https://example-moe.test/sample/a.jpg');

  const withoutSample = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost()])),
  });
  expect(withoutSample.items[0]?.sampleUrl).toBe('https://example-moe.test/image/a.png');
});

test('R8.24: a search hit previews the sample, falling back to the original', async () => {
  const withSample = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: { page: 1 },
    limit: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([
      recordedPost({ sample_url: 'https://example-moe.test/sample/a.jpg' }),
    ])),
  });
  // A Konachan/Yande.re original is a 3-16 MB wallpaper; a ~140 dp grid tile
  // must never pull it (R8.24 owner report: solid-coloured `maid` results).
  expect(withSample.items[0]?.previewUrl).toBe('https://example-moe.test/sample/a.jpg');

  const withoutSample = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: { page: 1 },
    limit: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([recordedPost()])),
  });
  expect(withoutSample.items[0]?.previewUrl).toBe('https://example-moe.test/image/a.png');
});
