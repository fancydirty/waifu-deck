import { createLibraryMirrorDown, LIBRARY_MIRROR_DOWNLOAD_CONCURRENCY } from '@/features/library/library-mirror-down';

const scope = 'scope-1';

function deps(candidates: string[], download: jest.Mock) {
  return {
    getAccountScope: jest.fn(async () => scope),
    listDownloadCandidates: jest.fn(async (s: string) => (s === scope ? candidates : [])),
    download,
  };
}

describe('createLibraryMirrorDown', () => {
  it('downloads every cloud-only candidate and reports counts', async () => {
    const download = jest.fn(async (_digest: string) => ({ status: 'applied' as const }));
    const mirror = createLibraryMirrorDown(deps(['a', 'b', 'c'], download));
    expect(await mirror.mirrorDown()).toEqual({ total: 3, done: 3, failed: 0 });
    expect(download.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'c']);
  });

  it('counts a blocked download as failed and still finishes the rest', async () => {
    const download = jest.fn(async (d: string) =>
      d === 'b' ? { status: 'blocked' as const, category: 'offline' as const } : { status: 'applied' as const });
    const mirror = createLibraryMirrorDown(deps(['a', 'b', 'c'], download));
    expect(await mirror.mirrorDown()).toEqual({ total: 3, done: 2, failed: 1 });
  });

  it('is a no-op with no account scope', async () => {
    const download = jest.fn();
    const mirror = createLibraryMirrorDown({
      getAccountScope: jest.fn(async () => null),
      listDownloadCandidates: jest.fn(),
      download,
    });
    expect(await mirror.mirrorDown()).toEqual({ total: 0, done: 0, failed: 0 });
    expect(download).not.toHaveBeenCalled();
  });

  it('exposes a concurrency ceiling greater than 1 (parallel, per owner no-throttle)', () => {
    expect(LIBRARY_MIRROR_DOWNLOAD_CONCURRENCY).toBeGreaterThan(1);
  });
});
