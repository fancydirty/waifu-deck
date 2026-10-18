import { useCallback, useMemo, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { useAppServices } from '@/providers/app-services';
import { deriveCloudIdentity } from './cloud-library-model';
import { CloudLibraryContext, useCloudLibraryModel } from './cloud-library-context';
import { useCloudLibraryData } from './use-cloud-library-data';

import {
  connectGdrive,
  connectOneDrive,
  connectToBucket,
  connectWebdav,
  disconnectDevice,
  probeBucket,
  probeGdrive,
  probeOneDrive,
  probeWebdav,
  provisionS3FromApiKey,
  reauthGdrive,
  reauthOneDrive,
  signInWithGoogle,
  signInWithMicrosoft,
  type ByosConnectFields,
  type ConnectResult,
  type GdriveSource,
  type OneDriveSource,
  type WebdavConnectFields,
} from '@/features/byos/byos-connect-flow';
import { createByosCredentialStore } from '@/features/byos/byos-credentials';
import {
  ByosSettingsSection,
  type ByosConnectFlow,
} from '@/screens/settings/byos-settings-section';
import type {
  ByosSettingsSlotProps,
} from '@/screens/settings/byos-settings-slot-types';

import { WaifuSyncService } from '../../../modules/waifu-sync-service';

/**
 * Runtime edge for credential loading and connect actions. Passive readers
 * belong to the single provider below; the section receives its snapshot.
 */

/**
 * The locked/`password_required` "unlock" path: the device already holds
 * credentials (that is why it locked rather than reading as unconfigured), so
 * unlock re-opens the same bucket with a freshly typed password by loading the
 * stored credentials, re-probing, and opening. This is the connect flow's own
 * "open an existing vault" path (`connectToBucket` on a join probe), just
 * seeded from the keychain instead of a form. Credential loading lives here in
 * the Direct-only slot rather than in the section, keeping the section a thin
 * shell with no direct BYOS-stack import.
 */
async function unlock(password: string): Promise<ConnectResult> {
  const binding = await createByosCredentialStore().loadBinding();
  if (binding === null) {
    // No stored binding means the vault is not actually configured; treat as
    // a rejected open rather than pretending success.
    return { ok: false, category: 'credential_rejected', detail: 'no_stored_credentials' };
  }
  if (binding.kind === 'webdav') {
    const fields: WebdavConnectFields = {
      baseUrl: binding.baseUrl,
      username: binding.username,
      password: binding.password,
      rootPath: binding.rootPath,
    };
    const probe = await probeWebdav(fields);
    if (probe.kind === 'error') {
      return { ok: false, category: probe.category, detail: probe.detail };
    }
    if (probe.kind === 'empty') {
      // Same "the vault that locked this device is gone" case as the S3 path
      // below, on the WebDAV store instead of a bucket.
      return { ok: false, category: 'meta_corrupt', detail: 'meta_absent' };
    }
    return connectWebdav({ fields, probe, password });
  }
  if (binding.kind === 'onedrive') {
    // Same shape as the WebDAV branch: the stored binding is the source; a
    // cold token source refreshes on the probe and writes the rotated token
    // back, and `connectOneDrive` keeps that newer token (see its comment).
    const source: OneDriveSource = { binding, accessToken: null, expiresAt: 0 };
    const probe = await probeOneDrive(source);
    if (probe.kind === 'error') return { ok: false, category: probe.category, detail: probe.detail };
    if (probe.kind === 'empty') return { ok: false, category: 'meta_corrupt', detail: 'meta_absent' };
    return connectOneDrive({ source, probe, password });
  }
  if (binding.kind === 'gdrive') {
    // The OneDrive branch's twin (P12-D Task 11): the stored binding is the
    // source with no access token, so the probe's first request refreshes
    // one. Google does not rotate refresh tokens (spec 补裁 3), so nothing is
    // written back and `connectGdrive` saves the binding as it was stored.
    const source: GdriveSource = { binding, accessToken: null, expiresAt: 0 };
    const probe = await probeGdrive(source);
    if (probe.kind === 'error') return { ok: false, category: probe.category, detail: probe.detail };
    if (probe.kind === 'empty') return { ok: false, category: 'meta_corrupt', detail: 'meta_absent' };
    return connectGdrive({ source, probe, password });
  }
  const fields: ByosConnectFields = {
    endpoint: binding.endpoint,
    bucket: binding.bucket,
    accessKey: binding.accessKeyId,
    secret: binding.secretAccessKey,
    prefix: binding.prefix,
    region: binding.region,
  };
  const probe = await probeBucket(fields);
  if (probe.kind === 'error') {
    return { ok: false, category: probe.category, detail: probe.detail };
  }
  if (probe.kind === 'empty') {
    // The meta that made this device lock is gone — the bucket was emptied or
    // re-created. Surface as corruption, not as an unlock the user can retry.
    return { ok: false, category: 'meta_corrupt', detail: 'meta_absent' };
  }
  return connectToBucket({ fields, probe, password });
}

/** Exported for the wiring test only: each provider's entry must be its own implementation. */
export const connectFlow: ByosConnectFlow = {
  probeBucket,
  connectToBucket,
  provisionS3FromApiKey,
  probeWebdav,
  connectWebdav,
  signInWithMicrosoft,
  probeOneDrive,
  connectOneDrive,
  reauthOneDrive,
  signInWithGoogle,
  probeGdrive,
  connectGdrive,
  reauthGdrive,
  unlock,
  disconnectDevice,
};

/**
 * K6-3: only a Direct Android build has the foreground-service module linked
 * in. Bound once here (the module is a process-wide singleton) rather than per
 * render, so the section receives a stable object.
 */
const syncService = WaifuSyncService;
const backgroundSync = syncService === null ? undefined : {
  isBatteryOptimizationIgnored: () => syncService.isBatteryOptimizationIgnored(),
  requestIgnoreBatteryOptimizations: () => syncService.requestIgnoreBatteryOptimizations(),
};

export function ByosCloudLibraryProvider({ children }: { children: ReactNode }) {
  const { byosStatus, libraryActions: actions, librarySync: sync,
    libraryChanges, libraryStorageMode: storageMode, libraryController } = useAppServices();
  const pathname = usePathname();
  const enabled = pathname === '/settings' || pathname === '/settings/cloud';
  // A controller replacement invalidates even an unchanged locked status.
  const readStoredIdentity = useCallback(async () => {
    const binding = await createByosCredentialStore().loadBinding();
    // Retain only safe display fields; localization is applied by the hook.
    return binding === null ? null : deriveCloudIdentity(binding, (key) => key);
    // This dependency owns the local credential generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryController]);
  const store = byosStatus.status === 'ready' && byosStatus.context.kind === 'store'
    ? byosStatus.context.store : null;
  const readLastSyncedAt = useCallback(
    async () => (await sync!.readSyncState())?.lastSyncedAt ?? null,
    [sync],
  );
  const readMirrorCounts = useCallback(() => actions!.readMirrorCounts(), [actions]);
  const readQuotaFullCount = useCallback(() => actions!.readQuotaFullCount(), [actions]);
  const subscribeLibraryChanges = useCallback(
    (listener: () => void) => libraryChanges!.subscribe(() => listener()),
    [libraryChanges],
  );
  const readQuota = useCallback(() => store!.quota(), [store]);
  const readStorageMode = useCallback(() => storageMode!.read(), [storageMode]);
  const readers = useMemo(() => ({
    readStoredIdentity,
    readLastSyncedAt: sync == null ? undefined : readLastSyncedAt,
    readMirrorCounts: actions == null ? undefined : readMirrorCounts,
    readQuotaFullCount: actions == null ? undefined : readQuotaFullCount,
    subscribeLibraryChanges: libraryChanges == null ? undefined : subscribeLibraryChanges,
    readQuota: store === null ? undefined : readQuota,
    readStorageMode: storageMode == null ? undefined : readStorageMode,
  }), [readStoredIdentity, sync, readLastSyncedAt, actions, readMirrorCounts,
    readQuotaFullCount, libraryChanges, subscribeLibraryChanges, store, readQuota, storageMode, readStorageMode]);
  const data = useCloudLibraryData({ byosStatus, readers, enabled });
  return <CloudLibraryContext.Provider value={data}>{children}</CloudLibraryContext.Provider>;
}

export function ByosSettingsSlot({ byosStatus, storageMode, onReload, renderCloudMessage }: ByosSettingsSlotProps) {
  const data = useCloudLibraryModel();
  return (
    <ByosSettingsSection
      data={data}
      byosStatus={byosStatus}
      connectFlow={connectFlow}
      onReload={onReload}
      storageMode={storageMode ?? undefined}
      backgroundSync={backgroundSync}
      renderCloudMessage={renderCloudMessage}
    />
  );
}
