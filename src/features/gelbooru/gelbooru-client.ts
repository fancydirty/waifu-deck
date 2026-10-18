import { createGelbooruDapiEngine } from '@/features/providers/engines/gelbooru-dapi-engine';

/** R8.28: Gelbooru's image CDN requires this Referer for renders and downloads. */
export const GELBOORU_IMAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Referer: 'https://gelbooru.com/',
});

/**
 * Gelbooru (gelbooru.com) — G4a, first credentialed source. Requires a free
 * per-user api_key+user_id (mandatory since 2025-08), injected per call from
 * the secure-store map (spec §2), NEVER from config. Live probe 2026-09-03:
 * HTTP 200 with key on both rating:general and rating:explicit; response wraps
 * in {"@attributes":…, "post":[…]}; md5 field `md5`; vocab
 * general|sensitive|questionable|explicit.
 */
const GELBOORU_CONFIG = {
  key: 'gelbooru' as const,
  label: 'Gelbooru',
  apiUrl: 'https://gelbooru.com/index.php',
  trustedCdnHosts: ['gelbooru.com'],
  headers: { 'User-Agent': 'WaifuDeck/1.0 (private local-first collection app)' },
  imageHeaders: GELBOORU_IMAGE_HEADERS,
  responseListKey: 'post',
  md5Field: 'md5',
  maxLimit: 100,
  discoveryLimitCap: 12,
  dominantColor: '#006ffa',
};

const gelbooruEngine = createGelbooruDapiEngine(GELBOORU_CONFIG);

export const buildGelbooruUrl = gelbooruEngine.buildUrl;
export const fetchGelbooruBatch = gelbooruEngine.fetchBatch;
export const fetchGelbooruSearchPage = gelbooruEngine.fetchSearchPage;
export const GelbooruApiError = gelbooruEngine.ApiError;
