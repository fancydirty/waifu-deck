import { act, render, userEvent, waitFor, within } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { BackHandler } from 'react-native';

import RootLayout from '@/app/_layout';
import TabsLayout from '@/app/(tabs)/_layout';
import SettingsRoute from '@/app/(tabs)/settings';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import i18n from '@/i18n';
import DiscoverRoute from '@/app/settings/discover';
import ResetRoute from '@/app/settings/reset';

let mockCurrentSettings: AppSettings = DEFAULT_SETTINGS;
let mockUpdateSettings: jest.Mock;
let mockWritesReady: Promise<void> | null = null;
const mockSettingsListeners = new Set<() => void>();
jest.mock('@/providers/app-services', () => ({
  ...jest.requireActual('@/providers/app-services'),
  AppServicesProvider: ({ children }: { children: ReactNode }) => children,
  useAppServices: function useAppServices() {
    const { useSyncExternalStore } = jest.requireActual<typeof import('react')>('react');
    const settings = useSyncExternalStore((listener) => {
      mockSettingsListeners.add(listener);
      return () => { mockSettingsListeners.delete(listener); };
    }, () => mockCurrentSettings);
    return {
      settings,
      updateSettings: mockUpdateSettings,
      dataRevision: 0,
      byosStatus: { status: 'unconfigured' },
      libraryChanges: null,
      managedPreviewCache: { getBytes: async () => 1234 },
      collectionService: { getCollectionBytes: async () => 5678 },
      resetDismissedHistory: jest.fn(async () => 2),
      resetDiscoveryHistory: jest.fn(async () => 5),
      deleteAllAppData: jest.fn(),
    };
  },
}));
jest.mock('@/screens/settings/byos-settings-slot', () => {
  const { CloudLibraryContext } = jest.requireActual('@/screens/settings/cloud-library-context');
  const { cloudSnapshot } = jest.requireActual('@/test/cloud-library-fixtures');
  return {
    ByosCloudLibraryProvider: ({ children }: { children: ReactNode }) => (
      <CloudLibraryContext.Provider value={cloudSnapshot({ status: 'unconfigured' })}>
        {children}
      </CloudLibraryContext.Provider>
    ),
  };
});
jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { Images: Icon, Search: Icon, Settings2: Icon, Sparkles: Icon,
    Archive: Icon, ArchiveRestore: Icon, Database: Icon, Filter: Icon, HardDrive: Icon,
    Languages: Icon, RotateCcw: Icon, Trash2: Icon, ChevronRight: Icon, Check: Icon, Cloud: Icon, Lock: Icon,
    Server: Icon, X: Icon };
});

const resetTitles = [
  ['zh-Hans', '重置与删除'], ['zh-Hant', '重置與刪除'],
  ['ja', 'リセットと削除'], ['en', 'Reset & delete'],
] as const;

const titles = [
  ['zh-Hans', '更多偏好', '纵向 · 排除动图 · 预加载 40', '纵向 · 排除动图 · 预加载 40 · 偏好 3D · 宽度 ≥ 1080 px', '，'],
  ['zh-Hant', '更多偏好', '直向 · 排除動圖 · 預先載入 40', '直向 · 排除動圖 · 預先載入 40 · 偏好 3D · 寬度 ≥ 1080 px', '，'],
  ['ja', 'その他の設定', '縦向き · アニメーションを除外 · 先読み 40', '縦向き · アニメーションを除外 · 先読み 40 · 3Dを優先 · 幅 ≥ 1080 px', '：'],
  ['en', 'More preferences', 'Portrait · Exclude animated · Preload 40', 'Portrait · Exclude animated · Preload 40 · Prefer 3D · Width ≥ 1080 px', ', '],
] as const;

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mockCurrentSettings = DEFAULT_SETTINGS;
  mockWritesReady = null;
  mockSettingsListeners.clear();
  let tail = Promise.resolve();
  mockUpdateSettings = jest.fn((update: (current: AppSettings) => AppSettings) => {
    const next = tail.then(async () => {
      await mockWritesReady;
      mockCurrentSettings = update(mockCurrentSettings);
      mockSettingsListeners.forEach((listener) => listener());
      return mockCurrentSettings;
    });
    tail = next.then(() => undefined, () => undefined);
    return next;
  });
});

test('the Discover route renders the real screen and its controls without an in-content title', async () => {
  await render(<DiscoverRoute />);
  expect(screen.getByTestId('screen-settings-discover')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-discover-scroll')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-style-preference')).toBeOnTheScreen();
  expect(screen.queryByText('More preferences')).toBeNull();
});

describe.each(resetTitles)('%s Reset navigation', (language, title) => {
  test.each(['header', 'Android'] as const)('entry → real page → one %s Back returns home, with clean delete reopen', async (backKind) => {
    await i18n.changeLanguage(language);
    expect(i18n.getResource(language, 'translation', 'settings.reset.title')).toBe(title);
    expect(i18n.getResource(language, 'translation', 'settings.reset.entry')).toBe(title);
    let hardwareBack: (() => boolean | null | undefined) | undefined;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      hardwareBack = handler;
      return { remove: jest.fn() };
    });
    const emptyRoute = () => null;
    const result = renderRouter({
      _layout: RootLayout, '(tabs)/_layout': TabsLayout,
      '(tabs)/index': emptyRoute, '(tabs)/search': emptyRoute,
      '(tabs)/collection': emptyRoute, '(tabs)/settings': SettingsRoute,
      'settings/discover': DiscoverRoute, 'settings/reset': ResetRoute,
      'settings/cloud': emptyRoute, 'settings/sources': emptyRoute,
      'library/trash': emptyRoute, 'image/[id]': emptyRoute,
    }, { initialUrl: '/settings' });
    await result;
    const home = screen.getByTestId('screen-settings');
    expect(screen.queryByTestId('settings-delete-all')).toBeNull();
    await userEvent.press(screen.getByTestId('settings-reset-entry'));
    expect(result.getPathname()).toBe('/settings/reset');
    const page = screen.getByTestId('screen-settings-reset');
    expect(screen.getByTestId('settings-reset-scroll')).toBeOnTheScreen();
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.container.queryAll((node) => node.type === 'RNSScreenStackHeaderConfig' && node.props.title === title)).toHaveLength(1);
    let nativeScreen = page.parent;
    while (nativeScreen && typeof nativeScreen.props.onHeaderBackButtonClicked !== 'function') nativeScreen = nativeScreen.parent;
    expect(nativeScreen).toBeTruthy();
    expect(nativeScreen!.props.stackPresentation).toBe('push');
    expect(screen.queryByTestId('settings-delete-all-input')).toBeNull();
    expect(screen.queryByTestId('settings-delete-all-confirm')).toBeNull();
    for (const kind of ['dismissed', 'discovery'] as const) {
      await userEvent.press(screen.getByRole('button', { name: i18n.t(kind === 'dismissed' ? 'settings.privacy.resetDismissed' : 'settings.privacy.resetDiscovery') }));
      expect(screen.getByText(i18n.t(kind === 'dismissed' ? 'settings.reset.dismissedTitle' : 'settings.reset.discoveryTitle'))).toBeOnTheScreen();
      await userEvent.press(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    }
    await userEvent.press(screen.getByTestId('settings-delete-all'));
    await fireEvent.changeText(screen.getByTestId('settings-delete-all-input'), 'DELETE');
    expect(screen.getByTestId('settings-delete-all-confirm')).toBeEnabled();
    await userEvent.press(screen.getByRole('button', { name: i18n.t('settings.deleteAll.cancel') }));
    await userEvent.press(screen.getByTestId('settings-delete-all'));
    expect(screen.getByTestId('settings-delete-all-input')).toHaveProp('value', '');
    expect(screen.getByTestId('settings-delete-all-confirm')).toBeDisabled();
    await userEvent.press(screen.getByRole('button', { name: i18n.t('settings.deleteAll.cancel') }));
    if (backKind === 'header') await fireEvent(nativeScreen!, 'headerBackButtonClicked');
    else await act(async () => { expect(hardwareBack?.()).toBe(true); });
    expect(result.getPathname()).toBe('/settings');
    expect(screen.getByTestId('screen-settings')).toBe(home);
    expect(screen.getByTestId('settings-reset-entry')).toBeOnTheScreen();
    expect(screen.queryByTestId('screen-settings-reset')).toBeNull();
    expect(screen.queryByTestId('settings-delete-all')).toBeNull();
  });
});

describe.each(titles)('%s Discover navigation', (language, title, initialSummary, updatedSummary, separator) => {
  test.each(['header', 'Android'] as const)('the real home entry opens the page with its Stack title; one %s Back returns home after writes', async (backKind) => {
    await i18n.changeLanguage(language);
    // Use the resource itself to exclude a fallback to English from the proof.
    expect(i18n.getResource(language, 'translation', 'settings.discover.title')).toBe(title);
    let hardwareBack: (() => boolean | null | undefined) | undefined;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      hardwareBack = handler;
      return { remove: jest.fn() };
    });
    const emptyRoute = () => null;
    const result = renderRouter({
      _layout: RootLayout, '(tabs)/_layout': TabsLayout,
      '(tabs)/index': emptyRoute, '(tabs)/search': emptyRoute,
      '(tabs)/collection': emptyRoute, '(tabs)/settings': SettingsRoute,
      'settings/discover': DiscoverRoute, 'settings/reset': ResetRoute, 'settings/cloud': emptyRoute,
      'settings/sources': emptyRoute, 'library/trash': emptyRoute, 'image/[id]': emptyRoute,
    }, { initialUrl: '/settings' });
    await result;
    const home = screen.getByTestId('screen-settings');
    expect(screen.getByRole('button', { name: title + separator + initialSummary })).toBeOnTheScreen();
    expect(within(screen.getByTestId('settings-discover-entry')).getByText(initialSummary)).toBeOnTheScreen();
    await userEvent.press(screen.getByTestId('settings-discover-entry'));

    const page = screen.getByTestId('screen-settings-discover');
    expect(result.getPathname()).toBe('/settings/discover');
    expect(screen.getByTestId('settings-discover-scroll')).toBeOnTheScreen();
    expect(screen.container.queryAll((node) => node.type === 'RNSScreenStackHeaderConfig'
      && node.props.title === title)).toHaveLength(1);
    expect(screen.queryByText(title)).toBeNull();
    let nativeScreen = page.parent;
    while (nativeScreen && typeof nativeScreen.props.onHeaderBackButtonClicked !== 'function') {
      nativeScreen = nativeScreen.parent;
    }
    expect(nativeScreen).toBeTruthy();
    // A card route is a native push screen; modal presentation would differ.
    expect(nativeScreen!.props.stackPresentation).toBe('push');

    await userEvent.press(screen.getByRole('radio', {
      name: i18n.t('settings.filters.stylePreference') + i18n.t('common.labelSeparator')
        + i18n.t('settings.filters.prefer3d'),
    }));
    await userEvent.press(screen.getByRole('button', { name: i18n.t('settings.quality.chooseMinimumWidth') }));
    await userEvent.press(screen.getByRole('button', { name: '1080 px' }));
    await waitFor(() => expect(mockCurrentSettings).toEqual({
      ...DEFAULT_SETTINGS, stylePreference: 'prefer-3d', minWidth: 1080,
    }));

    if (backKind === 'header') {
      await fireEvent(nativeScreen!, 'headerBackButtonClicked');
    } else {
      expect(hardwareBack).toEqual(expect.any(Function));
      await act(async () => { expect(hardwareBack?.()).toBe(true); });
    }
    expect(result.getPathname()).toBe('/settings');
    expect(screen.getByTestId('screen-settings')).toBe(home);
    const entry = screen.getByTestId('settings-discover-entry');
    expect(within(entry).getByText(updatedSummary)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: title + separator + updatedSummary })).toBe(entry);
    expect(screen.queryByTestId('screen-settings-discover')).toBeNull();
    expect(screen.queryByTestId('settings-style-preference')).toBeNull();
  });
});

test('two deferred preference writes publish the full summary after one Back without a home remount', async () => {
  let releaseWrites!: () => void;
  mockWritesReady = new Promise<void>((resolve) => { releaseWrites = resolve; });
  const emptyRoute = () => null;
  const result = renderRouter({
    _layout: RootLayout, '(tabs)/_layout': TabsLayout,
    '(tabs)/index': emptyRoute, '(tabs)/search': emptyRoute,
    '(tabs)/collection': emptyRoute, '(tabs)/settings': SettingsRoute,
    'settings/discover': DiscoverRoute, 'settings/reset': ResetRoute,
    'settings/cloud': emptyRoute, 'settings/sources': emptyRoute,
    'library/trash': emptyRoute, 'image/[id]': emptyRoute,
  }, { initialUrl: '/settings' });
  await result;
  const home = screen.getByTestId('screen-settings');
  const initialSummary = 'Portrait · Exclude animated · Preload 40';
  expect(within(screen.getByTestId('settings-discover-entry')).getByText(initialSummary)).toBeOnTheScreen();
  await userEvent.press(screen.getByTestId('settings-discover-entry'));
  await userEvent.press(screen.getByRole('radio', { name: '3D style preference: Prefer 2D' }));
  await userEvent.press(screen.getByRole('radio', { name: 'Image orientation: Landscape' }));
  expect(mockUpdateSettings).toHaveBeenCalledTimes(2);
  expect(mockCurrentSettings).toBe(DEFAULT_SETTINGS);
  expect(mockUpdateSettings.mock.calls.every(([update]) => typeof update === 'function')).toBe(true);
  const page = screen.getByTestId('screen-settings-discover');
  let nativeScreen = page.parent;
  while (nativeScreen && typeof nativeScreen.props.onHeaderBackButtonClicked !== 'function') nativeScreen = nativeScreen.parent;
  expect(nativeScreen).toBeTruthy();
  await fireEvent(nativeScreen!, 'headerBackButtonClicked');
  expect(result.getPathname()).toBe('/settings');
  expect(screen.getByTestId('screen-settings')).toBe(home);
  expect(within(screen.getByTestId('settings-discover-entry')).getByText(initialSummary)).toBeOnTheScreen();
  await act(async () => { releaseWrites(); });
  const summary = 'Landscape · Exclude animated · Preload 40 · Prefer 2D';
  await waitFor(() => expect(within(screen.getByTestId('settings-discover-entry')).getByText(summary)).toBeOnTheScreen());
  expect(mockCurrentSettings).toEqual({ ...DEFAULT_SETTINGS, orientation: 'landscape', stylePreference: 'prefer-2d' });
  expect(screen.getByTestId('screen-settings')).toBe(home);
  expect(screen.getByRole('button', { name: `More preferences, ${summary}` })).toBeOnTheScreen();
  expect(screen.queryByTestId('screen-settings-discover')).toBeNull();
});
