import { useCallback, useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { TextInput } from 'react-native';

import {
  KeyboardRevealContext,
  type MeasureLayout,
} from '@/screens/settings/keyboard-reveal';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type SettingsFieldProps = {
  accessibilityLabel: string;
  disabled?: boolean;
  keyboardType?: 'default' | 'url';
  onChangeText(value: string): void;
  placeholder: string;
  secureTextEntry?: boolean;
  testID: string;
  value: string;
  /**
   * U4-design visual pass: the connect field cards take the mockup's fit
   * compensation (`metrics.settingsConnect.fieldPaddingH`) over the plain
   * 12 inset. Sourced from metrics at the call site, never a literal.
   */
  paddingHorizontal?: number;
};

/**
 * U2c2 settings field (CD8): the settings screens' single field component —
 * the shared native input defaults and the v4 boxed-field look (1.5 border,
 * 12 radius, card fill, 15/heavy type, save border on focus). No outer margin —
 * the SettingsBlock owns the insets and the second-field wrapper owns the 8 gap.
 */
export function SettingsField({
  accessibilityLabel,
  disabled = false,
  keyboardType,
  onChangeText,
  paddingHorizontal = metrics.spacing.medium,
  placeholder,
  secureTextEntry,
  testID,
  value,
}: SettingsFieldProps): ReactElement {
  const theme = useAppThemeColors();
  const keyboardReveal = useContext(KeyboardRevealContext);
  const inputRef = useRef<TextInput>(null);
  const measureLayoutRef = useRef<MeasureLayout | null>(null);
  const [focused, setFocused] = useState(false);
  const releaseMeasure = keyboardReveal?.release;
  const releaseCurrentMeasure = useCallback(() => {
    const measureLayout = measureLayoutRef.current;
    if (measureLayout === null) return;
    releaseMeasure?.(measureLayout);
    measureLayoutRef.current = null;
  }, [releaseMeasure]);
  useEffect(() => releaseCurrentMeasure, [releaseCurrentMeasure]);
  return (
    <TextInput
      ref={inputRef}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={keyboardType}
      editable={!disabled}
      placeholder={placeholder}
      placeholderTextColor={theme.textSecondary}
      secureTextEntry={secureTextEntry}
      value={value}
      onChangeText={onChangeText}
      onFocus={() => {
        setFocused(true);
        const input = inputRef.current;
        if (input === null || keyboardReveal === null) return;
        const measureLayout: MeasureLayout = (relativeTo, onSuccess, onFail) => {
          input.measureLayout(relativeTo, onSuccess, onFail);
        };
        measureLayoutRef.current = measureLayout;
        keyboardReveal.reveal(measureLayout);
      }}
      onBlur={() => {
        setFocused(false);
        releaseCurrentMeasure();
      }}
      style={[settingsTypography.field, {
        minHeight: metrics.minimumHitArea,
        paddingVertical: metrics.settingsBlockTitleGap,
        paddingHorizontal,
        borderWidth: metrics.settingsFieldBorderWidth,
        borderColor: focused ? theme.save : theme.border,
        borderRadius: metrics.settingsRadius.field,
        color: theme.text,
        backgroundColor: theme.surfaceSecondary,
      }]}
    />
  );
}
