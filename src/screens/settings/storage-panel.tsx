import type { ReactElement } from 'react';
import { Text, View } from 'react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { cloudTypography, settingsTypography } from '@/theme/typography';
import { formatCloudBytes } from './cloud-library-format';
import { isValidStorageBytes, storageSplit, type StorageBytes } from './storage-split';
import { SettingsButton } from './ui/settings-button';

export type StoragePanelProps = Readonly<{
  collectionBytes: StorageBytes;
  previewCacheBytes: StorageBytes;
  busy: boolean;
  onClear(): void;
}>;

function displayBytes(value: StorageBytes, unavailable: string, calculating: string): string {
  if (value === null) return calculating;
  if (!isValidStorageBytes(value)) return unavailable;
  const formatted = formatCloudBytes(value);
  return `${formatted.value} ${formatted.unit}`;
}

export function StoragePanel({ collectionBytes, previewCacheBytes, busy, onClear }: StoragePanelProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const split = storageSplit(collectionBytes, previewCacheBytes);
  const unavailable = t('settings.storage.unavailable');
  const calculating = t('settings.storage.calculating');
  const collectionFigure = displayBytes(collectionBytes, unavailable, calculating);
  const previewFigure = displayBytes(previewCacheBytes, unavailable, calculating);
  const totalFigure = split.status === 'measured' && split.total !== null
    ? formatCloudBytes(split.total)
    : null;
  const totalText = totalFigure === null
    ? split.status === 'unavailable' ? unavailable : calculating
    : totalFigure.value;

  return (
    <View testID="storage-panel" style={{}}>
      <Text testID="storage-total" style={{ ...cloudTypography.stat, color: theme.text }}>
        {totalText}{totalFigure === null ? null : <Text style={{ ...settingsTypography.storageUnit,
          color: theme.textSecondary }}>{' '}{totalFigure.unit}{' '}{t('settings.storage.used')}</Text>}
      </Text>
      <View style={{ marginVertical: 10 }}>
        <View testID="storage-split-bar" importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden style={{ flexDirection: 'row', height: 8,
            backgroundColor: theme.controlFill, borderRadius: metrics.radius.circle, overflow: 'hidden' }}>
          <View testID="storage-collection-segment"
            style={{ flex: split.collectionFlex, backgroundColor: theme.storageCollection }} />
          <View testID="storage-preview-segment"
            style={{ flex: split.previewFlex, marginLeft: split.collectionFlex > 0 && split.previewFlex > 0 ? 2 : 0,
              backgroundColor: theme.storagePreview }} />
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: metrics.settingsLegendRowGap,
        columnGap: metrics.settingsLegendColumnGap }}>
        <StorageLegend testID="storage-collection-size" swatchTestID="storage-collection-swatch"
          color={theme.storageCollection} label={t('settings.storage.legendCollection')} figure={collectionFigure} />
        <StorageLegend testID="storage-preview-size" swatchTestID="storage-preview-swatch"
          color={theme.storagePreview} label={t('settings.storage.legendPreviewCache')} figure={previewFigure} />
      </View>
      <View style={{ marginTop: 12 }}>
        <SettingsButton testID="storage-clear-preview-cache" variant="ghost" disabled={busy}
          onPress={() => { if (!busy) onClear(); }}>{t('settings.storage.clearPreviewCache')}</SettingsButton>
      </View>
    </View>
  );
}

function StorageLegend({ testID, swatchTestID, color, label, figure }: Readonly<{
  testID: string;
  swatchTestID: string;
  color: string;
  label: string;
  figure: string;
}>): ReactElement {
  const theme = useAppThemeColors();
  return (
    <View style={{ flexShrink: 1, minWidth: 0, flexDirection: 'row',
      alignItems: 'center', gap: metrics.settingsLegendSwatchGap }}>
      <View testID={swatchTestID} style={{ width: 8, height: 8,
        borderRadius: metrics.settingsRadius.swatch, backgroundColor: color }} />
      <Text testID={testID} style={{ ...settingsTypography.storageLegend,
        color: theme.textSecondary, flexShrink: 1 }}>{label}{' '}{figure}</Text>
    </View>
  );
}
