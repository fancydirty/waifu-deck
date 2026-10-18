import type { ReactElement } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { ByosBinding } from '@/features/byos/byos-credentials';
import {
  S3_API_KEY_PROVIDERS,
  type S3ApiKeyProvider,
} from '@/features/byos/s3-api-key-provisioner';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { SectionHeading } from '@/screens/settings/section-heading';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { useAppThemeColors } from '@/theme/colors';
import { cloudBrandColors } from '@/theme/cloud-brand-colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import { CloudMark, S3BrandMark } from './cloud-marks';

export const LOCATION_LABEL_KEY = {
  s3: 'settings.byos.locations.s3',
  webdav: 'settings.byos.locations.webdav',
  onedrive: 'settings.byos.locations.onedrive',
  gdrive: 'settings.byos.locations.gdrive',
} as const satisfies Record<ByosBinding['kind'], string>;

export type StorageLocationPickerProps = {
  onPick: (kind: ByosBinding['kind']) => void;
  onOpenApiKeyDialog?: (preselectedProvider?: S3ApiKeyProvider | null) => void;
};

/**
 * U4-design visual pass (mockup `settings-unify-v4-connect.html` §1): the hero
 * stays on the surface, then two v4 group cards under .wd-label section
 * headings. Each row leads with the mockup's `.wd-ico` tile (30/9, mark 18) —
 * the brand wash follows the app's own mark colours (S3 cloud-soft, OneDrive
 * its blue at 0.12, Google Drive and WebDAV the hair fill).
 */
function LocationIconTile({
  kind,
  s3Cube = false,
}: {
  kind: ByosBinding['kind'];
  s3Cube?: boolean;
}): ReactElement {
  const theme = useAppThemeColors();
  const background = kind === 's3' ? theme.cloudSoft
    : kind === 'onedrive' ? cloudBrandColors.microsoftBlueSoft : theme.hair;
  return (
    <View style={{
      width: metrics.settingsConnect.iconTile,
      height: metrics.settingsConnect.iconTile,
      borderRadius: metrics.settingsConnect.iconTileRadius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: background,
    }}>
      {kind === 's3' && s3Cube ? (
        <S3BrandMark
          brand="s3-cube"
          size={metrics.settingsConnect.iconTileIcon}
          color={theme.cloud}
          testID="storage-pick-s3-cube-mark"
        />
      ) : (
        <CloudMark kind={kind} size={metrics.settingsConnect.iconTileIcon} />
      )}
    </View>
  );
}

function S3ApiKeyIconTile(): ReactElement {
  const theme = useAppThemeColors();
  return (
    <View style={{
      width: metrics.settingsConnect.iconTile,
      height: metrics.settingsConnect.iconTile,
      borderRadius: metrics.settingsConnect.iconTileRadius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.saveSoft,
    }}>
      <S3BrandMark brand="bunny" size={metrics.settingsConnect.iconTileIcon} />
    </View>
  );
}

export function StorageLocationPicker({
  onPick,
  onOpenApiKeyDialog,
}: StorageLocationPickerProps) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();

  const row = (kind: ByosBinding['kind'], subtitle?: string) => {
    const labelText =
      kind === 's3' && onOpenApiKeyDialog !== undefined
        ? t('settings.cloudLibrary.s3CustomTitle')
        : t(LOCATION_LABEL_KEY[kind]);
    return (
      <SettingsRow
        key={kind}
        testID={`storage-pick-${kind}`}
        label={labelText}
        detail={subtitle}
        accessibilityLabel={subtitle ? `${labelText}. ${subtitle}` : labelText}
        icon={<LocationIconTile kind={kind} s3Cube={kind === 's3' && onOpenApiKeyDialog !== undefined} />}
        chevron
        onPress={() => onPick(kind)}
      />
    );
  };

  return (
    <View testID="storage-location-picker">
      <View testID="storage-pick-heading">
        <SectionHeading>{t('settings.cloudLibrary.s3Group')}</SectionHeading>
      </View>
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
        {onOpenApiKeyDialog !== undefined ? (
          <View>
            <SettingsRow
              testID="storage-pick-s3-apikey"
              label={t('settings.cloudLibrary.s3ApiKeyTitle')}
              detail={t('settings.cloudLibrary.s3ApiKeySubtitle')}
              accessibilityLabel={`${t('settings.cloudLibrary.s3ApiKeyTitle')}. ${t('settings.cloudLibrary.s3ApiKeySubtitle')}`}
              icon={<S3ApiKeyIconTile />}
              chevron
              onPress={() => onOpenApiKeyDialog(null)}
            />
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 6,
                paddingHorizontal: 14,
                paddingBottom: 12,
                paddingLeft: 14 + metrics.settingsConnect.iconTile + 12,
              }}>
              {S3_API_KEY_PROVIDERS.map((provider) => {
                const badgeLabel = t(
                  `settings.cloudLibrary.s3ApiKey.providers.${provider}.badge`,
                );
                return (
                  <Pressable
                    key={provider}
                    testID={`storage-badge-${provider}`}
                    accessibilityRole="button"
                    accessibilityLabel={badgeLabel}
                    onPress={() => onOpenApiKeyDialog(provider)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: theme.border,
                      backgroundColor: theme.controlFill,
                      opacity: pressed ? 0.65 : 1,
                    })}>
                    <S3BrandMark brand={provider} size={13} />
                    <Text style={[settingsTypography.plainPill, { color: theme.text }]}>
                      {badgeLabel}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
        {row('s3', t('settings.cloudLibrary.s3Subtitle'))}
      </SettingsGroup>
      <SectionHeading>{t('settings.cloudLibrary.driveGroup')}</SectionHeading>
      <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
        {row('gdrive')}
        {row('onedrive')}
        {row('webdav', t('settings.cloudLibrary.webdavSubtitle'))}
      </SettingsGroup>
      <Text
        testID="storage-drives-footnote"
        style={[
          settingsTypography.connectHint,
          {
            color: theme.textSecondary,
            paddingHorizontal: metrics.contentPadding,
            paddingTop: 10,
          },
        ]}>
        {t('settings.cloudLibrary.drivesFootnote')}
      </Text>
    </View>
  );
}
