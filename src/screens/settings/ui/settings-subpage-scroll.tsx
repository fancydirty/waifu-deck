import type { ReactElement, ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type SettingsSubpageScrollProps = Readonly<{
  children: ReactNode;
  testID: string;
}>;

export function SettingsSubpageScroll({ children, testID }: SettingsSubpageScrollProps): ReactElement {
  const theme = useAppThemeColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1, backgroundColor: theme.surface }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingTop: metrics.spacing.medium,
        paddingBottom: Math.max(insets.bottom, metrics.gestureInset) + metrics.spacing.large,
      }}>
      {children}
    </ScrollView>
  );
}
