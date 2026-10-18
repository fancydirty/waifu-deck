import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';

/** Which backend family an adapter speaks; for logs and settings copy. */
export type CloudObjectStoreKind = 'webdav' | 'onedrive' | 'gdrive';

/** One flat listing row. `size` is null when the backend omits it. */
export type CloudObjectListEntry = Readonly<{
  name: string;
  size: number | null;
}>;

/**
 * P12-B (spec §4 补裁 2026-09-19): bytes that have ARRIVED for a `get`, and
 * the length the server announced (`Content-Length`) — `null` when it
 * announced none. `null` is a real answer, not a placeholder: the tile draws
 * an indeterminate spinner for it instead of dividing by a guess.
 */
export type CloudGetProgress = Readonly<{ sent: number; total: number | null }>;

/**
 * Board #12 (spec §4): the four core actions (put/get/list/delete) every
 * cloud-drive backend must offer, plus `putFromFile`, `ensureLayout` and
 * `quota`. Deliberately smaller than the S3 transport: no conditional writes,
 * no ETags, no read-after-write promise. The append-only protocol v2
 * (library-cloud-client-append.ts, library-reconciliation-append.ts) is what
 * makes those four actions sufficient — Drive v3 has no ETag and OpenList-backed
 * WebDAV lists with a cache delay, so any protocol that needed more would be
 * broken on exactly the backends this exists for.
 * `path` is one of three shapes: a slash-free root name (`vault-meta.json` is
 * one), `state/<name>`, or `blobs/<name>`; each adapter maps those onto its
 * own addressing (WebDAV paths; Drive's folder id + file name). `''`, a
 * trailing slash, and nested paths are refused.
 */
export type CloudObjectStore = Readonly<{
  kind: CloudObjectStoreKind;
  /** Whole-object write from memory: notes and `vault-meta.json`. */
  put(path: string, body: Uint8Array, contentType: string): Promise<void>;
  /**
   * The blob path: streams an already-sealed file from disk through the native
   * foreground-service upload (spec §4, 走原生前台服务上传), so a multi-megabyte
   * original never passes through JS and keeps going while the screen is off.
   * `onProgress` reports bytes sent for the transfer ring.
   */
  putFromFile(
    path: string,
    fileUri: string,
    contentType: string,
    onProgress?: (sent: number) => void,
  ): Promise<void>;
  /**
   * Resolves to null when the object is absent, rather than throwing.
   * `onProgress` (P12-B) is optional for callers, not for adapters: a
   * streaming adapter reports every chunk; one that cannot stream still owes
   * at least the final `{ sent: length }` report — that is what makes `sent`
   * verifiable, and the contract suite requires it. Nothing is reported for
   * an absent object. The client marks the ring indeterminate before calling
   * and clears it afterwards either way.
   */
  get(path: string, onProgress?: (progress: CloudGetProgress) => void): Promise<Uint8Array | null>;
  /** Streams a blob into an existing caller-owned file without buffering it in JS. */
  getToFile?(
    path: string,
    fileUri: string,
    onProgress?: (progress: CloudGetProgress) => void,
  ): Promise<{ bytesWritten: number } | null>;
  /**
   * One flat folder; the adapter paginates internally.
   *
   * Only `'state'` and `''` are listable, and that is the whole point.
   * `blobs/` is never listed (spec §3.1): every blob is fetched by the
   * generationId a note already names, so listing it would be a large, purely
   * wasted request on metered drive APIs. The one job that would need it —
   * orphan-blob reclamation — is deferred (spec §10).
   *
   * `''` (the bind root) exists for the adapter's own bookkeeping — a root-
   * object sanity listing, not dedupe. Drive lets two files share a name;
   * resolving that duplicate by backend `createdTime` (deleting the loser by
   * file id) is entirely the Drive adapter's job (spec §3.4). This port only
   * promises a stable read of a duplicated name: the earliest-created copy.
   */
  list(folder: 'state' | ''): Promise<readonly CloudObjectListEntry[]>;
  /** Idempotent: deleting an absent object is a success. */
  delete(path: string): Promise<void>;
  /** Bind-time only: creates `<root>/`, `state/` and `blobs/` if absent. */
  ensureLayout(): Promise<void>;
  /**
   * Outer null = this backend reports no quota at all, so the UI shows no
   * capacity rather than a guess. Inner `totalBytes: null` = it reports usage
   * but not capacity, so "N used" is honest and "N of M" is not.
   */
  quota(): Promise<
    Readonly<{ usedBytes: number; totalBytes: number | null }> | null
  >;
}>;

/** Spec §4: the transport-level categories an adapter may report. */
export type CloudStoreFailureCategory =
  | 'network'
  | 'auth'
  | 'quota_full'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'client';

/**
 * Whether a category, on its own, proves the write did not land.
 *
 * `network` / `server` / `rate_limited` do not: the request may have been
 * received and applied before the connection dropped or the gateway answered,
 * so the only safe reading is "unknown". The other four are a real answer from
 * the remote refusing the request — rejected credentials, an absent object, a
 * malformed request, a full drive — and nothing was written.
 *
 * This is the DEFAULT, not the rule: an adapter that genuinely knows better
 * (a 500 from a backend that documents an atomic reject, say) passes the 4th
 * argument explicitly.
 */
const OUTCOME_KNOWN_BY_DEFAULT: Readonly<
  Record<CloudStoreFailureCategory, boolean>
> = {
  network: false,
  server: false,
  rate_limited: false,
  auth: true,
  not_found: true,
  client: true,
  quota_full: true,
};

/**
 * The transport-level error every `CloudObjectStore` adapter raises. It is the
 * cloud-drive twin of `S3TransportError`: adapters classify their own protocol
 * noise (HTTP status, WebDAV multistatus, Graph/Drive error bodies) exactly
 * once, here, so nothing downstream has to know which backend produced it.
 *
 * `outcomeKnown` defaults FROM the category rather than to a flat `true`
 * because three hand-written adapters (WebDAV, OneDrive, Drive) will throw
 * these from dozens of call sites. A forgotten 4th argument has to fail safe:
 * `true` asserts "the remote refused, nothing landed", and `isKnownNotApplied`
 * reads that flag to decide whether durable intent may be dropped. Defaulting
 * a dropped connection to `true` would silently discard a write that had in
 * fact been applied — the expensive direction of the mistake.
 */
export class CloudStoreError extends Error {
  readonly outcomeKnown: boolean;

  constructor(
    readonly status: number,
    readonly category: CloudStoreFailureCategory,
    message: string,
    /**
     * `true` only when the remote answered and refused the request, so nothing
     * was written. `false` means the write may already have landed and the
     * caller must not discard its durable intent. Omit it to take the
     * category's safe default (`OUTCOME_KNOWN_BY_DEFAULT`).
     */
    outcomeKnown?: boolean,
  ) {
    super(message);
    this.name = 'CloudStoreError';
    this.outcomeKnown = outcomeKnown ?? OUTCOME_KNOWN_BY_DEFAULT[category];
    Object.setPrototypeOf(this, CloudStoreError.prototype);
  }
}

/** A file port could not create or complete the caller's local destination. */
export class CloudStoreLocalWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudStoreLocalWriteError';
    Object.setPrototypeOf(this, CloudStoreLocalWriteError.prototype);
  }
}

/**
 * Maps a `CloudStoreError` onto the design's user-action categories
 * (`LibraryFailureCategory`) per the spec §4 table, so the cloud-drive path
 * reuses the sync engine's existing halting/retry decisions unchanged.
 *
 * `quota_full` is the one category with no S3 counterpart: it passes straight
 * through as its own `LibraryFailureCategory` rather than folding into
 * `offline` or `integrity`. The drive is full — a product state only the user
 * can clear — so it must halt like `auth_attention`, not spend requests on a
 * retry that cannot succeed and not read as corruption.
 */
export function classifyCloudStoreError(
  error: CloudStoreError,
): LibraryFailureCategory {
  switch (error.category) {
    case 'auth':
      return 'auth_attention';
    case 'network':
    case 'rate_limited':
    case 'server':
      // All three are retryable transport trouble with no user action
      // available; the sync engine's existing 'offline' handling (bounded
      // backoff, not halting) is exactly what they need.
      return 'offline';
    case 'quota_full':
      return 'quota_full';
    case 'not_found':
      return 'object_missing';
    case 'client':
      // Any other 4xx (malformed request, rejected name, etc.): not transport
      // trouble and not something a retry fixes, so it goes to the same
      // terminal bucket the S3 bridge uses for its own `client` case.
      return 'integrity';
    default: {
      const exhaustive: never = error.category;
      return exhaustive;
    }
  }
}

/**
 * Adapts a `CloudStoreError` into the `LibraryCloudError` shape that
 * `library-sync-engine.ts` already knows how to consume, mirroring
 * `library-s3-error-bridge.ts`'s `toLibraryCloudError`. Wrapping every
 * adapter error through this function lets the engine's pre-existing
 * `instanceof LibraryCloudError` catch blocks classify cloud-drive backends
 * with no changes of their own.
 *
 * `outcomeKnown` is carried through unchanged: a write whose outcome the
 * adapter could not confirm (connection cut mid-send, or a 5xx/429 that may
 * have been applied before failing) must stay unknown here too, because
 * `isKnownNotApplied` reads this flag directly to decide whether durable
 * intent may be discarded.
 */
export function toLibraryCloudErrorFromStore(
  error: CloudStoreError,
): LibraryCloudError {
  return new LibraryCloudError(
    error.status,
    `store_${error.category}`,
    classifyCloudStoreError(error),
    error.message,
    error.outcomeKnown,
  );
}
