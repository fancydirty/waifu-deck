import type { ReactElement, ReactNode } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import { Check, Cloud, Lock } from 'lucide-react-native';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { peachTypography, settingsTypography } from '@/theme/typography';
import { formatCloudBytes, formatSyncAge } from './cloud-library-format';
import type { CloudLibraryModel } from './cloud-library-model';
import { StatusPill } from './status-pill';
import { CloudMark } from './cloud-marks';
import { PlainPill } from './ui/plain-pill';

export function CloudLibraryCard({ model, nowMs, onPress }: Readonly<{
  model: CloudLibraryModel; nowMs: number; onPress(): void;
}>): ReactElement {
  const dark = useColorScheme() === 'dark';
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  return (
    <Pressable
      testID="settings-cloud-card"
      accessibilityRole="button"
      onPress={onPress}
      style={{ marginHorizontal: metrics.settingsGutter, borderRadius: metrics.settingsRadius.cloud,
        borderWidth: 1, borderColor: model.tone === 'bad' ? theme.danger
          : model.tone === 'warn' ? theme.warnInk : theme.border,
        backgroundColor: theme.surfaceSecondary, minHeight: metrics.minimumHitArea,
        elevation: dark ? 0 : 1 }}>
      <CloudLibraryCardBody model={model} nowMs={nowMs} testID="settings-cloud-body"
        statsTestID="settings-cloud-stats" statIdPrefix="settings-cloud-stat" />
      {model.state === 'unconfigured' ? (
        <Text style={{ ...peachTypography.rowTitle, color: theme.saveDeep,
          paddingHorizontal: 14, paddingBottom: 14 }}>{t('settings.cloudLibrary.connect')}</Text>
      ) : null}
    </Pressable>
  );
}

export function CloudLibraryCardBody({ model, nowMs, action, message, testID,
  statsTestID, statIdPrefix = 'cloud-stat', footerTestID }: Readonly<{
  model: CloudLibraryModel; nowMs: number; action?: ReactNode;
  message?: ReactNode; testID?: string; statsTestID?: string; statIdPrefix?: string;
  footerTestID?: string;
}>): ReactElement {
  const dark = useColorScheme() === 'dark';
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const pill = model.state === 'ready' ? t('settings.byos.status.connected')
    : model.state === 'password-required' ? t('settings.cloudLibrary.pill.unlock')
    : model.state === 'reauth-required' ? t('settings.cloudLibrary.pill.reauth')
    : model.state === 'unreachable' ? t('settings.cloudLibrary.pill.unreachable')
    : model.state === 'unreadable' ? t('settings.cloudLibrary.pill.unreadable') : null;
  const prefix = statIdPrefix === 'settings-cloud-stat' ? 'settings-cloud' : 'cloud';
  const footer = model.footer;
  const footerText = footer === null ? null
    : footer.kind === 'synced' ? t('settings.cloudLibrary.footer.synced', { age: formatSyncAge(footer.at, nowMs, t) })
    : footer.kind === 'never-synced' ? t('settings.byos.status.neverSynced')
    : footer.kind === 'quota-full' ? t('settings.cloudLibrary.footer.quotaFull', { count: footer.count })
    : footer.kind === 'pending' ? t('settings.cloudLibrary.footer.pending', { count: footer.count })
    : t('settings.cloudLibrary.footer.downloading', { count: footer.count });
  const synced = footer?.kind === 'synced';
  const footerColor = footer?.kind === 'quota-full' ? theme.warnInk : theme.textSecondary;
  const storagePill = model.storageMode === null ? null : <PlainPill
    label={t(model.storageMode === 'cloud-only' ? 'settings.byos.storageMode.cloudOnly' : 'settings.byos.storageMode.both')}
    icon={<Cloud accessible={false} color={theme.text} size={12} />} />;
  const encryptionPill = model.encryption === null ? null : <PlainPill
    label={t(model.encryption === 'aes-gcm' ? 'settings.byos.status.encryptionOn' : 'settings.byos.status.encryptionOff')}
    icon={<Lock accessible={false} color={theme.text} size={12} />} />;
  const stats = model.stats;
  const values = [
    { id: 'in-cloud', value: stats === null ? '—' : String(stats.inCloud),
      unit: stats === null ? null : t('settings.cloudLibrary.image', { count: stats.inCloud }),
      label: t('settings.cloudLibrary.inCloud') },
    { id: 'total-bytes', ...(stats === null ? { value: '—', unit: null } : formatCloudBytes(stats.totalBytes)),
      label: t('settings.cloudLibrary.originalSize') },
    { id: 'pending', value: stats === null ? '—' : String(stats.pending),
      unit: stats === null ? null : t('settings.cloudLibrary.image', { count: stats.pending }),
      label: t('settings.cloudLibrary.pending') },
  ];
  return (
    <View testID={testID} style={{ padding: 14,
      ...(statIdPrefix === 'cloud-stat' ? { marginHorizontal: metrics.settingsGutter,
        borderRadius: metrics.settingsRadius.cloud, borderWidth: 1, backgroundColor: theme.surfaceSecondary,
        borderColor: model.tone === 'bad' ? theme.danger : model.tone === 'warn' ? theme.warnInk : theme.border,
        elevation: dark ? 0 : 1 } : {}) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: metrics.settingsRadius.tile,
          alignItems: 'center', justifyContent: 'center', backgroundColor: model.identity === null || model.identity.kind === 's3'
            ? theme.cloudSoft : theme.controlFill }}>
          <CloudMark kind={model.identity?.kind ?? null} size={24} testID={`${prefix}-mark`} label={model.identity?.label ?? null} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} ellipsizeMode="tail"
            style={{ ...settingsTypography.cloudName, color: theme.text }}>{model.identity?.label ?? t('settings.byos.heading')}</Text>
          <Text numberOfLines={1} ellipsizeMode="middle"
            style={{ ...settingsTypography.cloudSub, color: theme.textSecondary }}>
            {model.state === 'unconfigured' ? t('settings.cloudLibrary.notConnected') : model.identity?.identity}
          </Text>
        </View>
        {model.tone === null || pill === null ? null : <StatusPill testID={`${prefix}-pill`} tone={model.tone} label={pill} />}
      </View>
      {message !== undefined ? <View style={{ marginTop: 12 }}>{message}</View>
        : model.state === 'unconfigured' ? <Text style={{ ...settingsTypography.cloudMessage,
          color: theme.textSecondary, marginTop: 12 }}>{t('settings.cloudLibrary.homeIntro')}</Text>
        : model.messageKey === null ? null : <Text style={{ ...settingsTypography.cloudMessage,
          color: theme.text, marginTop: 12 }}>{t(model.messageKey)}</Text>}
      {action === undefined ? null : <View style={{ marginTop: 12 }}>{action}</View>}
      {model.state === 'unconfigured' ? null : <View testID={statsTestID}
        style={{ flexDirection: 'row', marginTop: 14, marginBottom: 12, paddingVertical: 12,
          borderTopWidth: 1, borderBottomWidth: 1, borderColor: theme.hair }}>
        {values.map(({ id, value, unit, label }, index) => <View key={id}
          style={{ flex: 1, minWidth: 0, ...(index === 0 ? {} : {
            borderLeftWidth: 1, borderLeftColor: theme.hair, paddingLeft: 12,
          }) }}>
          {model.state === 'loading' ? <View testID={statIdPrefix + '-' + id + '-placeholder'}
            style={{ height: settingsTypography.cloudStat.fontSize, backgroundColor: theme.hair,
              borderRadius: metrics.radius.small }} /> : <Text testID={statIdPrefix + '-' + id}
            numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}
            style={{ ...settingsTypography.cloudStat, color: theme.text }}>
            {value}{unit === null ? null : <Text style={{ ...settingsTypography.cloudStatUnit,
              color: theme.textSecondary }}>{' '}{unit}</Text>}
          </Text>}
          <Text style={{ ...settingsTypography.cloudStatLabel, color: theme.textSecondary }}>{label}</Text>
        </View>)}
      </View>}
      {footerText === null && storagePill === null && encryptionPill === null ? null : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 8 }}>
          {footerText === null ? null : (
            <View style={{ flexGrow: 1, flexShrink: 0, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              {synced ? <Check accessible={false} color={theme.ok} size={15} /> : null}
              <Text testID={footerTestID ?? prefix + '-footer'} numberOfLines={1} ellipsizeMode="tail"
                style={{ ...settingsTypography.cloudFooter, color: synced ? theme.ok : footerColor,
                  flexShrink: 1, minWidth: 0 }}>{footerText}</Text>
            </View>
          )}
          {storagePill === null && encryptionPill === null ? null : (
            <View style={{ flexDirection: 'row', gap: 8 }}>{storagePill}{encryptionPill}</View>
          )}
        </View>
      )}
    </View>
  );
}
