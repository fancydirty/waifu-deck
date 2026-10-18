import type { ImageCandidate, ImageProviderKey } from '@/features/waifu/types';

import { dedupeByCandidateIdentity, dedupeImageCandidates } from './candidate-dedupe';

function candidate(
  providerKey: ImageProviderKey,
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): ImageCandidate {
  return {
    providerKey,
    providerItemId,
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${providerKey}/${providerItemId}.jpg`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 768,
    height: 1152,
    byteSize: 100,
    extension: '.jpg',
    dominantColor: '#abcdef',
    isNsfw: false,
    isAnimated: false,
    tags: [],
    ...overrides,
  };
}

describe('dedupeImageCandidates md5 identity token', () => {
  test('two candidates sharing only an md5 cluster together and merge the stronger rating', () => {
    const safe = candidate('waifu_im', '1', {
      md5: '0123456789abcdef0123456789abcdef',
      contentRating: 'safe',
    });
    const explicit = candidate('danbooru', '2', {
      md5: '0123456789abcdef0123456789abcdef',
      contentRating: 'explicit',
      isNsfw: true,
    });

    const result = dedupeImageCandidates([safe, explicit]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      providerKey: 'waifu_im',
      providerItemId: '1',
      contentRating: 'explicit',
      isNsfw: true,
    });
  });

  test('differing md5 values alone do not cluster candidates', () => {
    const first = candidate('waifu_im', '1', {
      md5: '0123456789abcdef0123456789abcdef',
    });
    const second = candidate('danbooru', '2', {
      md5: 'fedcba9876543210fedcba9876543210',
    });

    const result = dedupeImageCandidates([first, second]);

    expect(result).toHaveLength(2);
  });

  test('a null md5 contributes no identity token, so it never clusters with a set md5', () => {
    const withMd5 = candidate('waifu_im', '1', {
      md5: '0123456789abcdef0123456789abcdef',
    });
    const withoutMd5 = candidate('danbooru', '2', { md5: null });

    const result = dedupeImageCandidates([withMd5, withoutMd5]);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.md5)).toEqual([
      '0123456789abcdef0123456789abcdef',
      null,
    ]);
  });
});

describe('dedupeByCandidateIdentity pinned clusters', () => {
  test('a value matching two pinned clusters folds into the first and removes neither', () => {
    const first = candidate('safebooru', 'first', {
      md5: 'm-a',
      contentRating: 'safe',
      isNsfw: false,
    });
    const second = candidate('danbooru', 'second', {
      canonicalSourceKey: 'pixiv:99',
      contentRating: 'safe',
      isNsfw: false,
    });
    const bridge = candidate('gelbooru', 'bridge', {
      md5: 'm-a',
      canonicalSourceKey: 'pixiv:99',
      contentRating: 'explicit',
      isNsfw: true,
    });
    const pinned = new Set(['safebooru:first', 'danbooru:second']);

    const result = dedupeByCandidateIdentity(
      [first, second, bridge],
      (value) => value,
      (_value, image) => image,
      [],
      (value) => pinned.has(`${value.providerKey}:${value.providerItemId}`),
    );

    expect(result.map((value) => `${value.providerKey}:${value.providerItemId}`)).toEqual([
      'safebooru:first',
      'danbooru:second',
    ]);
    expect(result[0]).toMatchObject({ contentRating: 'explicit', isNsfw: true });
    expect(result[1]).toMatchObject({ contentRating: 'explicit', isNsfw: true });
  });

  test('a pinned value that matches an earlier pinned value keeps its own place', () => {
    const first = candidate('safebooru', 'first', {
      md5: 'same',
      contentRating: 'safe',
      isNsfw: false,
    });
    const incoming = candidate('gelbooru', 'incoming', {
      md5: 'same',
      contentRating: 'explicit',
      isNsfw: true,
      width: 2000,
      height: 2000,
    });

    const result = dedupeByCandidateIdentity(
      [first, incoming],
      (value) => value,
      (_value, image) => image,
      [],
      () => true,
    );

    expect(result.map((value) => `${value.providerKey}:${value.providerItemId}`)).toEqual([
      'safebooru:first',
      'gelbooru:incoming',
    ]);
    expect(result[0]).toMatchObject({ contentRating: 'explicit', isNsfw: true });
    expect(result[1]).toBe(incoming);
  });

  test('without isPinned a bridging value still merges both clusters', () => {
    const first = candidate('safebooru', 'first', { md5: 'm-a' });
    const second = candidate('danbooru', 'second', { canonicalSourceKey: 'pixiv:99' });
    const bridge = candidate('gelbooru', 'bridge', {
      md5: 'm-a',
      canonicalSourceKey: 'pixiv:99',
    });

    const result = dedupeByCandidateIdentity(
      [first, second, bridge],
      (value) => value,
      (_value, image) => image,
    );

    expect(result).toHaveLength(1);
  });
});

describe('dedupeByCandidateIdentity survivor comparator (§3.3)', () => {
  const ORDER: readonly ImageProviderKey[] = [
    'waifu_im', 'nekos_api', 'danbooru', 'safebooru', 'yandere', 'konachan', 'e621', 'e926',
  ];

  test('tier 1: larger width*height survives, regardless of input order', () => {
    const small = candidate('danbooru', 'd1', { md5: 'aaaa', width: 400, height: 400 });
    const large = candidate('e621', 'e1', { md5: 'aaaa', width: 1200, height: 1600 });
    const forward = dedupeImageCandidates([small, large], ORDER);
    const backward = dedupeImageCandidates([large, small], ORDER);
    expect(forward).toHaveLength(1);
    expect(forward[0]!.providerItemId).toBe('e1');
    expect(backward[0]!.providerItemId).toBe('e1'); // order-independent
  });

  test('tier 2: equal area -> the copy with md5 survives', () => {
    const noMd5 = candidate('danbooru', 'd2', { perceptualHash: 'p', width: 500, height: 500 });
    const withMd5 = candidate('e621', 'e2', { perceptualHash: 'p', md5: 'zzzz', width: 500, height: 500 });
    const result = dedupeImageCandidates([noMd5, withMd5], ORDER);
    expect(result).toHaveLength(1);
    expect(result[0]!.providerItemId).toBe('e2');
  });

  test('tier 3: equal area + both md5 -> the copy with artistName survives', () => {
    const noArtist = candidate('danbooru', 'd3', { md5: 'mmmm', width: 500, height: 500 });
    const withArtist = candidate('e621', 'e3', { md5: 'mmmm', width: 500, height: 500, artistName: 'foo' });
    const result = dedupeImageCandidates([noArtist, withArtist], ORDER);
    expect(result[0]!.providerItemId).toBe('e3');
  });

  test('tier 4: all equal -> lower provider-order index survives', () => {
    const late = candidate('e621', 'e4', { md5: 'qqqq', width: 500, height: 500 });
    const early = candidate('waifu_im', 'w4', { md5: 'qqqq', width: 500, height: 500 });
    const forward = dedupeImageCandidates([late, early], ORDER);
    const backward = dedupeImageCandidates([early, late], ORDER);
    expect(forward[0]!.providerKey).toBe('waifu_im');
    expect(backward[0]!.providerKey).toBe('waifu_im');
  });

  test('rating never weakens: an explicit small copy lifts the larger safe survivor to nsfw', () => {
    const largeSafe = candidate('waifu_im', 'w5', {
      md5: 'rrrr', width: 2000, height: 2000, contentRating: 'safe', isNsfw: false,
    });
    const smallExplicit = candidate('e621', 'e5', {
      md5: 'rrrr', width: 100, height: 100, contentRating: 'explicit', isNsfw: true,
    });
    const result = dedupeImageCandidates([largeSafe, smallExplicit], ORDER);
    expect(result).toHaveLength(1);
    expect(result[0]!.providerItemId).toBe('w5'); // larger survived
    expect(result[0]!.isNsfw).toBe(true);          // but rating merged up
    expect(result[0]!.contentRating).toBe('explicit');
  });

  test('deterministic across 100 shuffles of a mixed cluster', () => {
    const members = [
      candidate('danbooru', 'a', { md5: 'xxxx', width: 800, height: 600 }),
      candidate('e621', 'b', { md5: 'xxxx', width: 1600, height: 1200 }),
      candidate('yandere', 'c', { md5: 'xxxx', width: 400, height: 400 }),
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const shuffled = [...members].sort(() => (i % 3) - 1);
      const result = dedupeImageCandidates(shuffled, ORDER);
      expect(result).toHaveLength(1);
      seen.add(result[0]!.providerItemId);
    }
    expect([...seen]).toEqual(['b']); // largest area, every time
  });

  test('dedupeByCandidateIdentity threads order through the generic wrapper form', () => {
    type Wrapped = { tag: string; image: ImageCandidate };
    const small: Wrapped = { tag: 'small', image: candidate('danbooru', 'd6', { md5: 'yyyy', width: 300, height: 300 }) };
    const large: Wrapped = { tag: 'large', image: candidate('e621', 'e6', { md5: 'yyyy', width: 900, height: 900 }) };
    const result = dedupeByCandidateIdentity(
      [small, large],
      (w) => w.image,
      (w, image) => image === w.image ? w : { ...w, image },
      ORDER,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.tag).toBe('large');
  });
});
