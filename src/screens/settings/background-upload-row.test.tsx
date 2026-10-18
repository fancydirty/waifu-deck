import { useEffect } from 'react';
import { act, render, screen, userEvent, within } from '@testing-library/react-native';
import { AppState, StyleSheet, type AppStateStatus } from 'react-native';

import i18n from '@/i18n';
import { BackgroundUploadRow, type BackgroundUploadPort } from '@/screens/settings/background-upload-row';
import * as themeColors from '@/theme/colors';
import { metrics } from '@/theme/metrics';

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, useEffect: jest.fn(actual.useEffect) };
});
jest.mock('lucide-react-native', () => ({ ChevronRight: () => null }));

const DETAIL = 'Uploads may be paused by the system while the screen is locked.';

function port(allowed = false): BackgroundUploadPort {
  return {
    isBatteryOptimizationIgnored: jest.fn(() => allowed),
    requestIgnoreBatteryOptimizations: jest.fn(async () => undefined),
  };
}

beforeEach(async () => {
  jest.mocked(useEffect).mockImplementation(jest.requireActual('react').useEffect);
  await i18n.changeLanguage('en');
});

afterEach(() => {
  jest.restoreAllMocks();
});

test.each([true, false])('first render reads the native state before passive effects: allowed=%s', async (allowed) => {
  const effects: unknown[] = [];
  jest.mocked(useEffect).mockImplementation((effect) => { effects.push(effect); });
  const backgroundSync = port(allowed);
  const { unmount } = await render(<BackgroundUploadRow backgroundSync={backgroundSync} />);
  try {
    expect(effects.length).toBeGreaterThan(0);
    expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent(allowed ? 'Allowed' : 'Restricted');
    if (allowed) {
      expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
      expect(screen.queryByText(DETAIL)).toBeNull();
    } else {
      expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
      expect(screen.getByText(DETAIL)).toBeTruthy();
    }
    expect(backgroundSync.isBatteryOptimizationIgnored).toHaveBeenCalledTimes(1);
  } finally {
    await unmount();
    jest.mocked(useEffect).mockImplementation(jest.requireActual('react').useEffect);
  }
});

describe.each([
  ['light', themeColors.lightColors],
  ['dark', themeColors.darkColors],
] as const)('%s status colours', (_name, theme) => {
  test.each([true, false])('the pill uses the state tone: allowed=%s', async (allowed) => {
    jest.spyOn(themeColors, 'useAppThemeColors').mockReturnValue(theme);
    const { unmount } = await render(<BackgroundUploadRow backgroundSync={port(allowed)} />);
    try {
      const pill = screen.getByTestId('byos-background-sync-state');
      expect(pill).toHaveStyle({ backgroundColor: allowed ? theme.okSoft : theme.warnSoft });
      expect(within(pill).getByText(allowed ? 'Allowed' : 'Restricted')).toHaveStyle({
        color: allowed ? theme.ok : theme.warnInk,
      });
    } finally {
      await unmount();
    }
  });
});

test('allowed: shows Allowed without an allow button or detail', async () => {
  const { unmount } = await render(<BackgroundUploadRow backgroundSync={port(true)} />);
  expect(screen.getByText('Background uploads')).toBeTruthy();
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Allowed');
  expect(screen.queryByTestId('byos-background-sync-allow')).toBeNull();
  expect(screen.queryByText(DETAIL)).toBeNull();
  await unmount();
});

test('restricted: Allow requests permission without immediately re-reading', async () => {
  const backgroundSync = port();
  const { unmount } = await render(<BackgroundUploadRow backgroundSync={backgroundSync} />);
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
  expect(screen.getByText(DETAIL)).toBeTruthy();
  await act(async () => {
    await userEvent.press(screen.getByRole('button', { name: 'Allow' }));
  });
  expect(backgroundSync.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
  expect(backgroundSync.isBatteryOptimizationIgnored).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
  await unmount();
});

test('foreground re-read: injected subscription updates both directions', async () => {
  const isBatteryOptimizationIgnored = jest.fn().mockReturnValueOnce(false).mockReturnValue(true);
  let listener = () => {};
  const unsubscribe = jest.fn();
  const subscribeAppActive = jest.fn((callback: () => void) => {
    listener = callback;
    return unsubscribe;
  });
  const { unmount } = await render(
    <BackgroundUploadRow
      backgroundSync={{ ...port(), isBatteryOptimizationIgnored }}
      subscribeAppActive={subscribeAppActive}
    />,
  );
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
  await act(async () => listener());
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Allowed');
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  expect(screen.queryByText(DETAIL)).toBeNull();
  isBatteryOptimizationIgnored.mockReturnValue(false);
  await act(async () => listener());
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  expect(screen.getByText(DETAIL)).toBeTruthy();
  expect(isBatteryOptimizationIgnored).toHaveBeenCalledTimes(3);
  await unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test('default subscription: only active re-reads and unmount removes the listener', async () => {
  let handler: (state: AppStateStatus) => void = () => {};
  const remove = jest.fn();
  const subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((event, callback) => {
    expect(event).toBe('change');
    handler = callback;
    return { remove };
  });
  subscription.mockClear();
  const backgroundSync = port();
  const { unmount } = await render(<BackgroundUploadRow backgroundSync={backgroundSync} />);
  expect(subscription).toHaveBeenCalledTimes(1);
  expect(backgroundSync.isBatteryOptimizationIgnored).toHaveBeenCalledTimes(1);
  await act(async () => handler('background'));
  expect(backgroundSync.isBatteryOptimizationIgnored).toHaveBeenCalledTimes(1);
  jest.mocked(backgroundSync.isBatteryOptimizationIgnored).mockReturnValue(true);
  await act(async () => handler('active'));
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Allowed');
  jest.mocked(backgroundSync.isBatteryOptimizationIgnored).mockReturnValue(false);
  await act(async () => handler('active'));
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
  expect(backgroundSync.isBatteryOptimizationIgnored).toHaveBeenCalledTimes(3);
  await unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

test('request failure: a rejected request leaves Restricted without throwing', async () => {
  const backgroundSync = port();
  jest.mocked(backgroundSync.requestIgnoreBatteryOptimizations).mockRejectedValue(new Error('unavailable'));
  const { unmount } = await render(<BackgroundUploadRow backgroundSync={backgroundSync} />);
  await act(async () => {
    await userEvent.press(screen.getByRole('button', { name: 'Allow' }));
  });
  expect(backgroundSync.requestIgnoreBatteryOptimizations).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('byos-background-sync-state')).toHaveTextContent('Restricted');
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  await unmount();
});

test('the allow button keeps a 48 dp touch target in the shared small-button frame', async () => {
  const { unmount } = await render(<BackgroundUploadRow backgroundSync={port()} />);
  const button = screen.getByRole('button', { name: 'Allow' });
  const frame = StyleSheet.flatten(button.props.style) ?? {};
  // SettingsButton draws 34 dp inside a 48 dp frame (7 + 34 + 7, per spec §5).
  expect((frame.paddingVertical ?? 0) * 2 + 34).toBeGreaterThanOrEqual(48);
  expect(button).toHaveStyle({ marginVertical: -7, paddingVertical: 7 });
  // U3a mutation evidence (M14): the call site must not restyle the shared button —
  // the drawn shape is the token (settingsRadius.button = 10), no frame override.
  expect(frame.borderRadius).toBeUndefined();
  const drawn = screen.container.queryAll(() => true)
    .filter((n) => StyleSheet.flatten(n.props.style)?.borderRadius === metrics.settingsRadius.button);
  expect(drawn.length).toBeGreaterThanOrEqual(1);
  await unmount();
});
