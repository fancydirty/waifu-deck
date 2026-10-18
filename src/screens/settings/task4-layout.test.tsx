import { fireEvent, render, screen, within } from '@testing-library/react-native';
import * as RN from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import i18n from '@/i18n';
import { cloudCounts, cloudRead, cloudSnapshot } from '@/test/cloud-library-fixtures';
import { renderCloudMessage } from '@/test/cloud-message-fixture';
import { lightColors, darkColors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { metrics } from '@/theme/metrics';
import { ByosReadyView } from './byos-ready-view';
import { ByosLockedView } from './byos-locked-view';
import { CloudLibraryCard } from './cloud-library-card';
import { ByosSettingsSection, type ByosConnectFlow } from './byos-settings-section';

jest.mock('lucide-react-native', () => ({ Check: () => null, Cloud: () => null, Lock: () => null, Server: () => null, ChevronRight: () => null }));
const ready: ByosStatus = { status: 'ready', context: { kind: 's3', credentials: {
  kind: 's3', endpoint: 'https://example.r2.cloudflarestorage.com', bucket: 'library', region: 'auto', prefix: '', accessKeyId: 'private-key', secretAccessKey: 'private-secret',
}, meta: { format: 'waifu-deck-byos', protocolVersion: 1, vaultId: 'v', encryption: 'none', createdAt: '', kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: '' }, keyCheckB64: '' }, masterKey: null, deviceId: 'd' } };
const base = cloudSnapshot(ready, { counts: cloudRead({ ...cloudCounts, downloadedTotal: 8, inCloud: 3, inCloudBytes: 4_000_000, totalBytes: 1_900_000_000, pending: 2 }),
  mode: cloudRead('both', null), quotaFullCount: cloudRead(0), lastSyncedAt: cloudRead(100), viewNowMs: 200 });
const handlers = { onPasswordChange: jest.fn(), onUnlock: jest.fn(), onReauth: jest.fn(), busy: false, password: '', disconnect: <RN.View testID="disconnect" /> };
const connect = { disconnectDevice: jest.fn(async () => undefined) } as unknown as ByosConnectFlow;
beforeEach(async () => { await i18n.changeLanguage('en'); });

test.each(['gdrive', 'onedrive', 'webdav', 's3'] as const)('ready %s identity and stats agree with home, value-only rows expose no secrets', async (kind) => {
  const identity = { kind, label: kind === 's3' ? 'Wasabi' : kind === 'webdav' ? 'WebDAV' : kind === 'gdrive' ? 'Google Drive' : 'OneDrive', identity: kind === 's3' ? 'library' : 'me@example.com' };
  const data = { ...base, model: { ...base.model, identity } };
  const view = await render(<><CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />
    <ByosReadyView data={data} modeControlPresent busy={false} onStorageModePress={jest.fn()} disconnect={handlers.disconnect} /></>);
  for (const root of ['settings-cloud-card', 'byos-status']) {
    expect(within(screen.getByTestId(root)).getByText(identity.label)).toBeOnTheScreen();
    expect(within(screen.getByTestId(root)).getByText(identity.identity)).toBeOnTheScreen();
  }
  for (const prefix of ['cloud-stat', 'settings-cloud-stat']) {
    expect(screen.getByTestId(`${prefix}-in-cloud`)).toHaveTextContent('8 images');
    expect(screen.getByTestId(`${prefix}-total-bytes`)).toHaveTextContent('1.9 GB');
    expect(screen.getByTestId(`${prefix}-pending`)).toHaveTextContent('2 images');
  }
  expect(screen.getByTestId('byos-encryption')).toHaveTextContent('EncryptionNot encrypted');
  expect(screen.queryByTestId('byos-encryption-toggle')).toBeNull();
  expect(JSON.stringify(view.toJSON())).not.toMatch(/private-key|private-secret|masterKey|encryptionDetail/);
  expect(screen.queryByTestId('library-import')).toBeNull();
  expect(screen.queryByText(i18n.t('collection.import.entry'))).toBeNull();
});
test('loading placeholders and failed first read dashes preserve truthful stats; read zero is measured', async () => {
  const loading = cloudSnapshot(ready, { counts: { state: 'pending', fresh: false, roundId: 1 } });
  const view = await render(<ByosReadyView data={loading} modeControlPresent={false} busy={false} onStorageModePress={jest.fn()} disconnect={handlers.disconnect} />);
  for (const id of ['in-cloud', 'total-bytes', 'pending']) expect(screen.getByTestId(`cloud-stat-${id}-placeholder`)).toBeOnTheScreen();
  expect(screen.queryByTestId('cloud-pill')).toBeNull();
  expect(screen.queryByTestId('byos-mirror-progress')).toBeNull();
  expect(screen.queryByTestId('byos-last-sync')).toBeNull();
  const failed = cloudSnapshot(ready, { counts: { state: 'error', fresh: false, roundId: 1 } });
  await view.rerender(<ByosReadyView data={failed} modeControlPresent={false} busy={false} onStorageModePress={jest.fn()} disconnect={handlers.disconnect} />);
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.queryByTestId('byos-mirror-progress')).toBeNull();
});
for (const scheme of ['light', 'dark'] as const) {
  test.each([360, 412])(`${scheme} %s dp: token styles permit large text and avoid fixed-height cards`, async (width) => {
    jest.spyOn(RN, 'useColorScheme').mockReturnValue(scheme);
    jest.spyOn(RN, 'useWindowDimensions').mockReturnValue({ width, height: 800, scale: 3, fontScale: 2 });
    const data = cloudSnapshot({ status: 'locked', reason: 'meta_corrupt', detail: 'malformed' });
    await render(<ByosLockedView {...handlers} data={data} message={renderCloudMessage(data.model)} />);
    const theme = scheme === 'dark' ? darkColors : lightColors;
    const card = RN.StyleSheet.flatten(screen.getByTestId('byos-locked-card').props.style);
    expect(card).toMatchObject({ borderRadius: metrics.settingsRadius.cloud, borderColor: theme.danger, backgroundColor: theme.surfaceSecondary });
    expect(card.height).toBeUndefined();
    const pill = screen.getByTestId('cloud-pill');
    expect(RN.StyleSheet.flatten(pill.props.style)).toMatchObject({ backgroundColor: theme.dangerSoft });
    expect(pill).toHaveTextContent('Unreadable');
    expect(within(pill).getByText('Unreadable').props.style).toEqual(expect.objectContaining({ color: theme.danger }));
    for (const id of ['in-cloud', 'total-bytes', 'pending']) {
      const value = screen.getByTestId(`cloud-stat-${id}`);
      expect(value.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.5 });
      expect(RN.StyleSheet.flatten(value.props.style)).toMatchObject({ fontFamily: settingsTypography.cloudStat.fontFamily });
      expect(RN.StyleSheet.flatten(value.parent?.props.style)).toMatchObject({ flex: 1, minWidth: 0 });
    }
    expect(screen.queryByTestId('byos-unlock')).toBeNull();
  });
}
test.each([
  [4, 2, 0, 'both', 'Drive full, 4 images waiting to upload', 'byos-quota-full'],
  [0, 2, 0, 'both', '2 images still waiting to upload', 'byos-cloud-footer'],
  [0, 0, 1, 'both', 'Downloading, 7 images remaining', 'byos-cloud-footer'],
  [0, 0, 1, 'cloud-only', 'All backed up · Just now', 'byos-last-sync'],
] as const)('footer priority %j/%j/%j/%s appears once on each consumer', async (full, pending, downloaded, mode, expected, id) => {
  const data = cloudSnapshot(ready, { counts: cloudRead({ ...cloudCounts, downloadedTotal: 8, pending, downloaded }), mode: cloudRead(mode, null), quotaFullCount: cloudRead(full), lastSyncedAt: cloudRead(100), viewNowMs: 200 });
  await render(<><CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />
    <ByosReadyView data={data} modeControlPresent busy={false} onStorageModePress={jest.fn()} disconnect={handlers.disconnect} /></>);
  expect(screen.getAllByText(expected)).toHaveLength(2);
  expect(screen.getByTestId(id)).toHaveTextContent(expected);
  for (const other of ['byos-quota-full', 'byos-last-sync']) if (id !== other) expect(screen.queryByTestId(other)).toBeNull();
});
test('disconnect warning uses missing-local count; back-to-both size uses missing-local bytes', async () => {
  const data = cloudSnapshot(ready, { ...base, mode: cloudRead('cloud-only', null) });
  const mode = { read: jest.fn(async () => 'cloud-only' as const), set: jest.fn() };
  await render(<ByosSettingsSection data={data} byosStatus={ready} connectFlow={connect} onReload={jest.fn()} storageMode={mode} renderCloudMessage={renderCloudMessage} />);
  await fireEvent.press(screen.getByTestId('byos-disconnect'));
  expect(screen.getByText(i18n.t('settings.byos.disconnectConfirm.message'), { exact: false })).toHaveTextContent(/3 images/);
  expect(screen.queryByText(/8 images exist/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  await fireEvent.press(screen.getByTestId('byos-storage-mode'));
  await fireEvent.press(screen.getByRole('button', { name: 'This phone + cloud' }));
  expect(screen.getByText(i18n.t('settings.byos.storageMode.back.message', { count: 3, size: '3.8 MB' }))).toBeOnTheScreen();
  expect(mode.set).not.toHaveBeenCalled();
});
