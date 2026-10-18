/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { SearchHit } from '@/features/search/types';
import i18n from '@/i18n';
import { getSearchColumnCount, SearchView } from '@/screens/search/search-view';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans');
});

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  const FlashList = React.forwardRef(({ data, renderItem, ListFooterComponent, ...props }: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      getAbsoluteLastScrollOffset: () => 0,
    }), []);
    return (
      <View {...props}>
        {data.map((item: SearchHit, index: number) => (
          <React.Fragment key={item.key}>{renderItem({ item, index })}</React.Fragment>
        ))}
        {ListFooterComponent}
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

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { EyeOff: Icon, Heart: Icon, Search: Icon, Check: Icon, ChevronDown: Icon, X: Icon };
});

function hit(id: number, providerKey: SearchHit['image']['providerKey'] = 'waifu_im'): SearchHit {
  return {
    key: `${providerKey}:${id}`,
    previewUrl: `https://preview.example.com/${id}.jpg`,
    image: {
      providerKey,
      providerItemId: String(id),
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: `https://cdn.example.com/${id}.jpg`,
      sourceUrl: `https://source.example.com/${id}`,
      artistName: `Artist ${id}`,
      artistUrl: null,
      width: 900,
      height: 1200,
      byteSize: 500_000,
      extension: 'jpg',
      dominantColor: '#726A7D',
      isNsfw: false,
      isAnimated: false,
      tags: ['waifu'],
    },
  };
}

function view(overrides: Partial<React.ComponentProps<typeof SearchView>> = {}) {
  return (
    <SafeAreaProvider initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 24, right: 0, bottom: 24, left: 0 },
    }}>
    <SearchView
      query="catgirl"
      hits={[hit(1), hit(2, 'danbooru')]}
      status="ready"
      errorMessage={null}
      blurNsfwThumbnails
      hasNextPage
      isLoadingMore={false}
      viewportWidth={390}
      onQueryChange={jest.fn()}
      onSubmit={jest.fn()}
      onOpen={jest.fn()}
      onLoadMore={jest.fn()}
      {...overrides}
    />
    </SafeAreaProvider>
  );
}

test('R8.21: the toolbar clears the top safe area instead of hiding under the status bar', async () => {
  await render(view({ safeAreaTop: 47 }));
  // The search input used to sit at y=28 under a 141px status bar/cutout on
  // device. The screen root now pads the device's own top inset so the toolbar
  // starts below it — device-adaptive, not a hardcoded offset.
  expect(screen.getByTestId('screen-search').props.style).toMatchObject({
    paddingTop: 47,
  });
});

test('R8.17: the results grid reserves for the floating tab bar', async () => {
  await render(view({ status: 'ready', hits: [hit(1)] }));

  const grid = screen.getByTestId('search-results');
  // The grid tail must scroll out from under the absolutely-positioned
  // floating bar (the owner's overlap bug class).
  expect(grid.props.contentContainerStyle).toMatchObject({
    paddingBottom: tabBarContentInset(0),
  });
});

test('uses three phone columns and five wide-screen columns', async () => {
  expect(getSearchColumnCount(390)).toBe(3);
  expect(getSearchColumnCount(699)).toBe(3);
  expect(getSearchColumnCount(700)).toBe(5);

  const { rerender } = await render(view());
  expect(screen.getByTestId('search-results').props.numColumns).toBe(3);

  await rerender(view({ viewportWidth: 800 }));
  expect(screen.getByTestId('search-results').props.numColumns).toBe(5);
});

test('the first layout reports the visible rows plus one row', async () => {
  const onSeenThrough = jest.fn();
  await render(view({
    hits: Array.from({ length: 6 }, (_, index) => hit(index + 1)),
    onSeenThrough,
  }));

  const grid = screen.getByTestId('search-results');
  await act(async () => {
    grid.props.onLayout({
      nativeEvent: { layout: { width: 300, height: 200 } },
    });
  });

  expect(onSeenThrough).toHaveBeenCalledWith(9);
});

test('scrolling reports the end of the last visible row plus one row', async () => {
  const onSeenThrough = jest.fn();
  await render(view({ onSeenThrough }));
  const grid = screen.getByTestId('search-results');

  await act(async () => {
    grid.props.onLayout({
      nativeEvent: { layout: { width: 300, height: 200 } },
    });
    onSeenThrough.mockClear();
    grid.props.onScroll({
      nativeEvent: { contentOffset: { y: 150 } },
    });
  });

  expect(onSeenThrough).toHaveBeenCalledWith(15);
});

test('a new hit list re-reports the current visible rows', async () => {
  const onSeenThrough = jest.fn();
  const { rerender } = await render(view({
    hits: [hit(1)],
    onSeenThrough,
  }));
  const grid = screen.getByTestId('search-results');

  await act(async () => {
    grid.props.onLayout({
      nativeEvent: { layout: { width: 300, height: 200 } },
    });
  });
  onSeenThrough.mockClear();
  await rerender(view({
    hits: [hit(2)],
    onSeenThrough,
  }));

  expect(onSeenThrough).toHaveBeenCalledWith(9);
});

test('no report before the viewport size is known', async () => {
  const onSeenThrough = jest.fn();
  await render(view({ onSeenThrough }));

  await act(async () => {
    screen.getByTestId('search-results').props.onScroll({
      nativeEvent: { contentOffset: { y: 100 } },
    });
  });
  expect(onSeenThrough).not.toHaveBeenCalled();
});

test('a new list starts its seen line from the top even after the old list was scrolled', async () => {
  const onSeenThrough = jest.fn();
  const { rerender } = await render(view({
    hits: [hit(1)],
    onSeenThrough,
  }));
  const oldGrid = screen.getByTestId('search-results');

  await act(async () => {
    oldGrid.props.onLayout({
      nativeEvent: { layout: { width: 300, height: 200 } },
    });
    oldGrid.props.onScroll({
      nativeEvent: { contentOffset: { y: 5000 } },
    });
  });
  onSeenThrough.mockClear();

  await rerender(view({
    hits: [],
    status: 'loading',
    onSeenThrough,
  }));
  await rerender(view({
    hits: [hit(2)],
    status: 'ready',
    onSeenThrough,
  }));
  await act(async () => {
    screen.getByTestId('search-results').props.onLayout({
      nativeEvent: { layout: { width: 300, height: 200 } },
    });
  });

  expect(onSeenThrough).toHaveBeenCalledWith(9);
});

test('a remount after a width change reports only after the new list\'s layout', async () => {
  const onSeenThrough = jest.fn();
  const { rerender } = await render(view({
    viewportWidth: 390,
    hits: [hit(1)],
    onSeenThrough,
  }));
  const oldGrid = screen.getByTestId('search-results');

  await act(async () => {
    oldGrid.props.onLayout({
      nativeEvent: { layout: { width: 390, height: 200 } },
    });
  });
  onSeenThrough.mockClear();

  await rerender(view({
    viewportWidth: 800,
    hits: [],
    status: 'loading',
    onSeenThrough,
  }));
  await rerender(view({
    viewportWidth: 800,
    hits: [hit(2)],
    status: 'ready',
    onSeenThrough,
  }));

  expect(onSeenThrough).not.toHaveBeenCalled();
  await act(async () => {
    screen.getByTestId('search-results').props.onLayout({
      nativeEvent: { layout: { width: 800, height: 200 } },
    });
  });
  expect(onSeenThrough).toHaveBeenCalledWith(15);
});

test('keeps the query controlled and exposes submit commands', async () => {
  const onQueryChange = jest.fn();
  const onSubmit = jest.fn();
  await render(view({ onQueryChange, onSubmit }));

  expect(screen.getByTestId('screen-search')).toBeOnTheScreen();
  const input = screen.getByTestId('search-input');
  expect(input.props.value).toBe('catgirl');
  await fireEvent.changeText(input, 'portrait');
  expect(onQueryChange).toHaveBeenCalledWith('portrait');

  await fireEvent(input, 'submitEditing');
  await fireEvent.press(screen.getByTestId('search-submit'));
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

test('allows a different draft but guards an identical query while loading', async () => {
  const onSubmit = jest.fn();
  const { rerender } = await render(view({
    query: 'maid',
    submittedQuery: 'maid',
    hits: [],
    status: 'loading',
    onSubmit,
  }));

  expect(screen.getByTestId('search-submit')).toBeDisabled();
  await rerender(view({
    query: 'catgirl',
    submittedQuery: 'maid',
    hits: [],
    status: 'loading',
    onSubmit,
  }));
  expect(screen.getByTestId('search-submit')).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId('search-submit'));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test('opens the selected hit and reports its favorite state accessibly', async () => {
  const onOpen = jest.fn();
  await render(view({ favoriteKeys: ['danbooru:2'], onOpen }));

  const favorite = screen.getByRole('button', {
    name: '搜索结果，Danbooru，普通内容，已收藏',
  });
  expect(screen.getByTestId('search-tile-danbooru:2')).toBe(favorite);
  expect(favorite.props.accessibilityState).toEqual({ selected: true });
  await fireEvent.press(favorite);
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'danbooru:2' }), 1);
});

test('names no image source anywhere while results are on screen', async () => {
  await render(view());

  expect(screen.queryByTestId('search-source-picker')).not.toBeOnTheScreen();
  expect(screen.queryByTestId('search-provider-status-waifu_im'))
    .not.toBeOnTheScreen();
  expect(screen.queryByTestId('search-provider-status-danbooru'))
    .not.toBeOnTheScreen();
  expect(screen.queryByTestId('search-provider-failures')).not.toBeOnTheScreen();
  expect(screen.queryByText('有结果')).not.toBeOnTheScreen();
  expect(screen.queryByText(/全部来源/)).not.toBeOnTheScreen();
  expect(screen.queryByText(/部分图片来源/)).not.toBeOnTheScreen();
  expect(screen.getByTestId('search-results')).toBeOnTheScreen();
});

test('a failing source is one aggregate retryable error, not a per-source list', async () => {
  await render(view({
    hits: [],
    status: 'error',
    errorMessage: '暂时无法确认这个标签的结果，请稍后重试。',
  }));

  expect(screen.queryByTestId('search-provider-failures')).not.toBeOnTheScreen();
  expect(screen.queryByText(/部分图片来源/)).not.toBeOnTheScreen();
  expect(screen.queryByText(/Danbooru/)).not.toBeOnTheScreen();
  expect(screen.getByText('暂时无法确认这个标签的结果，请稍后重试。'))
    .toBeOnTheScreen();
});

test('does not show a translated-tag banner or local suggestion buttons', async () => {
  await render(view({
    hits: [],
    status: 'empty',
    submittedQuery: '米法',
  }));

  expect(screen.queryByText(/已识别/u)).not.toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: /搜索标签/u })).not.toBeOnTheScreen();
});

test('loads another page from the footer command or list boundary', async () => {
  const onLoadMore = jest.fn();
  await render(view({ onLoadMore }));

  await fireEvent.press(screen.getByRole('button', { name: '加载更多结果' }));
  await fireEvent(screen.getByTestId('search-results'), 'endReached');
  expect(onLoadMore).toHaveBeenCalledTimes(2);
});

test('lets an empty multi-tag page continue while a provider has more pages', async () => {
  const onLoadMore = jest.fn();
  await render(view({
    hits: [],
    status: 'empty',
    submittedQuery: 'gundam, maid',
    hasNextPage: true,
    onLoadMore,
  }));

  expect(screen.getByText('这一页还没找到“gundam, maid”')).toBeOnTheScreen();
  expect(screen.getByText('这一页没有匹配图片，但还有后续页面。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '继续查找搜索结果' }));
  expect(onLoadMore).toHaveBeenCalledTimes(1);
});

test.each([
  ['idle', '从一个标签开始'],
  ['loading', '正在搜索'],
  ['empty', '没有找到“catgirl”'],
  ['unsupported', '没有图片来源接受这次查询'],
  ['error', '搜索失败'],
] as const)('renders the %s state', async (status, expectedTitle) => {
  await render(view({
    hits: [],
    status,
    errorMessage: status === 'error' ? '搜索暂时不可用' : null,
    hasNextPage: false,
  }));

  expect(screen.getByText(expectedTitle)).toBeOnTheScreen();
});

test('updates visible and accessibility copy immediately after a language switch', async () => {
  await render(view({
    query: '',
    hits: [],
    status: 'idle',
    hasNextPage: false,
  }));

  expect(screen.getByText('从一个标签开始')).toBeOnTheScreen();
  expect(screen.getByLabelText('搜索关键词').props.placeholder)
    .toBe('来源标签或查询');

  await act(async () => {
    await i18n.changeLanguage('en');
  });

  expect(screen.getByText('Start with a tag')).toBeOnTheScreen();
  expect(screen.getByLabelText('Search keywords').props.placeholder)
    .toBe('Source tag or query');
});

test('R8.29: the search input opens a Latin keyboard on Android', async () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  try {
    await render(view());
    // visible-password gives an ASCII/QWERTY layout with no IME composing
    // region, so pinyin candidates can never strand the typed Latin letters.
    expect(screen.getByTestId('search-input').props.keyboardType).toBe('visible-password');
  } finally {
      Platform.OS = original;
  }
});

test('R8.29: iOS keeps the default keyboard for the search input', async () => {
  const original = Platform.OS;
  Platform.OS = 'ios';
  try {
    await render(view());
    expect(screen.getByTestId('search-input').props.keyboardType).toBe('default');
  } finally {
      Platform.OS = original;
  }
});

test('R8.29: submitting an empty query shows a hint instead of a dead button', async () => {
  const onSubmit = jest.fn();
  const onQueryChange = jest.fn();
  await render(view({
    query: '   ',
    status: 'idle',
    hits: [],
    hasNextPage: false,
    onSubmit,
    onQueryChange,
  }));

  // The button is now pressable while empty, so the tap is observable rather
  // than a disabled no-op.
  expect(screen.getByTestId('search-submit')).not.toBeDisabled();
  expect(screen.queryByTestId('search-empty-hint')).not.toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId('search-submit'));
  expect(onSubmit).not.toHaveBeenCalled();
  const hint = screen.getByTestId('search-empty-hint');
  expect(hint).toBeOnTheScreen();
  expect(hint.props.children).toBe(i18n.t('search.emptyHint'));

  // Typing a real query clears the hint again.
  await fireEvent.changeText(screen.getByTestId('search-input'), 'maid');
  expect(onQueryChange).toHaveBeenCalledWith('maid');
  expect(screen.queryByTestId('search-empty-hint')).not.toBeOnTheScreen();
});
