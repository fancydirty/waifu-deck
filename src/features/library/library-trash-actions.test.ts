import {
  createLibraryTrashActions,
} from '@/features/library/library-trash-actions';
import type { LibraryBatchOrchestrator } from '@/features/library/library-batch-orchestrator';
import type { LibrarySessionPort } from '@/features/library/library-actions-types';

const DIGEST = 'a'.repeat(64);

const session: LibrarySessionPort = {
  async current() {
    return {
      deviceId: 'device',
      masterKey: new Uint8Array(32),
      accountScope: 'scope',
    };
  },
};

function noopBatches(): Pick<LibraryBatchOrchestrator, 'start'> {
  return { start: jest.fn() };
}

function sessionNone(): LibrarySessionPort {
  return { async current() { return null; } };
}

describe('createLibraryTrashActions', () => {
  it('restore queues enqueueRestoreIntent then runs one sync cycle', async () => {
    const restore = jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm1' }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: noopBatches(),
      sync: {
        enqueueRestoreIntent: restore,
        enqueuePermanentDeleteIntent: jest.fn(),
        sync,
      } as never,
    });
    await actions.restore(DIGEST);
    expect(restore).toHaveBeenCalledWith(DIGEST);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('permanentDelete queues then syncs', async () => {
    const enqueue = jest.fn(async () => ({ status: 'queued' as const, mutationId: 'm2' }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: noopBatches(),
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: enqueue,
        sync,
      } as never,
    });
    await actions.permanentDelete(DIGEST);
    expect(enqueue).toHaveBeenCalledWith(DIGEST);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('emptyTrash drives the empty-trash batch to completion then syncs', async () => {
    const start = jest.fn(async () => ({
      batchId: 'b1',
      kind: 'empty-trash' as const,
      state: 'completed' as const,
      total: 3,
      done: 3,
      failed: 0,
      pending: 0,
      pausedCategory: null,
      failures: [],
    }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: { start },
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: jest.fn(),
        sync,
      } as never,
    });
    await expect(actions.emptyTrash()).resolves.toEqual({
      purged: 3, failures: 0, pending: 0,
    });
    expect(start).toHaveBeenCalledWith('empty-trash');
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('emptyTrash honestly reports partial failures from the batch', async () => {
    const start = jest.fn(async () => ({
      batchId: 'b2',
      kind: 'empty-trash' as const,
      state: 'paused' as const,
      total: 2,
      done: 1,
      failed: 1,
      pending: 0,
      pausedCategory: 'auth_attention' as const,
      failures: [{ plaintextSha256: DIGEST, category: 'auth_attention' as const }],
    }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: { start },
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: jest.fn(),
        sync,
      } as never,
    });
    await expect(actions.emptyTrash()).resolves.toEqual({
      purged: 1, failures: 1, pending: 0,
    });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('emptyTrash reports items still pending when the batch halts before completion', async () => {
    const start = jest.fn(async () => ({
      batchId: 'b3',
      kind: 'empty-trash' as const,
      state: 'paused' as const,
      total: 5,
      done: 2,
      failed: 1,
      pending: 2,
      pausedCategory: 'auth_attention' as const,
      failures: [{ plaintextSha256: DIGEST, category: 'auth_attention' as const }],
    }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: { start },
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: jest.fn(),
        sync,
      } as never,
    });
    await expect(actions.emptyTrash()).resolves.toEqual({
      purged: 2, failures: 1, pending: 2,
    });
  });

  it('emptyTrash throws when another batch already owns the account scope, fabricating no counters', async () => {
    const start = jest.fn(async () => ({
      batchId: 'other-batch',
      kind: 'protect-all' as const,
      state: 'paused' as const,
      total: 500,
      done: 500,
      failed: 0,
      pending: 0,
      pausedCategory: null,
      startRefused: 'busy' as const,
      failures: [],
    }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: { start },
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: jest.fn(),
        sync,
      } as never,
    });
    await expect(actions.emptyTrash()).rejects.toThrow(
      'Cannot empty trash: another library batch is already in progress.',
    );
    expect(sync).not.toHaveBeenCalled();
  });

  it('emptyTrash refuses a busy scope even when the blocking batch is itself an empty-trash', async () => {
    // A paused empty-trash batch already owning the scope has the SAME `kind`
    // this call asked for, so a `kind`-based guard would let it through and
    // report the stale batch's counters as if this call had purged them.
    // `startRefused: 'busy'` is the exact signal, and it is set here too.
    const start = jest.fn(async () => ({
      batchId: 'earlier-empty-trash',
      kind: 'empty-trash' as const,
      state: 'paused' as const,
      total: 40,
      done: 31,
      failed: 2,
      pending: 7,
      pausedCategory: 'auth_attention' as const,
      startRefused: 'busy' as const,
      failures: [],
    }));
    const sync = jest.fn(async () => ({ status: 'completed' as const }));
    const actions = createLibraryTrashActions({
      session,
      batches: { start },
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: jest.fn(),
        sync,
      } as never,
    });
    await expect(actions.emptyTrash()).rejects.toThrow(
      'Cannot empty trash: another library batch is already in progress.',
    );
    expect(sync).not.toHaveBeenCalled();
  });

  it('emptyTrash is not-applicable without a session and never touches batches', async () => {
    const batches = noopBatches();
    const actions = createLibraryTrashActions({
      session: sessionNone(),
      batches,
      sync: {
        enqueueRestoreIntent: jest.fn(),
        enqueuePermanentDeleteIntent: jest.fn(),
        sync: jest.fn(),
      } as never,
    });
    await expect(actions.emptyTrash()).resolves.toEqual({
      status: 'not-applicable',
      reason: 'no_account',
    });
    expect(batches.start).not.toHaveBeenCalled();
  });
});
