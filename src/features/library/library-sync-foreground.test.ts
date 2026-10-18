import {
  createLibraryTransferProgress,
} from '@/features/library/library-transfer-progress';
import {
  createSyncForegroundGuard,
  type SyncForegroundService,
} from '@/features/library/library-sync-foreground';

function fakeService(overrides: Partial<SyncForegroundService> = {}): SyncForegroundService {
  return {
    start: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    ...overrides,
  };
}

/**
 * The guard serializes its native calls on a promise chain, so a single
 * microtask tick is not enough to observe one. `setImmediate` drains the whole
 * chain the synchronous `set`/`clear` above just appended to.
 */
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const t = (key: string, values?: Record<string, unknown>): string => {
  if (values === undefined) return key;
  if (key === 'sync.notificationBodyDownloading') {
    return `${key} ${values.downloading} ${values.done}/${values.total}`;
  }
  return `${key} ${values.done}/${values.total}`;
};

/** A controllable stand-in for `collectionService.subscribeActiveDownloads`. */
function activeDownloads() {
  let emit: ((count: number) => void) | null = null;
  return {
    subscribe(listener: (count: number) => void): () => void {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    push(count: number): void {
      emit?.(count);
    },
    attached(): boolean {
      return emit !== null;
    },
  };
}

describe('createSyncForegroundGuard', () => {
  it('does nothing while nothing is in flight', () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    expect(service.start).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('starts the service when the first transfer goes in flight', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    await flush();

    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledWith(
      'sync.notificationTitle',
      'sync.notificationBody 0/1',
    );
    expect(service.update).not.toHaveBeenCalled();
  });

  it('does not start a second time while a transfer is already in flight', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    store.set('a', { sent: 50, total: 100 });
    store.set('b', { sent: 0, total: 100 });
    await flush();

    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it('counts every transfer this batch has seen, not just the live ones', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    store.set('b', { sent: 0, total: 100 });
    store.set('c', { sent: 0, total: 100 });
    await flush();
    // The owner saved three images; the notification must say 3, whatever the
    // upload concurrency happens to be at this instant.
    expect(service.update).toHaveBeenLastCalledWith(
      'sync.notificationTitle',
      'sync.notificationBody 0/3',
    );

    store.clear('a');
    await flush();
    expect(service.update).toHaveBeenLastCalledWith(
      'sync.notificationTitle',
      'sync.notificationBody 1/3',
    );
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('stops once the last transfer settles', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    store.set('b', { sent: 0, total: 100 });
    await flush();
    store.clear('a');
    store.clear('b');
    await flush();

    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh count for the next batch', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    store.clear('a');
    await flush();
    expect(service.stop).toHaveBeenCalledTimes(1);

    store.set('b', { sent: 0, total: 100 });
    await flush();
    expect(service.start).toHaveBeenCalledTimes(2);
    expect(service.start).toHaveBeenLastCalledWith(
      'sync.notificationTitle',
      'sync.notificationBody 0/1',
    );
  });

  it('requests the notification permission once, before the first start', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const order: string[] = [];
    const requestPermission = jest.fn(async () => {
      order.push('permission');
      return true;
    });
    (service.start as jest.Mock).mockImplementation(async () => {
      order.push('start');
    });
    createSyncForegroundGuard({ service, store, t, requestPermission });

    store.set('a', { sent: 0, total: 100 });
    await flush();
    store.clear('a');
    store.set('b', { sent: 0, total: 100 });
    await flush();

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('permission');
  });

  it('starts anyway when the notification permission is denied', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({
      service,
      store,
      t,
      requestPermission: jest.fn(async () => false),
    });

    store.set('a', { sent: 0, total: 100 });
    await flush();

    // The notification is what the user loses; the unfrozen process — the
    // entire point — is what they keep.
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it('does not claim to be running after a start that threw', async () => {
    const service = fakeService({
      start: jest.fn(async () => {
        throw new Error('no such service');
      }),
    });
    const store = createLibraryTransferProgress();
    createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    await flush();
    store.clear('a');
    await flush();

    // Nothing is running, so there is nothing to stop — and, more importantly,
    // the next batch must not skip its own start because the guard still
    // believes the first one succeeded.
    expect(service.stop).not.toHaveBeenCalled();
    store.set('b', { sent: 0, total: 100 });
    await flush();
    expect(service.start).toHaveBeenCalledTimes(2);
  });

  it('stops and detaches on dispose', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const guard = createSyncForegroundGuard({ service, store, t });

    store.set('a', { sent: 0, total: 100 });
    await flush();
    guard.dispose();
    await flush();
    expect(service.stop).toHaveBeenCalledTimes(1);

    (service.start as jest.Mock).mockClear();
    store.set('b', { sent: 0, total: 100 });
    await flush();
    expect(service.start).not.toHaveBeenCalled();
  });
});

/**
 * K6-5 B. K6-3 covered the second half of a save — the upload — and left the
 * first half outside the foreground service. A booru download frozen by the
 * lock screen never reaches the library, so "save → lock → next open it is in
 * the cloud" fails before any upload exists to protect. In flight therefore
 * means cloud digests OR provider downloads.
 */
describe('K6-5 B: provider downloads hold the service open too', () => {
  it('starts for a provider download with nothing uploading', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const downloads = activeDownloads();
    createSyncForegroundGuard({
      service,
      store,
      t,
      subscribeActiveDownloads: downloads.subscribe,
    });

    downloads.push(1);
    await flush();

    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledWith(
      'sync.notificationTitle',
      'sync.notificationBodyDownloading 1 0/0',
    );
  });

  it('reports downloads and uploads together', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const downloads = activeDownloads();
    createSyncForegroundGuard({
      service,
      store,
      t,
      subscribeActiveDownloads: downloads.subscribe,
    });

    downloads.push(2);
    store.set('a', { sent: 0, total: 100 });
    store.set('b', { sent: 0, total: 100 });
    await flush();

    expect(service.update).toHaveBeenLastCalledWith(
      'sync.notificationTitle',
      'sync.notificationBodyDownloading 2 0/2',
    );
  });

  it('stops only once both the downloads and the uploads are done', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const downloads = activeDownloads();
    createSyncForegroundGuard({
      service,
      store,
      t,
      subscribeActiveDownloads: downloads.subscribe,
    });

    downloads.push(1);
    store.set('a', { sent: 0, total: 100 });
    await flush();
    store.clear('a');
    await flush();
    // A download is still running: the process must stay unfrozen.
    expect(service.stop).not.toHaveBeenCalled();

    downloads.push(0);
    await flush();
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  it('falls back to the upload-only text once the downloads finish', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const downloads = activeDownloads();
    createSyncForegroundGuard({
      service,
      store,
      t,
      subscribeActiveDownloads: downloads.subscribe,
    });

    downloads.push(1);
    store.set('a', { sent: 0, total: 100 });
    await flush();
    downloads.push(0);
    await flush();

    expect(service.update).toHaveBeenLastCalledWith(
      'sync.notificationTitle',
      'sync.notificationBody 0/1',
    );
    expect(service.stop).not.toHaveBeenCalled();
  });

  it('detaches the download subscription on dispose', async () => {
    const service = fakeService();
    const store = createLibraryTransferProgress();
    const downloads = activeDownloads();
    const guard = createSyncForegroundGuard({
      service,
      store,
      t,
      subscribeActiveDownloads: downloads.subscribe,
    });

    downloads.push(1);
    await flush();
    guard.dispose();
    await flush();
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(downloads.attached()).toBe(false);
  });
});
