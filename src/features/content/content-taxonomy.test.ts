import {
  candidateContentRating,
  contentTagDefinition,
  danbooruContentRating,
  matchesContentMode,
  nekosContentRating,
  normalizeContentTag,
  providerTagFor,
  suggestContentTags,
  waifuContentRating,
  yandereContentRating,
} from './content-taxonomy';

test('normalizes Chinese aliases and provider spellings to canonical tags', () => {
  expect(normalizeContentTag('雷电将军')).toBe('raiden_shogun');
  expect(normalizeContentTag('School Uniform')).toBe('school_uniform');
  expect(contentTagDefinition('高达')?.slug).toBe('gundam');
});

test('maps canonical tags only to providers that can actually search them', () => {
  expect(providerTagFor('waifu_im', 'raiden_shogun')).toBe('raiden-shogun');
  expect(providerTagFor('nekos_api', 'school_uniform')).toBe('School Uniform');
  expect(providerTagFor('waifu_im', 'gundam')).toBeNull();
  expect(providerTagFor('danbooru', 'unknown_ascii_tag')).toBeNull();
});

test('suggests exact and prefix matches in a stable order', () => {
  expect(suggestContentTags('蓝').map((tag) => tag.slug)).toContain('blue_hair');
  expect(suggestContentTags('rai')[0]?.slug).toBe('raiden_shogun');
});

test('normalizes native provider ratings without guessing missing intensity', () => {
  expect(waifuContentRating(false)).toBe('safe');
  expect(waifuContentRating(true)).toBe('nsfw_unspecified');
  expect(nekosContentRating('borderline')).toBe('nsfw_unspecified');
  expect(nekosContentRating('explicit')).toBe('explicit');
  expect(nekosContentRating('safe', true)).toBe('nsfw_unspecified');
  expect(danbooruContentRating('s')).toBe('suggestive');
  expect(danbooruContentRating('q')).toBe('nsfw_unspecified');
  expect(danbooruContentRating('e')).toBe('explicit');
});

test('maps Yande.re native ratings without Danbooru suggestive semantics', () => {
  expect(yandereContentRating('s')).toBe('safe');
  expect(yandereContentRating('q')).toBe('nsfw_unspecified');
  expect(yandereContentRating('e')).toBe('explicit');
});

test('strict content modes use canonical rating boundaries', () => {
  expect(matchesContentMode('safe', 'sfw')).toBe(true);
  expect(matchesContentMode('suggestive', 'sfw')).toBe(false);
  expect(matchesContentMode('suggestive', 'mixed')).toBe(true);
  expect(matchesContentMode('suggestive', 'nsfw')).toBe(true);
  expect(matchesContentMode('nsfw_unspecified', 'nsfw')).toBe(true);
  expect(matchesContentMode('explicit', 'nsfw')).toBe(true);
  expect(matchesContentMode('unknown', 'nsfw')).toBe(false);
});

test('legacy candidates receive a conservative derived rating', () => {
  expect(candidateContentRating({ isNsfw: true, tags: ['ecchi'] }))
    .toBe('nsfw_unspecified');
  expect(candidateContentRating({ isNsfw: false, tags: [] })).toBe('safe');
});
