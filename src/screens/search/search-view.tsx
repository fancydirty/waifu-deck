import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Search } from 'lucide-react-native';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { ScreenState } from '@/components/screen-state';
import type { SearchHit } from '@/features/search/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { SearchTile } from '@/screens/search/search-tile';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type SearchViewStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'unsupported'
  | 'error';

export type SearchViewProps = {
  query: string;
  hits: SearchHit[];
  status: SearchViewStatus;
  errorMessage: string | null;
  submittedQuery?: string | null;
  favoriteKeys?: readonly string[];
  blurNsfwThumbnails: boolean;
  hasNextPage: boolean;
  isLoadingMore: boolean;
  viewportWidth?: number;
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
  onOpen: (hit: SearchHit, index: number) => void;
  onLoadMore: () => void;
  onSeenThrough?: (count: number) => void;
  /**
   * R8.21: device top inset. The four tabs are headerless (R8.17), so each
   * surface must clear the status bar/cutout itself. Defaults to the live
   * inset; overridable for tests.
   */
  safeAreaTop?: number;
};

export function getSearchColumnCount(width: number): 3 | 5 {
  return width >= 700 ? 5 : 3;
}

function SearchGuidance({
  title,
  message,
  onRetry,
  actionLabel,
  actionAriaLabel,
  actionDisabled = false,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  actionLabel?: string;
  actionAriaLabel?: string;
  actionDisabled?: boolean;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const resolvedActionLabel = actionLabel ?? t('search.actions.retry');
  const resolvedActionAriaLabel = actionAriaLabel ?? t('search.actions.retrySearch');

  return (
    <ScrollView
      contentContainerStyle={{
        minHeight: metrics.stateMinHeight,
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: metrics.spacing.large,
        padding: metrics.contentPadding,
      }}
      keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: 'center', gap: metrics.spacing.small }}>
        <Text
          selectable
          style={{ color: theme.text, fontSize: 18, fontWeight: '600', textAlign: 'center' }}>
          {title}
        </Text>
        <Text
          selectable
          style={{ color: theme.textSecondary, fontSize: 14, textAlign: 'center' }}>
          {message}
        </Text>
      </View>
      {onRetry ? (
        <Pressable
          role="button"
          aria-label={resolvedActionAriaLabel}
          accessibilityState={{ disabled: actionDisabled }}
          disabled={actionDisabled}
          onPress={onRetry}
          style={({ pressed }) => ({
            minWidth: 96,
            minHeight: metrics.minimumHitArea,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: metrics.spacing.large,
            borderRadius: metrics.radius.large,
            backgroundColor: theme.text,
            opacity: actionDisabled ? 0.58 : pressed ? 0.7 : 1,
          })}>
          <Text style={{ color: theme.surface, fontSize: 15, fontWeight: '600' }}>
            {resolvedActionLabel}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

export function SearchView({
  query,
  hits,
  status,
  errorMessage,
  submittedQuery = null,
  favoriteKeys = [],
  blurNsfwThumbnails,
  hasNextPage,
  isLoadingMore,
  viewportWidth,
  onQueryChange,
  onSubmit,
  onOpen,
  onLoadMore,
  onSeenThrough,
  safeAreaTop,
}: SearchViewProps) {
  const theme = useAppThemeColors();
  // R8.17: floating-bar bottom reserve for the results grid.
  const insets = useSafeAreaInsets();
  const topInset = safeAreaTop ?? insets.top;
  const { t } = useAppTranslation();
  const window = useWindowDimensions();
  const columns = getSearchColumnCount(viewportWidth ?? window.width);
  const viewportRef = useRef({ width: 0, height: 0 });
  const scrollYRef = useRef(0);
  const listInstanceRef = useRef<FlashListRef<SearchHit> | null>(null);
  const onSeenThroughRef = useRef(onSeenThrough);
  useLayoutEffect(() => {
    onSeenThroughRef.current = onSeenThrough;
  }, [onSeenThrough]);
  const reportSeen = useCallback((
    width = viewportRef.current.width,
    height = viewportRef.current.height,
  ) => {
    if (width <= 0 || height <= 0) return;
    const rowHeight = width / columns;
    if (rowHeight <= 0) return;
    const lastRow = Math.floor(
      (scrollYRef.current + height - 1) / rowHeight,
    );
    onSeenThroughRef.current?.((lastRow + 2) * columns);
  }, [columns]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    viewportRef.current = { width, height };
    reportSeen(width, height);
  }, [reportSeen]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
    reportSeen();
  }, [reportSeen]);
  const attachListRef = useCallback((instance: FlashListRef<SearchHit> | null) => {
    if (instance === null) {
      listInstanceRef.current = null;
      scrollYRef.current = 0;
      viewportRef.current = { width: 0, height: 0 };
      return;
    }
    if (instance !== listInstanceRef.current) {
      listInstanceRef.current = instance;
      scrollYRef.current = instance.getAbsoluteLastScrollOffset();
      viewportRef.current = { width: 0, height: 0 };
    }
  }, []);
  useEffect(() => {
    reportSeen();
  }, [hits, reportSeen]);
  const [showEmptyHint, setShowEmptyHint] = useState(false);
  const trimmedQuery = query.trim();
  // R8.29: only the loading-duplicate case blocks the button. An empty query
  // stays pressable so the tap can surface the hint instead of a dead no-op.
  const submitBusy = status === 'loading' && trimmedQuery === submittedQuery;
  const favoriteKeySet = new Set(favoriteKeys);
  const canLoadMore = hasNextPage && !isLoadingMore;

  const submit = () => {
    if (submitBusy) return;
    if (trimmedQuery.length === 0) {
      setShowEmptyHint(true);
      return;
    }
    setShowEmptyHint(false);
    onSubmit();
  };
  const changeQuery = (next: string) => {
    if (next.trim().length > 0) setShowEmptyHint(false);
    onQueryChange(next);
  };
  const loadMore = () => {
    if (canLoadMore) onLoadMore();
  };

  let content = null;
  if (status === 'idle' && hits.length === 0) {
    content = (
      <SearchGuidance
        title={t('search.idle.title')}
        message={t('search.idle.message')}
      />
    );
  } else if (status === 'loading' && hits.length === 0) {
    content = (
      <ScreenState
        kind="loading"
        title={t('search.loading.title')}
        message={t('search.loading.message')}
      />
    );
  } else if (status === 'empty' && hits.length === 0) {
    content = (
      <SearchGuidance
        title={t(hasNextPage ? 'search.empty.pageTitle' : 'search.empty.title', {
          query: submittedQuery ?? query.trim(),
        })}
        message={hasNextPage
          ? t('search.empty.morePagesMessage')
          : t('search.empty.relatedMessage')}
        onRetry={hasNextPage ? onLoadMore : undefined}
        actionLabel={t(isLoadingMore
          ? 'search.actions.continuing'
          : 'search.actions.continue')}
        actionAriaLabel={t('search.actions.continueResults')}
        actionDisabled={isLoadingMore}
      />
    );
  } else if (status === 'unsupported' && hits.length === 0) {
    content = (
      <SearchGuidance
        title={t('search.unsupported.title')}
        message={t('search.unsupported.message')}
      />
    );
  } else if (status === 'error' && hits.length === 0) {
    content = (
      <ScreenState
        kind="error"
        title={t('search.errors.title')}
        message={errorMessage ?? t('search.errors.message')}
        onRetry={onSubmit}
        retryLabel={t('search.actions.retry')}
      />
    );
  } else {
    content = (
      <FlashList
        key={`search-${columns}`}
        ref={attachListRef}
        // R8.17: the floating tab bar overlays this grid; reserve so the tail
        // rows can always scroll out from under it.
        contentContainerStyle={{ paddingBottom: tabBarContentInset(insets.bottom) }}
        testID="search-results"
        aria-label={t('search.results.grid')}
        data={hits}
        numColumns={columns}
        onLayout={onLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyExtractor={(hit) => hit.key}
        extraData={{ favoriteKeys, blurNsfwThumbnails }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={loadMore}
        onEndReachedThreshold={0.35}
        ListFooterComponent={hasNextPage ? (
          <Pressable
            role="button"
            aria-label={t(isLoadingMore
              ? 'search.results.loadingMoreAccessibility'
              : 'search.results.loadMoreAccessibility')}
            accessibilityState={{ disabled: isLoadingMore }}
            disabled={isLoadingMore}
            onPress={loadMore}
            style={({ pressed }) => ({
              minHeight: 56,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: metrics.spacing.small,
              opacity: isLoadingMore ? 0.58 : pressed ? 0.68 : 1,
            })}>
            {isLoadingMore ? <ActivityIndicator color={theme.textSecondary} /> : null}
            <Text style={{ color: theme.textSecondary, fontSize: 14, fontWeight: '600' }}>
              {t(isLoadingMore ? 'search.results.loading' : 'search.results.loadMore')}
            </Text>
          </Pressable>
        ) : null}
        renderItem={({ item, index }) => (
          <View style={{ flex: 1, padding: 1 }}>
            <SearchTile
              hit={item}
              isFavorite={favoriteKeySet.has(item.key)}
              blurNsfwThumbnail={blurNsfwThumbnails}
              onPress={() => onOpen(item, index)}
            />
          </View>
        )}
      />
    );
  }

  return (
    <View testID="screen-search" style={{ flex: 1, paddingTop: topInset, backgroundColor: theme.surface }}>
      <View
        aria-label={t('search.toolbar.label')}
        style={{
          minHeight: 64,
          flexDirection: 'row',
          alignItems: 'center',
          gap: metrics.spacing.small,
          paddingHorizontal: metrics.spacing.medium,
          paddingVertical: metrics.spacing.small,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        }}>
        <TextInput
          testID="search-input"
          aria-label={t('search.toolbar.inputLabel')}
          value={query}
          onChangeText={changeQuery}
          onSubmitEditing={submit}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          // R8.29: on Android a pinyin IME strands typed Latin letters in the
          // candidate bar, so the field never sees them. visible-password forces
          // an ASCII/QWERTY layout with no composing region.
          keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
          placeholder={t('search.toolbar.placeholder')}
          placeholderTextColor={theme.textSecondary}
          selectionColor={theme.save}
          style={{
            minWidth: 0,
            minHeight: metrics.minimumHitArea,
            flex: 1,
            paddingHorizontal: metrics.spacing.large,
            paddingVertical: metrics.spacing.small,
            borderWidth: 1.5,
            borderColor: theme.border,
            borderRadius: 999,
            backgroundColor: theme.surfaceSecondary,
            color: theme.text,
            fontSize: 16,
          }}
        />
        <Pressable
          testID="search-submit"
          role="button"
          aria-label={t('search.toolbar.submit')}
          accessibilityState={{ disabled: submitBusy }}
          disabled={submitBusy}
          onPress={submit}
          style={({ pressed }) => ({
            minWidth: 78,
            minHeight: metrics.minimumHitArea,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingHorizontal: metrics.spacing.medium,
            borderRadius: 999,
            backgroundColor: theme.save,
            opacity: submitBusy ? 0.38 : pressed ? 0.7 : 1,
          })}>
          <Search color={theme.surface} size={18} strokeWidth={2.3} />
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{ color: theme.surface, fontSize: 15, fontWeight: '700' }}>
            {t('search.toolbar.button')}
          </Text>
        </Pressable>
      </View>

      {showEmptyHint ? (
        <Text
          testID="search-empty-hint"
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            paddingHorizontal: metrics.spacing.large,
            paddingTop: 4,
          }}>
          {t('search.emptyHint')}
        </Text>
      ) : null}

      {content}
    </View>
  );
}
