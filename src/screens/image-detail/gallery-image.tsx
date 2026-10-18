import { Image, useImage } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { isAnimatedRow, isTooLargeToAnimate } from '@/features/images/animation-limits';
import type { StoredImage } from '@/features/images/image-repository';
import { useGifStill } from '@/features/images/use-gif-still';
import { unavailableCopyFor, type LibraryAccess } from '@/features/library/library-access';
import { canonicalExtensionFor } from '@/features/library/library-format';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import type { LibraryEntry } from '@/features/library/library-view-model';
import { providerImageSource } from '@/features/providers/provider-image-source';
import type { ImageProviderKey } from '@/features/waifu/types';
import { useRemoteLoadRetry } from '@/components/use-remote-load-retry';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type GalleryMediaDescriptor = Readonly<{
  id: number | string;
  width: number;
  height: number;
  byteSize: number;
  extension: string;
  isAnimated: boolean;
  dominantColor: string | null;
  localUri: string | null;
  remoteUrl: string | null;
  sampleUrl?: string | null;
  providerKey?: ImageProviderKey | null;
}>;

export function entryToGalleryMedia(entry: LibraryEntry): GalleryMediaDescriptor {
  return {
    id: entry.plaintextSha256,
    width: entry.width,
    height: entry.height,
    byteSize: entry.byteSize,
    extension: canonicalExtensionFor(entry.format),
    isAnimated: entry.format === 'gif',
    dominantColor: null,
    localUri: null,
    remoteUrl: null,
    sampleUrl: null,
    providerKey: null,
  };
}

function toGalleryMedia(
  image: StoredImage | undefined,
  media: GalleryMediaDescriptor | undefined,
): GalleryMediaDescriptor {
  if (media !== undefined) return media;
  if (image === undefined) {
    throw new Error('GalleryImage requires either `image` or `media`');
  }
  return {
    id: image.id,
    width: image.width,
    height: image.height,
    byteSize: image.byteSize,
    extension: image.extension,
    isAnimated: image.isAnimated,
    dominantColor: image.dominantColor,
    localUri: image.localUri,
    remoteUrl: image.remoteUrl,
    sampleUrl: image.sampleUrl,
    providerKey: image.providerKey,
  };
}

export type GalleryImageProps = {
  image?: StoredImage;
  media?: GalleryMediaDescriptor;
  /**
   * Board #27 (spec §5.5 rule 3): called with the local file the page failed
   * to load, so a row the library took over since this snapshot is left alone.
   */
  onLocalFileMissing: (observedUri: string) => boolean | void | Promise<boolean | void>;
  /**
   * Direct-only library override. When present, a `file` source replaces the
   * local/remote URI and skips repair; an `unavailable` source shows the
   * offline or integrity placeholder instead of the image.
   */
  overrideSource?: LibraryRenderSource | null;
  /**
   * True while the library resolver owns this row but has not answered yet.
   * The content issues no provider load: rendering the provider sample in that
   * gap fetched bytes already on disk and put a second load on the same native
   * view — the black viewer of the 2026-09-16 phone report (see the transition
   * note in `StaticGalleryContent`). A library row can still decode this
   * device's thumbnail in the page stage behind that content.
   */
  overridePending?: boolean;
  /**
   * Board #27 (spec §5.7): set only when a `file` override is the entry's local
   * original (the fast path). Its load failing hands the row to the resolver.
   * A too-large gif's missing still re-fires it on every render, so the screen
   * keeps it to once per digest. A resolved override passes none and stays
   * silent.
   */
  onOverrideFailed?: () => void;
  /** Board #27 S4 (spec §5.2): the composition's access; absent reads `ready`. */
  libraryAccess?: LibraryAccess;
  /**
   * Board rows 48–49, amended by row 51. Absent (no library entry): today's
   * tree. `null`: the layered page, thumbnail not known yet. A string: that
   * thumbnail in the stage. The stage paints no colour. Never a provider URL.
   */
  placeholderUri?: string | null;
};

export function GalleryImage(props: GalleryImageProps) {
  if (props.placeholderUri !== undefined) {
    return <LayeredGalleryPage {...props} placeholderUri={props.placeholderUri} />;
  }
  return <GalleryBody {...props} />;
}

function GalleryBody({
  image,
  media: mediaProp,
  onLocalFileMissing,
  overrideSource = null,
  overridePending = false,
  onOverrideFailed,
  libraryAccess = 'ready',
  layered = false,
  onPictureDisplay,
}: GalleryImageProps & {
  layered?: boolean;
  onPictureDisplay?: () => void;
}) {
  const media = toGalleryMedia(image, mediaProp);
  if (overrideSource === null && overridePending) {
    return <PendingGalleryImage media={media} layered={layered} />;
  }
  if (overrideSource?.kind === 'unavailable') {
    return (
      <UnavailableGalleryImage
        media={media}
        category={overrideSource.category}
        libraryAccess={libraryAccess}
      />
    );
  }
  return (
    <FileGalleryImage
      media={media}
      onLocalFileMissing={onLocalFileMissing}
      overrideFileUri={overrideSource?.kind === 'file' ? overrideSource.uri : null}
      overrideIsOriginal={overrideSource?.kind === 'file' && overrideSource.role === 'original'}
      onOverrideFailed={onOverrideFailed}
      layered={layered}
      onPictureDisplay={onPictureDisplay}
    />
  );
}

function LayeredGalleryPage({
  image,
  media: mediaProp,
  placeholderUri,
  overrideSource = null,
  ...rest
}: GalleryImageProps & { placeholderUri: string | null }) {
  const media = toGalleryMedia(image, mediaProp);
  // Any picture of this mounted page, including a retained earlier ref.
  const [pictureDisplayed, setPictureDisplayed] = useState(false);
  const onPictureDisplay = useCallback(() => setPictureDisplayed(true), []);
  const unavailable = overrideSource?.kind === 'unavailable';
  // No fill, and no wait for measurement. The stage used to paint
  // `dominantColor` (or `#111111`) on the contain-fit rect as soon as the page
  // was measured, then wait while this thumbnail decoded. That colour flashed
  // for one or two frames (16–33 ms): Glide's memory cache is keyed by the
  // view's pixel size, and the stage is far larger than the grid tile, so the
  // tile's decode missed. Until the thumbnail draws, the black root shows.
  // The stage fills the page. expo-image contain-fits the thumbnail by the
  // thumbnail's own pixel size; the picture is fitted from the database
  // width and height. A derived thumbnail keeps the original's aspect ratio
  // up to rounding, so it lands where the picture will, and can differ when
  // those stored dimensions are zero or stale.
  const showStage = !unavailable && !pictureDisplayed;

  return (
    <View
      style={{ width: '100%', height: '100%', backgroundColor: '#000000' }}>
      {showStage ? (
        <View
          pointerEvents="none"
          accessible={false}
          style={STAGE_FILL}>
          {typeof placeholderUri === 'string'
            ? <PlaceholderLayer media={media} uri={placeholderUri} />
            : null}
        </View>
      ) : null}
      <GalleryBody
        {...rest}
        media={media}
        overrideSource={overrideSource}
        layered
        onPictureDisplay={onPictureDisplay}
      />
    </View>
  );
}

function UnavailableGalleryImage({
  media,
  category,
  libraryAccess,
}: {
  media: GalleryMediaDescriptor;
  category: Extract<LibraryRenderSource, { kind: 'unavailable' }>['category'];
  libraryAccess: LibraryAccess;
}) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const copy = unavailableCopyFor(category, libraryAccess);

  return (
    <View
      aria-label={t('detail.viewerAccessibility', { id: media.id })}
      accessibilityLiveRegion="polite"
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: '#000000',
        padding: metrics.spacing.large,
      }}>
      <Text
        testID={`gallery-image-${copy.kind}-${media.id}`}
        style={{
          color: theme.textSecondary,
          fontSize: 15,
          fontWeight: '600',
          textAlign: 'center',
        }}>
        {t(copy.title)}
      </Text>
      {copy.detail !== null ? (
        <Text
          style={{
            marginTop: metrics.spacing.small,
            color: theme.textSecondary,
            fontSize: 13,
            textAlign: 'center',
          }}>
          {t(copy.detail)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The thumbnail under a picture that is not on screen yet. `cachePolicy="memory"`
 * so the thumbnail itself is not written to the disk cache. The static picture's
 * `useImage` path still writes transformed resources; that cost is board row 47.
 * It fills the stage. expo-image contain-fits it by the thumbnail's own pixel
 * size; the picture is fitted from the database width and height. A derived
 * thumbnail keeps the original's aspect ratio up to rounding, so it lands
 * where the picture will, and can differ when those stored dimensions are
 * zero or stale. An error hides that URI. A different URI is requested
 * on the same mounted page. `key` gives each URI its own native view, so a
 * late error from the previous URI cannot reach the current one.
 */
function PlaceholderLayer({ media, uri }: { media: GalleryMediaDescriptor; uri: string }) {
  const [failedUri, setFailedUri] = useState<string | null>(null);
  if (failedUri === uri) return null;
  return (
    <Image
      key={uri}
      accessible={false}
      pointerEvents="none"
      testID={`gallery-image-placeholder-${media.id}`}
      source={{ uri }}
      contentFit="contain"
      cachePolicy="memory"
      transition={0}
      onError={() => setFailedUri(uri)}
      style={PLACEHOLDER_FILL}
    />
  );
}

const PLACEHOLDER_FILL = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;

const STAGE_FILL = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;

function PendingGalleryImage({
  media,
  layered = false,
}: {
  media: GalleryMediaDescriptor;
  layered?: boolean;
}) {
  const { t } = useAppTranslation();
  return (
    <View
      aria-label={t('detail.viewerAccessibility', { id: media.id })}
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: layered ? 'transparent' : '#000000',
      }}>
      <View
        testID={`gallery-image-loading-${media.id}`}
        accessibilityLabel={t('detail.fullscreenAccessibility', { id: media.id })}
        style={{
          width: '100%',
          aspectRatio: Math.max(1, media.width) / Math.max(1, media.height),
          backgroundColor: layered ? 'transparent' : (media.dominantColor ?? '#111111'),
        }}
      />
    </View>
  );
}

// Board #16 moved it beside the size cap; re-exported so callers don't change.
export { isAnimatedRow };

type GallerySourceKind = 'override' | 'local' | 'remote';
type GallerySource = string | { uri: string; headers?: Readonly<Record<string, string>> };
type ContainedSize = { width: number; height: number };

function containFit(
  imageWidth: number,
  imageHeight: number,
  layoutWidth: number,
  layoutHeight: number,
): ContainedSize {
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  const fit = Math.min(layoutWidth / width, layoutHeight / height);
  return {
    width: Math.max(1, width * fit),
    height: Math.max(1, height * fit),
  };
}

function FileGalleryImage({
  media,
  onLocalFileMissing,
  overrideFileUri,
  overrideIsOriginal,
  onOverrideFailed,
  layered = false,
  onPictureDisplay,
}: {
  media: GalleryMediaDescriptor;
  onLocalFileMissing: (observedUri: string) => boolean | void | Promise<boolean | void>;
  overrideFileUri: string | null;
  /** False for a derived (thumbnail/preview) override: that file is a still already. */
  overrideIsOriginal: boolean;
  onOverrideFailed?: () => void;
  layered?: boolean;
  onPictureDisplay?: () => void;
}) {
  const { t } = useAppTranslation();
  const reduceMotion = useReducedMotion();
  const [layout, setLayout] = useState<ContainedSize | null>(null);
  const repairInFlightKeys = useRef(new Set<string>());
  const [failedLocalKey, setFailedLocalKey] = useState<string | null>(null);
  const [forcedAnimatedKey, setForcedAnimatedKey] = useState<string | null>(null);
  const localImageKey = media.localUri
    ? JSON.stringify([media.id, media.localUri])
    : null;
  const useLocalUri = overrideFileUri === null
    && localImageKey !== null
    && failedLocalKey !== localImageKey;
  // R8.19: while there is no local file, show the medium sample the deck already
  // fetched and disk-cached instead of pulling the original over the network a
  // second time — a stalled second fetch left the viewer on its colour block.
  const sourceUri = overrideFileUri
    ?? (useLocalUri ? media.localUri! : media.sampleUrl ?? media.remoteUrl ?? '');
  const { attempt, scheduleRetry } = useRemoteLoadRetry(sourceUri);
  // R8.28: only the provider's own remote bytes carry the provider's headers
  // (Gelbooru's CDN 302s to hotlink.php without its Referer). Local files and
  // library-resolver overrides stay plain string sources — they are already
  // ours, and useImage keys its effect on the resolved uri, so handing it a
  // fresh object per render does not re-issue the load.
  const isProviderRemote = overrideFileUri === null && !useLocalUri && Boolean(media.providerKey);
  const loadSource = isProviderRemote && media.providerKey
    ? providerImageSource(sourceUri, media.providerKey)
    : sourceUri;
  const sourceKind: GallerySourceKind = overrideFileUri !== null
    ? 'override'
    : useLocalUri ? 'local' : 'remote';
  // A new source re-evaluates: a static sample of an animated original is fine
  // on the static path.
  const animatedKey = JSON.stringify([media.id, sourceUri]);
  const instantTransition = useLocalUri || overrideFileUri !== null || reduceMotion;
  const forceAnimated = useCallback(() => setForcedAnimatedKey(animatedKey), [animatedKey]);

  const handleLoadError = () => {
    if (overrideFileUri !== null) {
      // The fast path failed: the resolver takes the row over. Overridden
      // library sources are never repaired here.
      onOverrideFailed?.();
      return;
    }
    if (!useLocalUri) {
      // Remote source: retry with bounded backoff instead of stranding the
      // viewer on the dominant-colour placeholder.
      if (sourceUri) scheduleRetry();
      return;
    }
    const observedUri = media.localUri;
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
  };

  const updateLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout;
    setLayout({ width: Math.max(1, next.width), height: Math.max(1, next.height) });
  };

  const layoutWidth = layout?.width ?? 1;
  const layoutHeight = layout?.height ?? 1;
  const containedSize = useMemo(
    () => containFit(media.width, media.height, layoutWidth, layoutHeight),
    [media.height, media.width, layoutHeight, layoutWidth],
  );

  return (
    <View
      aria-label={t('detail.viewerAccessibility', { id: media.id })}
      onLayout={updateLayout}
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: layered ? 'transparent' : '#000000',
      }}>
      {isTooLargeToAnimate(media) ? (
        <TooLargeGalleryContent
          media={media}
          // Only our own file is cut; a remote-only row loads nothing at all.
          source={overrideFileUri ?? (useLocalUri ? media.localUri : null)}
          sourceIsStill={overrideFileUri !== null && !overrideIsOriginal}
          measured={layout !== null}
          containedSize={containedSize}
          onLocalFileMissing={handleLoadError}
          layered={layered}
          onPictureDisplay={onPictureDisplay}
        />
      ) : isAnimatedRow(media) || forcedAnimatedKey === animatedKey ? (
        <AnimatedGalleryContent
          media={media}
          // `<Image source>` takes an ImageSource; a bare string is a useImage
          // convenience only.
          source={typeof loadSource === 'string' ? { uri: loadSource } : loadSource}
          sourceKind={sourceKind}
          attempt={attempt}
          measured={layout !== null}
          containedSize={containedSize}
          instantTransition={instantTransition}
          onLoadError={handleLoadError}
          layered={layered}
          onPictureDisplay={onPictureDisplay}
        />
      ) : (
        <StaticGalleryContent
          media={media}
          source={loadSource}
          sourceKind={sourceKind}
          useLocalUri={useLocalUri}
          overrideFileUri={overrideFileUri}
          attempt={attempt}
          containedSize={containedSize}
          instantTransition={instantTransition}
          onLoadError={handleLoadError}
          onAnimatedRef={forceAnimated}
          layered={layered}
          onPictureDisplay={onPictureDisplay}
        />
      )}
    </View>
  );
}

function StaticGalleryContent({
  media,
  source,
  sourceKind,
  useLocalUri,
  overrideFileUri,
  attempt,
  containedSize,
  instantTransition,
  onLoadError,
  onAnimatedRef,
  layered = false,
  onPictureDisplay,
}: {
  media: GalleryMediaDescriptor;
  source: GallerySource;
  sourceKind: GallerySourceKind;
  useLocalUri: boolean;
  overrideFileUri: string | null;
  attempt: number;
  containedSize: ContainedSize;
  instantTransition: boolean;
  onLoadError: () => void;
  onAnimatedRef: () => void;
  layered?: boolean;
  onPictureDisplay?: () => void;
}) {
  const { t } = useAppTranslation();
  // Fixed for the lifetime of the mounted element. expo-image swaps between
  // two child views; its zero-transition path sets the reused view's alpha to
  // 1 without cancelling a fade-out still running on it from an earlier
  // 120 ms swap, so flipping 120 → 0 between two loads a few ms apart leaves
  // the new picture at alpha 0 (ExpoImageViewWrapper.onResourceReady, phone +
  // emulator evidence 2026-09-17). A remote-first row that later gains its
  // local file simply keeps fading.
  const [transition] = useState(() => (instantTransition ? 0 : 120));
  const loadedImage = useImage(source, {
    maxWidth: Math.min(4096, Math.max(1, media.width)),
    maxHeight: Math.min(4096, Math.max(1, media.height)),
    onError: onLoadError,
  }, [
    media.id,
    media.localUri,
    media.remoteUrl,
    media.sampleUrl,
    useLocalUri,
    overrideFileUri,
    attempt,
  ]);
  // Spec §5 point 2 (board #6): the metadata said static but the bytes are
  // animated. This ref is never handed to a view: a Glide-decoded
  // GifDrawable is built with autoplay off and only a displaying view
  // start()s it, so a never-displayed ref runs no decoder loop. The page
  // switches to the Glide-owned animated path, a new element.
  const animatedRef = loadedImage?.isAnimated === true;
  useEffect(() => {
    if (animatedRef) onAnimatedRef();
  }, [animatedRef, onAnimatedRef]);
  const label = t('detail.fullscreenAccessibility', { id: media.id });
  const pictureStyle = { width: containedSize.width, height: containedSize.height };
  const reportDisplay = onPictureDisplay ? { onDisplay: onPictureDisplay } : {};

  return loadedImage && !animatedRef ? (
    <Image
      testID={`gallery-image-${sourceKind}-loaded-${media.id}`}
      accessible
      accessibilityLabel={label}
      source={loadedImage}
      contentFit="contain"
      cachePolicy="memory-disk"
      transition={transition}
      style={pictureStyle}
      {...reportDisplay}
    />
  ) : (
    <View
      testID={`gallery-image-loading-${media.id}`}
      accessibilityLabel={label}
      style={{
        width: containedSize.width,
        height: containedSize.height,
        backgroundColor: layered ? 'transparent' : (media.dominantColor ?? '#111111'),
      }}
    />
  );
}

/**
 * Board #16 (spec §5.4/§5.5): a gif above `GIF_ANIMATE_MAX_BYTES`. Every Glide
 * path — this page's animated `<Image>` and `useImage` alike — reads the whole
 * file first, which OOMs at 192m and did so on every background pager mount.
 * The original is therefore never mounted, not even while the still is being
 * cut. A layered page keeps the thumbnail on the stage for the whole wait
 * before the page's first picture display, and only as long as the thumbnail
 * decodes. The stage paints no colour, so a row with no thumbnail shows the
 * black page. Then the page shows the bounded first-frame still
 * (`gif-first-frame.ts`), and always says why it does not play.
 */
function TooLargeGalleryContent({
  media,
  source,
  sourceIsStill,
  measured,
  containedSize,
  onLocalFileMissing,
  layered = false,
  onPictureDisplay,
}: {
  media: GalleryMediaDescriptor;
  /** The local or override file, or null when the row has none (remote-only). */
  source: string | null;
  /** A derived library still: shown as it is, nothing to cut. */
  sourceIsStill: boolean;
  measured: boolean;
  containedSize: ContainedSize;
  onLocalFileMissing: () => void;
  layered?: boolean;
  onPictureDisplay?: () => void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const cut = useGifStill(sourceIsStill ? null : source, media.byteSize);
  const stillUri = sourceIsStill ? source : cut.uri;
  const { missing } = cut;
  // The page's own local-file repair: it drops the file (source → null) and
  // restores it once repaired, which asks for the still again.
  useEffect(() => {
    if (missing) onLocalFileMissing();
  }, [missing, onLocalFileMissing]);
  const label = t('detail.fullscreenAccessibility', { id: media.id });

  return (
    <View style={CENTRED_FILL}>
      {/* Mount only once the page is measured, like the animated path: a
          resize would reload the still on the same view. */}
      {stillUri !== null && measured ? (
        <Image
          testID={`gallery-image-still-loaded-${media.id}`}
          accessible
          accessibilityLabel={label}
          source={{ uri: stillUri }}
          contentFit="contain"
          cachePolicy="none"
          autoplay={false}
          transition={0}
          style={{ width: containedSize.width, height: containedSize.height }}
          {...(onPictureDisplay ? { onDisplay: onPictureDisplay } : {})}
        />
      ) : (
        <View
          testID={`gallery-image-loading-${media.id}`}
          accessibilityLabel={label}
          style={{
            width: containedSize.width,
            height: containedSize.height,
            backgroundColor: layered ? 'transparent' : (media.dominantColor ?? '#111111'),
          }}
        />
      )}
      <Text
        testID={`gallery-image-too-large-${media.id}`}
        accessibilityLiveRegion="polite"
        style={{
          position: 'absolute',
          left: metrics.spacing.large,
          right: metrics.spacing.large,
          bottom: metrics.spacing.large,
          color: theme.textSecondary,
          fontSize: 13,
          textAlign: 'center',
        }}>
        {t('detail.animationTooLarge')}
      </Text>
    </View>
  );
}

/**
 * Board #6: an animated row renders its URI straight into `<Image>` — no
 * `useImage` — so Glide owns the GifDrawable. With `cachePolicy="disk"`
 * (skipMemoryCache) the resource is not memory-cacheable, and Glide recycles it
 * — penfeizhou's resource `recycle()` calls `GifDrawable.stop()` — as soon as
 * expo-image clears the view's target on unmount or source swap. A `useImage`
 * ref is never recycled, and expo-image never stops an Animatable it
 * displayed, so every opened gif kept decoding for the life of the process.
 *
 * Board #17 (spec docs/superpowers/specs/2026-09-26-row17-gif-cache-poison-design.md
 * §2): a local or override (`file://`) layer uses `cachePolicy="none"`. When
 * Glide cannot decode a local gif as an animation (the whole-file read OOMs) it
 * falls back to a static first frame, and under "disk" (Glide's AUTOMATIC
 * strategy) it writes that frame to its resource disk cache. The key is the
 * bare file URI with no content signature, so every later open is served the
 * static picture forever. For a file source "none" differs from "disk" only in
 * reading and writing that resource cache. A remote layer keeps "disk": its
 * provider bytes stay in the data disk cache, and a remote load cannot be
 * resource-poisoned. Both policies skip the memory cache, so the recycle above
 * holds. The policy is fixed per layer, like its size and transition.
 */
function AnimatedGalleryContent({
  media,
  source,
  sourceKind,
  attempt,
  measured,
  containedSize,
  instantTransition,
  onLoadError,
  layered = false,
  onPictureDisplay,
}: {
  media: GalleryMediaDescriptor;
  source: Exclude<GallerySource, string>;
  sourceKind: GallerySourceKind;
  attempt: number;
  measured: boolean;
  containedSize: ContainedSize;
  instantTransition: boolean;
  onLoadError: () => void;
  layered?: boolean;
  onPictureDisplay?: () => void;
}) {
  const { t } = useAppTranslation();
  const transitionNow = instantTransition ? 0 : 120;
  const [stack, setStack] = useState<AnimatedStack>(() => ({
    attempt,
    generation: 0,
    seq: 0,
    layers: [animatedLayer(media.id, 0, 0, source, sourceKind, transitionNow, containedSize)],
  }));
  let next = stack;
  if (attempt !== next.attempt) {
    // A retry (attempt went up) re-issues the load on a fresh element; the
    // layer that failed is dropped. `attempt` itself resets to 0 whenever the
    // source changes, so only an increase counts as a retry.
    next = attempt > next.attempt
      ? {
          attempt,
          generation: next.generation + 1,
          seq: 0,
          layers: [
            ...next.layers.filter((layer) => layer.displayed && !layer.failed),
            animatedLayer(media.id, next.generation + 1, 0, source, sourceKind, transitionNow, containedSize),
          ],
        }
      : { ...next, attempt };
  }
  const top = next.layers[next.layers.length - 1];
  if (
    top === undefined
    || top.source.uri !== source.uri
    || top.size.width !== containedSize.width
    || top.size.height !== containedSize.height
  ) {
    // A new source or size: keep the picture on screen (the newest displayed
    // layer) and load the new one above it. A layer that never displayed is
    // replaced, not stacked.
    const shown = next.layers.filter((layer) => layer.displayed && !layer.failed).slice(-1);
    next = {
      ...next,
      seq: next.seq + 1,
      layers: [
        ...shown,
        animatedLayer(media.id, next.generation, next.seq + 1, source, sourceKind, transitionNow, containedSize),
      ],
    };
  }
  if (next !== stack) setStack(next);
  const layers = next.layers;

  const onLayerDisplay = (key: string) => {
    onPictureDisplay?.();
    setStack((current) => {
      const index = current.layers.findIndex((layer) => layer.key === key);
      if (index < 0) return current;
      // The layers below are covered now: unmounting them lets Glide recycle
      // (and stop) their decoders.
      return {
        ...current,
        layers: current.layers.slice(index).map((layer, at) => (
          // A layer that displays is on screen, whatever it reported before.
          at === 0 ? { ...layer, displayed: true, failed: false } : layer
        )),
      };
    });
  };
  const onLayerError = (key: string) => {
    setStack((current) => ({
      ...current,
      layers: current.layers.map((layer) => (
        layer.key === key ? { ...layer, failed: true } : layer
      )),
    }));
    onLoadError();
  };

  // The topmost displayed layer is what is on screen: it alone carries the
  // loaded testID and the fullscreen label.
  let labelled = -1;
  layers.forEach((layer, index) => {
    if (layer.displayed && !layer.failed) labelled = index;
  });
  const label = t('detail.fullscreenAccessibility', { id: media.id });

  return (
    <View style={CENTRED_FILL}>
      {labelled < 0 ? (
        <View
          testID={`gallery-image-loading-${media.id}`}
          accessibilityLabel={label}
          style={{
            width: containedSize.width,
            height: containedSize.height,
            backgroundColor: layered ? 'transparent' : (media.dominantColor ?? '#111111'),
          }}
        />
      ) : null}
      {/* Mount only once the page is measured: at the 1×1 placeholder size
          Glide would load a thumbnail and then load again on the same view. */}
      {measured ? layers.map((layer, index) => (
        <View key={layer.key} pointerEvents="none" style={CENTRED_FILL}>
        <Image
          testID={index === labelled
            ? `gallery-image-${layer.kind}-loaded-${media.id}`
            : undefined}
          accessible={index === labelled}
          accessibilityLabel={index === labelled ? label : undefined}
          source={layer.source}
          contentFit="contain"
          cachePolicy={layer.kind === 'remote' ? 'disk' : 'none'}
          transition={layer.transition}
          style={{ width: layer.size.width, height: layer.size.height }}
          onDisplay={() => onLayerDisplay(layer.key)}
          onError={() => onLayerError(layer.key)}
        />
        </View>
      )) : null}
    </View>
  );
}

const CENTRED_FILL = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

type AnimatedLayer = {
  key: string;
  size: ContainedSize;
  source: Exclude<GallerySource, string>;
  kind: GallerySourceKind;
  transition: number;
  displayed: boolean;
  failed: boolean;
};

type AnimatedStack = {
  attempt: number;
  generation: number;
  seq: number;
  layers: AnimatedLayer[];
};

function animatedLayer(
  mediaId: number | string,
  generation: number,
  seq: number,
  source: Exclude<GallerySource, string>,
  kind: GallerySourceKind,
  transition: number,
  size: ContainedSize,
): AnimatedLayer {
  return {
    key: JSON.stringify([mediaId, generation, seq]),
    size,
    source,
    kind,
    transition,
    displayed: false,
    failed: false,
  };
}
