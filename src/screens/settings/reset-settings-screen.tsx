import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices, type DeleteAllAppDataResult } from '@/providers/app-services';
import {
  ConfirmModal,
  DeleteAllModal,
  remainingDeleteMessage,
  type SettingsResetKind,
} from '@/screens/settings/settings-dialogs';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import { SettingsSubpageScroll } from '@/screens/settings/ui/settings-subpage-scroll';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export function ResetSettingsScreen() {
  const theme = useAppThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useAppTranslation();
  const queryClient = useQueryClient();
  const {
    resetDismissedHistory,
    resetDiscoveryHistory,
    deleteAllAppData,
    byosStatus,
  } = useAppServices();
  const cloudBound = byosStatus.status !== 'unconfigured';
  const [resetKind, setResetKind] = useState<SettingsResetKind>(null);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      console.error('[Settings] operation failed', error);
      setNotice(t('settings.operationError'));
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  return (
    <View testID="screen-settings-reset" style={{ flex: 1, backgroundColor: theme.surface }}>
      <SettingsSubpageScroll testID="settings-reset-scroll">
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
          <SettingsRow
            label={t('settings.privacy.resetDismissed')}
            detail={t('settings.privacy.resetDismissedDetail')}
            chevron
            disabled={busy}
            onPress={() => setResetKind('dismissed')}
          />
          <SettingsRow
            label={t('settings.privacy.resetDiscovery')}
            detail={t('settings.privacy.resetDiscoveryDetail')}
            chevron
            disabled={busy}
            onPress={() => setResetKind('discovery')}
          />
        </SettingsGroup>
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
          <SettingsRow
            testID="settings-delete-all"
            label={t('settings.privacy.deleteAll')}
            detail={t('settings.privacy.deleteAllDetail')}
            destructive
            chevron
            disabled={busy}
            onPress={() => setDeleteVisible(true)}
          />
        </SettingsGroup>
      </SettingsSubpageScroll>
      {notice ? (
        <Text
          testID="settings-notice"
          selectable
          accessibilityLiveRegion="polite"
          style={[settingsTypography.detail, {
            padding: metrics.spacing.medium,
            color: theme.text,
            backgroundColor: theme.surfaceSecondary,
            borderTopWidth: 1,
            borderTopColor: theme.hair,
            marginBottom: insets.bottom,
          }]}>
          {notice}
        </Text>
      ) : null}
      <ConfirmModal
        visible={resetKind !== null}
        title={resetKind === 'dismissed'
          ? t('settings.reset.dismissedTitle')
          : t('settings.reset.discoveryTitle')}
        message={resetKind === 'dismissed'
          ? t('settings.reset.dismissedMessage')
          : t('settings.reset.discoveryMessage')}
        confirmLabel={resetKind === 'dismissed'
          ? t('settings.reset.dismissedConfirm')
          : t('settings.reset.discoveryConfirm')}
        onCancel={() => setResetKind(null)}
        onConfirm={() => {
          const kind = resetKind;
          setResetKind(null);
          void run(async () => {
            const count = kind === 'dismissed'
              ? await resetDismissedHistory()
              : await resetDiscoveryHistory();
            setNotice(t('settings.reset.completed', { count }));
          });
        }}
      />
      <DeleteAllModal
        key={deleteVisible ? 'delete-open' : 'delete-closed'}
        visible={deleteVisible}
        busy={busy}
        onCancel={() => setDeleteVisible(false)}
        onConfirm={() => void run(async () => {
          const result: DeleteAllAppDataResult = await deleteAllAppData();
          setDeleteVisible(false);
          const message = result.ok
            ? t('settings.reset.allDeleted')
            : remainingDeleteMessage(result, t, cloudBound);
          if (result.recomposed && !result.ok) {
            // Board #27 S4 (S1a Task 5 drift): the recompose unmounts this screen
            // before a notice could render; a native alert outlives it.
            Alert.alert(t('settings.deleteAll.title'), message);
            return;
          }
          if (!result.recomposed) {
            await queryClient.invalidateQueries({ queryKey: ['settings', 'storage'] });
          }
          setNotice(message);
        })}
      />
    </View>
  );
}
