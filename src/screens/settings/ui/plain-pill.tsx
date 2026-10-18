import { cloneElement, type ReactElement } from 'react';
import { Text, View } from 'react-native';
import { useAppThemeColors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { pillContainerStyle } from './pill-container';

export type PlainPillProps = Readonly<{ label: string; icon: ReactElement; testID?: string }>;
export function PlainPill({ label, icon, testID }: PlainPillProps): ReactElement {
  const theme = useAppThemeColors();
  return <View testID={testID} style={[pillContainerStyle, { backgroundColor: theme.controlFill }]}>
    {cloneElement(icon as ReactElement<{ accessible?: boolean }>, { accessible: false })}
    <Text numberOfLines={1} style={[settingsTypography.plainPill, { color: theme.text }]}>{label}</Text>
  </View>;
}
