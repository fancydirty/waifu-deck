import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ScrollView,
  Text,
  View,
} from 'react-native';
import type {
  BackupSummary,
  RestoreSummary,
} from '@/features/backup/backup-service';
import { APP_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import type { LibraryChangeKind } from '@/features/library/library-change-feed';
import { PROVIDER_REGISTRY } from '@/features/providers/provider-registry';
import { useOptionalAppUpdateSnapshot } from '@/features/update/app-update-context';
import type {
  AppSettings,
  LanguagePreference,
  NsfwMode,
} from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useAppServices,
  type UpdateAppSettings,
} from '@/providers/app-services';
import { formatBytes } from '@/screens/settings/format-bytes';
import { PersistedSwitch } from '@/screens/settings/setting-row';
import {
  ChoiceModal,
  ConfirmModal,
  type SettingsChoiceKind,
} from '@/screens/settings/settings-dialogs';
import { TagPickerSheet } from '@/screens/settings/tag-picker-sheet';
import { CloudLibraryCard } from '@/screens/settings/cloud-library-card';
import { useCloudLibraryModel } from '@/screens/settings/cloud-library-context';
import { SectionHeading } from '@/screens/settings/section-heading';
import { formatDiscoverSummary } from '@/screens/settings/discover-summary';
import { StoragePanel } from '@/screens/settings/storage-panel';
import { SettingsBlock } from '@/screens/settings/ui/settings-block';
import { SettingsGroup } from '@/screens/settings/ui/settings-group';
import { SettingsRow } from '@/screens/settings/ui/settings-row';
import SettingsSegmentedControl from '@/screens/settings/ui/settings-segmented-control';
import { settingsTypography } from '@/theme/typography';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { tabBarContentInset } from '@/theme/tab-bar-geometry';
export { CredentialProviderRow } from './credential-provider-row';
export { CREDENTIALED_PROVIDERS, CREDENTIAL_HOSTS, providerHealthDetail } from './provider-settings';

const NSFW_VALUES: NsfwMode[] = ['sfw', 'mixed', 'nsfw'];
/**
 * Board #27 F1 (spec §5.15): the library changes that move this phone's bytes
 * (`files/collection` + `files/library`, what 收藏占用 counts). `freed` is left
 * out: only the eviction emits it, inside a round whose `round-complete`
 * follows. Uploads keep the phone's copy, and `restored` is an intent whose
 * download reports `downloaded`.
 */
const COLLECTION_BYTES_CHANGE_KINDS: ReadonlySet<LibraryChangeKind> = new Set<LibraryChangeKind>([
  'round-complete', 'downloaded', 'purged', 'handed-over', 'ingested', 'trashed', 'original-missing',
]);
const COLLECTION_BYTES_KEY = ['settings', 'storage', 'collection'] as const;

/** A size that could not be read shows as unavailable (as the old `allSettled` did). */
async function bytesOrUnavailable(read: () => Promise<number>): Promise<number | 'unavailable'> {
  try {
    return await read();
  } catch {
    return 'unavailable';
  }
}

export type SettingsViewProps = {
  settings: AppSettings;
  previewCacheBytes: number | null | 'unavailable';
  collectionBytes: number | null | 'unavailable';
  appVersion: string;
  allowsAdultContent?: boolean;
  updateSettings: UpdateAppSettings;
  clearPreviewCache(): Promise<void>;
  createFullBackup(): Promise<BackupSummary>;
  restoreFullBackup(): Promise<RestoreSummary | null>;
  /**
   * R8.21: device top inset. The four tabs are headerless (R8.17), so each
   * surface clears the status bar/cutout itself. Defaults to the live inset;
   * overridable for tests.
   */
  safeAreaTop?: number;
};

export function SettingsView({
  settings,
  previewCacheBytes,
  collectionBytes,
  appVersion,
  allowsAdultContent = APP_DISTRIBUTION_POLICY.allowsAdultContent,
  updateSettings,
  clearPreviewCache,
  createFullBackup,
  restoreFullBackup,
  safeAreaTop,
}: SettingsViewProps) {
  const theme = useAppThemeColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const topInset = safeAreaTop ?? insets.top;
  const bottomInset = Math.max(insets.bottom, 0);
  const data = useCloudLibraryModel();
  const { service: appUpdateService, snapshot: appUpdateSnapshot } = useOptionalAppUpdateSnapshot();
  const { t } = useAppTranslation();
  const discoverSummary = formatDiscoverSummary(settings, t);
  const [pendingNsfw, setPendingNsfw] = useState<NsfwMode | null>(null);
  const [publishedAdultConfirmation, setPublishedAdultConfirmation] = useState(
    settings.nsfwConfirmed,
  );
  const [hasAdultGrant, setHasAdultGrant] = useState(settings.nsfwConfirmed);
  const [tagPickerVisible, setTagPickerVisible] = useState(false);
  const [choice, setChoice] = useState<SettingsChoiceKind>(null);
  const [restoreVisible, setRestoreVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const languageOptions: { label: string; value: LanguagePreference }[] = [
    { label: t('language.system'), value: 'system' },
    { label: t('language.english'), value: 'en' },
    { label: t('language.simplifiedChinese'), value: 'zh-Hans' },
    { label: t('language.traditionalChinese'), value: 'zh-Hant' },
    { label: t('language.japanese'), value: 'ja' },
  ];
  const languageLabel = languageOptions.find(({ value }) => value === settings.language)?.label;

  if (publishedAdultConfirmation !== settings.nsfwConfirmed) {
    setPublishedAdultConfirmation(settings.nsfwConfirmed);
    setHasAdultGrant(settings.nsfwConfirmed);
  }

  const save = useCallback(async (
    update: Partial<AppSettings> | ((current: AppSettings) => Partial<AppSettings>),
  ) => {
    setNotice(null);
    try {
      await updateSettings((current) => ({
        ...current,
        ...(typeof update === 'function' ? update(current) : update),
      }));
      return true;
    } catch {
      setNotice(t('settings.saveError'));
      return false;
    }
  }, [setNotice, t, updateSettings]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      console.error('[Settings] operation failed', error);
      setNotice(t('settings.operationError'));
    } finally {
      setBusy(false);
    }
  }, [busy, setNotice, t]);

  const selectNsfw = (value: NsfwMode) => {
    if (value !== 'sfw' && !hasAdultGrant) {
      setPendingNsfw(value);
      return;
    }
    void save((current) => ({
      nsfwMode: value,
      nsfwConfirmed: hasAdultGrant ? true : current.nsfwConfirmed,
    }));
  };

  // R8.22 (owner 2026-09-09): exclude-only. Blocking toggles one raw slug in
  // excludedTags; includedTags is no longer user-editable and stays at its
  // internal default (['waifu'] — the base tag waifu.im requires).
  const toggleTag = (slug: string) => {
    if (slug === 'waifu') return;
    void save((current) => {
      const excluded = current.excludedTags.filter((tag) => tag !== slug);
      return {
        excludedTags: current.excludedTags.includes(slug)
          ? excluded
          : [...excluded, slug],
      };
    });
  };

  const openTags = () => {
    setTagPickerVisible(true);
  };

  return (
    <View testID="screen-settings" style={{ flex: 1, backgroundColor: theme.surface }}>
        <ScrollView
          testID="settings-scroll"
          aria-label={t('settings.contentLabel')}
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingTop: topInset, paddingBottom: tabBarContentInset(bottomInset) }}>
        <Text testID="settings-title" style={[settingsTypography.pageTitle, { color: theme.text,
          marginHorizontal: metrics.settingsGutter + 4, marginTop: 18, marginBottom: 14 }]}>
          {t('navigation.settings')}
        </Text>
        <CloudLibraryCard model={data.model} nowMs={data.viewNowMs}
          onPress={() => router.push('/settings/cloud' as Href)} />
        <SectionHeading>{t('navigation.discover')}</SectionHeading>
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
          <SettingsRow testID="settings-sources-entry" label={t('settings.sections.sources')}
            value={t('settings.sources.enabledCount', { enabled: Object.values(settings.providers).filter(Boolean).length,
              total: PROVIDER_REGISTRY.length })} chevron onPress={() => router.push('/settings/sources' as Href)} />
          {allowsAdultContent ? <SettingsBlock title={t('settings.filters.nsfwMode')}>
            <SettingsSegmentedControl testID="settings-adult-content-mode" title={t('settings.filters.nsfwMode')}
              values={[t('settings.filters.sfwOnly'), t('settings.filters.mixed'), t('settings.filters.nsfwOnly')]}
              selectedIndex={NSFW_VALUES.indexOf(settings.nsfwMode)} enabled={!busy}
              onChange={(event) => selectNsfw(NSFW_VALUES[event.nativeEvent.selectedSegmentIndex]!)} />
          </SettingsBlock> : null}
          {allowsAdultContent ? <SettingsRow testID="settings-blur-nsfw" label={t('settings.privacy.blurNsfw')}
            trailing={<PersistedSwitch accessibilityLabel={t('settings.privacy.blurNsfw')} disabled={busy}
              value={settings.blurNsfwThumbnails} onValueChange={(value) => save({ blurNsfwThumbnails: value })} />} /> : null}
          <SettingsRow testID="settings-exclude-tags" label={t('settings.filters.excludedTags')} chevron
            value={settings.excludedTags.length === 0 ? t('settings.filters.none') : settings.excludedTags.length === 1
              ? settings.excludedTags[0] : t('settings.filters.excludedSummary', { first: settings.excludedTags[0],
                count: settings.excludedTags.length, rest: settings.excludedTags.length - 1 })}
            accessibilityLabel={t('settings.filters.editExcludedTags')} disabled={busy} onPress={openTags} />
          <SettingsRow testID="settings-discover-entry" label={t('settings.discover.title')} detail={discoverSummary}
            detailNumberOfLines={1} detailEllipsizeMode="tail" chevron
            accessibilityLabel={t('settings.discover.summaryAccessibility',
              { label: t('settings.discover.title'), summary: discoverSummary })}
            onPress={() => router.push('/settings/discover' as Href)} />
        </SettingsGroup>
        <SectionHeading>{t('settings.sections.phone')}</SectionHeading>
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
          <SettingsBlock><StoragePanel collectionBytes={collectionBytes} previewCacheBytes={previewCacheBytes}
            busy={busy} onClear={() => void run(async () => {
              await clearPreviewCache(); setNotice(t('settings.storage.previewCacheCleared'));
            })} /></SettingsBlock>
          <SettingsRow testID="settings-backup-export" label={t('settings.backup.export')}
            detail={t('settings.backup.exportDetail')} disabled={busy} chevron onPress={() => void run(async () => {
              const result = await createFullBackup();
              const missing = result.missingFileCount > 0 ? t('settings.backup.missingFiles', { count: result.missingFileCount }) : '';
              const cloudOnly = result.cloudOnlyCount > 0 ? t('settings.backup.cloudOnly', { count: result.cloudOnlyCount }) : '';
              setNotice(t('settings.backup.exported', { count: result.fileCount,
                size: formatBytes(result.totalFileBytes, t), missing: missing + cloudOnly }));
            })} />
          {allowsAdultContent ? <SettingsRow testID="backup-restore" label={t('settings.backup.restore')}
            detail={t('settings.backup.restoreDetail')} disabled={busy} chevron
            onPress={() => setRestoreVisible(true)} /> : null}
        </SettingsGroup>
        <SectionHeading>{t('settings.sections.general')}</SectionHeading>
        <SettingsGroup style={{ marginHorizontal: metrics.settingsGutter }}>
          <SettingsRow testID="settings-language" label={t('language.label')} value={languageLabel}
            accessibilityLabel={t('language.accessibilityLabel')} disabled={busy} chevron onPress={() => setChoice('language')} />
          <SettingsRow testID="settings-reset-entry" label={t('settings.reset.entry')} disabled={busy} chevron
            onPress={() => router.push('/settings/reset' as Href)} />
        </SettingsGroup>
        <Text
          testID="settings-version"
          onPress={
            appUpdateService
              ? () => {
                  if (appUpdateSnapshot?.offer) {
                    void appUpdateService.openModal().catch(() => {
                      setNotice(t('settings.footer.checkFailed'));
                    });
                    return;
                  }
                  void run(async () => {
                    setNotice(t('settings.footer.checking'));
                    const res = await appUpdateService.checkForUpdatesManual();
                    if (res.status === 'up_to_date') {
                      setNotice(t('settings.footer.upToDate', { version: res.versionName }));
                    } else if (res.status === 'failed') {
                      setNotice(t('settings.footer.checkFailed'));
                    } else {
                      setNotice(null);
                    }
                  });
                }
              : undefined
          }
          style={[settingsTypography.footer, {
            color: appUpdateSnapshot?.offer ? theme.save : theme.textSecondary,
            textAlign: 'center',
            marginTop: 22,
            marginBottom: 4,
          }]}>
          {appUpdateSnapshot?.offer
            ? `${t('settings.footer.version')} · ${appVersion} · ${t('settings.footer.updateAvailable', { version: appUpdateSnapshot.offer.release.versionName })}`
            : `${t('settings.footer.version')} · ${appVersion}`}
        </Text>
        </ScrollView>

      {notice ? (
        <Text
          testID="settings-notice"
          selectable
          accessibilityLiveRegion="polite"
          style={{ padding: metrics.spacing.medium, marginBottom: tabBarContentInset(bottomInset),
            color: theme.text, backgroundColor: theme.surfaceSecondary, borderTopWidth: 1, borderTopColor: theme.hair }}>
          {notice}
        </Text>
      ) : null}

      <TagPickerSheet
        visible={tagPickerVisible}
        disabled={busy}
        excludedTags={settings.excludedTags}
        onToggle={toggleTag}
        onClose={() => setTagPickerVisible(false)}
      />
      <ChoiceModal
        visible={choice === 'language'}
        title={t('language.label')}
        options={languageOptions}
        selectedValue={settings.language}
        onClose={() => setChoice(null)}
        onSelect={(value) => {
          setChoice(null);
          void save({ language: value as LanguagePreference });
        }}
      />
      <ConfirmModal
        visible={allowsAdultContent && pendingNsfw !== null}
        title={t('settings.adult.title')}
        message={t('settings.adult.message')}
        confirmLabel={t('settings.adult.confirm')}
        cancelLabel={t('settings.adult.cancel')}
        onCancel={() => setPendingNsfw(null)}
        onConfirm={() => {
          const mode = pendingNsfw;
          setPendingNsfw(null);
          if (mode) {
            setHasAdultGrant(true);
            void save({ nsfwMode: mode, nsfwConfirmed: true }).then((saved) => {
              if (!saved) setHasAdultGrant(false);
            });
          }
        }}
      />
      <ConfirmModal
        visible={allowsAdultContent && restoreVisible}
        title={t('settings.backup.restoreTitle')}
        message={t('settings.backup.restoreMessage')}
        confirmLabel={t('settings.backup.restoreConfirm')}
        onCancel={() => setRestoreVisible(false)}
        onConfirm={() => {
          setRestoreVisible(false);
          void run(async () => {
            const result = await restoreFullBackup();
            if (result !== null) {
              const removed = (result.removedAdultImageCount ?? 0) > 0
                ? t('settings.backup.removedAdult', {
                  count: result.removedAdultImageCount,
                })
                : '';
              setNotice(t('settings.backup.restored', {
                count: result.restoredFileCount,
                removed,
              }));
            }
          });
        }}
      />
    </View>
  );
}

export function SettingsScreen() {
  const {
    settings,
    dataRevision,
    updateSettings,
    managedPreviewCache,
    collectionService,
    createFullBackup,
    restoreFullBackup,
    libraryChanges,
  } = useAppServices();
  const queryClient = useQueryClient();
  const previewStorage = useQuery({
    queryKey: ['settings', 'storage', 'preview', dataRevision],
    queryFn: () => bytesOrUnavailable(() => managedPreviewCache.getBytes()),
  });
  const collectionStorage = useQuery({
    queryKey: [...COLLECTION_BYTES_KEY, dataRevision],
    queryFn: () => bytesOrUnavailable(() => collectionService.getCollectionBytes()),
  });
  // Board #27 F1 (spec §5.15): 收藏占用 follows the library. `dataRevision`
  // never moves for an eviction, a download, a hand-over or a 收藏 delete, so
  // the screen listens to the change feed — only while focused: a mounted, unfocused
  // Settings tab only marks the row stale and reads once when it is focused again.
  // One read at a time; changes during a read cost exactly one more read after it.
  // A read someone else started (mount, or any `dataRevision` key's read) is joined,
  // then read once more, since it may predate the change: the join counts every
  // collection-size fetch. No timer, no polling.
  const refetchCollection = collectionStorage.refetch;
  const collectionReadInFlight = useRef(false);
  const collectionReadAgain = useRef(false);
  const settingsFocused = useRef(false);
  const collectionStale = useRef(false);
  const refreshCollectionBytes = useCallback((): void => {
    if (collectionReadInFlight.current) {
      collectionReadAgain.current = true;
      return;
    }
    const read = (): void => {
      collectionReadInFlight.current = true;
      if (queryClient.isFetching({ queryKey: COLLECTION_BYTES_KEY }) > 0) {
        collectionReadAgain.current = true;
      }
      void refetchCollection({ cancelRefetch: false })
        .catch(() => undefined)
        .finally(() => {
          collectionReadInFlight.current = false;
          if (!collectionReadAgain.current) return;
          collectionReadAgain.current = false;
          read();
        });
    };
    read();
  }, [queryClient, refetchCollection]);
  useFocusEffect(useCallback(() => {
    settingsFocused.current = true;
    if (collectionStale.current) {
      collectionStale.current = false;
      refreshCollectionBytes();
    }
    return () => {
      settingsFocused.current = false;
    };
  }, [refreshCollectionBytes]));
  useEffect(() => {
    if (libraryChanges == null) return undefined;
    return libraryChanges.subscribe((change) => {
      if (!COLLECTION_BYTES_CHANGE_KINDS.has(change.kind)) return;
      if (settingsFocused.current) refreshCollectionBytes();
      else collectionStale.current = true;
    });
  }, [libraryChanges, refreshCollectionBytes]);

  return (
    <SettingsView
      settings={settings}
      previewCacheBytes={previewStorage.data ?? null}
      collectionBytes={collectionStorage.data ?? null}
      appVersion={Constants.expoConfig?.version ?? '1.0.0'}
      updateSettings={updateSettings}
      clearPreviewCache={async () => {
        await managedPreviewCache.clear();
        await previewStorage.refetch();
      }}
      createFullBackup={createFullBackup}
      restoreFullBackup={restoreFullBackup}
    />
  );
}
