import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryBackgroundSyncPort } from '@/features/library/library-background-sync-port';
import type { ImageRepository } from '@/features/images/image-repository';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { ByosBinding, ByosCredentials } from '@/features/byos/byos-credentials';
import type { VaultMeta } from '@/features/byos/byos-vault-meta';
import type { CloudObjectStore } from '@/features/cloud-store/cloud-object-store';
import type {
  LibraryActionsController,
} from '@/features/library/library-actions-service';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import type { LibraryCacheStore } from '@/features/library/library-cache-store';
import type { LibraryChangeFeed } from '@/features/library/library-change-feed';
import type { LibraryCollectEvent } from '@/features/library/library-collect-adapter';
import type { LibraryCollectionFilesPort } from '@/features/library/library-collection-handover';
import type { LibraryReconcileSummary } from '@/features/library/library-ingest';
import type {
  LibraryConfirmedImportInput,
  LibraryImportSummary,
} from '@/features/library/library-import';
import type {
  LibraryImportSessionController,
} from '@/features/library/library-import-session';
import type {
  RemoveDeviceDataAssessment,
  RemoveDeviceDataResult,
} from '@/features/library/library-remove-device-data';
import type { LibraryRenderResolver } from '@/features/library/library-render-source';
import type {
  LibraryStorageMode,
  LibraryStorageModeStore,
} from '@/features/library/library-storage-mode';
import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import type { LibrarySyncTrigger } from '@/features/library/library-sync-triggers';
import type { MigrationPreview } from '@/features/library/library-migration-preview';
import type {
  LibraryAccountEnrollment,
  LibraryEnrollmentSummary,
} from '@/features/library/library-types';
import type { LibraryViewModel } from '@/features/library/library-view-model';

/** Board #27 S3: this phone's 本机存储 choice for the bound library. */
export type LibraryStorageModeControl = Readonly<{
  read(): Promise<LibraryStorageMode>;
  set(mode: LibraryStorageMode): Promise<void>;
}>;

/** Board #27 (spec §5.4): 删除全部应用数据's library half, opened by `LibraryController.beginReset()`,
 *  which resolves once no sync round runs; none starts until `end`. */
export type LibraryResetSession = Readonly<{
  clearDevice(): Promise<Readonly<{ failed: readonly string[] }>>; // step 3
  forgetCloudLibraries(): Promise<void>;                            // step 5
  /**
   * Board #27 S1b Task 8 (spec R26): waits until the ingest pool is idle, then
   * for every running upload, then for every running purge; deletes nothing.
   */
  settle(): Promise<void>;
  end(options: Readonly<{ retire: boolean }>): void;                // step 6
}>;

/** The BYOS composition's part of the stop; absent in the local core. */
export type LibraryResetHooks = Readonly<{
  hold(): Promise<Readonly<{
    settleUploads(): Promise<void>;
    end(options: Readonly<{ retire: boolean }>): void;
  }>>;
}>;

export type LibraryController = Readonly<{
  importImages(): Promise<LibraryImportSummary>;
  importConfirmedFiles?(
    input: LibraryConfirmedImportInput,
  ): Promise<LibraryImportSummary>;
  /**
   * Ledger N6-B2 (spec §4.1–§4.2): service-owned import batch session state
   * machine (`idle → picking → awaiting-choice → importing → result → idle`),
   * independent of the Collection view's mount lifetime.
   */
  importSession?: LibraryImportSessionController;
  onCollectedOriginalReady(event: LibraryCollectEvent): void;
  reconcileStorage(): Promise<LibraryReconcileSummary>;
  /**
   * K6-5 C: re-ingest every collected original the library never got — a
   * `ready` row with a local file, no `device_library_assets` entry, and no
   * terminal ingest verdict. Answers how many rows it handed to the ingest
   * pool. Run from the collection's resume sweep and from a completed sync
   * round; it holds no timer and no queue of its own.
   */
  reingestMissingLibraryRows(): Promise<number>;
  /**
   * N10 T2: re-drives protect for this device's local originals whose
   * protection was never satisfied and which no pending/sending outbox row
   * explains — the ingest-time protect that died before its first durable
   * outbox write, which neither the drain nor the ingest-time callers ever
   * retried. Answers how many digests it handed to the protect action. Run
   * from the resume chain, after the missing-original pass has flagged
   * vanished files and the backfill has repaired rows; it holds no timer and
   * no queue of its own.
   */
  reprotectUncommittedOriginals(): Promise<number>;
  /**
   * N10 T1: the saved `mirrored` rows whose original bytes exist nowhere —
   * every active, non-device-trashed asset of the image holds no usable
   * local original and, in the vault core, no committed cloud original
   * generation. Conservative: an image with one dead and one usable asset is
   * left alone, and an image whose every asset is trashed belongs to the
   * trash sweeps, not to the repair. The collection's resume sweep hands
   * each answer to the same path the row's repair button uses.
   */
  listMirrorDeadSavedImageIds(): Promise<readonly number[]>;
  /**
   * K6-5 C: the user pressed 「修复入库」 on one row. Dispatches it to the same
   * ingest pool and resolves once the pool is idle, so the screen's busy state
   * covers the real work rather than just the hand-off.
   */
  reingestCollectedOriginal(event: LibraryCollectEvent): Promise<void>;
  /**
   * Board #24 stage 1 (spec §5.4.2): remove this device's library copy of a
   * rewound save — its device rows, original, device-trash copy and pending
   * `collect`/`protect` intents — once the row is back on the deck. Keeps the
   * account row and the projection, so sync never brings it back, and deletes
   * nothing if the image is `saved` again by then. Single-flight per id.
   */
  purgeCollectedImage(imageId: number): Promise<void>;
  /**
   * N6-A2 (spec §4.8): device-local digest-membership purge for an imported
   * image. Removes only this phone's import membership while preserving any
   * surviving provider member's bytes and keeping the account mapping /
   * projection so sync never resurrects it.
   */
  purgeImportedAsset?(plaintextSha256: string): Promise<boolean>;
  /**
   * Board #24 crash recovery (spec §5.4.5): purge every library row whose
   * `images` row is back in the deck (`queued`/`active`) — a rewind whose
   * local phase never ran. Answers how many images it handed to the purge.
   * Run from the collection's resume sweep, before `reingestMissingLibraryRows`.
   */
  purgeUndoneLibraryRows(): Promise<number>;
  /**
   * The resume pass's missing-original check; answers how many rows it flagged.
   */
  noteMissingOriginals(): Promise<number>;
  /**
   * The resume pass's hand-over of existing rows (spec §5.5); answers how many.
   */
  handOverExisting(): Promise<number>;
  /** R24: the resume pass's `library-cache` orphan sweep; answers how many files it deleted. */
  sweepCacheOrphans(): Promise<number>;
  /**
   * Bytes on disk under this phone's library directory (`Paths.document/library`),
   * one walk. 收藏占用 adds this to the collection directory.
   */
  deviceLibraryBytes(): Promise<number>;
  /**
   * Counts verified locals, pending/missing, and already-enrolled digests for
   * the additive migration confirmation. Empty enrolled set when signed out
   * or in Store builds.
   */
  previewLocalLibraryMigration(): Promise<MigrationPreview>;
  /**
   * Layer B catch-up for assets collected while signed out. Safe and inert in
   * Store builds and while signed out; SP9C calls it only after the user
   * confirms additive migration.
   */
  enrollLocalAssetsForAccount(): Promise<LibraryEnrollmentSummary>;
  /**
   * Layer B for ONE local asset, by plaintext digest. K6-3a uses it to rebuild
   * a `collect` intent that went missing under an asset the account already
   * holds, so a lost intent is repaired instead of recorded as the terminal
   * `object_missing`. Inert while signed out, exactly like its batch sibling.
   */
  enrollLocalAssetForAccount(
    plaintextSha256: string,
  ): Promise<LibraryAccountEnrollment>;
  /**
   * Clears account-scoped projection/cache sibling tables. Never deletes
   * durable local originals. Optional — absent in Store / local-only cores.
   */
  clearAccountProjection?(accountScope: string): Promise<void>;
  /**
   * Assesses whether remove-device-data is blocked by unprotected unexported
   * originals. Optional — Direct-only.
   */
  assessRemoveDeviceData?(): Promise<RemoveDeviceDataAssessment>;
  /**
   * Destructive remove-device-data path. Optional — Direct-only.
   */
  removeAccountDataFromThisDevice?(): Promise<RemoveDeviceDataResult>;
  /**
   * Export-for-removal escape hatch. Optional — Direct-only.
   */
  exportUnprotectedOriginals?(): Promise<{ exported: number }>;
  /**
   * Board #27 (spec §5.4): 删除全部应用数据's library half. Resolves once no
   * sync round runs; none starts until `end`.
   */
  beginReset(): Promise<LibraryResetSession>;
}>;

/**
 * Read model + render resolver for the grid and detail screens. Composed in
 * every composition; null only when library storage is unavailable.
 */
export type LibraryViewSurface = Readonly<{
  model: LibraryViewModel;
  resolver: LibraryRenderResolver;
  /**
   * Board row 45: the share staging area's two actions, over the
   * composition's own file store. `stage` copies a full-quality source that is
   * not this device's local original into `Paths.cache/library-share/` under
   * `<sha256>.<ext>` and answers the copy's uri; `release` deletes such a copy
   * (export's `finally`, never share's). Both reject/act exactly as
   * `LibraryFileStore.stageShareCopy` / `releaseShareCopy` do.
   */
  shareFiles: Readonly<{
    stage(sourceUri: string, fileName: string): Promise<string>;
    release(uri: string): Promise<void>;
  }>;
}>;

export type LibraryIntegration = Readonly<{
  /** Null only when private library storage is unavailable for the platform. */
  libraryController: LibraryController | null;
  /**
   * Direct-only Cloud Vault actions. Null in Store builds and in Direct builds
   * with no configured API URL, so the local product never depends on it.
   */
  libraryActions: LibraryActionsController | null;
  /**
   * Direct-only multi-device sync engine. Null in Store builds and in Direct
   * builds that fall back to the local-only core (no account / API / storage).
   */
  librarySync: LibrarySyncController | null;
  /** Every composition's read model. Null only when library storage is unavailable. */
  libraryView: LibraryViewSurface | null;
  /** Direct-only decrypted-role cache. SP9B clears it on remove-device-data. */
  libraryCache: LibraryCacheStore | null;
  /**
   * Direct-only sync trigger for the two event sources SP8 deferred:
   * app-state foreground and library-screen focus. One instance, so both
   * sources share its throttle window. `null` in Store builds.
   */
  librarySyncTrigger: LibrarySyncTrigger | null;
  /**
   * K4: Direct-only background-task registration for the seamless-sync
   * loop. `null` in Store builds — Store never touches
   * `expo-background-task`/`expo-task-manager`, which is exactly why this
   * is a port on the integration and not a module import in app-services
   * (that import leaked both packages into the Store bundle).
   */
  libraryBackgroundSync: LibraryBackgroundSyncPort | null;
  /**
   * K6-2b (spec §2 G3): "something in the library just settled" — the signal a
   * mounted grid, detail screen, or settings section re-reads on. Null only
   * when library storage is unavailable. Board #27: the local core composes a
   * feed too, so `original-missing` re-reads a mounted grid at once.
   *
   * Separate from `librarySyncTrigger.onRoundComplete` on purpose. K4b wired
   * the settings section to rounds, but since K6-1c the ingest-time protect
   * runs outside the sync round, so a round is not its completion signal — the
   * exact gap that let a `protected` asset keep showing "Available offline"
   * until the user left the tab (measured 2026-09-14).
   */
  libraryChanges: LibraryChangeFeed | null;
  /**
   * Board #28: releases what this composition subscribed to outside itself
   * (the sync foreground guard on the process-wide transfer store); the bundle
   * closer calls it once. Absent in the local-only core, which subscribes to
   * nothing.
   */
  libraryDispose?: () => void;
  /**
   * Board #27 S3 (spec §5.8): this phone's 本机存储 choice for the bound
   * library. `set` writes it, then starts a round. Absent without a ready
   * cloud library.
   */
  libraryStorageMode?: LibraryStorageModeControl | null;
}>;

/** Protocol v1: the accepted S3 path, exactly as before P12-B. */
export type ByosS3Context = Readonly<{
  kind: 's3';
  credentials: ByosCredentials;
  meta: VaultMeta;
  /** `null` exactly when `meta.encryption === 'none'` (decision #14). */
  masterKey: Uint8Array | null;
  deviceId: string;
}>;
/**
 * Protocol v2 over a 4-action store (WebDAV now; OneDrive / Google Drive
 * later). `masterKey` is never null: spec §6 forces aes-gcm on every
 * cloud-drive backend.
 */
export type ByosStoreContext = Readonly<{
  kind: 'store';
  binding: Exclude<ByosBinding, ByosCredentials>;
  store: CloudObjectStore;
  meta: VaultMeta;
  masterKey: Uint8Array;
  deviceId: string;
}>;
/**
 * A fully-resolved BYOS vault handle: everything the Direct composition needs
 * to build the cloud stack, with every async step already done by the caller,
 * discriminated by `kind` (board #12) so the composition root never has to
 * guess a backend from which fields happen to be present.
 *
 * Resolving it means loading the stored binding, prompting for the vault
 * password, running the create/adopt or join path (a network round trip plus
 * scrypt), and reading the device id — all of which need UI and I/O that the
 * composition layer must not own. Decision #23 therefore keeps
 * `createLibraryIntegration` synchronous and pure: the caller
 * (`resolveByosStatus` in `byos-context-resolver.ts`) does the work and hands
 * the result in.
 */
export type ByosResolvedContext = ByosS3Context | ByosStoreContext;

export type LibraryIntegrationInput = Readonly<{
  database: SqlDatabasePort;
  /**
   * Absent or `null` — the overwhelmingly common case today — runs the same
   * local-only core as Store builds. `null` is accepted alongside `undefined`
   * because the production resolver returns `ByosResolvedContext | null` and
   * callers pass its result straight through (decision #23).
   */
  byos?: ByosResolvedContext | null;
  /**
   * C3b: the app's own image repository, used to rebuild the local `images`
   * row for an asset another device collected. Optional so a bare test bundle
   * still composes; when absent, reconciliation leaves `source_image_id` NULL
   * and restored assets stay on the cloud-only tile path.
   */
  images?: ImageRepository;
  /**
   * The collection's files, for the hand-over (spec §5.5); absent in a bare
   * test bundle, where nothing is handed over.
   */
  collectionFiles?: LibraryCollectionFilesPort;
  /**
   * K6-5 B: `collectionService.subscribeActiveDownloads`. The sync foreground
   * service exists so a save finishes while the screen is locked, and a save
   * starts with a booru download — so the guard has to see those too, not just
   * the cloud transfers. Optional: a bare test bundle (and the local-only core)
   * composes without one and keeps the K6-3 upload-only behaviour.
   */
  subscribeActiveDownloads?: (listener: (count: number) => void) => () => void;
  /**
   * What a row the cloud holds but no session can fetch reports in the
   * local-only core. Absent: `auth_attention`.
   */
  localUnavailableCategory?: LibraryFailureCategory;
  /**
   * N6-A3 (spec §4.4, §4.11): the resolver status for the current session so
   * re-adding a deleted cloud-backed image while offline/locked can distinguish
   * network, password-lock, drive sign-in, and integrity guidance.
   */
  byosStatus?: ByosStatus;
  /** Board #27 S3: absent → the kv-store one; tests inject. */
  storageModeStore?: LibraryStorageModeStore;
}>;

export type CreateLibraryIntegration = (
  input: LibraryIntegrationInput,
) => LibraryIntegration;
