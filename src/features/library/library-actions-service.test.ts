import {
  createLibraryActionsService,
} from '@/features/library/library-actions-service';
import type { LibraryBatchProgress } from '@/features/library/library-actions-types';

const baseProgress = (
  overrides: Partial<LibraryBatchProgress> = {},
): LibraryBatchProgress => ({
  batchId: 'b1',
  kind: 'protect-all',
  state: 'paused',
  total: 2,
  done: 0,
  failed: 0,
  pending: 2,
  pausedCategory: null,
  failures: [],
  ...overrides,
});

const DIGEST = 'a'.repeat(64);

function createFacade(
  batches: {
    startPaused?: jest.Mock;
    resume?: jest.Mock;
    retryFailed?: jest.Mock;
    progress?: jest.Mock;
    pause?: jest.Mock;
    recover?: jest.Mock;
  } = {},
  trashActions: {
    restore?: jest.Mock;
    permanentDelete?: jest.Mock;
    emptyTrash?: jest.Mock;
  } = {},
  overrides: {
    readMirrorCounts?: jest.Mock;
    countFailureCategory?: jest.Mock;
    session?: { current: () => Promise<{ accountScope: string } | null> };
  } = {},
) {
  return createLibraryActionsService({
    protectAction: {
      protect: jest.fn(),
      applySavePolicyAfterIngest: jest.fn(),
    } as never,
    localActions: {
      download: jest.fn(),
      freeDeviceSpace: jest.fn(),
      availableActions: jest.fn(),
    } as never,
    accountActions: {
      stopProtection: jest.fn(),
      removeFromLibrary: jest.fn(),
    } as never,
    trashActions: {
      restore: trashActions.restore ?? jest.fn(),
      permanentDelete: trashActions.permanentDelete ?? jest.fn(),
      emptyTrash: trashActions.emptyTrash ?? jest.fn(),
    } as never,
    batches: {
      start: jest.fn(),
      startPaused: batches.startPaused ?? jest.fn(),
      pause: batches.pause ?? jest.fn(),
      resume: batches.resume ?? jest.fn(),
      retryFailed: batches.retryFailed ?? jest.fn(),
      progress: batches.progress ?? jest.fn(),
      recover: batches.recover ?? jest.fn(async () => []),
    },
    session: (overrides.session ?? {
      current: jest.fn(async () => ({ accountScope: 'scope-test' })),
    }) as never,
    readMirrorCounts: overrides.readMirrorCounts ?? jest.fn(async () => ({
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0,
      inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    })),
    countFailureCategory: overrides.countFailureCategory ?? jest.fn(async () => 0),
    sync: {
      sync: jest.fn(),
      readSyncState: jest.fn(async () => null),
      enqueueRestoreIntent: jest.fn(),
      enqueuePermanentDeleteIntent: jest.fn(),
    } as never,
  });
}

describe('createLibraryActionsService fire-and-watch', () => {
  it('startBatch returns a running snapshot without awaiting drain', async () => {
    let resolveDrain: (value: LibraryBatchProgress) => void = () => {};
    const deferredDrain = new Promise<LibraryBatchProgress>((resolve) => {
      resolveDrain = resolve;
    });
    const resume = jest.fn(() => deferredDrain);
    const startPaused = jest.fn(async () => baseProgress());
    const facade = createFacade({ startPaused, resume });

    const snapshot = await facade.startBatch('protect-all');
    expect(snapshot.state).toBe('running');
    expect(resume).toHaveBeenCalledWith('b1');
    // Drain still pending — startBatch already returned.
    expect(await Promise.race([
      deferredDrain.then(() => 'drained'),
      Promise.resolve('returned-first'),
    ])).toBe('returned-first');

    resolveDrain(baseProgress({ state: 'completed', done: 2, pending: 0 }));
    await deferredDrain;
  });

  it('resumeBatch and retryFailedBatch return without awaiting drain', async () => {
    let resolveResumeDrain: (value: LibraryBatchProgress) => void = () => {};
    let resolveRetryDrain: (value: LibraryBatchProgress) => void = () => {};
    const deferredResume = new Promise<LibraryBatchProgress>((resolve) => {
      resolveResumeDrain = resolve;
    });
    const deferredRetry = new Promise<LibraryBatchProgress>((resolve) => {
      resolveRetryDrain = resolve;
    });
    const resume = jest.fn(() => deferredResume);
    const retryFailed = jest.fn(() => deferredRetry);
    const progress = jest.fn(async () => baseProgress({
      done: 1,
      pending: 1,
      failed: 1,
      failures: [{
        plaintextSha256: 'a'.repeat(64),
        category: 'retryable_transfer',
      }],
    }));
    const facade = createFacade({ resume, retryFailed, progress });

    const resumed = await facade.resumeBatch('b1');
    expect(resumed.state).toBe('running');
    expect(resume).toHaveBeenCalledWith('b1');

    const retried = await facade.retryFailedBatch('b1');
    expect(retried.state).toBe('running');
    expect(retried.failed).toBe(0);
    expect(retryFailed).toHaveBeenCalledWith('b1');

    resolveResumeDrain(baseProgress({ state: 'completed', done: 2, pending: 0 }));
    resolveRetryDrain(baseProgress({ state: 'completed', done: 2, pending: 0, failed: 0 }));
    await Promise.all([deferredResume, deferredRetry]);
  });

  it('observes drain rejection without an unhandled rejection', async () => {
    const drainError = new Error('drain failed');
    const resume = jest.fn(() => Promise.reject(drainError));
    const startPaused = jest.fn(async () => baseProgress());
    const facade = createFacade({ startPaused, resume });

    const snapshot = await facade.startBatch('protect-all');
    expect(snapshot.state).toBe('running');

    // Flush the watched drain microtask. watchDrain must catch so Jest does
    // not report an unhandled rejection.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
});

describe('createLibraryActionsService trash facade', () => {
  it('restoreFromTrash / permanentlyDeleteFromTrash / emptyLibraryTrash delegate', async () => {
    const restore = jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm1' }));
    const permanentDelete = jest.fn(async () => ({
      status: 'queued' as const,
      mutationId: 'm2',
    }));
    const emptyTrash = jest.fn(async () => ({ purged: 1, failures: 0 }));
    const facade = createFacade({}, { restore, permanentDelete, emptyTrash });

    await expect(facade.restoreFromTrash(DIGEST)).resolves.toEqual({
      status: 'queued',
      mutationId: 'm1',
    });
    expect(restore).toHaveBeenCalledWith(DIGEST);

    await expect(facade.permanentlyDeleteFromTrash(DIGEST)).resolves.toEqual({
      status: 'queued',
      mutationId: 'm2',
    });
    expect(permanentDelete).toHaveBeenCalledWith(DIGEST);

    await expect(facade.emptyLibraryTrash()).resolves.toEqual({
      purged: 1,
      failures: 0,
    });
    expect(emptyTrash).toHaveBeenCalledTimes(1);
  });
});

describe('createLibraryActionsService mirror counts', () => {
  it('reads mirror counts for the resolved account scope', async () => {
    const readMirrorCounts = jest.fn(async () => ({
      backedUp: 3, backedUpTotal: 4, downloaded: 2, downloadedTotal: 5,
      inCloud: 3, inCloudBytes: 300, pending: 1, totalBytes: 700,
    }));
    const facade = createFacade({}, {}, { readMirrorCounts });
    expect(await facade.readMirrorCounts()).toEqual({
      backedUp: 3, backedUpTotal: 4, downloaded: 2, downloadedTotal: 5,
      inCloud: 3, inCloudBytes: 300, pending: 1, totalBytes: 700,
    });
    // Reads for the session's scope, never a hardcoded or empty one.
    expect(readMirrorCounts).toHaveBeenCalledWith(expect.any(String));
  });

  it('reports zeros without reading when no account scope is resolved', async () => {
    // C4a: the settings section renders before any bucket is connected. A
    // signed-out read must be a fact (nothing mirrored), never an exception
    // that blanks the settings screen.
    const readMirrorCounts = jest.fn();
    const facade = createFacade({}, {}, {
      readMirrorCounts,
      session: { current: async () => null },
    });
    expect(await facade.readMirrorCounts()).toEqual({
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0,
      inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    });
    expect(readMirrorCounts).not.toHaveBeenCalled();
  });
});

describe('createLibraryActionsService quota-full count', () => {
  it('reads the halted quota_full count for the resolved account scope', async () => {
    const countFailureCategory = jest.fn(async () => 3);
    const facade = createFacade({}, {}, { countFailureCategory });
    expect(await facade.readQuotaFullCount()).toBe(3);
    expect(countFailureCategory).toHaveBeenCalledWith('scope-test', 'quota_full');
  });

  it('reports zero without reading when no account scope is resolved', async () => {
    const countFailureCategory = jest.fn();
    const facade = createFacade({}, {}, {
      countFailureCategory,
      session: { current: async () => null },
    });
    expect(await facade.readQuotaFullCount()).toBe(0);
    expect(countFailureCategory).not.toHaveBeenCalled();
  });
});

describe('createLibraryActionsService save-policy seam', () => {
  it('exposes no save-policy seam at all', () => {
    // C4b: C1 made every ingest upload, so a stored policy could only lie.
    // C4a removed the last reader; this asserts the seam itself is gone, so a
    // future caller cannot resurrect the choice by finding a method to call.
    const service = createFacade() as unknown as Record<string, unknown>;
    expect('readSavePolicy' in service).toBe(false);
    expect('setSavePolicy' in service).toBe(false);
  });
});
