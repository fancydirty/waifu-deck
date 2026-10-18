import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { Pressable, Text, View, type AccessibilityState, type TextProps } from 'react-native';
import { ChevronRight } from 'lucide-react-native';

import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { SettingsToggle } from './ui/settings-toggle';

export type SettingRowProps = {
  label: string;
  value?: string;
  detail?: string;
  detailNumberOfLines?: TextProps['numberOfLines'];
  detailEllipsizeMode?: TextProps['ellipsizeMode'];
  accessibilityLabel?: string;
  testID?: string;
  destructive?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  control?: ReactNode;
  onPress?: () => void;
};

export function SettingRow({
  label,
  value,
  detail,
  detailNumberOfLines,
  detailEllipsizeMode,
  accessibilityLabel,
  testID,
  destructive = false,
  disabled = false,
  icon,
  control,
  onPress,
}: SettingRowProps) {
  const theme = useAppThemeColors();
  const content = (
    <>
      {icon ? <View style={{ width: 28, alignItems: 'center' }}>{icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          selectable={!onPress}
          style={{
            color: destructive ? theme.danger : theme.text,
            fontSize: 16,
            flexShrink: 1,
          }}>
          {label}
        </Text>
        {detail ? (
          <Text
            selectable
            numberOfLines={detailNumberOfLines}
            ellipsizeMode={detailEllipsizeMode}
            style={{ color: theme.textSecondary, fontSize: 13, flexShrink: 1 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text
          selectable
          style={{
            color: theme.textSecondary,
            fontSize: 15,
            fontVariant: ['tabular-nums'],
            textAlign: 'right',
            flexShrink: 1,
          }}>
          {value}
        </Text>
      ) : null}
      {control}
      {onPress ? <ChevronRight color={theme.textSecondary} size={20} /> : null}
    </>
  );
  const style = {
    minHeight: 56,
    width: '100%' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: metrics.spacing.small,
    paddingHorizontal: metrics.contentPadding,
    paddingVertical: metrics.spacing.small,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.surface,
  };

  if (!onPress) return <View testID={testID} style={style}>{content}</View>;
  return (
    <Pressable
      testID={testID}
      role="button"
      aria-label={accessibilityLabel ?? label}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={({ pressed }) => ({
        ...style,
        opacity: disabled ? 0.38 : pressed ? 0.62 : 1,
      })}>
      {content}
    </Pressable>
  );
}

export type PersistedSwitchProps = Readonly<{
  testID?: string; accessibilityLabel?: string; accessibilityState?: AccessibilityState;
  disabled?: boolean; busy?: boolean; value: boolean;
  onValueChange(value: boolean): Promise<boolean>;
  onPendingChange?(pending: boolean): void;
}>;

export function PersistedSwitch({ accessibilityState, disabled, busy, onPendingChange,
  onValueChange, value, testID, accessibilityLabel }: PersistedSwitchProps): ReactElement {
  const [draftValue, setDraftValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const displayedValue = draftValue ?? value;
  const switchDisabled = Boolean(disabled || busy || saving);
  if (!saving && draftValue !== null && draftValue === value) setDraftValue(null);
  const commit = useCallback((nextValue: boolean) => {
    if (switchDisabled) return;
    setDraftValue(nextValue); setSaving(true); onPendingChange?.(true);
    void onValueChange(nextValue).then((saved) => {
      if (!saved) setDraftValue(null);
    }).catch(() => setDraftValue(null)).finally(() => {
      setSaving(false); onPendingChange?.(false);
    });
  }, [onPendingChange, onValueChange, switchDisabled]);
  return <SettingsToggle testID={testID} accessibilityLabel={accessibilityLabel}
    accessibilityState={accessibilityState} disabled={disabled} busy={busy || saving} value={displayedValue}
    onValueChange={commit} />;
}
