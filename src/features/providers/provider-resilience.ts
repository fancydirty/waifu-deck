import {
  CircuitState,
  ConsecutiveBreaker,
  ExponentialBackoff,
  bulkhead,
  circuitBreaker,
  handleWhen,
  noJitterGenerator,
  type CircuitBreakerPolicy,
  type IDisposable,
} from 'cockatiel';

import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import type { ImageProviderKey } from '@/features/waifu/types';

const PROVIDER_KEYS: readonly ImageProviderKey[] =
  PROVIDER_REGISTRY.map((adapter) => adapter.key);

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_CIRCUIT_COOLDOWN_MS = 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15_000;
// Nekos discovery fans out up to eight candidate requests. Keep the queue
// bounded while allowing one complete provider batch to wait for a slot.
const DEFAULT_QUEUE_CAPACITY = 8;

/**
 * K7 ⑮ — how many requests one source may have in flight at once.
 *
 * This is a *politeness* budget owed to a third party, not a throttle on the
 * user. The engines already fan a discovery batch out as concurrent promises;
 * a capacity of 1 collapsed that fan-out back into a queue, so a batch of four
 * cost four round trips end to end and one black-holed request blocked the
 * three behind it until its 12 s deadline expired.
 *
 * `e621`/`e926` are the only sources with a published hard budget (2 req/s),
 * and their discovery batch is already capped at 2, so they keep the
 * single-flight lane: two spaced requests instead of two simultaneous ones.
 * Every other source's published allowance is far above four concurrent reads
 * (Danbooru documents 10 req/s), and four is the widest fan-out any of their
 * batches issues, so nothing here can exceed what the fan-out already asked
 * for.
 */
export const PROVIDER_CONCURRENCY_DEFAULT = 4;
export const PROVIDER_CONCURRENCY: Readonly<
  Partial<Record<ImageProviderKey, number>>
> = Object.freeze({
  e621: 1,
  e926: 1,
});

function concurrencyFor(providerKey: ImageProviderKey): number {
  return PROVIDER_CONCURRENCY[providerKey] ?? PROVIDER_CONCURRENCY_DEFAULT;
}

// K7 ㉒ — there is no retry layer here. TanStack Query owns user-visible retry
// scheduling, so the governor was always built with `maxAttempts: 0`: a policy
// that by construction could never fire. Its only effect was a fourth nested
// policy between the caller and the request, which made the three that do
// matter (bulkhead, circuit, rate-limit isolation) harder to reason about.

export type ProviderHealthStatus =
  | 'idle'
  | 'healthy'
  | 'degraded'
  | 'cooldown'
  | 'probing';

export type ProviderHealthEntry = Readonly<{
  providerKey: ImageProviderKey;
  status: ProviderHealthStatus;
  consecutiveFailures: number;
  blockedUntil: number | null;
  lastErrorCode: string | null;
  updatedAt: number;
}>;

export type ProviderHealthSnapshot = Readonly<
  Record<ImageProviderKey, ProviderHealthEntry>
>;

export type ProviderHealthListener = (snapshot: ProviderHealthSnapshot) => void;

export interface ProviderRequestGovernor {
  execute<T>(
    providerKey: ImageProviderKey,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  getSnapshot(): ProviderHealthSnapshot;
  subscribe(listener: ProviderHealthListener): () => void;
  reset(): void;
}

export type ProviderRequestGovernorOptions = Readonly<{
  failureThreshold?: number;
  circuitCooldownMs?: number;
  maxCircuitCooldownMs?: number;
  rateLimitCooldownMs?: number;
  queueCapacity?: number;
}>;

export class ProviderCooldownError extends Error {
  readonly code = 'rate_limited' as const;
  readonly providerKey: ImageProviderKey;
  readonly retryAfterMs: number;

  constructor(
    providerKey: ImageProviderKey,
    retryAfterMs: number,
    options: { cause?: unknown } = {},
  ) {
    const normalizedRetryAfterMs = normalizeDuration(retryAfterMs);
    super(
      `${providerKey} is cooling down for ${normalizedRetryAfterMs}ms`,
    );
    this.name = 'ProviderCooldownError';
    this.providerKey = providerKey;
    this.retryAfterMs = normalizedRetryAfterMs;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, ProviderCooldownError.prototype);
  }
}

type ResolvedOptions = Readonly<{
  failureThreshold: number;
  circuitCooldownMs: number;
  maxCircuitCooldownMs: number;
  rateLimitCooldownMs: number;
  queueCapacity: number;
}>;

type IsolationHandle = ReturnType<CircuitBreakerPolicy['isolate']>;

type ProviderRuntime = {
  readonly providerKey: ImageProviderKey;
  readonly generation: number;
  readonly bulkheadPolicy: ReturnType<typeof bulkhead>;
  readonly circuitPolicy: CircuitBreakerPolicy;
  readonly subscriptions: IDisposable[];
  active: boolean;
  releasingIsolation: boolean;
  circuitOpenCount: number;
  circuitBlockedUntil: number | null;
  pendingCircuitErrorCode: string | null;
  rateLimitBlockedUntil: number | null;
  isolation: IsolationHandle | null;
};

type ErrorDetails = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  retryAfterMs?: unknown;
  isTaskCancelledError?: unknown;
};

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.ceil(value);
}

function errorDetails(error: unknown): ErrorDetails {
  return error !== null && typeof error === 'object'
    ? error as ErrorDetails
    : {};
}

function errorCode(error: unknown): string | null {
  const { code } = errorDetails(error);
  return typeof code === 'string' ? code.toLowerCase() : null;
}

function errorStatus(error: unknown): number | null {
  const details = errorDetails(error);
  const value = typeof details.status === 'number'
    ? details.status
    : details.statusCode;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function retryAfterMs(error: unknown): number | null {
  const value = errorDetails(error).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? normalizeDuration(value)
    : null;
}

function isRateLimited(error: unknown): boolean {
  return errorCode(error) === 'rate_limited' || errorStatus(error) === 429;
}

function isCancellation(error: unknown): boolean {
  const details = errorDetails(error);
  const code = errorCode(error);
  return details.isTaskCancelledError === true ||
    code === 'aborted' ||
    code === 'abort' ||
    code === 'cancelled' ||
    code === 'canceled' ||
    (error instanceof Error && error.name === 'AbortError');
}

/**
 * K7 ⑱ — what counts as *the source* having failed.
 *
 * The breaker exists to stop hammering a host that is actually broken. A
 * `network` or `timeout` failure is not evidence about the host: it is what
 * every source looks like from a phone that walked into a lift. The old
 * predicate counted them, so five seconds of dead WiFi tripped all ten sources
 * at once (one batch is already >= 3 requests) and then refused them for
 * 15 -> 30 -> 60 s *after* the radio came back, showing "source unavailable"
 * for a source that was never asked.
 *
 * What remains is evidence the host itself produced: a source's own verdict
 * on the user's key (code `auth`: Gelbooru's HTTP 401, Rule34's "Missing
 * authentication" answer), HTTP 5xx, HTTP 429, and a 200 whose body could
 * not be parsed (`invalid_response`). The 429 path also
 * keeps its own `isolate()` + Retry-After cooldown in `invokeOperation`; this
 * predicate only decides what the consecutive-failure breaker counts.
 *
 * The same predicate drives the health snapshot, so the Settings rows stop
 * blaming a source for the phone's own connectivity.
 */
function isSourceFailure(error: unknown): boolean {
  const code = errorCode(error);
  const status = errorStatus(error);
  return isRateLimited(error) ||
    code === 'auth' ||
    code === 'invalid_response' ||
    (status !== null && status >= 500);
}

function healthErrorCode(error: unknown): string {
  const code = errorCode(error);
  if (code === 'auth') return 'auth';
  if (code !== null) return code;
  const status = errorStatus(error);
  return status === null ? 'provider' : `http_${status}`;
}

function createCancellationError(cause: unknown): Error & { code: 'aborted' } {
  const error = Object.assign(new Error('Provider request was cancelled'), {
    code: 'aborted' as const,
  });
  error.name = 'AbortError';
  error.cause = cause;
  return error;
}

function validateInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function validateDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.ceil(value);
}

function resolveOptions(
  options: ProviderRequestGovernorOptions,
): ResolvedOptions {
  const circuitCooldownMs = validateDuration(
    'circuitCooldownMs',
    options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS,
  );
  const maxCircuitCooldownMs = validateDuration(
    'maxCircuitCooldownMs',
    options.maxCircuitCooldownMs ?? DEFAULT_MAX_CIRCUIT_COOLDOWN_MS,
  );
  if (maxCircuitCooldownMs < circuitCooldownMs) {
    throw new RangeError('maxCircuitCooldownMs must be at least circuitCooldownMs');
  }

  return {
    failureThreshold: validateInteger(
      'failureThreshold',
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      1,
    ),
    circuitCooldownMs,
    maxCircuitCooldownMs,
    rateLimitCooldownMs: validateDuration(
      'rateLimitCooldownMs',
      options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    ),
    queueCapacity: validateInteger(
      'queueCapacity',
      options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY,
      0,
    ),
  };
}

function initialSnapshot(now: number): ProviderHealthSnapshot {
  return Object.freeze(Object.fromEntries(PROVIDER_KEYS.map((providerKey) => [
    providerKey,
    Object.freeze({
      providerKey,
      status: 'idle' as const,
      consecutiveFailures: 0,
      blockedUntil: null,
      lastErrorCode: null,
      updatedAt: now,
    }),
  ])) as Record<ImageProviderKey, ProviderHealthEntry>);
}

class DefaultProviderRequestGovernor implements ProviderRequestGovernor {
  private readonly options: ResolvedOptions;
  private readonly listeners = new Set<ProviderHealthListener>();
  private runtimes = new Map<ImageProviderKey, ProviderRuntime>();
  private snapshot: ProviderHealthSnapshot;
  private generation = 0;

  constructor(options: ProviderRequestGovernorOptions) {
    this.options = resolveOptions(options);
    this.snapshot = initialSnapshot(Date.now());
    this.createRuntimes();
  }

  async execute<T>(
    providerKey: ImageProviderKey,
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const runtime = this.runtimes.get(providerKey);
    if (!runtime) throw new Error(`Unknown image provider: ${providerKey}`);

    try {
      const result = await runtime.bulkheadPolicy.execute(
        ({ signal: bulkheadSignal }) => {
          this.prepareRateLimitProbe(runtime);
          return runtime.circuitPolicy.execute(
            async ({ signal: circuitSignal }) => {
              try {
                return await this.invokeOperation(
                  runtime,
                  operation,
                  circuitSignal,
                );
              } catch (error) {
                if (circuitSignal.aborted && !isCancellation(error)) {
                  throw createCancellationError(error);
                }
                throw error;
              }
            },
            bulkheadSignal,
          );
        },
        signal,
      );

      if (this.isCurrent(runtime)) {
        runtime.circuitOpenCount = 0;
        runtime.circuitBlockedUntil = null;
        this.updateHealth(providerKey, {
          status: 'healthy',
          consecutiveFailures: 0,
          blockedUntil: null,
          lastErrorCode: null,
        });
      }
      return result;
    } catch (error) {
      if (!this.isCurrent(runtime) || signal?.aborted || isCancellation(error)) {
        throw error;
      }
      if (error instanceof ProviderCooldownError) throw error;

      if (
        isSourceFailure(error) &&
        runtime.circuitPolicy.state !== CircuitState.Open &&
        runtime.circuitPolicy.state !== CircuitState.Isolated
      ) {
        const previous = this.snapshot[providerKey];
        this.updateHealth(providerKey, {
          status: 'degraded',
          consecutiveFailures: previous.consecutiveFailures + 1,
          blockedUntil: null,
          lastErrorCode: healthErrorCode(error),
        });
      }
      throw error;
    }
  }

  getSnapshot(): ProviderHealthSnapshot {
    return this.snapshot;
  }

  subscribe(listener: ProviderHealthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.active = false;
      for (const subscription of runtime.subscriptions) subscription.dispose();
      runtime.isolation?.dispose();
    }
    this.generation += 1;
    this.runtimes = new Map();
    this.snapshot = initialSnapshot(Date.now());
    this.createRuntimes();
    this.emitSnapshot();
  }

  private createRuntimes(): void {
    for (const providerKey of PROVIDER_KEYS) {
      this.runtimes.set(providerKey, this.createRuntime(providerKey));
    }
  }

  private createRuntime(providerKey: ImageProviderKey): ProviderRuntime {
    const sourceFailurePolicy = handleWhen(isSourceFailure);
    const circuitPolicy = circuitBreaker(sourceFailurePolicy, {
      breaker: new ConsecutiveBreaker(this.options.failureThreshold),
      halfOpenAfter: new ExponentialBackoff<number>({
        generator: noJitterGenerator,
        initialDelay: this.options.circuitCooldownMs,
        maxDelay: this.options.maxCircuitCooldownMs,
      }),
    });
    const runtime: ProviderRuntime = {
      providerKey,
      generation: this.generation,
      bulkheadPolicy: bulkhead(
        concurrencyFor(providerKey),
        this.options.queueCapacity,
      ),
      circuitPolicy,
      subscriptions: [],
      active: true,
      releasingIsolation: false,
      circuitOpenCount: 0,
      circuitBlockedUntil: null,
      pendingCircuitErrorCode: null,
      rateLimitBlockedUntil: null,
      isolation: null,
    };
    runtime.subscriptions.push(circuitPolicy.onBreak((reason) => {
      if ('error' in reason) {
        runtime.pendingCircuitErrorCode = healthErrorCode(reason.error);
      }
    }));
    runtime.subscriptions.push(circuitPolicy.onStateChange((state) => {
      this.handleCircuitState(runtime, state);
    }));
    return runtime;
  }

  private async invokeOperation<T>(
    runtime: ProviderRuntime,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await operation(signal);
    } catch (error) {
      if (signal.aborted) throw createCancellationError(error);
      if (!isRateLimited(error)) throw error;
      if (!this.isCurrent(runtime)) throw error;

      const delay = retryAfterMs(error) ?? this.options.rateLimitCooldownMs;
      runtime.rateLimitBlockedUntil = Date.now() + delay;
      if (runtime.isolation === null) {
        runtime.isolation = runtime.circuitPolicy.isolate();
      } else {
        this.updateHealth(runtime.providerKey, {
          status: 'cooldown',
          blockedUntil: runtime.rateLimitBlockedUntil,
          lastErrorCode: 'rate_limited',
        });
      }
      throw new ProviderCooldownError(runtime.providerKey, delay, { cause: error });
    }
  }

  private prepareRateLimitProbe(runtime: ProviderRuntime): void {
    const blockedUntil = runtime.rateLimitBlockedUntil;
    if (blockedUntil === null) return;

    const now = Date.now();
    if (now < blockedUntil) {
      throw new ProviderCooldownError(runtime.providerKey, blockedUntil - now);
    }

    runtime.rateLimitBlockedUntil = null;
    runtime.releasingIsolation = true;
    runtime.isolation?.dispose();
    runtime.isolation = null;
    runtime.releasingIsolation = false;
    this.updateHealth(runtime.providerKey, {
      status: 'probing',
      blockedUntil: null,
    });
  }

  private handleCircuitState(
    runtime: ProviderRuntime,
    state: CircuitState,
  ): void {
    if (!this.isCurrent(runtime)) return;
    const providerKey = runtime.providerKey;

    if (state === CircuitState.Open) {
      runtime.circuitOpenCount += 1;
      const delay = Math.min(
        this.options.maxCircuitCooldownMs,
        this.options.circuitCooldownMs * 2 ** (runtime.circuitOpenCount - 1),
      );
      runtime.circuitBlockedUntil = Date.now() + delay;
      this.updateHealth(providerKey, {
        status: 'cooldown',
        consecutiveFailures: Math.max(
          this.snapshot[providerKey].consecutiveFailures,
          this.options.failureThreshold,
        ),
        blockedUntil: runtime.circuitBlockedUntil,
        lastErrorCode: runtime.pendingCircuitErrorCode ??
          this.snapshot[providerKey].lastErrorCode,
      });
      runtime.pendingCircuitErrorCode = null;
      return;
    }

    if (state === CircuitState.HalfOpen) {
      this.updateHealth(providerKey, {
        status: 'probing',
        blockedUntil: null,
      });
      return;
    }

    if (state === CircuitState.Isolated) {
      this.updateHealth(providerKey, {
        status: 'cooldown',
        blockedUntil: runtime.rateLimitBlockedUntil,
        lastErrorCode: 'rate_limited',
      });
      return;
    }

    runtime.circuitBlockedUntil = null;
    runtime.circuitOpenCount = 0;
    runtime.pendingCircuitErrorCode = null;
    if (!runtime.releasingIsolation) {
      this.updateHealth(providerKey, {
        status: 'healthy',
        consecutiveFailures: 0,
        blockedUntil: null,
        lastErrorCode: null,
      });
    }
  }

  private isCurrent(runtime: ProviderRuntime): boolean {
    return runtime.active &&
      runtime.generation === this.generation &&
      this.runtimes.get(runtime.providerKey) === runtime;
  }

  private updateHealth(
    providerKey: ImageProviderKey,
    changes: Partial<Omit<ProviderHealthEntry, 'providerKey' | 'updatedAt'>>,
  ): void {
    const previous = this.snapshot[providerKey];
    const values = { ...previous, ...changes };
    if (
      values.status === previous.status &&
      values.consecutiveFailures === previous.consecutiveFailures &&
      values.blockedUntil === previous.blockedUntil &&
      values.lastErrorCode === previous.lastErrorCode
    ) {
      return;
    }

    const nextEntry = Object.freeze({
      ...values,
      providerKey,
      updatedAt: Date.now(),
    });
    this.snapshot = Object.freeze({
      ...this.snapshot,
      [providerKey]: nextEntry,
    });
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch {
        // A diagnostics listener must not affect provider execution.
      }
    }
  }
}

export function createProviderRequestGovernor(
  options: ProviderRequestGovernorOptions = {},
): ProviderRequestGovernor {
  return new DefaultProviderRequestGovernor(options);
}
