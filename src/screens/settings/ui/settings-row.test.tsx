import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, userEvent } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { View } from 'react-native';
import { colors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';
import { SettingsRow } from './settings-row';

jest.mock('lucide-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View: NativeView } = require('react-native');
  return { ChevronRight: (props: Record<string, unknown>) => React.createElement(NativeView, { ...props, testID: 'chevron' }) };
});

test.each(['light', 'dark'] as const)('%s pressable row preserves accessibility, tokens and child order', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const onPress = jest.fn();
  await render(<SettingsRow label="Delete library" detail="Cannot be undone" value="A very long value that must truncate"
    accessibilityLabel="Delete all images" testID="row" destructive disabled trailing={<View testID="trailing" />} chevron onPress={onPress} />);
  const row = screen.getByTestId('row');
  expect(row.props.role).toBe('button');
  expect(screen.getByRole('button', { name: 'Delete all images' })).toBe(row);
  expect(row.props.accessibilityLabel).toBe('Delete all images');
  expect(row).toBeDisabled();
  expect(row.props.accessibilityState).toEqual({ disabled: true });
  expect(row).toHaveStyle({ minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, gap: 12 });
  expect(row).not.toHaveStyle({ borderBottomWidth: 1 });
  expect(screen.getByText('Delete library')).toHaveStyle({ ...settingsTypography.rowTitle, color: colors[scheme].danger });
  expect(screen.getByText('Cannot be undone')).toHaveStyle({ ...settingsTypography.detail, color: colors[scheme].textSecondary });
  const value = screen.getByText('A very long value that must truncate');
  expect(value).toHaveStyle({ ...settingsTypography.value, color: colors[scheme].textSecondary, maxWidth: '58%' });
  expect(value.props.numberOfLines).toBe(1);
  expect(value.props.ellipsizeMode).toBe('tail');
  const order = screen.container.queryAll((node) => node.props.testID === 'trailing' || node.props.testID === 'chevron').map((node) => node.props.testID);
  expect(order).toEqual(['trailing', 'chevron']);
  const chevron = screen.getByTestId('chevron');
  expect(chevron.props.color).toBe(colors[scheme].textSecondary);
  expect(chevron.props.size).toBe(18);
  await userEvent.press(row);
  expect(onPress).not.toHaveBeenCalled();
});

test('row press calls an enabled handler once and ignores a disabled press', async () => {
  const onPress = jest.fn();
  const disabledPress = jest.fn();
  await render(<>
    <SettingsRow label="Enabled row" testID="enabled-row" onPress={onPress} />
    <SettingsRow label="Disabled row" testID="disabled-row" disabled onPress={disabledPress} />
  </>);
  await userEvent.press(screen.getByTestId('enabled-row'));
  expect(onPress).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByTestId('disabled-row'));
  expect(disabledPress).not.toHaveBeenCalled();
});

test('row falls back to its label and renders a non-pressable row as a View', async () => {
  const onPress = jest.fn();
  await render(<><SettingsRow label="Open settings" testID="pressable" onPress={onPress} /><SettingsRow label="Static" testID="plain" /></>);
  const pressable = screen.getByTestId('pressable');
  expect(screen.getByRole('button', { name: 'Open settings' })).toBe(pressable);
  expect(pressable.props.accessibilityLabel ?? pressable.props['aria-label']).toBe('Open settings');
  const plain = screen.getByTestId('plain');
  expect(String(plain.type)).toBe('View');
  expect(plain.props.onPress).toBeUndefined();
  expect(plain.props.accessibilityRole).toBeUndefined();
});

test('row source uses tokenized typography and no inline colour, font or radius literals', () => {
  const source = readFileSync(join(__dirname, 'settings-row.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('settingsTypography.rowTitle');
  expect(source).toContain('settingsTypography.detail');
  expect(source).toContain('settingsTypography.value');
  expect(source).toContain('accessibilityLabel ?? label');
  expect(source).toContain('accessibilityState={{ disabled }}');
  expect(source).toContain("maxWidth: '58%'");
});
