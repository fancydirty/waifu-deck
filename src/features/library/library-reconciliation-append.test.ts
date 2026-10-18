import { CloudStoreError } from '@/features/cloud-store/cloud-object-store';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';

import { encodeAssetState, type LibraryAssetStateRecord } from './library-asset-state-codec';
import { encodeNoteName, parseNoteName } from './library-note-name';
import { createAppendLibraryReconciliationPort, NOTE_ETAG } from './library-reconciliation-append';
import { createMemoryLibraryRemoteStateIndex } from './library-test-support';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const enc = (s: string) => new TextEncoder().encode(s);

function record(assetId: string, revision: number, over: Partial<LibraryAssetStateRecord> = {}): LibraryAssetStateRecord {
  return {
    assetId, revision, generation: 1, lifecycle: 'active', protection: 'unprotected',
    lastMutationId: null, trashedAt: null, generations: {}, ...over,
  };
}

/** A note name with a fixed, sortable ULID built from a timestamp (random part zeroed). */
function note(assetId: string, ts: number, writer = 'dev-a'): string {
  const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let v = ts; let t = '';
  for (let i = 0; i < 10; i += 1) { t = ULID[v % 32]! + t; v = Math.floor(v / 32); }
  return encodeNoteName({ assetId, mutationId: `${t}0000000000000000`, writer });
}

async function seed(store: ReturnType<typeof createMemoryCloudObjectStore>, name: string, rec: LibraryAssetStateRecord) {
  await store.put(`state/${name}`, encodeAssetState(rec), 'application/json');
}

describe('append-only reconciliation (spec §3.2)', () => {
  test('discoverChanges lists state/, GETs only unseen names, and reports the head per asset', async () => {
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, 1000), record(A, 1));
    await seed(store, note(A, 2000), record(A, 2));
    await seed(store, note(B, 1500), record(B, 1));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });

    const first = await port.discoverChanges();
    expect(first.total).toBe(3);
    expect(first.changed.map((r) => [r.assetId, r.revision])).toEqual(expect.arrayContaining([[A, 2], [B, 1]]));
    expect(first.changed).toHaveLength(2);           // head per asset, not one per note
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(3);

    const mark = store.calls.length;
    const second = await port.discoverChanges();
    expect(second.changed).toEqual([]);              // nothing new → zero GETs
    expect(store.calls.slice(mark).filter((c) => c.op === 'get')).toHaveLength(0);
  });

  test('a note that appears late (listing lag) is simply discovered later, never treated as a conflict', async () => {
    let now = 1000;
    const store = createMemoryCloudObjectStore({ clock: () => now, chaos: { listingDelayMs: 500 } });
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => now });
    await seed(store, note(A, 1000), record(A, 1));
    expect((await port.discoverChanges()).changed).toEqual([]);
    now = 2000;
    expect((await port.discoverChanges()).changed.map((r) => r.revision)).toEqual([1]);
  });

  test('getAssetState answers from the local index without a network call', async () => {
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, 1000), record(A, 7));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    await port.discoverChanges();
    const mark = store.calls.length;
    expect((await port.getAssetState(A))?.revision).toBe(7);
    expect(await port.getAssetState(B)).toBeNull();
    expect(store.calls.slice(mark)).toEqual([]);
  });

  test('remember() seeds the index so this device\'s own write is not re-read', async () => {
    const store = createMemoryCloudObjectStore();
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    const name = note(A, 3000, 'dev-a');
    await seed(store, name, record(A, 3));
    await port.remember(`state/${name}`, 'unused', record(A, 3));
    const changes = await port.discoverChanges();
    expect(changes.changed).toEqual([]);
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(0);
    expect((await port.getAssetState(A))?.revision).toBe(3);
  });

  test('superseded foreign notes older than 7 days are deleted during discovery; younger foreign ones and heads are left', async () => {
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, now - 30 * DAY, 'dev-b'), record(A, 1));   // superseded, old → delete
    await seed(store, note(A, now - 10 * DAY, 'dev-b'), record(A, 2));   // superseded by a note 8 days old → delete
    await seed(store, note(A, now - 8 * DAY, 'dev-b'), record(A, 3));    // head → keep
    await seed(store, note(B, now - 30 * DAY, 'dev-b'), record(B, 1));   // superseded by a 1-day-old note → keep (window)
    await seed(store, note(B, now - 1 * DAY, 'dev-b'), record(B, 2));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => now });
    await port.discoverChanges();
    const deleted = store.calls.filter((c) => c.op === 'delete').map((c) => (c as { path: string }).path).sort();
    expect(deleted).toEqual(
      [`state/${note(A, now - 30 * DAY, 'dev-b')}`, `state/${note(A, now - 10 * DAY, 'dev-b')}`].sort(),
    );
  });

  test('a failed cleanup delete is swallowed — leftovers are harmless', async () => {
    const DAY = 86_400_000; const now = 100 * DAY;
    const store = createMemoryCloudObjectStore({ chaos: { failDeletes: true } });
    await seed(store, note(A, now - 30 * DAY, 'dev-b'), record(A, 1));
    await seed(store, note(A, now - 20 * DAY, 'dev-b'), record(A, 2));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => now });
    await expect(port.discoverChanges()).resolves.toMatchObject({ total: 2 });
  });

  test('a corrupt note body rejects the whole pass with the reconciliation corruption error', async () => {
    const store = createMemoryCloudObjectStore();
    await store.put(`state/${note(A, 1000)}`, enc('{not json'), 'application/json');
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    await expect(port.discoverChanges()).rejects.toThrow(/Failed to parse asset state/);
  });

  test('a CloudStoreError from the store surfaces as a LibraryCloudError with the bridged category', async () => {
    const store = createMemoryCloudObjectStore();
    const broken = { ...store, list: async () => { throw new CloudStoreError(401, 'auth', 'expired'); } };
    const port = createAppendLibraryReconciliationPort(broken, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    await expect(port.discoverChanges()).rejects.toMatchObject({ name: 'LibraryCloudError', category: 'auth_attention' });
  });
});

describe('append-only reconciliation — follow-up fixes (spec §3.3 amendment + review items)', () => {
  test('own superseded notes are swept at discovery without the 7-day wait; foreign notes still wait (spec §3.3 amendment)', async () => {
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    const t0 = 100 * DAY;
    const now = t0 + 2 * HOUR; // inside the 7-day window for every note below
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, t0, 'dev-a'), record(A, 1));              // own, superseded → deleted now, no wait
    await seed(store, note(A, t0 + HOUR, 'dev-a'), record(A, 2));       // own, head → kept
    await seed(store, note(B, now - 30 * DAY, 'dev-b'), record(B, 1));  // foreign, superseded by a 1-day-old note → kept (window)
    await seed(store, note(B, now - 1 * DAY, 'dev-b'), record(B, 2));   // foreign, head
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => now });

    await port.discoverChanges();

    const deleted = store.calls.filter((c) => c.op === 'delete').map((c) => (c as { path: string }).path);
    expect(deleted).toEqual([`state/${note(A, t0, 'dev-a')}`]);
  });

  test('an index write failure leaves the cache stale, so a retry re-reads the miss and reports the change', async () => {
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, 1000), record(A, 1));
    const realIndex = createMemoryLibraryRemoteStateIndex();
    let failNext = true;
    const flakyIndex = {
      ...realIndex,
      async upsertMany(rows: Parameters<typeof realIndex.upsertMany>[0]) {
        if (failNext) {
          failNext = false;
          throw new Error('index write failed');
        }
        await realIndex.upsertMany(rows);
      },
    };
    const port = createAppendLibraryReconciliationPort(store, flakyIndex, { writer: 'dev-a', now: () => 10_000 });

    await expect(port.discoverChanges()).rejects.toThrow(/index write failed/);
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(1);

    const second = await port.discoverChanges();
    expect(second.changed.map((r) => r.revision)).toEqual([1]);
    // The failed write must not have let the cache absorb the miss; a retry
    // that silently found zero misses would report no change forever.
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(2);
  });

  test('remember() throws for a key that is not a parseable "state/<note name>"', async () => {
    const store = createMemoryCloudObjectStore();
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    await expect(port.remember('state/not-a-note.json', 'unused', record(A, 1))).rejects.toThrow(/not a/);
    await expect(port.remember('bogus-key', 'unused', record(A, 1))).rejects.toThrow(/not a/);
  });

  // Pin, not a strict proof: `.record` is read straight out of `cache` either
  // way, so this alone cannot by itself distinguish a memoized `heads()` from
  // a rebuilt-every-call one — what it pins is that a `heads()` read never
  // clones or replaces the stored record, which the memo depends on and a
  // careless future rewrite (e.g. spreading the record defensively) could
  // silently break.
  test('heads() is memoized: two getAssetState reads return the same object, and remember() invalidates it', async () => {
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, 1000, 'dev-b'), record(A, 1));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    await port.discoverChanges();

    const first = await port.getAssetState(A);
    const second = await port.getAssetState(A);
    expect(second).toBe(first); // pin

    const name = note(A, 2000, 'dev-a');
    await seed(store, name, record(A, 9));
    await port.remember(`state/${name}`, 'unused', record(A, 9));
    const third = await port.getAssetState(A);
    expect(third?.revision).toBe(9);   // invalidation: the new head is visible immediately
    expect(third).not.toBe(first);
  });

  test('an older foreign note for an already-indexed asset, arriving late, does not move the head or appear in changed', async () => {
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, 2000, 'dev-b'), record(A, 5));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    const first = await port.discoverChanges();
    expect(first.changed.map((r) => r.revision)).toEqual([5]);

    await seed(store, note(A, 1000, 'dev-b'), record(A, 3)); // arrives late, older than the head
    const second = await port.discoverChanges();
    expect(second.changed).toEqual([]);
    expect((await port.getAssetState(A))?.revision).toBe(5);
  });

  test('a note that vanishes from the listing appears in removedKeys, is dropped from the index, and the asset head still resolves', async () => {
    const store = createMemoryCloudObjectStore();
    const oldName = note(A, 1000, 'dev-b');
    const headName = note(A, 2000, 'dev-b');
    await seed(store, oldName, record(A, 1));
    await seed(store, headName, record(A, 2));
    const index = createMemoryLibraryRemoteStateIndex();
    const port = createAppendLibraryReconciliationPort(store, index, { writer: 'dev-a', now: () => 10_000 });
    await port.discoverChanges();
    expect((await index.getAll()).map((r) => r.key).sort()).toEqual([`state/${oldName}`, `state/${headName}`].sort());

    await store.delete(`state/${oldName}`); // a foreign device swept its own superseded note
    const second = await port.discoverChanges();
    expect(second.removedKeys).toEqual([`state/${oldName}`]);
    expect((await index.getAll()).map((r) => r.key)).toEqual([`state/${headName}`]);
    expect((await port.getAssetState(A))?.revision).toBe(2);
  });

  test('getAssetHead returns the head record plus the ULID from its NAME (the monotonic seed), and null for an unknown asset', async () => {
    const store = createMemoryCloudObjectStore();
    await seed(store, note(A, 1000, 'dev-b'), record(A, 1));
    const headName = note(A, 2000, 'dev-b');
    await seed(store, headName, record(A, 2));
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => 10_000 });
    await port.discoverChanges();

    const head = await port.getAssetHead(A);
    expect(head?.record.revision).toBe(2);                                  // greatest note wins
    expect(head?.mutationId).toBe(parseNoteName(headName)!.mutationId);     // seed from the NAME, not the body
    expect(await port.getAssetHead(B)).toBeNull();
  });

  test('remember() keeps the in-memory head truthful even when the durable index write fails, then rethrows', async () => {
    // Asymmetry with discoverChanges (which writes the index before the cache):
    // remember() records this device's OWN just-written, already-durable note,
    // so the cache must reflect it even if the index write fails, or heads()
    // would regress for an asset this device just mutated. RED before the fix:
    // upsertMany throws before cache.set, so getAssetState answers null.
    const store = createMemoryCloudObjectStore();
    const realIndex = createMemoryLibraryRemoteStateIndex();
    const flakyIndex = {
      ...realIndex,
      async upsertMany() {
        throw new Error('index write failed');
      },
    };
    const port = createAppendLibraryReconciliationPort(store, flakyIndex, { writer: 'dev-a', now: () => 10_000 });
    const name = note(A, 3000, 'dev-a');

    await expect(port.remember(`state/${name}`, 'note', record(A, 3))).rejects.toThrow(/index write failed/);
    expect((await port.getAssetState(A))?.revision).toBe(3);
  });

  test('cleanup deletes run concurrently (bounded pool), not strictly one at a time', async () => {
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const base = createMemoryCloudObjectStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const store = {
      ...base,
      async delete(path: string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return base.delete(path);
      },
    };
    for (let i = 0; i < 20; i += 1) {
      const asset = i.toString(16).padStart(2, '0').repeat(32); // 64 hex chars
      await seed(store, note(asset, now - 30 * DAY, 'dev-b'), record(asset, 1)); // superseded, old → delete
      await seed(store, note(asset, now - 8 * DAY, 'dev-b'), record(asset, 2));  // head, 8 days old → successor past the window
    }
    const port = createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: 'dev-a', now: () => now });

    await port.discoverChanges();

    const deletes = store.calls.filter((c) => c.op === 'delete').length;
    expect(deletes).toBe(20);
    // Deterministic, not a lower bound: the pool starts its 8 lanes
    // synchronously against 20 candidates, so exactly DISCOVERY_CONCURRENCY
    // deletes are in flight at the peak. An unbounded fan-out (20 at once)
    // fails this just as a serial sweep (1) does.
    expect(maxInFlight).toBe(8);
  });

  test('the factory rejects a writer id with no name-safe characters (same guard as the client factory)', () => {
    // An empty tag can never equal a parsed note's writer (1-8 chars), so the
    // own-note sweep would silently never fire and every own note would wait
    // out the foreign 7-day window; fail once at construction instead.
    const store = createMemoryCloudObjectStore();
    expect(() =>
      createAppendLibraryReconciliationPort(store, createMemoryLibraryRemoteStateIndex(), { writer: '！！！', now: () => 10_000 }),
    ).toThrow(/name-safe/);
  });

  /**
   * The listing is the only channel that can report a deletion, and it is
   * also the one channel that lags (spec §3.2): a backend may serve a
   * listing from a cache and omit a note this device has already written and
   * can already GET. "Absent from the listing" must therefore never mean
   * "never written" for a note this device wrote itself — otherwise the
   * device evicts its own head mid-lag, regresses to the previous note, and
   * decides its NEXT write against that stale head, silently losing a trash
   * or restore the user performed inside the window.
   */
  test('a remembered note the listing does not show yet is not evicted, and is promoted once a listing shows it', async () => {
    let now = 1000;
    const store = createMemoryCloudObjectStore({ clock: () => now, chaos: { listingDelayMs: 500 } });
    const index = createMemoryLibraryRemoteStateIndex();
    const port = createAppendLibraryReconciliationPort(store, index, { writer: 'dev-a', now: () => now });
    const name = note(A, 1000, 'dev-a');
    const key = `state/${name}`;
    await seed(store, name, record(A, 3));                 // this device's own PUT, already durable
    await port.remember(key, NOTE_ETAG, record(A, 3));

    // Inside the lag window: the listing omits the note this device just wrote.
    const hidden = await port.discoverChanges();
    expect(hidden.removedKeys).toEqual([]);
    expect((await port.getAssetHead(A))?.record.revision).toBe(3);
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(0);

    // The lag elapses and the note appears. It is already known, so it is
    // never re-read, and its durable marker is promoted to a plain note.
    now = 2000;
    expect((await port.discoverChanges()).removedKeys).toEqual([]);
    expect(store.calls.filter((c) => c.op === 'get')).toHaveLength(0);
    expect(await index.getAll()).toEqual([{ key, etag: NOTE_ETAG, record: record(A, 3) }]);

    // The promotion is what keeps a real deletion reportable: once a listing
    // has shown the note, a later absence is a deletion again.
    await store.delete(key);
    expect((await port.discoverChanges()).removedKeys).toEqual([key]);
    expect(await port.getAssetHead(A)).toBeNull();
  });

  test('the unlisted marker is persisted, so a relaunch inside the lag window still does not evict the note', async () => {
    const now = 1000;
    const store = createMemoryCloudObjectStore({ clock: () => now, chaos: { listingDelayMs: 500 } });
    const index = createMemoryLibraryRemoteStateIndex();
    const name = note(A, 1000, 'dev-a');
    const key = `state/${name}`;
    await seed(store, name, record(A, 3));
    const first = createAppendLibraryReconciliationPort(store, index, { writer: 'dev-a', now: () => now });
    await first.remember(key, NOTE_ETAG, record(A, 3));
    // Literal on purpose: this value is written to the shared index table and
    // read back by a LATER launch, so it is a stored format, not an internal
    // name a rename may quietly change.
    expect((await index.getAll()).map((row) => row.etag)).toEqual(['note:unlisted']);

    // A second port over the SAME durable index with an empty cache: the app
    // was relaunched inside the lag window. An in-memory-only flag would be
    // gone exactly when it is needed.
    const relaunched = createAppendLibraryReconciliationPort(store, index, { writer: 'dev-a', now: () => now });
    expect((await relaunched.discoverChanges()).removedKeys).toEqual([]);
    expect((await relaunched.getAssetHead(A))?.record.revision).toBe(3);
    expect((await index.getAll()).map((row) => row.key)).toEqual([key]);
  });

  /**
   * The OTHER place the unlisted marker is cleared (`cleanupSuperseded`,
   * ~line 334): not the listing/promotion path above, but the sweep. An own
   * note the client already deleted out of band — directly, before any
   * listing ever showed it — must not be reported by `removedKeys` (no
   * listing has shown it, so its marker still applies), and only the sweep,
   * which supersedes it with the newer own note, retires it: the durable
   * index row, the cache entry, and the marker are cleared together.
   */
  test('a superseded own note still carrying the unlisted marker, deleted out of band before any listing shows it, is retired by the sweep — not by removedKeys', async () => {
    const now = 10_000;
    const store = createMemoryCloudObjectStore({ clock: () => now });
    const index = createMemoryLibraryRemoteStateIndex();
    const port = createAppendLibraryReconciliationPort(store, index, { writer: 'dev-a', now: () => now });
    const n1 = note(A, 1000, 'dev-a');
    const n2 = note(A, 2000, 'dev-a');
    const k1 = `state/${n1}`;
    const k2 = `state/${n2}`;
    await seed(store, n1, record(A, 1));
    await port.remember(k1, NOTE_ETAG, record(A, 1));
    await seed(store, n2, record(A, 2));
    await port.remember(k2, NOTE_ETAG, record(A, 2));

    // The client's own out-of-band delete of its previous note, before any
    // listing ever shows it. `store.delete` on an already-gone key is
    // idempotent, so this never throws.
    await store.delete(k1);

    await expect(port.discoverChanges()).resolves.toMatchObject({ removedKeys: [] });
    expect((await index.getAll()).map((row) => row.key)).toEqual([k2]);
    expect((await port.getAssetHead(A))?.mutationId).toBe(parseNoteName(n2)!.mutationId);
  });
});
