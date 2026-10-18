import { render, screen, userEvent, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Keyboard } from 'react-native';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import i18n from '@/i18n';
import { cloudSnapshot } from '@/test/cloud-library-fixtures';
import { CloudLibraryContext } from './cloud-library-context';
import { SettingsScreen, SettingsView, type SettingsViewProps } from './settings-screen';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';
import type { CloudLibraryModel } from './cloud-library-model';
import { ResetSettingsScreen } from './reset-settings-screen';

let mockServices: Record<string, unknown>;
jest.mock('@/providers/app-services', () => ({ useAppServices: () => mockServices }));
const mockPush = jest.fn();
const mockImeListener = jest.fn((..._args: unknown[]) => ({ remove: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }), useFocusEffect: jest.fn() }));
jest.mock('../../../modules/waifu-sync-service', () => ({ addImeHeightListener: (...args: unknown[]) => mockImeListener(...args), WaifuSyncService: null }));
jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { Archive: Icon, ArchiveRestore: Icon, Database: Icon, Filter: Icon, HardDrive: Icon,
    Languages: Icon, RotateCcw: Icon, Trash2: Icon, ChevronRight: Icon, Check: Icon, Cloud: Icon, Lock: Icon, Server: Icon, X: Icon, Search: Icon };
});
const props = { settings: DEFAULT_SETTINGS, previewCacheBytes: 1234, collectionBytes: 5678, appVersion: 'test',
  updateSettings: jest.fn(), clearPreviewCache: jest.fn(), createFullBackup: jest.fn(), restoreFullBackup: jest.fn() } satisfies SettingsViewProps;
beforeEach(async () => { mockPush.mockClear(); mockImeListener.mockClear(); await i18n.changeLanguage('en'); });
const statuses: ByosStatus[] = [
  { status: 'unconfigured' }, { status: 'locked', reason: 'password_required' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'gdrive' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider: 'onedrive' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
  { status: 'locked', reason: 'vault_unreachable', detail: 'credential_rejected' },
  { status: 'locked', reason: 'meta_corrupt', detail: 'meta_absent' },
];
const configured: CloudLibraryModel = { state: 'ready', identity: { kind: 's3', label: 'Cloudflare R2', identity: 'bucket' },
  tone: 'ok', messageKey: null, reauthProvider: null, stats: { inCloud: 17, totalBytes: 123, pending: 2 },
  footer: { kind: 'pending', count: 2 }, storageMode: 'both', encryption: 'aes-gcm' };
const cases = [
  ...statuses.map((status) => ({ name: JSON.stringify(status), data: cloudSnapshot(status) })),
  ...(['aes-gcm', 'none'] as const).map((encryption) => ({ name: `ready ${encryption}`, data: { ...cloudSnapshot({ status: 'unconfigured' }), model: { ...configured, encryption } } })),
  { name: 'loading', data: { ...cloudSnapshot({ status: 'unconfigured' }), model: { ...configured, state: 'loading' as const, tone: null, stats: null, footer: null, encryption: null, storageMode: null } } },
];
test.each([
  ['both', 'aes-gcm', 'This phone + cloud', 'Encrypted'],
  ['both', 'none', 'This phone + cloud', 'Not encrypted'],
  ['cloud-only', 'aes-gcm', 'Cloud only', 'Encrypted'],
  ['cloud-only', 'none', 'Cloud only', 'Not encrypted'],
] as const)('home cloud pill labels stay single-line (%s, %s)', async (storageMode, encryption, storageLabel, encryptionLabel) => {
  const data = { ...cloudSnapshot({ status: 'unconfigured' }), model: { ...configured, storageMode, encryption } };
  await render(<CloudLibraryContext.Provider value={data}><SettingsView {...props} /></CloudLibraryContext.Provider>);
  const card = screen.getByTestId('settings-cloud-card');
  const labels = [storageLabel, encryptionLabel].flatMap((label) => within(card).getAllByText(label, { exact: true }));
  expect(labels).toHaveLength(2);
  for (const label of labels) {
    expect(label.type).toBe('Text');
    expect(label).toHaveProp('numberOfLines', 1);
  }
});

test.each(cases)('real Settings: title then first card, sources, one push, no cloud controls for $name', async ({ data }) => {
  await render(<CloudLibraryContext.Provider value={data}><SettingsView {...props} /></CloudLibraryContext.Provider>);
  const scroll = screen.getByTestId('settings-scroll');
  const content = scroll.children[0];
  expect(typeof content === 'object' && content.children[0] === screen.getByTestId('settings-title')).toBe(true);
  expect(typeof content === 'object' && content.children[1] === screen.getByTestId('settings-cloud-card')).toBe(true);
  const ids = ['settings-title', 'settings-cloud-card', 'settings-sources-entry', 'settings-discover-entry'];
  expect(scroll.queryAll((node) => typeof node.type === 'string' && ids.includes(node.props.testID))
    .map((node) => node.props.testID)).toEqual(ids);
  expect(screen.queryByTestId('settings-style-preference')).toBeNull();
  expect(screen.getByRole('button', { name: 'More preferences, Portrait · Exclude animated · Preload 40' })).toBeOnTheScreen();
  expect(screen.queryByTestId('byos-section')).toBeNull();
  expect(screen.queryByTestId('byos-unlock')).toBeNull();
  expect(screen.queryByTestId('byos-reauth')).toBeNull();
  expect(screen.container.queryAll((node) => node.props.secureTextEntry !== undefined || node.props.onChangeText !== undefined)).toHaveLength(0);
  expect(screen.queryByText('Cloud sync')).toBeNull();
  await userEvent.press(screen.getByTestId('settings-cloud-card'));
  expect(mockPush.mock.calls).toEqual([['/settings/cloud']]);
  await userEvent.press(screen.getByTestId('settings-discover-entry'));
  expect(mockPush.mock.calls).toEqual([['/settings/cloud'], ['/settings/discover']]);
});
test.each([true, false])('the sources home entry forwards one real press to /settings/sources (adult=%s)', async (allowsAdultContent) => {
  await render(<CloudLibraryContext.Provider value={cloudSnapshot({ status: 'unconfigured' })}>
    <SettingsView {...props} allowsAdultContent={allowsAdultContent} />
  </CloudLibraryContext.Provider>);
  const entry = screen.getByTestId('settings-sources-entry');
  expect(entry).toBe(screen.getByRole('button', { name: 'Image sources' }));
  await userEvent.press(entry);
  expect(mockPush.mock.calls).toEqual([['/settings/sources']]);
});

test.each([null, {}])('real service-connected SettingsScreen keeps the first card with controller %j and no inline slots', async (libraryController) => {
  mockServices = { ...props, dataRevision: 0, byosStatus: { status: 'unconfigured' }, libraryController,
    libraryActions: null, libraryChanges: null, managedPreviewCache: { getBytes: async () => 1234 },
    collectionService: { getCollectionBytes: async () => 5678 } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(<QueryClientProvider client={client}><CloudLibraryContext.Provider value={cloudSnapshot({ status: 'unconfigured' })}>
    <SettingsScreen />
  </CloudLibraryContext.Provider></QueryClientProvider>);
  const content = screen.getByTestId('settings-scroll').children[0];
  expect(typeof content === 'object' && content.children[0] === screen.getByTestId('settings-title')).toBe(true);
  expect(typeof content === 'object' && content.children[1] === screen.getByTestId('settings-cloud-card')).toBe(true);
  expect(screen.getByTestId('settings-sources-entry')).toBeOnTheScreen();
  expect(screen.queryByTestId('byos-section')).toBeNull();
});

test('home owns no keyboard or native IME listeners, keeps tab reserve and its own modal inputs', async () => {
  const keyboard = jest.spyOn(Keyboard, 'addListener');
  await render(<CloudLibraryContext.Provider value={cloudSnapshot({ status: 'unconfigured' })}><SettingsView {...props} /></CloudLibraryContext.Provider>);
  expect(keyboard).not.toHaveBeenCalled();
  expect(mockImeListener).not.toHaveBeenCalled();
  expect(screen.getByTestId('settings-scroll').props.contentContainerStyle.paddingBottom).toBe(tabBarContentInset(0));
  await userEvent.press(screen.getByRole('button', { name: 'Edit excluded tags' }));
  expect(screen.getByPlaceholderText('Type a tag, e.g. furry')).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: 'Close tag picker' }));
  expect(screen.queryByTestId('settings-delete-all')).toBeNull();
  await userEvent.press(screen.getByTestId('settings-reset-entry'));
  expect(mockPush).toHaveBeenCalledWith('/settings/reset');
  mockServices = { resetDismissedHistory: jest.fn(), resetDiscoveryHistory: jest.fn(),
    deleteAllAppData: jest.fn(), byosStatus: { status: 'unconfigured' } };
  const client = new QueryClient();
  await render(<QueryClientProvider client={client}><ResetSettingsScreen /></QueryClientProvider>);
  expect(screen.getByTestId('screen-settings-reset')).toBeOnTheScreen();
  await userEvent.press(screen.getByTestId('settings-delete-all'));
  expect(screen.getByTestId('settings-delete-all-input')).toBeOnTheScreen();
  expect(keyboard).not.toHaveBeenCalled();
  expect(mockImeListener).not.toHaveBeenCalled();
});
