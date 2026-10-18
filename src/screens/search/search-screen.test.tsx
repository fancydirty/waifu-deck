/* eslint-disable @typescript-eslint/no-require-imports */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type {
  CollectionDownloadResult,
  CollectionService,
} from '@/features/collection/collection-service';
import { collectionQueryKey } from '@/features/collection/collection-query';
import type { DiscoveryService } from '@/features/discovery/discovery-service';
import type {
  ImageRepository,
  StoredImage,
} from '@/features/images/image-repository';
import type { SearchHit } from '@/features/search/types';
import type { ProviderRequestGovernor } from '@/features/providers/provider-resilience';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type { AppSettings, ImageCandidate } from '@/features/waifu/types';
import i18n from '@/i18n';
import type { AppServicesContextValue } from '@/providers/app-services';
import { SearchScreen } from '@/screens/search/search-screen';
import { useSearch, type UseSearchResult } from '@/screens/search/use-search';

let mockAppServices: AppServicesContextValue;
let mockSearchHits: SearchHit[] = [];

const mockRefetch = jest.fn(async () => undefined);
const mockFetchNextPage = jest.fn(async () => undefined);

jest.mock('@/providers/app-services', () => ({
  useAppServices: () => mockAppServices,
}));

jest.mock('@/screens/search/use-search', () => ({
  useSearch: jest.fn(),
}));

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

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => undefined),
}));

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    ExternalLink: Icon,
    EyeOff: Icon,
    Heart: Icon,
    Search: Icon,
    Check: Icon,
    ChevronDown: Icon,
    X: Icon,
  };
});

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

const mockUseSearch = jest.mocked(useSearch);
const mockProviderRequestGovernor = {} as ProviderRequestGovernor;

type ServiceOverrides = {
  settings?: AppSettings;
  collectionService?: Partial<CollectionService>;
  discoveryService?: Partial<DiscoveryService>;
  imageRepository?: Partial<ImageRepository>;
};

function createAppServices({
  settings = DEFAULT_SETTINGS,
  collectionService = {},
  discoveryService = {},
  imageRepository = {},
}: ServiceOverrides = {}): AppServicesContextValue {
  return {
    settings,
    providerRequestGovernor: mockProviderRequestGovernor,
    providerCredentials: {
      snapshot: () => ({}),
      save: jest.fn(),
      clear: jest.fn(),
    },
    collectionService: {
      saveCandidate: jest.fn(),
      ...collectionService,
    },
    discoveryService: {
      restore: jest.fn().mockResolvedValue({ active: null, queued: [] }),
      ...discoveryService,
    },
    imageRepository: {
      listCollection: jest.fn().mockResolvedValue([]),
      ...imageRepository,
    },
  } as unknown as AppServicesContextValue;
}

function queryClient(initialCollection: StoredImage[] = []): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
    },
  });
  client.setQueryData(collectionQueryKey(), initialCollection);
  return client;
}

function searchScreen(
  client: QueryClient,
  props: React.ComponentProps<typeof SearchScreen> = {},
) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <QueryClientProvider client={client}>
        <SearchScreen {...props} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function candidate(
  providerKey: ImageCandidate['providerKey'],
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): ImageCandidate {
  return {
    providerKey,
    providerItemId,
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${providerKey}/${providerItemId}.jpg`,
    sourceUrl: `https://source.example.com/${providerKey}/${providerItemId}`,
    artistName: `Artist ${providerItemId}`,
    artistUrl: null,
    width: 1200,
    height: 1800,
    byteSize: 750_000,
    extension: 'jpg',
    dominantColor: '#726A7D',
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    ...overrides,
  };
}

function hit(
  providerKey: ImageCandidate['providerKey'],
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): SearchHit {
  return {
    key: `${providerKey}:${providerItemId}`,
    previewUrl: `https://preview.example.com/${providerKey}/${providerItemId}.jpg`,
    image: candidate(providerKey, providerItemId, overrides),
  };
}

function storedImage(
  id: number,
  overrides: Partial<StoredImage> = {},
): StoredImage {
  return {
    id,
    ...candidate('waifu_im', String(id)),
    contentRating: 'safe',
    nativeRating: null,
    decision: 'saved',
    presentedAt: 1,
    decidedAt: id * 100,
    queueOrdinal: id,
    decisionOrdinal: id,
    localUri: `file:///collection/${id}.jpg`,
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function submitSearch(value: string) {
  await fireEvent.changeText(screen.getByLabelText('搜索关键词'), value);
  await fireEvent.press(screen.getByRole('button', { name: '提交搜索' }));
}

async function flushQueryNotifications() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans');
  mockSearchHits = [];
  mockRefetch.mockReset();
  mockRefetch.mockResolvedValue(undefined);
  mockFetchNextPage.mockReset();
  mockFetchNextPage.mockResolvedValue(undefined);
  mockUseSearch.mockReset();
  mockUseSearch.mockImplementation((request, providers): UseSearchResult => ({
    hits: request === null ? [] : mockSearchHits,
    failures: [],
    enabledProviderCount: Object.values(providers).filter(Boolean).length,
    status: request === null
      ? 'idle'
      : mockSearchHits.length > 0 ? 'success' : 'empty',
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: mockFetchNextPage,
    refetch: mockRefetch,
    noteSeen: jest.fn(),
  }));
  mockAppServices = createAppServices();
});

test('submits raw terms with current quality settings and refetches the same query', async () => {
  const client = queryClient();
  const view = await render(searchScreen(client));
  await fireEvent.changeText(
    screen.getByLabelText('搜索关键词'),
    ' Raiden Shogun, solo ',
  );

  const currentSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    providers: { waifu_im: true, nekos_api: false, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
    excludedTags: ['loli', 'guro'],
    nsfwMode: 'mixed',
    orientation: 'landscape',
    animationMode: 'include',
    minWidth: 1080,
    maxBytes: 5_000_000,
  };
  mockAppServices = { ...mockAppServices, settings: currentSettings };
  await view.rerender(searchScreen(client));

  await fireEvent.press(screen.getByRole('button', { name: '提交搜索' }));

  await waitFor(() => expect(mockUseSearch).toHaveBeenLastCalledWith({
    tags: ['Raiden Shogun, solo'],
    excludedTags: [],
    nsfwMode: 'mixed',
    // R8.15: search never inherits the deck's orientation filter.
    orientation: 'any',
    animationMode: 'include',
    minWidth: 1080,
    maxBytes: 5_000_000,
  }, currentSettings.providers, mockProviderRequestGovernor, {}));
  expect(mockRefetch).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByRole('button', { name: '提交搜索' }));
  expect(mockRefetch).toHaveBeenCalledTimes(1);
});

test('submits a Chinese tag unchanged without a translated-tag banner', async () => {
  await render(searchScreen(queryClient()));

  await submitSearch('雷电将军');

  expect(mockUseSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({ tags: ['雷电将军'], excludedTags: [] }),
    DEFAULT_SETTINGS.providers,
    mockProviderRequestGovernor,
    {},
  );
  expect(screen.queryByText(/已识别/u)).not.toBeOnTheScreen();
});

test('submits unknown and provider-native terms instead of rejecting them locally', async () => {
  await render(searchScreen(queryClient()));

  await submitSearch('米法，character:foo，-bar');

  expect(mockUseSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      tags: ['米法，character:foo，-bar'],
      excludedTags: [],
    }),
    DEFAULT_SETTINGS.providers,
    mockProviderRequestGovernor,
    {},
  );
  expect(screen.queryByText('暂不识别这个标签')).not.toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: /搜索标签/u })).not.toBeOnTheScreen();
});

test('a tag link searches every enabled source exactly like a typed query', async () => {
  // R8.31 (owner ruling A, 2026-09-09): there is no hidden per-source scope.
  // A tag tapped on image detail arrives as initialQuery only and reaches
  // every source enabled in Settings, the same as text the user types.
  const providers = { ...DEFAULT_SETTINGS.providers, waifu_im: false };
  mockAppServices = createAppServices({
    settings: { ...DEFAULT_SETTINGS, providers },
  });
  await render(searchScreen(queryClient(), { initialQuery: 'School Uniform' }));

  const [request, linkedProviders] = mockUseSearch.mock.lastCall!;
  expect(request?.tags).toEqual(['School Uniform']);
  expect(linkedProviders).toEqual(providers);
  // The link lands on the ordinary aggregate outcome for that query — here the
  // empty state naming it — instead of the error dead end a disabled scope
  // used to produce.
  expect(screen.getByText('没有找到“School Uniform”')).toBeOnTheScreen();
  expect(screen.queryByText('搜索失败')).not.toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: /重试/u })).not.toBeOnTheScreen();

  // A query the user then types keeps exactly the same source set: nothing
  // about the link narrowed it, so nothing has to be un-narrowed.
  await submitSearch('maid');
  expect(mockUseSearch.mock.lastCall![1]).toEqual(providers);
});

test('searches every enabled source without exposing an in-screen source control', async () => {
  const originalProviders = { ...DEFAULT_SETTINGS.providers };
  await render(searchScreen(queryClient()));
  await submitSearch('id:1,2 ~solo');

  const [request, providers] = mockUseSearch.mock.lastCall!;
  expect(request?.tags).toEqual(['id:1,2 ~solo']);
  expect(providers).toEqual(originalProviders);
  expect(mockAppServices.settings.providers).toEqual(originalProviders);
  expect(screen.queryByTestId('search-source-picker')).not.toBeOnTheScreen();
});

test('submits a different nonempty draft while the previous query is loading', async () => {
  mockUseSearch.mockImplementation((request, providers): UseSearchResult => ({
    hits: [],
    failures: [],
    enabledProviderCount: Object.values(providers).filter(Boolean).length,
    status: request === null ? 'idle' : 'loading',
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: mockFetchNextPage,
    refetch: mockRefetch,
    noteSeen: jest.fn(),
  }));
  await render(searchScreen(queryClient()));
  await submitSearch('maid');

  expect(screen.getByTestId('search-submit')).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText('搜索关键词'), 'catgirl');
  expect(screen.getByTestId('search-submit')).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId('search-submit'));

  expect(mockUseSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({ tags: ['catgirl'] }),
    DEFAULT_SETTINGS.providers,
    mockProviderRequestGovernor,
    {},
  );
  expect(screen.getByTestId('search-submit')).toBeDisabled();
});

test('shows a settings-specific error when every provider is disabled', async () => {
  const providers = {
    waifu_im: false,
    nekos_api: false,
    danbooru: false,
    safebooru: false,
    yandere: false,
    konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
  };
  mockAppServices = createAppServices({
    settings: { ...DEFAULT_SETTINGS, providers },
  });
  await render(searchScreen(queryClient()));

  await submitSearch('maid');

  expect(await screen.findByText('请先在设置中打开至少一个图片来源。'))
    .toBeOnTheScreen();
  expect(screen.getByText('搜索失败')).toBeOnTheScreen();
  expect(mockUseSearch).toHaveBeenLastCalledWith(
    expect.objectContaining({ tags: ['maid'] }),
    providers,
    mockProviderRequestGovernor,
    {},
  );
});

test('matches cached favorites by provider identity, canonical source, and hash', async () => {
  mockSearchHits = [
    hit('waifu_im', 'provider-match'),
    hit('danbooru', 'canonical-match', {
      canonicalSourceKey: 'pixiv:100',
    }),
    hit('nekos_api', 'hash-match', {
      perceptualHash: 'hash-200',
    }),
    hit('danbooru', 'new-result'),
  ];
  const collection = [
    storedImage(1, {
      providerKey: 'waifu_im',
      providerItemId: 'provider-match',
      canonicalSourceKey: null,
      perceptualHash: null,
    }),
    storedImage(2, {
      providerKey: 'waifu_im',
      providerItemId: 'different-provider-item',
      canonicalSourceKey: 'pixiv:100',
      perceptualHash: null,
    }),
    storedImage(3, {
      providerKey: 'danbooru',
      providerItemId: 'different-hash-item',
      canonicalSourceKey: null,
      perceptualHash: 'hash-200',
    }),
  ];
  const listCollection = jest.fn().mockResolvedValue([]);
  mockAppServices = createAppServices({ imageRepository: { listCollection } });
  await render(searchScreen(queryClient(collection)));

  await submitSearch('waifu');

  const tiles = await screen.findAllByRole('button', { name: /^搜索结果，/ });
  expect(tiles.map((tile) => tile.props.accessibilityState.selected)).toEqual([
    true,
    true,
    true,
    false,
  ]);
  expect(listCollection).not.toHaveBeenCalled();
});

test('publishes DB-first favorite state, prevents duplicate saves, then republishes after download', async () => {
  const result = hit('danbooru', '42');
  mockSearchHits = [result];
  const backgroundDownload = deferred<CollectionDownloadResult>();
  const databaseSave = deferred<Awaited<ReturnType<CollectionService['saveCandidate']>>>();
  const saveCandidate = jest.fn(() => databaseSave.promise);
  let collection: StoredImage[] = [];
  const listCollection = jest.fn(async () => collection);
  mockAppServices = createAppServices({
    collectionService: { saveCandidate },
    imageRepository: { listCollection },
  });
  const client = queryClient();
  await render(searchScreen(client));
  await submitSearch('raiden shogun');
  await fireEvent.press(await screen.findByRole('button', {
    name: '搜索结果，Danbooru，普通内容，未收藏',
  }));

  await fireEvent.press(screen.getByRole('button', { name: '收藏图片' }));
  await waitFor(() => expect(screen.getByText('保存中')).toBeOnTheScreen());
  await fireEvent.press(screen.getByRole('button', { name: '收藏图片' }));

  expect(saveCandidate).toHaveBeenCalledTimes(1);
  expect(saveCandidate).toHaveBeenCalledWith(result.image);
  expect(listCollection).not.toHaveBeenCalled();
  expect(client.getQueryData(collectionQueryKey())).toEqual([]);

  const pending = storedImage(42, {
    ...result.image,
    localUri: null,
    downloadState: 'pending',
  });
  collection = [pending];
  await act(async () => {
    databaseSave.resolve({
      image: pending,
      backgroundDownload: backgroundDownload.promise,
    });
    await databaseSave.promise;
  });

  await waitFor(() => {
    expect(listCollection).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(collectionQueryKey())).toEqual([pending]);
  });
  expect(screen.getByRole('button', { name: '图片已收藏' }).props.accessibilityState)
    .toEqual({ disabled: true, selected: true });

  const ready = storedImage(42, {
    ...result.image,
    localUri: 'file:///collection/42.jpg',
    downloadState: 'ready',
  });
  collection = [ready];
  await act(async () => {
    backgroundDownload.resolve({
      status: 'ready',
      uri: 'file:///collection/42.jpg',
      reused: false,
    });
    await backgroundDownload.promise;
  });

  await waitFor(() => {
    expect(listCollection).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(collectionQueryKey())).toEqual([ready]);
  });
  expect(saveCandidate).toHaveBeenCalledTimes(1);
  await flushQueryNotifications();
});

test('opens and closes the original modal without losing input or results and opens its source', async () => {
  const result = hit('nekos_api', 'source-result');
  mockSearchHits = [result];
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  await render(searchScreen(queryClient()));
  await submitSearch('catgirl');

  await fireEvent.press(await screen.findByRole('button', {
    name: '搜索结果，Nekos API，普通内容，未收藏',
  }));
  expect(screen.getByLabelText('原图全屏画廊')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '打开图片来源' }));
  await waitFor(() => expect(openURL).toHaveBeenCalledWith(result.image.sourceUrl));
  await fireEvent.press(screen.getByRole('button', { name: '关闭原图画廊' }));

  expect(screen.getByLabelText('搜索关键词').props.value).toBe('catgirl');
  expect(screen.getByRole('button', {
    name: '搜索结果，Nekos API，普通内容，未收藏',
  })).toBeOnTheScreen();
  expect(mockSearchHits).toEqual([result]);
});

test('freezes the open detail order while providers add earlier results', async () => {
  const first = hit('nekos_api', 'first');
  const second = hit('danbooru', 'second', { width: 1400, height: 2100 });
  const late = hit('waifu_im', 'late', { width: 1600, height: 2400 });
  mockSearchHits = [first, second];
  const client = queryClient();
  const view = await render(searchScreen(client));
  await submitSearch('maid');

  await fireEvent.press(await screen.findByRole('button', {
    name: '搜索结果，Nekos API，普通内容，未收藏',
  }));
  expect(screen.getByText('1200 x 1800 · Nekos API · 1/2')).toBeOnTheScreen();

  mockSearchHits = [late, first, second];
  await view.rerender(searchScreen(client));

  expect(screen.getByText('1200 x 1800 · Nekos API · 1/2')).toBeOnTheScreen();
  expect(screen.queryByText('1600 x 2400 · Waifu.im · 1/3')).not.toBeOnTheScreen();

  const pager = screen.getByTestId('search-detail-pager');
  await fireEvent(pager, 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: pager.props.snapToInterval, y: 0 } },
  });
  expect(screen.getByText('1400 x 2100 · Danbooru · 2/2')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: '关闭原图画廊' }));
  await fireEvent.press(screen.getByRole('button', {
    name: '搜索结果，Waifu.im，普通内容，未收藏',
  }));
  expect(screen.getByText('1600 x 2400 · Waifu.im · 1/3')).toBeOnTheScreen();
});

test('keeps frozen detail favorite state when the live result set drops that hit', async () => {
  const frozen = hit('nekos_api', 'frozen');
  const replacement = hit('danbooru', 'replacement');
  mockSearchHits = [frozen];
  const client = queryClient([storedImage(9, {
    ...frozen.image,
    providerItemId: frozen.image.providerItemId,
  })]);
  const view = await render(searchScreen(client));
  await submitSearch('maid');

  await fireEvent.press(await screen.findByRole('button', {
    name: '搜索结果，Nekos API，普通内容，已收藏',
  }));
  expect(screen.getByRole('button', { name: '图片已收藏' })).toBeOnTheScreen();

  mockSearchHits = [replacement];
  await view.rerender(searchScreen(client));

  expect(screen.getByRole('button', { name: '图片已收藏' })).toBeOnTheScreen();
  expect(screen.getByText('1200 x 1800 · Nekos API · 1/1')).toBeOnTheScreen();
});

test('keeps DB save success when the first collection publication fails', async () => {
  const result = hit('danbooru', 'cache-failure');
  const existing = storedImage(7);
  const pending = storedImage(42, {
    ...result.image,
    localUri: null,
    downloadState: 'pending',
  });
  const ready = storedImage(42, {
    ...result.image,
    localUri: 'file:///collection/42.jpg',
    downloadState: 'ready',
  });
  const backgroundDownload = deferred<CollectionDownloadResult>();
  const saveCandidate = jest.fn().mockResolvedValue({
    image: pending,
    backgroundDownload: backgroundDownload.promise,
  });
  const listCollection = jest.fn()
    .mockRejectedValueOnce(new Error('temporary collection read failure'))
    .mockResolvedValueOnce([ready, existing]);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockSearchHits = [result];
  mockAppServices = createAppServices({
    collectionService: { saveCandidate },
    imageRepository: { listCollection },
  });
  const client = queryClient([existing]);
  await render(searchScreen(client));
  await submitSearch('raiden shogun');
  await fireEvent.press(await screen.findByRole('button', {
    name: '搜索结果，Danbooru，普通内容，未收藏',
  }));

  await fireEvent.press(screen.getByRole('button', { name: '收藏图片' }));

  await waitFor(() => {
    expect(client.getQueryData(collectionQueryKey())).toEqual([pending, existing]);
    expect(listCollection).toHaveBeenCalledTimes(1);
  });
  expect(alert).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '图片已收藏' })).toBeOnTheScreen();

  await act(async () => {
    backgroundDownload.resolve({
      status: 'ready',
      uri: 'file:///collection/42.jpg',
      reused: false,
    });
    await backgroundDownload.promise;
  });

  await waitFor(() => {
    expect(listCollection).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(collectionQueryKey())).toEqual([ready, existing]);
  });
  expect(alert).not.toHaveBeenCalled();
  await flushQueryNotifications();
});

test('does not write search hits into discovery seen or dismissed state', async () => {
  mockSearchHits = [hit('waifu_im', 'read-only')];
  const insertCandidates = jest.fn().mockResolvedValue(0);
  const activateNext = jest.fn().mockResolvedValue(null);
  const repositoryDecide = jest.fn().mockResolvedValue(null);
  const discoveryDecide = jest.fn().mockResolvedValue(null);
  const saveCandidate = jest.fn();
  mockAppServices = createAppServices({
    collectionService: { saveCandidate },
    discoveryService: { decide: discoveryDecide },
    imageRepository: {
      insertCandidates,
      activateNext,
      decide: repositoryDecide,
    },
  });
  await render(searchScreen(queryClient()));

  await submitSearch('maid');
  await fireEvent.press(await screen.findByRole('button', {
    name: '搜索结果，Waifu.im，普通内容，未收藏',
  }));
  await fireEvent.press(screen.getByRole('button', { name: '关闭原图画廊' }));

  expect(insertCandidates).not.toHaveBeenCalled();
  expect(activateNext).not.toHaveBeenCalled();
  expect(repositoryDecide).not.toHaveBeenCalled();
  expect(discoveryDecide).not.toHaveBeenCalled();
  expect(saveCandidate).not.toHaveBeenCalled();
});
