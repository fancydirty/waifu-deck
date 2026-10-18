import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, userEvent } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { Animated, StyleSheet } from 'react-native';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { SettingsToggle } from './settings-toggle';

test.each(['light', 'dark'] as const)('%s toggle uses the drawn 42 by 24 track and token fills', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    <SettingsToggle testID="on" accessibilityLabel="On" value onValueChange={jest.fn()} />
    <SettingsToggle testID="off" accessibilityLabel="Off" value={false} onValueChange={jest.fn()} />
  </>);

  expect(screen.getByTestId('on')).toHaveStyle({
    width: 42, height: 24, borderRadius: metrics.radius.circle, paddingHorizontal: 3,
    backgroundColor: colors[scheme].save,
  });
  expect(screen.getByTestId('off')).toHaveStyle({
    width: 42, height: 24, borderRadius: metrics.radius.circle, paddingHorizontal: 3,
    backgroundColor: colors[scheme].switchTrackOff,
  });
  for (const id of ['on', 'off']) {
    const toggle = screen.getByTestId(id);
    expect(toggle.props.hitSlop).toEqual({ top: 12, bottom: 12, left: 3, right: 3 });
    expect(toggle.props.value).toBeUndefined();
    expect(toggle.props.onValueChange).toBeUndefined();
    expect(toggle.props.accessibilityState).toEqual(expect.objectContaining({ checked: id === 'on', disabled: false }));
    expect(StyleSheet.flatten(toggle.props.style).minHeight).toBeUndefined();
    expect(StyleSheet.flatten(toggle.props.style).minWidth).toBeUndefined();
  }
  expect(screen.getByRole('switch', { name: 'On' })).toBe(screen.getByTestId('on'));
  expect(screen.getByRole('switch', { name: 'On' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Off' })).not.toBeChecked();

  const thumbs = screen.container.queryAll((node) => StyleSheet.flatten(node.props.style)?.width === 18);
  expect(thumbs).toHaveLength(2);
  thumbs.forEach((thumb) => expect(thumb).toHaveStyle({ width: 18, height: 18, borderRadius: metrics.radius.circle }));
});

function thumbStyle(testID: string) {
  const thumbs = screen.getByTestId(testID).queryAll((node) => node.type === 'View');
  expect(thumbs).toHaveLength(1);
  return StyleSheet.flatten(thumbs[0]!.props.style);
}

test.each(['light', 'dark'] as const)('%s toggle dims disabled tracks and thumbs while enabled toggles stay opaque', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    {[true, false].map((value) => <SettingsToggle key={String(value)} testID={`disabled-${value}`}
      value={value} disabled onValueChange={jest.fn()} />)}
    {[true, false].map((value) => <SettingsToggle key={`enabled-${value}`} testID={`enabled-${value}`}
      value={value} onValueChange={jest.fn()} />)}
  </>);

  for (const value of [true, false]) {
    expect(StyleSheet.flatten(screen.getByTestId(`disabled-${value}`).props.style).opacity).toBe(0.38);
    expect(StyleSheet.flatten(screen.getByTestId(`enabled-${value}`).props.style).opacity).toBe(1);
  }
});

test.each(['light', 'dark'] as const)('%s busy toggle blocks presses and reports disabled without dimming', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const onValueChange = jest.fn();
  await render(<>
    <SettingsToggle testID="busy-on" value busy onValueChange={onValueChange} />
    <SettingsToggle testID="busy-off" value={false} busy onValueChange={onValueChange} />
  </>);

  for (const id of ['busy-on', 'busy-off']) {
    const host = screen.getByTestId(id);
    await userEvent.press(host);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(host).toBeDisabled();
    expect(host.props.accessibilityState.disabled).toBe(true);
    expect(host.props.onStartShouldSetResponder()).toBe(false);
    expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
  }
});

test.each(['light', 'dark'] as const)('%s busy toggle looks exactly like the idle toggle with the same value', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    {[true, false].map((value) => <SettingsToggle key={`idle-${value}`} testID={`idle-${value}`}
      value={value} onValueChange={jest.fn()} />)}
    {[true, false].map((value) => <SettingsToggle key={`busy-${value}`} testID={`busy-${value}`}
      value={value} busy onValueChange={jest.fn()} />)}
  </>);

  for (const value of [true, false]) {
    const idle = screen.getByTestId(`idle-${value}`);
    const busy = screen.getByTestId(`busy-${value}`);
    expect(StyleSheet.flatten(busy.props.style)).toEqual(StyleSheet.flatten(idle.props.style));

    const { transform: idleTransform, ...idleThumbStyle } = thumbStyle(`idle-${value}`);
    const { transform: busyTransform, ...busyThumbStyle } = thumbStyle(`busy-${value}`);
    expect(busyThumbStyle).toEqual(idleThumbStyle);
    expect(busyTransform).toEqual(idleTransform);
    expect(busyTransform).toEqual([{ translateX: value ? 18 : 0 }]);
    expect(busy.props.needsOffscreenAlphaCompositing).toEqual(idle.props.needsOffscreenAlphaCompositing);
    expect(busy.props.hitSlop).toEqual(idle.props.hitSlop);
  }
});

test.each(['light', 'dark'] as const)('%s toggle composites its track and thumb together in enabled and disabled states', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    {[true, false].flatMap((disabled) => [true, false].map((value) =>
      <SettingsToggle key={`${disabled}-${value}`} testID={`toggle-${disabled}-${value}`}
        value={value} disabled={disabled} onValueChange={jest.fn()} />))}
  </>);

  for (const disabled of [true, false]) {
    for (const value of [true, false]) {
      expect(screen.getByTestId(`toggle-${disabled}-${value}`).props.needsOffscreenAlphaCompositing).toBe(true);
    }
  }
});

test.each(['light', 'dark'] as const)('%s toggle renders the on thumb at 18 and the off thumb at 0', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    <SettingsToggle testID="on" value onValueChange={jest.fn()} />
    <SettingsToggle testID="off" value={false} onValueChange={jest.fn()} />
  </>);

  expect(thumbStyle('on').transform).toEqual([{ translateX: 18 }]);
  expect(thumbStyle('off').transform).toEqual([{ translateX: 0 }]);
});

test.each(['light', 'dark'] as const)('%s toggle thumb uses the switchThumb fill in both states', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    <SettingsToggle testID="on" value onValueChange={jest.fn()} />
    <SettingsToggle testID="off" value={false} onValueChange={jest.fn()} />
  </>);

  for (const id of ['on', 'off']) {
    expect(thumbStyle(id).backgroundColor).toBe(colors[scheme].switchThumb);
  }
});

test.each(['light', 'dark'] as const)('%s toggle thumb retains its soft shadow and elevation in both states', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<>
    <SettingsToggle testID="on" value onValueChange={jest.fn()} />
    <SettingsToggle testID="off" value={false} onValueChange={jest.fn()} />
  </>);

  for (const id of ['on', 'off']) {
    expect(thumbStyle(id)).toMatchObject({
      shadowColor: colors[scheme].toggleShadow, shadowOpacity: 0.18, shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 }, elevation: 1,
    });
  }
});

test('toggle forwards enabled presses and ignores disabled presses through its Pressable', async () => {
  const onValueChange = jest.fn();
  const disabledChange = jest.fn();
  await render(<>
    <SettingsToggle testID="enabled" value={false} onValueChange={onValueChange} />
    <SettingsToggle testID="disabled" value onValueChange={disabledChange} disabled />
  </>);

  await userEvent.press(screen.getByTestId('enabled'));
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenCalledWith(true);
  await userEvent.press(screen.getByTestId('disabled'));
  expect(disabledChange).not.toHaveBeenCalled();
  expect(screen.getByTestId('disabled')).toBeDisabled();
});

test('toggle starts a native 120ms animation on the same value for every value change', async () => {
  const animations: Animated.CompositeAnimation[] = [];
  const timing = jest.spyOn(Animated, 'timing').mockImplementation(() => {
    const animation = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    animations.push(animation);
    return animation;
  });
  try {
    const onValueChange = jest.fn();
    const view = await render(<SettingsToggle testID="animated-toggle" value={false} onValueChange={onValueChange} />);
    const progress = timing.mock.calls[0]?.[0];
    expect(progress).toBeInstanceOf(Animated.Value);
    expect(timing).toHaveBeenCalledTimes(1);
    expect(timing).toHaveBeenNthCalledWith(1, progress, { toValue: 0, duration: 120, useNativeDriver: true });
    expect(animations[0]!.start).toHaveBeenCalledTimes(1);

    await view.rerender(<SettingsToggle testID="animated-toggle" value onValueChange={onValueChange} />);
    expect(timing).toHaveBeenCalledTimes(2);
    expect(timing.mock.calls[1]![0]).toBe(progress);
    expect(timing).toHaveBeenNthCalledWith(2, progress, { toValue: 1, duration: 120, useNativeDriver: true });
    expect(animations[1]!.start).toHaveBeenCalledTimes(1);

    await view.rerender(<SettingsToggle testID="animated-toggle" value={false} onValueChange={onValueChange} />);
    expect(timing).toHaveBeenCalledTimes(3);
    expect(timing.mock.calls[2]![0]).toBe(progress);
    expect(timing).toHaveBeenNthCalledWith(3, progress, { toValue: 0, duration: 120, useNativeDriver: true });
    expect(animations[2]!.start).toHaveBeenCalledTimes(1);
  } finally {
    timing.mockRestore();
  }
});

test('toggle source uses tokenized geometry and animated thumb direction', () => {
  const source = readFileSync(join(__dirname, 'settings-toggle.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).toContain('theme.save');
  expect(source).toContain('theme.switchTrackOff');
  expect(source).toContain('theme.switchThumb');
  expect(source).toContain('theme.toggleShadow');
  expect(source).toContain('return <Pressable testID={testID}');
  expect(source).toContain('width: 42');
  expect(source).toContain('height: 24');
  expect(source).toContain('width: 18');
  expect(source).toContain('outputRange: [0, 18]');
  expect(source).not.toContain('minHeight');
  expect(source).not.toContain('minWidth');
});
