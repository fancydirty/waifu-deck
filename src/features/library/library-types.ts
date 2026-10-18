export type LibraryImageFormat = 'jpeg' | 'png' | 'webp' | 'gif';

export type LibraryCanonicalExtension = 'jpg' | 'png' | 'webp' | 'gif';

export type LibraryAssetOrigin = 'provider' | 'import';

export type LibraryImportClassification = 'safe' | 'adult' | 'unknown';

export const LIBRARY_IMPORT_CLASSIFICATIONS: readonly LibraryImportClassification[] = [
  'safe',
  'adult',
  'unknown',
];

export function isLibraryImportClassification(
  value: unknown,
): value is LibraryImportClassification {
  return value === 'safe' || value === 'adult' || value === 'unknown';
}

export type LibraryResidency = 'local-original' | 'cached' | 'cloud-only';

export type LibraryMutationKind =
  | 'collect'
  | 'protect'
  | 'trash'
  | 'restore'
  | 'stop-protection'
  | 'permanent-delete';

export type LibraryOutboxState = 'pending' | 'sending' | 'sent' | 'failed';

/**
 * There is deliberately no missing-account failure code here. Layer A must make
 * bytes durable without an account, and Layer B is skipped — never failed —
 * when no session is available.
 */
export type LibraryIngestErrorCode =
  | 'empty_file'
  | 'file_too_large'
  | 'unreadable_source'
  | 'unsupported_format'
  | 'decode_failed'
  | 'storage_failed'
  | 'database_failed'
  | 'authority_network'
  | 'authority_password_locked'
  | 'authority_reauth_required'
  | 'authority_integrity';

export class LibraryIngestError extends Error {
  readonly code: LibraryIngestErrorCode;

  constructor(
    code: LibraryIngestErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'LibraryIngestError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
    Object.setPrototypeOf(this, LibraryIngestError.prototype);
  }
}

/**
 * K6-5 C: name an ingest rejection so it can be persisted. A
 * {@link LibraryIngestError} already carries its verdict; anything else that
 * escaped the pipeline came from the storage/database work around it, which is
 * what `database_failed` means everywhere else in this module.
 */
export function libraryIngestErrorCode(error: unknown): LibraryIngestErrorCode {
  return error instanceof LibraryIngestError ? error.code : 'database_failed';
}

/**
 * Layer A row. It is identified by the unkeyed plaintext digest and carries no
 * account column, so a signed-out Store or Direct device owns it completely.
 */
export type DeviceLibraryAsset = Readonly<{
  plaintextSha256: string;
  format: LibraryImageFormat;
  canonicalExtension: LibraryCanonicalExtension;
  byteSize: number;
  /** Decoded pixel size, kept locally so later account enrollment never re-decodes. */
  width: number;
  height: number;
  origin: LibraryAssetOrigin;
  sourceImageId: number | null;
  localOriginalUri: string | null;
  residency: LibraryResidency;
  protectEligible: boolean;
  missingOriginalSince: number | null;
  /** Board #27 S2: this device's durable thumbnail (spec §5.9); null until ensured. */
  localThumbnailUri: string | null;
  /** N6-A1 (spec §4.3): closed three-state import classification ('safe' | 'adult' | 'unknown'). */
  importClassification?: LibraryImportClassification;
  /** N6-A1 (spec §4.4): set when import membership is deleted on this phone while a shared digest remains. */
  importDeletedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}>;

/** Layer B row: the Vault-scoped keyed identity for one local asset. */
export type LibraryAccountAsset = Readonly<{
  accountScope: string;
  assetId: string;
  plaintextSha256: string;
  deviceId: string;
  enrolledAt: number;
  updatedAt: number;
}>;

export type LibraryCollectMetadata = Readonly<{
  assetId: string;
  plaintextSha256: string;
  format: LibraryImageFormat;
  byteSize: number;
  width: number;
  height: number;
  origin: LibraryAssetOrigin;
  sourceImageId: number | null;
  collectedAt: number;
  importClassification?: LibraryImportClassification;
}>;

/**
 * Mirrors the design `LibraryMutation` identity. `deviceId` is captured once at
 * collect time from the SP5 session and is submitted unchanged by SP8.
 */
export type LibraryOutboxEntry = Readonly<{
  mutationId: string;
  accountScope: string;
  deviceId: string;
  assetId: string;
  kind: LibraryMutationKind;
  baseRevision: number | null;
  observedGeneration: number | null;
  state: LibraryOutboxState;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  localMetadata: LibraryCollectMetadata;
  createdAt: number;
  updatedAt: number;
}>;

export type LibraryEnrollmentSkipReason = 'no_account' | 'no_device';

/** Result of the Layer B attempt. A skip or failure never harms Layer A. */
export type LibraryAccountEnrollment =
  | Readonly<{
      status: 'enrolled';
      accountAsset: LibraryAccountAsset;
      mutationId: string;
    }>
  | Readonly<{ status: 'already-enrolled'; accountAsset: LibraryAccountAsset }>
  | Readonly<{ status: 'skipped'; reason: LibraryEnrollmentSkipReason }>
  | Readonly<{ status: 'failed'; code: LibraryIngestErrorCode }>;

export type LibraryIngestOutcome = Readonly<{
  /** `ingested` means Layer A wrote a new local asset (or re-added a deleted import) on this call. */
  status: 'ingested' | 'duplicate';
  asset: DeviceLibraryAsset;
  enrollment: LibraryAccountEnrollment;
  /**
   * N6-A2 (spec §4.4 / §4.11): true only when a locally-deleted import was
   * explicitly re-added from an active cloud record whose authoritative
   * classification differed from the batch's chosen `safe | adult`.
   */
  retainedLibraryClassification?: boolean;
}>;

export type LibraryEnrollmentSummary = Readonly<{
  enrolled: number;
  alreadyEnrolled: number;
  skipped: number;
  failed: readonly Readonly<{ code: LibraryIngestErrorCode }>[];
}>;
