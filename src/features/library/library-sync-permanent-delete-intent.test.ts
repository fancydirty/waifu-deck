jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  buildEngine,
  DIGEST,
  harnessWithTrashedAsset,
  type TrashedAssetHarness,
} from '@/features/library/library-sync-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

/** buildEngine only needs ActionsHarness fields; outbox is assertion-only. */
function engineFor(harness: TrashedAssetHarness) {
  return buildEngine(harness as unknown as Parameters<typeof buildEngine>[0]);
}

describe('enqueuePermanentDeleteIntent', () => {
  beforeEach(() => {
    resetExpoCryptoDouble();
  });

  it('queues a bodyless permanent-delete for a trashed asset', async () => {
    const harness = await harnessWithTrashedAsset();
    const result = await engineFor(harness).enqueuePermanentDeleteIntent(DIGEST);
    expect(result).toMatchObject({ status: 'queued' });
    const row = await harness.outbox.listDue(harness.scope);
    expect(row[0]).toMatchObject({
      kind: 'permanent-delete',
      assetId: expect.any(String),
    });
    harness.close();
  });

  it('is idempotent while a permanent-delete is already queued', async () => {
    const harness = await harnessWithTrashedAsset();
    const engine = engineFor(harness);
    const first = await engine.enqueuePermanentDeleteIntent(DIGEST);
    const second = await engine.enqueuePermanentDeleteIntent(DIGEST);
    expect(first).toMatchObject({ status: 'queued' });
    expect(second).toMatchObject({
      status: 'already-queued',
      mutationId: (first as { mutationId: string }).mutationId,
    });
    harness.close();
  });

  it('returns not-applicable when the asset is not trash', async () => {
    const harness = await harnessWithTrashedAsset({ lifecycle: 'active' });
    await expect(
      engineFor(harness).enqueuePermanentDeleteIntent(DIGEST),
    ).resolves.toEqual({ status: 'not-applicable', reason: 'not_trash' });
    harness.close();
  });
});
