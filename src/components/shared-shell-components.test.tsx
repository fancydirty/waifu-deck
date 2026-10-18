import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { IconButton } from '@/components/icon-button';
import * as IconButtonModule from '@/components/icon-button';
import { ScreenState } from '@/components/screen-state';
import { darkColors, lightColors } from '@/theme/colors';

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('shared shell components', () => {
  test('clamps tooltips inside every viewport edge', () => {
    const getTooltipPlacement = (IconButtonModule as typeof IconButtonModule & {
      getTooltipPlacement?: (input: {
        anchorX: number;
        anchorY: number;
        anchorWidth: number;
        anchorHeight: number;
        tooltipWidth: number;
        tooltipHeight: number;
        viewportWidth: number;
        viewportHeight: number;
      }) => { left: number; top: number };
    }).getTooltipPlacement;

    expect(getTooltipPlacement).toBeDefined();
    expect(getTooltipPlacement?.({
      anchorX: 0,
      anchorY: 0,
      anchorWidth: 48,
      anchorHeight: 48,
      tooltipWidth: 160,
      tooltipHeight: 40,
      viewportWidth: 200,
      viewportHeight: 100,
    })).toEqual({ left: 8, top: 56 });
    expect(getTooltipPlacement?.({
      anchorX: 176,
      anchorY: 72,
      anchorWidth: 48,
      anchorHeight: 48,
      tooltipWidth: 160,
      tooltipHeight: 40,
      viewportWidth: 224,
      viewportHeight: 120,
    })).toEqual({ left: 56, top: 24 });
  });

  test('IconButton exposes a stable disabled command target', async () => {
    await render(
      <IconButton label="关闭" disabled onPress={jest.fn()}>
        <Text>X</Text>
      </IconButton>,
    );

    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toHaveStyle({
      minWidth: 48,
      minHeight: 48,
    });
  });

  test('IconButton shows an absolute tooltip on hover and focus while composing handlers', async () => {
    const onHoverIn = jest.fn();
    const onHoverOut = jest.fn();
    const onFocus = jest.fn();
    const onBlur = jest.fn();
    await render(
      <IconButton
        label="关闭"
        tooltip="关闭预览"
        onHoverIn={onHoverIn}
        onHoverOut={onHoverOut}
        onFocus={onFocus}
        onBlur={onBlur}
        onPress={jest.fn()}>
        <Text>X</Text>
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: '关闭' });

    expect(screen.queryByText('关闭预览')).not.toBeOnTheScreen();
    await fireEvent(button, 'hoverIn');
    expect(screen.getByText('关闭预览')).toBeOnTheScreen();
    expect(screen.getByLabelText('关闭提示')).toHaveStyle({
      position: 'absolute',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
    });
    expect(button).toHaveStyle({ minWidth: 48, minHeight: 48 });

    await fireEvent(button, 'focus');
    await fireEvent(button, 'hoverOut');
    expect(screen.getByText('关闭预览')).toBeOnTheScreen();
    await fireEvent(button, 'blur');
    expect(screen.queryByText('关闭预览')).not.toBeOnTheScreen();

    expect(onHoverIn).toHaveBeenCalledTimes(1);
    expect(onHoverOut).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('keeps %s destructive button contrast at or above 4.5:1', (_name, theme) => {
    const destructiveText = (
      theme as typeof theme & { destructiveText: string }
    ).destructiveText;
    expect(destructiveText).toBe('#FFFFFF');
    expect(contrastRatio(theme.dismiss, destructiveText)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(['loading', 'empty', 'offline', 'error', 'exhausted'] as const)(
    'renders an unframed %s state',
    async (kind) => {
      await render(<ScreenState kind={kind} />);

      expect(screen.getByLabelText(`screen-state-${kind}`)).toBeOnTheScreen();
    },
  );

  test('offers an accessible retry command when supplied', async () => {
    await render(<ScreenState kind="error" onRetry={jest.fn()} />);

    expect(screen.getByRole('button', { name: '重试' })).toBeEnabled();
  });

  test('leaves noncompact state copy uncapped for accessibility scaling', async () => {
    await render(<ScreenState kind="error" onRetry={jest.fn()} />);

    for (const copy of ['暂时无法完成', '请稍后重试', '重试']) {
      expect(screen.getByText(copy).props.maxFontSizeMultiplier).toBeUndefined();
    }
  });
});
