import { getLocales, type Locale } from 'expo-localization';

import type { AppLanguage, LanguagePreference } from '@/features/waifu/types';

export const APP_LANGUAGES = ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const;

const TRADITIONAL_CHINESE_REGIONS = new Set(['HK', 'MO', 'TW']);

export function languageForLocale(
  locale: Pick<Locale, 'languageCode' | 'languageScriptCode' | 'regionCode'>,
): AppLanguage {
  if (locale.languageCode === 'ja') return 'ja';
  if (locale.languageCode !== 'zh') return 'en';
  if (locale.languageScriptCode === 'Hant') return 'zh-Hant';
  if (locale.languageScriptCode === 'Hans') return 'zh-Hans';
  return locale.regionCode !== null && TRADITIONAL_CHINESE_REGIONS.has(locale.regionCode)
    ? 'zh-Hant'
    : 'zh-Hans';
}

export function getSystemLanguage(locales: readonly Locale[] = getLocales()): AppLanguage {
  const first = locales[0];
  return first ? languageForLocale(first) : 'en';
}

export function resolveLanguage(
  preference: LanguagePreference,
  locales?: readonly Locale[],
): AppLanguage {
  return preference === 'system' ? getSystemLanguage(locales) : preference;
}
