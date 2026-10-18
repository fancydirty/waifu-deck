import type { TFunction } from 'i18next';

import i18n from '@/i18n';

/**
 * The Settings byte ladder, shared by the home storage/backup rows and the
 * cloud card (spec §4.2 原图大小). Decimal units, MB for every larger value —
 * the cloud quota bar is the only GB surface and formats its own numbers.
 * Callers pass `t` so tests can inject translations.
 */
export function formatBytes(
  value: number | null | 'unavailable',
  t: TFunction = i18n.t,
): string {
  if (value === null) return t('settings.storage.calculating');
  if (value === 'unavailable') return t('settings.storage.unavailable');
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))} KB`;
  return `${Number((value / 1_000_000).toFixed(1))} MB`;
}
