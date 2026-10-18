/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Profiler, type ReactElement } from 'react';
import { createRoot } from 'test-renderer';
import type { StoredImage } from '@/features/images/image-repository';
import i18n from '@/i18n';
import zhHans from '@/i18n/locales/zh-Hans';
import { REMOTE_LOAD_RETRY_DELAYS_MS } from '@/components/use-remote-load-retry';
import {
  entryToGalleryMedia,
  GalleryImage,
  isAnimatedRow,
} from '@/screens/image-detail/gallery-image';
import { GalleryImage as Task1GalleryImage } from '@/test/gallery-image-at-e31f55ba';

beforeEach(async () => i18n.changeLanguage('zh-Hans'));

type HostNode = {
  props: Record<string, unknown> & {
    style?: Record<string, unknown>;
    pointerEvents?: string;
    accessible?: boolean;
  };
  parent: HostNode | null;
  children: (HostNode | string)[];
};

function host(node: unknown): HostNode {
  if (node == null || typeof node === 'string' || typeof node !== 'object' || !('props' in node)) {
    throw new Error('expected a host element');
  }
  return node as HostNode;
}

function styleOf(node: HostNode): Record<string, unknown> {
  if (!node.props.style) throw new Error('missing style');
  return node.props.style;
}

let mockUseImageError: ((error: Error) => void) | undefined;
let mockUseImageDeps: unknown[] | undefined;
// R8.28: the viewer now hands useImage an ImageSource for provider-remote
// bytes (so the load can carry the provider's headers) and keeps a plain
// string for local/override files. The mock records the argument verbatim.
type MockImageSource = string | { uri: string; headers?: Record<string, string> };
let mockUseImageSource: MockImageSource | undefined;
// Hold useImage at "no image yet" so a test can see the colour box before the
// picture is decoded. Default off: today's tests still get a loaded ref.
let mockUseImageHold = false;
// Board #6: every useImage call, the ref useImage hands back (so a test can make
// it report `isAnimated`), every <Image> render's props, and how many <Image>
// elements have mounted (a changed React key is a new mount).
let mockUseImageCalls: MockImageSource[] = [];
let mockUseImageAnimated = false;
let mockImageRenders: Record<string, unknown>[] = [];
let mockImageMounts = 0;
// Board #6 layers: the <Image> elements alive right now, by source uri.
let mockLiveImages: string[] = [];
// One record per mounted <Image> instance, keyed by the testID it mounted with.
let mockMountLog: { testID: string | undefined }[] = [];
// When set, useImage keeps returning the previous ref while the requested source changes.
let mockStickPreviousImage = false;
let mockPreviousImage: { uri?: string; isAnimated?: boolean; headers?: Record<string, string> } | null = null;
// One test renders expo-image's real JS wrapper over a stubbed native view.
let mockUseActualExpoImage = false;

jest.mock('expo-image', () => {
  const core = require('expo-modules-core');
  const { View } = require('react-native');
  const { useEffect } = require('react');
  jest.spyOn(core, 'requireNativeViewManager').mockImplementation(() => View);
  const ActualExpoImage = jest.requireActual('expo-image/src/ExpoImage').default;
  const RecordingImage = (props: Record<string, unknown>) => {
    mockImageRenders.push(props);
    const uri = (props.source as { uri?: string } | undefined)?.uri ?? '?';
    useEffect(() => {
      // The testID at mount identifies the instance. A later prop change is not a remount.
      mockMountLog.push({
        testID: typeof props.testID === 'string' ? props.testID : undefined,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
      mockImageMounts += 1;
      mockLiveImages.push(uri);
      return () => {
        const at = mockLiveImages.indexOf(uri);
        if (at >= 0) mockLiveImages.splice(at, 1);
      };
    }, [uri]);
    return (
      <View
        {...props}
        onError={(event: unknown) => {
          if (typeof props.onError === 'function') {
            (props.onError as (event: unknown) => void)(event);
            return;
          }
          mockUseImageError?.(new Error('load failed'));
        }}
      />
    );
  };
  return {
    Image: (props: Record<string, unknown>) => (
      mockUseActualExpoImage
        ? <ActualExpoImage {...props} />
        : <RecordingImage {...props} />
    ),
    useImage: (
      source: MockImageSource,
      options: { onError?: (error: Error) => void },
      deps?: unknown[],
    ) => {
      mockUseImageCalls.push(source);
      mockUseImageError = options.onError;
      mockUseImageDeps = deps;
      mockUseImageSource = source;
      if (mockUseImageHold) return null;
      const ref = typeof source === 'string' ? { uri: source } : { ...source };
      const next = mockUseImageAnimated ? { ...ref, isAnimated: true } : ref;
      if (mockStickPreviousImage && mockPreviousImage !== null) return mockPreviousImage;
      mockPreviousImage = next;
      return next;
    },
  };
});

let mockReducedMotion = false;
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated'),
  __esModule: true,
  useReducedMotion: () => mockReducedMotion,
}));

// Board #16: the first-frame still store, answered by hand in each test.
type MockStillResult = { uri: string | null; missing: boolean };
let mockStillPending: ((result: MockStillResult) => void)[] = [];
const mockStillStore = {
  stillFor: jest.fn((_uri: string, _byteSize: number) => new Promise<MockStillResult>((resolve) => {
    mockStillPending.push(resolve);
  })),
};
jest.mock('@/features/images/gif-first-frame', () => ({
  ...jest.requireActual('@/features/images/gif-first-frame'),
  defaultGifStillStore: () => mockStillStore,
}));

async function settleStill(at: number, result: MockStillResult) {
  await act(async () => mockStillPending[at]!(result));
}

beforeEach(() => {
  mockStillPending = [];
  mockStillStore.stillFor.mockClear();
  mockReducedMotion = false;
  mockUseImageCalls = [];
  mockUseImageHold = false;
  mockUseImageAnimated = false;
  mockImageRenders = [];
  mockImageMounts = 0;
  mockLiveImages = [];
  mockMountLog = [];
  mockStickPreviousImage = false;
  mockPreviousImage = null;
  mockUseActualExpoImage = false;
});

function image(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 7,
    providerKey: 'waifu_im',
    providerItemId: '7',
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: 'https://cdn.example.com/7.jpg',
    sourceUrl: 'https://source.example.com/7',
    artistName: 'Artist 7',
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
    decidedAt: 700,
    queueOrdinal: 7,
    decisionOrdinal: 7,
    localUri: 'file:///collection/7.jpg',
    downloadState: 'ready',
    downloadError: null,
    downloadErrorKind: null,
    libraryError: null,
    ...overrides,
  };
}

test('contains the original image without cropping it', async () => {
  await render(
    <GalleryImage
      image={image()}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(screen.getByLabelText('全屏图片 7').props.contentFit).toBe('contain');
  expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();
});

test('restores the same local URI after viewer repair completes', async () => {
  let finishRepair!: (repaired: boolean) => void;
  const onLocalFileMissing = jest.fn(() => new Promise<boolean>((resolve) => {
    finishRepair = resolve;
  }));
  await render(
    <GalleryImage
      image={image()}
      onLocalFileMissing={onLocalFileMissing}
    />,
  );

  const firstError = mockUseImageError!;
  await act(async () => {
    firstError(new Error('load failed'));
    firstError(new Error('load failed again'));
  });

  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7.jpg',
  });
  expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
  // Spec §5.5 rule 3: the repair names the file the viewer failed to load.
  expect(onLocalFileMissing).toHaveBeenCalledWith('file:///collection/7.jpg');

  await act(async () => finishRepair(true));

  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'file:///collection/7.jpg',
  });
  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
});

test('keeps remote fallback when same-URI repair does not succeed', async () => {
  const onLocalFileMissing = jest.fn().mockResolvedValue(false);
  await render(
    <GalleryImage
      image={image()}
      onLocalFileMissing={onLocalFileMissing}
    />,
  );

  await fireEvent(screen.getByLabelText('全屏图片 7'), 'error');
  await act(async () => undefined);

  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7.jpg',
  });
  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
});

test('keeps a rehydrated same URI failed and retries after the URI changes', async () => {
  const onLocalFileMissing = jest.fn().mockResolvedValue(false);
  const { rerender } = await render(
    <GalleryImage
      image={image()}
      onLocalFileMissing={onLocalFileMissing}
    />,
  );

  await fireEvent(screen.getByLabelText('全屏图片 7'), 'error');
  await act(async () => undefined);
  await rerender(
    <GalleryImage
      image={image({ artistName: 'Rehydrated artist' })}
      onLocalFileMissing={onLocalFileMissing}
    />,
  );

  await fireEvent(screen.getByLabelText('全屏图片 7'), 'error');
  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7.jpg',
  });
  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);

  await rerender(
    <GalleryImage
      image={image({ localUri: 'file:///collection/7-v2.jpg' })}
      onLocalFileMissing={onLocalFileMissing}
    />,
  );
  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'file:///collection/7-v2.jpg',
  });

  await fireEvent(screen.getByLabelText('全屏图片 7'), 'error');
  expect(onLocalFileMissing).toHaveBeenCalledTimes(2);
});

test('a pending row loads the cached sample in the viewer', async () => {
  await render(
    <GalleryImage
      image={image({
        localUri: null,
        downloadState: 'pending',
        sampleUrl: 'https://cdn.example.com/7-sample.jpg',
      })}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7-sample.jpg',
  });
  expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
});

test('a resolver-owned row shows the placeholder and loads nothing while its resolve is pending', async () => {
  mockUseImageSource = undefined;
  await render(
    <GalleryImage
      image={image({
        localUri: null,
        downloadState: 'mirrored',
        sampleUrl: 'https://cdn.example.com/7-sample.jpg',
      })}
      onLocalFileMissing={jest.fn()}
      overrideSource={null}
      overridePending
    />,
  );

  // The library owns this row. Rendering the provider sample in the gap
  // before the resolver answers costs a network fetch for bytes we already
  // hold and, worse, a second load a few ms later on the same native view —
  // the source of the black viewer (2026-09-16 phone report).
  expect(screen.getByTestId('gallery-image-loading-7')).toHaveStyle({ backgroundColor: '#726A7D' });
  expect(screen.queryByTestId('gallery-image-remote-loaded-7')).not.toBeOnTheScreen();
  expect(mockUseImageSource).toBeUndefined();
});

test('a mounted viewer image keeps its transition when the source flips from remote to local', async () => {
  const pending = image({
    localUri: null,
    downloadState: 'pending',
    sampleUrl: 'https://cdn.example.com/7-sample.jpg',
  });
  const { rerender } = await render(
    <GalleryImage image={pending} onLocalFileMissing={jest.fn()} />,
  );
  expect(screen.getByTestId('gallery-image-remote-loaded-7').props.transition).toBe(120);

  await rerender(<GalleryImage image={image()} onLocalFileMissing={jest.fn()} />);

  // expo-image's zero-transition swap never cancels a fade still running on
  // the child view it reuses, so flipping 120 → 0 on one mounted <Image> can
  // leave the newly loaded picture at alpha 0. The transition is fixed for
  // the lifetime of the mounted element.
  expect(screen.getByTestId('gallery-image-local-loaded-7').props.transition).toBe(120);
});

test('retries a failed remote load with backoff', async () => {
  jest.useFakeTimers();
  try {
    const onLocalFileMissing = jest.fn();
    await render(
      <GalleryImage
        image={image({
          localUri: null,
          downloadState: 'pending',
          sampleUrl: 'https://cdn.example.com/7-sample.jpg',
        })}
        onLocalFileMissing={onLocalFileMissing}
      />,
    );

    const initialDeps = [...(mockUseImageDeps ?? [])];
    const retryCount = () => mockUseImageDeps?.[mockUseImageDeps.length - 1];
    expect(retryCount()).toBe(0);

    await act(async () => {
      mockUseImageError?.(new Error('dns'));
    });
    expect(mockUseImageDeps).toEqual(initialDeps);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(mockUseImageDeps).not.toEqual(initialDeps);
    expect(retryCount()).toBe(1);
    expect(onLocalFileMissing).not.toHaveBeenCalled();

    await act(async () => {
      mockUseImageError?.(new Error('dns'));
      jest.advanceTimersByTime(3_000);
    });
    expect(retryCount()).toBe(2);

    await act(async () => {
      mockUseImageError?.(new Error('dns'));
      jest.advanceTimersByTime(8_000);
    });
    expect(retryCount()).toBe(3);

    // Bounded: a fourth failure never reloads again.
    await act(async () => {
      mockUseImageError?.(new Error('dns'));
      jest.advanceTimersByTime(600_000);
    });
    expect(retryCount()).toBe(3);
    expect(onLocalFileMissing).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('override file source wins and skips local repair', async () => {
  const onLocalFileMissing = jest.fn();
  await render(
    <GalleryImage
      image={image()}
      onLocalFileMissing={onLocalFileMissing}
      overrideSource={{
        kind: 'file',
        uri: 'file:///cache/library/preview-7.jpg',
        tier: 'cached-preview',
        role: 'preview',
      }}
    />,
  );

  expect(screen.getByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
  expect(screen.getByLabelText('全屏图片 7').props.source).toEqual({
    uri: 'file:///cache/library/preview-7.jpg',
  });
  await act(async () => {
    mockUseImageError?.(new Error('load failed'));
  });
  expect(onLocalFileMissing).not.toHaveBeenCalled();
});

test('a fast-path override reports its load error through onOverrideFailed', async () => {
  const onLocalFileMissing = jest.fn();
  const onOverrideFailed = jest.fn();
  await render(
    <GalleryImage
      image={image()}
      onLocalFileMissing={onLocalFileMissing}
      overrideSource={{
        kind: 'file',
        uri: 'file:///data/library/originals/a.jpg',
        tier: 'local-original',
        role: 'original',
      }}
      onOverrideFailed={onOverrideFailed}
    />,
  );

  await act(async () => {
    mockUseImageError?.(new Error('load failed'));
  });
  expect(onOverrideFailed).toHaveBeenCalledTimes(1);
  expect(onLocalFileMissing).not.toHaveBeenCalled();
});

test('an overridden source never retries: deps do not advance and no repair on error', async () => {
  jest.useFakeTimers();
  try {
    const onLocalFileMissing = jest.fn();
    await render(
      <GalleryImage
        image={image()}
        onLocalFileMissing={onLocalFileMissing}
        overrideSource={{
          kind: 'file',
          uri: 'file:///cache/library/full-7.jpg',
          tier: 'cached-preview',
          role: 'preview',
        }}
      />,
    );

    const initialDeps = [...(mockUseImageDeps ?? [])];

    await act(async () => {
      mockUseImageError?.(new Error('x'));
      jest.advanceTimersByTime(20_000);
    });

    // The library resolver owns overridden sources — a retry here would fight
    // the resolver, so the useImage deps (including the retry attempt) must
    // not move.
    expect(mockUseImageDeps).toEqual(initialDeps);
    expect(onLocalFileMissing).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('unavailable offline override shows a polite live region without fetching', async () => {
  await render(
    <GalleryImage
      image={image({ localUri: null })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{ kind: 'unavailable', category: 'offline' }}
    />,
  );

  const viewer = screen.getByLabelText('图片查看器 7');
  expect(viewer.props.accessibilityLiveRegion).toBe('polite');
  expect(screen.getByTestId('gallery-image-offline-7')).toHaveTextContent('离线不可用');
  expect(screen.getByText(zhHans.libraryView.offlineMessage)).toBeOnTheScreen();
  expect(screen.queryByLabelText('全屏图片 7')).not.toBeOnTheScreen();
});

test('unavailable integrity override shows the integrity placeholder', async () => {
  await render(
    <GalleryImage
      image={image({ localUri: null })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{ kind: 'unavailable', category: 'integrity' }}
    />,
  );

  expect(screen.getByTestId('gallery-image-unavailable-7'))
    .toHaveTextContent('此图片未能通过校验，未予显示。');
});

test('K3: unavailable auth_attention override shows the locked placeholder', async () => {
  await render(
    <GalleryImage
      image={image({ localUri: null })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{ kind: 'unavailable', category: 'auth_attention' }}
    />,
  );
  expect(screen.getByTestId('gallery-image-locked-7')).toHaveTextContent('解锁云同步后可查看');
  expect(screen.queryByTestId('gallery-image-unavailable-7')).toBeNull();
});

test('object_missing says the original is gone, not that it failed verification', async () => {
  await render(
    <GalleryImage
      image={image({ localUri: null })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{ kind: 'unavailable', category: 'object_missing' }}
    />,
  );
  expect(screen.getByTestId('gallery-image-unavailable-7'))
    .toHaveTextContent(zhHans.libraryView.missingMessage);
});

test("a disconnected phone's locked page says so", async () => {
  await render(
    <GalleryImage
      image={image({ localUri: null })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{ kind: 'unavailable', category: 'auth_attention' }}
      libraryAccess="disconnected"
    />,
  );
  expect(screen.getByTestId('gallery-image-locked-7'))
    .toHaveTextContent(zhHans.libraryView.disconnectedTitle);
});

test('R8.28: the viewer loads provider-remote bytes with the provider headers', async () => {
  await render(
    <GalleryImage
      image={image({
        providerKey: 'gelbooru',
        localUri: null,
        downloadState: 'pending',
        remoteUrl: 'https://img4.gelbooru.com/images/a/b/c.jpg',
        sampleUrl: 'https://img4.gelbooru.com/samples/a/b/sample_c.jpg',
      })}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(mockUseImageSource).toEqual({
    uri: 'https://img4.gelbooru.com/samples/a/b/sample_c.jpg',
    headers: { Referer: 'https://gelbooru.com/' },
  });
});

test('R8.28: a headerless provider keeps a bare { uri } load', async () => {
  await render(
    <GalleryImage
      image={image({
        providerKey: 'danbooru',
        localUri: null,
        downloadState: 'pending',
      })}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(mockUseImageSource).toEqual({ uri: 'https://cdn.example.com/7.jpg' });
  expect(Object.keys(mockUseImageSource as object)).toEqual(['uri']);
});

test('R8.28: local and override file loads stay plain string sources', async () => {
  await render(
    <GalleryImage
      image={image({ providerKey: 'gelbooru' })}
      onLocalFileMissing={jest.fn()}
    />,
  );
  expect(mockUseImageSource).toBe('file:///collection/7.jpg');

  await render(
    <GalleryImage
      image={image({ providerKey: 'gelbooru' })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{
        kind: 'file',
        uri: 'file:///cache/library/7.jpg',
        tier: 'cached-preview',
        role: 'preview',
      }}
    />,
  );
  expect(mockUseImageSource).toBe('file:///cache/library/7.jpg');
});

// ---------------------------------------------------------------------------
// Board #6 — animated rows render through a Glide-owned <Image> (no useImage,
// cachePolicy "disk") so Glide recycles — and stops — the GifDrawable when the
// view goes away. Spec docs/superpowers/specs/2026-09-26-row6-gif-decoder-leak-design.md.
// ---------------------------------------------------------------------------

function gif(overrides: Partial<StoredImage> = {}): StoredImage {
  return image({
    isAnimated: true,
    extension: '.gif',
    localUri: 'file:///collection/7.gif',
    remoteUrl: 'https://cdn.example.com/7.gif',
    ...overrides,
  });
}

const remoteGif = (overrides: Partial<StoredImage> = {}) => gif({
  localUri: null,
  downloadState: 'pending',
  sampleUrl: 'https://cdn.example.com/7-sample.gif',
  ...overrides,
});

async function measure(width = 400, height = 800) {
  await fireEvent(screen.getByLabelText('图片查看器 7'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width, height } },
  });
}

function lastImageProps(): Record<string, unknown> {
  const props = mockImageRenders[mockImageRenders.length - 1];
  if (!props) throw new Error('no <Image> rendered');
  return props;
}

async function display() {
  await act(async () => {
    (lastImageProps().onDisplay as () => void)();
  });
}

test('isAnimatedRow: the metadata flag or a gif extension (any case, stored with its dot)', () => {
  expect(isAnimatedRow(image({ isAnimated: true }))).toBe(true);
  // The repository stores extensions as `.gif` (every provider writes `.${ext}`).
  expect(isAnimatedRow(image({ isAnimated: false, extension: '.gif' }))).toBe(true);
  expect(isAnimatedRow(image({ isAnimated: false, extension: '.GIF' }))).toBe(true);
  expect(isAnimatedRow(image({ isAnimated: false, extension: '.jpg' }))).toBe(false);
  expect(isAnimatedRow(image({ isAnimated: false, extension: 'GIF' }))).toBe(true);
  expect(isAnimatedRow(image({ isAnimated: false, extension: 'gif' }))).toBe(true);
  expect(isAnimatedRow(image({ isAnimated: false, extension: 'jpg' }))).toBe(false);
});

test('an animated local row never calls useImage and loads its file with cachePolicy "none"', async () => {
  await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  await measure();

  expect(mockUseImageCalls).toEqual([]);
  expect(mockImageMounts).toBe(1);
  const props = lastImageProps();
  expect(props.source).toEqual({ uri: 'file:///collection/7.gif' });
  expect(props.cachePolicy).toBe('none');
  expect(props.contentFit).toBe('contain');
});

test('a row with a GIF extension but isAnimated false takes the animated path', async () => {
  await render(
    <GalleryImage
      image={image({ isAnimated: false, extension: '.GIF', localUri: 'file:///collection/7.GIF' })}
      onLocalFileMissing={jest.fn()}
    />,
  );
  await measure();

  expect(mockUseImageCalls).toEqual([]);
  expect(lastImageProps().cachePolicy).toBe('none');
  expect(lastImageProps().source).toEqual({ uri: 'file:///collection/7.GIF' });
});

// Board #17: a local gif that OOMs decodes to a static first frame, and under
// "disk" (Glide's AUTOMATIC strategy) that frame is written to the resource
// disk cache under a key with no content signature, then served forever.
// Spec docs/superpowers/specs/2026-09-26-row17-gif-cache-poison-design.md.
test('an animated override (library file) row loads with cachePolicy "none"', async () => {
  await render(
    <GalleryImage
      image={gif({ localUri: null, downloadState: 'mirrored' })}
      onLocalFileMissing={jest.fn()}
      overrideSource={{
        kind: 'file',
        uri: 'file:///library-cache/7.gif',
        tier: 'cached-preview',
        role: 'preview',
      }}
    />,
  );
  await measure();

  expect(lastImageProps().source).toEqual({ uri: 'file:///library-cache/7.gif' });
  expect(lastImageProps().cachePolicy).toBe('none');
});

test('an animated remote row keeps cachePolicy "disk" (the provider bytes stay in the data cache)', async () => {
  await render(
    <GalleryImage
      image={remoteGif({
        providerKey: 'gelbooru',
        remoteUrl: 'https://img4.gelbooru.com/images/a/b/c.gif',
        sampleUrl: 'https://img4.gelbooru.com/samples/a/b/sample_c.gif',
      })}
      onLocalFileMissing={jest.fn()}
    />,
  );
  await measure();

  expect(lastImageProps().source).toEqual({
    uri: 'https://img4.gelbooru.com/samples/a/b/sample_c.gif',
    headers: { Referer: 'https://gelbooru.com/' },
  });
  expect(lastImageProps().cachePolicy).toBe('disk');
});

test('remote → local layering: each layer keeps its own cache policy, never a flip on a mounted view', async () => {
  const { rerender } = await render(
    <GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />,
  );
  await measure();
  await display();

  mockImageRenders = [];
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  expect(mockLiveImages).toEqual([
    'https://cdn.example.com/7-sample.gif',
    'file:///collection/7.gif',
  ]);
  const policies = (uri: string) => [...new Set(mockImageRenders
    .filter((props) => (props.source as { uri?: string } | undefined)?.uri === uri)
    .map((props) => props.cachePolicy))];
  expect(policies('https://cdn.example.com/7-sample.gif')).toEqual(['disk']);
  expect(policies('file:///collection/7.gif')).toEqual(['none']);
  expect(mockImageRenders.slice(-2).map((props) => props.cachePolicy)).toEqual(['disk', 'none']);

  await display();
  mockImageRenders = [];
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  expect(mockLiveImages).toEqual(['file:///collection/7.gif']);
  expect(mockImageRenders.length).toBeGreaterThan(0);
  expect(mockImageRenders.every((props) => props.cachePolicy === 'none')).toBe(true);
});

test('the animated path never uses a memory cache policy (board #6 recycle guarantee)', async () => {
  const { rerender } = await render(
    <GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />,
  );
  await measure();
  await display();
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  await display();
  await rerender(
    <GalleryImage
      image={gif()}
      onLocalFileMissing={jest.fn()}
      overrideSource={{
        kind: 'file',
        uri: 'file:///library-cache/7.gif',
        tier: 'cached-preview',
        role: 'preview',
      }}
    />,
  );

  expect(mockImageRenders.length).toBeGreaterThan(0);
  expect(mockImageRenders.every((props) => (
    props.cachePolicy === 'disk' || props.cachePolicy === 'none'
  ))).toBe(true);
});

test('a static row keeps today\'s useImage call, deps, and memory-disk cache', async () => {
  await render(<GalleryImage image={image()} onLocalFileMissing={jest.fn()} />);

  expect(mockUseImageCalls.length).toBeGreaterThan(0);
  expect(mockUseImageSource).toBe('file:///collection/7.jpg');
  expect(mockUseImageDeps).toEqual([
    7,
    'file:///collection/7.jpg',
    'https://cdn.example.com/7.jpg',
    undefined,
    true,
    null,
    0,
  ]);
  const props = screen.getByLabelText('全屏图片 7').props;
  expect(props.cachePolicy).toBe('memory-disk');
  expect(props.source).toEqual({ uri: 'file:///collection/7.jpg' });
});

test('an animated provider-remote row loads the sample with the provider headers', async () => {
  await render(
    <GalleryImage
      image={remoteGif({
        providerKey: 'gelbooru',
        remoteUrl: 'https://img4.gelbooru.com/images/a/b/c.gif',
        sampleUrl: 'https://img4.gelbooru.com/samples/a/b/sample_c.gif',
      })}
      onLocalFileMissing={jest.fn()}
    />,
  );
  await measure();

  expect(mockUseImageCalls).toEqual([]);
  expect(lastImageProps().source).toEqual({
    uri: 'https://img4.gelbooru.com/samples/a/b/sample_c.gif',
    headers: { Referer: 'https://gelbooru.com/' },
  });
});

test('an animated row from a headerless provider loads a bare { uri }', async () => {
  await render(
    <GalleryImage image={remoteGif({ providerKey: 'danbooru' })} onLocalFileMissing={jest.fn()} />,
  );
  await measure();

  expect(lastImageProps().source).toEqual({ uri: 'https://cdn.example.com/7-sample.gif' });
  expect(Object.keys(lastImageProps().source as object)).toEqual(['uri']);
});

test('an animated override row loads the override file and never retries or repairs', async () => {
  jest.useFakeTimers();
  try {
    const onLocalFileMissing = jest.fn();
    await render(
      <GalleryImage
        image={gif()}
        onLocalFileMissing={onLocalFileMissing}
        overrideSource={{
          kind: 'file',
          uri: 'file:///cache/library/7.gif',
          tier: 'cached-preview',
          role: 'preview',
        }}
      />,
    );
    await measure();

    expect(lastImageProps().source).toEqual({ uri: 'file:///cache/library/7.gif' });
    expect(mockImageMounts).toBe(1);
    await act(async () => {
      (lastImageProps().onError as (event: unknown) => void)({ error: 'x' });
      jest.advanceTimersByTime(20_000);
    });
    expect(mockImageMounts).toBe(1);
    expect(onLocalFileMissing).not.toHaveBeenCalled();
    await display();
    expect(screen.getByTestId('gallery-image-override-loaded-7')).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

test('an animated resolver-owned row holds the colour block and renders no <Image>', async () => {
  await render(
    <GalleryImage
      image={gif({ localUri: null, downloadState: 'mirrored' })}
      onLocalFileMissing={jest.fn()}
      overrideSource={null}
      overridePending
    />,
  );

  expect(screen.getByTestId('gallery-image-loading-7')).toHaveStyle({ backgroundColor: '#726A7D' });
  expect(mockImageRenders).toEqual([]);
  expect(mockUseImageCalls).toEqual([]);
});

test('animated testIDs: loading until onDisplay, then the loaded id of the source kind', async () => {
  await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  await measure();

  expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
  expect(screen.queryByTestId('gallery-image-local-loaded-7')).not.toBeOnTheScreen();
  expect(screen.queryByTestId('gallery-image-remote-loaded-7')).not.toBeOnTheScreen();

  await display();

  expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();
  expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
  expect(screen.getByTestId('gallery-image-local-loaded-7').props.source)
    .toEqual({ uri: 'file:///collection/7.gif' });
});

test('an animated remote row reports remote-loaded after onDisplay', async () => {
  await render(<GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />);
  await measure();
  await display();

  expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
});

test('the animated <Image> waits for the page layout, then takes the contained size', async () => {
  await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);

  expect(mockImageRenders).toEqual([]);
  expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();

  // 900×1200 contained in 400×800 → 400×533.33…
  await measure(400, 800);

  expect(mockImageMounts).toBe(1);
  expect(lastImageProps().style).toEqual({ width: 400, height: 1200 * (400 / 900) });
});

function imageRenderCountFor(uri: string): number {
  return mockImageRenders.filter((props) => (props.source as { uri?: string } | undefined)?.uri === uri).length;
}

test('a remote-first animated row that gains its local file layers it above the remote picture (no flash)', async () => {
  const { rerender } = await render(
    <GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />,
  );
  await measure();
  await display();
  expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
  expect(mockImageMounts).toBe(1);

  mockImageRenders = [];
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);

  // The local file loads on a NEW element above the remote one. Swapping the
  // source on one Glide-owned element recycles the remote picture before the
  // local one is ready (a black frame); remounting in place would show the
  // colour block. Both layers are rendered until the local one displays.
  expect(mockImageMounts).toBe(2);
  expect(mockLiveImages).toEqual([
    'https://cdn.example.com/7-sample.gif',
    'file:///collection/7.gif',
  ]);
  expect(lastImageProps().source).toEqual({ uri: 'file:///collection/7.gif' });
  expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
  expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
  expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);

  await display();

  // The local layer is on screen; the remote layer is gone (Glide recycles and
  // stops its decoder), and nothing else mounted.
  expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();
  expect(screen.queryByTestId('gallery-image-remote-loaded-7')).not.toBeOnTheScreen();
  mockImageRenders = [];
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  expect(mockLiveImages).toEqual(['file:///collection/7.gif']);
  expect(mockImageMounts).toBe(2);
  expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);
});

test('a new source that arrives before the first one displayed replaces it (no stacking)', async () => {
  const { rerender } = await render(
    <GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />,
  );
  await measure();
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);

  mockImageRenders = [];
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  expect(imageRenderCountFor('https://cdn.example.com/7-sample.gif')).toBe(0);
  expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
});

test('an animated layer keeps its size for life; a new page size loads a new layer above the displayed one', async () => {
  const { rerender } = await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  // 900×1200 in 400×500 is height-bound → 375×500.
  await measure(400, 500);
  // The first real layout does not stack a layer on a never-mounted 1×1 one.
  expect(mockImageMounts).toBe(1);
  await display();

  // The page grows (its "saving" row went away): the displayed layer keeps its
  // size — a resized Glide view clears and reloads (a black frame) — and the
  // new size loads above it.
  // 400×800 → width-bound 400×533.33…
  await measure(400, 800);
  expect(mockImageMounts).toBe(2);
  expect(mockLiveImages).toEqual(['file:///collection/7.gif', 'file:///collection/7.gif']);
  const sizes = mockImageRenders.slice(-2).map((props) => props.style);
  expect(sizes).toContainEqual({ width: 375, height: 500 });
  expect(sizes).toContainEqual({ width: 400, height: 1200 * (400 / 900) });
  expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();

  await display();
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  expect(mockLiveImages).toEqual(['file:///collection/7.gif']);
  expect(lastImageProps().style).toEqual({ width: 400, height: 1200 * (400 / 900) });
});

test('the animated path puts the fullscreen label on exactly one element', async () => {
  await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  await measure();

  expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);
  expect(screen.getByLabelText('全屏图片 7').props.testID).toBe('gallery-image-loading-7');

  await display();

  expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);
  expect(screen.getByLabelText('全屏图片 7').props.testID).toBe('gallery-image-local-loaded-7');
  expect(screen.getByLabelText('全屏图片 7').props.cachePolicy).toBe('none');
});

// --- Task 2: every viewer guarantee on the animated path -------------------

test('each animated layer keeps its transition for life; the remote layer stays 120 when the local one arrives', async () => {
  const { rerender } = await render(
    <GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />,
  );
  await measure();
  expect(lastImageProps().transition).toBe(120);
  await display();

  mockImageRenders = [];
  await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);

  const remote = mockImageRenders.filter((props) => (
    (props.source as { uri: string }).uri === 'https://cdn.example.com/7-sample.gif'
  ));
  expect(remote.length).toBeGreaterThan(0);
  expect(remote.every((props) => props.transition === 120)).toBe(true);
  // The local layer is a new element: its own value, never a flip on the old one.
  expect(lastImageProps().source).toEqual({ uri: 'file:///collection/7.gif' });
  expect(lastImageProps().transition).toBe(0);
});

test('an animated row mounted local-first has transition 0', async () => {
  await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);
  await measure();

  expect(lastImageProps().transition).toBe(0);
});

test('an animated remote row has transition 0 with reduced motion', async () => {
  mockReducedMotion = true;
  await render(<GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />);
  await measure();

  expect(lastImageProps().transition).toBe(0);
});

test('an animated remote row retries a failed load by remounting its <Image>', async () => {
  jest.useFakeTimers();
  try {
    const onLocalFileMissing = jest.fn();
    await render(<GalleryImage image={remoteGif()} onLocalFileMissing={onLocalFileMissing} />);
    await measure();
    expect(mockImageMounts).toBe(1);

    await act(async () => {
      (lastImageProps().onError as (event: unknown) => void)({ error: 'dns' });
    });
    expect(mockImageMounts).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
    });

    // New key → new element → expo-image issues the load again.
    expect(mockImageMounts).toBe(2);
    expect(lastImageProps().source).toEqual({ uri: 'https://cdn.example.com/7-sample.gif' });
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(onLocalFileMissing).not.toHaveBeenCalled();
    expect(mockUseImageCalls).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('a retried animated remote row that gains its local file keeps the displayed element (no flash)', async () => {
  jest.useFakeTimers();
  try {
    const { rerender } = await render(
      <GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />,
    );
    await measure();
    await act(async () => {
      (lastImageProps().onError as (event: unknown) => void)({ error: 'dns' });
    });
    await act(async () => {
      jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
    });
    expect(mockImageMounts).toBe(2);
    await display();
    expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();

    // The local file lands: the retry counter resets with the new source, but
    // the displayed retry element must stay (a remount = colour block again);
    // the local file layers above it.
    mockImageRenders = [];
    await rerender(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} />);

    expect(mockImageMounts).toBe(3);
    expect(imageRenderCountFor('https://cdn.example.com/7-sample.gif')).toBeGreaterThan(0);
    expect(lastImageProps().source).toEqual({ uri: 'file:///collection/7.gif' });
    expect(screen.queryByTestId('gallery-image-loading-7')).not.toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

test('a retry after a displayed animated load shows the colour block until the new element displays', async () => {
  jest.useFakeTimers();
  try {
    await render(<GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />);
    await measure();
    await display();
    expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();

    await act(async () => {
      (lastImageProps().onError as (event: unknown) => void)({ error: 'reset' });
    });
    await act(async () => {
      jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
    });

    // The old element's display does not vouch for the new one.
    expect(mockImageMounts).toBe(2);
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.queryByTestId('gallery-image-remote-loaded-7')).not.toBeOnTheScreen();

    await display();
    expect(screen.getByTestId('gallery-image-remote-loaded-7')).toBeOnTheScreen();
  } finally {
    jest.useRealTimers();
  }
});

test('a displayed layer that later errors loses the label and is dropped by the retry, which mounts one fresh element', async () => {
  jest.useFakeTimers();
  try {
    await render(<GalleryImage image={remoteGif()} onLocalFileMissing={jest.fn()} />);
    await measure();
    await display();
    expect(mockImageMounts).toBe(1);

    // The displayed picture errors (for example a decode failed mid-stream).
    await act(async () => {
      (lastImageProps().onError as (event: unknown) => void)({ error: 'decode' });
    });
    // A failed layer is not what is on screen: no loaded testID, no label on it.
    expect(screen.queryByTestId('gallery-image-remote-loaded-7')).not.toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(REMOTE_LOAD_RETRY_DELAYS_MS[0]);
    });

    // The retry re-issues the load on a fresh element and the failed one is gone.
    expect(mockImageMounts).toBe(2);
    expect(mockLiveImages).toEqual(['https://cdn.example.com/7-sample.gif']);
  } finally {
    jest.useRealTimers();
  }
});

test('an animated local row repairs once, falls back to the sample, and restores the local file', async () => {
  let finishRepair!: (repaired: boolean) => void;
  const onLocalFileMissing = jest.fn(() => new Promise<boolean>((resolve) => {
    finishRepair = resolve;
  }));
  await render(
    <GalleryImage
      image={gif({ sampleUrl: 'https://cdn.example.com/7-sample.gif' })}
      onLocalFileMissing={onLocalFileMissing}
    />,
  );
  await measure();

  const firstError = lastImageProps().onError as (event: unknown) => void;
  await act(async () => {
    firstError({ error: 'missing' });
    firstError({ error: 'missing again' });
  });

  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
  expect(lastImageProps().source).toEqual({ uri: 'https://cdn.example.com/7-sample.gif' });

  await act(async () => finishRepair(true));

  expect(lastImageProps().source).toEqual({ uri: 'file:///collection/7.gif' });
  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
  expect(mockUseImageCalls).toEqual([]);
});

test('a static-metadata row whose ref turns out animated never displays that ref and hands off', async () => {
  mockUseImageAnimated = true;
  await render(<GalleryImage image={image()} onLocalFileMissing={jest.fn()} />);
  await measure();

  // The useImage ref was never handed to a view (a never-displayed ref was
  // never start()ed, so its decoder runs no loop).
  expect(mockImageRenders.some((props) => (
    (props.source as { isAnimated?: boolean } | undefined)?.isAnimated === true
  ))).toBe(false);
  // The page now renders the Glide-owned animated path: a fresh element.
  expect(mockImageMounts).toBe(1);
  expect(lastImageProps().source).toEqual({ uri: 'file:///collection/7.jpg' });
  expect(lastImageProps().cachePolicy).toBe('none');
  expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);
});

test('a forced-animated row re-evaluates on the static path when its source changes', async () => {
  mockUseImageAnimated = true;
  const sampleOnly = image({
    localUri: null,
    downloadState: 'pending',
    sampleUrl: 'https://cdn.example.com/7-sample.jpg',
  });
  const { rerender } = await render(
    <GalleryImage image={sampleOnly} onLocalFileMissing={jest.fn()} />,
  );
  await measure();
  expect(lastImageProps().cachePolicy).toBe('disk');
  const callsBefore = mockUseImageCalls.length;

  // The local file is a different file: its own bytes decide the path again.
  mockUseImageAnimated = false;
  await rerender(<GalleryImage image={image()} onLocalFileMissing={jest.fn()} />);

  expect(mockUseImageCalls.length).toBeGreaterThan(callsBefore);
  expect(screen.getByLabelText('全屏图片 7').props.cachePolicy).toBe('memory-disk');
});

test('a static-metadata row whose ref is static still displays the ref', async () => {
  await render(<GalleryImage image={image()} onLocalFileMissing={jest.fn()} />);

  const props = screen.getByLabelText('全屏图片 7').props;
  expect(props.source).toEqual({ uri: 'file:///collection/7.jpg' });
  expect(props.cachePolicy).toBe('memory-disk');
  expect(mockImageRenders.every((render) => render.cachePolicy === 'memory-disk')).toBe(true);
});

// ---------------------------------------------------------------------------
// Board #16 — a gif above GIF_ANIMATE_MAX_BYTES never starts an animated or
// whole-file decode: the page shows a first-frame still cut without Glide, and
// says why. Spec docs/superpowers/specs/2026-09-26-row16-huge-gif-cap-design.md
// §5.4/§5.5.
// ---------------------------------------------------------------------------

describe('board #16: a gif too large to animate', () => {
  const ORIGINAL = 'file:///collection/44.gif';
  const STILL = 'file:///cache/gif-still/x.png';

  const huge = (overrides: Partial<StoredImage> = {}) => image({
    id: 44,
    extension: '.gif',
    isAnimated: true,
    byteSize: 50_278_178,
    localUri: ORIGINAL,
    remoteUrl: 'https://cdn.example.com/44.gif',
    sampleUrl: 'https://cdn.example.com/44.gif',
    ...overrides,
  });

  async function measure44() {
    await fireEvent(screen.getByLabelText('图片查看器 44'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
    });
  }

  const everyImageUri = () => mockImageRenders.map((props) => (
    (props.source as { uri?: string } | undefined)?.uri
  ));

  test('(a) while the still is pending: the colour block, no <Image>, and the label', async () => {
    await render(<GalleryImage image={huge()} onLocalFileMissing={jest.fn()} />);
    await measure44();

    expect(screen.getByTestId('gallery-image-loading-44')).toBeOnTheScreen();
    expect(mockImageRenders).toEqual([]);
    expect(mockUseImageCalls).toEqual([]);
    const label = screen.getByTestId('gallery-image-too-large-44');
    expect(label).toHaveTextContent('文件过大，无法播放动图');
    expect(label.props.accessibilityLiveRegion).toBe('polite');
    expect(mockStillStore.stillFor).toHaveBeenCalledWith(ORIGINAL, 50_278_178);
  });

  test('(b) once the still is cut: exactly one <Image> of the still, never cached, never autoplayed', async () => {
    await render(<GalleryImage image={huge()} onLocalFileMissing={jest.fn()} />);
    await measure44();
    await settleStill(0, { uri: STILL, missing: false });

    expect(mockLiveImages).toEqual([STILL]);
    const still = screen.getByTestId('gallery-image-still-loaded-44');
    expect(still.props.source).toEqual({ uri: STILL });
    expect(still.props.cachePolicy).toBe('none');
    expect(still.props.autoplay).toBe(false);
    expect(still.props.transition).toBe(0);
    expect(still.props.accessibilityLabel).toBe('全屏图片 44');
    expect(screen.queryByTestId('gallery-image-loading-44')).not.toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();
    expect(mockUseImageCalls).toEqual([]);
  });

  test('(c) the original file is never mounted, over every recorded render', async () => {
    const { rerender } = await render(<GalleryImage image={huge()} onLocalFileMissing={jest.fn()} />);
    await measure44();
    await rerender(<GalleryImage image={huge({ artistName: 'x' })} onLocalFileMissing={jest.fn()} />);
    await settleStill(0, { uri: STILL, missing: false });
    await rerender(<GalleryImage image={huge({ artistName: 'y' })} onLocalFileMissing={jest.fn()} />);

    expect(mockImageRenders.length).toBeGreaterThan(0);
    expect(everyImageUri()).not.toContain(ORIGINAL);
    expect(everyImageUri().every((uri) => uri === STILL)).toBe(true);
    expect(mockUseImageCalls).toEqual([]);
  });

  test('a cut still waits for the page layout before it mounts, then takes the contained size', async () => {
    await render(<GalleryImage image={huge({ width: 900, height: 1200 })} onLocalFileMissing={jest.fn()} />);
    await settleStill(0, { uri: STILL, missing: false });

    // Cut, but the page is not measured yet: no <Image> at a placeholder size.
    expect(mockImageRenders).toEqual([]);
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();

    await measure44();
    expect(mockLiveImages).toEqual([STILL]);
    expect(screen.getByTestId('gallery-image-still-loaded-44').props.style)
      .toEqual(expect.objectContaining({ width: 400, height: 1200 * (400 / 900) }));
  });

  test('a still that cannot be cut keeps the colour block and the label, and loads nothing', async () => {
    await render(<GalleryImage image={huge()} onLocalFileMissing={jest.fn()} />);
    await measure44();
    await settleStill(0, { uri: null, missing: false });

    expect(screen.getByTestId('gallery-image-loading-44')).toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();
    expect(mockImageRenders).toEqual([]);
  });

  test('an override (library) file asks the store for the override uri', async () => {
    await render(
      <GalleryImage
        image={huge({ localUri: null, downloadState: 'mirrored' })}
        onLocalFileMissing={jest.fn()}
        overrideSource={{
          kind: 'file',
          uri: 'file:///library/44.gif',
          tier: 'local-original',
          role: 'original',
        }}
      />,
    );
    await measure44();

    expect(mockStillStore.stillFor).toHaveBeenCalledTimes(1);
    expect(mockStillStore.stillFor).toHaveBeenCalledWith('file:///library/44.gif', 50_278_178);
    await settleStill(0, { uri: STILL, missing: false });
    expect(everyImageUri()).toEqual(expect.arrayContaining([STILL]));
    expect(everyImageUri()).not.toContain('file:///library/44.gif');
  });

  test('a remote-only too-large row loads nothing and never asks the store, but says why', async () => {
    await render(
      <GalleryImage
        image={huge({ localUri: null, downloadState: 'pending' })}
        onLocalFileMissing={jest.fn()}
      />,
    );
    await measure44();

    expect(mockImageRenders).toEqual([]);
    expect(mockUseImageCalls).toEqual([]);
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
    expect(screen.getByTestId('gallery-image-loading-44')).toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();
  });

  test('a missing source file runs the viewer repair once, then cuts the restored file again', async () => {
    let finishRepair!: (repaired: boolean) => void;
    const onLocalFileMissing = jest.fn(() => new Promise<boolean>((resolve) => {
      finishRepair = resolve;
    }));
    await render(<GalleryImage image={huge()} onLocalFileMissing={onLocalFileMissing} />);
    await measure44();
    await settleStill(0, { uri: null, missing: true });

    expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
    // While the repair runs the page holds its colour block: no fallback to
    // the remote original either.
    expect(mockImageRenders).toEqual([]);
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();

    await act(async () => finishRepair(true));
    expect(mockStillStore.stillFor).toHaveBeenCalledTimes(2);
    await settleStill(1, { uri: STILL, missing: false });
    expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
    expect(mockLiveImages).toEqual([STILL]);
  });

  test('a missing override file is the resolver\'s to repair, never the viewer\'s', async () => {
    const onLocalFileMissing = jest.fn();
    const onOverrideFailed = jest.fn();
    await render(
      <GalleryImage
        image={huge({ localUri: null, downloadState: 'mirrored' })}
        onLocalFileMissing={onLocalFileMissing}
        overrideSource={{ kind: 'file', uri: 'file:///library/44.gif', tier: 'local-original', role: 'original' }}
        onOverrideFailed={onOverrideFailed}
      />,
    );
    await measure44();
    await settleStill(0, { uri: null, missing: true });

    expect(onLocalFileMissing).not.toHaveBeenCalled();
    // Board #27 S1b (spec §5.7): a too-large gif mounts no image, so its
    // fast-path failure reaches the screen only through the missing still.
    expect(onOverrideFailed).toHaveBeenCalled();
  });

  test('a derived (still) override of a too-large gif is already a still: it renders as before', async () => {
    await render(
      <GalleryImage
        image={huge({ localUri: null, downloadState: 'mirrored' })}
        onLocalFileMissing={jest.fn()}
        overrideSource={{ kind: 'file', uri: 'file:///library/44-preview.bin', tier: 'cached-preview', role: 'preview' }}
      />,
    );
    await measure44();

    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
    expect([...new Set(everyImageUri())]).toEqual(['file:///library/44-preview.bin']);
  });

  test('a 1.6 MB gif is unchanged: animated layer of its file, cachePolicy "none", no store, no label', async () => {
    await render(
      <GalleryImage
        image={huge({ byteSize: 1_600_000 })}
        onLocalFileMissing={jest.fn()}
      />,
    );
    await measure44();

    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
    expect(mockUseImageCalls).toEqual([]);
    expect(lastImageProps().source).toEqual({ uri: ORIGINAL });
    expect(lastImageProps().cachePolicy).toBe('none');
    expect(screen.queryByTestId('gallery-image-too-large-44')).not.toBeOnTheScreen();
  });

  test('a gif of exactly 16 MiB still animates; one byte more does not', async () => {
    const { rerender } = await render(
      <GalleryImage image={huge({ byteSize: 16 * 1024 * 1024 })} onLocalFileMissing={jest.fn()} />,
    );
    await measure44();
    expect(lastImageProps().source).toEqual({ uri: ORIGINAL });

    mockImageRenders = [];
    await rerender(
      <GalleryImage image={huge({ byteSize: 16 * 1024 * 1024 + 1 })} onLocalFileMissing={jest.fn()} />,
    );
    expect(everyImageUri()).not.toContain(ORIGINAL);
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();
  });

  test('the label is translated in every locale', async () => {
    const expected = {
      'zh-Hans': '文件过大，无法播放动图',
      'zh-Hant': '檔案過大，無法播放動圖',
      en: 'This file is too large to play as an animation',
      ja: 'ファイルが大きすぎるため、アニメーションを再生できません',
    } as const;
    for (const [language, copy] of Object.entries(expected)) {
      await i18n.changeLanguage(language);
      expect(i18n.t('detail.animationTooLarge')).toBe(copy);
    }
  });
});

// Board rows 48–49. The thumbnail is the page stage, under the content, and
// leaves only when a picture has actually been displayed.
describe('board rows 48–49: thumbnail under the picture', () => {
  const THUMB = 'file:///library/thumbnails/7.webp';
  const PROVIDER = 'https://cdn.example.com/7-sample.jpg';

  const imageUris = () => mockImageRenders.map((props) => (
    (props.source as { uri?: string } | undefined)?.uri
  ));

  async function measureLayered(label = '图片查看器 7', width = 400, height = 800) {
    const content = screen.getByLabelText(label);
    await fireEvent(content.parent ?? content, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width, height } },
    });
    await fireEvent(content, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width, height } },
    });
  }

  test('a pending page draws the thumbnail in the stage, not in the content', async () => {
    await render(
      <GalleryImage
        image={image({
          localUri: null,
          downloadState: 'mirrored',
          sampleUrl: PROVIDER,
        })}
        onLocalFileMissing={jest.fn()}
        overridePending
        placeholderUri={THUMB}
      />,
    );
    await measureLayered();

    const content = screen.getByLabelText('图片查看器 7');
    const stage = host(host(content.parent).children[0]);
    const placeholder = screen.getByTestId('gallery-image-placeholder-7');
    expect(host(placeholder.parent)).toBe(stage);
    expect(styleOf(stage).backgroundColor).toBeUndefined();
    expect(within(screen.getByTestId('gallery-image-loading-7'))
      .queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(placeholder.props.source).toEqual({ uri: THUMB });
    expect(placeholder.props.contentFit).toBe('contain');
    expect(placeholder.props.cachePolicy).toBe('memory');
    expect(placeholder.props.transition).toBe(0);
    expect(placeholder.props.pointerEvents).toBe('none');
    expect(placeholder.props.accessible).toBe(false);
    expect(screen.getAllByLabelText('全屏图片 7')).toHaveLength(1);
    // Board #9: the stand-in is the thumbnail, never the provider URL.
    expect(imageUris()).not.toContain(PROVIDER);
    expect(mockUseImageCalls).toEqual([]);
  });

  test('a pending page without a placeholder keeps today\'s colour box', async () => {
    await render(
      <GalleryImage
        image={image({
          localUri: null,
          downloadState: 'mirrored',
          sampleUrl: PROVIDER,
        })}
        onLocalFileMissing={jest.fn()}
        overridePending
      />,
    );

    expect(screen.getByTestId('gallery-image-loading-7')).toHaveStyle({ backgroundColor: '#726A7D' });
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(mockImageRenders).toEqual([]);
    expect(mockUseImageCalls).toEqual([]);
  });

  test('a static page keeps the placeholder until the picture\'s onDisplay', async () => {
    await render(
      <GalleryImage
        image={image()}
        onLocalFileMissing={jest.fn()}
        placeholderUri={THUMB}
      />,
    );
    await measureLayered();

    const picture = screen.getByTestId('gallery-image-local-loaded-7');
    expect(picture.props.source).toEqual({ uri: 'file:///collection/7.jpg' });
    expect(picture.props.cachePolicy).toBe('memory-disk');
    expect(picture.props.transition).toBe(0);
    expect(screen.getByTestId('gallery-image-placeholder-7').props.source).toEqual({ uri: THUMB });
    expect(screen.getByTestId('gallery-image-placeholder-7').props.cachePolicy).toBe('memory');
    // useImage has already resolved. The stage stays until the picture is on
    // screen; dropping it when the ref arrives would flash an empty frame.
    expect(screen.queryByTestId('gallery-image-loading-7')).toBeNull();

    await act(async () => {
      (picture.props.onDisplay as () => void)();
    });

    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-local-loaded-7').props.transition).toBe(0);
  });

  test('a static page waiting on its picture does not render the provider URL beside the placeholder', async () => {
    mockUseImageHold = true;
    await render(
      <GalleryImage
        image={image({
          localUri: null,
          downloadState: 'pending',
          sampleUrl: PROVIDER,
        })}
        onLocalFileMissing={jest.fn()}
        placeholderUri={THUMB}
      />,
    );
    await measureLayered();

    // useImage is held, so this only proves no <Image> is given the provider
    // URL. The hook may already have been asked to decode it.
    const placeholder = screen.getByTestId('gallery-image-placeholder-7');
    expect(placeholder.props.source).toEqual({ uri: THUMB });
    expect(within(screen.getByTestId('gallery-image-loading-7'))
      .queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(imageUris()).toEqual([THUMB]);
    expect(imageUris()).not.toContain(PROVIDER);
    expect(screen.queryByTestId('gallery-image-remote-loaded-7')).toBeNull();
  });

  test('a too-large gif keeps the placeholder until the still displays and never mounts the gif', async () => {
    const ORIGINAL = 'file:///collection/44.gif';
    const STILL = 'file:///cache/gif-still/44.png';
    const thumb = 'file:///library/thumbnails/44.webp';
    await render(
      <GalleryImage
        image={image({
          id: 44,
          extension: '.gif',
          isAnimated: true,
          byteSize: 50_278_178,
          localUri: ORIGINAL,
          remoteUrl: 'https://cdn.example.com/44.gif',
          sampleUrl: 'https://cdn.example.com/44.gif',
        })}
        onLocalFileMissing={jest.fn()}
        placeholderUri={thumb}
      />,
    );
    await measureLayered('图片查看器 44');

    expect(screen.getByTestId('gallery-image-placeholder-44')).toBeOnTheScreen();
    expect(within(screen.getByTestId('gallery-image-loading-44'))
      .queryByTestId('gallery-image-placeholder-44')).toBeNull();
    expect(imageUris()).not.toContain(ORIGINAL);
    expect(imageUris()).not.toContain('https://cdn.example.com/44.gif');

    await fireEvent(screen.getByLabelText('图片查看器 44'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
    });
    await settleStill(0, { uri: STILL, missing: false });

    expect(screen.getByTestId('gallery-image-still-loaded-44')).toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-placeholder-44').props.source).toEqual({ uri: thumb });
    expect(imageUris()).not.toContain(ORIGINAL);

    await act(async () => {
      (screen.getByTestId('gallery-image-still-loaded-44').props.onDisplay as () => void)();
    });

    expect(screen.queryByTestId('gallery-image-placeholder-44')).toBeNull();
    expect(screen.getByTestId('gallery-image-still-loaded-44')).toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-too-large-44')).toBeOnTheScreen();
    expect(imageUris()).not.toContain(ORIGINAL);
    expect(mockUseImageCalls).toEqual([]);
  });

  test('an animated page keeps the placeholder until a layer displays', async () => {
    await render(
      <GalleryImage
        image={gif()}
        onLocalFileMissing={jest.fn()}
        placeholderUri={THUMB}
      />,
    );
    await measureLayered();

    expect(screen.getByTestId('gallery-image-placeholder-7')).toBeOnTheScreen();
    expect(within(screen.getByTestId('gallery-image-loading-7'))
      .queryByTestId('gallery-image-placeholder-7')).toBeNull();

    await measure();

    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expect(screen.getByTestId('gallery-image-placeholder-7')).toBeOnTheScreen();
    expect(screen.queryByTestId('gallery-image-local-loaded-7')).toBeNull();

    const layer = [...mockImageRenders].reverse().find((props) => (
      (props.source as { uri?: string } | undefined)?.uri === 'file:///collection/7.gif'
      && typeof props.onDisplay === 'function'
    ));
    await act(async () => {
      (layer?.onDisplay as () => void)();
    });

    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();
  });

  test('a late native error for the old thumbnail does not hide the new one', async () => {
    mockUseActualExpoImage = true;
    const props = {
      image: image({ localUri: null, downloadState: 'mirrored' }),
      onLocalFileMissing: jest.fn(),
      overridePending: true,
    };
    const old = 'file:///library/thumbnails/native-old.webp';
    const own = 'file:///library/thumbnails/native-current.webp';
    const rendered = await render(<GalleryImage {...props} placeholderUri={old} />);
    const pending = screen.getByTestId('gallery-image-loading-7');
    const oldNativeError = screen.getByTestId('gallery-image-placeholder-7').props.onError;
    await rendered.rerender(<GalleryImage {...props} placeholderUri={own} />);
    const current = screen.getByTestId('gallery-image-placeholder-7');
    expect(current.props.source).toEqual({ uri: own });

    await act(async () => {
      oldNativeError({ nativeEvent: { error: 'old load failed late' } });
    });

    expect(screen.getByTestId('gallery-image-placeholder-7').props.source).toEqual({ uri: own });
    expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
  });

  test('a missing seed file does not hide the page\'s own later thumbnail', async () => {
    const props = {
      image: image({ localUri: null, downloadState: 'mirrored' }),
      onLocalFileMissing: jest.fn(),
      overridePending: true,
    };
    const rendered = await render(
      <GalleryImage {...props} placeholderUri="file:///library/thumbnails/gone.webp" />,
    );
    const pending = screen.getByTestId('gallery-image-loading-7');
    await fireEvent(screen.getByTestId('gallery-image-placeholder-7'), 'error');
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();

    const own = 'file:///library/thumbnails/new-valid.webp';
    await rendered.rerender(<GalleryImage {...props} placeholderUri={own} />);

    expect(screen.getByTestId('gallery-image-placeholder-7').props.source).toEqual({ uri: own });
    expect(screen.getByTestId('gallery-image-loading-7')).toBe(pending);
  });

  test('a placeholder that fails to decode hides itself and leaves the black page', async () => {
    await render(
      <GalleryImage
        image={image({ localUri: null, downloadState: 'mirrored' })}
        onLocalFileMissing={jest.fn()}
        overridePending
        placeholderUri={THUMB}
      />,
    );
    await measureLayered();

    await fireEvent(screen.getByTestId('gallery-image-placeholder-7'), 'error');

    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toContain('#726A7D');
    expect(tree).not.toContain('#111111');
    const root = screen.getByLabelText('图片查看器 7').parent;
    expect(root?.props.style.backgroundColor).toBe('#000000');
    expect(screen.getByLabelText('全屏图片 7')).toBeOnTheScreen();
  });
});

describe('board rows 48–49 amendment 1: one stage under the content', () => {
  const THUMB = 'file:///library/thumbnails/7.webp';
  const mounts = (testID: string) => mockMountLog.filter((entry) => entry.testID === testID).length;

  function preview(uri = 'file:///cache/library/7.jpg') {
    return {
      kind: 'file' as const,
      uri,
      tier: 'cached-preview' as const,
      role: 'preview' as const,
    };
  }

  async function layout(node: unknown, width: number, height: number) {
    if (node == null) return;
    await fireEvent(node as never, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width, height } },
    });
  }

  async function measurePage(width = 400, height = 800, label = '图片查看器 7') {
    const content = screen.getByLabelText(label);
    await layout(content.parent, width, height);
    await layout(content, width, height);
  }

  function stageAndContent(label = '图片查看器 7') {
    const content = screen.getByLabelText(label);
    const root = content.parent;
    if (!root || !Array.isArray(root.children) || root.children.length < 2) {
      throw new Error('the page has no stage under a layered root');
    }
    return { root, stage: host(root.children[0]), content };
  }

  function serialise(value: unknown) {
    return JSON.parse(JSON.stringify(value, (_key, item) => (
      typeof item === 'function' ? '[function]' : item
    ))) as unknown;
  }

  test('the thumbnail and the picture each mount once from pending through display', async () => {
    mockUseImageHold = true;
    const row = image({ localUri: null, downloadState: 'mirrored' });
    const rendered = await render(
      <GalleryImage image={row} onLocalFileMissing={jest.fn()} overridePending placeholderUri={THUMB} />,
    );
    await measurePage();
    expect(mounts('gallery-image-placeholder-7')).toBe(1);

    await rendered.rerender(
      <GalleryImage
        image={row}
        onLocalFileMissing={jest.fn()}
        overrideSource={preview()}
        placeholderUri={THUMB}
      />,
    );
    await measurePage();
    expect(mounts('gallery-image-placeholder-7')).toBe(1);
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();

    mockUseImageHold = false;
    await rendered.rerender(
      <GalleryImage
        image={row}
        onLocalFileMissing={jest.fn()}
        overrideSource={preview()}
        placeholderUri={THUMB}
      />,
    );
    expect(mounts('gallery-image-placeholder-7')).toBe(1);
    expect(mounts('gallery-image-override-loaded-7')).toBe(1);

    await act(async () => {
      (screen.getByTestId('gallery-image-override-loaded-7').props.onDisplay as () => void)();
    });
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(mounts('gallery-image-placeholder-7')).toBe(1);
    expect(mounts('gallery-image-override-loaded-7')).toBe(1);
  });

  test('a thumbnail that arrives after the picture has displayed does not appear or remount it', async () => {
    const rendered = await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={null} />,
    );
    await measurePage();
    await act(async () => {
      (screen.getByTestId('gallery-image-local-loaded-7').props.onDisplay as () => void)();
    });
    const before = mounts('gallery-image-local-loaded-7');
    const contentBefore = serialise(screen.getByLabelText('图片查看器 7'));

    await rendered.rerender(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );

    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(mounts('gallery-image-local-loaded-7')).toBe(before);
    expect(serialise(screen.getByLabelText('图片查看器 7'))).toEqual(contentBefore);
  });

  test('a thumbnail that arrives before display is added to the stage without remounting the content', async () => {
    mockUseImageHold = true;
    const rendered = await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={null} />,
    );
    await measurePage();
    const loading = screen.getByTestId('gallery-image-loading-7');
    expect(within(loading).queryByTestId('gallery-image-placeholder-7')).toBeNull();

    await rendered.rerender(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );

    expect(within(screen.getByTestId('gallery-image-loading-7'))
      .queryByTestId('gallery-image-placeholder-7')).toBeNull();
    const { stage } = stageAndContent();
    expect(host(screen.getByTestId('gallery-image-placeholder-7').parent)).toBe(stage);
    expect(styleOf(stage).backgroundColor).toBeUndefined();
    expect(screen.getByTestId('gallery-image-placeholder-7').props.source).toEqual({ uri: THUMB });
    expect(screen.getByTestId('gallery-image-loading-7').props.style).toEqual(loading.props.style);
  });

  test('a retained earlier picture keeps the stage dismissed when the source changes', async () => {
    const rendered = await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );
    await measurePage();
    await act(async () => {
      (screen.getByTestId('gallery-image-local-loaded-7').props.onDisplay as () => void)();
    });
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();

    mockStickPreviousImage = true;
    await rendered.rerender(
      <GalleryImage
        image={image({ localUri: 'file:///collection/7b.jpg' })}
        onLocalFileMissing={jest.fn()}
        placeholderUri={THUMB}
      />,
    );
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();

    mockStickPreviousImage = false;
    await rendered.rerender(
      <GalleryImage
        image={image({ localUri: 'file:///collection/7b.jpg' })}
        onLocalFileMissing={jest.fn()}
        placeholderUri={THUMB}
      />,
    );
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    await act(async () => {
      (screen.getByTestId('gallery-image-local-loaded-7').props.onDisplay as () => void)();
    });
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
  });

  const ABSOLUTE_FILL = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };

  function paintedBackgrounds(node: unknown): string[] {
    const found: string[] = [];
    const visit = (value: unknown) => {
      if (value == null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const record = value as { props?: { style?: unknown }; children?: unknown };
      const style = record.props?.style;
      const styles = Array.isArray(style) ? style : [style];
      for (const item of styles) {
        if (item && typeof item === 'object' && 'backgroundColor' in item) {
          const colour = (item as { backgroundColor?: unknown }).backgroundColor;
          if (typeof colour === 'string') found.push(colour);
        }
      }
      visit(record.children);
    };
    visit(node);
    return found;
  }

  function expectNoPaintedColour() {
    const { root, stage } = stageAndContent();
    expect(root.children[0]).toBe(stage);
    expect(stage.children).toEqual([]);
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(styleOf(stage).backgroundColor).toBeUndefined();
    expect(root.props.style.backgroundColor).toBe('#000000');
    expect(paintedBackgrounds(screen.toJSON()).filter((colour) => (
      colour !== '#000000' && colour !== 'transparent'
    ))).toEqual([]);
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toContain('#726A7D');
    expect(tree).not.toContain('#111111');
  }

  function expectOnlyBlackOrTransparentBackgrounds() {
    const colours = paintedBackgrounds(screen.toJSON());
    expect(colours.length).toBeGreaterThan(0);
    expect(colours.filter((colour) => colour !== '#000000' && colour !== 'transparent')).toEqual([]);
  }

  test('the thumbnail fills the stage and the stage fills the root', async () => {
    await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );
    await measurePage();

    const { stage } = stageAndContent();
    expect(styleOf(stage)).toEqual(ABSOLUTE_FILL);
    const thumb = screen.getByTestId('gallery-image-placeholder-7');
    expect(host(thumb.parent)).toBe(stage);
    expect(thumb.props.contentFit).toBe('contain');
    expect(thumb.props.style).toEqual(ABSOLUTE_FILL);
  });

  test('the stage is the root\'s first child and carries no zIndex, elevation, or blur', async () => {
    await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );
    await measurePage();
    const { root, stage, content } = stageAndContent();
    expect(root.children[0]).toBe(stage);
    expect(root.children[1]).toBe(content);
    expect(styleOf(stage).zIndex).toBeUndefined();
    expect(styleOf(stage).elevation).toBeUndefined();
    expect(stage.props.pointerEvents).toBe('none');
    expect(stage.props.accessible).toBe(false);
    const thumb = screen.getByTestId('gallery-image-placeholder-7');
    expect(thumb.props.blurRadius).toBeUndefined();
    expect(thumb.props.pointerEvents).toBe('none');
    expect(thumb.props.accessible).toBe(false);
    expect(thumb.props.style?.zIndex).toBeUndefined();
    expect(thumb.props.style?.elevation).toBeUndefined();
    expect(content.props.style?.backgroundColor).toBe('transparent');
  });

  test('before any layout event, a layered page shows the stage and the thumbnail', async () => {
    await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );

    expect(screen.queryByTestId('gallery-image-placeholder-7')).not.toBeNull();
    const { root, stage, content } = stageAndContent();
    expect(root.children[0]).toBe(stage);
    expect(root.children[1]).toBe(content);
    expect(host(screen.getByTestId('gallery-image-placeholder-7').parent)).toBe(stage);
    expect(root.props.style.backgroundColor).toBe('#000000');
    expect(JSON.stringify(screen.toJSON())).not.toContain('#726A7D');
  });

  test('the stage is absent for an unavailable row and after the first display', async () => {
    const unavailable = await render(
      <GalleryImage
        image={image()}
        onLocalFileMissing={jest.fn()}
        overrideSource={{ kind: 'unavailable', category: 'offline' }}
        placeholderUri={THUMB}
      />,
    );
    await measurePage();
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(screen.getByTestId('gallery-image-offline-7')).toBeOnTheScreen();
    expect(() => stageAndContent()).toThrow('the page has no stage under a layered root');
    await unavailable.unmount();

    const shown = await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );
    await measurePage();
    await act(async () => {
      (screen.getByTestId('gallery-image-local-loaded-7').props.onDisplay as () => void)();
    });
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(() => stageAndContent()).toThrow('the page has no stage under a layered root');
    const root = screen.getByLabelText('图片查看器 7').parent;
    expect(root?.props.style.backgroundColor).toBe('#000000');
    expect(JSON.stringify(screen.toJSON())).not.toContain('#726A7D');
    await shown.unmount();
  });

  test('a too-large still and an animated layer each dismiss the stage once', async () => {
    const huge = image({
      id: 44,
      extension: '.gif',
      isAnimated: true,
      byteSize: 50_278_178,
      localUri: 'file:///collection/44.gif',
      remoteUrl: 'https://cdn.example.com/44.gif',
      sampleUrl: 'https://cdn.example.com/44.gif',
    });
    const stillPage = await render(
      <GalleryImage image={huge} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );
    await measurePage(400, 800, '图片查看器 44');
    expect(screen.getByTestId('gallery-image-placeholder-44')).toBeOnTheScreen();
    await settleStill(0, { uri: 'file:///cache/gif-still/44.png', missing: false });
    await act(async () => {
      (screen.getByTestId('gallery-image-still-loaded-44').props.onDisplay as () => void)();
    });
    expect(screen.queryByTestId('gallery-image-placeholder-44')).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain('file:///collection/44.gif');
    await stillPage.unmount();

    await render(<GalleryImage image={gif()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />);
    await measurePage();
    expect(screen.getByTestId('gallery-image-placeholder-7')).toBeOnTheScreen();
    const layer = [...mockImageRenders].reverse().find((props) => (
      (props.source as { uri?: string } | undefined)?.uri === 'file:///collection/7.gif'
      && typeof props.onDisplay === 'function'
    ));
    await act(async () => {
      (layer?.onDisplay as () => void)();
    });
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
  });

  test('a thumbnail page paints no dominant colour before or after the picture displays', async () => {
    await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={THUMB} />,
    );
    await measurePage();
    expect(screen.getByTestId('gallery-image-placeholder-7')).toBeOnTheScreen();
    expect(JSON.stringify(screen.toJSON())).not.toContain('#726A7D');
    expect(JSON.stringify(screen.toJSON())).not.toContain('#111111');

    await act(async () => {
      (screen.getByTestId('gallery-image-local-loaded-7').props.onDisplay as () => void)();
    });

    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain('#726A7D');
    expect(JSON.stringify(screen.toJSON())).not.toContain('#111111');
  });

  test('a layered page with no thumbnail paints no colour in the pending, loading, and file states', async () => {
    const pending = await render(
      <GalleryImage
        image={image({ localUri: null, downloadState: 'mirrored' })}
        onLocalFileMissing={jest.fn()}
        overridePending
        placeholderUri={null}
      />,
    );
    await measurePage();
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expectNoPaintedColour();
    await pending.unmount();

    const noDominant = image({
      dominantColor: null as unknown as string,
      localUri: null,
      downloadState: 'mirrored',
    });
    const fallback = await render(
      <GalleryImage
        image={noDominant}
        onLocalFileMissing={jest.fn()}
        overridePending
        placeholderUri={null}
      />,
    );
    await measurePage();
    expectNoPaintedColour();
    await fallback.unmount();

    mockUseImageHold = true;
    const loading = await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={null} />,
    );
    await measurePage();
    expect(screen.getByTestId('gallery-image-loading-7')).toBeOnTheScreen();
    expectNoPaintedColour();
    await loading.unmount();
    mockUseImageHold = false;

    const file = await render(
      <GalleryImage image={image()} onLocalFileMissing={jest.fn()} placeholderUri={null} />,
    );
    await measurePage();
    expect(screen.getByTestId('gallery-image-local-loaded-7')).toBeOnTheScreen();
    expectNoPaintedColour();
    await file.unmount();
  });

  test('a page with no library entry and no dominant colour keeps the #111111 loading fill', async () => {
    const row = image({
      dominantColor: null as unknown as string,
      localUri: null,
      downloadState: 'mirrored',
    });
    await render(
      <GalleryImage image={row} onLocalFileMissing={jest.fn()} overridePending />,
    );
    expect(screen.getByTestId('gallery-image-loading-7')).toHaveStyle({ backgroundColor: '#111111' });
  });

  test('a zero width or height clamps the picture\'s contained size', async () => {
    const cases = [
      { width: 400, height: 1200, boxWidth: 800 / 3, boxHeight: 800 },
      { width: 1200, height: 400, boxWidth: 400, boxHeight: 400 / 3 },
      { width: 0, height: 0, boxWidth: 400, boxHeight: 400 },
      { width: 0, height: 100_000, boxWidth: 1, boxHeight: 800 },
      { width: 100_000, height: 0, boxWidth: 400, boxHeight: 1 },
    ];
    for (const item of cases) {
      const rendered = await render(
        <GalleryImage
          image={image({ width: item.width, height: item.height })}
          onLocalFileMissing={jest.fn()}
        />,
      );
      await measure(400, 800);
      const picture = screen.getByTestId('gallery-image-local-loaded-7');
      expect(Number(picture.props.style.width)).toBeCloseTo(item.boxWidth, 5);
      expect(Number(picture.props.style.height)).toBeCloseTo(item.boxHeight, 5);
      await rendered.unmount();
    }
  });

  test('omitting placeholderUri matches the Task 1 tree', async () => {
    const row = image();
    const renderPair = async (name: string, element: (View: typeof Task1GalleryImage) => ReactElement, finish?: () => Promise<void>) => {
      mockUseImageHold = name.includes('loading');
      const task1 = await render(element(Task1GalleryImage));
      if (finish) await finish();
      const before = serialise(screen.toJSON());
      await task1.unmount();
      mockMountLog = [];
      mockUseImageCalls = [];
      mockImageRenders = [];
      const current = await render(element(GalleryImage as unknown as typeof Task1GalleryImage));
      if (finish) await finish();
      expect(serialise(screen.toJSON())).toEqual(before);
      await current.unmount();
      mockUseImageHold = false;
    };

    const huge = image({
      extension: '.gif',
      isAnimated: true,
      byteSize: 50_278_178,
      localUri: 'file:///collection/7.gif',
      remoteUrl: 'https://cdn.example.com/7.gif',
      sampleUrl: 'https://cdn.example.com/7.gif',
    });
    await renderPair('pending', (View) => (
      <View image={image({ localUri: null, downloadState: 'mirrored' })} onLocalFileMissing={jest.fn()} overridePending />
    ));
    await renderPair('static-loaded', (View) => (
      <View image={row} onLocalFileMissing={jest.fn()} />
    ));
    await renderPair('static-loading', (View) => (
      <View image={row} onLocalFileMissing={jest.fn()} />
    ), async () => { await measurePage(); });
    await renderPair('animated-unmeasured', (View) => (
      <View image={gif()} onLocalFileMissing={jest.fn()} />
    ));
    await renderPair('animated-measured', (View) => (
      <View image={gif()} onLocalFileMissing={jest.fn()} />
    ), async () => { await measurePage(); });
    await renderPair('animated-displayed', (View) => (
      <View image={gif()} onLocalFileMissing={jest.fn()} />
    ), async () => {
      await measurePage();
      const layer = [...mockImageRenders].reverse().find((props) => (
        typeof props.onDisplay === 'function'
      ));
      await act(async () => { (layer?.onDisplay as () => void)(); });
    });
    await renderPair('too-large-unmeasured', (View) => (
      <View image={huge} onLocalFileMissing={jest.fn()} />
    ));
    await renderPair('too-large-measured', (View) => (
      <View image={huge} onLocalFileMissing={jest.fn()} />
    ), async () => { await measurePage(); });
    await renderPair('too-large-still', (View) => (
      <View image={huge} onLocalFileMissing={jest.fn()} />
    ), async () => {
      await measurePage();
      await settleStill(mockStillPending.length - 1, { uri: 'file:///cache/gif-still/7.png', missing: false });
    });
    await renderPair('unavailable', (View) => (
      <View
        image={row}
        onLocalFileMissing={jest.fn()}
        overrideSource={{ kind: 'unavailable', category: 'offline' }}
      />
    ));
  });

  test('the very first commit already contains the stage and thumbnail', async () => {
    const root = createRoot();
    const commits: { children: number; thumbs: number; style: unknown }[] = [];
    try {
      await act(async () => {
        root.render(
          <Profiler
            id="first-commit"
            onRender={() => {
              const content = root.container.queryAll((node) => (
                node.props['aria-label'] === '图片查看器 7'
              ))[0];
              const page = content?.parent;
              const first = page?.children[0];
              commits.push({
                children: page?.children.length ?? 0,
                thumbs: root.container.queryAll((node) => (
                  node.props.testID === 'gallery-image-placeholder-7'
                )).length,
                style: first !== undefined && typeof first !== 'string' ? first.props.style : undefined,
              });
            }}>
            <GalleryImage
              image={image()}
              onLocalFileMissing={jest.fn()}
              overridePending
              placeholderUri={THUMB}
            />
          </Profiler>,
        );
      });
      expect(commits.length).toBeGreaterThan(0);
      expect(commits[0]).toEqual({
        children: 2,
        thumbs: 1,
        style: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  test.each([null, THUMB])('a too-large gif paints no colour with placeholder %s', async (placeholderUri) => {
    await render(
      <GalleryImage
        image={gif({ byteSize: 50_278_178 })}
        onLocalFileMissing={jest.fn()}
        placeholderUri={placeholderUri}
      />,
    );
    expectOnlyBlackOrTransparentBackgrounds();
    await measure();
    expectOnlyBlackOrTransparentBackgrounds();
    await settleStill(0, { uri: 'file:///cache/gif-still/7.png', missing: false });
    expectOnlyBlackOrTransparentBackgrounds();
    await act(async () => {
      (screen.getByTestId('gallery-image-still-loaded-7').props.onDisplay as () => void)();
    });
    expectOnlyBlackOrTransparentBackgrounds();
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
  });

  test.each([null, THUMB])('an animated page paints no colour with placeholder %s', async (placeholderUri) => {
    await render(
      <GalleryImage image={gif()} onLocalFileMissing={jest.fn()} placeholderUri={placeholderUri} />,
    );
    expectOnlyBlackOrTransparentBackgrounds();
    await measure();
    expectOnlyBlackOrTransparentBackgrounds();
    const layer = [...mockImageRenders].reverse().find((props) => (
      (props.source as { uri?: string } | undefined)?.uri === 'file:///collection/7.gif'
      && typeof props.onDisplay === 'function'
    ));
    await act(async () => {
      (layer?.onDisplay as () => void)();
    });
    expectOnlyBlackOrTransparentBackgrounds();
    expect(screen.queryByTestId('gallery-image-placeholder-7')).toBeNull();
  });

  test('N6-C: entryToGalleryMedia renders an import entry through GalleryImage without fabricating a StoredImage', async () => {
    const digest = 'a'.repeat(64);
    const media = entryToGalleryMedia({
      plaintextSha256: digest,
      sourceImageId: null,
      origin: 'import',
      hasImportMembership: true,
      importClassification: 'safe',
      importDeletedAt: null,
      associatedProviderImageIds: [],
      format: 'webp',
      byteSize: 256_000,
      width: 1200,
      height: 1600,
      residency: 'local-original',
      lifecycle: 'active',
      protection: 'protected',
      failureCategory: null,
      hasLocalOriginal: true,
      localOriginalUri: 'file:///library/originals/import-a.webp',
      originalGenerationId: 'gen-1',
      createdAt: 1_728_000_000_000,
    });
    expect(media).toEqual({
      id: digest,
      width: 1200,
      height: 1600,
      byteSize: 256_000,
      extension: 'webp',
      isAnimated: false,
      dominantColor: null,
      localUri: null,
      remoteUrl: null,
      sampleUrl: null,
      providerKey: null,
    });

    await render(
      <GalleryImage
        media={media}
        overrideSource={{
          kind: 'file',
          uri: 'file:///library/originals/import-a.webp',
          tier: 'local-original',
          role: 'original',
        }}
        placeholderUri={THUMB}
        onLocalFileMissing={jest.fn()}
      />,
    );
    expect(screen.getByTestId(`gallery-image-placeholder-${digest}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`gallery-image-override-loaded-${digest}`)).toBeOnTheScreen();
    expect(screen.getByLabelText(`全屏图片 ${digest}`).props.source).toEqual({
      uri: 'file:///library/originals/import-a.webp',
    });
  });
});
