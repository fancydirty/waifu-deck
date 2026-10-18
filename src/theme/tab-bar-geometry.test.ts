import {
  TAB_BAR_BOTTOM_MARGIN,
  TAB_BAR_CLEARANCE,
  TAB_BAR_HEIGHT,
  TAB_BAR_RESERVE,
  tabBarContentInset,
} from '@/theme/tab-bar-geometry';
import { metrics } from '@/theme/metrics';

describe('tab-bar geometry (R8.17)', () => {
  test('the reserve composes from named parts, never a magic literal', () => {
    expect(TAB_BAR_RESERVE).toBe(
      TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_MARGIN + TAB_BAR_CLEARANCE,
    );
    expect(TAB_BAR_HEIGHT).toBe(64);
    expect(TAB_BAR_BOTTOM_MARGIN).toBe(10);
    expect(TAB_BAR_CLEARANCE).toBe(metrics.spacing.medium);
  });

  test('scroll content inset covers the bar plus the system bottom inset', () => {
    expect(tabBarContentInset(0)).toBe(TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_MARGIN);
    expect(tabBarContentInset(24)).toBe(
      TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_MARGIN + 24,
    );
    // Defensive: a negative inset must not eat the bar reserve.
    expect(tabBarContentInset(-10)).toBe(TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_MARGIN);
  });

  test('the constants are the single source of truth for the floating bar', () => {
    // These values mirror (tabs)/_layout.tsx's tabBarStyle height/marginBottom.
    // A visual tweak to the capsule MUST update this module in the same
    // commit — every surface's reserve derives from here.
    expect(TAB_BAR_HEIGHT).toBe(64);
    expect(TAB_BAR_BOTTOM_MARGIN).toBe(10);
  });
});