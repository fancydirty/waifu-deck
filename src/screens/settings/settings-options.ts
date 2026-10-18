import type {
  AnimationMode,
  MaximumBytes,
  MinimumWidth,
  Orientation,
  PrefetchDepth,
  StylePreference,
} from '@/features/waifu/types';

export const ORIENTATION_VALUES: readonly Orientation[] = ['portrait', 'landscape', 'any'];
export const ANIMATION_VALUES: readonly AnimationMode[] = ['exclude', 'include', 'only'];
export const STYLE_PREFERENCE_VALUES: readonly StylePreference[] = [
  'any',
  'prefer-3d',
  'prefer-2d',
];
// R8.20 (owner 2026-09-09): the visible 「预加载数量」 control is how many cards
// ahead stay image-warmed and reserved — 30/40/60. The internal first-paint
// batch is a constant (DISCOVERY_FIRST_PAINT_BATCH), not a setting.
export const PREFETCH_DEPTH_VALUES: readonly PrefetchDepth[] = [30, 40, 60];
export const MIN_WIDTH_OPTIONS: readonly { label: string; value: MinimumWidth }[] = [
  { label: '', value: 0 },
  { label: '720 px', value: 720 },
  { label: '1080 px', value: 1080 },
  { label: '1440 px', value: 1440 },
];
export const MAX_BYTES_OPTIONS: readonly { label: string; value: MaximumBytes }[] = [
  { label: '', value: 0 },
  { label: '2 MB', value: 2_000_000 },
  { label: '5 MB', value: 5_000_000 },
  { label: '10 MB', value: 10_000_000 },
];
