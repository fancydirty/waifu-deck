import type { PutOptions } from '@/features/byos/s3-transport';
import { S3TransportError } from '@/features/byos/s3-transport-types';

import type { LibraryAssetStateRecord } from './library-asset-state-codec';
import { encodeAssetState } from './library-asset-state-codec';
import { LibraryCloudError } from './library-cloud-errors';
import {
  buildNextRecord,
  createS3LibraryCloudClient,
  groupConsecutiveByAsset,
  rebaseWithinGroup,
  type S3LibraryPendingMutation,
  type S3LibraryTransportPort,
  toNarrowAsset,
} from './library-cloud-client-s3';
import { decideLibraryMutation } from './library-mutation-decision';
import { createLibraryTransferProgress } from './library-transfer-progress';

// --- fake transport -------------------------------------------------------
// Mirrors the real `createS3Transport` putObject/getObject contract (see
// src/features/byos/s3-transport.ts): putObject throws S3TransportError on a
// failed conditional write, getObject returns null on a missing key.

type FakeCall =
  | Readonly<{ op: 'get'; key: string }>
  | Readonly<{ op: 'put'; key: string; options: PutOptions; body: Uint8Array }>;

function createFakeTransport() {
  const store = new Map<string, { body: Uint8Array; etag: string }>();
  const calls: FakeCall[] = [];
  const conflictBudget = new Map<string, number>();
  let etagSeq = 0;

  function seed(key: string, body: Uint8Array): void {
    etagSeq += 1;
    store.set(key, { body, etag: `e${etagSeq}` });
  }

  /** The next `times` putObject calls to `key` throw a 412 precondition error. */
  function scheduleConflicts(key: string, times: number): void {
    conflictBudget.set(key, times);
  }

  const transport: S3LibraryTransportPort = {
    async putObject(key, body, options) {
      calls.push({ op: 'put', key, options, body });
      const budget = conflictBudget.get(key) ?? 0;
      if (budget > 0) {
        conflictBudget.set(key, budget - 1);
        etagSeq += 1;
        // Simulate a concurrent writer racing ahead of us: the object's
        // ETag has moved on by the time our conditional PUT is evaluated.
        const current = store.get(key);
        if (current) store.set(key, { body: current.body, etag: `e${etagSeq}` });
        throw new S3TransportError(
          412,
          'precondition',
          `simulated conflict on ${key}`,
          true,
        );
      }
      if (options.ifNoneMatch === '*' && store.has(key)) {
        throw new S3TransportError(
          412,
          'precondition',
          `already exists: ${key}`,
          true,
        );
      }
      if (options.ifMatch !== undefined) {
        const current = store.get(key);
        if (current === undefined || current.etag !== options.ifMatch) {
          throw new S3TransportError(
            412,
            'precondition',
            `etag mismatch: ${key}`,
            true,
          );
        }
      }
      etagSeq += 1;
      const etag = `e${etagSeq}`;
      store.set(key, { body, etag });
      return { etag };
    },
    async getObject(key) {
      calls.push({ op: 'get', key });
      const current = store.get(key);
      return current === undefined ? null : { body: current.body, etag: current.etag };
    },
  };

  return { transport, store, calls, seed, scheduleConflicts };
}

const FIXED_NOW = '2026-08-28T00:00:00.000Z';

/**
 * Drains the microtask queue without touching timers, so a test can observe
 * exactly where an async path has parked itself.
 */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function assetRecord(
  over: Partial<LibraryAssetStateRecord> = {},
): LibraryAssetStateRecord {
  return {
    assetId: 'a1',
    revision: 3,
    generation: 1,
    lifecycle: 'active',
    protection: 'unprotected',
    lastMutationId: null,
    trashedAt: null,
    generations: {},
    ...over,
  };
}

function pendingMutation(
  over: Partial<S3LibraryPendingMutation> = {},
): S3LibraryPendingMutation {
  return {
    mutationId: 'm1',
    assetId: 'a1',
    kind: 'collect',
    baseRevision: 3,
    observedGeneration: 1,
    originalGenerationId: null,
    newBlob: null,
    ...over,
  };
}

const PREFIX = 'p/';
const STATE_KEY = 'p/assets/a1/state.json';

describe('createS3LibraryCloudClient submitMutations', () => {
  it('creates a new asset with If-None-Match when no state.json exists', async () => {
    const { transport, calls } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [pendingMutation({ kind: 'collect', baseRevision: null, observedGeneration: null })],
    });

    expect(result.cursor).toBe(0);
    expect(result.minBaseCursor).toBe(0);
    expect(result.results).toEqual([
      {
        mutationId: 'm1',
        assetId: 'a1',
        kind: 'collect',
        outcome: 'applied',
        reason: null,
        revision: 1,
        asset: {
          assetId: 'a1',
          revision: 1,
          generation: 1,
          lifecycle: 'active',
          protection: 'unprotected',
          lastMutationId: 'm1',
          trashedAt: null,
          generations: {},
        },
      },
    ]);

    const stateWrites = calls.filter(
      (c): c is Extract<FakeCall, { op: 'put' }> => c.op === 'put' && c.key === STATE_KEY,
    );
    expect(stateWrites).toHaveLength(1);
    expect(stateWrites[0].options).toEqual({ ifNoneMatch: '*' });
    expect(stateWrites[0].options.ifMatch).toBeUndefined();
  });

  /**
   * K7 ⑭ (audit `docs/superpowers/research/2026-09-14-k7-first-principles-audit.md`):
   * a 412 means the OTHER writer's PUT already completed — its new ETag is
   * readable right now. The 200/400/800/1600 ms sleep this client used to take
   * between attempts is a multi-tenant congestion manoeuvre against a bucket
   * that belongs to the user alone, and it sat on the save path (the
   * believed-new fast path takes a 412 by design whenever a second device, or
   * a reinstall, meets an asset the bucket already holds).
   *
   * Fake timers make the deletion provable rather than asserted-by-comment:
   * a client that sleeps has a pending timer at the moment of the re-GET, and
   * `jest.getTimerCount()` sees it.
   */
  it('re-reads immediately after a 412 — no timer is ever scheduled', async () => {
    jest.useFakeTimers();
    try {
      const { transport, calls, seed, scheduleConflicts } = createFakeTransport();
      seed(STATE_KEY, encodeAssetState(assetRecord()));
      scheduleConflicts(STATE_KEY, 1);

      const client = createS3LibraryCloudClient({
        transport,
        prefix: PREFIX,
        decide: decideLibraryMutation,
        now: () => FIXED_NOW,
      });

      const pending = client.submitMutations({
        mutations: [
          pendingMutation({ kind: 'trash', baseRevision: 3, observedGeneration: null }),
        ],
      });
      // Every microtask the CAS loop can make is settled here. A client that
      // backs off is parked on a timer at this point; one that re-reads
      // immediately has already finished.
      await flushMicrotasks();
      expect(jest.getTimerCount()).toBe(0);

      // Belt and braces: if a timer HAD been scheduled, run it so the assertion
      // above is the failure rather than a suite-wide timeout.
      await jest.runAllTimersAsync();
      const result = await pending;

      expect(result.results[0]?.outcome).toBe('applied');
      const stateGets = calls.filter((c) => c.op === 'get' && c.key === STATE_KEY);
      expect(stateGets).toHaveLength(2); // initial read + immediate re-read
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries after a 412 precondition conflict and succeeds once re-read', async () => {
    const { transport, store, calls, seed, scheduleConflicts } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord()));
    scheduleConflicts(STATE_KEY, 1);

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'trash',
          baseRevision: 3,
          observedGeneration: null,
        }),
      ],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'trash',
      outcome: 'applied',
      reason: null,
      revision: 4,
      asset: {
        assetId: 'a1',
        revision: 4,
        generation: 1,
        lifecycle: 'trash',
        protection: 'unprotected',
        lastMutationId: 'm1',
        trashedAt: FIXED_NOW,
        generations: {},
      },
    });

    const stateGets = calls.filter((c) => c.op === 'get' && c.key === STATE_KEY);
    expect(stateGets).toHaveLength(2); // initial read + retry re-read
    expect(store.get(STATE_KEY)?.body).toEqual(
      encodeAssetState({
        assetId: 'a1',
        revision: 4,
        generation: 1,
        lifecycle: 'trash',
        protection: 'unprotected',
        lastMutationId: 'm1',
        trashedAt: FIXED_NOW,
        generations: {},
      }),
    );
  });

  it('gives up after 5 attempts and resolves as rejected instead of throwing', async () => {
    const { transport, calls, seed, scheduleConflicts } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord()));
    scheduleConflicts(STATE_KEY, 100); // always conflicts

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({ kind: 'trash', baseRevision: 3, observedGeneration: null }),
      ],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'trash',
      outcome: 'rejected',
      reason: 'resync_required',
      revision: null,
      asset: null,
    });

    const stateGets = calls.filter((c) => c.op === 'get' && c.key === STATE_KEY);
    // K7 ⑭: five attempts, five reads, and nothing in between them. The
    // bound is what keeps a genuinely contended asset from spinning; the
    // deleted sleep never was.
    expect(stateGets).toHaveLength(5);
  });

  it('writes nothing when the decision is rejected', async () => {
    const { transport, calls, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord({ lifecycle: 'trash' })));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [pendingMutation({ kind: 'collect' })],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'collect',
      outcome: 'rejected',
      reason: 'trash_wins',
      revision: 3,
      asset: assetRecord({ lifecycle: 'trash' }),
    });
    expect(calls.some((c) => c.op === 'put')).toBe(false);
  });

  it('writes nothing when the decision is merged', async () => {
    const { transport, calls, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord()));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [pendingMutation({ kind: 'collect' })],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'collect',
      outcome: 'merged',
      reason: null,
      revision: 3,
      asset: assetRecord(),
    });
    expect(calls.some((c) => c.op === 'put')).toBe(false);
  });

  it('PUTs the content blob before reading or writing state.json', async () => {
    const { transport, calls } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
          newBlob: { generationId: 'g1', bytes },
        }),
      ],
    });

    expect(calls[0]).toEqual({ op: 'put', key: 'p/blobs/g1', options: {}, body: bytes });
    // K6-1c: this collect states no base and no observed generation, so the
    // state.json write goes out optimistically and the second call is that PUT,
    // not a read. The invariant this test exists for is unchanged: nothing
    // touches state.json until the blob it will reference is durable.
    expect(calls[1]).toMatchObject({
      op: 'put',
      key: STATE_KEY,
      options: { ifNoneMatch: '*' },
    });
    const blobPutIndex = calls.findIndex((c) => c.op === 'put' && c.key === 'p/blobs/g1');
    const stateTouchIndex = calls.findIndex((c) => c.key === STATE_KEY);
    expect(blobPutIndex).toBeLessThan(stateTouchIndex);
  });

  it('runs multiple mutations sequentially and keys results by mutationId', async () => {
    const { transport } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm1',
          assetId: 'a1',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
        pendingMutation({
          mutationId: 'm2',
          assetId: 'a2',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
      ],
    });

    expect(result.results.map((r) => r.mutationId)).toEqual(['m1', 'm2']);
    expect(result.results.every((r) => r.outcome === 'applied')).toBe(true);
  });

  it('preserves existing generations when a mutation adds a new blob under a different role, and persists lastMutationId', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(assetRecord({ generations: { thumbnail: 'g-thumb' } })),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const bytes = new Uint8Array([4, 5, 6]);
    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'protect',
          baseRevision: 3,
          observedGeneration: 1,
          originalGenerationId: 'g-orig',
          newBlob: { generationId: 'g-orig', bytes, role: 'original' },
        }),
      ],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'protect',
      outcome: 'applied',
      reason: null,
      revision: 4,
      asset: {
        assetId: 'a1',
        revision: 4,
        generation: 1,
        lifecycle: 'active',
        protection: 'protected',
        lastMutationId: 'm1',
        trashedAt: null,
        generations: { thumbnail: 'g-thumb', original: 'g-orig' },
      },
    });
  });

  it('a restore mutation clears trashedAt', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(
        assetRecord({ lifecycle: 'trash', trashedAt: '2026-08-01T00:00:00.000Z' }),
      ),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({ kind: 'restore', baseRevision: 3, observedGeneration: 1 }),
      ],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'restore',
      outcome: 'applied',
      reason: null,
      revision: 4,
      asset: {
        assetId: 'a1',
        revision: 4,
        generation: 2,
        lifecycle: 'active',
        protection: 'unprotected',
        lastMutationId: 'm1',
        trashedAt: null,
        generations: {},
      },
    });
  });
  it('a permanent-delete mutation writes a tombstone that discards generations', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(
        assetRecord({
          lifecycle: 'trash',
          generations: { thumbnail: 'g-t', original: 'g-o' },
          trashedAt: '2026-08-01T00:00:00.000Z',
        }),
      ),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'permanent-delete',
          baseRevision: 3,
          observedGeneration: 1,
        }),
      ],
    });

    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'permanent-delete',
      outcome: 'applied',
      reason: null,
      revision: 4,
      asset: {
        assetId: 'a1',
        revision: 4,
        generation: 1,
        lifecycle: 'purged',
        protection: 'unprotected',
        lastMutationId: 'm1',
        trashedAt: '2026-08-01T00:00:00.000Z',
        generations: {},
      },
    });
  });
});

describe('createS3LibraryCloudClient submitMutations meta (carried field)', () => {
  const SEALED_META_1 = 'V0RMSUIwMDE.sealed-metadata-envelope-one';
  const SEALED_META_2 = 'V0RMSUIwMDE.sealed-metadata-envelope-two';

  it('round-trips an explicit meta supplied on collect into the result asset', async () => {
    const { transport } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
          meta: SEALED_META_1,
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.meta).toBe(SEALED_META_1);
  });

  it('carries meta forward, preserved, across a trash mutation that supplies none, and it survives a subsequent restore', async () => {
    const { transport, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord({ meta: SEALED_META_1 })));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const trashed = await client.submitMutations({
      mutations: [
        pendingMutation({ kind: 'trash', baseRevision: 3, observedGeneration: null }),
      ],
    });
    expect(trashed.results[0].outcome).toBe('applied');
    // The trash mutation carried no `meta` of its own — the existing sealed
    // envelope must be preserved, never null-erased.
    expect(trashed.results[0].asset?.meta).toBe(SEALED_META_1);

    const restored = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm2',
          kind: 'restore',
          baseRevision: trashed.results[0].revision ?? undefined,
          observedGeneration: trashed.results[0].asset?.generation ?? null,
        }),
      ],
    });
    expect(restored.results[0].outcome).toBe('applied');
    // trash -> restore must not have lost the sealed metadata along the way:
    // this is the exact bug that motivates the "carried field" merge rule
    // (second device otherwise never materializes the asset again).
    expect(restored.results[0].asset?.meta).toBe(SEALED_META_1);
  });

  it('an explicit meta on the mutation overrides the existing carried value', async () => {
    const { transport, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord({ meta: SEALED_META_1 })));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'protect',
          baseRevision: 3,
          observedGeneration: 1,
          originalGenerationId: 'g-orig',
          meta: SEALED_META_2,
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.meta).toBe(SEALED_META_2);
  });

  it('a permanent-delete tombstone strips meta, even when the mutation supplies one', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(
        assetRecord({
          lifecycle: 'trash',
          meta: SEALED_META_1,
          trashedAt: '2026-08-01T00:00:00.000Z',
        }),
      ),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'permanent-delete',
          baseRevision: 3,
          observedGeneration: 1,
          // Even if a caller mistakenly supplied a meta on a permanent-delete,
          // the tombstone carve-out must still strip it — mirrors the
          // `generations` purge carve-out.
          meta: SEALED_META_2,
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.meta).toBeUndefined();
  });

  it('absence: a mutation with no meta against an asset with no existing meta stays absent', async () => {
    const { transport, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord()));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({ kind: 'trash', baseRevision: 3, observedGeneration: null }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.meta).toBeUndefined();
  });
});

describe('createS3LibraryCloudClient submitMutations batch isolation', () => {
  it('isolates a corrupt remote state.json to that mutation, letting the rest of the batch proceed', async () => {
    const { transport, seed } = createFakeTransport();
    // Present but undecodable — triggers AssetStateCorruptionError, not "not found".
    seed('p/assets/a1/state.json', new TextEncoder().encode('not json{'));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm1',
          assetId: 'a1',
          kind: 'trash',
          baseRevision: 3,
          observedGeneration: null,
        }),
        pendingMutation({
          mutationId: 'm2',
          assetId: 'a2',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
      ],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      mutationId: 'm1',
      assetId: 'a1',
      kind: 'trash',
      outcome: 'rejected',
      reason: 'corrupt_remote_state',
      revision: null,
      asset: null,
    });
    expect(result.results[1].outcome).toBe('applied');
    expect(result.results[1].mutationId).toBe('m2');
  });
});

describe('createS3LibraryCloudClient submitMutations error propagation', () => {
  it('propagates a non-corruption transport error out of submitMutations instead of resolving a rejected result', async () => {
    const failingTransport: S3LibraryTransportPort = {
      async putObject() {
        throw new Error('should not be reached for a get-first mutation');
      },
      async getObject() {
        throw new S3TransportError(500, 'server', 'simulated server error', true);
      },
    };

    const client = createS3LibraryCloudClient({
      transport: failingTransport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    await expect(
      client.submitMutations({
        mutations: [
          // K6-1c: a mutation that STATES a base is not the optimistic
          // "I believe this asset is new" shape, so this still exercises the
          // get-first path the fake's putObject guard describes.
          pendingMutation({
            kind: 'collect',
            baseRevision: 3,
            observedGeneration: null,
          }),
        ],
      }),
    ).rejects.toThrow('simulated server error');
  });
});

describe('createS3LibraryCloudClient getObject', () => {
  it('passes through to the transport blob GET, returning bytes or null', async () => {
    const { transport, seed } = createFakeTransport();
    const bytes = new Uint8Array([9, 8, 7]);
    seed('p/blobs/g1', bytes);

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    expect(await client.getObject('g1')).toEqual(bytes);
    expect(await client.getObject('missing')).toBeNull();
  });
});

describe('createS3LibraryCloudClient putBlob', () => {
  it('writes the blob key with an unconditional PUT (no ifMatch/ifNoneMatch)', async () => {
    const { transport, calls } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await client.putBlob('g-standalone', bytes);

    expect(calls).toEqual([
      { op: 'put', key: 'p/blobs/g-standalone', options: {}, body: bytes },
    ]);
  });
});

describe('createS3LibraryCloudClient S3TransportError bridging', () => {
  // Root cause F7: writeBlob/getObject/submitMutations forwarded the raw
  // S3TransportError, so protect's categoryFor fell through to
  // `retryable_transfer` — a slow handshake looked like a failure and the
  // upload was re-derived and re-sent. Bridging every escaping S3TransportError
  // through toLibraryCloudError gives the caller the honest category (a network
  // wobble is `offline`, handled by the queue path, not a re-upload storm).
  const networkError = () =>
    new S3TransportError(0, 'network', 'connection reset', false);

  it('putBlob throws a LibraryCloudError(offline) when the transport reports network trouble', async () => {
    const transport: S3LibraryTransportPort = {
      async putObject() { throw networkError(); },
      async getObject() { return null; },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
    });

    const caught = await client.putBlob('g1', new Uint8Array([1])).catch((e) => e);
    expect(caught).toBeInstanceOf(LibraryCloudError);
    expect(caught.category).toBe('offline');
    // A network cut leaves the outcome unknown, so durable intent is kept.
    expect(caught.outcomeKnown).toBe(false);
  });

  it('getObject throws a LibraryCloudError(offline) when the transport reports network trouble', async () => {
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: null }; },
      async getObject() { throw networkError(); },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
    });

    const caught = await client.getObject('g1').catch((e) => e);
    expect(caught).toBeInstanceOf(LibraryCloudError);
    expect(caught.category).toBe('offline');
  });

  it('submitMutations throws a LibraryCloudError(offline) when a network read escapes', async () => {
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: null }; },
      async getObject() { throw networkError(); },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
    });

    const caught = await client.submitMutations({
      // K6-1c: states a base, so the group reads before it writes and the
      // failing read is the one under test.
      mutations: [pendingMutation({ kind: 'collect', baseRevision: 3, observedGeneration: null })],
    }).catch((e) => e);
    expect(caught).toBeInstanceOf(LibraryCloudError);
    expect(caught.category).toBe('offline');
  });

  it('leaves a non-transport error (corruption is handled elsewhere) unwrapped', async () => {
    // A plain Error is not an S3TransportError, so the bridge must not touch it.
    const boom = new Error('not a transport error');
    const transport: S3LibraryTransportPort = {
      async putObject() { throw boom; },
      async getObject() { return null; },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
    });

    const caught = await client.putBlob('g1', new Uint8Array([1])).catch((e) => e);
    expect(caught).toBe(boom);
  });
});

describe('createS3LibraryCloudClient submitMutations generationsPatch', () => {
  it('merges generationsPatch into the next record, preserving existing roles the patch does not mention', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(assetRecord({ generations: { original: 'g-orig' } })),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'protect',
          baseRevision: 3,
          observedGeneration: 1,
          originalGenerationId: 'g-orig',
          generationsPatch: { thumbnail: 'g-thumb-new', preview: 'g-preview-new' },
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.generations).toEqual({
      original: 'g-orig',
      thumbnail: 'g-thumb-new',
      preview: 'g-preview-new',
    });
  });

  it('applies both a newBlob merge and a generationsPatch, with the patch winning on a same-role conflict', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(assetRecord({ generations: { preview: 'g-preview-old' } })),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const bytes = new Uint8Array([4, 5, 6]);
    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'protect',
          baseRevision: 3,
          observedGeneration: 1,
          originalGenerationId: 'g-orig',
          newBlob: { generationId: 'g-orig-from-blob', bytes, role: 'original' },
          generationsPatch: { original: 'g-orig-from-patch', thumbnail: 'g-thumb' },
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    // Patch wins on 'original' (the same role newBlob also touched);
    // 'thumbnail' from the patch applies untouched; 'preview' is preserved
    // from the existing record, which neither newBlob nor the patch mention.
    expect(result.results[0].asset?.generations).toEqual({
      preview: 'g-preview-old',
      original: 'g-orig-from-patch',
      thumbnail: 'g-thumb',
    });
  });

  it('treats an explicit undefined value in generationsPatch as no-op, not as erasing an existing role', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(assetRecord({ generations: { original: 'g-o' } })),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'protect',
          baseRevision: 3,
          observedGeneration: 1,
          originalGenerationId: 'g-o',
          // `original: undefined` is legal under this tsconfig (no
          // exactOptionalPropertyTypes) and must NOT overwrite the
          // existing 'original' role with undefined — JSON.stringify would
          // then silently drop the key, erasing the blob reference.
          generationsPatch: { original: undefined, thumbnail: 'g-t' },
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.generations).toEqual({
      original: 'g-o',
      thumbnail: 'g-t',
    });
  });

  it('still empties generations on a permanent-delete tombstone even when a generationsPatch is supplied', async () => {
    const { transport, seed } = createFakeTransport();
    seed(
      STATE_KEY,
      encodeAssetState(
        assetRecord({
          lifecycle: 'trash',
          generations: { thumbnail: 'g-t', original: 'g-o' },
          trashedAt: '2026-08-01T00:00:00.000Z',
        }),
      ),
    );

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'permanent-delete',
          baseRevision: 3,
          observedGeneration: 1,
          generationsPatch: { thumbnail: 'should-be-ignored' },
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('applied');
    expect(result.results[0].asset?.generations).toEqual({});
  });

  it('ignores generationsPatch when the decision is rejected or merged, writing no state', async () => {
    const { transport, calls, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord()));

    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          kind: 'collect',
          generationsPatch: { thumbnail: 'should-not-be-written' },
        }),
      ],
    });

    expect(result.results[0].outcome).toBe('merged');
    expect(result.results[0].asset).toEqual(assetRecord());
    expect(calls.some((c) => c.op === 'put')).toBe(false);
  });
});

// K6-1b: a new asset's collect and protect are submitted in ONE batch, so the
// per-image cost on a real link drops from two state.json round trips (GET+PUT,
// GET+PUT) to one (GET+PUT). Consecutive mutations for the same asset share a
// single GET, roll the record forward in memory through the pure decision
// table, and write once — which must stay observably identical to submitting
// them one after another (spec §2 five-second bar, §4.5 reachability).
describe('createS3LibraryCloudClient submitMutations same-asset grouping', () => {
  const stateGets = (calls: readonly FakeCall[]): readonly FakeCall[] =>
    calls.filter((call) => call.op === 'get' && call.key === STATE_KEY);
  const statePuts = (
    calls: readonly FakeCall[],
  ): readonly Extract<FakeCall, { op: 'put' }>[] =>
    calls.filter(
      (call): call is Extract<FakeCall, { op: 'put' }> =>
        call.op === 'put' && call.key === STATE_KEY,
    );

  it('collapses a collect+protect batch for one asset into one CAS PUT', async () => {
    const { transport, calls } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm-collect',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
          meta: 'sealed-meta',
        }),
        pendingMutation({
          mutationId: 'm-protect',
          kind: 'protect',
          baseRevision: null,
          observedGeneration: null,
          originalGenerationId: 'g-orig',
          generationsPatch: { original: 'g-orig', thumbnail: 'g-thumb' },
        }),
      ],
    });

    expect(stateGets(calls)).toHaveLength(0); // K6-1c: believed-new, written optimistically
    expect(statePuts(calls)).toHaveLength(1);
    expect(statePuts(calls)[0].options).toEqual({ ifNoneMatch: '*' });
    expect(result.results.map((entry) => [entry.mutationId, entry.outcome])).toEqual([
      ['m-collect', 'applied'],
      ['m-protect', 'applied'],
    ]);
    // Equivalent to submitting the two one by one: the collect's own result is
    // the intermediate record it would have written alone...
    expect(result.results[0].asset).toEqual({
      assetId: 'a1',
      revision: 1,
      generation: 1,
      lifecycle: 'active',
      protection: 'unprotected',
      lastMutationId: 'm-collect',
      trashedAt: null,
      generations: {},
      meta: 'sealed-meta',
    });
    // ...and the single object actually written is the protect's final record.
    expect(result.results[1].asset).toEqual({
      assetId: 'a1',
      revision: 2,
      generation: 1,
      lifecycle: 'active',
      protection: 'protected',
      lastMutationId: 'm-protect',
      trashedAt: null,
      generations: { original: 'g-orig', thumbnail: 'g-thumb' },
      meta: 'sealed-meta',
    });
    expect(statePuts(calls)[0].body).toEqual(
      encodeAssetState(result.results[1].asset!),
    );
  });

  it('merges a repeated collect inside the group without a second PUT', async () => {
    const { transport, calls } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm1',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
        pendingMutation({
          mutationId: 'm2',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
      ],
    });

    expect(stateGets(calls)).toHaveLength(0); // K6-1c: believed-new, written optimistically
    expect(statePuts(calls)).toHaveLength(1);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      'applied',
      'merged',
    ]);
    expect(result.results[1].revision).toBe(1);
  });

  it('replays the whole group against the re-read record after a CAS conflict', async () => {
    const { transport, calls, scheduleConflicts } = createFakeTransport();
    scheduleConflicts(STATE_KEY, 1);
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm-collect',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
        pendingMutation({
          mutationId: 'm-protect',
          kind: 'protect',
          baseRevision: null,
          observedGeneration: null,
          originalGenerationId: 'g-orig',
          generationsPatch: { original: 'g-orig' },
        }),
      ],
    });

    // Both decisions are replayed, not just the last one. K6-1c: attempt 1 is
    // the optimistic write (no read), the scheduled conflict rejects it, so the
    // replay is the only read — one GET, two PUTs, and the same final record.
    expect(stateGets(calls)).toHaveLength(1);
    expect(statePuts(calls)).toHaveLength(2);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      'applied',
      'applied',
    ]);
    expect(result.results[1].asset?.revision).toBe(2);
    expect(result.results[1].asset?.protection).toBe('protected');
  });

  it('still lets another device trash win over a grouped collect+protect, writing nothing', async () => {
    const { transport, calls, store, seed } = createFakeTransport();
    const trashed = assetRecord({
      lifecycle: 'trash',
      trashedAt: '2026-08-01T00:00:00.000Z',
    });
    seed(STATE_KEY, encodeAssetState(trashed));
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({
          mutationId: 'm-collect',
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
        }),
        pendingMutation({
          mutationId: 'm-protect',
          kind: 'protect',
          baseRevision: null,
          observedGeneration: null,
          originalGenerationId: 'g-orig',
        }),
      ],
    });

    expect(result.results.map((entry) => [entry.outcome, entry.reason])).toEqual([
      ['rejected', 'trash_wins'],
      ['rejected', 'trash_wins'],
    ]);
    // K6-1c: the caller believed this asset was new, so attempt 1 wrote
    // optimistically — and `If-None-Match: '*'` is exactly what stops a stale
    // belief from clobbering the other device's trash. The bucket refused it,
    // attempt 2 read the truth, and nothing was written: the trashed object is
    // byte-for-byte what it was.
    expect(statePuts(calls).map((put) => put.options)).toEqual([{ ifNoneMatch: '*' }]);
    expect(store.get(STATE_KEY)?.body).toEqual(encodeAssetState(trashed));
  });

  it('isolates a corrupt state.json to the whole group of that asset only', async () => {
    const { transport, seed } = createFakeTransport();
    seed(STATE_KEY, new TextEncoder().encode('not json{'));
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
    });

    const result = await client.submitMutations({
      mutations: [
        pendingMutation({ mutationId: 'm1', assetId: 'a1', kind: 'collect', baseRevision: null, observedGeneration: null }),
        pendingMutation({ mutationId: 'm2', assetId: 'a1', kind: 'protect', baseRevision: null, observedGeneration: null, originalGenerationId: 'g' }),
        pendingMutation({ mutationId: 'm3', assetId: 'a2', kind: 'collect', baseRevision: null, observedGeneration: null }),
      ],
    });

    expect(result.results.map((entry) => [entry.mutationId, entry.outcome, entry.reason])).toEqual([
      ['m1', 'rejected', 'corrupt_remote_state'],
      ['m2', 'rejected', 'corrupt_remote_state'],
      ['m3', 'applied', null],
    ]);
  });
});

describe('createS3LibraryCloudClient submitMutations optimistic first write', () => {
  const stateGets = (calls: readonly FakeCall[]): readonly FakeCall[] =>
    calls.filter((call) => call.op === 'get' && call.key === STATE_KEY);
  const statePuts = (
    calls: readonly FakeCall[],
  ): readonly Extract<FakeCall, { op: 'put' }>[] =>
    calls.filter(
      (call): call is Extract<FakeCall, { op: 'put' }> =>
        call.op === 'put' && call.key === STATE_KEY,
    );

  const freshGroup = (): S3LibraryPendingMutation[] => [
    pendingMutation({
      mutationId: 'm-collect',
      kind: 'collect',
      baseRevision: null,
      observedGeneration: null,
      meta: 'sealed-meta',
    }),
    pendingMutation({
      mutationId: 'm-protect',
      kind: 'protect',
      baseRevision: null,
      observedGeneration: null,
      originalGenerationId: 'g-orig',
      generationsPatch: { original: 'g-orig' },
    }),
  ];

  it('skips the state.json GET for an asset the caller believes is new', async () => {
    // K6-1c (spec §2's five-second bar, §4.5: ~1.5 s per round trip warm).
    // A leading `collect` with no `baseRevision` and no `observedGeneration`
    // IS the caller saying "I believe this object does not exist". Asking the
    // bucket to confirm that costs a full round trip and buys nothing: the
    // answer the GET would give (`null`) is already the assumption, and if the
    // assumption is wrong the conditional PUT below catches it. So the write
    // goes out first, `If-None-Match: '*'`, and a new save pays two sequential
    // stages (parallel blobs, then one PUT) instead of three.
    const { transport, calls, store } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({ mutations: freshGroup() });

    expect(stateGets(calls)).toHaveLength(0);
    expect(statePuts(calls)).toHaveLength(1);
    expect(statePuts(calls)[0].options).toEqual({ ifNoneMatch: '*' });
    expect(result.results.map((entry) => [entry.mutationId, entry.outcome])).toEqual([
      ['m-collect', 'applied'],
      ['m-protect', 'applied'],
    ]);
    // Identical bytes to the GET-first path: one object, the protect's final
    // record, carrying the collect's sealed meta and the protect's generation.
    expect(store.get(STATE_KEY)?.body).toEqual(
      encodeAssetState({
        assetId: 'a1',
        revision: 2,
        generation: 1,
        lifecycle: 'active',
        protection: 'protected',
        lastMutationId: 'm-protect',
        trashedAt: null,
        generations: { original: 'g-orig' },
        meta: 'sealed-meta',
      }),
    );
  });

  it('falls back to read-and-replay when the optimistic write hits an existing object', async () => {
    // The assumption can be wrong — another device collected this asset first.
    // `If-None-Match: '*'` is what makes being wrong safe: the bucket refuses
    // with a 412 (it never overwrites), and this is the same precondition
    // failure the CAS loop already knows how to handle, so attempt 2 re-GETs,
    // replays the WHOLE group against the real record, and writes `If-Match`.
    // Nothing about the outcome changes — only that the common case stopped
    // paying for the rare one.
    const { transport, calls, store, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord()));
    const seededEtag = store.get(STATE_KEY)!.etag;
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      now: () => FIXED_NOW,
    });

    const result = await client.submitMutations({ mutations: freshGroup() });

    // One refused optimistic PUT, then exactly the round trip the old path
    // would have made: read, decide, conditional write.
    expect(statePuts(calls).map((put) => put.options)).toEqual([
      { ifNoneMatch: '*' },
      { ifMatch: seededEtag },
    ]);
    expect(stateGets(calls)).toHaveLength(1);
    // Decided against the record that really exists: the collect merges into
    // it rather than re-creating it, and the protect applies on top.
    expect(result.results.map((entry) => [entry.mutationId, entry.outcome])).toEqual([
      ['m-collect', 'merged'],
      ['m-protect', 'applied'],
    ]);
    expect(store.get(STATE_KEY)?.body).toEqual(
      encodeAssetState({
        assetId: 'a1',
        revision: 4,
        generation: 1,
        lifecycle: 'active',
        protection: 'protected',
        lastMutationId: 'm-protect',
        trashedAt: null,
        generations: { original: 'g-orig' },
      }),
    );
  });
});

// --- K6-2: blob writes go through a file so the upload reports real bytes ---

type StagedFile = Readonly<{ uri: string; bytes: Uint8Array }>;

/**
 * The narrow slice of `LibraryFilePort` the client needs to stage a blob.
 * Records every write/delete in order so the temp file's lifetime is testable.
 */
function createFakeStaging() {
  const files = new Map<string, Uint8Array>();
  const events: string[] = [];
  const port = {
    resolveTemp: (name: string) => `file:///tmp/${name}`,
    async writeBytes(uri: string, bytes: Uint8Array) {
      files.set(uri, bytes);
      events.push(`write:${uri}`);
    },
    async delete(uri: string) {
      files.delete(uri);
      events.push(`delete:${uri}`);
    },
  };
  return { port, files, events };
}

/** Transport fake that can also serve the file-upload path. */
function createUploadingTransport(
  files: Map<string, Uint8Array>,
  behaviour: {
    fail?: () => never;
    progress?: readonly { sent: number; total: number }[];
  } = {},
) {
  const uploads: { key: string; fileUri: string; body: Uint8Array | undefined; contentSha256: string }[] = [];
  const memoryPuts: { key: string; body: Uint8Array }[] = [];
  const transport: S3LibraryTransportPort = {
    async putObject(key, body) {
      memoryPuts.push({ key, body });
      return { etag: 'e1' };
    },
    async getObject() { return null; },
    async hashPayload(bytes) {
      return `sha-of-${Array.from(bytes).join('.')}`;
    },
    async putObjectFromFile(key, fileUri, options) {
      uploads.push({ key, fileUri, body: files.get(fileUri), contentSha256: options.contentSha256 });
      for (const event of behaviour.progress ?? []) options.onProgress?.(event);
      if (behaviour.fail) behaviour.fail();
      return { etag: 'e-file' };
    },
  };
  return { transport, uploads, memoryPuts };
}

describe('createS3LibraryCloudClient putBlob uploads from a staged file', () => {
  it('stages the ciphertext, uploads from that file, and deletes it', async () => {
    const staging = createFakeStaging();
    const { transport, uploads, memoryPuts } = createUploadingTransport(staging.files);
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging.port,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await client.putBlob('g-standalone', bytes);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.key).toBe('p/blobs/g-standalone');
    // Byte identity: the file the upload task read holds exactly the ciphertext
    // the in-memory path would have PUT, and the signature covers that hash.
    expect(uploads[0]!.body).toEqual(bytes);
    expect(uploads[0]!.contentSha256).toBe('sha-of-1.2.3');
    // Not both paths: one PUT per blob, as before.
    expect(memoryPuts).toEqual([]);
    // Written before the upload, deleted after it.
    expect(staging.events).toEqual([
      `write:${uploads[0]!.fileUri}`,
      `delete:${uploads[0]!.fileUri}`,
    ]);
    expect(staging.files.size).toBe(0);
  });

  it('deletes the staged file even when the upload fails', async () => {
    const staging = createFakeStaging();
    const { transport } = createUploadingTransport(staging.files, {
      fail: () => { throw new S3TransportError(0, 'network', 'reset', false); },
    });
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging.port,
    });

    await expect(client.putBlob('g1', new Uint8Array([9]))).rejects.toBeInstanceOf(
      LibraryCloudError,
    );
    expect(staging.events.filter((e) => e.startsWith('delete:'))).toHaveLength(1);
    expect(staging.files.size).toBe(0);
  });

  it('bridges an upload transport error to a LibraryCloudError, as the memory path does', async () => {
    const staging = createFakeStaging();
    const { transport } = createUploadingTransport(staging.files, {
      fail: () => { throw new S3TransportError(0, 'network', 'reset', false); },
    });
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging.port,
    });

    const caught = await client.putBlob('g1', new Uint8Array([9])).catch((e) => e);
    expect(caught).toBeInstanceOf(LibraryCloudError);
    expect(caught.category).toBe('offline');
    expect(caught.outcomeKnown).toBe(false);
  });

  it('forwards the upload’s byte reports to the caller unchanged', async () => {
    const staging = createFakeStaging();
    const { transport } = createUploadingTransport(staging.files, {
      progress: [{ sent: 0, total: 3 }, { sent: 3, total: 3 }],
    });
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging.port,
    });

    const seen: { sent: number; total: number }[] = [];
    await client.putBlob('g1', new Uint8Array([1, 2, 3]), (p) => seen.push(p));
    expect(seen).toEqual([{ sent: 0, total: 3 }, { sent: 3, total: 3 }]);
  });

  it('gives every generation its own staging file so parallel role uploads cannot collide', async () => {
    const staging = createFakeStaging();
    const { transport, uploads } = createUploadingTransport(staging.files);
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging.port,
    });

    await Promise.all([
      client.putBlob('g-thumb', new Uint8Array([1])),
      client.putBlob('g-prev', new Uint8Array([2])),
      client.putBlob('g-orig', new Uint8Array([3])),
    ]);
    const uris = uploads.map((u) => u.fileUri);
    expect(new Set(uris).size).toBe(3);
  });

  it('routes a submitMutations newBlob through the same file path — one write path', async () => {
    const staging = createFakeStaging();
    const { transport, uploads } = createUploadingTransport(staging.files);
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging.port,
    });

    await client.submitMutations({
      mutations: [pendingMutation({
        kind: 'collect', baseRevision: null, observedGeneration: null,
        newBlob: { generationId: 'g-new', bytes: new Uint8Array([7, 7]) },
      })],
    });

    expect(uploads.map((u) => u.key)).toEqual(['p/blobs/g-new']);
    expect(uploads[0]!.body).toEqual(new Uint8Array([7, 7]));
  });

  it('falls back to the in-memory PUT when no staging port is configured', async () => {
    const { transport, calls } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await client.putBlob('g-standalone', bytes);
    expect(calls).toEqual([
      { op: 'put', key: 'p/blobs/g-standalone', options: {}, body: bytes },
    ]);
  });
});

describe('createS3LibraryCloudClient getObject reports download bytes', () => {
  function downloadingTransport(
    chunks: readonly { sent: number; total: number }[],
    outcome: 'ok' | 'missing' | 'fail' = 'ok',
  ) {
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: null }; },
      async getObject(_key, options) {
        for (const chunk of chunks) options?.onProgress?.(chunk);
        if (outcome === 'fail') {
          throw new S3TransportError(0, 'network', 'reset', false);
        }
        if (outcome === 'missing') return null;
        return { body: new Uint8Array([1, 2, 3]), etag: 'e1' };
      },
    };
    return transport;
  }

  it('publishes the bytes arriving, keyed by the generation being fetched', async () => {
    const store = createLibraryTransferProgress();
    const seen: ({ sent: number; total: number | null } | null)[] = [];
    store.subscribe('g-orig', () => seen.push(store.get('g-orig')));
    const client = createS3LibraryCloudClient({
      transport: downloadingTransport([{ sent: 4, total: 10 }, { sent: 10, total: 10 }]),
      prefix: PREFIX, decide: decideLibraryMutation, transferProgress: store,
    });

    await client.getObject('g-orig');
    expect(seen).toEqual([
      { sent: 4, total: 10 },
      { sent: 10, total: 10 },
      null,
    ]);
    // Cleared once the bytes are in hand: the tile goes back to what the
    // database says about the asset.
    expect(store.get('g-orig')).toBeNull();
  });

  it('clears the ring when the download fails', async () => {
    const store = createLibraryTransferProgress();
    const client = createS3LibraryCloudClient({
      transport: downloadingTransport([{ sent: 4, total: 10 }], 'fail'),
      prefix: PREFIX, decide: decideLibraryMutation, transferProgress: store,
    });

    await expect(client.getObject('g-orig')).rejects.toBeInstanceOf(LibraryCloudError);
    expect(store.get('g-orig')).toBeNull();
  });

  it('clears the ring when the object is not there at all', async () => {
    const store = createLibraryTransferProgress();
    const client = createS3LibraryCloudClient({
      transport: downloadingTransport([], 'missing'),
      prefix: PREFIX, decide: decideLibraryMutation, transferProgress: store,
    });

    await expect(client.getObject('g-orig')).resolves.toBeNull();
    expect(store.get('g-orig')).toBeNull();
  });

  it('leaves other generations alone — one ring per object in flight', async () => {
    const store = createLibraryTransferProgress();
    store.set('g-other', { sent: 1, total: 2 });
    const client = createS3LibraryCloudClient({
      transport: downloadingTransport([{ sent: 1, total: 3 }]),
      prefix: PREFIX, decide: decideLibraryMutation, transferProgress: store,
    });

    await client.getObject('g-orig');
    expect(store.get('g-other')).toEqual({ sent: 1, total: 2 });
  });

  it('a state.json read is never a ring — only content-addressed blobs are', async () => {
    const store = createLibraryTransferProgress();
    const keys: string[] = [];
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: 'e1' }; },
      async getObject(key, options) {
        keys.push(key);
        options?.onProgress?.({ sent: 5, total: 5 });
        return null;
      },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation, transferProgress: store,
    });

    await client.submitMutations({
      mutations: [pendingMutation({ kind: 'collect', baseRevision: 3, observedGeneration: null })],
    });
    expect(keys).toContain(STATE_KEY);
    expect(store.get(STATE_KEY)).toBeNull();
    expect(store.get('a1')).toBeNull();
  });
});

describe('createS3LibraryCloudClient getObjectToFile', () => {
  const filePort = (writes: Uint8Array[] = []) => ({
    resolveTemp: (name: string) => `file:///tmp/${name}`,
    async writeBytes(_uri: string, bytes: Uint8Array) { writes.push(bytes); },
    async delete(_uri: string) {},
  });

  it('publishes streamed progress by generation and clears it after success', async () => {
    const store = createLibraryTransferProgress();
    const seen: ({ sent: number; total: number | null } | null)[] = [];
    store.subscribe('g-file', () => seen.push(store.get('g-file')));
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: null }; },
      async getObject() { return null; },
      async getObjectToFile(_key, _uri, options) {
        options?.onProgress?.({ sent: 3, total: null });
        return { etag: 'e-file', bytesWritten: 3 };
      },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation, transferProgress: store,
    });

    await expect(client.getObjectToFile('g-file', 'file:///tmp/g-file'))
      .resolves.toEqual({ etag: 'e-file' });
    expect(seen).toEqual([
      { sent: 0, total: null },
      { sent: 3, total: null },
      null,
    ]);
  });

  it('falls back to getObject plus the file port when no download port exists', async () => {
    const writes: Uint8Array[] = [];
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: null }; },
      async getObject() { return { body: new Uint8Array([4, 5]), etag: 'e-memory' }; },
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation, blobStaging: filePort(writes),
    });

    await expect(client.getObjectToFile('g-memory', 'file:///tmp/g-memory'))
      .resolves.toEqual({ etag: 'e-memory' });
    expect(writes).toEqual([new Uint8Array([4, 5])]);
  });

  it('maps a local write failure to local_space and clears progress', async () => {
    const store = createLibraryTransferProgress();
    const staging = filePort();
    staging.writeBytes = async () => { throw new Error('disk full'); };
    const transport: S3LibraryTransportPort = {
      async putObject() { return { etag: null }; },
      async getObject() { return { body: new Uint8Array([1]), etag: 'e' }; },
      downloadFileAvailable: false,
    };
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      blobStaging: staging, transferProgress: store,
    });

    await expect(client.getObjectToFile('g-full', 'file:///tmp/g-full')).rejects.toMatchObject({
      name: 'LibraryCloudError', code: 's3_local_write', category: 'local_space',
    });
    expect(store.get('g-full')).toBeNull();
  });
});

/**
 * K7 cut 3 / audit item ⑪. A successful CAS PUT knows three things the change
 * -discovery index wants: the key it wrote, the ETag the write returned, and
 * the record it wrote. Handing them over is what lets the engine's post-drain
 * `converge()` — and the next cycle's discovery — recognise this device's own
 * write instead of paying a round trip to be told what it just said.
 */
describe('createS3LibraryCloudClient remote-state index write-back', () => {
  type Remembered = { key: string; etag: string; record: LibraryAssetStateRecord };

  const recording = () => {
    const remembered: Remembered[] = [];
    return {
      remembered,
      index: {
        remember: async (
          key: string,
          etag: string,
          record: LibraryAssetStateRecord,
        ) => { remembered.push({ key, etag, record }); },
      },
    };
  };

  it('records the key, the returned ETag, and the record it wrote', async () => {
    const { transport, store } = createFakeTransport();
    const recorder = recording();
    const client = createS3LibraryCloudClient({
      transport,
      prefix: PREFIX,
      decide: decideLibraryMutation,
      rememberState: recorder.index.remember,
    });

    await client.submitMutations({
      mutations: [pendingMutation({
        kind: 'collect', baseRevision: null, observedGeneration: null,
      })],
    });

    expect(recorder.remembered).toHaveLength(1);
    const entry = recorder.remembered[0]!;
    expect(entry.key).toBe(STATE_KEY);
    const landed = store.get(STATE_KEY)!;
    // The ETag must be the one the write returned, and the record must encode
    // to exactly the bytes that landed: an index entry that disagreed with the
    // object would be served as a cache hit and silently diverge the device.
    expect(entry.etag).toBe(landed.etag);
    expect(Array.from(encodeAssetState(entry.record)))
      .toEqual(Array.from(landed.body));
  });

  it('records nothing when the group applied nothing', async () => {
    const { transport, seed } = createFakeTransport();
    seed(STATE_KEY, encodeAssetState(assetRecord({ lifecycle: 'trash' })));
    const recorder = recording();
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      rememberState: recorder.index.remember,
    });

    // A collect against a trashed asset is rejected (`trash_wins`): nothing is
    // written, so there is nothing to remember and the index entry the last
    // discovery pass recorded for this key must stand untouched.
    const response = await client.submitMutations({
      mutations: [pendingMutation({ kind: 'collect' })],
    });
    expect(response.results[0]!.outcome).toBe('rejected');
    expect(recorder.remembered).toEqual([]);
  });

  it('records nothing when the transport returns no ETag for the write', async () => {
    const transport: S3LibraryTransportPort = {
      // A backend that omits the header proves nothing about freshness.
      async putObject() { return { etag: null }; },
      async getObject() { return null; },
    };
    const recorder = recording();
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      rememberState: recorder.index.remember,
    });

    await client.submitMutations({
      mutations: [pendingMutation({
        kind: 'collect', baseRevision: null, observedGeneration: null,
      })],
    });

    expect(recorder.remembered).toEqual([]);
  });

  it('does not fail a committed write when the index rejects', async () => {
    const { transport } = createFakeTransport();
    const client = createS3LibraryCloudClient({
      transport, prefix: PREFIX, decide: decideLibraryMutation,
      rememberState: async () => { throw new Error('disk full'); },
    });

    // The bytes are durable on the bucket; a bookkeeping failure must not turn
    // a successful mutation into a halted cycle. The next pass re-reads.
    const response = await client.submitMutations({
      mutations: [pendingMutation({
        kind: 'collect', baseRevision: null, observedGeneration: null,
      })],
    });
    expect(response.results[0]!.outcome).toBe('applied');
  });
});

describe('board #12 — decision helpers are shared with protocol v2', () => {
  test('the four helpers are exported and pure', () => {
    expect(typeof toNarrowAsset).toBe('function');
    expect(typeof buildNextRecord).toBe('function');
    expect(typeof groupConsecutiveByAsset).toBe('function');
    expect(typeof rebaseWithinGroup).toBe('function');
    expect(toNarrowAsset(null)).toBeNull();
    expect(groupConsecutiveByAsset([])).toEqual([]);
  });
});
