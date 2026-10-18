import { fetch as expoFetch } from 'expo/fetch';

import {
  candidateContentRating,
  matchesContentMode,
  waifuContentRating,
} from '@/features/content/content-taxonomy';
import {
  APP_DISTRIBUTION_POLICY,
  applyDistributionToSearchRequest,
  applyDistributionToSettings,
  isImageAllowedByDistribution,
  type DistributionPolicy,
} from '@/features/distribution/distribution-policy';
import {
  matchesCandidateSettings,
  normalizeProviderTag,
} from '@/features/providers/candidate-filter';
import { canonicalizeSourceUrl } from '@/features/providers/source-identity';
import type { ProviderRequestGovernor } from '@/features/providers/provider-resilience';
import type {
  ProviderCursor,
  ProviderSearchPage,
  SearchHit,
  SearchRequest,
} from '@/features/search/types';

import type { AppSettings, ImageCandidate } from './types';

const WAIFU_API_URL = 'https://api.waifu.im/images';
export const WAIFU_REQUEST_TIMEOUT_MS = 10_000;
const WAIFU_API_HEADERS = { 'Accept-Version': 'v7' } as const;
const WAIFU_IMAGE_HOST = 'cdn.waifu.im';
const WAIFU_SOURCE_HOSTS = [
  'deviantart.com',
  'patreon.com',
  'pixiv.net',
  'reddit.com',
  'twitter.com',
  'x.com',
] as const;

export type WaifuApiErrorCode =
  | 'http'
  | 'rate_limited'
  | 'network'
  | 'aborted'
  | 'timeout'
  | 'invalid_response';

export class WaifuApiError extends Error {
  readonly code: WaifuApiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly unsupportedQuery?: boolean;

  constructor(
    code: WaifuApiErrorCode,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      unsupportedQuery?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'WaifuApiError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.unsupportedQuery = options.unsupportedQuery;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, WaifuApiError.prototype);
  }
}

export type WaifuFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type FetchWaifuBatchInput = {
  settings: AppSettings;
  excludedIds: number[];
  pageSize?: number;
  signal?: AbortSignal;
  fetcher?: WaifuFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type FetchWaifuSearchPageInput = {
  request: SearchRequest;
  cursor?: ProviderCursor['waifu_im'] | null;
  limit?: number;
  signal?: AbortSignal;
  fetcher?: WaifuFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type WaifuBatch = {
  items: ImageCandidate[];
  totalCount: number;
};

function runWaifuRequest<T>(
  governor: ProviderRequestGovernor | undefined,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return governor
    ? governor.execute('waifu_im', operation, signal)
    : operation(signal ?? new AbortController().signal);
}

type ApiArtist = {
  name?: unknown;
  pixiv?: unknown;
  twitter?: unknown;
  patreon?: unknown;
  deviantArt?: unknown;
};
type ApiImage = {
  id?: unknown;
  url?: unknown;
  source?: unknown;
  artists?: unknown;
  width?: unknown;
  height?: unknown;
  byteSize?: unknown;
  extension?: unknown;
  dominantColor?: unknown;
  isNsfw?: unknown;
  isAnimated?: unknown;
  tags?: unknown;
  perceptualHash?: unknown;
};

function mapNsfwMode(mode: AppSettings['nsfwMode']): string {
  return mode === 'mixed' ? 'All' : mode === 'nsfw' ? 'True' : 'False';
}

function mapAnimationMode(mode: AppSettings['animationMode']): string {
  return mode === 'only' ? 'True' : 'False';
}

function mapOrientation(mode: AppSettings['orientation']): string {
  return mode === 'landscape' ? 'Landscape' : 'Portrait';
}

function fixedIncludedTags(tags: string[]): string[] {
  return ['waifu', ...tags.filter((tag) => tag !== 'waifu')];
}

export function buildWaifuUrl(
  settings: AppSettings,
  excludedIds: number[] = [],
  pageSize = 20,
  distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): string {
  const effectiveSettings = applyDistributionToSettings(
    settings,
    distributionPolicy,
  );
  const params = new URLSearchParams({
    IsNsfw: mapNsfwMode(effectiveSettings.nsfwMode),
    PageSize: String(Math.min(20, Math.max(1, Math.trunc(pageSize)))),
  });

  if (effectiveSettings.animationMode !== 'include') {
    params.append('IsAnimated', mapAnimationMode(effectiveSettings.animationMode));
  }
  if (effectiveSettings.orientation !== 'any') {
    params.append('Orientation', mapOrientation(effectiveSettings.orientation));
  }

  for (const tag of fixedIncludedTags(effectiveSettings.includedTags)) {
    params.append('IncludedTags', tag);
  }
  for (const tag of effectiveSettings.excludedTags) {
    params.append('ExcludedTags', tag);
  }
  if (effectiveSettings.minWidth !== 0) {
    params.append('Width', `>=${effectiveSettings.minWidth}`);
  }
  if (effectiveSettings.maxBytes !== 0) {
    params.append('ByteSize', `<=${effectiveSettings.maxBytes}`);
  }

  for (const id of excludedIds.slice(0, 100)) {
    if (Number.isInteger(id) && id >= 0) params.append('ExcludedIds', String(id));
  }

  return `${WAIFU_API_URL}?${params.toString()}`;
}

function toWaifuTag(tag: string): string {
  return tag.trim();
}

function buildWaifuSearchUrl(
  request: SearchRequest,
  page: number,
  pageSize: number,
  distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): string {
  const effectiveRequest = applyDistributionToSearchRequest(
    request,
    distributionPolicy,
  );
  const params = new URLSearchParams({
    IsNsfw: mapNsfwMode(effectiveRequest.nsfwMode),
    Page: String(page),
    PageSize: String(pageSize),
    OrderBy: 'UploadedAt',
  });

  if (effectiveRequest.animationMode !== 'include') {
    params.append('IsAnimated', mapAnimationMode(effectiveRequest.animationMode));
  }
  if (effectiveRequest.orientation !== 'any') {
    params.append('Orientation', mapOrientation(effectiveRequest.orientation));
  }
  for (const tag of effectiveRequest.tags) {
    if (tag.trim().length > 0) params.append('IncludedTags', toWaifuTag(tag));
  }
  for (const tag of effectiveRequest.excludedTags) {
    params.append('ExcludedTags', toWaifuTag(tag));
  }
  if (effectiveRequest.minWidth !== 0) {
    params.append('Width', `>=${effectiveRequest.minWidth}`);
  }
  if (effectiveRequest.maxBytes !== 0) {
    params.append('ByteSize', `<=${effectiveRequest.maxBytes}`);
  }

  return `${WAIFU_API_URL}?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Stable display-link priority for Waifu.im's four documented artist fields.
const ARTIST_URL_FIELDS = ['pixiv', 'twitter', 'patreon', 'deviantArt'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function trustedHttpsUrl(
  value: string,
  isTrustedHost: (hostname: string) => boolean,
): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      !isTrustedHost(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function trustedWaifuImageUrl(value: string): string | null {
  return trustedHttpsUrl(value, (hostname) => hostname === WAIFU_IMAGE_HOST);
}

function trustedWaifuSourceUrl(value: string): string | null {
  return trustedHttpsUrl(value, (hostname) =>
    WAIFU_SOURCE_HOSTS.some(
      (trustedHost) =>
        hostname === trustedHost || hostname.endsWith(`.${trustedHost}`),
    ),
  );
}

function isUsableArtist(value: unknown): value is ApiArtist {
  return (
    isRecord(value) &&
    (isNonEmptyString(value.name) ||
      ARTIST_URL_FIELDS.some((field) => isNonEmptyString(value[field])))
  );
}

function parseArtistUrl(artist: ApiArtist | undefined): string | null {
  if (artist === undefined) return null;

  for (const field of ARTIST_URL_FIELDS) {
    if (isNonEmptyString(artist[field])) return artist[field];
  }
  return null;
}

function parseImage(value: unknown): ImageCandidate | null {
  if (!isRecord(value)) return null;
  const image = value as ApiImage;
  if (
    !isFiniteNumber(image.id) ||
    typeof image.url !== 'string' ||
    // R8.12: dimensions must be strictly positive, not merely finite. A
    // zero-size candidate reaches the deck as a blank frame (the contain math
    // degenerates); every other source family already rejects these via
    // positiveInteger.
    !isFiniteNumber(image.width) ||
    !isFiniteNumber(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    !isFiniteNumber(image.byteSize) ||
    typeof image.extension !== 'string' ||
    typeof image.isNsfw !== 'boolean' ||
    typeof image.isAnimated !== 'boolean'
  ) {
    return null;
  }

  const artists = Array.isArray(image.artists) ? (image.artists as ApiArtist[]) : [];
  const artist = artists.find(isUsableArtist);
  const tags = Array.isArray(image.tags) ? image.tags : [];
  const sourceUrl = typeof image.source === 'string' ? image.source : null;

  const normalizedTags = tags.flatMap((tag) =>
    isRecord(tag) && typeof tag.slug === 'string' ? [tag.slug] : [],
  );
  const contentRating = waifuContentRating(image.isNsfw);

  return {
    providerKey: 'waifu_im',
    providerItemId: String(image.id),
    canonicalSourceKey: canonicalizeSourceUrl(sourceUrl),
    perceptualHash: isNonEmptyString(image.perceptualHash)
      ? image.perceptualHash.trim().toLowerCase()
      : null,
    md5: null,
    remoteUrl: image.url,
    // waifu.im publishes no distinct sample; the deck shows the original.
    sampleUrl: image.url,
    sourceUrl,
    artistName: isNonEmptyString(artist?.name) ? artist.name : null,
    artistUrl: parseArtistUrl(artist),
    width: image.width,
    height: image.height,
    byteSize: image.byteSize,
    extension: image.extension,
    dominantColor:
      typeof image.dominantColor === 'string' ? image.dominantColor : '#D8D6D0',
    contentRating,
    nativeRating: image.isNsfw ? 'true' : 'false',
    isNsfw: contentRating !== 'safe',
    isAnimated: image.isAnimated,
    tags: normalizedTags,
  };
}

function sanitizeWaifuImage(image: ImageCandidate): ImageCandidate | null {
  const remoteUrl = trustedWaifuImageUrl(image.remoteUrl);
  if (remoteUrl === null) return null;
  const sourceUrl = image.sourceUrl === null
    ? null
    : trustedWaifuSourceUrl(image.sourceUrl);
  return {
    ...image,
    remoteUrl,
    sourceUrl,
    canonicalSourceKey: canonicalizeSourceUrl(sourceUrl),
  };
}

function matchesWaifuSearchRequest(
  image: ImageCandidate,
  request: SearchRequest,
): boolean {
  const tags = new Set(image.tags.map(normalizeProviderTag));
  const excludedTags = request.excludedTags.map(normalizeProviderTag);
  // Included terms are interpreted by Waifu.im. Re-applying them against the
  // returned tag slugs would break source-native queries and operators.
  if (excludedTags.some((tag) => tags.has(tag))) return false;
  if (!matchesContentMode(candidateContentRating(image), request.nsfwMode)) return false;
  if (request.orientation === 'portrait' && image.width >= image.height) return false;
  if (request.orientation === 'landscape' && image.width <= image.height) return false;
  if (request.animationMode === 'exclude' && image.isAnimated) return false;
  if (request.animationMode === 'only' && !image.isAnimated) return false;
  if (request.minWidth !== 0 && image.width < request.minWidth) return false;
  if (request.maxBytes !== 0 && image.byteSize > request.maxBytes) return false;
  return true;
}

export function parseWaifuResponse(value: unknown): WaifuBatch {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new WaifuApiError('invalid_response', 'Waifu.im returned an invalid response');
  }

  return {
    items: value.items.flatMap((item) => {
      const parsed = parseImage(item);
      return parsed === null ? [] : [parsed];
    }),
    totalCount: isFiniteNumber(value.totalCount) ? value.totalCount : value.items.length,
  };
}

function parseWaifuSearchPage(
  value: unknown,
  expectedPage: number,
  request: SearchRequest,
): { hits: SearchHit[]; totalCount: number; hasNextPage: boolean; pageNumber: number } {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.pageNumber) ||
    !Number.isInteger(value.totalPages) ||
    !Number.isInteger(value.totalCount) ||
    typeof value.hasNextPage !== 'boolean'
  ) {
    throw new WaifuApiError('invalid_response', 'Waifu.im returned invalid pagination');
  }

  const pageNumber = value.pageNumber as number;
  const totalPages = value.totalPages as number;
  const totalCount = value.totalCount as number;
  if (
    pageNumber !== expectedPage ||
    pageNumber < 1 ||
    totalPages < 0 ||
    totalCount < 0 ||
    value.hasNextPage !== (pageNumber < totalPages)
  ) {
    throw new WaifuApiError('invalid_response', 'Waifu.im returned invalid pagination');
  }

  const batch = parseWaifuResponse(value);
  return {
    hits: batch.items.flatMap((candidate) => {
      const image = sanitizeWaifuImage(candidate);
      if (image === null || !matchesWaifuSearchRequest(image, request)) return [];
      return [{
        key: `${image.providerKey}:${image.providerItemId}`,
        // R8.24: tiles render the medium sample; waifu.im has none, so this
        // resolves back to the original.
        previewUrl: image.sampleUrl ?? image.remoteUrl,
        image,
      }];
    }),
    totalCount,
    hasNextPage: value.hasNextPage,
    pageNumber,
  };
}

function retryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const deadline = Date.parse(retryAfter);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - Date.now());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function withWaifuDeadline<T>(
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
    rejectAbort(new Error(`Waifu.im request aborted by ${cause}`));
  };
  const onCallerAbort = () => abortRequest('caller');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) abortRequest('caller');

  const timeout = setTimeout(
    () => abortRequest('timeout'),
    WAIFU_REQUEST_TIMEOUT_MS,
  );

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (abortCause === 'caller') {
      throw new WaifuApiError('aborted', 'Waifu.im request was aborted', { cause: error });
    }
    if (abortCause === 'timeout') {
      throw new WaifuApiError('timeout', 'Waifu.im request timed out', { cause: error });
    }
    if (error instanceof WaifuApiError) throw error;
    if (isAbortError(error)) {
      throw new WaifuApiError('aborted', 'Waifu.im request was aborted', { cause: error });
    }
    throw new WaifuApiError('network', 'Waifu.im request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function requestWaifuJson(
  url: string,
  signal: AbortSignal,
  fetcher: WaifuFetcher,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: WAIFU_API_HEADERS,
    signal,
  });
  if (!response.ok) {
    const rateLimited = response.status === 429;
    const errorBody = response.status === 400
      ? await response.json().catch(() => null)
      : null;
    const unsupportedQuery = isRecord(errorBody) &&
      isRecord(errorBody.errors) &&
      Object.keys(errorBody.errors).length > 0 &&
      Object.entries(errorBody.errors).every(([key, messages]) =>
        /^(?:IncludedTags|ExcludedTags)(?:\[\d+\])?$/.test(key) &&
        Array.isArray(messages) &&
        messages.length > 0 &&
        messages.every(isNonEmptyString),
      );
    throw new WaifuApiError(
      rateLimited ? 'rate_limited' : 'http',
      `Waifu.im request failed with status ${response.status}`,
      {
        status: response.status,
        retryAfterMs: rateLimited ? retryAfterMs(response) : undefined,
        unsupportedQuery,
      },
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new WaifuApiError(
      'invalid_response',
      'Waifu.im returned invalid JSON',
      { cause: error },
    );
  }
}

export async function fetchWaifuBatch({
  settings,
  excludedIds,
  pageSize,
  signal,
  fetcher = expoFetch as unknown as WaifuFetcher,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
}: FetchWaifuBatchInput): Promise<WaifuBatch> {
  const effectiveSettings = applyDistributionToSettings(
    settings,
    distributionPolicy,
  );
  return runWaifuRequest(governor, signal, (governedSignal) => withWaifuDeadline(
    governedSignal,
    async (requestSignal) => {
      const body = await requestWaifuJson(
        buildWaifuUrl(
          effectiveSettings,
          excludedIds,
          pageSize,
          distributionPolicy,
        ),
        requestSignal,
        fetcher,
      );
      const batch = parseWaifuResponse(body);
      return {
        ...batch,
        items: batch.items.flatMap((candidate) => {
          const image = sanitizeWaifuImage(candidate);
          return image !== null
            && isImageAllowedByDistribution(image, distributionPolicy)
            && matchesCandidateSettings(image, effectiveSettings)
            ? [image]
            : [];
        }),
      };
    },
  ));
}

export async function fetchWaifuSearchPage({
  request,
  cursor,
  limit = 20,
  signal,
  fetcher = expoFetch as unknown as WaifuFetcher,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
}: FetchWaifuSearchPageInput): Promise<
  Extract<ProviderSearchPage, { providerKey: 'waifu_im' }>
> {
  const effectiveRequest = applyDistributionToSearchRequest(
    request,
    distributionPolicy,
  );
  if (cursor === null) {
    return { providerKey: 'waifu_im', items: [], nextCursor: null };
  }
  const page = cursor?.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new WaifuApiError('invalid_response', 'Waifu.im search cursor is invalid');
  }
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 20;
  const pageSize = Math.min(20, Math.max(1, requestedLimit));
  try {
    return await runWaifuRequest(
      governor,
      signal,
      (governedSignal) => withWaifuDeadline(governedSignal, async (requestSignal) => {
        const body = await requestWaifuJson(
          buildWaifuSearchUrl(
            effectiveRequest,
            page,
            pageSize,
            distributionPolicy,
          ),
          requestSignal,
          fetcher,
        );
        const result = parseWaifuSearchPage(body, page, effectiveRequest);
        return {
          providerKey: 'waifu_im',
          items: result.hits.filter(({ image }) =>
            isImageAllowedByDistribution(image, distributionPolicy),
          ),
          nextCursor: result.hasNextPage ? { page: result.pageNumber + 1 } : null,
          total: result.totalCount,
        };
      }),
    );
  } catch (error) {
    if (
      error instanceof WaifuApiError &&
      error.unsupportedQuery === true
    ) {
      return {
        providerKey: 'waifu_im',
        items: [],
        nextCursor: null,
        total: 0,
        unsupportedQuery: true,
      };
    }
    throw error;
  }
}
