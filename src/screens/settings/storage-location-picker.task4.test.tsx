import { render, screen } from '@testing-library/react-native';
import i18n from '@/i18n';
import { LOCATION_LABEL_KEY, StorageLocationPicker } from './storage-location-picker';

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const;
const own = (lng: string, key: string) => i18n.getResource(lng, 'translation', key) as string;

jest.mock('lucide-react-native', () => ({ ChevronRight: () => null, Cloud: () => null, Server: () => null }));

test('unconfigured picker uses two groups, marks, and only the approved subtitles', async () => {
  await i18n.changeLanguage('en');
  await render(<StorageLocationPicker onPick={jest.fn()} />);
  const root = screen.getByTestId('storage-location-picker');
  const json = JSON.stringify(root);
  expect(json.indexOf('S3-compatible storage')).toBeLessThan(json.indexOf('Cloud drives'));
  expect(json.indexOf('storage-pick-gdrive')).toBeLessThan(json.indexOf('storage-pick-onedrive'));
  expect(json.indexOf('storage-pick-onedrive')).toBeLessThan(json.indexOf('storage-pick-webdav'));
  expect(screen.getByTestId('storage-pick-s3')).toHaveTextContent(/Cloudflare R2, Wasabi, MinIO/);
  expect(screen.getByTestId('storage-pick-webdav')).toHaveTextContent(/Nutstore, Nextcloud, NAS/);
  expect(screen.getByTestId('storage-pick-gdrive')).not.toHaveTextContent('Needs a network');
  expect(screen.getByTestId('storage-pick-onedrive')).not.toHaveTextContent('Needs a network');
});

test.each(LOCALES)('%s: S3 and WebDAV accessible names include their choosing subtitles; drive names stay label-only', async (lng) => {
  await i18n.changeLanguage(lng);
  await render(<StorageLocationPicker onPick={jest.fn()} />);
  const s3Label = own(lng, LOCATION_LABEL_KEY.s3);
  const s3Subtitle = own(lng, 'settings.cloudLibrary.s3Subtitle');
  const webdavLabel = own(lng, LOCATION_LABEL_KEY.webdav);
  const webdavSubtitle = own(lng, 'settings.cloudLibrary.webdavSubtitle');
  expect(screen.getByLabelText(`${s3Label}. ${s3Subtitle}`)).toBeOnTheScreen();
  expect(screen.getByLabelText(`${webdavLabel}. ${webdavSubtitle}`)).toBeOnTheScreen();
  expect(screen.getByLabelText(own(lng, LOCATION_LABEL_KEY.gdrive))).toBeOnTheScreen();
  expect(screen.getByLabelText(own(lng, LOCATION_LABEL_KEY.onedrive))).toBeOnTheScreen();
});
