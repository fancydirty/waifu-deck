const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    files: ['src/components/swipe-card.tsx'],
    rules: {
      // Reanimated shared values are intentionally mutated from UI-thread worklets.
      'react-hooks/immutability': 'off',
    },
  },
  {
    files: ['src/hooks/use-color-scheme.web.ts'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]);
