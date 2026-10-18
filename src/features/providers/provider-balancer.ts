import type { ProviderAvailability } from '@/features/providers/provider-adapter';
import type { ProviderYieldStat } from '@/features/providers/provider-yield-ledger';
import type { ImageProviderKey } from '@/features/waifu/types';

/**
 * G3 spec §2.2 / §2.6 — the discovery balancer.
 *
 * Two pure functions, no state of their own:
 * - {@link planProviderShares} turns "I want N candidates from these admitted
 *   sources" into a per-source request count that no source can be squeezed
 *   out of (the floor invariant);
 * - {@link interleaveWithRunCap} turns per-source buckets back into one
 *   ordered list without letting one source monopolise a visible streak.
 *
 * Deterministic by construction: no clock, no randomness, no I/O, no ambient
 * globals — the same input always produces the same plan and the same order,
 * on Hermes as in Jest. All arithmetic is over at most 8 integers.
 *
 * **planProviderShares drives provider-client's share plan (G3c Task 2); interleaveWithRunCap orders the deck in discovery-service (G3c Task 3).** G3c Task 2 wires `planProviderShares` into
 * `provider-client.ts` and Task 3 wires `interleaveWithRunCap` into
 * `discovery-service.ts`; this module lands first so the policy diff is
 * reviewable on its own.
 */

/** Spec §2.2 step 4: every admitted provider ends with at least this share. */
export const PROVIDER_SHARE_FLOOR = 1;

/**
 * Spec §4: `consecutiveZeroRounds >= 3` on an `ok` outcome is the quiet
 * signal — a source answering HTTP 200 with nothing this filter can use.
 */
export const PROVIDER_QUIET_ROUNDS = 3;

/**
 * Spec §2.2 step 3: the redistribution weight is clamped into
 * `[PROVIDER_WEIGHT_MIN, PROVIDER_WEIGHT_MAX]` — floored so a temporarily thin
 * source is never driven toward zero, capped so a hot source cannot run away.
 */
export const PROVIDER_WEIGHT_MIN = 0.15;
export const PROVIDER_WEIGHT_MAX = 1;

/** Spec §2.1: `degraded` sources still get slack, at half weight. */
export const PROVIDER_DEGRADED_WEIGHT_FACTOR = 0.5;

/**
 * First-card streaming (spec 2026-09-16 §4) — the rolling soft quota. A source
 * whose rolling share of *inserted* deck cards, among the admitted sources with
 * ledger evidence, exceeds its fair share hands part of its base share back to
 * the pool — never below this fraction of base, never below the floor of 1.
 * Down-only and bounded: an under-represented source is never punished, a
 * dominant one keeps at least half its base share, and a nudged source is the
 * last receiver of slack in the round (or its release would flow straight
 * back) and is never handed back more than the quota-off plan would have given
 * it — so the delivered plan, not just the base share, is down-only for every
 * nudged source, and the round total is exactly the quota-off total. Fair share
 * is measured among the sources actually competing this round: a cooled or
 * quiet source is pinned at the floor either way, so it neither counts toward
 * the fair share nor sharpens the nudge on the others. So this can only nudge
 * the mix toward fairness over a few rounds — it cannot starve a source or
 * turn fairness into round-robin monotony.
 *
 * **Opt-in per call — see {@link SharePlanInput.softQuota}.** Rolling
 * `inserted` share is also how G3 measures productivity, so a source cannot be
 * "first-paint dominant" and "simply the most productive source" apart from the
 * ledger alone. Applied unconditionally the nudge therefore inverts the G3
 * contract that yield evidence moves *slack*, never the base share, and the
 * caller must say which rounds are converging from a streamed paint.
 */
export const PROVIDER_QUOTA_NUDGE_MIN = 0.5;

/**
 * `1` (no nudge) unless at least two admitted, unrestricted sources have ledger
 * evidence and something was inserted in the window; otherwise
 * `clamp(fair / share, 0.5, 1)` for a source above its fair share, where
 * fair = 1 / evidenced sources and share = its rolling `inserted` over those
 * sources' rolling `inserted`.
 *
 * Restricted (cooled / quiet) sources are left out of the measurement on both
 * sides: they are pinned at the floor this round regardless, so they are not
 * competing for share and cannot be "caught up". Counting them would only
 * lower `fair` for everyone still competing and sharpen the nudge on evidence
 * that has nothing to do with first-paint dominance — in the degenerate case
 * (two healthy sources at 0.5 each plus one cooled) it would nudge both and
 * hand the whole release straight back, a silent no-op.
 */
function quotaNudge(
  key: ImageProviderKey,
  admitted: readonly SharePlanProvider[],
  stats: ReadonlyMap<ImageProviderKey, ProviderYieldStat>,
): number {
  let total = 0;
  let mine = 0;
  let evidenced = 0;
  for (const provider of admitted) {
    const stat = stats.get(provider.key);
    if (stat === undefined || isRestricted(stat)) continue;
    evidenced += 1;
    total += stat.inserted;
    if (provider.key === key) mine = stat.inserted;
  }
  if (evidenced < 2 || total <= 0) return 1;
  const fair = 1 / evidenced;
  const share = mine / total;
  if (share <= fair) return 1;
  return clamp(fair / share, PROVIDER_QUOTA_NUDGE_MIN, 1);
}

export type SharePlanProvider = {
  readonly key: ImageProviderKey;
  /** `ProviderAdapter.maxDiscoveryBatch` — the source's declared per-round ceiling. */
  readonly cap: number;
  readonly availability: ProviderAvailability;
};

export type SharePlanInput = {
  /**
   * The sources that passed the capability gate, in registry order. An
   * `unavailable` source never reaches here (`provider-client.ts` skips it
   * before the plan is built), so it consumes no share and does not shrink
   * anyone else's — that ordering is the G3a fix this module depends on.
   * Input order is also the deterministic tie-break for apportionment.
   */
  readonly admitted: readonly SharePlanProvider[];
  readonly desiredCount: number;
  /** `ProviderYieldLedger.stats()`. An empty map is a cold start. */
  readonly stats: ReadonlyMap<ImageProviderKey, ProviderYieldStat>;
  /**
   * First-card streaming (spec 2026-09-16 §4): apply the rolling soft quota to
   * this round's base shares. **Default `false`, and that default is the
   * product contract, not a convenience.**
   *
   * Spec §5 keeps the steady-state share plan unchanged, and two shipped G3
   * release gates depend on that literally: `provider-client.test.ts`'s top-up
   * fan-out gate asserts that yield evidence "cannot move the wave-1 shares —
   * they only decide the top-up probe ORDER", and `discovery-balance.test.ts`
   * §6.3-4 asserts a cooled source's slack reaches the *productive* sources in
   * the same round. Both read exactly the rolling `inserted` share the quota
   * reads, so an always-on quota reverses them.
   *
   * Pass `true` only for the refill rounds that are converging away from a
   * streamed cold first paint (spec §3), where the caller — not the ledger —
   * knows the dominance was an artefact of who answered first. Never pass it
   * for the opportunistic top-up wave, which is deliberately yield-ranked.
   */
  readonly softQuota?: boolean;
};

export type SharePlan = ReadonlyMap<ImageProviderKey, number>;

export type InterleaveOptions = {
  /** How many items one provider may emit back-to-back. Spec §2.6 uses 2. */
  readonly maxConsecutivePerProvider: number;
  /**
   * The provider already sitting at the tail of the sequence this batch will be
   * appended to, and how many of its cards run there. Without it the bound holds
   * per batch but not across a batch boundary: the G3c Task 5 device smoke found
   * a persisted run of 3 built from a deck ending in one waifu card plus a batch
   * legitimately leading with two.
   *
   * Omit both (the default) for a standalone sequence — that path is unchanged.
   */
  readonly precededBy?: {
    readonly key: ImageProviderKey;
    readonly run: number;
  };
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Caps arrive from adapter declarations; keep a bad one from breaking the floor. */
function sanitizeCap(cap: number): number {
  if (!Number.isFinite(cap)) return PROVIDER_SHARE_FLOOR;
  const truncated = Math.trunc(cap);
  return truncated > PROVIDER_SHARE_FLOOR ? truncated : PROVIDER_SHARE_FLOOR;
}

/**
 * Spec §2.2 step 3 + §4. A source is *restricted* when the evidence says asking
 * it for a full share this round is waste — but the response is bounded and
 * non-punitive: it keeps a floor-of-1 probe request and forfeits redistribution
 * slack only. It is never disabled, never hidden, and one good round clears it.
 */
function isRestricted(stat: ProviderYieldStat | undefined): boolean {
  if (stat === undefined) return false;
  if (stat.lastOutcome === 'cooldown') return true;
  return stat.lastOutcome === 'ok' && stat.consecutiveZeroRounds >= PROVIDER_QUIET_ROUNDS;
}

/**
 * Spec §2.2 step 3: `clamp(admitted / max(1, requested), 0.15, 1)`, halved for
 * `degraded` availability.
 *
 * A source with no ledger entry — and a source the window never actually asked
 * (`requested === 0`, e.g. it was capability-skipped for the whole window and
 * has just become available again) — weighs 1. Both are "no evidence", and the
 * honest default for no evidence is today's uniform behaviour. Reading
 * `0 / max(1, 0)` as a 0.15 weight would instead punish a source for a round it
 * was never in, which is the exact failure mode this module exists to remove.
 */
function redistributionWeight(
  stat: ProviderYieldStat | undefined,
  availability: ProviderAvailability,
): number {
  const base = stat === undefined || stat.requested === 0
    ? PROVIDER_WEIGHT_MAX
    : clamp(stat.admitted / Math.max(1, stat.requested), PROVIDER_WEIGHT_MIN, PROVIDER_WEIGHT_MAX);
  return availability.state === 'degraded'
    ? base * PROVIDER_DEGRADED_WEIGHT_FACTOR
    : base;
}

type ShareSlot = {
  readonly key: ImageProviderKey;
  readonly cap: number;
  readonly weight: number;
  readonly restricted: boolean;
  /** Above its fair rolling `inserted` share — last in line for slack. */
  readonly nudged: boolean;
  /** Registry position — the deterministic tie-break for largest remainder. */
  readonly order: number;
  share: number;
};

/**
 * Spec §2.2: build the per-provider discovery request plan.
 *
 * 1. `base = max(1, ceil(desiredCount / admitted.length))`.
 * 2. `share[k] = min(base, cap[k])`; a restricted source (cooldown / quiet)
 *    takes a floor-of-1 probe instead. `slack = Σ(base − share[k])`, so a
 *    restricted source's released share joins the pool rather than evaporating
 *    — spec §1 S5 is precisely the bug where it evaporated.
 * 2b. Soft quota (only when `input.softQuota` — spec 2026-09-16 §4): a source
 *    above its fair rolling inserted share among the unrestricted evidenced
 *    sources takes round(base × nudge), nudge ∈ [0.5, 1], and drops to the
 *    back of the slack queue.
 * 3. Redistribute the slack to unrestricted sources that still have headroom,
 *    weighted by recent effective yield, largest-remainder, ties broken by
 *    registry order. Nudged sources are served last, only once every
 *    un-nudged receiver is at its cap, and never past the share the quota-off
 *    plan would have given them — so their release reaches another source when
 *    one can use it, returns to them when none can, and the quota can never
 *    leave a nudged source *above* where it would otherwise have landed
 *    (largest-remainder rounding over a bigger pool could otherwise do that).
 * 4. Floor invariant: every admitted provider ends `>= 1`.
 * 5. Restricted sources forfeit slack (they were already pinned at the floor in
 *    step 2 and are excluded from the receiver set here).
 *
 * The plan can total less than `desiredCount` — when Σcap is smaller, or when
 * every source is restricted. That is honest: the shortfall is answered by the
 * bounded top-up wave (spec §2.3), not by over-asking a source that cannot or
 * should not answer. The soft quota adds no third case: it moves share between
 * sources, and step 3's last pass hands an unusable release back rather than
 * letting it evaporate, so the round total is the same with the quota on or
 * off whenever no other source had headroom to take it.
 */
export function planProviderShares(input: SharePlanInput): SharePlan {
  const plan = new Map<ImageProviderKey, number>();
  const providers = input.admitted;
  if (providers.length === 0) return plan;

  const desired = Number.isFinite(input.desiredCount)
    ? Math.max(0, Math.trunc(input.desiredCount))
    : 0;
  // Step 1. `max(1, …)` also covers desiredCount 0 — the floor is the point.
  const base = Math.max(PROVIDER_SHARE_FLOOR, Math.ceil(desired / providers.length));

  // Step 2.
  const slots: ShareSlot[] = [];
  let slack = 0;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index] as SharePlanProvider;
    const stat = input.stats.get(provider.key);
    const cap = sanitizeCap(provider.cap);
    const restricted = isRestricted(stat);
    // Soft quota (spec 2026-09-16 §4): opt-in per call, and a restricted source
    // is already at the floor, so the nudge applies only to an unrestricted
    // base share on a round the caller marked as converging from a streamed
    // first paint.
    const nudge = restricted || input.softQuota !== true
      ? 1
      : quotaNudge(provider.key, providers, input.stats);
    const share = restricted
      ? PROVIDER_SHARE_FLOOR
      : Math.max(PROVIDER_SHARE_FLOOR, Math.min(cap, Math.round(base * nudge)));
    slack += base - share;
    slots.push({
      key: provider.key,
      cap,
      weight: redistributionWeight(stat, provider.availability),
      restricted,
      nudged: nudge < 1,
      order: index,
      share,
    });
  }

  // Step 3 + 5. Receivers are unrestricted sources with headroom. Each pass
  // apportions whatever is still unassigned; a pass that overshoots a source's
  // headroom returns the excess to the pool and retires that source, so the
  // loop runs at most once per provider (n <= 8) and always makes progress.
  const distribute = (
    receivers: readonly ShareSlot[],
    pool: number,
    ceilingOf: (slot: ShareSlot) => number = (slot) => slot.cap,
  ): number => {
    let remaining = pool;
    for (let pass = 0; pass < providers.length && remaining > 0; pass += 1) {
      const active = receivers.filter((slot) => slot.share < ceilingOf(slot));
      if (active.length === 0) break;
      let totalWeight = 0;
      for (const slot of active) totalWeight += slot.weight;
      if (totalWeight <= 0) break;

      // Largest-remainder apportionment of `remaining` across `active`.
      const quotas = active.map((slot) => (remaining * slot.weight) / totalWeight);
      const grants = quotas.map((quota) => Math.floor(quota));
      let assigned = 0;
      for (const grant of grants) assigned += grant;
      const byRemainder = active
        .map((slot, position) => ({ position, order: slot.order }))
        .sort((left, right) => {
          const leftRemainder = (quotas[left.position] as number) - (grants[left.position] as number);
          const rightRemainder = (quotas[right.position] as number) - (grants[right.position] as number);
          if (rightRemainder !== leftRemainder) return rightRemainder - leftRemainder;
          return left.order - right.order;
        });
      let leftover = remaining - assigned;
      for (const candidate of byRemainder) {
        if (leftover <= 0) break;
        grants[candidate.position] = (grants[candidate.position] as number) + 1;
        leftover -= 1;
      }

      let granted = 0;
      for (let position = 0; position < active.length; position += 1) {
        const slot = active[position] as ShareSlot;
        const give = Math.min(grants[position] as number, ceilingOf(slot) - slot.share);
        if (give <= 0) continue;
        slot.share += give;
        granted += give;
      }
      if (granted <= 0) break; // defensive: never spin without progress
      remaining -= granted;
    }
    return remaining;
  };

  // Un-nudged sources first: that is the whole point of the release — another
  // source gets the variety slot. Only what none of them can absorb (they are
  // all at their declared caps) goes back to the nudged sources, because an
  // evaporated unit is a card the user asked for and nobody could have served
  // instead. Without the second pass a 2-source round pairing a large-cap
  // source with a cap-2 booru plans 5 of the 12 cards it was asked for.
  //
  // The second pass is ceilinged at the quota-off plan: with two nudged
  // sources sharing a bigger pool, largest-remainder rounding can otherwise
  // move a unit from one nudged source to the other and leave it ABOVE where
  // the un-quota'd planner would have put it. Every un-nudged source is at cap
  // by then and the quota-off share of a nudged source is at most its cap, so
  // the ceilinged capacity still covers the quota-off total exactly: the round
  // total is unchanged and no nudged source ends higher than without the quota.
  const unrestricted = slots.filter((slot) => !slot.restricted);
  const unnudged = unrestricted.filter((slot) => !slot.nudged);
  const unabsorbed = distribute(unnudged, slack);
  if (unabsorbed > 0) {
    const quotaOff = slots.some((slot) => slot.nudged)
      ? planProviderShares({ ...input, softQuota: false })
      : null;
    distribute(unrestricted, unabsorbed, (slot) =>
      slot.nudged && quotaOff !== null
        ? Math.min(slot.cap, quotaOff.get(slot.key) ?? slot.cap)
        : slot.cap,
    );
  }

  // Step 4. Already true by construction (`base >= 1`, `cap >= 1`, and
  // redistribution only adds) — restated here so the invariant that makes
  // "no artificial starving" mechanically true is one readable line, and
  // fuzzed by the floor property test.
  for (const slot of slots) {
    plan.set(slot.key, Math.max(PROVIDER_SHARE_FLOOR, slot.share));
  }
  return plan;
}

type InterleaveLane<T> = {
  readonly key: ImageProviderKey;
  readonly items: readonly T[];
};

type SpreadEntry<T> = {
  readonly key: ImageProviderKey;
  /** Position of this item's bucket in the caller's map (registry order). */
  readonly laneOrder: number;
  /** Position of this item inside its own bucket — taste order, never changed. */
  readonly itemIndex: number;
  readonly laneSize: number;
  readonly item: T;
};

/**
 * Move `entries[to]` to index `from`, shifting `from..to-1` one slot right.
 *
 * A rotation, not a swap: the caller only ever calls this when `from..to-1` is
 * a single-provider run and `to` is the first item of a different provider, so
 * the moved item crosses nothing from its own bucket and the run's items keep
 * their mutual order. A swap would reorder the run and destroy the per-bucket
 * taste order this helper must preserve.
 */
function rotateEntryLeft<T>(entries: SpreadEntry<T>[], from: number, to: number): void {
  const moved = entries[to] as SpreadEntry<T>;
  for (let index = to; index > from; index -= 1) {
    entries[index] = entries[index - 1] as SpreadEntry<T>;
  }
  entries[from] = moved;
}

function longestProviderRun(keys: readonly ImageProviderKey[]): number {
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
 * Step 1 — proportional spread. Item `j` of a bucket holding `n` items takes
 * the ideal position `(2j + 1) / 2n` of the way through the output: the centre
 * of its `j`-th of `n` equal slices. Sorted by exact integer
 * cross-multiplication (the output length is common to both sides and cancels),
 * ties broken by bucket order then item index.
 */
function spreadProportionally<T>(lanes: readonly InterleaveLane<T>[]): SpreadEntry<T>[] {
  const entries: SpreadEntry<T>[] = [];
  for (let laneOrder = 0; laneOrder < lanes.length; laneOrder += 1) {
    const lane = lanes[laneOrder] as InterleaveLane<T>;
    for (let itemIndex = 0; itemIndex < lane.items.length; itemIndex += 1) {
      entries.push({
        key: lane.key,
        laneOrder,
        itemIndex,
        laneSize: lane.items.length,
        item: lane.items[itemIndex] as T,
      });
    }
  }
  entries.sort((left, right) => {
    const cross =
      (2 * left.itemIndex + 1) * right.laneSize -
      (2 * right.itemIndex + 1) * left.laneSize;
    if (cross !== 0) return cross;
    if (left.laneOrder !== right.laneOrder) return left.laneOrder - right.laneOrder;
    return left.itemIndex - right.itemIndex;
  });
  return entries;
}

/**
 * Step 2 — guarded run-cap correction, applied in place.
 *
 * Pulling a breaker earlier shortens the run before it and lengthens the run
 * after it, because the cards it used to separate now join. Writing `L` for the
 * over-cap run and `C` for the same provider's run immediately past the
 * breaker, the stretch goes from `max(L, C)` to `max(cap, L - cap + C)`. The
 * rotation is applied only when that is strictly smaller, so the correction can
 * never make the deck worse than the pure spread.
 *
 * The guard is not optional. An unconditional version regressed
 * `{waifu: 5, nekos: 17}` at cap 2 from a spread-only longest run of 4 to 6,
 * and `{a: 1, b: 6}` from 3 (optimal) to 4. It fires for the short-tail
 * rounding artifacts the spread leaves behind, e.g. `{a: 5, b: 2}`'s
 * `a b a a a b a` becoming `a b a a b a a`.
 *
 * There is deliberately no "search further ahead" fallback: the nearest card
 * from another provider is by definition the one that ends the run, so there is
 * no second candidate, and a run with nothing after it is the end of the deck.
 */
function applyGuardedRunCapCorrection<T>(entries: SpreadEntry<T>[], cap: number): void {
  let runKey = (entries[0] as SpreadEntry<T>).key;
  let runStart = 0;
  for (let position = 1; position < entries.length; position += 1) {
    const entry = entries[position] as SpreadEntry<T>;
    if (entry.key !== runKey) {
      runKey = entry.key;
      runStart = position;
      continue;
    }
    // Only the first card past the cap triggers a decision for this run.
    if (position - runStart !== cap) continue;

    // The breaker is structurally the card that ends the run.
    let breaker = position + 1;
    while (
      breaker < entries.length &&
      (entries[breaker] as SpreadEntry<T>).key === runKey
    ) {
      breaker += 1;
    }
    if (breaker >= entries.length) continue; // forced: nothing follows the run

    // `after` is this provider's run immediately past the breaker — the cards
    // that would join the shifted remainder if the breaker moved.
    let after = 0;
    for (
      let probe = breaker + 1;
      probe < entries.length && (entries[probe] as SpreadEntry<T>).key === runKey;
      probe += 1
    ) {
      after += 1;
    }

    const longestNow = Math.max(breaker - runStart, after);
    const longestIfRotated = Math.max(cap, breaker - position + after);
    if (longestIfRotated >= longestNow) continue; // guard: never worse

    rotateEntryLeft(entries, position, breaker);
    // `position` now holds the breaker, which starts its own run: the card
    // before it belongs to the run just interrupted, so it is a different key.
    runKey = (entries[position] as SpreadEntry<T>).key;
    runStart = position;
  }
}

/**
 * Step 3b, regime A — dominant split. Used when one bucket holds a strict
 * majority (`biggest >= rest + 1`), which is exactly when a run longer than 1
 * is unavoidable.
 *
 * The `rest` other cards can cut the dominant bucket into at most `rest + 1`
 * pieces, so the dominant bucket is split into exactly that many contiguous
 * groups and one other card is dealt into each boundary. Each group takes
 * `min(capacity, ceil(remaining / groupsLeft))`: the balanced term alone
 * reproduces near-equal groups, and `capacity` — `bound`, less the carry run for
 * group 0 — is what keeps the seam honest. `bound` is chosen so the reduced
 * total capacity still holds every dominant card, so the clamp never strands
 * one, and only group 0 can come out empty (when the carry has consumed the
 * whole budget), which puts an other card first exactly as intended.
 *
 * With no carry this is the theoretical minimum `ceil(biggest / (rest + 1))`,
 * and no two other cards are adjacent because every group is non-empty.
 *
 * The other cards are dealt index-major across their buckets (registry order),
 * which keeps the thin sources spaced rather than clumped. Their order cannot
 * affect run length, only variety.
 */
function dealDominantSplit<T>(
  lanes: readonly InterleaveLane<T>[],
  dominantIndex: number,
  bound: number,
  carryOnDominant: number,
): T[] {
  const dominant = lanes[dominantIndex] as InterleaveLane<T>;
  const others: T[] = [];
  let depth = 0;
  let dealt = true;
  while (dealt) {
    dealt = false;
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      if (laneIndex === dominantIndex) continue;
      const lane = lanes[laneIndex] as InterleaveLane<T>;
      if (depth >= lane.items.length) continue;
      others.push(lane.items[depth] as T);
      dealt = true;
    }
    depth += 1;
  }

  const segments = others.length + 1;
  const merged: T[] = [];
  let cursor = 0;
  let remaining = dominant.items.length;
  for (let group = 0; group < segments; group += 1) {
    // Group 0 is the one the carry run bleeds into, so it holds that much less.
    // `bound` was chosen so the reduced total capacity still fits `remaining`.
    const capacity = bound - (group === 0 ? carryOnDominant : 0);
    const balanced = Math.ceil(remaining / (segments - group));
    const size = Math.max(0, Math.min(capacity, balanced));
    for (let taken = 0; taken < size; taken += 1) {
      merged.push(dominant.items[cursor] as T);
      cursor += 1;
    }
    remaining -= size;
    if (group < segments - 1) merged.push(others[group] as T);
  }
  return merged;
}

/**
 * Step 3b, regime B — no strict majority. `biggest <= rest` means
 * `ceil(biggest / (rest + 1))` is 1, so the bound is just the cap and an
 * arrangement with no two adjacent cards from one provider exists (the
 * classic condition `biggest <= ceil(total / 2)` holds).
 *
 * Greedy reaches it: always take the next card of the provider with the most
 * cards left that is not the provider just emitted, ties by registry order.
 * Each bucket is consumed front to back, so taste order survives.
 */
function dealBalancedGreedy<T>(
  lanes: readonly InterleaveLane<T>[],
  total: number,
  blockedFirst: ImageProviderKey | null,
): T[] {
  const cursors = lanes.map(() => 0);
  const merged: T[] = [];
  // Greedy never repeats a provider while another lane is alive, so its leading
  // run is 1 unless it has no choice. Seeding `previous` is therefore needed
  // only when the carry has used the entire budget and even one card is too many.
  let previous: ImageProviderKey | null = blockedFirst;
  for (let emitted = 0; emitted < total; emitted += 1) {
    let pick = -1;
    let mostLeft = 0;
    let fallback = -1;
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      const lane = lanes[laneIndex] as InterleaveLane<T>;
      const left = lane.items.length - (cursors[laneIndex] as number);
      if (left <= 0) continue;
      if (fallback === -1) fallback = laneIndex;
      if (lane.key === previous) continue;
      if (left > mostLeft) {
        mostLeft = left;
        pick = laneIndex;
      }
    }
    // Only the just-emitted provider has cards left: emit it (end of deck).
    if (pick === -1) pick = fallback;
    if (pick === -1) break;
    const lane = lanes[pick] as InterleaveLane<T>;
    merged.push(lane.items[cursors[pick] as number] as T);
    cursors[pick] = (cursors[pick] as number) + 1;
    previous = lane.key;
  }
  return merged;
}

/**
 * Spec §2.6-2, **amended twice on 2026-08-31** — `85903c3` then `f4f57f0`.
 * Both amendments came out of measuring this function, and the history is kept
 * here because each one retired a design that looked right on paper.
 *
 * *Original:* index-major round-robin plus a deferral guard. Provably inert —
 * index-major already emits at most one card per lane per pass, so the guard
 * cannot fire while two buckets are alive, and once one bucket remains its own
 * "while another bucket is non-empty" qualifier switches it off. Over 5000
 * seeded shapes it changed the order zero times. The real streak was the tail:
 * `{danbooru: 9, e621: 1}` ended in eight consecutive danbooru cards, and no
 * deferral can fix a tail because nothing is left to defer to.
 *
 * *First amendment (`85903c3`):* proportional spread plus a local run-cap
 * correction. Much better, but each bucket computes its ideal positions against
 * the whole output *independently of the other buckets*, so two buckets of the
 * same size land on identical fractions and their cards cluster instead of
 * cutting the dominant bucket evenly. `{waifu: 20, e621: 2, e926: 2}` — an
 * ordinary deck once the share plan caps e621/e926 at 2 — left a run of 8 where
 * four breakers could have quartered it into runs of 4, and 16% of realistic
 * shapes at cap 2 missed the bound.
 *
 * *Second amendment (`f4f57f0`), implemented here — a hybrid:*
 *
 * 1. Spread proportionally ({@link spreadProportionally}).
 * 2. Apply the guarded run-cap correction ({@link applyGuardedRunCapCorrection}).
 * 3. If the result satisfies `longestRun <= bound`, keep it — the spread's
 *    varied, proportional pattern is the nicer deck.
 * 4. Otherwise rebuild: {@link dealDominantSplit} when one bucket holds a
 *    strict majority, {@link dealBalancedGreedy} when none does. Both reach the
 *    bound by construction, so the bound holds unconditionally.
 *
 * *Third amendment — seam awareness (G3c Task 5).* The bound above is per batch.
 * The all-sources device smoke read a persisted run of 3 off the deck: refresh
 * kept the active waifu card, deleted the rest of the queue, and the next batch
 * appended a within-cap 2-run of waifu behind it. Nothing was wrong with the
 * batch; the ordering simply could not see what it was landing behind. So
 * `precededBy` carries the destination's trailing provider and run length, step 3
 * gates on the *persisted* sequence, and the bound grows by the term the pinned
 * carry forces:
 *
 * ```
 * bound = max(cap, ceil(biggest/(rest+1)), ceil((carryCount+carryRun)/(total-carryCount+1)))
 * ```
 *
 * The carry occupies the first of the carry provider's gaps, so that provider's
 * cards have one fewer full gap to spread through. At `carryRun === 0` the new
 * term cannot exceed the second, so an absent or irrelevant carry leaves every
 * output byte-identical to the pre-seam behaviour.
 *
 * That bound is the hard acceptance invariant, fuzzed at 20k shapes per cap for
 * caps 2 and 3 with the live-bucket count drawn independently of the sizes.
 * `ceil(biggest / (rest + 1))` is the shortest streak *any* arrangement can
 * achieve, so a run above the cap now survives only where it is mathematically
 * forced — the deck is simply that taste-lean, which is honest rather than a
 * defect.
 *
 * Every path preserves each bucket's internal order exactly:
 * `rankCandidatesByTaste` decides which cards and in what order within a
 * source; this function only sets the pattern across sources. Deterministic
 * throughout — registry-order tie-breaks, no clock, no RNG.
 */
export function interleaveWithRunCap<T>(
  buckets: ReadonlyMap<ImageProviderKey, readonly T[]>,
  options: InterleaveOptions,
): T[] {
  const cap = Number.isFinite(options.maxConsecutivePerProvider)
    ? Math.max(1, Math.trunc(options.maxConsecutivePerProvider))
    : 1;

  const lanes: InterleaveLane<T>[] = [];
  let total = 0;
  let biggest = 0;
  let dominantIndex = 0;
  for (const [key, items] of buckets) {
    if (items.length === 0) continue;
    if (items.length > biggest) {
      biggest = items.length;
      dominantIndex = lanes.length;
    }
    lanes.push({ key, items });
    total += items.length;
  }
  if (lanes.length === 0) return [];

  // The carry only matters if this batch can actually extend that run.
  const carryKey = options.precededBy?.key;
  const carryLane = lanes.find((lane) => lane.key === carryKey);
  const carryRun =
    carryLane === undefined || options.precededBy === undefined
      ? 0
      : Math.max(0, Math.trunc(options.precededBy.run));
  const carryCount = carryLane?.items.length ?? 0;

  // `carryRun` cards are pinned into the first of the carry provider's
  // `total - carryCount + 1` gaps, so its cards need this much room. At
  // `carryRun === 0` the term is dominated by the plain bound (it is the same
  // expression on a smaller numerator), which is why no carry means no change.
  const seamTerm =
    carryRun === 0
      ? 0
      : Math.ceil((carryCount + carryRun) / (total - carryCount + 1));
  const bound = Math.max(
    cap,
    Math.ceil(biggest / (total - biggest + 1)),
    seamTerm,
  );

  const entries = spreadProportionally(lanes);
  applyGuardedRunCapCorrection(entries, cap);

  // Gate on the persisted sequence, not the batch: a batch that is fine alone
  // can still push the deck's trailing run over the bound.
  const carryPrefix = Array.from<unknown, ImageProviderKey>(
    { length: carryRun },
    () => carryKey as ImageProviderKey,
  );
  const spreadKeys = entries.map((entry) => entry.key);
  if (longestProviderRun([...carryPrefix, ...spreadKeys]) <= bound) {
    return entries.map((entry) => entry.item);
  }

  const carryOnDominant =
    (lanes[dominantIndex] as InterleaveLane<T>).key === carryKey ? carryRun : 0;
  return biggest >= total - biggest + 1
    ? dealDominantSplit(lanes, dominantIndex, bound, carryOnDominant)
    : dealBalancedGreedy(lanes, total, carryRun >= bound ? (carryKey ?? null) : null);
}
