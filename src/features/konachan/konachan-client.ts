import { moebooruContentRating } from '@/features/content/content-taxonomy';
import {
  createMoebooruEngine,
  type MoebooruEngineConfig,
} from '@/features/providers/engines/moebooru-engine';

const KONACHAN_HEADERS = {
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

// Konachan is the second Moebooru instance (after Yande.re).
//
// HOST: konachan.NET, not konachan.com. konachan.com sits behind a Cloudflare
// challenge that returns HTTP 403 (`cf-mitigated: challenge`, "Just a moment...")
// to any non-browser client — verified from the emulator's direct path and
// reproduced on the host with `--noproxy`, for every rating (s/q/e), while
// yande.re (same engine, same UA) returns 200. The G3c §6.5 landscape smoke
// caught it as `konachan req=2 ret=0 failed (http 403)`. konachan.net is the
// SFW mirror: same Moebooru API, same 7-tag anonymous cap, real landscape
// corpus, and — critically — it is NOT challenged. The old konachan.com choice
// served nothing on device, so this is a strict recovery, not a scope change.
//
// LIMITATION (honest): konachan.net is SFW-only — it returns 0 posts for
// rating:q and rating:e. konachan therefore no longer contributes to NSFW/mixed
// discovery or search. That capability was already dead on device (the .com
// 403 was domain-wide across all ratings), so nothing that worked is lost, but
// if konachan.com ever becomes reachable again (e.g. via a browser-grade
// transport) the NSFW corpus would only return by pointing back at .com.
const KONACHAN_CONFIG: MoebooruEngineConfig<'konachan'> = {
  key: 'konachan',
  label: 'Konachan',
  postUrl: 'https://konachan.net/post.json',
  host: 'konachan.net',
  headers: KONACHAN_HEADERS,
  maxLimit: 100,
  dominantColor: '#D8D6D0',
  toContentRating: moebooruContentRating,
  hardExclusionTags: HARD_EXCLUSION_TAGS,
  // Konachan caps ANONYMOUS queries at 7 tags. The full 8-tag hard-exclusion set
  // plus a rating tag = 9 query terms → deterministic HTTP 500 (G2a-1 Task 4
  // finding). Send only the safety-critical loli/shota exclusions query-side
  // (rating:s + -loli + -shota = 3 tags, safely under 7); the remaining
  // cosplay/photo/real-person exclusions are still enforced CLIENT-SIDE via
  // hasHardExcludedTag over the full hardExclusionTags set above.
  queryExclusionTags: new Set(['loli', 'shota']),
  discoveryLimitCap: 12,
  discoverySampleTag: 'order:random',
};

const konachanEngine = createMoebooruEngine(KONACHAN_CONFIG);

export const buildKonachanUrl = konachanEngine.buildUrl;
export const fetchKonachanBatch = konachanEngine.fetchBatch;
export const fetchKonachanSearchPage = konachanEngine.fetchSearchPage;
