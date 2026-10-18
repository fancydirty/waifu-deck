import fixture from './fixtures/gelbooru-posts.json';

import {
  buildGelbooruUrl,
  fetchGelbooruBatch,
  GELBOORU_IMAGE_HEADERS,
} from '@/features/gelbooru/gelbooru-client';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import { APP_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';

const CRED = { apiKey: 'test', userId: '42' };

// NOTE: this fixture was captured live 2026-09-04 (G4a Task 7), scrubbed
// (tags trimmed to 10, no query strings, no credential) — all 3 posts came
// back rating:general, so sfw admits all 3.

test('config instance parses the real-shape fixture; sfw admits every general post', async () => {
  const fetcher = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify(fixture),
    json: async () => fixture,
  }) as unknown as Response;
  const batch = await fetchGelbooruBatch({
    settings: { ...DEFAULT_SETTINGS, orientation: 'any' }, excludedIds: [], count: 3, fetcher,
    credential: CRED, distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(3);
  for (const item of batch.items) {
    expect(item).toMatchObject({ providerKey: 'gelbooru', isNsfw: false });
    expect(item.md5).toMatch(/^[0-9a-f]{32}$/);
  }
});

test('URL: DAPI query with json=1 and credential params', () => {
  const url = buildGelbooruUrl({ ...DEFAULT_SETTINGS, orientation: 'any' }, 12, APP_DISTRIBUTION_POLICY, 0, CRED);
  expect(url).toContain('https://gelbooru.com/index.php?');
  expect(url).toContain('page=dapi');
  expect(url).toContain('json=1');
  expect(url).toContain('api_key=test');
  expect(url).toContain('user_id=42');
});

test('the size probe carries Gelbooru\'s configured Referer', async () => {
  const calls: { init?: RequestInit }[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    calls.push({ init });
    if (init?.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '1234' : null },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(fixture),
    } as unknown as Response;
  };

  await fetchGelbooruBatch({
    settings: { ...DEFAULT_SETTINGS, orientation: 'any', maxBytes: 2_000_000 },
    excludedIds: [],
    count: 1,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(calls.find(({ init }) => init?.method === 'HEAD')?.init).toEqual({
    method: 'HEAD',
    headers: GELBOORU_IMAGE_HEADERS,
    signal: expect.any(AbortSignal),
  });
});
