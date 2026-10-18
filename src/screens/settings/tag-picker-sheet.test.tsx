import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

import type { TagSuggestionFetcher } from '@/features/tags/danbooru-tag-suggestions';
import i18n from '@/i18n';
import { TagPickerSheet } from '@/screens/settings/tag-picker-sheet';
import { colors, useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { fontFamilies } from '@/theme/typography';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('lucide-react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View: NativeView } = require('react-native');
  // X renders a marked view (settings-reset-chevron precedent) so the U3c
  // pins can assert the remove affordance survives restyling.
  return { Ban: () => null, Check: () => null, Plus: () => null, Search: () => null,
    X: (props: Record<string, unknown>) => React.createElement(NativeView, { ...props, testID: 'mock-lucide-x' }) };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

const probe = [
  ['fur', 5579], ['fur_trim', 237991], ['furry', 146890],
  ['furrowed_brow', 71363], ['furry_female', 70329], ['furry_male', 67701],
  ['fur-trimmed_jacket', 40336], ['fur_collar', 37548],
].map(([value, post_count]) => ({ type: 'tag-word', value, post_count }));

function probeFetcher() {
  return jest.fn<ReturnType<TagSuggestionFetcher>, Parameters<TagSuggestionFetcher>>()
    .mockResolvedValue({ ok: true, status: 200, json: async () => probe });
}

function StatefulSheet({
  initial = [], fetcher, visible = true, disabled = false, safeAreaTop,
}: {
  initial?: string[]; fetcher: TagSuggestionFetcher; visible?: boolean; disabled?: boolean; safeAreaTop?: number;
}) {
  const [excludedTags, setExcludedTags] = useState(initial);
  const theme = useAppThemeColors();
  return <>
    <Text testID="stored-tags">{JSON.stringify(excludedTags)}</Text>
    <Text testID="prefix-color">{theme.saveDeep}</Text>
    <TagPickerSheet visible={visible} disabled={disabled} excludedTags={excludedTags}
      fetchSuggestions={fetcher} safeAreaTop={safeAreaTop} onClose={() => {}}
      onToggle={(slug) => setExcludedTags((current) => {
        const excluded = current.filter((tag) => tag !== slug);
        return current.includes(slug) ? excluded : [...excluded, slug];
      })} />
  </>;
}

async function advance(ms = 250) {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
}
async function type(search: string) {
  await fireEvent.changeText(screen.getByLabelText('输入标签，比如 furry'), search);
}

beforeEach(async () => { jest.useFakeTimers(); await i18n.changeLanguage('zh-Hans'); });
afterEach(() => jest.useRealTimers());

test('fur loads probe rows with hyphens, locale counts and highlighted mono prefixes', async () => {
  const fetcher = probeFetcher();
  await render(<StatefulSheet fetcher={fetcher} />);
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  await type('fur');
  await advance(249);
  expect(fetcher).not.toHaveBeenCalled();
  await advance(1);
  expect(screen.getAllByRole('checkbox').map((row) => row.props.accessibilityLabel)).toEqual(probe.map((row) => row.value));
  expect(screen.getByText('23.8 万')).toBeOnTheScreen();
  const row = within(screen.getByRole('checkbox', { name: 'fur-trimmed_jacket' }));
  expect(row.getByText('fur-trimmed_jacket')).toHaveStyle({ fontFamily: fontFamilies.mono });
  expect(row.getByText('fur')).toHaveStyle({ color: screen.getByTestId('prefix-color').props.children });
});

test('add then checked-row remove updates chip, excluded heading and furry note; chip removal also works', async () => {
  await render(<StatefulSheet fetcher={probeFetcher()} />);
  const note = String(i18n.t('settings.provider.furryBlocked'));
  expect(screen.queryByText(note)).not.toBeOnTheScreen();
  await type('fur');
  await advance();
  await fireEvent.press(screen.getByRole('checkbox', { name: 'furry' }));
  expect(screen.getByRole('button', { name: '取消屏蔽 furry' })).toBeOnTheScreen();
  expect(screen.getByText('已排除 1 个')).toBeOnTheScreen();
  expect(screen.getByText(note)).toBeOnTheScreen();
  expect(screen.getByRole('checkbox', { name: 'furry' })).toBeChecked();
  await fireEvent.press(screen.getByRole('checkbox', { name: 'furry' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('[]');
  expect(screen.queryByRole('button', { name: '取消屏蔽 furry' })).not.toBeOnTheScreen();
  expect(screen.queryByText('已排除 1 个')).not.toBeOnTheScreen();
  expect(screen.queryByText(note)).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('checkbox', { name: 'furry' }));
  await fireEvent.press(screen.getByRole('button', { name: '取消屏蔽 furry' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('[]');
});

test('stores Danbooru value with its hyphen intact', async () => {
  await render(<StatefulSheet fetcher={probeFetcher()} />);
  await type('fur');
  await advance();
  await fireEvent.press(screen.getByRole('checkbox', { name: 'fur-trimmed_jacket' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('["fur-trimmed_jacket"]');
  expect(screen.getByRole('button', { name: '取消屏蔽 fur-trimmed_jacket' })).toBeOnTheScreen();
});

test('a checked hyphen suggestion removes the exact stored underscore variant', async () => {
  await render(<StatefulSheet initial={['fur_trimmed_jacket']} fetcher={probeFetcher()} />);
  await type('fur');
  await advance();
  const row = screen.getByRole('checkbox', { name: 'fur-trimmed_jacket' });
  expect(row).toBeChecked();
  await fireEvent.press(row);
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('[]');
  expect(row).not.toBeChecked();
});

test('on failure the unavailable line and raw row remain actionable', async () => {
  const fetcher = probeFetcher().mockRejectedValue(new Error('offline'));
  await render(<StatefulSheet fetcher={fetcher} />);
  await type('xyz');
  await advance();
  expect(screen.getByText('暂时拿不到建议，可以直接排除输入的内容。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '直接排除「xyz」' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('["xyz"]');
});

test.each(['furxyz', 'furry'])('after fur succeeds, a failed %s query clears stale rows and offers raw exclusion', async (query) => {
  let rejectRequest!: (reason: unknown) => void;
  const fetcher = probeFetcher().mockImplementationOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => probe,
  })).mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectRequest = reject;
  }));
  await render(<StatefulSheet fetcher={fetcher} />);
  await type('fur');
  await advance();
  expect(screen.getAllByRole('checkbox')).toHaveLength(probe.length);
  await type(query);
  await advance();
  // Previous suggestions remain usable while the current request is loading.
  expect(screen.getByRole('checkbox', { name: 'furry' })).toBeOnTheScreen();
  await act(async () => rejectRequest(new Error('offline')));
  expect(screen.getByText('暂时拿不到建议，可以直接排除输入的内容。')).toBeOnTheScreen();
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  await fireEvent.press(screen.getByRole('button', { name: `直接排除「${query}」` }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent(JSON.stringify([query]));
});

test('new heading, suggestion counts and unavailable text use their font tokens at the existing sizes', async () => {
  const fetcher = probeFetcher().mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => probe,
  }).mockRejectedValue(new Error('offline'));
  await render(<StatefulSheet initial={['comic']} fetcher={fetcher} />);
  expect(screen.getByText('已排除 1 个')).toHaveStyle({
    fontFamily: fontFamilies.sans,
    fontSize: 13,
  });
  await type('fur');
  await advance();
  expect(screen.getByText('23.8 万')).toHaveStyle({
    fontFamily: fontFamilies.sansMedium,
    fontSize: 13,
  });
  await type('furxyz');
  await advance();
  expect(screen.getByText('暂时拿不到建议，可以直接排除输入的内容。')).toHaveStyle({
    fontFamily: fontFamilies.sansMedium,
    fontSize: 13,
  });
});

test('raw row is hidden for a matching suggestion key and for an excluded normalized variant', async () => {
  await render(<StatefulSheet initial={['ai-generated']} fetcher={probeFetcher()} />);
  await type('fur-trimmed_jacket');
  await advance();
  expect(screen.queryByRole('button', { name: '直接排除「fur_trimmed_jacket」' })).not.toBeOnTheScreen();
  await type('ai_generated');
  expect(screen.queryByRole('button', { name: '直接排除「ai_generated」' })).not.toBeOnTheScreen();
});

test('typing with the sheet closed makes no request, and reopening resumes preserved input', async () => {
  const fetcher = probeFetcher();
  const view = await render(<StatefulSheet fetcher={fetcher} />);
  await type('fu');
  const changeText = screen.getByLabelText('输入标签，比如 furry').props.onChangeText;
  await view.rerender(<StatefulSheet fetcher={fetcher} visible={false} />);
  // Modal hides its native subtree while the sheet's search state stays mounted.
  await act(async () => changeText('fur'));
  await advance(1000);
  expect(fetcher).not.toHaveBeenCalled();
  await view.rerender(<StatefulSheet fetcher={fetcher} />);
  await advance();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('search[query]')).toBe('fur');
});

test('unlisted raw tags are normalized, disappear once excluded and remain removable by chip', async () => {
  await render(<StatefulSheet fetcher={probeFetcher()} />);
  await type(' FOO-Bar ');
  await fireEvent.press(screen.getByRole('button', { name: '直接排除「foo_bar」' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('["foo_bar"]');
  expect(screen.queryByRole('button', { name: '直接排除「foo_bar」' })).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '取消屏蔽 foo_bar' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('[]');
});

test('invalid and reserved entries have no raw row or include/exclude mode controls', async () => {
  await render(<StatefulSheet fetcher={probeFetcher()} />);
  for (const entry of ['bad tag!!', 'waifu', '']) {
    await type(entry);
    expect(screen.queryByRole('button', { name: /^直接排除「/ })).not.toBeOnTheScreen();
  }
  expect(screen.queryByRole('button', { name: '选择包含标签' })).not.toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '选择排除标签' })).not.toBeOnTheScreen();
});

test('disabled controls cannot add or remove a tag', async () => {
  const fetcher = probeFetcher();
  const view = await render(<StatefulSheet initial={['furry']} fetcher={fetcher} />);
  await type('fur');
  await advance();
  await view.rerender(<StatefulSheet initial={['furry']} fetcher={fetcher} disabled />);
  expect(screen.getByRole('checkbox', { name: 'fur_trim' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('checkbox', { name: 'fur_trim' }));
  await fireEvent.press(screen.getByRole('button', { name: '取消屏蔽 furry' }));
  expect(screen.getByTestId('stored-tags')).toHaveTextContent('["furry"]');
});

test.each([undefined, 141])('keeps header below device inset (override %p)', async (safeAreaTop) => {
  await render(<StatefulSheet fetcher={probeFetcher()} safeAreaTop={safeAreaTop} />);
  expect(screen.getByTestId('tag-picker-sheet')).toHaveStyle({ paddingTop: safeAreaTop ?? 47 });
});

/**
 * U3c RED pins (plan `2026-10-11-n7-u3-settings-sheets-dialogs.md`): the
 * exclude-tag sheet aligns to the mockup v4 vocabulary — 17/800 sheet-title
 * header with its divider and 48 dp close target, the boxed field search
 * (1.5 border, 12 radius, 15 type), pill chips (radius 999, ~36 tall, 14
 * type, X kept) and .wd-r suggestion rows (52 min height, 12/14 padding,
 * row-title scale). v4 numbers are pinned as independent literals. Behaviour
 * freeze: onToggle selection semantics (exact stored slug), raw-block
 * candidates and close semantics are byte-frozen; the four-locale literal
 * guards stay untouched.
 */

type FlatStyle = { [key: string]: unknown };

function flattened(node: unknown): FlatStyle | undefined {
  return StyleSheet.flatten((node as { props: { style?: unknown } }).props.style) as FlatStyle | undefined;
}

function ToggleProbe({
  initial, fetcher, onToggle, onClose,
}: {
  initial: string[]; fetcher: TagSuggestionFetcher;
  onToggle: (slug: string) => void; onClose: () => void;
}) {
  return <TagPickerSheet visible excludedTags={initial} fetchSuggestions={fetcher}
    onClose={onClose} onToggle={onToggle} />;
}

test('the sheet header takes the v4 sheet-title with its divider and 48 dp close target', async () => {
  await render(<ToggleProbe initial={['furry']} fetcher={probeFetcher()} onToggle={jest.fn()} onClose={jest.fn()} />);
  const title = screen.getByText('排除标签');
  expect(flattened(title)).toMatchObject({
    fontSize: 17,
    fontFamily: fontFamilies.sansHeavy,
    color: colors.light.text,
  });

  const root = screen.getByTestId('tag-picker-sheet');
  const header = root.children[0]!;
  expect(flattened(header)).toMatchObject({
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
  });
  const close = screen.getByRole('button', { name: '关闭标签选择' });
  expect(flattened(close)).toMatchObject({ width: 48, height: 48 });
  expect(within(close).getByTestId('mock-lucide-x')).toBeOnTheScreen();

  // sheet-head spacing vocabulary: the 12 dp under the header divider.
  const body = root.children[1]!;
  expect(flattened(body)).toMatchObject({ padding: 12, gap: 12 });
});

test('the search box follows the v4 .wd-search field vocabulary', async () => {
  await render(<ToggleProbe initial={['furry']} fetcher={probeFetcher()} onToggle={jest.fn()} onClose={jest.fn()} />);
  const input = screen.getByLabelText('输入标签，比如 furry');
  const box = input.parent!;
  expect(flattened(box)).toMatchObject({
    borderWidth: 1.5,
    borderRadius: 12,
    borderColor: colors.light.border,
  });
  expect(flattened(input)).toMatchObject({
    fontSize: 15,
    fontFamily: fontFamilies.mono,
    color: colors.light.text,
    minHeight: 48,
  });
});

test('the search box draws the focused accent border (.wd-search active)', async () => {
  await render(<ToggleProbe initial={['furry']} fetcher={probeFetcher()} onToggle={jest.fn()} onClose={jest.fn()} />);
  const input = screen.getByLabelText('输入标签，比如 furry');
  const box = input.parent!;
  await fireEvent(input, 'focus');
  expect(flattened(screen.getByLabelText('输入标签，比如 furry').parent!)).toMatchObject({
    borderColor: colors.light.save, borderWidth: 1.5,
  });
  await fireEvent(screen.getByLabelText('输入标签，比如 furry'), 'blur');
  expect(flattened(screen.getByLabelText('输入标签，比如 furry').parent!)).toMatchObject({
    borderColor: colors.light.border, borderWidth: 1.5,
  });
});

test('excluded chips are the v4 .wd-chip (accent-soft / accent-deep / 13 mono)', async () => {
  await render(<ToggleProbe initial={['furry']} fetcher={probeFetcher()} onToggle={jest.fn()} onClose={jest.fn()} />);
  const chip = screen.getByRole('button', { name: '取消屏蔽 furry' });
  expect(flattened(chip)).toMatchObject({
    minHeight: metrics.settingsChip.minTouch,
    borderRadius: metrics.radius.circle,
    backgroundColor: colors.light.saveSoft,
    paddingTop: metrics.settingsChip.paddingV,
    paddingBottom: metrics.settingsChip.paddingV,
    paddingLeft: metrics.settingsChip.paddingLeft,
    paddingRight: metrics.settingsChip.paddingRight,
    gap: metrics.settingsChip.gap,
    flexDirection: 'row',
    alignItems: 'center',
  });
  expect(flattened(chip)!.borderWidth).toBeUndefined();
  expect(within(chip).getByText('furry')).toHaveStyle({
    fontSize: 13,
    fontFamily: fontFamilies.mono,
    color: colors.light.saveDeep,
  });
  expect(within(chip).getByTestId('mock-lucide-x')).toHaveProp('size', metrics.settingsChip.iconSize);
  expect(within(chip).getByTestId('mock-lucide-x')).toHaveProp('color', colors.light.saveDeep);
});

test('suggestion and raw rows take the .wd-r row geometry', async () => {
  await render(<ToggleProbe initial={['furry']} fetcher={probeFetcher()} onToggle={jest.fn()} onClose={jest.fn()} />);
  await type('fur');
  await advance();
  const row = screen.getByRole('checkbox', { name: 'fur_trim' });
  expect(flattened(row)).toMatchObject({
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  });
  expect(within(row).getByText('fur_trim')).toHaveStyle({
    fontSize: 15,
    fontFamily: fontFamilies.mono,
  });

  await type('xyz');
  await advance();
  const raw = screen.getByRole('button', { name: '直接排除「xyz」' });
  expect(flattened(raw)).toMatchObject({
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 12,
  });
  expect(within(raw).getByText('直接排除「xyz」')).toHaveStyle({
    fontSize: 15,
    fontFamily: fontFamilies.sansHeavy,
  });
});

test('selection stays toggle-by-slug and close stays close-only', async () => {
  const onToggle = jest.fn();
  const onClose = jest.fn();
  await render(<ToggleProbe initial={['furry']} fetcher={probeFetcher()} onToggle={onToggle} onClose={onClose} />);
  await type('fur');
  await advance();

  await fireEvent.press(screen.getByRole('checkbox', { name: 'fur_trim' }));
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onToggle).toHaveBeenCalledWith('fur_trim');
  expect(onClose).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: '取消屏蔽 furry' }));
  expect(onToggle).toHaveBeenCalledTimes(2);
  expect(onToggle).toHaveBeenLastCalledWith('furry');
  expect(onClose).not.toHaveBeenCalled();

  await type('xyz');
  await advance();
  await fireEvent.press(screen.getByRole('button', { name: '直接排除「xyz」' }));
  expect(onToggle).toHaveBeenCalledTimes(3);
  expect(onToggle).toHaveBeenLastCalledWith('xyz');
  expect(onClose).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: '关闭标签选择' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onToggle).toHaveBeenCalledTimes(3);
});
