/**
 * Real-API cross-source dedup integration test (G2b Task 4).
 *
 * G2b Task 3 already proves the persistence gate suppresses a cross-source
 * re-offer, using hand-seeded rows in `image-repository.test.ts`
 * ("cross-source suppression of a dismissed image"). Those fixtures were
 * written by us, so they prove the SQL, not the wiring: a parser that quietly
 * returned `md5: null`, or a `canonicalizeSourceUrl` that fell through to the
 * generic `url:` bucket for every real booru `source` field, would leave every
 * one of those seeded tests green while the shipped app suppressed nothing.
 *
 * What only a live request can prove, and what this suite exists for:
 *
 *  1. Danbooru's `md5` and e621's `file.md5` are ACTUALLY present on real
 *     payloads and survive `parseCandidate` as 32-char lowercase hex. Signal B
 *     is worth exactly nothing if the live corpus omits the field or formats
 *     it differently from our fixtures.
 *  2. `canonicalizeSourceUrl` produces a real `pixiv:<id>` scheme key from
 *     whatever Danbooru actually puts in `source`/`pixiv_id` today — the
 *     precondition for signal A ever firing across two boorus.
 *  3. Real-payload-shaped candidates, pushed through the REAL migrated schema
 *     and the REAL `insertCandidates` gate, are suppressed by each of the two
 *     new arms independently, and a genuinely different real post is not.
 *
 * The deterministic legs (`describe` #2) carry the load. A live Danbooru/e621
 * mirror pair is not guaranteed to exist in any small sample of two recent
 * pages — the two sites' recent uploads barely overlap — so demanding one
 * would make this suite a coin flip. Instead the deterministic legs build the
 * second candidate out of REAL payload fields (a real e621 post's identity and
 * remote URL carrying a real Danbooru post's pixiv key, and a real e621 post
 * carrying a real Danbooru post's md5) and run those through the real gate.
 * The opportunistic leg (`describe` #3) then scans the two live pages for an
 * actual collision and asserts on it when one exists, logging a documented
 * "no live mirror pair in sample" pass when one does not.
 *
 * Network-graceful, on the same NARROW terms as `e621-client.integration.
 * test.ts`: only genuine unreachability (DNS failure, connection refused,
 * timeout, abort) is logged and skipped. An HTTP-level failure from a
 * reachable server — a 403, a schema change, an empty page — is a real
 * regression this suite exists to catch and hard-fails.
 *
 * e926 is deliberately absent: its Cloudflare edge 403s Node's undici fetch on
 * TLS fingerprint regardless of User-Agent (documented at length in
 * `e621-client.integration.test.ts`), and it shares 100% of e621's parser,
 * including the `file.md5` read this suite checks.
 *
 * The two `jest.mock`s below keep `react-native` out of the require graph
 * under this suite's plain Node environment; see the same pair, and the
 * reasoning, in `e621-client.integration.test.ts`.
 */
jest.mock('expo/fetch', () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));

import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import { fetchDanbooruSearchPage } from '@/features/danbooru/danbooru-client';
import { fetchE621SearchPage } from '@/features/e621/e621-client';
import {
  createImageRepository,
  type ImageRepository,
} from '@/features/images/image-repository';
import {
  DanbooruApiError,
  type DanbooruFetcher,
} from '@/features/providers/engines/danbooru-engine';
import type { DanbooruSearchCursor, SearchRequest } from '@/features/search/types';
import type { ImageCandidate } from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

/** A booru MD5 as it must reach SQLite: lowercase hex, never a Buffer. */
const MD5_HEX = /^[0-9a-f]{32}$/;

/** Pages per source. Two spaced pages stay well inside e621's 2 req/s cap. */
const PAGES_PER_SOURCE = 2;
const PAGE_LIMIT = 50;
/** e621 penalises bursts with 503; the app's own bulkhead spaces calls too. */
const REQUEST_SPACING_MS = 600;

const searchRequest: SearchRequest = {
  tags: [],
  excludedTags: [],
  nsfwMode: 'sfw',
  // Orientation is an ORTHOGONAL client-side geometry filter; leaving the
  // shipped 'portrait' default in place would race the real assertions to an
  // empty sample. Same carve-out as the Konachan/e621 suites.
  orientation: 'any',
  animationMode: 'include',
  minWidth: 0,
  maxBytes: 0,
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Genuine unreachability — offline runner, DNS failure, timeout, abort. */
function isNetworkUnreachable(error: unknown): boolean {
  return (
    error instanceof DanbooruApiError &&
    (error.code === 'network' || error.code === 'timeout' || error.code === 'aborted')
  );
}

/**
 * e621 rejects a missing/default User-Agent with 403. A 403 here is a real
 * regression (the mandatory UA stopped being accepted), not something to skip.
 */
function failLoudlyOn403(error: unknown, label: string): void {
  if (error instanceof DanbooruApiError && error.status === 403) {
    throw new Error(
      `[cross-source-dedup] Got HTTP 403 from ${label} — the mandatory User-Agent ` +
        'is apparently no longer accepted. Report this; do not fix production ' +
        `code from this suite. Original: ${error.message}`,
    );
  }
}

type PageFetcher = (cursor: DanbooruSearchCursor | undefined) => Promise<{
  items: readonly { image: ImageCandidate }[];
  nextCursor: DanbooruSearchCursor | null;
}>;

/** Walks `PAGES_PER_SOURCE` keyset pages, politely spaced, into one array. */
async function collectCandidates(
  label: string,
  fetchPage: PageFetcher,
): Promise<ImageCandidate[]> {
  const candidates: ImageCandidate[] = [];
  let cursor: DanbooruSearchCursor | undefined;
  for (let page = 0; page < PAGES_PER_SOURCE; page += 1) {
    if (page > 0) await delay(REQUEST_SPACING_MS);
    let result: Awaited<ReturnType<PageFetcher>>;
    try {
      result = await fetchPage(cursor);
    } catch (error) {
      failLoudlyOn403(error, label);
      throw error;
    }
    for (const hit of result.items) candidates.push(hit.image);
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  return candidates;
}

type LiveSample = {
  danbooru: ImageCandidate[];
  e621: ImageCandidate[];
};

let sample: LiveSample | null = null;
let unreachableReason: string | null = null;

/** Logs and returns true when the sample could not be fetched at all. */
function skippedForNetwork(label: string): boolean {
  if (unreachableReason === null) return false;
  console.warn(
    `[cross-source-dedup] Skipping ${label}: live pages were unreachable ` +
      `(network-unreachable, not an HTTP failure): ${unreachableReason}`,
  );
  return true;
}

beforeAll(async () => {
  try {
    const danbooru = await collectCandidates('danbooru', (cursor) =>
      fetchDanbooruSearchPage({
        request: searchRequest,
        cursor,
        limit: PAGE_LIMIT,
        // Real fetch, not the `expo/fetch` default: this Node environment has
        // no native Expo runtime behind it.
        fetcher: fetch as unknown as DanbooruFetcher,
      }),
    );
    await delay(REQUEST_SPACING_MS);
    const e621 = await collectCandidates('e621', (cursor) =>
      fetchE621SearchPage({
        request: searchRequest,
        cursor,
        limit: PAGE_LIMIT,
        fetcher: fetch as unknown as DanbooruFetcher,
      }),
    );
    sample = { danbooru, e621 };
    console.log(
      `[cross-source-dedup] sampled ${danbooru.length} danbooru + ${e621.length} ` +
        'e621 candidate(s) from live search pages.',
    );
  } catch (error) {
    if (isNetworkUnreachable(error)) {
      unreachableReason = String((error as { message?: string })?.message ?? error);
      return;
    }
    // Anything else — 403, schema change, parse failure — is a real
    // regression and fails every test in this file, loudly.
    throw error;
  }
}, 60_000);

async function openRepository(): Promise<{
  nativeDatabase: DatabaseSync;
  repository: ImageRepository;
  countRows: () => Promise<number>;
  allIdentities: () => Promise<
    { provider_key: string; provider_item_id: string; decision: string }[]
  >;
}> {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  // The REAL migration chain, up to and including the v15 `images.md5` column
  // and its partial index — not a hand-written test schema.
  await migrateDatabase(database);
  return {
    allIdentities: () =>
      database.getAll('SELECT provider_key, provider_item_id, decision FROM images'),
    countRows: async () =>
      (await database.getFirst<{ count: number }>('SELECT COUNT(*) AS count FROM images'))
        ?.count ?? 0,
    nativeDatabase,
    repository: createImageRepository(database),
  };
}

/**
 * Inserts one real candidate and walks it through the repository's REAL
 * dismissal path (queue -> activate -> decide('dismissed')), which is exactly
 * what a left swipe does in the app.
 */
async function seedDismissed(
  repository: ImageRepository,
  candidate: ImageCandidate,
): Promise<number> {
  await expect(repository.insertCandidates([candidate])).resolves.toMatchObject({ inserted: 1 });
  const active = await repository.activateNext(10);
  expect(active).not.toBeNull();
  await repository.decide(active!.id, 'dismissed', 20);
  return active!.id;
}

describe('live booru payloads carry the md5 signal B depends on', () => {
  test('every real danbooru and e621 candidate exposes 32-char lowercase hex md5', () => {
    if (skippedForNetwork('md5 wiring assertions')) return;
    const { danbooru, e621 } = sample!;

    // A rating:general / rating:s search page on either site is never legitimately
    // empty; zero items means the query shape or the parser broke.
    expect(danbooru.length).toBeGreaterThan(0);
    expect(e621.length).toBeGreaterThan(0);

    for (const [label, candidates] of [
      ['danbooru', danbooru],
      ['e621', e621],
    ] as const) {
      const withMd5 = candidates.filter((candidate) => candidate.md5 !== null);
      console.log(
        `[cross-source-dedup] ${label}: ${withMd5.length}/${candidates.length} ` +
          'candidate(s) carry md5.',
      );
      // Both sites publish md5 on every post; a partial rate would mean the
      // parser is reading the wrong field for some shapes.
      expect(withMd5.length).toBe(candidates.length);
      for (const candidate of candidates) {
        expect(typeof candidate.md5).toBe('string');
        expect(candidate.md5).toMatch(MD5_HEX);
        // Hermes has no Buffer. The digest must stay a plain string the whole
        // way to SQLite, never a Node binary type.
        expect(ArrayBuffer.isView(candidate.md5 as unknown as ArrayBufferView)).toBe(false);
      }
    }
  });

  test('real danbooru posts yield pixiv: canonical source keys (signal A precondition)', () => {
    if (skippedForNetwork('canonical source key assertions')) return;
    const pixiv = sample!.danbooru.filter((candidate) =>
      candidate.canonicalSourceKey?.startsWith('pixiv:'),
    );
    console.log(
      `[cross-source-dedup] danbooru: ${pixiv.length}/${sample!.danbooru.length} ` +
        'candidate(s) canonicalize to a pixiv: key.',
    );
    // If the live corpus stopped producing any pixiv-sourced post in 100
    // recent SFW posts, signal A could never fire cross-source and the finding
    // belongs in a report, not in a silent pass.
    expect(pixiv.length).toBeGreaterThan(0);
    for (const candidate of pixiv) {
      expect(candidate.canonicalSourceKey).toMatch(/^pixiv:\d+$/);
    }
  });
});

describe('real-payload cross-source re-offers hit the persistence gate', () => {
  /**
   * Picks the first real danbooru candidate whose source canonicalizes to a
   * pixiv scheme key — the dismissed row every leg below is seeded from.
   */
  function pixivAnchor(): ImageCandidate | null {
    return (
      sample!.danbooru.find((candidate) =>
        candidate.canonicalSourceKey?.startsWith('pixiv:'),
      ) ?? null
    );
  }

  /**
   * The real e621 post all three legs below are built from. Its md5 and source
   * key must genuinely differ from the anchor's, so each leg introduces
   * exactly ONE shared identity and the arm under test is the only one that
   * can fire.
   *
   * Using ONE carrier across the legs makes this a controlled three-way
   * contrast on the same live post rather than three unrelated scenarios: swap
   * its source key and it is suppressed, swap its md5 and it is suppressed,
   * leave it alone and it is queued. The single swapped field is then
   * demonstrably the whole cause.
   */
  function mirrorCarrier(anchor: ImageCandidate): ImageCandidate | undefined {
    return sample!.e621.find(
      (candidate) =>
        candidate.md5 !== anchor.md5 &&
        candidate.canonicalSourceKey !== anchor.canonicalSourceKey,
    );
  }

  test('signal A: a real e621 post carrying the dismissed post\'s pixiv key is suppressed', async () => {
    if (skippedForNetwork('signal A leg')) return;
    const anchor = pixivAnchor();
    if (anchor === null) {
      console.warn('[cross-source-dedup] no pixiv-sourced danbooru post in sample.');
      return;
    }
    const carrier = mirrorCarrier(anchor);
    expect(carrier).toBeDefined();

    const { nativeDatabase, repository, countRows, allIdentities } = await openRepository();
    try {
      await seedDismissed(repository, anchor);

      // The re-serve: a REAL e621 post's provider identity, remote URL and
      // md5, but the artwork the user already dismissed (same pixiv source).
      // Only `canonical_source_key` is shared, so only the signal-A arm can
      // fire — the md5 differs and neither side has a perceptual hash.
      const reOffer: ImageCandidate = {
        ...carrier!,
        canonicalSourceKey: anchor.canonicalSourceKey,
      };
      expect(reOffer.providerKey).not.toBe(anchor.providerKey);
      expect(reOffer.md5).not.toBe(anchor.md5);
      expect(reOffer.perceptualHash).toBeNull();
      expect(anchor.perceptualHash).toBeNull();

      await expect(repository.insertCandidates([reOffer])).resolves.toMatchObject({ inserted: 0 });

      expect(await countRows()).toBe(1);
      await expect(repository.restoreDeck()).resolves.toEqual({ active: null, queued: [] });
      await expect(allIdentities()).resolves.toEqual([
        {
          decision: 'dismissed',
          provider_key: anchor.providerKey,
          provider_item_id: anchor.providerItemId,
        },
      ]);
      console.log(
        `[cross-source-dedup] signal A: danbooru#${anchor.providerItemId} ` +
          `(${anchor.canonicalSourceKey}) suppressed a re-offer as ` +
          `${reOffer.providerKey}#${reOffer.providerItemId}.`,
      );
    } finally {
      nativeDatabase.close();
    }
  }, 30_000);

  test('signal B: a real e621 post carrying the dismissed post\'s md5 is suppressed', async () => {
    if (skippedForNetwork('signal B leg')) return;
    const anchor = pixivAnchor();
    if (anchor === null) {
      console.warn('[cross-source-dedup] no pixiv-sourced danbooru post in sample.');
      return;
    }

    // The same live post, this time with only its digest replaced by the
    // dismissed post's: the ONLY identity in common is the md5.
    const carrier = mirrorCarrier(anchor);
    expect(carrier).toBeDefined();

    const { nativeDatabase, repository, countRows, allIdentities } = await openRepository();
    try {
      await seedDismissed(repository, anchor);

      const reEncodeMirror: ImageCandidate = { ...carrier!, md5: anchor.md5 };
      expect(reEncodeMirror.md5).toMatch(MD5_HEX);
      expect(reEncodeMirror.canonicalSourceKey).not.toBe(anchor.canonicalSourceKey);
      expect(reEncodeMirror.providerKey).not.toBe(anchor.providerKey);

      await expect(repository.insertCandidates([reEncodeMirror])).resolves.toMatchObject({ inserted: 0 });

      expect(await countRows()).toBe(1);
      await expect(repository.restoreDeck()).resolves.toEqual({ active: null, queued: [] });
      await expect(allIdentities()).resolves.toEqual([
        {
          decision: 'dismissed',
          provider_key: anchor.providerKey,
          provider_item_id: anchor.providerItemId,
        },
      ]);
      console.log(
        `[cross-source-dedup] signal B: md5 ${anchor.md5} suppressed a re-offer as ` +
          `${reEncodeMirror.providerKey}#${reEncodeMirror.providerItemId} ` +
          `(${reEncodeMirror.canonicalSourceKey}).`,
      );
    } finally {
      nativeDatabase.close();
    }
  }, 30_000);

  test('negative control: the same real post, unmodified, still reaches the queue', async () => {
    if (skippedForNetwork('negative control')) return;
    const anchor = pixivAnchor();
    if (anchor === null) {
      console.warn('[cross-source-dedup] no pixiv-sourced danbooru post in sample.');
      return;
    }
    // The SAME live post the two legs above suppressed, this time untouched.
    // Different provider identity, different source key, different bytes:
    // nothing about it may be treated as identity. The single delta between
    // this leg and those is the one swapped field, which is the claim.
    const other = mirrorCarrier(anchor);
    expect(other).toBeDefined();

    const { nativeDatabase, repository, countRows } = await openRepository();
    try {
      await seedDismissed(repository, anchor);

      await expect(repository.insertCandidates([other!])).resolves.toMatchObject({ inserted: 1 });

      expect(await countRows()).toBe(2);
      const deck = await repository.restoreDeck();
      expect(deck.queued).toHaveLength(1);
      expect(deck.queued[0]).toMatchObject({
        decision: 'queued',
        md5: other!.md5,
        providerItemId: other!.providerItemId,
        providerKey: other!.providerKey,
      });
      console.log(
        `[cross-source-dedup] negative control: ${other!.providerKey}#` +
          `${other!.providerItemId} was queued as expected.`,
      );
    } finally {
      nativeDatabase.close();
    }
  }, 30_000);
});

describe('opportunistic live mirror pair', () => {
  test('any real collision between the two sampled pages is suppressed to one row', async () => {
    if (skippedForNetwork('live mirror scan')) return;
    const { danbooru, e621 } = sample!;

    let pair: { anchor: ImageCandidate; mirror: ImageCandidate; via: string } | null = null;
    for (const mirror of e621) {
      const anchor = danbooru.find(
        (candidate) =>
          (candidate.canonicalSourceKey !== null &&
            candidate.canonicalSourceKey === mirror.canonicalSourceKey) ||
          (candidate.md5 !== null && candidate.md5 === mirror.md5),
      );
      if (anchor) {
        pair = {
          anchor,
          mirror,
          via:
            anchor.canonicalSourceKey === mirror.canonicalSourceKey
              ? `canonical source key ${anchor.canonicalSourceKey}`
              : `md5 ${anchor.md5}`,
        };
        break;
      }
    }

    if (pair === null) {
      // Documented, expected outcome, NOT a silent weakening: the two sites'
      // recent uploads rarely overlap, so a live pair in a 100+100 sample is
      // luck. The deterministic legs above already ran real-payload data
      // through the same gate arms.
      console.log(
        `[cross-source-dedup] no live mirror pair in sample (${danbooru.length} ` +
          `danbooru x ${e621.length} e621 candidates scanned on source key and md5).`,
      );
      return;
    }

    console.log(
      `[cross-source-dedup] LIVE mirror pair found via ${pair.via}: ` +
        `danbooru#${pair.anchor.providerItemId} <-> ` +
        `${pair.mirror.providerKey}#${pair.mirror.providerItemId}.`,
    );

    const { nativeDatabase, repository, countRows } = await openRepository();
    try {
      await seedDismissed(repository, pair.anchor);
      await expect(repository.insertCandidates([pair.mirror])).resolves.toMatchObject({ inserted: 0 });
      expect(await countRows()).toBe(1);
      await expect(repository.restoreDeck()).resolves.toEqual({ active: null, queued: [] });
    } finally {
      nativeDatabase.close();
    }
  }, 30_000);
});
