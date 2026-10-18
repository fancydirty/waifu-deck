import { DEFAULT_SETTINGS } from '../settings/settings';
import { STORE_DISTRIBUTION_POLICY } from '../distribution/distribution-policy';
import {
  buildWaifuUrl,
  fetchWaifuBatch,
  fetchWaifuSearchPage,
  parseWaifuResponse,
  WAIFU_REQUEST_TIMEOUT_MS,
} from './waifu-client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as Response;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

test('builds the Waifu.im image URL with fixed and requested filters', () => {
  const url = new URL(
    buildWaifuUrl(
      {
        ...DEFAULT_SETTINGS,
        nsfwMode: 'mixed',
        includedTags: ['waifu', 'maid'],
        minWidth: 1080,
        maxBytes: 5_000_000,
      },
      [8, 13],
    ),
  );

  expect(url.origin + url.pathname).toBe('https://api.waifu.im/images');
  expect(url.searchParams.getAll('IncludedTags')).toEqual(['waifu', 'maid']);
  expect(url.searchParams.get('IsNsfw')).toBe('All');
  expect(url.searchParams.get('Width')).toBe('>=1080');
  expect(url.searchParams.get('ByteSize')).toBe('<=5000000');
  expect(url.searchParams.get('PageSize')).toBe('20');
  expect(url.searchParams.getAll('ExcludedIds')).toEqual(['8', '13']);
});

test('omits unrestricted animation and orientation filters', () => {
  const url = new URL(
    buildWaifuUrl(
      {
        ...DEFAULT_SETTINGS,
        animationMode: 'include',
        orientation: 'any',
      },
      [],
    ),
  );

  expect(url.searchParams.has('IsAnimated')).toBe(false);
  expect(url.searchParams.has('Orientation')).toBe(false);
});

test('forces Store discovery requests to SFW and drops an unsafe response', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    nsfwMode: 'mixed' as const,
    nsfwConfirmed: true,
  };
  expect(new URL(buildWaifuUrl(
    settings,
    [],
    20,
    STORE_DISTRIBUTION_POLICY,
  )).searchParams.get('IsNsfw')).toBe('False');

  const fetcher = jest.fn().mockResolvedValue(jsonResponse({
    totalCount: 1,
    items: [{
      id: 99,
      url: 'https://cdn.waifu.im/99.jpg',
      source: null,
      artists: [],
      width: 100,
      height: 200,
      byteSize: 300,
      extension: '.jpg',
      dominantColor: '#123456',
      isNsfw: true,
      isAnimated: false,
      tags: [{ slug: 'waifu' }],
    }],
  }));
  const batch = await fetchWaifuBatch({
    settings,
    excludedIds: [],
    fetcher,
    distributionPolicy: STORE_DISTRIBUTION_POLICY,
  });

  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('IsNsfw')).toBe('False');
  expect(batch.items).toEqual([]);
});

test('parses valid items and skips malformed items', () => {
  expect(
    parseWaifuResponse({
      totalCount: 9,
      items: [
        {
          id: 42,
          url: 'https://cdn.waifu.im/42.png',
          source: 'https://source.example/42',
          artists: [{ name: 'Maid Artist', pixiv: 'https://artist.example' }],
          width: 1080,
          height: 1920,
          byteSize: 5_000_000,
          extension: '.png',
          dominantColor: '#abcdef',
          isNsfw: false,
          isAnimated: true,
          perceptualHash: 'EE3DC0A83AB7828E',
          tags: [{ slug: 'waifu' }, { slug: 'maid' }],
        },
        { id: 'bad' },
      ],
    }),
  ).toEqual({
    totalCount: 9,
    items: [
      {
        providerKey: 'waifu_im',
        providerItemId: '42',
        canonicalSourceKey: 'url:https://source.example/42',
        perceptualHash: 'ee3dc0a83ab7828e',
        md5: null,
        remoteUrl: 'https://cdn.waifu.im/42.png',
        sampleUrl: 'https://cdn.waifu.im/42.png',
        sourceUrl: 'https://source.example/42',
        artistName: 'Maid Artist',
        artistUrl: 'https://artist.example',
        width: 1080,
        height: 1920,
        byteSize: 5_000_000,
        extension: '.png',
        dominantColor: '#abcdef',
        contentRating: 'safe',
        nativeRating: 'false',
        isNsfw: false,
        isAnimated: true,
        tags: ['waifu', 'maid'],
      },
    ],
  });
});

test('R8.12: drops zero-dimension items instead of admitting blank cards to the deck', () => {
  // `parseImage` historically accepted any finite width/height — including 0.
  // A zero-size candidate poisons the deck: R8.14's contain math degenerates
  // (normalizeDisplayDimension clamps to 1px) and the card renders as an
  // empty frame. Reject it at the parser, where every other source family
  // (Moebooru/Danbooru/Gelbooru) already does via positiveInteger.
  const parsed = parseWaifuResponse({
    totalCount: 3,
    items: [
      {
        id: 1,
        url: 'https://cdn.waifu.im/1.png',
        width: 0,
        height: 0,
        byteSize: 1000,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [{ slug: 'waifu' }],
      },
      {
        id: 2,
        url: 'https://cdn.waifu.im/2.png',
        width: 1080,
        height: -5,
        byteSize: 1000,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [{ slug: 'waifu' }],
      },
      {
        id: 3,
        url: 'https://cdn.waifu.im/3.png',
        width: 1080,
        height: 1920,
        byteSize: 1000,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [{ slug: 'waifu' }],
      },
    ],
  });
  expect(parsed.items.map((item) => item.providerItemId)).toEqual(['3']);
});

test('rejects a non-object response as invalid_response', () => {
  expect(() => parseWaifuResponse([])).toThrow(
    expect.objectContaining({ code: 'invalid_response' }),
  );
});

test('skips malformed nested tag elements', () => {
  const result = parseWaifuResponse({
    items: [
      {
        id: 43,
        url: 'https://cdn.waifu.im/43.png',
        source: null,
        artists: [],
        width: 1080,
        height: 1920,
        byteSize: 500,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [null, 7, 'maid', {}, { slug: 99 }, { slug: 'waifu' }],
      },
    ],
  });

  expect(result.items[0]?.tags).toEqual(['waifu']);
});

test('maps artist links with pixiv then twitter then patreon then deviantArt priority', () => {
  const result = parseWaifuResponse({
    items: [
      {
        id: 44,
        url: 'https://cdn.waifu.im/44.png',
        source: null,
        artists: [
          {
            name: 'Priority Artist',
            pixiv: 'https://pixiv.example/artist',
            twitter: 'https://twitter.example/artist',
            patreon: 'https://patreon.example/artist',
            deviantArt: 'https://deviantart.example/artist',
          },
        ],
        width: 1080,
        height: 1920,
        byteSize: 500,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [],
      },
    ],
  });

  expect(result.items[0]?.artistUrl).toBe('https://pixiv.example/artist');
});

test('skips empty artist records before selecting a valid artist', () => {
  const result = parseWaifuResponse({
    items: [
      {
        id: 46,
        url: 'https://cdn.waifu.im/46.png',
        source: null,
        artists: [
          null,
          {},
          {
            name: 'Valid Artist',
            twitter: 'https://twitter.example/valid-artist',
          },
        ],
        width: 1080,
        height: 1920,
        byteSize: 500,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [],
      },
    ],
  });

  expect(result.items[0]).toMatchObject({
    artistName: 'Valid Artist',
    artistUrl: 'https://twitter.example/valid-artist',
  });
});

test.each([
  ['twitter', 'https://twitter.example/artist'],
  ['patreon', 'https://patreon.example/artist'],
  ['deviantArt', 'https://deviantart.example/artist'],
] as const)('falls back to the artist %s link', (field, link) => {
  const result = parseWaifuResponse({
    items: [
      {
        id: 45,
        url: 'https://cdn.waifu.im/45.png',
        source: null,
        artists: [{ name: 'Fallback Artist', [field]: link }],
        width: 1080,
        height: 1920,
        byteSize: 500,
        extension: '.png',
        dominantColor: '#abcdef',
        isNsfw: false,
        isAnimated: false,
        tags: [],
      },
    ],
  });

  expect(result.items[0]?.artistUrl).toBe(link);
});

test('classifies malformed JSON as invalid_response', async () => {
  const fetcher = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Response);

  await expect(
    fetchWaifuBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      fetcher,
    }),
  ).rejects.toMatchObject({ code: 'invalid_response' });
});

test('makes one request and classifies a deadline abort as timeout', async () => {
  jest.useFakeTimers();
  const fetcher = jest.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortError()), {
        once: true,
      });
    }),
  );

  const promise = fetchWaifuBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    fetcher,
  });
  const expectation = expect(promise).rejects.toMatchObject({ code: 'timeout' });

  await jest.advanceTimersByTimeAsync(WAIFU_REQUEST_TIMEOUT_MS);
  await expectation;
  expect(fetcher).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test('classifies a caller abort as aborted', async () => {
  const controller = new AbortController();
  const fetcher = jest.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortError()), {
        once: true,
      });
    }),
  );

  const promise = fetchWaifuBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    signal: controller.signal,
    fetcher,
  });
  controller.abort();

  await expect(promise).rejects.toMatchObject({ code: 'aborted' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('keeps caller abort classification when the deadline fires before fetch rejects', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const fetcher = jest.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          setTimeout(() => reject(abortError()), WAIFU_REQUEST_TIMEOUT_MS + 1);
        },
        { once: true },
      );
    }),
  );

  const promise = fetchWaifuBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    signal: controller.signal,
    fetcher,
  });
  const expectation = expect(promise).rejects.toMatchObject({ code: 'aborted' });
  controller.abort();

  await jest.advanceTimersByTimeAsync(WAIFU_REQUEST_TIMEOUT_MS * 2 + 1);
  await expectation;
  expect(fetcher).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});

test('does not retry a failed request inside the client', async () => {
  const fetcher = jest.fn().mockRejectedValue(new TypeError('Network failed'));

  await expect(
    fetchWaifuBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      fetcher,
    }),
  ).rejects.toMatchObject({ code: 'network' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('returns parsed batches without retrying a failed request', async () => {
  const fetcher = jest.fn().mockResolvedValue(
    jsonResponse({
      totalCount: 1,
      items: [
        {
          id: 7,
          url: 'https://cdn.waifu.im/7.jpg',
          source: null,
          artists: [],
          width: 100,
          height: 200,
          byteSize: 300,
          extension: '.jpg',
          dominantColor: '#123456',
          isNsfw: false,
          isAnimated: false,
          tags: [{ slug: 'waifu' }],
        },
      ],
    }),
  );

  const batch = await fetchWaifuBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    fetcher,
  });

  expect(batch.items).toHaveLength(1);
  expect(batch.totalCount).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('rechecks discovery settings and trusted URLs before exposing candidates', async () => {
  const validImage = {
    id: 1,
    url: 'https://cdn.waifu.im/1.jpg',
    source: 'https://www.pixiv.net/artworks/1',
    artists: [],
    width: 1200,
    height: 1600,
    byteSize: 4_000_000,
    extension: '.jpg',
    dominantColor: '#123456',
    isNsfw: false,
    isAnimated: false,
    tags: [{ slug: 'waifu' }, { slug: 'maid' }],
  };
  const fetcher = jest.fn().mockResolvedValue(jsonResponse({
    totalCount: 12,
    items: [
      validImage,
      { ...validImage, id: 2, isNsfw: true },
      { ...validImage, id: 3, width: 1600, height: 1200 },
      { ...validImage, id: 4, isAnimated: true },
      { ...validImage, id: 5, width: 800 },
      { ...validImage, id: 6, byteSize: 6_000_000 },
      { ...validImage, id: 7, tags: [{ slug: 'waifu' }] },
      { ...validImage, id: 8, tags: [...validImage.tags, { slug: 'gore' }] },
      { ...validImage, id: 9, url: 'http://cdn.waifu.im/9.jpg' },
      { ...validImage, id: 10, url: 'https://cdn.waifu.im.evil.test/10.jpg' },
      { ...validImage, id: 11, source: 'http://www.pixiv.net/artworks/11' },
      { ...validImage, id: 12, source: 'https://pixiv.net.evil.test/artworks/12' },
    ],
  }));

  const batch = await fetchWaifuBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      includedTags: ['waifu', 'maid'],
      excludedTags: ['gore'],
      nsfwMode: 'sfw',
      orientation: 'portrait',
      animationMode: 'exclude',
      minWidth: 1080,
      maxBytes: 5_000_000,
    },
    excludedIds: [],
    fetcher,
  });

  expect(batch.totalCount).toBe(12);
  expect(batch.items.map((item) => item.providerItemId)).toEqual(['1', '11', '12']);
  expect(batch.items.map((item) => item.sourceUrl)).toEqual([
    'https://www.pixiv.net/artworks/1',
    null,
    null,
  ]);
  expect(batch.items.map((item) => item.canonicalSourceKey)).toEqual([
    'pixiv:1',
    null,
    null,
  ]);
});

test('pins image requests to Waifu.im API v7', async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse({ items: [] }));

  await fetchWaifuBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ headers: { 'Accept-Version': 'v7' } }),
  );
});

describe('fetchWaifuSearchPage', () => {
  const image = {
    id: 42,
    url: 'https://cdn.waifu.im/42.png',
    source: 'https://www.pixiv.net/artworks/42',
    artists: [],
    width: 2400,
    height: 1600,
    byteSize: 4_000_000,
    extension: '.png',
    dominantColor: '#abcdef',
    isNsfw: false,
    isAnimated: true,
    tags: [{ slug: 'raiden-shogun' }],
  };

  const request = {
    tags: ['raiden_shogun'],
    excludedTags: ['gore_scene'],
    nsfwMode: 'mixed',
    orientation: 'landscape',
    animationMode: 'only',
    minWidth: 1080,
    maxBytes: 5_000_000,
  } as const;

  test('forces Store searches to SFW and rejects unsafe hits', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      items: [{ ...image, isNsfw: true }],
      pageNumber: 1,
      totalPages: 1,
      totalCount: 1,
      hasNextPage: false,
    }));

    const page = await fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      fetcher,
      distributionPolicy: STORE_DISTRIBUTION_POLICY,
    });

    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('IsNsfw')).toBe(
      'False',
    );
    expect(page.items).toEqual([]);
  });

  test('requests a filtered v7 page and returns wrapped search hits', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      items: [image],
      pageNumber: 2,
      totalPages: 3,
      totalCount: 5,
      hasNextPage: true,
    }));

    const page = await fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      cursor: { page: 2 },
      limit: 2,
      fetcher,
    });

    const requestedUrl = new URL(fetcher.mock.calls[0][0]);
    expect(requestedUrl.origin + requestedUrl.pathname).toBe('https://api.waifu.im/images');
    expect(requestedUrl.searchParams.get('Page')).toBe('2');
    expect(requestedUrl.searchParams.get('PageSize')).toBe('2');
    expect(requestedUrl.searchParams.get('OrderBy')).toBe('UploadedAt');
    expect(requestedUrl.searchParams.getAll('IncludedTags')).toEqual(['raiden_shogun']);
    expect(requestedUrl.searchParams.getAll('ExcludedTags')).toEqual(['gore_scene']);
    expect(requestedUrl.searchParams.get('IsNsfw')).toBe('All');
    expect(requestedUrl.searchParams.get('Orientation')).toBe('Landscape');
    expect(requestedUrl.searchParams.get('IsAnimated')).toBe('True');
    expect(requestedUrl.searchParams.get('Width')).toBe('>=1080');
    expect(requestedUrl.searchParams.get('ByteSize')).toBe('<=5000000');
    expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: { 'Accept-Version': 'v7' },
    }));
    expect(page).toEqual({
      providerKey: 'waifu_im',
      items: [
        expect.objectContaining({
          key: 'waifu_im:42',
          // waifu.im publishes no distinct sample, so the R8.24 `sample ??
          // original` preview resolves back to the original URL.
          previewUrl: image.url,
          image: expect.objectContaining({
            providerKey: 'waifu_im',
            providerItemId: '42',
            remoteUrl: image.url,
            sampleUrl: image.url,
          }),
        }),
      ],
      nextCursor: { page: 3 },
      total: 5,
    });
  });

  test('round-trips the returned provider cursor into the next request', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [image],
        pageNumber: 2,
        totalPages: 3,
        totalCount: 2,
        hasNextPage: true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [],
        pageNumber: 3,
        totalPages: 3,
        totalCount: 2,
        hasNextPage: false,
      }));
    const searchRequest = {
      ...request,
      tags: [...request.tags],
      excludedTags: [...request.excludedTags],
    };

    const first = await fetchWaifuSearchPage({
      request: searchRequest,
      cursor: { page: 2 },
      fetcher,
    });
    const second = await fetchWaifuSearchPage({
      request: searchRequest,
      cursor: first.nextCursor,
      fetcher,
    });

    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('Page')).toBe('3');
    expect(first.nextCursor).toEqual({ page: 3 });
    expect(second.nextCursor).toBeNull();
  });

  test('returns immediately without requesting when the cursor is terminal', async () => {
    const fetcher = jest.fn();

    await expect(fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      cursor: null,
      fetcher,
    })).resolves.toEqual({
      providerKey: 'waifu_im',
      items: [],
      nextCursor: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects an invalid provider cursor without requesting', async () => {
    const fetcher = jest.fn();

    await expect(fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      cursor: { page: 0 },
      fetcher,
    })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rechecks every search filter and the remote image trust boundary locally', async () => {
    const validImage = { ...image, id: 1, isAnimated: false };
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      items: [
        validImage,
        { ...validImage, id: 2, isNsfw: true },
        { ...validImage, id: 3, tags: [{ slug: 'gore-scene' }] },
        { ...validImage, id: 4, width: 1200, height: 1600 },
        { ...validImage, id: 5, isAnimated: true },
        { ...validImage, id: 6, width: 800, height: 600 },
        { ...validImage, id: 7, byteSize: 6_000_000 },
        { ...validImage, id: 8, url: 'http://cdn.waifu.im/8.png' },
        { ...validImage, id: 9, url: 'https://cdn.waifu.im.evil.test/9.png' },
        { ...validImage, id: 10, tags: [{ slug: 'maid' }] },
      ],
      pageNumber: 1,
      totalPages: 1,
      totalCount: 10,
      hasNextPage: false,
    }));

    const page = await fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
        nsfwMode: 'sfw',
        animationMode: 'exclude',
      },
      fetcher,
    });

    expect(page.items.map((item) => item.key)).toEqual(['waifu_im:1', 'waifu_im:10']);
  });

  test('only exposes HTTPS source links on trusted hosts', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      items: [
        image,
        { ...image, id: 43, source: 'http://www.pixiv.net/artworks/43' },
        { ...image, id: 44, source: 'https://pixiv.net.evil.test/artworks/44' },
      ],
      pageNumber: 1,
      totalPages: 1,
      totalCount: 3,
      hasNextPage: false,
    }));

    const page = await fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      fetcher,
    });

    expect(page.items.map((item) => item.image.sourceUrl)).toEqual([
      'https://www.pixiv.net/artworks/42',
      null,
      null,
    ]);
    expect(page.items.map((item) => item.image.canonicalSourceKey)).toEqual([
      'pixiv:42',
      null,
      null,
    ]);
  });

  test('returns a valid empty terminal page', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      items: [],
      pageNumber: 1,
      totalPages: 0,
      totalCount: 0,
      hasNextPage: false,
    }));

    await expect(fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      fetcher,
    })).resolves.toEqual({
      providerKey: 'waifu_im',
      items: [],
      nextCursor: null,
      total: 0,
    });
  });

  test('treats a rejected tag as an unsupported query instead of an outage', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      errors: {
        'IncludedTags[0]': ['Tags must be a valid ID or a slug (lowercase letters, numbers, and hyphens).'],
      },
      title: 'One or more validation errors occurred.',
      status: 400,
    }, 400));

    await expect(fetchWaifuSearchPage({
      request: {
        ...request,
        tags: ['gundam'],
        excludedTags: [...request.excludedTags],
      },
      fetcher,
    })).resolves.toEqual({
      providerKey: 'waifu_im',
      items: [],
      nextCursor: null,
      total: 0,
      unsupportedQuery: true,
    });
  });

  test.each([
    [400, {}],
    [400, { errors: { Page: ['Invalid page'] } }],
    [400, { errors: { 'IncludedTags[0]': null } }],
    [400, { errors: { 'IncludedTags[0]': [] } }],
    [401, { errors: { 'IncludedTags[0]': ['Unauthorized'] } }],
    [500, { errors: { 'IncludedTags[0]': ['Server error'] } }],
  ])('does not report unrelated HTTP %i errors as unsupported', async (status, body) => {
    await expect(fetchWaifuSearchPage({
      request: { ...request, tags: ['福瑞'], excludedTags: [] },
      fetcher: async () => jsonResponse(body, status as number),
    })).rejects.toMatchObject({ code: 'http', status });
  });

  test('sends Chinese and provider spellings unchanged without inventing a mapping', async () => {
    const fetcher = jest.fn(async (_url: string) => jsonResponse({
      items: [], pageNumber: 1, totalPages: 0, totalCount: 0, hasNextPage: false,
    }));
    const result = await fetchWaifuSearchPage({
      request: { ...request, tags: ['福瑞', 'raiden-shogun'], excludedTags: [] },
      fetcher,
    });

    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.getAll('IncludedTags'))
      .toEqual(['福瑞', 'raiden-shogun']);
    expect(result).toMatchObject({ items: [], nextCursor: null });
    expect(result.unsupportedQuery).not.toBe(true);
  });

  test.each([
    [{ items: [] }, 'missing pagination'],
    [{
      items: [],
      pageNumber: 1,
      totalPages: 2,
      totalCount: 2,
      hasNextPage: false,
    }, 'inconsistent next page'],
    [{
      items: [],
      pageNumber: '1',
      totalPages: 0,
      totalCount: 0,
      hasNextPage: false,
    }, 'non-numeric page'],
  ] as const)('rejects a malformed search page: %s', async (body, _case) => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(body));

    await expect(fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      fetcher,
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  test('classifies a search rate limit and preserves Retry-After', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({}, 429, {
      'retry-after': '4',
    }));

    await expect(fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      fetcher,
    })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 4_000,
    });
  });

  test('classifies caller cancellation as aborted', async () => {
    const controller = new AbortController();
    const fetcher = jest.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()), {
          once: true,
        });
      }),
    );
    const pending = fetchWaifuSearchPage({
      request: {
        ...request,
        tags: [...request.tags],
        excludedTags: [...request.excludedTags],
      },
      signal: controller.signal,
      fetcher,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
