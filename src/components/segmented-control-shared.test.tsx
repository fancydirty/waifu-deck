import { fireEvent, render, screen, within } from '@testing-library/react-native';

import SegmentedControl from '@/components/segmented-control-shared';
import { lightColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

describe('shared segmented control', () => {
  test('renders accessible 48px radio targets and reports selection changes', async () => {
    const onChange = jest.fn();
    const onValueChange = jest.fn();
    const { rerender } = await render(
      <SegmentedControl
        accessibilityLabel="图片方向"
        values={['纵向', '横向', '不限']}
        selectedIndex={1}
        onChange={onChange}
        onValueChange={onValueChange}
      />,
    );

    const group = screen.getByLabelText('图片方向');
    const portrait = screen.getByRole('radio', { name: '图片方向：纵向' });
    const landscape = screen.getByRole('radio', { name: '图片方向：横向' });
    const any = screen.getByRole('radio', { name: '图片方向：不限' });

    expect(group).toHaveProp('role', 'radiogroup');
    expect(group).toHaveStyle({ minHeight: metrics.minimumHitArea });
    expect(group).not.toHaveStyle({ height: metrics.minimumHitArea });
    expect(portrait).toBeEnabled();
    expect(landscape).toBeSelected();
    expect(any).not.toBeSelected();
    for (const radio of [portrait, landscape, any]) {
      expect(radio).toHaveStyle({
        minHeight: 36,
        minWidth: metrics.minimumHitArea,
      });
      expect(radio).toHaveProp('hitSlop', { top: 6, bottom: 6 });
    }

    await fireEvent.press(any);
    expect(onChange).toHaveBeenCalledWith({
      nativeEvent: { value: '不限', selectedSegmentIndex: 2 },
    });
    expect(onValueChange).toHaveBeenCalledWith('不限');

    await rerender(
      <SegmentedControl
        accessibilityLabel="图片方向"
        enabled={false}
        values={['纵向', '横向', '不限']}
        selectedIndex={1}
        onChange={onChange}
        onValueChange={onValueChange}
      />,
    );

    for (const radio of [
      screen.getByRole('radio', { name: '图片方向：纵向' }),
      screen.getByRole('radio', { name: '图片方向：横向' }),
      screen.getByRole('radio', { name: '图片方向：不限' }),
    ]) {
      expect(radio).toBeDisabled();
    }
    await fireEvent.press(screen.getByRole('radio', { name: '图片方向：横向' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  test('R8.27: renders a horizontally scrollable chip row with solid selected pills', async () => {
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        values={['全部', 'SFW', 'NSFW']}
        selectedIndex={0}
      />,
    );

    const group = screen.getByLabelText('收藏内容模式');
    expect(group).toHaveProp('horizontal', true);
    expect(group).toHaveProp('showsHorizontalScrollIndicator', false);

    const all = screen.getByRole('radio', { name: '收藏内容模式：全部' });
    const sfw = screen.getByRole('radio', { name: '收藏内容模式：SFW' });

    expect(all).toHaveStyle({
      minHeight: 36,
      borderRadius: metrics.radius.circle,
      borderWidth: 1,
      backgroundColor: lightColors.text,
      borderColor: lightColors.text,
    });
    expect(sfw).toHaveStyle({
      backgroundColor: lightColors.surface,
      borderColor: lightColors.border,
    });
    // The pill must stay a 48dp touch target even though it draws 36dp tall.
    expect(all).toHaveProp('hitSlop', { top: 6, bottom: 6 });
    expect(all).toHaveStyle({ minWidth: metrics.minimumHitArea });
    expect(screen.getByText('全部')).toHaveStyle({ color: lightColors.surface });
    expect(screen.getByText('SFW')).toHaveStyle({ color: lightColors.text });
  });

  test('R8.27: renders optional per-chip counts and badges', async () => {
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        values={['全部', 'SFW', 'NSFW']}
        counts={[79, 52, 27]}
        badges={[null, null, '18+']}
        selectedIndex={0}
      />,
    );

    const all = screen.getByRole('radio', { name: '收藏内容模式：全部、79 张' });
    const sfw = screen.getByRole('radio', { name: '收藏内容模式：SFW、52 张' });
    const nsfw = screen.getByRole('radio', { name: '收藏内容模式：NSFW、27 张、18+' });

    expect(within(all).getByText('79')).toBeOnTheScreen();
    expect(within(sfw).getByText('52')).toBeOnTheScreen();
    expect(within(nsfw).getByText('27')).toBeOnTheScreen();
    expect(within(all).getByText('79')).toHaveStyle({
      color: lightColors.surfaceSecondary,
    });
    expect(within(sfw).getByText('52')).toHaveStyle({
      color: lightColors.text,
    });

    expect(within(nsfw).getByText('18+')).toBeOnTheScreen();
    expect(within(all).queryByText('18+')).toBeNull();
    expect(within(sfw).queryByText('18+')).toBeNull();
  });

  test('R8.27: short numeric chips still fill a 48dp touch target', async () => {
    // Settings' 预加载数量 row is the narrowest chip set in the app: a two-digit
    // label plus 14dp padding and a 1dp border draws ~46dp wide, which is under
    // metrics.minimumHitArea. The pill must reserve the full 48dp itself.
    await render(
      <SegmentedControl
        accessibilityLabel="预加载数量"
        values={['30', '40', '60']}
        selectedIndex={0}
      />,
    );

    for (const value of ['30', '40', '60']) {
      const chip = screen.getByRole('radio', { name: `预加载数量：${value}` });
      expect(chip).toHaveStyle({
        minHeight: 36,
        minWidth: metrics.minimumHitArea,
      });
      expect(chip).toHaveProp('hitSlop', { top: 6, bottom: 6 });
    }
  });

  test('R8.27 part 2: unselected count and badge text clear the 4.5:1 contrast floor', async () => {
    // 12sp/11sp is not large text, so WCAG AA needs 4.5:1. theme.textSecondary
    // (#A48A82) on theme.surface (#FDF7F3) is only 3.03:1. theme.text at 0.8
    // opacity blends to #766D6A = 4.75:1 on light and 9.10:1 on dark; 0.72
    // would still fall short at 3.90:1.
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        values={['全部', 'SFW', 'NSFW']}
        counts={[79, 52, 27]}
        badges={[null, null, '18+']}
        selectedIndex={0}
      />,
    );

    const all = screen.getByRole('radio', { name: '收藏内容模式：全部、79 张' });
    const sfw = screen.getByRole('radio', { name: '收藏内容模式：SFW、52 张' });
    const nsfw = screen.getByRole('radio', { name: '收藏内容模式：NSFW、27 张、18+' });

    expect(within(sfw).getByText('52')).toHaveStyle({
      color: lightColors.text,
      opacity: 0.8,
    });
    const badge = within(nsfw).getByText('18+');
    expect(badge).toHaveStyle({ color: lightColors.text });
    expect(badge.parent).toHaveStyle({
      borderColor: lightColors.text,
      opacity: 0.8,
    });

    // The selected pill is already light-on-dark and stays at full opacity.
    expect(within(all).getByText('79')).toHaveStyle({
      color: lightColors.surfaceSecondary,
      opacity: 1,
    });
  });

  test('R8.27 part 2: the accessible name carries the visible count and badge', async () => {
    // A screen reader user hears the same information a sighted user sees on
    // the chip. Without this the 「79」 and the 「18+」 are decoration only.
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        values={['全部', 'SFW', 'NSFW']}
        counts={[79, 52, 27]}
        badges={[null, null, '18+']}
        selectedIndex={0}
      />,
    );

    expect(screen.getAllByRole('radio').map((chip) => (
      chip.props.accessibilityLabel
    ))).toEqual([
      '收藏内容模式：全部、79 张',
      '收藏内容模式：SFW、52 张',
      '收藏内容模式：NSFW、27 张、18+',
    ]);
  });

  test('R8.27 part 2: a chip with no count or badge keeps its plain name', async () => {
    await render(
      <SegmentedControl
        accessibilityLabel="预加载数量"
        values={['30', '40', '60']}
        selectedIndex={0}
      />,
    );

    expect(screen.getAllByRole('radio').map((chip) => (
      chip.props.accessibilityLabel
    ))).toEqual(['预加载数量：30', '预加载数量：40', '预加载数量：60']);
  });

  test('R8.27 part 2: scrollable={false} drops the scroller so a parent row can own it', async () => {
    // The collection filter block puts the rating chips and the source chip in
    // ONE horizontal scroller (spec §4). A `role=button` chip cannot live
    // inside a `role=radiogroup`, so the radiogroup renders as a plain row and
    // the screen wraps both in its own `ScrollView horizontal`.
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        scrollable={false}
        values={['全部', 'SFW', 'NSFW']}
        selectedIndex={0}
      />,
    );

    expect(JSON.stringify(screen.toJSON())).not.toContain('RCTScrollView');

    const group = screen.getByLabelText('收藏内容模式');
    expect(group.type).toBe('View');
    expect(group).toHaveProp('role', 'radiogroup');
    expect(group.props.horizontal).toBeUndefined();
    expect(group).toHaveStyle({
      flexDirection: 'row',
      gap: metrics.spacing.small,
    });

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(screen.getByRole('radio', { name: '收藏内容模式：全部' })).toBeSelected();
    expect(screen.getByRole('radio', { name: '收藏内容模式：SFW' })).not.toBeSelected();
  });

  test('R8.27 part 2: the default variant keeps its own horizontal scroller', async () => {
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        values={['全部', 'SFW', 'NSFW']}
        selectedIndex={0}
      />,
    );

    const group = screen.getByLabelText('收藏内容模式');
    expect(group.type).toBe('RCTScrollView');
    expect(group).toHaveProp('horizontal', true);
  });

  test('R8.27: omits count text when a chip has no count', async () => {
    await render(
      <SegmentedControl
        accessibilityLabel="收藏内容模式"
        values={['全部', 'SFW']}
        counts={[7, null]}
        selectedIndex={1}
      />,
    );

    expect(screen.getByText('7')).toBeOnTheScreen();
    expect(
      within(screen.getByRole('radio', { name: '收藏内容模式：SFW' }))
        .getAllByText(/./)
        .map((node) => node.props.children),
    ).toEqual(['SFW']);
  });
});
