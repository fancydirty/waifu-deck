import { Text, View } from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { LibraryActionsController } from '@/features/library/library-actions-service';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';

export type LibraryCloudSectionProps = {
  actions: LibraryActionsController | null;
  accountScope: string | null | undefined;
  byosStatus?: ByosStatus;
  message?: string;
};

export function LibraryCloudSection({ accountScope, message }: LibraryCloudSectionProps) {
  const colors = useAppThemeColors();
  if (message === undefined) return <View style={{ gap: metrics.spacing.small }} />;
  return (
    <View style={{ gap: metrics.spacing.small }}>
      <Text testID={accountScope === null ? 'library-cloud-unavailable' : 'byos-message'} style={{ ...settingsTypography.cloudMessage, color: colors.text }}>
        {message}
      </Text>
    </View>
  );
}
