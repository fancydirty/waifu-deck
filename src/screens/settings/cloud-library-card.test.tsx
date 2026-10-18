import { render, screen, userEvent, within } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestInstance } from 'test-renderer';
import * as ReactNative from 'react-native';
import { StyleSheet, Text } from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import i18n from '@/i18n';
import { cloudCounts, cloudRead, cloudSnapshot } from '@/test/cloud-library-fixtures';
import { colors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { metrics } from '@/theme/metrics';
import { CloudLibraryCard, CloudLibraryCardBody } from './cloud-library-card';
import { deriveCloudIdentity, deriveCloudLibraryModel, type CloudLibraryModel } from './cloud-library-model';

jest.mock('lucide-react-native', () => {
  // Check draws a host node so the sibling pin below can see it; the others keep the null stub.
  const React = require('react');
  const { View } = require('react-native');
  return {
    Check: jest.fn(() => React.createElement(View, { testID: 'mock-check' })),
    Cloud: jest.fn(() => null), Lock: jest.fn(() => null), Server: jest.fn(() => null),
  };
});
const mockLucide = jest.requireMock('lucide-react-native') as {
  Check: jest.Mock; Cloud: jest.Mock; Lock: jest.Mock; Server: jest.Mock;
};
const { Check: mockCheck, Cloud: mockCloud, Lock: mockLock } = mockLucide;
const identity = { kind: 's3' as const, label: 'Cloudflare R2', identity: 'my-library' };
const base: CloudLibraryModel = { state: 'ready', identity, tone: 'ok', messageKey: null,
  reauthProvider: null, stats: { inCloud: 41, totalBytes: 1_500_000, pending: 0 },
  footer: { kind: 'synced', at: 100_000 }, storageMode: 'both', encryption: 'aes-gcm' };
const unconfigured = cloudSnapshot({ status: 'unconfigured' }).model;
// Literal approved text, independent of the translation resource under test.
const sentences = {
  'zh-Hans': ['此设备已配置云库，需要输入密码解锁。', '网盘登录已过期，重新登录就能继续。', '云库暂时连不上，网络恢复后会自动接上。', '云库不接受这台手机保存的登录信息。可以断开此设备后重新连接。', '读不出这个云库的数据。可以断开此设备后重新连接。', '云库暂时无法使用。可以断开此设备后重新连接。'],
  'zh-Hant': ['此裝置已設定雲庫，需要輸入密碼解鎖。', '雲端硬碟登入已過期，重新登入就能繼續。', '雲庫暫時連不上，網路恢復後會自動連上。', '雲庫不接受這台手機儲存的登入資訊。可以中斷此裝置後重新連接。', '讀不出這個雲庫的資料。可以中斷此裝置後重新連接。', '雲庫暫時無法使用。可以中斷此裝置後重新連接。'],
  ja: ['この端末はクラウドライブラリに接続済みです。パスワードを入力してロックを解除してください。', 'クラウドストレージのログインが期限切れです。再ログインすると続けられます。', 'クラウドライブラリに接続できません。ネットワークが戻ると自動で再接続します。', 'このスマートフォンに保存されたログイン情報が拒否されました。この端末の接続を解除して、接続し直してください。', 'このクラウドライブラリのデータを読み取れません。この端末の接続を解除して、接続し直してください。', 'クラウドライブラリを利用できません。この端末の接続を解除して、接続し直してください。'],
  en: ['This device has a cloud library configured. Enter your password to unlock it.', 'Your cloud drive sign-in has expired. Sign in again to continue.', 'The cloud library is unreachable. It will reconnect when the network returns.', 'The cloud library rejected the sign-in details saved on this phone. Disconnect this device, then connect again.', "This cloud library's data could not be read. Disconnect this device, then connect again.", 'The cloud library is unavailable. Disconnect this device, then connect again.'],
};
const statCopy = {
  'zh-Hans': { captions: ['在云端', '原图大小', '待上传'], unit: '张' },
  'zh-Hant': { captions: ['在雲端', '原圖大小', '待上傳'], unit: '張' },
  ja: { captions: ['クラウド上', '元画像のサイズ', 'アップロード待ち'], unit: '枚' },
  en: { captions: ['In cloud', 'Original size', 'Waiting to upload'], unit: 'images' },
} as const;
const statIds = ['in-cloud', 'total-bytes', 'pending'] as const;
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const host = (node: unknown): TestInstance => {
  if (typeof node === 'string' || node === null || typeof node !== 'object') throw new Error('expected a host node');
  return node as TestInstance;
};
afterEach(() => { jest.restoreAllMocks(); });
function expectStats(lines: readonly string[], captions: readonly string[]) {
  statIds.forEach((id, index) => {
    const value = screen.getByTestId(`settings-cloud-stat-${id}`);
    expect(value).toHaveTextContent(new RegExp(`^${literal(lines[index]!).source}$`));
    expect(value.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.5 });
    expect(within(value.parent!).getByText(captions[index]!)).toBeOnTheScreen();
  });
}
const locks: [ByosStatus, number, string][] = [
  [{ status: 'locked', reason: 'password_required' }, 0, 'Unlock needed'],
  ...(['gdrive', 'onedrive'] as const).map((provider): [ByosStatus, number, string] => [{ status: 'locked', reason: 'vault_unreachable', detail: 'reauth_required', provider }, 1, 'Sign in again']),
  [{ status: 'locked', reason: 'vault_unreachable', detail: 'network' }, 2, 'Unreachable'],
  [{ status: 'locked', reason: 'vault_unreachable', detail: 'credential_rejected' }, 3, 'Unreachable'],
  ...(['malformed', 'unsupported-version', 'meta_absent'] as const).map((detail): [ByosStatus, number, string] => [{ status: 'locked', reason: 'meta_corrupt', detail }, 4, 'Unreadable']),
  ...(['not_s3', 'not_webdav', 'not_onedrive', 'not_gdrive'] as const).map((detail): [ByosStatus, number, string] => [{ status: 'locked', reason: 'vault_unreachable', detail }, 5, 'Unreachable']),
];
beforeEach(async () => { jest.clearAllMocks(); await i18n.changeLanguage('en'); });

for (const locale of Object.keys(sentences) as (keyof typeof sentences)[]) {
  test.each(locks)(`${locale}: renders the approved status for %j without home controls`, async (status, message, pill) => {
    await i18n.changeLanguage(locale);
    const data = cloudSnapshot(status);
    const model = { ...data.model, identity };
    const onPress = jest.fn();
    await render(<CloudLibraryCard model={model} nowMs={1_000_000} onPress={onPress} />);
    expect(screen.getByText(sentences[locale][message]!)).toBeOnTheScreen();
    if (locale === 'en') expect(screen.getByText(pill)).toBeOnTheScreen();
    expect(screen.getByText('my-library')).toBeOnTheScreen();
    const card = screen.getByRole('button');
    expect(card).toHaveAccessibleName(/Cloudflare R2.*my-library/);
    expect(card).toHaveAccessibleName(literal(sentences[locale][message]!));
    expect(card).toHaveAccessibleName(/—.*—.*—/);
    expectStats(['—', '—', '—'], statCopy[locale].captions);
    expect(screen.container.queryAll((node) => node.props.secureTextEntry !== undefined || node.props.onChangeText !== undefined)).toHaveLength(0);
    for (const id of ['byos-unlock-password', 'byos-unlock', 'byos-reauth', 'gdrive-sign-in', 'onedrive-sign-in', 'byos-section', 'byos-status']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByTestId('settings-cloud-footer')).toBeNull();
    await userEvent.press(screen.getByTestId('settings-cloud-card'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
}
test.each([
  ['zh-Hans', '还没连接', '图存在你自己的云里，多台手机同一份收藏。', '连接云库'],
  ['zh-Hant', '還沒連線', '圖片存在你自己的雲端，多台手機共享同一份收藏。', '連接雲庫'],
  ['ja', '未接続', '自分のクラウドに保存して、複数のスマートフォンで同じコレクションを。', 'クラウドライブラリに接続'],
  ['en', 'Not connected', 'Keep images in your own cloud, with the same collection on every phone.', 'Connect cloud library'],
])('%s: not connected card and CTA each invoke one navigation', async (locale, state, intro, cta) => {
  await i18n.changeLanguage(locale);
  const onPress = jest.fn();
  await render(<CloudLibraryCard model={unconfigured} nowMs={1_000_000} onPress={onPress} />);
  expect(screen.getByText(state)).toBeOnTheScreen();
  expect(screen.getByText(intro)).toBeOnTheScreen();
  expect(screen.queryByTestId('settings-cloud-stats')).toBeNull();
  expect(screen.queryByTestId('settings-cloud-pill')).toBeNull();
  await userEvent.press(screen.getByText(cta));
  expect(onPress).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByTestId('settings-cloud-card'));
  expect(onPress).toHaveBeenCalledTimes(2);
});
test('loading has three placeholders and no numbers, pill or footer', async () => {
  await render(<CloudLibraryCard model={{ ...base, state: 'loading', tone: null, stats: null, footer: null, storageMode: null, encryption: null }} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getAllByTestId(/settings-cloud-stat-.*-placeholder/)).toHaveLength(3);
  expect(screen.queryByText('0')).toBeNull();
  expect(screen.queryByText('—')).toBeNull();
  expect(screen.queryByTestId('settings-cloud-pill')).toBeNull();
  expect(screen.queryByTestId('settings-cloud-footer')).toBeNull();
});
test('unread ready counts show dashes, measured zero shows zero', async () => {
  const view = await render(<CloudLibraryCard model={{ ...base, stats: null, footer: null }} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.queryByText('0')).toBeNull();
  await view.rerender(<CloudLibraryCard model={{ ...base, stats: { inCloud: 0, totalBytes: 0, pending: 0 }, footer: null }} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getByTestId('settings-cloud-stat-in-cloud')).toHaveTextContent(/^0 images$/);
  expect(screen.getByTestId('settings-cloud-stat-total-bytes')).toHaveTextContent('0 B');
});
test.each(['aes-gcm', 'none'] as const)('ready %s uses supplied clock, stat tokens and readable mode/encryption', async (encryption) => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(99_000_000);
  await render(<CloudLibraryCard model={{ ...base, encryption }} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getByText('Connected')).toBeOnTheScreen();
  const card = screen.getByRole('button');
  expect(card).toHaveAccessibleName(/Cloudflare R2.*my-library.*Connected/);
  expect(card).toHaveAccessibleName(/41 images.*1\.5 MB.*0 images/);
  expect(card).toHaveAccessibleName(/All backed up/);
  expect(screen.getByTestId('settings-cloud-stat-in-cloud')).toHaveTextContent(/^41 images$/);
  expect(screen.getByTestId('settings-cloud-stat-total-bytes')).toHaveTextContent('1.5 MB');
  expect(screen.getByTestId('settings-cloud-footer')).toHaveTextContent('All backed up · 2 minutes ago');
  expect(screen.getByText(encryption === 'none' ? 'Not encrypted' : 'Encrypted')).toBeOnTheScreen();
  expect(screen.getByText('This phone + cloud')).toBeOnTheScreen();
  expect(StyleSheet.flatten(screen.getByTestId('settings-cloud-stat-in-cloud').props.style)).toMatchObject(settingsTypography.cloudStat);
  expect(StyleSheet.flatten(screen.getByTestId('settings-cloud-card').props.style).borderRadius).toBe(metrics.settingsRadius.cloud);
  clock.mockRestore();
});
test.each([
  [{ kind: 'quota-full', count: 3 }, 'Drive full, 3 images waiting to upload'],
  [{ kind: 'pending', count: 2 }, '2 images still waiting to upload'],
  [{ kind: 'downloading', count: 4 }, 'Downloading, 4 images remaining'],
  [{ kind: 'never-synced' }, 'Not synced yet'],
] as const)('renders selected footer %j', async (footer, copy) => {
  await render(<CloudLibraryCard model={{ ...base, footer }} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getByTestId('settings-cloud-footer')).toHaveTextContent(copy);
});
test('stale counts remain visible but cannot claim a footer', async () => {
  const model = deriveCloudLibraryModel({ byosStatus: { status: 'ready', context: { meta: { encryption: 'none' } } } as ByosStatus,
    identity: cloudRead(identity, null), counts: { ...cloudRead(cloudCounts), fresh: false },
    mode: cloudRead('cloud-only', null), quotaFullCount: cloudRead(0), lastSyncedAt: cloudRead(100_000), readRoundId: 1 });
  await render(<CloudLibraryCard model={model} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getByTestId('settings-cloud-stat-in-cloud')).toHaveTextContent(/^2 images$/);
  expect(screen.queryByTestId('settings-cloud-footer')).toBeNull();
});
for (const locale of Object.keys(statCopy) as (keyof typeof statCopy)[]) {
  test.each([
    { inCloud: 41, pending: 0 }, { inCloud: 0, pending: 1 }, { inCloud: 1, pending: 7 },
  ])(`${locale}: distinct stat figures and units %j with number-free captions`, async (counts) => {
    await i18n.changeLanguage(locale);
    await render(<CloudLibraryCard model={{ ...base, stats: { ...counts, totalBytes: 1_900_000_000 } }} nowMs={220_000} onPress={jest.fn()} />);
    const unit = (count: number) => locale === 'en' && count === 1 ? 'image' : statCopy[locale].unit;
    const lines = [`${counts.inCloud} ${unit(counts.inCloud)}`, '1.9 GB', `${counts.pending} ${unit(counts.pending)}`];
    expectStats(lines, statCopy[locale].captions);
    const card = screen.getByRole('button');
    expect(card).toHaveAccessibleName(/Cloudflare R2.*my-library/);
    lines.forEach((line) => expect(card).toHaveAccessibleName(literal(line)));
    expect(card).toHaveAccessibleName(literal(i18n.t('settings.byos.status.connected')));
    for (const id of statIds) {
      const value = screen.getByTestId(`settings-cloud-stat-${id}`);
      const nestedUnit = value.children.find((child) => typeof child !== 'string');
      expect(typeof nestedUnit).toBe('object');
      if (typeof nestedUnit === 'object' && nestedUnit !== null) {
        expect(StyleSheet.flatten(nestedUnit.props.style)).toMatchObject({ ...settingsTypography.cloudStatUnit, color: expect.any(String) });
        expect(StyleSheet.flatten(nestedUnit.props.style).fontSize).toBeLessThan(settingsTypography.cloudStat.fontSize);
      }
    }
  });
  test(`${locale}: loading and unread figures retain placeholders or bare dashes and exact captions`, async () => {
    await i18n.changeLanguage(locale);
    const view = await render(<CloudLibraryCard model={{ ...base, state: 'loading', tone: null, stats: null, footer: null, storageMode: null, encryption: null }} nowMs={220_000} onPress={jest.fn()} />);
    expect(screen.getAllByTestId(/settings-cloud-stat-.*-placeholder/)).toHaveLength(3);
    statCopy[locale].captions.forEach((caption) => expect(screen.getByText(caption)).toBeOnTheScreen());
    await view.rerender(<CloudLibraryCard model={{ ...base, stats: null, footer: null }} nowMs={220_000} onPress={jest.fn()} />);
    expectStats(['—', '—', '—'], statCopy[locale].captions);
    await view.rerender(<CloudLibraryCard model={unconfigured} nowMs={220_000} onPress={jest.fn()} />);
    expect(screen.queryByTestId('settings-cloud-stats')).toBeNull();
  });
  test(`${locale}: real WebDAV identity derivation and translations compose the exact card title`, async () => {
    await i18n.changeLanguage(locale);
    const derived = deriveCloudIdentity({ kind: 'webdav', baseUrl: 'https://dav.example.com:5006/path', username: 'me', password: 'secret', rootPath: 'library' }, i18n.getFixedT(locale));
    await render(<CloudLibraryCard model={{ ...base, identity: derived }} nowMs={220_000} onPress={jest.fn()} />);
    expect(screen.getByText('WebDAV', { exact: true })).toBeOnTheScreen();
    expect(screen.getByText('dav.example.com:5006 · me', { exact: true })).toBeOnTheScreen();
    expect(i18n.t('settings.byos.locations.webdav')).toBe('WebDAV');
  });
}
test.each([
  [0, '0 B'], [999, '999 B'], [1000, '1 KB'], [999_999_999, '1000 MB'],
  [1_000_000_000, '1 GB'], [1_900_000_000, '1.9 GB'], [2_965_300_000, '3 GB'],
])('card original size at %i bytes is exactly %s', async (totalBytes, line) => {
  await render(<CloudLibraryCard model={{ ...base, stats: { ...base.stats!, totalBytes } }} nowMs={220_000} onPress={jest.fn()} />);
  expect(screen.getByTestId('settings-cloud-stat-total-bytes')).toHaveTextContent(new RegExp(`^${literal(line).source}$`));
});
test('body supports page IDs and actions as a non-pressable presentation', async () => {
  await render(<CloudLibraryCardBody model={{ ...base, stats: null, footer: null }} nowMs={220_000} testID="page-card" statsTestID="page-stats" statIdPrefix="cloud-stat" action={undefined} message={undefined} />);
  expect(within(screen.getByTestId('page-stats')).getAllByText('—')).toHaveLength(3);
  expect(screen.getByTestId('cloud-stat-in-cloud')).toHaveTextContent('—');
  expect(screen.queryByRole('button')).toBeNull();
});

test.each(['light', 'dark'] as const)('%s cloud card owns the v4 geometry and keeps the footer sentence on its Text', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<CloudLibraryCard model={base} nowMs={220_000} onPress={jest.fn()} />);
  const theme = colors[scheme];
  const card = StyleSheet.flatten(screen.getByTestId('settings-cloud-card').props.style);
  expect(card).toMatchObject({ marginHorizontal: metrics.settingsGutter, borderRadius: metrics.settingsRadius.cloud,
    minHeight: metrics.minimumHitArea, elevation: scheme === 'dark' ? 0 : 1 });
  expect(card.padding).toBeUndefined();
  expect(card.marginTop).toBeUndefined();
  expect(card.marginBottom).toBeUndefined();
  expect(card.marginVertical).toBeUndefined();
  const body = screen.getByTestId('settings-cloud-body');
  expect(StyleSheet.flatten(body.props.style)).toMatchObject({ padding: 14 });
  expect(StyleSheet.flatten(body.props.style).gap).toBeUndefined();
  const header = host(body.children[0]);
  expect(StyleSheet.flatten(header.props.style)).toMatchObject({ flexDirection: 'row', alignItems: 'center', gap: 12 });
  expect(StyleSheet.flatten(header.props.style).flexWrap).toBeUndefined();
  const tile = host(header.children[0]);
  expect(StyleSheet.flatten(tile.props.style)).toMatchObject({ width: 44, height: 44,
    borderRadius: metrics.settingsRadius.tile, backgroundColor: theme.cloudSoft });
  const identityColumn = host(header.children[1]);
  const provider = host(identityColumn.children[0]);
  const identityText = host(identityColumn.children[1]);
  expect(provider.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
  expect(StyleSheet.flatten(provider.props.style)).toMatchObject(settingsTypography.cloudName);
  expect(identityText.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'middle' });
  expect(StyleSheet.flatten(identityText.props.style)).toMatchObject(settingsTypography.cloudSub);
  const stats = screen.getByTestId('settings-cloud-stats');
  const statsStyle = StyleSheet.flatten(stats.props.style);
  expect(statsStyle).toMatchObject({ marginTop: 14, marginBottom: 12, paddingVertical: 12,
    borderTopWidth: 1, borderBottomWidth: 1 });
  expect(statsStyle.gap).toBeUndefined();
  const columns = stats.children;
  expect(columns).toHaveLength(3);
  expect(StyleSheet.flatten(host(columns[0]).props.style).gap).toBeUndefined();
  expect(StyleSheet.flatten(host(columns[1]).props.style)).toMatchObject({ borderLeftWidth: 1, paddingLeft: 12 });
  expect(StyleSheet.flatten(host(columns[2]).props.style)).toMatchObject({ borderLeftWidth: 1, paddingLeft: 12 });
  const unit = screen.getByTestId('settings-cloud-stat-in-cloud').children.find((child) => typeof child !== 'string');
  expect(typeof unit).toBe('object');
  if (typeof unit === 'object' && unit !== null) {
    expect(StyleSheet.flatten(host(unit).props.style)).toMatchObject({ ...settingsTypography.cloudStatUnit, color: theme.textSecondary });
  }
  const footer = screen.getByTestId('settings-cloud-footer');
  expect(footer.type).toBe('Text');
  expect(footer.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
  const footerParent = footer.parent;
  if (footerParent === null) throw new Error('footer must have a wrapper');
  expect(footerParent.props.testID).toBeUndefined();
  expect(StyleSheet.flatten(footerParent.props.style)).toMatchObject({ flexGrow: 1, flexShrink: 0, minWidth: 0 });
  expect(StyleSheet.flatten(footerParent.props.style).flex).toBeUndefined();
  const footerRow = footerParent.parent;
  if (footerRow === null) throw new Error('footer wrapper must have a row');
  expect(StyleSheet.flatten(footerRow.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 8 });
  const pillParent = screen.getByText('This phone + cloud').parent;
  if (pillParent === null || pillParent.parent === null) throw new Error('pill must have a group');
  const pillGroup = pillParent.parent;
  expect(pillGroup.props.testID).toBeUndefined();
  expect(StyleSheet.flatten(pillGroup.props.style)).toMatchObject({ flexDirection: 'row', gap: 8 });
  expect(StyleSheet.flatten(pillGroup.props.style).flexWrap).toBeUndefined();
  expect(screen.getByText('This phone + cloud').props.numberOfLines).toBe(1);
  expect(screen.getByText('Encrypted').props.numberOfLines).toBe(1);
});

test.each([
  ['s3', colors.light.cloudSoft],
  [null, colors.light.cloudSoft],
  ['gdrive', colors.light.controlFill],
  ['onedrive', colors.light.controlFill],
  ['webdav', colors.light.controlFill],
] as const)('provider kind %s controls tile colour and the body never owns a generic gap', async (kind, backgroundColor) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('light');
  const model = { ...base, identity: kind === null ? null : { ...identity, kind } };
  await render(<CloudLibraryCardBody model={model} nowMs={220_000} testID="page-card" statsTestID="page-stats" />);
  const pageCard = screen.getByTestId('page-card');
  const tile = host(host(pageCard.children[0]).children[0]);
  expect(StyleSheet.flatten(tile.props.style)).toMatchObject({ width: 44, height: 44,
    borderRadius: metrics.settingsRadius.tile, backgroundColor });
  expect(StyleSheet.flatten(screen.getByTestId('page-card').props.style).gap).toBeUndefined();
});

test('unconfigured CTA owns the v4 bottom padding and page bodies own their card shell', async () => {
  await render(<CloudLibraryCard model={unconfigured} nowMs={220_000} onPress={jest.fn()} />);
  const cta = StyleSheet.flatten(screen.getByText('Connect cloud library').props.style);
  expect(cta).toMatchObject({ paddingHorizontal: 14, paddingBottom: 14 });
  expect(cta.padding).toBeUndefined();
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('light');
  await render(<CloudLibraryCardBody model={base} nowMs={220_000} testID="page-shell" statIdPrefix="cloud-stat" />);
  expect(StyleSheet.flatten(screen.getByTestId('page-shell').props.style)).toMatchObject({
    marginHorizontal: metrics.settingsGutter, borderRadius: metrics.settingsRadius.cloud, elevation: 1,
  });
});

test('cloud body source pins the mark size and named tile radius', () => {
  const source = readFileSync(join(__dirname, 'cloud-library-card.tsx'), 'utf8');
  expect(source).toContain('<CloudMark kind={model.identity?.kind ?? null} size={24}');
  expect(source).toContain('borderRadius: metrics.settingsRadius.tile');
  expect(source).toMatch(/<Check accessible=\{false\}[^>]*size=\{15\} \/>/);
  expect(source).toMatch(/icon=\{<Cloud accessible=\{false\}[^>]*size=\{12\} \/>\}/);
  expect(source).toMatch(/icon=\{<Lock accessible=\{false\}[^>]*size=\{12\} \/>\}/);
  expect(source).not.toMatch(/<(?:Check|Cloud|Lock)\s[^>]*testID=/);
});

test.each([
  ['synced', 'settings-cloud-footer', { kind: 'synced', at: 100_000 }],
  ['synced page', 'byos-last-sync', { kind: 'synced', at: 100_000 }],
  ['quota full', 'byos-quota-full', { kind: 'quota-full', count: 3 }],
  ['pending', 'byos-cloud-footer', { kind: 'pending', count: 2 }],
] as const)('%s footer keeps its ID on the sentence Text', async (_name, testID, footer) => {
  await render(<CloudLibraryCardBody model={{ ...base, footer }} nowMs={220_000} footerTestID={testID} testID="footer-card" />);
  const sentence = screen.getByTestId(testID);
  expect(sentence.type).toBe('Text');
  const sentenceParent = sentence.parent;
  if (sentenceParent === null || sentenceParent.parent === null) throw new Error('footer sentence must have wrappers');
  expect(sentenceParent.props.testID).toBeUndefined();
  expect(sentenceParent.parent.props.testID).toBeUndefined();
  expect(sentence.props.numberOfLines).toBe(1);
});

const gdriveIdentity = { kind: 'gdrive' as const, label: 'Google Drive', identity: 'owner@example.com' };

test.each([
  ['synced', { kind: 'synced', at: 100_000 }, true, 'ok'],
  ['quota-full', { kind: 'quota-full', count: 3 }, false, 'warnInk'],
  ['pending', { kind: 'pending', count: 2 }, false, 'textSecondary'],
  ['never-synced', { kind: 'never-synced' }, false, 'textSecondary'],
  ['downloading', { kind: 'downloading', count: 4 }, false, 'textSecondary'],
] as const)('%s footer draws the check only for synced and uses the semantic sentence colour', async (_kind, footer, hasCheck, colourKey) => {
  for (const scheme of ['light', 'dark'] as const) {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    const theme = colors[scheme];
    const view = await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity, footer }} nowMs={220_000}
      footerTestID="settings-cloud-footer" />);
    expect(mockCheck).toHaveBeenCalledTimes(hasCheck ? 1 : 0);
    const sentence = screen.getByTestId('settings-cloud-footer');
    expect(StyleSheet.flatten(sentence.props.style)).toMatchObject({ color: theme[colourKey], flexShrink: 1, minWidth: 0 });
    const wrapper = sentence.parent;
    if (wrapper === null) throw new Error('footer sentence must have a wrapper');
    expect(StyleSheet.flatten(wrapper.props.style)).toMatchObject({ flexShrink: 0, minWidth: 0, gap: 5 });
    if (hasCheck) expect(mockCheck.mock.calls[0]?.[0]).toMatchObject({ accessible: false, color: theme.ok, size: 15 });
    await view.unmount();
    jest.clearAllMocks();
  }
});

test.each(['light', 'dark'] as const)('%s the synced check lives inside the sentence wrapper, sibling to its Text', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const syncedView = await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity }} nowMs={220_000}
    footerTestID="settings-cloud-footer" />);
  const wrapper = host(screen.getByTestId('settings-cloud-footer').parent);
  expect(wrapper.children.map((child) => host(child).props.testID)).toEqual(['mock-check', 'settings-cloud-footer']);
  await syncedView.unmount();
  const pendingView = await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity, footer: { kind: 'pending', count: 2 } }} nowMs={220_000}
    footerTestID="settings-cloud-footer" />);
  const wrapperNoCheck = host(screen.getByTestId('settings-cloud-footer').parent);
  expect(wrapperNoCheck.children.map((child) => host(child).props.testID)).toEqual(['settings-cloud-footer']);
  await pendingView.unmount();
});

test.each(['light', 'dark'] as const)('%s plain cloud-card pills use their matching icons and text colour', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const theme = colors[scheme];
  const view = await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity, storageMode: 'both', encryption: null }} nowMs={220_000} />);
  expect(mockCloud).toHaveBeenCalledTimes(1);
  expect(mockCloud.mock.calls[0]?.[0]).toMatchObject({ accessible: false, color: theme.text, size: 12 });
  expect(mockLock).not.toHaveBeenCalled();
  mockCloud.mockClear(); mockLock.mockClear();
  await view.rerender(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity, storageMode: null, encryption: 'aes-gcm' }} nowMs={220_000} />);
  expect(mockLock).toHaveBeenCalledTimes(1);
  expect(mockLock.mock.calls[0]?.[0]).toMatchObject({ accessible: false, color: theme.text, size: 12 });
  expect(mockCloud).not.toHaveBeenCalled();
});

test.each(['light', 'dark'] as const)('%s header, stats and page-body colours and spacing are token-owned', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const theme = colors[scheme];
  await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity }} nowMs={220_000}
    testID="page-card" statsTestID="page-stats" statIdPrefix="cloud-stat" />);
  const body = screen.getByTestId('page-card');
  expect(StyleSheet.flatten(body.props.style)).toMatchObject({ elevation: scheme === 'dark' ? 0 : 1 });
  const header = host(body.children[0]);
  const tile = host(header.children[0]);
  expect(StyleSheet.flatten(tile.props.style)).toMatchObject({ alignItems: 'center', justifyContent: 'center' });
  const provider = host(host(header.children[1]).children[0]);
  const identityText = host(host(header.children[1]).children[1]);
  expect(StyleSheet.flatten(provider.props.style).color).toBe(theme.text);
  expect(StyleSheet.flatten(identityText.props.style).color).toBe(theme.textSecondary);
  const stats = screen.getByTestId('page-stats');
  const statsStyle = StyleSheet.flatten(stats.props.style);
  expect(statsStyle.borderColor).toBe(theme.hair);
  expect(StyleSheet.flatten(host(stats.children[1]).props.style).borderLeftColor).toBe(theme.hair);
  expect(StyleSheet.flatten(host(stats.children[2]).props.style).borderLeftColor).toBe(theme.hair);
  expect(StyleSheet.flatten(screen.getByText('In cloud', { exact: true }).props.style).color).toBe(theme.textSecondary);
});

test.each(['light', 'dark'] as const)('%s page message and action keep their owned top spacing', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity }} nowMs={220_000}
    statIdPrefix="cloud-stat" message={<Text testID="page-message">Message</Text>}
    action={<Text testID="page-action">Action</Text>} />);
  const messageParent = screen.getByTestId('page-message').parent;
  const actionParent = screen.getByTestId('page-action').parent;
  if (messageParent === null || actionParent === null) throw new Error('page content must have wrappers');
  expect(StyleSheet.flatten(messageParent.props.style).marginTop).toBe(12);
  expect(StyleSheet.flatten(actionParent.props.style).marginTop).toBe(12);
});

test.each(['light', 'dark'] as const)('%s unconfigured intro uses secondary text', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const theme = colors[scheme];
  await render(<CloudLibraryCardBody model={unconfigured} nowMs={220_000} testID="unconfigured-body" />);
  expect(StyleSheet.flatten(screen.getByText('Keep images in your own cloud, with the same collection on every phone.').props.style).color)
    .toBe(theme.textSecondary);
});

// F9 / Yoga's single-flex-child optimization: no footer-row child may be the only flexGrow+flexShrink child.
test.each(['light', 'dark'] as const)('%s F9 footer row leaves Yoga a measurable sentence basis', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity }} nowMs={220_000}
    footerTestID="settings-cloud-footer" />);
  const sentence = screen.getByTestId('settings-cloud-footer');
  const sentenceWrapper = host(sentence.parent);
  const footerRow = host(sentenceWrapper.parent);
  const children = footerRow.children.map((child) => host(child));
  for (const child of children) {
    const style = StyleSheet.flatten(child.props.style);
    expect(style.flexGrow > 0 && style.flexShrink > 0).toBe(false);
  }
  expect(StyleSheet.flatten(sentenceWrapper.props.style)).toMatchObject({ flexGrow: 1, flexShrink: 0, minWidth: 0 });
});

// F9 / YGErrataAll: the sentence must shrink and ellipsize without growing its content-sized wrapper.
test.each(['light', 'dark'] as const)('%s F9 sentence Text keeps shrink-only ellipsis', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<CloudLibraryCardBody model={{ ...base, identity: gdriveIdentity }} nowMs={220_000}
    footerTestID="settings-cloud-footer" />);
  const sentence = screen.getByTestId('settings-cloud-footer');
  const style = StyleSheet.flatten(sentence.props.style);
  expect(style.flexGrow).toBeUndefined();
  expect(style.flexShrink).toBe(1);
  expect(style.minWidth).toBe(0);
  expect(sentence.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
});
