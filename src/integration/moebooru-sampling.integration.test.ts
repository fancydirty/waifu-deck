/**
 * Real-API integration gate for G3a's two Moebooru claims (Task 4).
 *
 * G3a Task 1 appended `order:random` to the DISCOVERY query of both Moebooru
 * instances and raised the discovery cap to 12, on the strength of a live
 * probe. G3a Task 2 then made Konachan refuse to participate at all under
 * `orientation: 'portrait'`, on the strength of a second live probe that found
 * konachan.com's portrait corpus to be empty at the board level. Both are
 * claims about *someone else's server*, and neither unit suite can hold them:
 * `moebooru-engine.test.ts` proves the URL we build, and `provider-registry`'s
 * availability suite proves the rule we wrote down. Nothing in the fixture
 * world notices the day konachan.com starts accepting portrait uploads, or the
 * day an instance stops honouring `order:random` and quietly serves the same
 * newest page to every refill again.
 *
 * So this suite asks the real hosts, with the app's exact tag set and headers:
 *
 * 1. `order:random` varies the sample — three spaced calls to the app's own
 *    discovery URL must not all return the same ids. This is the whole point
 *    of Task 1: before it, every refill re-pulled the same newest page.
 * 2. Konachan's anonymous 7-tag ceiling still has room. G2a-1 lost a day to a
 *    deterministic HTTP 500 from a 9-tag query; `order:random` spends one more
 *    tag against that ceiling, so the count is asserted numerically per
 *    nsfwMode AND the live host is made to accept each variant with a 200.
 * 3. The portrait-corpus fact that Task 2's capability rule rests on. If
 *    konachan.com ever answers these probes with a post, this test FAILS and
 *    says which production rule must be revisited — the dependency is encoded
 *    in the gate instead of living in a commit message. A yande.re probe runs
 *    the same query shape and must return posts, which is what makes the
 *    konachan zero mean "this board has no portraits" rather than "this probe
 *    never matches anything".
 *
 * Network-graceful, deliberately narrowly: only a *thrown* fetch (DNS failure,
 * refused connection, offline runner) skips. An HTTP status that is not 200, a
 * response that is not the bare array Moebooru documents, or a corpus that
 * disagrees with a production rule is a real failure — those are the findings
 * this suite exists to surface, and excusing them would make it decorative.
 *
 * One exception is about the *runner*, not the host's answer (2026-10-03):
 * konachan.net's Cloudflare now answers Node's own fetch with HTTP 403 and
 * `cf-mitigated: challenge`, while curl from the same Mac and the phone's
 * Android HTTP stack (the app's path) get 200 for the same URLs. A challenge
 * says nothing about `order:random` or the tag ceiling, so the request is
 * repeated once with curl (same URL, same headers) and curl's status and body
 * are what the assertions see. No curl on the runner → HostUnreachable (skip).
 * Any other non-200 is still a failure.
 *
 * The two `jest.mock` calls below are the technique
 * `konachan-client.integration.test.ts` established, for the same reason:
 * `expo/fetch` and `expo-constants` both reach `react-native`, whose top-level
 * `if (__DEV__)` throws under this config's plain Node environment (see
 * jest.integration.config.js). Neither is needed here — every request in this
 * file is issued by the Node `fetch` directly, and the distribution policy is
 * passed explicitly rather than read from `expoConfig`.
 */
import { execFileSync } from 'node:child_process';

jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));

import { DIRECT_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import { buildKonachanUrl } from '@/features/konachan/konachan-client';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings, NsfwMode } from '@/features/waifu/types';
import { buildYandereUrl } from '@/features/yandere/yandere-client';

/**
 * The app's own headers, restated here only for the RAW probes in test 3 —
 * those bypass the engine (they query a geometry band the app never asks for)
 * and would otherwise reach konachan.com as an unidentified client, which is
 * exactly the difference that could make a probe answer differently from the
 * app. The engine-built requests in tests 1 and 2 carry these via the engine.
 */
const APP_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'WaifuDeck/1.0 (Expo; https://github.com/fancydirty)',
} as const;

/**
 * Konachan caps anonymous queries at 7 tags and answers a longer one with a
 * deterministic HTTP 500 (G2a-1 Task 4). `order:random` spends one of those
 * seven, which is why this ceiling is re-asserted against the real builder.
 */
const KONACHAN_ANONYMOUS_TAG_CEILING = 7;

/** Spacing between the three sample calls; polite, and enough to defeat any edge cache. */
const SAMPLE_INTERVAL_MS = 600;

const NSFW_MODES: readonly NsfwMode[] = ['sfw', 'mixed', 'nsfw'];

/**
 * `orientation` is deliberately left at whatever DEFAULT_SETTINGS ships.
 * Spec §2.5 decided NOT to push geometry down to the server, so it does not
 * reach the query at all — pinning it here would imply a dependency the URL
 * builder does not have. `nsfwMode` is varied explicitly where it matters.
 */
const baseSettings: AppSettings = { ...DEFAULT_SETTINGS };

const settingsFor = (nsfwMode: NsfwMode): AppSettings => ({ ...baseSettings, nsfwMode });

/**
 * The discovery limit both instances now carry (`discoveryLimitCap: 12`), i.e.
 * the `count` fetchBatch clamps to before calling buildUrl. Using it here is
 * what makes these the app's REAL discovery URLs rather than a plausible
 * imitation of them.
 */
const DISCOVERY_LIMIT = 12;

/** Distinguishes "the host could not be reached" from "the host disagreed with us". */
class HostUnreachable extends Error {
  constructor(host: string, cause: unknown) {
    super(`${host} could not be reached: ${String((cause as { message?: string })?.message ?? cause)}`);
    this.name = 'HostUnreachable';
  }
}

const delay = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * One real request. A transport failure becomes HostUnreachable (skippable);
 * everything the server actually said is returned for assertion.
 */
async function getJson(url: string): Promise<{ body: unknown; status: number }> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { headers: APP_HEADERS });
  } catch (error) {
    throw new HostUnreachable(host, error);
  }
  if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') {
    // Cloudflare challenged this runner's Node client, not the query (see the
    // file comment): ask again with curl and assert on what the host says.
    console.warn(`[moebooru-sampling] ${host} challenged Node's fetch; repeating with curl`);
    return getJsonWithCurl(url, host);
  }
  // A non-200 is reported, not thrown: the status itself is under assertion.
  if (!response.ok) return { body: null, status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A 200 whose body is not JSON is a real wire-shape finding, not a skip.
    throw new Error(`${host} returned HTTP 200 with a non-JSON body: ${String(error)}`);
  }
  return { body, status: response.status };
}

/** getJson's fallback for a challenged Node client: one curl request with the app's headers. */
function getJsonWithCurl(url: string, host: string): { body: unknown; status: number } {
  const marker = '\n__waifu_status__:';
  let output: string;
  try {
    output = execFileSync('curl', [
      '-sS', '--max-time', '30',
      ...Object.entries(APP_HEADERS).flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
      '-w', `${marker}%{http_code}`,
      url,
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new HostUnreachable(host, error);
  }
  const at = output.lastIndexOf(marker);
  const status = Number(output.slice(at + marker.length).trim());
  if (at < 0 || !Number.isInteger(status)) {
    throw new HostUnreachable(host, new Error('curl printed no status'));
  }
  if (status !== 200) return { body: null, status };
  try {
    return { body: JSON.parse(output.slice(0, at)) as unknown, status };
  } catch (error) {
    throw new Error(`${host} returned HTTP 200 with a non-JSON body (curl): ${String(error)}`);
  }
}

/**
 * Moebooru's post.json returns a BARE ARRAY, not an envelope — the same shape
 * `fetchBatch` asserts with `Array.isArray(response)` before slicing. Anything
 * else here means the wire contract moved under the engine.
 */
function postsOf(body: unknown, label: string): { id: unknown }[] {
  if (!Array.isArray(body)) {
    throw new Error(`${label} returned ${typeof body}, expected the bare post array Moebooru documents`);
  }
  return body as { id: unknown }[];
}

const idSetOf = (posts: { id: unknown }[]) => new Set(posts.map((post) => String(post.id)));

/** The `tags` query terms of a built URL, whitespace-separated as Moebooru reads them. */
function tagsOf(url: string): string[] {
  return (new URL(url).searchParams.get('tags') ?? '').split(/\s+/).filter(Boolean);
}

const skip = (label: string, error: HostUnreachable) => {
  console.warn(`[moebooru-sampling] Skipping ${label}: ${error.message}`);
};

describe('Moebooru order:random sampling (real API)', () => {
  // The app's REAL discovery URLs, from the production builders.
  const subjects = [
    { build: buildKonachanUrl, label: 'konachan.net' },
    { build: buildYandereUrl, label: 'yande.re' },
  ] as const;

  test.each(subjects)(
    '$label: three discovery calls do not all return the same ids',
    async ({ build, label }) => {
      const url = build(settingsFor('sfw'), DISCOVERY_LIMIT, DIRECT_DISTRIBUTION_POLICY);

      // The sample tag has to be IN the URL under test, or the variation below
      // would be proving nothing about Task 1.
      expect(tagsOf(url)).toContain('order:random');

      const idSets: Set<string>[] = [];
      try {
        for (let call = 0; call < 3; call += 1) {
          if (call > 0) await delay(SAMPLE_INTERVAL_MS);
          const { body, status } = await getJson(url);
          expect(status).toBe(200);
          const posts = postsOf(body, label);
          expect(posts.length).toBeGreaterThan(0);
          idSets.push(idSetOf(posts));
        }
      } catch (error) {
        if (error instanceof HostUnreachable) return skip(label, error);
        throw error;
      }

      const fingerprints = idSets.map((ids) => [...ids].sort().join(','));
      console.log(
        `[moebooru-sampling] ${label} sample sizes ${idSets.map((s) => s.size).join('/')}, `
        + `distinct id sets: ${new Set(fingerprints).size}/3`,
      );

      // NOT all identical. Deliberately weaker than "all three differ": the
      // claim under test is that the sample varies at all, and demanding three
      // pairwise-distinct sets would make the gate flaky on any instance whose
      // randomisation has a coarse period, for no extra proof. Before Task 1
      // all three were the same newest page, so this discriminates exactly.
      expect(new Set(fingerprints).size).toBeGreaterThan(1);
    },
    60_000,
  );

  test('konachan discovery stays under the anonymous 7-tag ceiling and the host accepts it', async () => {
    // Numeric, per nsfwMode: this is the G2a-1 bug class (a 9-tag query that
    // 500s deterministically), re-asserted against the REAL builder rather
    // than a fixture, and then confirmed by the host itself.
    const urls = NSFW_MODES.map((nsfwMode) => {
      const url = buildKonachanUrl(
        settingsFor(nsfwMode), DISCOVERY_LIMIT, DIRECT_DISTRIBUTION_POLICY,
      );
      return { nsfwMode, tags: tagsOf(url), url };
    });

    for (const { nsfwMode, tags } of urls) {
      expect(tags.length).toBeLessThanOrEqual(KONACHAN_ANONYMOUS_TAG_CEILING);
      expect(tags).toContain('order:random');
      console.log(`[moebooru-sampling] konachan ${nsfwMode}: ${tags.length} tag(s) — ${tags.join(' ')}`);
    }

    try {
      for (const { nsfwMode, url } of urls) {
        const { body, status } = await getJson(url);
        // The ceiling is only meaningful as something the host agrees with.
        expect(status).toBe(200);
        postsOf(body, `konachan.com (${nsfwMode})`);
      }
    } catch (error) {
      if (error instanceof HostUnreachable) return skip('konachan.com tag-ceiling probe', error);
      throw error;
    }
  }, 60_000);
});

describe('Konachan portrait corpus (the capability rule this gate falsifies)', () => {
  /**
   * The bands Task 2's rule was derived from. Both describe "taller than wide
   * by a clear margin", at two different scales, so a single unlucky threshold
   * cannot be what produces the zero.
   */
  const PORTRAIT_BANDS = [
    'height:1200.. width:..1100',
    'height:900.. width:..800',
  ] as const;

  const probeUrl = (host: string, band: string) =>
    `https://${host}/post.json?limit=5&tags=${encodeURIComponent(`rating:s ${band}`)}`;

  test.each(PORTRAIT_BANDS)(
    'konachan.com has no rating:s posts matching "%s"',
    async (band) => {
      let result: { body: unknown; status: number };
      try {
        result = await getJson(probeUrl('konachan.com', band));
      } catch (error) {
        if (error instanceof HostUnreachable) return skip('konachan.com portrait probe', error);
        throw error;
      }
      expect(result.status).toBe(200);
      const posts = postsOf(result.body, 'konachan.com');
      console.log(`[moebooru-sampling] konachan portrait probe "${band}": n=${posts.length}`);

      // The falsifier. Konachan is a wallpaper board, so its rating:s corpus is
      // structurally landscape — that corpus fact, not a scheduling decision,
      // is why `provider-registry`'s availabilityFor reports konachan as
      // `unavailable` under orientation: 'portrait'. If this ever returns a
      // post, the rule is stale and the app is now silently refusing a source
      // that could serve the user.
      //
      // Thrown rather than `expect(...).toBe(0)` so the failure carries the
      // instruction with it: this suite's whole reason to exist is that the
      // person who sees it red is unlikely to know which production rule
      // depends on this number. (Jest's `expect` takes no message argument.)
      if (posts.length !== 0) {
        throw new Error(
          `konachan.com now HAS ${posts.length} portrait rating:s post(s) matching "${band}" `
          + `(e.g. id ${String(posts[0]?.id)}). The capability rule in `
          + 'src/features/providers/provider-registry.ts (availabilityFor -> '
          + "unavailable('konachanNoPortrait') when orientation === 'portrait') was "
          + 'derived from this corpus being empty and must be revisited, along with '
          + 'the settings note that tells the user Konachan has no portrait images.',
        );
      }
    },
    30_000,
  );

  test('yande.re answers the same probe shape with posts (the probe is not vacuous)', async () => {
    // The contrast case. Without it, "n=0" could just mean the band syntax is
    // wrong or `rating:s` plus geometry is unsupported — in which case the
    // konachan zero above would be an artifact rather than a corpus fact.
    let result: { body: unknown; status: number };
    try {
      result = await getJson(probeUrl('yande.re', PORTRAIT_BANDS[0]));
    } catch (error) {
      if (error instanceof HostUnreachable) return skip('yande.re portrait probe', error);
      throw error;
    }
    expect(result.status).toBe(200);
    const posts = postsOf(result.body, 'yande.re');
    console.log(`[moebooru-sampling] yande.re portrait probe "${PORTRAIT_BANDS[0]}": n=${posts.length}`);
    expect(posts.length).toBeGreaterThan(0);

    // Confirms the band did what it says: these really are portrait posts.
    for (const post of posts as { height?: unknown; width?: unknown }[]) {
      expect(Number(post.height)).toBeGreaterThan(Number(post.width));
    }
  }, 30_000);
});
