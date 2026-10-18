/* eslint-disable @typescript-eslint/no-require-imports */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Profiler } from 'react';
import { createRoot } from 'test-renderer';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { collectionQueryKey } from '@/features/collection/collection-query';
import { CollectionServiceError } from '@/features/collection/file-repository';
import type { StoredImage } from '@/features/images/image-repository';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import type { LibraryEntry } from '@/features/library/library-view-model';
import { viewDigest } from '@/features/library/library-view-test-support';
import i18n from '@/i18n';
import { HandedOverPublishersContext } from '@/providers/handed-over-publishers';
import { setDetailOpenSeed } from '@/screens/image-detail/detail-open-seed';
import {
  formatImportHeaderDate,
  ImageDetailScreen,
  ImageDetailView,
  isValidImportSha256,
  parseDetailGalleryQuery,
} from '@/screens/image-detail/image-detail-screen';

const mockRouter = {
  back: jest.fn(),
  dismissTo: jest.fn(),
  replace: jest.fn(),
};
let mockAppServices: any;
// Row 51. The real GalleryImage mounts LayeredGalleryPage only when
// placeholderUri is passed. These count that mount, and the content under
// it, the way the rows 48–49 image mock counts <Image> mounts.
let layeredPageMounts = 0;
let galleryContentMounts = 0;

beforeEach(async () => {
  layeredPageMounts = 0;
  galleryContentMounts = 0;
  await i18n.changeLanguage('zh-Hans');
});

const z = (key: string) => String(i18n.getResource('zh-Hans', 'translation', key));

// Rows 48–49 resolve `placeholder` beside `detail`. The placeholder answer is
// not a detail/full/grid fetch. Counts that used to be the total `resolve`
// calls now exclude only `placeholder`, so an extra `full` or `grid` still fails.
function answeringPlaceholder(
  onOther: (digest: string, intent: string) => Promise<LibraryRenderSource>,
): (digest: string, intent: string) => Promise<LibraryRenderSource> {
  return (digest, intent) => (
    intent === 'placeholder'
      ? Promise.resolve({ kind: 'unavailable', category: 'object_missing' })
      : onOther(digest, intent)
  );
}

function callsBesidesPlaceholder(resolve: jest.Mock, digest?: string): unknown[][] {
  return resolve.mock.calls.filter(([calledDigest, intent]) => (
    intent !== 'placeholder' && (digest === undefined || calledDigest === digest)
  ));
}

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/providers/app-services', () => ({
  useAppServices: () => mockAppServices,
}));

jest.mock('@/screens/image-detail/gallery-image', () => {
  const actual = jest.requireActual('@/screens/image-detail/gallery-image');
  const { useEffect } = require('react');
  const { View, Text } = require('react-native');
  const GalleryImageInner = ({
    image,
    media: mediaProp,
    overrideSource,
    overridePending,
    onLocalFileMissing,
    onOverrideFailed,
    placeholderUri,
  }: {
      image?: StoredImage;
      media?: {
        id: number | string;
        dominantColor: string | null;
        localUri: string | null;
        remoteUrl: string | null;
      };
      overrideSource?: {
        kind: 'file' | 'unavailable';
        uri?: string;
        category?: string;
        role?: string;
      } | null;
      overridePending?: boolean;
      onLocalFileMissing?: (observedUri: string | null) => void;
      onOverrideFailed?: () => void;
      placeholderUri?: string | null;
    }) => {
      const target = mediaProp ?? image!;
      useEffect(() => {
        galleryContentMounts += 1;
      }, []);
      if (overridePending && !overrideSource) {
        return (
          <View
            testID={`gallery-image-loading-${target.id}`}
            placeholderUri={placeholderUri}
            overridePending={overridePending}
            // The non-layered pending box paints the row colour. A passed
            // placeholderUri is the layered page, and that box stays clear.
            {...(placeholderUri === undefined
              ? { style: { backgroundColor: target.dominantColor ?? '#111111' } }
              : {})}
          />
        );
      }
      if (overrideSource?.kind === 'unavailable') {
        const kind = overrideSource.category === 'offline'
          ? 'offline'
          : overrideSource.category === 'auth_attention' ? 'locked' : 'unavailable';
        return (
          <View
            accessibilityLabel={`图片查看器 ${target.id}`}
            accessibilityLiveRegion="polite"
            placeholderUri={placeholderUri}>
            <Text testID={`gallery-image-${kind}-${target.id}`}>
              {kind === 'offline'
                ? '离线不可用'
                : kind === 'locked' ? '解锁云同步后可查看' : '此图片未能通过校验，未予显示。'}
            </Text>
          </View>
        );
      }
      const uri = overrideSource?.kind === 'file'
        ? overrideSource.uri
        : (target.localUri ?? target.remoteUrl);
      return (
        <View
          accessibilityLabel={`全屏图片 ${target.id}`}
          testID={overrideSource?.kind === 'file'
            ? `gallery-image-override-loaded-${target.id}`
            : undefined}
          source={{ uri }}
          // The screen decides the override's role; board #16 cuts a too-large
          // gif to a still only for an `original`, so the tests can read it here.
          overrideRole={overrideSource?.kind === 'file' ? overrideSource.role : undefined}
          placeholderUri={placeholderUri}
          // The real page names the local file it failed to load; a file
          // override is the resolver's, reported through onOverrideFailed.
          onError={overrideSource?.kind === 'file'
            ? () => onOverrideFailed?.()
            : () => onLocalFileMissing?.(target.localUri)}
        />
      );
    };
  // Same branch as GalleryImage: anything but an absent placeholderUri is the
  // layered page. A second mount means the screen swapped trees.
  const LayeredGalleryPage = (props: Parameters<typeof GalleryImageInner>[0]) => {
    useEffect(() => {
      layeredPageMounts += 1;
    }, []);
    return <GalleryImageInner {...props} />;
  };
  return {
    ...actual,
    GalleryImage: (props: { libraryAccess?: string } & Record<string, unknown>) => {
      const inner = props as Parameters<typeof GalleryImageInner>[0];
      return (
        <>
          <View testID={`gallery-access-${props.libraryAccess ?? 'none'}`} />
          {inner.placeholderUri !== undefined
            ? <LayeredGalleryPage {...inner} />
            : <GalleryImageInner {...inner} />}
        </>
      );
    },
  };
});

jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return {
    Download: Icon,
    ExternalLink: Icon,
    Images: Icon,
    Layers3: Icon,
    RotateCcw: Icon,
    Search: Icon,
    Share2: Icon,
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
    localUri: `file:///collection/${id}.jpg`,
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

function view(
  current: StoredImage,
  overrides: Partial<React.ComponentProps<typeof ImageDetailView>> = {},
) {
  return (
    <ImageDetailView
      images={[current]}
      initialImageId={current.id}
      status="ready"
      errorMessage={null}
      onClose={jest.fn()}
      onShare={jest.fn().mockResolvedValue(undefined)}
      onExport={jest.fn().mockResolvedValue(undefined)}
      onRetry={jest.fn().mockResolvedValue(undefined)}
      onDelete={jest.fn().mockResolvedValue(undefined)}
      onReturnToDiscovery={jest.fn().mockResolvedValue(undefined)}
      onLocalFileMissing={jest.fn()}
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

describe('ImageDetailView', () => {
  test('a mounted offline detail re-resolves with the rebound resolver', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = detailEntry({
      plaintextSha256: viewDigest('recovery-detail'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const localResolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///thumb.webp',
      tier: 'local-thumbnail',
      role: 'thumbnail',
    }));
    const cloudResolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///preview.webp',
      tier: 'cached-preview',
      role: 'preview',
    }));
    const rendered = await render(view(row, {
      libraryOverlay: { entries: [entry], access: 'offline', resolve: localResolve },
    }));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///thumb.webp',
    }));
    await rendered.rerender(view(row, {
      libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: cloudResolve },
    }));
    await waitFor(() => expect(cloudResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'detail'));
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///preview.webp',
    });
  });

  test('a resolver change keeps the open page until the new detail answer settles', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = detailEntry({
      plaintextSha256: viewDigest('recovery-detail-kept'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const kept = 'file:///offline-preview.webp';
    const keptPlaceholder = 'file:///offline-placeholder.webp';
    const next = 'file:///cloud-preview.webp';
    const file = (uri: string, role: 'preview' | 'thumbnail'): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: role === 'preview' ? 'cached-preview' : 'local-thumbnail',
      role,
    });
    const localResolve = jest.fn(async (_digest: string, intent: string) => (
      intent === 'placeholder' ? file(keptPlaceholder, 'thumbnail') : file(kept, 'preview')
    ));
    let finishDetail!: (source: LibraryRenderSource) => void;
    const cloudResolve = jest.fn((_digest: string, intent: string) => (
      intent === 'detail'
        ? new Promise<LibraryRenderSource>((done) => {
          finishDetail = done;
        })
        : new Promise<LibraryRenderSource>(() => undefined)
    ));
    const rendered = await render(view(row, {
      libraryOverlay: { entries: [entry], access: 'offline', resolve: localResolve },
    }));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: kept,
    }));
    expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).toBe(keptPlaceholder);

    await rendered.rerender(view(row, {
      libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: cloudResolve },
    }));

    expect(screen.queryByTestId('gallery-image-loading-7')).toBeNull();
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: kept });
    expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).toBe(keptPlaceholder);
    await act(async () => {
      finishDetail(file(next, 'preview'));
    });
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: next,
    }));
    expect(screen.queryByTestId('gallery-image-loading-7')).toBeNull();
  });

  test('a late answer from the previous resolver never publishes', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = detailEntry({
      plaintextSha256: viewDigest('recovery-detail-late'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const kept = 'file:///kept-preview.webp';
    const stale = 'file:///stale-placeholder.webp';
    const file = (uri: string, role: 'preview' | 'thumbnail'): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: role === 'preview' ? 'cached-preview' : 'local-thumbnail',
      role,
    });
    let finishPlaceholder!: (source: LibraryRenderSource) => void;
    const localResolve = jest.fn((_digest: string, intent: string) => (
      intent === 'placeholder'
        ? new Promise<LibraryRenderSource>((done) => {
          finishPlaceholder = done;
        })
        : Promise.resolve(file(kept, 'preview'))
    ));
    const cloudResolve = jest.fn(() => new Promise<LibraryRenderSource>(() => undefined));
    const rendered = await render(view(row, {
      libraryOverlay: { entries: [entry], access: 'offline', resolve: localResolve },
    }));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: kept,
    }));
    await waitFor(() => expect(localResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'placeholder'));

    await rendered.rerender(view(row, {
      libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: cloudResolve },
    }));
    await act(async () => {
      finishPlaceholder(file(stale, 'thumbnail'));
    });

    expect(screen.queryByTestId('gallery-image-loading-7')).toBeNull();
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: kept });
    expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).not.toBe(stale);
  });

  test('an old detail answer never publishes after the resolver changes', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = detailEntry({
      plaintextSha256: viewDigest('recovery-detail-old-answer'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const file = (uri: string): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: 'cached-preview',
      role: 'preview',
    });
    let finishOld!: (source: LibraryRenderSource) => void;
    let finishNew!: (source: LibraryRenderSource) => void;
    const oldResolve = jest.fn((_digest: string, intent: string) => (
      intent === 'detail'
        ? new Promise<LibraryRenderSource>((done) => {
          finishOld = done;
        })
        : Promise.resolve(file('file:///placeholder.webp'))
    ));
    const newResolve = jest.fn((_digest: string, intent: string) => (
      intent === 'detail'
        ? new Promise<LibraryRenderSource>((done) => {
          finishNew = done;
        })
        : Promise.resolve(file('file:///placeholder.webp'))
    ));
    const rendered = await render(view(row, {
      libraryOverlay: { entries: [entry], access: 'offline', resolve: oldResolve },
    }));
    await waitFor(() => expect(oldResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'detail'));
    await rendered.rerender(view(row, {
      libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: newResolve },
    }));
    await waitFor(() => expect(newResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'detail'));
    await act(async () => {
      finishOld(file('file:///old-detail.webp'));
    });
    expect(screen.queryByLabelText('全屏图片 7')?.props.source).not.toEqual({
      uri: 'file:///old-detail.webp',
    });
    await act(async () => {
      finishNew(file('file:///new-detail.webp'));
    });
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///new-detail.webp',
    });
  });

  test('an old full answer cannot replace the rebound detail answer', async () => {
    const row = image(7, { downloadState: 'mirrored', localUri: null });
    const entry = detailEntry({
      plaintextSha256: viewDigest('recovery-old-full'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const file = (
      uri: string,
      role: 'preview' | 'original' | 'thumbnail',
    ): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: role === 'original' ? 'local-original' : role === 'thumbnail' ? 'local-thumbnail' : 'cached-preview',
      role,
    });
    let finishFull!: (source: LibraryRenderSource) => void;
    const oldResolve = jest.fn((_digest: string, intent: string) => (
      intent === 'full'
        ? new Promise<LibraryRenderSource>((done) => {
          finishFull = done;
        })
        : Promise.resolve(file('file:///old-thumb.webp', 'thumbnail'))
    ));
    const next = file('file:///new-preview.webp', 'preview');
    const newResolve = jest.fn(async () => next);
    const onShare = jest.fn(async () => undefined);
    const rendered = await render(view(row, {
      onShare,
      libraryOverlay: { entries: [entry], access: 'offline', resolve: oldResolve },
    }));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///old-thumb.webp',
    }));
    await fireEvent.press(screen.getByRole('button', { name: '分享图片' }));
    await waitFor(() => expect(oldResolve).toHaveBeenCalledWith(entry.plaintextSha256, 'full'));
    await rendered.rerender(view(row, {
      onShare,
      libraryOverlay: { entries: [{ ...entry }], access: 'ready', resolve: newResolve },
    }));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///new-preview.webp',
    }));
    await act(async () => {
      finishFull(file('file:///old-original.jpg', 'original'));
    });
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///new-preview.webp',
    });
    expect(screen.queryByRole('button', { name: '修复离线文件' })).toBeNull();
  });

  test('a neighbour placeholder is resolved again when the resolver changes', async () => {
    const current = image(7, { downloadState: 'mirrored', localUri: null });
    const neighbour = image(8, { downloadState: 'mirrored', localUri: null });
    const currentEntry = detailEntry({
      plaintextSha256: viewDigest('recovery-placeholder-current'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const neighbourEntry = detailEntry({
      plaintextSha256: viewDigest('recovery-placeholder-neighbour'),
      sourceImageId: 8,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    const oldPlaceholder = 'file:///neighbour-old.webp';
    const nextPlaceholder = 'file:///neighbour-new.webp';
    const file = (uri: string, role: 'preview' | 'thumbnail'): LibraryRenderSource => ({
      kind: 'file',
      uri,
      tier: role === 'preview' ? 'cached-preview' : 'local-thumbnail',
      role,
    });
    const localResolve = jest.fn(async (_digest: string, intent: string) => (
      intent === 'placeholder'
        ? file(oldPlaceholder, 'thumbnail')
        : file('file:///preview.webp', 'preview')
    ));
    let finishNeighbour!: (source: LibraryRenderSource) => void;
    const cloudResolve = jest.fn((digest: string, intent: string) => {
      if (intent === 'placeholder' && digest === neighbourEntry.plaintextSha256) {
        return new Promise<LibraryRenderSource>((done) => {
          finishNeighbour = done;
        });
      }
      return Promise.resolve(
        intent === 'placeholder'
          ? file('file:///current-new.webp', 'thumbnail')
          : file('file:///preview-new.webp', 'preview'),
      );
    });
    const overlay = (
      resolve: typeof localResolve | typeof cloudResolve,
      access: 'offline' | 'ready',
    ) => view(current, {
      images: [current, neighbour],
      libraryOverlay: {
        entries: [{ ...currentEntry }, { ...neighbourEntry }],
        access,
        resolve,
      },
    });
    const rendered = await render(overlay(localResolve, 'offline'));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 8').props.placeholderUri)
      .toBe(oldPlaceholder));

    await rendered.rerender(overlay(cloudResolve, 'ready'));

    expect(screen.getByLabelText('全屏图片 8').props.placeholderUri).toBe(oldPlaceholder);
    await waitFor(() => expect(cloudResolve).toHaveBeenCalledWith(
      neighbourEntry.plaintextSha256,
      'placeholder',
    ));
    expect(screen.getByLabelText('全屏图片 8').props.placeholderUri).toBe(oldPlaceholder);
    await act(async () => {
      finishNeighbour(file(nextPlaceholder, 'thumbnail'));
    });
    await waitFor(() => expect(screen.getByLabelText('全屏图片 8').props.placeholderUri)
      .toBe(nextPlaceholder));
  });

  test('ready images render the local URI', async () => {
    await render(view(image(7)));

    expect(screen.getByTestId('screen-image-detail')).toBeOnTheScreen();
    expect(screen.getByTestId('detail-close')).toBeOnTheScreen();
    expect(screen.getByTestId('detail-counter')).toHaveTextContent(/1\/1$/);
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///collection/7.jpg',
    });
  });

  test('renders a horizontal pager with adjacent images preloaded', async () => {
    const current = image(7);
    await render(view(current, { images: [current, image(8)] }));
    const pager = screen.getByTestId('detail-pager');

    expect(screen.getByTestId('detail-position-1-of-2')).toBeOnTheScreen();
    expect(pager.props.horizontal).toBe(true);
    expect(pager.props.pagingEnabled).toBe(true);
    expect(pager.props.initialScrollIndex).toBe(0);
    expect(pager.props.windowSize).toBe(3);
    expect(pager.props.scrollEnabled).toBe(true);
  });

  test('keeps the pager mounted as collection membership changes and tracks the settled page', async () => {
    const first = image(7);
    const second = image(8);
    const third = image(9);
    const rendered = await render(view(first, { images: [first, second] }));
    const pager = screen.getByTestId('detail-pager');

    await rendered.rerender(view(first, { images: [first, second, third] }));

    const updatedPager = screen.getByTestId('detail-pager');
    expect(updatedPager).toBe(pager);

    await act(async () => {
      updatedPager.props.onMomentumScrollEnd({
        nativeEvent: {
          contentOffset: { x: updatedPager.props.snapToInterval, y: 0 },
        },
      });
    });

    expect(screen.getByText('Artist 8')).toBeOnTheScreen();
    expect(screen.getByText(/2\/3/)).toBeOnTheScreen();
    expect(screen.getByTestId('detail-position-2-of-3')).toBeOnTheScreen();
  });

  test('keeps the original image inside its media band and labels gallery commands', async () => {
    await render(view(image(7)));

    expect(screen.getByLabelText('全屏图片 7').parent).toHaveStyle({
      flex: 1,
    });
    expect(screen.getByLabelText('图片顶部操作')).not.toHaveStyle({
      position: 'absolute',
    });
    expect(screen.getByLabelText('图片信息和操作')).not.toHaveStyle({
      position: 'absolute',
    });
    for (const label of ['分享', '导出', '来源', '删除', '退回']) {
      expect(screen.getByText(label)).toBeOnTheScreen();
    }
  });

  test('updates visible gallery commands immediately when the language changes', async () => {
    await render(view(image(7)));

    expect(screen.getByText('分享')).toBeOnTheScreen();

    await act(async () => i18n.changeLanguage('en'));

    expect(screen.getByText('Share')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Delete image' })).toBeOnTheScreen();

    await act(async () => i18n.changeLanguage('zh-Hans'));
  });

  test('failed images expose a retry command', async () => {
    const onRetry = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7, {
      localUri: null,
      downloadState: 'failed',
      downloadError: 'download_failed',
    }), { onRetry }));

    await fireEvent.press(screen.getByRole('button', { name: '修复离线文件' }));

    expect(onRetry).toHaveBeenCalledWith(7);
  });

  test('K6-5 C: a ready row whose library ingest failed offers to re-run the ingest', async () => {
    // Re-downloading would be the wrong repair: the provider file is already on
    // disk and intact. What failed is the step after it.
    const onRepairLibrary = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7, { libraryError: 'decode_failed' }), {
      onRepairLibrary,
      onRetry,
    }));

    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: '修复入库' }));

    expect(onRepairLibrary).toHaveBeenCalledWith(7);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test('board #5: a row the source deleted offers no repair, but still deletes', async () => {
    // Repair re-downloads from the booru. When the booru answered 404/410 the
    // button can only fail, so it is hidden; delete and 退回 stay available.
    const onRetry = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7, {
      localUri: null,
      downloadState: 'failed',
      downloadError: 'download_failed',
      downloadErrorKind: 'source_gone',
    }), { onRetry }));

    expect(screen.queryByRole('button', { name: '修复离线文件' })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '删除图片' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '退回发现' })).toBeOnTheScreen();
  });

  test('board #5 discriminator: a transient failure keeps the repair command', async () => {
    const onRetry = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7, {
      localUri: null,
      downloadState: 'failed',
      downloadError: 'download_failed',
      downloadErrorKind: 'transient',
    }), { onRetry }));

    await fireEvent.press(screen.getByRole('button', { name: '修复离线文件' }));

    expect(onRetry).toHaveBeenCalledWith(7);
  });

  test('K6-5 C discriminator: a clean ready row offers neither repair', async () => {
    await render(view(image(7)));

    expect(screen.queryByRole('button', { name: '修复入库' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('null source URL hides the source action', async () => {
    await render(view(image(7, { sourceUrl: null })));

    expect(screen.queryByRole('button', { name: '打开来源' })).not.toBeOnTheScreen();
  });

  test('exposes artist, provider, and tag exploration from image metadata', async () => {
    const onExploreArtist = jest.fn();
    const onExploreProvider = jest.fn();
    const onExploreTag = jest.fn();
    const current = image(7, { tags: ['maid', 'blue_hair'] });
    await render(view(current, {
      onExploreArtist,
      onExploreProvider,
      onExploreTag,
    }));

    await fireEvent.press(screen.getByRole('button', {
      name: '查看画师 Artist 7 的收藏',
    }));
    await fireEvent.press(screen.getByRole('button', {
      name: '查看来源 Waifu.im 的收藏',
    }));
    await fireEvent.press(screen.getByRole('button', {
      name: '继续探索标签 maid',
    }));

    expect(onExploreArtist).toHaveBeenCalledWith('Artist 7');
    expect(onExploreProvider).toHaveBeenCalledWith(current);
    // R8.31: a tag link carries only the tag. The provider that owned the
    // image is no longer part of the search contract, so the callback takes
    // exactly one argument.
    expect(onExploreTag).toHaveBeenCalledWith('maid');
  });

  test('share and export are separate commands', async () => {
    const onShare = jest.fn().mockResolvedValue(undefined);
    const onExport = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7), { onShare, onExport }));

    await fireEvent.press(screen.getByRole('button', { name: '分享图片' }));
    await fireEvent.press(screen.getByRole('button', { name: '导出到照片' }));

    expect(onShare).toHaveBeenCalledWith(7);
    expect(onExport).toHaveBeenCalledWith(7);
    expect(await screen.findByText('已保存到系统相册')).toBeOnTheScreen();
  });

  test('delete confirms and removes the saved image without forcing navigation', async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    await render(view(image(7), { onDelete }));

    await fireEvent.press(screen.getByRole('button', { name: '删除图片' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(7));
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('return to discovery uses a stronger warning about possible reappearance', async () => {
    const onReturnToDiscovery = jest.fn().mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(
      (_title, _message, buttons) => {
        buttons?.find((button) => button.style === 'destructive')?.onPress?.();
      },
    );
    await render(view(image(7), { onReturnToDiscovery }));

    await fireEvent.press(screen.getByRole('button', { name: '退回发现' }));

    expect(alert).toHaveBeenCalledWith(
      '退回发现？',
      expect.stringContaining('可能再次出现'),
      expect.any(Array),
    );
    await waitFor(() => expect(onReturnToDiscovery).toHaveBeenCalledWith(7));
  });

  test('keeps deep-linked metadata and destructive actions aligned by image ID after cold load', async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    const onReturnToDiscovery = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    const props = {
      initialImageId: 7,
      errorMessage: null,
      onClose: jest.fn(),
      onShare: jest.fn().mockResolvedValue(undefined),
      onExport: jest.fn().mockResolvedValue(undefined),
      onRetry: jest.fn().mockResolvedValue(undefined),
      onDelete,
      onReturnToDiscovery,
      onLocalFileMissing: jest.fn(),
    };
    const { rerender } = await render(
      <ImageDetailView images={[]} status="loading" {...props} />,
    );

    await rerender(
      <ImageDetailView
        images={[image(1), image(7), image(9)]}
        status="ready"
        {...props}
      />,
    );

    expect(screen.getByTestId('detail-pager').props.initialScrollIndex).toBe(1);
    expect(screen.getByText('Artist 7')).toBeOnTheScreen();
    expect(screen.getByText(/2\/3/)).toBeOnTheScreen();

    await rerender(
      <ImageDetailView
        images={[image(9), image(1), image(7)]}
        status="ready"
        {...props}
      />,
    );

    expect(screen.getByText('Artist 7')).toBeOnTheScreen();
    expect(screen.getByText(/3\/3/)).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: '删除图片' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(7));
    await fireEvent.press(screen.getByRole('button', { name: '退回发现' }));
    await waitFor(() => expect(onReturnToDiscovery).toHaveBeenCalledWith(1));
  });

  test.each([
    ['分享图片', 'onShare', '此设备暂不支持分享收藏文件。'],
    ['导出到照片', 'onExport', '此设备暂不支持导出到照片。'],
  ] as const)('uses an action-specific platform unavailable message for %s', async (
    buttonName,
    callbackName,
    expectedMessage,
  ) => {
    await render(view(image(7), {
      [callbackName]: jest.fn().mockRejectedValue(
        new CollectionServiceError('platform_unavailable', 'unavailable'),
      ),
    }));

    await fireEvent.press(screen.getByRole('button', { name: buttonName }));

    expect(await screen.findByText(expectedMessage)).toBeOnTheScreen();
  });

  test('libraryOverlay absent leaves the accepted local detail assertions untouched', async () => {
    await render(view(image(7), { libraryOverlay: null }));

    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///collection/7.jpg',
    });
    expect(screen.getByRole('button', { name: '分享图片' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: '导出到照片' })).toBeOnTheScreen();
  });

  test("the viewer hands the page the composition's access", async () => {
    await render(view(image(7), {
      libraryOverlay: { entries: [], access: 'disconnected', resolve: jest.fn() },
    }));

    expect(screen.getByTestId('gallery-access-disconnected')).toBeOnTheScreen();
  });

  describe('board #27 S4: the degraded page (spec §5.12)', () => {
    const digest = viewDigest('s4-degraded-page');
    const T = 'file:///doc/library/thumbnails/d.webp';
    const thumb: LibraryRenderSource = {
      kind: 'file',
      uri: T,
      tier: 'local-thumbnail',
      role: 'thumbnail',
    };
    const mirrored = () => image(7, { downloadState: 'mirrored', localUri: null });
    const cloudEntry = (overrides: Partial<LibraryEntry> = {}) => detailEntry({
      plaintextSha256: digest,
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
      ...overrides,
    });
    const pageSource = () => screen.getByLabelText('全屏图片 7').props.source;

    test.each([
      ['ready', 'locked'],
      ['locked', 'locked'],
      ['offline', 'offline'],
      ['disconnected', 'disconnected'],
    ] as const)('the note names the composition: %s', async (access, note) => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => thumb);
      await render(view(mirrored(), {
        libraryOverlay: { entries: [cloudEntry()], access, resolve },
      }));

      expect(await screen.findByTestId('detail-thumbnail-note')).toHaveTextContent(
        z(`libraryView.thumbnailNote.${note}`),
      );
      expect(pageSource()).toEqual({ uri: T });
    });

    test.each(['a preview', 'a fast path', 'a ready row'] as const)('no note for %s', async (kind) => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => (
        kind === 'a preview'
          ? { kind: 'file', uri: 'file:///cache/preview.webp', tier: 'cached-preview', role: 'preview' }
          : thumb
      ));
      const fastEntry = cloudEntry({
        hasLocalOriginal: true,
        localOriginalUri: 'file:///data/library/originals/d.jpg',
      });
      const rendered = await render(view(kind === 'a ready row' || kind === 'a fast path' ? image(7) : mirrored(), {
        libraryOverlay: {
          entries: [kind === 'a fast path' ? fastEntry : cloudEntry()],
          access: 'offline',
          resolve,
        },
      }));
      await waitFor(() => expect(resolve).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });

      if (kind === 'a fast path') {
        await rendered.rerender(view(mirrored(), {
          libraryOverlay: {
            entries: [fastEntry],
            access: 'offline',
            resolve,
          },
        }));
        await act(async () => { await Promise.resolve(); });
      }
      expect(screen.queryByTestId('detail-thumbnail-note')).not.toBeOnTheScreen();
    });

    test('no note when the cloud holds no original, only the repair button', async () => {
      // Review finding 2: with no cloud generation the detail resolve lands on
      // the thumbnail with no cloud failure; no network or library can bring
      // the original back, so no note may say otherwise.
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => thumb);
      await render(view(mirrored(), {
        libraryOverlay: {
          entries: [cloudEntry({ residency: 'local-original', originalGenerationId: null })],
          access: 'ready',
          resolve,
        },
      }));

      await waitFor(() => expect(pageSource()).toEqual({ uri: T }));
      expect(screen.getByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
      expect(screen.queryByTestId('detail-thumbnail-note')).not.toBeOnTheScreen();
    });

    test.each([
      ['分享图片', 'onShare', 'offline', 'offline', 'offline', 'cloud_only_offline', 'detail.errorCloudOnlyOffline'],
      ['导出到照片', 'onExport', 'offline', 'offline', 'offline', 'cloud_only_offline', 'detail.errorCloudOnlyOffline'],
      ['分享图片', 'onShare', 'auth_attention', 'locked', 'locked', 'cloud_only_offline', 'detail.errorCloudOnlyOffline'],
      ['导出到照片', 'onExport', 'auth_attention', 'locked', 'locked', 'cloud_only_offline', 'detail.errorCloudOnlyOffline'],
      ['分享图片', 'onShare', 'auth_attention', 'disconnected', 'disconnected', 'cloud_only_disconnected', 'detail.errorCloudOnlyDisconnected'],
      ['导出到照片', 'onExport', 'auth_attention', 'disconnected', 'disconnected', 'cloud_only_disconnected', 'detail.errorCloudOnlyDisconnected'],
    ] as const)('a failed %s (%s) answering %s on a %s composition keeps the thumbnail and its note', async (
      buttonName,
      callbackName,
      category,
      access,
      note,
      errorCode,
      errorKey,
    ) => {
      const resolve = jest.fn(async (_digest: string, intent: string): Promise<LibraryRenderSource> => (
        intent === 'full'
          ? { kind: 'unavailable', category }
          : thumb
      ));
      await render(view(mirrored(), {
        [callbackName]: jest.fn().mockRejectedValue(
          new CollectionServiceError(errorCode, 'x'),
        ),
        libraryOverlay: { entries: [cloudEntry()], access, resolve },
      }));

      expect(await screen.findByTestId('detail-thumbnail-note')).toHaveTextContent(
        z(`libraryView.thumbnailNote.${note}`),
      );
      await fireEvent.press(screen.getByRole('button', { name: buttonName }));

      expect(await screen.findByTestId('detail-action-error')).toHaveTextContent(
        z(errorKey),
      );
      expect(pageSource()).toEqual({ uri: T });
      expect(screen.getByTestId('detail-thumbnail-note')).toHaveTextContent(
        z(`libraryView.thumbnailNote.${note}`),
      );
    });

    test('an original-role integrity from the full resolve still offers 修复', async () => {
      const resolve = jest.fn(async (_digest: string, intent: string): Promise<LibraryRenderSource> => (
        intent === 'full'
          ? { kind: 'unavailable', category: 'integrity', role: 'original' }
          : thumb
      ));
      await render(view(mirrored(), {
        onShare: jest.fn().mockRejectedValue(new CollectionServiceError('not_ready', 'x')),
        libraryOverlay: { entries: [cloudEntry()], access: 'offline', resolve },
      }));

      await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));
      expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
    });

    test('a full answer that lands after a residency move is dropped', async () => {
      let settleInitialDetail!: (source: LibraryRenderSource) => void;
      let settleFull!: (source: LibraryRenderSource) => void;
      let settleSecondDetail!: (source: LibraryRenderSource) => void;
      let detailCalls = 0;
      const resolve = jest.fn((_digest: string, intent: 'grid' | 'detail' | 'full') => {
        if (intent === 'full') return new Promise<LibraryRenderSource>((done) => { settleFull = done; });
        detailCalls += 1;
        if (detailCalls === 1) return new Promise<LibraryRenderSource>((done) => { settleInitialDetail = done; });
        return new Promise<LibraryRenderSource>((done) => { settleSecondDetail = done; });
      });
      const onShare = jest.fn().mockResolvedValue(undefined);
      const initialEntry = cloudEntry({ residency: 'cloud-only', hasLocalOriginal: false });
      const movedEntry = cloudEntry({ residency: 'local-original', hasLocalOriginal: false });
      const thumb2: LibraryRenderSource = {
        kind: 'file',
        uri: 'file:///doc/library/thumbnails/d2.webp',
        tier: 'local-thumbnail',
        role: 'thumbnail',
      };
      const rendered = await render(view(mirrored(), {
        onShare,
        libraryOverlay: { entries: [initialEntry], access: 'offline', resolve },
      }));
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'detail'));
      await act(async () => { settleInitialDetail!(thumb); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: T }));

      await fireEvent.press(screen.getByRole('button', { name: '分享图片' }));
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'full'));

      await rendered.rerender(view(mirrored(), {
        onShare,
        libraryOverlay: { entries: [movedEntry], access: 'offline', resolve },
      }));
      await waitFor(() => expect(resolve.mock.calls.filter(([, intent]) => intent === 'detail')).toHaveLength(2));

      await act(async () => {
        settleFull!({ kind: 'file', uri: 'file:///cache/original.jpg', tier: 'cloud-original', role: 'original' });
      });
      await act(async () => { settleSecondDetail!(thumb2); });

      await waitFor(() => expect(pageSource()).toEqual({ uri: thumb2.uri }));
      expect(pageSource()).not.toEqual({ uri: 'file:///cache/original.jpg' });
      expect(onShare).toHaveBeenCalledWith(7);
    });
  });

  test('cloud-only with a preview renders preview at detail and original only after full action', async () => {
    const digest = viewDigest('detail-preview');
    const resolve = jest.fn(async (
      _digest: string,
      intent: string,
    ): Promise<LibraryRenderSource> => {
      if (intent === 'full') {
        return {
          kind: 'file',
          uri: 'file:///cache/library/original.jpg',
          tier: 'cloud-original',
          role: 'original',
        };
      }
      return {
        kind: 'file',
        uri: 'file:///cache/library/preview.jpg',
        tier: 'cloud-preview',
        role: 'preview',
      };
    });
    const onExport = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7, { localUri: null }), {
      onExport,
      libraryOverlay: {
        entries: [detailEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          hasLocalOriginal: false,
        })],
        resolve,
      },
    }));

    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///cache/library/preview.jpg',
    });
    expect(resolve.mock.calls.every(([, intent]) => intent === 'detail' || intent === 'placeholder')).toBe(true);
    expect(resolve.mock.calls.some(([, intent]) => intent === 'detail')).toBe(true);
    expect(resolve.mock.calls.some(([, intent]) => intent === 'full')).toBe(false);

    await fireEvent.press(screen.getByRole('button', { name: '导出到照片' }));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(7));
    expect(resolve).toHaveBeenCalledWith(digest, 'full');
    await waitFor(() => {
      expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
        uri: 'file:///cache/library/original.jpg',
      });
    });
  });

  test('offline cloud-only shows offline and issues no fetch beyond the detail resolve', async () => {
    const digest = viewDigest('detail-offline');
    let fetchCount = 0;
    const resolve = jest.fn(async (
      _digest: string,
      intent: string,
    ): Promise<LibraryRenderSource> => {
      // The placeholder is this device's thumbnail, not another fetch.
      if (intent !== 'placeholder') fetchCount += 1;
      return { kind: 'unavailable', category: 'offline' };
    });
    await render(view(image(7, { localUri: null }), {
      libraryOverlay: {
        entries: [detailEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          hasLocalOriginal: false,
          failureCategory: 'offline',
        })],
        resolve,
      },
    }));

    expect(await screen.findByText('离线不可用')).toBeOnTheScreen();
    expect(screen.getByLabelText('图片查看器 7').props.accessibilityLiveRegion)
      .toBe('polite');
    expect(resolve).toHaveBeenCalledWith(digest, 'detail');
    expect(resolve).toHaveBeenCalledWith(digest, 'placeholder');
    expect(resolve.mock.calls.some(([, intent]) => intent === 'full' || intent === 'grid'))
      .toBe(false);
    expect(fetchCount).toBe(1);
  });

  test('the newest entry of an image wins in the viewer', async () => {
    const d1 = viewDigest('newest-old');
    const d2 = viewDigest('newest-new');
    const resolve = jest.fn(async (_digest: string, _intent: string): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///cache/library/newest.jpg',
      tier: 'cached-preview',
      role: 'preview',
    }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: {
        // `listEntries` is newest first.
        entries: [
          detailEntry({ plaintextSha256: d2, sourceImageId: 7, createdAt: 2_000 }),
          detailEntry({ plaintextSha256: d1, sourceImageId: 7, createdAt: 1_000 }),
        ],
        resolve,
      },
    }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(d2, 'detail'));
    expect(resolve.mock.calls.some(([digest]) => digest === d1)).toBe(false);
  });

  test('K2: a mirrored row with a local library original renders the resolver source', async () => {
    const digest = viewDigest('k2-detail');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///library/originals/k2.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: {
        entries: [detailEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        resolve,
      },
    }));
    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///library/originals/k2.jpg',
    });
    expect(screen.queryByText('离线文件正在保存')).not.toBeOnTheScreen();
  });

  test('K2 (pending): a mirrored row shows the placeholder and never loads the provider URL before the resolver answers', async () => {
    const digest = viewDigest('k2-pending');
    let settle!: (source: LibraryRenderSource) => void;
    const resolve = jest.fn(answeringPlaceholder(() => new Promise<LibraryRenderSource>((resolveSource) => {
      settle = resolveSource;
    })));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: {
        entries: [detailEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        resolve,
      },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'detail'));

    // Before the resolver answers the viewer holds the placeholder: no
    // provider load, no <Image> that a later override would have to replace.
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('gallery-image-override-loaded-7')).not.toBeOnTheScreen();

    await act(async () => settle({
      kind: 'file',
      uri: 'file:///library/originals/k2.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///library/originals/k2.jpg',
    });
  });

  test('K2 (entries loading): a mirrored row shows the placeholder while the library entries are still being read', async () => {
    const resolve = jest.fn();
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    // No entry yet, but the row is `mirrored`: the library owns its bytes, so
    // the page holds the black layered pending page instead of fetching the
    // provider URL in the gap before listEntries() lands.
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('K2 (entries read, no entry): a mirrored row the library does not know keeps the provider fallback', async () => {
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [], entriesPending: false, resolve: jest.fn() },
    }));
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    });
    expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
  });

  test('board #9 (entries loading): a failed file-less row shows the placeholder while the library entries are still being read', async () => {
    const resolve = jest.fn();
    await render(view(image(7, { downloadState: 'failed', localUri: null }), {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    // The collection file is gone, but the library may still hold the bytes:
    // hold the black layered pending page until listEntries() says who owns
    // the row.
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('board #9 regression: a ready row with its own file renders it while the library entries are still being read', async () => {
    await render(view(image(8), {
      libraryOverlay: { entries: [], entriesPending: true, resolve: jest.fn() },
    }));
    expect(screen.getByLabelText('全屏图片 8').props.source).toEqual({ uri: 'file:///collection/8.jpg' });
    expect(screen.queryByTestId('gallery-image-loading-8')).not.toBeOnTheScreen();
  });

  test('board #9: once the entries land, a failed file-less row the library owns renders the library file', async () => {
    const digest = viewDigest('row9-detail-owned');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: 'file:///library/originals/row9.jpg',
      tier: 'local-original',
      role: 'original',
    }));
    const row = image(7, { downloadState: 'failed', localUri: null });
    const screenView = await render(view(row, {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();

    await screenView.rerender(view(row, {
      libraryOverlay: {
        entries: [detailEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          residency: 'local-original',
          hasLocalOriginal: true,
        })],
        entriesPending: false,
        resolve,
      },
    }));
    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(resolve).toHaveBeenCalledWith(digest, 'detail');
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///library/originals/row9.jpg',
    });
  });

  test('board #9 (entries read, no entry): a failed file-less row the library does not know keeps the provider fallback', async () => {
    await render(view(image(7, { downloadState: 'failed', localUri: null }), {
      libraryOverlay: { entries: [], entriesPending: false, resolve: jest.fn() },
    }));
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    });
    expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
  });

  test('board #9 (entries loading): a saving row with no file yet holds the placeholder for that one read', async () => {
    const resolve = jest.fn();
    await render(view(image(7, { downloadState: 'pending', localUri: null }), {
      libraryOverlay: { entries: [], entriesPending: true, resolve },
    }));
    // Spec §5.1: the accepted one-read delay for a row still saving.
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();
  });

  describe('row 51: a file-less row awaiting its entries is the black layered page', () => {
    const fileLess = () => image(7, { downloadState: 'failed', localUri: null });

    test('a file-less row awaiting entries passes placeholderUri null and paints no dominant colour', async () => {
      const row = fileLess();
      const resolve = jest.fn();
      await render(view(row, {
        libraryOverlay: { entries: [], entriesPending: true, resolve },
      }));

      const page = screen.getByTestId('gallery-image-loading-7');
      expect(page.props.placeholderUri).toBeNull();
      expect(page.props.overridePending).toBe(true);
      expect(page.props.style).toBeUndefined();
      expect(JSON.stringify(page.props)).not.toContain(row.dominantColor);
      expect(JSON.stringify(page.props)).not.toContain('#111111');
      expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
      expect(resolve).not.toHaveBeenCalled();
    });

    test('the same layered page stays mounted from the entries through the thumbnail', async () => {
      const digest = viewDigest('row51-entry-arrives');
      const thumb = 'file:///library/thumbnails/row51.webp';
      const detail = 'file:///cache/library/row51.jpg';
      let settlePlaceholder!: (value: LibraryRenderSource) => void;
      let settleDetail!: (value: LibraryRenderSource) => void;
      const resolve = jest.fn((_digest: string, intent: string) => new Promise<LibraryRenderSource>((done) => {
        if (intent === 'placeholder') settlePlaceholder = done;
        if (intent === 'detail') settleDetail = done;
      }));
      const row = fileLess();
      const rendered = await render(view(row, {
        libraryOverlay: { entries: [], entriesPending: true, resolve },
      }));
      const pending = screen.getByTestId('gallery-image-loading-7');
      expect(pending.props.placeholderUri).toBeNull();
      expect(pending.props.overridePending).toBe(true);
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(resolve).not.toHaveBeenCalled();

      await rendered.rerender(view(row, {
        libraryOverlay: {
          entries: [detailEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            residency: 'cloud-only',
            hasLocalOriginal: false,
            localOriginalUri: null,
          })],
          entriesPending: false,
          resolve,
        },
      }));

      expect(resolve).toHaveBeenCalledWith(digest, 'placeholder');
      expect(resolve).toHaveBeenCalledWith(digest, 'detail');
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
      expect(pending.props.placeholderUri).toBeNull();
      expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();

      await act(async () => settlePlaceholder({
        kind: 'file',
        uri: thumb,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));

      expect(screen.getByTestId('gallery-image-loading-7').props.placeholderUri).toBe(thumb);
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
      expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();

      await act(async () => settleDetail({
        kind: 'file',
        uri: detail,
        tier: 'cached-preview',
        role: 'preview',
      }));

      expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: detail });
      expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
    });

    test('when the entries arrive with no entry, the page gets undefined', async () => {
      const row = fileLess();
      const rendered = await render(view(row, {
        libraryOverlay: { entries: [], entriesPending: true, resolve: jest.fn() },
      }));
      expect(screen.getByTestId('gallery-image-loading-7').props.placeholderUri).toBeNull();

      await rendered.rerender(view(row, {
        libraryOverlay: { entries: [], entriesPending: false, resolve: jest.fn() },
      }));

      expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).toBeUndefined();
      expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
        uri: 'https://cdn.example.com/7.jpg',
      });
      expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
    });

    test('a row with a collection file does not get null while the entries are pending', async () => {
      await render(view(image(8), {
        libraryOverlay: { entries: [], entriesPending: true, resolve: jest.fn() },
      }));

      expect(screen.getByLabelText('全屏图片 8').props.placeholderUri).toBeUndefined();
      expect(layeredPageMounts).toBe(0);
      expect(screen.queryByTestId('gallery-image-loading-8')).not.toBeOnTheScreen();
      expect(screen.getByLabelText('全屏图片 8').props.source).toEqual({
        uri: 'file:///collection/8.jpg',
      });
    });
  });

  describe('row 51 task 3: the opened page starts with its tile thumbnail', () => {
    const seed = 'file:///library/thumbnails/open.webp';
    const openSeed = { imageId: 7, uri: seed };
    const fileLess = (id = 7) => image(id, { downloadState: 'failed', localUri: null });

    test('the seeded image keeps that thumbnail until its own file answer', async () => {
      const digest = viewDigest('row51-seed-own-file');
      const own = 'file:///library/thumbnails/own.webp';
      let settlePlaceholder!: (value: LibraryRenderSource) => void;
      const resolve = jest.fn((_digest: string, intent: string) => new Promise<LibraryRenderSource>((done) => {
        if (intent === 'placeholder') settlePlaceholder = done;
      }));
      const row = fileLess();
      const rendered = await render(view(row, {
        openSeed,
        libraryOverlay: { entries: [], entriesPending: true, resolve },
      }));
      const pending = screen.getByTestId('gallery-image-loading-7');
      expect(pending.props.placeholderUri).toBe(seed);
      expect(pending.props.overridePending).toBe(true);
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(resolve).not.toHaveBeenCalled();

      await rendered.rerender(view(row, {
        openSeed,
        libraryOverlay: {
          entries: [detailEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            residency: 'cloud-only',
            hasLocalOriginal: false,
            localOriginalUri: null,
          })],
          entriesPending: false,
          resolve,
        },
      }));

      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
      expect(pending.props.placeholderUri).toBe(seed);
      expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();

      await act(async () => settlePlaceholder({
        kind: 'file',
        uri: own,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));

      expect(screen.getByTestId('gallery-image-loading-7').props.placeholderUri).toBe(own);
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
    });

    test('a null placeholder answer keeps the seed', async () => {
      const digest = viewDigest('row51-seed-own-null');
      let settlePlaceholder!: (value: LibraryRenderSource) => void;
      const resolve = jest.fn((_digest: string, intent: string) => new Promise<LibraryRenderSource>((done) => {
        if (intent === 'placeholder') settlePlaceholder = done;
      }));
      const row = fileLess();
      const rendered = await render(view(row, {
        openSeed,
        libraryOverlay: { entries: [], entriesPending: true, resolve },
      }));
      const pending = screen.getByTestId('gallery-image-loading-7');
      expect(pending.props.placeholderUri).toBe(seed);
      expect(layeredPageMounts).toBe(1);

      await rendered.rerender(view(row, {
        openSeed,
        libraryOverlay: {
          entries: [detailEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            hasLocalOriginal: false,
            localOriginalUri: null,
          })],
          entriesPending: false,
          resolve,
        },
      }));
      await act(async () => settlePlaceholder({
        kind: 'unavailable',
        category: 'object_missing',
        role: 'thumbnail',
      }));

      expect(screen.getByTestId('gallery-image-loading-7').props.placeholderUri).toBe(seed);
      expect(layeredPageMounts).toBe(1);
      expect(galleryContentMounts).toBe(1);
      expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
    });

    test('no entry after the read drops the seed', async () => {
      const row = fileLess();
      const rendered = await render(view(row, {
        openSeed,
        libraryOverlay: { entries: [], entriesPending: true, resolve: jest.fn() },
      }));
      expect(screen.getByTestId('gallery-image-loading-7').props.placeholderUri).toBe(seed);

      await rendered.rerender(view(row, {
        openSeed,
        libraryOverlay: { entries: [], entriesPending: false, resolve: jest.fn() },
      }));

      expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).toBeUndefined();
      expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
        uri: 'https://cdn.example.com/7.jpg',
      });
    });

    test('a page with another id ignores the seed', async () => {
      const row = fileLess();
      const other = fileLess(8);
      await render(view(row, {
        images: [row, other],
        openSeed,
        libraryOverlay: { entries: [], entriesPending: true, resolve: jest.fn() },
      }));

      expect(screen.getByTestId('gallery-image-loading-7').props.placeholderUri).toBe(seed);
      expect(screen.getByTestId('gallery-image-loading-8').props.placeholderUri).toBeNull();
    });
  });

  test('K2 (resolve failure): a rejected detail resolve falls back to the provider source instead of a permanent placeholder', async () => {
    const digest = viewDigest('k2-reject');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => {
      throw new Error('sqlite closed');
    });
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: {
        entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'local-original', hasLocalOriginal: true })],
        resolve,
      },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'detail'));
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    }));
    expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
  });

  test('K2b: a mirrored row whose ORIGINAL tier fails integrity offers the repair button', async () => {
    const digest = viewDigest('k2b-unavail');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'integrity', role: 'original' }));
    const onRetry = jest.fn().mockResolvedValue(undefined);
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      onRetry,
      libraryOverlay: {
        entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'gen-orig' })],
        resolve,
      },
    }));
    const repair = await screen.findByRole('button', { name: '修复离线文件' });
    await fireEvent.press(repair);
    expect(onRetry).toHaveBeenCalledWith(7);
  });

  describe('board #27 S1b: the entry fast path (spec §5.7)', () => {
    const digest = viewDigest('s1b-detail-fast-path');
    const U = 'file:///data/library/originals/d.jpg';
    const mirroredRow = () => image(7, { downloadState: 'mirrored', localUri: null });
    const fastEntry = (overrides: Partial<LibraryEntry> = {}) => detailEntry({
      plaintextSha256: digest,
      sourceImageId: 7,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: U,
      ...overrides,
    });
    const preview = (uri: string): LibraryRenderSource => ({
      kind: 'file', uri, tier: 'cached-preview', role: 'preview',
    });
    const pageSource = () => screen.getByLabelText('全屏图片 7').props.source;
    const pageError = () => screen.getByLabelText('全屏图片 7').props.onError as () => void;

    test('a mirrored row opens on its entry\'s local original with no detail resolve', async () => {
      const resolve = jest.fn(async (
        _digest: string,
        _intent: 'grid' | 'detail' | 'full',
      ) => preview('file:///cache/library/never.webp'));
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
      expect(pageSource()).toEqual({ uri: U });
      expect(resolve).not.toHaveBeenCalledWith(digest, 'detail');
    });

    test('a load error on it runs one detail resolve, however often the error fires', async () => {
      let settle!: (source: LibraryRenderSource) => void;
      const resolve = jest.fn(answeringPlaceholder(() => (
        new Promise<LibraryRenderSource>((done) => { settle = done; })
      )));
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      const onError = pageError();

      await act(async () => { onError(); });
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
      expect(resolve).toHaveBeenCalledWith(digest, 'detail');

      await act(async () => { onError(); });
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);

      await act(async () => { settle(preview('file:///cache/library/p.webp')); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: 'file:///cache/library/p.webp' }));
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
    });

    test.each(['settled', 'in flight'] as const)(
      'an earlier detail answer never stands in after a fast-path failure: %s',
      async (stateOfFirst) => {
        const pending: ((source: LibraryRenderSource) => void)[] = [];
        const resolve = jest.fn(answeringPlaceholder(() => (
          new Promise<LibraryRenderSource>((done) => { pending.push(done); })
        )));
        const A = 'file:///cache/library/a-preview.webp';
        const B = 'file:///cache/library/b-preview.webp';
        // A `ready` row has a collection file, so the resolver does not own it
        // and the fast path is off; the neighbour effect still resolves it.
        const readyRow = image(7);
        const rendered = await render(view(readyRow, {
          libraryOverlay: {
            entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: false })],
            resolve,
          },
        }));
        await waitFor(() => expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1));
        if (stateOfFirst === 'settled') {
          await act(async () => { pending[0]!(preview(A)); });
        }

        await rendered.rerender(view(mirroredRow(), {
          libraryOverlay: { entries: [fastEntry()], resolve },
        }));
        expect(pageSource()).toEqual({ uri: U });

        await act(async () => { pageError()(); });
        expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(2);
        expect(callsBesidesPlaceholder(resolve, digest)[1]).toEqual([digest, 'detail']);
        // A must leave the rendered state too, not only the ref.
        expect(JSON.stringify(screen.toJSON())).not.toContain(A);

        if (stateOfFirst === 'in flight') {
          await act(async () => { pending[0]!(preview(A)); });
        }
        await act(async () => { pending[1]!(preview(B)); });

        await waitFor(() => expect(pageSource()).toEqual({ uri: B }));
        expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(2);
      },
    );

    test('after a failed fast path the repair gate reads no local original', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();

      await act(async () => { pageError()(); });
      expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
    });

    test('a failed fast path whose detail resolve returns the local original hides 修复离线文件', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file', uri: U, tier: 'local-original', role: 'original',
      }));
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { pageError()(); });
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'detail'));
      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));

      expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
    });

    test('a failed fast path keeps trusting the local original while its detail resolve is in flight', async () => {
      let settle!: (source: LibraryRenderSource) => void;
      const resolve = jest.fn(() => new Promise<LibraryRenderSource>((done) => { settle = done; }));
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { pageError()(); });
      expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();

      await act(async () => { settle({ kind: 'file', uri: U, tier: 'local-original', role: 'original' }); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));
    });

    test('a failed fast path whose detail resolve returns another file tier still needs repair', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'file', uri: 'file:///cache/library/preview.webp', tier: 'cached-preview', role: 'preview',
      }));
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { pageError()(); });
      await waitFor(() => expect(screen.getByRole('button', { name: '修复离线文件' })).toBeOnTheScreen());
    });

    test('a failed fast path whose detail resolve rejects still needs repair', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => {
        throw new Error('resolve failed');
      });
      await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));

      await act(async () => { pageError()(); });
      await waitFor(() => expect(screen.getByRole('button', { name: '修复离线文件' })).toBeOnTheScreen());
    });

    test('a failed fast path is offered again after its row held its own collection file', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      const rendered = await render(view(mirroredRow(), { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });
      expect(pageSource()).toEqual({ uri: U });

      await act(async () => { pageError()(); });
      expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();

      // The row becomes a ready row that holds its own collection file …
      await rendered.rerender(view(image(7), { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });
      // … then a mirrored row again: the fast path is offered afresh.
      await rendered.rerender(view(mirroredRow(), { libraryOverlay: overlay() }));
      await act(async () => { await Promise.resolve(); });

      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));
      expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
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
        const resolve = jest.fn(async (
          _digest: string,
          _intent: 'grid' | 'detail' | 'full',
        ): Promise<LibraryRenderSource> => ({
          kind: 'unavailable', category: 'object_missing',
        }));
        const OWN8 = 'file:///collection/8.jpg';
        const pages = (extra: Partial<React.ComponentProps<typeof ImageDetailView>> = {}) => view(
          mirroredRow(),
          {
            images: [mirroredRow(), image(8, { downloadState: 'ready', localUri: OWN8 })],
            libraryOverlay: {
              entries: [
                fastEntry({ originalGenerationId: null }),
                detailEntry({
                  plaintextSha256: viewDigest('s1b-detail-prop-8'),
                  sourceImageId: 8,
                  residency: 'local-original',
                  hasLocalOriginal: true,
                  localOriginalUri: 'file:///data/library/originals/d8.jpg',
                }),
              ],
              resolve,
            },
            ...extra,
          },
        );
        const rendered = await render(pages());
        await act(async () => { await Promise.resolve(); });
        expect(pageSource()).toEqual({ uri: U });

        await act(async () => { pageError()(); });
        expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();

        // Nothing about the row or its entry changed; only the hand-over names it.
        await rendered.rerender(pages({ handedOver: { seq: 1, imageIds: [7] } }));
        await act(async () => { await Promise.resolve(); });

        await waitFor(() => expect(pageSource()).toEqual({ uri: U }));
        expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
        expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
      } finally {
        loopGuard.mockRestore();
      }
    });

    test('a hand-over is applied once: a later failure stays failed while the same hand-over is still the latest', async () => {
      const resolve = jest.fn(async (
        _digest: string,
        _intent: 'grid' | 'detail' | 'full',
      ): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const handed = { seq: 1, imageIds: [7] };
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      const rendered = await render(view(mirroredRow(), { libraryOverlay: overlay(), handedOver: handed }));
      await act(async () => { await Promise.resolve(); });
      expect(pageSource()).toEqual({ uri: U });

      // The fast path fails after the hand-over was applied …
      await act(async () => { pageError()(); });
      expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();

      // … and a fresh entries read (new entries, the same publication) does not forget it.
      await rendered.rerender(view(mirroredRow(), { libraryOverlay: overlay(), handedOver: handed }));
      await act(async () => { await Promise.resolve(); });

      expect(screen.queryByLabelText('全屏图片 7')?.props.source).not.toEqual({ uri: U });
      expect(screen.getByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
    });

    test('a hand-over naming no failed digest costs no extra render', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const overlay = () => ({ entries: [fastEntry({ originalGenerationId: null })], resolve });
      let commits = 0;
      const profiled = (handedOver: React.ComponentProps<typeof ImageDetailView>['handedOver']) => (
        <Profiler id="viewer" onRender={() => { commits += 1; }}>
          {view(mirroredRow(), { libraryOverlay: overlay(), handedOver })}
        </Profiler>
      );
      const rendered = await render(profiled(null));
      await act(async () => { await Promise.resolve(); });

      commits = 0;
      await rendered.rerender(profiled({ seq: 1, imageIds: [7] }));
      await act(async () => { await Promise.resolve(); });

      // Nothing had failed, so the hand-over changes no state: the prop's own render only.
      expect(commits).toBe(1);
    });

    test('a failed fast path stays withheld while nothing changed', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const rendered = await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      await act(async () => { pageError()(); });
      await waitFor(() => expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1));

      // New object references, equal values: the fast path must stay withheld,
      // so the page never re-opens on the local original U.
      for (let i = 0; i < 2; i += 1) {
        await rendered.rerender(view(mirroredRow(), {
          libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
        }));
        await act(async () => { await Promise.resolve(); });
      }

      expect(screen.queryByTestId('gallery-image-override-loaded-7')).toBeNull();
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
    });

    test('a failed fast path beside a row with no entry yet leaves that row alone', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      // Page 7 takes the fast path; page 8 is a ready row the library has not
      // ingested yet, so it has no entry for the forget effect to read.
      const pages = () => view(mirroredRow(), {
        images: [mirroredRow(), image(8)],
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      });
      const rendered = await render(pages());
      await act(async () => { await Promise.resolve(); });
      expect(pageSource()).toEqual({ uri: U });

      await act(async () => { pageError()(); });
      await waitFor(() => expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1));

      // New object references, equal values: the forget effect walks both rows
      // again, the entry-less one included, and must neither throw nor act on it.
      await rendered.rerender(pages());
      await act(async () => { await Promise.resolve(); });

      expect(screen.getByLabelText('全屏图片 8').props.source).toEqual({
        uri: 'file:///collection/8.jpg',
      });
      expect(screen.queryByTestId('gallery-image-override-loaded-7')).toBeNull();
      expect(screen.queryByLabelText('全屏图片 7')?.props.source).not.toEqual({ uri: U });
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1);
    });

    test('a late detail answer of an earlier resolve never clears the fresh resolve\'s in-flight mark', async () => {
      const pending: ((source: LibraryRenderSource) => void)[] = [];
      const resolve = jest.fn(answeringPlaceholder(() => (
        new Promise<LibraryRenderSource>((done) => { pending.push(done); })
      )));
      const A = 'file:///cache/library/a-preview.webp';
      const B = 'file:///cache/library/b-preview.webp';
      // #1 resolves for a ready row (resolver does not own it; fast path off).
      const rendered = await render(view(image(7), {
        libraryOverlay: { entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: false })], resolve },
      }));
      await waitFor(() => expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1));

      // The fast path returns and then fails → #2 at a fresh generation.
      await rendered.rerender(view(mirroredRow(), { libraryOverlay: { entries: [fastEntry()], resolve } }));
      expect(pageSource()).toEqual({ uri: U });
      await act(async () => { pageError()(); });
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(2);

      // #1 (older generation) settles late.
      await act(async () => { pending[0]!(preview(A)); });

      // Another neighbour pass must not start a third resolve — #2 still holds
      // the in-flight mark; #1's late `finally` must not clear it.
      await rendered.rerender(view(mirroredRow(), { libraryOverlay: { entries: [fastEntry()], resolve } }));
      await act(async () => { await Promise.resolve(); });
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(2);

      await act(async () => { pending[1]!(preview(B)); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: B }));
    });

    test('an earlier detail resolve that fails late never blanks the fresh one', async () => {
      const pending: ((source: LibraryRenderSource) => void)[] = [];
      const rejecters: ((error: unknown) => void)[] = [];
      const resolve = jest.fn(answeringPlaceholder(() => (
        new Promise<LibraryRenderSource>((done, fail) => { pending.push(done); rejecters.push(fail); })
      )));
      const B = 'file:///cache/library/b-preview.webp';
      const rendered = await render(view(image(7), {
        libraryOverlay: { entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: false })], resolve },
      }));
      await waitFor(() => expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(1));

      await rendered.rerender(view(mirroredRow(), { libraryOverlay: { entries: [fastEntry()], resolve } }));
      expect(pageSource()).toEqual({ uri: U });
      await act(async () => { pageError()(); });
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(2);

      // #1 (older generation) rejects late; it must not blank the digest.
      await act(async () => { rejecters[0]!(new Error('late failure')); });
      await act(async () => { await Promise.resolve(); });

      await act(async () => { pending[1]!(preview(B)); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: B }));
    });

    test('board #16: a fast-path page opens as an original, not a thumbnail', async () => {
      const resolve = jest.fn(async () => preview('file:///cache/library/never.webp'));
      await render(view(mirroredRow(), { libraryOverlay: { entries: [fastEntry()], resolve } }));
      await act(async () => { await Promise.resolve(); });

      // A fast path is an ORIGINAL; only an original is cut to a still.
      expect(screen.getByLabelText('全屏图片 7').props.overrideRole).toBe('original');
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(0);
    });

    test('a resolved override that fails to load stays silent', async () => {
      const P = 'file:///cache/library/p.webp';
      const resolve = jest.fn(async () => preview(P));
      await render(view(mirroredRow(), {
        libraryOverlay: {
          // No local original: the page takes the resolver's override, not a fast path.
          entries: [fastEntry({ localOriginalUri: null, hasLocalOriginal: true, originalGenerationId: null })],
          resolve,
        },
      }));
      await waitFor(() => expect(pageSource()).toEqual({ uri: P }));
      expect(callsBesidesPlaceholder(resolve)).toHaveLength(1);

      // The failing override is the resolver's, not a fast path: no re-resolve.
      await act(async () => { pageError()(); });
      expect(callsBesidesPlaceholder(resolve)).toHaveLength(1);
    });

    test('a ready page keeps its own collection file even when its entry holds the local original', async () => {
      const OWN = 'file:///collection/8.jpg';
      const ORIGINAL = 'file:///data/library/originals/d8.jpg';
      const resolve = jest.fn(async (
        _digest: string,
        _intent: 'grid' | 'detail' | 'full',
      ): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'object_missing' }));
      const onLocalFileMissing = jest.fn();
      await render(view(image(8, { downloadState: 'ready', localUri: OWN }), {
        onLocalFileMissing,
        libraryOverlay: {
          entries: [detailEntry({
            plaintextSha256: viewDigest('s1b-detail-ready-owns-file'),
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
      const page = () => screen.getByLabelText('全屏图片 8');

      expect(page().props.source).toEqual({ uri: OWN });
      expect(screen.queryByTestId('gallery-image-override-loaded-8')).not.toBeOnTheScreen();

      // Its load error is the page's own local-file repair, never a failed fast path.
      // The neighbour effect may still resolve a ready page (the render ignores the
      // result), so the count is compared across the error, not pinned.
      const resolvesBefore = resolve.mock.calls.length;
      await act(async () => { page().props.onError(); });

      expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
      expect(onLocalFileMissing).toHaveBeenCalledWith(8, OWN);
      expect(page().props.source).toEqual({ uri: OWN });
      expect(screen.queryByTestId('gallery-image-override-loaded-8')).not.toBeOnTheScreen();
      expect(resolve).toHaveBeenCalledTimes(resolvesBefore);
    });

    test('a failed fast path is offered again after its entry lost and regained its local original', async () => {
      const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
        kind: 'unavailable', category: 'object_missing',
      }));
      const rendered = await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      expect(pageSource()).toEqual({ uri: U });

      await act(async () => { pageError()(); });
      expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();

      // The entry loses its local original (still a mirrored, resolver-owned row) …
      await rendered.rerender(view(mirroredRow(), {
        libraryOverlay: {
          entries: [fastEntry({ originalGenerationId: null, hasLocalOriginal: false, localOriginalUri: null })],
          resolve,
        },
      }));
      await act(async () => { await Promise.resolve(); });
      // … then regains it: the fast path is offered afresh.
      await rendered.rerender(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ originalGenerationId: null })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));
      expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
      // Losing the local original moved the residency, so the resolve made for
      // the old one was dropped and asked afresh once (spec §5.12); regaining it
      // is served by the fast path with no further resolve.
      expect(callsBesidesPlaceholder(resolve, digest)).toHaveLength(2);
    });

    test('a failed fast path settles beside pages whose fast path is withheld for another reason', async () => {
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
        const pages = () => view(mirroredRow(), {
          images: [
            mirroredRow(),
            image(8, { downloadState: 'ready', localUri: OWN8 }),
            image(9, { downloadState: 'mirrored', localUri: null }),
          ],
          libraryOverlay: {
            entries: [
              fastEntry({ originalGenerationId: null }),
              detailEntry({
                plaintextSha256: viewDigest('s1b-settle-ready-8'),
                sourceImageId: 8,
                residency: 'local-original',
                hasLocalOriginal: true,
                localOriginalUri: 'file:///data/library/originals/d8.jpg',
              }),
              detailEntry({
                plaintextSha256: viewDigest('s1b-settle-no-original-9'),
                sourceImageId: 9,
                residency: 'local-original',
                hasLocalOriginal: false,
                localOriginalUri: null,
              }),
            ],
            resolve,
          },
        });
        const rendered = await render(pages());
        await act(async () => { await Promise.resolve(); });
        expect(pageSource()).toEqual({ uri: U });

        await act(async () => { pageError()(); });
        await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'detail'));
        for (let i = 0; i < 5; i += 1) {
          await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
        }
        await rendered.rerender(pages());
        await rendered.rerender(pages());
        await act(async () => { await Promise.resolve(); });

        expect(screen.getByLabelText('全屏图片 8').props.source).toEqual({ uri: OWN8 });
        expect(screen.queryByLabelText('全屏图片 7')?.props.source).not.toEqual({ uri: U });
        expect(
          resolve.mock.calls.filter(([d, intent]) => d === digest && intent === 'detail'),
        ).toHaveLength(1);
      } finally {
        loopGuard.mockRestore();
      }
    });
  });

  describe('board #27 S3b: a residency change drops the resolve (spec §5.12)', () => {
    const digest = viewDigest('s3b-detail-residency');
    const U = 'file:///data/library/originals/d.jpg';
    const mirroredRow = () => image(7, { downloadState: 'mirrored', localUri: null });
    const fastEntry = (overrides: Partial<LibraryEntry> = {}) => detailEntry({
      plaintextSha256: digest,
      sourceImageId: 7,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: U,
      ...overrides,
    });
    const evicted = { residency: 'cloud-only', hasLocalOriginal: false, localOriginalUri: null } as const;
    const preview = (uri: string): LibraryRenderSource => ({
      kind: 'file', uri, tier: 'cached-preview', role: 'preview',
    });
    const pageSource = () => screen.getByLabelText('全屏图片 7').props.source;
    const pageError = () => screen.getByLabelText('全屏图片 7').props.onError as () => void;
    const detailResolves = (resolve: jest.Mock) => (
      resolve.mock.calls.filter(([d, intent]) => d === digest && intent === 'detail')
    );

    function pendingResolve() {
      const pending: ((source: LibraryRenderSource) => void)[] = [];
      const resolve = jest.fn(answeringPlaceholder(() => (
        new Promise<LibraryRenderSource>((done) => { pending.push(done); })
      )));
      return { pending, resolve };
    }

    test('an eviction drops the page\'s resolve and resolves the preview', async () => {
      const { pending, resolve } = pendingResolve();
      const P = 'file:///cache/library/p.webp';
      const rendered = await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { pageError()(); });
      expect(detailResolves(resolve)).toHaveLength(1);
      const local: LibraryRenderSource = {
        kind: 'file', uri: U, tier: 'local-original', role: 'original',
      };
      await act(async () => { pending[0]!(local); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));

      await rendered.rerender(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry(evicted)], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      expect(detailResolves(resolve)).toHaveLength(2);
      // The deleted original is no longer shown while the fresh resolve runs.
      expect(screen.queryByLabelText('全屏图片 7')?.props.source).not.toEqual({ uri: U });
      await act(async () => { pending[1]!(preview(P)); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: P }));
    });

    test('a detail resolve in flight when the residency moves never lands', async () => {
      const { pending, resolve } = pendingResolve();
      const P = 'file:///cache/library/p.webp';
      const rendered = await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { pageError()(); });
      expect(detailResolves(resolve)).toHaveLength(1);

      await rendered.rerender(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry(evicted)], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      expect(detailResolves(resolve)).toHaveLength(2);

      await act(async () => {
        pending[0]!({ kind: 'file', uri: U, tier: 'local-original', role: 'original' });
      });
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByLabelText('全屏图片 7')?.props.source).not.toEqual({ uri: U });

      await act(async () => { pending[1]!(preview(P)); });
      await waitFor(() => expect(pageSource()).toEqual({ uri: P }));
      expect(detailResolves(resolve)).toHaveLength(2);
    });

    test('a local original that moves to another file is resolved afresh', async () => {
      // The re-offer effect only acts when the URI is gone, so nothing but the
      // residency effect, declared before the resolve effect, drops this page's
      // resolve (the move X → Y without a null read in between).
      const { pending, resolve } = pendingResolve();
      const Y = 'file:///data/library/originals/y.jpg';
      const rendered = await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { pageError()(); });
      await act(async () => {
        pending[0]!({ kind: 'file', uri: U, tier: 'local-original', role: 'original' });
      });
      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));

      await rendered.rerender(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ localOriginalUri: Y })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      expect(detailResolves(resolve)).toHaveLength(2);
    });

    test('no move, no second resolve', async () => {
      const { pending, resolve } = pendingResolve();
      const rendered = await render(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry()], resolve },
      }));
      await act(async () => { pageError()(); });
      await act(async () => {
        pending[0]!({ kind: 'file', uri: U, tier: 'local-original', role: 'original' });
      });
      await waitFor(() => expect(pageSource()).toEqual({ uri: U }));

      await rendered.rerender(view(mirroredRow(), {
        libraryOverlay: { entries: [fastEntry({ protection: 'pending' })], resolve },
      }));
      await act(async () => { await Promise.resolve(); });

      expect(detailResolves(resolve)).toHaveLength(1);
      expect(pageSource()).toEqual({ uri: U });
    });
  });

  test('K2c: a cloud-only mirrored row the resolver serves from the bucket has no repair button', async () => {
    const digest = viewDigest('k2c-cloud-served');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'file', uri: 'file:///cache/library/preview.jpg', tier: 'cloud-preview', role: 'preview' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false })], resolve },
    }));
    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('K2c: a mirrored row that is merely offline has no repair button', async () => {
    const digest = viewDigest('k2c-offline');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'offline' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false })], resolve },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('K2b discriminator: a mirrored row with a local library original has no repair button', async () => {
    const digest = viewDigest('k2b-ok');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'file', uri: 'file:///library/originals/ok.jpg', tier: 'local-original', role: 'original' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, hasLocalOriginal: true })], resolve },
    }));
    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('K3 G3: a missing DERIVED preview with an original in the cloud has no repair button', async () => {
    const digest = viewDigest('k3-detail-derived');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'object_missing' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'gen-orig' })], resolve },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('K3b G3: a corrupted DERIVED tier (preview integrity) with an original in the cloud has no repair button', async () => {
    const digest = viewDigest('k3b-detail-integrity');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'integrity', role: 'preview' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'gen-orig' })], resolve },
    }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('K3b G3 (regression fix): the ORIGINAL tier itself failing integrity (gif / preview-less asset) offers the repair button even with an original generation', async () => {
    const digest = viewDigest('k3b-detail-original-integrity');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'integrity', role: 'original' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: 'gen-orig' })], resolve },
    }));
    expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
  });

  test('K3 G3: no original in the cloud offers the repair button', async () => {
    const digest = viewDigest('k3-detail-no-original');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'object_missing' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false, originalGenerationId: null })], resolve },
    }));
    expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
  });

  test('K3: auth_attention renders the locked placeholder in the viewer', async () => {
    const digest = viewDigest('k3-detail-locked');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({ kind: 'unavailable', category: 'auth_attention' }));
    await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
      libraryOverlay: { entries: [detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'cloud-only', hasLocalOriginal: false })], resolve },
    }));
    expect(await screen.findByTestId('gallery-image-locked-7')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '修复离线文件' })).not.toBeOnTheScreen();
  });

  test('a ready row keeps its own file when its library entry has no local original', async () => {
    const digest = viewDigest('ready-detail-no-local');
    const resolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'unavailable',
      category: 'auth_attention',
    }));
    await render(view(image(7), {
      libraryOverlay: {
        entries: [detailEntry({
          plaintextSha256: digest,
          sourceImageId: 7,
          hasLocalOriginal: false,
          originalGenerationId: 'gen-orig',
        })],
        resolve,
      },
    }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'detail'));
    await act(async () => undefined);
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'file:///collection/7.jpg',
    });
    expect(screen.queryByText('解锁云同步后可查看')).not.toBeOnTheScreen();
  });

  describe('board rows 48–49: thumbnail first, neighbours ±2', () => {
    const thumbOf = (id: number) => `file:///library/thumbnails/${id}.webp`;

    test('a row with no library entry gets no placeholderUri', async () => {
      await render(view(image(8), {
        libraryOverlay: { entries: [], resolve: jest.fn() },
      }));

      expect(screen.getByLabelText('全屏图片 8').props.placeholderUri).toBeUndefined();
    });
    const digestOf = (id: number) => viewDigest(`row48-${id}`);
    const callsFor = (resolve: jest.Mock, id: number, intent: string) => (
      resolve.mock.calls.filter(([digest, called]) => digest === digestOf(id) && called === intent)
    );

    function pagesFor(ids: readonly number[], fastIds: ReadonlySet<number>) {
      const pages = ids.map((id) => image(id, { downloadState: 'mirrored', localUri: null }));
      const entries = ids.map((id) => detailEntry({
        plaintextSha256: digestOf(id),
        sourceImageId: id,
        residency: fastIds.has(id) ? 'local-original' : 'cloud-only',
        hasLocalOriginal: fastIds.has(id),
        localOriginalUri: fastIds.has(id) ? `file:///data/library/originals/${id}.jpg` : null,
      }));
      return { pages, entries };
    }

    function resolving(onPlaceholder: (digest: string) => Promise<LibraryRenderSource> | LibraryRenderSource) {
      return jest.fn(async (digest: string, intent: string): Promise<LibraryRenderSource> => {
        if (intent === 'placeholder') return onPlaceholder(digest);
        return {
          kind: 'file',
          uri: `file:///cache/library/${digest}.jpg`,
          tier: 'cached-preview',
          role: 'preview',
        };
      });
    }

    test('resolves placeholder for current ±2, fast-path rows included, and detail for ±2 excluding them', async () => {
      // Indexes 0..6. Current is index 3. ±2 is indexes 1..5; ±3 is 0 and 6.
      const ids = [10, 11, 12, 13, 14, 15, 16];
      const fastIds = new Set([12, 13, 15]);
      const { pages, entries } = pagesFor(ids, fastIds);
      const resolve = resolving((digest) => ({
        kind: 'file',
        uri: `file:///library/thumbnails/${digest}.webp`,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      await render(view(pages[3]!, {
        images: pages,
        libraryOverlay: { entries, resolve },
      }));

      await waitFor(() => {
        for (const id of [11, 12, 13, 14, 15]) {
          expect(callsFor(resolve, id, 'placeholder')).toHaveLength(1);
        }
      });
      expect(callsFor(resolve, 10, 'placeholder')).toHaveLength(0);
      expect(callsFor(resolve, 16, 'placeholder')).toHaveLength(0);
      for (const id of [11, 14]) {
        expect(callsFor(resolve, id, 'detail')).toHaveLength(1);
      }
      for (const id of [10, 12, 13, 15, 16]) {
        expect(callsFor(resolve, id, 'detail')).toHaveLength(0);
      }
      expect(resolve.mock.calls.some(([, intent]) => intent === 'grid')).toBe(false);
    });

    test.each([
      ['unavailable', { kind: 'unavailable', category: 'object_missing' } as LibraryRenderSource],
      ['rejected', null],
    ] as const)('a %s placeholder resolve passes placeholderUri null', async (_label, source) => {
      const digest = viewDigest('row48-null');
      const resolve = jest.fn(async (_digest: string, intent: string): Promise<LibraryRenderSource> => {
        if (intent === 'placeholder') {
          if (source === null) throw new Error('thumbnail missing');
          return source;
        }
        return {
          kind: 'file',
          uri: 'file:///cache/library/preview.jpg',
          tier: 'cached-preview',
          role: 'preview',
        };
      });
      await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
        libraryOverlay: {
          entries: [detailEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            residency: 'cloud-only',
            hasLocalOriginal: false,
          })],
          resolve,
        },
      }));

      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'placeholder'));
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).toBeNull());
      expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
        uri: 'file:///cache/library/preview.jpg',
      });
    });

    test('a resolved placeholder passes its file uri', async () => {
      const digest = viewDigest('row48-file');
      const resolve = resolving(() => ({
        kind: 'file',
        uri: thumbOf(7),
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      await render(view(image(7, { downloadState: 'mirrored', localUri: null }), {
        libraryOverlay: {
          entries: [detailEntry({
            plaintextSha256: digest,
            sourceImageId: 7,
            residency: 'cloud-only',
            hasLocalOriginal: false,
          })],
          resolve,
        },
      }));

      await waitFor(() => {
        expect(screen.getByLabelText('全屏图片 7').props.placeholderUri).toBe(thumbOf(7));
      });
      expect(resolve).toHaveBeenCalledWith(digest, 'placeholder');
      expect(resolve.mock.calls.filter(([, intent]) => intent === 'grid')).toHaveLength(0);
    });

    test('each digest is resolved once across re-renders and swipes', async () => {
      const ids = [10, 11, 12, 13, 14, 15, 16];
      const fastIds = new Set([12, 13, 15]);
      const { pages, entries } = pagesFor(ids, fastIds);
      const resolve = resolving(() => ({
        kind: 'unavailable',
        category: 'object_missing',
      }));
      const overlay = () => ({
        entries: entries.map((entry) => ({ ...entry })),
        resolve,
      });
      const rendered = await render(view(pages[3]!, {
        images: pages,
        libraryOverlay: overlay(),
      }));
      await waitFor(() => expect(callsFor(resolve, 11, 'placeholder')).toHaveLength(1));
      await waitFor(() => expect(callsFor(resolve, 11, 'detail')).toHaveLength(1));

      await rendered.rerender(view(pages[3]!, {
        images: pages.map((page) => ({ ...page })),
        libraryOverlay: overlay(),
      }));
      await act(async () => { await Promise.resolve(); });

      expect(callsFor(resolve, 11, 'placeholder')).toHaveLength(1);
      expect(callsFor(resolve, 13, 'placeholder')).toHaveLength(1);
      expect(callsFor(resolve, 12, 'detail')).toHaveLength(0);

      const pager = screen.getByTestId('detail-pager');
      await act(async () => {
        pager.props.onMomentumScrollEnd({
          nativeEvent: { contentOffset: { x: pager.props.snapToInterval * 5, y: 0 } },
        });
      });
      await waitFor(() => expect(callsFor(resolve, 16, 'placeholder')).toHaveLength(1));
      await waitFor(() => expect(callsFor(resolve, 16, 'detail')).toHaveLength(1));

      await rendered.rerender(view(pages[3]!, {
        images: pages.map((page) => ({ ...page })),
        libraryOverlay: overlay(),
      }));
      await act(async () => { await Promise.resolve(); });

      for (const id of ids) {
        expect(callsFor(resolve, id, 'placeholder').length).toBeLessThanOrEqual(1);
        expect(callsFor(resolve, id, 'detail').length).toBeLessThanOrEqual(1);
      }
      expect(callsFor(resolve, 11, 'placeholder')).toHaveLength(1);
      expect(callsFor(resolve, 16, 'placeholder')).toHaveLength(1);
      expect(callsFor(resolve, 10, 'placeholder')).toHaveLength(0);
      expect(callsFor(resolve, 13, 'detail')).toHaveLength(0);
    });

    test('a residency change does not resolve the placeholder again', async () => {
      const digest = viewDigest('row48-residency');
      const resolve = resolving(() => ({
        kind: 'file',
        uri: thumbOf(7),
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      const row = image(7, { downloadState: 'mirrored', localUri: null });
      const entry = (localOriginalUri: string | null) => detailEntry({
        plaintextSha256: digest,
        sourceImageId: 7,
        residency: localOriginalUri === null ? 'cloud-only' : 'local-original',
        hasLocalOriginal: localOriginalUri !== null,
        localOriginalUri,
      });
      const rendered = await render(view(row, {
        libraryOverlay: { entries: [entry(null)], resolve },
      }));
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(digest, 'placeholder'));
      const before = resolve.mock.calls.filter(([, intent]) => intent === 'placeholder').length;

      await rendered.rerender(view(row, {
        libraryOverlay: { entries: [entry('file:///data/library/originals/7.jpg')], resolve },
      }));
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });

      expect(resolve.mock.calls.filter(([, intent]) => intent === 'placeholder')).toHaveLength(before);
    });

    test('each mounted page receives its own thumbnail, not the current page\'s', async () => {
      const ids = [21, 22, 23];
      const { pages, entries } = pagesFor(ids, new Set(ids));
      const resolve = resolving((digest) => ({
        kind: 'file',
        uri: `file:///library/thumbnails/${digest}.webp`,
        tier: 'local-thumbnail',
        role: 'thumbnail',
      }));
      await render(view(pages[0]!, {
        images: pages,
        libraryOverlay: { entries, resolve },
      }));

      await waitFor(() => {
        for (const id of ids) {
          expect(screen.getByLabelText(`全屏图片 ${id}`).props.placeholderUri)
            .toBe(`file:///library/thumbnails/${digestOf(id)}.webp`);
        }
      });
    });

    test('one placeholder rejection leaves the other digests\' uris in place', async () => {
      const ids = [31, 32, 33];
      const { pages, entries } = pagesFor(ids, new Set(ids));
      const pending = new Map<string, {
        resolve: (source: LibraryRenderSource) => void;
        reject: (error: Error) => void;
      }>();
      const attempts = new Map<string, number>();
      const resolve = jest.fn((digest: string, intent: string) => {
        if (intent !== 'placeholder') {
          return Promise.resolve({
            kind: 'file',
            uri: 'file:///cache/library/preview.jpg',
            tier: 'cached-preview',
            role: 'preview',
          } satisfies LibraryRenderSource);
        }
        const attempt = (attempts.get(digest) ?? 0) + 1;
        attempts.set(digest, attempt);
        if (attempt > 1) return new Promise<LibraryRenderSource>(() => undefined);
        return new Promise<LibraryRenderSource>((resolveSource, rejectSource) => {
          pending.set(digest, { resolve: resolveSource, reject: rejectSource });
        });
      });
      await render(view(pages[0]!, {
        images: pages,
        libraryOverlay: { entries, resolve },
      }));
      await waitFor(() => expect(pending.size).toBe(3));

      const thumb = (id: number) => `file:///library/thumbnails/${id}.webp`;
      const file = (id: number): LibraryRenderSource => ({
        kind: 'file',
        uri: thumb(id),
        tier: 'local-thumbnail',
        role: 'thumbnail',
      });
      await act(async () => {
        pending.get(digestOf(31))!.resolve(file(31));
        pending.get(digestOf(33))!.resolve(file(33));
      });
      await waitFor(() => {
        expect(screen.getByLabelText('全屏图片 31').props.placeholderUri).toBe(thumb(31));
        expect(screen.getByLabelText('全屏图片 33').props.placeholderUri).toBe(thumb(33));
      });

      await act(async () => {
        pending.get(digestOf(32))!.reject(new Error('thumbnail missing'));
      });
      await waitFor(() => {
        expect(screen.getByLabelText('全屏图片 32').props.placeholderUri).toBeNull();
      });
      expect(screen.getByLabelText('全屏图片 31').props.placeholderUri).toBe(thumb(31));
      expect(screen.getByLabelText('全屏图片 33').props.placeholderUri).toBe(thumb(33));
    });
  });
});

function detailEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    plaintextSha256: viewDigest('detail'),
    sourceImageId: 7,
    format: 'jpeg',
    byteSize: 400_000,
    width: 900,
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

// Board row 45: the full-quality resolve of a cloud-only row answers the
// decrypted cache file (`<scope>-<sha>-original.bin`); every other intent
// renders the cached preview as usual.
function cachedOriginalResolver(cacheUri: string) {
  return jest.fn(async (_digest: string, intent: string): Promise<LibraryRenderSource> => ({
    kind: 'file',
    uri: intent === 'full' ? cacheUri : 'file:///cache/library/preview.jpg',
    tier: intent === 'full' ? 'cached-original' : 'cached-preview',
    role: intent === 'full' ? 'original' : 'preview',
  }));
}

describe('ImageDetailScreen', () => {
  test('a preloaded collection shows the seed in the first committed tree', async () => {
    const seed = 'file:///library/thumbnails/first-commit.webp';
    const id = 501;
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), [image(id, { localUri: null, downloadState: 'failed' })]);
    const listEntries = jest.fn(() => new Promise<LibraryEntry[]>(() => undefined));
    mockAppServices = {
      collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn() },
      libraryChanges: null,
      libraryView: { model: { listEntries }, resolver: { resolve: jest.fn() } },
    };
    setDetailOpenSeed(id, seed);
    const root = createRoot();
    const commits: unknown[] = [];
    try {
      await act(async () => {
        root.render(
          <Profiler id="detail-open-seed" onRender={() => {
            const pending = root.container.queryAll((node: { props: { testID?: string } }) => (
              node.props.testID === `gallery-image-loading-${id}`
            ))[0];
            commits.push(pending?.props.placeholderUri);
          }}>
            <QueryClientProvider client={client}>
              <SafeAreaProvider initialMetrics={{
                frame: { x: 0, y: 0, width: 390, height: 844 },
                insets: { top: 47, right: 0, bottom: 34, left: 0 },
              }}>
                <ImageDetailScreen imageId={id} />
              </SafeAreaProvider>
            </QueryClientProvider>
          </Profiler>,
        );
      });
      expect(commits.length).toBeGreaterThan(0);
      expect(commits[0]).toBe(seed);
    } finally {
      await act(async () => root.unmount());
      setDetailOpenSeed(id, null);
    }
  });

  test('an old in-flight entries read cannot own the rebound follow-up', async () => {
    const staleEntry = detailEntry({
      plaintextSha256: viewDigest('stale-detail-read'),
      sourceImageId: 7,
      residency: 'cloud-only',
      hasLocalOriginal: false,
      localOriginalUri: null,
      originalGenerationId: 'g1',
    });
    let finishOld!: (entries: readonly LibraryEntry[]) => void;
    const oldRead = jest.fn(() => new Promise<readonly LibraryEntry[]>((done) => {
      finishOld = done;
    }));
    const newRead = jest.fn(() => new Promise<readonly LibraryEntry[]>(() => undefined));
    const newResolve = jest.fn(async (): Promise<LibraryRenderSource> => ({
      kind: 'unavailable',
      category: 'offline',
    }));
    const client = queryClient();
    const oldServices = {
      collectionService: {},
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn(async () => [image(7, { downloadState: 'mirrored', localUri: null })]),
      },
      byosStatus: { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      libraryView: { model: { listEntries: oldRead }, resolver: { resolve: jest.fn() } },
    };
    mockAppServices = oldServices;
    const element = () => (
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>
    );
    const rendered = await render(element());
    await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(1));
    mockAppServices = {
      ...oldServices,
      libraryView: { model: { listEntries: newRead }, resolver: { resolve: newResolve } },
      byosStatus: { status: 'ready' },
    };
    await rendered.rerender(element());
    await act(async () => {
      finishOld([staleEntry]);
    });
    await waitFor(() => expect(newRead).toHaveBeenCalledTimes(1));
    expect(oldRead).toHaveBeenCalledTimes(1);
    expect(newResolve).not.toHaveBeenCalled();
    expect(screen.queryByTestId('gallery-image-offline-7')).toBeNull();
  });

  test('a hand-over taken by a replaced entries read is published by the follow-up', async () => {
    const own = 'file:///collection/7.jpg';
    const entry = detailEntry({
      plaintextSha256: viewDigest('handover-detail'),
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
      collectionService: {},
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn(async () => [image(7, { localUri: own, downloadState: 'ready' })]),
        getById,
      },
      libraryChanges: feed,
      libraryView: {
        model: { listEntries: oldRead },
        resolver: {
          resolve: jest.fn(async () => ({ kind: 'unavailable', category: 'object_missing' })),
        },
      },
    };
    mockAppServices = services;
    const element = () => (
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>
    );
    const rendered = await render(element());
    await screen.findByLabelText('全屏图片 7');
    await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(1));
    await act(async () => {
      feed.emit({ kind: 'handed-over', imageId: 7 });
    });
    await waitFor(() => expect(oldRead).toHaveBeenCalledTimes(2));
    mockAppServices = {
      ...services,
      libraryView: {
        model: { listEntries: newRead },
        resolver: {
          resolve: jest.fn(async () => ({ kind: 'unavailable', category: 'object_missing' })),
        },
      },
      byosStatus: { status: 'ready' },
    };
    await rendered.rerender(element());
    await act(async () => {
      finishOld([entry]);
    });
    await waitFor(() => expect(newRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      client.getQueryData<StoredImage[]>(
        jest.requireActual<typeof import('@/features/collection/collection-query')>(
          '@/features/collection/collection-query',
        ).collectionQueryKey(),
      )?.[0]?.downloadState,
    ).toBe('mirrored'));
    expect(getById).toHaveBeenCalledWith(7);
  });

  test.each([
    ['unconfigured', { status: 'unconfigured' }, 'disconnected'],
    [
      'a network lock',
      { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
      'offline',
    ],
  ] as const)('the container sets the overlay access from byosStatus: %s', async (
    _name,
    byosStatus,
    expected,
  ) => {
    mockAppServices = {
      collectionService: {},
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
      byosStatus,
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([]) },
        resolver: { resolve: jest.fn() },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId(`gallery-access-${expected}`)).toBeOnTheScreen();
  });

  test('K6-5 C: 修复入库 re-runs the ingest for that row and never re-downloads', async () => {
    const reingestCollectedOriginal = jest.fn().mockResolvedValue(undefined);
    const retryDownload = jest.fn();
    const repairDownload = jest.fn();
    mockAppServices = {
      collectionService: { repairDownload, retryDownload },
      libraryController: { reingestCollectedOriginal },
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([
          image(7, { libraryError: 'decode_failed' }),
        ]),
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '修复入库' }));

    await waitFor(() => expect(reingestCollectedOriginal).toHaveBeenCalledWith({
      imageId: 7,
      localUri: 'file:///collection/7.jpg',
    }));
    expect(retryDownload).not.toHaveBeenCalled();
    expect(repairDownload).not.toHaveBeenCalled();
  });

  test('force repairs a local decode failure instead of using ordinary retry', async () => {
    const repairMissingFile = jest.fn().mockResolvedValue({
      status: 'ready',
      uri: 'file:///collection/7.jpg',
      reused: false,
    });
    const repairDownload = jest.fn();
    const retryDownload = jest.fn();
    mockAppServices = {
      collectionService: {
        repairMissingFile,
        repairDownload,
        retryDownload,
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent(await screen.findByLabelText('全屏图片 7'), 'error');

    await waitFor(() => expect(repairMissingFile).toHaveBeenCalledWith(7, image(7).localUri));
    expect(repairDownload).not.toHaveBeenCalled();
    expect(retryDownload).not.toHaveBeenCalled();
  });

  test('K2b: repairing a mirrored row calls repairDownload, not retryDownload', async () => {
    const digest = viewDigest('k2b-container-repair');
    const repairDownload = jest.fn().mockResolvedValue({
      status: 'ready',
      uri: 'file:///collection/7.jpg',
      reused: false,
    });
    const retryDownload = jest.fn();
    const mirrored = image(7, { downloadState: 'mirrored', localUri: null });
    mockAppServices = {
      collectionService: {
        repairDownload,
        retryDownload,
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([mirrored]) },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7, hasLocalOriginal: false, originalGenerationId: 'gen-orig' })]) },
        resolver: { resolve: jest.fn(async () => ({ kind: 'unavailable', category: 'integrity', role: 'original' })) },
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '修复离线文件' }));

    await waitFor(() => expect(repairDownload).toHaveBeenCalledWith(7));
    expect(retryDownload).not.toHaveBeenCalled();
  });

  test.each([
    ['分享图片', 'share'],
    ['导出到照片', 'exportToPhotos'],
  ] as const)('publishes the repaired snapshot when %s detects a missing row', async (
    buttonName,
    serviceMethod,
  ) => {
    let collection = [image(7)];
    const failed = image(7, {
      downloadState: 'failed',
      downloadError: 'file_missing',
      localUri: null,
    });
    const missingFile = jest.fn(async () => {
      collection = [failed];
      throw new CollectionServiceError('file_missing', 'missing');
    });
    const collectionService = {
      share: serviceMethod === 'share' ? missingFile : jest.fn(),
      exportToPhotos: serviceMethod === 'exportToPhotos' ? missingFile : jest.fn(),
      retryDownload: jest.fn(),
      deleteSaved: jest.fn(),
      returnToDiscovery: jest.fn(),
    };
    const listCollection = jest.fn(async () => collection);
    mockAppServices = {
      collectionService,
      dataRevision: 0,
      imageRepository: { listCollection },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: buttonName }));

    expect(await screen.findByRole('button', { name: '修复离线文件' })).toBeOnTheScreen();
    expect(listCollection).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(collectionQueryKey())).toEqual([failed]);
  });

  test('opens synchronously from the shared collection snapshot without another database read', async () => {
    const listCollection = jest.fn().mockResolvedValue([image(7)]);
    mockAppServices = {
      collectionService: {
        share: jest.fn(),
        exportToPhotos: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved: jest.fn(),
        returnToDiscovery: jest.fn(),
        repairDownload: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection },
    };
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), [image(7)]);

    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText('全屏图片 7')).toBeOnTheScreen();
    expect(listCollection).not.toHaveBeenCalled();
  });

  test('advances to the next cached image after deletion instead of closing the gallery', async () => {
    let collection = [image(7), image(8)];
    const deleteSaved = jest.fn(async (imageId: number) => {
      const deleted = collection.find((item) => item.id === imageId)!;
      collection = collection.filter((item) => item.id !== imageId);
      return deleted;
    });
    const listCollection = jest.fn(async () => collection);
    mockAppServices = {
      collectionService: {
        share: jest.fn(),
        exportToPhotos: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved,
        returnToDiscovery: jest.fn(),
        repairDownload: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection },
    };
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), collection);
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });

    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(screen.getByRole('button', { name: '删除图片' }));

    expect(await screen.findByText('Artist 8')).toBeOnTheScreen();
    expect(deleteSaved).toHaveBeenCalledWith(7);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(client.getQueryData(collectionQueryKey())).toEqual([image(8)]);
  });

  test('keeps detail paging inside the collection gallery mode that opened it', async () => {
    const collection = [
      image(7),
      image(8, { isNsfw: true }),
      image(9, { isNsfw: true }),
    ];
    mockAppServices = {
      collectionService: {
        share: jest.fn(),
        exportToPhotos: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved: jest.fn(),
        returnToDiscovery: jest.fn(),
        repairDownload: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue(collection) },
    };
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), collection);

    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={8} galleryMode="nsfw" />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('detail-pager').props.data.map(
      (item: { kind?: string; image?: StoredImage; id?: number }) => item.image?.id ?? item.id,
    )).toEqual([8, 9]);
    expect(screen.getByText(/1\/2/)).toBeOnTheScreen();
  });

  // R8.31 (owner ruling A, 2026-09-09): a tag tap opens an unscoped search;
  // only the source tap still filters the collection by provider.
  test('routes tag taps to an unscoped search and source taps to the collection filter', async () => {
    const collection = [image(7, { tags: ['maid', 'provider_only_tag'] })];
    mockAppServices = {
      collectionService: {
        share: jest.fn(),
        exportToPhotos: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved: jest.fn(),
        returnToDiscovery: jest.fn(),
        repairDownload: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue(collection) },
    };
    const client = queryClient();
    client.setQueryData(collectionQueryKey(), collection);
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(screen.getByRole('button', { name: '继续探索标签 maid' }));
    expect(mockRouter.dismissTo).toHaveBeenLastCalledWith({
      pathname: '/search',
      params: { query: 'maid', focus: expect.any(String) },
    });

    await fireEvent.press(screen.getByRole('button', {
      name: '继续探索标签 provider_only_tag',
    }));
    expect(mockRouter.dismissTo).toHaveBeenLastCalledWith({
      pathname: '/search',
      params: { query: 'provider_only_tag', focus: expect.any(String) },
    });

    await fireEvent.press(screen.getByRole('button', {
      name: '查看来源 Waifu.im 的收藏',
    }));
    expect(mockRouter.dismissTo).toHaveBeenLastCalledWith(expect.objectContaining({
      pathname: '/collection',
      params: expect.objectContaining({ provider: 'waifu_im' }),
    }));
  });

  test('K2: sharing a mirrored row goes through shareFile with the library uri', async () => {
    const digest = viewDigest('k2-share');
    const mirrored = image(7, { downloadState: 'mirrored', localUri: null });
    const share = jest.fn();
    const shareFile = jest.fn().mockResolvedValue(undefined);
    const resolve = jest.fn(async (_d: string, intent: string): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: intent === 'full' ? 'file:///library/originals/full.jpg' : 'file:///cache/library/preview.jpg',
      tier: intent === 'full' ? 'local-original' : 'cached-preview',
      role: intent === 'full' ? 'original' : 'preview',
    }));
    mockAppServices = {
      collectionService: { share, shareFile, exportToPhotos: jest.fn(), exportFile: jest.fn(), retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([mirrored]) },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7, hasLocalOriginal: true })]) },
        resolver: { resolve },
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));

    await waitFor(() => expect(shareFile).toHaveBeenCalledWith('file:///library/originals/full.jpg'));
    expect(share).not.toHaveBeenCalled();
  });

  // Board row 45: a mirrored row whose full source is the decrypted cache file
  // (`<scope>-<sha>-original.bin`) stages a typed copy `<sha>.<ext>` for the
  // system; an export releases its copy, a share keeps hers.
  test('row 45: exporting a cloud-only row exports the staged copy and releases it afterwards', async () => {
    const digest = viewDigest('row45-export');
    const cacheUri = `file:///cache/library-cache/scope-${digest}-original.bin`;
    const stagedUri = `file:///cache/library-share/${digest}.jpg`;
    const events: string[] = [];
    const stage = jest.fn(async (sourceUri: string, fileName: string) => {
      events.push(`stage:${sourceUri}:${fileName}`);
      return stagedUri;
    });
    const release = jest.fn(async () => {
      events.push('release');
    });
    const exportFile = jest.fn(async () => {
      events.push('export');
    });
    mockAppServices = {
      collectionService: { share: jest.fn(), shareFile: jest.fn(), exportToPhotos: jest.fn(), exportFile, retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7 })]) },
        resolver: { resolve: cachedOriginalResolver(cacheUri) },
        shareFiles: { stage, release },
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '导出到照片' }));

    await waitFor(() => expect(events).toEqual([
      `stage:${cacheUri}:${digest}.jpg`,
      'export',
      'release',
    ]));
    expect(exportFile).toHaveBeenCalledWith(stagedUri);
    expect(release).toHaveBeenCalledWith(stagedUri);
  });

  test('row 45: the staged copy is released even when the export rejects', async () => {
    const digest = viewDigest('row45-export-failed');
    const cacheUri = `file:///cache/library-cache/scope-${digest}-original.bin`;
    const stagedUri = `file:///cache/library-share/${digest}.jpg`;
    const release = jest.fn().mockResolvedValue(undefined);
    const exportFile = jest.fn(async () => {
      throw new Error('the export failed');
    });
    mockAppServices = {
      collectionService: { share: jest.fn(), shareFile: jest.fn(), exportToPhotos: jest.fn(), exportFile, retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7 })]) },
        resolver: { resolve: cachedOriginalResolver(cacheUri) },
        shareFiles: {
          stage: jest.fn(async () => stagedUri),
          release,
        },
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '导出到照片' }));

    await waitFor(() => expect(exportFile).toHaveBeenCalledWith(stagedUri));
    await waitFor(() => expect(release).toHaveBeenCalledWith(stagedUri));
  });

  test('row 45: sharing a cloud-only row shares the staged copy and never releases it', async () => {
    const digest = viewDigest('row45-share');
    const cacheUri = `file:///cache/library-cache/scope-${digest}-original.bin`;
    const stagedUri = `file:///cache/library-share/${digest}.jpg`;
    const release = jest.fn().mockResolvedValue(undefined);
    const shareFile = jest.fn().mockResolvedValue(undefined);
    mockAppServices = {
      collectionService: { share: jest.fn(), shareFile, exportToPhotos: jest.fn(), exportFile: jest.fn(), retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7 })]) },
        resolver: { resolve: cachedOriginalResolver(cacheUri) },
        shareFiles: {
          stage: jest.fn(async (_sourceUri: string, fileName: string) => `file:///cache/library-share/${fileName}`),
          release,
        },
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));

    await waitFor(() => expect(shareFile).toHaveBeenCalledWith(stagedUri));
    expect(release).not.toHaveBeenCalled();
  });

  test('row 45: a local-original source is handed over unchanged, without staging or release', async () => {
    const digest = viewDigest('row45-local-original');
    const localUri = `file:///data/user/0/app.waifudeck.mobile/files/library/originals/${digest}.jpg`;
    const stage = jest.fn();
    const release = jest.fn();
    const shareFile = jest.fn().mockResolvedValue(undefined);
    mockAppServices = {
      collectionService: { share: jest.fn(), shareFile, exportToPhotos: jest.fn(), exportFile: jest.fn(), retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7 })]) },
        resolver: { resolve: jest.fn(async (_d: string, intent: string): Promise<LibraryRenderSource> => ({
          kind: 'file',
          uri: intent === 'full' ? localUri : 'file:///cache/library/preview.jpg',
          tier: intent === 'full' ? 'local-original' : 'cached-preview',
          role: intent === 'full' ? 'original' : 'preview',
        })) },
        shareFiles: { stage, release },
      },
    };
    const client = queryClient();
    await render(
      <QueryClientProvider client={client}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));

    await waitFor(() => expect(shareFile).toHaveBeenCalledWith(localUri));
    expect(stage).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  test.each([
    ['offline', { status: 'ready' }],
    ['auth_attention', { status: 'ready' }],
    ['auth_attention', { status: 'locked', reason: 'password_required' }],
    ['offline', { status: 'unconfigured' }],
  ] as const)('an unreachable cloud original answers the cloud-only message: %s with %j', async (
    category,
    byosStatus,
  ) => {
    const digest = viewDigest(`s4-container-${category}-${byosStatus.status}`);
    const share = jest.fn();
    const shareFile = jest.fn();
    mockAppServices = {
      collectionService: {
        share,
        shareFile,
        exportToPhotos: jest.fn(),
        exportFile: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved: jest.fn(),
        returnToDiscovery: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      byosStatus,
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7 })]) },
        resolver: { resolve: jest.fn().mockResolvedValue({ kind: 'unavailable', category }) },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));

    expect(await screen.findByText(z('detail.errorCloudOnlyOffline'))).toBeOnTheScreen();
    expect(shareFile).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  test('a disconnected phone is told to reconnect its library', async () => {
    const digest = viewDigest('s4-container-disconnected');
    const share = jest.fn();
    const exportToPhotos = jest.fn();
    mockAppServices = {
      collectionService: {
        share,
        shareFile: jest.fn(),
        exportToPhotos,
        exportFile: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved: jest.fn(),
        returnToDiscovery: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      byosStatus: { status: 'unconfigured' },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7 })]) },
        resolver: { resolve: jest.fn().mockResolvedValue({ kind: 'unavailable', category: 'auth_attention' }) },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));
    expect(await screen.findByText(z('detail.errorCloudOnlyDisconnected'))).toBeOnTheScreen();
    expect(share).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: '导出到照片' }));
    expect(await screen.findByText(z('detail.errorCloudOnlyDisconnected'))).toBeOnTheScreen();
    expect(exportToPhotos).not.toHaveBeenCalled();
  });

  test('no cloud original keeps the repair message', async () => {
    const digest = viewDigest('s4-container-object-missing');
    mockAppServices = {
      collectionService: {
        share: jest.fn(),
        shareFile: jest.fn(),
        exportToPhotos: jest.fn(),
        exportFile: jest.fn(),
        retryDownload: jest.fn(),
        deleteSaved: jest.fn(),
        returnToDiscovery: jest.fn(),
      },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]) },
      byosStatus: { status: 'ready' },
      libraryView: {
        model: { listEntries: jest.fn().mockResolvedValue([detailEntry({ plaintextSha256: digest, sourceImageId: 7, originalGenerationId: null })]) },
        resolver: { resolve: jest.fn().mockResolvedValue({ kind: 'unavailable', category: 'object_missing' }) },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));
    expect(await screen.findByText(z('detail.errorNotReady'))).toBeOnTheScreen();
  });

  test('the newest entry of an image wins when sharing', async () => {
    const d1 = viewDigest('share-old');
    const d2 = viewDigest('share-new');
    const mirrored = image(7, { downloadState: 'mirrored', localUri: null });
    const share = jest.fn();
    const shareFile = jest.fn().mockResolvedValue(undefined);
    const resolve = jest.fn(async (digest: string, intent: string): Promise<LibraryRenderSource> => ({
      kind: 'file',
      uri: `file:///library/${digest}-${intent}.jpg`,
      tier: intent === 'full' ? 'local-original' : 'cached-preview',
      role: intent === 'full' ? 'original' : 'preview',
    }));
    mockAppServices = {
      collectionService: { share, shareFile, exportToPhotos: jest.fn(), exportFile: jest.fn(), retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([mirrored]) },
      libraryView: {
        model: {
          listEntries: jest.fn().mockResolvedValue([
            detailEntry({ plaintextSha256: d2, sourceImageId: 7, createdAt: 2_000 }),
            detailEntry({ plaintextSha256: d1, sourceImageId: 7, createdAt: 1_000 }),
          ]),
        },
        resolver: { resolve },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(d2, 'detail'));
    await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));

    await waitFor(() => expect(shareFile).toHaveBeenCalledWith(`file:///library/${d2}-full.jpg`));
    expect(resolve).toHaveBeenCalledWith(d2, 'full');
    expect(resolve.mock.calls.some(([digest]) => digest === d1)).toBe(false);
    expect(share).not.toHaveBeenCalled();
  });

  test('board #9: a rejected first entries read still releases a file-less page to the provider', async () => {
    const resolve = jest.fn();
    mockAppServices = {
      collectionService: { share: jest.fn(), shareFile: jest.fn(), exportToPhotos: jest.fn(), exportFile: jest.fn(), retryDownload: jest.fn(), deleteSaved: jest.fn(), returnToDiscovery: jest.fn() },
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'failed', localUri: null })]),
      },
      libraryView: {
        model: { listEntries: jest.fn().mockRejectedValue(new Error('entries read failed')) },
        resolver: { resolve },
      },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );

    // The widened guard must not hold the page forever when the read fails.
    await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
      uri: 'https://cdn.example.com/7.jpg',
    }));
    expect(resolve).not.toHaveBeenCalled();
  });

  /**
   * K6-2b (spec §2 G3). Same gap as the grid's: `dataRevision` never moves for
   * an ingest or a protect, and this screen has no focus effect at all — it is
   * pushed, not tabbed to — so before the feed a detail view opened during an
   * upload showed that upload's starting state until the user backed out.
   */
  test('K6-2b: re-reads the library entries when the composition announces a change', async () => {
    const digest = viewDigest('k62b-detail');
    const listeners = new Set<(change: { kind: string }) => void>();
    const libraryChanges = {
      subscribe: (listener: (change: { kind: string }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const listEntries = jest.fn().mockResolvedValue([
      detailEntry({ plaintextSha256: digest, sourceImageId: 7 }),
    ]);
    mockAppServices = {
      collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
      dataRevision: 0,
      imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
      libraryChanges,
      libraryView: {
        model: { listEntries },
        resolver: { resolve: jest.fn(async () => ({
          kind: 'file',
          uri: 'file:///cache/library/detail.jpg',
          tier: 'cached-preview',
          role: 'preview',
        })) },
      },
    };
    const view = await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listEntries).toHaveBeenCalled());
    listEntries.mockClear();
    expect(listeners.size).toBe(1);

    await act(async () => {
      for (const listener of [...listeners]) listener({ kind: 'protected' });
    });

    expect(listEntries).toHaveBeenCalledTimes(1);

    // And the subscription is released with the screen, so a later upload
    // cannot set state on an unmounted view.
    await act(async () => { await view.unmount(); });
    expect(listeners.size).toBe(0);
  });

  describe('board #27 S1b: a hand-over republishes the row after the entries read', () => {
    const U = 'file:///data/library/originals/handed.jpg';
    const handedEntry = () => detailEntry({
      plaintextSha256: viewDigest('s1b-detail-handed'),
      sourceImageId: 7,
      residency: 'local-original',
      hasLocalOriginal: true,
      localOriginalUri: U,
    });

    function changeFeed() {
      const listeners = new Set<(change: { kind: string; imageId?: number }) => void>();
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

    function renderScreen(wrapper?: (children: React.ReactElement) => React.ReactElement) {
      const screenElement = (
        <QueryClientProvider client={queryClient()}>
          <SafeAreaProvider
            initialMetrics={{
              frame: { x: 0, y: 0, width: 390, height: 844 },
              insets: { top: 47, right: 0, bottom: 34, left: 0 },
            }}>
            <ImageDetailScreen imageId={7} />
          </SafeAreaProvider>
        </QueryClientProvider>
      );
      return render(wrapper === undefined ? screenElement : wrapper(screenElement));
    }

    test('a handed-over row is republished only after the entries read that follows it', async () => {
      const feed = changeFeed();
      const gates: (() => void)[] = [];
      let toHold = 0;
      const listEntries = jest.fn(async () => {
        if (toHold > 0) {
          toHold -= 1;
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        return [handedEntry()];
      });
      const getById = jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null }));
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([
            image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
          ]),
          getById,
        },
        libraryChanges: feed,
        libraryView: {
          model: { listEntries },
          resolver: { resolve: jest.fn(async () => ({
            kind: 'file', uri: 'file:///cache/never.jpg', tier: 'cached-preview', role: 'preview',
          })) },
        },
      };
      await renderScreen();
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source)
        .toEqual({ uri: 'file:///collection/7.jpg' }));
      await act(async () => { await Promise.resolve(); });

      toHold = 1;
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd'.repeat(64) });
      });
      await waitFor(() => expect(gates).toHaveLength(1));
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(getById).not.toHaveBeenCalled();

      await act(async () => { gates.shift()!(); });

      await waitFor(() => expect(getById).toHaveBeenCalledWith(7));
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: U }));
    });

    test('hand-overs recorded during a running read wait for the next one, which republishes them in one snapshot', async () => {
      const feed = changeFeed();
      const gates: (() => void)[] = [];
      let toHold = 0;
      const listEntries = jest.fn(async () => {
        if (toHold > 0) {
          toHold -= 1;
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        return [handedEntry()];
      });
      const getById = jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null }));
      const listCollection = jest.fn().mockResolvedValue([
        image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
        image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
      ]);
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: { listCollection, getById },
        libraryChanges: feed,
        libraryView: {
          model: { listEntries },
          resolver: { resolve: jest.fn(async () => ({
            kind: 'file', uri: 'file:///cache/never.jpg', tier: 'cached-preview', role: 'preview',
          })) },
        },
      };
      await renderScreen();
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });
      listCollection.mockClear();

      // An ordinary change starts a read that stays held; so does the follow-up.
      toHold = 2;
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(gates).toHaveLength(1));
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd'.repeat(64) });
        feed.emit({ kind: 'handed-over', imageId: 8, plaintextSha256: 'd'.repeat(64) });
      });

      await act(async () => { gates.shift()!(); });
      await waitFor(() => expect(gates).toHaveLength(1));
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      expect(listCollection).not.toHaveBeenCalled();
      expect(getById).not.toHaveBeenCalled();

      await act(async () => { gates.shift()!(); });

      await waitFor(() => expect(listCollection).toHaveBeenCalledTimes(1));
      expect(getById).not.toHaveBeenCalled();
    });

    test('a read after the follow-up publishes nothing it already published', async () => {
      const feed = changeFeed();
      const gates: (() => void)[] = [];
      let toHold = 0;
      const listEntries = jest.fn(async () => {
        if (toHold > 0) {
          toHold -= 1;
          await new Promise<void>((resolve) => { gates.push(resolve); });
        }
        return [handedEntry()];
      });
      const getById = jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null }));
      const listCollection = jest.fn().mockResolvedValue([
        image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
        image(8, { downloadState: 'ready', localUri: 'file:///collection/8.jpg' }),
      ]);
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: { listCollection, getById },
        libraryChanges: feed,
        libraryView: {
          model: { listEntries },
          resolver: { resolve: jest.fn(async () => ({
            kind: 'file', uri: 'file:///cache/never.jpg', tier: 'cached-preview', role: 'preview',
          })) },
        },
      };
      await renderScreen();
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });
      listCollection.mockClear();

      // Both hand-overs are published by the follow-up read, in one snapshot.
      toHold = 2;
      await act(async () => { feed.emit({ kind: 'protected' }); });
      await waitFor(() => expect(gates).toHaveLength(1));
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd'.repeat(64) });
        feed.emit({ kind: 'handed-over', imageId: 8, plaintextSha256: 'd'.repeat(64) });
      });
      await act(async () => { gates.shift()!(); });
      await waitFor(() => expect(gates).toHaveLength(1));
      await act(async () => { gates.shift()!(); });
      await waitFor(() => expect(listCollection).toHaveBeenCalledTimes(1));

      // A later ordinary change (no imageId) starts a third read; it has taken
      // nothing, so it publishes neither a row nor a snapshot.
      listEntries.mockClear();
      await act(async () => { feed.emit({ kind: 'ingested', plaintextSha256: 'x' }); });
      await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(listCollection).toHaveBeenCalledTimes(1);
      expect(getById).not.toHaveBeenCalled();
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
        const feed = changeFeed();
        const OWN8 = 'file:///collection/8.jpg';
        const getById = jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null }));
        mockAppServices = {
          collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
          dataRevision: 0,
          imageRepository: {
            listCollection: jest.fn().mockResolvedValue([
              image(7, { downloadState: 'mirrored', localUri: null }),
              image(8, { downloadState: 'ready', localUri: OWN8 }),
            ]),
            getById,
          },
          libraryChanges: feed,
          libraryView: {
            model: {
              listEntries: jest.fn(async () => [
                handedEntry(),
                detailEntry({
                  plaintextSha256: viewDigest('s1b-detail-handed-8'),
                  sourceImageId: 8,
                  residency: 'local-original',
                  hasLocalOriginal: true,
                  localOriginalUri: 'file:///data/library/originals/eight.jpg',
                }),
              ]),
            },
            resolver: { resolve: jest.fn(async (): Promise<LibraryRenderSource> => ({
              kind: 'unavailable', category: 'object_missing',
            })) },
          },
        };
        await renderScreen();
        await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: U }));

        // The fast path fails: the resolver serves the page instead.
        await act(async () => { (screen.getByLabelText('全屏图片 7').props.onError as () => void)(); });
        await waitFor(() => expect(screen.queryByLabelText('全屏图片 7')?.props.source)
          .not.toEqual({ uri: U }));

        // The row's state is unchanged (mirrored), so only the hand-over can
        // offer the fast path afresh.
        await act(async () => {
          feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd'.repeat(64) });
        });

        await waitFor(() => expect(getById).toHaveBeenCalledWith(7));
        await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: U }));
      } finally {
        loopGuard.mockRestore();
      }
    });

    test('a second hand-over clears a second failed fast path', async () => {
      const feed = changeFeed();
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([
            image(7, { downloadState: 'mirrored', localUri: null }),
          ]),
          getById: jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null })),
        },
        libraryChanges: feed,
        libraryView: {
          model: { listEntries: jest.fn(async () => [handedEntry()]) },
          resolver: { resolve: jest.fn(async (): Promise<LibraryRenderSource> => ({
            kind: 'unavailable', category: 'object_missing',
          })) },
        },
      };
      await renderScreen();
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: U }));

      for (let round = 0; round < 2; round += 1) {
        await act(async () => { (screen.getByLabelText('全屏图片 7').props.onError as () => void)(); });
        await waitFor(() => expect(screen.queryByLabelText('全屏图片 7')?.props.source)
          .not.toEqual({ uri: U }));
        await act(async () => {
          feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd'.repeat(64) });
        });
        await waitFor(() => expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: U }));
      }
    });

    test('only a handed-over change is a hand-over, whatever else it carries', async () => {
      const feed = changeFeed();
      const getById = jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null }));
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([
            image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
          ]),
          getById,
        },
        libraryChanges: feed,
        libraryView: {
          model: { listEntries: jest.fn(async () => [handedEntry()]) },
          resolver: { resolve: jest.fn(async () => ({
            kind: 'file', uri: 'file:///cache/never.jpg', tier: 'cached-preview', role: 'preview',
          })) },
        },
      };
      await renderScreen();
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });

      await act(async () => { feed.emit({ kind: 'protected', imageId: 7 }); });
      for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(getById).not.toHaveBeenCalled();
    });

    test('a failed entries read still publishes the ids it took', async () => {
      const feed = changeFeed();
      const listEntries = jest.fn(async () => [handedEntry()]);
      const getById = jest.fn(async (id: number) => image(id, { downloadState: 'mirrored', localUri: null }));
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: {
          listCollection: jest.fn().mockResolvedValue([
            image(7, { downloadState: 'ready', localUri: 'file:///collection/7.jpg' }),
          ]),
          getById,
        },
        libraryChanges: feed,
        libraryView: {
          model: { listEntries },
          resolver: { resolve: jest.fn(async () => ({
            kind: 'file', uri: 'file:///cache/never.jpg', tier: 'cached-preview', role: 'preview',
          })) },
        },
      };
      await renderScreen();
      await waitFor(() => expect(screen.getByLabelText('全屏图片 7')).toBeOnTheScreen());
      await act(async () => { await Promise.resolve(); });

      // The collection file is gone, so `mirrored` is the row's truth even
      // though the read that follows the hand-over rejects.
      listEntries.mockImplementationOnce(() => Promise.reject(new Error('read failed')));
      await act(async () => {
        feed.emit({ kind: 'handed-over', imageId: 7, plaintextSha256: 'd'.repeat(64) });
      });

      await waitFor(() => expect(getById).toHaveBeenCalledWith(7));
    });

    test('the viewer container registers as a hand-over publisher while mounted', async () => {
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([image(7)]) },
      };
      const release = jest.fn();
      const register = jest.fn(() => release);

      const rendered = await renderScreen((children) => (
        <HandedOverPublishersContext value={{ register, count: () => 0 }}>
          {children}
        </HandedOverPublishersContext>
      ));
      await act(async () => { await Promise.resolve(); });

      expect(register).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();

      await act(async () => { await rendered.unmount(); });

      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  test('the detail container keeps a mirrored row library-owned until the first entries read settles', async () => {
    const digest = viewDigest('k2-entries-wait');
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
      collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([image(7, { downloadState: 'mirrored', localUri: null })]),
      },
      libraryChanges: null,
      libraryView: { model: { listEntries }, resolver: { resolve } },
    };
    await render(
      <QueryClientProvider client={queryClient()}>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 47, right: 0, bottom: 34, left: 0 },
          }}>
          <ImageDetailScreen imageId={7} />
        </SafeAreaProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listEntries).toHaveBeenCalled());
    // Entries still in flight: the page is its colour block, no provider load.
    expect(await screen.findByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
    expect(resolve).not.toHaveBeenCalled();

    await act(async () => settleEntries([
      detailEntry({ plaintextSha256: digest, sourceImageId: 7, residency: 'local-original', hasLocalOriginal: true }),
    ]));
    expect(await screen.findByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
    expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({ uri: 'file:///library/originals/wait.jpg' });
  });

  test('ImageDetailScreen passes the seed read for its imageId', async () => {
    const seed = 'file:///library/thumbnails/screen.webp';
    setDetailOpenSeed(51, seed);
    const listEntries = jest.fn(() => new Promise<LibraryEntry[]>(() => undefined));
    mockAppServices = {
      collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
      dataRevision: 0,
      imageRepository: {
        listCollection: jest.fn().mockResolvedValue([
          image(51, { downloadState: 'failed', localUri: null }),
        ]),
      },
      libraryChanges: null,
      libraryView: { model: { listEntries }, resolver: { resolve: jest.fn() } },
    };
    try {
      await render(
        <QueryClientProvider client={queryClient()}>
          <SafeAreaProvider
            initialMetrics={{
              frame: { x: 0, y: 0, width: 390, height: 844 },
              insets: { top: 47, right: 0, bottom: 34, left: 0 },
            }}>
            <ImageDetailScreen imageId={51} />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(listEntries).toHaveBeenCalled());
      expect(screen.getByTestId('gallery-image-loading-51').props.placeholderUri).toBe(seed);
      expect(screen.getByTestId('gallery-image-loading-51').props.overridePending).toBe(true);
    } finally {
      setDetailOpenSeed(51, null);
    }
  });

  describe('N6-C: import viewer, mixed grid paging, manual date header, and 3-action commands', () => {
    const impDigest = viewDigest('n6c-import-main');
    const impDigest2 = viewDigest('n6c-import-second');

    function importEntry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
      return detailEntry({
        plaintextSha256: impDigest,
        sourceImageId: null,
        origin: 'import',
        hasImportMembership: true,
        importClassification: 'safe',
        importDeletedAt: null,
        associatedProviderImageIds: [],
        format: 'png',
        width: 1200,
        height: 1600,
        byteSize: 256_000,
        residency: 'local-original',
        hasLocalOriginal: true,
        localOriginalUri: `file:///data/library/originals/${impDigest}.png`,
        originalGenerationId: 'gen-imp-1',
        createdAt: new Date(2026, 9, 6, 12, 0, 0).getTime(),
        ...overrides,
      });
    }

    test('isValidImportSha256 and parseDetailGalleryQuery validate 64-hex digests and preserve provider: imports', () => {
      expect(isValidImportSha256('a'.repeat(64))).toBe(true);
      expect(isValidImportSha256('0123456789abcdef'.repeat(4))).toBe(true);
      expect(isValidImportSha256('A'.repeat(64))).toBe(false);
      expect(isValidImportSha256('a'.repeat(63))).toBe(false);
      expect(isValidImportSha256('7')).toBe(false);
      expect(isValidImportSha256(7)).toBe(false);

      expect(parseDetailGalleryQuery({
        provider: 'imports',
        mode: 'nsfw',
        sort: 'fileSize',
        query: 'maid',
        field: 'tag',
      })).toEqual({
        provider: 'imports',
        mode: 'nsfw',
        sort: 'fileSize',
        text: 'maid',
        field: 'tag',
      });
      expect(parseDetailGalleryQuery({ provider: 'unknown_source' }).provider).toBe('all');
    });

    test('formatImportHeaderDate formats local YYYY-MM-DD manually even when global Intl is removed, and returns null for invalid timestamps', () => {
      const originalIntl = globalThis.Intl;
      try {
        // @ts-expect-error simulating Hermes / environment without Intl
        delete globalThis.Intl;
        const ts = new Date(2026, 0, 5, 14, 30, 0).getTime();
        expect(formatImportHeaderDate(ts)).toBe('2026-01-05');
        expect(formatImportHeaderDate(0)).toBeNull();
        expect(formatImportHeaderDate(-100)).toBeNull();
        expect(formatImportHeaderDate(Number.NaN)).toBeNull();
        expect(formatImportHeaderDate(Number.POSITIVE_INFINITY)).toBeNull();
      } finally {
        globalThis.Intl = originalIntl;
      }
    });

    test('renders import header with manual date (or fallback without date when createdAt <= 0) across 4 locales and exposes only 分享 / 保存到相册 / 删除', async () => {
      const entryDated = importEntry({
        createdAt: new Date(2026, 9, 6, 12, 0, 0).getTime(),
      });
      mockAppServices = {
        collectionService: {
          share: jest.fn(),
          shareFile: jest.fn(),
          exportToPhotos: jest.fn(),
          exportFile: jest.fn(),
          retryDownload: jest.fn(),
          deleteSaved: jest.fn(),
          returnToDiscovery: jest.fn(),
        },
        libraryController: {
          purgeImportedAsset: jest.fn().mockResolvedValue(undefined),
        },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        libraryView: {
          model: { listEntries: jest.fn().mockResolvedValue([entryDated]) },
          resolver: { resolve: jest.fn() },
          shareFiles: { stage: jest.fn(), release: jest.fn() },
        },
      };

      const client = queryClient();
      const rendered = await render(
        <QueryClientProvider client={client}>
          <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
            <ImageDetailScreen importSha256={impDigest} />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );

      expect(await screen.findByTestId('detail-import-header')).toHaveTextContent(
        '导入的图片 · 2026-10-06',
      );
      expect(screen.getByTestId('detail-counter')).toHaveTextContent('1200 x 1600 · PNG · 1/1');
      // Fast-path local original renders immediately without calling resolver
      expect(screen.getByLabelText(`全屏图片 ${impDigest}`).props.source).toEqual({
        uri: `file:///data/library/originals/${impDigest}.png`,
      });

      // Exactly 3 commands: 分享, 保存到相册, 删除
      expect(screen.getByRole('button', { name: '分享图片' })).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: '保存到相册' })).toBeOnTheScreen();
      expect(screen.getByText('保存到相册')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: '删除图片' })).toBeOnTheScreen();

      // Absent provider-only controls/metadata
      expect(screen.queryByText('未知画师')).toBeNull();
      expect(screen.queryByRole('button', { name: '打开来源' })).toBeNull();
      expect(screen.queryByRole('button', { name: '退回发现' })).toBeNull();
      expect(screen.queryByRole('button', { name: '修复离线文件' })).toBeNull();
      expect(screen.queryByRole('button', { name: '修复入库' })).toBeNull();
      expect(screen.queryByLabelText('图片标签')).toBeNull();

      // Locale check: English
      await act(async () => i18n.changeLanguage('en'));
      expect(screen.getByTestId('detail-import-header')).toHaveTextContent(
        'Imported image · 2026-10-06',
      );
      expect(screen.getByText('Save to Photos')).toBeOnTheScreen();
      await act(async () => i18n.changeLanguage('zh-Hans'));

      // Invalid legacy createdAt <= 0 renders only 导入的图片 without inventing a date
      mockAppServices = {
        ...mockAppServices,
        dataRevision: 1,
        libraryView: {
          ...mockAppServices.libraryView,
          model: {
            listEntries: jest.fn().mockResolvedValue([importEntry({ createdAt: 0 })]),
          },
        },
      };
      await rendered.rerender(
        <QueryClientProvider client={client}>
          <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
            <ImageDetailScreen importSha256={impDigest} />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId('detail-import-header')).toHaveTextContent(/^导入的图片$/),
      );
    });

    test('pages across provider → import → provider in the unified current-grid order and switches header/commands per page', async () => {
      const p1 = image(10, { decidedAt: 3_000, artistName: 'Artist Ten', tags: ['neko'] });
      const imp = importEntry({ createdAt: 2_000 });
      const p2 = image(20, { decidedAt: 1_000, artistName: 'Artist Twenty', tags: ['fox'] });

      mockAppServices = {
        collectionService: {
          share: jest.fn(),
          shareFile: jest.fn(),
          exportToPhotos: jest.fn(),
          exportFile: jest.fn(),
          retryDownload: jest.fn(),
          deleteSaved: jest.fn(),
          returnToDiscovery: jest.fn(),
        },
        libraryController: {
          purgeImportedAsset: jest.fn().mockResolvedValue(undefined),
        },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([p1, p2]) },
        libraryView: {
          model: { listEntries: jest.fn().mockResolvedValue([imp]) },
          resolver: { resolve: jest.fn() },
          shareFiles: { stage: jest.fn(), release: jest.fn() },
        },
      };

      const client = queryClient();
      client.setQueryData(collectionQueryKey(), [p1, p2]);
      await render(
        <QueryClientProvider client={client}>
          <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
            <ImageDetailScreen
              imageId={10}
              galleryQuery={{ text: '', field: 'all', mode: 'mixed', provider: 'all', sort: 'newest' }}
            />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );

      const pager = await screen.findByTestId('detail-pager');
      await waitFor(() =>
        expect(pager.props.data.map((it: { key: string }) => it.key)).toEqual([
          'image:10',
          `import:${impDigest}`,
          'image:20',
        ]),
      );
      expect(screen.getByText('Artist Ten')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: '退回发现' })).toBeOnTheScreen();

      // Swipe to page 1 (the import)
      await act(async () => {
        pager.props.onMomentumScrollEnd({
          nativeEvent: { contentOffset: { x: pager.props.snapToInterval * 1, y: 0 } },
        });
      });
      expect(screen.getByTestId('detail-import-header')).toHaveTextContent(/导入的图片/);
      expect(screen.getByTestId('detail-position-2-of-3')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: '保存到相册' })).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: '退回发现' })).toBeNull();

      // Swipe to page 2 (the second provider image)
      await act(async () => {
        pager.props.onMomentumScrollEnd({
          nativeEvent: { contentOffset: { x: pager.props.snapToInterval * 2, y: 0 } },
        });
      });
      expect(screen.getByText('Artist Twenty')).toBeOnTheScreen();
      expect(screen.getByTestId('detail-position-3-of-3')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: '退回发现' })).toBeOnTheScreen();
    });

    test('import share and Save-to-Photos resolve full, stage non-local-original files as <sha256>.<ext>, release on export finally, and retain on share', async () => {
      const cacheUri = `file:///cache/library-cache/scope-${impDigest}-original.bin`;
      const stagedUri = `file:///cache/library-share/${impDigest}.png`;
      const stage = jest.fn(async (_src: string, name: string) => `file:///cache/library-share/${name}`);
      const release = jest.fn().mockResolvedValue(undefined);
      const shareFile = jest.fn().mockResolvedValue(undefined);
      const exportFile = jest.fn().mockResolvedValue(undefined);
      const resolve = jest.fn(async (_d: string, intent: string): Promise<LibraryRenderSource> => ({
        kind: 'file',
        uri: intent === 'full' ? cacheUri : 'file:///cache/library/preview.webp',
        tier: intent === 'full' ? 'cloud-original' : 'cached-preview',
        role: intent === 'full' ? 'original' : 'preview',
      }));

      mockAppServices = {
        collectionService: {
          share: jest.fn(),
          shareFile,
          exportToPhotos: jest.fn(),
          exportFile,
          retryDownload: jest.fn(),
          deleteSaved: jest.fn(),
          returnToDiscovery: jest.fn(),
        },
        libraryController: {
          purgeImportedAsset: jest.fn().mockResolvedValue(undefined),
        },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        libraryView: {
          model: {
            listEntries: jest.fn().mockResolvedValue([
              importEntry({
                format: 'png',
                residency: 'cloud-only',
                hasLocalOriginal: false,
                localOriginalUri: null,
              }),
            ]),
          },
          resolver: { resolve },
          shareFiles: { stage, release },
        },
      };

      await render(
        <QueryClientProvider client={queryClient()}>
          <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
            <ImageDetailScreen importSha256={impDigest} />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );

      // 1. Share: resolves 'full', stages <sha256>.png, calls shareFile, does NOT release
      await fireEvent.press(await screen.findByRole('button', { name: '分享图片' }));
      await waitFor(() => expect(shareFile).toHaveBeenCalledWith(stagedUri));
      expect(stage).toHaveBeenCalledWith(cacheUri, `${impDigest}.png`);
      expect(release).not.toHaveBeenCalled();

      // 2. Save to Photos (export): resolves 'full', stages <sha256>.png, calls exportFile, releases in finally
      stage.mockClear();
      await fireEvent.press(screen.getByRole('button', { name: '保存到相册' }));
      await waitFor(() => expect(exportFile).toHaveBeenCalledWith(stagedUri));
      expect(stage).toHaveBeenCalledWith(cacheUri, `${impDigest}.png`);
      expect(release).toHaveBeenCalledWith(stagedUri);
      expect(await screen.findByText('已保存到系统相册')).toBeOnTheScreen();

      // 3. Failed export still releases staged file in finally
      release.mockClear();
      exportFile.mockRejectedValueOnce(new Error('disk full'));
      await fireEvent.press(screen.getByRole('button', { name: '保存到相册' }));
      await waitFor(() => expect(release).toHaveBeenCalledWith(stagedUri));
      expect(await screen.findByTestId('detail-action-error')).toBeOnTheScreen();
    });

    test('deleting an import in the viewer calls purgeImportedAsset, keeps the pager mounted, and advances to the next remaining item', async () => {
      let entries: LibraryEntry[] = [
        importEntry({ plaintextSha256: impDigest, createdAt: 3_000 }),
        importEntry({ plaintextSha256: impDigest2, createdAt: 2_000, width: 800, height: 600 }),
      ];
      const purgeImportedAsset = jest.fn(async (sha: string) => {
        entries = entries.filter((e) => e.plaintextSha256 !== sha);
      });
      const listEntries = jest.fn(async () => entries);
      jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
        buttons?.find((b) => b.style === 'destructive')?.onPress?.();
      });

      mockAppServices = {
        collectionService: {
          share: jest.fn(),
          shareFile: jest.fn(),
          exportToPhotos: jest.fn(),
          exportFile: jest.fn(),
          retryDownload: jest.fn(),
          deleteSaved: jest.fn(),
          returnToDiscovery: jest.fn(),
        },
        libraryController: { purgeImportedAsset },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        libraryView: {
          model: { listEntries },
          resolver: { resolve: jest.fn() },
          shareFiles: { stage: jest.fn(), release: jest.fn() },
        },
      };

      await render(
        <QueryClientProvider client={queryClient()}>
          <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
            <ImageDetailScreen
              importSha256={impDigest}
              galleryQuery={{ text: '', field: 'all', mode: 'mixed', provider: 'imports', sort: 'newest' }}
            />
          </SafeAreaProvider>
        </QueryClientProvider>,
      );

      const pager = await screen.findByTestId('detail-pager');
      await waitFor(() => expect(screen.getByTestId('detail-position-1-of-2')).toBeOnTheScreen());

      await fireEvent.press(screen.getByRole('button', { name: '删除图片' }));

      await waitFor(() => expect(purgeImportedAsset).toHaveBeenCalledWith(impDigest));
      await waitFor(() => expect(screen.getByTestId('detail-position-1-of-1')).toBeOnTheScreen());
      expect(screen.getByTestId('detail-counter')).toHaveTextContent('800 x 600 · PNG · 1/1');
      expect(screen.getByTestId('detail-pager')).toBe(pager);
    });

    test('ImageDetailScreen passes the seed read for its importSha256', async () => {
      const seed = `file:///library/thumbnails/${impDigest}.webp`;
      setDetailOpenSeed(impDigest, seed);
      const listEntries = jest.fn().mockResolvedValue([
        importEntry({
          residency: 'cloud-only',
          hasLocalOriginal: false,
          localOriginalUri: null,
        }),
      ]);
      const resolve = jest.fn(() => new Promise<LibraryRenderSource>(() => undefined));
      mockAppServices = {
        collectionService: { repairDownload: jest.fn(), retryDownload: jest.fn() },
        dataRevision: 0,
        imageRepository: { listCollection: jest.fn().mockResolvedValue([]) },
        libraryChanges: null,
        libraryView: { model: { listEntries }, resolver: { resolve } },
      };
      try {
        await render(
          <QueryClientProvider client={queryClient()}>
            <SafeAreaProvider
              initialMetrics={{
                frame: { x: 0, y: 0, width: 390, height: 844 },
                insets: { top: 47, right: 0, bottom: 34, left: 0 },
              }}>
              <ImageDetailScreen importSha256={impDigest} />
            </SafeAreaProvider>
          </QueryClientProvider>,
        );
        const pending = await screen.findByTestId(`gallery-image-loading-${impDigest}`);
        expect(pending.props.placeholderUri).toBe(seed);
        expect(pending.props.overridePending).toBe(true);
      } finally {
        setDetailOpenSeed(impDigest, null);
      }
    });
  });
});
