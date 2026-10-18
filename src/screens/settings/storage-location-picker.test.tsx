import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import i18n from '@/i18n';
import {
  LOCATION_LABEL_KEY,
  StorageLocationPicker,
} from '@/screens/settings/storage-location-picker';
import { cloudBrandColors } from '@/theme/cloud-brand-colors';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ChevronRight: Icon, Cloud: Icon, Server: Icon };
});

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const;
// i18n.exists()/t() fall back to English; read each locale's own resource.
const own = (lng: string, key: string) => i18n.getResource(lng, 'translation', key) as string | undefined;

describe('StorageLocationPicker', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('reports the picked kind for every card, Google Drive included', async () => {
    const onPick = jest.fn();
    await render(<StorageLocationPicker onPick={onPick} />);
    for (const kind of ['s3', 'webdav', 'onedrive', 'gdrive'] as const) {
      await act(async () => {
        fireEvent.press(screen.getByTestId(`storage-pick-${kind}`));
      });
      expect(onPick).toHaveBeenLastCalledWith(kind);
    }
    expect(onPick).toHaveBeenCalledTimes(4);
  });

  it('renders the heading and four pressable rows, none of them disabled (the coming-soon mechanism is gone)', async () => {
    await render(<StorageLocationPicker onPick={jest.fn()} />);
    expect(screen.getByTestId('storage-pick-heading')).toHaveTextContent('S3-compatible storage');
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.queryAllByRole('button', { disabled: true })).toHaveLength(0);
    for (const kind of ['s3', 'webdav', 'onedrive', 'gdrive'] as const) {
      expect(screen.getByTestId(`storage-pick-${kind}`)).not.toBeDisabled();
    }
    expect(screen.getByLabelText('S3-compatible storage. Cloudflare R2, Wasabi, MinIO and more. Connect with your keys.')).toBeTruthy();
    expect(screen.getByLabelText('WebDAV. Nutstore, Nextcloud, NAS')).toBeTruthy();
    expect(screen.getByLabelText('OneDrive')).toBeTruthy();
    expect(screen.queryByText(/Coming in a later build/)).toBeNull();
  });

  // N4 §4.3 moves the access caveat into the unchanged Google form.
  it.each(LOCALES)('%s: picker Drive rows have no caveat or subtitle', async (lng) => {
    await i18n.changeLanguage(lng);
    await render(<StorageLocationPicker onPick={jest.fn()} />);
    const caveat = own(lng, 'settings.byos.gdrive.needsGoogle')!;
    const label = own(lng, LOCATION_LABEL_KEY.gdrive)!;
    const drive = screen.getByTestId('storage-pick-gdrive');
    expect(drive).toHaveTextContent(label);
    expect(drive).not.toHaveTextContent(caveat, { exact: false });
    expect(screen.getByLabelText(label)).toBeTruthy();
    for (const kind of ['s3', 'webdav', 'onedrive'] as const) {
      expect(screen.getByTestId(`storage-pick-${kind}`)).not.toHaveTextContent(caveat, { exact: false });
    }
  });

  it('U4-design visual pass: two group cards and brand-tinted icon tiles drawn from the v4 tokens', async () => {
    await render(<StorageLocationPicker onPick={jest.fn()} />);
    const cards = screen.container.queryAll((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.borderRadius === metrics.radius.card && style?.marginHorizontal === metrics.settingsGutter;
    });
    expect(cards).toHaveLength(2);
    const [s3Card, driveCard] = cards;
    expect(within(s3Card!).getByTestId('storage-pick-s3')).toBeOnTheScreen();
    expect(within(driveCard!).getByTestId('storage-pick-gdrive')).toBeOnTheScreen();
    expect(within(driveCard!).getByTestId('storage-pick-onedrive')).toBeOnTheScreen();
    expect(within(driveCard!).getByTestId('storage-pick-webdav')).toBeOnTheScreen();
    // Each row leads with the mockup's .wd-ico tile: 30/9, icon 18, and the
    // brand wash (S3 cloud-soft, OneDrive its own blue at 0.12, the rest hair).
    // The tile is the row's first host child (the SettingsRow icon slot).
    const tiles = screen.container.queryAll((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.width === metrics.settingsConnect.iconTile && style?.height === metrics.settingsConnect.iconTile;
    });
    expect(tiles).toHaveLength(4);
    for (const kind of ['s3', 'gdrive', 'onedrive', 'webdav'] as const) {
      const row = screen.getByTestId(`storage-pick-${kind}`);
      const tilesOfRow = tiles.filter((tile) => tile.parent === row);
      expect(tilesOfRow).toHaveLength(1);
      expect(tilesOfRow[0]).toHaveStyle({
        borderRadius: metrics.settingsConnect.iconTileRadius,
        backgroundColor: kind === 's3' ? colors.light.cloudSoft
          : kind === 'onedrive' ? cloudBrandColors.microsoftBlueSoft : colors.light.hair,
      });
    }
  });

  it('pins a resolvable label key for every binding kind in all four locales (dynamic keys the static-key scan cannot see)', () => {
    expect(Object.keys(LOCATION_LABEL_KEY).sort()).toEqual(['gdrive', 'onedrive', 's3', 'webdav']);
    for (const key of Object.values(LOCATION_LABEL_KEY)) {
      for (const lng of LOCALES) expect(own(lng, key)).toBeDefined();
    }
  });

  // Copy decision (Task 11, from the Task 8 quality review): the picker row,
  // the bound badge and the Drive card must name the service the same way.
  // zh-Hant and ja use Google's own localized names (「Google 雲端硬碟」,
  // 「Google ドライブ」); zh-Hans deliberately keeps the English "Google Drive"
  // rather than Google's 「Google 云端硬盘」, because mainland users meet the
  // product by that name (it is blocked there, so the English name is what
  // circulates); en keeps "Google Drive".
  it.each([
    ['en', 'Google Drive'], ['zh-Hans', 'Google Drive'], ['zh-Hant', 'Google 雲端硬碟'], ['ja', 'Google ドライブ'],
  ] as const)('%s: the Drive label is %s, and the card intro and the Drive error both use that same name', (lng, name) => {
    expect(own(lng, LOCATION_LABEL_KEY.gdrive)).toBe(name);
    expect(own(lng, 'settings.byos.gdrive.intro')).toContain(name);
    expect(own(lng, 'settings.byos.error.notGdrive')).toContain(name);
  });

  it('renders the S3 API key quick-setup row, three provider mini-badges, and Custom S3 credentials with the S3 cube mark when onOpenApiKeyDialog is supplied', async () => {
    const onPick = jest.fn();
    const onOpenApiKeyDialog = jest.fn();
    await render(<StorageLocationPicker onPick={onPick} onOpenApiKeyDialog={onOpenApiKeyDialog} />);
    expect(screen.getByTestId('storage-pick-s3-apikey')).toHaveTextContent(/Quick setup with API key/);
    expect(screen.getByTestId('storage-pick-s3')).toHaveTextContent(/Custom S3 credentials/);
    expect(screen.getByTestId('storage-pick-s3-cube-mark')).toBeTruthy();
    expect(screen.getByTestId('storage-drives-footnote')).toHaveTextContent(
      'Drive libraries are always encrypted with a password you set.',
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('storage-pick-s3-apikey'));
    });
    expect(onOpenApiKeyDialog).toHaveBeenLastCalledWith(null);

    for (const provider of ['bunny', 'b2', 'r2'] as const) {
      await act(async () => {
        fireEvent.press(screen.getByTestId(`storage-badge-${provider}`));
      });
      expect(onOpenApiKeyDialog).toHaveBeenLastCalledWith(provider);
    }
    expect(onOpenApiKeyDialog).toHaveBeenCalledTimes(4);
  });
});
