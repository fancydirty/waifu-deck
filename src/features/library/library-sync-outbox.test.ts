import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  TEST_DEVICE_ID,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import {
  actionIntentOf,
  collectMetadataOf,
  createLibrarySyncOutbox,
  isHaltingErrorCode,
  LIBRARY_SYNC_HALTING_ERROR_CODES,
  type LibrarySyncOutbox,
} from '@/features/library/library-sync-outbox';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const BYTES = Uint8Array.from([1, 2, 3, 4]);

let harness: ActionsHarness;
let outbox: LibrarySyncOutbox;
let now: number;

beforeEach(async () => {
  harness = await createActionsHarness();
  now = 1_000_000;
  let sequence = 100;
  outbox = createLibrarySyncOutbox({
    database: harness.database,
    newMutationId: () => {
      sequence += 1;
      return `00000000-0000-4000-9000-${sequence.toString().padStart(12, '0')}`;
    },
    clock: () => now,
  });
});

afterEach(() => {
  harness.close();
});

describe('library sync outbox', () => {
  it('reads every kind the table admits, including the SP6 collect', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const assetId = harness.assetIdFor(DIGEST_A);
    await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'trash',
      baseRevision: 4,
      observedGeneration: 1,
      payload: {
        assetId,
        plaintextSha256: DIGEST_A,
        kind: 'trash',
        reservationId: null,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        queuedAt: now,
      },
    });

    const rows = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(rows.map((row) => row.kind)).toEqual(['collect', 'trash']);
    expect(collectMetadataOf(rows[0]!).plaintextSha256).toBe(DIGEST_A);
    expect(actionIntentOf(rows[1]!).kind).toBe('trash');
  });

  it('queues a restore intent and reuses its stable mutation id', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const assetId = harness.assetIdFor(DIGEST_A);
    const payload = {
      assetId,
      plaintextSha256: DIGEST_A,
      kind: 'restore' as const,
      reservationId: null,
      originalGenerationId: null,
      originalCiphertextBytes: null,
      queuedAt: now,
    };
    const first = await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'restore',
      baseRevision: 9,
      observedGeneration: 2,
      payload,
    });
    const second = await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: TEST_DEVICE_ID,
      assetId,
      kind: 'restore',
      baseRevision: 9,
      observedGeneration: 2,
      payload,
    });
    expect(first.status).toBe('queued');
    expect(second).toEqual({
      status: 'already-queued',
      mutationId: first.mutationId,
    });
  });

  it('halts on the design categories and leaves every other failure due at once', async () => {
    // K7 ⑬: the halting set is the only thing that may hold a row back. A row
    // that failed for any other reason (offline, a 5xx, an unknown outcome) is
    // due the moment the next real event runs a round — the 30 s → 1 h
    // exponential backoff this module used to impose was multi-tenant
    // politeness aimed at the user's OWN single-tenant bucket.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_B, bytes: BYTES });
    const [collectA, collectB] = await outbox.listAll(TEST_ACCOUNT_SCOPE);

    await outbox.markFailed(collectA!.mutationId, 'auth_attention');
    await outbox.markFailed(collectB!.mutationId, 'offline');

    expect(isHaltingErrorCode('auth_attention')).toBe(true);
    expect(isHaltingErrorCode('unsupported_image')).toBe(true);
    expect(isHaltingErrorCode('integrity')).toBe(true);
    expect(isHaltingErrorCode('offline')).toBe(false);
    expect(isHaltingErrorCode('retryable_transfer')).toBe(false);
    expect(isHaltingErrorCode('stale_client')).toBe(false);

    const due = await outbox.listDue(TEST_ACCOUNT_SCOPE);
    expect(due.map((row) => row.mutationId)).toEqual([collectB!.mutationId]);
    // Nothing was stored that a later round would have to wait out.
    const stored = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(stored.map((row) => row.nextAttemptAt)).toEqual([null, null]);
  });

  it('never hides a row behind a stored wait, including one an older build left', async () => {
    // The upgrade case K7 ⑬ is really about: a phone that installs this build
    // carries rows the old code pushed up to an hour into the future. Reading
    // that column would make the user wait out a backoff that has already been
    // deleted, so nothing reads it.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await harness.database.run(
      'UPDATE library_outbox SET next_attempt_at = ? WHERE mutation_id = ?',
      [now + 3_600_000, row!.mutationId],
    );

    const due = await outbox.listDue(TEST_ACCOUNT_SCOPE);
    expect(due.map((entry) => entry.mutationId)).toEqual([row!.mutationId]);
  });

  it('clears any stored wait when it records a failure', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await harness.database.run(
      'UPDATE library_outbox SET next_attempt_at = ? WHERE mutation_id = ?',
      [now + 3_600_000, row!.mutationId],
    );

    await outbox.markFailed(row!.mutationId, 'offline');
    expect((await outbox.listAll(TEST_ACCOUNT_SCOPE))[0]?.nextAttemptAt).toBeNull();

    await outbox.markDispatched([row!.mutationId]);
    await outbox.markUnknownOutcome(row!.mutationId, 'offline');
    expect((await outbox.listAll(TEST_ACCOUNT_SCOPE))[0]?.nextAttemptAt).toBeNull();
  });

  it('always makes a dispatched-unknown row due, whatever category it carries', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await outbox.markDispatched([row!.mutationId]);
    await outbox.markUnknownOutcome(row!.mutationId, 'auth_attention');

    const stored = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(stored[0]?.state).toBe('sending');
    expect(stored[0]?.attemptCount).toBe(1);
    // A halting category cannot strand a row whose outcome is unknown, and
    // (K7 ⑬) nothing else delays it either: only a replay can resolve it.
    const due = await outbox.listDue(TEST_ACCOUNT_SCOPE);
    expect(due.map((entry) => entry.mutationId)).toEqual([row!.mutationId]);
    const unknown = await outbox.listUnknownOutcome(TEST_ACCOUNT_SCOPE);
    expect(unknown.map((entry) => entry.mutationId)).toEqual([row!.mutationId]);
  });

  it('lets a known refusal clear the sending state so eviction unblocks', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await outbox.markDispatched([row!.mutationId]);
    await outbox.markFailed(row!.mutationId, 'stale_client');
    const stored = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(stored[0]?.state).toBe('failed');
    await expect(
      outbox.listUnknownOutcome(TEST_ACCOUNT_SCOPE),
    ).resolves.toEqual([]);
  });

  it('rebases a queued row and refuses to rebase a dispatched one', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_B, bytes: BYTES });
    const [queued, dispatched] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await outbox.markFailed(queued!.mutationId, 'stale_client');
    await outbox.markDispatched([dispatched!.mutationId]);

    await expect(outbox.rebase(queued!.mutationId, 17, 3)).resolves.toBe(true);
    await expect(
      outbox.rebase(dispatched!.mutationId, 17, 3),
    ).resolves.toBe(false);

    const rows = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(rows[0]).toMatchObject({
      baseRevision: 17,
      observedGeneration: 3,
      state: 'pending',
      lastErrorCode: null,
      nextAttemptAt: null,
    });
    expect(rows[1]).toMatchObject({
      baseRevision: null,
      observedGeneration: null,
      state: 'sending',
    });
  });

  it('never rewrites the stored device id of any row it touches', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await outbox.rebase(row!.mutationId, 4, 1);
    await outbox.markDispatched([row!.mutationId]);
    await outbox.markUnknownOutcome(row!.mutationId, 'offline');
    const rows = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(rows[0]?.deviceId).toBe(TEST_DEVICE_ID);
  });

  it('removes a committed row and a discarded row alike', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A, bytes: BYTES });
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_B, bytes: BYTES });
    const [first, second] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    await outbox.markCommitted(first!.mutationId);
    await outbox.discard(second!.mutationId);
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
  });
});

describe('board #12 — quota_full', () => {
  test('quota_full is a halting error code: a full drive is not retried until the user acts', () => {
    expect(isHaltingErrorCode('quota_full')).toBe(true);
    expect(LIBRARY_SYNC_HALTING_ERROR_CODES).toContain('quota_full');
  });
});
