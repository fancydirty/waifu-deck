import {
  PROVIDER_QUIET_ROUNDS,
  PROVIDER_SHARE_FLOOR,
  interleaveWithRunCap,
  planProviderShares,
  type SharePlanProvider,
} from '@/features/providers/provider-balancer';
import type { ProviderAvailability } from '@/features/providers/provider-adapter';
import {
  PROVIDER_YIELD_WINDOW_ROUNDS,
  createProviderYieldLedger,
  type ProviderYieldStat,
} from '@/features/providers/provider-yield-ledger';
import type { ImageProviderKey } from '@/features/waifu/types';

const AVAILABLE: ProviderAvailability = { state: 'available' };
const DEGRADED: ProviderAvailability = {
  state: 'degraded',
  reasonKey: 'providers.safebooru.thinNsfw',
};

/** Registry order and the real declared caps (`provider-registry.ts`). */
const REGISTRY: readonly SharePlanProvider[] = [
  { key: 'waifu_im', cap: 20, availability: AVAILABLE },
  { key: 'nekos_api', cap: 8, availability: AVAILABLE },
  { key: 'danbooru', cap: 6, availability: AVAILABLE },
  { key: 'safebooru', cap: 8, availability: AVAILABLE },
  { key: 'yandere', cap: 12, availability: AVAILABLE },
  { key: 'konachan', cap: 12, availability: AVAILABLE },
  { key: 'e621', cap: 2, availability: AVAILABLE },
  { key: 'e926', cap: 2, availability: AVAILABLE },
];

const stat = (overrides: Partial<ProviderYieldStat> = {}): ProviderYieldStat => ({
  requested: 8,
  admitted: 8,
  inserted: 4,
  consecutiveZeroRounds: 0,
  lastOutcome: 'ok',
  ...overrides,
});

const provider = (
  key: ImageProviderKey,
  cap: number,
  availability: ProviderAvailability = AVAILABLE,
): SharePlanProvider => ({ key, cap, availability });

const plainPlan = (
  plan: ReadonlyMap<ImageProviderKey, number>,
): Record<string, number> => Object.fromEntries(plan);

/** mulberry32 — seeded, deterministic, no `Math.random` anywhere in the suite. */
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const intBetween = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

// --- planProviderShares -----------------------------------------------------

test('cold start plans the real registry deterministically: caps honoured, slack redistributed', () => {
  // base = ceil(30 / 8) = 4. e621/e926 are capped at 2, releasing 4 units of
  // slack; every source has weight 1 (no ledger), so the largest-remainder
  // tie-break hands the 4 leftover units out in registry order.
  const plan = planProviderShares({
    admitted: REGISTRY,
    desiredCount: 30,
    stats: new Map(),
  });

  expect(plainPlan(plan)).toEqual({
    waifu_im: 5,
    nekos_api: 5,
    danbooru: 5,
    safebooru: 5,
    yandere: 4,
    konachan: 4,
    e621: 2,
    e926: 2,
  });

  const total = [...plan.values()].reduce((sum, share) => sum + share, 0);
  const capTotal = REGISTRY.reduce((sum, entry) => sum + entry.cap, 0);
  expect(total).toBeGreaterThanOrEqual(Math.min(30, capTotal));
});

test('a capped source takes exactly its cap and never more', () => {
  const plan = planProviderShares({
    admitted: REGISTRY,
    desiredCount: 30,
    stats: new Map(),
  });

  expect(plan.get('e621')).toBe(2);
  expect(plan.get('e926')).toBe(2);
});

test('shrinking the admitted set grows the survivors (G3a capability-gate regression)', () => {
  // Konachan under portrait never reaches the plan: it consumes no share and,
  // crucially, does not sit in the denominator. Everyone else must get more.
  const withKonachan = planProviderShares({
    admitted: REGISTRY,
    desiredCount: 30,
    stats: new Map(),
  });
  const withoutKonachan = planProviderShares({
    admitted: REGISTRY.filter((entry) => entry.key !== 'konachan'),
    desiredCount: 30,
    stats: new Map(),
  });

  expect(withoutKonachan.has('konachan')).toBe(false);
  for (const entry of REGISTRY) {
    if (entry.key === 'konachan') continue;
    expect(withoutKonachan.get(entry.key) ?? 0).toBeGreaterThanOrEqual(
      withKonachan.get(entry.key) ?? 0,
    );
  }
  expect(withoutKonachan.get('yandere')).toBe(6);
  expect(withKonachan.get('yandere')).toBe(4);
});

test('slack flows toward the higher-yield source (spec §2.2 step 3 weighting)', () => {
  // base = ceil(12 / 3) = 4; `thin` is capped at 2 and releases 2 units.
  // rich weight = 8/8 = 1; poor weight = 1/8 = 0.125 -> clamped up to 0.15.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('nekos_api', 10), provider('e621', 2)],
    desiredCount: 12,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 8, admitted: 8 })],
      ['nekos_api', stat({ requested: 8, admitted: 1 })],
    ]),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 6, nekos_api: 4, e621: 2 });
});

test('the weight floor keeps a zero-yield source from spiralling below the base share', () => {
  // admitted/requested = 0 clamps to 0.15, not 0: the source still gets its
  // full base share and merely competes weakly for slack. Anti-feedback-loop.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('nekos_api', 10), provider('e621', 2)],
    desiredCount: 12,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['nekos_api', stat({ requested: 8, admitted: 0, consecutiveZeroRounds: 1 })],
    ]),
  });

  expect(plan.get('nekos_api')).toBe(4);
});

test('degraded availability halves the redistribution weight but not the base share', () => {
  // base = 4; two capped sources release 4 units; available weight 1 vs
  // degraded weight 0.5 splits them 3 / 1.
  const plan = planProviderShares({
    admitted: [
      provider('waifu_im', 10),
      provider('safebooru', 10, DEGRADED),
      provider('e621', 2),
      provider('e926', 2),
    ],
    desiredCount: 16,
    stats: new Map(),
  });

  expect(plainPlan(plan)).toEqual({
    waifu_im: 7,
    safebooru: 5,
    e621: 2,
    e926: 2,
  });
});

test('a cooling source keeps its floor-of-1 probe and forfeits slack', () => {
  const plan = planProviderShares({
    admitted: [
      provider('waifu_im', 10),
      provider('nekos_api', 10),
      provider('safebooru', 10),
      provider('danbooru', 10),
    ],
    desiredCount: 16,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['danbooru', stat({ lastOutcome: 'cooldown' })],
    ]),
  });

  // Floor of 1 — never 0, so a cooling source can always recover — and the
  // 3 units it gave up land on the healthy sources in the same round.
  expect(plan.get('danbooru')).toBe(1);
  expect(plainPlan(plan)).toEqual({
    waifu_im: 5,
    nekos_api: 5,
    safebooru: 5,
    danbooru: 1,
  });
});

test('a quiet source (3+ zero-admit ok rounds) keeps its floor and forfeits slack', () => {
  const plan = planProviderShares({
    admitted: [
      provider('waifu_im', 10),
      provider('nekos_api', 10),
      provider('safebooru', 10),
      provider('konachan', 10),
    ],
    desiredCount: 16,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['konachan', stat({ admitted: 0, consecutiveZeroRounds: 5, lastOutcome: 'ok' })],
    ]),
  });

  expect(plan.get('konachan')).toBe(1);
  expect(plainPlan(plan)).toEqual({
    waifu_im: 5,
    nekos_api: 5,
    safebooru: 5,
    konachan: 1,
  });
});

test('the quiet threshold is a boundary, not a slope: 2 zero rounds still take the full base share', () => {
  const below = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('konachan', 10)],
    desiredCount: 8,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['konachan', stat({ admitted: 0, consecutiveZeroRounds: PROVIDER_QUIET_ROUNDS - 1 })],
    ]),
  });
  const atThreshold = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('konachan', 10)],
    desiredCount: 8,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['konachan', stat({ admitted: 0, consecutiveZeroRounds: PROVIDER_QUIET_ROUNDS })],
    ]),
  });

  expect(below.get('konachan')).toBe(4);
  expect(atThreshold.get('konachan')).toBe(1);
});

test('a restricted source recovers the moment it reports a good round', () => {
  const recovered = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('konachan', 10)],
    desiredCount: 8,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['konachan', stat({ admitted: 6, consecutiveZeroRounds: 0, lastOutcome: 'ok' })],
    ]),
  });

  expect(recovered.get('konachan')).toBe(4);
});

test('a failed round is provider-resilience territory, not a share penalty', () => {
  // Spec §2.2 step 5 names `cooldown` only; HTTP health is governed elsewhere,
  // so a `failed` source keeps its base share (and competes weakly for slack).
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('nekos_api', 10)],
    desiredCount: 8,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['nekos_api', stat({ requested: 4, admitted: 0, lastOutcome: 'failed' })],
    ]),
  });

  expect(plan.get('nekos_api')).toBe(4);
});

test('a source never asked in the window weighs as a cold start, not as a failure', () => {
  // `requested === 0` (e.g. capability-skipped for the whole window and just
  // re-admitted) is "no evidence", so it competes for slack at weight 1 —
  // reading 0/max(1,0) as 0.15 would punish it for rounds it was never in.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 10), provider('konachan', 10), provider('e621', 2)],
    desiredCount: 12,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['konachan', stat({ requested: 0, admitted: 0, inserted: 0, lastOutcome: 'skipped_capability' })],
    ]),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 5, konachan: 5, e621: 2 });
});

test('slack that cannot land anywhere stops at the total cap instead of over-asking', () => {
  // base = 4, caps 5/2/2: the only headroom is waifu's single unit.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 5), provider('e621', 2), provider('e926', 2)],
    desiredCount: 12,
    stats: new Map(),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 5, e621: 2, e926: 2 });
  const total = [...plan.values()].reduce((sum, share) => sum + share, 0);
  expect(total).toBe(9);
  expect(total).toBe(Math.min(12, 9));
});

test('every admitted source gets the floor even when nothing is desired', () => {
  for (const desiredCount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = planProviderShares({
      admitted: REGISTRY,
      desiredCount,
      stats: new Map(),
    });
    expect(plan.size).toBe(REGISTRY.length);
    for (const share of plan.values()) {
      expect(share).toBeGreaterThanOrEqual(PROVIDER_SHARE_FLOOR);
    }
  }
});

test('a malformed cap cannot break the floor invariant', () => {
  const plan = planProviderShares({
    admitted: [
      provider('waifu_im', 0),
      provider('nekos_api', -5),
      provider('danbooru', Number.NaN),
    ],
    desiredCount: 30,
    stats: new Map(),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 1, nekos_api: 1, danbooru: 1 });
});

test('an empty admitted set plans nothing', () => {
  expect(planProviderShares({ admitted: [], desiredCount: 30, stats: new Map() }).size).toBe(0);
});

test('is deterministic: no clock and no randomness feed the plan', () => {
  const now = jest.spyOn(Date, 'now');
  const random = jest.spyOn(Math, 'random');
  try {
    const run = () =>
      plainPlan(
        planProviderShares({
          admitted: REGISTRY,
          desiredCount: 23,
          stats: new Map<ImageProviderKey, ProviderYieldStat>([
            ['waifu_im', stat({ requested: 9, admitted: 7 })],
            ['danbooru', stat({ lastOutcome: 'cooldown' })],
            ['yandere', stat({ requested: 12, admitted: 3 })],
          ]),
        }),
      );

    expect(run()).toEqual(run());
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
});

test('property: the floor invariant holds across an 8-source fuzz (spec §2.2 step 4)', () => {
  const random = createPrng(0x5eed_1234);
  const outcomes = ['ok', 'failed', 'cooldown', 'skipped_capability'] as const;
  const keys = REGISTRY.map((entry) => entry.key);

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const desiredCount = intBetween(random, 1, 30);
    const admitted: SharePlanProvider[] = keys.map((key) => ({
      key,
      cap: intBetween(random, 1, 20),
      availability: random() < 0.2 ? DEGRADED : AVAILABLE,
    }));
    const stats = new Map<ImageProviderKey, ProviderYieldStat>();
    for (const key of keys) {
      if (random() < 0.25) continue; // no ledger entry — cold start for this source
      const requested = intBetween(random, 0, 20);
      const admittedCount = intBetween(random, 0, requested + 5);
      stats.set(key, {
        requested,
        admitted: admittedCount,
        inserted: intBetween(random, 0, admittedCount),
        consecutiveZeroRounds: intBetween(random, 0, 6),
        lastOutcome: outcomes[intBetween(random, 0, outcomes.length - 1)] ?? 'ok',
      });
    }

    const plan = planProviderShares({ admitted, desiredCount, stats });

    expect(plan.size).toBe(admitted.length);
    let total = 0;
    for (const entry of admitted) {
      const share = plan.get(entry.key);
      expect(typeof share).toBe('number');
      const value = share as number;
      expect(Number.isInteger(value)).toBe(true);
      // The invariant: no admitted source is ever planned to zero.
      expect(value).toBeGreaterThanOrEqual(PROVIDER_SHARE_FLOOR);
      expect(value).toBeLessThanOrEqual(Math.max(PROVIDER_SHARE_FLOOR, entry.cap));
      total += value;
    }

    const capTotal = admitted.reduce(
      (sum, entry) => sum + Math.max(PROVIDER_SHARE_FLOOR, entry.cap),
      0,
    );
    expect(total).toBeLessThanOrEqual(capTotal);

    // Restricted sources deliberately hold at the floor and give their slack
    // away, so the "reaches the target" half of the property only applies when
    // no source is restricted.
    const anyRestricted = admitted.some((entry) => {
      const entryStat = stats.get(entry.key);
      if (entryStat === undefined) return false;
      return (
        entryStat.lastOutcome === 'cooldown' ||
        (entryStat.lastOutcome === 'ok' &&
          entryStat.consecutiveZeroRounds >= PROVIDER_QUIET_ROUNDS)
      );
    });
    if (!anyRestricted) {
      expect(total).toBeGreaterThanOrEqual(Math.min(desiredCount, capTotal));
    }
  }
});

// --- rolling soft quota (first-card streaming, spec 2026-09-16 §4) -----------

test('soft quota: a source that dominated recent inserts hands share back to the pool, down-only and bounded', () => {
  // base = ceil(12 / 3) = 4. waifu inserted 6 of 6 in the window → share 1.0
  // vs fair 1/3 → nudge = clamp(1/3 ÷ 1, 0.5, 1) = 0.5 → 2. The released 2
  // units go to the other two (equal yield weight), and waifu — nudged — is
  // not a receiver this round.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 30), provider('nekos_api', 30), provider('danbooru', 30)],
    desiredCount: 12,
    softQuota: true,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 6, admitted: 6, inserted: 6 })],
      ['nekos_api', stat({ requested: 6, admitted: 6, inserted: 0 })],
      ['danbooru', stat({ requested: 6, admitted: 6, inserted: 0 })],
    ]),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 2, nekos_api: 5, danbooru: 5 });
});

test('soft quota: fair share is measured over evidenced sources only; a lone evidenced source is never nudged', () => {
  const cold = planProviderShares({
    admitted: [provider('waifu_im', 30), provider('nekos_api', 30), provider('danbooru', 30)],
    desiredCount: 12,
    softQuota: true,
    stats: new Map(),
  });
  const oneEvidenced = planProviderShares({
    admitted: [provider('waifu_im', 30), provider('nekos_api', 30), provider('danbooru', 30)],
    desiredCount: 12,
    softQuota: true,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 6, admitted: 6, inserted: 6 })],
    ]),
  });

  expect(plainPlan(oneEvidenced)).toEqual(plainPlan(cold));
});

test('soft quota is inert in steady state: equal inserted shares plan exactly like no evidence', () => {
  const admitted = [provider('waifu_im', 30), provider('nekos_api', 30), provider('danbooru', 30)];
  const cold = planProviderShares({ admitted, desiredCount: 12, softQuota: true, stats: new Map() });
  const even = planProviderShares({
    admitted,
    desiredCount: 12,
    softQuota: true,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 4, admitted: 4, inserted: 4 })],
      ['nekos_api', stat({ requested: 4, admitted: 4, inserted: 4 })],
      ['danbooru', stat({ requested: 4, admitted: 4, inserted: 4 })],
    ]),
  });

  expect(plainPlan(even)).toEqual(plainPlan(cold));
});

test('soft quota never breaks the floor: a dominant source keeps at least half its base and never less than 1', () => {
  // base = ceil(2 / 2) = 1 → half of 1 rounds to 1 → floor holds.
  const tiny = planProviderShares({
    admitted: [provider('waifu_im', 30), provider('nekos_api', 30)],
    desiredCount: 2,
    softQuota: true,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 6, admitted: 6, inserted: 6 })],
      ['nekos_api', stat({ requested: 6, admitted: 6, inserted: 0 })],
    ]),
  });
  expect(tiny.get('waifu_im')).toBe(1);
  expect(tiny.get('nekos_api')).toBeGreaterThanOrEqual(1);
});

test('soft quota converges: a first-paint-dominant source returns to its fair share within the window', () => {
  // Simulate the real loop: round 0 is a streamed cold paint where waifu
  // inserted all 6 and the others 0; every later round inserts exactly what
  // it was asked for. The nudge must (a) cut waifu below base on round 1,
  // (b) never starve anyone, (c) be gone (plan == cold plan) once the window
  // shows even shares.
  const admitted = [provider('waifu_im', 30), provider('nekos_api', 30), provider('danbooru', 30)];
  const ledger = createProviderYieldLedger();
  ledger.record('waifu_im', { requested: 2, returned: 6, admitted: 6, inserted: 6, outcome: 'ok' });
  ledger.record('nekos_api', { requested: 2, returned: 0, admitted: 0, inserted: 0, outcome: 'ok' });
  ledger.record('danbooru', { requested: 2, returned: 0, admitted: 0, inserted: 0, outcome: 'ok' });
  const cold = plainPlan(planProviderShares({ admitted, desiredCount: 12, stats: new Map() }));
  const base = 4;

  const round1 = planProviderShares({
    admitted, desiredCount: 12, softQuota: true, stats: ledger.stats(),
  });
  expect(round1.get('waifu_im')).toBeLessThan(base);
  for (const share of round1.values()) expect(share).toBeGreaterThanOrEqual(1);

  let last: Record<string, number> = plainPlan(round1);
  for (let round = 1; round <= PROVIDER_YIELD_WINDOW_ROUNDS; round += 1) {
    const plan = planProviderShares({
      admitted, desiredCount: 12, softQuota: true, stats: ledger.stats(),
    });
    for (const { key } of admitted) {
      const share = plan.get(key) ?? 0;
      ledger.record(key, { requested: share, returned: share, admitted: share, inserted: share, outcome: 'ok' });
    }
    last = plainPlan(plan);
  }
  // Why this is equal to the cold plan, stated exactly (the plan-authored
  // comment here used to say "the dominant round has aged out of the window",
  // which is false and worth correcting in this of all modules): at the final
  // call the window still holds the dominant round plus rounds 1..7 — 8
  // records, the whole window. It is equal because the *nudge has gone inert*,
  // not because the evidence left: waifu's rolling inserted share has decayed
  // to 31/90 = 0.344 against a fair 0.333, so nudge = 0.968 and
  // round(4 × 0.968) = 4 = base. The observed path is
  // 2 → 3 → 4 → 4 → 4 → 4 → 4 → 4: the quota stops biting after two rounds of
  // catch-up, which is the "converge while swiping" the spec asks for.
  expect(last).toEqual(cold);
});

// --- soft quota: opt-in gate + slack preservation (fix pass, 2026-09-16) -----
//
// The nudge is driven by the ledger's rolling `inserted` share, and rolling
// inserted share is *also* how G3 rewards a productive source. Applied to every
// round it therefore inverts two shipped G3 release gates: `provider-client`'s
// "yieldStats cannot move the wave-1 shares, they only decide the top-up probe
// order" and `discovery-balance`'s §6.3-4 "the slack moves to healthy sources
// the same round". Spec 2026-09-16 §5 is explicit that steady-state refills'
// share plan is unchanged, so the quota is opt-in per call: only the rounds
// that follow a streamed cold first paint (§3/§4) ask for it.

test('soft quota is off unless the caller opts in: ledger yield alone never moves the wave-1 base shares', () => {
  // The exact stat shape of the shipped G3c gate
  // `provider-client.test.ts:1090` — six sources each asked 8, wildly different
  // inserted counts, every cap above base = ceil(24/6) = 4 so there is no
  // slack. That test's premise is that these stats "cannot move the wave-1
  // shares"; pin it here, in the balancer's own suite, so the premise is
  // owned by the module it constrains.
  const admitted = [
    provider('waifu_im', 20), provider('nekos_api', 8), provider('danbooru', 6),
    provider('safebooru', 8), provider('yandere', 12), provider('konachan', 12),
  ];
  const yieldStats = new Map<ImageProviderKey, ProviderYieldStat>([
    ['waifu_im', stat({ requested: 8, admitted: 2, inserted: 2 })],
    ['nekos_api', stat({ requested: 8, admitted: 1, inserted: 1 })],
    ['danbooru', stat({ requested: 8, admitted: 8, inserted: 8 })],
    ['safebooru', stat({ requested: 8, admitted: 4, inserted: 4 })],
    ['yandere', stat({ requested: 8, admitted: 3, inserted: 3 })],
    ['konachan', stat({ requested: 8, admitted: 8, inserted: 8 })],
  ]);

  const withEvidence = planProviderShares({ admitted, desiredCount: 24, stats: yieldStats });
  const cold = planProviderShares({ admitted, desiredCount: 24, stats: new Map() });

  expect(plainPlan(withEvidence)).toEqual(plainPlan(cold));
  expect(plainPlan(withEvidence)).toEqual({
    waifu_im: 4, nekos_api: 4, danbooru: 4, safebooru: 4, yandere: 4, konachan: 4,
  });
});

test('soft quota off by default: a cooled source\'s slack still reaches the productive source the same round (G3 §6.3-4)', () => {
  // base = ceil(12 / 3) = 4. nekos is cooling → floor of 1, releasing 3 units.
  // waifu is the productive one (9 of the window's 10 inserts) — under G3 that
  // is exactly who should absorb the release, and the soft quota must not
  // quietly reverse it on an ordinary refill.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 20), provider('nekos_api', 8), provider('danbooru', 6)],
    desiredCount: 12,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 8, admitted: 8, inserted: 9 })],
      ['nekos_api', stat({ requested: 8, admitted: 8, inserted: 0, lastOutcome: 'cooldown' })],
      ['danbooru', stat({ requested: 8, admitted: 8, inserted: 1 })],
    ]),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 6, nekos_api: 1, danbooru: 5 });
});

test('soft quota preserves the round total: a nudged source takes its own release back when nobody else has headroom', () => {
  // waifu (cap 30) dominated the window; e621 declares cap 2 (its real
  // registry cap). base = ceil(12 / 2) = 6, so e621 is pinned at 2 with no
  // headroom and is the only un-nudged receiver. Forfeiting waifu's release
  // outright would ask for 5 cards when 12 were wanted and buy no variety —
  // there is no second source that could have used the units. The nudge is a
  // preference for spreading share, not a licence to shrink the round.
  const plan = planProviderShares({
    admitted: [provider('waifu_im', 30), provider('e621', 2)],
    desiredCount: 12,
    softQuota: true,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 10, admitted: 10, inserted: 10 })],
      ['e621', stat({ requested: 2, admitted: 0, inserted: 0 })],
    ]),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 10, e621: 2 });
  let total = 0;
  for (const share of plan.values()) total += share;
  expect(total).toBe(12);
});

test('property: opting into the soft quota keeps the floor AND the round total (spec §2.2 step 4)', () => {
  // Same generator as the floor fuzz above, run with the quota on: the nudge
  // may move share between sources but must never break the floor and never
  // shrink the round below what the caps allow.
  const random = createPrng(0x5eed_1234);
  const outcomes = ['ok', 'failed', 'cooldown', 'skipped_capability'] as const;
  const keys = REGISTRY.map((entry) => entry.key);

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const desiredCount = intBetween(random, 1, 30);
    const admitted: SharePlanProvider[] = keys.map((key) => ({
      key,
      cap: intBetween(random, 1, 20),
      availability: random() < 0.2 ? DEGRADED : AVAILABLE,
    }));
    const stats = new Map<ImageProviderKey, ProviderYieldStat>();
    for (const key of keys) {
      if (random() < 0.25) continue;
      const requested = intBetween(random, 0, 20);
      const admittedCount = intBetween(random, 0, requested + 5);
      stats.set(key, {
        requested,
        admitted: admittedCount,
        inserted: intBetween(random, 0, admittedCount),
        consecutiveZeroRounds: intBetween(random, 0, 6),
        lastOutcome: outcomes[intBetween(random, 0, outcomes.length - 1)] ?? 'ok',
      });
    }

    const plan = planProviderShares({ admitted, desiredCount, stats, softQuota: true });

    let total = 0;
    const capTotal = admitted.reduce(
      (sum, entry) => sum + Math.max(PROVIDER_SHARE_FLOOR, entry.cap),
      0,
    );
    for (const entry of admitted) {
      const share = plan.get(entry.key) as number;
      expect(Number.isInteger(share)).toBe(true);
      expect(share).toBeGreaterThanOrEqual(PROVIDER_SHARE_FLOOR);
      expect(share).toBeLessThanOrEqual(Math.max(PROVIDER_SHARE_FLOOR, entry.cap));
      total += share;
    }
    const anyRestricted = admitted.some((entry) => {
      const entryStat = stats.get(entry.key);
      if (entryStat === undefined) return false;
      return (
        entryStat.lastOutcome === 'cooldown' ||
        (entryStat.lastOutcome === 'ok' &&
          entryStat.consecutiveZeroRounds >= PROVIDER_QUIET_ROUNDS)
      );
    });
    if (!anyRestricted) {
      expect(total).toBeGreaterThanOrEqual(Math.min(desiredCount, capTotal));
    }
  }
});

// --- soft quota: review fix pass 2 (2026-09-16) -----------------------------

test('soft quota measures fair share over the sources competing this round: a cooled source neither counts nor sharpens the nudge', () => {
  // base = ceil(16 / 4) = 4. danbooru is cooling → pinned at the floor, so it
  // cannot be "caught up" this round and must not lower everyone else's fair
  // share. Among the three sources actually competing waifu holds 6 of 12
  // inserts (0.5) against a fair 1/3 → nudge 2/3 → round(4 × 2/3) = 3, and the
  // 1 + 3 released units split evenly between nekos and safebooru. Counting the
  // cooled source would read fair as 1/4, sharpen waifu to 2 and hand 5 units
  // to the other two — a harsher cut than the competing evidence justifies.
  const plan = planProviderShares({
    admitted: [
      provider('waifu_im', 30), provider('nekos_api', 30),
      provider('safebooru', 30), provider('danbooru', 30),
    ],
    desiredCount: 16,
    softQuota: true,
    stats: new Map<ImageProviderKey, ProviderYieldStat>([
      ['waifu_im', stat({ requested: 6, admitted: 6, inserted: 6 })],
      ['nekos_api', stat({ requested: 6, admitted: 6, inserted: 3 })],
      ['safebooru', stat({ requested: 6, admitted: 6, inserted: 3 })],
      ['danbooru', stat({ requested: 6, admitted: 6, inserted: 0, lastOutcome: 'cooldown' })],
    ]),
  });

  expect(plainPlan(plan)).toEqual({ waifu_im: 3, nekos_api: 6, safebooru: 6, danbooru: 1 });
});

test('soft quota is down-only end to end: a nudged source never ends above the quota-off plan, even when only nudged sources can absorb the slack', () => {
  // Six cap-1 sources have no headroom, so all 18 + 4 released units can only
  // return to the two nudged sources. Their yield weights (7/19 vs 12/19) make
  // largest-remainder rounding fall differently over 22 units than over 18:
  // without a ceiling the second pass plans {danbooru 10, yandere 16} against
  // an off-quota {11, 15} — the quota would have LIFTED yandere. The second
  // pass must hand a nudged source back at most its quota-off share.
  const admitted = [
    provider('waifu_im', 1), provider('nekos_api', 1), provider('danbooru', 30),
    provider('safebooru', 1), provider('yandere', 30), provider('konachan', 1),
    provider('e621', 1), provider('e926', 1),
  ];
  const stats = new Map<ImageProviderKey, ProviderYieldStat>([
    ['waifu_im', stat({ requested: 1, admitted: 1, inserted: 0 })],
    ['nekos_api', stat({ requested: 1, admitted: 1, inserted: 0 })],
    ['danbooru', stat({ requested: 19, admitted: 7, inserted: 7 })],
    ['safebooru', stat({ requested: 1, admitted: 1, inserted: 0 })],
    ['yandere', stat({ requested: 19, admitted: 12, inserted: 12 })],
    ['konachan', stat({ requested: 1, admitted: 1, inserted: 0 })],
    ['e621', stat({ requested: 1, admitted: 1, inserted: 0 })],
    ['e926', stat({ requested: 1, admitted: 1, inserted: 0 })],
  ]);

  const off = plainPlan(planProviderShares({ admitted, desiredCount: 28, stats }));
  const on = plainPlan(planProviderShares({ admitted, desiredCount: 28, stats, softQuota: true }));

  expect(off).toEqual({
    waifu_im: 1, nekos_api: 1, danbooru: 11, safebooru: 1,
    yandere: 15, konachan: 1, e621: 1, e926: 1,
  });
  expect(on.yandere).toBeLessThanOrEqual(off.yandere as number);
  expect(on.danbooru).toBeLessThanOrEqual(off.danbooru as number);
  expect(on).toEqual(off);
});

/**
 * Test-side mirror of the module's nudge rule, so the property below can name
 * which sources the quota touched without exporting the private helper: among
 * the admitted sources that are neither cooled nor quiet and have ledger
 * evidence, a source is nudged when ≥ 2 such sources exist, something was
 * inserted, and its rolling `inserted` share exceeds `1 / evidenced`.
 */
function nudgedKeys(
  admitted: readonly SharePlanProvider[],
  stats: ReadonlyMap<ImageProviderKey, ProviderYieldStat>,
): ImageProviderKey[] {
  const competing = admitted.filter((entry) => {
    const entryStat = stats.get(entry.key);
    if (entryStat === undefined) return false;
    if (entryStat.lastOutcome === 'cooldown') return false;
    return !(entryStat.lastOutcome === 'ok' && entryStat.consecutiveZeroRounds >= PROVIDER_QUIET_ROUNDS);
  });
  let total = 0;
  for (const entry of competing) total += (stats.get(entry.key) as ProviderYieldStat).inserted;
  if (competing.length < 2 || total <= 0) return [];
  const fair = 1 / competing.length;
  return competing
    .filter((entry) => (stats.get(entry.key) as ProviderYieldStat).inserted / total > fair)
    .map((entry) => entry.key);
}

test('property: with the quota on, every nudged source plans at or below its quota-off share and the round total is unchanged', () => {
  const random = createPrng(0xd0_0d_5e_ed);
  const outcomes = ['ok', 'failed', 'cooldown', 'skipped_capability'] as const;
  const keys = REGISTRY.map((entry) => entry.key);
  let roundsWithNudge = 0;

  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const desiredCount = intBetween(random, 1, 30);
    const admitted: SharePlanProvider[] = keys.map((key) => ({
      key,
      cap: intBetween(random, 1, 20),
      availability: random() < 0.2 ? DEGRADED : AVAILABLE,
    }));
    const stats = new Map<ImageProviderKey, ProviderYieldStat>();
    for (const key of keys) {
      if (random() < 0.25) continue;
      const requested = intBetween(random, 0, 20);
      const admittedCount = intBetween(random, 0, requested + 5);
      stats.set(key, {
        requested,
        admitted: admittedCount,
        inserted: intBetween(random, 0, admittedCount),
        consecutiveZeroRounds: intBetween(random, 0, 6),
        lastOutcome: outcomes[intBetween(random, 0, outcomes.length - 1)] ?? 'ok',
      });
    }

    const off = planProviderShares({ admitted, desiredCount, stats });
    const on = planProviderShares({ admitted, desiredCount, stats, softQuota: true });
    const nudged = nudgedKeys(admitted, stats);
    if (nudged.length > 0) roundsWithNudge += 1;

    for (const key of nudged) {
      expect(on.get(key) as number).toBeLessThanOrEqual(off.get(key) as number);
    }
    let offTotal = 0;
    let onTotal = 0;
    for (const share of off.values()) offTotal += share;
    for (const share of on.values()) onTotal += share;
    expect(onTotal).toBe(offTotal);
  }
  // The generator must actually exercise the nudge, or the property is vacuous.
  expect(roundsWithNudge).toBeGreaterThan(1000);
});

// --- interleaveWithRunCap (spec §2.6, amended 85903c3 then f4f57f0) ---------

type Card = { readonly key: ImageProviderKey; readonly index: number };

const bucket = (key: ImageProviderKey, size: number): readonly Card[] =>
  Array.from({ length: size }, (_unused, index) => ({ key, index }));

const buildBuckets = (
  shape: readonly (readonly [ImageProviderKey, number])[],
): ReadonlyMap<ImageProviderKey, readonly Card[]> =>
  new Map(shape.map(([key, size]) => [key, bucket(key, size)]));

const labels = (cards: readonly Card[]): string[] =>
  cards.map((card) => `${card.key}${card.index}`);

const positionsOf = (order: readonly Card[], key: ImageProviderKey): number[] =>
  order.reduce<number[]>((found, card, index) => {
    if (card.key === key) found.push(index);
    return found;
  }, []);

const cardCount = (buckets: ReadonlyMap<ImageProviderKey, readonly Card[]>): number =>
  [...buckets.values()].reduce((sum, items) => sum + items.length, 0);

/** Longest streak of one provider anywhere in the output. */
function longestRun(order: readonly Card[]): number {
  let longest = 0;
  let current = 0;
  let previous: ImageProviderKey | null = null;
  for (const card of order) {
    current = card.key === previous ? current + 1 : 1;
    previous = card.key;
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Step 1 in isolation. A cap above the total card count can never be reached by
 * any run, so neither the guarded correction nor the hybrid rebuild triggers and
 * the output is the pure proportional spread — the baseline the finished
 * interleave must beat or match.
 */
function spreadOnly(
  buckets: ReadonlyMap<ImageProviderKey, readonly Card[]>,
): Card[] {
  return interleaveWithRunCap(buckets, {
    maxConsecutivePerProvider: cardCount(buckets) + 1,
  });
}

/**
 * The shortest streak any arrangement of this multiset can achieve: the other
 * buckets' `rest` cards split the biggest bucket into at most `rest + 1`
 * segments, so its best case is `ceil(biggest / (rest + 1))`.
 */
function optimalRun(
  buckets: ReadonlyMap<ImageProviderKey, readonly Card[]>,
): number {
  const sizes = [...buckets.values()].map((items) => items.length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total === 0) return 0;
  const biggest = Math.max(...sizes);
  return Math.ceil(biggest / (total - biggest + 1));
}

/** The hard acceptance invariant of the second §2.6 amendment (`f4f57f0`). */
const forcedMinimumBound = (
  buckets: ReadonlyMap<ImageProviderKey, readonly Card[]>,
  cap: number,
): number => Math.max(cap, optimalRun(buckets));

/**
 * Live-bucket count drawn independently of the sizes, so 2- and 3-source decks
 * (an ordinary state: the user enabled two sources, or a cooldown/capability
 * round left two admitted) are sampled as often as 8-source ones. Half the
 * shapes are high-skew — one bucket far larger than the rest — which is where a
 * spread-only interleave is weakest and the rebuild has to take over.
 */
function randomShape(
  random: () => number,
  keys: readonly ImageProviderKey[],
): [ImageProviderKey, number][] {
  const live = intBetween(random, 2, keys.length);
  const skewed = random() < 0.5;
  const dominant = intBetween(random, 0, live - 1);
  const shape: [ImageProviderKey, number][] = [];
  for (let index = 0; index < live; index += 1) {
    const size = skewed && index === dominant
      ? intBetween(random, 10, 40)
      : intBetween(random, 1, 6);
    shape.push([keys[index] as ImageProviderKey, size]);
  }
  return shape;
}

test('spreads a lone card into the middle instead of pooling the big bucket at the tail', () => {
  // The pre-amendment index-major merge produced danbooru x2, e621, then EIGHT
  // consecutive danbooru. One breaker can split 9 cards into 2 segments, so the
  // best achievable streak is ceil(9 / 2) = 5 — and the spread hits it exactly,
  // so the hybrid keeps the spread's output untouched.
  const buckets = buildBuckets([['danbooru', 9], ['e621', 1]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(labels(order)).toEqual([
    'danbooru0',
    'danbooru1',
    'danbooru2',
    'danbooru3',
    'danbooru4',
    'e6210',
    'danbooru5',
    'danbooru6',
    'danbooru7',
    'danbooru8',
  ]);
  expect(positionsOf(order, 'e621')).toEqual([5]);
  expect(longestRun(order)).toBe(5);
  expect(longestRun(order)).toBe(optimalRun(buckets));
});

test('spreads a 3-card bucket evenly through a 9-card lean, leaving only the forced run', () => {
  // 9 > 2 x (3 + 1), so one 3-run is unavoidable. The spread alone leaves two of
  // them (2/3/3/1); the guarded correction pulls the last nekos card one slot
  // earlier to make it 2/3/2/2 — a strict local improvement, which is the only
  // kind it is allowed to make. The bound is met, so no rebuild.
  const buckets = buildBuckets([['waifu_im', 9], ['nekos_api', 3]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(labels(order)).toEqual([
    'waifu_im0',
    'waifu_im1',
    'nekos_api0',
    'waifu_im2',
    'waifu_im3',
    'waifu_im4',
    'nekos_api1',
    'waifu_im5',
    'waifu_im6',
    'nekos_api2',
    'waifu_im7',
    'waifu_im8',
  ]);
  expect(positionsOf(order, 'nekos_api')).toEqual([2, 6, 9]);
  expect(positionsOf(spreadOnly(buckets), 'nekos_api')).toEqual([2, 6, 10]);
  expect(longestRun(order)).toBe(3);
  expect(optimalRun(buckets)).toBe(3);
});

test('the guarded correction fires where it strictly helps and reaches the optimum', () => {
  // The spread leaves `w n w w w n w` — a 3-run with only a single card past the
  // breaker. Rotating that breaker back gives `w n w w n w w`, capped and
  // optimal. This is the shape the guard is *for*.
  const buckets = buildBuckets([['waifu_im', 5], ['nekos_api', 2]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(longestRun(spreadOnly(buckets))).toBe(3);
  expect(labels(order)).toEqual([
    'waifu_im0',
    'nekos_api0',
    'waifu_im1',
    'waifu_im2',
    'nekos_api1',
    'waifu_im3',
    'waifu_im4',
  ]);
  expect(longestRun(order)).toBe(2);
  expect(optimalRun(buckets)).toBe(2);
});

test('the guard refuses rotations that would lengthen the deck (regression: unguarded correction)', () => {
  // {1,6} was made *worse* by the unguarded correction that shipped in b193924
  // — 3 (optimal) became 4 — because pulling a breaker earlier merges the cards
  // it used to separate. The spread already meets the bound here, so the guard
  // is what keeps it: no rebuild is available to paper over the regression.
  const buckets = buildBuckets([['waifu_im', 1], ['nekos_api', 6]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(longestRun(spreadOnly(buckets))).toBe(3);
  expect(longestRun(order)).toBe(3);
  expect(optimalRun(buckets)).toBe(3);
  expect(labels(order)).toEqual([
    'nekos_api0',
    'nekos_api1',
    'nekos_api2',
    'waifu_im0',
    'nekos_api3',
    'nekos_api4',
    'nekos_api5',
  ]);
});

test('rebuilds by dominant split when the spread clusters same-size breaker buckets', () => {
  // The headline case for the second amendment. Once the share plan caps
  // e621/e926 at 2, both compute the same ideal fractions and their cards
  // cluster, so the spread leaves a run of 10. The four breakers can quarter 20
  // waifu cards into runs of 4, and the dominant-split rebuild does exactly
  // that — 5 contiguous groups with one breaker at each boundary.
  const buckets = buildBuckets([['waifu_im', 20], ['e621', 2], ['e926', 2]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(longestRun(spreadOnly(buckets))).toBe(10);
  expect(longestRun(order)).toBe(4);
  expect(optimalRun(buckets)).toBe(4);
  expect(order.map((card) => card.key)).toEqual([
    'waifu_im', 'waifu_im', 'waifu_im', 'waifu_im', 'e621',
    'waifu_im', 'waifu_im', 'waifu_im', 'waifu_im', 'e926',
    'waifu_im', 'waifu_im', 'waifu_im', 'waifu_im', 'e621',
    'waifu_im', 'waifu_im', 'waifu_im', 'waifu_im', 'e926',
    'waifu_im', 'waifu_im', 'waifu_im', 'waifu_im',
  ]);
  // The two thin sources alternate rather than clumping, and every bucket keeps
  // its taste order.
  expect(positionsOf(order, 'e621')).toEqual([4, 14]);
  expect(positionsOf(order, 'e926')).toEqual([9, 19]);
  for (const [key, items] of buckets) {
    expect(order.filter((card) => card.key === key)).toEqual(items);
  }
});

test('the dominant-split rebuild also fixes a heavy lean the correction could not', () => {
  // {5,17}: the spread leaves 4 and the guarded correction (correctly) declines
  // to touch it, because no single rotation helps. ceil(17 / 6) = 3 is
  // achievable, and the rebuild reaches it — 6 groups of 3/3/3/3/3/2 with one
  // waifu card at each of the 5 boundaries.
  const buckets = buildBuckets([['waifu_im', 5], ['nekos_api', 17]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(longestRun(spreadOnly(buckets))).toBe(4);
  expect(longestRun(order)).toBe(3);
  expect(optimalRun(buckets)).toBe(3);
  expect(positionsOf(order, 'waifu_im')).toEqual([3, 7, 11, 15, 19]);
  expect(order).toHaveLength(22);
  for (const [key, items] of buckets) {
    expect(order.filter((card) => card.key === key)).toEqual(items);
  }
});

test('rebuilds by balanced greedy when no bucket holds a strict majority', () => {
  // The other rebuild branch. 20 of 43 cards is not a majority, so
  // ceil(20 / 24) = 1 and the bound is just the cap — but the spread still
  // clusters badly enough to miss it, and dominant-split does not apply because
  // there is no dominant bucket to split.
  const buckets = buildBuckets([
    ['waifu_im', 6],
    ['nekos_api', 6],
    ['danbooru', 5],
    ['safebooru', 1],
    ['yandere', 5],
    ['konachan', 20],
  ]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(optimalRun(buckets)).toBe(1);
  expect(longestRun(spreadOnly(buckets))).toBeGreaterThan(2);
  expect(longestRun(order)).toBeLessThanOrEqual(forcedMinimumBound(buckets, 2));
  expect(order).toHaveLength(43);
  for (const [key, items] of buckets) {
    expect(order.filter((card) => card.key === key)).toEqual(items);
  }
});

test('a realistic asymmetric 8-source deck comes out with no streak at all', () => {
  const buckets = buildBuckets([
    ['waifu_im', 5],
    ['nekos_api', 5],
    ['danbooru', 5],
    ['safebooru', 4],
    ['yandere', 3],
    ['konachan', 0],
    ['e621', 2],
    ['e926', 2],
  ]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(order).toHaveLength(26);
  expect(longestRun(order)).toBe(1);
  // The two thin sources are not stranded at the end: each appears once in the
  // first third and once in the last third.
  expect(positionsOf(order, 'e621')).toEqual([5, 19]);
  expect(positionsOf(order, 'e926')).toEqual([6, 20]);
  expect(order.slice(0, 7).map((card) => card.key)).toEqual([
    'waifu_im',
    'nekos_api',
    'danbooru',
    'safebooru',
    'yandere',
    'e621',
    'e926',
  ]);
});

test('keeps every card and every bucket internal order (taste order is never reshuffled)', () => {
  const buckets = buildBuckets([['waifu_im', 7], ['danbooru', 4], ['e621', 2]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(labels(order)).toEqual([
    'waifu_im0',
    'danbooru0',
    'waifu_im1',
    'e6210',
    'waifu_im2',
    'danbooru1',
    'waifu_im3',
    'danbooru2',
    'waifu_im4',
    'e6211',
    'waifu_im5',
    'danbooru3',
    'waifu_im6',
  ]);
  for (const [key, items] of buckets) {
    // The correction rotates rather than swaps, and both rebuild paths consume
    // each bucket front to back, precisely so this holds on every path.
    expect(order.filter((card) => card.key === key)).toEqual(items);
  }
});

test('skips empty buckets and returns nothing for an empty map', () => {
  const buckets = buildBuckets([['waifu_im', 0], ['e621', 2], ['e926', 0]]);

  expect(labels(interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 }))).toEqual([
    'e6210',
    'e6211',
  ]);
  expect(
    interleaveWithRunCap(new Map<ImageProviderKey, readonly Card[]>(), {
      maxConsecutivePerProvider: 2,
    }),
  ).toEqual([]);
});

test('a single bucket is emitted whole (its run is forced, nothing can break it)', () => {
  const buckets = buildBuckets([['waifu_im', 5]]);
  const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  expect(labels(order)).toEqual([
    'waifu_im0',
    'waifu_im1',
    'waifu_im2',
    'waifu_im3',
    'waifu_im4',
  ]);
  expect(longestRun(order)).toBe(optimalRun(buckets));
});

test('a nonsensical cap is clamped to 1 instead of stalling the merge', () => {
  const buckets = buildBuckets([['waifu_im', 3], ['e621', 2]]);

  for (const maxConsecutivePerProvider of [0, -3, Number.NaN]) {
    const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider });
    expect(labels(order)).toEqual([
      'waifu_im0',
      'e6210',
      'waifu_im1',
      'e6211',
      'waifu_im2',
    ]);
  }
});

test('is deterministic: identical input yields an identical order, with no clock or randomness', () => {
  const now = jest.spyOn(Date, 'now');
  const random = jest.spyOn(Math, 'random');
  try {
    const buckets = buildBuckets([
      ['waifu_im', 6],
      ['danbooru', 3],
      ['yandere', 4],
      ['e621', 1],
    ]);
    const first = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

    expect(labels(first)).toEqual([
      'waifu_im0',
      'yandere0',
      'danbooru0',
      'waifu_im1',
      'yandere1',
      'waifu_im2',
      'danbooru1',
      'e6210',
      'waifu_im3',
      'yandere2',
      'waifu_im4',
      'danbooru2',
      'yandere3',
      'waifu_im5',
    ]);
    expect(labels(first)).toEqual(
      labels(interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 })),
    );
    // The rebuild paths are deterministic too, not just the kept path.
    const rebuilt = buildBuckets([['waifu_im', 20], ['e621', 2], ['e926', 2]]);
    expect(labels(interleaveWithRunCap(rebuilt, { maxConsecutivePerProvider: 2 }))).toEqual(
      labels(interleaveWithRunCap(rebuilt, { maxConsecutivePerProvider: 2 })),
    );
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
});

test('property: a streak never exceeds the cap unless it is mathematically forced', () => {
  // The hard acceptance invariant of the second §2.6 amendment (`f4f57f0`):
  // `longestRun <= max(cap, ceil(biggest / (rest + 1)))`. The right-hand side is
  // the shortest streak *any* arrangement of the multiset could achieve, so this
  // says the deck is never more monotonous than the cards themselves force.
  //
  // 20k shapes per cap at caps 2 and 3, live-bucket count drawn independently of
  // the sizes, half of them high-skew. Zero violations.
  const keys = REGISTRY.map((entry) => entry.key);

  for (const cap of [2, 3]) {
    const random = createPrng(0x00c0_ffee ^ cap);
    for (let iteration = 0; iteration < 20000; iteration += 1) {
      const shape = randomShape(random, keys);
      const buckets = buildBuckets(shape);
      const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: cap });

      expect(longestRun(order)).toBeLessThanOrEqual(forcedMinimumBound(buckets, cap));
      // Whichever path ran, it is never worse than the pure spread...
      expect(longestRun(order)).toBeLessThanOrEqual(longestRun(spreadOnly(buckets)));
      // ...and never drops, duplicates, or reorders a card.
      expect(order).toHaveLength(cardCount(buckets));
      for (const [key, items] of buckets) {
        expect(order.filter((card) => card.key === key)).toEqual(items);
      }
    }
  }
});

test('property: the bound holds on realistic decks, where it is a product promise', () => {
  // Production merges at most `max(20, desiredCount)` cards and per-provider
  // caps run 2..20, so this samples decks the app can actually build. Under the
  // first amendment 16.0% of these missed the bound at cap 2 and 7.3% at cap 3;
  // the hybrid closes it completely.
  const keys = REGISTRY.map((entry) => entry.key);
  const declaredCaps: Record<ImageProviderKey, number> = {
    waifu_im: 20,
    nekos_api: 8,
    danbooru: 6,
    safebooru: 8,
    yandere: 12,
    konachan: 12,
    e621: 2,
    e926: 2,
    gelbooru: 8,
    rule34: 8,
  };

  for (const cap of [2, 3]) {
    const random = createPrng(0x000f_ace0 ^ cap);
    let sampled = 0;
    for (let iteration = 0; iteration < 20000; iteration += 1) {
      const live = intBetween(random, 2, keys.length);
      const shape: [ImageProviderKey, number][] = [];
      for (let index = 0; index < live; index += 1) {
        const key = keys[index] as ImageProviderKey;
        shape.push([key, intBetween(random, 1, declaredCaps[key])]);
      }
      if (shape.reduce((sum, size) => sum + size[1], 0) > 30) continue;
      sampled += 1;
      const buckets = buildBuckets(shape);
      const order = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: cap });
      expect(longestRun(order)).toBeLessThanOrEqual(forcedMinimumBound(buckets, cap));
    }
    expect(sampled).toBeGreaterThan(10000);
  }
});

// --- seam awareness across a batch boundary (G3c Task 5) --------------------

/**
 * The bound once a carry run is pinned in front of the batch. The carry sits in
 * the first of its provider's `total - carryCount + 1` gaps, so that provider
 * needs `ceil((carryCount + carryRun) / gaps)` room. A carry the batch cannot
 * extend (provider absent, or run 0) leaves the plain bound untouched.
 */
const seamBound = (
  buckets: ReadonlyMap<ImageProviderKey, readonly Card[]>,
  cap: number,
  carryKey: ImageProviderKey,
  carryRun: number,
): number => {
  const carryCount = buckets.get(carryKey)?.length ?? 0;
  if (carryCount === 0 || carryRun === 0) return forcedMinimumBound(buckets, cap);
  const total = cardCount(buckets);
  return Math.max(
    forcedMinimumBound(buckets, cap),
    Math.ceil((carryCount + carryRun) / (total - carryCount + 1)),
  );
};

/** The sequence the deck actually persists: carry run, then the batch. */
const persistedKeys = (
  order: readonly Card[],
  carryKey: ImageProviderKey,
  carryRun: number,
): ImageProviderKey[] => [
  ...Array.from({ length: carryRun }, () => carryKey),
  ...order.map((card) => card.key),
];

const runOfKeys = (keys: readonly ImageProviderKey[]): number =>
  longestRun(keys.map((key, index) => ({ key, index })));

test('device repro: a waifu-dominant batch behind one waifu card stays within run 2', () => {
  // The exact survivor shape read off the device DB in the Task 5 smoke. Refresh
  // kept the active waifu card and deleted the rest of the queue, so this batch
  // landed behind a single waifu card and produced rows `W W W`.
  const buckets = buildBuckets([
    ['waifu_im', 15],
    ['nekos_api', 1],
    ['danbooru', 3],
    ['safebooru', 2],
    ['yandere', 4],
    ['e621', 2],
    ['e926', 2],
  ]);

  // 15 waifu cards among 15 gaps, one of which the carry already holds:
  // ceil(16 / 15) = 2. The seam does not inflate the promise here — it is still
  // the spec §6.5 bound of 2, which is why the smoke failure was a real defect.
  expect(seamBound(buckets, 2, 'waifu_im', 1)).toBe(2);

  const order = interleaveWithRunCap(buckets, {
    maxConsecutivePerProvider: 2,
    precededBy: { key: 'waifu_im', run: 1 },
  });

  expect(runOfKeys(persistedKeys(order, 'waifu_im', 1))).toBeLessThanOrEqual(2);
  // Budget is `bound - carryRun` = 1, so leading with one waifu card is legal;
  // what must not happen is the two-run that made the persisted run 3.
  expect(order.slice(0, 2).every((card) => card.key === 'waifu_im')).toBe(false);

  expect(order).toHaveLength(cardCount(buckets));
  for (const [key, items] of buckets) {
    expect(order.filter((card) => card.key === key)).toEqual(items);
  }
});

test('a carry the batch cannot lengthen leaves the order byte-identical', () => {
  const buckets = buildBuckets([['waifu_im', 20], ['e621', 2], ['e926', 2]]);
  const plain = interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 });

  // Provider absent from this batch: nothing here can extend that run.
  expect(
    labels(
      interleaveWithRunCap(buckets, {
        maxConsecutivePerProvider: 2,
        precededBy: { key: 'konachan', run: 2 },
      }),
    ),
  ).toEqual(labels(plain));

  // Run 0 — an empty deck, the cold-start path.
  expect(
    labels(
      interleaveWithRunCap(buckets, {
        maxConsecutivePerProvider: 2,
        precededBy: { key: 'waifu_im', run: 0 },
      }),
    ),
  ).toEqual(labels(plain));

  // Omitted entirely: the standalone contract every other caller relies on.
  expect(
    labels(interleaveWithRunCap(buckets, { maxConsecutivePerProvider: 2 })),
  ).toEqual(labels(plain));
});

test('a carry that exhausts the budget yields to the forced bound, honestly', () => {
  // 10 waifu cards behind a 2-run of waifu. The 4 other cards open 5 gaps and
  // the carry holds one, so 12 waifu cards cannot do better than ceil(12/5) = 3.
  // The bound rises to 3 because the arrangement is forced, not because the
  // implementation gave up: no ordering of this multiset behind that carry keeps
  // it at 2.
  const buckets = buildBuckets([
    ['waifu_im', 10],
    ['nekos_api', 2],
    ['danbooru', 2],
  ]);
  expect(seamBound(buckets, 2, 'waifu_im', 2)).toBe(3);

  const order = interleaveWithRunCap(buckets, {
    maxConsecutivePerProvider: 2,
    precededBy: { key: 'waifu_im', run: 2 },
  });

  expect(runOfKeys(persistedKeys(order, 'waifu_im', 2))).toBeLessThanOrEqual(3);
  expect(order).toHaveLength(cardCount(buckets));
  for (const [key, items] of buckets) {
    expect(order.filter((card) => card.key === key)).toEqual(items);
  }
});

test('property: the persisted run honours the seam bound across 20k+ shapes per cap', () => {
  const keys = REGISTRY.map((entry) => entry.key);

  for (const cap of [2, 3]) {
    const random = createPrng(0x5ea0_0000 ^ cap);
    let sampled = 0;
    for (let iteration = 0; iteration < 40000; iteration += 1) {
      const shape = randomShape(random, keys);
      const buckets = buildBuckets(shape);
      const total = cardCount(buckets);
      if (total === 0 || total > 30) continue;

      // Carry from the batch's own providers most of the time, and occasionally
      // one that is absent, which must be inert.
      const live = [...buckets.keys()];
      const carryKey = (random() < 0.85
        ? live[intBetween(random, 0, live.length - 1)]
        : keys[intBetween(random, 0, keys.length - 1)]) as ImageProviderKey;
      const carryRun = intBetween(random, 0, cap);

      const order = interleaveWithRunCap(buckets, {
        maxConsecutivePerProvider: cap,
        precededBy: { key: carryKey, run: carryRun },
      });

      // The invariant the seam exists to protect: measured on the deck the user
      // scrolls, carry included.
      expect(runOfKeys(persistedKeys(order, carryKey, carryRun))).toBeLessThanOrEqual(
        seamBound(buckets, cap, carryKey, carryRun),
      );

      // Taste order within each source, and the multiset, survive every path.
      expect(order).toHaveLength(total);
      for (const [key, items] of buckets) {
        expect(order.filter((card) => card.key === key)).toEqual(items);
      }

      sampled += 1;
    }
    expect(sampled).toBeGreaterThan(20000);
  }
});

// Spec §6.5 Hermes guard (per the hermes-node-globals-gap lesson: Jest runs on
// Node, which HAS Buffer, so Jest-green says nothing about the device runtime).
// The balancer is pure arithmetic and must stay that way — pin it by running
// both entry points with the Node global removed, exactly as base64.test.ts
// pins its device contract.
test('plans and interleaves with the Buffer global removed (device-runtime contract)', () => {
  const saved = (globalThis as { Buffer?: unknown }).Buffer;
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();

    const plan = planProviderShares({
      admitted: REGISTRY,
      desiredCount: 30,
      stats: new Map(),
    });
    // Floor invariant and coverage, not the exact split — the cold-start plan
    // is pinned exactly elsewhere; here only "it computes on Hermes" matters.
    expect(plan.size).toBe(REGISTRY.length);
    for (const share of plan.values()) expect(share).toBeGreaterThanOrEqual(1);
    expect([...plan.values()].reduce((sum, share) => sum + share, 0))
      .toBeGreaterThanOrEqual(30);

    const order = interleaveWithRunCap(
      buildBuckets([['waifu_im', 9], ['danbooru', 3]]),
      { maxConsecutivePerProvider: 2 },
    );
    expect(order).toHaveLength(12);
    expect(longestRun(order)).toBeLessThanOrEqual(3);
  } finally {
    (globalThis as { Buffer?: unknown }).Buffer = saved;
  }
});
