import * as Linking from 'expo-linking';
import { LinearGradient } from 'expo-linear-gradient';
import { Heart, RotateCcw, X } from 'lucide-react-native';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { ScreenState } from '@/components/screen-state';
import {
  SwipeCard,
  type SwipeCardHandle,
  type SwipeCardProps,
  type SwipeDirection,
} from '@/components/swipe-card';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { TAB_BAR_RESERVE } from '@/theme/tab-bar-geometry';
import {
  useDiscovery,
  type DiscoverViewModel,
} from './use-discovery';
import { PeekInfoLayer } from './peek-info-layer';

export type { DiscoverViewModel } from './use-discovery';

type SwipeCardComponent = React.ComponentType<SwipeCardProps>;
type DeckCardRole = 'active' | 'next';

type DiscoverViewProps = {
  viewModel: DiscoverViewModel;
  SwipeCardComponent?: SwipeCardComponent;
  safeVerticalInsets?: number;
  safeAreaTop?: number;
  viewport?: { width: number; height: number; fontScale?: number };
};

const NEXT_CARD_OPACITY = 0.7;
const NEXT_CARD_SCALE = 0.975;
const NEXT_CARD_OFFSET_Y = 8;
const CARD_PROMOTION_DURATION = 160;
const SWIPE_ACTION_INTENT = 0.12;
const SWIPE_ACTION_THRESHOLD = 0.28;
const rejectQueuedDecision = async () => false;
const ignoreQueuedExit = () => undefined;

function DeckCardLayer({
  role,
  card,
  cardWidth,
  cardHeight,
  cardRef,
  SwipeCardComponent,
  onCommit,
  onExitComplete,
  swipeProgress,
  peekProgress,
}: {
  role: DeckCardRole;
  card: SwipeCardProps['card'];
  cardWidth: number;
  cardHeight: number;
  cardRef: React.RefObject<SwipeCardHandle | null>;
  SwipeCardComponent: SwipeCardComponent;
  onCommit: SwipeCardProps['onCommit'];
  onExitComplete: SwipeCardProps['onExitComplete'];
  swipeProgress: NonNullable<SwipeCardProps['swipeProgress']>;
  peekProgress: NonNullable<SwipeCardProps['peekProgress']>;
}) {
  const isActive = role === 'active';
  const { t } = useAppTranslation();
  const reducedMotion = useReducedMotion();
  const promotion = useSharedValue(isActive ? 1 : 0);

  useEffect(() => {
    promotion.value = withTiming(isActive ? 1 : 0, {
      duration: reducedMotion ? 1 : CARD_PROMOTION_DURATION,
    });
  }, [isActive, promotion, reducedMotion]);

  const layerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(promotion.value, [0, 1], [NEXT_CARD_OPACITY, 1]),
    transform: [
      {
        translateY: interpolate(
          promotion.value,
          [0, 1],
          [NEXT_CARD_OFFSET_Y, 0],
        ),
      },
      {
        scale: interpolate(
          promotion.value,
          [0, 1],
          [NEXT_CARD_SCALE, 1],
        ),
      },
    ],
  }));

  return (
    <Animated.View
      testID={isActive ? 'active-card-layer' : 'next-card-layer'}
      aria-hidden={isActive ? undefined : true}
      accessibilityElementsHidden={isActive ? undefined : true}
      importantForAccessibility={isActive ? undefined : 'no-hide-descendants'}
      style={[
        {
          // R8.14: the layer fills the deck; the SwipeCard pins itself to the
          // fixed deck rectangle (owner reverted R8.7-2) and centers the
          // contained artwork inside it. 'box-none' lets touches pass through
          // to the peek info layer beneath.
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: isActive ? 'box-none' : 'none',
          zIndex: isActive ? 3 : 1,
        },
        layerStyle,
      ]}>
      <SwipeCardComponent
        ref={isActive ? cardRef : undefined}
        card={card}
        cardWidth={cardWidth}
        cardHeight={cardHeight}
        onCommit={isActive ? onCommit : rejectQueuedDecision}
        onExitComplete={isActive ? onExitComplete : ignoreQueuedExit}
        interactive={isActive}
        accessibilityLabel={t(
          isActive ? 'discover.currentImage' : 'discover.nextImage',
          { id: card.id },
        )}
        swipeProgress={isActive ? swipeProgress : undefined}
        peekProgress={isActive ? peekProgress : undefined}
      />
    </Animated.View>
  );
}

/**
 * Board #24: the action row is [rewind · heart · X]. Heart and X decide the
 * active card; rewind undoes the newest decision still in the history.
 */
type DeckActionKind = 'rewind' | 'save' | 'dismiss';

function DeckAction({
  kind,
  label,
  disabled,
  progress,
  onPress,
}: {
  kind: DeckActionKind;
  label: string;
  disabled: boolean;
  progress: SharedValue<number>;
  onPress: () => void;
}) {
  const theme = useAppThemeColors();
  const reducedMotion = useReducedMotion();
  const isSave = kind === 'save';
  const size = isSave ? 72 : 52;
  // Rewind wears the X's quiet chrome: bordered disc, 20 dp stroked icon.
  const SecondaryIcon = kind === 'rewind' ? RotateCcw : X;
  // Owner 2026-09-27: with nothing to rewind the whole button goes
  // half-transparent — disc, border and arrow — not just the icon, so an
  // unavailable rewind reads as unavailable at a glance.
  const fadeWholeButton = kind === 'rewind' && disabled;
  const actionStyle = useAnimatedStyle(() => {
    // A decision button grows with the swipe that would press it: save with a
    // right swipe, dismiss with a left one. Rewind answers no swipe direction,
    // so it never scales.
    let directedProgress = 0;
    if (kind === 'save') directedProgress = Math.max(0, progress.value);
    else if (kind === 'dismiss') directedProgress = Math.max(0, -progress.value);
    return {
      transform: [{
        scale: reducedMotion
          ? 1
          : interpolate(
            directedProgress,
            [0, SWIPE_ACTION_INTENT, SWIPE_ACTION_THRESHOLD],
            [1, 1, 1.06],
            'clamp',
          ),
      }],
    };
  });

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          borderWidth: isSave ? 0 : 1,
          borderColor: theme.border,
          backgroundColor: isSave ? undefined : theme.surfaceSecondary,
          boxShadow: isSave ? '0 12px 26px rgba(240, 99, 122, 0.4)' : undefined,
          opacity: fadeWholeButton ? 0.38 : 1,
        },
        actionStyle,
      ]}>
      {isSave ? (
        <LinearGradient
          colors={[theme.save, theme.saveDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <Pressable
        testID={`discover-${kind}`}
        role="button"
        aria-label={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => ({
          width: '100%',
          height: '100%',
          minWidth: metrics.minimumHitArea,
          minHeight: metrics.minimumHitArea,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: fadeWholeButton ? 1 : disabled ? 0.38 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed && !disabled && !reducedMotion ? 0.94 : 1 }],
        })}>
        {isSave ? (
          <Heart color="#FFFFFF" fill="#FFFFFF" size={26} strokeWidth={2.1} />
        ) : (
          <SecondaryIcon color={theme.textSecondary} size={20} strokeWidth={2.2} />
        )}
      </Pressable>
    </Animated.View>
  );
}

// R8.17: the vertical budget under the deck is COMPOSED of named parts — no
// more "- 210" magic number. The floating tab bar is absolutely positioned
// (see (tabs)/_layout.tsx), so the deck must reserve for it explicitly:
//   TAB_BAR_RESERVE  the shared floating-bar occupancy (geometry module)
//   ACTION_ROW_HEIGHT the always-mounted action row (R8.9)
//   column gaps + root bottom padding
// A change to the bar's height now re-budgets the deck automatically instead
// of silently shoving the action buttons under the bar again.
const ACTION_ROW_HEIGHT = 76;
// One medium gap sits between deck and action row; the second is the root's
// TOP padding band under safeAreaTop (paddingTop = safeAreaTop + medium).
const DECK_COLUMN_GAPS = metrics.spacing.medium * 2;
const ROOT_BOTTOM_PADDING = metrics.spacing.small;

export function getDiscoverDeckSize(
  windowWidth: number,
  windowHeight: number,
  safeVerticalInsets: number,
) {
  const horizontalPadding = windowWidth < 380
    ? metrics.spacing.medium
    : metrics.contentPadding;
  const width = Math.min(windowWidth - horizontalPadding * 2, 560);
  const reservedBottom = TAB_BAR_RESERVE
    + ACTION_ROW_HEIGHT
    + DECK_COLUMN_GAPS
    + ROOT_BOTTOM_PADDING;
  const height = Math.max(
    180,
    Math.min(windowHeight - safeVerticalInsets - reservedBottom, 720),
  );
  return { width, height, horizontalPadding };
}

// R8.2b: everything the deck stacks over its BOTTOM edge — the action row and
// the floating toast — must get out of the peek panel's way. The panel opens
// against that same edge and its only control (view source) sits at its
// bottom, so chrome left standing there covers the link and, with an opaque
// background, becomes the gesture-handler touch target for the whole band.
// One rule, shared, so the two cannot drift apart.
export function getDiscoverPeekChromeStyle(
  peek: number,
  resting: 'auto' | 'box-none',
) {
  'worklet';
  return {
    opacity: 1 - peek,
    pointerEvents: peek > 0.5 ? ('none' as const) : resting,
  };
}

export function getDiscoverFeedbackLayout(fontScale: number) {
  const largeText = fontScale >= 1.5;
  return {
    minHeight: largeText ? 64 : metrics.minimumHitArea,
    maxHeight: largeText ? 76 : 64,
    paddingHorizontal: largeText ? metrics.spacing.small : metrics.spacing.medium,
    paddingVertical: largeText ? metrics.spacing.small / 2 : 0,
  };
}

function DeckFeedback({
  decisionError,
  fontScale,
  peekProgress,
}: {
  decisionError: string | null;
  fontScale: number;
  peekProgress: SharedValue<number>;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const layout = getDiscoverFeedbackLayout(fontScale);
  // Resting 'box-none' is the load-bearing half: the toast paints above the
  // active card, and the gesture-handler traversal walks the deck's children
  // last-first, so an opaque 'auto' box would become the touch target and
  // stop the walk before the card's pan handler — a swipe/peek dead zone
  // across the toast's band for as long as the error shows. 'box-none'
  // recurses into children only, and the only child is a 'none' view, so the
  // pan reaches the card.
  const peekStyle = useAnimatedStyle(() =>
    getDiscoverPeekChromeStyle(peekProgress.value, 'box-none'));
  // R8.2 + board #24: only transient failures — a decide or a rewind that did
  // not land. A decision itself shows nothing: the rewind button is both its
  // feedback and its undo. The deck's connection status is no longer a
  // persistent banner either — offline is normal browsing, not an error, and
  // the bar used to cover the artwork top.
  if (!decisionError) return null;

  return (
    <Animated.View
      aria-label={t('discover.feedback')}
      style={[{
        // R8.2b: a sticker on the deck, not a row in the column. Absolute
        // insets keep it off the layout pass entirely, so appearing cannot
        // shove the action row down under the floating tab bar. zIndex 4 is
        // the top of the deck's ladder (next 1, peek 2, active 3).
        position: 'absolute',
        left: metrics.spacing.small,
        right: metrics.spacing.small,
        bottom: metrics.spacing.small,
        zIndex: 4,
        // Resting value lives in the static style too, so the pan stays alive
        // under the toast even if the animated style ever drops the key; the
        // peek style only overrides it to 'none' while the peek panel is open.
        pointerEvents: 'box-none',
        minHeight: layout.minHeight,
        maxHeight: layout.maxHeight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: layout.paddingHorizontal,
        paddingVertical: layout.paddingVertical,
        borderRadius: metrics.radius.large,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)',
        overflow: 'hidden',
      }, peekStyle]}>
      {/* The wrapper is not decoration. 'box-none' above sends the gesture
          walk into these children, and a bare <Text> is a leaf that the walk
          claims as its touch target on sight — on Android only a view group
          honours pointerEvents, never a text node. Boxing the message in a
          'none' <View> makes the walk skip the subtree whole, which is what
          keeps the toast band pannable. */}
      <View style={{ flex: 1, pointerEvents: 'none' }}>
        <Text
          numberOfLines={2}
          adjustsFontSizeToFit
          style={{
            color: theme.textSecondary,
            fontSize: 13,
            fontWeight: '500',
          }}>
          {decisionError}
        </Text>
      </View>
    </Animated.View>
  );
}

export function DiscoverView({
  viewModel,
  SwipeCardComponent = SwipeCard,
  safeVerticalInsets = 0,
  safeAreaTop = 0,
  viewport,
}: DiscoverViewProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const windowDimensions = useWindowDimensions();
  const width = viewport?.width ?? windowDimensions.width;
  const height = viewport?.height ?? windowDimensions.height;
  const fontScale = viewport?.fontScale ?? windowDimensions.fontScale;
  const cardRef = useRef<SwipeCardHandle>(null);
  const swipeProgress = useSharedValue(0);
  const peekProgress = useSharedValue(0);
  const {
    width: deckWidth,
    height: deckHeight,
    horizontalPadding,
  } = getDiscoverDeckSize(width, height, safeVerticalInsets);
  const { active, queued } = viewModel.state.deck;
  const next = queued[0] ?? null;
  const cardLayers: { card: SwipeCardProps['card']; role: DeckCardRole }[] = [];
  if (next) cardLayers.push({ card: next, role: 'next' });
  if (active) cardLayers.push({ card: active, role: 'active' });

  // Runs before paint, so the promoted card never shows a frame of the
  // outgoing card's swipe progress. This is the single owner of the reset:
  // the deck advance (owned by the hook's commitDecision) does not touch the
  // shared values itself.
  useLayoutEffect(() => {
    swipeProgress.value = 0;
    peekProgress.value = 0;
  }, [active?.id, peekProgress, swipeProgress]);

  // Faded-out buttons must not swallow taps meant for the peek info layer.
  // Fields are copied out one by one rather than spread: object spread inside
  // a worklet can compile to a Babel helper the UI thread cannot call.
  const actionsStyle = useAnimatedStyle(() => {
    const chrome = getDiscoverPeekChromeStyle(peekProgress.value, 'auto');
    return {
      opacity: chrome.opacity,
      pointerEvents: chrome.pointerEvents,
      transform: [{ translateY: peekProgress.value * 40 }],
    };
  });

  // R8.3: the pan gesture is memoized on these two callbacks. Recreating them
  // per render rebuilt the Gesture object mid-exit, so a fast second swipe
  // landed on a handler that was being torn down. The ref keeps the identity
  // stable for the gesture while always calling the latest view model.
  const viewModelRef = useRef(viewModel);
  useLayoutEffect(() => {
    viewModelRef.current = viewModel;
  });

  const commitDecision = useCallback(
    async (direction: SwipeDirection) =>
      // Backlog #11: the hook advances the visible deck synchronously and
      // enqueues the durable write — there is no separate publish step. Wrapped
      // in a resolved promise so SwipeCard's `onCommit: (dir) => Promise<boolean>`
      // contract is unchanged.
      viewModelRef.current.commitDecision(
        direction === 'right' ? 'saved' : 'dismissed',
      ),
    [],
  );
  return (
    <View
      testID="screen-discover"
      aria-label={t('discover.screen')}
      style={{
        flex: 1,
        alignItems: 'center',
        gap: metrics.spacing.medium,
        paddingHorizontal: horizontalPadding,
        paddingTop: safeAreaTop + metrics.spacing.medium,
        paddingBottom: metrics.spacing.small,
        backgroundColor: theme.surface,
      }}>
      <View
        aria-label={t('discover.deck')}
        style={{
          width: deckWidth,
          height: deckHeight,
          position: 'relative',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {active === null ? (
          <ScreenState
            compact
            fontScale={fontScale}
            kind={viewModel.state.kind === 'ready' ? 'loading' : viewModel.state.kind}
            message={viewModel.state.message}
            onRetry={
              viewModel.state.kind === 'error' || viewModel.state.kind === 'offline'
                ? () => void viewModel.retry()
                : undefined
            }
          />
        ) : (
          <>
            <PeekInfoLayer
              card={active}
              progress={peekProgress}
              onOpenSource={active.sourceUrl
                ? () => void Linking.openURL(active.sourceUrl!).catch(() => undefined)
                : undefined}
            />
            {cardLayers.map(({ card, role }) => (
              <DeckCardLayer
                key={card.id}
                role={role}
                card={card}
                cardWidth={deckWidth}
                cardHeight={deckHeight}
                cardRef={cardRef}
                SwipeCardComponent={SwipeCardComponent}
                onCommit={commitDecision}
                onExitComplete={ignoreQueuedExit}
                swipeProgress={swipeProgress}
                peekProgress={peekProgress}
              />
            ))}
          </>
        )}

        {/* R8.2b: the transient toast floats over the deck's BOTTOM edge, above
            the card layers and clear of the artwork top (R8.2). It is rendered
            last so it stacks on top, and it is absolutely positioned so the
            root column stays exactly [deck, actions] whether or not it shows:
            the card and the action buttons never move when it appears. Painting
            on top must not mean taking the touch: the box is 'box-none' so the
            card keeps its pan under the toast, and the toast fades out with the
            action row while the peek panel is open so it never covers the view-
            source link. Board #24: it carries errors only, and renders nothing
            otherwise — a decision raises no toast. */}
        <DeckFeedback
          decisionError={viewModel.decisionError}
          fontScale={fontScale}
          peekProgress={peekProgress}
        />
      </View>

      {/* R8.9: The action row is always mounted. `active` is null on every refill
          window, not just true exhaustion, so gating the row on it made the
          buttons disappear mid-session and shifted this gap-based column.
          Board #24: [rewind · heart · X]. Heart and X act on the card, so they
          wait for one; rewind acts on the history, so it follows `canRewind`
          alone and stays live on an empty deck and right after a swipe. */}
      <Animated.View
        aria-label={t('discover.actions')}
        style={[
          {
            width: deckWidth,
            minHeight: 76,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: metrics.spacing.large,
          },
          actionsStyle,
        ]}>
        <DeckAction
          kind="rewind"
          label={t('discover.rewind')}
          disabled={!viewModel.canRewind}
          progress={swipeProgress}
          onPress={() => void viewModel.rewind()}
        />
        <DeckAction
          kind="save"
          label={t('discover.save')}
          disabled={!viewModel.canDecide}
          progress={swipeProgress}
          onPress={() => cardRef.current?.dismiss('right')}
        />
        <DeckAction
          kind="dismiss"
          label={t('discover.dismiss')}
          disabled={!viewModel.canDecide}
          progress={swipeProgress}
          onPress={() => cardRef.current?.dismiss('left')}
        />
      </Animated.View>
    </View>
  );
}

export function DiscoverScreen({ safeAreaTop }: { safeAreaTop?: number } = {}) {
  const insets = useSafeAreaInsets();
  const viewModel = useDiscovery();
  return (
    <DiscoverView
      viewModel={viewModel}
      safeVerticalInsets={insets.top + insets.bottom}
      safeAreaTop={safeAreaTop ?? insets.top}
    />
  );
}
