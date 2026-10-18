import { STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { fetchE926Batch } from '@/features/e926/e926-client';
import { fetchKonachanBatch } from '@/features/konachan/konachan-client';
import { fetchSafebooruBatch } from '@/features/safebooru/safebooru-client';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { ImageCandidate } from '@/features/waifu/types';
import type { ProviderYieldStat } from '@/features/providers/provider-yield-ledger';
import type { fetchWaifuBatch } from '@/features/waifu/waifu-client';
import type { fetchGelbooruBatch } from '@/features/gelbooru/gelbooru-client';

jest.mock('@/features/safebooru/safebooru-client', () => ({
  fetchSafebooruBatch: jest.fn(async () => ({ items: [], totalCount: 0 })),
}));
jest.mock('@/features/yandere/yandere-client', () => ({
  fetchYandereBatch: jest.fn(async () => ({ items: [], totalCount: 0 })),
}));
jest.mock('@/features/konachan/konachan-client', () => ({
  fetchKonachanBatch: jest.fn(async () => ({ items: [], totalCount: 0 })),
}));
jest.mock('@/features/e621/e621-client', () => ({
  fetchE621Batch: jest.fn(async () => ({ items: [], totalCount: 0 })),
}));
jest.mock('@/features/e926/e926-client', () => ({
  fetchE926Batch: jest.fn(async () => ({ items: [], totalCount: 0 })),
}));
jest.mock('@/features/rule34/rule34-client', () => ({
  fetchRule34Batch: jest.fn(async () => ({ items: [], totalCount: 0 })),
}));

import {
  createDiscoveryProviderFetcher,
  discoveryProviderErrorMessage,
} from './provider-client';

function candidate(
  providerKey: ImageCandidate['providerKey'],
  providerItemId: string,
  canonicalSourceKey: string | null = null,
): ImageCandidate {
  return {
    providerKey,
    providerItemId,
    canonicalSourceKey,
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
    tags: ['waifu'],
  };
}

test('requests enabled providers with scoped exclusions and interleaves results', async () => {
  const fetchWaifu = jest.fn(async () => ({
    items: [candidate('waifu_im', '1'), candidate('waifu_im', '2', 'pixiv:7')],
    totalCount: 2,
  }));
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'a'), {
      ...candidate('nekos_api', 'b', 'pixiv:7'),
      contentRating: 'explicit' as const,
      nativeRating: 'explicit',
      isNsfw: true,
    }],
    totalCount: 2,
  }));
  const fetchDanbooru = jest.fn(async () => ({
    items: [candidate('danbooru', 'd'), candidate('danbooru', 'e')],
    totalCount: 2,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  // 7 admitted under DEFAULT_SETTINGS (portrait admission-gates konachan out):
  // waifu_im, nekos_api, danbooru, safebooru, yandere, e621, e926.
  //
  // G3c task2 replaces the uniform share with `planProviderShares`. Cold start
  // (no yieldStats), desiredCount 21, base = ceil(21/7) = 3:
  //   share = min(3, cap) -> waifu 3, nekos 3, danbooru 3, safebooru 3,
  //   yandere 3, e621 2 (cap 2), e926 2 (cap 2); slack = 1 + 1 = 2.
  //   Receivers with headroom, all weight 1 (no evidence): waifu, nekos,
  //   danbooru, safebooru, yandere -> quota 2/5 = 0.4 each, floor 0, so the
  //   2 leftover units go by registry order -> waifu 4, nekos 4.
  // The uniform model asked e621/e926 for 3 each and let their engines clamp
  // it back to 2 in silence; the plan now spends those 2 units on sources that
  // can actually use them. That redistribution IS this cut.
  const result = await fetchBatch({
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {
      waifu_im: ['8'],
      nekos_api: ['old'],
      danbooru: ['seen'],
    },
    desiredCount: 21,
  });

  expect(fetchWaifu).toHaveBeenCalledWith(expect.objectContaining({
    excludedIds: [8],
    pageSize: 4,
  }));
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({
    excludedIds: ['old'],
    count: 4,
  }));
  expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({
    excludedIds: ['seen'],
    count: 3,
  }));
  // No top-up wave here: every source returned FEWER items than its share
  // (2 < 4, 2 < 4, 2 < 3), i.e. exhausted rather than capped.
  expect(fetchWaifu).toHaveBeenCalledTimes(1);
  expect(fetchNekos).toHaveBeenCalledTimes(1);
  expect(fetchDanbooru).toHaveBeenCalledTimes(1);
  expect(result.items.map((image) => `${image.providerKey}:${image.providerItemId}`))
    .toEqual([
      'waifu_im:1',
      'nekos_api:a',
      'danbooru:d',
      'waifu_im:2',
      'danbooru:e',
    ]);
  expect(result.items.find((image) => image.canonicalSourceKey === 'pixiv:7'))
    .toMatchObject({ contentRating: 'explicit', isNsfw: true });
});

test('fetches Yande.re only when its provider setting is enabled', async () => {
  const fetchYandere = jest.fn(async () => ({
    items: [candidate('yandere', 'y1')],
    totalCount: 1,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchYandere });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: false,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: true,
      konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  await expect(fetchBatch({
    settings,
    excludedProviderIds: { yandere: ['seen'] },
    // 1 admitted (only yandere enabled): base = ceil(8/1) = 8, and
    // min(8, cap 12) = 8 with no slack to move. Unchanged by the share plan
    // — a sole source under its cap is the one shape where the plan and the
    // old uniform split cannot differ.
    desiredCount: 8,
  })).resolves.toMatchObject({ items: [{ providerKey: 'yandere' }] });
  expect(fetchYandere).toHaveBeenCalledWith(expect.objectContaining({
    excludedIds: ['seen'],
    count: 8,
  }));
});

test('does not fetch Yande.re when its provider setting is disabled', async () => {
  const fetchYandere = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'n1')],
    totalCount: 1,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchNekos, fetchYandere });

  await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: {
        waifu_im: false,
        nekos_api: true,
        danbooru: false,
        safebooru: false,
        yandere: false,
        konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
      },
    },
    excludedProviderIds: {},
    // No count assertions in this test — desiredCount just satisfies the
    // required-param type; the scenario is "yandere never called".
    desiredCount: 4,
  });

  expect(fetchYandere).not.toHaveBeenCalled();
});

test('sizes provider work from the number of cards the deck actually needs', async () => {
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  // 7 admitted, desiredCount 5: base = max(1, ceil(5/7)) = 1, every cap is
  // >= 1 so there is no slack. The floor invariant IS the answer here — the
  // plan lands on the same 1 the uniform split did, and no source is dropped
  // to zero to make the arithmetic come out.
  await fetchBatch({
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {},
    desiredCount: 5,
  });

  expect(fetchWaifu).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 1 }));
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
});

test('forces SFW settings at the Store discovery provider boundary', async () => {
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
    distributionPolicy: STORE_DISTRIBUTION_POLICY,
  });

  await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: { waifu_im: true, nekos_api: true, danbooru: true, safebooru: true, yandere: true, konachan: true, e621: true, e926: true, gelbooru: false, rule34: false },
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
    },
    excludedProviderIds: {},
    // No count assertions here — only the SFW-forcing of `settings` is
    // checked. desiredCount just satisfies the required-param type.
    desiredCount: 8,
  });

  expect(fetchWaifu).toHaveBeenCalledWith(expect.objectContaining({
    settings: expect.objectContaining({
      nsfwMode: 'sfw',
      nsfwConfirmed: false,
    }),
  }));
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({
    settings: expect.objectContaining({ nsfwMode: 'sfw', nsfwConfirmed: false }),
  }));
  expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({
    settings: expect.objectContaining({ nsfwMode: 'sfw', nsfwConfirmed: false }),
  }));
});

test('keeps serving from a healthy provider when the other one fails', async () => {
  const fetchWaifu = jest.fn(async () => {
    throw new Error('waifu unavailable');
  });
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'a')],
    totalCount: 1,
  }));
  const fetchDanbooru = jest.fn(async () => {
    throw new Error('danbooru unavailable');
  });
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  await expect(fetchBatch({
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {},
    // No count assertions — just resolves from the healthy provider.
    desiredCount: 7,
  })).resolves.toMatchObject({ items: [{ providerKey: 'nekos_api' }] });
});

test('an empty round with one network failure resolves empty and records the failure', async () => {
  // Board #19 (inverts the pre-row-19 "does not misreport exhaustion" pin).
  // Waifu and Danbooru answered — with nothing new — so the pool is drained,
  // not unreachable. Only a round where every admitted source failed is an
  // error; here the failure stays visible in providerRounds for the ledger.
  const networkError = Object.assign(new Error('offline'), { code: 'network' });
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => {
    throw networkError;
  });
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  const batch = await fetchBatch({
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {},
    // No count assertions — only the resolution and the round record matter.
    desiredCount: 7,
  });

  expect(batch.items).toEqual([]);
  expect(batch.providerRounds).toEqual(expect.arrayContaining([
    expect.objectContaining({ providerKey: 'waifu_im', outcome: 'ok', admitted: 0 }),
    expect.objectContaining({ providerKey: 'danbooru', outcome: 'ok', admitted: 0 }),
    expect.objectContaining({ providerKey: 'nekos_api', outcome: 'failed', failureCode: 'network' }),
  ]));
});

test('one failed source among sources that answered with zero items is not an error (mixed mode, Safebooru admitted)', async () => {
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu: jest.fn(async () => ({ items: [], totalCount: 0 })),
    fetchNekos: jest.fn(async () => ({ items: [], totalCount: 0 })),
    fetchSafebooru: jest.fn(async () => {
      throw Object.assign(new Error('Safebooru request failed'), { code: 'network' });
    }),
  });

  const batch = await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'mixed',
      nsfwConfirmed: true,
      animationMode: 'only',
      providers: { waifu_im: true, nekos_api: true, danbooru: false, safebooru: true, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    },
    excludedProviderIds: {},
    desiredCount: 6,
  });

  expect(batch.items).toEqual([]);
  expect(batch.providerRounds).toEqual(expect.arrayContaining([
    expect.objectContaining({ providerKey: 'waifu_im', outcome: 'ok', admitted: 0 }),
    expect.objectContaining({ providerKey: 'safebooru', outcome: 'failed', failureCode: 'network' }),
  ]));
});

test('board #19 (D3 = B): an 仅NSFW + 仅动图 round asks Safebooru and serves its gifs', async () => {
  const gif: ImageCandidate = {
    ...candidate('safebooru', 'q1'),
    extension: '.gif',
    isAnimated: true,
    isNsfw: true,
    contentRating: 'nsfw_unspecified',
    nativeRating: 'questionable',
  };
  const fetchSafebooru = jest.fn(async () => ({ items: [gif], totalCount: 1 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu: jest.fn(async () => ({ items: [], totalCount: 0 })),
    fetchSafebooru,
  });

  const batch = await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
      animationMode: 'only',
      providers: { waifu_im: true, nekos_api: false, danbooru: false, safebooru: true, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    },
    excludedProviderIds: {},
    desiredCount: 6,
  });

  expect(fetchSafebooru).toHaveBeenCalledTimes(1);
  expect(batch.items).toEqual([expect.objectContaining({ providerKey: 'safebooru', providerItemId: 'q1' })]);
  expect(batch.providerRounds).toEqual(expect.arrayContaining([
    expect.objectContaining({ providerKey: 'safebooru', outcome: 'ok', admitted: 1 }),
  ]));
});

test('every admitted source failing is still a DiscoveryProviderError', async () => {
  const offline = () => jest.fn(async () => {
    throw Object.assign(new Error('offline'), { code: 'network' });
  });
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu: offline(),
    fetchSafebooru: offline(),
  });

  await expect(fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: { waifu_im: true, nekos_api: false, danbooru: false, safebooru: true, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    },
    excludedProviderIds: {},
    desiredCount: 6,
  })).rejects.toMatchObject({ name: 'DiscoveryProviderError', code: 'network' });
});

test('keeps Waifu disabled and ignores its persisted tag for healthy providers', async () => {
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchDanbooru = jest.fn(async () => ({
    items: [candidate('danbooru', 'd')],
    totalCount: 1,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    includedTags: ['waifu', 'raiden-shogun'],
  };

  // No count assertions — only settings-forwarding and enablement are
  // checked. desiredCount just satisfies the required-param type.
  await expect(fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 4 }))
    .resolves.toMatchObject({ items: [{ providerKey: 'danbooru' }] });
  expect(fetchWaifu).not.toHaveBeenCalled();
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({ settings }));
  expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({ settings }));
});

test('serves from sole Nekos with a persisted Waifu-only tag', async () => {
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'a')],
    totalCount: 1,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchNekos });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: { waifu_im: false, nekos_api: true, danbooru: false, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    includedTags: ['waifu', 'raiden-shogun'],
  };

  // No count assertions — only settings-forwarding is checked.
  await expect(fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 4 }))
    .resolves.toMatchObject({ items: [{ providerKey: 'nekos_api' }] });
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({ settings }));
});

test('returns the first healthy non-empty provider without waiting for a slow source', async () => {
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'fast')],
    totalCount: 1,
  }));
  let slowSignal: AbortSignal | undefined;
  const fetchDanbooru = jest.fn(({ signal }: { signal?: AbortSignal }) => {
    slowSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(
        Object.assign(new Error('cancelled after fast provider won'), { code: 'aborted' }),
      ), { once: true });
    });
  });
  const fetchBatch = createDiscoveryProviderFetcher({ fetchNekos, fetchDanbooru });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    includedTags: ['waifu', 'raiden-shogun'],
  };

  await expect(fetchBatch({
    settings,
    excludedProviderIds: {},
    preferFirstUsable: true,
    // No count assertions — only the race-and-abort behavior is checked.
    desiredCount: 4,
  })).resolves.toMatchObject({ items: [{ providerItemId: 'fast' }] });
  expect(slowSignal?.aborted).toBe(true);
});

test('names both enabled providers when they are actually unreachable', async () => {
  const offline = (provider: string) => Object.assign(
    new Error(`${provider} offline`),
    { code: 'network' },
  );
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchNekos: jest.fn(async () => { throw offline('nekos'); }),
    fetchDanbooru: jest.fn(async () => { throw offline('danbooru'); }),
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
  };

  // No count assertions — only the failure list/message is checked.
  const error = await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 4 }).catch(
    (failure: unknown) => failure,
  );

  expect(error).toMatchObject({
    code: 'network',
    failures: [
      expect.objectContaining({ providerKey: 'nekos_api' }),
      expect.objectContaining({ providerKey: 'danbooru' }),
    ],
  });
  expect(discoveryProviderErrorMessage(error)).toBe(
    'Nekos API、Danbooru 当前无法连接，请检查网络后重试',
  );
});

test('preserves transient metadata and retries when the first source can recover', async () => {
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu: jest.fn(async () => {
      throw Object.assign(new Error('waifu rate limited'), {
        code: 'rate_limited',
        status: 429,
        retryAfterMs: 2_000,
      });
    }),
    fetchNekos: jest.fn(async () => {
      throw Object.assign(new Error('nekos rate limited'), {
        code: 'rate_limited',
        status: 429,
        retryAfterMs: 7_000,
      });
    }),
    fetchDanbooru: jest.fn(async () => {
      throw Object.assign(new Error('danbooru offline'), { code: 'network' });
    }),
  });

  await expect(fetchBatch({
    // Board #19: only an all-failed round throws, so the default-on module
    // sources (whose mocks answer empty) are switched off to keep this an
    // all-failed round.
    settings: {
      ...DEFAULT_SETTINGS,
      providers: { waifu_im: true, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    },
    excludedProviderIds: {},
    // No count assertions — only the retryAfterMs/failure metadata is checked.
    desiredCount: 7,
  })).rejects.toMatchObject({
    code: 'rate_limited',
    retryAfterMs: 2_000,
    failures: [
      expect.objectContaining({
        providerKey: 'waifu_im',
        status: 429,
        retryAfterMs: 2_000,
      }),
      expect.objectContaining({
        providerKey: 'nekos_api',
        status: 429,
        retryAfterMs: 7_000,
      }),
      expect.objectContaining({ providerKey: 'danbooru', code: 'network' }),
    ],
  });
});

test('does not call a disabled provider', async () => {
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'a')],
    totalCount: 1,
  }));
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
        providers: { waifu_im: false, nekos_api: true, danbooru: false, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    },
    excludedProviderIds: {},
    // 1 admitted (only nekos_api enabled): base = 8 and nekos' cap is
    // exactly 8, so share = min(8, 8) = 8 — the plan sits right on the cap.
    // Unchanged from the uniform split; asking 9 would now be impossible.
    desiredCount: 8,
  });

  expect(fetchWaifu).not.toHaveBeenCalled();
  expect(fetchDanbooru).not.toHaveBeenCalled();
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({ count: 8 }));
});

test('requests Safebooru only when its provider checkbox is enabled', async () => {
  const fetchSafebooru = jest.fn(async () => ({
    items: [candidate('safebooru', 'safe-1')],
    totalCount: 1,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchSafebooru });

  await expect(fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: {
        waifu_im: false,
        nekos_api: false,
        danbooru: false,
        safebooru: true,
        yandere: false,
        konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
      },
    },
    excludedProviderIds: { safebooru: ['seen'] },
    // 1 admitted (only safebooru enabled): base = 8, cap 8, share 8.
    // Unchanged; safebooru is `available` here (sfw), so no degraded halving.
    desiredCount: 8,
  })).resolves.toMatchObject({
    items: [expect.objectContaining({ providerKey: 'safebooru' })],
  });
  expect(fetchSafebooru).toHaveBeenCalledWith(expect.objectContaining({
    excludedIds: ['seen'],
    count: 8,
  }));
});

test('excludes a structurally-unavailable provider from providerCount and skips its fetch (konachan/portrait)', async () => {
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  (fetchKonachanBatch as jest.Mock).mockClear();
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  await fetchBatch({
    // DEFAULT_SETTINGS: orientation 'portrait', all 8 providers enabled.
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {},
    desiredCount: 8,
  });

  // Konachan has no portrait corpus — skipped entirely, no request issued.
  expect(fetchKonachanBatch).not.toHaveBeenCalled();
  // The plan's denominator must exclude Konachan (7, not 8): base =
  // ceil(8/7) = 2, whereas the old un-gated computation would have produced
  // ceil(8/8) = 1. Every cap is >= 2 here (e621/e926 are exactly 2), so there
  // is no slack and the share plan lands on the same 2 the uniform split did.
  expect(fetchWaifu).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 2 }));
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
  expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
});

test('excludes e926 from providerCount and skips its fetch under nsfw mode', async () => {
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  (fetchE926Batch as jest.Mock).mockClear();
  (fetchSafebooruBatch as jest.Mock).mockClear();
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      // Landscape keeps Konachan admitted so this test isolates e926.
      orientation: 'landscape',
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
    },
    excludedProviderIds: {},
    desiredCount: 8,
  });

  // e926 is SFW-only — skipped entirely under nsfw, no request issued.
  expect(fetchE926Batch).not.toHaveBeenCalled();
  // Safebooru stays admitted under nsfw (board #19 D3 = B: it serves
  // rating:questionable there), so it is asked like any available source.
  expect(fetchSafebooruBatch).toHaveBeenCalled();
  // The plan's denominator must exclude e926 (7, not 8): base = ceil(8/7) =
  // 2, whereas the old un-gated computation would have produced ceil(8/8) = 1.
  // No cap binds at 2, so no slack moves and the numbers match the uniform
  // split.
  expect(fetchWaifu).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 2 }));
  expect(fetchNekos).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
  expect(fetchDanbooru).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
});

test('excludes Rule34 from providerCount and skips its fetch under sfw mode', async () => {
  const fetchBatch = createDiscoveryProviderFetcher();
  const result = await fetchBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      orientation: 'landscape',
      nsfwMode: 'sfw',
      providers: {
        waifu_im: false, nekos_api: false, danbooru: false, safebooru: false,
        yandere: false, konachan: false, e621: false, e926: false,
        gelbooru: false, rule34: true,
      },
    },
    excludedProviderIds: {},
    desiredCount: 8,
  });

  expect(result.items).toEqual([]);
  expect(result.providerRounds).toEqual([
    { providerKey: 'rule34', requested: 0, returned: 0, admitted: 0, outcome: 'skipped_capability' },
  ]);
});

test('R8.23: blocking furry keeps e621/e926 out of the round and records skipped_capability', async () => {
  // Owner ruling 2026-09-09. e621/e926 invalidated the `furry` tag (the whole
  // corpus is furry), so blocking it cannot be honoured by `-furry` or by the
  // local tag filter — the only honest answer is to not ask those two sources
  // at all. This asserts the existing capability gate now carries that ruling:
  // no request goes out, and the ledger says `skipped_capability` rather than
  // an empty `ok` round that would look like a dead source.
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchE621 = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchE926 = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchDanbooru,
    fetchE621,
    fetchE926,
  });

  const settings = {
    ...DEFAULT_SETTINGS,
    excludedTags: ['furry'],
    providers: {
      waifu_im: false, nekos_api: false, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: true, e926: true, gelbooru: false, rule34: false,
    },
  };

  const result = await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 6 });

  expect(fetchE621).not.toHaveBeenCalled();
  expect(fetchE926).not.toHaveBeenCalled();
  // The source that CAN honour `-furry` keeps working, and takes the whole
  // desiredCount because the gate removed the other two from the denominator.
  expect(fetchDanbooru).toHaveBeenCalledTimes(1);
  expect(result.providerRounds).toEqual(expect.arrayContaining([
    { providerKey: 'e621', requested: 0, returned: 0, admitted: 0, outcome: 'skipped_capability' },
    { providerKey: 'e926', requested: 0, returned: 0, admitted: 0, outcome: 'skipped_capability' },
  ]));

  // Control: without the block, both are admitted and asked — so the skip
  // above is the excludedTags entry, not an unrelated always-off condition.
  fetchDanbooru.mockClear();
  await fetchBatch({
    settings: { ...settings, excludedTags: [] },
    excludedProviderIds: {},
    desiredCount: 6,
  });
  expect(fetchE621).toHaveBeenCalledTimes(1);
  expect(fetchE926).toHaveBeenCalledTimes(1);
});

test('resolves an honest empty batch (not a throw) when the only enabled provider is unavailable', async () => {
  (fetchKonachanBatch as jest.Mock).mockClear();
  const fetchBatch = createDiscoveryProviderFetcher();

  // Konachan is the only enabled source, and portrait orientation makes it
  // admission-gated unavailable — the admitted set is empty even though a
  // provider IS enabled. Before this fix the fetcher threw
  // 'No image provider is enabled', which is false here and surfaced a
  // Retry that could never succeed. It must resolve empty instead so the
  // deck reaches its normal exhausted state; the Settings row explains why.
  const settings = {
    ...DEFAULT_SETTINGS,
    orientation: 'portrait' as const,
    providers: {
      waifu_im: false, nekos_api: false, danbooru: false, safebooru: false,
      yandere: false, konachan: true, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  // The empty batch now also carries the G3b accounting metadata: Konachan was
  // enabled and skipped by the capability gate, which is exactly what the yield
  // ledger must be able to distinguish from "never enabled". Extending the
  // asserted object keeps this a full-equality check rather than weakening it.
  // The share plan is built over an empty admitted set and returns an empty
  // map, so any desiredCount has no observable effect here.
  await expect(fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 1 }))
    .resolves.toEqual({
      items: [],
      totalCount: 0,
      providerRounds: [{
        providerKey: 'konachan',
        requested: 0,
        returned: 0,
        admitted: 0,
        outcome: 'skipped_capability',
      }],
    });
  expect(fetchKonachanBatch).not.toHaveBeenCalled();
});

test('still throws "No image provider is enabled" when genuinely none is enabled (control)', async () => {
  const fetchBatch = createDiscoveryProviderFetcher();
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: false, nekos_api: false, danbooru: false, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  // The share plan has no observable effect — zero enabled providers means
  // the throw fires before any adapter is asked for anything.
  await expect(fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 1 }))
    .rejects.toThrow('No image provider is enabled');
});

test('reports a read-only per-provider round for the yield ledger, including who was skipped', async () => {
  (fetchKonachanBatch as jest.Mock).mockClear();
  const fetchWaifu = jest.fn(async () => ({
    items: [candidate('waifu_im', '1')],
    // Pre-filter: five raw posts seen, one admitted — the yield rate the ledger
    // needs, and the reason the danbooru-family `totalCount` fix exists.
    totalCount: 5,
  }));
  const fetchDanbooru = jest.fn(async () => {
    throw new Error('danbooru exploded');
  });
  const fetchE621 = jest.fn(async () => {
    throw Object.assign(new Error('e621 is cooling down'), {
      code: 'rate_limited',
      retryAfterMs: 1_000,
    });
  });
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchDanbooru,
    fetchE621,
  });

  // Portrait makes Konachan capability-unavailable, so it is enabled but never
  // asked — the one outcome discovery could not previously observe.
  const settings = {
    ...DEFAULT_SETTINGS,
    orientation: 'portrait' as const,
    providers: {
      waifu_im: true, nekos_api: false, danbooru: true, safebooru: false,
      yandere: false, konachan: true, e621: true, e926: false, gelbooru: false, rule34: false,
    },
  };

  const result = await fetchBatch({
    settings,
    excludedProviderIds: {},
    desiredCount: 8,
  });

  expect(fetchKonachanBatch).not.toHaveBeenCalled();
  // Konachan is out of the plan's denominator, so 3 sources share
  // desiredCount 8: base = ceil(8/3) = 3, share = min(3, cap) -> waifu 3,
  // danbooru 3, e621 2 (cap 2). The 1 unit e621's cap frees is redistributed
  // to the receivers with headroom (waifu, danbooru, weight 1 each, quota 0.5
  // each, registry order breaks the tie) -> waifu 4.
  //
  // Changed from a single shared `share = 3` under the old uniform model. The
  // per-source numbers are pinned on BOTH the outgoing request and the
  // recorded round so `requested` can never drift into being a recomputation
  // of something the fetcher did not ask for.
  expect(fetchWaifu).toHaveBeenCalledWith(
    expect.objectContaining({ pageSize: 4 }),
  );
  expect(fetchDanbooru).toHaveBeenCalledWith(
    expect.objectContaining({ count: 3 }),
  );
  expect(fetchE621).toHaveBeenCalledWith(
    expect.objectContaining({ count: 2 }),
  );
  expect(result.providerRounds).toEqual([
    {
      providerKey: 'waifu_im',
      requested: 4,
      returned: 5,
      admitted: 1,
      outcome: 'ok',
    },
    {
      providerKey: 'danbooru',
      requested: 3,
      returned: 0,
      admitted: 0,
      outcome: 'failed',
      // The reason rides along for diagnosis. `outcome` alone cannot say whether
      // a silent source refused, timed out, or answered with something
      // unparseable, and on device those are indistinguishable in the persisted
      // deck — which is how a source contributing zero resisted diagnosis.
      failureCode: 'provider',
    },
    {
      // A rate limit is recorded as `cooldown`, not `failed`: the source was
      // never really asked, so G3c must keep its floor instead of reading it
      // as unproductive.
      providerKey: 'e621',
      requested: 2,
      returned: 0,
      admitted: 0,
      outcome: 'cooldown',
      failureCode: 'rate_limited',
    },
    {
      // Skipped and `ok` rounds carry no reason at all: nothing failed, so the
      // record must not imply a failure that did not happen.
      providerKey: 'konachan',
      requested: 0,
      returned: 0,
      admitted: 0,
      outcome: 'skipped_capability',
    },
  ]);
  // No top-up: waifu returned 1 of its 4, i.e. exhausted, not capped.
  expect(fetchWaifu).toHaveBeenCalledTimes(1);
  // Behaviour neutrality: the accounting field is additive; the batch itself is
  // exactly what it was before.
  expect(result.items).toEqual([candidate('waifu_im', '1')]);
  expect(result.totalCount).toBe(5);
});

// --- G3c task2: share plan, top-up wave, merge cap -------------------------

/** All eight clients stubbed, so the REAL registry caps drive the plan. */
function allEightStubs(items: Partial<Record<ImageCandidate['providerKey'], ImageCandidate[]>> = {}) {
  const make = (key: ImageCandidate['providerKey']) => jest.fn(async () => ({
    items: items[key] ?? [],
    totalCount: (items[key] ?? []).length,
  }));
  return {
    fetchWaifu: make('waifu_im'),
    fetchNekos: make('nekos_api'),
    fetchDanbooru: make('danbooru'),
    fetchSafebooru: make('safebooru'),
    fetchYandere: make('yandere'),
    fetchKonachan: make('konachan'),
    fetchE621: make('e621'),
    fetchE926: make('e926'),
  };
}

/** Landscape + sfw is the one setting where all eight sources are admitted. */
const ALL_EIGHT_ADMITTED = {
  ...DEFAULT_SETTINGS,
  orientation: 'landscape' as const,
  providers: {
    waifu_im: true, nekos_api: true, danbooru: true, safebooru: true,
    yandere: true, konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
  },
};

/** waifu + nekos only: 2 admitted, so desiredCount 10 gives each a share of 5. */
const TWO_SOURCE_SETTINGS = {
  ...DEFAULT_SETTINGS,
  providers: {
    waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
    yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
  },
};

function askedCount(fetcher: jest.Mock, call = 0): number | undefined {
  const args = fetcher.mock.calls[call]?.[0] as
    { count?: number; pageSize?: number } | undefined;
  return args?.count ?? args?.pageSize;
}

test('cold start: the share plan clamps to the real registry caps and redistributes the slack', async () => {
  const stubs = allEightStubs();
  const fetchBatch = createDiscoveryProviderFetcher(stubs);

  // Eight admitted, desiredCount 30, no yieldStats (cold start -> every weight
  // is 1, which is exactly the old uniform behaviour before the caps bite).
  //   base = ceil(30/8) = 4
  //   share = min(4, cap): e621 and e926 are capped at 2, everyone else 4
  //   slack = (4-2) + (4-2) = 4
  //   receivers with headroom = waifu, nekos, danbooru, safebooru, yandere,
  //   konachan (6 of them, equal weight) -> quota 4/6 = 0.667 each, integer
  //   part 0, so all 4 leftover units go by registry order.
  await fetchBatch({
    settings: ALL_EIGHT_ADMITTED,
    excludedProviderIds: {},
    desiredCount: 30,
  });

  expect({
    waifu_im: askedCount(stubs.fetchWaifu),
    nekos_api: askedCount(stubs.fetchNekos),
    danbooru: askedCount(stubs.fetchDanbooru),
    safebooru: askedCount(stubs.fetchSafebooru),
    yandere: askedCount(stubs.fetchYandere),
    konachan: askedCount(stubs.fetchKonachan),
    e621: askedCount(stubs.fetchE621),
    e926: askedCount(stubs.fetchE926),
  }).toEqual({
    waifu_im: 5,
    nekos_api: 5,
    danbooru: 5,
    safebooru: 5,
    yandere: 4,
    konachan: 4,
    // S10 closed: the declared cap of 2 is now enforced by the scheduler, not
    // silently by the engine's own Math.min after a pointless ask for 4.
    e621: 2,
    e926: 2,
  });
  // Request volume is conserved: the old uniform split asked 8 x 4 = 32 too.
  // The plan moves the 4 units e621/e926 cannot use, it does not add any.
  const total = [
    stubs.fetchWaifu, stubs.fetchNekos, stubs.fetchDanbooru, stubs.fetchSafebooru,
    stubs.fetchYandere, stubs.fetchKonachan, stubs.fetchE621, stubs.fetchE926,
  ].reduce((sum, stub) => sum + (askedCount(stub) ?? 0), 0);
  expect(total).toBe(32);
});

test('a quiet source and a cooling source keep their floor of 1 and forfeit slack', async () => {
  const stubs = allEightStubs();
  const fetchBatch = createDiscoveryProviderFetcher(stubs);

  await fetchBatch({
    settings: ALL_EIGHT_ADMITTED,
    excludedProviderIds: {},
    desiredCount: 30,
    yieldStats: new Map([
      // Answered 200 with nothing usable for five rounds running: quiet.
      ['yandere', {
        requested: 20, admitted: 0, inserted: 0,
        consecutiveZeroRounds: 5, lastOutcome: 'ok' as const,
      }],
      // Refused by the governor last round: cooling.
      ['konachan', {
        requested: 4, admitted: 4, inserted: 4,
        consecutiveZeroRounds: 0, lastOutcome: 'cooldown' as const,
      }],
    ]),
  });

  //   base = 4; yandere and konachan are restricted -> pinned at the floor of 1
  //   slack = (4-1) + (4-1) + (4-2) + (4-2) = 10, and the restricted sources'
  //   released 6 units join the pool rather than evaporating (spec §1 S5)
  //   receivers = waifu, nekos, danbooru, safebooru (e621/e926 sit at cap;
  //   restricted sources are excluded) -> quota 10/4 = 2.5 each, integer part
  //   2, the 2 leftover units by registry order -> waifu +1, nekos +1.
  expect({
    waifu_im: askedCount(stubs.fetchWaifu),
    nekos_api: askedCount(stubs.fetchNekos),
    danbooru: askedCount(stubs.fetchDanbooru),
    safebooru: askedCount(stubs.fetchSafebooru),
    yandere: askedCount(stubs.fetchYandere),
    konachan: askedCount(stubs.fetchKonachan),
    e621: askedCount(stubs.fetchE621),
    e926: askedCount(stubs.fetchE926),
  }).toEqual({
    waifu_im: 7,
    nekos_api: 7,
    // Right on danbooru's declared cap of 6 — redistribution never exceeds it.
    danbooru: 6,
    safebooru: 6,
    // Never zero. A quiet source keeps a probe so one good round can revive it,
    // and a cooling source is not punished for a request it never answered.
    yandere: 1,
    konachan: 1,
    e621: 2,
    e926: 2,
  });
});

test('issues exactly one top-up wave to a capped source, and never a second one', async () => {
  const wave1 = ['101', '102', '103', '104', '105']
    .map((id) => candidate('waifu_im', id));
  const fetchWaifu = jest.fn()
    .mockResolvedValueOnce({ items: wave1, totalCount: 9 })
    // The top-up itself comes back short. The shortfall therefore persists,
    // which is precisely the state a third wave would be tempted by.
    .mockResolvedValueOnce({ items: [candidate('waifu_im', '106')], totalCount: 2 });
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'n1'), candidate('nekos_api', 'n2')],
    totalCount: 2,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  // 2 admitted, desiredCount 10 -> base 5, both under cap, no slack.
  const result = await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 10 });

  expect(askedCount(fetchWaifu, 0)).toBe(5);
  expect(askedCount(fetchNekos, 0)).toBe(5);
  // waifu returned exactly its share of 5 -> capped, and cap 20 - share 5
  // leaves headroom, so it is the only top-up target. nekos returned 2 of 5 —
  // exhausted, not capped — so it is NOT re-asked.
  expect(fetchNekos).toHaveBeenCalledTimes(1);
  expect(fetchWaifu).toHaveBeenCalledTimes(2);
  // Shortfall after the merge is 10 - 7 = 3; the top-up plan over the single
  // target with cap = headroom 15 asks for exactly that.
  expect(askedCount(fetchWaifu, 1)).toBe(3);
  // Wave 1's own items are fed back as exclusions, so the top-up is a genuine
  // second sample rather than a re-fetch of what we already hold.
  expect(fetchWaifu.mock.calls[1]?.[0]).toMatchObject({
    excludedIds: [101, 102, 103, 104, 105],
  });
  // The top-up's item is merged in: 5 + 1 waifu + 2 nekos = 8.
  expect(result.items).toHaveLength(8);
  expect(result.items.map((image) => image.providerItemId)).toContain('106');
  // One round record per provider per CALL, with both waves summed.
  expect(result.providerRounds).toEqual([
    {
      providerKey: 'waifu_im',
      requested: 8, // 5 + 3
      returned: 11, // 9 + 2
      admitted: 6, // 5 + 1
      outcome: 'ok',
    },
    {
      providerKey: 'nekos_api',
      requested: 5,
      returned: 2,
      admitted: 2,
      outcome: 'ok',
    },
  ]);
  expect(result.totalCount).toBe(13);
});

test('does not top up when the shortfall comes from exhausted sources', async () => {
  const fetchWaifu = jest.fn(async () => ({
    items: [candidate('waifu_im', '1'), candidate('waifu_im', '2')],
    totalCount: 2,
  }));
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'a')],
    totalCount: 1,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: true, nekos_api: true, danbooru: false, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  // Both were asked for 5 and both answered with less: they have told us they
  // have nothing more this round. Re-asking them is the blind uniform re-ask
  // §2.3 exists to delete, so the wave must not fire even though 3 < 10.
  const result = await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 10 });

  expect(result.items).toHaveLength(3);
  expect(fetchWaifu).toHaveBeenCalledTimes(1);
  expect(fetchNekos).toHaveBeenCalledTimes(1);
});

test('does not top up a capped source that has no headroom left (e621 at its cap of 2)', async () => {
  const fetchE621 = jest.fn(async () => ({
    items: [candidate('e621', 'x'), candidate('e621', 'y')],
    totalCount: 2,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchE621 });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: false, nekos_api: false, danbooru: false, safebooru: false,
      yandere: false, konachan: false, e621: true, e926: false, gelbooru: false, rule34: false,
    },
  };

  const result = await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 10 });

  // Sole admitted source, base 10, but its declared cap is 2 — so it is asked
  // for 2, not 10. It then returns exactly its share, which is the "capped"
  // signature, yet cap - share = 0 so there is nothing to top up with: the
  // ceiling is a ceiling across both waves, not just the first.
  expect(askedCount(fetchE621, 0)).toBe(2);
  expect(fetchE621).toHaveBeenCalledTimes(1);
  expect(result.items).toHaveLength(2);
});

test('the merge cap follows desiredCount instead of truncating everything at 20 (S4)', async () => {
  const thirty = Array.from({ length: 30 }, (_unused, index) =>
    candidate('nekos_api', `m${index}`));
  const fetchNekos = jest.fn(async () => ({ items: thirty, totalCount: 30 }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchNekos });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: false, nekos_api: true, danbooru: false, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  const wide = await fetchBatch({
    settings, excludedProviderIds: {}, desiredCount: 30,
  });
  expect(wide.items).toHaveLength(30);
  // The 20 floor is kept for small asks, so a caller wanting 5 still gets the
  // same headroom for its own dedupe losses that it had before this change.
  const narrow = await fetchBatch({
    settings, excludedProviderIds: {}, desiredCount: 5,
  });
  expect(narrow.items).toHaveLength(20);
});

test('bounds the top-up fan-out to the shortfall and probes the most productive capped sources', async () => {
  // Six admitted sources (landscape keeps konachan in), desiredCount 24:
  // base = ceil(24/6) = 4, every cap is above 4 so there is NO slack, which
  // means the yieldStats below cannot move the wave-1 shares — they only
  // decide the top-up probe ORDER, which is what this test is about.
  const four = (
    key: ImageCandidate['providerKey'],
    shared: string | null = null,
  ) => [
    candidate(key, `${key}-0`, shared),
    candidate(key, `${key}-1`),
    candidate(key, `${key}-2`),
    candidate(key, `${key}-3`),
  ];
  const batch = (items: ImageCandidate[]) => ({ items, totalCount: items.length });
  // Two cross-source canonical duplicates, so the merge dedupes 24 -> 22 and
  // the shortfall is exactly 2 while every source still returned its full
  // share of 4 (i.e. all six are capped, not exhausted).
  const fetchWaifu = jest.fn(async () => batch(four('waifu_im')));
  const fetchNekos = jest.fn(async () => batch(four('nekos_api')));
  const fetchDanbooru = jest.fn(async () => batch(four('danbooru', 'pixiv:1')));
  const fetchSafebooru = jest.fn(async () => batch(four('safebooru', 'pixiv:1')));
  const fetchYandere = jest.fn(async () => batch(four('yandere', 'pixiv:2')));
  const fetchKonachan = jest.fn(async () => batch(four('konachan', 'pixiv:2')));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu, fetchNekos, fetchDanbooru, fetchSafebooru, fetchYandere, fetchKonachan,
  });
  const ok = (admitted: number) => ({
    requested: 8, admitted, inserted: admitted,
    consecutiveZeroRounds: 0, lastOutcome: 'ok' as const,
  });

  const result = await fetchBatch({
    settings: {
      ...ALL_EIGHT_ADMITTED,
      providers: {
        waifu_im: true, nekos_api: true, danbooru: true, safebooru: true,
        yandere: true, konachan: true, e621: false, e926: false, gelbooru: false, rule34: false,
      },
    },
    excludedProviderIds: {},
    desiredCount: 24,
    yieldStats: new Map([
      ['waifu_im', ok(2)], // 0.25
      ['nekos_api', ok(1)], // 0.125
      ['danbooru', ok(8)], // 1.0
      ['safebooru', ok(4)], // 0.5
      ['yandere', ok(3)], // 0.375
      ['konachan', ok(8)], // 1.0
    ]),
  });

  expect(result.items).toHaveLength(22);
  // All six are valid top-up targets (each returned exactly its share of 4 and
  // each has headroom under its cap). Planning over all six would have cost
  // SIX calls to close a two-card gap, because the planner's floor of 1 gives
  // every source in a plan at least one request. The bound makes it two.
  const calls = [
    fetchWaifu, fetchNekos, fetchDanbooru, fetchSafebooru, fetchYandere, fetchKonachan,
  ].reduce((sum, stub) => sum + stub.mock.calls.length, 0);
  expect(calls).toBe(6 + 2);
  // And the two are chosen by recent effective yield, not by registry order:
  // danbooru and konachan both yielded 8/8, so they outrank waifu (2/8) and
  // nekos (1/8), which a registry-order slice would have picked instead.
  expect(fetchDanbooru).toHaveBeenCalledTimes(2);
  expect(fetchKonachan).toHaveBeenCalledTimes(2);
  expect(fetchWaifu).toHaveBeenCalledTimes(1);
  expect(fetchNekos).toHaveBeenCalledTimes(1);
  expect(fetchSafebooru).toHaveBeenCalledTimes(1);
  expect(fetchYandere).toHaveBeenCalledTimes(1);
  // Two probes for a shortfall of two: one unit each, and danbooru's is also
  // its entire remaining headroom (cap 6 - share 4 = 2, asked 1).
  expect(askedCount(fetchDanbooru, 1)).toBe(1);
  expect(askedCount(fetchKonachan, 1)).toBe(1);
});

test('soft quota is off by default at the fetcher: yieldStats alone never move the wave-1 shares (spec 2026-09-16 §5)', async () => {
  // Same shape as the top-up gate above (no slack, so the plan is uniform),
  // but the ledger says waifu dominated recent inserts. Without `softQuota`
  // the wave-1 ask is still 4 each — the fetcher must not apply the quota on
  // an ordinary steady-state round.
  const four = (key: ImageCandidate['providerKey']) => [
    candidate(key, `${key}-0`), candidate(key, `${key}-1`),
    candidate(key, `${key}-2`), candidate(key, `${key}-3`),
  ];
  const batch = (items: ImageCandidate[]) => ({ items, totalCount: items.length });
  const fetchWaifu = jest.fn(async () => batch(four('waifu_im')));
  const fetchNekos = jest.fn(async () => batch(four('nekos_api')));
  const fetchDanbooru = jest.fn(async () => batch(four('danbooru')));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos, fetchDanbooru });
  const dominant = new Map<ImageCandidate['providerKey'], ProviderYieldStat>([
    ['waifu_im', { requested: 12, admitted: 12, inserted: 12, consecutiveZeroRounds: 0, lastOutcome: 'ok' }],
    ['nekos_api', { requested: 12, admitted: 12, inserted: 0, consecutiveZeroRounds: 0, lastOutcome: 'ok' }],
    ['danbooru', { requested: 12, admitted: 12, inserted: 0, consecutiveZeroRounds: 0, lastOutcome: 'ok' }],
  ]);
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: true, nekos_api: true, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 12, yieldStats: dominant });
  expect(askedCount(fetchWaifu)).toBe(4);
  expect(askedCount(fetchNekos)).toBe(4);
  expect(askedCount(fetchDanbooru)).toBe(4);
});

test('soft quota on: a converging round hands the dominant source\'s share to the others (wave 1 only, spec 2026-09-16 §4)', async () => {
  const four = (key: ImageCandidate['providerKey']) => [
    candidate(key, `${key}-0`), candidate(key, `${key}-1`),
    candidate(key, `${key}-2`), candidate(key, `${key}-3`),
  ];
  const batch = (items: ImageCandidate[]) => ({ items, totalCount: items.length });
  const fetchWaifu = jest.fn(async () => batch(four('waifu_im')));
  const fetchNekos = jest.fn(async () => batch(four('nekos_api')));
  const fetchDanbooru = jest.fn(async () => batch(four('danbooru')));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos, fetchDanbooru });
  const dominant = new Map<ImageCandidate['providerKey'], ProviderYieldStat>([
    ['waifu_im', { requested: 12, admitted: 12, inserted: 12, consecutiveZeroRounds: 0, lastOutcome: 'ok' }],
    ['nekos_api', { requested: 12, admitted: 12, inserted: 0, consecutiveZeroRounds: 0, lastOutcome: 'ok' }],
    ['danbooru', { requested: 12, admitted: 12, inserted: 0, consecutiveZeroRounds: 0, lastOutcome: 'ok' }],
  ]);
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: true, nekos_api: true, danbooru: true, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
    },
  };

  await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 12, yieldStats: dominant, softQuota: true });
  // base 4; waifu share 1.0 vs fair 1/3 -> nudge 0.5 -> 2; the 2 released
  // units go to the other two.
  expect(askedCount(fetchWaifu)).toBe(2);
  expect(askedCount(fetchNekos)).toBe(5);
  expect(askedCount(fetchDanbooru)).toBe(5);
  // One call each: the quota never reaches the top-up wave (nothing was short).
  expect(fetchWaifu).toHaveBeenCalledTimes(1);
  expect(fetchNekos).toHaveBeenCalledTimes(1);
  expect(fetchDanbooru).toHaveBeenCalledTimes(1);
});

test('a rejected top-up leaves the round ok and only inflates what was asked', async () => {
  const wave1 = ['201', '202', '203', '204', '205']
    .map((id) => candidate('waifu_im', id));
  const fetchWaifu = jest.fn()
    .mockResolvedValueOnce({ items: wave1, totalCount: 9 })
    .mockRejectedValueOnce(Object.assign(new Error('waifu blinked'), {
      code: 'network',
    }));
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'n1'), candidate('nekos_api', 'n2')],
    totalCount: 2,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos });

  const result = await fetchBatch({
    settings: TWO_SOURCE_SETTINGS,
    excludedProviderIds: {},
    desiredCount: 10,
  });

  // The opportunistic second ask failed, but wave 1 was good: the round must
  // not become an error, and the failure must not be reported to the caller.
  expect(result.items).toHaveLength(7);
  expect(result.providerRounds).toEqual([
    {
      providerKey: 'waifu_im',
      // 5 + 3: we really did ask for 8, and the ledger's admitted/requested
      // weight should reflect that we only got 5 of them.
      requested: 8,
      returned: 9,
      admitted: 5,
      // NOT 'failed': a failed top-up is not a failed round, and flipping this
      // would also feed the quiet signal a round that plainly produced items.
      outcome: 'ok',
    },
    {
      providerKey: 'nekos_api',
      requested: 5,
      returned: 2,
      admitted: 2,
      outcome: 'ok',
    },
  ]);
});

test('a caller abort during the top-up wave still aborts the call', async () => {
  const controller = new AbortController();
  const wave1 = ['301', '302', '303', '304', '305']
    .map((id) => candidate('waifu_im', id));
  const fetchWaifu = jest.fn()
    .mockResolvedValueOnce({ items: wave1, totalCount: 5 })
    // The caller gives up while the second wave is in flight.
    .mockImplementationOnce(async () => {
      controller.abort();
      return { items: [candidate('waifu_im', '306')], totalCount: 1 };
    });
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'n1'), candidate('nekos_api', 'n2')],
    totalCount: 2,
  }));
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos });

  // Same contract as wave 1: an aborted call does not deliver. This is the
  // one window the wave-1 abort check cannot cover, since it is the only
  // `await` added after it.
  await expect(fetchBatch({
    settings: TWO_SOURCE_SETTINGS,
    excludedProviderIds: {},
    desiredCount: 10,
    signal: controller.signal,
  })).rejects.toThrow('Discovery request was aborted');
  expect(fetchWaifu).toHaveBeenCalledTimes(2);
});

test('the top-up exclusion list stays capped at 100 entries', async () => {
  const wave1 = ['e0', 'e1', 'e2', 'e3', 'e4']
    .map((id) => candidate('nekos_api', id));
  const fetchWaifu = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchNekos = jest.fn()
    .mockResolvedValueOnce({ items: wave1, totalCount: 5 })
    .mockResolvedValueOnce({ items: [], totalCount: 0 });
  const fetchBatch = createDiscoveryProviderFetcher({ fetchWaifu, fetchNekos });
  const carried = Array.from({ length: 100 }, (_unused, index) => `old${index}`);

  await fetchBatch({
    settings: TWO_SOURCE_SETTINGS,
    excludedProviderIds: { nekos_api: carried },
    desiredCount: 10,
  });

  // nekos returned exactly its share of 5 (cap 8, so headroom 3) and is the
  // only capped source. Its 5 fresh ids are prepended to the caller's 100
  // carried ones and the result is truncated back to 100 — the same bound the
  // discovery-service uses, so a long-running session cannot grow the request.
  const second = fetchNekos.mock.calls[1]?.[0] as { excludedIds: string[] };
  expect(second.excludedIds).toHaveLength(100);
  expect(second.excludedIds.slice(0, 5)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  expect(second.excludedIds[99]).toBe('old94');
  expect(askedCount(fetchNekos, 1)).toBe(3); // clamped to the remaining headroom
});

test('injects each provider its own credential from the map accessor, and only its own', async () => {
  const seen: Record<string, unknown> = {};
  const fetchGelbooru = jest.fn(async (input: { credential?: unknown }) => {
    seen.gelbooru = input.credential;
    return { items: [], totalCount: 0 };
  });
  const fetchWaifu = jest.fn(async (input: { credential?: unknown }) => {
    seen.waifu_im = input.credential;
    return { items: [], totalCount: 0 };
  });
  const fetcher = createDiscoveryProviderFetcher({
    fetchWaifu: fetchWaifu as unknown as typeof fetchWaifuBatch,
    fetchGelbooru: fetchGelbooru as unknown as typeof fetchGelbooruBatch,
    credentials: () => ({ gelbooru: { apiKey: 'k', userId: 'u' } }),
  });
  await fetcher({
    settings: { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, gelbooru: true } },
    excludedProviderIds: {},
    desiredCount: 4,
  }).catch(() => undefined);
  expect(seen.gelbooru).toEqual({ apiKey: 'k', userId: 'u' });
  expect(seen.waifu_im).toBeUndefined();
});

test('injects the credential into the bounded top-up wave, not only wave 1', async () => {
  // Mirrors "issues exactly one top-up wave to a capped source": gelbooru
  // returns exactly its share of 5 (cap 8 -> 3 headroom) so it is the sole
  // top-up target, while nekos returns 2 of 5 (exhausted) and is not re-asked.
  const wave1 = ['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => candidate('gelbooru', id));
  const seenCredentials: unknown[] = [];
  const fetchGelbooru = jest.fn(async (input: { credential?: unknown }) => {
    seenCredentials.push(input.credential);
    return seenCredentials.length === 1
      ? { items: wave1, totalCount: 9 }
      : { items: [candidate('gelbooru', 'g6')], totalCount: 2 };
  });
  const fetchNekos = jest.fn(async () => ({
    items: [candidate('nekos_api', 'n1'), candidate('nekos_api', 'n2')],
    totalCount: 2,
  }));
  const cred = { apiKey: 'k', userId: 'u' };
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchGelbooru: fetchGelbooru as unknown as typeof fetchGelbooruBatch,
    fetchNekos,
    credentials: () => ({ gelbooru: cred }),
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    providers: {
      waifu_im: false, nekos_api: true, danbooru: false, safebooru: false,
      yandere: false, konachan: false, e621: false, e926: false, gelbooru: true, rule34: false,
    },
  };

  // 2 admitted, desiredCount 10 -> base 5, both under cap, no slack.
  await fetchBatch({ settings, excludedProviderIds: {}, desiredCount: 10 });

  // Two gelbooru fetches: wave 1 and its one top-up. The credential must ride
  // BOTH — the second wave builds its own DiscoveryFetchInput and must not drop
  // the key.
  expect(fetchGelbooru).toHaveBeenCalledTimes(2);
  expect(seenCredentials[0]).toEqual(cred);
  expect(seenCredentials[1]).toEqual(cred);
});

test('K7 ⑰ delivers a fast source before the slow one has settled', async () => {
  const fetchWaifu = jest.fn(async () => ({
    items: [candidate('waifu_im', 'fast-1'), candidate('waifu_im', 'fast-2')],
    totalCount: 2,
  }));
  // The slow source stands in for the 12 s request deadline: it settles only
  // when this test says so, which is what makes "before B settles" a fact
  // rather than a timing guess.
  let settleDanbooru!: () => void;
  const danbooruArrives = new Promise<void>((resolve) => { settleDanbooru = resolve; });
  let danbooruSettled = false;
  const fetchDanbooru = jest.fn(async () => {
    await danbooruArrives;
    danbooruSettled = true;
    return { items: [candidate('danbooru', 'slow-1')], totalCount: 1 };
  });
  // nekos is stubbed to an immediate empty answer for the same reason every
  // other test in this file stubs the sources it is not measuring: the real
  // client would reach for the network.
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const delivered: { key: string; ids: string[]; slowHadSettled: boolean }[] = [];
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  const pending = fetchBatch({
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {},
    desiredCount: 6,
    onSourceSettled: ({ providerKey, items }) => {
      delivered.push({
        key: providerKey,
        ids: items.map((item) => item.providerItemId),
        slowHadSettled: danbooruSettled,
      });
    },
  });

  // Let every already-resolved source land while the slow one is still out.
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  expect(danbooruSettled).toBe(false);
  expect(delivered).toEqual([
    { key: 'waifu_im', ids: ['fast-1', 'fast-2'], slowHadSettled: false },
  ]);

  settleDanbooru();
  const batch = await pending;

  expect(danbooruSettled).toBe(true);
  expect(delivered.map((entry) => entry.key)).toEqual(['waifu_im', 'danbooru']);
  // The aggregate contract is unchanged: one merged, fairness-ordered batch
  // with one round record per source.
  expect(batch.items.map((item) => item.providerItemId))
    .toEqual(['fast-1', 'slow-1', 'fast-2']);
});

test('K7 ⑰ a throwing delivery callback cannot fail the round', async () => {
  const fetchWaifu = jest.fn(async () => ({
    items: [candidate('waifu_im', '1')],
    totalCount: 1,
  }));
  const fetchNekos = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchDanbooru = jest.fn(async () => ({ items: [], totalCount: 0 }));
  const fetchBatch = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
  });

  await expect(fetchBatch({
    settings: DEFAULT_SETTINGS,
    excludedProviderIds: {},
    desiredCount: 4,
    onSourceSettled: () => { throw new Error('caller blew up'); },
  })).resolves.toMatchObject({
    items: [expect.objectContaining({ providerItemId: '1' })],
  });
});
