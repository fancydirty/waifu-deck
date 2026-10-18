export type NsfwMode = 'sfw' | 'mixed' | 'nsfw';
export type Orientation = 'portrait' | 'landscape' | 'any';
export type AnimationMode = 'exclude' | 'include' | 'only';
export type StylePreference = 'any' | 'prefer-3d' | 'prefer-2d';
/**
 * R8.20 (owner 2026-09-09): how many cards ahead the deck keeps image-warmed
 * and metadata-reserved. This is the user-visible 「预加载数量」 control.
 */
export type PrefetchDepth = 30 | 40 | 60;
export type MinimumWidth = 0 | 720 | 1080 | 1440;
export type MaximumBytes = 0 | 2_000_000 | 5_000_000 | 10_000_000;
export type AppLanguage = 'en' | 'zh-Hans' | 'zh-Hant' | 'ja';
export type LanguagePreference = 'system' | AppLanguage;
export type ImageProviderKey =
  | 'waifu_im'
  | 'nekos_api'
  | 'danbooru'
  | 'safebooru'
  | 'yandere'
  | 'konachan'
  | 'e621'
  | 'e926'
  | 'gelbooru'
  | 'rule34';

const IMAGE_PROVIDER_KEYS: Record<ImageProviderKey, true> = {
  waifu_im: true,
  nekos_api: true,
  danbooru: true,
  safebooru: true,
  yandere: true,
  konachan: true,
  e621: true,
  e926: true,
  gelbooru: true,
  rule34: true,
};

/**
 * Provider order as an array, in the same order as PROVIDER_REGISTRY. Lives in
 * this leaf types module so pure modules like `candidate-dedupe` can take it as
 * the §3.3 tie-break order without importing PROVIDER_REGISTRY (which would be a
 * cycle: registry -> provider-client -> candidate-dedupe). Kept in sync with the
 * registry order by a test in provider-registry.test.ts.
 */
export const IMAGE_PROVIDER_ORDER = Object.keys(
  IMAGE_PROVIDER_KEYS,
) as ImageProviderKey[];

export function isImageProviderKey(value: string): value is ImageProviderKey {
  return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDER_KEYS, value);
}
export type ContentRating =
  | 'safe'
  | 'suggestive'
  | 'nsfw_unspecified'
  | 'explicit'
  | 'unknown';

export type ImageProviderSettings = Record<ImageProviderKey, boolean>;

export type AppSettings = {
  version: 5;
  language: LanguagePreference;
  providers: ImageProviderSettings;
  nsfwMode: NsfwMode;
  nsfwConfirmed: boolean;
  includedTags: string[];
  excludedTags: string[];
  orientation: Orientation;
  animationMode: AnimationMode;
  stylePreference: StylePreference;
  minWidth: MinimumWidth;
  maxBytes: MaximumBytes;
  prefetchDepth: PrefetchDepth;
  blurNsfwThumbnails: boolean;
};

export type ImageCandidate = {
  providerKey: ImageProviderKey;
  providerItemId: string;
  canonicalSourceKey: string | null;
  perceptualHash: string | null;
  /**
   * Byte-exact MD5 hex digest (lowercased), when the source booru provides
   * one. Never a Buffer — plain hex string only (Hermes/Node-globals
   * safety). `null` when the source doesn't expose an MD5 (e.g. waifu_im,
   * nekos_api) or the value was absent/empty on this item.
   */
  md5: string | null;
  remoteUrl: string;
  /**
   * R8.18: the medium-size display image a source publishes next to the
   * original (moebooru/gelbooru `sample_url`, danbooru `large_file_url`,
   * e621 `sample.url`). The discover deck and its prefetch render this so the
   * UI thread never decodes a multi-megapixel original mid-swipe. Optional:
   * absent for sources with no sample (waifu_im, nekos_api) and for rows
   * written before schema v16 — consumers and the row mapper fall back to
   * `remoteUrl`. Saving to the collection always downloads `remoteUrl`.
   */
  sampleUrl?: string;
  sourceUrl: string | null;
  artistName: string | null;
  artistUrl: string | null;
  width: number;
  height: number;
  byteSize: number;
  extension: string;
  dominantColor: string;
  /** Optional only while legacy fixtures are migrated; runtime providers always set it. */
  contentRating?: ContentRating;
  nativeRating?: string | null;
  isNsfw: boolean;
  isAnimated: boolean;
  tags: string[];
};

export type WaifuImage = ImageCandidate & {
  id: number;
};
