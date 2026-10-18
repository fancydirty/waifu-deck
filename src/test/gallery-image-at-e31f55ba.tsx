// Test fixture, never imported by app code: `src/screens/image-detail/gallery-image.tsx` frozen at
// e31f55ba (board rows 48–49 Task 1, before the layered page). gallery-image.test.tsx renders it beside
// today's component to prove that a row with no library entry (no `placeholderUri`) still gets that tree.
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
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import { providerImageSource } from '@/features/providers/provider-image-source';
import { useRemoteLoadRetry } from '@/components/use-remote-load-retry';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type GalleryImageProps = {
  image: StoredImage;
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
   * The viewer then holds the row's colour block and issues NO load: rendering
   * the provider sample in that gap fetched bytes already on disk and, worse,
   * put a second load on the same native view a few milliseconds later — the
   * black viewer of the 2026-09-16 phone report (see the transition note in
   * `StaticGalleryContent`).
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
};

export function GalleryImage({
  image,
  onLocalFileMissing,
  overrideSource = null,
  overridePending = false,
  onOverrideFailed,
  libraryAccess = 'ready',
}: GalleryImageProps) {
  if (overrideSource === null && overridePending) {
    return <PendingGalleryImage image={image} />;
  }
  if (overrideSource?.kind === 'unavailable') {
    return (
      <UnavailableGalleryImage
        image={image}
        category={overrideSource.category}
        libraryAccess={libraryAccess}
      />
    );
  }
  return (
    <FileGalleryImage
      image={image}
      onLocalFileMissing={onLocalFileMissing}
      overrideFileUri={overrideSource?.kind === 'file' ? overrideSource.uri : null}
      overrideIsOriginal={overrideSource?.kind === 'file' && overrideSource.role === 'original'}
      onOverrideFailed={onOverrideFailed}
    />
  );
}

function UnavailableGalleryImage({
  image,
  category,
  libraryAccess,
}: {
  image: StoredImage;
  category: Extract<LibraryRenderSource, { kind: 'unavailable' }>['category'];
  libraryAccess: LibraryAccess;
}) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const copy = unavailableCopyFor(category, libraryAccess);

  return (
    <View
      aria-label={t('detail.viewerAccessibility', { id: image.id })}
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
        testID={`gallery-image-${copy.kind}-${image.id}`}
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

function PendingGalleryImage({ image }: { image: StoredImage }) {
  const { t } = useAppTranslation();
  return (
    <View
      aria-label={t('detail.viewerAccessibility', { id: image.id })}
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: '#000000',
      }}>
      <View
        testID={`gallery-image-loading-${image.id}`}
        accessibilityLabel={t('detail.fullscreenAccessibility', { id: image.id })}
        style={{
          width: '100%',
          aspectRatio: Math.max(1, image.width) / Math.max(1, image.height),
          backgroundColor: image.dominantColor ?? '#111111',
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

function FileGalleryImage({
  image,
  onLocalFileMissing,
  overrideFileUri,
  overrideIsOriginal,
  onOverrideFailed,
}: {
  image: StoredImage;
  onLocalFileMissing: (observedUri: string) => boolean | void | Promise<boolean | void>;
  overrideFileUri: string | null;
  /** False for a derived (thumbnail/preview) override: that file is a still already. */
  overrideIsOriginal: boolean;
  onOverrideFailed?: () => void;
}) {
  const { t } = useAppTranslation();
  const reduceMotion = useReducedMotion();
  const [layout, setLayout] = useState<ContainedSize | null>(null);
  const repairInFlightKeys = useRef(new Set<string>());
  const [failedLocalKey, setFailedLocalKey] = useState<string | null>(null);
  const [forcedAnimatedKey, setForcedAnimatedKey] = useState<string | null>(null);
  const localImageKey = image.localUri
    ? JSON.stringify([image.id, image.localUri])
    : null;
  const useLocalUri = overrideFileUri === null
    && localImageKey !== null
    && failedLocalKey !== localImageKey;
  // R8.19: while there is no local file, show the medium sample the deck already
  // fetched and disk-cached instead of pulling the original over the network a
  // second time — a stalled second fetch left the viewer on its colour block.
  const sourceUri = overrideFileUri
    ?? (useLocalUri ? image.localUri! : image.sampleUrl ?? image.remoteUrl);
  const { attempt, scheduleRetry } = useRemoteLoadRetry(sourceUri);
  // R8.28: only the provider's own remote bytes carry the provider's headers
  // (Gelbooru's CDN 302s to hotlink.php without its Referer). Local files and
  // library-resolver overrides stay plain string sources — they are already
  // ours, and useImage keys its effect on the resolved uri, so handing it a
  // fresh object per render does not re-issue the load.
  const isProviderRemote = overrideFileUri === null && !useLocalUri;
  const loadSource = isProviderRemote
    ? providerImageSource(sourceUri, image.providerKey)
    : sourceUri;
  const sourceKind: GallerySourceKind = overrideFileUri !== null
    ? 'override'
    : useLocalUri ? 'local' : 'remote';
  // A new source re-evaluates: a static sample of an animated original is fine
  // on the static path.
  const animatedKey = JSON.stringify([image.id, sourceUri]);
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
      scheduleRetry();
      return;
    }
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
  };

  const updateLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout;
    setLayout({ width: Math.max(1, next.width), height: Math.max(1, next.height) });
  };

  const layoutWidth = layout?.width ?? 1;
  const layoutHeight = layout?.height ?? 1;
  const containedSize = useMemo(() => {
    const imageWidth = Math.max(1, image.width);
    const imageHeight = Math.max(1, image.height);
    const fit = Math.min(layoutWidth / imageWidth, layoutHeight / imageHeight);
    return {
      width: Math.max(1, imageWidth * fit),
      height: Math.max(1, imageHeight * fit),
    };
  }, [image.height, image.width, layoutHeight, layoutWidth]);

  return (
    <View
      aria-label={t('detail.viewerAccessibility', { id: image.id })}
      onLayout={updateLayout}
      style={{
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: '#000000',
      }}>
      {isTooLargeToAnimate(image) ? (
        <TooLargeGalleryContent
          image={image}
          // Only our own file is cut; a remote-only row loads nothing at all.
          source={overrideFileUri ?? (useLocalUri ? image.localUri : null)}
          sourceIsStill={overrideFileUri !== null && !overrideIsOriginal}
          measured={layout !== null}
          containedSize={containedSize}
          onLocalFileMissing={handleLoadError}
        />
      ) : isAnimatedRow(image) || forcedAnimatedKey === animatedKey ? (
        <AnimatedGalleryContent
          image={image}
          // `<Image source>` takes an ImageSource; a bare string is a useImage
          // convenience only.
          source={typeof loadSource === 'string' ? { uri: loadSource } : loadSource}
          sourceKind={sourceKind}
          attempt={attempt}
          measured={layout !== null}
          containedSize={containedSize}
          instantTransition={instantTransition}
          onLoadError={handleLoadError}
        />
      ) : (
        <StaticGalleryContent
          image={image}
          source={loadSource}
          sourceKind={sourceKind}
          useLocalUri={useLocalUri}
          overrideFileUri={overrideFileUri}
          attempt={attempt}
          containedSize={containedSize}
          instantTransition={instantTransition}
          onLoadError={handleLoadError}
          onAnimatedRef={forceAnimated}
        />
      )}
    </View>
  );
}

function StaticGalleryContent({
  image,
  source,
  sourceKind,
  useLocalUri,
  overrideFileUri,
  attempt,
  containedSize,
  instantTransition,
  onLoadError,
  onAnimatedRef,
}: {
  image: StoredImage;
  source: GallerySource;
  sourceKind: GallerySourceKind;
  useLocalUri: boolean;
  overrideFileUri: string | null;
  attempt: number;
  containedSize: ContainedSize;
  instantTransition: boolean;
  onLoadError: () => void;
  onAnimatedRef: () => void;
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
    maxWidth: Math.min(4096, Math.max(1, image.width)),
    maxHeight: Math.min(4096, Math.max(1, image.height)),
    onError: onLoadError,
  }, [
    image.id,
    image.localUri,
    image.remoteUrl,
    image.sampleUrl,
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

  return loadedImage && !animatedRef ? (
    <Image
      testID={`gallery-image-${sourceKind}-loaded-${image.id}`}
      accessible
      accessibilityLabel={t('detail.fullscreenAccessibility', { id: image.id })}
      source={loadedImage}
      contentFit="contain"
      cachePolicy="memory-disk"
      transition={transition}
      style={{ width: containedSize.width, height: containedSize.height }}
    />
  ) : (
    <View
      testID={`gallery-image-loading-${image.id}`}
      accessibilityLabel={t('detail.fullscreenAccessibility', { id: image.id })}
      style={{
        width: containedSize.width,
        height: containedSize.height,
        backgroundColor: image.dominantColor ?? '#111111',
      }}
    />
  );
}

/**
 * Board #16 (spec §5.4/§5.5): a gif above `GIF_ANIMATE_MAX_BYTES`. Every Glide
 * path — this page's animated `<Image>` and `useImage` alike — reads the whole
 * file first, which OOMs at 192m and did so on every background pager mount.
 * The original is therefore never mounted, not even while the still is being
 * cut: the page holds its colour block, then shows the bounded first-frame
 * still (`gif-first-frame.ts`), and always says why it does not play.
 */
function TooLargeGalleryContent({
  image,
  source,
  sourceIsStill,
  measured,
  containedSize,
  onLocalFileMissing,
}: {
  image: StoredImage;
  /** The local or override file, or null when the row has none (remote-only). */
  source: string | null;
  /** A derived library still: shown as it is, nothing to cut. */
  sourceIsStill: boolean;
  measured: boolean;
  containedSize: ContainedSize;
  onLocalFileMissing: () => void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const cut = useGifStill(sourceIsStill ? null : source, image.byteSize);
  const stillUri = sourceIsStill ? source : cut.uri;
  const { missing } = cut;
  // The page's own local-file repair: it drops the file (source → null) and
  // restores it once repaired, which asks for the still again.
  useEffect(() => {
    if (missing) onLocalFileMissing();
  }, [missing, onLocalFileMissing]);
  const label = t('detail.fullscreenAccessibility', { id: image.id });

  return (
    <View style={CENTRED_FILL}>
      {/* Mount only once the page is measured, like the animated path: a
          resize would reload the still on the same view. */}
      {stillUri !== null && measured ? (
        <Image
          testID={`gallery-image-still-loaded-${image.id}`}
          accessible
          accessibilityLabel={label}
          source={{ uri: stillUri }}
          contentFit="contain"
          cachePolicy="none"
          autoplay={false}
          transition={0}
          style={{ width: containedSize.width, height: containedSize.height }}
        />
      ) : (
        <View
          testID={`gallery-image-loading-${image.id}`}
          accessibilityLabel={label}
          style={{
            width: containedSize.width,
            height: containedSize.height,
            backgroundColor: image.dominantColor ?? '#111111',
          }}
        />
      )}
      <Text
        testID={`gallery-image-too-large-${image.id}`}
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
  image,
  source,
  sourceKind,
  attempt,
  measured,
  containedSize,
  instantTransition,
  onLoadError,
}: {
  image: StoredImage;
  source: Exclude<GallerySource, string>;
  sourceKind: GallerySourceKind;
  attempt: number;
  measured: boolean;
  containedSize: ContainedSize;
  instantTransition: boolean;
  onLoadError: () => void;
}) {
  const { t } = useAppTranslation();
  // Each source gets its own <Image> element (a layer). A remote-sample gif
  // that gains its local file mounts the local layer ABOVE the remote one and
  // unmounts the remote layer only once the local one displays. Swapping the
  // source on one element is not an option here: Glide owns the GifDrawable,
  // so the swap clears the old target and recycles its picture before the new
  // one is ready — a black frame. A remount would show the
  // colour block instead. Each layer's transition AND size are fixed for its
  // lifetime: a Glide-owned view that changes size clears its target and
  // reloads (a black frame) — measured when the page grew as its repair or
  // "saving" row disappeared (1326 → 1473 px). A new size is a new layer, like
  // a new source. Emulator remote → local swaps, pixel-sampled every ~200 ms:
  // pre-fix build 2/14 black, one element per source 4/7, layers with a fixed
  // size 0/8 (2026-09-26). (See the static path for the 120 → 0 hazard.)
  const transitionNow = instantTransition ? 0 : 120;
  const [stack, setStack] = useState<AnimatedStack>(() => ({
    attempt,
    generation: 0,
    seq: 0,
    layers: [animatedLayer(image.id, 0, 0, source, sourceKind, transitionNow, containedSize)],
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
            animatedLayer(image.id, next.generation + 1, 0, source, sourceKind, transitionNow, containedSize),
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
        animatedLayer(image.id, next.generation, next.seq + 1, source, sourceKind, transitionNow, containedSize),
      ],
    };
  }
  if (next !== stack) setStack(next);
  const layers = next.layers;

  const onLayerDisplay = (key: string) => setStack((current) => {
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
  const label = t('detail.fullscreenAccessibility', { id: image.id });

  return (
    <View style={CENTRED_FILL}>
      {labelled < 0 ? (
        <View
          testID={`gallery-image-loading-${image.id}`}
          accessibilityLabel={label}
          style={{
            width: containedSize.width,
            height: containedSize.height,
            backgroundColor: image.dominantColor ?? '#111111',
          }}
        />
      ) : null}
      {/* Mount only once the page is measured: at the 1×1 placeholder size
          Glide would load a thumbnail and then load again on the same view. */}
      {measured ? layers.map((layer, index) => (
        <View key={layer.key} pointerEvents="none" style={CENTRED_FILL}>
        <Image
          testID={index === labelled
            ? `gallery-image-${layer.kind}-loaded-${image.id}`
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
  imageId: number,
  generation: number,
  seq: number,
  source: Exclude<GallerySource, string>,
  kind: GallerySourceKind,
  transition: number,
  size: ContainedSize,
): AnimatedLayer {
  return {
    key: JSON.stringify([imageId, generation, seq]),
    size,
    source,
    kind,
    transition,
    displayed: false,
    failed: false,
  };
}
