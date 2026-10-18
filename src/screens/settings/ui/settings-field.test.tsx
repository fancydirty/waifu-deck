import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import {
  KeyboardRevealContext,
  type KeyboardRevealContextValue,
  type MeasureLayout,
} from '@/screens/settings/keyboard-reveal';
import { colors } from '@/theme/colors';
import { settingsTypography } from '@/theme/typography';

import { SettingsField } from './settings-field';

function renderField(overrides: Partial<Parameters<typeof SettingsField>[0]> = {}) {
  return render(
    <SettingsField
      testID="field"
      accessibilityLabel="API key"
      placeholder="API key"
      value=""
      onChangeText={jest.fn()}
      {...overrides}
    />,
  );
}

test('U2c2 field draws the v4 box and swaps its border with focus', async () => {
  await renderField();
  const field = screen.getByTestId('field');
  expect(field).toHaveStyle({
    ...settingsTypography.field,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1.5,
    borderRadius: 12,
    borderColor: colors.light.border,
    color: colors.light.text,
    backgroundColor: colors.light.surfaceSecondary,
  });
  const style = StyleSheet.flatten(field.props.style);
  // No outer margin: the SettingsBlock owns the insets and the second-field
  // wrapper owns the 8 gap.
  expect(style.margin).toBeUndefined();
  expect(style.marginTop).toBeUndefined();
  expect(style.marginBottom).toBeUndefined();
  expect(style.marginHorizontal).toBeUndefined();
  expect(style.marginVertical).toBeUndefined();

  await fireEvent(field, 'focus');
  expect(field).toHaveStyle({ borderColor: colors.light.save });
  await fireEvent(field, 'blur');
  expect(field).toHaveStyle({ borderColor: colors.light.border });
});

test('U2c2 field reveals its measured native input and releases it on blur, replacement focus and unmount', async () => {
  const reveal = jest.fn();
  const release = jest.fn();
  const keyboardReveal: KeyboardRevealContextValue = { reveal, release };
  const measureLayout = jest.spyOn(TextInput.prototype, 'measureLayout')
    .mockImplementation(function (this: unknown, relativeTo, onSuccess) {
      onSuccess(0, 1200, 300, 48);
    });
  const view = await render(
    <KeyboardRevealContext.Provider value={keyboardReveal}>
      <SettingsField testID="field" accessibilityLabel="API key" placeholder="API key" value="" onChangeText={jest.fn()} />
    </KeyboardRevealContext.Provider>,
  );
  const host = screen.getByTestId('field');

  await fireEvent(host, 'focus');
  expect(reveal).toHaveBeenCalledTimes(1);
  const first = reveal.mock.calls[0]![0] as MeasureLayout;
  // The registered measure delegates to the native input.
  const onSuccess = jest.fn();
  first(123, onSuccess);
  expect(measureLayout).toHaveBeenCalledTimes(1);
  expect(onSuccess).toHaveBeenCalledWith(0, 1200, 300, 48);

  await fireEvent(host, 'blur');
  expect(release).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledWith(first);

  // A replacement focus registers a fresh measure and reveals it again.
  await fireEvent(host, 'focus');
  expect(reveal).toHaveBeenCalledTimes(2);
  const second = reveal.mock.calls[1]![0] as MeasureLayout;
  expect(second).not.toBe(first);

  // Unmount releases the live registration without waiting for a blur.
  await act(async () => { await view.unmount(); });
  expect(release).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenLastCalledWith(second);
});

test('U2c2 field stays a controlled input with the native defaults and disabled editing', async () => {
  const received: string[] = [];
  function Harness() {
    const [value, setValue] = useState('');
    return (
      <SettingsField
        testID="field"
        accessibilityLabel="API key"
        placeholder="API key"
        secureTextEntry
        value={value}
        onChangeText={(next) => { received.push(next); setValue(next); }}
      />
    );
  }
  const harnessView = await render(<Harness />);
  const field = screen.getByTestId('field');
  expect(field.props.secureTextEntry).toBe(true);
  expect(field.props.autoCapitalize).toBe('none');
  expect(field.props.autoCorrect).toBe(false);
  expect(field.props.editable).toBe(true);
  expect(field.props.keyboardType ?? 'default').toBe('default');

  await fireEvent.changeText(field, 'u2-synthetic-key');
  expect(received).toEqual(['u2-synthetic-key']);
  expect(screen.getByTestId('field').props.value).toBe('u2-synthetic-key');
  await act(async () => { await harnessView.unmount(); });

  const disabledView = await renderField({ value: 'kept', disabled: true });
  const disabled = screen.getByTestId('field');
  expect(disabled.props.editable).toBe(false);
  expect(disabled.props.value).toBe('kept');
  await act(async () => { await disabledView.unmount(); });

  const urlView = await renderField({ keyboardType: 'url' });
  const url = screen.getByTestId('field');
  expect(url.props.keyboardType).toBe('url');
  expect(url.props.secureTextEntry).toBeUndefined();
  await act(async () => { await urlView.unmount(); });
});
