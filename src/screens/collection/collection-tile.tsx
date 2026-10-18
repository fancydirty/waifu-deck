import { Image } from 'expo-image';
import type { TFunction } from 'i18next';
import { Check, EyeOff } from 'lucide-react-native';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { isTooLargeToAnimate } from '@/features/images/animation-limits';
import type { StoredImage } from '@/features/images/image-repository';
import { useGifStill } from '@/features/images/use-gif-still';
import type { LibraryObjectRole } from '@/features/library/library-actions-types';
import { providerImageSource } from '@/features/providers/provider-image-source';
import { CloudBadge } from '@/components/residency-badge';
import { useRemoteLoadRetry } from '@/components/use-remote-load-retry';
import { useTransferProgress, type TransferProgressView } from '@/features/library/library-transfer-progress';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type CollectionTileProps = {
  image: StoredImage;
  selected: boolean;
  selectionMode: boolean;
  blurNsfwThumbnail: boolean;
  onOpen: () => void;
  onLongPress: () => void;
  onToggleSelection: () => void;
  /**
   * Board #27 (spec §5.5 rule 3): called with the local file the tile failed
   * to load, so a row the library took over since this snapshot is left alone.
   */
  onLocalFileMissing: (observedUri: string) => boolean | void | Promise<boolean | void>;
  /**
   * Direct-only library override. When present it replaces the tile's source,
   * so a collected asset whose local original was freed renders from the
   * authenticated Cloud Vault thumbnail instead of the provider URL. Absent in
   * Store builds and in every existing call site, which keeps the accepted
   * local behaviour byte-for-byte unchanged.
   */
  overrideSourceUri?: string | null;
  /**
   * Board #16: which library object `overrideSourceUri` is. A derived
   * thumbnail is a still already; the original of a too-large gif is cut to
   * its first frame. Unknown (null) is treated as the original.
   */
  overrideSourceRole?: LibraryObjectRole | null;
  /**
   * True while the library resolver owns this row but has not answered yet.
   * The tile then keeps its colour block and mounts no image at all: the
   * provider sample it used to show in that gap was a network fetch for bytes
   * already on disk, followed by a remount a few ms later (2026-09-16 phone
   * report: tiles slow to fill after a scroll).
   */
  overridePending?: boolean;
  /**
   * Board #27 (spec §5.7): set only when `overrideSourceUri` is the entry's
   * local original (the fast path). Its load failing — or, for a gif too large
   * to animate, its still coming back missing — hands the row to the resolver.
   * It may fire on every render while the failure stands; the screen keeps it
   * to once per digest.
   */
  onOverrideFailed?: () => void;
  /** K3: true when the asset is protected (its original is in the user's cloud). */
  synced?: boolean;
  /** Board #27 S4 (spec §5.15): a `mirrored` row whose original is only in the cloud. */
  onlyInCloud?: boolean;
  /**
   * K6-2 (spec §2 G3): this row's library identity, when it has one. The tile
   * subscribes to both keys `library-transfer-progress.ts` uses — the digest
   * while THIS device uploads the asset, the original's generation id while it
   * is coming back down — so the ring is real bytes for this image and nothing
   * else. A collection row with no library entry passes neither and subscribes
   * to nothing.
   */
  libraryDigest?: string | null;
  libraryOriginalGenerationId?: string | null;
  /**
   * K2b: true when this row's `mirrored` bytes are known-unreachable in the
   * library (no local original, resolver reports unavailable). Only then does
   * a mirrored row read as broken/repairable.
   */
  libraryUnavailable?: boolean;
};

function downloadBadge(image: StoredImage, t: TFunction, libraryUnavailable: boolean): string | null {
  if (image.downloadState === 'pending') return t('collection.badgeSaving');
  // Board #5: the booru answered 404/410, so the bytes are gone for good.
  // "需修复" would promise a retry that can only fail again.
  if (image.downloadState === 'failed' && image.downloadErrorKind === 'source_gone') {
    return t('collection.badgeSourceGone');
  }
  if (image.downloadState === 'failed') return t('collection.badgeNeedsRepair');
  // K2b: a mirrored row is only broken when the library cannot serve it.
  if (image.downloadState === 'mirrored' && libraryUnavailable) return t('collection.badgeNeedsRepair');
  // K6-5 C: the download succeeded and the file is here, but the private
  // library refused it. Before this the tile said nothing at all — an ordinary
  // "available offline" image with no ring, no cloud, and no way to act, which
  // is how 40 of the owner's saves went missing from the bucket unnoticed.
  if (image.downloadState === 'ready' && image.libraryError !== null) {
    return t('collection.badgeLibraryFailed');
  }
  return null;
}

function collectionTileLabel(
  image: StoredImage,
  t: TFunction,
  libraryUnavailable: boolean,
  synced: boolean,
  onlyInCloud: boolean,
  progress: TransferProgressView | null,
): string {
  const artist = image.artistName ?? t('collection.unknownArtist');
  const rating = image.isNsfw
    ? t('collection.ratingAdult')
    : t('collection.ratingStandard');
  const offlineState = image.downloadState === 'failed'
    // Board #5: the badge and the screen reader agree — a source the booru
    // deleted is unavailable, not repairable.
    ? (image.downloadErrorKind === 'source_gone'
      ? t('collection.offlineSourceGone')
      : t('collection.offlineNeedsRepair'))
    : image.downloadState === 'pending'
      ? t('collection.offlineSaving')
      : image.downloadState === 'mirrored'
        // K2: bytes are the library's (mirrorDown keeps a local original).
        ? (libraryUnavailable
          ? t('collection.offlineNeedsRepair')
          : onlyInCloud ? t('collection.offlineCloudOnly') : t('collection.offlineReady'))
        // K6-5 C: the badge and the screen reader have to agree — announcing
        // "available offline" for a row the library never took is the same lie
        // the blank tile told.
        : image.downloadState === 'ready' && image.libraryError !== null
          ? t('collection.badgeLibraryFailed')
          : image.downloadState === 'ready' && image.localUri
            ? t('collection.offlineReady')
            : t('collection.onlineOnly');
  const base = t(
    synced ? 'collection.tileAccessibilitySynced' : 'collection.tileAccessibility',
    { id: image.id, artist, rating, offlineState },
  );
  // K6-2: the badge is decorative, so the only place a screen reader can learn
  // the real percentage is here.
  if (progress === null) return base;
  if (progress === 'indeterminate') return `${base}, ${t('collection.transferring')}`;
  return `${base}, ${t('collection.transferringPercent', {
    percent: Math.round(progress * 100),
  })}`;
}

/**
 * K7 ⑥: the collection grid re-renders whenever anything above it moves (a
 * resolve settling, a selection, a filter). Without memo every visible tile
 * re-ran its whole body — expo-image source assembly, two transfer-progress
 * subscriptions, the accessibility label — for rows that did not change.
 */
export const CollectionTile = memo(function CollectionTile({
  image,
  selected,
  selectionMode,
  blurNsfwThumbnail,
  onOpen,
  onLongPress,
  onToggleSelection,
  onLocalFileMissing,
  overrideSourceUri = null,
  overrideSourceRole = null,
  overridePending = false,
  onOverrideFailed,
  synced = false,
  onlyInCloud = false,
  libraryDigest = null,
  libraryOriginalGenerationId = null,
  libraryUnavailable = false,
}: CollectionTileProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const suppressPressAfterLongPress = useRef(false);
  const repairInFlightKeys = useRef(new Set<string>());
  const [failedLocalKey, setFailedLocalKey] = useState<string | null>(null);
  const overrideUri = typeof overrideSourceUri === 'string' && overrideSourceUri.length > 0
    ? overrideSourceUri
    : null;
  const localImageKey = image.localUri
    ? JSON.stringify([image.id, image.localUri])
    : null;
  const useLocalUri = overrideUri === null
    && localImageKey !== null
    && failedLocalKey !== localImageKey;
  // R8.19: while there is no local file, render the medium sample the deck
  // already fetched and disk-cached instead of re-downloading the multi-megabyte
  // original, which is what left saving tiles on their dominant colour.
  const fileUri = overrideUri ?? (useLocalUri ? image.localUri! : null);
  // Board #16 (spec §5.4): a gif too large to animate never has its own file
  // decoded here — Glide reads the whole gif even at tile size (~93 MB of Java
  // heap for row 44). The tile shows the bounded first-frame still instead, and
  // mounts no image while it is being cut. A remote source keeps today's path.
  const cutsStill = fileUri !== null
    && isTooLargeToAnimate(image)
    && (overrideUri === null || overrideSourceRole !== 'thumbnail');
  const still = useGifStill(cutsStill ? fileUri : null, image.byteSize);
  const sourceUri = cutsStill
    ? still.uri ?? fileUri
    : fileUri ?? image.sampleUrl ?? image.remoteUrl;
  // R8.28: only the provider's own remote bytes get the provider's headers.
  // A local file:// or a library-resolver override is already ours — a Referer
  // there would be meaningless, so those keep their bare `{ uri }`.
  const isProviderRemote = overrideUri === null && !useLocalUri;
  const source = isProviderRemote
    ? providerImageSource(sourceUri, image.providerKey)
    : { uri: sourceUri };
  const { attempt, scheduleRetry } = useRemoteLoadRetry(sourceUri);
  const renderKey = JSON.stringify([image.id, sourceUri, attempt]);
  const badge = downloadBadge(image, t, libraryUnavailable);
  // K6-2: a transfer in flight wins over the cloud — the ring IS the
  // "not finished yet" state, and the cloud is what the database says once the
  // commit lands and the store is cleared.
  const uploading = useTransferProgress(libraryDigest);
  const downloading = useTransferProgress(libraryOriginalGenerationId);
  const progress = uploading ?? downloading;
  const nsfwBlurred = blurNsfwThumbnail && image.isNsfw;
  // A1 (owner phone 2026-09-15): a Glide blur is a bitmap transformation, and
  // an animated GifDrawable is not a bitmap — the blur was silently skipped and
  // the NSFW animation played in the clear next to blurred static tiles. An
  // animated tile that must be blurred is covered outright instead, and its
  // animation is held while covered.
  const coveredAnimated = nsfwBlurred && image.isAnimated;
  // N10 (owner ruling 2026-10-13: keep the blur, fix the engine): expo-image's
  // blurRadius used to run wasabeef 4.3.0's RenderScript intrinsic, which
  // segfaults the whole app on Android 16 (Honor PGT-AN20, evidence
  // a local log). The engine is now
  // NoRsBlurTransformation — same blur, no RenderScript — applied by
  // patches/expo-image*.patch, so the static-tile blur stays as it always was.
  const awaitingResolver = overrideUri === null && overridePending;
  const awaitingStill = cutsStill && still.uri === null;

  const repairLocalFile = useCallback(() => {
    const observedUri = image.localUri;
    if (!localImageKey || !observedUri) return;
    setFailedLocalKey(localImageKey);
    if (repairInFlightKeys.current.has(localImageKey)) return;
    repairInFlightKeys.current.add(localImageKey);
    void (async () => {
      try {
        if (await onLocalFileMissing(observedUri)) {
          setFailedLocalKey((failed) => failed === localImageKey ? null : failed);
        }
      } catch {
        // Keep the remote fallback until a later repair succeeds.
      } finally {
        repairInFlightKeys.current.delete(localImageKey);
      }
    })();
  }, [image.localUri, localImageKey, onLocalFileMissing]);
  // Board #16: the still store found the tile's own file gone. An override
  // file is the resolver's to repair, never the tile's.
  const stillSourceMissing = still.missing && overrideUri === null && useLocalUri;
  useEffect(() => {
    if (stillSourceMissing) repairLocalFile();
  }, [stillSourceMissing, repairLocalFile]);
  // Board #27: a too-large gif mounts no image, so its fast-path failure shows
  // up only as the still store finding the override file gone.
  const stillOverrideMissing = still.missing && overrideUri !== null;
  useEffect(() => {
    if (stillOverrideMissing) onOverrideFailed?.();
  }, [stillOverrideMissing, onOverrideFailed]);

  return (
    <Pressable
      testID={`collection-tile-${image.id}`}
      role="button"
      aria-label={collectionTileLabel(image, t, libraryUnavailable, synced, onlyInCloud, progress)}
      accessibilityHint={selectionMode
        ? t('collection.selectionHint')
        : t('collection.openFullscreenHint')}
      accessibilityState={{ selected }}
      delayLongPress={350}
      onLongPress={() => {
        suppressPressAfterLongPress.current = true;
        onLongPress();
      }}
      onPress={() => {
        if (suppressPressAfterLongPress.current) {
          suppressPressAfterLongPress.current = false;
          return;
        }
        if (selectionMode) onToggleSelection();
        else onOpen();
      }}
      style={({ pressed }) => ({
        aspectRatio: 3 / 4,
        overflow: 'hidden',
        position: 'relative',
        backgroundColor: image.dominantColor || theme.surfaceSecondary,
        opacity: pressed ? 0.72 : 1,
      })}>
      {awaitingResolver || awaitingStill ? null : <Image
        // A key change remounts the native view, which is what makes expo-image
        // re-issue a load that failed transiently.
        key={renderKey}
        accessible={false}
        accessibilityLabel={t('collection.imageAccessibility', { id: image.id })}
        source={source}
        recyclingKey={renderKey}
        contentFit="cover"
        cachePolicy="memory-disk"
        // Board #7: Discover's deck prefetch shares Glide's 4 source threads at
        // NORMAL priority, so a grid tile would otherwise
        // queue behind the whole prefetch batch.
        priority="high"
        transition={useLocalUri ? 0 : 120}
        blurRadius={nsfwBlurred ? 24 : 0}
        autoplay={!coveredAnimated}
        onError={() => {
          if (overrideUri !== null) {
            // The fast path failed: the resolver takes the row over. A resolved
            // override passes no callback and stays silent.
            onOverrideFailed?.();
            return;
          }
          if (!useLocalUri) {
            // Remote source: retry with bounded backoff rather than leaving the
            // tile on its background colour until the row gains a local file.
            scheduleRetry();
            return;
          }
          // Board #16: a still that failed to decode is our cache file, not a
          // missing original; `stillFor` already reports a missing source.
          if (cutsStill) return;
          repairLocalFile();
        }}
        style={{ width: '100%', height: '100%' }}
      />}
      {coveredAnimated ? (
        <View
          testID={`collection-tile-cover-${image.id}`}
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
            backgroundColor: image.dominantColor || theme.surfaceSecondary,
          }}>
          <EyeOff color={theme.textSecondary} size={22} />
          <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600' }}>
            {t('collection.ratingAdult')}
          </Text>
        </View>
      ) : null}
      {badge ? (
        <View
          style={{
            position: 'absolute',
            left: 4,
            bottom: 4,
            maxWidth: '80%',
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderRadius: metrics.radius.small,
            backgroundColor: theme.scrim,
          }}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>
            {badge}
          </Text>
        </View>
      ) : null}
      {progress !== null ? (
        <View style={{ position: 'absolute', right: 7, bottom: 7 }}>
          <CloudBadge progress={progress} />
        </View>
      ) : synced ? (
        <View style={{ position: 'absolute', right: 7, bottom: 7 }}>
          <CloudBadge />
        </View>
      ) : null}
      {selectionMode ? (
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
      ) : null}
    </Pressable>
  );
});
