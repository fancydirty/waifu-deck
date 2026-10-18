import { QueryClient, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Text, View } from 'react-native';

import {
  openAppDatabaseConnection,
  resetAppDatabase,
  type AppDatabaseConnection,
} from '@/db/database';
import type { SqlDatabasePort } from '@/db/sql-port';
import { ScreenState } from '@/components/screen-state';
import {
  createAppBackupService,
  sweepBackupArtifacts,
  type AppBackupService,
  type BackupSummary,
  type PreparedAppRestore,
  type RestoreSummary,
} from '@/features/backup/backup-service';
import {
  createExpoFileRepository,
} from '@/features/collection/expo-file-repository';
import type {
  CollectionFileRepository,
  FileDeleteAllResult,
} from '@/features/collection/file-repository';
import { WaifuSyncService } from '../../modules/waifu-sync-service';
import {
  createCollectionService,
  type CollectionService,
  type DeleteAllDataResult,
} from '@/features/collection/collection-service';
import {
  publishCollectionRow,
  publishCollectionSnapshot,
  publishCollectionValue,
} from '@/features/collection/collection-query';
import {
  createDataResetCoordinator,
  type DataResetCoordinator,
} from '@/features/data-reset/data-reset-coordinator';
import {
  createDiscoveryService,
  type DiscoveryService,
} from '@/features/discovery/discovery-service';
import {
  configuredE2eRuntimeConfig,
} from '@/features/e2e/e2e-runtime';
import {
  createFixtureDiscoveryFetcher,
} from '@/features/e2e/fixture-discovery-provider';
import {
  sanitizeImageDatabaseForDistribution,
} from '@/features/distribution/distribution-policy';
import {
  createImageRepository,
  type ImageRepository,
} from '@/features/images/image-repository';
import {
  createManagedPreviewCache,
  type ManagedPreviewCache,
} from '@/features/images/preview-cache';
import {
  createDiscoveryProviderFetcher,
  type DiscoveryProviderFetcher,
} from '@/features/providers/provider-client';
import {
  createProviderCredentialStore,
  type ProviderCredential,
  type ProviderCredentialMap,
  type ProviderCredentialStore,
} from '@/features/providers/provider-credentials';
import {
  createProviderRequestGovernor,
  type ProviderRequestGovernor,
} from '@/features/providers/provider-resilience';
import {
  createSettingsRepository,
  type SettingsRepository,
} from '@/features/settings/settings-repository';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  settingsAffectDiscovery,
} from '@/features/settings/settings';
import type { AppSettings, ImageProviderKey } from '@/features/waifu/types';
import { resolveByosStatus as resolveByosStatusDefault } from '@/features/byos/byos-context-resolver';
import { disconnectDevice } from '@/features/byos/byos-connect-flow';
import { createExpoLibraryFileStore } from '@/features/library/library-expo-file-store';
import type { LibraryFileStore } from '@/features/library/library-file-store';
import { createExpoLibraryNetworkRecovery } from '@/features/library/library-network-recovery';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import {
  createLibraryRecoveryController,
  type LibraryRecoveryController,
  type RecoveryBundleState,
  type RecoveryVerdictKind,
} from '@/providers/library-recovery-controller';
import {
  createLibraryIntegration,
} from '@/features/library/library-integration';
import { localUnavailableCategoryFor } from '@/features/library/library-local-view';
import { setLibraryBackgroundRound } from '@/features/library/library-background-sync-slot';
import type {
  ByosResolvedContext,
  CreateLibraryIntegration,
  LibraryIntegration,
  LibraryResetSession,
  LibraryStorageModeControl,
} from '@/features/library/library-integration-types';
import { applyLanguagePreference } from '@/i18n';
import {
  createHandedOverPublishers,
  HandedOverPublishersContext,
} from '@/providers/handed-over-publishers';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { shouldRetryWaifu, waifuRetryDelay } from '@/features/waifu/query-policy';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type AppServiceResources = {
  database: SqlDatabasePort;
  settingsRepository: SettingsRepository;
  imageRepository: ImageRepository;
  fileRepository: CollectionFileRepository;
  initialSettings: AppSettings;
  /**
   * Pre-resolved BYOS vault context, or `null`/absent to run the local-only
   * core. `initializeAppServices` resolves this once via
   * `resolveByosStatus()` before constructing the bundle, since
   * `createAppServiceBundle` itself stays synchronous. Only a `ready` status
   * carries a context — see {@link byosResourcesFor}.
   */
  byos?: ByosResolvedContext | null;
  /**
   * The full resolver verdict behind `byos`, carried alongside it so the UI
   * can tell "no vault configured" apart from "vault configured but locked or
   * unreachable" (D3). Absent means `unconfigured`.
   */
  byosStatus?: ByosStatus;
  /**
   * G4 — the credential-map + its store, both resolved by
   * `initializeAppServices` before the synchronous bundle build (same seam as
   * `byos`). The bundle holds the map in a live ref the discovery fetcher and
   * search read through a snapshot accessor; save/clear refresh it. Absent in
   * a bare test bundle — it falls back to an empty map over a fresh store.
   */
  providerCredentialStore?: ProviderCredentialStore;
  providerCredentialMap?: ProviderCredentialMap;
};

const UNCONFIGURED_BYOS: ByosStatus = { status: 'unconfigured' };

let startupBackupSweep: Promise<void> | null = null;
let startupLibraryStreamSweep: Promise<void> | null = null;

function sweepBackupArtifactsAtStartup(): Promise<void> {
  startupBackupSweep ??= Promise.resolve()
    .then(() => sweepBackupArtifacts())
    .then(() => undefined, () => undefined);
  return startupBackupSweep;
}

export function sweepLibraryStreamAtStartup(): Promise<void> {
  startupLibraryStreamSweep ??= Promise.resolve()
    .then(async () => {
      const files = createExpoLibraryFileStore();
      // The two sweeps are independent: a failing one is warned about and
      // never stops the other (review fix, board row 45 — a stuck stream
      // sweep must not leave a staged share copy behind).
      try {
        await files.sweepStreamDir();
      } catch (error) {
        console.warn('Library stream startup sweep failed.', error);
      }
      // Board row 45: the same sweep empties the share staging area, so a
      // staged copy never outlives the process that shared it.
      try {
        await files.sweepShareDir();
      } catch (error) {
        console.warn('Library share startup sweep failed.', error);
      }
      // Ledger N6-B2 (spec §3.1): cold-start sweep of leftover picker cache
      // exports from an interrupted import session.
      try {
        await files.sweepPickerCacheDir?.();
      } catch (error) {
        console.warn('Library picker cache startup sweep failed.', error);
      }
    })
    .then(() => undefined, (error: unknown) => {
      // Anything outside the two blocks — `createExpoLibraryFileStore` itself
      // throws on a platform without private storage — is only warned about;
      // startup goes on to open the database (review fix 2, board row 45).
      console.warn('Library startup sweep failed.', error);
    });
  return startupLibraryStreamSweep;
}

/**
 * Split a resolver verdict into the two resource fields it feeds. Only
 * `ready` yields a vault context; a `locked` vault composes the same
 * local-only core as an unconfigured one — but keeps its reason in
 * `byosStatus`, because presenting `locked` as `unconfigured` is the silent
 * downgrade D3 forbids.
 */
export function byosResourcesFor(
  byosStatus: ByosStatus,
): Pick<AppServiceResources, 'byos' | 'byosStatus'> {
  return {
    byos: byosStatus.status === 'ready' ? byosStatus.context : null,
    byosStatus,
  };
}

export type AppServiceBundle = AppServiceResources & {
  backupService: AppBackupService;
  byosStatus: ByosStatus;
  libraryController: LibraryIntegration['libraryController'];
  libraryActions: LibraryIntegration['libraryActions'];
  librarySync: LibraryIntegration['librarySync'];
  libraryView: LibraryIntegration['libraryView'];
  libraryCache: LibraryIntegration['libraryCache'];
  librarySyncTrigger: LibraryIntegration['librarySyncTrigger'];
  libraryBackgroundSync: LibraryIntegration['libraryBackgroundSync'];
  /**
   * K6-2b: "something in the library settled" — what the grid, the detail
   * screen, and the BYOS settings section re-read on. Alongside
   * `librarySyncTrigger` because they are the two halves of one loop: the
   * trigger is how a screen asks for work, this is how the work answers.
   */
  libraryChanges: LibraryIntegration['libraryChanges'];
  /** Board #28: releases the composition's process-wide subscriptions; the closer calls it. */
  libraryDispose?: LibraryIntegration['libraryDispose'];
  /**
   * Board #27 S3b (spec §5.14): this phone's 本机存储 choice for the bound
   * library. Null without a ready cloud library (the local core has none).
   */
  libraryStorageMode: LibraryStorageModeControl | null;
  /**
   * Board row 52: replace the local library with the ready verdict's, on the
   * given bundle's database and repositories. The bundle is an argument so a
   * detached call still keeps `closeDatabase` and `startupRecovery`. Throws
   * when the current integration has `libraryDispose`, or when the factory
   * answers with the local core instead of a vault composition.
   */
  rebindLibrary(
    bundle: AppServiceBundle,
    verdict: Extract<ByosStatus, { status: 'ready' }>,
  ): AppServiceBundle;
  /** Undo an unpublished rebind only while its installed integration still owns the holder. */
  revertRebind?(): void;
  /**
   * The library half of a collection resume. A recovery rebind awaits the
   * entire pass chain under its mutation; `onCollectionResumed` starts the
   * same chain without delaying the collection's startup snapshot.
   */
  resumeLibrary(): Promise<void>;
  /** Refuse new resume starts and drain admitted chains across original and rebound bundles. */
  closeLibraryResume(): Promise<void>;
  resetCoordinator: DataResetCoordinator;
  collectionService: CollectionService;
  discoveryService: DiscoveryService;
  managedPreviewCache: ManagedPreviewCache;
  providerRequestGovernor: ProviderRequestGovernor;
  providerCredentials: ProviderCredentialService;
  startupRecovery?: Promise<boolean>;
  closeDatabase?: () => Promise<void>;
};

/**
 * G4 — the credential map behind a live ref. `snapshot()` returns the current
 * map (discovery's fetcher accessor and search read it); save/clear persist
 * through the secure store then refresh the ref, so a saved key takes effect
 * on the next refill/search without an app reload (spec §2.2). The enable-flag
 * flip stays on the normal settings path — this service never touches it.
 */
export type ProviderCredentialService = {
  snapshot: () => ProviderCredentialMap;
  save: (key: ImageProviderKey, credential: ProviderCredential) => Promise<void>;
  clear: (key: ImageProviderKey) => Promise<void>;
};

type AppServiceFactories = {
  createCoordinator: typeof createDataResetCoordinator;
  createCollection: typeof createCollectionService;
  createDiscovery: typeof createDiscoveryService;
  createProviderFetcher: () => DiscoveryProviderFetcher;
  createProviderGovernor: typeof createProviderRequestGovernor;
  createLibraryIntegration: CreateLibraryIntegration;
  /** The library's file store for a restore's sweep; `undefined` where it cannot be built. */
  createLibraryFiles: () => (
    Pick<LibraryFileStore, 'deleteUnnamedFiles'>
    & Partial<Pick<LibraryFileStore, 'originalUriFor'>>
  ) | undefined;
  disconnectCloudLibrary: () => Promise<void>;
};

export function createAppServiceBundle(
  resources: AppServiceResources,
  factories: Partial<AppServiceFactories> = {},
): AppServiceBundle {
  const createCoordinator = factories.createCoordinator ?? createDataResetCoordinator;
  const createCollection = factories.createCollection ?? createCollectionService;
  const createDiscovery = factories.createDiscovery ?? createDiscoveryService;
  const createProviderGovernor = factories.createProviderGovernor
    ?? createProviderRequestGovernor;
  const createLibrary = factories.createLibraryIntegration
    ?? createLibraryIntegration;
  const createLibraryFiles = factories.createLibraryFiles ?? (() => {
    try {
      return createExpoLibraryFileStore();
    } catch {
      return undefined;
    }
  });
  const disconnectCloudLibrary = factories.disconnectCloudLibrary ?? disconnectDevice;
  const resetCoordinator = createCoordinator();
  const providerRequestGovernor = createProviderGovernor();
  // G4 — the live credential ref for this bundle. The map was resolved before
  // construction (same async→sync seam as byos); save/clear persist through the
  // store and refresh this ref from the write's own return. Both are optional so
  // a bare test bundle composes with an empty map over a fresh store.
  const providerCredentialStore = resources.providerCredentialStore
    ?? createProviderCredentialStore();
  let providerCredentialMap: ProviderCredentialMap =
    resources.providerCredentialMap ?? {};
  const providerCredentials: ProviderCredentialService = {
    snapshot: () => providerCredentialMap,
    async save(key, credential) {
      // Refresh the live ref straight from the write's own return: the map is
      // computed inside the store's serialized block, so concurrent saves can't
      // leave the ref pointing at a stale snapshot (no separate load() race).
      providerCredentialMap = await providerCredentialStore.save(key, credential);
    },
    async clear(key) {
      providerCredentialMap = await providerCredentialStore.clear(key);
    },
  };
  const createProviderFetcher = factories.createProviderFetcher ?? (() => {
    const e2eRuntime = configuredE2eRuntimeConfig();
    return e2eRuntime === null
      ? createDiscoveryProviderFetcher({
        governor: providerRequestGovernor,
        // Function accessor, not the current map: the fetcher reads the live
        // ref on each refill, so a key saved mid-session is picked up without
        // rebuilding the fetcher (G4 spec §2.2).
        credentials: () => providerCredentialMap,
      })
      : createFixtureDiscoveryFetcher(e2eRuntime);
  });
  const backupService = createAppBackupService({
    database: resources.database,
    settingsRepository: resources.settingsRepository,
    fileRepository: resources.fileRepository,
    libraryFiles: createLibraryFiles(),
    ...(WaifuSyncService === null ? {} : {
      copyArchivedFile: WaifuSyncService.copyBackupFile,
      ...(typeof WaifuSyncService.copyBackupImportFile === 'function'
        ? { copyArchivedImportFile: WaifuSyncService.copyBackupImportFile }
        : {}),
    }),
  });
  // Board row 52: collection and discovery read the library through this
  // holder, not a const captured when the bundle was built. A recovery rebind
  // swaps `current`, so the next save, purge, reset, and resume hit the vault
  // controller. Copying fields onto the returned bundle is not enough — those
  // closures would keep calling the local controller.
  const libraryHolder: { current: LibraryIntegration | undefined } = { current: undefined };
  const currentLibrary = (): LibraryIntegration => {
    const library = libraryHolder.current;
    if (library === undefined) {
      throw new Error('Library integration is not composed.');
    }
    return library;
  };
  // K6-5 C / board row 52: one resume sequence, shared by the collection's
  // startup sweep and by a recovery rebind. The rebind runs it on the vault
  // controller; otherwise saves made while the phone was offline wait for the
  // next cold start to be backfilled.
  const libraryResumes = new Set<Promise<void>>();
  let libraryResumeClosed = false;
  const runLibraryResume = async (): Promise<void> => {
    const controller = currentLibrary().libraryController;
    await controller?.purgeUndoneLibraryRows().catch(() => undefined);
    // Board #27 (spec §5.2b): flag every library original that vanished
    // before the backfill reads the rows.
    await controller?.noteMissingOriginals().catch(() => undefined);
    await controller?.reingestMissingLibraryRows().catch(() => undefined);
    // N10 T2: the backfill may have created or repaired rows this pass, and
    // the missing-original pass above has already flagged vanished files — so
    // the re-protect only ever selects bytes that are really here.
    await controller?.reprotectUncommittedOriginals().catch(() => undefined);
    // Board #27 (spec §5.5): the migration, last — the recovery, the
    // missing-original pass and the backfill have read the rows first.
    await controller?.handOverExisting().catch(() => undefined);
    // Board #27 S2 (R24): a decrypted file whose row a 删除全部应用数据 deleted.
    await controller?.sweepCacheOrphans().catch(() => undefined);
  };
  // The original and rebound objects share this one-way boundary. A running
  // collection sweep can still call its detached callback during teardown;
  // closing admission makes that late callback inert on their shared handle.
  // Session registration is not part of this set.
  const resumeLibrary = (): Promise<void> => {
    if (libraryResumeClosed) return Promise.resolve();
    const resume = runLibraryResume().catch(() => undefined);
    libraryResumes.add(resume);
    const remove = () => libraryResumes.delete(resume);
    void resume.then(remove);
    return resume;
  };
  const closeLibraryResume = async (): Promise<void> => {
    libraryResumeClosed = true;
    // Even an empty first snapshot yields: an admitted invocation can enter
    // close through a synchronous pass seam before its promise is registered.
    do {
      await Promise.all([...libraryResumes]);
    } while (libraryResumes.size > 0);
  };
  // K6-5 B: the two halves of a save need each other — the library's foreground
  // guard needs the collection's download count, and the collection needs the
  // library's ingest seam. The collection is built first and reaches the library
  // through deferred closures, the same shape `library-integration-impl` already
  // uses for `integration` (the holder is filled before any of these closures
  // can run: the first is a completed download, the second a resume).
  const collectionService = createCollection({
    repository: resources.imageRepository,
    files: resources.fileRepository,
    settings: resources.settingsRepository,
    coordinator: resetCoordinator,
    onOriginalReady: (event) => {
      currentLibrary().libraryController?.onCollectedOriginalReady(event);
    },
    // Board #27 (spec §5.4): 收藏 delete and 回到发现 free this phone's copy.
    // Fire-and-forget: the row has already left, and the resume sweep finishes
    // the job if the app dies first.
    onSavedRowRemoved: (imageId) => {
      void currentLibrary().libraryController?.purgeCollectedImage(imageId).catch(() => undefined);
    },
    libraryBytes: () => currentLibrary().libraryController?.deviceLibraryBytes() ?? Promise.resolve(0),
    libraryReset: async () => {
      const controller = currentLibrary().libraryController;
      if (!controller) {
        return {
          async finish() {
            return {
              rows: 'deleted' as const,
              failedFiles: [],
              cloud: 'skipped' as const,
              disconnected: false,
              error: null,
            };
          },
          abandon() {},
        };
      }
      const session = await controller.beginReset();
      let finishing = false;
      let abandoned = false;
      return {
        async finish() {
          finishing = true;
          let disconnected = false;
          try {
            let failedFiles: readonly string[];
            try {
              ({ failed: failedFiles } = await session.clearDevice());
            } catch (error) {
              return {
                rows: 'failed' as const,
                failedFiles: [],
                cloud: 'skipped' as const,
                disconnected,
                error,
              };
            }
            try {
              await disconnectCloudLibrary();
              disconnected = true;
              // Only after the disconnect: a still-bound phone that forgot its
              // library would re-materialize all of it.
              await session.forgetCloudLibraries();
              return {
                rows: 'deleted' as const,
                failedFiles,
                cloud: 'deleted' as const,
                disconnected,
                error: null,
              };
            } catch (error) {
              return {
                rows: 'deleted' as const,
                failedFiles,
                cloud: 'failed' as const,
                disconnected,
                error,
              };
            }
          } finally {
            session.end({ retire: disconnected });
          }
        },
        abandon() {
          if (finishing || abandoned) return;
          abandoned = true;
          session.end({ retire: false });
        },
      };
    },
    // N10 T1: the sweep's one query for 「需修复」 rows — mirrored rows whose
    // original bytes exist on neither this phone nor the bucket — answered by
    // the CURRENT library integration the same way every other deferred
    // closure here reaches it; `[]` when none is composed.
    listMirrorDeadSavedImageIds: async () => (
      (await currentLibrary().libraryController?.listMirrorDeadSavedImageIds()) ?? []
    ),
    // K6-5 C: the startup/resume sweep is already walking the collection, so it
    // is where the library picks up the saves whose ingest threw and left a
    // blank tile behind. Board #24 (spec §5.4.5): first it finishes any rewind
    // whose library purge never ran, THEN the backfill, so one pass also gives
    // a still-saved image with the same bytes its library copy back.
    onCollectionResumed: () => {
      void resumeLibrary();
    },
  });
  // The category is fixed at composition. A rebind passes the same value with
  // the verdict's `byos`; only a ready context changes.
  const localUnavailableCategory = localUnavailableCategoryFor(resources.byosStatus);
  const composeLibrary = (byos: ByosResolvedContext | null) => createLibrary({
    database: resources.database,
    byos,
    // C3b: the same repository the collection reads from, so an asset another
    // device collected is rebuilt as an ordinary `images` row on this one
    // rather than staying on the cloud-only tile path.
    images: resources.imageRepository,
    // Board #27 S1b (spec §5.5): the library hands a saved image's collection
    // file over once it holds the original, so it needs the file port.
    collectionFiles: resources.fileRepository,
    subscribeActiveDownloads: collectionService.subscribeActiveDownloads,
    localUnavailableCategory,
  });
  libraryHolder.current = composeLibrary(resources.byos ?? null);
  function librarySurface(integration: LibraryIntegration) {
    return {
      libraryController: integration.libraryController,
      libraryActions: integration.libraryActions,
      librarySync: integration.librarySync,
      libraryView: integration.libraryView,
      libraryCache: integration.libraryCache,
      librarySyncTrigger: integration.librarySyncTrigger,
      libraryBackgroundSync: integration.libraryBackgroundSync,
      libraryChanges: integration.libraryChanges,
      libraryDispose: integration.libraryDispose,
      libraryStorageMode: integration.libraryStorageMode ?? null,
    };
  }
  function rebindLibrary(
    bundle: AppServiceBundle,
    verdict: Extract<ByosStatus, { status: 'ready' }>,
  ): AppServiceBundle {
    // A cloud integration already owns the foreground guard and the
    // background-round slot. Rebinding it would leave that guard beside the
    // new one. Recovery only replaces the local core a network lock composed,
    // and that core has nothing to dispose.
    if (currentLibrary().libraryDispose !== undefined) {
      throw new Error('Recovery rebind only replaces a local library.');
    }
    const previous = currentLibrary();
    const next = composeLibrary(verdict.context);
    // createLibraryIntegration answers a construction failure with the local
    // core. Publishing that as ready would end recovery on a library that
    // cannot reach the vault, so the provider takes the full reload instead.
    if (next.libraryDispose === undefined) {
      throw new Error('Recovery rebind requires a vault library.');
    }
    if (
      next.libraryController == null
      || next.libraryActions == null
      || next.libraryView == null
    ) {
      throw new Error('Recovery rebind requires a vault library.');
    }
    libraryHolder.current = next;
    return {
      ...bundle,
      ...byosResourcesFor(verdict),
      ...librarySurface(next),
      revertRebind: () => {
        if (libraryHolder.current === next) libraryHolder.current = previous;
      },
    };
  }
  const discoveryService = createDiscovery({
    repository: resources.imageRepository,
    collection: collectionService,
    coordinator: resetCoordinator,
    fetchBatch: createProviderFetcher(),
    // Board #24 (spec §5.4.2): a rewound save also leaves this device's library.
    library: {
      purgeCollectedImage: (imageId) => (
        currentLibrary().libraryController?.purgeCollectedImage(imageId)
        ?? Promise.resolve()
      ),
    },
  });
  const managedPreviewCache = createManagedPreviewCache();

  return {
    ...resources,
    backupService,
    byosStatus: resources.byosStatus ?? UNCONFIGURED_BYOS,
    ...librarySurface(currentLibrary()),
    rebindLibrary,
    resumeLibrary,
    closeLibraryResume,
    resetCoordinator,
    collectionService,
    discoveryService,
    managedPreviewCache,
    providerRequestGovernor,
    providerCredentials,
  };
}

export async function restoreAppServiceState(
  services: Pick<AppServiceBundle, 'collectionService' | 'discoveryService'>,
): Promise<{ collectionRecovery: Promise<boolean> }> {
  await services.discoveryService.restore();
  return {
    // K7 ㉕: true when the sweep changed a row (a repair download ran) — the
    // only case in which the collection snapshot the screens hold is stale.
    // A refused sweep resolves true so a real change is never hidden.
    collectionRecovery: services.collectionService
      .resumePendingDownloads()
      .then((results) => results.length > 0, () => true),
  };
}

export async function initializeAppServices(
  openDatabase: () => Promise<AppDatabaseConnection> = openAppDatabaseConnection,
): Promise<AppServiceBundle> {
  await sweepBackupArtifactsAtStartup();
  await sweepLibraryStreamAtStartup();
  const connection = await openDatabase();
  try {
    await sanitizeImageDatabaseForDistribution(connection.database);
    const settingsRepository = createSettingsRepository();
    const initialSettings = await settingsRepository.load();
    await applyLanguagePreference(initialSettings.language);
    // Resolved before bundle construction: createAppServiceBundle stays
    // synchronous, and this is the only async seam initializeAppServices has
    // for it. The whole verdict travels with the context so a locked vault
    // reaches the UI as locked rather than as "not configured" (D3).
    const byosStatus = await resolveByosStatusDefault();
    // G4 — loaded here (same async seam as byosStatus) and handed to the sync
    // bundle build, which holds it in a live ref. save/clear refresh it so a
    // new key takes effect on the next refill without an app reload (spec §2.2).
    const providerCredentialStore = createProviderCredentialStore();
    const providerCredentialMap = await providerCredentialStore.load();
    const resources: AppServiceResources = {
      database: connection.database,
      settingsRepository,
      imageRepository: createImageRepository(connection.database),
      fileRepository: createExpoFileRepository(),
      initialSettings,
      ...byosResourcesFor(byosStatus),
      providerCredentialStore,
      providerCredentialMap,
    };
    const bundle = createAppServiceBundle(resources);
    const { collectionRecovery } = await restoreAppServiceState(bundle);
    return {
      ...bundle,
      startupRecovery: collectionRecovery,
      closeDatabase: connection.close,
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryWaifu,
        retryDelay: waifuRetryDelay,
      },
      mutations: { retry: false },
    },
  });
}

export async function persistAppSettings(
  repository: SettingsRepository,
  discovery: DiscoveryService,
  value: unknown,
  publish: (settings: AppSettings) => void,
  recordPersisted: (settings: AppSettings) => void = () => undefined,
  previous?: AppSettings,
): Promise<AppSettings> {
  const candidate = normalizeSettings(value);
  if (previous === undefined || settingsAffectDiscovery(previous, candidate)) {
    await discovery.invalidateQueuedCandidates(candidate);
  }
  const settings = await repository.save(candidate);
  await applyLanguagePreference(settings.language);
  recordPersisted(settings);
  publish(settings);
  return settings;
}

export type ResetOwnedAppDataInput = {
  settingsRepository?: SettingsRepository;
  fileRepository?: CollectionFileRepository;
  libraryFiles?: Pick<LibraryFileStore, 'deleteAllDeviceFiles'>;
  resetDatabase?: () => Promise<void>;
};

function libraryFilesForReset(): Pick<LibraryFileStore, 'deleteAllDeviceFiles'> {
  try {
    return createExpoLibraryFileStore();
  } catch {
    return { deleteAllDeviceFiles: () => Promise.resolve([]) };
  }
}

export async function resetOwnedAppData({
  settingsRepository = createSettingsRepository(),
  fileRepository = createExpoFileRepository(),
  libraryFiles = libraryFilesForReset(),
  resetDatabase = resetAppDatabase,
}: ResetOwnedAppDataInput = {}): Promise<void> {
  const [settingsResult, filesResult, libraryResult, backupResult] = await Promise.allSettled([
    settingsRepository.reset(),
    fileRepository.deleteAll(),
    libraryFiles.deleteAllDeviceFiles(),
    sweepBackupArtifacts(),
  ]);
  await resetDatabase();

  const failures: unknown[] = [];
  if (settingsResult.status === 'rejected') failures.push(settingsResult.reason);
  if (filesResult.status === 'rejected') failures.push(filesResult.reason);
  if (filesResult.status === 'fulfilled' && filesResult.value.failed.length > 0) {
    failures.push(new Error('Some private collection files could not be deleted.'));
  }
  if (
    libraryResult.status === 'rejected'
    || (libraryResult.status === 'fulfilled' && libraryResult.value.length > 0)
  ) {
    failures.push(new Error('Some private library files could not be deleted.'));
  }
  if (backupResult.status === 'rejected') failures.push(backupResult.reason);
  if (backupResult.status === 'fulfilled' && backupResult.value.failed.length > 0) {
    failures.push(new Error('Some backup files could not be deleted.'));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'App-owned data could not be completely reset.');
  }
}

export type AppSettingsUpdater = (current: AppSettings) => unknown;

export type UpdateAppSettings = {
  (updater: AppSettingsUpdater): Promise<AppSettings>;
  (value: unknown): Promise<AppSettings>;
};

function createSettingsOperationBarrier() {
  let persisted: AppSettings | null = null;
  let tail = Promise.resolve();
  let resetPending = false;
  const enqueue = <T,>(operation: () => Promise<T>) => {
    const queued = tail.then(operation, operation);
    tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };
  return {
    getPersisted: () => persisted,
    setPersisted: (settings: AppSettings) => {
      persisted = settings;
    },
    enqueueSettings: <T,>(operation: () => Promise<T>) => {
      if (resetPending) {
        return Promise.reject(new Error('App data reset is in progress'));
      }
      return enqueue(operation);
    },
    enqueueReset: <T,>(operation: () => Promise<T>) => {
      if (resetPending) {
        return Promise.reject(new Error('App data reset is already in progress'));
      }
      resetPending = true;
      return enqueue(async () => {
        try {
          return await operation();
        } finally {
          resetPending = false;
        }
      });
    },
  };
}

export type AppServicesContextValue = Omit<AppServiceBundle, 'initialSettings'> & {
  settings: AppSettings;
  dataRevision: number;
  updateSettings: UpdateAppSettings;
  resetDismissedHistory(): Promise<number>;
  resetDiscoveryHistory(): Promise<number>;
  deleteAllAppData(): Promise<DeleteAllAppDataResult>;
  createFullBackup(): Promise<BackupSummary>;
  restoreFullBackup(): Promise<RestoreSummary | null>;
  /**
   * Close the live bundle and build a new one, so a BYOS change written to
   * SecureStore takes effect (the fresh `initializeAppServices` re-runs the
   * resolver). Callers persist their final state first — this reads storage,
   * it does not take a payload.
   */
  reloadAppServices(): void;
};

export type DeleteAllAppDataResult = DeleteAllDataResult & Readonly<{
  recomposed: boolean;
}>;

const AppServicesContext = createContext<AppServicesContextValue | null>(null);

export function AppServicesContextProvider({
  value,
  children,
}: {
  value: AppServicesContextValue;
  children: React.ReactNode;
}) {
  return <AppServicesContext value={value}>{children}</AppServicesContext>;
}

export function useAppServices(): AppServicesContextValue {
  const services = use(AppServicesContext);
  if (services === null) throw new Error('App services are not ready');
  return services;
}

export function useAppSettings() {
  const { settings, updateSettings } = useAppServices();
  return { settings, updateSettings };
}

function diagnosticsFor(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function mergeFailure(
  current: unknown | null,
  next: unknown,
  message: string,
): unknown {
  return current === null
    ? next
    : new AggregateError([current, next], message);
}

function mergeFileDeleteResults(
  current: FileDeleteAllResult,
  next: FileDeleteAllResult,
): FileDeleteAllResult {
  const failed = [...new Map(
    [...current.failed, ...next.failed].map((failure) => [failure.uri, failure]),
  ).values()];
  const failedUris = new Set(failed.map((failure) => failure.uri));
  return {
    deleted: [...new Set([...current.deleted, ...next.deleted])]
      .filter((uri) => !failedUris.has(uri)),
    failed,
  };
}

function includeBackupSweep(
  result: DeleteAllDataResult,
  backupFiles: FileDeleteAllResult,
): DeleteAllDataResult {
  const files = mergeFileDeleteResults(result.files, backupFiles);
  const remaining = files.failed.length > 0
    ? [...new Set([...result.remaining, 'files' as const])]
    : result.remaining;
  return {
    ...result,
    ok: remaining.length === 0,
    files,
    remaining,
  };
}

function failedBackupSweep(error: unknown): FileDeleteAllResult {
  return {
    deleted: [],
    failed: [{
      uri: 'backup-artifacts',
      error: {
        code: 'delete_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }],
  };
}

function RecoveryState({
  error,
  onReset,
}: {
  error: unknown;
  onReset: () => void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  return (
    <View style={{ flex: 1, backgroundColor: theme.surface }}>
      <ScreenState
        kind="error"
        title={t('startup.databaseTitle')}
        message={t('startup.databaseMessage')}
        command={{
          label: t('startup.reset'),
          onPress: onReset,
          destructive: true,
        }}
      />
      <Text
        selectable
        aria-label={t('startup.diagnostics')}
        style={{
          padding: metrics.contentPadding,
          color: theme.textSecondary,
          backgroundColor: theme.surfaceSecondary,
          fontSize: 12,
        }}>
        {diagnosticsFor(error)}
      </Text>
    </View>
  );
}

type StartupState =
  | { status: 'loading' }
  | { status: 'ready'; bundle: AppServiceBundle }
  | { status: 'error'; error: unknown };

// Review finding 1: Android can report connectivity before DNS is usable.
const RECOVERY_RETRY_DELAYS_MS = [3_000, 10_000] as const;

function isVaultNetworkLock(status: ByosStatus): boolean {
  return status.status === 'locked'
    && status.reason === 'vault_unreachable'
    && status.detail === 'network';
}

function recoveryBundleState(state: StartupState): RecoveryBundleState {
  if (state.status !== 'ready') return 'not-ready';
  return isVaultNetworkLock(state.bundle.byosStatus) ? 'network-locked' : 'ready';
}

function classifyRecoveryVerdict(verdict: ByosStatus): RecoveryVerdictKind {
  if (isVaultNetworkLock(verdict)) return 'network-lock';
  if (verdict.status === 'ready') return 'ready';
  return 'other';
}

// Restore the previous holder before releasing an unpublished composition,
// so collection/discovery callbacks cannot reach its disposed controller.
// The database stays with the closer.
function releaseUnpublishedLibrary(bundle: AppServiceBundle): void {
  bundle.revertRebind?.();
  try {
    bundle.librarySyncTrigger?.dispose();
  } catch {
    // The database closer still owns the handle.
  }
  try {
    setLibraryBackgroundRound(null);
  } catch {
    // The slot clear is best-effort; the guard still has to go.
  }
  try {
    bundle.libraryDispose?.();
  } catch {
    // Same as the closer: one release step must not skip the next.
  }
}

/**
 * K4 §4.7: a ready bundle either has a bound account (start the trigger's
 * session-ready cycle and register the background task) or it doesn't (make
 * sure the background task is not registered against a session-less
 * composition). Startup and a recovery rebind share this so the rebound
 * session is the one that actually starts.
 */
async function runBundleSessionReady(
  bundle: AppServiceBundle,
  cancelled: () => boolean,
): Promise<void> {
  if (cancelled()) return;
  const scope = await bundle.libraryActions?.getAccountScope() ?? null;
  if (cancelled()) return;
  const background = bundle.libraryBackgroundSync;
  if (scope !== null) {
    bundle.librarySyncTrigger?.onSessionReady();
    await background?.ensureRegistered();
  } else {
    await background?.ensureUnregistered();
  }
}
export function createAppServiceBundleCloser() {
  const closingBundles = new WeakMap<AppServiceBundle, Promise<void>>();
  return (bundle: AppServiceBundle): Promise<void> => {
    const existing = closingBundles.get(bundle);
    if (existing) return existing;
    const operation = Promise.resolve().then(async () => {
      let failure: unknown = null;
      try {
        bundle.librarySyncTrigger?.dispose();
        // K4 §4.7: a torn-down bundle must not leave a stale round behind for
        // the next background wakeup to run against a closed session.
        setLibraryBackgroundRound(null);
      } catch (error) {
        failure = error;
      }
      try {
        bundle.libraryDispose?.();
      } catch (error) {
        failure = mergeFailure(failure, error, 'App services could not close completely.');
      }
      // Refuse late callbacks, then finish admitted passes on the open handle.
      // None of these passes awaits this closer or its disposal.
      await bundle.closeLibraryResume();
      try {
        await bundle.closeDatabase?.();
      } catch (error) {
        failure = mergeFailure(failure, error, 'App services could not close completely.');
      }
      if (failure !== null) throw failure;
    });
    let tracked: Promise<void>;
    tracked = operation.catch((error) => {
      if (closingBundles.get(bundle) === tracked) {
        closingBundles.delete(bundle);
      }
      throw error;
    });
    closingBundles.set(bundle, tracked);
    return tracked;
  };
}

export function AppServicesProvider({
  children,
  initializer = initializeAppServices,
  resetter = resetOwnedAppData,
  resolveByosStatus = resolveByosStatusDefault,
}: {
  children: React.ReactNode;
  initializer?: () => Promise<AppServiceBundle>;
  resetter?: () => Promise<void>;
  /**
   * Board row 52: recovery re-resolves the open vault through this. Tests
   * answer it; production uses `resolveByosStatus`.
   */
  resolveByosStatus?: () => Promise<ByosStatus>;
}) {
  const queryClient = useQueryClient();
  const { t } = useAppTranslation();
  const [attempt, setAttempt] = useState(0);
  const [startup, setStartup] = useState<StartupState>({ status: 'loading' });
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [dataRevision, setDataRevision] = useState(0);
  const [settingsOperations] = useState(createSettingsOperationBarrier);
  const [closeBundle] = useState(createAppServiceBundleCloser);
  // Board #27 S1b: which mounted screens republish a handed-over row themselves.
  const [handedOverPublishers] = useState(createHandedOverPublishers);
  // Holds the in-flight close of the bundle the previous init-effect opened.
  // The next run awaits it before reopening so the new database handle is only
  // acquired after the superseded one is released (D2 — no WAL contention).
  const closePromiseRef = useRef<Promise<void> | null>(null);
  // The bundle the tree is rendering. A recovery rebind replaces it without
  // bumping `attempt`, so the start-up effect's cleanup must close this
  // object — the one that owns the vault integration — and not the local
  // bundle the effect originally opened.
  const currentBundleRef = useRef<AppServiceBundle | null>(null);
  const startupRef = useRef<StartupState>(startup);
  const mountedRef = useRef(true);
  const controllerRef = useRef<LibraryRecoveryController | null>(null);
  const resolveByosStatusRef = useRef(resolveByosStatus);
  const onReadyRef = useRef<(
    verdict: ByosStatus, isCurrent: () => boolean,
  ) => boolean>(() => true);
  const onFullReloadRef = useRef<() => void>(() => undefined);

  const recoveryController = useCallback(() => {
    const existing = controllerRef.current;
    if (existing !== null && !existing.disposed) return existing;
    const created = createLibraryRecoveryController({
      resolve: () => resolveByosStatusRef.current(),
      classify: classifyRecoveryVerdict,
      onReady: (verdict, isCurrent) => onReadyRef.current(verdict, isCurrent),
      onFullReload: () => onFullReloadRef.current(),
      delays: RECOVERY_RETRY_DELAYS_MS,
    });
    controllerRef.current = created;
    return created;
  }, []);

  const noteStartup = useCallback((next: StartupState) => {
    startupRef.current = next;
    setStartup(next);
    recoveryController().bundleChanged(recoveryBundleState(next));
  }, [recoveryController]);

  // Publication itself sets both refs. Its session tail remains valid only
  // while this exact bundle is the mounted ready bundle, including during a
  // restore's loading window before the startup effect cleans up the handle.
  const isPublishedReady = useCallback((bundle: AppServiceBundle): boolean => (
    mountedRef.current
    && currentBundleRef.current === bundle
    && startupRef.current.status === 'ready'
    && startupRef.current.bundle === bundle
  ), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let opened: AppServiceBundle | null = null;

    // Wait for the bundle the previous run opened to finish closing before the
    // initializer opens a fresh handle on the same database. On the first-ever
    // run the ref is null, so this resolves immediately and never deadlocks;
    // the guard swallows a prior close failure so a reopen is never blocked.
    const previousClose = closePromiseRef.current ?? Promise.resolve();
    void previousClose
      .catch(() => undefined)
      .then(() => {
        if (disposed) return;
        return initializer().then((bundle) => {
          opened = bundle;
          if (disposed) return closeBundle(bundle);
          currentBundleRef.current = bundle;
          if (bundle.startupRecovery) {
            void (async () => {
              const repaired = await bundle.startupRecovery?.catch(() => true);
              // K7 ㉕: nothing repaired means no row changed since the DB was
              // opened: no second full read, no app-wide revision cascade.
              // (`onCollectionResumed` still ran its library backfill; the
              // grid learns of those writes through `libraryChanges`.) The
              // Collection tab reads its own snapshot on first mount.
              if (disposed || !repaired) return;
              await publishCollectionSnapshot(
                queryClient,
                bundle.imageRepository,
              ).catch(() => undefined);
              if (!disposed) setDataRevision((revision) => revision + 1);
            })();
          }
          settingsOperations.setPersisted(bundle.initialSettings);
          setSettings(bundle.initialSettings);
          noteStartup({ status: 'ready', bundle });
          void runBundleSessionReady(bundle, () => disposed || !isPublishedReady(bundle))
            .catch(() => undefined);
        });
      })
      .catch((error) => {
        if (!disposed) noteStartup({ status: 'error', error });
      });

    return () => {
      disposed = true;
      // Close the bundle recovery published, not the local one this effect
      // opened. Closing `opened` would release nothing the vault integration
      // subscribed and leave its guard and background round running.
      const bundleToClose = currentBundleRef.current;
      if (opened && bundleToClose) {
        // Record this close so the next run serializes its reopen behind it.
        closePromiseRef.current = closeBundle(bundleToClose).catch(() => undefined);
        if (currentBundleRef.current === bundleToClose) currentBundleRef.current = null;
      }
    };
  }, [attempt, closeBundle, initializer, isPublishedReady, noteStartup, queryClient, settingsOperations]);

  const reloadAppServices = useCallback(() => {
    // Full reload for a manual reload, and for a recovery verdict that cannot
    // be rebound: another lock, a rejected resolve, or a refused rebind.
    // Bumping `attempt` re-runs the start-up effect, whose cleanup closes the
    // current bundle before the new initializer runs. A network lock keeps
    // the open bundle. A real vault composition is published by
    // `rebindLibrary`. Loading is not a hold: an edge while the new bundle is
    // still opening is remembered by the controller.
    noteStartup({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, [noteStartup]);

  useEffect(() => {
    resolveByosStatusRef.current = resolveByosStatus;
  }, [resolveByosStatus]);

  // Board row 52: a network return and its retries re-resolve the vault
  // against the open bundle. Reloading here is what unmounted the navigator and
  // sent the user back to 发现. The controller owns the flight and the retries. A
  // library composed for a verdict that is not published is released the way a
  // close would release it, without closing the database the reload still owns.
  useEffect(() => {
    onFullReloadRef.current = () => {
      reloadAppServices();
    };
    onReadyRef.current = (verdict, isCurrent) => {
      if (verdict.status !== 'ready') return false;
      const bundleAtStart = currentBundleRef.current;
      if (
        !mountedRef.current
        || startupRef.current.status !== 'ready'
        || bundleAtStart === null
      ) {
        return true;
      }
      let rebound: AppServiceBundle | null = null;
      let published = false;
      try {
        try {
          rebound = bundleAtStart.rebindLibrary(bundleAtStart, verdict);
        } catch {
          return false;
        }
        // Synchronous reentry through the factory can take a hold or reload.
        // Only the current verdict may publish on the still-ready handle.
        if (!isCurrent() || !isPublishedReady(bundleAtStart)) {
          return false;
        }
        published = true;
        currentBundleRef.current = rebound;
        const publishedBundle = rebound;
        noteStartup({ status: 'ready', bundle: publishedBundle });
        void (async () => {
          const cancelled = () => !isPublishedReady(publishedBundle);
          try {
            await runBundleSessionReady(publishedBundle, cancelled);
          } catch {
            // The startup path swallows a session-ready failure too.
          }
          if (cancelled()) return;
          // Track the entire resume chain so picking/preparing and reset wait
          // for its database work. Native registration stays outside the mutation.
          await publishedBundle.resetCoordinator.runMutation(async () => {
            if (!isPublishedReady(publishedBundle)) return;
            await publishedBundle.resumeLibrary();
          }).catch(() => undefined);
        })();
        return true;
      } finally {
        if (rebound !== null && !published) {
          releaseUnpublishedLibrary(rebound);
        }
      }
    };
  }, [isPublishedReady, noteStartup, reloadAppServices]);

  // One network listener for the provider's lifetime. It is not stopped when
  // startup leaves `ready`, and nothing re-arms it: the controller remembers
  // an edge while a hold is up or while no bundle is ready.
  useEffect(() => {
    const controller = recoveryController();
    const recovery = createExpoLibraryNetworkRecovery();
    const unsubscribe = recovery.subscribe(() => {
      controller.networkEdge();
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [recoveryController]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (settings?.language === 'system') {
        void applyLanguagePreference('system');
      }
      if (startup.status === 'ready') {
        startup.bundle.librarySyncTrigger?.onAppStateChange(state);
      }
    });
    return () => subscription.remove();
  }, [settings?.language, startup]);

  // A network blip while the app sits in the foreground used to strand pending
  // uploads: no save, no foreground transition, and (since the residue timer
  // was removed) nothing re-drove sync. Connectivity returning is the real
  // event the trigger comment always named; subscribe to it here, next to the
  // AppState subscription it mirrors.
  useEffect(() => {
    if (startup.status !== 'ready') return undefined;
    const trigger = startup.bundle.librarySyncTrigger;
    if (trigger == null) return undefined;
    const recovery = createExpoLibraryNetworkRecovery();
    return recovery.subscribe(() => trigger.onNetworkReturn());
  }, [startup]);

  // Board #27 S1b (spec §5.5): a row the library just took over turns
  // `mirrored`; the cached snapshot must learn it even when 收藏 was never
  // opened (the migration runs at startup) or only Discover/Search is showing.
  // While 收藏 or the viewer is mounted it publishes after its own entries
  // read, and this stays out of its way. (A React Query observer count would
  // not do: Search observes the collection and re-reads no entries.)
  useEffect(() => {
    if (startup.status !== 'ready') return undefined;
    const { libraryChanges, imageRepository } = startup.bundle;
    if (libraryChanges == null) return undefined;
    return libraryChanges.subscribe((change) => {
      if (change.kind !== 'handed-over' || change.imageId === undefined) return;
      if (handedOverPublishers.count() > 0) return;
      void publishCollectionRow(queryClient, imageRepository, change.imageId)
        .catch(() => undefined);
    });
  }, [handedOverPublishers, queryClient, startup]);

  const updateSettings = useCallback<UpdateAppSettings>((value: unknown) => {
    const run = async () => {
      if (startup.status !== 'ready') throw new Error('App services are not ready');
      const current = settingsOperations.getPersisted() ?? startup.bundle.initialSettings;
      const resolved = typeof value === 'function'
        ? (value as AppSettingsUpdater)(current)
        : value;
      const candidate = typeof value === 'function'
        && resolved !== null
        && typeof resolved === 'object'
        && !Array.isArray(resolved)
        ? { ...current, ...resolved }
        : resolved;
      return persistAppSettings(
        startup.bundle.settingsRepository,
        startup.bundle.discoveryService,
        candidate,
        (nextSettings) => {
          setSettings(nextSettings);
        },
        (nextSettings) => {
          settingsOperations.setPersisted(nextSettings);
        },
        current,
      );
    };
    return settingsOperations.enqueueSettings(run);
  }, [settingsOperations, startup]);

  const deleteAllAppData = useCallback((): Promise<DeleteAllAppDataResult> => {
    if (startup.status !== 'ready') {
      return Promise.reject(new Error('App services are not ready'));
    }
    const release = recoveryController().beginHold();
    return settingsOperations.enqueueReset(async () => {
      const bundle = currentBundleRef.current ?? startup.bundle;
      let result: DeleteAllDataResult | null = null;
      const publishResult = async (completedResult: DeleteAllDataResult) => {
        try {
          if (completedResult.database.status === 'deleted') {
            await publishCollectionValue(queryClient, []);
          } else {
            await publishCollectionSnapshot(
              queryClient,
              bundle.imageRepository,
            ).catch(() => undefined);
          }
          if (completedResult.settings.status === 'deleted') {
            await applyLanguagePreference(DEFAULT_SETTINGS.language);
            settingsOperations.setPersisted(DEFAULT_SETTINGS);
            setSettings(DEFAULT_SETTINGS);
          }
        } finally {
          setDataRevision((revision) => revision + 1);
        }
      };
      try {
        result = await bundle.collectionService.deleteAllData();
        const backupFiles = await sweepBackupArtifacts().catch(failedBackupSweep);
        result = includeBackupSweep(result, backupFiles);
      } catch (error) {
        let failure: unknown = error;
        if (result !== null) {
          try {
            await publishResult(result);
          } catch (publishError) {
            failure = mergeFailure(
              failure,
              publishError,
              'Completed local deletion could not be published.',
            );
          }
        }
        throw failure;
      }
      const recomposed = result.library.disconnected && bundle.byosStatus.status !== 'unconfigured';
      try {
        await publishResult(result);
      } catch (error) {
        // The recompose re-reads the emptied database; a publish that failed
        // first must not cost it (S1a Task 6 drift, finding 3).
        if (!recomposed) throw error;
      } finally {
        if (recomposed) {
          // The recomposed services read the database the delete emptied (S1a Task 6).
          queryClient.clear();
          reloadAppServices();
        }
      }
      return { ...result, recomposed };
    }).finally(release);
  }, [queryClient, recoveryController, reloadAppServices, settingsOperations, startup]);

  const resetHistory = useCallback(async (
    kind: 'dismissed' | 'discovery',
  ): Promise<number> => {
    if (startup.status !== 'ready') throw new Error('App services are not ready');
    const lease = await startup.bundle.resetCoordinator.beginReset();
    let deleted = 0;
    let failure: unknown;
    try {
      deleted = kind === 'dismissed'
        ? await startup.bundle.imageRepository.resetDismissedHistory()
        : await startup.bundle.imageRepository.resetDiscoveryHistory();
    } catch (error) {
      failure = error;
    } finally {
      lease.release();
    }

    try {
      await startup.bundle.discoveryService.restore();
    } catch (error) {
      failure ??= error;
    } finally {
      setDataRevision((revision) => revision + 1);
    }
    if (failure !== undefined) throw failure;
    return deleted;
  }, [startup]);

  const resetDismissedHistory = useCallback(
    () => resetHistory('dismissed'),
    [resetHistory],
  );
  const resetDiscoveryHistory = useCallback(
    () => resetHistory('discovery'),
    [resetHistory],
  );

  const createFullBackup = useCallback((): Promise<BackupSummary> => {
    if (startup.status !== 'ready') {
      return Promise.reject(new Error('App services are not ready'));
    }
    return settingsOperations.enqueueReset(async () => {
      // Board #32: an export only reads. A reset lease would run the participants,
      // which empty the discovery deck while the screen keeps its cards, and every
      // later decision was dropped.
      const lease = await startup.bundle.resetCoordinator.beginExclusive();
      try {
        return await startup.bundle.backupService.createAndShare();
      } finally {
        lease.release();
      }
    });
  }, [settingsOperations, startup]);

  const applyPreparedRestore = useCallback(async (
    prepared: PreparedAppRestore,
    bundle: AppServiceBundle,
  ): Promise<RestoreSummary> => {
    const lease = await bundle.resetCoordinator.beginReset();
    let failure: unknown | null = null;
    let restoredSettings: AppSettings | null = null;
    let shouldReloadServices = false;
    let library: LibraryResetSession | null = null;
    try {
      noteStartup({ status: 'loading' });
      shouldReloadServices = true;
      // Spec R26: no ingest or purge may commit to the database file between
      // the replacement and the sweep of the files it no longer names.
      library = await bundle.libraryController?.beginReset() ?? null;
      await library?.settle();
      await bundle.closeDatabase?.();
      restoredSettings = await prepared.apply();
      queryClient.clear();
      await applyLanguagePreference(restoredSettings.language);
      settingsOperations.setPersisted(restoredSettings);
      setSettings(restoredSettings);
      setDataRevision((revision) => revision + 1);
    } catch (error) {
      failure = error;
    } finally {
      // The reload replaces the composition whatever happened: its trigger and
      // background round go before the sync lease is released (E-row 33).
      try {
        library?.end({ retire: true });
      } catch (error) {
        failure = mergeFailure(
          failure,
          error,
          'App restore library cleanup failed.',
        );
      }
      try {
        lease.release();
      } catch (error) {
        failure = mergeFailure(
          failure,
          error,
          'App restore reset lease cleanup failed.',
        );
      }
      try {
        await prepared.dispose();
      } catch (error) {
        failure = mergeFailure(
          failure,
          error,
          'App restore temporary files could not be removed.',
        );
      }
      if (shouldReloadServices) setAttempt((value) => value + 1);
    }
    if (failure !== null) throw failure;
    if (restoredSettings === null) {
      throw new Error('App restore returned no settings.');
    }
    return prepared.summary;
  }, [noteStartup, queryClient, settingsOperations]);

  const restoreFullBackup = useCallback((): Promise<RestoreSummary | null> => {
    if (startup.status !== 'ready') {
      return Promise.reject(new Error('App services are not ready'));
    }
    const release = recoveryController().beginHold();
    return settingsOperations.enqueueReset(async () => {
      const bundleAtPick = currentBundleRef.current ?? startup.bundle;
      // Board #32: picking and preparing change nothing, so they hold the
      // exclusive lease. The reset lease, whose participants empty in-memory
      // state such as the discovery deck, is taken only once there is a backup
      // to apply. A cancelled or failed pick leaves the deck and history intact.
      const hold = await bundleAtPick.resetCoordinator.beginExclusive();
      let prepared: PreparedAppRestore | null;
      try {
        prepared = await bundleAtPick.backupService.pickAndPrepareRestore();
      } finally {
        // No await between this release and applyPreparedRestore's beginReset():
        // a queued mutation resumes only in a later microtask, so the reset takes
        // the slot first. One that slipped in could sweep the restore-stage files.
        hold.release();
      }
      if (prepared === null) return null;
      // A verdict that finished before this hold replaced the bundle. Apply
      // against the one mounted now, not the handle captured before the picker.
      const bundle = currentBundleRef.current ?? bundleAtPick;
      return applyPreparedRestore(prepared, bundle);
    }).finally(release);
  }, [applyPreparedRestore, recoveryController, settingsOperations, startup]);

  const contextValue = useMemo<AppServicesContextValue | null>(() => {
    if (startup.status !== 'ready' || settings === null) return null;
    const { initialSettings: _initialSettings, ...services } = startup.bundle;
    return {
      ...services,
      settings,
      dataRevision,
      updateSettings,
      resetDismissedHistory,
      resetDiscoveryHistory,
      deleteAllAppData,
      createFullBackup,
      restoreFullBackup,
      reloadAppServices,
    };
  }, [
    dataRevision,
    createFullBackup,
    deleteAllAppData,
    reloadAppServices,
    resetDismissedHistory,
    resetDiscoveryHistory,
    settings,
    startup,
    restoreFullBackup,
    updateSettings,
  ]);

  const recover = useCallback(() => {
    // No hold. Loading and the error screen are not ready, so an edge in
    // either is remembered. The resetter runs inside this chain, including a
    // synchronous throw: the button handler must not throw out into the
    // release runtime.
    noteStartup({ status: 'loading' });
    void Promise.resolve()
      .then(() => resetter())
      .then(() => {
        // resetter() wiped the database; drop the cache before the next
        // composition, as the restore does (board #27 S1a Task 6).
        queryClient.clear();
        setAttempt((value) => value + 1);
      })
      .catch((error) => {
        noteStartup({ status: 'error', error });
      });
  }, [noteStartup, queryClient, resetter]);

  if (startup.status === 'error') {
    return <RecoveryState error={startup.error} onReset={recover} />;
  }
  // The recovery controller lives in a ref and is only read from callbacks.
  // eslint-disable-next-line react-hooks/refs
  if (contextValue === null) {
    return <ScreenState kind="loading" title={t('startup.preparing')} />;
  }
  return (
    <AppServicesContextProvider value={contextValue}>
      <HandedOverPublishersContext value={handedOverPublishers}>
        {children}
      </HandedOverPublishersContext>
    </AppServicesContextProvider>
  );
}
