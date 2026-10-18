import type { LibraryDecodeGate } from '@/features/library/library-decode-gate';
import {
  createNativeDigest,
  createNativeFileDigest,
  type DigestPort,
  type FileDigestPort,
} from '@/features/library/library-digest';
import type {
  LibraryFileStore,
  LibraryTempFile,
} from '@/features/library/library-file-store';
import {
  detectLibraryImageFormat,
  LIBRARY_FORMAT_SNIFF_BYTES,
} from '@/features/library/library-format';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import type { LibraryRepository } from '@/features/library/library-repository';
import type {
  DeviceLibraryAsset,
  LibraryAccountEnrollment,
  LibraryAssetOrigin,
  LibraryCollectMetadata,
  LibraryEnrollmentSummary,
  LibraryImportClassification,
  LibraryIngestErrorCode,
  LibraryIngestOutcome,
} from '@/features/library/library-types';
import { LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES } from '@/features/library/library-limits';
import { LibraryIngestError } from '@/features/library/library-types';

/**
 * The only seam between Layer A and Layer B. A Store build, a signed-out Direct
 * build, and a Direct build whose device is not registered all supply `null`,
 * and local ingest still succeeds.
 */
export type LibraryAccountPort = Readonly<{
  /** The 32-byte Vault master key, or null when there is no usable account. */
  vaultMasterKey(): Promise<Uint8Array | null>;
  /** The registered device id from the SP5 session, or null when unavailable. */
  deviceId(): Promise<string | null>;
  /**
   * The account partition key from the resolved session (decision #20's single
   * source). ingest MUST use this rather than re-deriving scope from the master
   * key: under aes-gcm those two formulas differ, which silently splits every
   * collect intent from the scope protect and sync read. Null only when there
   * is no session.
   */
  accountScope(): Promise<string | null>;
}>;

export const LOCAL_ONLY_LIBRARY_ACCOUNT_PORT: LibraryAccountPort = {
  async vaultMasterKey() {
    return null;
  },
  async deviceId() {
    return null;
  },
  async accountScope() {
    return null;
  },
};

export type LibraryIngestRequest = Readonly<{
  origin: LibraryAssetOrigin;
  sourceImageId?: number | null;
  importClassification?: LibraryImportClassification;
}>;

export type LibraryReaddAuthorityUnavailableReason =
  | 'network'
  | 'password_locked'
  | 'reauth_required'
  | 'integrity';

export type LibraryReaddAuthorityResult =
  | Readonly<{ status: 'no_cloud_identity' }>
  | Readonly<{
      status: 'authoritative';
      origin: LibraryAssetOrigin;
      collectedAt: number;
      importClassification: LibraryImportClassification;
      /**
       * Optional callback that restores or locates the local `images` row for a
       * deleted cloud-backed provider item (N6-A3).
       */
      restoreProviderImage?: () => Promise<number | null>;
    }>
  | Readonly<{
      status: 'unavailable';
      reason: LibraryReaddAuthorityUnavailableReason;
    }>;

export type LibraryReaddAuthorityLookup = (
  plaintextSha256: string,
) => Promise<LibraryReaddAuthorityResult>;

export type LibraryReconcileSummary = Readonly<{
  deletedTemporary: readonly string[];
  deletedOrphanOriginals: readonly string[];
  missingOriginals: readonly string[];
  /** Plaintext digests of local rows whose durable file disappeared. */
  flaggedDigests: readonly string[];
  failed: readonly Readonly<{ uri: string; code: string }>[];
}>;

export type LibraryIngestService = Readonly<{
  ingestBytes(
    input: LibraryIngestRequest & {
      bytes: Uint8Array;
      strictImportDuplicate?: boolean;
    },
  ): Promise<LibraryIngestOutcome>;
  ingestUri(
    input: LibraryIngestRequest & {
      sourceUri: string;
      strictImportDuplicate?: boolean;
    },
  ): Promise<LibraryIngestOutcome>;
  ingestTempFile(
    input: LibraryIngestRequest & {
      temp: LibraryTempFile;
      strictImportDuplicate?: boolean;
    },
  ): Promise<LibraryIngestOutcome>;
  /** Layer B for one already-local asset. Safe to call when signed out. */
  enrichLocalAssetForAccount(
    plaintextSha256: string,
  ): Promise<LibraryAccountEnrollment>;
  /** Layer B for every local asset this account has not enrolled yet. */
  enrichLocalAssetsForAccount(): Promise<LibraryEnrollmentSummary>;
  reconcileStorage(): Promise<LibraryReconcileSummary>;
  /**
   * N6-A2 (spec §4.4, §4.8): runs `work` under the per-digest admission/commit
   * serialization gate so concurrent ingests, re-adds, and purges for the same
   * `plaintextSha256` serialize their DB and physical file operations.
   */
  withDigestGate<T>(
    plaintextSha256: string,
    work: () => Promise<T>,
  ): Promise<T>;
}>;

export type LibraryIngestDependencies = Readonly<{
  files: LibraryFileStore;
  repository: LibraryRepository;
  decodeGate: LibraryDecodeGate;
  account: LibraryAccountPort;
  newMutationId: () => string;
  clock?: () => number;
  maxProtectablePlaintextBytes?: number;
  /**
   * SHA-256 of the collected plaintext. Default: `expo-crypto`'s native
   * digest, because this runs for every image the user collects and the
   * pure-JS hash blocked the JS thread for seconds on multi-MB files (K6-1f).
   */
  digest?: DigestPort;
  /**
   * Streamed file-to-file SHA-256 + byte length port (64 KiB native buffer in
   * `WaifuSyncService.copyFileToFileWithSha256`), used when available so
   * multi-MB / 64 MiB exact-cap imports never allocate a full-file Java/JS
   * heap buffer during ingest.
   */
  fileDigest?: FileDigestPort | null;
  /**
   * Fire-and-forget notification after a **newly committed** collection. SP7
   * uses it to apply the device save policy to that new asset. It never fires
   * for a duplicate of an asset this device already holds, because a policy
   * change must not migrate existing assets. It must never affect the local
   * result.
   */
  onIngestOutcome?: (outcome: LibraryIngestOutcome) => void;
  /**
   * N6-A2 / N6-A3 (spec §4.4, §7.2): optional authority lookup consulted when
   * an explicit import re-adds a digest that was deleted on this phone while an
   * active cloud identity exists. When omitted, an active cloud identity with
   * no validated summary fails with `authority_network` rather than inventing a
   * new classification/time.
   */
  lookupReaddAuthority?: LibraryReaddAuthorityLookup;
  /**
   * N6-A2 (spec §4.4): optional test hook invoked while holding the same-digest
   * admission gate right after the duplicate/membership inspection and before
   * promotion/commit, so tests can Deterministically exercise the ingest-window
   * race against a concurrent provider or import.
   */
  onBeforeDigestCommit?: (
    plaintextSha256: string,
    origin: LibraryAssetOrigin,
  ) => Promise<void> | void;
}>;

function ingestError(
  error: unknown,
  fallbackCode: 'storage_failed' | 'database_failed',
  message: string,
): LibraryIngestError {
  if (error instanceof LibraryIngestError) return error;
  return new LibraryIngestError(fallbackCode, message, { cause: error });
}

export function createLibraryIngestService({
  files,
  repository,
  decodeGate,
  account,
  newMutationId,
  clock = Date.now,
  maxProtectablePlaintextBytes = LIBRARY_MAX_PROTECTABLE_PLAINTEXT_BYTES,
  onIngestOutcome = () => undefined,
  digest: customDigest,
  fileDigest = createNativeFileDigest(),
  lookupReaddAuthority,
  onBeforeDigestCommit,
}: LibraryIngestDependencies): LibraryIngestService {
  const digest = customDigest ?? createNativeDigest();
  const useStreamedFileDigest =
    customDigest === undefined
    && fileDigest !== null
    && typeof files.readTempPrefix === 'function'
    && typeof files.reserveStreamPath === 'function';
  const digestLocks = new Map<string, Promise<void>>();

  const withDigestGate = async <T>(
    plaintextSha256: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = digestLocks.get(plaintextSha256) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    digestLocks.set(plaintextSha256, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (digestLocks.get(plaintextSha256) === tail) {
        digestLocks.delete(plaintextSha256);
      }
    }
  };
  /**
   * Layer B for one local asset. It never throws: a missing account is a skip
   * and a storage/database problem is a reported failure, because the local
   * asset is already durable and must stay usable either way.
   */
  const enrichLocalAssetForAccount = async (
    plaintextSha256: string,
  ): Promise<LibraryAccountEnrollment> => {
    let masterKey: Uint8Array | null;
    let deviceId: string | null;
    try {
      masterKey = await account.vaultMasterKey();
      if (masterKey === null) {
        return { status: 'skipped', reason: 'no_account' };
      }
      deviceId = await account.deviceId();
      if (deviceId === null || deviceId.length === 0) {
        // The design mutation identity requires a real registered device id.
        return { status: 'skipped', reason: 'no_device' };
      }
    } catch {
      return { status: 'skipped', reason: 'no_account' };
    }

    try {
      const accountScope = await account.accountScope();
      if (accountScope === null) {
        return { status: 'skipped', reason: 'no_account' };
      }
      const local = await repository.findLocalAsset(plaintextSha256);
      if (local === null) {
        // Nothing local to enrol from. An account row without one is not
        // something this path can repair or describe.
        const enrolled = await repository.findAccountAsset(
          accountScope,
          plaintextSha256,
        );
        return enrolled === null
          ? { status: 'failed', code: 'database_failed' }
          : { status: 'already-enrolled', accountAsset: enrolled };
      }

      const assetId = deriveLibraryAssetId(masterKey, plaintextSha256);
      const at = clock();
      const metadata: LibraryCollectMetadata = {
        assetId,
        plaintextSha256,
        format: local.format,
        byteSize: local.byteSize,
        width: local.width,
        height: local.height,
        origin: local.origin,
        sourceImageId: local.sourceImageId,
        collectedAt: local.createdAt,
        importClassification: local.importClassification ?? 'unknown',
      };
      const mutationId = newMutationId();
      const committed = await repository.commitCollect({
        accountScope,
        assetId,
        plaintextSha256,
        deviceId,
        mutationId,
        metadata,
        at,
      });
      if (committed.status === 'duplicate') {
        return {
          status: 'already-enrolled',
          accountAsset: committed.accountAsset,
        };
      }
      return {
        status: 'enrolled',
        accountAsset: committed.accountAsset,
        mutationId,
      };
    } catch (error) {
      const code: LibraryIngestErrorCode = error instanceof LibraryIngestError
        ? error.code
        : 'database_failed';
      return { status: 'failed', code };
    }
  };

  const ingestTempFile = async ({
    temp,
    origin,
    sourceImageId = null,
    importClassification = 'unknown',
    strictImportDuplicate = false,
  }: LibraryIngestRequest & {
    temp: LibraryTempFile;
    /**
     * N6-A2 (spec §4.4, §4.9): true when invoked from the user's import batch
     * (`library-import.ts`), enforcing the 64 MiB - 96 byte cap and strict
     * no-op duplicate behavior (never adopting/healing an active duplicate's
     * missing original during an import batch).
     */
    strictImportDuplicate?: boolean;
  }): Promise<LibraryIngestOutcome> => {
    try {
      // N6-A2 (spec §4.9, revised D11): reject user import originals above
      // 67,108,768 bytes before whole-file read, decode, promotion, or
      // enrollment.
      if (
        origin === 'import'
        && strictImportDuplicate
        && temp.byteSize > maxProtectablePlaintextBytes
      ) {
        throw new LibraryIngestError(
          'file_too_large',
          'This image exceeds the maximum supported size.',
        );
      }
      if (temp.byteSize === 0) {
        throw new LibraryIngestError(
          'empty_file',
          'This image file is empty or incomplete.',
        );
      }

      // Step 2 & 3 & 5: completeness, byte-true format, and plaintext digest.
      // When native streamed file hashing (`fileDigest`) is available, read only
      // the 16-byte format header and stream the file in 64 KiB chunks off the
      // Java/JS heap so 64 MiB exact-cap imports never trigger a Dalvik OOM.
      let byteLength: number;
      let detected: ReturnType<typeof detectLibraryImageFormat>;
      let plaintextSha256 = '';
      let bytesForFallback: Uint8Array | null = null;

      if (useStreamedFileDigest && fileDigest !== null) {
        const prefix = await files.readTempPrefix!(temp, LIBRARY_FORMAT_SNIFF_BYTES);
        if (prefix.byteLength === 0) {
          throw new LibraryIngestError(
            'empty_file',
            'This image file is empty or incomplete.',
          );
        }
        detected = detectLibraryImageFormat(prefix);
        if (detected === null) {
          throw new LibraryIngestError(
            'unsupported_format',
            'Only JPEG, PNG, WebP, and GIF images can be added to the library.',
          );
        }
        const streamed = await fileDigest(temp.uri, files.reserveStreamPath());
        byteLength = streamed.byteSize;
        plaintextSha256 = streamed.plaintextSha256;
        if (byteLength === 0) {
          throw new LibraryIngestError(
            'empty_file',
            'This image file is empty or incomplete.',
          );
        }
        if (byteLength !== temp.byteSize) {
          throw new LibraryIngestError(
            'unreadable_source',
            'This image was not copied completely and was not saved.',
          );
        }
        if (
          origin === 'import'
          && strictImportDuplicate
          && byteLength > maxProtectablePlaintextBytes
        ) {
          throw new LibraryIngestError(
            'file_too_large',
            'This image exceeds the maximum supported size.',
          );
        }
      } else {
        bytesForFallback = await files.readTemp(temp);
        byteLength = bytesForFallback.byteLength;
        if (byteLength === 0) {
          throw new LibraryIngestError(
            'empty_file',
            'This image file is empty or incomplete.',
          );
        }
        if (byteLength !== temp.byteSize) {
          throw new LibraryIngestError(
            'unreadable_source',
            'This image was not copied completely and was not saved.',
          );
        }
        if (
          origin === 'import'
          && strictImportDuplicate
          && byteLength > maxProtectablePlaintextBytes
        ) {
          throw new LibraryIngestError(
            'file_too_large',
            'This image exceeds the maximum supported size.',
          );
        }
        detected = detectLibraryImageFormat(bytesForFallback);
        if (detected === null) {
          throw new LibraryIngestError(
            'unsupported_format',
            'Only JPEG, PNG, WebP, and GIF images can be added to the library.',
          );
        }
      }

      // Step 4: production-renderer decode.
      const decoded = await decodeGate.validate({
        uri: temp.uri,
        format: detected.format,
        byteSize: byteLength,
      });

      if (bytesForFallback !== null) {
        plaintextSha256 = await digest(bytesForFallback);
      }

      return await withDigestGate(plaintextSha256, async () => {
        if (origin === 'import' && strictImportDuplicate) {
          let currentScope: string | null = null;
          try {
            currentScope = await account.accountScope();
          } catch {
            currentScope = null;
          }
          const membership = await repository.inspectDigestMembership(
            plaintextSha256,
            currentScope,
          );
          await onBeforeDigestCommit?.(plaintextSha256, origin);

          // Spec §4.4: active import or active committed-map provider save is
          // `existing` — strict no-op on origin, time, classification,
          // residency, bytes, enrollment, and protection.
          if (
            membership.hasActiveImportMember
            || membership.hasActiveProviderMember
          ) {
            const existingAsset =
              membership.asset
              ?? (await repository.findLocalAsset(plaintextSha256));
            if (existingAsset !== null) {
              const existingAccount = currentScope === null
                ? null
                : await repository.findAccountAsset(
                  currentScope,
                  plaintextSha256,
                );
              return {
                status: 'duplicate',
                asset: existingAsset,
                enrollment: existingAccount !== null
                  ? { status: 'already-enrolled', accountAsset: existingAccount }
                  : { status: 'skipped', reason: 'no_account' },
              };
            }
          }

          // Locally deleted (or absent) on this phone: check whether an active
          // cloud identity exists that must supply the authoritative origin,
          // classification, and original time (§4.4).
          let effectiveOrigin: LibraryAssetOrigin = 'import';
          let effectiveSourceImageId: number | null = null;
          let effectiveClassification: LibraryImportClassification =
            importClassification;
          let effectiveCreatedAt: number | null = null;
          let retainedLibraryClassification = false;

          if (membership.hasActiveCloudIdentity || lookupReaddAuthority !== undefined) {
            const authority = lookupReaddAuthority !== undefined
              ? await lookupReaddAuthority(plaintextSha256)
              : ({ status: 'unavailable', reason: 'network' } as const);
            if (authority.status === 'unavailable') {
              const codeMap: Record<
                LibraryReaddAuthorityUnavailableReason,
                LibraryIngestErrorCode
              > = {
                network: 'authority_network',
                password_locked: 'authority_password_locked',
                reauth_required: 'authority_reauth_required',
                integrity: 'authority_integrity',
              };
              throw new LibraryIngestError(
                codeMap[authority.reason],
                'Cloud library authority is unavailable for this re-added image.',
              );
            } else if (authority.status === 'authoritative') {
              effectiveOrigin = authority.origin;
              effectiveCreatedAt = authority.collectedAt;
              if (authority.origin === 'provider') {
                effectiveClassification = 'unknown';
                if (authority.restoreProviderImage !== undefined) {
                  effectiveSourceImageId = await authority.restoreProviderImage();
                }
              } else {
                effectiveClassification = authority.importClassification;
                retainedLibraryClassification =
                  authority.importClassification !== importClassification;
              }
            }
          }

          const promoted = await files.promoteToOriginal(
            temp,
            plaintextSha256,
            detected.canonicalExtension,
          );
          const discardPromoted = async (): Promise<void> => {
            if (promoted.reused) return;
            try {
              if (await repository.isOriginalNamed(promoted.uri)) return;
              await files.deleteOriginal(promoted.uri);
            } catch {
              // reconcileStorage reclaims a file the rollback could not remove.
            }
          };

          const now = clock();
          const createdAt = effectiveCreatedAt ?? now;
          const asset: DeviceLibraryAsset = {
            plaintextSha256,
            format: detected.format,
            canonicalExtension: detected.canonicalExtension,
            byteSize: byteLength,
            width: decoded.width,
            height: decoded.height,
            origin: effectiveOrigin,
            sourceImageId: effectiveSourceImageId,
            localOriginalUri: promoted.uri,
            residency: 'local-original',
            protectEligible: byteLength <= maxProtectablePlaintextBytes,
            missingOriginalSince: null,
            localThumbnailUri: membership.asset?.localThumbnailUri ?? null,
            importClassification: effectiveClassification,
            importDeletedAt: null,
            createdAt,
            updatedAt: now,
          };

          let committed;
          try {
            committed =
              typeof repository.commitOrReactivateImportAsset === 'function'
                && membership.asset !== null
                ? await repository.commitOrReactivateImportAsset({
                  asset,
                  overwriteExistingRow: true,
                })
                : await repository.commitLocalAsset({ asset });
          } catch (error) {
            await discardPromoted();
            throw ingestError(
              error,
              'database_failed',
              'The library database could not be updated.',
            );
          }

          if (committed.status === 'duplicate') {
            const existingAccount = currentScope === null
              ? null
              : await repository.findAccountAsset(currentScope, plaintextSha256);
            return {
              status: 'duplicate',
              asset: committed.asset,
              enrollment: existingAccount !== null
                ? { status: 'already-enrolled', accountAsset: existingAccount }
                : { status: 'skipped', reason: 'no_account' },
            };
          }

          const enrollment = await enrichLocalAssetForAccount(plaintextSha256);
          const outcome: LibraryIngestOutcome = {
            status: 'ingested',
            asset: committed.asset,
            enrollment,
            ...(retainedLibraryClassification
              ? { retainedLibraryClassification: true }
              : {}),
          };
          try {
            onIngestOutcome(outcome);
          } catch {
            // A policy observer failure never fails a successful local ingest.
          }
          return outcome;
        }

        // Standard Layer A / provider / direct ingest path
        const existing = await repository.findLocalAsset(plaintextSha256);
        await onBeforeDigestCommit?.(plaintextSha256, origin);
        if (existing?.residency === 'cached') {
          // Board #27 S1b (spec §5.6): a device-trashed asset is never adopted.
          // Nothing is promoted; the staged bytes go with the `finally` below.
          if (
            sourceImageId !== null
            && typeof repository.recordProviderImageDigest === 'function'
          ) {
            await repository.recordProviderImageDigest(
              sourceImageId,
              plaintextSha256,
              clock(),
            );
          }
          return {
            status: 'duplicate',
            asset: existing,
            enrollment: await enrichLocalAssetForAccount(plaintextSha256),
          };
        }
        if (
          existing !== null
          && existing.residency === 'local-original'
          && existing.localOriginalUri !== null
          && existing.missingOriginalSince === null
          && await files.hasOwnOriginal(existing.localOriginalUri)
        ) {
          // Already local. Still try Layer B: the user may have signed in since.
          if (
            sourceImageId !== null
            && typeof repository.recordProviderImageDigest === 'function'
          ) {
            await repository.recordProviderImageDigest(
              sourceImageId,
              plaintextSha256,
              clock(),
            );
          }
          return {
            status: 'duplicate',
            asset: existing,
            enrollment: await enrichLocalAssetForAccount(plaintextSha256),
          };
        }

        // Step 6 (Layer A): durable local original, named by the digest.
        const promoted = await files.promoteToOriginal(
          temp,
          plaintextSha256,
          detected.canonicalExtension,
        );
        const discardPromoted = async (): Promise<void> => {
          if (promoted.reused) return;
          try {
            if (await repository.isOriginalNamed(promoted.uri)) return;
            await files.deleteOriginal(promoted.uri);
          } catch {
            // reconcileStorage reclaims a file the rollback could not remove.
          }
        };

        if (existing !== null) {
          // Board #27 S1b (spec §5.6): the matched row has no usable original
          // (flagged, gone, cloud-only, or another Android user's path), so the
          // fresh bytes become it. Like any duplicate, a heal is no new
          // collection and never reaches `onIngestOutcome`.
          let adopted: DeviceLibraryAsset | null;
          try {
            adopted = await repository.adoptLocalOriginal({
              plaintextSha256,
              localOriginalUri: promoted.uri,
              at: clock(),
            });
            if (
              sourceImageId !== null
              && typeof repository.recordProviderImageDigest === 'function'
            ) {
              await repository.recordProviderImageDigest(
                sourceImageId,
                plaintextSha256,
                clock(),
              );
            }
          } catch (error) {
            await discardPromoted();
            throw ingestError(
              error,
              'database_failed',
              'The library database could not be updated.',
            );
          }
          if (adopted === null) {
            // Purged or device-trashed since the lookup: no row names the file.
            await discardPromoted();
          }
          return {
            status: 'duplicate',
            asset: adopted ?? existing,
            enrollment: await enrichLocalAssetForAccount(plaintextSha256),
          };
        }

        const now = clock();
        const asset: DeviceLibraryAsset = {
          plaintextSha256,
          format: detected.format,
          canonicalExtension: detected.canonicalExtension,
          byteSize: byteLength,
          width: decoded.width,
          height: decoded.height,
          origin,
          sourceImageId,
          localOriginalUri: promoted.uri,
          residency: 'local-original',
          protectEligible: byteLength <= maxProtectablePlaintextBytes,
          missingOriginalSince: null,
          localThumbnailUri: null,
          importClassification,
          importDeletedAt: null,
          createdAt: now,
          updatedAt: now,
        };

        // Step 7a (Layer A): the local row is the durable commit. It succeeds
        // with no account, so collecting works before any cloud work exists.
        let committed;
        try {
          committed = await repository.commitLocalAsset({ asset });
        } catch (error) {
          await discardPromoted();
          throw ingestError(
            error,
            'database_failed',
            'The library database could not be updated.',
          );
        }

        // Step 7b (Layer B): enrichment. A skip or failure here never undoes the
        // durable local asset above.
        const enrollment = await enrichLocalAssetForAccount(plaintextSha256);
        const outcome: LibraryIngestOutcome = {
          status: committed.status === 'duplicate' ? 'duplicate' : 'ingested',
          asset: committed.asset,
          enrollment,
        };
        if (outcome.status === 'ingested') {
          try {
            onIngestOutcome(outcome);
          } catch {
            // A policy observer failure never fails a successful local ingest.
          }
        }
        return outcome;
      });
    } finally {
      // SP6 removes the temporary plaintext once the durable local original
      // and the Layer A commit are done, and on every rejection path.
      await temp.discard();
    }
  };

  return {
    ingestTempFile,
    withDigestGate,

    async ingestBytes({
      bytes,
      origin,
      sourceImageId = null,
      importClassification = 'unknown',
      strictImportDuplicate = false,
    }) {
      if (bytes.byteLength === 0) {
        throw new LibraryIngestError(
          'empty_file',
          'This image file is empty or incomplete.',
        );
      }
      if (
        origin === 'import'
        && strictImportDuplicate
        && bytes.byteLength > maxProtectablePlaintextBytes
      ) {
        throw new LibraryIngestError(
          'file_too_large',
          'This image exceeds the maximum supported size.',
        );
      }
      const temp = await files.acquireFromBytes(bytes);
      return await ingestTempFile({
        temp,
        origin,
        sourceImageId,
        importClassification,
        strictImportDuplicate,
      });
    },

    async ingestUri({
      sourceUri,
      origin,
      sourceImageId = null,
      importClassification = 'unknown',
      strictImportDuplicate = false,
    }) {
      const temp = await files.acquireFromUri(
        sourceUri,
        origin === 'import' && strictImportDuplicate
          ? { maxBytes: maxProtectablePlaintextBytes }
          : undefined,
      );
      return await ingestTempFile({
        temp,
        origin,
        sourceImageId,
        importClassification,
        strictImportDuplicate,
      });
    },

    enrichLocalAssetForAccount,

    async enrichLocalAssetsForAccount() {
      const accountScope = await account.accountScope();
      if (accountScope === null) {
        // Nothing is wrong: this is a Store build or a signed-out session.
        const local = await repository.listLocalAssets();
        return {
          enrolled: 0,
          alreadyEnrolled: 0,
          skipped: local.length,
          failed: [],
        };
      }

      const pending = await repository.listLocalAssetsMissingEnrollment(
        accountScope,
      );

      let enrolled = 0;
      let alreadyEnrolled = 0;
      let skipped = 0;
      const failed: { code: LibraryIngestErrorCode }[] = [];
      for (const asset of pending) {
        const enrollment = await enrichLocalAssetForAccount(
          asset.plaintextSha256,
        );
        if (enrollment.status === 'enrolled') enrolled += 1;
        else if (enrollment.status === 'already-enrolled') alreadyEnrolled += 1;
        else if (enrollment.status === 'skipped') skipped += 1;
        else failed.push({ code: enrollment.code });
      }
      return { enrolled, alreadyEnrolled, skipped, failed };
    },

    async reconcileStorage() {
      const referenced = await repository.listReferencedOriginalUris();
      const result = await files.reconcileOrphans({
        referencedOriginalUris: referenced,
        now: Date.now(),
      });

      const flaggedDigests: string[] = [];
      if (result.missingOriginals.length > 0) {
        const missing = new Set(result.missingOriginals);
        const at = clock();
        for (const uri of missing) {
          const fileName = uri.slice(uri.lastIndexOf('/') + 1);
          // Durable originals are named `<plaintextSha256>.<ext>`.
          const plaintextSha256 = fileName.slice(0, fileName.lastIndexOf('.'));
          await repository.markOriginalMissing(plaintextSha256, at);
          flaggedDigests.push(plaintextSha256);
        }
      }

      return {
        deletedTemporary: result.deletedTemporary,
        deletedOrphanOriginals: result.deletedOrphanOriginals,
        missingOriginals: result.missingOriginals,
        flaggedDigests,
        failed: result.failed,
      };
    },
  };
}
