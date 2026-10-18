import type {
  AnimationMode,
  ImageCandidate,
  ImageProviderKey,
  MaximumBytes,
  MinimumWidth,
  NsfwMode,
  Orientation,
} from '@/features/waifu/types';

/**
 * The result-set-defining search filter. The first version is tag-based, but a
 * search inherits the quality/safety filters that change *which* images match,
 * so identity must cover them all.
 *
 * Deliberately excluded:
 * - provider on/off toggles — queries are issued per provider and the
 *   `providerKey` enters the query key separately, so toggling one source must
 *   not invalidate another source's cached pages;
 * - display/pagination knobs (preload count, blur, page size) — they never
 *   change the set of matching images.
 */
export type SearchRequest = {
  tags: string[];
  excludedTags: string[];
  nsfwMode: NsfwMode;
  orientation: Orientation;
  animationMode: AnimationMode;
  minWidth: MinimumWidth;
  maxBytes: MaximumBytes;
};

/** ID-descending searches use keysets; source-ordered searches use page numbers. */
export type DanbooruSearchCursor = { beforeId: number } | { page: number };

/** Provider-specific pagination positions — no opaque strings. */
export type ProviderCursor = {
  waifu_im: { page: number };
  nekos_api: { offset: number };
  danbooru: DanbooruSearchCursor;
  safebooru: { page: number };
  yandere: { page: number };
  konachan: { page: number };
  e621: DanbooruSearchCursor;
  e926: DanbooruSearchCursor;
  gelbooru: { page: number };
  rule34: { page: number };
};

/**
 * Aggregate pagination state across providers. Per provider:
 * absent = not started (fetch the first page), `null` = exhausted,
 * otherwise the provider's next position.
 */
export type SearchCursor = {
  [K in ImageProviderKey]?: ProviderCursor[K] | null;
};

/**
 * A single search result. Merging and dedup operate on `image`; `key` is a
 * stable per-hit identity and `previewUrl` is retained for rendering.
 */
export type SearchHit = {
  key: string;
  previewUrl: string;
  image: ImageCandidate;
};

// Distributes over providers so `nextCursor` is correlated with `providerKey`.
type ProviderSearchPageFor<K extends ImageProviderKey> = {
  providerKey: K;
  items: SearchHit[];
  nextCursor: ProviderCursor[K] | null;
  total?: number;
  /** The provider answered, but does not recognize this tag combination. */
  unsupportedQuery?: boolean;
};

/** One provider's successful page. Discriminated by `providerKey`. */
export type ProviderSearchPage = {
  [K in ImageProviderKey]: ProviderSearchPageFor<K>;
}[ImageProviderKey];

/**
 * A provider that could not be queried for the current page.
 *
 * Carries no free-text field: per-source failures are never surfaced to the
 * user (R8.5/R8.7), so the only consumer is the aggregate `status === 'error'`
 * decision. Keeping this shape closed makes the no-secret-leak property
 * structural rather than asserted by a test.
 */
export type ProviderSearchFailure = {
  providerKey: ImageProviderKey;
  code: string;
};

/** The outcome of querying one provider for the current page. */
export type ProviderSearchState =
  | { status: 'ok'; page: ProviderSearchPage }
  | { status: 'failed'; failure: ProviderSearchFailure };
