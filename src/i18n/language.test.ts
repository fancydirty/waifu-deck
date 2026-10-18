import type { Locale } from 'expo-localization';

import { getSystemLanguage, languageForLocale, resolveLanguage } from './language';

function locale(
  languageCode: string | null,
  languageScriptCode: string | null = null,
  regionCode: string | null = null,
): Locale {
  return { languageCode, languageScriptCode, regionCode } as Locale;
}

describe('app language resolution', () => {
  test.each([
    [locale('zh', 'Hans', 'TW'), 'zh-Hans'],
    [locale('zh', 'Hant', 'CN'), 'zh-Hant'],
    [locale('zh', null, 'TW'), 'zh-Hant'],
    [locale('zh', null, 'HK'), 'zh-Hant'],
    [locale('zh', null, 'CN'), 'zh-Hans'],
    [locale('ja', null, 'JP'), 'ja'],
    [locale('fr', null, 'FR'), 'en'],
  ] as const)('maps locale %# to %s', (input, expected) => {
    expect(languageForLocale(input)).toBe(expected);
  });

  test('uses the first system locale and falls back to English', () => {
    expect(getSystemLanguage([locale('ja'), locale('en')])).toBe('ja');
    expect(getSystemLanguage([])).toBe('en');
  });

  test('respects an explicit preference before the system locale', () => {
    expect(resolveLanguage('zh-Hant', [locale('ja')])).toBe('zh-Hant');
    expect(resolveLanguage('system', [locale('ja')])).toBe('ja');
  });
});
