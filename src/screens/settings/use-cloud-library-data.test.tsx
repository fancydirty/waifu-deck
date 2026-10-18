import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import { createMemoryCloudObjectStore } from '@/features/cloud-store/memory-cloud-object-store';
import { createLibraryChangeFeed } from '@/features/library/library-change-feed';
import i18n from '@/i18n';
import { createCloudLibrarySource, useCloudLibraryData, type CloudLibraryReaders, type CloudLibraryData } from './use-cloud-library-data';
import { deriveCloudFooter } from './cloud-library-model';

jest.mock('lucide-react-native', () => ({ ChevronRight: () => null }));

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const COUNTS = { backedUp: 2, backedUpTotal: 2, downloaded: 2, downloadedTotal: 2,
  inCloud: 0, inCloudBytes: 0, totalBytes: 150, pending: 0 };
function ready(store = createMemoryCloudObjectStore()): ByosStatus {
  return { status: 'ready', context: { kind: 'store', store,
    binding: { kind: 'gdrive', accountEmail: 'owner@example.com', refreshToken: 'SECRET',
      rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs' },
    meta: { format: 'waifu-deck-byos', protocolVersion: 2, vaultId: 'vault', encryption: 'aes-gcm',
      kdf: { algo: 'scrypt', N: 16384, r: 8, p: 1, saltB64: 'salt' }, keyCheckB64: 'key', createdAt: '' },
    masterKey: new Uint8Array(32), deviceId: 'phone' } };
}
function setup(overrides: Partial<CloudLibraryReaders> = {}) {
  const feed = createLibraryChangeFeed();
  const unsubscribe = jest.fn();
  const readers = {
    readStoredIdentity: jest.fn(async () => ({ kind: 'gdrive' as const, label: 'Google Drive', identity: 'owner@example.com' })),
    readMirrorCounts: jest.fn(async () => COUNTS), readLastSyncedAt: jest.fn(async () => 100),
    readQuotaFullCount: jest.fn(async () => 0), readStorageMode: jest.fn(async () => 'both' as const),
    readQuota: jest.fn(async () => ({ usedBytes: 10, totalBytes: null })),
    subscribeLibraryChanges: jest.fn((listener: () => void) => {
      const off = feed.subscribe(listener);
      return () => { off(); unsubscribe(); };
    }), ...overrides,
  };
  return { readers, feed, unsubscribe, change: () => feed.emit({ kind: 'round-complete' }) };
}
beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('read states', () => {
  it('pending has no figures; first rejected and absent reads never invent zero', async () => {
    const counts = deferred<typeof COUNTS>();
    const { readers } = setup({ readMirrorCounts: jest.fn(() => counts.promise) });
    const status = ready();
    const { result, rerender, unmount } = await renderHook(
      ({ readers }: { readers: CloudLibraryReaders }) => useCloudLibraryData({ byosStatus: status, readers, enabled: true }),
      { initialProps: { readers: readers as CloudLibraryReaders } },
    );
    expect(result.current.counts.state).toBe('pending');
    expect(result.current.model.stats).toBeNull();
    expect(result.current.model.footer).toBeNull();
    await act(async () => counts.reject(new Error('counts')));
    expect(result.current.counts.state).toBe('error');
    expect(result.current.model.state).toBe('ready');
    expect(result.current.model.stats).toBeNull();
    await rerender({ readers: { ...readers, readMirrorCounts: undefined, readLastSyncedAt: undefined } });
    expect(result.current.counts.state).toBe('unread');
    expect(result.current.lastSyncedAt.state).toBe('unread');
    expect(result.current.model.footer).toBeNull();
    await unmount();
  });
  it('unconfigured reads nothing; locked reads only safe local identity', async () => {
    const { readers } = setup();
    const { result, rerender, unmount } = await renderHook(
      ({ status }: { status: ByosStatus }) => useCloudLibraryData({ byosStatus: status, readers, enabled: true }),
      { initialProps: { status: { status: 'unconfigured' } as ByosStatus } },
    );
    expect(readers.readStoredIdentity).not.toHaveBeenCalled();
    await rerender({ status: { status: 'locked', reason: 'password_required' } });
    expect(readers.readStoredIdentity).toHaveBeenCalledTimes(1);
    expect(result.current.model.identity?.identity).toBe('owner@example.com');
    expect(result.current.model.stats).toBeNull();
    expect(readers.readMirrorCounts).not.toHaveBeenCalled();
    expect(readers.readStorageMode).not.toHaveBeenCalled();
    expect(readers.readQuota).not.toHaveBeenCalled();
    await unmount();
  });
  it('ready reads each port and subscribes once; equal renders add no calls', async () => {
    const status = ready();
    const { readers, unsubscribe } = setup();
    const { result, rerender, unmount } = await renderHook(
      (_: { tick: number }) => useCloudLibraryData({ byosStatus: { ...status }, readers, enabled: true }),
      { initialProps: { tick: 0 } },
    );
    expect(result.current.model.stats?.inCloud).toBe(2);
    expect(readers.readStoredIdentity).not.toHaveBeenCalled();
    await rerender({ tick: 1 });
    for (const port of [readers.readMirrorCounts, readers.readLastSyncedAt, readers.readQuotaFullCount,
      readers.readStorageMode, readers.readQuota, readers.subscribeLibraryChanges]) expect(port).toHaveBeenCalledTimes(1);
    await unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('S3 never calls quota even when a quota port exists', async () => {
    const storeStatus = ready();
    if (storeStatus.status !== 'ready') throw new Error('fixture');
    const status: ByosStatus = { status: 'ready', context: { ...storeStatus.context, kind: 's3',
      credentials: { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'bucket', region: 'auto',
        accessKeyId: 'SECRET', secretAccessKey: 'SECRET', prefix: '' } } };
    const { readers, change } = setup();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    await act(async () => change());
    expect(readers.readQuota).not.toHaveBeenCalled();
    expect(result.current.quota).toBeNull();
    await unmount();
  });
});

describe('atomic rounds and freshness', () => {
  it('records every publication: round starts publish nothing; an interrupted settle is fresh and starts exactly one follow-up', async () => {
    const rounds = [1, 2, 3].map(() => ({
      counts: deferred<typeof COUNTS>(), at: deferred<number | null>(), full: deferred<number>(),
    }));
    const { readers, change, unsubscribe } = setup({
      readMirrorCounts: jest.fn().mockReturnValueOnce(rounds[0].counts.promise)
        .mockReturnValueOnce(rounds[1].counts.promise).mockReturnValueOnce(rounds[2].counts.promise),
      readLastSyncedAt: jest.fn().mockReturnValueOnce(rounds[0].at.promise)
        .mockReturnValueOnce(rounds[1].at.promise).mockReturnValueOnce(rounds[2].at.promise),
      readQuotaFullCount: jest.fn().mockReturnValueOnce(rounds[0].full.promise)
        .mockReturnValueOnce(rounds[1].full.promise).mockReturnValueOnce(rounds[2].full.promise),
      readStorageMode: undefined,
    });
    const source = createCloudLibrarySource({ readers, enabled: true, ready: true,
      store: null, identity: null, locked: false });
    const recorded: ReturnType<typeof source.getSnapshot>[] = [];
    // Observe inside every publish, including those React may batch into one render.
    const off = source.subscribe(() => { recorded.push(source.getSnapshot()); });
    const stop = source.start();
    try {
      await act(async () => {
        rounds[0].counts.resolve(COUNTS); rounds[0].at.resolve(100); rounds[0].full.resolve(0);
      });
      expect(source.getSnapshot()).toMatchObject({ readRoundId: 1,
        counts: { state: 'read', fresh: true, roundId: 1, value: COUNTS },
        lastSyncedAt: { state: 'read', fresh: true, roundId: 1, value: 100 },
        quotaFullCount: { state: 'read', fresh: true, roundId: 1, value: 0 } });
      const first = source.getSnapshot();
      const interruptedStart = recorded.length;
      change(); // Round 2 is deferred; starts must keep the last settled snapshot.
      expect(source.getSnapshot()).toBe(first);
      expect(recorded).toHaveLength(interruptedStart);
      change(); change(); change(); // The in-flight dirty path publishes nothing, too.
      expect(source.getSnapshot()).toBe(first);
      expect(recorded).toHaveLength(interruptedStart);
      for (const port of [readers.readMirrorCounts, readers.readLastSyncedAt, readers.readQuotaFullCount]) {
        expect(port).toHaveBeenCalledTimes(2);
      }
      await act(async () => {
        rounds[1].counts.resolve({ ...COUNTS, totalBytes: 300 });
        rounds[1].at.resolve(200); rounds[1].full.resolve(1);
      });
      // Record inside publish so React batching cannot hide a stale intermediate snapshot.
      const interrupted = recorded.slice(interruptedStart);
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({ readRoundId: 2,
        counts: { state: 'read', fresh: true, roundId: 2, value: { ...COUNTS, totalBytes: 300 } },
        lastSyncedAt: { state: 'read', fresh: true, roundId: 2, value: 200 },
        quotaFullCount: { state: 'read', fresh: true, roundId: 2, value: 1 } });
      expect(source.getSnapshot()).toBe(interrupted[0]);
      for (const port of [readers.readMirrorCounts, readers.readLastSyncedAt, readers.readQuotaFullCount]) {
        expect(port).toHaveBeenCalledTimes(3);
      }
      await act(async () => {
        rounds[2].counts.resolve({ ...COUNTS, totalBytes: 400 });
        rounds[2].at.resolve(300); rounds[2].full.resolve(2);
      });
      const final = source.getSnapshot();
      expect(final).toMatchObject({ readRoundId: 3,
        counts: { state: 'read', fresh: true, roundId: 3, value: { ...COUNTS, totalBytes: 400 } },
        lastSyncedAt: { state: 'read', fresh: true, roundId: 3, value: 300 },
        quotaFullCount: { state: 'read', fresh: true, roundId: 3, value: 2 } });
      expect(recorded.slice(interruptedStart)).toEqual([interrupted[0], final]);
    } finally {
      stop(); off();
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'] as const)('records no late %s from a previous activation, including a dirty follow-up', async (outcome) => {
    const old = deferred<typeof COUNTS>();
    const { readers, change } = setup({ readMirrorCounts: jest.fn().mockReturnValueOnce(old.promise).mockResolvedValue(COUNTS),
      readStorageMode: undefined });
    const source = createCloudLibrarySource({ readers, enabled: true, ready: true,
      store: null, identity: null, locked: false });
    const recorded: ReturnType<typeof source.getSnapshot>[] = [];
    const off = source.subscribe(() => recorded.push(source.getSnapshot()));
    const stopOld = source.start();
    change(); change();
    stopOld();
    const stopNew = source.start();
    try {
      await act(async () => {});
      const fresh = source.getSnapshot();
      expect(fresh.counts).toMatchObject({ state: 'read', fresh: true, value: COUNTS });
      const publications = recorded.length;
      await act(async () => {
        if (outcome === 'resolve') old.resolve({ ...COUNTS, totalBytes: 999 });
        else old.reject(new Error('obsolete'));
      });
      expect(source.getSnapshot()).toBe(fresh);
      expect(recorded).toHaveLength(publications);
      expect(readers.readMirrorCounts).toHaveBeenCalledTimes(2);
    } finally {
      stopNew(); off();
    }
  });
  it.each([0, 4, 7])('watermark waits for counts; failure keeps stats stale and suppresses claims (pending %s)', async (pending) => {
    const nextCounts = deferred<typeof COUNTS>();
    const nextAt = deferred<number | null>();
    const nextFull = deferred<number>();
    const { readers, change } = setup({
      readMirrorCounts: jest.fn().mockResolvedValueOnce({ ...COUNTS, pending, downloaded: pending === 7 ? 0 : 2 }).mockReturnValueOnce(nextCounts.promise),
      readLastSyncedAt: jest.fn().mockResolvedValueOnce(100).mockReturnValueOnce(nextAt.promise),
      readQuotaFullCount: jest.fn().mockResolvedValueOnce(0).mockReturnValueOnce(nextFull.promise),
    });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    const firstId = result.current.readRoundId;
    const footer = result.current.model.footer;
    expect(footer).not.toBeNull();
    await act(async () => change());
    expect(result.current.model.footer).toEqual(footer);
    expect(result.current.readRoundId).toBe(firstId);
    expect(result.current.counts.fresh).toBe(true);
    expect(result.current.model.stats?.pending).toBe(pending);
    expect(footer).not.toBeNull();
    await act(async () => nextAt.resolve(200));
    expect(result.current.lastSyncedAt).toMatchObject({ state: 'read', value: 100, fresh: true });
    expect(result.current.model.footer).toEqual(footer);
    await act(async () => { nextCounts.reject(new Error('counts')); nextFull.resolve(0); });
    expect(result.current.counts).toMatchObject({ state: 'read', fresh: false, value: { pending } });
    expect(result.current.lastSyncedAt).toMatchObject({ value: 200, fresh: true });
    expect(result.current.readRoundId).toBe(firstId + 1);
    for (const value of [result.current.counts, result.current.lastSyncedAt, result.current.quotaFullCount]) {
      expect(value.roundId).toBe(result.current.readRoundId);
    }
    expect(result.current.model.footer).toBeNull();
    await unmount();
  });
  it('a mixed round id cannot select a footer from the real snapshot', async () => {
    const { readers } = setup();
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    expect(result.current.model.footer?.kind).toBe('synced');
    expect(deriveCloudFooter({ ...result.current,
      lastSyncedAt: { ...result.current.lastSyncedAt, roundId: result.current.readRoundId - 1 },
    })).toBeNull();
    await unmount();
  });
  it('a burst during flight coalesces one follow-up and keeps the interrupted settled round fresh', async () => {
    const counts = deferred<typeof COUNTS>();
    const follow = deferred<typeof COUNTS>();
    const { readers, change } = setup({ readMirrorCounts: jest.fn().mockResolvedValueOnce(COUNTS)
      .mockReturnValueOnce(counts.promise).mockReturnValueOnce(follow.promise) });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    await act(async () => change());
    await act(async () => { change(); change(); change(); });
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(2);
    await act(async () => counts.resolve({ ...COUNTS, totalBytes: 300 }));
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(3);
    expect(result.current.counts).toMatchObject({ fresh: true, value: { totalBytes: 300 } });
    expect(result.current.lastSyncedAt.fresh).toBe(true);
    expect(result.current.quotaFullCount.fresh).toBe(true);
    expect(result.current.model.footer).toEqual({ kind: 'synced', at: 100 });
    await act(async () => follow.resolve({ ...COUNTS, totalBytes: 400 }));
    expect(result.current.model.stats?.totalBytes).toBe(400);
    expect(result.current.model.footer).toEqual({ kind: 'synced', at: 100 });
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(3);
    await unmount();
  });
  it('a failed refresh of old missing-download counts cannot claim downloading', async () => {
    const { readers, change } = setup({ readMirrorCounts: jest.fn()
      .mockResolvedValueOnce({ ...COUNTS, downloaded: 0 }).mockRejectedValueOnce(new Error('counts')) });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    expect(result.current.model.footer).toEqual({ kind: 'downloading', count: 2 });
    await act(async () => change());
    expect(result.current.counts).toMatchObject({ state: 'read', fresh: false, value: { downloaded: 0 } });
    expect(result.current.model.footer).toBeNull();
    await unmount();
  });
  it('quota-full failure retains its old number without making a stale full claim', async () => {
    const { readers, change } = setup({ readQuotaFullCount: jest.fn().mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('full')) });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    expect(result.current.model.footer).toEqual({ kind: 'quota-full', count: 3 });
    await act(async () => change());
    expect(result.current.quotaFullCount).toMatchObject({ value: 3, fresh: false });
    expect(result.current.model.footer).toBeNull();
    await unmount();
  });
});

describe('independent quota, lifecycle and mode', () => {
  it.each([0, 3])('deferred quota cannot hold local stats or footers; several events produce one non-overlapping follow-up (pending %s)', async (pending) => {
    const quota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const next = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const third = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const { readers, change } = setup({ readMirrorCounts: jest.fn(async () => ({ ...COUNTS, pending })),
      readQuota: jest.fn().mockReturnValueOnce(quota.promise).mockReturnValueOnce(next.promise).mockReturnValueOnce(third.promise) });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    expect(result.current.model.stats?.totalBytes).toBe(150);
    const footer = pending > 0 ? { kind: 'pending', count: pending } : { kind: 'synced', at: 100 };
    expect(result.current.model.footer).toEqual(footer);
    await act(async () => { change(); change(); change(); });
    expect(result.current.model.footer).toEqual(footer);
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(3);
    expect(readers.readQuota).toHaveBeenCalledTimes(1);
    expect(readers.readStorageMode).toHaveBeenCalledTimes(1);
    await act(async () => quota.resolve({ usedBytes: 5, totalBytes: null }));
    expect(result.current.quota).toEqual({ usedBytes: 5, totalBytes: null });
    expect(readers.readQuota).toHaveBeenCalledTimes(2);
    await act(async () => { change(); change(); change(); });
    expect(readers.readQuota).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve({ usedBytes: 9, totalBytes: 0 }));
    expect(result.current.quota).toEqual({ usedBytes: 9, totalBytes: 0 });
    expect(readers.readQuota).toHaveBeenCalledTimes(3);
    await act(async () => third.resolve(null));
    expect(result.current.quota).toBeNull();
    expect(readers.readQuota).toHaveBeenCalledTimes(3);
    await unmount();
  });
  it.each(['null', 'reject'] as const)('clears successful quota on %s', async (outcome) => {
    const readQuota = jest.fn().mockResolvedValueOnce({ usedBytes: 10, totalBytes: 20 });
    if (outcome === 'null') readQuota.mockResolvedValueOnce(null);
    else readQuota.mockRejectedValueOnce(new Error('quota'));
    const { readers, change } = setup({ readQuota });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    expect(result.current.quota).not.toBeNull();
    await act(async () => change());
    expect(result.current.quota).toBeNull();
    await unmount();
  });
  it('store-only replacement selects a clean snapshot before paint with the same binding and local ports', async () => {
    const oldQuota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const freshQuota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const { readers, change } = setup({ readQuota: jest.fn().mockResolvedValueOnce({ usedBytes: 10, totalBytes: 20 })
      .mockReturnValueOnce(oldQuota.promise).mockReturnValueOnce(freshQuota.promise) });
    const status = ready();
    if (status.status !== 'ready' || status.context.kind !== 'store') throw new Error('fixture');
    const next: ByosStatus = { status: 'ready', context: { ...status.context, store: createMemoryCloudObjectStore() } };
    const painted: { quota: CloudLibraryData['quota']; stats: number | null }[] = [];
    const { result, rerender, unmount } = await renderHook(({ status }: { status: ByosStatus }) => {
      const data = useCloudLibraryData({ byosStatus: status, readers, enabled: true });
      painted.push({ quota: data.quota, stats: data.model.stats?.totalBytes ?? null });
      return data;
    }, { initialProps: { status } });
    await act(async () => change());
    painted.length = 0;
    await rerender({ status: next });
    expect(painted[0]).toEqual({ quota: null, stats: null });
    await act(async () => oldQuota.resolve({ usedBytes: 999, totalBytes: 1000 }));
    expect(result.current.quota).toBeNull();
    await act(async () => freshQuota.resolve({ usedBytes: 99, totalBytes: 100 }));
    expect(result.current.quota?.usedBytes).toBe(99);
    await unmount();
  });
  it.each(['resolve', 'reject'] as const)('replacement discards obsolete %s and its dirty follow-up', async (outcome) => {
    const old = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const oldCounts = deferred<typeof COUNTS>();
    const first = setup({ readQuota: jest.fn(() => old.promise), readMirrorCounts: jest.fn(() => oldCounts.promise) });
    const second = setup({ readQuota: jest.fn(async () => ({ usedBytes: 99, totalBytes: 100 })) });
    const { result, rerender, unmount } = await renderHook(
      ({ status, readers }: { status: ByosStatus; readers: CloudLibraryReaders }) => useCloudLibraryData({ byosStatus: status, readers, enabled: true }),
      { initialProps: { status: ready(), readers: first.readers as CloudLibraryReaders } },
    );
    await act(async () => first.change());
    await rerender({ status: ready(), readers: second.readers });
    expect(result.current.quota?.usedBytes).toBe(99);
    await act(async () => {
      if (outcome === 'resolve') { old.resolve({ usedBytes: 1, totalBytes: 2 }); oldCounts.resolve({ ...COUNTS, totalBytes: 999 }); }
      else { old.reject(new Error('obsolete')); oldCounts.reject(new Error('obsolete')); }
      first.change();
    });
    expect(result.current.quota?.usedBytes).toBe(99);
    expect(result.current.model.stats?.totalBytes).toBe(150);
    expect(first.readers.readQuota).toHaveBeenCalledTimes(1);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    await unmount();
  });
  it.each(['resolve', 'reject'] as const)('ready → locked → ready clears figures/control/quota, preserves safe identity and rejects late reads (%s)', async (outcome) => {
    const late = deferred<typeof COUNTS>();
    const lateQuota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const { readers, change } = setup({ readMirrorCounts: jest.fn().mockResolvedValueOnce(COUNTS).mockReturnValueOnce(late.promise).mockResolvedValue(COUNTS),
      readQuota: jest.fn().mockResolvedValueOnce({ usedBytes: 10, totalBytes: null }).mockReturnValueOnce(lateQuota.promise)
        .mockResolvedValue({ usedBytes: 99, totalBytes: 100 }) });
    const status = ready();
    const { result, rerender, unmount } = await renderHook(
      ({ status }: { status: ByosStatus }) => useCloudLibraryData({ byosStatus: status, readers, enabled: true }), { initialProps: { status } },
    );
    await act(async () => change());
    await rerender({ status: { status: 'locked', reason: 'password_required' } });
    expect(result.current.model.stats).toBeNull();
    expect(result.current.model.storageMode).toBeNull();
    expect(result.current.quota).toBeNull();
    expect(result.current.model.identity?.identity).toBe('owner@example.com');
    expect(JSON.stringify(result.current)).not.toContain('SECRET');
    await rerender({ status });
    await act(async () => {
      if (outcome === 'resolve') { late.resolve({ ...COUNTS, totalBytes: 999 }); lateQuota.resolve({ usedBytes: 999, totalBytes: 1000 }); }
      else { late.reject(new Error('obsolete')); lateQuota.reject(new Error('obsolete')); }
    });
    expect(result.current.model.stats?.totalBytes).toBe(150);
    expect(result.current.quota?.usedBytes).toBe(99);
    expect(readers.readStorageMode).toHaveBeenCalledTimes(2);
    await unmount();
  });
  it('disable/unmount invalidates requests and subscriptions; returning reads once', async () => {
    const quota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const { readers, change, unsubscribe } = setup({ readQuota: jest.fn().mockResolvedValueOnce({ usedBytes: 10, totalBytes: 20 }).mockReturnValueOnce(quota.promise).mockResolvedValue(null) });
    const status = ready();
    const { result, rerender, unmount } = await renderHook(
      ({ enabled }: { enabled: boolean }) => useCloudLibraryData({ byosStatus: status, readers, enabled }), { initialProps: { enabled: true } },
    );
    await act(async () => change());
    await rerender({ enabled: false });
    expect(result.current.quota).toBeNull();
    expect(result.current.model.stats).toBeNull();
    await act(async () => { quota.resolve({ usedBytes: 999, totalBytes: 1000 }); change(); });
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(2);
    await rerender({ enabled: true });
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(3);
    expect(readers.readQuota).toHaveBeenCalledTimes(3);
    await unmount();
    await act(async () => change());
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(3);
  });
  it.each(['resolve', 'reject'] as const)('unmount during dirty flight discards late %s and starts no follow-up', async (outcome) => {
    const quota = deferred<{ usedBytes: number; totalBytes: number | null } | null>();
    const counts = deferred<typeof COUNTS>();
    const { readers, change, unsubscribe } = setup({ readQuota: jest.fn(() => quota.promise), readMirrorCounts: jest.fn(() => counts.promise) });
    const status = ready();
    const { unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    await act(async () => { change(); change(); });
    await unmount();
    await act(async () => {
      if (outcome === 'resolve') { quota.resolve({ usedBytes: 999, totalBytes: 1000 }); counts.resolve(COUNTS); }
      else { quota.reject(new Error('obsolete')); counts.reject(new Error('obsolete')); }
      change();
    });
    expect(readers.readQuota).toHaveBeenCalledTimes(1);
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('explicit mode refresh is shared, stale while pending and hidden after rejection; events do not reread it', async () => {
    const mode = deferred<'both' | 'cloud-only'>();
    const { readers, change } = setup({ readStorageMode: jest.fn().mockResolvedValueOnce('both').mockReturnValueOnce(mode.promise) });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    let refresh!: Promise<void>;
    await act(async () => { refresh = result.current.refreshStorageMode(); });
    expect(result.current.mode.fresh).toBe(false);
    expect(result.current.model.storageMode).toBeNull();
    await act(async () => { mode.reject(new Error('mode')); await refresh; });
    expect(result.current.mode.fresh).toBe(false);
    expect(result.current.model.storageMode).toBeNull();
    await act(async () => change());
    expect(readers.readStorageMode).toHaveBeenCalledTimes(2);
    await unmount();
  });
  it('binding replacement clears old stats before paint and rejects late mode/identity results', async () => {
    const oldMode = deferred<'both' | 'cloud-only'>();
    const { readers } = setup({ readStorageMode: jest.fn().mockReturnValueOnce(oldMode.promise).mockResolvedValue('cloud-only') });
    const first = ready();
    const next = ready();
    if (first.status !== 'ready' || next.status !== 'ready' || first.context.kind !== 'store' || next.context.kind !== 'store') throw new Error('fixture');
    const status: ByosStatus = { status: 'ready', context: { ...next.context, store: first.context.store } };
    const painted: (number | null)[] = [];
    const { result, rerender, unmount } = await renderHook(
      ({ status }: { status: ByosStatus }) => {
        const data = useCloudLibraryData({ byosStatus: status, readers, enabled: true });
        painted.push(data.model.stats?.totalBytes ?? null);
        return data;
      }, { initialProps: { status: first } },
    );
    painted.length = 0;
    await rerender({ status });
    expect(painted[0]).toBeNull();
    await act(async () => oldMode.resolve('both'));
    expect(result.current.model.storageMode).toBe('cloud-only');
    await unmount();
    const identity = deferred<{ kind: 'gdrive'; label: string; identity: string } | null>();
    const lockedReaders = setup({ readStoredIdentity: jest.fn().mockReturnValueOnce(identity.promise).mockResolvedValue(null) }).readers;
    const locked = await renderHook(({ enabled }: { enabled: boolean }) => useCloudLibraryData({
      byosStatus: { status: 'locked', reason: 'password_required' }, readers: lockedReaders, enabled,
    }), { initialProps: { enabled: true } });
    await locked.rerender({ enabled: false });
    await locked.rerender({ enabled: true });
    await act(async () => identity.resolve({ kind: 'gdrive', label: 'Google Drive', identity: 'OLD' }));
    expect(locked.result.current.model.identity).toBeNull();
    await locked.unmount();
  });
  it('an older explicit mode refresh cannot overwrite a newer answer', async () => {
    const old = deferred<'both' | 'cloud-only'>();
    const { readers } = setup({ readStorageMode: jest.fn().mockResolvedValueOnce('both').mockReturnValueOnce(old.promise).mockResolvedValueOnce('cloud-only') });
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    let earlier!: Promise<void>;
    await act(async () => { earlier = result.current.refreshStorageMode(); });
    await act(async () => result.current.refreshStorageMode());
    await act(async () => { old.resolve('both'); await earlier; });
    expect(result.current.model.storageMode).toBe('cloud-only');
    await unmount();
  });
  it('AppState active only updates viewNowMs; locale relabels without credential or quota reads; listener removed', async () => {
    let active!: (state: AppStateStatus) => void;
    const remove = jest.fn();
    const appState = jest.spyOn(AppState, 'addEventListener').mockImplementation((_, cb) => { active = cb; return { remove }; });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const { readers } = setup();
    const status = ready();
    const { result, unmount } = await renderHook(() => useCloudLibraryData({ byosStatus: status, readers, enabled: true }));
    clock.mockReturnValue(9000);
    await act(async () => active('background'));
    expect(result.current.viewNowMs).toBe(1000);
    await act(async () => active('active'));
    expect(result.current.viewNowMs).toBe(9000);
    await act(async () => i18n.changeLanguage('ja'));
    expect(result.current.model.identity?.label).toBe('Google ドライブ');
    expect(readers.readQuota).toHaveBeenCalledTimes(1);
    expect(readers.readMirrorCounts).toHaveBeenCalledTimes(1);
    expect(readers.readStorageMode).toHaveBeenCalledTimes(1);
    expect(readers.readStoredIdentity).not.toHaveBeenCalled();
    await unmount();
    expect(remove).toHaveBeenCalledTimes(1);
    appState.mockRestore(); clock.mockRestore();
  });
});
