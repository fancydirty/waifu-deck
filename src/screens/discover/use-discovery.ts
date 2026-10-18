import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  discoveryRefillThreshold,
  discoveryReserveLowWater,
  discoveryReserveTarget,
  DISCOVERY_FIRST_PAINT_BATCH,
  type DecisionResult,
} from '@/features/discovery/discovery-service';
import { publishCollectionRow } from '@/features/collection/collection-query';
import type {
  AppliedDecision,
  RestoredDeck,
} from '@/features/images/image-repository';
import { discoveryProviderErrorMessage } from '@/features/providers/provider-client';
import { providerImageHeaders } from '@/features/providers/provider-image-source';
import { discoverySettingsIdentity } from '@/features/settings/settings';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';

const DECK_QUERY_KEY = ['discovery', 'deck'] as const;
const REFILL_QUERY_KEY = ['discovery', 'refill'] as const;
const RESERVE_QUERY_KEY = ['discovery', 'reserve'] as const;
const EMPTY_DECK: RestoredDeck = { active: null, queued: [] };

function deckDepth(deck: RestoredDeck): number {
  return (deck.active === null ? 0 : 1) + deck.queued.length;
}

export type DiscoveryState = {
  kind: 'loading' | 'ready' | 'error' | 'offline' | 'exhausted';
  deck: RestoredDeck;
  message?: string;
};

export type DiscoverViewModel = {
  state: DiscoveryState;
  isDeciding: boolean;
  /** The visible card can accept a decide while earlier decides drain. */
  canDecide: boolean;
  /** Board #24: something this process decided can still be rewound. */
  canRewind: boolean;
  decisionError: string | null;
  commitDecision(decision: AppliedDecision): boolean;
  /** Board #24: queue one rewind; `false` when nothing is left to rewind. */
  rewind(): boolean;
  retry(): Promise<void>;
};

/** One swipe's durable write. `outcome` is set when it settles. */
type DecideOp = {
  kind: 'decide';
  imageId: number;
  decision: AppliedDecision;
  outcome?: { imageId: number } | 'failed';
};

/**
 * One rewind press. Paired with the swipe it was pressed behind, if that
 * swipe's decide had not landed yet; unpaired presses rewind the history.
 */
type RewindOp = {
  kind: 'rewind';
  pairedDecide: DecideOp | null;
};

type PipelineOp = DecideOp | RewindOp;

function isOfflineError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return error.code === 'network' || error.code === 'timeout';
}

export function useDiscovery(): DiscoverViewModel {
  const { t } = useAppTranslation();
  const {
    settings,
    dataRevision,
    discoveryService,
    imageRepository,
  } = useAppServices();
  const queryClient = useQueryClient();
  const settingsKey = discoverySettingsIdentity(settings);
  const previousSettingsKey = useRef(settingsKey);
  const previousSettings = useRef(settings);
  const previousDataRevision = useRef(dataRevision);
  const lastPrefetchKey = useRef<string | null>(null);
  const mounted = useRef(true);
  // Backlog #11 pipeline + board #24. A swipe advances the VISIBLE deck
  // optimistically the instant it commits; its durable `decide()` and every
  // rewind press ride one serial FIFO op queue, drained by a single consumer.
  // `opQueue` holds the queued ops AND the running one (at [0], until it
  // settles), `draining` is true while the consumer runs and `opRunning` while
  // an op is in flight. `pipelineBusy()` gates every publish that carries the
  // (trailing) service deck, so a refill/reserve/republish can never drag a
  // card the user already swiped past back onscreen.
  const opQueue = useRef<PipelineOp[]>([]);
  const draining = useRef(false);
  const opRunning = useRef(false);
  const [isDeciding, setIsDeciding] = useState(false);
  const [canDecide, setCanDecide] = useState(false);
  const [canRewind, setCanRewind] = useState(
    () => discoveryService.rewindDepth() > 0,
  );
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const pipelineBusy = useCallback(
    () => draining.current || opQueue.current.length > 0,
    [],
  );

  /**
   * Board #24: presses still available = the service history + the swipes
   * whose decide has not landed − the rewinds already queued or running. Read
   * from refs only, never render state.
   */
  const rewindAvailability = useCallback((): number => {
    let available = discoveryService.rewindDepth();
    for (const op of opQueue.current) available += op.kind === 'decide' ? 1 : -1;
    return available;
  }, [discoveryService]);

  // Board #24: recomputed only at op boundaries (enqueue, op start, op end) and
  // on a depth pushed while no op runs. A push during an op — a decide's new
  // entry, a rewind's pop — is read at that op's end, so the button never
  // blinks: not off while a rewind pops, not on when a paired decide lands.
  const refreshCanRewind = useCallback(() => {
    if (mounted.current) setCanRewind(rewindAvailability() > 0);
  }, [rewindAvailability]);

  const refreshCanDecide = useCallback(() => {
    const visibleDeck = queryClient.getQueryData<RestoredDeck>(DECK_QUERY_KEY) ?? EMPTY_DECK;
    const rewindQueued = opQueue.current.some((op) => op.kind === 'rewind');
    if (mounted.current) setCanDecide(visibleDeck.active !== null && !rewindQueued);
  }, [queryClient]);

  const deckQuery = useQuery({
    queryKey: DECK_QUERY_KEY,
    queryFn: () => discoveryService.restore(),
    staleTime: Infinity,
  });
  const deck = deckQuery.data ?? EMPTY_DECK;
  const candidateDepth = deckDepth(deck);
  const needsRefill = deckQuery.isSuccess &&
    candidateDepth <= discoveryRefillThreshold(DISCOVERY_FIRST_PAINT_BATCH);
  const reserveTarget = discoveryReserveTarget(settings.prefetchDepth);
  const needsReserve = deckQuery.isSuccess &&
    deck.active !== null &&
    !needsRefill &&
    candidateDepth <= discoveryReserveLowWater(reserveTarget);

  const refillQuery = useQuery({
    queryKey: [...REFILL_QUERY_KEY, settingsKey],
    enabled: needsRefill,
    queryFn: async ({ signal }) => {
      let result = await discoveryService.refill(settings, signal);
      // R8.13: an invalidated refill (generation moved under us — reset
      // participant aborted the batch) leaves the deck empty with no further
      // query scheduled under this key: needsRefill still holds, but the
      // query already settled. Retry once inside the same fetch so the
      // screen converges to ready/exhausted/error instead of parking on
      // 「正在加载」forever (owner report 2026-09-07).
      if (
        result.status === 'invalidated' &&
        deckDepth(result.deck) === 0 &&
        !signal.aborted
      ) {
        result = await discoveryService.refill(settings, signal);
      }
      if (result.status !== 'invalidated' && !pipelineBusy()) {
        queryClient.setQueryData<RestoredDeck>(DECK_QUERY_KEY, (current) => {
          if (current !== undefined && deckDepth(result.deck) < deckDepth(current)) {
            return current;
          }
          return result.deck;
        });
      }
      return result;
    },
  });

  useQuery({
    queryKey: [...RESERVE_QUERY_KEY, settingsKey, reserveTarget],
    enabled: needsReserve,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const result = await discoveryService.warmReserve(settings, signal);
      if (result.status !== 'invalidated' && !pipelineBusy()) {
        queryClient.setQueryData<RestoredDeck>(DECK_QUERY_KEY, (current) => {
          if (current !== undefined && deckDepth(result.deck) < deckDepth(current)) {
            return current;
          }
          return result.deck;
        });
      }
      return result;
    },
  });

  // First-card streaming (spec 2026-09-16 §3): the service publishes deck
  // snapshots as sources land inside a cold refill, before the refill promise
  // resolves. Publish them into the deck query under the SAME guards the
  // refill/reserve publishes use — never under a decision that is mid-write or
  // parked, and never a shallower deck over a deeper one — so the screen flips
  // to `ready` on the fastest source instead of waiting for the slowest.
  useEffect(() => discoveryService.subscribe((snapshot) => {
    if (pipelineBusy()) return;
    queryClient.setQueryData<RestoredDeck>(DECK_QUERY_KEY, (current) => {
      if (current !== undefined && deckDepth(snapshot) < deckDepth(current)) {
        return current;
      }
      return snapshot;
    });
  }), [discoveryService, queryClient]);

  // Board #24: follow a depth the service publishes while nothing runs here (a
  // reset, a settings clear). During an op the op's end reads it instead.
  useEffect(() => discoveryService.subscribeRewindDepth(() => {
    if (!opRunning.current) {
      refreshCanRewind();
      refreshCanDecide();
    }
  }), [discoveryService, refreshCanDecide, refreshCanRewind]);

  useEffect(() => {
    refreshCanDecide();
  }, [deck.active?.id, refreshCanDecide]);

  useEffect(() => {
    const settingsWerePublished = previousSettings.current !== settings ||
      previousDataRevision.current !== dataRevision;
    if (!settingsWerePublished) return;

    const previous = previousSettingsKey.current;
    previousSettings.current = settings;
    previousDataRevision.current = dataRevision;
    previousSettingsKey.current = settingsKey;
    if (previous !== settingsKey) {
      void queryClient.cancelQueries({
        queryKey: [...REFILL_QUERY_KEY, previous],
        exact: true,
      });
      void queryClient.cancelQueries({
        queryKey: [...RESERVE_QUERY_KEY, previous],
        // R8.20: the reserve key carries the depth as a third part; a prefix
        // match cancels the old settings' reserve at any depth.
        exact: false,
      });
    }
    // Never rewrite the visible deck under a decision that is mid-write or
    // parked: that unmounts the card still owing an exit report.
    if (pipelineBusy()) return;
    queryClient.setQueryData(DECK_QUERY_KEY, discoveryService.getDeck());
  }, [dataRevision, discoveryService, queryClient, settings, settingsKey]);

  const preloadCards = useMemo(
    () => deck.queued.slice(0, settings.prefetchDepth),
    [deck.queued, settings.prefetchDepth],
  );
  const prefetchKey = `${settings.prefetchDepth}:${preloadCards.map((card) => card.sampleUrl ?? card.remoteUrl).join('|')}`;
  // R8.20: with a 30–60 card window every deck shift re-slices the whole
  // queue; without a per-session dedupe that re-issued dozens of Glide loads
  // per swipe. Each url is warmed once per hook lifetime.
  const prefetchedUrls = useRef(new Set<string>());

  useEffect(() => {
    if (preloadCards.length === 0 || lastPrefetchKey.current === prefetchKey) return;

    lastPrefetchKey.current = prefetchKey;
    // R8.16-C: prefetch ONE url per call so a failure is attributable to a
    // specific queued card (a batched prefetch only resolves true when every
    // URL succeeds — no way to tell which one died). A dead queued card is
    // swapped out before it surfaces; the active card keeps its honest error
    // tile (R8.12) as the last line of defense.
    for (const card of preloadCards) {
      // R8.18: warm the medium sample the deck actually renders, never the
      // full-resolution original — prefetching originals decoded 100+MB
      // bitmaps into memory and stalled the swipe animation.
      const url = card.sampleUrl ?? card.remoteUrl;
      if (prefetchedUrls.current.has(url)) continue;
      prefetchedUrls.current.add(url);
      // R8.28: the warm has to look like the render — a hotlink-protected CDN
      // (Gelbooru) answers a Referer-less prefetch with hotlink.php HTML, and
      // caching THAT is worse than not warming at all. This is the options
      // form of prefetch for every source; a source with no declared headers
      // gets exactly `{ cachePolicy: 'memory-disk' }`, the same policy the
      // string form passed.
      const headers = providerImageHeaders(card.providerKey);
      Image.prefetch(url, {
        cachePolicy: 'memory-disk',
        ...(headers ? { headers } : {}),
      })
        .then(async (ok) => {
          if (ok) return;
          // Still queued under this exact deck identity? Then the drop is
          // ours to make; a mid-flight decision may have already reshaped the
          // queue, and then the id no longer exists and the drop is a no-op.
          const refreshed = await discoveryService.dropQueuedCandidate(card.id)
            .catch(() => null);
          if (refreshed === null) return;
          // R8.16-C drift finding 2: publish the post-drop deck (guarded like
          // the refill publishes) so the depth guard sees the shrunken queue
          // and refills promptly — a drop that never reaches the query cache
          // would leave needsRefill blind until the next decide.
          if (pipelineBusy()) return;
          // Unlike the refill publishes, the monotonic-depth guard does not
          // apply here: the drop is the sole owner of this transition — the
          // card was just deleted by THIS operation, so a shallower deck is
          // the newest truth, not a stale read racing a deeper one. The
          // committing/pendingDecision guards above still protect a mid-
          // decision publish from unmounting a card that owes an exit report.
          queryClient.setQueryData<RestoredDeck>(DECK_QUERY_KEY, refreshed);
        })
        .catch(() => undefined);
    }
  }, [discoveryService, prefetchKey, preloadCards, queryClient]);

  const invalidateRefill = useCallback(() => {
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: [...REFILL_QUERY_KEY, settingsKey],
        exact: true,
      }, { cancelRefetch: false }),
      queryClient.invalidateQueries({
        queryKey: [...RESERVE_QUERY_KEY, settingsKey, reserveTarget],
        exact: true,
      }, { cancelRefetch: false }),
    ]).then(() => undefined);
  }, [queryClient, reserveTarget, settingsKey]);

  useEffect(() => {
    mounted.current = true;
    // The op queue's consumer (`drainQueue`) is a detached promise that
    // references only app-scoped services and refs, so it keeps persisting
    // enqueued decisions after this hook unmounts or the app backgrounds — it
    // simply stops touching component state (guarded by `mounted`). The advance
    // already happened optimistically and the durable write is already in flight
    // or queued, so no parked-decision flush is needed on unmount/background.
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * K7 cut 5b (audit ⑧) + board #24: a save, its finished download and a
   * rewound save each change exactly one row, so only that row is read and
   * published into the 收藏 snapshot the screens already hold (a rewound save
   * leaves it; see `publishCollectionRow`). A read-side projection failing must
   * never surface on the swipe: the durable write already landed, and the next
   * full read reconciles.
   */
  const publishRow = useCallback((imageId: number) => {
    void publishCollectionRow(queryClient, imageRepository, imageId)
      .catch(() => undefined);
  }, [imageRepository, queryClient]);

  // Backlog #11 + board #24: the serial consumer of the op queue. It owns every
  // durable write and every rewind. Started (detached) by `commitDecision` and
  // `rewind`, it runs one op at a time — `discoveryService.decide` and
  // `rewind` are NOT safe to run concurrently (they race `activateNext` and the
  // history), so the FIFO order here is load-bearing. It keeps running across
  // unmount so no enqueued decision is ever lost; only its component-state
  // writes are guarded by `mounted`.
  const drainQueue = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    if (mounted.current) setIsDeciding(true);

    const runDecide = async (op: DecideOp): Promise<void> => {
      let result: DecisionResult | null = null;
      try {
        result = await discoveryService.decide(op.imageId, op.decision, settings);
      } catch {
        result = null;
      }
      if (result === null) {
        // The durable write did not land. Surface the error and never wedge
        // the queue; a later op can return the stranded row to the queue end.
        op.outcome = 'failed';
        if (mounted.current) setDecisionError(t('discover.decisionError'));
        return;
      }
      op.outcome = { imageId: result.imageId };
      if (result.decision === 'saved') {
        // Fire-and-forget, exactly as before: the durable write is committed;
        // the collection snapshot is a read-side projection and must never sit
        // in the consumer's critical path.
        const savedImageId = result.imageId;
        publishRow(savedImageId);
        if (result.backgroundDownload) {
          void result.backgroundDownload
            .then(() => publishRow(savedImageId))
            .catch(() => undefined);
        }
      }
    };

    const runRewind = async (op: RewindOp): Promise<void> => {
      let expected: { imageId: number } | undefined;
      if (op.pairedDecide !== null) {
        const outcome = op.pairedDecide.outcome;
        // The swipe this press was for never landed. Cancelled: rewinding the
        // history instead would undo an older, unrelated decision.
        if (outcome === undefined || outcome === 'failed') return;
        expected = { imageId: outcome.imageId };
      }
      try {
        const result = await discoveryService.rewind(expected);
        if (result.status !== 'rewound') return;
        // Safe to publish: every decide queued before this op has landed, and
        // no swipe can queue behind it (commitDecision refuses while it waits).
        queryClient.setQueryData<RestoredDeck>(DECK_QUERY_KEY, result.deck);
        if (result.entry.decision === 'saved') publishRow(result.entry.imageId);
      } catch {
        if (mounted.current) setDecisionError(t('discover.rewindError'));
      }
    };

    try {
      while (opQueue.current.length > 0) {
        const op = opQueue.current[0] as PipelineOp;
        opRunning.current = true;
        refreshCanRewind();
        refreshCanDecide();
        try {
          if (op.kind === 'decide') await runDecide(op);
          else await runRewind(op);
        } finally {
          opQueue.current.shift();
          opRunning.current = false;
          refreshCanRewind();
          refreshCanDecide();
        }
      }
    } finally {
      draining.current = false;
      if (mounted.current) setIsDeciding(false);
      // Top up now that publishes are unblocked: a burst may have drained the
      // visible depth below the reserve low-water mark.
      void invalidateRefill();
    }
  }, [discoveryService, invalidateRefill, publishRow, queryClient, refreshCanDecide, refreshCanRewind, settings, t]);

  const commitDecision = useCallback((decision: AppliedDecision): boolean => {
    // Board #24: a swipe is refused while a rewind is queued or running. The
    // rewind reshapes the deck and reads the history, so a decide queued behind
    // it would advance a deck the rewind is about to replace. It settles in a
    // few ms and the next swipe proceeds. (Draining decides does NOT block a
    // commit; that is the whole point of the pipeline.)
    if (opQueue.current.some((op) => op.kind === 'rewind')) return false;
    // Backlog #11: advance the VISIBLE deck the instant the swipe commits, then
    // enqueue the durable write. The next card becomes interactive within a
    // frame instead of after the SQLite write + React commit that used to gate
    // it — the ~180-220 ms window in which a fast second swipe was dropped.
    const current = queryClient.getQueryData<RestoredDeck>(DECK_QUERY_KEY) ?? EMPTY_DECK;
    if (current.active === null) return false;
    queryClient.setQueryData<RestoredDeck>(DECK_QUERY_KEY, {
      active: current.queued[0] ?? null,
      queued: current.queued.slice(1),
    });
    if (mounted.current) setDecisionError(null);
    opQueue.current.push({ kind: 'decide', imageId: current.active.id, decision });
    refreshCanRewind();
    refreshCanDecide();
    void drainQueue();
    return true;
  }, [drainQueue, queryClient, refreshCanDecide, refreshCanRewind]);

  const rewind = useCallback((): boolean => {
    if (mounted.current) setDecisionError(null);
    // From refs, never render state: the second tap of a double tap must see
    // the op the first one just queued.
    if (rewindAvailability() <= 0) return false;
    // Pair with the newest swipe whose decide has not landed and that no other
    // queued press is paired with: this press is for that swipe, and it is
    // cancelled if the swipe's durable write fails instead of falling onto an
    // older save.
    const claimed = new Set<DecideOp>();
    for (const op of opQueue.current) {
      if (op.kind === 'rewind' && op.pairedDecide !== null) claimed.add(op.pairedDecide);
    }
    let pairedDecide: DecideOp | null = null;
    for (let index = opQueue.current.length - 1; index >= 0; index -= 1) {
      const op = opQueue.current[index] as PipelineOp;
      if (op.kind === 'decide' && op.outcome === undefined && !claimed.has(op)) {
        pairedDecide = op;
        break;
      }
    }
    opQueue.current.push({ kind: 'rewind', pairedDecide });
    refreshCanRewind();
    refreshCanDecide();
    void drainQueue();
    return true;
  }, [drainQueue, refreshCanDecide, refreshCanRewind, rewindAvailability]);

  const retry = useCallback(async () => {
    if (deckQuery.isError) {
      await deckQuery.refetch();
      return;
    }
    await refillQuery.refetch();
  }, [deckQuery, refillQuery]);

  const state = useMemo<DiscoveryState>(() => {
    if (deckQuery.isPending) return { kind: 'loading', deck: EMPTY_DECK };
    if (deckQuery.isError) return { kind: 'error', deck: EMPTY_DECK };

    if (deck.active !== null) return { kind: 'ready', deck };
    if (refillQuery.isError) {
      return {
        kind: isOfflineError(refillQuery.error) ? 'offline' : 'error',
        deck,
        message: discoveryProviderErrorMessage(refillQuery.error, t),
      };
    }
    if (refillQuery.data?.status === 'exhausted') {
      return {
        kind: 'exhausted',
        deck,
        message: t('discover.exhausted'),
      };
    }
    // R8.13: the deck is empty and the refill has SETTLED without an error
    // and without a usable deck (every candidate suppressed, or a duplicate-
    // only loop that never reached its exhaustion accounting). "Loading"
    // would be a lie — nothing is fetching and nothing will change the
    // screen. The honest terminal state is exhausted: no source has a
    // usable card right now.
    if (!refillQuery.isFetching && refillQuery.isSuccess && deckDepth(deck) === 0) {
      return {
        kind: 'exhausted',
        deck,
        message: t('discover.exhausted'),
      };
    }
    return { kind: 'loading', deck };
  }, [deck, deckQuery.isError, deckQuery.isPending, refillQuery.data, refillQuery.error, refillQuery.isError, refillQuery.isFetching, refillQuery.isSuccess, t]);

  return {
    state,
    isDeciding,
    canDecide,
    canRewind,
    decisionError,
    commitDecision,
    rewind,
    retry,
  };
}
