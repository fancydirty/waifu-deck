import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { ExternalLink, Heart, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  View,
  type ViewToken,
  useWindowDimensions,
} from 'react-native';

import { useRemoteLoadRetry } from '@/components/use-remote-load-retry';
import { providerImageSource } from '@/features/providers/provider-image-source';
import { providerLabel } from '@/features/providers/provider-label';
import type { SearchHit } from '@/features/search/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { metrics } from '@/theme/metrics';
import { setModalStatusBarStyle } from '../../../modules/waifu-sync-service';

type SafeInsets = { top: number; bottom: number };

export type SearchDetailModalProps = {
  visible: boolean;
  hits: SearchHit[];
  initialIndex: number;
  favoriteKeys?: readonly string[];
  savingKeys?: readonly string[];
  safeInsets?: SafeInsets;
  viewportWidth?: number;
  onClose: () => void;
  onToggleFavorite: (hit: SearchHit) => void;
  onOpenSource: (hit: SearchHit) => void;
  onIndexChange?: (index: number, hit: SearchHit) => void;
};

type DetailCommandProps = {
  label: string;
  visibleLabel: string;
  disabled?: boolean;
  selected?: boolean;
  onPress: () => void;
  children: React.ReactNode;
};

function DetailCommand({
  label,
  visibleLabel,
  disabled = false,
  selected,
  onPress,
  children,
}: DetailCommandProps) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 82,
        minHeight: metrics.minimumHitArea,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: metrics.spacing.medium,
        opacity: disabled ? 0.4 : pressed ? 0.66 : 1,
      })}>
      {children}
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>
        {visibleLabel}
      </Text>
    </Pressable>
  );
}

function boundedIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

/**
 * One pager page. Extracted from `renderItem` so the per-page retry state is a
 * real component with its own hooks rather than a call inside a render callback.
 *
 * R8.24: the page shows the grid's already-cached sample as the placeholder
 * while the original streams, and retries the original with bounded backoff so
 * a stalled fetch no longer leaves a permanently black page.
 */
function SearchDetailPage({
  hit,
  index,
  pageWidth,
}: {
  hit: SearchHit;
  index: number;
  pageWidth: number;
}) {
  const { t } = useAppTranslation();
  const { attempt, scheduleRetry } = useRemoteLoadRetry(hit.image.remoteUrl);
  const imageKey = JSON.stringify([hit.key, attempt]);
  // R8.28: both the original and the placeholder are network loads against the
  // provider's CDN, so both need that provider's declared headers (Gelbooru's
  // Referer). Headerless sources keep their exact `{ uri }` objects.
  const providerKey = hit.image.providerKey;

  return (
    <View style={{ width: pageWidth, flex: 1 }}>
      <Image
        key={imageKey}
        accessible
        accessibilityLabel={t('search.detail.originalImage', { index: index + 1 })}
        source={providerImageSource(hit.image.remoteUrl, providerKey)}
        // Only when the grid preview is a distinct (smaller) image: for
        // sources without a sample the preview IS the original, and a
        // same-URL placeholder would decode it twice.
        placeholder={hit.previewUrl !== hit.image.remoteUrl
          ? providerImageSource(hit.previewUrl, providerKey)
          : undefined}
        placeholderContentFit={hit.previewUrl !== hit.image.remoteUrl ? 'contain' : undefined}
        recyclingKey={imageKey}
        contentFit="contain"
        cachePolicy="memory-disk"
        transition={0}
        onError={scheduleRetry}
        style={{ width: '100%', height: '100%' }}
      />
    </View>
  );
}

export function SearchDetailModal({
  visible,
  hits,
  initialIndex,
  favoriteKeys = [],
  savingKeys = [],
  safeInsets = { top: 0, bottom: 0 },
  viewportWidth,
  onClose,
  onToggleFavorite,
  onOpenSource,
  onIndexChange,
}: SearchDetailModalProps) {
  const { t } = useAppTranslation();
  const window = useWindowDimensions();
  const pageWidth = viewportWidth ?? window.width;
  const initialHitKey = hits[boundedIndex(initialIndex, hits.length)]?.key ?? null;
  const [currentHitKey, setCurrentHitKey] = useState<string | null>(initialHitKey);
  const [openRequest, setOpenRequest] = useState({ visible, initialHitKey });
  const pagerRef = useRef<FlatList<SearchHit>>(null);

  if (
    openRequest.visible !== visible ||
    (visible && openRequest.initialHitKey !== initialHitKey)
  ) {
    setOpenRequest({ visible, initialHitKey });
    if (visible && currentHitKey !== initialHitKey) setCurrentHitKey(initialHitKey);
  }

  const fallbackIndex = boundedIndex(initialIndex, hits.length);
  const keyedIndex = hits.findIndex((hit) => hit.key === currentHitKey);
  const currentIndex = keyedIndex >= 0 ? keyedIndex : fallbackIndex;
  const current = hits[currentIndex] ?? null;
  const favoriteKeySet = new Set(favoriteKeys);
  const savingKeySet = new Set(savingKeys);
  const isFavorite = current ? favoriteKeySet.has(current.key) : false;
  const isSaving = current ? savingKeySet.has(current.key) : false;

  const selectPage = useCallback((index: number) => {
    const nextIndex = boundedIndex(index, hits.length);
    const next = hits[nextIndex];
    if (!next) return;
    setCurrentHitKey(next.key);
    onIndexChange?.(nextIndex, next);
  }, [hits, onIndexChange]);

  const updateVisibleImage = useCallback((info: { viewableItems: ViewToken<SearchHit>[] }) => {
    const visibleHit = info.viewableItems.find((item) => item.isViewable !== false)?.item;
    if (!visibleHit) return;
    const index = hits.findIndex((hit) => hit.key === visibleHit.key);
    if (index >= 0) selectPage(index);
  }, [hits, selectPage]);

  const syncModalStatusBar = useCallback(() => {
    setModalStatusBarStyle('light');
  }, []);

  useEffect(() => {
    if (!visible) return;
    syncModalStatusBar();
  }, [visible, syncModalStatusBar]);

  return (
    <Modal
      testID="search-detail-modal"
      visible={visible}
      animationType="none"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onShow={syncModalStatusBar}
      onRequestClose={onClose}>
      {/* N8: the modal is black in both themes, so the root bar's
          scheme-following icons would go dark over it in light mode. Mounted
          only while visible so last-mount-wins fires on open and restores the
          root bar on close; setModalStatusBarStyle also clears
          LIGHT_STATUS_BARS on ReactModalHostView's own Android Dialog window. */}
      {visible ? <StatusBar style="light" /> : null}
      <View
        aria-label={t('search.detail.gallery')}
        style={{ flex: 1, backgroundColor: '#000000' }}>
        <View
          aria-label={t('search.detail.topActions')}
          style={{
            minHeight: safeInsets.top + 56,
            paddingTop: safeInsets.top,
            paddingHorizontal: metrics.spacing.small,
            justifyContent: 'center',
            backgroundColor: '#000000',
          }}>
          <Pressable
            role="button"
            aria-label={t('search.detail.close')}
            onPress={onClose}
            style={({ pressed }) => ({
              width: metrics.minimumHitArea,
              height: metrics.minimumHitArea,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.66 : 1,
            })}>
            <X color="#FFFFFF" size={26} strokeWidth={2.3} />
          </Pressable>
        </View>

        {current ? (
          <>
            <View style={{ flex: 1, overflow: 'hidden' }}>
              <FlatList
                ref={pagerRef}
                testID="search-detail-pager"
                aria-label={t('search.detail.pager')}
                data={hits}
                horizontal
                pagingEnabled
                disableIntervalMomentum
                decelerationRate="fast"
                snapToInterval={pageWidth}
                scrollEnabled={hits.length > 1}
                showsHorizontalScrollIndicator={false}
                initialScrollIndex={currentIndex}
                initialNumToRender={Math.min(3, hits.length)}
                maxToRenderPerBatch={3}
                windowSize={3}
                removeClippedSubviews={false}
                getItemLayout={(_data, index) => ({
                  index,
                  length: pageWidth,
                  offset: pageWidth * index,
                })}
                keyExtractor={(hit) => hit.key}
                onViewableItemsChanged={updateVisibleImage}
                onMomentumScrollEnd={(event) => {
                  selectPage(Math.round(
                    event.nativeEvent.contentOffset.x / Math.max(1, pageWidth),
                  ));
                }}
                renderItem={({ item, index }) => (
                  <SearchDetailPage hit={item} index={index} pageWidth={pageWidth} />
                )}
              />
            </View>

            <View
              aria-label={t('search.detail.infoAndCommands')}
              style={{
                gap: 4,
                paddingTop: metrics.spacing.small,
                paddingBottom: safeInsets.bottom + 4,
                borderTopWidth: 1,
                borderTopColor: 'rgba(255, 255, 255, 0.14)',
                backgroundColor: '#000000',
              }}>
              <Text
                selectable
                numberOfLines={1}
                style={{
                  paddingHorizontal: metrics.spacing.medium,
                  color: '#D2D3D5',
                  fontSize: 13,
                  fontVariant: ['tabular-nums'],
                }}>
                {t('search.detail.metadata', {
                  width: current.image.width,
                  height: current.image.height,
                  provider: providerLabel(current.image.providerKey),
                  current: currentIndex + 1,
                  total: hits.length,
                })}
              </Text>
              <View
                aria-label={t('search.detail.commands')}
                style={{
                  minHeight: 56,
                  flexDirection: 'row',
                  alignItems: 'stretch',
                  justifyContent: 'space-around',
                  paddingHorizontal: 4,
                }}>
                <DetailCommand
                  label={t(isFavorite
                    ? 'search.detail.savedAction'
                    : 'search.detail.saveAction')}
                  visibleLabel={t(isSaving
                    ? 'search.detail.saving'
                    : isFavorite
                      ? 'search.detail.saved'
                      : 'search.detail.save')}
                  disabled={isSaving || isFavorite}
                  selected={isFavorite}
                  onPress={() => onToggleFavorite(current)}>
                  {isSaving ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Heart
                      color="#FFFFFF"
                      fill={isFavorite ? '#FFFFFF' : 'transparent'}
                      size={21}
                      strokeWidth={2.2}
                    />
                  )}
                </DetailCommand>
                <DetailCommand
                  label={t('search.detail.openSource')}
                  visibleLabel={t('search.detail.source')}
                  disabled={!current.image.sourceUrl}
                  onPress={() => onOpenSource(current)}>
                  <ExternalLink color="#FFFFFF" size={21} strokeWidth={2.2} />
                </DetailCommand>
              </View>
            </View>
          </>
        ) : (
          <View
            aria-label={t('search.detail.unavailableLabel')}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text selectable style={{ color: '#D2D3D5', fontSize: 15 }}>
              {t('search.detail.unavailableMessage')}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
