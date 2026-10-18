import type { AppSettings } from '@/features/waifu/types';

import {
  allowedNsfwMode,
  applyDistributionToSearchRequest,
  applyDistributionToSettings,
  DIRECT_DISTRIBUTION_POLICY,
  distributionPolicyFor,
  isImageAllowedByDistribution,
  sanitizeImageDatabaseForDistribution,
  STORE_DISTRIBUTION_POLICY,
} from './distribution-policy';

const adultSettings: AppSettings = {
  version: 5,
  language: 'system',
  providers: { waifu_im: true, nekos_api: true, danbooru: true, safebooru: true, yandere: true, konachan: true, e621: true, e926: true, gelbooru: false, rule34: false },
  nsfwMode: 'nsfw',
  nsfwConfirmed: true,
  includedTags: ['waifu'],
  excludedTags: [],
  orientation: 'portrait',
  animationMode: 'exclude',
  stylePreference: 'any',
  minWidth: 0,
  maxBytes: 0,
  prefetchDepth: 40,
  blurNsfwThumbnails: false,
};

test('fails closed to the Store policy for missing and unknown variants', () => {
  expect(distributionPolicyFor(undefined)).toBe(STORE_DISTRIBUTION_POLICY);
  expect(distributionPolicyFor('preview')).toBe(STORE_DISTRIBUTION_POLICY);
});

test('preserves adult settings only for the Direct distribution', () => {
  expect(applyDistributionToSettings(
    adultSettings,
    DIRECT_DISTRIBUTION_POLICY,
  )).toBe(adultSettings);

  expect(applyDistributionToSettings(
    adultSettings,
    STORE_DISTRIBUTION_POLICY,
  )).toEqual({
    ...adultSettings,
    nsfwMode: 'sfw',
    nsfwConfirmed: false,
    blurNsfwThumbnails: true,
  });
});

test('forces Store requests and image eligibility to SFW', () => {
  expect(allowedNsfwMode('mixed', STORE_DISTRIBUTION_POLICY)).toBe('sfw');
  expect(applyDistributionToSearchRequest(
    { tags: ['waifu'], nsfwMode: 'nsfw' as const },
    STORE_DISTRIBUTION_POLICY,
  )).toEqual({ tags: ['waifu'], nsfwMode: 'sfw' });
  expect(isImageAllowedByDistribution(
    { contentRating: 'explicit', isNsfw: true, tags: [] },
    STORE_DISTRIBUTION_POLICY,
  )).toBe(false);
  expect(isImageAllowedByDistribution(
    { contentRating: 'suggestive', isNsfw: false, tags: [] },
    STORE_DISTRIBUTION_POLICY,
  )).toBe(false);
  expect(isImageAllowedByDistribution(
    { contentRating: 'safe', isNsfw: false, tags: [] },
    STORE_DISTRIBUTION_POLICY,
  )).toBe(true);
  expect(isImageAllowedByDistribution(
    { contentRating: 'safe', isNsfw: true, tags: [] },
    STORE_DISTRIBUTION_POLICY,
  )).toBe(false);
  expect(isImageAllowedByDistribution(
    { contentRating: 'explicit', isNsfw: true, tags: [] },
    DIRECT_DISTRIBUTION_POLICY,
  )).toBe(true);
});

test('sanitizes persisted content only for the Store distribution', async () => {
  const run = jest.fn(async () => ({ changes: 3, lastInsertRowId: 0 }));

  await expect(sanitizeImageDatabaseForDistribution(
    { run },
    STORE_DISTRIBUTION_POLICY,
  )).resolves.toBe(3);
  expect(run).toHaveBeenCalledWith(expect.stringContaining(
    "content_rating <> 'safe'",
  ));

  run.mockClear();
  await expect(sanitizeImageDatabaseForDistribution(
    { run },
    DIRECT_DISTRIBUTION_POLICY,
  )).resolves.toBe(0);
  expect(run).not.toHaveBeenCalled();
});

test('D6a: the runtime policy allows adult content even when the embedded config carries no variant', () => {
  jest.isolateModules(() => {
    // jest.setup.ts already instantiated the expo-constants mock; jest checks
    // its mock registry before any newly registered factory, so the registry
    // has to be cleared for jest.doMock below to take effect.
    jest.resetModules();
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { version: '1.2.0', extra: {} } },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const policy = require('./distribution-policy') as typeof import('./distribution-policy');
    expect(policy.APP_DISTRIBUTION_POLICY.allowsAdultContent).toBe(true);
  });
});
