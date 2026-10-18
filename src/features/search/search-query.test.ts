import { normalizeSearchRequest, searchFilterIdentity } from './search-query';
import type { SearchRequest } from './types';

const BASE: SearchRequest = {
  tags: ['genshin_impact'],
  excludedTags: ['guro'],
  nsfwMode: 'sfw',
  orientation: 'portrait',
  animationMode: 'exclude',
  minWidth: 0,
  maxBytes: 0,
};

describe('normalizeSearchRequest', () => {
  test('preserves provider-owned spelling and only removes blanks and exact duplicates', () => {
    expect(
      normalizeSearchRequest({
        tags: ['Genshin Impact', 'raiden-shogun', 'genshin_impact', '   '],
        excludedTags: ['  Guro ', 'GORE'],
      }),
    ).toMatchObject({
      tags: ['Genshin Impact', 'raiden-shogun', 'genshin_impact'],
      excludedTags: ['Guro', 'GORE'],
    });
  });

  test('passes filter fields through and fills sensible defaults when omitted', () => {
    expect(normalizeSearchRequest({ tags: ['blue archive'] })).toEqual({
      tags: ['blue archive'],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'exclude',
      minWidth: 0,
      maxBytes: 0,
    });
    expect(
      normalizeSearchRequest({
        tags: [],
        nsfwMode: 'nsfw',
        orientation: 'landscape',
        animationMode: 'only',
        minWidth: 1080,
        maxBytes: 5_000_000,
      }),
    ).toMatchObject({
      nsfwMode: 'nsfw',
      orientation: 'landscape',
      animationMode: 'only',
      minWidth: 1080,
      maxBytes: 5_000_000,
    });
  });

  test('is idempotent', () => {
    const once = normalizeSearchRequest(BASE);
    expect(normalizeSearchRequest(once)).toEqual(once);
  });
});

describe('searchFilterIdentity', () => {
  test('keeps provider query spelling in the identity', () => {
    const a = searchFilterIdentity({
      ...BASE,
      tags: ['Raiden Shogun', 'Genshin-Impact'],
    });
    const b = searchFilterIdentity({
      ...BASE,
      tags: ['genshin_impact', 'raiden_shogun'],
    });
    expect(a).not.toBe(b);
  });

  test('changes when any result-set-defining field changes', () => {
    const base = searchFilterIdentity(BASE);
    const variants: Partial<SearchRequest>[] = [
      { tags: ['blue_archive'] },
      { excludedTags: [] },
      { nsfwMode: 'nsfw' },
      { orientation: 'landscape' },
      { animationMode: 'only' },
      { minWidth: 720 },
      { maxBytes: 2_000_000 },
    ];
    for (const variant of variants) {
      expect(searchFilterIdentity({ ...BASE, ...variant })).not.toBe(base);
    }
  });
});
