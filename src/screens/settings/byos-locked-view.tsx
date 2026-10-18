import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';
import type { ByosSignInProvider } from '@/features/byos/byos-context-resolver';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { metrics } from '@/theme/metrics';
import { SettingsGroup } from './ui/settings-group';
import { BackgroundUploadRow, type BackgroundUploadPort } from './background-upload-row';
import { SettingsField } from './ui/settings-field';
import { CloudLibraryCardBody } from './cloud-library-card';
import { SettingRow } from './setting-row';
import type { CloudLibraryData } from './use-cloud-library-data';

const fieldOuterMargin = {
  marginHorizontal: metrics.contentPadding,
  marginVertical: metrics.spacing.small,
} as const;

export type ByosLockedViewProps = Readonly<{
  data: CloudLibraryData;
  password: string;
  busy: boolean;
  onPasswordChange(value: string): void;
  onUnlock(): void;
  onReauth(provider: ByosSignInProvider): void;
  backgroundSync?: BackgroundUploadPort;
  disconnect: ReactNode;
  message: ReactNode;
}>;

/**
 * The locked layout of the lower half: the ready-only rows (本机存储, 加密,
 * 存储位置) and their group labels stay hidden (mockup v4 "locked hides"), the
 * 后台上传 row groups into its own card, and the disconnect node keeps the
 * section's danger card. The card body (message + unlock/reauth action)
 * belongs to the upper half and keeps its look.
 */
export function ByosLockedView({ data, password, busy, onPasswordChange, onUnlock, onReauth, backgroundSync, disconnect, message }: ByosLockedViewProps): ReactElement {
  const { t } = useAppTranslation();
  const statusMessage = <View testID="byos-locked-reason">{message}</View>;
  const action = data.model.state === 'password-required' ? (
    <>
      <View style={fieldOuterMargin}>
        <SettingsField testID="byos-unlock-password" accessibilityLabel={t('settings.byos.password')} secureTextEntry
          placeholder={t('settings.byos.password')} value={password} onChangeText={onPasswordChange} />
      </View>
      <SettingRow testID="byos-unlock" label={t('settings.byos.unlock')} disabled={busy} onPress={onUnlock} />
    </>
  ) : data.model.state === 'reauth-required' && data.model.reauthProvider !== null ? (
    <SettingRow
      testID="byos-reauth"
      label={t(data.model.reauthProvider === 'gdrive' ? 'settings.byos.gdrive.reauth' : 'settings.byos.onedrive.reauth')}
      disabled={busy}
      onPress={() => onReauth(data.model.reauthProvider!)}
    />
  ) : null;
  return (
    <View testID="byos-locked-view">
      <CloudLibraryCardBody
        model={data.model}
        nowMs={data.viewNowMs}
        testID="byos-locked-card"
        statsTestID="cloud-locked-stats"
        statIdPrefix="cloud-stat"
        message={statusMessage}
        action={action}
      />
      {backgroundSync === undefined ? null : (
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
          <BackgroundUploadRow backgroundSync={backgroundSync} disabled={busy} />
        </SettingsGroup>
      )}
      {disconnect}
    </View>
  );
}
