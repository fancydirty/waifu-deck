import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import { createDataResetCoordinator } from '@/features/data-reset/data-reset-coordinator';
import {
  createDiscoveryService,
  discoveryReserveTarget,
  DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
  MAX_REFILL_BATCHES,
  type DiscoveryBatchFetcher,
} from '@/features/discovery/discovery-service';
import {
  createImageRepository,
  type ImageRepository,
} from '@/features/images/image-repository';
import { createDiscoveryProviderFetcher } from '@/features/providers/provider-client';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import {
  createProviderYieldLedger,
  type ProviderRoundOutcome,
  type ProviderYieldLedger,
} from '@/features/providers/provider-yield-ledger';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type {
  AppSettings,
  ImageCandidate,
  ImageProviderKey,
} from '@/features/waifu/types';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

/**
 * G3 spec §6.3 — the headline gate: **seeded multi-provider no-starve +
 * natural-lean-preserved**, run through the real stack (real
 * `createDiscoveryService`, real `createDiscoveryProviderFetcher`, real
 * `planProviderShares` / `interleaveWithRunCap`, real `node:sqlite`-backed
 * `ImageRepository`, real `ProviderYieldLedger`). Only the eight network
 * clients are stubbed, so nothing here touches the network and the whole run is
 * an ordinary Jest suite.
 *
 * It exists to prove the owner's contract end to end:
 * **a natural lean is fine; artificial starving is the bug.** Both halves
 * have to hold at once, which is why the fixtures are deliberately asymmetric —
 * a uniform fixture would prove nothing about either half.
 *
 * | source | fixture | what it is there to prove |
 * |---|---|---|
 * | `waifu_im` | always returns its full share, unique items (cap 20) | the rich source may lead — and, via the §2.3 top-up, is the one that absorbs the shortfall |
 * | `danbooru` / `yandere` | 3 items per round, whatever the ask | a moderate source keeps landing cards |
 * | `e621` / `e926` | 2 items per round (their declared cap) | a hard-capped source is never squeezed to zero |
 * | `konachan` | never called — `orientation: 'portrait'` capability-skips it | honest emptiness (`skipped_capability`) is not starving |
 * | `nekos_api` | always rejects 429 | a cooling source keeps its floor-of-1 probe and its slack goes to the healthy |
 * | `safebooru` | answers every round, but every item is a DB duplicate | the G2b dedup gate zeroing a source is honest, not scheduling |
 *
 * Determinism: every tie-break in the stack is registry order. No clock, no
 * `Math.random`, no wall time — so every number asserted below is exact rather
 * than statistical.
 */

const LIKED_TAG = 'oceanic';
const DISLIKED_TAG = 'swampy';
const NEUTRAL_TAG = 'driftwood';

/** Spec §6.3: "Run 30 simulated refill rounds". One round = one `fetchBatch`. */
const ROUNDS = 30;
/** Spec §6.3-1's window. */
const WINDOW = 5;
/**
 * Pre-seeded rows whose `canonical_source_key` safebooru re-offers forever.
 * Larger than safebooru's per-round yield so the keys inside one round are
 * distinct — the point is the *DB* dedup gate, not the in-round merge dedupe.
 */
const DUPE_POOL = 8;
/**
 * Spec §6.3-5's yardstick. Pre-G3 the refill loop ran `MAX_REFILL_BATCHES = 3`
 * blind uniform rounds and every round asked all 8 registry sources, so a full
 * refill cycle cost 24 client calls. G3c must not spend more than that.
 */
const PRE_G3_CALLS_PER_REFILL = 3 * 8;

/** The five sources whose corpus can actually answer under these settings. */
const HEALTHY: readonly ImageProviderKey[] = [
  'waifu_im',
  'danbooru',
  'yandere',
  'e621',
  'e926',
];

type StubBatchInput = {
  /** Every adapter except waifu passes the plan's share as `count`. */
  readonly count?: number;
  /** waifu's client names the same thing `pageSize`. */
  readonly pageSize?: number;
};

type StubBatch = { items: ImageCandidate[]; totalCount: number };

type RoundRecord = {
  readonly requested: number;
  readonly returned: number;
  readonly admitted: number;
  readonly inserted: number;
  readonly outcome: ProviderRoundOutcome;
};

type Round = {
  readonly index: number;
  readonly cycle: number;
  readonly desiredCount: number;
  /** Client calls issued while this round ran (wave 1 + any top-up). */
  calls: number;
  /** Per-source ask, in call order: `[wave1, topUp?]`. */
  readonly asks: Map<ImageProviderKey, number[]>;
  readonly records: Map<ImageProviderKey, RoundRecord>;
  /** The ordered list `orderBatchForDeck` handed to `insertCandidates`. */
  ordered: ImageProviderKey[];
};

type Cycle = {
  readonly index: number;
  calls: number;
  /** Persisted `queue_ordinal` order after this cycle's `warmReserve`. */
  deck: ImageProviderKey[];
};

function longestRun(keys: readonly ImageProviderKey[]): number {
  let longest = 0;
  let current = 0;
  let previous: ImageProviderKey | null = null;
  for (const key of keys) {
    current = key === previous ? current + 1 : 1;
    previous = key;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Spec §2.6 second amendment / §6.5: `max(cap, ceil(biggest / (rest + 1)))`.
 * `ceil(biggest / (rest + 1))` is the shortest streak *any* arrangement of
 * these counts can achieve, so a run above it is avoidable, not forced.
 */
function runBound(keys: readonly ImageProviderKey[]): number {
  const counts = new Map<ImageProviderKey, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const biggest = Math.max(0, ...counts.values());
  const rest = keys.length - biggest;
  return Math.max(
    DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
    Math.ceil(biggest / (rest + 1)),
  );
}

type Harness = {
  readonly rounds: readonly Round[];
  readonly cycles: readonly Cycle[];
  readonly callsByProvider: ReadonlyMap<ImageProviderKey, number>;
  readonly totalCalls: number;
  readonly insertedByProvider: ReadonlyMap<ImageProviderKey, number>;
  readonly settings: AppSettings;
  close(): void;
};

async function runSeededRounds(): Promise<Harness> {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);
  const repository = createImageRepository(database);

  let sequence = 0;
  const makeCandidate = (
    providerKey: ImageProviderKey,
    tags: string[],
    canonicalSourceKey: string | null = null,
  ): ImageCandidate => {
    sequence += 1;
    const providerItemId = `${providerKey}-${sequence}`;
    return {
      providerKey,
      providerItemId,
      canonicalSourceKey,
      perceptualHash: null,
      md5: null,
      remoteUrl: `https://cdn.example.com/${providerItemId}.webp`,
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1200,
      height: 1800,
      byteSize: 400_000,
      extension: '.webp',
      dominantColor: '#aabbcc',
      isNsfw: false,
      isAnimated: false,
      tags,
    };
  };

  let now = 1_000;
  const tick = () => (now += 10);

  // The rows safebooru's items will collide with forever, seeded as dismissed
  // so they occupy the identity gate without ever sitting in the deck.
  const dupeKeys: string[] = [];
  for (let index = 0; index < DUPE_POOL; index += 1) {
    const key = `dupe:${index}`;
    dupeKeys.push(key);
    await repository.insertCandidates([
      makeCandidate('safebooru', [NEUTRAL_TAG], key),
    ]);
    const active = await repository.activateNext(tick());
    await repository.decide(active!.id, 'dismissed', tick());
  }
  let dupeCursor = 0;

  const rounds: Round[] = [];
  const cycles: Cycle[] = [];
  const callsByProvider = new Map<ImageProviderKey, number>();
  let totalCalls = 0;
  let roundIndex = -1;
  let cycleIndex = -1;

  const ask = (key: ImageProviderKey, input: StubBatchInput): number => {
    const count = input.pageSize ?? input.count ?? 0;
    callsByProvider.set(key, (callsByProvider.get(key) ?? 0) + 1);
    totalCalls += 1;
    const round = rounds[roundIndex];
    if (round) {
      round.calls += 1;
      const asks = round.asks.get(key);
      if (asks) asks.push(count);
      else round.asks.set(key, [count]);
    }
    return count;
  };
  const fill = (
    key: ImageProviderKey,
    wanted: number,
    tagsFor: (index: number) => string[],
  ): StubBatch => ({
    items: Array.from({ length: wanted }, (_, index) =>
      makeCandidate(key, tagsFor(index))),
    totalCount: wanted,
  });

  // Rich: answers whatever it is asked, always fresh. Its merge order
  // alternates two tags so its cards stay visibly distinct; nothing reorders a
  // bucket, so that merge order is exactly what reaches the deck.
  const fetchWaifu = jest.fn(async (input: StubBatchInput): Promise<StubBatch> =>
    fill('waifu_im', ask('waifu_im', input), (index) =>
      [index % 2 === 0 ? DISLIKED_TAG : LIKED_TAG]));
  // Cooling: a rate-limited-shaped rejection, which `provider-client` maps to
  // the `cooldown` outcome (not `failed`) — the source was never really asked.
  const fetchNekos = jest.fn(async (input: StubBatchInput): Promise<StubBatch> => {
    ask('nekos_api', input);
    throw Object.assign(new Error('nekos_api is rate limited'), {
      code: 'rate_limited',
      status: 429,
      retryAfterMs: 1_000,
    });
  });
  const fetchDanbooru = jest.fn(async (input: StubBatchInput): Promise<StubBatch> =>
    fill('danbooru', Math.min(ask('danbooru', input), 3), () => [NEUTRAL_TAG]));
  // Duplicates-only: it answers every round with fresh provider item ids that
  // all resolve to canonical keys already in the database, so the G2b identity
  // gate suppresses every one of them at insert time.
  const fetchSafebooru = jest.fn(async (input: StubBatchInput): Promise<StubBatch> => {
    const wanted = Math.min(ask('safebooru', input), 3);
    return {
      items: Array.from({ length: wanted }, () => {
        const key = dupeKeys[dupeCursor % dupeKeys.length]!;
        dupeCursor += 1;
        return makeCandidate('safebooru', [NEUTRAL_TAG], key);
      }),
      totalCount: wanted,
    };
  });
  const fetchYandere = jest.fn(async (input: StubBatchInput): Promise<StubBatch> =>
    fill('yandere', Math.min(ask('yandere', input), 3), () => [NEUTRAL_TAG]));
  // Never expected to run — the capability gate skips it under portrait. It
  // counts calls rather than throwing so the assertion reads as a number.
  const fetchKonachan = jest.fn(async (input: StubBatchInput): Promise<StubBatch> =>
    fill('konachan', ask('konachan', input), () => [NEUTRAL_TAG]));
  const fetchE621 = jest.fn(async (input: StubBatchInput): Promise<StubBatch> =>
    fill('e621', Math.min(ask('e621', input), 2), () => [NEUTRAL_TAG]));
  const fetchE926 = jest.fn(async (input: StubBatchInput): Promise<StubBatch> =>
    fill('e926', Math.min(ask('e926', input), 2), () => [NEUTRAL_TAG]));

  const providerFetcher = createDiscoveryProviderFetcher({
    fetchWaifu,
    fetchNekos,
    fetchDanbooru,
    fetchSafebooru,
    fetchYandere,
    fetchKonachan,
    fetchE621,
    fetchE926,
  });

  const fetchBatch: DiscoveryBatchFetcher = async (input) => {
    roundIndex += 1;
    rounds.push({
      index: roundIndex,
      cycle: cycleIndex,
      desiredCount: input.desiredCount,
      calls: 0,
      asks: new Map(),
      records: new Map(),
      ordered: [],
    });
    return providerFetcher(input);
  };

  const base = createProviderYieldLedger();
  const yieldLedger: ProviderYieldLedger = {
    record(key, record) {
      rounds[roundIndex]?.records.set(key, {
        requested: record.requested,
        returned: record.returned,
        admitted: record.admitted,
        inserted: record.inserted,
        outcome: record.outcome,
      });
      base.record(key, record);
    },
    stats: () => base.stats(),
    reset: () => base.reset(),
  };

  // Observes the ordering decision without changing it. Since the G3c Task 4
  // fix the order is decided *inside* the write, over the cards that survived
  // the identity gate, so the thing to watch is the callback's output: that is
  // the sequence `interleaveWithRunCap` produced and the sequence the rows are
  // seated in. Assertion §6.3-3 compares it against what actually persisted.
  const observedRepository: ImageRepository = {
    ...repository,
    async insertCandidates(candidates, options) {
      const orderSurvivors = options?.orderSurvivors;
      return repository.insertCandidates(candidates, {
        ...options,
        ...(orderSurvivors === undefined ? {} : {
          orderSurvivors: (survivors) => {
            const ordered = orderSurvivors(survivors);
            const round = rounds[roundIndex];
            if (round) round.ordered = ordered.map((item) => item.providerKey);
            return ordered;
          },
        }),
      });
    },
  };

  const service = createDiscoveryService({
    repository: observedRepository,
    coordinator: createDataResetCoordinator(),
    fetchBatch,
    clock: tick,
    yieldLedger,
  });

  // prefetchDepth 30 -> reserve target 30: the depth this seeded gate was
  // calibrated at (R8.20 raised the default to 40, so pin it explicitly), where
  // the declared caps actually bite and the merge cap `max(20, desiredCount)`
  // is exercised above its 20 floor.
  const settings: AppSettings = { ...DEFAULT_SETTINGS, prefetchDepth: 30 };
  await service.restore();

  while (rounds.length < ROUNDS) {
    cycleIndex += 1;
    const callsBefore = totalCalls;
    await service.warmReserve(settings);

    const deck = await repository.restoreDeck();
    const ordered = [deck.active, ...deck.queued].flatMap((image) =>
      image ? [image] : []);
    cycles.push({
      index: cycleIndex,
      calls: totalCalls - callsBefore,
      deck: ordered.map((image) => image.providerKey),
    });

    // Swipe the deck empty so the next `warmReserve` really refills. The
    // deck-drain is not what is under test; it just clears the deck so the
    // next cycle issues a fresh refill.
    for (;;) {
      const current = await repository.restoreDeck();
      if (current.active === null && current.queued.length === 0) break;
      if (current.active === null) {
        await repository.activateNext(tick());
        continue;
      }
      await repository.decide(current.active.id, 'dismissed', tick());
    }
    await service.restore();
  }

  const insertedByProvider = new Map<ImageProviderKey, number>();
  for (const round of rounds) {
    for (const [key, record] of round.records) {
      insertedByProvider.set(
        key,
        (insertedByProvider.get(key) ?? 0) + record.inserted,
      );
    }
  }

  return {
    rounds,
    cycles,
    callsByProvider,
    totalCalls,
    insertedByProvider,
    settings,
    close: () => nativeDatabase.close(),
  };
}

describe('discovery balance — seeded 30-round gate (G3 spec §6.3)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await runSeededRounds();
  }, 120_000);

  afterAll(() => {
    harness?.close();
  });

  const inserted = (key: ImageProviderKey, round: Round): number =>
    round.records.get(key)?.inserted ?? 0;

  const windowFloor = (provider: ImageProviderKey): number => {
    let lowest = Number.POSITIVE_INFINITY;
    for (let start = 0; start + WINDOW <= ROUNDS; start += 1) {
      const total = harness.rounds
        .slice(start, start + WINDOW)
        .reduce((sum, round) => sum + inserted(provider, round), 0);
      lowest = Math.min(lowest, total);
    }
    return lowest;
  };

  test('the run is the shape the gate needs: 30 rounds, seven admitted sources, konachan skipped', () => {
    expect(harness.rounds).toHaveLength(ROUNDS);
    // 15 warmReserve cycles of 2 rounds each — `MAX_REFILL_BATCHES` after
    // G3c Task 3 dropped it from 3.
    expect(harness.cycles).toHaveLength(ROUNDS / MAX_REFILL_BATCHES);
    expect(discoveryReserveTarget(harness.settings.prefetchDepth)).toBe(30);
    // Every enabled source is accounted for every round, asked or skipped.
    // Derived from the ENABLED set, not all of PROVIDER_REGISTRY: gelbooru
    // (G4a) is the first default-disabled provider, so "registry == enabled" no
    // longer holds — a disabled source is never admitted or recorded.
    const enabledKeys = PROVIDER_REGISTRY
      .map((adapter) => adapter.key)
      .filter((key) => harness.settings.providers[key])
      .sort();
    for (const round of harness.rounds) {
      expect([...round.records.keys()].sort()).toEqual(enabledKeys);
    }
  });

  test('§6.3-1 no-starve: every capable source lands a card in every 5-round window', () => {
    const starved: {
      provider: ImageProviderKey;
      window: string;
      inserted: number;
    }[] = [];
    for (const provider of HEALTHY) {
      for (let start = 0; start + WINDOW <= ROUNDS; start += 1) {
        const total = harness.rounds
          .slice(start, start + WINDOW)
          .reduce((sum, round) => sum + inserted(provider, round), 0);
        if (total < 1) {
          starved.push({
            provider,
            window: `${start}..${start + WINDOW - 1}`,
            inserted: total,
          });
        }
      }
    }
    expect(starved).toEqual([]);

    // The floor is not merely non-zero — the hard-capped tail sources keep
    // landing several cards per window, which is exactly what S3/S4 ate.
    expect(HEALTHY.map((provider) => [provider, windowFloor(provider)])).toEqual([
      ['waifu_im', 37],
      ['danbooru', 9],
      ['yandere', 6],
      ['e621', 4],
      ['e926', 4],
    ]);
  });

  test('§6.3-1 honest emptiness is not starving: konachan is skipped, never asked', () => {
    expect(harness.insertedByProvider.get('konachan')).toBe(0);
    // Not "asked and got nothing" — never asked at all. Under
    // `orientation: 'portrait'` konachan's corpus is empty board-wide (spec
    // §1 S1), so the capability gate skips it before the share plan runs and
    // it consumes no share from anyone else.
    expect(harness.callsByProvider.get('konachan')).toBeUndefined();
    for (const round of harness.rounds) {
      expect(round.records.get('konachan')).toEqual({
        requested: 0,
        returned: 0,
        admitted: 0,
        inserted: 0,
        outcome: 'skipped_capability',
      });
    }
  });

  test('§6.3-1 honest emptiness is not starving: cooling and duplicate-only sources stay in the plan', () => {
    // nekos rejects 429 every round. It inserts nothing — but it is asked every
    // single round, which is the difference between "upstream refused" and
    // "the scheduler dropped it". One good round would restore its full share.
    expect(harness.insertedByProvider.get('nekos_api')).toBe(0);
    expect(harness.callsByProvider.get('nekos_api')).toBe(ROUNDS);
    for (const round of harness.rounds) {
      expect(round.records.get('nekos_api')?.outcome).toBe('cooldown');
      expect(round.records.get('nekos_api')?.requested).toBeGreaterThanOrEqual(1);
    }

    // safebooru answers every round with usable candidates — its `admitted` is
    // always > 0 — and every one of them is suppressed by the identity gate at
    // insert time. Zero inserted, zero starving: the scheduler did its job and
    // the dedup gate did its job.
    expect(harness.insertedByProvider.get('safebooru')).toBe(0);
    for (const round of harness.rounds) {
      const record = round.records.get('safebooru');
      expect(record?.outcome).toBe('ok');
      expect(record?.admitted).toBeGreaterThan(0);
    }
    // …and because the quiet signal is `admitted`-based (G3b drift item F1), a
    // source whose cards all dedupe away is never read as "quiet", so it never
    // loses its slack for it: its ask stays above the bare floor to the end.
    expect(harness.rounds.at(-2)?.records.get('safebooru')?.requested)
      .toBeGreaterThan(1);
  });

  test('§6.3-2 natural lean preserved: the leader leads by more than 1.5x uniform and nobody is zeroed', () => {
    // Second half of the pair first, because it is the half that fails when the
    // first half is achieved the wrong way.
    const contributors = HEALTHY.filter(
      (provider) => (harness.insertedByProvider.get(provider) ?? 0) > 0,
    );
    expect(contributors).toEqual(HEALTHY);
    expect(HEALTHY.map((provider) => [
      provider,
      harness.insertedByProvider.get(provider),
    ])).toEqual([
      ['waifu_im', 270],
      ['danbooru', 60],
      ['yandere', 45],
      ['e621', 30],
      ['e926', 30],
    ]);

    const total = [...harness.insertedByProvider.values()]
      .reduce((sum, count) => sum + count, 0);
    expect(total).toBe(435);
    const leaderShare = (harness.insertedByProvider.get('waifu_im') ?? 0) / total;
    const uniform = 1 / contributors.length;
    expect(leaderShare).toBeGreaterThan(1.5 * uniform);
    expect(Number(leaderShare.toFixed(4))).toBe(0.6207);
  });

  test('§6.3-3 run cap: no source monopolises the persisted queue_ordinal order', () => {
    // (a) The ordering decision itself: `interleaveWithRunCap`'s output after
    //     the refill's truncation. The hybrid bound holds in every round.
    const orderingViolations = harness.rounds.flatMap((round) => {
      const run = longestRun(round.ordered);
      const bound = runBound(round.ordered);
      return run > bound
        ? [{ round: round.index, run, bound, order: round.ordered.join(' ') }]
        : [];
    });
    expect(orderingViolations).toEqual([]);

    // (b) The persisted deck the user actually swipes. Spec §6.3-3 counts
    //     `queue_ordinal` entries and §6.5 restates the same bound over the
    //     persisted deck, so this is the product-facing form of the criterion.
    const deckViolations = harness.cycles.flatMap((cycle) => {
      const run = longestRun(cycle.deck);
      const bound = runBound(cycle.deck);
      return run > bound
        ? [{ cycle: cycle.index, run, bound, deck: cycle.deck.join(' ') }]
        : [];
    });
    expect(deckViolations).toEqual([]);
  });

  test('§6.3-4 cooldown redistribution: the slack moves to healthy sources the same round', () => {
    const wave1 = (round: Round, key: ImageProviderKey): number =>
      round.asks.get(key)?.[0] ?? 0;
    const registryKeys = PROVIDER_REGISTRY
      .map((adapter) => adapter.key)
      .filter((key) => harness.settings.providers[key]);
    const cold = harness.rounds[0]!;
    const cooled = harness.rounds[2]!;
    expect(cold.desiredCount).toBe(30);
    expect(cooled.desiredCount).toBe(30);

    // Round 0 is the cold start: no ledger evidence yet, so nekos is planned
    // like everyone else and only the declared caps bite (e621/e926 at 2).
    expect(registryKeys.map((key) => [key, wave1(cold, key)])).toEqual([
      ['waifu_im', 7],
      ['nekos_api', 6],
      ['danbooru', 6],
      ['safebooru', 6],
      ['yandere', 6],
      ['konachan', 0],
      ['e621', 2],
      ['e926', 2],
    ]);

    // Round 2 is the first round planned with nekos' cooldown on record. It
    // keeps a floor-of-1 probe — never zero, so one good round restores it —
    // and the 5 units it released are absorbed by sources with headroom in the
    // same round. danbooru takes none: it is already at its declared cap of 6.
    expect(registryKeys.map((key) => [key, wave1(cooled, key)])).toEqual([
      ['waifu_im', 10],
      ['nekos_api', 1],
      ['danbooru', 6],
      ['safebooru', 7],
      ['yandere', 7],
      ['konachan', 0],
      ['e621', 2],
      ['e926', 2],
    ]);
    const absorbers: readonly ImageProviderKey[] = [...HEALTHY, 'safebooru'];
    const absorbed = (round: Round): number =>
      absorbers.reduce((sum, key) => sum + wave1(round, key), 0);
    expect(wave1(cold, 'nekos_api') - wave1(cooled, 'nekos_api')).toBe(5);
    expect(absorbed(cooled) - absorbed(cold)).toBe(5);

    // The probe stays at the floor for the rest of the run, and it is a real
    // request every round — the cooling source is never dropped from the plan.
    for (const round of harness.rounds.slice(1)) {
      expect(wave1(round, 'nekos_api')).toBe(1);
    }
  });

  test('§6.3-5 request volume does not grow past the pre-G3 baseline', () => {
    // Per full refill cycle: 2 rounds x 7 admitted sources + exactly one
    // top-up call = 15, against the pre-G3 3 x 8 = 24.
    for (const cycle of harness.cycles) {
      expect(cycle.calls).toBeLessThanOrEqual(PRE_G3_CALLS_PER_REFILL);
    }
    expect(harness.cycles.map((cycle) => cycle.calls))
      .toEqual(Array.from({ length: 15 }, () => 15));
    expect(harness.totalCalls).toBe(15 * 15);

    // One bounded top-up wave, never two: the round that runs one spends 8
    // calls (7 admitted + 1 probe), the round that does not spends 7.
    expect([...new Set(harness.rounds.map((round) => round.calls))].sort())
      .toEqual([7, 8]);
    for (const round of harness.rounds) {
      for (const [, asks] of round.asks) {
        expect(asks.length).toBeLessThanOrEqual(2);
      }
    }
    // The top-up only ever went to the one source that was capped rather than
    // exhausted (returned exactly its share) and still had headroom.
    const toppedUp = new Set(harness.rounds.flatMap((round) =>
      [...round.asks].flatMap(([key, asks]) => asks.length > 1 ? [key] : [])));
    expect([...toppedUp]).toEqual(['waifu_im']);
  });
});
