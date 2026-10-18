/* eslint-disable @typescript-eslint/no-require-imports */
import {
  usePathname,
  useRouter,
} from 'expo-router';
import {
  fireEvent,
  renderRouter,
  screen,
} from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { act } from '@testing-library/react-native';
import { BackHandler, Pressable, Text, View } from 'react-native';

import RootLayout, {
  rootStackScreenOptions,
} from '@/app/_layout';
import TabsLayout from '@/app/(tabs)/_layout';
import CollectionRoute from '@/app/(tabs)/collection';
import DiscoverRoute from '@/app/(tabs)/index';
import SearchRoute from '@/app/(tabs)/search';
import SettingsRoute from '@/app/(tabs)/settings';
import CloudRoute from '@/app/settings/cloud';
import ImageDetailRoute from '@/app/image/[id]';
import ImportedImageDetailRoute from '@/app/image/import/[sha256]';
import i18n from '@/i18n';

jest.mock('@/providers/app-services', () => ({
  ...jest.requireActual('@/providers/app-services'),
  AppServicesProvider: ({ children }: { children: ReactNode }) => children,
  useAppServices: () => ({ byosStatus: { status: 'unconfigured' }, libraryActions: null,
    librarySync: null, libraryChanges: null, libraryStorageMode: null, libraryController: null }),
}));

jest.mock('lucide-react-native', () => ({
  Images: 'ImagesIcon',
  Search: 'SearchIcon',
  Settings2: 'SettingsIcon',
  Sparkles: 'SparklesIcon',
  Check: 'CheckIcon',
  Cloud: 'CloudIcon',
  Lock: 'LockIcon',
}));

jest.mock('@/screens/discover/discover-screen', () => ({
  DiscoverScreen: 'DiscoverScreen',
}));

jest.mock('@/screens/image-detail/image-detail-screen', () => {
  const actual = jest.requireActual('@/screens/image-detail/image-detail-screen');
  const React = require('react');
  const { useRouter } = require('expo-router');
  const { Pressable, Text } = require('react-native');

  return {
    ...actual,
    ImageDetailScreen: ({
      imageId,
      importSha256,
    }: {
      imageId?: number;
      importSha256?: string;
    }) => {
      const router = useRouter();
      const target = importSha256 ?? imageId;
      return React.createElement(
        Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: `关闭图片 ${target}`,
          onPress: () => router.back(),
        },
        React.createElement(Text, null, `图片 ${target}`),
      );
    },
  };
});

jest.mock('@/screens/settings/settings-screen', () => {
  const React = require('react');
  const { Pressable, View, Text } = require('react-native');
  const { useRouter } = require('expo-router');
  return {
    SettingsScreen: () => {
      const navigation = useRouter();
      return React.createElement(View, { 'aria-label': '设置内容', testID: 'screen-settings' },
        React.createElement(Pressable, { testID: 'settings-cloud-card', onPress: () => navigation.push('/settings/cloud') },
          React.createElement(Text, null, '打开云库')));
    },
  };
});

jest.mock('@/screens/settings/cloud-library-screen', () => {
  const React = require('react');
  const { View, Text } = require('react-native');
  return { CloudLibraryScreen: () => React.createElement(View, { testID: 'screen-settings-cloud' },
    React.createElement(Text, null, 'CloudLibraryScreen rendered')) };
});

jest.mock('@/screens/search/search-screen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SearchScreen: () => React.createElement(View, { 'aria-label': '搜索内容' }),
  };
});

function CollectionNavigationFixture() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <View>
      <Text>收藏路由已显示</Text>
      <Text>{`当前路径：${pathname}`}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="打开测试图片"
        onPress={() => router.push('/image/7')}>
        <Text>打开</Text>
      </Pressable>
    </View>
  );
}

function DiscoverNavigationFixture() {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="从发现打开测试图片"
      onPress={() => router.push('/image/7')}>
      <Text>从发现打开</Text>
    </Pressable>
  );
}

function routeNames(state: unknown): string[] {
  if (!state || typeof state !== 'object' || !('routes' in state)) {
    return [];
  }

  const routes = (state as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) {
    return [];
  }

  return routes.flatMap((route: unknown) => {
    if (!route || typeof route !== 'object' || !('name' in route)) {
      return [];
    }

    const { name, state: childState } = route as { name: unknown; state?: unknown };
    return typeof name === 'string' ? [name, ...routeNames(childState)] : [];
  });
}

describe('Waifu Deck app shell', () => {
  beforeEach(async () => i18n.changeLanguage('zh-Hans'));

  test.each(['header', 'Android'] as const)('cloud route renders its screen under the translated Stack title; %s back returns to Settings', async (backKind) => {
    let hardwareBack: (() => boolean | null | undefined) | undefined;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      hardwareBack = handler;
      return { remove: jest.fn() };
    });
    const result = renderRouter({ _layout: RootLayout, '(tabs)/_layout': TabsLayout,
      '(tabs)/index': DiscoverRoute, '(tabs)/search': SearchRoute, '(tabs)/collection': CollectionRoute,
      '(tabs)/settings': SettingsRoute, 'settings/cloud': CloudRoute,
      'image/[id]': ImageDetailRoute, 'library/trash': () => null, 'settings/sources': () => null }, { initialUrl: '/settings' });
    await result;
    await fireEvent.press(screen.getByTestId('settings-cloud-card'));
    expect(screen.getByTestId('screen-settings-cloud')).toBeOnTheScreen();
    expect(screen.getByText('CloudLibraryScreen rendered')).toBeOnTheScreen();
    // Native Stack titles are header-config props, not JS Text nodes.
    const header = screen.container.queryAll((node) => node.type === 'RNSScreenStackHeaderConfig' && node.props.title === '云库');
    expect(header).toHaveLength(1);
    expect(result.getPathname()).toBe('/settings/cloud');
    if (backKind === 'header') {
      const page = screen.getByTestId('screen-settings-cloud');
      let nativeScreen = page.parent;
      while (nativeScreen && typeof nativeScreen.props.onHeaderBackButtonClicked !== 'function') nativeScreen = nativeScreen.parent;
      expect(nativeScreen).toBeTruthy();
      await fireEvent(nativeScreen!, 'headerBackButtonClicked');
    } else {
      expect(hardwareBack).toEqual(expect.any(Function));
      await act(async () => { expect(hardwareBack?.()).toBe(true); });
    }
    expect(result.getPathname()).toBe('/settings');
    expect(screen.getByTestId('screen-settings')).toBeOnTheScreen();
  });

  test('disables root native-stack transitions', () => {
    expect(rootStackScreenOptions).toEqual({ animation: 'none' });
  });

  test('resolves the root route through the four primary tabs', async () => {
    await renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': DiscoverRoute,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionRoute,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
      },
      { initialUrl: '/' },
    );

    expect(screen.getByRole('button', { name: '发现' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '搜索' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '收藏' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '设置' })).toBeOnTheScreen();
    // R8.17: all four tabs run headerless (owner decision 2026-09-08) — no
    // per-screen title exists anywhere in the tab shell anymore.
    expect(screen.queryByText('Waifu Deck')).not.toBeOnTheScreen();
    expect(screen.queryByText(/This starter app includes example/i)).not.toBeOnTheScreen();
  });

  test('renders primary navigation in the selected language', async () => {
    await i18n.changeLanguage('en');
    await renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': DiscoverRoute,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionRoute,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
      },
      { initialUrl: '/' },
    );

    for (const label of ['Discover', 'Search', 'Collection', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeOnTheScreen();
    }
  });

  test('normal detail close guarantees Collection with one existing tab route', async () => {
    const result = renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': DiscoverNavigationFixture,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionNavigationFixture,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
      },
      { initialUrl: '/' },
    );
    await result;

    await fireEvent.press(screen.getByRole('button', { name: '从发现打开测试图片' }));
    expect(await screen.findByRole('button', { name: '关闭图片 7' })).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: '关闭图片 7' }));

    expect(await screen.findByText('收藏路由已显示')).toBeOnTheScreen();
    expect(screen.getByText('当前路径：/collection')).toBeOnTheScreen();
    const names = routeNames(result.getRouterState());
    expect(names.filter((name) => name === '(tabs)')).toHaveLength(1);
    expect(names).not.toContain('image/[id]');
  });

  test('fallback close navigates to Collection without duplicating the tab route', async () => {
    const result = renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': DiscoverRoute,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionNavigationFixture,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
      },
      { initialUrl: '/image/not-a-number' },
    );
    await result;

    expect(await screen.findByText('图片地址无效')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '返回收藏' }));

    expect(await screen.findByText('收藏路由已显示')).toBeOnTheScreen();
    expect(screen.getByText('当前路径：/collection')).toBeOnTheScreen();
    const names = routeNames(result.getRouterState());
    expect(names.filter((name) => name === '(tabs)')).toHaveLength(1);
    expect(names).not.toContain('image/[id]');
  });

  test('N6-C: import detail route validates 64-hex digests and normal close returns to Collection', async () => {
    const validSha = 'a'.repeat(64);
    function ImportNavigationFixture() {
      const router = useRouter();
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开导入测试图片"
          onPress={() => router.push(`/image/import/${validSha}`)}>
          <Text>打开导入</Text>
        </Pressable>
      );
    }
    const result = renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': ImportNavigationFixture,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionNavigationFixture,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
        'image/import/[sha256]': ImportedImageDetailRoute,
      },
      { initialUrl: '/' },
    );
    await result;

    await fireEvent.press(screen.getByRole('button', { name: '打开导入测试图片' }));
    expect(await screen.findByRole('button', { name: `关闭图片 ${validSha}` })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: `关闭图片 ${validSha}` }));
    expect(await screen.findByText('收藏路由已显示')).toBeOnTheScreen();
    const names = routeNames(result.getRouterState());
    expect(names.filter((name) => name === '(tabs)')).toHaveLength(1);
    expect(names).not.toContain('image/import/[sha256]');
  });

  test('N6-C: invalid import digest on /image/import/[sha256] renders error state and returns to Collection', async () => {
    const result = renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': DiscoverRoute,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionNavigationFixture,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
        'image/import/[sha256]': ImportedImageDetailRoute,
      },
      { initialUrl: '/image/import/12345' },
    );
    await result;

    expect(await screen.findByText('图片地址无效')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '返回收藏' }));
    expect(await screen.findByText('收藏路由已显示')).toBeOnTheScreen();
    expect(screen.getByText('当前路径：/collection')).toBeOnTheScreen();
  });

  test('N6-C: a 64-hex digest on /image/[id] is rejected as invalid numeric address', async () => {
    const validSha = 'a'.repeat(64);
    const result = renderRouter(
      {
        _layout: RootLayout,
        '(tabs)/_layout': TabsLayout,
        '(tabs)/index': DiscoverRoute,
        '(tabs)/search': SearchRoute,
        '(tabs)/collection': CollectionNavigationFixture,
        '(tabs)/settings': SettingsRoute,
        'image/[id]': ImageDetailRoute,
        'image/import/[sha256]': ImportedImageDetailRoute,
      },
      { initialUrl: `/image/${validSha}` },
    );
    await result;

    expect(await screen.findByText('图片地址无效')).toBeOnTheScreen();
  });
});
