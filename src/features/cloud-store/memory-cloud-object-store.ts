/**
 * Board #12: the reference `CloudObjectStore`, in memory.
 *
 * Every unit test of the append-only protocol v2 runs against this store, so
 * it is not a convenience fake — it is where the awkward parts of the real
 * backends live. A protocol that only ever ran against a well-behaved map
 * would pass its tests and then break on exactly the backends this subsystem
 * exists for, so the chaos knobs below reproduce the observed OpenList/WebDAV
 * and Google Drive behaviours the protocol must tolerate.
 */

import {
  CloudStoreError,
  type CloudObjectListEntry,
  type CloudObjectStore,
  type CloudObjectStoreKind,
} from './cloud-object-store';

/**
 * The four backend behaviours protocol v2 has to survive, each switchable:
 *
 * - `listingDelayMs`: OpenList-backed WebDAV serves `PROPFIND` from a cache, so
 *   an object that `GET` already returns can stay missing from a listing for
 *   seconds. Reconciliation must never read "absent from the listing" as
 *   "never written".
 * - `failDeletes`: a delete can fail (or be silently refused) on every backend
 *   here. Append-only means a leftover object must be harmless, never a
 *   correctness bug, so the protocol has to survive deletes that do not happen.
 * - `allowDuplicateNames`: Google Drive addresses files by id, not by name, so
 *   two uploads of `vault-meta.json` coexist as two distinct files. What this
 *   store owes spec §3.4 is only that reads of a duplicated name are STABLE
 *   and return the earliest-created copy; resolving the duplicate — adopting
 *   the earliest `createdTime` and deleting the loser BY ID — belongs to the
 *   Drive adapter (P12-D), because `delete(path)` cannot address a specific
 *   copy through this 4-action port.
 * - `quotaBytes`: a full drive is a product state only the user can clear, so
 *   the halting `quota_full` path needs a store that can actually fill up.
 */
export type MemoryStoreChaos = Readonly<{
  listingDelayMs?: number;
  failDeletes?: boolean;
  allowDuplicateNames?: boolean;
  quotaBytes?: number;
}>;

export type MemoryStoreCall =
  | Readonly<{
      op: 'put';
      path: string;
      bytes: number;
      contentType: string;
    }>
  | Readonly<{
      op: 'putFromFile';
      path: string;
      fileUri: string;
      contentType: string;
    }>
  | Readonly<{ op: 'get'; path: string }>
  | Readonly<{ op: 'list'; folder: 'state' | '' }>
  | Readonly<{ op: 'delete'; path: string }>
  | Readonly<{ op: 'ensureLayout' }>
  | Readonly<{ op: 'quota' }>;

export type MemoryCloudObjectStore = CloudObjectStore &
  Readonly<{
    /**
     * Every call in order, so a test can assert on request shape as well as
     * on the resulting bytes (e.g. that reconciliation spent one `list`).
     */
    calls: readonly MemoryStoreCall[];
    /**
     * A point-in-time SNAPSHOT of the raw bytes by path — copies, detached
     * from the store, so later writes do not change a Map a test is holding.
     * When `allowDuplicateNames` let several objects share a path, the first
     * keeps the bare path and the later ones are suffixed `#1`, `#2`, … in
     * write order, so every copy is still inspectable.
     */
    objects(): ReadonlyMap<string, Uint8Array>;
  }>;

type MemoryEntry = {
  readonly path: string;
  readonly body: Uint8Array;
  /** `clock()` must reach this before `list()` admits the entry exists. */
  readonly visibleAt: number;
};

export function createMemoryCloudObjectStore(
  options: Readonly<{
    clock?: () => number;
    readFile?: (uri: string) => Promise<Uint8Array | null>;
    /**
     * Only the reported label (`store.kind`), for a test's own assertions or
     * logs — it changes no behaviour. Duplicates, delete failures, listing
     * delay, and quota still come entirely from `chaos` regardless of which
     * family this claims to be.
     */
    kind?: CloudObjectStoreKind;
    chaos?: MemoryStoreChaos;
  }> = {},
): MemoryCloudObjectStore {
  const clock = options.clock ?? Date.now;
  const chaos = options.chaos ?? {};
  const entries: MemoryEntry[] = [];
  const calls: MemoryStoreCall[] = [];

  const usedBytes = (): number =>
    entries.reduce((total, entry) => total + entry.body.byteLength, 0);

  const write = (path: string, body: Uint8Array): void => {
    const { quotaBytes } = chaos;
    // Conservative on purpose, and deliberately family-independent: a
    // replacement is charged on top of the copy it replaces, never net of it,
    // for every `kind` this store can pretend to be, not only Drive. Drive
    // uploads the new file before deleting the old one, so a nearly-full drive
    // really does refuse that sequence, and a store that quietly discounted
    // the old bytes would hide the failure the `quota_full` halting path
    // exists to surface. Nothing here should ever branch on `kind`.
    if (quotaBytes !== undefined && usedBytes() + body.byteLength > quotaBytes) {
      // The remote answered and refused, so nothing was written: the caller may
      // safely keep treating this write as not applied.
      throw new CloudStoreError(
        507,
        'quota_full',
        `memory store is full: ${usedBytes()} + ${body.byteLength} > ${quotaBytes} bytes`,
        true,
      );
    }
    if (chaos.allowDuplicateNames !== true) {
      const existing = entries.findIndex((entry) => entry.path === path);
      if (existing !== -1) {
        entries.splice(existing, 1);
      }
    }
    entries.push({
      path,
      body: new Uint8Array(body),
      visibleAt: clock() + (chaos.listingDelayMs ?? 0),
    });
  };

  return {
    kind: options.kind ?? 'webdav',

    async put(path, body, contentType) {
      calls.push({ op: 'put', path, bytes: body.byteLength, contentType });
      write(path, body);
    },

    async putFromFile(path, fileUri, contentType, onProgress) {
      calls.push({ op: 'putFromFile', path, fileUri, contentType });
      const body = await options.readFile?.(fileUri);
      if (body === undefined || body === null) {
        throw new CloudStoreError(
          0,
          'client',
          `memory store cannot read ${fileUri}`,
        );
      }
      write(path, body);
      onProgress?.(body.byteLength);
    },

    async get(path, onProgress) {
      calls.push({ op: 'get', path });
      // Stable, and the earliest-created copy: entries are in write order, so
      // the first match is the oldest. Spec §3.4 needs exactly this much from
      // a store — every read of a duplicated `vault-meta.json` agreeing on one
      // body, the earliest one. Deleting the loser is the Drive adapter's job,
      // by file id; `delete(path)` here can only reach the copy this returns.
      const found = entries.find((entry) => entry.path === path);
      if (found === undefined) return null;
      // One whole-object report on completion — the same cadence as this
      // store's `putFromFile` (which reports a bare byte count): a backend that
      // cannot stream still owes the caller the final byte count.
      onProgress?.({ sent: found.body.byteLength, total: found.body.byteLength });
      return new Uint8Array(found.body);
    },

    async list(folder) {
      calls.push({ op: 'list', folder });
      const now = clock();
      const prefix = folder === '' ? '' : `${folder}/`;
      const visible: CloudObjectListEntry[] = [];
      for (const entry of entries) {
        if (entry.visibleAt > now || !entry.path.startsWith(prefix)) {
          continue;
        }
        const name = entry.path.slice(prefix.length);
        // Flat folder only: anything with a further separator lives deeper.
        if (name === '' || name.includes('/')) {
          continue;
        }
        visible.push({ name, size: entry.body.byteLength });
      }
      return visible;
    },

    async delete(path) {
      calls.push({ op: 'delete', path });
      if (chaos.failDeletes === true) {
        // Outcome unknown: the object may or may not be gone. Append-only means
        // the leftover is harmless either way.
        throw new CloudStoreError(
          500,
          'server',
          `memory store refused to delete ${path}`,
          false,
        );
      }
      const index = entries.findIndex((entry) => entry.path === path);
      if (index !== -1) {
        entries.splice(index, 1);
      }
    },

    async ensureLayout() {
      calls.push({ op: 'ensureLayout' });
    },

    async quota() {
      calls.push({ op: 'quota' });
      return { usedBytes: usedBytes(), totalBytes: chaos.quotaBytes ?? null };
    },

    calls,

    objects() {
      const seen = new Map<string, number>();
      const snapshot = new Map<string, Uint8Array>();
      for (const entry of entries) {
        const count = seen.get(entry.path) ?? 0;
        seen.set(entry.path, count + 1);
        const key = count === 0 ? entry.path : `${entry.path}#${count}`;
        snapshot.set(key, new Uint8Array(entry.body));
      }
      return snapshot;
    },
  };
}
