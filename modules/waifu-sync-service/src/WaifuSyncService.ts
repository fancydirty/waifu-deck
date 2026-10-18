import { requireOptionalNativeModule } from 'expo-modules-core';

import type { ImeHeightEvent, WaifuSyncServiceModule } from './WaifuSyncService.types';

/**
 * `null` on every environment that is not a Direct Android build with this
 * module linked in: Jest, web, and the Node integration gate. Callers branch on
 * that rather than crashing, so `expo-file-system` stays the fallback upload
 * path and the foreground guard becomes a no-op instead of a hard failure.
 */
export const WaifuSyncService =
  requireOptionalNativeModule<WaifuSyncServiceModule>('WaifuSyncService');

/**
 * IME height in dp while the keyboard is shown, including a height change that
 * never produces `keyboardDidShow` (API 30+ reports visibility only).
 * Where the native module is absent — iOS, web, and Jest — this is a no-op
 * subscription and the React Native keyboard events stay the only source.
 */
export function addImeHeightListener(
  listener: (event: ImeHeightEvent) => void,
): { remove(): void } {
  if (WaifuSyncService === null) return { remove() {} };
  return WaifuSyncService.addListener('onImeHeightChange', listener);
}

/**
 * N8: updates the status bar icon style on a React Native `<Modal>`'s own
 * Android `Dialog` window (`WindowInsetsControllerCompat.isAppearanceLightStatusBars`).
 * `StatusBarModule` only touches `currentActivity.window`, which the Dialog's
 * fullscreen window overrides on Android 16. No-op wherever the native module
 * is absent.
 */
export function setModalStatusBarStyle(style: 'light' | 'dark'): void {
  if (WaifuSyncService === null) return;
  WaifuSyncService.setModalStatusBarStyle(style === 'light');
}

