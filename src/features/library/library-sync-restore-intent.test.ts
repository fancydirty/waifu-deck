jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createActionsHarness,
  TEST_ACCOUNT_SCOPE,
  type ActionsHarness,
} from '@/features/library/library-actions-test-support';
import { createLibrarySyncOutbox } from '@/features/library/library-sync-outbox';
import { buildEngine } from '@/features/library/library-sync-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const DIGEST = 'a'.repeat(64);

describe('enqueueRestoreIntent', () => {
  let harness: ActionsHarness;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    harness = await createActionsHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it('queues a restore for a trashed asset', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST });
    await buildEngine(harness).sync();
    harness.cloud.trashRemoteAsset(DIGEST);
    await buildEngine(harness).sync();

    const result = await buildEngine(harness).enqueueRestoreIntent(DIGEST);

    expect(result.status).toBe('queued');
    const outbox = createLibrarySyncOutbox({
      database: harness.database,
      newMutationId: () => 'unused',
      clock: () => harness.now,
    });
    const [row] = await outbox.listAll(TEST_ACCOUNT_SCOPE);
    expect(row).toMatchObject({
      kind: 'restore',
      deviceId: harness.deviceId,
      assetId: harness.assetIdFor(DIGEST),
    });
  });

  it('is idempotent for a second tap', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST });
    await buildEngine(harness).sync();
    harness.cloud.trashRemoteAsset(DIGEST);
    await buildEngine(harness).sync();

    const first = await buildEngine(harness).enqueueRestoreIntent(DIGEST);
    const second = await buildEngine(harness).enqueueRestoreIntent(DIGEST);

    expect(second).toEqual({
      status: 'already-queued',
      mutationId: first.status === 'queued' ? first.mutationId : '',
    });
  });

  it('refuses an asset that is not in trash', async () => {
    await harness.seedLocalAsset({ plaintextSha256: DIGEST });
    await buildEngine(harness).sync();

    await expect(
      buildEngine(harness).enqueueRestoreIntent(DIGEST),
    ).resolves.toEqual({ status: 'not-applicable', reason: 'not_trash' });
  });

  it('refuses an unknown digest and a signed-out device', async () => {
    await expect(
      buildEngine(harness).enqueueRestoreIntent('f'.repeat(64)),
    ).resolves.toEqual({ status: 'not-applicable', reason: 'unknown_asset' });

    harness.session.signOut();
    await expect(
      buildEngine(harness).enqueueRestoreIntent(DIGEST),
    ).resolves.toEqual({ status: 'not-applicable', reason: 'no_account' });
  });
});
