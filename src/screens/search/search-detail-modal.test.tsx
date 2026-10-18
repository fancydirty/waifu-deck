/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { SearchHit } from '@/features/search/types';
import i18n from '@/i18n';
import { SearchDetailModal } from '@/screens/search/search-detail-modal';
import { SearchView } from '@/screens/search/search-view';

beforeEach(async () => {
  mockSetModalStatusBarStyle.mockReset();
  await i18n.changeLanguage('zh-Hans');
});

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  const FlashList = React.forwardRef(({ data, renderItem, ...props }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      getAbsoluteLastScrollOffset: () => 0,
    }), []);
    return (
      <View {...props}>
        {data.map((item: SearchHit, index: number) => (
          <React.Fragment key={item.key}>{renderItem({ item, index })}</React.Fragment>
        ))}
      </View>
    );
  });
  FlashList.displayName = 'FlashList';
  return {
    FlashList,
  };
});

jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => <View {...props} /> };
});

const mockSetModalStatusBarStyle = jest.fn();

jest.mock('../../../modules/waifu-sync-service', () => ({
  setModalStatusBarStyle: (...args: unknown[]) => mockSetModalStatusBarStyle(...args),
}));

jest.mock('expo-status-bar', () => {
  const { View } = require('react-native');
  return {
    StatusBar: (props: Record<string, unknown>) => (
      <View testID="modal-status-bar" {...props} />
    ),
  };
});

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ExternalLink: Icon, EyeOff: Icon, Heart: Icon, Search: Icon, X: Icon };
});

function hit(id: number, overrides: Partial<SearchHit['image']> = {}): SearchHit {
  return {
    key: `waifu_im:${id}`,
    previewUrl: `https://preview.example.com/${id}.jpg`,
    image: {
      providerKey: 'waifu_im',
      providerItemId: String(id),
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: `https://cdn.example.com/${id}.jpg`,
      sourceUrl: `https://source.example.com/${id}`,
      artistName: `Artist ${id}`,
      artistUrl: null,
      width: id === 1 ? 900 : 1440,
      height: id === 1 ? 1200 : 1920,
      byteSize: 500_000,
      extension: 'jpg',
      dominantColor: '#726A7D',
      isNsfw: false,
      isAnimated: false,
      tags: ['waifu'],
      ...overrides,
    },
  };
}

function modal(overrides: Partial<React.ComponentProps<typeof SearchDetailModal>> = {}) {
  return (
    <SearchDetailModal
      visible
      hits={[hit(1), hit(2)]}
      initialIndex={0}
      viewportWidth={390}
      onClose={jest.fn()}
      onToggleFavorite={jest.fn()}
      onOpenSource={jest.fn()}
      {...overrides}
    />
  );
}

test('uses a full-screen non-animated black Modal', async () => {
  await render(modal());

  const value = screen.getByTestId('search-detail-modal');
  expect(value.props.animationType).toBe('none');
  expect(value.props.presentationStyle).toBe('fullScreen');
  expect(screen.getByLabelText('原图全屏画廊')).toHaveStyle({
    flex: 1,
    backgroundColor: '#000000',
  });
});

test('renders remote originals with contain so they are not cropped', async () => {
  await render(modal());

  const original = screen.getByLabelText('原图 1');
  expect(original.props.source).toEqual({ uri: 'https://cdn.example.com/1.jpg' });
  expect(original.props.contentFit).toBe('contain');
  expect(original.props.recyclingKey).toBe(JSON.stringify(['waifu_im:1', 0]));
});

test('shows the already-cached grid preview while the original streams in', async () => {
  await render(modal());

  // The tile already fetched and disk-cached this sample, so the page has
  // something to show the instant it opens instead of a black rectangle.
  const original = screen.getByLabelText('原图 1');
  expect(original.props.placeholder).toEqual({
    uri: 'https://preview.example.com/1.jpg',
  });
  expect(original.props.placeholderContentFit).toBe('contain');
});

test('skips the placeholder when the preview is the original itself (no double load)', async () => {
  // waifu.im / nekos publish no sample, so previewUrl === remoteUrl; a
  // placeholder with the same URL would decode the original twice.
  await render(modal({ hits: [hit(1, { remoteUrl: 'https://preview.example.com/1.jpg' })] }));

  const original = screen.getByLabelText('原图 1');
  expect(original.props.source).toEqual({ uri: 'https://preview.example.com/1.jpg' });
  expect(original.props.placeholder).toBeUndefined();
});

test('R8.28: the pager sends the provider headers on both the original and the placeholder', async () => {
  await render(modal({
    hits: [{
      ...hit(1, { providerKey: 'gelbooru', remoteUrl: 'https://img4.gelbooru.com/images/a/b/1.jpg' }),
      previewUrl: 'https://img4.gelbooru.com/samples/a/b/sample_1.jpg',
    }],
  }));

  const original = screen.getByLabelText('原图 1');
  expect(original.props.source).toEqual({
    uri: 'https://img4.gelbooru.com/images/a/b/1.jpg',
    headers: { Referer: 'https://gelbooru.com/' },
  });
  // The placeholder is a second network load of the same protected CDN.
  expect(original.props.placeholder).toEqual({
    uri: 'https://img4.gelbooru.com/samples/a/b/sample_1.jpg',
    headers: { Referer: 'https://gelbooru.com/' },
  });
});

test('R8.28: a headerless provider page keeps bare { uri } source and placeholder', async () => {
  await render(modal({ hits: [hit(1, { providerKey: 'danbooru' })] }));

  const original = screen.getByLabelText('原图 1');
  expect(Object.keys(original.props.source)).toEqual(['uri']);
  expect(Object.keys(original.props.placeholder)).toEqual(['uri']);
});

test('retries a failed original with bounded backoff', async () => {
  jest.useFakeTimers();
  try {
    await render(modal());

    const page = () => screen.getByLabelText('原图 1');
    const keyForAttempt = (attempt: number) =>
      JSON.stringify(['waifu_im:1', attempt]);
    expect(page().props.recyclingKey).toBe(keyForAttempt(0));

    await act(async () => {
      (page().props.onError as () => void)();
    });
    expect(page().props.recyclingKey).toBe(keyForAttempt(0));

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(page().props.recyclingKey).toBe(keyForAttempt(1));

    await act(async () => {
      (page().props.onError as () => void)();
      jest.advanceTimersByTime(3_000);
    });
    expect(page().props.recyclingKey).toBe(keyForAttempt(2));

    await act(async () => {
      (page().props.onError as () => void)();
      jest.advanceTimersByTime(8_000);
    });
    expect(page().props.recyclingKey).toBe(keyForAttempt(3));

    // Bounded: a fourth failure never reloads again.
    await act(async () => {
      (page().props.onError as () => void)();
      jest.advanceTimersByTime(60_000);
    });
    expect(page().props.recyclingKey).toBe(keyForAttempt(3));
  } finally {
    jest.useRealTimers();
  }
});

test('pages horizontally and updates metadata after a swipe', async () => {
  const onIndexChange = jest.fn();
  await render(modal({ onIndexChange }));
  const pager = screen.getByTestId('search-detail-pager');

  expect(pager.props.horizontal).toBe(true);
  expect(pager.props.pagingEnabled).toBe(true);
  expect(pager.props.snapToInterval).toBe(390);
  expect(screen.getByText('900 x 1200 · Waifu.im · 1/2')).toBeOnTheScreen();

  await fireEvent(pager, 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: 390, y: 0 } },
  });

  expect(screen.getByText('1440 x 1920 · Waifu.im · 2/2')).toBeOnTheScreen();
  expect(onIndexChange).toHaveBeenCalledWith(1, expect.objectContaining({ key: 'waifu_im:2' }));
});

test('shows idle, busy, and saved favorite states', async () => {
  const { rerender } = await render(modal());
  expect(screen.getByText('收藏')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '收藏图片' }).props.accessibilityState).toEqual({
    disabled: false,
    selected: false,
  });

  await rerender(modal({ savingKeys: ['waifu_im:1'] }));
  expect(screen.getByText('保存中')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '收藏图片' })).toBeDisabled();

  await rerender(modal({ favoriteKeys: ['waifu_im:1'] }));
  expect(screen.getByText('已收藏')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '图片已收藏' }).props.accessibilityState).toEqual({
    disabled: true,
    selected: true,
  });
});

test('labels close, favorite, and source commands and dispatches callbacks', async () => {
  const onClose = jest.fn();
  const onToggleFavorite = jest.fn();
  const onOpenSource = jest.fn();
  await render(modal({ onClose, onToggleFavorite, onOpenSource }));

  await fireEvent.press(screen.getByRole('button', { name: '关闭原图画廊' }));
  await fireEvent.press(screen.getByRole('button', { name: '收藏图片' }));
  await fireEvent.press(screen.getByRole('button', { name: '打开图片来源' }));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ key: 'waifu_im:1' }));
  expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ key: 'waifu_im:1' }));
});

test('closing the Modal leaves the controlled search page state mounted', async () => {
  const searchProps: React.ComponentProps<typeof SearchView> = {
    query: 'catgirl',
    hits: [hit(1)],
    status: 'ready',
    errorMessage: null,
    blurNsfwThumbnails: true,
    hasNextPage: false,
    isLoadingMore: false,
    viewportWidth: 390,
    onQueryChange: jest.fn(),
    onSubmit: jest.fn(),
    onOpen: jest.fn(),
    onLoadMore: jest.fn(),
  };
  const { rerender } = await render(
    <>
      <SearchView {...searchProps} />
      {modal()}
    </>,
  );

  await rerender(
    <>
      <SearchView {...searchProps} />
      {modal({ visible: false })}
    </>,
  );

  expect(screen.getByLabelText('搜索关键词').props.value).toBe('catgirl');
  expect(screen.getByTestId('search-results')).toBeOnTheScreen();
});

test('N8: mounts a light StatusBar and syncs the native Modal Dialog window only while visible', async () => {
  const { rerender } = await render(modal({ visible: false }));
  expect(screen.queryByTestId('modal-status-bar')).toBeNull();
  expect(mockSetModalStatusBarStyle).not.toHaveBeenCalled();

  await rerender(modal({ visible: true }));
  expect(screen.getByTestId('modal-status-bar').props.style).toBe('light');
  expect(mockSetModalStatusBarStyle).toHaveBeenCalledWith('light');

  mockSetModalStatusBarStyle.mockClear();
  await fireEvent(screen.getByTestId('search-detail-modal'), 'show');
  expect(mockSetModalStatusBarStyle).toHaveBeenCalledWith('light');

  await rerender(modal({ visible: false }));
  expect(screen.queryByTestId('modal-status-bar')).toBeNull();
});
