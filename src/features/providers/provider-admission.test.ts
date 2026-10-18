import { fetchDanbooruBatch } from '@/features/danbooru/danbooru-client';
import {
  DIRECT_DISTRIBUTION_POLICY,
  type DistributionPolicy,
} from '@/features/distribution/distribution-policy';
import { fetchGelbooruBatch } from '@/features/gelbooru/gelbooru-client';
import { fetchNekosBatch } from '@/features/nekos/nekos-client';
import {
  defineProviderAdmissionRegistryTests,
  type ProviderAdmissionRegistry,
  validateProviderAdmissionContract,
} from '@/features/providers/provider-admission-test-helper';
import { fetchRule34Batch } from '@/features/rule34/rule34-client';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import {
  fetchSafebooruBatch,
  type SafebooruRating,
} from '@/features/safebooru/safebooru-client';
import { fetchWaifuBatch } from '@/features/waifu/waifu-client';
import type { ImageCandidate } from '@/features/waifu/types';
import { fetchYandereBatch } from '@/features/yandere/yandere-client';
import { fetchKonachanBatch } from '@/features/konachan/konachan-client';
import { fetchE621Batch } from '@/features/e621/e621-client';
import { fetchE926Batch } from '@/features/e926/e926-client';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    // The Gelbooru-DAPI engine reads the body via `.text()` + `JSON.parse`
    // (not `.json()` directly), so this mock must implement both.
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/**
 * The REAL e621-family `posts/random.json` WRAPS the post in `{"post":{...}}`
 * (verified live with curl; see `responseSingleKey` in `e621-client.ts`).
 * Danbooru-family peers return it bare, which is why the e621/e926 admission
 * fixtures below originally passed a bare object — green-but-wrong: it agreed
 * with the unit suites while every live e621/e926 call failed
 * `invalid_response`. These two providers therefore use this helper instead of
 * `jsonResponse` directly.
 */
// K7 ⑯: discovery asks `posts.json?...order:random&limit=N` once, so the
// e621-family wire shape here is the LIST wrapper `{"posts":[...]}` rather
// than `posts/random.json`'s `{"post":{...}}`.
function e621FamilyRandomResponse(post: unknown): Response {
  return jsonResponse({ posts: [post] });
}

const mixedSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'mixed' as const,
  nsfwConfirmed: true,
};

type WaifuFixture = {
  id?: number;
  isNsfw: boolean;
  source?: string | null;
  artists?: unknown[];
};

async function adaptWaifu(
  fixture: WaifuFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const batch = await fetchWaifuBatch({
    settings: mixedSettings,
    excludedIds: [],
    distributionPolicy,
    fetcher: jest.fn().mockResolvedValue(jsonResponse({
      totalCount: 1,
      items: [{
        id,
        url: `https://cdn.waifu.im/${id}.jpg`,
        source: fixture.source ?? null,
        artists: fixture.artists ?? [],
        width: 1200,
        height: 1800,
        byteSize: 400_000,
        extension: '.jpg',
        isNsfw: fixture.isNsfw,
        isAnimated: false,
        tags: [{ slug: 'waifu' }],
      }],
    })),
  });
  return batch.items[0] ?? null;
}

type NekosFixture = {
  id?: string;
  rating: 'safe' | 'suggestive' | 'borderline' | 'explicit';
  nsfwTag?: boolean;
  sourceUrl?: string | null;
  artistName?: string | null;
};

function webpMetadataResponse(): Response {
  const bytes = new Uint8Array(64);
  bytes.set([...Buffer.from('RIFF')], 0);
  bytes.set([...Buffer.from('WEBP')], 8);
  bytes.set([...Buffer.from('VP8X')], 12);
  bytes[24] = 255;
  bytes[25] = 2;
  bytes[27] = 127;
  bytes[28] = 4;
  return {
    ok: true,
    status: 206,
    headers: {
      get: (name: string) => ({
        'content-range': 'bytes 0-63/400000',
        'content-type': 'image/webp',
      })[name.toLowerCase()] ?? null,
    },
    arrayBuffer: async () => bytes.buffer,
  } as Response;
}

async function adaptNekos(
  fixture: NekosFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 'nekos-101';
  const fetcher = jest.fn(async (url: string) =>
    url.startsWith('https://api.nekosapi.com/v5/images/random')
      ? jsonResponse({
          id,
          url: `https://cdn.nekosapi.com/images/${id}.webp`,
          rating: fixture.rating,
          source_url: fixture.sourceUrl ?? null,
          artist_name: fixture.artistName ?? null,
          tags: fixture.nsfwTag ? [{ name: 'NSFW', is_nsfw: true }] : [],
        })
      : webpMetadataResponse(),
  );
  const batch = await fetchNekosBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    fetcher,
  });
  return batch.items[0] ?? null;
}

type DanbooruFixture = {
  id?: number;
  rating: 'g' | 's' | 'q' | 'e';
  source?: string | null;
  artistTag?: string | null;
};

async function adaptDanbooru(
  fixture: DanbooruFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const artistTag = fixture.artistTag ?? null;
  const batch = await fetchDanbooruBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    // K7 ⑯: discovery asks `posts.json?...random:N` once, so the wire shape
    // here is a one-element page rather than a bare `posts/random.json` post.
    fetcher: jest.fn().mockResolvedValue(jsonResponse([{
      id,
      image_width: 1200,
      image_height: 1800,
      file_size: 400_000,
      file_ext: 'jpg',
      file_url: `https://cdn.donmai.us/original/ab/cd/${id}.jpg`,
      source: fixture.source ?? null,
      rating: fixture.rating,
      tag_string: ['1girl', artistTag].filter(Boolean).join(' '),
      tag_string_artist: artistTag ?? '',
      media_asset: { duration: null },
      md5: '0123456789abcdef0123456789abcdef',
    }])),
  });
  return batch.items[0] ?? null;
}

type SafebooruFixture = {
  id?: number;
  rating: SafebooruRating;
  source?: string | null;
  artistTag?: string | null;
};

async function adaptSafebooru(
  fixture: SafebooruFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const artistTag = fixture.artistTag ?? null;
  const fetcher = jest.fn(async (url: string) => {
    if (url.startsWith('https://safebooru.org/index.php')) {
      return jsonResponse([{
        id,
        width: 1200,
        height: 1800,
        file_url: `https://safebooru.org/images/1/${id}.jpg`,
        preview_url: `https://safebooru.org/thumbnails/1/${id}.jpg`,
        rating: fixture.rating,
        tags: ['1girl', artistTag].filter(Boolean).join(' '),
        source: fixture.source ?? null,
        hash: '0123456789abcdef0123456789abcdef',
      }]);
    }
    return {
      ok: true,
      status: 206,
      headers: {
        get: (name: string) => ({
          'content-range': 'bytes 0-0/400000',
          'content-type': 'image/jpeg',
        })[name.toLowerCase()] ?? null,
      },
    } as unknown as Response;
  });
  const batch = await fetchSafebooruBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    fetcher,
  });
  return batch.items[0] ?? null;
}

type YandereFixture = {
  id?: number;
  rating: 's' | 'q' | 'e';
  source?: string | null;
  tags?: string;
};

async function adaptYandere(
  fixture: YandereFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const batch = await fetchYandereBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([{
      id,
      width: 1200,
      height: 1800,
      file_size: 400_000,
      file_ext: 'jpg',
      file_url: `https://files.yande.re/image/${id}.jpg`,
      preview_url: `https://assets.yande.re/preview/${id}.jpg`,
      rating: fixture.rating,
      tags: fixture.tags ?? '1girl',
      source: fixture.source ?? null,
      md5: '0123456789abcdef0123456789abcdef',
    }])),
  });
  return batch.items[0] ?? null;
}

type KonachanFixture = {
  id?: number;
  rating: 's' | 'q' | 'e';
  source?: string | null;
  tags?: string;
};

async function adaptKonachan(
  fixture: KonachanFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const batch = await fetchKonachanBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    fetcher: jest.fn().mockResolvedValue(jsonResponse([{
      id,
      width: 1200,
      height: 1800,
      file_size: 400_000,
      file_ext: 'jpg',
      file_url: `https://konachan.net/image/${id}.jpg`,
      preview_url: `https://konachan.net/preview/${id}.jpg`,
      rating: fixture.rating,
      tags: fixture.tags ?? '1girl',
      source: fixture.source ?? null,
      md5: '0123456789abcdef0123456789abcdef',
    }])),
  });
  return batch.items[0] ?? null;
}

type E621Fixture = {
  id?: number;
  rating: 's' | 'q' | 'e';
  source?: string | null;
  artistTag?: string | null;
};

async function adaptE621(
  fixture: E621Fixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const artistTag = fixture.artistTag ?? null;
  const batch = await fetchE621Batch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    fetcher: jest.fn().mockResolvedValue(e621FamilyRandomResponse({
      id,
      file: {
        width: 1200,
        height: 1800,
        ext: 'jpg',
        size: 400_000,
        md5: '0123456789abcdef0123456789abcdef',
        url: `https://static1.e621.net/data/ab/cd/${id}.jpg`,
      },
      preview: { url: `https://static1.e621.net/data/preview/ab/cd/${id}.jpg` },
      sample: { url: `https://static1.e621.net/data/sample/ab/cd/${id}.jpg` },
      tags: {
        general: ['1girl'],
        species: [],
        character: [],
        copyright: [],
        artist: artistTag ? [artistTag] : [],
        invalid: [],
        contributor: [],
        meta: [],
        lore: [],
      },
      rating: fixture.rating,
      flags: { deleted: false, pending: false, flagged: false },
      sources: fixture.source ? [fixture.source] : [],
    })),
  });
  return batch.items[0] ?? null;
}

type E926Fixture = {
  id?: number;
  rating: 's' | 'q' | 'e';
  source?: string | null;
  artistTag?: string | null;
};

async function adaptE926(
  fixture: E926Fixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const artistTag = fixture.artistTag ?? null;
  const batch = await fetchE926Batch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    fetcher: jest.fn().mockResolvedValue(e621FamilyRandomResponse({
      id,
      file: {
        width: 1200,
        height: 1800,
        ext: 'jpg',
        size: 400_000,
        md5: '0123456789abcdef0123456789abcdef',
        url: `https://static1.e926.net/data/ab/cd/${id}.jpg`,
      },
      preview: { url: `https://static1.e926.net/data/preview/ab/cd/${id}.jpg` },
      sample: { url: `https://static1.e926.net/data/sample/ab/cd/${id}.jpg` },
      tags: {
        general: ['1girl'],
        species: [],
        character: [],
        copyright: [],
        artist: artistTag ? [artistTag] : [],
        invalid: [],
        contributor: [],
        meta: [],
        lore: [],
      },
      rating: fixture.rating,
      flags: { deleted: false, pending: false, flagged: false },
      sources: fixture.source ? [fixture.source] : [],
    })),
  });
  return batch.items[0] ?? null;
}

type GelbooruFixture = {
  id?: number;
  rating: 'general' | 'sensitive' | 'questionable' | 'explicit';
  source?: string | null;
};

async function adaptGelbooru(
  fixture: GelbooruFixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 101;
  const batch = await fetchGelbooruBatch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    credential: { apiKey: 'test', userId: '42' },
    fetcher: jest.fn().mockResolvedValue(jsonResponse({
      '@attributes': { count: 1 },
      post: [{
        id,
        width: 1200,
        height: 1800,
        file_url: `https://img4.gelbooru.com/images/ab/cd/${id}.jpg`,
        preview_url: `https://img4.gelbooru.com/thumbnails/ab/cd/${id}.jpg`,
        rating: fixture.rating,
        tags: '1girl',
        source: fixture.source ?? null,
        md5: '0123456789abcdef0123456789abcdef',
      }],
    })),
  });
  return batch.items[0] ?? null;
}

type Rule34Fixture = {
  id?: number;
  rating: 'sensitive' | 'questionable' | 'explicit';
  source?: string | null;
};

async function adaptRule34(
  fixture: Rule34Fixture,
  distributionPolicy: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const id = fixture.id ?? 202;
  const batch = await fetchRule34Batch({
    settings: mixedSettings,
    excludedIds: [],
    count: 1,
    distributionPolicy,
    credential: { apiKey: 'test', userId: '42' },
    fetcher: jest.fn().mockResolvedValue(jsonResponse([{
      id,
      width: 1200,
      height: 1800,
      file_url: `https://api-cdn.rule34.xxx/images/ab/cd/${id}.jpg`,
      preview_url: `https://api-cdn.rule34.xxx/thumbnails/ab/cd/${id}.jpg`,
      rating: fixture.rating,
      tags: '1girl',
      source: fixture.source ?? null,
      hash: '0123456789abcdef0123456789abcdef',
    }])),
  });
  return batch.items[0] ?? null;
}

const providerAdmissionRegistry = {
  waifu_im: {
    providerKey: 'waifu_im',
    adapt: adaptWaifu,
    identity: { fixture: { id: 4242, isNsfw: false }, expectedItemId: '4242' },
    nativeRatings: {
      false: true,
      true: true,
    } satisfies Record<`${WaifuFixture['isNsfw']}`, true>,
    ratings: [
      { nativeRating: 'false', fixture: { isNsfw: false }, canonicalRating: 'safe' },
      {
        nativeRating: 'true',
        fixture: { isNsfw: true },
        canonicalRating: 'nsfw_unspecified',
      },
    ],
    attribution: {
      fixture: {
        isNsfw: false,
        source: 'https://www.pixiv.net/artworks/101',
        artists: [{ name: 'Artist', pixiv: 'https://www.pixiv.net/users/5' }],
      },
    },
    md5: null,
  },
  nekos_api: {
    providerKey: 'nekos_api',
    adapt: adaptNekos,
    identity: {
      fixture: { id: 'stable-nekos-id', rating: 'safe' },
      expectedItemId: 'stable-nekos-id',
    },
    nativeRatings: {
      safe: true,
      suggestive: true,
      borderline: true,
      explicit: true,
    } satisfies Record<NekosFixture['rating'], true>,
    ratings: [
      { nativeRating: 'safe', fixture: { rating: 'safe' }, canonicalRating: 'safe' },
      {
        label: 'safe with an NSFW tag',
        nativeRating: 'safe',
        fixture: { rating: 'safe', nsfwTag: true },
        canonicalRating: 'nsfw_unspecified',
      },
      {
        nativeRating: 'suggestive',
        fixture: { rating: 'suggestive' },
        canonicalRating: 'suggestive',
      },
      {
        nativeRating: 'borderline',
        fixture: { rating: 'borderline' },
        canonicalRating: 'nsfw_unspecified',
      },
      {
        nativeRating: 'explicit',
        fixture: { rating: 'explicit' },
        canonicalRating: 'explicit',
      },
    ],
    attribution: {
      fixture: {
        rating: 'safe',
        sourceUrl: 'https://www.pixiv.net/artworks/202',
        artistName: 'Artist',
      },
    },
    md5: null,
  },
  danbooru: {
    providerKey: 'danbooru',
    adapt: adaptDanbooru,
    identity: { fixture: { id: 6060, rating: 'g' }, expectedItemId: '6060' },
    nativeRatings: {
      g: true,
      s: true,
      q: true,
      e: true,
    } satisfies Record<DanbooruFixture['rating'], true>,
    ratings: [
      { nativeRating: 'g', fixture: { rating: 'g' }, canonicalRating: 'safe' },
      { nativeRating: 's', fixture: { rating: 's' }, canonicalRating: 'suggestive' },
      {
        nativeRating: 'q',
        fixture: { rating: 'q' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'e', fixture: { rating: 'e' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 'g',
        source: 'https://www.pixiv.net/artworks/303',
        artistTag: 'example_artist',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  safebooru: {
    providerKey: 'safebooru',
    adapt: adaptSafebooru,
    identity: {
      fixture: { id: 7070, rating: 'safe' },
      expectedItemId: '7070',
    },
    nativeRatings: {
      general: true,
      safe: true,
      questionable: true,
    } satisfies Record<SafebooruFixture['rating'], true>,
    ratings: [
      { nativeRating: 'general', fixture: { rating: 'general' }, canonicalRating: 'safe' },
      { nativeRating: 'safe', fixture: { rating: 'safe' }, canonicalRating: 'safe' },
      {
        nativeRating: 'questionable',
        fixture: { rating: 'questionable' },
        canonicalRating: 'nsfw_unspecified',
      },
    ],
    attribution: {
      fixture: {
        rating: 'safe',
        source: 'https://www.pixiv.net/artworks/404',
        artistTag: 'example_artist',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  yandere: {
    providerKey: 'yandere',
    adapt: adaptYandere,
    identity: {
      fixture: { id: 8080, rating: 's' },
      expectedItemId: '8080',
    },
    nativeRatings: {
      s: true,
      q: true,
      e: true,
    } satisfies Record<YandereFixture['rating'], true>,
    ratings: [
      { nativeRating: 's', fixture: { rating: 's' }, canonicalRating: 'safe' },
      {
        nativeRating: 'q',
        fixture: { rating: 'q' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'e', fixture: { rating: 'e' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 's',
        source: 'https://www.pixiv.net/artworks/505',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  konachan: {
    providerKey: 'konachan',
    adapt: adaptKonachan,
    identity: {
      fixture: { id: 9090, rating: 's' },
      expectedItemId: '9090',
    },
    nativeRatings: {
      s: true,
      q: true,
      e: true,
    } satisfies Record<KonachanFixture['rating'], true>,
    ratings: [
      { nativeRating: 's', fixture: { rating: 's' }, canonicalRating: 'safe' },
      {
        nativeRating: 'q',
        fixture: { rating: 'q' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'e', fixture: { rating: 'e' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 's',
        source: 'https://www.pixiv.net/artworks/606',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  e621: {
    providerKey: 'e621',
    adapt: adaptE621,
    identity: {
      fixture: { id: 1212, rating: 's' },
      expectedItemId: '1212',
    },
    nativeRatings: {
      s: true,
      q: true,
      e: true,
    } satisfies Record<E621Fixture['rating'], true>,
    ratings: [
      { nativeRating: 's', fixture: { rating: 's' }, canonicalRating: 'safe' },
      {
        nativeRating: 'q',
        fixture: { rating: 'q' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'e', fixture: { rating: 'e' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 's',
        source: 'https://www.pixiv.net/artworks/707',
        artistTag: 'example_artist',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  e926: {
    providerKey: 'e926',
    adapt: adaptE926,
    identity: {
      fixture: { id: 1313, rating: 's' },
      expectedItemId: '1313',
    },
    nativeRatings: {
      s: true,
      q: true,
      e: true,
    } satisfies Record<E926Fixture['rating'], true>,
    ratings: [
      { nativeRating: 's', fixture: { rating: 's' }, canonicalRating: 'safe' },
      {
        nativeRating: 'q',
        fixture: { rating: 'q' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'e', fixture: { rating: 'e' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 's',
        source: 'https://www.pixiv.net/artworks/808',
        artistTag: 'example_artist',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  gelbooru: {
    providerKey: 'gelbooru',
    adapt: adaptGelbooru,
    identity: {
      fixture: { id: 1414, rating: 'general' },
      expectedItemId: '1414',
    },
    nativeRatings: {
      general: true,
      sensitive: true,
      questionable: true,
      explicit: true,
    } satisfies Record<GelbooruFixture['rating'], true>,
    ratings: [
      { nativeRating: 'general', fixture: { rating: 'general' }, canonicalRating: 'safe' },
      {
        nativeRating: 'sensitive',
        fixture: { rating: 'sensitive' },
        canonicalRating: 'suggestive',
      },
      {
        nativeRating: 'questionable',
        fixture: { rating: 'questionable' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'explicit', fixture: { rating: 'explicit' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 'general',
        source: 'https://www.pixiv.net/artworks/909',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
  rule34: {
    providerKey: 'rule34',
    adapt: adaptRule34,
    identity: {
      fixture: { id: 1515, rating: 'sensitive' },
      expectedItemId: '1515',
    },
    nativeRatings: {
      sensitive: true,
      questionable: true,
      explicit: true,
    } satisfies Record<Rule34Fixture['rating'], true>,
    ratings: [
      {
        nativeRating: 'sensitive',
        fixture: { rating: 'sensitive' },
        canonicalRating: 'suggestive',
      },
      {
        nativeRating: 'questionable',
        fixture: { rating: 'questionable' },
        canonicalRating: 'nsfw_unspecified',
      },
      { nativeRating: 'explicit', fixture: { rating: 'explicit' }, canonicalRating: 'explicit' },
    ],
    attribution: {
      fixture: {
        rating: 'sensitive',
        source: 'https://example.invalid/art/1010',
      },
    },
    md5: '0123456789abcdef0123456789abcdef',
  },
} satisfies ProviderAdmissionRegistry;

describe('provider admission contract validation', () => {
  const validContract = providerAdmissionRegistry.waifu_im;

  test('rejects a declared native rating without a mapping case', () => {
    expect(() => validateProviderAdmissionContract({
      ...validContract,
      ratings: validContract.ratings.filter(({ nativeRating }) => nativeRating !== 'true'),
    })).toThrow('waifu_im is missing a mapping case for true');
  });

  test('rejects a contract that supplies only safe mapping cases', () => {
    expect(() => validateProviderAdmissionContract({
      ...validContract,
      nativeRatings: { false: true },
      ratings: validContract.ratings.filter(({ canonicalRating }) => canonicalRating === 'safe'),
    })).toThrow('waifu_im must prove at least one non-safe Store rejection');
  });
});

defineProviderAdmissionRegistryTests(providerAdmissionRegistry);
