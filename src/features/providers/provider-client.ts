import type { TFunction } from 'i18next';

import type { fetchDanbooruBatch } from '@/features/danbooru/danbooru-client';
import type { fetchE621Batch } from '@/features/e621/e621-client';
import type { fetchE926Batch } from '@/features/e926/e926-client';
import {
  APP_DISTRIBUTION_POLICY,
  applyDistributionToSettings,
  type DistributionPolicy,
} from '@/features/distribution/distribution-policy';
import type { fetchKonachanBatch } from '@/features/konachan/konachan-client';
import type { fetchNekosBatch } from '@/features/nekos/nekos-client';
import { dedupeImageCandidates } from '@/features/providers/candidate-dedupe';
import {
  PROVIDER_DEGRADED_WEIGHT_FACTOR,
  PROVIDER_SHARE_FLOOR,
  planProviderShares,
} from '@/features/providers/provider-balancer';
import { providerLabel } from '@/features/providers/provider-label';
import type { ProviderRequestGovernor } from '@/features/providers/provider-resilience';
import {
  PROVIDER_REGISTRY,
  buildRegistry,
} from '@/features/providers/provider-registry';
import type { ProviderYieldStat } from '@/features/providers/provider-yield-ledger';
import type {
  ProviderAvailability,
  ProviderExclusions,
  DiscoveryBatch,
  DiscoveryProviderRound,
} from '@/features/providers/provider-adapter';
import type { fetchGelbooruBatch } from '@/features/gelbooru/gelbooru-client';
import type { ProviderCredentialMap } from '@/features/providers/provider-credentials';
import type { fetchSafebooruBatch } from '@/features/safebooru/safebooru-client';
import type { fetchYandereBatch } from '@/features/yandere/yandere-client';
import type { fetchWaifuBatch } from '@/features/waifu/waifu-client';
import { IMAGE_PROVIDER_ORDER } from '@/features/waifu/types';
import type {
  AppSettings,
  ImageCandidate,
  ImageProviderKey,
} from '@/features/waifu/types';
import i18n from '@/i18n';

export type {
  ProviderExclusions,
  DiscoveryBatch,
  DiscoveryProviderRound,
} from '@/features/providers/provider-adapter';

export type FetchDiscoveryBatchInput = {
  settings: AppSettings;
  excludedProviderIds: ProviderExclusions;
  excludedIds?: number[];
  /**
   * Required (G3b/S3+S10): the sole production caller
   * (`discovery-service.ts`'s refill loop) always supplies this — it was
   * only ever optional for tests that didn't care about per-provider
   * share sizing. Making it required at the type level is the proof that
   * the per-adapter `?? <formula>` defaults in `provider-registry.ts`
   * were dead code.
   *
   * G3c task2 gives it two more jobs beyond feeding the share plan: it is
   * the merge cap (`max(20, desiredCount)`) and the shortfall yardstick that
   * decides whether the bounded top-up wave runs at all.
   */
  desiredCount: number;
  /**
   * G3c §2.2 — the rolling per-source yield window from
   * `ProviderYieldLedger.stats()`, used to weight redistribution of the
   * capped sources' slack and to hold a cooling / persistently quiet source
   * at its floor-of-1 probe.
   *
   * Optional on purpose: an absent or empty map is a **cold start**, and
   * `planProviderShares` reads "no evidence" as weight 1 for everyone —
   * i.e. today's uniform behaviour modulo the cap clamp. G3c Task 3 wired the
   * real ledger in from `discovery-service.ts`, so production now supplies it
   * from the second round of a process onward; the first round still takes the
   * cold-start path, and tests that omit it get that same uniform behaviour.
   */
  yieldStats?: ReadonlyMap<ImageProviderKey, ProviderYieldStat>;
  /**
   * First-card streaming (spec 2026-09-16 §4): apply the rolling soft quota to
   * this round's WAVE-1 share plan. The discovery service sets it only for the
   * rounds converging away from a streamed cold first paint; it is never
   * applied to the opportunistic top-up wave, which stays yield-ranked. See
   * `SharePlanInput.softQuota` for why the default is off.
   */
  softQuota?: boolean;
  preferFirstUsable?: boolean;
  /**
   * K7 ⑰ — per-source delivery, called the moment that source's request
   * settles rather than after every source has.
   *
   * The aggregate promise still resolves once, with the merged and
   * fairness-ordered batch, because the merge, the bounded top-up wave and the
   * per-source round records are all round-level facts. What this removes is
   * the *delivery* gate: a caller that wants to show the fast sources'
   * cards no longer has to wait out the slowest one's 12 s deadline to see
   * that waifu.im answered in under a second.
   *
   * Only sources that returned at least one item are delivered; a failure or an
   * empty answer has nothing to hand over and is reported in `providerRounds`
   * on the aggregate instead. A throwing callback is swallowed: an observer
   * must never turn a good round into a failed one.
   */
  onSourceSettled?: (delivery: DiscoverySourceDelivery) => void;
  signal?: AbortSignal;
};

/** One source's contribution to a round (K7 ⑰). */
export type DiscoverySourceDelivery = Readonly<{
  providerKey: ImageProviderKey;
  items: readonly ImageCandidate[];
}>;

/** Shared empty snapshot for the cold-start path — avoids a per-call Map. */
const NO_YIELD_STATS: ReadonlyMap<ImageProviderKey, ProviderYieldStat> =
  new Map();

export type DiscoveryProviderFetcher = (
  input: FetchDiscoveryBatchInput,
) => Promise<DiscoveryBatch>;

type ProviderClientDependencies = {
  fetchWaifu?: typeof fetchWaifuBatch;
  fetchNekos?: typeof fetchNekosBatch;
  fetchDanbooru?: typeof fetchDanbooruBatch;
  fetchSafebooru?: typeof fetchSafebooruBatch;
  fetchYandere?: typeof fetchYandereBatch;
  fetchKonachan?: typeof fetchKonachanBatch;
  fetchE621?: typeof fetchE621Batch;
  fetchE926?: typeof fetchE926Batch;
  fetchGelbooru?: typeof fetchGelbooruBatch;
  governor?: ProviderRequestGovernor;
  distributionPolicy?: DistributionPolicy;
  /**
   * G4 — synchronous snapshot accessor for the credential map. A function,
   * not a value: app-services holds a live ref refreshed on save/clear, and
   * each refill reads the current snapshot without an async seam in the
   * fan-out.
   */
  credentials?: () => ProviderCredentialMap;
};

export type DiscoveryProviderFailure = {
  providerKey: ImageProviderKey;
  code: string;
  message: string;
  status?: number;
  retryAfterMs?: number;
};

export type DiscoveryProviderErrorCode =
  | 'network'
  | 'rate_limited'
  | 'provider';

export class DiscoveryProviderError extends Error {
  readonly code: DiscoveryProviderErrorCode;
  readonly failures: readonly DiscoveryProviderFailure[];
  readonly retryAfterMs?: number;

  constructor(failures: readonly DiscoveryProviderFailure[]) {
    const labels = failures.map((failure) => providerLabel(failure.providerKey));
    super(`No usable result from ${labels.join(', ')}`);
    this.name = 'DiscoveryProviderError';
    this.failures = failures;
    this.code = classifyProviderFailures(failures);
    const retryAfterValues = failures.flatMap((failure) =>
      typeof failure.retryAfterMs === 'number' &&
        Number.isFinite(failure.retryAfterMs) &&
        failure.retryAfterMs >= 0
        ? [failure.retryAfterMs]
        : [],
    );
    this.retryAfterMs = retryAfterValues.length > 0
      ? Math.min(...retryAfterValues)
      : undefined;
    Object.setPrototypeOf(this, DiscoveryProviderError.prototype);
  }
}

function isTransientProviderFailure(failure: DiscoveryProviderFailure): boolean {
  return failure.code === 'network' ||
    failure.code === 'timeout' ||
    failure.code === 'rate_limited' ||
    failure.status === 429 ||
    (typeof failure.status === 'number' && failure.status >= 500);
}

function classifyProviderFailures(
  failures: readonly DiscoveryProviderFailure[],
): DiscoveryProviderErrorCode {
  if (failures.length === 0 || !failures.every(isTransientProviderFailure)) {
    return 'provider';
  }
  if (failures.some(
    (failure) => failure.code === 'rate_limited' || failure.status === 429,
  )) {
    return 'rate_limited';
  }
  return 'network';
}

function providerFailure(
  providerKey: ImageProviderKey,
  error: unknown,
): DiscoveryProviderFailure {
  const details = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  const code = typeof details?.code === 'string'
    ? details.code
    : 'provider';
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof details?.status === 'number' && Number.isFinite(details.status)
    ? details.status
    : undefined;
  const retryAfterMs = typeof details?.retryAfterMs === 'number' &&
      Number.isFinite(details.retryAfterMs) &&
      details.retryAfterMs >= 0
    ? details.retryAfterMs
    : undefined;
  return { providerKey, code, message, status, retryAfterMs };
}

export function discoveryProviderErrorMessage(
  error: unknown,
  t: TFunction = i18n.t,
): string | undefined {
  if (!(error instanceof DiscoveryProviderError)) return undefined;
  const labels = [...new Set(
    error.failures.map((failure) => providerLabel(failure.providerKey)),
  )].join(t('common.listSeparator'));
  if (error.code === 'network') {
    return t('discover.providerNetwork', { providers: labels });
  }
  if (error.code === 'rate_limited') {
    return t('discover.providerRateLimited', { providers: labels });
  }
  return t('discover.providerUnavailable', { providers: labels });
}

/**
 * Index-major merge across the per-source buckets, then cross-source dedupe.
 *
 * The cap is `max(20, desiredCount)` (G3 spec §2.6-1, fixing S1's S4): the
 * old hard `20` silently threw away everything a caller asked for beyond 20,
 * and because the merge is index-major the discarded tail is always the
 * *registry-tail sources' deeper cards* — the same sources the share plan just
 * worked to keep in the deck. The `20` floor is kept so a small `desiredCount`
 * still allows the caller a little headroom for its own dedupe losses, exactly
 * as before.
 */
function mergeProviderItems(
  batches: readonly (readonly ImageCandidate[])[],
  desiredCount: number,
): ImageCandidate[] {
  const items: ImageCandidate[] = [];
  const maxLength = Math.max(0, ...batches.map((batch) => batch.length));
  for (let index = 0; index < maxLength; index += 1) {
    for (const batch of batches) {
      const image = batch[index];
      if (!image) continue;
      items.push(image);
    }
  }
  const cap = Number.isFinite(desiredCount)
    ? Math.max(20, Math.trunc(desiredCount))
    : 20;
  return dedupeImageCandidates(items, IMAGE_PROVIDER_ORDER).slice(0, cap);
}

/**
 * Ordering key for the bounded top-up probe list (G3c §2.3). **Not** an
 * apportionment — `planProviderShares` still decides how many items each
 * chosen source is asked for. This only decides *which* capped sources get
 * into a probe list that is deliberately shorter than the target set.
 *
 * Recent effective yield, halved for a `degraded` source, so the shortfall is
 * probed at the sources most likely to answer it. No stats (cold start) reads
 * as 1 for everyone, which collapses the order to registry order — the same
 * deterministic tie-break the planner uses.
 *
 * Deliberately **unclamped**, unlike the planner's `[0.15, 1]` weight: the
 * floor exists there so a thin source is never apportioned toward zero, but
 * for a pure ordering it would flatten every source below 0.15 into a tie and
 * destroy exactly the distinction being ranked. Ordering is a heuristic; the
 * floor and cap invariants that matter live in the planner.
 */
function topUpPriority(
  stat: ProviderYieldStat | undefined,
  availability: ProviderAvailability,
): number {
  const yieldRate = stat === undefined || stat.requested === 0
    ? 1
    : stat.admitted / Math.max(1, stat.requested);
  return availability.state === 'degraded'
    ? yieldRate * PROVIDER_DEGRADED_WEIGHT_FACTOR
    : yieldRate;
}

export function createDiscoveryProviderFetcher({
  fetchWaifu,
  fetchNekos,
  fetchDanbooru,
  fetchSafebooru,
  fetchYandere,
  fetchKonachan,
  fetchE621,
  fetchE926,
  fetchGelbooru,
  governor,
  distributionPolicy = APP_DISTRIBUTION_POLICY,
  credentials,
}: ProviderClientDependencies = {}): DiscoveryProviderFetcher {
  const hasOverride = Boolean(
    fetchWaifu || fetchNekos || fetchDanbooru || fetchSafebooru || fetchYandere || fetchKonachan || fetchE621 || fetchE926 || fetchGelbooru,
  );
  const registry = hasOverride
    ? buildRegistry({ fetchWaifu, fetchNekos, fetchDanbooru, fetchSafebooru, fetchYandere, fetchKonachan, fetchE621, fetchE926, fetchGelbooru })
    : PROVIDER_REGISTRY;
  return async ({
    settings: requestedSettings,
    excludedProviderIds,
    desiredCount,
    yieldStats,
    softQuota = false,
    preferFirstUsable = false,
    onSourceSettled,
    signal,
  }) => {
    const settings = applyDistributionToSettings(
      requestedSettings,
      distributionPolicy,
    );
    // Read once per call, not per adapter: a live snapshot accessor (not a
    // frozen value) so a key saved mid-session takes effect on the next
    // refill without re-creating the fetcher (G4 spec §2.2).
    const credentialMap = credentials?.() ?? {};
    // Admission gate (G3a §2.1): a source whose corpus is structurally unable
    // to satisfy the current settings (e.g. Konachan has no portrait images)
    // is skipped entirely — no request, and excluded from the share plan's
    // denominator so the remaining sources' share isn't silently shrunk by a
    // source that would return zero anyway. `degraded` sources participate;
    // G3c halves their redistribution weight inside `planProviderShares`.
    // `availabilityFor` is evaluated exactly once per adapter and carried, so
    // admission and weighting can never disagree about the same round.
    const enabledAdapters = registry.filter(
      (adapter) => settings.providers[adapter.key],
    );
    const admissions = enabledAdapters.flatMap((adapter) => {
      const availability = adapter.availabilityFor(settings);
      return availability.state === 'unavailable'
        ? []
        : [{ adapter, availability }];
    });
    const admittedAdapters = admissions.map(({ adapter }) => adapter);
    const anyProviderEnabled = enabledAdapters.length > 0;
    // G3 spec §4 — accounting only, no scheduling effect. The enabled sources the
    // capability gate skipped this round issued no request and consumed no share;
    // without this the yield ledger cannot tell "skipped" from "never enabled".
    const admittedKeys = new Set(admittedAdapters.map((adapter) => adapter.key));
    const skippedRounds: DiscoveryProviderRound[] = enabledAdapters.flatMap(
      (adapter) => admittedKeys.has(adapter.key)
        ? []
        : [{
          providerKey: adapter.key,
          requested: 0,
          returned: 0,
          admitted: 0,
          outcome: 'skipped_capability' as const,
        }],
    );
    const stats = yieldStats ?? NO_YIELD_STATS;
    // G3c §2.2 — the uniform `ceil(desiredCount / providerCount)` scalar is
    // gone. The plan clamps each source to its declared `maxDiscoveryBatch`
    // and hands the freed slack to the sources that still have headroom,
    // weighted by recent yield, with a floor of 1 per admitted source.
    const shares = planProviderShares({
      admitted: admissions.map(({ adapter, availability }) => ({
        key: adapter.key,
        cap: adapter.maxDiscoveryBatch,
        availability,
      })),
      desiredCount,
      stats,
      // Wave 1 only. The top-up plan below is deliberately yield-ranked
      // (G3c §2.3) and never sees the quota.
      softQuota,
    });
    const availabilityByKey = new Map<ImageProviderKey, ProviderAvailability>(
      admissions.map(({ adapter, availability }) => [adapter.key, availability]),
    );
    const firstUsableController = preferFirstUsable ? new AbortController() : null;
    const onCallerAbort = () => firstUsableController?.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) firstUsableController?.abort();
    const requestSignal = firstUsableController?.signal ?? signal;
    const requests: {
      providerKey: ImageProviderKey;
      /** This source's declared per-round ceiling — the top-up's headroom base. */
      cap: number;
      /** First-wave share from the plan. */
      share: number;
      promise: Promise<DiscoveryBatch>;
    }[] = [];
    for (const adapter of admittedAdapters) {
      // `??` is unreachable: the plan holds every admitted key by construction
      // (its floor invariant). Kept as a floor rather than a `!` so a future
      // plan bug degrades to "ask for one" instead of `undefined`.
      const count = shares.get(adapter.key) ?? PROVIDER_SHARE_FLOOR;
      requests.push({
        providerKey: adapter.key,
        cap: adapter.maxDiscoveryBatch,
        share: count,
        promise: adapter.fetchDiscoveryBatch({
          settings,
          excludedProviderIds,
          count,
          signal: requestSignal,
          distributionPolicy,
          ...(governor ? { governor } : {}),
          ...(credentialMap[adapter.key] ? { credential: credentialMap[adapter.key] } : {}),
        }),
      });
    }
    if (requests.length === 0) {
      // Two distinct cases share an empty admitted set:
      // - genuinely no provider is enabled: the message below is true, keep throwing.
      // - >=1 provider is enabled but every enabled one is `unavailable` under the
      //   current settings (e.g. Konachan-only + portrait): throwing here would be
      //   false ("no provider is enabled") and surfaces a Retry that can never
      //   succeed. Resolve to an honest empty batch instead so callers reach the
      //   normal exhausted/empty state; the Settings row already explains why.
      if (!anyProviderEnabled) {
        throw new Error('No image provider is enabled');
      }
      signal?.removeEventListener('abort', onCallerAbort);
      return { items: [], totalCount: 0, providerRounds: skippedRounds };
    }

    const deliver = (index: number, batch: DiscoveryBatch): void => {
      if (onSourceSettled === undefined || batch.items.length === 0) return;
      try {
        onSourceSettled({
          providerKey: requests[index]!.providerKey,
          items: batch.items,
        });
      } catch {
        // An observer must not affect the round it is observing.
      }
    };
    const tracked = requests.map((request, index) => request.promise.then(
      (batch) => {
        // K7 ⑰ — inside the `then`, so this runs on the tick that source
        // settled, not on the tick the whole fan-out settles.
        deliver(index, batch);
        return { status: 'fulfilled' as const, index, batch };
      },
      (reason: unknown) => ({ status: 'rejected' as const, index, reason }),
    ));
    if (preferFirstUsable) {
      // No `providerRounds` on this path: it returns as soon as one source is
      // usable, so the others' rounds would be unfinished rather than zero.
      // Discovery always passes `preferFirstUsable: false`, so the ledger is
      // never fed a half-observed round.
      const pending = new Map(tracked.map((promise, index) => [index, promise]));
      const failures: DiscoveryProviderFailure[] = [];
      let totalCount = 0;
      try {
        while (pending.size > 0) {
          const result = await Promise.race(pending.values());
          pending.delete(result.index);
          if (signal?.aborted) {
            if (result.status === 'rejected') throw result.reason;
            throw new Error('Discovery request was aborted');
          }
          if (result.status === 'rejected') {
            failures.push(providerFailure(
              requests[result.index]!.providerKey,
              result.reason,
            ));
            continue;
          }
          totalCount += result.batch.totalCount;
          if (result.batch.items.length > 0) {
            firstUsableController?.abort();
            return result.batch;
          }
        }
        if (failures.length > 0) throw new DiscoveryProviderError(failures);
        return { items: [], totalCount };
      } finally {
        signal?.removeEventListener('abort', onCallerAbort);
      }
    }

    const settled = await Promise.all(tracked);
    signal?.removeEventListener('abort', onCallerAbort);
    // One mutable accumulator per asked source, in registry order. The top-up
    // wave appends into these same slots, which is what makes `providerRounds`
    // one record per provider **per call** (see the comment on the round build
    // below) and keeps the merge's per-source bucket shape intact.
    const tallies = settled.map((result, index) => {
      const request = requests[index]!;
      if (result.status === 'fulfilled') {
        return {
          providerKey: request.providerKey,
          requested: request.share,
          returned: result.batch.totalCount,
          items: [...result.batch.items],
          outcome: 'ok' as DiscoveryProviderRound['outcome'],
          succeeded: true,
          // Declared on both branches so the tally shape stays homogeneous; an
          // `ok` round has no failure to report.
          failureCode: undefined as string | undefined,
          failureStatus: undefined as number | undefined,
        };
      }
      // A governor cooldown and a provider 429 are the same fact for the
      // ledger: the source was never really asked, so it should keep its floor
      // rather than look unproductive. Everything else is a plain failure —
      // HTTP health itself stays provider-resilience's job.
      const failure = providerFailure(request.providerKey, result.reason);
      return {
        providerKey: request.providerKey,
        requested: request.share,
        returned: 0,
        items: [] as ImageCandidate[],
        outcome: (failure.code === 'rate_limited' || failure.status === 429
          ? 'cooldown'
          : 'failed') as DiscoveryProviderRound['outcome'],
        succeeded: false,
        // Carried for diagnosis only. Until now this reason died here unless
        // EVERY source failed, which is why a single silent source could not be
        // told apart from one that was never asked — see DiscoveryProviderRound.
        failureCode: failure.code,
        failureStatus: failure.status,
      };
    });
    const requestFailures = settled.flatMap((result, index) =>
      result.status === 'rejected'
        ? [providerFailure(requests[index]!.providerKey, result.reason)]
        : [],
    );
    if (signal?.aborted) {
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      throw new Error('Discovery request was aborted');
    }
    const failures = requestFailures;
    // Board #19 — the round is an error only when EVERY admitted source
    // failed. If any source answered, even with zero usable posts, the round
    // resolves (possibly empty) and the failures stay visible in
    // `providerRounds`; the discovery loop's duplicate-only accounting then
    // settles a genuinely dry deck as `exhausted` 「暂时没有新图片」 instead
    // of blaming one unreachable source for a pool that is simply drained.
    if (tallies.every((tally) => !tally.succeeded)) {
      throw new DiscoveryProviderError(failures);
    }
    let items = mergeProviderItems(
      tallies.map((tally) => tally.items),
      desiredCount,
    );

    // G3c §2.3 — ONE bounded top-up wave, never two.
    //
    // A source qualifies only when it (a) succeeded, (b) returned *exactly*
    // its share — the signature of being capped rather than exhausted — and
    // (c) has headroom left under its declared `maxDiscoveryBatch`. The spec
    // phrases the target set as "only providers that succeeded and have
    // `cap − share > 0`"; that is an upper bound, and this is a strict subset
    // of it. A source that answered with fewer items than it was asked for
    // has already told us it has nothing more this round, and re-asking it is
    // precisely the blind uniform re-ask §2.3 exists to delete. The empty and
    // rejected sources are excluded for the same reason.
    //
    // Because every share is >= 1 (the plan's floor invariant), qualifying at
    // all requires having returned at least one item, so this branch can never
    // fire on an all-empty round.
    const topUpTargets = tallies.flatMap((tally, index) => {
      const request = requests[index]!;
      const headroom = request.cap - request.share;
      const availability = availabilityByKey.get(request.providerKey)
        ?? { state: 'available' as const };
      return tally.succeeded &&
        headroom > 0 &&
        tally.items.length === request.share
        ? [{
          index,
          key: tally.providerKey,
          headroom,
          availability,
          priority: topUpPriority(stats.get(tally.providerKey), availability),
        }]
        : [];
    });
    const shortfall = desiredCount - items.length;
    // No `signal?.aborted` guard here on purpose: the wave-1 abort check above
    // already throws, and nothing between it and this line awaits, so a guard
    // would be unreachable. The reachable window is *after* the wave-2 await,
    // and that one is checked below.
    if (shortfall > 0 && topUpTargets.length > 0) {
      // FAN-OUT BOUND (spec §6.3-5 counts *calls*, not units). The planner's
      // floor of 1 means every source in the plan costs at least one request,
      // so planning over all T targets for a shortfall of S issues T calls to
      // close an S-item gap — 8 admitted sources short by 2 after dedupe would
      // spend 6 extra calls on 2 cards, which is the opposite of calm. Bound
      // the probe list to S first, so the wave costs `min(T, S)` calls and can
      // never out-spend the gap it is closing.
      //
      // Which S: the most productive capped sources, by recent effective
      // yield, ties broken by registry order (and at cold start every priority
      // is 1, so the order simply *is* registry order). Probing the sources
      // most likely to answer is what makes a shorter list as good as the long
      // one. This does not starve anyone — every admitted source already got
      // its floor-of-1 share in wave 1; the top-up is opportunistic top-up,
      // not the fairness mechanism.
      const probes = [...topUpTargets]
        .sort((left, right) => right.priority - left.priority
          || left.index - right.index)
        .slice(0, shortfall);
      // Sized by the SAME `planProviderShares`, with each probe's `cap` set to
      // its *remaining* headroom, so no source can be asked past its declared
      // per-round ceiling across the two waves combined, and the shortfall is
      // still split by recent yield with the degraded/cooldown rules intact.
      // With `probes.length <= shortfall`, the planner's floor can no longer
      // over-ask: the CALL count is exactly min(targets, shortfall) — the quantity spec §6.3-5 measures; requested units can exceed the shortfall by at most targets−1 when targets < shortfall (base=ceil rounding).
      const topUpPlan = planProviderShares({
        admitted: probes.map((probe) => ({
          key: probe.key,
          cap: probe.headroom,
          availability: probe.availability,
        })),
        desiredCount: shortfall,
        stats,
      });
      // What wave 1 already returned is a known duplicate for wave 2. Feeding
      // it back as an exclusion is what makes the top-up productive rather
      // than a re-fetch of the same posts; the per-source list is capped the
      // same way the discovery-service caps its own (100).
      const topUpExclusions: ProviderExclusions = { ...excludedProviderIds };
      for (const probe of probes) {
        const tally = tallies[probe.index]!;
        topUpExclusions[probe.key] = [...new Set([
          ...tally.items.map((item) => item.providerItemId),
          ...(excludedProviderIds[probe.key] ?? []),
        ])].slice(0, 100);
      }
      const topUps = probes.flatMap((probe) => {
        const adapter = admittedAdapters.find(
          (candidate) => candidate.key === probe.key,
        );
        const count = topUpPlan.get(probe.key) ?? 0;
        if (!adapter || count <= 0) return [];
        return [{
          probe,
          count,
          promise: adapter.fetchDiscoveryBatch({
            settings,
            excludedProviderIds: topUpExclusions,
            count,
            signal: requestSignal,
            distributionPolicy,
            ...(governor ? { governor } : {}),
            ...(credentialMap[adapter.key] ? { credential: credentialMap[adapter.key] } : {}),
          }).then(
            (batch) => ({ status: 'fulfilled' as const, batch }),
            () => ({ status: 'rejected' as const }),
          ),
        }];
      });
      const toppedUp = await Promise.all(topUps.map(({ promise }) => promise));
      // The caller can abort during the wave-2 await. Same contract as wave 1:
      // an aborted call does not deliver. This is distinct from a *provider*
      // rejecting its top-up, which is swallowed below — an opportunistic
      // second ask must never turn a good round into an error, but a caller
      // cancelling the round still cancels it.
      if (signal?.aborted) throw new Error('Discovery request was aborted');
      for (let position = 0; position < topUps.length; position += 1) {
        const { probe, count } = topUps[position]!;
        const result = toppedUp[position]!;
        const tally = tallies[probe.index]!;
        // `requested` counts what we actually asked for, whether or not the
        // source answered: the ledger's weight is `admitted / requested`, and a
        // source that could not answer a second ask really did yield less per
        // request. A rejected top-up does NOT flip `outcome` — the round did
        // produce items, and an opportunistic second ask must never turn a
        // good round into a failure or a false quiet signal.
        tally.requested += count;
        if (result.status !== 'fulfilled') continue;
        tally.returned += result.batch.totalCount;
        tally.items.push(...result.batch.items);
      }
      // Re-merge across both waves. No third wave exists: `topUpTargets` is
      // computed once, from the first wave only, and nothing below re-enters
      // this branch.
      items = mergeProviderItems(
        tallies.map((tally) => tally.items),
        desiredCount,
      );
    }

    // G3 spec §4 — per-provider accounting, written after every decision above
    // is already made. `admitted` is each source's own post-filter count
    // (before the cross-source dedupe and merge cap), which is what "survived
    // matchesCandidateSettings" means for that source.
    //
    // ONE RECORD PER PROVIDER PER CALL, not per wave: the ledger's window is
    // measured in refill rounds, and the top-up is an implementation detail of
    // a single round, not a round of its own. Splitting it would double-count
    // one refill against `PROVIDER_YIELD_WINDOW_ROUNDS` and let a topped-up
    // source age out of the window at twice the rate of everyone else. So
    // `requested` is the summed ask across both waves and `admitted` /
    // `returned` are the summed answers.
    const providerRounds: DiscoveryProviderRound[] = [
      ...tallies.map((tally): DiscoveryProviderRound => ({
        providerKey: tally.providerKey,
        requested: tally.requested,
        returned: tally.returned,
        admitted: tally.items.length,
        outcome: tally.outcome,
        // Omitted entirely on an `ok` round rather than carried as undefined,
        // so a round record never suggests a failure that did not happen.
        ...(tally.failureCode === undefined ? {} : { failureCode: tally.failureCode }),
        ...(tally.failureStatus === undefined ? {} : { failureStatus: tally.failureStatus }),
      })),
      ...skippedRounds,
    ];
    return {
      items,
      totalCount: tallies.reduce((total, tally) => total + tally.returned, 0),
      providerRounds,
    };
  };
}

export const fetchDiscoveryBatch = createDiscoveryProviderFetcher();
