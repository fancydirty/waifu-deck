import {
  CloudStoreError,
  toLibraryCloudErrorFromStore,
  type CloudObjectStore,
} from '@/features/cloud-store/cloud-object-store';

import {
  AssetStateCorruptionError,
  attachAssetStateKey,
  decodeAssetState,
  type LibraryAssetStateRecord,
} from './library-asset-state-codec';
import { parseNoteName, ulidTimestamp, writerTag } from './library-note-name';
import {
  LibraryReconciliationCorruptionError,
  type LibraryReconciliationPort,
  type LibraryRemoteChanges,
} from './library-reconciliation-port';
import type { LibraryRemoteStateIndex } from './library-remote-state-cache';
import { runTransferPool } from './library-transfer-pool';

/**
 * Board #12 protocol v2 reconciliation (spec §3.2, §3.3 cleanup).
 *
 * Same port the sync engine already consumes (`LibraryReconciliationPort`),
 * fed by a `CloudObjectStore` instead of an S3 transport:
 * - `discoverChanges` lists `state/`, GETs only names it has never read
 *   (the index is keyed by note NAME, so "unchanged" is "already indexed" —
 *   no ETag is needed because a note never changes), and reports the head
 *   (greatest `mutationId`) per asset. A key is reported as REMOVED only once
 *   a listing has shown it at least once (`NOTE_ETAG_UNLISTED`), because a
 *   backend's listing can lag behind a note this device just wrote.
 * - `getAssetState` answers from the index: this device knows its own notes,
 *   so `converge()` no longer needs read-after-write from the backend.
 * - A note superseded for more than 7 days is deleted opportunistically —
 *   except this device's OWN superseded notes, which are deleted at the next
 *   discovery regardless of age (spec §3.3 amendment): the 7-day wait exists
 *   so a slower FOREIGN reader gets a chance to see a note before it's swept
 *   out from under it, but this device already knows its own head the
 *   instant it writes it (via `remember`), so there is nothing left for the
 *   window to protect — including the single-device case, where no other
 *   device is ever going to sweep them.
 */
const DISCOVERY_CONCURRENCY = 8;
const CLEANUP_WINDOW_MS = 7 * 86_400_000;

/**
 * Index/cache keys are stored as `state/<name>` — the exact path
 * `store.get`/`store.delete` need — not the bare note name spec §7 calls
 * "key = 纸条文件名" (key = note filename). Documented deviation: v1 (S3 CAS)
 * and this v2 index share one `library_remote_state_cache` table, so the
 * `state/` prefix also keeps a v2 note key from ever colliding with a v1
 * `assets/<id>/state.json` key in that shared table.
 */
const STATE_PREFIX = 'state/';

/** The note name a `state/<name>` index/cache key was built from. */
function noteNameOf(key: string): string {
  return key.slice(STATE_PREFIX.length);
}

/**
 * The index's `etag` column exists so protocol v1 can diff an S3 listing
 * against what it last read. A v2 note never changes once written, so there
 * is nothing to diff — this constant only satisfies the shared schema's
 * `CHECK(length(etag) > 0)`; the index only needs to remember that this NAME
 * has been read.
 */
export const NOTE_ETAG = 'note';

/**
 * The same column, used for the one thing about a v2 note that CAN change:
 * whether a listing has ever shown it.
 *
 * A note this device wrote is durable in the bucket the instant its PUT
 * returns, but a backend may serve a listing from a cache and omit it for
 * seconds (spec §3.2, the memory store's `listingDelayMs`). "Absent from the
 * listing" therefore must not mean "never written" for a note THIS device
 * wrote: treating it as deleted evicts the device's own head, regresses it to
 * the previous note, and decides the device's NEXT write against that stale
 * head — losing a trash or restore the user performed inside the window (T9
 * review E9/E10), or answering `object_missing` for one (E5).
 *
 * The marker is PERSISTED rather than kept only in memory because the window
 * outlives the process: a relaunch inside it prewarms a cache from the index
 * alone, and an in-memory-only flag would be gone exactly when it is needed.
 * `discoverChanges` promotes the row to `NOTE_ETAG` the first time a listing
 * does show the note, which is what makes a LATER disappearance a real
 * deletion again.
 */
export const NOTE_ETAG_UNLISTED = 'note:unlisted';

export type AppendReconciliationDeps = Readonly<{
  /** This device's id; only its first 8 chars are compared against note writers. */
  writer: string;
  now?: () => number;
}>;

/**
 * The append port is a superset of the shared `LibraryReconciliationPort`: it
 * adds `getAssetHead`, which returns the head record TOGETHER WITH the ULID
 * from its note NAME. That name is the authoritative monotonic seed (spec
 * §3.1: the name is the ordering), so the append client seeds
 * `nextMutationId` from it rather than from the record body's
 * `lastMutationId` — a foreign writer may have left that null or behind the
 * name, which would let this device mint a note that sorts UNDER the head it
 * just read and silently lose the write.
 */
export type AppendLibraryReconciliationPort = LibraryReconciliationPort &
  Readonly<{
    getAssetHead(
      assetId: string,
    ): Promise<{ record: LibraryAssetStateRecord; mutationId: string } | null>;
  }>;

async function viaStoreErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof CloudStoreError ? toLibraryCloudErrorFromStore(error) : error;
  }
}

export function createAppendLibraryReconciliationPort(
  store: Pick<CloudObjectStore, 'list' | 'get' | 'delete'>,
  index: LibraryRemoteStateIndex,
  deps: AppendReconciliationDeps,
): AppendLibraryReconciliationPort {
  const now = deps.now ?? Date.now;
  const mine = writerTag(deps.writer);
  if (mine === '') {
    // Same guard as `createAppendLibraryCloudClient`: an empty tag can never
    // equal a parsed note's writer (1–8 chars), so `cleanupSuperseded` would
    // silently treat every one of this device's own notes as foreign and make
    // them wait out the 7-day window. Fail once here, at construction, rather
    // than misbehave quietly on every pass.
    throw new Error(
      `createAppendLibraryReconciliationPort: writer id has no name-safe characters: ${JSON.stringify(deps.writer)}`,
    );
  }
  /** `state/<name>` → decoded record; the hot half of the durable index. */
  const cache = new Map<string, LibraryAssetStateRecord>();
  /**
   * Keys this device wrote that no listing has shown yet (`NOTE_ETAG_UNLISTED`
   * rows). Always a subset of `cache`: the two are written and cleared
   * together.
   */
  const unlisted = new Set<string>();
  let prewarmed: Promise<void> | null = null;
  /**
   * Lazily built, invalidated on every `cache` mutation. `heads()` runs a
   * full scan of `cache`; without memoizing it, a `discoverChanges` pass
   * (which calls it twice) plus every `getAssetState` call would each rescan
   * the whole cache even when nothing changed between calls.
   */
  let headsMemo: Map<string, { name: string; record: LibraryAssetStateRecord }> | null = null;

  function invalidateHeads(): void {
    headsMemo = null;
  }

  function prewarm(): Promise<void> {
    prewarmed ??= (async () => {
      for (const row of await index.getAll()) {
        attachAssetStateKey(row.record, row.key);
        cache.set(row.key, row.record);
        // A relaunch inside the lag window: this row is still only known to
        // this device, so it must not be evicted by the next listing either.
        if (row.etag === NOTE_ETAG_UNLISTED) unlisted.add(row.key);
      }
      invalidateHeads();
    })().catch((error: unknown) => {
      prewarmed = null;
      throw error;
    });
    return prewarmed;
  }

  /** Head per asset across every indexed note: the greatest mutationId wins (LWW). */
  function heads(): Map<string, { name: string; record: LibraryAssetStateRecord }> {
    if (headsMemo !== null) return headsMemo;
    const out = new Map<string, { name: string; record: LibraryAssetStateRecord }>();
    for (const [key, record] of cache) {
      const name = noteNameOf(key);
      const note = parseNoteName(name);
      if (note === null) continue;
      attachAssetStateKey(record, key);
      const cur = out.get(note.assetId);
      // `cur.name` is a key this same loop already admitted into `out`, so it
      // parsed successfully once before and must parse again the same way.
      if (cur === undefined || parseNoteName(cur.name)!.mutationId < note.mutationId) {
        out.set(note.assetId, { name, record });
      }
    }
    headsMemo = out;
    return out;
  }

  async function discoverChanges(): Promise<LibraryRemoteChanges> {
    await prewarm();
    const listed = (await viaStoreErrors(() => store.list('state')))
      .filter((e) => parseNoteName(e.name) !== null)
      .map((e) => `${STATE_PREFIX}${e.name}`);
    const present = new Set(listed);
    const misses = listed.filter((key) => !cache.has(key));

    const fetched: { key: string; record: LibraryAssetStateRecord }[] = [];
    const failures: unknown[] = [];
    await runTransferPool(misses, async (key) => {
      let body: Uint8Array | null;
      try {
        body = await viaStoreErrors(() => store.get(key));
      } catch (error) { failures.push(error); return; }
      if (body === null) return; // listed then gone: converge next pass
      try {
        fetched.push({ key, record: attachAssetStateKey(decodeAssetState(body), key) });
      } catch (cause) {
        failures.push(cause instanceof AssetStateCorruptionError
          ? new LibraryReconciliationCorruptionError(key, cause) : cause);
      }
    }, { concurrency: DISCOVERY_CONCURRENCY });
    if (failures.length > 0) throw failures[0];

    const before = heads();
    // Only a key a listing has ALREADY shown can be reported as removed. A
    // note this device wrote and the listing has not caught up with yet is
    // absent for the one reason that is not a deletion — and it is normally
    // this device's own head, so dropping it is exactly the regression
    // `NOTE_ETAG_UNLISTED` exists to prevent.
    const removedKeys = [...cache.keys()].filter(
      (key) => !present.has(key) && !unlisted.has(key),
    );
    // Promotion: the listing finally shows a note this device wrote, so it
    // becomes an ordinary confirmed note — and a future absence becomes a
    // deletion again.
    const promoted: { key: string; etag: string; record: LibraryAssetStateRecord }[] = [];
    for (const key of unlisted) {
      const record = cache.get(key);
      // `unlisted ⊆ cache` by construction; the guard only keeps a future
      // drift from throwing here — a marked key that was somehow NOT cached
      // would have been a listing miss above and is already re-indexed with
      // `NOTE_ETAG` by the fetch.
      if (present.has(key) && record !== undefined) {
        promoted.push({ key, etag: NOTE_ETAG, record });
      }
    }

    // Durable truth first, memory second: this is the key set the hot map is
    // about to hold once this pass's writes land, computed without mutating
    // `cache` yet. That way a rejected write below leaves `cache` exactly as
    // it was — the next call in this same process still finds these keys
    // uncached (or still cached) and behaves as if this pass never ran,
    // instead of caching a change the durable index never recorded and
    // silently hiding it from every future retry until relaunch.
    const survivors = new Set(cache.keys());
    for (const { key } of fetched) survivors.add(key);
    // Provably a no-op today: `unlisted ⊆ cache` (see the field comment above)
    // and `removedKeys` is disjoint from `unlisted` by construction (the
    // filter above excludes unlisted keys), so every unlisted key is already
    // in `survivors` by the time this loop runs. No-op while survivors is
    // seeded from cache; kept so a future survivors computed differently
    // cannot silently wipe a marker row.
    for (const key of unlisted) survivors.add(key);
    for (const key of removedKeys) survivors.delete(key);

    await index.upsertMany([
      ...fetched.map(({ key, record }) => ({ key, etag: NOTE_ETAG, record })),
      ...promoted,
    ]);
    await index.deleteMissing([...survivors]);

    for (const { key, record } of fetched) cache.set(key, record);
    for (const key of removedKeys) cache.delete(key);
    // Durable first, memory second, like the writes above: a rejected index
    // write leaves the marker set, so the next pass promotes again.
    for (const { key } of promoted) unlisted.delete(key);
    // Only rebuild heads() when the cache actually moved: an all-hits pass
    // (every listed note already indexed, nothing removed) changed no head, so
    // keeping the memo lets the two heads() calls below reuse it instead of
    // rescanning the whole cache for an identical result. Invariant this
    // depends on: `before` and `after` are then the SAME object, so any code
    // that mutates `cache` between the two heads() calls MUST call
    // invalidateHeads(), or its change is invisible to the diff below.
    if (fetched.length > 0 || removedKeys.length > 0) invalidateHeads();

    const after = heads();
    const changed: LibraryAssetStateRecord[] = [];
    for (const [assetId, head] of after) {
      if (before.get(assetId)?.name !== head.name) changed.push(head.record);
    }
    await cleanupSuperseded(after);
    return { changed, removedKeys, total: listed.length };
  }

  /**
   * Spec §3.3 (amended): a FOREIGN note is deleted once its successor has
   * been the head for longer than the window, so a slower foreign reader
   * gets a chance to see it before it's swept. This device's OWN superseded
   * notes skip the wait — deleted the moment a newer own note supersedes
   * them, because this device already knows its own head the instant it
   * writes it (via `remember`), so there is nothing left for the window to
   * protect, including the single-device case where no other device is ever
   * going to sweep them. Failures are swallowed: a leftover note is inert
   * clutter, never a correctness bug (append-only), and a later pass tries
   * again.
   */
  async function cleanupSuperseded(after: Map<string, { name: string }>): Promise<void> {
    const cutoff = now() - CLEANUP_WINDOW_MS;
    // Collect the deletable keys first (a snapshot), then delete them through
    // the bounded pool: `cache` is mutated inside the worker, so iterating a
    // separate array keeps that safe, and a sweep of many superseded notes
    // overlaps its deletes against the user's own bucket instead of paying one
    // round-trip at a time (same DISCOVERY_CONCURRENCY, same no-throttle rule).
    const candidates: string[] = [];
    for (const key of [...cache.keys()]) {
      const name = noteNameOf(key);
      const note = parseNoteName(name);
      if (note === null) continue;
      const head = after.get(note.assetId);
      // Never sweep the head itself. Accepted residual case: this device's
      // own note deleted out of protocol (by hand, directly on the bucket)
      // while still the head just stays indexed until this device's next
      // write supersedes it — self-healing, and no data is lost meanwhile
      // since the index still holds the record.
      if (head === undefined || head.name === name) continue;
      if (note.writer !== mine) {
        // `head.name` came out of `heads()`, which only ever populates `out`
        // from keys that parsed successfully, so this can only succeed too.
        const successor = parseNoteName(head.name)!;
        if (ulidTimestamp(successor.mutationId) > cutoff) continue;
      }
      candidates.push(key);
    }
    await runTransferPool(
      candidates,
      async (key) => {
        try {
          await store.delete(key);
          await index.deleteKeys([key]);
          cache.delete(key);
          // Safe even if this note is already gone from the backend (e.g.
          // this device's own out-of-band delete already removed it before
          // this pass ever ran): `store.delete` is idempotent, an absent key
          // is success (cloud-object-store.ts:60-61), and the marker is
          // cleared together with the index row and the cache entry above —
          // never left behind as a dangling `unlisted` flag for a key nothing
          // else still references.
          unlisted.delete(key);
          invalidateHeads();
        } catch {
          // Leftover is harmless; a later pass tries again.
        }
      },
      { concurrency: DISCOVERY_CONCURRENCY },
    );
  }

  return {
    discoverChanges,
    async getAssetState(assetId) {
      await prewarm();
      return heads().get(assetId)?.record ?? null;
    },
    async getAssetHead(assetId) {
      await prewarm();
      const head = heads().get(assetId);
      if (head === undefined) return null;
      // The seed is the ULID from the NAME, not `record.lastMutationId`: the
      // name is the ordering (spec §3.1), and `heads()` only ever holds keys
      // that parsed, so this parse cannot fail.
      return { record: head.record, mutationId: parseNoteName(head.name)!.mutationId };
    },
    /**
     * `etag` is ignored on purpose: the argument exists only because this port
     * implements the shared `LibraryReconciliationPort` signature, where v1's
     * CAS writer passes back the ETag S3 returned. A v2 note never changes, so
     * the column carries the one fact that does — whether a listing has shown
     * the note — and a note reaching this method never has. (The append client
     * keeps passing `NOTE_ETAG`, which is harmless.)
     */
    async remember(key, _etag, record) {
      await prewarm();
      if (!key.startsWith(STATE_PREFIX) || parseNoteName(noteNameOf(key)) === null) {
        // A malformed key here means a caller is confusing this port with the
        // v1 `assets/<id>/state.json` one, or building a note path by hand
        // instead of through the writer that names notes — either way,
        // indexing it would silently corrupt `heads()`'s LWW scan the next
        // time `cache` is read, so this fails loudly instead.
        throw new Error(`remember(): not a "${STATE_PREFIX}<note name>" key: ${JSON.stringify(key)}`);
      }
      // Asymmetry with discoverChanges, which writes the index BEFORE the cache
      // so a failed index write leaves memory untouched and the miss is re-read
      // next pass. remember() is the opposite: it records THIS device's own
      // just-written note, which is already durable in the bucket. If the index
      // write fails, the cache must STILL hold it — otherwise heads() would
      // answer a stale head for an asset this device just mutated and converge()
      // could re-diverge it. The price of that cache hit is that the durable
      // row does NOT heal in this process: discoverChanges() only GETs names it
      // has not cached, so it never re-reads this one. The row is re-created at
      // the next process start instead — prewarm loads an index without it,
      // the listing reports it as a miss, and one GET re-indexes it. The index
      // error is still rethrown so the caller knows the durable write did not
      // land.
      try {
        attachAssetStateKey(record, key);
        await index.upsertMany([{ key, etag: NOTE_ETAG_UNLISTED, record }]);
      } finally {
        attachAssetStateKey(record, key);
        cache.set(key, record);
        unlisted.add(key);
        invalidateHeads();
      }
    },
    async invalidateAsset(assetId) {
      await prewarm();
      const matchingKeys: string[] = [];
      for (const key of cache.keys()) {
        const note = parseNoteName(noteNameOf(key));
        if (note !== null && note.assetId === assetId) {
          matchingKeys.push(key);
        }
      }
      if (matchingKeys.length === 0) return;
      await index.deleteKeys(matchingKeys);
      for (const key of matchingKeys) {
        cache.delete(key);
        unlisted.delete(key);
      }
      invalidateHeads();
    },
  };
}
