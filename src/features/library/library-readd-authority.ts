import type { SqlDatabasePort } from '@/db/sql-port';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import { createByosCredentialStore } from '@/features/byos/byos-credentials';
import { createByosSessionCache } from '@/features/byos/byos-session-cache';
import { S3TransportError } from '@/features/byos/s3-transport-types';
import {
  createLibraryAccountMetadataSummaryRepository,
  type LibraryAccountMetadataSummaryRow,
} from '@/features/library/library-account-metadata-summary';
import type {
  LibraryEncryptedMetadata,
  LibrarySessionPort,
} from '@/features/library/library-actions-types';
import { readAssetStateKey } from '@/features/library/library-asset-state-codec';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import {
  deriveLibraryAssetId,
  LIBRARY_ASSET_ID_PATTERN,
} from '@/features/library/library-identity';
import type {
  LibraryReaddAuthorityLookup,
  LibraryReaddAuthorityResult,
  LibraryReaddAuthorityUnavailableReason,
} from '@/features/library/library-ingest';
import { LAST_ACCOUNT_SCOPE_SQL } from '@/features/library/library-local-view';
import type { LibraryObjectCipher } from '@/features/library/library-object-crypto';
import {
  LibraryReconciliationCorruptionError,
  type LibraryReconciliationPort,
} from '@/features/library/library-reconciliation-port';
import { restoreCandidateFrom } from '@/features/library/library-restore-image';
import { toLibraryCloudError } from '@/features/library/library-s3-error-bridge';
import { resolveEnvelopeImportClassification } from '@/features/library/library-source-metadata';
import type { LibrarySyncRestoreImage } from '@/features/library/library-sync-apply';

const FORMATS: readonly string[] = ['jpeg', 'png', 'webp', 'gif'];
const EXTENSIONS: readonly string[] = ['jpg', 'png', 'webp', 'gif'];
const ORIGINS: readonly string[] = ['provider', 'import'];

export type LibraryReaddAuthorityDependencies = Readonly<{
  database: SqlDatabasePort;
  session?: LibrarySessionPort | null;
  reconciliation?: LibraryReconciliationPort | null;
  cipher?: LibraryObjectCipher | null;
  restoreImage?: LibrarySyncRestoreImage;
  byosStatus?: ByosStatus;
  unavailableReason?: LibraryReaddAuthorityUnavailableReason;
  clock?: () => number;
}>;

export function readdUnavailableReasonFor(
  status: ByosStatus | undefined,
): LibraryReaddAuthorityUnavailableReason {
  if (status === undefined || status.status !== 'locked') {
    return 'network';
  }
  if (status.reason === 'password_required') {
    return 'password_locked';
  }
  if (status.reason === 'meta_corrupt') {
    return 'integrity';
  }
  if (status.detail === 'reauth_required') {
    return 'reauth_required';
  }
  return 'network';
}

function classifyFetchError(
  error: unknown,
  fallback: LibraryReaddAuthorityUnavailableReason,
): LibraryReaddAuthorityUnavailableReason {
  if (error instanceof LibraryReconciliationCorruptionError) {
    return 'integrity';
  }
  const cloudError =
    error instanceof LibraryCloudError
      ? error
      : error instanceof S3TransportError
        ? toLibraryCloudError(error)
        : null;
  if (cloudError !== null) {
    if (cloudError.category === 'integrity') return 'integrity';
    if (cloudError.category === 'auth_attention') {
      return fallback === 'reauth_required' ? 'reauth_required' : 'network';
    }
    return 'network';
  }
  return fallback;
}

function isValidEnvelope(
  metadata: LibraryEncryptedMetadata,
  expectedAssetId: string,
  expectedDigest: string,
  masterKey: Uint8Array,
): boolean {
  const version = (metadata as { version?: unknown }).version;
  if (version !== 1 && version !== 2 && version !== 3) return false;
  if (resolveEnvelopeImportClassification(metadata) === null) return false;
  if (
    metadata.plaintextSha256 !== expectedDigest
    || !LIBRARY_ASSET_ID_PATTERN.test(metadata.plaintextSha256)
    || !FORMATS.includes(metadata.format)
    || !EXTENSIONS.includes(metadata.canonicalExtension)
    || !ORIGINS.includes(metadata.origin)
    || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize <= 0
    || !Number.isSafeInteger(metadata.width) || metadata.width <= 0
    || !Number.isSafeInteger(metadata.height) || metadata.height <= 0
    || !Number.isSafeInteger(metadata.collectedAt)
  ) {
    return false;
  }
  try {
    return deriveLibraryAssetId(masterKey, expectedDigest) === expectedAssetId;
  } catch {
    return false;
  }
}

export function createLibraryReaddAuthorityLookup({
  database,
  session = null,
  reconciliation = null,
  cipher = null,
  restoreImage,
  byosStatus,
  unavailableReason,
  clock = Date.now,
}: LibraryReaddAuthorityDependencies): LibraryReaddAuthorityLookup {
  const summaryRepo = createLibraryAccountMetadataSummaryRepository({
    database,
    clock,
  });
  const fallbackReason =
    unavailableReason ?? readdUnavailableReasonFor(byosStatus);

  function fromSummary(
    summary: LibraryAccountMetadataSummaryRow,
  ): LibraryReaddAuthorityResult {
    const fakeMetadata: LibraryEncryptedMetadata = {
      version: 3,
      plaintextSha256: summary.plaintextSha256,
      format: 'jpeg',
      canonicalExtension: 'jpg',
      byteSize: 1,
      width: 1,
      height: 1,
      origin: summary.origin,
      sourceImageId: null,
      collectedAt: summary.collectedAt,
      importClassification: summary.importClassification,
      tags: summary.source?.tags ?? [],
      ...(summary.source !== null ? { source: summary.source } : {}),
    };
    const restore =
      summary.origin === 'provider'
        ? restoreCandidateFrom(fakeMetadata)
        : null;
    return {
      status: 'authoritative',
      origin: summary.origin,
      collectedAt: summary.collectedAt,
      importClassification: summary.importClassification,
      ...(restore !== null && restoreImage !== undefined
        ? {
          restoreProviderImage: () =>
            restoreImage(restore.candidate, restore.savedAt),
        }
        : {}),
    };
  }

  return async (plaintextSha256: string): Promise<LibraryReaddAuthorityResult> => {
    const context = session !== null ? await session.current() : null;
    let scope: string | null = context?.accountScope ?? null;
    if (scope === null) {
      const last = await database.getFirst<{ account_scope: string }>(
        LAST_ACCOUNT_SCOPE_SQL,
      );
      scope = last?.account_scope ?? null;
    }
    if (scope === null) {
      const anyScope = await database.getFirst<{ account_scope: string }>(
        `SELECT account_scope FROM library_account_assets
          WHERE plaintext_sha256 = ?
          ORDER BY updated_at DESC, account_scope ASC
          LIMIT 1`,
        [plaintextSha256],
      );
      scope = anyScope?.account_scope ?? null;
    }

    if (scope === null) {
      if (byosStatus?.status === 'locked') {
        // With no local mapping for this digest and a locked vault, only an
        // existing cloud identity for this digest requires authority. Since
        // `inspectDigestMembership` found `hasActiveCloudIdentity = false` when
        // no account row exists, a brand-new local import while locked/offline
        // succeeds locally (§5: "Cloud offline/locked / encryption off: Fresh
        // local imports still succeed").
        return { status: 'no_cloud_identity' };
      }
      return { status: 'no_cloud_identity' };
    }

    // Check whether the local projection already knows the asset is trashed or
    // purged in the cloud: cloud trash/purged is not an active cloud image (§4.4).
    const localLifecycle = await database.getFirst<{ lifecycle: string }>(
      `SELECT lifecycle FROM library_asset_protection
        WHERE account_scope = ? AND plaintext_sha256 = ?
        LIMIT 1`,
      [scope, plaintextSha256],
    );
    if (
      localLifecycle !== null
      && localLifecycle.lifecycle !== 'active'
    ) {
      return { status: 'no_cloud_identity' };
    }

    // Check if an active cloud identity is enrolled or summarized for this digest.
    const existingSummary = await summaryRepo.findByDigest(
      scope,
      plaintextSha256,
    );
    const enrolled = await database.getFirst<{ asset_id: string }>(
      `SELECT asset_id FROM library_account_assets
        WHERE account_scope = ? AND plaintext_sha256 = ?
        LIMIT 1`,
      [scope, plaintextSha256],
    );

    if (existingSummary !== null && (context === null || reconciliation === null)) {
      return fromSummary(existingSummary);
    }

    if (context === null || reconciliation === null || cipher === null) {
      if (existingSummary !== null) {
        return fromSummary(existingSummary);
      }
      if (enrolled !== null) {
        if (unavailableReason === undefined && byosStatus === undefined) {
          try {
            const binding = await createByosCredentialStore().loadBinding();
            if (binding !== null) {
              if (binding.kind === 'onedrive' || binding.kind === 'gdrive') {
                return { status: 'unavailable', reason: 'reauth_required' };
              }
              const cachedSession = await createByosSessionCache().load();
              if (cachedSession === null) {
                return { status: 'unavailable', reason: 'password_locked' };
              }
            }
          } catch {
            // Fall through to fallbackReason.
          }
        }
        return { status: 'unavailable', reason: fallbackReason };
      }
      return { status: 'no_cloud_identity' };
    }

    // We have a live session + reconciliation + cipher. If we already have a
    // validated summary and the asset is enrolled locally, return it directly
    // unless no summary exists yet.
    if (existingSummary !== null) {
      return fromSummary(existingSummary);
    }

    const assetId =
      enrolled?.asset_id
      ?? deriveLibraryAssetId(context.masterKey, plaintextSha256);

    let remote;
    try {
      remote = await reconciliation.getAssetState(assetId);
    } catch (error) {
      if (enrolled !== null) {
        return {
          status: 'unavailable',
          reason: classifyFetchError(error, fallbackReason),
        };
      }
      // For an un-enrolled digest, a failed remote read while the user was just
      // importing locally does not block a fresh local import unless the digest
      // was previously enrolled on this phone.
      return { status: 'no_cloud_identity' };
    }

    if (remote === null || remote.lifecycle !== 'active') {
      return { status: 'no_cloud_identity' };
    }

    if (remote.meta === undefined || remote.meta.length === 0) {
      return { status: 'unavailable', reason: 'integrity' };
    }

    let opened: LibraryEncryptedMetadata;
    try {
      opened = await cipher.openMetadata({
        masterKey: context.masterKey,
        assetId,
        sealed: remote.meta,
      });
    } catch {
      return { status: 'unavailable', reason: 'integrity' };
    }

    if (!isValidEnvelope(opened, assetId, plaintextSha256, context.masterKey)) {
      return { status: 'unavailable', reason: 'integrity' };
    }

    const importClassification = resolveEnvelopeImportClassification(opened)!;
    const stateKey = readAssetStateKey(remote) ?? `s3:${remote.revision}`;
    await summaryRepo.upsert({
      accountScope: scope,
      assetId,
      plaintextSha256,
      origin: opened.origin,
      collectedAt: opened.collectedAt,
      importClassification,
      source: opened.origin === 'provider' ? (opened.source ?? null) : null,
      stateKey,
      sealedMeta: remote.meta,
    });

    const summary = await summaryRepo.findByAssetId(scope, assetId);
    if (summary !== null) {
      return fromSummary(summary);
    }
    return {
      status: 'authoritative',
      origin: opened.origin,
      collectedAt: opened.collectedAt,
      importClassification,
    };
  };
}
