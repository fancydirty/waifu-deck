import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { SearchRequest } from '@/features/search/types';
import { STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';

import {
  buildNekosUrl,
  fetchNekosBatch,
  fetchNekosSearchPage,
  NekosApiError,
  NEKOS_REQUEST_TIMEOUT_MS,
  parseWebpMetadata,
} from './nekos-client';

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function vp8xHeader(width = 768, height = 1152, animated = false): Uint8Array {
  const bytes = new Uint8Array(64);
  writeAscii(bytes, 0, 'RIFF');
  writeAscii(bytes, 8, 'WEBP');
  writeAscii(bytes, 12, 'VP8X');
  bytes[20] = animated ? 0x02 : 0;
  const encodedWidth = width - 1;
  const encodedHeight = height - 1;
  bytes[24] = encodedWidth & 0xff;
  bytes[25] = (encodedWidth >> 8) & 0xff;
  bytes[26] = (encodedWidth >> 16) & 0xff;
  bytes[27] = encodedHeight & 0xff;
  bytes[28] = (encodedHeight >> 8) & 0xff;
  bytes[29] = (encodedHeight >> 16) & 0xff;
  return bytes;
}

function headers(values: Record<string, string>) {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers({}),
    json: async () => body,
  } as Response;
}

function rangeResponse(bytes = vp8xHeader(), byteSize = 394_630): Response {
  return {
    ok: true,
    status: 206,
    headers: headers({
      'content-type': 'image/webp',
      'content-range': `bytes 0-63/${byteSize}`,
    }),
    arrayBuffer: async () => bytes.buffer,
  } as Response;
}

function apiImage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'nekos-1',
    url: 'https://cdn.nekosapi.com/nekos-api/images/original/one.webp',
    rating: 'safe',
    color_primary: '#e8dad5',
    source_url: 'https://danbooru.donmai.us/post/show/6560542',
    artist_name: 'Example Artist',
    tags: [{ name: 'Girl', is_nsfw: false }],
    ...overrides,
  };
}

function searchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    tags: [],
    excludedTags: [],
    nsfwMode: DEFAULT_SETTINGS.nsfwMode,
    orientation: DEFAULT_SETTINGS.orientation,
    animationMode: DEFAULT_SETTINGS.animationMode,
    minWidth: DEFAULT_SETTINGS.minWidth,
    maxBytes: DEFAULT_SETTINGS.maxBytes,
    ...overrides,
  };
}

test('keeps Waifu included tags source-scoped when building a Nekos request', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    nsfwMode: 'mixed' as const,
    nsfwConfirmed: true,
    includedTags: ['waifu', 'blue-hair', 'uniform', 'raiden-shogun'],
  };
  const url = new URL(buildNekosUrl(settings));

  expect(url.origin + url.pathname).toBe('https://api.nekosapi.com/v5/images/random');
  expect(url.searchParams.getAll('rating')).toEqual([
    'safe',
    'suggestive',
    'borderline',
    'explicit',
  ]);
  expect(url.searchParams.getAll('tag')).toEqual([]);
});

test('uses only the strongest Nekos rating for strict NSFW mode', () => {
  const url = new URL(buildNekosUrl({
    ...DEFAULT_SETTINGS,
    nsfwMode: 'nsfw',
    nsfwConfirmed: true,
  }));

  expect(url.searchParams.getAll('rating')).toEqual(['explicit']);
});

test('forces Store discovery requests to safe ratings and drops unsafe results', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    nsfwMode: 'mixed' as const,
    nsfwConfirmed: true,
  };
  expect(new URL(
    buildNekosUrl(settings, STORE_DISTRIBUTION_POLICY),
  ).searchParams.getAll('rating')).toEqual(['safe']);

  const fetcher = jest.fn(async (_url: string) =>
    jsonResponse(apiImage({ rating: 'suggestive' })),
  );
  const batch = await fetchNekosBatch({
    settings,
    excludedIds: [],
    count: 1,
    fetcher,
    distributionPolicy: STORE_DISTRIBUTION_POLICY,
  });

  expect(new URL(fetcher.mock.calls[0]![0]).searchParams.getAll('rating')).toEqual([
    'safe',
  ]);
  expect(batch.items).toEqual([]);
});

test('accepts a known non-safe result in NSFW mode', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.startsWith('https://api.nekosapi.com/')
      ? jsonResponse(apiImage({ rating: 'suggestive' }))
      : rangeResponse(),
  );

  await expect(fetchNekosBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
    },
    excludedIds: [],
    count: 1,
    fetcher,
  })).resolves.toMatchObject({
    items: [{ contentRating: 'suggestive', isNsfw: true }],
    totalCount: 1,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('ignores a Waifu tag while applying orientation, width, and byte limits', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.startsWith('https://api.nekosapi.com/')
      ? jsonResponse(apiImage({ tags: [{ name: 'School Uniform', is_nsfw: false }] }))
      : rangeResponse(vp8xHeader(1440, 2160), 1_500_000),
  );

  const result = await fetchNekosBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: { waifu_im: false, nekos_api: true, danbooru: false, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
      includedTags: ['waifu', 'raiden-shogun'],
      orientation: 'portrait',
      minWidth: 1440,
      maxBytes: 2_000_000,
    },
    excludedIds: [],
    count: 1,
    fetcher,
  });

  expect(result.items[0]).toMatchObject({
    width: 1440,
    height: 2160,
    byteSize: 1_500_000,
    tags: ['School Uniform'],
  });
  expect(fetcher.mock.calls[0]?.[0]).not.toContain('tag=');
});

test('parses WebP dimensions and animation from a 64-byte VP8X header', () => {
  expect(parseWebpMetadata(vp8xHeader(1440, 2160, true))).toEqual({
    width: 1440,
    height: 2160,
    isAnimated: true,
  });
});

test('fetches candidates with provider identity using CDN range metadata', async () => {
  let apiRequest = 0;
  const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://api.nekosapi.com/')) {
      apiRequest += 1;
      return jsonResponse(apiImage({
        id: `nekos-${apiRequest}`,
        url: `https://cdn.nekosapi.com/nekos-api/images/original/${apiRequest}.webp`,
      }));
    }
    expect(init?.headers).toEqual({ Range: 'bytes=0-63' });
    return rangeResponse();
  });

  const result = await fetchNekosBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 2,
    fetcher,
  });

  expect(result.items).toHaveLength(2);
  expect(result.items[0]).toMatchObject({
    providerKey: 'nekos_api',
    providerItemId: 'nekos-1',
    canonicalSourceKey: 'danbooru:6560542',
    width: 768,
    height: 1152,
    byteSize: 394_630,
    extension: '.webp',
    isNsfw: false,
  });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test.each([
  'intent://open.example/#Intent;scheme=https;end',
  'javascript:alert(1)',
  'tel:+12025550123',
  'https://user:password@example.com/private',
])('drops an unsafe source URL while preserving the image: %s', async (sourceUrl) => {
  const fetcher = jest.fn(async (url: string) =>
    url.startsWith('https://api.nekosapi.com/')
      ? jsonResponse(apiImage({ source_url: sourceUrl }))
      : rangeResponse(),
  );

  const result = await fetchNekosBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher,
  });

  expect(result.items).toEqual([
    expect.objectContaining({
      sourceUrl: null,
      canonicalSourceKey: null,
    }),
  ]);
});

test('rejects an API-safe image when its tags mark it as NSFW', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.startsWith('https://api.nekosapi.com/')
      ? jsonResponse(apiImage({ tags: [{ name: 'Explicit nudity', is_nsfw: true }] }))
      : rangeResponse(),
  );

  await expect(fetchNekosBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher,
  })).resolves.toEqual({ items: [], totalCount: 0 });
});

test('does not request file metadata for an excluded provider ID', async () => {
  const fetcher = jest.fn(async () => jsonResponse(apiImage()));

  await expect(fetchNekosBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: ['nekos-1'],
    count: 1,
    fetcher,
  })).resolves.toEqual({ items: [], totalCount: 0 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('classifies an all-request rate limit for query-level retry', async () => {
  const fetcher = jest.fn(async () => ({
    ...jsonResponse({}, 429),
    headers: headers({ 'retry-after': '3' }),
  } as Response));

  await expect(fetchNekosBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 2,
    fetcher,
  })).rejects.toMatchObject({
    code: 'rate_limited',
    status: 429,
    retryAfterMs: 3_000,
  });
});

describe('fetchNekosSearchPage', () => {
  test('forces Store searches to safe ratings and rejects unsafe hits', async () => {
    const fetcher = jest.fn(async (url: string) =>
      url.startsWith('https://api.nekosapi.com/')
        ? jsonResponse({
            items: [apiImage({ rating: 'suggestive' })],
            total: 1,
          })
        : rangeResponse(),
    );

    const page = await fetchNekosSearchPage({
      request: searchRequest({
        nsfwMode: 'mixed',
      }),
      fetcher,
      distributionPolicy: STORE_DISTRIBUTION_POLICY,
    });

    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.getAll('rating')).toEqual([
      'safe',
    ]);
    expect(page.items).toEqual([]);
  });

  test('requests the paginated list endpoint with the caller raw tag', async () => {
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        const requestUrl = new URL(url);
        expect(requestUrl.origin + requestUrl.pathname).toBe(
          'https://api.nekosapi.com/v5/images',
        );
        expect(requestUrl.searchParams.getAll('tag')).toEqual(['School Uniform']);
        expect(requestUrl.searchParams.getAll('rating')).toEqual(['safe']);
        expect(requestUrl.searchParams.get('offset')).toBe('20');
        expect(requestUrl.searchParams.get('limit')).toBe('2');
        expect(requestUrl.searchParams.has('includedTags')).toBe(false);
        return jsonResponse({
          items: [
            apiImage({
              id: 'nekos-20',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/20.webp',
              tags: [{ name: 'School Uniform', is_nsfw: false }],
            }),
            apiImage({
              id: 'nekos-21',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/21.webp',
              tags: [{ name: 'School Uniform', is_nsfw: false }],
            }),
          ],
          total: 50,
        });
      }
      expect(init?.headers).toEqual({ Range: 'bytes=0-63' });
      return rangeResponse();
    });

    await expect(
      fetchNekosSearchPage({
        request: searchRequest({ tags: ['School Uniform'] }),
        cursor: { offset: 20 },
        limit: 2,
        fetcher,
      }),
    ).resolves.toEqual({
      providerKey: 'nekos_api',
      items: [
        expect.objectContaining({
          key: 'nekos_api:nekos-20',
          // nekos publishes no distinct sample, so the R8.24 `sample ??
          // original` preview resolves back to the original URL.
          previewUrl: 'https://cdn.nekosapi.com/nekos-api/images/original/20.webp',
          image: expect.objectContaining({
            providerKey: 'nekos_api',
            providerItemId: 'nekos-20',
            sampleUrl: 'https://cdn.nekosapi.com/nekos-api/images/original/20.webp',
            tags: ['School Uniform'],
          }),
        }),
        expect.objectContaining({
          key: 'nekos_api:nekos-21',
          previewUrl: 'https://cdn.nekosapi.com/nekos-api/images/original/21.webp',
          image: expect.objectContaining({ providerItemId: 'nekos-21' }),
        }),
      ],
      nextCursor: { offset: 22 },
      total: 50,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('skips malformed and locally excluded items before requesting CDN metadata', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return jsonResponse({
          items: [
            apiImage({ id: '', url: 'not-a-url' }),
            apiImage({
              id: 'excluded',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/excluded.webp',
              tags: [{ name: 'Gore', is_nsfw: false }],
            }),
            apiImage({
              id: 'unsafe-tag',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/unsafe.webp',
              tags: [{ name: 'Explicit Nudity', is_nsfw: true }],
            }),
            apiImage({
              id: 'valid',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/valid.webp',
              tags: [{ name: 'Girl', is_nsfw: false }],
            }),
          ],
          total: 4,
        });
      }
      expect(url).toBe(
        'https://cdn.nekosapi.com/nekos-api/images/original/valid.webp',
      );
      return rangeResponse();
    });

    const page = await fetchNekosSearchPage({
      request: searchRequest({ tags: ['girl'], excludedTags: ['gore'] }),
      limit: 4,
      fetcher,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ image: expect.objectContaining({ providerItemId: 'valid' }) }),
    ]);
    expect(page.nextCursor).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('applies orientation, animation, width, and byte filters after Range metadata', async () => {
    const images = [
      ['landscape', vp8xHeader(1600, 900), 900_000],
      ['animated', vp8xHeader(1600, 2400, true), 900_000],
      ['narrow', vp8xHeader(800, 1200), 900_000],
      ['large', vp8xHeader(1600, 2400), 3_000_000],
      ['accepted', vp8xHeader(1600, 2400), 900_000],
    ] as const;
    const fetcher = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return jsonResponse({
          items: images.map(([id]) =>
            apiImage({
              id,
              url: `https://cdn.nekosapi.com/nekos-api/images/original/${id}.webp`,
            }),
          ),
          total: images.length,
        });
      }
      const item = images.find(([id]) => url.endsWith(`/${id}.webp`));
      if (item === undefined) throw new Error(`Unexpected metadata URL: ${url}`);
      return rangeResponse(item[1], item[2]);
    });

    const page = await fetchNekosSearchPage({
      request: searchRequest({
        orientation: 'portrait',
        animationMode: 'exclude',
        minWidth: 1440,
        maxBytes: 2_000_000,
      }),
      limit: images.length,
      fetcher,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ image: expect.objectContaining({ providerItemId: 'accepted' }) }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1 + images.length);
  });

  test('skips one malformed CDN item while preserving valid hits and page progress', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return jsonResponse({
          items: [
            apiImage({
              id: 'bad-cdn',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/bad.webp',
            }),
            apiImage({
              id: 'good-cdn',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/good.webp',
            }),
          ],
          total: 3,
        });
      }
      return url.endsWith('/bad.webp') ? jsonResponse({}, 200) : rangeResponse();
    });

    const page = await fetchNekosSearchPage({
      request: searchRequest(),
      limit: 2,
      fetcher,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ image: expect.objectContaining({ providerItemId: 'good-cdn' }) }),
    ]);
    expect(page.nextCursor).toEqual({ offset: 2 });
  });

  test('fails the page when every CDN metadata request has a network error', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return jsonResponse({
          items: [
            apiImage({
              id: 'offline-1',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/offline-1.webp',
            }),
            apiImage({
              id: 'offline-2',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/offline-2.webp',
            }),
          ],
          total: 10,
        });
      }
      throw new TypeError('Network request failed');
    });

    await expect(
      fetchNekosSearchPage({
        request: searchRequest(),
        cursor: { offset: 4 },
        limit: 2,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  test('fails the page when one CDN metadata request has a network error', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return jsonResponse({
          items: [
            apiImage({
              id: 'available',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/available.webp',
            }),
            apiImage({
              id: 'offline',
              url: 'https://cdn.nekosapi.com/nekos-api/images/original/offline.webp',
            }),
          ],
          total: 10,
        });
      }
      if (url.endsWith('/available.webp')) return rangeResponse();
      throw new TypeError('Network request failed');
    });

    await expect(
      fetchNekosSearchPage({
        request: searchRequest(),
        cursor: { offset: 4 },
        limit: 2,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  test('preserves a CDN metadata rate limit for query-level retry', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return jsonResponse({ items: [apiImage()], total: 3 });
      }
      return {
        ...jsonResponse({}, 429),
        headers: headers({ 'retry-after': '5' }),
      } as Response;
    });

    await expect(
      fetchNekosSearchPage({
        request: searchRequest(),
        limit: 1,
        fetcher,
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 5_000,
    });
  });

  test('classifies a search rate limit and preserves Retry-After', async () => {
    const fetcher = jest.fn(async () => ({
      ...jsonResponse({}, 429),
      headers: headers({ 'retry-after': '4' }),
    } as Response));

    await expect(
      fetchNekosSearchPage({
        request: searchRequest({ tags: ['girl'] }),
        limit: 10,
        fetcher,
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 4_000,
    });
  });

  test('treats explicit tag validation as an unsupported query', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      detail: [{
        type: 'too_long',
        loc: ['query', 'tag'],
        msg: 'Set should have at most 5 items after validation, not more',
      }],
    }, 422));

    await expect(fetchNekosSearchPage({
      request: searchRequest({ tags: ['gundam'] }),
      fetcher,
    })).resolves.toEqual({
      providerKey: 'nekos_api',
      items: [],
      nextCursor: null,
      total: 0,
      unsupportedQuery: true,
    });
  });

  test('sends all source-owned terms for source validation instead of truncating at five', async () => {
    const fetcher = jest.fn(async (_url: string) => jsonResponse({ items: [], total: 0 }));
    await fetchNekosSearchPage({
      request: searchRequest({ tags: ['Girl', 'Boy', 'School Uniform', 'Maid', 'Glasses', '福瑞'] }),
      fetcher,
    });

    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.getAll('tag'))
      .toEqual(['Girl', 'Boy', 'School Uniform', 'Maid', 'Glasses', '福瑞']);
  });

  test.each([
    [422, {}],
    [422, { detail: [{ loc: ['query', 'offset'], msg: 'Invalid offset' }] }],
    [422, { detail: [{ loc: ['query', 'tag'] }] }],
    [401, { detail: [{ loc: ['query', 'tag'], msg: 'Unauthorized' }] }],
    [500, { title: 'Internal Server Error', message: 'An unexpected error occurred on the server.' }],
  ])('does not report unrelated HTTP %i errors as unsupported', async (status, body) => {
    await expect(fetchNekosSearchPage({
      request: searchRequest({ tags: ['福瑞'] }),
      fetcher: async () => jsonResponse(body, status as number),
    })).rejects.toMatchObject({ code: 'http', status });
  });


  test('classifies caller cancellation during CDN metadata as aborted', async () => {
    const controller = new AbortController();
    let markMetadataStarted!: () => void;
    const metadataStarted = new Promise<void>((resolve) => {
      markMetadataStarted = resolve;
    });
    const fetcher = jest.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('https://api.nekosapi.com/')) {
        return Promise.resolve(jsonResponse({ items: [apiImage()], total: 3 }));
      }
      markMetadataStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });

    const pending = fetchNekosSearchPage({
      request: searchRequest({ tags: ['girl'] }),
      signal: controller.signal,
      fetcher,
    });
    await metadataStarted;
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(NekosApiError);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  test('classifies a stalled CDN metadata request as timed out', async () => {
    jest.useFakeTimers();
    try {
      let markMetadataStarted!: () => void;
      const metadataStarted = new Promise<void>((resolve) => {
        markMetadataStarted = resolve;
      });
      const fetcher = jest.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('https://api.nekosapi.com/')) {
          return Promise.resolve(jsonResponse({ items: [apiImage()], total: 3 }));
        }
        markMetadataStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      });

      const pending = fetchNekosSearchPage({
        request: searchRequest(),
        fetcher,
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await metadataStarted;
      jest.advanceTimersByTime(NEKOS_REQUEST_TIMEOUT_MS);

      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });

  test('returns an empty terminal page when the API has no more results', async () => {
    const fetcher = jest.fn(async () => jsonResponse({ items: [], total: 12 }));

    await expect(
      fetchNekosSearchPage({
        request: searchRequest({ tags: ['girl'] }),
        cursor: { offset: 12 },
        limit: 10,
        fetcher,
      }),
    ).resolves.toEqual({
      providerKey: 'nekos_api',
      items: [],
      nextCursor: null,
      total: 12,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

test('R8.18: sampleUrl equals remoteUrl (nekos has no distinct sample)', async () => {
  const fetcher = jest.fn(async (url: string) =>
    url.startsWith('https://api.nekosapi.com/')
      ? jsonResponse(apiImage())
      : rangeResponse(vp8xHeader(1440, 2160), 1_500_000),
  );

  const result = await fetchNekosBatch({
    settings: { ...DEFAULT_SETTINGS, nsfwMode: 'mixed', nsfwConfirmed: true },
    excludedIds: [],
    count: 1,
    fetcher,
  });

  const candidate = result.items[0];
  expect(candidate?.sampleUrl).toBe(candidate?.remoteUrl);
  expect(candidate?.sampleUrl).toBe('https://cdn.nekosapi.com/nekos-api/images/original/one.webp');
});

test('K7 ⑳ probes every hit on a search page at once, not two at a time', async () => {
  const PAGE_SIZE = 6;
  let started = 0;
  let releaseAll!: () => void;
  // The barrier is the concurrency proof: no probe resolves until ALL of them
  // are in flight, so any chunked `for … await` loop can only deadlock here.
  const allInFlight = new Promise<void>((resolve) => { releaseAll = resolve; });
  const fetcher = jest.fn(async (url: string) => {
    if (url.startsWith('https://api.nekosapi.com/')) {
      return jsonResponse({
        items: Array.from({ length: PAGE_SIZE }, (_unused, index) => apiImage({
          id: `nekos-${index}`,
          url: `https://cdn.nekosapi.com/nekos-api/images/original/${index}.webp`,
        })),
        total: PAGE_SIZE,
      });
    }
    started += 1;
    if (started === PAGE_SIZE) releaseAll();
    await allInFlight;
    return rangeResponse();
  });

  const page = await fetchNekosSearchPage({
    request: searchRequest(),
    limit: PAGE_SIZE,
    fetcher,
  });

  expect(started).toBe(PAGE_SIZE);
  expect(page.items).toHaveLength(PAGE_SIZE);
  expect(fetcher).toHaveBeenCalledTimes(PAGE_SIZE + 1);
});
