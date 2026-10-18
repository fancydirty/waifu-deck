import 'react-native-gesture-handler/jestSetup';

import { notifyManager } from '@tanstack/react-query';
import { setUpTests } from 'react-native-reanimated';

// The broad regression suite preserves the existing Direct behavior. Store
// restrictions are exercised with explicit policy injection in focused tests.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      version: '1.1.0',
      extra: { distributionVariant: 'direct' },
    },
  },
}));

jest.mock('expo-localization', () => ({
  getLocales: () => [{
    languageTag: 'zh-CN',
    languageCode: 'zh',
    languageScriptCode: 'Hans',
    languageRegionCode: 'CN',
    regionCode: 'CN',
    textDirection: 'ltr',
  }],
}));

setUpTests();

// Keep Query observer notifications inside the test action that triggered them.
notifyManager.setScheduler((callback) => callback());

// R8.17: screens consume safe-area insets directly (headerless tabs, floating
// bar reserves). Unit tests render surfaces outside a SafeAreaProvider, so
// provide deterministic zeros app-wide; per-screen wrappers that already
// supply a provider override this naturally.
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  const zeroInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    ...actual,
    useSafeAreaInsets: () => zeroInsets,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
});

jest.mock('react-native-worklets', () =>
  require('react-native-worklets/src/mock'),
);

declare global {
  var __WAIFU_DECK_TEST_READY__: boolean;
}

globalThis.__WAIFU_DECK_TEST_READY__ = true;

afterEach(() => {
  jest.restoreAllMocks();
});

export {};
