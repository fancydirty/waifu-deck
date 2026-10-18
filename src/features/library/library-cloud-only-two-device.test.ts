jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

import type { LibraryActionResult } from '@/features/library/library-actions-types';
import type { LibraryDerivedImages } from '@/features/library/library-derived-images';
import { createLibraryEviction } from '@/features/library/library-eviction';
import { createLibraryLocalThumbnails } from '@/features/library/library-local-thumbnails';
import { createLibraryMirrorDown } from '@/features/library/library-mirror-down';
import { createLibrarySyncRound } from '@/features/library/library-sync-round';
import {
  createTwoDeviceHarness,
  digestFixture,
  type TwoDeviceHarness,
} from '@/features/library/library-sync-test-support';
import { createLibraryThumbnailPass } from '@/features/library/library-thumbnail-pass';
import { resetExpoCryptoDouble } from '@/test/expo-crypto-double';

const CAT = digestFixture('cat');
const NONE = { total: 0, done: 0, failed: 0 };

const thumbnailOnlyDerive: LibraryDerivedImages = {
  async derive() {
    return {
      thumbnail: {
        role: 'thumbnail',
        bytes: new Uint8Array([1, 2, 3]),
        width: 8,
        height: 8,
        format: 'webp',
      },
      preview: null,
      animated: false,
      failed: false,
    };
  },
};

/** At most 200 macrotasks, then an assertion — never Jest's timeout. */
async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  let met = await condition();
  for (let turn = 0; !met && turn < 200; turn += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    met = await condition();
  }
  expect(met).toBe(true);
}

describe('board #27 S3 leg 10: a 仅云端 device and a 本地+云端 device of one library', () => {
  let world: TwoDeviceHarness;

  beforeEach(async () => {
    resetExpoCryptoDouble();
    world = await createTwoDeviceHarness();
  });

  afterEach(() => {
    world.close();
  });

  function evictionOnA() {
    const a = world.a.harness;
    const thumbnails = createLibraryLocalThumbnails({
      repository: a.repository,
      files: a.files,
      port: a.port,
      derived: thumbnailOnlyDerive,
    });
    const eviction = createLibraryEviction({
      database: a.database,
      files: a.files,
      port: a.port,
      repository: a.repository,
      thumbnails,
      fillDerived: async () => ({ status: 'complete' }),
      isCloudOnly: async () => true,
      changes: { emit: () => undefined },
    });
    return { eviction, thumbnails };
  }

  it('A evicts without touching the cloud; B keeps downloading what A evicted; A never downloads', async () => {
    await world.a.collect(CAT);
    await world.a.protect(CAT);
    await world.a.sync();
    // The protect's derived patch runs behind its answer.
    await waitUntil(async () => {
      const ids = await world.a.generationIdsOf(CAT);
      return ids !== null && ids.thumbnail !== null && ids.preview !== null;
    });
    const collectedBytes = await world.a.harness.readOriginalBytes(CAT);
    expect(collectedBytes).not.toBeNull();
    const writes = world.account.writes.length;
    const blobs = world.account.blobs.size;
    const { eviction, thumbnails } = evictionOnA();

    await expect(eviction.evict(world.a.harness.accountScope)).resolves.toEqual({
      reclaimed: 0, evicted: 1, kept: 0,
    });

    await expect(world.a.residencyOf(CAT)).resolves.toBe('cloud-only');
    await expect(world.a.hasLocalOriginal(CAT)).resolves.toBe(false);
    expect(world.account.writes).toHaveLength(writes);
    expect(world.account.blobs.size).toBe(blobs);

    await world.b.sync();
    const mirrorDownB = createLibraryMirrorDown({
      getAccountScope: async () => world.b.harness.accountScope,
      listDownloadCandidates: (scope) => world.b.harness.protection.listDownloadCandidates(scope),
      download: (digest) => world.b.download(digest) as Promise<LibraryActionResult>,
    });
    await expect(mirrorDownB.mirrorDown()).resolves.toEqual({ total: 1, done: 1, failed: 0 });
    await expect(world.b.hasLocalOriginal(CAT)).resolves.toBe(true);
    await expect(world.b.harness.readOriginalBytes(CAT)).resolves.toEqual(collectedBytes);

    const spy = jest.fn(async () => ({ total: 1, done: 1, failed: 0 }));
    const round = createLibrarySyncRound({
      mirrorUp: { mirrorUp: async () => NONE },
      mirrorDown: { mirrorDown: spy },
      thumbnailPass: createLibraryThumbnailPass({
        database: world.a.harness.database,
        thumbnails,
      }),
      eviction,
      isCloudOnly: async () => true,
      getAccountScope: async () => world.a.harness.accountScope,
    });
    await round();
    expect(spy).not.toHaveBeenCalled();
    await expect(world.a.residencyOf(CAT)).resolves.toBe('cloud-only');
    await expect(world.a.hasLocalOriginal(CAT)).resolves.toBe(false);
  });
});
