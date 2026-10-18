import type {
  LibraryActionResult,
  LibraryFailureCategory,
  LibrarySessionContext,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import {
  hasUnknownOutcome,
  type LibraryActionOutbox,
} from '@/features/library/library-action-outbox';
import {
  isKnownNotApplied,
  LibraryCloudError,
} from '@/features/library/library-cloud-errors';
import type { LibraryAssetStateRecord } from '@/features/library/library-asset-state-codec';
import type {
  LibraryCloudClient,
  S3LibraryRemoteRejectionReason,
} from '@/features/library/library-cloud-client-s3';
import type { LibraryFileStore } from '@/features/library/library-file-store';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import type { LibraryLocalActions } from '@/features/library/library-local-actions';
import {
  categoryForRejection,
  type LibraryProtectAction,
} from '@/features/library/library-protect-action';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';
import type { LibraryRepository } from '@/features/library/library-repository';

export type LibraryAccountActions = Readonly<{
  stopProtection(plaintextSha256: string): Promise<LibraryActionResult>;
  removeFromLibrary(plaintextSha256: string): Promise<LibraryActionResult>;
}>;

export type LibraryAccountActionsDependencies = Readonly<{
  repository: LibraryRepository;
  protection: LibraryProtectionRepository;
  outbox: LibraryActionOutbox;
  files: LibraryFileStore;
  cloud: Pick<LibraryCloudClient, 'submitMutations'>;
  session: LibrarySessionPort;
  protectAction: LibraryProtectAction;
  localActions: LibraryLocalActions;
  clock?: () => number;
}>;

/**
 * `adoptStopped`/`applyLocal` below only ever read `lifecycle`/`generation`/
 * `revision` off an observed remote snapshot. Both sources they're called
 * with are now the narrow `LibraryAssetStateRecord`: the one
 * `protectAction.readRemoteState`/`ensureCollected` return (BYOS
 * reconciliation port) and the one carried on
 * `S3LibraryRemoteMutationResult.asset` (from `cloud.submitMutations`). This
 * Pick is the minimal shape both are structurally assignable to, so neither
 * call site needs a cast.
 */
type RemoteAssetSnapshot = Pick<
  LibraryAssetStateRecord,
  'lifecycle' | 'generation' | 'revision'
>;

function categoryFor(error: unknown): LibraryFailureCategory {
  if (error instanceof LibraryCloudError) return error.category;
  return 'retryable_transfer';
}

/**
 * `categoryForRejection` (from `library-protect-action.ts`) is now itself
 * typed for `S3LibraryRemoteRejectionReason | null` and already maps
 * `'corrupt_remote_state'` to `'integrity'` (this file's existing convention
 * for corrupt-remote-data failures, e.g. the ciphertext-hash mismatch check
 * in `stopProtection`'s caller `library-local-actions.ts`). This thin wrapper
 * stays only as this file's single call surface for both mutation-rejection
 * sites below; it delegates unchanged.
 */
function categoryForResultRejection(
  reason: S3LibraryRemoteRejectionReason | null,
): LibraryFailureCategory {
  return categoryForRejection(reason);
}

export function createLibraryAccountActions({
  repository,
  protection,
  outbox,
  files,
  cloud,
  session,
  protectAction,
  localActions,
  clock = Date.now,
}: LibraryAccountActionsDependencies): LibraryAccountActions {
  const resolve = async (
    plaintextSha256: string,
  ): Promise<
    | Readonly<{ status: 'ready'; context: LibrarySessionContext; assetId: string }>
    | LibraryActionResult
  > => {
    const context = await session.current();
    if (context === null) {
      return { status: 'blocked', category: 'auth_attention' };
    }
    const asset = await repository.findLocalAsset(plaintextSha256);
    if (asset === null) {
      return { status: 'blocked', category: 'object_missing' };
    }
    return {
      status: 'ready',
      context,
      assetId: deriveLibraryAssetId(context.masterKey, plaintextSha256),
    };
  };

  return {
    async stopProtection(plaintextSha256) {
      const resolved = await resolve(plaintextSha256);
      if (resolved.status !== 'ready') return resolved;
      const { context, assetId } = resolved;
      const record = await protection.findByAssetId(context.accountScope, assetId);
      if (record === null || record.protection !== 'protected') {
        return { status: 'noop', reason: 'not-applicable' };
      }
      if (record.lifecycle === 'purged') {
        return { status: 'blocked', category: 'stale_client' };
      }

      const adoptStopped = async (
        observed: RemoteAssetSnapshot | null,
        revision: number | null,
      ): Promise<void> => {
        await protection.upsertProtection({
          accountScope: context.accountScope,
          assetId,
          plaintextSha256,
          lifecycle: observed?.lifecycle ?? record.lifecycle,
          protection: 'unprotected',
          generation: observed?.generation ?? record.generation,
          revision: revision ?? observed?.revision ?? record.revision,
          originalGenerationId: null,
          originalCiphertextBytes: null,
          thumbnailGenerationId: null,
          previewGenerationId: null,
          verifiedAt: null,
          failureCategory: null,
          trashedAt: record.trashedAt,
        });
      };

      // The authoritative index read comes first. It is the cheap, idempotent
      // way to learn whether an earlier dispatch whose response was lost has
      // already deleted the cloud original — in which case downloading it
      // again is impossible and re-submitting is unnecessary.
      let remote: LibraryAssetStateRecord | null;
      try {
        remote = await protectAction.readRemoteState(context, assetId);
      } catch (error) {
        return { status: 'blocked', category: categoryFor(error) };
      }
      if (remote === null) {
        return { status: 'blocked', category: 'object_missing' };
      }

      const dispatched = await outbox.find(
        context.accountScope,
        assetId,
        'stop-protection',
      );
      if (
        dispatched !== null
        && hasUnknownOutcome(dispatched)
        && remote.protection !== 'protected'
      ) {
        // The lost response did commit. Adopt the authoritative state and
        // release the intent instead of issuing a second destructive mutation.
        await adoptStopped(remote, remote.revision);
        await outbox.markSent(dispatched.mutationId);
        return { status: 'applied' };
      }
      // Reaching here with `remote.protection === 'protected'` proves any
      // earlier dispatch did not commit, so the normal path is safe again.

      // Design: if the protected object is the only reliable original, the app
      // must first download, authenticate, and durably store it here. This is
      // the safe-local-copy gate, and it blocks — never deletes — on failure.
      const local = await repository.findLocalAsset(plaintextSha256);
      const hasProvedLocalCopy = local?.localOriginalUri != null
        && local.missingOriginalSince === null
        && local.residency === 'local-original'
        && record.verifiedAt !== null;
      if (!hasProvedLocalCopy) {
        const downloaded = await localActions.download(plaintextSha256);
        if (downloaded.status !== 'applied' && downloaded.status !== 'noop') {
          return downloaded;
        }
      }

      // Account-global and destructive: one stable mutation, kept until its
      // outcome is known.
      const enqueued = await outbox.enqueue({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        assetId,
        kind: 'stop-protection',
        baseRevision: remote.revision,
        observedGeneration: remote.generation,
        payload: {
          assetId,
          plaintextSha256,
          kind: 'stop-protection',
          reservationId: null,
          originalGenerationId: record.originalGenerationId,
          originalCiphertextBytes: null,
          queuedAt: clock(),
        },
      });
      try {
        const submitted = await cloud.submitMutations({
          mutations: [{
            mutationId: enqueued.mutationId,
            assetId,
            kind: 'stop-protection',
            baseRevision: remote.revision,
            observedGeneration: remote.generation,
            originalGenerationId: null,
            newBlob: null,
          }],
        });
        const result = submitted.results[0];
        if (result === undefined) throw new Error('missing mutation result');
        if (result.outcome === 'rejected') {
          // Note: production `decideLibraryMutation` never rejects a
          // stop-protection with `not_protected` — an already-unprotected
          // asset resolves as `merged`, not a rejection — so there is no
          // `not_protected` branch here. A `merged` outcome falls through to
          // the success path below (the intent is satisfied).
          const category = categoryForResultRejection(result.reason);
          await outbox.markFailed(enqueued.mutationId, category);
          return { status: 'blocked', category };
        }
        await adoptStopped(result.asset, result.revision);
        await outbox.markSent(enqueued.mutationId);
        return { status: 'applied' };
      } catch (error) {
        const category = categoryFor(error);
        if (isKnownNotApplied(error)) {
          // The Worker answered and refused: the cloud original is intact and
          // the user can retry, so the intent stays a plain failure.
          await outbox.markFailed(enqueued.mutationId, category);
          return { status: 'blocked', category };
        }
        // The response was lost. This mutation may already have deleted the
        // cloud original, so the intent is preserved for idempotent
        // resolution and every local eviction path refuses this asset until
        // then. Discarding it here could destroy the final reliable original.
        await outbox.markOutcomeUnknown(enqueued.mutationId, category);
        return { status: 'blocked', category };
      }
    },

    async removeFromLibrary(plaintextSha256) {
      const resolved = await resolve(plaintextSha256);
      if (resolved.status !== 'ready') return resolved;
      const { context, assetId } = resolved;
      const record = await protection.findByAssetId(context.accountScope, assetId);
      if (record?.lifecycle === 'purged') {
        return { status: 'noop', reason: 'already-satisfied' };
      }
      const existingState = await protection.readDeviceState(plaintextSha256);
      if (record?.lifecycle === 'trash' && existingState?.deviceTrashedAt != null) {
        return { status: 'noop', reason: 'already-satisfied' };
      }
      const asset = await repository.findLocalAsset(plaintextSha256);
      if (asset === null) {
        return { status: 'blocked', category: 'object_missing' };
      }

      const at = clock();
      const applyLocal = async (
        remote: RemoteAssetSnapshot | null,
      ): Promise<void> => {
        // Adopt the authoritative lifecycle. A lost trash response may already
        // have been followed by server purge — projecting `trash` would leave
        // a false account view after markSent clears the intent.
        const lifecycle = remote?.lifecycle === 'purged' ? 'purged' : 'trash';
        const purged = lifecycle === 'purged';
        await protection.upsertProtection({
          accountScope: context.accountScope,
          assetId,
          plaintextSha256,
          lifecycle,
          // Purged clears cloud protection/object refs: the original no longer
          // exists remotely. Trash may still retain protected-object state
          // until SP8 learns the revision.
          protection: purged
            ? 'unprotected'
            : (record?.protection ?? 'unprotected'),
          generation: remote?.generation ?? record?.generation ?? 1,
          revision: remote?.revision ?? record?.revision ?? null,
          originalGenerationId: purged
            ? null
            : (record?.originalGenerationId ?? null),
          originalCiphertextBytes: purged
            ? null
            : (record?.originalCiphertextBytes ?? null),
          thumbnailGenerationId: purged
            ? null
            : (record?.thumbnailGenerationId ?? null),
          previewGenerationId: purged
            ? null
            : (record?.previewGenerationId ?? null),
          verifiedAt: purged ? null : (record?.verifiedAt ?? null),
          failureCategory: null,
          trashedAt: at,
        });
        // SP7 never permanently deletes device bytes. A protected asset keeps
        // its local original (eviction needs a durable trash revision — SP8).
        // An unprotected original is retained in device trash for 30 days,
        // including when the account lifecycle has already advanced to purged.
        if (
          record?.protection !== 'protected'
          && asset.localOriginalUri !== null
        ) {
          const trashUri = await files.moveOriginalToDeviceTrash(
            asset.localOriginalUri,
            plaintextSha256,
            asset.canonicalExtension,
          );
          await protection.setDeviceTrash(plaintextSha256, trashUri, at);
          await protection.setResidency(plaintextSha256, 'cached', null);
        } else {
          await protection.setDeviceTrash(plaintextSha256, null, at);
        }
      };

      // Stable mutationId first: a parked unknown trash reuses this row.
      const enqueued = await outbox.enqueue({
        accountScope: context.accountScope,
        deviceId: context.deviceId,
        assetId,
        kind: 'trash',
        baseRevision: record?.revision ?? null,
        observedGeneration: record?.generation ?? null,
        payload: {
          assetId,
          plaintextSha256,
          kind: 'trash',
          reservationId: null,
          originalGenerationId: null,
          originalCiphertextBytes: null,
          queuedAt: at,
        },
      });

      let remote: LibraryAssetStateRecord | null = null;
      let trashDispatched = false;
      try {
        const collected = await protectAction.ensureCollected(
          context,
          asset,
          assetId,
        );
        if (typeof collected === 'string') {
          if (collected === 'offline') {
            // Never reached the Worker: keep the pending intent for SP8 drain
            // and apply the local device-trash move so bytes survive.
            await applyLocal(null);
            return { status: 'queued', category: 'offline' };
          }
          await outbox.markFailed(enqueued.mutationId, collected);
          return { status: 'blocked', category: collected };
        }
        remote = collected;

        const parked = await outbox.find(context.accountScope, assetId, 'trash');
        if (
          parked !== null
          && hasUnknownOutcome(parked)
          && (remote.lifecycle === 'trash' || remote.lifecycle === 'purged')
        ) {
          // The lost response did commit (and may already be purged). Adopt
          // that authoritative lifecycle, then release the intent — markSent
          // only after the durable projection is written.
          await applyLocal(remote);
          await outbox.markSent(parked.mutationId);
          return { status: 'applied' };
        }
        // Remote still `active` proves any earlier dispatch did not commit.

        trashDispatched = true;
        const submitted = await cloud.submitMutations({
          mutations: [{
            mutationId: enqueued.mutationId,
            assetId,
            kind: 'trash',
            baseRevision: remote.revision,
            observedGeneration: remote.generation,
            originalGenerationId: null,
            newBlob: null,
          }],
        });
        const result = submitted.results[0];
        if (result === undefined) throw new Error('missing mutation result');
        if (result.outcome === 'rejected') {
          const category = categoryForResultRejection(result.reason);
          await outbox.markFailed(enqueued.mutationId, category);
          return { status: 'blocked', category };
        }
        await applyLocal(result.asset ?? remote);
        await outbox.markSent(enqueued.mutationId);
        return { status: 'applied' };
      } catch (error) {
        const category = categoryFor(error);
        if (!trashDispatched && category === 'offline') {
          await applyLocal(null);
          return { status: 'queued', category };
        }
        if (isKnownNotApplied(error)) {
          // The Worker answered and refused: nothing was trashed, retry later.
          await outbox.markFailed(enqueued.mutationId, category);
          return { status: 'blocked', category };
        }
        // The response was lost. This mutation may already have trashed the
        // account asset, so the intent is preserved for idempotent resolution
        // and every local eviction path refuses this asset until then.
        await outbox.markOutcomeUnknown(enqueued.mutationId, category);
        return { status: 'blocked', category };
      }
    },
  };
}
