import type { SqlDatabasePort } from '@/db/sql-port';
import { S3TransportError } from '@/features/byos/s3-transport-types';
import type {
  LibraryLifecycle,
  LibraryProtection,
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import {
  attachAssetStateKey,
  decodeAssetState,
  readAssetStateKey,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import {
  isKnownNotApplied,
  LibraryCloudError,
} from '@/features/library/library-cloud-errors';
import type {
  LibraryCloudClient,
  S3LibraryPendingMutation,
  S3LibraryRemoteMutationResult,
} from '@/features/library/library-cloud-client-s3';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import { categoryForRejection } from '@/features/library/library-protect-action';
import {
  LibraryReconciliationCorruptionError,
  type LibraryReconciliationPort,
} from '@/features/library/library-reconciliation-port';
import { toLibraryCloudError } from '@/features/library/library-s3-error-bridge';
import type { LibrarySyncApplyWriter } from '@/features/library/library-sync-apply';
import type { LibrarySyncCursorStore } from '@/features/library/library-sync-cursors';
import {
  collectMetadataOf,
  type LibrarySyncOutbox,
  type LibrarySyncOutboxKind,
  type LibrarySyncOutboxRow,
} from '@/features/library/library-sync-outbox';
import { projectAssetStateRecord } from '@/features/library/library-sync-projection';
import type {
  LibraryDeviceTrashSweep,
  LibraryDeviceTrashSweepReport,
} from '@/features/library/library-device-trash-sweep';
import type { LibrarySyncReconciler } from '@/features/library/library-sync-reconciler';
import type {
  LibraryProjectedAsset,
  LibraryPermanentDeleteIntentResult,
  LibraryRestoreIntentResult,
  LibrarySyncCursor,
  LibrarySyncReconcileReport,
  LibrarySyncReport,
} from '@/features/library/library-sync-types';
import {
  isLibraryImportClassification,
  type LibraryCanonicalExtension,
  type LibraryCollectMetadata,
} from '@/features/library/library-types';
import {
  buildLibraryEncryptedMetadata,
  readSourceMetadata,
} from '@/features/library/library-source-metadata';

/**
 * The one pipeline SP8 must not rebuild: a `protect` row that never reached
 * its upload still needs seal and put, and `library-protect-action` owns both.
 * Optional so the read-half tests and the Store build can construct an engine
 * without it. There is deliberately no collect member: the SP6 ingest
 * adapter's own `drain()` awaits that adapter's in-memory ingest tail, reads
 * no outbox row, and would submit nothing, so this engine builds and submits
 * every stored `collect` row itself.
 */
export type LibrarySyncPipelines = Readonly<{
  /** `library-protect-action.ts` `protect(plaintextSha256)`. */
  retryProtect(plaintextSha256: string): Promise<void>;
}>;

/**
 * The write face of the BYOS cloud client. Narrow on purpose: the engine
 * submits mutations and nothing else — blob reads and writes belong to the
 * actions that own the bytes.
 */
export type LibrarySyncCloudPort = Pick<LibraryCloudClient, 'submitMutations'>;

export type LibrarySyncEngineDependencies = Readonly<{
  session: LibrarySessionPort;
  cloud: LibrarySyncCloudPort;
  /**
   * BYOS change discovery (protocol spec, "变更发现"): there is no server-side
   * change feed, so every cycle lists per-asset state and reconciles against
   * it. Replaces the Worker's `readChanges`/`listIndexPage` cursor face.
   */
  reconciliation: LibraryReconciliationPort;
  cipher: LibraryObjectCipher;
  cursors: LibrarySyncCursorStore;
  apply: LibrarySyncApplyWriter;
  reconciler: LibrarySyncReconciler;
  outbox: LibrarySyncOutbox;
  database: SqlDatabasePort;
  pipelines?: LibrarySyncPipelines;
  /**
   * K6-3a: is a `protect` for this asset uploading right now? Bound to
   * `library-protect-action.ts`'s `isInFlight`. The drain skips such an asset
   * entirely — both the protect row and the `collect` intent K6-1b pairs with
   * it — because the live protect is about to submit those exact rows itself,
   * and a drain that replays and then deletes them destroys the collect intent
   * the live run still needs (proven on the emulator, asset a8bfed37).
   *
   * Defaults to "nothing is in flight", which is literally true for a
   * composition with no protect action: the read-half tests and the Store
   * build cannot upload at all.
   */
  isProtectInFlight?: (assetId: string) => boolean;
  /** Direct-only: time-based purge of expired device-trash bytes. */
  sweep?: LibraryDeviceTrashSweep;
  clock?: () => number;
}>;

export type LibrarySyncController = Readonly<{
  /** One full cycle. Never throws for an expected offline/auth condition. */
  sync(): Promise<LibrarySyncReport>;
  readSyncState(): Promise<LibrarySyncCursor | null>;
  /** SP9's trash screen calls this. SP8 ships no trash UI of its own. */
  enqueueRestoreIntent(
    plaintextSha256: string,
  ): Promise<LibraryRestoreIntentResult>;
  /** SP9's permanent-delete hook. Same not-applicable reasons as restore. */
  enqueuePermanentDeleteIntent(
    plaintextSha256: string,
  ): Promise<LibraryPermanentDeleteIntentResult>;
}>;

/** One batch's worth of mutations; a larger backlog finishes next cycle. */
const MAX_MUTATIONS_PER_REQUEST = 50;

/**
 * Kinds whose body needs nothing but the stored row: no bytes, no reservation,
 * no metadata envelope.
 */
const BODYLESS_KINDS: ReadonlySet<LibrarySyncOutboxKind> = new Set([
  'trash',
  'restore',
  'stop-protection',
  'permanent-delete',
]);

/** Rejections that can never succeed for this intent: drop the row. */
const TERMINAL_REJECTIONS: ReadonlySet<string> = new Set([
  'trash_wins',
  'purged_permanently',
  'not_found',
  'not_trash',
  'not_protected',
]);

/** A corrupt payload must not crash a cycle; the row simply waits. */
function readQueuedDigest(payloadJson: string): string | null {
  try {
    const parsed = JSON.parse(payloadJson) as { plaintextSha256?: unknown };
    return typeof parsed.plaintextSha256 === 'string'
      ? parsed.plaintextSha256
      : null;
  } catch {
    return null;
  }
}

/**
 * A `protect` row is replayable exactly when its own dispatch already uploaded
 * the original: `library-protect-action.ts` writes `originalGenerationId` into
 * the payload *before* it submits. A `sending` row is replayable by definition
 * — it was dispatched, so that value is durable — and must be replayed rather
 * than re-run, because a second `protect()` could upload again.
 *
 * Only `originalGenerationId` is required. The payload's `reservationId` is
 * quota machinery: BYOS has no quota (protocol spec, simplification 2), and
 * the migrated protect action stores `null` there, so requiring it would strand
 * every real protect row in the delegated pre-upload branch forever.
 *
 * The derived-role ids (`thumbnailGenerationId`/`previewGenerationId`) are
 * carried when present so the replayed mutation reconstructs the whole
 * `generations` triad. They are optional: a row written before that field
 * existed replays with `{ original }` only — enough that the asset degrades to
 * "missing derived variants" (regenerable) rather than "generations: {}" with
 * even the original reference lost.
 */
function readProtectBody(
  row: Readonly<{ state: string; payloadJson: string }>,
): Readonly<{
  originalGenerationId: string;
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
}> | null {
  let parsed: {
    originalGenerationId?: unknown;
    thumbnailGenerationId?: unknown;
    previewGenerationId?: unknown;
  };
  try {
    parsed = JSON.parse(row.payloadJson) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.originalGenerationId !== 'string') return null;
  return {
    originalGenerationId: parsed.originalGenerationId,
    thumbnailGenerationId:
      typeof parsed.thumbnailGenerationId === 'string'
        ? parsed.thumbnailGenerationId
        : null,
    previewGenerationId:
      typeof parsed.previewGenerationId === 'string'
        ? parsed.previewGenerationId
        : null,
  };
}

/**
 * The authoritative snapshot a mutation result carries. Under BYOS this is the
 * full `state.json` record the CAS write just produced, so it goes through the
 * same record→projection mapping a reconciled record does — one mapping, no
 * drift between what a writer and a reader believe about the same asset.
 *
 * N6-A3 (spec §4.3): in a multi-mutation same-asset group (`[collect, protect]`),
 * only the final mutation result that represents the committed remote object/note
 * is projected; intermediate group steps are not independently authoritative
 * notes.
 */
function projectMutationResult(
  result: S3LibraryRemoteMutationResult,
  hasLaterAppliedInSameAssetGroup: boolean,
): LibraryProjectedAsset | null {
  if (result.asset === null || hasLaterAppliedInSameAssetGroup) return null;
  return projectAssetStateRecord(result.asset);
}

/** The authoritative projection row a queued intent is judged against. */
export type LibraryQueuedProjection = Readonly<{
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  revision: number | null;
  generation: number | null;
  /** When this device last learned the row. Anchors the re-import exception. */
  updatedAt: number;
}>;

export type LibraryQueuedDecision =
  | Readonly<{
      kind: 'send';
      baseRevision: number | null;
      observedGeneration: number | null;
    }>
  | Readonly<{
      kind: 'discard';
      reason:
        | 'purged'
        | 'trash_wins'
        | 'already_trashed'
        | 'already_active'
        | 'not_trash'
        | 'already_stopped';
    }>;

/**
 * Pure. Decides a *queued* row only: a `sending` row is never passed here,
 * because its dispatched bytes must stay stable for replay.
 */
export function decideQueuedMutation(
  row: Readonly<{ kind: LibrarySyncOutboxKind; createdAt: number }>,
  projection: LibraryQueuedProjection | null,
): LibraryQueuedDecision {
  if (projection === null) {
    return { kind: 'send', baseRevision: null, observedGeneration: null };
  }
  const send = {
    kind: 'send',
    baseRevision: projection.revision,
    observedGeneration: projection.generation,
  } as const;

  if (projection.lifecycle === 'purged') {
    // Anti-resurrection. The single exception is a collect this device queued
    // *after* it learned about the purge: that is a deliberate re-import of
    // the same bytes, which the Worker models as a new generation.
    if (row.kind === 'collect' && row.createdAt > projection.updatedAt) {
      return send;
    }
    return { kind: 'discard', reason: 'purged' };
  }

  if (projection.lifecycle === 'trash') {
    if (row.kind === 'collect') return { kind: 'discard', reason: 'trash_wins' };
    if (row.kind === 'trash') {
      return { kind: 'discard', reason: 'already_trashed' };
    }
    if (row.kind === 'stop-protection' && projection.protection !== 'protected') {
      return { kind: 'discard', reason: 'already_stopped' };
    }
    return send;
  }

  if (row.kind === 'collect') {
    // K6-3a: `revision === null` means no `state.json` has ever been read for
    // this asset — the projection is a local optimistic write (the pending or
    // failed row a protect leaves behind), not learned remote truth. Reading
    // it as "the account already has this asset" deleted the one intent that
    // would create the asset, and every later protect then answered the
    // terminal `object_missing` forever. Only a reconciled projection may
    // retire a collect.
    if (projection.revision === null) return send;
    return { kind: 'discard', reason: 'already_active' };
  }
  if (row.kind === 'restore' || row.kind === 'permanent-delete') {
    return { kind: 'discard', reason: 'not_trash' };
  }
  if (row.kind === 'stop-protection' && projection.protection !== 'protected') {
    return { kind: 'discard', reason: 'already_stopped' };
  }
  return send;
}

const NO_FILES: LibrarySyncReconcileReport = {
  movedToDeviceTrash: 0,
  restoredFromDeviceTrash: 0,
  purgedDeviceTrash: 0,
  refused: 0,
  failed: 0,
};

const NO_DEVICE_TRASH_SWEEP: LibraryDeviceTrashSweepReport = {
  deleted: 0,
  refused: 0,
  failed: 0,
};

const EMPTY_REPORT: LibrarySyncReport = {
  status: 'completed',
  skipped: null,
  haltedCategory: null,
  reconciled: 0,
  materialized: 0,
  rebased: 0,
  discarded: 0,
  submitted: 0,
  committed: 0,
  rejected: 0,
  unresolved: 0,
  files: NO_FILES,
  deviceTrashSweep: NO_DEVICE_TRASH_SWEEP,
};

type DrainOutcome = {
  submitted: number;
  committed: number;
  rejected: number;
  unresolved: number;
  /** Assets whose committed outcome this cycle must converge on. */
  committedAssetIds: string[];
};

const NO_DRAIN: DrainOutcome = {
  submitted: 0,
  committed: 0,
  rejected: 0,
  unresolved: 0,
  committedAssetIds: [],
};

type ReconcileOutcome = Readonly<{
  reconciled: number;
  materialized: number;
}>;

const NO_RECONCILE: ReconcileOutcome = { reconciled: 0, materialized: 0 };

/**
 * Every failure the BYOS transport and reconciliation port raise, restated in
 * the one shape the cycle's catch blocks already understand.
 *
 * `S3TransportError` goes through the Task 2 bridge, so a 403 becomes a
 * halting `auth_attention` and a cut connection becomes a retryable `offline`
 * instead of an unhandled rejection escaping `sync()`. A corrupt remote
 * `state.json` becomes a halting `integrity`: the object will not heal by
 * being read again, so retrying it every cycle forever is worse than stopping
 * and telling the user.
 */
function asLibraryCloudError(error: unknown): LibraryCloudError | null {
  if (error instanceof LibraryCloudError) return error;
  if (error instanceof S3TransportError) return toLibraryCloudError(error);
  if (error instanceof LibraryReconciliationCorruptionError) {
    return new LibraryCloudError(
      0,
      'corrupt_remote_state',
      'integrity',
      error.message,
      true,
    );
  }
  return null;
}

/**
 * Runs one remote read/write through the Task 2 bridge. Every call into the
 * reconciliation port and the cloud client goes through here, so the engine's
 * existing `instanceof LibraryCloudError` classification fires for the S3
 * transport too, with no per-call-site error handling.
 */
async function viaCloudErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const translated = asLibraryCloudError(error);
    throw translated ?? error;
  }
}

export function createLibrarySyncEngine({
  session,
  cloud,
  reconciliation,
  cipher,
  cursors,
  apply,
  reconciler,
  outbox,
  database,
  pipelines,
  isProtectInFlight = () => false,
  sweep,
  clock = Date.now,
}: LibrarySyncEngineDependencies): LibrarySyncController {
  /**
   * Writes a batch of remote records into the local projection.
   *
   * A record whose lifecycle or protection this build cannot store is counted
   * and skipped, never coerced. There is no "arm a rebase" flag: a record the
   * build cannot read is re-projected as soon as it next changes remotely, and
   * a build that understands it reads it again on its first pass after
   * install, because installing a build does not carry the old build's index
   * forward for objects it never projected.
   *
   * An empty batch returns without touching the database at all. That is the
   * common case after K7 cut 3 — an unchanged library — and it is what keeps
   * a launch from opening an exclusive write transaction on the shared FIFO
   * SQL queue for no reason.
   */
  const backfilledScopes = new Set<string>();
  const encoder = new TextEncoder();

  async function project(
    context: LibrarySessionContext,
    records: readonly LibraryProjectedAsset[],
  ): Promise<ReconcileOutcome> {
    if (records.length === 0) return NO_RECONCILE;
    let report;
    try {
      report = await apply.apply({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        masterKey: context.masterKey,
        assets: records,
      });
    } catch (error) {
      if (reconciliation.invalidateAsset !== undefined) {
        for (const item of records) {
          await reconciliation.invalidateAsset(item.assetId).catch(() => {});
        }
      }
      throw error;
    }
    if (
      report.failedAssetIds !== undefined
      && report.failedAssetIds.length > 0
      && reconciliation.invalidateAsset !== undefined
    ) {
      for (const assetId of report.failedAssetIds) {
        await reconciliation.invalidateAsset(assetId).catch(() => {});
      }
    }
    return { reconciled: records.length, materialized: report.materialized };
  }

  /**
   * N6-A3 (spec §4.3): one-time upgrade backfill per account scope. Opens
   * cached indexed records in `library_remote_state_cache` for enrolled assets
   * that still lack a `library_account_metadata_summary` row, without clearing
   * the ETag/note index or repeating the scan on later sync rounds.
   */
  async function backfillMissingSummariesFromIndex(
    context: LibrarySessionContext,
  ): Promise<void> {
    if (backfilledScopes.has(context.accountScope)) return;
    const missing = await database.getAll<{ asset_id: string }>(
      `SELECT aa.asset_id
         FROM library_account_assets aa
        WHERE aa.account_scope = ?
          AND NOT EXISTS (
            SELECT 1 FROM library_account_metadata_summary s
             WHERE s.account_scope = aa.account_scope
               AND s.asset_id = aa.asset_id
          )`,
      [context.accountScope],
    );
    if (missing.length === 0) {
      backfilledScopes.add(context.accountScope);
      return;
    }
    const missingIds = new Set(missing.map((row) => row.asset_id));
    const cachedRows = await database.getAll<{
      key: string;
      record_json: string;
    }>(
      `SELECT key, record_json
         FROM library_remote_state_cache
        WHERE account_scope = ?`,
      [context.accountScope],
    );
    const bestByAsset = new Map<string, { key: string; record: LibraryAssetStateRecord }>();
    for (const row of cachedRows) {
      let decoded: LibraryAssetStateRecord;
      try {
        decoded = decodeAssetState(encoder.encode(row.record_json));
      } catch {
        continue;
      }
      if (!missingIds.has(decoded.assetId)) continue;
      const stateKey = row.key.startsWith('state/')
        ? row.key
        : `s3:${decoded.revision}`;
      attachAssetStateKey(decoded, stateKey);
      const prev = bestByAsset.get(decoded.assetId);
      if (
        prev === undefined
        || (row.key.startsWith('state/') && row.key > prev.key)
        || (!row.key.startsWith('state/') && decoded.revision > prev.record.revision)
      ) {
        bestByAsset.set(decoded.assetId, { key: row.key, record: decoded });
      }
    }
    const toProject: LibraryProjectedAsset[] = [];
    for (const { record } of bestByAsset.values()) {
      if (readAssetStateKey(record) === null) {
        attachAssetStateKey(record, `s3:${record.revision}`);
      }
      const projectedRow = projectAssetStateRecord(record);
      if (projectedRow !== null) toProject.push(projectedRow);
    }
    if (toProject.length > 0) {
      const report = await apply.apply({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        masterKey: context.masterKey,
        assets: toProject,
      });
      if (report.failedAssetIds === undefined || report.failedAssetIds.length === 0) {
        backfilledScopes.add(context.accountScope);
      } else if (reconciliation.invalidateAsset !== undefined) {
        for (const assetId of report.failedAssetIds) {
          await reconciliation.invalidateAsset(assetId).catch(() => {});
        }
      }
      return;
    }
    backfilledScopes.add(context.accountScope);
  }

  /**
   * BYOS change discovery, in full (protocol spec, "变更发现"): list every
   * asset's `state.json` and project the ones that moved. There is no cursor —
   * a stale device's full rebase is the same algorithm's natural result, so
   * there is exactly one read path to reason about.
   *
   * K7 cut 3: the port serves that read path incrementally (P5 / decision #24)
   * against a DURABLE ETag index, and now returns only what changed. An asset
   * whose listed ETag still matches what this device last read cannot have
   * moved — an ETag is a server-side content hash — so projecting it again
   * could only rewrite a row with the values already in it. Reprojecting the
   * whole library every cycle cost one exclusive SQLite transaction of N
   * no-op UPSERTs on the shared FIFO queue, per app launch, per foreground,
   * per save. It bought exactly one thing: a projection wiped out of band
   * would rebuild itself. Nothing wipes it out of band any more —
   * `clearAccountProjection` is the one path that clears the account's rows
   * and it drops this vault's ETag index in the same transaction, so the next
   * cycle is a full pass again by construction.
   *
   * Tombstone semantics follow the spec's "每资产状态对象" section, inverted
   * from the Worker's: **a present record with `lifecycle: 'purged'` is the
   * authoritative tombstone** and is projected like any other record. A purge
   * is a CAS overwrite of the same key, so its ETag moves and it arrives in
   * `changed`.
   *
   * `removedKeys` — keys the listing stopped reporting — is deliberately NOT
   * routed into the projection, because that is exactly what this engine does
   * today: absence is inert. State objects are never DELETEd, so absence means
   * "not written yet", "raced a concurrent write", or "swept after the 180-day
   * tombstone retention", none of which authorize forgetting a local row. The
   * Worker-era `tombstoneMissing` sweep, which read absence as deletion, is
   * deliberately gone (pinned by "never forgets a local row just because the
   * listing omits it"). The port's own index drops those keys so a
   * reappearance is re-read rather than served stale; that is the whole of the
   * cleanup the spec's "listing 缺失只作清扫提示" asks for.
   */
  async function reconcile(
    context: LibrarySessionContext,
  ): Promise<ReconcileOutcome> {
    const { changed } = await viaCloudErrors(
      () => reconciliation.discoverChanges(),
    );
    const projected: LibraryProjectedAsset[] = [];
    for (const record of changed) {
      const row = projectAssetStateRecord(record);
      if (row !== null) projected.push(row);
    }
    const outcome = await project(context, projected);
    await backfillMissingSummariesFromIndex(context);
    return outcome;
  }

  /**
   * Targeted convergence after a committed drain: re-read only the assets this
   * cycle actually wrote, rather than listing the whole library a second time.
   * A committed mutation's own result already carries the record it produced,
   * but a concurrent device may have written the same asset in between, and
   * one GET per committed asset is both cheaper than a second full list and
   * free of the oscillation a second list could cause.
   *
   * A `null` record (the state object is gone out of band) is left alone: the
   * next cycle's full reconcile is the right place to decide about it.
   *
   * Each of these reads also refreshes the port's ETag index for that asset,
   * so this device's own committed writes are not re-read by the next cycle's
   * change discovery.
   */
  async function converge(
    context: LibrarySessionContext,
    assetIds: readonly string[],
  ): Promise<ReconcileOutcome> {
    const projected: LibraryProjectedAsset[] = [];
    for (const assetId of assetIds) {
      const record = await viaCloudErrors(
        () => reconciliation.getAssetState(assetId),
      );
      if (record === null) continue;
      const row = projectAssetStateRecord(record);
      if (row !== null) projected.push(row);
    }
    return await project(context, projected);
  }

  async function readProjections(
    scope: string,
    assetIds: readonly string[],
  ): Promise<Map<string, LibraryQueuedProjection>> {
    const found = new Map<string, LibraryQueuedProjection>();
    if (assetIds.length === 0) return found;
    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = await database.getAll<{
      asset_id: string;
      lifecycle: string;
      protection: string;
      revision: number | null;
      generation: number | null;
      updated_at: number;
    }>(
      `SELECT asset_id, lifecycle, protection, revision, generation, updated_at
         FROM library_asset_protection
        WHERE account_scope = ? AND asset_id IN (${placeholders})`,
      [scope, ...assetIds],
    );
    for (const row of rows) {
      found.set(row.asset_id, {
        lifecycle: row.lifecycle as LibraryLifecycle,
        protection: row.protection as LibraryProtection,
        revision: row.revision,
        generation: row.generation,
        updatedAt: row.updated_at,
      });
    }
    return found;
  }

  /** Cycle step 5. Runs after the pull, so it judges fresh truth. */
  async function rebaseQueuedMutations(
    scope: string,
  ): Promise<Readonly<{ rebased: number; discarded: number }>> {
    const rows = await outbox.listAll(scope);
    const queued = rows.filter((row) => row.state !== 'sending');
    const projections = await readProjections(
      scope,
      queued.map((row) => row.assetId),
    );
    let rebased = 0;
    let discarded = 0;

    for (const row of queued) {
      const decision = decideQueuedMutation(
        { kind: row.kind, createdAt: row.createdAt },
        projections.get(row.assetId) ?? null,
      );
      if (decision.kind === 'discard') {
        await outbox.discard(row.mutationId);
        discarded += 1;
        continue;
      }
      if (
        decision.baseRevision === row.baseRevision
        && decision.observedGeneration === row.observedGeneration
      ) {
        continue;
      }
      if (
        await outbox.rebase(
          row.mutationId,
          decision.baseRevision,
          decision.observedGeneration,
        )
      ) {
        rebased += 1;
      }
    }

    return { rebased, discarded };
  }

  /**
   * Rebuilds the exact envelope SP7 seals, from durable local state only:
   * the stored collect payload, the local asset's canonical extension, and
   * (C3a) the provider `images` row the payload points at. Returns `null` when
   * the local record is gone, in which case the row simply waits — SP8 never
   * invents metadata and never discards the intent.
   */
  async function sealCollectMetadata(
    context: LibrarySessionContext,
    row: LibrarySyncOutboxRow,
  ): Promise<string | null> {
    let metadata: LibraryCollectMetadata;
    try {
      metadata = collectMetadataOf(row);
    } catch {
      return null;
    }
    const local = await database.getFirst<{
      canonical_extension: string;
      import_classification: string;
    }>(
      `SELECT canonical_extension, import_classification
         FROM device_library_assets
        WHERE plaintext_sha256 = ?`,
      [metadata.plaintextSha256],
    );
    if (local === null) return null;
    return await cipher.sealMetadata({
      masterKey: context.masterKey,
      assetId: row.assetId,
      // Byte-shape parity with `library-protect-action.ts`'s `metadataFor`:
      // both sites build the payload through this one projection, so the JSON
      // key order `sealMetadata` serializes cannot drift between them.
      metadata: buildLibraryEncryptedMetadata(
        {
          plaintextSha256: metadata.plaintextSha256,
          format: metadata.format,
          canonicalExtension:
            local.canonical_extension as LibraryCanonicalExtension,
          byteSize: metadata.byteSize,
          width: metadata.width,
          height: metadata.height,
          origin: metadata.origin,
          sourceImageId: metadata.sourceImageId,
          collectedAt: metadata.collectedAt,
          importClassification: isLibraryImportClassification(
            local.import_classification,
          )
            ? local.import_classification
            : (metadata.importClassification ?? 'unknown'),
        },
        await readSourceMetadata(database, metadata.sourceImageId),
      ),
    });
  }

  /**
   * One durable outbox row as a BYOS pending mutation, or `null` when this
   * cycle must not submit it (a pre-upload `protect`, or a `collect` whose
   * local record is gone). `null` never deletes anything.
   *
   * `meta` is why this rebuild exists. The engine is the *second* producer of
   * a collect body — `library-protect-action.ts` is the first — and under
   * BYOS the sealed envelope rides on the asset's own state record rather
   * than a Worker column (Task 1). A collect submitted without `meta` writes
   * a `state.json` a second device can list but never materialize: no
   * envelope, no digest mapping, so `library-sync-apply.ts` counts it as
   * `skippedUnknownAsset` and the asset stays invisible there forever.
   *
   * The envelope is sealed through the **injected** cipher port, never a
   * locally constructed one (P3C decisions #14/#21): with
   * `encryption: 'none'` the session carries a derived pseudo-key that must
   * never perform real encryption, and only the composition layer knows which
   * cipher — real or passthrough — this session should use.
   */
  async function buildMutation(
    context: LibrarySessionContext,
    row: LibrarySyncOutboxRow,
  ): Promise<S3LibraryPendingMutation | null> {
    const base = {
      mutationId: row.mutationId,
      assetId: row.assetId,
      baseRevision: row.baseRevision,
      observedGeneration: row.observedGeneration,
      originalGenerationId: null,
      // The engine never carries bytes: `library-protect-action.ts` uploads
      // every blob and this row only moves lifecycle or protection.
      newBlob: null,
    } as const;

    if (BODYLESS_KINDS.has(row.kind)) {
      return {
        ...base,
        kind: row.kind as
          | 'trash'
          | 'restore'
          | 'stop-protection'
          | 'permanent-delete',
      };
    }
    if (row.kind === 'collect') {
      const meta = await sealCollectMetadata(context, row);
      if (meta === null) return null;
      return { ...base, kind: 'collect', meta };
    }
    if (row.kind === 'protect') {
      // Replay only. A row without a stored generation was delegated to
      // `library-protect-action.ts`, which owns the upload.
      const stored = readProtectBody(row);
      if (stored === null) return null;
      // Always carry the whole triad the row knows about. `generationsPatch`
      // is what makes the CAS write persist the references: without it,
      // `buildNextRecord` keeps `existing?.generations ?? {}`, so a true crash
      // where the inline submit never wrote `state.json` would land
      // `protected` with `generations: {}` — losing even the original. A
      // legacy row (no derived ids) still emits `{ original }`, which the
      // decision table's `object_missing` guard also needs.
      return {
        ...base,
        kind: 'protect',
        originalGenerationId: stored.originalGenerationId,
        generationsPatch: {
          original: stored.originalGenerationId,
          ...(stored.thumbnailGenerationId !== null
            ? { thumbnail: stored.thumbnailGenerationId }
            : {}),
          ...(stored.previewGenerationId !== null
            ? { preview: stored.previewGenerationId }
            : {}),
        },
      };
    }
    return null;
  }

  /**
   * Sends what is due and records every outcome.
   *
   * K7 ⑬: no row leaves here with a retry time. A failure — this batch's
   * throw, or one row's refusal — makes the row due again on the NEXT round,
   * which the triggers fire on a real event (a save, a foreground, a
   * reconnect). The old `nextAttemptDelayMs` pushed every row in the batch,
   * up to 50 of them, 15-30 s out on the first failure and up to an hour by
   * the sixth, against a bucket that belongs to the user alone.
   */
  async function drain(context: LibrarySessionContext): Promise<DrainOutcome> {
    const scope = context.accountScope;
    const out: DrainOutcome = { ...NO_DRAIN, committedAssetIds: [] };

    const due = (await outbox.listDue(scope))
      // K6-3a: an asset whose protect is uploading right now belongs to that
      // run, not to this drain. Filtered at the source so every consumer below
      // — the delegated-retry loop, the batch builder, and the K6-1b collect
      // pairing that searches this same list — sees one consistent view.
      .filter((row) => !isProtectInFlight(row.assetId));

    // The single delegated case. A `protect` row that never reached its upload
    // has no body to replay, so the pipeline that owns seal and put runs it,
    // with its own retry and verification rules unchanged. A `sending` protect
    // row is deliberately excluded: re-running `protect()` on a dispatched row
    // could upload a second time, so it is replayed below instead.
    if (pipelines !== undefined) {
      for (const row of due) {
        if (row.kind !== 'protect') continue;
        if (row.state === 'sending') continue;
        if (readProtectBody(row) !== null) continue;
        const digest = readQueuedDigest(row.payloadJson);
        if (digest !== null) await pipelines.retryProtect(digest);
      }
    }

    const batch: Readonly<{
      row: LibrarySyncOutboxRow;
      mutation: S3LibraryPendingMutation;
    }>[] = [];
    const seenAssets = new Set<string>();
    // Outcome-unknown rows first: a replay under the original id resolves them
    // from the stored `lastMutationId` before any new work is risked.
    const ordered = [
      ...due.filter((row) => row.state === 'sending'),
      ...due.filter((row) => row.state !== 'sending'),
    ];
    for (const row of ordered) {
      // One mutation per asset per batch: two mutations against one asset in
      // the same request would have the second decide against a state the
      // first has already replaced.
      if (seenAssets.has(row.assetId)) continue;
      // Async, because a `collect` body reseals durable local metadata. This
      // runs before `markDispatched`, so an unbuildable row is never marked.
      const mutation = await buildMutation(context, row);
      if (mutation === null) continue;
      seenAssets.add(row.assetId);
      // K6-1b: the ONE exception to the rule above, and the reason it is safe.
      // `library-protect-action.ts` now writes a brand-new asset's `collect`
      // and `protect` in a single CAS PUT, so a crash between the blob uploads
      // and that PUT leaves NOTHING on the bucket — not even the collect
      // record the old two-submit path used to leave. Replaying the protect
      // alone would decide against a missing `state.json`: `not_found`, which
      // is terminal, so the intent would be dropped and the asset would stay
      // unprotected with its blobs already paid for. The client applies
      // CONSECUTIVE same-asset mutations against a single read and a single
      // CAS PUT (see `library-cloud-client-s3.ts`'s same-asset grouping), so
      // the pair rides together with the collect FIRST — the second mutation
      // decides against the record the first produced, which is exactly what
      // the old one-per-asset rule was protecting against. A collect for an
      // asset that already exists remotely simply merges.
      if (row.kind === 'protect') {
        const collectRow = due.find(
          (candidate) => candidate.kind === 'collect'
            && candidate.assetId === row.assetId,
        );
        const collectMutation = collectRow === undefined
          ? null
          : await buildMutation(context, collectRow);
        if (collectRow !== undefined && collectMutation !== null) {
          batch.push({ row: collectRow, mutation: collectMutation });
        }
      }
      batch.push({ row, mutation });
      if (batch.length >= MAX_MUTATIONS_PER_REQUEST) break;
    }
    if (batch.length === 0) return out;

    // Dispatched *before* the write: a process death lands in `sending`, which
    // is replayed, never discarded.
    await outbox.markDispatched(batch.map(({ row }) => row.mutationId));
    out.submitted = batch.length;

    let response;
    try {
      response = await viaCloudErrors(() => cloud.submitMutations({
        mutations: batch.map(({ mutation }) => mutation),
      }));
    } catch (error) {
      const translated = asLibraryCloudError(error);
      const category = translated?.category ?? 'offline';
      const known = isKnownNotApplied(translated ?? error);
      for (const { row } of batch) {
        // One throw covers the whole batch, so it says nothing about any
        // individual row — least of all the ones whose request never left the
        // device. None of them is delayed because of it (K7 ⑬).
        if (known) {
          await outbox.markFailed(row.mutationId, category);
        } else {
          await outbox.markUnknownOutcome(row.mutationId, category);
          out.unresolved += 1;
        }
      }
      return out;
    }

    const byId = new Map(response.results.map((entry) => [entry.mutationId, entry]));
    const settled: LibraryProjectedAsset[] = [];

    for (const [batchIdx, { row }] of batch.entries()) {
      const result = byId.get(row.mutationId);
      if (result === undefined) {
        // Answered, but not about this row: the outcome is still unknown.
        await outbox.markUnknownOutcome(row.mutationId, 'offline');
        out.unresolved += 1;
        continue;
      }
      const hasLaterAppliedInSameAssetGroup = batch
        .slice(batchIdx + 1)
        .some(
          (later) =>
            later.row.assetId === row.assetId
            && byId.get(later.row.mutationId)?.outcome === 'applied',
        );
      const projectedResult = projectMutationResult(
        result,
        hasLaterAppliedInSameAssetGroup,
      );
      if (projectedResult !== null) settled.push(projectedResult);
      if (result.outcome === 'applied' || result.outcome === 'merged') {
        // A known committed outcome; the projection below holds the truth.
        // For a replayed `protect` this records the authoritative snapshot and
        // leaves `verified_at` NULL: the local decrypt-and-hash proof is still
        // SP7's, reached from the durable `original_generation_id`.
        await outbox.markCommitted(row.mutationId);
        out.committed += 1;
        // K6-1b: a batch can now carry a collect AND the protect that follows
        // it for one asset, so converge on that asset once, not twice.
        if (!out.committedAssetIds.includes(row.assetId)) {
          out.committedAssetIds.push(row.assetId);
        }
        continue;
      }
      out.rejected += 1;
      const reason = result.reason ?? 'stale_base_revision';
      if (TERMINAL_REJECTIONS.has(reason)) {
        await outbox.discard(row.mutationId);
        continue;
      }
      await outbox.markFailed(
        row.mutationId,
        // A corrupt remote `state.json` is not a conflict this row can retry
        // its way out of, so it takes the halting `integrity` category and
        // stops being due until the object or the build changes.
        // `resync_required` needs no special handling any more: there is no
        // cursor to rearm, and the next cycle's full reconcile rebases the row
        // onto whatever the remote actually says.
        reason === 'corrupt_remote_state'
          ? 'integrity'
          : categoryForRejection(reason),
      );
    }

    if (settled.length > 0) {
      // Authoritative snapshots are durable immediately. `converge()` still
      // re-reads each committed asset afterwards, because another device may
      // have written it between our CAS and now.
      await project(context, settled);
    }

    return out;
  }

  return {
    async enqueueRestoreIntent(plaintextSha256) {
      const context = await session.current();
      if (context === null) {
        return { status: 'not-applicable', reason: 'no_account' };
      }
      const row = await database.getFirst<{
        asset_id: string;
        lifecycle: string;
        revision: number | null;
        generation: number | null;
      }>(
        `SELECT asset_id, lifecycle, revision, generation
           FROM library_asset_protection
          WHERE account_scope = ? AND plaintext_sha256 = ?`,
        [context.accountScope, plaintextSha256],
      );
      if (row === null) {
        return { status: 'not-applicable', reason: 'unknown_asset' };
      }
      if (row.lifecycle !== 'trash') {
        return { status: 'not-applicable', reason: 'not_trash' };
      }
      const queued = await outbox.enqueue({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        assetId: row.asset_id,
        kind: 'restore',
        baseRevision: row.revision,
        observedGeneration: row.generation,
        payload: {
          assetId: row.asset_id,
          plaintextSha256,
          kind: 'restore',
          reservationId: null,
          originalGenerationId: null,
          originalCiphertextBytes: null,
          queuedAt: clock(),
        },
      });
      return queued.status === 'queued'
        ? { status: 'queued', mutationId: queued.mutationId }
        : { status: 'already-queued', mutationId: queued.mutationId };
    },

    async enqueuePermanentDeleteIntent(plaintextSha256) {
      const context = await session.current();
      if (context === null) {
        return { status: 'not-applicable', reason: 'no_account' };
      }
      const row = await database.getFirst<{
        asset_id: string;
        lifecycle: string;
        revision: number | null;
        generation: number | null;
      }>(
        `SELECT asset_id, lifecycle, revision, generation
           FROM library_asset_protection
          WHERE account_scope = ? AND plaintext_sha256 = ?`,
        [context.accountScope, plaintextSha256],
      );
      if (row === null) {
        return { status: 'not-applicable', reason: 'unknown_asset' };
      }
      if (row.lifecycle !== 'trash') {
        return { status: 'not-applicable', reason: 'not_trash' };
      }
      const queued = await outbox.enqueue({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        assetId: row.asset_id,
        kind: 'permanent-delete',
        baseRevision: row.revision,
        observedGeneration: row.generation,
        payload: {
          assetId: row.asset_id,
          plaintextSha256,
          kind: 'permanent-delete',
          reservationId: null,
          originalGenerationId: null,
          originalCiphertextBytes: null,
          queuedAt: clock(),
        },
      });
      return queued.status === 'queued'
        ? { status: 'queued', mutationId: queued.mutationId }
        : { status: 'already-queued', mutationId: queued.mutationId };
    },

    async readSyncState() {
      const context = await session.current();
      if (context === null) return null;
      return await cursors.read(context.accountScope);
    },

    async sync() {
      const context = await session.current();
      if (context === null) {
        return { ...EMPTY_REPORT, status: 'skipped', skipped: 'no_account' };
      }
      const scope = context.accountScope;

      let pulled: ReconcileOutcome = NO_RECONCILE;
      let converged: ReconcileOutcome = NO_RECONCILE;
      let rebase: Readonly<{ rebased: number; discarded: number }> = {
        rebased: 0,
        discarded: 0,
      };
      let drained: DrainOutcome = { ...NO_DRAIN, committedAssetIds: [] };
      try {
        // Step 1: learn the remote truth by reconciling every asset's state.
        pulled = await reconcile(context);
        // Step 2: judge queued intents against the projection we just applied.
        rebase = await rebaseQueuedMutations(scope);
        // Step 3: send what is due.
        drained = await drain(context);
        // Step 4: converge on exactly the assets the drain committed.
        if (drained.committedAssetIds.length > 0) {
          converged = await converge(context, drained.committedAssetIds);
        }
      } catch (error) {
        const cloudError = asLibraryCloudError(error);
        if (cloudError !== null) {
          return {
            ...EMPTY_REPORT,
            status: 'halted',
            haltedCategory: cloudError.category,
          };
        }
        throw error;
      }

      // Files move only after the projection they follow is durable.
      const files = await reconciler.reconcile(scope);
      // Time-based purge of expired device-trash bytes.
      const deviceTrashSweep = sweep === undefined
        ? NO_DEVICE_TRASH_SWEEP
        : await sweep.run(scope);
      // The one surviving watermark: this device completed a reconcile.
      await cursors.markSynced(scope);

      return {
        ...EMPTY_REPORT,
        status: 'completed',
        reconciled: pulled.reconciled + converged.reconciled,
        materialized: pulled.materialized + converged.materialized,
        rebased: rebase.rebased,
        discarded: rebase.discarded,
        submitted: drained.submitted,
        committed: drained.committed,
        rejected: drained.rejected,
        unresolved: drained.unresolved,
        files,
        deviceTrashSweep,
      };
    },
  };
}
