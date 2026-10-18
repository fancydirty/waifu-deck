import Constants from 'expo-constants';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { Linking } from 'react-native';

import {
  createNativeDownloadFile,
  type S3DownloadFilePort,
} from '@/features/byos/s3-file-download';
import { WaifuSyncService } from '../../../modules/waifu-sync-service';
import type { ApkVerificationResponse } from '../../../modules/waifu-sync-service';
import { versionCodeOf } from './product-version';
import {
  computeUpdateOffer,
  DEFAULT_LATEST_RELEASE_URL,
  MAX_APK_DOWNLOAD_BYTES,
  parseAppRelease,
  shouldAutoCheck,
  type AppRelease,
  type UpdateOffer,
} from './update-model';
import {
  createUpdateStateStore,
  type UpdateStateStore,
} from './update-state-store';

export type AppUpdateModalPhase =
  | { kind: 'ready'; alreadyDownloaded: boolean }
  | { kind: 'downloading'; bytesReceived: number; totalBytes: number }
  | { kind: 'verifying' }
  | { kind: 'permission-required'; apkUri: string }
  | { kind: 'error'; reason: 'download_failed' | 'verification_failed'; message?: string };

export type AppUpdateSnapshot = Readonly<{
  installedVersionCode: number;
  installedVersionName: string;
  offer: UpdateOffer | null;
  modalVisible: boolean;
  modalPhase: AppUpdateModalPhase;
  checking: boolean;
}>;

export type ManualUpdateCheckResult =
  | { status: 'update_available'; release: AppRelease }
  | { status: 'up_to_date'; versionName: string }
  | { status: 'failed' };

export interface AppUpdateService {
  getSnapshot(): AppUpdateSnapshot;
  subscribe(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
  initialize(autoCheckEnabled: boolean): Promise<void>;
  onForegroundResume(autoCheckEnabled: boolean): Promise<void>;
  checkForUpdatesManual(): Promise<ManualUpdateCheckResult>;
  openModal(): Promise<void>;
  dismissModal(): Promise<void>;
  startDownloadAndInstall(): Promise<void>;
  cancelDownload(): void;
  openUnknownSourcesSettings(): Promise<void>;
  openInBrowser(): Promise<void>;
}

export type AppUpdateNativePort = {
  getInstalledAppVersion(): {
    versionCode: number;
    versionName: string;
    isDebuggable: boolean;
  };
  canRequestPackageInstalls(): boolean;
  openUnknownAppSourcesSettings(): Promise<void>;
  installUpdateApk(apkPath: string): Promise<void>;
  sweepUpdateApks(installedVersionCode: number): Promise<number>;
  verifyDownloadedApk(
    apkPath: string,
    expectedVersionCode: number,
    expectedSizeBytes: number,
    expectedSha256: string,
  ): Promise<ApkVerificationResponse>;
};

export type AppUpdateFilePort = {
  getUpdateDirUri(): string;
  ensureDirExists(dirUri: string): Promise<void>;
  fileExists(fileUri: string): Promise<boolean>;
  deleteFileIfExists(fileUri: string): Promise<void>;
  moveFile(fromUri: string, toUri: string): Promise<void>;
};

export type CreateAppUpdateServiceOptions = {
  stateStore?: UpdateStateStore;
  fetchImpl?: typeof fetch;
  endpointUrl?: string;
  now?: () => number;
  nativePort?: AppUpdateNativePort | null;
  downloadFile?: S3DownloadFilePort | null;
  filePort?: AppUpdateFilePort;
  openUrl?: (url: string) => Promise<unknown>;
  allowDebugUpdateChecks?: boolean;
};

function createDefaultFilePort(): AppUpdateFilePort {
  return {
    getUpdateDirUri() {
      const base =
        FileSystemLegacy.cacheDirectory ??
        'file:///data/user/0/app.waifudeck.mobile/cache/';
      const normalized = base.endsWith('/') ? base : `${base}/`;
      return `${normalized}app-updates`;
    },
    async ensureDirExists(dirUri: string) {
      await FileSystemLegacy.makeDirectoryAsync(dirUri, {
        intermediates: true,
      }).catch(() => undefined);
    },
    async fileExists(fileUri: string) {
      try {
        const info = await FileSystemLegacy.getInfoAsync(fileUri);
        return Boolean(info.exists);
      } catch {
        return false;
      }
    },
    async deleteFileIfExists(fileUri: string) {
      await FileSystemLegacy.deleteAsync(fileUri, { idempotent: true }).catch(
        () => undefined,
      );
    },
    async moveFile(fromUri: string, toUri: string) {
      await FileSystemLegacy.deleteAsync(toUri, { idempotent: true }).catch(
        () => undefined,
      );
      await FileSystemLegacy.moveAsync({ from: fromUri, to: toUri });
    },
  };
}

function defaultInstalledVersion(nativePort: AppUpdateNativePort | null): {
  versionCode: number;
  versionName: string;
  isDebuggable: boolean;
} {
  if (nativePort !== null) {
    try {
      return nativePort.getInstalledAppVersion();
    } catch {
      // Fall back to Constants below
    }
  }
  const versionName = Constants.expoConfig?.version ?? '1.2.0';
  let versionCode = 1_002_000;
  try {
    versionCode = versionCodeOf(versionName);
  } catch {
    versionCode = Constants.expoConfig?.android?.versionCode ?? 1_002_000;
  }
  return {
    versionCode,
    versionName,
    isDebuggable: typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : false,
  };
}

function resolveDownloadPort(
  options: CreateAppUpdateServiceOptions,
  nativePort: AppUpdateNativePort | null,
): S3DownloadFilePort | null {
  if (options.downloadFile !== undefined) {
    return options.downloadFile;
  }
  if (nativePort !== null && WaifuSyncService !== null) {
    return createNativeDownloadFile(WaifuSyncService);
  }
  return null;
}

export function createAppUpdateService(
  options: CreateAppUpdateServiceOptions = {},
): AppUpdateService {
  const stateStore = options.stateStore ?? createUpdateStateStore();
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpointUrl = options.endpointUrl ?? DEFAULT_LATEST_RELEASE_URL;
  const now = options.now ?? (() => Date.now());
  const nativePort =
    options.nativePort !== undefined ? options.nativePort : WaifuSyncService;
  const downloadFile = resolveDownloadPort(options, nativePort);
  const filePort = options.filePort ?? createDefaultFilePort();
  const openUrl = options.openUrl ?? ((url: string) => Linking.openURL(url));
  const installed = defaultInstalledVersion(nativePort);
  const allowChecks =
    options.allowDebugUpdateChecks === true || !installed.isDebuggable;

  let persisted = {
    lastCheckAtMs: 0,
    dismissedVersionCode: 0,
    cachedRelease: null as AppRelease | null,
  };
  let loadPromise: Promise<void> | null = null;
  let sweptStartup = false;
  let inFlightCheck: Promise<AppRelease | null> | null = null;
  let inFlightInstall: Promise<void> | null = null;
  let activeDownloadAbort: AbortController | null = null;
  let installGeneration = 0;
  let waitingPermissionApkUri: string | null = null;
  let verifiedApkCache: {
    versionCode: number;
    sha256: string;
    uri: string;
  } | null = null;

  let snapshot: AppUpdateSnapshot = {
    installedVersionCode: installed.versionCode,
    installedVersionName: installed.versionName,
    offer: null,
    modalVisible: false,
    modalPhase: { kind: 'ready', alreadyDownloaded: false },
    checking: false,
  };

  const listeners = new Set<(next: AppUpdateSnapshot) => void>();

  function publish(patch: Partial<AppUpdateSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loadPromise !== null) {
      return loadPromise;
    }
    loadPromise = (async () => {
      persisted = await stateStore.load();
    })();
    return loadPromise;
  }

  function currentRelease(): AppRelease | null {
    return snapshot.offer?.release ?? persisted.cachedRelease;
  }

  function currentOffer(): UpdateOffer | null {
    return computeUpdateOffer(
      installed.versionCode,
      persisted.cachedRelease,
      persisted.dismissedVersionCode,
    );
  }

  function apkFilePaths(versionCode: number) {
    const dirUri = filePort.getUpdateDirUri();
    return {
      dirUri,
      partUri: `${dirUri}/waifudeck-${versionCode}.apk.part`,
      finalUri: `${dirUri}/waifudeck-${versionCode}.apk`,
    };
  }

  async function hasVerifiedCachedApk(
    release: AppRelease,
  ): Promise<string | null> {
    if (nativePort === null) return null;
    const { finalUri } = apkFilePaths(release.versionCode);
    const exists = await filePort.fileExists(finalUri);
    if (!exists) {
      if (verifiedApkCache?.versionCode === release.versionCode) {
        verifiedApkCache = null;
      }
      return null;
    }
    if (
      verifiedApkCache !== null &&
      verifiedApkCache.versionCode === release.versionCode &&
      verifiedApkCache.sha256 === release.sha256 &&
      verifiedApkCache.uri === finalUri
    ) {
      return finalUri;
    }
    try {
      const res = await nativePort.verifyDownloadedApk(
        finalUri,
        release.versionCode,
        release.sizeBytes,
        release.sha256,
      );
      if (res.valid) {
        verifiedApkCache = {
          versionCode: release.versionCode,
          sha256: release.sha256,
          uri: finalUri,
        };
        return finalUri;
      }
      verifiedApkCache = null;
      return null;
    } catch {
      return null;
    }
  }

  async function refreshModalReadyPhase(release: AppRelease | null) {
    if (release === null) {
      publish({ modalPhase: { kind: 'ready', alreadyDownloaded: false } });
      return;
    }
    const cachedUri = await hasVerifiedCachedApk(release);
    if (
      snapshot.modalPhase.kind === 'ready' ||
      snapshot.modalPhase.kind === 'error'
    ) {
      publish({
        modalPhase: { kind: 'ready', alreadyDownloaded: cachedUri !== null },
      });
    }
  }

  async function fetchLatestReleaseFromNetwork(): Promise<AppRelease | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchImpl(endpointUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      return parseAppRelease(json);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runSerializedNetworkCheck(): Promise<AppRelease | null> {
    if (inFlightCheck !== null) {
      return inFlightCheck;
    }
    publish({ checking: true });
    inFlightCheck = (async () => {
      try {
        const checkTime = now();
        const remote = await fetchLatestReleaseFromNetwork();
        if (remote === null) {
          return null;
        }
        persisted = await stateStore.save({
          lastCheckAtMs: checkTime,
          dismissedVersionCode: persisted.dismissedVersionCode,
          cachedRelease: remote,
        });
        return remote;
      } finally {
        inFlightCheck = null;
        publish({ checking: false });
      }
    })();
    return inFlightCheck;
  }

  async function evaluateAndPublishAutoOffer(autoCheckEnabled: boolean) {
    if (!allowChecks) return;
    await ensureLoaded();
    if (!sweptStartup && nativePort !== null) {
      sweptStartup = true;
      void nativePort
        .sweepUpdateApks(installed.versionCode)
        .catch(() => undefined);
    }
    if (shouldAutoCheck(autoCheckEnabled, persisted.lastCheckAtMs, now())) {
      await runSerializedNetworkCheck();
    }
    const offer = currentOffer();
    const isPipelineIdle =
      !snapshot.modalVisible ||
      snapshot.modalPhase.kind === 'ready' ||
      snapshot.modalPhase.kind === 'error';
    const shouldOpenModal = Boolean(offer?.shouldAutoPopup) && isPipelineIdle;
    const cachedUri =
      shouldOpenModal && offer !== null
        ? await hasVerifiedCachedApk(offer.release)
        : null;
    publish({
      offer,
      ...(shouldOpenModal
        ? {
            modalVisible: true,
            modalPhase: {
              kind: 'ready',
              alreadyDownloaded: cachedUri !== null,
            },
          }
        : {}),
    });
  }

  return {
    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async initialize(autoCheckEnabled: boolean) {
      await evaluateAndPublishAutoOffer(autoCheckEnabled);
    },

    async onForegroundResume(autoCheckEnabled: boolean) {
      if (waitingPermissionApkUri !== null && nativePort !== null) {
        const targetUri = waitingPermissionApkUri;
        if (!nativePort.canRequestPackageInstalls()) {
          return;
        }
        waitingPermissionApkUri = null;
        publish({
          modalPhase: { kind: 'ready', alreadyDownloaded: true },
        });
        try {
          await nativePort.installUpdateApk(targetUri);
          return;
        } catch {
          publish({
            modalPhase: { kind: 'error', reason: 'download_failed' },
          });
          return;
        }
      }
      await evaluateAndPublishAutoOffer(autoCheckEnabled);
    },

    async checkForUpdatesManual(): Promise<ManualUpdateCheckResult> {
      try {
        await ensureLoaded();
        const remote = await runSerializedNetworkCheck();
        if (remote === null) {
          return { status: 'failed' };
        }
        const offer = currentOffer();
        if (offer !== null) {
          const cachedUri = await hasVerifiedCachedApk(offer.release);
          publish({
            offer,
            modalVisible: true,
            modalPhase: {
              kind: 'ready',
              alreadyDownloaded: cachedUri !== null,
            },
          });
          return { status: 'update_available', release: offer.release };
        }
        publish({ offer: null, modalVisible: false });
        return { status: 'up_to_date', versionName: installed.versionName };
      } catch {
        return { status: 'failed' };
      }
    },

    async openModal() {
      const release = currentRelease();
      if (!release || release.versionCode <= installed.versionCode) return;
      await refreshModalReadyPhase(release);
      publish({ modalVisible: true });
    },

    async dismissModal() {
      installGeneration += 1;
      if (activeDownloadAbort !== null) {
        activeDownloadAbort.abort();
        activeDownloadAbort = null;
      }
      waitingPermissionApkUri = null;
      await ensureLoaded();
      const release = currentRelease();
      if (release !== null) {
        const nextDismissed = Math.max(
          persisted.dismissedVersionCode,
          release.versionCode,
        );
        persisted = await stateStore.save({
          ...persisted,
          dismissedVersionCode: nextDismissed,
        });
      }
      const offer = currentOffer();
      publish({
        offer,
        modalVisible: false,
        modalPhase: { kind: 'ready', alreadyDownloaded: false },
      });
    },

    cancelDownload() {
      installGeneration += 1;
      if (activeDownloadAbort !== null) {
        activeDownloadAbort.abort();
        activeDownloadAbort = null;
      }
      publish({
        modalPhase: { kind: 'ready', alreadyDownloaded: false },
      });
    },

    async startDownloadAndInstall() {
      if (inFlightInstall !== null) {
        return inFlightInstall;
      }
      const release = currentRelease();
      if (!release) return;

      if (nativePort === null || downloadFile === null) {
        await openUrl(release.downloadUrl);
        return;
      }

      const myGeneration = ++installGeneration;
      const runPipeline = async () => {
        // Step 1: Reuse already-downloaded & verified APK in 0s if present
        const existingVerifiedUri = await hasVerifiedCachedApk(release);
        if (myGeneration !== installGeneration) return;
        let verifiedApkUri = existingVerifiedUri;

        if (verifiedApkUri === null) {
          const { dirUri, partUri, finalUri } = apkFilePaths(
            release.versionCode,
          );
          const abortController = new AbortController();
          activeDownloadAbort = abortController;
          publish({
            modalPhase: {
              kind: 'downloading',
              bytesReceived: 0,
              totalBytes: release.sizeBytes,
            },
          });

          await filePort.ensureDirExists(dirUri);
          await filePort.deleteFileIfExists(partUri);
          if (
            myGeneration !== installGeneration ||
            abortController.signal.aborted
          ) {
            return;
          }

          try {
            const response = await downloadFile({
              url: release.downloadUrl,
              fileUri: partUri,
              headers: { Accept: 'application/vnd.android.package-archive' },
              maxBytes: Math.min(release.sizeBytes, MAX_APK_DOWNLOAD_BYTES),
              signal: abortController.signal,
              onProgress: ({ bytesReceived, total }) => {
                if (myGeneration !== installGeneration) return;
                publish({
                  modalPhase: {
                    kind: 'downloading',
                    bytesReceived,
                    totalBytes: total && total > 0 ? total : release.sizeBytes,
                  },
                });
              },
            });
            if (response.status < 200 || response.status >= 300) {
              await filePort.deleteFileIfExists(partUri);
              if (myGeneration === installGeneration) {
                publish({
                  modalPhase: { kind: 'error', reason: 'download_failed' },
                });
              }
              return;
            }
          } catch {
            await filePort.deleteFileIfExists(partUri);
            if (
              myGeneration !== installGeneration ||
              abortController.signal.aborted
            ) {
              if (myGeneration === installGeneration) {
                publish({
                  modalPhase: { kind: 'ready', alreadyDownloaded: false },
                });
              }
              return;
            }
            publish({
              modalPhase: { kind: 'error', reason: 'download_failed' },
            });
            return;
          } finally {
            if (activeDownloadAbort === abortController) {
              activeDownloadAbort = null;
            }
          }

          if (myGeneration !== installGeneration) return;
          publish({ modalPhase: { kind: 'verifying' } });
          try {
            await filePort.moveFile(partUri, finalUri);
            const check = await nativePort.verifyDownloadedApk(
              finalUri,
              release.versionCode,
              release.sizeBytes,
              release.sha256,
            );
            if (!check.valid) {
              verifiedApkCache = null;
              await filePort.deleteFileIfExists(finalUri);
              if (myGeneration === installGeneration) {
                publish({
                  modalPhase: {
                    kind: 'error',
                    reason: 'verification_failed',
                    message: check.reason ?? undefined,
                  },
                });
              }
              return;
            }
            verifiedApkCache = {
              versionCode: release.versionCode,
              sha256: release.sha256,
              uri: finalUri,
            };
            verifiedApkUri = finalUri;
          } catch {
            verifiedApkCache = null;
            await filePort.deleteFileIfExists(partUri);
            await filePort.deleteFileIfExists(finalUri);
            if (myGeneration === installGeneration) {
              publish({
                modalPhase: { kind: 'error', reason: 'verification_failed' },
              });
            }
            return;
          }
        }

        if (myGeneration !== installGeneration) return;

        // Step 2: Check unknown-sources install permission
        if (!nativePort.canRequestPackageInstalls()) {
          waitingPermissionApkUri = verifiedApkUri;
          publish({
            modalPhase: { kind: 'permission-required', apkUri: verifiedApkUri },
          });
          return;
        }

        // Step 3: Hand off content:// URI to Android PackageInstaller
        publish({
          modalPhase: { kind: 'ready', alreadyDownloaded: true },
        });
        try {
          await nativePort.installUpdateApk(verifiedApkUri);
        } catch {
          if (myGeneration === installGeneration) {
            publish({
              modalPhase: { kind: 'error', reason: 'download_failed' },
            });
          }
        }
      };

      inFlightInstall = runPipeline().finally(() => {
        inFlightInstall = null;
      });
      return inFlightInstall;
    },

    async openUnknownSourcesSettings() {
      if (nativePort === null) return;
      await nativePort.openUnknownAppSourcesSettings();
    },

    async openInBrowser() {
      const release = currentRelease();
      if (!release) return;
      await openUrl(release.downloadUrl);
    },
  };
}
