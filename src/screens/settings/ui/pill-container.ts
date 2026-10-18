import type { ViewStyle } from 'react-native';
import { metrics } from '@/theme/metrics';

export const pillContainerStyle: Readonly<Pick<ViewStyle,
  'flexDirection' | 'alignItems' | 'gap' | 'paddingHorizontal' | 'paddingVertical' | 'borderRadius'>> = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6,
  paddingHorizontal: 9,
  paddingVertical: 3,
  borderRadius: metrics.radius.circle,
};
