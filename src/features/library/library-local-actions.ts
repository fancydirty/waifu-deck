import type {
  LibraryActionKind,
  LibraryActionResult,
  LibraryFailureCategory,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import {
  hasUnknownOutcome,
  type LibraryActionOutbox,
} from '@/features/library/library-action-outbox';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import type { LibraryCloudClient } from '@/features/library/library-cloud-client-s3';
import type { LibraryFileStore } from '@/features/library/library-file-store';
import {
  LibraryCopySourceMissingError,
  LibraryLocalStorageError,
  type LibraryFileDecryptor,
} from '@/features/library/library-file-decryptor';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import type { LibraryProtectionRepository } from '@/features/library/library-protection-repository';
import type { LibraryRepository } from '@/features/library/library-repository';
import {
  downloadCategoryFor,
  transferFaultFor,
  type LibraryTransferFault,
} from '@/features/library/library-transfer-fault';
import {
  runWithOwnership,
  type LibraryRoleFetch,
  type LibraryTransferCoalescer,
} from '@/features/library/library-transfer-coalescer';

export type LibraryLocalActions = Readonly<{
  download(plaintextSha256: string): Promise<LibraryActionResult>;
  freeDeviceSpace(plaintextSha256: string): Promise<LibraryActionResult>;
  availableActions(
    plaintextSha256: string,
  ): Promise<readonly LibraryActionKind[]>;
}>;

export type LibraryLocalActionsDependencies = Readonly<{
  repository: LibraryRepository;
  protection: LibraryProtectionRepository;
  outbox: LibraryActionOutbox;
  files: LibraryFileStore;
  cipher: LibraryObjectCipher;
  /** Task 3 file decryptor; consumed by the streamed download path in Task 4. */
  decryptor: LibraryFileDecryptor;
  cloud: Pick<LibraryCloudClient, 'getObjectToFile'>;
  session: LibrarySessionPort;
  transferCoalescer: LibraryTransferCoalescer<LibraryRoleFetch>;
  clock?: () => number;
}>;

export function createLibraryLocalActions({
  repository,
  protection,
  outbox,
  files,
  decryptor,
  cloud,
  session,
  transferCoalescer,
  clock = Date.now,
}: LibraryLocalActionsDependencies): LibraryLocalActions {
  const discardStreamPath = async (uri: string): Promise<void> => {
    try {
      const temp = await files.adoptStreamFile(uri);
      await temp.discard();
    } catch {
      // The startup stream sweep is the crash backstop if cleanup itself fails.
    }
  };

  /**
   * An unconfirmed `stop-protection` or `trash` may already have removed the
   * cloud original, so the local `protected` projection is not proof that a
   * second copy exists. No eviction may run until that intent is resolved.
   */
  const hasUnresolvedDestructiveOutcome = async (
    accountScope: string,
    assetId: string,
  ): Promise<boolean> => {
    const stop = await outbox.find(accountScope, assetId, 'stop-protection');
    if (hasUnknownOutcome(stop)) return true;
    return hasUnknownOutcome(await outbox.find(accountScope, assetId, 'trash'));
  };

  const blocked = (
    category: LibraryFailureCategory,
  ): LibraryActionResult => ({ status: 'blocked', category });

  const failed = (
    stage: 'transfer' | 'consume',
    fault: LibraryTransferFault,
  ): LibraryRoleFetch => ({ kind: 'failed', stage, fault });

  type DownloadAsset = NonNullable<Awaited<ReturnType<LibraryRepository['findLocalAsset']>>>;
  type DownloadAssessment =
    | Readonly<{
      kind: 'stop';
      result: LibraryActionResult;
      shared: LibraryRoleFetch;
    }>
    | Readonly<{
      kind: 'clear';
      asset: DownloadAsset;
      generationId: string;
    }>;

  const assessDownload = async (
    accountScope: string,
    assetId: string,
    plaintextSha256: string,
  ): Promise<DownloadAssessment> => {
    const asset = await repository.findLocalAsset(plaintextSha256);
    if (asset === null) {
      return {
        kind: 'stop',
        result: blocked('object_missing'),
        shared: failed('transfer', { kind: 'missing' }),
      };
    }
    const record = await protection.findByAssetId(accountScope, assetId);
    // Trash / purged follow trash semantics, not normal-library download.
    if (record !== null && record.lifecycle !== 'active') {
      return {
        kind: 'stop',
        result: blocked('object_missing'),
        shared: failed('transfer', { kind: 'missing' }),
      };
    }
    if (
      asset.localOriginalUri !== null
      && asset.missingOriginalSince === null
      && asset.residency === 'local-original'
    ) {
      return {
        kind: 'stop',
        result: { status: 'noop', reason: 'already-satisfied' },
        shared: { kind: 'promoted', uri: asset.localOriginalUri },
      };
    }
    // Invariant 9: only an *active* committed original may be downloaded.
    if (
      record === null
      || record.protection !== 'protected'
      || record.originalGenerationId === null
    ) {
      return {
        kind: 'stop',
        result: blocked('object_missing'),
        shared: failed('transfer', { kind: 'missing' }),
      };
    }
    return { kind: 'clear', asset, generationId: record.originalGenerationId };
  };

  const transferOriginal = async (
    masterKey: Uint8Array,
    accountScope: string,
    assetId: string,
    plaintextSha256: string,
    asset: DownloadAsset,
    generationId: string,
  ): Promise<LibraryRoleFetch> => {
    let cipherPath: string | undefined;
    let plainPath: string | undefined;
    let promotedUri!: string;
    try {
      cipherPath = files.reserveStreamPath();
      plainPath = files.reserveStreamPath();
      const downloaded = await cloud.getObjectToFile(generationId, cipherPath);
      if (downloaded === null) return failed('transfer', { kind: 'missing' });

      let opened: Awaited<ReturnType<LibraryFileDecryptor['openToFile']>>;
      try {
        opened = await decryptor.openToFile({
          masterKey,
          assetId,
          scope: 'original',
          envelopeUri: cipherPath,
          plaintextUri: plainPath,
        });
      } catch (error) {
        if (error instanceof LibraryCloudError) {
          return failed('transfer', { kind: 'cloud', category: error.category });
        }
        if (error instanceof LibraryLocalStorageError) {
          return failed('transfer', { kind: 'local-storage' });
        }
        return failed('transfer', { kind: 'integrity', role: 'original' });
      } finally {
        await discardStreamPath(cipherPath);
      }

      if (opened.plaintextSha256 !== plaintextSha256) {
        await discardStreamPath(plainPath);
        return failed('transfer', { kind: 'integrity', role: 'original' });
      }

      try {
        const temp = await files.adoptStreamFile(plainPath);
        const promoted = await files.promoteToOriginal(
          temp,
          plaintextSha256,
          asset.canonicalExtension,
        );
        promotedUri = promoted.uri;
      } catch {
        return failed('consume', { kind: 'local-storage' });
      }
    } catch (error) {
      return failed('transfer', transferFaultFor(error));
    } finally {
      if (cipherPath !== undefined) await discardStreamPath(cipherPath);
      if (plainPath !== undefined) await discardStreamPath(plainPath);
    }
    await protection.setResidency(plaintextSha256, 'local-original', promotedUri);
    await protection.markVerified(accountScope, assetId, plaintextSha256, clock());
    return { kind: 'promoted', uri: promotedUri };
  };

  const copyCachedOriginal = async (
    accountScope: string,
    assetId: string,
    plaintextSha256: string,
    sourceUri: string,
  ): Promise<LibraryActionResult | 'again'> => {
    const decision = await assessDownload(accountScope, assetId, plaintextSha256);
    if (decision.kind === 'stop') return decision.result;
    let destination: string | undefined;
    try {
      try {
        destination = files.reserveStreamPath();
      } catch {
        return blocked('local_space');
      }
      let copied: Awaited<ReturnType<LibraryFileDecryptor['copyToFile']>>;
      try {
        copied = await decryptor.copyToFile({
          sourceUri,
          destinationUri: destination,
        });
      } catch (error) {
        if (error instanceof LibraryCopySourceMissingError) return 'again';
        return blocked('local_space');
      }
      if (copied.sha256 !== plaintextSha256) return blocked('integrity');
      let promotedUri: string;
      try {
        const temp = await files.adoptStreamFile(destination);
        const promoted = await files.promoteToOriginal(
          temp,
          plaintextSha256,
          decision.asset.canonicalExtension,
        );
        promotedUri = promoted.uri;
      } catch {
        return blocked('local_space');
      }
      await protection.setResidency(plaintextSha256, 'local-original', promotedUri);
      await protection.markVerified(accountScope, assetId, plaintextSha256, clock());
      return { status: 'applied' };
    } finally {
      if (destination !== undefined) await discardStreamPath(destination);
    }
  };

  const download = async (plaintextSha256: string): Promise<LibraryActionResult> => {
      const context = await session.current();
      if (context === null) {
        return blocked('auth_attention');
      }
      const assetId = deriveLibraryAssetId(context.masterKey, plaintextSha256);
      let stopped: LibraryActionResult | undefined;
      const claim = runWithOwnership(
        transferCoalescer,
        `${assetId}:original`,
        async () => {
          const decision = await assessDownload(
            context.accountScope,
            assetId,
            plaintextSha256,
          );
          if (decision.kind === 'stop') {
            stopped = decision.result;
            return decision.shared;
          }
          return transferOriginal(
            context.masterKey,
            context.accountScope,
            assetId,
            plaintextSha256,
            decision.asset,
            decision.generationId,
          );
        },
      );

      if (!claim.owner) {
        const decision = await assessDownload(
          context.accountScope,
          assetId,
          plaintextSha256,
        );
        if (decision.kind === 'stop') return decision.result;
        const outcome = await claim.promise;
        if (outcome.kind === 'failed' && outcome.stage === 'consume') {
          return download(plaintextSha256);
        }
        if (outcome.kind === 'failed') {
          return blocked(downloadCategoryFor(outcome.fault));
        }
        if (outcome.kind === 'promoted') return { status: 'applied' };
        const copied = await copyCachedOriginal(
          context.accountScope,
          assetId,
          plaintextSha256,
          outcome.entry.uri,
        );
        if (copied === 'again') return download(plaintextSha256);
        return copied;
      }

      const outcome = await claim.promise;
      if (stopped !== undefined) return stopped;
      if (outcome.kind === 'promoted') return { status: 'applied' };
      if (outcome.kind === 'failed') return blocked(downloadCategoryFor(outcome.fault));
      return blocked('integrity');
    };

  return {
    download,

    async freeDeviceSpace(plaintextSha256) {
      const context = await session.current();
      if (context === null) {
        return { status: 'blocked', category: 'auth_attention' };
      }
      const asset = await repository.findLocalAsset(plaintextSha256);
      if (asset === null || asset.localOriginalUri === null) {
        return { status: 'noop', reason: 'not-applicable' };
      }
      const assetId = deriveLibraryAssetId(context.masterKey, plaintextSha256);
      const record = await protection.findByAssetId(context.accountScope, assetId);
      const deviceState = await protection.readDeviceState(plaintextSha256);
      // Invariant 4: eviction requires a committed *and* verified original.
      if (
        record === null
        || record.protection !== 'protected'
        || record.originalGenerationId === null
        || record.verifiedAt === null
        || record.lifecycle !== 'active'
        || deviceState?.deviceTrashedAt != null
      ) {
        return { status: 'blocked', category: 'object_missing' };
      }
      // Invariant 3: an unknown destructive account outcome is never assumed safe.
      if (await hasUnresolvedDestructiveOutcome(context.accountScope, assetId)) {
        return { status: 'blocked', category: 'stale_client' };
      }
      // Invariant 5: device-local only. No mutation, no outbox row, no cloud call.
      await files.deleteOriginal(asset.localOriginalUri);
      await protection.setResidency(plaintextSha256, 'cloud-only', null);
      return { status: 'applied' };
    },

    async availableActions(plaintextSha256) {
      const context = await session.current();
      if (context === null) return [];
      const asset = await repository.findLocalAsset(plaintextSha256);
      if (asset === null) return [];
      const assetId = deriveLibraryAssetId(context.masterKey, plaintextSha256);
      const record = await protection.findByAssetId(context.accountScope, assetId);
      const state = await protection.readDeviceState(plaintextSha256);
      // Normal-library actions require an active account projection. Trash and
      // purged follow separate trash semantics (Task 9+), not these affordances.
      if (
        (record !== null && record.lifecycle !== 'active')
        || state?.deviceTrashedAt != null
      ) {
        return [];
      }
      const hasLocal = asset.localOriginalUri !== null
        && asset.missingOriginalSince === null
        && asset.residency === 'local-original';
      const protectedAndVerified = record?.protection === 'protected'
        && record.originalGenerationId !== null;
      const available: LibraryActionKind[] = [];
      if (!protectedAndVerified && hasLocal && asset.protectEligible) {
        available.push('protect');
      }
      if (protectedAndVerified && !hasLocal) available.push('download');
      if (protectedAndVerified) available.push('stop-protection');
      available.push('remove');
      return available;
    },
  };
}
