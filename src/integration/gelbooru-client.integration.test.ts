/**
 * Real-API integration test for the Gelbooru DAPI source (G4a Task 7).
 *
 * The unit suites (`gelbooru-dapi-engine.test.ts`, `gelbooru-client.test.ts`)
 * prove the engine's parsing, auth-guard, and rating fail-safe against
 * fixtures we wrote ourselves. What only a live, credentialed request can
 * prove is that gelbooru.com's real DAPI response shape still round-trips
 * through `createGelbooruDapiEngine`'s parser, that the owner's real
 * api_key/user_id credential is actually accepted, and that `rating:general`
 * / `rating:explicit` querying really segments content server-side.
 *
 * Unlike the Konachan/e621 suites in this directory, Gelbooru is
 * CREDENTIALED (mandatory api_key+user_id since 2025-08) — there is no
 * request to attempt without a key. This suite is gated on
 * `GELBOORU_API_KEY`/`GELBOORU_USER_ID` and skips the whole describe block
 * (loudly, via console.warn below) when either is absent, rather than
 * attempting a keyless request that would only prove the auth-failure guard,
 * not the live source. The credential is read from the environment only —
 * never written to this file, a fixture, a log line, or a commit.
 *
 * Once gated in, "network-graceful" mirrors Konachan's spirit: a genuine
 * network/availability failure (offline runner, DNS failure, gelbooru.com
 * down or rate-limiting) is logged and skipped per-test rather than failing
 * the run. A real shape/safety-contract violation — wrong rating leaking
 * through, an unmapped rating silently admitted, a cursor that doesn't
 * advance — still fails the test; that is precisely what this gate exists to
 * catch.
 *
 * `gelbooru-client.ts` transitively imports two native-only modules at
 * module scope via `gelbooru-dapi-engine.ts`, neither of which this suite's
 * logic ever needs (it always passes its own `fetcher: fetch`, and
 * distribution policy is irrelevant to a direct fetchBatch/fetchSearchPage
 * call):
 *
 * - `expo/fetch` (the engine's default fetcher).
 * - `expo-constants` (via `distribution-policy.ts`, for `Constants.expoConfig`).
 *
 * Both reach into `react-native`, whose `index.js` references the RN-global
 * `__DEV__` merely by being evaluated — undefined under this suite's plain
 * Node `testEnvironment` (see jest.integration.config.js's header comment on
 * why this config deliberately isn't `jest-expo`). Mocking both leaf modules
 * to inert passthroughs — scoped to this test file only via `jest.mock` —
 * keeps `react-native` out of the require graph and lets the import succeed;
 * this is the same per-file-mock technique the Konachan/e621 integration
 * suites established.
 */
jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));

import {
  buildGelbooruUrl,
  fetchGelbooruBatch,
  fetchGelbooruSearchPage,
} from '@/features/gelbooru/gelbooru-client';
import {
  APP_DISTRIBUTION_POLICY,
  DIRECT_DISTRIBUTION_POLICY,
} from '@/features/distribution/distribution-policy';
import {
  GELBOORU_MAPPED_RATINGS,
  type GelbooruDapiFetcher,
} from '@/features/providers/engines/gelbooru-dapi-engine';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';

const apiKey = process.env.GELBOORU_API_KEY;
const userId = process.env.GELBOORU_USER_ID;
const gated = apiKey && userId ? describe : describe.skip;

if (!apiKey || !userId) {
  console.warn(
    '[gelbooru-integration] Skipping: GELBOORU_API_KEY/GELBOORU_USER_ID not set in the environment.',
  );
}

// orientation is deliberately overridden to 'any' — the same Konachan/e621
// lesson: DEFAULT_SETTINGS.orientation is 'portrait', and
// matchesCandidateSettings drops every landscape candidate (width >= height)
// client-side. A small live sample skews toward whatever aspect ratios
// happen to be posted; relaxing this ORTHOGONAL geometry filter lets the
// real safety/parsing assertions actually run instead of racing an unrelated
// client-side filter to zero.
const sfwSettings: AppSettings = { ...DEFAULT_SETTINGS, orientation: 'any' };
const nsfwSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'nsfw',
  nsfwConfirmed: true,
  orientation: 'any',
};
// 'mixed' is the app's admits-everything mode: ratingQuery() in the engine
// returns no rating: tag for anything other than 'sfw'/'nsfw', so this query
// is unfiltered by rating server-side. That makes it the right vehicle for
// the fail-safe canary below — a real page unfiltered by our own rating
// query, filtered only by the engine's rating-vocab map.
const mixedSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'mixed',
  nsfwConfirmed: true,
  orientation: 'any',
};

// The nsfw/mixed tests pass DIRECT_DISTRIBUTION_POLICY explicitly, not the
// engine's default APP_DISTRIBUTION_POLICY. APP_DISTRIBUTION_POLICY reads
// `Constants.expoConfig?.extra?.distributionVariant`; under this file's
// `expo-constants` mock (`expoConfig: null`, required to keep react-native
// out of the require graph — see header) that always resolves to
// STORE_DISTRIBUTION_POLICY (`allowsAdultContent: false`), which
// `applyDistributionToSettings` uses to silently force `nsfwMode` back to
// `'sfw'` — a real production behaviour (Play Store builds can't request
// adult content) that would otherwise make these two tests query
// `rating:general` regardless of the `nsfwMode` set above and quietly pass
// with the wrong assertion. DIRECT_DISTRIBUTION_POLICY lets the real
// `nsfwMode` reach the query, which is what these tests exist to prove.

/** Genuine unreachability — offline runner, DNS failure, timeout, rate limit. */
function isNetworkUnreachable(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'network' || code === 'timeout' || code === 'aborted' || code === 'rate_limited';
}

gated('Gelbooru real API (DAPI) integration', () => {
  const credential = { apiKey: apiKey!, userId: userId! };

  test('sfw discovery batch returns >0 candidates, every one rating-safe with 32-hex md5', async () => {
    let batch: Awaited<ReturnType<typeof fetchGelbooruBatch>>;
    try {
      batch = await fetchGelbooruBatch({
        settings: sfwSettings,
        excludedIds: [],
        count: 6,
        credential,
        fetcher: fetch as unknown as GelbooruDapiFetcher,
        distributionPolicy: APP_DISTRIBUTION_POLICY,
      });
    } catch (error) {
      if (isNetworkUnreachable(error)) {
        console.warn(
          `[gelbooru-integration] Skipping sfw discovery: request failed: ${String(
            (error as { message?: string })?.message ?? error,
          )}`,
        );
        return;
      }
      throw error;
    }

    expect(batch.items.length).toBeGreaterThan(0);
    for (const item of batch.items) {
      expect(item.md5).toMatch(/^[0-9a-f]{32}$/);
      expect(item.isNsfw).toBe(false);
    }
  }, 20_000);

  test('nsfw discovery batch under nsfwMode nsfw returns only nsfw-rated items', async () => {
    let batch: Awaited<ReturnType<typeof fetchGelbooruBatch>>;
    try {
      batch = await fetchGelbooruBatch({
        settings: nsfwSettings,
        excludedIds: [],
        count: 6,
        credential,
        fetcher: fetch as unknown as GelbooruDapiFetcher,
        distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      });
    } catch (error) {
      if (isNetworkUnreachable(error)) {
        console.warn(
          `[gelbooru-integration] Skipping nsfw discovery: request failed: ${String(
            (error as { message?: string })?.message ?? error,
          )}`,
        );
        return;
      }
      throw error;
    }

    expect(batch.items.length).toBeGreaterThan(0);
    for (const item of batch.items) expect(item.isNsfw).toBe(true);
  }, 20_000);

  test('live rating vocab stays within the mapped set (fail-safe canary)', async () => {
    // NOT a real canary: `batch.totalCount` is `values.length` — the RAW,
    // PRE-FILTER post count computed in fetchBatch before adaptPosts/parsePost
    // run (see gelbooru-dapi-engine.ts). parsePost's fail-safe (an unmapped
    // `rating` -> toContentRating returns null -> the post is DROPPED from
    // `items`) happens strictly after `totalCount` is captured, so
    // `totalCount` cannot observe that rejection. If gelbooru.com introduced
    // a new rating tomorrow and every post on the page got silently dropped,
    // `items.length` would go to 0 while `totalCount` stayed exactly as large
    // as before — asserting `totalCount > 0` would keep passing, vacuously,
    // through the exact failure it claims to guard.
    //
    // The only honest canary is inspecting the RAW `rating` strings the live
    // API actually returns and asserting every one is inside
    // GELBOORU_MAPPED_RATINGS — the same set `toContentRating` accepts
    // (imported from the engine, not duplicated here, so this can't silently
    // drift from the real map). This is a direct, unparsed fetch: it
    // deliberately bypasses fetchGelbooruBatch/parsePost so it observes the
    // wire shape, not the already-filtered result.
    const url = buildGelbooruUrl(mixedSettings, 15, DIRECT_DISTRIBUTION_POLICY, 0, credential);
    let rawPosts: unknown[];
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[gelbooru-integration] Skipping rating-vocab canary: raw request returned HTTP ${response.status}`,
        );
        return;
      }
      const body = (await response.json()) as { post?: unknown[] };
      rawPosts = Array.isArray(body.post) ? body.post : [];
    } catch (error) {
      console.warn(
        `[gelbooru-integration] Skipping rating-vocab canary: raw request failed: ${String(
          (error as { message?: string })?.message ?? error,
        )}`,
      );
      return;
    }

    expect(rawPosts.length).toBeGreaterThan(0);
    const rawRatings = new Set(
      rawPosts.map((post) => String((post as { rating?: unknown }).rating).toLowerCase()),
    );
    for (const rating of rawRatings) {
      expect(GELBOORU_MAPPED_RATINGS.has(rating)).toBe(true);
    }

    // Sanity companion: total vocab breakage (every raw rating unmapped)
    // would zero out fetchBatch's items entirely even though the
    // subset-check above would also already have failed on the first
    // unmapped raw rating — this catches the same class of regression
    // through the production code path, not just the raw wire inspection.
    let batch: Awaited<ReturnType<typeof fetchGelbooruBatch>>;
    try {
      batch = await fetchGelbooruBatch({
        settings: mixedSettings,
        excludedIds: [],
        count: 10,
        credential,
        fetcher: fetch as unknown as GelbooruDapiFetcher,
        distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      });
    } catch (error) {
      if (isNetworkUnreachable(error)) {
        console.warn(
          `[gelbooru-integration] Skipping rating-vocab canary sanity check: request failed: ${String(
            (error as { message?: string })?.message ?? error,
          )}`,
        );
        return;
      }
      throw error;
    }

    expect(batch.items.length).toBeGreaterThan(0);
  }, 20_000);

  test('search page returns hits and a cursor that advances', async () => {
    let page: Awaited<ReturnType<typeof fetchGelbooruSearchPage>>;
    try {
      page = await fetchGelbooruSearchPage({
        request: {
          tags: ['1girl'],
          excludedTags: [],
          nsfwMode: 'sfw',
          orientation: 'any',
          animationMode: 'exclude',
          minWidth: 0,
          maxBytes: 0,
        },
        cursor: undefined,
        credential,
        limit: 5,
        fetcher: fetch as unknown as GelbooruDapiFetcher,
      });
    } catch (error) {
      if (isNetworkUnreachable(error)) {
        console.warn(
          `[gelbooru-integration] Skipping search page: request failed: ${String(
            (error as { message?: string })?.message ?? error,
          )}`,
        );
        return;
      }
      throw error;
    }

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.nextCursor).toEqual({ page: 1 });
  }, 20_000);
});
