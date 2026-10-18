import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, userEvent } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import { SettingsButton } from './settings-button';

test.each(['light', 'dark'] as const)('%s button variants use the approved fills, text and 48dp frame', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<><SettingsButton variant="primary" testID="primary" onPress={jest.fn()}>Save</SettingsButton>
    <SettingsButton variant="ghost" testID="ghost" onPress={jest.fn()}>Cancel</SettingsButton>
    <SettingsButton variant="danger" testID="danger" onPress={jest.fn()}>Delete</SettingsButton></>);
  const expected = [
    ['primary', colors[scheme].save, colors[scheme].destructiveText],
    ['ghost', colors[scheme].controlFill, colors[scheme].text],
    ['danger', colors[scheme].danger, colors[scheme].destructiveText],
  ] as const;
  for (const [id, backgroundColor, color] of expected) {
    const button = screen.getByTestId(id);
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe(id === 'primary' ? 'Save' : id === 'ghost' ? 'Cancel' : 'Delete');
    expect(button).toHaveStyle({ alignSelf: 'flex-start', marginVertical: -7, paddingVertical: 7 });
    expect(button.props.hitSlop).toBeUndefined();
    const inners = screen.container.queryAll((node) => {
      const style = StyleSheet.flatten(node.props.style);
      return style?.minHeight === 34 && style?.backgroundColor === backgroundColor;
    });
    expect(inners).toHaveLength(1);
    expect(inners[0]).toHaveStyle({ minHeight: 34, paddingHorizontal: 12, borderRadius: metrics.settingsRadius.button, backgroundColor });
    expect(screen.getByText(id === 'primary' ? 'Save' : id === 'ghost' ? 'Cancel' : 'Delete')).toHaveStyle({ ...settingsTypography.buttonLabel, color });
  }
});

test('button disabled state is exposed to accessibility and source has no inline literals', async () => {
  await render(<SettingsButton variant="primary" disabled testID="disabled" onPress={jest.fn()}>Save</SettingsButton>);
  const button = screen.getByTestId('disabled');
  expect(button).toBeDisabled();
  expect(button.props.accessibilityState).toEqual({ disabled: true });
  const source = readFileSync(join(__dirname, 'settings-button.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('settingsTypography.buttonLabel');
  expect(source).toContain('metrics.settingsRadius.button');
  expect(source).toContain('onPress={onPress}');
});

test('button press, disabled press, icon accessibility and accessible name follow the public contract', async () => {
  const onPress = jest.fn();
  const disabledPress = jest.fn();
  await render(<>
    <SettingsButton variant="primary" testID="pressable" icon={<ReactNative.View testID="button-icon" />} onPress={onPress}>Save</SettingsButton>
    <SettingsButton variant="primary" testID="disabled-press" disabled onPress={disabledPress}>Disabled</SettingsButton>
  </>);
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button.props.accessibilityLabel).toBe('Save');
  expect(screen.getByTestId('button-icon').props.accessible).toBe(false);
  await userEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
  await userEvent.press(screen.getByTestId('disabled-press'));
  expect(disabledPress).not.toHaveBeenCalled();
});
