/**
 * R8.10: the native resolve of `segmented-control` must be a real interactive
 * control. The iOS-only `@react-native-segmented-control/segmented-control`
 * stub rendered as a static shell on Android — `onChange` never fired — while
 * Jest's `.web.tsx` resolution masked the gap. This suite targets the NATIVE
 * resolve (`src/components/segmented-control.tsx`) directly so a regression
 * back to the iOS-only re-export fails here.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import SegmentedControl from '@/components/segmented-control';

jest.mock('react-native/Libraries/Utilities/Platform', () => {
  const platform = {
    OS: 'android',
    select: (value: Record<string, unknown>) => value.android,
  };
  return { __esModule: true, default: platform, ...platform };
});

describe('SegmentedControl (native resolve, Android)', () => {
  test('pressing a segment fires onChange with the pressed index', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        testID="native-segmented"
        accessibilityLabel="模式"
        values={['安全', '混合', '仅成人']}
        selectedIndex={0}
        onChange={onChange}
      />,
    );

    fireEvent.press(screen.getByText('混合'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].nativeEvent.selectedSegmentIndex).toBe(1);
    expect(onChange.mock.calls[0][0].nativeEvent.value).toBe('混合');
  });

  test('the already-selected segment still reports the press (settings rows persist on re-press)', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        accessibilityLabel="模式"
        values={['A', 'B']}
        selectedIndex={1}
        onChange={onChange}
      />,
    );

    fireEvent.press(screen.getByText('B'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].nativeEvent.selectedSegmentIndex).toBe(1);
  });

  test('a disabled control does not fire onChange', async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        accessibilityLabel="模式"
        values={['A', 'B']}
        selectedIndex={0}
        enabled={false}
        onChange={onChange}
      />,
    );

    fireEvent.press(screen.getByText('B'));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('exposes radio-group semantics for screen readers', async () => {
    await render(
      <SegmentedControl
        accessibilityLabel="内容模式"
        values={['A', 'B']}
        selectedIndex={0}
      />,
    );

    const group = screen.getByLabelText('内容模式');
    expect(group).toHaveProp('role', 'radiogroup');
    const selected = screen.getByLabelText('内容模式：A');
    const unselected = screen.getByLabelText('内容模式：B');
    expect(selected).toHaveProp('accessibilityState', expect.objectContaining({ checked: true }));
    expect(unselected).toHaveProp('accessibilityState', expect.objectContaining({ checked: false }));
  });
});