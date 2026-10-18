import { e621ContentRating } from "@/features/content/content-taxonomy";
import {
  createDanbooruEngine,
  DanbooruApiError,
  isRecord,
  nonEmptyString,
  positiveInteger,
  safeSourceUrl,
  trustedImageUrl,
  type DanbooruEngineConfig,
  type DanbooruParseContext,
} from "@/features/providers/engines/danbooru-engine";
import { canonicalizeSourceUrl, normalizedMd5Hex } from "@/features/providers/source-identity";
import type {
  ContentRating,
  ImageCandidate,
  ImageProviderKey,
} from "@/features/waifu/types";

// e621 is the second Danbooru-family instance (after Danbooru). It shares the
// engine chassis but brings its own NESTED post schema (`file`/`tags`/`flags`/
// `sources`), a 3-value `s/q/e` rating vocabulary, a mandatory User-Agent, a
// still-image-only extension allowlist (video is dropped first round), and a
// 503-aware retryable set for its 2 req/s rate limit — see spec §1/§4 and the
// G2a-2 plan's key design decisions.
//
// e926 (the SFW-only mirror, G2a-2 task 3) reuses this exact schema mapping —
// only the base URLs/CDN host differ. Rather than copy-pasting the ~90-line
// nested parser, this file exports {@link createE621FamilyConfig}: a factory
// that closes over the shared parsing logic and is parameterized by
// key/label/postsUrl/randomUrl/trustedCdnHosts. `e926-client.ts` imports it
// directly; this file's own `E621_CONFIG` is just one call to it.

const E621_TRUSTED_CDN_HOSTS: readonly string[] = ["static1.e621.net"];
// Still images only for the first round: e621 serves heavy mp4/webm posts, but
// this app is focused on images/art, so `mp4`/`webm` fall through the disallowed
// -extension path and are rejected (plan decision).
const E621_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
]);
// e621 bans the default/empty/browser User-Agent; a descriptive UA is MANDATORY
// (a missing/blocked UA returns HTTP 403). This header is passed verbatim to the
// fetcher by the engine — there is no shared fetch wrapper (spec §4).
const E621_HEADERS = {
  Accept: "application/json",
  "User-Agent": "WaifuDeck/1.0 (Expo; https://github.com/fancydirty)",
} as const;
// The e621 tag namespaces flattened into a single tag list. `invalid` (rejected
// tags) and `contributor` (a wiki-editing namespace, not content) are excluded
// per the plan decision.
const E621_TAG_NAMESPACES = [
  "general",
  "species",
  "character",
  "copyright",
  "artist",
  "meta",
  "lore",
] as const;

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

/** Base URL/host overrides that distinguish an e621-family instance. */
export type E621FamilyOverrides<K extends ImageProviderKey> = {
  key: K;
  label: string;
  postsUrl: string;
  randomUrl: string;
  trustedCdnHosts: readonly string[];
};

/**
 * Builds a full {@link DanbooruEngineConfig} for an e621-schema instance
 * (e621 itself, or e926 — its SFW-only mirror). The nested `posts.json`
 * schema mapping, headers, tag namespaces, allowed extensions, and rating
 * vocabulary are byte-identical across every instance; only `overrides`
 * (key/label/postsUrl/randomUrl/trustedCdnHosts) varies.
 *
 * `parseCandidate` is consistent with Danbooru's contract: throws
 * `DanbooruApiError('invalid_response')` for dirty/missing required fields
 * (id, `file.url`, dimensions, rating) and returns `'reject'` (a silent skip)
 * for a disallowed extension (video) or a deleted/pending/flagged post.
 * Trusted hosts, allowed extensions, and the rating vocabulary arrive through
 * `ctx` (built by the engine from the returned config); `providerKey` on the
 * returned candidate and the error-message label come from `overrides` so
 * each instance is tagged and diagnosed correctly.
 */
export function createE621FamilyConfig<K extends ImageProviderKey>(
  overrides: E621FamilyOverrides<K>,
): DanbooruEngineConfig<K> {
  function parseCandidate(
    value: unknown,
    ctx: DanbooruParseContext,
  ): ImageCandidate | "reject" | null {
    if (!isRecord(value)) {
      throw new DanbooruApiError(
        "invalid_response",
        `${overrides.label} returned invalid post metadata`,
      );
    }
    const file = isRecord(value.file) ? value.file : null;
    const id = positiveInteger(value.id);
    const width = file ? positiveInteger(file.width) : null;
    const height = file ? positiveInteger(file.height) : null;
    const byteSize = file ? positiveInteger(file.size) : null;
    const extension = file
      ? (nonEmptyString(file.ext)?.toLowerCase() ?? null)
      : null;
    const remoteUrl = file
      ? trustedImageUrl(file.url, ctx.trustedCdnHosts)
      : null;
    const rating = nonEmptyString(value.rating);
    if (
      id === null ||
      file === null ||
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
        `${overrides.label} returned incomplete image metadata`,
      );
    }

    // e621/e926 expose a byte-exact MD5 on `file.md5`. Threaded onto
    // ImageCandidate for cross-source dedup (G2b task2) as a plain hex
    // string — never a Buffer — to stay Hermes-safe.
    const md5 = normalizedMd5Hex(file.md5);

    // Drop video (mp4/webm) — first round is still-image only.
    if (!ctx.allowedExtensions.has(extension)) return "reject";

    // Skip posts that are not publicly servable content.
    const flags = isRecord(value.flags) ? value.flags : {};
    if (
      flags.deleted === true ||
      flags.pending === true ||
      flags.flagged === true
    ) {
      return "reject";
    }

    const tagsRecord = isRecord(value.tags) ? value.tags : {};
    const tags = E621_TAG_NAMESPACES.flatMap((namespace) =>
      stringArray(tagsRecord[namespace]),
    );
    const artistName = stringArray(tagsRecord.artist)[0] ?? null;
    const sources = Array.isArray(value.sources) ? value.sources : [];
    const sourceUrl = safeSourceUrl(sources[0]);
    const contentRating = ctx.toContentRating(rating);

    return {
      providerKey: overrides.key,
      providerItemId: String(id),
      canonicalSourceKey: canonicalizeSourceUrl(sourceUrl),
      perceptualHash: null,
      md5,
      remoteUrl,
      // R8.18: `sample.url` is the medium display image the deck renders; the
      // original `file.url` (remoteUrl) is still downloaded on save.
      sampleUrl:
        (isRecord(value.sample)
          ? trustedImageUrl(value.sample.url, ctx.trustedCdnHosts)
          : null) ?? remoteUrl,
      sourceUrl,
      artistName,
      artistUrl: null,
      width,
      height,
      byteSize,
      extension: `.${extension}`,
      dominantColor: "#D8D6D0",
      contentRating,
      nativeRating: rating,
      isNsfw: contentRating !== "safe",
      isAnimated: extension === "gif",
      tags,
    };
  }

  return {
    key: overrides.key,
    label: overrides.label,
    postsUrl: overrides.postsUrl,
    randomUrl: overrides.randomUrl,
    trustedCdnHosts: overrides.trustedCdnHosts,
    headers: E621_HEADERS,
    allowedExtensions: E621_ALLOWED_EXTENSIONS,
    ratingVocab: {
      allowed: new Set<string>(["s", "q", "e"]),
      toContentRating: (rating: string): ContentRating =>
        e621ContentRating(rating as "s" | "q" | "e"),
      sfwQueryTag: "rating:s",
      nsfwQueryTag: "rating:e",
    },
    parseCandidate,
    parsePreviewUrl: (raw, candidate, ctx) => {
      if (!isRecord(raw)) return candidate.remoteUrl;
      const preview = isRecord(raw.preview)
        ? trustedImageUrl(raw.preview.url, ctx.trustedCdnHosts)
        : null;
      const sample = isRecord(raw.sample)
        ? trustedImageUrl(raw.sample.url, ctx.trustedCdnHosts)
        : null;
      return preview ?? sample ?? candidate.remoteUrl;
    },
    // e621/e926 hard-limit at 2 req/s (503 penalty); cap discovery fan-out at
    // 2 and treat 503 as a retryable rate-limit alongside 429 (spec §1/§7
    // risk 2). This engine clamp is the REAL enforcement of the 2-request
    // discovery ceiling — `provider-registry.ts`'s `maxDiscoveryBatch: 2`
    // for e621/e926 is a declaration that points back here, not a second
    // enforcement point (G3 spec S10: the registry's old `?? 2` fallback
    // was dead code and never actually enforced anything).
    // K7 ⑯ — e621/e926 answer `order:random` with 200 (Danbooru answers it
    // with a 500 QueryCanceled, hence the two sampling forms). One request for
    // both cards instead of two, which also halves what the 2 req/s budget
    // has to carry.
    randomSampling: "order-random",
    discoveryBatchSize: 2,
    retryableStatuses: new Set([429, 503]),
    // Unlike Danbooru (bare array/object), the real e621-family API WRAPS its
    // responses: `posts.json` -> `{"posts":[...]}` and `posts/random.json` ->
    // `{"post":{...}}`. Verified live against both e621.net and e926.net; the
    // G2a-2 Task 4 real-API gate caught this (every call previously failed
    // `invalid_response`, so both sources returned zero images in production).
    responseListKey: "posts",
    responseSingleKey: "post",
  };
}

const E621_CONFIG: DanbooruEngineConfig<"e621"> = createE621FamilyConfig({
  key: "e621",
  label: "e621",
  postsUrl: "https://e621.net/posts.json",
  randomUrl: "https://e621.net/posts/random.json",
  trustedCdnHosts: E621_TRUSTED_CDN_HOSTS,
});

const e621Engine = createDanbooruEngine(E621_CONFIG);

export const fetchE621Batch = e621Engine.fetchBatch;
export const fetchE621SearchPage = e621Engine.fetchSearchPage;
