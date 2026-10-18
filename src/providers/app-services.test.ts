// K4 T4: the background task factory reaches into `expo-background-task` /
// `expo-task-manager` through a lazy require; mocked wholesale so each test

import { DatabaseSync } from 'node:sqlite';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { migrateDatabase } from '@/db/schema';
import type { SqlBindValue, SqlDatabasePort } from '@/db/sql-port';
import {
  createAppBackupService,
  sweepBackupArtifacts,
  type BackupSummary,
} from '@/features/backup/backup-service';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type {
  createCollectionService,
  CollectionService,
  DeleteAllDataResult,
} from '@/features/collection/collection-service';
import type { CollectionFileRepository } from '@/features/collection/file-repository';
import { collectionQueryKey } from '@/features/collection/collection-query';
import { createLibraryChangeFeed } from '@/features/library/library-change-feed';
import {
  createDataResetCoordinator,
  type DataResetCoordinator,
} from '@/features/data-reset/data-reset-coordinator';
import type {
  createDiscoveryService,
  DiscoveryLibraryPort,
  DiscoveryService,
} from '@/features/discovery/discovery-service';
import {
  createImageRepository,
  type ImageRepository,
  type StoredImage,
} from '@/features/images/image-repository';
import type {
  ByosResolvedContext,
  LibraryIntegration,
} from '@/features/library/library-integration-types';
import type {
  DiscoveryProviderFetcher,
} from '@/features/providers/provider-client';
import { createProviderCredentialStore } from '@/features/providers/provider-credentials';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { SettingsRepository } from '@/features/settings/settings-repository';
import type { AppSettings, WaifuImage } from '@/features/waifu/types';
import { shouldRetryWaifu, waifuRetryDelay } from '@/features/waifu/query-policy';
import * as i18n from '@/i18n';
import {
  AppServicesProvider,
  byosResourcesFor,
  createAppServiceBundleCloser,
  createAppQueryClient,
  createAppServiceBundle,
  persistAppSettings,
  resetOwnedAppData,
  restoreAppServiceState,
  type AppServiceBundle,
  type DeleteAllAppDataResult,
  useAppServices,
  useAppSettings,
} from '@/providers/app-services';

import { useHandedOverPublisher } from '@/providers/handed-over-publishers';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

let mockWaifuSyncService: {
  copyBackupFile: jest.Mock<Promise<number>, [string, number, string]>;
  copyBackupImportFile?: jest.Mock<
    Promise<{ bytesWritten: number; plaintextSha256: string }>,
    [string, string, string]
  >;
} | null = null;

jest.mock('../../modules/waifu-sync-service', () => ({
  get WaifuSyncService() {
    return mockWaifuSyncService;
  },
}));

afterEach(() => {
  mockWaifuSyncService = null;
  mockNetworkRecovery = null;
  startDeleteAllRef.current = null;
});

// Board #27 S1b T8: wraps the real factory so the input the bundle hands the
// backup service is reachable.
jest.mock('@/features/backup/backup-service', () => {
  const actual = jest.requireActual('@/features/backup/backup-service');
  return {
    ...actual,
    createAppBackupService: jest.fn(actual.createAppBackupService),
    sweepBackupArtifacts: jest.fn(actual.sweepBackupArtifacts),
  };
});

type NetworkRecoveryHarness = {
  subscribe: jest.Mock;
  emit(): void;
  unsubscribe: jest.Mock;
};

function networkRecoveryHarness({
  retainHandlerOnUnsubscribe = false,
}: { retainHandlerOnUnsubscribe?: boolean } = {}): NetworkRecoveryHarness {
  const listeners = new Set<() => void>();
  const unsubscribe = jest.fn();
  const subscribe = jest.fn((callback: () => void) => {
    listeners.add(callback);
    return () => {
      if (!retainHandlerOnUnsubscribe) listeners.delete(callback);
      unsubscribe();
    };
  });
  return {
    subscribe,
    emit: () => {
      for (const callback of [...listeners]) callback();
    },
    unsubscribe,
  };
}

let mockNetworkRecovery: NetworkRecoveryHarness | null = null;

jest.mock('@/features/library/library-network-recovery', () => ({
  createExpoLibraryNetworkRecovery: jest.fn(() => mockNetworkRecovery ?? {
    subscribe: () => () => undefined,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** A deck card as a refill inserts it (board #24 wiring tests). */
function deckCandidate(id: number): WaifuImage {
  return {
    id,
    providerKey: 'waifu_im',
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.jpg`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 1200,
    height: 1800,
    byteSize: 456_789,
    extension: '.jpg',
    dominantColor: '#aabbcc',
    isNsfw: false,
    isAnimated: false,
    tags: [],
  };
}

function appTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { retry: false },
    },
  });
}

function deleteAllResult(
  settingsStatus: DeleteAllDataResult['settings']['status'],
): DeleteAllAppDataResult {
  const settingsFailed = settingsStatus === 'failed';
  return {
    ok: !settingsFailed,
    files: { deleted: [], failed: [] },
    database: { status: 'deleted', deletedRows: 0, error: null },
    settings: {
      status: settingsStatus,
      error: settingsFailed
        ? { code: 'settings_failed', message: 'Settings could not be deleted.' }
        : null,
    },
    library: { status: 'deleted', cloud: 'skipped', disconnected: false, error: null },
    remaining: settingsFailed ? ['settings'] : [],
    recomposed: false,
  };
}

function byosContext(): ByosResolvedContext {
  return {
    kind: 's3',
    credentials: {
      endpoint: 'https://vault.example.com',
      region: 'auto',
      bucket: 'waifu-deck',
      accessKeyId: 'AKIA-TEST',
      secretAccessKey: 'secret',
    },
    meta: {
      version: 1,
      vaultId: 'vault-1',
      encryption: 'aes-gcm',
      kdf: { name: 'scrypt', saltB64: 'c2FsdA==', N: 16384, r: 8, p: 1 },
    },
    masterKey: new Uint8Array(32),
    deviceId: 'device-1',
  } as unknown as ByosResolvedContext;
}

function appBundle({
  byosStatus = { status: 'unconfigured' } as ByosStatus,
  closeDatabase = jest.fn(async () => undefined),
  databaseId = 'database',
  deleteAllData = jest.fn(async () => deleteAllResult('deleted')),
  initialSettings = DEFAULT_SETTINGS,
  imageRepository = {} as ImageRepository,
  settingsRepository = {} as SettingsRepository,
  startupRecovery,
  discoveryService = {
    restore: jest.fn(async () => ({ active: null, queued: [] })),
  } as unknown as DiscoveryService,
  librarySyncTrigger,
  libraryActions,
  libraryBackgroundSync = null,
  libraryDispose,
}: {
  byosStatus?: ByosStatus;
  closeDatabase?: jest.Mock<Promise<void>, []>;
  databaseId?: string;
  deleteAllData?: jest.Mock<Promise<DeleteAllDataResult>, []>;
  initialSettings?: AppSettings;
  imageRepository?: ImageRepository;
  settingsRepository?: SettingsRepository;
  startupRecovery?: Promise<boolean>;
  discoveryService?: DiscoveryService;
  librarySyncTrigger?: {
    dispose: () => void;
    onSessionReady?: () => void;
    onNetworkReturn?: () => void;
  };
  libraryActions?: { getAccountScope: () => Promise<string | null> };
  libraryBackgroundSync?: { ensureRegistered: () => Promise<void>; ensureUnregistered: () => Promise<void> } | null;
  libraryDispose?: () => void;
} = {}): AppServiceBundle {
  return {
    database: { id: databaseId } as unknown as SqlDatabasePort,
    settingsRepository,
    imageRepository,
    fileRepository: {} as CollectionFileRepository,
    initialSettings,
    byosStatus,
    resetCoordinator: {} as DataResetCoordinator,
    collectionService: { deleteAllData } as unknown as CollectionService,
    discoveryService,
    startupRecovery,
    closeDatabase,
    closeLibraryResume: async () => undefined,
    librarySyncTrigger,
    libraryActions,
    libraryBackgroundSync,
    libraryDispose,
  } as unknown as AppServiceBundle;
}

let lastDeleteAllResult: DeleteAllAppDataResult | null = null;
let lastDeleteAllError: unknown = null;
const startDeleteAllRef: { current: (() => Promise<DeleteAllAppDataResult>) | null } = {
  current: null,
};

function SettingsProbe() {
  const { settings, updateSettings } = useAppSettings();
  const services = useAppServices();
  return createElement(
    View,
    null,
    createElement(Text, null, `preload:${settings.minWidth}`),
    createElement(Text, null, `revision:${services.dataRevision}`),
    createElement(Text, null, `initial:${String('initialSettings' in services)}`),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '更新设置',
        onPress: () => void updateSettings({ ...settings, minWidth: 1080 }),
      },
      createElement(Text, null, '更新设置'),
    ),
  );
}

function OverlappingSettingsProbe() {
  const { settings, updateSettings } = useAppSettings();
  const [status, setStatus] = useState('idle');
  return createElement(
    View,
    null,
    createElement(
      Text,
      null,
      `overlap:${settings.nsfwMode}:${String(settings.nsfwConfirmed)}:${settings.includedTags.join(',')}:${status}`,
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '连续更新设置',
        onPress: () => {
          const first = updateSettings(() => ({
            nsfwMode: 'mixed',
            nsfwConfirmed: true,
          }));
          const second = updateSettings((current: AppSettings) => ({
            includedTags: [...current.includedTags, 'maid'],
          }));
          void Promise.all([first, second]).then(() => setStatus('done'));
        },
      },
      createElement(Text, null, '连续更新设置'),
    ),
  );
}

function RejectedSettingsProbe() {
  const { settings, updateSettings } = useAppSettings();
  const [status, setStatus] = useState('idle');
  return createElement(
    View,
    null,
    createElement(
      Text,
      null,
      `rejected:${settings.minWidth}:${String(settings.blurNsfwThumbnails)}:${status}`,
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '失败后继续更新',
        onPress: () => {
          const rejected = updateSettings(() => ({ minWidth: 1080 }));
          const recovered = updateSettings(() => ({ blurNsfwThumbnails: false }));
          void Promise.allSettled([rejected, recovered]).then(() => setStatus('done'));
        },
      },
      createElement(Text, null, '失败后继续更新'),
    ),
  );
}

function DeleteAllProbe() {
  const { settings } = useAppSettings();
  const { dataRevision, deleteAllAppData } = useAppServices();
  const [result, setResult] = useState('none');
  const [recomposed, setRecomposed] = useState('none');
  return createElement(
    View,
    null,
    createElement(Text, null, `preload:${settings.minWidth}`),
    createElement(Text, null, `revision:${dataRevision}`),
    createElement(Text, null, `reset:${result}`),
    createElement(Text, null, `recomposed:${recomposed}`),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '删除全部数据',
        onPress: () => {
          void deleteAllAppData().then((value) => {
            setResult(value.settings.status);
            setRecomposed(String(value.recomposed));
            lastDeleteAllResult = value;
          }, (error: unknown) => {
            lastDeleteAllError = error;
          });
        },
      },
      createElement(Text, null, '删除全部数据'),
    ),
  );
}

function DeleteAllMethodProbe() {
  const deleteAllAppData = useAppServices().deleteAllAppData;
  useEffect(() => {
    startDeleteAllRef.current = deleteAllAppData;
    return () => {
      startDeleteAllRef.current = null;
    };
  }, [deleteAllAppData]);
  return null;
}

function SettingsDeleteBarrierProbe() {
  const {
    settings,
    updateSettings,
    deleteAllAppData,
  } = useAppServices();
  const [writeStatus, setWriteStatus] = useState('idle');
  const [deleteStatus, setDeleteStatus] = useState('idle');
  const [attemptStatus, setAttemptStatus] = useState('idle');
  return createElement(
    View,
    null,
    createElement(
      Text,
      null,
      `barrier:${settings.minWidth}:${writeStatus}:${deleteStatus}:${attemptStatus}`,
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '开始屏障设置更新',
        onPress: () => {
          setWriteStatus('pending');
          void updateSettings(() => ({ minWidth: 1080 })).then(
            () => setWriteStatus('saved'),
            () => setWriteStatus('failed'),
          );
        },
      },
      createElement(Text, null, '开始屏障设置更新'),
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '排队删除全部数据',
        onPress: () => {
          setDeleteStatus('pending');
          void deleteAllAppData().then(
            () => setDeleteStatus('deleted'),
            () => setDeleteStatus('failed'),
          );
        },
      },
      createElement(Text, null, '排队删除全部数据'),
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: '尝试屏障期间更新',
        onPress: () => {
          setAttemptStatus('pending');
          void updateSettings(() => ({ minWidth: 1440 })).then(
            () => setAttemptStatus('saved'),
            () => setAttemptStatus('rejected'),
          );
        },
      },
      createElement(Text, null, '尝试屏障期间更新'),
    ),
  );
}

function HistoryResetProbe() {
  const {
    dataRevision,
    resetDismissedHistory,
    resetDiscoveryHistory,
  } = useAppServices();
  const [result, setResult] = useState('none');
  return createElement(
    View,
    null,
    createElement(Text, null, `revision:${dataRevision}`),
    createElement(Text, null, `history:${result}`),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: 'provider reset dismissed',
        onPress: () => void resetDismissedHistory()
          .then((count) => setResult(`dismissed:${count}`)),
      },
      createElement(Text, null, 'provider reset dismissed'),
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: 'provider reset discovery',
        onPress: () => void resetDiscoveryHistory()
          .then((count) => setResult(`discovery:${count}`)),
      },
      createElement(Text, null, 'provider reset discovery'),
    ),
  );
}

function BackupRestoreProbe() {
  const { restoreFullBackup } = useAppServices();
  const [status, setStatus] = useState('idle');
  return createElement(
    View,
    null,
    createElement(Text, null, `restore:${status}`),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: 'provider restore backup',
        onPress: () => void restoreFullBackup().then(
          () => setStatus('restored'),
          () => setStatus('failed'),
        ),
      },
      createElement(Text, null, 'provider restore backup'),
    ),
  );
}

function BackupExportProbe() {
  const { createFullBackup } = useAppServices();
  const [status, setStatus] = useState('idle');
  return createElement(
    View,
    null,
    createElement(Text, null, `export:${status}`),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: 'provider export backup',
        onPress: () => void createFullBackup().then(
          () => setStatus('exported'),
          () => setStatus('failed'),
        ),
      },
      createElement(Text, null, 'provider export backup'),
    ),
  );
}

function BundleProbe() {
  const services = useAppServices();
  const { settings } = useAppSettings();
  return createElement(
    Text,
    null,
    `${(services.database as unknown as { id: string }).id}:${settings.minWidth}`,
  );
}

function RevisionProbe() {
  const { dataRevision } = useAppServices();
  return createElement(Text, null, `revision:${dataRevision}`);
}

function ByosProbe() {
  const { byosStatus, database, reloadAppServices } = useAppServices();
  const detail = byosStatus.status === 'locked' ? `:${byosStatus.reason}` : '';
  return createElement(
    View,
    null,
    createElement(
      Text,
      null,
      `${(database as unknown as { id: string }).id}:${byosStatus.status}${detail}`,
    ),
    createElement(
      Pressable,
      {
        accessibilityRole: 'button',
        accessibilityLabel: 'provider reload services',
        onPress: () => reloadAppServices(),
      },
      createElement(Text, null, 'provider reload services'),
    ),
  );
}

function providerElement(
  children: ReactNode,
  initializer: () => Promise<AppServiceBundle>,
  resetter?: () => Promise<void>,
  queryClient: QueryClient = appTestQueryClient(),
  resolveByosStatus?: () => Promise<ByosStatus>,
) {
  const props = {
    initializer,
    resetter,
    resolveByosStatus,
  } as Parameters<typeof AppServicesProvider>[0];
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(AppServicesProvider, props, children),
  );
}

const NETWORK_LOCK: ByosStatus = {
  status: 'locked',
  reason: 'vault_unreachable',
  detail: 'network',
};

function readyVault(): ByosStatus {
  return { status: 'ready', context: byosContext() };
}

function RecoveryMarker({ onMount }: { onMount: () => void }) {
  const services = useAppServices();
  useEffect(() => {
    onMount();
  }, [onMount]);
  const status = services.byosStatus.status === 'locked'
    ? services.byosStatus.reason
    : services.byosStatus.status;
  return createElement(Text, null, `marker:${status}`);
}

function libraryShell(partial: Record<string, unknown>): LibraryIntegration {
  return {
    libraryController: null,
    libraryActions: null,
    librarySync: null,
    libraryView: null,
    libraryCache: null,
    librarySyncTrigger: null,
    libraryBackgroundSync: null,
    libraryChanges: null,
    ...partial,
  } as unknown as LibraryIntegration;
}

function libraryPassFns() {
  return {
    onCollectedOriginalReady: jest.fn(),
    purgeCollectedImage: jest.fn(async () => undefined),
    purgeUndoneLibraryRows: jest.fn(async () => 0),
    noteMissingOriginals: jest.fn(async () => 0),
    reingestMissingLibraryRows: jest.fn(async () => 0),
    reprotectUncommittedOriginals: jest.fn(async () => 0),
    handOverExisting: jest.fn(async () => 0),
    sweepCacheOrphans: jest.fn(async () => 0),
  };
}

function lockedLibraryBundle(options?: {
  cloudController?: Record<string, unknown>;
  localDispose?: boolean;
  storageMode?: unknown;
}) {
  const localController = libraryPassFns();
  const cloudController = { ...libraryPassFns(), ...options?.cloudController };
  const onSessionReady = jest.fn();
  const onNetworkReturn = jest.fn();
  const triggerDispose = jest.fn();
  const ensureRegistered = jest.fn(async () => undefined);
  const ensureUnregistered = jest.fn(async () => undefined);
  const libraryDispose = jest.fn();
  const getAccountScope = jest.fn(async () => 'scope-1');
  const subscribeActiveDownloads = jest.fn(() => () => undefined);
  const hooks: {
    onOriginalReady?: (event: { imageId: number; localUri: string }) => void;
    onSavedRowRemoved?: (imageId: number) => void;
    onCollectionResumed?: () => void;
    libraryBytes?: () => Promise<number>;
    libraryReset?: () => Promise<unknown>;
    purgeCollectedImage?: (imageId: number) => Promise<void>;
  } = {};
  const database = { id: 'database' };
  const imageRepository = { id: 'images' };
  const fileRepository = { id: 'files' };
  const resources = {
    database: database as unknown as SqlDatabasePort,
    settingsRepository: {} as SettingsRepository,
    imageRepository: imageRepository as unknown as ImageRepository,
    fileRepository: fileRepository as unknown as CollectionFileRepository,
    initialSettings: DEFAULT_SETTINGS,
    byosStatus: NETWORK_LOCK,
  };
  const createLibraryIntegration = jest.fn()
    .mockReturnValueOnce(libraryShell({
      libraryController: localController,
      ...(options?.localDispose ? { libraryDispose: jest.fn() } : {}),
    }))
    .mockReturnValue(libraryShell({
      libraryController: cloudController,
      libraryActions: { getAccountScope },
      librarySyncTrigger: {
        dispose: triggerDispose,
        onSessionReady,
        onNetworkReturn,
        onAppStateChange: jest.fn(),
      },
      libraryBackgroundSync: { ensureRegistered, ensureUnregistered },
      libraryView: { model: {}, resolver: { resolve: jest.fn() } },
      libraryDispose,
      ...(options?.storageMode ? { libraryStorageMode: options.storageMode } : {}),
    }));
  const closeDatabase = jest.fn(async () => undefined);
  const bundle = {
    ...createAppServiceBundle(resources, {
      createCollection: ((dependencies: {
        onOriginalReady?: (event: { imageId: number; localUri: string }) => void;
        onSavedRowRemoved?: (imageId: number) => void;
        onCollectionResumed?: () => void;
        libraryBytes?: () => Promise<number>;
        libraryReset?: () => Promise<unknown>;
      }) => {
        hooks.onOriginalReady = dependencies.onOriginalReady;
        hooks.onSavedRowRemoved = dependencies.onSavedRowRemoved;
        hooks.onCollectionResumed = dependencies.onCollectionResumed;
        hooks.libraryBytes = dependencies.libraryBytes;
        hooks.libraryReset = dependencies.libraryReset;
        return { subscribeActiveDownloads };
      }) as unknown as typeof createCollectionService,
      createDiscovery: ((dependencies: {
        library?: { purgeCollectedImage?: (imageId: number) => Promise<void> };
      }) => {
        hooks.purgeCollectedImage = dependencies.library?.purgeCollectedImage;
        return {
          restore: async () => ({ active: null, queued: [] }),
        };
      }) as unknown as typeof createDiscoveryService,
      createLibraryIntegration,
    }),
    closeDatabase,
  } as AppServiceBundle;
  return {
    bundle,
    closeDatabase,
    createLibraryIntegration,
    hooks,
    localController,
    cloudController,
    onSessionReady,
    onNetworkReturn,
    triggerDispose,
    ensureRegistered,
    ensureUnregistered,
    getAccountScope,
    libraryDispose,
    subscribeActiveDownloads,
    resources,
  };
}

async function flushAppEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('app services', () => {
  beforeEach(() => {
    const sweep = sweepBackupArtifacts as jest.Mock;
    sweep.mockReset();
    sweep.mockResolvedValue({ deleted: [], failed: [] });
    mockNetworkRecovery = networkRecoveryHarness();
  });
  describe('row 52: publication and session continuation ownership', () => {
    test('an initializer change cancels pending registration after the current handle clears', async () => {
      const prepared = lockedLibraryBundle();
      const resume = jest.spyOn(prepared.bundle, 'resumeLibrary');
      const registering = deferred<undefined>();
      prepared.ensureRegistered.mockImplementation(() => registering.promise);
      const opening = deferred<AppServiceBundle>();
      const client = appTestQueryClient();
      const resolveVault = async () => readyVault();
      const firstInitializer = async () => prepared.bundle;
      const view = await render(providerElement(
        createElement(ByosProbe), firstInitializer, undefined, client, resolveVault,
      ));
      try {
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await screen.findByText('database:ready');
        await waitFor(() => expect(prepared.ensureRegistered).toHaveBeenCalledTimes(1));
        await view.rerender(providerElement(
          createElement(ByosProbe), () => opening.promise, undefined, client, resolveVault,
        ));
        await waitFor(() => expect(prepared.closeDatabase).toHaveBeenCalledTimes(1));
        // Effect cleanup clears the current handle; startup still names the
        // old ready bundle until the replacement initializer resolves.
        expect(screen.getByText('database:ready')).toBeOnTheScreen();
        await act(async () => { registering.resolve(undefined); });
        await flushAppEffects();
        expect(resume).not.toHaveBeenCalled();
        expect(prepared.cloudController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
        expect(prepared.cloudController.sweepCacheOrphans).not.toHaveBeenCalled();
      } finally {
        await act(async () => { opening.resolve(appBundle()); registering.resolve(undefined); });
        await view.unmount();
      }
    });

    test.each(['scope', 'registration'] as const)(
      'restore closes the database without a rebound resume after pending %s',
      async (step) => {
        const prepared = lockedLibraryBundle({
          cloudController: {
            beginReset: jest.fn(async () => ({ settle: async () => undefined, end() {} })),
          },
        });
        const resumeStart = jest.spyOn(prepared.bundle.resetCoordinator, 'runMutation');
        const scope = deferred<string>();
        const registering = deferred<undefined>();
        if (step === 'scope') prepared.getAccountScope.mockImplementation(() => scope.promise);
        else prepared.ensureRegistered.mockImplementation(() => registering.promise);
        const applying = deferred<AppSettings>();
        const apply = jest.fn(() => applying.promise);
        prepared.bundle.backupService = {
          pickAndPrepareRestore: async () => ({ summary: {}, apply, dispose: async () => undefined }),
        } as unknown as AppServiceBundle['backupService'];
        let restore!: () => Promise<unknown>;
        function Capture() {
          const { restoreFullBackup } = useAppServices();
          useEffect(() => { restore = restoreFullBackup; }, [restoreFullBackup]);
          return createElement(ByosProbe);
        }
        const initializer = jest.fn().mockResolvedValueOnce(prepared.bundle).mockResolvedValue(appBundle());
        const view = await render(providerElement(
          createElement(Capture), initializer, undefined, appTestQueryClient(), async () => readyVault(),
        ));
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await screen.findByText('database:ready');
        await waitFor(() => expect(step === 'scope' ? prepared.getAccountScope : prepared.ensureRegistered)
          .toHaveBeenCalledTimes(1));
        let restoring!: Promise<unknown>;
        await act(async () => { restoring = restore(); });
        // Native registration is outside the mutation: even while it is pending,
        // restore can acquire its lease and close the database.
        await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
        expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
        expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
        try {
          await act(async () => {
            if (step === 'scope') scope.resolve('scope-1');
            else registering.resolve(undefined);
          });
          await flushAppEffects();
          expect(resumeStart).not.toHaveBeenCalled();
          if (step === 'scope') {
            expect(prepared.onSessionReady).not.toHaveBeenCalled();
            expect(prepared.ensureRegistered).not.toHaveBeenCalled();
          }
          for (const pass of ['purgeUndoneLibraryRows', 'noteMissingOriginals',
            'reingestMissingLibraryRows', 'reprotectUncommittedOriginals',
            'handOverExisting', 'sweepCacheOrphans'] as const) {
            expect(prepared.cloudController[pass]).not.toHaveBeenCalled();
          }
        } finally {
          await act(async () => { applying.resolve(DEFAULT_SETTINGS); await restoring; });
          await view.unmount();
        }
      },
    );

    test.each(['scope', 'registration'] as const)(
      'a cancelled restore defers the rebound resume until cancel after pending %s',
      async (step) => {
        const prepared = lockedLibraryBundle();
        const scope = deferred<string>();
        const registering = deferred<undefined>();
        if (step === 'scope') prepared.getAccountScope.mockImplementation(() => scope.promise);
        else prepared.ensureRegistered.mockImplementation(() => registering.promise);
        const picking = deferred<null>();
        const pick = jest.fn(() => picking.promise);
        prepared.bundle.backupService = {
          pickAndPrepareRestore: pick,
        } as unknown as AppServiceBundle['backupService'];
        let restore!: () => Promise<unknown>;
        function Capture() {
          const { restoreFullBackup } = useAppServices();
          useEffect(() => { restore = restoreFullBackup; }, [restoreFullBackup]);
          return createElement(ByosProbe);
        }
        const view = await render(providerElement(
          createElement(Capture), async () => prepared.bundle, undefined,
          appTestQueryClient(), async () => readyVault(),
        ));
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await screen.findByText('database:ready');
        let restoring!: Promise<unknown>;
        await act(async () => { restoring = restore(); });
        await waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
        try {
          await act(async () => {
            if (step === 'scope') scope.resolve('scope-1');
            else registering.resolve(undefined);
          });
          await flushAppEffects();
          expect(prepared.ensureRegistered).toHaveBeenCalledTimes(1);
          expect(prepared.cloudController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
          await act(async () => { picking.resolve(null); await restoring; });
          await waitFor(() => expect(prepared.cloudController.sweepCacheOrphans).toHaveBeenCalledTimes(1));
          for (const pass of ['purgeUndoneLibraryRows', 'noteMissingOriginals',
            'reingestMissingLibraryRows', 'reprotectUncommittedOriginals',
            'handOverExisting', 'sweepCacheOrphans'] as const) {
            expect(prepared.cloudController[pass]).toHaveBeenCalledTimes(1);
          }
          expect(prepared.closeDatabase).not.toHaveBeenCalled();
          expect(prepared.onSessionReady).toHaveBeenCalledTimes(1);
        } finally {
          await act(async () => { picking.resolve(null); await restoring; });
          await view.unmount();
        }
      },
    );

    test('delete-all defers a pending rebound resume and replacement discards the old bundle', async () => {
      const prepared = lockedLibraryBundle();
      const resume = jest.spyOn(prepared.bundle, 'resumeLibrary');
      const registering = deferred<undefined>();
      prepared.ensureRegistered.mockImplementation(() => registering.promise);
      const deleting = deferred<void>();
      let release!: () => void;
      const deleteAllData = jest.fn(async () => {
        const lease = await prepared.bundle.resetCoordinator.beginReset();
        release = lease.release;
        await deleting.promise;
        return { ...deleteAllResult('deleted'), library: {
          status: 'deleted' as const, cloud: 'deleted' as const, disconnected: true, error: null,
        } };
      });
      prepared.bundle.collectionService.deleteAllData = deleteAllData;
      let deleteAll!: () => Promise<unknown>;
      function Capture() {
        const { deleteAllAppData } = useAppServices();
        useEffect(() => { deleteAll = deleteAllAppData; }, [deleteAllAppData]);
        return createElement(ByosProbe);
      }
      const initializer = jest.fn().mockResolvedValueOnce(prepared.bundle).mockResolvedValue(appBundle());
      const view = await render(providerElement(
        createElement(Capture), initializer, undefined, appTestQueryClient(), async () => readyVault(),
      ));
      await screen.findByText('database:locked:vault_unreachable');
      await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
      await screen.findByText('database:ready');
      let pending!: Promise<unknown>;
      await act(async () => { pending = deleteAll(); });
      await waitFor(() => expect(deleteAllData).toHaveBeenCalledTimes(1));
      try {
        await act(async () => { registering.resolve(undefined); });
        await flushAppEffects();
        expect(prepared.cloudController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
        await act(async () => { deleting.resolve(); await pending; });
        await screen.findByText('database:unconfigured');
        await act(async () => { release(); });
        await flushAppEffects();
        expect(resume).not.toHaveBeenCalled();
        expect(prepared.cloudController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
        expect(prepared.cloudController.sweepCacheOrphans).not.toHaveBeenCalled();
        expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => { deleting.resolve(); release?.(); await pending; });
        await view.unmount();
      }
    });

    test.each(['restore', 'rebind'] as const)(
      'the original startup session stops after %s while its scope is pending',
      async (operation) => {
        const prepared = lockedLibraryBundle();
        const scope = deferred<string>();
        const onSessionReady = jest.fn();
        const ensureRegistered = jest.fn(async () => undefined);
        Object.assign(prepared.localController, {
          beginReset: jest.fn(async () => ({ settle: async () => undefined, end() {} })),
        });
        prepared.bundle.libraryActions = {
          getAccountScope: () => scope.promise,
        } as AppServiceBundle['libraryActions'];
        prepared.bundle.librarySyncTrigger = {
          dispose: jest.fn(), onSessionReady, onNetworkReturn: jest.fn(), onAppStateChange: jest.fn(),
        } as unknown as AppServiceBundle['librarySyncTrigger'];
        prepared.bundle.libraryBackgroundSync = {
          ensureRegistered, ensureUnregistered: jest.fn(async () => undefined),
        };
        const applying = deferred<AppSettings>();
        const apply = jest.fn(() => applying.promise);
        prepared.bundle.backupService = {
          pickAndPrepareRestore: async () => ({ summary: {}, apply, dispose: async () => undefined }),
        } as unknown as AppServiceBundle['backupService'];
        let restore!: () => Promise<unknown>;
        function Capture() {
          const { restoreFullBackup } = useAppServices();
          useEffect(() => { restore = restoreFullBackup; }, [restoreFullBackup]);
          return createElement(ByosProbe);
        }
        const initializer = jest.fn().mockResolvedValueOnce(prepared.bundle).mockResolvedValue(appBundle());
        const view = await render(providerElement(
          createElement(Capture), initializer, undefined, appTestQueryClient(), async () => readyVault(),
        ));
        await screen.findByText('database:locked:vault_unreachable');
        let restoring: Promise<unknown> | undefined;
        if (operation === 'restore') {
          await act(async () => { restoring = restore(); });
          await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
          expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
        } else {
          await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
          await screen.findByText('database:ready');
          expect(prepared.onSessionReady).toHaveBeenCalledTimes(1);
        }
        try {
          await act(async () => { scope.resolve('old-scope'); });
          await flushAppEffects();
          expect(onSessionReady).not.toHaveBeenCalled();
          expect(ensureRegistered).not.toHaveBeenCalled();
        } finally {
          if (restoring) {
            await act(async () => { applying.resolve(DEFAULT_SETTINGS); await restoring; });
          }
          await view.unmount();
        }
      },
    );

    test.each(['restore', 'delete'] as const)(
      'a hold inside rebind refuses publication and resolves again after %s ends',
      async (operation) => {
        const prepared = lockedLibraryBundle();
        const picking = deferred<null>();
        const deleting = deferred<DeleteAllDataResult>();
        prepared.bundle.backupService = {
          pickAndPrepareRestore: () => picking.promise,
        } as unknown as AppServiceBundle['backupService'];
        prepared.bundle.collectionService.deleteAllData = jest.fn(() => deleting.promise);
        let begin!: () => Promise<unknown>;
        function Capture() {
          const { restoreFullBackup, deleteAllAppData } = useAppServices();
          useEffect(() => {
            begin = operation === 'restore' ? restoreFullBackup : deleteAllAppData;
          }, [restoreFullBackup, deleteAllAppData]);
          return createElement(ByosProbe);
        }
        const integration = prepared.createLibraryIntegration.getMockImplementation()!();
        let pending!: Promise<unknown>;
        prepared.createLibraryIntegration.mockImplementationOnce(() => {
          pending = begin();
          void pending.catch(() => undefined);
          return integration;
        });
        const resolveVault = jest.fn().mockResolvedValueOnce(readyVault()).mockResolvedValue(NETWORK_LOCK);
        const initializer = jest.fn(async () => prepared.bundle);
        const view = await render(providerElement(
          createElement(Capture), initializer, undefined, appTestQueryClient(), resolveVault,
        ));
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await flushAppEffects();
        try {
          expect(screen.getByText('database:locked:vault_unreachable')).toBeOnTheScreen();
          expect(screen.queryByText('database:ready')).toBeNull();
          expect(prepared.onSessionReady).not.toHaveBeenCalled();
          expect(prepared.getAccountScope).not.toHaveBeenCalled();
          expect(prepared.ensureRegistered).not.toHaveBeenCalled();
          expect(prepared.cloudController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
          expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
          expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
          expect(resolveVault).toHaveBeenCalledTimes(1);
          await act(async () => {
            if (operation === 'restore') picking.resolve(null);
            else deleting.reject(new Error('delete failed'));
            await pending.catch(() => undefined);
          });
          await flushAppEffects();
          expect(resolveVault).toHaveBeenCalledTimes(2);
          expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
          expect(initializer).toHaveBeenCalledTimes(1);
          expect(prepared.closeDatabase).not.toHaveBeenCalled();
        } finally {
          await view.unmount();
          await act(async () => {
            if (operation === 'restore') picking.resolve(null);
            else deleting.reject(new Error('test complete'));
            await pending.catch(() => undefined);
          });
        }
      },
    );

    test.each(['restore', 'delete'] as const)(
      'a refused rebind restores local saves and the next ready recovery after %s ends',
      async (operation) => {
        const prepared = lockedLibraryBundle();
        const picking = deferred<null>();
        const deleting = deferred<DeleteAllDataResult>();
        const nextVerdict = deferred<ByosStatus>();
        prepared.bundle.backupService = {
          pickAndPrepareRestore: () => picking.promise,
        } as unknown as AppServiceBundle['backupService'];
        prepared.bundle.collectionService.deleteAllData = jest.fn(() => deleting.promise);
        let begin!: () => Promise<unknown>;
        let publishedController: AppServiceBundle['libraryController'];
        function Capture() {
          const services = useAppServices();
          useEffect(() => {
            begin = operation === 'restore' ? services.restoreFullBackup : services.deleteAllAppData;
            publishedController = services.libraryController;
          }, [services]);
          return createElement(ByosProbe);
        }
        const refused = prepared.createLibraryIntegration.getMockImplementation()!() as LibraryIntegration;
        const nextController = libraryPassFns();
        const nextDispose = jest.fn();
        const nextTriggerDispose = jest.fn();
        const nextSessionReady = jest.fn();
        const nextIntegration = {
          ...refused,
          libraryController: nextController,
          libraryDispose: nextDispose,
          librarySyncTrigger: {
            ...refused.librarySyncTrigger,
            dispose: nextTriggerDispose,
            onSessionReady: nextSessionReady,
          },
        } as unknown as LibraryIntegration;
        let pending: Promise<unknown> | undefined;
        prepared.createLibraryIntegration.mockImplementationOnce(() => {
          pending = begin();
          void pending.catch(() => undefined);
          return refused;
        }).mockReturnValueOnce(nextIntegration);
        const resolveVault = jest.fn<Promise<ByosStatus>, []>()
          .mockResolvedValueOnce(readyVault()).mockReturnValueOnce(nextVerdict.promise);
        const initializer = jest.fn().mockResolvedValueOnce(prepared.bundle).mockResolvedValue(appBundle());
        const view = await render(providerElement(
          createElement(Capture), initializer, undefined, appTestQueryClient(), resolveVault,
        ));
        try {
          await screen.findByText('database:locked:vault_unreachable');
          await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
          await waitFor(() => expect(prepared.libraryDispose).toHaveBeenCalledTimes(1));
          expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
          expect(screen.getByText('database:locked:vault_unreachable')).toBeOnTheScreen();
          await act(async () => {
            if (operation === 'restore') picking.resolve(null);
            else deleting.reject(new Error('delete failed'));
            await pending?.catch(() => undefined);
          });
          await waitFor(() => expect(resolveVault).toHaveBeenCalledTimes(2));
          const localSave = { imageId: 93, localUri: 'file:///93.jpg' };
          prepared.hooks.onOriginalReady?.(localSave);
          expect(prepared.localController.onCollectedOriginalReady).toHaveBeenCalledWith(localSave);
          expect(prepared.cloudController.onCollectedOriginalReady).not.toHaveBeenCalled();
          expect(nextController.onCollectedOriginalReady).not.toHaveBeenCalled();
          await act(async () => { nextVerdict.resolve(readyVault()); });
          await screen.findByText('database:ready');
          await waitFor(() => expect(nextController.sweepCacheOrphans).toHaveBeenCalledTimes(1));
          expect(publishedController!).toBe(nextController);
          expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(3);
          expect(initializer).toHaveBeenCalledTimes(1);
          expect(prepared.closeDatabase).not.toHaveBeenCalled();
          expect(screen.queryByText('正在准备 Waifu Deck')).toBeNull();
          expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
          expect(prepared.onSessionReady).not.toHaveBeenCalled();
          expect(nextDispose).not.toHaveBeenCalled();
          expect(nextSessionReady).toHaveBeenCalledTimes(1);
          const cloudSave = { imageId: 94, localUri: 'file:///94.jpg' };
          prepared.hooks.onOriginalReady?.(cloudSave);
          expect(nextController.onCollectedOriginalReady).toHaveBeenCalledWith(cloudSave);
          expect(prepared.localController.onCollectedOriginalReady).toHaveBeenCalledTimes(1);
          expect(prepared.cloudController.onCollectedOriginalReady).not.toHaveBeenCalled();
        } finally {
          await act(async () => {
            picking.resolve(null);
            if (operation === 'delete') deleting.reject(new Error('test complete'));
            nextVerdict.resolve(readyVault());
            if (pending) await pending.catch(() => undefined);
          });
          await view.unmount();
        }
      },
    );

    test.each(['reload', 'unmount', 'reload with current token'] as const)(
      'a refusal after the holder swap restores local callbacks before disposal on %s',
      async (cause) => {
        const prepared = lockedLibraryBundle();
        const recoveryModule = jest.requireActual<typeof import('@/providers/library-recovery-controller')>(
          '@/providers/library-recovery-controller',
        );
        const createController = recoveryModule.createLibraryRecoveryController;
        const observedCurrency: boolean[] = [];
        const controllerSpy = jest.spyOn(recoveryModule, 'createLibraryRecoveryController')
          .mockImplementation((dependencies) => createController({
            ...dependencies,
            onReady: (verdict, isCurrent) => dependencies.onReady(verdict, () => {
              const current = isCurrent();
              observedCurrency.push(current);
              // Exercise the ready-bundle predicate independently of sequence currency.
              return cause === 'reload with current token' ? true : current;
            }),
          }));
        let reload!: () => void;
        function Capture() {
          const { reloadAppServices } = useAppServices();
          useEffect(() => { reload = reloadAppServices; }, [reloadAppServices]);
          return createElement(ByosProbe);
        }
        const rendererModule = jest.requireActual<typeof import('test-renderer')>('test-renderer');
        const createRoot = rendererModule.createRoot;
        let unmountNow!: () => void;
        const rendererSpy = jest.spyOn(rendererModule, 'createRoot').mockImplementation((options) => {
          const root = createRoot(options);
          unmountNow = root.unmount;
          return root;
        });
        const react = jest.requireActual<typeof import('react')>('react');
        let view: Awaited<ReturnType<typeof render>> | undefined;
        const rebind = prepared.bundle.rebindLibrary;
        const rebindSpy = jest.spyOn(prepared.bundle, 'rebindLibrary')
          .mockImplementation((bundle, verdict) => {
            const rebound = rebind(bundle, verdict);
            if (cause === 'unmount') react.act(() => { unmountNow(); });
            else reload();
            return rebound;
          });
        const saveDuringRelease = { imageId: 97, localUri: 'file:///97.jpg' };
        prepared.libraryDispose.mockImplementation(() => {
          prepared.hooks.onOriginalReady?.(saveDuringRelease);
        });
        const opening = deferred<AppServiceBundle>();
        const initializer = jest.fn<Promise<AppServiceBundle>, []>()
          .mockResolvedValueOnce(prepared.bundle).mockReturnValueOnce(opening.promise);
        try {
          view = await render(providerElement(
            createElement(Capture), initializer, undefined, appTestQueryClient(), async () => readyVault(),
          ));
          await screen.findByText('database:locked:vault_unreachable');
          if (cause === 'unmount') {
            // RNTL's unmount is async. Let the verdict settle outside an outer
            // act so React's synchronous act commits cleanup inside rebind.
            (mockNetworkRecovery as NetworkRecoveryHarness).emit();
            await Promise.resolve();
            await Promise.resolve();
          } else {
            await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
          }
          await waitFor(() => expect(prepared.libraryDispose).toHaveBeenCalledTimes(1));
          expect(rebindSpy).toHaveBeenCalledTimes(1);
          expect(observedCurrency).toEqual([false]);
          expect(prepared.localController.onCollectedOriginalReady).toHaveBeenCalledWith(saveDuringRelease);
          expect(prepared.cloudController.onCollectedOriginalReady).not.toHaveBeenCalled();
          expect(prepared.onSessionReady).not.toHaveBeenCalled();
          expect(prepared.cloudController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
          expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
          await waitFor(() => expect(prepared.closeDatabase).toHaveBeenCalledTimes(1));
          if (cause === 'unmount') expect(initializer).toHaveBeenCalledTimes(1);
          else expect(initializer).toHaveBeenCalledTimes(2);
        } finally {
          await act(async () => { opening.resolve(appBundle()); });
          if (view) await view.unmount();
          controllerSpy.mockRestore();
          rendererSpy.mockRestore();
          rebindSpy.mockRestore();
        }
      },
    );

    test('an older rebind revert cannot replace the current integration', async () => {
      const prepared = lockedLibraryBundle();
      const ready = readyVault();
      if (ready.status !== 'ready') throw new Error('Expected ready verdict');
      const first = prepared.bundle.rebindLibrary(prepared.bundle, ready);
      expect(first.revertRebind).toEqual(expect.any(Function));
      first.revertRebind?.();
      const localSave = { imageId: 95, localUri: 'file:///95.jpg' };
      prepared.hooks.onOriginalReady?.(localSave);
      expect(prepared.localController.onCollectedOriginalReady).toHaveBeenCalledWith(localSave);
      const integration = prepared.createLibraryIntegration.getMockImplementation()!() as LibraryIntegration;
      const nextController = libraryPassFns();
      prepared.createLibraryIntegration.mockReturnValueOnce({ ...integration, libraryController: nextController });
      const next = prepared.bundle.rebindLibrary(prepared.bundle, ready);
      try {
        first.revertRebind?.();
        const cloudSave = { imageId: 96, localUri: 'file:///96.jpg' };
        prepared.hooks.onOriginalReady?.(cloudSave);
        expect(nextController.onCollectedOriginalReady).toHaveBeenCalledWith(cloudSave);
        expect(prepared.localController.onCollectedOriginalReady).toHaveBeenCalledTimes(1);
        expect(prepared.cloudController.onCollectedOriginalReady).not.toHaveBeenCalled();
      } finally {
        await createAppServiceBundleCloser()(next);
      }
    });

    test.each(['restore', 'delete'] as const)(
      'a hold before rebind prevents composition until %s ends',
      async (operation) => {
        const prepared = lockedLibraryBundle();
        const picking = deferred<null>();
        const deleting = deferred<DeleteAllDataResult>();
        prepared.bundle.backupService = {
          pickAndPrepareRestore: () => picking.promise,
        } as unknown as AppServiceBundle['backupService'];
        prepared.bundle.collectionService.deleteAllData = jest.fn(() => deleting.promise);
        let begin!: () => Promise<unknown>;
        function Capture() {
          const { restoreFullBackup, deleteAllAppData } = useAppServices();
          useEffect(() => {
            begin = operation === 'restore' ? restoreFullBackup : deleteAllAppData;
          }, [restoreFullBackup, deleteAllAppData]);
          return createElement(ByosProbe);
        }
        const resolveVault = jest.fn().mockResolvedValueOnce(readyVault()).mockResolvedValue(NETWORK_LOCK);
        const view = await render(providerElement(
          createElement(Capture), async () => prepared.bundle, undefined, appTestQueryClient(), resolveVault,
        ));
        await screen.findByText('database:locked:vault_unreachable');
        let pending!: Promise<unknown>;
        await act(async () => {
          (mockNetworkRecovery as NetworkRecoveryHarness).emit();
          pending = begin();
          void pending.catch(() => undefined);
        });
        await flushAppEffects();
        try {
          expect(screen.getByText('database:locked:vault_unreachable')).toBeOnTheScreen();
          expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(1);
          expect(prepared.onSessionReady).not.toHaveBeenCalled();
          expect(prepared.libraryDispose).not.toHaveBeenCalled();
          await act(async () => {
            if (operation === 'restore') picking.resolve(null);
            else deleting.reject(new Error('delete failed'));
            await pending.catch(() => undefined);
          });
          expect(resolveVault).toHaveBeenCalledTimes(2);
        } finally {
          await view.unmount();
          await act(async () => {
            if (operation === 'restore') picking.resolve(null);
            else deleting.reject(new Error('test complete'));
            await pending.catch(() => undefined);
          });
        }
      },
    );
  });

  test('retries only a failed bundle close instead of caching its rejection', async () => {
    const closeDatabase = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('database close failed'))
      .mockResolvedValueOnce(undefined);
    const bundle = appBundle({ closeDatabase });
    const closeBundle = createAppServiceBundleCloser();

    await expect(closeBundle(bundle)).rejects.toThrow('database close failed');
    await expect(closeBundle(bundle)).resolves.toBeUndefined();

    expect(closeDatabase).toHaveBeenCalledTimes(2);
  });

  test('still closes the database when the library sync trigger fails to dispose', async () => {
    const closeDatabase = jest.fn<Promise<void>, []>().mockResolvedValueOnce(undefined);
    const dispose = jest.fn(() => {
      throw new Error('sync trigger dispose failed');
    });
    const bundle = appBundle({ closeDatabase, librarySyncTrigger: { dispose } });
    const closeBundle = createAppServiceBundleCloser();

    await expect(closeBundle(bundle)).rejects.toThrow('sync trigger dispose failed');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  describe('board #28: closing a bundle releases its library composition', () => {
    test('closing a bundle releases its library composition', async () => {
      const closeDatabase = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
      const libraryDispose = jest.fn();
      const bundle = appBundle({ closeDatabase, libraryDispose });
      const closeBundle = createAppServiceBundleCloser();

      await expect(closeBundle(bundle)).resolves.toBeUndefined();
      await closeBundle(bundle);

      expect(libraryDispose).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    });

    test('a throwing trigger dispose never skips the library dispose, and its error is merged', async () => {
      const closeDatabase = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
      const triggerError = new Error('sync trigger dispose failed');
      const libraryDispose = jest.fn();
      const bundle = appBundle({
        closeDatabase,
        librarySyncTrigger: {
          dispose: () => {
            throw triggerError;
          },
        },
        libraryDispose,
      });

      await expect(createAppServiceBundleCloser()(bundle)).rejects.toBe(triggerError);

      expect(libraryDispose).toHaveBeenCalledTimes(1);
      expect(closeDatabase).toHaveBeenCalledTimes(1);
    });

    test('a throwing library dispose is merged with the others, never swallowed, and never skips closeDatabase', async () => {
      const closeDatabase = jest.fn<Promise<void>, []>().mockRejectedValue(
        new Error('database close failed'),
      );
      const triggerError = new Error('sync trigger dispose failed');
      const libraryError = new Error('library dispose failed');
      const bundle = appBundle({
        closeDatabase,
        librarySyncTrigger: {
          dispose: () => {
            throw triggerError;
          },
        },
        libraryDispose: () => {
          throw libraryError;
        },
      });

      const rejection = await createAppServiceBundleCloser()(bundle).then(
        () => null,
        (error: unknown) => error,
      );

      expect(closeDatabase).toHaveBeenCalledTimes(1);
      expect(rejection).toBeInstanceOf(AggregateError);
      const merged = (rejection as AggregateError).errors.flatMap((error: unknown) => (
        error instanceof AggregateError ? error.errors : [error]
      ));
      expect(merged).toEqual(expect.arrayContaining([
        triggerError,
        libraryError,
        expect.objectContaining({ message: 'database close failed' }),
      ]));
    });

    test('a lone library dispose failure reaches the caller and still closes the database', async () => {
      const closeDatabase = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
      const libraryError = new Error('library dispose failed');
      const bundle = appBundle({
        closeDatabase,
        libraryDispose: () => {
          throw libraryError;
        },
      });

      await expect(createAppServiceBundleCloser()(bundle)).rejects.toBe(libraryError);

      expect(closeDatabase).toHaveBeenCalledTimes(1);
    });

    test('the bundle carries the composition\'s libraryDispose', () => {
      const libraryDispose = jest.fn();
      const libraryIntegration = {
        libraryController: null,
        libraryActions: null,
        librarySync: null,
        libraryView: null,
        libraryCache: null,
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryChanges: null,
        libraryDispose,
      } as unknown as LibraryIntegration;

      const bundle = createAppServiceBundle(
        {
          database: {} as SqlDatabasePort,
          settingsRepository: {} as SettingsRepository,
          imageRepository: {} as ImageRepository,
          fileRepository: {} as CollectionFileRepository,
          initialSettings: DEFAULT_SETTINGS,
        },
        {
          createCollection: jest.fn(() => ({} as CollectionService)),
          createDiscovery: jest.fn(() => ({
            restore: jest.fn(async () => ({ active: null, queued: [] })),
          } as unknown as DiscoveryService)),
          createLibraryIntegration: jest.fn(() => libraryIntegration),
        },
      );

      expect(bundle.libraryDispose).toBe(libraryDispose);
    });
  });

  test('shares one reset coordinator between collection and discovery', () => {
    const coordinator = {} as DataResetCoordinator;
    const collectionService = {} as CollectionService;
    const discoveryService = {
      restore: jest.fn(async () => ({ active: null, queued: [] })),
    } as unknown as DiscoveryService;
    const createCollection = jest.fn(() => collectionService);
    const createDiscovery = jest.fn(() => discoveryService);

    const bundle = createAppServiceBundle(
      {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
      },
      {
        createCoordinator: () => coordinator,
        createCollection,
        createDiscovery,
      },
    );

    expect(bundle.resetCoordinator).toBe(coordinator);
    expect(bundle).not.toHaveProperty('settings');
    expect(createCollection).toHaveBeenCalledWith(expect.objectContaining({ coordinator }));
    expect(createDiscovery).toHaveBeenCalledWith(expect.objectContaining({ coordinator }));
  });

  test('K6-5 B: the collection still reaches the library it is now built before', async () => {
    // The collection is constructed first so the library's foreground guard can
    // subscribe to its download count. The ingest seam therefore runs through a
    // deferred closure — if that ever stopped resolving, every save would stop
    // entering the library and no test would say so.
    const onCollectedOriginalReady = jest.fn();
    const reingestMissingLibraryRows = jest.fn(async () => 0);
    const reprotectUncommittedOriginals = jest.fn(async () => 0);
    const purgeUndoneLibraryRows = jest.fn(async () => 0);
    const noteMissingOriginals = jest.fn(async () => 0);
    const libraryIntegration = {
      libraryController: {
        onCollectedOriginalReady,
        reingestMissingLibraryRows,
        reprotectUncommittedOriginals,
        purgeUndoneLibraryRows,
        noteMissingOriginals,
        handOverExisting: jest.fn(async () => 0),
        sweepCacheOrphans: jest.fn(async () => 0),
      },
      libraryActions: null,
      librarySync: null,
      libraryView: null,
      libraryCache: null,
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
      libraryChanges: null,
    } as unknown as LibraryIntegration;
    const createCollection: jest.MockedFunction<typeof createCollectionService> =
      jest.fn((_dependencies) => ({} as CollectionService));
    const discoveryService = {
      restore: jest.fn(async () => ({ active: null, queued: [] })),
    } as unknown as DiscoveryService;

    createAppServiceBundle(
      {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
      },
      {
        createCollection,
        createDiscovery: jest.fn(() => discoveryService),
        createLibraryIntegration: jest.fn(() => libraryIntegration),
      },
    );

    const { onOriginalReady, onCollectionResumed } = createCollection.mock.calls[0]![0];
    onOriginalReady?.({ imageId: 7, localUri: 'file:///documents/collection/7.jpg' });
    onCollectionResumed?.();

    expect(onCollectedOriginalReady).toHaveBeenCalledWith({
      imageId: 7,
      localUri: 'file:///documents/collection/7.jpg',
    });
    // K6-5 C: and the resume sweep asks the library for the saves it lost.
    await waitFor(() => expect(reingestMissingLibraryRows).toHaveBeenCalledTimes(1));
  });

  describe('board #24: the library local phase of a rewound save', () => {
    function libraryWith(
      controller: Record<string, unknown> | null,
    ): LibraryIntegration {
      return {
        libraryController: controller,
        libraryActions: null,
        librarySync: null,
        libraryView: null,
        libraryCache: null,
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryChanges: null,
      } as unknown as LibraryIntegration;
    }

    function collectionDependenciesWith(
      controller: Record<string, unknown>,
      factories: Parameters<typeof createAppServiceBundle>[1] = {},
    ) {
      const createCollection: jest.MockedFunction<typeof createCollectionService> =
        jest.fn((_dependencies) => ({} as CollectionService));
      createAppServiceBundle(
        {
          database: {} as SqlDatabasePort,
          settingsRepository: {} as SettingsRepository,
          imageRepository: {} as ImageRepository,
          fileRepository: {} as CollectionFileRepository,
          initialSettings: DEFAULT_SETTINGS,
        },
        {
          createCollection,
          createDiscovery: jest.fn(() => ({
            restore: jest.fn(async () => ({ active: null, queued: [] })),
          } as unknown as DiscoveryService)),
          createLibraryIntegration: jest.fn(() => libraryWith(controller)),
          ...factories,
        },
      );
      return createCollection.mock.calls[0]![0];
    }

    function resumeHookFor(controller: Record<string, unknown>): () => void {
      const { onCollectionResumed } = collectionDependenciesWith(controller);
      return () => onCollectionResumed?.();
    }

    test('a saved rewind reaches libraryController.purgeCollectedImage through the discovery port', async () => {
      const nativeDatabase = new DatabaseSync(':memory:');
      const database = createNodeSqliteAdapter(nativeDatabase);
      try {
        await migrateDatabase(database);
        const imageRepository = createImageRepository(database);
        await imageRepository.insertCandidates([deckCandidate(1), deckCandidate(2)]);
        const purgeCollectedImage = jest.fn(async (_imageId: number) => undefined);
        const collectionService = {
          retryDownload: jest.fn(async () => ({ status: 'ready' as const })),
          revertPendingSave: jest.fn(async () => undefined),
        } as unknown as CollectionService;

        // The real discovery service, composed by the bundle: only its ports are fakes.
        const bundle = createAppServiceBundle(
          {
            database,
            settingsRepository: {} as SettingsRepository,
            imageRepository,
            fileRepository: {} as CollectionFileRepository,
            initialSettings: DEFAULT_SETTINGS,
          },
          {
            createCollection: jest.fn(() => collectionService),
            createLibraryIntegration: jest.fn(() => libraryWith({ purgeCollectedImage })),
            createProviderFetcher: () => jest.fn() as unknown as DiscoveryProviderFetcher,
          },
        );
        await bundle.discoveryService.restore();
        await bundle.discoveryService.decide(1, 'saved');

        await expect(bundle.discoveryService.rewind()).resolves.toMatchObject({
          status: 'rewound',
          entry: { imageId: 1, decision: 'saved' },
        });

        await waitFor(() => expect(purgeCollectedImage).toHaveBeenCalledWith(1));
        expect(collectionService.revertPendingSave).toHaveBeenCalledTimes(1);
      } finally {
        nativeDatabase.close();
      }
    });

    test('the discovery port resolves when this build has no library controller', async () => {
      const createDiscovery = jest.fn((_dependencies: { library?: DiscoveryLibraryPort }) => ({
        restore: jest.fn(async () => ({ active: null, queued: [] })),
      } as unknown as DiscoveryService));
      createAppServiceBundle(
        {
          database: {} as SqlDatabasePort,
          settingsRepository: {} as SettingsRepository,
          imageRepository: {} as ImageRepository,
          fileRepository: {} as CollectionFileRepository,
          initialSettings: DEFAULT_SETTINGS,
        },
        {
          createDiscovery: createDiscovery as unknown as typeof createDiscoveryService,
          createLibraryIntegration: jest.fn(() => libraryWith(null)),
        },
      );

      const { library } = createDiscovery.mock.calls[0]![0];
      expect(library).toBeDefined();
      await expect(library!.purgeCollectedImage(3)).resolves.toBeUndefined();
    });

    test('the resume sweep purges un-saved library rows first, and re-ingests only after that settles', async () => {
      let finishPurge!: (purged: number) => void;
      const purgeUndoneLibraryRows = jest.fn(() => new Promise<number>((resolve) => {
        finishPurge = resolve;
      }));
      const reingestMissingLibraryRows = jest.fn(async () => 0);
      const reprotectUncommittedOriginals = jest.fn(async () => 0);
      const noteMissingOriginals = jest.fn(async () => 0);
      const resume = resumeHookFor({
        purgeUndoneLibraryRows,
        noteMissingOriginals,
        reingestMissingLibraryRows,
        reprotectUncommittedOriginals,
        handOverExisting: jest.fn(async () => 0),
        sweepCacheOrphans: jest.fn(async () => 0),
      });

      resume();
      await waitFor(() => expect(purgeUndoneLibraryRows).toHaveBeenCalledTimes(1));
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(reingestMissingLibraryRows).not.toHaveBeenCalled();

      finishPurge(1);
      await waitFor(() => expect(reingestMissingLibraryRows).toHaveBeenCalledTimes(1));
    });

    test('a failing recovery purge still lets the backfill run, and a failing backfill does not break the next sweep', async () => {
      const purgeUndoneLibraryRows = jest.fn(async () => {
        throw new Error('database is busy');
      });
      const reingestMissingLibraryRows = jest.fn(async () => {
        throw new Error('database is busy');
      });
      const reprotectUncommittedOriginals = jest.fn(async () => 0);
      const noteMissingOriginals = jest.fn(async () => 0);
      const resume = resumeHookFor({
        purgeUndoneLibraryRows,
        noteMissingOriginals,
        reingestMissingLibraryRows,
        reprotectUncommittedOriginals,
        handOverExisting: jest.fn(async () => 0),
        sweepCacheOrphans: jest.fn(async () => 0),
      });

      expect(() => resume()).not.toThrow();
      await waitFor(() => expect(reingestMissingLibraryRows).toHaveBeenCalledTimes(1));

      expect(() => resume()).not.toThrow();
      await waitFor(() => expect(reingestMissingLibraryRows).toHaveBeenCalledTimes(2));
      expect(purgeUndoneLibraryRows).toHaveBeenCalledTimes(2);
    });

    test('the resume pass runs the recovery, the missing pass, the backfill, the re-protect, the migration, then the cache sweep', async () => {
      const order: string[] = [];
      const resume = resumeHookFor({
        purgeUndoneLibraryRows: async () => {
          order.push('recovery');
          return 0;
        },
        noteMissingOriginals: async () => {
          order.push('missing');
          return 0;
        },
        reingestMissingLibraryRows: async () => {
          order.push('backfill');
          return 0;
        },
        reprotectUncommittedOriginals: async () => {
          order.push('re-protect');
          return 0;
        },
        handOverExisting: async () => {
          order.push('migration');
          return 0;
        },
        sweepCacheOrphans: async () => {
          order.push('cache-sweep');
          return 0;
        },
      });

      resume();

      await waitFor(() => expect(order).toEqual([
        'recovery',
        'missing',
        'backfill',
        're-protect',
        'migration',
        'cache-sweep',
      ]));
    });

    test('a failing re-protect still lets the migration and the cache sweep run', async () => {
      const reprotectUncommittedOriginals = jest.fn(async () => {
        throw new Error('database is busy');
      });
      const handOverExisting = jest.fn(async () => 0);
      const resume = resumeHookFor({
        purgeUndoneLibraryRows: async () => 0,
        noteMissingOriginals: async () => 0,
        reingestMissingLibraryRows: async () => 0,
        reprotectUncommittedOriginals,
        handOverExisting,
        sweepCacheOrphans: async () => 0,
      });

      expect(() => resume()).not.toThrow();
      await waitFor(() => expect(handOverExisting).toHaveBeenCalledTimes(1));
      expect(reprotectUncommittedOriginals).toHaveBeenCalledTimes(1);
    });

    test('a failing migration does not break the next pass', async () => {
      const handOverExisting = jest.fn(async () => {
        throw new Error('database is busy');
      });
      const resume = resumeHookFor({
        purgeUndoneLibraryRows: async () => 0,
        noteMissingOriginals: async () => 0,
        reingestMissingLibraryRows: async () => 0,
        reprotectUncommittedOriginals: async () => 0,
        handOverExisting,
        sweepCacheOrphans: async () => 0,
      });

      expect(() => resume()).not.toThrow();
      await waitFor(() => expect(handOverExisting).toHaveBeenCalledTimes(1));

      expect(() => resume()).not.toThrow();
      await waitFor(() => expect(handOverExisting).toHaveBeenCalledTimes(2));
    });

    test('the library gets the collection\'s files', () => {
      const fileRepository = {} as CollectionFileRepository;
      const createLibraryIntegration = jest.fn(() => libraryWith(null));

      createAppServiceBundle(
        {
          database: {} as SqlDatabasePort,
          settingsRepository: {} as SettingsRepository,
          imageRepository: {} as ImageRepository,
          fileRepository,
          initialSettings: DEFAULT_SETTINGS,
        },
        {
          createDiscovery: jest.fn(() => ({
            restore: jest.fn(async () => ({ active: null, queued: [] })),
          } as unknown as DiscoveryService)),
          createLibraryIntegration,
        },
      );

      const [input] = createLibraryIntegration.mock.calls[0] as unknown as [
        { collectionFiles?: unknown },
      ];
      expect(input.collectionFiles).toBe(fileRepository);
    });

    test('the backup service gets the library\'s file store', () => {
      const wrapped = createAppBackupService as jest.Mock;
      const resources = {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
      };
      const factories = {
        createDiscovery: jest.fn(() => ({
          restore: jest.fn(async () => ({ active: null, queued: [] })),
        } as unknown as DiscoveryService)),
        createLibraryIntegration: jest.fn(() => libraryWith(null)),
      };
      const files = { deleteUnnamedFiles: jest.fn(async () => []) };

      wrapped.mockClear();
      createAppServiceBundle(resources, { ...factories, createLibraryFiles: () => files });
      expect(wrapped.mock.calls[0]?.[0].libraryFiles).toBe(files);

      wrapped.mockClear();
      createAppServiceBundle(resources, factories);
      expect(wrapped.mock.calls[0]?.[0].libraryFiles.deleteUnnamedFiles).toEqual(
        expect.any(Function),
      );
    });

    test('the backup service gets a native archived-file copier when the module is linked', async () => {
      const copyBackupFile = jest.fn(async (
        _archiveUri: string,
        _imageId: number,
        _destinationUri: string,
      ) => 123);
      const copyBackupImportFile = jest.fn(async (
        _archiveUri: string,
        plaintextSha256: string,
        _destinationUri: string,
      ) => ({ bytesWritten: 456, plaintextSha256 }));
      mockWaifuSyncService = { copyBackupFile, copyBackupImportFile };
      const wrapped = createAppBackupService as jest.Mock;
      const resources = {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
      };
      const factories = {
        createDiscovery: jest.fn(() => ({
          restore: jest.fn(async () => ({ active: null, queued: [] })),
        } as unknown as DiscoveryService)),
        createLibraryIntegration: jest.fn(() => libraryWith(null)),
      };

      wrapped.mockClear();
      createAppServiceBundle(resources, factories);
      const copyArchivedFile = wrapped.mock.calls[0]?.[0].copyArchivedFile as (
        archiveUri: string,
        imageId: number,
        destinationUri: string,
      ) => Promise<number>;
      const copyArchivedImportFile = wrapped.mock.calls[0]?.[0].copyArchivedImportFile as (
        archiveUri: string,
        plaintextSha256: string,
        destinationUri: string,
      ) => Promise<{ bytesWritten: number; plaintextSha256: string }>;

      await expect(copyArchivedFile('archive', 41, 'destination')).resolves.toBe(123);
      expect(copyBackupFile).toHaveBeenCalledWith('archive', 41, 'destination');
      const digest = 'a'.repeat(64);
      await expect(copyArchivedImportFile('archive', digest, 'destination')).resolves.toEqual({
        bytesWritten: 456,
        plaintextSha256: digest,
      });
      expect(copyBackupImportFile).toHaveBeenCalledWith('archive', digest, 'destination');
    });

    test('the backup service has no native archived-file copier when the module is absent', () => {
      mockWaifuSyncService = null;
      const wrapped = createAppBackupService as jest.Mock;
      const resources = {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
      };
      const factories = {
        createDiscovery: jest.fn(() => ({
          restore: jest.fn(async () => ({ active: null, queued: [] })),
        } as unknown as DiscoveryService)),
        createLibraryIntegration: jest.fn(() => libraryWith(null)),
      };

      wrapped.mockClear();
      createAppServiceBundle(resources, factories);

      expect(wrapped.mock.calls[0]?.[0]).not.toHaveProperty('copyArchivedFile');
      expect(wrapped.mock.calls[0]?.[0]).not.toHaveProperty('copyArchivedImportFile');
    });

    test('the collection hands a removed saved row to the library purge', async () => {
      const purgeCollectedImage = jest.fn(async (_imageId: number) => undefined);
      const deviceLibraryBytes = jest.fn(async () => 1234);
      const { onSavedRowRemoved, libraryBytes } = collectionDependenciesWith({
        purgeCollectedImage,
        deviceLibraryBytes,
      });

      onSavedRowRemoved!(7);

      expect(purgeCollectedImage).toHaveBeenCalledWith(7);
      await expect(libraryBytes!()).resolves.toBe(1234);
    });

    test.each<[
      string,
      'clear' | 'disconnect' | 'forget' | null,
      string[],
      { rows: 'deleted' | 'failed'; cloud: 'deleted' | 'failed' | 'skipped'; disconnected: boolean },
    ]>([
      [
        'everything succeeds',
        null,
        ['begin', 'clear', 'disconnect', 'forget', 'end:true'],
        { rows: 'deleted', cloud: 'deleted', disconnected: true },
      ],
      [
        'the disconnect fails: nothing is forgotten',
        'disconnect',
        ['begin', 'clear', 'disconnect', 'end:false'],
        { rows: 'deleted', cloud: 'failed', disconnected: false },
      ],
      [
        'the forget fails after the disconnect',
        'forget',
        ['begin', 'clear', 'disconnect', 'forget', 'end:true'],
        { rows: 'deleted', cloud: 'failed', disconnected: true },
      ],
      [
        'the library rows fail: no disconnect',
        'clear',
        ['begin', 'clear', 'end:false'],
        { rows: 'failed', cloud: 'skipped', disconnected: false },
      ],
    ])(
      "删除全部应用数据's library half runs in order when %s",
      async (_label, failing, expectedOrder, expectedOutcome) => {
        const order: string[] = [];
        const beginReset = async () => {
          order.push('begin');
          return {
            clearDevice: async () => {
              order.push('clear');
              if (failing === 'clear') throw new Error('clear');
              return { failed: [] };
            },
            forgetCloudLibraries: async () => {
              order.push('forget');
              if (failing === 'forget') throw new Error('forget');
            },
            settle: async () => undefined,
            end: ({ retire }: { retire: boolean }) => {
              order.push(`end:${retire}`);
            },
          };
        };
        const disconnectCloudLibrary = async () => {
          order.push('disconnect');
          if (failing === 'disconnect') throw new Error('disconnect');
        };

        const { libraryReset } = collectionDependenciesWith(
          { beginReset },
          { disconnectCloudLibrary },
        );
        const hold = await libraryReset!();
        const outcome = await hold.finish();
        hold.abandon();

        expect(order).toEqual(expectedOrder);
        expect(outcome).toMatchObject(expectedOutcome);
      },
    );

    test('abandon ends the held library session once and a second abandon adds nothing', async () => {
      const order: string[] = [];
      const beginReset = async () => {
        order.push('begin');
        return {
          clearDevice: async () => ({ failed: [] }),
          forgetCloudLibraries: async () => undefined,
          settle: async () => undefined,
          end: ({ retire }: { retire: boolean }) => {
            order.push(`end:${retire}`);
          },
        };
      };
      const { libraryReset } = collectionDependenciesWith({ beginReset });
      const hold = await libraryReset!();

      hold.abandon();
      hold.abandon();

      expect(order).toEqual(['begin', 'end:false']);
    });
  });

  test('threads a ready BYOS context and its status into the bundle', () => {
    const storageModeControl = { read: jest.fn(), set: jest.fn() };
    const libraryIntegration: LibraryIntegration = {
      libraryController: null,
      libraryActions: null,
      librarySync: null,
      libraryView: null,
      libraryCache: null,
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
      libraryChanges: null,
      libraryStorageMode: storageModeControl,
    };
    const createLibraryIntegration = jest.fn(() => libraryIntegration);
    const discoveryService = {
      restore: jest.fn(async () => ({ active: null, queued: [] })),
    } as unknown as DiscoveryService;
    const createDiscovery = jest.fn(() => discoveryService);
    const database = {} as SqlDatabasePort;
    const context = byosContext();
    const imageRepository = {} as ImageRepository;
    const fileRepository = {} as CollectionFileRepository;

    const bundle = createAppServiceBundle(
      {
        database,
        settingsRepository: {} as SettingsRepository,
        imageRepository,
        fileRepository,
        initialSettings: DEFAULT_SETTINGS,
        ...byosResourcesFor({ status: 'ready', context }),
      },
      {
        createDiscovery,
        createLibraryIntegration,
      },
    );

    // A resolved vault has to reach construction — the library core is chosen
    // once, here — and the verdict has to survive alongside it for the UI.
    // C3b: the app's own repository has to reach it too, or reconciliation
    // cannot rebuild an `images` row and every restored asset stays on the
    // cloud-only tile path on device even though the code for it exists.
    expect(createLibraryIntegration).toHaveBeenCalledWith({
      database,
      byos: context,
      images: imageRepository,
      collectionFiles: fileRepository,
      // K6-5 B: the sync foreground guard has to see provider downloads too.
      subscribeActiveDownloads: bundle.collectionService.subscribeActiveDownloads,
      localUnavailableCategory: 'auth_attention',
    });
    expect(bundle.byosStatus).toEqual({ status: 'ready', context });
    // Board #27 S3b: Settings' 本机存储 row reads the composition's own control.
    expect(bundle.libraryStorageMode).toBe(storageModeControl);
  });

  test('composes the local core for a locked vault without hiding the reason', () => {
    const libraryIntegration: LibraryIntegration = {
      libraryController: null,
      libraryActions: null,
      librarySync: null,
      libraryView: null,
      libraryCache: null,
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
      libraryChanges: null,
    };
    const createLibraryIntegration = jest.fn(() => libraryIntegration);
    const createDiscovery = jest.fn(() => ({
      restore: jest.fn(async () => ({ active: null, queued: [] })),
    } as unknown as DiscoveryService));
    const database = {} as SqlDatabasePort;
    const locked = {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'network',
    } as const;
    const imageRepository = {} as ImageRepository;
    const fileRepository = {} as CollectionFileRepository;

    const bundle = createAppServiceBundle(
      {
        database,
        settingsRepository: {} as SettingsRepository,
        imageRepository,
        fileRepository,
        initialSettings: DEFAULT_SETTINGS,
        ...byosResourcesFor(locked),
      },
      {
        createDiscovery,
        createLibraryIntegration,
      },
    );

    // There is nothing to talk to the bucket with, so the composition matches
    // the unconfigured one — but D3 forbids the status collapsing with it.
    expect(createLibraryIntegration).toHaveBeenCalledWith({
      database,
      byos: null,
      images: imageRepository,
      collectionFiles: fileRepository,
      subscribeActiveDownloads: bundle.collectionService.subscribeActiveDownloads,
      localUnavailableCategory: 'offline',
    });
    expect(bundle.byosStatus).toEqual(locked);
    expect(bundle.libraryStorageMode).toBeNull();
  });

  test('treats an unresolved BYOS status as unconfigured', () => {
    const createLibraryIntegration = jest.fn(() => ({
      libraryController: null,
      libraryActions: null,
      librarySync: null,
      libraryView: null,
      libraryCache: null,
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
    } as LibraryIntegration));
    const createDiscovery = jest.fn(() => ({
      restore: jest.fn(async () => ({ active: null, queued: [] })),
    } as unknown as DiscoveryService));
    const database = {} as SqlDatabasePort;
    const imageRepository = {} as ImageRepository;
    const fileRepository = {} as CollectionFileRepository;

    const bundle = createAppServiceBundle(
      {
        database,
        settingsRepository: {} as SettingsRepository,
        imageRepository,
        fileRepository,
        initialSettings: DEFAULT_SETTINGS,
      },
      {
        createDiscovery,
        createLibraryIntegration,
      },
    );

    // Fixtures and Store builds construct bundles without a resolver verdict;
    // consumers still get a status object rather than `undefined`.
    expect(bundle.byosStatus).toEqual({ status: 'unconfigured' });
    expect(createLibraryIntegration).toHaveBeenCalledWith({
      database,
      byos: null,
      images: imageRepository,
      collectionFiles: fileRepository,
      subscribeActiveDownloads: bundle.collectionService.subscribeActiveDownloads,
      localUnavailableCategory: 'auth_attention',
    });
    expect(byosResourcesFor({ status: 'unconfigured' })).toEqual({
      byos: null,
      byosStatus: { status: 'unconfigured' },
    });
  });

  test('passes an injected provider fetcher into discovery', () => {
    const fetchBatch = jest.fn() as unknown as DiscoveryProviderFetcher;
    const createProviderFetcher = jest.fn(() => fetchBatch);
    const createDiscovery = jest.fn(() => ({
      restore: jest.fn(async () => ({ active: null, queued: [] })),
    } as unknown as DiscoveryService));

    createAppServiceBundle(
      {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
      },
      {
        createDiscovery,
        createProviderFetcher,
      },
    );

    expect(createProviderFetcher).toHaveBeenCalledTimes(1);
    expect(createDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      fetchBatch,
    }));
  });

  test('exposes a live credential ref: a save reaches snapshot() without a bundle rebuild', async () => {
    // A real store over an in-memory port so the save→reload refresh is
    // exercised end to end, not stubbed. The map handed to the bundle is the
    // loaded snapshot. snapshot() and the default fetcher accessor
    // (`() => providerCredentialMap`) close over the SAME ref, so proving
    // snapshot() observes a save proves the discovery accessor does too.
    const backing = new Map<string, string>();
    const store = createProviderCredentialStore({
      getItemAsync: async (k) => backing.get(k) ?? null,
      setItemAsync: async (k, v) => void backing.set(k, v),
      deleteItemAsync: async (k) => void backing.delete(k),
    });

    const bundle = createAppServiceBundle(
      {
        database: {} as SqlDatabasePort,
        settingsRepository: {} as SettingsRepository,
        imageRepository: {} as ImageRepository,
        fileRepository: {} as CollectionFileRepository,
        initialSettings: DEFAULT_SETTINGS,
        providerCredentialStore: store,
        providerCredentialMap: {},
      },
      {
        createDiscovery: jest.fn(() => ({
          restore: jest.fn(async () => ({ active: null, queued: [] })),
        } as unknown as DiscoveryService)),
      },
    );
    // The stable accessor the discovery fan-out reads on each refill.
    const accessor = bundle.providerCredentials.snapshot;

    expect(accessor()).toEqual({});
    await bundle.providerCredentials.save('gelbooru', { apiKey: 'k', userId: 'u' });
    // The live ref is refreshed in place: the same accessor now returns the
    // saved credential (no bundle rebuild).
    expect(accessor()).toEqual({ gelbooru: { apiKey: 'k', userId: 'u' } });
    expect(backing.size).toBe(1);

    await bundle.providerCredentials.clear('gelbooru');
    expect(accessor()).toEqual({});
  });

  test('starts legacy collection recovery at app startup after discovery restore', async () => {
    const restored = deferred<{ active: null; queued: [] }>();
    const resumePendingDownloads = jest.fn().mockResolvedValue([]);
    const services = {
      discoveryService: {
        restore: jest.fn(() => restored.promise),
      } as unknown as DiscoveryService,
      collectionService: {
        resumePendingDownloads,
      } as unknown as CollectionService,
    };

    const startup = restoreAppServiceState(services);
    expect(resumePendingDownloads).not.toHaveBeenCalled();

    restored.resolve({ active: null, queued: [] });
    const { collectionRecovery } = await startup;
    await collectionRecovery;

    expect(resumePendingDownloads).toHaveBeenCalledTimes(1);
  });

  test('publishes a data revision when startup collection recovery settles', async () => {
    const recovery = deferred<boolean>();
    const snapshot = [{ id: 7 }] as StoredImage[];
    const imageRepository = {
      listCollection: jest.fn().mockResolvedValue(snapshot),
    } as unknown as ImageRepository;
    const bundle = appBundle({
      imageRepository,
      startupRecovery: recovery.promise,
    });
    const queryClient = appTestQueryClient();

    await render(providerElement(
      createElement(RevisionProbe),
      async () => bundle,
      undefined,
      queryClient,
    ));

    expect(await screen.findByText('revision:0')).toBeOnTheScreen();
    await act(async () => recovery.resolve(true));
    expect(await screen.findByText('revision:1')).toBeOnTheScreen();
    expect(imageRepository.listCollection).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(collectionQueryKey())).toEqual(snapshot);
  });

  test('K7 ㉕: a startup sweep that repaired nothing publishes nothing and bumps no revision', async () => {
    const recovery = deferred<boolean>();
    const imageRepository = {
      listCollection: jest.fn().mockResolvedValue([{ id: 7 }] as StoredImage[]),
    } as unknown as ImageRepository;
    const bundle = appBundle({ imageRepository, startupRecovery: recovery.promise });
    const queryClient = appTestQueryClient();

    await render(providerElement(
      createElement(RevisionProbe),
      async () => bundle,
      undefined,
      queryClient,
    ));
    expect(await screen.findByText('revision:0')).toBeOnTheScreen();

    await act(async () => recovery.resolve(false));
    // Positive marker first (the provider chain has several microtask hops),
    // then the negative assertions are meaningful.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(screen.getByText('revision:0')).toBeOnTheScreen();
    expect(imageRepository.listCollection).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(collectionQueryKey())).toBeUndefined();
  });

  test('K7 ㉕: restoreAppServiceState reports whether the sweep repaired anything', async () => {
    const services = {
      discoveryService: { restore: jest.fn(async () => ({ active: null, queued: [] })) } as unknown as DiscoveryService,
      collectionService: {
        resumePendingDownloads: jest.fn().mockResolvedValue([{ status: 'ready', uri: 'file:///x', reused: false }]),
      } as unknown as CollectionService,
    };
    await expect((await restoreAppServiceState(services)).collectionRecovery).resolves.toBe(true);

    services.collectionService = {
      resumePendingDownloads: jest.fn().mockResolvedValue([]),
    } as unknown as CollectionService;
    await expect((await restoreAppServiceState(services)).collectionRecovery).resolves.toBe(false);

    services.collectionService = {
      resumePendingDownloads: jest.fn().mockRejectedValue(new Error('blocked')),
    } as unknown as CollectionService;
    // A refused sweep over-publishes rather than hides.
    await expect((await restoreAppServiceState(services)).collectionRecovery).resolves.toBe(true);
  });

  test('invalidates queued candidates before saving and publishing settings', async () => {
    const events: string[] = [];
    const next = { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
    const settingsRepository = {
      save: jest.fn(async () => {
        events.push('saved');
        return next;
      }),
    } as unknown as SettingsRepository;
    const discoveryService = {
      invalidateQueuedCandidates: jest.fn(async () => {
        events.push('invalidated');
        return 0;
      }),
    } as unknown as DiscoveryService;

    const saved = await persistAppSettings(
      settingsRepository,
      discoveryService,
      next,
      () => events.push('published'),
    );

    expect(saved).toEqual(next);
    expect(events).toEqual(['invalidated', 'saved', 'published']);
    expect(discoveryService.invalidateQueuedCandidates).toHaveBeenCalledWith(next);
  });

  test('persists a language-only update without invalidating the discovery queue', async () => {
    const next = { ...DEFAULT_SETTINGS, language: 'zh-Hans' as const };
    const settingsRepository = {
      save: jest.fn(async () => next),
    } as unknown as SettingsRepository;
    const discoveryService = {
      invalidateQueuedCandidates: jest.fn(async () => 0),
    } as unknown as DiscoveryService;
    const publish = jest.fn();

    const saved = await persistAppSettings(
      settingsRepository,
      discoveryService,
      next,
      publish,
      undefined,
      DEFAULT_SETTINGS,
    );

    expect(saved).toEqual(next);
    expect(discoveryService.invalidateQueuedCandidates).not.toHaveBeenCalled();
    expect(settingsRepository.save).toHaveBeenCalledWith(next);
    expect(publish).toHaveBeenCalledWith(next);
  });

  test('normalizes the candidate in memory before invalidation and persistence', async () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      includedTags: ['WAIFU', 'Maid', 'maid', 'bad slug'],
      excludedTags: ['MAID', 'Uniform'],
    };
    const normalized = {
      ...DEFAULT_SETTINGS,
      includedTags: ['waifu', 'maid'],
      excludedTags: ['uniform'],
    };
    const settingsRepository = {
      save: jest.fn(async (value: unknown) => value as AppSettings),
    } as unknown as SettingsRepository;
    const discoveryService = {
      invalidateQueuedCandidates: jest.fn(async () => 0),
    } as unknown as DiscoveryService;

    const saved = await persistAppSettings(
      settingsRepository,
      discoveryService,
      raw,
      jest.fn(),
    );

    expect(settingsRepository.save).toHaveBeenCalledWith(normalized);
    expect(discoveryService.invalidateQueuedCandidates).toHaveBeenCalledWith(normalized);
    expect(saved).toEqual(normalized);
  });

  test('does not save or publish settings when queue invalidation fails', async () => {
    const events: string[] = [];
    const next = { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
    const settingsRepository = {
      save: jest.fn(async () => {
        events.push('saved');
        return next;
      }),
    } as unknown as SettingsRepository;
    const discoveryService = {
      invalidateQueuedCandidates: jest.fn(async () => {
        events.push('invalidated');
        throw new Error('invalidation failed');
      }),
    } as unknown as DiscoveryService;
    const publish = jest.fn(() => events.push('published'));
    const recordPersisted = jest.fn(() => events.push('recorded'));

    await expect(persistAppSettings(
      settingsRepository,
      discoveryService,
      next,
      publish,
      recordPersisted,
    )).rejects.toThrow('invalidation failed');

    expect(settingsRepository.save).not.toHaveBeenCalled();
    expect(recordPersisted).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(events).toEqual(['invalidated']);
  });

  test('publishes persisted settings through the mounted provider', async () => {
    const events: string[] = [];
    const next = { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
    const settingsRepository = {
      save: jest.fn(async () => {
        events.push('saved');
        return next;
      }),
    } as unknown as SettingsRepository;
    const discoveryService = {
      invalidateQueuedCandidates: jest.fn(async () => {
        events.push('invalidated');
        return 0;
      }),
    } as unknown as DiscoveryService;

    await render(providerElement(
      createElement(SettingsProbe),
      async () => appBundle({ settingsRepository, discoveryService }),
    ));

    expect(await screen.findByText('preload:0')).toBeOnTheScreen();
    expect(screen.getByText('revision:0')).toBeOnTheScreen();
    expect(screen.getByText('initial:false')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '更新设置' }));

    expect(await screen.findByText('preload:1080')).toBeOnTheScreen();
    expect(screen.getByText('revision:0')).toBeOnTheScreen();
    expect(events).toEqual(['invalidated', 'saved']);
  });

  test('serializes functional updates against the latest persisted settings', async () => {
    const firstWrite = deferred<void>();
    const events: string[] = [];
    let persisted = DEFAULT_SETTINGS;
    const save = jest.fn(async (value: unknown) => {
      const call = save.mock.calls.length;
      events.push(`save:${call}`);
      if (call === 1) await firstWrite.promise;
      persisted = value as AppSettings;
      return persisted;
    });
    const invalidateQueuedCandidates = jest.fn(async () => {
      events.push(`invalidate:${invalidateQueuedCandidates.mock.calls.length}`);
      return 0;
    });

    await render(providerElement(
      createElement(OverlappingSettingsProbe),
      async () => appBundle({
        settingsRepository: { save } as unknown as SettingsRepository,
        discoveryService: { invalidateQueuedCandidates } as unknown as DiscoveryService,
      }),
    ));

    expect(await screen.findByText('overlap:sfw:false:waifu:idle')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '连续更新设置' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => firstWrite.resolve());

    expect(await screen.findByText('overlap:mixed:true:waifu,maid:done')).toBeOnTheScreen();
    expect(persisted).toEqual(expect.objectContaining({
      nsfwMode: 'mixed',
      nsfwConfirmed: true,
      includedTags: ['waifu', 'maid'],
    }));
    expect(events).toEqual(['invalidate:1', 'save:1', 'invalidate:2', 'save:2']);
  });

  test('continues the serialized update queue after a rejected write', async () => {
    let persisted = DEFAULT_SETTINGS;
    const save = jest
      .fn<Promise<AppSettings>, [unknown]>()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockImplementationOnce(async (value) => {
        persisted = value as AppSettings;
        return persisted;
      });
    const invalidateQueuedCandidates = jest.fn(async () => 0);

    await render(providerElement(
      createElement(RejectedSettingsProbe),
      async () => appBundle({
        settingsRepository: { save } as unknown as SettingsRepository,
        discoveryService: { invalidateQueuedCandidates } as unknown as DiscoveryService,
      }),
    ));

    expect(await screen.findByText('rejected:0:true:idle')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '失败后继续更新' }));

    expect(await screen.findByText('rejected:0:false:done')).toBeOnTheScreen();
    expect(persisted).toEqual(expect.objectContaining({
      minWidth: 0,
      blurNsfwThumbnails: false,
    }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(invalidateQueuedCandidates).toHaveBeenCalledTimes(1);
  });

  test('keeps the old baseline and continues after queue invalidation rejects', async () => {
    const events: string[] = [];
    let persisted = DEFAULT_SETTINGS;
    const save = jest.fn(async (value: unknown) => {
      events.push(`save:${save.mock.calls.length}`);
      persisted = value as AppSettings;
      return persisted;
    });
    const invalidateQueuedCandidates = jest
      .fn<Promise<number>, []>()
      .mockImplementationOnce(async () => {
        events.push('invalidate:1');
        throw new Error('invalidation failed');
      })
      .mockImplementationOnce(async () => {
        events.push('invalidate:2');
        return 0;
      });

    await render(providerElement(
      createElement(RejectedSettingsProbe),
      async () => appBundle({
        settingsRepository: { save } as unknown as SettingsRepository,
        discoveryService: { invalidateQueuedCandidates } as unknown as DiscoveryService,
      }),
    ));

    expect(await screen.findByText('rejected:0:true:idle')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '失败后继续更新' }));

    expect(await screen.findByText('rejected:0:false:done')).toBeOnTheScreen();
    expect(persisted).toEqual(expect.objectContaining({
      minWidth: 0,
      blurNsfwThumbnails: false,
    }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['invalidate:1', 'save:1']);
  });

  test('synchronizes live settings after delete-all resets the settings stage', async () => {
    const customSettings = { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
    const result = deleteAllResult('deleted');
    const deleteAllData = jest.fn(async () => result);
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(collectionQueryKey(), [{ id: 7 }]);

    await render(providerElement(
      createElement(DeleteAllProbe),
      async () => appBundle({ initialSettings: customSettings, deleteAllData }),
      undefined,
      queryClient,
    ));

    expect(await screen.findByText('preload:1080')).toBeOnTheScreen();
    expect(screen.getByText('revision:0')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '删除全部数据' }));

    expect(await screen.findByText('reset:deleted')).toBeOnTheScreen();
    expect(screen.getByText('preload:0')).toBeOnTheScreen();
    expect(screen.getByText('revision:1')).toBeOnTheScreen();
    expect(queryClient.getQueryData(collectionQueryKey())).toEqual([]);
    expect(deleteAllData).toHaveBeenCalledTimes(1);
  });

  test('publishes data invalidation while preserving settings after a partial delete-all', async () => {
    const customSettings = { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
    const result = deleteAllResult('failed');
    const deleteAllData = jest.fn(async () => result);
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(collectionQueryKey(), [{ id: 7 }]);

    await render(providerElement(
      createElement(DeleteAllProbe),
      async () => appBundle({ initialSettings: customSettings, deleteAllData }),
      undefined,
      queryClient,
    ));

    expect(await screen.findByText('preload:1080')).toBeOnTheScreen();
    expect(screen.getByText('revision:0')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '删除全部数据' }));

    expect(await screen.findByText('reset:failed')).toBeOnTheScreen();
    expect(screen.getByText('preload:1080')).toBeOnTheScreen();
    expect(screen.getByText('revision:1')).toBeOnTheScreen();
    expect(queryClient.getQueryData(collectionQueryKey())).toEqual([]);
    expect(deleteAllData).toHaveBeenCalledTimes(1);
  });

  test('republishes the surviving repository snapshot when delete-all cannot clear the database', async () => {
    const surviving = [{ id: 8 }] as StoredImage[];
    const result: DeleteAllDataResult = {
      ok: false,
      files: { deleted: [], failed: [] },
      database: {
        status: 'failed',
        deletedRows: 0,
        error: { code: 'database_failed', message: 'database busy' },
      },
      settings: { status: 'skipped', error: null },
      library: { status: 'deleted', cloud: 'skipped', disconnected: false, error: null },
      remaining: ['database'],
    };
    const imageRepository = {
      listCollection: jest.fn().mockResolvedValue(surviving),
    } as unknown as ImageRepository;
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(collectionQueryKey(), [{ id: 7 }]);

    await render(providerElement(
      createElement(DeleteAllProbe),
      async () => appBundle({
        deleteAllData: jest.fn(async () => result),
        imageRepository,
      }),
      undefined,
      queryClient,
    ));
    await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

    expect(await screen.findByText('reset:skipped')).toBeOnTheScreen();
    expect(imageRepository.listCollection).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(collectionQueryKey())).toEqual(surviving);
  });

  test('a delete-all that disconnected a bound library recomposes the services', async () => {
    const closeDatabase = jest.fn(async () => undefined);
    lastDeleteAllResult = null;
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'ready', context: byosContext() },
        closeDatabase,
        deleteAllData: jest.fn(async (): Promise<DeleteAllDataResult> => ({
          ...deleteAllResult('deleted'),
          library: { status: 'deleted', cloud: 'deleted', disconnected: true, error: null },
        })),
      }))
      .mockResolvedValueOnce(appBundle());

    await render(providerElement(createElement(DeleteAllProbe), initializer));
    await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(lastDeleteAllResult).toEqual(expect.objectContaining({ recomposed: true }));
  });

  test('a publish that throws after a successful disconnect still recomposes', async () => {
    const closeDatabase = jest.fn(async () => undefined);
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(['discovery', 'deck'], { active: { id: 2342 } });
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'ready', context: byosContext() },
        closeDatabase,
        deleteAllData: jest.fn(async (): Promise<DeleteAllDataResult> => ({
          ...deleteAllResult('deleted'),
          library: { status: 'deleted', cloud: 'deleted', disconnected: true, error: null },
        })),
      }))
      .mockResolvedValueOnce(appBundle());
    lastDeleteAllResult = null;

    await render(providerElement(
      createElement(DeleteAllProbe),
      initializer,
      undefined,
      queryClient,
    ));
    await screen.findByText('revision:0');
    const language = jest.spyOn(i18n, 'applyLanguagePreference')
      .mockRejectedValueOnce(new Error('language'));
    try {
      await fireEvent.press(screen.getByRole('button', { name: '删除全部数据' }));
      await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
      expect(lastDeleteAllResult).toEqual(expect.objectContaining({ recomposed: true }));
    } finally {
      language.mockRestore();
    }
  });

  test('without a recompose a publish failure still rejects, and the revision moves', async () => {
    lastDeleteAllError = null;
    const initializer = jest.fn(async () => appBundle({
      byosStatus: { status: 'unconfigured' },
      deleteAllData: jest.fn(async (): Promise<DeleteAllDataResult> => deleteAllResult('deleted')),
    }));

    await render(providerElement(
      createElement(DeleteAllProbe),
      initializer,
    ));
    await screen.findByText('revision:0');
    const language = jest.spyOn(i18n, 'applyLanguagePreference')
      .mockRejectedValueOnce(new Error('language'));
    try {
      await fireEvent.press(screen.getByRole('button', { name: '删除全部数据' }));
      await waitFor(() => expect(lastDeleteAllError).toEqual(expect.objectContaining({ message: 'language' })));
      expect(screen.getByText('revision:1')).toBeOnTheScreen();
      expect(initializer).toHaveBeenCalledTimes(1);
    } finally {
      language.mockRestore();
    }
  });

  test.each<[string, ByosStatus, boolean]>([
    ['the disconnect failed', { status: 'ready', context: byosContext() }, false],
    ['no library was bound', { status: 'unconfigured' }, true],
  ])('no recompose when %s', async (_label, byosStatus, disconnected) => {
    const initializer = jest.fn(async () => appBundle({
      byosStatus,
      deleteAllData: jest.fn(async (): Promise<DeleteAllDataResult> => ({
        ...deleteAllResult('deleted'),
        library: {
          status: 'deleted',
          cloud: disconnected ? 'deleted' : 'failed',
          disconnected,
          error: null,
        },
      })),
    }));

    await render(providerElement(createElement(DeleteAllProbe), initializer));
    await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

    expect(await screen.findByText('reset:deleted')).toBeOnTheScreen();
    expect(screen.getByText('recomposed:false')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  test('a delete-all that recomposes drops every cached query, so Discover cannot mount on the deleted deck', async () => {
    const deletedDeck = { active: { id: 2342 }, queued: [] };
    const closeDatabase = jest.fn(async () => undefined);
    const queryClient = appTestQueryClient();
    let cacheAtRestart: string[] | null = null;
    queryClient.setQueryData(['discovery', 'deck'], deletedDeck);
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'ready', context: byosContext() },
        closeDatabase,
        deleteAllData: jest.fn(async (): Promise<DeleteAllDataResult> => ({
          ...deleteAllResult('deleted'),
          library: { status: 'deleted', cloud: 'deleted', disconnected: true, error: null },
        })),
      }))
      .mockImplementationOnce(async () => {
        cacheAtRestart = queryClient.getQueryCache().getAll().map((query) => query.queryHash);
        return appBundle();
      });

    await render(providerElement(
      createElement(DeleteAllProbe),
      initializer,
      undefined,
      queryClient,
    ));
    await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['discovery', 'deck'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(cacheAtRestart).toEqual([]);
  });

  test.each<[string, ByosStatus, boolean]>([
    ['the disconnect failed', { status: 'ready', context: byosContext() }, false],
    ['no library was bound', { status: 'unconfigured' }, true],
  ])('a delete-all that does not recompose keeps the cached deck when %s', async (_label, byosStatus, disconnected) => {
    const deletedDeck = { active: { id: 2342 }, queued: [] };
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(['discovery', 'deck'], deletedDeck);
    const initializer = jest.fn(async () => appBundle({
      byosStatus,
      deleteAllData: jest.fn(async (): Promise<DeleteAllDataResult> => ({
        ...deleteAllResult('deleted'),
        library: {
          status: 'deleted',
          cloud: disconnected ? 'deleted' : 'failed',
          disconnected,
          error: null,
        },
      })),
    }));

    await render(providerElement(
      createElement(DeleteAllProbe),
      initializer,
      undefined,
      queryClient,
    ));
    await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

    expect(await screen.findByText('reset:deleted')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['discovery', 'deck'])).toEqual(deletedDeck);
  });

  test('waits for accepted settings writes, rejects concurrent writes, then resets to defaults', async () => {
    const heldSave = deferred<void>();
    const heldDelete = deferred<DeleteAllDataResult>();
    const events: string[] = [];
    const save = jest.fn(async (value: unknown) => {
      events.push('save:start');
      await heldSave.promise;
      events.push('save:end');
      return value as AppSettings;
    });
    const invalidateQueuedCandidates = jest.fn(async () => {
      events.push('invalidate');
      return 0;
    });
    const deleteAllData = jest.fn(async () => {
      events.push('delete:start');
      const result = await heldDelete.promise;
      events.push('delete:end');
      return result;
    });

    await render(providerElement(
      createElement(SettingsDeleteBarrierProbe),
      async () => appBundle({
        settingsRepository: { save } as unknown as SettingsRepository,
        discoveryService: { invalidateQueuedCandidates } as unknown as DiscoveryService,
        deleteAllData,
      }),
    ));

    expect(await screen.findByText('barrier:0:idle:idle:idle')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '开始屏障设置更新' }));
    await waitFor(() => expect(events).toEqual(['invalidate', 'save:start']));

    await fireEvent.press(screen.getByRole('button', { name: '排队删除全部数据' }));
    expect(deleteAllData).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: '尝试屏障期间更新' }));
    expect(await screen.findByText('barrier:0:pending:pending:rejected')).toBeOnTheScreen();

    await act(async () => heldSave.resolve());
    await waitFor(() => expect(deleteAllData).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['invalidate', 'save:start', 'save:end', 'delete:start']);

    await act(async () => heldDelete.resolve(deleteAllResult('deleted')));
    expect(await screen.findByText('barrier:0:saved:deleted:rejected')).toBeOnTheScreen();
    expect(save).toHaveBeenCalledTimes(1);
    expect(invalidateQueuedCandidates).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'invalidate',
      'save:start',
      'save:end',
      'delete:start',
      'delete:end',
    ]);

    await fireEvent.press(screen.getByRole('button', { name: '尝试屏障期间更新' }));
    expect(await screen.findByText('barrier:1440:saved:deleted:saved')).toBeOnTheScreen();
    expect(save).toHaveBeenCalledTimes(2);
    expect(invalidateQueuedCandidates).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({
      ...DEFAULT_SETTINGS,
      minWidth: 1440,
    });
  });

  test('rejects writes during a failed delete and accepts later updates after the barrier releases', async () => {
    const heldDelete = deferred<DeleteAllDataResult>();
    const save = jest.fn(async (value: unknown) => value as AppSettings);
    const invalidateQueuedCandidates = jest.fn(async () => 0);
    const deleteAllData = jest.fn(() => heldDelete.promise);

    await render(providerElement(
      createElement(SettingsDeleteBarrierProbe),
      async () => appBundle({
        settingsRepository: { save } as unknown as SettingsRepository,
        discoveryService: { invalidateQueuedCandidates } as unknown as DiscoveryService,
        deleteAllData,
      }),
    ));

    expect(await screen.findByText('barrier:0:idle:idle:idle')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '排队删除全部数据' }));
    await waitFor(() => expect(deleteAllData).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: '尝试屏障期间更新' }));

    expect(await screen.findByText('barrier:0:idle:pending:rejected')).toBeOnTheScreen();
    expect(save).not.toHaveBeenCalled();

    await act(async () => heldDelete.reject(new Error('delete failed')));
    expect(await screen.findByText('barrier:0:idle:failed:rejected')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '尝试屏障期间更新' }));

    expect(await screen.findByText('barrier:1440:idle:failed:saved')).toBeOnTheScreen();
    expect(save).toHaveBeenCalledTimes(1);
    expect(invalidateQueuedCandidates).toHaveBeenCalledTimes(1);
  });

  test('runs distinct history reset commands and publishes a fresh discovery revision', async () => {
    const events: string[] = [];
    const resetDismissedHistory = jest.fn(async () => {
      events.push('reset-dismissed');
      return 2;
    });
    const resetDiscoveryHistory = jest.fn(async () => {
      events.push('reset-discovery');
      return 4;
    });
    const restore = jest.fn(async () => {
      events.push('restore-deck');
      return { active: null, queued: [] };
    });
    const release = jest.fn(() => events.push('release-reset'));
    const beginReset = jest.fn(async () => {
      events.push('begin-reset');
      return { release };
    });
    const bundle = appBundle({
      discoveryService: { restore } as unknown as DiscoveryService,
    });
    bundle.imageRepository = {
      resetDismissedHistory,
      resetDiscoveryHistory,
    } as unknown as ImageRepository;
    bundle.resetCoordinator = { beginReset } as unknown as DataResetCoordinator;

    await render(providerElement(
      createElement(HistoryResetProbe),
      async () => bundle,
    ));

    expect(await screen.findByText('revision:0')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'provider reset dismissed' }));
    expect(await screen.findByText('history:dismissed:2')).toBeOnTheScreen();
    expect(screen.getByText('revision:1')).toBeOnTheScreen();
    expect(events).toEqual([
      'begin-reset',
      'reset-dismissed',
      'release-reset',
      'restore-deck',
    ]);
    expect(resetDiscoveryHistory).not.toHaveBeenCalled();

    events.length = 0;
    await fireEvent.press(screen.getByRole('button', { name: 'provider reset discovery' }));
    expect(await screen.findByText('history:discovery:4')).toBeOnTheScreen();
    expect(screen.getByText('revision:2')).toBeOnTheScreen();
    expect(events).toEqual([
      'begin-reset',
      'reset-discovery',
      'release-reset',
      'restore-deck',
    ]);
    expect(resetDismissedHistory).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['resolves', false, 'exported'],
    ['rejects', true, 'failed'],
  ])('board #32: a backup export holds the exclusive lease and begins no reset (createAndShare %s)', (_name, rejects, status) => {
    test('releases once after createAndShare', async () => {
      const events: string[] = [];
      const release = jest.fn(() => events.push('release'));
      const beginExclusive = jest.fn(async () => {
        events.push('begin-exclusive');
        return { release };
      });
      const beginReset = jest.fn(async () => ({ release: jest.fn() }));
      const createAndShare = jest.fn(async () => {
        events.push('create-and-share');
        if (rejects) throw new Error('share failed');
        return {} as BackupSummary;
      });
      const bundle = appBundle();
      bundle.backupService = {
        createArchive: jest.fn(),
        createAndShare,
        prepareRestoreFromUri: jest.fn(),
        pickAndPrepareRestore: jest.fn(),
      };
      bundle.resetCoordinator = {
        beginExclusive,
        beginReset,
      } as unknown as DataResetCoordinator;

      await render(providerElement(createElement(BackupExportProbe), async () => bundle));
      await fireEvent.press(
        await screen.findByRole('button', { name: 'provider export backup' }),
      );

      expect(await screen.findByText(`export:${status}`)).toBeOnTheScreen();
      expect(beginExclusive).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(beginReset).not.toHaveBeenCalled();
      expect(events).toEqual(['begin-exclusive', 'create-and-share', 'release']);
    });
  });

  test('closes and reinitializes app services after restoring a full backup', async () => {
    const release = jest.fn();
    const beginReset = jest.fn(async () => ({ release }));
    const closeDatabase = jest.fn(async () => undefined);
    const dispose = jest.fn(async () => undefined);
    const apply = jest.fn(async () => ({ ...DEFAULT_SETTINGS, minWidth: 1080 as const }));
    const pickAndPrepareRestore = jest.fn(async () => ({
      summary: {
        formatVersion: 1,
        applicationId: 'app.waifudeck.mobile',
        appVersion: '1.1.0',
        createdAt: 123,
        imageCount: 4,
        fileCount: 3,
        totalFileBytes: 3_000_000,
        restoredFileCount: 3,
        missingFileCount: 0,
      },
      apply,
      dispose,
    }));
    const first = appBundle({ closeDatabase });
    first.backupService = {
      createArchive: jest.fn(),
      createAndShare: jest.fn(),
      prepareRestoreFromUri: jest.fn(),
      pickAndPrepareRestore,
    };
    first.resetCoordinator = {
      beginExclusive: async () => ({ release: () => undefined }),
      beginReset,
    } as unknown as DataResetCoordinator;
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(appBundle({
        databaseId: 'restored',
        initialSettings: { ...DEFAULT_SETTINGS, minWidth: 1080 },
      }));

    await render(providerElement(createElement(BackupRestoreProbe), initializer));
    await fireEvent.press(
      await screen.findByRole('button', { name: 'provider restore backup' }),
    );

    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(pickAndPrepareRestore).toHaveBeenCalledTimes(1);
    expect(beginReset).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['succeeds', false],
    ['fails', true],
  ])('board #27 S1b T8: a restore that %s', (_label, applyFails) => {
    test('holds the library around the replacement and retires it before the lease is released', async () => {
      const events: string[] = [];
      const release = jest.fn(() => events.push('release'));
      const beginReset = jest.fn(async () => {
        events.push('lease');
        return { release };
      });
      const closeDatabase = jest.fn(async () => {
        events.push('close');
      });
      const apply = jest.fn(async () => {
        events.push('apply');
        if (applyFails) throw new Error('apply failed');
        return { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
      });
      const pickAndPrepareRestore = jest.fn(async () => ({
        summary: {
          formatVersion: 1,
          applicationId: 'app.waifudeck.mobile',
          appVersion: '1.1.0',
          createdAt: 123,
          imageCount: 4,
          fileCount: 3,
          totalFileBytes: 3_000_000,
          restoredFileCount: 3,
          missingFileCount: 0,
        },
        apply,
        dispose: jest.fn(async () => undefined),
      }));
      const first = appBundle({ closeDatabase });
      first.backupService = {
        createArchive: jest.fn(),
        createAndShare: jest.fn(),
        prepareRestoreFromUri: jest.fn(),
        pickAndPrepareRestore,
      };
      first.resetCoordinator = {
        beginExclusive: async () => ({ release: () => undefined }),
        beginReset,
      } as unknown as DataResetCoordinator;
      first.libraryController = {
        beginReset: async () => {
          events.push('hold');
          return {
            clearDevice: async () => ({ failed: [] }),
            forgetCloudLibraries: async () => undefined,
            settle: async () => {
              events.push('settle');
            },
            end: ({ retire }: { retire: boolean }) => {
              events.push(`end:${retire}`);
            },
          };
        },
      } as unknown as AppServiceBundle['libraryController'];
      const initializer = jest
        .fn<Promise<AppServiceBundle>, []>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(appBundle({ databaseId: 'restored' }));

      let outcome: 'restored' | 'failed' | null = null;
      function OutcomeProbe() {
        const { restoreFullBackup } = useAppServices();
        return createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'provider restore backup',
            onPress: () => void restoreFullBackup().then(
              () => { outcome = 'restored'; },
              () => { outcome = 'failed'; },
            ),
          },
          createElement(Text, null, 'provider restore backup'),
        );
      }

      await render(providerElement(createElement(OutcomeProbe), initializer));
      await fireEvent.press(
        await screen.findByRole('button', { name: 'provider restore backup' }),
      );

      await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(outcome).toBe(applyFails ? 'failed' : 'restored'));
      expect(events.slice(0, 7)).toEqual([
        'lease', 'hold', 'settle', 'close', 'apply', 'end:true', 'release',
      ]);
      expect(events.slice(7).every((event) => event === 'close')).toBe(true);
    });
  });

  describe('board #27 S1b T8: the restore\'s library hold, when it is slow or fails', () => {
    function restoreWithLibrary(
      libraryBeginReset: (events: string[]) => Promise<unknown>,
    ) {
      const events: string[] = [];
      const release = jest.fn(() => events.push('release'));
      const beginReset = jest.fn(async () => {
        events.push('lease');
        return { release };
      });
      const closeDatabase = jest.fn(async () => {
        events.push('close');
      });
      const apply = jest.fn(async () => {
        events.push('apply');
        return { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
      });
      const pickAndPrepareRestore = jest.fn(async () => ({
        summary: {
          formatVersion: 1,
          applicationId: 'app.waifudeck.mobile',
          appVersion: '1.1.0',
          createdAt: 123,
          imageCount: 4,
          fileCount: 3,
          totalFileBytes: 3_000_000,
          restoredFileCount: 3,
          missingFileCount: 0,
        },
        apply,
        dispose: jest.fn(async () => undefined),
      }));
      const first = appBundle({ closeDatabase });
      first.backupService = {
        createArchive: jest.fn(),
        createAndShare: jest.fn(),
        prepareRestoreFromUri: jest.fn(),
        pickAndPrepareRestore,
      };
      first.resetCoordinator = {
        beginExclusive: async () => ({ release: () => undefined }),
        beginReset,
      } as unknown as DataResetCoordinator;
      first.libraryController = {
        beginReset: () => libraryBeginReset(events),
      } as unknown as AppServiceBundle['libraryController'];
      const initializer = jest
        .fn<Promise<AppServiceBundle>, []>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(appBundle({ databaseId: 'restored' }));

      const result: { outcome: 'restored' | 'failed' | null } = { outcome: null };
      function OutcomeProbe() {
        const { restoreFullBackup } = useAppServices();
        return createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'provider restore backup',
            onPress: () => void restoreFullBackup().then(
              () => { result.outcome = 'restored'; },
              () => { result.outcome = 'failed'; },
            ),
          },
          createElement(Text, null, 'provider restore backup'),
        );
      }

      const start = async () => {
        await render(providerElement(createElement(OutcomeProbe), initializer));
        await fireEvent.press(
          await screen.findByRole('button', { name: 'provider restore backup' }),
        );
      };
      return { events, release, closeDatabase, apply, initializer, result, start };
    }

    function session(events: string[], endThrows = false) {
      return {
        clearDevice: async () => ({ failed: [] }),
        forgetCloudLibraries: async () => undefined,
        settle: async () => {
          events.push('settle');
        },
        end: ({ retire }: { retire: boolean }) => {
          events.push(`end:${retire}`);
          if (endThrows) throw new Error('the library end failed');
        },
      };
    }

    test('a library end that throws still releases the lease, and the restore rejects', async () => {
      const harness = restoreWithLibrary(async (events) => {
        events.push('hold');
        return session(events, true);
      });

      await harness.start();

      await waitFor(() => expect(harness.initializer).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(harness.result.outcome).toBe('failed'));
      expect(harness.release).toHaveBeenCalledTimes(1);
      expect(harness.events.slice(0, 7)).toEqual([
        'lease', 'hold', 'settle', 'close', 'apply', 'end:true', 'release',
      ]);
    });

    test('the loading screen is up while the restore waits for the library hold', async () => {
      const hold = deferred<ReturnType<typeof session>>();
      const harness = restoreWithLibrary((events) => {
        events.push('hold');
        return hold.promise;
      });

      await harness.start();

      await waitFor(() => expect(harness.events).toEqual(['lease', 'hold']));
      // The provider has dropped its children for the loading screen.
      expect(
        screen.queryByRole('button', { name: 'provider restore backup' }),
      ).toBeNull();
      expect(harness.closeDatabase).not.toHaveBeenCalled();
      expect(harness.initializer).toHaveBeenCalledTimes(1);

      await act(async () => hold.resolve(session(harness.events)));

      await waitFor(() => expect(harness.initializer).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(harness.result.outcome).toBe('restored'));
      expect(harness.release).toHaveBeenCalledTimes(1);
    });

    test('the restore waits for the library to settle before it closes and replaces the database', async () => {
      const settled = deferred<void>();
      const harness = restoreWithLibrary(async (events) => {
        events.push('hold');
        return {
          ...session(events),
          settle: () => {
            events.push('settle');
            return settled.promise;
          },
        };
      });

      await harness.start();

      await waitFor(() => expect(harness.events).toContain('settle'));
      await act(async () => {
        await Promise.resolve();
      });
      // OQ-8b: running ingests, uploads and purges finish before the file is
      // replaced, so none of them can commit into the restored database.
      expect(harness.events).toEqual(['lease', 'hold', 'settle']);
      expect(harness.closeDatabase).not.toHaveBeenCalled();
      expect(harness.apply).not.toHaveBeenCalled();

      await act(async () => settled.resolve());

      await waitFor(() => expect(harness.result.outcome).toBe('restored'));
      expect(harness.events.slice(0, 7)).toEqual([
        'lease', 'hold', 'settle', 'close', 'apply', 'end:true', 'release',
      ]);
    });

    test('a library hold that rejects still reloads the services and releases the lease', async () => {
      const harness = restoreWithLibrary(async () => {
        throw new Error('the hold failed');
      });

      await harness.start();

      await waitFor(() => expect(harness.initializer).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(harness.result.outcome).toBe('failed'));
      expect(harness.release).toHaveBeenCalledTimes(1);
      expect(harness.apply).not.toHaveBeenCalled();
      // The restore never closed the database: the one close is the reload's
      // own, of the superseded bundle, after the lease was released.
      expect(harness.events).toEqual(['lease', 'release', 'close']);
      expect(harness.closeDatabase).toHaveBeenCalledTimes(1);
    });
  });

  describe('board #32: a restore takes the reset lease only to apply', () => {
    function preparedBackup(events: string[]) {
      return {
        summary: {
          formatVersion: 1,
          applicationId: 'app.waifudeck.mobile',
          appVersion: '1.1.0',
          createdAt: 123,
          imageCount: 4,
          fileCount: 3,
          totalFileBytes: 3_000_000,
          restoredFileCount: 3,
          missingFileCount: 0,
        },
        apply: jest.fn(async () => {
          events.push('apply');
          return { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
        }),
        dispose: jest.fn(async () => undefined),
      };
    }

    function restoreHarness(
      events: string[],
      pickAndPrepareRestore: () => Promise<unknown>,
      resetCoordinator: DataResetCoordinator,
    ) {
      const first = appBundle({
        closeDatabase: jest.fn(async () => {
          events.push('close');
        }),
      });
      first.backupService = {
        createArchive: jest.fn(),
        createAndShare: jest.fn(),
        prepareRestoreFromUri: jest.fn(),
        pickAndPrepareRestore,
      } as unknown as AppServiceBundle['backupService'];
      first.resetCoordinator = resetCoordinator;
      first.libraryController = {
        beginReset: async () => {
          events.push('hold');
          return {
            clearDevice: async () => ({ failed: [] }),
            forgetCloudLibraries: async () => undefined,
            settle: async () => {
              events.push('settle');
            },
            end: ({ retire }: { retire: boolean }) => {
              events.push(`end:${retire}`);
            },
          };
        },
      } as unknown as AppServiceBundle['libraryController'];
      const initializer = jest
        .fn<Promise<AppServiceBundle>, []>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(appBundle({ databaseId: 'restored' }));

      const result: {
        outcome: 'restored' | 'failed' | null;
        value: unknown;
      } = { outcome: null, value: undefined };
      function OutcomeProbe() {
        const { restoreFullBackup } = useAppServices();
        return createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'provider restore backup',
            onPress: () => void restoreFullBackup().then(
              (value) => {
                result.outcome = 'restored';
                result.value = value;
              },
              (error: unknown) => {
                result.outcome = 'failed';
                result.value = error;
              },
            ),
          },
          createElement(Text, null, 'provider restore backup'),
        );
      }

      const start = async () => {
        await render(providerElement(createElement(OutcomeProbe), initializer));
        await fireEvent.press(
          await screen.findByRole('button', { name: 'provider restore backup' }),
        );
      };
      return { initializer, result, start };
    }

    function recordingCoordinator(events: string[]) {
      const releaseExclusive = jest.fn(() => events.push('release-exclusive'));
      const beginExclusive = jest.fn(async () => {
        events.push('exclusive');
        return { release: releaseExclusive };
      });
      const release = jest.fn(() => events.push('release'));
      const beginReset = jest.fn(async () => {
        events.push('lease');
        return { release };
      });
      return {
        beginExclusive,
        releaseExclusive,
        beginReset,
        release,
        coordinator: { beginExclusive, beginReset } as unknown as DataResetCoordinator,
      };
    }

    test('a cancelled pick begins no reset', async () => {
      const events: string[] = [];
      const doubles = recordingCoordinator(events);
      const harness = restoreHarness(events, async () => null, doubles.coordinator);

      await harness.start();

      await waitFor(() => expect(harness.result.outcome).toBe('restored'));
      expect(harness.result.value).toBeNull();
      expect(doubles.beginExclusive).toHaveBeenCalledTimes(1);
      expect(doubles.releaseExclusive).toHaveBeenCalledTimes(1);
      expect(doubles.beginReset).not.toHaveBeenCalled();
      expect(harness.initializer).toHaveBeenCalledTimes(1);
    });

    test('a backup that fails to prepare begins no reset, and the restore rejects', async () => {
      const events: string[] = [];
      const doubles = recordingCoordinator(events);
      const failure = new Error('the backup could not be prepared');
      const harness = restoreHarness(
        events,
        async () => {
          throw failure;
        },
        doubles.coordinator,
      );

      await harness.start();

      await waitFor(() => expect(harness.result.outcome).toBe('failed'));
      expect(harness.result.value).toBe(failure);
      expect(doubles.beginExclusive).toHaveBeenCalledTimes(1);
      expect(doubles.releaseExclusive).toHaveBeenCalledTimes(1);
      expect(doubles.beginReset).not.toHaveBeenCalled();
      expect(harness.initializer).toHaveBeenCalledTimes(1);
    });

    test('a prepared backup releases the exclusive hold before the reset lease', async () => {
      const events: string[] = [];
      const doubles = recordingCoordinator(events);
      const harness = restoreHarness(
        events,
        async () => preparedBackup(events),
        doubles.coordinator,
      );

      await harness.start();

      await waitFor(() => expect(harness.initializer).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(harness.result.outcome).toBe('restored'));
      expect(events.slice(0, 9)).toEqual([
        'exclusive', 'release-exclusive',
        'lease', 'hold', 'settle', 'close', 'apply', 'end:true', 'release',
      ]);
    });

    test('a mutation queued while the pick is pending starts only after the restore has applied', async () => {
      const events: string[] = [];
      const coordinator = createDataResetCoordinator();
      const pick = deferred<unknown>();
      const pickAndPrepareRestore = jest.fn(() => pick.promise);
      const harness = restoreHarness(events, pickAndPrepareRestore, coordinator);

      await harness.start();
      await waitFor(() => expect(pickAndPrepareRestore).toHaveBeenCalledTimes(1));

      // A mutation that slipped in between the hold's release and the reset
      // lease could sweep the restore's staged files.
      void coordinator.runMutation(async () => {
        events.push('queued-op');
      });
      await act(async () => pick.resolve(preparedBackup(events)));

      await waitFor(() => expect(harness.result.outcome).toBe('restored'));
      await waitFor(() => expect(events).toContain('queued-op'));
      expect(events).toContain('apply');
      expect(events.indexOf('apply')).toBeLessThan(events.indexOf('queued-op'));
    });
  });

  test('a restore whose language step fails still drops the cache before the new composition starts', async () => {
    const staleDeck = { active: { id: 2342 }, queued: [] };
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(['discovery', 'deck'], staleDeck);
    const language = jest.spyOn(i18n, 'applyLanguagePreference')
      .mockRejectedValueOnce(new Error('language failed'));
    const release = jest.fn();
    const beginReset = jest.fn(async () => ({ release }));
    const closeDatabase = jest.fn(async () => undefined);
    const apply = jest.fn(async () => ({ ...DEFAULT_SETTINGS, minWidth: 1080 as const }));
    const pickAndPrepareRestore = jest.fn(async () => ({
      summary: {
        formatVersion: 1,
        applicationId: 'app.waifudeck.mobile',
        appVersion: '1.1.0',
        createdAt: 123,
        imageCount: 4,
        fileCount: 3,
        totalFileBytes: 3_000_000,
        restoredFileCount: 3,
        missingFileCount: 0,
      },
      apply,
      dispose: jest.fn(async () => undefined),
    }));
    const first = appBundle({ closeDatabase });
    first.backupService = {
      createArchive: jest.fn(),
      createAndShare: jest.fn(),
      prepareRestoreFromUri: jest.fn(),
      pickAndPrepareRestore,
    };
    first.resetCoordinator = {
      beginExclusive: async () => ({ release: () => undefined }),
      beginReset,
    } as unknown as DataResetCoordinator;
    let cacheAtRestart: string[] | null = null;
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(async () => {
        cacheAtRestart = queryClient.getQueryCache().getAll().map((query) => query.queryHash);
        return appBundle({ databaseId: 'restored' });
      });

    try {
      await render(providerElement(
        createElement(BackupRestoreProbe),
        initializer,
        undefined,
        queryClient,
      ));
      await fireEvent.press(
        await screen.findByRole('button', { name: 'provider restore backup' }),
      );

      await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
      expect(apply).toHaveBeenCalledTimes(1);
      expect(language).toHaveBeenCalledTimes(1);
      expect(cacheAtRestart).toEqual([]);
    } finally {
      language.mockRestore();
    }
  });

  test('exposes the locked BYOS status to consumers', async () => {
    const initializer = jest.fn(async () => appBundle({
      byosStatus: { status: 'locked', reason: 'password_required' },
    }));

    await render(providerElement(createElement(ByosProbe), initializer));

    // The settings and library sections read this to say "configured but
    // unavailable" rather than offering a fresh set-up flow (D3).
    expect(
      await screen.findByText('database:locked:password_required'),
    ).toBeOnTheScreen();
  });

  test('reloads services so a BYOS change is picked up by a fresh resolve', async () => {
    const closeDatabase = jest.fn(async () => undefined);
    const reinitialized = deferred<AppServiceBundle>();
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        closeDatabase,
        byosStatus: { status: 'locked', reason: 'password_required' },
      }))
      .mockReturnValueOnce(reinitialized.promise);

    await render(providerElement(createElement(ByosProbe), initializer));
    expect(
      await screen.findByText('database:locked:password_required'),
    ).toBeOnTheScreen();

    await fireEvent.press(
      await screen.findByRole('button', { name: 'provider reload services' }),
    );

    // The superseded bundle is closed the moment the reload starts, so the
    // tree must stop rendering against it for the whole re-initialization —
    // a real resolve costs a network round-trip to the bucket.
    await waitFor(() => expect(closeDatabase).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('database:locked:password_required')).toBeNull();

    // Unlocking writes to SecureStore, then reloads: what the resolver sees
    // on the way back up is the new state.
    await act(async () => reinitialized.resolve(appBundle({
      databaseId: 'reloaded',
      byosStatus: { status: 'ready', context: byosContext() },
    })));
    expect(await screen.findByText('reloaded:ready')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(2);
  });

  test('a network recovery keeps the child mounted and rebinds the library', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const prepared = lockedLibraryBundle();
    const queryClient = appTestQueryClient();
    const deck = { active: { id: 1 }, queued: [] as const };
    queryClient.setQueryData(['discovery', 'deck'], deck);
    const mounts = { current: 0 };
    const onMount = () => {
      mounts.current += 1;
    };
    const resolveVault = jest.fn(async () => readyVault());
    const initializer = jest.fn(async () => prepared.bundle);

    await render(providerElement(
      createElement(
        View,
        null,
        createElement(RecoveryMarker, { onMount }),
        createElement(ByosProbe),
      ),
      initializer,
      undefined,
      queryClient,
      resolveVault,
    ));
    expect(await screen.findByText('marker:vault_unreachable')).toBeOnTheScreen();
    expect(screen.queryByText('正在准备 Waifu Deck')).toBeNull();
    await waitFor(() => expect(recovery.subscribe).toHaveBeenCalledTimes(1));

    const verdict = deferred<ByosStatus>();
    resolveVault.mockImplementation(() => verdict.promise);
    await act(async () => {
      recovery.emit();
    });

    expect(screen.getByText('marker:vault_unreachable')).toBeOnTheScreen();
    expect(screen.queryByText('正在准备 Waifu Deck')).toBeNull();
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(prepared.closeDatabase).not.toHaveBeenCalled();

    await act(async () => {
      verdict.resolve(readyVault());
    });

    expect(await screen.findByText('marker:ready')).toBeOnTheScreen();
    expect(screen.getByText('database:ready')).toBeOnTheScreen();
    expect(screen.queryByText('正在准备 Waifu Deck')).toBeNull();
    expect(mounts.current).toBe(1);
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(prepared.closeDatabase).not.toHaveBeenCalled();
    expect(resolveVault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(prepared.onSessionReady).toHaveBeenCalledTimes(1));
    expect(prepared.ensureRegistered).toHaveBeenCalledTimes(1);
    expect(prepared.ensureUnregistered).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['discovery', 'deck'])).toEqual(deck);
    await act(async () => {
      recovery.emit();
    });
    expect(prepared.onNetworkReturn).toHaveBeenCalledTimes(1);
    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(screen.getByText('marker:ready')).toBeOnTheScreen();
  });

  test.each<[string, ByosStatus]>([
    ['wrong password', { status: 'locked', reason: 'password_required' }],
    ['corrupt meta', { status: 'locked', reason: 'meta_corrupt', detail: 'malformed' }],
    ['auth failure', {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'credential_rejected',
    }],
    ['HTTP failure', {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'not_s3',
    }],
  ])('a start locked for another reason ignores a network edge: %s', async (_label, byosStatus) => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const initializer = jest.fn(async () => appBundle({ byosStatus }));
    const reason = byosStatus.status === 'locked' ? byosStatus.reason : byosStatus.status;

    await render(providerElement(createElement(ByosProbe), initializer));
    await screen.findByText(`database:locked:${reason}`);
    await act(async () => {
      recovery.emit();
    });

    expect(recovery.subscribe).toHaveBeenCalledTimes(1);
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`database:locked:${reason}`)).toBeOnTheScreen();
  });

  test('a ready start does not reload on network return', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const onNetworkReturn = jest.fn();
    const initializer = jest.fn(async () => appBundle({
      byosStatus: { status: 'ready', context: byosContext() },
      librarySyncTrigger: { dispose: jest.fn(), onNetworkReturn },
    }));

    await render(providerElement(createElement(ByosProbe), initializer));
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
    await waitFor(() => expect(recovery.subscribe).toHaveBeenCalledTimes(2));

    await act(async () => recovery.emit());

    expect(onNetworkReturn).toHaveBeenCalledTimes(1);
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  test('the subscription ends on unmount', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const initializer = jest.fn(async () => appBundle({
      byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
    }));

    const view = await render(providerElement(createElement(ByosProbe), initializer));
    await screen.findByText('database:locked:vault_unreachable');
    await waitFor(() => expect(recovery.subscribe).toHaveBeenCalledTimes(1));

    await view.unmount();
    expect(recovery.unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => recovery.emit());
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  test('two network-return events resolve once while one recovery is in flight', async () => {
    const recovery = networkRecoveryHarness({ retainHandlerOnUnsubscribe: true });
    mockNetworkRecovery = recovery;
    const verdict = deferred<ByosStatus>();
    const resolveVault = jest.fn(() => verdict.promise);
    const initializer = jest.fn(async () => appBundle({ byosStatus: NETWORK_LOCK }));
    const mounts = { current: 0 };
    const onMount = () => {
      mounts.current += 1;
    };

    const view = await render(providerElement(
      createElement(RecoveryMarker, { onMount }),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('marker:vault_unreachable');
    await waitFor(() => expect(recovery.subscribe).toHaveBeenCalledTimes(1));

    await act(async () => {
      recovery.emit();
      recovery.emit();
    });

    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(screen.getByText('marker:vault_unreachable')).toBeOnTheScreen();
    expect(screen.queryByText('正在准备 Waifu Deck')).toBeNull();

    await view.unmount();
    await act(async () => {
      verdict.resolve(NETWORK_LOCK);
    });
  });

  test('a network-locked recovery accepts the next edge without another initializer', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const prepared = lockedLibraryBundle();
    const resolveVault = jest.fn()
      .mockResolvedValueOnce(NETWORK_LOCK)
      .mockResolvedValueOnce(readyVault());
    const initializer = jest.fn(async () => prepared.bundle);
    const mounts = { current: 0 };
    const onMount = () => {
      mounts.current += 1;
    };

    await render(providerElement(
      createElement(RecoveryMarker, { onMount }),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('marker:vault_unreachable');
    await waitFor(() => expect(recovery.subscribe).toHaveBeenCalledTimes(1));

    await act(async () => {
      recovery.emit();
    });
    await flushAppEffects();
    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(screen.getByText('marker:vault_unreachable')).toBeOnTheScreen();

    await act(async () => {
      recovery.emit();
    });
    expect(await screen.findByText('marker:ready')).toBeOnTheScreen();
    expect(resolveVault).toHaveBeenCalledTimes(2);
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(mounts.current).toBe(1);
    expect(prepared.closeDatabase).not.toHaveBeenCalled();
  });

  test('a recovery that stays network-locked retries the resolve at 3 s and 10 s, then waits for the next edge', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async () => NETWORK_LOCK);
    const initializer = jest.fn(async () => appBundle({
      databaseId: 'initial',
      byosStatus: NETWORK_LOCK,
    }));
    const mounts = { current: 0 };
    const onMount = () => {
      mounts.current += 1;
    };

    await render(providerElement(
      createElement(RecoveryMarker, { onMount }),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('marker:vault_unreachable');

    jest.useFakeTimers();
    try {
      await act(async () => {
        recovery.emit();
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(1);
      expect(initializer).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(2_999);
      });
      expect(resolveVault).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(2);
      expect(initializer).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(9_999);
      });
      expect(resolveVault).toHaveBeenCalledTimes(2);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(3);
      expect(initializer).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(20_000);
      });
      expect(resolveVault).toHaveBeenCalledTimes(3);

      await act(async () => {
        recovery.emit();
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(4);
      expect(initializer).toHaveBeenCalledTimes(1);
      expect(screen.getByText('marker:vault_unreachable')).toBeOnTheScreen();
      expect(screen.queryByText('正在准备 Waifu Deck')).toBeNull();
      expect(mounts.current).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a retry that reaches ready ends the sequence', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const prepared = lockedLibraryBundle();
    const resolveVault = jest.fn()
      .mockResolvedValueOnce(NETWORK_LOCK)
      .mockResolvedValueOnce(readyVault());
    const initializer = jest.fn(async () => prepared.bundle);

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');

    jest.useFakeTimers();
    try {
      await act(async () => {
        recovery.emit();
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(1);
      expect(initializer).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(await screen.findByText('database:ready')).toBeOnTheScreen();
      expect(resolveVault).toHaveBeenCalledTimes(2);

      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await act(async () => {
        recovery.emit();
      });
      expect(prepared.onNetworkReturn).toHaveBeenCalledTimes(1);
      expect(resolveVault).toHaveBeenCalledTimes(2);
      expect(initializer).toHaveBeenCalledTimes(1);
      expect(prepared.closeDatabase).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a save after the rebind reaches the new controller', () => {
    const prepared = lockedLibraryBundle();
    const ready = readyVault();
    if (ready.status !== 'ready') throw new Error('expected a ready verdict');
    const rebound = prepared.bundle.rebindLibrary(prepared.bundle, ready);

    expect(rebound).not.toBe(prepared.bundle);
    expect(prepared.bundle.byosStatus).toEqual(NETWORK_LOCK);
    expect(rebound.byosStatus).toEqual(ready);
    expect(rebound.closeDatabase).toBe(prepared.closeDatabase);
    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(2);
    expect(prepared.createLibraryIntegration).toHaveBeenLastCalledWith(expect.objectContaining({
      database: prepared.resources.database,
      images: prepared.resources.imageRepository,
      collectionFiles: prepared.resources.fileRepository,
      subscribeActiveDownloads: prepared.subscribeActiveDownloads,
      localUnavailableCategory: 'offline',
      byos: ready.context,
    }));

    prepared.hooks.onOriginalReady?.({
      imageId: 7,
      localUri: 'file:///documents/collection/7.jpg',
    });

    expect(prepared.cloudController.onCollectedOriginalReady).toHaveBeenCalledWith({
      imageId: 7,
      localUri: 'file:///documents/collection/7.jpg',
    });
    expect(prepared.localController.onCollectedOriginalReady).not.toHaveBeenCalled();
  });

  test('rebind refuses a library that already has libraryDispose', () => {
    const prepared = lockedLibraryBundle({ localDispose: true });

    const ready = readyVault();
    if (ready.status !== 'ready') throw new Error('expected a ready verdict');
    expect(() => prepared.bundle.rebindLibrary(prepared.bundle, ready)).toThrow(/local library/);
    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(1);

    prepared.hooks.onOriginalReady?.({ imageId: 4, localUri: 'file:///a.jpg' });
    expect(prepared.localController.onCollectedOriginalReady).toHaveBeenCalledTimes(1);
    expect(prepared.cloudController.onCollectedOriginalReady).not.toHaveBeenCalled();
  });

  test('the rebound bundle keeps the open services and the vault context', () => {
    const storageMode = { read: jest.fn(), set: jest.fn() };
    const prepared = lockedLibraryBundle({
      storageMode,
      cloudController: {
        deviceLibraryBytes: jest.fn(async () => 4),
        purgeCollectedImage: jest.fn(async () => undefined),
        beginReset: jest.fn(async () => ({ clearDevice: async () => ({ failed: [] }) })),
      },
    });
    const ready = readyVault();
    if (ready.status !== 'ready') throw new Error('expected a ready verdict');
    const rebound = prepared.bundle.rebindLibrary(prepared.bundle, ready);

    expect(rebound.byos).toBe(ready.context);
    expect(rebound.byosStatus).toEqual(ready);
    expect(rebound.discoveryService).toBe(prepared.bundle.discoveryService);
    expect(rebound.providerCredentials).toBe(prepared.bundle.providerCredentials);
    expect(rebound.libraryStorageMode).toBe(storageMode);
    expect(rebound.closeDatabase).toBe(prepared.closeDatabase);
    expect(rebound.startupRecovery).toBe(prepared.bundle.startupRecovery);

    const cloud = prepared.cloudController as Record<string, jest.Mock>;
    prepared.hooks.onSavedRowRemoved?.(3);
    expect(cloud.purgeCollectedImage).toHaveBeenCalledWith(3);
    expect(prepared.localController.purgeCollectedImage).not.toHaveBeenCalled();

    void prepared.hooks.purgeCollectedImage?.(9);
    expect(cloud.purgeCollectedImage).toHaveBeenCalledWith(9);

    void prepared.hooks.libraryBytes?.();
    expect(cloud.deviceLibraryBytes).toHaveBeenCalledTimes(1);

    void prepared.hooks.libraryReset?.();
    expect(cloud.beginReset).toHaveBeenCalledTimes(1);
  });

  test('a ready verdict whose factory stays local takes the full reload', async () => {
    const prepared = lockedLibraryBundle();
    prepared.createLibraryIntegration.mockReturnValue(libraryShell({
      libraryController: { onCollectedOriginalReady: jest.fn() },
      libraryActions: { getAccountScope: jest.fn(async () => null) },
      libraryView: { model: {}, resolver: { resolve: jest.fn() } },
    }));
    const reopened = deferred<AppServiceBundle>();
    const initializer = jest.fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(prepared.bundle)
      .mockReturnValueOnce(reopened.promise);
    const resolveVault = jest.fn(async () => readyVault());

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });

    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    expect(prepared.bundle.byosStatus).toEqual(NETWORK_LOCK);

    await act(async () => {
      reopened.resolve(appBundle({ databaseId: 'reloaded' }));
    });
    expect(await screen.findByText('reloaded:unconfigured')).toBeOnTheScreen();
  });

  test('a second edge during a retry resolve still runs both retry delays', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const slow = deferred<ByosStatus>();
    const resolveVault = jest.fn()
      .mockResolvedValueOnce(NETWORK_LOCK)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(NETWORK_LOCK);
    const initializer = jest.fn(async () => appBundle({ byosStatus: NETWORK_LOCK }));

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');

    jest.useFakeTimers();
    try {
      await act(async () => {
        recovery.emit();
      });
      await flushAppEffects();
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(2);

      await act(async () => {
        recovery.emit();
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(2);

      await act(async () => {
        slow.resolve(NETWORK_LOCK);
      });
      await flushAppEffects();
      const before = resolveVault.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(before + 1);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(before + 2);
      expect(initializer).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a cancelled restore during a recovery flight still recovers the locked bundle', async () => {
    const prepared = lockedLibraryBundle();
    const slow = deferred<ByosStatus>();
    const resolveVault = jest.fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(readyVault());
    const restoreFn: { current: (() => Promise<unknown>) | null } = { current: null };
    function RestoreCapture() {
      const services = useAppServices();
      useEffect(() => {
        restoreFn.current = services.restoreFullBackup;
      }, [services.restoreFullBackup]);
      return createElement(ByosProbe);
    }
    prepared.bundle.resetCoordinator = createDataResetCoordinator();
    prepared.bundle.backupService = {
      pickAndPrepareRestore: async () => null,
    } as unknown as AppServiceBundle['backupService'];

    await render(providerElement(
      createElement(RestoreCapture),
      async () => prepared.bundle,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await act(async () => {
      expect(await restoreFn.current?.()).toBeNull();
    });
    await flushAppEffects();
    expect(resolveVault).toHaveBeenCalledTimes(2);
    await act(async () => {
      slow.resolve(readyVault());
    });
    await flushAppEffects();
    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
  });

  test('a cancelled restore still runs both retry delays for the next edge', async () => {
    const oldFlight = deferred<ByosStatus>();
    const newFlight = deferred<ByosStatus>();
    const resolveVault = jest.fn()
      .mockResolvedValueOnce(NETWORK_LOCK)
      .mockReturnValueOnce(oldFlight.promise)
      .mockReturnValueOnce(newFlight.promise)
      .mockResolvedValue(NETWORK_LOCK);
    const prepared = lockedLibraryBundle();
    prepared.bundle.resetCoordinator = {
      beginExclusive: async () => ({ release() { return undefined; } }),
    } as unknown as DataResetCoordinator;
    prepared.bundle.backupService = {
      pickAndPrepareRestore: async () => null,
    } as unknown as AppServiceBundle['backupService'];
    const restoreFn: { current: (() => Promise<unknown>) | null } = { current: null };
    function Capture() {
      const services = useAppServices();
      useEffect(() => {
        restoreFn.current = services.restoreFullBackup;
      }, [services.restoreFullBackup]);
      return createElement(ByosProbe);
    }
    await render(providerElement(
      createElement(Capture),
      async () => prepared.bundle,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    jest.useFakeTimers();
    try {
      await act(async () => {
        (mockNetworkRecovery as NetworkRecoveryHarness).emit();
      });
      await flushAppEffects();
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(2);
      await act(async () => {
        expect(await restoreFn.current?.()).toBeNull();
      });
      await flushAppEffects();
      await act(async () => {
        (mockNetworkRecovery as NetworkRecoveryHarness).emit();
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(3);
      await act(async () => {
        oldFlight.resolve(NETWORK_LOCK);
      });
      await flushAppEffects();
      await act(async () => {
        newFlight.resolve(NETWORK_LOCK);
      });
      await flushAppEffects();
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(4);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(5);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a restore does not publish a verdict or apply a stale bundle while the picker is open', async () => {
    const prepared = lockedLibraryBundle({
      cloudController: {
        beginReset: jest.fn(async () => ({ settle: async () => undefined, end() { return undefined; } })),
      },
    });
    const localReset = jest.fn(async () => ({
      settle: async () => undefined,
      end() { return undefined; },
    }));
    prepared.bundle.libraryController = {
      ...prepared.bundle.libraryController,
      beginReset: localReset,
    } as unknown as AppServiceBundle['libraryController'];
    const oldFlight = deferred<ByosStatus>();
    const picking = deferred<{
      summary: { imageCount: number };
      apply: () => Promise<typeof DEFAULT_SETTINGS>;
      dispose: () => Promise<void>;
    } | null>();
    const resolveVault = jest.fn()
      .mockReturnValueOnce(oldFlight.promise)
      .mockResolvedValue(readyVault());
    prepared.bundle.resetCoordinator = {
      beginExclusive: async () => ({ release() { return undefined; } }),
      beginReset: async () => ({ release() { return undefined; } }),
    } as unknown as DataResetCoordinator;
    prepared.bundle.backupService = {
      pickAndPrepareRestore: () => picking.promise,
    } as unknown as AppServiceBundle['backupService'];
    const restoreFn: { current: (() => Promise<unknown>) | null } = { current: null };
    function Capture() {
      const services = useAppServices();
      useEffect(() => {
        restoreFn.current = services.restoreFullBackup;
      }, [services.restoreFullBackup]);
      return createElement(ByosProbe);
    }
    const initializer = jest.fn()
      .mockResolvedValueOnce(prepared.bundle)
      .mockResolvedValue(appBundle());
    await render(providerElement(
      createElement(Capture),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    let restoring!: Promise<unknown>;
    await act(async () => {
      restoring = restoreFn.current!();
    });
    await act(async () => {
      oldFlight.resolve(readyVault());
    });
    await flushAppEffects();
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await flushAppEffects();
    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(1);
    await act(async () => {
      picking.resolve({
        summary: { imageCount: 0 },
        apply: async () => DEFAULT_SETTINGS,
        dispose: async () => undefined,
      });
      await restoring;
    });
    expect(localReset).toHaveBeenCalledTimes(1);
    const cloudReset = (prepared.cloudController as unknown as { beginReset: jest.Mock }).beginReset;
    expect(cloudReset).not.toHaveBeenCalled();
    expect(prepared.libraryDispose).not.toHaveBeenCalled();
  });

  test('a network edge during the picker starts recovery when the pick is cancelled', async () => {
    const picking = deferred<null>();
    const resolveVault = jest.fn(async () => NETWORK_LOCK);
    const prepared = lockedLibraryBundle();
    prepared.bundle.resetCoordinator = {
      beginExclusive: async () => ({ release() { return undefined; } }),
    } as unknown as DataResetCoordinator;
    prepared.bundle.backupService = {
      pickAndPrepareRestore: () => picking.promise,
    } as unknown as AppServiceBundle['backupService'];
    const restoreFn: { current: (() => Promise<unknown>) | null } = { current: null };
    function Capture() {
      const services = useAppServices();
      useEffect(() => {
        restoreFn.current = services.restoreFullBackup;
      }, [services.restoreFullBackup]);
      return createElement(ByosProbe);
    }
    await render(providerElement(
      createElement(Capture),
      async () => prepared.bundle,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    jest.useFakeTimers();
    try {
      let restoring!: Promise<unknown>;
      await act(async () => {
        restoring = restoreFn.current!();
      });
      await flushAppEffects();
      await act(async () => {
        (mockNetworkRecovery as NetworkRecoveryHarness).emit();
      });
      await flushAppEffects();
      expect(resolveVault).not.toHaveBeenCalled();
      await act(async () => {
        picking.resolve(null);
        await restoring;
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(2);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(3);
      expect(screen.getByText('database:locked:vault_unreachable')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  test('delete-all remembers a network edge and runs both retries after it fails', async () => {
    const deleting = deferred<DeleteAllDataResult>();
    const prepared = lockedLibraryBundle();
    prepared.bundle.collectionService.deleteAllData = jest.fn(() => deleting.promise);
    const removeFn: { current: (() => Promise<unknown>) | null } = { current: null };
    function Capture() {
      const services = useAppServices();
      useEffect(() => {
        removeFn.current = services.deleteAllAppData;
      }, [services.deleteAllAppData]);
      return createElement(ByosProbe);
    }
    const resolveVault = jest.fn(async () => NETWORK_LOCK);
    await render(providerElement(
      createElement(Capture),
      async () => prepared.bundle,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    jest.useFakeTimers();
    try {
      let deletingApp!: Promise<unknown>;
      await act(async () => {
        deletingApp = removeFn.current!();
        void deletingApp.catch(() => undefined);
      });
      await flushAppEffects();
      await act(async () => {
        (mockNetworkRecovery as NetworkRecoveryHarness).emit();
      });
      expect(resolveVault).not.toHaveBeenCalled();
      await act(async () => {
        deleting.reject(new Error('partial delete failed'));
        await expect(deletingApp).rejects.toThrow('partial delete failed');
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(2);
      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(3);
      expect(screen.getByText('database:locked:vault_unreachable')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an edge during the error reset is remembered for the replacement locked bundle', async () => {
    const resetting = deferred<void>();
    const next = lockedLibraryBundle();
    const initializer = jest.fn()
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValue(next.bundle);
    const resolveVault = jest.fn(async () => readyVault());
    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      () => resetting.promise,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByLabelText('数据库诊断信息');
    await fireEvent.press(screen.getByRole('button', { name: '删除本地数据并重新初始化' }));
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    expect(resolveVault).not.toHaveBeenCalled();
    await act(async () => {
      resetting.resolve();
    });
    await flushAppEffects();
    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
  });

  test('an edge during a manual reload is remembered for the replacement locked bundle', async () => {
    const first = lockedLibraryBundle();
    const second = lockedLibraryBundle();
    const opening = deferred<AppServiceBundle>();
    const initializer = jest.fn()
      .mockResolvedValueOnce(first.bundle)
      .mockReturnValueOnce(opening.promise);
    const resolveVault = jest.fn(async () => readyVault());
    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await fireEvent.press(screen.getByRole('button', { name: 'provider reload services' }));
    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    expect(resolveVault).not.toHaveBeenCalled();
    await act(async () => {
      opening.resolve(second.bundle);
    });
    await flushAppEffects();
    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
  });

  test.each([
    ['cancel', 'old-first'],
    ['cancel', 'new-first'],
    ['picker-reject', 'old-first'],
    ['picker-reject', 'new-first'],
    ['reset-reject', 'old-first'],
    ['reset-reject', 'new-first'],
  ] as const)(
    'a cancelled first flight keeps both retries when the restore %s and the %s verdict settles',
    async (outcome, order) => {
      const oldFlight = deferred<ByosStatus>();
      const newFlight = deferred<ByosStatus>();
      const resolveVault = jest.fn()
        .mockReturnValueOnce(oldFlight.promise)
        .mockReturnValueOnce(newFlight.promise)
        .mockResolvedValue(NETWORK_LOCK);
      const prepared = lockedLibraryBundle();
      prepared.bundle.resetCoordinator = {
        beginExclusive: async () => ({ release() { return undefined; } }),
        beginReset: async () => {
          throw new Error('reset lease unavailable');
        },
      } as unknown as DataResetCoordinator;
      prepared.bundle.backupService = {
        pickAndPrepareRestore: async () => {
          if (outcome === 'cancel') return null;
          if (outcome === 'picker-reject') throw new Error('picker failed');
          return {
            summary: {},
            apply: async () => DEFAULT_SETTINGS,
            dispose: async () => undefined,
          };
        },
      } as unknown as AppServiceBundle['backupService'];
      const restoreFn: { current: (() => Promise<unknown>) | null } = { current: null };
      function Capture() {
        const services = useAppServices();
        useEffect(() => {
          restoreFn.current = services.restoreFullBackup;
        }, [services.restoreFullBackup]);
        return createElement(ByosProbe);
      }
      await render(providerElement(
        createElement(Capture),
        async () => prepared.bundle,
        undefined,
        appTestQueryClient(),
        resolveVault,
      ));
      await screen.findByText('database:locked:vault_unreachable');
      jest.useFakeTimers();
      try {
        await act(async () => {
          (mockNetworkRecovery as NetworkRecoveryHarness).emit();
        });
        await act(async () => {
          const restoring = restoreFn.current!();
          if (outcome === 'cancel') await expect(restoring).resolves.toBeNull();
          else {
            await expect(restoring).rejects.toThrow(
              outcome === 'picker-reject' ? 'picker failed' : 'reset lease unavailable',
            );
          }
        });
        await flushAppEffects();
        await act(async () => {
          (mockNetworkRecovery as NetworkRecoveryHarness).emit();
        });
        expect(resolveVault).toHaveBeenCalledTimes(2);
        const settleOld = () => {
          oldFlight.resolve(NETWORK_LOCK);
        };
        const settleNew = () => {
          newFlight.resolve(NETWORK_LOCK);
        };
        if (order === 'old-first') {
          await act(async () => {
            settleOld();
          });
          await flushAppEffects();
          await act(async () => {
            settleNew();
          });
        } else {
          await act(async () => {
            settleNew();
          });
          await flushAppEffects();
          await act(async () => {
            settleOld();
          });
        }
        await flushAppEffects();
        await act(async () => {
          jest.advanceTimersByTime(3_000);
        });
        await flushAppEffects();
        expect(resolveVault).toHaveBeenCalledTimes(3);
        await act(async () => {
          jest.advanceTimersByTime(10_000);
        });
        await flushAppEffects();
        expect(resolveVault).toHaveBeenCalledTimes(4);
        expect(screen.getByText('database:locked:vault_unreachable')).toBeOnTheScreen();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test('a cancelled restore of a ready vault does not start recovery', async () => {
    const picking = deferred<null>();
    const prepared = lockedLibraryBundle();
    prepared.bundle.byosStatus = readyVault();
    prepared.bundle.resetCoordinator = {
      beginExclusive: async () => ({ release() { return undefined; } }),
    } as unknown as DataResetCoordinator;
    prepared.bundle.backupService = {
      pickAndPrepareRestore: () => picking.promise,
    } as unknown as AppServiceBundle['backupService'];
    const restoreFn: { current: (() => Promise<unknown>) | null } = { current: null };
    function Capture() {
      const services = useAppServices();
      useEffect(() => {
        restoreFn.current = services.restoreFullBackup;
      }, [services.restoreFullBackup]);
      return createElement(ByosProbe);
    }
    const resolveVault = jest.fn(async () => readyVault());
    await render(providerElement(
      createElement(Capture),
      async () => prepared.bundle,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:ready');
    let restoring!: Promise<unknown>;
    await act(async () => {
      restoring = restoreFn.current!();
    });
    await flushAppEffects();
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    expect(resolveVault).not.toHaveBeenCalled();
    await act(async () => {
      picking.resolve(null);
      await restoring;
    });
    await flushAppEffects();
    expect(resolveVault).not.toHaveBeenCalled();
    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(1);
    expect(screen.getByText('database:ready')).toBeOnTheScreen();
  });

  test('a synchronous resetter throw leaves the error screen able to recover', async () => {
    const failure = new Error('reset failed');
    const second = lockedLibraryBundle();
    const resetter = jest.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockResolvedValue(undefined);
    const initializer = jest.fn()
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValue(second.bundle);
    const resolveVault = jest.fn(async () => readyVault());
    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      resetter,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByLabelText('数据库诊断信息');
    const errorButton = () => screen.getByRole('button', { name: '删除本地数据并重新初始化' });
    await expect(fireEvent.press(errorButton())).resolves.toBeUndefined();
    expect(screen.getByText('Error: reset failed')).toBeOnTheScreen();
    await fireEvent.press(errorButton());
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await flushAppEffects();
    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
  });

  test('a ready verdict whose factory returns an empty vault shell takes the full reload', async () => {
    const prepared = lockedLibraryBundle();
    prepared.createLibraryIntegration.mockReturnValue(libraryShell({
      libraryDispose: jest.fn(),
    }));
    const reopened = deferred<AppServiceBundle>();
    const initializer = jest.fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(prepared.bundle)
      .mockReturnValueOnce(reopened.promise);
    const resolveVault = jest.fn(async () => readyVault());
    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    await act(async () => {
      reopened.resolve(appBundle({ databaseId: 'reloaded' }));
    });
    expect(await screen.findByText('reloaded:unconfigured')).toBeOnTheScreen();
  });

  test('unmount while getAccountScope waits never starts the disposed session', async () => {
    const prepared = lockedLibraryBundle();
    const scope = deferred<string>();
    prepared.getAccountScope.mockReturnValue(scope.promise);
    const resolveVault = jest.fn(async () => readyVault());
    const view = await render(providerElement(
      createElement(ByosProbe),
      async () => prepared.bundle,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await waitFor(() => expect(prepared.getAccountScope).toHaveBeenCalledTimes(1));
    await view.unmount();
    await act(async () => {
      scope.resolve('scope-1');
    });
    await flushAppEffects();
    expect(prepared.onSessionReady).not.toHaveBeenCalled();
    expect(prepared.ensureRegistered).not.toHaveBeenCalled();
  });

  test('startup StrictMode effect replay still recovers', async () => {
    const prepared = lockedLibraryBundle();
    const resolveVault = jest.fn(async () => readyVault());
    const StrictMode = jest.requireActual<typeof import('react')>('react').StrictMode;
    await render(createElement(
      StrictMode,
      null,
      providerElement(
        createElement(ByosProbe),
        async () => prepared.bundle,
        undefined,
        appTestQueryClient(),
        resolveVault,
      ),
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await flushAppEffects();
    expect(resolveVault).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
  });

  test('a new locked attempt recovers while the previous resolve is still in flight', async () => {
    const slow = deferred<ByosStatus>();
    const resolveVault = jest.fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(readyVault());
    const first = lockedLibraryBundle();
    const second = lockedLibraryBundle();
    const initializer = jest.fn()
      .mockResolvedValueOnce(first.bundle)
      .mockResolvedValueOnce(second.bundle);

    const view = await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await fireEvent.press(screen.getByRole('button', { name: 'provider reload services' }));
    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    await screen.findByText('database:locked:vault_unreachable');

    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await waitFor(() => expect(resolveVault).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('database:ready')).toBeOnTheScreen();
    expect(second.createLibraryIntegration).toHaveBeenCalledTimes(2);

    await act(async () => {
      slow.resolve(readyVault());
    });
    await flushAppEffects();
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await flushAppEffects();

    expect(resolveVault).toHaveBeenCalledTimes(2);
    expect(first.createLibraryIntegration).toHaveBeenCalledTimes(1);
    expect(second.createLibraryIntegration).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  test('an error reset keeps a recovery edge for the replacement locked bundle', async () => {
    const first = lockedLibraryBundle();
    const second = lockedLibraryBundle();
    const slow = deferred<ByosStatus>();
    const resolveVault = jest.fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(readyVault());
    const initializer = jest.fn()
      .mockResolvedValueOnce(first.bundle)
      .mockRejectedValueOnce(new Error('open failed'))
      .mockResolvedValueOnce(second.bundle);

    const view = await render(providerElement(
      createElement(ByosProbe),
      initializer,
      async () => undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await fireEvent.press(screen.getByRole('button', { name: 'provider reload services' }));
    await screen.findByLabelText('数据库诊断信息');
    await fireEvent.press(screen.getByRole('button', { name: '删除本地数据并重新初始化' }));
    await screen.findByText('database:locked:vault_unreachable');

    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await act(async () => {
      slow.resolve(readyVault());
    });
    await flushAppEffects();
    expect(first.createLibraryIntegration).toHaveBeenCalledTimes(1);
    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    await flushAppEffects();

    expect(resolveVault).toHaveBeenCalledTimes(2);
    expect(second.createLibraryIntegration).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  test('a reload during rebind releases the unpublished guard, trigger and background round', async () => {
    const prepared = lockedLibraryBundle();
    const reloadFn: { current: (() => void) | null } = { current: null };
    function Capture() {
      const services = useAppServices();
      useEffect(() => {
        reloadFn.current = services.reloadAppServices;
      }, [services.reloadAppServices]);
      return createElement(ByosProbe);
    }
    const integration = prepared.createLibraryIntegration.getMockImplementation()?.();
    if (integration == null) throw new Error('expected the cloud shell');
    prepared.createLibraryIntegration.mockImplementation(() => {
      reloadFn.current?.();
      return integration;
    });
    const slots = jest.requireActual<typeof import('@/features/library/library-background-sync-slot')>(
      '@/features/library/library-background-sync-slot',
    );
    const round = jest.fn(async () => ({ finished: true, uploaded: 0, failed: 0 }));
    slots.setLibraryBackgroundRound(round as never);
    const slotClears = jest.spyOn(slots, 'setLibraryBackgroundRound');
    const initializer = jest.fn()
      .mockResolvedValueOnce(prepared.bundle)
      .mockResolvedValue(appBundle());
    try {
      await render(providerElement(
        createElement(Capture),
        initializer,
        undefined,
        appTestQueryClient(),
        async () => readyVault(),
      ));
      await screen.findByText('database:locked:vault_unreachable');
      await act(async () => {
        (mockNetworkRecovery as NetworkRecoveryHarness).emit();
      });
      await flushAppEffects();
      await waitFor(() => expect(prepared.closeDatabase).toHaveBeenCalledTimes(1));
      expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
      expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
      expect(slotClears.mock.calls.filter((call) => call[0] === null).length).toBeGreaterThanOrEqual(2);
      expect(slots.getLibraryBackgroundRound()).toBeNull();
      expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
    } finally {
      slotClears.mockRestore();
      slots.setLibraryBackgroundRound(null);
    }
  });

  test('the library resume passes run once after a rebind, on the rebound controller, in order', async () => {
    const order: string[] = [];
    const prepared = lockedLibraryBundle({
      cloudController: {
        purgeUndoneLibraryRows: jest.fn(async () => {
          order.push('recovery');
          return 0;
        }),
        noteMissingOriginals: jest.fn(async () => {
          order.push('missing');
          return 0;
        }),
        reingestMissingLibraryRows: jest.fn(async () => {
          order.push('backfill');
          return 0;
        }),
        handOverExisting: jest.fn(async () => {
          order.push('migration');
          return 0;
        }),
        sweepCacheOrphans: jest.fn(async () => {
          order.push('cache-sweep');
          return 0;
        }),
      },
    });
    prepared.onSessionReady.mockImplementation(() => {
      order.push('session');
    });
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async () => readyVault());
    const initializer = jest.fn(async () => prepared.bundle);

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');

    await act(async () => {
      recovery.emit();
    });

    await waitFor(() => expect(order).toEqual([
      'session',
      'recovery',
      'missing',
      'backfill',
      'migration',
      'cache-sweep',
    ]));
    expect(prepared.cloudController.purgeUndoneLibraryRows).toHaveBeenCalledTimes(1);
    expect(prepared.cloudController.sweepCacheOrphans).toHaveBeenCalledTimes(1);
    expect(prepared.localController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
    expect(prepared.localController.noteMissingOriginals).not.toHaveBeenCalled();
    expect(prepared.localController.reingestMissingLibraryRows).not.toHaveBeenCalled();
    expect(prepared.localController.handOverExisting).not.toHaveBeenCalled();
    expect(prepared.localController.sweepCacheOrphans).not.toHaveBeenCalled();
    expect(initializer).toHaveBeenCalledTimes(1);
  });

  describe('row 52: resume lifetime through teardown', () => {
    async function productionResume(startup: boolean) {
      const { createLibraryTestHarness } = jest.requireActual<
        typeof import('@/features/library/library-test-support')
      >('@/features/library/library-test-support');
      const fileModule = jest.requireActual<
        typeof import('@/features/library/library-expo-file-store')
      >('@/features/library/library-expo-file-store');
      const { createLocalLibraryIntegration } = jest.requireActual<
        typeof import('@/features/library/library-integration-local-core')
      >('@/features/library/library-integration-local-core');
      const h = await createLibraryTestHarness();
      const storeSpy = jest.spyOn(fileModule, 'createExpoLibraryFileStore').mockReturnValue(h.files);
      const portSpy = jest.spyOn(fileModule, 'createExpoLibraryFilePort').mockReturnValue(h.port);
      const listing = deferred<string[]>();
      const list = jest.fn(() => listing.promise);
      h.port.listOriginalNames = list;
      const sqlAfterClose: string[] = [];
      const events: string[] = [];
      let closed = false;
      const database: SqlDatabasePort = {
        ...h.database,
        async getAll<T>(sql: string, args?: readonly SqlBindValue[]) {
          if (closed) sqlAfterClose.push(sql);
          return h.database.getAll<T>(sql, args);
        },
        async run(sql: string, args?: readonly SqlBindValue[]) {
          if (closed) sqlAfterClose.push(sql);
          return h.database.run(sql, args);
        },
      };
      await database.run(`INSERT INTO device_library_assets (
        plaintext_sha256, format, canonical_extension, byte_size, width, height,
        origin, source_image_id, local_original_uri, residency, protect_eligible,
        missing_original_since, created_at, updated_at
      ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, ?, 'local-original', 1, NULL, 1, 1)`,
      ['a'.repeat(64), h.port.resolveOriginal('gone.jpg')]);
      const core = createLocalLibraryIntegration({ database }).libraryController;
      if (core === null) throw new Error('Expected the production library core');
      const prepared = lockedLibraryBundle();
      const controller = startup ? prepared.localController : prepared.cloudController;
      Object.assign(controller, core);
      const finished = jest.fn();
      for (const pass of ['purgeUndoneLibraryRows', 'noteMissingOriginals',
        'reingestMissingLibraryRows', 'handOverExisting', 'sweepCacheOrphans'] as const) {
        controller[pass] = jest.fn(async () => {
          const count = await core[pass]();
          events.push(pass);
          if (pass === 'sweepCacheOrphans') finished();
          return count;
        });
      }
      prepared.closeDatabase.mockImplementation(async () => {
        if (closed) throw new Error('Database closed twice');
        events.push('close');
        closed = true;
        h.close();
      });
      return {
        ...prepared, list, listing, finished, events, sqlAfterClose,
        cleanup() {
          if (!closed) h.close();
          storeSpy.mockRestore();
          portSpy.mockRestore();
        },
      };
    }

    test.each([
      ['recovery', 'control'], ['recovery', 'reload'], ['recovery', 'unmount'],
      ['recovery', 'props'], ['startup', 'reload'],
    ] as const)(
      '%s resume finishes before teardown closes SQLite (%s)',
      async (source, operation) => {
        const prepared = await productionResume(source === 'startup');
        let reload!: () => void;
        function Capture() {
          const { reloadAppServices } = useAppServices();
          useEffect(() => { reload = reloadAppServices; }, [reloadAppServices]);
          return createElement(ByosProbe);
        }
        const initializer = jest.fn().mockResolvedValueOnce(prepared.bundle).mockResolvedValue(appBundle());
        const replacementInitializer = jest.fn(async () => appBundle());
        const client = appTestQueryClient();
        const resolver = async () => readyVault();
        let view: Awaited<ReturnType<typeof render>> | undefined;
        let unmounted = false;
        try {
          if (source === 'startup') {
            prepared.bundle.collectionService.resumePendingDownloads = async () => {
              prepared.hooks.onCollectionResumed?.();
              return [];
            };
            const state = await restoreAppServiceState(prepared.bundle);
            // The collection snapshot still completes while its library pass
            // is pending; teardown owns the wait, not the collection mutation.
            await expect(state.collectionRecovery).resolves.toBe(false);
            prepared.bundle.startupRecovery = state.collectionRecovery;
          }
          view = await render(providerElement(
            createElement(Capture), initializer, undefined, client, resolver,
          ));
          await screen.findByText('database:locked:vault_unreachable');
          if (source === 'recovery') {
            await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
            await screen.findByText('database:ready');
          }
          await waitFor(() => expect(prepared.list).toHaveBeenCalledTimes(1));
          expect(prepared.finished).not.toHaveBeenCalled();
          if (operation === 'reload') {
            await act(async () => { reload(); });
          } else if (operation === 'unmount') {
            await view.unmount();
            unmounted = true;
          } else if (operation === 'props') {
            await view.rerender(providerElement(
              createElement(Capture), replacementInitializer, undefined, client, resolver,
            ));
          }
          await flushAppEffects();
          if (operation !== 'control' && source === 'recovery') {
            expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
            expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
          }
          expect(prepared.closeDatabase).not.toHaveBeenCalled();
          expect(initializer).toHaveBeenCalledTimes(1);
          expect(replacementInitializer).not.toHaveBeenCalled();
          if (operation === 'reload') {
            expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
          }
          await act(async () => { prepared.listing.resolve([]); });
          await waitFor(() => expect(prepared.finished).toHaveBeenCalledTimes(1));
          if (operation === 'control') {
            expect(prepared.closeDatabase).not.toHaveBeenCalled();
            await view.unmount();
            unmounted = true;
          }
          await waitFor(() => expect(prepared.closeDatabase).toHaveBeenCalledTimes(1));
          if (operation === 'reload' || operation === 'props') {
            await screen.findByText('database:unconfigured');
            if (operation === 'props') expect(replacementInitializer).toHaveBeenCalledTimes(1);
            else expect(initializer).toHaveBeenCalledTimes(2);
          }
          expect(prepared.events).toEqual([
            'purgeUndoneLibraryRows', 'noteMissingOriginals', 'reingestMissingLibraryRows',
            'handOverExisting', 'sweepCacheOrphans', 'close',
          ]);
          expect(prepared.sqlAfterClose).toEqual([]);
        } finally {
          await act(async () => { prepared.listing.resolve([]); });
          await flushAppEffects();
          if (view && !unmounted) await view.unmount();
          await flushAppEffects();
          prepared.cleanup();
        }
      },
    );

    test('closing the rebound bundle drains both original and rebound resume chains', async () => {
      const prepared = lockedLibraryBundle();
      const localScan = deferred<number>();
      const cloudScan = deferred<number>();
      prepared.localController.noteMissingOriginals.mockImplementation(() => localScan.promise);
      prepared.cloudController.noteMissingOriginals.mockImplementation(() => cloudScan.promise);
      const originalResume = prepared.bundle.resumeLibrary();
      await waitFor(() => expect(prepared.localController.noteMissingOriginals).toHaveBeenCalledTimes(1));
      const ready = readyVault();
      if (ready.status !== 'ready') throw new Error('Expected ready verdict');
      const rebound = prepared.bundle.rebindLibrary(prepared.bundle, ready);
      const reboundResume = rebound.resumeLibrary();
      await waitFor(() => expect(prepared.cloudController.noteMissingOriginals).toHaveBeenCalledTimes(1));
      const closeBundle = createAppServiceBundleCloser();
      const closing = closeBundle(rebound);
      try {
        await flushAppEffects();
        expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
        expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
        expect(prepared.closeDatabase).not.toHaveBeenCalled();
        cloudScan.resolve(0);
        await reboundResume;
        await flushAppEffects();
        expect(prepared.cloudController.sweepCacheOrphans).toHaveBeenCalledTimes(1);
        expect(prepared.closeDatabase).not.toHaveBeenCalled();
        localScan.resolve(0);
        await originalResume;
        await closing;
        expect(prepared.localController.sweepCacheOrphans).toHaveBeenCalledTimes(1);
        await closeBundle(rebound);
        expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        localScan.resolve(0);
        cloudScan.resolve(0);
        await Promise.all([originalResume, reboundResume, closing]);
      }
    });
  });

  describe('row 52: closing resume admission', () => {
    test.each(['control', 'reload', 'unmount', 'props'] as const)(
      'a late production collection callback is safe after %s',
      async (operation) => {
        const { createLibraryTestHarness } = jest.requireActual<
          typeof import('@/features/library/library-test-support')
        >('@/features/library/library-test-support');
        const { createLocalLibraryIntegration } = jest.requireActual<
          typeof import('@/features/library/library-integration-local-core')
        >('@/features/library/library-integration-local-core');
        const { createCollectionService: createCollection } = jest.requireActual<
          typeof import('@/features/collection/collection-service')
        >('@/features/collection/collection-service');
        const fileModule = jest.requireActual<
          typeof import('@/features/library/library-expo-file-store')
        >('@/features/library/library-expo-file-store');
        const h = await createLibraryTestHarness();
        const storeSpy = jest.spyOn(fileModule, 'createExpoLibraryFileStore').mockReturnValue(h.files);
        const portSpy = jest.spyOn(fileModule, 'createExpoLibraryFilePort').mockReturnValue(h.port);
        const first = deferred<string[]>();
        const second = deferred<string[]>();
        const sweeping = deferred<{ missing: string[]; deleted: string[]; failed: string[] }>();
        const list = jest.fn().mockImplementationOnce(() => first.promise)
          .mockImplementationOnce(() => second.promise);
        h.port.listOriginalNames = list;
        let closed = false;
        const sqlAfterClose: string[] = [];
        const events: string[] = [];
        const database: SqlDatabasePort = {
          ...h.database,
          async getAll<T>(sql: string, args?: readonly SqlBindValue[]) {
            if (closed) sqlAfterClose.push(sql);
            return h.database.getAll<T>(sql, args);
          },
          async run(sql: string, args?: readonly SqlBindValue[]) {
            if (closed) sqlAfterClose.push(sql);
            return h.database.run(sql, args);
          },
        };
        await database.run(`INSERT INTO device_library_assets (
          plaintext_sha256, format, canonical_extension, byte_size, width, height,
          origin, source_image_id, local_original_uri, residency, protect_eligible,
          missing_original_since, created_at, updated_at
        ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, ?, 'local-original', 1, NULL, 1, 1)`,
        ['e'.repeat(64), h.port.resolveOriginal('gone.jpg')]);
        const core = createLocalLibraryIntegration({ database }).libraryController;
        if (core === null) throw new Error('Expected the production library core');
        const p = lockedLibraryBundle();
        Object.assign(p.cloudController, core);
        const passes = ['purgeUndoneLibraryRows', 'noteMissingOriginals',
          'reingestMissingLibraryRows', 'handOverExisting', 'sweepCacheOrphans'] as const;
        for (const pass of passes) {
          p.cloudController[pass] = jest.fn(async () => {
            const count = await core[pass]();
            events.push(pass);
            return count;
          });
        }
        p.closeDatabase.mockImplementation(async () => {
          if (closed) throw new Error('Database closed twice');
          closed = true;
          events.push('close');
          h.close();
        });
        const sweep = jest.fn(() => sweeping.promise);
        const callback = jest.fn(() => {
          events.push('collection-resumed');
          p.hooks.onCollectionResumed?.();
        });
        const collection = createCollection({
          repository: createImageRepository(database),
          files: { sweep } as unknown as CollectionFileRepository,
          coordinator: p.bundle.resetCoordinator,
          onCollectionResumed: callback,
        });
        p.bundle.collectionService = collection;
        let reload!: () => void;
        function Capture() {
          const { reloadAppServices } = useAppServices();
          useEffect(() => { reload = reloadAppServices; }, [reloadAppServices]);
          return createElement(ByosProbe);
        }
        const openReplacement = async () => {
          expect(closed).toBe(true);
          events.push('open');
          return appBundle();
        };
        const initializer = jest.fn().mockResolvedValueOnce(p.bundle).mockImplementation(openReplacement);
        const nextInitializer = jest.fn(openReplacement);
        const client = appTestQueryClient();
        const resolver = async () => readyVault();
        let view: Awaited<ReturnType<typeof render>> | undefined;
        let unmounted = false;
        let collecting: Promise<unknown> | undefined;
        try {
          view = await render(providerElement(createElement(Capture), initializer, undefined, client, resolver));
          await screen.findByText('database:locked:vault_unreachable');
          await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
          await screen.findByText('database:ready');
          await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
          collecting = collection.resumePendingDownloads();
          await waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
          if (operation === 'reload') await act(async () => { reload(); });
          else if (operation === 'unmount') {
            await view.unmount();
            unmounted = true;
          } else if (operation === 'props') {
            await view.rerender(providerElement(createElement(Capture), nextInitializer, undefined, client, resolver));
          }
          await flushAppEffects();
          if (operation !== 'control') expect(p.libraryDispose).toHaveBeenCalledTimes(1);
          expect(closed).toBe(false);
          expect(initializer).toHaveBeenCalledTimes(1);
          expect(nextInitializer).not.toHaveBeenCalled();
          // The real sweep reaches the factory's detached callback after
          // teardown has already entered its drain of the recovery chain.
          await act(async () => {
            sweeping.resolve({ missing: [], deleted: [], failed: [] });
            await collecting;
          });
          expect(callback).toHaveBeenCalledTimes(1);
          await flushAppEffects();
          const admitted = operation === 'control' ? 2 : 1;
          expect(p.cloudController.purgeUndoneLibraryRows).toHaveBeenCalledTimes(admitted);
          expect(list).toHaveBeenCalledTimes(admitted);
          await act(async () => { first.resolve(['gone.jpg']); });
          await waitFor(() => expect(p.cloudController.sweepCacheOrphans).toHaveBeenCalledTimes(1));
          if (operation === 'control') {
            expect(closed).toBe(false);
            await act(async () => { second.resolve([]); });
            await waitFor(() => expect(p.cloudController.sweepCacheOrphans).toHaveBeenCalledTimes(2));
            expect(closed).toBe(false);
            await view.unmount();
            unmounted = true;
          }
          await waitFor(() => expect(p.closeDatabase).toHaveBeenCalledTimes(1));
          if (operation === 'reload' || operation === 'props') {
            await screen.findByText('database:unconfigured');
            expect(events.indexOf('open')).toBeGreaterThan(events.indexOf('close'));
            if (operation === 'reload') expect(initializer).toHaveBeenCalledTimes(2);
            else expect(nextInitializer).toHaveBeenCalledTimes(1);
          }
          // Both bundle objects share the closed boundary, including the
          // original object still held by a collection caller.
          if (operation !== 'control') await p.bundle.resumeLibrary();
          for (const pass of passes) expect(p.cloudController[pass]).toHaveBeenCalledTimes(admitted);
          expect(p.localController.purgeUndoneLibraryRows).not.toHaveBeenCalled();
          expect(sqlAfterClose).toEqual([]);
        } finally {
          await act(async () => {
            first.resolve(['gone.jpg']);
            second.resolve([]);
            sweeping.resolve({ missing: [], deleted: [], failed: [] });
            if (collecting) await collecting.catch(() => undefined);
          });
          await flushAppEffects();
          if (view && !unmounted) await view.unmount();
          await flushAppEffects();
          if (!closed) h.close();
          storeSpy.mockRestore();
          portSpy.mockRestore();
        }
      },
    );

    test('finishing one invocation keeps another tracked before close starts', async () => {
      const p = lockedLibraryBundle();
      const first = deferred<number>();
      const second = deferred<number>();
      p.localController.noteMissingOriginals.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const firstInvocation = p.bundle.resumeLibrary();
      const secondInvocation = p.bundle.resumeLibrary();
      await waitFor(() => expect(p.localController.noteMissingOriginals).toHaveBeenCalledTimes(2));
      first.resolve(0);
      await firstInvocation;
      const closing = createAppServiceBundleCloser()(p.bundle);
      try {
        await flushAppEffects();
        expect(p.closeDatabase).not.toHaveBeenCalled();
        second.resolve(0);
        await secondInvocation;
        await closing;
        expect(p.localController.sweepCacheOrphans).toHaveBeenCalledTimes(2);
        expect(p.closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        second.resolve(0);
        await secondInvocation;
        await closing;
      }
    });

    test('a synchronous pass throw leaves the invocation resolved and permits close', async () => {
      const p = lockedLibraryBundle();
      p.localController.purgeUndoneLibraryRows.mockImplementation(() => {
        throw new Error('synchronous controller failure');
      });
      await expect(p.bundle.resumeLibrary()).resolves.toBeUndefined();
      await expect(createAppServiceBundleCloser()(p.bundle)).resolves.toBeUndefined();
      expect(p.closeDatabase).toHaveBeenCalledTimes(1);
    });

    test('a synchronous close drains an invocation admitted before the mark', async () => {
      const p = lockedLibraryBundle();
      const purge = deferred<number>();
      let closing: Promise<void> | undefined;
      let closed = false;
      // Admission precedes the synchronous seam. It enters close while the
      // admitted chain's promise is still being constructed and registered.
      p.localController.purgeUndoneLibraryRows.mockImplementation(() => {
        closing = p.bundle.closeLibraryResume().then(async () => {
          closed = true;
          await p.closeDatabase();
        });
        return purge.promise;
      });
      const invocation = p.bundle.resumeLibrary();
      try {
        await flushAppEffects();
        expect(closed).toBe(false);
        purge.resolve(0);
        await invocation;
        await closing;
        expect(p.localController.sweepCacheOrphans).toHaveBeenCalledTimes(1);
        expect(p.closeDatabase).toHaveBeenCalledTimes(1);
      } finally {
        purge.resolve(0);
        await invocation;
        await closing;
      }
    });
  });

  test.each([
    ['noteMissingOriginals', 'reject'], ['handOverExisting', 'resolve'],
    ['handOverExisting', 'reject'],
  ] as const)(
    'a pending %s (%s) retains the recovery chain and releases restore after settling',
    async (pass, outcome) => {
      const prepared = lockedLibraryBundle();
      const pendingPass = deferred<number>();
      prepared.cloudController[pass].mockImplementation(() => pendingPass.promise);
      const pick = jest.fn(async () => null);
      prepared.bundle.backupService = {
        pickAndPrepareRestore: pick,
      } as unknown as AppServiceBundle['backupService'];
      const passes = ['purgeUndoneLibraryRows', 'noteMissingOriginals',
        'reingestMissingLibraryRows', 'handOverExisting', 'sweepCacheOrphans'] as const;
      let restore!: () => Promise<unknown>;
      let remove!: () => Promise<unknown>;
      function Capture() {
        const { restoreFullBackup, deleteAllAppData } = useAppServices();
        useEffect(() => {
          restore = restoreFullBackup;
          remove = deleteAllAppData;
        }, [restoreFullBackup, deleteAllAppData]);
        return createElement(ByosProbe);
      }
      const initializer = jest.fn(async () => prepared.bundle);
      const view = await render(providerElement(
        createElement(Capture), initializer, undefined,
        appTestQueryClient(), async () => readyVault(),
      ));
      let restoring: Promise<unknown> | undefined;
      try {
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await screen.findByText('database:ready');
        await waitFor(() => expect(prepared.cloudController[pass]).toHaveBeenCalledTimes(1));
        await act(async () => { restoring = restore(); });
        await flushAppEffects();
        expect(pick).not.toHaveBeenCalled();
        expect(prepared.cloudController.sweepCacheOrphans).not.toHaveBeenCalled();
        if (outcome === 'resolve') {
          await act(async () => {
            await expect(restore()).rejects.toThrow('already in progress');
            await expect(remove()).rejects.toThrow('already in progress');
          });
          expect(pick).not.toHaveBeenCalled();
          expect(prepared.closeDatabase).not.toHaveBeenCalled();
        }
        await act(async () => {
          if (outcome === 'resolve') pendingPass.resolve(0);
          else pendingPass.reject(new Error('pass failed'));
          await restoring;
        });
        for (const name of passes) expect(prepared.cloudController[name]).toHaveBeenCalledTimes(1);
        expect(pick).toHaveBeenCalledTimes(1);
        expect(prepared.closeDatabase).not.toHaveBeenCalled();
        expect(screen.getByText('database:ready')).toBeOnTheScreen();
        expect(initializer).toHaveBeenCalledTimes(1);
      } finally {
        await act(async () => { pendingPass.resolve(0); if (restoring) await restoring; });
        await view.unmount();
      }
    },
  );

  test.each(['scope', 'trigger', 'registration'] as const)(
    'a failed recovery %s still runs all resume passes once in order',
    async (failure) => {
      const order: string[] = [];
      const prepared = lockedLibraryBundle();
      const passes = ['purgeUndoneLibraryRows', 'noteMissingOriginals',
        'reingestMissingLibraryRows', 'handOverExisting', 'sweepCacheOrphans'] as const;
      for (const pass of passes) {
        prepared.cloudController[pass].mockImplementation(async () => {
          order.push(pass);
          return 0;
        });
      }
      if (failure === 'scope') {
        prepared.getAccountScope.mockRejectedValue(new Error('scope failed'));
      } else if (failure === 'trigger') {
        prepared.onSessionReady.mockImplementation(() => { throw new Error('session failed'); });
      } else {
        prepared.ensureRegistered.mockRejectedValue(new Error('registration failed'));
      }
      const view = await render(providerElement(
        createElement(ByosProbe), async () => prepared.bundle, undefined,
        appTestQueryClient(), async () => readyVault(),
      ));
      try {
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await screen.findByText('database:ready');
        await waitFor(() => expect(order).toEqual(passes));
        for (const pass of passes) expect(prepared.cloudController[pass]).toHaveBeenCalledTimes(1);
        expect(prepared.closeDatabase).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );

  test.each([
    ['restore', 'before-operation'], ['restore', 'while-pending'],
    ['delete-all', 'before-operation'], ['delete-all', 'while-pending'],
  ] as const)(
    'recovery drains the production core passes before %s (%s native listing)',
    async (operation, listingOrder) => {
      const { createLibraryTestHarness } = jest.requireActual<
        typeof import('@/features/library/library-test-support')
      >('@/features/library/library-test-support');
      const fileModule = jest.requireActual<
        typeof import('@/features/library/library-expo-file-store')
      >('@/features/library/library-expo-file-store');
      const { createLocalLibraryIntegration } = jest.requireActual<
        typeof import('@/features/library/library-integration-local-core')
      >('@/features/library/library-integration-local-core');
      const { holdLibrarySync } = jest.requireActual<
        typeof import('@/features/library/library-background-sync-slot')
      >('@/features/library/library-background-sync-slot');
      const { createCollectionService: createCollection } = jest.requireActual<
        typeof import('@/features/collection/collection-service')
      >('@/features/collection/collection-service');
      const h = await createLibraryTestHarness();
      const storeSpy = jest.spyOn(fileModule, 'createExpoLibraryFileStore').mockReturnValue(h.files);
      const portSpy = jest.spyOn(fileModule, 'createExpoLibraryFilePort').mockReturnValue(h.port);
      const checking = deferred<string[]>();
      const listing = jest.fn(() => checking.promise);
      // This is the production readDirectoryAsync boundary. The rest of the
      // missing-original, backfill and cache passes use the real SQLite core.
      h.port.listOriginalNames = listing;
      const sqlAfterClose: string[] = [];
      let closed = false;
      const database: SqlDatabasePort = {
        ...h.database,
        async getAll<T>(sql: string, args?: readonly SqlBindValue[]) {
          if (closed) sqlAfterClose.push(sql);
          return h.database.getAll<T>(sql, args);
        },
        async run(sql: string, args?: readonly SqlBindValue[]) {
          if (closed) sqlAfterClose.push(sql);
          return h.database.run(sql, args);
        },
      };
      await database.run(`INSERT INTO device_library_assets (
        plaintext_sha256, format, canonical_extension, byte_size, width, height,
        origin, source_image_id, local_original_uri, residency, protect_eligible,
        missing_original_since, created_at, updated_at
      ) VALUES (?, 'jpeg', 'jpg', 100, 10, 10, 'import', NULL, ?, 'local-original', 1, NULL, 1, 1)`,
      ['d'.repeat(64), h.port.resolveOriginal('missing.jpg')]);
      const integration = createLocalLibraryIntegration({
        database,
        resetHooks: {
          hold: async () => {
            const release = await holdLibrarySync();
            return { settleUploads: async () => undefined, end: () => release() };
          },
        },
      });
      const core = integration.libraryController;
      if (core === null) throw new Error('Expected the production library core');
      const prepared = lockedLibraryBundle();
      Object.assign(prepared.cloudController, core);
      const events: string[] = [];
      const resumeFinished = jest.fn();
      const sweep = jest.spyOn(prepared.cloudController, 'sweepCacheOrphans')
        .mockImplementation(async () => {
          const count = await core.sweepCacheOrphans();
          events.push('resume-finished');
          resumeFinished();
          return count;
        });
      const beginReset = jest.spyOn(core, 'beginReset');
      // Object.assign above copies the controller methods. Use this spy for
      // both restore and the production collection service's library reset.
      prepared.bundle.libraryController = core;
      Object.assign(prepared.cloudController, { beginReset });
      const imageRepository = createImageRepository(database);
      const deleteRows = jest.spyOn(imageRepository, 'deleteAll');
      prepared.bundle.imageRepository = imageRepository;
      if (operation === 'delete-all') {
        const files = {
          deleteAll: jest.fn(async () => ({ deleted: [], failed: [] })),
          reconcile: jest.fn(async () => ({ deleted: [], failed: [] })),
        } as unknown as CollectionFileRepository;
        prepared.bundle.collectionService = createCollection({
          repository: imageRepository,
          files,
          coordinator: prepared.bundle.resetCoordinator,
          libraryReset: async () => {
            const session = await core.beginReset();
            return {
              async finish() {
                events.push('delete');
                try {
                  await session.clearDevice();
                  expect(await database.getAll('SELECT * FROM device_library_assets')).toEqual([]);
                  await session.forgetCloudLibraries();
                  return { rows: 'deleted', failedFiles: [], cloud: 'deleted',
                    disconnected: true, error: null };
                } finally { session.end({ retire: true }); }
              },
              abandon() { session.end({ retire: false }); },
            };
          },
        });
      }
      const applying = deferred<AppSettings>();
      const apply = jest.fn(() => applying.promise);
      const pick = jest.fn(async () => {
        events.push('pick');
        return { summary: {}, apply, dispose: async () => undefined };
      });
      prepared.bundle.backupService = {
        pickAndPrepareRestore: pick,
      } as unknown as AppServiceBundle['backupService'];
      prepared.closeDatabase.mockImplementation(async () => {
        if (closed) return;
        events.push('close');
        closed = true;
        h.close();
      });
      const beginExclusive = jest.spyOn(prepared.bundle.resetCoordinator, 'beginExclusive');
      const resetRequest = jest.spyOn(prepared.bundle.resetCoordinator, 'beginReset');
      let begin!: () => Promise<unknown>;
      function Capture() {
        const { restoreFullBackup, deleteAllAppData } = useAppServices();
        useEffect(() => {
          begin = operation === 'restore' ? restoreFullBackup : deleteAllAppData;
        }, [restoreFullBackup, deleteAllAppData]);
        return createElement(ByosProbe);
      }
      const initializer = jest.fn().mockResolvedValueOnce(prepared.bundle).mockResolvedValue(appBundle());
      let view: Awaited<ReturnType<typeof render>> | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        view = await render(providerElement(
          createElement(Capture), initializer, undefined, appTestQueryClient(), async () => readyVault(),
        ));
        await screen.findByText('database:locked:vault_unreachable');
        await act(async () => (mockNetworkRecovery as NetworkRecoveryHarness).emit());
        await screen.findByText('database:ready');
        await waitFor(() => expect(listing).toHaveBeenCalledTimes(1));
        if (listingOrder === 'before-operation') {
          await act(async () => { checking.resolve([]); });
          await waitFor(() => expect(resumeFinished).toHaveBeenCalledTimes(1));
          await flushAppEffects();
        }
        await act(async () => { pending = begin(); });
        await waitFor(() => expect(operation === 'restore' ? beginExclusive : resetRequest)
          .toHaveBeenCalledTimes(1));
        if (listingOrder === 'while-pending') {
          await flushAppEffects();
          expect(pick).not.toHaveBeenCalled();
          expect(apply).not.toHaveBeenCalled();
          expect(beginReset).not.toHaveBeenCalled();
          expect(deleteRows).not.toHaveBeenCalled();
          expect(prepared.closeDatabase).not.toHaveBeenCalled();
          expect(closed).toBe(false);
          expect(resumeFinished).not.toHaveBeenCalled();
          await act(async () => { checking.resolve([]); });
        }
        if (operation === 'restore') {
          await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
          expect(events).toEqual(['resume-finished', 'pick', 'close']);
          await act(async () => { applying.resolve(DEFAULT_SETTINGS); await pending; });
        } else {
          await act(async () => { await pending; });
          expect(deleteRows).toHaveBeenCalledTimes(1);
          expect(events).toEqual(['resume-finished', 'delete', 'close']);
        }
        await screen.findByText('database:unconfigured');
        expect(beginReset).toHaveBeenCalledTimes(1);
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(sqlAfterClose).toEqual([]);
      } finally {
        await act(async () => {
          checking.resolve([]);
          applying.resolve(DEFAULT_SETTINGS);
          if (pending) await pending;
        });
        if (view) await view.unmount();
        if (!closed) h.close();
        storeSpy.mockRestore();
        portSpy.mockRestore();
      }
    },
  );

  test('unmount after a rebind disposes the rebound integration once and closes the database once', async () => {
    const prepared = lockedLibraryBundle();
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async () => readyVault());
    const initializer = jest.fn(async () => prepared.bundle);

    const view = await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      recovery.emit();
    });
    await screen.findByText('database:ready');

    await view.unmount();

    await waitFor(() => expect(prepared.libraryDispose).toHaveBeenCalledTimes(1));
    expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
    expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
  });

  test('a manual reload after a rebind closes the rebound integration once', async () => {
    const prepared = lockedLibraryBundle();
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async () => readyVault());
    const reopened = deferred<AppServiceBundle>();
    const initializer = jest.fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(prepared.bundle)
      .mockReturnValueOnce(reopened.promise);

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await act(async () => {
      recovery.emit();
    });
    await screen.findByText('database:ready');

    await fireEvent.press(screen.getByRole('button', { name: 'provider reload services' }));

    await waitFor(() => expect(prepared.closeDatabase).toHaveBeenCalledTimes(1));
    expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
    expect(prepared.triggerDispose).toHaveBeenCalledTimes(1);
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(2);

    await act(async () => {
      reopened.resolve(appBundle({ databaseId: 'reloaded' }));
    });
    expect(await screen.findByText('reloaded:unconfigured')).toBeOnTheScreen();
    expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
    expect(prepared.libraryDispose).toHaveBeenCalledTimes(1);
  });

  test('a manual reload during an in-flight recovery resolve does not rebind onto the closing handle', async () => {
    const prepared = lockedLibraryBundle();
    const verdict = deferred<ByosStatus>();
    const resolveVault = jest.fn(() => verdict.promise);
    const reopened = deferred<AppServiceBundle>();
    const initializer = jest.fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(prepared.bundle)
      .mockReturnValueOnce(reopened.promise);

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');
    await waitFor(() => expect(mockNetworkRecovery?.subscribe).toHaveBeenCalled());

    await act(async () => {
      (mockNetworkRecovery as NetworkRecoveryHarness).emit();
    });
    expect(resolveVault).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: 'provider reload services' }));
    await waitFor(() => expect(prepared.closeDatabase).toHaveBeenCalledTimes(1));
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(1);

    await act(async () => {
      verdict.resolve(readyVault());
    });
    await flushAppEffects();

    expect(prepared.createLibraryIntegration).toHaveBeenCalledTimes(1);
    expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
    expect(prepared.libraryDispose).not.toHaveBeenCalled();
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(2);

    await act(async () => {
      reopened.resolve(appBundle({ databaseId: 'reloaded' }));
    });
    expect(await screen.findByText('reloaded:unconfigured')).toBeOnTheScreen();
    expect(prepared.closeDatabase).toHaveBeenCalledTimes(1);
  });

  test('a recovery whose verdict is another lock takes the full reload', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async (): Promise<ByosStatus> => ({
      status: 'locked',
      reason: 'password_required',
    }));
    const reopened = deferred<AppServiceBundle>();
    const initializer = jest.fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({ byosStatus: NETWORK_LOCK }))
      .mockReturnValueOnce(reopened.promise);
    const mounts = { current: 0 };
    const onMount = () => {
      mounts.current += 1;
    };

    await render(providerElement(
      createElement(
        View,
        null,
        createElement(RecoveryMarker, { onMount }),
        createElement(ByosProbe),
      ),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('marker:vault_unreachable');

    await act(async () => {
      recovery.emit();
    });

    await waitFor(() => expect(resolveVault).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    expect(screen.queryByText(/marker:/)).toBeNull();

    await act(async () => {
      reopened.resolve(appBundle({
        databaseId: 'reloaded',
        byosStatus: { status: 'locked', reason: 'password_required' },
      }));
    });

    expect(await screen.findByText('reloaded:locked:password_required')).toBeOnTheScreen();
    expect(await screen.findByText('marker:password_required')).toBeOnTheScreen();
    expect(mounts.current).toBe(2);
  });

  test('a recovery whose resolver rejects takes the full reload', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async (): Promise<ByosStatus> => {
      throw new Error('vault resolve failed');
    });
    const reopened = deferred<AppServiceBundle>();
    const initializer = jest.fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({ byosStatus: NETWORK_LOCK }))
      .mockReturnValueOnce(reopened.promise);

    await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');

    await act(async () => {
      recovery.emit();
    });

    await waitFor(() => expect(resolveVault).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(initializer).toHaveBeenCalledTimes(2));
    expect(screen.getByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    expect(screen.queryByText('database:locked:vault_unreachable')).toBeNull();

    await act(async () => {
      reopened.resolve(appBundle({ databaseId: 'reloaded' }));
    });
    expect(await screen.findByText('reloaded:unconfigured')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(2);
  });

  test('a lock for another reason ends the sequence', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      }))
      .mockResolvedValueOnce(appBundle({
        databaseId: 'password-locked',
        byosStatus: { status: 'locked', reason: 'password_required' },
      }));

    await render(providerElement(createElement(ByosProbe), initializer));
    await screen.findByText('database:locked:vault_unreachable');

    jest.useFakeTimers();
    try {
      await act(async () => recovery.emit());
      await flushAppEffects();
      expect(await screen.findByText('password-locked:locked:password_required')).toBeOnTheScreen();
      await act(async () => jest.advanceTimersByTime(13_000));
      expect(initializer).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('unmount cancels a pending retry', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async () => NETWORK_LOCK);
    const initializer = jest.fn(async () => appBundle({ byosStatus: NETWORK_LOCK }));

    const view = await render(providerElement(
      createElement(ByosProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await screen.findByText('database:locked:vault_unreachable');

    jest.useFakeTimers();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    try {
      await act(async () => recovery.emit());
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(1);
      const clearCallsBeforeUnmount = clearTimeoutSpy.mock.calls.length;
      await view.unmount();
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearCallsBeforeUnmount);
      await act(async () => jest.advanceTimersByTime(13_000));
      expect(resolveVault).toHaveBeenCalledTimes(1);
      expect(initializer).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('a network lock without a recovery schedules no retry', async () => {
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      }))
      .mockResolvedValueOnce(appBundle({
        databaseId: 'settings-retry',
        byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      }));

    await render(providerElement(createElement(ByosProbe), initializer));
    await screen.findByText('database:locked:vault_unreachable');

    jest.useFakeTimers();
    try {
      await act(async () => jest.advanceTimersByTime(13_000));
      expect(initializer).toHaveBeenCalledTimes(1);
      await fireEvent.press(screen.getByRole('button', { name: 'provider reload services' }));
      await flushAppEffects();
      expect(await screen.findByText('settings-retry:locked:vault_unreachable')).toBeOnTheScreen();
      await act(async () => jest.advanceTimersByTime(13_000));
      expect(initializer).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a restore ends a pending recovery retry', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const pick = deferred<unknown>();
    const second = appBundle({
      databaseId: 'retrying',
      byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
    });
    const pickAndPrepareRestore = jest.fn(() => pick.promise);
    second.backupService = {
      createArchive: jest.fn(),
      createAndShare: jest.fn(),
      prepareRestoreFromUri: jest.fn(),
      pickAndPrepareRestore,
    } as unknown as AppServiceBundle['backupService'];
    second.resetCoordinator = {
      beginExclusive: jest.fn(async () => ({ release: jest.fn() })),
      beginReset: jest.fn(async () => ({ release: jest.fn() })),
    } as unknown as DataResetCoordinator;
    const prepared = {
      summary: {
        formatVersion: 1,
        applicationId: 'app.waifudeck.mobile',
        appVersion: '1.1.0',
        createdAt: 123,
        imageCount: 0,
        fileCount: 0,
        totalFileBytes: 0,
        restoredFileCount: 0,
        missingFileCount: 0,
      },
      apply: jest.fn(async () => DEFAULT_SETTINGS),
      dispose: jest.fn(async () => undefined),
    };
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      }))
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(appBundle({ databaseId: 'restored' }));

    await render(providerElement(createElement(BackupRestoreProbe), initializer));
    await flushAppEffects();
    expect(initializer).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    try {
      await act(async () => recovery.emit());
      await flushAppEffects();
      expect(initializer).toHaveBeenCalledTimes(2);
      await fireEvent.press(await screen.findByRole('button', { name: 'provider restore backup' }));
      await flushAppEffects();
      expect(pickAndPrepareRestore).toHaveBeenCalledTimes(1);

      await act(async () => jest.advanceTimersByTime(3_000));
      expect(initializer).toHaveBeenCalledTimes(2);

      await act(async () => pick.resolve(prepared));
      await waitFor(() => expect(initializer).toHaveBeenCalledTimes(3));
    } finally {
      jest.useRealTimers();
    }
  });

  test('delete-all ends a pending recovery retry before it touches the bundle', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const deleteAll = deferred<DeleteAllDataResult>();
    const second = appBundle({
      databaseId: 'retrying',
      byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      deleteAllData: jest.fn(() => deleteAll.promise),
    });
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      }))
      .mockResolvedValueOnce(second);

    await render(providerElement(createElement(DeleteAllProbe), initializer));
    await flushAppEffects();
    expect(initializer).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    try {
      await act(async () => recovery.emit());
      await flushAppEffects();
      expect(initializer).toHaveBeenCalledTimes(2);
      await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

      await act(async () => jest.advanceTimersByTime(3_000));
      expect(initializer).toHaveBeenCalledTimes(2);

      await act(async () => deleteAll.resolve(deleteAllResult('deleted')));
      expect(await screen.findByText('reset:deleted')).toBeOnTheScreen();
      expect(initializer).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('delete-all cancels the retry timer synchronously when it starts', async () => {
    const recovery = mockNetworkRecovery as NetworkRecoveryHarness;
    const resolveVault = jest.fn(async () => NETWORK_LOCK);
    const deleteAll = deferred<DeleteAllDataResult>();
    const bundle = appBundle({
      byosStatus: NETWORK_LOCK,
      deleteAllData: jest.fn(() => deleteAll.promise),
    });
    const initializer = jest.fn(async () => bundle);

    await render(providerElement(
      createElement(DeleteAllMethodProbe),
      initializer,
      undefined,
      appTestQueryClient(),
      resolveVault,
    ));
    await flushAppEffects();
    jest.useFakeTimers();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    try {
      await act(async () => recovery.emit());
      await flushAppEffects();
      expect(resolveVault).toHaveBeenCalledTimes(1);

      const clearCallsBeforeStart = clearTimeoutSpy.mock.calls.length;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let operation: Promise<DeleteAllAppDataResult> | undefined;
      try {
        operation = startDeleteAllRef.current?.();
      } finally {
        consoleError.mockRestore();
      }
      expect(operation).toBeDefined();
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearCallsBeforeStart);
      await act(async () => jest.advanceTimersByTime(3_000));
      expect(resolveVault).toHaveBeenCalledTimes(1);

      await act(async () => {
        deleteAll.resolve(deleteAllResult('deleted'));
        await operation;
      });
    } finally {
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('K4 T4: registers the background task and starts a session-ready cycle when a bundle is ready with a bound account', async () => {
    const onSessionReady = jest.fn();
    const ensureRegistered = jest.fn(async () => undefined);
    const ensureUnregistered = jest.fn(async () => undefined);
    const initializer = jest.fn(async () => appBundle({
      librarySyncTrigger: { dispose: jest.fn(), onSessionReady },
      libraryActions: { getAccountScope: jest.fn(async () => 'scope-1') },
      libraryBackgroundSync: { ensureRegistered, ensureUnregistered },
    }));

    await render(providerElement(createElement(ByosProbe), initializer));
    await screen.findByText('database:unconfigured');

    await waitFor(() => expect(ensureRegistered).toHaveBeenCalledTimes(1));
    expect(onSessionReady).toHaveBeenCalledTimes(1);
    expect(ensureUnregistered).not.toHaveBeenCalled();
  });

  test('K4 T4: unregisters the background task when a bundle is ready with no bound account', async () => {
    const onSessionReady = jest.fn();
    const ensureRegistered = jest.fn(async () => undefined);
    const ensureUnregistered = jest.fn(async () => undefined);
    const initializer = jest.fn(async () => appBundle({
      librarySyncTrigger: { dispose: jest.fn(), onSessionReady },
      libraryActions: { getAccountScope: jest.fn(async () => null) },
      libraryBackgroundSync: { ensureRegistered, ensureUnregistered },
    }));

    await render(providerElement(createElement(ByosProbe), initializer));
    await screen.findByText('database:unconfigured');

    await waitFor(() => expect(ensureUnregistered).toHaveBeenCalledTimes(1));
    expect(onSessionReady).not.toHaveBeenCalled();
    expect(ensureRegistered).not.toHaveBeenCalled();
  });

  test('holds the reload initializer until the superseded database has closed', async () => {
    const closeGate = deferred<void>();
    const closeDatabase = jest.fn(() => closeGate.promise);
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockResolvedValueOnce(appBundle({
        closeDatabase,
        byosStatus: { status: 'locked', reason: 'password_required' },
      }))
      .mockResolvedValueOnce(appBundle({
        databaseId: 'reloaded',
        byosStatus: { status: 'ready', context: byosContext() },
      }));

    await render(providerElement(createElement(ByosProbe), initializer));
    expect(
      await screen.findByText('database:locked:password_required'),
    ).toBeOnTheScreen();

    await fireEvent.press(
      await screen.findByRole('button', { name: 'provider reload services' }),
    );

    // Reload closes the superseded bundle first; the fresh initializer opens a
    // new handle on the same waifu-deck.db, so it must not run until that close
    // resolves. Two live handles contend on the WAL and lock the DB (D2).
    await waitFor(() => expect(closeDatabase).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('database:locked:password_required')).toBeNull();

    // Once the superseded handle is released, the reopen proceeds.
    await act(async () => closeGate.resolve());
    expect(await screen.findByText('reloaded:ready')).toBeOnTheScreen();
    expect(initializer).toHaveBeenCalledTimes(2);
  });

  test('renders selectable migration diagnostics and the destructive reset command', async () => {
    await render(providerElement(
      createElement(BundleProbe),
      async () => Promise.reject(new Error('migration failed')),
    ));

    const diagnostics = await screen.findByLabelText('数据库诊断信息');
    expect(diagnostics).toHaveTextContent('Error: migration failed');
    expect(diagnostics.props.selectable).toBe(true);
    expect(
      screen.getByRole('button', { name: '删除本地数据并重新初始化' }),
    ).toBeEnabled();
  });

  test('resets failed startup, reinitializes, and renders the new bundle', async () => {
    const next = { ...DEFAULT_SETTINGS, minWidth: 1080 as const };
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockRejectedValueOnce(new Error('migration failed'))
      .mockResolvedValueOnce(appBundle({ databaseId: 'replacement', initialSettings: next }));
    const resetter = jest.fn(async () => undefined);

    await render(providerElement(createElement(BundleProbe), initializer, resetter));

    await fireEvent.press(
      await screen.findByRole('button', { name: '删除本地数据并重新初始化' }),
    );

    expect(await screen.findByText('replacement:1080')).toBeOnTheScreen();
    expect(resetter).toHaveBeenCalledTimes(1);
    expect(initializer).toHaveBeenCalledTimes(2);
  });

  test('a recovery reset drops every cached query before the new composition starts', async () => {
    const staleDeck = { active: { id: 2342 }, queued: [] };
    const queryClient = appTestQueryClient();
    let cacheAtRestart: string[] | null = null;
    queryClient.setQueryData(['discovery', 'deck'], staleDeck);
    const initializer = jest
      .fn<Promise<AppServiceBundle>, []>()
      .mockRejectedValueOnce(new Error('migration failed'))
      .mockImplementationOnce(async () => {
        cacheAtRestart = queryClient.getQueryCache().getAll().map((query) => query.queryHash);
        return appBundle({ databaseId: 'replacement' });
      });
    const resetter = jest.fn(async () => undefined);

    await render(providerElement(
      createElement(BundleProbe),
      initializer,
      resetter,
      queryClient,
    ));

    await fireEvent.press(
      await screen.findByRole('button', { name: '删除本地数据并重新初始化' }),
    );

    expect(await screen.findByText('replacement:0')).toBeOnTheScreen();
    expect(resetter).toHaveBeenCalledTimes(1);
    expect(initializer).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(cacheAtRestart).toEqual([]);
  });

  test('keeps recovery visible with the reset failure diagnostic', async () => {
    const staleDeck = { active: { id: 2342 }, queued: [] };
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(['discovery', 'deck'], staleDeck);
    const initializer = jest.fn(async () => Promise.reject(new Error('migration failed')));
    const resetter = jest.fn(async () => Promise.reject(new Error('reset failed')));

    await render(providerElement(
      createElement(BundleProbe),
      initializer,
      resetter,
      queryClient,
    ));

    await fireEvent.press(
      await screen.findByRole('button', { name: '删除本地数据并重新初始化' }),
    );

    expect(await screen.findByText('Error: reset failed')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: '删除本地数据并重新初始化' }),
    ).toBeEnabled();
    expect(initializer).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['discovery', 'deck'])).toEqual(staleDeck);
  });

  test('closes a bundle that resolves after provider unmount without rendering it', async () => {
    const pending = deferred<AppServiceBundle>();
    const closeDatabase = jest.fn(async () => undefined);
    const view = await render(providerElement(
      createElement(Text, null, 'late child'),
      () => pending.promise,
    ));

    expect(await screen.findByText('正在准备 Waifu Deck')).toBeOnTheScreen();
    await view.unmount();
    pending.resolve(appBundle({ closeDatabase }));

    await waitFor(() => expect(closeDatabase).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('late child')).not.toBeOnTheScreen();
  });

  test('uses TanStack Query as the single Waifu retry scheduler', () => {
    const client = createAppQueryClient();
    const defaults = client.getDefaultOptions();

    expect(defaults.queries?.retry).toBe(shouldRetryWaifu);
    expect(defaults.queries?.retryDelay).toBe(waifuRetryDelay);
    expect(defaults.mutations?.retry).toBe(false);
  });

  test('initialization sweeps once per process, before the services are ready', async () => {
    let isolatedTest!: Promise<void>;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeAppServices } = require('@/providers/app-services') as typeof import('@/providers/app-services');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sweepBackupArtifacts } = require('@/features/backup/backup-service') as typeof import('@/features/backup/backup-service');
      isolatedTest = (async () => {
        const sweep = sweepBackupArtifacts as jest.Mock;
        const done = deferred<{ deleted: string[]; failed: never[] }>();
        sweep.mockImplementationOnce(() => done.promise);
        const events: string[] = [];
        const openDatabase = jest.fn(async () => {
          events.push('open');
          throw new Error('open failed');
        });

        const first = initializeAppServices(openDatabase);
        await waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
        expect(events).toEqual([]);

        done.resolve({ deleted: [], failed: [] });
        await expect(first).rejects.toThrow('open failed');
        await expect(initializeAppServices(openDatabase)).rejects.toThrow('open failed');
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(events).toEqual(['open', 'open']);
      })();
    });
    await isolatedTest;
  });

  test('initialization sweeps library stream files before the database and only once', async () => {
    let isolatedTest!: Promise<void>;
    jest.isolateModules(() => {
      const events: string[] = [];
      jest.doMock('@/features/library/library-expo-file-store', () => {
        const actual = jest.requireActual('@/features/library/library-expo-file-store');
        return {
          ...actual,
          createExpoLibraryFileStore: jest.fn(() => ({
            sweepStreamDir: jest.fn(async () => {
              events.push('stream');
              return 2;
            }),
            // Board row 45: the same startup sweep empties the share staging
            // area, so a shared copy cannot outlive the process.
            sweepShareDir: jest.fn(async () => {
              events.push('share');
              return 1;
            }),
          })),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeAppServices } = require('@/providers/app-services') as typeof import('@/providers/app-services');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sweepBackupArtifacts } = require('@/features/backup/backup-service') as typeof import('@/features/backup/backup-service');
      const sweep = sweepBackupArtifacts as jest.Mock;
      sweep.mockImplementation(async () => {
        events.push('backup');
        return { deleted: [], failed: [] };
      });
      const openDatabase = jest.fn(async () => {
        events.push('open');
        throw new Error('open failed');
      });
      isolatedTest = (async () => {
        await expect(initializeAppServices(openDatabase)).rejects.toThrow('open failed');
        await expect(initializeAppServices(openDatabase)).rejects.toThrow('open failed');
        expect(events).toEqual(['backup', 'stream', 'share', 'open', 'open']);
      })();
    });
    await isolatedTest;
    jest.dontMock('@/features/library/library-expo-file-store');
  });

  test('a failed library stream sweep does not block database opening', async () => {
    let isolatedTest!: Promise<void>;
    jest.isolateModules(() => {
      jest.doMock('@/features/library/library-expo-file-store', () => {
        const actual = jest.requireActual('@/features/library/library-expo-file-store');
        return {
          ...actual,
          createExpoLibraryFileStore: jest.fn(() => ({
            sweepStreamDir: jest.fn(async () => {
              throw new Error('stream sweep failed');
            }),
          })),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeAppServices } = require('@/providers/app-services') as typeof import('@/providers/app-services');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sweepBackupArtifacts } = require('@/features/backup/backup-service') as typeof import('@/features/backup/backup-service');
      (sweepBackupArtifacts as jest.Mock).mockResolvedValue({ deleted: [], failed: [] });
      const openDatabase = jest.fn(async () => {
        throw new Error('open failed');
      });
      isolatedTest = (async () => {
        await expect(initializeAppServices(openDatabase)).rejects.toThrow('open failed');
        expect(openDatabase).toHaveBeenCalledTimes(1);
      })();
    });
    await isolatedTest;
    jest.dontMock('@/features/library/library-expo-file-store');
  });

  // Review fix 2: even the sweep's factory can throw — on a platform without
  // private storage `createExpoLibraryFileStore` rejects before any sweep
  // runs. Startup must only warn about it and still open the database.
  test('a throwing library file-store factory does not block database opening', async () => {
    let isolatedTest!: Promise<void>;
    jest.isolateModules(() => {
      jest.doMock('@/features/library/library-expo-file-store', () => {
        const actual = jest.requireActual('@/features/library/library-expo-file-store');
        return {
          ...actual,
          createExpoLibraryFileStore: jest.fn(() => {
            throw new Error('no private storage');
          }),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeAppServices } = require('@/providers/app-services') as typeof import('@/providers/app-services');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sweepBackupArtifacts } = require('@/features/backup/backup-service') as typeof import('@/features/backup/backup-service');
      (sweepBackupArtifacts as jest.Mock).mockResolvedValue({ deleted: [], failed: [] });
      const openDatabase = jest.fn(async () => {
        throw new Error('open failed');
      });
      isolatedTest = (async () => {
        await expect(initializeAppServices(openDatabase)).rejects.toThrow('open failed');
        expect(openDatabase).toHaveBeenCalledTimes(1);
      })();
    });
    await isolatedTest;
    jest.dontMock('@/features/library/library-expo-file-store');
  });

  // Review fix 5: the two startup sweeps are independent — a throwing stream
  // sweep must still empty the share staging area, and the database still
  // opens.
  test('a failed library stream sweep still empties the share area before the database opens', async () => {
    let isolatedTest!: Promise<void>;
    jest.isolateModules(() => {
      const events: string[] = [];
      jest.doMock('@/features/library/library-expo-file-store', () => {
        const actual = jest.requireActual('@/features/library/library-expo-file-store');
        return {
          ...actual,
          createExpoLibraryFileStore: jest.fn(() => ({
            sweepStreamDir: jest.fn(async () => {
              events.push('stream');
              throw new Error('stream sweep failed');
            }),
            sweepShareDir: jest.fn(async () => {
              events.push('share');
              return 1;
            }),
          })),
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeAppServices } = require('@/providers/app-services') as typeof import('@/providers/app-services');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sweepBackupArtifacts } = require('@/features/backup/backup-service') as typeof import('@/features/backup/backup-service');
      (sweepBackupArtifacts as jest.Mock).mockResolvedValue({ deleted: [], failed: [] });
      const openDatabase = jest.fn(async () => {
        events.push('open');
        throw new Error('open failed');
      });
      isolatedTest = (async () => {
        await expect(initializeAppServices(openDatabase)).rejects.toThrow('open failed');
        expect(events).toEqual(['stream', 'share', 'open']);
        expect(openDatabase).toHaveBeenCalledTimes(1);
      })();
    });
    await isolatedTest;
    jest.dontMock('@/features/library/library-expo-file-store');
  });

  test('a failed startup backup sweep does not block initialization', async () => {
    let isolatedTest!: Promise<void>;
    jest.isolateModules(() => {
      jest.doMock('expo-sqlite/kv-store', () => ({
        __esModule: true,
        default: {
          getItem: jest.fn(async () => null),
          setItem: jest.fn(async () => undefined),
          removeItem: jest.fn(async () => undefined),
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { initializeAppServices } = require('@/providers/app-services') as typeof import('@/providers/app-services');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sweepBackupArtifacts } = require('@/features/backup/backup-service') as typeof import('@/features/backup/backup-service');
      const database = {
        exec: jest.fn(async () => undefined),
        run: jest.fn(async () => ({ changes: 0, lastInsertRowId: 0 })),
        getFirst: jest.fn(async () => null),
        getAll: jest.fn(async () => []),
        transaction: jest.fn(async (task: (port: SqlDatabasePort) => unknown) => task(database as unknown as SqlDatabasePort)),
      } as unknown as SqlDatabasePort;
      const openDatabase = jest.fn(async () => ({
        database,
        close: jest.fn(async () => undefined),
      }));
      const sweep = sweepBackupArtifacts as jest.Mock;
      sweep.mockRejectedValueOnce(new Error('sweep failed'));

      isolatedTest = (async () => {
        await expect(initializeAppServices(openDatabase)).resolves.toEqual(
          expect.objectContaining({ database }),
        );
        expect(sweep).toHaveBeenCalledTimes(1);
        expect(openDatabase).toHaveBeenCalledTimes(1);
      })();
    });
    try {
      await isolatedTest;
    } finally {
      jest.dontMock('expo-sqlite/kv-store');
    }
  });

  test('clears settings and private files before resetting the database', async () => {
    const calls: string[] = [];
    await resetOwnedAppData({
      settingsRepository: {
        reset: jest.fn(async () => {
          calls.push('settings');
        }),
      } as unknown as SettingsRepository,
      fileRepository: {
        deleteAll: jest.fn(async () => {
          calls.push('files');
          return { deleted: [], failed: [] };
        }),
      } as unknown as CollectionFileRepository,
      libraryFiles: {
        deleteAllDeviceFiles: jest.fn(async () => {
          calls.push('library');
          return [];
        }),
      },
      resetDatabase: jest.fn(async () => {
        calls.push('database');
      }),
    });

    expect(calls.slice(0, 3).sort()).toEqual(['files', 'library', 'settings']);
    expect(calls.at(-1)).toBe('database');
  });

  test('删除全部应用数据 deletes leftover backup files', async () => {
    const sweep = sweepBackupArtifacts as jest.Mock;
    const failed = {
      uri: 'file:///database/restore-import-1790850945725.waifudeck',
      error: { code: 'delete_failed', message: 'busy' },
    };
    sweep.mockResolvedValueOnce({ deleted: [], failed: [failed] });
    lastDeleteAllResult = null;
    const queryClient = appTestQueryClient();

    await render(providerElement(
      createElement(DeleteAllProbe),
      async () => appBundle({ deleteAllData: jest.fn(async () => deleteAllResult('deleted')) }),
      undefined,
      queryClient,
    ));
    await fireEvent.press(await screen.findByRole('button', { name: '删除全部数据' }));

    await waitFor(() => expect(lastDeleteAllResult).not.toBeNull());
    const completed = lastDeleteAllResult as unknown as DeleteAllAppDataResult;
    expect(completed.files.failed).toEqual([failed]);
    expect(completed.remaining).toContain('files');
    expect(completed.ok).toBe(false);
  });

  test('a library file left behind fails the startup reset', async () => {
    const reset = resetOwnedAppData({
      settingsRepository: {
        reset: jest.fn(async () => undefined),
      } as unknown as SettingsRepository,
      fileRepository: {
        deleteAll: jest.fn(async () => ({ deleted: [], failed: [] })),
      } as unknown as CollectionFileRepository,
      libraryFiles: {
        deleteAllDeviceFiles: jest.fn(async () => ['file:///x']),
      },
      resetDatabase: jest.fn(async () => undefined),
    });

    await expect(reset).rejects.toThrow('App-owned data could not be completely reset.');
  });

  test('the startup reset deletes leftover backup files', async () => {
    const sweep = sweepBackupArtifacts as jest.Mock;
    sweep.mockResolvedValueOnce({
      deleted: ['file:///database/backup-snapshot-1790850945700.db'],
      failed: [{
        uri: 'file:///database/backup-snapshot-1790850945700.db-wal',
        error: { code: 'delete_failed', message: 'busy' },
      }],
    });

    const reset = resetOwnedAppData({
      settingsRepository: { reset: jest.fn(async () => undefined) } as unknown as SettingsRepository,
      fileRepository: { deleteAll: jest.fn(async () => ({ deleted: [], failed: [] })) } as unknown as CollectionFileRepository,
      libraryFiles: { deleteAllDeviceFiles: jest.fn(async () => []) },
      resetDatabase: jest.fn(async () => undefined),
    });

    await expect(reset).rejects.toMatchObject({ name: 'AggregateError' });
    expect(sweep).toHaveBeenCalled();
  });

  test('a library file deletion that throws fails the startup reset', async () => {
    const reset = resetOwnedAppData({
      settingsRepository: {
        reset: jest.fn(async () => undefined),
      } as unknown as SettingsRepository,
      fileRepository: {
        deleteAll: jest.fn(async () => ({ deleted: [], failed: [] })),
      } as unknown as CollectionFileRepository,
      libraryFiles: {
        deleteAllDeviceFiles: jest.fn(async () => {
          throw new Error('disk');
        }),
      },
      resetDatabase: jest.fn(async () => undefined),
    });

    await expect(reset).rejects.toThrow('App-owned data could not be completely reset.');
  });
});

describe('board #27 S1b: the provider republishes a handed-over row when no screen does', () => {
  const D = 'd'.repeat(64);
  const readyRow = { id: 7, decision: 'saved', downloadState: 'ready' } as unknown as StoredImage;
  const mirroredRow = { id: 7, decision: 'saved', downloadState: 'mirrored' } as unknown as StoredImage;

  function setup() {
    const libraryChanges = createLibraryChangeFeed();
    const getById = jest.fn(async (_id: number) => mirroredRow);
    const bundle = appBundle({
      imageRepository: { getById } as unknown as ImageRepository,
    });
    (bundle as unknown as { libraryChanges: unknown }).libraryChanges = libraryChanges;
    const queryClient = appTestQueryClient();
    queryClient.setQueryData(collectionQueryKey(), [readyRow]);
    return { libraryChanges, getById, bundle, queryClient };
  }

  function cachedState(queryClient: QueryClient) {
    return (queryClient.getQueryData(collectionQueryKey()) as StoredImage[])[0]?.downloadState;
  }

  function SearchProbe() {
    // Search observes the collection and stays mounted, but re-reads no entries.
    useQuery({
      queryKey: collectionQueryKey(),
      queryFn: async () => [readyRow],
      staleTime: Infinity,
    });
    return null;
  }

  function PublisherProbe() {
    useHandedOverPublisher();
    return null;
  }

  test('with no hand-over publisher mounted, a handed-over row is republished — even while Search observes the collection', async () => {
    const { libraryChanges, bundle, queryClient } = setup();

    await render(providerElement(
      createElement(SearchProbe),
      async () => bundle,
      undefined,
      queryClient,
    ));
    await waitFor(() => expect(bundle.libraryChanges).toBeDefined());
    await act(async () => undefined);
    expect(cachedState(queryClient)).toBe('ready');

    libraryChanges.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: D });

    await waitFor(() => expect(cachedState(queryClient)).toBe('mirrored'));
  });

  test('a change of another kind that carries an imageId is not republished', async () => {
    const { libraryChanges, getById, bundle, queryClient } = setup();
    await render(providerElement(
      createElement(View),
      async () => bundle,
      undefined,
      queryClient,
    ));
    await act(async () => undefined);

    libraryChanges.emit({ kind: 'ingested', imageId: 7, plaintextSha256: 'x' });
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(getById).not.toHaveBeenCalled();
    expect(cachedState(queryClient)).toBe('ready');
  });

  test('…and not while a publisher is mounted', async () => {
    const { libraryChanges, getById, bundle, queryClient } = setup();
    // One initializer, so the rerender below does not recompose the services.
    const initializer = async () => bundle;
    const view = await render(providerElement(
      createElement(PublisherProbe),
      initializer,
      undefined,
      queryClient,
    ));
    await act(async () => undefined);

    libraryChanges.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: D });
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(getById).not.toHaveBeenCalled();
    expect(cachedState(queryClient)).toBe('ready');

    await view.rerender(providerElement(
      createElement(View),
      initializer,
      undefined,
      queryClient,
    ));
    await act(async () => undefined);
    libraryChanges.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: D });

    await waitFor(() => expect(cachedState(queryClient)).toBe('mirrored'));
  });
});
