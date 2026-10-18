import { Text, type StyleProp, type TextStyle } from 'react-native';

import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export function SectionHeading({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const theme = useAppThemeColors();
  return (
    <Text
      selectable
      style={[settingsTypography.groupLabel, {
        paddingHorizontal: metrics.settingsGutter + 6,
        paddingTop: 20,
        paddingBottom: 8,
        color: theme.textSecondary,
      }, style]}>
      {children}
    </Text>
  );
}
