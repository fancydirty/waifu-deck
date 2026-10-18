/**
 * Board #12: the reusable `CloudObjectStore` contract.
 *
 * Every adapter — the in-memory reference today, WebDAV / OneDrive / Google
 * Drive later — runs this suite unchanged, and passing it is the definition of
 * "this backend is supported". That only works if the suite asks for exactly
 * what the append-only protocol v2 relies on and nothing more: no ETags, no
 * conditional writes, and no immediate list-after-write. Google Drive v3 has no
 * ETag to compare and OpenList-backed WebDAV serves PROPFIND from a cache, so a
 * contract that demanded either would fail the very backends this subsystem
 * exists for. Listing is therefore only ever asserted as *eventual*.
 *
 * One clause this suite cannot exercise: spec §3.4's "earliest-created copy
 * of a duplicated name" needs a backend that can manufacture a duplicate,
 * which this 4-action port has no way to do. That clause is pinned only by
 * the memory-store suite (`memory-cloud-object-store.test.ts`); a Drive
 * adapter must pin it again in its own suite.
 */

import { CloudStoreError, type CloudGetProgress, type CloudObjectStore } from './cloud-object-store';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type StoreContractFactory = (
  /**
   * The per-run token every name in this suite carries. A real backend needs
   * it to scope (and later clean up) the objects one run created; the memory
   * store gets a fresh instance anyway and ignores it.
   */
  run: string,
) => Promise<
  Readonly<{
    store: CloudObjectStore;
    /** Remove everything the suite created (a real backend needs this; memory does not). */
    dispose: () => Promise<void>;
  }>
>;

export type StoreContractOptions = Readonly<{ samePathBehavior?: 'replace' | 'append' }>;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) =>
  b === null ? null : new TextDecoder().decode(b);

const bySize = (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0);

async function temporaryFileUri(name: string): Promise<Readonly<{ uri: string; cleanup: () => Promise<void> }>> {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-store-get-'));
  return {
    uri: pathToFileURL(join(directory, name)).href,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** How long one `eventually` poll waits for a backend's listing to converge. */
const EVENTUALLY_MS = 30_000;

/**
 * Longer than the worst case in this suite, not just one poll: the "list(state)
 * never reports blobs and list('') never reports state notes" case below makes
 * TWO sequential `EVENTUALLY_MS` polls (one for `list('state')`, one for
 * `list('')`), so a backend lagging up to a combined 2× would otherwise die
 * here with jest's bare "Exceeded timeout" instead of `eventually`'s own
 * observation dump. 3× covers that with margin — derived from the poll
 * constant rather than written as a second literal, so the two cannot drift.
 */
const POLLING_TEST_TIMEOUT_MS = 3 * EVENTUALLY_MS;

/**
 * Polls `probe` until `ok` accepts what it returned, then hands that
 * observation back; on timeout it THROWS, naming `what` and dumping the last
 * observation. A real backend may take seconds to admit a fresh write into a
 * listing, so every listing assertion goes through here rather than reading
 * `list()` once — and when a backend genuinely never converges, the failure
 * has to say what was still wrong rather than `expect(false).toBe(true)`.
 */
async function eventually<T>(
  what: string,
  probe: () => Promise<T>,
  ok: (observation: T) => boolean,
  timeoutMs = EVENTUALLY_MS,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observation = await probe();
    if (ok(observation)) {
      return observation;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${what}: never became true within ${timeoutMs} ms. Last observation: ${JSON.stringify(observation)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

export function describeCloudObjectStoreContract(
  label: string,
  factory: StoreContractFactory,
  options: StoreContractOptions = {},
): void {
  describe(`CloudObjectStore contract — ${label}`, () => {
    let store: CloudObjectStore;
    let dispose: () => Promise<void>;
    // A real bucket outlives one run, so every name this suite writes carries a
    // per-run token: leftovers from an earlier run can never satisfy or break a
    // later one.
    // Two runs can start inside the same millisecond (CI matrix, a retry), so
    // the clock alone is not unique enough to keep their objects apart.
    const run = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

    beforeAll(async () => {
      ({ store, dispose } = await factory(run));
      await store.ensureLayout();
      // A real backend may have to create folders and authenticate here, and
      // cleanup may have to page through and delete everything this run wrote.
    }, 60_000);

    afterAll(async () => {
      await dispose();
    }, 60_000);

    test('ensureLayout is idempotent', async () => {
      await expect(store.ensureLayout()).resolves.toBeUndefined();
    });

    test('get of a missing object is null, never a throw', async () => {
      expect(await store.get(`state/${run}-missing.json`)).toBeNull();
      expect(await store.get(`blobs/${run}-missing`)).toBeNull();
    });

    test('put then get returns identical bytes (small JSON and a 300 KiB blob)', async () => {
      await store.put(`state/${run}-a.json`, enc('{"a":1}'), 'application/json');
      expect(dec(await store.get(`state/${run}-a.json`))).toBe('{"a":1}');

      const big = Uint8Array.from({ length: 300 * 1024 }, (_, i) => (i * 31) % 256);
      await store.put(`blobs/${run}-big`, big, 'application/octet-stream');
      const back = await store.get(`blobs/${run}-big`);
      expect(back).not.toBeNull();
      expect(back!.byteLength).toBe(big.byteLength);
      expect(big.findIndex((byte, index) => back![index] !== byte)).toBe(-1);
    });

    test('get reports progress that ends at the full length; total is the length or null, never 0 or a guess', async () => {
      const body = Uint8Array.from({ length: 64 * 1024 }, (_, i) => (i * 7) % 256);
      await store.put(`blobs/${run}-p`, body, 'application/octet-stream');
      const seen: CloudGetProgress[] = [];
      // Snapshot each report: an adapter that reuses one mutable progress
      // object per chunk would otherwise make every entry read as the final
      // state and neutralise the monotone/same-total checks below.
      const back = await store.get(`blobs/${run}-p`, (p) => seen.push({ ...p }));
      expect(back?.byteLength).toBe(body.byteLength);
      // At least the final byte count is owed: it is what makes `sent`
      // verifiable at all (the port doc says the same).
      expect(seen.length).toBeGreaterThanOrEqual(1);
      const last = seen[seen.length - 1]!;
      expect(last.sent).toBe(body.byteLength);
      expect([null, body.byteLength]).toContain(last.total);
      // Monotone: bytes only ever arrive.
      for (let i = 1; i < seen.length; i += 1) expect(seen[i]!.sent).toBeGreaterThanOrEqual(seen[i - 1]!.sent);
      // A backend that reports a total reports the same total throughout.
      const totals = new Set(seen.map((p) => p.total));
      expect(totals.size).toBe(1);
    });

    test('get of a missing object reports no progress at all (a 404 body is not bytes of the object)', async () => {
      const seen: CloudGetProgress[] = [];
      expect(await store.get(`blobs/${run}-p-missing`, (p) => seen.push({ ...p }))).toBeNull();
      expect(seen).toEqual([]);
    });

    test('getToFile returns byte-identical contents and ends progress at the full length', async () => {
      if (store.getToFile === undefined) return;
      const body = Uint8Array.from({ length: 64 * 1024 }, (_, i) => (i * 13) % 256);
      await store.put(`blobs/${run}-file`, body, 'application/octet-stream');
      const target = await temporaryFileUri('blob.bin');
      try {
        const seen: CloudGetProgress[] = [];
        const result = await store.getToFile(`blobs/${run}-file`, target.uri, (p) => seen.push({ ...p }));
        expect(result).toEqual({ bytesWritten: body.byteLength });
        expect(new Uint8Array(await readFile(new URL(target.uri)))).toEqual(body);
        expect(seen.length).toBeGreaterThanOrEqual(1);
        const last = seen.at(-1)!;
        expect(last.sent).toBe(body.byteLength);
        expect([null, body.byteLength]).toContain(last.total);
      } finally {
        await target.cleanup();
      }
    });

    test('getToFile missing object returns null, reports no progress, and leaves no file', async () => {
      if (store.getToFile === undefined) return;
      const target = await temporaryFileUri('missing.bin');
      try {
        const seen: CloudGetProgress[] = [];
        await expect(store.getToFile(`blobs/${run}-file-missing`, target.uri, (p) => seen.push({ ...p }))).resolves.toBeNull();
        await expect(stat(new URL(target.uri))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(seen).toEqual([]);
      } finally {
        await target.cleanup();
      }
    });

    test(
      'list(state) eventually reports every written name with its size',
      async () => {
        await store.put(`state/${run}-l1.json`, enc('xx'), 'application/json');
        await store.put(`state/${run}-l2.json`, enc('yyy'), 'application/json');

        const listed = await eventually(
          `list(state) reports both ${run}-l notes`,
          async () =>
            (await store.list('state')).filter((entry) =>
              entry.name.startsWith(`${run}-l`),
            ),
          (mine) => mine.length === 2,
        );

        expect(listed.map((entry) => entry.name).sort()).toEqual([
          `${run}-l1.json`,
          `${run}-l2.json`,
        ]);
        expect(listed.map((entry) => entry.size).sort(bySize)).toEqual([2, 3]);
      },
      POLLING_TEST_TIMEOUT_MS,
    );

    test(
      'list(state) never reports blobs and list("") never reports state notes',
      async () => {
        await store.put(`state/${run}-f.json`, enc('s'), 'application/json');
        await store.put(`blobs/${run}-f`, enc('b'), 'application/octet-stream');
        await store.put(`${run}-f-root.json`, enc('r'), 'application/json');

        // Wait until each listing admits its OWN write before reading anything
        // into a negative. On a cache-backed backend an absence proves nothing
        // until propagation has demonstrably happened, so without these two
        // waits the four checks below could pass purely because the listing
        // was still empty.
        const state = await eventually(
          `list(state) reports ${run}-f.json`,
          () => store.list('state'),
          (entries) => entries.some((entry) => entry.name === `${run}-f.json`),
        );
        const root = await eventually(
          `list("") reports ${run}-f-root.json`,
          () => store.list(''),
          (entries) =>
            entries.some((entry) => entry.name === `${run}-f-root.json`),
        );

        expect(state.some((entry) => entry.name === `${run}-f`)).toBe(false);
        expect(state.some((entry) => entry.name === `${run}-f-root.json`)).toBe(
          false,
        );
        expect(root.some((entry) => entry.name === `${run}-f.json`)).toBe(false);
        expect(root.some((entry) => entry.name === `${run}-f`)).toBe(false);
      },
      POLLING_TEST_TIMEOUT_MS,
    );

    test(
      'delete removes (eventually — a CDN-fronted drive can serve the old bytes for a moment), and deleting a missing object is a success',
      async () => {
        await store.put(`state/${run}-d.json`, enc('d'), 'application/json');
        await store.delete(`state/${run}-d.json`);
        // Protocol v2 only ever deletes SUPERSEDED notes, and a stale read of
        // one is harmless (the greatest ULID still wins), so immediate
        // read-after-delete is not something the protocol needs — and 123 云盘
        // serves a deleted object through its CDN for ~1 s (measured
        // 2026-09-20). Eventual is the honest contract.
        await eventually(
          `get(${run}-d.json) reports the deleted object as absent`,
          () => store.get(`state/${run}-d.json`),
          (body) => body === null,
        );
        await expect(store.delete(`state/${run}-d.json`)).resolves.toBeUndefined();
      },
      POLLING_TEST_TIMEOUT_MS,
    );

    test('quota is null or a well-formed number pair, and is stable across calls', async () => {
      const quota = await store.quota();
      if (quota === null) {
        // A backend that reports no quota at all must say so consistently;
        // otherwise this branch would assert nothing and pass on any backend
        // that happens to return null.
        expect(await store.quota()).toBeNull();
        return;
      }
      expect(quota.usedBytes).toBeGreaterThanOrEqual(0);
      expect(quota.totalBytes === null || quota.totalBytes >= quota.usedBytes).toBe(
        true,
      );
    });

    test(
      options.samePathBehavior === 'append'
        ? 'a second put to the same path appends a duplicate and reads the earliest bytes'
        : 'a second put to the same path replaces it: one object, the newer bytes',
      async () => {
        const path = `state/${run}-r.json`;
        await store.put(path, enc('v1'), 'application/json');
        // Append mode reads the earliest createdTime (millisecond resolution). Two puts
        // inside one millisecond tie, and the tie-break alone could make "latest" pass
        // as "earliest"; spacing them makes the ordering the thing under test.
        if (options.samePathBehavior === 'append') await new Promise((resolve) => setTimeout(resolve, 5));
        await store.put(path, enc('v2'), 'application/json');
        expect(dec(await store.get(path))).toBe(options.samePathBehavior === 'append' ? 'v1' : 'v2');

        // Drive addresses files by id, so its append-only protocol permits two
        // same-name rows; the adapter must choose the earliest-created copy.
        // Other backends retain the historical replace contract.
        await eventually(
          `list(state) reports the expected ${run}-r.json rows`,
          async () =>
            (await store.list('state')).filter(
              (entry) => entry.name === `${run}-r.json`,
            ),
          (mine) => mine.length === (options.samePathBehavior === 'append' ? 2 : 1),
        );

        if (options.samePathBehavior === 'append') return;

        // Converge AND stay: a backend that briefly shows one copy and then
        // lets a slow-to-vanish duplicate reappear would still pass the check
        // above. Re-list once more after a short settle to rule that out.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const settled = (await store.list('state')).filter(
          (entry) => entry.name === `${run}-r.json`,
        );
        expect(settled.length).toBe(1);
      },
      POLLING_TEST_TIMEOUT_MS,
    );

    test('putFromFile of a missing file rejects with a client CloudStoreError', async () => {
      const error: unknown = await store
        .putFromFile(
          `blobs/${run}-nofile`,
          'file:///definitely/missing',
          'application/octet-stream',
        )
        .then(() => null, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(CloudStoreError);
      expect((error as CloudStoreError).category).toBe('client');
    });

    test('kind names one of the supported backend families', () => {
      expect(['webdav', 'onedrive', 'gdrive']).toContain(store.kind);
    });
  });
}
