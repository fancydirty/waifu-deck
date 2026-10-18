import type { ByosStatus } from '@/features/byos/byos-context-resolver';

// Recovery state lives here, not in React. A sequence owns a token. A new
// sequence, a hold, a bundle change, or dispose invalidates that token, so a
// late verdict cannot publish or schedule a retry. The next retry is armed
// here, at 3 s then 10 s, when the current token's verdict is still a network lock.

export type RecoveryBundleState = 'network-locked' | 'ready' | 'not-ready';

export type RecoveryVerdictKind = 'network-lock' | 'ready' | 'other';

export interface RecoveryTimers {
  setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface LibraryRecoveryControllerDeps {
  resolve: () => Promise<ByosStatus>;
  classify: (verdict: ByosStatus) => RecoveryVerdictKind;
  /** Publish only while isCurrent() holds. False takes the full reload if still current. */
  onReady: (verdict: ByosStatus, isCurrent: () => boolean) => boolean;
  onFullReload: () => void;
  delays?: readonly number[];
  timers?: RecoveryTimers;
}

export interface LibraryRecoveryController {
  readonly disposed: boolean;
  networkEdge(): void;
  bundleChanged(state: RecoveryBundleState): void;
  beginHold(): () => void;
  dispose(): void;
}

const DEFAULT_DELAYS_MS = [3_000, 10_000] as const;

export function createLibraryRecoveryController(
  deps: LibraryRecoveryControllerDeps,
): LibraryRecoveryController {
  const delays = deps.delays ?? DEFAULT_DELAYS_MS;
  const timers: RecoveryTimers = deps.timers ?? {
    setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimeout: (timer) => {
      clearTimeout(timer);
    },
  };

  let disposed = false;
  let bundle: RecoveryBundleState = 'not-ready';
  let holdCount = 0;
  let rememberedEdge = false;
  let token = 0;
  let phase: 'idle' | 'flight' | 'wait' = 'idle';
  let retriesDone = 0;
  let restartRetries = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function rememberEdge(): void {
    rememberedEdge = true;
  }

  function clearTimer(): void {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  }

  function invalidate(): void {
    clearTimer();
    token += 1;
    phase = 'idle';
    restartRetries = false;
  }

  function accepts(myToken: number): boolean {
    return myToken === token && !disposed;
  }

  function startSequence(): void {
    if (disposed) return;
    invalidate();
    rememberedEdge = false;
    retriesDone = 0;
    phase = 'flight';
    const myToken = token;
    void settle(myToken);
  }

  function scheduleRetry(myToken: number): void {
    if (!accepts(myToken)) return;
    // An edge during this flight does not start a second resolve. It does
    // restart the 3 s / 10 s budget when this verdict is still a network lock.
    if (restartRetries) {
      restartRetries = false;
      retriesDone = 0;
    }
    if (retriesDone >= delays.length) {
      phase = 'idle';
      return;
    }
    const delayMs = delays[retriesDone];
    retriesDone += 1;
    phase = 'wait';
    timer = timers.setTimeout(() => {
      if (!accepts(myToken)) return;
      timer = null;
      phase = 'flight';
      void settle(myToken);
    }, delayMs);
  }

  async function settle(myToken: number): Promise<void> {
    let verdict: ByosStatus;
    try {
      verdict = await deps.resolve();
    } catch {
      if (!accepts(myToken)) return;
      phase = 'idle';
      deps.onFullReload();
      return;
    }
    if (!accepts(myToken)) return;
    const kind = deps.classify(verdict);
    if (kind === 'network-lock') {
      scheduleRetry(myToken);
      return;
    }
    if (kind === 'ready') {
      // Applying the verdict is still part of the sequence. A hold inside
      // rebind must remember it, and any reentrant change owns the state next.
      const published = deps.onReady(verdict, () => accepts(myToken));
      if (!accepts(myToken)) return;
      phase = 'idle';
      if (!published) deps.onFullReload();
      return;
    }
    phase = 'idle';
    deps.onFullReload();
  }

  return {
    get disposed() {
      return disposed;
    },
    networkEdge() {
      if (disposed) return;
      if (holdCount > 0 || bundle === 'not-ready') {
        rememberEdge();
        return;
      }
      if (bundle !== 'network-locked') return;
      if (phase === 'flight') {
        restartRetries = true;
        return;
      }
      startSequence();
    },
    bundleChanged(state) {
      if (disposed) return;
      bundle = state;
      invalidate();
      if (state !== 'network-locked') {
        rememberedEdge = false;
        return;
      }
      if (rememberedEdge && holdCount === 0) startSequence();
    },
    beginHold() {
      if (disposed) return () => undefined;
      holdCount += 1;
      if (holdCount === 1 && phase !== 'idle') rememberEdge();
      if (holdCount === 1) invalidate();
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        if (disposed) return;
        holdCount = Math.max(0, holdCount - 1);
        if (holdCount === 0 && rememberedEdge && bundle === 'network-locked') {
          startSequence();
        }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
      rememberedEdge = false;
      holdCount = 0;
    },
  };
}
