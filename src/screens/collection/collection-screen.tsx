import { FlashList } from '@shopify/flash-list';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ImagePlus,
  Search,
  Trash2,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  findNodeHandle,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type ViewToken,
} from 'react-native';

import { isSyncedToCloud } from '@/components/residency-badge';
import { isOnlyInCloud, isOriginalUnrecoverable } from '@/features/library/library-render-availability';
import { ScreenState } from '@/components/screen-state';
import SegmentedControl from '@/components/segmented-control';
import type { CollectionService } from '@/features/collection/collection-service';
import {
  browseCollectionItems,
  buildCollectionItems,
  collectionItemSourceOptions,
  countCollectionItemsByMode,
  DEFAULT_COLLECTION_QUERY,
  filterCollectionItemsByMode,
  normalizeCollectionBrowserQuery,
  type CollectionBrowserQuery,
  type CollectionItem,
  type CollectionProvider,
  type CollectionSort,
} from '@/features/collection/collection-filter';
import {
  collectionQueryKey,
  publishCollectionRow,
  publishCollectionSnapshot,
} from '@/features/collection/collection-query';
import { CollectionServiceError } from '@/features/collection/file-repository';
import {
  APP_DISTRIBUTION_POLICY,
  DIRECT_DISTRIBUTION_POLICY,
  STORE_DISTRIBUTION_POLICY,
} from '@/features/distribution/distribution-policy';
import type { StoredImage } from '@/features/images/image-repository';
import { LIBRARY_RENDER_WINDOW_AHEAD } from '@/features/library/library-cache-limits';
import type { LibraryRenderIntent } from '@/features/library/library-actions-types';
import type { LibraryRenderSource } from '@/features/library/library-render-source';
import { takeResidencyChanges } from '@/features/library/library-entry-residency';
import { libraryAccessFor, type LibraryAccess } from '@/features/library/library-access';
import type {
  LibraryImportResultDescriptor,
  LibraryImportSessionController,
  LibraryImportSessionState,
} from '@/features/library/library-import-session';
import type { LibraryEntry } from '@/features/library/library-view-model';
import { providerLabel } from '@/features/providers/provider-label';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import type { NsfwMode } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';
import { useHandedOverPublisher, type HandedOver } from '@/providers/handed-over-publishers';
import { CollectionTile } from '@/screens/collection/collection-tile';
import { LibraryAssetTile } from '@/screens/collection/library-asset-tile';
import { setDetailOpenSeed } from '@/screens/image-detail/detail-open-seed';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { fontFamilies } from '@/theme/typography';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';

/** Direct-only. `null` keeps the accepted local grid exactly as it is. */
export type LibraryOverlay = Readonly<{
  entries: readonly LibraryEntry[];
  /**
   * True until the first `listEntries()` read has settled (resolved or
   * rejected). Any file-less row — mirrored, or a failed/saving row with no
   * collection file — may be library-owned before its entry is known, so the
   * grid and the viewer hold its colour block instead of fetching the provider
   * URL in that gap (board #9, spec §5.1).
   */
  entriesPending?: boolean;
  /**
   * Board #27 S4: the composition's `libraryAccessFor(byosStatus)`; absent
   * reads `ready`.
   */
  access?: LibraryAccess;
  resolve(
    plaintextSha256: string,
    intent: LibraryRenderIntent,
  ): Promise<LibraryRenderSource>;
}>;

/**
 * K7 ⑦ + N6-B1 (spec §4.5): the fields the grid actually filters, sorts, and
 * renders from. A read that returns the same library in the same order is the
 * common case (a tab tap, a change feed event for a row that is already
 * painted), and it must not replace the array; conversely a changed origin,
 * classification, timestamp, dimensions, or byte size must publish.
 */
function sameAssociatedIds(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  if (a === b) return true;
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function sameLibraryEntries(
  a: readonly LibraryEntry[],
  b: readonly LibraryEntry[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index]!;
    return entry.plaintextSha256 === other.plaintextSha256
      && entry.sourceImageId === other.sourceImageId
      && sameAssociatedIds(entry.associatedProviderImageIds, other.associatedProviderImageIds)
      && (entry.origin ?? 'import') === (other.origin ?? 'import')
      && (entry.importClassification ?? 'unknown') === (other.importClassification ?? 'unknown')
      && (entry.importDeletedAt ?? null) === (other.importDeletedAt ?? null)
      && (entry.hasImportMembership ?? false) === (other.hasImportMembership ?? false)
      && entry.format === other.format
      && entry.byteSize === other.byteSize
      && entry.width === other.width
      && entry.height === other.height
      && entry.createdAt === other.createdAt
      && entry.protection === other.protection
      && entry.residency === other.residency
      && entry.lifecycle === other.lifecycle
      && entry.hasLocalOriginal === other.hasLocalOriginal
      && entry.localOriginalUri === other.localOriginalUri
      && entry.originalGenerationId === other.originalGenerationId
      && entry.failureCategory === other.failureCategory;
  });
}

export function getCollectionColumnCount(width: number): 3 | 5 {
  return width >= 700 ? 5 : 3;
}

const COLLECTION_MODES: readonly NsfwMode[] = ['mixed', 'sfw', 'nsfw'];
const COLLECTION_SORTS: readonly CollectionSort[] = [
  'newest',
  'oldest',
  'resolution',
  'fileSize',
];
const REGISTRY_KEYS = PROVIDER_REGISTRY.map((adapter) => adapter.key);

type CollectionChoice = CollectionProvider | CollectionSort;

function CollectionChoiceSheet({
  current,
  options,
  title,
  visible,
  onClose,
  onSelect,
}: {
  current: CollectionChoice;
  options: readonly { label: string; value: CollectionChoice; count?: number }[];
  title: string;
  visible: boolean;
  onClose(): void;
  onSelect(value: CollectionChoice): void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const { height } = useWindowDimensions();
  const titleRef = useRef<Text>(null);

  useEffect(() => {
    if (!visible) return undefined;
    const focusTimer = setTimeout(() => {
      const target = findNodeHandle(titleRef.current);
      if (target !== null) AccessibilityInfo.setAccessibilityFocus(target);
    }, 80);
    return () => clearTimeout(focusTimer);
  }, [visible]);

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          role="button"
          aria-label={t('collection.closeOptions')}
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: 'rgba(8, 8, 10, 0.58)',
          }}
        />
        <View
          accessibilityViewIsModal
          onStartShouldSetResponder={() => true}
          style={{
            paddingTop: metrics.spacing.medium,
            paddingBottom: metrics.spacing.large,
            backgroundColor: theme.surface,
            borderTopLeftRadius: metrics.radius.large,
            borderTopRightRadius: metrics.radius.large,
          }}>
          <Text
            ref={titleRef}
            accessibilityRole="header"
            style={{
              paddingHorizontal: metrics.contentPadding,
              paddingBottom: metrics.spacing.small,
              color: theme.text,
              fontSize: 18,
              fontWeight: '700',
            }}>
            {title}
          </Text>
          {/* 12 sources must stay reachable on short screens and with large
            fonts, so the rows scroll instead of growing the sheet. */}
          <ScrollView
            testID="collection-choice-options"
            style={{ maxHeight: height * 0.7 }}>
            {options.map((option) => {
              const selected = option.value === current;
              return (
                <Pressable
                  key={option.value}
                  role="button"
                  aria-label={option.label}
                  accessibilityState={{ selected }}
                  accessibilityValue={typeof option.count === 'number'
                    ? { text: t('collection.chipCount', { count: option.count }) }
                    : undefined}
                  onPress={() => onSelect(option.value)}
                  style={({ pressed }) => ({
                    minHeight: 52,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: metrics.contentPadding,
                    paddingVertical: metrics.spacing.small,
                    backgroundColor: selected ? `${theme.save}12` : 'transparent',
                    opacity: pressed ? 0.62 : 1,
                  })}>
                  <Text
                    style={{
                      flex: 1,
                      flexShrink: 1,
                      minWidth: 0,
                      color: selected ? theme.save : theme.text,
                      fontSize: 16,
                      fontWeight: selected ? '600' : '400',
                    }}>
                    {option.label}
                  </Text>
                  <View style={{
                    flexShrink: 0,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    {typeof option.count === 'number' ? (
                      <Text style={{
                        color: theme.textSecondary,
                        fontSize: 15,
                        fontFamily: fontFamilies.sansMedium,
                        fontVariant: ['tabular-nums'],
                      }}>
                        {t('collection.chipCount', { count: option.count })}
                      </Text>
                    ) : null}
                    {selected ? <Check color={theme.save} size={21} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function CollectionImportChoiceSheet({
  visible,
  count,
  onSelectClassification,
  onCancel,
}: {
  visible: boolean;
  count: number;
  onSelectClassification: (classification: 'safe' | 'adult') => void;
  onCancel: () => void;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const titleRef = useRef<Text>(null);

  useEffect(() => {
    if (!visible) return undefined;
    const focusTimer = setTimeout(() => {
      const target = findNodeHandle(titleRef.current);
      if (target !== null) AccessibilityInfo.setAccessibilityFocus(target);
    }, 80);
    return () => clearTimeout(focusTimer);
  }, [visible]);

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          role="button"
          aria-label={t('collection.import.cancel')}
          onPress={onCancel}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: 'rgba(8, 8, 10, 0.58)',
          }}
        />
        <View
          testID="collection-import-sheet"
          accessibilityViewIsModal
          onStartShouldSetResponder={() => true}
          style={{
            paddingTop: metrics.spacing.medium,
            paddingBottom: metrics.spacing.large,
            paddingHorizontal: metrics.contentPadding,
            backgroundColor: theme.surface,
            borderTopLeftRadius: metrics.radius.large,
            borderTopRightRadius: metrics.radius.large,
            gap: metrics.spacing.small,
          }}>
          <Text
            ref={titleRef}
            accessibilityRole="header"
            style={{
              color: theme.text,
              fontSize: 18,
              fontWeight: '700',
            }}>
            {t('collection.import.sheetTitle', { count })}
          </Text>
          <Text
            style={{
              color: theme.textSecondary,
              fontSize: 14,
              lineHeight: 20,
              marginBottom: 4,
            }}>
            {t('collection.import.sheetConstraint')}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              gap: metrics.spacing.small,
            }}>
            <Pressable
              testID="collection-import-safe"
              role="button"
              aria-label={t('collection.import.choiceSafe')}
              onPress={() => onSelectClassification('safe')}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 48,
                paddingHorizontal: metrics.spacing.medium,
                paddingVertical: metrics.spacing.small,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: metrics.radius.medium,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceSecondary,
                opacity: pressed ? 0.72 : 1,
              })}>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 16,
                  fontWeight: '600',
                  textAlign: 'center',
                }}>
                {t('collection.import.choiceSafe')}
              </Text>
            </Pressable>
            <Pressable
              testID="collection-import-adult"
              role="button"
              aria-label={t('collection.import.choiceAdult')}
              onPress={() => onSelectClassification('adult')}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 48,
                paddingHorizontal: metrics.spacing.medium,
                paddingVertical: metrics.spacing.small,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: metrics.radius.medium,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surfaceSecondary,
                opacity: pressed ? 0.72 : 1,
              })}>
              <Text
                style={{
                  color: theme.text,
                  fontSize: 16,
                  fontWeight: '600',
                  textAlign: 'center',
                }}>
                {t('collection.import.choiceAdult')}
              </Text>
            </Pressable>
          </View>
          <Pressable
            testID="collection-import-cancel"
            role="button"
            aria-label={t('collection.import.cancel')}
            onPress={onCancel}
            style={({ pressed }) => ({
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: metrics.radius.medium,
              opacity: pressed ? 0.64 : 1,
            })}>
            <Text
              style={{
                color: theme.textSecondary,
                fontSize: 15,
                fontWeight: '500',
              }}>
              {t('collection.import.cancel')}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function formatImportResultLines(
  result: LibraryImportResultDescriptor,
  t: (key: string, options?: Record<string, unknown>) => string,
): { primary: string; notes: string[] } {
  if (result.kind === 'picker-failed') {
    return {
      primary: t('collection.import.pickerFailed'),
      notes: [],
    };
  }
  if (result.kind === 'exceeded-limit') {
    return {
      primary: t('collection.import.exceededLimit', { limit: result.limit }),
      notes: [],
    };
  }

  const parts: string[] = [];
  if (result.addedCount > 0) {
    parts.push(t('collection.import.resultAdded', { count: result.addedCount }));
  }
  if (result.existingCount > 0) {
    parts.push(t('collection.import.resultExisting', { count: result.existingCount }));
  }
  if (result.failedCount > 0) {
    parts.push(t('collection.import.resultFailed', { count: result.failedCount }));
  }
  const primary = parts.join(' · ');

  const notes: string[] = [];
  if (result.overCapCount > 0) {
    notes.push(
      t('collection.import.overCapRejected', { count: result.overCapCount }),
    );
  }
  if (result.retainedClassificationCount > 0) {
    notes.push(
      t('collection.import.retainedClassification', {
        count: result.retainedClassificationCount,
      }),
    );
  }
  if (result.nextStep !== null) {
    notes.push(t(`collection.import.nextStep.${result.nextStep}`));
  }

  return { primary, notes };
}

export async function deleteSelectedImages(
  service: CollectionService,
  imageIds: readonly number[],
): Promise<void> {
  const results = await Promise.allSettled(
    imageIds.map((imageId) => service.deleteSaved(imageId)),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

type CollectionErrorKey =
  | 'collection.errorOperationBlocked'
  | 'collection.errorDeleteFailed'
  | 'collection.errorDatabaseFailed'
  | 'collection.errorGeneric';

function userSafeMessageKey(error: unknown): CollectionErrorKey {
  if (error instanceof CollectionServiceError) {
    if (error.code === 'operation_blocked') return 'collection.errorOperationBlocked';
    if (error.code === 'delete_failed') return 'collection.errorDeleteFailed';
    if (error.code === 'database_failed') return 'collection.errorDatabaseFailed';
  }
  return 'collection.errorGeneric';
}

export type CollectionViewProps = {
  images: readonly StoredImage[];
  status: 'loading' | 'error' | 'ready';
  errorMessage: string | null;
  blurNsfwThumbnails: boolean;
  allowsAdultContent?: boolean;
  initialQuery?: Partial<CollectionBrowserQuery>;
  refreshing?: boolean;
  viewportWidth?: number;
  onBrowse: () => void;
  onOpen: (imageId: number, query: CollectionBrowserQuery) => void;
  onOpenImport?: (plaintextSha256: string, query: CollectionBrowserQuery) => void;
  onRefresh: () => void;
  onDelete: (imageIds: number[]) => Promise<void>;
  /** N6-B1 (spec §4.8): device-local digest-membership purge for selected imports. */
  onDeleteImports?: (plaintextSha256s: string[]) => Promise<void>;
  onRepair?: (imageId: number, observedUri: string) => boolean | void | Promise<boolean | void>;
  /**
   * Redesign 2026-09-15: opens the library trash. Set only when a Direct
   * library exists; the compact header trash button renders when it is present
   * and the grid is not in selection mode. The entry moved here from the
   * settings 云同步 section.
   */
  onOpenTrash?: () => void;
  /**
   * Ledger N6-B2 (spec §4.1–§4.2): service-owned import batch session
   * controller. When present, renders `collection-import-entry` immediately
   * before `collection-trash-entry` in both populated and empty collection
   * states, plus the classification bottom sheet and progress/result feedback.
   */
  importSession?: LibraryImportSessionController | null;
  /** Direct-only. `null` keeps the accepted local grid exactly as it is. */
  libraryOverlay?: LibraryOverlay | null;
  /**
   * Board #27 S1b (spec §5.5): the container's hand-over publications. Each new
   * object names images the library just took over; the view offers a failed
   * fast path for each of them again (the hand-over verified its original).
   */
  handedOver?: HandedOver | null;
  /**
   * R8.21: device top inset. The four tabs are headerless (R8.17), so each
   * surface clears the status bar/cutout itself. Defaults to the live inset;
   * overridable for tests.
   */
  safeAreaTop?: number;
};

export function CollectionView({
  images,
  status,
  errorMessage,
  blurNsfwThumbnails,
  allowsAdultContent = APP_DISTRIBUTION_POLICY.allowsAdultContent,
  initialQuery,
  refreshing = false,
  viewportWidth,
  onBrowse,
  onOpen,
  onOpenImport,
  onRefresh,
  onDelete,
  onDeleteImports,
  onRepair = () => false,
  onOpenTrash,
  importSession = null,
  libraryOverlay = null,
  handedOver = null,
  safeAreaTop,
}: CollectionViewProps) {
  const theme = useAppThemeColors();
  // R8.17: the floating tab bar overlays this list; the content's tail must
  // always be able to scroll out from under it.
  const insets = useSafeAreaInsets();
  const topInset = safeAreaTop ?? insets.top;
  const { t } = useAppTranslation();
  const window = useWindowDimensions();
  const distributionPolicy = allowsAdultContent
    ? DIRECT_DISTRIBUTION_POLICY
    : STORE_DISTRIBUTION_POLICY;
  const columns = getCollectionColumnCount(viewportWidth ?? window.width);

  const [importSessionState, setImportSessionState] = useState<LibraryImportSessionState>(
    () => importSession?.getState() ?? { phase: 'idle' },
  );
  const [trackedImportSession, setTrackedImportSession] = useState(importSession);
  if (trackedImportSession !== importSession) {
    setTrackedImportSession(importSession);
    setImportSessionState(importSession?.getState() ?? { phase: 'idle' });
  }
  useEffect(() => {
    if (importSession == null) {
      return undefined;
    }
    return importSession.subscribe((next) => {
      setImportSessionState(next);
    });
  }, [importSession]);

  useEffect(() => {
    if (
      importSession != null
      && importSessionState.phase === 'result'
      && !importSessionState.result.presented
    ) {
      importSession.markResultPresented();
    }
  }, [importSession, importSessionState]);

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

  const allItems = useMemo(
    () => buildCollectionItems(images, libraryOverlay?.entries ?? []),
    [images, libraryOverlay],
  );

  // N6-B1 (spec §4.5, §4.8): selection uses discriminated item keys
  // (`image:<id>`, `import:<sha256>`, `legacy:<sha256>`) and is pruned by live
  // collection membership.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const liveItemKeys = useMemo(
    () => new Set<string>(allItems.map((item) => item.key)),
    [allItems],
  );
  const [knownItemKeys, setKnownItemKeys] = useState(liveItemKeys);
  if (
    liveItemKeys.size !== knownItemKeys.size ||
    [...liveItemKeys].some((key) => !knownItemKeys.has(key))
  ) {
    setKnownItemKeys(liveItemKeys);
    setSelectedKeys((current) => new Set(
      [...current].filter((key) => liveItemKeys.has(key)),
    ));
  }

  const [operationError, setOperationError] = useState<CollectionErrorKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [browserQuery, setBrowserQuery] = useState<CollectionBrowserQuery>(
    () => normalizeCollectionBrowserQuery(initialQuery, distributionPolicy),
  );
  const [choiceSheet, setChoiceSheet] = useState<'provider' | 'sort' | null>(null);
  const selectionMode = selectedKeys.size > 0;

  const sortedAllItems = useMemo(
    () => browseCollectionItems(allItems, DEFAULT_COLLECTION_QUERY, distributionPolicy),
    [allItems, distributionPolicy],
  );
  // R8.27 + N6-B1 (spec §4.6): the chip counts describe the text+source query
  // before mode, including imports (`mixed = safe + adult + unknown`,
  // `sfw = safe`, `nsfw = adult + unknown`).
  const searchedItems = useMemo(
    () => browseCollectionItems(
      allItems,
      { ...browserQuery, mode: 'mixed' },
      distributionPolicy,
    ),
    [allItems, browserQuery, distributionPolicy],
  );
  const gridItems = useMemo(
    () => filterCollectionItemsByMode(searchedItems, browserQuery.mode, distributionPolicy),
    [browserQuery.mode, distributionPolicy, searchedItems],
  );
  const modeCounts = useMemo(
    () => countCollectionItemsByMode(searchedItems, distributionPolicy),
    [distributionPolicy, searchedItems],
  );
  const blurVisibleNsfw = browserQuery.mode === 'mixed' && blurNsfwThumbnails;
  const hasBrowserFilter = browserQuery.text.trim().length > 0
    || browserQuery.provider !== 'all';

  // Ledger N2 + N6-B1 (spec §4.6): the source sheet counts the list after the
  // text and mode filters and before the source filter, including `我的导入`.
  const sourceCountItems = useMemo(
    () => filterCollectionItemsByMode(
      browseCollectionItems(
        allItems,
        { ...browserQuery, provider: 'all', mode: 'mixed' },
        distributionPolicy,
      ),
      browserQuery.mode,
      distributionPolicy,
    ),
    [allItems, browserQuery, distributionPolicy],
  );
  const sourceOptions = useMemo(
    () => collectionItemSourceOptions(
      sourceCountItems,
      browserQuery.provider,
      REGISTRY_KEYS,
    ),
    [browserQuery.provider, sourceCountItems],
  );

  // `null` = the resolve rejected (an unexpected error, not a resolver
  // verdict): the row falls back to what it rendered before the library
  // existed instead of sitting on its colour block forever.
  const [resolvedSources, setResolvedSources] = useState(
    () => new Map<string, LibraryRenderSource | null>(),
  );
  const resolvedRef = useRef(resolvedSources);
  const inFlightRef = useRef(new Set<string>());
  // Board row 52: bumped when the resolver identity changes, so an answer
  // started by the previous composition cannot publish. Digests in
  // `staleResolvedRef` are still on screen from that composition; the new
  // resolver replaces each one when its own answer arrives.
  const resolverEpochRef = useRef(0);
  const staleResolvedRef = useRef(new Set<string>());
  const highestViewableIndexRef = useRef(0);
  const [highestViewableIndex, setHighestViewableIndex] = useState(0);

  const digestForGridItem = useCallback((item: CollectionItem): string | null => {
    if (item.kind !== 'image') return item.entry.plaintextSha256;
    return entriesByImageId.get(item.image.id)?.plaintextSha256 ?? null;
  }, [entriesByImageId]);

  /**
   * K7 ⑥: the grid only resolves a row the collection cannot serve — a
   * cloud-only library row, a row with no file, or a `mirrored` row. A `ready`
   * file stays the collection's whatever its library entry says.
   */
  /**
   * Board #27 (spec §5.7): a saved row whose entry holds the local original
   * renders it straight from disk — no resolve — until that load fails once
   * (`fastPathFailedFor`), after which the resolver serves the row. A ref for
   * the once-per-digest guard, a state set for the renders and the gate.
   */
  const fastPathFailedRef = useRef(new Set<string>());
  const [fastPathFailed, setFastPathFailed] = useState(() => new Set<string>());
  const resolveGenerationRef = useRef(new Map<string, number>());

  /** Today's ownership rule: the collection cannot serve the row itself. */
  const isResolverOwned = useCallback((item: CollectionItem): boolean => {
    if (item.kind !== 'image') return true;
    const entry = entriesByImageId.get(item.image.id);
    if (entry === undefined) return false;
    return item.image.localUri === null
      || item.image.downloadState === 'mirrored';
  }, [entriesByImageId]);

  /** The entry's local original, for a row the caller has found resolver-owned. */
  const fastPathUriFor = useCallback((item: CollectionItem): string | null => {
    const entry = item.kind === 'image'
      ? entriesByImageId.get(item.image.id)
      : item.entry;
    if (entry === undefined) return null;
    if (entry.localOriginalUri === null || fastPathFailed.has(entry.plaintextSha256)) return null;
    return entry.localOriginalUri;
  }, [entriesByImageId, fastPathFailed]);

  const gridItemNeedsResolve = useCallback((item: CollectionItem): boolean => (
    isResolverOwned(item) && fastPathUriFor(item) === null
  ), [fastPathUriFor, isResolverOwned]);

  // K7 ⑥: resolves land one at a time, and each used to copy the whole Map and
  // set state — N resolves meant N full-grid repaints on the frame the tab
  // opened. Completions accumulate here and are published once per frame.
  const pendingResolvesRef = useRef(new Map<string, LibraryRenderSource | null>());
  const publishFrameRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (publishFrameRef.current !== null) {
      cancelAnimationFrame(publishFrameRef.current);
      publishFrameRef.current = null;
    }
  }, []);

  const resolveGenerationOf = useCallback((digest: string): number => (
    resolveGenerationRef.current.get(digest) ?? 0
  ), []);

  // The fast path's local original failed to load. The once-per-digest guard
  // lives here, not in the tile: a gif too large to animate re-fires its
  // callback on every render. The digest's generation is bumped and everything
  // an older resolve left behind is dropped, so exactly one fresh `grid`
  // resolve runs and an older one, settled or in flight, cannot stand in for it.
  const fastPathFailedFor = useCallback((digest: string) => {
    if (fastPathFailedRef.current.has(digest)) return;
    fastPathFailedRef.current.add(digest);
    resolveGenerationRef.current.set(
      digest,
      (resolveGenerationRef.current.get(digest) ?? 0) + 1,
    );
    if (resolvedRef.current.has(digest)) {
      const next = new Map(resolvedRef.current);
      next.delete(digest);
      resolvedRef.current = next;
      setResolvedSources(next);
    }
    staleResolvedRef.current.delete(digest);
    pendingResolvesRef.current.delete(digest);
    inFlightRef.current.delete(digest);
    setFastPathFailed(new Set(fastPathFailedRef.current));
  }, []);

  // A tile's `onOverrideFailed` must keep its identity across screen rerenders,
  // or the memoized `CollectionTile` re-renders on every unrelated change. Cache
  // one bound callback per digest; `fastPathFailedFor` is itself stable.
  const fastPathHandlerCache = useRef(new Map<string, () => void>());
  const fastPathHandlerFor = useCallback((digest: string): (() => void) => {
    const cached = fastPathHandlerCache.current.get(digest);
    if (cached !== undefined) return cached;
    const handler = () => fastPathFailedFor(digest);
    fastPathHandlerCache.current.set(digest, handler);
    return handler;
  }, [fastPathFailedFor]);

  const publishResolved = useCallback((digest: string, source: LibraryRenderSource | null) => {
    pendingResolvesRef.current.set(digest, source);
    if (publishFrameRef.current !== null) return;
    publishFrameRef.current = requestAnimationFrame(() => {
      publishFrameRef.current = null;
      const pending = pendingResolvesRef.current;
      if (pending.size === 0) return;
      pendingResolvesRef.current = new Map();
      const next = new Map(resolvedRef.current);
      for (const [key, value] of pending) {
        // A digest already on screen keeps its first answer. A stale one is
        // the previous resolver's picture, and this answer replaces it.
        if (next.has(key) && !staleResolvedRef.current.has(key)) continue;
        next.set(key, value);
        staleResolvedRef.current.delete(key);
      }
      resolvedRef.current = next;
      setResolvedSources(next);
    });
  }, []);

  const scheduleWindowResolves = useCallback((upToIndex: number) => {
    if (libraryOverlay === null) return;
    const limit = Math.min(gridItems.length - 1, upToIndex + LIBRARY_RENDER_WINDOW_AHEAD);
    for (let index = 0; index <= limit; index += 1) {
      const item = gridItems[index];
      if (!item) continue;
      if (!gridItemNeedsResolve(item)) continue;
      const digest = digestForGridItem(item);
      if (digest === null) continue;
      if (inFlightRef.current.has(digest) || pendingResolvesRef.current.has(digest)) {
        continue;
      }
      // A settled answer stays on screen. A stale one is resolved again, and
      // the new answer is what replaces it.
      if (resolvedRef.current.has(digest) && !staleResolvedRef.current.has(digest)) {
        continue;
      }
      inFlightRef.current.add(digest);
      const generation = resolveGenerationOf(digest);
      const resolverEpoch = resolverEpochRef.current;
      const current = () => resolveGenerationOf(digest) === generation
        && resolverEpochRef.current === resolverEpoch;
      const stillOpen = () => current()
        && !(resolvedRef.current.has(digest) && !staleResolvedRef.current.has(digest));
      void libraryOverlay.resolve(digest, 'grid')
        .then((source) => {
          if (!stillOpen()) return;
          publishResolved(digest, source);
        })
        .catch(() => {
          if (!stillOpen()) return;
          publishResolved(digest, null);
        })
        .finally(() => {
          if (current()) inFlightRef.current.delete(digest);
        });
    }
  }, [
    digestForGridItem,
    gridItemNeedsResolve,
    gridItems,
    libraryOverlay,
    publishResolved,
    resolveGenerationOf,
  ]);

  // Board #27 S3b (spec §5.12): a resolve describes the residency it was made
  // for. When an entries read shows that residency moved, the digest is
  // resolved afresh — as after a fast-path failure — so an evicted tile never
  // keeps pointing at its deleted original. Declared before the resolve
  // effect, which then sees the digest unresolved in the same commit.
  const residencySeenRef = useRef(new Map<string, string>());
  // Board row 52: a recovery rebind replaces the resolver without moving
  // residency. Settled answers stay on screen and are marked stale, so the
  // window resolves them again and replaces each one when the new answer
  // arrives. An in-flight answer from the old resolver cannot publish.
  const resolverSeenRef = useRef(libraryOverlay?.resolve);
  useEffect(() => {
    const resolve = libraryOverlay?.resolve;
    if (resolverSeenRef.current === resolve) return;
    resolverSeenRef.current = resolve;
    resolverEpochRef.current += 1;
    pendingResolvesRef.current = new Map();
    if (publishFrameRef.current !== null) {
      cancelAnimationFrame(publishFrameRef.current);
      publishFrameRef.current = null;
    }
    inFlightRef.current.clear();
    staleResolvedRef.current = new Set(resolvedRef.current.keys());
  }, [libraryOverlay?.resolve]);
  const overlayEntries = libraryOverlay?.entries ?? null;
  useEffect(() => {
    if (overlayEntries === null) return;
    const changed = takeResidencyChanges(residencySeenRef.current, overlayEntries);
    if (changed.length === 0) return;
    let next: Map<string, LibraryRenderSource | null> | null = null;
    for (const digest of changed) {
      resolveGenerationRef.current.set(digest, resolveGenerationOf(digest) + 1);
      pendingResolvesRef.current.delete(digest);
      inFlightRef.current.delete(digest);
      staleResolvedRef.current.delete(digest);
      if (resolvedRef.current.has(digest)) {
        next ??= new Map(resolvedRef.current);
        next.delete(digest);
      }
    }
    if (next !== null) {
      resolvedRef.current = next;
      setResolvedSources(next);
    }
  }, [overlayEntries, resolveGenerationOf]);

  useEffect(() => {
    if (libraryOverlay === null) return;
    scheduleWindowResolves(highestViewableIndex);
  }, [highestViewableIndex, libraryOverlay, scheduleWindowResolves]);

  // A failed fast path is offered again once the screen sees its row with the
  // fast path withheld for another reason: the entry lost its local original,
  // or the row now holds its own collection file (not resolver-owned). Either
  // transition took a DB write that put fresh bytes in place, so re-offering
  // cannot loop — a load failure writes nothing and never leaves this state.
  // The resolved map and the generation are left alone; a later failure clears
  // them itself, and an absent entry forgets nothing.
  useEffect(() => {
    if (fastPathFailed.size === 0) return;
    let changed = false;
    for (const item of gridItems) {
      const entry = item.kind === 'image'
        ? entriesByImageId.get(item.image.id)
        : item.entry;
      if (entry === undefined) continue;
      if (!fastPathFailed.has(entry.plaintextSha256)) continue;
      if (entry.localOriginalUri === null || !isResolverOwned(item)) {
        // Only a digest actually removed changes the set, so this effect can never re-trigger itself.
        if (fastPathFailedRef.current.delete(entry.plaintextSha256)) changed = true;
      }
    }
    if (changed) setFastPathFailed(new Set(fastPathFailedRef.current));
  }, [gridItems, entriesByImageId, fastPathFailed, isResolverOwned]);

  // Board #27 S1b (spec §5.5): a hand-over has just verified the image's local
  // original, so a fast path that failed earlier is offered again — even when
  // this screen never saw the row's intermediate `ready` state. Once per
  // publication (`seq`), so a later failure is not forgotten again by the next
  // entries read; only a digest actually removed changes the set.
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

  // K7 ⑥: a fresh object literal here re-rendered every tile on every render of
  // the screen, whether or not any of these five actually moved.
  const gridExtraData = useMemo(() => ({
    selectedIds: selectedKeys,
    selectionMode,
    blurVisibleNsfw,
    resolvedSources,
    fastPathFailed,
  }), [blurVisibleNsfw, fastPathFailed, resolvedSources, selectedKeys, selectionMode]);

  const onViewableItemsChanged = useCallback((
    info: { viewableItems: ViewToken[] },
  ) => {
    let highest = highestViewableIndexRef.current;
    for (const token of info.viewableItems) {
      if (typeof token.index === 'number' && token.index > highest) {
        highest = token.index;
      }
    }
    if (highest === highestViewableIndexRef.current) return;
    highestViewableIndexRef.current = highest;
    setHighestViewableIndex(highest);
  }, []);

  const updateBrowserQuery = useCallback((update: Partial<CollectionBrowserQuery>) => {
    setSelectedKeys(new Set());
    setBrowserQuery((current) => ({ ...current, ...update }));
  }, []);

  const toggleSelection = useCallback((itemKey: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  }, []);

  // K7 ⑥: memoizing the tile only buys anything if its handlers keep the same
  // identity across renders. These read the newest values through a ref and are
  // cached per item, so a filter or selection change never rewrites 40
  // tiles' props.
  // Updated in layout, after commit and before a passive effect. A press queued
  // on this commit then reads it. A discarded render never runs the effect.
  const tileHandlerState = useRef({
    browserQuery,
    onOpen,
    onOpenImport,
    onRepair,
    selectionMode,
    toggleSelection,
    gridItems,
    entriesByImageId,
    resolvedSources,
    isResolverOwned,
    fastPathUriFor,
  });
  useLayoutEffect(() => {
    tileHandlerState.current = {
      browserQuery,
      onOpen,
      onOpenImport,
      onRepair,
      selectionMode,
      toggleSelection,
      gridItems,
      entriesByImageId,
      resolvedSources,
      isResolverOwned,
      fastPathUriFor,
    };
  }, [
    browserQuery,
    onOpen,
    onOpenImport,
    onRepair,
    selectionMode,
    toggleSelection,
    gridItems,
    entriesByImageId,
    resolvedSources,
    isResolverOwned,
    fastPathUriFor,
  ]);
  const tileHandlerCache = useRef(new Map<number, {
    onOpen: () => void;
    onLongPress: () => void;
    onToggleSelection: () => void;
    onLocalFileMissing: (observedUri: string) => boolean | void | Promise<boolean | void>;
  }>());
  const tileHandlers = useCallback((imageId: number) => {
    const cached = tileHandlerCache.current.get(imageId);
    if (cached !== undefined) return cached;
    const itemKey = `image:${imageId}` as const;
    const handlers = {
      onOpen: () => {
        const state = tileHandlerState.current;
        const found = state.gridItems.find(
          (candidate): candidate is Extract<CollectionItem, { kind: 'image' }> =>
            candidate.kind === 'image' && candidate.image.id === imageId,
        );
        const entry = state.entriesByImageId.get(imageId);
        const resolved = entry === undefined
          ? undefined
          : state.resolvedSources.get(entry.plaintextSha256);
        const item = found ?? null;
        const owned = item !== null && state.isResolverOwned(item);
        const fastPathUri = item !== null && owned ? state.fastPathUriFor(item) : null;
        // What the committed sources say this tile shows. A resolver-owned
        // thumbnail file; every other open clears that id.
        setDetailOpenSeed(
          imageId,
          owned
            && fastPathUri === null
            && resolved?.kind === 'file'
            && resolved.role === 'thumbnail'
            ? resolved.uri
            : null,
        );
        state.onOpen(imageId, state.browserQuery);
      },
      onLongPress: () => {
        const { selectionMode: selecting, toggleSelection: toggle } = tileHandlerState.current;
        if (!selecting) toggle(itemKey);
      },
      onToggleSelection: () => tileHandlerState.current.toggleSelection(itemKey),
      onLocalFileMissing: (observedUri: string) => (
        tileHandlerState.current.onRepair(imageId, observedUri)
      ),
    };
    tileHandlerCache.current.set(imageId, handlers);
    return handlers;
  }, []);

  const libraryTileHandlerCache = useRef(new Map<string, {
    onOpen: () => void;
    onLongPress: () => void;
    onToggleSelection: () => void;
  }>());
  const libraryTileHandlers = useCallback((itemKey: string, digest: string) => {
    const cached = libraryTileHandlerCache.current.get(itemKey);
    if (cached !== undefined) return cached;
    const handlers = {
      onOpen: () => {
        const state = tileHandlerState.current;
        const found = state.gridItems.find(
          (candidate) => candidate.kind !== 'image'
            && candidate.entry.plaintextSha256 === digest,
        );
        const resolved = state.resolvedSources.get(digest);
        const fastPathUri = found !== undefined ? state.fastPathUriFor(found) : null;
        setDetailOpenSeed(
          digest,
          fastPathUri === null
            && resolved?.kind === 'file'
            && resolved.role === 'thumbnail'
            ? resolved.uri
            : null,
        );
        state.onOpenImport?.(digest, state.browserQuery);
      },
      onLongPress: () => {
        const { selectionMode: selecting, toggleSelection: toggle } = tileHandlerState.current;
        if (!selecting) toggle(itemKey);
      },
      onToggleSelection: () => tileHandlerState.current.toggleSelection(itemKey),
    };
    libraryTileHandlerCache.current.set(itemKey, handlers);
    return handlers;
  }, []);

  const confirmDelete = useCallback(() => {
    const selectedItems = sortedAllItems.filter((item) => selectedKeys.has(item.key));
    const imageIds: number[] = [];
    const importDigests: string[] = [];
    for (const item of selectedItems) {
      if (item.kind === 'image') {
        imageIds.push(item.image.id);
      } else {
        importDigests.push(item.entry.plaintextSha256);
      }
    }
    const totalCount = imageIds.length + importDigests.length;
    if (totalCount === 0 || deleting) return;
    Alert.alert(
      t('collection.deleteSelectedTitle', { count: totalCount }),
      t('collection.deleteSelectedMessage'),
      [
        { text: t('collection.cancel'), style: 'cancel' },
        {
          text: t('collection.delete'),
          style: 'destructive',
          onPress: () => {
            setDeleting(true);
            setOperationError(null);
            const tasks: Promise<unknown>[] = [];
            if (imageIds.length > 0) {
              tasks.push(onDelete(imageIds));
            }
            if (importDigests.length > 0 && onDeleteImports !== undefined) {
              tasks.push(onDeleteImports(importDigests));
            }
            void Promise.allSettled(tasks)
              .then((results) => {
                const rejected = results.find(
                  (result): result is PromiseRejectedResult =>
                    result.status === 'rejected',
                );
                if (rejected !== undefined) {
                  throw rejected.reason;
                }
                setSelectedKeys(new Set());
              })
              .catch((error: unknown) => {
                setSelectedKeys(new Set());
                setOperationError(userSafeMessageKey(error));
              })
              .finally(() => setDeleting(false));
          },
        },
      ],
    );
  }, [deleting, onDelete, onDeleteImports, selectedKeys, sortedAllItems, t]);

  if (status === 'loading') {
    return (
      <View testID="screen-collection" collapsable={false} style={{ flex: 1, paddingTop: topInset, backgroundColor: theme.surface }}>
        <ScreenState kind="loading" />
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View testID="screen-collection" collapsable={false} style={{ flex: 1, paddingTop: topInset, backgroundColor: theme.surface }}>
        <ScreenState
          kind="error"
          message={errorMessage ?? t('collection.loadError')}
          onRetry={onRefresh}
        />
      </View>
    );
  }
  // Rendered in both the populated header and the empty state: trash needs the
  // cloud library's actions (the local core has a view too). A user who
  // soft-deleted every image has an empty grid but their images live in trash,
  // and settings no longer carries a trash entry. Positioned top-right so it
  // never blocks the empty CTA.
  const importBusy = importSessionState.phase === 'picking'
    || importSessionState.phase === 'awaiting-choice'
    || importSessionState.phase === 'importing';
  const importEntry = importSession ? (
    <Pressable
      testID="collection-import-entry"
      role="button"
      aria-label={t('collection.import.entry')}
      accessibilityState={{ disabled: importBusy, busy: importBusy }}
      disabled={importBusy}
      hitSlop={8}
      onPress={() => {
        void importSession.startPick();
      }}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: importBusy ? 0.38 : pressed ? 0.64 : 1,
      })}>
      <ImagePlus color={theme.save} size={22} />
    </Pressable>
  ) : null;
  const trashEntry = onOpenTrash ? (
    <Pressable
      testID="collection-trash-entry"
      role="button"
      aria-label={t('libraryTrash.entryRow')}
      hitSlop={8}
      onPress={onOpenTrash}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.64 : 1,
      })}>
      <Trash2 color={theme.textSecondary} size={22} />
    </Pressable>
  ) : null;

  const importSheet = importSession ? (
    <CollectionImportChoiceSheet
      visible={importSessionState.phase === 'awaiting-choice'}
      count={importSessionState.phase === 'awaiting-choice'
        ? importSessionState.count
        : 0}
      onSelectClassification={(classification) => {
        void importSession.confirmChoice(classification);
      }}
      onCancel={() => {
        void importSession.cancelChoice();
      }}
    />
  ) : null;

  const importFeedback = (() => {
    if (importSessionState.phase === 'importing') {
      return (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: metrics.spacing.medium,
            right: metrics.spacing.medium,
            bottom: tabBarContentInset(insets.bottom) + metrics.spacing.small,
            alignItems: 'center',
          }}>
          <View
            testID="collection-import-progress"
            accessibilityLiveRegion="polite"
            style={{
              maxWidth: 440,
              paddingHorizontal: metrics.spacing.medium,
              paddingVertical: 10,
              borderRadius: metrics.radius.medium,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surfaceSecondary,
            }}>
            <Text
              style={{
                color: theme.text,
                fontSize: 14,
                fontWeight: '600',
                fontVariant: ['tabular-nums'],
                textAlign: 'center',
              }}>
              {t('collection.import.progress', {
                completed: importSessionState.completed,
                total: importSessionState.total,
              })}
            </Text>
          </View>
        </View>
      );
    }
    if (importSessionState.phase === 'result') {
      const { primary, notes } = formatImportResultLines(importSessionState.result, t);
      return (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: metrics.spacing.medium,
            right: metrics.spacing.medium,
            bottom: tabBarContentInset(insets.bottom) + metrics.spacing.small,
            alignItems: 'center',
          }}>
          <View
            testID="collection-import-result"
            accessibilityLiveRegion="polite"
            style={{
              maxWidth: 440,
              paddingHorizontal: metrics.spacing.medium,
              paddingVertical: 10,
              borderRadius: metrics.radius.medium,
              borderWidth: 1,
              borderColor: theme.border,
              backgroundColor: theme.surfaceSecondary,
              gap: 4,
            }}>
            {primary ? (
              <Text
                style={{
                  color: theme.text,
                  fontSize: 14,
                  fontWeight: '600',
                  fontVariant: ['tabular-nums'],
                  textAlign: 'center',
                }}>
                {primary}
              </Text>
            ) : null}
            {notes.map((note) => (
              <Text
                key={note}
                style={{
                  color: theme.textSecondary,
                  fontSize: 13,
                  lineHeight: 18,
                  textAlign: 'center',
                }}>
                {note}
              </Text>
            ))}
          </View>
        </View>
      );
    }
    return null;
  })();

  if (sortedAllItems.length === 0) {
    return (
      <View testID="screen-collection" collapsable={false} style={{ flex: 1, paddingTop: topInset, backgroundColor: theme.surface }}>
        {importEntry || trashEntry ? (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              paddingHorizontal: metrics.spacing.small,
            }}>
            {importEntry}
            {trashEntry}
          </View>
        ) : null}
        <ScreenState
          kind="empty"
          title={t('collection.emptyTitle')}
          message={t('collection.emptyMessage')}
          command={{ label: t('collection.browse'), onPress: onBrowse }}
        />
        {importFeedback}
        {importSheet}
      </View>
    );
  }

  const visibleCount = gridItems.length;
  const sourceChipName = browserQuery.provider === 'all'
    ? t('collection.sourceAll')
    : browserQuery.provider === 'imports'
      ? t('collection.sourceImports')
      : providerLabel(browserQuery.provider);

  return (
    <View testID="screen-collection" collapsable={false} style={{ flex: 1, paddingTop: topInset, backgroundColor: theme.surface }}>
      <View
        aria-label={t('collection.selectionActionsLabel')}
        style={{
          height: 56,
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: metrics.spacing.small,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        }}>
        {selectionMode ? (
          <>
            <Pressable
              role="button"
              aria-label={t('collection.exitSelection')}
              hitSlop={8}
              onPress={() => setSelectedKeys(new Set())}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.64 : 1,
              })}>
              <X color={theme.text} size={23} />
            </Pressable>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{
                flex: 1,
                color: theme.text,
                fontSize: 16,
                fontWeight: '600',
                fontVariant: ['tabular-nums'],
                textAlign: 'center',
              }}>
              {t('collection.selectedCount', { count: selectedKeys.size })}
            </Text>
            <Pressable
              role="button"
              aria-label={t('collection.deleteSelectedAccessibility')}
              accessibilityState={{ disabled: deleting }}
              disabled={deleting}
              hitSlop={8}
              onPress={confirmDelete}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: deleting ? 0.38 : pressed ? 0.64 : 1,
              })}>
              <Trash2 color={theme.danger} size={22} />
            </Pressable>
          </>
        ) : (
          <>
            <View
              testID={`collection-count-value-${visibleCount}`}
              collapsable={false}
              style={{
                flex: 1,
              }}>
              <Text
                testID="collection-count"
                selectable
                numberOfLines={1}
                style={{
                  flex: 1,
                  paddingHorizontal: metrics.spacing.medium,
                  color: theme.textSecondary,
                  fontSize: 14,
                }}>
                {t('collection.imageCount', { count: visibleCount })}
              </Text>
            </View>
            {importEntry}
            {trashEntry}
          </>
        )}
      </View>
      <View
        aria-label={t('collection.filterLabel')}
        style={{
          minHeight: 112,
          justifyContent: 'center',
          paddingHorizontal: metrics.spacing.medium,
          paddingVertical: 8,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        }}>
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{
            minWidth: 0,
            flex: 1,
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 13,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: metrics.radius.medium,
            backgroundColor: theme.surfaceSecondary,
          }}>
            <Search color={theme.textSecondary} size={19} />
            <TextInput
              testID="collection-search"
              aria-label={t('collection.searchAccessibility')}
              placeholder={t('collection.searchPlaceholder')}
              placeholderTextColor={theme.textSecondary}
              value={browserQuery.text}
              onChangeText={(text) => updateBrowserQuery({ text, field: 'all' })}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              editable={!selectionMode}
              style={{
                minWidth: 0,
                flex: 1,
                minHeight: 48,
                paddingHorizontal: 10,
                color: theme.text,
                fontSize: 16,
              }}
            />
            {browserQuery.text ? (
              <Pressable
                role="button"
                aria-label={t('collection.clearSearch')}
                onPress={() => updateBrowserQuery({ text: '', field: 'all' })}
                style={({ pressed }) => ({
                  width: 48,
                  height: 48,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.62 : 1,
                })}>
                <X color={theme.textSecondary} size={18} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            role="button"
            aria-label={t('collection.sortAccessibility', {
              sort: t(`collection.sort.${browserQuery.sort}`),
            })}
            accessibilityState={{ disabled: selectionMode, selected: browserQuery.sort !== 'newest' }}
            disabled={selectionMode}
            onPress={() => setChoiceSheet('sort')}
            style={({ pressed }) => ({
              width: 48,
              height: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: browserQuery.sort === 'newest' ? theme.border : theme.save,
              borderRadius: metrics.radius.medium,
              backgroundColor: browserQuery.sort === 'newest' ? theme.surface : `${theme.save}12`,
              opacity: selectionMode ? 0.38 : pressed ? 0.62 : 1,
            })}>
            <ArrowDownUp color={browserQuery.sort === 'newest' ? theme.text : theme.save} size={21} />
          </Pressable>
        </View>
        {/*
          * R8.27 spec §4: one chip row directly above the grid — the rating
          * chips first, the source chip last. `role=button` may not sit inside
          * a `role=radiogroup`, so the radio group renders without its own
          * scroller (`scrollable={false}`) and this row owns the scrolling for
          * both. The Store variant drops the rating chips and keeps the source
          * chip.
          */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            alignItems: 'center',
            gap: metrics.spacing.small,
          }}
          style={{ minHeight: metrics.minimumHitArea, flexGrow: 0 }}>
          {allowsAdultContent ? (
            <SegmentedControl
              testID="collection-adult-content-mode"
              accessibilityLabel={t('collection.modeAccessibility')}
              enabled={!selectionMode}
              scrollable={false}
              values={[
                t('collection.modeMixed'),
                t('collection.modeSfw'),
                t('collection.modeNsfw'),
              ]}
              counts={[modeCounts.mixed, modeCounts.sfw, modeCounts.nsfw]}
              badges={[null, null, '18+']}
              selectedIndex={COLLECTION_MODES.indexOf(browserQuery.mode)}
              onChange={(event) => {
                const next = COLLECTION_MODES[event.nativeEvent.selectedSegmentIndex];
                if (!next) return;
                updateBrowserQuery({ mode: next });
              }}
            />
          ) : null}
          <Pressable
            role="button"
            aria-label={t('collection.sourceChip', {
              name: sourceChipName,
            })}
            accessibilityState={{ disabled: selectionMode, selected: browserQuery.provider !== 'all' }}
            disabled={selectionMode}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => setChoiceSheet('provider')}
            style={({ pressed }) => ({
              // R8.27 spec §4: the source chip closes the same chip row as the
              // rating chips. Spec §2 only asks for the first three chips to be
              // fully visible at 360dp, so this one may sit past the fold and
              // be reached by scrolling — it needs no width cap and must keep
              // its intrinsic width inside the scroller.
              minHeight: 36,
              flexShrink: 0,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              paddingLeft: 14,
              paddingRight: 10,
              gap: 4,
              borderWidth: 1,
              borderColor: browserQuery.provider === 'all' ? theme.border : theme.text,
              borderRadius: metrics.radius.circle,
              backgroundColor: browserQuery.provider === 'all' ? theme.surface : theme.text,
              opacity: selectionMode ? 0.38 : pressed ? 0.7 : 1,
            })}>
            <Text
              numberOfLines={1}
              style={{
                flexShrink: 1,
                color: browserQuery.provider === 'all' ? theme.text : theme.surface,
                fontSize: 14,
                fontWeight: browserQuery.provider === 'all' ? '500' : '600',
              }}>
              {t('collection.sourceChip', {
                name: sourceChipName,
              })}
            </Text>
            <ChevronDown
              color={browserQuery.provider === 'all' ? theme.textSecondary : theme.surface}
              size={14}
            />
          </Pressable>
        </ScrollView>
      </View>
      {operationError ? (
        <Text
          selectable
          accessibilityLiveRegion="polite"
          style={{
            paddingHorizontal: metrics.spacing.medium,
            paddingVertical: metrics.spacing.small,
            color: theme.danger,
            fontSize: 14,
          }}>
          {t(operationError)}
        </Text>
      ) : null}
      {gridItems.length === 0 ? (
        <View style={{ flex: 1 }}>
          <ScreenState
            kind="empty"
            title={hasBrowserFilter
              ? t('collection.emptySearchTitle')
              : browserQuery.mode === 'sfw'
                ? t('collection.emptySfwTitle')
                : t('collection.emptyNsfwTitle')}
            message={hasBrowserFilter
              ? t('collection.emptySearchMessage')
              : t('collection.emptyFilteredMessage')}
            command={hasBrowserFilter ? {
              label: t('collection.clearFilters'),
              onPress: () => updateBrowserQuery({ text: '', field: 'all', provider: 'all' }),
            } : undefined}
          />
        </View>
      ) : (
        <FlashList
          contentContainerStyle={{ paddingBottom: tabBarContentInset(insets.bottom) }}
          testID="collection-list"
          key={`collection-${columns}`}
          aria-label={t('collection.gridLabel')}
          data={gridItems as CollectionItem[]}
          numColumns={columns}
          keyExtractor={(item) => item.key}
          extraData={gridExtraData}
          contentInsetAdjustmentBehavior="automatic"
          refreshing={refreshing}
          onRefresh={onRefresh}
          onViewableItemsChanged={onViewableItemsChanged}
          renderItem={({ item, index }) => {
            if (item.kind !== 'image') {
              const fastPathUri = fastPathUriFor(item);
              const resolved = resolvedSources.get(item.entry.plaintextSha256) ?? null;
              const libHandlers = libraryTileHandlers(item.key, item.entry.plaintextSha256);
              return (
                <View style={{ flex: 1, padding: 1 }}>
                  <LibraryAssetTile
                    entry={item.entry}
                    index={index + 1}
                    source={resolved}
                    fastPathUri={fastPathUri}
                    onFastPathFailed={fastPathUri !== null
                      ? fastPathHandlerFor(item.entry.plaintextSha256)
                      : undefined}
                    libraryAccess={libraryOverlay?.access ?? 'ready'}
                    blurNsfwThumbnail={blurVisibleNsfw}
                    selected={selectedKeys.has(item.key)}
                    selectionMode={selectionMode}
                    onOpen={libHandlers.onOpen}
                    onLongPress={libHandlers.onLongPress}
                    onToggleSelection={libHandlers.onToggleSelection}
                  />
                </View>
              );
            }
            const entry = entriesByImageId.get(item.image.id) ?? null;
            const resolved = entry === null
              ? undefined
              : resolvedSources.get(entry.plaintextSha256);
            // K2: use the library resolver whenever the collection holds no
            // file for this row (mirrored rows). A row with its own ready
            // collection file keeps the local-first path.
            const resolverOwned = isResolverOwned(item);
            // Board #27 (spec §5.7): a resolver-owned row whose entry holds the
            // local original renders it with no resolve, until it fails once.
            const fastPathUri = resolverOwned ? fastPathUriFor(item) : null;
            const overrideSourceUri = fastPathUri
              ?? (resolverOwned && resolved?.kind === 'file' ? resolved.uri : null);
            const overrideSourceRole = fastPathUri !== null
              ? 'original'
              : overrideSourceUri !== null && resolved?.kind === 'file'
                ? resolved.role
                : null;
            // Board #9 (spec §5.1): any file-less row may be library-owned
            // before its entry has even been read (mirrored, or a failed row
            // whose collection file went missing); while the first read or the
            // resolve is in flight the tile keeps its colour block and issues
            // no load.
            const awaitingEntries = libraryOverlay !== null
              && libraryOverlay.entriesPending === true
              && entry === null
              && item.image.localUri === null;
            const overridePending = awaitingEntries
              || (resolverOwned && fastPathUri === null && resolved === undefined);
            // K3 G3: judge the ORIGINAL, not the rendered thumbnail tier. Row 34
            // trusts `hasLocalOriginal` after a fast-path failure until its resolve
            // settles to a non-local-original tier, unavailable, or rejection.
            const hasLocalOriginal = entry !== null
              && entry.hasLocalOriginal
              && (!fastPathFailed.has(entry.plaintextSha256)
                || resolved === undefined
                || (resolved?.kind === 'file' && resolved.tier === 'local-original'));
            const libraryUnavailable = entry !== null
              && item.image.downloadState === 'mirrored'
              && isOriginalUnrecoverable({
                hasLocalOriginal,
                originalGenerationId: entry.originalGenerationId,
                resolved,
              });
            const onlyInCloud = entry !== null
              && item.image.downloadState === 'mirrored'
              && isOnlyInCloud({
                hasLocalOriginal,
                originalGenerationId: entry.originalGenerationId,
                resolved,
              });
            const synced = entry !== null && isSyncedToCloud(entry);
            const handlers = tileHandlers(item.image.id);
            return (
              <View style={{ flex: 1, padding: 1 }}>
                <CollectionTile
                  image={item.image}
                  selected={selectedKeys.has(item.key)}
                  selectionMode={selectionMode}
                  blurNsfwThumbnail={blurVisibleNsfw}
                  overrideSourceUri={overrideSourceUri}
                  overrideSourceRole={overrideSourceRole}
                  overridePending={overridePending}
                  onOverrideFailed={fastPathUri !== null && entry !== null
                    ? fastPathHandlerFor(entry.plaintextSha256)
                    : undefined}
                  synced={synced}
                  onlyInCloud={onlyInCloud}
                  libraryDigest={entry?.plaintextSha256 ?? null}
                  libraryOriginalGenerationId={entry?.originalGenerationId ?? null}
                  libraryUnavailable={libraryUnavailable}
                  onOpen={handlers.onOpen}
                  onLongPress={handlers.onLongPress}
                  onToggleSelection={handlers.onToggleSelection}
                  onLocalFileMissing={handlers.onLocalFileMissing}
                />
              </View>
            );
          }}
        />
      )}
      <CollectionChoiceSheet
        visible={choiceSheet === 'provider'}
        title={t('collection.providerFilterTitle')}
        current={browserQuery.provider}
        options={sourceOptions.map((option) => ({
          value: option.provider,
          label: option.provider === 'all'
            ? t('collection.providerAll')
            : option.provider === 'imports'
              ? t('collection.sourceImports')
              : providerLabel(option.provider),
          count: option.count,
        }))}
        onClose={() => setChoiceSheet(null)}
        onSelect={(provider) => {
          updateBrowserQuery({ provider: provider as CollectionProvider });
          setChoiceSheet(null);
        }}
      />
      <CollectionChoiceSheet
        visible={choiceSheet === 'sort'}
        title={t('collection.sortTitle')}
        current={browserQuery.sort}
        options={COLLECTION_SORTS.map((sort) => ({
          value: sort,
          label: t(`collection.sort.${sort}`),
        }))}
        onClose={() => setChoiceSheet(null)}
        onSelect={(sort) => {
          updateBrowserQuery({ sort: sort as CollectionSort });
          setChoiceSheet(null);
        }}
      />
      {importFeedback}
      {importSheet}
    </View>
  );
}

export async function deleteSelectedImports(
  purgeImportedAsset: (plaintextSha256: string) => Promise<unknown>,
  plaintextSha256s: readonly string[],
): Promise<void> {
  const results = await Promise.allSettled(
    plaintextSha256s.map((digest) => purgeImportedAsset(digest)),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

export function CollectionScreen({
  initialQuery,
}: {
  initialQuery?: Partial<CollectionBrowserQuery>;
} = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useAppTranslation();
  const {
    collectionService,
    imageRepository,
    settings,
    dataRevision,
    libraryController,
    libraryActions,
    libraryChanges,
    libraryView,
    byosStatus,
  } = useAppServices();
  const [isResuming, setIsResuming] = useState(false);
  const [libraryEntries, setLibraryEntries] = useState<readonly LibraryEntry[]>(
    [],
  );
  const [entriesPending, setEntriesPending] = useState(true);
  const [handedOver, setHandedOver] = useState<HandedOver | null>(null);
  // Board #27 S1b: while mounted, this screen republishes a handed-over row
  // itself, after the entries read that follows the hand-over.
  useHandedOverPublisher();
  const refreshCollection = useCallback(() => {
    return publishCollectionSnapshot(queryClient, imageRepository);
  }, [imageRepository, queryClient]);
  // K6-2b: one read at a time. A burst of completions (the owner's 「疯狂右滑」
  // case — hundreds of assets settling inside one another's read) becomes one
  // read plus one more afterwards, never a queue of identical queries and
  // never a dropped last event. A flag, not a timer: spec §2 G2 rules out
  // windows and throttles, and the last event must still be honoured.
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
        // K7 ⑦: every read builds fresh row objects, so handing the result
        // straight to setState replaced the array reference even when the
        // library had not moved — recomputing all three useMemos and
        // re-rendering every visible tile. Keep the old reference when the
        // content is identical.
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
            // The follow-up read on the new model publishes these. Dropping
            // them leaves the row `ready` at the collection file the hand-over
            // already deleted.
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
    // The library read: on mount, and when the shared data revision bumps
    // (startup recovery, delete, delete-all, restore). Store clears
    // synchronously via libraryView == null. K7 ⑦ removed the focus read —
    // a tab tap is not a change, and the K6-2b feed below is.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshLibraryEntries();
  }, [dataRevision, refreshLibraryEntries]);
  // K6-2b (spec §2 G3): the tile has to tell the truth about the bucket the
  // moment the upload settles. `dataRevision` never moves for an ingest or a
  // protect, and focus is exactly the thing the owner should not have to do —
  // so the grid listens to the composition's change feed instead.
  useEffect(() => {
    if (libraryChanges == null) return undefined;
    return libraryChanges.subscribe((change) => refreshLibraryEntries(
      change.kind === 'handed-over' ? change.imageId : undefined,
    ));
  }, [libraryChanges, refreshLibraryEntries]);
  useFocusEffect(useCallback(() => {
    return () => {
      libraryController?.importSession?.dismissResultIfPresented();
    };
  }, [libraryController]));
  const resumeOperation = useRef<Promise<void> | null>(null);
  const resumeAndRefresh = useCallback((): Promise<void> => {
    if (resumeOperation.current) return resumeOperation.current;

    setIsResuming(true);
    let operation!: Promise<void>;
    operation = collectionService.resumePendingDownloads()
      .then(() => undefined)
      .catch(() => undefined)
      .then(refreshCollection)
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (resumeOperation.current === operation) {
          resumeOperation.current = null;
          setIsResuming(false);
        }
      });
    resumeOperation.current = operation;
    return operation;
  }, [collectionService, refreshCollection]);
  const collectionQuery = useQuery({
    queryKey: collectionQueryKey(),
    queryFn: () => imageRepository.listCollection(),
    staleTime: Infinity,
  });

  const refresh = useCallback(() => {
    void resumeAndRefresh();
    refreshLibraryEntries();
  }, [refreshLibraryEntries, resumeAndRefresh]);

  // Settled answers stay on screen and are marked stale when this function's
  // identity changes. It follows the library view and its resolver, not a
  // fresh entries array.
  const libraryResolver = libraryView?.resolver ?? null;
  const libraryResolve = useMemo(() => {
    if (libraryView == null || libraryResolver == null) return null;
    return (
      digest: string,
      intent: LibraryRenderIntent,
    ) => libraryResolver.resolve(digest, intent);
  }, [libraryResolver, libraryView]);
  // K7 ⑦: a fresh object literal every render invalidated every useMemo that
  // keys off the overlay, which is all of them.
  const libraryOverlay = useMemo(() => (
    libraryView == null || libraryResolve == null
      ? null
      : {
          entries: libraryEntries,
          entriesPending,
          access: libraryAccessFor(byosStatus),
          resolve: libraryResolve,
        }
  ), [byosStatus, entriesPending, libraryEntries, libraryResolve, libraryView]);

  return (
    <CollectionView
      images={collectionQuery.data ?? []}
      status={collectionQuery.data === undefined && collectionQuery.isPending
        ? 'loading'
        : collectionQuery.data === undefined && collectionQuery.isError ? 'error' : 'ready'}
      errorMessage={collectionQuery.data === undefined && collectionQuery.isError
        ? t('collection.loadError')
        : null}
      blurNsfwThumbnails={settings.blurNsfwThumbnails}
      initialQuery={initialQuery}
      refreshing={isResuming}
      libraryOverlay={libraryOverlay}
      handedOver={handedOver}
      importSession={libraryController?.importSession ?? null}
      onOpenTrash={libraryActions == null ? undefined : () => router.push('/library/trash')}
      onBrowse={() => router.replace('/')}
      onOpen={(imageId, query) => router.push({
        pathname: '/image/[id]',
        params: {
          id: String(imageId),
          mode: query.mode,
          query: query.text || undefined,
          field: query.field,
          provider: query.provider,
          sort: query.sort,
        },
      })}
      onOpenImport={(plaintextSha256, query) => router.push({
        pathname: '/image/import/[sha256]',
        params: {
          sha256: plaintextSha256,
          mode: query.mode,
          query: query.text || undefined,
          field: query.field,
          provider: query.provider,
          sort: query.sort,
        },
      })}
      onRefresh={refresh}
      onDelete={async (imageIds) => {
        try {
          await deleteSelectedImages(collectionService, imageIds);
        } finally {
          await refreshCollection();
        }
      }}
      onDeleteImports={
        libraryController?.purgeImportedAsset
          ? async (digests) => {
              try {
                await deleteSelectedImports(
                  (digest) => libraryController.purgeImportedAsset!(digest),
                  digests,
                );
              } finally {
                refreshLibraryEntries();
              }
            }
          : undefined
      }
      onRepair={async (imageId, observedUri) => {
        try {
          // Board #27 (spec §5.5 rule 3): repairs only while the row still
          // holds the file the tile failed to load; `stale` otherwise, and the
          // re-read below shows the row as it is now.
          const result = await collectionService.repairMissingFile(imageId, observedUri);
          return result.status === 'ready' && !result.reused;
        } catch {
          return false;
        } finally {
          await refreshCollection();
        }
      }}
    />
  );
}
