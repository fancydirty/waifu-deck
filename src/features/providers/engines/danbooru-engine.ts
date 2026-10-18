import { fetch as expoFetch } from "expo/fetch";

import {
  candidateContentRating,
  matchesContentMode,
} from "@/features/content/content-taxonomy";
import {
  APP_DISTRIBUTION_POLICY,
  applyDistributionToSearchRequest,
  applyDistributionToSettings,
  isImageAllowedByDistribution,
  type DistributionPolicy,
} from "@/features/distribution/distribution-policy";
import { matchesCandidateSettings } from "@/features/providers/candidate-filter";
import type { ProviderRequestGovernor } from "@/features/providers/provider-resilience";
import type { DanbooruSearchCursor, SearchHit, SearchRequest } from "@/features/search/types";
import type {
  AppSettings,
  ContentRating,
  ImageCandidate,
  ImageProviderKey,
} from "@/features/waifu/types";

/**
 * Shared Danbooru-family transport, safety filters, and pagination. Per-source
 * schemas and verified query-rejection responses belong to config. Ordinary
 * searches keep ID keysets; explicit source ordering uses numbered pages so
 * pagination cannot override the caller's order.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_DISCOVERY_BATCH_SIZE = 4;
const DEFAULT_SEARCH_DEFAULT_LIMIT = 20;
const DEFAULT_SEARCH_MAX_LIMIT = 200;
const DEFAULT_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429]);

export type DanbooruApiErrorCode =
  | "http"
  | "rate_limited"
  | "network"
  | "aborted"
  | "timeout"
  | "invalid_response";

export class DanbooruApiError extends Error {
  readonly code: DanbooruApiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly unsupportedQuery?: boolean;

  constructor(
    code: DanbooruApiErrorCode,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      unsupportedQuery?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "DanbooruApiError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.unsupportedQuery = options.unsupportedQuery;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, DanbooruApiError.prototype);
  }
}

/** See {@link DanbooruEngineConfig.randomSampling}. */
export type DanbooruRandomSampling = "random-tag" | "order-random";

/**
 * Rating contract for a Danbooru-family instance.
 * - `allowed`/`toContentRating` are threaded into the per-instance
 *   `config.parseCandidate` via {@link DanbooruParseContext} (Danbooru:
 *   `g/s/q/e`; e621: `s/q/e`).
 * - `sfwQueryTag`/`nsfwQueryTag` are consumed by the shared chassis when it
 *   appends the safety tag to discovery and search queries.
 */
export type DanbooruRatingVocab = {
  allowed: ReadonlySet<string>;
  toContentRating: (rating: string) => ContentRating;
  sfwQueryTag: string;
  nsfwQueryTag: string;
};

/**
 * The config-derived values the engine threads into a per-instance parse hook,
 * so `trustedCdnHosts`/`allowedExtensions`/`ratingVocab` are genuinely read by
 * (and type-enforced against) the hook instead of being captured from a
 * module-level constant. The engine builds one context from `config` and passes
 * it to every `parseCandidate`/`parsePreviewUrl` call.
 */
export type DanbooruParseContext = {
  /** EXACT-host trusted CDN hosts; pass to {@link trustedImageUrl}. */
  trustedCdnHosts: readonly string[];
  /** Allowed (lowercase) file extensions; a miss means skip the post. */
  allowedExtensions: ReadonlySet<string>;
  /** Maps a native rating string to the app's {@link ContentRating}. */
  toContentRating: (rating: string) => ContentRating;
  /** Whether a native rating string is within this instance's vocabulary. */
  ratingAllowed: (rating: string) => boolean;
};

export type DanbooruEngineConfig<
  K extends ImageProviderKey = ImageProviderKey,
> = {
  /** Provider key; also the governor key and hit prefix. */
  key: K;
  /** Human label used verbatim in error messages (e.g. `Danbooru`). */
  label: string;
  /** Post-list (search) endpoint, e.g. `https://danbooru.donmai.us/posts.json`. */
  postsUrl: string;
  /** Random single-post (discovery) endpoint, e.g. `.../posts/random.json`. */
  randomUrl: string;
  /**
   * Trusted CDN hosts for image/preview URLs, matched by EXACT host (not
   * subdomain). Threaded into the per-instance parse hooks via
   * {@link DanbooruParseContext}, not read directly by the chassis.
   */
  trustedCdnHosts: readonly string[];
  headers: Record<string, string>;
  /**
   * Allowed file extensions (disallowed ones are silently skipped by
   * `config.parseCandidate`). Threaded into the per-instance parse hook via
   * {@link DanbooruParseContext}.
   */
  allowedExtensions: ReadonlySet<string>;
  ratingVocab: DanbooruRatingVocab;
  /**
   * Per-instance schema mapping. Receives the raw post and a
   * {@link DanbooruParseContext} built from this config (trusted hosts, allowed
   * extensions, rating vocabulary). Returns an {@link ImageCandidate}, or a skip
   * signal (`"reject"` or `null` — both silently drop the post), or throws a
   * {@link DanbooruApiError} with code `invalid_response` for dirty data.
   */
  parseCandidate: (
    raw: unknown,
    ctx: DanbooruParseContext,
  ) => ImageCandidate | "reject" | null;
  /**
   * Per-instance search-hit preview URL extraction. Receives the same
   * {@link DanbooruParseContext} as `parseCandidate`. Defaults to the
   * candidate's own `remoteUrl` when omitted.
   */
  parsePreviewUrl?: (
    raw: unknown,
    candidate: ImageCandidate,
    ctx: DanbooruParseContext,
  ) => string;
  /**
   * K7 ⑯ — how this instance asks for N random posts in ONE list request.
   *
   * Omitted, discovery falls back to the historical shape: N separate
   * `posts/random.json` calls for N cards, each paying its own TLS + HTTP
   * round trip (measured 2.3-3.8 s for four on Danbooru, against 0.67-1.05 s
   * for the same four in one request).
   *
   * - `random-tag` (Danbooru): `posts.json?limit=N&tags=<tags> random:N`.
   *   Danbooru's documented metatag. **Not** `order:random`, which the audit
   *   measured returning HTTP 500 `QueryCanceled` on danbooru.donmai.us.
   * - `order-random` (e621/e926): `posts.json?limit=N&tags=<tags> order:random`,
   *   the form that instance family answers with 200.
   *
   * Either way the one-request path is best-effort: a 4xx (Danbooru's
   * anonymous tag limit answers 422 once a style tag pushes the query past it)
   * falls back to the single-post fan-out below, so a rejected query costs one
   * wasted request rather than an empty round.
   */
  randomSampling?: DanbooruRandomSampling;
  /**
   * Discovery ceiling: the number of posts asked for in the one-request random
   * path, and the fan-out width of the fallback. Default 4.
   */
  discoveryBatchSize?: number;
  /** Per-request deadline. Default 12_000ms. */
  requestTimeoutMs?: number;
  /** Statuses mapped to `rate_limited` (retryable). Default `{429}`. */
  retryableStatuses?: ReadonlySet<number>;
  searchDefaultLimit?: number;
  searchMaxLimit?: number;
  /**
   * Key to unwrap list responses from (e621 wraps posts.json in
   * `{"posts":[...]}`). Bare array when omitted (Danbooru).
   */
  responseListKey?: string;
  /**
   * Key to unwrap single-post responses from (e621 wraps posts/random.json in
   * `{"post":{...}}`). Bare object when omitted.
   */
  responseSingleKey?: string;
  /** Only verified query rejection responses, never generic HTTP/auth failures. */
  isUnsupportedSearchResponse?: (status: number, body: unknown) => boolean;
};

export type DanbooruFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type DanbooruBatch = {
  items: ImageCandidate[];
  totalCount: number;
};

export type DanbooruBatchInput = {
  settings: AppSettings;
  excludedIds: readonly string[];
  count?: number;
  signal?: AbortSignal;
  fetcher?: DanbooruFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type DanbooruSearchPageInput = {
  request: SearchRequest;
  cursor?: DanbooruSearchCursor | null;
  limit?: number;
  signal?: AbortSignal;
  fetcher?: DanbooruFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type DanbooruSearchPage<K extends ImageProviderKey> = {
  providerKey: K;
  items: SearchHit[];
  nextCursor: DanbooruSearchCursor | null;
  unsupportedQuery?: boolean;
};

export type DanbooruEngine<K extends ImageProviderKey> = {
  fetchBatch: (input: DanbooruBatchInput) => Promise<DanbooruBatch>;
  fetchSearchPage: (
    input: DanbooruSearchPageInput,
  ) => Promise<DanbooruSearchPage<K>>;
  buildUrl: (
    settings: AppSettings,
    distributionPolicy?: DistributionPolicy,
  ) => string;
  ApiError: typeof DanbooruApiError;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Shared trusted-CDN URL guard for every Danbooru-family instance. Returns the
 * normalized URL only when it is `https:` and its EXACT host is in
 * `trustedCdnHosts`; otherwise `null`. Behaviour is identical to the original
 * per-client helper — the trusted host set is now supplied per instance rather
 * than captured from a module constant.
 */
export function trustedImageUrl(
  value: unknown,
  trustedCdnHosts: readonly string[],
): string | null {
  const raw =
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && trustedCdnHosts.includes(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/**
 * Shared zero-dependency parsing primitives for every Danbooru-family instance.
 * These carry no schema-specific logic (the same class of helper as
 * {@link trustedImageUrl}), so the engine is their single home; the per-instance
 * clients import them rather than re-declaring byte-identical copies.
 */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function safeSourceUrl(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeSearchTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "_");
}

function retryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const deadline = Date.parse(retryAfter);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - Date.now());
}

/**
 * K7 ⑯ — the narrow class of failure that means "this instance would not
 * accept THAT QUERY", and therefore that the single-request random page should
 * be re-asked as the single-post fan-out.
 *
 * Client-side HTTP only. A 429 arrives as `rate_limited` (the governor owns the
 * cooldown), a 5xx is the source failing and must surface so the breaker sees
 * it, and `network`/`timeout`/`aborted`/`invalid_response` say nothing about
 * the query. Re-asking on any of those would multiply a bad round by five.
 */
function isQueryRejection(error: unknown): boolean {
  return error instanceof DanbooruApiError &&
    error.code === "http" &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500;
}

export function createDanbooruEngine<K extends ImageProviderKey>(
  config: DanbooruEngineConfig<K>,
): DanbooruEngine<K> {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const discoveryBatchSize =
    config.discoveryBatchSize ?? DEFAULT_DISCOVERY_BATCH_SIZE;
  const searchDefaultLimit =
    config.searchDefaultLimit ?? DEFAULT_SEARCH_DEFAULT_LIMIT;
  const searchMaxLimit = config.searchMaxLimit ?? DEFAULT_SEARCH_MAX_LIMIT;
  const retryableStatuses =
    config.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
  const parseContext: DanbooruParseContext = {
    trustedCdnHosts: config.trustedCdnHosts,
    allowedExtensions: config.allowedExtensions,
    toContentRating: config.ratingVocab.toContentRating,
    ratingAllowed: (rating) => config.ratingVocab.allowed.has(rating),
  };
  const parsePreviewUrl =
    config.parsePreviewUrl ?? ((_raw, candidate, _ctx) => candidate.remoteUrl);

  function runRequest<T>(
    governor: ProviderRequestGovernor | undefined,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return governor
      ? governor.execute(config.key, operation, signal)
      : operation(signal ?? new AbortController().signal);
  }

  async function withDeadline<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let abortCause: "caller" | "timeout" | null = null;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abortRequest = (cause: "caller" | "timeout") => {
      if (abortCause !== null) return;
      abortCause = cause;
      controller.abort();
      rejectAbort(new Error(`${config.label} request aborted by ${cause}`));
    };
    const onCallerAbort = () => abortRequest("caller");
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) abortRequest("caller");
    const timeout = setTimeout(() => abortRequest("timeout"), requestTimeoutMs);

    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (abortCause === "caller") {
        throw new DanbooruApiError(
          "aborted",
          `${config.label} request was aborted`,
          { cause: error },
        );
      }
      if (abortCause === "timeout") {
        throw new DanbooruApiError(
          "timeout",
          `${config.label} request timed out`,
          { cause: error },
        );
      }
      if (error instanceof DanbooruApiError) throw error;
      throw new DanbooruApiError("network", `${config.label} request failed`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async function requestJson(
    url: string,
    signal: AbortSignal,
    fetcher: DanbooruFetcher,
  ): Promise<unknown> {
    const response = await fetcher(url, {
      headers: config.headers,
      signal,
    });
    if (!response.ok) {
      const rateLimited = retryableStatuses.has(response.status);
      const errorBody = config.isUnsupportedSearchResponse === undefined
        ? null
        : await response.json().catch(() => null);
      throw new DanbooruApiError(
        rateLimited ? "rate_limited" : "http",
        `${config.label} request failed with status ${response.status}`,
        {
          status: response.status,
          retryAfterMs: rateLimited ? retryAfterMs(response) : undefined,
          unsupportedQuery: config.isUnsupportedSearchResponse?.(
            response.status,
            errorBody,
          ),
        },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new DanbooruApiError(
        "invalid_response",
        `${config.label} returned invalid JSON`,
        { cause: error },
      );
    }
  }

  function tagsFor(settings: AppSettings): string[] {
    const tags = ["1girl"];
    if (settings.nsfwMode === "sfw") tags.push(config.ratingVocab.sfwQueryTag);
    if (settings.nsfwMode === "nsfw") tags.push(config.ratingVocab.nsfwQueryTag);
    if (settings.stylePreference === "prefer-3d") tags.push("3d");
    if (settings.stylePreference === "prefer-2d") tags.push("2d");
    return tags;
  }

  function searchTagsFor(request: SearchRequest): string[] {
    const tags: string[] = [];
    if (request.nsfwMode === "sfw") tags.push(config.ratingVocab.sfwQueryTag);
    if (request.nsfwMode === "nsfw") tags.push(config.ratingVocab.nsfwQueryTag);
    tags.push(...request.tags.map((tag) => tag.trim()).filter(Boolean));
    return tags;
  }

  function searchLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return searchDefaultLimit;
    }
    return Math.min(searchMaxLimit, Math.max(1, Math.trunc(limit)));
  }

  function searchPageParam(
    cursor: DanbooruSearchCursor | null | undefined,
  ): string | null {
    if (cursor === undefined || cursor === null) return cursor ?? null;
    if ("page" in cursor && Number.isSafeInteger(cursor.page) && cursor.page > 0) {
      return String(cursor.page);
    }
    if ("beforeId" in cursor && Number.isSafeInteger(cursor.beforeId) && cursor.beforeId > 0) {
      return `b${cursor.beforeId}`;
    }
    throw new DanbooruApiError(
      "invalid_response",
      `${config.label} search cursor is invalid`,
    );
  }

  function buildUrl(
    settings: AppSettings,
    distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
  ): string {
    const effectiveSettings = applyDistributionToSettings(
      settings,
      distributionPolicy,
    );
    const params = new URLSearchParams({
      tags: tagsFor(effectiveSettings).join(" "),
    });
    return `${config.randomUrl}?${params.toString()}`;
  }

  /**
   * K7 ⑯ — the one-request random page. `count` appears twice on the
   * `random-tag` form on purpose: `random:N` is what selects N random posts,
   * and `limit` keeps the page from widening if an instance ever treats the
   * metatag as a filter rather than a sample.
   */
  function buildRandomPageUrl(
    settings: AppSettings,
    count: number,
    sampling: DanbooruRandomSampling,
    distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
  ): string {
    const effectiveSettings = applyDistributionToSettings(
      settings,
      distributionPolicy,
    );
    const tags = tagsFor(effectiveSettings);
    tags.push(sampling === "random-tag" ? `random:${count}` : "order:random");
    const params = new URLSearchParams({
      limit: String(count),
      tags: tags.join(" "),
    });
    return `${config.postsUrl}?${params.toString()}`;
  }

  function buildSearchUrl(
    request: SearchRequest,
    cursor: DanbooruSearchCursor | null | undefined,
    limit: number,
    distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
  ): string {
    const effectiveRequest = applyDistributionToSearchRequest(
      request,
      distributionPolicy,
    );
    const params = new URLSearchParams({ limit: String(limit) });
    const tags = searchTagsFor(effectiveRequest);
    if (tags.length > 0) params.set("tags", tags.join(" "));
    const page = searchPageParam(cursor);
    if (page !== null) params.set("page", page);
    return `${config.postsUrl}?${params.toString()}`;
  }

  function matchesSearchRequest(
    image: ImageCandidate,
    request: SearchRequest,
  ): boolean {
    const imageTags = new Set(image.tags.map(normalizeSearchTag));
    const excludedTags = request.excludedTags
      .map(normalizeSearchTag)
      .filter(Boolean);
    // Included terms have already been interpreted by the provider query
    // grammar. Re-applying them locally would reject valid operators and
    // provider-native syntax such as `character:foo` or `-bar`.
    if (excludedTags.some((tag) => imageTags.has(tag))) return false;
    if (!matchesContentMode(candidateContentRating(image), request.nsfwMode))
      return false;
    if (request.orientation === "portrait" && image.width >= image.height)
      return false;
    if (request.orientation === "landscape" && image.width <= image.height)
      return false;
    if (request.animationMode === "exclude" && image.isAnimated) return false;
    if (request.animationMode === "only" && !image.isAnimated) return false;
    if (request.minWidth !== 0 && image.width < request.minWidth) return false;
    if (request.maxBytes !== 0 && image.byteSize > request.maxBytes)
      return false;
    return true;
  }

  async function fetchCandidate(
    settings: AppSettings,
    excludedIds: ReadonlySet<string>,
    signal: AbortSignal | undefined,
    fetcher: DanbooruFetcher,
    governor?: ProviderRequestGovernor,
    distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
  ): Promise<ImageCandidate | null> {
    const effectiveSettings = applyDistributionToSettings(
      settings,
      distributionPolicy,
    );
    return runRequest(governor, signal, (governedSignal) =>
      withDeadline(governedSignal, async (requestSignal) => {
        const response = await requestJson(
          buildUrl(effectiveSettings, distributionPolicy),
          requestSignal,
          fetcher,
        );
        // e621/e926 wrap the random post in `{"post":{...}}`; Danbooru returns
        // the post object bare. Unwrap only when the instance declares a key.
        const raw =
          config.responseSingleKey !== undefined && isRecord(response)
            ? response[config.responseSingleKey]
            : response;
        const candidate = config.parseCandidate(raw, parseContext);
        if (
          candidate === null ||
          candidate === "reject" ||
          excludedIds.has(candidate.providerItemId)
        ) {
          return null;
        }
        return isImageAllowedByDistribution(candidate, distributionPolicy) &&
          matchesCandidateSettings(candidate, effectiveSettings)
          ? candidate
          : null;
      }),
    );
  }

  /**
   * K7 ⑯ — N random posts in one round trip. Mirrors the fan-out's contract
   * exactly: same distribution guard, same settings filter, same per-id
   * dedupe, and a pre-filter `totalCount` (G3 spec §4 item 1) so the yield
   * ledger keeps seeing raw-posts-seen rather than a constant 1.0.
   *
   * A single dirty post is skipped rather than failing the page, the same way
   * `fetchSearchPage` treats one: the other N-1 cards are still good.
   */
  async function fetchRandomPage(
    settings: AppSettings,
    excludedIds: ReadonlySet<string>,
    count: number,
    sampling: DanbooruRandomSampling,
    signal: AbortSignal | undefined,
    fetcher: DanbooruFetcher,
    governor: ProviderRequestGovernor | undefined,
    distributionPolicy: DistributionPolicy,
  ): Promise<DanbooruBatch> {
    return runRequest(governor, signal, (governedSignal) =>
      withDeadline(governedSignal, async (requestSignal) => {
        const response = await requestJson(
          buildRandomPageUrl(settings, count, sampling, distributionPolicy),
          requestSignal,
          fetcher,
        );
        const list =
          config.responseListKey !== undefined && isRecord(response)
            ? response[config.responseListKey]
            : response;
        if (!Array.isArray(list)) {
          throw new DanbooruApiError(
            "invalid_response",
            `${config.label} returned invalid random results`,
          );
        }
        const values = list.slice(0, count);
        const seen = new Set<string>();
        const items: ImageCandidate[] = [];
        for (const value of values) {
          let candidate: ImageCandidate | "reject" | null;
          try {
            candidate = config.parseCandidate(value, parseContext);
          } catch (error) {
            if (
              error instanceof DanbooruApiError &&
              error.code === "invalid_response"
            ) {
              continue;
            }
            throw error;
          }
          if (
            candidate === null ||
            candidate === "reject" ||
            seen.has(candidate.providerItemId) ||
            excludedIds.has(candidate.providerItemId) ||
            !isImageAllowedByDistribution(candidate, distributionPolicy) ||
            !matchesCandidateSettings(candidate, settings)
          ) {
            continue;
          }
          seen.add(candidate.providerItemId);
          items.push(candidate);
        }
        return { items, totalCount: values.length };
      }),
    );
  }

  async function fetchBatch({
    settings,
    excludedIds,
    count = discoveryBatchSize,
    signal,
    fetcher = expoFetch as unknown as DanbooruFetcher,
    governor,
    distributionPolicy = APP_DISTRIBUTION_POLICY,
  }: DanbooruBatchInput): Promise<DanbooruBatch> {
    const effectiveSettings = applyDistributionToSettings(
      settings,
      distributionPolicy,
    );
    const requestCount = Math.min(
      discoveryBatchSize,
      Math.max(1, Math.trunc(count)),
    );
    const excluded = new Set(excludedIds.slice(0, 100));
    if (config.randomSampling !== undefined) {
      try {
        return await fetchRandomPage(
          effectiveSettings,
          excluded,
          requestCount,
          config.randomSampling,
          signal,
          fetcher,
          governor,
          distributionPolicy,
        );
      } catch (error) {
        // Only a rejected QUERY earns the fallback; see `isQueryRejection`.
        if (!isQueryRejection(error)) throw error;
      }
    }
    const settled = await Promise.allSettled(
      Array.from({ length: requestCount }, () =>
        fetchCandidate(
          effectiveSettings,
          excluded,
          signal,
          fetcher,
          governor,
          distributionPolicy,
        ),
      ),
    );
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (signal?.aborted) {
      throw failures[0] instanceof DanbooruApiError
        ? failures[0]
        : new DanbooruApiError(
            "aborted",
            `${config.label} request was aborted`,
          );
    }

    const seen = new Set<string>();
    const items = settled.flatMap((result) => {
      if (result.status !== "fulfilled" || result.value === null) return [];
      if (seen.has(result.value.providerItemId)) return [];
      seen.add(result.value.providerItemId);
      return [result.value];
    });
    if (items.length === 0 && failures.length === requestCount)
      throw failures[0];
    // G3 spec §4 item 1 — `totalCount` is the yield ledger's `returned`: the raw
    // posts this engine SAW, before the client-side filter. Reporting
    // `items.length` here made `admitted / returned` a constant 1.0 for
    // danbooru/e621/e926 and hid every orientation/rating/extension rejection.
    // Moebooru and Safebooru already report pre-filter (`values.length`).
    //
    // Each fulfilled request is exactly one raw post received: `fetchCandidate`
    // collapses "parsed but filtered out", "excluded id", and "unusable schema"
    // to `null` *after* the response arrived. A rejected request saw nothing, so
    // it is not counted — that is why this is the fulfilled count rather than
    // `requestCount`, which would charge a failed HTTP request as a post seen
    // and understate the yield of a partially-failing round.
    const returnedCount = settled.reduce(
      (total, result) => (result.status === "fulfilled" ? total + 1 : total),
      0,
    );
    return { items, totalCount: returnedCount };
  }

  async function fetchSearchPage({
    request,
    cursor,
    limit,
    signal,
    fetcher = expoFetch as unknown as DanbooruFetcher,
    governor,
    distributionPolicy = APP_DISTRIBUTION_POLICY,
  }: DanbooruSearchPageInput): Promise<DanbooruSearchPage<K>> {
    const effectiveRequest = applyDistributionToSearchRequest(
      request,
      distributionPolicy,
    );
    if (cursor === null) {
      return { providerKey: config.key, items: [], nextCursor: null };
    }
    const safeLimit = searchLimit(limit);
    // A sequential b<ID> cursor forces id-descending order upstream. Keep a
    // numbered cursor when the caller selected any source-owned ordering.
    const numberedPage = cursor !== undefined && "page" in cursor
      ? cursor.page
      : cursor === undefined && request.tags.some((tag) =>
        /\b(?:order|ordfav|ordvote|ordfavgroup|ordpool):/i.test(tag),
      )
        ? 1
        : null;
    return runRequest(governor, signal, (governedSignal) =>
      withDeadline(governedSignal, async (requestSignal) => {
        const response = await requestJson(
          buildSearchUrl(
            effectiveRequest,
            cursor,
            safeLimit,
            distributionPolicy,
          ),
          requestSignal,
          fetcher,
        );
        // e621/e926 wrap posts.json in `{"posts":[...]}`; Danbooru returns the
        // array bare. Unwrap only when the instance declares a key.
        const list =
          config.responseListKey !== undefined && isRecord(response)
            ? response[config.responseListKey]
            : response;
        if (!Array.isArray(list)) {
          throw new DanbooruApiError(
            "invalid_response",
            `${config.label} returned invalid search results`,
          );
        }

        const postIds = list.flatMap((value) => {
          if (!isRecord(value)) return [];
          const id = positiveInteger(value.id);
          return id === null ? [] : [id];
        });
        const minimumPostId =
          postIds.length === 0 ? null : Math.min(...postIds);
        if (
          cursor !== undefined &&
          "beforeId" in cursor &&
          minimumPostId !== null &&
          minimumPostId >= cursor.beforeId
        ) {
          throw new DanbooruApiError(
            "invalid_response",
            `${config.label} search pagination did not advance`,
          );
        }
        const seen = new Set<string>();
        const items: SearchHit[] = [];
        for (const value of list) {
          let image: ImageCandidate | "reject" | null;
          try {
            image = config.parseCandidate(value, parseContext);
          } catch (error) {
            if (
              error instanceof DanbooruApiError &&
              error.code === "invalid_response"
            ) {
              continue;
            }
            throw error;
          }
          if (
            image === null ||
            image === "reject" ||
            seen.has(image.providerItemId) ||
            !isImageAllowedByDistribution(image, distributionPolicy) ||
            !matchesSearchRequest(image, effectiveRequest)
          ) {
            continue;
          }
          seen.add(image.providerItemId);
          items.push({
            key: `${image.providerKey}:${image.providerItemId}`,
            previewUrl: parsePreviewUrl(value, image, parseContext),
            image,
          });
        }

        return {
          providerKey: config.key,
          items,
          nextCursor:
            numberedPage !== null
              ? list.length === 0 ? null : { page: numberedPage + 1 }
              : minimumPostId === null ? null : { beforeId: minimumPostId },
        };
      }),
    ).catch((error: unknown) => {
      if (error instanceof DanbooruApiError && error.unsupportedQuery === true) {
        return {
          providerKey: config.key,
          items: [],
          nextCursor: null,
          unsupportedQuery: true,
        };
      }
      throw error;
    });
  }

  return {
    fetchBatch,
    fetchSearchPage,
    buildUrl,
    ApiError: DanbooruApiError,
  };
}
