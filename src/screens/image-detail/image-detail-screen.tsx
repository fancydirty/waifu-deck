import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import {
  Download,
  ExternalLink,
  Layers3,
  RotateCcw,
  Search,
  Share2,
  Trash2,
  X,
} from 'lucide-react-native';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  Text,
  type ViewToken,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ScreenState } from '@/components/screen-state';
import {
  browseCollectionItems,
  buildCollectionItems,
  DEFAULT_COLLECTION_QUERY,
  filterCollectionItemsByMode,
  isCollectionProvider,
  type CollectionBrowserQuery,
  type CollectionItem,
} from '@/features/collection/collection-filter';
import {
  collectionQueryKey,
  publishCollectionRow,
  publishCollectionSnapshot,
} from '@/features/collection/collection-query';
import { CollectionServiceError } from '@/features/collection/file-repository';
import { allowedNsfwMode } from '@/features/distribution/distribution-policy';
import type { StoredImage } from '@/features/images/image-repository';
import type { LibraryRenderIntent } from '@/features/library/library-actions-types';
import { takeResidencyChanges } from '@/features/library/library-entry-residency';
import { libraryAccessFor, thumbnailNoteKey } from '@/features/library/library-access';
import { canonicalExtensionFor } from '@/features/library/library-format';
import type { LibraryEntry } from '@/features/library/library-view-model';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import { providerLabel } from '@/features/providers/provider-label';
import type { NsfwMode } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';
import { useHandedOverPublisher, type HandedOver } from '@/providers/handed-over-publishers';
import {
  sameLibraryEntries,
  type LibraryOverlay,
} from '@/screens/collection/collection-screen';
import { readDetailOpenSeed } from '@/screens/image-detail/detail-open-seed';
import {
  entryToGalleryMedia,
  GalleryImage,
} from '@/screens/image-detail/gallery-image';
import { isOriginalUnrecoverable } from '@/features/library/library-render-availability';
import {
  resolveEntryShareTarget,
  resolveShareTarget,
} from '@/screens/image-detail/library-share-target';
import { metrics } from '@/theme/metrics';

type SafeInsets = { top: number; bottom: number };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isValidImportSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export function parseDetailGalleryQuery(params: {
  query?: string;
  field?: string;
  mode?: string;
  provider?: string;
  sort?: string;
}): CollectionBrowserQuery {
  return {
    text: params.query ?? '',
    field: params.field === 'artist' || params.field === 'tag' ? params.field : 'all',
    mode: allowedNsfwMode(
      params.mode === 'sfw' || params.mode === 'nsfw' ? params.mode : 'mixed',
    ),
    provider: typeof params.provider === 'string' && isCollectionProvider(params.provider)
      ? params.provider
      : 'all',
    sort: params.sort === 'oldest' || params.sort === 'resolution'
      || params.sort === 'fileSize' ? params.sort : DEFAULT_COLLECTION_QUERY.sort,
  };
}

/**
 * N6-C (spec §4.7): format `YYYY-MM-DD` by hand with local `Date` getters and
 * zero padding; never use `Intl`, `toLocaleDateString`, or Node-only globals.
 * If a legacy timestamp is invalid (`!Number.isFinite(createdAt) || createdAt <= 0`),
 * return `null` so the caller renders only the imported-picture label without
 * inventing a date.
 */
export function formatImportHeaderDate(createdAt: number): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
    return null;
  }
  const date = new Date(createdAt);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function GalleryActionButton({
  children,
  destructive = false,
  disabled,
  label,
  onPress,
  visibleLabel,
}: {
  children: ReactNode;
  destructive?: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
  visibleLabel: string;
}) {
  const color = destructive ? '#FF8FA3' : '#FFFFFF';

  return (
    <Pressable
      role="button"
      aria-label={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        minHeight: 68,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 3,
        paddingVertical: 5,
        opacity: disabled ? 0.38 : pressed ? 0.64 : 1,
      })}>
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: destructive
            ? 'rgba(255, 143, 163, 0.14)'
            : 'rgba(255, 255, 255, 0.12)',
        }}>
        {children}
      </View>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={{ color, fontSize: 11, fontWeight: '600' }}>
        {visibleLabel}
      </Text>
    </Pressable>
  );
}

type DetailActionMessageKey =
  | 'detail.errorShareUnavailable'
  | 'detail.errorExportUnavailable'
  | 'detail.errorPermissionDenied'
  | 'detail.errorNotReady'
  | 'detail.errorFileMissing'
  | 'detail.errorOperationBlocked'
  | 'detail.errorShare'
  | 'detail.errorExport'
  | 'detail.errorRepair'
  | 'detail.errorDelete'
  | 'detail.errorCloudOnlyOffline'
  | 'detail.errorCloudOnlyDisconnected'
  | 'detail.sourceOpenError';

type DetailNoticeKey = 'detail.exportSuccess';

function userSafeActionMessageKey(
  error: unknown,
  action: 'share' | 'export' | 'repair' | 'delete',
): DetailActionMessageKey {
  if (error instanceof CollectionServiceError) {
    if (error.code === 'cloud_only_offline') return 'detail.errorCloudOnlyOffline';
    if (error.code === 'cloud_only_disconnected') return 'detail.errorCloudOnlyDisconnected';
    if (error.code === 'share_unavailable') {
      return 'detail.errorShareUnavailable';
    }
    if (error.code === 'platform_unavailable') {
      return action === 'export'
        ? 'detail.errorExportUnavailable'
        : 'detail.errorShareUnavailable';
    }
    if (error.code === 'export_unavailable') return 'detail.errorExportUnavailable';
    if (error.code === 'permission_denied') return 'detail.errorPermissionDenied';
    if (error.code === 'not_ready') return 'detail.errorNotReady';
    if (error.code === 'file_missing') return 'detail.errorFileMissing';
    if (error.code === 'operation_blocked') return 'detail.errorOperationBlocked';
  }
  if (action === 'share') return 'detail.errorShare';
  if (action === 'export') return 'detail.errorExport';
  if (action === 'repair') return 'detail.errorRepair';
  return 'detail.errorDelete';
}

export type DetailOpenSeed =
  | Readonly<{ imageId: number; uri: string }>
  | Readonly<{ plaintextSha256: string; uri: string }>;

export type ImageDetailViewProps = {
  images: readonly StoredImage[];
  /**
   * Optional pre-built unified collection items (provider saves + imports +
   * legacy entries in the exact current-grid order). When omitted, the view
   * wraps `images` as provider `CollectionItem`s so existing `StoredImage[]`
   * callers work unchanged.
   */
  items?: readonly CollectionItem[];
  initialImageId?: number;
  initialImportSha256?: string;
  initialItemKey?: CollectionItem['key'];
  status: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  safeInsets?: SafeInsets;
  onClose: () => void;
  onShare: (imageId: number) => Promise<void>;
  onExport: (imageId: number) => Promise<void>;
  onShareImport?: (plaintextSha256: string) => Promise<void>;
  onExportImport?: (plaintextSha256: string) => Promise<void>;
  onRetry: (imageId: number) => Promise<void>;
  /**
   * K6-5 C: re-run the private-library ingest for a `ready` row whose
   * `libraryError` is set. Separate from `onRetry` on purpose — the provider
   * file is already on disk and intact, so re-downloading it repairs nothing.
   */
  onRepairLibrary?: (imageId: number) => Promise<void>;
  onDelete: (imageId: number) => Promise<void>;
  onDeleteImport?: (plaintextSha256: string) => Promise<void>;
  onReturnToDiscovery: (imageId: number) => Promise<void>;
  onLocalFileMissing: (
    imageId: number,
    observedUri: string,
  ) => boolean | void | Promise<boolean | void>;
  onExploreArtist?: (artist: string) => void;
  onExploreProvider?: (image: StoredImage) => void;
  onExploreTag?: (tag: string) => void;
  onReload?: () => void;
  /** Direct-only. `null` keeps the accepted local detail exactly as it is. */
  libraryOverlay?: LibraryOverlay | null;
  /**
   * Board #27 S1b (spec §5.5): the container's hand-over publications. Each new
   * object names images the library just took over; the view offers a failed
   * fast path for each of them again (the hand-over verified its original).
   */
  handedOver?: HandedOver | null;
  /**
   * The thumbnail a collection open stored for this image id or import digest.
   * A deep link can never supply a file URI. A later deep link to an id
   * that was opened can still read that id's last seed.
   */
  openSeed?: DetailOpenSeed | null;
};

// The first batch starts at `initialScrollIndex` and renders up to three
// consecutive items. `windowSize` 3 keeps that small. Detail and placeholder
// fetches reach ±2.
const NEIGHBOUR_RADIUS = 2;

function indexesAround(current: number, count: number, radius: number): number[] {
  const indexes: number[] = [];
  for (let index = current - radius; index <= current + radius; index += 1) {
    if (index >= 0 && index < count) indexes.push(index);
  }
  return indexes;
}

function resolveInitialItemKey(
  initialItemKey: CollectionItem['key'] | undefined,
  initialImportSha256: string | undefined,
  initialImageId: number | undefined,
): CollectionItem['key'] {
  if (initialItemKey !== undefined) return initialItemKey;
  if (initialImportSha256 !== undefined) return `import:${initialImportSha256}`;
  return `image:${initialImageId ?? 0}`;
}

function matchesItemTarget(
  item: CollectionItem,
  targetKey: CollectionItem['key'],
): boolean {
  if (item.key === targetKey) return true;
  if (targetKey.startsWith('import:') && item.kind === 'legacy') {
    return `import:${item.entry.plaintextSha256}` === targetKey;
  }
  return false;
}

export function ImageDetailView({
  images,
  items: itemsProp,
  initialImageId,
  initialImportSha256,
  initialItemKey: initialItemKeyProp,
  status,
  errorMessage,
  safeInsets = { top: 0, bottom: 0 },
  onClose,
  onShare,
  onExport,
  onShareImport,
  onExportImport,
  onRetry,
  onRepairLibrary,
  onDelete,
  onDeleteImport,
  onReturnToDiscovery,
  onLocalFileMissing,
  onExploreArtist = () => undefined,
  onExploreProvider = () => undefined,
  onExploreTag = () => undefined,
  onReload = () => undefined,
  libraryOverlay = null,
  handedOver = null,
  openSeed = null,
}: ImageDetailViewProps) {
  const { t } = useAppTranslation();
  const window = useWindowDimensions();
  const pagerItems = useMemo<readonly CollectionItem[]>(() => {
    if (itemsProp !== undefined) return itemsProp;
    return images.map((image) => ({
      kind: 'image' as const,
      key: `image:${image.id}` as const,
      image,
    }));
  }, [images, itemsProp]);

  const initialKey = useMemo(
    () => resolveInitialItemKey(initialItemKeyProp, initialImportSha256, initialImageId),
    [initialImageId, initialImportSha256, initialItemKeyProp],
  );
  const [currentItemKey, setCurrentItemKey] = useState<CollectionItem['key']>(initialKey);
  // Track whether the user has explicitly navigated (or a deletion moved the
  // active key) since the initial target was found. Before the initial target
  // is present (or while it is still at its initial position), if `initialKey`
  // arrives asynchronously (e.g., an import entry arriving after `listEntries`
  // settles), the pager snaps to that initial target instead of getting stuck
  // on index 0's provider image.
  const [hasLockedSelection, setHasLockedSelection] = useState(false);

  const currentIndex = useMemo(() => {
    if (hasLockedSelection) {
      const locked = pagerItems.findIndex((item) => matchesItemTarget(item, currentItemKey));
      if (locked >= 0) return locked;
    }
    const initial = pagerItems.findIndex((item) => matchesItemTarget(item, initialKey));
    if (initial >= 0) return initial;
    const fallback = pagerItems.findIndex((item) => matchesItemTarget(item, currentItemKey));
    if (fallback >= 0) return fallback;
    return 0;
  }, [currentItemKey, hasLockedSelection, initialKey, pagerItems]);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<DetailActionMessageKey | null>(null);
  const [actionNotice, setActionNotice] = useState<DetailNoticeKey | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const galleryRef = useRef<FlatList<CollectionItem>>(null);

  const entriesByImageId = useMemo(() => {
    const map = new Map<number, LibraryEntry>();
    if (libraryOverlay === null) return map;
    for (const entry of libraryOverlay.entries) {
      // `listEntries` is newest first: the first entry of an image wins.
      const associatedIds = entry.associatedProviderImageIds !== undefined
        ? entry.associatedProviderImageIds
        : entry.sourceImageId !== null
          ? [entry.sourceImageId]
          : [];
      for (const imageId of associatedIds) {
        if (!map.has(imageId)) {
          map.set(imageId, entry);
        }
      }
    }
    return map;
  }, [libraryOverlay]);

  // `null` = the resolve rejected (an unexpected error, not a resolver
  // verdict): the page falls back to what it rendered before the library
  // existed instead of holding its colour block forever.
  const [renderSources, setRenderSources] = useState(
    () => new Map<string, LibraryRenderSource | null>(),
  );
  const renderSourcesRef = useRef(renderSources);
  const detailInFlightRef = useRef(new Set<string>());
  // Board rows 48–49. The thumbnail does not depend on where the original
  // lives, so each digest is resolved once and a residency move does not drop it.
  const [placeholderSources, setPlaceholderSources] = useState(
    () => new Map<string, string | null>(),
  );
  const placeholderSourcesRef = useRef(placeholderSources);
  const placeholderInFlightRef = useRef(new Set<string>());
  // Digests whose on-screen answer came from an earlier resolver. Declared
  // above the fast-path callback, which drops one when that path fails.
  const staleDetailRef = useRef(new Set<string>());
  const stalePlaceholderRef = useRef(new Set<string>());
  const pagerExtraData = useMemo(
    () => ({ renderSources, placeholderSources }),
    [renderSources, placeholderSources],
  );

  // Board #27 (spec §5.7): a file-less row whose entry holds the local original
  // opens on it with no detail resolve, until that load fails once. A ref for
  // the once-per-digest guard, a state set for the renders and the gate; the
  // generation makes an older resolve, settled or in flight, unable to stand in
  // for the fresh one.
  const fastPathFailedRef = useRef(new Set<string>());
  const [fastPathFailed, setFastPathFailed] = useState(() => new Set<string>());
  const detailGenerationRef = useRef(new Map<string, number>());
  const detailGenerationOf = useCallback((digest: string): number => (
    detailGenerationRef.current.get(digest) ?? 0
  ), []);

  const entryForItem = useCallback((item: CollectionItem): LibraryEntry | null => {
    if (item.kind !== 'image') return item.entry;
    return entriesByImageId.get(item.image.id) ?? null;
  }, [entriesByImageId]);

  const isItemResolverOwned = useCallback((item: CollectionItem): boolean => {
    if (item.kind !== 'image') return true;
    const entry = entriesByImageId.get(item.image.id);
    if (entry === undefined) return false;
    return item.image.localUri === null || item.image.downloadState === 'mirrored';
  }, [entriesByImageId]);

  const fastPathUriForItem = useCallback((item: CollectionItem): string | null => {
    const entry = entryForItem(item);
    if (entry === null) return null;
    if (!isItemResolverOwned(item) || entry.localOriginalUri === null) return null;
    if (fastPathFailed.has(entry.plaintextSha256)) return null;
    return entry.localOriginalUri;
  }, [entryForItem, fastPathFailed, isItemResolverOwned]);

  // The once-per-digest guard lives here, not in the page: a gif too large to
  // animate re-fires its callback on every render.
  const fastPathFailedFor = useCallback((digest: string) => {
    if (fastPathFailedRef.current.has(digest)) return;
    fastPathFailedRef.current.add(digest);
    detailGenerationRef.current.set(
      digest,
      (detailGenerationRef.current.get(digest) ?? 0) + 1,
    );
    if (renderSourcesRef.current.has(digest)) {
      const next = new Map(renderSourcesRef.current);
      next.delete(digest);
      renderSourcesRef.current = next;
      setRenderSources(next);
    }
    staleDetailRef.current.delete(digest);
    detailInFlightRef.current.delete(digest);
    setFastPathFailed(new Set(fastPathFailedRef.current));
  }, []);

  // Board #27 S3b (spec §5.12): a resolved page describes the residency it was
  // made for. When an entries read shows that residency moved, the digest is
  // resolved afresh — as after a fast-path failure. Declared before the detail
  // resolve effect, which then sees the digest unresolved in the same commit.
  const residencySeenRef = useRef(new Map<string, string>());
  // Board row 52: a recovery rebind replaces the resolver without moving
  // residency. Settled detail and placeholder answers stay on screen and are
  // marked stale, so the window resolves them again and replaces each one
  // when the new answer arrives. An in-flight answer from the old resolver
  // cannot publish.
  const resolverEpochRef = useRef(0);
  const resolverSeenRef = useRef(libraryOverlay?.resolve);
  useEffect(() => {
    const resolve = libraryOverlay?.resolve;
    if (resolverSeenRef.current === resolve) return;
    resolverSeenRef.current = resolve;
    resolverEpochRef.current += 1;
    detailInFlightRef.current.clear();
    placeholderInFlightRef.current.clear();
    staleDetailRef.current = new Set(renderSourcesRef.current.keys());
    stalePlaceholderRef.current = new Set(placeholderSourcesRef.current.keys());
  }, [libraryOverlay?.resolve]);
  const overlayEntries = libraryOverlay?.entries ?? null;
  useEffect(() => {
    if (overlayEntries === null) return;
    const changed = takeResidencyChanges(residencySeenRef.current, overlayEntries);
    if (changed.length === 0) return;
    let next: Map<string, LibraryRenderSource | null> | null = null;
    for (const digest of changed) {
      detailGenerationRef.current.set(digest, detailGenerationOf(digest) + 1);
      detailInFlightRef.current.delete(digest);
      staleDetailRef.current.delete(digest);
      if (renderSourcesRef.current.has(digest)) {
        next ??= new Map(renderSourcesRef.current);
        next.delete(digest);
      }
    }
    if (next !== null) {
      renderSourcesRef.current = next;
      setRenderSources(next);
    }
  }, [overlayEntries, detailGenerationOf]);

  useEffect(() => {
    if (libraryOverlay === null) return;
    const neighbourIndexes = indexesAround(currentIndex, pagerItems.length, NEIGHBOUR_RADIUS);
    for (const index of neighbourIndexes) {
      const item = pagerItems[index];
      if (!item) continue;
      const entry = entryForItem(item);
      if (!entry) continue;
      const digest = entry.plaintextSha256;
      if (fastPathUriForItem(item) !== null) continue;
      if (detailInFlightRef.current.has(digest)) continue;
      if (renderSourcesRef.current.has(digest) && !staleDetailRef.current.has(digest)) {
        continue;
      }
      detailInFlightRef.current.add(digest);
      const generation = detailGenerationOf(digest);
      const resolverEpoch = resolverEpochRef.current;
      const current = () => detailGenerationOf(digest) === generation
        && resolverEpochRef.current === resolverEpoch;
      const stillOpen = () => current()
        && !(renderSourcesRef.current.has(digest) && !staleDetailRef.current.has(digest));
      const publishDetail = (source: LibraryRenderSource | null) => {
        if (!stillOpen()) return;
        staleDetailRef.current.delete(digest);
        const next = new Map(renderSourcesRef.current);
        next.set(digest, source);
        renderSourcesRef.current = next;
        setRenderSources(next);
      };
      void Promise.resolve(libraryOverlay.resolve(digest, 'detail'))
        .then((source) => {
          publishDetail(source);
        })
        .catch(() => {
          publishDetail(null);
        })
        .finally(() => {
          if (current()) detailInFlightRef.current.delete(digest);
        });
    }
  }, [
    currentIndex,
    detailGenerationOf,
    entryForItem,
    fastPathUriForItem,
    libraryOverlay,
    pagerItems,
  ]);

  useEffect(() => {
    if (libraryOverlay === null) return;
    for (const index of indexesAround(currentIndex, pagerItems.length, NEIGHBOUR_RADIUS)) {
      const item = pagerItems[index];
      if (!item) continue;
      const entry = entryForItem(item);
      if (!entry) continue;
      const digest = entry.plaintextSha256;
      if (placeholderInFlightRef.current.has(digest)) continue;
      if (
        placeholderSourcesRef.current.has(digest)
        && !stalePlaceholderRef.current.has(digest)
      ) {
        continue;
      }
      placeholderInFlightRef.current.add(digest);
      const resolverEpoch = resolverEpochRef.current;
      const stillOpen = () => resolverEpochRef.current === resolverEpoch
        && !(
          placeholderSourcesRef.current.has(digest)
          && !stalePlaceholderRef.current.has(digest)
        );
      const publishPlaceholder = (uri: string | null) => {
        if (!stillOpen()) return;
        stalePlaceholderRef.current.delete(digest);
        const next = new Map(placeholderSourcesRef.current);
        next.set(digest, uri);
        placeholderSourcesRef.current = next;
        setPlaceholderSources(next);
      };
      void Promise.resolve(libraryOverlay.resolve(digest, 'placeholder'))
        .then((source) => {
          publishPlaceholder(source.kind === 'file' ? source.uri : null);
        })
        .catch(() => {
          publishPlaceholder(null);
        })
        .finally(() => {
          if (resolverEpochRef.current === resolverEpoch) {
            placeholderInFlightRef.current.delete(digest);
          }
        });
    }
  }, [currentIndex, entryForItem, libraryOverlay, pagerItems]);

  // A failed fast path is offered again once a page is seen with the fast path
  // withheld for another reason: the entry lost its local original, or the row
  // now holds its own collection file (not resolver-owned). Either transition
  // took a DB write that put fresh bytes in place, so re-offering cannot loop —
  // a load failure writes nothing. The render map and the generation are left
  // alone; a later failure clears them itself, and an absent entry forgets
  // nothing.
  useEffect(() => {
    if (fastPathFailed.size === 0) return;
    let changed = false;
    for (const item of pagerItems) {
      const entry = entryForItem(item);
      if (entry === null) continue;
      if (!fastPathFailed.has(entry.plaintextSha256)) continue;
      const resolverOwned = isItemResolverOwned(item);
      if (entry.localOriginalUri === null || !resolverOwned) {
        // Only a digest actually removed changes the set, so this effect can never re-trigger itself.
        if (fastPathFailedRef.current.delete(entry.plaintextSha256)) changed = true;
      }
    }
    if (changed) setFastPathFailed(new Set(fastPathFailedRef.current));
  }, [entryForItem, fastPathFailed, isItemResolverOwned, pagerItems]);

  // Board #27 S1b (spec §5.5): a hand-over has just verified the image's local
  // original, so a fast path that failed earlier is offered again — even when
  // this screen never saw the row's intermediate `ready` state. Once per
  // publication (`seq`); only a digest actually removed changes the set.
  const appliedHandedOverSeq = useRef(0);
  useEffect(() => {
    if (handedOver === null || handedOver.seq === appliedHandedOverSeq.current) return;
    appliedHandedOverSeq.current = handedOver.seq;
    let changed = false;
    for (const imageId of handedOver.imageIds) {
      const entry = entriesByImageId.get(imageId);
      if (entry === undefined) continue;
      if (fastPathFailedRef.current.delete(entry.plaintextSha256)) changed = true;
    }
    if (changed) setFastPathFailed(new Set(fastPathFailedRef.current));
  }, [handedOver, entriesByImageId]);

  const resolveFullForDigestBeforeAction = useCallback(async (digest: string) => {
    if (libraryOverlay === null) return;
    const generation = detailGenerationOf(digest);
    const resolverEpoch = resolverEpochRef.current;
    const source = await libraryOverlay.resolve(digest, 'full');
    // Board #27 S4 (spec §5.12, O2): a soft failure (offline, locked, nothing
    // fetched) never replaces what the page shows, so the thumbnail and its
    // note stay; a role-pinned failure still reaches K3's repair gate. A
    // residency move during the fetch (S3b), or a resolver replacement, makes
    // the answer stale.
    if (resolverEpochRef.current !== resolverEpoch) return;
    if (source.kind === 'unavailable' && source.role === undefined) return;
    if (detailGenerationOf(digest) !== generation) return;
    const next = new Map(renderSourcesRef.current);
    next.set(digest, source);
    renderSourcesRef.current = next;
    setRenderSources(next);
  }, [detailGenerationOf, libraryOverlay]);

  const resolveFullBeforeAction = useCallback(async (imageId: number) => {
    const entry = entriesByImageId.get(imageId);
    if (!entry) return;
    await resolveFullForDigestBeforeAction(entry.plaintextSha256);
  }, [entriesByImageId, resolveFullForDigestBeforeAction]);

  const clearActionNotice = useCallback(() => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setActionNotice(null);
  }, []);

  const showActionNotice = useCallback((message: DetailNoticeKey) => {
    clearActionNotice();
    setActionNotice(message);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setActionNotice(null);
    }, 4_000);
  }, [clearActionNotice]);

  useEffect(() => clearActionNotice, [clearActionNotice]);

  const currentItem = pagerItems[currentIndex] ?? null;
  const updateVisibleImage = useCallback((info: { viewableItems: ViewToken<CollectionItem>[] }) => {
    const visible = info.viewableItems.find((item) => item.isViewable !== false)?.item;
    if (visible) {
      setHasLockedSelection(true);
      setCurrentItemKey(visible.key);
    }
  }, []);

  const runAction = useCallback(async (
    action: 'share' | 'export' | 'repair' | 'delete',
    operation: () => Promise<void>,
    onSuccess?: () => void,
    onFailure?: () => void,
  ) => {
    if (busyAction) return;
    setBusyAction(action);
    setActionError(null);
    clearActionNotice();
    try {
      await operation();
      onSuccess?.();
    } catch (error) {
      onFailure?.();
      setActionError(userSafeActionMessageKey(error, action));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, clearActionNotice]);

  const confirmDelete = useCallback(() => {
    if (!currentItem || busyAction) return;
    const nextItem = pagerItems[currentIndex + 1] ?? pagerItems[currentIndex - 1] ?? null;
    const previousKey = currentItem.key;
    Alert.alert(
      t('detail.deleteTitle'),
      t('detail.deleteMessage'),
      [
        { text: t('detail.cancel'), style: 'cancel' },
        {
          text: t('detail.delete'),
          style: 'destructive',
          onPress: () => {
            if (nextItem) {
              setHasLockedSelection(true);
              setCurrentItemKey(nextItem.key);
            }
            if (currentItem.kind === 'image') {
              const imageId = currentItem.image.id;
              void runAction(
                'delete',
                () => onDelete(imageId),
                undefined,
                () => {
                  setHasLockedSelection(true);
                  setCurrentItemKey(previousKey);
                },
              );
            } else if (onDeleteImport) {
              const digest = currentItem.entry.plaintextSha256;
              void runAction(
                'delete',
                () => onDeleteImport(digest),
                undefined,
                () => {
                  setHasLockedSelection(true);
                  setCurrentItemKey(previousKey);
                },
              );
            }
          },
        },
      ],
    );
  }, [busyAction, currentIndex, currentItem, onDelete, onDeleteImport, pagerItems, runAction, t]);

  const confirmReturn = useCallback(() => {
    if (!currentItem || currentItem.kind !== 'image' || busyAction) return;
    const nextItem = pagerItems[currentIndex + 1] ?? pagerItems[currentIndex - 1] ?? null;
    const previousKey = currentItem.key;
    const imageId = currentItem.image.id;
    Alert.alert(
      t('detail.returnTitle'),
      t('detail.returnMessage'),
      [
        { text: t('detail.cancel'), style: 'cancel' },
        {
          text: t('detail.returnConfirm'),
          style: 'destructive',
          onPress: () => {
            if (nextItem) {
              setHasLockedSelection(true);
              setCurrentItemKey(nextItem.key);
            }
            void runAction(
              'delete',
              () => onReturnToDiscovery(imageId),
              undefined,
              () => {
                setHasLockedSelection(true);
                setCurrentItemKey(previousKey);
              },
            );
          },
        },
      ],
    );
  }, [busyAction, currentIndex, currentItem, onReturnToDiscovery, pagerItems, runAction, t]);

  if (status === 'loading') {
    return <View style={{ flex: 1, backgroundColor: '#000000' }}><ScreenState kind="loading" /></View>;
  }
  if (status === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: '#000000' }}>
        <ScreenState
          kind="error"
          message={errorMessage ?? t('detail.loadError')}
          onRetry={onReload}
        />
      </View>
    );
  }
  if (!currentItem) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000000' }}>
        <ScreenState
          kind="empty"
          title={t('detail.missingTitle')}
          message={t('detail.missingMessage')}
          command={{ label: t('detail.backToCollection'), onPress: onClose }}
        />
      </View>
    );
  }

  const disabled = busyAction !== null;
  const currentEntry = entryForItem(currentItem);
  const currentSource = currentEntry === null
    ? undefined
    : renderSources.get(currentEntry.plaintextSha256);
  // Board #27 S4 (spec §5.12, O2): the page shows the durable thumbnail
  // enlarged because nothing better can be fetched now; one line says why,
  // from the composition (a render result cannot tell offline from locked).
  const thumbnailNote = currentEntry !== null
    && isItemResolverOwned(currentItem)
    && fastPathUriForItem(currentItem) === null
    // Only while the cloud holds the original: with no cloud generation the
    // thumbnail is all there is, and no network or library brings more.
    && currentEntry.originalGenerationId !== null
    && currentSource?.kind === 'file'
    && currentSource.role === 'thumbnail'
    ? thumbnailNoteKey(libraryOverlay?.access ?? 'ready')
    : null;

  const isProviderPage = currentItem.kind === 'image';
  const currentImage = isProviderPage ? currentItem.image : null;
  const ready = currentImage !== null
    && currentImage.downloadState === 'ready'
    && Boolean(currentImage.localUri);
  const libraryReady = currentEntry !== null;
  const canShareOrExport = isProviderPage ? (ready || libraryReady) : libraryReady;

  const seededUriForItem = (item: CollectionItem, entry: LibraryEntry | null): string | null => {
    if (openSeed === null) return null;
    if ('imageId' in openSeed) {
      return item.kind === 'image' && openSeed.imageId === item.image.id
        ? openSeed.uri
        : null;
    }
    const digest = item.kind === 'image' ? entry?.plaintextSha256 : item.entry.plaintextSha256;
    return digest === openSeed.plaintextSha256 ? openSeed.uri : null;
  };

  const renderPage = (item: CollectionItem) => {
    const entry = entryForItem(item);
    // undefined = not resolved yet; null = the resolve rejected (fallback).
    const lookup = entry === null ? undefined : renderSources.get(entry.plaintextSha256);
    const resolved = lookup ?? null;
    const resolverOwned = isItemResolverOwned(item);
    const fastPathUri = fastPathUriForItem(item);
    // Board #9 (spec §5.1): any file-less row may be library-owned before its
    // entry has even been read, so it holds the black layered page for that
    // read. The colour showed for a frame while the entries were read.
    const awaitingEntries = item.kind === 'image'
      && libraryOverlay !== null
      && libraryOverlay.entriesPending === true
      && entry === null
      && item.image.localUri === null;
    // The stage requests this thumbnail at the first commit, with no wait on
    // the entries read or a placeholder resolve. The tile was already showing it.
    const seededUri = seededUriForItem(item, entry);
    const ownPlaceholder = entry === null
      ? undefined
      : placeholderSources.get(entry.plaintextSha256);
    const placeholderUri = entry === null
      ? (awaitingEntries ? (seededUri ?? null) : undefined)
      : typeof ownPlaceholder === 'string'
        ? ownPlaceholder
        : (seededUri ?? ownPlaceholder ?? null);
    const overrideSource: LibraryRenderSource | null = fastPathUri !== null
      ? { kind: 'file', uri: fastPathUri, tier: 'local-original', role: 'original' }
      : resolverOwned ? resolved : null;
    const overridePending = awaitingEntries
      || (resolverOwned && fastPathUri === null && lookup === undefined);

    if (item.kind !== 'image') {
      const digest = item.entry.plaintextSha256;
      return (
        <View
          collapsable={false}
          style={{ flex: 1, width: window.width }}>
          <GalleryImage
            media={entryToGalleryMedia(item.entry)}
            overrideSource={overrideSource}
            overridePending={overridePending}
            onOverrideFailed={fastPathUri !== null
              ? () => fastPathFailedFor(digest)
              : undefined}
            onLocalFileMissing={() => false}
            libraryAccess={libraryOverlay?.access ?? 'ready'}
            placeholderUri={placeholderUri}
          />
        </View>
      );
    }

    const imageItem = item.image;
    return (
      <View
        collapsable={false}
        style={{ flex: 1, width: window.width }}>
        <GalleryImage
          image={imageItem}
          overrideSource={overrideSource}
          // Until the resolver answers, the content does not use the provider
          // URL. A library row shows its thumbnail stage behind that wait.
          overridePending={overridePending}
          onOverrideFailed={fastPathUri !== null && entry !== null
            ? () => fastPathFailedFor(entry.plaintextSha256)
            : undefined}
          onLocalFileMissing={(observedUri) => onLocalFileMissing(imageItem.id, observedUri)}
          libraryAccess={libraryOverlay?.access ?? 'ready'}
          placeholderUri={placeholderUri}
        />
      </View>
    );
  };

  const selectPage = (index: number) => {
    const visible = pagerItems[Math.max(0, Math.min(pagerItems.length - 1, index))];
    if (visible) {
      setHasLockedSelection(true);
      setCurrentItemKey(visible.key);
    }
  };

  const importHeaderDate = !isProviderPage && currentEntry !== null
    ? formatImportHeaderDate(currentEntry.createdAt)
    : null;
  const importHeaderText = importHeaderDate !== null
    ? t('detail.importedHeaderDated', { date: importHeaderDate })
    : t('detail.importedHeader');

  const counterWidth = isProviderPage ? currentImage!.width : currentItem.entry.width;
  const counterHeight = isProviderPage ? currentImage!.height : currentItem.entry.height;
  const counterFormat = isProviderPage
    ? currentImage!.extension.toUpperCase()
    : canonicalExtensionFor(currentItem.entry.format).toUpperCase();

  return (
    <View testID="screen-image-detail" style={{ flex: 1, backgroundColor: '#000000' }}>
      <View
        aria-label={t('detail.topActionsLabel')}
        style={{
          height: safeInsets.top + 56,
          paddingTop: safeInsets.top,
          paddingHorizontal: metrics.spacing.small,
          justifyContent: 'center',
          backgroundColor: '#000000',
        }}>
        <Pressable
          testID="detail-close"
          role="button"
          aria-label={t('detail.close')}
          onPress={onClose}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 24,
            backgroundColor: 'rgba(255, 255, 255, 0.12)',
            opacity: pressed ? 0.64 : 1,
          })}>
          <X color="#FFFFFF" size={24} />
        </Pressable>
      </View>

      <View style={{ flex: 1, overflow: 'hidden' }}>
        <FlatList
          ref={galleryRef}
          testID="detail-pager"
          style={{ flex: 1 }}
          aria-label={t('detail.pagerLabel')}
          data={pagerItems as CollectionItem[]}
          horizontal
          pagingEnabled
          disableIntervalMomentum
          decelerationRate="fast"
          snapToInterval={window.width}
          scrollEnabled={pagerItems.length > 1}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={currentIndex}
          initialNumToRender={Math.min(3, pagerItems.length)}
          maxToRenderPerBatch={3}
          windowSize={3}
          removeClippedSubviews={false}
          getItemLayout={(_data, index) => ({
            index,
            length: window.width,
            offset: window.width * index,
          })}
          keyExtractor={(item) => (
            itemsProp === undefined && item.kind === 'image'
              ? String(item.image.id)
              : item.key
          )}
          extraData={pagerExtraData}
          onViewableItemsChanged={updateVisibleImage}
          onMomentumScrollEnd={(event) => {
            selectPage(Math.round(
              event.nativeEvent.contentOffset.x / Math.max(1, window.width),
            ));
          }}
          renderItem={({ item }) => renderPage(item)}
        />
      </View>

      <View
        aria-label={t('detail.infoActionsLabel')}
        style={{
          gap: metrics.spacing.small,
          paddingTop: metrics.spacing.small,
          paddingBottom: safeInsets.bottom + 4,
          backgroundColor: '#000000',
          borderTopWidth: 1,
          borderTopColor: 'rgba(255, 255, 255, 0.14)',
        }}>
        <View style={{ gap: 5, paddingHorizontal: metrics.spacing.medium }}>
          {isProviderPage && currentImage !== null ? (
            <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {currentImage.artistName ? (
                <Pressable
                  role="button"
                  aria-label={t('detail.exploreArtistAccessibility', {
                    artist: currentImage.artistName,
                  })}
                  onPress={() => onExploreArtist(currentImage.artistName!)}
                  style={({ pressed }) => ({
                    minWidth: 0,
                    flex: 1,
                    minHeight: 48,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    opacity: pressed ? 0.64 : 1,
                  })}>
                  <Text
                    numberOfLines={1}
                    style={{ minWidth: 0, color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                    {currentImage.artistName}
                  </Text>
                  <Search color="#D2D3D5" size={15} />
                </Pressable>
              ) : (
                <Text
                  selectable
                  numberOfLines={1}
                  style={{ minWidth: 0, flex: 1, color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                  {t('detail.unknownArtist')}
                </Text>
              )}
              <Pressable
                role="button"
                aria-label={t('detail.exploreProviderAccessibility', {
                  provider: providerLabel(currentImage.providerKey),
                })}
                onPress={() => onExploreProvider(currentImage)}
                style={({ pressed }) => ({
                  minHeight: 48,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  paddingHorizontal: 8,
                  borderWidth: 1,
                  borderColor: 'rgba(255, 255, 255, 0.28)',
                  borderRadius: metrics.radius.small,
                  opacity: pressed ? 0.64 : 1,
                })}>
                <Layers3 color="#D2D3D5" size={15} />
                <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }}>
                  {providerLabel(currentImage.providerKey)}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <Text
                testID="detail-import-header"
                selectable
                numberOfLines={1}
                style={{ minWidth: 0, flex: 1, color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                {importHeaderText}
              </Text>
            </View>
          )}
          <View
            testID={`detail-position-${currentIndex + 1}-of-${pagerItems.length}`}
            collapsable={false}>
            <Text
              testID="detail-counter"
              selectable
              numberOfLines={2}
              style={{ color: '#D2D3D5', fontSize: 13 }}>
              {`${counterWidth} x ${counterHeight} · ${counterFormat} · ${currentIndex + 1}/${pagerItems.length}`}
            </Text>
          </View>
          {thumbnailNote === null ? null : (
            <Text
              testID="detail-thumbnail-note"
              selectable
              style={{ color: '#F0C178', fontSize: 13 }}>
              {t(thumbnailNote)}
            </Text>
          )}
          {isProviderPage && currentImage !== null && currentImage.tags.length > 0 ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
              aria-label={t('detail.tagsAccessibility')}
              contentContainerStyle={{ gap: 6 }}>
              {currentImage.tags.slice(0, 12).map((tag) => (
                <Pressable
                  key={tag}
                  role="button"
                  aria-label={t('detail.exploreTagAccessibility', { tag })}
                  onPress={() => onExploreTag(tag)}
                  style={({ pressed }) => ({
                    minHeight: 48,
                    justifyContent: 'center',
                    paddingHorizontal: 9,
                    borderRadius: metrics.radius.small,
                    backgroundColor: 'rgba(255, 255, 255, 0.12)',
                    opacity: pressed ? 0.64 : 1,
                  })}>
                  <Text numberOfLines={1} style={{ color: '#E7E8EA', fontSize: 12 }}>
                    {tag.replace(/_/g, ' ')}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          {isProviderPage && currentImage !== null && currentImage.downloadState === 'pending' ? (
            <Text selectable style={{ color: '#F0C178', fontSize: 13 }}>
              {t('detail.offlineSaving')}
            </Text>
          ) : null}
          {actionError ? (
            <Text
              testID="detail-action-error"
              selectable
              accessibilityLiveRegion="polite"
              style={{ color: '#FF9EAB', fontSize: 13 }}>
              {t(actionError)}
            </Text>
          ) : null}
          {actionNotice ? (
            <Text
              selectable
              accessibilityLiveRegion="polite"
              style={{ color: '#9ED7B5', fontSize: 13 }}>
              {t(actionNotice)}
            </Text>
          ) : null}
        </View>

        {isProviderPage
          && currentImage !== null
          && currentImage.downloadState === 'ready'
          && currentImage.libraryError !== null
          && onRepairLibrary !== undefined ? (
          <Pressable
            role="button"
            aria-label={t('detail.repairLibrary')}
            disabled={disabled}
            onPress={() => void runAction('repair', () => onRepairLibrary(currentImage.id))}
            style={({ pressed }) => ({
              minHeight: 48,
              marginHorizontal: metrics.spacing.medium,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: metrics.spacing.medium,
              borderWidth: 1,
              borderColor: '#D2D3D5',
              borderRadius: metrics.radius.medium,
              opacity: disabled ? 0.38 : pressed ? 0.64 : 1,
            })}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
              {t('detail.repairLibrary')}
            </Text>
          </Pressable>
        ) : null}

        {/* Board #5: repair re-downloads from the provider, which cannot work
            on a source the booru has deleted (404/410). The button is hidden
            for those rows; delete and return-to-discovery stay available. */}
        {isProviderPage
          && currentImage !== null
          && ((currentImage.downloadState === 'failed'
            && currentImage.downloadErrorKind !== 'source_gone')
            // K3 G3: a mirrored row is repairable only when its ORIGINAL is
            // unrecoverable — never for a missing derived variant. The detail
            // resolve reaches the original tier for animated / preview-less
            // assets, so an original-role integrity there is a genuine signal.
            || (currentImage.downloadState === 'mirrored'
              && currentEntry !== null
              && isOriginalUnrecoverable({
                hasLocalOriginal: currentEntry.hasLocalOriginal
                  && (!fastPathFailed.has(currentEntry.plaintextSha256)
                    || currentSource === undefined
                    || (currentSource?.kind === 'file' && currentSource.tier === 'local-original')),
                originalGenerationId: currentEntry.originalGenerationId,
                resolved: currentSource,
              }))) ? (
          <Pressable
            role="button"
            aria-label={t('detail.repair')}
            disabled={disabled}
            onPress={() => void runAction('repair', () => onRetry(currentImage.id))}
            style={({ pressed }) => ({
              minHeight: 48,
              marginHorizontal: metrics.spacing.medium,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: metrics.spacing.medium,
              borderWidth: 1,
              borderColor: '#D2D3D5',
              borderRadius: metrics.radius.medium,
              opacity: disabled ? 0.38 : pressed ? 0.64 : 1,
            })}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
              {t('detail.repair')}
            </Text>
          </Pressable>
        ) : null}

        <View
          aria-label={t('detail.commandsLabel')}
          style={{
            minHeight: 68,
            flexDirection: 'row',
            alignItems: 'stretch',
            paddingHorizontal: 4,
          }}>
          {currentItem.kind === 'image' ? (
            <>
              <GalleryActionButton
                label={t('detail.shareAccessibility')}
                visibleLabel={t('detail.shareLabel')}
                disabled={disabled || !canShareOrExport}
                onPress={() => void runAction('share', async () => {
                  await resolveFullBeforeAction(currentItem.image.id);
                  await onShare(currentItem.image.id);
                })}>
                <Share2 color="#FFFFFF" size={24} />
              </GalleryActionButton>
              <GalleryActionButton
                label={t('detail.exportAccessibility')}
                visibleLabel={t('detail.exportLabel')}
                disabled={disabled || !canShareOrExport}
                onPress={() => void runAction(
                  'export',
                  async () => {
                    await resolveFullBeforeAction(currentItem.image.id);
                    await onExport(currentItem.image.id);
                  },
                  () => showActionNotice('detail.exportSuccess'),
                )}>
                <Download color="#FFFFFF" size={24} />
              </GalleryActionButton>
              {currentItem.image.sourceUrl ? (
                <GalleryActionButton
                  label={t('detail.sourceAccessibility')}
                  visibleLabel={t('detail.sourceLabel')}
                  disabled={disabled}
                  onPress={() => {
                    void Linking.openURL(currentItem.image.sourceUrl!).catch(() => {
                      setActionError('detail.sourceOpenError');
                    });
                  }}>
                  <ExternalLink color="#FFFFFF" size={24} />
                </GalleryActionButton>
              ) : null}
              <GalleryActionButton
                destructive
                label={t('detail.deleteAccessibility')}
                visibleLabel={t('detail.deleteLabel')}
                disabled={disabled}
                onPress={confirmDelete}>
                <Trash2 color="#FF8FA3" size={24} />
              </GalleryActionButton>
              <GalleryActionButton
                destructive
                label={t('detail.returnAccessibility')}
                visibleLabel={t('detail.returnLabel')}
                disabled={disabled}
                onPress={confirmReturn}>
                <RotateCcw color="#FF8FA3" size={24} />
              </GalleryActionButton>
            </>
          ) : (
            <>
              <GalleryActionButton
                label={t('detail.shareAccessibility')}
                visibleLabel={t('detail.shareLabel')}
                disabled={disabled || !canShareOrExport || !onShareImport}
                onPress={() => void runAction('share', async () => {
                  const digest = currentItem.entry.plaintextSha256;
                  await resolveFullForDigestBeforeAction(digest);
                  await onShareImport!(digest);
                })}>
                <Share2 color="#FFFFFF" size={24} />
              </GalleryActionButton>
              <GalleryActionButton
                label={t('detail.saveToPhotosAccessibility')}
                visibleLabel={t('detail.saveToPhotosLabel')}
                disabled={disabled || !canShareOrExport || !onExportImport}
                onPress={() => void runAction(
                  'export',
                  async () => {
                    const digest = currentItem.entry.plaintextSha256;
                    await resolveFullForDigestBeforeAction(digest);
                    await onExportImport!(digest);
                  },
                  () => showActionNotice('detail.exportSuccess'),
                )}>
                <Download color="#FFFFFF" size={24} />
              </GalleryActionButton>
              <GalleryActionButton
                destructive
                label={t('detail.deleteAccessibility')}
                visibleLabel={t('detail.deleteLabel')}
                disabled={disabled || !onDeleteImport}
                onPress={confirmDelete}>
                <Trash2 color="#FF8FA3" size={24} />
              </GalleryActionButton>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

export function ImageDetailScreen({
  imageId,
  importSha256,
  galleryMode = 'mixed',
  galleryQuery,
}: {
  imageId?: number;
  importSha256?: string;
  galleryMode?: NsfwMode;
  galleryQuery?: CollectionBrowserQuery;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const {
    collectionService,
    imageRepository,
    dataRevision,
    libraryChanges,
    libraryController,
    libraryView,
    byosStatus,
  } = useAppServices();
  const [libraryEntries, setLibraryEntries] = useState<readonly LibraryEntry[]>(
    [],
  );
  const [entriesPending, setEntriesPending] = useState(
    () => libraryView != null && libraryView.model != null,
  );
  const [handedOver, setHandedOver] = useState<HandedOver | null>(null);
  // Once per mount. Reading does not consume the seed, so a StrictMode replay
  // of this initializer still sees it.
  const [openSeed] = useState<DetailOpenSeed | null>(() => {
    if (importSha256 !== undefined) {
      const uri = readDetailOpenSeed(importSha256);
      return uri === null ? null : { plaintextSha256: importSha256, uri };
    }
    if (imageId !== undefined) {
      const uri = readDetailOpenSeed(imageId);
      return uri === null ? null : { imageId, uri };
    }
    return null;
  });
  // Board #27 S1b: while mounted, this screen republishes a handed-over row
  // itself, after the entries read that follows the hand-over.
  useHandedOverPublisher();
  // K6-2b: one read at a time, plus exactly one more if changes arrived while
  // it was running. A flag, not a timer — spec §2 G2 allows no window.
  const readInFlight = useRef(false);
  const readAgainWhenDone = useRef(false);
  const libraryViewRef = useRef(libraryView);
  useEffect(() => {
    libraryViewRef.current = libraryView;
  }, [libraryView]);
  // Board #27 S1b (spec §5.5): images the library handed over since the last
  // read started. Each read takes the set as it starts and, once it has
  // completed, publishes exactly what it took — so a row turns `mirrored` only
  // after a read that began after its hand-over, and carries its entry. Ids
  // recorded during a read wait for the follow-up read the coalescing already
  // schedules.
  const pendingHandedOver = useRef(new Set<number>());
  const publishHandedOver = useCallback((imageIds: readonly number[]) => {
    setHandedOver((current) => ({ seq: (current?.seq ?? 0) + 1, imageIds }));
    // One row is one read; a burst (the migration) is one snapshot, one render.
    const published = imageIds.length === 1
      ? publishCollectionRow(queryClient, imageRepository, imageIds[0])
      : publishCollectionSnapshot(queryClient, imageRepository);
    void published.catch(() => undefined);
  }, [imageRepository, queryClient]);
  const refreshLibraryEntries = useCallback((handedOverId?: number) => {
    if (libraryView == null) {
      setLibraryEntries((current) => (current.length === 0 ? current : []));
      setEntriesPending(false);
      return;
    }
    if (handedOverId !== undefined) pendingHandedOver.current.add(handedOverId);
    if (readInFlight.current) {
      readAgainWhenDone.current = true;
      return;
    }
    const read = (): void => {
      const model = libraryViewRef.current?.model;
      if (model == null) {
        readInFlight.current = false;
        setLibraryEntries((current) => (current.length === 0 ? current : []));
        setEntriesPending(false);
        return;
      }
      readInFlight.current = true;
      const taken = [...pendingHandedOver.current];
      pendingHandedOver.current.clear();
      void model.listEntries()
        .then((next) => {
          if (libraryViewRef.current?.model !== model) return;
          setLibraryEntries(
            (current) => (sameLibraryEntries(current, next) ? current : next),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          const replaced = libraryViewRef.current?.model !== model;
          readInFlight.current = false;
          if (replaced) {
            for (const imageId of taken) pendingHandedOver.current.add(imageId);
          } else {
            setEntriesPending(false);
            // A failed read publishes too: the collection file is gone, so
            // `mirrored` is the row's truth whether or not its entry arrived.
            if (taken.length > 0) publishHandedOver(taken);
          }
          if (!readAgainWhenDone.current) return;
          readAgainWhenDone.current = false;
          read();
        });
    };
    read();
  }, [libraryView, publishHandedOver]);
  useEffect(() => {
    // Re-read the library overlay when the shared data revision bumps. Store
    // clears synchronously via libraryView == null.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshLibraryEntries();
  }, [dataRevision, refreshLibraryEntries]);
  // K6-2b (spec §2 G3): this screen is pushed, never focused as a tab, so
  // without the feed an upload that settles while the user is looking at the
  // image stays invisible until they back out and come in again.
  useEffect(() => {
    if (libraryChanges == null) return undefined;
    return libraryChanges.subscribe((change) => refreshLibraryEntries(
      change.kind === 'handed-over' ? change.imageId : undefined,
    ));
  }, [libraryChanges, refreshLibraryEntries]);
  const collectionQuery = useQuery({
    queryKey: collectionQueryKey(),
    queryFn: () => imageRepository.listCollection(),
    staleTime: Infinity,
  });
  const effectiveGalleryQuery = useMemo<CollectionBrowserQuery>(
    () => galleryQuery ?? { ...DEFAULT_COLLECTION_QUERY, mode: galleryMode },
    [galleryMode, galleryQuery],
  );
  const allItems = useMemo(
    () => buildCollectionItems(collectionQuery.data ?? [], libraryEntries),
    [collectionQuery.data, libraryEntries],
  );
  const galleryItems = useMemo(
    () => galleryQuery
      ? browseCollectionItems(allItems, effectiveGalleryQuery)
      : filterCollectionItemsByMode(allItems, galleryMode),
    [allItems, effectiveGalleryQuery, galleryMode, galleryQuery],
  );
  const galleryImages = useMemo(
    () => galleryItems
      .filter((item): item is Extract<CollectionItem, { kind: 'image' }> => item.kind === 'image')
      .map((item) => item.image),
    [galleryItems],
  );

  const openCollectionFilter = useCallback((filter: Partial<CollectionBrowserQuery>) => {
    const next = { ...DEFAULT_COLLECTION_QUERY, mode: effectiveGalleryQuery.mode, ...filter };
    router.dismissTo({
      pathname: '/collection',
      params: {
        query: next.text || undefined,
        field: next.field,
        mode: next.mode,
        provider: next.provider,
        sort: next.sort,
        focus: String(Date.now()),
      },
    });
  }, [effectiveGalleryQuery.mode, router]);

  const refreshCollection = useCallback(() => {
    return publishCollectionSnapshot(queryClient, imageRepository);
  }, [imageRepository, queryClient]);
  const syncAfterFailure = useCallback(async (error: unknown): Promise<never> => {
    await refreshCollection().catch(() => undefined);
    throw error;
  }, [refreshCollection]);

  const entriesById = useMemo(() => {
    const map = new Map<number, LibraryEntry>();
    for (const entry of libraryEntries) {
      // `listEntries` is newest first: the first entry of an image wins.
      const associatedIds = entry.associatedProviderImageIds !== undefined
        ? entry.associatedProviderImageIds
        : entry.sourceImageId !== null
          ? [entry.sourceImageId]
          : [];
      for (const id of associatedIds) {
        if (!map.has(id)) {
          map.set(id, entry);
        }
      }
    }
    return map;
  }, [libraryEntries]);
  const entriesByDigest = useMemo(() => {
    const map = new Map<string, LibraryEntry>();
    for (const entry of libraryEntries) {
      if (!map.has(entry.plaintextSha256)) {
        map.set(entry.plaintextSha256, entry);
      }
    }
    return map;
  }, [libraryEntries]);
  const access = libraryAccessFor(byosStatus);
  const dispatchFileAction = useCallback(async (
    id: number,
    onCollection: (imageId: number) => Promise<void>,
    onFile: (uri: string) => Promise<void>,
    releaseStagedFile = false,
  ) => {
    const current = (collectionQuery.data ?? []).find((img) => img.id === id);
    const target = current === undefined || libraryView == null
      ? { kind: 'collection' as const, imageId: id }
      : await resolveShareTarget(
          current,
          entriesById.get(id) ?? null,
          (digest) => libraryView.resolver.resolve(digest, 'full'),
          (sourceUri, fileName) => libraryView.shareFiles.stage(sourceUri, fileName),
        );
    if (target.kind === 'collection') return onCollection(target.imageId);
    if (target.kind === 'file') {
      if (!target.staged) return onFile(target.uri);
      // Board row 45: the system received a copy from the share staging area.
      // An export releases it as soon as the system is done (its own copy);
      // a share's copy stays until the next stage, the startup sweep, or
      // 删除全部应用数据, because the receiving app may still read the stream.
      try {
        return await onFile(target.uri);
      } finally {
        if (releaseStagedFile) await libraryView?.shareFiles.release(target.uri);
      }
    }
    if (target.kind === 'unavailable' && target.category === 'auth_attention' && access === 'disconnected') {
      // Board #27 S4 (spec §5.12, §5.16): a disconnected phone gets the image back
      // by reconnecting its library, not by getting online.
      throw new CollectionServiceError('cloud_only_disconnected', 'This image is only in the disconnected cloud library.');
    }
    if (target.kind === 'unavailable'
      && (target.category === 'offline' || target.category === 'auth_attention')) {
      // Board #27 S4 (spec §5.12): the original is only in the cloud library,
      // which this phone cannot reach now.
      throw new CollectionServiceError('cloud_only_offline', 'This image is only in the cloud library.');
    }
    throw new CollectionServiceError('not_ready', 'This image is not available offline yet.');
  }, [access, collectionQuery.data, entriesById, libraryView]);

  const dispatchImportFileAction = useCallback(async (
    plaintextSha256: string,
    onFile: (uri: string) => Promise<void>,
    releaseStagedFile = false,
  ) => {
    const entry = entriesByDigest.get(plaintextSha256) ?? null;
    if (entry === null || libraryView == null) {
      throw new CollectionServiceError('not_ready', 'This image is not available offline yet.');
    }
    const target = await resolveEntryShareTarget(
      entry,
      (digest) => libraryView.resolver.resolve(digest, 'full'),
      (sourceUri, fileName) => libraryView.shareFiles.stage(sourceUri, fileName),
    );
    if (target.kind === 'file') {
      if (!target.staged) return onFile(target.uri);
      try {
        return await onFile(target.uri);
      } finally {
        if (releaseStagedFile) await libraryView?.shareFiles.release(target.uri);
      }
    }
    if (target.kind === 'unavailable' && target.category === 'auth_attention' && access === 'disconnected') {
      throw new CollectionServiceError('cloud_only_disconnected', 'This image is only in the disconnected cloud library.');
    }
    if (target.kind === 'unavailable'
      && (target.category === 'offline' || target.category === 'auth_attention')) {
      throw new CollectionServiceError('cloud_only_offline', 'This image is only in the cloud library.');
    }
    throw new CollectionServiceError('not_ready', 'This image is not available offline yet.');
  }, [access, entriesByDigest, libraryView]);

  // Settled answers stay on screen and are marked stale when this function's
  // identity changes. A new library view or resolver does that; a new entries
  // array does not.
  const libraryResolver = libraryView?.resolver ?? null;
  const libraryResolve = useMemo(() => {
    if (libraryView == null || libraryResolver == null) return null;
    return (digest: string, intent: LibraryRenderIntent) => (
      libraryResolver.resolve(digest, intent)
    );
  }, [libraryResolver, libraryView]);
  const libraryOverlay = useMemo(() => (
    libraryView == null || libraryResolve == null
      ? null
      : {
          entries: libraryEntries,
          entriesPending,
          access,
          resolve: libraryResolve,
        }
  ), [access, entriesPending, libraryEntries, libraryResolve, libraryView]);

  const isLoading = (collectionQuery.data === undefined && collectionQuery.isPending)
    || (importSha256 !== undefined && entriesPending && libraryEntries.length === 0);

  return (
    <ImageDetailView
      images={galleryImages}
      items={galleryItems}
      initialImageId={imageId}
      initialImportSha256={importSha256}
      status={isLoading
        ? 'loading'
        : collectionQuery.data === undefined && collectionQuery.isError ? 'error' : 'ready'}
      errorMessage={collectionQuery.data === undefined && collectionQuery.isError
        ? t('detail.loadError')
        : null}
      safeInsets={{ top: insets.top, bottom: insets.bottom }}
      libraryOverlay={libraryOverlay}
      handedOver={handedOver}
      openSeed={openSeed}
      onClose={() => router.dismissTo('/collection')}
      onShare={async (id) => {
        try {
          await dispatchFileAction(
            id,
            (targetId) => collectionService.share(targetId),
            (uri) => collectionService.shareFile(uri),
          );
        } catch (error) {
          return syncAfterFailure(error);
        }
      }}
      onExport={async (id) => {
        try {
          await dispatchFileAction(
            id,
            (targetId) => collectionService.exportToPhotos(targetId),
            (uri) => collectionService.exportFile(uri),
            true,
          );
        } catch (error) {
          return syncAfterFailure(error);
        }
      }}
      onShareImport={async (digest) => {
        await dispatchImportFileAction(
          digest,
          (uri) => collectionService.shareFile(uri),
        );
      }}
      onExportImport={async (digest) => {
        await dispatchImportFileAction(
          digest,
          (uri) => collectionService.exportFile(uri),
          true,
        );
      }}
      onRetry={async (id) => {
        const current = (collectionQuery.data ?? []).find((img) => img.id === id);
        if (current?.downloadState === 'mirrored') {
          await collectionService.repairDownload(id);
        } else {
          await collectionService.retryDownload(id);
        }
        await refreshCollection();
      }}
      onRepairLibrary={!libraryController ? undefined : async (id) => {
        // K6-5 C: the provider file is fine; what failed is the ingest that
        // turns it into a library asset. Re-run exactly that, through the same
        // pool a fresh save uses, and wait for it so the button's busy state is
        // the truth rather than a guess.
        const row = (collectionQuery.data ?? []).find((image) => image.id === id);
        if (row?.localUri) {
          await libraryController.reingestCollectedOriginal({
            imageId: id,
            localUri: row.localUri,
          });
        }
        await refreshCollection();
      }}
      onDelete={async (id) => {
        await collectionService.deleteSaved(id);
        await refreshCollection();
      }}
      onDeleteImport={
        libraryController?.purgeImportedAsset
          ? async (digest) => {
              await libraryController.purgeImportedAsset!(digest);
              refreshLibraryEntries();
            }
          : undefined
      }
      onReturnToDiscovery={async (id) => {
        await collectionService.returnToDiscovery(id);
        await refreshCollection();
      }}
      onLocalFileMissing={async (id, observedUri) => {
        try {
          // Board #27 (spec §5.5 rule 3): repairs only while the row still
          // holds the file the page failed to load; `stale` otherwise, and the
          // re-read below shows the row as it is now.
          const result = await collectionService.repairMissingFile(id, observedUri);
          return result.status === 'ready' && !result.reused;
        } catch {
          return false;
        } finally {
          await refreshCollection();
        }
      }}
      onExploreArtist={(artist) => openCollectionFilter({
        text: artist,
        field: 'artist',
      })}
      onExploreProvider={(image) => openCollectionFilter({
        provider: image.providerKey,
      })}
      onExploreTag={(tag) => {
        router.dismissTo({
          pathname: '/search',
          params: {
            query: tag,
            focus: String(Date.now()),
          },
        });
      }}
      onReload={() => void collectionQuery.refetch()}
    />
  );
}
