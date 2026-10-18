import { CloudStoreError } from './cloud-object-store';
import { createMemoryCloudObjectStore } from './memory-cloud-object-store';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

describe('memory CloudObjectStore', () => {
  test('put/get/list/delete round trip; delete of a missing object is a success', async () => {
    const store = createMemoryCloudObjectStore();
    await store.ensureLayout();
    await store.put('state/a.json', enc('A'), 'application/json');
    await store.put('blobs/g1', enc('B'), 'application/octet-stream');
    expect(dec(await store.get('state/a.json'))).toBe('A');
    expect(await store.get('state/missing.json')).toBeNull();
    expect(await store.list('state')).toEqual([{ name: 'a.json', size: 1 }]);
    expect(await store.list('')).toEqual([]);
    await store.delete('state/a.json');
    await expect(store.delete('state/a.json')).resolves.toBeUndefined();
    expect(await store.list('state')).toEqual([]);
  });

  test('putFromFile reads the injected file port and reports progress', async () => {
    const files = new Map<string, Uint8Array>([['file:///tmp/x', enc('HELLO')]]);
    const store = createMemoryCloudObjectStore({ readFile: async (uri) => files.get(uri) ?? null });
    const sent: number[] = [];
    await store.putFromFile('blobs/g2', 'file:///tmp/x', 'application/octet-stream', (n) => sent.push(n));
    expect(dec(await store.get('blobs/g2'))).toBe('HELLO');
    expect(sent.at(-1)).toBe(5);
  });

  test('chaos: listingDelayMs hides a fresh write from list() until the delay passes', async () => {
    let now = 1000;
    const store = createMemoryCloudObjectStore({ clock: () => now, chaos: { listingDelayMs: 500 } });
    await store.put('state/n1.json', enc('x'), 'application/json');
    expect(await store.list('state')).toEqual([]);
    expect(dec(await store.get('state/n1.json'))).toBe('x');
    now = 1600;
    expect(await store.list('state')).toEqual([{ name: 'n1.json', size: 1 }]);
  });

  test('chaos: failDeletes makes delete throw but leaves the object (harmless leftover)', async () => {
    const store = createMemoryCloudObjectStore({ chaos: { failDeletes: true } });
    await store.put('state/n1.json', enc('x'), 'application/json');
    await expect(store.delete('state/n1.json')).rejects.toBeInstanceOf(CloudStoreError);
    expect(await store.list('state')).toHaveLength(1);
  });

  test('chaos: allowDuplicateNames lets two puts of the same name coexist (Drive semantics)', async () => {
    const store = createMemoryCloudObjectStore({ chaos: { allowDuplicateNames: true } });
    await store.put('vault-meta.json', enc('one'), 'application/json');
    await store.put('vault-meta.json', enc('two'), 'application/json');
    expect(await store.list('')).toEqual([
      { name: 'vault-meta.json', size: 3 },
      { name: 'vault-meta.json', size: 3 },
    ]);
  });

  test('chaos: quotaBytes turns the put that would exceed it into quota_full', async () => {
    const store = createMemoryCloudObjectStore({ chaos: { quotaBytes: 4 } });
    await store.put('blobs/g1', enc('abc'), 'application/octet-stream');
    await expect(store.put('blobs/g2', enc('de'), 'application/octet-stream')).rejects.toMatchObject({ category: 'quota_full', status: 507 });
    expect(await store.quota()).toEqual({ usedBytes: 3, totalBytes: 4 });
  });

  test('quota boundary: filling exactly to quotaBytes succeeds; one byte over does not', async () => {
    // Pins the boundary itself (`>` vs `>=` in the write() guard): landing
    // exactly on the limit must succeed, and the very next byte must not.
    const store = createMemoryCloudObjectStore({ chaos: { quotaBytes: 3 } });
    await store.put('x', enc('abc'), 'application/octet-stream');
    expect(await store.quota()).toEqual({ usedBytes: 3, totalBytes: 3 });

    await expect(
      store.put('y', enc('d'), 'application/octet-stream'),
    ).rejects.toMatchObject({ category: 'quota_full' });
  });

  test('records every call for assertions', async () => {
    const store = createMemoryCloudObjectStore();
    await store.put('state/a.json', enc('A'), 'application/json');
    await store.get('state/a.json');
    await store.list('state');
    await store.delete('state/a.json');
    expect(store.calls.map((c) => c.op)).toEqual(['put', 'get', 'list', 'delete']);
  });

  test('objects() exposes duplicates by suffixing the later ones (#1, #2, ...), and hands back detached copies', async () => {
    // A debugging snapshot, not a protocol surface. The port reads one body per
    // name, so this is the only way a test can see that a duplicated write
    // really did produce two distinct objects rather than one replacement.
    const store = createMemoryCloudObjectStore({ chaos: { allowDuplicateNames: true } });
    await store.put('vault-meta.json', enc('first'), 'application/json');
    await store.put('vault-meta.json', enc('second'), 'application/json');
    const snapshot = store.objects();
    expect([...snapshot.keys()]).toEqual(['vault-meta.json', 'vault-meta.json#1']);
    expect(dec(snapshot.get('vault-meta.json#1') ?? null)).toBe('second');

    // Detached copy: mutating a value objects() handed back must not reach
    // into the store, in either direction (read back via get() or objects()).
    const winner = snapshot.get('vault-meta.json');
    winner![0] = 'Z'.charCodeAt(0);
    expect(dec(await store.get('vault-meta.json'))).toBe('first');
    expect(dec(store.objects().get('vault-meta.json') ?? null)).toBe('first');
  });

  test('duplicates: repeated get() is stable, and delete() cannot target the later copy', async () => {
    // Spec §3.4's rule is "earliest createdAt wins; the loser deletes its own
    // copy". A 4-action store can only promise the first half: every read of a
    // duplicated name returns the same body, and that body is the
    // earliest-created one. The second half is unreachable from here, and this
    // test pins the gap — delete(path) can only reach the copy get() returns,
    // so it removes the WINNER and leaves the loser behind. That is exactly why
    // the Drive adapter (P12-D) must resolve duplicates internally by backend
    // createdTime and delete the loser by file id, never through this port.
    const store = createMemoryCloudObjectStore({ chaos: { allowDuplicateNames: true } });
    await store.put('vault-meta.json', enc('earliest'), 'application/json');
    await store.put('vault-meta.json', enc('mine'), 'application/json');

    expect(dec(await store.get('vault-meta.json'))).toBe('earliest');
    expect(dec(await store.get('vault-meta.json'))).toBe('earliest');

    await store.delete('vault-meta.json');
    expect(dec(await store.get('vault-meta.json'))).toBe('mine');
  });

  test('put snapshots the caller buffer and get hands back a private copy', async () => {
    const store = createMemoryCloudObjectStore();
    const source = enc('AB');
    await store.put('state/a.json', source, 'application/json');
    source[0] = 'Z'.charCodeAt(0);
    expect(dec(await store.get('state/a.json'))).toBe('AB');

    const handedBack = await store.get('state/a.json');
    handedBack![0] = 'Z'.charCodeAt(0);
    expect(dec(await store.get('state/a.json'))).toBe('AB');
  });

  test('a quota-rejected put is still recorded in calls, and nothing lands', async () => {
    const store = createMemoryCloudObjectStore({ chaos: { quotaBytes: 2 } });
    await expect(
      store.put('blobs/g1', enc('abc'), 'application/octet-stream'),
    ).rejects.toBeInstanceOf(CloudStoreError);
    expect(store.calls).toEqual([
      { op: 'put', path: 'blobs/g1', bytes: 3, contentType: 'application/octet-stream' },
    ]);
    expect(store.objects().size).toBe(0);
    expect(await store.get('blobs/g1')).toBeNull();
    expect(await store.quota()).toEqual({ usedBytes: 0, totalBytes: 2 });
  });

  test('quota: replacing an object needs headroom for both copies', async () => {
    // Deliberately conservative, and pinned here so it reads as a decision
    // rather than an accident: a replacement is charged on top of the copy it
    // replaces, because Drive uploads the new file before deleting the old one
    // and a nearly-full drive really does refuse that sequence.
    const store = createMemoryCloudObjectStore({ chaos: { quotaBytes: 4 } });
    await store.put('state/a.json', enc('abc'), 'application/json');
    await expect(
      store.put('state/a.json', enc('xyz'), 'application/json'),
    ).rejects.toMatchObject({ category: 'quota_full' });
    expect(dec(await store.get('state/a.json'))).toBe('abc');
  });

  test('kind defaults to webdav and can model another backend family', () => {
    expect(createMemoryCloudObjectStore().kind).toBe('webdav');
    expect(createMemoryCloudObjectStore({ kind: 'gdrive' }).kind).toBe('gdrive');
  });

  test('calls record the contentType each write was sent with', async () => {
    const store = createMemoryCloudObjectStore({ readFile: async () => enc('HELLO') });
    await store.put('state/a.json', enc('A'), 'application/json');
    await store.putFromFile('blobs/g1', 'file:///tmp/x', 'image/png');
    expect(store.calls).toEqual([
      { op: 'put', path: 'state/a.json', bytes: 1, contentType: 'application/json' },
      {
        op: 'putFromFile',
        path: 'blobs/g1',
        fileUri: 'file:///tmp/x',
        contentType: 'image/png',
      },
    ]);
  });
});

describe('get progress (spec §4 补裁 2026-09-19)', () => {
  test('get reports exactly one progress event: the whole object, total = its length', async () => {
    const store = createMemoryCloudObjectStore();
    const body = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
    await store.put('blobs/g', body, 'application/octet-stream');
    const seen: { sent: number; total: number | null }[] = [];
    const back = await store.get('blobs/g', (p) => seen.push(p));
    expect(back?.byteLength).toBe(1000);
    expect(seen).toEqual([{ sent: 1000, total: 1000 }]);
  });

  test('get of a missing object reports nothing', async () => {
    const store = createMemoryCloudObjectStore();
    const seen: unknown[] = [];
    expect(await store.get('blobs/none', (p) => seen.push(p))).toBeNull();
    expect(seen).toEqual([]);
  });
});
