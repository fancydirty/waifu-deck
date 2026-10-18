import { moebooruContentRating } from '@/features/content/content-taxonomy';
import {
  createMoebooruEngine,
  MoebooruApiError,
  type MoebooruApiErrorCode,
  type MoebooruBatch,
  type MoebooruBatchInput,
  type MoebooruEngineConfig,
  type MoebooruFetcher,
  type MoebooruSearchPageInput,
} from '@/features/providers/engines/moebooru-engine';

const YANDERE_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'WaifuDeck/1.0 (Expo; https://github.com/fancydirty)',
} as const;

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

export const YANDERE_REQUEST_TIMEOUT_MS = 12_000;
export const YANDERE_NATIVE_RATINGS = ['s', 'q', 'e'] as const;
export type YandereRating = typeof YANDERE_NATIVE_RATINGS[number];

// Yande.re remains the reference Moebooru instance; the shared engine holds the
// (behaviour-identical) logic. All previous exports are preserved by delegation.
export type YandereApiErrorCode = MoebooruApiErrorCode;
export type YandereFetcher = MoebooruFetcher;
export type YandereBatch = MoebooruBatch;
export type FetchYandereBatchInput = MoebooruBatchInput;
export type FetchYandereSearchPageInput = MoebooruSearchPageInput;

// Same class object as the engine's error, so existing `instanceof YandereApiError`
// checks and `Partial<YandereApiError>` type usages keep working unchanged.
// eslint-disable-next-line @typescript-eslint/no-redeclare -- deliberate value+type merge for the back-compat alias
export const YandereApiError = MoebooruApiError;
export type YandereApiError = MoebooruApiError;

const YANDERE_CONFIG: MoebooruEngineConfig<'yandere'> = {
  key: 'yandere',
  label: 'Yande.re',
  postUrl: 'https://yande.re/post.json',
  host: 'yande.re',
  headers: YANDERE_HEADERS,
  maxLimit: 100,
  dominantColor: '#D8D6D0',
  toContentRating: moebooruContentRating,
  hardExclusionTags: HARD_EXCLUSION_TAGS,
  requestTimeoutMs: YANDERE_REQUEST_TIMEOUT_MS,
  discoveryLimitCap: 12,
  discoverySampleTag: 'order:random',
};

const yandereEngine = createMoebooruEngine(YANDERE_CONFIG);

export const buildYandereUrl = yandereEngine.buildUrl;
export const fetchYandereBatch = yandereEngine.fetchBatch;
export const fetchYandereSearchPage = yandereEngine.fetchSearchPage;
