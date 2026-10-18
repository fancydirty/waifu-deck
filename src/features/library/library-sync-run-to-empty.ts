import type { TransferPoolResult } from '@/features/library/library-transfer-pool';

export type SyncRoundResult = Readonly<{ up: TransferPoolResult; down: TransferPoolResult }>;
export type RunToEmptyOutcome = Readonly<{
  rounds: number;
  /** Last round listed no candidates on either side. */
  clean: boolean;
  /** Stopped by `maxRounds` with residue left. */
  capped: boolean;
  lastRound: SyncRoundResult;
}>;

/**
 * Repeat `round` until a round lists nothing (clean), makes zero progress
 * (every candidate failed — retrying now would spin on the same dead set;
 * the caller's residue timer retries later), or hits `maxRounds`.
 */
export async function runToEmpty(
  round: () => Promise<SyncRoundResult>,
  { maxRounds }: Readonly<{ maxRounds: number }>,
): Promise<RunToEmptyOutcome> {
  let rounds = 0;
  let last: SyncRoundResult = {
    up: { total: 0, done: 0, failed: 0 },
    down: { total: 0, done: 0, failed: 0 },
  };
  while (rounds < maxRounds) {
    last = await round();
    rounds += 1;
    const total = last.up.total + last.down.total;
    if (total === 0) return { rounds, clean: true, capped: false, lastRound: last };
    if (last.up.done + last.down.done === 0) {
      return { rounds, clean: false, capped: false, lastRound: last };
    }
  }
  return { rounds, clean: false, capped: true, lastRound: last };
}
