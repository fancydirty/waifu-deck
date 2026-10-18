import type {
  AnimationMode,
  AppSettings,
  ImageProviderKey,
  ImageProviderSettings,
  LanguagePreference,
  MaximumBytes,
  MinimumWidth,
  NsfwMode,
  Orientation,
  PrefetchDepth,
  StylePreference,
} from '../waifu/types';
import {
  APP_DISTRIBUTION_POLICY,
  applyDistributionToSettings,
  type DistributionPolicy,
} from '../distribution/distribution-policy';

export type { AppSettings } from '../waifu/types';

export const DEFAULT_SETTINGS: AppSettings = {
  version: 5,
  language: 'system',
  providers: {
    waifu_im: true,
    nekos_api: true,
    danbooru: true,
    safebooru: true,
    yandere: true,
    konachan: true,
    e621: true,
    e926: true,
    // G4: credentialed source — disabled until the user saves an API key (key↔enable coupling)
    gelbooru: false,
    // G4: credentialed source — disabled until the user saves an API key (key↔enable coupling)
    rule34: false,
  },
  nsfwMode: 'sfw',
  nsfwConfirmed: false,
  includedTags: ['waifu'],
  excludedTags: [],
  orientation: 'portrait',
  animationMode: 'exclude',
  stylePreference: 'any',
  minWidth: 0,
  maxBytes: 0,
  prefetchDepth: 40,
  blurNsfwThumbnails: true,
};

export function setProviderEnabled(
  providers: ImageProviderSettings,
  provider: ImageProviderKey,
  enabled: boolean,
): ImageProviderSettings {
  const next = { ...providers, [provider]: enabled };
  return Object.values(next).some(Boolean) ? next : providers;
}

const TAG_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * R8.22: a raw provider tag the user typed may be blocked verbatim. It must be
 * a normalized slug (lowercase, `[a-z0-9]` with `_`/`-` separators) and never
 * the fixed `waifu` base tag waifu.im requires on every request.
 */
export function isBlockableTagSlug(value: string): boolean {
  return TAG_SLUG.test(value) && value !== 'waifu';
}

function isOneOf<T extends string | number>(
  value: unknown,
  values: readonly T[],
): value is T {
  return values.includes(value as T);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => TAG_SLUG.test(tag) && tag !== 'waifu'),
  )];
}

export function normalizeSettings(
  value: unknown,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): AppSettings {
  const candidate =
    value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const includedTags = normalizeTags(candidate.includedTags);
  const excludedTags = normalizeTags(candidate.excludedTags).filter(
    (tag) => !includedTags.includes(tag),
  );
  const nsfwConfirmed = candidate.nsfwConfirmed === true;
  const requestedNsfwMode = isOneOf<NsfwMode>(candidate.nsfwMode, [
    'sfw',
    'mixed',
    'nsfw',
  ])
    ? candidate.nsfwMode
    : DEFAULT_SETTINGS.nsfwMode;
  const nsfwMode = requestedNsfwMode !== 'sfw' && !nsfwConfirmed
    ? DEFAULT_SETTINGS.nsfwMode
    : requestedNsfwMode;
  const candidateProviders =
    candidate.providers !== null && typeof candidate.providers === 'object'
      ? candidate.providers as Record<string, unknown>
      : {};
  const providers = {
    waifu_im: typeof candidateProviders.waifu_im === 'boolean'
      ? candidateProviders.waifu_im
      : DEFAULT_SETTINGS.providers.waifu_im,
    nekos_api: typeof candidateProviders.nekos_api === 'boolean'
      ? candidateProviders.nekos_api
      : DEFAULT_SETTINGS.providers.nekos_api,
    danbooru: typeof candidateProviders.danbooru === 'boolean'
      ? candidateProviders.danbooru
      : DEFAULT_SETTINGS.providers.danbooru,
    safebooru: typeof candidateProviders.safebooru === 'boolean'
      ? candidateProviders.safebooru
      : DEFAULT_SETTINGS.providers.safebooru,
    yandere: typeof candidateProviders.yandere === 'boolean'
      ? candidateProviders.yandere
      : DEFAULT_SETTINGS.providers.yandere,
    konachan: typeof candidateProviders.konachan === 'boolean'
      ? candidateProviders.konachan
      : DEFAULT_SETTINGS.providers.konachan,
    e621: typeof candidateProviders.e621 === 'boolean'
      ? candidateProviders.e621
      : DEFAULT_SETTINGS.providers.e621,
    e926: typeof candidateProviders.e926 === 'boolean'
      ? candidateProviders.e926
      : DEFAULT_SETTINGS.providers.e926,
    gelbooru: typeof candidateProviders.gelbooru === 'boolean'
      ? candidateProviders.gelbooru
      : DEFAULT_SETTINGS.providers.gelbooru,
    rule34: typeof candidateProviders.rule34 === 'boolean'
      ? candidateProviders.rule34
      : DEFAULT_SETTINGS.providers.rule34,
  };
  if (!Object.values(providers).some(Boolean)) providers.waifu_im = true;

  return applyDistributionToSettings({
    version: 5,
    language: isOneOf<LanguagePreference>(candidate.language, [
      'system',
      'en',
      'zh-Hans',
      'zh-Hant',
      'ja',
    ])
      ? candidate.language
      : DEFAULT_SETTINGS.language,
    providers,
    nsfwMode,
    nsfwConfirmed,
    includedTags: ['waifu', ...includedTags],
    excludedTags,
    orientation: isOneOf<Orientation>(candidate.orientation, [
      'portrait',
      'landscape',
      'any',
    ])
      ? candidate.orientation
      : DEFAULT_SETTINGS.orientation,
    animationMode: isOneOf<AnimationMode>(candidate.animationMode, [
      'exclude',
      'include',
      'only',
    ])
      ? candidate.animationMode
      : DEFAULT_SETTINGS.animationMode,
    stylePreference: isOneOf<StylePreference>(candidate.stylePreference, [
      'any',
      'prefer-3d',
      'prefer-2d',
    ])
      ? candidate.stylePreference
      : DEFAULT_SETTINGS.stylePreference,
    minWidth: isOneOf<MinimumWidth>(candidate.minWidth, [0, 720, 1080, 1440])
      ? candidate.minWidth
      : DEFAULT_SETTINGS.minWidth,
    maxBytes: isOneOf<MaximumBytes>(candidate.maxBytes, [
      0,
      2_000_000,
      5_000_000,
      10_000_000,
    ])
      ? candidate.maxBytes
      : DEFAULT_SETTINGS.maxBytes,
    prefetchDepth: isOneOf<PrefetchDepth>(candidate.prefetchDepth, [30, 40, 60])
      ? candidate.prefetchDepth
      : DEFAULT_SETTINGS.prefetchDepth,
    blurNsfwThumbnails:
      typeof candidate.blurNsfwThumbnails === 'boolean'
        ? candidate.blurNsfwThumbnails
        : DEFAULT_SETTINGS.blurNsfwThumbnails,
  }, policy);
}

export function discoverySettingsIdentity(settings: AppSettings): string {
  return JSON.stringify([
    settings.providers,
    settings.nsfwMode,
    settings.nsfwConfirmed,
    settings.includedTags,
    settings.excludedTags,
    settings.orientation,
    settings.animationMode,
    settings.stylePreference,
    settings.minWidth,
    settings.maxBytes,
  ]);
}

export function settingsAffectDiscovery(
  previous: AppSettings,
  next: AppSettings,
): boolean {
  return discoverySettingsIdentity(previous) !== discoverySettingsIdentity(next);
}
