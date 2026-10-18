import type { ReactElement } from 'react';
import { cloneElement } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type SettingsButtonProps = Readonly<{
  children: string; variant: 'primary' | 'ghost' | 'danger'; disabled?: boolean;
  testID?: string; icon?: ReactElement; onPress: () => void;
}>;
export function SettingsButton({ children, variant, disabled = false, testID, icon, onPress }: SettingsButtonProps): ReactElement {
  const theme = useAppThemeColors();
  const backgroundColor = variant === 'primary' ? theme.save : variant === 'danger' ? theme.danger : theme.controlFill;
  const color = variant === 'ghost' ? theme.text : theme.destructiveText;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={children}
    disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
    style={({ pressed }) => ({ alignSelf: 'flex-start', marginVertical: -7, paddingVertical: 7,
      opacity: disabled ? 0.38 : pressed ? 0.62 : 1 })}>
    <View style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 8, paddingHorizontal: 12, borderRadius: metrics.settingsRadius.button, backgroundColor }}>
      {icon === undefined ? null : cloneElement(icon as ReactElement<{ accessible?: boolean }>, { accessible: false })}
      <Text style={[settingsTypography.buttonLabel, { color }]}>{children}</Text>
    </View>
  </Pressable>;
}
