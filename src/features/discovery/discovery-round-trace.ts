import type { DiscoveryProviderRound } from '@/features/providers/provider-adapter';
import type { ImageProviderKey } from '@/features/waifu/types';

/**
 * Dev-only per-refill round trace (spec §7 allows the ledger to be
 * "dev-visible"; this is that visibility). The §6.5 device gate reads the
 * persisted deck, which can say a source contributed nothing but never WHY —
 * never asked, asked and failed, honestly empty, or fetched and then
 * identity-suppressed all look identical in SQLite. Two gate diagnoses stalled
 * on exactly that blindness: the waifu-share attribution and a landscape run
 * where konachan stayed "Not connected yet" with all sources enabled.
 *
 * Off by default so the Jest suites that drive refills stay silent; the app
 * root flips it on under `__DEV__` only. Release builds never enable it and
 * nothing here writes anywhere but the console — no telemetry, no counters
 * shipped to users (spec §7).
 */
export const discoveryRoundTrace = { enabled: false };

export function traceProviderRounds(
  rounds: readonly DiscoveryProviderRound[] | undefined,
  insertedByProvider: Partial<Record<ImageProviderKey, number>>,
): void {
  if (!discoveryRoundTrace.enabled || rounds === undefined || rounds.length === 0) {
    return;
  }
  const parts = rounds.map((round) => {
    // The reason is what makes a zero actionable: 500 points at the anonymous
    // tag cap, 429/503 at throttling, invalid_response at a body the parser
    // rejected (e.g. an interstitial HTML challenge instead of JSON), timeout at
    // the request deadline. Without it every one of those reads as a bare zero.
    const reason = round.failureCode === undefined
      ? ''
      : ` (${round.failureCode}${round.failureStatus === undefined ? '' : ` ${round.failureStatus}`})`;
    return `${round.providerKey} req=${round.requested} ret=${round.returned} ` +
      `adm=${round.admitted} ins=${insertedByProvider[round.providerKey] ?? 0} ` +
      `${round.outcome}${reason}`;
  });
  // One logcat line per refill round, greppable as [discovery:rounds].
  console.debug(`[discovery:rounds] ${parts.join(' | ')}`);
}
