import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppUpdateModalPhase } from '@/features/update/app-update-service';
import type { AppRelease } from '@/features/update/update-model';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { formatBytes } from '@/screens/settings/format-bytes';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type AppUpdateModalProps = {
  visible: boolean;
  release: AppRelease | null;
  phase: AppUpdateModalPhase;
  onLater(): void;
  onConfirmUpdate(): void;
  onCancelDownload(): void;
  onOpenUnknownSources(): void;
  onOpenBrowser(): void;
};

function UpdateActionPill({
  label,
  accessibilityLabel,
  variant,
  disabled = false,
  testID,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  variant: 'ghost' | 'primary';
  disabled?: boolean;
  testID?: string;
  onPress(): void;
}) {
  const theme = useAppThemeColors();
  let opacity = 1;
  if (disabled) {
    opacity = 0.38;
  }
  return (
    <Pressable
      testID={testID}
      role="button"
      aria-label={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionHitFrame,
        { opacity: disabled ? opacity : pressed ? 0.62 : 1 },
      ]}>
      <View
        style={[
          styles.actionPill,
          {
            backgroundColor:
              variant === 'primary' ? theme.save : theme.controlFill,
          },
        ]}>
        <Text
          style={[
            settingsTypography.buttonLabel,
            {
              color:
                variant === 'primary' ? theme.destructiveText : theme.text,
            },
          ]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

export function AppUpdateModal({
  visible,
  release,
  phase,
  onLater,
  onConfirmUpdate,
  onCancelDownload,
  onOpenUnknownSources,
  onOpenBrowser,
}: AppUpdateModalProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();

  if (!visible || release === null) return null;

  const title = t('settings.appUpdate.title', { version: release.versionName });
  const notes =
    release.notes.trim().length > 0
      ? release.notes.trim()
      : t('settings.appUpdate.defaultNotes');
  const sizeLabel = formatBytes(release.sizeBytes, t);

  const isDownloading = phase.kind === 'downloading';
  const isVerifying = phase.kind === 'verifying';
  const isPermission = phase.kind === 'permission-required';
  const isError = phase.kind === 'error';

  const progressRatio =
    phase.kind === 'downloading' && phase.totalBytes > 0
      ? Math.max(0, Math.min(1, phase.bytesReceived / phase.totalBytes))
      : 0;
  const percent = Math.round(progressRatio * 100);

  let confirmLabel = t('settings.appUpdate.updateNow');
  if (isError) {
    confirmLabel = t('settings.appUpdate.retry');
  } else if (phase.kind === 'ready' && phase.alreadyDownloaded) {
    confirmLabel = t('settings.appUpdate.installNow');
  }

  let primaryActionNode = null;
  if (!isDownloading && !isVerifying) {
    if (isPermission) {
      primaryActionNode = (
        <UpdateActionPill
          testID="update-modal-confirm"
          label={t('settings.appUpdate.openSettings')}
          accessibilityLabel={t('settings.appUpdate.openSettings')}
          variant="primary"
          onPress={onOpenUnknownSources}
        />
      );
    } else {
      primaryActionNode = (
        <UpdateActionPill
          testID="update-modal-confirm"
          label={confirmLabel}
          accessibilityLabel={confirmLabel}
          variant="primary"
          onPress={onConfirmUpdate}
        />
      );
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (isVerifying) return;
        if (isDownloading) {
          onCancelDownload();
        } else {
          onLater();
        }
      }}>
      <View
        testID="app-update-modal"
        style={[styles.scrim, { backgroundColor: theme.sheetScrim }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.surfaceSecondary,
              borderColor: theme.border,
            },
          ]}>
          <View style={styles.headerRow}>
            <Text
              testID="app-update-modal-title"
              style={[
                settingsTypography.sheetTitle,
                styles.titleText,
                { color: theme.text },
              ]}>
              {title}
            </Text>
            <Text
              testID="app-update-modal-size"
              style={[settingsTypography.footer, { color: theme.textSecondary }]}>
              {sizeLabel}
            </Text>
          </View>

          <Text
            testID="app-update-modal-notes"
            selectable
            style={[settingsTypography.dialogBody, { color: theme.text }]}>
            {notes}
          </Text>

          {isDownloading ? (
            <View testID="app-update-modal-progress" style={styles.progressWrap}>
              <View
                style={[
                  styles.progressTrack,
                  { backgroundColor: theme.controlFill },
                ]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${percent}%`,
                      backgroundColor: theme.save,
                    },
                  ]}
                />
              </View>
              <Text
                testID="app-update-modal-progress-label"
                style={[settingsTypography.footer, { color: theme.textSecondary }]}>
                {t('settings.appUpdate.downloading', {
                  percent,
                  received: formatBytes(phase.bytesReceived, t),
                  total: formatBytes(phase.totalBytes, t),
                })}
              </Text>
            </View>
          ) : null}

          {isVerifying ? (
            <Text
              testID="app-update-modal-verifying"
              style={[
                settingsTypography.footer,
                styles.verifyingText,
                { color: theme.textSecondary },
              ]}>
              {t('settings.appUpdate.verifying')}
            </Text>
          ) : null}

          {isPermission ? (
            <Text
              testID="app-update-modal-permission"
              style={[
                settingsTypography.dialogBody,
                styles.statusMessage,
                { color: theme.textSecondary },
              ]}>
              {t('settings.appUpdate.permissionMessage')}
            </Text>
          ) : null}

          {isError ? (
            <Text
              testID="app-update-modal-error"
              style={[
                settingsTypography.dialogBody,
                styles.statusMessage,
                { color: theme.danger },
              ]}>
              {phase.reason === 'verification_failed'
                ? t('settings.appUpdate.verificationFailed')
                : t('settings.appUpdate.downloadFailed')}
            </Text>
          ) : null}

          <View style={styles.footerRow}>
            {!isDownloading && !isVerifying ? (
              <Pressable
                testID="update-modal-browser"
                role="button"
                aria-label={t('settings.appUpdate.browserDownload')}
                onPress={onOpenBrowser}
                style={({ pressed }) => [
                  styles.browserLink,
                  { opacity: pressed ? 0.62 : 1 },
                ]}>
                <Text
                  style={[
                    settingsTypography.footer,
                    styles.browserLinkText,
                    { color: theme.textSecondary },
                  ]}>
                  {t('settings.appUpdate.browserDownload')}
                </Text>
              </Pressable>
            ) : (
              <View />
            )}

            <View style={styles.actionGroup}>
              {isDownloading ? (
                <UpdateActionPill
                  testID="update-modal-cancel"
                  label={t('settings.appUpdate.cancelDownload')}
                  accessibilityLabel={t('settings.appUpdate.cancelDownload')}
                  variant="ghost"
                  onPress={onCancelDownload}
                />
              ) : (
                <UpdateActionPill
                  testID="update-modal-later"
                  label={t('settings.appUpdate.later')}
                  accessibilityLabel={t('settings.appUpdate.later')}
                  variant="ghost"
                  disabled={isVerifying}
                  onPress={onLater}
                />
              )}

              {primaryActionNode}
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actionHitFrame: {
    marginVertical: -metrics.settingsDialog.actionFrame,
    paddingVertical: metrics.settingsDialog.actionFrame,
  },
  actionPill: {
    minHeight: metrics.settingsDialog.actionMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: metrics.settingsDialog.actionPaddingH,
    borderRadius: metrics.settingsRadius.button,
  },
  scrim: {
    flex: 1,
    justifyContent: 'center',
    padding: metrics.contentPadding,
  },
  card: {
    borderRadius: metrics.settingsDialog.radius,
    paddingTop: metrics.settingsDialog.paddingTop,
    paddingHorizontal: metrics.settingsDialog.paddingH,
    paddingBottom: metrics.settingsDialog.paddingBottom,
    borderWidth: metrics.settingsDialog.borderWidth,
    boxShadow: metrics.settingsDialog.shadow,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: metrics.settingsDialog.titleGap,
  },
  titleText: {
    flex: 1,
  },
  progressWrap: {
    marginTop: 14,
    gap: 6,
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
  },
  verifyingText: {
    marginTop: 14,
  },
  statusMessage: {
    marginTop: 12,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: metrics.settingsDialog.actionTopGap,
    gap: 8,
  },
  browserLink: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  browserLinkText: {
    textDecorationLine: 'underline',
  },
  actionGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: metrics.settingsDialog.actionGap,
  },
});
