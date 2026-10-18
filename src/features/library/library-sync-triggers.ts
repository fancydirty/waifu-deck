import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import {
  acquireLibrarySyncLease,
  onLibrarySyncLeaseReleased,
} from '@/features/library/library-background-sync-slot';
import {
  runToEmpty,
  type RunToEmptyOutcome,
  type SyncRoundResult,
} from '@/features/library/library-sync-run-to-empty';

/**
 * No minimum gap between event-driven cycles (spec G2 "立刻"). Uploads to a
 * user's own single-tenant bucket are not something to throttle — the in-flight
 * flag and the "stop when a round finds no candidates" guard prevent a busy
 * loop, not a time window. Kept as an exported, injectable constant so a test
 * or a future policy can still set a floor without touching call sites.
 */
export const LIBRARY_SYNC_MIN_INTERVAL_MS = 0;

export type LibrarySyncTrigger = Readonly<{
  /** Call on every app-state change. Only `active` may start a cycle. */
  onAppStateChange(state: string): void;
  /**
   * The device's connectivity returned (false -> true). The trigger comment
   * already named this a real retry event; before, only the removed residue
   * timer covered it, so an idle foreground app after a network blip never
   * re-drove sync. Same coalescing as every other event.
   */
  onNetworkReturn(): void;
  /** K4: one asset finished ingest. Coalesces into any in-flight round. */
  onLibraryChanged(): void;
  /**
   * K4: bucket bound / device unlocked. Coalesces into any in-flight round.
   * K6-1d: also the moment the transport's connection is pre-warmed.
   */
  onSessionReady(): void;
  /** K4: subscribe to each runToEmpty outcome. Returns an unsubscribe function. */
  onRoundComplete(cb: (outcome: RunToEmptyOutcome) => void): () => void;
  dispose(): void;
}>;

const EMPTY_ROUND = {
  up: { total: 0, done: 0, failed: 0 },
  down: { total: 0, done: 0, failed: 0 },
} as const;

export function createLibrarySyncTrigger({
  sync,
  afterCycle,
  round,
  maxRounds = 20,
  minIntervalMs = LIBRARY_SYNC_MIN_INTERVAL_MS,
  clock = Date.now,
  acquireLease = acquireLibrarySyncLease,
  onLeaseReleased = onLibrarySyncLeaseReleased,
  prewarm,
}: Readonly<{
  sync: LibrarySyncController;
  /**
   * Optional work to run once, right after each sync cycle, inside the SAME
   * in-flight window (mirror C2a: the automatic cloud-only download pass). One
   * trigger therefore drives one sync plus one afterCycle, never a second
   * concurrent cycle. Its rejection is swallowed like the sync's and still
   * clears the in-flight flag, so a failed download never blocks the next
   * trigger. Absent by default, keeping the local-only composition unchanged.
   *
   * Mutually exclusive with `round`: when `round` is supplied it drives the
   * K4 run-to-empty loop instead, and `afterCycle` is ignored.
   */
  afterCycle?: () => Promise<unknown>;
  /**
   * K4: when supplied, a cycle is `sync.sync()` followed by
   * `runToEmpty(round, { maxRounds })` instead of the plain `afterCycle` path.
   */
  round?: () => Promise<SyncRoundResult>;
  maxRounds?: number;
  minIntervalMs?: number;
  clock?: () => number;
  /** #6: process-wide lease shared with the background executor. Injectable for tests. */
  acquireLease?: () => (() => void) | null;
  /**
   * K7 ①: register to be run once when the lease holder releases. Replaces the
   * `setTimeout(0)` poll a lease-blocked start used to arm.
   */
  onLeaseReleased?: (onRelease: () => void) => () => void;
  /**
   * K6-1d: open a connection to the bucket as soon as a session exists, so the
   * first real upload lands on a warm socket instead of paying the cold
   * DNS+TCP+TLS handshake that measured 10–85 s on the owner's network (spec
   * §4.5). Fire-and-forget by contract: it is called for its side effect only,
   * its result is never awaited, and a throw is swallowed here so a warm-up
   * can never cost a cycle. Absent by default, leaving every other composition
   * byte-for-byte unchanged.
   */
  prewarm?: () => void;
}>): LibrarySyncTrigger {
  let inFlight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let rerunRequested = false;
  /**
   * K7 ①: set when a start could not take the shared lease. The holder's
   * release runs it once — no polling, no timer.
   */
  let cancelLeaseWait: (() => void) | null = null;
  const roundListeners = new Set<(outcome: RunToEmptyOutcome) => void>();

  const clearLeaseWait = (): void => {
    if (cancelLeaseWait === null) return;
    cancelLeaseWait();
    cancelLeaseWait = null;
  };

  // The single gate every event source goes through. There is one in-flight
  // flag, so two sources firing together still run one cycle, and a
  // still-running cycle coalesces later events instead of starting a second.
  // There is no time window (spec G2 "立刻"): `minIntervalMs` defaults to 0, so
  // a fresh event after a cycle finishes starts a new cycle at once. No timer,
  // no background fetch, no task manager: the trigger only ever reacts to a
  // caller's event.
  const start = (force: boolean): void => {
    if (disposed) return;
    if (inFlight) {
      if (force) rerunRequested = true;
      return;
    }
    const at = clock();
    if (!force && at - lastStartedAt < minIntervalMs) return;
    lastStartedAt = at;
    inFlight = true;

    const finish = (): void => {
      inFlight = false;
      if (disposed) return;
      if (rerunRequested) {
        rerunRequested = false;
        start(true);
      }
    };

    if (round !== undefined) {
      const activeRound = round;
      // #6: the background executor may be mid-round (headless wakeup that
      // overlapped a resume). Don't run concurrently — wait for its release
      // and run exactly once then.
      const releaseLease = acquireLease();
      if (releaseLease === null) {
        inFlight = false;
        lastStartedAt = Number.NEGATIVE_INFINITY;
        if (!disposed && cancelLeaseWait === null) {
          cancelLeaseWait = onLeaseReleased(() => {
            cancelLeaseWait = null;
            start(true);
          });
        }
        return;
      }
      const runRoundCycle = async (): Promise<void> => {
        try {
          await sync.sync();
        } catch {
          // A failed sync doesn't block the run-to-empty pass below; mirrors
          // the swallow-and-continue behavior of the plain cycle.
        }
        let outcome: RunToEmptyOutcome;
        try {
          outcome = await runToEmpty(activeRound, { maxRounds });
        } catch {
          // A structural round failure (e.g. listDownloadCandidates threw)
          // is a non-clean outcome, not a silent drop: listeners still hear
          // about it.
          outcome = { rounds: 0, clean: false, capped: false, lastRound: EMPTY_ROUND };
        }
        for (const cb of roundListeners) cb(outcome);
        // K7 ①: a non-clean round used to arm an immediate retry of the whole
        // round. A round that made no progress will not make progress 0 ms
        // later — the work is durable in the outbox and the local originals
        // are never dropped, so the next REAL event (save, foreground, session,
        // network return) picks it up.
      };
      void runRoundCycle()
        .catch(() => undefined)
        .finally(() => {
          releaseLease();
          finish();
        });
      return;
    }

    // Coalesced and swallowed: a triggered sync failure is never a user-facing
    // error, and a rejection must not block the next trigger. When afterCycle
    // is wired it runs right after sync in the same window; the extra `.then`
    // hop is added only in that case so the afterCycle-less path keeps its
    // exact prior microtask timing.
    const cycle =
      afterCycle === undefined ? sync.sync() : sync.sync().then(() => afterCycle());
    void cycle.catch(() => undefined).finally(finish);
  };

  return {
    onAppStateChange(state) {
      if (state !== 'active') {
        // Going to the background cancels a start that is still waiting for
        // the lease; the next foreground is its own event.
        clearLeaseWait();
        return;
      }
      start(false);
    },
    onLibraryChanged() {
      start(true);
    },
    onNetworkReturn() {
      start(false);
    },
    onSessionReady() {
      try {
        prewarm?.();
      } catch {
        // A warm-up is an optimization; it never owes the caller an error and
        // must not stop the cycle below from starting.
      }
      start(true);
    },
    onRoundComplete(cb) {
      roundListeners.add(cb);
      return () => roundListeners.delete(cb);
    },
    dispose() {
      disposed = true;
      clearLeaseWait();
    },
  };
}
