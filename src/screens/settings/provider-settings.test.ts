import i18n from '@/i18n';
import type { ProviderHealthEntry, ProviderHealthStatus } from '@/features/providers/provider-resilience';
import { providerHealthDetail } from './provider-settings';

const providerDescription = {
  en: 'Curated gallery with complete tags',
  ja: 'タグが充実した厳選ギャラリー',
  'zh-Hans': '精选图库与完整标签',
  'zh-Hant': '精選圖庫與完整標籤',
} as const;

const copy = {
  en: {
    idle: 'No images fetched yet', healthy: 'Connected',
    degraded: 'Connection unstable · recovering automatically',
    cooldown: 'Cooling down after frequent requests', probing: 'Restoring connection',
    auth: 'The key was rejected. Check it and save again.', off: 'Off',
    availability: 'Konachan has no portrait images. Switch orientation to Landscape or Any to see it.',
  },
  ja: {
    idle: 'まだ画像を取得していません', healthy: '接続済み',
    degraded: '接続が不安定 · 自動的に復旧中', cooldown: '頻繁なリクエストのため待機中',
    probing: '接続を復旧中', auth: 'キーが拒否されました。確認してもう一度保存してください。', off: 'オフ',
    availability: 'Konachanには縦向きの画像がありません。向きを横向きまたは指定なしに変更すると表示されます。',
  },
  'zh-Hans': {
    idle: '本次尚未取图', healthy: '连接正常', degraded: '连接不稳，正在自动恢复',
    cooldown: '请求较多，暂时冷却', probing: '正在恢复连接', auth: '密钥被拒绝，请检查后重新保存', off: '已关闭',
    availability: 'Konachan 没有竖屏图片。把方向改为横屏或任意即可看到它。',
  },
  'zh-Hant': {
    idle: '本次尚未取圖', healthy: '連線正常', degraded: '連線不穩，正在自動恢復',
    cooldown: '請求較多，暫時冷卻中', probing: '正在恢復連線', auth: '金鑰遭拒，請檢查後重新儲存', off: '已關閉',
    availability: 'Konachan 沒有直向圖片。將方向改為橫向或不限即可看到它。',
  },
} as const;

function health(status: ProviderHealthStatus, lastErrorCode: string | null = null): ProviderHealthEntry {
  return {
    providerKey: 'waifu_im', status, consecutiveFailures: 0, blockedUntil: null,
    lastErrorCode, updatedAt: 0,
  };
}

const statuses: ProviderHealthStatus[] = ['idle', 'healthy', 'degraded', 'cooldown', 'probing'];

describe.each(Object.entries(copy) as [keyof typeof copy, (typeof copy)[keyof typeof copy]][])(
  '%s provider detail', (language, localeCopy) => {
    test.each(statuses)('publishes the %s health suffix from app resources', async (status) => {
      await i18n.changeLanguage(language);
      const key = status;
      expect(i18n.getResource(language, 'translation', `settings.provider.${key}`)).toBe(localeCopy[key]);
      expect(providerHealthDetail(providerDescription[language], true, health(status), i18n.t))
        .toBe(`${providerDescription[language]} · ${localeCopy[key]}`);
    });

    test('publishes auth rejection, disabled state and availability without losing detail', async () => {
      await i18n.changeLanguage(language);
      expect(i18n.getResource(language, 'translation', 'settings.provider.credentialRejected')).toBe(localeCopy.auth);
      expect(i18n.getResource(language, 'translation', 'settings.provider.disabled'))
        .toBe('{{description}} · ' + localeCopy.off);
      expect(providerHealthDetail(
        providerDescription[language], true, health('degraded', 'auth'), i18n.t, localeCopy.availability,
      )).toBe(`${providerDescription[language]} · ${localeCopy.auth}\n${localeCopy.availability}`);
      expect(providerHealthDetail(providerDescription[language], false, health('idle'), i18n.t, localeCopy.availability))
        .toBe(`${providerDescription[language]} · ${localeCopy.off}\n${localeCopy.availability}`);
    });
  },
);
