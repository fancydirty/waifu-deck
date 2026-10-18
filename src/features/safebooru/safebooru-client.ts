import { fetch as expoFetch } from 'expo/fetch';

import {
  candidateContentRating,
  matchesContentMode,
  safebooruContentRating,
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
import type {
  ProviderCursor,
  ProviderSearchPage,
  SearchHit,
  SearchRequest,
} from '@/features/search/types';
import type { AppSettings, ImageCandidate } from '@/features/waifu/types';

const SAFEBOORU_API_URL = 'https://safebooru.org/index.php';
const SAFEBOORU_HOST = 'safebooru.org';
const SAFEBOORU_MAX_LIMIT = 100;
const SAFEBOORU_DISCOVERY_PAGE_SPAN = 1_000;
// Board #19: `rating:questionable animated` minus the hard exclusions is 44
// posts (live 2026-09-27; 43 of the first 44 are gifs). A random pid out of
// 1 000 lands past them on ~99% of rounds — that is why 仅 NSFW + 仅动图 got
// zero Safebooru cards. That query picks a pid inside the measured pool
// instead (6 pages at 8 per page); a few posts added later are merely reached
// less often, a few deleted ones make an occasional empty round. The other
// animation queries (safe ~11.6k, unrated ~17k, -animated ~16.6k) fill the
// 1 000-page span at any discovery limit (≤ 8), so they keep it.
const SAFEBOORU_QUESTIONABLE_ANIMATED_POOL = 44;
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const HARD_EXCLUSION_TAGS = new Set([
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
const SAFEBOORU_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'WaifuDeck/1.0 (Expo; https://github.com/fancydirty)',
} as const;
export const SAFEBOORU_REQUEST_TIMEOUT_MS = 12_000;

export const SAFEBOORU_NATIVE_RATINGS = [
  'general',
  'safe',
  'questionable',
] as const;
export type SafebooruRating = typeof SAFEBOORU_NATIVE_RATINGS[number];
const SAFEBOORU_NATIVE_RATING_SET: ReadonlySet<string> = new Set(
  SAFEBOORU_NATIVE_RATINGS,
);
export type SafebooruApiErrorCode =
  | 'http'
  | 'rate_limited'
  | 'network'
  | 'aborted'
  | 'timeout'
  | 'invalid_response';

export class SafebooruApiError extends Error {
  readonly code: SafebooruApiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: SafebooruApiErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'SafebooruApiError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, SafebooruApiError.prototype);
  }
}

export type SafebooruFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type SafebooruBatch = {
  items: ImageCandidate[];
  totalCount: number;
};

export type FetchSafebooruBatchInput = {
  settings: AppSettings;
  excludedIds: readonly string[];
  count?: number;
  signal?: AbortSignal;
  fetcher?: SafebooruFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

export type FetchSafebooruSearchPageInput = {
  request: SearchRequest;
  cursor?: ProviderCursor['safebooru'] | null;
  limit?: number;
  signal?: AbortSignal;
  fetcher?: SafebooruFetcher;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
};

type ParsedPost = {
  id: string;
  width: number;
  height: number;
  remoteUrl: string;
  /** Medium display copy (`sample_url`); equals `remoteUrl` when the post has
   *  no distinct sample or the DAPI returned an untrusted host. */
  sampleUrl: string;
  previewUrl: string;
  sourceUrl: string | null;
  extension: string;
  rating: SafebooruRating;
  tags: string[];
  /** Byte-exact MD5 hex digest (lowercased), when present. Plain string —
   *  never a Buffer (Hermes-safety). */
  md5: string | null;
};

function runSafebooruRequest<T>(
  governor: ProviderRequestGovernor | undefined,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return governor
    ? governor.execute('safebooru', operation, signal)
    : operation(signal ?? new AbortController().signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function safeUrl(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== ''
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function trustedSafebooruUrl(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== SAFEBOORU_HOST ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== ''
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseRating(value: unknown): SafebooruRating | null {
  return typeof value === 'string' && SAFEBOORU_NATIVE_RATING_SET.has(value)
    ? value as SafebooruRating
    : null;
}

function parsePost(value: unknown): ParsedPost {
  if (!isRecord(value)) {
    throw new SafebooruApiError(
      'invalid_response',
      'Safebooru returned invalid post metadata',
    );
  }
  const numericId = positiveInteger(value.id);
  const width = positiveInteger(value.width);
  const height = positiveInteger(value.height);
  const remoteUrl = trustedSafebooruUrl(value.file_url);
  // R8.18/R8.24: Safebooru's DAPI publishes an absolute `sample_url` on every
  // post (verified live 2026-09-09); `sample: false` posts return it equal to
  // `file_url`. Same host-validated `sample_url ?? file_url` rule the moebooru
  // and gelbooru engines already use.
  const sampleUrl = trustedSafebooruUrl(value.sample_url) ?? remoteUrl;
  const previewUrl = trustedSafebooruUrl(value.preview_url) ?? remoteUrl;
  const rating = parseRating(value.rating);
  const tags = (nonEmptyString(value.tags) ?? '').split(/\s+/).filter(Boolean);
  if (
    numericId === null ||
    width === null ||
    height === null ||
    remoteUrl === null ||
    sampleUrl === null ||
    previewUrl === null ||
    rating === null
  ) {
    throw new SafebooruApiError(
      'invalid_response',
      'Safebooru returned incomplete image metadata',
    );
  }
  const extension = new URL(remoteUrl).pathname.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new SafebooruApiError(
      'invalid_response',
      'Safebooru returned an unsupported image type',
    );
  }
  return {
    id: String(numericId),
    width,
    height,
    remoteUrl,
    sampleUrl,
    previewUrl,
    sourceUrl: safeUrl(value.source),
    extension,
    rating,
    tags,
    md5: normalizedMd5Hex(value.hash),
  };
}

function hasHardExcludedTag(post: ParsedPost): boolean {
  return post.tags.some((tag) => HARD_EXCLUSION_TAGS.has(tag.toLowerCase()));
}

function ratingQuery(mode: AppSettings['nsfwMode'] | SearchRequest['nsfwMode']): string[] {
  if (mode === 'sfw') return ['rating:safe'];
  // Board #19, owner ruling D3 = B: safebooru.org has no explicit corpus
  // (`rating:explicit` = 0 posts, live 2026-09-26). Its NSFW-capable posts are
  // `questionable`, which safebooruContentRating maps to nsfw_unspecified and
  // matchesContentMode('nsfw') accepts — so 仅 NSFW asks for those.
  if (mode === 'nsfw') return ['rating:questionable'];
  return [];
}

function animationQuery(mode: AppSettings['animationMode']): string[] {
  // Safebooru tags its gifs `animated`; asking server-side means 仅动图 pages
  // are gifs instead of ~0.3% gifs the client filter then throws away.
  if (mode === 'only') return ['animated'];
  if (mode === 'exclude') return ['-animated'];
  return [];
}

function discoveryPageSpan(settings: AppSettings, limit: number): number {
  if (settings.nsfwMode === 'nsfw' && settings.animationMode === 'only') {
    return Math.max(1, Math.ceil(SAFEBOORU_QUESTIONABLE_ANIMATED_POOL / limit));
  }
  return SAFEBOORU_DISCOVERY_PAGE_SPAN;
}

function dapiUrl(tags: readonly string[], limit: number, page: number): string {
  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: String(Math.min(SAFEBOORU_MAX_LIMIT, Math.max(1, Math.trunc(limit)))),
    pid: String(Math.max(0, Math.trunc(page))),
    tags: tags.join(' '),
  });
  return `${SAFEBOORU_API_URL}?${params.toString()}`;
}

export function buildSafebooruUrl(
  settings: AppSettings,
  count = 4,
  distributionPolicy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
  page = 0,
): string {
  const effectiveSettings = applyDistributionToSettings(settings, distributionPolicy);
  return dapiUrl(
    [
      ...ratingQuery(effectiveSettings.nsfwMode),
      ...animationQuery(effectiveSettings.animationMode),
      ...HARD_EXCLUSION_QUERY_TAGS,
    ],
    count,
    page,
  );
}

function retryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const deadline = Date.parse(retryAfter);
  return Number.isNaN(deadline) ? undefined : Math.max(0, deadline - Date.now());
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
    rejectAbort(new Error(`Safebooru request aborted by ${cause}`));
  };
  const onCallerAbort = () => abortRequest('caller');
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  if (callerSignal?.aborted) abortRequest('caller');
  const timeout = setTimeout(() => abortRequest('timeout'), SAFEBOORU_REQUEST_TIMEOUT_MS);

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (abortCause === 'caller') {
      throw new SafebooruApiError('aborted', 'Safebooru request was aborted', { cause: error });
    }
    if (abortCause === 'timeout') {
      throw new SafebooruApiError('timeout', 'Safebooru request timed out', { cause: error });
    }
    if (error instanceof SafebooruApiError) throw error;
    throw new SafebooruApiError('network', 'Safebooru request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function requestJson(
  url: string,
  signal: AbortSignal,
  fetcher: SafebooruFetcher,
): Promise<unknown> {
  const response = await fetcher(url, { headers: SAFEBOORU_HEADERS, signal });
  if (!response.ok) {
    const rateLimited = response.status === 429;
    throw new SafebooruApiError(
      rateLimited ? 'rate_limited' : 'http',
      `Safebooru request failed with status ${response.status}`,
      {
        status: response.status,
        retryAfterMs: rateLimited ? retryAfterMs(response) : undefined,
      },
    );
  }
  try {
    const text = await response.text();
    if (text.trim().length === 0) {
      // safebooru.org answers a zero-result DAPI query with HTTP 200 and a
      // 0-byte body (live-confirmed 2026-09-26, board #19: any search with no
      // hits, and every `rating:explicit` query). That is an empty page, not
      // a broken one — without this, `JSON.parse('')`'s SyntaxError surfaces
      // as `invalid_response` and an ordinary empty round reads as
      // 「Safebooru 暂时不可用」. Same shape and fix as the Gelbooru DAPI
      // engine's Rule34 precedent (gelbooru-dapi-engine.ts).
      return [];
    }
    return JSON.parse(text);
  } catch (error) {
    throw new SafebooruApiError(
      'invalid_response',
      'Safebooru returned invalid JSON',
      { cause: error },
    );
  }
}

async function requestByteSize(
  post: ParsedPost,
  signal: AbortSignal,
  fetcher: SafebooruFetcher,
): Promise<number> {
  const response = await fetcher(post.remoteUrl, {
    headers: { Range: 'bytes=0-0' },
    signal,
  });
  const contentRange = response.headers.get('content-range');
  const sizeMatch = contentRange?.match(/\/(\d+)$/);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
  const byteSize = sizeMatch ? Number(sizeMatch[1]) : Number.NaN;
  if (
    !response.ok ||
    response.status !== 206 ||
    !contentType ||
    !ALLOWED_CONTENT_TYPES.has(contentType) ||
    !Number.isSafeInteger(byteSize) ||
    byteSize <= 0
  ) {
    throw new SafebooruApiError(
      'invalid_response',
      'Safebooru image metadata response was invalid',
    );
  }
  return byteSize;
}

function toCandidate(post: ParsedPost, byteSize: number): ImageCandidate {
  const contentRating = safebooruContentRating(post.rating);
  return {
    providerKey: 'safebooru',
    providerItemId: post.id,
    canonicalSourceKey: canonicalizeSourceUrl(post.sourceUrl),
    perceptualHash: null,
    md5: post.md5,
    remoteUrl: post.remoteUrl,
    sampleUrl: post.sampleUrl,
    sourceUrl: post.sourceUrl,
    // DAPI exposes one uncategorized tag string, so artist-like tags are not identity evidence.
    artistName: null,
    artistUrl: null,
    width: post.width,
    height: post.height,
    byteSize,
    extension: `.${post.extension}`,
    dominantColor: '#D8D6D0',
    contentRating,
    nativeRating: post.rating,
    isNsfw: contentRating !== 'safe',
    isAnimated: post.extension === 'gif',
    tags: post.tags,
  };
}

/**
 * K7 ⑲ — the `Range: bytes=0-0` size probe is a *per-image extra request* that
 * only the optional "max file size" setting can read, and that setting is off
 * (`maxBytes: 0`) by default. Off, this used to cost one serial round trip to
 * the image host per surviving post (measured: 1.0 s list + 8.4 s of probes
 * for one 8-card batch on a cold connection) to fill a field nothing consumed —
 * ingest measures the real byte size again when the image is saved.
 *
 * So: probe only when the user actually set a limit, and probe the whole page
 * at once rather than one at a time. `byteSize: 0` otherwise, which is what the
 * Gelbooru/Rule34 engine has always reported.
 */
async function adaptPosts(
  values: unknown[],
  excludedIds: ReadonlySet<string>,
  settings: Pick<AppSettings, 'nsfwMode' | 'orientation' | 'animationMode' | 'minWidth' | 'maxBytes' | 'includedTags' | 'excludedTags'>,
  distributionPolicy: DistributionPolicy,
  signal: AbortSignal,
  fetcher: SafebooruFetcher,
): Promise<ImageCandidate[]> {
  const posts = values.map(parsePost);
  const admitted: ParsedPost[] = [];
  const seen = new Set<string>();
  for (const post of posts) {
    if (
      seen.has(post.id) ||
      excludedIds.has(post.id) ||
      hasHardExcludedTag(post)
    ) continue;
    seen.add(post.id);
    if (!matchesContentMode(safebooruContentRating(post.rating), settings.nsfwMode)) {
      continue;
    }
    admitted.push(post);
  }
  const byteSizes = settings.maxBytes > 0
    ? await Promise.all(
      admitted.map((post) => requestByteSize(post, signal, fetcher)),
    )
    : admitted.map(() => 0);
  return admitted.flatMap((post, index) => {
    const candidate = toCandidate(post, byteSizes[index] ?? 0);
    return isImageAllowedByDistribution(candidate, distributionPolicy) &&
      matchesCandidateSettings(candidate, settings as AppSettings)
      ? [candidate]
      : [];
  });
}

export async function fetchSafebooruBatch({
  settings,
  excludedIds,
  count = 4,
  signal,
  fetcher = expoFetch as unknown as SafebooruFetcher,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
}: FetchSafebooruBatchInput): Promise<SafebooruBatch> {
  const effectiveSettings = applyDistributionToSettings(settings, distributionPolicy);
  const limit = Math.min(8, Math.max(1, Math.trunc(count)));
  const page = Math.floor(Math.random() * discoveryPageSpan(effectiveSettings, limit));
  return runSafebooruRequest(governor, signal, (governedSignal) => withDeadline(
    governedSignal,
    async (requestSignal) => {
      const response = await requestJson(
        buildSafebooruUrl(effectiveSettings, limit, distributionPolicy, page),
        requestSignal,
        fetcher,
      );
      if (!Array.isArray(response)) {
        throw new SafebooruApiError('invalid_response', 'Safebooru returned invalid posts');
      }
      const values = response.slice(0, limit);
      return {
        items: await adaptPosts(
          values,
          new Set(excludedIds.slice(0, 100)),
          effectiveSettings,
          distributionPolicy,
          requestSignal,
          fetcher,
        ),
        totalCount: values.length,
      };
    },
  ));
}

function searchTags(request: SearchRequest): string[] {
  return [
    ...ratingQuery(request.nsfwMode),
    ...animationQuery(request.animationMode),
    ...request.tags.map((tag) => tag.trim()).filter(Boolean),
    ...request.excludedTags.map((tag) => `-${tag.trim()}`).filter(Boolean),
    ...HARD_EXCLUSION_QUERY_TAGS,
  ];
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

export async function fetchSafebooruSearchPage({
  request,
  cursor,
  limit = 20,
  signal,
  fetcher = expoFetch as unknown as SafebooruFetcher,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
}: FetchSafebooruSearchPageInput): Promise<
  Extract<ProviderSearchPage, { providerKey: 'safebooru' }>
> {
  const effectiveRequest = applyDistributionToSearchRequest(request, distributionPolicy);
  if (cursor === null) {
    return { providerKey: 'safebooru', items: [], nextCursor: null };
  }
  const page = cursor?.page ?? 0;
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new SafebooruApiError('invalid_response', 'Safebooru search cursor is invalid');
  }
  const tags = searchTags(effectiveRequest);
  const pageLimit = Math.min(SAFEBOORU_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  return runSafebooruRequest(governor, signal, (governedSignal) => withDeadline(
    governedSignal,
    async (requestSignal) => {
      const response = await requestJson(
        dapiUrl(tags, pageLimit, page),
        requestSignal,
        fetcher,
      );
      if (!Array.isArray(response)) {
        throw new SafebooruApiError('invalid_response', 'Safebooru returned invalid posts');
      }
      const values = response.slice(0, pageLimit);
      const images = await adaptPosts(
        values,
        new Set(),
        {
          ...effectiveRequest,
          includedTags: [],
          excludedTags: effectiveRequest.excludedTags,
        },
        distributionPolicy,
        requestSignal,
        fetcher,
      );
      const items: SearchHit[] = images
        .filter((image) => matchesSearchRequest(image, effectiveRequest))
        .map((image) => ({
          key: `safebooru:${image.providerItemId}`,
          // R8.24: tiles render the medium 850 px sample, never the original.
          previewUrl: image.sampleUrl ?? image.remoteUrl,
          image,
        }));
      return {
        providerKey: 'safebooru',
        items,
        nextCursor: values.length === pageLimit ? { page: page + 1 } : null,
      };
    },
  ));
}
