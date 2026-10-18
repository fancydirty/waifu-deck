import type { ImageCandidate, ImageProviderKey } from '@/features/waifu/types';

import { dedupeByCandidateIdentity } from '@/features/providers/candidate-dedupe';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';

import { toSearchHit } from './search-hit';
import {
  aggregateSearchCursor,
  interleaveProviderSearchHits,
  mergeProviderSearchStates,
  reconcileStableSearchHits,
} from './search-merge';
import type {
  ProviderCursor,
  ProviderSearchFailure,
  ProviderSearchState,
  SearchCursor,
  SearchHit,
} from './types';

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
    tags: [],
    ...overrides,
  };
}

function hit(
  providerKey: ImageProviderKey,
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): SearchHit {
  return toSearchHit(candidate(providerKey, providerItemId, overrides));
}

function okWaifu(
  items: SearchHit[],
  nextCursor: ProviderCursor['waifu_im'] | null,
  total?: number,
): ProviderSearchState {
  return { status: 'ok', page: { providerKey: 'waifu_im', items, nextCursor, total } };
}

function okNekos(
  items: SearchHit[],
  nextCursor: ProviderCursor['nekos_api'] | null,
): ProviderSearchState {
  return { status: 'ok', page: { providerKey: 'nekos_api', items, nextCursor } };
}

function okDanbooru(
  items: SearchHit[],
  nextCursor: ProviderCursor['danbooru'] | null,
): ProviderSearchState {
  return { status: 'ok', page: { providerKey: 'danbooru', items, nextCursor } };
}

function failed(
  providerKey: ImageProviderKey,
  code = 'network',
): ProviderSearchState {
  return {
    status: 'failed',
    failure: { providerKey, code },
  };
}

const keys = (page: { hits: SearchHit[] }) => page.hits.map((h) => h.key);

// §3.4 reduced `mergeProviderSearchStates` to a failures-only aggregator; the
// hits/cursor folding now lives in the hook, which composes these three directly.
// This helper mirrors that composition so the round-robin + dedupe + cursor
// coverage below is preserved without a second merge implementation.
function mergePage(
  previousCursor: SearchCursor,
  states: readonly ProviderSearchState[],
): { hits: SearchHit[]; cursor: SearchCursor; failures: ProviderSearchFailure[] } {
  const hits = dedupeByCandidateIdentity(
    interleaveProviderSearchHits(states),
    (hit) => hit.image,
    (hit, image) => image === hit.image ? hit : { ...hit, image },
    PROVIDER_REGISTRY.map((adapter) => adapter.key),
  );
  return {
    hits,
    cursor: aggregateSearchCursor(previousCursor, states),
    failures: mergeProviderSearchStates(states).failures,
  };
}

describe('search page composition (interleave + dedupe + cursor)', () => {
  test('interleaves successful pages round-robin across sources', () => {
    const result = mergePage({}, [
      okWaifu([hit('waifu_im', '1'), hit('waifu_im', '2')], { page: 2 }, 100),
      okNekos([hit('nekos_api', 'a'), hit('nekos_api', 'b')], { offset: 2 }),
      okDanbooru([hit('danbooru', 'd')], null),
    ]);

    expect(keys(result)).toEqual([
      'waifu_im:1',
      'nekos_api:a',
      'danbooru:d',
      'waifu_im:2',
      'nekos_api:b',
    ]);
    expect(result.failures).toEqual([]);
  });

  test('dedupes by provider identity, canonical source, and perceptual hash', () => {
    const result = mergePage({}, [
      okWaifu(
        [
          hit('waifu_im', '1', { canonicalSourceKey: 'pixiv:7' }),
          hit('waifu_im', '2', { perceptualHash: 'abc' }),
        ],
        null,
      ),
      okNekos(
        [
          hit('nekos_api', 'a', { canonicalSourceKey: 'pixiv:7' }), // dup source
          hit('nekos_api', 'b', { perceptualHash: 'abc' }), // dup hash
          hit('waifu_im', '1'), // dup provider identity
          hit('nekos_api', 'c'), // unique
        ],
        null,
      ),
    ]);

    // waifu_im (index 0) wins the tie-break over nekos_api for the shared-source
    // and shared-hash clusters (equal size, no md5/artist → lower registry index).
    expect(keys(result)).toEqual(['waifu_im:1', 'waifu_im:2', 'nekos_api:c']);
  });

  test('keeps the stricter content rating when equivalent hits disagree', () => {
    const result = mergePage({}, [
      okWaifu([hit('waifu_im', '1', {
        canonicalSourceKey: 'pixiv:rating-conflict',
        contentRating: 'safe',
      })], null),
      okNekos([hit('nekos_api', 'a', {
        canonicalSourceKey: 'pixiv:rating-conflict',
        contentRating: 'explicit',
        nativeRating: 'explicit',
        isNsfw: true,
      })], null),
    ]);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.image).toMatchObject({
      providerKey: 'waifu_im',
      contentRating: 'explicit',
      isNsfw: true,
    });
  });

  test('propagates every key of a duplicate so transitive collisions are removed', () => {
    // A shares its source with B; B shares its hash with C. All three are the
    // same image, so only A must survive — even though C collides with B, not A.
    const a = hit('waifu_im', '1', { canonicalSourceKey: 'pixiv:7' });
    const b = hit('waifu_im', '2', {
      canonicalSourceKey: 'pixiv:7',
      perceptualHash: 'hhh',
    });
    const c = hit('waifu_im', '3', { perceptualHash: 'hhh' });

    const result = mergePage({}, [okWaifu([a, b, c], null)]);

    expect(keys(result)).toEqual(['waifu_im:1']);
  });

  test('returns the complete fair page before advancing provider cursors', () => {
    const result = mergePage({}, [
      okWaifu(
        [hit('waifu_im', '1'), hit('waifu_im', '2')],
        { page: 3 },
      ),
      okNekos(
        [hit('nekos_api', 'a'), hit('nekos_api', 'b')],
        { offset: 40 },
      ),
    ]);

    expect(keys(result)).toEqual([
      'waifu_im:1',
      'nekos_api:a',
      'waifu_im:2',
      'nekos_api:b',
    ]);
    expect(result.cursor).toEqual({
      waifu_im: { page: 3 },
      nekos_api: { offset: 40 },
    });
  });

  test('preserves each hit key and preview url through the merge', () => {
    const image = candidate('nekos_api', 'a', {
      remoteUrl: 'https://cdn.example.com/preview/a.webp',
    });

    const result = mergePage({}, [
      okNekos([toSearchHit(image)], { offset: 1 }),
    ]);

    expect(result.hits[0]).toEqual({
      key: 'nekos_api:a',
      previewUrl: 'https://cdn.example.com/preview/a.webp',
      image,
    });
  });

  test('advances ok cursors, retains failed positions, and marks exhausted null', () => {
    const previous: SearchCursor = {
      waifu_im: { page: 1 },
      nekos_api: { offset: 20 },
    };

    const result = mergePage(previous, [
      okWaifu([hit('waifu_im', '9')], { page: 2 }),
      failed('nekos_api'),
      okDanbooru([hit('danbooru', 'd')], null),
    ]);

    expect(result.cursor).toEqual({
      waifu_im: { page: 2 },
      nekos_api: { offset: 20 },
      danbooru: null,
    });
  });
});

describe('mergeProviderSearchStates (failures aggregator only — §3.4)', () => {
  test('collects failures across providers and ignores successful pages', () => {
    const result = mergeProviderSearchStates([
      okDanbooru([hit('danbooru', 'd')], null),
      failed('e621', 'network'),
    ]);
    expect(result).toEqual({
      failures: [{ providerKey: 'e621', code: 'network' }],
    });
  });

  test('returns no failures when every provider is ok', () => {
    expect(mergeProviderSearchStates([okDanbooru([hit('danbooru', 'd')], null)]))
      .toEqual({ failures: [] });
  });

  test('keeps healthy providers out of the failure list', () => {
    const result = mergeProviderSearchStates([
      failed('waifu_im', 'rate_limited'),
      okNekos([hit('nekos_api', 'a')], { offset: 8 }),
    ]);
    expect(result.failures).toEqual([
      { providerKey: 'waifu_im', code: 'rate_limited' },
    ]);
  });
});

describe('aggregateSearchCursor', () => {
  test('keeps untouched providers and does not mutate the previous cursor', () => {
    const previous: SearchCursor = { danbooru: { beforeId: 500 } };

    const next = aggregateSearchCursor(previous, [okWaifu([], { page: 1 })]);

    expect(next).toEqual({ danbooru: { beforeId: 500 }, waifu_im: { page: 1 } });
    expect(previous).toEqual({ danbooru: { beforeId: 500 } });
  });
});

describe('reconcileStableSearchHits', () => {
  test('a seen hit the current results no longer hold keeps its index', () => {
    const first = hit('waifu_im', 'a');
    const missingSeen = hit('waifu_im', 'b');
    const third = hit('waifu_im', 'c');
    const unseen = hit('waifu_im', 'd');

    const result = reconcileStableSearchHits(
      [first, missingSeen, third, unseen],
      [first, third, unseen],
      3,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:a',
      'waifu_im:b',
      'waifu_im:c',
      'waifu_im:d',
    ]);
  });

  test('a seen hit that is back in the current results takes its current version in place', () => {
    const first = hit('waifu_im', 'a');
    const previousSeen = hit('waifu_im', 'b', {
      contentRating: 'safe',
      isNsfw: false,
    });
    const third = hit('waifu_im', 'c');
    const currentSeen = hit('waifu_im', 'b', {
      contentRating: 'explicit',
      isNsfw: true,
    });

    const result = reconcileStableSearchHits(
      [first, previousSeen, third],
      [first, currentSeen, third],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:a',
      'waifu_im:b',
      'waifu_im:c',
    ]);
    expect(result[1]).toBe(currentSeen);
    expect(result[1]).not.toBe(previousSeen);
  });

  test('a shown-but-unseen hit the current results no longer hold is dropped', () => {
    const first = hit('waifu_im', 'a');
    const second = hit('waifu_im', 'b');
    const missingUnseen = hit('waifu_im', 'c');
    const last = hit('waifu_im', 'd');

    const result = reconcileStableSearchHits(
      [first, second, missingUnseen, last],
      [first, second, last],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:a',
      'waifu_im:b',
      'waifu_im:d',
    ]);
  });

  test('a stale seen hit never appears twice when its key reappears below the seen line', () => {
    const first = hit('waifu_im', 'a');
    const seenAgain = hit('waifu_im', 'b');
    const later = hit('waifu_im', 'c');

    const result = reconcileStableSearchHits(
      [first, seenAgain],
      [first, later, seenAgain],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:a',
      'waifu_im:b',
      'waifu_im:c',
    ]);
  });

  test('a kept stale seen hit stays pinned against a later identity duplicate', () => {
    const first = hit('waifu_im', 'a');
    const staleSeen = hit('waifu_im', 'b', {
      md5: 'stale-alias',
      width: 768,
      height: 768,
      contentRating: 'safe',
      isNsfw: false,
    });
    const laterDuplicate = hit('gelbooru', 'new', {
      md5: 'stale-alias',
      width: 2048,
      height: 2048,
    });

    const result = reconcileStableSearchHits(
      [first, staleSeen],
      [first, laterDuplicate],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:a',
      'waifu_im:b',
    ]);
    expect(result[1]).toBe(staleSeen);
  });

  test('a late hit that matches two seen hits leaves both in place', () => {
    const safebooru = hit('safebooru', '1', { md5: 'm-a' });
    const danbooru = hit('danbooru', '2', { canonicalSourceKey: 'pixiv:99' });
    const e621 = hit('e621', '3');
    const rule34 = hit('rule34', '4');
    const lateDuplicate = hit('gelbooru', '9', {
      md5: 'm-a',
      canonicalSourceKey: 'pixiv:99',
    });
    const lateUnique = hit('gelbooru', '10');

    const result = reconcileStableSearchHits(
      [safebooru, danbooru, e621, rule34],
      [safebooru, danbooru, e621, rule34, lateDuplicate, lateUnique],
      4,
    );

    expect(result.map((item) => item.key)).toEqual([
      'safebooru:1',
      'danbooru:2',
      'e621:3',
      'rule34:4',
      'gelbooru:10',
    ]);
  });

  test('a late hit that bridges two seen hits raises both to its rating', () => {
    const first = hit('safebooru', 'safe', {
      md5: 'm-a',
      contentRating: 'safe',
      isNsfw: false,
    });
    const second = hit('danbooru', 'safe-2', {
      canonicalSourceKey: 'pixiv:99',
      contentRating: 'safe',
      isNsfw: false,
    });
    const bridge = hit('gelbooru', 'late', {
      md5: 'm-a',
      canonicalSourceKey: 'pixiv:99',
      contentRating: 'explicit',
      isNsfw: true,
    });

    const result = reconcileStableSearchHits(
      [first, second],
      [first, second, bridge],
      2,
    );

    expect(result.map((item) => item.key)).toEqual(['safebooru:safe', 'danbooru:safe-2']);
    expect(result[0]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
    expect(result[1]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
  });

  test('a bridge shares the strongest seen rating across the seen hits it joins', () => {
    const first = hit('safebooru', 'safe', {
      md5: 'm-a',
      contentRating: 'safe',
      isNsfw: false,
    });
    const second = hit('danbooru', 'explicit', {
      canonicalSourceKey: 'pixiv:99',
      contentRating: 'explicit',
      isNsfw: true,
    });
    const bridge = hit('gelbooru', 'late', {
      md5: 'm-a',
      canonicalSourceKey: 'pixiv:99',
      contentRating: 'safe',
      isNsfw: false,
    });

    const result = reconcileStableSearchHits(
      [first, second],
      [first, second, bridge],
      2,
    );

    expect(result.map((item) => item.key)).toEqual(['safebooru:safe', 'danbooru:explicit']);
    expect(result[0]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
    expect(result[1]).toBe(second);
  });

  test('two seen aliases share the stronger rating', () => {
    const first = hit('safebooru', 'seen-safe', {
      md5: 'shared-alias',
      contentRating: 'safe',
      isNsfw: false,
    });
    const second = hit('danbooru', 'seen-explicit', {
      md5: 'shared-alias',
      contentRating: 'explicit',
      isNsfw: true,
    });

    const result = reconcileStableSearchHits(
      [first, second],
      [first, second],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'safebooru:seen-safe',
      'danbooru:seen-explicit',
    ]);
    expect(result[0]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
    expect(result[1]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
  });

  test('two seen aliases share the stronger rating when the earlier alias is explicit', () => {
    const first = hit('safebooru', 'seen-explicit', {
      md5: 'shared-alias-reverse',
      contentRating: 'explicit',
      isNsfw: true,
    });
    const second = hit('danbooru', 'seen-safe', {
      md5: 'shared-alias-reverse',
      contentRating: 'safe',
      isNsfw: false,
    });

    const result = reconcileStableSearchHits(
      [first, second],
      [first, second],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'safebooru:seen-explicit',
      'danbooru:seen-safe',
    ]);
    expect(result[0]).toBe(first);
    expect(result[0]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
    expect(result[1]!.image).toMatchObject({ contentRating: 'explicit', isNsfw: true });
  });

  test('hits above the seen line keep their positions when a late source lands', () => {
    const w1 = hit('waifu_im', '1');
    const w2 = hit('waifu_im', '2');
    const w3 = hit('waifu_im', '3');
    const n1 = hit('nekos_api', 'a');
    const n2 = hit('nekos_api', 'b');
    const firstOrder = interleaveProviderSearchHits([
      okWaifu([w1, w2, w3], null),
    ]);
    const first = reconcileStableSearchHits([], firstOrder, 0);

    const completeOrder = interleaveProviderSearchHits([
      okWaifu([w1, w2, w3], null),
      okNekos([n1, n2], null),
    ]);
    const complete = reconcileStableSearchHits(first, completeOrder, 2);

    expect(first.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'waifu_im:2',
      'waifu_im:3',
    ]);
    expect(complete.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'waifu_im:2',
      'nekos_api:a',
      'waifu_im:3',
      'nekos_api:b',
    ]);
  });

  test("a late source's first hit lands within one round of the seen line", () => {
    const w1 = hit('waifu_im', '1');
    const w2 = hit('waifu_im', '2');
    const w3 = hit('waifu_im', '3');
    const w4 = hit('waifu_im', '4');
    const n1 = hit('nekos_api', 'a');
    const n2 = hit('nekos_api', 'b');
    const d1 = hit('danbooru', 'd');

    const result = reconcileStableSearchHits(
      [w1, w2, n1, n2, w3, w4],
      [w1, n1, d1, w2, n2, w3, w4],
      2,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'waifu_im:2',
      'nekos_api:a',
      'danbooru:d',
      'waifu_im:3',
      'nekos_api:b',
      'waifu_im:4',
    ]);
    expect(result.findIndex((item) => item.key === 'danbooru:d')).toBeLessThanOrEqual(2 + 3);
  });

  test('below the seen line sources alternate, fewest-seen first, ties in registry order', () => {
    const w1 = hit('waifu_im', '1');
    const w2 = hit('waifu_im', '2');
    const w3 = hit('waifu_im', '3');
    const w4 = hit('waifu_im', '4');
    const n1 = hit('nekos_api', 'a');
    const n2 = hit('nekos_api', 'b');
    const d1 = hit('danbooru', 'd1');
    const d2 = hit('danbooru', 'd2');

    const result = reconcileStableSearchHits(
      [w1, w2, n1],
      [w1, n1, d1, w2, n2, d2, w3, w4],
      3,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'waifu_im:2',
      'nekos_api:a',
      'danbooru:d1',
      'nekos_api:b',
      'waifu_im:3',
      'danbooru:d2',
      'waifu_im:4',
    ]);
  });

  test('a seen line of 0 gives the plain fair order', () => {
    const w1 = hit('waifu_im', '1');
    const w2 = hit('waifu_im', '2');
    const n1 = hit('nekos_api', 'a');
    const n2 = hit('nekos_api', 'b');
    const d1 = hit('danbooru', 'd');

    const result = reconcileStableSearchHits(
      [d1, w1, n1],
      [w1, n1, d1, w2, n2],
      0,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'nekos_api:a',
      'danbooru:d',
      'waifu_im:2',
      'nekos_api:b',
    ]);
  });

  test('a seen line past the end appends the new hits in fair order', () => {
    const w1 = hit('waifu_im', '1');
    const n1 = hit('nekos_api', 'a');
    const w2 = hit('waifu_im', '2');
    const n2 = hit('nekos_api', 'b');
    const d1 = hit('danbooru', 'd');

    const result = reconcileStableSearchHits(
      [w1, n1],
      [w1, n1, w2, n2, d1],
      99,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'nekos_api:a',
      'danbooru:d',
      'waifu_im:2',
      'nekos_api:b',
    ]);
  });

  test('a hit above the seen line keeps its identity when a later duplicate merges into it', () => {
    const visible = hit('waifu_im', 'visible', {
      canonicalSourceKey: 'pixiv:visible',
      width: 200,
      height: 200,
      contentRating: 'safe',
      isNsfw: false,
    });
    const largerDuplicate = hit('nekos_api', 'late', {
      canonicalSourceKey: 'pixiv:visible',
      width: 2000,
      height: 2000,
    });

    const result = reconcileStableSearchHits(
      [visible],
      [largerDuplicate, visible],
      1,
    );

    expect(result[0]).toBe(visible);
  });

  test('a duplicate below the seen line uses the quality survivor', () => {
    const visible = hit('waifu_im', 'visible', {
      canonicalSourceKey: 'pixiv:visible-below',
      contentRating: 'safe',
      isNsfw: false,
    });
    const below = hit('waifu_im', 'below', {
      canonicalSourceKey: 'pixiv:below',
      width: 200,
      height: 200,
      contentRating: 'safe',
      isNsfw: false,
    });
    const largerDuplicate = hit('nekos_api', 'late-below', {
      canonicalSourceKey: 'pixiv:below',
      width: 2000,
      height: 2000,
      contentRating: 'safe',
      isNsfw: false,
    });

    const result = reconcileStableSearchHits(
      [visible, below],
      [visible, below, largerDuplicate],
      1,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:visible',
      'nekos_api:late-below',
    ]);
  });

  test('keeps the first visible equivalent and propagates transitive duplicate keys', () => {
    const visible = hit('nekos_api', 'visible', {
      canonicalSourceKey: 'pixiv:7',
    });
    const bridge = hit('waifu_im', 'bridge', {
      canonicalSourceKey: 'pixiv:7',
      perceptualHash: 'hash-7',
    });
    const late = hit('danbooru', 'late', { perceptualHash: 'hash-7' });

    const result = reconcileStableSearchHits(
      [visible],
      [bridge, visible, late],
      1,
    );

    expect(result.map((item) => item.key)).toEqual(['nekos_api:visible']);
  });

  test('reuses an equivalent merged hit so React snapshots stay stable', () => {
    const safe = hit('waifu_im', '1', {
      canonicalSourceKey: 'pixiv:stable-rating',
      contentRating: 'safe',
    });
    const explicit = hit('nekos_api', 'a', {
      canonicalSourceKey: 'pixiv:stable-rating',
      contentRating: 'explicit',
      isNsfw: true,
    });
    const first = reconcileStableSearchHits([], [safe, explicit], 0);
    const second = reconcileStableSearchHits(first, [safe, explicit], 1);

    expect(second[0]).toBe(first[0]);
  });

  test('drops hits absent after refetch while retaining the remaining order', () => {
    const first = hit('waifu_im', '1');
    const removed = hit('nekos_api', 'gone');
    const last = hit('danbooru', '3');

    const result = reconcileStableSearchHits(
      [first, removed, last],
      [last, first],
      1,
    );

    expect(result.map((item) => item.key)).toEqual([
      'waifu_im:1',
      'danbooru:3',
    ]);
  });
});
