import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@/db/schema';
import { createCollectionService } from '@/features/collection/collection-service';
import {
  createCollectionFileRepository,
  type CollectionFilePort,
} from '@/features/collection/file-repository';
import { createDataResetCoordinator } from '@/features/data-reset/data-reset-coordinator';
import {
  createDiscoveryService as createDiscoveryServiceWithCoordinator,
  discoveryReserveLowWater,
  discoveryReserveTarget,
  DISCOVERY_FIRST_PAINT_BATCH,
  DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
  MAX_DUPLICATE_ONLY_ATTEMPTS,
  MAX_REFILL_BATCHES,
  type DiscoveryBatchFetcher,
  type DiscoveryCollectionPort,
  type DiscoveryLibraryPort,
} from '@/features/discovery/discovery-service';
import {
  createImageRepository,
  type RestoredDeck,
  type StoredImage,
} from '@/features/images/image-repository';
import { createDiscoveryProviderFetcher } from '@/features/providers/provider-client';
import {
  createProviderYieldLedger,
  type ProviderYieldStat,
} from '@/features/providers/provider-yield-ledger';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';
import type {
  ImageCandidate,
  ImageProviderKey,
  WaifuImage,
} from '@/features/waifu/types';
import { WaifuApiError } from '@/features/waifu/waifu-client';
import { createNodeSqliteAdapter } from '@/test/node-sqlite-adapter';

type DiscoveryServiceDependencies = Omit<
  Parameters<typeof createDiscoveryServiceWithCoordinator>[0],
  'coordinator'
>;

function createDiscoveryService(
  dependencies: DiscoveryServiceDependencies,
  coordinator = createDataResetCoordinator(),
) {
  return createDiscoveryServiceWithCoordinator({ ...dependencies, coordinator });
}

function createEmptyFilePort(): CollectionFilePort {
  const files = new Map<string, number>();
  return {
    rootUri: 'file:///documents/collection',
    resolve: (name) => `file:///documents/collection/${name}`,
    ensureDirectory: async () => undefined,
    exists: async (uri) => files.has(uri),
    download: async (_remoteUrl, uri) => {
      files.set(uri, 1);
    },
    move: async (source, destination) => {
      const size = files.get(source) ?? 0;
      files.delete(source);
      files.set(destination, size);
    },
    delete: async (uri) => {
      files.delete(uri);
    },
    size: async (uri) => files.get(uri) ?? 0,
    directorySize: async () => [...files.values()].reduce((sum, size) => sum + size, 0),
    list: async () => [...files.keys()],
    isSharingAvailable: async () => true,
    share: async () => undefined,
    requestPhotoPermission: async () => true,
    exportToPhotos: async () => undefined,
  };
}

const candidate = (
  id: number,
  overrides: Partial<WaifuImage> = {},
): WaifuImage => ({
  id,
  providerKey: 'waifu_im',
  providerItemId: String(id),
  canonicalSourceKey: null,
  perceptualHash: null,
  md5: null,
  remoteUrl: `https://cdn.example.com/${id}.webp`,
  sourceUrl: null,
  artistName: null,
  artistUrl: null,
  width: 1200,
  height: 1800,
  byteSize: 456_789,
  extension: '.webp',
  dominantColor: '#aabbcc',
  isNsfw: false,
  isAnimated: false,
  tags: ['waifu'],
  ...overrides,
});

async function openRepository() {
  const nativeDatabase = new DatabaseSync(':memory:');
  const database = createNodeSqliteAdapter(nativeDatabase);
  await migrateDatabase(database);
  return {
    nativeDatabase,
    database,
    repository: createImageRepository(database),
  };
}

async function dismiss(repository: ReturnType<typeof createImageRepository>, id: number) {
  await repository.insertCandidates([candidate(id)]);
  await repository.activateNext(100);
  await repository.decide(id, 'dismissed', 200);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Lets detached background work (the rewind's removal chain) run. */
async function settle(predicate: () => boolean, rounds = 50): Promise<void> {
  for (let round = 0; round < rounds && !predicate(); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('discoveryReserveLowWater (deck jank 2026-09-17)', () => {
  test('is half the reserve target, rounded up, so a swipe never re-arms a full reserve', () => {
    expect(discoveryReserveLowWater(30)).toBe(15);
    expect(discoveryReserveLowWater(40)).toBe(20);
    expect(discoveryReserveLowWater(60)).toBe(30);
    // one below target (the old trigger) is comfortably above the mark
    for (const target of [30, 40, 60]) {
      expect(target - 1).toBeGreaterThan(discoveryReserveLowWater(target));
    }
  });
});

describe('discoveryReserveTarget (R8.20 deeper streaming buffer)', () => {
  test('the reserve follows the user-visible prefetchDepth: 30 / 40 / 60', () => {
    // Owner 2026-09-09: "队列最低都要有 30-40 张". prefetchDepth is what the
    // settings row edits; the DB reserve holds at least that many so every
    // prefetched image has a card behind it. Bounded to [30, 60].
    expect(discoveryReserveTarget(30)).toBe(30);
    expect(discoveryReserveTarget(40)).toBe(40);
    expect(discoveryReserveTarget(60)).toBe(60);
    expect(discoveryReserveTarget(5)).toBe(30);
    expect(discoveryReserveTarget(999)).toBe(60);
  });

  test('the first-paint refill batch is a constant, not a settings field', () => {
    expect(DISCOVERY_FIRST_PAINT_BATCH).toBe(5);
  });
});

describe('DiscoveryService restore and refill', () => {
  test('filters handled images through repository uniqueness and sends recent IDs as an optimization', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => ({ items: [candidate(1), candidate(2), candidate(3)], totalCount: 3 }),
    );

    try {
      await dismiss(repository, 1);
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });

      await service.restore();
      const result = await service.refill(DEFAULT_SETTINGS);

      expect(result.status).toBe('ready');
      expect([result.deck.active, ...result.deck.queued].map((image) => image?.id)).toEqual([
        2,
        3,
      ]);
      // G3c Task 3: MAX_REFILL_BATCHES 3 -> 2 (spec §2.3). The round budget is
      // what changed, not the exclusion behaviour this test is about — the same
      // two rounds run and the same IDs are excluded.
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(fetchBatch.mock.calls[0][0].excludedIds).toContain(1);
      expect(fetchBatch.mock.calls[0][0].excludedProviderIds.waifu_im).toContain('1');
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'dismissed' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('promotes an old duplicate into the bounded exclusion window before the next request', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>()
      .mockResolvedValueOnce({ items: [candidate(1)], totalCount: 102 })
      .mockResolvedValueOnce({ items: [candidate(1_000)], totalCount: 102 })
      .mockResolvedValueOnce({ items: [], totalCount: 102 });

    try {
      for (let id = 1; id <= 101; id += 1) await dismiss(repository, id);
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const result = await service.refill(DEFAULT_SETTINGS);

      expect(fetchBatch.mock.calls[0][0].excludedIds).not.toContain(1);
      expect(fetchBatch.mock.calls[1][0].excludedIds).toContain(1);
      expect(fetchBatch.mock.calls[1][0].excludedProviderIds.waifu_im).toContain('1');
      expect(result).toMatchObject({ status: 'ready', inserted: 1 });
      expect(result.deck.active?.id).toBe(1_000);
    } finally {
      nativeDatabase.close();
    }
  });

  test('returns exhausted after every allowed duplicate-only batch', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => ({ items: [candidate(1)], totalCount: 1 }),
    );

    try {
      await dismiss(repository, 1);
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const result = await service.refill(DEFAULT_SETTINGS);

      expect(result).toMatchObject({ status: 'exhausted', inserted: 0 });
      expect(result.deck.active).toBeNull();
      expect(result.deck.queued).toEqual([]);
      // G3c Task 3: two rounds, not three. MAX_DUPLICATE_ONLY_ATTEMPTS moved
      // with MAX_REFILL_BATCHES so the outcome is unchanged — every batch this
      // refill was allowed to fetch was duplicate-only, so it is exhausted.
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(MAX_DUPLICATE_ONLY_ATTEMPTS).toBe(MAX_REFILL_BATCHES);
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'dismissed' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('board #19: a drained deck whose refill finds nothing and hits one failed source reports exhausted, not an error', async () => {
    // Cross-layer, through the real provider fan-out: every answering source
    // has nothing new and one source errors. The owner saw
    // 「暂时无法完成 / Safebooru 暂时不可用」 here; a dry pool is `exhausted`.
    const { nativeDatabase, repository } = await openRepository();
    const fetchBatch = createDiscoveryProviderFetcher({
      fetchWaifu: jest.fn(async () => ({ items: [], totalCount: 0 })),
      fetchNekos: jest.fn(async () => ({ items: [], totalCount: 0 })),
      fetchSafebooru: jest.fn(async () => {
        throw Object.assign(new Error('Safebooru returned invalid JSON'), {
          code: 'invalid_response',
        });
      }),
    });

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      await expect(service.refill({
        ...DEFAULT_SETTINGS,
        nsfwMode: 'mixed',
        nsfwConfirmed: true,
        animationMode: 'only',
        providers: {
          waifu_im: true, nekos_api: true, danbooru: false, safebooru: true, yandere: false,
          konachan: false, e621: false, e926: false, gelbooru: false, rule34: false,
        },
      })).resolves.toMatchObject({ status: 'exhausted', inserted: 0 });
    } finally {
      nativeDatabase.close();
    }
  });

  test('requests a fair all-provider batch when the persisted deck is empty', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const slowProviderCandidates = Array.from({ length: 6 }, (_, index) =>
      candidate(index + 2, {
        providerKey: 'danbooru',
        providerItemId: `slow-fresh-${index + 2}`,
      }),
    );
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => ({ items: slowProviderCandidates, totalCount: 7 }),
    );

    try {
      await dismiss(repository, 1);
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const result = await service.refill(DEFAULT_SETTINGS);

      expect(fetchBatch).toHaveBeenCalledTimes(1);
      expect(fetchBatch.mock.calls[0][0].preferFirstUsable).toBe(false);
      expect(result).toMatchObject({
        status: 'ready',
        inserted: 6,
        deck: { active: { providerKey: 'danbooru', providerItemId: 'slow-fresh-2' } },
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('first-card streaming: a cold paint activates the fastest source before the slow one settles, accounted once', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let settleSlow!: () => void;
    const slowArrives = new Promise<void>((resolve) => { settleSlow = resolve; });
    const fast = [
      candidate(11, { providerItemId: 'fast-11' }),
      candidate(12, { providerItemId: 'fast-12' }),
    ];
    const slow = Array.from({ length: 4 }, (_, index) =>
      candidate(20 + index, { providerKey: 'danbooru', providerItemId: `slow-${20 + index}` }),
    );
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ onSourceSettled }) => {
        // The fast source lands on the tick the round starts; the slow one
        // lands only when this test says so — "before the slow one settles" is
        // a fact, not a timing guess.
        onSourceSettled?.({ providerKey: 'waifu_im', items: fast });
        await slowArrives;
        onSourceSettled?.({ providerKey: 'danbooru', items: slow });
        return {
          items: [...fast, ...slow],
          totalCount: 6,
          providerRounds: [
            { providerKey: 'waifu_im', requested: 3, returned: 2, admitted: 2, outcome: 'ok' },
            { providerKey: 'danbooru', requested: 3, returned: 4, admitted: 4, outcome: 'ok' },
          ],
        };
      },
    );
    const yieldLedger = createProviderYieldLedger();

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300, yieldLedger });
      await service.restore();
      const published: RestoredDeck[] = [];
      const unsubscribe = service.subscribe((deck) => { published.push(deck); });

      const pending = service.refill(DEFAULT_SETTINGS);
      for (let tick = 0; tick < 50 && service.getDeck().active === null; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // The fast source is on screen while the slow one is still out.
      expect(service.getDeck().active).toMatchObject({ providerKey: 'waifu_im', providerItemId: 'fast-11' });
      expect(service.getDeck().queued.map((card) => card.providerItemId)).toEqual(['fast-12']);
      expect(published[0]?.active).toMatchObject({ providerItemId: 'fast-11' });

      settleSlow();
      const result = await pending;
      expect(result).toMatchObject({ status: 'ready', inserted: 6 });
      expect(result.deck.queued.map((card) => card.providerItemId))
        .toEqual(['fast-12', 'slow-20', 'slow-21', 'slow-22', 'slow-23']);
      // Streamed cards are accounted exactly once in the ledger.
      expect(yieldLedger.stats().get('waifu_im')).toMatchObject({ inserted: 2, admitted: 2 });
      expect(yieldLedger.stats().get('danbooru')).toMatchObject({ inserted: 4, admitted: 4 });
      unsubscribe();
    } finally {
      nativeDatabase.close();
    }
  });

  test('first-card streaming: the rounds after a streamed paint ask the fetcher for the soft quota; steady state never does', async () => {
    // Spec §4: convergence is the fetcher's wave-1 share plan applying the
    // rolling quota for the window after a streamed cold paint. The streaming
    // round itself does not (no evidence yet), the next rounds do, and a
    // process that never streamed never asks for it.
    const { nativeDatabase, repository } = await openRepository();
    let next = 100;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ onSourceSettled, desiredCount }) => {
        const items = Array.from({ length: desiredCount }, () => candidate(next++));
        onSourceSettled?.({ providerKey: 'waifu_im', items });
        return { items, totalCount: items.length };
      },
    );
    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();
      await service.refill(DEFAULT_SETTINGS);            // cold paint: streams
      expect(fetchBatch.mock.calls[0][0].onSourceSettled).toBeDefined();
      expect(fetchBatch.mock.calls[0][0].softQuota).toBe(false);

      await service.warmReserve(DEFAULT_SETTINGS);       // first fair round after it
      expect(fetchBatch.mock.calls[1][0].onSourceSettled).toBeUndefined();
      expect(fetchBatch.mock.calls[1][0].softQuota).toBe(true);
    } finally {
      nativeDatabase.close();
    }

    // A process that never streamed never asks for the quota.
    const fresh = await openRepository();
    const steady = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ desiredCount }) => {
        const items = Array.from({ length: desiredCount }, () => candidate(next++));
        return { items, totalCount: items.length };
      },
    );
    try {
      await fresh.repository.insertCandidates([candidate(1)]);
      await fresh.repository.activateNext(100);
      const service = createDiscoveryService({ repository: fresh.repository, fetchBatch: steady, clock: () => 300 });
      await service.restore();
      await service.refill(DEFAULT_SETTINGS);
      await service.warmReserve(DEFAULT_SETTINGS);
      for (const [input] of steady.mock.calls) expect(input.softQuota).toBe(false);
    } finally {
      fresh.nativeDatabase.close();
    }
  });

  test('first-card streaming: beyond the streamed head, the persisted deck keeps the G3 run bound after the reserve round', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const streamedHead = Array.from({ length: 6 }, (_, index) =>
      candidate(100 + index, { providerItemId: `w-${100 + index}` }),
    );
    const reserve = (key: ImageProviderKey, start: number) => Array.from({ length: 12 }, (_, index) =>
      candidate(start + index, { providerKey: key, providerItemId: `${key}-${start + index}` }),
    );
    let round = 0;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ onSourceSettled }) => {
        round += 1;
        if (round === 1) {
          // Cold paint: only waifu has landed when it streams; the aggregate
          // adds nothing new (the slow sources answered empty this round).
          onSourceSettled?.({ providerKey: 'waifu_im', items: streamedHead });
          return { items: streamedHead, totalCount: 6, providerRounds: [
            { providerKey: 'waifu_im', requested: 2, returned: 6, admitted: 6, outcome: 'ok' },
            { providerKey: 'danbooru', requested: 2, returned: 0, admitted: 0, outcome: 'ok' },
            { providerKey: 'nekos_api', requested: 2, returned: 0, admitted: 0, outcome: 'ok' },
          ] };
        }
        // Reserve round: three sources, twelve each, index-major merge as
        // provider-client would hand it over.
        const buckets = [reserve('waifu_im', 200), reserve('danbooru', 300), reserve('nekos_api', 400)];
        const merged: ImageCandidate[] = [];
        for (let index = 0; index < 12; index += 1) for (const bucket of buckets) merged.push(bucket[index]!);
        return { items: merged, totalCount: 36 };
      },
    );

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();
      await service.refill(DEFAULT_SETTINGS);
      await service.warmReserve({ ...DEFAULT_SETTINGS, prefetchDepth: 40 });

      const deck = await repository.restoreDeck();
      const keys = [...(deck.active === null ? [] : [deck.active]), ...deck.queued].map((card) => card.providerKey);
      // The head is the feature: at most the first-paint batch, all from the
      // source that had landed.
      const head = keys.slice(0, DISCOVERY_FIRST_PAINT_BATCH + 1);
      expect(head.every((key) => key === 'waifu_im')).toBe(true);

      // Beyond the head the G3 §6.5 bound holds, and the seam does not extend
      // the head's run: the first card after the head is not waifu.
      const tail = keys.slice(DISCOVERY_FIRST_PAINT_BATCH + 1);
      expect(tail[0]).not.toBe('waifu_im');
      const counts = new Map<ImageProviderKey, number>();
      for (const key of tail) counts.set(key, (counts.get(key) ?? 0) + 1);
      const biggest = Math.max(...counts.values());
      const bound = Math.max(
        DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
        Math.ceil(biggest / (tail.length - biggest + 1)),
      );
      let longest = 0;
      let run = 0;
      let previous: ImageProviderKey | null = null;
      for (const key of tail) {
        run = key === previous ? run + 1 : 1;
        previous = key;
        longest = Math.max(longest, run);
      }
      expect(longest).toBeLessThanOrEqual(bound);
    } finally {
      nativeDatabase.close();
    }
  });

  test('first-card streaming only on a cold paint: a non-empty deck refills as before (no delivery callback)', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => ({ items: [candidate(2), candidate(3)], totalCount: 2 }),
    );
    try {
      await repository.insertCandidates([candidate(1)]);
      await repository.activateNext(100);
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();
      await service.refill(DEFAULT_SETTINGS);
      expect(fetchBatch.mock.calls[0][0].onSourceSettled).toBeUndefined();
    } finally {
      nativeDatabase.close();
    }
  });

  test('first-card streaming only on the first-paint round: a cold reserve warm does not stream (G3 §6.3 fair path)', async () => {
    // Deviation from the plan's literal `streamFirstPaint = candidateCount === 0`:
    // `warmReserve` on an empty deck is *also* depth-0, and streaming it would
    // hand a 30-card reserve to whichever source answered first — the fair
    // aggregate is then truncated to nothing and the G3 §6.3 seeded gate's
    // no-starve / lean / run-cap properties collapse. Spec §4 bounds the
    // streamed head to DISCOVERY_FIRST_PAINT_BATCH + 1 and §5 leaves the
    // reserve round on the fair path, so only the first-paint target streams.
    const { nativeDatabase, repository } = await openRepository();
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => ({ items: [candidate(2), candidate(3)], totalCount: 2 }),
    );
    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();
      await service.warmReserve({ ...DEFAULT_SETTINGS, prefetchDepth: 30 });
      expect(fetchBatch.mock.calls[0][0].desiredCount).toBe(30);
      expect(fetchBatch.mock.calls[0][0].onSourceSettled).toBeUndefined();
    } finally {
      nativeDatabase.close();
    }
  });

  test('shares one in-flight refill across concurrent callers', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let resolveBatch!: (value: { items: WaifuImage[]; totalCount: number }) => void;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      () => {
        if (fetchBatch.mock.calls.length === 1) {
          return new Promise((resolve) => {
            resolveBatch = resolve;
          });
        }
        return Promise.resolve({ items: [candidate(2)], totalCount: 1 });
      },
    );

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const first = service.refill(DEFAULT_SETTINGS);
      const second = service.refill(DEFAULT_SETTINGS);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchBatch).toHaveBeenCalledTimes(1);

      resolveBatch({ items: [candidate(2)], totalCount: 1 });
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: 'ready', inserted: 1 }),
        expect.objectContaining({ status: 'ready', inserted: 1 }),
      ]);
      // G3c Task 3: the shared-refill semantics are unchanged; only the round
      // budget dropped from 3 to 2 (spec §2.3).
      expect(fetchBatch).toHaveBeenCalledTimes(2);
    } finally {
      nativeDatabase.close();
    }
  });

  test('continues partial-fresh pagination toward the target for at most two batches', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const batches = [candidate(10), candidate(11), candidate(12)];
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => {
        const item = batches.shift();
        return { items: item ? [item] : [], totalCount: 1 };
      },
    );

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const result = await service.refill(DEFAULT_SETTINGS);

      // G3c Task 3 (spec §2.3): the loop is bounded at MAX_REFILL_BATCHES = 2,
      // so the third one-item batch is never asked for. The bounded top-up wave
      // inside the fetcher (Task 2) is what recovers the shortfall now, aimed
      // only at sources that were capped rather than at everyone.
      expect(MAX_REFILL_BATCHES).toBe(2);
      expect(result).toMatchObject({ status: 'ready', inserted: 2 });
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(batches).toEqual([candidate(12)]);
      expect([result.deck.active, ...result.deck.queued].map((image) => image?.id)).toEqual([
        10,
        11,
      ]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('stops when the first-paint batch target is reached', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const first = Array.from({ length: 13 }, (_, index) => candidate(100 + index));
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>()
      .mockResolvedValue({ items: first, totalCount: 13 });

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const result = await service.refill(DEFAULT_SETTINGS);

      expect(result).toMatchObject({ status: 'ready', inserted: 6 });
      expect(fetchBatch).toHaveBeenCalledTimes(1);
      expect(fetchBatch).toHaveBeenCalledWith(expect.objectContaining({
        desiredCount: 6,
        preferFirstUsable: false,
      }));
      expect([result.deck.active, ...result.deck.queued]).toHaveLength(6);
    } finally {
      nativeDatabase.close();
    }
  });

  test('warms a larger metadata reserve after the foreground deck is ready', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let nextId = 100;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ desiredCount = 1 }) => ({
        items: Array.from({ length: desiredCount }, () => candidate(nextId++)),
        totalCount: desiredCount,
      }),
    );
    const settings = { ...DEFAULT_SETTINGS, prefetchDepth: 30 as const };

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const foreground = await service.refill(settings);
      const reserve = await service.warmReserve(settings);

      expect(foreground.deck.active).not.toBeNull();
      expect(fetchBatch.mock.calls[0][0].desiredCount).toBe(6);
      // R8.20: reserve warms the 6-deep foreground up to the 30 floor.
      expect(fetchBatch.mock.calls[1][0].desiredCount).toBe(24);
      expect([reserve.deck.active, ...reserve.deck.queued]).toHaveLength(
        discoveryReserveTarget(settings.prefetchDepth),
      );
    } finally {
      nativeDatabase.close();
    }
  });

  test('R8.20: warmReserve streams to a 60-deep buffer when prefetchDepth is 60, not the 30 floor', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let nextId = 700;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ desiredCount = 1 }) => ({
        items: Array.from({ length: desiredCount }, () => candidate(nextId++)),
        totalCount: desiredCount,
      }),
    );
    // prefetchDepth is the one field raised to 60. warmReserve must key off
    // prefetchDepth, so the buffer streams to 60 rather than the 30 floor.
    const settings = { ...DEFAULT_SETTINGS, prefetchDepth: 60 as const };

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const foreground = await service.refill(settings);
      const reserve = await service.warmReserve(settings);

      expect(foreground.deck.active).not.toBeNull();
      expect(fetchBatch.mock.calls[0][0].desiredCount).toBe(6);
      // Reserve warms the 6-deep foreground up to 60, not 30: a 54-item top-up.
      expect(fetchBatch.mock.calls[1][0].desiredCount).toBe(54);
      expect([reserve.deck.active, ...reserve.deck.queued]).toHaveLength(60);
    } finally {
      nativeDatabase.close();
    }
  });

  test('continues to the larger reserve when warming overlaps foreground refill', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let releaseForeground!: () => void;
    const foregroundGate = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    let nextId = 200;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ desiredCount = 1 }) => {
        if (fetchBatch.mock.calls.length === 1) await foregroundGate;
        return {
          items: Array.from({ length: desiredCount }, () => candidate(nextId++)),
          totalCount: desiredCount,
        };
      },
    );
    const settings = { ...DEFAULT_SETTINGS, prefetchDepth: 30 as const };

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 400 });
      await service.restore();

      const foreground = service.refill(settings);
      while (fetchBatch.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const reserve = service.warmReserve(settings);
      releaseForeground();

      await expect(foreground).resolves.toMatchObject({ status: 'ready', inserted: 6 });
      // R8.20: the reserve now streams to a 30-deep buffer (was 15), so it tops
      // the foreground's 6 up to 30 in one 24-item warm.
      await expect(reserve).resolves.toMatchObject({ status: 'ready', inserted: 24 });
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(fetchBatch.mock.calls.map(([input]) => input.desiredCount)).toEqual([6, 24]);
      expect([service.getDeck().active, ...service.getDeck().queued]).toHaveLength(30);
    } finally {
      releaseForeground();
      nativeDatabase.close();
    }
  });

  test('lets a foreground target resolve before a larger reserve finishes', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let releaseReserve!: () => void;
    const reserveGate = new Promise<void>((resolve) => {
      releaseReserve = resolve;
    });
    let nextId = 300;
    let batchCall = 0;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async ({ desiredCount = 1 }) => {
        batchCall += 1;
        const requested = batchCall === 1 ? 3 : desiredCount;
        if (batchCall === 2) await reserveGate;
        return {
          items: Array.from({ length: requested }, () => candidate(nextId++)),
          totalCount: requested,
        };
      },
    );
    const settings = { ...DEFAULT_SETTINGS, prefetchDepth: 30 as const };

    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 500 });
      await service.restore();

      let reserveSettled = false;
      const reserve = service.warmReserve(settings).then((result) => {
        reserveSettled = true;
        return result;
      });
      const foreground = service.refill(settings);

      await expect(foreground).resolves.toMatchObject({
        status: 'ready',
        inserted: 3,
        deck: { active: expect.any(Object) },
      });
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(reserveSettled).toBe(false);

      releaseReserve();
      await expect(reserve).resolves.toMatchObject({ status: 'ready' });
    } finally {
      releaseReserve();
      nativeDatabase.close();
    }
  });

  test('propagates a typed network failure without scheduling a retry', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const error = new WaifuApiError('network', 'offline');
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => {
        throw error;
      },
    );

    try {
      const service = createDiscoveryService({ repository, fetchBatch });
      await service.restore();

      await expect(service.refill(DEFAULT_SETTINGS)).rejects.toBe(error);
      expect(fetchBatch).toHaveBeenCalledTimes(1);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('DiscoveryService decisions and rewind', () => {
  test('clears deck state written by a non-abortable restore after reset begins', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const coordinator = createDataResetCoordinator();
    const discovery = createDiscoveryService({ repository, clock: () => 300 }, coordinator);
    const collection = createCollectionService({
      repository,
      files: createCollectionFileRepository(createEmptyFilePort()),
      coordinator,
    });
    const restoreDeck = repository.restoreDeck.bind(repository);
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    jest.spyOn(repository, 'restoreDeck').mockImplementationOnce(async () => {
      await restoreGate;
      return restoreDeck();
    });

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const restore = discovery.restore();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const reset = collection.deleteAllData();
      await new Promise((resolve) => setTimeout(resolve, 0));

      releaseRestore();
      await expect(restore).resolves.toMatchObject({ active: { id: 1 } });
      await expect(reset).resolves.toMatchObject({ ok: true, remaining: [] });

      expect(discovery.getDeck()).toEqual({ active: null, queued: [] });
      await expect(repository.restoreDeck()).resolves.toEqual({ active: null, queued: [] });
    } finally {
      releaseRestore();
      nativeDatabase.close();
    }
  });

  test('clears a full process deck before reset and keeps queued work on the new epoch', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const coordinator = createDataResetCoordinator();
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      async () => ({ items: [], totalCount: 0 }),
    );
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const settings = { reset: jest.fn(() => settingsGate) };
    const discovery = createDiscoveryService({ repository, fetchBatch, clock: () => 300 }, coordinator);
    const collection = createCollectionService({
      repository,
      files: createCollectionFileRepository(createEmptyFilePort()),
      settings,
      coordinator,
    });

    try {
      await repository.insertCandidates(
        Array.from({ length: 20 }, (_, index) => candidate(index + 1)),
      );
      await discovery.restore();
      expect(discovery.getDeck()).toMatchObject({
        active: { id: 1 },
        queued: expect.arrayContaining([expect.objectContaining({ id: 20 })]),
      });

      const reset = collection.deleteAllData();
      while (settings.reset.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(discovery.getDeck()).toEqual({ active: null, queued: [] });
      const queuedRefill = discovery.refill(DEFAULT_SETTINGS);
      const queuedDecision = discovery.decide(1, 'dismissed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchBatch).not.toHaveBeenCalled();

      releaseSettings();
      await reset;

      await expect(queuedRefill).resolves.toEqual({
        status: 'exhausted',
        inserted: 0,
        deck: { active: null, queued: [] },
      });
      await expect(queuedDecision).resolves.toBeNull();
      expect(discovery.getDeck()).toEqual({ active: null, queued: [] });
      await expect(repository.restoreDeck()).resolves.toEqual({ active: null, queued: [] });
    } finally {
      releaseSettings();
      nativeDatabase.close();
    }
  });

  test('R8.16-A: decide advances the deck without re-reading the whole table', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let restoreDeckCalls = 0;
    const countedRepository = new Proxy(repository, {
      get(target, prop, receiver) {
        if (prop === 'restoreDeck') {
          return async () => {
            restoreDeckCalls += 1;
            return target.restoreDeck();
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    try {
      // A deep queued deck: one active + a full preload queue, so a decide has
      // a next card to promote without any full-table refresh.
      await repository.insertCandidates(
        [1, 2, 3, 4, 5, 6].map((id) => candidate(id)),
      );
      const service = createDiscoveryService({ repository: countedRepository, clock: () => 1_000 });
      await service.restore();
      const restoresAfterRestore = restoreDeckCalls;

      const decision = await service.decide(1, 'dismissed');

      // The decided card left and the next queued card was promoted — the
      // user-visible outcome the restore reads used to guarantee.
      expect(decision).toMatchObject({ imageId: 1, decision: 'dismissed' });
      expect(decision!.deck.active?.id).toBe(2);
      expect(decision!.deck.queued.map((image) => image.id)).toEqual([3, 4, 5, 6]);
      expect(service.getDeck()).toMatchObject({ active: { id: 2 } });
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'dismissed' });

      // The gate: a decide must not add full-table restore reads. The old
      // implementation did restoreDeck() (+ possibly another after
      // activateNext) per decide.
      expect(restoreDeckCalls).toBe(restoresAfterRestore);
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: rewinds three decisions newest first, publishing every depth, then reports empty', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let now = 1_000;

    try {
      await repository.insertCandidates([1, 2, 3, 4, 5].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => now });
      const depths: number[] = [];
      service.subscribeRewindDepth((depth) => depths.push(depth));
      await service.restore();
      expect(service.rewindDepth()).toBe(0);

      await service.decide(1, 'dismissed');                       // 1
      now += 10;
      await service.decide(2, 'saved');                           // 2
      now += 10;
      await service.decide(3, 'dismissed');                       // 3
      expect(service.rewindDepth()).toBe(3);

      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 3, decision: 'dismissed', decidedAt: 1_020 },
        deck: { active: { id: 3, decision: 'active' } },
      });
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 2, decision: 'saved', decidedAt: 1_010 },
        deck: { active: { id: 2, decision: 'active' } },
      });
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 1, decision: 'dismissed', decidedAt: 1_000 },
        deck: { active: { id: 1, decision: 'active' } },
      });
      expect(service.getDeck()).toMatchObject({
        active: { id: 1 },
        queued: [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      });
      await expect(repository.listCollection()).resolves.toEqual([]);

      await expect(service.rewind()).resolves.toMatchObject({ status: 'empty' });
      expect(service.rewindDepth()).toBe(0);
      expect(depths).toEqual([1, 2, 3, 2, 1, 0]);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a null decide does not let the next swipe write the failed card', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      const service = createDiscoveryService({ repository, clock: () => 1_000 });
      await service.restore();
      const decide = jest.spyOn(repository, 'decide').mockResolvedValueOnce(null);

      await expect(service.decide(1, 'saved')).resolves.toBeNull();
      expect(service.rewindDepth()).toBe(0);
      await expect(service.decide(2, 'dismissed')).resolves.toMatchObject({ imageId: 2 });

      expect(decide).toHaveBeenNthCalledWith(1, 1, 'saved', 1_000);
      expect(decide).toHaveBeenNthCalledWith(2, 2, 'dismissed', 1_000);
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'queued',
        presentedAt: null,
      });
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 2 },
      });
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'queued' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a failed card comes back in the queue', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.insertCandidates([1, 2, 3, 4].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => 1_000 });
      await service.restore();
      jest.spyOn(repository, 'decide').mockResolvedValueOnce(null);

      await expect(service.decide(1, 'saved')).resolves.toBeNull();
      await expect(service.decide(2, 'dismissed')).resolves.toMatchObject({ imageId: 2 });
      expect(service.getDeck()).toMatchObject({
        active: { id: 3 },
        queued: [{ id: 4 }, { id: 1 }],
      });

      await service.decide(3, 'dismissed');
      await service.decide(4, 'dismissed');
      expect(service.getDeck()).toMatchObject({ active: { id: 1 }, queued: [] });
      await expect(service.decide(1, 'saved')).resolves.toMatchObject({ imageId: 1 });
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'saved' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a promoted decision writes the requested image id even if the re-read is stale', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      const service = createDiscoveryService({ repository, clock: () => 1_000 });
      await service.restore();
      const staleDeck = service.getDeck();
      jest.spyOn(repository, 'restoreDeck').mockResolvedValueOnce(staleDeck);
      const decide = jest.spyOn(repository, 'decide');

      await expect(service.decide(2, 'dismissed')).resolves.toMatchObject({ imageId: 2 });
      expect(decide).toHaveBeenCalledWith(2, 'dismissed', 1_000);
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'dismissed' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a decision fails without writing when its card cannot be promoted', async () => {
    const { nativeDatabase, repository } = await openRepository();
    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      const service = createDiscoveryService({ repository, clock: () => 1_000 });
      await service.restore();
      const beforeDeck = service.getDeck();
      const promote = jest.spyOn(repository, 'promoteForDecision').mockResolvedValueOnce(null);
      const decide = jest.spyOn(repository, 'decide');

      await expect(service.decide(2, 'dismissed')).resolves.toBeNull();
      expect(promote).toHaveBeenCalledWith(2, 1_000);
      expect(decide).not.toHaveBeenCalled();
      expect(service.getDeck()).toEqual(beforeDeck);
      expect(service.rewindDepth()).toBe(0);
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'active' });
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'queued' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('re-reads the deck when a refill replaces it during decide advance', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const releaseAdvance = deferred<void>();
    const advanceEntered = deferred<void>();
    let blockNextAdvance = true;
    try {
      await repository.insertCandidates([1, 2, 3, 4, 5].map((id) => candidate(id)));
      const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
        async () => ({ items: [], totalCount: 0 }),
      );
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 1_000 });
      await service.restore();

      const originalDecide = repository.decide.bind(repository);
      jest.spyOn(repository, 'decide')
        .mockImplementationOnce(async () => null)
        .mockImplementation((imageId, decision, decidedAt) => (
          originalDecide(imageId, decision, decidedAt)
        ));
      const originalActivateNext = repository.activateNext.bind(repository);
      jest.spyOn(repository, 'activateNext').mockImplementation(async (presentedAt) => {
        if (blockNextAdvance) {
          blockNextAdvance = false;
          advanceEntered.resolve();
          await releaseAdvance.promise;
        }
        return originalActivateNext(presentedAt);
      });

      await expect(service.decide(1, 'saved')).resolves.toBeNull();
      const deciding = service.decide(2, 'dismissed');
      await advanceEntered.promise;

      await expect(service.refill(DEFAULT_SETTINGS)).resolves.toMatchObject({
        status: 'exhausted',
        inserted: 0,
      });
      releaseAdvance.resolve();
      await expect(deciding).resolves.toMatchObject({
        imageId: 2,
        deck: {
          active: { id: 3 },
          queued: [{ id: 4 }, { id: 5 }, { id: 1 }],
        },
      });
      expect(service.getDeck()).toMatchObject({
        active: { id: 3 },
        queued: [{ id: 4 }, { id: 5 }, { id: 1 }],
      });
    } finally {
      releaseAdvance.resolve();
      nativeDatabase.close();
    }
  });

  test('captures the operation deck before a refill during its decide write', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const releaseDecide = deferred<void>();
    const decideWritten = deferred<void>();
    let blockSecondDecide = true;
    try {
      await repository.insertCandidates([1, 2, 3, 4, 5].map((id) => candidate(id)));
      const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
        async () => ({ items: [], totalCount: 0 }),
      );
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 1_000 });
      await service.restore();

      const originalDecide = repository.decide.bind(repository);
      jest.spyOn(repository, 'decide')
        .mockImplementationOnce(async () => null)
        .mockImplementation(async (imageId, decision, decidedAt) => {
          const result = await originalDecide(imageId, decision, decidedAt);
          if (imageId === 2 && blockSecondDecide) {
            blockSecondDecide = false;
            decideWritten.resolve();
            await releaseDecide.promise;
          }
          return result;
        });

      await expect(service.decide(1, 'saved')).resolves.toBeNull();
      const deciding = service.decide(2, 'dismissed');
      await decideWritten.promise;

      await expect(service.refill(DEFAULT_SETTINGS)).resolves.toMatchObject({
        status: 'exhausted',
        inserted: 0,
      });
      releaseDecide.resolve();
      await expect(deciding).resolves.toMatchObject({
        imageId: 2,
        deck: {
          active: { id: 3 },
          queued: [{ id: 4 }, { id: 5 }, { id: 1 }],
        },
      });
      expect(service.getDeck()).toMatchObject({
        active: { id: 3 },
        queued: [{ id: 4 }, { id: 5 }, { id: 1 }],
      });
    } finally {
      releaseDecide.resolve();
      nativeDatabase.close();
    }
  });

  test('a landed write whose advance throws stays rewindable and the next swipe writes its own card', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let now = 1_000;
    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      const service = createDiscoveryService({ repository, clock: () => now });
      await service.restore();
      jest.spyOn(repository, 'activateNext').mockRejectedValueOnce(new Error('disk I/O error'));
      await expect(service.decide(1, 'dismissed')).rejects.toThrow('disk I/O error');   // write landed at 1000
      expect(service.rewindDepth()).toBe(1);
      now = 2_000;
      await expect(service.decide(2, 'dismissed')).resolves.toMatchObject({ imageId: 2 });
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 2, decidedAt: 2_000 },
      });
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'active' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: a rewind has no time limit', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let now = 1_000;

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const service = createDiscoveryService({ repository, clock: () => now });
      await service.restore();
      await service.decide(1, 'dismissed');

      now += 60 * 60 * 1_000;                                    // an hour later
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 1, decision: 'dismissed' },
        deck: { active: { id: 1 }, queued: [{ id: 2 }] },
      });
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'active' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: stale entries are dropped inside the same press, and a later user action wins', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let now = 1_000;

    try {
      await repository.insertCandidates([1, 2, 3, 4, 5].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => now });
      const depths: number[] = [];
      service.subscribeRewindDepth((depth) => depths.push(depth));
      await service.restore();
      for (const [index, decision] of (['saved', 'dismissed', 'saved', 'dismissed'] as const).entries()) {
        await service.decide(index + 1, decision);               // 1 saved, 2 dismissed, 3 saved, 4 dismissed
        now += 10;
      }
      // 收藏 deletes after the swipes: entries 1 and 3 are stale now.
      await repository.deleteFromCollection(1);
      await repository.deleteFromCollection(3);

      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 4 },
      });
      // One press: the stale 3 is dropped and 2 is rewound.
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 2 },
        deck: { active: { id: 2 } },
      });
      // The stale 1 is dropped and nothing is left.
      await expect(service.rewind()).resolves.toMatchObject({ status: 'empty' });
      expect(service.rewindDepth()).toBe(0);
      expect(depths).toEqual([1, 2, 3, 4, 3, 2, 1, 0]);
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(repository.getById(3)).resolves.toMatchObject({ decision: 'dismissed' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: expect only ever looks at the top entry', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let now = 1_000;

    try {
      await repository.insertCandidates([1, 2, 3, 4].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => now });
      await service.restore();
      for (let index = 0; index < 3; index += 1) {
        await service.decide(index + 1, 'dismissed');             // 1, 2, 3
        now += 10;
      }

      // A different image on top: skipped, and nothing is popped.
      await expect(service.rewind({ imageId: 99 })).resolves.toEqual({ status: 'skipped' });
      expect(service.rewindDepth()).toBe(3);
      await expect(repository.getById(3)).resolves.toMatchObject({ decision: 'dismissed' });

      // The expected image on top: rewound.
      await expect(service.rewind({ imageId: 3 })).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 3 },
      });
      expect(service.rewindDepth()).toBe(2);

      // A stale expected entry is dropped alone; the older entry under it stays.
      await repository.saveCandidate(candidate(2), now);          // a Search save of 2
      await expect(service.rewind({ imageId: 2 })).resolves.toEqual({ status: 'skipped' });
      expect(service.rewindDepth()).toBe(1);
      await expect(repository.getById(1)).resolves.toMatchObject({ decision: 'dismissed' });
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'saved' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('board #32: an exclusive lease keeps the deck and the rewind history, so the next decision lands', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const coordinator = createDataResetCoordinator();

    try {
      await repository.insertCandidates([1, 2, 3].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => 500 }, coordinator);
      await service.restore();
      await service.decide(1, 'dismissed');
      expect(service.rewindDepth()).toBe(1);

      (await coordinator.beginExclusive()).release();

      expect(service.rewindDepth()).toBe(1);
      await expect(service.decide(2, 'saved')).resolves.toMatchObject({
        imageId: 2,
        decision: 'saved',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: delete-all clears the history and tells listeners', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const coordinator = createDataResetCoordinator();

    try {
      await repository.insertCandidates([1, 2, 3].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => 500 }, coordinator);
      const collection = createCollectionService({
        repository,
        files: createCollectionFileRepository(createEmptyFilePort()),
        coordinator,
      });
      const depths: number[] = [];
      service.subscribeRewindDepth((depth) => depths.push(depth));
      await service.restore();
      await service.decide(1, 'dismissed');
      await service.decide(2, 'dismissed');
      expect(service.rewindDepth()).toBe(2);
      depths.length = 0;

      await expect(collection.deleteAllData()).resolves.toMatchObject({ ok: true });
      expect(service.rewindDepth()).toBe(0);
      expect(depths).toEqual([0]);
      await expect(service.rewind()).resolves.toMatchObject({ status: 'empty' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: a settings invalidation clears the history, and its auto-dismiss records nothing', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([1, 2, 3, 4].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => 500 });
      const depths: number[] = [];
      service.subscribeRewindDepth((depth) => depths.push(depth));
      await service.restore();
      await service.decide(1, 'dismissed');
      await service.decide(2, 'dismissed');
      expect(service.rewindDepth()).toBe(2);
      depths.length = 0;

      // Waifu is switched off, so the active card 3 is retired by the auto-dismiss.
      await service.invalidateQueuedCandidates({
        ...DEFAULT_SETTINGS,
        providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
      });

      await expect(repository.getById(3)).resolves.toMatchObject({ decision: 'dismissed' });
      expect(service.rewindDepth()).toBe(0);
      expect(depths).toEqual([0]);
      await expect(service.rewind()).resolves.toMatchObject({ status: 'empty' });
      await expect(repository.getById(2)).resolves.toMatchObject({ decision: 'dismissed' });
    } finally {
      nativeDatabase.close();
    }
  });

  test('a refused write records nothing, but a landed write stays rewindable when advance fails', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([1, 2, 3].map((id) => candidate(id)));
      const service = createDiscoveryService({ repository, clock: () => 500 });
      const depths: number[] = [];
      service.subscribeRewindDepth((depth) => depths.push(depth));
      await service.restore();

      jest.spyOn(repository, 'decide').mockResolvedValueOnce(null);
      await expect(service.decide(1, 'dismissed')).resolves.toBeNull();
      // The write lands but the deck cannot advance, so the decide still fails.
      jest.spyOn(repository, 'activateNext').mockRejectedValueOnce(new Error('disk I/O error'));
      await expect(service.decide(1, 'dismissed')).rejects.toThrow('disk I/O error');

      expect(service.rewindDepth()).toBe(1);
      expect(depths).toEqual([1]);
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 1, decision: 'dismissed' },
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: rewinding a save reverts its collection files, then purges its library copy, in the background', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const events: string[] = [];
    const revertGate = deferred<void>();
    const collection: DiscoveryCollectionPort = {
      retryDownload: jest.fn(async () => ({ status: 'ready' as const })),
      revertPendingSave: jest.fn(async (image: StoredImage) => {
        events.push(`revert:${image.id}:${(await repository.getById(image.id))?.decision}`);
        await revertGate.promise;
      }),
    };
    const library: DiscoveryLibraryPort = {
      purgeCollectedImage: jest.fn(async (imageId: number) => {
        events.push(`purge:${imageId}:${(await repository.getById(imageId))?.decision}`);
      }),
    };

    try {
      await repository.insertCandidates([candidate(1), candidate(2), candidate(3)]);
      const service = createDiscoveryService({
        repository,
        collection,
        library,
        clock: () => 1_000,
      });
      await service.restore();
      await service.decide(1, 'saved');                           // 1
      await service.decide(2, 'dismissed');                       // 2

      await expect(service.rewind()).resolves.toMatchObject({
        entry: { imageId: 2, decision: 'dismissed' },
      });
      // The card is back at once; its removal is still running.
      await expect(service.rewind()).resolves.toMatchObject({
        status: 'rewound',
        entry: { imageId: 1, decision: 'saved' },
        deck: { active: { id: 1 } },
      });
      await settle(() => events.length > 0);
      expect(collection.revertPendingSave).toHaveBeenCalledTimes(1);
      expect(collection.revertPendingSave).toHaveBeenCalledWith(expect.objectContaining({
        id: 1,
        decision: 'saved',
        downloadState: 'pending',
      }));                                                        // the row before the rewind
      expect(library.purgeCollectedImage).not.toHaveBeenCalled();

      revertGate.resolve();
      await settle(() => events.length > 1);
      expect(events).toEqual(['revert:1:active', 'purge:1:active']);
      expect(library.purgeCollectedImage).toHaveBeenCalledTimes(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('row24: a Discover re-save waits for the removal still in flight, and an older removal settling does not release it', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const purgeGates = [deferred<void>(), deferred<void>()];
    let purgeCalls = 0;
    const collection: DiscoveryCollectionPort = {
      retryDownload: jest.fn(async () => ({ status: 'ready' as const })),
      revertPendingSave: jest.fn(async () => undefined),
    };
    const library: DiscoveryLibraryPort = {
      purgeCollectedImage: jest.fn(() => {
        const gate = purgeGates[purgeCalls];
        purgeCalls += 1;
        return gate!.promise;
      }),
    };

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      let now = 1_000;
      const service = createDiscoveryService({
        repository,
        collection,
        library,
        clock: () => now,
      });
      await service.restore();
      const first = await service.decide(1, 'saved');
      await first!.backgroundDownload;
      expect(collection.retryDownload).toHaveBeenCalledTimes(1);

      await service.rewind();                                    // removal A: its purge is held
      await settle(() => purgeCalls === 1);
      now += 10;
      const second = await service.decide(1, 'saved');            // resolves at once...
      expect(second).toMatchObject({ imageId: 1, decision: 'saved' });
      await settle(() => false, 5);
      expect(collection.retryDownload).toHaveBeenCalledTimes(1); // ...but its download waits for A

      await service.rewind();                                    // removal B, while A is still held
      await settle(() => purgeCalls === 2);
      purgeGates[0]!.resolve();                                  // A settles
      await second!.backgroundDownload;
      expect(collection.retryDownload).toHaveBeenCalledTimes(2);

      now += 10;
      const third = await service.decide(1, 'saved');
      await settle(() => false, 5);
      expect(collection.retryDownload).toHaveBeenCalledTimes(2); // A's settling left B's wait alone

      purgeGates[1]!.resolve();
      await third!.backgroundDownload;
      expect(collection.retryDownload).toHaveBeenCalledTimes(3);
      expect(collection.retryDownload).toHaveBeenLastCalledWith(1);
    } finally {
      nativeDatabase.close();
    }
  });

  test('publishes a pending save immediately and settles its private file in the background', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let now = 1_000;
    let finishDownload!: () => Promise<void>;
    const collection: DiscoveryCollectionPort = {
      retryDownload: jest.fn(
        () => new Promise((resolve) => {
          finishDownload = async () => {
            now = 2_000;
            await repository.markDownloadReady(
              1,
              'file:///documents/collection/1.webp',
              {
                remoteUrl: candidate(1).remoteUrl,
                extension: candidate(1).extension,
              },
            );
            resolve({ status: 'ready' });
          };
        }),
      ),
      revertPendingSave: jest.fn(async () => undefined),
    };

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const service = createDiscoveryService({
        repository,
        collection,
        clock: () => now,
      });
      await service.restore();

      const decision = await service.decide(1, 'saved');
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'pending',
      });
      expect(collection.retryDownload).toHaveBeenCalledWith(1);
      expect(decision).toMatchObject({
        imageId: 1,
        decision: 'saved',
        deck: { active: { id: 2 } },
        backgroundDownload: expect.any(Promise),
      });

      await finishDownload();
      await decision!.backgroundDownload;
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'ready',
        localUri: 'file:///documents/collection/1.webp',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('keeps the saved decision when background persistence rejects', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const failure = new Error('database unavailable while marking ready');
    const collection: DiscoveryCollectionPort = {
      retryDownload: jest.fn().mockRejectedValue(failure),
      revertPendingSave: jest.fn(async () => undefined),
    };

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const service = createDiscoveryService({ repository, collection });
      await service.restore();

      const decision = await service.decide(1, 'saved');
      await expect(decision!.backgroundDownload).resolves.toEqual({ status: 'failed' });

      expect(service.getDeck()).toMatchObject({
        active: { id: 2, decision: 'active' },
      });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'saved',
        downloadState: 'pending',
        localUri: null,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('advances the deck when private persistence reports failure', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const collection: DiscoveryCollectionPort = {
      retryDownload: jest.fn().mockResolvedValue({ status: 'failed' }),
      revertPendingSave: jest.fn(async () => undefined),
    };

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const service = createDiscoveryService({ repository, collection });
      await service.restore();

      const decision = await service.decide(1, 'saved');
      await expect(decision!.backgroundDownload).resolves.toEqual({ status: 'failed' });
      expect(service.getDeck()).toMatchObject({
        active: { id: 2, decision: 'active' },
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('keeps a non-Waifu active card when only a Waifu-scoped tag is retained', async () => {
    const { nativeDatabase, database, repository } = await openRepository();

    try {
      await repository.insertCandidates([
        candidate(1, { providerKey: 'nekos_api', providerItemId: 'nekos-1' }),
        candidate(2),
        candidate(3),
      ]);
      const service = createDiscoveryService({ repository });
      await service.restore();

      await expect(service.invalidateQueuedCandidates({
        ...DEFAULT_SETTINGS,
        providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
        includedTags: ['waifu', 'raiden-shogun'],
      })).resolves.toBe(2);
      expect(service.getDeck()).toMatchObject({ active: { id: 1 }, queued: [] });

      const reconstructed = createDiscoveryService({
        repository: createImageRepository(database),
      });
      await expect(reconstructed.restore()).resolves.toMatchObject({
        active: { id: 1 },
        queued: [],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('retires an active card when its provider is disabled', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const service = createDiscoveryService({ repository, clock: () => 500 });
      await service.restore();

      await service.invalidateQueuedCandidates({
        ...DEFAULT_SETTINGS,
        providers: { waifu_im: false, nekos_api: true, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
      });

      expect(service.getDeck()).toEqual({ active: null, queued: [] });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'dismissed',
        decidedAt: 500,
      });
      await expect(repository.getById(2)).resolves.toBeNull();
    } finally {
      nativeDatabase.close();
    }
  });

  test('retires an active NSFW card when settings return to SFW', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      await repository.insertCandidates([candidate(1, { isNsfw: true })]);
      const service = createDiscoveryService({ repository, clock: () => 700 });
      await service.restore();

      await service.invalidateQueuedCandidates(DEFAULT_SETTINGS);

      expect(service.getDeck()).toEqual({ active: null, queued: [] });
      await expect(repository.getById(1)).resolves.toMatchObject({
        decision: 'dismissed',
        decidedAt: 700,
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('aborts and drains an old-generation refill before deleting queued rows', async () => {
    const { nativeDatabase, repository } = await openRepository();
    let resolveBatch!: (value: { items: WaifuImage[]; totalCount: number }) => void;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      () => new Promise((resolve) => {
        resolveBatch = resolve;
      }),
    );

    try {
      await repository.insertCandidates([candidate(1), candidate(2)]);
      const deleteQueued = jest.spyOn(repository, 'deleteQueuedCandidates');
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const refill = service.refill(DEFAULT_SETTINGS);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const invalidation = service.invalidateQueuedCandidates();

      expect(fetchBatch.mock.calls[0][0].signal?.aborted).toBe(true);
      expect(deleteQueued).not.toHaveBeenCalled();
      resolveBatch({ items: [candidate(10), candidate(11)], totalCount: 2 });

      await expect(refill).resolves.toMatchObject({ status: 'invalidated', inserted: 0 });
      await expect(invalidation).resolves.toBe(1);
      expect(deleteQueued).toHaveBeenCalledTimes(1);
      await expect(repository.getById(10)).resolves.toBeNull();
      await expect(repository.restoreDeck()).resolves.toMatchObject({
        active: { id: 1 },
        queued: [],
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('holds discovery behind data reset and prevents an old refill from repopulating SQLite', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const coordinator = createDataResetCoordinator();
    let resolveOldBatch!: (value: { items: WaifuImage[]; totalCount: number }) => void;
    let fetchCalls = 0;
    const fetchBatch = jest.fn<ReturnType<DiscoveryBatchFetcher>, Parameters<DiscoveryBatchFetcher>>(
      () => {
        fetchCalls += 1;
        const call = fetchCalls;
        if (call === 1) {
          return new Promise((resolve) => {
            resolveOldBatch = resolve;
          });
        }
        const id = call <= 3 ? 10 : 20 + call;
        return Promise.resolve({ items: [candidate(id)], totalCount: 1 });
      },
    );
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const settings = { reset: jest.fn(() => settingsGate) };
    const discovery = createDiscoveryService({ repository, fetchBatch, clock: () => 300 }, coordinator);
    const collection = createCollectionService({
      repository,
      files: createCollectionFileRepository(createEmptyFilePort()),
      settings,
      coordinator,
    });
    const decide = jest.spyOn(repository, 'decide');

    try {
      await discovery.restore();
      const oldRefill = discovery.refill(DEFAULT_SETTINGS);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const reset = collection.deleteAllData();
      await new Promise((resolve) => setTimeout(resolve, 0));

      resolveOldBatch({ items: [candidate(10)], totalCount: 1 });
      const oldResult = await oldRefill;
      while (settings.reset.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const staleRowDuringReset = await repository.getById(10);
      const callsBeforeQueuedWork = fetchBatch.mock.calls.length;
      const queuedRefill = discovery.refill(DEFAULT_SETTINGS);
      const queuedDecision = discovery.decide(1, 'dismissed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const callsWhileResetHeld = fetchBatch.mock.calls.length;
      const decisionsWhileResetHeld = decide.mock.calls.length;

      releaseSettings();
      await reset;
      const [queuedRefillResult, queuedDecisionResult] = await Promise.all([
        queuedRefill,
        queuedDecision,
      ]);

      expect(staleRowDuringReset).toBeNull();
      expect(oldResult).toEqual({
        status: 'invalidated',
        inserted: 0,
        deck: { active: null, queued: [] },
      });
      expect(callsBeforeQueuedWork).toBe(1);
      expect(callsWhileResetHeld).toBe(1);
      expect(decisionsWhileResetHeld).toBe(0);
      expect(fetchBatch.mock.calls.length).toBeGreaterThan(1);
      expect(queuedDecisionResult).toBeNull();
      expect(decide).not.toHaveBeenCalled();
      expect(queuedRefillResult.deck).toEqual(discovery.getDeck());
    } finally {
      releaseSettings();
      nativeDatabase.close();
    }
  });
});

describe('DiscoveryService yield ledger (G3b accounting, read by the G3c balancer)', () => {
  test('records one round per enabled provider, including skipped and failed sources', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const yieldLedger = createProviderYieldLedger();
    const fetchBatch = jest.fn<
      ReturnType<DiscoveryBatchFetcher>,
      Parameters<DiscoveryBatchFetcher>
    >(async () => ({
      items: [
        candidate(1),
        candidate(2),
        candidate(5),
        candidate(3, { providerKey: 'danbooru', providerItemId: '3' }),
        candidate(4, { providerKey: 'danbooru', providerItemId: '4' }),
        candidate(6, { providerKey: 'danbooru', providerItemId: '6' }),
      ],
      totalCount: 11,
      providerRounds: [
        {
          providerKey: 'waifu_im',
          requested: 6,
          returned: 6,
          admitted: 3,
          outcome: 'ok',
        },
        {
          providerKey: 'danbooru',
          requested: 6,
          returned: 6,
          admitted: 3,
          outcome: 'ok',
        },
        {
          providerKey: 'e621',
          requested: 2,
          returned: 0,
          admitted: 0,
          outcome: 'failed',
        },
        {
          providerKey: 'e926',
          requested: 2,
          returned: 0,
          admitted: 0,
          outcome: 'cooldown',
        },
        {
          providerKey: 'konachan',
          requested: 0,
          returned: 0,
          admitted: 0,
          outcome: 'skipped_capability',
        },
      ],
    }));

    try {
      const service = createDiscoveryService({
        repository,
        fetchBatch,
        clock: () => 300,
        yieldLedger,
      });
      await service.restore();

      // The first-paint batch targets DISCOVERY_FIRST_PAINT_BATCH + 1 = 6, and
      // the single batch delivers 6 items, so exactly one refill round runs.
      await service.refill(DEFAULT_SETTINGS);

      expect(fetchBatch).toHaveBeenCalledTimes(1);
      const stats = yieldLedger.stats();
      expect(stats.get('waifu_im')).toEqual({
        requested: 6,
        admitted: 3,
        inserted: 3,
        consecutiveZeroRounds: 0,
        lastOutcome: 'ok',
      });
      expect(stats.get('danbooru')).toEqual({
        requested: 6,
        admitted: 3,
        inserted: 3,
        consecutiveZeroRounds: 0,
        lastOutcome: 'ok',
      });
      expect(stats.get('e621')).toEqual({
        requested: 2,
        admitted: 0,
        inserted: 0,
        consecutiveZeroRounds: 0,
        lastOutcome: 'failed',
      });
      expect(stats.get('e926')?.lastOutcome).toBe('cooldown');
      // The capability gate skipped Konachan before any request: it is present
      // with a zero share, not silently absent.
      expect(stats.get('konachan')).toEqual({
        requested: 0,
        admitted: 0,
        inserted: 0,
        consecutiveZeroRounds: 0,
        lastOutcome: 'skipped_capability',
      });
      // Sources that are not part of the round are not invented.
      expect(stats.has('nekos_api')).toBe(false);
    } finally {
      nativeDatabase.close();
    }
  });

  test('accumulates rounds and exposes the per-source insert blind spot the global counter hides', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const yieldLedger = createProviderYieldLedger();
    // Danbooru re-offers the same post every round after the first, so it
    // inserts nothing while Waifu keeps contributing. `duplicateOnlyAttempts`
    // stays 0 the whole time (the deck does grow), which is exactly the blind
    // spot the per-provider ledger exists to remove: the rolling `inserted`
    // sum separates the two sources even though both answered every round.
    let nextWaifuId = 100;
    const round = (): Awaited<ReturnType<DiscoveryBatchFetcher>> => ({
      items: [
        candidate(nextWaifuId++),
        candidate(50, { providerKey: 'danbooru', providerItemId: '50' }),
      ],
      totalCount: 8,
      providerRounds: [
        {
          providerKey: 'waifu_im',
          requested: 2,
          returned: 4,
          admitted: 1,
          outcome: 'ok',
        },
        {
          providerKey: 'danbooru',
          requested: 2,
          returned: 4,
          admitted: 1,
          outcome: 'ok',
        },
      ],
    });
    const fetchBatch = jest.fn<
      ReturnType<DiscoveryBatchFetcher>,
      Parameters<DiscoveryBatchFetcher>
    >(async () => round());

    try {
      const service = createDiscoveryService({
        repository,
        fetchBatch,
        clock: () => 300,
        yieldLedger,
      });
      await service.restore();

      const result = await service.refill(DEFAULT_SETTINGS);

      // G3c Task 3: two rounds instead of three (spec §2.3), so every rolling
      // sum below is one round smaller. The asymmetry this test exists to show
      // — Waifu inserting every round while Danbooru re-offers one duplicate —
      // is unchanged.
      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(result.status).toBe('ready');
      const stats = yieldLedger.stats();
      expect(stats.get('waifu_im')).toEqual({
        requested: 4,
        admitted: 2,
        inserted: 2,
        consecutiveZeroRounds: 0,
        lastOutcome: 'ok',
      });
      expect(stats.get('danbooru')).toEqual({
        requested: 4,
        admitted: 2,
        inserted: 1,
        // F1 (G3c Task 1): the quiet run counts zero-*admit* rounds, not
        // zero-insert rounds. Danbooru admitted a usable post every round and
        // downstream dedupe discarded it, which is not the source going quiet
        // — an inserted-based run would let the balancer punish a source for
        // dedupe and truncation it does not control. The duplicate-only
        // behaviour is still visible here, in the rolling `inserted` sum.
        consecutiveZeroRounds: 0,
        lastOutcome: 'ok',
      });
    } finally {
      nativeDatabase.close();
    }
  });

  test('feeds each round its own ledger snapshot and never resets the window (G3c)', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const yieldLedger = createProviderYieldLedger();
    const statsSpy = jest.spyOn(yieldLedger, 'stats');
    const reset = jest.spyOn(yieldLedger, 'reset');
    const seen: (ReadonlyMap<ImageProviderKey, ProviderYieldStat> | undefined)[] = [];
    let nextId = 500;
    const fetchBatch = jest.fn<
      ReturnType<DiscoveryBatchFetcher>,
      Parameters<DiscoveryBatchFetcher>
    >(async ({ yieldStats }) => {
      seen.push(yieldStats);
      return {
        items: [candidate(nextId++)],
        totalCount: 1,
        providerRounds: [
          {
            providerKey: 'waifu_im' as const,
            requested: 4,
            returned: 4,
            admitted: 1,
            outcome: 'ok' as const,
          },
          // Answered HTTP 200 with nothing this filter can use: the quiet
          // signal the next round's share plan has to be able to see.
          {
            providerKey: 'e621' as const,
            requested: 2,
            returned: 3,
            admitted: 0,
            outcome: 'ok' as const,
          },
        ],
      };
    });

    try {
      const service = createDiscoveryService({
        repository,
        fetchBatch,
        clock: () => 300,
        yieldLedger,
      });
      await service.restore();
      // Two fresh items per round -> both allowed rounds run before the
      // first-paint target is reached.
      await service.refill(DEFAULT_SETTINGS);

      expect(fetchBatch).toHaveBeenCalledTimes(2);
      expect(statsSpy).toHaveBeenCalledTimes(2);
      // Round 1 is a cold start: no evidence, so `planProviderShares` plans
      // uniformly — today's behaviour, unchanged.
      expect(seen[0]?.size).toBe(0);
      // Round 2 sees round 1, so the balancer is genuinely live in production
      // rather than permanently cold-started.
      expect(seen[1]?.get('waifu_im')).toEqual({
        requested: 4,
        admitted: 1,
        inserted: 1,
        consecutiveZeroRounds: 0,
        lastOutcome: 'ok',
      });
      expect(seen[1]?.get('e621')).toEqual({
        requested: 2,
        admitted: 0,
        inserted: 0,
        consecutiveZeroRounds: 1,
        lastOutcome: 'ok',
      });
      // A snapshot, not a live view: round 1's map did not grow underneath the
      // fetcher after the round was recorded.
      expect(seen[0]?.size).toBe(0);
      expect(seen[0]).not.toBe(seen[1]);
      // The window is never cleared mid-session; only a new process starts cold.
      expect(reset).not.toHaveBeenCalled();
    } finally {
      statsSpy.mockRestore();
      reset.mockRestore();
      nativeDatabase.close();
    }
  });

  test('a batch without accounting metadata records nothing rather than guessing', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const yieldLedger = createProviderYieldLedger();
    const fetchBatch = jest.fn<
      ReturnType<DiscoveryBatchFetcher>,
      Parameters<DiscoveryBatchFetcher>
    >(async () => ({
      items: [candidate(1), candidate(2), candidate(3), candidate(4)],
      totalCount: 4,
    }));

    try {
      const service = createDiscoveryService({
        repository,
        fetchBatch,
        clock: () => 300,
        yieldLedger,
      });
      await service.restore();
      await service.refill(DEFAULT_SETTINGS);

      expect(yieldLedger.stats().size).toBe(0);
    } finally {
      nativeDatabase.close();
    }
  });
});

describe('DiscoveryService stratified fairness interleave (G3c)', () => {
  function longestRun(keys: readonly (ImageProviderKey | undefined)[]): number {
    let longest = 0;
    let current = 0;
    let previous: ImageProviderKey | undefined;
    for (const key of keys) {
      current = key === previous ? current + 1 : 1;
      previous = key;
      if (current > longest) longest = current;
    }
    return longest;
  }

  /** The hybrid interleave's hard bound (spec §2.6, second amendment). */
  function forcedRunBound(counts: readonly number[]): number {
    const biggest = Math.max(...counts);
    const rest = counts.reduce((sum, count) => sum + count, 0) - biggest;
    return Math.max(
      DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
      Math.ceil(biggest / (rest + 1)),
    );
  }

  const deckKeys = (deck: { active: WaifuImage | null; queued: WaifuImage[] }) =>
    [deck.active, ...deck.queued].map((image) => image?.providerKey);

  test('no source monopolises the persisted queue_ordinal order while another has cards', async () => {
    const { nativeDatabase, repository } = await openRepository();
    // Worst case for the old path: the merge tail is one solid provider run.
    const batchItems: ImageCandidate[] = [
      ...Array.from({ length: 7 }, (_, index) =>
        candidate(600 + index, { providerItemId: `w-${index}` })),
      ...Array.from({ length: 5 }, (_, index) =>
        candidate(700 + index, {
          providerKey: 'danbooru',
          providerItemId: `d-${index}`,
        })),
    ];
    const fetchBatch = jest.fn<
      ReturnType<DiscoveryBatchFetcher>,
      Parameters<DiscoveryBatchFetcher>
    >(async () => ({ items: [...batchItems], totalCount: batchItems.length }));

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      // warmReserve targets prefetchDepth (40), so all 12 cards are kept and
      // the whole persisted order is under test.
      const result = await service.warmReserve(DEFAULT_SETTINGS);

      expect(batchItems).toHaveLength(12);
      expect(longestRun(batchItems.map((item) => item.providerKey))).toBe(7);
      const keys = deckKeys(result.deck);
      expect(keys).toHaveLength(12);
      // {7, 5}: nothing is forced, so the bound is the cap itself — literally
      // no three-in-a-row anywhere in queue_ordinal.
      expect(forcedRunBound([7, 5])).toBe(DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER);
      expect(longestRun(keys)).toBeLessThanOrEqual(DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER);
      // Proportions are preserved: fairness patterns the deck, it does not
      // equalise the sources.
      expect(keys.filter((key) => key === 'waifu_im')).toHaveLength(7);
      expect(keys.filter((key) => key === 'danbooru')).toHaveLength(5);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a forced run at the extreme of a lean deck stays at the mathematical minimum', async () => {
    const { nativeDatabase, repository } = await openRepository();
    const batchItems: ImageCandidate[] = [
      ...Array.from({ length: 9 }, (_, index) =>
        candidate(800 + index, { providerItemId: `w-${index}` })),
      ...Array.from({ length: 3 }, (_, index) =>
        candidate(900 + index, {
          providerKey: 'e621',
          providerItemId: `e-${index}`,
        })),
    ];
    const fetchBatch = jest.fn<
      ReturnType<DiscoveryBatchFetcher>,
      Parameters<DiscoveryBatchFetcher>
    >(async () => ({ items: [...batchItems], totalCount: batchItems.length }));

    try {
      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      const result = await service.warmReserve(DEFAULT_SETTINGS);

      const keys = deckKeys(result.deck);
      // {9, 3}: three breakers cut nine cards into four groups, so a run of 3
      // is unavoidable. The deck is that lean — honest, not a defect — and the
      // interleave still reaches the minimum rather than leaving a run of 9.
      expect(forcedRunBound([9, 3])).toBe(3);
      expect(longestRun(keys)).toBeLessThanOrEqual(forcedRunBound([9, 3]));
      expect(keys.filter((key) => key === 'e621')).toHaveLength(3);
    } finally {
      nativeDatabase.close();
    }
  });

  test('a duplicate sitting between two waifu runs does not let them join once it is suppressed (G3c Task 4)', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      // A pre-existing, already-dismissed row the batch's yandere card will
      // collide with by canonical source key. It exists purely as the
      // identity gate's collision target -- dismissed so it never itself sits
      // in the deck under test.
      await repository.insertCandidates([
        candidate(9_000, {
          providerKey: 'yandere',
          providerItemId: 'y-seed',
          canonicalSourceKey: 'yandere:dup-1',
        }),
      ]);
      await repository.activateNext(1);
      await repository.decide(9_000, 'dismissed', 2);

      // Six waifu cards, two danbooru cards, and one yandere card that dedupes
      // against the seed above. Nothing reorders within a bucket, so each
      // keeps this merge order, and `orderBatchForDeck` (cap 2, spec §2.6)
      // places the lone yandere card between two runs of waifu cards --
      // reproducible directly from `interleaveWithRunCap` for the shape
      // {waifu_im: 6, danbooru: 2, yandere: 1}, independent of this service.
      const batchItems: ImageCandidate[] = [
        candidate(601), candidate(602),
        candidate(701, { providerKey: 'danbooru' }),
        candidate(603),
        candidate(900, { providerKey: 'yandere', canonicalSourceKey: 'yandere:dup-1' }),
        candidate(604), candidate(605),
        candidate(702, { providerKey: 'danbooru' }),
        candidate(606),
      ];
      const fetchBatch = jest.fn<
        ReturnType<DiscoveryBatchFetcher>,
        Parameters<DiscoveryBatchFetcher>
      >(async () => ({ items: [...batchItems], totalCount: batchItems.length }));

      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();

      // warmReserve targets prefetchDepth (40), so nothing is truncated ahead of the
      // identity gate: the offered order is the interleave over all 9 cards,
      // with the yandere duplicate sitting between two waifu cards. Before the
      // fix, deleting that card in place (instead of re-spreading the eight
      // survivors) would merge them into a run of 3 -- above the {waifu: 6,
      // danbooru: 2} bound of 2.
      const result = await service.warmReserve(DEFAULT_SETTINGS);

      // The duplicate never lands: 8 of the 9 offered cards are inserted.
      expect(result).toMatchObject({ status: 'ready', inserted: 8 });

      const keys = deckKeys(result.deck);
      expect(keys).toHaveLength(8);
      expect(keys.filter((key) => key === 'waifu_im')).toHaveLength(6);
      expect(keys.filter((key) => key === 'danbooru')).toHaveLength(2);
      expect(keys.filter((key) => key === 'yandere')).toHaveLength(0);
      expect(forcedRunBound([6, 2])).toBe(DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER);
      // The hole did not join the runs: the persisted queue_ordinal order is
      // re-spread over the survivors, not the offered batch with a gap in it.
      expect(longestRun(keys)).toBeLessThanOrEqual(forcedRunBound([6, 2]));

      const ids = [result.deck.active, ...result.deck.queued]
        .map((image) => image?.providerItemId);
      expect(ids).toEqual(['601', '602', '701', '603', '604', '702', '605', '606']);
    } finally {
      nativeDatabase.close();
    }
  });

  test('Task 5 device regression: a refill behind a leftover active card honours the bound', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      // The device state the all-sources smoke hit: a discovery-affecting
      // settings change invalidates the queue, which deletes the queued rows but
      // keeps the *active* card. The next refill appends at
      // `MAX(queue_ordinal) + 1` — behind one surviving waifu card.
      await repository.insertCandidates([
        candidate(2330, { providerItemId: 'w-2330' }),
        candidate(2331, { providerItemId: 'w-2331' }),
      ]);
      await repository.activateNext(100);
      await repository.deleteQueuedCandidates();

      const deckBefore = await repository.restoreDeck();
      expect(deckBefore.queued).toHaveLength(0);
      expect(deckBefore.active?.providerKey).toBe('waifu_im');

      // A waifu-lean batch, the shape the device actually fetched. On its own an
      // opening 2-run of waifu is legal; behind the leftover card it persists 3.
      const batchItems: ImageCandidate[] = [
        ...Array.from({ length: 6 }, (_unused, index) =>
          candidate(6400 + index, { providerItemId: `w-${6400 + index}` })),
        candidate(8010, { providerKey: 'danbooru', providerItemId: 'd-8010' }),
        candidate(8011, { providerKey: 'danbooru', providerItemId: 'd-8011' }),
        candidate(9010, { providerKey: 'yandere', providerItemId: 'y-9010' }),
      ];

      const fetchBatch = jest.fn<
        ReturnType<DiscoveryBatchFetcher>,
        Parameters<DiscoveryBatchFetcher>
      >(async () => ({ items: batchItems, totalCount: batchItems.length }));

      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();
      const result = await service.warmReserve(DEFAULT_SETTINGS);

      // Round 2 re-offers the same nine cards and the identity gate suppresses
      // every one, so the deck is the leftover card plus this batch.
      expect(result).toMatchObject({ status: 'ready', inserted: 9 });

      // Measured on the persisted deck, leftover card included — the sequence the
      // user actually scrolls, which is where the smoke read `W W W`.
      const keys = deckKeys(result.deck);
      expect(keys).toHaveLength(10);
      expect(keys[0]).toBe('waifu_im');
      expect(longestRun(keys)).toBeLessThanOrEqual(
        DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
      );
    } finally {
      nativeDatabase.close();
    }
  });

  test('the survivor re-spread also sees the deck tail (both halves of the seam fix)', async () => {
    const { nativeDatabase, repository } = await openRepository();

    try {
      // A deck whose tail is already a full 2-run of waifu. The batch below
      // carries a duplicate, so the identity gate shrinks it and the SURVIVOR
      // re-spread — not the offered order — decides what persists. A survivor
      // re-spread blind to the tail puts waifu first (the proportional spread's
      // natural choice for {waifu: 2, danbooru: 1}) and persists a run of 3;
      // the drift review found this half of bf4d899 unguarded by any test.
      await repository.insertCandidates([
        candidate(2330, { providerItemId: 'w-2330' }),
        candidate(2331, { providerItemId: 'w-2331' }),
      ]);
      await repository.activateNext(100);

      const batchItems: ImageCandidate[] = [
        candidate(6501, { providerItemId: 'w-6501' }),
        candidate(6502, { providerItemId: 'w-6502' }),
        // Duplicate of the seeded active card: suppressed at insert.
        candidate(6503, { providerItemId: 'w-2330' }),
        candidate(8020, { providerKey: 'danbooru', providerItemId: 'd-8020' }),
      ];
      const fetchBatch = jest.fn<
        ReturnType<DiscoveryBatchFetcher>,
        Parameters<DiscoveryBatchFetcher>
      >(async () => ({ items: batchItems, totalCount: batchItems.length }));

      const service = createDiscoveryService({ repository, fetchBatch, clock: () => 300 });
      await service.restore();
      const result = await service.warmReserve(DEFAULT_SETTINGS);

      // 3 of the 4 offered cards land, so the survivor callback really ran.
      expect(result).toMatchObject({ status: 'ready', inserted: 3 });

      const keys = deckKeys(result.deck);
      expect(keys).toHaveLength(5);
      expect(keys[0]).toBe('waifu_im');
      expect(keys[1]).toBe('waifu_im');
      expect(longestRun(keys)).toBeLessThanOrEqual(
        DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
      );
    } finally {
      nativeDatabase.close();
    }
  });
});
