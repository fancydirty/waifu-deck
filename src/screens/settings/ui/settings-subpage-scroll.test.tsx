import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { SettingsSubpageScroll } from './settings-subpage-scroll';

let mockInsets = { top: 31, right: 0, bottom: 24, left: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

test('owns the shared scroll geometry without adding a top safe-area inset', async () => {
  await render(<SettingsSubpageScroll testID="subpage-scroll"><Text>content</Text></SettingsSubpageScroll>);

  const scroll = screen.getByTestId('subpage-scroll');
  expect(scroll).toHaveStyle({ flex: 1, backgroundColor: colors.light.surface });
  expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
  expect(scroll.props.contentContainerStyle).toEqual({
    paddingTop: metrics.spacing.medium,
    paddingBottom: 24 + metrics.spacing.large,
  });
  expect(scroll.props.contentContainerStyle.paddingTop).not.toBe(31 + metrics.spacing.medium);
  expect(scroll.props.contentContainerStyle.paddingHorizontal).toBeUndefined();
  expect(screen.getByText('content')).toBeOnTheScreen();
});

test('clears the gesture zone even when the platform reports no bottom inset', async () => {
  // Honor PGT-AN20 / Android 16 gesture nav with the edge-to-edge window reports
  // insets.bottom ≈ 0 (measured 2026-10-10: the sources footer landed 3.7 dp inside
  // the 24 dp gesture band). The scroll keeps the designed "20 beyond the gesture
  // inset" clearance for every reported inset value.
  mockInsets = { top: 31, right: 0, bottom: 0, left: 0 };
  await render(<SettingsSubpageScroll testID="subpage-scroll"><Text>content</Text></SettingsSubpageScroll>);

  const scroll = screen.getByTestId('subpage-scroll');
  expect(scroll.props.contentContainerStyle).toEqual({
    paddingTop: metrics.spacing.medium,
    paddingBottom: metrics.gestureInset + metrics.spacing.large,
  });
});

test('shell source is a single ScrollView with token-owned geometry', async () => {
  const source = readFileSync(resolve(process.cwd(), 'src/screens/settings/ui/settings-subpage-scroll.tsx'), 'utf8');
  expect(source).toContain('ScrollView');
  expect(source).toContain('keyboardShouldPersistTaps="handled"');
  expect(source).toContain('metrics.spacing.medium');
  expect(source).toContain('metrics.spacing.large');
  expect(source).toContain('Math.max(insets.bottom, metrics.gestureInset)');
  expect(source).not.toContain('insets.top');
  expect(source).not.toContain('SafeAreaView');
});
