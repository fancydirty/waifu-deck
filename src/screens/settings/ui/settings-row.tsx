import type { ReactElement, ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type TextProps, type ViewStyle } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useAppThemeColors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';

export type SettingsRowProps = Readonly<{
  label: string; value?: string; detail?: string;
  detailNumberOfLines?: TextProps['numberOfLines']; detailEllipsizeMode?: TextProps['ellipsizeMode'];
  accessibilityLabel?: string; testID?: string; destructive?: boolean; disabled?: boolean;
  /** U4-design visual pass: the row-start slot (picker icon tile, back chevron). */
  icon?: ReactNode;
  trailing?: ReactNode; chevron?: boolean; onPress?: () => void; style?: StyleProp<ViewStyle>;
}>;
export function SettingsRow({ label, value, detail, detailNumberOfLines, detailEllipsizeMode,
  accessibilityLabel, testID, destructive = false, disabled = false, icon, trailing, chevron = false, onPress, style }: SettingsRowProps): ReactElement {
  const theme = useAppThemeColors();
  const content = <>{icon}<View style={{ flex: 1, minWidth: 0, gap: 2 }}>
    <Text selectable={!onPress} style={[settingsTypography.rowTitle, { color: destructive ? theme.danger : theme.text, flexShrink: 1 }]}>{label}</Text>
    {detail === undefined ? null : <Text selectable numberOfLines={detailNumberOfLines}
      ellipsizeMode={detailEllipsizeMode} style={[settingsTypography.detail, { color: theme.textSecondary, flexShrink: 1 }]}>{detail}</Text>}
  </View>
  {value === undefined ? null : <Text selectable numberOfLines={1} ellipsizeMode="tail"
    style={[settingsTypography.value, { color: theme.textSecondary, maxWidth: '58%', textAlign: 'right', flexShrink: 1 }]}>{value}</Text>}
  {trailing}{chevron ? <ChevronRight accessible={false} color={theme.textSecondary} size={18} /> : null}</>;
  const rowStyle = [{ minHeight: 52, width: '100%' as const, flexDirection: 'row' as const,
    alignItems: 'center' as const, gap: 12, paddingHorizontal: 14, paddingVertical: 12 }, style];
  if (onPress === undefined) return <View testID={testID} style={rowStyle}>{content}</View>;
  return <Pressable testID={testID} role="button" aria-label={accessibilityLabel ?? label}
    disabled={disabled} accessibilityState={{ disabled }} onPress={onPress}
    style={({ pressed }) => [rowStyle, { opacity: disabled ? 0.38 : pressed ? 0.62 : 1 }]}>{content}</Pressable>;
}
