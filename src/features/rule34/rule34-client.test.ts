import fixture from './fixtures/rule34-posts.json';

import { buildRule34Url, fetchRule34Batch } from '@/features/rule34/rule34-client';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import { DIRECT_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';

const CRED = { apiKey: 'test', userId: '42' };

// NOTE: this fixture was captured live 2026-09-05 (G4b Task 3), scrubbed
// (tags trimmed to 10, no query strings, no credential) — all 3 posts came
// back rating:explicit (Rule34's corpus is NSFW-skewed), so nsfw admits all 3.

test('config instance parses the bare-array fixture; nsfw admits all non-safe posts', async () => {
  const fetcher = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify(fixture),
    json: async () => fixture,
  }) as unknown as Response;
  const batch = await fetchRule34Batch({
    settings: { ...DEFAULT_SETTINGS, nsfwMode: 'nsfw', nsfwConfirmed: true, orientation: 'any' },
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(3);
  for (const item of batch.items) {
    expect(item).toMatchObject({ providerKey: 'rule34', isNsfw: true });
    expect(item.md5).toMatch(/^[0-9a-f]{32}$/);
  }
});

test('URL: DAPI query with json=1 and credential params', () => {
  const url = buildRule34Url(
    { ...DEFAULT_SETTINGS, nsfwMode: 'nsfw', nsfwConfirmed: true, orientation: 'any' },
    12,
    DIRECT_DISTRIBUTION_POLICY,
    0,
    CRED,
  );
  expect(url).toContain('https://api.rule34.xxx/index.php?');
  expect(url).toContain('page=dapi');
  expect(url).toContain('json=1');
  expect(url).toContain('api_key=test');
  expect(url).toContain('user_id=42');
});

test('Rule34 probes with no image headers', async () => {
  const calls: { init?: RequestInit }[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    calls.push({ init });
    if (init?.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '2345' : null },
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(fixture),
    } as unknown as Response;
  };

  await fetchRule34Batch({
    settings: {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
      orientation: 'any',
      maxBytes: 5_000_000,
    },
    excludedIds: [],
    count: 1,
    fetcher,
    credential: CRED,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
  });

  const probe = calls.find(({ init }) => init?.method === 'HEAD')?.init;
  expect(probe).toEqual({ method: 'HEAD', signal: expect.any(AbortSignal) });
  expect(probe && 'headers' in probe).toBe(false);
});
