import { act, render, screen, userEvent, within } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StyleSheet } from 'react-native';

import { PersistedSwitch, SettingRow } from './setting-row';

jest.mock('lucide-react-native', () => ({ ChevronRight: () => null }));

test('detail truncation applies only to detail, leaving title and value unchanged', async () => {
  await render(<SettingRow
    testID="row" label="Title" value="Value" detail="Full detail"
    detailNumberOfLines={1} detailEllipsizeMode="tail"
    accessibilityLabel="Title, Full detail" onPress={jest.fn()}
  />);
  const row = screen.getByTestId('row');
  const detail = within(row).getByText('Full detail');
  expect(detail).toHaveProp('numberOfLines', 1);
  expect(detail).toHaveProp('ellipsizeMode', 'tail');
  for (const text of ['Title', 'Value']) {
    expect(within(row).getByText(text).props.numberOfLines).toBeUndefined();
    expect(within(row).getByText(text).props.ellipsizeMode).toBeUndefined();
  }
  expect(screen.getByRole('button', { name: 'Title, Full detail' })).toBe(row);
});

test('existing callers retain unbounded detail and label-only accessible name', async () => {
  await render(<SettingRow label="Title" value="Value" detail="Detail" onPress={jest.fn()} />);
  expect(screen.getByText('Detail').props.numberOfLines).toBeUndefined();
  expect(screen.getByText('Detail').props.ellipsizeMode).toBeUndefined();
  expect(screen.getByRole('button', { name: 'Title' })).toBeOnTheScreen();
});

test('non-pressable rows support the same optional detail props', async () => {
  await render(<SettingRow label="Title" detail="Detail" detailNumberOfLines={2} detailEllipsizeMode="middle" />);
  expect(screen.getByText('Detail')).toHaveProp('numberOfLines', 2);
  expect(screen.getByText('Detail')).toHaveProp('ellipsizeMode', 'middle');
  expect(screen.queryByRole('button')).toBeNull();
});


test('PersistedSwitch renders the drawn toggle without native host value props', async () => {
  const onValueChange = jest.fn(async () => true);
  await render(<PersistedSwitch testID="persisted" accessibilityLabel="Persisted" value onValueChange={onValueChange} />);
  const toggle = screen.getByRole('switch', { name: 'Persisted' });
  expect(toggle.props.value).toBeUndefined();
  expect(toggle.props.onValueChange).toBeUndefined();
  expect(toggle).toBeChecked();
  await userEvent.press(toggle);
  expect(onValueChange).toHaveBeenCalledWith(false);
});

test('PersistedSwitch disables during a pending save and rolls back a rejected save', async () => {
  let reject!: (reason: unknown) => void;
  const pending = new Promise<boolean>((_, rejectPromise) => { reject = rejectPromise; });
  const onValueChange = jest.fn(() => pending);
  await render(<PersistedSwitch testID="persisted" accessibilityLabel="Persisted" value onValueChange={onValueChange} />);
  const toggle = screen.getByRole('switch', { name: 'Persisted' });

  await userEvent.press(toggle);
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeDisabled();
  await act(async () => reject(new Error('save failed')));
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
});

test('PersistedSwitch keeps its held save opaque while blocking a second press', async () => {
  let resolve!: (saved: boolean) => void;
  const pending = new Promise<boolean>((resolvePromise) => { resolve = resolvePromise; });
  const onValueChange = jest.fn(() => pending);
  const onPendingChange = jest.fn();
  await render(<PersistedSwitch testID="persisted" value onValueChange={onValueChange} onPendingChange={onPendingChange} />);

  await userEvent.press(screen.getByTestId('persisted'));
  const host = screen.getByTestId('persisted');
  expect(host).not.toBeChecked();
  expect(host).toBeDisabled();
  expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
  await userEvent.press(host);
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenCalledWith(false);
  expect(onPendingChange).toHaveBeenCalledWith(true);

  await act(async () => { resolve(true); });
  expect(host).toBeEnabled();
  expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});

test('PersistedSwitch caller busy blocks presses without dimming', async () => {
  const onValueChange = jest.fn(async () => true);
  await render(<PersistedSwitch testID="persisted" value busy onValueChange={onValueChange} />);
  const host = screen.getByTestId('persisted');

  await userEvent.press(host);
  expect(onValueChange).not.toHaveBeenCalled();
  expect(host).toBeChecked();
  expect(host).toBeDisabled();
  expect(StyleSheet.flatten(host.props.style).opacity).toBe(1);
});

test('PersistedSwitch caller disabled stays dimmed and blocks presses', async () => {
  const onValueChange = jest.fn(async () => true);
  await render(<PersistedSwitch testID="persisted" value disabled onValueChange={onValueChange} />);
  const host = screen.getByTestId('persisted');

  await userEvent.press(host);
  expect(onValueChange).not.toHaveBeenCalled();
  expect(host).toBeDisabled();
  expect(StyleSheet.flatten(host.props.style).opacity).toBe(0.38);
});

test('PersistedSwitch clears a caught-up draft so later persisted changes reach the toggle', async () => {
  let resolve!: (saved: boolean) => void;
  const pending = new Promise<boolean>((resolvePromise) => { resolve = resolvePromise; });
  const onValueChange = jest.fn(() => pending);
  const view = await render(<PersistedSwitch testID="persisted" accessibilityLabel="Persisted" value onValueChange={onValueChange} />);
  expect(screen.getByTestId('persisted')).toBeChecked();

  await userEvent.press(screen.getByTestId('persisted'));
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenCalledWith(false);
  expect(screen.getByTestId('persisted')).not.toBeChecked();
  expect(screen.getByTestId('persisted')).toBeDisabled();
  await act(async () => { resolve(true); });
  expect(screen.getByTestId('persisted')).toBeEnabled();

  await view.rerender(<PersistedSwitch testID="persisted" accessibilityLabel="Persisted" value={false} onValueChange={onValueChange} />);
  expect(screen.getByTestId('persisted')).not.toBeChecked();
  await view.rerender(<PersistedSwitch testID="persisted" accessibilityLabel="Persisted" value onValueChange={onValueChange} />);
  expect(screen.getByTestId('persisted')).toBeChecked();
});

test('PersistedSwitch source narrows props and delegates its visual to SettingsToggle', () => {
  const source = readFileSync(join(__dirname, 'setting-row.tsx'), 'utf8');
  const start = source.indexOf('export type PersistedSwitchProps');
  expect(start).toBeGreaterThanOrEqual(0);
  const slice = source.slice(start);
  expect(slice).toContain('Readonly');
  expect(slice).toContain('SettingsToggle');
  expect(slice).not.toMatch(/\bSwitchProps\b/);
  expect(slice).not.toContain('<Switch');
  expect(slice).not.toContain('thumbColor');
  expect(slice).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(slice).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
});
