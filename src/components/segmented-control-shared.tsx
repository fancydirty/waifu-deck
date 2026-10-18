import type { ScrollViewProps, StyleProp, ViewStyle } from 'react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

type SegmentedControlChangeEvent = {
  nativeEvent: {
    value: string;
    selectedSegmentIndex: number;
  };
};

type SegmentedControlProps = Omit<
  ScrollViewProps,
  'onChange' | 'style' | 'horizontal' | 'children'
> & {
  values: readonly string[];
  selectedIndex?: number | null;
  enabled?: boolean;
  /** Optional per-option count shown after the label (`null` hides it). */
  counts?: readonly (number | null)[];
  /** Optional per-option badge pill, e.g. `18+` (`null` hides it). */
  badges?: readonly (string | null)[];
  /**
   * `false` renders the radio group as a plain row without its own scroller so
   * a parent can place it inside one `ScrollView horizontal` alongside other
   * controls. The collection filter row needs this: spec §4 puts the source
   * chip at the end of the same row, and that chip is a `role=button`, which
   * must not be a child of a `role=radiogroup`.
   */
  scrollable?: boolean;
  style?: StyleProp<ViewStyle>;
  onChange?(event: SegmentedControlChangeEvent): void;
  onValueChange?(value: string): void;
};

/**
 * R8.27: one choice-chip row for every three-way control in the app. The
 * selected option is a solid `theme.text` pill so the current choice reads at
 * a glance; unselected options are outlined `theme.surface` pills. The row
 * scrolls horizontally when the labels overflow instead of squeezing them.
 * Radio-group semantics and the `onChange` event shape are unchanged, so the
 * settings call sites keep working without edits.
 */
export default function SegmentedControl({
  values,
  selectedIndex = 0,
  enabled = true,
  counts,
  badges,
  scrollable = true,
  style,
  onChange,
  onValueChange,
  accessibilityLabel,
  testID,
  ...scrollViewProps
}: SegmentedControlProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();

  const chips = values.map((value, index) => {
    const selected = index === selectedIndex;
    const count = counts?.[index] ?? null;
    const badge = badges?.[index] ?? null;
    // Everything drawn on the chip is also spoken: a screen reader user gets
    // the count and the `18+` badge, not just the label.
    const spokenDetail = [
      count === null ? null : t('collection.chipCount', { count }),
      badge,
    ].filter((part): part is string => part !== null);
    return (
      <Pressable
        key={`${value}-${index}`}
        role="radio"
        aria-label={[
          `${accessibilityLabel ?? t('common.option')}${t('common.labelSeparator')}${value}`,
          ...spokenDetail,
        ].join(t('common.listSeparator'))}
        aria-checked={selected}
        aria-disabled={!enabled}
        accessibilityState={{ selected, disabled: !enabled }}
        disabled={!enabled}
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={() => {
          onChange?.({
            nativeEvent: { value, selectedSegmentIndex: index },
          });
          onValueChange?.(value);
        }}
        style={({ pressed }) => ({
          // 36dp drawn + 6dp hitSlop top/bottom = 48dp tall; `minWidth`
          // keeps short labels (settings' '30'/'40'/'60') at the 48dp
          // minimum hit area instead of collapsing to ~46dp.
          minHeight: 36,
          minWidth: metrics.minimumHitArea,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          // 12dp (not 14) keeps the collection's three rating chips inside
          // the 336dp usable width of a 360dp screen even with 4-digit
          // counts: 73 + 75 + 121 + 2 gaps of 8 = 285dp.
          paddingHorizontal: 12,
          gap: 6,
          borderWidth: 1,
          borderColor: selected ? theme.text : theme.border,
          borderRadius: metrics.radius.circle,
          backgroundColor: selected ? theme.text : theme.surface,
          opacity: pressed ? 0.7 : 1,
        })}>
        <Text
          numberOfLines={1}
          style={{
            color: selected ? theme.surface : theme.text,
            fontSize: 14,
            fontWeight: selected ? '600' : '500',
          }}>
          {value}
        </Text>
        {count === null ? null : (
          <Text
            numberOfLines={1}
            style={{
              // 12sp is not large text, so AA asks for 4.5:1. theme.textSecondary
              // on theme.surface is only 3.03:1; theme.text at 0.8 opacity blends
              // to #766D6A for 4.75:1 on light and 9.10:1 on dark. (0.72 would
              // still miss at 3.90:1.)
              color: selected ? theme.surfaceSecondary : theme.text,
              opacity: selected ? 1 : 0.8,
              fontSize: 12,
              fontVariant: ['tabular-nums'],
            }}>
            {String(count)}
          </Text>
        )}
        {badge === null ? null : (
          <View
            style={{
              paddingHorizontal: 5,
              paddingVertical: 1,
              borderWidth: 1,
              // The opacity rides the wrapper so the 11sp text and its outline
              // dim together and both stay above 4.5:1 / 3:1.
              borderColor: selected ? theme.surface : theme.text,
              opacity: selected ? 1 : 0.8,
              borderRadius: metrics.radius.circle,
            }}>
            <Text
              numberOfLines={1}
              style={{
                color: selected ? theme.surface : theme.text,
                fontSize: 11,
                fontWeight: '700',
              }}>
              {badge}
            </Text>
          </View>
        )}
      </Pressable>
    );
  });

  const groupStyle = [
    {
      minHeight: metrics.minimumHitArea,
      flexGrow: 0,
      opacity: enabled ? 1 : 0.5,
    },
    style,
  ];

  if (!scrollable) {
    return (
      <View
        testID={testID}
        role="radiogroup"
        aria-label={accessibilityLabel}
        aria-disabled={!enabled}
        accessibilityState={enabled ? undefined : { disabled: true }}
        style={[
          groupStyle,
          {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 2,
            gap: metrics.spacing.small,
          },
        ]}>
        {chips}
      </View>
    );
  }

  return (
    <ScrollView
      {...scrollViewProps}
      testID={testID}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      role="radiogroup"
      aria-label={accessibilityLabel}
      aria-disabled={!enabled}
      accessibilityState={enabled ? undefined : { disabled: true }}
      contentContainerStyle={{
        alignItems: 'center',
        paddingVertical: 2,
        gap: metrics.spacing.small,
      }}
      style={groupStyle}>
      {chips}
    </ScrollView>
  );
}
