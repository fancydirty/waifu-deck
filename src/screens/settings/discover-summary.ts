import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings } from '@/features/waifu/types';
import { MAX_BYTES_OPTIONS, MIN_WIDTH_OPTIONS } from './settings-options';

type SummaryTranslation = (key: string, values?: Record<string, string | number>) => string;

export function discoverSummaryParts(settings: AppSettings, t: SummaryTranslation): string[] {
  const parts = [
    t(settings.orientation === 'any'
      ? 'settings.discover.summary.anyOrientation'
      : `settings.filters.${settings.orientation}`),
    t(`settings.discover.summary.animation.${settings.animationMode}`),
    t('settings.discover.prefetchSummary', { count: settings.prefetchDepth }),
  ];

  if (settings.stylePreference !== DEFAULT_SETTINGS.stylePreference) {
    const styleKeys = {
      any: 'settings.filters.styleAny',
      'prefer-3d': 'settings.filters.prefer3d',
      'prefer-2d': 'settings.filters.prefer2d',
    };
    parts.push(t(styleKeys[settings.stylePreference]));
  }
  if (settings.minWidth !== DEFAULT_SETTINGS.minWidth) {
    parts.push(t('settings.discover.summary.minWidth', {
      value: MIN_WIDTH_OPTIONS.find((option) => option.value === settings.minWidth)?.label ?? '',
    }));
  }
  if (settings.maxBytes !== DEFAULT_SETTINGS.maxBytes) {
    parts.push(t('settings.discover.summary.maxBytes', {
      value: MAX_BYTES_OPTIONS.find((option) => option.value === settings.maxBytes)?.label ?? '',
    }));
  }
  return parts;
}

export function formatDiscoverSummary(settings: AppSettings, t: SummaryTranslation): string {
  return discoverSummaryParts(settings, t).join(' · ');
}
