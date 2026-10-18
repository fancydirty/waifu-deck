/* eslint-disable @typescript-eslint/no-require-imports */
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, fireEvent, render, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import * as ReactNative from 'react-native';
import { Alert, Keyboard, ScrollView, Text, TextInput } from 'react-native';

import { createLibraryChangeFeed, type LibraryChangeKind } from '@/features/library/library-change-feed';
import { createProviderRequestGovernor } from '@/features/providers/provider-resilience';
import { DEFAULT_SETTINGS, normalizeSettings } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import { colors } from '@/theme/colors';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import { CloudLibraryScroll } from './cloud-library-scroll';
import i18n from '@/i18n';
import {
  providerHealthDetail,
  SettingsScreen,
  SettingsView,
  type SettingsViewProps,
} from '@/screens/settings/settings-screen';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { WebdavConnectForm } from '@/screens/settings/webdav-connect-form';
import { KEYBOARD_REVEAL_GAP, scrollOffsetToReveal } from '@/screens/settings/keyboard-reveal';
import type { DeleteAllAppDataResult } from '@/providers/app-services';

import { ResetSettingsScreen } from './reset-settings-screen';
import { AppUpdateProvider } from '@/features/update/app-update-context';
import type { AppUpdateService, AppUpdateSnapshot } from '@/features/update/app-update-service';

type ResetServices = {
  resetDismissedHistory(): Promise<number>;
  resetDiscoveryHistory(): Promise<number>;
  deleteAllAppData(): Promise<DeleteAllAppDataResult>;
  cloudBound?: boolean;
};
function renderReset(overrides: Partial<ResetServices> = {}, client = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
})) {
  mockAppServices = {
    resetDismissedHistory: jest.fn(async () => 0),
    resetDiscoveryHistory: jest.fn(async () => 0),
    deleteAllAppData: jest.fn(async () => deleteAllResult()),
    ...overrides,
    byosStatus: { status: overrides.cloudBound ? 'locked' : 'unconfigured' },
  };
  return render(<QueryClientProvider client={client}><ResetSettingsScreen /></QueryClientProvider>);
}

jest.mock('./cloud-library-context', () => ({
  useCloudLibraryModel: () => require('@/test/cloud-library-fixtures').cloudSnapshot({ status: 'unconfigured' }),
}));

const mockTagFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockTagFetch(...args) }));

let mockAppServices: any;
let mockSlotProps: Record<string, unknown> | null = null;
let mockSafeAreaBottomInset = 0;
const providerRequestGovernor = createProviderRequestGovernor();
const providerHealth = providerRequestGovernor.getSnapshot();

type ImeHeightEvent = { height: number; visible: boolean };
const mockImeHeightSink: {
  listener: ((event: ImeHeightEvent) => void) | null;
  remove: jest.Mock;
} = {
  listener: null,
  remove: jest.fn(),
};

jest.mock('../../../modules/waifu-sync-service', () => ({
  get WaifuSyncService() {
    return null;
  },
  addImeHeightListener(listener: (event: ImeHeightEvent) => void) {
    mockImeHeightSink.listener = listener;
    return { remove: () => mockImeHeightSink.remove() };
  },
}));

beforeEach(async () => {
  mockTagFetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => [
    { value: 'fur', post_count: 5579 }, { value: 'fur_trim', post_count: 237991 },
    { value: 'furry', post_count: 146890 }, { value: 'fur-trimmed_jacket', post_count: 40336 },
  ] });
  mockSlotProps = null;
  mockSafeAreaBottomInset = 0;
  mockPush.mockClear();
  mockFocus.effect = null;
  mockFocus.cleanup = undefined;
  mockImeHeightSink.listener = null;
  mockImeHeightSink.remove.mockClear();
  await i18n.changeLanguage('zh-Hans');
});

jest.mock('@/providers/app-services', () => ({
  useAppServices: () => mockAppServices,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: mockSafeAreaBottomInset, left: 0, right: 0 }),
}));

type MockFocusEffect = () => void | (() => void);
const mockFocus: { effect: MockFocusEffect | null; cleanup: ReturnType<MockFocusEffect> } = { effect: null, cleanup: undefined };
const focusSettings = () => { mockFocus.cleanup = mockFocus.effect?.(); };
const blurSettings = () => { if (typeof mockFocus.cleanup === 'function') mockFocus.cleanup(); mockFocus.cleanup = undefined; };

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: MockFocusEffect) => { mockFocus.effect = effect; },
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));

jest.mock('@/screens/settings/library-cloud-slot', () => ({
  LibraryCloudSlot: () => null,
}));

jest.mock('@/screens/settings/byos-settings-slot', () => {
  const ReactModule = require('react') as typeof React;
  const { Text } = require('react-native') as typeof import('react-native');
  return {
    ByosSettingsSlot: (slotProps: Record<string, unknown>) => {
      mockSlotProps = slotProps;
      return ReactModule.createElement(
        Text,
        { testID: 'byos-settings-slot' },
        'byos',
      );
    },
  };
});

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    Archive: Icon,
    ArchiveRestore: Icon,
    Check: Icon,
    Cloud: Icon,
    Lock: Icon,
    Server: Icon,
    Ban: Icon,
    Plus: Icon,
    ChevronRight: Icon,
    Database: Icon,
    ExternalLink: Icon,
    Filter: Icon,
    HardDrive: Icon,
    Info: Icon,
    Languages: Icon,
    RotateCcw: Icon,
    Search: Icon,
    Trash2: Icon,
    X: Icon,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function deleteAllResult(): DeleteAllAppDataResult {
  return {
    ok: true,
    files: { deleted: [], failed: [] },
    database: { status: 'deleted', deletedRows: 0, error: null },
    settings: { status: 'deleted', error: null },
    library: { status: 'deleted', cloud: 'skipped', disconnected: false, error: null },
    remaining: [],
    recomposed: false,
  };
}

function createStatefulSettingsUpdater(initial: AppSettings = DEFAULT_SETTINGS) {
  let current = initial;
  let tail = Promise.resolve();
  const updateSettings = jest.fn((update: unknown) => {
    const operation = tail.then(() => {
      const resolved = typeof update === 'function'
        ? (update as (settings: AppSettings) => unknown)(current)
        : update;
      current = { ...current, ...(resolved as Partial<AppSettings>) };
      return current;
    });
    tail = operation.then(() => undefined);
    return operation;
  });
  return {
    getCurrent: () => current,
    updateSettings,
  };
}

function createFirstFailureSettingsUpdater(initial: AppSettings = DEFAULT_SETTINGS) {
  const firstAttempt = deferred<void>();
  const published: AppSettings[] = [];
  let current = initial;
  let call = 0;
  let tail = Promise.resolve();
  const updateSettings = jest.fn((update: unknown) => {
    call += 1;
    const queuedCall = call;
    const operation = tail.then(async () => {
      const resolved = typeof update === 'function'
        ? (update as (settings: AppSettings) => unknown)(current)
        : update;
      const candidate = normalizeSettings(resolved);
      if (queuedCall === 1) {
        await firstAttempt.promise;
        throw new Error('first write failed');
      }
      current = candidate;
      published.push(candidate);
      return candidate;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  });
  return {
    firstAttempt,
    getCurrent: () => current,
    getPublished: () => published,
    updateSettings,
  };
}

function props(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  return {
    settings: DEFAULT_SETTINGS,
    previewCacheBytes: 1_500_000,
    collectionBytes: 3_000_000,
    appVersion: '1.0.0',
    updateSettings: createStatefulSettingsUpdater().updateSettings,
    clearPreviewCache: jest.fn(async () => undefined),
    createFullBackup: jest.fn(async () => ({
      formatVersion: 1,
      applicationId: 'app.waifudeck.mobile',
      appVersion: '1.1.0',
      createdAt: 123,
      imageCount: 4,
      fileCount: 3,
      totalFileBytes: 3_000_000,
      missingFileCount: 1,
      cloudOnlyCount: 0,
    })),
    restoreFullBackup: jest.fn(async () => null),
    ...overrides,
  };
}

const summaryLocales = [
  {
    language: 'zh-Hans', title: '更多偏好', separator: '，',
    defaults: '纵向 · 排除动图 · 预加载 40',
    nonDefaults: '横向 · 仅动图 · 预加载 60 · 偏好 3D · 宽度 ≥ 1080 px · 文件 ≤ 5 MB',
    anyInclude: '方向不限 · 包含动图 · 预加载 30 · 偏好 2D · 宽度 ≥ 720 px · 文件 ≤ 2 MB',
  },
  {
    language: 'zh-Hant', title: '更多偏好', separator: '，',
    defaults: '直向 · 排除動圖 · 預先載入 40',
    nonDefaults: '橫向 · 僅動圖 · 預先載入 60 · 偏好 3D · 寬度 ≥ 1080 px · 檔案 ≤ 5 MB',
    anyInclude: '方向不限 · 包含動圖 · 預先載入 30 · 偏好 2D · 寬度 ≥ 720 px · 檔案 ≤ 2 MB',
  },
  {
    language: 'ja', title: 'その他の設定', separator: '：',
    defaults: '縦向き · アニメーションを除外 · 先読み 40',
    nonDefaults: '横向き · アニメーションのみ · 先読み 60 · 3Dを優先 · 幅 ≥ 1080 px · ファイル ≤ 5 MB',
    anyInclude: '方向指定なし · アニメーションを含む · 先読み 30 · 2Dを優先 · 幅 ≥ 720 px · ファイル ≤ 2 MB',
  },
  {
    language: 'en', title: 'More preferences', separator: ', ',
    defaults: 'Portrait · Exclude animated · Preload 40',
    nonDefaults: 'Landscape · Animated only · Preload 60 · Prefer 3D · Width ≥ 1080 px · File ≤ 5 MB',
    anyInclude: 'Any orientation · Include animated · Preload 30 · Prefer 2D · Width ≥ 720 px · File ≤ 2 MB',
  },
] as const;

describe.each(summaryLocales)('$language Discover home summary', (locale) => {
  test.each(['defaults', 'nonDefaults', 'anyInclude'] as const)(
    '%s renders exact translated detail and complete accessible name', async (variant) => {
      await i18n.changeLanguage(locale.language);
      const settings: AppSettings = variant === 'defaults' ? DEFAULT_SETTINGS : variant === 'nonDefaults' ? {
        ...DEFAULT_SETTINGS, orientation: 'landscape', animationMode: 'only', prefetchDepth: 60,
        stylePreference: 'prefer-3d', minWidth: 1080, maxBytes: 5_000_000,
      } : {
        ...DEFAULT_SETTINGS, orientation: 'any', animationMode: 'include', prefetchDepth: 30,
        stylePreference: 'prefer-2d', minWidth: 720, maxBytes: 2_000_000,
      };
      await render(<SettingsView {...props({ settings })} />);
      const row = screen.getByTestId('settings-discover-entry');
      const detail = within(row).getByText(locale[variant]);
      expect(detail).toHaveProp('numberOfLines', 1);
      expect(detail).toHaveProp('ellipsizeMode', 'tail');
      // Detail is below the label in the same left-hand column, not a value
      // sibling in the row's right-hand column.
      const label = within(row).getByText(locale.title);
      expect(detail.parent).toBe(label.parent);
      expect(label.parent!.children).toEqual([label, detail]);
      const name = locale.title + locale.separator + locale[variant];
      expect(row).toHaveProp('accessibilityLabel', name);
      expect(screen.getByRole('button', { name })).toBe(row);
      expect(within(row).queryByText(/settings\./)).toBeNull();
    },
  );
});

const homeLocales = [
  ['en', 'Settings', 'Discover', 'This phone', 'General'],
  ['ja', '設定', '見つける', 'このスマートフォン', '一般'],
  ['zh-Hans', '设置', '发现', '这台手机', '通用'],
  ['zh-Hant', '設定', '探索', '這台手機', '一般'],
] as const;

describe.each(homeLocales)('%s U1b home assembly', (language, title, discover, phone, general) => {
  test.each([
    ['light', true], ['light', false], ['dark', true], ['dark', false],
  ] as const)('host preorder, unique IDs and exact home geometry (%s, adult=%s)', async (scheme, allowsAdultContent) => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    await i18n.changeLanguage(language);
    await render(<SettingsView {...props({ allowsAdultContent })} />);
    const theme = colors[scheme];
    const root = screen.getByTestId('screen-settings');
    expect(root).toHaveStyle({ flex: 1, backgroundColor: theme.surface });
    const scroll = screen.getByTestId('settings-scroll');
    const pageTitle = screen.getByTestId('settings-title');
    const card = screen.getByTestId('settings-cloud-card');
    const version = screen.getByTestId('settings-version');
    expect(pageTitle).toHaveTextContent(title, { exact: true });
    expect(pageTitle).toHaveStyle({ ...settingsTypography.pageTitle, color: theme.text,
      marginHorizontal: 18, marginTop: 18, marginBottom: 14 });
    expect(card).toHaveStyle({ marginHorizontal: 14 });
    const cardStyle = ReactNative.StyleSheet.flatten(card.props.style);
    for (const key of ['margin', 'marginTop', 'marginBottom', 'marginVertical']) expect(cardStyle[key]).toBeUndefined();
    const headings = [discover, phone, general].map((text) => screen.getByText(text));
    for (const heading of headings) {
      expect(heading).toHaveStyle({ ...settingsTypography.groupLabel, color: theme.textSecondary,
        paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 });
    }
    const ids = ['settings-title', 'settings-cloud-card', 'settings-sources-entry',
      ...(allowsAdultContent ? ['settings-adult-content-mode', 'settings-blur-nsfw'] : []),
      'settings-exclude-tags', 'settings-discover-entry', 'storage-panel', 'settings-backup-export',
      ...(allowsAdultContent ? ['backup-restore'] : []), 'settings-language', 'settings-reset-entry', 'settings-version'];
    const markers = new Map(ids.map((id) => [screen.getByTestId(id), id]));
    headings.forEach((node, index) => markers.set(node, ['discover-heading', 'phone-heading', 'general-heading'][index]!));
    const actual = scroll.queryAll((node) => typeof node.type === 'string' && markers.has(node)).map((node) => markers.get(node));
    expect(actual).toEqual(['settings-title', 'settings-cloud-card', 'discover-heading', 'settings-sources-entry',
      ...(allowsAdultContent ? ['settings-adult-content-mode', 'settings-blur-nsfw'] : []),
      'settings-exclude-tags', 'settings-discover-entry', 'phone-heading', 'storage-panel', 'settings-backup-export',
      ...(allowsAdultContent ? ['backup-restore'] : []), 'general-heading', 'settings-language', 'settings-reset-entry', 'settings-version']);
    const hosts = root.queryAll((node) => typeof node.type === 'string');
    const allIds = hosts.map((node) => node.props.testID).filter((id) => typeof id === 'string');
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const id of ['settings-style-preference', 'image-orientation', 'animation', 'settings-min-width',
      'settings-max-bytes', 'settings-prefetch-depth', 'settings-delete-all', 'settings-delete-all-input',
      'settings-delete-all-confirm', 'library-import', 'library-settings-section', 'byos-section']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(allIds.filter((id) => /^(?:provider-|library-import|settings-delete-all)/.test(id))).toEqual([]);
    expect(screen.queryByRole('button', { name: i18n.t('collection.import.entry') })).toBeNull();
    if (!allowsAdultContent) {
      for (const id of ['settings-adult-content-mode', 'settings-blur-nsfw', 'backup-restore']) expect(screen.queryByTestId(id)).toBeNull();
    }
    const sources = screen.getByTestId('settings-sources-entry');
    const languageRow = screen.getByTestId('settings-language');
    const panel = screen.getByTestId('storage-panel');
    const groups = [sources.parent!.parent!, panel.parent!.parent!.parent!, languageRow.parent!.parent!];
    for (const group of groups) {
      expect(group).toHaveStyle({ marginHorizontal: 14, borderRadius: 14, borderWidth: 1,
        borderColor: theme.border, backgroundColor: theme.surfaceSecondary, overflow: 'hidden' });
    }
    expect(panel.parent).toHaveStyle({ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 });
    expect(panel.parent!.children).toEqual([panel]);
    const content = scroll.children[0];
    if (typeof content !== 'object') throw new Error('Settings scroll has no host content');
    expect(content.children).toEqual([pageTitle, card, headings[0], groups[0], headings[1], groups[1], headings[2], groups[2], version]);
    expect(version).toHaveTextContent(`${i18n.t('settings.footer.version')} · 1.0.0`, { exact: true });
    expect(version).toHaveStyle({ ...settingsTypography.footer, color: theme.textSecondary,
      textAlign: 'center', marginTop: 22, marginBottom: 4 });
    for (const id of ['settings-sources-entry', 'settings-exclude-tags', 'settings-discover-entry',
      'settings-backup-export', 'settings-language', 'settings-reset-entry', ...(allowsAdultContent ? ['backup-restore', 'settings-blur-nsfw'] : [])]) {
      const row = screen.getByTestId(id);
      expect(row).toHaveStyle({ minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, gap: 12 });
      expect(row.children[0]).toHaveStyle({ flex: 1, minWidth: 0 });
    }
    for (const row of [sources, languageRow, screen.getByTestId('settings-exclude-tags')]) {
      const value = row.children[1];
      if (typeof value !== 'object') throw new Error('Settings row has no value host');
      expect(value).toHaveStyle({ maxWidth: '58%' });
      expect(value.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
    }
  });
});

describe('settings screen content filters', () => {
  test('R8.21: the settings list clears the top safe area instead of hiding under the status bar', async () => {
    await render(<SettingsView {...props({ safeAreaTop: 47 })} />);
    expect(screen.getByTestId('settings-scroll').props.contentContainerStyle)
      .toMatchObject({ paddingTop: 47 });
  });

  test('renders the settings surface in English', async () => {
    await i18n.changeLanguage('en');
    await render(<SettingsView {...props()} />);

    expect(screen.getByTestId('screen-settings')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-language')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-discover-entry')).toBeOnTheScreen();
    expect(screen.getByText('Image sources')).toBeOnTheScreen();
    expect(screen.getByText('Discover')).toBeOnTheScreen();
    expect(screen.getByText('This phone')).toBeOnTheScreen();
    expect(screen.getByText('General')).toBeOnTheScreen();
    expect(screen.queryByText('Content & quality')).toBeNull();
    expect(screen.queryByTestId('settings-style-preference')).toBeNull();
    expect(screen.queryByTestId('image-orientation')).toBeNull();
    expect(screen.queryByTestId('animation')).toBeNull();
    expect(screen.queryByTestId('settings-min-width')).toBeNull();
    expect(screen.queryByTestId('settings-max-bytes')).toBeNull();
    expect(screen.queryByTestId('settings-prefetch-depth')).toBeNull();
    expect(screen.queryByRole('radio', { name: '3D style preference: Prefer 3D' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose app language' })).toBeOnTheScreen();
  });

  test('the home page shows one image-sources entry row with the enabled count and no inline toggles', async () => {
    await i18n.changeLanguage('en');
    await render(<SettingsView {...props()} />);
    expect(screen.getByTestId('settings-sources-entry')).toBeOnTheScreen();
    // DEFAULT_SETTINGS enables 8 sources (gelbooru + rule34 default off) of 10.
    expect(screen.getByText('8 / 10 enabled')).toBeOnTheScreen();
    expect(screen.queryByTestId('provider-waifu-toggle')).toBeNull();
  });

  test('exposes the stable full-backup restore id for upgrade automation', async () => {
    await i18n.changeLanguage('en');
    await render(<SettingsView {...props()} />);

    expect(screen.getByTestId('backup-restore')).toBeOnTheScreen();
  });

  test('does not expose adult content controls in the Store distribution', async () => {
    await i18n.changeLanguage('en');
    await render(<SettingsView {...props({ allowsAdultContent: false })} />);

    expect(screen.queryByLabelText('NSFW content mode')).not.toBeOnTheScreen();
    expect(screen.queryByRole('switch', {
      name: 'Blur NSFW thumbnails',
    })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', {
      name: 'Restore from full backup',
    })).not.toBeOnTheScreen();
    expect(screen.getByTestId('settings-discover-entry')).toBeOnTheScreen();
  });

  test.each([true, false])('keeps the blur row ID only when allowsAdultContent is %s', async (allowsAdultContent) => {
    await render(<SettingsView {...props({ allowsAdultContent })} />);

    if (allowsAdultContent) {
      const row = screen.getByTestId('settings-blur-nsfw');
      expect(row).toBeOnTheScreen();
      expect(within(row).getByRole('switch', { name: '模糊 NSFW 缩略图' })).toBeChecked();
    } else {
      expect(screen.queryByTestId('settings-blur-nsfw')).toBeNull();
    }
  });

  test.each([true, false])('keeps the exclude-tags ID on its home row when allowsAdultContent is %s', async (allowsAdultContent) => {
    await render(<SettingsView {...props({ allowsAdultContent })} />);

    const row = screen.getByTestId('settings-exclude-tags');
    expect(row).toBeOnTheScreen();
    expect(row).toBe(screen.getByRole('button', { name: '编辑排除标签' }));
  });

  test.each(['light', 'dark'] as const)('the Discover entry label uses neutral text in the %s theme', async (scheme) => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    await render(<SettingsView {...props()} />);

    const label = within(screen.getByTestId('settings-discover-entry')).getByText('更多偏好');
    expect(label).toHaveStyle({ color: colors[scheme].text });
    expect(label).not.toHaveStyle({ color: colors[scheme].danger });
  });

  test.each([
    ['light', true], ['light', false], ['dark', true], ['dark', false],
  ] as const)('reset home entry is neutral and no destructive rows or dialogs remain (%s, adult=%s)', async (scheme, allowsAdultContent) => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    await render(<SettingsView {...props({ allowsAdultContent })} />);
    const entry = screen.getByTestId('settings-reset-entry');
    expect(entry).toBe(screen.getByRole('button', { name: '重置与删除' }));
    expect(within(entry).getByText('重置与删除')).toHaveStyle({ color: colors[scheme].text });
    // An icon adds a leading fixed-width View; this row starts with its text.
    expect(entry.children[0]).toHaveStyle({ flex: 1, minWidth: 0 });
    for (const label of ['重置已忽略记录', '重置发现记录', '删除全部应用数据']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    for (const id of ['settings-delete-all', 'settings-delete-all-input', 'settings-delete-all-confirm']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.container.queryAll((node) => node.props.color === colors[scheme].danger)).toHaveLength(0);
  });

  test('reset entry blocks navigation during pending backup export and enables navigation after completion', async () => {
    const backup = await props().createFullBackup();
    const heldExport = deferred<Awaited<ReturnType<SettingsViewProps['createFullBackup']>>>();
    const createFullBackup = jest.fn(() => heldExport.promise);
    await render(<SettingsView {...props({ createFullBackup })} />);
    expect(screen.getByTestId('settings-reset-entry')).toBeEnabled();

    await userEvent.press(screen.getByRole('button', { name: '导出完整备份' }));
    await waitFor(() => expect(createFullBackup).toHaveBeenCalledTimes(1));
    try {
      const entry = screen.getByTestId('settings-reset-entry');
      expect(entry).toBeDisabled();
      await userEvent.press(entry);
      expect(mockPush).not.toHaveBeenCalled();
      expect(screen.getByTestId('settings-discover-entry')).toBeEnabled();
      expect(screen.getByTestId('settings-sources-entry')).toBeEnabled();
    } finally {
      await act(async () => { heldExport.resolve(backup); });
    }

    await waitFor(() => expect(screen.getByTestId('settings-reset-entry')).toBeEnabled());
    await userEvent.press(screen.getByTestId('settings-reset-entry'));
    expect(mockPush.mock.calls).toEqual([['/settings/reset']]);
  });

  test('persists an explicit app language choice', async () => {
    const stateful = createStatefulSettingsUpdater();
    await render(<SettingsView {...props({ updateSettings: stateful.updateSettings })} />);

    await userEvent.press(screen.getByRole('button', { name: '选择应用语言' }));
    await userEvent.press(screen.getByRole('button', { name: 'English' }));

    await waitFor(() => expect(stateful.getCurrent().language).toBe('en'));
  });

  test('providerHealthDetail appends an availability note without hiding the health status', () => {
    expect(providerHealthDetail(
      '高清动漫壁纸与插画',
      true,
      providerHealth.konachan,
      i18n.t,
      'Konachan 没有竖屏图片。把方向改为横屏或任意即可看到它。',
    )).toBe('高清动漫壁纸与插画 · 本次尚未取图\nKonachan 没有竖屏图片。把方向改为横屏或任意即可看到它。');
    // The note appends even when the toggle itself is off — never silent.
    expect(providerHealthDetail(
      '高清动漫壁纸与插画',
      false,
      providerHealth.konachan,
      i18n.t,
      'Konachan 没有竖屏图片。把方向改为横屏或任意即可看到它。',
    )).toBe('高清动漫壁纸与插画 · 已关闭\nKonachan 没有竖屏图片。把方向改为横屏或任意即可看到它。');
    // No note when omitted — unchanged legacy behaviour.
    expect(providerHealthDetail(
      '高清动漫壁纸与插画',
      true,
      providerHealth.konachan,
    )).toBe('高清动漫壁纸与插画 · 本次尚未取图');
  });

  test('a rejected key reads as 密钥被拒绝', () => {
    expect(providerHealthDetail(
      '大型标签图库，需要你的免费 API 密钥',
      true,
      { ...providerHealth.gelbooru, status: 'degraded', lastErrorCode: 'auth' },
      i18n.t,
    )).toBe('大型标签图库，需要你的免费 API 密钥 · 密钥被拒绝，请检查后重新保存');
  });

  test('the Settings ScrollView keeps taps while a field has focus', async () => {
    await render(<SettingsView {...props()} />);
    expect(screen.getByTestId('settings-scroll').props.keyboardShouldPersistTaps)
      .toBe('handled');
  });

  test.each([true, false])('blur switch persists the chosen value and shows it after saving (initial=%s)', async (initial) => {
    const stateful = createStatefulSettingsUpdater({ ...DEFAULT_SETTINGS, blurNsfwThumbnails: initial });
    const view = await render(<SettingsView {...props({
      settings: stateful.getCurrent(), updateSettings: stateful.updateSettings,
    })} />);
    const toggle = screen.getByRole('switch', { name: '模糊 NSFW 缩略图' });
    expect(toggle).toHaveProp('accessibilityState', expect.objectContaining({ checked: initial }));
    await userEvent.press(toggle);
    await waitFor(() => expect(stateful.getCurrent().blurNsfwThumbnails).toBe(!initial));
    expect(stateful.updateSettings).toHaveBeenCalledTimes(1);
    expect(stateful.updateSettings.mock.calls[0]![0]).toEqual(expect.any(Function));
    await waitFor(() => expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).toBeEnabled());
    await view.rerender(<SettingsView {...props({
      settings: stateful.getCurrent(), updateSettings: stateful.updateSettings,
    })} />);
    expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).toHaveProp(
      'accessibilityState', expect.objectContaining({ checked: !initial }),
    );
  });

  test.each([true, false])('adult block has a visible host title before the segmented control only when allowed (adult=%s)', async (allowsAdultContent) => {
    await render(<SettingsView {...props({ allowsAdultContent })} />);
    const titles = screen.getByTestId('screen-settings').queryAll((node) => node.type === 'Text'
      && node.children.length === 1 && node.children[0] === 'NSFW 内容模式');
    expect(titles).toHaveLength(allowsAdultContent ? 1 : 0);
    if (allowsAdultContent) {
      const control = screen.getByTestId('settings-adult-content-mode');
      expect(titles[0]!.parent === control.parent).toBe(true);
      expect(control.parent!.children[0] === titles[0]).toBe(true);
      expect(control.parent!.children[1] === control).toBe(true);
    } else {
      expect(screen.queryByTestId('settings-adult-content-mode')).toBeNull();
    }
  });

  test('rolls an optimistic switch back once when persistence fails', async () => {
    const heldSave = deferred<AppSettings>();
    const updateSettings = jest.fn(() => heldSave.promise);
    await render(<SettingsView {...props({ updateSettings })} />);

    await userEvent.press(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' }));
    expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).toHaveStyle({ opacity: 1 });
    await userEvent.press(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' }));
    expect(updateSettings).toHaveBeenCalledTimes(1);

    await act(async () => heldSave.reject(new Error('save failed')));

    expect(await screen.findByText('设置暂时无法保存，请重试。')).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '模糊 NSFW 缩略图' })).toBeEnabled();
  });

  test('gives the home adult segmented control stable 48dp interaction geometry', async () => {
    await render(<SettingsView {...props()} />);

    const track = screen.getByTestId('settings-adult-content-mode');
    expect(track).toHaveStyle({ padding: 3, gap: 2, borderRadius: metrics.settingsRadius.track });
    expect(track.props.hitSlop).toBeUndefined();
    for (const radio of within(track).getAllByRole('radio')) {
      expect(radio).toHaveStyle({ flex: 1, marginVertical: -9, paddingVertical: 9 });
      expect(radio.props.hitSlop).toBeUndefined();
      expect(radio.children[0]).toHaveStyle({ minHeight: 30, paddingVertical: 6, paddingHorizontal: 4,
        borderRadius: metrics.settingsRadius.segment });
    }
  });

  test('defaults to SFW and canceling the first adult confirmation preserves it', async () => {
    const updateSettings = jest.fn(async (value: unknown) => value as AppSettings);

    await render(<SettingsView {...props({ updateSettings })} />);

    expect(screen.getByRole('radio', { name: 'NSFW 内容模式：仅 SFW' }).props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));
    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));
    expect(screen.getByText('仅限 18 岁以上')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: '取消成人内容' }));

    expect(updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'NSFW 内容模式：仅 SFW' }).props.accessibilityState)
      .toEqual(expect.objectContaining({ selected: true }));
  });

  test('confirmation persists adult consent and later NSFW changes skip it', async () => {
    const stateful = createStatefulSettingsUpdater();
    const view = await render(<SettingsView {...props({ updateSettings: stateful.updateSettings })} />);

    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：仅 NSFW' }));
    await userEvent.press(screen.getByRole('button', { name: '确认已满 18 岁' }));

    await waitFor(() => expect(stateful.getCurrent()).toEqual(expect.objectContaining({
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
    })));

    const confirmed = {
      ...DEFAULT_SETTINGS,
      nsfwMode: 'nsfw' as const,
      nsfwConfirmed: true,
    };
    await view.rerender(<SettingsView {...props({
      settings: confirmed,
      updateSettings: stateful.updateSettings,
    })} />);
    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));

    await waitFor(() => expect(stateful.getCurrent()).toEqual(expect.objectContaining({
      nsfwMode: 'mixed',
      nsfwConfirmed: true,
    })));
    expect(screen.queryByText('仅限 18 岁以上')).not.toBeOnTheScreen();
  });

  test('uses a local adult grant while consent persistence is still pending', async () => {
    const heldConsent = deferred<AppSettings>();
    const updateSettings = jest
      .fn<Promise<AppSettings>, [unknown]>()
      .mockImplementationOnce(() => heldConsent.promise)
      .mockResolvedValue({
        ...DEFAULT_SETTINGS,
        nsfwMode: 'nsfw',
        nsfwConfirmed: true,
      });
    await render(<SettingsView {...props({ updateSettings })} />);

    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));
    await userEvent.press(screen.getByRole('button', { name: '确认已满 18 岁' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：仅 NSFW' }));

    expect(screen.queryByText('仅限 18 岁以上')).not.toBeOnTheScreen();
    expect(updateSettings).toHaveBeenCalledTimes(2);

    await act(async () => heldConsent.resolve({
      ...DEFAULT_SETTINGS,
      nsfwMode: 'mixed',
      nsfwConfirmed: true,
    }));
  });

  test('rolls back a local adult grant when consent persistence fails', async () => {
    const heldConsent = deferred<AppSettings>();
    const updateSettings = jest
      .fn<Promise<AppSettings>, [unknown]>()
      .mockImplementationOnce(() => heldConsent.promise)
      .mockResolvedValue({
        ...DEFAULT_SETTINGS,
        nsfwMode: 'nsfw',
      });
    await render(<SettingsView {...props({ updateSettings })} />);

    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));
    await userEvent.press(screen.getByRole('button', { name: '确认已满 18 岁' }));
    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：仅 NSFW' }));
    expect(screen.queryByText('仅限 18 岁以上')).not.toBeOnTheScreen();

    await act(async () => heldConsent.reject(new Error('save failed')));
    expect(await screen.findByText('设置暂时无法保存，请重试。')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));

    expect(screen.getByText('仅限 18 岁以上')).toBeOnTheScreen();
  });

  test('preserves explicit consent when a queued adult transition outlives the failed consent write', async () => {
    const queued = createFirstFailureSettingsUpdater();
    await render(<SettingsView {...props({ updateSettings: queued.updateSettings })} />);

    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));
    await userEvent.press(screen.getByRole('button', { name: '确认已满 18 岁' }));
    await waitFor(() => expect(queued.updateSettings).toHaveBeenCalledTimes(1));
    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：仅 NSFW' }));

    expect(screen.queryByText('仅限 18 岁以上')).not.toBeOnTheScreen();
    expect(queued.updateSettings).toHaveBeenCalledTimes(2);
    await act(async () => queued.firstAttempt.resolve());

    await waitFor(() => expect(queued.getCurrent()).toEqual(expect.objectContaining({
      nsfwMode: 'nsfw',
      nsfwConfirmed: true,
    })));
    expect(queued.getPublished()).toEqual([
      expect.objectContaining({ nsfwMode: 'nsfw', nsfwConfirmed: true }),
    ]);
    expect(queued.getPublished()).not.toContainEqual(
      expect.objectContaining({ nsfwMode: 'nsfw', nsfwConfirmed: false }),
    );
  });

  test('R8.22: the include-tags row is gone and the exclude row opens the exclude-only picker', async () => {
    const stateful = createStatefulSettingsUpdater();
    const view = await render(
      <SettingsView {...props({ updateSettings: stateful.updateSettings })} />,
    );

    // Owner 2026-09-09: 「包含标签」 is removed as a user-facing feature.
    expect(screen.queryByRole('button', { name: '编辑包含标签' })).not.toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: '编辑排除标签' }));
    expect(screen.queryByRole('checkbox', { name: 'Waifu' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '选择包含标签' })).not.toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), 'maid');
    await userEvent.press(screen.getByRole('button', { name: '直接排除「maid」' }));

    // Blocking persists to excludedTags; the internal includedTags default
    // stays exactly ['waifu'] (waifu.im requires a base tag).
    await waitFor(() => expect(stateful.getCurrent()).toEqual(expect.objectContaining({
      includedTags: ['waifu'],
      excludedTags: ['maid'],
    })));

    await view.rerender(<SettingsView {...props({
      settings: { ...DEFAULT_SETTINGS, excludedTags: ['maid'] },
      updateSettings: stateful.updateSettings,
    })} />);
    expect(screen.queryByRole('button', { name: '直接排除「maid」' })).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '取消屏蔽 maid' })).toBeOnTheScreen();
  });

  test('combines rapid consent and tag toggles without awaiting persistence or rerendering', async () => {
    const stateful = createStatefulSettingsUpdater();
    await render(<SettingsView {...props({ updateSettings: stateful.updateSettings })} />);

    await userEvent.press(screen.getByRole('radio', { name: 'NSFW 内容模式：混合' }));
    await userEvent.press(await screen.findByRole('button', { name: '确认已满 18 岁' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '确认已满 18 岁' })).not.toBeOnTheScreen();
    });
    await userEvent.press(screen.getByRole('button', { name: '编辑排除标签' }));
    await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), 'maid');
    await userEvent.press(screen.getByRole('button', { name: '直接排除「maid」' }));
    await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), 'uniform');
    await userEvent.press(screen.getByRole('button', { name: '直接排除「uniform」' }));

    await waitFor(() => expect(stateful.updateSettings).toHaveBeenCalledTimes(3));
    expect(stateful.getCurrent()).toEqual(expect.objectContaining({
      nsfwMode: 'mixed',
      nsfwConfirmed: true,
      includedTags: ['waifu'],
      excludedTags: ['maid', 'uniform'],
    }));
  });
});

describe('settings screen storage and data controls', () => {
  test('keeps a supported storage metric when the other platform metric rejects', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    mockAppServices = {
      settings: DEFAULT_SETTINGS,
      dataRevision: 0,
      updateSettings: createStatefulSettingsUpdater().updateSettings,
      managedPreviewCache: {
        getBytes: jest.fn().mockResolvedValue(1_500),
        clear: jest.fn().mockResolvedValue(undefined),
      },
      collectionService: {
        getCollectionBytes: jest.fn().mockRejectedValue(new Error('unsupported')),
      },
      byosStatus: { status: 'unconfigured' },
      resetDismissedHistory: jest.fn().mockResolvedValue(0),
      resetDiscoveryHistory: jest.fn().mockResolvedValue(0),
      deleteAllAppData: jest.fn().mockResolvedValue(deleteAllResult()),
      providerRequestGovernor,
      providerCredentials: {
        snapshot: () => ({}),
        save: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      },
    };

    await render(
      <QueryClientProvider client={client}>
        <SettingsScreen />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('预览缓存 1.5 KB')).toBeOnTheScreen();
    expect(screen.getByTestId('storage-total')).toHaveTextContent('不可用', { exact: true });
    expect(screen.getByTestId('storage-collection-size')).toHaveTextContent('收藏 不可用', { exact: true });
    expect(screen.queryByText('正在计算')).not.toBeOnTheScreen();
  });

  test('backup rows stay disabled and dimmed during a held preview-cache clear', async () => {
    const heldClear = deferred<void>();
    const clearPreviewCache = jest.fn(() => heldClear.promise);
    const createFullBackup = jest.fn(props().createFullBackup);
    await render(<SettingsView {...props({ clearPreviewCache, createFullBackup })} />);
    expect(screen.getByTestId('settings-backup-export')).toBeEnabled();
    expect(screen.getByTestId('backup-restore')).toBeEnabled();
    await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
    expect(clearPreviewCache).toHaveBeenCalledTimes(1);
    try {
      const exportRow = screen.getByTestId('settings-backup-export');
      const restoreRow = screen.getByTestId('backup-restore');
      expect(exportRow).toBeDisabled();
      expect(exportRow).toHaveStyle({ opacity: 0.38 });
      expect(restoreRow).toBeDisabled();
      expect(restoreRow).toHaveStyle({ opacity: 0.38 });
      await userEvent.press(exportRow);
      await userEvent.press(restoreRow);
      expect(createFullBackup).not.toHaveBeenCalled();
      expect(screen.queryByText(i18n.t('settings.backup.restoreTitle'))).toBeNull();
      expect(screen.queryByRole('button', { name: i18n.t('settings.backup.restoreConfirm') })).toBeNull();
    } finally {
      await act(async () => heldClear.resolve());
    }
    expect(screen.getByTestId('settings-backup-export')).toBeEnabled();
    expect(screen.getByTestId('settings-backup-export')).toHaveStyle({ opacity: 1 });
    expect(screen.getByTestId('backup-restore')).toBeEnabled();
    expect(screen.getByTestId('backup-restore')).toHaveStyle({ opacity: 1 });
    await userEvent.press(screen.getByTestId('settings-backup-export'));
    await waitFor(() => expect(createFullBackup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('backup-restore')).toBeEnabled());
    await userEvent.press(screen.getByTestId('backup-restore'));
    expect(screen.getByRole('button', { name: i18n.t('settings.backup.restoreConfirm') })).toBeOnTheScreen();
  });

  test('clear button host dims only while a preview-cache clear is pending', async () => {
    const heldClear = deferred<void>();
    const clearPreviewCache = jest.fn(() => heldClear.promise);
    await render(<SettingsView {...props({ clearPreviewCache })} />);
    expect(screen.getByTestId('storage-clear-preview-cache')).toHaveStyle({ opacity: 1 });
    await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
    expect(clearPreviewCache).toHaveBeenCalledTimes(1);
    try {
      const button = screen.getByTestId('storage-clear-preview-cache');
      expect(typeof button.type).toBe('string');
      expect(button).toBeDisabled();
      expect(button).toHaveStyle({ opacity: 0.38 });
    } finally {
      await act(async () => heldClear.resolve());
    }
    expect(screen.getByTestId('storage-clear-preview-cache')).toBeEnabled();
    expect(screen.getByTestId('storage-clear-preview-cache')).toHaveStyle({ opacity: 1 });
  });

  test('clear uses the home run lifecycle: pending disables clear and language, rejection is handled, retry publishes success', async () => {
    const held = deferred<void>();
    const clearPreviewCache = jest.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(undefined);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const error = new Error('clear failed');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await render(<SettingsView {...props({ clearPreviewCache })} />);
      expect(screen.getByTestId('storage-clear-preview-cache')).toBeEnabled();
      await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
      expect(clearPreviewCache).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('storage-clear-preview-cache')).toBeDisabled();
      expect(screen.getByTestId('settings-language')).toBeDisabled();
      await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
      await userEvent.press(screen.getByTestId('settings-language'));
      expect(clearPreviewCache).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'English' })).toBeNull();
      await act(async () => { held.reject(error); });
      expect(await screen.findByTestId('settings-notice')).toHaveTextContent(i18n.t('settings.operationError'), { exact: true });
      expect(consoleError).toHaveBeenCalledWith('[Settings] operation failed', error);
      expect(screen.getByTestId('storage-clear-preview-cache')).toBeEnabled();
      expect(screen.getByTestId('settings-language')).toBeEnabled();
      await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
      await waitFor(() => expect(clearPreviewCache).toHaveBeenCalledTimes(2));
      expect(await screen.findByTestId('settings-notice')).toHaveTextContent('预览缓存已清除。', { exact: true });
      expect(screen.getByTestId('storage-clear-preview-cache')).toBeEnabled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      consoleError.mockRestore();
    }
  });

  test.each([
    [
      'a bound library',
      { status: 'ready', context: { kind: 's3' } },
      '部分数据未能删除：收藏和浏览记录、云库连接仍保留。',
    ],
    [
      'a locked library',
      { status: 'locked', reason: 'password_required' },
      '部分数据未能删除：收藏和浏览记录、云库连接仍保留。',
    ],
    [
      'an unconfigured library',
      { status: 'unconfigured' },
      '部分数据未能删除：收藏和浏览记录仍保留。',
    ],
  ] as const)('the reset page reports the true cloud state for %s', async (
    _label,
    byosStatus,
    expected,
  ) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const partial: DeleteAllAppDataResult = {
      ...deleteAllResult(),
      ok: false,
      database: { status: 'failed', deletedRows: 0, error: null },
      library: { status: 'failed', cloud: 'skipped', disconnected: false, error: null },
      remaining: ['database'],
      recomposed: false,
    };
    mockAppServices = {
      settings: DEFAULT_SETTINGS,
      dataRevision: 0,
      updateSettings: createStatefulSettingsUpdater().updateSettings,
      managedPreviewCache: {
        getBytes: jest.fn().mockResolvedValue(1_500),
        clear: jest.fn().mockResolvedValue(undefined),
      },
      collectionService: {
        getCollectionBytes: jest.fn().mockResolvedValue(0),
      },
      byosStatus,
      resetDismissedHistory: jest.fn().mockResolvedValue(0),
      resetDiscoveryHistory: jest.fn().mockResolvedValue(0),
      deleteAllAppData: jest.fn().mockResolvedValue(partial),
      createFullBackup: jest.fn(),
      restoreFullBackup: jest.fn(),
      providerRequestGovernor,
      providerCredentials: {
        snapshot: () => ({}),
        save: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      },
      libraryController: null,
      libraryActions: null,
      librarySync: null,
      libraryChanges: null,
      libraryStorageMode: null,
      reloadAppServices: jest.fn(),
    };

    await render(
      <QueryClientProvider client={client}>
        <ResetSettingsScreen />
      </QueryClientProvider>,
    );
    await userEvent.press(screen.getByRole('button', { name: '删除全部应用数据' }));
    await fireEvent.changeText(screen.getByLabelText('输入 DELETE'), 'DELETE');
    await userEvent.press(screen.getByRole('button', { name: '确认删除全部应用数据' }));

    expect(await screen.findByTestId('settings-notice')).toHaveTextContent(expected);
  });

  test.each([
    ['recomposed', true, 0],
    ['not recomposed', false, 1],
  ] as const)('after a delete-all that was %s, the reset page refreshes the mounted home storage only without a recompose', async (
    _label,
    recomposed,
    extraReads,
  ) => {
    // Board #27 S4 T6 review pin (finding 1): after a recompose the old
    // services are going away, so the container does not re-read storage.
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      const getCollectionBytes = jest.fn().mockResolvedValue(0);
      const getPreviewBytes = jest.fn().mockResolvedValue(1_500);
      const partial: DeleteAllAppDataResult = {
        ...deleteAllResult(),
        ok: false,
        remaining: ['files'],
        recomposed,
      };
      mockAppServices = {
        settings: DEFAULT_SETTINGS,
        dataRevision: 0,
        updateSettings: createStatefulSettingsUpdater().updateSettings,
        managedPreviewCache: {
          getBytes: getPreviewBytes,
          clear: jest.fn().mockResolvedValue(undefined),
        },
        collectionService: { getCollectionBytes },
        byosStatus: { status: 'unconfigured' },
        resetDismissedHistory: jest.fn().mockResolvedValue(0),
        resetDiscoveryHistory: jest.fn().mockResolvedValue(0),
        deleteAllAppData: jest.fn().mockResolvedValue(partial),
        createFullBackup: jest.fn(),
        restoreFullBackup: jest.fn(),
        providerRequestGovernor,
        providerCredentials: {
          snapshot: () => ({}),
          save: jest.fn(async () => undefined),
          clear: jest.fn(async () => undefined),
        },
        libraryController: null,
        libraryActions: null,
        librarySync: null,
        libraryChanges: null,
        libraryStorageMode: null,
        reloadAppServices: jest.fn(),
      };

      await render(
        <QueryClientProvider client={client}>
          <SettingsScreen />
          <ResetSettingsScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(getCollectionBytes).toHaveBeenCalled());
      const readsBefore = getCollectionBytes.mock.calls.length;
      await waitFor(() => expect(getPreviewBytes).toHaveBeenCalled());
      const previewReadsBefore = getPreviewBytes.mock.calls.length;
      await userEvent.press(screen.getByRole('button', { name: '删除全部应用数据' }));
      await fireEvent.changeText(screen.getByLabelText('输入 DELETE'), 'DELETE');
      await userEvent.press(screen.getByRole('button', { name: '确认删除全部应用数据' }));

      if (recomposed) {
        await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
      } else {
        expect(await screen.findByTestId('settings-notice')).toHaveTextContent('部分数据未能删除：本机文件仍保留。');
      }
      expect(getCollectionBytes).toHaveBeenCalledTimes(readsBefore + extraReads);
      expect(getPreviewBytes).toHaveBeenCalledTimes(previewReadsBefore + extraReads);
    } finally {
      alertSpy.mockRestore();
    }
  });

  test('disables filters, tags, numeric choices, switches, and segmented controls while data work is busy', async () => {
    const heldClear = deferred<void>();
    const clearPreviewCache = jest.fn(() => heldClear.promise);
    await render(<SettingsView {...props({ clearPreviewCache })} />);

    await userEvent.press(screen.getByRole('button', { name: '编辑排除标签' }));
    await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), 'maid');
    expect(screen.getByRole('button', { name: '直接排除「maid」' })).toBeEnabled();
    await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
    await waitFor(() => expect(clearPreviewCache).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText('NSFW 内容模式').props.accessibilityState)
      .toEqual(expect.objectContaining({ disabled: true }));
    expect(screen.getByRole('button', { name: '编辑排除标签' })).toBeDisabled();
    const toggle = screen.getByRole('switch', { name: '模糊 NSFW 缩略图' });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveStyle({ opacity: 0.38 });
    await userEvent.press(toggle);
    expect(toggle).toBeChecked();
    for (const radio of within(screen.getByTestId('settings-adult-content-mode')).getAllByRole('radio')) {
      expect(radio).toBeDisabled();
      expect(radio).toHaveStyle({ opacity: 0.5 });
      await userEvent.press(radio);
    }
    expect(screen.queryByText('仅限 18 岁以上')).toBeNull();
    expect(screen.getByRole('button', { name: '直接排除「maid」' })).toBeDisabled();

    await act(async () => heldClear.resolve());
  });

  test('home keeps About links hidden', async () => {
    await i18n.changeLanguage('en');
    await render(<SettingsView {...props()} />);
    for (const gone of ['Terms of service', 'API status and reference', 'Source code', 'Nekos API documentation']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  test('renders the storage panel with export and restore immediately below and clears only preview cache', async () => {
    const clearPreviewCache = jest.fn(async () => undefined);
    mockAppServices = { deleteAllAppData: jest.fn(), resetDiscoveryHistory: jest.fn() };

    await render(<SettingsView {...props({ clearPreviewCache })} />);

    expect(screen.getByTestId('storage-panel')).toBeOnTheScreen();
    expect(screen.getByTestId('storage-total')).toHaveTextContent('4.5 MB 已用', { exact: true });
    expect(screen.getByTestId('storage-preview-size')).toHaveTextContent('预览缓存 1.5 MB', { exact: true });
    expect(screen.getByTestId('storage-collection-size')).toHaveTextContent('收藏 3 MB', { exact: true });
    for (const oldLabel of ['受管预览缓存', '收藏占用', '清除受管预览缓存', '清理不会触碰收藏文件']) {
      expect(screen.queryByText(oldLabel)).toBeNull();
    }
    const panel = screen.getByTestId('storage-panel');
    const block = panel.parent!;
    expect(block).toHaveStyle({ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 });
    const siblings = block.parent!.parent!.children;
    expect(siblings).toHaveLength(3);
    expect(siblings[0]).toBe(block.parent);
    expect(screen.getByTestId('settings-backup-export').parent).toBe(siblings[1]);
    expect(screen.getByTestId('backup-restore').parent).toBe(siblings[2]);
    await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));

    await waitFor(() => expect(clearPreviewCache).toHaveBeenCalledTimes(1));
    expect(mockAppServices.deleteAllAppData).not.toHaveBeenCalled();
    expect(mockAppServices.resetDiscoveryHistory).not.toHaveBeenCalled();
  });

  test('calls distinct commands for dismissed and discovery resets', async () => {
    const resetDismissedHistory = jest.fn(async () => 2);
    const resetDiscoveryHistory = jest.fn(async () => 5);
    await renderReset({ resetDismissedHistory, resetDiscoveryHistory });

    await userEvent.press(screen.getByRole('button', { name: '重置已忽略记录' }));
    await userEvent.press(screen.getByRole('button', { name: '确认重置已忽略记录' }));
    await waitFor(() => expect(resetDismissedHistory).toHaveBeenCalledTimes(1));
    expect(resetDiscoveryHistory).not.toHaveBeenCalled();

    await userEvent.press(screen.getByRole('button', { name: '重置发现记录' }));
    await userEvent.press(screen.getByRole('button', { name: '确认重置发现记录' }));
    await waitFor(() => expect(resetDiscoveryHistory).toHaveBeenCalledTimes(1));
    expect(resetDismissedHistory).toHaveBeenCalledTimes(1);
  });

  test('requires the exact DELETE phrase in an Android-compatible modal', async () => {
    const deleteAllAppData = jest.fn(async () => deleteAllResult());
    await renderReset({ deleteAllAppData });

    await userEvent.press(screen.getByRole('button', { name: '删除全部应用数据' }));
    const confirm = screen.getByRole('button', { name: '确认删除全部应用数据' });
    expect(confirm).toBeDisabled();

    await fireEvent.changeText(screen.getByLabelText('输入 DELETE'), 'delete');
    expect(confirm).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('输入 DELETE'), 'DELETE');
    expect(confirm).toBeEnabled();
    await userEvent.press(confirm);

    await waitFor(() => expect(deleteAllAppData).toHaveBeenCalledTimes(1));
  });

  test('reports structured partial delete failures without raw errors', async () => {
    const partial: DeleteAllAppDataResult = {
      ok: false,
      files: {
        deleted: ['file:///collection/1.jpg'],
        failed: [{
          uri: 'file:///collection/2.jpg',
          error: { code: 'delete_failed', message: 'internal file detail' },
        }],
      },
      database: { status: 'deleted', deletedRows: 4, error: null },
      settings: { status: 'failed', error: { code: 'settings_failed', message: 'raw detail' } },
      library: { status: 'deleted', cloud: 'failed', disconnected: false, error: null },
      remaining: ['files', 'settings', 'cloud'],
      recomposed: false,
    };
    await renderReset({ deleteAllAppData: jest.fn(async () => partial) });

    await userEvent.press(screen.getByRole('button', { name: '删除全部应用数据' }));
    await fireEvent.changeText(screen.getByLabelText('输入 DELETE'), 'DELETE');
    await userEvent.press(screen.getByRole('button', { name: '确认删除全部应用数据' }));

    expect(await screen.findByText('部分数据未能删除：本机文件、设置、云库连接仍保留。')).toBeOnTheScreen();
    expect(screen.queryByText('internal file detail')).not.toBeOnTheScreen();
    expect(screen.queryByText('raw detail')).not.toBeOnTheScreen();
  });

  test('exports a complete backup and confirms destructive restore', async () => {
    const createFullBackup = jest.fn(async () => ({
      formatVersion: 1,
      applicationId: 'app.waifudeck.mobile',
      appVersion: '1.1.0',
      createdAt: 123,
      imageCount: 4,
      fileCount: 3,
      totalFileBytes: 3_000_000,
      missingFileCount: 1,
      cloudOnlyCount: 2,
    }));
    const restoreFullBackup = jest.fn(async () => ({
      formatVersion: 1,
      applicationId: 'app.waifudeck.mobile',
      appVersion: '1.1.0',
      createdAt: 123,
      imageCount: 4,
      fileCount: 3,
      totalFileBytes: 3_000_000,
      restoredFileCount: 3,
      missingFileCount: 1,
    }));
    await render(<SettingsView {...props({
      createFullBackup,
      restoreFullBackup,
    })} />);

    await userEvent.press(screen.getByRole('button', { name: '导出完整备份' }));
    await waitFor(() => expect(createFullBackup).toHaveBeenCalledTimes(1));
    expect(screen.getByText('完整备份已导出：3 张原图，3 MB，1 张缺失原图未写入，2 张只在云端，未写入。'))
      .toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: '从完整备份恢复' }));
    expect(screen.getByText('恢复完整备份？')).toBeOnTheScreen();
    expect(restoreFullBackup).not.toHaveBeenCalled();
    await userEvent.press(screen.getByRole('button', { name: '选择备份并恢复' }));
    await waitFor(() => expect(restoreFullBackup).toHaveBeenCalledTimes(1));
  });

  test.each([
    [2, '已恢复 7 张收藏。 当前版本已略过 2 条成人内容记录。正在重新载入。'],
    [0, '已恢复 7 张收藏。正在重新载入。'],
  ] as const)('completed restore renders the exact notice (removedAdultImageCount=%s)', async (removedAdultImageCount, expected) => {
    const heldRestore = deferred<Awaited<ReturnType<SettingsViewProps['restoreFullBackup']>>>();
    const restoreFullBackup = jest.fn(() => heldRestore.promise);
    await render(<SettingsView {...props({ restoreFullBackup })} />);
    await userEvent.press(screen.getByTestId('backup-restore'));
    await userEvent.press(screen.getByRole('button', { name: '选择备份并恢复' }));
    expect(restoreFullBackup).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('settings-notice')).toBeNull();
    await act(async () => heldRestore.resolve({
      formatVersion: 1, applicationId: 'app.waifudeck.mobile', appVersion: '1.1.0', createdAt: 123,
      imageCount: 9, fileCount: 8, totalFileBytes: 3_000_000, missingFileCount: 1,
      restoredFileCount: 7, removedAdultImageCount,
    }));
    expect(screen.queryByTestId('settings-notice')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-notice')).toHaveTextContent(expected, { exact: true });
  });

  test('does not add a cloud-only clause when the backup count is zero', async () => {
    const createFullBackup = jest.fn(async () => ({
      formatVersion: 1,
      applicationId: 'app.waifudeck.mobile',
      appVersion: '1.1.0',
      createdAt: 123,
      imageCount: 4,
      fileCount: 3,
      totalFileBytes: 3_000_000,
      missingFileCount: 1,
      cloudOnlyCount: 0,
    }));
    await render(<SettingsView {...props({ createFullBackup })} />);

    await userEvent.press(screen.getByRole('button', { name: '导出完整备份' }));
    await waitFor(() => expect(createFullBackup).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('settings-notice')).toHaveTextContent(
      '完整备份已导出：3 张原图，3 MB，1 张缺失原图未写入。',
    );
    expect(screen.getByTestId('settings-notice')).not.toHaveTextContent(/只在云端/);
  });
});

describe('N3 Settings exclude tags', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function StatefulSettings({ initial }: { initial: AppSettings }) {
    const [settings, setSettings] = React.useState(initial);
    const updateSettings: SettingsViewProps['updateSettings'] = async (update) => {
      const next = typeof update === 'function' ? update(settings) : update;
      const saved = { ...settings, ...next };
      setSettings(saved);
      return saved;
    };
    return <SettingsView {...props({ settings, updateSettings })} />;
  }

  test.each([
    [[], '无'], [['furry'], 'furry'],
    [['furry', 'comic', '3d', 'ai-generated'], 'furry 等 4 个'],
  ] as [string[], string][])('row summarizes %p as %s', async (excludedTags, expected) => {
    await render(<StatefulSettings initial={{ ...DEFAULT_SETTINGS, excludedTags }} />);
    expect(screen.getByText(expected)).toBeOnTheScreen();
  });

  test('with Danbooru disabled, suggestions still load and saves survive closing and reopening the sheet', async () => {
    await render(<StatefulSettings initial={{
      ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, danbooru: false },
    }} />);
    expect(mockTagFetch).not.toHaveBeenCalled();
    await userEvent.press(screen.getByRole('button', { name: '编辑排除标签' }));
    await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), 'fur');
    await act(async () => { await jest.advanceTimersByTimeAsync(250); });
    expect(mockTagFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('23.8 万')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('checkbox', { name: 'fur-trimmed_jacket' }));
    expect(screen.getByRole('button', { name: '取消屏蔽 fur-trimmed_jacket' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('checkbox', { name: 'furry' }));
    expect(screen.getByText('fur-trimmed_jacket 等 2 个')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: '关闭标签选择' }));
    await userEvent.press(screen.getByRole('button', { name: '编辑排除标签' }));
    expect(screen.getByRole('button', { name: '取消屏蔽 furry' })).toBeOnTheScreen();
    await act(async () => { await jest.advanceTimersByTimeAsync(250); });
    await userEvent.press(screen.getByRole('checkbox', { name: 'furry' }));
    await userEvent.press(screen.getByRole('checkbox', { name: 'fur-trimmed_jacket' }));
    expect(screen.getByText('无')).toBeOnTheScreen();
  });

  test('failed suggestions keep raw exclusion available through the Settings save path', async () => {
    mockTagFetch.mockRejectedValue(new Error('offline'));
    await render(<StatefulSettings initial={DEFAULT_SETTINGS} />);
    await userEvent.press(screen.getByRole('button', { name: '编辑排除标签' }));
    await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), 'xyz');
    await act(async () => { await jest.advanceTimersByTimeAsync(250); });
    expect(screen.getByText('暂时拿不到建议，可以直接排除输入的内容。')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: '直接排除「xyz」' }));
    expect(screen.getByRole('button', { name: '取消屏蔽 xyz' })).toBeOnTheScreen();
  });
});

describe('settings screen about', () => {

  test('shows the app version', async () => {
    await render(<SettingsView {...props({ appVersion: '2.4.1' })} />);

    expect(screen.getByTestId('settings-version')).toHaveTextContent('应用版本 · 2.4.1', { exact: true });
  });

  test('shows update available indicator on settings-version and opens the update modal on tap', async () => {
    const openModal = jest.fn(async () => {});
    const release = {
      versionName: '1.2.1',
      versionCode: 1002001,
      publishedAt: '2026-10-16T00:00:00Z',
      sizeBytes: 1000,
      sha256: 'a'.repeat(64),
      downloadUrl: 'https://waifudeck.app/api/app/download',
      notes: 'Bug fixes',
    };
    const checkForUpdatesManual = jest.fn(async () => ({
      status: 'update_available' as const,
      release,
    }));
    const snapshot: AppUpdateSnapshot = {
      installedVersionCode: 1002000,
      installedVersionName: '1.2.0',
      offer: {
        release,
        shouldAutoPopup: false,
      },
      modalVisible: false,
      modalPhase: { kind: 'ready', alreadyDownloaded: false },
      checking: false,
    };
    const fakeService: AppUpdateService = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      initialize: async () => {},
      onForegroundResume: async () => {},
      checkForUpdatesManual,
      openModal,
      dismissModal: async () => {},
      startDownloadAndInstall: async () => {},
      cancelDownload: () => {},
      openUnknownSourcesSettings: async () => {},
      openInBrowser: async () => {},
    };

    await render(
      <AppUpdateProvider service={fakeService}>
        <SettingsView {...props({ appVersion: '1.2.0' })} />
      </AppUpdateProvider>,
    );

    const versionFooter = screen.getByTestId('settings-version');
    expect(versionFooter).toHaveTextContent('应用版本 · 1.2.0 · 发现新版本 v1.2.1', { exact: true });
    fireEvent.press(versionFooter);
    expect(openModal).toHaveBeenCalledTimes(1);
    expect(checkForUpdatesManual).not.toHaveBeenCalled();
  });

  test('tapping settings-version when no update offer is cached triggers a manual check', async () => {
    const checkForUpdatesManual = jest.fn(async () => ({
      status: 'up_to_date' as const,
      versionName: '1.2.0',
    }));
    const snapshot: AppUpdateSnapshot = {
      installedVersionCode: 1002000,
      installedVersionName: '1.2.0',
      offer: null,
      modalVisible: false,
      modalPhase: { kind: 'ready', alreadyDownloaded: false },
      checking: false,
    };
    const fakeService: AppUpdateService = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      initialize: async () => {},
      onForegroundResume: async () => {},
      checkForUpdatesManual,
      openModal: async () => {},
      dismissModal: async () => {},
      startDownloadAndInstall: async () => {},
      cancelDownload: () => {},
      openUnknownSourcesSettings: async () => {},
      openInBrowser: async () => {},
    };

    await render(
      <AppUpdateProvider service={fakeService}>
        <SettingsView {...props({ appVersion: '1.2.0' })} />
      </AppUpdateProvider>,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('settings-version'));
    });

    expect(checkForUpdatesManual).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-notice')).toHaveTextContent('当前已是最新版本（v1.2.0）。');
  });
});

describe('board #27 S4: delete-all notices', () => {
  let alertSpy: jest.SpiedFunction<typeof Alert.alert>;

  beforeEach(() => {
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  async function confirmDelete() {
    await userEvent.press(screen.getByRole('button', { name: '删除全部应用数据' }));
    await fireEvent.changeText(screen.getByLabelText('输入 DELETE'), 'DELETE');
    await userEvent.press(screen.getByRole('button', { name: '确认删除全部应用数据' }));
  }

  test('a bound phone whose reset stopped before the disconnect is told it is still connected', async () => {
    const result: DeleteAllAppDataResult = {
      ...deleteAllResult(),
      ok: false,
      database: { status: 'failed', deletedRows: 0, error: null },
      library: { status: 'failed', cloud: 'skipped', disconnected: false, error: null },
      remaining: ['database'],
    };
    const deleteAllAppData = jest.fn(async () => result);
    const client = new QueryClient();
    const view = await renderReset({ deleteAllAppData, cloudBound: true }, client);

    await confirmDelete();
    expect(await screen.findByText('部分数据未能删除：收藏和浏览记录、云库连接仍保留。')).toBeOnTheScreen();

    mockAppServices.byosStatus = { status: 'unconfigured' };
    await view.rerender(<QueryClientProvider client={client}><ResetSettingsScreen /></QueryClientProvider>);
    await confirmDelete();
    expect(await screen.findByText('部分数据未能删除：收藏和浏览记录仍保留。')).toBeOnTheScreen();
  });

  test('a forget that failed after the disconnect names the records', async () => {
    const result: DeleteAllAppDataResult = {
      ...deleteAllResult(),
      ok: false,
      library: { status: 'deleted', cloud: 'failed', disconnected: true, error: null },
      remaining: ['cloud'],
      recomposed: true,
    };
    await renderReset({ deleteAllAppData: jest.fn(async () => result) });

    await confirmDelete();

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy).toHaveBeenCalledWith(
        '删除全部应用数据',
        '部分数据未能删除：云库图片记录仍保留。',
      );
    });
    expect(screen.queryByText('部分数据未能删除：云库图片记录仍保留。')).toBeNull();
  });

  test('a recomposed partial result is an alert, not a notice', async () => {
    const partial: DeleteAllAppDataResult = {
      ...deleteAllResult(),
      ok: false,
      remaining: ['files'],
      recomposed: true,
    };
    const deleteAllAppData = jest.fn()
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce({ ...deleteAllResult(), recomposed: true });
    await renderReset({ deleteAllAppData });

    await confirmDelete();
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(
      '删除全部应用数据',
      '部分数据未能删除：本机文件仍保留。',
    ));
    expect(screen.queryByText('部分数据未能删除：本机文件仍保留。')).toBeNull();

    await confirmDelete();
    await waitFor(() => {
      expect(screen.getByTestId('settings-notice')).toHaveTextContent(
        i18n.t('settings.reset.allDeleted'),
      );
    });
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  test('a failed disconnect is not listed twice', async () => {
    const result: DeleteAllAppDataResult = {
      ...deleteAllResult(),
      ok: false,
      library: { status: 'deleted', cloud: 'failed', disconnected: false, error: null },
      remaining: ['cloud'],
    };
    await renderReset({ deleteAllAppData: jest.fn(async () => result), cloudBound: true });

    await confirmDelete();
    expect(await screen.findByText('部分数据未能删除：云库连接仍保留。')).toBeOnTheScreen();
  });
});

describe('settings screen private library section', () => {
  function libraryMockServices() {
    return {
      settings: DEFAULT_SETTINGS,
      dataRevision: 0,
      updateSettings: createStatefulSettingsUpdater().updateSettings,
      managedPreviewCache: {
        getBytes: jest.fn().mockResolvedValue(1_500),
        clear: jest.fn().mockResolvedValue(undefined),
      },
      collectionService: {
        getCollectionBytes: jest.fn().mockResolvedValue(0),
      },
      resetDismissedHistory: jest.fn().mockResolvedValue(0),
      resetDiscoveryHistory: jest.fn().mockResolvedValue(0),
      deleteAllAppData: jest.fn().mockResolvedValue(deleteAllResult()),
      createFullBackup: jest.fn(),
      restoreFullBackup: jest.fn(),
      providerRequestGovernor,
      providerCredentials: {
        snapshot: () => ({}),
        save: jest.fn(async () => undefined),
        clear: jest.fn(async () => undefined),
      },
      reloadAppServices: jest.fn(),
      byosStatus: { status: 'unconfigured' },
      libraryStorageMode: null,
    };
  }

  test('the SettingsScreen container clears preview cache and refetches only its query', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const getBytes = jest.fn().mockResolvedValue(1_500);
    const clear = jest.fn().mockResolvedValue(undefined);
    const getCollectionBytes = jest.fn().mockResolvedValue(3_000_000);
    mockAppServices = {
      ...libraryMockServices(),
      managedPreviewCache: { getBytes, clear },
      collectionService: { getCollectionBytes },
    };

    await render(
      <QueryClientProvider client={client}>
        <SettingsScreen />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getBytes).toHaveBeenCalledTimes(1));
    const previewReadsBefore = getBytes.mock.calls.length;
    const collectionReadsBefore = getCollectionBytes.mock.calls.length;

    await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));

    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getBytes).toHaveBeenCalledTimes(previewReadsBefore + 1));
    expect(getCollectionBytes).toHaveBeenCalledTimes(collectionReadsBefore);
  });

  test('a configured controller still renders only the home card; mode wiring moves to the page', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const storageMode = { read: jest.fn(), set: jest.fn() };
    mockAppServices = {
      ...libraryMockServices(),
      libraryController: { importImages: jest.fn() },
      libraryActions: {},
      libraryStorageMode: storageMode,
    };

    await render(
      <QueryClientProvider client={client}>
        <SettingsScreen />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('settings-cloud-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('byos-settings-slot')).toBeNull();
    expect(mockSlotProps).toBeNull();
  });

  test('R8.17: the settings scroll content reserves for the floating tab bar', async () => {
    await render(<SettingsView {...props()} />);

    const scroll = screen.getByTestId('settings-scroll');
    // The tail of the list must always be able to scroll out from under the
    // absolutely-positioned floating bar (owner's overlap bug class).
    expect(scroll.props.contentContainerStyle).toMatchObject({
      paddingBottom: tabBarContentInset(0),
    });
  });

  test.each(['light', 'dark'] as const)('R8.17: the %s home notice clears the floating tab bar', async (scheme) => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    mockSafeAreaBottomInset = 23;
    try {
      await render(<SettingsView {...props()} />);
      await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
      const notice = await screen.findByTestId('settings-notice');
      expect(notice).toHaveStyle({ padding: 12, marginBottom: tabBarContentInset(23),
        backgroundColor: colors[scheme].surfaceSecondary, color: colors[scheme].text,
        borderTopWidth: 1, borderTopColor: colors[scheme].hair });
      expect(notice).toHaveProp('accessibilityLiveRegion', 'polite');
      expect(notice.parent).toBe(screen.getByTestId('screen-settings'));
      expect(screen.getByTestId('settings-scroll').queryAll((node) => node === notice)).toHaveLength(0);
    } finally {
      mockSafeAreaBottomInset = 0;
    }
  });

  test('the cloud page scroll reserves keyboard height without a tab bar and removes it on hide', async () => {
    const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
    const remove = jest.fn();
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: Parameters<typeof Keyboard.addListener>[0], listener: Parameters<typeof Keyboard.addListener>[1]) => {
      listeners.set(event, listener as (value: unknown) => void);
      return { remove };
    }) as never);

    const view = await render(<CloudLibraryScroll><Text>page</Text></CloudLibraryScroll>);
    const scroll = screen.getByTestId('cloud-library-scroll');
    // U3a: the page bottom clearance is the shared scroll clamp (U2c2 `c96d3b8a`).
    expect(scroll.props.contentContainerStyle).toMatchObject({
      paddingBottom: metrics.gestureInset + metrics.spacing.large,
    });

    await act(async () => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 400, screenY: 2868 } } as never);
    });
    expect(screen.getByTestId('cloud-library-scroll').props.contentContainerStyle).toMatchObject({
      paddingBottom: metrics.gestureInset + metrics.spacing.large + 400,
    });

    await act(async () => {
      listeners.get('keyboardDidHide')?.({ endCoordinates: { height: 0, screenY: 2868 } } as never);
    });
    expect(screen.getByTestId('cloud-library-scroll').props.contentContainerStyle).toMatchObject({
      paddingBottom: metrics.gestureInset + metrics.spacing.large,
    });

    await view.unmount();
    expect(mockImeHeightSink.remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  test('scrollOffsetToReveal lifts a covered field above the keyboard and leaves a visible one', () => {
    const boardCase = {
      fieldTop: 2000,
      fieldHeight: 48,
      currentScrollOffset: 0,
      viewportHeight: 2868,
      keyboardHeight: 1064,
      gap: 16,
    };
    expect(scrollOffsetToReveal({ ...boardCase, bottomInset: 0 })).toBe(260);
    expect(scrollOffsetToReveal({ ...boardCase, bottomInset: 80 })).toBe(340);
    expect(scrollOffsetToReveal({
      ...boardCase,
      fieldTop: 1600,
      currentScrollOffset: 10,
      bottomInset: 0,
    })).toBe(10);
    expect(scrollOffsetToReveal({ ...boardCase, currentScrollOffset: 123, keyboardHeight: 0, bottomInset: 0 })).toBe(123);
    expect(scrollOffsetToReveal({ ...boardCase, fieldTop: 3000, currentScrollOffset: 123, keyboardHeight: 0, bottomInset: 0 })).toBe(123);
  });

  test('a focused cloud field asks the settings scroll to reveal it', async () => {
    const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: Parameters<typeof Keyboard.addListener>[0], listener: Parameters<typeof Keyboard.addListener>[1]) => {
      listeners.set(event, listener as (value: unknown) => void);
      return { remove: jest.fn() };
    }) as never);

    const view = await render(
      <CloudLibraryScroll>
        <WebdavConnectForm
          probe={jest.fn(async () => ({ kind: 'empty' as const }))}
          connect={jest.fn(async () => ({ ok: true } as any))}
          onConnected={jest.fn()}
          busy={false}
          setBusy={jest.fn()}
        />
      </CloudLibraryScroll>,
    );
    const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
    const contentNode = 123;
    jest.spyOn(ScrollView.prototype, 'getInnerViewNode').mockReturnValue(contentNode);
    const measureLayout = jest.spyOn(TextInput.prototype, 'measureLayout').mockImplementation((relativeTo, onSuccess) => {
      expect(relativeTo).toBe(contentNode);
      onSuccess(0, 2000, 300, 48);
    });
    const scroll = screen.getByTestId('cloud-library-scroll');
    await fireEvent(scroll, 'layout', { nativeEvent: { layout: { height: 2868 } } });
    await fireEvent(screen.getByTestId('webdav-field-url'), 'focus');
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 1064, screenY: 2868 } } as never);
    });
    expect(screen.getByTestId('cloud-library-scroll').props.contentContainerStyle.paddingBottom)
      .toBe(metrics.gestureInset + metrics.spacing.large + 1064);
    expect(measureLayout).toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith({ y: scrollOffsetToReveal({
      fieldTop: 2000,
      fieldHeight: 48,
      currentScrollOffset: 0,
      viewportHeight: 2868,
      keyboardHeight: 1064,
      bottomInset: 0,
      gap: 16,
    }), animated: true });

    measureLayout.mockImplementation((_relativeTo, onSuccess) => {
      onSuccess(0, 1600, 300, 48);
    });
    scrollTo.mockClear();
    await fireEvent(screen.getByTestId('webdav-field-username'), 'focus');
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => {
      view.unmount();
    });
  });

  test('R9: home hides local-gallery import and moves the BYOS slot behind the card', async () => {
    // Owner decision 2026-09-07: the local import feature leaves the UI for
    // now (mechanism retained underneath). The import row must not render;
    // the BYOS slot beside it must keep working untouched.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    mockAppServices = {
      ...libraryMockServices(),
      libraryController: { importImages: jest.fn() },
      libraryActions: {},
    };

    await render(
      <QueryClientProvider client={client}>
        <SettingsScreen />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('settings-cloud-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('byos-settings-slot')).toBeNull();
    expect(screen.queryByText('导入图片')).not.toBeOnTheScreen();
  });

  test('omits the library section (and BYOS slot) with no library controller', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    mockAppServices = {
      ...libraryMockServices(),
      libraryController: null,
      libraryActions: null,
    };

    await render(
      <QueryClientProvider client={client}>
        <SettingsScreen />
      </QueryClientProvider>,
    );

    await screen.findByTestId('settings-version');
    expect(screen.getByTestId('settings-cloud-card')).toBeOnTheScreen();
    expect(screen.queryByTestId('byos-settings-slot')).not.toBeOnTheScreen();
  });
});

describe('SettingsScreen: 收藏占用 follows the library (board #27 F1)', () => {
  const noop = () => jest.fn().mockResolvedValue(0);
  function servicesWith(overrides: Record<string, unknown>) {
    return {
      settings: DEFAULT_SETTINGS, dataRevision: 0, updateSettings: createStatefulSettingsUpdater().updateSettings,
      managedPreviewCache: { getBytes: noop(), clear: jest.fn().mockResolvedValue(undefined) },
      collectionService: { getCollectionBytes: noop() }, byosStatus: { status: 'unconfigured' },
      resetDismissedHistory: noop(), resetDiscoveryHistory: noop(), deleteAllAppData: jest.fn(),
      createFullBackup: jest.fn(), restoreFullBackup: jest.fn(), providerRequestGovernor,
      providerCredentials: { snapshot: () => ({}), save: jest.fn(async () => undefined), clear: jest.fn(async () => undefined) },
      libraryController: null, libraryActions: null, librarySync: null, libraryChanges: null,
      libraryStorageMode: null, reloadAppServices: jest.fn(), ...overrides,
    };
  }
  // One client per test: a re-render with a new client would remount the screen
  // and hide whether the subscription follows `libraryChanges`.
  let client: QueryClient;
  const tree = () => <QueryClientProvider client={client}><SettingsScreen /></QueryClientProvider>;
  async function renderSettings(overrides: Record<string, unknown>) {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    mockAppServices = servicesWith(overrides);
    const view = await render(tree());
    await act(async () => { focusSettings(); });
    return view;
  }
  // A focused Settings with a real feed, after its mount read.
  async function mounted(getCollectionBytes: jest.Mock = noop(), extra: Record<string, unknown> = {}) {
    const feed = createLibraryChangeFeed();
    const view = await renderSettings({ libraryChanges: feed, collectionService: { getCollectionBytes }, ...extra });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(1));
    return { feed, getCollectionBytes, view };
  }
  const settle = () => act(async () => { await Promise.resolve(); });
  const LISTED: LibraryChangeKind[] = ['round-complete', 'downloaded', 'purged', 'handed-over', 'ingested', 'trashed', 'original-missing'];

  test('focused: a round-complete re-reads 收藏占用, the row shows the new value, and the preview cache is read once', async () => {
    const getBytes = jest.fn().mockResolvedValue(1_500);
    const { feed, getCollectionBytes } = await mounted(
      jest.fn().mockResolvedValueOnce(900_000_000).mockResolvedValue(20_000_000),
      { managedPreviewCache: { getBytes, clear: jest.fn().mockResolvedValue(undefined) } },
    );
    expect(await screen.findByText('收藏 900 MB')).toBeTruthy();
    await act(async () => { feed.emit({ kind: 'round-complete' }); });
    expect(await screen.findByText('收藏 20 MB')).toBeTruthy();
    await act(async () => { feed.emit({ kind: 'purged', plaintextSha256: 'a'.repeat(64) }); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(3));
    expect(getBytes).toHaveBeenCalledTimes(1);
  });

  test('a failed collection refresh after measured data removes the total and ratio and keeps the preview size', async () => {
    const { feed } = await mounted(jest.fn().mockResolvedValueOnce(3_000_000).mockRejectedValue(new Error('read failed')),
      { managedPreviewCache: { getBytes: jest.fn().mockResolvedValue(1_500_000), clear: jest.fn() } });
    expect(await screen.findByText('收藏 3 MB')).toBeOnTheScreen();
    expect(screen.getByTestId('storage-total')).toHaveTextContent('4.5 MB 已用', { exact: true });
    await act(async () => { feed.emit({ kind: 'round-complete' }); });
    await waitFor(() => expect(screen.getByTestId('storage-collection-size')).toHaveTextContent('收藏 不可用', { exact: true }));
    expect(screen.getByTestId('storage-preview-size')).toHaveTextContent('预览缓存 1.5 MB', { exact: true });
    expect(screen.getByTestId('storage-total')).toHaveTextContent('不可用', { exact: true });
    for (const id of ['storage-collection-segment', 'storage-preview-segment']) {
      expect(screen.getByTestId(id, { includeHiddenElements: true })).toHaveStyle({ flex: 0 });
    }
  });

  test.each(LISTED)('focused: a %s change re-reads 收藏占用', async (kind) => {
    const { feed, getCollectionBytes } = await mounted();
    await act(async () => { feed.emit({ kind }); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));
  });

  test.each<LibraryChangeKind>(['freed', 'protected', 'protect-settled', 'restored'])(
    'a %s change does not re-read (a round-complete control right after it re-reads once)',
    async (kind) => {
      const { feed, getCollectionBytes } = await mounted();
      await act(async () => { feed.emit({ kind }); });
      await act(async () => { feed.emit({ kind: 'round-complete' }); });
      await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));
      await settle();
      expect(getCollectionBytes).toHaveBeenCalledTimes(2);
    },
  );

  test('blurred: changes only mark the row stale; the next focus reads once, a focus with nothing new reads nothing', async () => {
    const { feed, getCollectionBytes } = await mounted();
    await act(async () => { blurSettings(); });
    await act(async () => { feed.emit({ kind: 'purged', plaintextSha256: 'b'.repeat(64) }); feed.emit({ kind: 'round-complete' }); });
    await settle();
    expect(getCollectionBytes).toHaveBeenCalledTimes(1);
    await act(async () => { focusSettings(); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));
    await act(async () => { blurSettings(); });
    await act(async () => { focusSettings(); });
    await settle();
    expect(getCollectionBytes).toHaveBeenCalledTimes(2);
  });

  test('focused: a listed change reads once and leaves no stale work for refocus', async () => {
    const { feed, getCollectionBytes } = await mounted();
    await act(async () => { feed.emit({ kind: 'purged', plaintextSha256: 'd'.repeat(64) }); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));
    await act(async () => { blurSettings(); });
    await act(async () => { focusSettings(); });
    await settle();
    expect(getCollectionBytes).toHaveBeenCalledTimes(2);
  });

  test('a dataRevision move during a collection read still applies a listed change after the new key mounts', async () => {
    const oldRead = deferred<number>();
    const newKeyRead = deferred<number>();
    const getCollectionBytes = jest.fn()
      .mockResolvedValueOnce(1_000)
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => newKeyRead.promise)
      .mockResolvedValue(3_000);
    const feed = createLibraryChangeFeed();
    const view = await renderSettings({
      libraryChanges: feed,
      collectionService: { getCollectionBytes },
    });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(1));

    await act(async () => { feed.emit({ kind: 'round-complete' }); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));

    mockAppServices = { ...mockAppServices, dataRevision: 1 };
    await view.rerender(tree());
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(3));

    await act(async () => { feed.emit({ kind: 'purged', plaintextSha256: 'e'.repeat(64) }); });
    await act(async () => { oldRead.resolve(1_000); });
    await act(async () => { newKeyRead.resolve(2_000); });

    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('收藏 3 KB')).toBeTruthy();
  });

  test('350 changes during one in-flight read cost exactly one more read', async () => {
    // The in-flight guard is pinned by the observer's `refetch` calls: without it,
    // `cancelRefetch: false` would still join the fetch, but every change would
    // start a `refetch` (plan re-review 2, finding 3). `refetch` is bound in the
    // observer's constructor, so the spy must exist before the render.
    const refetchSpy = jest.spyOn(QueryObserver.prototype, 'refetch');
    const held = deferred<number>();
    const { feed, getCollectionBytes } = await mounted(jest.fn()
      .mockResolvedValueOnce(1_000).mockImplementationOnce(() => held.promise).mockResolvedValue(3_000));
    await act(async () => { feed.emit({ kind: 'round-complete' }); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));
    const refetchesBeforeBurst = refetchSpy.mock.calls.length;
    await act(async () => { for (let i = 0; i < 350; i += 1) feed.emit({ kind: 'purged', plaintextSha256: 'c'.repeat(64) }); });
    expect(getCollectionBytes).toHaveBeenCalledTimes(2);
    expect(refetchSpy.mock.calls.length).toBe(refetchesBeforeBurst);
    await act(async () => { held.resolve(2_000); });
    expect(await screen.findByText('收藏 3 KB')).toBeTruthy();
    expect(getCollectionBytes).toHaveBeenCalledTimes(3);
    refetchSpy.mockRestore();
  });

  test('a change during the mount read joins it and reads once more after it', async () => {
    const held = deferred<number>();
    const { feed, getCollectionBytes } = await mounted(jest.fn()
      .mockImplementationOnce(() => held.promise).mockResolvedValue(5_000));
    await act(async () => { feed.emit({ kind: 'round-complete' }); });
    expect(getCollectionBytes).toHaveBeenCalledTimes(1);
    await act(async () => { held.resolve(4_000); });
    expect(await screen.findByText('收藏 5 KB')).toBeTruthy();
    await settle();
    expect(getCollectionBytes).toHaveBeenCalledTimes(2);
  });

  test('unmount and a new feed release the old subscription', async () => {
    const feedA = createLibraryChangeFeed();
    const offA = jest.fn();
    const wrappedA = { ...feedA, subscribe: jest.fn((l: Parameters<typeof feedA.subscribe>[0]) => {
      const off = feedA.subscribe(l); return () => { offA(); off(); }; }) };
    const getCollectionBytes = noop();
    const view = await renderSettings({ libraryChanges: wrappedA, collectionService: { getCollectionBytes } });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(1));
    expect(wrappedA.subscribe).toHaveBeenCalledTimes(1);
    const feedB = createLibraryChangeFeed();
    mockAppServices = { ...mockAppServices, libraryChanges: feedB };
    await view.rerender(tree());
    expect(offA).toHaveBeenCalledTimes(1);
    await act(async () => { feedA.emit({ kind: 'round-complete' }); });
    expect(getCollectionBytes).toHaveBeenCalledTimes(1);
    await act(async () => { feedB.emit({ kind: 'round-complete' }); });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(2));
    await view.unmount();
    feedB.emit({ kind: 'round-complete' });
    await settle();
    expect(getCollectionBytes).toHaveBeenCalledTimes(2);
  });

  test('with no change feed it renders and reads once', async () => {
    const getCollectionBytes = noop();
    await renderSettings({ libraryChanges: null, collectionService: { getCollectionBytes } });
    await waitFor(() => expect(getCollectionBytes).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('storage-collection-size')).toHaveTextContent(/^收藏 /);
  });
});

test('moving focus from one cloud field to another while the keyboard stays up still reveals the second field', async () => {
  const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: Parameters<typeof Keyboard.addListener>[0], listener: Parameters<typeof Keyboard.addListener>[1]) => {
    listeners.set(event, listener as (value: unknown) => void);
    return { remove: jest.fn() };
  }) as never);
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  const contentNode = 123;
  jest.spyOn(ScrollView.prototype, 'getInnerViewNode').mockReturnValue(contentNode);
  const measureLayout = jest.spyOn(TextInput.prototype, 'measureLayout').mockImplementation(function (this: any, relativeTo, onSuccess) {
    expect(relativeTo).toBe(contentNode);
    onSuccess(0, this.props?.testID === 'field-b' ? 2400 : 1600, 300, 48);
  });

  const renderFields = async () => {
    const view = await render(
      <CloudLibraryScroll>
        <SettingsField testID="field-a" accessibilityLabel="Field A" placeholder="Field A" value="" onChangeText={jest.fn()} />
        <SettingsField testID="field-b" accessibilityLabel="Field B" placeholder="Field B" value="" onChangeText={jest.fn()} />
      </CloudLibraryScroll>,
    );
    await fireEvent(screen.getByTestId('cloud-library-scroll'), 'layout', { nativeEvent: { layout: { height: 2868 } } });
    return view;
  };

  const firstView = await renderFields();
  await fireEvent(screen.getByTestId('field-a'), 'focus');
  await fireEvent(screen.getByTestId('field-b'), 'focus');
  await fireEvent(screen.getByTestId('field-a'), 'blur');
  await act(async () => {
    listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 1064, screenY: 2868 } } as never);
  });
  expect(scrollTo).toHaveBeenCalledWith({ y: 660, animated: true });

  await act(async () => {
    listeners.get('keyboardDidHide')?.({} as never);
  });
  await act(async () => {
    firstView.unmount();
  });
  scrollTo.mockClear();
  measureLayout.mockClear();
  listeners.clear();

  const secondView = await renderFields();
  await fireEvent(screen.getByTestId('field-a'), 'focus');
  await fireEvent(screen.getByTestId('field-a'), 'blur');
  await fireEvent(screen.getByTestId('field-b'), 'focus');
  await act(async () => {
    listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 1064, screenY: 2868 } } as never);
  });
  expect(scrollTo).toHaveBeenCalledWith({ y: 660, animated: true });
  await act(async () => {
    secondView.unmount();
  });
});

test('blurred and unmounted cloud fields are never revealed by a later keyboard show', async () => {
  const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: Parameters<typeof Keyboard.addListener>[0], listener: Parameters<typeof Keyboard.addListener>[1]) => {
    listeners.set(event, listener as (value: unknown) => void);
    return { remove: jest.fn() };
  }) as never);
  const contentNode = 123;
  jest.spyOn(ScrollView.prototype, 'getInnerViewNode').mockReturnValue(contentNode);
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  const measureLayout = jest.spyOn(TextInput.prototype, 'measureLayout').mockImplementation((relativeTo, onSuccess) => {
    expect(relativeTo).toBe(contentNode);
    onSuccess(0, 2000, 300, 48);
  });

  const renderFields = async (children: React.ReactNode) => {
    const view = await render(<CloudLibraryScroll>{children}</CloudLibraryScroll>);
    await fireEvent(screen.getByTestId('cloud-library-scroll'), 'layout', { nativeEvent: { layout: { height: 2868 } } });
    return view;
  };

  const blurView = await renderFields(
    <SettingsField testID="blur-field" accessibilityLabel="Field" placeholder="Field" value="" onChangeText={jest.fn()} />,
  );
  await fireEvent(screen.getByTestId('blur-field'), 'focus');
  await fireEvent(screen.getByTestId('blur-field'), 'blur');
  measureLayout.mockClear();
  scrollTo.mockClear();
  await act(async () => {
    listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 1064, screenY: 2868 } } as never);
  });
  expect(measureLayout).not.toHaveBeenCalled();
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => {
    blurView.unmount();
  });

  listeners.clear();
  let removeField!: () => void;
  function SwappableField() {
    const [visible, setVisible] = React.useState(true);
    removeField = () => setVisible(false);
    return visible
      ? <SettingsField testID="lifecycle-field" accessibilityLabel="Field" placeholder="Field" value="" onChangeText={jest.fn()} />
      : <Text>replacement</Text>;
  }
  const unmountView = await renderFields(<SwappableField />);
  await fireEvent(screen.getByTestId('lifecycle-field'), 'focus');
  await act(async () => {
    listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 1064, screenY: 2868 } } as never);
  });
  expect(measureLayout).toHaveBeenCalled();
  expect(scrollTo).toHaveBeenCalledWith({ y: 260, animated: true });

  measureLayout.mockClear();
  scrollTo.mockClear();
  await act(async () => {
    listeners.get('keyboardDidHide')?.({} as never);
  });
  await act(async () => {
    removeField();
  });
  await act(async () => {
    listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 1064, screenY: 2868 } } as never);
  });
  expect(measureLayout).not.toHaveBeenCalled();
  expect(scrollTo).not.toHaveBeenCalled();
  await act(async () => {
    unmountView.unmount();
  });
});

test('a taller native IME height reveals the focused password field when keyboardDidShow does not fire again', async () => {
  const viewportHeight = 2868;
  const textKeyboardHeight = 900;
  const secureKeyboardHeight = 997;
  const textTop = 2200;
  const passwordTop = 2400;
  const laterTop = 2700;
  const fieldHeight = 48;
  const reveal = (fieldTop: number, keyboardHeight: number) => scrollOffsetToReveal({
    fieldTop,
    fieldHeight,
    currentScrollOffset: 0,
    viewportHeight,
    keyboardHeight,
    bottomInset: 0,
    gap: KEYBOARD_REVEAL_GAP,
  });
  const textOffset = reveal(textTop, textKeyboardHeight);
  const passwordOffsetAtTextKeyboard = reveal(passwordTop, textKeyboardHeight);
  const passwordOffsetAtSecureKeyboard = reveal(passwordTop, secureKeyboardHeight);
  // The secure keyboard is taller, so the same field has to move further up.
  expect(passwordOffsetAtSecureKeyboard).toBeGreaterThan(passwordOffsetAtTextKeyboard);
  const keyboardTop = viewportHeight - secureKeyboardHeight;
  const passwordBottom = passwordTop + fieldHeight - passwordOffsetAtSecureKeyboard;
  expect(keyboardTop - passwordBottom).toBe(KEYBOARD_REVEAL_GAP);

  const listeners = new Map<string, Parameters<typeof Keyboard.addListener>[1]>();
  const keyboardListener = jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: Parameters<typeof Keyboard.addListener>[0], listener: Parameters<typeof Keyboard.addListener>[1]) => {
    listeners.set(event, listener as (value: unknown) => void);
    return { remove: jest.fn() };
  }) as never);
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  const contentNode = 123;
  const innerNode = jest.spyOn(ScrollView.prototype, 'getInnerViewNode').mockReturnValue(contentNode);
  const measureLayout = jest.spyOn(TextInput.prototype, 'measureLayout').mockImplementation(function (this: any, relativeTo, onSuccess) {
    expect(relativeTo).toBe(contentNode);
    const top = this.props?.testID === 'field-password'
      ? passwordTop
      : this.props?.testID === 'field-after'
        ? laterTop
        : textTop;
    onSuccess(0, top, 300, fieldHeight);
  });

  try {
    const view = await render(
      <CloudLibraryScroll>
        <SettingsField testID="field-text" accessibilityLabel="Address" placeholder="Address" value="" onChangeText={jest.fn()} />
        <SettingsField testID="field-password" accessibilityLabel="Password" placeholder="Password" value="" onChangeText={jest.fn()} secureTextEntry />
        <SettingsField testID="field-after" accessibilityLabel="Root" placeholder="Root" value="" onChangeText={jest.fn()} />
      </CloudLibraryScroll>,
    );
    expect(screen.getByTestId('field-password').props.secureTextEntry).toBe(true);
    await fireEvent(screen.getByTestId('cloud-library-scroll'), 'layout', { nativeEvent: { layout: { height: viewportHeight } } });
    await fireEvent(screen.getByTestId('field-text'), 'focus');
    let keyboardShows = 0;
    await act(async () => {
      keyboardShows += 1;
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: textKeyboardHeight, screenY: viewportHeight } } as never);
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: textOffset, animated: true });
    expect(screen.getByTestId('cloud-library-scroll').props.contentContainerStyle.paddingBottom)
      .toBe(metrics.gestureInset + metrics.spacing.large + textKeyboardHeight);

    scrollTo.mockClear();
    await fireEvent(screen.getByTestId('field-text'), 'blur');
    await fireEvent(screen.getByTestId('field-password'), 'focus');
    // No second keyboardDidShow: the password field is revealed for the text keyboard only.
    expect(keyboardShows).toBe(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: passwordOffsetAtTextKeyboard, animated: true });
    expect(scrollTo).not.toHaveBeenCalledWith({ y: passwordOffsetAtSecureKeyboard, animated: true });

    expect(mockImeHeightSink.listener).toEqual(expect.any(Function));
    await act(async () => {
      mockImeHeightSink.listener?.({ height: secureKeyboardHeight, visible: true });
    });
    expect(keyboardShows).toBe(1);
    expect(screen.getByTestId('cloud-library-scroll').props.contentContainerStyle.paddingBottom)
      .toBe(metrics.gestureInset + metrics.spacing.large + secureKeyboardHeight);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: passwordOffsetAtSecureKeyboard, animated: true });

    scrollTo.mockClear();
    await act(async () => {
      mockImeHeightSink.listener?.({ height: 0, visible: false });
    });
    expect(screen.getByTestId('cloud-library-scroll').props.contentContainerStyle.paddingBottom)
      .toBe(metrics.gestureInset + metrics.spacing.large);
    expect(scrollTo).not.toHaveBeenCalled();
    await fireEvent(screen.getByTestId('field-password'), 'blur');
    await fireEvent(screen.getByTestId('field-after'), 'focus');
    expect(scrollTo).not.toHaveBeenCalled();

    await act(async () => {
      view.unmount();
    });
    expect(mockImeHeightSink.remove).toHaveBeenCalled();
  } finally {
    keyboardListener.mockRestore();
    scrollTo.mockRestore();
    innerNode.mockRestore();
    measureLayout.mockRestore();
  }
});
