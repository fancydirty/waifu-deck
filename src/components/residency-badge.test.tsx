import { render, screen } from '@testing-library/react-native';

import { CloudBadge, isSyncedToCloud } from './residency-badge';

jest.mock('lucide-react-native', () => {
  const { View } = jest.requireActual('react-native');
  const Cloud = (props: Record<string, unknown>) => (
    <View testID="cloud-icon" {...props} />
  );
  return { Cloud };
});

const reanimated = {
  reducedMotion: false,
  repeats: 0,
  repeatArgs: null as unknown,
  timingArgs: null as unknown,
  /** Whether the shared value was set to 0 before the repeat was started. */
  resetToZero: false,
};
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return {
    ...actual,
    __esModule: true,
    default: actual.default,
    useReducedMotion: () => reanimated.reducedMotion,
    useSharedValue: (initial: number) => {
      const sv = actual.useSharedValue(initial) as { value: unknown };
      return new Proxy(sv, {
        set(target, key, value) {
          // A `withRepeat` result is an object; a plain 0 is the reset.
          if (key === 'value' && value === 0) reanimated.resetToZero = true;
          return Reflect.set(target, key, value);
        },
      });
    },
    // Record the arguments and pass through to the real animations: a stub
    // return value here would not be a driveable animation for withRepeat.
    withTiming: (...args: unknown[]) => {
      reanimated.timingArgs = args;
      return (actual.withTiming as (...a: unknown[]) => unknown)(...args);
    },
    withRepeat: (...args: unknown[]) => {
      reanimated.repeats += 1;
      reanimated.repeatArgs = args;
      return (actual.withRepeat as (...a: unknown[]) => unknown)(...args);
    },
  };
});

describe('CloudBadge', () => {
  test('renders a solid Cloudflare-orange cloud, hidden from assistive tech', async () => {
    await render(<CloudBadge />);
    const badge = screen.getByTestId('cloud-badge', { includeHiddenElements: true });
    expect(badge).toHaveStyle({ width: 26, height: 26, borderRadius: 13 });
    expect(badge.props['aria-hidden']).toBe(true);
    expect(badge.props.accessibilityElementsHidden).toBe(true);
    expect(badge.props.importantForAccessibility).toBe('no-hide-descendants');
    const icon = screen.getByTestId('cloud-icon', { includeHiddenElements: true });
    expect(icon.props.color).toBe('#F38020');
    expect(icon.props.fill).toBe('#F38020');
    expect(screen.queryByTestId('residency-dot', { includeHiddenElements: true })).toBeNull();
  });
});

describe('isSyncedToCloud', () => {
  test('only a protected asset is synced', () => {
    expect(isSyncedToCloud({ protection: 'protected' })).toBe(true);
  });

  test.each(['unprotected', 'pending', 'failed'] as const)('%s is not synced', (protection) => {
    expect(isSyncedToCloud({ protection })).toBe(false);
  });

  test('a local original does not change the answer', () => {
    const protectedEntry = { protection: 'protected', hasLocalOriginal: true };
    const pendingEntry = { protection: 'pending', hasLocalOriginal: true };
    expect(isSyncedToCloud(protectedEntry)).toBe(true);
    expect(isSyncedToCloud(pendingEntry)).toBe(false);
  });
});

// --- K6-2: the real-percentage ring (spec §2 G3) ---------------------------

describe('CloudBadge progress ring', () => {
  function arc() {
    return screen.getByTestId('cloud-progress-arc', { includeHiddenElements: true });
  }

  /**
   * react-native-svg normalises `strokeDasharray` into an array of strings on
   * the host node, so read the drawn segment from there rather than from the
   * string this component passes in.
   */
  function dashArc(): number {
    const dashes = arc().props.strokeDasharray as readonly string[];
    return Number(dashes[0]);
  }

  function circumference(): number {
    return 2 * Math.PI * Number(arc().props.r);
  }

  test('draws an arc of exactly the reported fraction', async () => {
    await render(<CloudBadge progress={0.4} />);
    expect(screen.getByTestId('cloud-progress', { includeHiddenElements: true }))
      .toBeTruthy();
    expect(dashArc() / circumference()).toBeCloseTo(0.4, 5);
  });

  test('0 draws nothing and 1 draws the whole circle', async () => {
    const { rerender } = await render(<CloudBadge progress={0} />);
    expect(dashArc()).toBeCloseTo(0, 5);
    await rerender(<CloudBadge progress={1} />);
    expect(dashArc() / circumference()).toBeCloseTo(1, 5);
  });

  test('starts the arc at twelve o’clock, not at three', async () => {
    await render(<CloudBadge progress={0.25} />);
    // An SVG circle's zero angle is the +x axis; a progress ring must read
    // clockwise from the top. react-native-svg resolves the rotate() into a
    // matrix, so assert the matrix a -90° rotation produces: [0,-1,1,0,…].
    const matrix = arc().props.matrix as readonly number[];
    expect(matrix[0]).toBeCloseTo(0, 6);
    expect(matrix[1]).toBeCloseTo(-1, 6);
    expect(matrix[2]).toBeCloseTo(1, 6);
    expect(matrix[3]).toBeCloseTo(0, 6);
  });

  test('the ring replaces the cloud — a tile never shows both', async () => {
    await render(<CloudBadge progress={0.4} />);
    expect(screen.queryByTestId('cloud-icon', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
  });

  test('no progress means the cloud, exactly as before', async () => {
    await render(<CloudBadge />);
    expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('cloud-progress', { includeHiddenElements: true })).toBeNull();
  });

  test('the ring is decorative — the percentage lives in the tile’s label', async () => {
    await render(<CloudBadge progress={0.4} />);
    const ring = screen.getByTestId('cloud-progress', { includeHiddenElements: true });
    expect(ring.props['aria-hidden']).toBe(true);
    expect(ring.props.accessibilityElementsHidden).toBe(true);
    expect(ring.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  test('a value outside 0–1 can never draw a longer arc than the circle', async () => {
    await render(<CloudBadge progress={1.8} />);
    expect(dashArc() / circumference()).toBeCloseTo(1, 5);
  });
});

describe('CloudBadge indeterminate spinner (P12-B)', () => {
  beforeEach(() => {
    reanimated.reducedMotion = false;
    reanimated.repeats = 0;
    reanimated.repeatArgs = null;
    reanimated.timingArgs = null;
    reanimated.resetToZero = false;
  });

  test("'indeterminate' draws a quarter arc that spins, and never the cloud or a percentage ring", async () => {
    await render(<CloudBadge progress="indeterminate" />);
    const spinner = screen.getByTestId('cloud-progress-indeterminate', { includeHiddenElements: true });
    expect(spinner.props['aria-hidden']).toBe(true);
    const arc = screen.getByTestId('cloud-progress-arc', { includeHiddenElements: true });
    const dashes = arc.props.strokeDasharray as readonly string[];
    expect(Number(dashes[0]) / (2 * Math.PI * Number(arc.props.r))).toBeCloseTo(0.25, 5);
    expect(screen.queryByTestId('cloud-progress', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
    expect(reanimated.repeats).toBe(1);
    // Same a11y contract as the other two badge states.
    expect(spinner.props.accessibilityElementsHidden).toBe(true);
    expect(spinner.props.importantForAccessibility).toBe('no-hide-descendants');
    // Starts at twelve o'clock like the percentage ring (matters only when
    // the arc is frozen under reduce-motion, but the convention is shared).
    const matrix = arc.props.matrix as readonly number[];
    expect(matrix[0]).toBeCloseTo(0, 6);
    expect(matrix[1]).toBeCloseTo(-1, 6);
  });

  test('the spin is an endless linear full turn that starts from zero', async () => {
    await render(<CloudBadge progress="indeterminate" />);
    const [, repetitions, reverse] = reanimated.repeatArgs as unknown[];
    expect([repetitions, reverse]).toEqual([-1, false]);
    const [toValue, config] = reanimated.timingArgs as [number, { duration: number }];
    expect(toValue).toBe(360);
    expect(config.duration).toBe(1000);
    expect(reanimated.resetToZero).toBe(true);
  });

  test('under reduced motion the arc is drawn but does not spin', async () => {
    reanimated.reducedMotion = true;
    await render(<CloudBadge progress="indeterminate" />);
    expect(screen.getByTestId('cloud-progress-indeterminate', { includeHiddenElements: true })).toBeTruthy();
    expect(reanimated.repeats).toBe(0);
  });
});
