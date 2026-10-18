import type { S3GetResult, S3ListPage } from '@/features/byos/s3-transport';

import {
  AssetStateCorruptionError,
  attachAssetStateKey,
  decodeAssetState,
  type LibraryAssetStateRecord,
} from './library-asset-state-codec';
import type { LibraryRemoteStateIndex } from './library-remote-state-cache';
import { runTransferPool } from './library-transfer-pool';

/**
 * The minimal slice of `S3Transport` this port depends on. Kept structural
 * (rather than importing `createS3Transport`'s return type) so unit tests
 * can inject a plain fake without implementing `putObject`/`deleteObject`.
 */
export type LibraryReconciliationTransport = Readonly<{
  listObjects(
    prefix: string,
    continuationToken: string | undefined,
  ): Promise<S3ListPage>;
  getObject(key: string): Promise<S3GetResult | null>;
}>;

/**
 * Thrown when a `state.json` object is present but its body is not valid
 * JSON, or is missing a field `LibraryRemoteAssetState` requires.
 *
 * Choice (documented per plan Task 2 Step 4): fail fast rather than
 * silently drop the bad object from the result set. A skipped asset would
 * look identical to "this asset doesn't exist on the remote" to every
 * caller — the reconciler could then treat a protected/trashed asset as
 * absent and re-collect or re-diverge it, silently reverting a real
 * mutation. A thrown, structured error surfaces the corruption immediately
 * and lets the caller decide (retry, alert, or halt sync) instead of the
 * port making that decision invisibly.
 */
export class LibraryReconciliationCorruptionError extends Error {
  constructor(
    readonly key: string,
    cause: unknown,
  ) {
    super(
      `Failed to parse asset state at "${key}": ${describeCause(cause)}`,
    );
    this.name = 'LibraryReconciliationCorruptionError';
    Object.setPrototypeOf(this, LibraryReconciliationCorruptionError.prototype);
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Parses only the outer/plaintext-structural shape of a `state.json` body
 * and maps it to `LibraryAssetStateRecord` (the full persisted record —
 * including `generations`, which callers need to locate an asset's blobs,
 * not just the 5 narrow decision fields), via the shared
 * `library-asset-state-codec`. Decryption (when the vault has encryption
 * enabled, the body is `{protocolVersion, sealed}` instead) is not this
 * port's job — that happens in the caller, which holds the masterKey
 * (P3C-2 / the sync engine). This port only ever sees a body it can already
 * read as the plaintext-structural shape, per the plan's test stub.
 *
 * Re-throws the codec's `AssetStateCorruptionError` as this port's own
 * public `LibraryReconciliationCorruptionError(key, cause)` so callers keep
 * relying on this port's documented error type.
 */
function parseAssetState(key: string, body: Uint8Array): LibraryAssetStateRecord {
  try {
    return decodeAssetState(body);
  } catch (cause) {
    if (cause instanceof AssetStateCorruptionError) {
      throw new LibraryReconciliationCorruptionError(key, cause);
    }
    throw cause;
  }
}

/**
 * What one pass of change discovery actually learned.
 *
 * `changed` is the point of the whole port: an asset whose listed ETag still
 * matches the index has provably not moved since this device last read it, so
 * returning it would only cost the caller a projection write that can change
 * nothing. `total` keeps the pass's scale visible without it.
 */
export type LibraryRemoteChanges = Readonly<{
  /** New, changed, or never-successfully-read assets — nothing else. */
  changed: readonly LibraryAssetStateRecord[];
  /** Indexed keys the listing no longer reports. A cleanup hint, not a delete. */
  removedKeys: readonly string[];
  /** How many `state.json` keys the listing reported, changed or not. */
  total: number;
}>;

export type LibraryReconciliationPort = Readonly<{
  /**
   * LISTs every asset's `state.json` and returns only what moved since the
   * last pass on this device (across restarts — the index is durable).
   */
  discoverChanges(): Promise<LibraryRemoteChanges>;
  /** GETs a single asset's state; `null` when it has no remote state yet. */
  getAssetState(assetId: string): Promise<LibraryAssetStateRecord | null>;
  /**
   * Records a state this device itself just wrote (the CAS PUT's key, the ETag
   * that PUT returned, and the record it wrote), so the next discovery
   * recognises this device's own write instead of paying to re-read it.
   */
  remember(
    key: string,
    etag: string,
    record: LibraryAssetStateRecord,
  ): Promise<void>;
  /**
   * N6-A3 (spec §4.3): invalidates cached/indexed state for `assetId` so a
   * failed or integrity-skipped apply is retried on the next discovery pass
   * instead of being permanently hidden behind an unchanged ETag or note name.
   */
  invalidateAsset?(assetId: string): Promise<void>;
}>;

/** One decoded state object plus the ETag of the bytes it was decoded from. */
type CachedState = Readonly<{
  etag: string;
  record: LibraryAssetStateRecord;
}>;

/**
 * How many ETag misses are re-read at once.
 *
 * A ceiling on parallelism, NOT a rate limit — there is no sleep between
 * items (`library-transfer-pool.ts`; owner mirror ruling: no throttling
 * against the user's own bucket). Deliberately the same 8 the mirror uploads
 * use (`LIBRARY_MIRROR_UPLOAD_CONCURRENCY`) against the same bucket: change
 * discovery and the mirror are the same kind of traffic, so a single number is
 * one thing to reason about. The serial `for … await` this replaced was
 * measured at ~55 s for 450 keys with exactly one request ever in flight.
 */
const DISCOVERY_CONCURRENCY = 8;

export function createLibraryReconciliationPort(
  transport: LibraryReconciliationTransport,
  prefix: string,
  index: LibraryRemoteStateIndex,
): LibraryReconciliationPort {
  /**
   * The hot half of the "local index" the protocol spec's 变更发现 section
   * diffs listing ETags against (P5 / decision #24), keyed by full object key.
   *
   * In-process, but no longer the whole truth: it is prewarmed from
   * `library_remote_state_cache` on first use and written through on every
   * fill, so a relaunch starts warm instead of re-reading the entire bucket.
   *
   * It holds the decoded record, not just the ETag, so an unchanged asset
   * needs no re-read at all. At personal scale (the spec's thousands of
   * assets) that is a few MB of small plain objects; `meta` is an opaque
   * base64url string and blob bytes are never held here.
   */
  const cache = new Map<string, CachedState>();
  let prewarmed: Promise<void> | null = null;

  /**
   * Loads the durable index into the hot map exactly once per port instance.
   * Memoized on the promise, not a boolean, so concurrent first calls share
   * one read; a failed load is retried rather than remembered, because an
   * empty map is only ever a performance loss, never a correctness one.
   */
  function prewarm(): Promise<void> {
    prewarmed ??= (async () => {
      for (const row of await index.getAll()) {
        attachAssetStateKey(row.record, `s3:${row.record.revision}`);
        cache.set(row.key, { etag: row.etag, record: row.record });
      }
    })().catch((error: unknown) => {
      prewarmed = null;
      throw error;
    });
    return prewarmed;
  }

  /**
   * Records a freshly read state, keyed on the ETag the read itself returned
   * (the version of the bytes actually decoded — which, under a write that
   * raced the listing, is newer than the listed one).
   *
   * An empty ETag (the transport's fallback when a backend omits the header)
   * proves nothing about freshness, so it evicts instead of caching: the next
   * pass re-reads rather than risking a stale hit.
   */
  async function remember(
    key: string,
    etag: string,
    record: LibraryAssetStateRecord,
  ): Promise<void> {
    if (etag === '') {
      await index.deleteKeys([key]);
      cache.delete(key);
      return;
    }
    attachAssetStateKey(record, `s3:${record.revision}`);
    await index.upsertMany([{ key, etag, record }]);
    cache.set(key, { etag, record });
  }

  async function forget(key: string): Promise<void> {
    await index.deleteKeys([key]);
    cache.delete(key);
  }

  async function invalidateAsset(assetId: string): Promise<void> {
    await prewarm();
    const key = `${prefix}assets/${assetId}/state.json`;
    await forget(key);
  }

  /**
   * Change discovery, per the protocol spec's 变更发现 section: LIST the whole
   * prefix (cheap, one request per page), then GET only the keys whose ETag
   * differs from the local index — new, changed, or never-successfully-read —
   * eight at a time. An unchanged key costs nothing: no GET, and no place in
   * the result, so the caller writes nothing for it either.
   *
   * Semantics the ETag diff does not change:
   * - A tombstone is a `state.json` like any other. purge/trash CAS-overwrite
   *   the object in place, so its ETag changes and the diff re-reads it, and
   *   it comes back in `changed` like any other record.
   * - Absence from the listing stays a cleanup hint only: the key's index
   *   entry is dropped (so a later reappearance is re-read rather than served
   *   stale), the key is reported in `removedKeys`, and nothing is synthesized
   *   in its place.
   *
   * A lane rejection is re-thrown, not counted: a GET that failed leaves this
   * device's knowledge of that key exactly as stale as before, and resolving
   * as "no change here" would let the cycle complete, move its watermark, and
   * silently skip a real remote change until that object next moves.
   */
  async function discoverChanges(): Promise<LibraryRemoteChanges> {
    await prewarm();

    const listed: { key: string; etag: string }[] = [];
    let token: string | undefined;
    do {
      const page = await transport.listObjects(`${prefix}assets/`, token);
      for (const item of page.objects) {
        if (item.key.endsWith('/state.json')) {
          listed.push({ key: item.key, etag: item.etag });
        }
      }
      token = page.nextToken;
    } while (token !== undefined);

    const present = new Set(listed.map((item) => item.key));
    // An index entry never holds an empty ETag (`remember` evicts instead, and
    // the table CHECKs it), so a listed key whose backend reports no ETag can
    // never match one and needs no special case here — it is simply a miss.
    const misses = listed.filter(({ key, etag }) => cache.get(key)?.etag !== etag);

    const changed: LibraryAssetStateRecord[] = [];
    const fetched: { key: string; etag: string; record: LibraryAssetStateRecord }[] = [];
    const vanished: string[] = [];
    const failures: unknown[] = [];

    await runTransferPool(
      misses,
      async ({ key }) => {
        let result: S3GetResult | null;
        try {
          result = await transport.getObject(key);
        } catch (error) {
          // The pool counts a rejection and moves on; this keeps the reason so
          // the whole pass can fail with it once every lane has drained.
          failures.push(error);
          return;
        }
        if (result === null) {
          // Listed a moment ago, gone now (concurrent purge/expiry between
          // the LIST and this GET). Not corruption — a later reconciliation
          // pass converges naturally once the deletion is fully visible.
          vanished.push(key);
          return;
        }
        let record: LibraryAssetStateRecord;
        try {
          const parsed = parseAssetState(key, result.body);
          record = attachAssetStateKey(parsed, `s3:${parsed.revision}`);
        } catch (error) {
          failures.push(error);
          return;
        }
        if (result.etag === '') {
          vanished.push(key);
        } else {
          fetched.push({ key, etag: result.etag, record });
        }
        changed.push(record);
      },
      { concurrency: DISCOVERY_CONCURRENCY },
    );

    if (failures.length > 0) throw failures[0];

    const removedKeys = [...cache.keys()].filter((key) => !present.has(key));

    // Durable truth first, memory second: this is the key set the hot map is
    // about to hold once this pass's writes land, computed without mutating
    // `cache` yet. That way a rejected write below leaves the in-memory map
    // exactly as it was — the next pass in this same process still finds
    // these keys uncached and re-reads them — instead of caching a change the
    // durable index never actually recorded.
    const survivors = new Set(cache.keys());
    for (const { key } of fetched) survivors.add(key);
    for (const key of [...vanished, ...removedKeys]) survivors.delete(key);

    await index.upsertMany(fetched);
    // One statement for both kinds of forgetting: a key the listing dropped
    // and a key whose GET found nothing are equally "not indexed any more",
    // and the surviving set is exactly what the hot map is about to hold.
    await index.deleteMissing([...survivors]);

    for (const { key, etag, record } of fetched) cache.set(key, { etag, record });
    for (const key of [...vanished, ...removedKeys]) cache.delete(key);

    return { changed, removedKeys, total: listed.length };
  }

  async function getAssetState(
    assetId: string,
  ): Promise<LibraryAssetStateRecord | null> {
    const key = `${prefix}assets/${assetId}/state.json`;
    const result = await transport.getObject(key);
    if (result === null) {
      await forget(key);
      return null;
    }
    const parsed = parseAssetState(key, result.body);
    const record = attachAssetStateKey(parsed, `s3:${parsed.revision}`);
    // The engine's post-drain targeted convergence and the protect action
    // both read through here; indexing the result means the next discovery
    // recognises this device's own writes instead of re-GETting them.
    await remember(key, result.etag, record);
    return record;
  }

  return { discoverChanges, getAssetState, remember, invalidateAsset };
}
