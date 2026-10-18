import { createGelbooruDapiEngine } from '@/features/providers/engines/gelbooru-dapi-engine';

/**
 * Rule34.xxx — G4b, second credentialed source, same Gelbooru-DAPI engine.
 * Free per-user api_key+user_id, injected per call from the secure-store map
 * (spec §2), NEVER from config. Live probe 2026-09-03: keyed → HTTP 200 BARE
 * ARRAY (no {post:…} wrapper); md5 under `hash`; keyless → HTTP 200 body
 * "Missing authentication…" (the engine's §3.4 sentinel guard turns that into a
 * thrown auth failure, never a silent empty batch). NSFW-heavy corpus.
 */
const RULE34_CONFIG = {
  key: 'rule34' as const,
  label: 'Rule34',
  apiUrl: 'https://api.rule34.xxx/index.php',
  trustedCdnHosts: ['rule34.xxx'],
  headers: { 'User-Agent': 'WaifuDeck/1.0 (private local-first collection app)' },
  responseListKey: 'post',
  md5Field: 'hash',
  maxLimit: 100,
  discoveryLimitCap: 12,
  dominantColor: '#7ec850',
};

const rule34Engine = createGelbooruDapiEngine(RULE34_CONFIG);

export const buildRule34Url = rule34Engine.buildUrl;
export const fetchRule34Batch = rule34Engine.fetchBatch;
export const fetchRule34SearchPage = rule34Engine.fetchSearchPage;
export const Rule34ApiError = rule34Engine.ApiError;
