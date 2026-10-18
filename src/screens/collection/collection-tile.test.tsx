/* eslint-disable @typescript-eslint/no-require-imports */
import { act, render, screen } from '@testing-library/react-native';

import type { StoredImage } from '@/features/images/image-repository';
import { libraryTransferProgress } from '@/features/library/library-transfer-progress';
import i18n from '@/i18n';
import { CollectionTile } from '@/screens/collection/collection-tile';

beforeEach(async () => i18n.changeLanguage('zh-Hans'));

// Board #16: every <Image> render's props, so a test can assert over all of them.
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
  Check: () => null,
  Cloud: () => null,
  EyeOff: () => null,
}));

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

function tile(value: StoredImage, onLocalFileMissing = jest.fn()) {
  return (
    <CollectionTile
      image={value}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={onLocalFileMissing}
    />
  );
}

test('gives expo-image a stable recycling key for the rendered source', async () => {
  const { rerender } = await render(tile(image()));

  expect(screen.getByTestId('collection-tile-7')).toBeOnTheScreen();
  expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(
    JSON.stringify([7, 'file:///collection/7.jpg', 0]),
  );

  await rerender(tile(image({ artistName: 'Rehydrated artist' })));

  expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(
    JSON.stringify([7, 'file:///collection/7.jpg', 0]),
  );

  await rerender(tile(image({ id: 8, localUri: 'file:///collection/8.jpg' })));

  expect(screen.getByLabelText('图片 8').props.recyclingKey).toBe(
    JSON.stringify([8, 'file:///collection/8.jpg', 0]),
  );
});

test('board #7: a ready row loads ahead of Discover prefetch on Glide\'s source threads', async () => {
  await render(tile(image()));

  expect(screen.getByLabelText('图片 7').props.priority).toBe('high');
});

test('a mirrored row only in the cloud says 仅在云端', async () => {
  await render(
    <CollectionTile
      image={image({ downloadState: 'mirrored', localUri: null })}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onlyInCloud
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(screen.getByTestId('collection-tile-7').props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，仅在云端');
});

test('needing repair wins over only in the cloud', async () => {
  await render(
    <CollectionTile
      image={image({ downloadState: 'mirrored', localUri: null })}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onlyInCloud
      libraryUnavailable
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(screen.getByTestId('collection-tile-7').props.accessibilityLabel)
    .toContain('离线文件需修复');
});

test('a ready row keeps 可离线查看 when onlyInCloud is set', async () => {
  await render(
    <CollectionTile
      image={image({ downloadState: 'ready', localUri: 'file:///collection/7.jpg' })}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onlyInCloud
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
    />,
  );

  expect(screen.getByTestId('collection-tile-7').props.accessibilityLabel)
    .toContain('可离线查看');
});

test('a pending row renders the cached sample instead of the full original', async () => {
  await render(tile(image({
    localUri: null,
    downloadState: 'pending',
    sampleUrl: 'https://cdn.example.com/7-sample.jpg',
  })));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7-sample.jpg',
  });

  await render(tile(image({
    localUri: null,
    downloadState: 'failed',
    downloadError: 'network',
    sampleUrl: 'https://cdn.example.com/7-sample.jpg',
  })));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7-sample.jpg',
  });
});

test('retries a failed remote load with backoff instead of staying on the background colour', async () => {
  jest.useFakeTimers();
  try {
    const onLocalFileMissing = jest.fn();
    const pending = image({
      localUri: null,
      downloadState: 'pending',
      sampleUrl: 'https://cdn.example.com/7-sample.jpg',
    });
    await render(tile(pending, onLocalFileMissing));

    const keyForAttempt = (attempt: number) =>
      JSON.stringify([7, 'https://cdn.example.com/7-sample.jpg', attempt]);
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(keyForAttempt(0));

    await act(async () => {
      (screen.getByLabelText('图片 7').props.onError as () => void)();
    });
    // The retry is scheduled, not immediate: no reload storm on a DNS flap.
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(keyForAttempt(0));

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(keyForAttempt(1));
    expect(onLocalFileMissing).not.toHaveBeenCalled();

    await act(async () => {
      (screen.getByLabelText('图片 7').props.onError as () => void)();
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(keyForAttempt(2));

    await act(async () => {
      (screen.getByLabelText('图片 7').props.onError as () => void)();
      jest.advanceTimersByTime(8_000);
    });
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(keyForAttempt(3));

    // Bounded: a fourth failure never reloads again.
    await act(async () => {
      (screen.getByLabelText('图片 7').props.onError as () => void)();
      jest.advanceTimersByTime(600_000);
    });
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(keyForAttempt(3));
    expect(onLocalFileMissing).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('overrideSourceUri wins over local and remote sources and skips repair', async () => {
  const onLocalFileMissing = jest.fn();
  await render(
    <CollectionTile
      image={image()}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={onLocalFileMissing}
      overrideSourceUri="file:///cache/library/thumb-7.jpg"
    />,
  );

  const rendered = screen.getByLabelText('图片 7');
  expect(rendered.props.source).toEqual({ uri: 'file:///cache/library/thumb-7.jpg' });
  expect(rendered.props.priority).toBe('high');
  await act(async () => {
    (rendered.props.onError as () => void)();
  });
  expect(onLocalFileMissing).not.toHaveBeenCalled();
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'file:///cache/library/thumb-7.jpg',
  });
});

test('a fast-path override reports its load error through onOverrideFailed', async () => {
  const onLocalFileMissing = jest.fn();
  const onOverrideFailed = jest.fn();
  await render(
    <CollectionTile
      image={image()}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={onLocalFileMissing}
      overrideSourceUri="file:///data/library/originals/a.jpg"
      overrideSourceRole="original"
      onOverrideFailed={onOverrideFailed}
    />,
  );

  const onError = screen.getByLabelText('图片 7').props.onError as () => void;
  await act(async () => {
    onError();
  });
  await act(async () => {
    onError();
  });
  // The tile does not dedupe: the screen keeps it to once per digest.
  expect(onOverrideFailed).toHaveBeenCalledTimes(2);
  expect(onLocalFileMissing).not.toHaveBeenCalled();
});

test('an overridden source never retries: no remount and no repair on error', async () => {
  jest.useFakeTimers();
  try {
    const onLocalFileMissing = jest.fn();
    await render(
      <CollectionTile
        image={image()}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={onLocalFileMissing}
        overrideSourceUri="file:///cache/library/thumb-7.jpg"
      />,
    );

    const initialKey = screen.getByLabelText('图片 7').props.recyclingKey;

    await act(async () => {
      (screen.getByLabelText('图片 7').props.onError as () => void)();
      jest.advanceTimersByTime(20_000);
    });

    // The library resolver owns overridden sources — a retry remount here
    // would fight the resolver, so the recycling key must stay put.
    expect(screen.getByLabelText('图片 7').props.recyclingKey).toBe(initialKey);
    expect(onLocalFileMissing).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('R8.28: a remote gelbooru tile carries the provider Referer', async () => {
  await render(tile(image({
    providerKey: 'gelbooru',
    localUri: null,
    downloadState: 'pending',
    remoteUrl: 'https://img4.gelbooru.com/images/a/b/c.jpg',
    sampleUrl: 'https://img4.gelbooru.com/samples/a/b/sample_c.jpg',
  })));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'https://img4.gelbooru.com/samples/a/b/sample_c.jpg',
    headers: { Referer: 'https://gelbooru.com/' },
  });
});

test('R8.28: local and overridden sources never carry provider headers', async () => {
  // The bytes are already on disk — a Referer on a file:// load is meaningless.
  await render(tile(image({ providerKey: 'gelbooru' })));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'file:///collection/7.jpg',
  });

  await render(
    <CollectionTile
      image={image({ providerKey: 'gelbooru' })}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
      overrideSourceUri="file:///cache/library/thumb-7.jpg"
    />,
  );
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'file:///cache/library/thumb-7.jpg',
  });
});

test('absent overrideSourceUri keeps the accepted local-first source', async () => {
  await render(tile(image()));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'file:///collection/7.jpg',
  });

  await render(tile(image({ localUri: null })));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7.jpg',
  });
});

test('a resolver-owned row renders no provider source while its resolve is pending', async () => {
  await render(
    <CollectionTile
      image={image({
        localUri: null,
        downloadState: 'mirrored',
        sampleUrl: 'https://cdn.example.com/7-sample.jpg',
      })}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
      overrideSourceUri={null}
      overridePending
    />,
  );

  // The library owns this row: while its grid resolve is in flight the tile
  // keeps its colour block and issues no load — never the provider sample,
  // which cost a network round-trip for bytes already on disk and a remount
  // a few ms later (2026-09-16 phone report: tiles slow to fill).
  expect(screen.queryByLabelText('图片 7')).not.toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/)).toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/)).toHaveStyle({ backgroundColor: '#726A7D' });
});

test('single-flights repair by image id and local URI, then retries a changed URI', async () => {
  let finishRepair!: (repaired: boolean) => void;
  const onLocalFileMissing = jest.fn(() => new Promise<boolean>((resolve) => {
    finishRepair = resolve;
  }));
  const { rerender } = await render(tile(image(), onLocalFileMissing));
  const firstError = screen.getByLabelText('图片 7').props.onError as () => void;

  await act(async () => {
    firstError();
    firstError();
  });

  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
  // Spec §5.5 rule 3: the repair names the file the tile failed to load.
  expect(onLocalFileMissing).toHaveBeenNthCalledWith(1, 'file:///collection/7.jpg');
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'https://cdn.example.com/7.jpg',
  });

  await act(async () => finishRepair(false));
  await rerender(tile(image({ artistName: 'Rehydrated artist' }), onLocalFileMissing));

  await act(async () => {
    (screen.getByLabelText('图片 7').props.onError as () => void)();
  });
  expect(onLocalFileMissing).toHaveBeenCalledTimes(1);

  await rerender(tile(image({ localUri: 'file:///collection/7-v2.jpg' }), onLocalFileMissing));
  expect(screen.getByLabelText('图片 7').props.source).toEqual({
    uri: 'file:///collection/7-v2.jpg',
  });

  await act(async () => {
    (screen.getByLabelText('图片 7').props.onError as () => void)();
  });
  expect(onLocalFileMissing).toHaveBeenCalledTimes(2);
  expect(onLocalFileMissing).toHaveBeenNthCalledWith(2, 'file:///collection/7-v2.jpg');
});

test('K2: a mirrored row shows no saving/repair badge and reads as offline-ready', async () => {
  await render(tile(image({ downloadState: 'mirrored', localUri: null })));
  expect(screen.queryByText('保存中')).not.toBeOnTheScreen();
  expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，可离线查看');
});

test('K2 discriminator: a pending row still shows the saving badge', async () => {
  await render(tile(image({ downloadState: 'pending', localUri: null })));
  expect(screen.getByText('保存中')).toBeOnTheScreen();
});

test('K2b: a mirrored row the library cannot serve shows the repair badge and reads as needing repair', async () => {
  await render(
    <CollectionTile
      image={image({ downloadState: 'mirrored', localUri: null })}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
      libraryUnavailable
    />,
  );
  expect(screen.getByText('需修复')).toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，离线文件需修复');
});

test('K6-5 C: a ready row whose library ingest failed is never a blank tile', async () => {
  // Owner phone 2026-09-14 21:30: a 1064x1216 Waifu.im JPEG with its local file
  // present and "可离线查看" on the tile — no ring, no cloud, no repair badge —
  // because the ingest threw and nothing recorded it.
  await render(tile(image({ libraryError: 'decode_failed' })));

  expect(screen.getByText('入库失败')).toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，入库失败');
});

test('K6-5 C discriminator: a ready row with no ingest error keeps its clean tile', async () => {
  await render(tile(image()));

  expect(screen.queryByText('入库失败')).not.toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，可离线查看');
});

test('K6-5 C: a failed download still reads as needing repair, not as an ingest failure', async () => {
  // `download_error` and `library_error` describe different halves of a save;
  // the half that never produced a file wins, because there is nothing to
  // ingest until it is repaired.
  await render(tile(image({
    downloadState: 'failed',
    localUri: null,
    downloadError: 'download_failed',
    libraryError: 'decode_failed',
  })));

  expect(screen.getByText('需修复')).toBeOnTheScreen();
  expect(screen.queryByText('入库失败')).not.toBeOnTheScreen();
});

test('board #5: a failed row the source deleted reads as 源站已删除, not as repairable', async () => {
  // A 404/410 from the booru means the bytes are gone for good; offering
  // "needs repair" there sends the owner into a retry that can never succeed.
  await render(tile(image({
    downloadState: 'failed',
    localUri: null,
    downloadError: 'download_failed',
    downloadErrorKind: 'source_gone',
  })));

  expect(screen.getByText('源站已删除')).toBeOnTheScreen();
  expect(screen.queryByText('需修复')).not.toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，源站已删除，离线文件不可用');
});

test.each(['transient', null] as const)(
  'board #5 discriminator: a failed row of kind %s still reads as repairable',
  async (downloadErrorKind) => {
    await render(tile(image({
      downloadState: 'failed',
      localUri: null,
      downloadError: 'download_failed',
      downloadErrorKind,
    })));

    expect(screen.getByText('需修复')).toBeOnTheScreen();
    expect(screen.queryByText('源站已删除')).not.toBeOnTheScreen();
    expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
      .toBe('收藏图片 7，画师 Artist 7，普通内容，离线文件需修复');
  },
);

test('K3: synced renders the orange cloud and extends the a11y label; absent renders nothing', async () => {
  const { rerender } = await render(tile(image()));
  expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，可离线查看');

  await rerender(
    <CollectionTile
      image={image()}
      selected={false}
      selectionMode={false}
      blurNsfwThumbnail
      synced
      onOpen={jest.fn()}
      onLongPress={jest.fn()}
      onToggleSelection={jest.fn()}
      onLocalFileMissing={jest.fn()}
    />,
  );
  expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.getByLabelText(/收藏图片 7/).props.accessibilityLabel)
    .toBe('收藏图片 7，画师 Artist 7，普通内容，可离线查看，已同步到云端');
});

test('K3: the tile no longer accepts library status copy or a residency prop', () => {
  // Compile-time contract: these props are gone. (No runtime assertion needed.)
  const props = {
    image: image(), selected: false, selectionMode: false, blurNsfwThumbnail: true,
    onOpen: jest.fn(), onLongPress: jest.fn(), onToggleSelection: jest.fn(), onLocalFileMissing: jest.fn(),
  };
  // @ts-expect-error K3 removed statusLabel
  void (<CollectionTile {...props} statusLabel="已保护" />);
  // @ts-expect-error K3 removed residency
  void (<CollectionTile {...props} residency="both" />);
  expect(true).toBe(true);
});

// --- K6-2: the collection tile watches its own transfer (spec §2 G3/G5) -----

describe('collection tile transfer ring', () => {
  const DIGEST = 'a'.repeat(64);
  const GENERATION = 'gen-orig-7';

  beforeEach(() => {
    libraryTransferProgress.clear(DIGEST);
    libraryTransferProgress.clear(GENERATION);
  });

  function syncingTile(overrides: Partial<StoredImage> = {}) {
    return (
      <CollectionTile
        image={image(overrides)}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail
        synced
        libraryDigest={DIGEST}
        libraryOriginalGenerationId={GENERATION}
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={jest.fn()}
      />
    );
  }

  test('shows the ring while this digest is uploading, then the cloud', async () => {
    await render(syncingTile());
    expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeTruthy();

    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 900, total: 1200 });
    });
    const arc = screen.getByTestId('cloud-progress-arc', { includeHiddenElements: true });
    const dashes = arc.props.strokeDasharray as readonly string[];
    expect(Number(dashes[0]) / (2 * Math.PI * Number(arc.props.r))).toBeCloseTo(0.75, 5);
    expect(screen.queryByTestId('cloud-badge', { includeHiddenElements: true })).toBeNull();

    await act(async () => {
      libraryTransferProgress.clear(DIGEST);
    });
    expect(screen.getByTestId('cloud-badge', { includeHiddenElements: true })).toBeTruthy();
  });

  test('a download of the original lights the same ring', async () => {
    await render(syncingTile());
    await act(async () => {
      libraryTransferProgress.set(GENERATION, { sent: 1, total: 4 });
    });
    expect(screen.getByTestId('cloud-progress', { includeHiddenElements: true })).toBeTruthy();
  });

  test('the percentage is announced on the tile, not on the decorative badge', async () => {
    await render(syncingTile());
    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 900, total: 1200 });
    });
    expect(screen.getByTestId('collection-tile-7').props.accessibilityLabel)
      .toContain('75%');
  });

  test('a row with no library identity never subscribes to anything', async () => {
    await render(tile(image()));
    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 1, total: 2 });
    });
    expect(screen.queryByTestId('cloud-progress', { includeHiddenElements: true })).toBeNull();
    libraryTransferProgress.clear(DIGEST);
  });

  test("a download whose length the server did not announce shows the spinner and says 'Syncing…' with no percentage", async () => {
    await i18n.changeLanguage('en');
    await render(syncingTile());
    await act(async () => {
      libraryTransferProgress.set(DIGEST, { sent: 0, total: null });
    });
    expect(screen.getByTestId('cloud-progress-indeterminate', { includeHiddenElements: true })).toBeTruthy();
    const label = screen.getByTestId('collection-tile-7').props.accessibilityLabel as string;
    expect(label).toContain('Syncing…');
    expect(label).not.toMatch(/\d+%/);
    libraryTransferProgress.clear(DIGEST);
  });
});

// --- A1 (owner phone 2026-09-15): NSFW animated tiles were not blurred ------

describe('A1: blurred NSFW animated tiles', () => {
  // Glide applies `blurRadius` as a BitmapTransformation; an animated
  // GifDrawable is not convertible to a bitmap, so the blur was silently
  // skipped and the animation played in the clear. Emulator repro 2026-09-16:
  // static NSFW tiles blurred, the four NSFW gifs rendered sharp under the same
  // setting. An animated NSFW tile is therefore covered outright, and its
  // animation is not played while covered. N10 (owner ruling 2026-10-13: keep
  // the blur, fix the engine): the engine behind blurRadius is
  // NoRsBlurTransformation (patches/expo-image*.patch) — no RenderScript — so
  // the static blur these pins assert is safe on Android 16 too.
  test('an NSFW animated tile is covered and not autoplayed while the setting is on', async () => {
    await render(tile(image({ isNsfw: true, isAnimated: true })));
    expect(screen.getByTestId('collection-tile-cover-7')).toBeOnTheScreen();
    expect(screen.getByText('成人内容')).toBeOnTheScreen();
    expect(screen.getByLabelText('图片 7').props.autoplay).toBe(false);
  });

  test('a static NSFW tile keeps the blur and gets no cover', async () => {
    await render(tile(image({ isNsfw: true, isAnimated: false })));
    expect(screen.queryByTestId('collection-tile-cover-7')).toBeNull();
    expect(screen.getByLabelText('图片 7').props.blurRadius).toBe(24);
  });

  test('an animated tile that is not covered plays and has no cover', async () => {
    await render(tile(image({ isNsfw: false, isAnimated: true })));
    expect(screen.queryByTestId('collection-tile-cover-7')).toBeNull();
    expect(screen.getByLabelText('图片 7').props.autoplay).not.toBe(false);
  });

  test('setting off: an NSFW animated tile plays in the clear, no cover', async () => {
    await render(
      <CollectionTile
        image={image({ isNsfw: true, isAnimated: true })}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail={false}
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('collection-tile-cover-7')).toBeNull();
    expect(screen.getByLabelText('图片 7').props.autoplay).not.toBe(false);
  });

  test('blur off: a static NSFW tile renders uncovered with blur 0', async () => {
    await render(
      <CollectionTile
        image={image({ isNsfw: true, isAnimated: false })}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail={false}
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('collection-tile-cover-7')).toBeNull();
    const tileImage = screen.getByLabelText('图片 7');
    expect(tileImage.props.blurRadius).toBe(0);
    expect(tileImage.props.autoplay).not.toBe(false);
  });
});

// --- Board #16: a gif too large to animate shows its first-frame still -------

describe('board #16: a too-large gif tile', () => {
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
  const renderedUris = () => mockTileRenders.map((props) => (
    (props.source as { uri?: string } | undefined)?.uri
  ));
  const settle = async (at: number, result: MockStillResult) => {
    await act(async () => mockStillPending[at]!(result));
  };

  test('shows the colour block while the still is cut, then renders the still — never the file', async () => {
    await render(tile(huge()));

    expect(screen.queryByLabelText('图片 44')).toBeNull();
    expect(mockTileRenders).toEqual([]);
    expect(mockStillStore.stillFor).toHaveBeenCalledWith(ORIGINAL, 50_278_178);

    await settle(0, { uri: STILL, missing: false });
    const still = screen.getByLabelText('图片 44');
    expect(still.props.source).toEqual({ uri: STILL });
    expect(still.props.priority).toBe('high');
    expect(renderedUris()).not.toContain(ORIGINAL);
  });

  test('a still that cannot be cut keeps the colour block and loads nothing', async () => {
    await render(tile(huge()));
    await settle(0, { uri: null, missing: false });

    expect(screen.queryByLabelText('图片 44')).toBeNull();
    expect(mockTileRenders).toEqual([]);
  });

  test('an NSFW too-large tile with blur on stays covered and is never autoplayed (A1)', async () => {
    await render(tile(huge({ isNsfw: true })));
    expect(screen.getByTestId('collection-tile-cover-44')).toBeOnTheScreen();

    await settle(0, { uri: STILL, missing: false });
    expect(screen.getByTestId('collection-tile-cover-44')).toBeOnTheScreen();
    const still = screen.getByLabelText('图片 44');
    expect(still.props.autoplay).toBe(false);
    expect(still.props.blurRadius).toBe(24);
  });

  test('a too-large row with no local file keeps today\'s remote path (spec §4) and never asks the store', async () => {
    await render(tile(huge({ localUri: null, downloadState: 'none' })));

    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
    expect(screen.getByLabelText('图片 44').props.source).toEqual(
      expect.objectContaining({ uri: 'https://cdn.example.com/44.gif' }),
    );
  });

  test('a gif at or under the cap keeps its local file and never asks the store', async () => {
    await render(tile(huge({ byteSize: 16 * 1024 * 1024 })));

    expect(screen.getByLabelText('图片 44').props.source).toEqual({ uri: ORIGINAL });
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
  });

  test('a too-large non-gif is out of scope: its file renders as before', async () => {
    await render(tile(huge({ extension: '.webp', localUri: 'file:///collection/44.webp' })));

    expect(screen.getByLabelText('图片 44').props.source).toEqual({ uri: 'file:///collection/44.webp' });
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
  });

  test('a library original override is cut too; a derived thumbnail override is already a still', async () => {
    const withOverride = (role: 'original' | 'thumbnail', uri: string) => (
      <CollectionTile
        image={huge({ localUri: null, downloadState: 'mirrored' })}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={jest.fn()}
        overrideSourceUri={uri}
        overrideSourceRole={role}
      />
    );
    const { rerender } = await render(withOverride('original', 'file:///library/44.gif'));
    expect(mockStillStore.stillFor).toHaveBeenCalledWith('file:///library/44.gif', 50_278_178);
    expect(mockTileRenders).toEqual([]);
    await settle(0, { uri: STILL, missing: false });
    expect(screen.getByLabelText('图片 44').props.source).toEqual({ uri: STILL });

    mockStillStore.stillFor.mockClear();
    await rerender(withOverride('thumbnail', 'file:///library/44-thumbnail.bin'));
    expect(screen.getByLabelText('图片 44').props.source).toEqual({ uri: 'file:///library/44-thumbnail.bin' });
    expect(mockStillStore.stillFor).not.toHaveBeenCalled();
  });

  test('a missing library-original override is the resolver\'s to repair, not the tile\'s', async () => {
    const onLocalFileMissing = jest.fn().mockResolvedValue(false);
    const onOverrideFailed = jest.fn();
    await render(
      <CollectionTile
        image={huge()}
        selected={false}
        selectionMode={false}
        blurNsfwThumbnail
        onOpen={jest.fn()}
        onLongPress={jest.fn()}
        onToggleSelection={jest.fn()}
        onLocalFileMissing={onLocalFileMissing}
        overrideSourceUri="file:///library/44.gif"
        overrideSourceRole="original"
        onOverrideFailed={onOverrideFailed}
      />,
    );
    await settle(0, { uri: null, missing: true });

    expect(onOverrideFailed).toHaveBeenCalledTimes(1);
    expect(onLocalFileMissing).not.toHaveBeenCalled();
  });

  test('a missing local file runs the tile repair once; a failed still decode never does', async () => {
    const onLocalFileMissing = jest.fn().mockResolvedValue(false);
    await render(tile(huge(), onLocalFileMissing));
    await settle(0, { uri: STILL, missing: false });

    await act(async () => {
      (screen.getByLabelText('图片 44').props.onError as () => void)();
    });
    expect(onLocalFileMissing).not.toHaveBeenCalled();

    await render(tile(huge({ id: 45, localUri: 'file:///collection/45.gif' }), onLocalFileMissing));
    await settle(1, { uri: null, missing: true });
    expect(onLocalFileMissing).toHaveBeenCalledTimes(1);
    expect(onLocalFileMissing).toHaveBeenCalledWith('file:///collection/45.gif');
  });
});
