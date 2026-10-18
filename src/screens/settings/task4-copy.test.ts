import { createElement } from 'react';
import { render, screen } from '@testing-library/react-native';
import i18n from '@/i18n';
import { StorageLocationPicker } from './storage-location-picker';

jest.mock('lucide-react-native', () => ({ ChevronRight: () => null, Cloud: () => null, Server: () => null }));

// Independent transcription of CD 13, not copied from the locale module.
const approved = {
  en: {
    wrongPassword: 'Incorrect password. Try again.', passwordRequired: 'Enter your password.',
    signInCancelled: "Sign-in cancelled. You can sign in again when you're ready.",
    networkAction: "Can't reach the cloud library. Check your network and try again.",
    heroTitle: 'Your images in your own cloud', heroDetail: 'Connect phones to the same cloud library for the same collection.',
    driveGroup: 'Cloud drives', s3Subtitle: 'Cloudflare R2, Wasabi, MinIO and more. Connect with your keys.',
    webdavSubtitle: 'Nutstore, Nextcloud, NAS', phoneGroup: 'This phone', libraryGroup: 'This cloud library', encryption: 'Encryption',
  },
  ja: {
    wrongPassword: 'パスワードが正しくありません。もう一度お試しください。', passwordRequired: 'パスワードを入力してください。',
    signInCancelled: 'ログインをキャンセルしました。必要なときにもう一度ログインできます。',
    networkAction: 'クラウドライブラリに接続できません。ネットワークを確認して、もう一度お試しください。',
    heroTitle: '画像は自分のクラウドに', heroDetail: '同じクラウドライブラリにつなげば、どのスマートフォンでも同じコレクション。',
    driveGroup: 'クラウドストレージ', s3Subtitle: 'Cloudflare R2、Wasabi、MinIO など。キーを入力して接続', webdavSubtitle: 'Nutstore、Nextcloud、NAS',
    phoneGroup: 'このスマートフォン', libraryGroup: 'このクラウドライブラリ', encryption: '暗号化',
  },
  'zh-Hans': {
    wrongPassword: '密码不正确，请再试一次。', passwordRequired: '请输入密码。', signInCancelled: '已取消登录。需要时可以重新登录。',
    networkAction: '连不上云库。检查网络后再试一次。', heroTitle: '图存在你自己的云里', heroDetail: '多台手机连同一个云库，就是同一份收藏。',
    driveGroup: '网盘', s3Subtitle: 'Cloudflare R2、Wasabi、MinIO 等，填 key 即可', webdavSubtitle: '坚果云、Nextcloud、NAS',
    phoneGroup: '这台手机', libraryGroup: '这个云库', encryption: '加密',
  },
  'zh-Hant': {
    wrongPassword: '密碼不正確，請再試一次。', passwordRequired: '請輸入密碼。', signInCancelled: '已取消登入。需要時可以重新登入。',
    networkAction: '連不上雲庫。檢查網路後再試一次。', heroTitle: '圖片存在你自己的雲端', heroDetail: '多台手機連接同一個雲庫，就是同一份收藏。',
    driveGroup: '雲端硬碟', s3Subtitle: 'Cloudflare R2、Wasabi、MinIO 等，填入 key 即可', webdavSubtitle: '堅果雲、Nextcloud、NAS',
    phoneGroup: '這台手機', libraryGroup: '這個雲庫', encryption: '加密',
  },
};
test.each(Object.keys(approved) as (keyof typeof approved)[])('%s: the unconfigured picker copy has no scoped-folder explanation', async (locale) => {
  await i18n.changeLanguage(locale);
  await render(createElement(StorageLocationPicker, { onPick: jest.fn() }));
  expect(screen.getByTestId('storage-location-picker')).not.toHaveTextContent(/folder|文件夹|資料夾|フォルダ/i);
  for (const key of ['heroTitle', 'heroDetail', 's3Subtitle', 'webdavSubtitle']) {
    expect(i18n.getResource(locale, 'translation', `settings.cloudLibrary.${key}`)).not.toMatch(/folder|文件夹|資料夾|フォルダ/i);
  }
});

test.each(Object.keys(approved) as (keyof typeof approved)[])('%s exact approved action and page copy', (locale) => {
  for (const [suffix, value] of Object.entries(approved[locale])) {
    const action = ['wrongPassword', 'passwordRequired', 'signInCancelled', 'networkAction'].includes(suffix);
    expect(i18n.getResource(locale, 'translation', `settings.cloudLibrary.${action ? 'lockMessage.' : ''}${suffix}`)).toBe(value);
  }
  expect(i18n.getResource(locale, 'translation', 'settings.byos.locations.webdav')).toBe('WebDAV');
});
