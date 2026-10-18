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
 * Shared Moebooru (Yande.re / Konachan / …) client engine. Behaviour is a
 * byte-faithful lift of the original `yandere-client.ts`; only the constants
 * captured by {@link MoebooruEngineConfig} differ between instances. No
 * filtering, timeout, pagination, rating, or error-classification logic is
 * changed here relative to that source.
 */

export const MOEBOORU_NATIVE_RATINGS = ['s', 'q', 'e'] as const;
export type MoebooruRating = typeof MOEBOORU_NATIVE_RATINGS[number];
const MOEBOORU_NATIVE_RATING_SET: ReadonlySet<string> = new Set(MOEBOORU_NATIVE_RATINGS);

const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_DISCOVERY_LIMIT_CAP = 8;

export type MoebooruApiErrorCode =
  | 'http'
  | 'rate_limited'
  | 'network'
  | 'aborted'
  | 'timeout'
  | 'invalid_response';

export class MoebooruApiError extends Error {
  readonly code: MoebooruApiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: MoebooruApiErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'MoebooruApiError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, MoebooruApiError.prototype);
  }
}

export type MoebooruEngineConfig<K extends ImageProviderKey = ImageProviderKey> = {
  /** Provider key; also the governor key and search-hit prefix. */
  key: K;
  /** Human label used verbatim in error messages (e.g. `Yande.re`). */
  label: string;
  /** Post-list endpoint, e.g. `https://yande.re/post.json`. */
  postUrl: string;
  /** Trusted host for `file_url`/`preview_url` and source-url fallback. */
  host: string;
  headers: Record<string, string>;
  maxLimit: number;
  dominantColor: string;
  toContentRating: (rating: MoebooruRating) => ContentRating;
  hardExclusionTags: ReadonlySet<string>;
  /** Exclusion tags sent as `-tag` in the query URL. Defaults to hardExclusionTags.
   *  Konachan caps anonymous queries at 7 tags, so it sends only the safety-critical
   *  subset here and relies on client-side hasHardExcludedTag for the rest. */
  queryExclusionTags?: ReadonlySet<string>;
  requestTimeoutMs?: number;
  discoveryLimitCap?: number;
  /** Tag appended to DISCOVERY queries only, to vary the sample across refills.
   *  Verified 2026-08-31 against konachan.com and yande.re: `order:random`
   *  returns HTTP 200 and a different id set on every call. Counts as one tag
   *  against Konachan's anonymous 7-tag ceiling (G2a-1 task4) — budget with
   *  rating:s + -loli + -shota is 4/7, safe. Fallback if a future instance
   *  rejects it: the randomized-page pattern at safebooru-client.ts:456. */
  discoverySampleTag?: string;
};

export type MoebooruFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type MoebooruBatch = { items: ImageCandidate[]; totalCount: number };

export type MoebooruBatchInput = {
  settings: AppSettings;
  excludedIds: readonly string[];
  count?: number;
  signal?: AbortSignal;
  fetcher?: MoebooruFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type MoebooruSearchPageInput = {
  request: SearchRequest;
  cursor?: { page: number } | null;
  limit?: number;
  signal?: AbortSignal;
  fetcher?: MoebooruFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type MoebooruSearchPage<K extends ImageProviderKey> = {
  providerKey: K;
  items: SearchHit[];
  nextCursor: { page: number } | null;
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
  rating: MoebooruRating;
  tags: string[];
  /** Byte-exact MD5 hex digest (lowercased), when present. Plain string —
   *  never a Buffer (Hermes-safety). */
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

function ratingQuery(mode: AppSettings['nsfwMode'] | SearchRequest['nsfwMode']): string[] {
  if (mode === 'sfw') return ['rating:s'];
  if (mode === 'nsfw') return ['rating:e'];
  return [];
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export type MoebooruEngine<K extends ImageProviderKey> = {
  fetchBatch: (input: MoebooruBatchInput) => Promise<MoebooruBatch>;
  fetchSearchPage: (input: MoebooruSearchPageInput) => Promise<MoebooruSearchPage<K>>;
  buildUrl: (
    settings: AppSettings,
    count?: number,
    distributionPolicy?: DistributionPolicy,
    page?: number,
  ) => string;
  ApiError: typeof MoebooruApiError;
};

export function createMoebooruEngine<K extends ImageProviderKey>(
  config: MoebooruEngineConfig<K>,
): MoebooruEngine<K> {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const discoveryLimitCap = config.discoveryLimitCap ?? DEFAULT_DISCOVERY_LIMIT_CAP;
  const hardExclusionQueryTags = [...(config.queryExclusionTags ?? config.hardExclusionTags)].map(
    (tag) => `-${tag}`,
  );

  function trustedUrl(value: unknown): string | null {
    const raw = nonEmptyString(value);
    if (raw === null) return null;
    try {
      const url = new URL(raw);
      if (
        url.protocol !== 'https:' ||
        (url.hostname !== config.host && !url.hostname.endsWith(`.${config.host}`)) ||
        url.username || url.password || url.port
      ) return null;
      return url.toString();
    } catch {
      return null;
    }
  }

  function parsePost(value: unknown): ParsedPost {
    if (!isRecord(value)) {
      throw new MoebooruApiError('invalid_response', `${config.label} returned invalid post metadata`);
    }
    const id = positiveInteger(value.id);
    const width = positiveInteger(value.width);
    const height = positiveInteger(value.height);
    const byteSize = positiveInteger(value.file_size);
    const remoteUrl = trustedUrl(value.file_url);
    const previewUrl = trustedUrl(value.preview_url) ?? remoteUrl;
    const rating = typeof value.rating === 'string' && MOEBOORU_NATIVE_RATING_SET.has(value.rating)
      ? value.rating as MoebooruRating
      : null;
    const extension = (nonEmptyString(value.file_ext) ?? '').toLowerCase().replace(/^\./, '');
    const tags = (nonEmptyString(value.tags) ?? '').split(/\s+/).filter(Boolean);
    if (
      id === null || width === null || height === null || byteSize === null ||
      remoteUrl === null || previewUrl === null || rating === null || extension.length === 0
    ) {
      throw new MoebooruApiError('invalid_response', `${config.label} returned incomplete image metadata`);
    }
    // R8.18: medium display image; the deck renders this, not the original.
    const sampleUrl = trustedUrl(value.sample_url) ?? remoteUrl;
    return {
      id: String(id), width, height, byteSize, remoteUrl, previewUrl, sampleUrl,
      sourceUrl: safeUrl(value.source) ?? `https://${config.host}/post/show/${id}`,
      extension, rating, tags,
      md5: normalizedMd5Hex(value.md5),
    };
  }

  function hasHardExcludedTag(post: ParsedPost): boolean {
    return post.tags.some((tag) => config.hardExclusionTags.has(tag.toLowerCase()));
  }

  function postUrl(tags: readonly string[], limit: number, page: number): string {
    const params = new URLSearchParams({
      limit: String(Math.min(config.maxLimit, Math.max(1, Math.trunc(limit)))),
      page: String(Math.max(1, Math.trunc(page))),
      tags: tags.join(' '),
    });
    return `${config.postUrl}?${params.toString()}`;
  }

  function buildUrl(
    settings: AppSettings,
    count = 4,
    distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
    page = 1,
  ): string {
    const effectiveSettings = applyDistributionToSettings(settings, distributionPolicy);
    return postUrl(
      [
        ...ratingQuery(effectiveSettings.nsfwMode),
        ...hardExclusionQueryTags,
        ...(config.discoverySampleTag ? [config.discoverySampleTag] : []),
      ],
      count,
      page,
    );
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
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
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
      if (abortCause === 'caller') throw new MoebooruApiError('aborted', `${config.label} request was aborted`, { cause: error });
      if (abortCause === 'timeout') throw new MoebooruApiError('timeout', `${config.label} request timed out`, { cause: error });
      if (error instanceof MoebooruApiError) throw error;
      throw new MoebooruApiError('network', `${config.label} request failed`, { cause: error });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async function requestJson(url: string, signal: AbortSignal, fetcher: MoebooruFetcher): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, { headers: config.headers, signal });
    } catch (error) {
      throw error;
    }
    if (!response.ok) {
      throw new MoebooruApiError(
        response.status === 429 ? 'rate_limited' : 'http',
        `${config.label} request failed with status ${response.status}`,
        { status: response.status, retryAfterMs: response.status === 429 ? retryAfterMs(response) : undefined },
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new MoebooruApiError('invalid_response', `${config.label} returned invalid JSON`, { cause: error });
    }
  }

  function toCandidate(post: ParsedPost): ImageCandidate {
    const contentRating = config.toContentRating(post.rating);
    return {
      providerKey: config.key,
      providerItemId: post.id,
      canonicalSourceKey: canonicalizeSourceUrl(post.sourceUrl),
      perceptualHash: null,
      md5: post.md5,
      remoteUrl: post.remoteUrl,
      sampleUrl: post.sampleUrl,
      sourceUrl: post.sourceUrl,
      artistName: null,
      artistUrl: null,
      width: post.width,
      height: post.height,
      byteSize: post.byteSize,
      extension: `.${post.extension}`,
      dominantColor: config.dominantColor,
      contentRating,
      nativeRating: post.rating,
      isNsfw: contentRating !== 'safe',
      isAnimated: post.extension === 'gif',
      tags: post.tags,
    };
  }

  async function adaptPosts(
    values: unknown[],
    excludedIds: ReadonlySet<string>,
    settings: Pick<AppSettings, 'nsfwMode' | 'orientation' | 'animationMode' | 'minWidth' | 'maxBytes' | 'includedTags' | 'excludedTags'>,
    distributionPolicy: DistributionPolicy,
  ): Promise<ImageCandidate[]> {
    const items: ImageCandidate[] = [];
    const seen = new Set<string>();
    for (const post of values.map(parsePost)) {
      if (seen.has(post.id) || excludedIds.has(post.id) || hasHardExcludedTag(post)) continue;
      seen.add(post.id);
      const candidate = toCandidate(post);
      if (
        matchesContentMode(candidateContentRating(candidate), settings.nsfwMode) &&
        isImageAllowedByDistribution(candidate, distributionPolicy) &&
        matchesCandidateSettings(candidate, settings as AppSettings)
      ) items.push(candidate);
    }
    return items;
  }

  async function fetchBatch({
    settings,
    excludedIds,
    count = 4,
    signal,
    fetcher = expoFetch as unknown as MoebooruFetcher,
    governor,
    distributionPolicy = APP_DISTRIBUTION_POLICY,
  }: MoebooruBatchInput): Promise<MoebooruBatch> {
    // buildUrl re-applies the distribution policy internally; harmless because
    // applyDistributionToSettings is idempotent. Do not "simplify" into a real
    // double-transform, and don't copy the redundant pattern into new call sites.
    const effectiveSettings = applyDistributionToSettings(settings, distributionPolicy);
    const limit = Math.min(discoveryLimitCap, Math.max(1, Math.trunc(count)));
    return runRequest(governor, signal, (governedSignal) => withDeadline(
      governedSignal,
      async (requestSignal) => {
        const response = await requestJson(
          buildUrl(effectiveSettings, limit, distributionPolicy),
          requestSignal,
          fetcher,
        );
        if (!Array.isArray(response)) throw new MoebooruApiError('invalid_response', `${config.label} returned invalid posts`);
        const values = response.slice(0, limit);
        return {
          items: await adaptPosts(values, new Set(excludedIds.slice(0, 100)), effectiveSettings, distributionPolicy),
          totalCount: values.length,
        };
      },
    ));
  }

  function searchTags(request: SearchRequest): string[] {
    return [
      ...ratingQuery(request.nsfwMode),
      ...request.tags.map((tag) => tag.trim()).filter(Boolean),
      ...request.excludedTags.map((tag) => `-${tag.trim()}`).filter(Boolean),
      ...hardExclusionQueryTags,
    ];
  }

  async function fetchSearchPage({
    request,
    cursor,
    limit = 20,
    signal,
    fetcher = expoFetch as unknown as MoebooruFetcher,
    governor,
    distributionPolicy = APP_DISTRIBUTION_POLICY,
  }: MoebooruSearchPageInput): Promise<MoebooruSearchPage<K>> {
    const effectiveRequest = applyDistributionToSearchRequest(request, distributionPolicy);
    if (cursor === null) return { providerKey: config.key, items: [], nextCursor: null };
    const page = cursor?.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1) throw new MoebooruApiError('invalid_response', `${config.label} search cursor is invalid`);
    const pageLimit = Math.min(config.maxLimit, Math.max(1, Math.trunc(limit)));
    return runRequest(governor, signal, (governedSignal) => withDeadline(
      governedSignal,
      async (requestSignal) => {
        const response = await requestJson(postUrl(searchTags(effectiveRequest), pageLimit, page), requestSignal, fetcher);
        if (!Array.isArray(response)) throw new MoebooruApiError('invalid_response', `${config.label} returned invalid posts`);
        const values = response.slice(0, pageLimit);
        const images = await adaptPosts(values, new Set(), {
          ...effectiveRequest, includedTags: [], excludedTags: effectiveRequest.excludedTags,
        }, distributionPolicy);
        return {
          providerKey: config.key,
          items: images.map((image) => ({
            key: `${config.key}:${image.providerItemId}`,
            // R8.24: tiles render the medium sample, never the multi-MB original.
            previewUrl: image.sampleUrl ?? image.remoteUrl,
            image,
          })),
          nextCursor: values.length === pageLimit ? { page: page + 1 } : null,
        };
      },
    ));
  }

  return { fetchBatch, fetchSearchPage, buildUrl, ApiError: MoebooruApiError };
}
