import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard, ScrollView, TextInput } from 'react-native';
import { CloudLibraryScroll } from './cloud-library-scroll';
import { SettingsField } from './ui/settings-field';
import { metrics } from '@/theme/metrics';

let mockBottomInset = 24;
let mockIme: ((event: { visible: boolean; height: number }) => void) | null;
const mockRemoveIme = jest.fn();
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: mockBottomInset, left: 0, right: 0 }) }));
jest.mock('../../../modules/waifu-sync-service', () => ({ addImeHeightListener: (listener: typeof mockIme) => {
  mockIme = listener; return { remove: mockRemoveIme };
} }));
beforeEach(() => { mockBottomInset = 24; mockIme = null; mockRemoveIme.mockClear(); });
test('Stack scroll clears only the bottom safe area, owns and releases keyboard/IME listeners', async () => {
  const listeners = new Map<string, (event: any) => void>();
  const remove = jest.fn();
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => { listeners.set(event, listener); return { remove } as unknown as ReturnType<typeof Keyboard.addListener>; });
  const view = await render(<CloudLibraryScroll><SettingsField testID="input" accessibilityLabel="Input" placeholder="Input" value="" onChangeText={jest.fn()} /></CloudLibraryScroll>);
  const scroll = screen.getByTestId('cloud-library-scroll');
  expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
  expect(scroll.props.innerViewRef).toBeDefined();
  expect(scroll.props.contentContainerStyle).toEqual({ paddingBottom: 24 + metrics.spacing.large });
  expect([...listeners.keys()]).toEqual(['keyboardDidShow', 'keyboardDidHide']);
  await act(async () => listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 400 } }));
  expect(scroll.props.contentContainerStyle.paddingBottom).toBe(24 + metrics.spacing.large + 400);
  await act(async () => mockIme?.({ visible: true, height: 500 }));
  expect(scroll.props.contentContainerStyle.paddingBottom).toBe(24 + metrics.spacing.large + 500);
  await act(async () => mockIme?.({ visible: false, height: 0 }));
  expect(scroll.props.contentContainerStyle.paddingBottom).toBe(24 + metrics.spacing.large);
  await view.unmount(); expect(remove).toHaveBeenCalledTimes(2); expect(mockRemoveIme).toHaveBeenCalledTimes(1);
});
test('bottom clearance follows the shared gesture clamp, including a zero bottom inset', async () => {
  mockBottomInset = 0;
  const view = await render(<CloudLibraryScroll><SettingsField testID="input" accessibilityLabel="Input" placeholder="Input" value="" onChangeText={jest.fn()} /></CloudLibraryScroll>);
  const scroll = screen.getByTestId('cloud-library-scroll');
  expect(scroll.props.contentContainerStyle).toEqual({ paddingBottom: metrics.gestureInset + metrics.spacing.large });
  await act(async () => mockIme?.({ visible: true, height: 500 }));
  expect(scroll.props.contentContainerStyle.paddingBottom).toBe(metrics.gestureInset + metrics.spacing.large + 500);
  await view.unmount();
});
test('the scroll source keeps the shared clamp expression (U2c2 `c96d3b8a`)', () => {
  const source = readFileSync(join(__dirname, 'cloud-library-scroll.tsx'), 'utf8');
  expect(source).toContain('Math.max(insets.bottom, metrics.gestureInset)');
});
test('layout and scroll offset reveal covered input exactly once; late measurement after blur does not scroll', async () => {
  let show: ((event: any) => void) | undefined;
  jest.spyOn(Keyboard, 'addListener').mockImplementation((event, listener) => { if (event === 'keyboardDidShow') show = listener; return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>; });
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  jest.spyOn(ScrollView.prototype, 'getInnerViewNode').mockReturnValue(123);
  let measured: ((x: number, y: number, width: number, height: number) => void) | undefined;
  jest.spyOn(TextInput.prototype, 'measureLayout').mockImplementation((_node, success) => { measured = success; });
  await render(<CloudLibraryScroll><SettingsField testID="input" accessibilityLabel="Input" placeholder="Input" value="" onChangeText={jest.fn()} /></CloudLibraryScroll>);
  await fireEvent(screen.getByTestId('cloud-library-scroll'), 'layout', { nativeEvent: { layout: { height: 800 } } });
  await fireEvent.scroll(screen.getByTestId('cloud-library-scroll'), { nativeEvent: { contentOffset: { y: 100, x: 0 } } });
  await fireEvent(screen.getByTestId('input'), 'focus');
  await act(async () => show?.({ endCoordinates: { height: 400 } }));
  await act(async () => measured?.(0, 700, 300, 48));
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 388, animated: true });
  scrollTo.mockClear();
  await fireEvent(screen.getByTestId('input'), 'focus');
  await fireEvent(screen.getByTestId('input'), 'blur');
  await act(async () => measured?.(0, 900, 300, 48));
  expect(scrollTo).not.toHaveBeenCalled();
});
