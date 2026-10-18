import { Text, View } from 'react-native';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { cloudTypography } from '@/theme/typography';

export type CloudQuota = Readonly<{ usedBytes: number; totalBytes: number | null }>;

export function CloudQuotaBar({ quota }: { quota: CloudQuota }) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const used = (quota.usedBytes / 1_000_000_000).toFixed(1);
  const knownTotal = quota.totalBytes !== null;
  const total = knownTotal ? (quota.totalBytes / 1_000_000_000).toFixed(1) : null;
  const fraction = knownTotal && quota.totalBytes > 0
    ? Math.max(0, Math.min(1, quota.usedBytes / quota.totalBytes)) : 0;
  return (
    <View testID="byos-quota" style={{ paddingHorizontal: metrics.contentPadding, paddingVertical: metrics.spacing.medium, gap: metrics.spacing.small }}>
      <Text style={{ ...cloudTypography.footer, color: theme.text }}>
        {knownTotal ? t('settings.cloudLibrary.quota', { used, total }) : t('settings.cloudLibrary.quotaUsedOnly', { used })}
      </Text>
      {knownTotal ? (
        <View
          testID="byos-quota-progress"
          accessible
          accessibilityRole="progressbar"
          accessibilityValue={quota.totalBytes != null && quota.totalBytes > 0
            ? { min: 0, max: 100, now: Math.round(fraction * 100) }
            : undefined}
          style={{ height: 8, borderRadius: metrics.radius.circle, backgroundColor: theme.hair, overflow: 'hidden' }}>
          <View style={{ width: `${fraction * 100}%`, height: '100%', backgroundColor: theme.cloud }} />
        </View>
      ) : null}
    </View>
  );
}
