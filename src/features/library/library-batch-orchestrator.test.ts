jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import type {
  LibraryActionResult,
  LibraryBatchKind,
} from '@/features/library/library-actions-types';
import {
  createLibraryBatchOrchestrator,
  type LibraryBatchOrchestrator,
  type LibraryBatchRunner,
} from '@/features/library/library-batch-orchestrator';
import { sha256PlaintextHex } from '@/features/library/library-identity';
import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const digests: string[] = [];
let harness: ActionsHarness;
let orchestrator: LibraryBatchOrchestrator;
let calls: string[];
let outcomes: Map<string, LibraryActionResult>;
let onItem: ((digest: string) => Promise<void>) | null;
/** Shared across rebuilds so account-switch tests do not collide on batch_id. */
let batchIdSequence = 0;

function runner(): LibraryBatchRunner {
  const perform = async (digest: string): Promise<LibraryActionResult> => {
    calls.push(digest);
    if (onItem !== null) await onItem(digest);
    return outcomes.get(digest) ?? { status: 'applied' };
  };
  return {
    protect: perform,
    download: perform,
    freeDeviceSpace: perform,
    permanentDelete: perform,
  };
}

function build(current: ActionsHarness): LibraryBatchOrchestrator {
  return createLibraryBatchOrchestrator({
    protection: current.protection,
    session: { async current() { return current.session.value; } },
    runner: runner(),
    database: current.database,
    clock: current.clock,
    newBatchId: () => {
      batchIdSequence += 1;
      return `00000000-0000-4000-9000-${batchIdSequence.toString().padStart(12, '0')}`;
    },
  });
}

beforeEach(async () => {
  resetExpoCryptoDouble();
  harness = await createActionsHarness();
  calls = [];
  outcomes = new Map();
  onItem = null;
  batchIdSequence = 0;
  digests.length = 0;
  for (let index = 0; index < 4; index += 1) {
    const bytes = Uint8Array.from([index + 1, index + 2, index + 3]);
    const digest = sha256PlaintextHex(bytes);
    digests.push(digest);
    await harness.seedLocalAsset({ plaintextSha256: digest, bytes });
  }
  orchestrator = build(harness);
});

afterEach(() => {
  harness.close();
});

describe('library batch orchestrator', () => {
  it('protects every eligible local asset and reports totals', async () => {
    const progress = await orchestrator.start('protect-all');
    expect(progress).toMatchObject({
      kind: 'protect-all', state: 'completed', total: 4, done: 4, failed: 0,
    });
    expect(calls.sort()).toEqual([...digests].sort());
  });

  it('commits each item independently and keeps going after a failure', async () => {
    outcomes.set(digests[1]!, { status: 'blocked', category: 'integrity' });
    const progress = await orchestrator.start('protect-all');
    expect(progress).toMatchObject({ state: 'completed', done: 3, failed: 1 });
    expect(progress.failures).toEqual([
      { plaintextSha256: digests[1]!, category: 'integrity' },
    ]);
    expect(calls.length).toBe(4);
  });

  it('pauses mid-run and resumes without redoing completed items', async () => {
    let batchId = '';
    onItem = async (digest) => {
      if (digest === digests[1]) await orchestrator.pause(batchId);
    };
    const started = await orchestrator.startPaused('protect-all');
    batchId = started.batchId;
    const paused = await orchestrator.resume(batchId);
    expect(paused.state).toBe('paused');
    expect(paused.done).toBe(2);
    expect(paused.pending).toBe(2);

    onItem = null;
    const finished = await orchestrator.resume(batchId);
    expect(finished).toMatchObject({ state: 'completed', done: 4, failed: 0 });
    expect(calls.length).toBe(4);
  });

  it('auto-pauses on authentication attention', async () => {
    outcomes.set(digests[0]!, { status: 'blocked', category: 'auth_attention' });
    const progress = await orchestrator.start('protect-all');
    expect(progress).toMatchObject({
      state: 'paused', pausedCategory: 'auth_attention',
    });
    expect(calls.length).toBe(1);
  });

  it('auto-pauses on quota_full', async () => {
    outcomes.set(digests[0]!, { status: 'blocked', category: 'quota_full' });
    const progress = await orchestrator.start('protect-all');
    expect(progress).toMatchObject({
      state: 'paused', pausedCategory: 'quota_full',
    });
    expect(calls.length).toBe(1);
  });

  it('recovers an interrupted batch after process restart', async () => {
    const started = await orchestrator.startPaused('protect-all');
    await harness.database.run(
      `UPDATE library_batch_items SET state = 'running'
        WHERE batch_id = ? AND plaintext_sha256 = ?`,
      [started.batchId, digests[0]!],
    );
    const recovered = await build(harness).recover();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      batchId: started.batchId, state: 'paused', pending: 4,
    });
    const rows = await harness.database.getAll<{ state: string }>(
      'SELECT state FROM library_batch_items WHERE batch_id = ?',
      [started.batchId],
    );
    expect(rows.every((row) => row.state === 'pending')).toBe(true);
  });

  it('refuses to start a second batch while one is unfinished', async () => {
    const first = await orchestrator.startPaused('protect-all');
    expect(first.state).toBe('paused');
    const refused = await orchestrator.start('download-all');
    expect(refused).toMatchObject({
      batchId: first.batchId,
      kind: 'protect-all',
      state: 'paused',
      startRefused: 'busy',
    });
    expect(
      await harness.database.getAll('SELECT batch_id FROM library_batch_operations'),
    ).toHaveLength(1);
    const finished = await orchestrator.resume(first.batchId);
    expect(finished.state).toBe('completed');
    expect(await orchestrator.start('download-all')).toMatchObject({
      kind: 'download-all',
      state: 'completed',
      total: 0,
    });
  });

  it('admits only one of two concurrent starts for the same account scope', async () => {
    // Overlapping startPaused calls with the same candidate-bearing kind so
    // both reach atomic admission (download-all can be empty and skip it).
    const [first, second] = await Promise.all([
      orchestrator.startPaused('protect-all'),
      orchestrator.startPaused('protect-all'),
    ]);
    const outcomes = [first, second];
    const created = outcomes.filter((row) => row.startRefused !== 'busy');
    const refused = outcomes.filter((row) => row.startRefused === 'busy');
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      batchId: created[0]!.batchId,
      startRefused: 'busy',
    });
    expect(
      await harness.database.getAll('SELECT batch_id FROM library_batch_operations'),
    ).toHaveLength(1);
  });

  it('hides and does not block on another account\'s unfinished batch', async () => {
    const forA = await orchestrator.startPaused('protect-all');
    expect(forA.state).toBe('paused');
    const sessionA = harness.session.value!;

    harness.session.value = {
      deviceId: 'device-B',
      masterKey: Uint8Array.from({ length: 32 }, (_, index) => index + 50),
      accountScope: 'scope-B',
    };
    const forB = build(harness);
    expect(await forB.recover()).toEqual([]);
    // B is not blocked by A's open row and can enqueue its own batch.
    const startedB = await forB.startPaused('protect-all');
    expect(startedB.startRefused).toBeUndefined();
    expect(startedB.batchId.length).toBeGreaterThan(0);
    expect(startedB.batchId).not.toBe(forA.batchId);
    await expect(forB.resume(forA.batchId)).rejects.toThrow(
      `Unknown library batch ${forA.batchId}.`,
    );
    await expect(forB.retryFailed(forA.batchId)).rejects.toThrow(
      `Unknown library batch ${forA.batchId}.`,
    );
    await expect(forB.pause(forA.batchId)).rejects.toThrow(
      `Unknown library batch ${forA.batchId}.`,
    );
    // Public progress reads are scoped too — no foreign metadata via
    // `progress` / facade `batchProgress` (null, same surface as missing).
    expect(await forB.progress(forA.batchId)).toBeNull();

    // A's unfinished row is still there and recovers when A returns.
    harness.session.value = sessionA;
    const recoveredA = await build(harness).recover();
    expect(recoveredA.map((row) => row.batchId)).toContain(forA.batchId);
    expect(
      await harness.database.getAll<{ account_scope: string; state: string }>(
        `SELECT account_scope, state FROM library_batch_operations
          WHERE batch_id = ?`,
        [forA.batchId],
      ),
    ).toEqual([{ account_scope: TEST_ACCOUNT_SCOPE, state: 'paused' }]);
  });

  it('returns null progress for a foreign-scope batch id without a session switch rebuild', async () => {
    const forA = await orchestrator.startPaused('protect-all');
    harness.session.value = {
      deviceId: 'device-B',
      masterKey: Uint8Array.from({ length: 32 }, (_, index) => index + 50),
      accountScope: 'scope-B',
    };
    // Same harness DB; only the session port identity changed.
    expect(await build(harness).progress(forA.batchId)).toBeNull();
    harness.session.value = null;
    expect(await build(harness).progress(forA.batchId)).toBeNull();
  });

  it('pauses mid-drain on A→B without performing the next item under B', async () => {
    // Live switch *during* drain (after item 1 / before item 2), not an idle
    // startPaused row. Remaining work must stay unfinished for A and must not
    // run through B's session/keys.
    const sessionA = harness.session.value!;
    onItem = async (digest) => {
      if (digest === digests[0]) {
        harness.session.value = {
          deviceId: 'device-B',
          masterKey: Uint8Array.from({ length: 32 }, (_, index) => index + 50),
          accountScope: 'scope-B',
        };
      }
    };
    const started = await orchestrator.startPaused('protect-all');
    const paused = await orchestrator.resume(started.batchId);
    expect(paused).toMatchObject({
      batchId: started.batchId,
      state: 'paused',
      done: 1,
      pending: 3,
      failed: 0,
    });
    // Only the in-flight item-1 perform ran; item 2+ never called the runner.
    expect(calls).toEqual([digests[0]!]);

    harness.session.value = sessionA;
    const recoveredA = await build(harness).recover();
    expect(recoveredA.map((row) => row.batchId)).toContain(started.batchId);
    expect(
      recoveredA.find((row) => row.batchId === started.batchId),
    ).toMatchObject({
      state: 'paused',
      done: 1,
      pending: 3,
    });
    expect(
      await harness.database.getAll<{ account_scope: string; state: string }>(
        `SELECT account_scope, state FROM library_batch_operations
          WHERE batch_id = ?`,
        [started.batchId],
      ),
    ).toEqual([{ account_scope: TEST_ACCOUNT_SCOPE, state: 'paused' }]);
  });

  it('recovers multiple unfinished batches after restart and keeps later ones reachable', async () => {
    // Pre-existing plurality: seed two paused incomplete batches by SQL.
    // The single-open start rule prevents creating this through start/startPaused.
    const at = harness.clock();
    const batchIds = [
      '00000000-0000-4000-9000-000000000101',
      '00000000-0000-4000-9000-000000000102',
    ] as const;
    for (const [index, batchId] of batchIds.entries()) {
      await harness.database.run(
        `INSERT INTO library_batch_operations (
           batch_id, account_scope, kind, state, created_at, updated_at
         ) VALUES (?, ?, ?, 'paused', ?, ?)`,
        [
          batchId,
          TEST_ACCOUNT_SCOPE,
          index === 0 ? 'protect-all' : 'download-all',
          at + index,
          at + index,
        ],
      );
      await harness.database.run(
        `INSERT INTO library_batch_items (
           batch_id, plaintext_sha256, position, state, failure_category,
           updated_at
         ) VALUES (?, ?, 0, 'pending', NULL, ?)`,
        [batchId, digests[index]!, at + index],
      );
    }
    const recovered = await build(harness).recover();
    expect(recovered.map((row) => row.batchId)).toEqual([...batchIds]);
    expect(recovered.every((row) => row.state === 'paused')).toBe(true);

    const firstDone = await orchestrator.resume(batchIds[0]);
    expect(firstDone.state).toBe('completed');
    const stillOpen = await orchestrator.progress(batchIds[1]);
    expect(stillOpen).toMatchObject({
      batchId: batchIds[1],
      state: 'paused',
      pending: 1,
    });
    const secondDone = await orchestrator.resume(batchIds[1]);
    expect(secondDone.state).toBe('completed');
  });

  it('queues download-all from its own candidate set', async () => {
    expect(await orchestrator.start('download-all')).toMatchObject({
      kind: 'download-all', total: 0, state: 'completed',
    });
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digests[0]!),
      plaintextSha256: digests[0]!,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 2,
      originalGenerationId: '11111111-1111-4111-8111-111111111111',
      originalCiphertextBytes: 99,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 5,
      failureCategory: null,
      trashedAt: null,
    });
    // C4b: the `free-all` half of this test is gone with the kind itself. The
    // eviction it used to perform is done directly here, so the surviving
    // assertion — a cloud-only asset becomes a download candidate — is
    // unchanged rather than weakened.
    await harness.protection.setResidency(digests[0]!, 'cloud-only', null);
    expect(await orchestrator.start('download-all')).toMatchObject({
      kind: 'download-all', total: 1, done: 1,
    });
  });

  it('queues empty-trash from trashed candidates and skips active assets', async () => {
    expect(await orchestrator.start('empty-trash')).toMatchObject({
      kind: 'empty-trash', total: 0, state: 'completed',
    });
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digests[0]!),
      plaintextSha256: digests[0]!,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 2,
      originalGenerationId: '11111111-1111-4111-8111-111111111111',
      originalCiphertextBytes: 99,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 5,
      failureCategory: null,
      trashedAt: null,
    });
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digests[1]!),
      plaintextSha256: digests[1]!,
      lifecycle: 'trash',
      protection: 'unprotected',
      generation: 1,
      revision: 3,
      originalGenerationId: null,
      originalCiphertextBytes: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: 500,
    });
    const progress = await orchestrator.start('empty-trash');
    expect(progress).toMatchObject({
      kind: 'empty-trash', state: 'completed', total: 1, done: 1, failed: 0,
    });
    expect(calls).toEqual([digests[1]!]);
  });

  it('offers no batch and no rows without an account', async () => {
    harness.session.value = null;
    const kinds: LibraryBatchKind[] = [
      'protect-all', 'download-all', 'empty-trash',
    ];
    for (const kind of kinds) {
      expect(await orchestrator.start(kind)).toMatchObject({
        state: 'completed', total: 0,
      });
    }
    expect(
      await harness.database.getAll('SELECT batch_id FROM library_batch_operations'),
    ).toEqual([]);
  });

  it('retries only the failed items of a finished batch', async () => {
    outcomes.set(digests[2]!, { status: 'blocked', category: 'retryable_transfer' });
    const first = await orchestrator.start('protect-all');
    expect(first.failed).toBe(1);
    outcomes.clear();
    calls.length = 0;
    const retried = await orchestrator.retryFailed(first.batchId);
    expect(retried).toMatchObject({ state: 'completed', failed: 0, done: 4 });
    expect(calls).toEqual([digests[2]!]);
  });

  /**
   * Single runtime source of the surviving kinds. `tsc` forces this to grow
   * whenever `LibraryBatchKind` grows, and the eviction test below starts
   * everything in it — so a re-added kind is caught by type-check and, once
   * type-check is satisfied, by jest.
   */
  const ALL_BATCH_KINDS: Record<LibraryBatchKind, true> = {
    'protect-all': true,
    'download-all': true,
    'empty-trash': true,
  };

  it('supports exactly the three surviving batch kinds', () => {
    // C4b discriminating guard. `candidatesFor`/`performFor` in the
    // orchestrator end in an unconditional fallthrough to
    // `listFreeCandidates`/`freeDeviceSpace`, so re-adding any member to
    // `LibraryBatchKind` silently routes it down the eviction path a complete
    // mirror must never take — and no behavioral test catches that, because the
    // new kind is simply never started. Enumerating the union here is what
    // fails. Deleting the fallthrough belongs to whoever removes
    // `listFreeCandidates`; pinning the union is what C4b can honestly do.
    expect(Object.keys(ALL_BATCH_KINDS).sort())
      .toEqual(['download-all', 'empty-trash', 'protect-all']);
  });

  it('never routes a surviving batch kind to device eviction', async () => {
    // C4b runtime companion to the union pin above, which fails only under
    // `tsc`. A jest-only gate would not see it, so this asserts the same danger
    // behaviorally: no kind a user can start may reach `freeDeviceSpace`. Each
    // surviving kind is given a real candidate first, so the assertion cannot
    // pass by performing nothing.
    const ran: string[] = [];
    const record = (name: string) => async (): Promise<LibraryActionResult> => {
      ran.push(name);
      return { status: 'applied' };
    };
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digests[0]!),
      plaintextSha256: digests[0]!,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 2,
      originalGenerationId: '11111111-1111-4111-8111-111111111111',
      originalCiphertextBytes: 99,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 5,
      failureCategory: null,
      trashedAt: null,
    });
    await harness.protection.setResidency(digests[0]!, 'cloud-only', null);
    // digests[2] stays a verified local original so `listFreeCandidates` has a
    // real row. Without it a resurrected 'free-all' finds nothing and the
    // assertion below would pass vacuously.
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digests[2]!),
      plaintextSha256: digests[2]!,
      lifecycle: 'active',
      protection: 'protected',
      generation: 1,
      revision: 2,
      originalGenerationId: '33333333-3333-4333-8333-333333333333',
      originalCiphertextBytes: 99,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: 5,
      failureCategory: null,
      trashedAt: null,
    });
    expect(await harness.protection.listFreeCandidates(TEST_ACCOUNT_SCOPE))
      .toContain(digests[2]!);
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId: harness.assetIdFor(digests[1]!),
      plaintextSha256: digests[1]!,
      lifecycle: 'trash',
      protection: 'unprotected',
      generation: 1,
      revision: 3,
      originalGenerationId: null,
      originalCiphertextBytes: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: null,
      trashedAt: 500,
    });
    const guarded = createLibraryBatchOrchestrator({
      protection: harness.protection,
      session: { async current() { return harness.session.value; } },
      runner: {
        protect: record('protect'),
        download: record('download'),
        permanentDelete: record('permanentDelete'),
        freeDeviceSpace: record('freeDeviceSpace'),
      },
      database: harness.database,
      clock: harness.clock,
      newBatchId: () => {
        batchIdSequence += 1;
        return `00000000-0000-4000-9000-${batchIdSequence.toString().padStart(12, '0')}`;
      },
    });
    for (const kind of Object.keys(ALL_BATCH_KINDS) as LibraryBatchKind[]) {
      await guarded.start(kind);
    }
    expect(ran).not.toContain('freeDeviceSpace');
    expect([...new Set(ran)].sort())
      .toEqual(['download', 'permanentDelete', 'protect']);
  });
});
