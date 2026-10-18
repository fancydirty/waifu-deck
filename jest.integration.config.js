/**
 * Integration suites run against a real S3-compatible backend (MinIO locally,
 * R2 later) instead of a fetch fake. They are excluded from `npm test` by the
 * main config's `testPathIgnorePatterns` and are driven by
 * `npm run verify:byos-minio`, which supplies the BYOS_IT_* environment.
 *
 * This project deliberately does NOT use the `jest-expo` preset. That preset's
 * setup files (which Jest concatenates, so a config cannot opt out) install
 * Expo's native `fetch`, whose native module is stubbed under Jest: every
 * request resolves to an inert object with no status. React Native's fallback
 * fetch is XHR-based and equally mocked, so under the preset no real socket is
 * reachable and a wire-compat gate would prove nothing. A plain Node
 * environment gives the suites the real `fetch`/`Response` this gate needs.
 *
 * The transform and `@/` mapping below are copied from the resolved jest-expo
 * preset so modules compile exactly as they do under `npm test`.
 */
module.exports = {
  // rootDir defaults to this file's directory: the repository root.
  testEnvironment: 'node',
  transform: {
    '\\.[jt]sx?$': [
      'babel-jest',
      {
        presets: [require.resolve('expo/internal/babel-preset.js')],
        caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@noble/hashes))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  testMatch: ['<rootDir>/src/integration/**/*.integration.test.ts'],
  // Native-only modules the BYOS stack imports at module scope. `expo-crypto`
  // is now the REAL AES-GCM shim over Node WebCrypto (P5 Task 1 supersedes
  // P3C decision #9, which kept real crypto out of this gate): its combined
  // layout is IV||ciphertext||tag, byte-for-byte what the native module
  // produces — see the citations in `src/test/expo-crypto-real.ts`. Secure
  // storage is never the subject here because production takes an injected
  // port.
  moduleNameMapper: {
    '^expo-crypto$': '<rootDir>/src/test/expo-crypto-real.ts',
    '^expo-secure-store$': '<rootDir>/src/test/expo-secure-store-double.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Real network round-trips against a container, not in-process fakes.
  testTimeout: 30000,
};
