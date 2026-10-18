import {
  APP_DISTRIBUTION_POLICY,
  allowedNsfwMode,
  type DistributionPolicy,
} from '@/features/distribution/distribution-policy';
import type { StoredImage } from '@/features/images/image-repository';
import type { LibraryEntry } from '@/features/library/library-view-model';
import {
  isImageProviderKey,
  type ImageProviderKey,
  type NsfwMode,
} from '@/features/waifu/types';

export type CollectionSearchField = 'all' | 'artist' | 'tag';
export type CollectionSort = 'newest' | 'oldest' | 'resolution' | 'fileSize';
export type CollectionProvider = ImageProviderKey | 'imports' | 'all';

export function isCollectionProvider(
  value: string,
): value is CollectionProvider {
  return value === 'all' || value === 'imports' || isImageProviderKey(value);
}

export type CollectionBrowserQuery = {
  text: string;
  field: CollectionSearchField;
  mode: NsfwMode;
  provider: CollectionProvider;
  sort: CollectionSort;
};

export const DEFAULT_COLLECTION_QUERY: CollectionBrowserQuery = {
  text: '',
  field: 'all',
  mode: 'mixed',
  provider: 'all',
  sort: 'newest',
};

export function normalizeCollectionBrowserQuery(
  input: Partial<CollectionBrowserQuery> | undefined,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): CollectionBrowserQuery {
  return {
    text: input?.text ?? DEFAULT_COLLECTION_QUERY.text,
    field: input?.field ?? DEFAULT_COLLECTION_QUERY.field,
    mode: allowedNsfwMode(input?.mode ?? DEFAULT_COLLECTION_QUERY.mode, policy),
    provider: input?.provider ?? DEFAULT_COLLECTION_QUERY.provider,
    sort: input?.sort ?? DEFAULT_COLLECTION_QUERY.sort,
  };
}

export type CollectionItem =
  | Readonly<{
      kind: 'image';
      key: `image:${number}`;
      image: StoredImage;
    }>
  | Readonly<{
      kind: 'import';
      key: `import:${string}`;
      entry: LibraryEntry;
    }>
  | Readonly<{
      kind: 'legacy';
      key: `legacy:${string}`;
      entry: LibraryEntry;
    }>;

const PROVIDER_SEARCH_NAMES: Record<ImageProviderKey, readonly string[]> = {
  waifu_im: ['waifu.im', 'waifu im', 'waifu_im'],
  nekos_api: ['nekos.api', 'nekos api', 'nekos_api'],
  danbooru: ['danbooru'],
  safebooru: ['safebooru', 'safe booru'],
  yandere: ['yande.re', 'yandere', 'yande re'],
  konachan: ['konachan'],
  e621: ['e621'],
  e926: ['e926'],
  gelbooru: ['gelbooru'],
  rule34: ['rule34'],
};

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function recentOrder(left: StoredImage, right: StoredImage): number {
  return (right.decidedAt ?? 0) - (left.decidedAt ?? 0)
    || (right.decisionOrdinal ?? 0) - (left.decisionOrdinal ?? 0)
    || right.id - left.id;
}

function oldestOrder(left: StoredImage, right: StoredImage): number {
  return (left.decidedAt ?? Number.MAX_SAFE_INTEGER)
      - (right.decidedAt ?? Number.MAX_SAFE_INTEGER)
    || (left.decisionOrdinal ?? Number.MAX_SAFE_INTEGER)
      - (right.decisionOrdinal ?? Number.MAX_SAFE_INTEGER)
    || left.id - right.id;
}

function searchableValues(
  image: StoredImage,
  field: CollectionSearchField,
): readonly string[] {
  if (field === 'artist') return image.artistName ? [image.artistName] : [];
  if (field === 'tag') return image.tags;
  return [
    ...(image.artistName ? [image.artistName] : []),
    ...image.tags,
    ...PROVIDER_SEARCH_NAMES[image.providerKey],
  ];
}

/**
 * K7 cut 5b (audit ㉚): the normalized searchable text of each row, computed
 * once per `images` reference and search field.
 *
 * Every keystroke used to re-run `normalize('NFKC').trim().toLocaleLowerCase()`
 * over every artist, tag and provider name of every saved image — a JNI hop
 * per value on Hermes — while a controlled TextInput waited on the result. The
 * rows do not change between keystrokes; only the query does.
 *
 * The cache hangs off the array identity, so a new snapshot (a save, a delete,
 * a sync) is normalized afresh and an old one is collected with it.
 */
const haystacksByImages = new WeakMap<
  readonly StoredImage[],
  Map<CollectionSearchField, readonly string[]>
>();

function collectionHaystacks(
  images: readonly StoredImage[],
  field: CollectionSearchField,
): readonly string[] {
  let byField = haystacksByImages.get(images);
  if (byField === undefined) {
    byField = new Map();
    haystacksByImages.set(images, byField);
  }
  const cached = byField.get(field);
  if (cached !== undefined) return cached;
  const haystacks = images.map((image) => searchableValues(image, field)
    .map(normalizeSearchText)
    .join('\n'));
  byField.set(field, haystacks);
  return haystacks;
}

const haystacksByImageRef = new WeakMap<
  StoredImage,
  Map<CollectionSearchField, string>
>();

function imageHaystack(
  image: StoredImage,
  field: CollectionSearchField,
): string {
  let byField = haystacksByImageRef.get(image);
  if (byField === undefined) {
    byField = new Map();
    haystacksByImageRef.set(image, byField);
  }
  const cached = byField.get(field);
  if (cached !== undefined) return cached;
  const computed = searchableValues(image, field)
    .map(normalizeSearchText)
    .join('\n');
  byField.set(field, computed);
  return computed;
}

export function isEntryImportMember(entry: LibraryEntry): boolean {
  if (typeof entry.hasImportMembership === 'boolean') {
    return entry.hasImportMembership;
  }
  const origin = entry.origin ?? (entry.sourceImageId === null ? 'import' : 'provider');
  return origin === 'import' && (entry.importDeletedAt ?? null) === null;
}

export function isEntryAdultLike(entry: LibraryEntry): boolean {
  return entry.importClassification !== 'safe';
}

/**
 * N6-B1 (spec §4.5): builds the unified collection item list from saved
 * provider rows (`StoredImage`) and active library entries (`LibraryEntry`):
 * - Every saved `StoredImage` becomes `{ kind: 'image', key: 'image:<id>', image }`.
 * - Every `LibraryEntry` with active import membership (`isEntryImportMember`)
 *   becomes `{ kind: 'import', key: 'import:<sha256>', entry }` — including in
 *   the explicitly admitted §4.4 two-member case where the same digest also
 *   links to a saved `StoredImage`.
 * - A `LibraryEntry` with `origin === 'provider'` and no matching saved
 *   `StoredImage` row is preserved as `{ kind: 'legacy', key: 'legacy:<sha256>', entry }`
 *   (opaque legacy provider fallback: never relabeled as `我的导入`).
 * - A provider-only `LibraryEntry` whose `sourceImageId` is already present in
 *   `images` is an attachment on that provider tile, never a second tile.
 */
export function buildCollectionItems(
  images: readonly StoredImage[],
  entries: readonly LibraryEntry[] = [],
): CollectionItem[] {
  const imageIds = new Set<number>();
  const items: CollectionItem[] = [];
  for (const image of images) {
    imageIds.add(image.id);
    items.push({
      kind: 'image',
      key: `image:${image.id}`,
      image,
    });
  }
  const seenImportDigests = new Set<string>();
  const seenLegacyDigests = new Set<string>();
  for (const entry of entries) {
    if (isEntryImportMember(entry)) {
      if (!seenImportDigests.has(entry.plaintextSha256)) {
        seenImportDigests.add(entry.plaintextSha256);
        items.push({
          kind: 'import',
          key: `import:${entry.plaintextSha256}`,
          entry,
        });
      }
      continue;
    }
    const associatedIds = entry.associatedProviderImageIds !== undefined
      ? entry.associatedProviderImageIds
      : entry.sourceImageId !== null
        ? [entry.sourceImageId]
        : [];
    const hasSavedProviderImage = associatedIds.some((id) => imageIds.has(id));
    if (!hasSavedProviderImage) {
      if (!seenLegacyDigests.has(entry.plaintextSha256)) {
        seenLegacyDigests.add(entry.plaintextSha256);
        items.push({
          kind: 'legacy',
          key: `legacy:${entry.plaintextSha256}`,
          entry,
        });
      }
    }
  }
  return items;
}

function itemKindRank(item: CollectionItem): 0 | 1 | 2 {
  if (item.kind === 'image') return 0;
  if (item.kind === 'import') return 1;
  return 2;
}

function itemTimeForNewest(item: CollectionItem): number {
  if (item.kind === 'image') return item.image.decidedAt ?? 0;
  return item.entry.createdAt;
}

function itemTimeForOldest(item: CollectionItem): number {
  if (item.kind === 'image') {
    return item.image.decidedAt ?? Number.MAX_SAFE_INTEGER;
  }
  return item.entry.createdAt;
}

function itemResolution(item: CollectionItem): number {
  if (item.kind === 'image') return item.image.width * item.image.height;
  return item.entry.width * item.entry.height;
}

function itemByteSize(item: CollectionItem): number {
  if (item.kind === 'image') return item.image.byteSize;
  return item.entry.byteSize;
}

function compareDigestAsc(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareItemsNewest(
  left: CollectionItem,
  right: CollectionItem,
): number {
  const timeDiff = itemTimeForNewest(right) - itemTimeForNewest(left);
  if (timeDiff !== 0) return timeDiff;
  const rankDiff = itemKindRank(left) - itemKindRank(right);
  if (rankDiff !== 0) return rankDiff;
  if (left.kind === 'image' && right.kind === 'image') {
    return (
      (right.image.decisionOrdinal ?? 0) - (left.image.decisionOrdinal ?? 0)
      || right.image.id - left.image.id
    );
  }
  if (left.kind !== 'image' && right.kind !== 'image') {
    return compareDigestAsc(
      left.entry.plaintextSha256,
      right.entry.plaintextSha256,
    );
  }
  return 0;
}

function compareItemsOldest(
  left: CollectionItem,
  right: CollectionItem,
): number {
  const timeDiff = itemTimeForOldest(left) - itemTimeForOldest(right);
  if (timeDiff !== 0) return timeDiff;
  const rankDiff = itemKindRank(left) - itemKindRank(right);
  if (rankDiff !== 0) return rankDiff;
  if (left.kind === 'image' && right.kind === 'image') {
    return (
      (left.image.decisionOrdinal ?? Number.MAX_SAFE_INTEGER)
        - (right.image.decisionOrdinal ?? Number.MAX_SAFE_INTEGER)
      || left.image.id - right.image.id
    );
  }
  if (left.kind !== 'image' && right.kind !== 'image') {
    return compareDigestAsc(
      left.entry.plaintextSha256,
      right.entry.plaintextSha256,
    );
  }
  return 0;
}

export function compareCollectionItems(
  left: CollectionItem,
  right: CollectionItem,
  sort: CollectionSort,
): number {
  if (sort === 'oldest') {
    return compareItemsOldest(left, right);
  }
  if (sort === 'resolution') {
    return (
      itemResolution(right) - itemResolution(left)
      || compareItemsNewest(left, right)
    );
  }
  if (sort === 'fileSize') {
    return (
      itemByteSize(right) - itemByteSize(left)
      || compareItemsNewest(left, right)
    );
  }
  return compareItemsNewest(left, right);
}

function itemMatchesMode(
  item: CollectionItem,
  allowedMode: NsfwMode,
): boolean {
  if (item.kind === 'image') {
    if (allowedMode === 'sfw') return !item.image.isNsfw;
    if (allowedMode === 'nsfw') return item.image.isNsfw;
    return true;
  }
  if (item.kind === 'import') {
    const isAdult = isEntryAdultLike(item.entry);
    if (allowedMode === 'sfw') return !isAdult;
    if (allowedMode === 'nsfw') return isAdult;
    return true;
  }
  // Legacy opaque provider fallback: has no known safe classification, so keep
  // it visible under mixed/all and hide under strict SFW/NSFW filters unless
  // treated as unknown. Per §4.5 ("Preserve opaque legacy provider-only
  // fallback entries as provider fallback data; do not relabel every
  // sourceImageId === null row as 我的导入 or fabricate a rating/source"),
  // legacy rows appear under mixed/all and not under fabricated SFW/NSFW ratings.
  return allowedMode === 'mixed';
}

export function filterCollectionItemsByMode(
  items: readonly CollectionItem[],
  mode: NsfwMode,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): CollectionItem[] {
  const allowedMode = allowedNsfwMode(mode, policy);
  return items.filter((item) => itemMatchesMode(item, allowedMode));
}

export function browseCollectionItems(
  items: readonly CollectionItem[],
  query: CollectionBrowserQuery,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): CollectionItem[] {
  const allowedMode = allowedNsfwMode(query.mode, policy);
  const terms = normalizeSearchText(query.text).split(/\s+/).filter(Boolean);
  const filtered = items.filter((item) => {
    if (!itemMatchesMode(item, allowedMode)) return false;
    if (query.provider === 'imports') {
      if (item.kind !== 'import') return false;
    } else if (query.provider !== 'all') {
      if (item.kind !== 'image' || item.image.providerKey !== query.provider) {
        return false;
      }
    }
    if (terms.length === 0) return true;
    // Spec §4.6: Imports (and legacy digest rows without provider metadata)
    // have no searchable text; any normalized non-empty search hides them.
    if (item.kind !== 'image') return false;
    const haystack = imageHaystack(item.image, query.field);
    return terms.every((term) => haystack.includes(term));
  });

  return filtered.sort((left, right) =>
    compareCollectionItems(left, right, query.sort),
  );
}

export function countCollectionItemsByMode(
  items: readonly CollectionItem[],
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): Record<NsfwMode, number> {
  if (!policy.allowsAdultContent) {
    const sfw = filterCollectionItemsByMode(items, 'sfw', policy).length;
    return { mixed: sfw, sfw, nsfw: 0 };
  }
  const mixed = filterCollectionItemsByMode(items, 'mixed', policy).length;
  const sfw = filterCollectionItemsByMode(items, 'sfw', policy).length;
  const nsfw = filterCollectionItemsByMode(items, 'nsfw', policy).length;
  return { mixed, sfw, nsfw };
}

export type CollectionSourceOption = Readonly<{
  provider: CollectionProvider;
  count: number;
}>;

/**
 * N6-B1 (spec §4.6): unified source options from the pre-source pool (after
 * text + content mode filters, before source selection).
 * - Lists `全部` (`provider: 'all'`) with `items.length`.
 * - Lists every positive-count provider and `'imports'` (`我的导入`), keeping
 *   `current` listed at `0` when selected and its count is `0`.
 * - Sorts by descending count, then `registryOrder` for providers, and
 *   `'imports'` after `registryOrder` on equal counts.
 * - Legacy opaque fallback rows (`kind: 'legacy'`) count toward `全部` only and
 *   never fabricate a `我的导入` or provider option.
 */
export function collectionItemSourceOptions(
  items: readonly CollectionItem[],
  current: CollectionProvider,
  registryOrder: readonly ImageProviderKey[],
): CollectionSourceOption[] {
  const counts = new Map<Exclude<CollectionProvider, 'all'>, number>();
  for (const item of items) {
    if (item.kind === 'image') {
      counts.set(
        item.image.providerKey,
        (counts.get(item.image.providerKey) ?? 0) + 1,
      );
    } else if (item.kind === 'import') {
      counts.set('imports', (counts.get('imports') ?? 0) + 1);
    }
  }
  if (current !== 'all' && !counts.has(current)) {
    counts.set(current, 0);
  }
  const rank = (key: Exclude<CollectionProvider, 'all'>): number => {
    if (key === 'imports') return registryOrder.length + 1;
    const index = registryOrder.indexOf(key);
    return index === -1 ? registryOrder.length : index;
  };
  const sources = [...counts.entries()]
    .sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || rank(leftKey) - rank(rightKey),
    )
    .map(([provider, count]) => ({ provider, count }));
  return [{ provider: 'all', count: items.length }, ...sources];
}

export function browseCollectionImages(
  images: readonly StoredImage[],
  query: CollectionBrowserQuery,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): StoredImage[] {
  if (query.provider === 'imports') return [];
  const allowedMode = allowedNsfwMode(query.mode, policy);
  // The query is normalized once per call, not once per image.
  const terms = normalizeSearchText(query.text).split(/\s+/).filter(Boolean);
  const haystacks = terms.length === 0
    ? null
    : collectionHaystacks(images, query.field);
  const filtered = images.filter((image, index) => {
    if (allowedMode === 'sfw' && image.isNsfw) return false;
    if (allowedMode === 'nsfw' && !image.isNsfw) return false;
    if (query.provider !== 'all' && image.providerKey !== query.provider) return false;
    if (haystacks === null) return true;
    const haystack = haystacks[index];
    return terms.every((term) => haystack.includes(term));
  });

  return filtered.sort((left, right) => {
    if (query.sort === 'oldest') return oldestOrder(left, right);
    if (query.sort === 'resolution') {
      return right.width * right.height - left.width * left.height
        || recentOrder(left, right);
    }
    if (query.sort === 'fileSize') {
      return right.byteSize - left.byteSize || recentOrder(left, right);
    }
    return recentOrder(left, right);
  });
}

export function filterCollectionImages(
  images: readonly StoredImage[],
  mode: NsfwMode,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): StoredImage[] {
  const allowedMode = allowedNsfwMode(mode, policy);
  if (allowedMode === 'sfw') return images.filter((image) => !image.isNsfw);
  if (allowedMode === 'nsfw') return images.filter((image) => image.isNsfw);
  return [...images];
}

/**
 * R8.27: per-mode row counts for the collection chip row. Callers pass the
 * list that already survived the text and provider filters so the numbers
 * track the visible query.
 */
export function countCollectionImagesByMode(
  images: readonly StoredImage[],
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): Record<NsfwMode, number> {
  // `filterCollectionImages(_, 'mixed')` already coerces a Store policy down to
  // SFW, so the adult bucket honestly reads 0 there instead of mirroring SFW.
  const mixed = filterCollectionImages(images, 'mixed', policy);
  const sfw = mixed.filter((image) => !image.isNsfw).length;
  return { mixed: mixed.length, sfw, nsfw: mixed.length - sfw };
}

/**
 * Ledger N2 / N6-B1: 全部 plus every provider present in `images`, most first,
 * ties in `registryOrder` (with `'imports'` ordered after `registryOrder` on
 * equal counts).
 */
export function collectionSourceOptions(
  images: readonly StoredImage[],
  withoutSourceCount: number,
  current: CollectionProvider,
  registryOrder: readonly ImageProviderKey[],
  importCount = 0,
): CollectionSourceOption[] {
  const counts = new Map<Exclude<CollectionProvider, 'all'>, number>();
  for (const image of images) {
    counts.set(image.providerKey, (counts.get(image.providerKey) ?? 0) + 1);
  }
  if (importCount > 0) {
    counts.set('imports', importCount);
  }
  if (current !== 'all' && !counts.has(current)) counts.set(current, 0);
  const rank = (key: Exclude<CollectionProvider, 'all'>) => {
    if (key === 'imports') return registryOrder.length + 1;
    const index = registryOrder.indexOf(key);
    return index === -1 ? registryOrder.length : index;
  };
  const providers = [...counts.entries()]
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || rank(leftKey) - rank(rightKey))
    .map(([provider, count]) => ({ provider, count }));
  return [
    { provider: 'all', count: images.length + importCount + withoutSourceCount },
    ...providers,
  ];
}
