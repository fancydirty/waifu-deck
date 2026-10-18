import type { TFunction } from 'i18next';

import type { ProviderHealthEntry } from '@/features/providers/provider-resilience';
import type { ImageProviderKey } from '@/features/waifu/types';
import i18n from '@/i18n';

// G4a — sources that require a user-supplied API key have no bare on/off
// toggle when keyless: saving a key both stores it and enables the source
// (key<->enable coupling, spec §2.2). CREDENTIAL_HOSTS feeds the per-source
// `credentialHint` copy ("get a free key from your {{host}} account
// settings"), which varies by source.
export const CREDENTIALED_PROVIDERS: ReadonlySet<ImageProviderKey> = new Set(['gelbooru', 'rule34']);
export const CREDENTIAL_HOSTS: Partial<Record<ImageProviderKey, string>> = {
  gelbooru: 'gelbooru.com',
  rule34: 'rule34.xxx',
};

export function providerHealthDetail(
  description: string,
  enabled: boolean,
  health: ProviderHealthEntry,
  t: TFunction = i18n.t,
  availabilityNote?: string,
): string {
  const statusLabel = health.status !== 'healthy' && health.lastErrorCode === 'auth'
    ? t('settings.provider.credentialRejected')
    : {
      idle: t('settings.provider.idle'),
      healthy: t('settings.provider.healthy'),
      degraded: t('settings.provider.degraded'),
      cooldown: t('settings.provider.cooldown'),
      probing: t('settings.provider.probing'),
    }[health.status];
  const base = enabled
    ? `${description} · ${statusLabel}`
    : t('settings.provider.disabled', { description });
  return availabilityNote ? `${base}\n${availabilityNote}` : base;
}
