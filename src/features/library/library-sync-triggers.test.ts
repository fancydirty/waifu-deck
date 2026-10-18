import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import { acquireLibrarySyncLease } from '@/features/library/library-background-sync-slot';
import {
  createLibrarySyncTrigger,
  LIBRARY_SYNC_MIN_INTERVAL_MS,
} from '@/features/library/library-sync-triggers';

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSync(
  syncImpl: () => Promise<unknown> = async () => ({ status: 'completed' }),
): LibrarySyncController {
  return {
    sync: jest.fn(syncImpl) as unknown as LibrarySyncController['sync'],
    readSyncState: async () => null,
    enqueueRestoreIntent: async () => ({
      status: 'not-applicable' as const,
      reason: 'unknown_asset' as const,
    }),
    enqueuePermanentDeleteIntent: async () => ({
      status: 'not-applicable' as const,
      reason: 'unknown_asset' as const,
    }),
  };
}

describe('createLibrarySyncTrigger foreground source', () => {
  test('a foreground transition runs one cycle', async () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onAppStateChange('active');

    expect(sync.sync).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  test('a second foreground transition after the first completes runs again (no throttle window)', async () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onAppStateChange('active');
    await flush();
    trigger.onAppStateChange('active'); // same instant, no window to block it
    await flush();

    expect(sync.sync).toHaveBeenCalledTimes(2);
  });

  test('a transition while a cycle is already in flight runs nothing and does not queue a second', async () => {
    const pending = deferred<{ status: string }>();
    const sync = createSync(() => pending.promise);
    let now = 1_000;
    const trigger = createLibrarySyncTrigger({
      sync,
      clock: () => now,
    });

    trigger.onAppStateChange('active');
    expect(sync.sync).toHaveBeenCalledTimes(1);

    now += LIBRARY_SYNC_MIN_INTERVAL_MS + 1;
    trigger.onAppStateChange('active');
    expect(sync.sync).toHaveBeenCalledTimes(1);

    pending.resolve({ status: 'completed' });
    await pending.promise;
    await Promise.resolve();

    expect(sync.sync).toHaveBeenCalledTimes(1);
  });

  test('a rejected cycle is swallowed and does not stop later triggers', async () => {
    const sync = createSync(async () => {
      throw new Error('offline');
    });
    let now = 1_000;
    const trigger = createLibrarySyncTrigger({
      sync,
      clock: () => now,
    });

    trigger.onAppStateChange('active');
    await Promise.resolve();
    await Promise.resolve();

    now += LIBRARY_SYNC_MIN_INTERVAL_MS + 1;
    trigger.onAppStateChange('active');
    await Promise.resolve();

    expect(sync.sync).toHaveBeenCalledTimes(2);
  });

  test('a non-active state runs nothing', () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onAppStateChange('background');
    trigger.onAppStateChange('inactive');

    expect(sync.sync).not.toHaveBeenCalled();
  });

  test('dispose() stops all further work', async () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.dispose();
    trigger.onAppStateChange('active');

    expect(sync.sync).not.toHaveBeenCalled();
  });
});

/**
 * K7 ⑤: `onScreenFocus` is deleted. A tab tap is not a data-change event, and
 * it ran a whole round on the frame the grid mounted. These are the three real
 * sources that replace it — each still starts exactly one cycle.
 */
describe('createLibrarySyncTrigger real event sources (onScreenFocus removed)', () => {
  it('K6-5b: onNetworkReturn drives a sync cycle like a foreground return', async () => {
    const sync = { sync: jest.fn().mockResolvedValue(undefined), readSyncState: jest.fn(), enqueueRestoreIntent: jest.fn() } as unknown as Parameters<typeof createLibrarySyncTrigger>[0]['sync'];
    const trigger = createLibrarySyncTrigger({ sync });
    trigger.onNetworkReturn();
    await Promise.resolve();
    await Promise.resolve();
    expect((sync.sync as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(typeof trigger.onNetworkReturn).toBe('function');
  });

  test('the trigger exposes no screen-focus entry point at all', () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    expect((trigger as Record<string, unknown>).onScreenFocus).toBeUndefined();
    expect(Object.keys(trigger)).not.toContain('onScreenFocus');
  });

  test('onLibraryChanged runs exactly one cycle', async () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onLibraryChanged();

    expect(sync.sync).toHaveBeenCalledTimes(1);
    await flush();
  });

  test('onSessionReady runs exactly one cycle', async () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onSessionReady();

    expect(sync.sync).toHaveBeenCalledTimes(1);
    await flush();
  });

  test('a content-change event coalesces with an in-flight cycle', async () => {
    const pending = deferred<{ status: string }>();
    const sync = createSync(() => pending.promise);
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onAppStateChange('active'); // starts the cycle; it stays in flight
    expect(sync.sync).toHaveBeenCalledTimes(1);
    trigger.onLibraryChanged(); // coalesced by the in-flight flag, not a window
    expect(sync.sync).toHaveBeenCalledTimes(1);

    pending.resolve({ status: 'completed' });
    await flush();

    // Forced sources re-run once right after; that is B7's contract.
    expect(sync.sync).toHaveBeenCalledTimes(2);
  });

  test('a rejected content-change cycle is swallowed', async () => {
    const sync = createSync(async () => {
      throw new Error('offline');
    });
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onLibraryChanged();
    await flush();

    trigger.onLibraryChanged();
    await flush();

    expect(sync.sync).toHaveBeenCalledTimes(2);
  });

  test('dispose() stops content-change work', () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.dispose();
    trigger.onLibraryChanged();
    trigger.onSessionReady();

    expect(sync.sync).not.toHaveBeenCalled();
  });
});

describe('createLibrarySyncTrigger afterCycle', () => {
  test('runs afterCycle once, after sync, in the same in-flight window', async () => {
    const order: string[] = [];
    const sync = createSync(async () => {
      order.push('sync');
      return { status: 'completed' };
    });
    const afterCycle = jest.fn(async () => {
      order.push('after');
    });
    const trigger = createLibrarySyncTrigger({ sync, afterCycle, clock: () => 0 });

    trigger.onAppStateChange('active');
    await new Promise((r) => setTimeout(r, 0));

    expect(order).toEqual(['sync', 'after']);
    expect(afterCycle).toHaveBeenCalledTimes(1);
  });

  test('still clears in-flight when afterCycle rejects', async () => {
    let n = 0;
    const sync = createSync();
    const afterCycle = jest.fn(async () => {
      n += 1;
      throw new Error('boom');
    });
    const clock = jest.fn(() => 0);
    const trigger = createLibrarySyncTrigger({ sync, afterCycle, clock });

    trigger.onAppStateChange('active');
    await new Promise((r) => setTimeout(r, 0));

    // A second foreground far in the future must run again (in-flight cleared).
    clock.mockReturnValue(10_000_000);
    trigger.onAppStateChange('active');
    await new Promise((r) => setTimeout(r, 0));

    expect(n).toBe(2);
  });

  test('afterCycle can run two ordered steps in one in-flight window', async () => {
    const order: string[] = [];
    const sync = createSync(async () => { order.push('sync'); return { status: 'completed' }; });
    const up = jest.fn(async () => { order.push('up'); });
    const down = jest.fn(async () => { order.push('down'); });
    const trigger = createLibrarySyncTrigger({
      sync,
      afterCycle: async () => { await up(); await down(); },
      clock: () => 0,
    });
    trigger.onAppStateChange('active');
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['sync', 'up', 'down']);
  });
});

const ROUND_EMPTY = {
  up: { total: 0, done: 0, failed: 0 },
  down: { total: 0, done: 0, failed: 0 },
};
const ROUND_CAPPED = { up: { total: 5, done: 1, failed: 4 }, down: ROUND_EMPTY.down };

describe('K4 content-change sources and run-to-empty', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('B6 both a repeated foreground and onLibraryChanged run a fresh round (no throttle window)', async () => {
    let now = 1_000;
    const sync = createSync();
    const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => now });
    t.onAppStateChange('active');
    await flush(); // 1st cycle
    expect(sync.sync).toHaveBeenCalledTimes(1);
    now += 5_000;
    t.onAppStateChange('active');
    await flush(); // no window: the foreground runs a fresh cycle immediately
    expect(sync.sync).toHaveBeenCalledTimes(2);
    t.onLibraryChanged();
    await flush();
    expect(sync.sync).toHaveBeenCalledTimes(3);
  });

  test('B7 onLibraryChanged during an in-flight cycle re-runs once right after it', async () => {
    const gate = deferred<void>();
    const sync = createSync(() => gate.promise);
    const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => 1_000 });
    t.onAppStateChange('active');
    t.onLibraryChanged();
    t.onLibraryChanged();
    expect(sync.sync).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
    expect(sync.sync).toHaveBeenCalledTimes(2); // exactly one re-run, coalesced
  });

  test('B8 a clean outcome schedules no residue timer', async () => {
    const sync = createSync();
    const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    t.onAppStateChange('active');
    await flush();
    jest.advanceTimersByTime(5 * 60_000);
    await flush();
    expect(sync.sync).toHaveBeenCalledTimes(1);
  });

  /**
   * K7 ①: B9/B9b used to assert the opposite — that a non-clean round armed a
   * 0 ms retry. That retry re-ran a WHOLE round (bucket LIST, full-library
   * UPSERT, candidate scan, re-read/re-encrypt every pending file) against the
   * state that had just failed to make progress, with no ceiling and no gap.
   * A round that made zero progress will not make progress 0 ms later; the
   * retry belongs on a real event (a save, a foreground, a session, a network
   * return), all of which already drive this trigger.
   */
  test('B9 a capped outcome arms NO automatic re-run', async () => {
    const sync = createSync();
    const round = jest.fn(async () => ROUND_CAPPED);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now(), maxRounds: 2 });
    t.onAppStateChange('active');
    await flush();
    expect(round).toHaveBeenCalledTimes(2); // the two rounds runToEmpty itself ran

    jest.advanceTimersByTime(5 * 60_000);
    await flush();

    expect(round).toHaveBeenCalledTimes(2); // nothing re-ran on its own
    expect(jest.getTimerCount()).toBe(0); // and no timer was ever armed
  });

  test('B9b after a non-clean round a REAL event still runs a fresh round', async () => {
    const sync = createSync();
    const round = jest.fn(async () => ROUND_CAPPED);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now(), maxRounds: 1 });
    t.onAppStateChange('active');
    await flush();
    expect(round).toHaveBeenCalledTimes(1);

    // The user saves a new image: that is a reason to try again, unlike a timer.
    t.onLibraryChanged();
    await flush();
    expect(round).toHaveBeenCalledTimes(2);
  });

  test('B10 dispose leaves nothing that could fire later', async () => {
    const sync = createSync();
    const round = jest.fn(async () => ROUND_CAPPED);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now(), maxRounds: 1 });
    t.onAppStateChange('active');
    await flush();
    t.dispose();
    jest.advanceTimersByTime(5 * 60_000);
    await flush();
    expect(round).toHaveBeenCalledTimes(1);
  });

  test('B11 onRoundComplete fires once per runToEmpty with the outcome', async () => {
    const sync = createSync();
    const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    const seen: unknown[] = [];
    const off = t.onRoundComplete((o) => seen.push(o));
    t.onAppStateChange('active');
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ clean: true, rounds: 1 });
    off();
    t.onLibraryChanged();
    await flush();
    expect(seen).toHaveLength(1);
  });

  test('K4-C2a: dispose() during an in-flight non-clean round arms no timer afterwards', async () => {
    const gate = deferred<void>(); const sync = createSync(() => gate.promise);
    const round = jest.fn(async () => ROUND_CAPPED);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now(), maxRounds: 1 });
    t.onAppStateChange('active');
    t.dispose();
    gate.resolve(); await flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('K4-C2b: a forced re-run after a non-clean round runs exactly once, and nothing fires later', async () => {
    const gate = deferred<void>(); const sync = createSync(() => gate.promise);
    let n = 0;
    const round = jest.fn(async () => (n++ === 0 ? ROUND_CAPPED : ROUND_EMPTY));
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now(), maxRounds: 1 });
    t.onAppStateChange('active'); t.onLibraryChanged();  // forced re-run queued while in flight
    gate.resolve(); await flush();                        // round 1 capped; then the forced re-run → clean
    expect(round).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(5 * 60_000); await flush();
    expect(round).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('K4-C5: a structural mirrorDown rejection still notifies listeners, and still arms no retry', async () => {
    const sync = createSync();
    const round = jest.fn(async () => { throw new Error('listDownloadCandidates failed'); });
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    const seen: unknown[] = []; t.onRoundComplete((o) => seen.push(o));
    t.onAppStateChange('active'); await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ clean: false });
    jest.advanceTimersByTime(60_000); await flush();
    expect(round).toHaveBeenCalledTimes(1); // no automatic retry
  });

  test('K4-C6: the foreground trigger holds the shared sync lease during a round and releases it after (bg executor can then run)', async () => {
      const gate = deferred<void>(); const sync = createSync(() => gate.promise);
    const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    t.onAppStateChange('active');
    expect(acquireLibrarySyncLease()).toBeNull();        // held by the in-flight round
    gate.resolve(); await flush();
    const r = acquireLibrarySyncLease(); expect(r).not.toBeNull(); r?.();
  });

  test('K4-C6b: when the bg executor holds the lease, the start is deferred and runs ONCE on release (no polling)', async () => {
    const sync = createSync(); const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    const release = acquireLibrarySyncLease();
    t.onLibraryChanged(); await flush();
    expect(sync.sync).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);   // K7 ①: no setTimeout(0) busy-wait

    release?.(); await flush();                 // the release itself runs the deferred start
    expect(sync.sync).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5 * 60_000); await flush();
    expect(sync.sync).toHaveBeenCalledTimes(1); // exactly once, not once per tick
  });

  test('K4-C6c: two deferred starts while the lease is held collapse into one run after release', async () => {
    const sync = createSync(); const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    const release = acquireLibrarySyncLease();
    t.onLibraryChanged();
    t.onSessionReady();
    t.onAppStateChange('active');
    await flush();
    expect(sync.sync).not.toHaveBeenCalled();

    release?.(); await flush();
    expect(sync.sync).toHaveBeenCalledTimes(1);
  });

  test('K4-C6d: dispose before the lease is released cancels the deferred start', async () => {
    const sync = createSync(); const round = jest.fn(async () => ROUND_EMPTY);
    const t = createLibrarySyncTrigger({ sync, round, clock: () => Date.now() });
    const release = acquireLibrarySyncLease();
    t.onLibraryChanged(); await flush();
    t.dispose();

    release?.(); await flush();
    expect(sync.sync).not.toHaveBeenCalled();
  });
});

/**
 * K6-1d: a bound bucket is about to be talked to, and a cold TLS handshake to
 * R2 measured 10–85 s on the owner's network. The session-ready trigger is the
 * earliest moment a real connection can be opened, so it opens one — off to the
 * side of the cycle it already starts, never in front of it.
 */
describe('K6-1d connection pre-warm', () => {
  test('session-ready pre-warms the transport exactly once, and still runs its cycle', async () => {
    const sync = createSync();
    const prewarm = jest.fn();
    const trigger = createLibrarySyncTrigger({ sync, prewarm, clock: () => 1_000 });

    trigger.onSessionReady();
    await flush();

    expect(prewarm).toHaveBeenCalledTimes(1);
    expect(sync.sync).toHaveBeenCalledTimes(1);
  });

  test('the other three sources never pre-warm: the pool is already warm by then', async () => {
    const sync = createSync();
    const prewarm = jest.fn();
    const trigger = createLibrarySyncTrigger({ sync, prewarm, clock: () => 1_000 });

    trigger.onAppStateChange('active');
    await flush();
    trigger.onAppStateChange('active');
    await flush();
    trigger.onLibraryChanged();
    await flush();

    expect(prewarm).not.toHaveBeenCalled();
  });

  test('a pre-warm that throws costs neither the cycle nor the caller', async () => {
    const sync = createSync();
    const prewarm = jest.fn(() => {
      throw new Error('offline');
    });
    const trigger = createLibrarySyncTrigger({ sync, prewarm, clock: () => 1_000 });

    expect(() => trigger.onSessionReady()).not.toThrow();
    await flush();

    expect(sync.sync).toHaveBeenCalledTimes(1);
  });

  test('a session-ready that coalesces into an in-flight cycle still pre-warms', async () => {
    const gate = deferred<void>();
    const sync = createSync(() => gate.promise);
    const prewarm = jest.fn();
    const trigger = createLibrarySyncTrigger({ sync, prewarm, clock: () => 1_000 });

    trigger.onAppStateChange('active');
    await flush();
    expect(sync.sync).toHaveBeenCalledTimes(1);

    trigger.onSessionReady();
    await flush();

    // The cycle is coalesced away; warming the connection is not.
    expect(prewarm).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
  });

  test('a trigger without a pre-warm behaves exactly as before', async () => {
    const sync = createSync();
    const trigger = createLibrarySyncTrigger({ sync, clock: () => 1_000 });

    trigger.onSessionReady();
    await flush();

    expect(sync.sync).toHaveBeenCalledTimes(1);
  });
});
