import type { ByosStatus } from '@/features/byos/byos-context-resolver';

import {
  createLibraryRecoveryController,
  type LibraryRecoveryController,
  type RecoveryBundleState,
  type RecoveryVerdictKind,
} from '@/providers/library-recovery-controller';

const LOCK: ByosStatus = {
  status: 'locked',
  reason: 'vault_unreachable',
  detail: 'network',
};
const READY = {
  status: 'ready',
  context: { kind: 's3' },
} as ByosStatus;
const OTHER: ByosStatus = { status: 'locked', reason: 'password_required' };

function classify(verdict: ByosStatus): RecoveryVerdictKind {
  if (
    verdict.status === 'locked'
    && verdict.reason === 'vault_unreachable'
    && verdict.detail === 'network'
  ) return 'network-lock';
  if (verdict.status === 'ready') return 'ready';
  return 'other';
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function harness(options?: {
  resolve?: () => Promise<ByosStatus>;
  onReady?: (verdict: ByosStatus, isCurrent: () => boolean) => boolean;
}) {
  const resolve = jest.fn(options?.resolve ?? (async () => LOCK));
  const onReady = jest.fn(options?.onReady ?? (() => true));
  const onFullReload = jest.fn();
  const controller = createLibraryRecoveryController({
    resolve,
    classify,
    onReady,
    onFullReload,
  });
  return { controller, resolve, onReady, onFullReload };
}

function lock(controller: LibraryRecoveryController): void {
  controller.bundleChanged('network-locked');
}

describe('library recovery controller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('an edge on a network-locked bundle starts one resolve', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    controller.networkEdge();
    controller.networkEdge();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('an edge during a flight restarts the retry budget without a second resolve', async () => {
    const flight = deferred<ByosStatus>();
    const { controller, resolve } = harness({
      resolve: jest.fn()
        .mockResolvedValueOnce(LOCK)
        .mockReturnValueOnce(flight.promise)
        .mockResolvedValue(LOCK),
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    controller.networkEdge();
    expect(resolve).toHaveBeenCalledTimes(2);
    flight.resolve(LOCK);
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  test('an edge while a resolve is in flight does not start another', async () => {
    const flight = deferred<ByosStatus>();
    const { controller, resolve } = harness({ resolve: () => flight.promise });
    lock(controller);
    controller.networkEdge();
    controller.networkEdge();
    expect(resolve).toHaveBeenCalledTimes(1);
    flight.resolve(LOCK);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('an edge while ready and not network-locked is ignored', async () => {
    const { controller, resolve } = harness();
    controller.bundleChanged('ready');
    controller.networkEdge();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('an edge while no bundle is ready is remembered and consumed when the bundle is network-locked', async () => {
    const { controller, resolve } = harness();
    controller.bundleChanged('not-ready');
    controller.networkEdge();
    expect(resolve).not.toHaveBeenCalled();
    controller.bundleChanged('network-locked');
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('a further not-ready transition clears the edge, and a later edge is the one consumed', async () => {
    const { controller, resolve } = harness();
    controller.bundleChanged('not-ready');
    controller.networkEdge();
    controller.bundleChanged('not-ready');
    controller.bundleChanged('network-locked');
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    controller.bundleChanged('not-ready');
    controller.networkEdge();
    controller.bundleChanged('network-locked');
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('a bundle change away from a network lock clears a remembered edge', async () => {
    const { controller, resolve } = harness();
    controller.bundleChanged('not-ready');
    controller.networkEdge();
    controller.bundleChanged('ready');
    controller.bundleChanged('network-locked');
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('an edge while held is remembered and starts a sequence when the hold releases', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    const release = controller.beginHold();
    controller.networkEdge();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    release();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  test('an edge right after beginHold, while a flight is pending, is kept until release', async () => {
    const flight = deferred<ByosStatus>();
    const { controller, resolve, onReady, onFullReload } = harness({
      resolve: jest.fn()
        .mockReturnValueOnce(flight.promise)
        .mockResolvedValue(LOCK),
    });
    lock(controller);
    controller.networkEdge();
    const release = controller.beginHold();
    controller.networkEdge();
    expect(resolve).toHaveBeenCalledTimes(1);
    flight.resolve(LOCK);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onFullReload).not.toHaveBeenCalled();
    release();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  test('a hold taken with no sequence and no edge does not start a resolve', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    const release = controller.beginHold();
    release();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a hold taken mid-sequence restarts that sequence when it releases', async () => {
    const flight = deferred<ByosStatus>();
    const { controller, resolve } = harness({
      resolve: jest.fn()
        .mockReturnValueOnce(flight.promise)
        .mockResolvedValue(LOCK),
    });
    lock(controller);
    controller.networkEdge();
    const release = controller.beginHold();
    flight.resolve(READY);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test('release is idempotent and a nested hold stays until the outer release', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    const outer = controller.beginHold();
    controller.networkEdge();
    const inner = controller.beginHold();
    inner();
    inner();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    outer();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    outer();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test.each(['old-first', 'new-first'] as const)(
    'a new sequence ignores the flight it replaced (%s) and keeps both retries',
    async (order) => {
      const oldFlight = deferred<ByosStatus>();
      const newFlight = deferred<ByosStatus>();
      const { controller, resolve, onReady, onFullReload } = harness({
        resolve: jest.fn()
          .mockReturnValueOnce(oldFlight.promise)
          .mockReturnValueOnce(newFlight.promise)
          .mockResolvedValue(LOCK),
      });
      lock(controller);
      controller.networkEdge();
      const release = controller.beginHold();
      release();
      expect(resolve).toHaveBeenCalledTimes(2);
      const settleOld = () => {
        oldFlight.resolve(LOCK);
      };
      const settleNew = () => {
        newFlight.resolve(LOCK);
      };
      if (order === 'old-first') {
        settleOld();
        await flush();
        settleNew();
      } else {
        settleNew();
        await flush();
        settleOld();
      }
      await flush();
      expect(onReady).not.toHaveBeenCalled();
      expect(onFullReload).not.toHaveBeenCalled();
      expect(resolve).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(resolve).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(resolve).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(20_000);
      expect(resolve).toHaveBeenCalledTimes(4);
    },
  );

  test('a network-lock verdict schedules 3 s then 10 s, and the next edge starts clean', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    controller.networkEdge();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_999);
    expect(resolve).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(3);
    controller.networkEdge();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(4);
  });

  test('an edge while a retry is waiting starts a new sequence immediately', async () => {
    const { controller, resolve } = harness({
      resolve: jest.fn()
        .mockResolvedValueOnce(LOCK)
        .mockResolvedValueOnce(READY),
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    controller.networkEdge();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(13_000);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  test('a ready verdict publishes and does not reload or retry', async () => {
    const { controller, resolve, onReady, onFullReload } = harness({
      resolve: async () => READY,
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    expect(onReady).toHaveBeenCalledWith(READY, expect.any(Function));
    expect(onFullReload).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(13_000);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test.each(['hold', 'bundle', 'dispose'] as const)(
    'the onReady currency check turns false after a reentrant %s',
    async (event) => {
      let controller!: LibraryRecoveryController;
      let isCurrent!: () => boolean;
      const h = harness({
        resolve: async () => READY,
        onReady: (verdict, check) => {
          expect(verdict).toBe(READY);
          isCurrent = check;
          expect(isCurrent()).toBe(true);
          if (event === 'hold') controller.beginHold();
          else if (event === 'bundle') controller.bundleChanged('not-ready');
          else controller.dispose();
          expect(isCurrent()).toBe(false);
          return false;
        },
      });
      controller = h.controller;
      lock(controller);
      controller.networkEdge();
      await flush();
      expect(h.onReady).toHaveBeenCalledTimes(1);
      expect(isCurrent()).toBe(false);
      expect(h.onFullReload).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      controller.dispose();
    },
  );

  test('a hold taken inside onReady restarts a refused publication on release', async () => {
    let controller!: LibraryRecoveryController;
    let release!: () => void;
    const h = harness({
      resolve: jest.fn().mockResolvedValueOnce(READY).mockResolvedValue(LOCK),
      onReady: () => {
        release = controller.beginHold();
        return false;
      },
    });
    controller = h.controller;
    lock(controller);
    controller.networkEdge();
    await flush();
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.onReady).toHaveBeenCalledTimes(1);
    expect(h.onFullReload).not.toHaveBeenCalled();
    release();
    await flush();
    expect(h.resolve).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.resolve).toHaveBeenCalledTimes(4);
    controller.dispose();
  });

  test('a successful publication reenters bundleChanged ready and ends once', async () => {
    let controller!: LibraryRecoveryController;
    const h = harness({
      resolve: async () => READY,
      onReady: (_verdict, isCurrent) => {
        expect(isCurrent()).toBe(true);
        controller.bundleChanged('ready');
        expect(isCurrent()).toBe(false);
        return true;
      },
    });
    controller = h.controller;
    lock(controller);
    controller.networkEdge();
    await flush();
    controller.networkEdge();
    await jest.advanceTimersByTimeAsync(100_000);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.onReady).toHaveBeenCalledTimes(1);
    expect(h.onFullReload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    controller.dispose();
  });

  test('a refused rebind takes the full reload', async () => {
    const { controller, onReady, onFullReload } = harness({
      resolve: async () => READY,
      onReady: () => false,
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onFullReload).toHaveBeenCalledTimes(1);
  });

  test('any other verdict takes the full reload', async () => {
    const { controller, onReady, onFullReload } = harness({
      resolve: async () => OTHER,
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    expect(onReady).not.toHaveBeenCalled();
    expect(onFullReload).toHaveBeenCalledTimes(1);
  });

  test('a rejected resolve takes the full reload', async () => {
    const { controller, onFullReload } = harness({
      resolve: async () => {
        throw new Error('vault down');
      },
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    expect(onFullReload).toHaveBeenCalledTimes(1);
  });

  test('a retry that is not a network lock takes the full reload', async () => {
    const { controller, onFullReload } = harness({
      resolve: jest.fn()
        .mockResolvedValueOnce(LOCK)
        .mockRejectedValueOnce(new Error('still down')),
    });
    lock(controller);
    controller.networkEdge();
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(onFullReload).toHaveBeenCalledTimes(1);
  });

  test('dispose stops the timer, the flight, and every later event', async () => {
    const flight = deferred<ByosStatus>();
    const { controller, resolve, onReady, onFullReload } = harness({
      resolve: () => flight.promise,
    });
    lock(controller);
    controller.networkEdge();
    const release = controller.beginHold();
    controller.dispose();
    expect(controller.disposed).toBe(true);
    flight.resolve(READY);
    await flush();
    release();
    controller.networkEdge();
    controller.bundleChanged('network-locked');
    controller.beginHold()();
    await jest.advanceTimersByTimeAsync(13_000);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onFullReload).not.toHaveBeenCalled();
  });

  test('dispose cancels a retry that has not fired', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    controller.networkEdge();
    await flush();
    controller.dispose();
    await jest.advanceTimersByTimeAsync(13_000);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('a bundle change invalidates the flight that was already running', async () => {
    const flight = deferred<ByosStatus>();
    const { controller, resolve, onReady, onFullReload } = harness({
      resolve: () => flight.promise,
    });
    lock(controller);
    controller.networkEdge();
    controller.bundleChanged('not-ready' satisfies RecoveryBundleState);
    flight.resolve(READY);
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    expect(onFullReload).not.toHaveBeenCalled();
  });

  test('releasing a hold while the bundle is ready starts no resolve', async () => {
    const { controller, resolve } = harness();
    controller.bundleChanged('ready');
    const release = controller.beginHold();
    controller.networkEdge();
    release();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('releasing a hold while nothing is ready waits for a network-locked bundle', async () => {
    const { controller, resolve } = harness();
    controller.bundleChanged('not-ready');
    const release = controller.beginHold();
    controller.networkEdge();
    release();
    await flush();
    expect(resolve).not.toHaveBeenCalled();
    controller.bundleChanged('network-locked');
    await flush();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test.each(['bundle', 'dispose'] as const)(
    'a refused rebind does not reload after %s invalidates its token',
    async (how) => {
      const box: { controller: LibraryRecoveryController | null } = { controller: null };
      const { controller, onFullReload } = harness({
        resolve: async () => READY,
        onReady: () => {
          if (how === 'dispose') box.controller?.dispose();
          else box.controller?.bundleChanged('not-ready');
          return false;
        },
      });
      box.controller = controller;
      lock(controller);
      controller.networkEdge();
      await flush();
      expect(onFullReload).not.toHaveBeenCalled();
    },
  );

  test('an edge during the 10 s wait starts a sequence that still has both retries', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    controller.networkEdge();
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(2);
    controller.networkEdge();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  test('a new edge after both retries are spent gets both retries again', async () => {
    const { controller, resolve } = harness();
    lock(controller);
    controller.networkEdge();
    await flush();
    await jest.advanceTimersByTimeAsync(3_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(3);
    controller.networkEdge();
    await flush();
    expect(resolve).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(resolve).toHaveBeenCalledTimes(5);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolve).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(resolve).toHaveBeenCalledTimes(6);
  });
});
