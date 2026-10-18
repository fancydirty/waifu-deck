import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import i18n from '@/i18n';
import { DiscoverSettingsScreen } from './discover-settings-screen';

let mockCurrentSettings: AppSettings = DEFAULT_SETTINGS;
let mockUpdateSettings: jest.Mock;

jest.mock('@/providers/app-services', () => ({
  useAppServices: () => ({ settings: mockCurrentSettings, updateSettings: mockUpdateSettings }),
}));
jest.mock('lucide-react-native', () => ({
  Check: () => null,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ChevronRight: (props: Record<string, unknown>) => require('react').createElement('View', { ...props, testID: 'chevron' }),
  Cloud: () => null,
  Lock: () => null,
}));

function statefulUpdater(initial: AppSettings = DEFAULT_SETTINGS, persistence = Promise.resolve()) {
  mockCurrentSettings = initial;
  let tail = Promise.resolve();
  return jest.fn((update: (current: AppSettings) => AppSettings) => {
    const next = tail.then(async () => {
      await persistence;
      mockCurrentSettings = update(mockCurrentSettings);
      return mockCurrentSettings;
    });
    tail = next.then(() => undefined, () => undefined);
    return next;
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mockUpdateSettings = statefulUpdater();
});

test('renders the Discover page root and only its six secondary controls', async () => {
  await render(<DiscoverSettingsScreen />);

  expect(screen.getByTestId('screen-settings-discover')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-discover-scroll')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-style-preference')).toBeOnTheScreen();
  expect(screen.getByTestId('image-orientation')).toBeOnTheScreen();
  expect(screen.getByTestId('animation')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-min-width')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-max-bytes')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-prefetch-depth')).toBeOnTheScreen();
  for (const id of ['settings-sources-entry', 'settings-adult-content-mode',
    'settings-blur-nsfw', 'settings-exclude-tags', 'settings-delete-all',
    'settings-cloud-card', 'byos-section', 'backup-restore']) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
  for (const label of ['Reset dismissed history', 'Reset discovery history', 'Delete all app data']) {
    expect(screen.queryByRole('button', { name: label })).toBeNull();
  }
  expect(screen.queryByText('More preferences')).toBeNull();
});

test('U2a six writes reach persistence through host presses', async () => {
  await render(<DiscoverSettingsScreen />);

  await userEvent.press(screen.getByRole('radio', { name: '3D style preference: Prefer 3D' }));
  await userEvent.press(screen.getByRole('radio', { name: 'Image orientation: Landscape' }));
  await userEvent.press(screen.getByRole('radio', { name: 'Animated images: Animated only' }));
  await userEvent.press(screen.getByRole('button', { name: 'Choose minimum width' }));
  expect(screen.getByRole('button', { name: 'No limit' })).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: '1080 px' }));
  await userEvent.press(screen.getByRole('button', { name: 'Choose maximum file size' }));
  expect(screen.getByRole('button', { name: 'No limit' })).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: '5 MB' }));
  await userEvent.press(screen.getByRole('radio', { name: 'Preload count: 60' }));

  await waitFor(() => expect(mockCurrentSettings).toEqual({
    ...DEFAULT_SETTINGS,
    stylePreference: 'prefer-3d',
    orientation: 'landscape',
    animationMode: 'only',
    minWidth: 1080,
    maxBytes: 5_000_000,
    prefetchDepth: 60,
  }));
  expect(mockUpdateSettings).toHaveBeenCalledTimes(6);
  expect(mockUpdateSettings.mock.calls.every(([value]) => typeof value === 'function')).toBe(true);
});

test('preserves all segmented options, default selections, and U1 segment geometry', async () => {
  await render(<DiscoverSettingsScreen />);

  for (const [label, options, selected] of [
    ['3D style preference', ['Any', 'Prefer 3D', 'Prefer 2D'], 'Any'],
    ['Image orientation', ['Portrait', 'Landscape', 'Any'], 'Portrait'],
    ['Animated images', ['Exclude', 'Include', 'Animated only'], 'Exclude'],
    ['Preload count', ['30', '40', '60'], '40'],
  ] as const) {
    expect(screen.getAllByRole('radio', { name: new RegExp(`^${label}:`) })
      .map((node) => node.props.accessibilityLabel)).toEqual(options.map((option) => `${label}: ${option}`));
    expect(screen.getByRole('radio', { name: `${label}: ${selected}` })).toBeChecked();
    expect(screen.getByLabelText(label)).toHaveStyle({ minHeight: 36 });
    expect(screen.getByRole('radio', { name: `${label}: ${selected}` })).toHaveStyle({
      marginVertical: -9,
      paddingVertical: 9,
    });
  }
});

test.each([
  ['settings-style-preference', 'stylePreference', '3D style preference: Prefer 3D', 'prefer-3d'],
  ['image-orientation', 'orientation', 'Image orientation: Landscape', 'landscape'],
  ['animation', 'animationMode', 'Animated images: Animated only', 'only'],
  ['settings-prefetch-depth', 'prefetchDepth', 'Preload count: 60', 60],
] as const)('%s displays its changed selection after settings publication and returning to the page', async (id, field, label, value) => {
  const view = await render(<DiscoverSettingsScreen />);
  await userEvent.press(screen.getByRole('radio', { name: label }));
  await waitFor(() => expect(mockCurrentSettings[field]).toBe(value));

  // Publish the persisted settings through a rerender of the service consumer.
  await view.rerender(<DiscoverSettingsScreen />);
  const group = within(screen.getByTestId(id));
  const selected = group.getByRole('radio', { name: label });
  expect(selected).toBeChecked();
  expect(group.getAllByRole('radio', { checked: true })).toEqual([selected]);

  // Leaving and opening the page again must retain the published selection.
  await view.unmount();
  await render(<DiscoverSettingsScreen />);
  const reopenedGroup = within(screen.getByTestId(id));
  const reopenedSelection = reopenedGroup.getByRole('radio', { name: label });
  expect(reopenedSelection).toBeChecked();
  expect(reopenedGroup.getAllByRole('radio', { checked: true })).toEqual([reopenedSelection]);
});

test('offers every numeric option and persists zero from both choice sheets', async () => {
  mockUpdateSettings = statefulUpdater({ ...DEFAULT_SETTINGS, minWidth: 1440, maxBytes: 10_000_000 });
  const view = await render(<DiscoverSettingsScreen />);

  await userEvent.press(screen.getByRole('button', { name: 'Choose minimum width' }));
  expect(screen.getAllByRole('button', { name: /^(No limit|\d+ px)$/ })
    .map((node) => node.props.accessibilityLabel)).toEqual(['No limit', '720 px', '1080 px', '1440 px']);
  await userEvent.press(screen.getByRole('button', { name: 'No limit' }));
  await waitFor(() => expect(mockCurrentSettings.minWidth).toBe(0));

  await userEvent.press(screen.getByRole('button', { name: 'Choose maximum file size' }));
  expect(screen.getAllByRole('button', { name: /^(No limit|\d+ MB)$/ })
    .map((node) => node.props.accessibilityLabel)).toEqual(['No limit', '2 MB', '5 MB', '10 MB']);
  await userEvent.press(screen.getByRole('button', { name: 'No limit' }));
  await waitFor(() => expect(mockCurrentSettings).toEqual(DEFAULT_SETTINGS));
  await view.rerender(<DiscoverSettingsScreen />);
  expect(screen.getAllByText('No limit')).toHaveLength(2);
  expect(mockUpdateSettings).toHaveBeenCalledTimes(2);
});

// Expected label/value pairs are independent of the production option tables,
// so a mislabeled value cannot change both the action and its expected result.
test.each([
  ['minWidth', '选择最小宽度', '不限', 0],
  ['minWidth', '选择最小宽度', '720 px', 720],
  ['minWidth', '选择最小宽度', '1080 px', 1080],
  ['minWidth', '选择最小宽度', '1440 px', 1440],
  ['maxBytes', '选择最大文件大小', '不限', 0],
  ['maxBytes', '选择最大文件大小', '2 MB', 2_000_000],
  ['maxBytes', '选择最大文件大小', '5 MB', 5_000_000],
  ['maxBytes', '选择最大文件大小', '10 MB', 10_000_000],
] as const)('%s choice %s → %s persists %s', async (field, chooser, label, value) => {
  await i18n.changeLanguage('zh-Hans');
  const initial = {
    ...DEFAULT_SETTINGS,
    [field]: value === 0 ? (field === 'minWidth' ? 1440 : 10_000_000) : 0,
  };
  mockUpdateSettings = statefulUpdater(initial);
  await render(<DiscoverSettingsScreen />);
  expect(mockCurrentSettings[field]).not.toBe(value);

  await userEvent.press(screen.getByRole('button', { name: chooser }));
  await userEvent.press(screen.getByRole('button', { name: label }));

  await waitFor(() => expect(mockCurrentSettings).toEqual({ ...initial, [field]: value }));
  expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
  expect(mockUpdateSettings.mock.calls[0][0]).toEqual(expect.any(Function));
});

test('shows saveError after a rejected save and retries without a busy lock', async () => {
  let attempts = 0;
  mockUpdateSettings = jest.fn((update: (current: AppSettings) => AppSettings) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error('nope'));
    mockCurrentSettings = update(mockCurrentSettings);
    return Promise.resolve(mockCurrentSettings);
  });
  await render(<DiscoverSettingsScreen />);

  const style = screen.getByRole('radio', { name: '3D style preference: Prefer 3D' });
  await userEvent.press(style);
  expect(style).toBeEnabled();
  expect(await screen.findByText('Settings could not be saved. Try again.')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-notice')).toHaveStyle({
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#F5EBE5',
    marginBottom: 0,
  });

  await userEvent.press(screen.getByRole('radio', { name: '3D style preference: Prefer 3D' }));
  await waitFor(() => expect(mockCurrentSettings.stylePreference).toBe('prefer-3d'));
  expect(screen.queryByText('Settings could not be saved. Try again.')).toBeNull();
});

test('queues two rapid functional writes while persistence is still unresolved', async () => {
  let release!: () => void;
  const persistence = new Promise<void>((resolve) => { release = resolve; });
  mockUpdateSettings = statefulUpdater(DEFAULT_SETTINGS, persistence);
  await render(<DiscoverSettingsScreen />);

  try {
    await userEvent.press(screen.getByRole('radio', { name: '3D style preference: Prefer 3D' }));
    expect(mockCurrentSettings).toEqual(DEFAULT_SETTINGS);
    expect(screen.getByRole('radio', { name: 'Image orientation: Landscape' })).toBeEnabled();
    await userEvent.press(screen.getByRole('radio', { name: 'Image orientation: Landscape' }));
    expect(mockCurrentSettings).toEqual(DEFAULT_SETTINGS);
    expect(mockUpdateSettings).toHaveBeenCalledTimes(2);
    expect(mockUpdateSettings.mock.calls.every(([update]) => typeof update === 'function')).toBe(true);
  } finally {
    await act(async () => { release(); });
  }
  await waitFor(() => expect(mockCurrentSettings).toEqual({
    ...DEFAULT_SETTINGS,
    stylePreference: 'prefer-3d',
    orientation: 'landscape',
  }));
});

test('renders the two discover cards in v4 order with style detail after its control', async () => {
  await render(<DiscoverSettingsScreen />);

  const first = screen.getByTestId('settings-discover-primary-group');
  const second = screen.getByTestId('settings-discover-secondary-group');
  expect(first).toHaveStyle({ marginHorizontal: 14 });
  expect(second).toHaveStyle({ marginHorizontal: 14, marginTop: 14 });
  const firstChildren = first.children.filter((child): child is TestInstance => typeof child !== 'string');
  const secondChildren = second.children.filter((child): child is TestInstance => typeof child !== 'string');
  expect(firstChildren).toHaveLength(3);
  expect(secondChildren).toHaveLength(3);
  const marker = (child: TestInstance) => ['settings-style-block', 'settings-orientation-block', 'settings-animation-block', 'settings-min-width', 'settings-max-bytes', 'settings-prefetch-block']
    .find((id) => child.queryAll((node) => node.props.testID === id).length > 0);
  expect(firstChildren.map(marker)).toEqual([
    'settings-style-block', 'settings-orientation-block', 'settings-animation-block',
  ]);
  expect(secondChildren.map(marker)).toEqual([
    'settings-min-width', 'settings-max-bytes', 'settings-prefetch-block',
  ]);
  expect(first.queryAll((node) => StyleSheet.flatten(node.props.style)?.borderTopWidth === 1)).toHaveLength(2);
  expect(second.queryAll((node) => StyleSheet.flatten(node.props.style)?.borderTopWidth === 1)).toHaveLength(2);
  expect(within(first).getByTestId('settings-style-block')).toBeOnTheScreen();
  expect(within(first).getByTestId('settings-orientation-block')).toBeOnTheScreen();
  expect(within(first).getByTestId('settings-animation-block')).toBeOnTheScreen();
  expect(within(second).getByTestId('settings-min-width')).toBeOnTheScreen();
  expect(within(second).getByTestId('settings-max-bytes')).toBeOnTheScreen();
  expect(within(second).getByTestId('settings-prefetch-block')).toBeOnTheScreen();
  expect(within(screen.getByTestId('settings-min-width')).getByText('No limit')).toBeOnTheScreen();
  expect(within(screen.getByTestId('settings-max-bytes')).getByText('No limit')).toBeOnTheScreen();
  expect(within(screen.getByTestId('settings-min-width')).getByTestId('chevron')).toBeOnTheScreen();
  expect(within(screen.getByTestId('settings-max-bytes')).getByTestId('chevron')).toBeOnTheScreen();

  const styleBlock = screen.getByTestId('settings-style-block');
  const styleControl = screen.getByTestId('settings-style-preference');
  const styleDetail = screen.getByText(i18n.t('settings.filters.stylePreferenceDetail'));
  expect(styleBlock.children.indexOf(styleControl)).toBeLessThan(styleBlock.children.indexOf(styleDetail));
  expect(styleDetail).toHaveStyle({ marginTop: 8 });
  expect(screen.getByTestId('screen-settings-discover')).toHaveStyle({ backgroundColor: '#FDF7F3' });
});

test('Discover composition keeps its visual roles in shared token components', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/screens/settings/discover-settings-screen.tsx'), 'utf8');
  expect(source).toContain('SettingsSubpageScroll');
  expect(source).toContain('SettingsGroup');
  expect(source).toContain('SettingsSegmentedControl');
  expect(source).toContain('settingsTypography.hint');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])/);
});

const discoverCopy = {
  en: {
    style: ['3D style preference', 'Applies to Danbooru, e621, and e926.', ['Any', 'Prefer 3D', 'Prefer 2D']],
    orientation: ['Image orientation', '', ['Portrait', 'Landscape', 'Any']],
    animation: ['Animated images', '', ['Exclude', 'Include', 'Animated only']],
    prefetch: ['Preload count', '', ['30', '40', '60']],
    minWidth: ['Minimum width', 'Choose minimum width'],
    maxBytes: ['Maximum file size', 'Choose maximum file size'],
  },
  'zh-Hans': {
    style: ['3D 风格偏好', '对 Danbooru、e621、e926 生效。', ['不限', '偏好 3D', '偏好 2D']],
    orientation: ['图片方向', '', ['纵向', '横向', '不限']],
    animation: ['动图', '', ['排除', '包含', '仅动图']],
    prefetch: ['预加载数量', '', ['30', '40', '60']],
    minWidth: ['最小宽度', '选择最小宽度'],
    maxBytes: ['最大文件大小', '选择最大文件大小'],
  },
  'zh-Hant': {
    style: ['3D 風格偏好', '對 Danbooru、e621、e926 生效。', ['不限', '偏好 3D', '偏好 2D']],
    orientation: ['圖片方向', '', ['直向', '橫向', '不限']],
    animation: ['動圖', '', ['排除', '包含', '僅動圖']],
    prefetch: ['預先載入數量', '', ['30', '40', '60']],
    minWidth: ['最小寬度', '選擇最小寬度'],
    maxBytes: ['檔案大小上限', '選擇檔案大小上限'],
  },
  ja: {
    style: ['3Dスタイルの優先設定', 'Danbooru、e621、e926 に適用されます。', ['指定なし', '3Dを優先', '2Dを優先']],
    orientation: ['画像の向き', '', ['縦向き', '横向き', '指定なし']],
    animation: ['アニメーション画像', '', ['除外', '含める', 'アニメーションのみ']],
    prefetch: ['先読み枚数', '', ['30', '40', '60']],
    minWidth: ['最小幅', '最小幅を選択'],
    maxBytes: ['最大ファイルサイズ', '最大ファイルサイズを選択'],
  },
} as const;

test.each(['en', 'zh-Hans', 'zh-Hant', 'ja'] as const)('%s keeps Discover labels, details and chooser names local', async (locale) => {
  await i18n.changeLanguage(locale);
  await render(<DiscoverSettingsScreen />);

  const expected = discoverCopy[locale];
  const separator = i18n.t('common.labelSeparator');
  const controls = [
    ['settings.filters.stylePreference', expected.style, 'settings-style-preference', 'stylePreference'],
    ['settings.filters.orientation', expected.orientation, 'image-orientation', 'orientation'],
    ['settings.filters.animation', expected.animation, 'animation', 'animation'],
    ['settings.storage.prefetchDepth', expected.prefetch, 'settings-prefetch-depth', 'prefetchDepth'],
  ] as const;
  for (const [titleKey, [title, detail, values], testId, resourceKey] of controls) {
    const group = screen.getByTestId(testId);
    expect(i18n.getResource(locale, 'translation', titleKey)).toBe(title);
    expect(screen.getByText(title)).toBeOnTheScreen();
    expect(group.props['aria-label']).toBe(title);
    expect(screen.getAllByRole('radio', { name: new RegExp(`^${title}${separator}`) }).map((node) => node.props.accessibilityLabel))
      .toEqual(values.map((value) => `${title}${separator}${value}`));
    if (detail) expect(i18n.getResource(locale, 'translation', 'settings.filters.stylePreferenceDetail')).toBe(detail);
    expect(within(group).getAllByRole('radio', { checked: true })).toHaveLength(1);
    if (resourceKey === 'stylePreference') expect(screen.getByText(detail)).toBeOnTheScreen();
  }
  expect(i18n.getResource(locale, 'translation', 'settings.quality.minimumWidth')).toBe(expected.minWidth[0]);
  expect(i18n.getResource(locale, 'translation', 'settings.quality.maximumFileSize')).toBe(expected.maxBytes[0]);
  expect(i18n.getResource(locale, 'translation', 'settings.quality.chooseMinimumWidth')).toBe(expected.minWidth[1]);
  expect(i18n.getResource(locale, 'translation', 'settings.quality.chooseMaximumFileSize')).toBe(expected.maxBytes[1]);
  expect(screen.getByText(expected.minWidth[0])).toBeOnTheScreen();
  expect(screen.getByText(expected.maxBytes[0])).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: expected.minWidth[1] })).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: expected.maxBytes[1] })).toBeOnTheScreen();
});
