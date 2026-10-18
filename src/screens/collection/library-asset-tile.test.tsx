/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { LibraryEntry } from '@/features/library/library-view-model';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import { viewDigest } from '@/features/library/library-view-test-support';
import i18n from '@/i18n';
import zhHans from '@/i18n/locales/zh-Hans';
import { LibraryAssetTile } from '@/screens/collection/library-asset-tile';

beforeEach(async () => i18n.changeLanguage('zh-Hans'));

let mockTileRenders: Record<string, unknown>[] = [];
jest.mock('expo-image', () => {
  const { View } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => {
      mockTileRenders.push(props);
      return <View {...props} />;
    },
  };
});

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

beforeEach(() => {
  mockTileRenders = [];
  mockStillPending = [];
  mockStillStore.stillFor.mockClear();
});

jest.mock('lucide-react-native', () => ({
  Cloud: () => null,
  Check: () => null,
  EyeOff: () => null,
}));

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    plaintextSha256: viewDigest('tile'),
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

function tile(
  source: LibraryRenderSource | null,
  overrides: Partial<LibraryEntry> = {},
) {
  return (
    <LibraryAssetTile
      entry={entry(overrides)}
      index={1}
      source={source}
      onOpen={jest.fn()}
    />
  );
}

test('renders a file source without accepting a remote URL prop', async () => {
  const source: LibraryRenderSource = {
    kind: 'file',
    uri: 'file:///cache/library/thumb.jpg',
    tier: 'cached-thumbnail',
    role: 'thumbnail',
  };
  await render(tile(source));

  const pressable = screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`);
  expect(pressable).toHaveStyle({ aspectRatio: 3 / 4, minHeight: 48 });
  expect(pressable.props.role).toBe('button');
  expect(pressable.props.accessibilityLabel).toContain('图库图片 1');
  expect(pressable.props.remoteUrl).toBeUndefined();
  expect(pressable.props.source).toBeUndefined();

  const image = screen.getByLabelText('正在加载图库图片');
  expect(image.props.source).toEqual({ uri: 'file:///cache/library/thumb.jpg' });
  expect(image.props.remoteUrl).toBeUndefined();
});

test('board #7: the file-source tile loads ahead of Discover prefetch on Glide\'s source threads', async () => {
  const source: LibraryRenderSource = {
    kind: 'file',
    uri: 'file:///cache/library/thumb.jpg',
    tier: 'cached-thumbnail',
    role: 'thumbnail',
  };
  await render(tile(source));

  expect(screen.getByLabelText('正在加载图库图片').props.priority).toBe('high');
});

test('shows the offline placeholder with a polite live region', async () => {
  await render(tile({ kind: 'unavailable', category: 'offline' }));

  const pressable = screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`);
  expect(pressable.props.accessibilityLiveRegion).toBe('polite');
  expect(screen.getByTestId(`library-asset-offline-${viewDigest('tile')}`))
    .toHaveTextContent('离线不可用');
});

test('shows the integrity placeholder for integrity and the missing words for object_missing', async () => {
  const { rerender } = await render(tile({ kind: 'unavailable', category: 'integrity' }));
  expect(screen.getByTestId(`library-asset-unavailable-${viewDigest('tile')}`))
    .toHaveTextContent('此图片未能通过校验，未予显示。');

  await rerender(tile({ kind: 'unavailable', category: 'object_missing' }));
  expect(screen.getByTestId(`library-asset-unavailable-${viewDigest('tile')}`))
    .toHaveTextContent(zhHans.libraryView.missingMessage);
});

test("a disconnected phone's locked tile says so", async () => {
  await render(
    <LibraryAssetTile
      entry={entry()}
      index={1}
      source={{ kind: 'unavailable', category: 'auth_attention' }}
      libraryAccess="disconnected"
      onOpen={jest.fn()}
    />,
  );
  expect(screen.getByTestId(`library-asset-locked-${viewDigest('tile')}`))
    .toHaveTextContent(zhHans.libraryView.disconnectedTitle);
});

test('never exposes a remoteUrl-shaped prop on any state', async () => {
  const { rerender } = await render(tile(null));
  const assertNoRemoteUrl = () => {
    const pressable = screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`);
    expect(pressable.props.remoteUrl).toBeUndefined();
    expect(Object.keys(pressable.props)).not.toContain('remoteUrl');
  };
  assertNoRemoteUrl();

  await rerender(tile({
    kind: 'file',
    uri: 'file:///cache/library/thumb.jpg',
    tier: 'cached-thumbnail',
    role: 'thumbnail',
  }));
  assertNoRemoteUrl();

  await rerender(tile({ kind: 'unavailable', category: 'offline' }));
  assertNoRemoteUrl();

  await rerender(tile({ kind: 'unavailable', category: 'integrity' }));
  assertNoRemoteUrl();
});

test('K3: a protected entry shows the orange cloud and no status pill; a11y says only in the cloud', async () => {
  const source: LibraryRenderSource = { kind: 'file', uri: 'file:///cache/library/thumb.jpg', tier: 'cached-thumbnail', role: 'thumbnail' };
  await render(tile(source, { protection: 'protected', hasLocalOriginal: false }));
  expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.queryByText('已保护')).toBeNull();
  expect(screen.queryByText('云端副本需要处理')).toBeNull();
  const pressable = screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`);
  expect(pressable.props.accessibilityLabel).toBe('图库图片 1 · 仅在云端');
});

test('K3: an unprotected entry shows no badge and says only in the cloud', async () => {
  const source: LibraryRenderSource = { kind: 'file', uri: 'file:///cache/library/thumb.jpg', tier: 'cached-thumbnail', role: 'thumbnail' };
  const { rerender } = await render(tile(source, { protection: 'pending', hasLocalOriginal: false }));
  expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
  const pressable = screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`);
  expect(pressable.props.accessibilityLabel).toBe('图库图片 1 · 仅在云端');

  await rerender(tile(source, {
    protection: 'pending',
    hasLocalOriginal: false,
    originalGenerationId: null,
  }));
  expect(screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`).props.accessibilityLabel)
    .toBe('图库图片 1 · 原图已不在这台手机上。');
});

test('K3b G5: a protected asset shows the cloud badge even on the locked placeholder (a11y says only in the cloud)', async () => {
  await render(tile({ kind: 'unavailable', category: 'auth_attention' }, { protection: 'protected' }));
  expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeOnTheScreen();
  const pressable = screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`);
  expect(pressable.props.accessibilityLabel).toContain('仅在云端');
});

test.each([
  [
    'cloud-only protected entry',
    { protection: 'protected', hasLocalOriginal: false, originalGenerationId: 'gen-orig' },
    '图库图片 1 · 仅在云端',
  ],
  [
    'protected entry with local original',
    { protection: 'protected', hasLocalOriginal: true, originalGenerationId: 'gen-orig' },
    '图库图片 1 · 已同步到云端',
  ],
  [
    'unprotected entry with local original',
    { protection: 'pending', hasLocalOriginal: true, originalGenerationId: 'gen-orig' },
    '图库图片 1 · 可离线查看',
  ],
  [
    'no local original and no cloud generation',
    { protection: 'pending', hasLocalOriginal: false, originalGenerationId: null },
    '图库图片 1 · 原图已不在这台手机上。',
  ],
] as const)('the a11y status says where the original is: %s', async (_name, overrides, expected) => {
  const source: LibraryRenderSource = {
    kind: 'file', uri: 'file:///cache/library/thumb.jpg', tier: 'cached-thumbnail', role: 'thumbnail',
  };
  await render(tile(source, overrides));
  expect(screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`).props.accessibilityLabel)
    .toBe(expected);
});

test('K3b G5: a protected asset shows the cloud badge on the loading placeholder (source not yet resolved)', async () => {
  await render(tile(null, { protection: 'protected' }));
  expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeOnTheScreen();
});

test('K3b G5: an unprotected asset shows no cloud badge on the loading placeholder', async () => {
  await render(tile(null, { protection: 'pending' }));
  expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
});

test('K3: auth_attention shows the locked placeholder, not the integrity one', async () => {
  await render(tile({ kind: 'unavailable', category: 'auth_attention' }));
  expect(screen.getByTestId(`library-asset-locked-${viewDigest('tile')}`))
    .toHaveTextContent('解锁云同步后可查看');
  expect(screen.queryByTestId(`library-asset-unavailable-${viewDigest('tile')}`)).toBeNull();
});

// --- K6-2: the tile watches its own transfer (spec §2 G3/G5) ----------------

describe('library tile transfer ring', () => {
  const DIGEST = viewDigest('tile');

  beforeEach(() => {
    libraryTransferProgress.clear(DIGEST);
    libraryTransferProgress.clear('gen-orig');
  });

  const source: LibraryRenderSource = {
    kind: 'file',
    uri: 'file:///cache/library/thumb.jpg',
    tier: 'cached-thumbnail',
    role: 'thumbnail',
  };

  test('an upload in flight shows the ring instead of the cloud', async () => {
    await render(tile(source, { protection: 'pending' }));
    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 300, total: 1200 });
    });
    const arc = screen.getByTestId('cloud-progress-arc', { includeHiddenElements: true });
    const dashes = arc.props.strokeDasharray as readonly string[];
    const circumference = 2 * Math.PI * Number(arc.props.r);
    expect(Number(dashes[0]) / circumference).toBeCloseTo(0.25, 5);
    expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
  });

  test('a download of this asset’s original shows the ring too', async () => {
    await render(tile(source, { protection: 'protected' }));
    await act(async () => {
      libraryTransferProgress.set('gen-orig', { sent: 600, total: 1200 });
    });
    expect(screen.getByTestId('cloud-progress', { includeHiddenElements: true })).toBeTruthy();
  });

  test('a protected asset with nothing in flight keeps the orange cloud', async () => {
    await render(tile(source, { protection: 'protected' }));
    expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('cloud-progress', { includeHiddenElements: true })).toBeNull();
  });

  test('the ring goes away and the cloud takes over when the transfer clears', async () => {
    await render(tile(source, { protection: 'protected' }));
    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 1200, total: 1200 });
    });
    expect(screen.getByTestId('cloud-progress', { includeHiddenElements: true })).toBeTruthy();
    await act(async () => {
      libraryTransferProgress.clear(DIGEST);
    });
    expect(screen.queryByTestId('cloud-progress', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeTruthy();
  });

  test('the percentage is announced in the tile’s own label', async () => {
    await render(tile(source, { protection: 'pending' }));
    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 300, total: 1200 });
    });
    const pressable = screen.getByTestId(`library-asset-tile-${DIGEST}`);
    expect(pressable.props.accessibilityLabel).toContain('25%');
  });

  test('another asset’s transfer never lights up this tile', async () => {
    await render(tile(source, { protection: 'pending' }));
    await act(async () => {
      libraryTransferProgress.set(viewDigest('other'), { sent: 1, total: 2 });
    });
    expect(screen.queryByTestId('cloud-progress', { includeHiddenElements: true })).toBeNull();
    libraryTransferProgress.clear(viewDigest('other'));
  });

  test("a download whose length the server did not announce shows the spinner and says 'Syncing…' with no percentage", async () => {
    await i18n.changeLanguage('en');
    await render(tile(source, { protection: 'protected' }));
    await act(async () => {
      libraryTransferProgress.set('gen-orig', { sent: 0, total: null });
    });
    expect(screen.getByTestId('cloud-progress-indeterminate', { includeHiddenElements: true })).toBeTruthy();
    const label = screen.getByTestId(`library-asset-tile-${DIGEST}`).props.accessibilityLabel as string;
    expect(label).toContain('Syncing…');
    expect(label).not.toMatch(/\d+%/);
    libraryTransferProgress.clear('gen-orig');
  });
});

// --- Board #16: a library-only gif too large to animate ----------------------

describe('board #16: a too-large library gif tile', () => {
  const ORIGINAL = 'file:///library/originals/huge.gif';
  const STILL = 'file:///cache/gif-still/x.png';
  const localOriginal: LibraryRenderSource = {
    kind: 'file',
    uri: ORIGINAL,
    tier: 'local-original',
    role: 'original',
  };
  const renderedUris = () => mockTileRenders.map((props) => (
    (props.source as { uri?: string } | undefined)?.uri
  ));

  test('a 50 MB gif whose grid source is its local original renders the still, never the file', async () => {
    await render(tile(localOriginal, { format: 'gif', byteSize: 50_278_178, hasLocalOriginal: true }));

    expect(mockStillStore.stillFor).toHaveBeenCalledWith(ORIGINAL, 50_278_178);
    expect(mockTileRenders).toEqual([]);
    expect(screen.getByTestId(`library-asset-tile-${viewDigest('tile')}`)).toBeOnTheScreen();

    await act(async () => mockStillPending[0]!({ uri: STILL, missing: false }));
    const image = screen.getByLabelText('正在加载图库图片');
    expect(image.props.source).toEqual({ uri: STILL });
    expect(image.props.priority).toBe('high');
    expect(renderedUris()).not.toContain(ORIGINAL);
  });

  test('a still that cannot be cut keeps the placeholder and loads nothing', async () => {
    await render(tile(localOriginal, { format: 'gif', byteSize: 50_278_178, hasLocalOriginal: true }));
    await act(async () => mockStillPending[0]!({ uri: null, missing: false }));

    expect(mockTileRenders).toEqual([]);
  });

  test('a 1 MB gif entry keeps its local original and never asks the store', async () => {
    await render(tile(localOriginal, { format: 'gif', byteSize: 1_000_000, hasLocalOriginal: true }));

    expect(screen.getByLabelText('正在加载图库图片').props.source).toEqual({ uri: ORIGINAL });
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
  });

  test('a too-large gif whose grid source is its thumbnail (already a still) is unchanged', async () => {
    const thumbnail: LibraryRenderSource = {
      kind: 'file',
      uri: 'file:///cache/library/huge-thumbnail.bin',
      tier: 'cached-thumbnail',
      role: 'thumbnail',
    };
    await render(tile(thumbnail, { format: 'gif', byteSize: 50_278_178 }));

    expect(screen.getByLabelText('正在加载图库图片').props.source)
      .toEqual({ uri: 'file:///cache/library/huge-thumbnail.bin' });
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
  });

  test('a 50 MB jpeg is not a gif: unchanged', async () => {
    await render(tile({ ...localOriginal, uri: 'file:///library/originals/big.jpg' }, {
      format: 'jpeg',
      byteSize: 50_278_178,
      hasLocalOriginal: true,
    }));

    expect(screen.getByLabelText('正在加载图库图片').props.source)
      .toEqual({ uri: 'file:///library/originals/big.jpg' });
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
  });
});

describe('N6-B1: import thumbnail obscuring (blur & GIF cover) and selection', () => {
  const DIGEST = viewDigest('tile');
  const fileSource: LibraryRenderSource = {
    kind: 'file',
    uri: 'file:///cache/library/thumb.jpg',
    tier: 'cached-thumbnail',
    role: 'thumbnail',
  };

  test('safe import is never blurred or covered even when blurNsfwThumbnail is true', async () => {
    await render(
      <LibraryAssetTile
        entry={entry({ importClassification: 'safe', format: 'jpeg' })}
        index={1}
        source={fileSource}
        blurNsfwThumbnail
        onOpen={jest.fn()}
      />,
    );

    const img = screen.getByLabelText('正在加载图库图片');
    expect(img.props.blurRadius).toBe(0);
    expect(screen.queryByTestId(`library-asset-tile-cover-${DIGEST}`)).toBeNull();
  });

  test('static adult and unknown imports apply blurRadius=24 when blurNsfwThumbnail is true', async () => {
    const { rerender } = await render(
      <LibraryAssetTile
        entry={entry({ importClassification: 'adult', format: 'png' })}
        index={1}
        source={fileSource}
        blurNsfwThumbnail
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByLabelText('正在加载图库图片').props.blurRadius).toBe(24);

    await rerender(
      <LibraryAssetTile
        entry={entry({ importClassification: 'unknown', format: 'webp' })}
        index={1}
        source={fileSource}
        blurNsfwThumbnail
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByLabelText('正在加载图库图片').props.blurRadius).toBe(24);
  });

  test('animated GIF adult/unknown import renders opaque cover and autoplay=false when blurNsfwThumbnail is true, including on loading placeholder', async () => {
    const { rerender } = await render(
      <LibraryAssetTile
        entry={entry({ importClassification: 'adult', format: 'gif' })}
        index={1}
        source={null}
        blurNsfwThumbnail
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByTestId(`library-asset-tile-cover-${DIGEST}`)).toBeOnTheScreen();

    await rerender(
      <LibraryAssetTile
        entry={entry({ importClassification: 'adult', format: 'gif' })}
        index={1}
        source={fileSource}
        blurNsfwThumbnail
        onOpen={jest.fn()}
      />,
    );
    const img = screen.getByLabelText('正在加载图库图片');
    expect(img.props.autoplay).toBe(false);
    expect(screen.getByTestId(`library-asset-tile-cover-${DIGEST}`)).toBeOnTheScreen();
  });

  test('long press enters selection and suppresses the immediate follow-up tap; selectionMode tap toggles selection', async () => {
    const onOpen = jest.fn();
    const onLongPress = jest.fn();
    const onToggleSelection = jest.fn();
    const { rerender } = await render(
      <LibraryAssetTile
        entry={entry()}
        index={1}
        source={fileSource}
        onOpen={onOpen}
        onLongPress={onLongPress}
        onToggleSelection={onToggleSelection}
      />,
    );

    const pressable = screen.getByTestId(`library-asset-tile-${DIGEST}`);
    await fireEvent(pressable, 'longPress');
    await fireEvent.press(pressable);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    await rerender(
      <LibraryAssetTile
        entry={entry()}
        index={1}
        source={fileSource}
        selected
        selectionMode
        onOpen={onOpen}
        onLongPress={onLongPress}
        onToggleSelection={onToggleSelection}
      />,
    );
    expect(screen.getByTestId(`library-asset-tile-${DIGEST}`).props.accessibilityState).toEqual({
      selected: true,
    });
    await fireEvent.press(screen.getByTestId(`library-asset-tile-${DIGEST}`));
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('fastPathUri renders local original directly without resolved source and fires onFastPathFailed on image load error or missing GIF still', async () => {
    const onFastPathFailed = jest.fn();
    const { rerender } = await render(
      <LibraryAssetTile
        entry={entry({
          hasLocalOriginal: true,
          localOriginalUri: 'file:///data/library/originals/fast.jpg',
          format: 'jpeg',
        })}
        index={1}
        source={null}
        fastPathUri="file:///data/library/originals/fast.jpg"
        onFastPathFailed={onFastPathFailed}
        onOpen={jest.fn()}
      />,
    );

    const img = screen.getByLabelText('正在加载图库图片');
    expect(img.props.source).toEqual({ uri: 'file:///data/library/originals/fast.jpg' });
    await act(async () => {
      img.props.onError?.();
    });
    expect(onFastPathFailed).toHaveBeenCalledTimes(1);

    // Too-large GIF on fastPathUri whose still comes back missing also fires onFastPathFailed:
    const onGifFastPathFailed = jest.fn();
    await rerender(
      <LibraryAssetTile
        entry={entry({
          hasLocalOriginal: true,
          localOriginalUri: 'file:///data/library/originals/huge-fast.gif',
          format: 'gif',
          byteSize: 50_278_178,
        })}
        index={1}
        source={null}
        fastPathUri="file:///data/library/originals/huge-fast.gif"
        onFastPathFailed={onGifFastPathFailed}
        onOpen={jest.fn()}
      />,
    );
    await act(async () => {
      mockStillPending.at(-1)?.({ uri: null, missing: true });
    });
    expect(onGifFastPathFailed).toHaveBeenCalledTimes(1);
  });
});
