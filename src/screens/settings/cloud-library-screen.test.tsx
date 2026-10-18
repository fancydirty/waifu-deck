import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { AppState, Keyboard, ScrollView, TextInput, type AppStateStatus } from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import { createLibraryChangeFeed } from '@/features/library/library-change-feed';
import i18n from '@/i18n';
import { cloudCounts, cloudSnapshot } from '@/test/cloud-library-fixtures';
import { createByosCredentialStore } from '@/features/byos/byos-credentials';
import { probeBucket, connectToBucket, reauthGdrive, reauthOneDrive, disconnectDevice } from '@/features/byos/byos-connect-flow';
import { ByosCloudLibraryProvider } from './byos-settings-slot';
import { CloudLibraryCard } from './cloud-library-card';
import { useCloudLibraryModel, CloudLibraryContext } from './cloud-library-context';
import { CloudLibraryScreen } from './cloud-library-screen';
import { colors } from '@/theme/colors';

let mockServices: any;
const mockNavigation = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
jest.mock('@/providers/app-services', () => ({ useAppServices: () => mockServices }));
jest.mock('expo-router', () => ({ usePathname: () => '/settings/cloud', useRouter: () => mockNavigation }));
jest.mock('@/features/byos/byos-credentials', () => ({ createByosCredentialStore: jest.fn() }));
jest.mock('@/features/byos/byos-connect-flow', () => ({
  probeBucket: jest.fn(), connectToBucket: jest.fn(), provisionS3FromApiKey: jest.fn(), probeWebdav: jest.fn(), connectWebdav: jest.fn(),
  signInWithMicrosoft: jest.fn(), probeOneDrive: jest.fn(), connectOneDrive: jest.fn(), reauthOneDrive: jest.fn(),
  signInWithGoogle: jest.fn(), probeGdrive: jest.fn(), connectGdrive: jest.fn(), reauthGdrive: jest.fn(), disconnectDevice: jest.fn(),
}));
jest.mock('lucide-react-native', () => ({ Check: () => null, ChevronRight: () => null, Cloud: () => null, Lock: () => null, Server: () => null }));
const ready: ByosStatus = { status: 'ready', context: { kind: 's3', credentials: {
  kind: 's3', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-library',
  accessKeyId: 'key', secretAccessKey: 'secret', prefix: 'waifu-deck/',
}, meta: { format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'aes-gcm', vaultId: 'v',
  kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: '' }, keyCheckB64: '', createdAt: '' }, masterKey: new Uint8Array(32), deviceId: 'd' } };
function services(status: ByosStatus = ready) {
  return { byosStatus: status, libraryActions: { readMirrorCounts: jest.fn(async () => cloudCounts),
    readQuotaFullCount: jest.fn(async () => 0), getAccountScope: jest.fn(async () => 'scope') },
    librarySync: { readSyncState: jest.fn(async () => ({ lastSyncedAt: 100_000 })) },
    libraryChanges: createLibraryChangeFeed(), libraryStorageMode: { read: jest.fn(async () => 'both'), set: jest.fn(async () => undefined) },
    libraryController: {}, reloadAppServices: jest.fn() };
}
const tree = () => <ByosCloudLibraryProvider><CloudLibraryScreen /></ByosCloudLibraryProvider>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function HomeCard() {
  const data = useCloudLibraryModel();
  return <CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />;
}
beforeEach(async () => {
  jest.clearAllMocks(); await i18n.changeLanguage('en'); mockServices = services();
  jest.mocked(createByosCredentialStore).mockReturnValue({ loadBinding: jest.fn(async () => null) } as never);
});
test('real provider and home card keep the same 正在下载 footer throughout deferred local refreshes', async () => {
  await i18n.changeLanguage('zh-Hans');
  const counts = deferred<typeof cloudCounts>();
  const sync = deferred<{ lastSyncedAt: number }>();
  const full = deferred<number>();
  mockServices.libraryActions.readMirrorCounts.mockResolvedValueOnce({ ...cloudCounts, downloaded: 0 })
    .mockReturnValueOnce(counts.promise);
  mockServices.librarySync.readSyncState.mockReturnValueOnce(Promise.resolve({ lastSyncedAt: 100_000 }))
    .mockReturnValueOnce(sync.promise);
  mockServices.libraryActions.readQuotaFullCount.mockReturnValueOnce(Promise.resolve(0)).mockReturnValueOnce(full.promise);
  await render(<ByosCloudLibraryProvider><HomeCard /></ByosCloudLibraryProvider>);
  const footer = screen.getByTestId('settings-cloud-footer');
  expect(footer).toHaveTextContent(/^正在下载，还差 2 张$/);
  await act(async () => mockServices.libraryChanges.emit({ kind: 'round-complete' }));
  expect(screen.getByTestId('settings-cloud-footer')).toBe(footer);
  expect(footer).toHaveTextContent(/^正在下载，还差 2 张$/);
  await act(async () => { sync.resolve({ lastSyncedAt: 200_000 }); full.resolve(0); });
  expect(screen.getByTestId('settings-cloud-footer')).toBe(footer);
  expect(footer).toHaveTextContent(/^正在下载，还差 2 张$/);
  await act(async () => counts.resolve({ ...cloudCounts, downloaded: 1 }));
  expect(screen.getByTestId('settings-cloud-footer')).toHaveTextContent(/^正在下载，还差 1 张$/);
  expect(mockServices.libraryActions.readMirrorCounts).toHaveBeenCalledTimes(2);
  expect(mockServices.libraryStorageMode.read).toHaveBeenCalledTimes(1);
});
test.each(['zh-Hans', 'zh-Hant', 'ja', 'en'])('%s: real provider preserves the exact WebDAV title in ready and locked states', async (locale) => {
  await i18n.changeLanguage(locale);
  const binding = { kind: 'webdav' as const, baseUrl: 'https://dav.example.com:5006/path', username: 'me', password: 'secret', rootPath: 'library' };
  if (ready.status !== 'ready') throw new Error('fixture');
  mockServices.byosStatus = { status: 'ready', context: { ...ready.context, kind: 'store', binding, store: { quota: async () => null } } };
  const composition = () => <ByosCloudLibraryProvider><HomeCard /></ByosCloudLibraryProvider>;
  const view = await render(composition());
  expect(screen.getByText('WebDAV', { exact: true })).toBeOnTheScreen();
  expect(screen.getByText('dav.example.com:5006 · me', { exact: true })).toBeOnTheScreen();
  jest.mocked(createByosCredentialStore).mockReturnValue({ loadBinding: async () => binding } as never);
  mockServices.byosStatus = { status: 'locked', reason: 'password_required' };
  await view.rerender(composition());
  expect(screen.getByText('WebDAV', { exact: true })).toBeOnTheScreen();
  expect(screen.getByText('dav.example.com:5006 · me', { exact: true })).toBeOnTheScreen();
});
test('page uses the existing section, service mode/sync/feed and IDs; R9 import stays hidden', async () => {
  await render(tree());
  expect(screen.getByTestId('screen-settings-cloud')).toBeOnTheScreen();
  expect(screen.getByTestId('cloud-library-scroll')).toBeOnTheScreen();
  for (const id of ['byos-section', 'byos-status', 'byos-mirror-progress', 'byos-storage-mode', 'byos-disconnect', 'byos-last-sync', 'storage-kind-badge']) expect(screen.getByTestId(id)).toBeOnTheScreen();
  expect(screen.queryByText('Import images')).toBeNull();
  await fireEvent.press(screen.getByTestId('byos-storage-mode'));
  await fireEvent.press(screen.getByRole('button', { name: 'Cloud only' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Turn on' }));
  expect(mockServices.libraryStorageMode.set).toHaveBeenCalledWith('cloud-only');
  expect(mockServices.libraryStorageMode.read).toHaveBeenCalledTimes(2);
  await act(async () => mockServices.libraryChanges.emit({ kind: 'protected' }));
  expect(mockServices.libraryActions.readMirrorCounts).toHaveBeenCalledTimes(2);
  expect(mockServices.librarySync.readSyncState).toHaveBeenCalledTimes(2);
});
test('unconfigured with no controller/actions retains picker, S3/WebDAV forms and form back stays on page', async () => {
  mockServices = { ...services({ status: 'unconfigured' }), libraryController: null, libraryActions: null };
  await render(tree());
  expect(screen.getByTestId('storage-pick-s3')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('storage-pick-s3'));
  // No prefix field: removed by the U4-design ruling (2026-10-12).
  for (const field of ['endpoint', 'bucket', 'access-key', 'secret', 'region']) expect(screen.getByTestId(`byos-field-${field}`)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('storage-pick-back'));
  expect(screen.getByTestId('storage-pick-heading')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('storage-pick-webdav'));
  expect(screen.getByTestId('webdav-field-url')).toBeOnTheScreen();
  expect(screen.getByTestId('webdav-field-password').props.secureTextEntry).toBe(true);
  await fireEvent.press(screen.getByTestId('storage-pick-back'));
  expect(screen.getByTestId('screen-settings-cloud')).toBeOnTheScreen();
  expect(mockNavigation.back).not.toHaveBeenCalled();
});
test('S3 probe and plain create on the real page preserve the explicit successful-connect reload', async () => {
  mockServices = services({ status: 'unconfigured' });
  jest.mocked(probeBucket).mockResolvedValue({ kind: 'empty' });
  jest.mocked(connectToBucket).mockResolvedValue({ ok: true, vaultId: 'v', encryption: 'none' });
  await render(tree());
  await fireEvent.press(screen.getByTestId('storage-pick-s3'));
  for (const [id, value] of [
    ['endpoint', 'https://example.r2.cloudflarestorage.com'], ['bucket', 'my-library'],
    ['access-key', 'key'], ['secret', 'secret'],
  ]) await fireEvent.changeText(screen.getByTestId(`byos-field-${id}`), value);
  await fireEvent.press(screen.getByTestId('byos-check'));
  expect(screen.getByTestId('byos-probe-empty')).toBeOnTheScreen();
  expect(screen.getByTestId('byos-field-password')).toBeOnTheScreen();
  await fireEvent(screen.getByTestId('byos-encryption-toggle'), 'valueChange', false);
  expect(screen.queryByTestId('byos-field-password')).toBeNull();
  expect(screen.queryByTestId('byos-field-password-confirm')).toBeNull();
  await fireEvent.press(screen.getByTestId('byos-create'));
  expect(connectToBucket).toHaveBeenCalledWith(expect.objectContaining({ encryption: 'none', probe: { kind: 'empty' } }));
  expect(mockServices.reloadAppServices).toHaveBeenCalledTimes(1);
});

test.each<ByosStatus>([
  { status: 'locked', reason: 'password_required' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
  { status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' },
])('interim page retains locked controls and successful action reload for %j', async (status) => {
  mockServices = services(status);
  jest.mocked(probeBucket).mockResolvedValue({ kind: 'existing', meta: ready.status === 'ready' ? ready.context.meta : null } as never);
  jest.mocked(createByosCredentialStore).mockReturnValue({ loadBinding: async () => ready.status === 'ready' && ready.context.kind === 's3' ? ready.context.credentials : null } as never);
  jest.mocked(connectToBucket).mockResolvedValue({ ok: true, vaultId: 'v', encryption: 'aes-gcm' });
  jest.mocked(reauthGdrive).mockResolvedValue({ ok: true }); jest.mocked(reauthOneDrive).mockResolvedValue({ ok: true });
  await render(tree());
  expect(screen.getByTestId('byos-locked-reason')).toBeOnTheScreen();
  expect(screen.getByTestId('byos-disconnect')).toBeOnTheScreen();
  if (status.status === 'locked' && status.reason === 'password_required') {
    await fireEvent.changeText(screen.getByTestId('byos-unlock-password'), 'password');
    await fireEvent.press(screen.getByTestId('byos-unlock'));
    expect(connectToBucket).toHaveBeenCalledWith(expect.objectContaining({ password: 'password' }));
    expect(mockServices.reloadAppServices).toHaveBeenCalledTimes(1);
  } else if (status.status === 'locked' && status.reason === 'vault_unreachable' && status.detail === 'reauth_required') {
    expect(screen.queryByTestId('byos-unlock-password')).toBeNull();
    await fireEvent.press(screen.getByTestId('byos-reauth'));
    expect(status.provider === 'gdrive' ? reauthGdrive : reauthOneDrive).toHaveBeenCalledTimes(1);
    expect(status.provider === 'gdrive' ? reauthOneDrive : reauthGdrive).not.toHaveBeenCalled();
    expect(mockServices.reloadAppServices).toHaveBeenCalledTimes(1);
  } else {
    expect(screen.queryByTestId('byos-unlock')).toBeNull();
    expect(screen.queryByTestId('byos-reauth')).toBeNull();
    expect(mockServices.reloadAppServices).not.toHaveBeenCalled();
  }
});
test('automatic ready recovery keeps the same page root and scroll mounted without navigation or reload', async () => {
  mockServices = services({ status: 'locked', reason: 'vault_unreachable', detail: 'network' });
  const view = await render(tree());
  const root = screen.getByTestId('screen-settings-cloud');
  const scroll = screen.getByTestId('cloud-library-scroll');
  mockServices = { ...mockServices, byosStatus: ready };
  await view.rerender(tree());
  expect(screen.getByTestId('screen-settings-cloud')).toBe(root);
  expect(screen.getByTestId('cloud-library-scroll')).toBe(scroll);
  expect(screen.getByTestId('byos-status')).toBeOnTheScreen();
  expect(screen.queryByTestId('byos-locked-reason')).toBeNull();
  expect(mockServices.reloadAppServices).not.toHaveBeenCalled();
  expect(mockNavigation.replace).not.toHaveBeenCalled(); expect(mockNavigation.push).not.toHaveBeenCalled();
});
test('explicit disconnect retains confirmation and reload', async () => {
  jest.mocked(disconnectDevice).mockResolvedValue(undefined);
  await render(tree());
  await fireEvent.press(screen.getByTestId('byos-disconnect'));
  await fireEvent.press(screen.getByRole('button', { name: 'Disconnect' }));
  expect(disconnectDevice).toHaveBeenCalledTimes(1);
  expect(mockServices.reloadAppServices).toHaveBeenCalledTimes(1);
});
test.each(['s3', 'gdrive'] as const)('one real %s provider updates both home and interim page ages on foreground, without any new reader call', async (kind) => {
  const readQuota = jest.fn(async () => ({ usedBytes: 1_000_000, totalBytes: 10_000_000 }));
  if (kind === 'gdrive' && ready.status === 'ready') {
    mockServices.byosStatus = { status: 'ready', context: { ...ready.context, kind: 'store',
      binding: { kind: 'gdrive', accountEmail: 'owner@example.com', refreshToken: 'private', rootFolderId: 'r', stateFolderId: 's', blobsFolderId: 'b' },
      store: { quota: readQuota } } };
  }
  let active: ((state: AppStateStatus) => void) | undefined;
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { active = listener; return { remove }; });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(220_000);
  const feedSubscribe = jest.spyOn(mockServices.libraryChanges, 'subscribe');
  function Home() { const data = useCloudLibraryModel(); return <CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />; }
  const composition = () => <ByosCloudLibraryProvider><Home /><CloudLibraryScreen /></ByosCloudLibraryProvider>;
  const view = await render(composition());
  const age = 'All backed up · 2 minutes ago';
  expect(within(screen.getByTestId('settings-cloud-card')).getByText(age)).toBeOnTheScreen();
  expect(screen.getByTestId('byos-last-sync')).toHaveTextContent(age);
  const readers = [mockServices.libraryActions.readMirrorCounts, mockServices.libraryActions.readQuotaFullCount,
    mockServices.librarySync.readSyncState, mockServices.libraryStorageMode.read, feedSubscribe];
  for (const read of readers) expect(read).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(400_000);
  await view.rerender(composition());
  expect(screen.getByTestId('byos-last-sync')).toHaveTextContent(age);
  await act(async () => active?.('active'));
  expect(within(screen.getByTestId('settings-cloud-card')).getByText('All backed up · 5 minutes ago')).toBeOnTheScreen();
  expect(screen.getByTestId('byos-last-sync')).toHaveTextContent('All backed up · 5 minutes ago');
  for (const read of readers) expect(read).toHaveBeenCalledTimes(1);
  expect(readQuota).toHaveBeenCalledTimes(kind === 's3' ? 0 : 1);
  expect(createByosCredentialStore).not.toHaveBeenCalled();
  await act(async () => { await i18n.changeLanguage('ja'); });
  const japanese = 'すべてバックアップ済み · 5 分前';
  expect(within(screen.getByTestId('settings-cloud-card')).getByText(japanese)).toBeOnTheScreen();
  expect(screen.getByTestId('byos-last-sync')).toHaveTextContent(japanese);
  for (const read of readers) expect(read).toHaveBeenCalledTimes(1);
  expect(readQuota).toHaveBeenCalledTimes(kind === 's3' ? 0 : 1);
  await view.unmount(); expect(remove).toHaveBeenCalledTimes(1); clock.mockRestore();
});
test.each([
  [{ status: 'unconfigured' }, 'storage-pick-s3', 'byos-field-secret'],
  [{ status: 'unconfigured' }, 'storage-pick-webdav', 'webdav-field-password'],
  [{ status: 'locked', reason: 'password_required' }, null, 'byos-unlock-password'],
] as const)('real page reveals secure field $2 above a taller IME', async (status, picker, field) => {
  mockServices = services(status);
  let show: ((event: any) => void) | undefined;
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => {
    if (event === 'keyboardDidShow') show = listener;
    return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
  });
  jest.spyOn(ScrollView.prototype, 'getInnerViewNode').mockReturnValue(123);
  jest.spyOn(TextInput.prototype, 'measureLayout').mockImplementation((_node, success) => success(0, 700, 300, 48));
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  await render(tree());
  if (picker !== null) await fireEvent.press(screen.getByTestId(picker));
  expect(screen.getByTestId(field).props.secureTextEntry).toBe(true);
  await fireEvent(screen.getByTestId('cloud-library-scroll'), 'layout', { nativeEvent: { layout: { height: 800 } } });
  await fireEvent(screen.getByTestId(field), 'focus');
  await act(async () => show?.({ endCoordinates: { height: 400 } }));
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 364, animated: true });
});

test('page also accepts the already-owned context, without mounting a second data provider', async () => {
  await render(<CloudLibraryContext.Provider value={cloudSnapshot(ready)}><CloudLibraryScreen /></CloudLibraryContext.Provider>);
  expect(mockServices.libraryActions.readMirrorCounts).not.toHaveBeenCalled();
});

test('the page paints the shared settings surface (spec §3 page background swap)', async () => {
  await render(tree());
  expect(screen.getByTestId('screen-settings-cloud')).toHaveStyle({ backgroundColor: colors.light.surface });
});
