import {
  candidateContentRating,
  strongerContentRating,
} from '@/features/content/content-taxonomy';
import type {
  ContentRating,
  ImageCandidate,
  ImageProviderKey,
} from '@/features/waifu/types';

function identityTokens(candidate: ImageCandidate): string[] {
  return [
    `provider:${candidate.providerKey}:${candidate.providerItemId}`,
    ...(candidate.canonicalSourceKey
      ? [`source:${candidate.canonicalSourceKey}`]
      : []),
    ...(candidate.perceptualHash ? [`hash:${candidate.perceptualHash}`] : []),
    ...(candidate.md5 ? [`md5:${candidate.md5}`] : []),
  ];
}

/**
 * Provider order for the §3.3 final tie-break. Injected, never imported here:
 * `PROVIDER_REGISTRY` depends (transitively) on this module via
 * `provider-client.ts`, so importing it back would be a cycle. Callers that have
 * the registry pass its key order; an empty default keeps the module usable
 * standalone (the tie-break then falls through to `providerItemId`).
 */
export type ProviderOrder = readonly ImageProviderKey[];

function providerRank(order: ProviderOrder, key: ImageProviderKey): number {
  const index = order.indexOf(key);
  // Unknown provider sorts last, deterministically, rather than winning ties.
  return index === -1 ? order.length : index;
}

/**
 * §3.3 — decide whether `challenger` should replace `incumbent` as the surviving
 * copy of one clustered image, by a deterministic quality comparator (NOT
 * first-seen). Pure: no clock, no RNG, so a re-render on shuffled input cannot
 * reshuffle the grid.
 *
 *   1. larger `width * height`
 *   2. tie -> has `md5` (stronger downstream identity, feeds G2b)
 *   3. tie -> has `artistName`
 *   4. tie -> lower provider-order index
 *   5. tie -> lower `providerItemId` lexically — a final TOTAL tie-break so the
 *      outcome is order-independent even when two same-provider copies collide.
 *      (Spec lists tiers 1-4; this only decides a full 1-4 tie, never overrides them.)
 */
function survivorIsChallenger(
  incumbent: ImageCandidate,
  challenger: ImageCandidate,
  order: ProviderOrder,
): boolean {
  const areaI = incumbent.width * incumbent.height;
  const areaC = challenger.width * challenger.height;
  if (areaC !== areaI) return areaC > areaI;

  const md5I = incumbent.md5 !== null;
  const md5C = challenger.md5 !== null;
  if (md5C !== md5I) return md5C;

  const artI = incumbent.artistName !== null;
  const artC = challenger.artistName !== null;
  if (artC !== artI) return artC;

  const rankI = providerRank(order, incumbent.providerKey);
  const rankC = providerRank(order, challenger.providerKey);
  if (rankC !== rankI) return rankC < rankI;

  return challenger.providerItemId < incumbent.providerItemId;
}

/**
 * Fold `incoming` into `retained`: pick the survivor value, then apply the
 * merged (never-weakened) rating onto the survivor's image. A `pinned` value
 * (already shown on screen — see `reconcileStableSearchHits`) always survives so
 * a late-arriving duplicate cannot flip a visible tile's identity; otherwise the
 * §3.3 quality comparator decides. `strongerContentRating` is a max, so folding
 * incrementally across a cluster yields the strongest rating regardless of order.
 */
function foldCluster<T>(
  retained: T,
  incoming: T,
  imageFor: (value: T) => ImageCandidate,
  withImage: (value: T, image: ImageCandidate) => T,
  order: ProviderOrder,
  isPinned: (value: T) => boolean,
): T {
  const retainedImage = imageFor(retained);
  const incomingImage = imageFor(incoming);
  const pinnedRetained = isPinned(retained);
  const pinnedIncoming = isPinned(incoming);
  // A pinned survivor is never demoted; only an unpinned-vs-unpinned (or a
  // pinned challenger displacing an unpinned incumbent) contest reaches quality.
  const takeIncoming = pinnedRetained
    ? false
    : pinnedIncoming
      ? true
      : survivorIsChallenger(retainedImage, incomingImage, order);
  const survivorValue = takeIncoming ? incoming : retained;
  const survivorImage = imageFor(survivorValue);

  const contentRating = strongerContentRating(
    candidateContentRating(retainedImage),
    candidateContentRating(incomingImage),
  );
  const isNsfw = contentRating !== 'safe';
  if (
    survivorImage.contentRating === contentRating &&
    survivorImage.isNsfw === isNsfw
  ) {
    return survivorValue;
  }
  return withImage(survivorValue, { ...survivorImage, contentRating, isNsfw });
}

function applyContentRating<T>(
  value: T,
  contentRating: ContentRating,
  imageFor: (value: T) => ImageCandidate,
  withImage: (value: T, image: ImageCandidate) => T,
): T {
  const image = imageFor(value);
  const isNsfw = contentRating !== 'safe';
  if (image.contentRating === contentRating && image.isNsfw === isNsfw) {
    return value;
  }
  return withImage(value, { ...image, contentRating, isNsfw });
}

type CandidateCluster<T> = {
  value: T;
  tokens: Set<string>;
};

export function dedupeByCandidateIdentity<T>(
  values: readonly T[],
  imageFor: (value: T) => ImageCandidate,
  withImage: (value: T, image: ImageCandidate) => T,
  order: ProviderOrder = [],
  isPinned: (value: T) => boolean = () => false,
): T[] {
  const clusters: CandidateCluster<T>[] = [];

  for (const value of values) {
    const image = imageFor(value);
    const tokens = identityTokens(image);
    const matching = clusters
      .map((cluster, index) => ({ cluster, index }))
      .filter(({ cluster }) => tokens.some((token) => cluster.tokens.has(token)));

    if (matching.length === 0) {
      clusters.push({ value, tokens: new Set(tokens) });
      continue;
    }

    let strongestRating = candidateContentRating(image);
    for (const { cluster } of matching) {
      strongestRating = strongerContentRating(
        strongestRating,
        candidateContentRating(imageFor(cluster.value)),
      );
    }

    const pinnedMatching = matching.filter(({ cluster }) => isPinned(cluster.value));
    if (isPinned(value) && pinnedMatching.length > 0) {
      const ratedValue = applyContentRating(value, strongestRating, imageFor, withImage);
      for (const { cluster } of pinnedMatching) {
        cluster.value = applyContentRating(
          cluster.value,
          strongestRating,
          imageFor,
          withImage,
        );
      }
      clusters.push({ value: ratedValue, tokens: new Set(tokens) });
      continue;
    }

    const primary = (pinnedMatching[0] ?? matching[0]!).cluster;
    primary.value = foldCluster(primary.value, value, imageFor, withImage, order, isPinned);
    for (const token of tokens) primary.tokens.add(token);

    const mergeable = matching
      .filter(({ cluster }) => cluster !== primary && !isPinned(cluster.value))
      .sort((left, right) => right.index - left.index);
    for (const { cluster, index } of mergeable) {
      primary.value = foldCluster(
        primary.value,
        cluster.value,
        imageFor,
        withImage,
        order,
        isPinned,
      );
      for (const token of cluster.tokens) primary.tokens.add(token);
      clusters.splice(index, 1);
    }

    primary.value = applyContentRating(
      primary.value,
      strongestRating,
      imageFor,
      withImage,
    );
    for (const { cluster } of pinnedMatching) {
      if (cluster !== primary) {
        cluster.value = applyContentRating(
          cluster.value,
          strongestRating,
          imageFor,
          withImage,
        );
      }
    }
  }

  return clusters.map(({ value }) => value);
}

export function dedupeImageCandidates<T extends ImageCandidate>(
  candidates: readonly T[],
  order: ProviderOrder = [],
): T[] {
  return dedupeByCandidateIdentity(
    candidates,
    (candidate) => candidate,
    (_candidate, image) => image as T,
    order,
  );
}
