import { STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';

import {
  DEFAULT_SETTINGS,
  isBlockableTagSlug,
  normalizeSettings,
  setProviderEnabled,
  settingsAffectDiscovery,
} from './settings';

test('defaults to safe content', () => {
  expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  expect(DEFAULT_SETTINGS.nsfwMode).toBe('sfw');
  expect(DEFAULT_SETTINGS.stylePreference).toBe('any');
  expect(DEFAULT_SETTINGS.providers).toEqual({
    waifu_im: true,
    nekos_api: true,
    danbooru: true,
    safebooru: true,
    yandere: true,
    konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
  });
});

test.each([
  ['any', 'any'],
  ['prefer-3d', 'prefer-3d'],
  ['prefer-2d', 'prefer-2d'],
  ['invalid', 'any'],
] as const)('normalizes style preference %s', (value, expected) => {
  expect(normalizeSettings({ stylePreference: value }).stylePreference).toBe(expected);
});

test('migrates old settings to all providers and repairs an all-disabled value', () => {
  expect(normalizeSettings({ version: 1 })).toMatchObject({
    version: 5,
    providers: { waifu_im: true, nekos_api: true, danbooru: true, safebooru: true, yandere: true, konachan: true, e621: true, e926: true },
  });
  expect(normalizeSettings({
    providers: { waifu_im: false, nekos_api: false, danbooru: false, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false },
  }).providers).toEqual({
    waifu_im: true,
    nekos_api: false,
    danbooru: false,
    safebooru: false,
    yandere: false,
    konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
  });
});

test('drops the removed taste personalization fields on normalize', () => {
  // R-taste removal: the swipe "taste" personalization is gone, so its two
  // persisted controls no longer exist. normalizeSettings must not resurrect
  // them from stored blobs, and neither the defaults nor the discovery
  // identity may carry them.
  const normalized = normalizeSettings({
    personalizedDiscovery: false,
    tasteResetAt: 1234,
  });
  expect('personalizedDiscovery' in normalized).toBe(false);
  expect('tasteResetAt' in normalized).toBe(false);
  expect('personalizedDiscovery' in DEFAULT_SETTINGS).toBe(false);
  expect('tasteResetAt' in DEFAULT_SETTINGS).toBe(false);
  // Toggling either legacy field must not register as a discovery change,
  // because discovery no longer reads them.
  expect(settingsAffectDiscovery(DEFAULT_SETTINGS, {
    ...DEFAULT_SETTINGS,
    personalizedDiscovery: false,
    tasteResetAt: 999,
  } as typeof DEFAULT_SETTINGS)).toBe(false);
});

test('drops the removed preloadCount field on normalize (legacy pre-R8.20 rows)', () => {
  // The UI-less preloadCount field (3/5/8/12) was deleted; the first-paint batch
  // is now a constant. A device upgrading from a pre-R8.20 build has a stored
  // row carrying preloadCount — normalizeSettings must ignore it cleanly, never
  // resurrect it, and the discovery identity must not carry it.
  const normalized = normalizeSettings({ preloadCount: 12 });
  expect('preloadCount' in normalized).toBe(false);
  expect('preloadCount' in DEFAULT_SETTINGS).toBe(false);
  // A stale preloadCount must not read as a discovery change (it is gone from
  // discoverySettingsIdentity).
  expect(settingsAffectDiscovery(DEFAULT_SETTINGS, {
    ...DEFAULT_SETTINGS,
    preloadCount: 12,
  } as typeof DEFAULT_SETTINGS)).toBe(false);
});

test('preserves an explicit Waifu disable while another provider remains enabled', () => {
  expect(normalizeSettings({
    providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false },
  }).providers).toEqual({
    waifu_im: false,
    nekos_api: true,
    danbooru: true,
    safebooru: false,
    yandere: false,
    konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
  });
});

test('does not disable the last enabled provider', () => {
  const providers = {
    waifu_im: false,
    nekos_api: true,
    danbooru: false,
    safebooru: false,
    yandere: false,
    konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
  };

  expect(setProviderEnabled(providers, 'nekos_api', false)).toEqual(providers);
  expect(setProviderEnabled(providers, 'danbooru', true)).toEqual({
    waifu_im: false,
    nekos_api: true,
    danbooru: true,
    safebooru: false,
    yandere: false,
    konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
  });
});

test('repairs invalid or unconfirmed fields independently', () => {
  expect(
    normalizeSettings({
      nsfwMode: 'mixed',
      minWidth: 1080,
    }),
  ).toMatchObject({
    nsfwMode: 'sfw',
    nsfwConfirmed: false,
    minWidth: 1080,
  });
});

test.each([
  ['mixed', false],
  ['nsfw', undefined],
  ['mixed', 'yes'],
] as const)('downgrades unconfirmed adult mode %s with confirmation %p', (
  nsfwMode,
  nsfwConfirmed,
) => {
  expect(normalizeSettings({ nsfwMode, nsfwConfirmed })).toMatchObject({
    nsfwMode: 'sfw',
    nsfwConfirmed: false,
  });
});

test.each(['mixed', 'nsfw'] as const)('preserves confirmed adult mode %s', (nsfwMode) => {
  expect(normalizeSettings({ nsfwMode, nsfwConfirmed: true })).toMatchObject({
    nsfwMode,
    nsfwConfirmed: true,
  });
});

test('forces confirmed adult preferences back to SFW for the Store distribution', () => {
  expect(normalizeSettings({
    nsfwMode: 'nsfw',
    nsfwConfirmed: true,
    blurNsfwThumbnails: false,
  }, STORE_DISTRIBUTION_POLICY)).toMatchObject({
    nsfwMode: 'sfw',
    nsfwConfirmed: false,
    blurNsfwThumbnails: true,
  });
});

test('normalizes tags without letting editable arrays override waifu', () => {
  expect(
    normalizeSettings({
      includedTags: ['Maid', 'maid', 'waifu', 'blue_hair'],
      excludedTags: ['maid', 'Waifu', 'gore', 'gore'],
    }),
  ).toMatchObject({
    includedTags: ['waifu', 'maid', 'blue_hair'],
    excludedTags: ['gore'],
  });
});

test('does not treat language or thumbnail blur as discovery changes', () => {
  expect(settingsAffectDiscovery(DEFAULT_SETTINGS, {
    ...DEFAULT_SETTINGS,
    language: 'ja',
    blurNsfwThumbnails: false,
  })).toBe(false);
});

test('detects settings that change discovery candidates or ordering', () => {
  expect(settingsAffectDiscovery(DEFAULT_SETTINGS, {
    ...DEFAULT_SETTINGS,
    orientation: 'landscape',
  })).toBe(true);
  expect(settingsAffectDiscovery(DEFAULT_SETTINGS, {
    ...DEFAULT_SETTINGS,
    stylePreference: 'prefer-3d',
  })).toBe(true);
});

test('R8.20: prefetchDepth defaults to 40 cards ahead and repairs invalid values', () => {
  // Owner 2026-09-09: the visible "预加载数量" control must offer at least
  // 30–40 cards, not 3–12. prefetchDepth drives the image prefetch window and
  // the DB reserve; the internal first-paint batch is unchanged.
  expect(DEFAULT_SETTINGS.prefetchDepth).toBe(40);
  expect(normalizeSettings({ prefetchDepth: 60 }).prefetchDepth).toBe(60);
  expect(normalizeSettings({ prefetchDepth: 30 }).prefetchDepth).toBe(30);
  // A pre-R8.20 persisted settings object (no field) or a junk value → default.
  expect(normalizeSettings({}).prefetchDepth).toBe(40);
  expect(normalizeSettings({ prefetchDepth: 12 }).prefetchDepth).toBe(40);
});

test('R8.22: isBlockableTagSlug accepts a normalized slug but never the fixed waifu base tag', () => {
  // Any normalized slug is blockable...
  expect(isBlockableTagSlug('furry')).toBe(true);
  // ...except the one tag waifu.im requires on every request, which must
  // never be blockable no matter how the slug regex evolves.
  expect(isBlockableTagSlug('waifu')).toBe(false);
  // Not a normalized slug (space, punctuation) → not blockable.
  expect(isBlockableTagSlug('bad tag!!')).toBe(false);
  // Empty string → not blockable.
  expect(isBlockableTagSlug('')).toBe(false);
});
