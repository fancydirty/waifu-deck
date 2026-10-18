import { isBrokenCircuitError, isBulkheadRejectedError } from 'cockatiel';

import type { ImageProviderKey } from '@/features/waifu/types';

import {
  ProviderCooldownError,
  createProviderRequestGovernor,
  type ProviderHealthSnapshot,
} from './provider-resilience';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function networkError(message = 'offline'): Error & { code: 'network' } {
  return Object.assign(new Error(message), { code: 'network' as const });
}

/**
 * K7 ⑱: evidence the HOST produced. `networkError` is evidence about OUR radio
 * and no longer counts against a source, so every circuit/health test below
 * drives the breaker with one of these instead.
 */
function serverError(status = 503): Error & { status: number } {
  return Object.assign(new Error(`server ${status}`), { status });
}

function rateLimitError(retryAfterMs: number): Error & {
  code: 'rate_limited';
  status: 429;
  retryAfterMs: number;
} {
  return Object.assign(new Error('too many requests'), {
    code: 'rate_limited' as const,
    status: 429 as const,
    retryAfterMs,
  });
}

function authError(): Error & { code: 'auth' } {
  return Object.assign(new Error('credential rejected'), { code: 'auth' as const });
}

function testGovernor(options: {
  queueCapacity?: number;
  circuitCooldownMs?: number;
} = {}) {
  return createProviderRequestGovernor({
    circuitCooldownMs: options.circuitCooldownMs ?? 1_000,
    maxCircuitCooldownMs: 8_000,
    queueCapacity: options.queueCapacity ?? 2,
  });
}

afterEach(() => {
  jest.useRealTimers();
});

// K7 ⑮ rewrote this from `waifu_im` to `e621`: the bounded-queue contract it
// guards is unchanged, but single-flight serialization is now only owed to the
// two sources with a published 2 req/s budget. `waifu_im` runs four abreast.
test('serializes the polite sources and rejects work beyond the bounded queue', async () => {
  const governor = testGovernor({ queueCapacity: 1 });
  const held = deferred<string>();
  const calls: string[] = [];

  const first = governor.execute('e621', async () => {
    calls.push('first:start');
    const value = await held.promise;
    calls.push('first:end');
    return value;
  });
  const secondOperation = jest.fn(async () => {
    calls.push('second');
    return 'second';
  });
  const second = governor.execute('e621', secondOperation);
  const overflow = governor.execute('e621', async () => 'overflow');

  await Promise.resolve();
  expect(calls).toEqual(['first:start']);
  expect(secondOperation).not.toHaveBeenCalled();
  const overflowError = await overflow.catch((error: unknown) => error);
  expect(isBulkheadRejectedError(overflowError)).toBe(true);

  held.resolve('first');
  await expect(first).resolves.toBe('first');
  await expect(second).resolves.toBe('second');
  expect(calls).toEqual(['first:start', 'first:end', 'second']);
});

test('keeps providers independent while one provider has an active batch', async () => {
  const governor = testGovernor();
  const held = deferred<string>();
  const waifu = governor.execute('waifu_im', async () => held.promise);
  const nekosOperation = jest.fn(async () => 'nekos-ready');

  await expect(governor.execute('nekos_api', nekosOperation))
    .resolves.toBe('nekos-ready');
  expect(nekosOperation).toHaveBeenCalledTimes(1);

  held.resolve('waifu-ready');
  await expect(waifu).resolves.toBe('waifu-ready');
});

test('accepts one full eight-candidate provider batch by default', async () => {
  const governor = createProviderRequestGovernor();
  const held = deferred<string>();
  const first = governor.execute('nekos_api', async () => held.promise);
  const queued = Array.from({ length: 7 }, (_, index) => (
    governor.execute('nekos_api', async () => `queued-${index}`)
  ));

  await Promise.resolve();
  held.resolve('first');

  await expect(first).resolves.toBe('first');
  await expect(Promise.all(queued)).resolves.toHaveLength(7);
});

test('does not hide extra request attempts behind the default governor', async () => {
  const governor = createProviderRequestGovernor();
  const operation = jest.fn(async () => {
    throw networkError();
  });

  await expect(governor.execute('waifu_im', operation))
    .rejects.toMatchObject({ code: 'network' });
  expect(operation).toHaveBeenCalledTimes(1);
});

// K7 ⑱ rewrote the three failures this drives the breaker with: they were
// `network`, 503, `timeout`, and two of those are now the phone's own radio.
test('moves from degraded to cooldown after three source failures', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(10_000);
  const governor = testGovernor();

  await expect(governor.execute('danbooru', async () => {
    throw serverError(500);
  })).rejects.toMatchObject({ status: 500 });
  expect(governor.getSnapshot().danbooru).toMatchObject({
    status: 'degraded',
    consecutiveFailures: 1,
    lastErrorCode: 'http_500',
  });

  await expect(governor.execute('danbooru', async () => {
    throw serverError(503);
  })).rejects.toMatchObject({ status: 503 });
  expect(governor.getSnapshot().danbooru).toMatchObject({
    status: 'degraded',
    consecutiveFailures: 2,
    lastErrorCode: 'http_503',
  });

  await expect(governor.execute('danbooru', async () => {
    throw Object.assign(new Error('bad json'), { code: 'invalid_response' });
  })).rejects.toMatchObject({ code: 'invalid_response' });
  expect(governor.getSnapshot().danbooru).toMatchObject({
    status: 'cooldown',
    consecutiveFailures: 3,
    blockedUntil: 11_000,
  });

  const operation = jest.fn(async () => 'not-called');
  const openError = await governor.execute('danbooru', operation)
    .catch((error: unknown) => error);
  expect(isBrokenCircuitError(openError)).toBe(true);
  expect(operation).not.toHaveBeenCalled();
});

test('probes and recovers after the circuit cooldown', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(20_000);
  const governor = testGovernor({ circuitCooldownMs: 1_000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await governor.execute('waifu_im', async () => {
      throw serverError();
    }).catch(() => undefined);
  }

  await jest.advanceTimersByTimeAsync(1_000);
  const probe = deferred<string>();
  const recovery = governor.execute('waifu_im', async () => probe.promise);

  expect(governor.getSnapshot().waifu_im.status).toBe('probing');
  probe.resolve('recovered');
  await expect(recovery).resolves.toBe('recovered');
  expect(governor.getSnapshot().waifu_im).toMatchObject({
    status: 'healthy',
    consecutiveFailures: 0,
    blockedUntil: null,
    lastErrorCode: null,
  });
});

test('isolates immediately on rate limits and fails fast until Retry-After expires', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(30_000);
  const governor = testGovernor();

  const firstError = await governor.execute('nekos_api', async () => {
    throw rateLimitError(5_000);
  }).catch((error: unknown) => error);
  expect(firstError).toBeInstanceOf(ProviderCooldownError);
  expect(firstError).toMatchObject({
    providerKey: 'nekos_api',
    code: 'rate_limited',
    retryAfterMs: 5_000,
  });
  expect(governor.getSnapshot().nekos_api).toMatchObject({
    status: 'cooldown',
    blockedUntil: 35_000,
    lastErrorCode: 'rate_limited',
  });

  const blockedOperation = jest.fn(async () => 'blocked');
  const blockedError = await governor.execute('nekos_api', blockedOperation)
    .catch((error: unknown) => error);
  expect(blockedError).toMatchObject({
    code: 'rate_limited',
    retryAfterMs: 5_000,
  });
  expect(blockedOperation).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(5_000);
  const probe = deferred<string>();
  const recovery = governor.execute('nekos_api', async () => probe.promise);
  expect(governor.getSnapshot().nekos_api.status).toBe('probing');
  probe.resolve('ready');
  await expect(recovery).resolves.toBe('ready');
  expect(governor.getSnapshot().nekos_api.status).toBe('healthy');
});

test('does not degrade health when an active request is aborted', async () => {
  const governor = testGovernor();
  await governor.execute('waifu_im', async () => {
    throw networkError();
  }).catch(() => undefined);
  const beforeAbort = governor.getSnapshot().waifu_im;
  const controller = new AbortController();

  const operation = governor.execute('waifu_im', (signal) => new Promise(
    (_resolve, reject) => signal.addEventListener('abort', () => reject(
      Object.assign(new Error('cancelled'), { code: 'aborted' }),
    ), { once: true }),
  ), controller.signal);
  controller.abort();

  await expect(operation).rejects.toMatchObject({ code: 'aborted' });
  expect(governor.getSnapshot().waifu_im).toMatchObject({
    status: beforeAbort.status,
    consecutiveFailures: beforeAbort.consecutiveFailures,
    lastErrorCode: beforeAbort.lastErrorCode,
  });
});

test('reset creates fresh idle policies and clears prior failures', async () => {
  const governor = testGovernor();
  await governor.execute('danbooru', async () => {
    throw serverError();
  }).catch(() => undefined);
  expect(governor.getSnapshot().danbooru.status).toBe('degraded');

  governor.reset();

  expect(governor.getSnapshot().danbooru).toMatchObject({
    status: 'idle',
    consecutiveFailures: 0,
    blockedUntil: null,
    lastErrorCode: null,
  });
  await expect(governor.execute('danbooru', async () => 'fresh'))
    .resolves.toBe('fresh');
  expect(governor.getSnapshot().danbooru.status).toBe('healthy');
});

test('publishes new immutable snapshots for health and circuit changes', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(40_000);
  const governor = testGovernor();
  const updates: ProviderHealthSnapshot[] = [];
  const unsubscribe = governor.subscribe((snapshot) => updates.push(snapshot));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await governor.execute('waifu_im', async () => {
      throw serverError();
    }).catch(() => undefined);
  }

  expect(updates.map((snapshot) => snapshot.waifu_im.status)).toEqual([
    'degraded',
    'degraded',
    'cooldown',
  ]);
  expect(new Set(updates).size).toBe(updates.length);
  for (const snapshot of updates) {
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.waifu_im)).toBe(true);
  }

  const updateCount = updates.length;
  unsubscribe();
  governor.reset();
  expect(updates).toHaveLength(updateCount);
});

test.each<ImageProviderKey>(['waifu_im', 'nekos_api', 'danbooru', 'safebooru'])(
  'starts %s with an immutable idle health entry',
  (providerKey) => {
    const snapshot = testGovernor().getSnapshot();
    expect(snapshot[providerKey]).toMatchObject({
      providerKey,
      status: 'idle',
      consecutiveFailures: 0,
      blockedUntil: null,
      lastErrorCode: null,
    });
    expect(Object.isFrozen(snapshot[providerKey])).toBe(true);
  },
);

test('K7 ⑮ runs a source batch concurrently instead of one request at a time', async () => {
  const governor = testGovernor({ queueCapacity: 8 });
  const held = deferred<string>();
  const started: number[] = [];

  const batch = Array.from({ length: 4 }, (_, index) => governor.execute(
    'danbooru',
    async () => {
      started.push(index);
      return held.promise;
    },
  ));

  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);

  held.resolve('done');
  await expect(Promise.all(batch)).resolves.toHaveLength(4);
});

test.each<ImageProviderKey>(['e621', 'e926'])(
  'K7 ⑮ keeps %s single-flight for its published 2 req/s budget',
  async (providerKey) => {
    const governor = testGovernor({ queueCapacity: 8 });
    const held = deferred<string>();
    const started: number[] = [];

    const batch = Array.from({ length: 2 }, (_, index) => governor.execute(
      providerKey,
      async () => {
        started.push(index);
        return held.promise;
      },
    ));

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0]);

    held.resolve('done');
    await expect(Promise.all(batch)).resolves.toHaveLength(2);
  },
);

test.each([
  ['network', networkError()],
  ['timeout', Object.assign(new Error('slow'), { code: 'timeout' as const })],
])(
  'K7 ⑱ keeps the circuit closed after three %s failures — that is our radio, not the source',
  async (_label, failure) => {
    jest.useFakeTimers();
    jest.setSystemTime(50_000);
    const governor = testGovernor();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await governor.execute('danbooru', async () => {
        throw failure;
      }).catch(() => undefined);
    }

    expect(governor.getSnapshot().danbooru).toMatchObject({
      status: 'idle',
      consecutiveFailures: 0,
      blockedUntil: null,
    });

    const operation = jest.fn(async () => 'reachable');
    await expect(governor.execute('danbooru', operation)).resolves.toBe('reachable');
    expect(operation).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ['http 500', Object.assign(new Error('server'), { status: 500 })],
  ['a parse failure', Object.assign(new Error('bad json'), { code: 'invalid_response' as const })],
])('K7 ⑱ opens the circuit after three of %s — that is the source', async (_label, failure) => {
  jest.useFakeTimers();
  jest.setSystemTime(60_000);
  const governor = testGovernor();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await governor.execute('safebooru', async () => {
      throw failure;
    }).catch(() => undefined);
  }

  expect(governor.getSnapshot().safebooru).toMatchObject({
    status: 'cooldown',
    consecutiveFailures: 3,
  });

  const operation = jest.fn(async () => 'not-called');
  const openError = await governor.execute('safebooru', operation)
    .catch((error: unknown) => error);
  expect(isBrokenCircuitError(openError)).toBe(true);
  expect(operation).not.toHaveBeenCalled();
});

test('an auth failure is recorded as lastErrorCode auth and counts toward the breaker', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(70_000);
  const governor = testGovernor();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await governor.execute('gelbooru', async () => {
      throw authError();
    }).catch(() => undefined);
  }

  expect(governor.getSnapshot().gelbooru).toMatchObject({
    status: 'cooldown',
    consecutiveFailures: 3,
    lastErrorCode: 'auth',
  });
});

test('a success after an auth failure clears it', async () => {
  const governor = testGovernor();

  await governor.execute('gelbooru', async () => {
    throw authError();
  }).catch(() => undefined);
  expect(governor.getSnapshot().gelbooru).toMatchObject({
    status: 'degraded',
    lastErrorCode: 'auth',
  });

  await expect(governor.execute('gelbooru', async () => 'recovered'))
    .resolves.toBe('recovered');
  expect(governor.getSnapshot().gelbooru).toMatchObject({
    status: 'healthy',
    consecutiveFailures: 0,
    lastErrorCode: null,
  });
});

test('K7 ㉒ a failing request is attempted exactly once — no retry layer', async () => {
  const governor = createProviderRequestGovernor();
  const serverFailure = jest.fn(async () => {
    throw serverError();
  });
  await expect(governor.execute('danbooru', serverFailure))
    .rejects.toMatchObject({ status: 503 });
  expect(serverFailure).toHaveBeenCalledTimes(1);

  const rateLimited = jest.fn(async () => {
    throw rateLimitError(1_000);
  });
  await expect(governor.execute('yandere', rateLimited))
    .rejects.toBeInstanceOf(ProviderCooldownError);
  expect(rateLimited).toHaveBeenCalledTimes(1);
});
