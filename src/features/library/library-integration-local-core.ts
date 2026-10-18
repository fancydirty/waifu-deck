import { randomUUID } from 'expo-crypto';
import type { LibraryBackgroundSyncPort } from '@/features/library/library-background-sync-port';

import type { SqlDatabasePort } from '@/db/sql-port';
import type { ImageRepository } from '@/features/images/image-repository';
import { forgetEveryAccount } from '@/features/library/library-account-projection';
import type {
  LibraryActionsController,
} from '@/features/library/library-actions-service';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import {
  createLibraryCacheStore,
  type LibraryCacheStore,
} from '@/features/library/library-cache-store';
import {
  createLibraryChangeFeed,
  type LibraryChangeFeed,
} from '@/features/library/library-change-feed';
import {
  createLibraryCollectAdapter,
} from '@/features/library/library-collect-adapter';
import {
  createLibraryCollectBackfill,
  createLibraryIngestOutcomeRecorder,
} from '@/features/library/library-collect-backfill';
import {
  createLibraryCollectionHandover,
  type LibraryCollectionFilesPort,
  type LibraryCollectionHandover,
} from '@/features/library/library-collection-handover';
import {
  createLibraryCollectedPurge,
  type LibraryCollectedPurgeHooks,
} from '@/features/library/library-collected-purge';
import { listLocalMirrorDeadSavedImageIds } from '@/features/library/library-mirror-dead';
import {
  createExpoLibraryDecodeGate,
} from '@/features/library/library-decode-gate';
import {
  createExpoLibraryFilePort,
  createExpoLibraryFileStore,
} from '@/features/library/library-expo-file-store';
import type { LibraryFilePort } from '@/features/library/library-file-store';
import { createLibraryImportService } from '@/features/library/library-import';
import {
  createLibraryImportSessionController,
} from '@/features/library/library-import-session';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import {
  createLocalLibraryRenderResolver,
  createLocalLibraryViewModel,
} from '@/features/library/library-local-view';
import {
  createLibraryIngestService,
  LOCAL_ONLY_LIBRARY_ACCOUNT_PORT,
  type LibraryAccountPort,
  type LibraryReaddAuthorityLookup,
} from '@/features/library/library-ingest';
import {
  createLibraryReaddAuthorityLookup,
} from '@/features/library/library-readd-authority';
import type {
  LibraryIntegration,
  LibraryResetHooks,
  LibraryViewSurface,
} from '@/features/library/library-integration-types';
import {
  buildMigrationPreview,
} from '@/features/library/library-migration-preview';
import { createLibraryMissingOriginals } from '@/features/library/library-missing-originals';
import {
  createExpoLibraryPickerPort,
} from '@/features/library/library-picker';
import { createLibraryRepository } from '@/features/library/library-repository';
import type { LibrarySyncController } from '@/features/library/library-sync-engine';
import type { LibrarySyncTrigger } from '@/features/library/library-sync-triggers';
import type { LibraryIngestOutcome } from '@/features/library/library-types';

export function createLocalLibraryIntegration({
  database,
  account = LOCAL_ONLY_LIBRARY_ACCOUNT_PORT,
  images,
  onIngestOutcome,
  libraryActions = null,
  librarySync = null,
  libraryView = null,
  localUnavailableCategory = 'auth_attention',
  byosStatus,
  lookupReaddAuthority,
  libraryCache = null,
  librarySyncTrigger = null,
  libraryBackgroundSync = null,
  libraryChanges = null,
  collectionFiles,
  collectedPurgeHooks,
  resetHooks,
}: Readonly<{
  database: SqlDatabasePort;
  account?: LibraryAccountPort;
  /**
   * K6-5 C: the collection's own repository, so an ingest that throws is
   * written to `images.library_error` instead of vanishing. Optional — a bare
   * test bundle composes without one and simply records nothing.
   */
  images?: ImageRepository;
  onIngestOutcome?: (outcome: LibraryIngestOutcome) => void;
  libraryActions?: LibraryActionsController | null;
  librarySync?: LibrarySyncController | null;
  libraryView?: LibraryViewSurface | null;
  /**
   * What a row the cloud holds but no session can fetch reports.
   * Absent: `auth_attention`.
   */
  localUnavailableCategory?: LibraryFailureCategory;
  byosStatus?: ByosStatus;
  lookupReaddAuthority?: LibraryReaddAuthorityLookup;
  libraryCache?: LibraryCacheStore | null;
  librarySyncTrigger?: LibrarySyncTrigger | null;
  libraryBackgroundSync?: LibraryBackgroundSyncPort | null;
  /**
   * K6-2b: the Direct composition's change feed. Absent: this core makes its
   * own, so a vanished original still announces.
   */
  libraryChanges?: LibraryChangeFeed | null;
  /**
   * Board #27 S1b: the collection's files, for the hand-over (spec §5.5).
   * Absent in a bare test bundle: nothing is handed over.
   */
  collectionFiles?: LibraryCollectionFilesPort;
  /**
   * Board #24: the BYOS composition's before/after steps of a rewound save's
   * purge (join an upload, evict the cache; announce). Absent here.
   */
  collectedPurgeHooks?: LibraryCollectedPurgeHooks;
  /**
   * Board #27: the BYOS composition's part of 删除全部应用数据 — hold the sync
   * lease and settle uploads. Absent here: settle and end do nothing.
   */
  resetHooks?: LibraryResetHooks;
}>): LibraryIntegration {
  let files: ReturnType<typeof createExpoLibraryFileStore>;
  let view: LibraryViewSurface;
  let port: LibraryFilePort;
  const repository = createLibraryRepository(database);
  try {
    // Web check first: the store throws before expo-file-system is touched.
    files = createExpoLibraryFileStore();
    // Every composition checks its originals (the missing-original pass),
    // including one that brings its own view.
    port = createExpoLibraryFilePort();
    if (libraryView !== null) {
      view = libraryView;
    } else {
      const model = createLocalLibraryViewModel({ database });
      const resolver = createLocalLibraryRenderResolver({
        repository,
        model,
        files: port,
        unavailableCategory: localUnavailableCategory,
      });
      view = {
        model,
        resolver,
        shareFiles: {
          stage: (sourceUri: string, fileName: string) =>
            files.stageShareCopy(sourceUri, fileName),
          release: (uri: string) => files.releaseShareCopy(uri),
        },
      };
    }
  } catch {
    // Private library storage is unavailable on this platform.
    return {
      libraryController: null,
      libraryActions: null,
      librarySync: null,
      libraryView: null,
      libraryCache: null,
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
      libraryChanges: null,
    };
  }

  const changes = libraryChanges ?? createLibraryChangeFeed();
  const defaultRestoreImage = images === undefined
    ? undefined
    : async (
      candidate: Parameters<typeof images.saveMirroredCandidate>[0],
      savedAt: number,
    ) => {
      const stored = await images.saveMirroredCandidate(candidate, savedAt);
      return stored.id;
    };
  const ingest = createLibraryIngestService({
    files,
    repository,
    decodeGate: createExpoLibraryDecodeGate(),
    account,
    newMutationId: () => randomUUID(),
    lookupReaddAuthority:
      lookupReaddAuthority
      ?? createLibraryReaddAuthorityLookup({
        database,
        restoreImage: defaultRestoreImage,
        byosStatus,
        unavailableReason:
          byosStatus !== undefined
            ? undefined
            : localUnavailableCategory === 'offline'
              ? 'network'
              : undefined,
      }),
    // N6-A2 (spec §4.5 / §7.1): in the local-only core (when no BYOS
    // `onIngestOutcome` wrapper is provided), emit `ingested` immediately on
    // the local change feed so mounted Collection screens and storage counters
    // update without a tab-focus workaround.
    onIngestOutcome: onIngestOutcome ?? ((outcome) => {
      if (outcome.status !== 'ingested') return;
      changes.emit({
        kind: 'ingested',
        plaintextSha256: outcome.asset.plaintextSha256,
      });
    }),
  });

  const picker = createExpoLibraryPickerPort();
  const importService = createLibraryImportService({
    picker,
    files,
    ingest,
  });
  const importSession = createLibraryImportSessionController({
    picker,
    files,
    importService,
  });
  // K6-5 C: the two halves of "this save is in the library, or here is why it
  // is not", written next to the query that reads them back.
  const outcome = createLibraryIngestOutcomeRecorder(images);
  // Board #27 S1b (spec §5.5): a saved image's collection file goes to the
  // library once the ingest holds its original. Inert without the collection's
  // files.
  const handover: LibraryCollectionHandover = collectionFiles === undefined
    ? {
      handOver: async () => false,
      handOverExisting: async () => 0,
    }
    : createLibraryCollectionHandover({
      database,
      libraryFiles: port,
      collectionFiles,
      changes,
    });
  const collectAdapter = createLibraryCollectAdapter({
    ingest,
    onFailure: outcome.onFailure,
    onSuccess: (event, ingestOutcome) => {
      outcome.onSuccess(event);
      // `handOver` never throws; the catch is for a future that might.
      void handover.handOver(event, ingestOutcome).catch(() => undefined);
    },
  });
  const collectBackfill = createLibraryCollectBackfill({
    database,
    collect: collectAdapter.onOriginalReady,
  });
  // Board #24: the same pool the ingest runs in, so a purge can wait for it.
  const collectedPurge = createLibraryCollectedPurge({
    database,
    files,
    collect: collectAdapter,
    withDigestGate: (plaintextSha256, work) =>
      ingest.withDigestGate(plaintextSha256, work),
    settleImports: () => importService.settled(),
    // Board #27 F1: with no BYOS hooks the purge still announces, so a no-cloud
    // 收藏 delete reaches 收藏占用 (the BYOS hooks announce the same after the purge).
    hooks: collectedPurgeHooks ?? {
      after: ({ plaintextSha256 }) => changes.emit({ kind: 'purged', plaintextSha256 }),
    },
  });
  const idleHold: Awaited<ReturnType<LibraryResetHooks['hold']>> = {
    settleUploads: async () => undefined,
    end: () => undefined,
  };
  const missingOriginals = createLibraryMissingOriginals({
    database,
    files: port,
    changes,
  });

  // R24: the no-cloud composition has no cache store, yet it can hold decrypted
  // files a 删除全部应用数据 left behind; it builds one over its own port to sweep.
  const cacheSweep = libraryCache ?? createLibraryCacheStore({ database, files, port });

  return {
    libraryController: {
      importImages: () => importService.importFromPicker(),
      importConfirmedFiles: (input) => importService.importConfirmedFiles(input),
      importSession,
      onCollectedOriginalReady: collectAdapter.onOriginalReady,
      reconcileStorage: () => ingest.reconcileStorage(),
      reingestMissingLibraryRows: () => collectBackfill.run(),
      // N10 T2: no cloud in this core — there is no account to commit an
      // original to, so nothing is ever unprotected by a lost protect. The
      // vault composition overrides this with the real re-protect pass.
      reprotectUncommittedOriginals: async () => 0,
      // N10 T1: no cloud in this core, so the selector reads no protection
      // row — a mirrored row with no usable local original is dead here too.
      listMirrorDeadSavedImageIds: () =>
        listLocalMirrorDeadSavedImageIds(database),
      reingestCollectedOriginal: async (event) => {
        collectAdapter.onOriginalReady(event);
        await collectAdapter.drain();
      },
      purgeCollectedImage: (imageId) => collectedPurge.purgeCollectedImage(imageId),
      purgeImportedAsset: (plaintextSha256) =>
        collectedPurge.purgeImportedAsset(plaintextSha256),
      purgeUndoneLibraryRows: () => collectedPurge.purgeUndoneLibraryRows(),
      beginReset: async () => {
        // Refused before the hold is awaited: a round's listeners can still
        // dispatch an ingest, an import, or a purge while the hold waits for
        // that round.
        const releaseIngests = collectAdapter.refuse();
        const releaseImports = importService.refuse();
        const releaseImportSession = importSession.refuse();
        const releasePurges = collectedPurge.refuse();
        const releaseRefusals = () => {
          releaseIngests();
          releaseImports();
          releaseImportSession();
          releasePurges();
        };
        let hold: Awaited<ReturnType<LibraryResetHooks['hold']>>;
        try {
          hold = resetHooks === undefined ? idleHold : await resetHooks.hold();
        } catch (error) {
          releaseRefusals();
          throw error;
        }
        return {
          clearDevice: async () => {
            await importSession.settled();
            await importService.settled();
            return await collectedPurge.clearDeviceLibrary(
              () => hold.settleUploads(),
            );
          },
          forgetCloudLibraries: () => forgetEveryAccount(database),
          settle: async () => {
            await collectAdapter.drain();
            await importSession.settled();
            await importService.settled();
            await hold.settleUploads();
            await collectedPurge.settled();
          },
          end: (options) => {
            try {
              hold.end(options);
            } finally {
              releaseRefusals();
            }
          },
        };
      },
      noteMissingOriginals: () => missingOriginals.noteMissingOriginals(),
      handOverExisting: () => handover.handOverExisting(),
      sweepCacheOrphans: () => cacheSweep.sweepOrphans(),
      deviceLibraryBytes: () => port.durableBytes(),
      previewLocalLibraryMigration: async () => {
        const localAssets = (await repository.listLocalAssets()).filter(
          (asset) =>
            asset.origin !== 'import'
            || (asset.importDeletedAt ?? null) === null
            || asset.sourceImageId !== null,
        );
        const accountScope = await account.accountScope();
        const alreadyEnrolledDigests = new Set<string>();
        if (accountScope !== null) {
          const pending = await repository.listLocalAssetsMissingEnrollment(
            accountScope,
          );
          const pendingDigests = new Set(
            pending.map((asset) => asset.plaintextSha256),
          );
          for (const asset of localAssets) {
            if (!pendingDigests.has(asset.plaintextSha256)) {
              alreadyEnrolledDigests.add(asset.plaintextSha256);
            }
          }
        }
        return buildMigrationPreview({
          localAssets,
          alreadyEnrolledDigests,
        });
      },
      enrollLocalAssetsForAccount: () => ingest.enrichLocalAssetsForAccount(),
      enrollLocalAssetForAccount: (plaintextSha256) => (
        ingest.enrichLocalAssetForAccount(plaintextSha256)
      ),
    },
    libraryActions,
    // Store and local-only Direct fallbacks never construct a sync engine.
    librarySync,
    libraryView: view,
    libraryCache,
    librarySyncTrigger,
    libraryBackgroundSync,
    libraryChanges: changes,
  };
}
