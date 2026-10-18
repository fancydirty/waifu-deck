import type {
  GetObjectToFileOptions,
  GetOptions,
  PutFromFileOptions,
  PutOptions,
  S3GetResult,
  S3TransferProgress,
} from '@/features/byos/s3-transport';
import { S3LocalWriteError, S3TransportError } from '@/features/byos/s3-transport-types';

import {
  AssetStateCorruptionError,
  attachAssetStateKey,
  decodeAssetState,
  encodeAssetState,
  type LibraryAssetStateGenerations,
  type LibraryAssetStateRecord,
} from './library-asset-state-codec';
import { LibraryCloudError } from './library-cloud-errors';
import type {
  LibraryMutationDecision,
  LibraryRemoteAssetState,
  LibraryRemoteMutation,
} from './library-mutation-decision';
import { toLibraryCloudError } from './library-s3-error-bridge';
import type { LibraryTransferProgressStore } from './library-transfer-progress';

/**
 * BYOS S3-backed `LibraryCloudClient` — the per-asset CAS write path from the
 * protocol spec
 * (`docs/superpowers/specs/2026-08-28-byos-s3-sync-protocol-design.md`,
 * "每资产状态对象（CAS 源真）" section) and P3C decisions #2/#3
 * (`docs/superpowers/specs/2026-08-28-byos-p3c-decisions.md`).
 *
 * Deliberately built on the NARROW `LibraryRemoteAssetState`/
 * `LibraryRemoteMutation` types from `./library-mutation-decision`, not the
 * wider Worker-REST-shaped same-named types the deleted `library-cloud-client`
 * once exported (per-role generation-id triad, quota accounting, mutationId/
 * reservationId baked into the mutation itself) — see that module's header
 * comment for why the two were intentionally incompatible. This file never
 * depended on the Worker cloud client; see `S3LibraryRemoteMutationResult`
 * below for what that means for the sync engine wiring.
 *
 * Five-step CAS write path, run once per run of CONSECUTIVE same-asset
 * mutations in a batch ("group" below — K6-1b; a lone mutation is a group of
 * one and behaves exactly as before):
 *   1. For every mutation in the group that carries new content-addressed
 *      bytes, PUT them to `blobs/<generationId>` unconditionally, before
 *      touching state.json — interruption safety: other devices only ever see
 *      a fully-written generation once state.json references it ("blob first,
 *      state second").
 *   2. GET `assets/<assetId>/state.json` ONCE for the whole group; record its
 *      ETag. A missing object (transport returns `null`) means `asset = null`.
 *   3. Run the injected `decide` (production `decideLibraryMutation`) for each
 *      mutation in turn, against the record as the group has rolled it so far,
 *      projected down to the 5 narrow decision fields — `decide` itself is
 *      untouched by this module and never sees
 *      `generations`/`lastMutationId`/`trashedAt`. Per P3C decision #3,
 *      `minBaseCursor` is always 0 — BYOS has no account-wide cursor, only
 *      per-asset revisions. `decide` is pure, so rolling the record forward in
 *      memory is equivalent to submitting the group one mutation at a time,
 *      and every mutation still gets its own applied/merged/rejected result.
 *   4. `applied` -> build the next full `LibraryAssetStateRecord` by
 *      PRESERVING the existing record's carried fields (see
 *      `buildNextRecord` below — this is the fix for the CAS-overwrite data
 *      loss bug: rebuilding state from only the 5 narrow decision fields
 *      would silently erase `generations`/`lastMutationId`/`trashedAt` on
 *      every applied mutation). After the whole group has been decided, PUT
 *      the final record ONCE, `If-Match: <etag>` (or `If-None-Match: '*'`
 *      when the asset didn't exist). A group in which nothing applied
 *      (`merged`/`rejected` only) writes nothing.
 *   5. A `precondition` (412/409) PUT failure means another writer raced us:
 *      re-GET IMMEDIATELY, replay the WHOLE group's decisions against the
 *      fresh record, and retry, bounded to 5 total attempts. Attempts
 *      exhausted -> every mutation in the group resolves as a
 *      `rejected`/`resync_required` result (never thrown — the local intents
 *      are still durable and the outbox decides what to do next).
 *
 *      K7 ⑭: there is no sleep between attempts. A 412 is the server saying
 *      the other writer's PUT has ALREADY completed, so its new ETag is
 *      readable this instant; the old 200/400/800/1600 ms exponential backoff
 *      was multi-tenant congestion control pointed at a bucket with exactly
 *      one tenant — the user — and it sat on the save path, because the
 *      believed-new fast path below takes a 412 by design every time a second
 *      device (or a reinstall) meets an asset the bucket already holds.
 *
 * A `state.json` GET that decodes to a corrupt/malformed existing record
 * (`AssetStateCorruptionError`) is isolated to that one asset's group of
 * results (`rejected` / `corrupt_remote_state`) rather than aborting the whole
 * `submitMutations` batch — see `submitMutations` below.
 *
 * `sessionToken` does not appear anywhere in this module's signatures: SigV4
 * credentials are bound once at `S3Transport` construction, not threaded
 * per-call (P3C decision #2).
 */

/**
 * The subset of `S3Transport` this client depends on. Kept structural
 * (rather than importing `createS3Transport`'s return type) so unit tests
 * can inject a plain fake without implementing `deleteObject`/`listObjects`
 * — the same pattern `library-reconciliation-port.ts` uses.
 */
export type S3LibraryTransportPort = Readonly<{
  putObject(
    key: string,
    body: Uint8Array,
    options: PutOptions,
  ): Promise<{ etag: string | null }>;
  getObject(key: string, options?: GetOptions): Promise<S3GetResult | null>;
  getObjectToFile?(
    key: string,
    fileUri: string,
    options?: GetObjectToFileOptions,
  ): Promise<{ etag: string; bytesWritten: number } | null>;
  downloadFileAvailable?: boolean;
  /**
   * K6-2: the file-backed PUT that reports real `bytesSent` (spec §2 G3).
   * Optional so the many hand-written fakes in the unit suites stay valid;
   * `writeBlob` below falls back to the in-memory `putObject` when it — or
   * `blobStaging` — is absent, which is the pre-K6-2 behaviour minus progress.
   * Production always has both (pinned by `src/test/k6-2-progress-wiring.test.ts`).
   */
  putObjectFromFile?(
    key: string,
    fileUri: string,
    options: PutFromFileOptions,
  ): Promise<{ etag: string | null }>;
  /** Lowercase hex SHA-256, for the file path's `x-amz-content-sha256`. */
  hashPayload?(bytes: Uint8Array): Promise<string>;
}>;

/**
 * The narrow slice of `LibraryFilePort` a staged blob upload needs: a name in
 * the app's cache-backed temp area, a write, and a delete. Narrow on purpose —
 * this module has no business with originals, trash, or the cache index.
 */
export type S3LibraryBlobStagingPort = Readonly<{
  resolveTemp(name: string): string;
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
  delete(uri: string): Promise<void>;
}>;

export type DecideLibraryMutationFn = (
  asset: LibraryRemoteAssetState | null,
  mutation: LibraryRemoteMutation,
  minBaseCursor: number,
) => LibraryMutationDecision;

/** Which rendition a mutation's new blob backs. Defaults to `'original'` when omitted. */
export type LibraryGenerationRole = 'thumbnail' | 'preview' | 'original';

/**
 * One outbox entry. A structural superset of the narrow
 * `LibraryRemoteMutation` (assignable to it wherever `decide` is called),
 * plus the things the decision table itself doesn't need: a local
 * `mutationId` for outbox/result correlation, and the new blob bytes (if
 * any) this mutation introduces.
 */
export type S3LibraryPendingMutation = LibraryRemoteMutation &
  Readonly<{
    mutationId: string;
    /**
     * Present when this mutation also uploads new content-addressed bytes
     * (e.g. a fresh import's original/thumbnail/preview object). `null` for
     * mutations that only change lifecycle/protection (trash, restore,
     * stop-protection, permanent-delete). `role` says which rendition the
     * blob backs; defaults to `'original'` when omitted (every pre-existing
     * caller only ever uploaded the original).
     */
    newBlob: Readonly<{
      generationId: string;
      bytes: Uint8Array;
      role?: LibraryGenerationRole;
    }> | null;
    /**
     * P3C-2 addition (Task 6): lets a caller that already uploaded blobs for
     * multiple roles out-of-band via `putBlob` (the "protect" flow's 3-role
     * upload) fold all of them into `generations` with a single mutation,
     * instead of the one-`newBlob`-per-mutation shape above. On an `applied`
     * decision, `buildNextRecord` merges this AFTER the `newBlob` merge —
     * patch entries win over `newBlob` on the same role, and roles this
     * patch doesn't mention are preserved from whatever `newBlob`/`existing`
     * already produced. Still subject to the purge-tombstone carve-out: a
     * `purged` decision forces `generations` to `{}` regardless of any patch
     * supplied here. An explicit `undefined` value for a role is treated as
     * "no change to that role", not "clear it" (see `compactGenerations`).
     *
     * Caller obligation: the caller MUST have already completed a
     * successful `putBlob(generationId, bytes)` call for every
     * `generationId` this patch references BEFORE submitting the mutation
     * that carries the patch. This module does not upload the patch's blobs
     * itself and has no way to verify they exist — submit the mutation
     * first and another device can read a `state.json` that references a
     * `generationId` whose blob was never (or not yet) written, breaking
     * the "blob durable before state" invariant that Step 1 of the CAS
     * write path enforces automatically for `newBlob` (see the module
     * header). `generationsPatch` moves that invariant's enforcement from
     * this module onto the caller.
     *
     * K7 ⑨: this is also now a decision INPUT, declared on the narrow
     * `LibraryRemoteMutation` — a `protect` whose patch names only derived
     * roles, against an already-protected asset, applies instead of merging
     * (see `decideLibraryMutation`'s `protect` branch). The merge rules above
     * are unchanged.
     */
    generationsPatch?: LibraryAssetStateGenerations;
    /**
     * P3C-2 Task 9 (this module's `meta` field) addition: the sealed asset-
     * metadata envelope to carry on this mutation's applied result, produced
     * by the injected cipher's `sealMetadata` (an opaque base64url string —
     * see `library-asset-state-codec.ts`'s module header for what it
     * contains and why it's opaque here). Same "carried field" merge rule
     * as `generations`: `undefined` means "this mutation doesn't change
     * meta" (the existing record's `meta`, if any, is preserved verbatim —
     * NEVER null-erased just because this mutation omitted it; a
     * trash-then-restore round trip must not lose the second device's only
     * route to materializing the asset), a present string always overrides
     * whatever `existing` had, and the purge-tombstone carve-out (see
     * `buildNextRecord`) strips it exactly like `generations`, regardless of
     * what this mutation supplies.
     */
    meta?: string;
  }>;

type RejectionReason = Extract<
  LibraryMutationDecision,
  { outcome: 'rejected' }
>['reason'];

/**
 * `RejectionReason` (the decision table's rejection reasons, `LibraryRemoteRejection`
 * in `./library-mutation-decision`) widened with a reason this module itself can
 * produce: an existing `state.json` that fails to decode. None of the existing
 * `LibraryRemoteRejection` values describe "the remote object is corrupt", so
 * this documents a new one scoped to this module rather than touching the
 * `LibraryRemoteRejection` union.
 */
export type S3LibraryRemoteRejectionReason = RejectionReason | 'corrupt_remote_state';

/**
 * NOT the wide Worker-shaped mutation result the deleted `library-cloud-client`
 * once carried — that type's `asset` field was the wide,
 * per-role-generation-id `LibraryRemoteAssetState`, which this client never
 * produces (see module header). Field-for-field parallel to it otherwise
 * (`mutationId`/`assetId`/`kind`/`outcome`/`reason`/`revision`/`asset`), so
 * a consumer that only keys off `results[i].mutationId` — which is all
 * `drain()` needs per P3C decision #3 — sees the same shape either way.
 * `asset` is the full `LibraryAssetStateRecord` (not just the 5 narrow
 * decision fields): a caller resolving where a rendition's blob lives needs
 * `generations`, and this is the only place that record is available right
 * after a write. P3C-2 must decide how the sync engine's `LibraryCloudClient`
 * union/adapter reconciles this narrower `asset` with the wide one before
 * wiring this client in.
 */
export type S3LibraryRemoteMutationResult = Readonly<{
  mutationId: string;
  assetId: string;
  kind: LibraryRemoteMutation['kind'];
  outcome: 'applied' | 'merged' | 'rejected';
  reason: S3LibraryRemoteRejectionReason | null;
  revision: number | null;
  asset: LibraryAssetStateRecord | null;
}>;

export type LibraryCloudClient = Readonly<{
  submitMutations(
    input: Readonly<{ mutations: readonly S3LibraryPendingMutation[] }>,
  ): Promise<
    Readonly<{
      cursor: 0;
      minBaseCursor: 0;
      results: readonly S3LibraryRemoteMutationResult[];
    }>
  >;
  /** Passthrough to the transport's content-addressed blob GET. */
  getObject(generationId: string): Promise<Uint8Array | null>;
  getObjectToFile(generationId: string, fileUri: string): Promise<{ etag: string } | null>;
  /**
   * P3C-2 addition (Task 6): a thin unconditional PUT to
   * `blobs/<generationId>`, exposed standalone for the protect flow's
   * 3-role blob upload (thumbnail/preview/original each get their own
   * `putBlob` call, then one mutation with `generationsPatch` folds all
   * three into `generations` — see that field's doc comment above). Shares
   * the same key construction and transport call as the `newBlob` path
   * inside `submitMutations`; both go through the private `writeBlob`
   * helper in `createS3LibraryCloudClient` below (DRY, not two write paths
   * to the same key that could drift).
   *
   * Caller obligation: for every `generationId` a caller intends to
   * reference in a later `generationsPatch`, the `putBlob` call for that
   * `generationId` MUST complete (its returned promise must resolve)
   * BEFORE the mutation carrying the patch is submitted. `putBlob` and
   * `submitMutations` are separate calls, so nothing inside this module can
   * enforce that ordering — the caller owns it. Submit the mutation first
   * (or concurrently) and another device can read a `state.json` that
   * references a blob object that doesn't exist yet, the same
   * "blob durable before state" hazard Step 1 of the CAS write path
   * prevents automatically for `newBlob` (see the module header).
   */
  putBlob(
    generationId: string,
    bytes: Uint8Array,
    onProgress?: (progress: S3TransferProgress) => void,
  ): Promise<void>;
  putBlobFromFile?(
    generationId: string,
    fileUri: string,
    options: Readonly<{
      contentSha256: string;
      byteLength: number;
      onProgress?: (progress: S3TransferProgress) => void;
    }>,
  ): Promise<void>;
}>;
/** Historical name; the contract has been backend-neutral since board #12 (the append client returns it too). */
export type S3LibraryCloudClient = LibraryCloudClient;

export type CreateS3LibraryCloudClientOptions = Readonly<{
  transport: S3LibraryTransportPort;
  /** e.g. `'waifu-deck/'` — must already end in `/`. */
  prefix: string;
  decide: DecideLibraryMutationFn;
  /**
   * K6-2: where a blob's ciphertext is staged so the native upload task can
   * stream it off disk and report `bytesSent`. Absent (unit fakes only) means
   * blobs take the old in-memory `putObject` path and report no progress.
   */
  blobStaging?: S3LibraryBlobStagingPort;
  /**
   * K6-2: where a content-addressed blob DOWNLOAD publishes its arriving bytes,
   * keyed by generation id (spec §2 G5). Absent means no ring is drawn.
   */
  transferProgress?: LibraryTransferProgressStore;
  /**
   * K7 cut 3 / audit ⑪: told the key, the ETag the PUT returned, and the
   * record that landed, every time a CAS write commits.
   *
   * Bound to the reconciliation port's `remember` in production. A successful
   * write already knows everything change discovery would otherwise pay a GET
   * to learn — the engine's post-drain `converge()` re-reads each committed
   * asset, and the next cycle's diff would see an ETag it has never seen. With
   * this, both are index hits.
   *
   * Optional: the many hand-written fakes in the unit suites, and any
   * composition without an index, simply don't pass it and behave as before.
   * A rejection is swallowed at the call site — the bytes are durable on the
   * bucket, and stale bookkeeping costs one GET, never correctness.
   */
  rememberState?: (
    key: string,
    etag: string,
    record: LibraryAssetStateRecord,
  ) => Promise<void>;
  /**
   * Clock used to stamp `trashedAt`. Test seam for determinism; real callers
   * omit this and get `new Date().toISOString()`.
   */
  now?: () => string;
}>;

const MAX_CAS_ATTEMPTS = 5;

const defaultNow = (): string => new Date().toISOString();

function isPreconditionFailure(error: unknown): boolean {
  return (
    error instanceof S3TransportError && error.category === 'precondition'
  );
}

/**
 * Board #12: exported (not moved) so `library-cloud-client-append.ts` applies
 * the identical decision/record-building semantics to an append-only backend.
 * Behaviour and the S3 CAS path are unchanged.
 */
/** Projects the full persisted record down to the 5 fields `decide` needs. */
export function toNarrowAsset(
  record: LibraryAssetStateRecord | null,
): LibraryRemoteAssetState | null {
  if (record === null) return null;
  const { assetId, revision, generation, lifecycle, protection } = record;
  return { assetId, revision, generation, lifecycle, protection };
}

/**
 * Drops any role whose value is explicitly `undefined` from a
 * `generationsPatch` before it gets spread into `generations`. This
 * tsconfig does not set `exactOptionalPropertyTypes`, so a patch like
 * `{ original: undefined, thumbnail: 'g-t' }` type-checks as a valid
 * `LibraryAssetStateGenerations` — and a naive
 * `{...generationsWithNewBlob, ...patch}` spread would overwrite an
 * existing, still-valid `original` role with `undefined`, silently erasing
 * it: `encodeAssetState`'s `JSON.stringify` drops `undefined`-valued keys
 * entirely, so the persisted record would come out with no `original` key
 * at all, not even a `null` marker. This guard makes an explicit
 * `undefined` entry in a patch a no-op instead — the role, if any, keeps
 * whatever value `generationsWithNewBlob`/`existing` already had for it.
 */
function compactGenerations(
  patch: LibraryAssetStateGenerations,
): LibraryAssetStateGenerations {
  const compact: {
    thumbnail?: string;
    preview?: string;
    original?: string;
  } = {};
  if (patch.thumbnail !== undefined) compact.thumbnail = patch.thumbnail;
  if (patch.preview !== undefined) compact.preview = patch.preview;
  if (patch.original !== undefined) compact.original = patch.original;
  return compact;
}

/**
 * Builds the next full `LibraryAssetStateRecord` for an `applied` decision,
 * PRESERVING every carried field of `existing` that this mutation doesn't
 * touch. This is the fix: the previous implementation rebuilt state from
 * only the 5 narrow decision fields on every write, silently dropping
 * `generations`/`lastMutationId`/`trashedAt` for any asset that already had
 * them (e.g. protecting an asset that already had a thumbnail generation
 * would erase the thumbnail's blob location).
 *
 * Exception: a `purged` decision (`decision.lifecycle === 'purged'`,
 * equivalently `decision.changeKind === 'purge'`) is the one applied outcome
 * that must NOT preserve `generations` (or `meta`, added in P3C-2 Task 9 —
 * same carve-out, see below). Per the protocol spec ("每资产状态对
 * 象" section), a permanent-delete overwrites `state.json` as a SMALLER
 * tombstone that discards `generations` and `meta` — "object exists with
 * lifecycle=purged" is the
 * authoritative signal that orphan-blob GC can treat every generation this
 * asset ever referenced as unreferenced. Preserving `generations` here would
 * leave GC unable to tell the blobs are safe to reclaim. The carve-out wins
 * over `mutation.generationsPatch` too — a purge always empties
 * `generations`, whatever patch a caller supplied. Likewise it wins over any
 * `mutation.meta` a caller supplied on the same permanent-delete mutation —
 * there is no valid reason for one, but the tombstone must come out empty
 * either way.
 *
 * `meta` (P3C-2 Task 9) follows `generations`' carried-field rule exactly,
 * just without a role-keyed merge: `mutation.meta ?? existing?.meta` — a
 * present `mutation.meta` always wins (collect/protect supplying a freshly
 * sealed envelope), an absent one preserves whatever `existing` already had
 * (trash/restore/stop-protection never touch it), and the purge carve-out
 * above strips it to `undefined` regardless of either input. This is the
 * fix for the same class of bug the header docstring describes for the
 * other carried fields: rebuilding `meta` from nothing on every write would
 * silently erase the one thing a second device needs to materialize an
 * asset it has never seen locally.
 *
 * `mutation.generationsPatch` (P3C-2 Task 6), when present, is merged in
 * AFTER the `newBlob` merge below: patch entries win over `newBlob` on a
 * same-role conflict, and roles the patch doesn't mention are preserved from
 * whatever the `newBlob` merge (or `existing`, if there's no `newBlob`)
 * already produced.
 */
export function buildNextRecord(
  existing: LibraryAssetStateRecord | null,
  mutation: S3LibraryPendingMutation,
  decision: Extract<LibraryMutationDecision, { outcome: 'applied' }>,
  now: () => string,
): LibraryAssetStateRecord {
  const role: LibraryGenerationRole = mutation.newBlob?.role ?? 'original';
  const generationsWithNewBlob: LibraryAssetStateGenerations =
    mutation.newBlob === null
      ? (existing?.generations ?? {})
      : {
          ...(existing?.generations ?? {}),
          [role]: mutation.newBlob.generationId,
        };
  const generations: LibraryAssetStateGenerations =
    decision.lifecycle === 'purged'
      ? {}
      : mutation.generationsPatch === undefined
        ? generationsWithNewBlob
        : {
            ...generationsWithNewBlob,
            ...compactGenerations(mutation.generationsPatch),
          };

  // trashedAt: stamped on trash, cleared on restore, preserved otherwise —
  // never silently dropped by protect/stop-protection/permanent-delete
  // touching the same asset.
  const trashedAt: string | null =
    mutation.kind === 'trash'
      ? now()
      : mutation.kind === 'restore'
        ? null
        : (existing?.trashedAt ?? null);

  // meta: carried field, same rule as `generations` (see the doc comment
  // above) — an explicit `mutation.meta` always wins, an absent one
  // preserves `existing?.meta` verbatim, and a purge tombstone strips it
  // regardless of either input.
  const meta: string | undefined =
    decision.lifecycle === 'purged'
      ? undefined
      : (mutation.meta ?? existing?.meta);

  return {
    assetId: mutation.assetId,
    revision: (existing?.revision ?? 0) + 1,
    generation: decision.generation,
    lifecycle: decision.lifecycle,
    protection: decision.protection,
    lastMutationId: mutation.mutationId,
    trashedAt,
    generations,
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * K6-1b: splits a batch into runs of CONSECUTIVE mutations that target the
 * same asset. Consecutive, not "all mutations for asset X anywhere in the
 * batch", so a batch's order is never rearranged behind the caller's back —
 * `[A, B, A]` stays three groups, and each still decides against the state its
 * position implies.
 */
export function groupConsecutiveByAsset(
  mutations: readonly S3LibraryPendingMutation[],
): readonly (readonly S3LibraryPendingMutation[])[] {
  const groups: S3LibraryPendingMutation[][] = [];
  for (const mutation of mutations) {
    const current = groups[groups.length - 1];
    if (current !== undefined && current[0]!.assetId === mutation.assetId) {
      current.push(mutation);
      continue;
    }
    groups.push([mutation]);
  }
  return groups;
}

/**
 * K6-1b: the one convention a grouped submit needs. Submitted one at a time, a
 * caller reads result N's revision and builds mutation N+1 against it; inside a
 * group it cannot, because the record it must base on is only produced
 * in-memory here. So a non-first group member whose `baseRevision` is `null`
 * ("I have no independent base") inherits the base the group has rolled to.
 *
 * Deliberately `null`-only: a mutation that DID state a base keeps it, so a
 * genuine stale-base conflict is still detected rather than silently rebased.
 * `observedGeneration` needs no equivalent — a `null` there already means "do
 * not check the generation" in the decision table, and any non-null value is
 * the caller's own deliberate guard.
 *
 * The first mutation of a group is never rebased: it always decides against
 * the record as the bucket actually holds it, which is what keeps another
 * device's trash winning over a fresh `collect` (`trash_wins`).
 */
export function rebaseWithinGroup(
  mutation: S3LibraryPendingMutation,
  record: LibraryAssetStateRecord | null,
): S3LibraryPendingMutation {
  if (record === null || mutation.baseRevision !== null) return mutation;
  return { ...mutation, baseRevision: record.revision };
}

export function createS3LibraryCloudClient(
  options: CreateS3LibraryCloudClientOptions,
): S3LibraryCloudClient {
  const { transport, prefix, decide } = options;
  const staging = options.blobStaging;
  const transferProgress = options.transferProgress;
  const now = options.now ?? defaultNow;
  const rememberState = options.rememberState;

  const assetKey = (assetId: string): string =>
    `${prefix}assets/${assetId}/state.json`;
  const blobKey = (generationId: string): string =>
    `${prefix}blobs/${generationId}`;

  /**
   * Shared blob-write helper (P3C-2 Task 6): unconditional PUT to
   * `blobs/<generationId>`, used both by `processMutation`'s Step 1
   * (`mutation.newBlob`) and by the standalone `putBlob` exposed on the
   * returned client. One place owns this key construction + transport call
   * so the two paths can't drift.
   *
   * K6-1 (root cause F7): an unconditional blob PUT can never raise a CAS
   * precondition, so bridging its `S3TransportError` here is safe and gives
   * both callers the honest `LibraryCloudError` category (a network wobble is
   * `offline`, not the `retryable_transfer` fallback that drove re-upload
   * storms). The CAS state PUT inside `processMutation` is deliberately NOT
   * routed through here — it needs the raw `precondition` error for its retry
   * loop — so this helper only ever handles content-addressed blob writes.
   *
   * K6-2 (spec §2 G3): when a staging port and a progress-capable transport are
   * configured — which is every production build — the ciphertext is written to
   * a cache temp file and uploaded from there, because SDK 56 reports
   * `bytesSent` only for a file-backed upload task (`expo/fetch` has no upload
   * progress event at all). The bytes on the wire are identical either way: the
   * temp file holds exactly the buffer the in-memory path would have PUT, and
   * the signature commits to that same hash, computed once here from the
   * in-memory bytes rather than by re-reading the file. The temp file is always
   * deleted, success or failure — it is a transient copy of something the
   * caller still holds, so leaving one behind would be pure cache growth.
   *
   * Still ONE write path, not two: both callers come through here, and the
   * fallback exists only for unit fakes that implement neither hook.
   */
  async function writeBlob(
    generationId: string,
    bytes: Uint8Array,
    onProgress?: (progress: S3TransferProgress) => void,
  ): Promise<void> {
    const key = blobKey(generationId);
    const uploadFromFile = transport.putObjectFromFile;
    const hashPayload = transport.hashPayload;
    try {
      if (
        staging === undefined
        || uploadFromFile === undefined
        || hashPayload === undefined
      ) {
        await transport.putObject(key, bytes, {});
        return;
      }
      // Named by generation id: content-addressed and minted per attempt, so
      // three roles uploading in parallel can never share a staging file.
      const fileUri = staging.resolveTemp(`blob-${generationId}`);
      const contentSha256 = await hashPayload(bytes);
      await staging.writeBytes(fileUri, bytes);
      try {
        await uploadFromFile(key, fileUri, {
          contentSha256,
          byteLength: bytes.byteLength,
          ...(onProgress === undefined ? {} : { onProgress }),
        });
      } finally {
        await staging.delete(fileUri).catch(() => {});
      }
    } catch (error) {
      throw error instanceof S3TransportError ? toLibraryCloudError(error) : error;
    }
  }

  /**
   * K6-1b: one same-asset group — one GET, N in-memory decisions, ONE CAS PUT.
   *
   * Consecutive mutations in a batch that target the same asset used to pay a
   * full GET+PUT round trip each. On the owner's link a round trip is ~1.5 s
   * warm, so a new asset's `collect` + `protect` alone cost 3 s of pure
   * latency before any bytes moved (spec §2's five-second bar, §4.5's
   * reachability measurement). `decide` is a pure function of
   * (record, mutation), so rolling the record forward in memory across the
   * group and writing the final record once is observably identical to
   * submitting the group one mutation at a time — each mutation still gets its
   * own applied/merged/rejected result computed against the state it would
   * have seen — while paying for one round trip instead of N.
   *
   * CAS semantics are unchanged: the precondition comes from the single GET at
   * the top of the attempt (`If-None-Match: '*'` when absent, `If-Match: etag`
   * when present), and a 412 re-GETs and replays the WHOLE group's decisions
   * against the fresh record, never just the last one.
   */
  async function processGroup(
    group: readonly S3LibraryPendingMutation[],
  ): Promise<S3LibraryRemoteMutationResult[]> {
    // Step 1: unconditional blob PUTs, before any state.json traffic, for
    // every mutation in the group — "blob durable before the state.json that
    // references it" holds for the group exactly as it did per mutation.
    for (const mutation of group) {
      if (mutation.newBlob !== null) {
        await writeBlob(mutation.newBlob.generationId, mutation.newBlob.bytes);
      }
    }

    const key = assetKey(group[0]!.assetId);

    /**
     * K6-1c: the first attempt for an asset the caller believes is NEW skips
     * the state.json GET entirely and writes straight through with
     * `If-None-Match: '*'`.
     *
     * A leading `collect` that states no `baseRevision` and no
     * `observedGeneration` is exactly the caller saying "I have never seen
     * this asset" (see `library-protect-action.ts`'s fresh path, which only
     * builds that mutation when the local database has no protection row for
     * the digest). The GET's answer in that case is the assumption already
     * made — `null` — so paying a full round trip (~1.5 s warm on the owner's
     * link, spec §4.5) to hear it back is the last purely sequential stage
     * left on a new save, against spec §2's five-second bar.
     *
     * Being wrong is safe and is why the condition is `If-None-Match: '*'`
     * rather than an unconditional PUT: S3 refuses with a 412 instead of
     * overwriting another device's object, which is precisely the precondition
     * failure Step 5 below already handles — re-GET, replay the whole group,
     * write `If-Match`. So CAS is intact, `trash_wins` still wins, and only
     * the common case got cheaper. Attempt 2 onward always reads.
     */
    const first = group[0]!;
    const believedNew =
      first.kind === 'collect'
      && first.baseRevision === null
      && first.observedGeneration === null;

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      // Step 2: GET state.json, record its ETag. Absent -> record = null.
      // A present-but-corrupt body throws AssetStateCorruptionError, which
      // propagates out of processGroup — submitMutations isolates it to this
      // one asset's mutations instead of aborting the batch.
      const existing = attempt === 1 && believedNew
        ? null
        : await transport.getObject(key);
      const existingRecord: LibraryAssetStateRecord | null =
        existing === null
          ? null
          : (() => {
            const decoded = decodeAssetState(existing.body);
            return attachAssetStateKey(decoded, `s3:${decoded.revision}`);
          })();

      let record: LibraryAssetStateRecord | null = existingRecord;
      let anyApplied = false;
      const results: S3LibraryRemoteMutationResult[] = [];

      for (const [index, mutation] of group.entries()) {
        // Step 3: local decision, against the 5-field narrow projection of the
        // record as this group has rolled it so far. BYOS is per-asset, so
        // minBaseCursor is always 0 (P3C decision #3).
        const decided = index === 0 ? mutation : rebaseWithinGroup(mutation, record);
        const decision = decide(toNarrowAsset(record), decided, 0);

        if (decision.outcome !== 'applied') {
          // Step 4 (merged/rejected branch): this mutation contributes nothing
          // to the record; the rest of the group still gets its turn.
          results.push({
            mutationId: mutation.mutationId,
            assetId: mutation.assetId,
            kind: mutation.kind,
            outcome: decision.outcome,
            reason: decision.outcome === 'rejected' ? decision.reason : null,
            revision: record?.revision ?? null,
            asset: record,
          });
          continue;
        }

        const nextRecord = buildNextRecord(record, decided, decision, now);
        record = attachAssetStateKey(nextRecord, `s3:${nextRecord.revision}`);
        anyApplied = true;
        results.push({
          mutationId: mutation.mutationId,
          assetId: mutation.assetId,
          kind: mutation.kind,
          outcome: 'applied',
          reason: null,
          revision: record.revision,
          asset: record,
        });
      }

      // Nothing applied: write nothing, exactly as the per-mutation path did.
      if (!anyApplied || record === null) return results;

      try {
        // Step 4 (applied branch): the ONE CAS PUT this group pays for.
        const putOptions: PutOptions =
          existing === null ? { ifNoneMatch: '*' } : { ifMatch: existing.etag };
        const written = await transport.putObject(
          key,
          encodeAssetState(record),
          putOptions,
        );
        // K7 cut 3: this device now knows the authoritative (key, etag,
        // record) triple for an object it just wrote. Telling the change
        // -discovery index means the post-drain convergence and the next
        // cycle's diff both recognise this write instead of re-reading it. A
        // backend that omitted the ETag header proves nothing about freshness,
        // so there is nothing worth recording then.
        if (rememberState !== undefined && written.etag !== null) {
          try {
            await rememberState(key, written.etag, record);
          } catch {
            // Bookkeeping only. The mutation committed; a failed index write
            // costs exactly one GET on the next pass.
          }
        }
        return results;
      } catch (error) {
        // Step 5: another writer raced us. Re-GET immediately, replay the
        // whole group's decisions against the fresh record, retry, bounded.
        if (isPreconditionFailure(error) && attempt < MAX_CAS_ATTEMPTS) {
          // K7 ⑭: straight back to the top of the loop — the next iteration's
          // GET reads the winner's record. Nothing is gained by waiting for a
          // bucket that is not contended.
          continue;
        }
        if (isPreconditionFailure(error)) {
          // Exhausted retries: resolve as results, don't throw — the local
          // intents are still durable and the outbox decides what to do next.
          return group.map((mutation) => ({
            mutationId: mutation.mutationId,
            assetId: mutation.assetId,
            kind: mutation.kind,
            outcome: 'rejected' as const,
            reason: 'resync_required' as const,
            revision: null,
            asset: null,
          }));
        }
        throw error;
      }
    }
    // Unreachable: every loop iteration returns or throws above. Present
    // only to satisfy the compiler's control-flow analysis.
    throw new Error('unreachable: CAS loop exited without a result');
  }

  return {
    async submitMutations({ mutations }) {
      const results: S3LibraryRemoteMutationResult[] = [];
      for (const group of groupConsecutiveByAsset(mutations)) {
        // One GET + one CAS PUT per same-asset group (see `processGroup`).
        // Isolated: a corrupt EXISTING remote state for one asset rejects only
        // that asset's mutations (`corrupt_remote_state`) instead of aborting
        // the rest of the batch — other assets' mutations are unrelated and
        // should still get a chance to apply.
        try {
          results.push(...(await processGroup(group)));
        } catch (error) {
          if (error instanceof AssetStateCorruptionError) {
            for (const mutation of group) {
              results.push({
                mutationId: mutation.mutationId,
                assetId: mutation.assetId,
                kind: mutation.kind,
                outcome: 'rejected',
                reason: 'corrupt_remote_state',
                revision: null,
                asset: null,
              });
            }
            continue;
          }
          // K6-1 (root cause F7): a transport failure that escaped the CAS
          // retry loop (a network cut, a 5xx GET/PUT) must reach the caller as
          // a category-bearing LibraryCloudError, not a raw S3TransportError
          // that protect would misclassify as `retryable_transfer`. Precondition
          // failures never reach here — they resolve to a `resync_required`
          // result inside `processGroup` — so this only bridges genuine
          // transport trouble, carrying `outcomeKnown` through unchanged.
          throw error instanceof S3TransportError ? toLibraryCloudError(error) : error;
        }
      }
      return { cursor: 0, minBaseCursor: 0, results };
    },
    async getObject(generationId) {
      const key = blobKey(generationId);
      try {
        // K6-2 (spec §2 G5): 下凡 gets the same real ring as 上云, keyed by the
        // generation being fetched rather than by digest — this module knows
        // generations, not digests, and the tile already holds its asset's
        // `originalGenerationId`. That key choice is also what keeps the ring
        // honest about WHICH bytes are moving: a grid thumbnail resolve pulls a
        // thumbnail generation, which no tile is watching, so only a real
        // original download ever draws one.
        const result = await transport.getObject(
          key,
          transferProgress === undefined
            ? undefined
            : { onProgress: (progress) => transferProgress.set(generationId, progress) },
        );
        return result === null ? null : result.body;
      } catch (error) {
        // Same bridge as writeBlob: a blob GET carries no CAS precondition, so
        // any S3TransportError here is transport trouble the caller classifies
        // by category (offline/auth_attention/…), never `retryable_transfer`.
        throw error instanceof S3TransportError ? toLibraryCloudError(error) : error;
      } finally {
        // Arrived, missing, or failed — nothing is in flight any more.
        transferProgress?.clear(generationId);
      }
    },
    async getObjectToFile(generationId, fileUri) {
      const key = blobKey(generationId);
      transferProgress?.set(generationId, { sent: 0, total: null });
      try {
        const fileGet = transport.downloadFileAvailable === false
          ? undefined
          : transport.getObjectToFile;
        if (fileGet !== undefined) {
          const result = await fileGet(
            key,
            fileUri,
            transferProgress === undefined
              ? undefined
              : { onProgress: (progress) => transferProgress.set(generationId, progress) },
          );
          return result === null ? null : { etag: result.etag };
        }
        const result = await transport.getObject(
          key,
          transferProgress === undefined
            ? undefined
            : { onProgress: (progress) => transferProgress.set(generationId, progress) },
        );
        if (result === null) return null;
        if (staging === undefined) {
          throw new Error('S3 getObjectToFile fallback requires a file port');
        }
        try {
          await staging.writeBytes(fileUri, result.body);
        } catch (error) {
          throw new S3LocalWriteError(error instanceof Error ? error.message : String(error));
        }
        return { etag: result.etag };
      } catch (error) {
        if (error instanceof S3LocalWriteError) {
          throw new LibraryCloudError(
            0,
            's3_local_write',
            'local_space',
            error.message,
            true,
          );
        }
        if (error instanceof S3TransportError) throw toLibraryCloudError(error);
        throw error;
      } finally {
        transferProgress?.clear(generationId);
      }
    },
    putBlob: writeBlob,
    ...(transport.putObjectFromFile === undefined
      ? {}
      : {
          async putBlobFromFile(
            generationId: string,
            fileUri: string,
            options: Readonly<{
              contentSha256: string;
              byteLength: number;
              onProgress?: (progress: S3TransferProgress) => void;
            }>,
          ): Promise<void> {
            const key = blobKey(generationId);
            try {
              await transport.putObjectFromFile!(key, fileUri, {
                contentSha256: options.contentSha256,
                byteLength: options.byteLength,
                ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
              });
            } catch (error) {
              throw error instanceof S3TransportError ? toLibraryCloudError(error) : error;
            }
          },
        }),
  };
}
