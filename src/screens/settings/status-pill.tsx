import { Text, View } from 'react-native';

import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { cloudTypography } from '@/theme/typography';
import { pillContainerStyle } from './ui/pill-container';

export type StatusPillProps = {
  tone: 'ok' | 'warn' | 'bad';
  label: string;
  testID?: string;
};

export function StatusPill({ tone, label, testID }: StatusPillProps) {
  const theme = useAppThemeColors();
  const ink = tone === 'ok' ? theme.ok : tone === 'bad' ? theme.danger : theme.warnInk;
  return (
    <View
      testID={testID}
      style={[pillContainerStyle, {
        backgroundColor: tone === 'ok' ? theme.okSoft : tone === 'bad' ? theme.dangerSoft : theme.warnSoft,
      }]}>
      <View style={{ width: 6, height: 6, borderRadius: metrics.radius.circle, backgroundColor: ink }} />
      <Text style={{ ...cloudTypography.pill, color: ink }}>{label}</Text>
    </View>
  );
}
