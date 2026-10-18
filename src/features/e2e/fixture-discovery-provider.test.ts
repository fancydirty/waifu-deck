import {
  createFixtureDiscoveryFetcher,
} from '@/features/e2e/fixture-discovery-provider';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';

describe('fixture discovery provider', () => {
  it('returns stable unique SFW candidates from the configured endpoint', async () => {
    const fetchBatch = createFixtureDiscoveryFetcher({
      fixtureBaseUrl: 'https://fixtures.example/root/',
    });

    const input = {
      settings: DEFAULT_SETTINGS,
      excludedProviderIds: {},
      desiredCount: 4,
    };
    const first = await fetchBatch(input);
    const second = await fetchBatch(input);

    expect(first).toEqual(second);
    expect(first.totalCount).toBe(16);
    expect(first.items).toHaveLength(4);
    expect(new Set(first.items.map((item) => item.providerItemId)).size).toBe(4);
    expect(first.items[0]).toEqual(expect.objectContaining({
      providerKey: 'waifu_im',
      providerItemId: 'e2e-fixture-01',
      remoteUrl: 'https://fixtures.example/root/images/fixture-01.png',
      width: 720,
      height: 1280,
      extension: 'png',
      contentRating: 'safe',
      isNsfw: false,
      isAnimated: false,
    }));
  });

  it('honors provider exclusions before applying the desired count', async () => {
    const fetchBatch = createFixtureDiscoveryFetcher({
      fixtureBaseUrl: 'https://fixtures.example',
    });

    const result = await fetchBatch({
      settings: DEFAULT_SETTINGS,
      excludedProviderIds: {
        waifu_im: ['e2e-fixture-01', 'e2e-fixture-03'],
      },
      desiredCount: 3,
    });

    expect(result.items.map((item) => item.providerItemId)).toEqual([
      'e2e-fixture-02',
      'e2e-fixture-04',
      'e2e-fixture-05',
    ]);
  });

  it('rejects immediately when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchBatch = createFixtureDiscoveryFetcher({
      fixtureBaseUrl: 'https://fixtures.example',
    });

    await expect(fetchBatch({
      settings: DEFAULT_SETTINGS,
      excludedProviderIds: {},
      // Aborts before desiredCount is ever read (see the `signal?.aborted`
      // check at the top of createFixtureDiscoveryFetcher's returned
      // function) — any value satisfies the now-required-param type.
      desiredCount: 4,
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'aborted',
    });
  });
});
