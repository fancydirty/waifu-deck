import { fetch as expoFetch } from 'expo/fetch';

import {
  matchesContentMode,
  nekosContentRating,
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
import type { AppSettings, ImageCandidate } from '@/features/waifu/types';

const NEKOS_RANDOM_API_URL = 'https://api.nekosapi.com/v5/images/random';
const NEKOS_SEARCH_API_URL = 'https://api.nekosapi.com/v5/images';
const NEKOS_CDN_HOST = 'cdn.nekosapi.com';
const NEKOS_SEARCH_LIMIT_MAX = 100;
const WEBP_HEADER_BYTES = 64;
export const NEKOS_REQUEST_TIMEOUT_MS = 12_000;

export type NekosApiErrorCode =
  | 'http'
  | 'rate_limited'
  | 'network'
  | 'aborted'
  | 'timeout'
  | 'invalid_response';

export class NekosApiError extends Error {
  readonly code: NekosApiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly unsupportedQuery?: boolean;

  constructor(
    code: NekosApiErrorCode,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      unsupportedQuery?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'NekosApiError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.unsupportedQuery = options.unsupportedQuery;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, NekosApiError.prototype);
  }
}

export type NekosFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type FetchNekosBatchInput = {
  settings: AppSettings;
  excludedIds: readonly string[];
  count?: number;
  signal?: AbortSignal;
  fetcher?: NekosFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type FetchNekosSearchPageInput = {
  request: SearchRequest;
  cursor?: ProviderCursor['nekos_api'] | null;
  limit?: number;
  signal?: AbortSignal;
  fetcher?: NekosFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type NekosBatch = {
  items: ImageCandidate[];
  totalCount: number;
};

function runNekosRequest<T>(
  governor: ProviderRequestGovernor | undefined,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return governor
    ? governor.execute('nekos_api', operation, signal)
    : operation(signal ?? new AbortController().signal);
}

type NekosRating = 'safe' | 'suggestive' | 'borderline' | 'explicit';

type ParsedNekosImage = {
  id: string;
  url: string;
  rating: NekosRating;
  dominantColor: string;
  sourceUrl: string | null;
  artistName: string | null;
  tags: { name: string; isNsfw: boolean }[];
};

export type WebpMetadata = {
  width: number;
  height: number;
  isAnimated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function safeSourceUrl(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function uint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

export function parseWebpMetadata(bytes: Uint8Array): WebpMetadata {
  if (
    bytes.length < 25 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP'
  ) {
    throw new NekosApiError('invalid_response', 'Nekos API returned invalid WebP data');
  }

  const chunk = ascii(bytes, 12, 4);
  let width: number;
  let height: number;
  let isAnimated = false;
  if (chunk === 'VP8 ') {
    if (
      bytes.length < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      throw new NekosApiError('invalid_response', 'Nekos API returned invalid VP8 data');
    }
    width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
    height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) {
      throw new NekosApiError('invalid_response', 'Nekos API returned invalid VP8L data');
    }
    width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
  } else if (chunk === 'VP8X') {
    if (bytes.length < 30) {
      throw new NekosApiError('invalid_response', 'Nekos API returned incomplete VP8X data');
    }
    width = 1 + uint24(bytes, 24);
    height = 1 + uint24(bytes, 27);
    isAnimated = (bytes[20]! & 0x02) !== 0;
  } else {
    throw new NekosApiError('invalid_response', 'Nekos API returned unsupported WebP data');
  }

  if (width <= 0 || height <= 0) {
    throw new NekosApiError('invalid_response', 'Nekos API returned invalid image dimensions');
  }
  return { width, height, isAnimated };
}

function parseNekosImage(value: unknown): ParsedNekosImage {
  if (!isRecord(value)) {
    throw new NekosApiError('invalid_response', 'Nekos API returned an invalid response');
  }
  const id = nonEmptyString(value.id);
  const url = nonEmptyString(value.url);
  const ratings: NekosRating[] = ['safe', 'suggestive', 'borderline', 'explicit'];
  if (id === null || url === null || !ratings.includes(value.rating as NekosRating)) {
    throw new NekosApiError('invalid_response', 'Nekos API returned invalid image metadata');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    throw new NekosApiError('invalid_response', 'Nekos API returned an invalid image URL', {
      cause: error,
    });
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== NEKOS_CDN_HOST) {
    throw new NekosApiError('invalid_response', 'Nekos API returned an untrusted image URL');
  }

  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => {
        if (!isRecord(tag)) return [];
        const name = nonEmptyString(tag.name);
        return name === null
          ? []
          : [{ name, isNsfw: tag.is_nsfw === true }];
      })
    : [];

  return {
    id,
    url,
    rating: value.rating as NekosRating,
    dominantColor: nonEmptyString(value.color_primary) ?? '#D8D6D0',
    sourceUrl: safeSourceUrl(value.source_url),
    artistName: nonEmptyString(value.artist_name),
    tags,
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

async function withNekosDeadline<T>(
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
    rejectAbort(new Error(`Nekos API request aborted by ${cause}`));
  };
  const onCallerAbort = () => abortRequest('caller');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) abortRequest('caller');
  const timeout = setTimeout(() => abortRequest('timeout'), NEKOS_REQUEST_TIMEOUT_MS);

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (abortCause === 'caller') {
      throw new NekosApiError('aborted', 'Nekos API request was aborted', { cause: error });
    }
    if (abortCause === 'timeout') {
      throw new NekosApiError('timeout', 'Nekos API request timed out', { cause: error });
    }
    if (error instanceof NekosApiError) throw error;
    throw new NekosApiError('network', 'Nekos API request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function ratingsFor(value: Pick<AppSettings, 'nsfwMode'>): NekosRating[] {
  if (value.nsfwMode === 'sfw') return ['safe'];
  if (value.nsfwMode === 'nsfw') return ['explicit'];
  return ['safe', 'suggestive', 'borderline', 'explicit'];
}

function isNekosNsfw(parsed: ParsedNekosImage): boolean {
  return parsed.rating === 'borderline' ||
    parsed.rating === 'explicit' ||
    parsed.tags.some((tag) => tag.isNsfw);
}

function matchesNekosRating(
  parsed: ParsedNekosImage,
  value: Pick<AppSettings, 'nsfwMode'>,
): boolean {
  return matchesContentMode(
    nekosContentRating(parsed.rating, isNekosNsfw(parsed)),
    value.nsfwMode,
  );
}

export function buildNekosUrl(
  settings: AppSettings,
  distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): string {
  const effectiveSettings = applyDistributionToSettings(
    settings,
    distributionPolicy,
  );
  const params = new URLSearchParams();
  for (const rating of ratingsFor(effectiveSettings)) {
    params.append('rating', rating);
  }
  return `${NEKOS_RANDOM_API_URL}?${params.toString()}`;
}

function apiTagName(value: string): string {
  return value.trim();
}

function buildNekosSearchUrl(
  request: SearchRequest,
  offset: number,
  limit: number,
  distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): string {
  const effectiveRequest = applyDistributionToSearchRequest(
    request,
    distributionPolicy,
  );
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  for (const rating of ratingsFor(effectiveRequest)) {
    params.append('rating', rating);
  }
  for (const tag of effectiveRequest.tags) {
    params.append('tag', apiTagName(tag));
  }
  return `${NEKOS_SEARCH_API_URL}?${params.toString()}`;
}

async function requestJson(
  url: string,
  signal: AbortSignal,
  fetcher: NekosFetcher,
): Promise<unknown> {
  const response = await fetcher(url, { signal });
  if (!response.ok) {
    const rateLimited = response.status === 429;
    const errorBody = response.status === 422
      ? await response.json().catch(() => null)
      : null;
    const unsupportedQuery = isRecord(errorBody) &&
      Array.isArray(errorBody.detail) &&
      errorBody.detail.length > 0 &&
      errorBody.detail.every((issue: unknown) =>
        isRecord(issue) &&
        nonEmptyString(issue.type) !== null &&
        nonEmptyString(issue.msg) !== null &&
        Array.isArray(issue.loc) &&
        issue.loc[0] === 'query' &&
        issue.loc[1] === 'tag',
      );
    throw new NekosApiError(
      rateLimited ? 'rate_limited' : 'http',
      `Nekos API request failed with status ${response.status}`,
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
    throw new NekosApiError('invalid_response', 'Nekos API returned invalid JSON', {
      cause: error,
    });
  }
}

async function requestImageMetadata(
  url: string,
  signal: AbortSignal,
  fetcher: NekosFetcher,
): Promise<WebpMetadata & { byteSize: number }> {
  const response = await fetcher(url, {
    headers: { Range: `bytes=0-${WEBP_HEADER_BYTES - 1}` },
    signal,
  });
  if (!response.ok) {
    const rateLimited = response.status === 429;
    throw new NekosApiError(
      rateLimited ? 'rate_limited' : 'http',
      `Nekos CDN metadata request failed with status ${response.status}`,
      {
        status: response.status,
        retryAfterMs: rateLimited ? retryAfterMs(response) : undefined,
      },
    );
  }
  const contentRange = response.headers.get('content-range');
  const sizeMatch = contentRange?.match(/\/(\d+)$/);
  if (
    response.status !== 206 ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('image/webp') ||
    !sizeMatch
  ) {
    throw new NekosApiError('invalid_response', 'Nekos CDN did not honor metadata range');
  }
  const byteSize = Number(sizeMatch[1]);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || bytes.length < 25) {
    throw new NekosApiError('invalid_response', 'Nekos CDN returned invalid metadata');
  }
  return { ...parseWebpMetadata(bytes), byteSize };
}

function imageTags(parsed: ParsedNekosImage): string[] {
  return [...new Set(parsed.tags.map((tag) => tag.name))];
}

function toCandidate(
  parsed: ParsedNekosImage,
  metadata: WebpMetadata & { byteSize: number },
): ImageCandidate {
  const tags = imageTags(parsed);
  const contentRating = nekosContentRating(parsed.rating, isNekosNsfw(parsed));
  return {
    providerKey: 'nekos_api',
    providerItemId: parsed.id,
    canonicalSourceKey: canonicalizeSourceUrl(parsed.sourceUrl),
    perceptualHash: null,
    md5: null,
    remoteUrl: parsed.url,
    // nekos publishes no distinct sample; the deck shows the original.
    sampleUrl: parsed.url,
    sourceUrl: parsed.sourceUrl,
    artistName: parsed.artistName,
    artistUrl: null,
    width: metadata.width,
    height: metadata.height,
    byteSize: metadata.byteSize,
    extension: '.webp',
    dominantColor: parsed.dominantColor,
    contentRating,
    nativeRating: parsed.rating,
    isNsfw: contentRating !== 'safe',
    isAnimated: metadata.isAnimated,
    tags,
  };
}

function matchesSearchTags(parsed: ParsedNekosImage, request: SearchRequest): boolean {
  const tags = new Set(imageTags(parsed).map(normalizeProviderTag));
  const excluded = request.excludedTags.map(normalizeProviderTag);
  // Nekos API has already applied the included `tag` parameters. Only retain
  // the local exclusion guard because this endpoint has no exclusion field.
  if (excluded.some((tag) => tags.has(tag))) return false;

  if (!matchesNekosRating(parsed, request)) return false;
  return true;
}

function matchesSearchQuality(image: ImageCandidate, request: SearchRequest): boolean {
  if (request.orientation === 'portrait' && image.width >= image.height) return false;
  if (request.orientation === 'landscape' && image.width <= image.height) return false;
  if (request.animationMode === 'exclude' && image.isAnimated) return false;
  if (request.animationMode === 'only' && !image.isAnimated) return false;
  if (request.minWidth !== 0 && image.width < request.minWidth) return false;
  if (request.maxBytes !== 0 && image.byteSize > request.maxBytes) return false;
  return true;
}

function parseSearchPage(value: unknown): { items: unknown[]; total: number } {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new NekosApiError('invalid_response', 'Nekos API returned an invalid search page');
  }
  const total = value.total;
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    throw new NekosApiError('invalid_response', 'Nekos API returned an invalid search total');
  }
  return { items: value.items, total: total as number };
}

function parseSearchItems(items: unknown[], request: SearchRequest): ParsedNekosImage[] {
  const seen = new Set<string>();
  return items.flatMap((value) => {
    try {
      const parsed = parseNekosImage(value);
      if (seen.has(parsed.id) || !matchesSearchTags(parsed, request)) return [];
      seen.add(parsed.id);
      return [parsed];
    } catch (error) {
      if (error instanceof NekosApiError && error.code === 'invalid_response') return [];
      throw error;
    }
  });
}

async function fetchCandidate(
  settings: AppSettings,
  excludedIds: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  fetcher: NekosFetcher,
  governor?: ProviderRequestGovernor,
  distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): Promise<ImageCandidate | null> {
  const effectiveSettings = applyDistributionToSettings(
    settings,
    distributionPolicy,
  );
  return runNekosRequest(governor, signal, (governedSignal) => withNekosDeadline(
    governedSignal,
    async (requestSignal) => {
      const parsed = parseNekosImage(
        await requestJson(
          buildNekosUrl(effectiveSettings, distributionPolicy),
          requestSignal,
          fetcher,
        ),
      );
      if (
        excludedIds.has(parsed.id)
        || !matchesNekosRating(parsed, effectiveSettings)
      ) {
        return null;
      }
      const metadata = await requestImageMetadata(parsed.url, requestSignal, fetcher);
      const candidate = toCandidate(parsed, metadata);
      return isImageAllowedByDistribution(candidate, distributionPolicy)
        && matchesCandidateSettings(candidate, effectiveSettings)
        ? candidate
        : null;
    },
  ));
}

export async function fetchNekosBatch({
  settings,
  excludedIds,
  count = 6,
  signal,
  fetcher = expoFetch as unknown as NekosFetcher,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
}: FetchNekosBatchInput): Promise<NekosBatch> {
  const effectiveSettings = applyDistributionToSettings(
    settings,
    distributionPolicy,
  );
  const requestCount = Math.min(8, Math.max(1, Math.trunc(count)));
  const excluded = new Set(excludedIds.slice(0, 100));
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
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (signal?.aborted) {
    throw failures[0] instanceof NekosApiError
      ? failures[0]
      : new NekosApiError('aborted', 'Nekos API request was aborted');
  }

  const seen = new Set<string>();
  const items = settled.flatMap((result) => {
    if (result.status !== 'fulfilled' || result.value === null) return [];
    if (seen.has(result.value.providerItemId)) return [];
    seen.add(result.value.providerItemId);
    return [result.value];
  });
  if (items.length === 0 && failures.length === requestCount) throw failures[0];
  return { items, totalCount: items.length };
}

export async function fetchNekosSearchPage({
  request,
  cursor,
  limit = 20,
  signal,
  fetcher = expoFetch as unknown as NekosFetcher,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
}: FetchNekosSearchPageInput): Promise<
  Extract<ProviderSearchPage, { providerKey: 'nekos_api' }>
> {
  const effectiveRequest = applyDistributionToSearchRequest(
    request,
    distributionPolicy,
  );
  if (cursor === null) {
    return { providerKey: 'nekos_api', items: [], nextCursor: null };
  }

  const offset = cursor?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new NekosApiError('invalid_response', 'Nekos search cursor is invalid');
  }
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 20;
  const pageLimit = Math.min(NEKOS_SEARCH_LIMIT_MAX, Math.max(1, requestedLimit));
  try {
    return await runNekosRequest(
      governor,
      signal,
      (governedSignal) => withNekosDeadline(governedSignal, async (requestSignal) => {
        const page = parseSearchPage(
          await requestJson(
            buildNekosSearchUrl(
              effectiveRequest,
              offset,
              pageLimit,
              distributionPolicy,
            ),
            requestSignal,
            fetcher,
          ),
        );
        const parsed = parseSearchItems(
          page.items.slice(0, pageLimit),
          effectiveRequest,
        );
        // K7 ⑳ — one probe per hit, all at once. These were issued two at a
        // time behind an undocumented `index += 2` chunk, so a 20-hit page was
        // ten serial rounds of a 64-byte Range GET (2-4 s before the first
        // tile) inside the page's single 12 s all-or-nothing deadline: on a
        // high-latency link the whole page timed out and rendered empty. The
        // discovery path in this same file already fans out eight abreast.
        const settled = await Promise.allSettled(
          parsed.map(async (item): Promise<SearchHit | null> => {
            const metadata = await requestImageMetadata(
              item.url,
              requestSignal,
              fetcher,
            );
            const image = toCandidate(item, metadata);
            if (
              !isImageAllowedByDistribution(image, distributionPolicy)
              || !matchesSearchQuality(image, effectiveRequest)
            ) return null;
            return {
              key: `nekos_api:${image.providerItemId}`,
              // R8.24: tiles render the medium sample; nekos has none, so
              // this resolves back to the original.
              previewUrl: image.sampleUrl ?? image.remoteUrl,
              image,
            };
          }),
        );
        const fatalFailure = settled.find(
          (result) => result.status === 'rejected' && !(
            result.reason instanceof NekosApiError &&
            result.reason.code === 'invalid_response'
          ),
        );
        if (fatalFailure?.status === 'rejected') throw fatalFailure.reason;
        const items = settled.flatMap((result) =>
          result.status === 'fulfilled' && result.value !== null ? [result.value] : [],
        );
        const consumed = Math.min(page.items.length, pageLimit);
        const nextOffset = offset + consumed;
        return {
          providerKey: 'nekos_api',
          items,
          nextCursor:
            consumed > 0 && nextOffset < page.total ? { offset: nextOffset } : null,
          total: page.total,
        };
      }),
    );
  } catch (error) {
    if (
      error instanceof NekosApiError &&
      error.unsupportedQuery === true
    ) {
      return {
        providerKey: 'nekos_api',
        items: [],
        nextCursor: null,
        total: 0,
        unsupportedQuery: true,
      };
    }
    throw error;
  }
}
