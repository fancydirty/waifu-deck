import type { SyncRoundResult } from '@/features/library/library-sync-run-to-empty';

/**
 * Module-level slot for the background task executor to reach the active
 * library composition's `round` function. `TaskManager.defineTask` runs in
 * the global scope before any provider/services bundle exists, so it cannot
 * receive the round function via props or context — it reads this slot
 * instead. The library-integration-impl composition writes it once the bundle
 * is ready and clears it (`null`) when the bundle is disposed, so a background
 * wakeup that lands with no live session correctly reports "nothing to do"
 * rather than running a stale round against a torn-down session.
 */
let libraryBackgroundRound: (() => Promise<SyncRoundResult>) | null = null;

export function setLibraryBackgroundRound(
  fn: (() => Promise<SyncRoundResult>) | null,
): void {
  libraryBackgroundRound = fn;
}

export function getLibraryBackgroundRound(): (() => Promise<SyncRoundResult>) | null {
  return libraryBackgroundRound;
}

// K4 §4.5 (#6): one process-wide lease so the foreground trigger and the
// background executor never run a round concurrently against the same
// database/account scope. Expo says WorkManager won't fire while the app is
// foregrounded; this makes that a code-level guarantee instead of an
// assumption. Non-blocking: `acquire` returns null when held.
let syncLeaseHeld = false;
/**
 * K7 ①: a caller that cannot get the lease used to arm a `setTimeout(0)` and
 * poll for it — a busy-wait landing exactly when the app is resuming and the UI
 * is remounting. Waiters register here instead and are run once, when the
 * holder actually releases.
 */
const leaseReleaseWaiters = new Set<() => void>();
/**
 * Board #27 (spec §5.4 step 1): 删除全部应用数据 queues here so it takes the
 * lease ahead of every waiting start. A running round finishes first; the
 * release then hands the lease straight to the next hold, and the waiters stay
 * queued until no hold is left.
 */
const holds: ((release: () => void) => void)[] = [];

/** Run `onRelease` once, the next time the lease is released. Returns an unsubscribe. */
export function onLibrarySyncLeaseReleased(onRelease: () => void): () => void {
  leaseReleaseWaiters.add(onRelease);
  return () => leaseReleaseWaiters.delete(onRelease);
}

/** One release for both a round and a hold. Idempotent. */
function createRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const grant = holds.shift();
    if (grant !== undefined) {
      grant(createRelease());
      return;
    }
    syncLeaseHeld = false;
    const waiters = [...leaseReleaseWaiters];
    leaseReleaseWaiters.clear();
    for (const waiter of waiters) waiter();
  };
}

export function acquireLibrarySyncLease(): (() => void) | null {
  if (syncLeaseHeld || holds.length > 0) return null;
  syncLeaseHeld = true;
  return createRelease();
}

/**
 * Take the process-wide sync lease, ahead of every waiting start. Resolves
 * with the release. The lease passes straight from a running round to this
 * hold; waiters run only when the hold releases and nothing else is queued.
 */
export function holdLibrarySync(): Promise<() => void> {
  if (!syncLeaseHeld && holds.length === 0) {
    syncLeaseHeld = true;
    return Promise.resolve(createRelease());
  }
  return new Promise((grant) => {
    holds.push(grant);
  });
}
