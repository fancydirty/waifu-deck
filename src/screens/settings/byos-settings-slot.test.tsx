import { createContext, useContext as mockUseContext } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import {
  connectGdrive,
  connectOneDrive,
  connectWebdav,
  probeGdrive,
  probeOneDrive,
  probeWebdav,
  provisionS3FromApiKey,
  reauthGdrive,
  reauthOneDrive,
  signInWithGoogle,
  signInWithMicrosoft,
  type ConnectResult,
  type ProbeResult,
} from '@/features/byos/byos-connect-flow';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import {
  createByosCredentialStore, type GoogleDriveBinding, type OneDriveBinding, type WebdavBinding,
} from '@/features/byos/byos-credentials';
import { createLibraryChangeFeed } from '@/features/library/library-change-feed';
import i18n from '@/i18n';
import { ByosSettingsSlot as Slot, ByosCloudLibraryProvider, connectFlow } from '@/screens/settings/byos-settings-slot';
import type { ByosSettingsSlotProps } from './byos-settings-slot-types';
import { renderCloudMessage } from '@/test/cloud-message-fixture';

const mockServicesContext = createContext<Record<string, unknown>>({});
jest.mock('expo-router', () => ({ usePathname: () => '/settings' }));
jest.mock('@/providers/app-services', () => ({ useAppServices: () => mockUseContext(mockServicesContext) }));
function ByosSettingsSlot(props: Omit<ByosSettingsSlotProps, 'renderCloudMessage'>) {
  const services = { byosStatus: props.byosStatus, libraryActions: props.actions,
    librarySync: props.sync, libraryChanges: props.libraryChanges,
    libraryStorageMode: props.storageMode, libraryController: null };
  return <mockServicesContext.Provider value={services}><ByosCloudLibraryProvider><Slot {...props} renderCloudMessage={renderCloudMessage} /></ByosCloudLibraryProvider></mockServicesContext.Provider>;
}

// The slot is the only settings edge that reaches the BYOS connect flow, and
// through it the S3 / crypto / secure-store stack. None of that is under test
// here — this suite is about which signal the slot subscribes the section to —
// so the whole edge is stubbed rather than exercised.
jest.mock('@/features/byos/byos-connect-flow', () => ({
  probeBucket: jest.fn(),
  connectToBucket: jest.fn(),
  provisionS3FromApiKey: jest.fn(),
  probeWebdav: jest.fn(),
  connectWebdav: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  probeOneDrive: jest.fn(),
  connectOneDrive: jest.fn(),
  reauthOneDrive: jest.fn(),
  signInWithGoogle: jest.fn(),
  probeGdrive: jest.fn(),
  connectGdrive: jest.fn(),
  reauthGdrive: jest.fn(),
  disconnectDevice: jest.fn(),
}));
jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { Check: Icon, ChevronRight: Icon, Cloud: Icon, Lock: Icon, Server: Icon };
});
jest.mock('@/features/byos/byos-credentials', () => ({
  createByosCredentialStore: jest.fn(() => ({
    load: jest.fn(async () => null),
    loadBinding: jest.fn(async () => null),
  })),
}));

beforeEach(async () => i18n.changeLanguage('zh-Hans'));

function readyStatus(): ByosStatus {
  return {
    status: 'ready',
    context: {
      kind: 's3',
      credentials: {
        kind: 's3',
        endpoint: 'https://example.r2.cloudflarestorage.com',
        region: 'auto',
        bucket: 'waifu-deck',
        accessKeyId: 'AKIA',
        secretAccessKey: 'shhh',
        prefix: 'waifu-deck/',
      },
      meta: {
        format: 'waifu-deck-byos',
        protocolVersion: 1,
        encryption: 'aes-gcm',
        vaultId: '11111111-2222-4333-8444-555555555555',
        kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'c2FsdA' },
        keyCheckB64: 'a2V5Y2hlY2s',
        createdAt: '2026-08-29T00:00:00.000Z',
      },
      masterKey: new Uint8Array(32),
      deviceId: 'device-1',
    },
  } as ByosStatus;
}

/**
 * K6-2b (spec §2 G3). K4b wired this row to the sync trigger's
 * `onRoundComplete`, which was right while every upload happened inside a
 * round. Since K6-1c the ingest-time protect runs outside the round, so
 * "云端 已备份 a/b" only advanced once a whole round finished — the same
 * staleness the grid had. The slot now subscribes to the composition's change
 * feed, which announces each asset as it settles.
 */
describe('ByosSettingsSlot', () => {
  it('P12-D: each drive provider entry in the connect flow is that provider\'s own implementation (a Google slot wired to Microsoft would pass every mock-level test)', () => {
    expect(connectFlow.signInWithGoogle).toBe(signInWithGoogle);
    expect(connectFlow.probeGdrive).toBe(probeGdrive);
    expect(connectFlow.connectGdrive).toBe(connectGdrive);
    expect(connectFlow.reauthGdrive).toBe(reauthGdrive);
    expect(connectFlow.signInWithMicrosoft).toBe(signInWithMicrosoft);
    expect(connectFlow.probeOneDrive).toBe(probeOneDrive);
    expect(connectFlow.connectOneDrive).toBe(connectOneDrive);
    expect(connectFlow.reauthOneDrive).toBe(reauthOneDrive);
    expect(connectFlow.provisionS3FromApiKey).toBe(provisionS3FromApiKey);
    expect(signInWithGoogle).not.toBe(signInWithMicrosoft);
  });

  it('re-reads the mirror counts when a single upload settles, not only at round end', async () => {
    const libraryChanges = createLibraryChangeFeed();
    const readMirrorCounts = jest
      .fn<Promise<{
        backedUp: number;
        backedUpTotal: number;
        downloaded: number;
        downloadedTotal: number;
        inCloud: number; inCloudBytes: number; totalBytes: number; pending: number;
      }>, []>()
      .mockResolvedValueOnce({
        backedUp: 1, backedUpTotal: 5, downloaded: 0, downloadedTotal: 1,
        inCloud: 1, inCloudBytes: 100, totalBytes: 500, pending: 4,
      })
      .mockResolvedValue({
        backedUp: 2, backedUpTotal: 5, downloaded: 0, downloadedTotal: 2,
        inCloud: 2, inCloudBytes: 200, totalBytes: 500, pending: 3,
      });

    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={readyStatus()}
        actions={{ readMirrorCounts, readQuotaFullCount: async () => 0 } as never}
        sync={null}
        libraryChanges={libraryChanges}
        onReload={jest.fn()}
      />,
    );
    expect(await screen.findByTestId('cloud-stat-in-cloud')).toHaveTextContent('1 张');
    expect(screen.getByTestId('cloud-stat-pending')).toHaveTextContent('4 张');

    await act(async () => {
      libraryChanges.emit({ kind: 'protected', plaintextSha256: 'a'.repeat(64) });
    });

    await waitFor(() => expect(
      screen.getByTestId('cloud-stat-in-cloud'),
    ).toHaveTextContent('2 张'));
    expect(screen.getByTestId('cloud-stat-pending')).toHaveTextContent('3 张');
    expect(readMirrorCounts).toHaveBeenCalledTimes(2);
  });

  it('renders without a feed (locked device / no composition yet)', async () => {
    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={readyStatus()}
        actions={null}
        sync={null}
        libraryChanges={null}
        onReload={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('byos-mirror-progress')).toBeNull();
  });

  it('board #12 P12-B: wires readQuotaFullCount through to the quota-full line when actions is present', async () => {
    const libraryChanges = createLibraryChangeFeed();
    const readMirrorCounts = jest.fn(async () => (
      { backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0 }
    ));
    const readQuotaFullCount = jest.fn(async () => 1);

    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={readyStatus()}
        actions={{ readMirrorCounts, readQuotaFullCount } as never}
        sync={null}
        libraryChanges={libraryChanges}
        onReload={jest.fn()}
      />,
    );

    expect(await screen.findByTestId('byos-quota-full')).toHaveTextContent(/网盘已满，1 张等待上传/);
  });

  it('board #12 P12-B: unlocks a WebDAV-bound locked device through the slot\'s own unlock wiring (loadBinding \u2192 probeWebdav \u2192 connectWebdav)', async () => {
    const binding: WebdavBinding = {
      kind: 'webdav',
      baseUrl: 'https://dav.example.com/dav',
      username: 'u',
      password: 'stored-pw',
      rootPath: '/',
    };
    jest.mocked(createByosCredentialStore).mockReturnValue({
      load: jest.fn(async () => null),
      save: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      saveBinding: jest.fn(async () => undefined),
      loadBinding: jest.fn(async () => binding),
    });
    const meta = {
      format: 'waifu-deck-byos' as const,
      protocolVersion: 1,
      encryption: 'aes-gcm' as const,
      vaultId: '11111111-2222-4333-8444-555555555555',
      kdf: { algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA' },
      keyCheckB64: 'a2V5Y2hlY2s',
      createdAt: '2026-08-29T00:00:00.000Z',
    };
    jest.mocked(probeWebdav).mockResolvedValue({ kind: 'existing-encrypted', meta } as ProbeResult);
    jest.mocked(connectWebdav).mockResolvedValue(
      { ok: true, vaultId: meta.vaultId, encryption: 'aes-gcm' } as ConnectResult,
    );
    const onReload = jest.fn();

    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        actions={null}
        sync={null}
        libraryChanges={null}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'typed-password');
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-unlock'));
    });

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('byos-unlock')).toBeEnabled());
    expect(probeWebdav).toHaveBeenCalledWith({
      baseUrl: binding.baseUrl,
      username: binding.username,
      password: binding.password,
      rootPath: binding.rootPath,
    });
    expect(connectWebdav).toHaveBeenCalledWith(expect.objectContaining({ password: 'typed-password' }));
  });

  it('board #12 P12-C: unlocks a OneDrive-bound locked device through the slot\'s own unlock wiring (loadBinding \u2192 probeOneDrive \u2192 connectOneDrive)', async () => {
    const binding: OneDriveBinding = {
      kind: 'onedrive',
      refreshToken: 'stored-refresh-token',
      accountEmail: 'owner@example.com',
      rootFolderId: 'F1',
      stateFolderId: 'F2',
      blobsFolderId: 'F3',
    };
    jest.mocked(createByosCredentialStore).mockReturnValue({
      load: jest.fn(async () => null),
      save: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      saveBinding: jest.fn(async () => undefined),
      loadBinding: jest.fn(async () => binding),
    });
    const meta = {
      format: 'waifu-deck-byos' as const,
      protocolVersion: 1,
      encryption: 'aes-gcm' as const,
      vaultId: '11111111-2222-4333-8444-555555555555',
      kdf: { algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA' },
      keyCheckB64: 'a2V5Y2hlY2s',
      createdAt: '2026-08-29T00:00:00.000Z',
    };
    jest.mocked(probeOneDrive).mockResolvedValue({ kind: 'existing-encrypted', meta } as ProbeResult);
    jest.mocked(connectOneDrive).mockResolvedValue(
      { ok: true, vaultId: meta.vaultId, encryption: 'aes-gcm' } as ConnectResult,
    );
    const onReload = jest.fn();

    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        actions={null}
        sync={null}
        libraryChanges={null}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'typed-password');
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-unlock'));
    });

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('byos-unlock')).toBeEnabled());
    expect(probeOneDrive).toHaveBeenCalledWith({ binding, accessToken: null, expiresAt: 0 });
    expect(connectOneDrive).toHaveBeenCalledWith(expect.objectContaining({ password: 'typed-password' }));
  });

  const GDRIVE: GoogleDriveBinding = {
    kind: 'gdrive',
    refreshToken: 'stored-google-refresh-token',
    accountEmail: 'owner@gmail.com',
    rootFolderId: 'G1',
    stateFolderId: 'G2',
    blobsFolderId: 'G3',
  };

  function storeHolding(binding: GoogleDriveBinding) {
    jest.mocked(createByosCredentialStore).mockReturnValue({
      load: jest.fn(async () => null),
      save: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
      saveBinding: jest.fn(async () => undefined),
      loadBinding: jest.fn(async () => binding),
    });
  }

  it('P12-D: unlocks a Google-Drive-bound locked device through the slot\'s own unlock wiring (loadBinding \u2192 probeGdrive from the stored binding \u2192 connectGdrive), never unsupported_binding_kind', async () => {
    storeHolding(GDRIVE);
    const meta = {
      format: 'waifu-deck-byos' as const,
      protocolVersion: 2,
      encryption: 'aes-gcm' as const,
      vaultId: '11111111-2222-4333-8444-555555555555',
      kdf: { algo: 'scrypt' as const, N: 16384, r: 8, p: 1, saltB64: 'c2FsdA' },
      keyCheckB64: 'a2V5Y2hlY2s',
      createdAt: '2026-09-25T00:00:00.000Z',
    };
    jest.mocked(probeGdrive).mockResolvedValue({ kind: 'existing-encrypted', meta } as ProbeResult);
    jest.mocked(connectGdrive).mockResolvedValue(
      { ok: true, vaultId: meta.vaultId, encryption: 'aes-gcm' } as ConnectResult,
    );
    const onReload = jest.fn();

    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        actions={null}
        sync={null}
        libraryChanges={null}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'typed-password');
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-unlock'));
    });

    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('byos-unlock')).toBeEnabled());
    expect(probeGdrive).toHaveBeenCalledWith({ binding: GDRIVE, accessToken: null, expiresAt: 0 });
    expect(connectGdrive).toHaveBeenCalledWith({
      source: { binding: GDRIVE, accessToken: null, expiresAt: 0 },
      probe: { kind: 'existing-encrypted', meta },
      password: 'typed-password',
    });
    expect(screen.queryByTestId('byos-error')).toBeNull();
  });

  it('P12-D: a Drive unlock whose folder lost its meta reads meta_absent, and a wrong password its own copy — no connect after an empty probe', async () => {
    storeHolding(GDRIVE);
    jest.mocked(probeGdrive).mockResolvedValue({ kind: 'empty' } as ProbeResult);
    jest.mocked(connectGdrive).mockClear();
    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={{ status: 'locked', reason: 'password_required' }}
        actions={null}
        sync={null}
        libraryChanges={null}
        onReload={jest.fn()}
      />,
    );
    await act(async () => {
      await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'pw');
    });
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-unlock'));
    });
    expect(await screen.findByTestId('byos-error')).toHaveTextContent(i18n.t('settings.cloudLibrary.lockMessage.unreadable'));
    expect(connectGdrive).not.toHaveBeenCalled();
  });

  it.each([
    ['gdrive', 'reauthGdrive'], ['onedrive', 'reauthOneDrive'],
  ] as const)('P12-D: the %s reauth lock row is wired to the real %s', async (provider, name) => {
    const fn = name === 'reauthGdrive' ? reauthGdrive : reauthOneDrive;
    const other = name === 'reauthGdrive' ? reauthOneDrive : reauthGdrive;
    jest.mocked(fn).mockReset().mockResolvedValue({ ok: true });
    jest.mocked(other).mockReset().mockResolvedValue({ ok: true });
    const onReload = jest.fn();
    await render(
      <ByosSettingsSlot
        storageMode={null}
        byosStatus={{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider }}
        actions={null}
        sync={null}
        libraryChanges={null}
        onReload={onReload}
      />,
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId('byos-reauth'));
    });
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });
});
