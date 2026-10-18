import type { SqlDatabasePort } from '@/db/sql-port';
import type {
  LibraryFailureCategory,
  LibraryLifecycle,
  LibraryProtection,
} from '@/features/library/library-actions-types';
import type {
  LibraryAssetOrigin,
  LibraryCanonicalExtension,
  LibraryImageFormat,
  LibraryImportClassification,
  LibraryResidency,
} from '@/features/library/library-types';

export const VIEW_TEST_ACCOUNT_SCOPE = 'scope-view';
export const VIEW_TEST_DEVICE_ID = 'device-view';

/** 64-hex digest helpers that stay CHECK-compatible. */
export function viewDigest(tag: string): string {
  const hex = Buffer.from(tag.padEnd(32, '0'), 'utf8').toString('hex');
  return hex.slice(0, 64).padEnd(64, '0');
}

export function viewAssetId(tag: string): string {
  const hex = Buffer.from(`asset:${tag}`.padEnd(32, '0'), 'utf8').toString('hex');
  return hex.slice(0, 64).padEnd(64, '0');
}

export type SeedDeviceLibraryAssetInput = Readonly<{
  plaintextSha256: string;
  format?: LibraryImageFormat;
  canonicalExtension?: LibraryCanonicalExtension;
  byteSize?: number;
  width?: number;
  height?: number;
  origin?: LibraryAssetOrigin;
  sourceImageId?: number | null;
  localOriginalUri?: string | null;
  residency?: LibraryResidency;
  protectEligible?: boolean;
  missingOriginalSince?: number | null;
  importClassification?: LibraryImportClassification;
  importDeletedAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}>;

export type SeedLibraryProtectionInput = Readonly<{
  plaintextSha256: string;
  accountScope?: string;
  assetId?: string;
  lifecycle?: LibraryLifecycle;
  protection?: LibraryProtection;
  generation?: number;
  revision?: number | null;
  originalGenerationId?: string | null;
  originalCiphertextBytes?: number | null;
  verifiedAt?: number | null;
  failureCategory?: LibraryFailureCategory | null;
  trashedAt?: number | null;
  updatedAt?: number;
}>;

export type SeedDeviceAssetStateInput = Readonly<{
  plaintextSha256: string;
  cachedRolesJson?: string;
  lastVerifiedAt?: number | null;
  deviceTrashUri?: string | null;
  deviceTrashedAt?: number | null;
  updatedAt?: number;
}>;

/**
 * Seeds a Layer A `device_library_assets` row with CHECK-compatible defaults.
 * Shared by the view-model suite and Task 9 component fixtures.
 */
export async function seedDeviceLibraryAsset(
  database: SqlDatabasePort,
  input: SeedDeviceLibraryAssetInput,
): Promise<void> {
  const format = input.format ?? 'jpeg';
  const canonicalExtension = input.canonicalExtension
    ?? (format === 'jpeg' ? 'jpg' : format);
  const residency = input.residency ?? 'local-original';
  const localOriginalUri = input.localOriginalUri === undefined
    ? (residency === 'local-original'
      ? `file:///data/library/originals/${input.plaintextSha256}.jpg`
      : null)
    : input.localOriginalUri;
  const at = input.createdAt ?? 1_000;
  const columns = await database.getAll<{ name: string }>(
    'PRAGMA table_info(device_library_assets)',
  );
  const hasImportClassification = columns.some(
    ({ name }) => name === 'import_classification',
  );
  if (hasImportClassification) {
    await database.run(
      `INSERT INTO device_library_assets (
         plaintext_sha256, format, canonical_extension, byte_size, width, height,
         origin, source_image_id, local_original_uri, residency, protect_eligible,
         missing_original_since, import_classification, import_deleted_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.plaintextSha256,
        format,
        canonicalExtension,
        input.byteSize ?? 1_024,
        input.width ?? 800,
        input.height ?? 600,
        input.origin ?? 'import',
        input.sourceImageId === undefined ? null : input.sourceImageId,
        localOriginalUri,
        residency,
        (input.protectEligible ?? true) ? 1 : 0,
        input.missingOriginalSince ?? null,
        input.importClassification ?? 'unknown',
        input.importDeletedAt ?? null,
        at,
        input.updatedAt ?? at,
      ],
    );
    return;
  }
  await database.run(
    `INSERT INTO device_library_assets (
       plaintext_sha256, format, canonical_extension, byte_size, width, height,
       origin, source_image_id, local_original_uri, residency, protect_eligible,
       missing_original_since, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.plaintextSha256,
      format,
      canonicalExtension,
      input.byteSize ?? 1_024,
      input.width ?? 800,
      input.height ?? 600,
      input.origin ?? 'import',
      input.sourceImageId === undefined ? null : input.sourceImageId,
      localOriginalUri,
      residency,
      (input.protectEligible ?? true) ? 1 : 0,
      input.missingOriginalSince ?? null,
      at,
      input.updatedAt ?? at,
    ],
  );
}

/**
 * Seeds a Layer B `library_asset_protection` projection row.
 */
export async function seedLibraryProtection(
  database: SqlDatabasePort,
  input: SeedLibraryProtectionInput,
): Promise<void> {
  const lifecycle = input.lifecycle ?? 'active';
  await database.run(
    `INSERT INTO library_asset_protection (
       account_scope, asset_id, plaintext_sha256, lifecycle, protection,
       generation, revision, original_generation_id, original_ciphertext_bytes,
       verified_at, failure_category, trashed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.accountScope ?? VIEW_TEST_ACCOUNT_SCOPE,
      input.assetId
        ?? `${input.plaintextSha256.slice(32)}${input.plaintextSha256.slice(0, 32)}`,
      input.plaintextSha256,
      lifecycle,
      input.protection ?? 'unprotected',
      input.generation ?? 0,
      input.revision ?? null,
      input.originalGenerationId ?? null,
      input.originalCiphertextBytes ?? null,
      input.verifiedAt ?? null,
      input.failureCategory ?? null,
      input.trashedAt ?? (
        lifecycle === 'trash' || lifecycle === 'purged' ? 1 : null
      ),
      input.updatedAt ?? 1_000,
    ],
  );
}

/**
 * Seeds the per-device sidecar used for device trash and cache-role hints.
 */
export async function seedDeviceAssetState(
  database: SqlDatabasePort,
  input: SeedDeviceAssetStateInput,
): Promise<void> {
  await database.run(
    `INSERT INTO library_device_asset_state (
       plaintext_sha256, cached_roles_json, last_verified_at,
       device_trash_uri, device_trashed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.plaintextSha256,
      input.cachedRolesJson ?? '[]',
      input.lastVerifiedAt ?? null,
      input.deviceTrashUri ?? null,
      input.deviceTrashedAt ?? null,
      input.updatedAt ?? 1_000,
    ],
  );
}
