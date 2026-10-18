import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type SettingsGroupProps = Readonly<{ children: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }>;
export function SettingsGroup({ children, testID, style }: SettingsGroupProps): ReactElement {
  const theme = useAppThemeColors();
  const items = Children.toArray(children);
  return <View testID={testID} style={[{ backgroundColor: theme.surfaceSecondary, borderWidth: 1,
    borderColor: theme.border, borderRadius: metrics.radius.card, overflow: 'hidden' }, style]}>
    {items.map((child, index) => <View key={isValidElement(child) ? child.key : index}
      style={index === 0 ? undefined : { borderTopWidth: 1, borderTopColor: theme.hair }}>
      {child}
    </View>)}
  </View>;
}
