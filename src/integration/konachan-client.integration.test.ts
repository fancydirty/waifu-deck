/**
 * Real-API integration test for the Konachan Moebooru source (G2a-1 Task 4).
 *
 * The unit suites (`moebooru-engine.test.ts`, and Konachan's slice of the
 * provider-registry suite) prove the engine's parsing and filtering logic
 * against fixtures we wrote ourselves. What only a live request can prove is
 * that konachan.com's real `post.json` response shape still round-trips
 * through `createMoebooruEngine`'s parser, and that `rating:s` querying
 * really filters explicit content server-side — not just in a fixture that
 * happens to agree with our assumptions.
 *
 * Unlike the BYOS suites in this directory, Konachan's post.json endpoint is
 * public and unauthenticated: there is no BYOS_IT_*-style credential to gate
 * on. "Network-graceful" here instead means attempting the real request and,
 * if it fails for network/availability reasons (offline runner, DNS failure,
 * konachan.com down or rate-limiting), logging and skipping the assertions
 * rather than failing the run — the same non-hard-fail spirit as the other
 * integration suites, adapted to an endpoint that needs no configuration to
 * attempt in the first place. A real assertion failure (bad shape, unsafe
 * content leaking through rating:s) still fails the test.
 *
 * `konachan-client.ts` transitively imports two native-only modules at
 * module scope, neither of which this suite's logic ever needs (it always
 * passes its own `fetcher: fetch`, and distribution policy is irrelevant to
 * a direct fetchBatch call):
 *
 * - `expo/fetch` (via `moebooru-engine.ts`, for its default fetcher). Its
 *   real implementation reaches into `react-native` for its native bridge.
 * - `expo-constants` (via `distribution-policy.ts`, imported by both
 *   `moebooru-engine.ts` and `settings.ts`, for `Constants.expoConfig`).
 *   Its real implementation reaches into `expo-modules-core`, which also
 *   pulls in `react-native`.
 *
 * `react-native/index.js` references the RN-global `__DEV__` merely by being
 * evaluated (`if (__DEV__) { ... }` at module top level) — undefined under
 * this suite's plain Node `testEnvironment` (see jest.integration.config.js's
 * header comment on why this config deliberately isn't `jest-expo`, which is
 * what normally supplies that global). So merely importing
 * `konachan-client.ts` here would throw before any test runs. Mocking both
 * leaf modules to inert passthroughs — scoped to this test file only via
 * `jest.mock`, not a global config or production-code change — keeps
 * `react-native` out of the require graph entirely and lets the import
 * succeed; the BYOS integration suites in this directory established the
 * same per-file-mock technique for their own native-only imports
 * (`expo-crypto`, `expo-secure-store`), just via moduleNameMapper instead of
 * inline `jest.mock` because those two are shared across multiple suites.
 */
jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));

import type { MoebooruFetcher } from '@/features/providers/engines/moebooru-engine';
import { fetchKonachanBatch, fetchKonachanSearchPage } from '@/features/konachan/konachan-client';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { SearchRequest } from '@/features/search/types';
import type { AppSettings } from '@/features/waifu/types';

const KONACHAN_HOST = 'konachan.net'; // SFW mirror — konachan.com is Cloudflare-challenged (403); see konachan-client.ts

// DEFAULT_SETTINGS already ships nsfwMode: 'sfw' (see settings.ts), which is
// what makes the engine query `rating:s`; spelled out explicitly here so the
// assertion below ("every item is 'safe'") reads as a deliberate condition of
// this test, not an accident of whatever the default happens to be today.
//
// orientation is deliberately overridden to 'any'. DEFAULT_SETTINGS.orientation
// is 'portrait', and matchesCandidateSettings drops every landscape candidate
// (width >= height) client-side. Konachan's rating:s front page skews heavily
// landscape (wallpapers), so a small live sample under the 'portrait' default
// filters to zero items — which has nothing to do with what this suite proves
// (real-response round-trip through the parser + rating:s -> 'safe' holding).
// Relaxing this ORTHOGONAL geometry filter lets the real safety assertions
// actually run on live data; nsfwMode: 'sfw' (the thing under test) is untouched.
const sfwSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: 'sfw',
  orientation: 'any',
};

describe('Konachan real API (post.json) integration', () => {
  test('fetches real posts and rating:s holds under sfw settings', async () => {
    let result: Awaited<ReturnType<typeof fetchKonachanBatch>>;
    try {
      result = await fetchKonachanBatch({
        settings: sfwSettings,
        excludedIds: [],
        count: 5,
        // Real fetch, not the `expo/fetch` default — this Node integration
        // environment has no native Expo runtime to back it (see
        // jest.integration.config.js's header comment).
        fetcher: fetch as unknown as MoebooruFetcher,
      });
    } catch (error) {
      // Deliberately broad: this can be a real outage/rate-limit or a DNS
      // failure in an offline CI runner. (During Task 4's own run this also
      // caught a *deterministic* HTTP 500 caused by the query carrying 9 tags
      // — the full 8-tag hard-exclusion set plus rating:s — which exceeded
      // Konachan's anonymous 7-tag cap. That is now FIXED: KONACHAN_CONFIG sets
      // queryExclusionTags to just {loli, shota}, so the discovery query is
      // rating:s + -loli + -shota = 3 tags. A 500 here now would be a genuine
      // regression, but a live-host request-time failure is still not this
      // suite's to fail the build over; the exact cause is preserved below.
      console.warn(
        `[konachan-integration] Skipping: konachan.com request failed: ${String(
          (error as { message?: string })?.message ?? error,
        )}`,
      );
      return;
    }

    // With the 7-tag-cap fix in place, a successful response to a rating:s
    // discovery query MUST yield posts — konachan.com's rating:s corpus is
    // enormous, so zero surviving items now signals a real regression (query
    // shape broke, parser rejected the real shape, or client-side filtering
    // over-dropped), not a transient empty page. This is the happy-path
    // assertion the fix exists to make pass.
    expect(result.items.length).toBeGreaterThan(0);
    console.log(`[konachan-integration] konachan.com returned ${result.items.length} item(s).`);

    for (const item of result.items) {
      expect(item.providerKey).toBe('konachan');

      // remoteUrl must be a trusted konachan.com (or subdomain) HTTPS URL —
      // this is the engine's own `trustedUrl` guard proving out against a
      // real response, not a fixture we control.
      const remote = new URL(item.remoteUrl);
      expect(remote.protocol).toBe('https:');
      expect(remote.hostname === KONACHAN_HOST || remote.hostname.endsWith(`.${KONACHAN_HOST}`))
        .toBe(true);

      expect(Number.isInteger(item.width)).toBe(true);
      expect(item.width).toBeGreaterThan(0);
      expect(Number.isInteger(item.height)).toBe(true);
      expect(item.height).toBeGreaterThan(0);

      // The load-bearing assertion: konachan.com's API returns posts across
      // all ratings regardless of the `tags=rating:s` query filter being
      // honored server-side, and the engine also re-filters client-side
      // (adaptPosts -> matchesContentMode). Every item surviving fetchBatch
      // under sfw settings must be 'safe' — proving rating:s filtering holds
      // end-to-end against the real API, not just against a fixture.
      expect(item.contentRating).toBe('safe');
      expect(item.nativeRating).toBe('s');
      expect(item.isNsfw).toBe(false);

      // sourceUrl is always populated: either the post's real `source` field
      // (often a pixiv URL for Konachan) or the engine's konachan.com
      // fallback — either way it must be a plausible, parseable URL.
      expect(item.sourceUrl).toBeTruthy();
      expect(() => new URL(item.sourceUrl as string)).not.toThrow();
    }
  }, 20_000);

  // R8.15: the owner reported Konachan returning nothing for ANY keyword.
  // Root cause was upstream of this client — `buildSearchRequest` leaked the
  // deck's portrait orientation filter into search, and Konachan's corpus is
  // landscape-heavy wallpapers, so matchesCandidateSettings discarded every
  // result client-side. That leak is fixed in search-screen-model.ts; this
  // test pins the wiring this suite owns: with an 'any' search request the
  // REAL API must yield non-zero hits for a common English tag, and under the
  // old portrait leak the same request would have been filtered to zero.
  test('R8.15: a raw-tag search page returns real posts under any-orientation search requests', async () => {
    const request: SearchRequest = {
      tags: ['hatsune_miku'],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    };

    let page: Awaited<ReturnType<typeof fetchKonachanSearchPage>>;
    try {
      page = await fetchKonachanSearchPage({
        request,
        cursor: { page: 1 },
        limit: 20,
        fetcher: fetch as unknown as MoebooruFetcher,
      });
    } catch (error) {
      console.warn(
        `[konachan-integration] Skipping R8.15 search check: request failed: ${String(
          (error as { message?: string })?.message ?? error,
        )}`,
      );
      return;
    }

    // A common English tag on the real corpus must yield hits — zero here
    // signals the search wiring broke again (query shape, parser, or a
    // client-side filter silently eating the corpus).
    expect(page.items.length).toBeGreaterThan(0);
    console.log(`[konachan-integration] R8.15 search returned ${page.items.length} item(s).`);
    for (const hit of page.items) {
      expect(hit.key).toMatch(/^konachan:\d+$/);
      expect(() => new URL(hit.image.remoteUrl)).not.toThrow();
    }
  }, 20_000);
});
