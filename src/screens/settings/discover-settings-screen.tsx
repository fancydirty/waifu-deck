import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppServices } from '@/providers/app-services';
import { ChoiceModal } from '@/screens/settings/settings-dialogs';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import SettingsSegmentedControl from '@/screens/settings/ui/settings-segmented-control';
import { SettingsSubpageScroll } from '@/screens/settings/ui/settings-subpage-scroll';
import {
  ANIMATION_VALUES,
  MAX_BYTES_OPTIONS,
  MIN_WIDTH_OPTIONS,
  ORIENTATION_VALUES,
  PREFETCH_DEPTH_VALUES,
  STYLE_PREFERENCE_VALUES,
} from '@/screens/settings/settings-options';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import type {
  AppSettings,
  MaximumBytes,
  MinimumWidth,
} from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';

type DiscoverChoice = 'minWidth' | 'maxBytes' | null;

export function DiscoverSettingsScreen() {
  const theme = useAppThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useAppTranslation();
  const { settings, updateSettings } = useAppServices();
  const [choice, setChoice] = useState<DiscoverChoice>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const save = useCallback(async (
    update: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>),
  ) => {
    setNotice(null);
    try {
      await updateSettings((current) => ({
        ...current,
        ...(typeof update === 'function' ? update(current) : update),
      }));
    } catch {
      setNotice(t('settings.saveError'));
    }
  }, [t, updateSettings]);

  const minWidthOptions = MIN_WIDTH_OPTIONS.map((option) => option.value === 0
    ? { ...option, label: t('settings.quality.unlimited') }
    : option);
  const maxBytesOptions = MAX_BYTES_OPTIONS.map((option) => option.value === 0
    ? { ...option, label: t('settings.quality.unlimited') }
    : option);

  return (
    <View testID="screen-settings-discover" style={{ flex: 1, backgroundColor: theme.surface }}>
      <SettingsSubpageScroll testID="settings-discover-scroll">
        <SettingsGroup testID="settings-discover-primary-group" style={{ marginHorizontal: metrics.settingsGutter }}>
          <SettingsBlock testID="settings-style-block" title={t('settings.filters.stylePreference')}>
            <SettingsSegmentedControl
              testID="settings-style-preference"
              title={t('settings.filters.stylePreference')}
              values={[t('settings.filters.styleAny'), t('settings.filters.prefer3d'), t('settings.filters.prefer2d')]}
              selectedIndex={STYLE_PREFERENCE_VALUES.indexOf(settings.stylePreference)}
              onChange={(event) => void save({ stylePreference: STYLE_PREFERENCE_VALUES[event.nativeEvent.selectedSegmentIndex] })}
            />
            <Text style={[settingsTypography.hint, { color: theme.textSecondary, marginTop: metrics.spacing.small }]}>
              {t('settings.filters.stylePreferenceDetail')}
            </Text>
          </SettingsBlock>
          <SettingsBlock testID="settings-orientation-block" title={t('settings.filters.orientation')}>
            <SettingsSegmentedControl
              testID="image-orientation"
              title={t('settings.filters.orientation')}
              values={[t('settings.filters.portrait'), t('settings.filters.landscape'), t('settings.filters.any')]}
              selectedIndex={ORIENTATION_VALUES.indexOf(settings.orientation)}
              onChange={(event) => void save({ orientation: ORIENTATION_VALUES[event.nativeEvent.selectedSegmentIndex] })}
            />
          </SettingsBlock>
          <SettingsBlock testID="settings-animation-block" title={t('settings.filters.animation')}>
            <SettingsSegmentedControl
              testID="animation"
              title={t('settings.filters.animation')}
              values={[t('settings.filters.excludeAnimation'), t('settings.filters.includeAnimation'), t('settings.filters.onlyAnimation')]}
              selectedIndex={ANIMATION_VALUES.indexOf(settings.animationMode)}
              onChange={(event) => void save({ animationMode: ANIMATION_VALUES[event.nativeEvent.selectedSegmentIndex] })}
            />
          </SettingsBlock>
        </SettingsGroup>
        <SettingsGroup testID="settings-discover-secondary-group" style={{ marginHorizontal: metrics.settingsGutter, marginTop: metrics.settingsGroupGap }}>
          <SettingsRow
            testID="settings-min-width"
            label={t('settings.quality.minimumWidth')}
            value={settings.minWidth === 0 ? t('settings.quality.unlimited') : MIN_WIDTH_OPTIONS.find((option) => option.value === settings.minWidth)?.label}
            accessibilityLabel={t('settings.quality.chooseMinimumWidth')}
            chevron
            onPress={() => setChoice('minWidth')}
          />
          <SettingsRow
            testID="settings-max-bytes"
            label={t('settings.quality.maximumFileSize')}
            value={settings.maxBytes === 0 ? t('settings.quality.unlimited') : MAX_BYTES_OPTIONS.find((option) => option.value === settings.maxBytes)?.label}
            accessibilityLabel={t('settings.quality.chooseMaximumFileSize')}
            chevron
            onPress={() => setChoice('maxBytes')}
          />
          <SettingsBlock testID="settings-prefetch-block" title={t('settings.storage.prefetchDepth')}>
            <SettingsSegmentedControl
              testID="settings-prefetch-depth"
              title={t('settings.storage.prefetchDepth')}
              values={PREFETCH_DEPTH_VALUES.map(String)}
              selectedIndex={PREFETCH_DEPTH_VALUES.indexOf(settings.prefetchDepth)}
              onChange={(event) => void save({ prefetchDepth: PREFETCH_DEPTH_VALUES[event.nativeEvent.selectedSegmentIndex] })}
            />
          </SettingsBlock>
        </SettingsGroup>
      </SettingsSubpageScroll>
      {notice ? (
        <Text
          testID="settings-notice"
          selectable
          accessibilityLiveRegion="polite"
          style={[settingsTypography.detail, {
            padding: metrics.spacing.medium,
            color: theme.text,
            backgroundColor: theme.surfaceSecondary,
            borderTopWidth: 1,
            borderTopColor: theme.hair,
            marginBottom: insets.bottom,
          }]}>
          {notice}
        </Text>
      ) : null}
      <ChoiceModal
        visible={choice !== null}
        title={choice === 'minWidth' ? t('settings.quality.minimumWidth') : t('settings.quality.maximumFileSize')}
        options={choice === 'minWidth' ? minWidthOptions : maxBytesOptions}
        selectedValue={choice === 'minWidth' ? settings.minWidth : settings.maxBytes}
        onClose={() => setChoice(null)}
        onSelect={(value) => {
          const selectedChoice = choice;
          setChoice(null);
          if (selectedChoice === 'minWidth') void save({ minWidth: value as MinimumWidth });
          if (selectedChoice === 'maxBytes') void save({ maxBytes: value as MaximumBytes });
        }}
      />
    </View>
  );
}
