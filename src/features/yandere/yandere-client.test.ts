import { DIRECT_DISTRIBUTION_POLICY, STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import {
  buildYandereUrl,
  fetchYandereBatch,
  fetchYandereSearchPage,
  YANDERE_NATIVE_RATINGS,
  YandereApiError,
} from './yandere-client';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: 1266851,
    width: 1200,
    height: 1800,
    file_size: 400_000,
    file_ext: 'jpg',
    file_url: 'https://files.yande.re/image/example.jpg',
    preview_url: 'https://assets.yande.re/preview/example.jpg',
    rating: 's',
    tags: '1girl solo example_artist',
    source: 'https://www.pixiv.net/artworks/1266851',
    ...overrides,
  };
}

const mixedSettings = { ...DEFAULT_SETTINGS, nsfwMode: 'mixed' as const, nsfwConfirmed: true };

test('rejects a hard-excluded tag after parsing', async () => {
  const batch = await fetchYandereBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'mixed',
      nsfwConfirmed: true,
    },
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([{
      ...post({ tags: '1girl cosplay' }),
    }])),
  });

  expect(batch.items).toEqual([]);
});

test('maps all native ratings and preserves split tags and identity', async () => {
  expect(YANDERE_NATIVE_RATINGS).toEqual(['s', 'q', 'e']);
  for (const [rating, contentRating] of [['s', 'safe'], ['q', 'nsfw_unspecified'], ['e', 'explicit']] as const) {
    const batch = await fetchYandereBatch({
      settings: mixedSettings, excludedIds: [], count: 1,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest.fn().mockResolvedValue(jsonResponse([post({ rating })])),
    });
    expect(batch.items[0]).toMatchObject({
      providerKey: 'yandere', providerItemId: '1266851', contentRating, nativeRating: rating,
      tags: ['1girl', 'solo', 'example_artist'],
    });
  }
});

test('always requests rating:s for Store and SFW', () => {
  expect(new URL(buildYandereUrl(DEFAULT_SETTINGS)).searchParams.get('tags')).toContain('rating:s');
  expect(new URL(buildYandereUrl({ ...mixedSettings, nsfwMode: 'sfw' })).searchParams.get('tags')).toContain('rating:s');
});

test('does not apply Danbooru style preference tags to Yande.re discovery', () => {
  const tags = new URL(buildYandereUrl({
    ...DEFAULT_SETTINGS,
    stylePreference: 'prefer-3d',
  })).searchParams.get('tags')?.split(' ');

  expect(tags).not.toContain('3d');
  expect(tags).not.toContain('2d');
});

test.each(['q', 'e'] as const)('Store rejects %s', async (rating) => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([post({ rating })]));
  await expect(fetchYandereBatch({ settings: DEFAULT_SETTINGS, excludedIds: [], count: 1, distributionPolicy: STORE_DISTRIBUTION_POLICY, fetcher })).resolves.toEqual({ items: [], totalCount: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('fails closed on an unknown rating', async () => {
  await expect(fetchYandereBatch({
    settings: mixedSettings, excludedIds: [], count: 1,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([post({ rating: 'general' })])),
  })).rejects.toMatchObject({ code: 'invalid_response' } satisfies Partial<YandereApiError>);
});

test.each(['cosplay', 'cosplayer', 'photo', 'photography', 'real_life', 'real_person', 'loli', 'shota'])('rejects %s under Direct', async (tag) => {
  const batch = await fetchYandereBatch({ settings: mixedSettings, excludedIds: [], count: 1, distributionPolicy: DIRECT_DISTRIBUTION_POLICY, fetcher: jest.fn().mockResolvedValue(jsonResponse([post({ tags: `1girl ${tag}` })])) });
  expect(batch.items).toEqual([]);
});

test('forwards search tags and returns stable search identity', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([post()]));
  const page = await fetchYandereSearchPage({
    request: { tags: ['solo'], excludedTags: ['guro'], nsfwMode: 'sfw', orientation: 'portrait', animationMode: 'exclude', minWidth: 0, maxBytes: 0 },
    limit: 1, fetcher,
  });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe('https://yande.re/post.json');
  expect(url.searchParams.get('tags')?.split(' ')).toEqual(expect.arrayContaining(['rating:s', 'solo', '-guro']));
  expect(page).toMatchObject({ providerKey: 'yandere', items: [{ key: 'yandere:1266851' }] });
});

test('discovery query includes order:random for sample variation', () => {
  const tags = new URL(buildYandereUrl(mixedSettings)).searchParams.get('tags')?.split(' ');
  expect(tags).toContain('order:random');
});

test('order:random never leaks into search pagination (contamination guard)', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([post()]));
  await fetchYandereSearchPage({
    request: { tags: [], excludedTags: [], nsfwMode: 'mixed', orientation: 'any', animationMode: 'include', minWidth: 0, maxBytes: 0 },
    limit: 1,
    fetcher,
  });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.searchParams.get('tags')?.split(' ')).not.toContain('order:random');
});

test('discoveryLimitCap of 12 raises the discovery request size from the previous 8-post default', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([]));
  await fetchYandereBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 12,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('limit')).toBe('12');
});
