/* eslint-disable @typescript-eslint/no-require-imports */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lightColors } from '@/theme/colors';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Profiler, Suspense, startTransition } from 'react';
import { Alert, Dimensions, View } from 'react-native';
import { createRoot } from 'test-renderer';

import type { CollectionService } from '@/features/collection/collection-service';
import { collectionQueryKey } from '@/features/collection/collection-query';
import type { StoredImage } from '@/features/images/image-repository';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';
import { LIBRARY_RENDER_WINDOW_AHEAD } from '@/features/library/library-cache-limits';
import {
  createLibraryImportSessionController,
  type LibraryImportSessionController,
} from '@/features/library/library-import-session';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import type { LibraryEntry } from '@/features/library/library-view-model';
import { viewDigest } from '@/features/library/library-view-test-support';
import i18n from '@/i18n';
import zhHans from '@/i18n/locales/zh-Hans';
import { HandedOverPublishersContext } from '@/providers/handed-over-publishers';
import { CollectionTile } from '@/screens/collection/collection-tile';
import { readDetailOpenSeed, setDetailOpenSeed } from '@/screens/image-detail/detail-open-seed';
import {
  CollectionView,
  CollectionScreen,
  deleteSelectedImages,
  deleteSelectedImports,
  getCollectionColumnCount,
  sameLibraryEntries,
} from '@/screens/collection/collection-screen';

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
};
let mockAppServices: any;
/**
 * K7 ⑦: expo-router calls a focus callback on every focus, not only on mount.
 * The suite needs both halves separately, so the mock keeps the live callbacks
 * and `refocus()` fires them the way a tab tap does.
 */
const mockFocusCallbacks = new Set<() => void | (() => void)>();
const mockFocusCleanups = new Map<() => void | (() => void), () => void>();
function refocus() {
  for (const [callback, cleanup] of [...mockFocusCleanups.entries()]) {
    cleanup();
    mockFocusCleanups.delete(callback);
  }
  for (const callback of [...mockFocusCallbacks]) {
    const cleanup = callback();
    if (typeof cleanup === 'function') {
      mockFocusCleanups.set(callback, cleanup);
    }
  }
}
function blurFocus() {
  for (const [callback, cleanup] of [...mockFocusCleanups.entries()]) {
    cleanup();
    mockFocusCleanups.delete(callback);
  }
}
/** Every `data` reference the grid has been handed, oldest first. */
const mockGridData: unknown[] = [];
/** Every `extraData` reference the grid has been handed, oldest first. */
const mockGridExtraData: unknown[] = [];
/** A suspended FlashList render, used to discard an update after `renderItem` runs. */
let mockReviewSuspend = false;
let mockReviewSuspendedRenders = 0;
let mockReviewOpen: (() => void) | null = null;
const mockReviewNever = new Promise(() => undefined);
/** How many times the mocked expo-image has rendered, keyed by its label. */
const mockImageRenders: Record<string, number> = {};

type MockStillResult = { uri: string | null; missing: boolean };
let mockStillPending: ((result: MockStillResult) => void)[] = [];
const mockStillStore = {
  stillFor: jest.fn((_uri: string, _byteSize: number) => new Promise<MockStillResult>((resolve) => {
    mockStillPending.push(resolve);
  })),
};

beforeEach(async () => i18n.changeLanguage('zh-Hans'));
beforeEach(() => {
  mockGridData.length = 0;
  mockGridExtraData.length = 0;
  for (const key of Object.keys(mockImageRenders)) delete mockImageRenders[key];
  mockStillPending = [];
  mockStillStore.stillFor.mockClear();
  mockReviewSuspend = false;
  mockReviewSuspendedRenders = 0;
  mockReviewOpen = null;
});

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => {
        mockFocusCallbacks.add(effect);
        const cleanup = effect();
        if (typeof cleanup === 'function') {
          mockFocusCleanups.set(effect, cleanup);
        }
        return () => {
          mockFocusCallbacks.delete(effect);
          const activeCleanup = mockFocusCleanups.get(effect);
          mockFocusCleanups.delete(effect);
          if (typeof activeCleanup === 'function') activeCleanup();
        };
      }, [effect]);
    },
  };
});

jest.mock('@/providers/app-services', () => ({
  useAppServices: () => mockAppServices,
}));

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View: NativeView } = require('react-native');
  return {
    FlashList: ({
      data,
      renderItem,
      keyExtractor,
      onViewableItemsChanged,
      extraData,
      ...props
    }: any) => {
      mockGridData.push(data);
      mockGridExtraData.push(extraData);
      React.useEffect(() => {
        if (!onViewableItemsChanged || data.length === 0) return;
        onViewableItemsChanged({
          viewableItems: [{
            index: 0,
            item: data[0],
            isViewable: true,
            key: keyExtractor ? keyExtractor(data[0], 0) : '0',
          }],
          changed: [],
        });
      }, [data, keyExtractor, onViewableItemsChanged]);
      const cells = data.map((item: unknown, index: number) => (
        <React.Fragment key={keyExtractor ? keyExtractor(item, index) : String(index)}>
          {renderItem({ item, index })}
        </React.Fragment>
      ));
      if (mockReviewSuspend) {
        mockReviewSuspendedRenders += 1;
        throw mockReviewNever;
      }
      const tile = cells[0]?.props.children?.props.children;
      mockReviewOpen = typeof tile?.props.onOpen === 'function' ? tile.props.onOpen : null;
      return (
        <NativeView testID="collection-list" {...props} onViewableItemsChanged={onViewableItemsChanged}>
          {cells}
        </NativeView>
      );
    },
  };
});

jest.mock('expo-image', () => {
  const { View: NativeView } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => {
      const label = props.accessibilityLabel;
      if (typeof label === 'string') {
        mockImageRenders[label] = (mockImageRenders[label] ?? 0) + 1;
      }
      return <NativeView {...props} />;
    },
  };
});

jest.mock('@/features/images/gif-first-frame', () => ({
  ...jest.requireActual('@/features/images/gif-first-frame'),
  defaultGifStillStore: () => mockStillStore,
}));

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    ArrowDownUp: Icon,
    ChevronDown: Icon,
    Cloud: Icon,
    Check: Icon,
    CheckSquare: Icon,
    EyeOff: Icon,
    ImagePlus: Icon,
    Search: Icon,
    Trash2: Icon,
    X: Icon,
  };
});

function image(id: number, overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id,
    providerKey: 'waifu_im',
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
    contentRating: 'safe',
    nativeRating: null,
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu'],
    decision: 'saved',
    presentedAt: 1,
    decidedAt: id * 100,
    queueOrdinal: id,
    decisionOrdinal: id,
    localUri: null,
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

function readyView(
  images: StoredImage[],
  overrides: Partial<React.ComponentProps<typeof CollectionView>> = {},
) {
  return (
    <CollectionView
      images={images}
      status="ready"
      blurNsfwThumbnails
      errorMessage={null}
      onBrowse={jest.fn()}
      onOpen={jest.fn()}
      onRefresh={jest.fn()}
      onDelete={jest.fn().mockResolvedValue(undefined)}
      viewportWidth={390}
      {...overrides}
    />
  );
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
    },
  });
}

/**
 * The `mockAppServices` shape the `CollectionScreen` container reads, with a
 * non-empty collection so the header (and its trash entry) renders. Pass a
 * `libraryView` override to make a library exist.
 */
function collectionMockServices() {
  return {
    collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
    dataRevision: 0,
    imageRepository: { listCollection: jest.fn().mockResolvedValue([image(1)]) },
    settings: { blurNsfwThumbnails: true },
    librarySyncTrigger: null,
    libraryBackgroundSync: null,
    libraryChanges: null,
    libraryView: null,
    libraryActions: null,
  };
}

describe('CollectionView', () => {
  test('a mounted offline grid re-resolves with the rebound resolver', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = libraryEntry({
      plaintextSha256: viewDigest('recovery-grid'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const localResolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'unavailable',
      category: 'offline',
    }));
    const cloudResolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///cloud-thumb.webp',
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    }));
    const rendered = await render(readyView([row], {
      libraryOverlay: { entries: [entry], access: 'offline', resolve: localResolve },
    }));
    await waitFor(() => expect(localResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'grid'));
    await rendered.rerender(readyView([row], {
      libraryOverlay: {
        entries: [{ ...entry }],
        access: 'ready',
        resolve: cloudResolve,
      },
    }));
    await waitFor(() => expect(cloudResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'grid'));
  });

  test('a resolver change keeps the file answer until the new resolve settles', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = libraryEntry({
      plaintextSha256: viewDigest('recovery-grid-kept'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const kept = 'file:///offline-thumb.webp';
    const next = 'file:///cloud-thumb.webp';
    const file = (uri: string): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    });
    const localResolve = jest.fn(async (): Promise<LibraryRenderSource> => file(kept));
    let finishCloud!: (source: LibraryRenderSource) => void;
    const cloudResolve = jest.fn(() => new Promise<LibraryRenderSource>((done) => {
      finishCloud = done;
    }));
    const rendered = await render(readyView([row], {
      libraryOverlay: { entries: [entry], access: 'offline', resolve: localResolve },
    }));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: kept }));

    await rendered.rerender(readyView([row], {
      libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: cloudResolve },
    }));

    expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: kept });
    expect(screen.queryByTestId('collection-tile-cover-7')).toBeNull();
    await act(async () => {
      finishCloud(file(next));
    });
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: next }));
  });

  test('a late answer from the previous resolver never publishes', async () => {
    const keptRow = image(7, { downloadState: 'mirrored', localUri: null });
    const lateRow = image(8, { downloadState: 'mirrored', localUri: null });
    const keptEntry = libraryEntry({
      plaintextSha256: viewDigest('recovery-grid-kept-late'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const lateEntry = libraryEntry({
      plaintextSha256: viewDigest('recovery-grid-late'),
      sourceImageId: 8,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const kept = 'file:///kept-thumb.webp';
    const stale = 'file:///stale-thumb.webp';
    const file = (uri: string): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    });
    let finishLate!: (source: LibraryRenderSource) => void;
    const localResolve = jest.fn((digest: string) => (
      digest === lateEntry.plaintextSha256
        ? new Promise<LibraryRenderSource>((done) => {
          finishLate = done;
        })
        : Promise.resolve(file(kept))
    ));
    const cloudResolve = jest.fn(() => new Promise<LibraryRenderSource>(() => undefined));
    const rendered = await render(readyView([keptRow, lateRow], {
      libraryOverlay: {
        entries: [keptEntry, lateEntry],
        access: 'offline',
        resolve: localResolve,
      },
    }));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: kept }));
    await waitFor(() => expect(localResolve).toHaveBeenCalledWith(lateEntry.plaintextSha256, 'grid'));

    await rendered.rerender(readyView([keptRow, lateRow], {
      libraryOverlay: {
        entries: [{ ...keptEntry }, { ...lateEntry }],
        access: 'ready',
        resolve: cloudResolve,
      },
    }));
    await act(async () => {
      finishLate(file(stale));
    });
    // The grid publishes on the next animation frame. The assertion has to
    // wait for that frame, or an old answer queued there still looks unpublished.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: kept });
    expect(screen.queryByLabelText('图片 8')).toBeNull();
  });

  test('an old pending publication frame cannot paint after the resolver changes', async () => {
    const frames: ((time: number) => void)[] = [];
    const raf = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback as (time: number) => void);
      return frames.length;
    });
    const cancel = jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => undefined);
    try {
      const row = image(7, { downloadState: 'mirrored', localUri: null });
      const entry = libraryEntry({
        plaintextSha256: viewDigest('recovery-grid-frame'),
        sourceImageId: 7,
        residency: 'cloud-only',
        hasLocalOriginal: false,
        localOriginalUri: null,
        originalGenerationId: 'g1',
      });
      const stale = 'file:///stale-frame.webp';
      const file = (uri: string): LibraryRenderSource => ({
        kind: 'file',
        uri,
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      });
      let finish!: (source: LibraryRenderSource) => void;
      const localResolve = jest.fn(() => new Promise<LibraryRenderSource>((done) => {
        finish = done;
      }));
      const cloudResolve = jest.fn(() => new Promise<LibraryRenderSource>(() => undefined));
      const rendered = await render(readyView([row], {
        libraryOverlay: { entries: [entry], access: 'offline', resolve: localResolve },
      }));
      await waitFor(() => expect(localResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'grid'));
      const queued = frames.length;
      await act(async () => {
        finish(file(stale));
      });
      expect(frames.length).toBeGreaterThan(queued);

      await rendered.rerender(readyView([row], {
        libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: cloudResolve },
      }));
      await act(async () => {
        for (const frame of frames.splice(0)) frame(0);
      });

      expect(screen.queryByLabelText('图片 7')).toBeNull();
    } finally {
      raf.mockRestore();
      cancel.mockRestore();
    }
  });

  test('R8.21: the header clears the top safe area instead of hiding under the status bar', async () => {
    await render(readyView([image(1)], { safeAreaTop: 47 }));
    expect(screen.getByTestId('screen-collection').props.style).toMatchObject({
      paddingTop: 47,
    });
  });

  test('every collection state paints its own opaque surface under the status bar', async () => {
    // The stack container background is solid ink (navigation-theme), so any
    // root that leaves its top-inset strip unpainted would show black on the
    // warm light theme. Every state — loading, error, empty, populated — owns
    // its background (drift review of b7fd89a, 2026-09-17, Finding 1).
    const surface = lightColors.surface;

    const { rerender } = await render(
      readyView([], { status: 'loading', safeAreaTop: 47 }),
    );
    expect(screen.getByTestId('screen-collection').props.style).toMatchObject({
      backgroundColor: surface,
    });

    await rerender(readyView([], { status: 'error', errorMessage: 'boom', safeAreaTop: 47 }));
    expect(screen.getByTestId('screen-collection').props.style).toMatchObject({
      backgroundColor: surface,
    });

    await rerender(readyView([], { status: 'ready', safeAreaTop: 47 }));
    expect(screen.getByTestId('screen-collection').props.style).toMatchObject({
      backgroundColor: surface,
    });
  });

  test('R8.17: the collection grid reserves for the floating tab bar', async () => {
    await render(readyView([image(1)]));

    const list = screen.getByTestId('collection-list');
    // The grid tail must scroll out from under the absolutely-positioned
    // floating bar (the owner's overlap bug class).
    expect(list.props.contentContainerStyle).toMatchObject({
      paddingBottom: tabBarContentInset(0),
    });
  });


  test('uses three phone columns and five wide columns', () => {
    expect(getCollectionColumnCount(390)).toBe(3);
    expect(getCollectionColumnCount(699)).toBe(3);
    expect(getCollectionColumnCount(700)).toBe(5);
  });

  test('renders newest-first stable 3:4 tiles with local URI preference', async () => {
    await render(readyView([
      image(1, { decidedAt: 100 }),
      image(2, { decidedAt: 300, localUri: 'file:///collection/2.jpg' }),
    ]));

    const tiles = screen.getAllByLabelText(/收藏图片/);
    expect(tiles.map((tile) => tile.props.accessibilityLabel)).toEqual([
      '收藏图片 2，画师 Artist 2，普通内容，可离线查看',
      '收藏图片 1，画师 Artist 1，普通内容，仅在线查看',
    ]);
    expect(tiles[0]).toHaveStyle({ aspectRatio: 3 / 4 });
    expect(within(tiles[0]).getByLabelText('图片 2').props.source).toEqual({
      uri: 'file:///collection/2.jpg',
    });
    expect(within(tiles[1]).getByLabelText('图片 1').props.source).toEqual({
      uri: 'https://cdn.example.com/1.jpg',
    });
    expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();
  });

  test('shows pending and failed badges and blurs configured NSFW thumbnails', async () => {
    await render(readyView([
      image(1, { downloadState: 'pending' }),
      image(2, { downloadState: 'failed', downloadError: 'download_failed' }),
      image(3, { isNsfw: true }),
    ]));

    expect(screen.getByText('保存中')).toBeOnTheScreen();
    expect(screen.getByText('需修复')).toBeOnTheScreen();
    expect(screen.getByLabelText('图片 3').props.blurRadius).toBe(24);
    expect(screen.queryByText('敏感内容')).not.toBeOnTheScreen();
  });

  test('board #5: a row the source deleted carries the 源站已删除 badge in the grid', async () => {
    await render(readyView([
      image(2, {
        downloadState: 'failed',
        downloadError: 'download_failed',
        downloadErrorKind: 'source_gone',
        localUri: null,
      }),
    ]));

    expect(screen.getByText('源站已删除')).toBeOnTheScreen();
    expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
  });

  test('filters SFW and NSFW galleries and only blurs NSFW in mixed mode', async () => {
    const onOpen = jest.fn();
    await render(readyView([
      image(1),
      image(2, { isNsfw: true }),
    ], { onOpen }));
    const mode = screen.getByLabelText('收藏内容模式');

    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(2);
    expect(screen.getByLabelText('图片 2').props.blurRadius).toBe(24);

    await fireEvent(mode, 'change', { nativeEvent: { selectedSegmentIndex: 2 } });
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(1);
    expect(screen.getByLabelText(/收藏图片 2/)).toBeOnTheScreen();
    expect(screen.getByLabelText('图片 2').props.blurRadius).toBe(0);
    expect(screen.getByText('1 张图片')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText(/收藏图片 2/));
    expect(onOpen).toHaveBeenCalledWith(2, expect.objectContaining({ mode: 'nsfw' }));

    await fireEvent(mode, 'change', { nativeEvent: { selectedSegmentIndex: 1 } });
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(1);
    expect(screen.getByLabelText(/收藏图片 1/)).toBeOnTheScreen();

    await fireEvent(mode, 'change', { nativeEvent: { selectedSegmentIndex: 0 } });
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(2);
  });

  test('R8.27: shows 全部/SFW/NSFW chips with live counts above the grid', async () => {
    await render(readyView([
      image(1, { artistName: 'Mika Pikazo' }),
      image(2, { artistName: 'Mika Pikazo' }),
      image(3, { artistName: 'Another Artist', isNsfw: true }),
    ]));

    // The count and the 18+ badge are spoken as well as drawn.
    expect(screen.getAllByRole('radio').map((chip) => (
      chip.props.accessibilityLabel
    ))).toEqual([
      '收藏内容模式：全部、3 张',
      '收藏内容模式：SFW、2 张',
      '收藏内容模式：NSFW、1 张、18+',
    ]);

    const chipAt = (index: number) => screen.getAllByRole('radio')[index]!;
    const chipCount = (index: number) => within(chipAt(index))
      .getByText(/^\d+$/).props.children;

    expect(chipCount(0)).toBe('3');
    expect(chipCount(1)).toBe('2');
    expect(chipCount(2)).toBe('1');
    expect(within(chipAt(2)).getByText('18+')).toBeOnTheScreen();

    // Counts follow the search term, not the whole library.
    await fireEvent.changeText(screen.getByLabelText('搜索收藏'), 'mika');
    expect(chipCount(0)).toBe('2');
    expect(chipCount(1)).toBe('2');
    expect(chipCount(2)).toBe('0');
    expect(chipAt(2).props.accessibilityLabel).toBe('收藏内容模式：NSFW、0 张、18+');
  });

  test('R8.27: the chip row sits below the search row, directly above the grid', async () => {
    await render(readyView([image(1)]));

    const filters = screen.getByLabelText('收藏内容筛选');
    const rows = filters.children as { type: string; props: Record<string, unknown> }[];
    const searchRowIndex = rows.findIndex((row) => (
      within(row as never).queryByLabelText('搜索收藏') !== null
    ));
    const chipRowIndex = rows.findIndex((row) => (
      within(row as never).queryAllByRole('radio').length > 0
    ));

    expect(searchRowIndex).toBeGreaterThanOrEqual(0);
    expect(chipRowIndex).toBe(searchRowIndex + 1);
    // The chip row is the last thing in the filter block, so it sits directly
    // above the grid.
    expect(chipRowIndex).toBe(rows.length - 1);
    expect(within(filters).queryByTestId('collection-list')).toBeNull();

    // Spec §4: the source chip sits at the END of the same chip row as
    // 全部/SFW/NSFW, not in the search row. Spec §2 makes that fit: the row
    // scrolls horizontally, and only the first three chips have to be fully
    // visible at 360dp — the source chip is reached by scrolling. A
    // `role=button` chip may not be a child of a `role=radiogroup`, so the row
    // is one `ScrollView horizontal` holding the non-scrolling radiogroup and
    // then the source chip.
    expect(within(rows[searchRowIndex] as never)
      .queryAllByRole('button', { name: /^来源：/ })).toHaveLength(0);

    const chipRow = rows[chipRowIndex]!;
    expect(chipRow.type).toBe('RCTScrollView');
    expect(chipRow).toHaveProp('horizontal', true);
    expect(chipRow).toHaveProp('showsHorizontalScrollIndicator', false);
    expect(within(chipRow as never)
      .getAllByLabelText(/^收藏内容模式$|^来源：/)
      .map((node) => node.props['aria-label'] ?? node.props.accessibilityLabel))
      .toEqual(['收藏内容模式', '来源：全部']);
    expect(within(chipRow as never)
      .getByRole('button', { name: '来源：全部' })).toBeOnTheScreen();
  });

  test('hides adult gallery controls and rows in the Store distribution', async () => {
    await render(readyView([
      image(1),
      image(2, { isNsfw: true, contentRating: 'explicit' }),
    ], { allowsAdultContent: false }));

    expect(screen.queryByLabelText('收藏内容模式')).not.toBeOnTheScreen();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '来源：全部' })).toBeOnTheScreen();
    // Spec §4: the Store variant keeps the same chip row with only the source
    // chip in it.
    const storeRows = screen.getByLabelText('收藏内容筛选').children;
    expect(within(storeRows[storeRows.length - 1] as never)
      .getAllByRole('button')
      .map((chip) => chip.props.accessibilityLabel)).toEqual(['来源：全部']);
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(1);
    expect(screen.getByLabelText(/收藏图片 1/)).toBeOnTheScreen();
    expect(screen.queryByLabelText(/收藏图片 2/)).not.toBeOnTheScreen();
  });

  test('searches the cached collection by artist and tag without refreshing', async () => {
    const onRefresh = jest.fn();
    await render(readyView([
      image(1, { artistName: 'Mika Pikazo', tags: ['blue_hair'] }),
      image(2, { artistName: 'Another Artist', tags: ['maid'] }),
    ], { onRefresh }));

    await fireEvent.changeText(screen.getByLabelText('搜索收藏'), 'mika blue');

    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(1);
    expect(screen.getByLabelText(/收藏图片 1/)).toBeOnTheScreen();
    expect(onRefresh).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: '清除收藏搜索' }));
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(2);
  });

  test('filters by provider and sorts through bottom option sheets', async () => {
    await render(readyView([
      image(1, { providerKey: 'danbooru', byteSize: 900 }),
      image(2, { providerKey: 'danbooru', byteSize: 700 }),
      image(3, { providerKey: 'nekos_api', byteSize: 1200 }),
    ]));

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Danbooru' }));

    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(2);
    expect(screen.getByRole('button', {
      name: '来源：Danbooru',
    }).props.accessibilityState.selected).toBe(true);

    await fireEvent.press(screen.getByRole('button', {
      name: '收藏排序，当前为 最新收藏',
    }));
    await fireEvent.press(screen.getByRole('button', { name: '最大文件' }));

    expect(screen.getAllByLabelText(/收藏图片/).map((tile) => (
      tile.props.accessibilityLabel
    ))).toEqual([
      '收藏图片 1，画师 Artist 1，普通内容，仅在线查看',
      '收藏图片 2，画师 Artist 2，普通内容，仅在线查看',
    ]);
  });

  test('ledger N2: the source sheet lists every source with its count, most first', async () => {
    await render(readyView([
      image(1, { providerKey: 'yandere' }),
      image(2, { providerKey: 'yandere' }),
      image(3, { providerKey: 'gelbooru' }),
      image(4, { providerKey: 'danbooru' }),
    ]));

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));

    expect(within(screen.getByTestId('collection-choice-options'))
      .getAllByRole('button')
      .map((option) => option.props['aria-label'] ?? option.props.accessibilityLabel))
      .toEqual(['全部来源', 'Yande.re', 'Danbooru', 'Gelbooru']);
    const optionRow = (name: string) => screen.getByRole('button', { name });
    expect(optionRow('全部来源').props.accessibilityValue.text).toBe('4 张');
    expect(within(optionRow('全部来源')).getByText('4 张')).toBeOnTheScreen();
    expect(optionRow('Yande.re').props.accessibilityValue.text).toBe('2 张');
    expect(within(optionRow('Yande.re')).getByText('2 张')).toBeOnTheScreen();
    expect(optionRow('Danbooru').props.accessibilityValue.text).toBe('1 张');
    expect(within(optionRow('Danbooru')).getByText('1 张')).toBeOnTheScreen();
    expect(optionRow('Gelbooru').props.accessibilityValue.text).toBe('1 张');
    expect(within(optionRow('Gelbooru')).getByText('1 张')).toBeOnTheScreen();

    await fireEvent.press(optionRow('Yande.re'));
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(2);
    expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();

    // The counts ignore the source filter: the other sources are still listed.
    await fireEvent.press(screen.getByRole('button', { name: '来源：Yande.re' }));
    expect(optionRow('Danbooru').props.accessibilityValue.text).toBe('1 张');
    expect(within(optionRow('Danbooru')).getByText('1 张')).toBeOnTheScreen();
    expect(optionRow('Gelbooru').props.accessibilityValue.text).toBe('1 张');
    expect(within(optionRow('Gelbooru')).getByText('1 张')).toBeOnTheScreen();

    // The counts follow the text search as well (CD 2): 「artist 3」 matches
    // only the Gelbooru image, and the selected Yande.re stays listed at 0.
    await fireEvent.press(optionRow('Yande.re'));
    await fireEvent.changeText(screen.getByLabelText('搜索收藏'), 'artist 3');
    await fireEvent.press(screen.getByRole('button', { name: '来源：Yande.re' }));

    expect(optionRow('全部来源').props.accessibilityValue.text).toBe('1 张');
    expect(within(optionRow('全部来源')).getByText('1 张')).toBeOnTheScreen();
    expect(optionRow('Gelbooru').props.accessibilityValue.text).toBe('1 张');
    expect(within(optionRow('Gelbooru')).getByText('1 张')).toBeOnTheScreen();
    expect(optionRow('Yande.re').props.accessibilityValue.text).toBe('0 张');
    expect(within(optionRow('Yande.re')).getByText('0 张')).toBeOnTheScreen();
    expect(optionRow('Yande.re').props.accessibilityState.selected).toBe(true);
    expect(screen.queryByRole('button', { name: 'Danbooru' })).toBeNull();
  });

  test('ledger N2: the mode choice changes the source counts', async () => {
    await render(readyView([
      image(1, { providerKey: 'konachan', isNsfw: true, contentRating: 'explicit' }),
      image(2, { providerKey: 'danbooru' }),
    ]));

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
    expect(screen.getByRole('button', { name: 'Konachan' }).props.accessibilityValue.text)
      .toBe('1 张');
    expect(within(screen.getByRole('button', { name: 'Konachan' })).getByText('1 张'))
      .toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Danbooru' }).props.accessibilityValue.text)
      .toBe('1 张');
    expect(within(screen.getByRole('button', { name: 'Danbooru' })).getByText('1 张'))
      .toBeOnTheScreen();
    // Close without changing the selection: 全部 is already the current one.
    await fireEvent.press(screen.getByRole('button', { name: '全部来源' }));

    await fireEvent(screen.getByLabelText('收藏内容模式'), 'change', {
      nativeEvent: { selectedSegmentIndex: 1 },
    });
    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
    expect(screen.queryByRole('button', { name: 'Konachan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Danbooru' }).props.accessibilityValue.text)
      .toBe('1 张');
    expect(within(screen.getByRole('button', { name: 'Danbooru' })).getByText('1 张'))
      .toBeOnTheScreen();
  });

  test('ledger N2: a selected source with nothing left stays listed at 0', async () => {
    await render(readyView([
      image(1, { providerKey: 'konachan', isNsfw: true, contentRating: 'explicit' }),
      image(2, { providerKey: 'danbooru' }),
    ]));

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Konachan' }));
    expect(screen.getByRole('button', { name: '来源：Konachan' })).toBeOnTheScreen();

    await fireEvent(screen.getByLabelText('收藏内容模式'), 'change', {
      nativeEvent: { selectedSegmentIndex: 1 },
    });
    await fireEvent.press(screen.getByRole('button', { name: '来源：Konachan' }));

    const konachan = screen.getByRole('button', { name: 'Konachan' });
    expect(konachan.props.accessibilityValue.text).toBe('0 张');
    expect(within(konachan).getByText('0 张')).toBeOnTheScreen();
    expect(konachan.props.accessibilityState.selected).toBe(true);
  });

  test('ledger N2: library-only tiles count toward 全部 and follow the source filter', async () => {
    const digest = viewDigest('n2-library-only');
    const resolve = jest.fn(async (
      _digest: string,
      _intent: 'grid' | 'detail' | 'full',
    ): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///cache/library/n2.jpg',
      tier: 'cloud-thumbnail',
      role: 'thumbnail',
    }));
    await render(readyView([image(1, { providerKey: 'danbooru' })], {
      libraryOverlay: {
        entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: null })],
        resolve,
      },
    }));

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
    expect(screen.getByRole('button', { name: '全部来源' }).props.accessibilityValue.text)
      .toBe('2 张');
    expect(within(screen.getByRole('button', { name: '全部来源' })).getByText('2 张'))
      .toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Danbooru' }).props.accessibilityValue.text)
      .toBe('1 张');
    expect(within(screen.getByRole('button', { name: 'Danbooru' })).getByText('1 张'))
      .toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '全部来源' }));

    expect(screen.getByTestId(`library-asset-tile-${digest}`)).toBeOnTheScreen();
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(1);
    expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Danbooru' }));

    expect(screen.queryByTestId(`library-asset-tile-${digest}`)).toBeNull();
    expect(screen.getAllByLabelText(/收藏图片/)).toHaveLength(1);
    expect(screen.getByTestId('collection-count-value-1')).toBeOnTheScreen();
  });

  test('ledger N2: the option list scrolls so every source stays reachable', async () => {
    await render(readyView([
      image(1, { providerKey: 'waifu_im' }),
      image(2, { providerKey: 'nekos_api' }),
      image(3, { providerKey: 'danbooru' }),
      image(4, { providerKey: 'safebooru' }),
      image(5, { providerKey: 'yandere' }),
      image(6, { providerKey: 'konachan' }),
      image(7, { providerKey: 'e621' }),
      image(8, { providerKey: 'e926' }),
      image(9, { providerKey: 'gelbooru' }),
      image(10, { providerKey: 'rule34' }),
    ]));

    await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));

    const list = screen.getByTestId('collection-choice-options');
    expect(list.type).toBe('RCTScrollView');
    expect(list.props.scrollEnabled).not.toBe(false);
    expect(list.props.style.maxHeight).toBe(Dimensions.get('window').height * 0.7);
    const rows = within(list).getAllByRole('button');
    expect(rows.map((row) => row.props['aria-label'] ?? row.props.accessibilityLabel)).toEqual([
      '全部来源',
      'Waifu.im',
      'Nekos API',
      'Danbooru',
      'Safebooru',
      'Yande.re',
      'Konachan',
      'e621',
      'e926',
      'Gelbooru',
      'Rule34',
    ]);
    expect(rows[0]!.props.accessibilityValue.text).toBe('10 张');
    expect(within(rows[0]!).getByText('10 张')).toBeOnTheScreen();
  });

  test('shows a distinct zero-result state and clears local filters', async () => {
    await render(readyView([image(1)]));

    await fireEvent.changeText(screen.getByLabelText('搜索收藏'), 'no match');

    expect(screen.getByText('没有匹配的收藏')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByLabelText(/收藏图片 1/)).toBeOnTheScreen();
  });

  test('empty collection navigates back to discovery', async () => {
    const onBrowse = jest.fn();
    await render(readyView([], { onBrowse }));

    expect(screen.getByTestId('screen-collection')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '去发现图片' }));

    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  test('updates visible collection copy immediately when the language changes', async () => {
    await render(readyView([]));

    expect(screen.getByTestId('screen-collection')).toBeOnTheScreen();
    expect(screen.getByText('还没有收藏')).toBeOnTheScreen();

    await act(async () => i18n.changeLanguage('en'));

    expect(screen.getByText('No saved images yet')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Discover images' })).toBeOnTheScreen();

    await act(async () => i18n.changeLanguage('zh-Hans'));
  });

  test('long press enters selection without changing tile geometry and shows batch count', async () => {
    const onOpen = jest.fn();
    await render(readyView([image(1), image(2)], { onOpen }));
    const firstTile = screen.getByLabelText(/收藏图片 2/);
    const aspectRatio = firstTile.props.style.aspectRatio;

    await fireEvent(firstTile, 'longPress');
    await fireEvent.press(firstTile);

    expect(screen.getByText('已选择 1 项')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '删除所选图片' })).toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 2/).props.style.aspectRatio).toBe(aspectRatio);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('batch delete requires confirmation and reports selected IDs', async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    await render(readyView([image(1), image(2)], { onDelete }));

    await fireEvent(screen.getByLabelText(/收藏图片 2/), 'longPress');
    await fireEvent.press(screen.getByLabelText(/收藏图片 1/));
    await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));

    expect(alert).toHaveBeenCalledWith(
      '删除 2 张图片？',
      expect.stringContaining('永久移除'),
      expect.any(Array),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith([2, 1]));
  });

  test('exits selection after partial batch failure and refreshed images', async () => {
    const onDelete = jest.fn().mockRejectedValue(new Error('delete 2 failed'));
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    const { rerender } = await render(readyView([image(1), image(2)], { onDelete }));

    await fireEvent(screen.getByLabelText(/收藏图片 2/), 'longPress');
    await fireEvent.press(screen.getByLabelText(/收藏图片 1/));
    await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith([2, 1]));
    await screen.findByText('操作未能完成，请重试。');

    await rerender(readyView([image(2)], { onDelete }));

    expect(screen.queryByText(/已选择/)).not.toBeOnTheScreen();
    expect(screen.getByText('1 张图片')).toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 2/).props.accessibilityState).toEqual({
      selected: false,
    });
    expect(screen.queryByRole('button', { name: '删除所选图片' })).not.toBeOnTheScreen();
  });

  test('drops externally removed selections before the same ID can reappear', async () => {
    const { rerender } = await render(readyView([image(7)]));
    await fireEvent(screen.getByLabelText(/收藏图片 7/), 'longPress');
    expect(screen.getByText('已选择 1 项')).toBeOnTheScreen();

    await rerender(readyView([]));
    await rerender(readyView([image(7)]));

    expect(screen.queryByText(/已选择/)).not.toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityState).toEqual({
      selected: false,
    });
  });

  test('restores same local URI precedence after repair completes', async () => {
    let finishRepair!: (repaired: boolean) => void;
    const onRepair = jest.fn(() => new Promise<boolean>((resolve) => {
      finishRepair = resolve;
    }));
    await render(readyView([
      image(7, { localUri: 'file:///collection/7.jpg' }),
    ], { onRepair }));

    await fireEvent(screen.getByLabelText('图片 7'), 'error');

    expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    });
    expect(onRepair).toHaveBeenCalledWith(7, 'file:///collection/7.jpg');

    await act(async () => finishRepair(true));

    expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///collection/7.jpg',
    });
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  test('libraryOverlay=null leaves the accepted local grid assertions unchanged', async () => {
    await render(readyView([
      image(1, { decidedAt: 100 }),
      image(2, { decidedAt: 300, localUri: 'file:///collection/2.jpg' }),
    ], { libraryOverlay: null }));

    const tiles = screen.getAllByLabelText(/收藏图片/);
    expect(tiles.map((tile) => tile.props.accessibilityLabel)).toEqual([
      '收藏图片 2，画师 Artist 2，普通内容，可离线查看',
      '收藏图片 1，画师 Artist 1，普通内容，仅在线查看',
    ]);
    expect(tiles[0]).toHaveStyle({ aspectRatio: 3 / 4 });
    expect(within(tiles[0]).getByLabelText('图片 2').props.source).toEqual({
      uri: 'file:///collection/2.jpg',
    });
    expect(within(tiles[1]).getByLabelText('图片 1').props.source).toEqual({
      uri: 'https://cdn.example.com/1.jpg',
    });
    expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();
  });

  test('a 500-entry overlay resolves at most visible + WINDOW_AHEAD on first render', async () => {
    const resolve = jest.fn(async (
      digest: string,
      _intent: 'grid' | 'detail' | 'full',
    ): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: `file:///cache/library/${digest}.jpg`,
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    }));
    const entries = Array.from({ length: 500 }, (_, index) => libraryEntry({
      plaintextSha256: viewDigest(`grid-${index}`),
      sourceImageId: null,
      createdAt: 1_000 - index,
    }));
    await render(readyView([], {
      libraryOverlay: { entries, resolve },
    }));

    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(1 + LIBRARY_RENDER_WINDOW_AHEAD);
    expect(resolve.mock.calls.every(([, intent]) => intent === 'grid')).toBe(true);
  });

  test('a cloud-only entry with no images row appears in the grid', async () => {
    const digest = viewDigest('cloud-only');
    const resolve = jest.fn(async (
      _digest: string,
      _intent: 'grid' | 'detail' | 'full',
    ): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///cache/library/cloud-only.jpg',
      tier: 'cloud-thumbnail',
      role: 'thumbnail',
    }));
    await render(readyView([image(1)], {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: null,
        })],
        resolve,
      },
    }));

    expect(await screen.findByTestId(`library-asset-tile-${digest}`)).toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 1/)).toBeOnTheScreen();
    expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();
  });

  test('scrolling extends the window without re-resolving already-resolved digests', async () => {
    const resolve = jest.fn(async (
      digest: string,
      _intent: 'grid' | 'detail' | 'full',
    ): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: `file:///cache/library/${digest}.jpg`,
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    }));
    const entries = Array.from({ length: 80 }, (_, index) => libraryEntry({
      plaintextSha256: viewDigest(`scroll-${index}`),
      sourceImageId: null,
      createdAt: 1_000 - index,
    }));
    await render(readyView([], {
      libraryOverlay: { entries, resolve },
    }));

    await waitFor(() => expect(resolve).toHaveBeenCalled());
    const firstWave = resolve.mock.calls.length;
    expect(firstWave).toBeLessThanOrEqual(1 + LIBRARY_RENDER_WINDOW_AHEAD);
    const firstDigest = viewDigest('scroll-0');
    expect(resolve.mock.calls.filter(([digest]) => digest === firstDigest)).toHaveLength(1);

    await act(async () => {
      screen.getByTestId('collection-list').props.onViewableItemsChanged({
        viewableItems: [{
          index: 40,
          item: { kind: 'library', entry: entries[40] },
          isViewable: true,
          key: entries[40]!.plaintextSha256,
        }],
        changed: [],
      });
    });

    await waitFor(() => expect(resolve.mock.calls.length).toBeGreaterThan(firstWave));
    expect(resolve.mock.calls.filter(([digest]) => digest === firstDigest)).toHaveLength(1);
    expect(resolve.mock.calls.every(([, intent]) => intent === 'grid')).toBe(true);
  });

  test('overlay resolves only intent grid and unavailable stays without a larger-intent resolve', async () => {
    const digest = viewDigest('unavailable-grid');
    const resolve = jest.fn(async (
      _digest: string,
      _intent: 'grid' | 'detail' | 'full',
    ): Promise<LibraryRenderSource> => ({
      kind: 'unavailable',
      category: 'object_missing',
    }));
    await render(readyView([], {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: null,
        })],
        resolve,
      },
    }));

    expect(await screen.findByTestId(`library-asset-unavailable-${digest}`)).toBeOnTheScreen();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(digest, 'grid');
    expect(resolve.mock.calls.some(([, intent]) => intent === 'detail' || intent === 'full'))
      .toBe(false);
  });

  test('K2: a mirrored row with a local library original renders from the resolver, not the provider', async () => {
    const digest = viewDigest('k2-mirrored');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///library/originals/k2.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        resolve,
      },
    }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///library/originals/k2.jpg',
    }));
    expect(screen.queryByText('保存中')).not.toBeOnTheScreen();
  });

  test('the newest entry of an image wins', async () => {
    const d1 = viewDigest('newest-old');
    const d2 = viewDigest('newest-new');
    const resolve = jest.fn(async (_digest: string, _intent: string): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///cache/library/newest.jpg',
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    }));
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
    ], {
      libraryOverlay: {
        // `listEntries` is newest first.
        entries: [
          libraryEntry({ plaintextSha256: d2, sourceImageId: 7, createdAt: 2_000 }),
          libraryEntry({ plaintextSha256: d1, sourceImageId: 7, createdAt: 1_000 }),
        ],
        resolve,
      },
    }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(d2, 'grid'));
    expect(resolve.mock.calls.some(([digest]) => digest === d1)).toBe(false);
  });

  test('K2 (pending): a mirrored tile renders no provider sample while its grid resolve is in flight', async () => {
    const digest = viewDigest('k2-pending-tile');
    let settle!: (source: LibraryRenderSource) => void;
    const resolve = jest.fn((
      _digest: string,
      _intent: 'grid' | 'detail' | 'full',
    ) => new Promise<LibraryRenderSource>((resolveSource) => {
      settle = resolveSource;
    }));
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        resolve,
      },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));

    // The resolver owns this row; until it answers the tile is its colour
    // block, not the provider sample (a network fetch for bytes we hold).
    expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 7/)).toBeOnTheScreen();

    await act(async () => settle({
      kind: 'file',
      uri: 'file:///library/originals/k2.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///library/originals/k2.jpg',
    }));
  });

  test('K2 (entries loading): a mirrored tile renders no provider sample while the library entries are still being read', async () => {
    const resolve = jest.fn();
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
      image(8, { localUri: 'file:///collection/8.jpg' }),
    ], {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    // The mirrored row is library-owned even before its entry is known; the
    // ready row next to it keeps its local file.
    expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    expect(screen.getByLabelText('图片 8').props.source).toEqual({ uri: 'file:///collection/8.jpg' });
    expect(resolve).not.toHaveBeenCalled();
  });

  test('K2 (entries read, no entry): a mirrored tile the library does not know keeps the provider fallback', async () => {
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
    ], {
      libraryOverlay: { entries: [], entriesPending: false, resolve: jest.fn() },
    }));
    expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    });
  });

  describe('row 51: an opened tile hands its thumbnail to the detail page', () => {
    const thumb = 'file:///library/thumbnails/7.webp';

    test('a newly committed thumbnail is the seed before passive effects', async () => {
      const root = createRoot();
      const id = 553;
      const justCommitted = 'file:///library/thumbnails/just-committed.webp';
      const digest = viewDigest('row51-effect-gap-thumb');
      const entry = libraryEntry({
        plaintextSha256: digest,
        sourceImageId: id,
        localOriginalUri: null,
        hasLocalOriginal: false,
      });
      let settle!: (source: LibraryRenderSource) => void;
      const resolve = jest.fn(() => new Promise<LibraryRenderSource>((done) => {
        settle = done;
      }));
      const seen: (string | null)[] = [];
      const onOpen = jest.fn(() => { seen.push(readDetailOpenSeed(id)); });
      const { unstable_shouldYield } = require('scheduler') as {
        unstable_shouldYield: () => boolean;
      };
      const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT;
      let observed!: () => void;
      const eventObserved = new Promise<void>((done) => { observed = done; });
      const tileImage = () => root.container.queryAll((node: {
        props: { accessibilityLabel?: string; source?: { uri?: string } };
      }) => node.props.accessibilityLabel === `图片 ${id}`)[0];
      let invoked = false;
      setDetailOpenSeed(id, null);
      try {
        await act(async () => root.render(
          <Profiler id="row51-new-thumbnail" onRender={() => {
            if (!invoked && tileImage()?.props.source?.uri === justCommitted) {
              invoked = true;
              queueMicrotask(() => {
                mockReviewOpen!();
                observed();
              });
              const yieldDeadline = Date.now() + 20;
              while (!unstable_shouldYield() && Date.now() < yieldDeadline) {
                // A queued press runs after this commit and before a passive effect.
              }
            }
          }}>
            {readyView([image(id, { localUri: null, downloadState: 'mirrored' })], {
              onOpen,
              libraryOverlay: { entries: [entry], resolve },
            })}
          </Profiler>,
        ));
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
        settle({
          kind: 'file',
          uri: justCommitted,
          tier: 'local-thumbnail',
          role: 'thumbnail',
        });
        await eventObserved;
        expect(seen).toEqual([justCommitted]);
      } finally {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
          .IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        await act(async () => root.unmount());
        setDetailOpenSeed(id, null);
      }
    });

    test('a newly committed collection file clears the seed before passive effects', async () => {
      const root = createRoot();
      const id = 552;
      const { unstable_shouldYield } = require('scheduler') as {
        unstable_shouldYield: () => boolean;
      };
      const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT;
      let observed!: () => void;
      const eventObserved = new Promise<void>((done) => { observed = done; });
      const previousThumb = 'file:///library/thumbnails/before-commit.webp';
      const own = 'file:///collection/552.jpg';
      const digest = viewDigest('row51-effect-gap-file');
      const entry = libraryEntry({
        plaintextSha256: digest,
        sourceImageId: id,
        localOriginalUri: null,
        hasLocalOriginal: false,
      });
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: previousThumb,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      const seen: (string | null)[] = [];
      const onOpen = jest.fn(() => { seen.push(readDetailOpenSeed(id)); });
      let pressOnCommit = false;
      let invoked = false;
      const tileImage = () => root.container.queryAll((node: {
        props: { accessibilityLabel?: string; source?: { uri?: string } };
      }) => node.props.accessibilityLabel === `图片 ${id}`)[0];
      const page = (row: ReturnType<typeof image>) => (
        <Profiler id="row51-post-commit" onRender={() => {
          if (pressOnCommit && !invoked && tileImage()?.props.source?.uri === own) {
            invoked = true;
            queueMicrotask(() => {
              mockReviewOpen!();
              observed();
            });
            const yieldDeadline = Date.now() + 20;
            while (!unstable_shouldYield() && Date.now() < yieldDeadline) {
              // A queued press runs after this commit and before a passive effect.
            }
          }
        }}>
          {readyView([row], { onOpen, libraryOverlay: { entries: [entry], resolve } })}
        </Profiler>
      );
      try {
        await act(async () => root.render(page(image(id, {
          localUri: null,
          downloadState: 'mirrored',
        }))));
        await waitFor(() => expect(tileImage()?.props.source).toEqual({ uri: previousThumb }));
        pressOnCommit = true;
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
        root.render(page(image(id, { localUri: own, downloadState: 'ready' })));
        await eventObserved;
        expect(invoked).toBe(true);
        expect(seen).toEqual([null]);
      } finally {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
          .IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        await act(async () => root.unmount());
        setDetailOpenSeed(id, null);
      }
    });

    function openOf(id: number) {
      const seen: (string | null)[] = [];
      const onOpen = jest.fn(() => {
        seen.push(readDetailOpenSeed(id));
      });
      return { onOpen, seen };
    }

    test('a resolver-owned thumbnail file sets the seed before navigation', async () => {
      const digest = viewDigest('row51-open-thumb');
      const { onOpen, seen } = openOf(7);
      setDetailOpenSeed(7, 'file:///stale');
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: thumb,
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      }));
      await render(readyView([
        image(7, { downloadState: 'mirrored', localUri: null }),
      ], {
        onOpen,
        libraryOverlay: {
          entries: [libraryEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            residency: 'cloud-only',
            hasLocalOriginal: false,
            localOriginalUri: null,
          })],
          resolve,
        },
      }));
      await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
        uri: thumb,
      }));

      await fireEvent.press(screen.getByLabelText(/收藏图片 7/));

      expect(seen).toEqual([thumb]);
      expect(readDetailOpenSeed(7)).toBe(thumb);
      expect(onOpen).toHaveBeenCalledWith(7, expect.any(Object));
    });

    test('a fast-path original sets null', async () => {
      const original = 'file:///data/library/originals/7.jpg';
      const { onOpen, seen } = openOf(7);
      setDetailOpenSeed(7, 'file:///stale');
      await render(readyView([
        image(7, { downloadState: 'mirrored', localUri: null }),
      ], {
        onOpen,
        libraryOverlay: {
          entries: [libraryEntry({
            plaintextSha256: viewDigest('row51-open-fast'),
            sourceImageId: 7,
            residency: 'local-original',
            hasLocalOriginal: true,
            localOriginalUri: original,
          })],
          resolve: jest.fn(),
        },
      }));
      await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
        uri: original,
      }));

      await fireEvent.press(screen.getByLabelText(/收藏图片 7/));

      expect(seen).toEqual([null]);
      expect(readDetailOpenSeed(7)).toBeNull();
    });

    test('a tile with no file answer sets null', async () => {
      const digest = viewDigest('row51-open-missing');
      const { onOpen, seen } = openOf(7);
      setDetailOpenSeed(7, 'file:///stale');
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable',
        category: 'object_missing',
        role: 'thumbnail',
      }));
      await render(readyView([
        image(7, { downloadState: 'mirrored', localUri: null }),
      ], {
        onOpen,
        libraryOverlay: {
          entries: [libraryEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            hasLocalOriginal: false,
            localOriginalUri: null,
          })],
          resolve,
        },
      }));
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
      await act(async () => { await Promise.resolve(); });

      await fireEvent.press(screen.getByLabelText(/收藏图片 7/));

      expect(seen).toEqual([null]);
      expect(readDetailOpenSeed(7)).toBeNull();
    });

    test('a preview-role file sets null', async () => {
      const digest = viewDigest('row51-open-preview');
      const preview = 'file:///cache/library/7-preview.jpg';
      const { onOpen, seen } = openOf(7);
      setDetailOpenSeed(7, 'file:///stale');
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: preview,
        tier: 'cached-preview',
        role: 'preview',
      }));
      await render(readyView([
        image(7, { downloadState: 'mirrored', localUri: null }),
      ], {
        onOpen,
        libraryOverlay: {
          entries: [libraryEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            hasLocalOriginal: false,
            localOriginalUri: null,
          })],
          resolve,
        },
      }));
      await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
        uri: preview,
      }));

      await fireEvent.press(screen.getByLabelText(/收藏图片 7/));

      expect(seen).toEqual([null]);
      expect(readDetailOpenSeed(7)).toBeNull();
    });

    test('a row with a collection file sets null', async () => {
      const { onOpen, seen } = openOf(8);
      setDetailOpenSeed(8, 'file:///stale');
      await render(readyView([
        image(8, { localUri: 'file:///collection/8.jpg', downloadState: 'ready' }),
      ], { onOpen }));

      await fireEvent.press(screen.getByLabelText(/收藏图片 8/));

      expect(seen).toEqual([null]);
      expect(readDetailOpenSeed(8)).toBeNull();
      expect(onOpen).toHaveBeenCalledWith(8, expect.any(Object));
    });

    test('a row that gains its own collection file seeds null', async () => {
      const id = 503;
      const thumb = 'file:///library/thumbnails/resolved-earlier.webp';
      const digest = viewDigest('row51-owner');
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: thumb,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      const entry = libraryEntry({
        plaintextSha256: digest,
        sourceImageId: id,
        localOriginalUri: null,
        hasLocalOriginal: false,
      });
      const seen: (string | null)[] = [];
      const onOpen = jest.fn(() => { seen.push(readDetailOpenSeed(id)); });
      const rendered = await render(readyView([
        image(id, { localUri: null, downloadState: 'mirrored' }),
      ], {
        onOpen,
        libraryOverlay: { entries: [entry], resolve },
      }));
      try {
        await waitFor(() => expect(screen.getByLabelText(`图片 ${id}`).props.source).toEqual({
          uri: thumb,
        }));
        const original = 'file:///collection/503.jpg';
        await rendered.rerender(readyView([
          image(id, { localUri: original, downloadState: 'ready' }),
        ], {
          onOpen,
          libraryOverlay: { entries: [entry], resolve },
        }));
        expect(screen.getByLabelText(`图片 ${id}`).props.source).toEqual({ uri: original });
        setDetailOpenSeed(id, 'file:///stale');

        await fireEvent.press(screen.getByTestId(`collection-tile-${id}`));

        expect(seen).toEqual([null]);
        expect(readDetailOpenSeed(id)).toBeNull();
      } finally {
        setDetailOpenSeed(id, null);
      }
    });

    test('a discarded render does not replace the committed tile seed', async () => {
      const root = createRoot();
      const id = 502;
      const thumb = 'file:///library/thumbnails/committed.webp';
      const digest = viewDigest('row51-discarded');
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: thumb,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      const entry = libraryEntry({
        plaintextSha256: digest,
        sourceImageId: id,
        localOriginalUri: null,
        hasLocalOriginal: false,
      });
      const seen: (string | null)[] = [];
      const onOpen = jest.fn(() => { seen.push(readDetailOpenSeed(id)); });
      const page = (row: ReturnType<typeof image>) => (
        <Suspense fallback={<View testID="review-fallback" />}>
          {readyView([row], { onOpen, libraryOverlay: { entries: [entry], resolve } })}
        </Suspense>
      );
      const tileImage = () => root.container.queryAll((node: { props: { accessibilityLabel?: string } }) => (
        node.props.accessibilityLabel === `图片 ${id}`
      ))[0];
      try {
        await act(async () => root.render(page(image(id, { localUri: null, downloadState: 'mirrored' }))));
        await waitFor(() => expect(tileImage()?.props.source).toEqual({ uri: thumb }));
        await act(async () => {
          mockReviewSuspend = true;
          startTransition(() => root.render(page(image(id, {
            localUri: 'file:///collection/502.jpg',
            downloadState: 'ready',
          }))));
        });
        expect(mockReviewSuspendedRenders).toBeGreaterThan(0);
        expect(tileImage()?.props.source).toEqual({ uri: thumb });
        expect(mockReviewOpen).not.toBeNull();

        await act(async () => mockReviewOpen!());

        expect(seen).toEqual([thumb]);
      } finally {
        mockReviewSuspend = false;
        await act(async () => root.unmount());
        setDetailOpenSeed(id, null);
      }
    });

    test('a selection press writes no seed', async () => {
      const digest = viewDigest('row51-selection');
      const thumb = 'file:///library/thumbnails/7.webp';
      const onOpen = jest.fn();
      setDetailOpenSeed(7, 'file:///stale');
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: thumb,
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      }));
      try {
        await render(readyView([
          image(7, { downloadState: 'mirrored', localUri: null }),
        ], {
          onOpen,
          libraryOverlay: {
            entries: [libraryEntry({
              plaintextSha256: digest,
              sourceImageId: 7,
              hasLocalOriginal: false,
              localOriginalUri: null,
            })],
            resolve,
          },
        }));
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
          uri: thumb,
        }));
        const tile = screen.getByTestId('collection-tile-7');
        await fireEvent(tile, 'longPress');
        await fireEvent.press(tile);

        await fireEvent.press(screen.getByTestId('collection-tile-7'));

        expect(readDetailOpenSeed(7)).toBe('file:///stale');
        expect(onOpen).not.toHaveBeenCalled();
      } finally {
        setDetailOpenSeed(7, null);
      }
    });

    test('a seeded open keeps a non-default collection query', async () => {
      const digest = viewDigest('row51-query');
      const onOpen = jest.fn();
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: thumb,
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      }));
      const query = {
        mode: 'sfw' as const,
        sort: 'fileSize' as const,
      };
      try {
        await render(readyView([
          image(7, { downloadState: 'mirrored', localUri: null }),
        ], {
          onOpen,
          initialQuery: query,
          libraryOverlay: {
            entries: [libraryEntry({
              plaintextSha256: digest,
              sourceImageId: 7,
              hasLocalOriginal: false,
              localOriginalUri: null,
            })],
            resolve,
          },
        }));
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
          uri: thumb,
        }));

        await fireEvent.press(screen.getByTestId('collection-tile-7'));

        expect(readDetailOpenSeed(7)).toBe(thumb);
        expect(onOpen).toHaveBeenCalledWith(7, expect.objectContaining(query));
      } finally {
        setDetailOpenSeed(7, null);
      }
    });
  });

  test('board #9 (entries loading): a failed file-less tile renders no provider sample while the library entries are still being read', async () => {
    const resolve = jest.fn();
    await render(readyView([
      image(7, { downloadState: 'failed', localUri: null }),
    ], {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    // The collection file is gone (markFileMissing), but the library may still
    // hold the bytes — unknowable until listEntries() lands, so the tile keeps
    // its colour block instead of fetching the provider URL.
    expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('board #9 regression: a ready tile with its own file renders it while the library entries are still being read', async () => {
    await render(readyView([
      image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
    ], {
      libraryOverlay: { entries: [], entriesPending: true, resolve: jest.fn() },
    }));
    expect(screen.getByLabelText('图片 8').props.source).toEqual({ uri: 'file:///collection/8.jpg' });
  });

  test('board #9: once the entries land, a failed file-less tile the library owns renders the library file', async () => {
    const digest = viewDigest('row9-failed-owned');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///library/originals/row9.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    const rows = [image(7, { downloadState: 'failed', localUri: null })];
    const view = await render(readyView(rows, {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();

    await view.rerender(readyView(rows, {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        entriesPending: false,
        resolve,
      },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///library/originals/row9.jpg',
    }));
  });

  test('board #9 (entries read, no entry): a failed file-less tile the library does not know keeps the provider fallback', async () => {
    await render(readyView([
      image(7, { downloadState: 'failed', localUri: null }),
    ], {
      libraryOverlay: { entries: [], entriesPending: false, resolve: jest.fn() },
    }));
    expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    });
  });

  test('board #9 (entries loading): a saving tile with no file yet holds its colour block for that one read', async () => {
    const resolve = jest.fn();
    await render(readyView([
      image(7, { downloadState: 'pending', localUri: null }),
    ], {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    // Spec §5.1: the accepted one-read delay — block + 保存中, then the sample.
    expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();
    expect(screen.getByText('保存中')).toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('K2 (resolve failure): a rejected grid resolve falls back to the provider sample instead of a permanent colour block', async () => {
    const digest = viewDigest('k2-reject-tile');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => {
      throw new Error('sqlite closed');
    });
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'local-original', hasLocalOriginal: true })],
        resolve,
      },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    }));
  });

  test('K2c: a mirrored tile that is merely offline shows no repair badge', async () => {
    const digest = viewDigest('k2c-tile-offline');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'offline' }));
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false })],
        resolve,
      },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
    expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel).toContain('仅在云端');
    expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel).not.toContain('可离线查看');
  });

  test('board #16: a too-large gif\'s resolved thumbnail (already a still) is rendered as it is', async () => {
    // The grid hands the tile the resolved role, so a derived still is never
    // put through the first-frame cut (which would hold the tile blank).
    const digest = viewDigest('row16-thumb');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file', uri: 'file:///cache/library/44-thumbnail.bin', tier: 'cached-thumbnail', role: 'thumbnail',
    }));
    await render(readyView([
      image(7, { downloadState: 'mirrored', localUri: null, extension: '.gif', isAnimated: true, byteSize: 50_278_178 }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: 7, format: 'gif', byteSize: 50_278_178 })],
        resolve,
      },
    }));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///cache/library/44-thumbnail.bin',
    }));
  });

  test('K3 G3: a missing DERIVED object with an original in the cloud is NOT "needs repair"', async () => {
    const digest = viewDigest('k3-derived-missing');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'object_missing' }));
    await render(readyView([image(7, { downloadState: 'mirrored', localUri: null })], {
      libraryOverlay: { entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'gen-orig' })], resolve },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
    expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
  });

  test('K3b G3: a corrupted DERIVED tier (thumbnail integrity) with an original in the cloud is NOT "needs repair"', async () => {
    const digest = viewDigest('k3b-integrity-derived');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'integrity', role: 'thumbnail' }));
    await render(readyView([image(7, { downloadState: 'mirrored', localUri: null })], {
      libraryOverlay: { entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'gen-orig' })], resolve },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
    expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
  });

  test('K3 G3: no original in the cloud IS "needs repair"', async () => {
    const digest = viewDigest('k3-no-original');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'object_missing' }));
    await render(readyView([image(7, { downloadState: 'mirrored', localUri: null })], {
      libraryOverlay: { entries: [libraryEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: null })], resolve },
    }));
    await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());
  });

  test('K3: protected rows get the orange cloud; pending/unprotected rows get nothing; no status copy anywhere', async () => {
    const a = viewDigest('k3-a'); const b = viewDigest('k3-b');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'file', uri: 'file:///cache/library/t.jpg', tier: 'cached-thumbnail', role: 'thumbnail' }));
    await render(readyView([
      image(1, { decidedAt: 300, localUri: 'file:///collection/1.jpg' }),
      image(2, { decidedAt: 200, localUri: 'file:///collection/2.jpg' }),
    ], {
      libraryOverlay: {
        entries: [
          libraryEntry({ plaintextSha256: a, sourceImageId: 1, protection: 'protected', hasLocalOriginal: true, residency: 'local-original' }),
          libraryEntry({ plaintextSha256: b, sourceImageId: 2, protection: 'pending', hasLocalOriginal: true, residency: 'local-original' }),
        ],
        resolve,
      },
    }));
    const tiles = screen.getAllByLabelText(/收藏图片/);
    expect(within(tiles[0]).getByTestId('cloud-badge', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(within(tiles[1]).queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
    expect(tiles[0].props.accessibilityLabel).toMatch(/已同步到云端$/);
    expect(tiles[1].props.accessibilityLabel).not.toMatch(/已同步到云端/);
    for (const copy of ['已保护', '保护中', '等待网络', '原图仅在其他设备上', '云端副本需要处理']) {
      expect(screen.queryByText(copy)).toBeNull();
    }
  });

  /**
   * K7 ⑥: the grid used to resolve EVERY tile in the window — 3 SQLite reads,
   * an HMAC and a file stat each — though it only ever uses the result for a
   * row with no local original or a `mirrored` download state. Each completion
   * then copied the whole Map and set state, so N resolves meant N full-grid
   * re-renders on the frame the tab opened.
   */
  describe('K7 ⑥ the grid only resolves rows that use the result', () => {
    function fileSource(): LibraryRenderSource {
      return {
        kind: 'file',
        uri: 'file:///cache/library/k7.jpg',
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      };
    }

    test('35 of 40 rows have a local original: only the other 5 are resolved', async () => {
      const resolve = jest.fn(async (
        _digest: string,
        _intent: 'grid' | 'detail' | 'full',
      ) => fileSource());
      const images: StoredImage[] = [];
      const entries: LibraryEntry[] = [];
      for (let index = 0; index < 40; index += 1) {
        // The five newest rows are the cloud-backed kind the resolver exists
        // for, so all five sit inside the first render window; the 35 behind
        // them have their own local file and never need it.
        const needsResolver = index < 5;
        images.push(image(index + 1, {
          decidedAt: 10_000 - index,
          localUri: needsResolver ? null : `file:///collection/${index + 1}.jpg`,
          downloadState: needsResolver ? 'mirrored' : 'ready',
        }));
        entries.push(libraryEntry({
          plaintextSha256: viewDigest(`k7-grid-${index}`),
          sourceImageId: index + 1,
          residency: needsResolver ? 'cloud-only' : 'local-original',
          hasLocalOriginal: !needsResolver,
        }));
      }

      await render(readyView(images, { libraryOverlay: { entries, resolve } }));
      await waitFor(() => expect(resolve).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });

      expect(resolve).toHaveBeenCalledTimes(5);
      const resolvedIds = resolve.mock.calls.map(([digest]) => digest);
      expect(new Set(resolvedIds).size).toBe(5);
    });

    test('five resolves settle into at most two grid renders, not five', async () => {
      const gates: (() => void)[] = [];
      const resolve = jest.fn((
        _digest: string,
        _intent: 'grid' | 'detail' | 'full',
      ) => new Promise<LibraryRenderSource>((done) => {
        gates.push(() => done(fileSource()));
      }));
      const images: StoredImage[] = [];
      const entries: LibraryEntry[] = [];
      for (let index = 0; index < 5; index += 1) {
        images.push(image(index + 1, {
          decidedAt: 10_000 - index,
          localUri: null,
          downloadState: 'mirrored',
        }));
        entries.push(libraryEntry({
          plaintextSha256: viewDigest(`k7-batch-${index}`),
          sourceImageId: index + 1,
          residency: 'cloud-only',
          hasLocalOriginal: false,
        }));
      }

      await render(readyView(images, { libraryOverlay: { entries, resolve } }));
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(5));
      const rendersBefore = mockGridData.length;

      // The test owns the frame: jest's requestAnimationFrame is a
      // setTimeout(0), which can fire between two act() calls and made this
      // test flaky (it failed on docs-only commits).
      const frames: FrameRequestCallback[] = [];
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      try {
        // Five independent SQLite reads settle in five separate commits, all
        // inside one frame — the real shape of a grid mount. Unbatched, each
        // completion copies the Map and repaints the whole grid; batched, the
        // frame publishes once. No timers are advanced between them, so nothing
        // here relies on React's own auto-batching.
        for (const openGate of gates) {
          await act(async () => { openGate(); });
        }
        const rendersBeforeFrame = mockGridData.length;
        expect(rendersBeforeFrame - rendersBefore).toBe(0);

        // One frame was requested for the whole batch.
        expect(frames).toHaveLength(1);
      } finally {
        // Later frames go through the real rAF again, so nothing below waits
        // on a callback this spy swallowed — also when an assertion failed.
        rafSpy.mockRestore();
      }
      // The frame lands.
      await act(async () => {
        for (const frame of frames.splice(0)) frame(0);
      });

      expect(mockGridData.length - rendersBefore).toBe(1);
      // and the batched state actually reached the tiles
      await waitFor(() => expect(screen.getByLabelText('图片 1').props.source).toEqual({
        uri: 'file:///cache/library/k7.jpg',
      }));
    });

    test('extraData keeps the same reference when nothing about it changed', async () => {
      const resolve = jest.fn(async () => fileSource());
      const view = await render(readyView([
        image(1, { localUri: 'file:///collection/1.jpg' }),
      ], { libraryOverlay: { entries: [], resolve } }));
      await waitFor(() => expect(mockGridExtraData.length).toBeGreaterThan(0));
      const before = mockGridExtraData.at(-1);

      await view.rerender(readyView([
        image(1, { localUri: 'file:///collection/1.jpg' }),
      ], { libraryOverlay: { entries: [], resolve } }));

      expect(mockGridExtraData.length).toBeGreaterThan(1);
      expect(mockGridExtraData.at(-1)).toBe(before);
    });

    test('CollectionTile is memoized, so an unchanged row does not re-render', () => {
      // A plain function component has no `$$typeof` memo marker.
      expect((CollectionTile as unknown as { $$typeof?: symbol }).$$typeof)
        .toBe(Symbol.for('react.memo'));
    });
  });

  describe('board #27 S1b: the entry fast path (spec §5.7)', () => {
    const digest = viewDigest('s1b-fast-path');
    const LOCAL = 'file:///data/library/originals/d.jpg';
    const fastRow = () => image(7, { downloadState: 'mirrored', localUri: null });
    const fastEntry = (overrides: Partial<LibraryEntry> = {}) => libraryEntry({
      plaintextSha256: digest,
      sourceImageId: 7,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: LOCAL,
      ...overrides,
    });
    const thumbnail = (uri: string): LibraryRenderSource => ({
      kind: 'file', uri, tier: 'cached-thumbnail', role: 'thumbnail',
    });
    const tileSource = () => screen.getByLabelText('图片 7').props.source;
    const tileError = () => screen.getByLabelText('图片 7').props.onError as () => void;

    test.each([
      [
        'cloud-only original',
        { residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'g1' },
        '仅在云端',
        '可离线查看',
      ],
      [
        'flagged local-original row',
        { residency: 'local-original', hasLocalOriginal: false, originalGenerationId: 'g1' },
        '仅在云端',
        '可离线查看',
      ],
      [
        'local original',
        { residency: 'local-original', hasLocalOriginal: true, originalGenerationId: 'g1' },
        '可离线查看',
        '仅在云端',
      ],
      [
        'missing cloud original',
        { residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: null },
        '离线文件需修复',
        '仅在云端',
      ],
    ] as const)('the tile label follows where the original is: %s', async (_name, overrides, contains, notContains) => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'offline',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry(overrides)], resolve },
      }));
      await waitFor(() => expect(screen.getByLabelText(/收藏图片 7/)).toBeOnTheScreen());
      const label = screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel as string;
      expect(label).toContain(contains);
      expect(label).not.toContain(notContains);
    });

    test('a failed fast path reads as only in the cloud', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'offline',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { tileError()(); });
      await waitFor(() => {
        const label = screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel as string;
        expect(label).toContain('仅在云端');
        expect(label).not.toContain('可离线查看');
      });
    });

    test('a mirrored row renders its entry\'s local original with no resolve', async () => {
      const resolve = jest.fn(async () => thumbnail('file:///cache/library/never.webp'));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      expect(tileSource()).toEqual({ uri: LOCAL });
      expect(resolve).not.toHaveBeenCalled();
    });

    test('a load error on it runs one grid resolve, however often the error fires', async () => {
      let settle!: (source: LibraryRenderSource) => void;
      const resolve = jest.fn((_digest: string, _intent: 'grid' | 'detail' | 'full') => (
        new Promise<LibraryRenderSource>((done) => { settle = done; })
      ));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      const onError = tileError();

      await act(async () => { onError(); });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(digest, 'grid');

      await act(async () => { onError(); });
      expect(resolve).toHaveBeenCalledTimes(1);

      await act(async () => { settle(thumbnail('file:///cache/library/t.webp')); });
      await waitFor(() => expect(tileSource()).toEqual({ uri: 'file:///cache/library/t.webp' }));
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test.each(['settled', 'settled, frame not run', 'in flight'] as const)(
      'an earlier resolve never stands in for the one after a fast-path failure: %s',
      async (stateOfFirst) => {
        const pending: ((source: LibraryRenderSource) => void)[] = [];
        const resolve = jest.fn((_digest: string, _intent: 'grid' | 'detail' | 'full') => (
          new Promise<LibraryRenderSource>((done) => { pending.push(done); })
        ));
        // The grid publishes resolves once per frame; the test owns the frames.
        const frames: FrameRequestCallback[] = [];
        const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
          frames.push(callback);
          return frames.length;
        });
        const runFrames = async () => {
          await act(async () => {
            for (const frame of frames.splice(0)) frame(0);
          });
        };
        try {
          const A = 'file:///cache/library/a.webp';
          const B = 'file:///cache/library/b.webp';
          const view = await render(readyView([fastRow()], {
            libraryOverlay: { entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: false })], resolve },
          }));
          await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
          if (stateOfFirst === 'settled') {
            await act(async () => { pending[0]!(thumbnail(A)); });
            await runFrames();
            expect(tileSource()).toEqual({ uri: A });
          }
          if (stateOfFirst === 'settled, frame not run') {
            // A is settled but waits in the pending batch for its frame.
            await act(async () => { pending[0]!(thumbnail(A)); });
          }

          await view.rerender(readyView([fastRow()], {
            libraryOverlay: { entries: [fastEntry()], resolve },
          }));
          expect(tileSource()).toEqual({ uri: LOCAL });

          await act(async () => { tileError()(); });
          expect(resolve).toHaveBeenCalledTimes(2);
          // The fast-path failure drops A from the rendered state too, not only
          // from the ref: A must never stand in while B is still on its way.
          await runFrames();
          expect(screen.queryByLabelText('图片 7')?.props.source).not.toEqual({ uri: A });

          if (stateOfFirst === 'in flight') {
            await act(async () => { pending[0]!(thumbnail(A)); });
          }
          await runFrames();
          await act(async () => { pending[1]!(thumbnail(B)); });
          await runFrames();

          expect(tileSource()).toEqual({ uri: B });
          expect(resolve).toHaveBeenCalledTimes(2);
        } finally {
          rafSpy.mockRestore();
        }
      },
    );

    test('after a failed fast path the repair gate reads no local original', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByText('需修复')).not.toBeOnTheScreen();

      await act(async () => { tileError()(); });
      await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());
    });

    test('a failed fast path whose grid resolve returns the local original is not 需修复', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file', uri: LOCAL, tier: 'local-original', role: 'original',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { tileError()(); });
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
      await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));

      expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
      expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel).toContain('可离线查看');
    });

    test('a failed fast path whose grid resolve returns the local original still reads as offline-ready', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file', uri: LOCAL, tier: 'local-original', role: 'original',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: 'cloud-original' })], resolve },
      }));

      await act(async () => { tileError()(); });
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
      await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));

      const label = screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel as string;
      expect(label).toContain('可离线查看');
      expect(label).not.toContain('仅在云端');
    });

    test('a failed fast path keeps trusting the local original while its grid resolve is in flight', async () => {
      let settle!: (source: LibraryRenderSource) => void;
      const resolve = jest.fn(() => new Promise<LibraryRenderSource>((done) => { settle = done; }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { tileError()(); });
      expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
      expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel).toContain('可离线查看');

      await act(async () => { settle({ kind: 'file', uri: LOCAL, tier: 'local-original', role: 'original' }); });
      await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));
    });

    test('a failed fast path whose grid resolve returns another file tier still needs repair', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file', uri: 'file:///cache/library/thumbnail.webp', tier: 'cached-thumbnail', role: 'thumbnail',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { tileError()(); });
      await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());
    });

    test('a failed fast path whose grid resolve rejects still needs repair', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => {
        throw new Error('resolve failed');
      });
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { tileError()(); });
      await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());
    });

    test('a local-original resolve does not clear the failed fast-path guard', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file', uri: LOCAL, tier: 'local-original', role: 'original',
      }));
      await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));

      await act(async () => { tileError()(); });
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));
      await act(async () => { tileError()(); });

      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test('a fast-path tile keeps its render across an unrelated screen rerender', async () => {
      const resolve = jest.fn(async () => thumbnail('file:///cache/library/never.webp'));
      // Row 7 takes the fast path; row 8 is an ordinary ready tile with no entry.
      const rows = [
        fastRow(),
        image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
      ];
      const overlay = { entries: [fastEntry()], resolve };
      const view = await render(readyView(rows, { libraryOverlay: overlay }));
      await act(async () => { await Promise.resolve(); });

      expect(mockImageRenders['图片 7']).toBe(1);
      expect(mockImageRenders['图片 8']).toBe(1);

      // Five screen rerenders with the same rows and overlay references: only a
      // callback that changes identity per render can reach the memoized tile.
      for (let i = 0; i < 5; i += 1) {
        await view.rerender(readyView(rows, { libraryOverlay: overlay }));
      }

      expect(mockImageRenders['图片 7']).toBe(1);
      expect(mockImageRenders['图片 8']).toBe(1);
      expect(resolve).not.toHaveBeenCalled();
    });

    test('a failed fast path is offered again after its row held its own collection file', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      const view = await render(readyView([fastRow()], { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });
      expect(tileSource()).toEqual({ uri: LOCAL });

      await act(async () => { tileError()(); });
      await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());

      // Row 7 becomes a ready row that holds its own collection file …
      await view.rerender(readyView([
        image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
      ], { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });
      // … then a mirrored row again: the fast path is offered afresh.
      await view.rerender(readyView([fastRow()], { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });

      await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));
      expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test('a failed fast path is offered again after its entry lost and regained its local original', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const view = await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      expect(tileSource()).toEqual({ uri: LOCAL });

      await act(async () => { tileError()(); });
      await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());

      // The entry loses its local original (still a mirrored, resolver-owned row) …
      await view.rerender(readyView([fastRow()], {
        libraryOverlay: {
          entries: [fastEntry({ originalGenerationId: null, hasLocalOriginal: false, localOriginalUri: null })],
          resolve,
        },
      }));
      await act(async () => { await Promise.resolve(); });
      // … then regains it: the fast path is offered afresh.
      await view.rerender(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));
      expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
      // Losing the local original moved the residency, so the resolve made for
      // the old one was dropped and asked afresh once (spec §5.12); regaining it
      // is served by the fast path with no further resolve.
      expect(resolve).toHaveBeenCalledTimes(2);
    });

    test('a hand-over clears a failed fast path (the handedOver prop)', async () => {
      // A render loop never returns from act(); turning React's loop warning into
      // a throw makes a self-re-triggering effect fail at once.
      const loopGuard = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).includes('Maximum update depth exceeded')) {
          throw new Error('the hand-over effect re-triggers itself');
        }
      });
      try {
        const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
          kind: 'unavailable', category: 'object_missing',
        }));
        const OWN8 = 'file:///collection/8.jpg';
        const rows = () => [fastRow(), image(8, { downloadState: 'ready', localUri: OWN8 })];
        const overlay = () => ({
          entries: [
            fastEntry({ originalGenerationId: null }),
            libraryEntry({
              plaintextSha256: viewDigest('s1b-prop-ready-8'),
              sourceImageId: 8,
              residency: 'local-original',
              hasLocalOriginal: true,
              localOriginalUri: 'file:///data/library/originals/d8.jpg',
            }),
          ],
          resolve,
        });
        const view = await render(readyView(rows(), { libraryOverlay: overlay() }));
        await act(async () => { await Promise.resolve(); });
        expect(tileSource()).toEqual({ uri: LOCAL });

        await act(async () => { tileError()(); });
        await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());

        // Nothing about the row or its entry changed; only the hand-over names it.
        await view.rerender(readyView(rows(), {
          libraryOverlay: overlay(),
          handedOver: { seq: 1, imageIds: [7] },
        }));
        await act(async () => { await Promise.resolve(); });

        await waitFor(() => expect(tileSource()).toEqual({ uri: LOCAL }));
        expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
        expect(screen.getByLabelText('图片 8').props.source).toEqual({ uri: OWN8 });
        expect(resolve).toHaveBeenCalledTimes(1);
      } finally {
        loopGuard.mockRestore();
      }
    });

    test('a hand-over is applied once: a later failure stays failed while the same hand-over is still the latest', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const handed = { seq: 1, imageIds: [7] };
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      const view = await render(readyView([fastRow()], { libraryOverlay: overlay(), handedOver: handed }));
      await act(async () => { await Promise.resolve(); });
      expect(tileSource()).toEqual({ uri: LOCAL });

      // The fast path fails after the hand-over was applied …
      await act(async () => { tileError()(); });
      await waitFor(() => expect(screen.getByText('需修复')).toBeOnTheScreen());

      // … and a fresh entries read (new entries, the same publication) does not forget it.
      await view.rerender(readyView([fastRow()], { libraryOverlay: overlay(), handedOver: handed }));
      await act(async () => { await Promise.resolve(); });

      expect(tileSource()).not.toEqual({ uri: LOCAL });
      expect(screen.getByText('需修复')).toBeOnTheScreen();
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test('a hand-over naming no failed digest costs no extra render', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      let commits = 0;
      const profiled = (handedOver: React.ComponentProps<typeof CollectionView>['handedOver']) => (
        <Profiler id="grid" onRender={() => { commits += 1; }}>
          {readyView([fastRow()], { libraryOverlay: overlay(), handedOver })}
        </Profiler>
      );
      const view = await render(profiled(null));
      await act(async () => { await Promise.resolve(); });

      commits = 0;
      await view.rerender(profiled({ seq: 1, imageIds: [7] }));
      await act(async () => { await Promise.resolve(); });

      // Nothing had failed, so the hand-over changes no state: the prop's own render only.
      expect(commits).toBe(1);
    });

    test('a failed fast path stays withheld while nothing changed', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const view = await render(readyView([fastRow()], {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      await act(async () => { tileError()(); });
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

      // New object references, equal values: the fast path must stay withheld.
      for (let i = 0; i < 2; i += 1) {
        await view.rerender(readyView([fastRow()], {
          libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
        }));
        await act(async () => { await Promise.resolve(); });
      }

      expect(tileSource()).not.toEqual({ uri: LOCAL });
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test('a failed fast path beside a row with no entry yet leaves that row alone', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      // Row 7 takes the fast path; row 8 is a ready row the library has not
      // ingested yet, so it has no entry for the forget effect to read.
      const rows = () => [
        fastRow(),
        image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
      ];
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      const view = await render(readyView(rows(), { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });
      expect(tileSource()).toEqual({ uri: LOCAL });

      await act(async () => { tileError()(); });
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

      // New object references, equal values: the forget effect walks both rows
      // again, the entry-less one included, and must neither throw nor act on it.
      await view.rerender(readyView(rows(), { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByLabelText('图片 8').props.source).toEqual({
        uri: 'file:///collection/8.jpg',
      });
      expect(tileSource()).not.toEqual({ uri: LOCAL });
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test('a late answer of an earlier resolve never clears the fresh resolve\'s in-flight mark', async () => {
      const pending: ((source: LibraryRenderSource) => void)[] = [];
      const resolve = jest.fn((_digest: string, _intent: 'grid' | 'detail' | 'full') => (
        new Promise<LibraryRenderSource>((done) => { pending.push(done); })
      ));
      const frames: FrameRequestCallback[] = [];
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const runFrames = async () => {
        await act(async () => { for (const frame of frames.splice(0)) frame(0); });
      };
      try {
        const B = 'file:///cache/library/b.webp';
        // #1 resolves while the fast path is off (no local original yet).
        const view = await render(readyView([fastRow()], {
          libraryOverlay: { entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: false })], resolve },
        }));
        await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

        // The fast path returns and then fails → #2 at a fresh generation.
        await view.rerender(readyView([fastRow()], { libraryOverlay: { entries: [fastEntry()], resolve } }));
        expect(tileSource()).toEqual({ uri: LOCAL });
        await act(async () => { tileError()(); });
        expect(resolve).toHaveBeenCalledTimes(2);

        // #1 (older generation) settles late and its frame runs.
        await act(async () => { pending[0]!(thumbnail('file:///cache/library/a.webp')); });
        await runFrames();

        // Another window pass must not start a third resolve — #2 still holds the
        // in-flight mark; #1's late `finally` must not clear it.
        await view.rerender(readyView([fastRow()], { libraryOverlay: { entries: [fastEntry()], resolve } }));
        await runFrames();
        expect(resolve).toHaveBeenCalledTimes(2);

        await act(async () => { pending[1]!(thumbnail(B)); });
        await runFrames();
        expect(tileSource()).toEqual({ uri: B });
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('an earlier resolve that fails late never blanks the fresh one', async () => {
      const pending: ((source: LibraryRenderSource) => void)[] = [];
      const rejecters: ((error: unknown) => void)[] = [];
      const resolve = jest.fn((_digest: string, _intent: 'grid' | 'detail' | 'full') => (
        new Promise<LibraryRenderSource>((done, fail) => { pending.push(done); rejecters.push(fail); })
      ));
      const frames: FrameRequestCallback[] = [];
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const runFrames = async () => {
        await act(async () => { for (const frame of frames.splice(0)) frame(0); });
      };
      try {
        const B = 'file:///cache/library/b.webp';
        const view = await render(readyView([fastRow()], {
          libraryOverlay: { entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: false })], resolve },
        }));
        await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

        await view.rerender(readyView([fastRow()], { libraryOverlay: { entries: [fastEntry()], resolve } }));
        expect(tileSource()).toEqual({ uri: LOCAL });
        await act(async () => { tileError()(); });
        expect(resolve).toHaveBeenCalledTimes(2);

        // #1 (older generation) rejects late; it must not blank the digest.
        await act(async () => { rejecters[0]!(new Error('late failure')); });
        await runFrames();

        // #2 answers B, which must survive.
        await act(async () => { pending[1]!(thumbnail(B)); });
        await runFrames();
        expect(tileSource()).toEqual({ uri: B });
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('board #16: a fast-path too-large gif is cut as an original, not treated as a thumbnail', async () => {
      const GIF = 'file:///data/library/originals/d.gif';
      const resolve = jest.fn(async () => thumbnail('file:///cache/library/never.webp'));
      await render(readyView([
        image(7, { downloadState: 'mirrored', localUri: null, extension: '.gif', isAnimated: true, byteSize: 50_278_178 }),
      ], {
        libraryOverlay: {
          entries: [fastEntry({ format: 'gif', byteSize: 50_278_178, localOriginalUri: GIF })],
          resolve,
        },
      }));
      await act(async () => { await Promise.resolve(); });

      // A fast path is an ORIGINAL: a too-large gif is cut to its first-frame
      // still. A 'thumbnail' role would skip the cut and render the gif file.
      expect(mockStillStore.stillFor).toHaveBeenCalledWith(GIF, 50_278_178);
      expect(resolve).not.toHaveBeenCalled();
    });

    test('a resolved override that fails to load stays silent', async () => {
      const T = 'file:///cache/library/t.webp';
      const resolve = jest.fn(async () => thumbnail(T));
      await render(readyView([fastRow()], {
        libraryOverlay: {
          // No local original: the row takes the resolver's override, not a fast path.
          entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: true, originalGenerationId: null })],
          resolve,
        },
      }));
      await waitFor(() => expect(tileSource()).toEqual({ uri: T }));
      expect(resolve).toHaveBeenCalledTimes(1);

      // The failing override is the resolver's, not a fast path: no re-resolve.
      await act(async () => { tileError()(); });
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    test('a ready row keeps its own collection file even when its entry holds the local original', async () => {
      const OWN = 'file:///collection/8.jpg';
      const ORIGINAL = 'file:///data/library/originals/d8.jpg';
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const onRepair = jest.fn(async () => false);
      await render(readyView([
        image(8, { downloadState: 'ready', localUri: OWN }),
      ], {
        onRepair,
        libraryOverlay: {
          entries: [libraryEntry({
            plaintextSha256: viewDigest('s1b-ready-owns-file'),
            sourceImageId: 8,
            residency: 'local-original',
            hasLocalOriginal: true,
            localOriginalUri: ORIGINAL,
          })],
          resolve,
        },
      }));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByLabelText('图片 8').props.source).toEqual({ uri: OWN });
      expect(resolve).not.toHaveBeenCalled();

      // Its load error is the tile's own local-file repair, never a failed fast path.
      await fireEvent(screen.getByLabelText('图片 8'), 'error');

      expect(onRepair).toHaveBeenCalledTimes(1);
      expect(onRepair).toHaveBeenCalledWith(8, OWN);
      expect(screen.getByLabelText('图片 8').props.source).toEqual({
        uri: 'https://cdn.example.com/8.jpg',
      });
      expect(resolve).not.toHaveBeenCalled();
    });

    test('a failed fast path settles beside rows whose fast path is withheld for another reason', async () => {
      // A render loop never returns from act(); turning React's loop warning into
      // a throw stops it inside the effect, so a self-re-triggering effect fails at once.
      const loopGuard = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).includes('Maximum update depth exceeded')) {
          throw new Error('the forget effect re-triggers itself');
        }
      });
      try {
        const resolve = jest.fn(async (
          _digest: string,
          _intent: 'grid' | 'detail' | 'full',
        ): Promise<LibraryRenderSource> => ({
          kind: 'unavailable', category: 'object_missing',
        }));
        const OWN8 = 'file:///collection/8.jpg';
        const rows = () => [
          fastRow(),
          image(8, { downloadState: 'ready', localUri: OWN8 }),
          image(9, { downloadState: 'mirrored', localUri: null }),
        ];
        const overlay = () => ({
          entries: [
            fastEntry({ originalGenerationId: null }),
            libraryEntry({
              plaintextSha256: viewDigest('s1b-settle-ready-8'),
              sourceImageId: 8,
              residency: 'local-original',
              hasLocalOriginal: true,
              localOriginalUri: 'file:///data/library/originals/d8.jpg',
            }),
            libraryEntry({
              plaintextSha256: viewDigest('s1b-settle-no-original-9'),
              sourceImageId: 9,
              residency: 'local-original',
              hasLocalOriginal: false,
              localOriginalUri: null,
            }),
          ],
          resolve,
        });
        const rendered = await render(readyView(rows(), { libraryOverlay: overlay() }));
        await act(async () => { await Promise.resolve(); });
        expect(tileSource()).toEqual({ uri: LOCAL });

        await act(async () => { tileError()(); });
        await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'grid'));
        for (let i = 0; i < 5; i += 1) {
          await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
        }
        await rendered.rerender(readyView(rows(), { libraryOverlay: overlay() }));
        await rendered.rerender(readyView(rows(), { libraryOverlay: overlay() }));
        await act(async () => { await Promise.resolve(); });

        expect(screen.getByLabelText('图片 8').props.source).toEqual({ uri: OWN8 });
        expect(tileSource()).not.toEqual({ uri: LOCAL });
        expect(resolve.mock.calls.filter(([d]) => d === digest)).toHaveLength(1);
      } finally {
        loopGuard.mockRestore();
      }
    });
  });

  describe('board #27 S3b: a residency change drops the resolve (spec §5.12)', () => {
    const digest = viewDigest('s3b-residency');
    const LOCAL = 'file:///data/library/originals/d.jpg';
    const T = 'file:///doc/library/thumbnails/d.webp';
    const fastRow = () => image(7, { downloadState: 'mirrored', localUri: null });
    const fastEntry = (overrides: Partial<LibraryEntry> = {}) => libraryEntry({
      plaintextSha256: digest,
      sourceImageId: 7,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: LOCAL,
      ...overrides,
    });
    const evicted = { residency: 'cloud-only', hasLocalOriginal: false, localOriginalUri: null } as const;
    const localOriginal = (uri: string): LibraryRenderSource => ({
      kind: 'file', uri, tier: 'local-original', role: 'original',
    });
    const thumbnail = (uri: string): LibraryRenderSource => ({
      kind: 'file', uri, tier: 'cached-thumbnail', role: 'thumbnail',
    });
    const tileSource = () => screen.getByLabelText('图片 7').props.source;
    const tileError = () => screen.getByLabelText('图片 7').props.onError as () => void;

    // The grid publishes resolves once per frame; the test owns the frames.
    function ownFrames() {
      const frames: FrameRequestCallback[] = [];
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const runFrames = async () => {
        await act(async () => {
          for (const frame of frames.splice(0)) frame(0);
        });
      };
      return { rafSpy, runFrames };
    }

    function pendingResolve() {
      const pending: ((source: LibraryRenderSource) => void)[] = [];
      const resolve = jest.fn((_digest: string, _intent: 'grid' | 'detail' | 'full') => (
        new Promise<LibraryRenderSource>((done) => { pending.push(done); })
      ));
      return { pending, resolve };
    }

    test('an eviction drops a settled resolve and resolves afresh', async () => {
      const { pending, resolve } = pendingResolve();
      const { rafSpy, runFrames } = ownFrames();
      try {
        const view = await render(readyView([fastRow()], {
          libraryOverlay: { entries: [fastEntry()], resolve },
        }));
        await act(async () => { tileError()(); });
        expect(resolve).toHaveBeenCalledTimes(1);
        await act(async () => { pending[0]!(localOriginal(LOCAL)); });
        await runFrames();
        expect(tileSource()).toEqual({ uri: LOCAL });

        await view.rerender(readyView([fastRow()], {
          libraryOverlay: { entries: [fastEntry(evicted)], resolve },
        }));
        await act(async () => { await Promise.resolve(); });
        await runFrames();

        expect(resolve).toHaveBeenCalledTimes(2);
        expect(resolve).toHaveBeenLastCalledWith(digest, 'grid');
        // The deleted original is no longer shown while the fresh resolve runs.
        expect(screen.queryByLabelText('图片 7')?.props.source).not.toEqual({ uri: LOCAL });
        await act(async () => { pending[1]!(thumbnail(T)); });
        await runFrames();
        expect(tileSource()).toEqual({ uri: T });
      } finally {
        rafSpy.mockRestore();
      }
    });

    test.each(['in flight', 'settled, frame not run'] as const)(
      'a resolve in flight when the residency moves never lands: %s',
      async (stateOfFirst) => {
        const { pending, resolve } = pendingResolve();
        const { rafSpy, runFrames } = ownFrames();
        try {
          const view = await render(readyView([fastRow()], {
            libraryOverlay: { entries: [fastEntry()], resolve },
          }));
          await act(async () => { tileError()(); });
          expect(resolve).toHaveBeenCalledTimes(1);
          if (stateOfFirst === 'settled, frame not run') {
            await act(async () => { pending[0]!(localOriginal(LOCAL)); });
          }

          await view.rerender(readyView([fastRow()], {
            libraryOverlay: { entries: [fastEntry(evicted)], resolve },
          }));
          await act(async () => { await Promise.resolve(); });
          expect(resolve).toHaveBeenCalledTimes(2);

          await runFrames();
          expect(screen.queryByLabelText('图片 7')?.props.source).not.toEqual({ uri: LOCAL });

          if (stateOfFirst === 'in flight') {
            await act(async () => { pending[0]!(localOriginal(LOCAL)); });
          }
          await runFrames();
          expect(screen.queryByLabelText('图片 7')?.props.source).not.toEqual({ uri: LOCAL });

          await act(async () => { pending[1]!(thumbnail(T)); });
          await runFrames();
          expect(tileSource()).toEqual({ uri: T });
          expect(resolve).toHaveBeenCalledTimes(2);
        } finally {
          rafSpy.mockRestore();
        }
      },
    );

    test('an entries read that moves nothing re-resolves nothing', async () => {
      const { pending, resolve } = pendingResolve();
      const { rafSpy, runFrames } = ownFrames();
      try {
        const view = await render(readyView([fastRow()], {
          libraryOverlay: { entries: [fastEntry()], resolve },
        }));
        await act(async () => { tileError()(); });
        await act(async () => { pending[0]!(localOriginal(LOCAL)); });
        await runFrames();
        expect(tileSource()).toEqual({ uri: LOCAL });

        await view.rerender(readyView([fastRow()], {
          libraryOverlay: {
            entries: [fastEntry({ protection: 'pending', failureCategory: 'offline' })],
            resolve,
          },
        }));
        await act(async () => { await Promise.resolve(); });
        await runFrames();

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(tileSource()).toEqual({ uri: LOCAL });
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('a library-only tile re-resolves when its residency moves', async () => {
      const { pending, resolve } = pendingResolve();
      const { rafSpy, runFrames } = ownFrames();
      const libraryOnly = (overrides: Partial<LibraryEntry> = {}) => libraryEntry({
        plaintextSha256: digest,
        sourceImageId: null,
        residency: 'local-original',
        hasLocalOriginal: true,
        localOriginalUri: LOCAL,
        ...overrides,
      });
      try {
        const rows = () => [image(1, { localUri: 'file:///collection/1.jpg' })];
        // Start on local-original fast-path (0 resolves), then fail fast-path once so resolve #1 runs:
        const view = await render(readyView(rows(), {
          libraryOverlay: { entries: [libraryOnly()], resolve },
        }));
        expect(resolve).not.toHaveBeenCalled();
        const libImg = screen.getByLabelText('正在加载图库图片');
        await act(async () => { libImg.props.onError?.(); });
        await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
        await act(async () => { pending[0]!(localOriginal(LOCAL)); });
        await runFrames();

        // Residency moves to cloud-only -> drops the previous resolve and re-resolves (#2):
        await view.rerender(readyView(rows(), {
          libraryOverlay: {
            entries: [libraryOnly({
              residency: 'cloud-only',
              hasLocalOriginal: false,
              localOriginalUri: null,
            })],
            resolve,
          },
        }));
        await act(async () => { await Promise.resolve(); });

        expect(resolve).toHaveBeenCalledTimes(2);
        expect(resolve).toHaveBeenLastCalledWith(digest, 'grid');
      } finally {
        rafSpy.mockRestore();
      }
    });
  });

  test('K2 regression: a ready row with its own collection file ignores the resolver', async () => {
    const digest = viewDigest('k2-ready');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///library/originals/never.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    await render(readyView([
      image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: 8,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        resolve,
      },
    }));

    expect(screen.getByLabelText('图片 8').props.source).toEqual({
      uri: 'file:///collection/8.jpg',
    });
  });

  test('a ready row keeps its own file when its library entry has no local original', async () => {
    const digest = viewDigest('ready-no-local-original');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///cache/library/cloud-thumb.jpg',
      tier: 'cloud-thumbnail',
      role: 'thumbnail',
    }));
    await render(readyView([
      image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
    ], {
      libraryOverlay: {
        entries: [libraryEntry({
          plaintextSha256: digest,
          sourceImageId: 8,
          hasLocalOriginal: false,
        })],
        resolve,
      },
    }));

    expect(screen.getByLabelText('图片 8').props.source).toEqual({
      uri: 'file:///collection/8.jpg',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

function libraryEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    plaintextSha256: viewDigest('entry'),
    sourceImageId: null,
    format: 'jpeg',
    byteSize: 400_000,
    width: 800,
    height: 1200,
    residency: 'cloud-only',
    lifecycle: 'active',
    protection: 'protected',
    failureCategory: null,
    hasLocalOriginal: false,
    localOriginalUri: null,
    originalGenerationId: 'gen-orig',
    createdAt: 1_000,
    ...overrides,
  };
}

test('batch deletion calls deleteSaved per image and never returns images to discovery', async () => {
  const service = {
    deleteSaved: jest.fn().mockResolvedValue(image(1)),
    returnToDiscovery: jest.fn(),
  } as unknown as CollectionService;

  await deleteSelectedImages(service, [3, 2, 1]);

  expect(service.deleteSaved).toHaveBeenCalledTimes(3);
  expect(service.deleteSaved).toHaveBeenNthCalledWith(1, 3);
  expect(service.deleteSaved).toHaveBeenNthCalledWith(2, 2);
  expect(service.deleteSaved).toHaveBeenNthCalledWith(3, 1);
  expect(service.returnToDiscovery).not.toHaveBeenCalled();
});

test('batch deletion waits for every operation before rejecting', async () => {
  let finishSuccessfulDelete!: () => void;
  let successfulDeleteFinished = false;
  const successfulDelete = new Promise<StoredImage>((resolve) => {
    finishSuccessfulDelete = () => {
      successfulDeleteFinished = true;
      resolve(image(1));
    };
  });
  const service = {
    deleteSaved: jest.fn((imageId: number) => imageId === 2
      ? Promise.reject(new Error('delete 2 failed'))
      : successfulDelete),
  } as unknown as CollectionService;
  let settled = false;
  let deletionError: unknown;

  const deletion = deleteSelectedImages(service, [2, 1])
    .catch((error: unknown) => {
      deletionError = error;
    })
    .finally(() => {
      settled = true;
    });
  await act(async () => undefined);

  expect(settled).toBe(false);
  expect(successfulDeleteFinished).toBe(false);

  finishSuccessfulDelete();

  await deletion;
  expect(deletionError).toEqual(new Error('delete 2 failed'));
  expect(successfulDeleteFinished).toBe(true);
});

describe('CollectionScreen', () => {
  test('an old in-flight entries read cannot own the rebound follow-up', async () => {
    let finishOld!: (entries: readonly LibraryEntry[]) => void;
    const staleEntry = libraryEntry({
      plaintextSha256: viewDigest('stale-grid-read'),
      sourceImageId: null,
    });
    const oldRead = jest.fn(() => new Promise<readonly LibraryEntry[]>((done) => {
      finishOld = done;
    }));
    const newRead = jest.fn(() => new Promise<readonly LibraryEntry[]>(() => undefined));
    const client = queryClient();
    const oldServices = {
      ...collectionMockServices(),
      libraryView: { model: { listEntries: oldRead }, resolver: { resolve: jest.fn() } },
    };
    mockAppServices = oldServices;
    const element = () => (
      <QueryClientProvider client={client}>
        <CollectionScreen />
      </QueryClientProvider>
    );
    const rendered = await render(element());
    await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(1));
    mockAppServices = {
      ...oldServices,
      libraryView: { model: { listEntries: newRead }, resolver: { resolve: jest.fn() } },
      byosStatus: { status: 'ready' },
    };
    await rendered.rerender(element());
    await act(async () => {
      finishOld([staleEntry]);
    });
    await waitFor(() => expect(newRead).toHaveBeenCalledTimes(1));
    expect(oldRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(`library-asset-tile-${staleEntry.plaintextSha256}`)).toBeNull();
  });

  test('a hand-over taken by a replaced entries read is published by the follow-up', async () => {
    const own = 'file:///collection/7.jpg';
    const entry = libraryEntry({
      plaintextSha256: viewDigest('handover-grid'),
      sourceImageId: 7,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: 'file:///library/7.jpg',
    });
    const callbacks = new Set<(change: { kind: string; imageId?: number }) => void>();
    const feed = {
      subscribe: jest.fn((callback: (change: { kind: string; imageId?: number }) => void) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      }),
      emit: (change: { kind: string; imageId?: number }) => {
        for (const callback of callbacks) callback(change);
      },
    };
    let finishOld!: (entries: readonly LibraryEntry[]) => void;
    const oldRead = jest.fn()
      .mockResolvedValueOnce([entry])
      .mockImplementationOnce(() => new Promise<readonly LibraryEntry[]>((done) => {
        finishOld = done;
      }));
    const newRead = jest.fn(async () => [entry]);
    const getById = jest.fn(async () => image(7, { localUri: null, downloadState: 'mirrored' }));
    const client = queryClient();
    const services = {
      ...collectionMockServices(),
      imageRepository: {
        listCollection: jest.fn(async () => [image(7, { localUri: own, downloadState: 'ready' })]),
        getById,
      },
      libraryChanges: feed,
      libraryView: { model: { listEntries: oldRead }, resolver: { resolve: jest.fn() } },
    };
    mockAppServices = services;
    const element = () => (
      <QueryClientProvider client={client}>
        <CollectionScreen />
      </QueryClientProvider>
    );
    const rendered = await render(element());
    await screen.findByLabelText(/收藏图片 7/);
    await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(1));
    await act(async () => {
      feed.emit({ kind: 'handed-over', imageId: 7 });
    });
    await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(2));
    mockAppServices = {
      ...services,
      libraryView: { model: { listEntries: newRead }, resolver: { resolve: jest.fn() } },
      byosStatus: { status: 'ready' },
    };
    await rendered.rerender(element());
    await act(async () => {
      finishOld([entry]);
    });
    await waitFor(() => expect(newRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      client.getQueryData<StoredImage[]>(collectionQueryKey())?.[0]?.downloadState,
    ).toBe('mirrored'));
    expect(getById).toHaveBeenCalledWith(7);
  });

  test('the collection header offers a trash entry that opens the trash route when a library exists', async () => {
    // libraryView present => a Direct library exists.
    mockRouter.push.mockClear();
    mockAppServices = {
      ...collectionMockServices(),
      libraryActions: {},
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([]) },
        resolver: { resolve: jest.fn() },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    const trash = await screen.findByTestId('collection-trash-entry');
    await fireEvent.press(trash);
    expect(mockRouter.push).toHaveBeenCalledWith('/library/trash');
  });

  test('a library-only tile on a disconnected composition says the library is disconnected', async () => {
    const digest = viewDigest('disconnected-grid');
    mockAppServices = {
      ...collectionMockServices(),
      imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
      byosStatus: { status: 'unconfigured' },
      libraryView: {
        model: {
          listEntries: jest.fn().mockResolvedValue([
            libraryEntry({ plaintextSha256: digest, sourceImageId: null }),
          ]),
        },
        resolver: {
          resolve: jest.fn(async () => ({ kind: 'unavailable', category: 'auth_attention' })),
        },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId(`library-asset-locked-${digest}`))
      .toHaveTextContent(zhHans.libraryView.disconnectedTitle);
  });

  test('no trash entry without a library', async () => {
    mockAppServices = { ...collectionMockServices(), libraryView: null };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    await screen.findByLabelText(/收藏图片 1/);
    expect(screen.queryByTestId('collection-trash-entry')).toBeNull();
  });

  test('no trash entry with only the local library view', async () => {
    mockAppServices = {
      ...collectionMockServices(),
      libraryActions: null,
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([]) },
        resolver: { resolve: jest.fn() },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    await screen.findByLabelText(/收藏图片 1/);
    expect(screen.queryByTestId('collection-trash-entry')).toBeNull();
  });

  test('trash stays reachable from the empty collection when a library exists (soft-deleted everything)', async () => {
    // Every image soft-deleted => the collection grid is empty but the library
    // (and its trash) exists. Trash MUST remain reachable, or the user can never
    // restore what they deleted. Settings no longer carries a trash entry.
    mockRouter.push.mockClear();
    mockAppServices = {
      ...collectionMockServices(),
      imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
      libraryActions: {},
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([]) },
        resolver: { resolve: jest.fn() },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    const trash = await screen.findByTestId('collection-trash-entry');
    await fireEvent.press(trash);
    expect(mockRouter.push).toHaveBeenCalledWith('/library/trash');
  });

  test('reads pending records without making the collection tab start repair work', async () => {
    const resumePendingDownloads = jest.fn().mockResolvedValue([]);
    const listCollection = jest.fn().mockResolvedValue([
      image(7, { downloadState: 'pending', localUri: null }),
    ]);
    mockAppServices = {
      collectionService: { resumePendingDownloads },
      dataRevision: 0,
      imageRepository: { listCollection },
      settings: { blurNsfwThumbnails: true },
    };

    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    expect(screen.getByText('保存中')).toBeOnTheScreen();
    expect(resumePendingDownloads).not.toHaveBeenCalled();
    expect(screen.getByTestId('collection-list').props.refreshing).toBe(false);

    expect(listCollection).toHaveBeenCalledTimes(1);
    expect(resumePendingDownloads).not.toHaveBeenCalled();
  });

  test('runs legacy pending repair only when the user manually refreshes', async () => {
    let collection = [image(7, { downloadState: 'pending', localUri: null })];
    let finishRetry!: () => void;
    const resumePendingDownloads = jest.fn(
      () => new Promise<void>((resolve) => {
        finishRetry = () => {
          collection = [image(7, { localUri: 'file:///collection/7.jpg' })];
          resolve();
        };
      }),
    );
    const listCollection = jest.fn(async () => collection);
    mockAppServices = {
      collectionService: { resumePendingDownloads },
      dataRevision: 0,
      imageRepository: { listCollection },
      settings: { blurNsfwThumbnails: true },
    };

    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('保存中')).toBeOnTheScreen();
    expect(resumePendingDownloads).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByTestId('collection-list').props.onRefresh();
    });

    expect(resumePendingDownloads).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('collection-list').props.refreshing).toBe(true);

    await act(async () => finishRetry());

    await waitFor(() => expect(screen.queryByText('保存中')).not.toBeOnTheScreen());
    expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///collection/7.jpg',
    });
    expect(resumePendingDownloads).toHaveBeenCalledTimes(1);
    expect(listCollection).toHaveBeenCalledTimes(2);
  });

  test('the automatic repair names the file it failed to load', async () => {
    const retryDownload = jest.fn().mockResolvedValue({
      status: 'ready',
      uri: 'file:///collection/7.jpg',
      reused: true,
    });
    const repairDownload = jest.fn().mockResolvedValue({
      status: 'ready',
      uri: 'file:///collection/7.jpg',
      reused: false,
    });
    const repairMissingFile = jest.fn().mockResolvedValue({
      status: 'ready',
      uri: 'file:///collection/7.jpg',
      reused: false,
    });
    mockAppServices = {
      collectionService: {
        resumePendingDownloads: jest.fn(() => new Promise<never>(() => undefined)),
        retryDownload,
        repairDownload,
        repairMissingFile,
      },
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([
          image(7, { localUri: 'file:///collection/7.jpg' }),
        ]),
      },
      settings: { blurNsfwThumbnails: true },
    };

    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    await fireEvent(await screen.findByLabelText('图片 7'), 'error');
    await waitFor(() => expect(repairMissingFile).toHaveBeenCalledWith(7, 'file:///collection/7.jpg'));

    expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///collection/7.jpg',
    });
    expect(repairMissingFile).toHaveBeenCalledTimes(1);
    expect(repairDownload).not.toHaveBeenCalled();
    expect(retryDownload).not.toHaveBeenCalled();
  });

  test('publishes one refreshed snapshot only after all batch deletions settle', async () => {
    let finishSuccessfulDelete!: () => void;
    let collection = [image(1), image(2)];
    const successfulDelete = new Promise<StoredImage>((resolve) => {
      finishSuccessfulDelete = () => {
        collection = [image(2)];
        resolve(image(1));
      };
    });
    const collectionService = {
      resumePendingDownloads: jest.fn().mockResolvedValue([]),
      deleteSaved: jest.fn((imageId: number) => imageId === 2
        ? Promise.reject(new Error('delete 2 failed'))
        : successfulDelete),
    };
    const listCollection = jest.fn(async () => collection);
    mockAppServices = {
      collectionService,
      dataRevision: 0,
      imageRepository: { listCollection },
      settings: { blurNsfwThumbnails: true },
    };
    const client = queryClient();
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    await render(
      <QueryClientProvider client={client}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    await screen.findByLabelText(/收藏图片 2/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await fireEvent(screen.getByLabelText(/收藏图片 2/), 'longPress');
    await fireEvent.press(screen.getByLabelText(/收藏图片 1/));
    await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));
    await waitFor(() => expect(collectionService.deleteSaved).toHaveBeenCalledTimes(2));

    expect(listCollection).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishSuccessfulDelete();
      await successfulDelete;
    });

    await waitFor(() => expect(listCollection).toHaveBeenCalledTimes(2));
    expect(client.getQueryData(collectionQueryKey())).toEqual([image(2)]);
    expect(screen.getByText('操作未能完成，请重试。')).toBeOnTheScreen();
  });

  test('keeps the same cached collection when settings publish a new data revision', async () => {
    const listCollection = jest.fn().mockResolvedValue([image(7)]);
    mockAppServices = {
      collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
      dataRevision: 0,
      imageRepository: { listCollection },
      settings: { blurNsfwThumbnails: true },
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
      libraryView: null,
    };
    const client = queryClient();
    const screenView = await render(
      <QueryClientProvider client={client}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    expect(listCollection).toHaveBeenCalledTimes(1);

    mockAppServices = {
      ...mockAppServices,
      dataRevision: 1,
      settings: { blurNsfwThumbnails: false },
    };
    await screenView.rerender(
      <QueryClientProvider client={client}>
        <CollectionScreen />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    expect(listCollection).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(collectionQueryKey())).toEqual([image(7)]);
  });

  /**
   * K7 ⑤: a tab tap is not a data-change event. Focusing the grid used to run
   * a whole cloud round (bucket LIST, full-library UPSERT, candidate scans,
   * mirror passes) on the exact frame the grid mounts — the owner's "点 Tab
   * 卡几秒". The four real events (ingest, session ready, foreground,
   * K6-2b's change feed) already cover every case that moves data.
   */
  test('K7 ⑤: focusing the grid starts no sync cycle at all', async () => {
    const trigger = {
      onAppStateChange: jest.fn(),
      onLibraryChanged: jest.fn(),
      onSessionReady: jest.fn(),
      onNetworkReturn: jest.fn(),
      onRoundComplete: jest.fn(() => () => undefined),
      dispose: jest.fn(),
    };
    mockAppServices = {
      collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
      settings: { blurNsfwThumbnails: true },
      librarySyncTrigger: trigger,
      libraryView: null,
    };

    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );

    expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    expect(trigger.onAppStateChange).not.toHaveBeenCalled();
    expect(trigger.onLibraryChanged).not.toHaveBeenCalled();
    expect(trigger.onSessionReady).not.toHaveBeenCalled();
    // The deleted method must not come back under any name.
    expect(Object.keys(trigger)).not.toContain('onScreenFocus');
    expect((trigger as Record<string, unknown>).onScreenFocus).toBeUndefined();
  });

  test('board #9: a rejected first entries read still releases a file-less tile to the provider', async () => {
    const listEntries = jest.fn().mockRejectedValue(new Error('entries read failed'));
    const resolve = jest.fn();
    mockAppServices = {
      ...collectionMockServices(),
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'failed', localUri: null })]),
      },
      libraryView: { model: { listEntries }, resolver: { resolve } },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );

    // The widened guard must not hold the row forever when the read fails.
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    }));
    expect(resolve).not.toHaveBeenCalled();
  });

  test('the grid container keeps a mirrored tile library-owned until the first entries read settles', async () => {
    const digest = viewDigest('k2-grid-entries-wait');
    let settleEntries!: (entries: LibraryEntry[]) => void;
    const listEntries = jest.fn(() => new Promise<LibraryEntry[]>((resolveEntries) => {
      settleEntries = resolveEntries;
    }));
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///library/originals/wait.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    mockAppServices = {
      ...collectionMockServices(),
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]),
      },
      libraryView: { model: { listEntries }, resolver: { resolve } },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listEntries).toHaveBeenCalled());
    expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    // Entries still in flight: the tile is its colour block, no provider load.
    expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();

    await act(async () => settleEntries([
      libraryEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'local-original', hasLocalOriginal: true }),
    ]));
    await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({
      uri: 'file:///library/originals/wait.jpg',
    }));
  });

  test('a Store-shaped bundle with librarySyncTrigger == null focuses inertly', async () => {
    mockAppServices = {
      collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
      settings: { blurNsfwThumbnails: true },
      librarySyncTrigger: null,
      libraryBackgroundSync: null,
      libraryView: null,
    };

    await expect(render(
      <QueryClientProvider client={queryClient()}>
        <CollectionScreen />
      </QueryClientProvider>,
    )).resolves.toBeTruthy();

    expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
  });

  /**
   * K6-2b (spec §2 G3, owner 2026-09-14: 「到底是上云了但 UI 过时还是确实还在
   * 上，这是个大事」). Measured on the emulator that day: a new save is
   * `protected` in SQLite after 4.2 s and the tile keeps reading "可离线查看"
   * with no orange cloud until the user leaves the tab and comes back. The grid
   * had no signal for it — `refreshLibraryEntries` ran on focus and on
   * `dataRevision`, and neither ingest nor protect touches either.
   */
  describe('K6-2b live refresh', () => {
    function changeFeed() {
      const listeners = new Set<(change: { kind: string }) => void>();
      return {
        emit(change: { kind: string }) {
          for (const listener of [...listeners]) listener(change);
        },
        subscribe: jest.fn((listener: (change: { kind: string }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        listenerCount: () => listeners.size,
      };
    }

    const digest = viewDigest('k62b-live');

    function libraryView(listEntries: jest.Mock) {
      return {
        model: { listEntries },
        resolver: {
          resolve: jest.fn(async () => ({
            kind: 'file',
            uri: 'file:///cache/library/k62b.jpg',
            tier: 'cached-thumbnail',
            role: 'thumbnail',
          })),
        },
      };
    }

    test('a `protected` change repaints the tile without a focus or a tab switch', async () => {
      let protection: LibraryEntry['protection'] = 'pending';
      const listEntries = jest.fn(async () => [libraryEntry({
        plaintextSha256: digest,
        sourceImageId: 7,
        protection,
        hasLocalOriginal: true,
        residency: 'local-original',
        originalGenerationId: protection === 'protected' ? 'gen-1' : null,
      })]);
      const feed = changeFeed();
      mockAppServices = {
        collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
        dataRevision: 0,
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([
            image(7, { localUri: 'file:///collection/7.jpg' }),
          ]),
        },
        settings: { blurNsfwThumbnails: true },
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryView: libraryView(listEntries),
        libraryChanges: feed,
      };

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );

      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      expect(screen.queryByLabelText(/收藏图片 7.*已同步到云端/)).toBeNull();
      const callsBefore = listEntries.mock.calls.length;

      // The upload just committed. Nothing else happens: no focus, no
      // re-render from above, no `dataRevision` bump.
      protection = 'protected';
      await act(async () => { feed.emit({ kind: 'protected' }); });

      await waitFor(() => expect(
        screen.getByLabelText(/收藏图片 7.*已同步到云端/),
      ).toBeOnTheScreen());
      expect(listEntries.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    test('coalesces a burst of changes into one extra read, never a queue of them', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let gateArmed = false;
      const listEntries = jest.fn(async () => {
        if (gateArmed) await gate;
        return [libraryEntry({ plaintextSha256: digest, sourceImageId: null })];
      });
      const feed = changeFeed();
      mockAppServices = {
        collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        settings: { blurNsfwThumbnails: true },
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryView: libraryView(listEntries),
        libraryChanges: feed,
      };

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(listEntries).toHaveBeenCalled());
      listEntries.mockClear();

      // Five assets finish within one another's read. The grid must not run
      // five reads, and must not drop the last one either.
      gateArmed = true;
      await act(async () => {
        for (let i = 0; i < 5; i++) feed.emit({ kind: 'protected' });
      });
      expect(listEntries).toHaveBeenCalledTimes(1);

      gateArmed = false;
      await act(async () => { release(); });

      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
      // And it stays at two: the four coalesced events became one re-read.
      await act(async () => { await Promise.resolve(); });
      expect(listEntries).toHaveBeenCalledTimes(2);
    });

    test('unsubscribes on unmount so a later upload cannot set state on a dead screen', async () => {
      const listEntries = jest.fn(async () => []);
      const feed = changeFeed();
      mockAppServices = {
        collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        settings: { blurNsfwThumbnails: true },
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryView: libraryView(listEntries),
        libraryChanges: feed,
      };

      const view = await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(feed.subscribe).toHaveBeenCalledTimes(1));

      await act(async () => { await view.unmount(); });

      expect(feed.listenerCount()).toBe(0);
    });

    test('a Store-shaped bundle with no feed still renders', async () => {
      mockAppServices = {
        collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
        settings: { blurNsfwThumbnails: true },
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryView: null,
        libraryChanges: null,
      };

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );

      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
    });
  });

  /**
   * Board #27 S1b (spec §5.5): the library takes a saved image's collection
   * file over and the row turns `mirrored`. The row is republished only after
   * an entries read that began after the hand-over, so it carries its entry.
   */
  describe('board #27 S1b: a hand-over republishes the row after the entries read', () => {
    const handedDigest = viewDigest('s1b-handed-over');
    const U = 'file:///data/library/originals/handed.jpg';
    const handedEntry = (id: number) => libraryEntry({
      plaintextSha256: viewDigest(`s1b-handed-${id}`),
      sourceImageId: id,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: U,
    });

    function changeFeed() {
      const listeners = new Set<(change: { kind: string; imageId?: number; plaintextSha256?: string }) => void>();
      return {
        emit(change: { kind: string; imageId?: number; plaintextSha256?: string }) {
          for (const listener of [...listeners]) listener(change);
        },
        subscribe: jest.fn((listener: (change: { kind: string; imageId?: number }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      };
    }

    /** `listEntries` answers at once until `hold(n)` arms n held reads, released one by one. */
    function heldEntries(answer: () => LibraryEntry[]) {
      const gates: (() => void)[] = [];
      let toHold = 0;
      const listEntries = jest.fn(async () => {
        if (toHold > 0) {
          toHold -= 1;
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        return answer();
      });
      return {
        listEntries,
        hold: (count: number) => { toHold = count; },
        release: async () => { await act(async () => { gates.shift()!(); }); },
        held: () => gates.length,
      };
    }

    function setup(rows: StoredImage[], entries: () => LibraryEntry[]) {
      const feed = changeFeed();
      const held = heldEntries(entries);
      const getById = jest.fn(async (id: number) => (
        rows.some((row) => row.id === id)
          ? image(id, { downloadState: 'mirrored', localUri: null })
          : null
      ));
      const listCollection = jest.fn().mockResolvedValue(rows);
      mockAppServices = {
        collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
        dataRevision: 0,
        imageRepository: { listCollection, getById },
        settings: { blurNsfwThumbnails: true },
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryView: {
          model: { listEntries: held.listEntries },
          resolver: {
            resolve: jest.fn(async () => ({
              kind: 'file', uri: 'file:///cache/never.jpg', tier: 'cached-thumbnail', role: 'thumbnail',
            })),
          },
        },
        libraryChanges: feed,
      };
      return { feed, held, getById, listCollection };
    }

    test('a handed-over row is republished only after the entries read that follows it', async () => {
      const { feed, held, getById } = setup(
        [image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' })],
        () => [handedEntry(7)],
      );
      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('图片 7').props.source)
        .toEqual({ uri: 'file:///collection/7.jpg' }));
      held.listEntries.mockClear();

      held.hold(1);
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: handedDigest });
      });
      await waitFor(() => expect(held.held()).toBe(1));
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(getById).not.toHaveBeenCalled();

      await held.release();

      await waitFor(() => expect(getById).toHaveBeenCalledWith(7));
      await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: U }));
    });

    test('hand-overs recorded during a running read wait for the next one, which republishes them in one snapshot', async () => {
      const { feed, held, getById, listCollection } = setup(
        [
          image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
          image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
        ],
        () => [handedEntry(7), handedEntry(8)],
      );
      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });
      listCollection.mockClear();

      // An ordinary change starts a read that stays held; so does the follow-up.
      held.hold(2);
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(held.held()).toBe(1));
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: handedDigest });
        feed.emit({ kind: 'handed-over', imageId: 8, plaintextSha256: handedDigest });
      });

      await held.release();
      await waitFor(() => expect(held.held()).toBe(1));
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      expect(listCollection).not.toHaveBeenCalled();
      expect(getById).not.toHaveBeenCalled();

      await held.release();

      await waitFor(() => expect(listCollection).toHaveBeenCalledTimes(1));
      expect(getById).not.toHaveBeenCalled();
    });

    test('a read after the follow-up publishes nothing it already published', async () => {
      const { feed, held, getById, listCollection } = setup(
        [
          image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
          image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
        ],
        () => [handedEntry(7), handedEntry(8)],
      );
      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });
      listCollection.mockClear();

      // Both hand-overs are published by the follow-up read, in one snapshot.
      held.hold(2);
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(held.held()).toBe(1));
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: handedDigest });
        feed.emit({ kind: 'handed-over', imageId: 8, plaintextSha256: handedDigest });
      });
      await held.release();
      await waitFor(() => expect(held.held()).toBe(1));
      await held.release();
      await waitFor(() => expect(listCollection).toHaveBeenCalledTimes(1));

      // A later ordinary change (no imageId) starts a third read; it has taken
      // nothing, so it publishes neither a row nor a snapshot.
      held.listEntries.mockClear();
      await act(async () => { feed.emit({ kind: 'ingested', plaintextSha256: 'x' }); });
      await waitFor(() => expect(held.listEntries).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(listCollection).toHaveBeenCalledTimes(1);
      expect(getById).not.toHaveBeenCalled();
    });

    test('a second hand-over clears a second failed fast path', async () => {
      const { feed } = setup(
        [image(7, { downloadState: 'mirrored', localUri: null })],
        () => [handedEntry(7)],
      );
      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: U }));

      for (let round = 0; round < 2; round += 1) {
        await act(async () => { (screen.getByLabelText('图片 7').props.onError as () => void)(); });
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source)
          .not.toEqual({ uri: U }));
        await act(async () => {
          feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: handedDigest });
        });
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: U }));
      }
    });

    test('only a handed-over change is a hand-over, whatever else it carries', async () => {
      const { feed, getById } = setup(
        [image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' })],
        () => [handedEntry(7)],
      );
      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });

      await act(async () => { feed.emit({ kind: 'protected', imageId: 7 }); });
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(getById).not.toHaveBeenCalled();
    });

    test('a failed entries read still publishes the ids it took', async () => {
      const { feed, held, getById } = setup(
        [image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' })],
        () => [handedEntry(7)],
      );
      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByLabelText('图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });

      // The collection file is gone, so `mirrored` is the row's truth even
      // though the read that follows the hand-over rejects.
      held.listEntries.mockImplementationOnce(() => Promise.reject(new Error('read failed')));
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: handedDigest });
      });

      await waitFor(() => expect(getById).toHaveBeenCalledWith(7));
    });

    test('the grid container registers as a hand-over publisher while mounted', async () => {
      setup([image(7)], () => []);
      const release = jest.fn();
      const register = jest.fn(() => release);

      const view = await render(
        <QueryClientProvider client={queryClient()}>
          <HandedOverPublishersContext value={{ register, count: () => 0 }}>
            <CollectionScreen />
          </HandedOverPublishersContext>
        </QueryClientProvider>,
      );
      await act(async () => { await Promise.resolve(); });

      expect(register).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();

      await act(async () => { await view.unmount(); });

      expect(release).toHaveBeenCalledTimes(1);
    });

    test('a hand-over clears a failed fast path', async () => {
      // A render loop never returns from act(); turning React's loop warning into
      // a throw makes a self-re-triggering effect fail at once.
      const loopGuard = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).includes('Maximum update depth exceeded')) {
          throw new Error('the hand-over effect re-triggers itself');
        }
      });
      try {
        const OWN8 = 'file:///collection/8.jpg';
        const rows = [
          image(7, { downloadState: 'mirrored', localUri: null }),
          image(8, { downloadState: 'ready', localUri: OWN8 }),
        ];
        const { feed, getById } = setup(rows, () => [
          handedEntry(7),
          libraryEntry({
            plaintextSha256: viewDigest('s1b-handed-8'),
            sourceImageId: 8,
            residency: 'local-original',
            hasLocalOriginal: true,
            localOriginalUri: 'file:///data/library/originals/eight.jpg',
          }),
        ]);
        await render(
          <QueryClientProvider client={queryClient()}>
            <CollectionScreen />
          </QueryClientProvider>,
        );
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: U }));

        // The fast path fails: the resolver serves the row instead.
        await act(async () => { (screen.getByLabelText('图片 7').props.onError as () => void)(); });
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source)
          .not.toEqual({ uri: U }));

        // The hand-over verified the original again; the row's state is unchanged
        // (mirrored), so only the hand-over can offer the fast path afresh.
        await act(async () => {
          feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: handedDigest });
        });

        await waitFor(() => expect(getById).toHaveBeenCalledWith(7));
        await waitFor(() => expect(screen.getByLabelText('图片 7').props.source).toEqual({ uri: U }));
        expect(screen.getByLabelText('图片 8').props.source).toEqual({ uri: OWN8 });
      } finally {
        loopGuard.mockRestore();
      }
    });
  });

  /**
   * K7 ⑦: `refreshLibraryEntries` ran on mount, on EVERY focus, on
   * `dataRevision` and on pull-to-refresh, and always handed the grid a brand
   * new array — so three useMemos recomputed and every visible tile re-rendered
   * on a tab tap where not one pixel changed. K6-2b's change feed is the event
   * that actually means "the library moved".
   */
  describe('K7 ⑦ focus does not re-read the library', () => {
    function changeFeed() {
      const listeners = new Set<(change: { kind: string }) => void>();
      return {
        emit(change: { kind: string }) {
          for (const listener of [...listeners]) listener(change);
        },
        subscribe: jest.fn((listener: (change: { kind: string }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      };
    }

    const digest = viewDigest('k7-focus');

    function services(
      listEntries: jest.Mock,
      feed: ReturnType<typeof changeFeed> | null,
      dataRevision = 0,
    ) {
      return {
        collectionService: { resumePendingDownloads: jest.fn().mockResolvedValue([]) },
        dataRevision,
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([
            image(7, { localUri: 'file:///collection/7.jpg' }),
          ]),
        },
        settings: { blurNsfwThumbnails: true },
        librarySyncTrigger: null,
        libraryBackgroundSync: null,
        libraryView: {
          model: { listEntries },
          resolver: {
            resolve: jest.fn(async () => ({
              kind: 'file',
              uri: 'file:///cache/library/k7.jpg',
              tier: 'cached-thumbnail',
              role: 'thumbnail',
            })),
          },
        },
        libraryChanges: feed,
      };
    }

    function entry(overrides: Partial<LibraryEntry> = {}) {
      return libraryEntry({
        plaintextSha256: digest,
        sourceImageId: 7,
        protection: 'pending',
        hasLocalOriginal: true,
        residency: 'local-original',
        originalGenerationId: null,
        ...overrides,
      });
    }

    test('mounting reads the library once; a later focus reads nothing more', async () => {
      const listEntries = jest.fn(async () => [entry()]);
      mockAppServices = services(listEntries, changeFeed());

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));

      // The user leaves for another tab and comes back. Nothing changed.
      await act(async () => { refocus(); });
      await act(async () => { refocus(); });

      expect(listEntries).toHaveBeenCalledTimes(1);
    });

    test('K6-2b preserved: a `protected` change still re-reads and repaints', async () => {
      let protection: LibraryEntry['protection'] = 'pending';
      const listEntries = jest.fn(async () => [entry({
        protection,
        originalGenerationId: protection === 'protected' ? 'gen-1' : null,
      })]);
      const feed = changeFeed();
      mockAppServices = services(listEntries, feed);

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));

      protection = 'protected';
      await act(async () => { feed.emit({ kind: 'protected' }); });

      await waitFor(() => expect(
        screen.getByLabelText(/收藏图片 7.*已同步到云端/),
      ).toBeOnTheScreen());
      expect(listEntries).toHaveBeenCalledTimes(2);
    });

    test('two reads with identical content keep the same grid data reference', async () => {
      // Every read builds fresh row objects, exactly like a real SQLite read.
      const listEntries = jest.fn(async () => [entry()]);
      const feed = changeFeed();
      mockAppServices = services(listEntries, feed);

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));
      const dataAfterFirstRead = mockGridData.at(-1);

      // A change arrives, the read runs, and it returns the same library.
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));

      // Same content ⇒ same reference ⇒ no useMemo recompute, no grid churn.
      expect(mockGridData.at(-1)).toBe(dataAfterFirstRead);
    });

    test('a real content change does replace the reference', async () => {
      let protection: LibraryEntry['protection'] = 'pending';
      const listEntries = jest.fn(async () => [entry({ protection })]);
      const feed = changeFeed();
      mockAppServices = services(listEntries, feed);

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));
      const before = mockGridData.at(-1);

      protection = 'protected';
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));

      expect(mockGridData.at(-1)).not.toBe(before);
    });

    test('a re-read that changes only localOriginalUri replaces the reference', async () => {
      let localOriginalUri = 'file:///data/user/10/app.waifudeck.mobile/files/library/originals/a.jpg';
      const listEntries = jest.fn(async () => [entry({ localOriginalUri })]);
      const feed = changeFeed();
      mockAppServices = services(listEntries, feed);

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));
      const before = mockGridData.at(-1);

      localOriginalUri = 'file:///data/library/originals/a.jpg';
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));

      expect(mockGridData.at(-1)).not.toBe(before);
    });

    test('the dataRevision cold path still re-reads', async () => {
      const listEntries = jest.fn(async () => [entry()]);
      mockAppServices = services(listEntries, changeFeed());

      const view = await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));

      mockAppServices = { ...mockAppServices, dataRevision: 1 };
      await view.rerender(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
    });

    test('pull-to-refresh still re-reads', async () => {
      const listEntries = jest.fn(async () => [entry()]);
      mockAppServices = services(listEntries, changeFeed());

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText(/收藏图片 7/)).toBeOnTheScreen();
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));

      await act(async () => {
        screen.getByTestId('collection-list').props.onRefresh();
      });

      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
    });
  });

  describe('N6-B1: unified collection screen, mixed sorts, 来源「我的导入」, mode filtering, and mixed selection deletion', () => {
    const safeImpDigest = viewDigest('n6b1-safe-imp');
    const adultImpDigest = viewDigest('n6b1-adult-imp');
    const resolveThumb = jest.fn(async (digest: string): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: `file:///cache/library/${digest}.jpg`,
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    }));

    function ownFrames() {
      const frames: FrameRequestCallback[] = [];
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      const runFrames = async () => {
        await act(async () => {
          for (const frame of frames.splice(0)) frame(0);
        });
      };
      return { rafSpy, runFrames };
    }

    test('sameLibraryEntries detects changes in origin, importClassification, importDeletedAt, hasImportMembership, format, byteSize, width, height, and createdAt', () => {
      const base = libraryEntry({
        plaintextSha256: safeImpDigest,
        origin: 'import',
        importClassification: 'safe',
        importDeletedAt: null,
        hasImportMembership: true,
        format: 'jpeg',
        byteSize: 420_000,
        width: 1200,
        height: 1600,
        createdAt: 1_000,
      });
      expect(sameLibraryEntries([base], [{ ...base }])).toBe(true);
      expect(sameLibraryEntries([base], [{ ...base, origin: 'provider' }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, importClassification: 'adult' }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, importDeletedAt: 500 }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, hasImportMembership: false }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, format: 'png' }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, byteSize: 420_001 }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, width: 1201 }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, height: 1601 }])).toBe(false);
      expect(sameLibraryEntries([base], [{ ...base, createdAt: 1_001 }])).toBe(false);
    });

    test('source sheet offers 我的导入 with count, filters to imports only, and keeps 我的导入 at 0 when non-empty search hides imports', async () => {
      const { rafSpy, runFrames } = ownFrames();
      try {
        await render(readyView([
          image(1, { providerKey: 'danbooru', artistName: 'Mika', decidedAt: 200 }),
        ], {
          libraryOverlay: {
            entries: [
              libraryEntry({
                plaintextSha256: safeImpDigest,
                origin: 'import',
                importClassification: 'safe',
                hasImportMembership: true,
                createdAt: 300,
              }),
              libraryEntry({
                plaintextSha256: adultImpDigest,
                origin: 'import',
                importClassification: 'adult',
                hasImportMembership: true,
                createdAt: 100,
              }),
            ],
            resolve: resolveThumb,
          },
        }));
        await runFrames();

        expect(screen.getByTestId('collection-count-value-3')).toBeOnTheScreen();

        // Open source sheet -> shows 全部来源 (3), 我的导入 (2), Danbooru (1)
        await fireEvent.press(screen.getByRole('button', { name: '来源：全部' }));
        const importsOpt = screen.getByRole('button', { name: '我的导入' });
        expect(importsOpt.props.accessibilityValue).toEqual({ text: '2 张' });

        // Select 我的导入 -> hides Danbooru image 1, shows 2 import tiles, chip label reads 来源：我的导入
        await fireEvent.press(importsOpt);
        expect(screen.getByRole('button', { name: '来源：我的导入' })).toBeOnTheScreen();
        expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();
        expect(screen.queryByTestId('collection-tile-1')).toBeNull();
        expect(screen.getByTestId(`library-asset-tile-${safeImpDigest}`)).toBeOnTheScreen();
        expect(screen.getByTestId(`library-asset-tile-${adultImpDigest}`)).toBeOnTheScreen();

        // Enter non-empty search while 我的导入 is selected -> hides imports, count=0, but 我的导入 remains in source sheet at 0 张
        await fireEvent.changeText(screen.getByTestId('collection-search'), 'Mika');
        expect(screen.getByText('没有匹配的收藏')).toBeOnTheScreen();
        await fireEvent.press(screen.getByRole('button', { name: '来源：我的导入' }));
        expect(screen.getByRole('button', { name: '我的导入' }).props.accessibilityValue).toEqual({
          text: '0 张',
        });
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('mixed selection selects both provider saves and imports, confirms combined count, and dispatches both delete ports', async () => {
      const { rafSpy, runFrames } = ownFrames();
      const onDelete = jest.fn().mockResolvedValue(undefined);
      const onDeleteImports = jest.fn().mockResolvedValue(undefined);
      const alert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.find((button) => button.style === 'destructive')?.onPress?.();
      });

      try {
        await render(readyView([
          image(1, { decidedAt: 200 }),
        ], {
          onDelete,
          onDeleteImports,
          libraryOverlay: {
            entries: [
              libraryEntry({
                plaintextSha256: safeImpDigest,
                origin: 'import',
                importClassification: 'safe',
                hasImportMembership: true,
                createdAt: 300,
              }),
            ],
            resolve: resolveThumb,
          },
        }));
        await runFrames();

        // Long-press the import tile to enter selection mode, then tap the provider tile:
        const importTile = screen.getByTestId(`library-asset-tile-${safeImpDigest}`);
        await fireEvent(importTile, 'longPress');
        expect(screen.getByText('已选择 1 项')).toBeOnTheScreen();

        await fireEvent.press(screen.getByTestId('collection-tile-1'));
        expect(screen.getByText('已选择 2 项')).toBeOnTheScreen();

        await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));
        expect(alert).toHaveBeenCalledWith(
          '删除 2 张图片？',
          expect.stringContaining('永久移除'),
          expect.any(Array),
        );
        await waitFor(() => {
          expect(onDelete).toHaveBeenCalledWith([1]);
          expect(onDeleteImports).toHaveBeenCalledWith([safeImpDigest]);
        });
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('CollectionScreen wires libraryController.purgeImportedAsset for import deletion and refreshes library entries', async () => {
      const { rafSpy, runFrames } = ownFrames();
      const purgeImportedAsset = jest.fn().mockResolvedValue(undefined);
      let entries = [
        libraryEntry({
          plaintextSha256: safeImpDigest,
          origin: 'import',
          importClassification: 'safe',
          hasImportMembership: true,
          createdAt: 300,
        }),
      ];
      const listEntries = jest.fn(async () => entries);
      jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        entries = [];
        buttons?.find((button) => button.style === 'destructive')?.onPress?.();
      });

      mockAppServices = {
        collectionService: {
          resumePendingDownloads: jest.fn().mockResolvedValue([]),
          deleteSaved: jest.fn().mockResolvedValue(image(1)),
        },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([image(1)]) },
        settings: { blurNsfwThumbnails: true },
        libraryController: { purgeImportedAsset },
        libraryView: {
          model: { listEntries },
          resolver: { resolve: resolveThumb },
        },
      };

      try {
        await render(
          <QueryClientProvider client={queryClient()}>
            <CollectionScreen />
          </QueryClientProvider>,
        );

        const impTile = await screen.findByTestId(`library-asset-tile-${safeImpDigest}`);
        await runFrames();
        await fireEvent(impTile, 'longPress');
        await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));

        await waitFor(() => expect(purgeImportedAsset).toHaveBeenCalledWith(safeImpDigest));
        await waitFor(() => expect(screen.queryByTestId(`library-asset-tile-${safeImpDigest}`)).toBeNull());
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('deleteSelectedImports waits for all purges before rejecting on partial failure', async () => {
      const purge = jest.fn((sha: string) =>
        sha === 'bad' ? Promise.reject(new Error('purge failed')) : Promise.resolve(),
      );
      await expect(deleteSelectedImports(purge, ['good', 'bad'])).rejects.toThrow('purge failed');
      expect(purge).toHaveBeenCalledTimes(2);
    });

    test('local-original import tile uses fastPathUri directly with 0 grid resolves until fast-path fails, and a 500-item cloud-only mixed grid caps initial mount resolves at <= 25 with 0 detail/full resolves', async () => {
      const { rafSpy, runFrames } = ownFrames();
      const resolveSpy = jest.fn(async (digest: string, _intent?: string): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: `file:///cache/library/${digest}.jpg`,
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      }));

      try {
        // 1. Local-original import tile: hasLocalOriginal=true + localOriginalUri set -> 0 resolves on mount
        const localImp = libraryEntry({
          plaintextSha256: safeImpDigest,
          origin: 'import',
          importClassification: 'safe',
          hasImportMembership: true,
          residency: 'local-original',
          hasLocalOriginal: true,
          localOriginalUri: `file:///data/library/originals/${safeImpDigest}.jpg`,
          createdAt: 500,
        });

        const view = await render(readyView([], {
          libraryOverlay: {
            entries: [localImp],
            resolve: resolveSpy,
          },
        }));
        expect(screen.getByTestId(`library-asset-tile-${safeImpDigest}`)).toBeOnTheScreen();
        expect(resolveSpy).not.toHaveBeenCalled();

        // 2. 500-item mixed grid (400 mirrored cloud-only provider rows + 100 cloud-only imports):
        // rerendering with the 500-item overlay schedules <= 25 'grid' resolves and 0 'detail' / 'full' resolves.
        resolveSpy.mockClear();
        const manyImages = Array.from({ length: 400 }, (_, i) =>
          image(i + 1, {
            localUri: null,
            downloadState: 'mirrored',
            decidedAt: 10_000 - i,
          }),
        );
        const manyEntries: LibraryEntry[] = [
          ...manyImages.map((img, i) =>
            libraryEntry({
              plaintextSha256: (i + 1).toString(16).padStart(64, 'b'),
              sourceImageId: img.id,
              associatedProviderImageIds: [img.id],
              origin: 'provider',
              importClassification: 'unknown',
              hasImportMembership: false,
              residency: 'cloud-only',
              hasLocalOriginal: false,
              localOriginalUri: null,
              createdAt: 10_000 - i,
            }),
          ),
          ...Array.from({ length: 100 }, (_, i) =>
            libraryEntry({
              plaintextSha256: (i + 1).toString(16).padStart(64, 'c'),
              sourceImageId: null,
              origin: 'import',
              importClassification: i % 2 === 0 ? 'safe' : 'adult',
              hasImportMembership: true,
              residency: 'cloud-only',
              hasLocalOriginal: false,
              localOriginalUri: null,
              createdAt: 20_000 - i,
            }),
          ),
        ];

        await view.rerender(readyView(manyImages, {
          libraryOverlay: {
            entries: manyEntries,
            resolve: resolveSpy,
          },
        }));
        await act(async () => { await Promise.resolve(); });
        await runFrames();

        const gridCalls = resolveSpy.mock.calls.filter(([, intent]) => intent === 'grid');
        const nonGridCalls = resolveSpy.mock.calls.filter(([, intent]) => intent !== 'grid');
        expect(gridCalls.length).toBeGreaterThan(0);
        expect(gridCalls.length).toBeLessThanOrEqual(25);
        expect(nonGridCalls).toHaveLength(0);
      } finally {
        rafSpy.mockRestore();
      }
    });

    test('two-member shared digest renders both the provider tile and the import tile on the fast path, and deleting either member leaves the other member visible with usable local bytes', async () => {
      const sharedDigest = viewDigest('two-member-shared-grid');
      const sharedOriginalUri = `file:///data/library/originals/${sharedDigest}.jpg`;
      const resolveSpy = jest.fn(async (digest: string): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: `file:///cache/library/${digest}.jpg`,
        tier: 'cached-thumbnail',
        role: 'thumbnail',
      }));
      const onDelete = jest.fn().mockResolvedValue(undefined);
      const onDeleteImports = jest.fn().mockResolvedValue(undefined);
      jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.find((button) => button.style === 'destructive')?.onPress?.();
      });

      const sharedEntry = (hasImportMembership: boolean) =>
        libraryEntry({
          plaintextSha256: sharedDigest,
          sourceImageId: 42,
          associatedProviderImageIds: [42],
          origin: 'import',
          importClassification: 'safe',
          importDeletedAt: hasImportMembership ? null : 999,
          hasImportMembership,
          residency: 'local-original',
          hasLocalOriginal: true,
          localOriginalUri: sharedOriginalUri,
          createdAt: 400,
        });

      const mirroredProvider = image(42, {
        localUri: null,
        downloadState: 'mirrored',
        isNsfw: true,
        contentRating: 'explicit',
        decidedAt: 300,
      });

      const view = await render(readyView([mirroredProvider], {
        allowsAdultContent: true,
        onDelete,
        onDeleteImports,
        libraryOverlay: {
          entries: [sharedEntry(true)],
          resolve: resolveSpy,
        },
      }));

      // Both tiles render in the grid (total count = 2, SFW = 1 from safe import, NSFW = 1 from explicit provider),
      // and both use the shared localOriginalUri fast-path with 0 resolver calls:
      expect(screen.getByTestId('collection-count-value-2')).toBeOnTheScreen();
      expect(screen.getByTestId('collection-tile-42')).toBeOnTheScreen();
      expect(screen.getByTestId(`library-asset-tile-${sharedDigest}`)).toBeOnTheScreen();
      expect(resolveSpy).not.toHaveBeenCalled();

      // Delete only the import member -> dispatches onDeleteImports([sharedDigest]) and NOT onDelete;
      // after re-render with importDeletedAt set, the provider tile remains visible on the same fast-path:
      await fireEvent(screen.getByTestId(`library-asset-tile-${sharedDigest}`), 'longPress');
      await fireEvent.press(screen.getByRole('button', { name: '删除所选图片' }));
      await waitFor(() => expect(onDeleteImports).toHaveBeenCalledWith([sharedDigest]));
      expect(onDelete).not.toHaveBeenCalled();

      await view.rerender(readyView([mirroredProvider], {
        allowsAdultContent: true,
        onDelete,
        onDeleteImports,
        libraryOverlay: {
          entries: [sharedEntry(false)],
          resolve: resolveSpy,
        },
      }));
      expect(screen.getByTestId('collection-count-value-1')).toBeOnTheScreen();
      expect(screen.getByTestId('collection-tile-42')).toBeOnTheScreen();
      expect(screen.queryByTestId(`library-asset-tile-${sharedDigest}`)).toBeNull();
      expect(resolveSpy).not.toHaveBeenCalled();
    });
  });

  describe('N6-B2: collection header import entry, classification sheet, progress/result feedback, and tab-blur dismissal', () => {
    function createImportSessionFixture() {
      let pickResolver: ((items: readonly { uri: string }[]) => void) | null = null;
      let confirmResolver: ((summary: any) => void) | null = null;
      const deletedUris: string[] = [];
      const picker = {
        pickImages: jest.fn(
          () =>
            new Promise<readonly { uri: string }[]>((resolve) => {
              pickResolver = resolve;
            }),
        ),
      };
      const files = {
        deleteOriginal: jest.fn(async (uri: string) => {
          deletedUris.push(uri);
        }),
        deletePickerCacheUri: jest.fn(async (uri: string) => {
          deletedUris.push(uri);
        }),
        listPickerCache: jest.fn(async () => []),
      };
      const importService = {
        importConfirmedFiles: jest.fn(
          (input: any) =>
            new Promise<any>((resolve) => {
              confirmResolver = (summary) => {
                resolve(summary);
              };
              input.onProgress?.({ completed: 0, total: input.uris.length });
            }),
        ),
        settled: jest.fn(async () => undefined),
      };
      const session: LibraryImportSessionController = createLibraryImportSessionController({
        picker,
        files,
        importService,
      });
      return {
        session,
        picker,
        files,
        importService,
        deletedUris,
        resolvePick(items: readonly { uri: string }[]) {
          pickResolver?.(items);
        },
        resolveConfirm(summary: any) {
          confirmResolver?.(summary);
        },
      };
    }

    test('renders collection-import-entry immediately before collection-trash-entry in populated, empty, and filtered-empty states, and hides it in selection mode', async () => {
      const { session } = createImportSessionFixture();
      const onOpenTrash = jest.fn();

      // 1. True empty collection state
      const view = await render(readyView([], {
        importSession: session,
        onOpenTrash,
      }));
      expect(screen.getByTestId('collection-import-entry')).toBeOnTheScreen();
      expect(screen.getByTestId('collection-trash-entry')).toBeOnTheScreen();

      // 2. Populated collection state + filtered-empty state + selection mode
      await view.rerender(readyView([image(1, { isNsfw: false, contentRating: 'safe' })], {
        importSession: session,
        onOpenTrash,
      }));
      const importBtn = screen.getByTestId('collection-import-entry');
      expect(importBtn).toHaveProp('accessibilityState', { disabled: false, busy: false });
      expect(screen.getByTestId('collection-trash-entry')).toBeOnTheScreen();

      // Filtered empty (search with 0 matches) still keeps the header import entry
      await fireEvent.changeText(screen.getByTestId('collection-search'), 'no-such-tag');
      expect(screen.getByTestId('collection-import-entry')).toBeOnTheScreen();
      await fireEvent.changeText(screen.getByTestId('collection-search'), '');

      // Entering selection mode hides collection-import-entry
      await fireEvent(screen.getByTestId('collection-tile-1'), 'longPress');
      expect(screen.queryByTestId('collection-import-entry')).toBeNull();
    });

    test('drives idle -> picking -> awaiting-choice (with (a) constraint) -> importing progress -> formatted result + notes across tab blur', async () => {
      const fx = createImportSessionFixture();
      mockAppServices = {
        ...collectionMockServices(),
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([image(1)]),
        },
        libraryController: {
          importSession: fx.session,
        },
      };

      await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );

      const entry = await screen.findByTestId('collection-import-entry');
      await fireEvent.press(entry);
      expect(fx.picker.pickImages).toHaveBeenCalledWith({ selectionLimit: 50 });
      expect(screen.getByTestId('collection-import-entry')).toHaveProp(
        'accessibilityState',
        { disabled: true, busy: true },
      );

      // Picker returns 3 files -> opens sheet with title + (a) constraint + 普通 / 成人 / 取消
      await act(async () => {
        fx.resolvePick([
          { uri: 'file:///cache/ImagePicker/a.jpg' },
          { uri: 'file:///cache/ImagePicker/b.jpg' },
          { uri: 'file:///cache/ImagePicker/c.jpg' },
        ]);
      });

      const sheet = screen.getByTestId('collection-import-sheet');
      expect(within(sheet).getByText('导入 3 张图片')).toBeOnTheScreen();
      expect(within(sheet).getByText('导入后不能改分类，请确认后再选。')).toBeOnTheScreen();
      expect(screen.getByTestId('collection-import-safe')).toBeOnTheScreen();
      expect(screen.getByTestId('collection-import-adult')).toBeOnTheScreen();
      expect(screen.getByTestId('collection-import-cancel')).toBeOnTheScreen();

      // Tap 普通 -> sheet closes, progress bar appears with 正在导入 0 / 3
      await fireEvent.press(screen.getByTestId('collection-import-safe'));
      expect(screen.queryByTestId('collection-import-sheet')).toBeNull();
      expect(screen.getByTestId('collection-import-progress')).toHaveTextContent(
        '正在导入 0 / 3',
      );

      // Batch completes with 1 added, 1 duplicate, 1 over-cap, 1 retained classification, 1 unsupported
      await act(async () => {
        fx.resolveConfirm({
          selected: 4,
          ingested: 1,
          duplicates: 1,
          notEnrolled: 0,
          retainedClassificationCount: 1,
          rejected: [
            { code: 'file_too_large' },
            { code: 'unsupported_format' },
          ],
        });
      });

      const resultBox = screen.getByTestId('collection-import-result');
      expect(within(resultBox).getByText('已添加 1 张 · 已存在 1 张 · 2 张没导入')).toBeOnTheScreen();
      expect(within(resultBox).getByText('1 张图片太大，没导入。')).toBeOnTheScreen();
      expect(within(resultBox).getByText('1 张沿用了原来的分类。')).toBeOnTheScreen();
      expect(within(resultBox).getByText('部分图片格式不支持，请选 JPEG、PNG、WebP 或 GIF。')).toBeOnTheScreen();

      // Leaving the Collection tab (tab blur) after presentation dismisses the result
      await act(async () => {
        blurFocus();
      });
      expect(screen.queryByTestId('collection-import-result')).toBeNull();
    });

    test('batch finishing while away from Collection tab retains unpresented result until user returns and presents it once, while an in-tab CollectionView remount does not dismiss it', async () => {
      const fx = createImportSessionFixture();
      mockAppServices = {
        ...collectionMockServices(),
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([image(1)]),
        },
        libraryController: {
          importSession: fx.session,
        },
      };

      const view = await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );

      await fireEvent.press(await screen.findByTestId('collection-import-entry'));
      await act(async () => {
        fx.resolvePick([{ uri: 'file:///cache/ImagePicker/away.jpg' }]);
      });
      await fireEvent.press(screen.getByTestId('collection-import-adult'));
      expect(screen.getByTestId('collection-import-progress')).toBeOnTheScreen();

      // User switches away from Collection while batch is still importing (unmount CollectionScreen)
      await act(async () => {
        await view.unmount();
      });
      expect(fx.session.getState().phase).toBe('importing');

      // Batch finishes while away -> result is retained with presented: false
      await act(async () => {
        fx.resolveConfirm({
          selected: 1,
          ingested: 1,
          duplicates: 0,
          notEnrolled: 0,
          retainedClassificationCount: 0,
          rejected: [],
        });
      });
      expect(fx.session.getState()).toEqual({
        phase: 'result',
        result: expect.objectContaining({
          addedCount: 1,
          presented: false,
        }),
      });

      // Returning to Collection presents the result once
      const returnedView = await render(
        <QueryClientProvider client={queryClient()}>
          <CollectionScreen />
        </QueryClientProvider>,
      );
      expect(await screen.findByTestId('collection-import-result')).toHaveTextContent('已添加 1 张');
      expect(fx.session.getState()).toEqual({
        phase: 'result',
        result: expect.objectContaining({
          addedCount: 1,
          presented: true,
        }),
      });

      // An in-tab CollectionView unmount/remount does NOT dismiss the result; only leaving the tab does
      const standaloneView = await render(readyView([image(1)], { importSession: fx.session }));
      await act(async () => {
        await standaloneView.unmount();
      });
      expect(fx.session.getState().phase).toBe('result');

      // Leaving CollectionScreen (tab blur / unmount) dismisses the presented result
      await act(async () => {
        await returnedView.unmount();
      });
      expect(fx.session.getState()).toEqual({ phase: 'idle' });
    });

    test('cancelling the classification sheet cleans picker cache files and shows no progress or result', async () => {
      const fx = createImportSessionFixture();
      await render(readyView([image(1)], { importSession: fx.session }));

      await fireEvent.press(screen.getByTestId('collection-import-entry'));
      await act(async () => {
        fx.resolvePick([{ uri: 'file:///cache/ImagePicker/cancel-me.jpg' }]);
      });
      expect(screen.getByTestId('collection-import-sheet')).toBeOnTheScreen();

      await fireEvent.press(screen.getByTestId('collection-import-cancel'));
      await waitFor(() => expect(screen.queryByTestId('collection-import-sheet')).toBeNull());
      expect(screen.queryByTestId('collection-import-progress')).toBeNull();
      expect(screen.queryByTestId('collection-import-result')).toBeNull();
      expect(fx.deletedUris).toEqual(['file:///cache/ImagePicker/cancel-me.jpg']);
    });
  });

  describe('N6-C: opening an import tile hands over its thumbnail seed and navigates to /image/import/[sha256]', () => {
    const impDigest = viewDigest('n6c-open-import');

    test('tapping a cloud-only import tile with a resolved thumbnail sets detail open seed and routes with current query', async () => {
      const thumbUri = `file:///doc/library/thumbnails/${impDigest}.webp`;
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: thumbUri,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      const listEntries = jest.fn().mockResolvedValue([
        libraryEntry({
          plaintextSha256: impDigest,
          sourceImageId: null,
          origin: 'import',
          importClassification: 'safe',
          hasImportMembership: true,
          residency: 'cloud-only',
          hasLocalOriginal: false,
          localOriginalUri: null,
          createdAt: 1_728_000_000_000,
        }),
      ]);
      mockAppServices = {
        ...collectionMockServices(),
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        libraryView: { model: { listEntries }, resolver: { resolve } },
      };

      const frames: FrameRequestCallback[] = [];
      const rafSpy = jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      try {
        setDetailOpenSeed(impDigest, null);
        await render(
          <QueryClientProvider client={queryClient()}>
            <CollectionScreen initialQuery={{ mode: 'sfw', provider: 'imports', sort: 'oldest' }} />
          </QueryClientProvider>,
        );
        const tile = await screen.findByTestId(`library-asset-tile-${impDigest}`);
        await waitFor(() => expect(resolve).toHaveBeenCalledWith(impDigest, 'grid'));
        await act(async () => {
          for (const frame of frames.splice(0)) frame(0);
        });

        await fireEvent.press(tile);

        expect(readDetailOpenSeed(impDigest)).toBe(thumbUri);
        expect(mockRouter.push).toHaveBeenCalledWith({
          pathname: '/image/import/[sha256]',
          params: {
            sha256: impDigest,
            mode: 'sfw',
            query: undefined,
            field: 'all',
            provider: 'imports',
            sort: 'oldest',
          },
        });
      } finally {
        rafSpy.mockRestore();
        setDetailOpenSeed(impDigest, null);
      }
    });

    test('tapping a local-original import tile on the fast path clears any stale seed for that digest', async () => {
      setDetailOpenSeed(impDigest, 'file:///doc/library/thumbnails/stale.webp');
      const onOpenImport = jest.fn();
      await render(readyView([], {
        onOpenImport,
        libraryOverlay: {
          entries: [
            libraryEntry({
              plaintextSha256: impDigest,
              sourceImageId: null,
              origin: 'import',
              importClassification: 'safe',
              hasImportMembership: true,
              residency: 'local-original',
              hasLocalOriginal: true,
              localOriginalUri: `file:///data/library/originals/${impDigest}.jpg`,
              createdAt: 1_728_000_000_000,
            }),
          ],
          resolve: jest.fn(),
        },
      }));

      await fireEvent.press(screen.getByTestId(`library-asset-tile-${impDigest}`));
      expect(readDetailOpenSeed(impDigest)).toBeNull();
      expect(onOpenImport).toHaveBeenCalledWith(impDigest, expect.objectContaining({
        provider: 'all',
        mode: 'mixed',
      }));
    });
  });
});
