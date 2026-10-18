import { randomUUID } from 'expo-crypto';

import type {
  LibraryActionResult,
  LibraryEncryptedMetadata,
  LibraryFailureCategory,
  LibraryLifecycle,
  LibraryRestorableSource,
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import type { LibraryActionOutbox } from '@/features/library/library-action-outbox';
import {
  isKnownNotApplied,
  LibraryCloudError,
} from '@/features/library/library-cloud-errors';
import {
  readAssetStateKey,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import type {
  LibraryGenerationRole,
  LibraryCloudClient,
  S3LibraryPendingMutation,
  S3LibraryRemoteMutationResult,
  S3LibraryRemoteRejectionReason,
} from '@/features/library/library-cloud-client-s3';
import type { LibraryReconciliationPort } from '@/features/library/library-reconciliation-port';
import type { LibraryFileDecryptor } from '@/features/library/library-file-decryptor';
import type { LibraryFileStore } from '@/features/library/library-file-store';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';
import type { LibraryRepository } from '@/features/library/library-repository';
import { buildLibraryEncryptedMetadata } from '@/features/library/library-source-metadata';
import {
  libraryTransferProgress,
  type LibraryTransferProgressStore,
} from '@/features/library/library-transfer-progress';
import type { DeviceLibraryAsset } from '@/features/library/library-types';

export type LibraryFillDerivedResult = Readonly<{
  status: 'complete' | 'unfillable' | 'retry';
}>;

export type LibraryProtectAction = Readonly<{
  protect(plaintextSha256: string): Promise<LibraryActionResult>;
  /**
   * K6-3a: is this asset's upload running right now? The sync engine's drain
   * asks before it replays anything, because a live protect owns both its own
   * `protect` row and the `collect` intent it is about to submit with it.
   * Keyed by assetId, not digest, because an outbox row is all the drain has.
   */
  isInFlight(assetId: string): boolean;
  /**
   * Board #24 (spec §5.4.2 step 3): resolves once the upload of this digest
   * that is in flight right now has settled, whichever way it ended; at once
   * when none is. Joins the K6-1c run below — it never starts one. The purge
   * of a rewound save waits on it, so the upload's writes land before the
   * rows they belong to are deleted.
   */
  settled(plaintextSha256: string): Promise<void>;
  /**
   * Board #27 (spec §5.4 step 3): every upload running now has settled,
   * whichever way it ended. Starts nothing.
   */
  settledAll(): Promise<void>;
  /**
   * Board #27 S3 (spec §5.10): before this phone deletes its original, give the
   * cloud the thumbnail and preview it lacks, derived from that original.
   * Joins this digest's upload and the derived patch it runs behind its answer.
   * `complete`: both roles referenced. `unfillable`: this phone cannot produce
   * a role, or the cloud refused the patch — evicting loses nothing a retry
   * could add. `retry`: no session, a read that threw, a PUT or the patch
   * that failed — keep the original this round. Never rejects.
   */
  fillDerived(plaintextSha256: string): Promise<LibraryFillDerivedResult>;
  applySavePolicyAfterIngest(
    plaintextSha256: string,
  ): Promise<LibraryActionResult>;
  /** Shared by download/stop-protection: read authoritative remote state. */
  readRemoteState(
    session: LibrarySessionContext,
    assetId: string,
  ): Promise<LibraryAssetStateRecord | null>;
  /** Shared by remove/stop-protection: make the asset known to the account. */
  ensureCollected(
    session: LibrarySessionContext,
    asset: DeviceLibraryAsset,
    assetId: string,
  ): Promise<LibraryAssetStateRecord | LibraryFailureCategory>;
}>;

export type LibraryProtectActionDependencies = Readonly<{
  repository: LibraryRepository;
  protection: LibraryProtectionRepository;
  outbox: LibraryActionOutbox;
  files: LibraryFileStore;
  cipher: LibraryObjectCipher;
  decryptor?: Pick<LibraryFileDecryptor, 'sealToFile'>;
  cloud: Pick<LibraryCloudClient, 'putBlob' | 'submitMutations'>
    & Partial<Pick<LibraryCloudClient, 'putBlobFromFile'>>;
  reconciliation: LibraryReconciliationPort;
  session: LibrarySessionPort;
  derived: LibraryDerivedImages;
  /**
   * C3a: the provider `images` row behind this asset, projected into the
   * envelope's `source` block, or `null` for a local import (and for a
   * discovery row that is gone). A narrow port rather than the whole database,
   * so this action stays unaware of SQL; the composition layer binds it to
   * `library-source-metadata.ts`'s `readSourceMetadata`.
   *
   * Required, not optional: the deferred drain site in `library-sync-engine.ts`
   * reads the source unconditionally, so a composition that silently omitted
   * it here would seal a source-less v2 envelope from this path and a full one
   * from the drain for the same asset — the exact byte divergence this cut
   * exists to prevent. A missing wire is now a compile error. A caller that
   * genuinely seals no provider metadata passes `async () => null`.
   */
  readSource: (
    sourceImageId: number | null,
  ) => Promise<LibraryRestorableSource | null>;
  /**
   * K6-2 (spec §2 G3): where this action publishes the bytes its uploads have
   * actually put on the server, so the grid tile can draw a real percentage
   * ring. Defaults to the process-wide store the UI hook reads; tests inject a
   * private one.
   */
  transferProgress?: LibraryTransferProgressStore;
  /**
   * K6-3a: rebuilds this asset's durable `collect` intent from local state,
   * bound to `library-ingest.ts`'s `enrichLocalAssetForAccount`.
   *
   * `object_missing` is terminal: the row is retried and re-failed every round
   * forever, so it must mean the OBJECT is gone, never that a local intent row
   * is. An asset this account has enrolled can always have its intent rebuilt
   * from the local asset row, so a missing intent is a repairable local state.
   * Optional: a composition without an ingest service simply gets the old
   * honest `object_missing`.
   */
  reenroll?: (plaintextSha256: string) => Promise<unknown>;
  clock?: () => number;
  /**
   * Mints the content-addressed generationId (a fresh ULID/UUID) for each
   * role blob this device uploads. The client is content-addressed and no
   * longer echoes a server-assigned id, so the caller owns minting. Test
   * seam for determinism; real callers omit this.
   */
  newGenerationId?: () => string;
}>;

/**
 * Spec §4: the failure categories that mean "stop and wait for the user".
 * A row already failed with one of these re-reports the block without
 * re-deriving, re-sealing or re-uploading anything: the blocking state cannot
 * change on its own, so every request a retry spends is guaranteed to fail the
 * same way — 403 for a session that needs the user, 507 for a full drive.
 * Both clear the moment `failure_category` goes back to NULL.
 */
/**
 * Exported because N10 T2's resume selector (`library-protect-resume.ts`) must
 * exclude exactly these verdicts from its re-protect candidates — one set, so
 * the two sides cannot drift.
 */
export const PROTECT_SHORT_CIRCUIT: ReadonlySet<LibraryFailureCategory> = new Set([
  'auth_attention',
  'quota_full',
]);

/**
 * Mutation rejections the user must resolve; never a blind retry. Typed for
 * the S3 client's `S3LibraryRemoteRejectionReason` (the production
 * `decideLibraryMutation` reasons plus `corrupt_remote_state`). The Worker's
 * quota rejection reasons (`quota_exhausted`/`reservation_required`) no
 * longer exist under BYOS (no quota — decision #13), so they are gone from
 * the S3 reason union and from this switch.
 */
export function categoryForRejection(
  reason: S3LibraryRemoteRejectionReason | null,
): LibraryFailureCategory {
  switch (reason) {
    case 'object_missing':
    case 'not_found':
      return 'object_missing';
    case 'corrupt_remote_state':
      return 'integrity';
    default:
      return 'stale_client';
  }
}

function categoryFor(error: unknown): LibraryFailureCategory {
  if (error instanceof LibraryCloudError) return error.category;
  return 'retryable_transfer';
}

export function createLibraryProtectAction({
  repository,
  protection,
  outbox,
  files,
  cipher,
  decryptor,
  cloud,
  reconciliation,
  session,
  derived,
  readSource,
  transferProgress = libraryTransferProgress,
  reenroll,
  clock = Date.now,
  newGenerationId = randomUUID,
}: LibraryProtectActionDependencies): LibraryProtectAction {
  const readRemoteState = async (
    _context: LibrarySessionContext,
    assetId: string,
  ): Promise<LibraryAssetStateRecord | null> =>
    reconciliation.getAssetState(assetId);

  /**
   * C3a: `version: 2` — the envelope carries the provider identity and
   * presentation fields a receiving device needs to rebuild an ordinary
   * `StoredImage`. The payload object is built by the shared
   * `buildLibraryEncryptedMetadata` so this site and
   * `library-sync-engine.ts`'s `sealCollectMetadata` serialize identical bytes
   * (`sealMetadata` seals `JSON.stringify`, so key order is part of the
   * contract). An import — or a provider row that is gone — seals the same
   * v1-shaped field set with no `source`; nothing is ever invented.
   */
  const metadataFor = async (
    asset: DeviceLibraryAsset,
    _assetId: string,
  ): Promise<LibraryEncryptedMetadata> =>
    buildLibraryEncryptedMetadata(
      {
        plaintextSha256: asset.plaintextSha256,
        format: asset.format,
        canonicalExtension: asset.canonicalExtension,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        origin: asset.origin,
        sourceImageId: asset.sourceImageId,
        collectedAt: asset.createdAt,
        importClassification: asset.importClassification ?? 'unknown',
      },
      await readSource(asset.sourceImageId),
    );

  /**
   * Bounded per-asset prerequisite: the account cannot protect, trash, or stop
   * protecting an asset it has never seen. This submits only the one stored
   * SP6 `collect` intent, and only from the device that created it. It is not
   * the SP8 sync engine: no change feed, no queue drain, no rebase.
   *
   * The `collect` mutation carries `meta` — the sealed metadata envelope
   * (P3C-2 Task 1's carried field) — sealed through the **injected** `cipher`
   * port, never a locally constructed one (decisions #14/#21): under
   * `encryption: 'none'` the session carries a derived pseudo-key that must
   * never perform real encryption, and only the composition layer knows
   * which cipher — real or passthrough — this session should use. A collect
   * submitted without `meta` writes a `state.json` a second device can list
   * but never materialize (`library-sync-apply.ts` counts it
   * `skippedUnknownAsset` forever) — this is decision #22's bug. The `protect`
   * mutation below deliberately does NOT re-seal/re-attach `meta`: it is a
   * carried field (`mutation.meta ?? existing?.meta` in
   * `library-cloud-client-s3.ts`'s `buildNextRecord`), so whichever `collect`
   * mutation created this asset's state — this one, or the sync engine's own
   * `buildMutation`/`sealCollectMetadata` (Task 3, same rule) — already wrote
   * it durably, and a `protect` never touches it again. Byte-shape parity with
   * `library-sync-engine.ts`'s `sealCollectMetadata` is held by the shared
   * `buildLibraryEncryptedMetadata` projection both sites call.
   */
  /**
   * K6-3a: this asset's durable `collect` intent, repaired once if it is gone.
   *
   * A missing intent used to mean the terminal `object_missing`, which is
   * retried and re-failed every round forever. But the intent is local
   * bookkeeping — the asset, its bytes, and its enrolment are all still here —
   * so it can simply be rebuilt from that durable local state and the protect
   * can continue. Exactly one repair attempt: if the re-enrol restores
   * nothing, the honest `object_missing` stands.
   */
  const findCollectIntentRepairing = async (
    context: LibrarySessionContext,
    plaintextSha256: string,
    assetId: string,
  ) => {
    const intent = await outbox.findCollectIntent(context.accountScope, assetId);
    if (intent !== null || reenroll === undefined) return intent;
    await reenroll(plaintextSha256);
    return await outbox.findCollectIntent(context.accountScope, assetId);
  };

  const ensureCollected = async (
    context: LibrarySessionContext,
    asset: DeviceLibraryAsset,
    assetId: string,
  ): Promise<LibraryAssetStateRecord | LibraryFailureCategory> => {
    const existing = await readRemoteState(context, assetId);
    if (existing !== null) return existing;
    const intent = await findCollectIntentRepairing(
      context,
      asset.plaintextSha256,
      assetId,
    );
    if (intent === null) return 'object_missing';
    if (intent.deviceId !== context.deviceId) {
      // A stored intent belongs to the device that made it; SP8 rebases it.
      return 'stale_client';
    }
    const meta = await cipher.sealMetadata({
      masterKey: context.masterKey,
      assetId,
      metadata: await metadataFor(asset, assetId),
    });
    const submitted = await cloud.submitMutations({
      mutations: [{
        mutationId: intent.mutationId,
        assetId,
        kind: 'collect',
        baseRevision: null,
        observedGeneration: null,
        originalGenerationId: null,
        newBlob: null,
        meta,
      }],
    });
    const result = submitted.results[0];
    if (result === undefined) return 'retryable_transfer';
    if (result.outcome === 'rejected') {
      return categoryForRejection(result.reason);
    }
    return result.asset ?? (await readRemoteState(context, assetId)) ?? 'object_missing';
  };

  const recordFailure = async (
    context: LibrarySessionContext,
    asset: DeviceLibraryAsset,
    assetId: string,
    remote: LibraryAssetStateRecord | null,
    category: LibraryFailureCategory,
  ): Promise<void> => {
    await protection.upsertProtection({
      accountScope: context.accountScope,
      assetId,
      plaintextSha256: asset.plaintextSha256,
      lifecycle: remote?.lifecycle ?? 'active',
      protection: 'failed',
      generation: remote?.generation ?? 1,
      revision: remote?.revision ?? null,
      originalGenerationId: remote?.generations.original ?? null,
      originalCiphertextBytes: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: category,
      trashedAt: null,
    });
  };

  const finishVerified = async (
    context: LibrarySessionContext,
    input: Readonly<{
      assetId: string;
      plaintextSha256: string;
      lifecycle: LibraryLifecycle;
      generation: number;
      revision: number | null;
      originalGenerationId: string;
      originalCiphertextBytes: number | null;
      thumbnailGenerationId: string | null;
      previewGenerationId: string | null;
      mutationId: string | null;
      appliedStateKey?: string | null;
    }>,
  ): Promise<LibraryActionResult> => {
    await protection.markProtectedAndVerified({
      accountScope: context.accountScope,
      assetId: input.assetId,
      plaintextSha256: input.plaintextSha256,
      lifecycle: input.lifecycle,
      generation: input.generation,
      revision: input.revision,
      originalGenerationId: input.originalGenerationId,
      originalCiphertextBytes: input.originalCiphertextBytes,
      thumbnailGenerationId: input.thumbnailGenerationId,
      previewGenerationId: input.previewGenerationId,
      verifiedAt: clock(),
      appliedStateKey: input.appliedStateKey ?? null,
    });
    // Intent stays until the verified terminal projection is durable.
    if (input.mutationId !== null) {
      await outbox.markSent(input.mutationId);
    }
    return { status: 'applied' };
  };

  /**
   * K7 ⑨: the second half of a protect, run behind the answer.
   *
   * `protectOnce` commits `[collect, protect]` the moment the ORIGINAL blob is
   * durable, so the asset is already `protected` and the tile already shows
   * the orange cloud when this starts. What is left is bookkeeping for OTHER
   * devices: the thumbnail and preview references, which this device never
   * reads (its local original wins in `library-render-tiers.ts`) but a second
   * device needs to draw a grid without downloading originals.
   *
   * Three properties this function must have, and the reasons:
   *
   * 1. It can only ADD. The mutation carries no lifecycle change and no
   *    `original`, and the local write preserves the row's current
   *    `protection`/`lifecycle`/`trashedAt` verbatim. A derived extra is not
   *    protection (§ State Model), so nothing here may ever take protection
   *    away — the same rule a failed derived UPLOAD already obeyed.
   * 2. It is best-effort and silent, and answers how it ended for
   *    `fillDerived` (board #27 S3). Every failure path — a derived upload
   *    that never landed, a refused patch, a lost connection, a database that
   *    closed underneath it — leaves an asset that is protected with a
   *    complete original, which is what the user asked for. The derived
   *    objects are regenerable (`repairDerived`).
   * 3. It writes the local row itself rather than leaving it to the next sync
   *    round. K7 cut 3 made discovery ETag-diffed and this same patch tells the
   *    index about its own write, so the round would correctly see "nothing
   *    changed" and never project the new references back down.
   *
   * The mutation is a `protect` whose `generationsPatch` names only derived
   * roles — see `decideLibraryMutation`'s `protect` branch, which applies
   * exactly that shape against an already-protected asset and merges every
   * other one.
   */
  const patchDerivedGenerations = async (input: Readonly<{
    context: LibrarySessionContext;
    assetId: string;
    derived: Promise<Readonly<{
      thumbnailGenerationId: string | null;
      previewGenerationId: string | null;
    }>>;
    originalGenerationId: string;
    baseRevision: number | null;
    observedGeneration: number;
  }>): Promise<'applied' | 'refused' | 'failed'> => {
    try {
      const { thumbnailGenerationId, previewGenerationId } = await input.derived;
      if (thumbnailGenerationId === null && previewGenerationId === null) {
        return 'refused';
      }
      const submitted = await cloud.submitMutations({
        mutations: [{
          mutationId: newGenerationId(),
          assetId: input.assetId,
          kind: 'protect',
          baseRevision: input.baseRevision,
          // A restore on another device mints a new generation; the derived
          // blobs belong to the old one, so the decision table rejects the
          // patch rather than folding stale references in.
          observedGeneration: input.observedGeneration,
          originalGenerationId: input.originalGenerationId,
          newBlob: null,
          generationsPatch: {
            ...(thumbnailGenerationId !== null
              ? { thumbnail: thumbnailGenerationId }
              : {}),
            ...(previewGenerationId !== null
              ? { preview: previewGenerationId }
              : {}),
          },
        }],
      });
      const result = submitted.results[0];
      if (result === undefined || result.outcome !== 'applied') return 'refused';

      const current = await protection.findByAssetId(
        input.context.accountScope,
        input.assetId,
      );
      // Read-modify-write, not `markProtectedAndVerified`: whatever the row
      // says NOW about lifecycle, protection and trash is preserved, so a
      // trash the user asked for while this ran is not undone.
      if (current === null) return 'refused';
      // The asset moved on (stop-protection, a re-protect under a new
      // original): these references belong to a generation it no longer has.
      if (current.originalGenerationId !== input.originalGenerationId) {
        return 'refused';
      }
      await protection.upsertProtection({
        accountScope: current.accountScope,
        assetId: current.assetId,
        plaintextSha256: current.plaintextSha256,
        lifecycle: current.lifecycle,
        protection: current.protection,
        generation: current.generation,
        revision: result.revision ?? current.revision,
        originalGenerationId: current.originalGenerationId,
        originalCiphertextBytes: current.originalCiphertextBytes,
        thumbnailGenerationId:
          thumbnailGenerationId ?? current.thumbnailGenerationId,
        previewGenerationId:
          previewGenerationId ?? current.previewGenerationId,
        verifiedAt: current.verifiedAt,
        failureCategory: current.failureCategory,
        trashedAt: current.trashedAt,
        appliedStateKey:
          (result.asset !== null ? readAssetStateKey(result.asset) : null)
          ?? current.appliedStateKey
          ?? null,
      });
      return 'applied';
    } catch {
      // See property 2 above: the asset is protected either way.
      return 'failed';
    }
  };

  /**
   * Board #27 S3: the derived patch each protect runs behind its answer, by
   * digest, so `fillDerived` reads the roles only after it has landed.
   */
  const derivedPatches = new Map<string, Promise<unknown>>();

  const protectOnce = async (
    plaintextSha256: string,
  ): Promise<LibraryActionResult> => {
    const context = await session.current();
    if (context === null) {
      return { status: 'blocked', category: 'auth_attention' };
    }
    const asset = await repository.findLocalAsset(plaintextSha256);
    if (
      asset === null
      || asset.localOriginalUri === null
      || asset.missingOriginalSince !== null
    ) {
      return { status: 'blocked', category: 'object_missing' };
    }
    if (!asset.protectEligible) {
      // Design: an oversize original stays a valid local asset, is reported,
      // and can never be evicted. Nothing is uploaded.
      return { status: 'blocked', category: 'unsupported_image' };
    }
    const assetId = deriveLibraryAssetId(context.masterKey, plaintextSha256);
    // K6-3a: from here on this run owns the asset. Every outbox row it writes
    // below — its own `protect`, and the `collect` intent it carries into the
    // same submit — is written strictly after this claim, so a drain that can
    // see those rows can also see the claim. That ordering is what makes the
    // ownership check correct with no lock and no window.
    claimedAssetIds.set(plaintextSha256, assetId);
    const known = await protection.findByAssetId(context.accountScope, assetId);
    if (known?.protection === 'protected' && known.verifiedAt !== null) {
      return { status: 'noop', reason: 'already-satisfied' };
    }
    if (
      known?.protection === 'failed'
      && known.failureCategory !== null
      && PROTECT_SHORT_CIRCUIT.has(known.failureCategory)
    ) {
      // Do not burn battery while the blocking state is unchanged.
      return { status: 'blocked', category: known.failureCategory };
    }

    // The account commit already landed (including a protected projection
    // adopted at join): the mirror keeps the local original, so this device
    // trusts the committed generation instead of reading it back. Mark it
    // verified and clear the retained intent — no second upload, no protect
    // mutation, no download-back.
    if (
      known?.originalGenerationId !== null
      && known?.originalGenerationId !== undefined
      && known.verifiedAt === null
      && (
        known.protection === 'protected'
        || known.protection === 'pending'
        || known.protection === 'failed'
      )
    ) {
      const retained = await outbox.find(context.accountScope, assetId, 'protect');
      // A compare-and-set keeps a projection or local action that won the gap:
      // the remote commit is evidence this device trusts only for the exact
      // generation it read, so a changed row is left for the next round.
      const committed = await protection.markCommittedVerified({
        assetId,
        accountScope: context.accountScope,
        plaintextSha256,
        lifecycle: known.lifecycle,
        protection: known.protection,
        generation: known.generation,
        revision: known.revision,
        originalGenerationId: known.originalGenerationId,
        at: clock(),
      });
      if (!committed) {
        // The row changed while this ran. Its new state will be listed by the
        // next round; mirror-up counts this noop as done and runToEmpty starts
        // another round. Keep the retained intent until that state is handled.
        return { status: 'noop', reason: 'not-applicable' };
      }
      // The remote commit is the evidence this device trusts for its resumed
      // commit — no second upload, protect mutation or download-back.
      if (retained?.mutationId !== undefined && retained.mutationId !== null) {
        await outbox.markSent(retained.mutationId);
      }
      return { status: 'applied' };
    }

    const discardStreamPath = async (uri: string): Promise<void> => {
      try {
        const temp = await files.adoptStreamFile(uri);
        await temp.discard();
      } catch {
        // The startup stream sweep is the crash backstop if cleanup itself fails.
      }
    };

    const useStreamedOriginalSeal =
      typeof decryptor?.sealToFile === 'function'
      && typeof cloud.putBlobFromFile === 'function'
      && typeof files.reserveStreamPath === 'function'
      && typeof files.adoptStreamFile === 'function';

    let envelope: Uint8Array | null = null;
    let streamedEnvelopeUri: string | null = null;
    let streamedEnvelopeSha256 = '';
    let envelopeByteLength = 0;

    if (useStreamedOriginalSeal) {
      let actualSize = asset.byteSize;
      if (typeof files.measureTemp === 'function') {
        try {
          actualSize = await files.measureTemp({
            uri: asset.localOriginalUri,
            byteSize: asset.byteSize,
            async discard() {},
          });
        } catch {
          return { status: 'blocked', category: 'object_missing' };
        }
      }
      if (actualSize !== asset.byteSize) {
        await recordFailure(context, asset, assetId, null, 'integrity');
        return { status: 'blocked', category: 'integrity' };
      }
      const candidatePath = files.reserveStreamPath();
      try {
        const sealed = await decryptor!.sealToFile!({
          masterKey: context.masterKey,
          assetId,
          scope: 'original',
          plaintextUri: asset.localOriginalUri,
          envelopeUri: candidatePath,
        });
        if (
          sealed.plaintextBytes !== asset.byteSize
          || sealed.plaintextSha256 !== plaintextSha256
        ) {
          await discardStreamPath(candidatePath);
          await recordFailure(context, asset, assetId, null, 'integrity');
          return { status: 'blocked', category: 'integrity' };
        }
        streamedEnvelopeUri = candidatePath;
        streamedEnvelopeSha256 = sealed.envelopeSha256;
        envelopeByteLength = sealed.envelopeBytes;
      } catch {
        await discardStreamPath(candidatePath);
        return { status: 'blocked', category: 'unsupported_image' };
      }
    } else {
      let plaintext: Uint8Array;
      try {
        plaintext = await files.readTemp({
          uri: asset.localOriginalUri,
          byteSize: asset.byteSize,
          async discard() {},
        });
      } catch {
        return { status: 'blocked', category: 'object_missing' };
      }
      if (plaintext.byteLength !== asset.byteSize) {
        // K6-1e (spec §2's five-second bar): this used to re-compute
        // `sha256PlaintextHex(plaintext)` and compare it to `plaintextSha256` —
        // re-verifying a file THIS app wrote seconds earlier, whose digest
        // `library-ingest.ts` already computed, used as the file name, and
        // stored as the primary key. On Hermes (no JIT) that pure-JS @noble hash
        // measured 1334 ms of JS thread for a 6 MB original, all of it before
        // the upload started. The only local failure it could really catch is a
        // truncated/partial file, and the recorded `byteSize` catches that for
        // free.
        await recordFailure(context, asset, assetId, null, 'integrity');
        return { status: 'blocked', category: 'integrity' };
      }

      try {
        envelope = await cipher.seal({
          masterKey: context.masterKey,
          assetId,
          scope: 'original',
          plaintext,
        });
        envelopeByteLength = envelope.byteLength;
      } catch {
        return { status: 'blocked', category: 'unsupported_image' };
      }
    }

    const cleanupStreamedEnvelope = async (): Promise<void> => {
      if (streamedEnvelopeUri !== null) {
        const uri = streamedEnvelopeUri;
        streamedEnvelopeUri = null;
        await discardStreamPath(uri);
      }
    };

    const queueIntent = async (
      category: LibraryFailureCategory,
      remote: LibraryAssetStateRecord | null,
    ): Promise<LibraryActionResult> => {
      await cleanupStreamedEnvelope();
      await outbox.enqueue({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        assetId,
        kind: 'protect',
        baseRevision: remote?.revision ?? null,
        observedGeneration: remote?.generation ?? null,
        payload: {
          assetId,
          plaintextSha256,
          kind: 'protect',
          reservationId: null,
          originalGenerationId: null,
          originalCiphertextBytes: envelopeByteLength,
          queuedAt: clock(),
        },
      });
      await protection.upsertProtection({
        accountScope: context.accountScope,
        assetId,
        plaintextSha256,
        lifecycle: remote?.lifecycle ?? 'active',
        protection: 'pending',
        generation: remote?.generation ?? 1,
        revision: remote?.revision ?? null,
        originalGenerationId: null,
        originalCiphertextBytes: envelopeByteLength,
        thumbnailGenerationId: null,
        previewGenerationId: null,
        verifiedAt: null,
        failureCategory: category,
        trashedAt: null,
      });
      return { status: 'queued', category };
    };

    /**
     * K6-1b: for an asset this device has never protected, the pre-flight
     * `readRemoteState` GET and the separate collect submit are both pure
     * latency (spec §2's five-second bar; §4.5 measured ~1.5 s per round trip
     * warm). The local database already answers "has this device ever seen
     * this asset" — `known === null` plus its own durable `collect` intent —
     * so nothing is learned by asking the bucket first. This path instead
     * carries the collect into the SAME `submitMutations` call as the protect,
     * where the client decides both against one GET and writes one state.json
     * (see `library-cloud-client-s3.ts`'s same-asset grouping). `remote` stays
     * null here: the bucket's answer arrives with the results.
     *
     * Everything else still takes the original path: an asset with a local
     * protection row, an intent another device created, or no stored intent at
     * all keeps `ensureCollected`'s read-then-collect semantics unchanged.
     */
    let remote: LibraryAssetStateRecord | null = null;
    let collectMutation: S3LibraryPendingMutation | null = null;
    try {
      const intent = known === null
        ? await findCollectIntentRepairing(context, plaintextSha256, assetId)
        : null;
      if (intent !== null && intent.deviceId === context.deviceId) {
        collectMutation = {
          mutationId: intent.mutationId,
          assetId,
          kind: 'collect',
          baseRevision: null,
          observedGeneration: null,
          originalGenerationId: null,
          newBlob: null,
          // Same sealed envelope, through the same injected cipher, as
          // `ensureCollected` — see that function's contract for why a collect
          // without `meta` writes a state.json no second device can
          // materialize.
          meta: await cipher.sealMetadata({
            masterKey: context.masterKey,
            assetId,
            metadata: await metadataFor(asset, assetId),
          }),
        };
      } else {
        const collected = await ensureCollected(context, asset, assetId);
        if (typeof collected === 'string') {
          if (collected === 'offline') return queueIntent('offline', null);
          await cleanupStreamedEnvelope();
          await recordFailure(context, asset, assetId, null, collected);
          return { status: 'blocked', category: collected };
        }
        remote = collected;
      }
    } catch (error) {
      const category = categoryFor(error);
      if (category === 'offline') return queueIntent('offline', null);
      await cleanupStreamedEnvelope();
      await recordFailure(context, asset, assetId, null, category);
      return { status: 'blocked', category };
    }

    if (remote !== null && remote.lifecycle !== 'active') {
      await cleanupStreamedEnvelope();
      await recordFailure(context, asset, assetId, remote, 'stale_client');
      return { status: 'blocked', category: 'stale_client' };
    }

    // Blob-first, state-second (protocol spec § 每资产状态对象): every role's
    // content-addressed blob is uploaded unconditionally BEFORE the state
    // mutation that references it, so another device can only ever read a
    // `state.json` whose generations already have durable bytes behind them.
    // A derived upload failure drops that role and never fails protection: a
    // committed thumbnail or preview alone is not protection, and derived
    // objects are regenerable. Each role's generationId is a fresh client-
    // minted id (content-addressed; BYOS has no server-assigned echo).
    //
    // All PUTs run concurrently (spec G0/G4): the throughput is fine, the cost
    // is per-request connection setup, so launching every role at once —
    // against the user's own single-tenant bucket that S3 handles thousands of
    // parallel requests for — pays that cost once, not three times in series.
    // Nothing here throttles.
    //
    // K6-1e: the original goes FIRST, before derivation has even been asked
    // for. The original's sealed envelope is already in hand at this point,
    // while derivation is decode + resize + re-encode on the JS thread —
    // measured 1618 ms for a 6 MB image, all of it previously spent before the
    // original's first byte left the device. The original is the payload the
    // user is waiting on (spec §2's five-second bar); the thumbnail and
    // preview are regenerable extras and now ride alongside it instead of
    // ahead of it.
    const generationId = newGenerationId();
    /**
     * K6-2 (spec §2 G3, owner: 「不是假百分比，必须得是实际的真实百分比」).
     *
     * One accumulator per role, summed on every report: the ring's numerator is
     * the bytes the upload tasks say are on the server, and its denominator is
     * the ciphertext this protect is actually sending. Nothing is estimated and
     * nothing advances on a timer — a report is the only thing that moves it.
     *
     * K7 ⑨: the only role that reports here is the ORIGINAL. The derived
     * uploads no longer hold up the commit, so they no longer hold up the ring
     * either — it measures exactly the payload the user is waiting on, reaches
     * 100% when that payload is durable, and hands the tile straight to the
     * orange cloud. (Its denominator used to grow when derivation finished,
     * which kept the ring alive for objects this device never reads.)
     *
     * `plaintextSha256` is the key because that is the identity the grid tile
     * holds; the run is cleared in `protect`'s `finally` (below), so every exit
     * — applied, blocked, queued, thrown — takes the ring down.
     */
    const sentByRole = new Map<LibraryGenerationRole, number>();
    const totalByRole = new Map<LibraryGenerationRole, number>();
    const publishProgress = (): void => {
      let sent = 0;
      let total = 0;
      for (const value of sentByRole.values()) sent += value;
      for (const value of totalByRole.values()) total += value;
      transferProgress.set(plaintextSha256, { sent, total });
    };
    const reportProgress = (role: LibraryGenerationRole) =>
      (progress: Readonly<{ sent: number; total: number }>): void => {
        sentByRole.set(role, progress.sent);
        totalByRole.set(role, progress.total);
        publishProgress();
      };
    sentByRole.set('original', 0);
    totalByRole.set('original', envelopeByteLength);
    publishProgress();

    const originalInFlight = (streamedEnvelopeUri !== null
      ? cloud.putBlobFromFile!(
          generationId,
          streamedEnvelopeUri,
          {
            contentSha256: streamedEnvelopeSha256,
            byteLength: envelopeByteLength,
            onProgress: reportProgress('original'),
          },
        ).finally(() => cleanupStreamedEnvelope())
      : cloud.putBlob(
          generationId,
          envelope!,
          reportProgress('original'),
        ));
    // Derivation is awaited below, so an original that fails fast would sit
    // unhandled until then. Claim the rejection now; the real outcome is still
    // taken from `originalInFlight` afterwards.
    originalInFlight.catch(() => {});

    // Narrowed above (a null `localOriginalUri` already returned
    // `object_missing`); bound here because that narrowing does not follow a
    // property access into the closure below.
    const sourceUri = asset.localOriginalUri;

    // Derived roles are produced from the same local original, on a path that
    // can never fail protection: § State Model says a committed thumbnail or
    // preview alone is not protection, and derived objects are regenerable.
    // This whole block therefore swallows its own failures and only reports
    // which roles made it all the way into the bucket.
    //
    // K7 ⑨: nothing below this point is awaited before the commit. The whole
    // block now runs BEHIND the `[collect, protect]` write — see
    // `patchDerivedGenerations` at the end of this function, which is the one
    // consumer of this promise.
    const derivedInFlight = (async (): Promise<Readonly<{
      thumbnailGenerationId: string | null;
      previewGenerationId: string | null;
    }>> => {
      type SealedDerived = Readonly<{
        role: 'thumbnail' | 'preview';
        envelope: Uint8Array;
      }>;
      const sealedDerived: SealedDerived[] = [];
      try {
        const produced = await derived.derive({
          sourceUri,
          format: asset.format,
          width: asset.width,
          height: asset.height,
        });
        for (const image of [produced.thumbnail, produced.preview]) {
          if (image === null) continue;
          try {
            sealedDerived.push({
              role: image.role,
              envelope: await cipher.seal({
                masterKey: context.masterKey,
                assetId,
                scope: image.role,
                plaintext: image.bytes,
              }),
            });
          } catch {
            // One unsealable derived role never blocks the original.
          }
        }
      } catch {
        // Protection proceeds on the original alone.
      }

      const derivedPlan = sealedDerived.map((entry) => ({
        role: entry.role,
        generationId: newGenerationId(),
        envelope: entry.envelope,
      }));
      // A derived role's upload rejection drops that role and never blocks the
      // original; only the original's failure fails protection.
      //
      // K7 ⑨: no `onProgress` reporter. By the time these PUTs run the commit
      // has already landed and the tile is showing the orange cloud, so a
      // report here would either be ignored or — worse — redraw a ring over an
      // asset that is already backed up.
      const settled = await Promise.allSettled(
        derivedPlan.map((plan) => cloud.putBlob(plan.generationId, plan.envelope)),
      );
      let thumbnail: string | null = null;
      let preview: string | null = null;
      settled.forEach((outcome, index) => {
        if (outcome.status !== 'fulfilled') return;
        const { role, generationId: id } = derivedPlan[index]!;
        if (role === 'thumbnail') thumbnail = id;
        else preview = id;
      });
      return { thumbnailGenerationId: thumbnail, previewGenerationId: preview };
    })();

    try {
      await originalInFlight;
    } catch (error) {
      const category = categoryFor(error);
      if (category === 'offline') return queueIntent('offline', remote);
      await recordFailure(context, asset, assetId, remote, category);
      return { status: 'blocked', category };
    }

    let committed: S3LibraryRemoteMutationResult;
    let collected: S3LibraryRemoteMutationResult | null = null;
    const mutationId = (await outbox.enqueue({
      accountScope: context.accountScope,
      deviceId: context.deviceId,
      assetId,
      kind: 'protect',
      baseRevision: remote?.revision ?? null,
      observedGeneration: remote?.generation ?? null,
      payload: {
        assetId,
        plaintextSha256,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: generationId,
        originalCiphertextBytes: envelopeByteLength,
        // K7 ⑨: the derived ids are deliberately absent. They do not exist yet
        // — derivation is still running behind this commit — and the row's
        // only job is to let a crash-restart drain replay the write that
        // makes the asset PROTECTED, which the original alone does. A crash
        // that loses the derived patch loses two regenerable objects the
        // uploading device never reads; `repairDerived` and the next protect
        // both rebuild them.
        queuedAt: clock(),
      },
    })).mutationId;
    try {
      // The ORIGINAL blob is durable above, so the caller's `generationsPatch`
      // obligation ("blob durable before state") is met for the one role this
      // write references. The derived roles are added later, by
      // `patchDerivedGenerations`, and only after their own PUTs resolve.
      //
      // K6-1b: on the fresh path this batch also carries the `collect`, so one
      // round trip creates the asset AND marks it protected. `baseRevision`/
      // `observedGeneration` are null there — the protect has no independent
      // base to state, so the client bases it on whatever the collect ahead of
      // it in the group rolled the record to (`rebaseWithinGroup`).
      const submitted = await cloud.submitMutations({
        mutations: [
          ...(collectMutation === null ? [] : [collectMutation]),
          {
            mutationId,
            assetId,
            kind: 'protect',
            baseRevision: remote?.revision ?? null,
            observedGeneration: remote?.generation ?? null,
            originalGenerationId: generationId,
            newBlob: null,
            generationsPatch: { original: generationId },
          },
        ],
      });
      const byId = new Map(
        submitted.results.map((entry) => [entry.mutationId, entry]),
      );
      const result = byId.get(mutationId);
      if (result === undefined) throw new Error('missing mutation result');
      committed = result;
      collected = collectMutation === null
        ? null
        : (byId.get(collectMutation.mutationId) ?? null);
    } catch (error) {
      const category = categoryFor(error);
      if (isKnownNotApplied(error)) {
        // The write was refused before applying: nothing was committed.
        await outbox.markFailed(mutationId, category);
      } else {
        // Dispatched, outcome never learned. The row stays `sending` with its
        // stable mutationId so SP8's drain replays it and the account returns
        // its stored terminal result instead of a second protect.
        await outbox.markOutcomeUnknown(mutationId, category);
      }
      if (category !== 'offline') {
        await recordFailure(context, asset, assetId, remote, category);
      }
      return category === 'offline'
        ? { status: 'queued', category }
        : { status: 'blocked', category };
    }

    // K6-1b: the grouped `collect` answers in the same response. A refusal
    // here is what `ensureCollected` used to surface before anything was
    // uploaded — most importantly another device's trash winning over this
    // collect (`trash_wins` -> `stale_client`). The asset is NOT protected;
    // the blobs already uploaded are unreferenced and belong to the orphan
    // sweep (spec G7/K6-4), never to a retry loop here.
    if (collected !== null && collected.outcome === 'rejected') {
      const category = categoryForRejection(collected.reason);
      await outbox.markFailed(mutationId, category);
      await recordFailure(context, asset, assetId, collected.asset, category);
      return { status: 'blocked', category };
    }

    if (committed.outcome === 'rejected') {
      const category = categoryForRejection(committed.reason);
      await outbox.markFailed(mutationId, category);
      await recordFailure(context, asset, assetId, remote, category);
      return { status: 'blocked', category };
    }

    // BYOS has no server-authoritative generation-id echo: the id this device
    // just minted and uploaded IS the authoritative original (it is what the
    // `state.json` this mutation wrote now references). Trust the local var.
    const committedGeneration = generationId;
    const committedLifecycle = committed.asset?.lifecycle ?? 'active';
    const committedAssetGeneration =
      committed.asset?.generation ?? remote?.generation ?? 1;
    const committedRevision =
      committed.revision ?? committed.asset?.revision ?? remote?.revision ?? null;
    const committedStateKey =
      committed.asset !== null
        ? readAssetStateKey(committed.asset)
        : (remote !== null ? readAssetStateKey(remote) : null);
    // Design contract: commit leaves the account asset `pending`. `protected`
    // is recorded only after decrypt-and-hash verify succeeds. Keep the protect
    // outbox row until verification finishes so a later protect() can resume
    // the committed generation without re-uploading.
    await protection.upsertProtection({
      accountScope: context.accountScope,
      assetId,
      plaintextSha256,
      lifecycle: committedLifecycle,
      protection: 'pending',
      generation: committedAssetGeneration,
      revision: committedRevision,
      originalGenerationId: committedGeneration,
      originalCiphertextBytes: envelopeByteLength,
      // K7 ⑨: not known yet — `patchDerivedGenerations` writes them when the
      // derived uploads it is still running actually land.
      thumbnailGenerationId: null,
      previewGenerationId: null,
      // Not verified yet: eviction stays forbidden until finishVerified runs.
      verifiedAt: null,
      failureCategory: null,
      trashedAt: null,
      appliedStateKey: committedStateKey,
    });

    // R2 answered 200 and the state.json now references this content-addressed
    // blob, so the bytes are proven durable (spec G4) — no download-back.
    const outcome = await finishVerified(context, {
      assetId,
      plaintextSha256,
      lifecycle: committedLifecycle,
      generation: committedAssetGeneration,
      revision: committedRevision,
      originalGenerationId: committedGeneration,
      originalCiphertextBytes: envelopeByteLength,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      mutationId,
      appliedStateKey: committedStateKey,
    });

    // K7 ⑨: the tile is orange from here. Everything the derived roles still
    // owe happens behind this return and can only ever ADD references.
    const patch = patchDerivedGenerations({
      context,
      assetId,
      derived: derivedInFlight,
      originalGenerationId: committedGeneration,
      baseRevision: committedRevision,
      observedGeneration: committedAssetGeneration,
    });
    // Board #27 S3: eviction joins this before it reads which roles the cloud has.
    derivedPatches.set(plaintextSha256, patch);
    void patch.finally(() => {
      if (derivedPatches.get(plaintextSha256) === patch) {
        derivedPatches.delete(plaintextSha256);
      }
    });
    return outcome;
  };

  /**
   * K6-1c: one upload per digest, ever, no matter how many callers ask.
   *
   * Two callers legitimately race for every freshly saved image: the save path
   * calls `applySavePolicyAfterIngest` -> `protect(sha)` the instant the file
   * lands, and the K4 sync round's `mirrorUp` lists the same still-pending row
   * as a protect candidate moments later. Both ran the full upload, so the
   * owner's bucket held 15 objects for 3 images — every blob written twice
   * under a different generationId (measured 2026-09-13 23:26) — and the
   * wasted traffic ate into spec §2's five-second bar (G3/G7: written objects
   * must equal referenced objects).
   *
   * The second caller gets the SAME promise, not a queued re-run: re-running
   * after the first finished would answer `noop`/`already-satisfied` instead
   * of the first call's real outcome, and would still have paid a pointless
   * extra pass. The entry is removed as soon as the run settles, so the next
   * caller after that starts a genuine attempt (a failed protect stays
   * retryable).
   *
   * In-process only, and that is the whole scope: the two racing callers are
   * both in this app process, sharing one action instance (see
   * `library-integration-impl.ts`, where `applySavePolicyAfterIngest` and
   * `mirrorUp.protect` are the same object). Cross-process serialization is
   * K4's lease, not this map.
   */
  const inFlight = new Map<string, Promise<LibraryActionResult>>();
  /**
   * K6-3a: the same in-flight run, under the identity the drain holds. A
   * digest becomes an assetId only after the session's master key is in hand
   * (`deriveLibraryAssetId` above), so this is populated a few statements into
   * the run rather than at its first line. Nothing is lost by that: the rows
   * the drain could race are all written later still.
   */
  const claimedAssetIds = new Map<string, string>();
  const protect = (plaintextSha256: string): Promise<LibraryActionResult> => {
    const existing = inFlight.get(plaintextSha256);
    if (existing !== undefined) return existing;
    const run = protectOnce(plaintextSha256).finally(() => {
      inFlight.delete(plaintextSha256);
      claimedAssetIds.delete(plaintextSha256);
      // K6-2: the ring belongs to an upload that is in flight. Whatever this
      // run settled as — committed, blocked, queued offline, thrown — there is
      // no transfer any more, so the tile goes back to the `protection` the
      // database now records (the orange cloud on success). Clearing here
      // rather than at each `return` inside `protectOnce` is what makes that
      // unconditional; it is also the only exit the K6-1c dedupe has, so the
      // joined second caller can never clear a still-running first one.
      transferProgress.clear(plaintextSha256);
    });
    inFlight.set(plaintextSha256, run);
    return run;
  };

  return {
    protect,
    readRemoteState,
    ensureCollected,

    isInFlight(assetId) {
      for (const claimed of claimedAssetIds.values()) {
        if (claimed === assetId) return true;
      }
      return false;
    },

    settled(plaintextSha256) {
      const noop = (): void => undefined;
      return inFlight.get(plaintextSha256)?.then(noop, noop) ?? Promise.resolve();
    },

    settledAll() {
      return Promise.allSettled([...inFlight.values()]).then(() => undefined);
    },

    async fillDerived(plaintextSha256) {
      try {
        await inFlight.get(plaintextSha256)?.catch(() => undefined);
        await derivedPatches.get(plaintextSha256);
        const context = await session.current();
        if (context === null) return { status: 'retry' };
        const record = await protection.findByDigest(
          context.accountScope,
          plaintextSha256,
        );
        if (
          record === null || record.protection !== 'protected'
          || record.lifecycle !== 'active' || record.originalGenerationId === null
        ) return { status: 'unfillable' };
        const missing: ('thumbnail' | 'preview')[] = [];
        if (record.thumbnailGenerationId === null) missing.push('thumbnail');
        if (record.previewGenerationId === null) missing.push('preview');
        if (missing.length === 0) return { status: 'complete' };
        const asset = await repository.findLocalAsset(plaintextSha256);
        if (
          asset === null || asset.residency !== 'local-original'
          || asset.missingOriginalSince !== null || asset.localOriginalUri === null
          || !(await files.hasOwnOriginal(asset.localOriginalUri))
        ) return { status: 'unfillable' };
        let produced: Awaited<ReturnType<typeof derived.derive>>;
        try {
          produced = await derived.derive({
            sourceUri: asset.localOriginalUri,
            format: asset.format,
            width: asset.width,
            height: asset.height,
            roles: missing,
          });
        } catch {
          // This phone cannot produce the role from its original.
          return { status: 'unfillable' };
        }
        const assetId = deriveLibraryAssetId(context.masterKey, plaintextSha256);
        let thumbnailGenerationId: string | null = null;
        let previewGenerationId: string | null = null;
        let transferFailed = false;
        for (const image of [produced.thumbnail, produced.preview]) {
          if (image === null) continue;
          const generationId = newGenerationId();
          try {
            const envelope = await cipher.seal({
              masterKey: context.masterKey,
              assetId,
              scope: image.role,
              plaintext: image.bytes,
            });
            await cloud.putBlob(generationId, envelope);
          } catch {
            transferFailed = true;
            continue;
          }
          if (image.role === 'thumbnail') thumbnailGenerationId = generationId;
          else previewGenerationId = generationId;
        }
        if (thumbnailGenerationId !== null || previewGenerationId !== null) {
          const patched = await patchDerivedGenerations({
            context,
            assetId,
            derived: Promise.resolve({ thumbnailGenerationId, previewGenerationId }),
            originalGenerationId: record.originalGenerationId,
            baseRevision: record.revision,
            observedGeneration: record.generation,
          });
          if (patched === 'failed') return { status: 'retry' };
          if (patched === 'refused') return { status: 'unfillable' };
        }
        if (transferFailed) return { status: 'retry' };
        const made = [produced.thumbnail, produced.preview]
          .filter((image) => image !== null).length;
        return { status: made === missing.length ? 'complete' : 'unfillable' };
      } catch {
        // A read, a session or a seal that threw: transient — keep the
        // original this round (Spec delta 1).
        return { status: 'retry' };
      }
    },

    async applySavePolicyAfterIngest(plaintextSha256) {
      // C1 mirror (owner ruling 2026-09-09): when BYOS is connected, every
      // ingest is backed up. There is no save-policy gate and no eviction at
      // ingest — the mirror keeps the local original. Runs strictly after the
      // local commit, so a failure here can never undo the durable local asset.
      // (C4b removed the now-inert `library-policy-store` and the policy
      // chooser; the historical name is kept here to avoid a rename churning
      // every caller in this cut.)
      return protect(plaintextSha256);
    },
  };
}
