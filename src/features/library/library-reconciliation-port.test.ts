import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import type { SqlDatabasePort } from '@/db/sql-port';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

import type { LibraryAssetStateRecord } from './library-asset-state-codec';
import {
  bindLibraryRemoteStateIndex,
  createLibraryRemoteStateCacheRepository,
  type LibraryRemoteStateIndex,
} from './library-remote-state-cache';
import {
  createLibraryReconciliationPort,
  type LibraryReconciliationTransport,
} from './library-reconciliation-port';

const enc = new TextEncoder();
const SCOPE = 'scope-a';

function stateBody(
  over: Partial<LibraryAssetStateRecord> & { assetId: string; revision: number },
): Uint8Array {
  const record: LibraryAssetStateRecord = {
    assetId: over.assetId,
    revision: over.revision,
    generation: over.generation ?? 1,
    lifecycle: over.lifecycle ?? 'active',
    protection: over.protection ?? 'unprotected',
    lastMutationId: over.lastMutationId ?? null,
    trashedAt: over.trashedAt ?? null,
    generations: over.generations ?? {},
  };
  return enc.encode(
    JSON.stringify({
      // P3C-1: plaintext-structural stub state for the port test;
      // decryption is not this port's job. A stray protocolVersion field is
      // included to prove extra fields are still ignored.
      protocolVersion: 1,
      ...record,
    }),
  );
}

/** A real repository over an in-memory database: the production index at rest. */
function newIndex(): {
  native: DatabaseSync;
  database: SqlDatabasePort;
  index: LibraryRemoteStateIndex;
  ready: Promise<void>;
} {
  const native = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(native);
  const ready = migrateDatabase(database);
  const index = bindLibraryRemoteStateIndex(
    createLibraryRemoteStateCacheRepository({ database }),
    async () => SCOPE,
  );
  return { native, database, index, ready };
}

function fakeTransport(
  pages: { items: { key: string; etag: string }[]; next?: string }[],
  objects: Record<string, Uint8Array>,
): LibraryReconciliationTransport {
  let call = 0;
  return {
    async listObjects(_prefix: string, _token?: string) {
      const page = pages[call++] ?? { items: [] };
      return {
        objects: page.items.map((i) => ({ ...i, lastModified: '', size: 0 })),
        nextToken: page.next,
      };
    },
    async getObject(key: string) {
      const body = objects[key];
      return body ? { body, etag: `e-${key}` } : null;
    },
  };
}

describe('LibraryReconciliationPort', () => {
  let harness: ReturnType<typeof newIndex>;

  beforeEach(async () => {
    harness = newIndex();
    await harness.ready;
  });

  afterEach(() => {
    harness.native.close();
  });

  it('discovers every asset across pagination on a cold index', async () => {
    const t = fakeTransport(
      [
        { items: [{ key: 'p/assets/a1/state.json', etag: 'x' }], next: 'tok' },
        { items: [{ key: 'p/assets/a2/state.json', etag: 'y' }] },
      ],
      {
        'p/assets/a1/state.json': stateBody({ assetId: 'a1', revision: 2 }),
        'p/assets/a2/state.json': stateBody({ assetId: 'a2', revision: 5 }),
      },
    );
    const port = createLibraryReconciliationPort(t, 'p/', harness.index);
    const discovered = await port.discoverChanges();
    expect(discovered.changed.map((s) => s.assetId).sort()).toEqual(['a1', 'a2']);
    expect(discovered.total).toBe(2);
    expect(discovered.removedKeys).toEqual([]);
    expect(discovered.changed.find((s) => s.assetId === 'a2')?.revision).toBe(5);
  });

  it('getAssetState returns null for a missing asset', async () => {
    const t = fakeTransport([], {});
    const port = createLibraryReconciliationPort(t, 'p/', harness.index);
    expect(await port.getAssetState('nope')).toBeNull();
  });

  it('getAssetState returns the parsed full record, including generations, for an existing asset', async () => {
    const t = fakeTransport([], {
      'p/assets/a1/state.json': stateBody({
        assetId: 'a1',
        revision: 7,
        lastMutationId: 'm-9',
        trashedAt: null,
        generations: {
          thumbnail: 'gen-thumb',
          preview: 'gen-preview',
          original: 'gen-orig',
        },
      }),
    });
    const port = createLibraryReconciliationPort(t, 'p/', harness.index);
    const state = await port.getAssetState('a1');
    expect(state?.revision).toBe(7);
    expect(state?.lastMutationId).toBe('m-9');
    expect(state?.generations).toEqual({
      thumbnail: 'gen-thumb',
      preview: 'gen-preview',
      original: 'gen-orig',
    });
  });
});

/**
 * A transport that serves its listing from the same object map it serves GETs
 * from (so an ETag written into the map is the one the listing reports, as a
 * real backend does), counts both calls, records peak GET concurrency, and can
 * be told to list a key whose object is gone — the LIST/GET race.
 */
function countingTransport(
  objects: Map<string, { body: Uint8Array; etag: string }>,
  listingOnly: { key: string; etag: string }[] = [],
) {
  const counts = { lists: 0, gets: 0 };
  const gotKeys: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let failNext: Error | null = null;
  const transport: LibraryReconciliationTransport = {
    async listObjects(prefix: string, _token: string | undefined) {
      counts.lists += 1;
      const listed = [...objects.entries()]
        .map(([key, object]) => ({ key, etag: object.etag }))
        .concat(listingOnly)
        .filter((item) => item.key.startsWith(prefix))
        .map((item) => ({ ...item, lastModified: '', size: 0 }));
      return { objects: listed, nextToken: undefined };
    },
    async getObject(key: string) {
      counts.gets += 1;
      gotKeys.push(key);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // One macrotask of latency, so a serial loop can never look parallel:
        // with N lanes the peak in-flight count is N, with one lane it is 1.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (failNext !== null) {
          const error = failNext;
          failNext = null;
          throw error;
        }
        const object = objects.get(key);
        return object ? { body: object.body, etag: object.etag } : null;
      } finally {
        inFlight -= 1;
      }
    },
  };
  return {
    transport,
    counts,
    gotKeys,
    peak: () => maxInFlight,
    failNextGet(error: Error) { failNext = error; },
  };
}

/**
 * Wraps a real index so its very first `upsertMany` call rejects, then
 * behaves normally. Proves the port treats the durable index as the source of
 * truth: a rejected write must not leave the in-memory cache believing the
 * write happened, or the next pass in the same process would wrongly see the
 * key as unchanged and skip it — see the two "does not poison the cache"
 * tests below.
 */
function failFirstUpsert(inner: LibraryRemoteStateIndex): LibraryRemoteStateIndex {
  let failOnce = true;
  return {
    ...inner,
    async upsertMany(rows: Parameters<LibraryRemoteStateIndex['upsertMany']>[0]) {
      if (failOnce) {
        failOnce = false;
        throw new Error('disk full');
      }
      return inner.upsertMany(rows);
    },
  };
}

const stateKey = (assetId: string) => `p/assets/${assetId}/state.json`;

function seed(count: number): Map<string, { body: Uint8Array; etag: string }> {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  for (let i = 1; i <= count; i += 1) {
    const assetId = `a${i}`;
    objects.set(stateKey(assetId), {
      body: stateBody({ assetId, revision: 1 }),
      etag: `"etag-${assetId}-1"`,
    });
  }
  return objects;
}

const ids = (states: readonly LibraryAssetStateRecord[]) =>
  states.map((s) => s.assetId).sort();

/**
 * K7 cut 3. Change discovery is a full LIST whose per-key ETags are diffed
 * against a DURABLE index, only the differing keys are re-read (8 at a time),
 * and only those keys come back. A launch over an unchanged library is one
 * LIST and nothing else.
 */
describe('LibraryReconciliationPort durable ETag-incremental change discovery', () => {
  let harness: ReturnType<typeof newIndex>;

  beforeEach(async () => {
    harness = newIndex();
    await harness.ready;
  });

  afterEach(() => {
    harness.native.close();
  });

  /** A second port over the SAME index: a relaunch, not a second cycle. */
  const relaunch = (transport: LibraryReconciliationTransport) =>
    createLibraryReconciliationPort(transport, 'p/', harness.index);

  it('reads nothing at all when a relaunched device finds the library unchanged', async () => {
    const objects = seed(450);
    const { transport, counts } = countingTransport(objects);

    const first = await relaunch(transport).discoverChanges();
    expect(first.total).toBe(450);
    expect(first.changed).toHaveLength(450);
    expect(counts).toEqual({ lists: 1, gets: 450 });

    // The measured defect: this is a COLD port — the process restarted, its
    // in-memory map is empty — and the library has not changed. One LIST, zero
    // GETs, and nothing for the engine to project.
    const second = await relaunch(transport).discoverChanges();
    expect(second.changed).toEqual([]);
    expect(second.removedKeys).toEqual([]);
    expect(second.total).toBe(450);
    expect(counts).toEqual({ lists: 2, gets: 450 });
  });

  it('re-reads exactly the changed keys, eight at a time', async () => {
    const objects = seed(50);
    const { transport, counts, gotKeys, peak } = countingTransport(objects);
    await relaunch(transport).discoverChanges();
    gotKeys.length = 0;

    const touched = ['a3', 'a7', 'a11', 'a15', 'a19', 'a23', 'a27', 'a31', 'a35', 'a39'];
    for (const assetId of touched) {
      objects.set(stateKey(assetId), {
        body: stateBody({ assetId, revision: 2 }),
        etag: `"etag-${assetId}-2"`,
      });
    }

    const discovered = await relaunch(transport).discoverChanges();

    expect(gotKeys.sort()).toEqual(touched.map(stateKey).sort());
    expect(counts).toEqual({ lists: 2, gets: 60 });
    expect(ids(discovered.changed)).toEqual([...touched].sort());
    expect(discovered.total).toBe(50);
    // The misses ride the same 8-lane pool the mirror uploads use, not the
    // serial `for … await` that cost ~55 s on the owner's 450-asset library.
    expect(peak()).toBe(8);
    for (const record of discovered.changed) expect(record.revision).toBe(2);
  });

  it('persists each fetched ETag and record, so the next launch is warm', async () => {
    const objects = seed(3);
    const { transport } = countingTransport(objects);
    await relaunch(transport).discoverChanges();

    await expect(harness.database.getAll<{ key: string; etag: string }>(
      `SELECT key, etag FROM library_remote_state_cache
        WHERE account_scope = ? ORDER BY key`,
      [SCOPE],
    )).resolves.toEqual([
      { key: stateKey('a1'), etag: '"etag-a1-1"' },
      { key: stateKey('a2'), etag: '"etag-a2-1"' },
      { key: stateKey('a3'), etag: '"etag-a3-1"' },
    ]);

    objects.set(stateKey('a2'), {
      body: stateBody({ assetId: 'a2', revision: 4 }),
      etag: '"etag-a2-4"',
    });
    await relaunch(transport).discoverChanges();

    await expect(harness.database.getFirst<{ etag: string }>(
      'SELECT etag FROM library_remote_state_cache WHERE key = ?',
      [stateKey('a2')],
    )).resolves.toEqual({ etag: '"etag-a2-4"' });
  });

  it('reports and forgets a key that left the listing, without synthesizing a tombstone', async () => {
    const objects = seed(3);
    const { transport, gotKeys } = countingTransport(objects);
    await relaunch(transport).discoverChanges();
    gotKeys.length = 0;

    const removed = objects.get(stateKey('a2'))!;
    objects.delete(stateKey('a2'));

    // Absence is a cleanup hint only (spec: "listing 缺失只作清扫提示"): the key
    // is named so the caller can act, and no purged record is invented.
    const discovered = await relaunch(transport).discoverChanges();
    expect(discovered.removedKeys).toEqual([stateKey('a2')]);
    expect(discovered.changed).toEqual([]);
    expect(discovered.total).toBe(2);
    expect(gotKeys).toEqual([]);

    // The indexed row went with it, at rest: the same bytes at the same ETag
    // are re-read rather than served from a stale entry.
    await expect(harness.database.getFirst(
      'SELECT key FROM library_remote_state_cache WHERE key = ?',
      [stateKey('a2')],
    )).resolves.toBeNull();
    objects.set(stateKey('a2'), removed);
    expect(ids((await relaunch(transport).discoverChanges()).changed))
      .toEqual(['a2']);
    expect(gotKeys).toEqual([stateKey('a2')]);
  });

  it('detects a tombstone overwrite through its new ETag', async () => {
    const objects = seed(3);
    const { transport, gotKeys } = countingTransport(objects);
    await relaunch(transport).discoverChanges();
    gotKeys.length = 0;

    // A tombstone is a state.json like any other: CAS-overwritten in place,
    // so the object's ETag changes and the diff picks it up.
    objects.set(stateKey('a2'), {
      body: stateBody({ assetId: 'a2', revision: 4, lifecycle: 'purged' }),
      etag: '"etag-a2-4"',
    });

    const discovered = await relaunch(transport).discoverChanges();
    expect(gotKeys).toEqual([stateKey('a2')]);
    expect(discovered.changed).toHaveLength(1);
    expect(discovered.changed[0]!.lifecycle).toBe('purged');
  });

  it('drops the indexed record when the GET after the listing finds nothing', async () => {
    const objects = seed(1);
    const { transport, gotKeys } = countingTransport(objects, [
      { key: stateKey('a2'), etag: '"etag-a2-1"' },
    ]);

    // Listed a moment ago, gone now: skipped, and nothing is indexed for it,
    // so a later listing at the same ETag still re-reads.
    expect(ids((await relaunch(transport).discoverChanges()).changed))
      .toEqual(['a1']);
    gotKeys.length = 0;
    expect(ids((await relaunch(transport).discoverChanges()).changed))
      .toEqual([]);
    expect(gotKeys).toEqual([stateKey('a2')]);
  });

  it('primes the index from getAssetState so the next launch skips that GET', async () => {
    const objects = seed(2);
    const { transport, gotKeys } = countingTransport(objects);

    // The engine's targeted convergence after a committed drain, and the
    // protect action's pre-flight read, both go through here; that read is an
    // index fill like any other — durable, so a relaunch still honours it.
    expect((await relaunch(transport).getAssetState('a1'))?.revision).toBe(1);
    gotKeys.length = 0;

    expect(ids((await relaunch(transport).discoverChanges()).changed))
      .toEqual(['a2']);
    expect(gotKeys).toEqual([stateKey('a2')]);
  });

  it('forgets an asset whose getAssetState finds no object', async () => {
    const objects = seed(1);
    const { transport, gotKeys } = countingTransport(objects);
    await relaunch(transport).discoverChanges();

    objects.delete(stateKey('a1'));
    expect(await relaunch(transport).getAssetState('a1')).toBeNull();
    objects.set(stateKey('a1'), {
      body: stateBody({ assetId: 'a1', revision: 1 }),
      etag: '"etag-a1-1"',
    });
    gotKeys.length = 0;

    expect(ids((await relaunch(transport).discoverChanges()).changed))
      .toEqual(['a1']);
    expect(gotKeys).toEqual([stateKey('a1')]);
  });

  it('never serves an indexed record when the backend reports no ETag', async () => {
    const objects = new Map([
      [stateKey('a1'), { body: stateBody({ assetId: 'a1', revision: 1 }), etag: '' }],
    ]);
    const { transport, counts } = countingTransport(objects);

    await relaunch(transport).discoverChanges();
    await relaunch(transport).discoverChanges();
    // An empty ETag proves nothing about freshness, so it is never an index
    // hit: correctness first, the GET saving second.
    expect(counts).toEqual({ lists: 2, gets: 2 });
    await expect(harness.database.getAll(
      'SELECT key FROM library_remote_state_cache',
    )).resolves.toEqual([]);
  });

  it('remember() records this device’s own CAS write so converge costs no GET', async () => {
    const objects = seed(1);
    const { transport, gotKeys } = countingTransport(objects);
    await relaunch(transport).discoverChanges();
    gotKeys.length = 0;

    // The S3 client's successful CAS PUT knows the key, the new ETag, and the
    // record it just wrote. Telling the index means the next discovery
    // recognises this device's own write instead of paying to re-read it.
    const written = stateBody({ assetId: 'a1', revision: 2 });
    objects.set(stateKey('a1'), { body: written, etag: '"etag-a1-2"' });
    const port = relaunch(transport);
    await port.remember(stateKey('a1'), '"etag-a1-2"', {
      assetId: 'a1',
      revision: 2,
      generation: 1,
      lifecycle: 'active',
      protection: 'unprotected',
      lastMutationId: null,
      trashedAt: null,
      generations: {},
    });

    expect((await relaunch(transport).discoverChanges()).changed).toEqual([]);
    expect(gotKeys).toEqual([]);
  });

  it('surfaces a failed GET instead of reporting the library as unchanged', async () => {
    const objects = seed(20);
    const counting = countingTransport(objects);
    await relaunch(counting.transport).discoverChanges();

    for (const assetId of ['a3', 'a4', 'a5']) {
      objects.set(stateKey(assetId), {
        body: stateBody({ assetId, revision: 2 }),
        etag: `"etag-${assetId}-2"`,
      });
    }
    counting.failNextGet(new Error('connection reset'));

    // A pool that swallowed lane rejections would resolve as "these keys
    // simply had no changes", move the watermark, and leave the index claiming
    // the stale ETag was re-read. The cycle must halt instead.
    await expect(relaunch(counting.transport).discoverChanges())
      .rejects.toThrow('connection reset');
    const stored = await harness.database.getAll<{ etag: string; key: string }>(
      'SELECT key, etag FROM library_remote_state_cache WHERE key IN (?, ?, ?)',
      [stateKey('a3'), stateKey('a4'), stateKey('a5')],
    );
    for (const row of stored) expect(row.etag).not.toContain('-2"');
  });

  it('a rejected durable-index write does not poison the cache: the next pass re-reads and reports the change', async () => {
    const objects = seed(1);
    const { transport, gotKeys } = countingTransport(objects);
    const port = createLibraryReconciliationPort(transport, 'p/', failFirstUpsert(harness.index));

    // The very first pass ever run: LIST finds the one key, GETs it (a cold
    // miss), then fails to persist it durably.
    await expect(port.discoverChanges()).rejects.toThrow(/disk full/);

    // No relaunch: same port, same process. If the failed write had already
    // poisoned the hot cache, this call would find the key "unchanged" and
    // skip it — the defect a fresh review of the protocol-v2 twin found.
    gotKeys.length = 0;
    const discovered = await port.discoverChanges();
    expect(ids(discovered.changed)).toEqual(['a1']);
    expect(discovered.changed[0]?.revision).toBe(1);
    expect(gotKeys).toEqual([stateKey('a1')]);

    await expect(harness.index.getAll()).resolves.toEqual([
      expect.objectContaining({ key: stateKey('a1'), etag: '"etag-a1-1"' }),
    ]);
  });

  it('remember() does not poison the cache when its durable-index write rejects', async () => {
    const objects = seed(1);
    const { transport, gotKeys } = countingTransport(objects);
    const port = createLibraryReconciliationPort(transport, 'p/', failFirstUpsert(harness.index));

    const written = stateBody({ assetId: 'a1', revision: 2 });
    objects.set(stateKey('a1'), { body: written, etag: '"etag-a1-2"' });

    await expect(
      port.remember(stateKey('a1'), '"etag-a1-2"', {
        assetId: 'a1',
        revision: 2,
        generation: 1,
        lifecycle: 'active',
        protection: 'unprotected',
        lastMutationId: null,
        trashedAt: null,
        generations: {},
      }),
    ).rejects.toThrow(/disk full/);

    // The cache must not have learned the etag `remember` failed to persist:
    // a following discovery pass still GETs the key instead of trusting it.
    gotKeys.length = 0;
    const discovered = await port.discoverChanges();
    expect(ids(discovered.changed)).toEqual(['a1']);
    expect(gotKeys).toEqual([stateKey('a1')]);
  });
});
