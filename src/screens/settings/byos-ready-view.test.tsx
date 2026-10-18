import { render, screen } from '@testing-library/react-native';
import { View } from 'react-native';
import i18n from '@/i18n';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import { cloudCounts, cloudSnapshot } from '@/test/cloud-library-fixtures';
import { ByosReadyView } from './byos-ready-view';
import { LOCATION_LABEL_KEY } from './storage-location-picker';

jest.mock('lucide-react-native', () => ({ Check: () => null, Cloud: () => null, Lock: () => null, Server: () => null, ChevronRight: () => null }));

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

const data = cloudSnapshot(ready, {
  counts: { state: 'read', fresh: true, roundId: 1, value: { ...cloudCounts, downloadedTotal: 8, totalBytes: 1_900_000_000, pending: 2, inCloud: 3, inCloudBytes: 444 } },
  mode: { state: 'read', fresh: true, roundId: null, value: 'both' },
  quota: { usedBytes: 1_250_000_000, totalBytes: 2_000_000_000 },
  quotaFullCount: { state: 'read', fresh: true, roundId: 1, value: 0 },
  lastSyncedAt: { state: 'read', fresh: true, roundId: 1, value: 100 },
  readRoundId: 1,
  viewNowMs: 200,
});

describe('ByosReadyView', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });

  it.each([
    ['Cloudflare R2', 's3'],
    ['Wasabi', 's3'],
    ['s3.example.com', 's3'],
    ['WebDAV', 'webdav'],
    ['OneDrive', 'onedrive'],
    ['Google Drive', 'gdrive'],
  ] as const)('uses the provider kind for the storage row when the card identity is %s', async (brand, kind) => {
    const model = { ...data.model, identity: { kind, label: brand, identity: 'bucket-or-account' } };
    await render(<ByosReadyView data={{ ...data, model }} modeControlPresent={false} busy={false}
      onStorageModePress={jest.fn()} disconnect={<View testID="disconnect-node" />} />);
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(new RegExp(i18n.t(LOCATION_LABEL_KEY[kind])));
    expect(screen.getByTestId('byos-status')).toHaveTextContent(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('falls back to the cloud-library heading when the identity is unavailable', async () => {
    const model = { ...data.model, identity: null };
    await render(<ByosReadyView data={{ ...data, model }} modeControlPresent={false} busy={false}
      onStorageModePress={jest.fn()} disconnect={<View testID="disconnect-node" />} />);
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(new RegExp(i18n.t('settings.byos.heading')));
  });
  it('keeps the connected page order and reuses the measured card stats', async () => {
    await render(<ByosReadyView
      data={data}
      modeControlPresent
      busy={false}
      onStorageModePress={jest.fn()}
      backgroundSync={{ isBatteryOptimizationIgnored: () => true, requestIgnoreBatteryOptimizations: async () => undefined }}
      disconnect={<View testID="disconnect-node" />}
    />);

    const root = screen.getByTestId('byos-ready-view');
    const order = JSON.stringify(root);
    expect(order.indexOf('byos-status')).toBeLessThan(order.indexOf('byos-quota'));
    expect(order.indexOf('byos-quota')).toBeLessThan(order.indexOf('byos-storage-mode'));
    expect(order.indexOf('byos-storage-mode')).toBeLessThan(order.indexOf('byos-background-sync'));
    expect(order.indexOf('byos-background-sync')).toBeLessThan(order.indexOf('byos-library-group'));
    expect(order.indexOf('byos-library-group')).toBeLessThan(order.indexOf('disconnect-node'));

    expect(screen.getByTestId('byos-status')).toHaveTextContent(/Cloudflare R2/);
    expect(screen.getByTestId('cloud-stat-in-cloud')).toHaveTextContent('8 images');
    expect(screen.getByTestId('cloud-stat-total-bytes')).toHaveTextContent('1.9 GB');
    expect(screen.getByTestId('cloud-stat-pending')).toHaveTextContent('2 images');
    expect(screen.getByTestId('byos-quota')).toBeOnTheScreen();
    expect(screen.getByTestId('byos-storage-mode')).toHaveTextContent(/This phone \+ cloud/);
    expect(screen.getByTestId('byos-background-sync')).toBeOnTheScreen();
    expect(screen.getByTestId('byos-library-group')).toHaveTextContent('This cloud library');
    expect(screen.getByTestId('byos-encryption')).toHaveTextContent(/Encrypted/);
    expect(screen.getByTestId('storage-kind-badge')).toHaveTextContent(/S3-compatible storage/);
    expect(screen.getByTestId('byos-status')).toHaveTextContent(/Cloudflare R2/);
  });

});
