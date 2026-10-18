import { metrics } from './metrics';

/**
 * R8.17: the single source of truth for how much vertical space the floating
 * tab bar occupies. The bar is absolutely positioned (it overlays content),
 * so EVERY surface that must clear it derives its bottom reserve from here —
 * the discover deck-height budget and the scroll-content bottom padding of the
 * other three tabs. No surface may hardcode its own guess (the pre-R8.17
 * `- 210` magic number is exactly how the like/dislike buttons ended up under
 * the floating bar on the owner's phone).
 *
 * Keep the components of the total exported: tests assert the SUM so a visual
 * change to the bar cannot silently invalidate the reserves.
 */

/** Visual height of the floating capsule bar (tabBarStyle.height). */
export const TAB_BAR_HEIGHT = 64;

/** Margin below the bar (tabBarStyle.marginBottom). */
export const TAB_BAR_BOTTOM_MARGIN = 10;

/** Breathing room between a surface's last row and the bar's top edge. */
export const TAB_BAR_CLEARANCE = metrics.spacing.medium;

/** Total vertical space a non-scrolling surface must leave under its content. */
export const TAB_BAR_RESERVE =
  TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_MARGIN + TAB_BAR_CLEARANCE;

/** Bottom padding for scrollable content that slides under the floating bar. */
export function tabBarContentInset(bottomInset: number): number {
  return TAB_BAR_HEIGHT + TAB_BAR_BOTTOM_MARGIN + Math.max(bottomInset, 0);
}