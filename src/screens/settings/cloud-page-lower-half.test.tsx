import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';

import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import type { LibraryStorageModeControl } from '@/features/library/library-integration-types';
import i18n from '@/i18n';
import { cloudCounts, cloudRead, cloudSnapshot } from '@/test/cloud-library-fixtures';
import { renderCloudMessage } from '@/test/cloud-message-fixture';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import { ByosLockedView } from './byos-locked-view';
import { ByosSettingsSection, type ByosConnectFlow } from './byos-settings-section';

jest.mock('lucide-react-native', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const mark = (name: string) => {
    const Icon = (props: Record<string, unknown>) =>
      React.createElement(View, { ...props, testID: name, accessible: false });
    Icon.displayName = name;
    return Icon;
  };
  return {
    Check: mark('mark-check'),
    ChevronRight: mark('row-chevron'),
    Cloud: mark('mark-cloud'),
    Lock: mark('mark-lock'),
    Server: mark('mark-server'),
  };
});

/**
 * U3a RED pins (plan `2026-10-11-n7-u3-settings-sheets-dialogs.md`): the 云库
 * page lower half (本机存储, 后台上传, 加密, 存储位置, 断开此设备) matches mockup
 * v4 §2 in every state layout. Behaviour is frozen: copy, testIDs, accessible
 * names, write semantics and the disconnect guard are pinned unchanged.
 */

const LOCALES = ['en', 'ja', 'zh-Hans', 'zh-Hant'] as const;
type Locale = (typeof LOCALES)[number];

// Independent literals (written from the current resources, not read from them):
// every lower-half string in all four locales must keep rendering byte-for-byte.
const LITERALS: Record<Locale, Record<string, string>> = {
  en: {
    phoneGroup: 'This phone',
    libraryGroup: 'This cloud library',
    storageLabel: 'Storage on this phone',
    storageDetail: 'Cloud only: after backup the originals leave this phone; thumbnails stay and full images load from your cloud library.',
    storageValueBoth: 'This phone + cloud',
    backgroundLabel: 'Background uploads',
    backgroundAllowed: 'Allowed',
    encryptionLabel: 'Encryption',
    encryptionValueOn: 'Encrypted',
    locationLabel: 'Storage location',
    locationValueS3: 'S3-compatible storage',
    disconnect: 'Disconnect this device',
    disconnectDetail: 'Removes the connection here only. Cloud data and other devices are untouched.',
    disconnectConfirm: 'Disconnect',
    cancel: 'Cancel',
  },
  ja: {
    phoneGroup: 'このスマートフォン',
    libraryGroup: 'このクラウドライブラリ',
    storageLabel: 'この端末の保存方法',
    storageDetail: 'クラウドのみ：バックアップ後にこの端末のオリジナルを削除し、サムネイルだけを残します。大きな画像はクラウドから読み込みます。',
    storageValueBoth: '端末+クラウド',
    backgroundLabel: 'バックグラウンドアップロード',
    backgroundAllowed: '許可済み',
    encryptionLabel: '暗号化',
    encryptionValueOn: '暗号化あり',
    locationLabel: '保存先',
    locationValueS3: 'S3 互換ストレージ',
    disconnect: 'この端末を切断',
    disconnectDetail: 'この端末の接続のみを解除します。クラウドのデータと他の端末には影響しません。',
    disconnectConfirm: '切断',
    cancel: 'キャンセル',
  },
  'zh-Hans': {
    phoneGroup: '这台手机',
    libraryGroup: '这个云库',
    storageLabel: '本机存储',
    storageDetail: '仅云端：备份完成后删除本机原图，只留缩略图，看大图时从云端取。',
    storageValueBoth: '本地+云端',
    backgroundLabel: '后台上传',
    backgroundAllowed: '已允许',
    encryptionLabel: '加密',
    encryptionValueOn: '已加密',
    locationLabel: '存储位置',
    locationValueS3: 'S3 兼容存储',
    disconnect: '断开此设备',
    disconnectDetail: '仅移除此设备的连接。云端数据与其他设备不受影响。',
    disconnectConfirm: '断开',
    cancel: '取消',
  },
  'zh-Hant': {
    phoneGroup: '這台手機',
    libraryGroup: '這個雲庫',
    storageLabel: '本機儲存',
    storageDetail: '僅雲端：備份完成後刪除本機原圖，只留縮圖，看大圖時從雲端取得。',
    storageValueBoth: '本機+雲端',
    backgroundLabel: '背景上傳',
    backgroundAllowed: '已允許',
    encryptionLabel: '加密',
    encryptionValueOn: '已加密',
    locationLabel: '儲存位置',
    locationValueS3: 'S3 相容儲存',
    disconnect: '中斷此裝置',
    disconnectDetail: '僅移除此裝置的連線。雲端資料與其他裝置不受影響。',
    disconnectConfirm: '中斷',
    cancel: '取消',
  },
};

const RESOURCE_KEYS: Record<string, string> = {
  phoneGroup: 'settings.cloudLibrary.phoneGroup',
  libraryGroup: 'settings.cloudLibrary.libraryGroup',
  storageLabel: 'settings.byos.storageMode.label',
  storageDetail: 'settings.byos.storageMode.detail',
  storageValueBoth: 'settings.byos.storageMode.both',
  backgroundLabel: 'settings.byos.backgroundSync.label',
  backgroundAllowed: 'settings.byos.backgroundSync.allowed',
  encryptionLabel: 'settings.cloudLibrary.encryption',
  encryptionValueOn: 'settings.byos.status.encryptionOn',
  locationLabel: 'settings.byos.locations.title',
  locationValueS3: 'settings.byos.locations.s3',
  disconnect: 'settings.byos.disconnect',
  disconnectDetail: 'settings.byos.disconnectDetail',
};

const ready: ByosStatus = {
  status: 'ready',
  context: {
    kind: 's3',
    credentials: {
      kind: 's3', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto',
      bucket: 'library', accessKeyId: 'secret-access-key', secretAccessKey: 'master-secret', prefix: '',
    },
    meta: { format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'aes-gcm', vaultId: 'v',
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'salt' }, keyCheckB64: 'check', createdAt: 'now' },
    masterKey: new Uint8Array(32), deviceId: 'device',
  },
};
const lockedPassword: ByosStatus = { status: 'locked', reason: 'password_required' };

function readyData() {
  return cloudSnapshot(ready, {
    counts: cloudRead({ ...cloudCounts, downloadedTotal: 8, totalBytes: 1_900_000_000, pending: 2, inCloud: 3, inCloudBytes: 444 }),
    mode: cloudRead<LibraryStorageMode>('both', null),
    quota: { usedBytes: 1_250_000_000, totalBytes: 2_000_000_000 },
    quotaFullCount: cloudRead(0),
    lastSyncedAt: cloudRead(100),
    readRoundId: 1,
    viewNowMs: 200,
  });
}

function flow(overrides: Partial<ByosConnectFlow> = {}): ByosConnectFlow {
  return {
    probeBucket: jest.fn(), connectToBucket: jest.fn(), probeWebdav: jest.fn(), connectWebdav: jest.fn(),
    signInWithMicrosoft: jest.fn(), probeOneDrive: jest.fn(), connectOneDrive: jest.fn(), reauthOneDrive: jest.fn(),
    signInWithGoogle: jest.fn(), probeGdrive: jest.fn(), connectGdrive: jest.fn(), reauthGdrive: jest.fn(),
    unlock: jest.fn(), disconnectDevice: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as ByosConnectFlow;
}

function control(initial: LibraryStorageMode = 'both'): LibraryStorageModeControl {
  let mode = initial;
  return {
    read: jest.fn(async () => mode),
    set: jest.fn(async (next: LibraryStorageMode) => { mode = next; }),
  };
}

function backgroundPort(allowed = true) {
  return {
    isBatteryOptimizationIgnored: jest.fn(() => allowed),
    requestIgnoreBatteryOptimizations: jest.fn(async () => undefined),
  };
}

async function renderReadySection(options: {
  connectFlow?: ByosConnectFlow;
  backgroundSync?: ReturnType<typeof backgroundPort>;
} = {}) {
  await render(
    <ByosSettingsSection
      byosStatus={ready}
      connectFlow={options.connectFlow ?? flow()}
      onReload={jest.fn()}
      data={readyData()}
      storageMode={control('both')}
      backgroundSync={options.backgroundSync ?? backgroundPort(true)}
      renderCloudMessage={renderCloudMessage}
    />,
  );
  await act(async () => {});
}

function groupCards() {
  return screen.container.queryAll((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.borderRadius === metrics.radius.card && style?.marginHorizontal === metrics.settingsGutter;
  });
}

function orderOf(root: ReturnType<typeof screen.getByTestId>, ids: readonly string[]) {
  // Host-node preorder membership (CD11): IDs must appear as an exact
  // subsequence, so `byos-unlock` can never match `byos-unlock-password`.
  const found: string[] = [];
  const walk = (node: { props: { testID?: unknown }; children: unknown[] }) => {
    if (typeof node.props.testID === 'string') found.push(node.props.testID);
    for (const child of node.children) {
      if (typeof child !== 'string') walk(child as typeof node);
    }
  };
  walk(root as unknown as { props: { testID?: unknown }; children: unknown[] });
  let cursor = -1;
  for (const id of ids) {
    const at = found.indexOf(id, cursor + 1);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
}

beforeEach(async () => { await i18n.changeLanguage('en'); });

test('ready lower half keeps row order/IDs and groups the five rows into three v4 cards', async () => {
  await renderReadySection();
  const root = screen.getByTestId('byos-ready-view');
  orderOf(root, ['byos-status', 'byos-quota', 'byos-phone-group', 'byos-storage-mode',
    'byos-background-sync', 'byos-library-group', 'byos-encryption', 'storage-kind-badge', 'byos-disconnect']);

  const groups = groupCards();
  expect(groups).toHaveLength(3);
  const [phoneGroup, libraryGroup, dangerGroup] = groups;
  expect(phoneGroup).toHaveStyle({
    backgroundColor: colors.light.surfaceSecondary, borderColor: colors.light.border,
    borderRadius: metrics.radius.card, marginHorizontal: metrics.settingsGutter,
  });
  expect(StyleSheet.flatten(phoneGroup.props.style).marginTop).toBeUndefined();
  expect(StyleSheet.flatten(libraryGroup.props.style).marginTop).toBeUndefined();
  expect(dangerGroup).toHaveStyle({ marginTop: metrics.settingsGroupGap });

  expect(within(phoneGroup).getByTestId('byos-storage-mode')).toBeOnTheScreen();
  expect(within(phoneGroup).getByTestId('byos-background-sync')).toBeOnTheScreen();
  expect(within(libraryGroup).getByTestId('byos-encryption')).toBeOnTheScreen();
  expect(within(libraryGroup).getByTestId('storage-kind-badge')).toBeOnTheScreen();
  expect(within(dangerGroup).getByTestId('byos-disconnect')).toBeOnTheScreen();
  expect(within(dangerGroup).queryAllByRole('button')).toHaveLength(1);
});

test('ready lower half draws labels, rows, values and icons from the v4 geometry tokens', async () => {
  await renderReadySection();
  for (const id of ['byos-phone-group', 'byos-library-group']) {
    const label = within(screen.getByTestId(id)).getByText(
      id === 'byos-phone-group' ? LITERALS.en.phoneGroup : LITERALS.en.libraryGroup);
    expect(label).toHaveStyle({
      ...settingsTypography.groupLabel,
      color: colors.light.textSecondary,
      paddingHorizontal: metrics.settingsGutter + 6,
      paddingTop: 20,
      paddingBottom: 8,
    });
  }
  const row = screen.getByTestId('byos-storage-mode');
  expect(row).toHaveStyle({
    minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
  });
  expect(within(row).getByText(LITERALS.en.storageLabel)).toHaveStyle({
    ...settingsTypography.rowTitle, color: colors.light.text,
  });
  expect(within(row).getByText(LITERALS.en.storageDetail)).toHaveStyle({
    ...settingsTypography.detail, color: colors.light.textSecondary,
  });
  expect(within(row).getByText(LITERALS.en.storageValueBoth)).toHaveStyle({
    ...settingsTypography.value, color: colors.light.textSecondary,
  });
  // v4 §2 icon slots: chevron only on the open row; none on value/pill/danger rows.
  const [phoneGroup, libraryGroup, dangerGroup] = groupCards();
  expect(within(phoneGroup).queryAllByTestId('row-chevron')).toHaveLength(1);
  expect(within(screen.getByTestId('byos-background-sync')).queryAllByTestId('row-chevron')).toHaveLength(0);
  expect(within(libraryGroup).queryAllByTestId('row-chevron')).toHaveLength(0);
  expect(within(dangerGroup).queryAllByTestId('row-chevron')).toHaveLength(0);
  // 后台上传 keeps its status pill in the trailing slot.
  expect(within(screen.getByTestId('byos-background-sync')).getByTestId('byos-background-sync-state')).toBeOnTheScreen();
});

test('the disconnect row is the v4 danger row in its own card, with its detail kept', async () => {
  await renderReadySection();
  const row = screen.getByTestId('byos-disconnect');
  const [, , dangerGroup] = groupCards();
  expect(within(dangerGroup).getByTestId('byos-disconnect')).toBe(row);
  expect(within(row).getByText(LITERALS.en.disconnect)).toHaveStyle({
    ...settingsTypography.rowTitle, color: colors.light.danger,
  });
  expect(within(row).getByText(LITERALS.en.disconnectDetail)).toBeOnTheScreen();
});

test('the disconnect failure note is the v4 detail style in danger', async () => {
  // U3a mutation evidence (M07): an inline fontSize in the failure note is killed here,
  // the file-level source guard cannot see it (the section still hosts U4-owned literals).
  const disconnectDevice = jest.fn(async () => { throw new Error('store down'); });
  await renderReadySection({ connectFlow: flow({ disconnectDevice }) });
  await userEvent.press(screen.getByTestId('byos-disconnect'));
  await userEvent.press(screen.getByRole('button', { name: LITERALS.en.disconnectConfirm }));
  const note = await screen.findByTestId('byos-disconnect-failed');
  expect(note).toHaveStyle({ ...settingsTypography.detail, color: colors.light.danger });
});

test('the quota bar keeps its measured look inside the redrawn page', async () => {
  await renderReadySection();
  expect(screen.getByTestId('byos-quota')).toHaveStyle({
    paddingHorizontal: metrics.contentPadding,
    paddingVertical: metrics.spacing.medium,
    gap: metrics.spacing.small,
  });
});

test('locked layout hides the ready-only rows and labels, keeps its two controls and keeps the order', async () => {
  await render(
    <ByosSettingsSection
      byosStatus={lockedPassword}
      connectFlow={flow()}
      onReload={jest.fn()}
      data={cloudSnapshot(lockedPassword)}
      backgroundSync={backgroundPort(true)}
      renderCloudMessage={renderCloudMessage}
    />,
  );
  await act(async () => {});
  const root = screen.getByTestId('byos-locked-view');
  orderOf(root, ['byos-locked-card', 'byos-unlock-password', 'byos-unlock', 'byos-background-sync', 'byos-disconnect']);
  for (const id of ['byos-phone-group', 'byos-storage-mode', 'byos-library-group', 'byos-encryption', 'storage-kind-badge']) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
  const groups = groupCards();
  expect(groups).toHaveLength(2);
  expect(groups[0]).toHaveStyle({ marginTop: metrics.settingsGroupGap });
  expect(within(groups[0]).getByTestId('byos-background-sync')).toBeOnTheScreen();
  expect(groups[1]).toHaveStyle({ marginTop: metrics.settingsGroupGap });
  expect(within(groups[1]).getByTestId('byos-disconnect')).toBeOnTheScreen();
});

test('locked-state controls take the disabled dim form', async () => {
  const unlockData = cloudSnapshot(lockedPassword);
  await render(<ByosLockedView
    data={unlockData}
    password=""
    busy
    onPasswordChange={jest.fn()}
    onUnlock={jest.fn()}
    onReauth={jest.fn()}
    backgroundSync={backgroundPort(false)}
    disconnect={<View testID="disconnect-node" />}
    message={<View testID="byos-locked-reason" />}
  />);
  const unlock = screen.getByTestId('byos-unlock');
  expect(unlock).toBeDisabled();
  expect(StyleSheet.flatten(unlock.props.style).opacity).toBe(0.38);
  const allow = screen.getByTestId('byos-background-sync-allow');
  expect(allow).toBeDisabled();
  expect(StyleSheet.flatten(allow.props.style).opacity).toBe(0.38);
});

test('a held disconnect write dims the danger row until it settles', async () => {
  let release!: () => void;
  const disconnectDevice = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  await renderReadySection({ connectFlow: flow({ disconnectDevice }) });
  await userEvent.press(screen.getByTestId('byos-disconnect'));
  await userEvent.press(screen.getByRole('button', { name: LITERALS.en.disconnectConfirm }));
  await waitFor(() => expect(screen.getByTestId('byos-disconnect')).toBeDisabled());
  expect(StyleSheet.flatten(screen.getByTestId('byos-disconnect').props.style).opacity).toBe(0.38);
  await act(async () => { release(); });
  await waitFor(() => expect(screen.getByTestId('byos-disconnect')).toBeEnabled());
  expect(StyleSheet.flatten(screen.getByTestId('byos-disconnect').props.style).opacity).toBe(1);
});

test('not-connected layout shows the connect prompt and none of the lower-half rows', async () => {
  await render(
    <ByosSettingsSection
      byosStatus={{ status: 'unconfigured' }}
      connectFlow={flow()}
      onReload={jest.fn()}
      data={cloudSnapshot({ status: 'unconfigured' })}
      renderCloudMessage={renderCloudMessage}
    />,
  );
  await act(async () => {});
  for (const id of ['byos-ready-view', 'byos-locked-view', 'byos-phone-group', 'byos-storage-mode',
    'byos-background-sync', 'byos-library-group', 'byos-encryption', 'storage-kind-badge', 'byos-disconnect']) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
  for (const id of ['cloud-unconfigured', 'storage-location-picker', 'storage-pick-heading',
    'storage-pick-s3', 'storage-pick-gdrive', 'storage-pick-onedrive', 'storage-pick-webdav']) {
    expect(screen.getByTestId(id)).toBeOnTheScreen();
  }
});

test('the disconnect entry is guarded: confirm required, cancel closes, the entry reopens', async () => {
  const disconnectDevice = jest.fn(async () => undefined);
  await renderReadySection({ connectFlow: flow({ disconnectDevice }) });
  const entry = screen.getByTestId('byos-disconnect');
  await userEvent.press(entry);
  expect(disconnectDevice).not.toHaveBeenCalled();
  expect(within(entry).getByText(LITERALS.en.disconnectDetail)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: LITERALS.en.disconnectConfirm })).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: LITERALS.en.cancel }));
  expect(disconnectDevice).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: LITERALS.en.disconnectConfirm })).toBeNull();
  await userEvent.press(entry);
  expect(screen.getByRole('button', { name: LITERALS.en.disconnectConfirm })).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: LITERALS.en.disconnectConfirm }));
  expect(disconnectDevice).toHaveBeenCalledTimes(1);
});

test.each(LOCALES)('%s: the lower-half copy is the unchanged resource in every row', async (lng) => {
  await i18n.changeLanguage(lng);
  const copy = LITERALS[lng];
  for (const [field, key] of Object.entries(RESOURCE_KEYS)) {
    expect(i18n.getResource(lng, 'translation', key)).toBe(copy[field]);
  }
  await renderReadySection();
  const [phoneGroup, libraryGroup] = groupCards();
  expect(within(screen.getByTestId('byos-phone-group')).getByText(copy.phoneGroup)).toBeOnTheScreen();
  expect(within(screen.getByTestId('byos-library-group')).getByText(copy.libraryGroup)).toBeOnTheScreen();
  const storageRow = within(phoneGroup).getByTestId('byos-storage-mode');
  expect(within(storageRow).getByText(copy.storageLabel)).toBeOnTheScreen();
  expect(within(storageRow).getByText(copy.storageDetail)).toBeOnTheScreen();
  expect(within(storageRow).getByText(copy.storageValueBoth)).toBeOnTheScreen();
  const backgroundRow = within(phoneGroup).getByTestId('byos-background-sync');
  expect(within(backgroundRow).getByText(copy.backgroundLabel)).toBeOnTheScreen();
  expect(within(backgroundRow).getByText(copy.backgroundAllowed)).toBeOnTheScreen();
  const libraryRows = within(libraryGroup);
  const encryptionRow = libraryRows.getByTestId('byos-encryption');
  expect(within(encryptionRow).getByText(copy.encryptionLabel)).toBeOnTheScreen();
  expect(within(encryptionRow).getByText(copy.encryptionValueOn)).toBeOnTheScreen();
  const locationRow = libraryRows.getByTestId('storage-kind-badge');
  expect(within(locationRow).getByText(copy.locationLabel)).toBeOnTheScreen();
  expect(within(locationRow).getByText(copy.locationValueS3)).toBeOnTheScreen();
  const danger = screen.getByTestId('byos-disconnect');
  expect(within(danger).getByText(copy.disconnect)).toBeOnTheScreen();
  expect(within(danger).getByText(copy.disconnectDetail)).toBeOnTheScreen();
});

test('the redrawn lower half cites shared tokens and primitives, never inline literals', () => {
  const source = (name: string) => readFileSync(join(__dirname, name), 'utf8');
  const readySource = source('byos-ready-view.tsx');
  expect(readySource).toContain('marginHorizontal: metrics.settingsGutter');
  expect(readySource).toContain('<SectionHeading');
  expect(readySource).toContain('<SettingsGroup');
  expect(readySource).toContain('<SettingsRow');
  expect(readySource).not.toMatch(/font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|#[\da-f]{3,8}\b/i);
  const lockedSource = source('byos-locked-view.tsx');
  expect(lockedSource).toContain('marginHorizontal: metrics.settingsGutter');
  expect(lockedSource).toContain('marginTop: metrics.settingsGroupGap');
  expect(lockedSource).not.toMatch(/font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|#[\da-f]{3,8}\b/i);
  const sectionSource = source('byos-settings-section.tsx');
  expect(sectionSource).toContain('marginHorizontal: metrics.settingsGutter');
  expect(sectionSource).toContain('marginTop: metrics.settingsGroupGap');
  const rowSource = source('background-upload-row.tsx');
  expect(rowSource).toContain('<SettingsButton');
  expect(rowSource).toContain('<SettingsRow');
  expect(rowSource).not.toMatch(/font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|#[\da-f]{3,8}\b/i);
  const scrollSource = source('cloud-library-scroll.tsx');
  expect(scrollSource).toContain('Math.max(insets.bottom, metrics.gestureInset)');
  const screenSource = source('cloud-library-screen.tsx');
  expect(screenSource).toContain('backgroundColor: theme.surface');
  expect(screenSource).not.toContain('surfaceSecondary');
  const messageSource = source('library-cloud-section.tsx');
  expect(messageSource).toContain('settingsTypography.cloudMessage');
});
