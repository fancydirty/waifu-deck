import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const POINTER_EVENT_SOURCES = [
  'src/components/icon-button.tsx',
  'src/screens/collection/collection-tile.tsx',
  'src/screens/discover/discover-screen.tsx',
];

test('uses style.pointerEvents instead of the deprecated React Native Web prop', () => {
  for (const sourcePath of POINTER_EVENT_SOURCES) {
    const source = readFileSync(resolve(process.cwd(), sourcePath), 'utf8');
    expect(source).not.toMatch(/\spointerEvents=/);
  }
});

test('routes settings through the warning-free web segmented control', () => {
  const settingsSource = readFileSync(
    resolve(process.cwd(), 'src/screens/settings/settings-screen.tsx'),
    'utf8',
  );
  const discoverSource = readFileSync(
    resolve(process.cwd(), 'src/screens/settings/discover-settings-screen.tsx'),
    'utf8',
  );
  const segmentedControlSource = readFileSync(
    resolve(process.cwd(), 'src/screens/settings/ui/settings-segmented-control.tsx'),
    'utf8',
  );

  // The drawn control avoids the native package's Android and web failures.
  expect(settingsSource).toMatch(
    /from\s+(['"])@\/screens\/settings\/ui\/settings-segmented-control\1/,
  );
  expect(settingsSource).not.toMatch(
    /(['"`])@react-native-segmented-control\/segmented-control(?:\/[^'"`]*)?\1/,
  );
  expect(discoverSource).toMatch(
    /from\s+(['"])@\/screens\/settings\/ui\/settings-segmented-control\1/,
  );
  expect(discoverSource).not.toMatch(
    /(['"`])@react-native-segmented-control\/segmented-control(?:\/[^'"`]*)?\1/,
  );
  expect(segmentedControlSource).not.toMatch(
    /(['"`])@react-native-segmented-control\/segmented-control(?:\/[^'"`]*)?\1/,
  );
});
