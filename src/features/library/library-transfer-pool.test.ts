import { runTransferPool, type TransferPoolResult } from '@/features/library/library-transfer-pool';

describe('runTransferPool', () => {
  it('runs all items, bounds concurrency, and one failure never aborts the rest', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];
    const result = await runTransferPool(
      items,
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        if (n === 7) { inFlight -= 1; throw new Error('boom'); }
        done.push(n);
        inFlight -= 1;
      },
      { concurrency: 4 },
    );
    expect(done.length).toBe(19);          // all but the thrower completed
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(result).toEqual({ total: 20, done: 19, failed: 1 });
  });

  it('returns zeros for an empty list without invoking the worker', async () => {
    const worker = jest.fn();
    expect(await runTransferPool([], worker, { concurrency: 4 }))
      .toEqual({ total: 0, done: 0, failed: 0 });
    expect(worker).not.toHaveBeenCalled();
  });

  it('never inserts an artificial delay between items (schedules no timer)', async () => {
    // Owner mirror ruling: no throttling. A throttle is a wall-clock delay,
    // which needs a timer (the review's own probe was `setTimeout(r, 50)`).
    // Fake the timers and drain only the microtask queue — never advance a
    // timer. A correct, throttle-free pool settles purely on microtasks and
    // leaves zero pending timers. A pool that slept between items would stay
    // parked on an unfired fake timer: `settled` would remain undefined and
    // `getTimerCount()` would be non-zero, failing the assertions below. This
    // discriminates the property; the prior version passed with or without a
    // sleep because it used real timers and asserted only the counts.
    jest.useFakeTimers();
    try {
      const items = [1, 2, 3];
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      let settled: TransferPoolResult | undefined;
      void runTransferPool(items, async () => undefined, { concurrency: 2 }).then((r) => {
        settled = r;
      });
      // Flush microtasks only; do not advance any timer.
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve();
      }
      expect(settled).toEqual({ total: 3, done: 3, failed: 0 });
      expect(jest.getTimerCount()).toBe(0);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
