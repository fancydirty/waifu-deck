import { Fragment, useCallback, useState, useSyncExternalStore } from 'react';
import { Text } from 'react-native';

import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import { setProviderEnabled } from '@/features/settings/settings';
import type { AppSettings, ImageProviderKey } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';
import { CredentialProviderRow } from '@/screens/settings/credential-provider-row';
import { CREDENTIALED_PROVIDERS, providerHealthDetail } from '@/screens/settings/provider-settings';
import { PersistedSwitch } from '@/screens/settings/setting-row';
import { SectionHeading } from '@/screens/settings/section-heading';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { SettingsSubpageScroll } from '@/screens/settings/ui/settings-subpage-scroll';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

const GROUP_ORDER = ['general', 'booru', 'furry'] as const;

export function SourcesScreen() {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const {
    settings,
    updateSettings,
    providerCredentials,
    providerRequestGovernor,
  } = useAppServices();
  const [providerSavePending, setProviderSavePending] = useState(false);

  const providerHealth = useSyncExternalStore(
    useCallback((l: () => void) => providerRequestGovernor.subscribe(l), [providerRequestGovernor]),
    useCallback(() => providerRequestGovernor.getSnapshot(), [providerRequestGovernor]),
    useCallback(() => providerRequestGovernor.getSnapshot(), [providerRequestGovernor]),
  );

  const enabledProviderCount = Object.values(settings.providers).filter(Boolean).length;

  const save = useCallback(
    (update: (current: AppSettings) => Partial<AppSettings>) =>
      updateSettings((current) => ({ ...current, ...update(current) })).then(() => true, () => false),
    [updateSettings],
  );
  const toggleProvider = (key: ImageProviderKey, value: boolean) =>
    save((current) => ({ providers: setProviderEnabled(current.providers, key, value) }));
  const onSaveCredential = async (key: ImageProviderKey, credential: { apiKey: string; userId: string }) => {
    try {
      await providerCredentials.save(key, credential);
    } catch {
      return false;
    }
    return save((current) => ({ providers: setProviderEnabled(current.providers, key, true) }));
  };
  const onClearCredential = async (key: ImageProviderKey) => {
    try {
      await providerCredentials.clear(key);
    } catch {
      return false;
    }
    return save((current) => ({ providers: setProviderEnabled(current.providers, key, false) }));
  };

  return (
    <SettingsSubpageScroll testID="sources-scroll">
      {GROUP_ORDER.map((group, index) => (
        <Fragment key={group}>
          <SectionHeading style={index === 0 ? { paddingTop: metrics.spacing.small } : undefined}>
            {t(`settings.sections.sourcesGroups.${group}`)}
          </SectionHeading>
          <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
            {PROVIDER_REGISTRY.filter((adapter) => adapter.settingsGroup === group).map((adapter) => {
              const enabled = settings.providers[adapter.key];
              const availability = adapter.availabilityFor(settings);
              const availabilityNote = availability.state === 'unavailable'
                ? t(`settings.provider.${availability.reasonKey}`)
                : undefined;
              if (CREDENTIALED_PROVIDERS.has(adapter.key)) {
                return (
                  <CredentialProviderRow
                    key={adapter.key}
                    adapter={adapter}
                    enabled={enabled}
                    enabledProviderCount={enabledProviderCount}
                    busy={providerSavePending}
                    credential={providerCredentials.snapshot()[adapter.key]}
                    health={providerHealth[adapter.key]}
                    availabilityNote={availabilityNote}
                    onSaveCredential={onSaveCredential}
                    onClearCredential={onClearCredential}
                    onToggle={toggleProvider}
                    onPendingChange={setProviderSavePending}
                  />
                );
              }
              const slug = adapter.settingsSlug;
              const cap = slug.charAt(0).toUpperCase() + slug.slice(1);
              return (
                <SettingsRow
                  key={adapter.key}
                  label={adapter.label}
                  detail={providerHealthDetail(
                    t(`settings.provider.${slug}Description`),
                    enabled,
                    providerHealth[adapter.key],
                    t,
                    availabilityNote,
                  )}
                  trailing={(
                    <PersistedSwitch
                      testID={`provider-${slug}-toggle`}
                      accessibilityLabel={t(`settings.provider.enable${cap}`)}
                      disabled={enabled && enabledProviderCount === 1}
                      busy={providerSavePending}
                      value={enabled}
                      onValueChange={(value) => toggleProvider(adapter.key, value)}
                      onPendingChange={setProviderSavePending}
                    />
                  )}
                />
              );
            })}
          </SettingsGroup>
        </Fragment>
      ))}
      <Text
        testID="sources-last-source-note"
        style={[settingsTypography.hint, {
          marginHorizontal: metrics.settingsGutter,
          marginTop: metrics.spacing.medium,
          color: theme.textSecondary,
        }]}>
        {t('settings.sources.lastSourceNote')}
      </Text>
    </SettingsSubpageScroll>
  );
}
