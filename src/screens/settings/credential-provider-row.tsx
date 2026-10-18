import { useState, type ReactElement } from 'react';
import { Text, View } from 'react-native';

import type { ProviderCredential } from '@/features/providers/provider-credentials';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import type { ProviderHealthEntry } from '@/features/providers/provider-resilience';
import type { ImageProviderKey } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { PersistedSwitch } from '@/screens/settings/setting-row';
import {
  CREDENTIAL_HOSTS,
  providerHealthDetail,
} from '@/screens/settings/provider-settings';
import { SettingsButton } from '@/screens/settings/ui/settings-button';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type CredentialProviderRowProps = {
  adapter: (typeof PROVIDER_REGISTRY)[number];
  enabled: boolean;
  enabledProviderCount: number;
  busy: boolean;
  credential: ProviderCredential | undefined;
  health: ProviderHealthEntry;
  availabilityNote?: string;
  onSaveCredential(key: ImageProviderKey, credential: ProviderCredential): Promise<boolean>;
  onClearCredential(key: ImageProviderKey): Promise<boolean>;
  onToggle(key: ImageProviderKey, value: boolean): Promise<boolean>;
  onPendingChange?(pending: boolean): void;
};

/**
 * G4a key<->enable coupling (spec §2.2): a credentialed source with no stored
 * key gets the credential form instead of a bare toggle — toggling a keyless
 * source is meaningless, since it can never be fetched. Saving stores the key
 * and enables the source in one action; once a key exists the row reverts to
 * the normal toggle (disabling no longer clears the key) plus a masked status
 * and a clear button. The clear button shares the toggle's last-source guard
 * so clearing the only enabled source can't strand it enabled-but-keyless.
 *
 * U2c2 (CD8): the keyed children match the v4 source card — title/detail +
 * toggle, an internal 1dp hair, then the neutral clear row (saved) or the
 * field block (keyless). The internal hair exists because SettingsGroup
 * separates direct children only (E16).
 */
export function CredentialProviderRow({
  adapter,
  enabled,
  enabledProviderCount,
  busy,
  credential,
  health,
  availabilityNote,
  onSaveCredential,
  onClearCredential,
  onToggle,
  onPendingChange,
}: CredentialProviderRowProps): ReactElement {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const slug = adapter.settingsSlug;
  const cap = slug.charAt(0).toUpperCase() + slug.slice(1);
  const [apiKey, setApiKey] = useState('');
  const [userId, setUserId] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const internalHair = (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.hair }} />
  );

  if (credential !== undefined) {
    const clearDisabled = busy || clearing || (enabled && enabledProviderCount === 1);
    return (
      <>
        <SettingsRow
          label={adapter.label}
          detail={providerHealthDetail(
            t(`settings.provider.${slug}Description`),
            enabled,
            health,
            t,
            availabilityNote,
          )}
          trailing={(
            <PersistedSwitch
              testID={`provider-${slug}-toggle`}
              accessibilityLabel={t(`settings.provider.enable${cap}`)}
              disabled={enabled && enabledProviderCount === 1}
              busy={busy}
              value={enabled}
              onValueChange={(value) => onToggle(adapter.key, value)}
              onPendingChange={onPendingChange}
            />
          )}
        />
        {internalHair}
        <SettingsRow
          testID={`provider-${slug}-credential-clear`}
          label={t('settings.provider.credentialClear')}
          detail={t('settings.provider.credentialSet')}
          disabled={clearDisabled}
          chevron
          onPress={() => {
            setClearing(true);
            void onClearCredential(adapter.key).finally(() => setClearing(false));
          }}
        />
      </>
    );
  }

  const canSave = !saving && apiKey.trim().length > 0 && userId.trim().length > 0;
  return (
    <>
      <SettingsRow
        label={adapter.label}
        detail={t('settings.provider.disabled', {
          description: t(`settings.provider.${slug}Description`),
        })}
      />
      {internalHair}
      <SettingsBlock>
        <SettingsField
          testID={`provider-${slug}-credential-apikey`}
          accessibilityLabel={t('settings.provider.credentialApiKey')}
          placeholder={t('settings.provider.credentialApiKey')}
          secureTextEntry
          disabled={saving}
          value={apiKey}
          onChangeText={setApiKey}
        />
        <View style={{ marginTop: metrics.spacing.small }}>
          <SettingsField
            testID={`provider-${slug}-credential-userid`}
            accessibilityLabel={t('settings.provider.credentialUserId')}
            placeholder={t('settings.provider.credentialUserId')}
            disabled={saving}
            value={userId}
            onChangeText={setUserId}
          />
        </View>
        <Text
          style={[settingsTypography.hint, {
            marginTop: metrics.spacing.small,
            color: theme.textSecondary,
          }]}>
          {t('settings.provider.credentialHint', { host: CREDENTIAL_HOSTS[adapter.key] })}
        </Text>
        <View style={{ marginTop: metrics.settingsBlockTitleGap }}>
          <SettingsButton
            testID={`provider-${slug}-credential-save`}
            variant="primary"
            disabled={!canSave}
            onPress={() => {
              setSaving(true);
              void onSaveCredential(adapter.key, {
                apiKey: apiKey.trim(),
                userId: userId.trim(),
              }).then((saved) => {
                if (saved) {
                  setApiKey('');
                  setUserId('');
                }
              }).finally(() => setSaving(false));
            }}>
            {t('settings.provider.credentialSave')}
          </SettingsButton>
        </View>
      </SettingsBlock>
    </>
  );
}
