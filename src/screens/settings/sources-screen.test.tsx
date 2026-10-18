import { act, fireEvent, render, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

import { createProviderRequestGovernor } from '@/features/providers/provider-resilience';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import i18n from '@/i18n';
import { colors } from '@/theme/colors';
import { SourcesScreen } from '@/screens/settings/sources-screen';

let mockAppServices: any;
const providerRequestGovernor = createProviderRequestGovernor();

/**
 * Passive forwarding spy (U2c2): the real row renders untouched, while the
 * callbacks Sources hands it are wrapped so a test can await what the real host
 * press actually returned.
 */
const mockRowCalls: { kind: 'save' | 'clear'; key: string; promise: Promise<boolean> }[] = [];
jest.mock('@/screens/settings/credential-provider-row', () => {
  const actual = jest.requireActual('@/screens/settings/credential-provider-row');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const Wrapped = (props: {
    adapter: { key: string };
    onSaveCredential(key: string, credential: unknown): Promise<boolean>;
    onClearCredential(key: string): Promise<boolean>;
  }) => React.createElement(actual.CredentialProviderRow, {
    ...props,
    onSaveCredential: (key: string, credential: unknown) => {
      const promise = props.onSaveCredential(key, credential);
      mockRowCalls.push({ kind: 'save', key, promise });
      return promise;
    },
    onClearCredential: (key: string) => {
      const promise = props.onClearCredential(key);
      mockRowCalls.push({ kind: 'clear', key, promise });
      return promise;
    },
  });
  return { ...actual, CredentialProviderRow: Wrapped };
});

beforeEach(async () => i18n.changeLanguage('zh-Hans'));

jest.mock('@/providers/app-services', () => ({
  useAppServices: () => mockAppServices,
}));

jest.mock('lucide-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const Icon = () => null;
  return {
    Archive: Icon,
    ArchiveRestore: Icon,
    Check: Icon,
    // U2c2: the saved clear row's chevron is shape-pinned, so it needs a host.
    ChevronRight: (props: Record<string, unknown>) => React.createElement(View, { ...props, testID: 'chevron' }),
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

function allHosts(): TestInstance[] {
  return screen.container.queryAll(() => true);
}

function indexTestId(list: TestInstance[], testID: string): number {
  return list.findIndex((node) => node.props.testID === testID);
}

function indexText(list: TestInstance[], text: string): number {
  return list.findIndex((node) => typeof node.props.children === 'string' && node.props.children === text);
}

/** The keyed rows' internal 1dp hair: a leaf View carrying only a top hair border. */
function hairLeafIndexes(list: TestInstance[]): number[] {
  return list.flatMap((node, index) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.borderTopWidth === 1 && style?.borderTopColor === colors.light.hair && node.children.length === 0
      ? [index]
      : [];
  });
}

function roundedCards(list: TestInstance[]): TestInstance[] {
  return list.filter((node) => StyleSheet.flatten(node.props.style)?.borderRadius === 14);
}

const SYNTHETIC_CREDENTIAL = { apiKey: 'u2-synthetic-key', userId: '0' };

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

type ServicesOverrides = {
  settings?: AppSettings;
  updateSettings?: jest.Mock;
  providerCredentials?: {
    snapshot: () => Record<string, { apiKey: string; userId: string }>;
    save: jest.Mock;
    clear: jest.Mock;
  };
};

function services(overrides: ServicesOverrides = {}) {
  return {
    settings: overrides.settings ?? DEFAULT_SETTINGS,
    updateSettings: overrides.updateSettings ?? createStatefulSettingsUpdater().updateSettings,
    providerCredentials: overrides.providerCredentials ?? {
      snapshot: () => ({}),
      save: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
    },
    providerRequestGovernor,
  };
}

/**
 * Fix round (drift review): the page's own copy is pinned in all four shipped
 * languages AND asserted against the render tree — a resource-only or
 * feed-the-formatter check cannot catch a wrong key at render time. Keyed-row
 * credential copy (inputs, save/clear, hint) stays with U2c2 and is not pinned.
 */
type SourcesPageCopy = {
  language: string;
  groups: [string, string, string];
  descriptions: Record<string, string>;
  enables: Record<string, string>;
  lastSourceNote: string;
};

const SOURCES_PAGE_COPY: SourcesPageCopy[] = [
  {
    language: 'zh-Hans',
    groups: ['综合动漫图站', '标签图站', '兽人图站'],
    descriptions: {
      waifu: '精选图库与完整标签',
      nekos: '更大的动漫图片池',
      danbooru: '大型标签图库与原作来源',
      safebooru: '以 SFW 为主的动漫标签图库',
      yandere: '标签丰富的动漫图库与原作来源',
      konachan: '高清动漫壁纸与插画',
      e621: '标签丰富的大型图站，附原作来源',
      e926: 'e621 的纯 SFW 镜像站',
      gelbooru: '大型标签图库，需要你的免费 API 密钥',
      rule34: '大型 NSFW 图板，需要你的免费 API 密钥',
    },
    enables: {
      waifu: '启用 Waifu.im',
      nekos: '启用 Nekos API',
      danbooru: '启用 Danbooru',
      safebooru: '启用 Safebooru',
      yandere: '启用 Yande.re',
      konachan: '启用 Konachan',
      e621: '启用 e621',
      e926: '启用 e926',
      gelbooru: '启用 Gelbooru',
      rule34: '启用 Rule34',
    },
    lastSourceNote: '至少保留一个来源开启。',
  },
  {
    language: 'zh-Hant',
    groups: ['綜合動漫圖站', '標籤圖站', '獸人圖站'],
    descriptions: {
      waifu: '精選圖庫與完整標籤',
      nekos: '更大的動漫圖片庫',
      danbooru: '大型標籤圖庫與原作來源',
      safebooru: '以 SFW 為主的動漫標籤圖庫',
      yandere: '標籤豐富的動漫圖庫與原作來源',
      konachan: '高清動漫桌布與插畫',
      e621: '標籤豐富的大型圖站，附原作來源',
      e926: 'e621 的純 SFW 鏡像站',
      gelbooru: '大型標籤圖庫，需要你的免費 API 金鑰',
      rule34: '大型 NSFW 圖板，需要你的免費 API 金鑰',
    },
    enables: {
      waifu: '啟用 Waifu.im',
      nekos: '啟用 Nekos API',
      danbooru: '啟用 Danbooru',
      safebooru: '啟用 Safebooru',
      yandere: '啟用 Yande.re',
      konachan: '啟用 Konachan',
      e621: '啟用 e621',
      e926: '啟用 e926',
      gelbooru: '啟用 Gelbooru',
      rule34: '啟用 Rule34',
    },
    lastSourceNote: '至少保留一個來源開啟。',
  },
  {
    language: 'ja',
    groups: ['総合アニメギャラリー', 'タグ付き掲示板', 'ケモノアート'],
    descriptions: {
      waifu: 'タグが充実した厳選ギャラリー',
      nekos: 'より多くのアニメ画像を収録',
      danbooru: '元の出典を備えた大規模なタグ付きギャラリー',
      safebooru: 'SFW中心のタグ付きアニメ画像ギャラリー',
      yandere: 'タグが充実したアニメ画像ギャラリー',
      konachan: '高解像度アニメ壁紙・イラスト',
      e621: 'タグが豊富な大規模イメージボード（原作リンク付き）',
      e926: 'e621のSFW専用ミラー',
      gelbooru: 'タグが豊富な大規模ギャラリー（無料APIキーが必要）',
      rule34: '大規模なNSFWイメージボード（無料APIキーが必要）',
    },
    enables: {
      waifu: 'Waifu.im を有効にする',
      nekos: 'Nekos API を有効にする',
      danbooru: 'Danbooru を有効にする',
      safebooru: 'Safebooru を有効にする',
      yandere: 'Yande.re を有効にする',
      konachan: 'Konachan を有効にする',
      e621: 'e621 を有効にする',
      e926: 'e926 を有効にする',
      gelbooru: 'Gelbooru を有効にする',
      rule34: 'Rule34 を有効にする',
    },
    lastSourceNote: '少なくとも 1 つのソースを有効にしてください。',
  },
  {
    language: 'en',
    groups: ['General anime galleries', 'Tagged imageboards', 'Furry-art sites'],
    descriptions: {
      waifu: 'Curated gallery with complete tags',
      nekos: 'A larger anime image pool',
      danbooru: 'Large tagged gallery with original sources',
      safebooru: 'SFW-focused tagged anime gallery',
      yandere: 'Tag-rich anime gallery with original sources',
      konachan: 'High-resolution anime wallpapers and illustrations',
      e621: 'Large tagged imageboard with original sources',
      e926: 'SFW-only mirror of e621',
      gelbooru: 'Large tagged gallery, requires your free API key',
      rule34: 'Large NSFW imageboard, requires your free API key',
    },
    enables: {
      waifu: 'Enable Waifu.im',
      nekos: 'Enable Nekos API',
      danbooru: 'Enable Danbooru',
      safebooru: 'Enable Safebooru',
      yandere: 'Enable Yande.re',
      konachan: 'Enable Konachan',
      e621: 'Enable e621',
      e926: 'Enable e926',
      gelbooru: 'Enable Gelbooru',
      rule34: 'Enable Rule34',
    },
    lastSourceNote: 'Keep at least one source enabled.',
  },
];

describe('image-sources sub-page', () => {
  test('U2c1 source groups keep the v4 cards, heading geometry and hint outside the cards', async () => {
    await i18n.changeLanguage('en');
    mockAppServices = services();
    await render(<SourcesScreen />);

    const scroll = screen.getByTestId('sources-scroll');
    expect(scroll).toHaveStyle({ backgroundColor: '#FDF7F3' });
    expect(scroll.props.contentContainerStyle).toEqual(expect.objectContaining({ paddingTop: 12 }));

    const groups = screen.container.queryAll((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.borderRadius === 14 && style?.marginHorizontal === 14;
    });
    expect(groups).toHaveLength(3);
    for (const group of groups) {
      const style = StyleSheet.flatten(group.props.style);
      expect(style.marginTop).toBeUndefined();
      expect(style.marginBottom).toBeUndefined();
      expect(style.marginVertical).toBeUndefined();
    }
    expect(groups.map((group) => within(group).getAllByRole('switch').map((host) => host.props.testID))).toEqual([
      ['provider-waifu-toggle', 'provider-nekos-toggle'],
      ['provider-danbooru-toggle', 'provider-safebooru-toggle', 'provider-yandere-toggle', 'provider-konachan-toggle'],
      ['provider-e621-toggle', 'provider-e926-toggle'],
    ]);

    const headings = ['General anime galleries', 'Tagged imageboards', 'Furry-art sites']
      .map((label) => screen.getByText(label));
    expect(headings[0]).toHaveStyle({ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8 });
    expect(headings[1]).toHaveStyle({ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 });
    expect(headings[2]).toHaveStyle({ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 });
    expect(screen.getByTestId('sources-last-source-note')).toHaveStyle({
      marginHorizontal: 14, marginTop: 12, fontSize: 12.5, lineHeight: 18.75,
    });
    expect(groups.every((group) => group.queryAll((node) => node.props.testID === 'sources-last-source-note').length === 0)).toBe(true);
  });

  test('source composition uses the shared shell and row primitives', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/screens/settings/sources-screen.tsx'), 'utf8');
    expect(source).toContain('SettingsSubpageScroll');
    expect(source).toContain('SettingsGroup');
    expect(source).toContain('SettingsRow');
    expect(source).toContain('settingsTypography.hint');
    expect(source).not.toContain('SettingRow');
    expect(source).not.toContain('control={');
    expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
    expect(source).not.toMatch(/font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])/);
  });

  test('governor publication updates ordinary detail without remounting the source page', async () => {
    await i18n.changeLanguage('en');
    mockAppServices = services();
    await render(<SourcesScreen />);
    expect(screen.getByText('A larger anime image pool · No images fetched yet')).toBeOnTheScreen();

    await act(async () => { await providerRequestGovernor.execute('nekos_api', async () => 'ok'); });
    await waitFor(() => expect(screen.getByText('A larger anime image pool · Connected')).toBeOnTheScreen());
  });

  test('U2c1 ordinary provider presses preserve health and last-source policy', async () => {
    await i18n.changeLanguage('en');
    await providerRequestGovernor.execute('waifu_im', async () => 'ok');
    const heldSave = deferred<AppSettings>();
    const updateSettings = jest.fn(() => heldSave.promise);
    mockAppServices = services({ updateSettings });
    const view = await render(<SourcesScreen />);

    await userEvent.press(screen.getByRole('switch', { name: 'Enable Nekos API' }));
    expect(screen.getByText('Curated gallery with complete tags · Connected')).toBeOnTheScreen();
    expect(screen.getByTestId('provider-waifu-toggle')).toBeDisabled();
    expect(StyleSheet.flatten(screen.getByTestId('provider-waifu-toggle').props.style).opacity).toBe(1);
    await act(async () => heldSave.resolve(DEFAULT_SETTINGS));
    await view.unmount();

    const onlyWaifu = {
      ...DEFAULT_SETTINGS,
      providers: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.providers)
        .map((key) => [key, key === 'waifu_im'])) as AppSettings['providers'],
    };
    mockAppServices = services({ settings: onlyWaifu, updateSettings: jest.fn(async () => onlyWaifu) });
    const lastView = await render(<SourcesScreen />);
    const last = screen.getByTestId('provider-waifu-toggle');
    expect(last).toBeDisabled();
    expect(StyleSheet.flatten(last.props.style).opacity).toBe(0.38);
    await userEvent.press(last);
    expect(mockAppServices.updateSettings).not.toHaveBeenCalled();
    await lastView.unmount();
  });

  test('groups the ten sources under general / booru / furry headings', async () => {
    await i18n.changeLanguage('en');
    mockAppServices = services();
    await render(<SourcesScreen />);

    expect(screen.getByText('General anime galleries')).toBeOnTheScreen();
    expect(screen.getByText('Tagged imageboards')).toBeOnTheScreen();
    expect(screen.getByText('Furry-art sites')).toBeOnTheScreen();
    expect(screen.getByText('Waifu.im')).toBeOnTheScreen();
    expect(screen.getByText('Yande.re')).toBeOnTheScreen();
    expect(screen.getByText('Keep at least one source enabled.')).toBeOnTheScreen();
  });

  test('U2c1 all ten source titles keep registry order and their group card', async () => {
    await i18n.changeLanguage('en');
    mockAppServices = services();
    await render(<SourcesScreen />);

    const groups = screen.container.queryAll((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.borderRadius === 14 && style?.marginHorizontal === 14;
    });
    const titleHost = /^(Waifu\.im|Nekos API|Danbooru|Safebooru|Yande\.re|Konachan|Gelbooru|Rule34|e621|e926)$/;
    // Exact order AND card membership for all ten rows — including the keyed
    // Gelbooru/Rule34 titles, which ride CredentialProviderRow instead of the
    // ordinary row. The keyed rows belong to the booru card, after Konachan.
    expect(groups.map((group) => within(group)
      .getAllByText(titleHost)
      .map((host) => String(host.props.children)))).toEqual([
      ['Waifu.im', 'Nekos API'],
      ['Danbooru', 'Safebooru', 'Yande.re', 'Konachan', 'Gelbooru', 'Rule34'],
      ['e621', 'e926'],
    ]);
  });

  test.each(SOURCES_PAGE_COPY)(
    'U2c1 renders its own page copy in $language',
    async ({ language, groups, descriptions, enables, lastSourceNote }) => {
      await i18n.changeLanguage(language);
      // Saved keys put Gelbooru/Rule34 into their toggle state so every row's
      // description and every switch's accessibility name can be checked.
      mockAppServices = services({
        settings: {
          ...DEFAULT_SETTINGS,
          providers: { ...DEFAULT_SETTINGS.providers, gelbooru: true, rule34: true },
        },
        providerCredentials: {
          snapshot: () => ({
            gelbooru: { apiKey: 'fake-key', userId: 'fake-user' },
            rule34: { apiKey: 'fake-key', userId: 'fake-user' },
          }),
          save: jest.fn(),
          clear: jest.fn(),
        },
      });
      await render(<SourcesScreen />);

      for (const heading of groups) {
        expect(screen.getByText(heading)).toBeOnTheScreen();
      }
      for (const description of Object.values(descriptions)) {
        // Row detail is `description · <health>` plus an optional availability
        // note — pin the description copy as it renders, not via the formatter.
        expect(screen.getByText(description, { exact: false })).toBeOnTheScreen();
      }
      for (const name of Object.values(enables)) {
        expect(screen.getByRole('switch', { name })).toBeOnTheScreen();
      }
      expect(screen.getByText(lastSourceNote)).toBeOnTheScreen();
    },
  );

  test('persists provider switches and prevents disabling the last source', async () => {
    const stateful = createStatefulSettingsUpdater();
    mockAppServices = services({ updateSettings: stateful.updateSettings });
    const view = await render(<SourcesScreen />);

    expect(screen.getByRole('switch', { name: '启用 Waifu.im' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 Nekos API' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 Danbooru' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 Safebooru' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 Yande.re' })).toBeChecked();
    await userEvent.press(screen.getByRole('switch', { name: '启用 Nekos API' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: true,
      safebooru: true,
      yandere: true,
      konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    await userEvent.press(screen.getByRole('switch', { name: '启用 Danbooru' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: false,
      safebooru: true,
      yandere: true,
      konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    await userEvent.press(screen.getByRole('switch', { name: '启用 Safebooru' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: true,
      konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    await userEvent.press(screen.getByRole('switch', { name: '启用 Yande.re' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: true, e621: true, e926: true, gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    await userEvent.press(screen.getByRole('switch', { name: '启用 Konachan' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false,
      e621: true,
      e926: true,
      gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    await userEvent.press(screen.getByRole('switch', { name: '启用 e926' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false,
      e621: true,
      e926: false,
      gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    await userEvent.press(screen.getByRole('switch', { name: '启用 e621' }));
    await waitFor(() => expect(stateful.getCurrent().providers).toEqual({
      waifu_im: true,
      nekos_api: false,
      danbooru: false,
      safebooru: false,
      yandere: false,
      konachan: false,
      e621: false,
      e926: false,
      gelbooru: false, rule34: false,
    }));

    mockAppServices = services({
      settings: stateful.getCurrent(),
      updateSettings: stateful.updateSettings,
    });
    await view.rerender(<SourcesScreen />);
    expect(screen.getByRole('switch', { name: '启用 Waifu.im' })).toBeDisabled();
  });

  test('keeps an optimistic switch value stable while persistence is pending', async () => {
    const heldSave = deferred<AppSettings>();
    const updateSettings = jest.fn(() => heldSave.promise);
    mockAppServices = services({ updateSettings });
    const view = await render(<SourcesScreen />);

    await userEvent.press(screen.getByRole('switch', { name: '启用 Nekos API' }));

    expect(screen.getByRole('switch', { name: '启用 Nekos API' })).not.toBeChecked();
    for (const label of [
      '启用 Waifu.im',
      '启用 Nekos API',
      '启用 Danbooru',
      '启用 Safebooru',
      '启用 Yande.re',
    ]) {
      expect(screen.getByRole('switch', { name: label })).toBeDisabled();
    }

    const savedSettings = {
      ...DEFAULT_SETTINGS,
      providers: { ...DEFAULT_SETTINGS.providers, nekos_api: false },
    };
    await act(async () => heldSave.resolve(savedSettings));

    expect(screen.getByRole('switch', { name: '启用 Nekos API' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 Nekos API' })).toBeEnabled();

    mockAppServices = services({ settings: savedSettings, updateSettings });
    await view.rerender(<SourcesScreen />);
    expect(screen.getByRole('switch', { name: '启用 Nekos API' })).not.toBeChecked();
  });

  test('keeps every provider toggle opaque and locked while a provider save is held', async () => {
    const heldSave = deferred<AppSettings>();
    const updateSettings = jest.fn(() => heldSave.promise);
    mockAppServices = services({ updateSettings });
    const view = await render(<SourcesScreen />);

    await userEvent.press(screen.getByTestId('provider-nekos-toggle'));
    expect(screen.getByTestId('provider-nekos-toggle')).not.toBeChecked();
    const toggles = screen.getAllByRole('switch');
    expect(toggles).toHaveLength(8);
    for (const host of toggles) {
      expect(host).toBeDisabled();
      expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
      await userEvent.press(host);
    }
    expect(updateSettings).toHaveBeenCalledTimes(1);

    const savedSettings = {
      ...DEFAULT_SETTINGS,
      providers: { ...DEFAULT_SETTINGS.providers, nekos_api: false },
    };
    await act(async () => { heldSave.resolve(savedSettings); });
    mockAppServices = services({ settings: savedSettings, updateSettings });
    await view.rerender(<SourcesScreen />);
    for (const host of screen.getAllByRole('switch')) {
      expect(host).toBeEnabled();
      expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
    }
  });

  test('keeps the last enabled provider toggle disabled and dimmed', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providers: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.providers)
        .map((key) => [key, key === 'waifu_im'])) as AppSettings['providers'],
    };
    const updateSettings = jest.fn(async () => settings);
    mockAppServices = services({ settings, updateSettings });
    await render(<SourcesScreen />);
    const host = screen.getByTestId('provider-waifu-toggle');

    expect(host).toBeDisabled();
    expect(StyleSheet.flatten(host.props.style).opacity).toBe(0.38);
    await userEvent.press(host);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test('a keyed row without a key is unchanged', async () => {
    await i18n.changeLanguage('en');
    mockAppServices = services(); // DEFAULT_SETTINGS: gelbooru disabled, no key
    await render(<SourcesScreen />);

    expect(screen.getByTestId('provider-gelbooru-credential-apikey')).toBeOnTheScreen();
    expect(screen.getByTestId('provider-gelbooru-credential-userid')).toBeOnTheScreen();
    expect(screen.queryByTestId('provider-gelbooru-toggle')).not.toBeOnTheScreen();
    expect(screen.getByText(/Saving your key enables this source.*gelbooru\.com/i)).toBeOnTheScreen();
  });

  test('keeps the credential save button disabled until both apikey and userid are filled', async () => {
    mockAppServices = services(); // DEFAULT_SETTINGS: gelbooru disabled, no key
    await render(<SourcesScreen />);

    const saveButton = () => screen.getByTestId('provider-gelbooru-credential-save');
    expect(saveButton().props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-apikey'), 'k'.repeat(32));
    expect(saveButton().props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-userid'), '2047386');
    expect(saveButton().props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
  });

  test('saving a credential stores it AND enables the source via the normal settings path', async () => {
    const saveCredential = jest.fn(async () => undefined);
    const stateful = createStatefulSettingsUpdater();
    mockAppServices = services({
      updateSettings: stateful.updateSettings,
      providerCredentials: { snapshot: () => ({}), save: saveCredential, clear: jest.fn() },
    });
    await render(<SourcesScreen />);

    await fireEvent.changeText(
      screen.getByTestId('provider-gelbooru-credential-apikey'),
      'k'.repeat(128),
    );
    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-userid'), '2047386');
    await fireEvent.press(screen.getByTestId('provider-gelbooru-credential-save'));

    await waitFor(() => expect(saveCredential).toHaveBeenCalledWith('gelbooru', {
      apiKey: 'k'.repeat(128),
      userId: '2047386',
    }));
    await waitFor(() => expect(stateful.getCurrent().providers.gelbooru).toBe(true));
  });

  test('a keyed source shows a masked state + clear, never echoes the key, keeps its toggle', async () => {
    await i18n.changeLanguage('en');
    const clearCredential = jest.fn(async () => undefined);
    const settings = {
      ...DEFAULT_SETTINGS,
      providers: { ...DEFAULT_SETTINGS.providers, gelbooru: true },
    };
    const stateful = createStatefulSettingsUpdater(settings);
    mockAppServices = services({
      settings,
      updateSettings: stateful.updateSettings,
      providerCredentials: {
        snapshot: () => ({ gelbooru: { apiKey: 'SECRET_KEY_VALUE', userId: '2047386' } }),
        save: jest.fn(),
        clear: clearCredential,
      },
    });
    await render(<SourcesScreen />);

    expect(screen.queryByText(/SECRET_KEY_VALUE/)).not.toBeOnTheScreen();
    expect(screen.getByText(/key saved/i)).toBeOnTheScreen();
    expect(screen.getByTestId('provider-gelbooru-toggle')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('provider-gelbooru-credential-clear'));

    await waitFor(() => expect(clearCredential).toHaveBeenCalledWith('gelbooru'));
    await waitFor(() => expect(stateful.getCurrent().providers.gelbooru).toBe(false));
  });

  test('a keyed row with a saved key shows its health', async () => {
    await i18n.changeLanguage('zh-Hans');
    await providerRequestGovernor.execute('gelbooru', async () => 'ok');
    const settings = {
      ...DEFAULT_SETTINGS,
      providers: { ...DEFAULT_SETTINGS.providers, gelbooru: true },
    };
    mockAppServices = services({
      settings,
      providerCredentials: {
        snapshot: () => ({ gelbooru: { apiKey: 'fake-key', userId: 'fake-user' } }),
        save: jest.fn(),
        clear: jest.fn(),
      },
    });
    await render(<SourcesScreen />);

    expect(screen.getByText(
      '大型标签图库，需要你的免费 API 密钥 · 连接正常',
      { exact: false },
    )).toBeOnTheScreen();
  });

  test('Rule34 in 仅 SFW shows its NSFW-only note', async () => {
    mockAppServices = services({
      settings: {
        ...DEFAULT_SETTINGS,
        providers: { ...DEFAULT_SETTINGS.providers, rule34: true },
        nsfwMode: 'sfw',
      },
      providerCredentials: {
        snapshot: () => ({ rule34: { apiKey: 'fake-key', userId: 'fake-user' } }),
        save: jest.fn(),
        clear: jest.fn(),
      },
    });
    await render(<SourcesScreen />);

    expect(screen.getByText(
      'Rule34 只有成人内容，在仅 SFW 模式下不参与。',
      { exact: false },
    )).toBeOnTheScreen();
  });

  test('the sources ScrollView keeps taps while a field has focus', async () => {
    mockAppServices = services();
    await render(<SourcesScreen />);
    expect(screen.getByTestId('sources-scroll').props.keyboardShouldPersistTaps)
      .toBe('handled');
  });

  test('disables the credential clear button when it is the last enabled source', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providers: {
        waifu_im: false,
        nekos_api: false,
        danbooru: false,
        safebooru: false,
        yandere: false,
        konachan: false,
        e621: false,
        e926: false,
        gelbooru: true,
        rule34: false,
      },
    };
    mockAppServices = services({
      settings,
      providerCredentials: {
        snapshot: () => ({ gelbooru: { apiKey: 'k'.repeat(20), userId: '2047386' } }),
        save: jest.fn(),
        clear: jest.fn(),
      },
    });
    await render(<SourcesScreen />);

    expect(screen.getByTestId('provider-gelbooru-credential-clear').props.accessibilityState)
      .toEqual(expect.objectContaining({ disabled: true }));
  });

  test('shows an honest note on Konachan when portrait orientation makes it unavailable', async () => {
    mockAppServices = services(); // DEFAULT_SETTINGS: orientation 'portrait'
    await render(<SourcesScreen />);

    expect(screen.getByText(
      'Konachan 没有竖屏图片。把方向改为横屏或任意即可看到它。',
      { exact: false },
    )).toBeOnTheScreen();
    // The toggle stays user-controlled — explain, never silently disable.
    expect(screen.getByRole('switch', { name: '启用 Konachan' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 Konachan' })).toBeEnabled();
  });

  test('hides the Konachan note once orientation allows it to serve results', async () => {
    mockAppServices = services({
      settings: { ...DEFAULT_SETTINGS, orientation: 'landscape' },
    });
    await render(<SourcesScreen />);

    expect(screen.queryByText(
      'Konachan 没有竖屏图片。把方向改为横屏或任意即可看到它。',
      { exact: false },
    )).not.toBeOnTheScreen();
  });

  test('shows an honest note on e926 when nsfw mode makes it sit out', async () => {
    mockAppServices = services({
      settings: { ...DEFAULT_SETTINGS, nsfwMode: 'nsfw', nsfwConfirmed: true },
    });
    await render(<SourcesScreen />);

    expect(screen.getByText(
      'e926 只有 SFW 内容，在 NSFW 模式下不参与。',
      { exact: false },
    )).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: '启用 e926' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用 e926' })).toBeEnabled();
  });

  test('does not show the e926 note under sfw or mixed nsfw modes', async () => {
    mockAppServices = services(); // DEFAULT_SETTINGS: nsfwMode 'sfw'
    await render(<SourcesScreen />);

    expect(screen.queryByText(
      'e926 只有 SFW 内容，在 NSFW 模式下不参与。',
      { exact: false },
    )).not.toBeOnTheScreen();
  });

  test('R8.23: shows the furry-blocked reason on both e621 and e926 rows', async () => {
    mockAppServices = services({
      settings: { ...DEFAULT_SETTINGS, excludedTags: ['furry'] },
    });
    await render(<SourcesScreen />);

    expect(screen.getAllByText(
      '已屏蔽 furry：e621/e926 是兽人图站，「发现」不再从这里取图。',
      { exact: false },
    )).toHaveLength(2);
    // Explain, never silently disable — both toggles stay user-controlled.
    for (const name of ['启用 e621', '启用 e926']) {
      expect(screen.getByRole('switch', { name })).toBeChecked();
      expect(screen.getByRole('switch', { name })).toBeEnabled();
    }
  });

  test('R8.23: no furry note when furry is not among the blocked tags', async () => {
    mockAppServices = services({
      settings: { ...DEFAULT_SETTINGS, excludedTags: ['loli'] },
    });
    await render(<SourcesScreen />);

    expect(screen.queryByText(
      '已屏蔽 furry：e621/e926 是兽人图站，「发现」不再从这里取图。',
      { exact: false },
    )).not.toBeOnTheScreen();
  });

  test('U2c2 keyed card children match the v4 saved and keyless states', async () => {
    await i18n.changeLanguage('en');
    await providerRequestGovernor.execute('gelbooru', async () => 'ok');
    mockAppServices = services({
      settings: { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, gelbooru: true } },
      providerCredentials: {
        snapshot: () => ({ gelbooru: SYNTHETIC_CREDENTIAL }),
        save: jest.fn(),
        clear: jest.fn(),
      },
    });
    await render(<SourcesScreen />);

    // Full health text stays an independently discoverable Text (search-late
    // finds the longest Text containing the provider description).
    expect(screen.getByText('Large tagged gallery, requires your free API key · Connected')).toBeOnTheScreen();

    const hosts = allHosts();
    const hairs = hairLeafIndexes(hosts);
    // One internal hair per keyed row: saved Gelbooru and keyless Rule34.
    expect(hairs).toHaveLength(2);

    // Saved Gelbooru: title → toggle → hair → masked clear with chevron.
    const gelbooruToggle = indexTestId(hosts, 'provider-gelbooru-toggle');
    const gelbooruClear = indexTestId(hosts, 'provider-gelbooru-credential-clear');
    const savedOrder = [
      indexText(hosts, 'Gelbooru'),
      gelbooruToggle,
      hairs.find((index) => index > gelbooruToggle && index < gelbooruClear)!,
      gelbooruClear,
    ];
    expect(savedOrder.every((index) => index >= 0)).toBe(true);
    expect([...savedOrder].sort((a, b) => a - b)).toEqual(savedOrder);
    expect(screen.getByTestId('provider-gelbooru-credential-clear')
      .queryAll((node) => node.props.testID === 'chevron')).toHaveLength(1);

    // Keyless Rule34: title/Off → hair → API/user/help/button, no toggle.
    expect(screen.queryByTestId('provider-rule34-toggle')).toBeNull();
    const rule34Apikey = indexTestId(hosts, 'provider-rule34-credential-apikey');
    const rule34Hairs = hairs.filter((index) => index < rule34Apikey);
    const keylessOrder = [
      indexText(hosts, 'Rule34'),
      rule34Hairs[rule34Hairs.length - 1]!,
      rule34Apikey,
      indexTestId(hosts, 'provider-rule34-credential-userid'),
      indexText(hosts, 'Saving your key enables this source. Get a free key from your rule34.xxx account settings.'),
      indexTestId(hosts, 'provider-rule34-credential-save'),
    ];
    expect(keylessOrder.every((index) => index >= 0)).toBe(true);
    expect([...keylessOrder].sort((a, b) => a - b)).toEqual(keylessOrder);

    // No extra rounded card: the outer registry card owns the only border.
    expect(roundedCards(hosts)).toHaveLength(3);
    const block = screen.getByTestId('provider-rule34-credential-apikey').parent!;
    expect(block).toHaveStyle({ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 });
    expect(StyleSheet.flatten(block.props.style).borderRadius).toBeUndefined();
    expect(StyleSheet.flatten(block.props.style).borderWidth).toBeUndefined();
    let ancestor: TestInstance | null = screen.getByTestId('provider-rule34-credential-save');
    let insideGroup = false;
    while (ancestor !== null) {
      if (StyleSheet.flatten(ancestor.props.style)?.borderRadius === 14) insideGroup = true;
      ancestor = ancestor.parent;
    }
    expect(insideGroup).toBe(true);

    // Save frame stays inside the Block/group: 34 draw + 14 frame extension.
    const save = screen.getByTestId('provider-rule34-credential-save');
    expect(save).toHaveStyle({ marginVertical: -7, paddingVertical: 7 });
    expect(save.queryAll((node) => StyleSheet.flatten(node.props.style)?.minHeight === 34)).toHaveLength(1);

    // Compatibility export identity: the home re-exports the extracted row.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const extracted = require('./credential-provider-row');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const home = require('./settings-screen');
    expect(home.CredentialProviderRow).toBe(extracted.CredentialProviderRow);
  });

  test('U2c2 ordinary and keyed held toggle writes lock each other without dimming', async () => {
    const heldSave = deferred<AppSettings>();
    const updateSettings = jest.fn(() => heldSave.promise);
    mockAppServices = services({
      settings: { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers, gelbooru: true } },
      updateSettings,
      providerCredentials: {
        snapshot: () => ({ gelbooru: SYNTHETIC_CREDENTIAL }),
        save: jest.fn(),
        clear: jest.fn(),
      },
    });
    const view = await render(<SourcesScreen />);

    // A held ordinary write locks the keyed toggle without dimming it.
    await userEvent.press(screen.getByTestId('provider-nekos-toggle'));
    const keyed = screen.getByTestId('provider-gelbooru-toggle');
    expect(keyed).toBeDisabled();
    expect(StyleSheet.flatten(keyed.props.style).opacity).toBe(1);
    await userEvent.press(keyed);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    await act(async () => { heldSave.resolve(DEFAULT_SETTINGS); });

    // A held keyed write locks the ordinary toggles without dimming them.
    const heldKeyed = deferred<AppSettings>();
    updateSettings.mockImplementation(() => heldKeyed.promise);
    await userEvent.press(screen.getByTestId('provider-gelbooru-toggle'));
    const ordinary = screen.getByTestId('provider-nekos-toggle');
    expect(ordinary).toBeDisabled();
    expect(StyleSheet.flatten(ordinary.props.style).opacity).toBe(1);
    await userEvent.press(ordinary);
    expect(updateSettings).toHaveBeenCalledTimes(2);
    await act(async () => { heldKeyed.resolve(DEFAULT_SETTINGS); });
    await view.unmount();

    // The natural keyed last source dims both controls and swallows presses.
    const onlyGelbooru = {
      ...DEFAULT_SETTINGS,
      providers: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.providers)
        .map((key) => [key, key === 'gelbooru'])) as AppSettings['providers'],
    };
    const lastUpdate = jest.fn(async () => onlyGelbooru);
    const lastClear = jest.fn(async () => undefined);
    mockAppServices = services({
      settings: onlyGelbooru,
      updateSettings: lastUpdate,
      providerCredentials: {
        snapshot: () => ({ gelbooru: SYNTHETIC_CREDENTIAL }),
        save: jest.fn(),
        clear: lastClear,
      },
    });
    await render(<SourcesScreen />);
    const lastToggle = screen.getByTestId('provider-gelbooru-toggle');
    const lastClearRow = screen.getByTestId('provider-gelbooru-credential-clear');
    expect(lastToggle).toBeDisabled();
    expect(StyleSheet.flatten(lastToggle.props.style).opacity).toBe(0.38);
    expect(lastClearRow).toBeDisabled();
    await userEvent.press(lastToggle);
    await userEvent.press(lastClearRow);
    expect(lastUpdate).not.toHaveBeenCalled();
    expect(lastClear).not.toHaveBeenCalled();
  });

  test('U2c2 Sources converts credential and settings failures to false', async () => {
    const stateful = createStatefulSettingsUpdater();
    let updateMode: 'reject' | 'stateful' = 'stateful';
    const updateSettings = jest.fn((update: unknown) => {
      if (updateMode === 'reject') return Promise.reject(new Error('settings store down'));
      return stateful.updateSettings(update);
    });
    let credentialMode: 'reject' | 'ok' = 'ok';
    const saveCredential = jest.fn(async () => {
      if (credentialMode === 'reject') throw new Error('credential service down');
    });
    const clearCredential = jest.fn(async () => {
      if (credentialMode === 'reject') throw new Error('credential service down');
    });
    let snapshot: Record<string, { apiKey: string; userId: string }> = {};
    const providerCredentials = {
      snapshot: () => snapshot,
      save: saveCredential,
      clear: clearCredential,
    };
    mockAppServices = services({ updateSettings, providerCredentials });
    const view = await render(<SourcesScreen />);

    // 1. credential-service save rejects → the row's save callback resolves false.
    credentialMode = 'reject';
    mockRowCalls.length = 0;
    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-apikey'), 'u2-synthetic-key');
    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-userid'), '0');
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-save'));
    expect(mockRowCalls).toHaveLength(1);
    expect(mockRowCalls[0]!.kind).toBe('save');
    await expect(mockRowCalls[0]!.promise).resolves.toBe(false);
    await act(async () => {});
    // Keyless inputs retained, controls unlocked, retryable.
    expect(screen.getByTestId('provider-gelbooru-credential-apikey').props.value).toBe('u2-synthetic-key');
    expect(screen.getByTestId('provider-gelbooru-credential-userid').props.value).toBe('0');
    expect(screen.getByTestId('provider-gelbooru-credential-save')).toBeEnabled();
    credentialMode = 'ok';
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-save'));
    expect(mockRowCalls).toHaveLength(2);
    await expect(mockRowCalls[1]!.promise).resolves.toBe(true);
    await act(async () => {});
    expect(saveCredential).toHaveBeenCalledTimes(2);
    expect(stateful.getCurrent().providers.gelbooru).toBe(true);
    expect(screen.getByTestId('provider-gelbooru-credential-apikey').props.value).toBe('');
    await view.unmount();

    // 2. credential-service clear rejects → the row's clear callback resolves false.
    credentialMode = 'reject';
    mockAppServices = services({ updateSettings, providerCredentials });
    snapshot = { gelbooru: SYNTHETIC_CREDENTIAL };
    const savedView = await render(<SourcesScreen />);
    mockRowCalls.length = 0;
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-clear'));
    expect(mockRowCalls).toHaveLength(1);
    expect(mockRowCalls[0]!.kind).toBe('clear');
    await expect(mockRowCalls[0]!.promise).resolves.toBe(false);
    await act(async () => {});
    // Saved state kept by the snapshot, clear unlocked and retryable.
    expect(screen.getByTestId('provider-gelbooru-credential-clear')).toBeEnabled();
    expect(screen.getByText('•••• 密钥已保存')).toBeOnTheScreen();
    credentialMode = 'ok';
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-clear'));
    expect(mockRowCalls).toHaveLength(2);
    await expect(mockRowCalls[1]!.promise).resolves.toBe(true);
    await act(async () => {});
    expect(clearCredential).toHaveBeenCalledTimes(2);
    await savedView.unmount();

    // 3. updateSettings rejects after a successful credential save → false.
    updateMode = 'reject';
    snapshot = {};
    mockAppServices = services({ updateSettings, providerCredentials });
    const retryView = await render(<SourcesScreen />);
    mockRowCalls.length = 0;
    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-apikey'), 'u2-synthetic-key');
    await fireEvent.changeText(screen.getByTestId('provider-gelbooru-credential-userid'), '0');
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-save'));
    expect(mockRowCalls).toHaveLength(1);
    await expect(mockRowCalls[0]!.promise).resolves.toBe(false);
    await act(async () => {});
    // The credential layer succeeded; only the settings write failed.
    expect(saveCredential).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('provider-gelbooru-credential-apikey').props.value).toBe('u2-synthetic-key');
    expect(screen.getByTestId('provider-gelbooru-credential-save')).toBeEnabled();
    updateMode = 'stateful';
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-save'));
    expect(mockRowCalls).toHaveLength(2);
    await expect(mockRowCalls[1]!.promise).resolves.toBe(true);
    await act(async () => {});
    expect(stateful.getCurrent().providers.gelbooru).toBe(true);
    await retryView.unmount();

    // 4. updateSettings rejects after a successful credential clear → false.
    updateMode = 'reject';
    snapshot = { gelbooru: SYNTHETIC_CREDENTIAL };
    mockAppServices = services({ updateSettings, providerCredentials });
    const clearView = await render(<SourcesScreen />);
    mockRowCalls.length = 0;
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-clear'));
    expect(mockRowCalls).toHaveLength(1);
    await expect(mockRowCalls[0]!.promise).resolves.toBe(false);
    await act(async () => {});
    // The credential layer succeeded; only the settings write failed.
    expect(clearCredential).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('provider-gelbooru-credential-clear')).toBeEnabled();
    expect(screen.getByText('•••• 密钥已保存')).toBeOnTheScreen();
    updateMode = 'stateful';
    await userEvent.press(screen.getByTestId('provider-gelbooru-credential-clear'));
    expect(mockRowCalls).toHaveLength(2);
    await expect(mockRowCalls[1]!.promise).resolves.toBe(true);
    await act(async () => {});
    expect(stateful.getCurrent().providers.gelbooru).toBe(false);
    await clearView.unmount();
  });
});
