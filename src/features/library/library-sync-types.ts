import type {
  LibraryFailureCategory,
  LibraryLifecycle,
  LibraryProtection,
} from '@/features/library/library-actions-types';
import type { LibraryDeviceTrashSweepReport } from '@/features/library/library-device-trash-sweep';

/**
 * Worker `LibraryChangeKind`. `purge` exists only in the change feed — it is
 * never a client mutation kind — and its row always carries
 * `lifecycle: 'purged'`, `protection: 'unprotected'`, and no metadata.
 */
export type LibraryChangeKind =
  | 'collect'
  | 'trash'
  | 'restore'
  | 'purge'
  | 'protect'
  | 'stop-protection';

/**
 * One row of `GET /api/v3/library/changes`. Times are ISO-8601 strings exactly
 * as the Worker stores them; the projection converts them once. A change row
 * deliberately carries **no** object generation ids.
 */
export type LibraryRemoteChange = Readonly<{
  revision: number;
  assetId: string;
  kind: LibraryChangeKind;
  generation: number;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  encryptedMetadata: string | null;
  trashedAt: string | null;
  purgeAfter: string | null;
  createdAt: string;
}>;

export type LibraryChangesPage = Readonly<{
  resyncRequired: boolean;
  /** Exclusive watermark: the next request asks for `revision > cursor`. */
  cursor: number;
  latestRevision: number;
  minBaseCursor: number;
  hasMore: boolean;
  changes: readonly LibraryRemoteChange[];
}>;

/**
 * One row of `GET /api/v3/library/index`. It is a superset of the SP7
 * `LibraryRemoteAssetState` and is declared here, not imported from the cloud
 * client, so no pure sync module ever imports a network module for a type.
 */
export type LibraryRemoteIndexAsset = Readonly<{
  assetId: string;
  generation: number;
  revision: number;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  collectedAt: string;
  trashedAt: string | null;
  purgeAfter: string | null;
  encryptedMetadata: string | null;
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
  originalGenerationId: string | null;
  originalBytes: number | null;
  committedCiphertextBytes: number;
}>;

export type LibraryIndexPage = Readonly<{
  cursor: number;
  minBaseCursor: number;
  hasMore: boolean;
  nextAfter: string | null;
  assets: readonly LibraryRemoteIndexAsset[];
}>;

/** A remote asset state record reduced to what the local projection owns. */
export type LibraryProjectedAsset = Readonly<{
  assetId: string;
  revision: number;
  generation: number;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  encryptedMetadata: string | null;
  trashedAtMs: number | null;
  /**
   * Authoritative object reference for role `original`, from the record's
   * `generations` map. `null` for an unprotected asset — and `null` never
   * clears a stored reference for a still-protected one.
   */
  originalGenerationId: string | null;
  /**
   * Always `null` under BYOS: the per-asset state record has no ciphertext
   * byte count and, with quota deleted, nothing needs one. See
   * `library-sync-projection.ts` for the ruling.
   */
  originalCiphertextBytes: number | null;
  /** Authoritative derived references, same `generations`-map source. */
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
  /**
   * N6-A3 (spec §4.3): remote state authority identity (`state/<noteName>` for
   * append-only protocol v2 notes, or `s3:<revision>` for S3 CAS).
   */
  stateKey?: string | null;
}>;

/**
 * The retired `library_sync_state` row: one watermark per account scope
 * (P3C decision #19). `lastSyncedAt` is when this device last completed a
 * reconcile; `updatedAt` is 0 for a scope that never has.
 */
export type LibrarySyncCursor = Readonly<{
  accountScope: string;
  lastSyncedAt: number | null;
  updatedAt: number;
}>;

/**
 * The only file effects SP8 may cause. None of them deletes a durable local
 * original: `delete-device-trash` targets app-private device-trash bytes only.
 */
export type LibrarySyncFileAction =
  | Readonly<{
      kind: 'move-to-device-trash';
      plaintextSha256: string;
      fromUri: string;
    }>
  | Readonly<{
      kind: 'restore-from-device-trash';
      plaintextSha256: string;
      fromUri: string;
    }>
  | Readonly<{
      kind: 'delete-device-trash';
      plaintextSha256: string;
      uri: string;
    }>;

export type LibrarySyncReconcileReport = Readonly<{
  movedToDeviceTrash: number;
  restoredFromDeviceTrash: number;
  purgedDeviceTrash: number;
  /** A delete whose target was a durable original or an unknown path. */
  refused: number;
  failed: number;
}>;

export type LibrarySyncReport = Readonly<{
  status: 'completed' | 'skipped' | 'halted';
  skipped: 'no_account' | null;
  haltedCategory: LibraryFailureCategory | null;
  /** Remote state records this cycle projected (reconcile + convergence). */
  reconciled: number;
  materialized: number;
  rebased: number;
  discarded: number;
  submitted: number;
  committed: number;
  rejected: number;
  /** Rows left `sending`: dispatched, outcome still unknown, never discarded. */
  unresolved: number;
  files: LibrarySyncReconcileReport;
  /** Expired device-trash bytes swept after reconcile. */
  deviceTrashSweep: LibraryDeviceTrashSweepReport;
}>;

/** Result of SP9's trash-screen hook. SP8 builds no trash UI. */
export type LibraryRestoreIntentResult =
  | Readonly<{ status: 'queued'; mutationId: string }>
  | Readonly<{ status: 'already-queued'; mutationId: string }>
  | Readonly<{
      status: 'not-applicable';
      reason: 'no_account' | 'unknown_asset' | 'not_trash';
    }>;

/** Result of SP9's permanent-delete hook. Same shape as restore. */
export type LibraryPermanentDeleteIntentResult =
  | Readonly<{ status: 'queued'; mutationId: string }>
  | Readonly<{ status: 'already-queued'; mutationId: string }>
  | Readonly<{
      status: 'not-applicable';
      reason: 'no_account' | 'unknown_asset' | 'not_trash';
    }>;
