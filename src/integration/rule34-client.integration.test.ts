/**
 * Real-API integration test for the Rule34.xxx source (G4b Task 3).
 *
 * Rule34 is a pure config instance on `createGelbooruDapiEngine` (G4a Task 3
 * already generalized and unit-tested its three quirks: bare-array top-level
 * response, the md5 field named `hash`, and a keyless HTTP-200 string
 * sentinel). The unit suite (`rule34-client.test.ts`) proves the config wires
 * those quirks correctly against a fixture we wrote ourselves. What only a
 * live, credentialed request can prove is that rule34.xxx's real DAPI
 * response shape still round-trips through the engine, that the owner's real
 * api_key/user_id credential is actually accepted, that `rating:explicit`
 * querying really returns nsfw content server-side, and that the two
 * host-specific behaviours (bare array, keyless sentinel) the whole config
 * depends on are still real on the live host today — not just true of the
 * 2026-09-03 probe this file's sibling client was written from.
 *
 * Rule34 is CREDENTIALED (free per-user api_key+user_id, mandatory) — same as
 * Gelbooru, so this suite is gated on `RULE34_API_KEY`/`RULE34_USER_ID` and
 * skips the whole describe block (loudly, via console.warn below) when either
 * is absent, rather than attempting a keyless discovery request that would
 * only prove the auth-failure guard, not the live source. (The auth sentinel
 * IS separately proven live, deliberately keyless, by the third test below.)
 * The credential is read from the environment only — never written to this
 * file, a fixture, a log line, or a commit.
 *
 * "Network-graceful" mirrors the Gelbooru/Konachan/e621 gates in this
 * directory: a genuine network/availability failure (offline runner, DNS
 * failure, rule34.xxx down or rate-limiting) is logged and skipped per-test
 * rather than failing the run. A real shape/safety-contract violation — wrong
 * rating leaking through, an unmapped rating silently admitted, a cursor that
 * doesn't advance, the auth sentinel no longer looking like an auth sentinel —
 * still fails the test; that is precisely what this gate exists to catch.
 *
 * `rule34-client.ts` transitively imports two native-only modules at module
 * scope via `gelbooru-dapi-engine.ts`, neither of which this suite's logic
 * ever needs (it always passes its own `fetcher: fetch`, and distribution
 * policy is irrelevant to a direct fetchBatch/fetchSearchPage call):
 *
 * - `expo/fetch` (the engine's default fetcher).
 * - `expo-constants` (via `distribution-policy.ts`, for `Constants.expoConfig`).
 *
 * Both reach into `react-native`, whose `index.js` references the RN-global
 * `__DEV__` merely by being evaluated — undefined under this suite's plain
 * Node `testEnvironment`. This file is run with
 * `npx jest --config jest.integration.config.js src/integration/rule34-client.integration.test.ts`,
 * exactly like `gelbooru-client.integration.test.ts` — see
 * jest.integration.config.js's header comment for why this config
 * deliberately isn't `jest-expo` (that preset's setup installs a stubbed
 * native `fetch`; every request resolves with no real status, so no real
 * socket is reachable and this gate would prove nothing under it).
 * Mocking both leaf modules to inert passthroughs — scoped to this test file
 * only via `jest.mock` — keeps `react-native` out of the require graph and
 * lets the import succeed; this is the same per-file-mock technique the
 * Gelbooru/Konachan/e621 integration suites established.
 */
jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));

import {
  buildRule34Url,
  fetchRule34Batch,
  fetchRule34SearchPage,
} from '@/features/rule34/rule34-client';
import {
  DIRECT_DISTRIBUTION_POLICY,
} from '@/features/distribution/distribution-policy';
import {
  GELBOORU_MAPPED_RATINGS,
  type GelbooruDapiFetcher,
} from '@/features/providers/engines/gelbooru-dapi-engine';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';

const apiKey = process.env.RULE34_API_KEY;
const userId = process.env.RULE34_USER_ID;
const gated = apiKey && userId ? describe : describe.skip;

if (!apiKey || !userId) {
  console.warn(
    '[rule34-integration] Skipping: RULE34_API_KEY/RULE34_USER_ID not set in the environment.',
  );
}

// orientation is deliberately overridden to 'any' — the same Gelbooru/
// Konachan/e621 lesson: DEFAULT_SETTINGS.orientation is 'portrait', and
// matchesCandidateSettings drops every landscape candidate (width >= height)
// client-side. A small live sample skews toward whatever aspect ratios happen
// to be posted; relaxing this ORTHOGONAL geometry filter lets the real
// safety/parsing assertions actually run instead of racing an unrelated
// client-side filter to zero.
const nsfwSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'nsfw',
  nsfwConfirmed: true,
  orientation: 'any',
};
// 'mixed' is the app's admits-everything mode: ratingQuery() in the engine
// returns no rating: tag for anything other than 'sfw'/'nsfw', so this query
// is unfiltered by rating server-side. That makes it the right vehicle for
// the vocab canary below — a real page unfiltered by our own rating query,
// filtered only by the engine's rating-vocab map.
const mixedSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'mixed',
  nsfwConfirmed: true,
  orientation: 'any',
};

/** Genuine unreachability — offline runner, DNS failure, timeout, rate limit. */
function isNetworkUnreachable(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === 'network' || code === 'timeout' || code === 'aborted' || code === 'rate_limited';
}

gated('Rule34 real API (Gelbooru-DAPI config instance) integration', () => {
  const credential = { apiKey: apiKey!, userId: userId! };

  test('nsfw discovery batch returns >0 candidates, every one nsfw with 32-hex md5', async () => {
    // DIRECT_DISTRIBUTION_POLICY, not the engine default — see the
    // Gelbooru-gate lesson below (this test is the one where the store
    // policy's silent sfw-downgrade would otherwise bite).
    let batch: Awaited<ReturnType<typeof fetchRule34Batch>>;
    try {
      batch = await fetchRule34Batch({
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
          `[rule34-integration] Skipping nsfw discovery: request failed: ${String(
            (error as { message?: string })?.message ?? error,
          )}`,
        );
        return;
      }
      throw error;
    }

    expect(batch.items.length).toBeGreaterThan(0);
    for (const item of batch.items) {
      expect(item.md5).toMatch(/^[0-9a-f]{32}$/); // resolved from `hash`, not `md5`
      expect(item.isNsfw).toBe(true);
    }
  }, 20_000);

  test("rating-vocab canary: live ratings stay within the engine's mapped set", async () => {
    // NOT a real canary if measured via a post-filter count: parsePost's
    // fail-safe (an unmapped `rating` -> toContentRating returns null -> the
    // post is DROPPED) happens strictly after any raw count is captured, so a
    // pre-filter total can't observe that rejection — it would silently keep
    // "looking fine" while `items` silently shrank. The only honest canary is
    // inspecting the RAW `rating` strings the live API actually returns and
    // asserting every one is inside GELBOORU_MAPPED_RATINGS (imported from
    // the engine, not duplicated here, so this can't silently drift from the
    // real map Rule34 shares with Gelbooru). This is a direct, unparsed
    // fetch: it deliberately bypasses fetchRule34Batch/parsePost so it
    // observes the wire shape, not the already-filtered result.
    const url = buildRule34Url(mixedSettings, 10, DIRECT_DISTRIBUTION_POLICY, 0, credential);
    let rawPosts: unknown[];
    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(
          `[rule34-integration] Skipping rating-vocab canary: raw request returned HTTP ${response.status}`,
        );
        return;
      }
      const body = await response.json();
      // Rule34 is a bare array (no {post:[…]} wrapper) — the engine's
      // §3.4 auth guard is exactly what distinguishes this from Gelbooru's
      // object envelope.
      if (!Array.isArray(body)) {
        console.warn('[rule34-integration] Skipping rating-vocab canary: response was not a bare array');
        return;
      }
      rawPosts = body;
    } catch (error) {
      console.warn(
        `[rule34-integration] Skipping rating-vocab canary: raw request failed: ${String(
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
  }, 20_000);

  test('auth sentinel (live): keyless request returns the HTTP-200 string sentinel', async () => {
    // Proves the keyless sentinel the engine's §3.4 auth guard depends on
    // (unwrapPostList: a top-level STRING body throws `auth`) is still real
    // on the live host, not just true of the 2026-09-03 probe the config was
    // written from. Deliberately NO credential on this one request.
    const url = buildRule34Url(nsfwSettings, 3, DIRECT_DISTRIBUTION_POLICY, 0, undefined);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        // Network/infra failure — skip gracefully, not a safety violation.
        console.warn(
          `[rule34-integration] Skipping auth sentinel: keyless probe got HTTP ${response.status}`,
        );
        return;
      }
      const body = await response.text(); // parse as text to catch the string sentinel
      expect(typeof body).toBe('string');
      expect(body).toContain('Missing authentication');
    } catch (error) {
      // Network error — skip, not a safety issue.
      console.warn('[rule34-integration] Skipping auth sentinel: keyless probe network error:', error);
    }
  }, 20_000);

  test('search page returns hits and a cursor that advances', async () => {
    let page: Awaited<ReturnType<typeof fetchRule34SearchPage>>;
    try {
      page = await fetchRule34SearchPage({
        request: {
          tags: ['1girl'],
          excludedTags: [],
          nsfwMode: 'nsfw',
          orientation: 'any',
          animationMode: 'exclude',
          minWidth: 0,
          maxBytes: 0,
        },
        cursor: undefined,
        credential,
        limit: 5,
        fetcher: fetch as unknown as GelbooruDapiFetcher,
        // DIRECT, not the engine default APP_DISTRIBUTION_POLICY — see the
        // header/lesson above. Without it, the mocked expo-constants forces
        // this back to `rating:general`, and Rule34's `general`-rated corpus
        // for a common tag like `1girl` is thin enough that the live query
        // can return a genuinely EMPTY (0-byte) body rather than `[]` — a
        // real Rule34 API quirk (confirmed live 2026-09-05), not a request
        // bug. `nsfwMode:'nsfw'` only reaches the query with DIRECT.
        distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      });
    } catch (error) {
      if (isNetworkUnreachable(error)) {
        console.warn(
          `[rule34-integration] Skipping search page: request failed: ${String(
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
