import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, fireEvent, render, screen, userEvent, waitFor, within } from '@testing-library/react-native';
import { Alert, StyleSheet } from 'react-native';

import type { DeleteAllAppDataResult } from '@/providers/app-services';
import i18n from '@/i18n';
import en from '@/i18n/locales/en';
import ja from '@/i18n/locales/ja';
import zhHans from '@/i18n/locales/zh-Hans';
import zhHant from '@/i18n/locales/zh-Hant';
import { colors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { ResetSettingsScreen } from './reset-settings-screen';

let mockServices: {
  resetDismissedHistory: jest.Mock;
  resetDiscoveryHistory: jest.Mock;
  deleteAllAppData: jest.Mock;
  byosStatus: { status: string };
};
jest.mock('@/providers/app-services', () => ({ useAppServices: () => mockServices }));
jest.mock('lucide-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View: NativeView } = require('react-native');
  const Icon = () => null;
  const ChevronRight = (props: Record<string, unknown>) => React.createElement(NativeView, { ...props, testID: 'settings-reset-chevron' });
  return { RotateCcw: Icon, Trash2: Icon, ChevronRight, Archive: Icon, ArchiveRestore: Icon,
    Check: Icon, Database: Icon, HardDrive: Icon, Filter: Icon, Languages: Icon, Cloud: Icon, Lock: Icon, Server: Icon, X: Icon, Search: Icon };
});

function result(overrides: Partial<DeleteAllAppDataResult> = {}): DeleteAllAppDataResult {
  return {
    ok: true, files: { deleted: [], failed: [] },
    database: { status: 'deleted', deletedRows: 4, error: null },
    settings: { status: 'deleted', error: null },
    library: { status: 'deleted', cloud: 'skipped', disconnected: false, error: null },
    remaining: [], recomposed: false, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const rows = ['重置已忽略记录', '重置发现记录', '删除全部应用数据'];
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
async function renderReset(queryClient = client()) {
  return render(<QueryClientProvider client={queryClient}><ResetSettingsScreen /></QueryClientProvider>);
}
async function openDelete() {
  await userEvent.press(screen.getByTestId('settings-delete-all'));
}
async function confirmDelete() {
  await openDelete();
  await fireEvent.changeText(screen.getByTestId('settings-delete-all-input'), 'DELETE');
  await userEvent.press(screen.getByTestId('settings-delete-all-confirm'));
}
async function confirmOperation(kind: 'dismissed' | 'discovery' | 'delete') {
  if (kind === 'delete') return confirmDelete();
  await userEvent.press(screen.getByRole('button', { name: kind === 'dismissed' ? rows[0] : rows[1] }));
  await userEvent.press(screen.getByRole('button', { name: kind === 'dismissed' ? '确认重置已忽略记录' : '确认重置发现记录' }));
}
beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans');
  mockServices = {
    resetDismissedHistory: jest.fn().mockResolvedValue(2),
    resetDiscoveryHistory: jest.fn().mockResolvedValue(5),
    deleteAllAppData: jest.fn().mockResolvedValue(result()),
    byosStatus: { status: 'unconfigured' },
  };
});

test('renders neutral reset rows and an isolated destructive delete card, with no in-content title or closed-modal IDs', async () => {
  await renderReset();
  expect(screen.getByTestId('screen-settings-reset')).toBeOnTheScreen();
  const scroll = screen.getByTestId('settings-reset-scroll');
  expect(screen.getByTestId('screen-settings-reset')).toHaveStyle({ backgroundColor: colors.light.surface });
  expect(scroll).toHaveStyle({ backgroundColor: colors.light.surface });
  expect(within(scroll).getAllByRole('button').map((node) => node.props.accessibilityLabel)).toEqual(rows);
  const groups = screen.container.queryAll((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.borderRadius === 14 && style?.marginHorizontal === 14;
  });
  expect(groups).toHaveLength(2);
  const [neutralGroup, dangerGroup] = groups;
  expect(neutralGroup).toHaveStyle({ backgroundColor: colors.light.surfaceSecondary, marginHorizontal: 14, borderRadius: 14 });
  expect(dangerGroup).toHaveStyle({ backgroundColor: colors.light.surfaceSecondary, marginHorizontal: 14, marginTop: 14, borderRadius: 14 });
  expect(StyleSheet.flatten(neutralGroup.props.style).marginTop).toBeUndefined();
  expect(neutralGroup.parent).toBe(dangerGroup.parent);
  expect(within(neutralGroup).getAllByRole('button')).toHaveLength(2);
  expect(within(dangerGroup).getAllByRole('button')).toHaveLength(1);
  expect(screen.container.queryAll((node) => StyleSheet.flatten(node.props.style)?.width === 28)).toHaveLength(0);
  for (const row of rows.slice(0, 2)) {
    expect(within(screen.getByRole('button', { name: row })).getByText(row)).toHaveStyle({ color: colors.light.text });
    expect(within(screen.getByRole('button', { name: row })).getByText(i18n.t(row === rows[0]
      ? 'settings.privacy.resetDismissedDetail' : 'settings.privacy.resetDiscoveryDetail'))).toBeOnTheScreen();
  }
  expect(within(screen.getByRole('button', { name: rows[2] })).getByText(rows[2])).toHaveStyle({ color: colors.light.danger });
  expect(screen.getAllByTestId('settings-reset-chevron')).toHaveLength(3);
  expect(screen.queryByText('重置与删除')).toBeNull();
  for (const id of ['settings-delete-all-input', 'settings-delete-all-confirm', 'settings-cloud-card',
    'settings-style-preference', 'settings-sources-entry', 'settings-adult-content-mode', 'backup-restore']) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
});

test.each([
  ['dismissed', '重置已忽略记录？', '已忽略图片之后可以再次出现，收藏保持不变。', 2],
  ['discovery', '重置发现记录？', '发现页会重新开始，看过和忽略过的图片可能再次出现。收藏保持不变。', 5],
] as const)('%s opens the exact confirm, cancels safely, then calls only its matching service', async (kind, title, message, count) => {
  await renderReset();
  const row = kind === 'dismissed' ? rows[0] : rows[1];
  await userEvent.press(screen.getByRole('button', { name: row }));
  expect(screen.getByText(title)).toBeOnTheScreen();
  expect(screen.getByText(message)).toBeOnTheScreen();
  expect(mockServices.resetDismissedHistory).not.toHaveBeenCalled();
  expect(mockServices.resetDiscoveryHistory).not.toHaveBeenCalled();
  await userEvent.press(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByText(title)).toBeNull();
  await confirmOperation(kind);
  const notice = await screen.findByTestId('settings-notice');
  expect(notice).toHaveTextContent(`已重置 ${count} 条记录。`);
  expect(notice).toHaveStyle({ ...settingsTypography.detail, padding: 12,
    color: colors.light.text, backgroundColor: colors.light.surfaceSecondary,
    borderTopWidth: 1, borderTopColor: colors.light.hair });
  expect(mockServices.resetDismissedHistory).toHaveBeenCalledTimes(kind === 'dismissed' ? 1 : 0);
  expect(mockServices.resetDiscoveryHistory).toHaveBeenCalledTimes(kind === 'discovery' ? 1 : 0);
  expect(mockServices.deleteAllAppData).not.toHaveBeenCalled();
});

test('cancel then reopen clears typed DELETE; lowercase and whitespace never enable the exact confirm', async () => {
  await renderReset();
  await openDelete();
  expect(screen.getByText(zhHans.settings.deleteAll.message)).toBeOnTheScreen();
  const input = screen.getByTestId('settings-delete-all-input');
  expect(screen.getByTestId('settings-delete-all-confirm')).toBeDisabled();
  for (const phrase of ['delete', 'Delete', ' DELETE', 'DELETE ']) {
    await fireEvent.changeText(input, phrase);
    expect(screen.getByTestId('settings-delete-all-confirm')).toBeDisabled();
    await userEvent.press(screen.getByTestId('settings-delete-all-confirm'));
    expect(mockServices.deleteAllAppData).not.toHaveBeenCalled();
  }
  await fireEvent.changeText(input, 'DELETE');
  expect(screen.getByTestId('settings-delete-all-confirm')).toBeEnabled();
  await userEvent.press(screen.getByRole('button', { name: '取消删除全部应用数据' }));
  expect(screen.queryByTestId('settings-delete-all-input')).toBeNull();
  await openDelete();
  expect(screen.getByTestId('settings-delete-all-input')).toHaveProp('value', '');
  expect(screen.getByTestId('settings-delete-all-confirm')).toBeDisabled();
  await fireEvent.changeText(screen.getByTestId('settings-delete-all-input'), 'DELETE');
  await userEvent.press(screen.getByTestId('settings-delete-all-confirm'));
  expect(await screen.findByTestId('settings-notice')).toHaveTextContent('全部应用数据已删除。');
  expect(mockServices.deleteAllAppData).toHaveBeenCalledTimes(1);
  expect(mockServices.resetDismissedHistory).not.toHaveBeenCalled();
  expect(mockServices.resetDiscoveryHistory).not.toHaveBeenCalled();
});

test.each(['dismissed', 'discovery', 'delete'] as const)('U2b actions open only their matching dialog and stay blocked during run (%s)', async (kind) => {
  const held = deferred<number | DeleteAllAppDataResult>();
  const service = kind === 'dismissed' ? mockServices.resetDismissedHistory
    : kind === 'discovery' ? mockServices.resetDiscoveryHistory : mockServices.deleteAllAppData;
  service.mockImplementationOnce(() => held.promise);
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await renderReset();
    await confirmOperation(kind);
    expect(service).toHaveBeenCalledTimes(1);
    const actions = within(screen.getByTestId('settings-reset-scroll')).getAllByRole('button');
    expect(actions).toHaveLength(3);
    for (const action of actions) {
      expect(action).toBeDisabled();
      expect(StyleSheet.flatten(action.props.style).opacity).toBe(0.38);
      await userEvent.press(action);
    }
    if (kind === 'delete') {
      expect(screen.getByTestId('settings-delete-all-input')).toHaveProp('editable', false);
      expect(screen.getByTestId('settings-delete-all-confirm')).toBeDisabled();
      expect(screen.getByRole('button', { name: '取消删除全部应用数据' })).toBeDisabled();
    }
    await act(async () => { held.reject(new Error('private raw failure')); });
    expect(await screen.findByTestId('settings-notice')).toHaveTextContent(i18n.t('settings.operationError'));
    expect(screen.queryByText('private raw failure')).toBeNull();
    for (const row of rows) {
      const host = screen.getByRole('button', { name: row });
      expect(host).toBeEnabled();
      expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
    }
    if (kind === 'delete') {
      expect(screen.getByTestId('settings-delete-all-input')).toHaveProp('editable', true);
      await userEvent.press(screen.getByTestId('settings-delete-all-confirm'));
    } else await confirmOperation(kind);
    await waitFor(() => expect(service).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('settings-notice')).toHaveTextContent(kind === 'delete' ? '全部应用数据已删除。' : `已重置 ${kind === 'dismissed' ? 2 : 5} 条记录。`);
    expect(screen.getByTestId('settings-notice')).not.toHaveTextContent(i18n.t('settings.operationError'));
  } finally { errorLog.mockRestore(); }
});

test.each([true, false])('awaits exact storage invalidation before publishing a non-recomposed notice (ok=%s)', async (ok) => {
  const queryClient = client();
  const heldRefresh = deferred<void>();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockImplementation(() => heldRefresh.promise);
  mockServices.deleteAllAppData.mockResolvedValue(result({ ok, remaining: ok ? [] : ['files'] }));
  await renderReset(queryClient);
  try {
    await confirmDelete();
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings', 'storage'] });
    expect(screen.queryByTestId('settings-notice')).toBeNull();
    for (const row of rows) expect(screen.getByRole('button', { name: row })).toBeDisabled();
  } finally { await act(async () => { heldRefresh.resolve(); }); }
  expect(await screen.findByTestId('settings-notice')).toHaveTextContent(ok ? '全部应用数据已删除。' : '部分数据未能删除：本机文件仍保留。');
  expect(screen.queryByTestId('settings-delete-all-input')).toBeNull();
  expect(screen.queryByTestId('settings-delete-all-confirm')).toBeNull();
});

test.each([false, true])('active preview and collection queries refresh only without recomposition (%s)', async (recomposed) => {
  const queryClient = client();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const preview = jest.fn().mockResolvedValue(1500);
  const collection = jest.fn().mockResolvedValue(3000);
  function StorageProbe() {
    useQuery({ queryKey: ['settings', 'storage', 'preview', 0], queryFn: preview });
    useQuery({ queryKey: ['settings', 'storage', 'collection', 0], queryFn: collection });
    return null;
  }
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockServices.deleteAllAppData.mockResolvedValue(result({ ok: false, remaining: ['files'], recomposed }));
  try {
    await render(<QueryClientProvider client={queryClient}><StorageProbe /><ResetSettingsScreen /></QueryClientProvider>);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(collection).toHaveBeenCalledTimes(1);
    await confirmDelete();
    if (recomposed) {
      await waitFor(() => expect(alert).toHaveBeenCalledWith('删除全部应用数据', '部分数据未能删除：本机文件仍保留。'));
      expect(screen.queryByTestId('settings-notice')).toBeNull();
    } else expect(await screen.findByTestId('settings-notice')).toHaveTextContent('部分数据未能删除：本机文件仍保留。');
    expect(invalidate).toHaveBeenCalledTimes(recomposed ? 0 : 1);
    expect(preview).toHaveBeenCalledTimes(recomposed ? 1 : 2);
    expect(collection).toHaveBeenCalledTimes(recomposed ? 1 : 2);
  } finally { alert.mockRestore(); }
});

test('a leftover backup archive alone is reported as files on this phone, without raw errors', async () => {
  // includeBackupSweep folds this exact kind of archive failure into files;
  // the database, collection files, settings and library have all been deleted.
  mockServices.deleteAllAppData.mockResolvedValue(result({
    ok: false, remaining: ['files'], files: { deleted: ['file:///collection/1.jpg'], failed: [{
      uri: 'file:///database/restore-import-1790850945725.waifudeck',
      error: { code: 'delete_failed', message: 'private archive busy' },
    }] },
  }));
  await renderReset();
  await confirmDelete();
  expect(await screen.findByTestId('settings-notice')).toHaveTextContent('部分数据未能删除：本机文件仍保留。');
  expect(screen.queryByText(/private archive|restore-import|数据库|受管/)).toBeNull();
});

test.each(['ready', 'locked', 'unconfigured'])('cloudBound includes every configured state (%s), without duplicating a failed disconnect', async (status) => {
  mockServices.byosStatus = { status };
  mockServices.deleteAllAppData.mockResolvedValue(result({
    ok: false, remaining: ['database'],
    database: { status: 'failed', deletedRows: 0, error: null },
    library: { status: 'failed', cloud: 'skipped', disconnected: false, error: null },
  }));
  await renderReset();
  await confirmDelete();
  expect(await screen.findByTestId('settings-notice')).toHaveTextContent(status === 'unconfigured'
    ? '部分数据未能删除：收藏和浏览记录仍保留。' : '部分数据未能删除：收藏和浏览记录、云库连接仍保留。');
  mockServices.deleteAllAppData.mockResolvedValue(result({ ok: false, remaining: ['cloud'] }));
  await confirmDelete();
  expect(await screen.findByTestId('settings-notice')).toHaveTextContent('部分数据未能删除：云库连接仍保留。');
});

test('a recomposed partial result alerts even after unmount, with no invalidation; success adds no alert', async () => {
  const queryClient = client();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const held = deferred<DeleteAllAppDataResult>();
  mockServices.deleteAllAppData.mockImplementationOnce(() => held.promise);
  try {
    const view = await renderReset(queryClient);
    await confirmDelete();
    await view.unmount();
    await act(async () => { held.resolve(result({ ok: false, remaining: ['cloud'], recomposed: true,
      library: { status: 'deleted', cloud: 'failed', disconnected: true, error: null } })); });
    expect(alert).toHaveBeenCalledWith('删除全部应用数据', '部分数据未能删除：云库图片记录仍保留。');
    expect(invalidate).not.toHaveBeenCalled();
    mockServices.deleteAllAppData.mockResolvedValue(result({ recomposed: true }));
    await renderReset(queryClient);
    await confirmDelete();
    expect(await screen.findByTestId('settings-notice')).toHaveTextContent('全部应用数据已删除。');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  } finally { alert.mockRestore(); }
});

const localeCases = [
  { language: 'zh-Hans', locale: zhHans, title: '重置与删除',
    dismissedTitle: '重置已忽略记录', discoveryTitle: '重置发现记录', deleteTitle: '删除全部应用数据',
    dismissed: '忽略过的图片可能再次出现；收藏不变',
    discovery: '发现页重新开始，看过和忽略过的图片可能再出现；收藏不变',
    deleteDetail: '删除收藏文件、发现记录和设置',
    message: '发现页会重新开始，看过和忽略过的图片可能再次出现。收藏保持不变。',
    files: '本机文件', database: '收藏和浏览记录',
    warning: '这会删除这台手机上的收藏文件、发现记录和设置。已连接的云库也会断开；云库里的图片不受影响，重新连接即可取回。请输入 DELETE 继续。' },
  { language: 'zh-Hant', locale: zhHant, title: '重置與刪除',
    dismissedTitle: '重設已略過紀錄', discoveryTitle: '重設探索紀錄', deleteTitle: '刪除所有應用程式資料',
    dismissed: '略過的圖片可能再次出現；收藏不變',
    discovery: '探索頁重新開始，看過與略過的圖片可能再出現；收藏不變',
    deleteDetail: '刪除收藏檔案、探索紀錄與設定',
    message: '探索頁會重新開始，看過與略過的圖片可能再次出現。收藏保持不變。',
    files: '本機檔案', database: '收藏與瀏覽紀錄',
    warning: '這會刪除這台手機上的收藏檔案、探索紀錄與設定。已連線的雲端媒體庫也會中斷；媒體庫裡的圖片不受影響，重新連線即可取回。請輸入 DELETE 繼續。' },
  { language: 'ja', locale: ja, title: 'リセットと削除',
    dismissedTitle: '除外履歴をリセット', discoveryTitle: '「見つける」の履歴をリセット', deleteTitle: 'アプリの全データを削除',
    dismissed: '除外した画像が再び表示されることがあります。コレクションは変わりません',
    discovery: '「見つける」が最初からになり、表示済み・除外した画像が再び表示されることがあります。コレクションは変わりません',
    deleteDetail: 'コレクションのファイル、閲覧履歴、設定を削除します',
    message: '「見つける」が最初からになり、表示済み・除外した画像が再び表示されることがあります。コレクションは変わりません。',
    files: 'この端末のファイル', database: 'コレクションと閲覧履歴',
    warning: 'この端末のコレクションのファイル、閲覧履歴、設定が削除されます。接続中のクラウドライブラリも切断されます（ライブラリ内の画像はそのまま残り、再接続すると戻ります）。続行するには「DELETE」と入力してください。' },
  { language: 'en', locale: en, title: 'Reset & delete',
    dismissedTitle: 'Reset dismissed history', discoveryTitle: 'Reset discovery history', deleteTitle: 'Delete all app data',
    dismissed: 'Dismissed images may appear again; your collection stays',
    discovery: 'Discover starts over; images you have seen or dismissed may appear again; your collection stays',
    deleteDetail: 'Delete collection files, discovery history, and settings',
    message: 'Discover will start over, and images you have seen or dismissed may appear again. Your collection stays unchanged.',
    files: 'files on this phone', database: 'collection and browsing records',
    warning: "This deletes this phone's collection files, discovery history, and settings. A connected cloud library is disconnected too; the images in it are not touched, and connecting again brings them back. Enter DELETE to continue." },
] as const;

test.each(localeCases)('$language exact reset card copy resolves locally and the cloud warning stays unchanged', async ({ language, title, dismissedTitle, discoveryTitle, deleteTitle, dismissed, discovery, deleteDetail, message, files, database, warning }) => {
  await i18n.changeLanguage(language);
  for (const [key, value] of [
    ['settings.reset.title', title], ['settings.reset.entry', title],
    ['settings.privacy.resetDismissed', dismissedTitle], ['settings.privacy.resetDiscovery', discoveryTitle],
    ['settings.privacy.resetDismissedDetail', dismissed], ['settings.privacy.resetDiscoveryDetail', discovery],
    ['settings.privacy.deleteAll', deleteTitle], ['settings.privacy.deleteAllDetail', deleteDetail],
    ['settings.reset.discoveryMessage', message], ['settings.deleteAll.files', files],
    ['settings.deleteAll.database', database], ['settings.deleteAll.message', warning],
  ]) expect(i18n.getResource(language, 'translation', key)).toBe(value);
  await renderReset();
  expect(screen.getByText(dismissedTitle)).toBeOnTheScreen();
  expect(screen.getByText(discoveryTitle)).toBeOnTheScreen();
  expect(screen.getByText(deleteTitle)).toBeOnTheScreen();
  expect(screen.getByText(deleteDetail)).toBeOnTheScreen();
  expect(screen.getByText(dismissed)).toBeOnTheScreen();
  expect(screen.getByText(discovery)).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: i18n.t('settings.privacy.resetDiscovery') }));
  expect(screen.getByText(message)).toBeOnTheScreen();
  await userEvent.press(screen.getByRole('button', { name: i18n.t('common.cancel') }));
  await openDelete();
  expect(screen.getByText(warning)).toBeOnTheScreen();
});

describe.each(localeCases)('$language partial labels', ({ language, locale, files, database }) => {
  test.each([
    ['files', false], ['database', false], ['settings', false], ['cloud', false], ['cloud', true],
  ] as const)('%s disconnected=%s renders its user-facing label', async (stage, disconnected) => {
    await i18n.changeLanguage(language);
    mockServices.deleteAllAppData.mockResolvedValue(result({ ok: false, remaining: [stage],
      library: { status: 'deleted', cloud: 'failed', disconnected, error: null } }));
    await renderReset();
    await confirmDelete();
    const label = stage === 'files' ? files : stage === 'database' ? database
      : stage === 'settings' ? locale.settings.deleteAll.settings
        : disconnected ? locale.settings.deleteAll.cloudRecords : locale.settings.deleteAll.cloud;
    expect(await screen.findByTestId('settings-notice')).toHaveTextContent(locale.settings.deleteAll.remaining.replace('{{labels}}', label));
    expect(screen.getByTestId('settings-notice')).not.toHaveTextContent(/队列|佇列|キュー|queue|受管|managed|資料庫|数据库|database|データベース|非收藏/);
  });
});
