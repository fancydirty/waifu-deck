import type { KeyValueStorage } from '@/features/settings/settings-repository';
import {
  createAppUpdateService,
  type AppUpdateFilePort,
  type AppUpdateNativePort,
} from './app-update-service';
import {
  computeUpdateOffer,
  parseAppRelease,
  shouldAutoCheck,
  UPDATE_CHECK_INTERVAL_MS,
  type AppRelease,
} from './update-model';
import { createUpdateStateStore } from './update-state-store';

function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.get(key) ?? null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
}

const RELEASE_121: AppRelease = {
  versionCode: 1_002_001,
  versionName: '1.2.1',
  publishedAt: '2026-10-16T08:00:00.000Z',
  sizeBytes: 86_620_693,
  sha256: '3c3d38370211f11dc52fa489f7760560bf179342addcd7075f2a6d8e4697beeb',
  notes: '支持应用内自动检查更新与无损覆盖安装。',
  downloadUrl: 'https://waifudeck.app/api/app/download',
};

const RELEASE_122: AppRelease = {
  ...RELEASE_121,
  versionCode: 1_002_002,
  versionName: '1.2.2',
  notes: '第二版更新。',
};

describe('UpdateCheckPolicy & AppUpdateService (Ledger N11-C)', () => {
  it('validates AppRelease JSON and rejects non-https downloadUrl or malformed sha256', () => {
    expect(parseAppRelease(RELEASE_121)).toEqual(RELEASE_121);
    expect(parseAppRelease({ ...RELEASE_121, downloadUrl: 'http://waifudeck.app/api/app/download' })).toBeNull();
    expect(parseAppRelease({ ...RELEASE_121, sha256: 'short' })).toBeNull();
    expect(parseAppRelease({ ...RELEASE_121, versionCode: 0 })).toBeNull();
  });

  it(' enforces 24-hour throttle and handles backward clock jumps in shouldAutoCheck', () => {
    const base = 1_700_000_000_000;
    expect(shouldAutoCheck(false, 0, base)).toBe(false);
    expect(shouldAutoCheck(true, 0, base)).toBe(true);
    expect(shouldAutoCheck(true, base, base + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldAutoCheck(true, base, base + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    // Clock moved backwards -> due
    expect(shouldAutoCheck(true, base, base - 5_000)).toBe(true);
  });

  it('computes offer and suppresses auto-popup only for dismissedVersionCode, re-enabling on newer versionCode', () => {
    expect(computeUpdateOffer(1_002_000, null, 0)).toBeNull();
    expect(computeUpdateOffer(1_002_001, RELEASE_121, 0)).toBeNull();

    const firstOffer = computeUpdateOffer(1_002_000, RELEASE_121, 0);
    expect(firstOffer).toEqual({ release: RELEASE_121, shouldAutoPopup: true });

    const dismissedOffer = computeUpdateOffer(1_002_000, RELEASE_121, 1_002_001);
    expect(dismissedOffer).toEqual({ release: RELEASE_121, shouldAutoPopup: false });

    const newerOffer = computeUpdateOffer(1_002_000, RELEASE_122, 1_002_001);
    expect(newerOffer).toEqual({ release: RELEASE_122, shouldAutoPopup: true });
  });

  it('auto-checks on initialize, pops up modal once, suppresses popup after dismissModal, and re-pops when a newer release arrives', async () => {
    const storage = createMemoryStorage();
    const stateStore = createUpdateStateStore(storage);
    let currentTime = 1_700_000_000_000;
    let currentRemote: AppRelease = RELEASE_121;
    const sweptCodes: number[] = [];

    const nativePort: AppUpdateNativePort = {
      getInstalledAppVersion: () => ({
        versionCode: 1_002_000,
        versionName: '1.2.0',
        isDebuggable: false,
      }),
      canRequestPackageInstalls: () => true,
      openUnknownAppSourcesSettings: async () => undefined,
      installUpdateApk: async () => undefined,
      sweepUpdateApks: async (code) => {
        sweptCodes.push(code);
        return 1;
      },
      verifyDownloadedApk: async () => ({ valid: false, reason: 'missing_file' }),
    };

    const service = createAppUpdateService({
      stateStore,
      now: () => currentTime,
      nativePort,
      fetchImpl: (async () =>
        new Response(JSON.stringify(currentRemote), { status: 200 })) as typeof fetch,
    });

    await service.initialize(true);
    expect(sweptCodes).toEqual([1_002_000]);
    expect(service.getSnapshot().modalVisible).toBe(true);
    expect(service.getSnapshot().offer?.release.versionName).toBe('1.2.1');

    // User taps "Later" -> modal closes and dismissedVersionCode = 1_002_001
    await service.dismissModal();
    expect(service.getSnapshot().modalVisible).toBe(false);
    expect(service.getSnapshot().offer?.shouldAutoPopup).toBe(false);
    // Offer itself stays available so Settings footer still shows "Update available · v1.2.1"
    expect(service.getSnapshot().offer?.release.versionName).toBe('1.2.1');

    // 25 hours later, user resumes app while 1.2.1 is still current -> no auto-popup!
    currentTime += UPDATE_CHECK_INTERVAL_MS + 10_000;
    await service.onForegroundResume(true);
    expect(service.getSnapshot().modalVisible).toBe(false);

    // User manually taps the Settings footer -> modal opens even though 1.2.1 was dismissed
    await service.openModal();
    expect(service.getSnapshot().modalVisible).toBe(true);
    await service.dismissModal();
    expect(service.getSnapshot().modalVisible).toBe(false);

    // 25 hours later, 1.2.2 is published -> auto-popup appears again!
    currentRemote = RELEASE_122;
    currentTime += UPDATE_CHECK_INTERVAL_MS + 10_000;
    await service.onForegroundResume(true);
    expect(service.getSnapshot().modalVisible).toBe(true);
    expect(service.getSnapshot().offer?.release.versionName).toBe('1.2.2');
  });

  it('streams APK download with progress, verifies SHA-256, handles unknown-sources permission resume, and reuses cached verified APK in 0s', async () => {
    const storage = createMemoryStorage();
    const stateStore = createUpdateStateStore(storage);
    const files = new Set<string>();
    let permissionGranted = false;
    const installedUris: string[] = [];
    const openedSettings: number[] = [];
    let downloadCalls = 0;

    const filePort: AppUpdateFilePort = {
      getUpdateDirUri: () => 'file:///cache/app-updates',
      ensureDirExists: async () => undefined,
      fileExists: async (uri) => files.has(uri),
      deleteFileIfExists: async (uri) => {
        files.delete(uri);
      },
      moveFile: async (from, to) => {
        files.delete(from);
        files.add(to);
      },
    };

    const nativePort: AppUpdateNativePort = {
      getInstalledAppVersion: () => ({
        versionCode: 1_002_000,
        versionName: '1.2.0',
        isDebuggable: false,
      }),
      canRequestPackageInstalls: () => permissionGranted,
      openUnknownAppSourcesSettings: async () => {
        openedSettings.push(1);
      },
      installUpdateApk: async (uri) => {
        installedUris.push(uri);
      },
      sweepUpdateApks: async () => 0,
      verifyDownloadedApk: async (uri) =>
        files.has(uri)
          ? { valid: true, reason: null }
          : { valid: false, reason: 'missing_file' },
    };

    const service = createAppUpdateService({
      stateStore,
      nativePort,
      filePort,
      fetchImpl: (async () =>
        new Response(JSON.stringify(RELEASE_121), { status: 200 })) as typeof fetch,
      downloadFile: async (req) => {
        downloadCalls += 1;
        req.onProgress?.({ bytesReceived: 43_000_000, total: RELEASE_121.sizeBytes });
        files.add(req.fileUri);
        return {
          status: 200,
          headers: {},
          redirected: false,
          errorBody: '',
          bytesWritten: RELEASE_121.sizeBytes,
        };
      },
    });

    await service.initialize(true);
    await service.startDownloadAndInstall();

    // Downloaded once, verified, and stopped at permission-required because permissionGranted === false
    expect(downloadCalls).toBe(1);
    expect(service.getSnapshot().modalPhase).toEqual({
      kind: 'permission-required',
      apkUri: 'file:///cache/app-updates/waifudeck-1002001.apk',
    });
    expect(installedUris).toEqual([]);

    await service.openUnknownSourcesSettings();
    expect(openedSettings.length).toBe(1);

    // User grants permission in Android Settings and returns to the app
    permissionGranted = true;
    await service.onForegroundResume(true);
    expect(installedUris).toEqual(['file:///cache/app-updates/waifudeck-1002001.apk']);

    // Tapping startDownloadAndInstall again reuses the verified APK on disk without downloading again
    await service.startDownloadAndInstall();
    expect(downloadCalls).toBe(1);
    expect(installedUris).toEqual([
      'file:///cache/app-updates/waifudeck-1002001.apk',
      'file:///cache/app-updates/waifudeck-1002001.apk',
    ]);
  });

  it('does not advance lastCheckAtMs when the network check fails so the next foreground resume can retry', async () => {
    const storage = createMemoryStorage();
    const stateStore = createUpdateStateStore(storage);
    let shouldFail = true;
    let fetchCount = 0;

    const service = createAppUpdateService({
      stateStore,
      now: () => 1_700_000_000_000,
      nativePort: {
        getInstalledAppVersion: () => ({
          versionCode: 1_002_000,
          versionName: '1.2.0',
          isDebuggable: false,
        }),
        canRequestPackageInstalls: () => true,
        openUnknownAppSourcesSettings: async () => undefined,
        installUpdateApk: async () => undefined,
        sweepUpdateApks: async () => 0,
        verifyDownloadedApk: async () => ({ valid: false, reason: 'missing_file' }),
      },
      fetchImpl: (async () => {
        fetchCount += 1;
        if (shouldFail) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify(RELEASE_121), { status: 200 });
      }) as typeof fetch,
    });

    await service.initialize(true);
    expect(fetchCount).toBe(1);
    expect(service.getSnapshot().offer).toBeNull();

    shouldFail = false;
    await service.onForegroundResume(true);
    expect(fetchCount).toBe(2);
    expect(service.getSnapshot().offer?.release.versionName).toBe('1.2.1');
    expect(service.getSnapshot().modalVisible).toBe(true);
  });

  it('preserves permission-required modalPhase when returning from settings without granting permission', async () => {
    const storage = createMemoryStorage();
    const stateStore = createUpdateStateStore(storage);
    const files = new Set<string>();

    const service = createAppUpdateService({
      stateStore,
      nativePort: {
        getInstalledAppVersion: () => ({
          versionCode: 1_002_000,
          versionName: '1.2.0',
          isDebuggable: false,
        }),
        canRequestPackageInstalls: () => false,
        openUnknownAppSourcesSettings: async () => undefined,
        installUpdateApk: async () => undefined,
        sweepUpdateApks: async () => 0,
        verifyDownloadedApk: async (uri) =>
          files.has(uri)
            ? { valid: true, reason: null }
            : { valid: false, reason: 'missing_file' },
      },
      filePort: {
        getUpdateDirUri: () => 'file:///cache/app-updates',
        ensureDirExists: async () => undefined,
        fileExists: async (uri) => files.has(uri),
        deleteFileIfExists: async (uri) => {
          files.delete(uri);
        },
        moveFile: async (from, to) => {
          files.delete(from);
          files.add(to);
        },
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify(RELEASE_121), { status: 200 })) as typeof fetch,
      downloadFile: async (req) => {
        files.add(req.fileUri);
        return {
          status: 200,
          headers: {},
          redirected: false,
          errorBody: '',
          bytesWritten: RELEASE_121.sizeBytes,
        };
      },
    });

    await service.initialize(true);
    await service.startDownloadAndInstall();
    expect(service.getSnapshot().modalPhase).toEqual({
      kind: 'permission-required',
      apkUri: 'file:///cache/app-updates/waifudeck-1002001.apk',
    });

    await service.onForegroundResume(true);
    expect(service.getSnapshot().modalPhase).toEqual({
      kind: 'permission-required',
      apkUri: 'file:///cache/app-updates/waifudeck-1002001.apk',
    });
  });

  it('rejects oversized release payloads above 250 MiB', () => {
    expect(
      parseAppRelease({
        ...RELEASE_121,
        sizeBytes: 300 * 1024 * 1024,
      }),
    ).toBeNull();
  });
});
