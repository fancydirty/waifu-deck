import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ban, Check, Plus, Search, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { normalizeProviderTag } from '@/features/providers/candidate-filter';
import { isBlockableTagSlug } from '@/features/settings/settings';
import type { TagSuggestionFetcher } from '@/features/tags/danbooru-tag-suggestions';
import { formatTagCount } from '@/features/tags/format-tag-count';
import { useTagSuggestions } from '@/features/tags/use-tag-suggestions';
import type { AppLanguage } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { fontFamilies, settingsTypography } from '@/theme/typography';

/**
 * R8.22 (owner 2026-09-09): an exclude-only, search-to-block editor. The user
 * types a tag (furry), suggestions or a raw row appear, and one tap blocks it.
 * Excluded tags are provider slugs persisted verbatim in `excludedTags` and
 * enforced as a home hard filter by every source engine (`-tag` in booru
 * queries + the local candidate filter). No include mode.
 */
type TagPickerSheetProps = {
  visible: boolean;
  disabled?: boolean;
  excludedTags: readonly string[];
  /** Toggle the exact stored spelling, or add a new provider tag. */
  onToggle(slug: string): void;
  onClose(): void;
  fetchSuggestions?: TagSuggestionFetcher;
  /**
   * R8.21: overrides the device's top safe-area inset (status bar / cutout).
   * Defaults to `useSafeAreaInsets().top`; tests pass a fixed value instead
   * of standing up a `SafeAreaProvider`.
   */
  safeAreaTop?: number;
};

/**
 * Offer raw input unless a suggestion or stored tag already handles its key.
 * An already-excluded tag must never get a raw row: that would re-arm
 * `onToggle` as an accidental unblock. Removal belongs to its chip or a
 * checked suggestion row, which toggles the exact stored variant.
 */
export function rawBlockCandidate(
  search: string,
  suggestionKeys: ReadonlySet<string>,
  excludedKeys: ReadonlySet<string>,
): string | null {
  // Literal normalization only (lowercase, spaces/hyphens → _), matching the
  // exclusion filter. Never taxonomy aliases: those rewrote "waifu" to "girl".
  const slug = normalizeProviderTag(search);
  if (slug.length === 0 || !isBlockableTagSlug(slug)) return null;
  if (suggestionKeys.has(slug) || excludedKeys.has(slug)) return null;
  return slug;
}

export function TagPickerSheet({
  visible,
  disabled = false,
  excludedTags,
  onToggle,
  onClose,
  fetchSuggestions,
  safeAreaTop,
}: TagPickerSheetProps) {
  const theme = useAppThemeColors();
  const insets = useSafeAreaInsets();
  const topInset = safeAreaTop ?? insets.top;
  const { t, i18n } = useAppTranslation();
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const { status, suggestions } = useTagSuggestions(search, { enabled: visible, fetch: fetchSuggestions });
  const suggestionKeys = new Set(suggestions.map((tag) => tag.key));
  const excludedKeys = new Set(excludedTags.map(normalizeProviderTag));
  const rawCandidate = rawBlockCandidate(search, suggestionKeys, excludedKeys);
  const prefix = search.trim().toLowerCase();
  const furryExcluded = excludedTags.some((tag) => normalizeProviderTag(tag) === 'furry');

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}>
      <View testID="tag-picker-sheet" style={{ flex: 1, backgroundColor: theme.surface, paddingTop: topInset }}>
        <View style={{
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: metrics.spacing.small,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        }}>
          <View style={{ width: 48 }} />
          <Text style={[settingsTypography.sheetTitle, { flex: 1, color: theme.text, textAlign: 'center' }]}>
            {t('settings.tagPicker.title')}
          </Text>
          <Pressable
            role="button"
            aria-label={t('settings.tagPicker.close')}
            onPress={onClose}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}>
            <X color={theme.text} size={23} />
          </Pressable>
        </View>

        <View style={{ padding: metrics.spacing.medium, gap: metrics.spacing.medium }}>
          <View style={{
            minHeight: metrics.minimumHitArea,
            flexDirection: 'row',
            alignItems: 'center',
            gap: metrics.spacing.small,
            paddingHorizontal: metrics.spacing.medium,
            borderWidth: metrics.settingsFieldBorderWidth,
            borderColor: searchFocused ? theme.save : theme.border,
            borderRadius: metrics.settingsRadius.field,
          }}>
            <Search color={theme.textSecondary} size={20} />
            <TextInput
              aria-label={t('settings.tagPicker.search')}
              value={search}
              onChangeText={setSearch}
              placeholder={t('settings.tagPicker.search')}
              placeholderTextColor={theme.textSecondary}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              style={[settingsTypography.dialogInput, { flex: 1, minHeight: metrics.minimumHitArea, color: theme.text }]}
            />
          </View>
          {excludedTags.length > 0 ? (
            <Text style={{ color: theme.textSecondary, fontSize: 13, fontFamily: fontFamilies.sans }}>
              {t('settings.tagPicker.excludedCount', { count: excludedTags.length })}
            </Text>
          ) : (
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
              {t('settings.tagPicker.blockedEmpty')}
            </Text>
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: metrics.spacing.small }}>
            {excludedTags.map((slug) => (
              <Pressable
                key={slug}
                role="button"
                aria-label={t('settings.tagPicker.removeBlocked', { tag: slug })}
                disabled={disabled}
                accessibilityState={{ disabled }}
                onPress={() => onToggle(slug)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: metrics.settingsChip.gap,
                  paddingTop: metrics.settingsChip.paddingV,
                  paddingBottom: metrics.settingsChip.paddingV,
                  paddingLeft: metrics.settingsChip.paddingLeft,
                  paddingRight: metrics.settingsChip.paddingRight,
                  borderRadius: metrics.radius.circle,
                  minHeight: metrics.settingsChip.minTouch,
                  backgroundColor: theme.saveSoft,
                  opacity: disabled ? 0.6 : pressed ? 0.62 : 1,
                })}>
                <Text style={[settingsTypography.chipLabel, { color: theme.saveDeep }]}>{slug}</Text>
                <X color={theme.saveDeep} size={metrics.settingsChip.iconSize} />
              </Pressable>
            ))}
          </View>
          {furryExcluded ? (
            <Text selectable style={{ color: theme.textSecondary, fontSize: 13 }}>
              {t('settings.provider.furryBlocked')}
            </Text>
          ) : null}
        </View>

        <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
          {rawCandidate !== null ? (
            <Pressable
              role="button"
              aria-label={t('settings.tagPicker.blockRaw', { tag: rawCandidate })}
              disabled={disabled}
              accessibilityState={{ disabled }}
              onPress={() => onToggle(rawCandidate)}
              style={({ pressed }) => ({
                minHeight: metrics.settingsSheet.rowMinHeight,
                flexDirection: 'row',
                alignItems: 'center',
                gap: metrics.settingsSheet.rowContentGap,
                paddingHorizontal: metrics.settingsSheet.rowPaddingH,
                paddingVertical: metrics.settingsSheet.rowPaddingV,
                borderBottomWidth: 1,
                borderBottomColor: theme.border,
                opacity: disabled ? 0.6 : pressed ? 0.62 : 1,
              })}>
              <Ban color={theme.textSecondary} size={20} />
              <Text style={[settingsTypography.rowTitle, { flex: 1, color: theme.text }]}>
                {t('settings.tagPicker.blockRaw', { tag: rawCandidate })}
              </Text>
            </Pressable>
          ) : null}
          {suggestions.map((tag) => {
            const storedTag = excludedTags.find((stored) => normalizeProviderTag(stored) === tag.key);
            const checked = storedTag !== undefined;
            const prefixLength = tag.value.startsWith(prefix) ? prefix.length : 0;
            return (
              <Pressable
                key={tag.key}
                role="checkbox"
                aria-label={tag.value}
                disabled={disabled}
                accessibilityState={{ checked, disabled }}
                onPress={() => onToggle(storedTag ?? tag.value)}
                style={({ pressed }) => ({
                  minHeight: metrics.settingsSheet.rowMinHeight,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: metrics.settingsSheet.rowContentGap,
                  paddingHorizontal: metrics.settingsSheet.rowPaddingH,
                  paddingVertical: metrics.settingsSheet.rowPaddingV,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.border,
                  opacity: disabled ? 0.6 : pressed ? 0.62 : 1,
                })}>
                <Text style={{
                  flex: 1,
                  color: theme.text,
                  ...settingsTypography.rowTitle,
                  fontFamily: fontFamilies.mono,
                }}>
                  <Text style={{ color: theme.saveDeep }}>{tag.value.slice(0, prefixLength)}</Text>
                  {tag.value.slice(prefixLength)}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, fontFamily: fontFamilies.sansMedium }}>
                  {formatTagCount(tag.postCount, i18n.language as AppLanguage)}
                </Text>
                {checked ? <Check color={theme.save} size={22} /> : <Plus color={theme.textSecondary} size={22} />}
              </Pressable>
            );
          })}
          {status === 'loading' && suggestions.length === 0 ? (
            <ActivityIndicator color={theme.textSecondary} style={{ margin: metrics.spacing.medium }} />
          ) : null}
          {status === 'error' ? (
            <Text selectable style={{
              color: theme.textSecondary,
              fontSize: 13,
              fontFamily: fontFamilies.sansMedium,
              padding: metrics.contentPadding,
            }}>
              {t('settings.tagPicker.suggestionsUnavailable')}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
