import type { ReactElement } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type SettingsSegmentedControlChangeEvent = Readonly<{ nativeEvent: { value: string; selectedSegmentIndex: number } }>;
export type SettingsSegmentedControlProps = Readonly<{
  title: string; values: readonly string[]; selectedIndex: number; enabled?: boolean;
  testID?: string; onChange: (event: SettingsSegmentedControlChangeEvent) => void;
}>;

export default function SettingsSegmentedControl({ title, values, selectedIndex, enabled = true, testID, onChange }: SettingsSegmentedControlProps): ReactElement {
  const theme = useAppThemeColors();
  const dark = useColorScheme() === 'dark';
  const { t } = useAppTranslation();
  return <View testID={testID} role="radiogroup" aria-label={title} aria-disabled={!enabled}
    accessibilityState={enabled ? undefined : { disabled: true }}
    style={{ minHeight: 36, flexDirection: 'row', alignItems: 'stretch',
      backgroundColor: theme.controlFill, borderRadius: metrics.settingsRadius.track, padding: 3, gap: 2 }}>
    {values.map((value, index) => {
      const selected = index === selectedIndex;
      return <Pressable key={value + index} role="radio"
        aria-label={title + t('common.labelSeparator') + value} aria-checked={selected}
        accessibilityState={{ selected, checked: selected, disabled: !enabled }} disabled={!enabled}
        needsOffscreenAlphaCompositing
        onPress={() => onChange({ nativeEvent: { value, selectedSegmentIndex: index } })}
        style={({ pressed }) => ({ flex: 1, marginVertical: -9, paddingVertical: 9,
          opacity: pressed ? 0.7 : enabled ? 1 : 0.5 })}>
        <View style={{ minHeight: 30, alignItems: 'center', justifyContent: 'center',
          paddingVertical: 6, paddingHorizontal: 4, borderRadius: metrics.settingsRadius.segment,
          backgroundColor: selected ? theme.controlSelected : theme.controlFill,
          elevation: selected && !dark ? 1 : 0 }}>
          <Text numberOfLines={1} style={[settingsTypography.segmentLabel,
            { color: selected ? theme.text : theme.textSecondary }]}>{value}</Text>
        </View>
      </Pressable>;
    })}
  </View>;
}
