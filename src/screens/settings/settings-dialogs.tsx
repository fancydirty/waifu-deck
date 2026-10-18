import { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TFunction } from 'i18next';

import type { DeleteAllDataResult } from '@/features/collection/collection-service';
import i18n from '@/i18n';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type SettingsChoiceKind = 'language' | 'minWidth' | 'maxBytes' | null;
export type SettingsResetKind = 'dismissed' | 'discovery' | null;
export type SettingsChoiceOption = { label: string; value: number | string };

/**
 * U3b: the shared bottom choice sheet (mockup v4 §3 「选择表和确认框（改后）」) —
 * scrim, grab bar, 17/800 header, option rows in a group card, radio dots and
 * bottom safe-area clearance. Purely visual: copy, option order, roles,
 * accessible names, selection writes and close semantics are frozen, so every
 * caller keeps its behaviour.
 */
export function ChoiceModal({
  title,
  options,
  visible,
  onSelect,
  onClose,
  selectedValue,
  safeAreaBottom,
}: {
  title: string;
  options: readonly SettingsChoiceOption[];
  visible: boolean;
  onSelect(value: number | string): void;
  onClose(): void;
  /** v4 §3 selection mark: which option's radio dot is drawn filled. Visual only. */
  selectedValue?: number | string | null;
  /**
   * Test override for the device's bottom safe-area inset (the TagPickerSheet
   * `safeAreaTop` precedent). Defaults to `useSafeAreaInsets().bottom`.
   */
  safeAreaBottom?: number;
}) {
  const theme = useAppThemeColors();
  const insets = useSafeAreaInsets();
  const bottomInset = safeAreaBottom ?? insets.bottom;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{
        flex: 1,
        justifyContent: 'flex-end',
        backgroundColor: theme.sheetScrim,
      }}>
        <View style={{
          backgroundColor: theme.surfaceSecondary,
          borderTopLeftRadius: metrics.settingsSheet.radius,
          borderTopRightRadius: metrics.settingsSheet.radius,
          borderTopWidth: 1,
          borderTopColor: theme.border,
          paddingTop: metrics.settingsSheet.paddingTop,
          paddingHorizontal: metrics.settingsSheet.paddingH,
          // Gesture band clamp (U2c2): Honor reports ~0 bottom inset to the
          // edge-to-edge window; content must still clear the 24 dp band.
          paddingBottom: metrics.settingsSheet.paddingBottom + Math.max(bottomInset, metrics.gestureInset),
        }}>
          <View style={{
            width: metrics.settingsSheet.grabWidth,
            height: metrics.settingsSheet.grabHeight,
            borderRadius: metrics.radius.circle,
            backgroundColor: theme.border,
            alignSelf: 'center',
            marginTop: metrics.settingsSheet.grabTopGap,
            marginBottom: metrics.settingsSheet.grabBottomGap,
          }} />
          <Text style={[settingsTypography.sheetTitle, {
            color: theme.text,
            marginBottom: metrics.settingsSheet.headerGap,
          }]}>
            {title}
          </Text>
          <View style={{
            backgroundColor: theme.surfaceSecondary,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: metrics.radius.card,
            overflow: 'hidden',
          }}>
            {options.map((option, index) => {
              const selected = selectedValue != null && option.value === selectedValue;
              return (
                <Pressable
                  key={option.value}
                  role="button"
                  aria-label={option.label}
                  onPress={() => onSelect(option.value)}
                  style={({ pressed }) => ({
                    minHeight: metrics.settingsSheet.rowMinHeight,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: metrics.settingsSheet.rowContentGap,
                    paddingVertical: metrics.settingsSheet.rowPaddingV,
                    paddingHorizontal: metrics.settingsSheet.rowPaddingH,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: theme.hair,
                    opacity: pressed ? 0.62 : 1,
                  })}>
                  <Text style={[settingsTypography.rowTitle, { color: theme.text, flex: 1 }]}>
                    {option.label}
                  </Text>
                  <View
                    accessible={false}
                    style={{
                      width: metrics.settingsSheet.radioSize,
                      height: metrics.settingsSheet.radioSize,
                      borderRadius: metrics.radius.circle,
                      borderWidth: metrics.settingsSheet.radioBorderWidth,
                      borderColor: selected ? theme.save : theme.border,
                    }}>
                    {selected ? (
                      <View
                        accessible={false}
                        style={{
                          position: 'absolute',
                          top: metrics.settingsSheet.radioDotInset,
                          left: metrics.settingsSheet.radioDotInset,
                          right: metrics.settingsSheet.radioDotInset,
                          bottom: metrics.settingsSheet.radioDotInset,
                          borderRadius: metrics.radius.circle,
                          backgroundColor: theme.save,
                        }}
                      />
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * U3c: the shared dialog action (mockup v4 §3 `.wd-btn.small`) — a 34 dp pill
 * (13/800 ink, 10 radius, 0/12 padding) inside a ±7 frame, so the drawn shape
 * matches v4 while the touch box keeps the plan's 48 dp floor (the U1
 * SettingsButton pattern). Ghost = control-fill pill with text ink; danger =
 * danger fill with white ink; off = 0.38.
 */
function DialogAction({
  label,
  accessibilityLabel,
  variant,
  disabled = false,
  accessibilityState,
  testID,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  variant: 'ghost' | 'danger';
  disabled?: boolean;
  accessibilityState?: { disabled: boolean };
  testID?: string;
  onPress(): void;
}) {
  const theme = useAppThemeColors();
  return (
    <Pressable
      testID={testID}
      role="button"
      aria-label={accessibilityLabel}
      disabled={disabled}
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={({ pressed }) => ({
        marginVertical: -metrics.settingsDialog.actionFrame,
        paddingVertical: metrics.settingsDialog.actionFrame,
        opacity: disabled ? 0.38 : pressed ? 0.62 : 1,
      })}>
      <View style={{
        minHeight: metrics.settingsDialog.actionMinHeight,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: metrics.settingsDialog.actionPaddingH,
        borderRadius: metrics.settingsRadius.button,
        backgroundColor: variant === 'danger' ? theme.danger : theme.controlFill,
      }}>
        <Text style={[settingsTypography.buttonLabel, {
          color: variant === 'danger' ? theme.destructiveText : theme.text,
        }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{
        flex: 1,
        justifyContent: 'center',
        padding: metrics.contentPadding,
        backgroundColor: theme.sheetScrim,
      }}>
        <View style={{
          backgroundColor: theme.surfaceSecondary,
          borderRadius: metrics.settingsDialog.radius,
          paddingTop: metrics.settingsDialog.paddingTop,
          paddingHorizontal: metrics.settingsDialog.paddingH,
          paddingBottom: metrics.settingsDialog.paddingBottom,
          borderWidth: metrics.settingsDialog.borderWidth,
          borderColor: theme.border,
          boxShadow: metrics.settingsDialog.shadow,
        }}>
          <Text style={[settingsTypography.sheetTitle, {
            color: theme.text,
            marginBottom: metrics.settingsDialog.titleGap,
          }]}>
            {title}
          </Text>
          <Text selectable style={[settingsTypography.dialogBody, { color: theme.text }]}>
            {message}
          </Text>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: metrics.settingsDialog.actionGap,
            marginTop: metrics.settingsDialog.actionTopGap,
          }}>
            <DialogAction
              label={cancelLabel ?? t('common.cancel')}
              accessibilityLabel={cancelLabel ?? t('common.cancel')}
              variant="ghost"
              onPress={onCancel}
            />
            <DialogAction
              label={confirmLabel}
              accessibilityLabel={confirmLabel}
              variant="danger"
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function DeleteAllModal({
  visible,
  busy,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const [phrase, setPhrase] = useState('');
  const exact = phrase === 'DELETE';
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{
        flex: 1,
        justifyContent: 'center',
        padding: metrics.contentPadding,
        backgroundColor: theme.sheetScrim,
      }}>
        <View style={{
          backgroundColor: theme.surfaceSecondary,
          borderRadius: metrics.settingsDialog.radius,
          paddingTop: metrics.settingsDialog.paddingTop,
          paddingHorizontal: metrics.settingsDialog.paddingH,
          paddingBottom: metrics.settingsDialog.paddingBottom,
          borderWidth: metrics.settingsDialog.borderWidth,
          borderColor: theme.border,
          boxShadow: metrics.settingsDialog.shadow,
        }}>
          <Text style={[settingsTypography.sheetTitle, {
            color: theme.text,
            marginBottom: metrics.settingsDialog.titleGap,
          }]}>
            {t('settings.deleteAll.title')}
          </Text>
          <Text selectable style={[settingsTypography.dialogBody, { color: theme.text }]}>
            {t('settings.deleteAll.message')}
          </Text>
          <TextInput
            testID="settings-delete-all-input"
            aria-label={t('settings.deleteAll.input')}
            value={phrase}
            onChangeText={setPhrase}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!busy}
            style={[settingsTypography.dialogInput, {
              marginTop: metrics.settingsDialog.inputTopGap,
              minHeight: metrics.minimumHitArea,
              paddingVertical: metrics.settingsDialog.inputPaddingV,
              paddingHorizontal: metrics.settingsDialog.inputPaddingH,
              borderWidth: metrics.settingsFieldBorderWidth,
              borderColor: theme.border,
              borderRadius: metrics.settingsRadius.field,
              color: theme.textSecondary,
            }]}
          />
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: metrics.settingsDialog.actionGap,
            marginTop: metrics.settingsDialog.actionTopGap,
          }}>
            <DialogAction
              label={t('common.cancel')}
              accessibilityLabel={t('settings.deleteAll.cancel')}
              variant="ghost"
              disabled={busy}
              onPress={onCancel}
            />
            <DialogAction
              testID="settings-delete-all-confirm"
              label={t('common.delete')}
              accessibilityLabel={t('settings.deleteAll.confirm')}
              variant="danger"
              disabled={!exact || busy}
              accessibilityState={{ disabled: !exact || busy }}
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function remainingDeleteMessage(
  result: DeleteAllDataResult,
  t: TFunction = i18n.t,
  cloudBound = false,
): string {
  const stages = [...result.remaining];
  if (cloudBound && !result.library.disconnected && !stages.includes('cloud')) {
    stages.push('cloud');
  }
  const labels = stages.map((stage) => ({
    files: t('settings.deleteAll.files'),
    database: t('settings.deleteAll.database'),
    settings: t('settings.deleteAll.settings'),
    cloud: result.library.disconnected
      ? t('settings.deleteAll.cloudRecords')
      : t('settings.deleteAll.cloud'),
  })[stage]);
  return t('settings.deleteAll.remaining', {
    labels: labels.join(t('common.listSeparator')),
  });
}
