import { DIRECT_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import {
  buildKonachanUrl,
  fetchKonachanBatch,
  fetchKonachanSearchPage,
} from './konachan-client';

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
    id: 999001,
    width: 1200,
    height: 1800,
    file_size: 300_000,
    file_ext: 'jpg',
    file_url: 'https://konachan.net/image/example.jpg',
    preview_url: 'https://konachan.net/preview/example.jpg',
    rating: 's',
    tags: '1girl solo example_artist',
    source: 'https://www.pixiv.net/artworks/999001',
    ...overrides,
  };
}

const mixedSettings = { ...DEFAULT_SETTINGS, nsfwMode: 'mixed' as const, nsfwConfirmed: true };

test('discovery query includes order:random for sample variation', () => {
  const tags = new URL(buildKonachanUrl(mixedSettings, 4, DIRECT_DISTRIBUTION_POLICY))
    .searchParams.get('tags')?.split(' ');
  expect(tags).toContain('order:random');
});

test.each(['sfw', 'mixed', 'nsfw'] as const)(
  'discovery query tag count stays within the anonymous 7-tag ceiling under nsfwMode=%s',
  (nsfwMode) => {
    // G2a-1 bug-class guard: Konachan's anonymous query cap is 7 tags total
    // (rating + exclusions + sample). Numeric assertion, not a smell check —
    // a future exclusion-tag addition that silently crosses 7 must fail here.
    const settings = { ...DEFAULT_SETTINGS, nsfwMode, nsfwConfirmed: true };
    const tags = new URL(buildKonachanUrl(settings, 4, DIRECT_DISTRIBUTION_POLICY))
      .searchParams.get('tags')?.split(' ')
      .filter(Boolean) ?? [];
    expect(tags.length).toBeLessThanOrEqual(7);
  },
);

test('discoveryLimitCap of 12 raises the discovery request size from the previous 8-post default', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([]));
  await fetchKonachanBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 12,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('limit')).toBe('12');
});

test('order:random never leaks into Konachan search pagination (contamination guard)', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([post()]));
  await fetchKonachanSearchPage({
    request: { tags: [], excludedTags: [], nsfwMode: 'mixed', orientation: 'any', animationMode: 'include', minWidth: 0, maxBytes: 0 },
    cursor: { page: 1 },
    limit: 1,
    fetcher,
  });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.searchParams.get('tags')?.split(' ')).not.toContain('order:random');
});

test('maps a recorded post and preserves split tags and identity', async () => {
  const batch = await fetchKonachanBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([post()])),
  });
  expect(batch.items[0]).toMatchObject({
    providerKey: 'konachan',
    providerItemId: '999001',
    contentRating: 'safe',
    nativeRating: 's',
    tags: ['1girl', 'solo', 'example_artist'],
  });
});
