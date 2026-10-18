import { Image } from 'expo-image';
import { Check, EyeOff } from 'lucide-react-native';
import { memo, useEffect, useRef } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CloudBadge, isSyncedToCloud } from '@/components/residency-badge';
import { isEntryAdultLike } from '@/features/collection/collection-filter';
import { isTooLargeToAnimate } from '@/features/images/animation-limits';
import { useGifStill } from '@/features/images/use-gif-still';
import { isOnlyInCloud } from '@/features/library/library-render-availability';
import { unavailableCopyFor, type LibraryAccess } from '@/features/library/library-access';
import type { LibraryEntry } from '@/features/library/library-view-model';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import { useTransferProgress } from '@/features/library/library-transfer-progress';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type LibraryAssetTileProps = {
  entry: LibraryEntry;
  /** 1-based grid index for accessibility copy. */
  index: number;
  /** Resolved grid source, or `null` while the bounded window is still resolving. */
  source: LibraryRenderSource | null;
  /**
   * Board #27 + N6-B1 (spec §5.7): when set, renders the local original file
   * directly without a resolve, falling back via `onFastPathFailed` if loading
   * fails.
   */
  fastPathUri?: string | null;
  onFastPathFailed?: () => void;
  /** Board #27 S4 (spec §5.2): the composition's access; absent reads `ready`. */
  libraryAccess?: LibraryAccess;
  /** N6-B1 (spec §4.6): true when mixed-mode NSFW thumbnail blurring is active. */
  blurNsfwThumbnail?: boolean;
  /** N6-B1 (spec §4.8): selection state for this tile. */
  selected?: boolean;
  /** N6-B1 (spec §4.8): true when any collection tile is currently selected. */
  selectionMode?: boolean;
  onOpen: () => void;
  onLongPress?: () => void;
  onToggleSelection?: () => void;
};

/**
 * Digest-keyed library/import tile. Same 3/4 shape, selection contract, and
 * mixed-mode NSFW obscuring (blur for static images, opaque cover for GIFs) as
 * `CollectionTile`, while never accepting a remote URL and never escalating the
 * resolve role to fill a placeholder.
 */
export const LibraryAssetTile = memo(function LibraryAssetTile({
  entry,
  index,
  source,
  fastPathUri = null,
  onFastPathFailed,
  libraryAccess = 'ready',
  blurNsfwThumbnail = false,
  selected = false,
  selectionMode = false,
  onOpen,
  onLongPress,
  onToggleSelection,
}: LibraryAssetTileProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const suppressPressAfterLongPress = useRef(false);
  const synced = isSyncedToCloud(entry);
  // K6-2 (spec §2 G3/G5): this asset is keyed two ways while bytes are moving —
  // by digest when THIS device is uploading it, and by the original's
  // generation id when it is being pulled back down (下凡). The download side
  // is keyed by generation because the transport only ever knows generations;
  // watching the ORIGINAL's id is also what keeps a grid thumbnail fetch from
  // lighting up a ring that is not about the asset the user is waiting for.
  const uploading = useTransferProgress(entry.plaintextSha256);
  const downloading = useTransferProgress(entry.originalGenerationId);
  const progress = uploading ?? downloading;
  const status = progress === 'indeterminate'
    ? t('collection.transferring')
    : progress !== null
      ? t('collection.transferringPercent', { percent: Math.round(progress * 100) })
      : isOnlyInCloud({
        hasLocalOriginal: entry.hasLocalOriginal,
        originalGenerationId: entry.originalGenerationId,
        resolved: source ?? undefined,
      })
        ? t('collection.offlineCloudOnly')
        : !entry.hasLocalOriginal
          ? t('libraryView.missingMessage')
          : synced ? t('collection.syncedToCloud') : t('collection.offlineReady');
  const label = t('libraryView.tileAccessibility', { index, status });
  // A transfer in flight always wins over the badge: the ring IS the
  // "not finished yet" state, and the cloud is what the database says once it
  // is (`library-transfer-progress.ts` is cleared on commit).
  const badge = progress !== null
    ? <CloudBadge progress={progress} />
    : synced ? <CloudBadge /> : null;
  const effectiveSource: LibraryRenderSource | null = fastPathUri !== null
    ? {
        kind: 'file',
        uri: fastPathUri,
        tier: 'local-original',
        role: 'original',
      }
    : source;
  // Board #16 (spec §5.4): a grid source that is the ORIGINAL of a gif too
  // large to animate (the `local-original` tier comes first) is never decoded
  // here; the tile shows its bounded first-frame still. A derived thumbnail is
  // a still already.
  const cutsStill = effectiveSource?.kind === 'file'
    && effectiveSource.role === 'original'
    && effectiveSource.uri.startsWith('file://')
    && isTooLargeToAnimate({ extension: entry.format, byteSize: entry.byteSize });
  const still = useGifStill(cutsStill ? effectiveSource.uri : null, entry.byteSize);
  const stillFastPathMissing = still.missing && fastPathUri !== null;
  useEffect(() => {
    if (stillFastPathMissing) onFastPathFailed?.();
  }, [stillFastPathMissing, onFastPathFailed]);

  // N6-B1 (spec §4.6): `adult` and `unknown` imports are obscured in mixed mode
  // when `模糊 NSFW 缩略图` is on. Static images use `blurRadius={24}`; animated
  // GIFs use the same opaque cover and suppressed animation (`autoplay={false}`)
  // as the provider A1 fix so a GIF can never play in the clear.
  const nsfwBlurred = blurNsfwThumbnail && isEntryAdultLike(entry);
  const isAnimated = entry.format === 'gif';
  const coveredAnimated = nsfwBlurred && isAnimated;

  const handleLongPress = () => {
    if (!onLongPress) return;
    suppressPressAfterLongPress.current = true;
    onLongPress();
  };

  const handlePress = () => {
    if (suppressPressAfterLongPress.current) {
      suppressPressAfterLongPress.current = false;
      return;
    }
    if (selectionMode && onToggleSelection) {
      onToggleSelection();
    } else {
      onOpen();
    }
  };

  const selectionOverlay = selectionMode ? (
    <View
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        inset: 0,
        alignItems: 'flex-end',
        padding: 6,
        borderWidth: selected ? 3 : 0,
        borderColor: theme.save,
        backgroundColor: selected ? 'rgba(0, 0, 0, 0.18)' : 'transparent',
      }}>
      <View
        style={{
          width: 26,
          height: 26,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: metrics.radius.circle,
          borderWidth: 2,
          borderColor: '#FFFFFF',
          backgroundColor: selected ? theme.save : theme.scrim,
        }}>
        {selected ? <Check color="#FFFFFF" size={17} strokeWidth={3} /> : null}
      </View>
    </View>
  ) : null;

  const animatedCover = coveredAnimated ? (
    <View
      testID={`library-asset-tile-cover-${entry.plaintextSha256}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        backgroundColor: theme.surfaceSecondary,
      }}>
      <EyeOff color={theme.textSecondary} size={22} />
      <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600' }}>
        {t('collection.ratingAdult')}
      </Text>
    </View>
  ) : null;

  if (effectiveSource === null || (cutsStill && still.uri === null)) {
    return (
      <Pressable
        testID={`library-asset-tile-${entry.plaintextSha256}`}
        role="button"
        aria-label={label}
        accessibilityHint={selectionMode
          ? t('collection.selectionHint')
          : t('collection.openFullscreenHint')}
        accessibilityState={{ selected }}
        delayLongPress={350}
        onLongPress={handleLongPress}
        onPress={handlePress}
        style={({ pressed }) => ({
          minHeight: 48,
          aspectRatio: 3 / 4,
          overflow: 'hidden',
          position: 'relative',
          backgroundColor: theme.surfaceSecondary,
          opacity: pressed ? 0.72 : 1,
        })}>
        <View
          accessible={false}
          accessibilityLabel={t('libraryView.loadingAccessibility')}
          style={{ width: '100%', height: '100%' }}
        />
        {animatedCover}
        {badge === null ? null : (
          <View style={{ position: 'absolute', right: 7, bottom: 7 }}>
            {badge}
          </View>
        )}
        {selectionOverlay}
      </Pressable>
    );
  }

  if (effectiveSource.kind === 'unavailable') {
    const copy = unavailableCopyFor(effectiveSource.category, libraryAccess);
    return (
      <Pressable
        testID={`library-asset-tile-${entry.plaintextSha256}`}
        role="button"
        aria-label={label}
        accessibilityHint={selectionMode
          ? t('collection.selectionHint')
          : t('collection.openFullscreenHint')}
        accessibilityState={{ selected }}
        accessibilityLiveRegion="polite"
        delayLongPress={350}
        onLongPress={handleLongPress}
        onPress={handlePress}
        style={({ pressed }) => ({
          minHeight: 48,
          aspectRatio: 3 / 4,
          overflow: 'hidden',
          position: 'relative',
          alignItems: 'center',
          justifyContent: 'center',
          padding: metrics.spacing.small,
          backgroundColor: theme.surfaceSecondary,
          opacity: pressed ? 0.72 : 1,
        })}>
        <Text
          testID={`library-asset-${copy.kind}-${entry.plaintextSha256}`}
          numberOfLines={4}
          style={{
            color: theme.textSecondary,
            fontSize: 12,
            fontWeight: '600',
            textAlign: 'center',
          }}>
          {t(copy.title)}
        </Text>
        {badge === null ? null : (
          <View style={{ position: 'absolute', right: 7, bottom: 7 }}>
            {badge}
          </View>
        )}
        {selectionOverlay}
      </Pressable>
    );
  }

  const renderUri = cutsStill ? still.uri! : effectiveSource.uri;
  const recyclingKey = JSON.stringify([
    entry.plaintextSha256,
    renderUri,
    entry.origin ?? 'import',
    entry.importClassification ?? 'unknown',
    nsfwBlurred ? 1 : 0,
  ]);
  return (
    <Pressable
      testID={`library-asset-tile-${entry.plaintextSha256}`}
      role="button"
      aria-label={label}
      accessibilityHint={selectionMode
        ? t('collection.selectionHint')
        : t('collection.openFullscreenHint')}
      accessibilityState={{ selected }}
      delayLongPress={350}
      onLongPress={handleLongPress}
      onPress={handlePress}
      style={({ pressed }) => ({
        minHeight: 48,
        aspectRatio: 3 / 4,
        overflow: 'hidden',
        position: 'relative',
        backgroundColor: theme.surfaceSecondary,
        opacity: pressed ? 0.72 : 1,
      })}>
      <Image
        key={recyclingKey}
        accessible={false}
        accessibilityLabel={t('libraryView.loadingAccessibility')}
        source={{ uri: renderUri }}
        recyclingKey={recyclingKey}
        contentFit="cover"
        cachePolicy="memory-disk"
        // Board #7: Discover's deck prefetch shares Glide's 4 source threads at
        // NORMAL priority, so a grid tile decoding from a file would otherwise
        // queue behind the whole prefetch batch.
        priority="high"
        transition={0}
        blurRadius={nsfwBlurred && !coveredAnimated ? 24 : 0}
        autoplay={!coveredAnimated}
        onError={fastPathUri !== null ? onFastPathFailed : undefined}
        style={{ width: '100%', height: '100%' }}
      />
      {animatedCover}
      <View style={{ position: 'absolute', right: 7, bottom: 7 }}>
        {badge}
      </View>
      {selectionOverlay}
    </Pressable>
  );
});
