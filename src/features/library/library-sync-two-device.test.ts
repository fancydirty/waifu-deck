jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import {
  createTwoDeviceHarness,
  digestFixture,
  type TwoDeviceHarness,
} from '@/features/library/library-sync-test-support';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

// Real bytes behind each digest: protect, download, and the device trash all
// re-hash what they hold, so a made-up digest would fail integrity instead of
// proving anything about sync.
const CAT = digestFixture('cat');
const DOG = digestFixture('dog');

describe('two-device conflict contract', () => {
  let world: TwoDeviceHarness;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    world = await createTwoDeviceHarness();
  });

  afterEach(() => {
    world.close();
  });

  it('keeps two different concurrent collects as two active assets', async () => {
    await world.a.collect(CAT);
    await world.b.collect(DOG);
    await world.a.sync();
    await world.b.sync();
    await world.a.sync();

    await expect(world.a.lifecycleOf(CAT)).resolves.toBe('active');
    await expect(world.a.lifecycleOf(DOG)).resolves.toBe('active');
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('active');
    await expect(world.b.lifecycleOf(DOG)).resolves.toBe('active');
    expect(world.account.assetCount()).toBe(2);
  });

  it('collapses identical concurrent collects into one asset', async () => {
    await world.a.collect(CAT);
    await world.b.collect(CAT);
    await world.a.sync();
    await world.b.sync();

    // Same plaintext digest -> same deterministic assetId -> one account asset.
    expect(world.account.assetCount()).toBe(1);
    await expect(world.a.lifecycleOf(CAT)).resolves.toBe('active');
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('active');
    // Neither device lost its local original to the merge.
    await expect(world.a.hasLocalOriginal(CAT)).resolves.toBe(true);
    await expect(world.b.hasLocalOriginal(CAT)).resolves.toBe(true);
  });

  it('replays a retried mutation to its original result', async () => {
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();
    await world.a.trash(CAT);
    world.account.dropNextResponse = true;

    await world.a.sync();                 // lands, answer lost -> sending
    world.advance(60_000);
    const second = await world.a.sync();   // replay resolves from stored result

    expect(second).toMatchObject({ committed: 1, unresolved: 0 });
    expect(world.account.revisionsFor(CAT)).toHaveLength(2); // collect + trash
    await expect(world.a.lifecycleOf(CAT)).resolves.toBe('trash');
  });

  it('lets a newer trash beat an unseen older collect', async () => {
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();
    await world.b.trash(CAT);
    await world.b.sync();

    // A third context: A re-queues a stale collect it never sent.
    world.a.setOffline(true);
    await world.a.collect(CAT);
    world.a.setOffline(false);
    await world.a.sync();

    await expect(world.a.lifecycleOf(CAT)).resolves.toBe('trash');
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('trash');
  });

  it('gives an explicit restore a newer generation and revision', async () => {
    await world.a.collect(CAT);
    await world.a.protect(CAT);
    await world.a.sync();
    await world.b.sync();
    const before = await world.b.generationOf(CAT);

    await world.a.trash(CAT);
    await world.a.sync();
    await world.a.restore(CAT);
    await world.a.sync();
    await world.b.sync();

    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('active');
    expect(await world.b.generationOf(CAT)).toBeGreaterThan(before!);
    expect(await world.b.revisionOf(CAT)).toBeGreaterThan(0);
  });

  it('allows an explicit re-import of a purged asset as a new generation', async () => {
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();
    world.account.purge(CAT);
    await world.a.sync();
    await world.b.sync();
    const purgedGeneration = await world.a.generationOf(CAT);

    // The user deliberately re-imports the same picture after the full sync.
    world.advance(1_000);
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();

    await expect(world.a.lifecycleOf(CAT)).resolves.toBe('active');
    expect(await world.a.generationOf(CAT)).toBeGreaterThan(purgedGeneration!);
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('active');
  });

  it('rejects an old device edit made after a permanent deletion', async () => {
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();
    world.b.setOffline(true);
    await world.b.trash(CAT);          // B queues an edit while offline
    world.account.purge(CAT);          // A permanently deletes it
    await world.a.sync();

    world.b.setOffline(false);
    const report = await world.b.sync();

    // Anti-resurrection: B's stale edit is dropped, not sent.
    expect(report).toMatchObject({ discarded: 1, submitted: 0 });
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('purged');
    expect(world.account.lifecycleOf(CAT)).toBe('purged');
  });

});

describe('two-device simulation scenarios', () => {
  let world: TwoDeviceHarness;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    world = await createTwoDeviceHarness();
  });

  afterEach(() => {
    world.close();
  });

  it('does not free B when A frees local space', async () => {
    await world.a.collect(CAT);
    await world.a.protect(CAT);
    await world.a.sync();
    await world.b.sync();
    await world.b.download(CAT);

    await world.a.harness.freeLocalSpace(CAT);
    await world.a.sync();
    await world.b.sync();

    await expect(world.a.hasLocalOriginal(CAT)).resolves.toBe(false);
    await expect(world.b.hasLocalOriginal(CAT)).resolves.toBe(true);
    expect(world.account.lifecycleOf(CAT)).toBe('active');
  });

  it('propagates a deletion made while the other device was offline', async () => {
    await world.a.collect(CAT);
    // B must actually hold bytes, or the device-trash claim below is vacuous.
    await world.a.protect(CAT);
    await world.a.sync();
    await world.b.sync();
    await world.b.download(CAT);
    world.b.setOffline(true);
    await world.a.trash(CAT);
    await world.a.sync();

    world.b.setOffline(false);
    const report = await world.b.sync();

    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('trash');
    // The bytes moved to device trash; the durable original was not deleted.
    expect(report.files).toMatchObject({ movedToDeviceTrash: 1 });
    expect(world.b.harness.port.deletedFiles.filter((uri) => uri.includes('/originals/')))
      .toEqual([]);
  });

  it('serves full-quality originals offline after a download-all', async () => {
    await world.a.collect(CAT);
    await world.a.collect(DOG);
    await world.a.protect(CAT);
    await world.a.protect(DOG);
    await world.a.sync();
    await world.b.sync();

    // Cloud-only structure is visible before any byte is fetched.
    await expect(world.b.residencyOf(CAT)).resolves.toBe('cloud-only');
    await world.b.download(CAT);
    await world.b.download(DOG);

    // The generation-id TRIAD, not just the numeric `generation` counter,
    // must reach device B intact: the harness's `generationsPatch` bridge
    // bug (fixed alongside protect-action's S3 migration, d3e05d7) silently
    // dropped these exact fields, and no other two-device test asserts on
    // them with real, protect-minted ids.
    const aCat = await world.a.generationIdsOf(CAT);
    const aDog = await world.a.generationIdsOf(DOG);
    expect(aCat).toMatchObject({
      thumbnail: expect.any(String),
      preview: expect.any(String),
      original: expect.any(String),
    });
    expect(aDog).toMatchObject({
      thumbnail: expect.any(String),
      preview: expect.any(String),
      original: expect.any(String),
    });
    await expect(world.b.generationIdsOf(CAT)).resolves.toEqual(aCat);
    await expect(world.b.generationIdsOf(DOG)).resolves.toEqual(aDog);

    world.b.setOffline(true);

    await expect(world.b.hasLocalOriginal(CAT)).resolves.toBe(true);
    await expect(world.b.hasLocalOriginal(DOG)).resolves.toBe(true);
    await expect(world.b.harness.readOriginalBytes(CAT)).resolves.toHaveLength(
      await world.a.harness.originalByteLength(CAT),
    );
  });

  it('converges a long-offline device in one reconcile', async () => {
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();
    world.b.setOffline(true);
    // B misses an arbitrary amount of history while it is away. There is no
    // cursor to fall behind and no pruned feed to fail against: a stale
    // device's full rebase is just what listing every asset state produces.
    await world.a.collect(DOG);
    await world.a.sync();
    world.a.harness.cloud.trashRemoteAsset(DOG);
    await world.a.sync();
    world.b.setOffline(false);

    const report = await world.b.sync();

    expect(report).toMatchObject({ status: 'completed' });
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('active');
    await expect(world.b.lifecycleOf(DOG)).resolves.toBe('trash');
  });

  it('never uploads a whole-library snapshot while reconciling', async () => {
    await world.a.collect(CAT);
    await world.a.collect(DOG);
    await world.a.sync();
    world.account.requests.length = 0;
    await world.b.sync();

    // A device meeting a library for the first time reads it. It must never
    // mistake "I have no local rows" for "the account has nothing" and push
    // its own empty state back over everyone else's.
    const writes = world.account.requests.filter(
      (path) => path.includes('/mutations') || path.includes('/objects/'),
    );
    expect(writes).toEqual([]);
  });

  it('refuses to resurrect a purged asset from a stale queue', async () => {
    await world.a.collect(CAT);
    await world.a.sync();
    await world.b.sync();
    world.b.setOffline(true);
    await world.b.trash(CAT);
    world.account.purge(CAT);
    await world.a.sync();

    world.b.setOffline(false);
    await world.b.sync();
    await world.b.sync();
    await world.a.sync();

    expect(world.account.lifecycleOf(CAT)).toBe('purged');
    await expect(world.a.lifecycleOf(CAT)).resolves.toBe('purged');
    await expect(world.b.lifecycleOf(CAT)).resolves.toBe('purged');
  });
});
