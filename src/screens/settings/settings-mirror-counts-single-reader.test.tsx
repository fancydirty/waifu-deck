import { act, render, screen } from '@testing-library/react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import { createLibraryChangeFeed } from '@/features/library/library-change-feed';
import i18n from '@/i18n';
import { ByosSettingsSlot, ByosCloudLibraryProvider } from './byos-settings-slot';
import { cloudMessageFactory } from '@/test/cloud-message-fixture';
import { useCloudLibraryModel } from './cloud-library-context';
import { CloudLibraryCard } from './cloud-library-card';
import { cloudCounts } from '@/test/cloud-library-fixtures';
let mockServices: Record<string, unknown>;
jest.mock('@/providers/app-services', () => ({ useAppServices: () => mockServices }));
jest.mock('expo-router', () => ({ usePathname: () => '/settings' }));
jest.mock('@/features/byos/byos-connect-flow', () => ({}));
jest.mock('lucide-react-native', () => ({ Check: () => null, ChevronRight: () => null, Cloud: () => null, Lock: () => null, Server: () => null }));
jest.mock('@/features/byos/byos-credentials', () => ({ createByosCredentialStore: jest.fn() }));
function SecondConsumer() {
  const data = useCloudLibraryModel();
  return <CloudLibraryCard model={data.model} nowMs={data.viewNowMs} onPress={jest.fn()} />;
}
function readyStatus(): ByosStatus {
  return { status: 'ready', context: { kind: 's3', credentials: {
    kind: 's3', endpoint: 'https://example.r2.cloudflarestorage.com', region: 'auto',
    bucket: 'waifu-deck', accessKeyId: 'AKIA', secretAccessKey: 'shhh', prefix: 'waifu-deck/',
  }, meta: { format: 'waifu-deck-byos', protocolVersion: 1, encryption: 'aes-gcm', vaultId: 'v',
    kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: '' }, keyCheckB64: '', createdAt: '' },
    masterKey: new Uint8Array(32), deviceId: 'phone' } };
}
describe('settings mirror counts — shared snapshot', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  it.each([false, true])('two consumers and the old section retain one counts/feed reader (mode control %s)', async (withMode) => {
    const readMirrorCounts = jest.fn(async () => cloudCounts);
    const libraryChanges = createLibraryChangeFeed();
    const subscribe = jest.spyOn(libraryChanges, 'subscribe');
    const status = readyStatus();
    const actions = { readMirrorCounts, readQuotaFullCount: async () => 0, getAccountScope: async () => 'scope' } as never;
    const mode = { read: jest.fn(async () => 'both' as const), set: jest.fn() };
    const storageMode = withMode ? mode : null;
    mockServices = { byosStatus: status, libraryActions: actions, librarySync: null,
      libraryChanges, libraryStorageMode: storageMode, libraryController: null };
    function Screen(_: { tick: number }) {
      return <ByosCloudLibraryProvider><SecondConsumer />
        <ByosSettingsSlot renderCloudMessage={cloudMessageFactory(actions)} byosStatus={status} actions={actions} sync={null} libraryChanges={libraryChanges}
          storageMode={storageMode} onReload={jest.fn()} />
      </ByosCloudLibraryProvider>;
    }
    const { rerender, unmount } = await render(<Screen tick={0} />);
    expect(screen.getByTestId('cloud-stat-in-cloud')).toHaveTextContent('2 images');
    expect(screen.getByTestId('settings-cloud-stat-in-cloud')).toHaveTextContent('2 images');
    expect(readMirrorCounts).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    await rerender(<Screen tick={1} />);
    expect(readMirrorCounts).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) await act(async () => libraryChanges.emit({ kind: 'protected' }));
    expect(readMirrorCounts).toHaveBeenCalledTimes(4);
    expect(mode.read).toHaveBeenCalledTimes(withMode ? 1 : 0);
    expect(screen.queryByTestId('library-mirror-status')).toBeNull();
    await unmount();
  });
});
