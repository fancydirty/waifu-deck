import { useState, type ReactElement } from 'react';
import { Linking, Modal, Pressable, Text, View } from 'react-native';

import {
  detectS3ApiKeyProvider,
  S3_API_KEY_PROVIDERS,
  type S3ApiKeyErrorCode,
  type S3ApiKeyProvider,
} from '@/features/byos/s3-api-key-provisioner';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { CloudMark, S3BrandMark } from '@/screens/settings/cloud-marks';
import { SettingsButton } from '@/screens/settings/ui/settings-button';
import { SettingsField } from '@/screens/settings/ui/settings-field';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { cloudTypography, settingsTypography } from '@/theme/typography';

const CF_R2_DASHBOARD_URL = 'https://dash.cloudflare.com/?to=/:account/r2';

export function StorageAdviceFaqModal({
  visible,
  onClose,
}: Readonly<{
  visible: boolean;
  onClose: () => void;
}>): ReactElement | null {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: metrics.contentPadding,
          backgroundColor: theme.sheetScrim,
        }}>
        <View
          testID="cloud-storage-faq-dialog"
          style={{
            backgroundColor: theme.surfaceSecondary,
            borderRadius: metrics.settingsDialog.radius,
            paddingTop: metrics.settingsDialog.paddingTop,
            paddingHorizontal: metrics.settingsDialog.paddingH,
            paddingBottom: metrics.settingsDialog.paddingBottom,
            borderWidth: metrics.settingsDialog.borderWidth,
            borderColor: theme.border,
            boxShadow: metrics.settingsDialog.shadow,
            gap: 14,
          }}>
          <Text style={[settingsTypography.sheetTitle, { color: theme.text }]}>
            {t('settings.cloudLibrary.faq.title')}
          </Text>

          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <S3BrandMark brand="r2" size={14} />
              <S3BrandMark brand="bunny" size={14} />
              <S3BrandMark brand="b2" size={14} />
              <Text style={[settingsTypography.rowTitle, { color: theme.text, flex: 1 }]}>
                {t('settings.cloudLibrary.faq.s3Heading')}
              </Text>
            </View>
            <Text style={[settingsTypography.dialogBody, { color: theme.textSecondary }]}>
              {t('settings.cloudLibrary.faq.s3Body')}
            </Text>
          </View>

          <View style={{ height: 1, backgroundColor: theme.hair }} />

          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <CloudMark kind="gdrive" size={14} />
              <CloudMark kind="onedrive" size={13} />
              <Text style={[settingsTypography.rowTitle, { color: theme.text, flex: 1 }]}>
                {t('settings.cloudLibrary.faq.driveHeading')}
              </Text>
            </View>
            <Text style={[settingsTypography.dialogBody, { color: theme.textSecondary }]}>
              {t('settings.cloudLibrary.faq.driveBody')}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 }}>
            <SettingsButton
              testID="cloud-storage-faq-close"
              variant="primary"
              onPress={onClose}>
              {t('settings.cloudLibrary.faq.gotIt')}
            </SettingsButton>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function S3ApiKeyQuickSetupModal({
  visible,
  initialProvider,
  busy,
  errorCode,
  onClearError,
  onClose,
  onConnect,
}: Readonly<{
  visible: boolean;
  initialProvider: S3ApiKeyProvider | null;
  busy: boolean;
  errorCode: S3ApiKeyErrorCode | null;
  onClearError: () => void;
  onClose: () => void;
  onConnect: (rawKey: string, provider: S3ApiKeyProvider) => void;
}>): ReactElement | null {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const [keyInput, setKeyInput] = useState('');
  const [selectedTab, setSelectedTab] = useState<S3ApiKeyProvider | null>(null);

  if (!visible) return null;

  const detectedProvider = detectS3ApiKeyProvider(keyInput);
  const activeProvider: S3ApiKeyProvider =
    selectedTab ?? detectedProvider ?? initialProvider ?? 'r2';
  const canConnect = !busy && keyInput.trim().length > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: metrics.contentPadding,
          backgroundColor: theme.sheetScrim,
        }}>
        <View
          testID="s3-apikey-dialog"
          style={{
            backgroundColor: theme.surfaceSecondary,
            borderRadius: metrics.settingsDialog.radius,
            paddingTop: metrics.settingsDialog.paddingTop,
            paddingHorizontal: metrics.settingsDialog.paddingH,
            paddingBottom: metrics.settingsDialog.paddingBottom,
            borderWidth: metrics.settingsDialog.borderWidth,
            borderColor: theme.border,
            boxShadow: metrics.settingsDialog.shadow,
            gap: 10,
          }}>
          <Text style={[settingsTypography.sheetTitle, { color: theme.text }]}>
            {t('settings.cloudLibrary.s3ApiKey.dialogTitle')}
          </Text>
          <Text style={[settingsTypography.connectHint, { color: theme.textSecondary }]}>
            {t('settings.cloudLibrary.s3ApiKey.dialogSubtitle')}
          </Text>

          <View style={{ flexDirection: 'row', gap: 6 }}>
            {S3_API_KEY_PROVIDERS.map((provider) => {
              const active = activeProvider === provider;
              const badge = t(`settings.cloudLibrary.s3ApiKey.providers.${provider}.badge`);
              return (
                <Pressable
                  key={provider}
                  testID={`s3-apikey-tab-${provider}`}
                  accessibilityRole="button"
                  accessibilityLabel={badge}
                  disabled={busy}
                  onPress={() => {
                    setSelectedTab(provider);
                    onClearError();
                  }}
                  style={({ pressed }) => {
                    let tabOpacity = 1;
                    if (busy) {
                      tabOpacity = 0.5;
                    } else if (pressed) {
                      tabOpacity = 0.72;
                    }
                    return {
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      paddingHorizontal: 6,
                      paddingVertical: 8,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: active ? theme.save : theme.border,
                      backgroundColor: active ? theme.saveSoft : theme.controlFill,
                      opacity: tabOpacity,
                    };
                  }}>
                  <S3BrandMark brand={provider} size={13} />
                  <Text
                    numberOfLines={1}
                    style={[
                      cloudTypography.pill,
                      { color: active ? theme.saveDeep : theme.text },
                    ]}>
                    {badge}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <SettingsField
            testID="s3-apikey-input"
            accessibilityLabel={t('settings.cloudLibrary.s3ApiKey.inputLabel')}
            placeholder={t('settings.cloudLibrary.s3ApiKey.inputPlaceholder')}
            secureTextEntry
            value={keyInput}
            disabled={busy}
            onChangeText={(val) => {
              setKeyInput(val);
              onClearError();
            }}
            paddingHorizontal={metrics.settingsConnect.fieldPaddingH}
          />

          {detectedProvider !== null ? (
            <View
              testID="s3-apikey-detected-banner"
              style={{
                borderRadius: 8,
                backgroundColor: theme.okSoft,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}>
              <Text style={[cloudTypography.pill, { color: theme.ok }]}>
                {t('settings.cloudLibrary.s3ApiKey.detectedPrefix', {
                  provider: t(
                    `settings.cloudLibrary.s3ApiKey.providers.${detectedProvider}.hintTitle`,
                  ),
                })}
              </Text>
            </View>
          ) : null}

          <View
            style={{
              borderRadius: 8,
              backgroundColor: theme.controlFill,
              paddingHorizontal: 10,
              paddingVertical: 8,
              gap: 4,
            }}>
            <Text style={[settingsTypography.rowTitle, { color: theme.text, fontSize: 13 }]}>
              {t(`settings.cloudLibrary.s3ApiKey.providers.${activeProvider}.hintTitle`)}
            </Text>
            <Text style={[settingsTypography.connectHint, { color: theme.textSecondary }]}>
              {t(`settings.cloudLibrary.s3ApiKey.providers.${activeProvider}.hintSteps`)}
            </Text>
            {activeProvider === 'r2' ? (
              <Pressable
                testID="s3-apikey-r2-dashboard-link"
                accessibilityRole="link"
                onPress={() => {
                  void Linking.openURL(CF_R2_DASHBOARD_URL).catch(() => undefined);
                }}
                style={{ paddingTop: 2 }}>
                <Text style={[cloudTypography.pill, { color: theme.saveDeep }]}>
                  {t('settings.cloudLibrary.s3ApiKey.openR2Dashboard')}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {errorCode !== null ? (
            <Text
              testID="s3-apikey-error"
              style={[settingsTypography.detail, { color: theme.danger }]}>
              {t(`settings.cloudLibrary.s3ApiKey.errors.${errorCode}`)}
            </Text>
          ) : null}

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: metrics.settingsDialog.actionGap,
              marginTop: 4,
            }}>
            <SettingsButton
              testID="s3-apikey-cancel"
              variant="ghost"
              disabled={busy}
              onPress={onClose}>
              {t('common.cancel')}
            </SettingsButton>
            <SettingsButton
              testID="s3-apikey-connect"
              variant="primary"
              disabled={!canConnect}
              onPress={() => onConnect(keyInput, activeProvider)}>
              {busy
                ? t('settings.cloudLibrary.s3ApiKey.connectingCta')
                : t('settings.cloudLibrary.s3ApiKey.connectCta')}
            </SettingsButton>
          </View>
        </View>
      </View>
    </Modal>
  );
}
