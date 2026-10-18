import type { ImageProviderKey } from '@/features/waifu/types';

/**
 * G3 spec §4 (ACCOUNTING) — in-memory per-provider yield accounting.
 *
 * In-memory only: no table, no migration, no persistence, no telemetry egress.
 * The ledger lives for the process lifetime inside the discovery-service closure
 * and is rebuilt from scratch on cold start; a cold start simply begins with
 * uniform equal shares, which is today's behaviour.
 *
 * Deterministic by construction — no clock, no randomness, no I/O — so the same
 * sequence of {@link ProviderYieldLedger.record} calls always yields the same
 * stats. Allocation is bounded: each provider keeps a fixed
 * {@link PROVIDER_YIELD_WINDOW_ROUNDS}-slot ring buffer that is allocated once
 * and overwritten in place (Hermes-safe, no unbounded growth).
 *
 * **Read since G3c Task 3.** `discovery-service.ts` passes {@link
 * ProviderYieldLedger.stats} to each refill round's fetcher, where
 * `planProviderShares` weights slack redistribution with it. Still no
 * persistence and no egress: the window dies with the process.
 */

/** Rolling window length, per provider, in refill rounds (spec §4). */
export const PROVIDER_YIELD_WINDOW_ROUNDS = 8;

/**
 * How a provider's round ended.
 * - `ok`: the provider was asked and answered (even if it answered with zero
 *   usable posts — that is the quiet signal, not a failure).
 * - `failed`: the provider's request rejected.
 * - `cooldown`: the request was refused by the resilience governor.
 * - `skipped_capability`: the capability gate (spec §2.1) skipped the provider
 *   before any request was issued, so it consumed no share.
 */
export type ProviderRoundOutcome =
  | 'ok'
  | 'failed'
  | 'cooldown'
  | 'skipped_capability';

export type ProviderRoundRecord = {
  /** What the plan asked this provider for. */
  readonly requested: number;
  /** Raw posts the engine saw, PRE client filter. */
  readonly returned: number;
  /** Survived `matchesCandidateSettings`. */
  readonly admitted: number;
  /** Survived DB dedupe. */
  readonly inserted: number;
  readonly outcome: ProviderRoundOutcome;
};

export type ProviderYieldStat = {
  /** Rolling sum over the window. */
  readonly requested: number;
  /** Rolling sum over the window. */
  readonly admitted: number;
  /** Rolling sum over the window. */
  readonly inserted: number;
  /**
   * Length of the newest run of rounds that were `ok` and **admitted** nothing.
   * A round that admitted anything, or that did not end `ok`, ends the run —
   * HTTP-level health belongs to `provider-resilience`, not to this counter.
   *
   * **G3b drift item F1 — why `admitted`, not `inserted`.** `inserted` is
   * measured after cross-provider dedupe, the merge cap
   * (`provider-client.ts`'s `.slice`) and the post-rank truncation in
   * `discovery-service.ts`. Those three cuts fall on the registry tail by
   * construction (spec §1 S4/S6), so an `inserted`-based quiet signal reads
   * "truncated" as "quiet" and would let the balancer penalise exactly the
   * sources it exists to protect. `admitted` is counted before all of them —
   * it is the provider's own yield, uncontaminated by downstream policy.
   *
   * A round that admitted items which later all deduped away therefore does
   * **not** count as quiet. That under-counts genuinely low-value sources, and
   * that direction is the safe one: under-counting only ever grants a source
   * more slack, never less, so it cannot create the starving G3 removes.
   */
  readonly consecutiveZeroRounds: number;
  readonly lastOutcome: ProviderRoundOutcome;
};

export type ProviderYieldLedger = {
  record(key: ImageProviderKey, round: ProviderRoundRecord): void;
  /** Snapshot of the rolling window; later `record` calls do not mutate it. */
  stats(): ReadonlyMap<ImageProviderKey, ProviderYieldStat>;
  reset(): void;
};

/** Network-derived counters are untrusted; keep them out of the sums if dirty. */
function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : 0;
}

type ProviderWindow = {
  /** Fixed-length ring buffer; `null` marks a slot that was never written. */
  readonly rounds: (ProviderRoundRecord | null)[];
  /** Index the next round is written to. */
  nextIndex: number;
  /** Number of populated slots, capped at the window length. */
  size: number;
};

function createWindow(): ProviderWindow {
  return {
    rounds: new Array<ProviderRoundRecord | null>(
      PROVIDER_YIELD_WINDOW_ROUNDS,
    ).fill(null),
    nextIndex: 0,
    size: 0,
  };
}

function summarize(window: ProviderWindow): ProviderYieldStat | null {
  if (window.size === 0) return null;
  let requested = 0;
  let admitted = 0;
  let inserted = 0;
  let consecutiveZeroRounds = 0;
  let zeroRunOpen = true;
  let lastOutcome: ProviderRoundOutcome = 'ok';

  // Walk newest → oldest so the zero-round run can stop at the first round that
  // breaks it, while the sums still cover the whole window.
  for (let step = 0; step < window.size; step += 1) {
    const index =
      (window.nextIndex - 1 - step + PROVIDER_YIELD_WINDOW_ROUNDS * 2) %
      PROVIDER_YIELD_WINDOW_ROUNDS;
    const round = window.rounds[index];
    if (!round) continue;
    if (step === 0) lastOutcome = round.outcome;
    requested += round.requested;
    admitted += round.admitted;
    inserted += round.inserted;
    if (zeroRunOpen) {
      // F1: the quiet signal is `admitted`-based on purpose — see the
      // `consecutiveZeroRounds` doc comment above.
      if (round.outcome === 'ok' && round.admitted === 0) {
        consecutiveZeroRounds += 1;
      } else {
        zeroRunOpen = false;
      }
    }
  }

  return { requested, admitted, inserted, consecutiveZeroRounds, lastOutcome };
}

export function createProviderYieldLedger(): ProviderYieldLedger {
  const windows = new Map<ImageProviderKey, ProviderWindow>();

  return {
    record(key, round) {
      let window = windows.get(key);
      if (window === undefined) {
        window = createWindow();
        windows.set(key, window);
      }
      window.rounds[window.nextIndex] = {
        requested: nonNegativeInteger(round.requested),
        returned: nonNegativeInteger(round.returned),
        admitted: nonNegativeInteger(round.admitted),
        inserted: nonNegativeInteger(round.inserted),
        outcome: round.outcome,
      };
      window.nextIndex = (window.nextIndex + 1) % PROVIDER_YIELD_WINDOW_ROUNDS;
      if (window.size < PROVIDER_YIELD_WINDOW_ROUNDS) window.size += 1;
    },
    stats() {
      const snapshot = new Map<ImageProviderKey, ProviderYieldStat>();
      for (const [key, window] of windows) {
        const stat = summarize(window);
        if (stat !== null) snapshot.set(key, stat);
      }
      return snapshot;
    },
    reset() {
      windows.clear();
    },
  };
}
