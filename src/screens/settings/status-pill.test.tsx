import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';
import { cloudTypography } from '@/theme/typography';
import { pillContainerStyle } from './ui/pill-container';
import { StatusPill } from './status-pill';

test.each(['light', 'dark'] as const)('%s status pill uses existing ok/warn and distinct unreadable danger tokens', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const theme = colors[scheme];
  const view = await render(<StatusPill tone="ok" label="Connected" testID="pill" />);
  expect(StyleSheet.flatten(screen.getByTestId('pill').props.style).backgroundColor).toBe(theme.okSoft);
  expect(StyleSheet.flatten(screen.getByText('Connected').props.style).color).toBe(theme.ok);
  await view.rerender(<StatusPill tone="warn" label="Unreachable" testID="pill" />);
  expect(StyleSheet.flatten(screen.getByTestId('pill').props.style).backgroundColor).toBe(theme.warnSoft);
  expect(StyleSheet.flatten(screen.getByText('Unreachable').props.style).color).toBe(theme.warnInk);
  await view.rerender(<StatusPill tone="bad" label="Unreadable" testID="pill" />);
  expect(StyleSheet.flatten(screen.getByTestId('pill').props.style).backgroundColor).toBe(theme.dangerSoft);
  expect(StyleSheet.flatten(screen.getByText('Unreadable').props.style)).toMatchObject({ ...cloudTypography.pill, color: theme.danger });
});

test('status pill spreads the shared container geometry for every tone', async () => {
  await render(<StatusPill tone="ok" label="Connected" testID="pill" />);
  const style = StyleSheet.flatten(screen.getByTestId('pill').props.style);
  for (const key of Object.keys(pillContainerStyle) as (keyof typeof pillContainerStyle)[]) {
    expect(style[key]).toBe(pillContainerStyle[key]);
  }
});

test('status pill source spreads the shared container and has no inline colour, font or radius literals', () => {
  const source = readFileSync(join(__dirname, 'status-pill.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('pillContainerStyle');
  expect(source).toContain('cloudTypography.pill');
});
