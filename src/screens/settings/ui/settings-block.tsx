import type { ReactElement, ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type SettingsBlockProps = Readonly<{
  children: ReactNode; title?: string; testID?: string;
  /**
   * U4-design visual pass: the connect field cards take the mockup's fit
   * compensation (`metrics.settingsConnect.fieldCardPaddingH`) over the plain
   * 14 inset. Sourced from metrics at the call site, never a literal.
   */
  paddingHorizontal?: number;
}>;
export function SettingsBlock({ children, title, testID, paddingHorizontal = 14 }: SettingsBlockProps): ReactElement {
  const theme = useAppThemeColors();
  return <View testID={testID} style={{ paddingTop: 12, paddingHorizontal, paddingBottom: 14 }}>
    {title === undefined ? null : <Text style={[settingsTypography.rowTitle,
      { color: theme.text, marginBottom: metrics.settingsBlockTitleGap }]}>{title}</Text>}
    {children}
  </View>;
}
