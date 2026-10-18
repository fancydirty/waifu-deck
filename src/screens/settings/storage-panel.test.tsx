import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, userEvent, within } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import i18n from '@/i18n';
import { colors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { cloudTypography, settingsTypography } from '@/theme/typography';
import * as byteFormat from './cloud-library-format';
import { StoragePanel, type StoragePanelProps } from './storage-panel';

const props = (overrides: Partial<StoragePanelProps> = {}): StoragePanelProps => ({
  collectionBytes: 3_000_000, previewCacheBytes: 1_500_000, busy: false, onClear: jest.fn(), ...overrides,
});
const hidden = { includeHiddenElements: true };
function expectFlex(collection: number, preview: number) {
  expect(screen.getByTestId('storage-collection-segment', hidden)).toHaveStyle({ flex: collection });
  expect(screen.getByTestId('storage-preview-segment', hidden)).toHaveStyle({ flex: preview });
}
function expectFigures(total: string, collection: string, preview: string) {
  expect(screen.getByTestId('storage-total')).toHaveTextContent(total, { exact: true });
  expect(screen.getByTestId('storage-collection-size')).toHaveTextContent(collection, { exact: true });
  expect(screen.getByTestId('storage-preview-size')).toHaveTextContent(preview, { exact: true });
}
beforeEach(async () => { await i18n.changeLanguage('en'); });

test('renders the presentational panel without an app-services provider', async () => {
  await render(<StoragePanel {...props()} />);
  expect(screen.getByTestId('storage-panel')).toBeOnTheScreen();
  expectFigures('4.5 MB used', 'Collection 3 MB', 'Preview cache 1.5 MB');
  expectFlex(3_000_000, 1_500_000);
});

test.each([
  ['zh-Hans', '已用', '收藏', '预览缓存', '清除预览缓存'],
  ['zh-Hant', '已用', '收藏', '預覽快取', '清除預覽快取'],
  ['ja', '使用済み', 'コレクション', 'プレビューキャッシュ', 'プレビューキャッシュを消去'],
  ['en', 'used', 'Collection', 'Preview cache', 'Clear preview cache'],
])('%s renders the approved storage copy, including the mockup figures', async (locale, used, collection, preview, clear) => {
  await i18n.changeLanguage(locale);
  await render(<StoragePanel {...props({ collectionBytes: 26_000_000, previewCacheBytes: 312_000_000 })} />);
  expectFigures(`338 MB ${used}`, `${collection} 26 MB`, `${preview} 312 MB`);
  expect(screen.getByRole('button', { name: clear })).toBe(screen.getByTestId('storage-clear-preview-cache'));
  expect(screen.queryByText(/settings\.storage/)).toBeNull();
});

test.each([
  [0, 0, '0 B', '0 B', '0 B'],
  [1, 998, '999 B', '1 B', '998 B'],
  [999, 1, '1 KB', '999 B', '1 B'],
  [1_000, 1_500, '2.5 KB', '1 KB', '1.5 KB'],
  [999_000, 1_000, '1 MB', '999 KB', '1 KB'],
  [1_500_000, 2_250_000, '3.8 MB', '1.5 MB', '2.3 MB'],
  [1_000_000_000, 500_000_000, '1.5 GB', '1 GB', '500 MB'],
  [0, 3_000_000, '3 MB', '0 B', '3 MB'],
  [3_000_000, 0, '3 MB', '3 MB', '0 B'],
])('total and legends share the decimal byte ladder for %s + %s', async (collection, preview, totalText, collectionText, previewText) => {
  await render(<StoragePanel {...props({ collectionBytes: collection, previewCacheBytes: preview })} />);
  expectFigures(`${totalText} used`, `Collection ${collectionText}`, `Preview cache ${previewText}`);
  expect(byteFormat.formatCloudBytes(collection)).toEqual({ value: collectionText.split(' ')[0], unit: collectionText.split(' ')[1] });
  expectFlex(collection, preview);
});

test.each(['light', 'dark'] as const)('%s swatches and meter use matching role tokens, and zero has an empty neutral track', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  const view = await render(<StoragePanel {...props()} />);
  const theme = colors[scheme];
  expect(screen.getByTestId('storage-split-bar', hidden)).toHaveStyle({ backgroundColor: theme.controlFill });
  for (const [id, token] of [['collection', theme.storageCollection], ['preview', theme.storagePreview]] as const) {
    expect(screen.getByTestId(`storage-${id}-segment`, hidden)).toHaveStyle({ backgroundColor: token });
    expect(screen.getByTestId(`storage-${id}-swatch`)).toHaveStyle({ backgroundColor: token });
  }
  await view.rerender(<StoragePanel {...props({ collectionBytes: 0, previewCacheBytes: 0 })} />);
  expectFigures('0 B used', 'Collection 0 B', 'Preview cache 0 B');
  expectFlex(0, 0);
  expect(screen.getByTestId('storage-split-bar', hidden)).toHaveStyle({ backgroundColor: theme.controlFill });
});

test('the decorative bar is hidden while legends expose both figures to accessibility', async () => {
  await render(<StoragePanel {...props()} />);
  expect(screen.queryByTestId('storage-split-bar')).toBeNull();
  expect(screen.queryByTestId('storage-collection-segment')).toBeNull();
  expect(screen.queryByTestId('storage-preview-segment')).toBeNull();
  expect(screen.getByTestId('storage-split-bar', hidden)).toHaveProp('importantForAccessibility', 'no-hide-descendants');
  expect(screen.getByTestId('storage-split-bar', hidden)).toHaveProp('accessibilityElementsHidden', true);
  expect(screen.getByTestId('storage-collection-size')).toBeVisible();
  expect(screen.getByTestId('storage-preview-size')).toBeVisible();
});

test.each(['light', 'dark'] as const)('%s total, legends and ghost button use the approved typography and geometry tokens', async (scheme) => {
  jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
  await render(<StoragePanel {...props()} />);
  const theme = colors[scheme];
  const total = screen.getByTestId('storage-total');
  expect(total).toHaveStyle(cloudTypography.stat);
  expect(within(total).getByText('MB used')).toHaveStyle({ ...settingsTypography.storageUnit, color: theme.textSecondary });
  expect(total.props.numberOfLines).toBeUndefined();
  for (const id of ['collection', 'preview']) {
    const legend = screen.getByTestId(`storage-${id}-size`);
    expect(legend.parent).toHaveStyle({ flexShrink: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 });
    expect(ReactNative.StyleSheet.flatten(legend.parent!.props.style).flex).toBeUndefined();
    expect(legend).toHaveStyle({ ...settingsTypography.storageLegend, color: theme.textSecondary, flexShrink: 1 });
    expect(screen.getByTestId(`storage-${id}-swatch`)).toHaveStyle({ width: 8, height: 8,
      borderRadius: metrics.settingsRadius.swatch });
  }
  const button = screen.getByTestId('storage-clear-preview-cache');
  expect(button).toHaveStyle({
    alignSelf: 'flex-start',
    marginVertical: -7,
    paddingVertical: 7,
  });
  expect(button).not.toHaveStyle({ borderWidth: 1 });
  expect(button).not.toHaveStyle({ borderColor: theme.border });
  expect(button.props.hitSlop).toBeUndefined();
  expect(button.children[0]).toHaveStyle({ backgroundColor: theme.controlFill, minHeight: 34,
    borderRadius: metrics.settingsRadius.button, paddingHorizontal: 12 });
  expect(within(button).getByText('Clear preview cache')).toHaveStyle({ ...settingsTypography.buttonLabel, color: theme.text });
  const panel = screen.getByTestId('storage-panel');
  expect(ReactNative.StyleSheet.flatten(panel.props.style)).toEqual({});
  const bar = screen.getByTestId('storage-split-bar', hidden);
  expect(bar.parent).toHaveStyle({ marginVertical: 10 });
  expect(bar).toHaveStyle({ height: 8, borderRadius: metrics.radius.circle, flexDirection: 'row', overflow: 'hidden' });
  const legends = screen.getByTestId('storage-collection-size').parent!.parent!;
  expect(legends).toHaveStyle({ flexDirection: 'row', flexWrap: 'wrap', rowGap: 6, columnGap: 14 });
  expect(button.parent).toHaveStyle({ marginTop: 12 });
  expect(panel.children).toEqual([total, bar.parent, legends, button.parent]);
});

test('panel has no inline colour, font or radius literals or service/promise/notice ownership', () => {
  const source = readFileSync(join(__dirname, 'storage-panel.tsx'), 'utf8');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i);
  expect(source).not.toMatch(/(?:backgroundColor|color|borderColor)\s*:\s*['"]|font(?:Size|Family|Weight)\s*:\s*(?:\d|['"])|borderRadius\s*:\s*\d/);
  expect(source).not.toMatch(/\b(?:async|await|Promise|useAppServices|setNotice)\b/);
  expect(source).toContain('settingsTypography.storageLegend');
  expect(source).toContain('metrics.settingsLegendSwatchGap');
  expect(source).toContain('metrics.settingsLegendRowGap');
  expect(source).toContain('metrics.settingsLegendColumnGap');
});

test.each([
  [null, null, 'Calculating', 'Calculating', 'Calculating'],
  [null, 1_500, 'Calculating', 'Calculating', '1.5 KB'],
  [3_000, null, 'Calculating', '3 KB', 'Calculating'],
  ['unavailable', 1_500, 'Unavailable', 'Unavailable', '1.5 KB'],
  [3_000, 'unavailable', 'Unavailable', '3 KB', 'Unavailable'],
  [null, 'unavailable', 'Unavailable', 'Calculating', 'Unavailable'],
  ['unavailable', null, 'Unavailable', 'Unavailable', 'Calculating'],
  [-1, 1_500, 'Unavailable', 'Unavailable', '1.5 KB'],
  [3_000, NaN, 'Unavailable', '3 KB', 'Unavailable'],
  [Infinity, null, 'Unavailable', 'Unavailable', 'Calculating'],
  [3_000, -Infinity, 'Unavailable', '3 KB', 'Unavailable'],
] as const)('fallback %s + %s keeps each legend honest and never formats a sentinel', async (collection, preview, totalText, collectionText, previewText) => {
  const format = jest.spyOn(byteFormat, 'formatCloudBytes');
  await render(<StoragePanel {...props({ collectionBytes: collection, previewCacheBytes: preview })} />);
  expectFigures(totalText, `Collection ${collectionText}`, `Preview cache ${previewText}`);
  expectFlex(0, 0);
  for (const [value] of format.mock.calls) {
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  for (const value of [collection, preview]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) expect(format).toHaveBeenCalledWith(value);
  }
});

test.each([
  [0, 0, 0], [0, 3_000, 0], [3_000, 0, 0], [3_000, 1_500, 2],
  [null, 1_500, 0], ['unavailable', 1_500, 0],
] as const)('meter separation for %s + %s is present only between two measured segments', async (collectionBytes, previewCacheBytes, marginLeft) => {
  await render(<StoragePanel {...props({ collectionBytes, previewCacheBytes })} />);
  expect(screen.getByTestId('storage-preview-segment', hidden)).toHaveStyle({ marginLeft });
});

test('overflow shows an unavailable total but keeps valid legend figures', async () => {
  const format = jest.spyOn(byteFormat, 'formatCloudBytes');
  await render(<StoragePanel {...props({ collectionBytes: Number.MAX_VALUE, previewCacheBytes: Number.MAX_VALUE })} />);
  expect(screen.getByTestId('storage-total')).toHaveTextContent('Unavailable', { exact: true });
  expect(screen.getByTestId('storage-collection-size')).toHaveTextContent(/Collection .+ GB/);
  expect(screen.getByTestId('storage-preview-size')).toHaveTextContent(/Preview cache .+ GB/);
  expectFlex(0, 0);
  expect(format).not.toHaveBeenCalledWith(Infinity);
});

test.each(['collection', 'preview'] as const)('a failed %s refresh after measured data drops total and stale ratio, keeping the other size', async (side) => {
  const view = await render(<StoragePanel {...props()} />);
  expectFlex(3_000_000, 1_500_000);
  await view.rerender(<StoragePanel {...props(side === 'collection' ? { collectionBytes: 'unavailable' } : { previewCacheBytes: 'unavailable' })} />);
  expectFigures('Unavailable', side === 'collection' ? 'Collection Unavailable' : 'Collection 3 MB',
    side === 'preview' ? 'Preview cache Unavailable' : 'Preview cache 1.5 MB');
  expectFlex(0, 0);
});

test('clear calls onClear once synchronously, does not await its result, and blocks busy presses', async () => {
  const then = jest.fn();
  const onClear = jest.fn(() => ({ then }));
  const view = await render(<StoragePanel {...props({ onClear })} />);
  const button = screen.getByTestId('storage-clear-preview-cache');
  // A real host press must forward once; a returned thenable stays outside the panel's lifecycle.
  await userEvent.press(button);
  expect(onClear).toHaveBeenCalledTimes(1);
  expect(then).not.toHaveBeenCalled();
  await view.rerender(<StoragePanel {...props({ onClear, busy: true })} />);
  expect(screen.getByTestId('storage-clear-preview-cache')).toBeDisabled();
  await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
  expect(onClear).toHaveBeenCalledTimes(1);
  await view.rerender(<StoragePanel {...props({ onClear })} />);
  await userEvent.press(screen.getByTestId('storage-clear-preview-cache'));
  expect(onClear).toHaveBeenCalledTimes(2);
});
