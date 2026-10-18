import { fetch as expoFetch } from 'expo/fetch';

import {
  candidateContentRating,
  matchesContentMode,
} from '@/features/content/content-taxonomy';
import {
  APP_DISTRIBUTION_POLICY,
  applyDistributionToSearchRequest,
  applyDistributionToSettings,
  isImageAllowedByDistribution,
  type DistributionPolicy,
} from '@/features/distribution/distribution-policy';
import { matchesCandidateSettings } from '@/features/providers/candidate-filter';
import type { ProviderCredential } from '@/features/providers/provider-credentials';
import type { ProviderRequestGovernor } from '@/features/providers/provider-resilience';
import { canonicalizeSourceUrl, normalizedMd5Hex } from '@/features/providers/source-identity';
import type { SearchHit, SearchRequest } from '@/features/search/types';
import type {
  AppSettings,
  ContentRating,
  ImageCandidate,
  ImageProviderKey,
} from '@/features/waifu/types';

/**
 * Gelbooru-DAPI engine family (third engine family; Gelbooru today, Rule34 in a
 * later cut). Structurally a Safebooru-family DAPI client refactored into a
 * `create…Engine(config)` factory, plus four host-difference behaviours the two
 * real instances forced out (live-probed 2026-09-03 with the owner's keys):
 *
 *  1. Optional-unwrap `responseListKey`. Gelbooru wraps its list in
 *     `{"@attributes":…, "post":[…]}`; Rule34 returns a BARE ARRAY. A top-level
 *     object is unwrapped at `config.responseListKey`; a top-level array passes
 *     through untouched.
 *  2. Configurable `md5Field`. Gelbooru exposes the digest under `md5`; Rule34
 *     under `hash` (it has no `md5` key at all).
 *  3. Universal auth-failure guard (runs BEFORE any post parsing). Rule34's
 *     keyless sentinel is a live-reproduced HTTP 200 whose body is the bare JSON
 *     STRING "Missing authentication…". That fake-success — and any future
 *     object-wrapped error that unwraps to a non-array — becomes a thrown `auth`
 *     failure, NEVER a silent empty batch. A genuinely empty result
 *     (`{"@attributes":{count:0}}`, `{post:[]}`, or `[]`) stays an empty batch.
 *  4. Fail-safe ratings. An unmapped rating REJECTS the post (drops it); it must
 *     never fall back to a safe tier, which would surface an explicit image
 *     under the default `nsfwMode:'sfw'`.
 *
 * The credential (per-user api_key + user_id) is appended to the request URL
 * only. It must never appear in a thrown message or any console call; this
 * module logs nothing.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const DEFAULT_DISCOVERY_LIMIT_CAP = 8;
/**
 * K7 ㉑ — how deep into the corpus discovery is allowed to sample.
 *
 * Discovery varies the sample by requesting a random page index (`pid`), the
 * same tactic Safebooru uses — and Safebooru has used 1_000 in production all
 * along. This was 20, so with the per-round limit capped at 8 the entire
 * reachable corpus was the ~240 newest posts. The exclusion list only carries
 * 100 ids, so after a couple of hundred cards a user's rounds were mostly
 * re-draws of posts the identity gate had already seen: one API request spent,
 * `inserted === 0`, and eventually a false "this source is exhausted".
 *
 * Not `sort:random`: Gelbooru does document a `sort:` metatag, but this cut
 * could not verify against the live API (offline, fake-fetch tests only) that
 * BOTH instances honour `sort:random`, and an unhonoured metatag is not
 * ignored — it is parsed as an ordinary tag name that matches nothing, which
 * would turn every discovery round into an empty page. A wider `pid` cannot
 * fail that way: the worst case for a page past the end of a smaller corpus is
 * the empty result the engine already handles, and the next round rolls a
 * different page. If a later cut can verify `sort:random` live on both
 * gelbooru.com and rule34.xxx, it strictly improves on this.
 */
const DISCOVERY_PAGE_SPAN = 1_000;

// E8: a saved video becomes 「入库失败」: the library accepts only JPEG/PNG/WebP/GIF,
// while collection naming stores an unsupported download as `.jpg`. This follows
// e621's still-images-only rule. These constants are the one place to re-admit
// video when playback exists (board 4b).
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
]);
const ANIMATED_EXTENSIONS: ReadonlySet<string> = new Set(['gif']);
const ANIMATED_TAGS: ReadonlySet<string> = new Set(['animated', 'video']);
const HARD_EXCLUSION_TAGS: ReadonlySet<string> = new Set([
  'cosplay',
  'cosplayer',
  'photo',
  'photography',
  'real_life',
  'real_person',
  'loli',
  'shota',
]);
const HARD_EXCLUSION_QUERY_TAGS = [...HARD_EXCLUSION_TAGS].map((tag) => `-${tag}`);

export type GelbooruDapiApiErrorCode =
  | 'auth'
  | 'invalid_response'
  | 'http'
  | 'rate_limited'
  | 'network'
  | 'aborted'
  | 'timeout';

export class GelbooruDapiApiError extends Error {
  readonly code: GelbooruDapiApiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: GelbooruDapiApiErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'GelbooruDapiApiError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, GelbooruDapiApiError.prototype);
  }
}

export type GelbooruDapiEngineConfig<K extends ImageProviderKey = ImageProviderKey> = {
  /** Provider key; also the governor key and search-hit prefix. */
  key: K;
  /** Human label used verbatim in error messages (e.g. `Gelbooru`). */
  label: string;
  /** `<apiUrl>?page=dapi&s=post&q=index&json=1&…` */
  apiUrl: string;
  /**
   * Trusted image/preview hosts, matched by host OR subdomain (real file URLs
   * live on CDN subdomains like `img4.gelbooru.com` under `gelbooru.com`).
   */
  trustedCdnHosts: readonly string[];
  headers: Record<string, string>;
  /** Headers required by the image CDN, separate from the DAPI request headers. */
  imageHeaders?: Readonly<Record<string, string>>;
  /**
   * Unwrap key when the top level is an object (Gelbooru's `post`). Optional:
   * bare-array hosts (Rule34) never read it — their list is the top-level value.
   */
  responseListKey?: string;
  /** Per-host md5 field name: gelbooru `md5`, rule34 `hash`. */
  md5Field: string;
  maxLimit: number;
  discoveryLimitCap: number;
  dominantColor: string;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
};

export type GelbooruDapiFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type GelbooruDapiBatch = { items: ImageCandidate[]; totalCount: number };

export type GelbooruDapiBatchInput = {
  settings: AppSettings;
  excludedIds: readonly string[];
  count?: number;
  signal?: AbortSignal;
  fetcher?: GelbooruDapiFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
  /**
   * Per-user credential. When present, `&api_key=…&user_id=…` is appended to the
   * request URL. When absent the engine builds a keyless URL and stays total —
   * the registry guarantees a credentialed source is only invoked when keyed.
   */
  credential?: ProviderCredential;
};

export type GelbooruDapiSearchPageInput = {
  request: SearchRequest;
  cursor?: { page: number } | null;
  limit?: number;
  signal?: AbortSignal;
  fetcher?: GelbooruDapiFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
  credential?: ProviderCredential;
};

export type GelbooruDapiSearchPage<K extends ImageProviderKey> = {
  providerKey: K;
  items: SearchHit[];
  nextCursor: { page: number } | null;
};

export type GelbooruDapiEngine<K extends ImageProviderKey> = {
  fetchBatch: (input: GelbooruDapiBatchInput) => Promise<GelbooruDapiBatch>;
  fetchSearchPage: (
    input: GelbooruDapiSearchPageInput,
  ) => Promise<GelbooruDapiSearchPage<K>>;
  buildUrl: (
    settings: AppSettings,
    count?: number,
    distributionPolicy?: DistributionPolicy,
    page?: number,
    credential?: ProviderCredential,
  ) => string;
  ApiError: typeof GelbooruDapiApiError;
};

type ParsedPost = {
  id: string;
  width: number;
  height: number;
  byteSize: number;
  remoteUrl: string;
  previewUrl: string;
  sampleUrl: string;
  sourceUrl: string | null;
  extension: string;
  nativeRating: string;
  contentRating: ContentRating;
  tags: string[];
  /** Byte-exact MD5 hex (lowercased) when present. Plain string — never a Buffer
   *  (Hermes-safety). */
  md5: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeUrl(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Spec §3.2 rating map — Danbooru-style vocab plus legacy `safe`. The single
 * source of truth for which raw `rating` strings `toContentRating` accepts;
 * exported so callers outside this module (the live-API integration gate's
 * rating-vocab canary) can check the real API's raw ratings against the exact
 * set the engine maps, instead of duplicating the literal and risking silent
 * drift between the two.
 */
export const GELBOORU_MAPPED_RATINGS: ReadonlySet<string> = new Set([
  'general',
  'safe',
  'sensitive',
  'questionable',
  'explicit',
]);

/**
 * FAIL-SAFE: an unknown rating returns `null` and the caller REJECTS the
 * post. It must never fall back to a safe tier — that would surface an
 * explicit image under the default `nsfwMode:'sfw'`.
 */
function toContentRating(rating: string): ContentRating | null {
  const normalized = rating.toLowerCase();
  if (!GELBOORU_MAPPED_RATINGS.has(normalized)) return null; // fail-safe: reject, never a safe tier
  switch (normalized) {
    case 'general':
    case 'safe':
      return 'safe';
    case 'sensitive':
      return 'suggestive';
    case 'questionable':
      return 'nsfw_unspecified';
    case 'explicit':
      return 'explicit';
    default:
      // Unreachable: every member of GELBOORU_MAPPED_RATINGS is handled above.
      return null;
  }
}

/**
 * §3.4 universal auth-failure guard. Runs before any post parsing.
 *  - top-level STRING → the Rule34 keyless sentinel (live-reproduced HTTP 200 +
 *    bare string). Thrown as `auth`, never a silent empty batch. The message
 *    carries no response body — a future server that echoed the request URL back
 *    could otherwise leak the credential.
 *  - top-level ARRAY → the bare-array (Rule34) shape; pass through.
 *  - top-level OBJECT → unwrap `listKey`. An array (incl. `[]`) is the result.
 *    Legit-empty with no `post` key is the DAPI zero-result envelope
 *    (`{"@attributes":{count:0}}`), recognised by the `@attributes` marker.
 *    Anything else — `{error:…}`, a bare `{}`, or a non-array list — is an
 *    auth/shape failure and throws.
 */
function unwrapPostList(body: unknown, listKey: string | undefined, label: string): unknown[] {
  if (typeof body === 'string') {
    throw new GelbooruDapiApiError('auth', `${label} rejected the request (unauthenticated)`);
  }
  if (Array.isArray(body)) return body;
  if (isRecord(body)) {
    // A bare-array host (no responseListKey) that returns an object at all is an
    // error/auth shape — `list` is undefined and the guard below throws.
    const list = listKey === undefined ? undefined : body[listKey];
    if (Array.isArray(list)) return list;
    if (list === undefined && Object.prototype.hasOwnProperty.call(body, '@attributes')) {
      return []; // DAPI zero-result envelope
    }
    throw new GelbooruDapiApiError(
      'auth',
      `${label} returned an object without a ${listKey ?? 'post'} list`,
    );
  }
  throw new GelbooruDapiApiError('invalid_response', `${label} returned an unparseable body`);
}

function ratingQuery(mode: AppSettings['nsfwMode'] | SearchRequest['nsfwMode']): string[] {
  // sfw uses the LIVE tag `rating:general` — `rating:safe` is deprecated
  // server-side and returns nothing on modern Gelbooru-DAPI hosts.
  if (mode === 'sfw') return ['rating:general'];
  if (mode === 'nsfw') return ['rating:explicit'];
  return [];
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const deadline = Date.parse(value);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - Date.now());
}

export function createGelbooruDapiEngine<K extends ImageProviderKey>(
  config: GelbooruDapiEngineConfig<K>,
): GelbooruDapiEngine<K> {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const probeTimeoutMs = config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const discoveryLimitCap = config.discoveryLimitCap ?? DEFAULT_DISCOVERY_LIMIT_CAP;

  function trustedUrl(value: unknown): string | null {
    const raw = nonEmptyString(value);
    if (raw === null) return null;
    try {
      const url = new URL(raw);
      const hostAllowed = config.trustedCdnHosts.some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      );
      if (url.protocol !== 'https:' || !hostAllowed || url.username || url.password || url.port) {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  /**
   * Returns a parsed post, or `null` to DROP the post silently. Every per-post
   * defect — unknown/unmapped rating (fail-safe), untrusted CDN host, disallowed
   * extension, missing id/dimensions — drops that one post rather than throwing,
   * so a single dirty item never fails the whole batch. Structural failures
   * (auth, non-array body) are thrown earlier by {@link unwrapPostList}.
   */
  function parsePost(value: unknown): ParsedPost | null {
    if (!isRecord(value)) return null;
    const id = positiveInteger(value.id);
    const width = positiveInteger(value.width);
    const height = positiveInteger(value.height);
    const remoteUrl = trustedUrl(value.file_url);
    const previewUrl = trustedUrl(value.preview_url) ?? remoteUrl;
    const nativeRating = nonEmptyString(value.rating);
    const contentRating = nativeRating === null ? null : toContentRating(nativeRating);
    if (
      id === null ||
      width === null ||
      height === null ||
      remoteUrl === null ||
      previewUrl === null ||
      nativeRating === null ||
      contentRating === null
    ) {
      return null;
    }
    const extension = new URL(remoteUrl).pathname.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.has(extension)) return null;
    const tags = (nonEmptyString(value.tags) ?? '').split(/\s+/).filter(Boolean);
    // R8.18: medium display image; the deck renders this, not the original.
    const sampleUrl = trustedUrl(value.sample_url) ?? remoteUrl;
    return {
      id: String(id),
      width,
      height,
      // DAPI JSON carries no `file_size` on either host (checked 2026-10-02).
      // 0 means unknown; the image probe fills it where it matters (gifs, and
      // any post when maxBytes is set).
      byteSize: positiveInteger(value.file_size) ?? 0,
      remoteUrl,
      sampleUrl,
      previewUrl,
      sourceUrl: safeUrl(value.source),
      extension,
      nativeRating,
      contentRating,
      tags,
      md5: normalizedMd5Hex(value[config.md5Field]),
    };
  }

  function hasHardExcludedTag(post: ParsedPost): boolean {
    return post.tags.some((tag) => HARD_EXCLUSION_TAGS.has(tag.toLowerCase()));
  }

  function isAnimated(post: ParsedPost): boolean {
    return (
      ANIMATED_EXTENSIONS.has(post.extension) ||
      post.tags.some((tag) => ANIMATED_TAGS.has(tag.toLowerCase()))
    );
  }

  function toCandidate(post: ParsedPost): ImageCandidate {
    return {
      providerKey: config.key,
      providerItemId: post.id,
      canonicalSourceKey: canonicalizeSourceUrl(post.sourceUrl),
      perceptualHash: null,
      md5: post.md5,
      remoteUrl: post.remoteUrl,
      sampleUrl: post.sampleUrl,
      sourceUrl: post.sourceUrl,
      // DAPI exposes one uncategorized tag string, so artist-like tags are not
      // identity evidence.
      artistName: null,
      artistUrl: null,
      width: post.width,
      height: post.height,
      byteSize: post.byteSize,
      extension: `.${post.extension}`,
      dominantColor: config.dominantColor,
      contentRating: post.contentRating,
      nativeRating: post.nativeRating,
      isNsfw: post.contentRating !== 'safe',
      isAnimated: isAnimated(post),
      tags: post.tags,
    };
  }

  function dapiUrl(
    tags: readonly string[],
    limit: number,
    page: number,
    credential: ProviderCredential | undefined,
  ): string {
    const params = new URLSearchParams({
      page: 'dapi',
      s: 'post',
      q: 'index',
      json: '1',
      limit: String(Math.min(config.maxLimit, Math.max(1, Math.trunc(limit)))),
      pid: String(Math.max(0, Math.trunc(page))),
      tags: tags.join(' '),
    });
    if (credential !== undefined) {
      params.set('api_key', credential.apiKey);
      params.set('user_id', credential.userId);
    }
    return `${config.apiUrl}?${params.toString()}`;
  }

  function buildUrl(
    settings: AppSettings,
    count = 4,
    distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
    page = 0,
    credential?: ProviderCredential,
  ): string {
    const effectiveSettings = applyDistributionToSettings(settings, distributionPolicy);
    return dapiUrl(
      [...ratingQuery(effectiveSettings.nsfwMode), ...HARD_EXCLUSION_QUERY_TAGS],
      count,
      page,
      credential,
    );
  }

  function searchTags(request: SearchRequest): string[] {
    return [
      ...ratingQuery(request.nsfwMode),
      ...request.tags.map((tag) => tag.trim()).filter(Boolean),
      ...request.excludedTags.map((tag) => `-${tag.trim()}`).filter((tag) => tag !== '-'),
      ...HARD_EXCLUSION_QUERY_TAGS,
    ];
  }

  function searchUrl(
    request: SearchRequest,
    limit: number,
    page: number,
    credential: ProviderCredential | undefined,
  ): string {
    return dapiUrl(searchTags(request), limit, page, credential);
  }

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
    let abortCause: 'caller' | 'timeout' | null = null;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abortRequest = (cause: 'caller' | 'timeout') => {
      if (abortCause !== null) return;
      abortCause = cause;
      controller.abort();
      rejectAbort(new Error(`${config.label} request aborted by ${cause}`));
    };
    const onCallerAbort = () => abortRequest('caller');
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal?.aborted) abortRequest('caller');
    const timeout = setTimeout(() => abortRequest('timeout'), requestTimeoutMs);
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (abortCause === 'caller') {
        throw new GelbooruDapiApiError('aborted', `${config.label} request was aborted`, { cause: error });
      }
      if (abortCause === 'timeout') {
        throw new GelbooruDapiApiError('timeout', `${config.label} request timed out`, { cause: error });
      }
      if (error instanceof GelbooruDapiApiError) throw error;
      throw new GelbooruDapiApiError('network', `${config.label} request failed`, { cause: error });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async function requestByteSize(
    remoteUrl: string,
    callerSignal: AbortSignal,
    fetcher: GelbooruDapiFetcher,
  ): Promise<number> {
    if (callerSignal.aborted) {
      throw new GelbooruDapiApiError('aborted', `${config.label} request was aborted`);
    }
    const controller = new AbortController();
    let outcome: 'caller' | 'timeout' | null = null;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const abort = (reason: 'caller' | 'timeout') => {
      if (outcome !== null) return;
      outcome = reason;
      controller.abort();
      rejectDeadline(new Error(`Gelbooru image probe ${reason}`));
    };
    const onCallerAbort = () => abort('caller');
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => abort('timeout'), probeTimeoutMs);
    try {
      const init: RequestInit = { method: 'HEAD', signal: controller.signal };
      if (config.imageHeaders !== undefined) init.headers = config.imageHeaders;
      const response = await Promise.race([fetcher(remoteUrl, init), deadline]);
      if (
        !response.ok ||
        response.status < 200 ||
        response.status >= 300
      ) return 0;
      const rawLength = response.headers.get('content-length')?.trim() ?? '';
      if (!/^\d+$/u.test(rawLength)) return 0;
      const byteSize = Number(rawLength);
      return Number.isSafeInteger(byteSize) && byteSize > 0 ? byteSize : 0;
    } catch (error) {
      if (outcome === 'caller') {
        throw new GelbooruDapiApiError('aborted', `${config.label} request was aborted`, {
          cause: error,
        });
      }
      return 0;
    } finally {
      clearTimeout(timeout);
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  async function requestJson(
    url: string,
    signal: AbortSignal,
    fetcher: GelbooruDapiFetcher,
  ): Promise<unknown> {
    const response = await fetcher(url, { headers: config.headers, signal });
    if (!response.ok) {
      // 401 is Gelbooru's key rejection; Rule34 returns its own 200 "Missing
      // authentication" sentinel, handled in unwrapPostList. A 403 is a
      // Cloudflare/WAF block, not a key verdict (measured 2026-10-03).
      const authRejected = response.status === 401;
      const rateLimited = response.status === 429;
      // Error messages carry the status only — never the URL (which holds the
      // credential).
      throw new GelbooruDapiApiError(
        authRejected ? 'auth' : rateLimited ? 'rate_limited' : 'http',
        `${config.label} request failed with status ${response.status}`,
        {
          status: response.status,
          retryAfterMs: rateLimited ? retryAfterMs(response) : undefined,
        },
      );
    }
    try {
      const text = await response.text();
      if (text.trim().length === 0) {
        // A genuinely empty (0-byte) HTTP-200 body — live-confirmed on
        // Rule34.xxx 2026-09-05 for a zero-result query (its `general`-rated
        // corpus for a common tag can be empty; Rule34 is NSFW-skewed by
        // design) — is not valid JSON, but it IS the same "legitimate-empty
        // results ... -> empty batch, not failure" case the bare `[]` shape
        // documented above already covers. Without this, `JSON.parse('')`'s
        // SyntaxError would surface as `invalid_response`, turning an
        // ordinary zero-result page into a spurious provider failure.
        return [];
      }
      return JSON.parse(text);
    } catch (error) {
      throw new GelbooruDapiApiError('invalid_response', `${config.label} returned invalid JSON`, {
        cause: error,
      });
    }
  }

  async function adaptPosts(
    values: unknown[],
    excludedIds: ReadonlySet<string>,
    settings: Pick<
      AppSettings,
      'nsfwMode' | 'orientation' | 'animationMode' | 'minWidth' | 'maxBytes' | 'includedTags' | 'excludedTags'
    >,
    distributionPolicy: DistributionPolicy,
    signal: AbortSignal,
    fetcher: GelbooruDapiFetcher,
  ): Promise<ImageCandidate[]> {
    const admitted: ImageCandidate[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const post = parsePost(value);
      if (post === null) continue;
      if (seen.has(post.id) || excludedIds.has(post.id) || hasHardExcludedTag(post)) continue;
      seen.add(post.id);
      const candidate = toCandidate(post);
      if (
        isImageAllowedByDistribution(candidate, distributionPolicy) &&
        matchesCandidateSettings(candidate, { ...settings, maxBytes: 0 } as AppSettings)
      ) {
        admitted.push(candidate);
      }
    }
    const sized = await Promise.all(admitted.map(async (candidate) => {
      const isGif = candidate.extension.trim().toLowerCase() === '.gif';
      if (candidate.byteSize !== 0 || (!isGif && settings.maxBytes === 0)) {
        return candidate;
      }
      const byteSize = await requestByteSize(candidate.remoteUrl, signal, fetcher);
      return byteSize > 0 ? { ...candidate, byteSize } : candidate;
    }));
    return sized.filter((candidate) => matchesCandidateSettings(candidate, settings as AppSettings));
  }

  async function fetchBatch({
    settings,
    excludedIds,
    count = 4,
    signal,
    fetcher = expoFetch as unknown as GelbooruDapiFetcher,
    governor,
    distributionPolicy = APP_DISTRIBUTION_POLICY,
    credential,
  }: GelbooruDapiBatchInput): Promise<GelbooruDapiBatch> {
    const effectiveSettings = applyDistributionToSettings(settings, distributionPolicy);
    const limit = Math.min(discoveryLimitCap, Math.max(1, Math.trunc(count)));
    const page = Math.floor(Math.random() * DISCOVERY_PAGE_SPAN);
    return runRequest(governor, signal, async (governedSignal) => {
      const values = await withDeadline(governedSignal, async (requestSignal) => {
        const response = await requestJson(
          buildUrl(effectiveSettings, limit, distributionPolicy, page, credential),
          requestSignal,
          fetcher,
        );
        return unwrapPostList(response, config.responseListKey, config.label).slice(0, limit);
      });
      return {
        items: await adaptPosts(
          values,
          new Set(excludedIds.slice(0, 100)),
          effectiveSettings,
          distributionPolicy,
          governedSignal,
          fetcher,
        ),
        totalCount: values.length,
      };
    });
  }

  function matchesSearchRequest(image: ImageCandidate, request: SearchRequest): boolean {
    if (!matchesContentMode(candidateContentRating(image), request.nsfwMode)) return false;
    if (request.orientation === 'portrait' && image.width >= image.height) return false;
    if (request.orientation === 'landscape' && image.width <= image.height) return false;
    if (request.animationMode === 'exclude' && image.isAnimated) return false;
    if (request.animationMode === 'only' && !image.isAnimated) return false;
    if (request.minWidth !== 0 && image.width < request.minWidth) return false;
    if (request.maxBytes !== 0 && image.byteSize > request.maxBytes) return false;
    return true;
  }

  async function fetchSearchPage({
    request,
    cursor,
    limit = 20,
    signal,
    fetcher = expoFetch as unknown as GelbooruDapiFetcher,
    governor,
    distributionPolicy = APP_DISTRIBUTION_POLICY,
    credential,
  }: GelbooruDapiSearchPageInput): Promise<GelbooruDapiSearchPage<K>> {
    const effectiveRequest = applyDistributionToSearchRequest(request, distributionPolicy);
    if (cursor === null) return { providerKey: config.key, items: [], nextCursor: null };
    const page = cursor?.page ?? 0;
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new GelbooruDapiApiError('invalid_response', `${config.label} search cursor is invalid`);
    }
    const pageLimit = Math.min(config.maxLimit, Math.max(1, Math.trunc(limit)));
    return runRequest(governor, signal, async (governedSignal) => {
      const values = await withDeadline(governedSignal, async (requestSignal) => {
        const response = await requestJson(
          searchUrl(effectiveRequest, pageLimit, page, credential),
          requestSignal,
          fetcher,
        );
        return unwrapPostList(response, config.responseListKey, config.label).slice(0, pageLimit);
      });
      const images = await adaptPosts(
        values,
        new Set(),
        { ...effectiveRequest, includedTags: [], excludedTags: effectiveRequest.excludedTags },
        distributionPolicy,
        governedSignal,
        fetcher,
      );
      const items: SearchHit[] = images
        .filter((image) => matchesSearchRequest(image, effectiveRequest))
        .map((image) => ({
          key: `${config.key}:${image.providerItemId}`,
          // R8.24: tiles render the medium sample, never the multi-MB original.
          previewUrl: image.sampleUrl ?? image.remoteUrl,
          image,
        }));
      return {
        providerKey: config.key,
        items,
        nextCursor: values.length === pageLimit ? { page: page + 1 } : null,
      };
    });
  }

  return { fetchBatch, fetchSearchPage, buildUrl, ApiError: GelbooruDapiApiError };
}
