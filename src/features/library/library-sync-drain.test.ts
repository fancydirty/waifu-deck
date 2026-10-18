jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  TEST_MASTER_KEY,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import type { S3LibraryPendingMutation } from '@/features/library/library-cloud-client-s3';
import {
  decideQueuedMutation,
  type LibraryQueuedProjection,
} from '@/features/library/library-sync-engine';
import {
  createLibrarySyncOutbox,
  type LibrarySyncOutbox,
} from '@/features/library/library-sync-outbox';
import { buildEngine } from '@/features/library/library-sync-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function projected(
  overrides: Partial<LibraryQueuedProjection> = {},
): LibraryQueuedProjection {
  return {
    lifecycle: 'active',
    protection: 'unprotected',
    revision: 12,
    generation: 2,
    updatedAt: 500,
    ...overrides,
  };
}

describe('decideQueuedMutation', () => {
  it('sends an intent for an asset the account has never seen', () => {
    expect(
      decideQueuedMutation({ kind: 'trash', createdAt: 10 }, null),
    ).toEqual({ kind: 'send', baseRevision: null, observedGeneration: null });
  });

  it('rebases onto the authoritative revision and generation', () => {
    expect(
      decideQueuedMutation({ kind: 'trash', createdAt: 10 }, projected()),
    ).toEqual({ kind: 'send', baseRevision: 12, observedGeneration: 2 });
  });

  it('discards every intent against a purged asset', () => {
    const purged = projected({ lifecycle: 'purged', protection: 'unprotected' });
    for (const kind of ['trash', 'restore', 'stop-protection', 'protect'] as const) {
      expect(
        decideQueuedMutation({ kind, createdAt: 900 }, purged),
      ).toEqual({ kind: 'discard', reason: 'purged' });
    }
  });

  it('discards a collect queued before the purge was learned', () => {
    expect(
      decideQueuedMutation(
        { kind: 'collect', createdAt: 400 },
        projected({ lifecycle: 'purged' }),
      ),
    ).toEqual({ kind: 'discard', reason: 'purged' });
  });

  it('allows a collect queued after the purge was learned', () => {
    // The user re-imported the same image on this device after a full sync
    // told it the account had permanently deleted the old one. That is a new
    // deliberate act, not a resurrection of the deleted asset.
    expect(
      decideQueuedMutation(
        { kind: 'collect', createdAt: 501 },
        projected({ lifecycle: 'purged' }),
      ),
    ).toEqual({ kind: 'send', baseRevision: 12, observedGeneration: 2 });
  });

  it('discards intents the account already satisfies', () => {
    expect(
      decideQueuedMutation({ kind: 'trash', createdAt: 9 }, projected({
        lifecycle: 'trash',
      })),
    ).toEqual({ kind: 'discard', reason: 'already_trashed' });
    expect(
      decideQueuedMutation({ kind: 'restore', createdAt: 9 }, projected()),
    ).toEqual({ kind: 'discard', reason: 'not_trash' });
    expect(
      decideQueuedMutation({ kind: 'collect', createdAt: 9 }, projected()),
    ).toEqual({ kind: 'discard', reason: 'already_active' });
    expect(
      decideQueuedMutation({ kind: 'collect', createdAt: 9 }, projected({
        lifecycle: 'trash',
      })),
    ).toEqual({ kind: 'discard', reason: 'trash_wins' });
    expect(
      decideQueuedMutation({ kind: 'stop-protection', createdAt: 9 }, projected()),
    ).toEqual({ kind: 'discard', reason: 'already_stopped' });
  });

  it('keeps a collect whose projection this device never reconciled', () => {
    // K6-3a: `revision: null` means no `state.json` has ever been read for
    // this asset — the row is a local optimistic write (a pending or failed
    // protect), not learned remote truth. Discarding the collect against it
    // deletes the only intent that would create the asset remotely.
    expect(
      decideQueuedMutation(
        { kind: 'collect', createdAt: 9 },
        projected({ revision: null, protection: 'pending' }),
      ),
    ).toEqual({ kind: 'send', baseRevision: null, observedGeneration: 2 });
  });

  it('still discards a collect the account really does hold', () => {
    // The genuine case the discard exists for: a reconciled projection, with
    // a revision this device actually read off the bucket.
    expect(
      decideQueuedMutation({ kind: 'collect', createdAt: 9 }, projected()),
    ).toEqual({ kind: 'discard', reason: 'already_active' });
  });

  it('still sends a restore for a trashed asset', () => {
    expect(
      decideQueuedMutation({ kind: 'restore', createdAt: 9 }, projected({
        lifecycle: 'trash',
      })),
    ).toEqual({ kind: 'send', baseRevision: 12, observedGeneration: 2 });
  });

  it('sends permanent-delete while the projection is trash', () => {
    expect(
      decideQueuedMutation(
        { kind: 'permanent-delete', createdAt: 9 },
        projected({ lifecycle: 'trash', revision: 4, generation: 2 }),
      ),
    ).toEqual({ kind: 'send', baseRevision: 4, observedGeneration: 2 });
  });

  it('discards permanent-delete when the projection is active', () => {
    expect(
      decideQueuedMutation(
        { kind: 'permanent-delete', createdAt: 9 },
        projected({ lifecycle: 'active' }),
      ),
    ).toEqual({ kind: 'discard', reason: 'not_trash' });
  });

  it('discards permanent-delete against a purged projection', () => {
    expect(
      decideQueuedMutation(
        { kind: 'permanent-delete', createdAt: 9 },
        projected({ lifecycle: 'purged' }),
      ),
    ).toEqual({ kind: 'discard', reason: 'purged' });
  });
});

describe('library sync engine (write half)', () => {
  let harness: ActionsHarness;
  let outbox: LibrarySyncOutbox;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    harness = await createActionsHarness();
    let sequence = 200;
    outbox = createLibrarySyncOutbox({
      database: harness.database,
      newMutationId: () => {
        sequence += 1;
        return `00000000-0000-4000-b000-${sequence.toString().padStart(12, '0')}`;
      },
      clock: () => harness.now,
    });
  });

  afterEach(() => {
    harness.close();
  });

  async function queueTrash(digest: string) {
    await harness.seedLocalAsset({ plaintextSha256: digest });
    await buildEngine(harness).sync();
    // That priming cycle legitimately submits the seeded SP6 `collect` intent.
    // The assertions below are about what the *next* cycle sends.
    harness.cloud.submittedMutations.length = 0;
    return await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(digest),
      kind: 'trash',
      baseRevision: 1,
      observedGeneration: 1,
      payload: {
        assetId: harness.assetIdFor(digest),
        plaintextSha256: digest,
        kind: 'trash',
        reservationId: null,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        queuedAt: harness.now,
      },
    });
  }

  it('drains a queued trash and clears the row', async () => {
    await queueTrash(DIGEST_A);

    const report = await buildEngine(harness).sync();

    expect(report).toMatchObject({ submitted: 1, committed: 1, rejected: 0 });
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({ lifecycle: 'trash' });
  });

  it('converges on exactly the assets the drain committed', async () => {
    await queueTrash(DIGEST_A);
    const assetId = harness.assetIdFor(DIGEST_A);
    harness.cloud.requests.length = 0;

    await buildEngine(harness).sync();

    // One listing for the cycle's reconcile, then one targeted GET per
    // committed asset — never a second full listing, which would cost N GETs
    // and could oscillate against a concurrent writer.
    expect(
      harness.cloud.requests.filter((path) => path === '/byos/assets/'),
    ).toHaveLength(1);
    expect(
      harness.cloud.requests.filter((path) => path.endsWith('/state.json')),
    ).toEqual([`/byos/assets/${assetId}/state.json`]);
  });

  it('advances the watermark once the cycle completes', async () => {
    await queueTrash(DIGEST_A);

    await buildEngine(harness).sync();

    await expect(buildEngine(harness).readSyncState()).resolves.toMatchObject({
      lastSyncedAt: harness.now,
    });
  });

  it('sends exactly the narrow BYOS body for a bodyless kind', async () => {
    await queueTrash(DIGEST_A);
    const built: S3LibraryPendingMutation[] = [];
    const engine = buildEngine(harness, {
      cloud: {
        submitMutations: async (input) => {
          built.push(...input.mutations);
          return await harness.s3.submitMutations(input);
        },
      },
    });

    await engine.sync();

    const [sent] = built;
    // No sessionToken and no reservation: SigV4 credentials are bound at
    // transport construction (decision #2) and quota is gone.
    expect(Object.keys(sent!).sort()).toEqual([
      'assetId', 'baseRevision', 'kind', 'mutationId', 'newBlob',
      'observedGeneration', 'originalGenerationId',
    ]);
    expect(sent).toMatchObject({
      kind: 'trash',
      newBlob: null,
      originalGenerationId: null,
    });
  });

  it('rebases a stale row onto the authoritative revision before sending', async () => {
    const { mutationId } = await queueTrash(DIGEST_A);
    // Another device bumped the asset while this one was offline.
    harness.cloud.bumpRevision(DIGEST_A);
    // Read before the drain: the accepted trash raises this revision again.
    const authoritative = harness.cloud.revisionFor(DIGEST_A);

    await buildEngine(harness).sync();

    const [sent] = harness.cloud.submittedMutations;
    expect(sent?.mutationId).toBe(mutationId);
    expect(sent?.baseRevision).toBe(authoritative);
    // A stale base would have been refused, so an empty outbox proves the
    // rebase happened before the submission.
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
  });

  it('never rebases or reorders a dispatched row', async () => {
    const { mutationId } = await queueTrash(DIGEST_A);
    await outbox.markDispatched([mutationId]);
    await outbox.markUnknownOutcome(mutationId, 'offline');
    harness.cloud.bumpRevision(DIGEST_A);

    await buildEngine(harness).sync();

    const [sent] = harness.cloud.submittedMutations;
    // Byte-stable replay: the same id and the same base it was sent with.
    expect(sent).toMatchObject({ mutationId, baseRevision: 1 });
  });

  it('resolves an inherited unknown from the Worker stored result', async () => {
    const { mutationId } = await queueTrash(DIGEST_A);
    await outbox.markDispatched([mutationId]);
    await outbox.markUnknownOutcome(mutationId, 'offline');
    // The first attempt really did land; only the answer was lost.
    harness.cloud.applyStoredMutation(mutationId, harness.assetIdFor(DIGEST_A));

    const report = await buildEngine(harness).sync();

    expect(report).toMatchObject({ committed: 1, unresolved: 0 });
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
    // The Worker deduplicated: no second trash was applied.
    expect(harness.cloud.appliedCountFor(harness.assetIdFor(DIGEST_A))).toBe(1);
  });

  it('keeps a sending row when the POST itself fails', async () => {
    const { mutationId } = await queueTrash(DIGEST_A);
    harness.cloud.failMutationsOnce = 'offline';

    const report = await buildEngine(harness).sync();

    expect(report).toMatchObject({ submitted: 1, unresolved: 1, committed: 0 });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(row).toMatchObject({ mutationId, state: 'sending' });
    // K7 ⑬: `sending` is what makes the row replayable; it is NOT parked
    // behind a retry time, so the next round picks it straight back up.
    expect(row?.nextAttemptAt).toBeNull();
    await expect(outbox.listDue(TEST_ACCOUNT_SCOPE)).resolves.toMatchObject([
      { mutationId },
    ]);
  });

  it('clears sending when the refusal proves nothing was applied', async () => {
    await queueTrash(DIGEST_A);
    harness.cloud.failMutationsOnce = 'refused';

    await buildEngine(harness).sync();

    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(row).toMatchObject({ state: 'failed', lastErrorCode: 'auth_attention' });
  });

  it('discards a queued intent the account purged permanently', async () => {
    await queueTrash(DIGEST_A);
    harness.cloud.purgeRemoteAsset(DIGEST_A);
    harness.cloud.submittedMutations.length = 0;

    const report = await buildEngine(harness).sync();

    expect(report).toMatchObject({ discarded: 1, submitted: 0 });
    expect(harness.cloud.submittedMutations).toHaveLength(0);
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
    // Anti-resurrection: the purge stands.
    await expect(harness.protection.findByAssetId(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
    )).resolves.toMatchObject({ lifecycle: 'purged' });
  });

  it('leaves a resync_required rejection to the next cycle\'s reconcile', async () => {
    await queueTrash(DIGEST_A);
    harness.cloud.rejectWith = 'resync_required';

    await buildEngine(harness).sync();

    // There is no cursor to rearm any more: every cycle already reconciles the
    // whole library, so the row simply waits and is rebased onto fresh truth.
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(row).toMatchObject({ state: 'failed', lastErrorCode: 'stale_client' });
    await expect(buildEngine(harness).readSyncState()).resolves.toMatchObject({
      lastSyncedAt: harness.now,
    });
  });

  it('halts a corrupt remote state row on the halting integrity code', async () => {
    await queueTrash(DIGEST_A);
    // Only the S3 client can produce this reason (a present-but-unparseable
    // `state.json` for one asset), so the client is where the test injects it.
    const engine = buildEngine(harness, {
      cloud: {
        submitMutations: async ({ mutations }) => ({
          cursor: 0,
          minBaseCursor: 0,
          results: mutations.map((mutation) => ({
            mutationId: mutation.mutationId,
            assetId: mutation.assetId,
            kind: mutation.kind,
            outcome: 'rejected' as const,
            reason: 'corrupt_remote_state' as const,
            revision: null,
            asset: null,
          })),
        }),
      },
    });

    await engine.sync();

    // `integrity` is a halting code, so the row stops being due instead of
    // rewriting a permanently corrupt object every cycle forever.
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(row).toMatchObject({ state: 'failed', lastErrorCode: 'integrity' });
    await expect(outbox.listDue(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
  });

  it('carries the sealed envelope on the collect body it builds', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const built: S3LibraryPendingMutation[] = [];
    const engine = buildEngine(harness, {
      cloud: {
        submitMutations: async (input) => {
          built.push(...input.mutations);
          return await harness.s3.submitMutations(input);
        },
      },
    });

    await engine.sync();

    // The engine is the second producer of a collect body, and under BYOS the
    // envelope rides on the asset's own state record. A collect submitted
    // without `meta` writes a state.json a second device can list but never
    // materialize.
    const [collect] = built.filter((mutation) => mutation.kind === 'collect');
    expect(Object.keys(collect!).sort()).toEqual([
      'assetId', 'baseRevision', 'kind', 'meta', 'mutationId', 'newBlob',
      'observedGeneration', 'originalGenerationId',
    ]);
    expect(collect).toMatchObject({ newBlob: null, originalGenerationId: null });
    await expect(harness.cipher.openMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: harness.assetIdFor(DIGEST_A),
      sealed: collect!.meta!,
    })).resolves.toMatchObject({ plaintextSha256: DIGEST_A });
  });

  it('submits a stored collect intent a failed attempt never delivered', async () => {
    // `seedLocalAsset` leaves the durable SP6 `collect` row behind, exactly as
    // an ingest that happened while this device was offline would.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const [queued] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(queued).toMatchObject({ kind: 'collect', state: 'pending' });
    harness.cloud.failMutationsOnce = 'offline';

    // First cycle: dispatched, outcome unknown, nothing discarded.
    const first = await buildEngine(harness).sync();
    expect(first).toMatchObject({ submitted: 1, committed: 0, unresolved: 1 });
    expect((await outbox.listAll(TEST_ACCOUNT_SCOPE))[0]).toMatchObject({
      mutationId: queued!.mutationId,
      state: 'sending',
    });

    // Second cycle: the same intent is really submitted, not merely retried
    // by a spy, and the account learns the asset. K7 ⑬: the clock is NOT
    // advanced — a row whose outcome is unknown is due on the next real
    // event, not once a 30 s → 1 h backoff has expired.
    const second = await buildEngine(harness).sync();

    expect(second).toMatchObject({ committed: 1, unresolved: 0 });
    const sent = harness.cloud.submittedMutations.filter(
      (mutation) => mutation.kind === 'collect',
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      mutationId: queued!.mutationId,
      assetId: harness.assetIdFor(DIGEST_A),
      kind: 'collect',
      newBlob: null,
      originalGenerationId: null,
    });
    expect(sent[1]?.meta).toBeDefined();
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
    expect(harness.cloud.lifecycleFor(harness.assetIdFor(DIGEST_A)))
      .toBe('active');
  });

  it('rebuilds the collect envelope from durable local metadata', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });

    await buildEngine(harness).sync();

    const [sent] = harness.cloud.submittedMutations;
    // Byte-shape parity with SP7's `metadataFor`: a second device reads this
    // envelope and nothing else to learn what the image is. C3a raised the
    // payload version to 2; this asset is a local import, so it carries no
    // `source` block and every other field keeps its v1 meaning.
    await expect(harness.cipher.openMetadata({
      masterKey: TEST_MASTER_KEY,
      assetId: harness.assetIdFor(DIGEST_A),
      sealed: sent!.meta!,
    })).resolves.toMatchObject({
      version: 3,
      plaintextSha256: DIGEST_A,
      canonicalExtension: await harness.canonicalExtensionFor(DIGEST_A),
      byteSize: await harness.byteSizeFor(DIGEST_A),
      importClassification: 'unknown',
      tags: [],
    });
  });

  it('retries EVERY row of a failed batch on the very next round, at the same instant', async () => {
    // K7 ⑬ (audit `docs/superpowers/research/2026-09-14-k7-first-principles-audit.md`):
    // one throw used to push the retry time of every row in the batch — up to
    // 50 of them, including rows whose own request never left the device —
    // 15-30 s out on the first failure and up to an hour by the sixth. Against
    // the user's own bucket there is nothing to be polite to: the next real
    // event (a save, a foreground, a reconnect) is the correct retry moment,
    // and it is already what drives the loop.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_B });
    harness.cloud.failMutationsOnce = 'offline';

    const first = await buildEngine(harness).sync();
    expect(first).toMatchObject({ submitted: 2, unresolved: 2, committed: 0 });
    const stored = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.nextAttemptAt)).toEqual([null, null]);

    // Same instant — the clock never moves — and both rows go out again.
    const second = await buildEngine(harness).sync();
    expect(second).toMatchObject({ submitted: 2, committed: 2 });
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
  });

  it('replays a dispatched protect body without a second upload', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    const { mutationId } = await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(DIGEST_A),
      kind: 'protect',
      baseRevision: 1,
      observedGeneration: 1,
      payload: {
        assetId: harness.assetIdFor(DIGEST_A),
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        // Durable: `library-protect-action.ts` stored these before its POST.
        reservationId: 'reservation-1',
        originalGenerationId: 'generation-1',
        originalCiphertextBytes: 10,
        queuedAt: harness.now,
      },
    });
    await outbox.markDispatched([mutationId]);
    await outbox.markUnknownOutcome(mutationId, 'offline');
    const blobsBefore = harness.cloud.blobs.size;
    const blobPutsBefore = harness.cloud.blobPuts.length;
    harness.cloud.submittedMutations.length = 0;

    await buildEngine(harness).sync();

    const [sent] = harness.cloud.submittedMutations;
    expect(sent).toMatchObject({
      mutationId,
      kind: 'protect',
      baseRevision: 1,
      observedGeneration: 1,
      newBlob: null,
      originalGenerationId: 'generation-1',
    });
    // No second uploader: the engine uploaded nothing.
    expect(harness.cloud.blobs.size).toBe(blobsBefore);
    expect(harness.cloud.blobPuts.length).toBe(blobPutsBefore);
    // Verification stays SP7's: SP8 never claims a verified original.
    await expect(harness.protection.findByDigest(
      TEST_ACCOUNT_SCOPE,
      DIGEST_A,
    )).resolves.toMatchObject({ verifiedAt: null });
  });

  it('replays the full generation triad so a crash never loses generations', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    // The true-crash window: `library-protect-action.ts` PUT all three role
    // blobs and enqueued this row, then the process died before its inline
    // submit wrote `state.json`. The durable row carries the whole triad it
    // uploaded, so the restart drain must replay every reference — not just the
    // original.
    const { mutationId } = await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(DIGEST_A),
      kind: 'protect',
      baseRevision: 1,
      observedGeneration: 1,
      payload: {
        assetId: harness.assetIdFor(DIGEST_A),
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'generation-1',
        originalCiphertextBytes: 10,
        thumbnailGenerationId: 'thumb-1',
        previewGenerationId: 'preview-1',
        queuedAt: harness.now,
      },
    });
    const built: S3LibraryPendingMutation[] = [];
    const engine = buildEngine(harness, {
      cloud: {
        submitMutations: async (input) => {
          built.push(...input.mutations);
          return await harness.s3.submitMutations(input);
        },
      },
    });

    await engine.sync();

    const [sent] = built.filter((mutation) => mutation.kind === 'protect');
    expect(sent).toMatchObject({
      mutationId,
      kind: 'protect',
      originalGenerationId: 'generation-1',
      generationsPatch: {
        original: 'generation-1',
        thumbnail: 'thumb-1',
        preview: 'preview-1',
      },
    });
    // The `state.json` the replay wrote references the whole triad — a second
    // device can materialize thumbnails and preview, not just the original.
    const record = harness.cloud.remote.get(harness.assetIdFor(DIGEST_A));
    expect(record?.protection).toBe('protected');
    expect(record?.generations).toEqual({
      original: 'generation-1',
      thumbnail: 'thumb-1',
      preview: 'preview-1',
    });
  });

  it('replays a legacy protect row (no triad) with at least the original ref', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    await buildEngine(harness).sync();
    // A row written BEFORE this fix: its payload has no thumbnail/preview
    // fields at all. It must still replay with `{ original }` so the asset
    // degrades to "missing derived variants" (spec-regenerable) rather than
    // "generations: {}" with even the original ref lost.
    await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(DIGEST_A),
      kind: 'protect',
      baseRevision: 1,
      observedGeneration: 1,
      payload: {
        assetId: harness.assetIdFor(DIGEST_A),
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'generation-1',
        originalCiphertextBytes: 10,
        queuedAt: harness.now,
      },
    });
    const built: S3LibraryPendingMutation[] = [];
    const engine = buildEngine(harness, {
      cloud: {
        submitMutations: async (input) => {
          built.push(...input.mutations);
          return await harness.s3.submitMutations(input);
        },
      },
    });

    await engine.sync();

    const [sent] = built.filter((mutation) => mutation.kind === 'protect');
    expect(sent?.generationsPatch).toEqual({ original: 'generation-1' });
    const record = harness.cloud.remote.get(harness.assetIdFor(DIGEST_A));
    // Never `{}`: the original reference survives an old-row replay.
    expect(record?.generations).toEqual({ original: 'generation-1' });
  });

  it('delegates only a pre-upload protect row to the protect pipeline', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const calls: string[] = [];
    const engine = buildEngine(harness, {
      pipelines: {
        retryProtect: async (digest) => { calls.push(`protect:${digest}`); },
      },
    });
    await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(DIGEST_A),
      kind: 'protect',
      baseRevision: null,
      observedGeneration: null,
      payload: {
        assetId: harness.assetIdFor(DIGEST_A),
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        // Never uploaded: there is no body for SP8 to replay.
        reservationId: null,
        originalGenerationId: null,
        originalCiphertextBytes: 10,
        queuedAt: harness.now,
      },
    });

    await engine.sync();

    expect(calls).toEqual([`protect:${DIGEST_A}`]);
    // SP8 built no protect body for a row that has no reservation.
    expect(
      harness.cloud.submittedMutations.filter((m) => m.kind === 'protect'),
    ).toHaveLength(0);
    // The row survives for SP7's pipeline; it was never discarded.
    await expect(outbox.find(
      TEST_ACCOUNT_SCOPE,
      harness.assetIdFor(DIGEST_A),
      'protect',
    )).resolves.not.toBeNull();
  });

  it('keeps a dispatched collect in sending, never failed, when the outcome is unknown', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    harness.cloud.failMutationsOnce = 'offline';

    await buildEngine(harness).sync();

    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(row?.state).toBe('sending');
    expect(row?.lastErrorCode).toBe('offline');
  });

  it('replays a never-landed protect together with its collect, collect first', async () => {
    // K6-1b crash window: `library-protect-action.ts` now writes a brand-new
    // asset's `collect` and `protect` in ONE CAS PUT, so a crash between the
    // blob uploads and that PUT leaves NOTHING on the bucket — not even the
    // collect record the old two-submit path would have left behind. Replaying
    // the protect alone would decide against a missing state.json
    // (`not_found`, a terminal rejection) and silently drop the intent, so the
    // drain must send the surviving collect with it, collect first.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const assetId = harness.assetIdFor(DIGEST_A);
    const { mutationId } = await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId,
      kind: 'protect',
      baseRevision: null,
      observedGeneration: null,
      payload: {
        assetId,
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'generation-1',
        originalCiphertextBytes: 10,
        thumbnailGenerationId: 'thumb-1',
        previewGenerationId: 'preview-1',
        queuedAt: harness.now,
      },
    });
    // Dispatched, outcome unknown: exactly what the inline merged submit
    // leaves behind when the network dies mid-PUT.
    await outbox.markDispatched([mutationId]);
    await outbox.markUnknownOutcome(mutationId, 'offline');
    harness.cloud.submittedMutations.length = 0;

    await buildEngine(harness).sync();

    expect(harness.cloud.submittedMutations.map((entry) => entry.kind)).toEqual([
      'collect',
      'protect',
    ]);
    // One state.json, carrying both: the asset exists AND is protected, with
    // every reference the crashed attempt had already uploaded.
    const record = harness.cloud.remote.get(assetId);
    expect(record).toMatchObject({ lifecycle: 'active', protection: 'protected' });
    expect(record?.generations).toEqual({
      original: 'generation-1',
      thumbnail: 'thumb-1',
      preview: 'preview-1',
    });
    // The collect's sealed envelope is what lets a second device materialize.
    expect(record?.meta).toBeDefined();
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toEqual([]);
  });

  it('skips a protect row and its paired collect while that protect is live', async () => {
    // K6-3a, proven on the emulator (asset a8bfed37, 02:25–02:29): the live
    // fresh-collect protect enqueues its `protect` row (pending,
    // `next_attempt_at` NULL, so instantly due) BEFORE its combined
    // collect+protect `submitMutations`. A sync round landing in that window
    // used to pick the row up, pair it with the collect intent (K6-1b), replay
    // both, and then DELETE both on commit — taking the collect intent the
    // live protect was about to submit with it. The live protect then read
    // `findCollectIntent() === null` and recorded the terminal
    // `object_missing`, and every later round re-read, re-sealed, and
    // re-failed the same image forever.
    //
    // The fix is ownership, not a throttle: the protect that is actually
    // uploading owns the asset, and the drain simply leaves it alone.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const assetId = harness.assetIdFor(DIGEST_A);
    await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId,
      kind: 'protect',
      baseRevision: null,
      observedGeneration: null,
      payload: {
        assetId,
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'generation-1',
        originalCiphertextBytes: 10,
        queuedAt: harness.now,
      },
    });
    harness.cloud.submittedMutations.length = 0;

    const report = await buildEngine(harness, {
      isProtectInFlight: (candidate) => candidate === assetId,
    }).sync();

    expect(report).toMatchObject({ submitted: 0, committed: 0 });
    expect(harness.cloud.submittedMutations).toEqual([]);
    // Both rows survive untouched — above all the collect intent, which is
    // what the live protect is about to submit.
    const rows = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(rows.map((row) => row.kind).sort()).toEqual(['collect', 'protect']);
    expect(rows.every((row) => row.state === 'pending')).toBe(true);
  });

  it('still replays a crashed protect and its collect when nothing is in flight', async () => {
    // The K6-1b crash-replay path, restated against the new filter: with no
    // live protect, the drain is still the thing that finishes a protect the
    // process died in the middle of.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const assetId = harness.assetIdFor(DIGEST_A);
    const { mutationId } = await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId,
      kind: 'protect',
      baseRevision: null,
      observedGeneration: null,
      payload: {
        assetId,
        plaintextSha256: DIGEST_A,
        kind: 'protect',
        reservationId: null,
        originalGenerationId: 'generation-1',
        originalCiphertextBytes: 10,
        queuedAt: harness.now,
      },
    });
    await outbox.markDispatched([mutationId]);
    await outbox.markUnknownOutcome(mutationId, 'offline');
    harness.cloud.submittedMutations.length = 0;

    await buildEngine(harness, {
      isProtectInFlight: () => false,
    }).sync();

    expect(harness.cloud.submittedMutations.map((entry) => entry.kind)).toEqual([
      'collect',
      'protect',
    ]);
  });

  it('never discards a collect intent for an asset that has no remote record yet', async () => {
    // K6-3a, second path to the same zombie (found while implementing, not in
    // the plan; see "Plan deviations"). A protect whose blob upload fails
    // writes a LOCAL `library_asset_protection` row with a defaulted
    // `lifecycle: 'active'` and `revision: null` — nothing was learned from
    // the bucket, and no `state.json` exists. `decideQueuedMutation` then read
    // that local row as "the account already has this asset" and discarded the
    // collect intent as `already_active`, after which every protect answered
    // the terminal `object_missing` forever.
    //
    // A projection this device has never reconciled proves nothing about the
    // account, so it can never authorize dropping the one intent that would
    // create the asset.
    await harness.seedLocalAsset({ plaintextSha256: DIGEST_A });
    const assetId = harness.assetIdFor(DIGEST_A);
    // Exactly what a failed protect leaves behind: pending, no revision, and
    // no remote record anywhere.
    await harness.protection.upsertProtection({
      accountScope: TEST_ACCOUNT_SCOPE,
      assetId,
      plaintextSha256: DIGEST_A,
      lifecycle: 'active',
      protection: 'pending',
      generation: 1,
      revision: null,
      originalGenerationId: null,
      originalCiphertextBytes: 10,
      thumbnailGenerationId: null,
      previewGenerationId: null,
      verifiedAt: null,
      failureCategory: 'offline',
      trashedAt: null,
    });
    expect(harness.cloud.remote.has(assetId)).toBe(false);

    await buildEngine(harness).sync();

    // The intent is still here, and the asset it describes now exists.
    expect(harness.cloud.remote.has(assetId)).toBe(true);
  });

  it('sends at most one mutation per asset per request', async () => {
    await queueTrash(DIGEST_A);
    await outbox.enqueue({
      accountScope: TEST_ACCOUNT_SCOPE,
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(DIGEST_A),
      kind: 'stop-protection',
      baseRevision: 1,
      observedGeneration: 1,
      payload: {
        assetId: harness.assetIdFor(DIGEST_A),
        plaintextSha256: DIGEST_A,
        kind: 'stop-protection',
        reservationId: null,
        originalGenerationId: null,
        originalCiphertextBytes: null,
        queuedAt: harness.now,
      },
    });

    await buildEngine(harness).sync();

    // The Worker rejects a request with a duplicated assetId outright.
    expect(harness.cloud.submittedMutations).toHaveLength(1);
  });

  it('drains nothing and halts cleanly while offline', async () => {
    await queueTrash(DIGEST_A);
    harness.cloud.offline = true;

    await expect(buildEngine(harness).sync()).resolves.toMatchObject({
      status: 'halted',
      submitted: 0,
    });
    await expect(outbox.listAll(TEST_ACCOUNT_SCOPE)).resolves.toHaveLength(1);
  });
});
