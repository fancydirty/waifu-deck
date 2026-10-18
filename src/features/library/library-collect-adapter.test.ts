/**
 * This suite drives `library-ingest`, whose plaintext digest is `expo-crypto`'s
 * native `digest` (K6-1f). Under `jest-expo` the unmocked native module answers
 * it with a 32-byte ZERO buffer, so two different images would share one id and
 * one durable file name; map `expo-crypto` onto the double's genuine SHA-256.
 */
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createLibraryCollectAdapter,
  LIBRARY_INGEST_CONCURRENCY,
} from '@/features/library/library-collect-adapter';
import {
  createLibraryIngestService,
  type LibraryAccountPort,
  type LibraryIngestService,
} from '@/features/library/library-ingest';
import {
  deriveLibraryAccountScope,
} from '@/features/library/library-identity';
import {
  createLibraryTestHarness,
  JPEG_FIXTURE,
  LOCAL_ONLY_ACCOUNT_PORT,
  NOT_AN_IMAGE_FIXTURE,
  PNG_FIXTURE,
  type LibraryTestHarness,
} from '@/features/library/library-test-support';

type LibraryIngestOutcome = Awaited<ReturnType<LibraryIngestService['ingestUri']>>;

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A `LibraryIngestService` whose `ingestUri` never settles on its own: each
 * call records the `sourceImageId` and hands back a manually-controlled gate,
 * so a test can prove exactly how many ingests are allowed to run at once.
 */
function createControllableIngest() {
  const calls: (number | null)[] = [];
  const gates: Deferred[] = [];
  const ingest = {
    ingestUri: (input: { sourceImageId?: number | null }) => {
      calls.push(input.sourceImageId ?? null);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
  } as unknown as LibraryIngestService;
  return { ingest, calls, gates };
}

/** Drain the microtask queue (and any queued 0ms timers). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function ingestFor(
  harness: LibraryTestHarness,
  account: LibraryAccountPort = harness.signedInAccount,
) {
  return createLibraryIngestService({
    files: harness.files,
    repository: harness.repository,
    decodeGate: harness.decodeGate,
    account,
    newMutationId: harness.newMutationId,
    clock: harness.clock,
  });
}

describe('library collect adapter', () => {
  test('ingests a downloaded original from its final collection uri', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const adapter = createLibraryCollectAdapter({ ingest: ingestFor(harness) });
      harness.port.files.set('file:///collection/17.jpg', JPEG_FIXTURE);

      adapter.onOriginalReady({
        imageId: 17,
        localUri: 'file:///collection/17.jpg',
      });
      await adapter.drain();

      const assets = await harness.repository.listLocalAssets();
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({
        origin: 'provider',
        sourceImageId: 17,
        format: 'jpeg',
      });
      // The Alpha collection file is copied, never moved away.
      expect(await harness.port.exists('file:///collection/17.jpg')).toBe(true);
      const scope = deriveLibraryAccountScope(harness.masterKey);
      await expect(harness.repository.listOutbox(scope)).resolves.toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  test('processes concurrent notifications with per-item failure isolation', async () => {
    const harness = await createLibraryTestHarness();
    const failures: { imageId: number; code: string }[] = [];
    try {
      const adapter = createLibraryCollectAdapter({
        ingest: ingestFor(harness),
        onFailure: (event, error) => {
          failures.push({
            imageId: event.imageId,
            code: (error as { code?: string }).code ?? 'unknown',
          });
        },
      });

      harness.port.files.set('file:///collection/1.jpg', JPEG_FIXTURE);
      harness.port.files.set('file:///collection/2.png', PNG_FIXTURE);
      harness.port.files.set('file:///collection/3.jpg', NOT_AN_IMAGE_FIXTURE);

      adapter.onOriginalReady({ imageId: 1, localUri: 'file:///collection/1.jpg' });
      adapter.onOriginalReady({ imageId: 2, localUri: 'file:///collection/2.png' });
      adapter.onOriginalReady({ imageId: 3, localUri: 'file:///collection/3.jpg' });
      await adapter.drain();

      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(2);
      expect(failures).toEqual([{ imageId: 3, code: 'unsupported_format' }]);
    } finally {
      harness.close();
    }
  });

  test('collects into the local library with no account and reports no failure', async () => {
    const harness = await createLibraryTestHarness();
    const failures: string[] = [];
    try {
      // Exactly the Store build, and a signed-out Direct build.
      const adapter = createLibraryCollectAdapter({
        ingest: ingestFor(harness, LOCAL_ONLY_ACCOUNT_PORT),
        onFailure: (_event, error) => {
          failures.push((error as { code?: string }).code ?? 'unknown');
        },
      });
      harness.port.files.set('file:///collection/9.jpg', JPEG_FIXTURE);

      adapter.onOriginalReady({ imageId: 9, localUri: 'file:///collection/9.jpg' });
      await adapter.drain();

      expect(failures).toEqual([]);
      const assets = await harness.repository.listLocalAssets();
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({
        origin: 'provider',
        sourceImageId: 9,
        residency: 'local-original',
      });
      expect(await harness.port.exists(assets[0]!.localOriginalUri!)).toBe(true);
      await expect(
        harness.database.getAll<{ mutation_id: string }>(
          'SELECT mutation_id FROM library_outbox',
        ),
      ).resolves.toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('enrolls locally collected assets once the user signs in', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const offlineIngest = ingestFor(harness, LOCAL_ONLY_ACCOUNT_PORT);
      const adapter = createLibraryCollectAdapter({ ingest: offlineIngest });
      harness.port.files.set('file:///collection/11.jpg', JPEG_FIXTURE);
      adapter.onOriginalReady({
        imageId: 11,
        localUri: 'file:///collection/11.jpg',
      });
      await adapter.drain();

      const summary = await ingestFor(harness).enrichLocalAssetsForAccount();

      expect(summary).toEqual({
        enrolled: 1,
        alreadyEnrolled: 0,
        skipped: 0,
        failed: [],
      });
      const scope = deriveLibraryAccountScope(harness.masterKey);
      const outbox = await harness.repository.listOutbox(scope);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        kind: 'collect',
        deviceId: harness.deviceId,
      });
    } finally {
      harness.close();
    }
  });

  test('runs at most `concurrency` ingests at once and admits the next as one finishes', async () => {
    const { ingest, calls, gates } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest, concurrency: 3 });

    for (let imageId = 1; imageId <= 10; imageId += 1) {
      adapter.onOriginalReady({ imageId, localUri: `file:///c/${imageId}.jpg` });
    }
    await flushMicrotasks();

    // Bounded fan-out: exactly 3 lanes busy; the other 7 wait for a slot.
    expect(calls).toEqual([1, 2, 3]);

    // Freeing one lane admits exactly one more — a fan-out, never a burst.
    gates[0]!.resolve();
    await flushMicrotasks();
    expect(calls).toEqual([1, 2, 3, 4]);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await flushMicrotasks();
    expect(calls).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('merges a repeated imageId in flight instead of ingesting it twice', async () => {
    const { ingest, calls, gates } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest, concurrency: 3 });

    adapter.onOriginalReady({ imageId: 42, localUri: 'file:///c/42.jpg' });
    adapter.onOriginalReady({ imageId: 42, localUri: 'file:///c/42-again.jpg' });
    await flushMicrotasks();

    // The second push for an in-flight id merges; it does not re-ingest.
    expect(calls).toEqual([42]);

    gates[0]!.resolve();
    await adapter.drain();

    // Once it has settled, the same id is a genuine later collect again.
    adapter.onOriginalReady({ imageId: 42, localUri: 'file:///c/42.jpg' });
    await flushMicrotasks();
    expect(calls).toEqual([42, 42]);
  });

  test('drain resolves only after every queued ingest settles', async () => {
    const { ingest, gates } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest, concurrency: 2 });

    for (let imageId = 1; imageId <= 5; imageId += 1) {
      adapter.onOriginalReady({ imageId, localUri: `file:///c/${imageId}.jpg` });
    }

    let settled = false;
    const drainPromise = adapter.drain().then(() => {
      settled = true;
    });
    await flushMicrotasks();
    // 2 in flight + 3 queued: drain must still be pending.
    expect(settled).toBe(false);

    // Release gates as lanes free them (the array grows as the queue drains).
    for (let index = 0; index < gates.length; index += 1) {
      gates[index]!.resolve();
      await flushMicrotasks();
    }
    await drainPromise;
    expect(settled).toBe(true);
  });

  test('defaults to LIBRARY_INGEST_CONCURRENCY lanes', () => {
    expect(LIBRARY_INGEST_CONCURRENCY).toBe(6);
  });
});

/**
 * K6-5 C. `onFailure` defaulted to a no-op and nothing else observed the pool,
 * so an ingest that threw left the collection row `ready` with no library
 * asset, no badge, no retry — a blank tile, forever. Both outcomes now have to
 * be reportable, because the composition writes one column from each.
 */
describe('K6-5 C: every ingest reports its outcome', () => {
  test('reports the successful ingest so a recorded failure can be cleared', async () => {
    const harness = await createLibraryTestHarness();
    const succeeded: number[] = [];
    const failed: number[] = [];
    try {
      const adapter = createLibraryCollectAdapter({
        ingest: ingestFor(harness),
        onSuccess: (event) => {
          succeeded.push(event.imageId);
        },
        onFailure: (event) => {
          failed.push(event.imageId);
        },
      });
      harness.port.files.set('file:///collection/31.jpg', JPEG_FIXTURE);

      adapter.onOriginalReady({ imageId: 31, localUri: 'file:///collection/31.jpg' });
      await adapter.drain();

      expect(succeeded).toEqual([31]);
      expect(failed).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('reports a failure and nothing else when the ingest throws', async () => {
    const harness = await createLibraryTestHarness();
    const succeeded: number[] = [];
    const failed: { imageId: number; code: string }[] = [];
    try {
      const adapter = createLibraryCollectAdapter({
        ingest: ingestFor(harness),
        onSuccess: (event) => {
          succeeded.push(event.imageId);
        },
        onFailure: (event, error) => {
          failed.push({
            imageId: event.imageId,
            code: (error as { code?: string }).code ?? 'unknown',
          });
        },
      });
      harness.port.files.set('file:///collection/32.jpg', NOT_AN_IMAGE_FIXTURE);

      adapter.onOriginalReady({ imageId: 32, localUri: 'file:///collection/32.jpg' });
      await adapter.drain();

      expect(failed).toEqual([{ imageId: 32, code: 'unsupported_format' }]);
      expect(succeeded).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test("onSuccess receives the ingest's outcome", async () => {
    const outcome = {
      status: 'ingested',
      asset: { plaintextSha256: 'd' },
      enrollment: { status: 'skipped', reason: 'no_account' },
    } as unknown as LibraryIngestOutcome;
    const ingest = {
      ingestUri: async () => outcome,
    } as unknown as LibraryIngestService;
    const seen: unknown[][] = [];
    const adapter = createLibraryCollectAdapter({
      ingest,
      onSuccess: (...args) => {
        seen.push(args);
      },
    });
    const event = { imageId: 35, localUri: 'file:///collection/35.jpg' };

    adapter.onOriginalReady(event);
    await adapter.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual(event);
    expect(seen[0][1]).toBe(outcome);
  });

  test('a throwing success reporter cannot break the pool', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const adapter = createLibraryCollectAdapter({
        ingest: ingestFor(harness),
        onSuccess: () => {
          throw new Error('reporting failed');
        },
      });
      harness.port.files.set('file:///collection/33.jpg', JPEG_FIXTURE);
      harness.port.files.set('file:///collection/34.png', PNG_FIXTURE);

      adapter.onOriginalReady({ imageId: 33, localUri: 'file:///collection/33.jpg' });
      adapter.onOriginalReady({ imageId: 34, localUri: 'file:///collection/34.png' });
      await adapter.drain();

      await expect(harness.repository.listLocalAssets()).resolves.toHaveLength(2);
    } finally {
      harness.close();
    }
  });
});


/**
 * Board #24 (spec §5.4.2 step 1): the library's removal of a rewound save
 * waits until nothing is queued or running for that image, so an ingest that
 * was already under way commits first and is purged next instead of landing
 * after the purge and leaving the copy behind.
 */
describe('board #24: settled(imageId)', () => {
  test('resolves at once when nothing is queued or running for the id', async () => {
    const { ingest } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest });

    await expect(adapter.settled(7)).resolves.toBeUndefined();
  });

  test('waits for the running ingest of that id, and only that id', async () => {
    const { ingest, calls, gates } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest, concurrency: 3 });
    adapter.onOriginalReady({ imageId: 7, localUri: 'file:///c/7.jpg' });
    await flushMicrotasks();
    expect(calls).toEqual([7]);

    let settledSeven = false;
    const waiting = adapter.settled(7).then(() => {
      settledSeven = true;
    });
    // Another image never waits behind this one.
    await expect(adapter.settled(8)).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(settledSeven).toBe(false);

    gates[0]!.resolve();
    await waiting;
    expect(settledSeven).toBe(true);
  });

  test('an event queued behind full lanes keeps settled pending until it has run', async () => {
    const { ingest, calls, gates } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest, concurrency: 1 });
    adapter.onOriginalReady({ imageId: 6, localUri: 'file:///c/6.jpg' });
    adapter.onOriginalReady({ imageId: 7, localUri: 'file:///c/7.jpg' });
    await flushMicrotasks();
    expect(calls).toEqual([6]);

    let settledSeven = false;
    const waiting = adapter.settled(7).then(() => {
      settledSeven = true;
    });
    gates[0]!.resolve();
    await flushMicrotasks();
    // 7 got the lane and is running now: still not settled.
    expect(calls).toEqual([6, 7]);
    expect(settledSeven).toBe(false);

    gates[1]!.resolve();
    await waiting;
    expect(settledSeven).toBe(true);
  });

  test('a failed ingest settles its id too', async () => {
    const harness = await createLibraryTestHarness();
    try {
      const adapter = createLibraryCollectAdapter({ ingest: ingestFor(harness) });
      harness.port.files.set('file:///collection/35.jpg', NOT_AN_IMAGE_FIXTURE);

      adapter.onOriginalReady({ imageId: 35, localUri: 'file:///collection/35.jpg' });

      await expect(adapter.settled(35)).resolves.toBeUndefined();
      await expect(harness.repository.listLocalAssets()).resolves.toEqual([]);
    } finally {
      harness.close();
    }
  });
});

// Board #27 S1b Task 8 (spec R26): a restore's hold stops new ingests.
describe('board #27 S1b T8: refuse()', () => {
  test('refuse drops new events until released; queued and running ones still finish', async () => {
    const { ingest, calls, gates } = createControllableIngest();
    const adapter = createLibraryCollectAdapter({ ingest, concurrency: 1 });
    const event = (imageId: number) => ({
      imageId,
      localUri: `file:///collection/${imageId}.jpg`,
    });

    adapter.onOriginalReady(event(1));
    adapter.onOriginalReady(event(2));
    const release = adapter.refuse();
    adapter.onOriginalReady(event(3));
    // Dropped: neither queued nor pending.
    await expect(adapter.settled(3)).resolves.toBeUndefined();

    gates[0]!.resolve();
    await flushMicrotasks();
    gates[1]!.resolve();
    await adapter.drain();
    expect(calls).toEqual([1, 2]);

    release();
    release();
    adapter.onOriginalReady(event(3));
    expect(calls).toEqual([1, 2, 3]);
    gates[2]!.resolve();
    await adapter.drain();

    const r1 = adapter.refuse();
    const r2 = adapter.refuse();
    r1();
    r1();
    adapter.onOriginalReady(event(4));
    expect(calls).toEqual([1, 2, 3]);
    r2();
    adapter.onOriginalReady(event(4));
    expect(calls).toEqual([1, 2, 3, 4]);
  });
});
