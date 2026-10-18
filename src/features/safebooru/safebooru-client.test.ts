import { STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';

import {
  buildSafebooruUrl,
  fetchSafebooruBatch,
  fetchSafebooruSearchPage,
  SAFEBOORU_NATIVE_RATINGS,
  SafebooruApiError,
} from './safebooru-client';
import ratingDomainEvidence from './fixtures/dapi-rating-domain.json';

const mixedSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'mixed' as const,
  nsfwConfirmed: true,
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** HTTP 200 with the given raw body; `json()` fails the way a real Response would. */
function rawBodyResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('JSON Parse error: Unexpected end of input');
    },
    text: async () => body,
  } as unknown as Response;
}

function metadataResponse(byteSize = 400_000): Response {
  return {
    ok: true,
    status: 206,
    headers: {
      get: (name: string) => ({
        'content-range': `bytes 0-0/${byteSize}`,
        'content-type': 'image/jpeg',
      })[name.toLowerCase()] ?? null,
    },
  } as unknown as Response;
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: 7028787,
    width: 1206,
    height: 1534,
    file_url: 'https://safebooru.org/images/3658/example.jpeg',
    // Verified against a live DAPI call (2026-09-09): every post carries an
    // absolute `sample_url`; when `sample` is false it simply equals file_url.
    sample_url: 'https://safebooru.org/samples/3658/sample_example.jpg',
    preview_url: 'https://safebooru.org/thumbnails/3658/thumbnail_example.jpg',
    rating: 'safe',
    tags: '1girl solo original example_artist',
    source: 'https://www.pixiv.net/artworks/12345',
    ...overrides,
  };
}

test('builds a safe API query that excludes hard product-boundary tags', () => {
  const url = new URL(buildSafebooruUrl(DEFAULT_SETTINGS, 3));

  expect(url.origin).toBe('https://safebooru.org');
  expect(url.searchParams.get('page')).toBe('dapi');
  expect(url.searchParams.get('json')).toBe('1');
  expect(url.searchParams.get('limit')).toBe('3');
  expect(url.searchParams.get('tags')?.split(' ')).toEqual(expect.arrayContaining([
    'rating:safe',
    '-cosplay',
    '-photo',
    '-real_person',
    '-loli',
    '-shota',
  ]));
});

// K7 ⑲ rewrote two expectations here: with the default `maxBytes: 0` there is
// no `Range: bytes=0-0` probe at all, so `byteSize` is 0 (ingest measures the
// real size on save) and the only request is the DAPI page. The probe path
// itself is covered by the K7 ⑲ test at the bottom of this file.
test('adapts a safe post to an attributed image candidate without live network', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi') ? jsonResponse([post()]) : metadataResponse(),
  );

  await expect(fetchSafebooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher,
  })).resolves.toEqual({
    totalCount: 1,
    items: [expect.objectContaining({
      providerKey: 'safebooru',
      providerItemId: '7028787',
      canonicalSourceKey: 'pixiv:12345',
      remoteUrl: 'https://safebooru.org/images/3658/example.jpeg',
      sourceUrl: 'https://www.pixiv.net/artworks/12345',
      artistName: null,
      artistUrl: null,
      width: 1206,
      height: 1534,
      byteSize: 0,
      extension: '.jpeg',
      contentRating: 'safe',
      nativeRating: 'safe',
      isNsfw: false,
      isAnimated: false,
    })],
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('reads and lowercases the post\'s hash field into md5, defaulting to null when absent or empty', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi')
      ? jsonResponse([
          post({ id: 1, hash: 'ABCDEF0123456789ABCDEF0123456789' }),
          post({ id: 2, hash: '' }),
          post({ id: 3 }),
        ])
      : metadataResponse(),
  );

  const batch = await fetchSafebooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 3,
    fetcher,
  });

  expect(batch.items.map((item) => item.md5)).toEqual([
    'abcdef0123456789abcdef0123456789',
    null,
    null,
  ]);
});

test('board #19 (D3 = B): NSFW mode asks Safebooru for rating:questionable, never rating:explicit', async () => {
  // rating:explicit on safebooru.org is always zero posts (live 2026-09-26);
  // its NSFW-capable corpus is `questionable`, which the app already labels
  // nsfw_unspecified and matchesContentMode(nsfw) accepts. Owner ruled D3 = B.
  const nsfwSettings = { ...DEFAULT_SETTINGS, nsfwMode: 'nsfw' as const, nsfwConfirmed: true };
  const discoveryTags = new URL(buildSafebooruUrl(nsfwSettings, 3)).searchParams.get('tags')?.split(' ');
  expect(discoveryTags).toContain('rating:questionable');
  expect(discoveryTags).not.toContain('rating:explicit');

  const fetcher = jest.fn(async () => rawBodyResponse(''));
  await fetchSafebooruSearchPage({
    request: {
      tags: ['solo'],
      excludedTags: [],
      nsfwMode: 'nsfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    },
    fetcher,
  });
  const searchTags = new URL((fetcher.mock.calls[0] as unknown as [string])[0]).searchParams.get('tags')?.split(' ');
  expect(searchTags).toContain('rating:questionable');
  expect(searchTags).not.toContain('rating:explicit');
});

test('supports every native rating observed in the tracked DAPI evidence', async () => {
  const observedRatings = ratingDomainEvidence.observedResponses.map(({ rating }) => rating);

  expect(SAFEBOORU_NATIVE_RATINGS).toEqual(observedRatings);

  for (const [rating, contentRating] of [
    ['general', 'safe'],
    ['safe', 'safe'],
    ['questionable', 'nsfw_unspecified'],
  ] as const) {
    const fetcher = jest.fn(async (url: string) =>
      url.includes('page=dapi')
        ? jsonResponse([post({ rating })])
        : metadataResponse(),
    );

    await expect(fetchSafebooruBatch({
      settings: mixedSettings,
      excludedIds: [],
      count: 1,
      fetcher,
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ nativeRating: rating, contentRating })],
    });
  }
});

test('does not infer artist identity from uncategorized flat DAPI tags', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi') ? jsonResponse([post()]) : metadataResponse(),
  );

  const batch = await fetchSafebooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher,
  });

  expect(batch.items[0]).toMatchObject({
    tags: expect.arrayContaining(['example_artist']),
    artistName: null,
    artistUrl: null,
  });
});

test.each(['cosplay', 'photo', 'photography', 'real_person', 'loli', 'shota'])(
  'rejects the hard exclusion tag %s even when the provider says safe',
  async (tag) => {
    const fetcher = jest.fn(async (url: string) =>
      url.includes('page=dapi')
        ? jsonResponse([post({ tags: `1girl ${tag}` })])
        : metadataResponse(),
    );

    await expect(fetchSafebooruBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      count: 1,
      fetcher,
    })).resolves.toEqual({ items: [], totalCount: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test('rejects a non-safe response under the Store policy even on a safe query', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi')
      ? jsonResponse([post({ rating: 'questionable' })])
      : metadataResponse(),
  );

  await expect(fetchSafebooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    distributionPolicy: STORE_DISTRIBUTION_POLICY,
    fetcher,
  })).resolves.toEqual({ items: [], totalCount: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['explicit', 'unrated'])(
  'fails closed on the unobserved native rating %s',
  async (rating) => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse([
      post({ rating }),
    ]));

    await expect(fetchSafebooruBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      count: 1,
      fetcher,
    })).rejects.toBeInstanceOf(SafebooruApiError);
  },
);

test('rejects image URLs outside the Safebooru host', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse([
    post({ file_url: 'https://evil.example/image.jpeg' }),
  ]));

  await expect(fetchSafebooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher,
  })).rejects.toMatchObject({ code: 'invalid_response' });
});

test('searches with source-owned tags and advances the Safebooru page cursor', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi') ? jsonResponse([post()]) : metadataResponse(),
  );

  const page = await fetchSafebooruSearchPage({
    request: {
      tags: ['solo'],
      excludedTags: ['guro'],
      nsfwMode: 'sfw',
      orientation: 'portrait',
      animationMode: 'exclude',
      minWidth: 0,
      maxBytes: 0,
    },
    limit: 1,
    fetcher,
  });

  const requestedUrl = new URL(fetcher.mock.calls[0]![0]);
  expect(requestedUrl.searchParams.get('pid')).toBe('0');
  expect(requestedUrl.searchParams.get('tags')?.split(' ')).toEqual(
    expect.arrayContaining(['rating:safe', 'solo', '-guro', '-cosplay', '-loli']),
  );
  expect(page).toMatchObject({
    providerKey: 'safebooru',
    // R8.24: a ~140 dp tile renders the medium sample, never the original.
    items: [{
      key: 'safebooru:7028787',
      previewUrl: 'https://safebooru.org/samples/3658/sample_example.jpg',
    }],
    nextCursor: { page: 1 },
  });
});

test('R8.18/R8.24: the candidate keeps the DAPI sample_url, else the original', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi')
      ? jsonResponse([
          post({ id: 1 }),
          // `sample: false` posts return sample_url === file_url; an untrusted
          // or malformed sample must fall back to the original, never leak.
          post({ id: 2, sample_url: 'https://evil.example.com/samples/x.jpg' }),
        ])
      : metadataResponse(),
  );

  const batch = await fetchSafebooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 2,
    fetcher,
  });

  expect(batch.items.map((item) => item.sampleUrl)).toEqual([
    'https://safebooru.org/samples/3658/sample_example.jpg',
    'https://safebooru.org/images/3658/example.jpeg',
  ]);
  // The saved original is untouched: favouriting still downloads file_url.
  expect(batch.items.map((item) => item.remoteUrl)).toEqual([
    'https://safebooru.org/images/3658/example.jpeg',
    'https://safebooru.org/images/3658/example.jpeg',
  ]);
});

test('R8.24: a search hit previews the sample, falling back to the original', async () => {
  const request = {
    tags: [],
    excludedTags: [],
    nsfwMode: 'sfw' as const,
    orientation: 'any' as const,
    animationMode: 'include' as const,
    minWidth: 0 as const,
    maxBytes: 0 as const,
  };

  const sampled = await fetchSafebooruSearchPage({
    request,
    limit: 1,
    fetcher: jest.fn(async (url: string) =>
      url.includes('page=dapi') ? jsonResponse([post()]) : metadataResponse(),
    ),
  });
  // Safebooru is enabled by default and renders in the same grid as Konachan;
  // its 850 px sample is what a tile must fetch.
  expect(sampled.items[0]?.previewUrl).toBe(
    'https://safebooru.org/samples/3658/sample_example.jpg',
  );

  const fallback = await fetchSafebooruSearchPage({
    request,
    limit: 1,
    fetcher: jest.fn(async (url: string) =>
      url.includes('page=dapi')
        ? jsonResponse([post({ sample_url: undefined })])
        : metadataResponse(),
    ),
  });
  expect(fallback.items[0]?.previewUrl).toBe(
    'https://safebooru.org/images/3658/example.jpeg',
  );
});

test('sends Chinese and native syntax without local interpretation', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.includes('page=dapi') ? jsonResponse([post()]) : metadataResponse(),
  );
  const result = await fetchSafebooruSearchPage({
    request: {
      tags: ['福瑞 id:1,2 -bar MiXeD-case'],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    },
    fetcher,
  });

  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('tags'))
    .toBe('rating:safe 福瑞 id:1,2 -bar MiXeD-case -cosplay -cosplayer -photo -photography -real_life -real_person -loli -shota');
  expect(result.items).toHaveLength(1);
});

test('K7 ⑲ sends zero size probes when no size limit is set', async () => {
  const fetcher = jest.fn(
    async (_url: string) => jsonResponse([post({ id: 1 }), post({ id: 2 })]),
  );

  const batch = await fetchSafebooruBatch({
    settings: { ...DEFAULT_SETTINGS, maxBytes: 0 },
    excludedIds: [],
    count: 2,
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('page')).toBe('dapi');
  expect(batch.items.map((item) => item.byteSize)).toEqual([0, 0]);
});

test('K7 ⑲ probes concurrently and enforces the limit when the user sets one', async () => {
  // The barrier is the concurrency proof: neither probe can resolve until BOTH
  // are in flight, so a serial `for … await` loop can only deadlock here.
  let started = 0;
  let releaseAll!: () => void;
  const bothInFlight = new Promise<void>((resolve) => { releaseAll = resolve; });
  const fetcher = jest.fn(async (url: string) => {
    if (url.includes('page=dapi')) {
      return jsonResponse([
        post({ id: 1, file_url: 'https://safebooru.org/images/3658/small.jpeg' }),
        post({ id: 2, file_url: 'https://safebooru.org/images/3658/huge.jpeg' }),
      ]);
    }
    started += 1;
    if (started === 2) releaseAll();
    await bothInFlight;
    return metadataResponse(url.includes('huge') ? 9_000_000 : 100_000);
  });

  await expect(fetchSafebooruBatch({
    settings: { ...DEFAULT_SETTINGS, maxBytes: 2_000_000 },
    excludedIds: [],
    count: 2,
    fetcher,
  })).resolves.toMatchObject({
    items: [expect.objectContaining({ providerItemId: '1', byteSize: 100_000 })],
    totalCount: 2,
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(started).toBe(2);
});

// Board #19. Live 2026-09-26: safebooru.org answers a zero-result DAPI query
// (`json=1`) with HTTP 200 and a 0-byte body — any search with no hits, and
// every `rating:explicit` query. That is an empty page, not `invalid_response`
// (Gelbooru DAPI engine precedent, Rule34).
test('a 0-byte HTTP 200 discovery page is an empty batch, not invalid_response', async () => {
  const fetcher = jest.fn(async () => rawBodyResponse(''));

  await expect(fetchSafebooruBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 8,
    fetcher,
  })).resolves.toEqual({ items: [], totalCount: 0 });
});

test('a 0-byte HTTP 200 search page is an empty page, not invalid_response', async () => {
  const fetcher = jest.fn(async () => rawBodyResponse(''));

  await expect(fetchSafebooruSearchPage({
    request: {
      tags: ['zzqqxx_no_such_tag'],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    },
    fetcher,
  })).resolves.toMatchObject({ providerKey: 'safebooru', items: [] });
});

test('a non-empty body that is not JSON is still invalid_response', async () => {
  const fetcher = jest.fn(async () => rawBodyResponse('<html>busy</html>'));

  await expect(fetchSafebooruBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 8,
    fetcher,
  })).rejects.toMatchObject({ code: 'invalid_response' });
});

describe('board #19: animation mode narrows the Safebooru query server-side', () => {
  const nsfwSettings = { ...DEFAULT_SETTINGS, nsfwMode: 'nsfw' as const, nsfwConfirmed: true };
  const requestedDiscoveryUrl = async (
    settings: typeof DEFAULT_SETTINGS,
    random: number,
    count = 8,
  ): Promise<URL> => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(random);
    try {
      const fetcher = jest.fn(async (_url: string) => jsonResponse([]));
      await fetchSafebooruBatch({ settings, excludedIds: [], count, fetcher });
      return new URL(fetcher.mock.calls[0]![0]);
    } finally {
      spy.mockRestore();
    }
  };

  test('仅动图 asks for the animated tag, and 仅 NSFW + 仅动图 stays inside the ~44-post pool', async () => {
    const url = await requestedDiscoveryUrl(
      { ...nsfwSettings, animationMode: 'only' },
      0.999,
    );
    const tags = url.searchParams.get('tags')?.split(' ');
    expect(tags).toEqual(expect.arrayContaining(['rating:questionable', 'animated']));
    // 44 posts at 8 per page = pages 0..5 (live 2026-09-27: pid 5 holds 4,
    // pid 6 is empty). The top draw reaches the last page, so every post is
    // reachable and none is past the end.
    expect(url.searchParams.get('pid')).toBe('5');

    const single = await requestedDiscoveryUrl(
      { ...nsfwSettings, animationMode: 'only' },
      0.999,
      1,
    );
    expect(single.searchParams.get('pid')).toBe('43');
  });

  test('仅动图 outside 仅 NSFW keeps the 1000-page span (the animated pool is ~11k+)', async () => {
    const url = await requestedDiscoveryUrl(
      { ...DEFAULT_SETTINGS, animationMode: 'only' },
      0.999,
    );
    expect(url.searchParams.get('tags')?.split(' ')).toContain('animated');
    expect(url.searchParams.get('pid')).toBe('999');
  });

  test('other animation modes keep the 1000-page span and never ask for animated', async () => {
    for (const settings of [
      { ...nsfwSettings, animationMode: 'include' as const },
      { ...DEFAULT_SETTINGS, animationMode: 'include' as const },
    ]) {
      const url = await requestedDiscoveryUrl(settings, 0.999);
      expect(url.searchParams.get('tags')?.split(' ')).not.toContain('animated');
      expect(url.searchParams.get('tags')?.split(' ')).not.toContain('-animated');
      expect(url.searchParams.get('pid')).toBe('999');
    }
    const excluded = await requestedDiscoveryUrl(
      { ...nsfwSettings, animationMode: 'exclude' },
      0.999,
    );
    expect(excluded.searchParams.get('tags')?.split(' ')).toContain('-animated');
    expect(excluded.searchParams.get('tags')?.split(' ')).not.toContain('animated');
    expect(excluded.searchParams.get('pid')).toBe('999');
  });

  test('search sends animated for 仅动图, -animated for exclude, nothing for include', async () => {
    const searchTagsFor = async (animationMode: 'only' | 'exclude' | 'include') => {
      const fetcher = jest.fn(async (_url: string) => jsonResponse([]));
      await fetchSafebooruSearchPage({
        request: {
          tags: ['solo'],
          excludedTags: [],
          nsfwMode: 'nsfw',
          orientation: 'any',
          animationMode,
          minWidth: 0,
          maxBytes: 0,
        },
        fetcher,
      });
      return new URL(fetcher.mock.calls[0]![0]).searchParams.get('tags')?.split(' ');
    };
    expect(await searchTagsFor('only')).toContain('animated');
    expect(await searchTagsFor('exclude')).toContain('-animated');
    const included = await searchTagsFor('include');
    expect(included).not.toContain('animated');
    expect(included).not.toContain('-animated');
  });
});
