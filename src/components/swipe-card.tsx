import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Heart, X } from 'lucide-react-native';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  AXIS_UNLOCKED,
  AXIS_VERTICAL,
  getPanAxisLock,
  getPeekProgressForTranslation,
  getPeekSettle,
  PEEK_TRAVEL_PX,
} from './pan-axis';
import { providerImageSource } from '@/features/providers/provider-image-source';
import type { WaifuImage } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { actionColors, useAppThemeColors } from '@/theme/colors';

export type SwipeDirection = 'left' | 'right';

export type SwipeCardHandle = {
  dismiss: (direction: SwipeDirection) => void;
};

export type SwipeCardProps = {
  card: WaifuImage;
  cardWidth: number;
  cardHeight: number;
  onCommit: (direction: SwipeDirection) => Promise<boolean>;
  onExitComplete: (direction: SwipeDirection) => void;
  interactive?: boolean;
  accessibilityLabel?: string;
  swipeProgress?: SharedValue<number>;
  peekProgress?: SharedValue<number>;
  ref?: React.Ref<SwipeCardHandle>;
};

const SWIPE_VELOCITY = 800;
const SWIPE_THRESHOLD_RATIO = 0.28;
const SWIPE_INTENT_RATIO = 0.12;
const SWIPE_DISARM_RATIO = 0.2;
const PEEK_SETTLE_SPRING = { damping: 20, stiffness: 220 } as const;

export function getSwipeCardImageLayout({
  cardWidth,
  cardHeight,
  imageWidth,
  imageHeight,
}: {
  cardWidth: number;
  cardHeight: number;
  imageWidth: number;
  imageHeight: number;
}) {
  const frameWidth = normalizeDisplayDimension(cardWidth);
  const frameHeight = normalizeDisplayDimension(cardHeight);
  const intrinsicWidth = normalizeDisplayDimension(imageWidth);
  const intrinsicHeight = normalizeDisplayDimension(imageHeight);
  const scale = Math.min(
    frameWidth / intrinsicWidth,
    frameHeight / intrinsicHeight,
  );
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;

  return {
    width,
    height,
    left: (frameWidth - width) / 2,
    top: (frameHeight - height) / 2,
  };
}

function normalizeDisplayDimension(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

type DismissAttempt = {
  direction: SwipeDirection;
  commit: 'pending' | 'accepted' | 'rejected';
};

export function getSwipeDecision({
  translationX,
  velocityX,
  cardWidth,
}: {
  translationX: number;
  velocityX: number;
  cardWidth: number;
}): SwipeDirection | null {
  'worklet';
  const crossedThreshold = Math.abs(translationX) / cardWidth >= SWIPE_THRESHOLD_RATIO;
  const flickedFast = Math.abs(velocityX) >= SWIPE_VELOCITY;
  if (!crossedThreshold && !flickedFast) return null;

  const directionValue = crossedThreshold ? translationX : velocityX;
  return directionValue >= 0 ? 'right' : 'left';
}

export function getSwipeMotionConfig(reducedMotion: boolean) {
  return {
    exitDuration: reducedMotion ? 1 : 220,
    imageTransition: reducedMotion ? 0 : 180,
    resetWithSpring: !reducedMotion,
  };
}

export function triggerSwipeThresholdHaptic() {
  const haptic = process.env.EXPO_OS === 'android'
    ? Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Segment_Tick)
    : Haptics.selectionAsync();
  void haptic.catch(() => undefined);
}

export function SwipeCard({
  card,
  cardWidth,
  cardHeight,
  onCommit,
  onExitComplete,
  interactive = true,
  accessibilityLabel,
  swipeProgress: externalSwipeProgress,
  peekProgress: externalPeekProgress,
  ref,
}: SwipeCardProps) {
  const { t } = useAppTranslation();
  const theme = useAppThemeColors();
  const reducedMotion = useReducedMotion();

  // R8.12: a card whose artwork fails to load (404, decode error, offline CDN)
  // must show an honest failure state, not the blank frame the owner reported.
  // Derived state, not an effect reset: the failure is keyed by the URL that
  // failed, so moving to the next card (a different URL) clears it during
  // render without a setState-in-effect cascading render.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // R8.18: the deck renders the medium sample (falls back to the original when
  // a source has none). Track failure against the URL actually displayed so a
  // new card (different display URL) clears it during render.
  const displayUrl = card.sampleUrl ?? card.remoteUrl;
  const imageFailed = failedUrl !== null && failedUrl === displayUrl;
  // R8.28: some sources' CDNs refuse a bare request — Gelbooru's 302s to
  // hotlink.php unless the load carries its Referer. Sources that declare no
  // headers still produce exactly `{ uri }`, so their loads are unchanged.
  const imageSource = useMemo(
    () => providerImageSource(displayUrl, card.providerKey),
    [card.providerKey, displayUrl],
  );

  // R8.14: owner reverted R8.7-2 — the card keeps a FIXED deck rectangle and
  // the artwork is contained at its native aspect ratio inside it. The contain
  // math below preserves R5.3 (no default crop); the neutral surface background
  // keeps the letterbox from reading as the saturated "傻逼框框" the 2026-09-06
  // review rejected (dominantColor must never return as a static fill).
  const imageLayout = getSwipeCardImageLayout({
    cardWidth,
    cardHeight,
    imageWidth: card.width,
    imageHeight: card.height,
  });

  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const internalSwipeProgress = useSharedValue(0);
  const swipeProgress = externalSwipeProgress ?? internalSwipeProgress;
  const internalPeekProgress = useSharedValue(0);
  const peekProgress = externalPeekProgress ?? internalPeekProgress;
  const peekGestureStartProgress = useSharedValue(0);
  const panAxis = useSharedValue(AXIS_UNLOCKED);
  const thresholdArmed = useSharedValue(false);
  const isBusy = useSharedValue(false);
  // R8.3: The gesture is always enabled, but only the top card in the deck
  // should respond to touches. Checking this inside the worklet callback
  // eliminates the 220ms dead input window that occurred when .enabled(interactive)
  // toggled during the exit animation, leaving the next card unable to receive events.
  const isTopOfStack = useSharedValue(interactive);

  useEffect(() => {
    isTopOfStack.value = interactive;
  }, [interactive, isTopOfStack]);

  const pendingDismiss = useRef<DismissAttempt | null>(null);
  // R8.1: Gesture math continues using deck width constant so thresholds don't
  // vary with image aspect ratio.
  const swipeThreshold = cardWidth * SWIPE_THRESHOLD_RATIO;
  const exitDistance = cardWidth + 160;
  const motion = getSwipeMotionConfig(reducedMotion);

  const resetPosition = useCallback(() => {
    'worklet';
    if (!motion.resetWithSpring) {
      translateX.value = 0;
      translateY.value = 0;
      swipeProgress.value = 0;
    } else {
      translateX.value = withSpring(0, { damping: 18, stiffness: 220 });
      translateY.value = withSpring(0, { damping: 18, stiffness: 220 });
      swipeProgress.value = withSpring(0, { damping: 20, stiffness: 260 });
    }
    peekProgress.value = 0;
    panAxis.value = AXIS_UNLOCKED;
    thresholdArmed.value = false;
    isBusy.value = false;
  }, [
    isBusy,
    motion.resetWithSpring,
    panAxis,
    peekProgress,
    swipeProgress,
    thresholdArmed,
    translateX,
    translateY,
  ]);

  // The unmount cleanup runs with empty deps, so it cannot close over the prop.
  const onExitCompleteRef = useRef(onExitComplete);
  useLayoutEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  });

  const settleDismiss = useCallback((attempt: DismissAttempt) => {
    // R8.4 requirement 1: an accepted write is durable, so it must publish even
    // when a newer gesture has already taken the slot. Only clear the slot if
    // this attempt still owns it, so the newer attempt keeps its own bookkeeping.
    const ownsSlot = pendingDismiss.current === attempt;
    if (attempt.commit === 'rejected') {
      // A displaced rejection must not reset the position out from under the
      // attempt that now owns the card.
      if (!ownsSlot) return;
      pendingDismiss.current = null;
      resetPosition();
      return;
    }
    // R8.3: Once the write is accepted, publish immediately — the durable side
    // effect has landed, so the deck must advance regardless of whether the exit
    // animation has finished. Waiting for animation completion created a 220ms
    // dead input window during which the next card could not be interacted with.
    if (attempt.commit === 'accepted') {
      if (ownsSlot) pendingDismiss.current = null;
      onExitComplete(attempt.direction);
    }
  }, [onExitComplete, resetPosition]);

  const animateCommittedExit = useCallback((direction: SwipeDirection) => {
    'worklet';
    translateX.value = withTiming(
      direction === 'right' ? exitDistance : -exitDistance,
      { duration: motion.exitDuration },
      (finished) => {
        if (finished) return;
        translateX.value = withSpring(0, { damping: 18, stiffness: 220 });
        translateY.value = withSpring(0, { damping: 18, stiffness: 220 });
        isBusy.value = false;
      },
    );
    translateY.value = withTiming(-18, { duration: motion.exitDuration });
    swipeProgress.value = withTiming(direction === 'right' ? 1 : -1, {
      duration: motion.exitDuration,
    });
  }, [exitDistance, isBusy, motion.exitDuration, swipeProgress, translateX, translateY]);

  const commitAndAnimate = useCallback((direction: SwipeDirection) => {
    const attempt: DismissAttempt = {
      direction,
      commit: 'pending',
    };
    pendingDismiss.current = attempt;
    animateCommittedExit(direction);
    void onCommit(direction)
      .then((committed) => {
        attempt.commit = committed ? 'accepted' : 'rejected';
        settleDismiss(attempt);
      })
      .catch(() => {
        attempt.commit = 'rejected';
        settleDismiss(attempt);
      });
  }, [animateCommittedExit, onCommit, settleDismiss]);

  useEffect(() => () => {
    const attempt = pendingDismiss.current;
    if (attempt === null) return;
    pendingDismiss.current = null;
    // An accepted write must never leave with the card. The exit animation is
    // gone either way, so publish now rather than stranding the deck behind an
    // animation that can no longer report.
    if (attempt.commit === 'accepted') onExitCompleteRef.current(attempt.direction);
  }, []);

  const requestDismiss = useCallback((direction: SwipeDirection) => {
    if (isBusy.value) return;
    // The exit animation owns translateY (-18 lift); make sure an interrupted
    // vertical peek gesture cannot keep the axis locked against it.
    panAxis.value = AXIS_UNLOCKED;
    isBusy.value = true;
    triggerSwipeThresholdHaptic();
    void commitAndAnimate(direction);
  }, [commitAndAnimate, isBusy, panAxis]);

  useImperativeHandle(ref, () => ({
    dismiss: requestDismiss,
  }));

  /* eslint-disable react-hooks/refs -- Gesture callbacks run after render on the UI thread. */
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin(() => {
          if (!isTopOfStack.value || isBusy.value) return;
          peekGestureStartProgress.value = peekProgress.value;
        })
        .onUpdate((event) => {
          if (!isTopOfStack.value || isBusy.value) return;
          const prevAxis = panAxis.value;
          panAxis.value = getPanAxisLock(
            panAxis.value,
            event.translationX,
            event.translationY,
          );
          if (panAxis.value === AXIS_VERTICAL) {
            const ratio = getPeekProgressForTranslation(
              peekGestureStartProgress.value,
              event.translationY,
            );
            peekProgress.value = ratio;
            translateY.value = -ratio * PEEK_TRAVEL_PX;
            return;
          }
          if (panAxis.value === AXIS_UNLOCKED) return;
          if (prevAxis === AXIS_UNLOCKED && peekProgress.value > 0.01) {
            // A previously settled-open peek must collapse with a spring the
            // moment the horizontal axis takes over — never snap 190px in one
            // frame.
            peekProgress.value = withSpring(0, PEEK_SETTLE_SPRING);
            translateY.value = withSpring(0, { damping: 18, stiffness: 220 });
          }
          translateX.value = event.translationX;
          if (peekProgress.value <= 0.01) {
            translateY.value = event.translationY * 0.18;
          }
          swipeProgress.value = Math.max(
            -1,
            Math.min(1, event.translationX / cardWidth),
          );
          const distanceRatio = Math.abs(event.translationX) / cardWidth;
          if (!thresholdArmed.value && distanceRatio >= SWIPE_THRESHOLD_RATIO) {
            thresholdArmed.value = true;
            scheduleOnRN(triggerSwipeThresholdHaptic);
          } else if (
            thresholdArmed.value &&
            distanceRatio <= SWIPE_DISARM_RATIO
          ) {
            thresholdArmed.value = false;
          }
        })
        .onEnd((event) => {
          if (!isTopOfStack.value) return;
          // onBegin and onUpdate already bail while a commit is in flight, so
          // this pan never moved the card; end it the same way instead of
          // falling through to resetPosition(), which would clear isBusy and
          // let the same card commit twice.
          if (isBusy.value) return;
          if (panAxis.value === AXIS_VERTICAL) {
            const target = getPeekSettle(peekProgress.value);
            peekProgress.value = withSpring(target, PEEK_SETTLE_SPRING);
            translateY.value = withSpring(
              -target * PEEK_TRAVEL_PX,
              PEEK_SETTLE_SPRING,
            );
            panAxis.value = AXIS_UNLOCKED;
            return;
          }
          panAxis.value = AXIS_UNLOCKED;
          // Score the gesture's OWN end translation, not translateX.value.
          // The animated value only ever holds the last sample onUpdate got to
          // process; the sample immediately before liftoff arrives on the end
          // event alone. Judging the stale value silently discarded swipes the
          // handler had already measured past the threshold — device evidence
          // 2026-09-22: end tx=100 evTx=120.63 vx=0 cardWidth=371.43, i.e. 26.9%
          // scored for a 32.5% swipe, one sample behind (threshold 28%).
          const direction = getSwipeDecision({
            translationX: event.translationX,
            velocityX: event.velocityX,
            cardWidth,
          });
          if (direction) {
            if (!thresholdArmed.value) {
              thresholdArmed.value = true;
              scheduleOnRN(triggerSwipeThresholdHaptic);
            }
            isBusy.value = true;
            scheduleOnRN(commitAndAnimate, direction);
            return;
          }

          resetPosition();
        })
        .onFinalize(() => {
          // Runs after onEnd and on system cancellation alike; keep it cheap
          // and idempotent so cancelled pans never leave the axis locked.
          panAxis.value = AXIS_UNLOCKED;
        }),
    [
      cardWidth,
      commitAndAnimate,
      isBusy,
      isTopOfStack,
      panAxis,
      peekGestureStartProgress,
      peekProgress,
      resetPosition,
      swipeProgress,
      thresholdArmed,
      translateX,
      translateY,
    ],
  );
  /* eslint-enable react-hooks/refs */

  const cardStyle = useAnimatedStyle(() => {
    const rotation = interpolate(
      translateX.value,
      [-cardWidth, 0, cardWidth],
      reducedMotion ? [0, 0, 0] : [-7, 0, 7],
      Extrapolation.CLAMP,
    );

    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { rotate: `${rotation}deg` },
      ],
    };
  });

  const skipStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      translateX.value,
      [-swipeThreshold, -cardWidth * SWIPE_INTENT_RATIO, 0],
      [1, 0, 0],
      Extrapolation.CLAMP,
    );
    return {
      opacity,
      transform: [{ scale: reducedMotion ? 1 : interpolate(opacity, [0, 1], [0.9, 1.06]) }],
    };
  });

  const keepStyle = useAnimatedStyle(() => {
    const opacity = interpolate(
      translateX.value,
      [0, cardWidth * SWIPE_INTENT_RATIO, swipeThreshold],
      [0, 0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity,
      transform: [{ scale: reducedMotion ? 1 : interpolate(opacity, [0, 1], [0.9, 1.06]) }],
    };
  });

  const content = (
    <Animated.View
      testID="swipe-card-frame"
      style={[
        styles.card,
        { width: cardWidth, height: cardHeight, backgroundColor: theme.surface },
        cardStyle,
      ]}>
        <View
          key={interactive ? 'card-a11y-interactive' : 'card-a11y-inert'}
          accessible={interactive}
          accessibilityRole="imagebutton"
          aria-label={interactive ? accessibilityLabel : undefined}
          accessibilityActions={interactive ? [
            { name: 'dismiss', label: t('discover.dismiss') },
            { name: 'save', label: t('discover.save') },
          ] : undefined}
          onAccessibilityAction={interactive ? (event) => {
            if (event.nativeEvent.actionName === 'dismiss') requestDismiss('left');
            if (event.nativeEvent.actionName === 'save') requestDismiss('right');
          } : undefined}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
        <Image
          source={imageSource}
          style={[styles.artwork, imageLayout]}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={motion.imageTransition}
          onError={() => setFailedUrl(displayUrl)}
        />
        {imageFailed ? (
          <View
            testID="swipe-card-image-failed"
            style={styles.imageFailed}
            aria-label={t('discover.imageFailed')}>
            <X color={theme.textSecondary} size={28} />
          </View>
        ) : null}

        <Animated.View
          aria-hidden
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, skipStyle]}>
          <LinearGradient
            colors={['rgba(18, 18, 20, 0)', 'rgba(18, 18, 20, 0.24)']}
            locations={[0.48, 1]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          aria-hidden
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, keepStyle]}>
          <LinearGradient
            colors={['rgba(25, 134, 91, 0.22)', 'rgba(25, 134, 91, 0)']}
            locations={[0, 0.52]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        <Animated.View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.stamp, styles.skipStamp, skipStyle]}>
          <X color="#FFFFFF" size={22} strokeWidth={2.6} />
        </Animated.View>
        <Animated.View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.stamp, styles.keepStamp, keepStyle]}>
          <Heart color="#FFFFFF" size={22} strokeWidth={2.6} fill="#FFFFFF" />
        </Animated.View>
      </Animated.View>
  );

  return <GestureDetector gesture={panGesture}>{content}</GestureDetector>;
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    borderRadius: 8,
    borderCurve: 'continuous',
    boxShadow: '0 14px 36px rgba(24, 25, 28, 0.16)',
  },
  artwork: {
    position: 'absolute',
  },
  imageFailed: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stamp: {
    position: 'absolute',
    top: 16,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipStamp: {
    right: 16,
    backgroundColor: actionColors.dismiss,
    transform: [{ rotate: '14deg' }],
  },
  keepStamp: {
    left: 16,
    backgroundColor: actionColors.save,
    transform: [{ rotate: '-14deg' }],
  },
});
