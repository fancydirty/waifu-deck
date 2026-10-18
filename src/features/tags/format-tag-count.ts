import type { AppLanguage } from '@/features/waifu/types';

export function formatTagCount(count: number, language: AppLanguage): string {
  const units: readonly (readonly [number, string])[] = language === 'en'
    ? [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
    : language === 'zh-Hans'
      ? [[1e8, ' 亿'], [1e4, ' 万']]
      : language === 'zh-Hant'
        ? [[1e8, ' 億'], [1e4, ' 萬']]
        : [[1e8, '億'], [1e4, '万']];
  for (const [threshold, suffix] of units) {
    if (count >= threshold) return (count / threshold).toFixed(1).replace(/\.0$/, '') + suffix;
  }
  return Math.round(count).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
