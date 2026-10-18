import { STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import type { StoredImage } from '@/features/images/image-repository';
import type { SearchHit } from '@/features/search/types';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';

import {
  buildSavedIdentityIndex,
  buildSearchRequest,
  isSearchHitSaved,
  parseSearchTags,
  resolveSearchInput,
} from './search-screen-model';

/**
 * K7 cut 5b (audit ㉙) oracle: the pre-index implementation, kept verbatim.
 * The Set-based lookup must agree with it on every input, not merely look
 * plausible.
 */
function isSearchHitSavedOracle(
  hit: SearchHit,
  collection: readonly StoredImage[],
): boolean {
  const candidate = hit.image;
  return collection.some((saved) =>
    (saved.providerKey === candidate.providerKey &&
      saved.providerItemId === candidate.providerItemId) ||
    (candidate.canonicalSourceKey !== null &&
      saved.canonicalSourceKey === candidate.canonicalSourceKey) ||
    (candidate.perceptualHash !== null &&
      saved.perceptualHash === candidate.perceptualHash),
  );
}

/**
 * An array that counts every element read, so a lookup that walks the
 * collection is impossible to hide behind a passing assertion.
 */
function countingCollection(rows: readonly StoredImage[]): {
  collection: StoredImage[];
  reads: () => number;
} {
  let reads = 0;
  const collection: StoredImage[] = new Array(rows.length);
  rows.forEach((row, index) => {
    Object.defineProperty(collection, index, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return row;
      },
    });
  });
  return { collection, reads: () => reads };
}

function hit(overrides: Partial<SearchHit['image']> = {}): SearchHit {
  return {
    key: 'danbooru:42',
    previewUrl: 'https://cdn.example/preview.jpg',
    image: {
      providerKey: 'danbooru',
      providerItemId: '42',
      canonicalSourceKey: 'pixiv:100',
      perceptualHash: 'hash-100',
      md5: null,
      remoteUrl: 'https://cdn.example/original.jpg',
      sourceUrl: 'https://example.test/posts/42',
      artistName: null,
      artistUrl: null,
      width: 1200,
      height: 1800,
      byteSize: 500_000,
      extension: 'jpg',
      dominantColor: '#101010',
      isNsfw: false,
      isAnimated: false,
      tags: ['raiden_shogun'],
      ...overrides,
    },
  };
}

function saved(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 7,
    ...hit().image,
    contentRating: 'safe',
    nativeRating: null,
    decision: 'saved',
    queueOrdinal: 1,
    presentedAt: 1,
    decidedAt: 2,
    decisionOrdinal: 1,
    localUri: 'file:///saved.jpg',
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

test('preserves the whole query including provider-owned commas and whitespace', () => {
  expect(parseSearchTags(' id:1,2 ~maid ~solo  -blue_hair ')).toEqual([
    'id:1,2 ~maid ~solo  -blue_hair',
  ]);
  expect(parseSearchTags('猫，犬')).toEqual(['猫，犬']);
});

test('builds a raw provider request without inheriting home exclusions', () => {
  const request = buildSearchRequest('Raiden Shogun, solo', {
    ...DEFAULT_SETTINGS,
    excludedTags: ['loli'],
    orientation: 'portrait',
    minWidth: 1080,
  });

  // R8.15: the discovery orientation filter must NOT leak into search.
  // Konachan is a landscape-heavy wallpaper source; a portrait default
  // silently zeroed every Konachan search result. Search always requests
  // 'any' orientation — the deck filter is a home-feed preference, and the
  // search surface exposes no orientation control to override it with.
  expect(request).toEqual({
    tags: ['Raiden Shogun, solo'],
    excludedTags: [],
    nsfwMode: DEFAULT_SETTINGS.nsfwMode,
    orientation: 'any',
    animationMode: DEFAULT_SETTINGS.animationMode,
    minWidth: 1080,
    maxBytes: DEFAULT_SETTINGS.maxBytes,
  });
  expect(buildSearchRequest(' \n ', DEFAULT_SETTINGS)).toBeNull();
});

test('passes Chinese, unknown, and provider-native terms through unchanged', () => {
  expect(resolveSearchInput('雷电将军，制服')).toEqual({
    kind: 'ready',
    tags: ['雷电将军，制服'],
  });
  expect(resolveSearchInput('米法')).toEqual({
    kind: 'ready',
    tags: ['米法'],
  });
  expect(resolveSearchInput('character:foo, -bar, furry')).toEqual({
    kind: 'ready',
    tags: ['character:foo, -bar, furry'],
  });
  expect(buildSearchRequest('米法', DEFAULT_SETTINGS)).toEqual(
    expect.objectContaining({ tags: ['米法'], excludedTags: [] }),
  );
});

test('builds only SFW search requests for the Store distribution', () => {
  expect(buildSearchRequest('maid', {
    ...DEFAULT_SETTINGS,
    nsfwMode: 'nsfw',
    nsfwConfirmed: true,
  }, STORE_DISTRIBUTION_POLICY)).toMatchObject({ nsfwMode: 'sfw' });
});

test.each([
  ['provider identity', { providerItemId: '42' }, {}],
  ['canonical source', { providerItemId: 'different' }, { providerItemId: 'saved' }],
  [
    'perceptual hash',
    { providerItemId: 'different', canonicalSourceKey: null },
    { providerItemId: 'saved', canonicalSourceKey: null },
  ],
])('recognizes an already saved hit by %s', (_label, hitOverrides, savedOverrides) => {
  const collection = [saved(savedOverrides)];
  expect(isSearchHitSaved(hit(hitOverrides), buildSavedIdentityIndex(collection)))
    .toBe(true);
  expect(isSearchHitSavedOracle(hit(hitOverrides), collection)).toBe(true);
});

test('does not match absent cross-provider identities', () => {
  const collection = [saved({ providerItemId: 'old' })];
  const orphan = hit({
    providerItemId: 'new',
    canonicalSourceKey: null,
    perceptualHash: null,
  });
  expect(isSearchHitSaved(orphan, buildSavedIdentityIndex(collection))).toBe(false);
  expect(isSearchHitSavedOracle(orphan, collection)).toBe(false);
});

test('K7 ㉙: 100 hits against 1000 saved rows walk the collection exactly once', () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => saved({
    id: index,
    providerKey: index % 2 === 0 ? 'danbooru' : 'gelbooru',
    providerItemId: `item-${index}`,
    canonicalSourceKey: index % 3 === 0 ? `pixiv:${index}` : null,
    perceptualHash: index % 5 === 0 ? `hash-${index}` : null,
  }));
  const hits = Array.from({ length: 100 }, (_, index) => hit({
    providerKey: index % 2 === 0 ? 'danbooru' : 'gelbooru',
    // A third of the hits are saved under each identity rule; the rest miss.
    providerItemId: index % 4 === 0 ? `item-${index * 7}` : `absent-${index}`,
    canonicalSourceKey: index % 4 === 1 ? `pixiv:${index * 3}` : null,
    perceptualHash: index % 4 === 2 ? `hash-${index * 5}` : null,
  }));
  const { collection, reads } = countingCollection(rows);

  const index = buildSavedIdentityIndex(collection);
  const readsAfterIndex = reads();
  const fast = hits.map((candidate) => isSearchHitSaved(candidate, index));

  // The index pass is the only walk; 100 lookups add nothing.
  expect(readsAfterIndex).toBe(rows.length);
  expect(reads()).toBe(rows.length);
  // Byte-identical to the implementation it replaces, including the misses.
  expect(fast).toEqual(hits.map((candidate) => isSearchHitSavedOracle(candidate, rows)));
  expect(fast).toContain(true);
  expect(fast).toContain(false);
});

test('K7 ㉙: a null identity on a saved row never matches a null on a hit', () => {
  // `null === null` is true; a Set must not turn "neither has a canonical
  // source key" into a match the `.some()` chain explicitly refused.
  const rows = [saved({
    providerItemId: 'other',
    canonicalSourceKey: null,
    perceptualHash: null,
  })];
  const candidate = hit({
    providerItemId: 'mine',
    canonicalSourceKey: null,
    perceptualHash: null,
  });
  expect(isSearchHitSaved(candidate, buildSavedIdentityIndex(rows))).toBe(false);
  expect(isSearchHitSavedOracle(candidate, rows)).toBe(false);
});

test('K7 ㉙: the same item id under a different provider is not the same image', () => {
  // The chain this replaces required providerKey AND providerItemId together;
  // a single-keyed Set would badge every gelbooru post whose numeric id a
  // danbooru post happens to share.
  const rows = [saved({
    providerKey: 'danbooru',
    providerItemId: '42',
    canonicalSourceKey: null,
    perceptualHash: null,
  })];
  const candidate = hit({
    providerKey: 'gelbooru',
    providerItemId: '42',
    canonicalSourceKey: null,
    perceptualHash: null,
  });
  expect(isSearchHitSaved(candidate, buildSavedIdentityIndex(rows))).toBe(false);
  expect(isSearchHitSavedOracle(candidate, rows)).toBe(false);
});

test('K7 ㉙: an empty collection is an empty index', () => {
  expect(isSearchHitSaved(hit(), buildSavedIdentityIndex([]))).toBe(false);
  expect(isSearchHitSavedOracle(hit(), [])).toBe(false);
});
