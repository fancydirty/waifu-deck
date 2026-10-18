import { danbooruContentRating } from "@/features/content/content-taxonomy";
import { canonicalizeSourceUrl, normalizedMd5Hex } from "@/features/providers/source-identity";
import {
  createDanbooruEngine,
  DanbooruApiError as EngineDanbooruApiError,
  isRecord,
  nonEmptyString,
  positiveInteger,
  safeSourceUrl,
  trustedImageUrl,
  type DanbooruApiErrorCode as EngineDanbooruApiErrorCode,
  type DanbooruBatch as EngineDanbooruBatch,
  type DanbooruBatchInput,
  type DanbooruEngineConfig,
  type DanbooruFetcher as EngineDanbooruFetcher,
  type DanbooruParseContext,
  type DanbooruSearchPageInput,
} from "@/features/providers/engines/danbooru-engine";
import type { ContentRating, ImageCandidate } from "@/features/waifu/types";

// Danbooru remains the reference Danbooru-family instance; the shared engine holds
// the (behaviour-identical) chassis. All previous exports are preserved by
// delegation. e621/e926 join as sibling configs in later G2a-2 tasks.

export const DANBOORU_REQUEST_TIMEOUT_MS = 12_000;

export type DanbooruApiErrorCode = EngineDanbooruApiErrorCode;
export type DanbooruFetcher = EngineDanbooruFetcher;
export type DanbooruBatch = EngineDanbooruBatch;
export type FetchDanbooruBatchInput = DanbooruBatchInput;
export type FetchDanbooruSearchPageInput = DanbooruSearchPageInput;

// Same class object as the engine's error, so existing `instanceof DanbooruApiError`
// checks and `new DanbooruApiError(...)` construction keep working unchanged.
// The value+type merge trips @typescript-eslint/no-redeclare on the `type`
// declaration (the second/redeclaring one), so the disable belongs there — not
// above the `const`, where the original comment sat inert.
export const DanbooruApiError = EngineDanbooruApiError;
// eslint-disable-next-line @typescript-eslint/no-redeclare -- deliberate value+type merge for the back-compat alias
export type DanbooruApiError = EngineDanbooruApiError;

// --- Danbooru schema constants + parse helpers (byte-faithful from the original
// client). These feed both DANBOORU_CONFIG (the engine's per-instance contract)
// and the flat `parseCandidate`/`parsePreviewUrl` hooks below. ---
const DANBOORU_RANDOM_URL = "https://danbooru.donmai.us/posts/random.json";
const DANBOORU_POSTS_URL = "https://danbooru.donmai.us/posts.json";
const DANBOORU_TRUSTED_CDN_HOSTS: readonly string[] = ["cdn.donmai.us"];
const DANBOORU_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
]);
export const DANBOORU_HEADERS = {
  Accept: "application/json",
  "User-Agent": "WaifuDeck/1.0 (Expo; https://github.com/fancydirty)",
} as const;
const DANBOORU_RATING_VOCAB = {
  allowed: new Set<string>(["g", "s", "q", "e"]),
  toContentRating: (rating: string): ContentRating =>
    danbooruContentRating(rating as "g" | "s" | "q" | "e"),
  sfwQueryTag: "rating:general",
  nsfwQueryTag: "is:nsfw",
};

// Danbooru's flat post schema mapping. Behaviour is identical to the original
// standalone `parseCandidate`: returns `null` to silently skip a disallowed
// extension, throws `DanbooruApiError('invalid_response')` for dirty/missing
// fields, builds the Danbooru-specific artist search URL, and reads
// `media_asset.duration` to flag animation. Trusted hosts, allowed extensions,
// and the rating vocabulary now arrive through `ctx` (built by the engine from
// DANBOORU_CONFIG), so this hook reads no module-level schema constants.
function parseCandidate(
  value: unknown,
  ctx: DanbooruParseContext,
): ImageCandidate | null {
  if (!isRecord(value)) {
    throw new DanbooruApiError(
      "invalid_response",
      "Danbooru returned invalid post metadata",
    );
  }
  const id = positiveInteger(value.id);
  const width = positiveInteger(value.image_width);
  const height = positiveInteger(value.image_height);
  const byteSize = positiveInteger(value.file_size);
  const extension = nonEmptyString(value.file_ext)?.toLowerCase() ?? null;
  const remoteUrl = trustedImageUrl(value.file_url, ctx.trustedCdnHosts);
  const rating = nonEmptyString(value.rating);
  if (
    id === null ||
    width === null ||
    height === null ||
    byteSize === null ||
    extension === null ||
    remoteUrl === null ||
    rating === null ||
    !ctx.ratingAllowed(rating)
  ) {
    throw new DanbooruApiError(
      "invalid_response",
      "Danbooru returned incomplete image metadata",
    );
  }
  if (!ctx.allowedExtensions.has(extension)) return null;

  const tags = (nonEmptyString(value.tag_string) ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const artistTag =
    (nonEmptyString(value.tag_string_artist) ?? "")
      .split(/\s+/)
      .find(Boolean) ?? null;
  const sourceUrl = safeSourceUrl(value.source);
  const pixivId = positiveInteger(value.pixiv_id);
  const duration =
    isRecord(value.media_asset) &&
    typeof value.media_asset.duration === "number"
      ? value.media_asset.duration
      : 0;
  const contentRating = ctx.toContentRating(rating);

  return {
    providerKey: "danbooru",
    providerItemId: String(id),
    canonicalSourceKey:
      pixivId === null ? canonicalizeSourceUrl(sourceUrl) : `pixiv:${pixivId}`,
    perceptualHash: null,
    md5: normalizedMd5Hex(value.md5),
    remoteUrl,
    // R8.18: `large_file_url` is the medium sample the deck renders; the
    // original `file_url` is still what the collection downloads on save.
    sampleUrl: trustedImageUrl(value.large_file_url, ctx.trustedCdnHosts) ?? remoteUrl,
    sourceUrl,
    artistName: artistTag?.replace(/_/g, " ") ?? null,
    artistUrl:
      artistTag === null
        ? null
        : `https://danbooru.donmai.us/artists?search[name]=${encodeURIComponent(artistTag)}`,
    width,
    height,
    byteSize,
    extension: `.${extension}`,
    dominantColor: "#D8D6D0",
    contentRating,
    nativeRating: rating,
    isNsfw: contentRating !== "safe",
    isAnimated: extension === "gif" || duration > 0,
    tags,
  };
}

const DANBOORU_CONFIG: DanbooruEngineConfig<"danbooru"> = {
  key: "danbooru",
  label: "Danbooru",
  postsUrl: DANBOORU_POSTS_URL,
  randomUrl: DANBOORU_RANDOM_URL,
  trustedCdnHosts: DANBOORU_TRUSTED_CDN_HOSTS,
  headers: DANBOORU_HEADERS,
  allowedExtensions: DANBOORU_ALLOWED_EXTENSIONS,
  ratingVocab: DANBOORU_RATING_VOCAB,
  parseCandidate,
  // R8.24: an untrusted/missing 180x180 preview falls back to the medium
  // sample (large_file_url, parsed into candidate.sampleUrl) before the original.
  parsePreviewUrl: (raw, candidate, ctx) =>
    isRecord(raw)
      ? (trustedImageUrl(raw.preview_file_url, ctx.trustedCdnHosts) ??
        candidate.sampleUrl ??
        candidate.remoteUrl)
      : candidate.sampleUrl ?? candidate.remoteUrl,
  // K7 ⑯ — `random:N` in one request, not N `posts/random.json` calls.
  // Danbooru's anonymous tag limit answers 422 once a style tag widens the
  // query; the engine falls back to the fan-out for exactly that case.
  randomSampling: "random-tag",
  discoveryBatchSize: 4,
  requestTimeoutMs: DANBOORU_REQUEST_TIMEOUT_MS,
  retryableStatuses: new Set([429]),
  searchDefaultLimit: 20,
  searchMaxLimit: 200,
  isUnsupportedSearchResponse: (status, body) =>
    status === 422 &&
    isRecord(body) &&
    body.success === false &&
    body.error === "PostQuery::TagLimitError",
};

const danbooruEngine = createDanbooruEngine(DANBOORU_CONFIG);

export const buildDanbooruUrl = danbooruEngine.buildUrl;
export const fetchDanbooruBatch = danbooruEngine.fetchBatch;
export const fetchDanbooruSearchPage = danbooruEngine.fetchSearchPage;
