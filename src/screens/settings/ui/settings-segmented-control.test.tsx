import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, userEvent } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { StyleSheet } from 'react-native';
import i18n from '@/i18n';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { settingsTypography } from '@/theme/typography';
import SettingsSegmentedControl from './settings-segmented-control';

beforeEach(async () => { await i18n.changeLanguage('en'); });

test.each(['light', 'dark'] as const)('%s segmented control uses the drawn track and 48dp option frames', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const onChange = jest.fn();
  await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={1} testID="segments" onChange={onChange} />);

  const group = screen.getByTestId('segments');
  expect(group).toHaveStyle({ minHeight: 36, backgroundColor: colors[scheme].controlFill,
    borderRadius: metrics.settingsRadius.track, padding: 3, gap: 2 });
  expect(group.props.role).toBe('radiogroup');
  expect(group.props['aria-label']).toBe('Content mode');
  expect(group.props.hitSlop).toBeUndefined();

  const selected = screen.getByRole('radio', { name: 'Content mode: Mixed' });
  const unselected = screen.getByRole('radio', { name: 'Content mode: SFW' });
  expect(selected).toBeChecked();
  expect(unselected).not.toBeChecked();
  expect(selected.props.accessibilityState).toEqual(expect.objectContaining({ selected: true, checked: true, disabled: false }));
  expect(selected).toHaveStyle({ flex: 1, marginVertical: -9, paddingVertical: 9 });
  expect(selected.props.hitSlop).toBeUndefined();
  expect(unselected).toHaveStyle({ flex: 1, marginVertical: -9, paddingVertical: 9 });
  const innerDraws = screen.container.queryAll((node) => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.minHeight === 30 && style?.borderRadius === metrics.settingsRadius.segment;
  });
  expect(innerDraws).toHaveLength(2);
  innerDraws.forEach((inner) => expect(inner).toHaveStyle({ minHeight: 30, paddingVertical: 6, paddingHorizontal: 4 }));
  expect(screen.getByText('Mixed')).toHaveStyle({ ...settingsTypography.segmentLabel, color: colors[scheme].text });
});

function optionDraw(label: string) {
  const draws = screen.getByRole('radio', { name: `Content mode: ${label}` })
    .queryAll((node) => node.type === 'View');
  expect(draws).toHaveLength(1);
  return draws[0]!;
}

test.each(['light', 'dark'] as const)('%s segmented options distinguish selected and unselected fills', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={1} onChange={jest.fn()} />);

  expect(StyleSheet.flatten(optionDraw('Mixed').props.style).backgroundColor).toBe(colors[scheme].controlSelected);
  expect(StyleSheet.flatten(optionDraw('SFW').props.style).backgroundColor).toBe(colors[scheme].controlFill);
});

test.each(['light', 'dark'] as const)('%s segmented options elevate only the light selected draw', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={1} onChange={jest.fn()} />);

  expect(StyleSheet.flatten(optionDraw('Mixed').props.style).elevation).toBe(scheme === 'light' ? 1 : 0);
  expect(StyleSheet.flatten(optionDraw('SFW').props.style).elevation).toBe(0);
});

test.each(['light', 'dark'] as const)('%s segmented labels distinguish selected and unselected text colours', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={1} onChange={jest.fn()} />);

  expect(StyleSheet.flatten(screen.getByText('Mixed').props.style).color).toBe(colors[scheme].text);
  expect(StyleSheet.flatten(screen.getByText('SFW').props.style).color).toBe(colors[scheme].textSecondary);
});

test.each(['light', 'dark'] as const)('%s segmented option labels stay on one line', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const values = ['SFW', 'Mixed', 'NSFW'];
  await render(<SettingsSegmentedControl title="Content mode" values={values} selectedIndex={1} onChange={jest.fn()} />);

  for (const value of values) {
    expect(screen.getByText(value).props.numberOfLines).toBe(1);
  }
});

test.each(['light', 'dark'] as const)('%s segmented option frames composite their draw and label together', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const values = ['SFW', 'Mixed', 'NSFW'];
  const view = await render(<SettingsSegmentedControl title="Content mode" values={values} selectedIndex={1} onChange={jest.fn()} />);

  for (const enabled of [true, false]) {
    if (!enabled) {
      await view.rerender(<SettingsSegmentedControl title="Content mode" values={values} selectedIndex={1} enabled={false} onChange={jest.fn()} />);
    }
    const frames = screen.getAllByRole('radio');
    expect(frames).toHaveLength(values.length);
    for (const frame of frames) {
      expect(frame.props.needsOffscreenAlphaCompositing).toBe(true);
    }
  }
});

test.each([
  ['en', ': '], ['zh-Hans', '：'], ['zh-Hant', '：'], ['ja', '：'],
] as const)('segmented option names use the %s locale separator', async (locale, separator) => {
  await i18n.changeLanguage(locale);
  await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={0} onChange={jest.fn()} />);
  expect(screen.getByRole('radio', { name: `Content mode${separator}SFW` })).toBeChecked();
});

test('segmented control forwards the selected segment press with its native event and ignores disabled segments', async () => {
  const onChange = jest.fn();
  await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={0} onChange={onChange} />);

  await userEvent.press(screen.getByRole('radio', { name: 'Content mode: Mixed' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith({ nativeEvent: { value: 'Mixed', selectedSegmentIndex: 1 } });

  onChange.mockClear();
  const disabled = await render(<SettingsSegmentedControl title="Content mode" values={['SFW', 'Mixed']} selectedIndex={0} enabled={false} testID="disabled-segments" onChange={onChange} />);
  expect(disabled.getByTestId('disabled-segments').props.accessibilityState).toEqual({ disabled: true });
  await userEvent.press(disabled.getByRole('radio', { name: 'Content mode: Mixed' }));
  expect(onChange).not.toHaveBeenCalled();
  expect(disabled.getByRole('radio', { name: 'Content mode: Mixed' })).toBeDisabled();
});

test('segmented control source uses tokenized geometry, locale names and no hit slop', () => {
  const source = readFileSync(join(__dirname, 'settings-segmented-control.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain("t('common.labelSeparator')");
  expect(source).toContain('marginVertical: -9');
  expect(source).toContain('paddingVertical: 9');
  expect(source).toContain('minHeight: 30');
  expect(source).toContain('paddingVertical: 6');
  expect(source).toContain('paddingHorizontal: 4');
  expect(source).toContain('<View style={{ minHeight: 30');
  expect(source).not.toContain('hitSlop');
});
