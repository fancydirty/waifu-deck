import { Cloud } from 'lucide-react-native';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { useAppThemeColors } from '@/theme/colors';

/**
 * K3: the one library fact a tile shows — "this image is in my cloud". True
 * exactly when the asset is protected (its original is committed in the
 * bucket). Whether this device also holds a local original is irrelevant.
 */
export function isSyncedToCloud(entry: { protection: string }): boolean {
  return entry.protection === 'protected';
}

const BADGE_SIZE = 26;
const RING_STROKE = 2.5;
/** Inset by half the stroke so the ring is drawn fully inside the disc. */
const RING_RADIUS = (BADGE_SIZE - RING_STROKE) / 2 - 1;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export type CloudBadgeProps = {
  /**
   * K6-2 (spec §2 G3): `0`–`1`, the fraction of this asset's bytes that are
   * actually on the server right now, from
   * `library-transfer-progress.ts`. Present means a transfer is in flight and
   * the badge draws the ring instead of the cloud; the cloud is what the
   * database says afterwards, so the two are never shown together.
   *
   * Owner's binding wording: 「不是假百分比，必须得是实际的真实百分比」. The arc
   * is a straight multiplication of this value by the circumference — no easing,
   * no minimum visible sliver, no animation between values.
   *
   * P12-B (spec §4 补裁): `'indeterminate'` when a transfer is in flight but
   * its source never announced a length (a WebDAV `GET` with no
   * `Content-Length`). There is no honest percentage to draw, so the badge
   * spins a quarter arc instead of guessing one — 「转圈的感觉，但不用给进度」.
   */
  progress?: number | 'indeterminate';
};

/**
 * Solid Cloudflare-orange cloud on a dark glass disc — or, while the asset is
 * moving to or from the bucket, a real-percentage ring in the same 26px
 * footprint. Decorative only in both states: the "synced"/"uploading"
 * semantics live in the tile's accessibility label, so the badge is hidden from
 * assistive tech.
 */
export function CloudBadge({ progress }: CloudBadgeProps = {}) {
  const theme = useAppThemeColors();
  if (progress === 'indeterminate') {
    return <IndeterminateRing />;
  }
  if (typeof progress === 'number') {
    const arc = Math.max(0, Math.min(1, progress)) * RING_CIRCUMFERENCE;
    return (
      <View
        testID="cloud-progress"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.badge}>
        <Svg width={BADGE_SIZE} height={BADGE_SIZE}>
          <Circle
            testID="cloud-progress-track"
            cx={BADGE_SIZE / 2}
            cy={BADGE_SIZE / 2}
            r={RING_RADIUS}
            stroke="rgba(255, 255, 255, 0.28)"
            strokeWidth={RING_STROKE}
            fill="none"
          />
          <Circle
            testID="cloud-progress-arc"
            cx={BADGE_SIZE / 2}
            cy={BADGE_SIZE / 2}
            r={RING_RADIUS}
            stroke={theme.cloud}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            fill="none"
            // Dash on for the drawn arc, off for the rest; rotated so 0% starts
            // at twelve o'clock and fills clockwise.
            strokeDasharray={`${arc} ${RING_CIRCUMFERENCE - arc}`}
            transform={`rotate(-90 ${BADGE_SIZE / 2} ${BADGE_SIZE / 2})`}
          />
        </Svg>
      </View>
    );
  }
  return (
    <View
      testID="cloud-badge"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.badge}>
      <Cloud color={theme.cloud} fill={theme.cloud} size={15} strokeWidth={2.2} />
    </View>
  );
}

/**
 * P12-B: the same 26px disc as the percentage ring, but with a fixed quarter
 * arc that spins instead of a length proportional to real bytes — there is no
 * real fraction to draw when the source never announced a `Content-Length`.
 * Decorative like every other badge state: the tile's own label carries the
 * "Syncing…" wording for assistive tech.
 */
function IndeterminateRing() {
  const theme = useAppThemeColors();
  const reducedMotion = useReducedMotion();
  const turn = useSharedValue(0);

  useEffect(() => {
    // Always from zero: `withRepeat` restarts each lap from the value it found,
    // so a remount mid-lap (Fast Refresh, a re-run of this effect) would
    // otherwise snap back to that angle once a second. Reanimated reads the
    // reduce-motion setting once at launch, so the branch below never flips
    // while mounted — the reset is cheap insurance, not a live toggle path.
    turn.value = 0;
    if (reducedMotion) return undefined;
    turn.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(turn);
  }, [reducedMotion, turn]);

  const spin = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.value}deg` }],
  }));

  const arc = 0.25 * RING_CIRCUMFERENCE;

  return (
    <View
      testID="cloud-progress-indeterminate"
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.badge}>
      <Animated.View style={spin}>
        <Svg width={BADGE_SIZE} height={BADGE_SIZE}>
          <Circle
            testID="cloud-progress-track"
            cx={BADGE_SIZE / 2}
            cy={BADGE_SIZE / 2}
            r={RING_RADIUS}
            stroke="rgba(255, 255, 255, 0.28)"
            strokeWidth={RING_STROKE}
            fill="none"
          />
          <Circle
            testID="cloud-progress-arc"
            cx={BADGE_SIZE / 2}
            cy={BADGE_SIZE / 2}
            r={RING_RADIUS}
            stroke={theme.cloud}
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${arc} ${RING_CIRCUMFERENCE - arc}`}
            // Same twelve-o'clock origin as the percentage ring: it is where
            // the frozen reduce-motion arc sits, so the two states share one
            // convention instead of the spinner alone starting at three.
            transform={`rotate(-90 ${BADGE_SIZE / 2} ${BADGE_SIZE / 2})`}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(28, 20, 18, 0.55)',
  },
});
