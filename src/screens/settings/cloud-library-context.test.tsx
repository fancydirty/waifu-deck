import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { createLibraryChangeFeed } from '@/features/library/library-change-feed';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { createByosCredentialStore } from '@/features/byos/byos-credentials';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { ReactNode } from 'react';
import { ByosCloudLibraryProvider, ByosSettingsSlot } from './byos-settings-slot';
import { renderCloudMessage } from '@/test/cloud-message-fixture';
import { disconnectDevice } from '@/features/byos/byos-connect-flow';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import { useCloudLibraryModel } from './cloud-library-context';
import type { CloudLibraryData } from './use-cloud-library-data';
import i18n from '@/i18n';

let mockPath = '/settings';
let mockServices: Record<string, unknown>;
jest.mock('expo-router', () => ({ usePathname: () => mockPath }));
jest.mock('@/providers/app-services', () => ({ useAppServices: () => mockServices }));
jest.mock('@/features/byos/byos-connect-flow', () => ({ disconnectDevice: jest.fn() }));
jest.mock('@/features/byos/byos-credentials', () => ({ createByosCredentialStore: jest.fn() }));
jest.mock('lucide-react-native', () => ({ Check: () => null, ChevronRight: () => null, Cloud: () => null, Lock: () => null, Server: () => null }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function services() {
  const quota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
  const store = { ...createMemoryCloudObjectStore(), quota: jest.fn(() => quota.promise) };
  const status: ByosStatus = { status: 'ready', context: { kind: 'store', store,
    binding: { kind: 'gdrive', accountEmail: 'owner@example.com', refreshToken: 'SECRET', rootFolderId: 'r', stateFolderId: 's', blobsFolderId: 'b' },
    meta: { format: 'waifu-deck-byos', protocolVersion: 2, encryption: 'aes-gcm', vaultId: 'v',
      kdf: { algo: 'scrypt', N: 1, r: 1, p: 1, saltB64: '' }, keyCheckB64: '', createdAt: '' },
    masterKey: new Uint8Array(32), deviceId: 'd' } };
  const feed = createLibraryChangeFeed();
  const subscribe = jest.spyOn(feed, 'subscribe');
  const actions = { readMirrorCounts: jest.fn(async () => ({ backedUp: 2, backedUpTotal: 2,
    downloaded: 2, downloadedTotal: 2, totalBytes: 100, pending: 0, inCloud: 0, inCloudBytes: 0 })),
    readQuotaFullCount: jest.fn(async () => 0) };
  const sync = { readSyncState: jest.fn(async () => ({ lastSyncedAt: 100 })) };
  const mode = { read: jest.fn(async () => 'both'), set: jest.fn() };
  mockServices = { byosStatus: status, libraryActions: actions, librarySync: sync,
    libraryChanges: feed, libraryStorageMode: mode, libraryController: {} };
  return { quota, store, feed, subscribe, actions, sync, mode };
}
it('two home/page consumers use one real runtime provider; navigation, equal renders and active add no reads', async () => {
  await i18n.changeLanguage('en');
  mockPath = '/settings';
  const ports = services();
  const seen: CloudLibraryData[] = [];
  function Consumer({ index }: { index: number }) { seen[index] = useCloudLibraryModel(); return null; }
  function Tree({ page }: { page: boolean }) {
    return <ByosCloudLibraryProvider><Consumer index={0} />{page && <Consumer index={1} />}</ByosCloudLibraryProvider>;
  }
  let foreground!: (state: AppStateStatus) => void;
  const active = jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => { foreground = listener; return { remove: jest.fn() }; });
  const { rerender, unmount } = await render(<Tree page={false} />);
  expect(seen[0].model.footer?.kind).toBe('synced');
  expect(ports.actions.readMirrorCounts).toHaveBeenCalledTimes(1);
  expect(ports.store.quota).toHaveBeenCalledTimes(1);
  mockPath = '/settings/cloud';
  await rerender(<Tree page />);
  expect(seen[0]).toBe(seen[1]);
  await act(async () => foreground('active'));
  expect(ports.actions.readMirrorCounts).toHaveBeenCalledTimes(1);
  expect(ports.sync.readSyncState).toHaveBeenCalledTimes(1);
  expect(ports.mode.read).toHaveBeenCalledTimes(1);
  expect(ports.store.quota).toHaveBeenCalledTimes(1);
  expect(ports.subscribe).toHaveBeenCalledTimes(1);
  await act(async () => { ports.feed.emit({ kind: 'round-complete' }); ports.feed.emit({ kind: 'round-complete' }); });
  expect(ports.store.quota).toHaveBeenCalledTimes(1);
  await act(async () => ports.quota.resolve({ usedBytes: 9, totalBytes: 10 }));
  expect(ports.store.quota).toHaveBeenCalledTimes(2);
  await act(async () => ports.feed.emit({ kind: 'round-complete' }));
  expect(ports.store.quota).toHaveBeenCalledTimes(3);
  mockPath = '/collection';
  await rerender(<Tree page />);
  expect(seen[0].quota).toBeNull();
  expect(seen[0].model.stats).toBeNull();
  await act(async () => ports.feed.emit({ kind: 'round-complete' }));
  mockPath = '/settings';
  const count = ports.actions.readMirrorCounts.mock.calls.length;
  await rerender(<Tree page={false} />);
  expect(ports.actions.readMirrorCounts).toHaveBeenCalledTimes(count + 1);
  await unmount(); active.mockRestore();
});
it('a mode write and failed disconnect publish the stored mode to both real-provider consumers', async () => {
  await i18n.changeLanguage('en');
  mockPath = '/settings';
  const ports = services();
  let stored: LibraryStorageMode = 'both';
  const mode = {
    read: jest.fn(async () => stored),
    set: jest.fn(async (value: LibraryStorageMode) => { stored = value; }),
  };
  mockServices.libraryStorageMode = mode;
  const seen: CloudLibraryData[] = [];
  function Consumer({ index }: { index: number }) { seen[index] = useCloudLibraryModel(); return null; }
  const onReload = jest.fn();
  const props = { byosStatus: mockServices.byosStatus as ByosStatus, actions: null,
    sync: null, libraryChanges: ports.feed, storageMode: mode, onReload };
  const { unmount } = await render(<ByosCloudLibraryProvider><Consumer index={0} /><Consumer index={1} />
    <ByosSettingsSlot {...props} renderCloudMessage={renderCloudMessage} /></ByosCloudLibraryProvider>);
  await act(async () => { await fireEvent.press(screen.getByTestId('byos-storage-mode')); });
  await act(async () => { await fireEvent.press(screen.getByRole('button', { name: i18n.t('settings.byos.storageMode.cloudOnly') })); });
  await act(async () => { await fireEvent.press(screen.getByRole('button', { name: i18n.t('settings.byos.storageMode.warn.confirm') })); });
  expect(seen[0]).toBe(seen[1]);
  expect(seen[0].model.storageMode).toBe('cloud-only');
  expect(mode.read).toHaveBeenCalledTimes(2);
  jest.mocked(disconnectDevice).mockImplementation(async () => { stored = 'both'; throw new Error('disconnect'); });
  await act(async () => { await fireEvent.press(screen.getByTestId('byos-disconnect')); });
  await act(async () => { await fireEvent.press(screen.getByRole('button', { name: i18n.t('settings.byos.disconnectConfirm.confirm') })); });
  expect(onReload).not.toHaveBeenCalled();
  expect(seen[0]).toBe(seen[1]);
  expect(seen[0].model.storageMode).toBe('both');
  expect(mode.read).toHaveBeenCalledTimes(3);
  expect(ports.actions.readMirrorCounts).toHaveBeenCalledTimes(1);
  await unmount();
});
it.each([true, false])('a deferred mode write refreshes the current snapshot after navigation (return before completion: %s)', async (returnBeforeCompletion) => {
  await i18n.changeLanguage('zh-Hans');
  mockPath = '/settings';
  const ports = services();
  const write = deferred<void>();
  let stored: LibraryStorageMode = 'both';
  const mode = {
    read: jest.fn(async () => stored),
    set: jest.fn(async (value: LibraryStorageMode) => {
      await write.promise;
      stored = value;
    }),
  };
  mockServices.libraryStorageMode = mode;
  const seen: CloudLibraryData[] = [];
  function Consumer({ index }: { index: number }) { seen[index] = useCloudLibraryModel(); return null; }
  const props = { byosStatus: mockServices.byosStatus as ByosStatus, actions: null,
    sync: null, libraryChanges: ports.feed, storageMode: mode, onReload: jest.fn() };
  function Tree({ settings }: { settings: boolean }) {
    return <ByosCloudLibraryProvider><Consumer index={0} /><Consumer index={1} />
      {settings && <ByosSettingsSlot {...props} renderCloudMessage={renderCloudMessage} />}</ByosCloudLibraryProvider>;
  }
  const { rerender, unmount } = await render(<Tree settings />);
  const refresh = seen[0].refreshStorageMode;
  await act(async () => { await fireEvent.press(screen.getByTestId('byos-storage-mode')); });
  await act(async () => { await fireEvent.press(screen.getByRole('button', { name: '仅云端' })); });
  await act(async () => { await fireEvent.press(screen.getByRole('button', { name: i18n.t('settings.byos.storageMode.warn.confirm') })); });
  expect(mode.set).toHaveBeenCalledWith('cloud-only');
  expect(stored).toBe('both');
  expect(mode.read).toHaveBeenCalledTimes(1);
  mockPath = '/collection';
  await rerender(<Tree settings={false} />);
  expect(seen[0].model.storageMode).toBeNull();
  expect(screen.queryByTestId('byos-storage-mode')).toBeNull();
  if (returnBeforeCompletion) {
    mockPath = '/settings';
    await rerender(<Tree settings />);
    expect(mode.read).toHaveBeenCalledTimes(2);
    expect(seen[0].model.storageMode).toBe('both');
    expect(within(screen.getByTestId('byos-storage-mode')).getByText('本地+云端')).toBeTruthy();
  }
  await act(async () => write.resolve());
  expect(stored).toBe('cloud-only');
  if (!returnBeforeCompletion) {
    // Completion outside Settings adds no mode read; returning reads the stored answer once.
    expect(mode.read).toHaveBeenCalledTimes(1);
    expect(seen[0].model.storageMode).toBeNull();
    mockPath = '/settings';
    await rerender(<Tree settings />);
  }
  expect(seen[0].model.storageMode).toBe('cloud-only');
  expect(seen[0]).toBe(seen[1]);
  expect(within(screen.getByTestId('byos-storage-mode')).getByText('仅云端')).toBeTruthy();
  expect(seen[0].refreshStorageMode).toBe(refresh);
  const reads = returnBeforeCompletion ? 3 : 2;
  expect(mode.read).toHaveBeenCalledTimes(reads);
  await act(async () => {
    ports.feed.emit({ kind: 'round-complete' });
    ports.feed.emit({ kind: 'freed' });
  });
  expect(mode.read).toHaveBeenCalledTimes(reads);
  expect(seen[0].model.storageMode).toBe('cloud-only');
  await unmount();
  await act(async () => refresh());
  expect(mode.read).toHaveBeenCalledTimes(reads);
});
it('locked local identity loads once per controller; locale changes never reload credentials', async () => {
  await i18n.changeLanguage('en');
  mockPath = '/settings';
  services();
  mockServices.byosStatus = { status: 'locked', reason: 'password_required' };
  const loadBinding = jest.fn(async () => ({ kind: 'gdrive', accountEmail: 'owner@example.com', refreshToken: 'SECRET' }));
  jest.mocked(createByosCredentialStore).mockReturnValue({ loadBinding } as never);
  const wrapper = ({ children }: { children: ReactNode }) => <ByosCloudLibraryProvider>{children}</ByosCloudLibraryProvider>;
  const { result, rerender, unmount } = await renderHook(() => useCloudLibraryModel(), { wrapper });
  expect(result.current.model.identity?.label).toBe('Google Drive');
  await act(async () => i18n.changeLanguage('ja'));
  expect(result.current.model.identity?.label).toBe('Google ドライブ');
  expect(loadBinding).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result.current)).not.toContain('SECRET');
  mockServices.libraryController = {};
  await rerender(undefined);
  expect(loadBinding).toHaveBeenCalledTimes(2);
  await unmount();
});
