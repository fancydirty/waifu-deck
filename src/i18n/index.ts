import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import type { LanguagePreference } from '@/features/waifu/types';
import { getSystemLanguage, resolveLanguage } from '@/i18n/language';
import en from '@/i18n/locales/en';
import ja from '@/i18n/locales/ja';
import zhHans from '@/i18n/locales/zh-Hans';
import zhHant from '@/i18n/locales/zh-Hant';

export const translationResources = {
  en: { translation: en },
  'zh-Hans': { translation: zhHans },
  'zh-Hant': { translation: zhHant },
  ja: { translation: ja },
} as const;

const i18n = createInstance();

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: translationResources,
    lng: getSystemLanguage(),
    fallbackLng: 'en',
    supportedLngs: Object.keys(translationResources),
    load: 'currentOnly',
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export async function applyLanguagePreference(
  preference: LanguagePreference,
): Promise<void> {
  const language = resolveLanguage(preference);
  if (i18n.resolvedLanguage !== language) await i18n.changeLanguage(language);
}

export default i18n;
