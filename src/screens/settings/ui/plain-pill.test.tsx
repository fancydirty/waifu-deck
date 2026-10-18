import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet, View } from 'react-native';
import { colors } from '@/theme/colors';
import { fontFamilies, settingsTypography } from '@/theme/typography';
import { pillContainerStyle } from './pill-container';
import { PlainPill } from './plain-pill';
import { StatusPill } from '../status-pill';

test.each(['light', 'dark'] as const)('%s plain pill shares the container geometry with StatusPill but uses controlFill', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<><PlainPill label="Encrypted" icon={<View testID="icon" />} testID="plain" /><StatusPill tone="ok" label="Connected" testID="status" /></>);
  const plain = StyleSheet.flatten(screen.getByTestId('plain').props.style);
  const status = StyleSheet.flatten(screen.getByTestId('status').props.style);
  for (const key of Object.keys(pillContainerStyle) as (keyof typeof pillContainerStyle)[]) {
    expect(plain[key]).toBe(pillContainerStyle[key]);
    expect(status[key]).toBe(pillContainerStyle[key]);
  }
  expect(plain.backgroundColor).toBe(colors[scheme].controlFill);
  expect(status.backgroundColor).toBe(colors[scheme].okSoft);
  expect(settingsTypography.plainPill).toMatchObject({ fontSize: 12, fontFamily: fontFamilies.sans });
  expect(screen.getByText('Encrypted')).toHaveStyle({ ...settingsTypography.plainPill, color: colors[scheme].text });
  expect(screen.getByTestId('icon').props.accessible).toBe(false);
});

test('plain pill source spreads the shared container and has no inline colour, font or radius literals', () => {
  const source = readFileSync(join(__dirname, 'plain-pill.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('pillContainerStyle');
  expect(source).toContain('settingsTypography.plainPill');
});
