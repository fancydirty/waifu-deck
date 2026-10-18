/**
 * R8.10: the native resolve is a plain React Native control, not the
 * iOS-only `@react-native-segmented-control/segmented-control` package —
 * that package wraps `UISegmentedControl` and has NO Android implementation,
 * so on Android (this product's only target platform) it rendered a static
 * shell where `onChange` never fired. The shared implementation is the
 * former web variant (Pressable + theme), now serving every platform.
 */
export { default } from '@/components/segmented-control-shared';
