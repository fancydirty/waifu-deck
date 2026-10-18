import { useEffect, type ReactElement } from 'react';
import { Animated, Pressable, useAnimatedValue, type AccessibilityState } from 'react-native';

import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type SettingsToggleProps = Readonly<{
  value: boolean; disabled?: boolean; busy?: boolean; testID?: string; accessibilityLabel?: string;
  accessibilityState?: AccessibilityState; onValueChange(value: boolean): void;
}>;

export function SettingsToggle({ value, disabled = false, busy = false, testID, accessibilityLabel, accessibilityState, onValueChange }: SettingsToggleProps): ReactElement {
  const theme = useAppThemeColors();
  const pressDisabled = disabled || busy;
  const progress = useAnimatedValue(value ? 1 : 0);
  useEffect(() => {
    Animated.timing(progress, { toValue: value ? 1 : 0, duration: 120, useNativeDriver: true }).start();
  }, [progress, value]);
  return <Pressable testID={testID} role="switch" aria-label={accessibilityLabel} disabled={pressDisabled}
    accessibilityState={{ ...accessibilityState, checked: value, disabled: pressDisabled }}
    needsOffscreenAlphaCompositing
    hitSlop={{ top: 12, bottom: 12, left: 3, right: 3 }}
    onPress={() => { if (!pressDisabled) onValueChange(!value); }}
    style={{ width: 42, height: 24, borderRadius: metrics.radius.circle, opacity: disabled ? 0.38 : 1,
      backgroundColor: value ? theme.save : theme.switchTrackOff, justifyContent: 'center', paddingHorizontal: 3 }}>
    <Animated.View style={{ width: 18, height: 18, borderRadius: metrics.radius.circle,
      backgroundColor: theme.switchThumb, shadowColor: theme.toggleShadow, shadowOpacity: 0.18,
      shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1,
      transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) }] }} />
  </Pressable>;
}
