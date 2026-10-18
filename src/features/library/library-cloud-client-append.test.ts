import { createMemoryCloudObjectStore, type MemoryCloudObjectStore, type MemoryStoreChaos } from '@/features/cloud-store/memory-cloud-object-store';
import { CloudStoreError, CloudStoreLocalWriteError, type CloudGetProgress } from '@/features/cloud-store/cloud-object-store';

import { decodeAssetState, type LibraryAssetStateRecord } from './library-asset-state-codec';
import { createAppendLibraryCloudClient } from './library-cloud-client-append';
import type { S3LibraryBlobStagingPort, S3LibraryPendingMutation } from './library-cloud-client-s3';
import { decideLibraryMutation } from './library-mutation-decision';
import { encodeNoteName, nextMutationId, parseNoteName } from './library-note-name';
import { createAppendLibraryReconciliationPort } from './library-reconciliation-append';
import { createMemoryLibraryRemoteStateIndex } from './library-test-support';
import { createLibraryTransferProgress, type LibraryTransferProgressStore } from './library-transfer-progress';

const A = 'a'.repeat(64);
const NOW = '2026-09-18T00:00:00.000Z';

function collect(mutationId: string, over: Partial<S3LibraryPendingMutation> = {}): S3LibraryPendingMutation {
  return {
    mutationId, assetId: A, kind: 'collect', baseRevision: null, observedGeneration: null,
    newBlob: { generationId: 'g1', bytes: new Uint8Array([1, 2, 3]), role: 'original' },
    ...over,
  } as S3LibraryPendingMutation;
}

function harness(opts: {
  clock?: () => number;
  chaos?: MemoryStoreChaos;
  transferProgress?: LibraryTransferProgressStore;
  blobStaging?: S3LibraryBlobStagingPort;
  getHook?: (onProgress: ((p: CloudGetProgress) => void) | undefined) => Promise<void>;
} = {}) {
  let t = 1_000_000;
  const clock = opts.clock ?? (() => (t += 1));
  const base = createMemoryCloudObjectStore({ clock, chaos: opts.chaos });
  const store: MemoryCloudObjectStore = opts.getHook === undefined
    ? base
    : {
        ...base,
        get: async (path: string, onProgress?: (progress: CloudGetProgress) => void) => {
          await opts.getHook!(onProgress);
          return base.get(path, onProgress);
        },
      };
  const index = createMemoryLibraryRemoteStateIndex();
  const reconciliation = createAppendLibraryReconciliationPort(base, index, { writer: 'device-A-uuid', now: clock });
  const cloud = createAppendLibraryCloudClient({
    store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
    now: () => NOW, clock, random: () => new Uint8Array(10),
    transferProgress: opts.transferProgress,
    blobStaging: opts.blobStaging,
  });
  return { store, index, reconciliation, cloud };
}

const stateNames = (store: ReturnType<typeof createMemoryCloudObjectStore>) =>
  [...store.objects().keys()].filter((k) => k.startsWith('state/')).map((k) => k.slice(6));

describe('append-only cloud client (spec §3.3)', () => {
  test('collect: blob PUT happens before the note PUT; one note appears; result is applied', async () => {
    const { store, cloud } = harness();
    const out = await cloud.submitMutations({ mutations: [collect('m1')] });
    expect(out.results).toEqual([expect.objectContaining({ mutationId: 'm1', outcome: 'applied', revision: 1 })]);
    const ops = store.calls.filter((c) => c.op === 'put').map((c) => (c as { path: string }).path);
    expect(ops[0]).toBe('blobs/g1');
    expect(ops[1]).toMatch(/^state\/a{64}\.[0-9A-HJKMNP-TV-Z]{26}\.device-A\.json$/);
    const [name] = stateNames(store);
    expect(decodeAssetState(store.objects().get(`state/${name}`)!).generations.original).toBe('g1');
  });

  test('a second mutation on the same asset writes a NEW note and deletes this device\'s previous one', async () => {
    const { store, cloud } = harness();
    await cloud.submitMutations({ mutations: [collect('m1')] });
    const [first] = stateNames(store);
    const out = await cloud.submitMutations({ mutations: [{ mutationId: 'm2', assetId: A, kind: 'trash', baseRevision: 1, observedGeneration: 1, newBlob: null } as S3LibraryPendingMutation] });
    expect(out.results[0]).toMatchObject({ outcome: 'applied', revision: 2 });
    const names = stateNames(store);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(first);
    expect(parseNoteName(names[0]!)!.mutationId > parseNoteName(first!)!.mutationId).toBe(true);
    expect(store.calls.some((c) => c.op === 'delete' && (c as { path: string }).path === `state/${first}`)).toBe(true);
  });

  test('a same-asset group pays one note for N decisions (collect + protect)', async () => {
    const { store, cloud } = harness();
    const out = await cloud.submitMutations({ mutations: [
      collect('m1'),
      { mutationId: 'm2', assetId: A, kind: 'protect', baseRevision: null, observedGeneration: null, newBlob: null, generationsPatch: { thumbnail: 'g-t' } } as S3LibraryPendingMutation,
    ] });
    expect(out.results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
    expect(stateNames(store)).toHaveLength(1);
  });

  test('LWW: a foreign note with a greater mutationId discovered later becomes the head; my write after it sorts above it', async () => {
    const { store, cloud, reconciliation } = harness();
    await cloud.submitMutations({ mutations: [collect('m1')] });
    const mineName = stateNames(store)[0]!;
    const mine = parseNoteName(mineName)!;
    const foreignId = nextMutationId(mine.mutationId, { now: () => 0, random: () => new Uint8Array(10) });
    const foreign: LibraryAssetStateRecord = { ...decodeAssetState(store.objects().get(`state/${mineName}`)!), revision: 2, lifecycle: 'trash', trashedAt: NOW, lastMutationId: foreignId };
    await store.put(`state/${A}.${foreignId}.device-B.json`, new TextEncoder().encode(JSON.stringify(foreign)), 'application/json');
    await reconciliation.discoverChanges();
    expect((await reconciliation.getAssetState(A))?.lifecycle).toBe('trash');
    const out = await cloud.submitMutations({ mutations: [{ mutationId: 'm3', assetId: A, kind: 'restore', baseRevision: 2, observedGeneration: 1, newBlob: null } as S3LibraryPendingMutation] });
    expect(out.results[0]).toMatchObject({ outcome: 'applied', revision: 3 });
    const newest = stateNames(store).map((n) => parseNoteName(n)!).sort((x, y) => (x.mutationId < y.mutationId ? 1 : -1))[0]!;
    expect(newest.writer).toBe('device-A');
    expect(newest.mutationId > foreignId).toBe(true);
  });

  test('a stale baseRevision against a newer head is rejected as stale_base_revision (the decision table\'s outcome), never resync_required', async () => {
    // "No conditional writes exist to fail" is only meaningful if a genuinely
    // stale submission still comes back with the decision table's own reason
    // rather than the CAS-only resync_required. Seed a foreign head BETWEEN my
    // first write and my second so the second is decided against state my base
    // no longer sees.
    const { cloud, reconciliation } = harness();
    await cloud.submitMutations({ mutations: [collect('m1')] }); // my head, revision 1
    const foreignId = nextMutationId(null, { now: () => 9_000_000, random: () => new Uint8Array(10) });
    const foreignName = encodeNoteName({ assetId: A, mutationId: foreignId, writer: 'device-B-uuid' });
    const foreign: LibraryAssetStateRecord = {
      assetId: A, revision: 5, generation: 1, lifecycle: 'purged', protection: 'unprotected',
      lastMutationId: null, trashedAt: null, generations: {},
    };
    await reconciliation.remember(`state/${foreignName}`, 'note', foreign);

    const out = await cloud.submitMutations({ mutations: [collect('m2', { baseRevision: 1 })] });
    expect(out.results[0]).toMatchObject({ outcome: 'rejected', reason: 'stale_base_revision' });
    expect(out.results.every((r) => r.reason !== 'resync_required')).toBe(true);
  });

  test('a blob PUT that hits quota_full surfaces as LibraryCloudError quota_full and writes no note', async () => {
    const { store, cloud } = harness({ chaos: { quotaBytes: 1 } });
    await expect(cloud.submitMutations({ mutations: [collect('m1')] })).rejects.toMatchObject({ name: 'LibraryCloudError', category: 'quota_full' });
    expect(stateNames(store)).toEqual([]);
  });

  test('putBlob/getObject round-trip through blobs/<generationId>', async () => {
    const { cloud } = harness();
    await cloud.putBlob('g9', new Uint8Array([9, 9]));
    expect(await cloud.getObject('g9')).toEqual(new Uint8Array([9, 9]));
    expect(await cloud.getObject('nope')).toBeNull();
  });

  test('getObjectToFile falls back to get plus file-port write and preserves null', async () => {
    const writes = new Map<string, Uint8Array>();
    const staging: S3LibraryBlobStagingPort = {
      resolveTemp: (name) => `file:///tmp/${name}`,
      async writeBytes(uri, bytes) { writes.set(uri, bytes); },
      async delete() {},
    };
    const { store, cloud } = harness({ blobStaging: staging });
    await store.put('blobs/g-file', new Uint8Array([7, 8]), 'application/octet-stream');
    await expect(cloud.getObjectToFile('g-file', 'file:///tmp/destination'))
      .resolves.toEqual({ etag: '' });
    expect(writes.get('file:///tmp/destination')).toEqual(new Uint8Array([7, 8]));
    await expect(cloud.getObjectToFile('missing', 'file:///tmp/missing')).resolves.toBeNull();
  });

  test('getObjectToFile uses getToFile when present and never buffers through get', async () => {
    const progress = createLibraryTransferProgress();
    const seen: ({ sent: number; total: number | null } | null)[] = [];
    progress.subscribe('g-file', () => seen.push(progress.get('g-file')));
    const base = createMemoryCloudObjectStore();
    const store = {
      ...base,
      async get() {
        throw new Error('get must not be called when getToFile exists');
      },
      async getToFile(_path: string, _fileUri: string, onProgress?: (p: CloudGetProgress) => void) {
        onProgress?.({ sent: 2, total: 5 });
        onProgress?.({ sent: 5, total: 5 });
        return { bytesWritten: 5 };
      },
    };
    const reconciliation = createAppendLibraryReconciliationPort(base, createMemoryLibraryRemoteStateIndex(), { writer: 'device-A-uuid', now: () => 1 });
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      transferProgress: progress,
    });

    await expect(cloud.getObjectToFile('g-file', 'file:///tmp/destination')).resolves.toEqual({ etag: '' });
    expect(seen).toEqual([{ sent: 0, total: null }, { sent: 2, total: 5 }, { sent: 5, total: 5 }, null]);
  });

  test('getObjectToFile passes through null and clears progress when getToFile throws', async () => {
    const progress = createLibraryTransferProgress();
    const base = createMemoryCloudObjectStore();
    const store = {
      ...base,
      async getToFile(path: string, _fileUri: string, onProgress?: (p: CloudGetProgress) => void) {
        onProgress?.({ sent: 1, total: 3 });
        if (path === 'blobs/missing') return null;
        throw new CloudStoreError(401, 'auth', 'expired');
      },
    };
    const reconciliation = createAppendLibraryReconciliationPort(base, createMemoryLibraryRemoteStateIndex(), { writer: 'device-A-uuid', now: () => 1 });
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      transferProgress: progress,
    });

    await expect(cloud.getObjectToFile('missing', 'file:///tmp/missing')).resolves.toBeNull();
    expect(progress.get('missing')).toBeNull();
    await expect(cloud.getObjectToFile('g-file', 'file:///tmp/destination')).rejects.toMatchObject({ name: 'LibraryCloudError', category: 'auth_attention' });
    expect(progress.get('g-file')).toBeNull();
  });

  test('getObjectToFile maps a local write failure to local_space', async () => {
    const progress = createLibraryTransferProgress();
    const base = createMemoryCloudObjectStore();
    const store = {
      ...base,
      async getToFile() {
        throw new CloudStoreLocalWriteError('disk full');
      },
    };
    const reconciliation = createAppendLibraryReconciliationPort(base, createMemoryLibraryRemoteStateIndex(), { writer: 'device-A-uuid', now: () => 1 });
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      transferProgress: progress,
    });

    await expect(cloud.getObjectToFile('g-file', 'file:///tmp/destination')).rejects.toMatchObject({
      name: 'LibraryCloudError', category: 'local_space', code: 'store_local_write', outcomeKnown: true,
    });
    expect(progress.get('g-file')).toBeNull();
  });

  test('a corrupt note for another asset never blocks this asset: discovery rejects, the client still applies against a null head', async () => {
    const { store, cloud, reconciliation } = harness();
    await store.put(`state/${A}.01J8Z3M9A5N6P7Q8R9S0T1V2W3.device-B.json`, new TextEncoder().encode('{bad'), 'application/json');
    await expect(reconciliation.discoverChanges()).rejects.toThrow();
    const B = 'b'.repeat(64);
    const out = await cloud.submitMutations({ mutations: [collect('mB', { assetId: B, newBlob: { generationId: 'gB', bytes: new Uint8Array([1]), role: 'original' } })] });
    expect(out.results[0]).toMatchObject({ assetId: B, outcome: 'applied' });
  });

  test('a delete of the previous note that fails is swallowed (harmless leftover), but was attempted', async () => {
    const { store, cloud } = harness({ chaos: { failDeletes: true } });
    await cloud.submitMutations({ mutations: [collect('m1')] });
    const [first] = stateNames(store);
    const out = await cloud.submitMutations({ mutations: [{ mutationId: 'm2', assetId: A, kind: 'trash', baseRevision: 1, observedGeneration: 1, newBlob: null } as S3LibraryPendingMutation] });
    expect(out.results[0]).toMatchObject({ outcome: 'applied' });
    expect(stateNames(store)).toHaveLength(2);
    // Swallowed is not skipped: the previous note's delete was still issued.
    expect(store.calls.some((c) => c.op === 'delete' && (c as { path: string }).path === `state/${first}`)).toBe(true);
  });

  test('the note written carries lastMutationId = its own ULID, so a relaunch can seed the monotonic rule from the head', async () => {
    const { store, cloud } = harness();
    await cloud.submitMutations({ mutations: [collect('m1')] });
    const [name] = stateNames(store);
    expect(decodeAssetState(store.objects().get(`state/${name}`)!).lastMutationId).toBe(parseNoteName(name!)!.mutationId);
  });

  test('putFromFile path: with blobStaging the blob streams from a staged temp file, progress is reported, and the temp file is deleted', async () => {
    const files = new Map<string, Uint8Array>();
    let t = 1_000_000;
    const clock = () => (t += 1);
    const store = createMemoryCloudObjectStore({ clock, readFile: async (uri) => files.get(uri) ?? null });
    const index = createMemoryLibraryRemoteStateIndex();
    const reconciliation = createAppendLibraryReconciliationPort(store, index, { writer: 'device-A-uuid', now: clock });
    const deleted: string[] = [];
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid', now: () => NOW, clock,
      random: () => new Uint8Array(10),
      blobStaging: {
        resolveTemp: (name) => `file:///tmp/${name}`,
        writeBytes: async (uri, bytes) => { files.set(uri, bytes); },
        delete: async (uri) => { deleted.push(uri); files.delete(uri); },
      },
    });
    const progress: { sent: number; total: number }[] = [];
    await cloud.putBlob('g5', new Uint8Array([5, 5, 5]), (p) => progress.push(p));
    expect(store.calls.filter((c) => c.op === 'putFromFile')).toHaveLength(1);
    expect(await cloud.getObject('g5')).toEqual(new Uint8Array([5, 5, 5]));
    expect(progress.at(-1)).toEqual({ sent: 3, total: 3 });
    expect(deleted).toEqual(['file:///tmp/blob-g5']);
  });

  test('a poisoned head (mutationId at the ULID ceiling) is isolated as corrupt_remote_state for EVERY mutation of its asset\'s group; the rest of the batch applies', async () => {
    // A head whose id is the maximal ULID cannot be minted above, so
    // nextMutationId throws `unusable timestamp`. Without isolation that throw
    // escapes submitMutations and the engine replays the whole batch forever;
    // it must instead reject only this asset's group and let B through.
    const { cloud, reconciliation, store } = harness();
    const poisonName = encodeNoteName({ assetId: A, mutationId: 'Z'.repeat(26), writer: 'device-B-uuid' });
    const poison: LibraryAssetStateRecord = {
      assetId: A, revision: 1, generation: 1, lifecycle: 'active', protection: 'unprotected',
      lastMutationId: 'Z'.repeat(26), trashedAt: null, generations: {},
    };
    await reconciliation.remember(`state/${poisonName}`, 'note', poison);
    const B = 'b'.repeat(64);

    const out = await cloud.submitMutations({
      mutations: [
        { mutationId: 'mA', assetId: A, kind: 'trash', baseRevision: 1, observedGeneration: 1, newBlob: null } as S3LibraryPendingMutation,
        // Same asset, consecutive: ONE group with mA, so the isolation must
        // reject every member of the group, not just its first mutation.
        { mutationId: 'mA2', assetId: A, kind: 'permanent-delete', baseRevision: null, observedGeneration: null, newBlob: null } as S3LibraryPendingMutation,
        collect('mB', { assetId: B, newBlob: { generationId: 'gB', bytes: new Uint8Array([1]), role: 'original' } }),
      ],
    });

    const poisoned = { assetId: A, outcome: 'rejected', reason: 'corrupt_remote_state', revision: null, asset: null };
    expect(out.results[0]).toMatchObject({ mutationId: 'mA', ...poisoned });
    expect(out.results[1]).toMatchObject({ mutationId: 'mA2', ...poisoned });
    expect(out.results[2]).toMatchObject({ mutationId: 'mB', assetId: B, outcome: 'applied' });
    expect(out.results).toHaveLength(3);
    // No note was written for the poisoned asset; only B's landed.
    expect(stateNames(store).map((n) => parseNoteName(n)!.assetId)).toEqual([B]);
  });

  test('collect against a trashed head is rejected trash_wins, echoes the head back, and writes no note', async () => {
    const { store, cloud, reconciliation } = harness();
    const headId = nextMutationId(null, { now: () => 5_000_000, random: () => new Uint8Array(10) });
    const headName = encodeNoteName({ assetId: A, mutationId: headId, writer: 'device-B-uuid' });
    const head: LibraryAssetStateRecord = {
      assetId: A, revision: 4, generation: 1, lifecycle: 'trash', protection: 'unprotected',
      lastMutationId: null, trashedAt: NOW, generations: {},
    };
    await reconciliation.remember(`state/${headName}`, 'note', head);

    const out = await cloud.submitMutations({ mutations: [collect('m1')] });

    expect(out.results[0]).toMatchObject({ outcome: 'rejected', reason: 'trash_wins', revision: 4 });
    expect(out.results[0]!.asset).toMatchObject({ assetId: A, revision: 4, lifecycle: 'trash' });
    expect(stateNames(store)).toEqual([]); // nothing written (the seed lives only in the index)
  });

  test('the monotonic seed comes from the head note NAME, not its body: a foreign head with lastMutationId:null but a far-future name still gets out-sorted', async () => {
    const { store, cloud, reconciliation } = harness();
    const foreignId = nextMutationId(null, { now: () => 9_000_000, random: () => new Uint8Array(10) });
    const foreignName = encodeNoteName({ assetId: A, mutationId: foreignId, writer: 'device-B-uuid' });
    const foreign: LibraryAssetStateRecord = {
      assetId: A, revision: 5, generation: 1, lifecycle: 'active', protection: 'unprotected',
      lastMutationId: null, trashedAt: null, generations: {}, // body carries no id — only the NAME does
    };
    await reconciliation.remember(`state/${foreignName}`, 'note', foreign);

    const out = await cloud.submitMutations({ mutations: [{ mutationId: 'm1', assetId: A, kind: 'trash', baseRevision: 5, observedGeneration: 1, newBlob: null } as S3LibraryPendingMutation] });
    expect(out.results[0]).toMatchObject({ outcome: 'applied' });

    const newest = stateNames(store).map((n) => parseNoteName(n)!).sort((x, y) => (x.mutationId < y.mutationId ? 1 : -1))[0]!;
    expect(newest.writer).toBe('device-A');
    expect(newest.mutationId > foreignId).toBe(true); // seeded from the far-future NAME, so it sorts above
  });

  test('a note PUT that fails surfaces as LibraryCloudError offline with outcome unknown; the blob stays written and remember is never called', async () => {
    let t = 1_000_000;
    const clock = () => (t += 1);
    const base = createMemoryCloudObjectStore({ clock });
    const store = {
      ...base,
      async put(path: string, body: Uint8Array, contentType: string) {
        if (path.startsWith('state/')) throw new CloudStoreError(500, 'server', 'note PUT failed');
        return base.put(path, body, contentType);
      },
    };
    const index = createMemoryLibraryRemoteStateIndex();
    const realPort = createAppendLibraryReconciliationPort(store, index, { writer: 'device-A-uuid', now: clock });
    let remembered = 0;
    const reconciliation = {
      ...realPort,
      remember: async (...args: Parameters<typeof realPort.remember>) => {
        remembered += 1;
        return realPort.remember(...args);
      },
    };
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      now: () => NOW, clock, random: () => new Uint8Array(10),
    });

    await expect(cloud.submitMutations({ mutations: [collect('m1')] })).rejects.toMatchObject({
      name: 'LibraryCloudError', category: 'offline', outcomeKnown: false,
    });
    expect(base.objects().get('blobs/g1')).toBeDefined(); // blob durable even though the note failed
    expect(remembered).toBe(0);                            // never index a note the bucket rejected
  });

  test('a remember() that rejects is swallowed: the note is already durable, so the mutation still resolves applied', async () => {
    let t = 1_000_000;
    const clock = () => (t += 1);
    const store = createMemoryCloudObjectStore({ clock });
    const index = createMemoryLibraryRemoteStateIndex();
    const realPort = createAppendLibraryReconciliationPort(store, index, { writer: 'device-A-uuid', now: clock });
    const reconciliation = {
      ...realPort,
      remember: async () => {
        throw new Error('index write failed');
      },
    };
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      now: () => NOW, clock, random: () => new Uint8Array(10),
    });

    const out = await cloud.submitMutations({ mutations: [collect('m1')] });
    expect(out.results[0]).toMatchObject({ outcome: 'applied', revision: 1 });
    expect(stateNames(store)).toHaveLength(1); // the note is in the bucket regardless of the index
  });

  test('a multi-applied same-asset group: only the last member carries the note\'s final record + ULID; the earlier one keeps its intermediate revision', async () => {
    const { store, cloud } = harness();
    const out = await cloud.submitMutations({ mutations: [
      collect('m1'),
      { mutationId: 'm2', assetId: A, kind: 'protect', baseRevision: null, observedGeneration: null, newBlob: null, generationsPatch: { thumbnail: 'g-t' } } as S3LibraryPendingMutation,
    ] });
    expect(out.results.map((r) => r.outcome)).toEqual(['applied', 'applied']);
    // Earlier member keeps the record buildNextRecord produced for it (rev 1),
    // NOT the group's final written record.
    expect(out.results[0]!.revision).toBe(1);
    expect((out.results[0]!.asset as LibraryAssetStateRecord).revision).toBe(1);
    // Only the last member is rewritten to the note's final record: rev 2 and
    // the note's own ULID.
    const [name] = stateNames(store);
    const finalRecord = out.results[1]!.asset as LibraryAssetStateRecord;
    expect(finalRecord.revision).toBe(2);
    expect(finalRecord.lastMutationId).toBe(parseNoteName(name!)!.mutationId);
  });

  test('getObject bridges a store error to a category-bearing LibraryCloudError', async () => {
    const base = createMemoryCloudObjectStore();
    const store = { ...base, async get() { throw new CloudStoreError(401, 'auth', 'expired'); } };
    const reconciliation = createAppendLibraryReconciliationPort(base, createMemoryLibraryRemoteStateIndex(), { writer: 'device-A-uuid', now: () => 1 });
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      now: () => NOW, clock: () => 1, random: () => new Uint8Array(10),
    });
    await expect(cloud.getObject('g1')).rejects.toMatchObject({ name: 'LibraryCloudError', category: 'auth_attention' });
  });

  test('putBlob bridges a store error to a category-bearing LibraryCloudError', async () => {
    const base = createMemoryCloudObjectStore();
    const store = { ...base, async put() { throw new CloudStoreError(401, 'auth', 'expired'); } };
    const reconciliation = createAppendLibraryReconciliationPort(base, createMemoryLibraryRemoteStateIndex(), { writer: 'device-A-uuid', now: () => 1 });
    const cloud = createAppendLibraryCloudClient({
      store, reconciliation, decide: decideLibraryMutation, writer: 'device-A-uuid',
      now: () => NOW, clock: () => 1, random: () => new Uint8Array(10),
    });
    await expect(cloud.putBlob('g1', new Uint8Array([1]))).rejects.toMatchObject({ name: 'LibraryCloudError', category: 'auth_attention' });
  });

  test('the factory rejects a writer id with no name-safe characters', () => {
    const { store, reconciliation } = harness();
    expect(() =>
      createAppendLibraryCloudClient({ store, reconciliation, decide: decideLibraryMutation, writer: '！！！' }),
    ).toThrow(/name-safe/);
  });

  test('getObject marks the ring indeterminate BEFORE the store answers, forwards real bytes, and clears it in finally', async () => {
    const progress = createLibraryTransferProgress();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { store, cloud } = harness({ transferProgress: progress, getHook: async () => { await gate; } });
    await store.put('blobs/g1', new Uint8Array([1, 2, 3]), 'application/octet-stream');
    const pending = cloud.getObject('g1');
    await Promise.resolve();
    expect(progress.get('g1')).toEqual({ sent: 0, total: null });   // spinning before the first byte
    release();
    expect(await pending).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress.get('g1')).toBeNull();                          // cleared in finally
  });

  test('getObject forwards the adapter\'s byte reports into the ring while the transfer runs', async () => {
    const progress = createLibraryTransferProgress();
    const seen: ({ sent: number; total: number | null } | null)[] = [];
    progress.subscribe('g1', () => seen.push(progress.get('g1')));
    const { store, cloud } = harness({ transferProgress: progress, getHook: async (onProgress) => { onProgress?.({ sent: 1, total: 3 }); onProgress?.({ sent: 2, total: 3 }); } });
    await store.put('blobs/g1', new Uint8Array([1, 2, 3]), 'application/octet-stream');
    await cloud.getObject('g1');
    // indeterminate → 1/3 → 2/3 → the memory store's own final 3/3 → cleared
    expect(seen).toEqual([{ sent: 0, total: null }, { sent: 1, total: 3 }, { sent: 2, total: 3 }, { sent: 3, total: 3 }, null]);
  });

  test('getObject clears the ring even when the store throws', async () => {
    const progress = createLibraryTransferProgress();
    const { cloud } = harness({ transferProgress: progress, getHook: async () => { throw new CloudStoreError(401, 'auth', 'nope'); } });
    await expect(cloud.getObject('g1')).rejects.toMatchObject({ name: 'LibraryCloudError', category: 'auth_attention' });
    expect(progress.get('g1')).toBeNull();
  });

  test('getObject without a transferProgress store still works and still returns null for a missing blob', async () => {
    const { cloud } = harness();
    expect(await cloud.getObject('missing')).toBeNull();
  });
});
