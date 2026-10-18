import {
  createExpoFileRepository,
  type ExpoDirectoryHandle,
  type ExpoFileAdapter,
  type ExpoFileHandle,
} from '@/features/collection/expo-file-repository';
import {
  LIBRARY_RANGE_SEGMENT_CONCURRENCY,
  type RangeProbeResult,
} from '@/features/collection/range-download';

function createInjectedAdapter(
  cachedPath: string | null = null,
  copyFile?: (
    sourceUri: string,
    destination: ExpoFileHandle,
    commit: () => void,
  ) => void | Promise<void>,
) {
  const operations: string[] = [];
  const files = new Map<string, { exists: boolean; size: number }>();
  const rootUri = 'file:///documents/collection';
  if (cachedPath !== null) {
    const cachedUri = cachedPath.startsWith('/') ? `file://${cachedPath}` : cachedPath;
    files.set(cachedUri, { exists: true, size: 42 });
  }

  const createFileHandle = (uri: string): ExpoFileHandle & {
    copy(destination: ExpoFileHandle): void | Promise<void>;
  } => ({
    uri,
    get exists() {
      return files.get(uri)?.exists ?? false;
    },
    get size() {
      return files.get(uri)?.size ?? 0;
    },
    delete() {
      operations.push(`delete:${uri}`);
      files.delete(uri);
    },
    async move(destination) {
      operations.push(`move:${uri}->${destination.uri}`);
      const source = files.get(uri);
      if (!source?.exists) throw new Error('missing source');
      files.delete(uri);
      files.set(destination.uri, source);
    },
    async copy(destination) {
      operations.push(`copy:${uri}->${destination.uri}`);
      const source = files.get(uri);
      if (!source?.exists) throw new Error('missing source');
      const commit = () => files.set(destination.uri, { ...source });
      if (copyFile) await copyFile(uri, destination, commit);
      else commit();
    },
  });

  const directory: ExpoDirectoryHandle = {
    uri: rootUri,
    exists: true,
    get size() {
      return [...files.values()].filter((f) => f.exists).reduce((sum, f) => sum + f.size, 0);
    },
    create(options) {
      operations.push(`create-directory:${JSON.stringify(options)}`);
    },
    list() {
      return [...files.entries()]
        .filter(([, value]) => value.exists)
        .map(([uri]) => createFileHandle(uri));
    },
  };

  const adapter: ExpoFileAdapter = {
    createCollectionDirectory() {
      operations.push('create-collection-directory');
      return directory;
    },
    createFile(location, name) {
      const uri = typeof location === 'string'
        ? location
        : `${location.uri}/${name}`;
      operations.push(`create-file:${uri}`);
      return createFileHandle(uri);
    },
    isFile(value): value is ExpoFileHandle {
      return typeof value === 'object' && value !== null && 'move' in value;
    },
    rangeDownloader: null,
    async getCachedImagePath(cacheKey) {
      operations.push(`cache-path:${cacheKey}`);
      return cachedPath;
    },
    createDownloadTask(remoteUrl, destination, options) {
      operations.push(`create-download:${remoteUrl}->${destination.uri}`);
      operations.push(`download-signal:${options?.signal ? 'present' : 'missing'}`);
      return {
        cancel() {
          operations.push(`cancel:${destination.uri}`);
        },
        async downloadAsync() {
          operations.push(`download:${destination.uri}`);
          files.set(destination.uri, { exists: true, size: 42 });
          return destination;
        },
      };
    },
    async isSharingAvailable() {
      operations.push('sharing-available');
      return true;
    },
    async share(uri) {
      operations.push(`share:${uri}`);
    },
    async requestPhotoPermission(writeOnly, granularPermissions) {
      operations.push(`permission:${writeOnly}:${granularPermissions.join(',')}`);
      return { granted: true };
    },
    async createAsset(uri) {
      operations.push(`asset:${uri}`);
    },
  };

  return { adapter, files, operations };
}

describe('Expo collection file adapter', () => {
  test('K7 ㉖: collection bytes come from the directory size, not one handle per file', async () => {
    const { adapter, files, operations } = createInjectedAdapter(null);
    files.set('file:///documents/collection/1.webp', { exists: true, size: 40 });
    files.set('file:///documents/collection/2.webp.partial', { exists: true, size: 2 });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.getCollectionBytes()).resolves.toBe(42);
    expect(operations.filter((op) => op.startsWith('create-file:'))).toEqual([]);
  });

  test('copies an already rendered Expo Image cache entry without another network request', async () => {
    const cachedPath = '/data/user/0/expo/cache/7.webp';
    const { adapter, operations } = createInjectedAdapter(cachedPath);
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const image = {
      id: 7,
      providerKey: 'waifu_im' as const,
      providerItemId: '7',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://cdn.example.com/7.webp',
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1,
      height: 1,
      byteSize: 42,
      extension: '.webp',
      dominantColor: '#000000',
      isNsfw: false,
      isAnimated: false,
      tags: [],
    };

    const onTransferStart = jest.fn();
    await expect(repository.download(image, { onTransferStart })).resolves.toEqual({
      uri: 'file:///documents/collection/7.webp',
      reused: false,
    });

    expect(operations).toEqual(expect.arrayContaining([
      'cache-path:https://cdn.example.com/7.webp',
      `copy:file://${cachedPath}->file:///documents/collection/7.webp.partial`,
      'move:file:///documents/collection/7.webp.partial->file:///documents/collection/7.webp',
    ]));
    expect(operations).not.toContain(
      'create-download:https://cdn.example.com/7.webp->file:///documents/collection/7.webp.partial',
    );
    expect(onTransferStart).not.toHaveBeenCalled();
  });

  test('does not reuse the Expo Image cache after cancellation', async () => {
    const cachedPath = '/data/user/0/expo/cache/9.webp';
    const { adapter, operations } = createInjectedAdapter(cachedPath);
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const controller = new AbortController();
    controller.abort();

    await expect(repository.download({
      id: 9,
      providerKey: 'waifu_im',
      providerItemId: '9',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://cdn.example.com/9.webp',
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1,
      height: 1,
      byteSize: 42,
      extension: '.webp',
      dominantColor: '#000000',
      isNsfw: false,
      isAnimated: false,
      tags: [],
    }, { signal: controller.signal })).rejects.toMatchObject({
      code: 'download_failed',
    });

    expect(operations.some((operation) => operation.startsWith('cache-path:'))).toBe(false);
    expect(operations.some((operation) => operation.startsWith('copy:'))).toBe(false);
    expect(operations.some((operation) => operation.startsWith('create-download:'))).toBe(false);
  });

  test('removes a cache copy that finishes after cancellation', async () => {
    const cachedPath = '/data/user/0/expo/cache/10.webp';
    let releaseCopy!: () => void;
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const { adapter, files, operations } = createInjectedAdapter(
      cachedPath,
      async (_source, _destination, commit) => {
        copyStarted();
        await release;
        commit();
      },
    );
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const controller = new AbortController();
    const download = repository.download({
      id: 10,
      providerKey: 'waifu_im',
      providerItemId: '10',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://cdn.example.com/10.webp',
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1,
      height: 1,
      byteSize: 42,
      extension: '.webp',
      dominantColor: '#000000',
      isNsfw: false,
      isAnimated: false,
      tags: [],
    }, { signal: controller.signal });

    await started;
    controller.abort();
    releaseCopy();
    await expect(download).rejects.toMatchObject({ code: 'download_failed' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const partialUri = 'file:///documents/collection/10.webp.partial';
    expect(files.has(partialUri)).toBe(false);
    expect(operations).toEqual(expect.arrayContaining([
      `copy:file://${cachedPath}->${partialUri}`,
      `delete:${partialUri}`,
    ]));
    expect(operations.some((operation) => operation.startsWith('create-download:'))).toBe(false);
    expect(operations.some((operation) => operation.startsWith('move:'))).toBe(false);
  });

  test('delegates Android file, sharing, and photo operations through SDK56-shaped APIs', async () => {
    const { adapter, operations } = createInjectedAdapter();
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const image = {
      id: 7,
      providerKey: 'waifu_im' as const,
      providerItemId: '7',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://cdn.example.com/7.webp',
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1,
      height: 1,
      byteSize: 42,
      extension: '.webp',
      dominantColor: '#000000',
      isNsfw: false,
      isAnimated: false,
      tags: [],
    };

    const downloaded = await repository.download(image);
    await repository.share(downloaded.uri);
    await repository.exportToPhotos(downloaded.uri);

    expect(downloaded).toEqual({
      uri: 'file:///documents/collection/7.webp',
      reused: false,
    });
    expect(operations).toEqual(expect.arrayContaining([
      'create-collection-directory',
      'create-directory:{"idempotent":true,"intermediates":true}',
      'create-download:https://cdn.example.com/7.webp->file:///documents/collection/7.webp.partial',
      'download-signal:missing',
      'download:file:///documents/collection/7.webp.partial',
      'move:file:///documents/collection/7.webp.partial->file:///documents/collection/7.webp',
      'sharing-available',
      'share:file:///documents/collection/7.webp',
      'permission:true:photo',
      'asset:file:///documents/collection/7.webp',
    ]));
  });

  test('R8.28: forwards provider image headers to the SDK 56 download task', async () => {
    const { adapter, operations } = createInjectedAdapter();
    const seen: (Record<string, string> | undefined)[] = [];
    const createTask = adapter.createDownloadTask;
    adapter.createDownloadTask = (remoteUrl, destination, options) => {
      seen.push((options as { headers?: Record<string, string> } | undefined)?.headers);
      return createTask(remoteUrl, destination, options);
    };
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const image = {
      id: 7,
      providerKey: 'gelbooru' as const,
      providerItemId: '7',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://img4.gelbooru.com/images/a/b/7.webp',
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1,
      height: 1,
      byteSize: 42,
      extension: '.webp',
      dominantColor: '#000000',
      isNsfw: false,
      isAnimated: false,
      tags: [],
    };

    await repository.download(image);

    expect(seen).toEqual([{ Referer: 'https://gelbooru.com/' }]);
    expect(operations).toEqual(expect.arrayContaining([
      'download:file:///documents/collection/7.webp.partial',
    ]));
  });

  test('passes AbortSignal to SDK 56, cancels a never-settling task, and removes the partial', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    adapter.createDownloadTask = (remoteUrl, destination, options) => {
      operations.push(`create-download:${remoteUrl}->${destination.uri}`);
      operations.push(`download-signal:${options?.signal ? 'present' : 'missing'}`);
      return {
        cancel() {
          operations.push(`cancel:${destination.uri}`);
        },
        downloadAsync() {
          files.set(destination.uri, { exists: true, size: 5 });
          return new Promise(() => undefined);
        },
      };
    };
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const controller = new AbortController();
    const image = {
      id: 8,
      providerKey: 'waifu_im' as const,
      providerItemId: '8',
      canonicalSourceKey: null,
      perceptualHash: null,
      md5: null,
      remoteUrl: 'https://cdn.example.com/8.webp',
      sourceUrl: null,
      artistName: null,
      artistUrl: null,
      width: 1,
      height: 1,
      byteSize: 42,
      extension: '.webp',
      dominantColor: '#000000',
      isNsfw: false,
      isAnimated: false,
      tags: [],
    };

    const download = repository.download(image, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(download).rejects.toMatchObject({ code: 'download_failed' });
    expect(operations).toEqual(expect.arrayContaining([
      'download-signal:present',
      'cancel:file:///documents/collection/8.webp.partial',
      'delete:file:///documents/collection/8.webp.partial',
    ]));
  });

  test('returns a typed unavailable repository on web without touching native adapter members', async () => {
    const nativeAdapter = new Proxy({} as ExpoFileAdapter, {
      get() {
        throw new Error('native adapter was touched');
      },
    });
    const repository = createExpoFileRepository({
      platform: 'web',
      adapter: nativeAdapter,
    });

    await expect(repository.getCollectionBytes()).rejects.toMatchObject({
      name: 'CollectionServiceError',
      code: 'platform_unavailable',
      message: expect.any(String),
    });
    await expect(repository.share('file:///missing.webp')).rejects.toMatchObject({
      code: 'platform_unavailable',
    });
  });
});

type RangeRequest = {
  url: string;
  destinationUri: string;
  headers?: Readonly<Record<string, string>>;
  totalBytes: number;
  parts: number;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number) => void;
};

function konachanImage(id: number) {
  return {
    id,
    providerKey: 'konachan' as const,
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://konachan.net/image/${id}.png`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 3840,
    height: 2160,
    byteSize: 4_250_693,
    extension: '.png',
    dominantColor: '#000000',
    isNsfw: false,
    isAnimated: false,
    tags: [],
  };
}

/**
 * K6-4c. A stand-in for `modules/waifu-sync-service`'s range downloader that
 * records every window request and, by default, writes the destination file the
 * way the native one does.
 */
function attachRangeDownloader(
  adapter: ExpoFileAdapter,
  files: Map<string, { exists: boolean; size: number }>,
  overrides: {
    probe?: (url: string) => Promise<RangeProbeResult>;
    run?: (request: RangeRequest) => Promise<void>;
  } = {},
) {
  const probes: string[] = [];
  const requests: RangeRequest[] = [];

  adapter.rangeDownloader = {
    async probe(url) {
      probes.push(url);
      if (overrides.probe) return await overrides.probe(url);
      return { kind: 'probe', totalBytes: 4_250_693, acceptsRanges: true };
    },
    async downloadRanges(request) {
      requests.push(request);
      if (overrides.run) {
        await overrides.run(request);
        return;
      }
      files.set(request.destinationUri, { exists: true, size: request.totalBytes });
    },
  };

  return { probes, requests };
}

describe('K6-4c parallel range download', () => {
  test('splits a wallpaper-size range-capable file instead of opening one stream', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { probes, requests } = attachRangeDownloader(adapter, files);
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.download(konachanImage(11))).resolves.toEqual({
      uri: 'file:///documents/collection/11.png',
      reused: false,
    });

    expect(probes).toEqual(['https://konachan.net/image/11.png']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://konachan.net/image/11.png',
      destinationUri: 'file:///documents/collection/11.png.partial',
      totalBytes: 4_250_693,
      // ~512 KB target parts, capped at 8 (ceil(4.25 MB / 512 KB) = 9 -> 8).
      parts: 8,
    });
    expect(operations.some((operation) => operation.startsWith('create-download:'))).toBe(false);
    expect(operations).toContain(
      'move:file:///documents/collection/11.png.partial->file:///documents/collection/11.png',
    );
  });

  test('leaves a file below the split threshold on the single-stream path', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files, {
      probe: async () => ({ kind: 'probe', totalBytes: 500_000, acceptsRanges: true }),
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download(konachanImage(12));

    expect(requests).toHaveLength(0);
    expect(operations).toContain(
      'create-download:https://konachan.net/image/12.png->file:///documents/collection/12.png.partial',
    );
  });

  test('leaves a host that will not serve windows on the single-stream path', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files, {
      probe: async () => ({ kind: 'probe', totalBytes: 4_250_693, acceptsRanges: false }),
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download(konachanImage(13));

    expect(requests).toHaveLength(0);
    expect(operations).toContain(
      'create-download:https://konachan.net/image/13.png->file:///documents/collection/13.png.partial',
    );
  });

  test('does not pay a probe round trip for an image the booru already sized below the split', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { probes, requests } = attachRangeDownloader(adapter, files);
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download({ ...konachanImage(19), byteSize: 500_000 });

    expect(probes).toEqual([]);
    expect(requests).toHaveLength(0);
    expect(operations).toContain(
      'create-download:https://konachan.net/image/19.png->file:///documents/collection/19.png.partial',
    );
  });

  test('still probes when the booru declared no size', async () => {
    const { adapter, files } = createInjectedAdapter();
    const { probes, requests } = attachRangeDownloader(adapter, files);
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download({ ...konachanImage(25), byteSize: 0 });

    expect(probes).toEqual(['https://konachan.net/image/25.png']);
    expect(requests).toHaveLength(1);
  });

  test('never probes when the native module is not linked', async () => {
    const { adapter, operations } = createInjectedAdapter();
    expect(adapter.rangeDownloader).toBeNull();
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download(konachanImage(14));

    expect(operations).toContain(
      'create-download:https://konachan.net/image/14.png->file:///documents/collection/14.png.partial',
    );
  });

  test('falls back to one stream exactly once when a window fails', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files, {
      run: async () => {
        throw new Error('ERR_DOWNLOAD_RANGE');
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.download(konachanImage(15))).resolves.toEqual({
      uri: 'file:///documents/collection/15.png',
      reused: false,
    });

    expect(requests).toHaveLength(1);
    expect(
      operations.filter((operation) => operation.startsWith('create-download:')),
    ).toEqual([
      'create-download:https://konachan.net/image/15.png->file:///documents/collection/15.png.partial',
    ]);
  });

  test('falls back to one stream when the probe itself fails', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files, {
      probe: async () => {
        throw new Error('probe refused');
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download(konachanImage(16));

    expect(requests).toHaveLength(0);
    expect(operations).toContain(
      'create-download:https://konachan.net/image/16.png->file:///documents/collection/16.png.partial',
    );
  });

  test('forwards provider image headers to both the probe and the windows', async () => {
    const { adapter, files } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files);
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await repository.download({ ...konachanImage(17), providerKey: 'gelbooru' as const });

    expect(requests[0].headers).toEqual({ Referer: 'https://gelbooru.com/' });
  });

  test('abandons the parallel path rather than falling back when the save is cancelled', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const controller = new AbortController();
    const { requests } = attachRangeDownloader(adapter, files, {
      run: async () => {
        controller.abort();
        throw new Error('ERR_DOWNLOAD_CANCELLED');
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });
    const onTransferStart = jest.fn();

    await expect(
      repository.download(konachanImage(18), {
        signal: controller.signal,
        onTransferStart,
      }),
    ).rejects.toMatchObject({ code: 'download_failed' });

    expect(requests).toHaveLength(1);
    expect(onTransferStart).toHaveBeenCalledTimes(1);
    expect(operations.some((operation) => operation.startsWith('create-download:'))).toBe(false);
  });

  test('does not let narrow saves barge past a wallpaper already queued for windows', async () => {
    const { adapter, files } = createInjectedAdapter();
    const releases: (() => void)[] = [];
    const sizes = new Map<string, number>();
    const { requests } = attachRangeDownloader(adapter, files, {
      probe: async (url) => ({
        kind: 'probe',
        totalBytes: sizes.get(url) ?? 1024 * 1024,
        acceptsRanges: true,
      }),
      run: async (request) => {
        await new Promise<void>((resolve) => { releases.push(resolve); });
        files.set(request.destinationUri, { exists: true, size: request.totalBytes });
      },
    });
    const repository = createExpoFileRepository({
      platform: 'android',
      adapter,
      segmentConcurrency: LIBRARY_RANGE_SEGMENT_CONCURRENCY,
    });

    // Sixteen 1 MiB images are two windows each (~512 KB target): exactly the 32-segment budget.
    const narrow = Array.from({ length: 16 }, (_unused, index) => repository.download({
      ...konachanImage(50 + index),
      byteSize: 1024 * 1024,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(16);

    // An 8 MiB wallpaper now queues for eight windows.
    sizes.set('https://konachan.net/image/70.png', 8 * 1024 * 1024);
    const wallpaper = repository.download({
      ...konachanImage(70),
      byteSize: 8 * 1024 * 1024,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(16);

    // One narrow save finishes, freeing two windows — not the eight the
    // wallpaper needs. A narrow save arriving now fits in those two, and must
    // still not take them: the wallpaper is the save this path exists for, and
    // a stream of small images would otherwise starve it indefinitely.
    releases.splice(0, 1)[0]();
    const latecomer = repository.download({
      ...konachanImage(71),
      byteSize: 1024 * 1024,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(16);

    // Three more narrow saves finish: eight windows free in total, which is
    // what the wallpaper has been waiting for. It must be the next save to
    // start, ahead of the narrow one queued behind it.
    for (const release of releases.splice(0, 3)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(17);
    expect(requests[16].destinationUri).toBe('file:///documents/collection/70.png.partial');

    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases.splice(0)) release();
    await Promise.all([...narrow, wallpaper, latecomer]);
  });

  test('a save waiting for a range lease does not stall', async () => {
    const { adapter, files } = createInjectedAdapter();
    const releases: (() => void)[] = [];
    const { requests } = attachRangeDownloader(adapter, files, {
      run: async (request) => {
        await new Promise<void>((resolve) => { releases.push(resolve); });
        files.set(request.destinationUri, { exists: true, size: request.totalBytes });
      },
    });
    const repository = createExpoFileRepository({
      platform: 'android',
      adapter,
      segmentConcurrency: 8,
    });
    const firstWait = jest.fn();
    const firstAcquired = jest.fn();
    const secondWait = jest.fn();
    const secondAcquired = jest.fn();
    const firstStarted = jest.fn();
    const secondStarted = jest.fn();
    const first = repository.download(konachanImage(72), {
      onTransferStart: firstStarted,
      onLeaseWait: firstWait,
      onLeaseAcquired: firstAcquired,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(firstStarted).toHaveBeenCalledTimes(1);
    expect(firstWait).not.toHaveBeenCalled();
    expect(firstAcquired).toHaveBeenCalledTimes(1);

    const second = repository.download(konachanImage(73), {
      onTransferStart: secondStarted,
      onLeaseWait: secondWait,
      onLeaseAcquired: secondAcquired,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondStarted).not.toHaveBeenCalled();
    expect(secondWait).toHaveBeenCalledTimes(1);
    expect(secondAcquired).not.toHaveBeenCalled();

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
    expect(secondStarted).toHaveBeenCalledTimes(1);
    expect(secondAcquired).toHaveBeenCalledTimes(1);

    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second]);
  });

  test('a cancelled save waiting for a range lease never starts its transfer', async () => {
    const { adapter, files } = createInjectedAdapter();
    const releases: (() => void)[] = [];
    const { requests } = attachRangeDownloader(adapter, files, {
      run: async (request) => {
        await new Promise<void>((resolve) => { releases.push(resolve); });
        files.set(request.destinationUri, { exists: true, size: request.totalBytes });
      },
    });
    const repository = createExpoFileRepository({
      platform: 'android',
      adapter,
      segmentConcurrency: 8,
    });
    const first = repository.download(konachanImage(74));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    const controller = new AbortController();
    const onTransferStart = jest.fn();
    const onLeaseWait = jest.fn();
    const onLeaseAcquired = jest.fn();
    const second = repository.download(konachanImage(75), {
      signal: controller.signal,
      onTransferStart,
      onLeaseWait,
      onLeaseAcquired,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    releases.shift()?.();

    await expect(first).resolves.toBeDefined();
    await expect(second).rejects.toMatchObject({ code: 'download_failed' });
    expect(requests).toHaveLength(1);
    expect(onTransferStart).not.toHaveBeenCalled();
    expect(onLeaseWait).toHaveBeenCalledTimes(1);
    expect(onLeaseAcquired).not.toHaveBeenCalled();
  });

  test('holds the total number of in-flight windows at or under the global segment cap', async () => {
    const { adapter, files } = createInjectedAdapter();
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const { requests } = attachRangeDownloader(adapter, files, {
      probe: async () => ({ kind: 'probe', totalBytes: 8 * 1024 * 1024, acceptsRanges: true }),
      run: async (request) => {
        inFlight += request.parts;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        inFlight -= request.parts;
        files.set(request.destinationUri, { exists: true, size: request.totalBytes });
      },
    });
    const repository = createExpoFileRepository({
      platform: 'android',
      adapter,
      segmentConcurrency: LIBRARY_RANGE_SEGMENT_CONCURRENCY,
    });

    // Five 8-window images is 40 segments; the cap is 32.
    const downloads = [20, 21, 22, 23, 24].map((id) => repository.download({
      ...konachanImage(id),
      byteSize: 8 * 1024 * 1024,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(peak).toBeLessThanOrEqual(LIBRARY_RANGE_SEGMENT_CONCURRENCY);
    expect(requests).toHaveLength(4);

    // Releasing the first four lets the fifth image's windows start.
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(5);
    for (const release of releases.splice(0)) release();

    await Promise.all(downloads);
    expect(peak).toBeLessThanOrEqual(LIBRARY_RANGE_SEGMENT_CONCURRENCY);
  });

  test('two repositories in one app draw windows from the same budget', async () => {
    const first = createInjectedAdapter();
    const second = createInjectedAdapter();
    const releases: (() => void)[] = [];
    const writeOnRelease = (
      files: Map<string, { exists: boolean; size: number }>,
    ) => async (request: RangeRequest) => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      files.set(request.destinationUri, { exists: true, size: request.totalBytes });
    };
    const probe = async (): Promise<RangeProbeResult> => ({
      kind: 'probe',
      totalBytes: 8 * 1024 * 1024,
      acceptsRanges: true,
    });

    const firstRange = attachRangeDownloader(first.adapter, first.files, {
      probe,
      run: writeOnRelease(first.files),
    });
    const secondRange = attachRangeDownloader(second.adapter, second.files, {
      probe,
      run: writeOnRelease(second.files),
    });
    const repositories = [first, second].map(({ adapter }) => createExpoFileRepository({
      platform: 'android',
      adapter,
    }));

    // The app builds a repository in app services and another in the library
    // integration. Four 8-window images through the first one is the whole
    // 32-segment cap, so the second one's save has to wait — a per-repository
    // budget would silently let it open another eight sockets.
    const saturating = [80, 81, 82, 83].map((id) => repositories[0].download({
      ...konachanImage(id),
      byteSize: 8 * 1024 * 1024,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstRange.requests).toHaveLength(4);

    const other = repositories[1].download({ ...konachanImage(84), byteSize: 8 * 1024 * 1024 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondRange.requests).toHaveLength(0);

    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondRange.requests).toHaveLength(1);
    for (const release of releases.splice(0)) release();
    await Promise.all([...saturating, other]);
  });
});

describe('K6-4d download progress reporting', () => {
  const plainImage = (id: number) => ({
    id,
    providerKey: 'waifu_im' as const,
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${id}.webp`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 1,
    height: 1,
    byteSize: 42,
    extension: '.webp',
    dominantColor: '#000000',
    isNsfw: false,
    isAnimated: false,
    tags: [],
  });

  test('the single-stream path forwards download-task progress to onProgress', async () => {
    const { adapter, files } = createInjectedAdapter();
    adapter.createDownloadTask = (_remoteUrl, destination, options) => ({
      cancel() {},
      async downloadAsync() {
        options?.onProgress?.(1_024);
        options?.onProgress?.(4_096);
        files.set(destination.uri, { exists: true, size: 42 });
        return destination;
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    const received: number[] = [];
    await repository.download(plainImage(41), {
      onProgress: (bytes) => received.push(bytes),
    });

    expect(received).toEqual([1_024, 4_096]);
  });

  test('the parallel range path forwards native window progress to onProgress', async () => {
    const { adapter, files } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files, {
      run: async (request) => {
        request.onProgress?.(1_000_000);
        request.onProgress?.(4_250_693);
        files.set(request.destinationUri, { exists: true, size: request.totalBytes });
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    const received: number[] = [];
    await repository.download(konachanImage(42), {
      onProgress: (bytes) => received.push(bytes),
    });

    expect(received).toEqual([1_000_000, 4_250_693]);
    expect(requests[0]?.onProgress).toBeDefined();
  });
});

describe('board #5 download-failure classification', () => {
  test('a probe that answers 404 fails the save with the status instead of retrying single-stream', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    const { requests } = attachRangeDownloader(adapter, files, {
      probe: async () => ({ kind: 'gone', status: 404 }),
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.download(konachanImage(80))).rejects.toMatchObject({
      name: 'CollectionServiceError',
      code: 'download_failed',
      httpStatus: 404,
    });

    // A 404 on the probe is a 404 on the file: retrying it on the single-stream
    // path would spend a round trip only to throw the status away again.
    expect(requests).toHaveLength(0);
    expect(operations.some((operation) => operation.startsWith('create-download:'))).toBe(false);
  });

  test('a probe that answers 410 fails the save with the status', async () => {
    const { adapter, files, operations } = createInjectedAdapter();
    attachRangeDownloader(adapter, files, {
      probe: async () => ({ kind: 'gone', status: 410 }),
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.download(konachanImage(81))).rejects.toMatchObject({
      code: 'download_failed',
      httpStatus: 410,
    });
    expect(operations.some((operation) => operation.startsWith('create-download:'))).toBe(false);
  });

  test("carries the status out of the single-stream task's own rejection", async () => {
    const { adapter } = createInjectedAdapter();
    adapter.createDownloadTask = () => ({
      cancel() {},
      downloadAsync() {
        return Promise.reject(new Error('Unable to download a file: HTTP 404'));
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.download(konachanImage(82))).rejects.toMatchObject({
      name: 'CollectionServiceError',
      code: 'download_failed',
      httpStatus: 404,
    });
  });

  test('carries a retryable status through unchanged for the classifier to judge', async () => {
    const { adapter } = createInjectedAdapter();
    adapter.createDownloadTask = () => ({
      cancel() {},
      downloadAsync() {
        return Promise.reject(new Error('Unable to download a file: HTTP 503'));
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(repository.download(konachanImage(83))).rejects.toMatchObject({
      code: 'download_failed',
      httpStatus: 503,
    });
  });

  test('a cancelled save still surfaces as cancellation, not as a status', async () => {
    const { adapter } = createInjectedAdapter();
    const controller = new AbortController();
    adapter.createDownloadTask = () => ({
      cancel() {},
      downloadAsync() {
        // A cancelled task can still reject with a status attached — the
        // request was already in flight when the user backed out. The status
        // must not win: the save failed because the user cancelled it, and
        // storing `source_gone` here would strand an image that is still there.
        controller.abort();
        return Promise.reject(new Error('Unable to download a file: HTTP 404'));
      },
    });
    const repository = createExpoFileRepository({ platform: 'android', adapter });

    await expect(
      repository.download(konachanImage(84), { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'download_failed',
      message: 'This image download was cancelled.',
      httpStatus: null,
    });
  });
});
