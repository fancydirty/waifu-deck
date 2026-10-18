import type { DataResetCoordinator } from '@/features/data-reset/data-reset-coordinator';
import type {
  AppliedDecision,
  ImageRepository,
  RestoredDeck,
  StoredImage,
} from '@/features/images/image-repository';
import {
  fetchDiscoveryBatch,
  type DiscoveryBatch,
  type DiscoverySourceDelivery,
  type FetchDiscoveryBatchInput,
  type ProviderExclusions,
} from '@/features/providers/provider-client';
import { matchesCandidateSettings } from '@/features/providers/candidate-filter';
import { traceProviderRounds } from '@/features/discovery/discovery-round-trace';
import { interleaveWithRunCap } from '@/features/providers/provider-balancer';
import {
  createProviderYieldLedger,
  PROVIDER_YIELD_WINDOW_ROUNDS,
  type ProviderYieldLedger,
} from '@/features/providers/provider-yield-ledger';
import type {
  AppSettings,
  ImageCandidate,
  ImageProviderKey,
} from '@/features/waifu/types';

export const DISCOVERY_LOW_WATER_MARK = 2;
/**
 * Redesign 2026-09-15: the first-paint refill batch. Was the per-settings
 * first-paint count field (3/5/8/12, default 5) but that field had no settings
 * UI since R8.20 moved the visible control to `prefetchDepth`. Frozen to the
 * old default.
 */
export const DISCOVERY_FIRST_PAINT_BATCH = 5;
// R8.20 (owner 2026-09-09): the reserve follows the user-visible
// `prefetchDepth` (30/40/60) so every image-warmed card has a row behind it,
// and the deck never runs dry into 「正在加载」. The default user used to top
// out at 15. Sample-sized prefetch (R8.18) makes a buffer this deep cheap to
// warm. Deck jank 2026-09-17: the reserve no longer re-warms after every
// swipe — the hook arms it only once depth drains to
// `discoveryReserveLowWater(target)` (half the target), then one round refills
// back to target. The internal first-paint batch (`refill`,
// DISCOVERY_FIRST_PAINT_BATCH + 1) is unchanged — the G3 §6.3 fairness gate is
// calibrated on it.
export const DISCOVERY_RESERVE_MIN = 30;
export const DISCOVERY_RESERVE_MAX = 60;
/**
 * G3 spec §2.3 — 3 → 2 (G3c Task 3).
 *
 * The third blind round was the only compensation the old design had for a
 * short batch: re-ask *everyone*, including the source that just failed. G3c
 * Task 2 replaced it with one bounded top-up wave aimed only at the sources
 * that were capped and succeeded, so this loop drops a round to keep the total
 * request volume flat. Fewer wasted requests, same target depth.
 */
export const MAX_REFILL_BATCHES = 2;
/**
 * Kept equal to {@link MAX_REFILL_BATCHES} — that equality, not the literal 3,
 * was always the semantic: *every* batch this refill was allowed to fetch came
 * back duplicate-only, so there is nothing left to find and the round reports
 * `exhausted`. Leaving it at 3 while the loop can only run twice would make the
 * `>=` test below permanently false, silently downgrading that outcome to
 * `ready` — which `startRefill` then treats as licence to escalate into another
 * refill, i.e. more requests, the opposite of what §2.3 is buying.
 */
export const MAX_DUPLICATE_ONLY_ATTEMPTS = 2;
/**
 * G3 spec §2.6 — how many cards one source may occupy back-to-back in the
 * persisted deck order (`queue_ordinal`).
 *
 * 2, not 1: strict alternation would be a metronome and would fight a genuine
 * provider lean, which the load balancer deliberately allows. 2 removes only
 * the monopoly streak. A longer run survives when it is mathematically forced
 * (see `interleaveWithRunCap` — the deck is simply that lean), which is honest.
 */
export const DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER = 2;

export function discoveryRefillThreshold(batchSize: number): number {
  return Math.max(
    DISCOVERY_LOW_WATER_MARK,
    Math.ceil(Math.max(1, batchSize) * 0.75),
  );
}

export function discoveryReserveTarget(prefetchDepth: number): number {
  return Math.min(
    DISCOVERY_RESERVE_MAX,
    Math.max(DISCOVERY_RESERVE_MIN, Math.max(1, Math.trunc(prefetchDepth))),
  );
}

/**
 * Deck jank (owner 2026-09-17 「发现tab 左滑右滑又开始卡了」): the reserve used
 * to re-warm whenever depth was *one below* target, i.e. after EVERY swipe — a
 * whole multi-source network round plus SQLite inserts on the Hermes thread,
 * queued in front of the next touch (measured: idle JS 0 % → 16.7 % while
 * swiping; 54.82 % of it draining promises). A reserve is a buffer: it only
 * needs topping up once it has genuinely drained. Warm when depth is at or
 * below half the target, then refill all the way back to target, so a 40-deep
 * reserve costs one round per ~20 swipes instead of one per swipe.
 */
export function discoveryReserveLowWater(reserveTarget: number): number {
  return Math.ceil(reserveTarget / 2);
}

export type DiscoveryBatchFetcher = (
  input: FetchDiscoveryBatchInput,
) => Promise<DiscoveryBatch>;

export type RefillResult = {
  status: 'ready' | 'exhausted' | 'invalidated';
  inserted: number;
  deck: RestoredDeck;
};

export type DecisionResult = {
  imageId: number;
  decision: AppliedDecision;
  deck: RestoredDeck;
  backgroundDownload?: Promise<DiscoveryDownloadResult>;
};

/**
 * Board #24: one Discover decision this process can still rewind. `decidedAt`
 * is the decided row's own value, so a row a later user action changed (a
 * 收藏 delete, a Search re-save) no longer matches and is skipped as stale.
 */
export type RewindEntry = {
  imageId: number;
  decision: AppliedDecision;
  decidedAt: number;
};

export type RewindResult =
  | { status: 'rewound'; entry: RewindEntry; deck: RestoredDeck }
  | { status: 'empty'; deck: RestoredDeck }
  | { status: 'skipped' };

export type DiscoveryDownloadResult = {
  status: 'ready' | 'failed' | 'stale';
};

export interface DiscoveryCollectionPort {
  retryDownload(imageId: number): Promise<DiscoveryDownloadResult>;
  revertPendingSave(image: StoredImage): Promise<void>;
}

/** Board #24: removes a rewound save's copy from the private library on this device. */
export interface DiscoveryLibraryPort {
  purgeCollectedImage(imageId: number): Promise<void>;
}

export interface DiscoveryService {
  restore(): Promise<RestoredDeck>;
  refill(settings: AppSettings, signal?: AbortSignal): Promise<RefillResult>;
  warmReserve(settings: AppSettings, signal?: AbortSignal): Promise<RefillResult>;
  /**
   * First-card streaming (spec 2026-09-16 §3): deck snapshots published from
   * inside a refill each time a card lands and is activated, so the screen can
   * show the fastest source's card before the round's slowest source settles.
   * Returns the unsubscribe function. Listeners must not throw; a throw is
   * swallowed so an observer can never fail a refill.
   */
  subscribe(listener: (deck: RestoredDeck) => void): () => void;
  getDeck(): RestoredDeck;
  decide(
    imageId: number,
    decision: AppliedDecision,
    settings?: AppSettings,
  ): Promise<DecisionResult | null>;
  /**
   * Board #24: undo the newest still-valid decision this process made. Stale
   * entries are dropped inside the same call. With `expect`, only the top
   * entry is considered: another image there gives `skipped` and pops nothing,
   * and a stale `expect` entry is dropped alone (`skipped`), so a rewind
   * paired with a swipe can never land on an older decision.
   */
  rewind(expect?: { imageId: number }): Promise<RewindResult>;
  /** How many decisions the history holds (stale ones included). */
  rewindDepth(): number;
  /** Hears the depth after every push, pop and clear. Returns the unsubscribe. */
  subscribeRewindDepth(listener: (depth: number) => void): () => void;
  invalidateQueuedCandidates(settings?: AppSettings): Promise<number>;
  /**
   * R8.16-C: drop one queued card (failed artwork prefetch) and return the
   * refreshed deck. Returns null when the id is not a queued card.
   */
  dropQueuedCandidate(imageId: number): Promise<RestoredDeck | null>;
}

type DiscoveryServiceDependencies = {
  repository: ImageRepository;
  coordinator: DataResetCoordinator;
  fetchBatch?: DiscoveryBatchFetcher;
  clock?: () => number;
  collection?: DiscoveryCollectionPort;
  /** Board #24: the library's local removal of a rewound save (row 24 stage 1). */
  library?: DiscoveryLibraryPort;
  /**
   * Per-provider yield accounting (G3 spec §4). Defaults to a fresh in-memory
   * ledger owned by this service closure; production never passes one, and it
   * is injected here so tests can observe the writes without widening the
   * {@link DiscoveryService} surface.
   *
   * **Live since G3c Task 3.** The refill loop now feeds each round's snapshot
   * to the fetcher as `yieldStats`, where `planProviderShares` weights slack
   * redistribution with it. A cold start (empty ledger) is read as "no
   * evidence" and plans uniformly, so the first round of a fresh process
   * behaves exactly as before.
   */
  yieldLedger?: ProviderYieldLedger;
};

const EMPTY_DECK: RestoredDeck = { active: null, queued: [] };

export function createDiscoveryService({
  repository,
  coordinator,
  fetchBatch = fetchDiscoveryBatch,
  clock = Date.now,
  collection,
  library,
  yieldLedger = createProviderYieldLedger(),
}: DiscoveryServiceDependencies): DiscoveryService {
  let deck = EMPTY_DECK;
  let refillInFlight: Promise<RefillResult> | null = null;
  let refillTargetInFlight = 0;
  let refillController: AbortController | null = null;
  const refillProgressWaiters = new Set<() => void>();
  const deckListeners = new Set<(deck: RestoredDeck) => void>();
  // First-card streaming (spec 2026-09-16 §4): how many refill rounds are still
  // converging away from a streamed cold first paint. Armed to the ledger window
  // when a round streams, decremented per fair round, and the wave-1 share plan
  // applies the rolling soft quota while it is > 0. Once the streamed round has
  // aged out of the window the ledger no longer carries its dominance, so the
  // quota would be inert anyway; ending it here keeps steady state literally on
  // the G3 share plan (spec §5).
  let convergingRounds = 0;
  const publishDeck = (): void => {
    for (const listener of [...deckListeners]) {
      try {
        listener(deck);
      } catch {
        // An observer must not affect the refill it is observing.
      }
    }
  };
  let invalidationInFlight: Promise<number> | null = null;
  let generation = 0;
  // Board #24: this process's Discover decisions, newest last (R1: multi-step,
  // gone with the process). It lives here, not in the hook, so it survives tab
  // switches and remounts; a bundle rebuild starts a fresh one.
  const history: RewindEntry[] = [];
  const depthListeners = new Set<(depth: number) => void>();
  // The background removal of each rewound save, so a Discover re-save of the
  // same card downloads only after its local purge has finished.
  const purges = new Map<number, Promise<void>>();

  const publishDepth = (): void => {
    for (const listener of [...depthListeners]) {
      try {
        listener(history.length);
      } catch {
        // An observer must not affect the decision it is observing.
      }
    }
  };

  const clearHistory = (): void => {
    history.length = 0;
    publishDepth();
  };

  const candidateDepth = (): number => (
    (deck.active === null ? 0 : 1) + deck.queued.length
  );

  const publishRefillProgress = (): void => {
    for (const notify of [...refillProgressWaiters]) notify();
  };

  const abortedRefillError = (): Error & { code: 'aborted' } => {
    const error = Object.assign(new Error('Discovery refill was aborted'), {
      code: 'aborted' as const,
    });
    error.name = 'AbortError';
    return error;
  };

  const waitForRefillTarget = (
    current: Promise<RefillResult>,
    target: number,
    signal?: AbortSignal,
  ): Promise<RefillResult> => new Promise((resolve, reject) => {
    const initialDepth = candidateDepth();
    let settled = false;

    const cleanup = () => {
      refillProgressWaiters.delete(notify);
      signal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (result: RefillResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(abortedRefillError());
    const notify = () => {
      const depth = candidateDepth();
      if (depth < target) return;
      resolveOnce({
        status: 'ready',
        inserted: Math.max(0, depth - initialDepth),
        deck,
      });
    };

    if (signal?.aborted) {
      rejectOnce(abortedRefillError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    refillProgressWaiters.add(notify);
    current.then(resolveOnce, rejectOnce);
    notify();
  });

  const invalidateProcessState = (): void => {
    generation += 1;
    refillController?.abort();
    deck = EMPTY_DECK;
    convergingRounds = 0;
    // Delete all, 重置发现记录 and an applied restore: the deck starts over. A backup
    // export or a restore's pick holds an exclusive lease instead, which skips this.
    clearHistory();
  };

  coordinator.registerResetParticipant(invalidateProcessState);

  const restoreAndActivate = async (): Promise<RestoredDeck> => {
    deck = await repository.restoreDeck();
    if (deck.active === null && deck.queued.length > 0) {
      await repository.activateNext(clock());
      deck = await repository.restoreDeck();
    }
    return deck;
  };

  /**
   * Board #24 §5.4: remove a rewound save from this device, in the background,
   * after its row is already back on the deck. The collection files go first
   * (it aborts and awaits the image's downloads, so none can land afterwards),
   * then the library copy. Failures are left to the owners' own retries: the
   * collection's cleanup queue and the library's recovery rule.
   */
  const startRemoval = (previous: StoredImage): void => {
    const imageId = previous.id;
    let removal!: Promise<void>;
    removal = (async () => {
      try {
        await collection?.revertPendingSave(previous);
      } catch {
        // Queued for the resume sweep by the collection service.
      }
      try {
        await library?.purgeCollectedImage(imageId);
      } catch {
        // The library's recovery rule purges it on the next resume sweep.
      }
    })().finally(() => {
      // Only this removal's own entry: a newer rewind of the same card may
      // already have replaced it, and its re-save must keep waiting for that.
      if (purges.get(imageId) === removal) purges.delete(imageId);
    });
    purges.set(imageId, removal);
  };

  /**
   * G3 spec §4 — per-provider accounting for one refill round. Records exactly
   * what the round already did; it changes no schedule by itself. Since G3c
   * Task 3 the accumulated window *is* read back — the next round's
   * `fetchBatch` receives {@link ProviderYieldLedger.stats} as `yieldStats` —
   * so what is recorded here is what the share plan will weight next round.
   *
   * One known blind spot: a round whose whole `fetchBatch` rejected — which
   * since board #19 means every admitted source failed — carries no
   * per-provider metadata, so it is not recorded. (A mixed round, where some
   * sources answered with zero posts and another failed, used to throw too;
   * it now resolves and is recorded like any other round.) Under-counting
   * only ever grants a source *more* slack, never less, so the blind spot
   * cannot produce the starving G3 exists to remove.
   */
  const recordProviderRounds = (
    batch: DiscoveryBatch,
    insertedByProvider: Partial<Record<ImageProviderKey, number>>,
  ): void => {
    traceProviderRounds(batch.providerRounds, insertedByProvider);
    for (const round of batch.providerRounds ?? []) {
      yieldLedger.record(round.providerKey, {
        requested: round.requested,
        returned: round.returned,
        admitted: round.admitted,
        inserted: insertedByProvider[round.providerKey] ?? 0,
        outcome: round.outcome,
      });
    }
  };

  /**
   * G3 spec §2.6-2 — provider bucketing, then fairness interleave.
   *
   * The batch merged by `provider-client` is index-major: its tail is a solid
   * run of whichever source contributed most (spec §1 S6, §2.6). This function
   * removes that streak without changing which cards a source contributes:
   *
   * 1. bucket by `providerKey` — insertion order is the merged batch order,
   *    which is registry order, and that is the interleave's tie-break;
   * 2. interleave the buckets under a run cap, so the caller's truncation takes
   *    a proportional slice of *every* source's head instead of one source's
   *    entire contribution.
   *
   * The interleave runs unconditionally: it is a fairness mechanism (the
   * cross-source load balancer the owner requires), not a personalization
   * mechanism. Within a bucket the cards keep their merge order — there is no
   * per-user reordering.
   *
   * **Applied twice, and the second time to survivors (G3c Task 4 gate catch).**
   * Once over the offered batch, where the truncation cuts the interleaved tail;
   * then again over the cards that actually cleared the identity gate, because a
   * suppressed card leaves a hole in an order already decided, and a hole
   * between two runs of one source joins them. A deck ordered to a longest run
   * of 2 persisted a run of 4, which the spec §6.3 gate caught in 15 of 15
   * cycles. The bound is a property of the sequence this function is handed, so
   * handing it the survivors is what makes the *persisted* `queue_ordinal` order
   * inherit it.
   */
  const orderBatchForDeck = (
    items: readonly ImageCandidate[],
    precededBy?: { key: ImageProviderKey; run: number },
  ): readonly ImageCandidate[] => {
    if (items.length < 2) return items;

    const buckets = new Map<ImageProviderKey, ImageCandidate[]>();
    for (const item of items) {
      const bucket = buckets.get(item.providerKey);
      if (bucket === undefined) buckets.set(item.providerKey, [item]);
      else bucket.push(item);
    }

    return interleaveWithRunCap(buckets, {
      maxConsecutivePerProvider: DISCOVERY_MAX_CONSECUTIVE_PER_PROVIDER,
      precededBy,
    });
  };

  /**
   * The provider at the tail of the deck this batch will be appended to, and how
   * many of its cards run there. New candidates take `MAX(queue_ordinal) + 1`, so
   * this is exactly what the batch lands behind.
   *
   * Without it the §2.6 bound holds within a batch but not across the boundary:
   * the Task 5 all-sources device smoke read `W W W` off `queue_ordinal` where a
   * refresh had deleted the queued rows but kept the active waifu card, and the
   * next batch then opened with a locally legal 2-run of waifu. The batch was
   * correct in isolation — it simply could not see what it was landing behind.
   */
  const deckTailContext = (): { key: ImageProviderKey; run: number } | undefined => {
    const persisted: readonly StoredImage[] = [
      ...(deck.active === null ? [] : [deck.active]),
      ...deck.queued,
    ];
    const tail = persisted[persisted.length - 1];
    if (tail === undefined) return undefined;
    let run = 0;
    for (let index = persisted.length - 1; index >= 0; index -= 1) {
      if ((persisted[index] as StoredImage).providerKey !== tail.providerKey) break;
      run += 1;
    }
    return { key: tail.providerKey, run };
  };

  const performRefill = async (
    settings: AppSettings,
    target: number,
    signal: AbortSignal,
    refillGeneration: number,
  ): Promise<RefillResult> => {
    let candidateCount = candidateDepth();
    // Cold first paint = nothing active and nothing queued when the round
    // starts, *and* the round is the first-paint refill. A refill on a
    // non-empty deck (depth at the low-water mark) is the steady-state path and
    // never streams; neither does a reserve warm that happens to start empty
    // (after a data reset, or the G3 §6.3 gate's drained cycles). Streaming a
    // 30-60 card reserve would hand the whole queue to whichever source
    // answered first — the fair aggregate below is then truncated to nothing —
    // which is exactly the monopoly G3 §2.6/§6.3 exists to prevent. Spec
    // §4 bounds the streamed head to DISCOVERY_FIRST_PAINT_BATCH + 1 and §5
    // leaves every other round on the proven fair path, so the target itself is
    // the honest discriminator.
    const streamFirstPaint = candidateCount === 0 &&
      target <= DISCOVERY_FIRST_PAINT_BATCH + 1;
    if (candidateCount >= target) {
      return { status: 'ready', inserted: 0, deck };
    }

    let excludedIds = await repository.recentHandledIds(100);
    const handledIdentities = await repository.recentHandledIdentities(100);
    let excludedProviderIds = handledIdentities.reduce<ProviderExclusions>(
      (grouped, identity) => ({
        ...grouped,
        [identity.providerKey]: [
          ...(grouped[identity.providerKey] ?? []),
          identity.providerItemId,
        ],
      }),
      {},
    );
    let insertedTotal = 0;
    let duplicateOnlyAttempts = 0;
    for (
      let batchNumber = 0;
      batchNumber < MAX_REFILL_BATCHES &&
      duplicateOnlyAttempts < MAX_DUPLICATE_ONLY_ATTEMPTS &&
      candidateCount < target;
      batchNumber += 1
    ) {
      // First-card streaming (spec 2026-09-16 §3): only the COLD first paint
      // streams, and only its first batch. Each source's delivery is inserted
      // the tick it lands — run-capped against the live deck tail, serialised
      // through `streamChain` so two sources settling on adjacent ticks never
      // interleave their inserts — and the first activation is published to
      // subscribers before the round's slowest source has settled. The
      // aggregate batch below then reconciles: cards already streamed are
      // suppressed by the identity gate, and the streamed counts are folded
      // into this round's ledger record so every card is accounted exactly once.
      const streamThisBatch = streamFirstPaint && batchNumber === 0;
      let streamChain: Promise<void> = Promise.resolve();
      const streamedByProvider: Partial<Record<ImageProviderKey, number>> = {};
      let streamedInserted = 0;
      const onSourceSettled = streamThisBatch
        ? (delivery: DiscoverySourceDelivery): void => {
          streamChain = streamChain.then(async () => {
            if (generation !== refillGeneration || signal.aborted) return;
            const room = target - candidateDepth();
            if (room <= 0) return;
            const precededBy = deckTailContext();
            const offered = orderBatchForDeck(delivery.items, precededBy).slice(0, room);
            const result = await repository.insertCandidates(offered, {
              orderSurvivors: (survivors) => survivors.length === offered.length
                ? survivors
                : orderBatchForDeck(survivors, precededBy),
            });
            if (generation !== refillGeneration) return;
            for (const [key, count] of Object.entries(result.byProvider)) {
              const providerKey = key as ImageProviderKey;
              streamedByProvider[providerKey] = (streamedByProvider[providerKey] ?? 0) + (count ?? 0);
            }
            streamedInserted += result.inserted;
            if (result.inserted === 0) return;
            await restoreAndActivate();
            if (generation !== refillGeneration) return;
            publishDeck();
            publishRefillProgress();
          }).catch(() => undefined);
        }
        : undefined;

      const batch = await fetchBatch({
        settings,
        excludedIds,
        excludedProviderIds,
        desiredCount: target - candidateCount,
        // G3 spec §2.2 — the rolling per-source yield window this refill has
        // accumulated so far. Snapshotted per round, so a source that went
        // quiet (or cooled down) in the previous round is already reflected in
        // the share plan of the next one. Empty on a cold process, which
        // `planProviderShares` reads as "no evidence" and plans uniformly.
        yieldStats: yieldLedger.stats(),
        // Spec §4: the rounds after a streamed paint plan with the rolling soft
        // quota so the source that answered first hands share back until the
        // others catch up. A streaming round itself plans without it (the
        // ledger has no evidence to nudge on yet, and its fairness is the
        // aggregate's job).
        softQuota: !streamThisBatch && convergingRounds > 0,
        // The aggregate is still source-fair (G3): racing providers here would
        // let the fastest source fill the whole queue. Streaming (above) only
        // decides *when* a landed source's cards become visible on a cold
        // paint; the merged batch, the top-up wave and the round records are
        // unchanged.
        preferFirstUsable: false,
        ...(onSourceSettled === undefined ? {} : { onSourceSettled }),
        signal,
      });
      if (streamThisBatch) {
        convergingRounds = PROVIDER_YIELD_WINDOW_ROUNDS;
      } else if (convergingRounds > 0) {
        convergingRounds -= 1;
      }
      // Every delivery has landed (or been skipped) before the aggregate is
      // reconciled against the deck.
      await streamChain;
      if (generation !== refillGeneration) {
        return { status: 'invalidated', inserted: 0, deck };
      }
      candidateCount = candidateDepth();

      excludedIds = [...new Set([
        ...batch.items.flatMap((item) => 'id' in item ? [item.id as number] : []),
        ...excludedIds,
      ])].slice(0, 100);
      for (const item of batch.items) {
        excludedProviderIds = {
          ...excludedProviderIds,
          [item.providerKey]: [...new Set([
            item.providerItemId,
            ...(excludedProviderIds[item.providerKey] ?? []),
          ])].slice(0, 100),
        };
      }

      // The interleave spreads the batch across sources, exactly as §2.6-2
      // specifies, and the truncation cuts the interleaved tail — so the slice
      // takes a proportional share of every source rather than one source's
      // whole contribution (spec §1 S6).
      // Read before the insert, so both the offered order and the survivor
      // re-spread below are built against the same deck tail.
      const precededBy = deckTailContext();
      const offered = orderBatchForDeck(batch.items, precededBy)
        .slice(0, Math.max(0, target - candidateCount));
      const insertResult = offered.length === 0
        ? { inserted: 0, byProvider: {} as Partial<Record<ImageProviderKey, number>> }
        : await repository.insertCandidates(offered, {
          // …and then the identity gate has its say. Whatever it suppresses
          // leaves a hole in an order that was already decided, and a hole
          // between two runs of one source joins them: an order built to a
          // longest run of 2 persisted a run of 4 (G3c Task 4 gate, 15/15
          // cycles). Re-spreading the survivors closes the holes, so the
          // persisted `queue_ordinal` order inherits the §2.6 bound — the form
          // §6.3-3 and §6.5 state.
          //
          // Bucketing preserves each source's relative order, so re-spreading
          // only moves cards between sources to restore the interleave — it never
          // reorders a source's own cards.
          //
          // Nothing suppressed means nothing to repair: the order handed in is
          // already an interleave of exactly these cards, and rebuilding it would
          // only pick a different valid one.
          orderSurvivors: (survivors) => survivors.length === offered.length
            ? survivors
            : orderBatchForDeck(survivors, precededBy),
        });
      // Streamed cards count for this round: for the ledger (once, merged into
      // the per-provider record) and for the duplicate-only accounting (a round
      // that streamed six fresh cards is not a duplicate-only round).
      const inserted = insertResult.inserted + streamedInserted;
      const insertedByProvider: Partial<Record<ImageProviderKey, number>> = { ...insertResult.byProvider };
      for (const [key, count] of Object.entries(streamedByProvider)) {
        const providerKey = key as ImageProviderKey;
        insertedByProvider[providerKey] = (insertedByProvider[providerKey] ?? 0) + (count ?? 0);
      }
      recordProviderRounds(batch, insertedByProvider);
      if (generation !== refillGeneration) {
        return { status: 'invalidated', inserted: 0, deck };
      }
      insertedTotal += inserted;
      if (inserted === 0) {
        duplicateOnlyAttempts += 1;
      } else {
        await restoreAndActivate();
        if (generation !== refillGeneration) {
          return { status: 'invalidated', inserted: 0, deck };
        }
        publishDeck();
        candidateCount = candidateDepth();
        publishRefillProgress();
      }
    }

    if (generation !== refillGeneration) {
      return { status: 'invalidated', inserted: 0, deck };
    }
    await restoreAndActivate();
    publishDeck();
    publishRefillProgress();
    const exhausted = insertedTotal === 0 &&
      duplicateOnlyAttempts >= MAX_DUPLICATE_ONLY_ATTEMPTS;
    return {
      status: exhausted || (deck.active === null && deck.queued.length === 0)
        ? 'exhausted'
        : 'ready',
      inserted: insertedTotal,
      deck,
    };
  };

  const startRefill = (
    settings: AppSettings,
    target: number,
    signal?: AbortSignal,
  ): Promise<RefillResult> => {
    if (refillInFlight !== null) {
      if (refillTargetInFlight === target) return refillInFlight;
      if (refillTargetInFlight > target) {
        return waitForRefillTarget(refillInFlight, target, signal);
      }
      return refillInFlight.then((result) => {
        if (result.status !== 'ready' || signal?.aborted) return result;
        return startRefill(settings, target, signal);
      });
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const refillGeneration = generation;
    refillController = controller;
    refillTargetInFlight = target;

    let current!: Promise<RefillResult>;
    current = coordinator.runMutation(
      () => performRefill(settings, target, controller.signal, refillGeneration),
      { abort: invalidateProcessState },
    ).finally(() => {
      signal?.removeEventListener('abort', onCallerAbort);
      if (refillInFlight === current) refillInFlight = null;
      if (refillController === controller) refillController = null;
      if (refillTargetInFlight === target) refillTargetInFlight = 0;
    });
    refillInFlight = current;
    return current;
  };

  return {
    restore() {
      return coordinator.runMutation(restoreAndActivate);
    },
    refill(settings, signal) {
      if (invalidationInFlight) {
        return invalidationInFlight.then(() => startRefill(
          settings,
          DISCOVERY_FIRST_PAINT_BATCH + 1,
          signal,
        ));
      }
      return startRefill(settings, DISCOVERY_FIRST_PAINT_BATCH + 1, signal);
    },
    warmReserve(settings, signal) {
      const target = discoveryReserveTarget(settings.prefetchDepth);
      if (invalidationInFlight) {
        return invalidationInFlight.then(() => startRefill(settings, target, signal));
      }
      return startRefill(settings, target, signal);
    },
    subscribe(listener) {
      deckListeners.add(listener);
      return () => {
        deckListeners.delete(listener);
      };
    },
    getDeck() {
      return deck;
    },
    decide(imageId, decision, _settings) {
      return coordinator.runMutation(async () => {
        if (deck.active === null) return null;

        if (deck.active.id !== imageId) {
          const promoted = await repository.promoteForDecision(imageId, clock());
          if (promoted === null) return null;
          deck = await repository.restoreDeck();
        }

        const operationDeck = deck;
        const decidedAt = clock();
        const decided = await repository.decide(imageId, decision, decidedAt);
        if (decided === null) return null;

        // Record a landed write before advancing. If activateNext throws after
        // this point, the decision still belongs in rewind history.
        history.push({
          imageId,
          decision,
          decidedAt: decided.decidedAt ?? decidedAt,
        });
        publishDepth();

        // R8.16-A: advance the deck LOCALLY instead of re-reading the whole
        // table. `repository.decide` already persisted this card's decision,
        // and the service's in-memory deck already holds the queue the next
        // card promotes from — promote with the single activateNext UPDATE and
        // re-shape the in-memory deck. In the normal path, the full restoreDeck
        // read belongs to restore/refill/rewind; the branch below uses it only
        // when another mutation replaced this operation's deck while it waited.
        const presented = await repository.activateNext(clock());
        if (deck !== operationDeck) {
          deck = await repository.restoreDeck();
        } else {
          deck = presented === null
            ? { active: null, queued: deck.queued.slice(1) }
            : { active: presented, queued: deck.queued.slice(1) };
        }

        let backgroundDownload: Promise<DiscoveryDownloadResult> | undefined;
        if (decision === 'saved' && collection) {
          // Board #24 §5.2: a re-save of a card whose rewound save is still
          // being removed downloads only once that removal has finished, so
          // the new download never races the purge of the same bytes.
          const removal = purges.get(imageId);
          const download = removal === undefined
            ? collection.retryDownload(imageId)
            : removal.then(() => collection.retryDownload(imageId));
          backgroundDownload = download.catch(() => ({
            status: 'failed' as const,
          }));
        }

        return backgroundDownload === undefined
          ? { imageId, decision, deck }
          : { imageId, decision, deck, backgroundDownload };
      });
    },
    rewind(expect) {
      return coordinator.runMutation(async (): Promise<RewindResult> => {
        while (history.length > 0) {
          const entry = history[history.length - 1] as RewindEntry;
          if (expect !== undefined && entry.imageId !== expect.imageId) {
            return { status: 'skipped' };
          }
          history.pop();
          publishDepth();
          const previous = await repository.rewindDecision(entry.imageId, {
            decision: entry.decision,
            decidedAt: entry.decidedAt,
          });
          if (previous === null) {
            // Stale: a later user action changed this image. It wins; drop the
            // entry and look at the next one in the same press — unless this
            // press was paired with exactly this entry.
            if (expect !== undefined) return { status: 'skipped' };
            continue;
          }

          // The flip is durable: the removal follows it even if the deck read
          // below fails.
          if (entry.decision === 'saved') startRemoval(previous);
          const restored = await restoreAndActivate();
          return { status: 'rewound', entry, deck: restored };
        }
        return expect === undefined ? { status: 'empty', deck } : { status: 'skipped' };
      });
    },
    rewindDepth() {
      return history.length;
    },
    subscribeRewindDepth(listener) {
      depthListeners.add(listener);
      return () => {
        depthListeners.delete(listener);
      };
    },
    async dropQueuedCandidate(imageId) {
      // No coordinator mutation: this is a narrow single-row delete that must
      // not wait behind (or block) an in-flight refill — the whole point of
      // R8.16-C is that a dead card is swapped promptly. The FIFO scheduler
      // serializes the SQL statements themselves. NOTE (2026-09-08 drift
      // finding 4): this covers DB ordering only — the in-memory `deck`
      // write below is NOT under the coordinator lock and can interleave with
      // the data-reset participant (invalidateProcessState); a stale window
      // there self-heals on the next full restore read (restore/refill/rewind
      // all full-read). Keep this operation idempotent and allocation-free
      // (filter, not rebuild).
      const dropped = await repository.dropQueuedCandidate(imageId);
      if (dropped === null) return null;
      deck = {
        active: deck.active,
        queued: deck.queued.filter((item) => item.id !== imageId),
      };
      return deck;
    },
    invalidateQueuedCandidates(settings) {
      if (invalidationInFlight) return invalidationInFlight;

      let current!: Promise<number>;
      current = coordinator.runMutation(async () => {
        generation += 1;
        refillController?.abort();
        const activeRefill = refillInFlight;
        if (activeRefill) await activeRefill.catch(() => undefined);
        const persistedDeck = await repository.restoreDeck();
        const active = persistedDeck.active;
        if (
          settings !== undefined &&
          active !== null &&
          (
            !settings.providers[active.providerKey] ||
            !matchesCandidateSettings(active, settings)
          )
        ) {
          await repository.decide(active.id, 'dismissed', clock());
        }
        const invalidated = await repository.deleteQueuedCandidates();
        deck = await repository.restoreDeck();
        // Board #24: the deck was rebuilt under the new content rules, and a
        // rewound card could break them (e.g. SFW-only). Cleared here, at the
        // end, so a decision that landed during the rebuild goes as well; the
        // settings auto-dismiss above never entered the history.
        clearHistory();
        return invalidated;
      }).finally(() => {
        if (invalidationInFlight === current) invalidationInFlight = null;
      });
      invalidationInFlight = current;
      return current;
    },
  };
}
