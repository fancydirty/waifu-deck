import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Trash2 } from 'lucide-react-native';

import type {
  LibraryActionsController,
} from '@/features/library/library-actions-service';
import type { TrashLibraryEntry } from '@/features/library/library-view-model';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppServices } from '@/providers/app-services';
import { ConfirmModal } from '@/screens/settings/settings-dialogs';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type LibraryTrashScreenProps = {
  listTrashEntries: () => Promise<readonly TrashLibraryEntry[]>;
  restoreFromTrash: LibraryActionsController['restoreFromTrash'];
  permanentlyDeleteFromTrash: LibraryActionsController['permanentlyDeleteFromTrash'];
  emptyLibraryTrash: LibraryActionsController['emptyLibraryTrash'];
  formatDeadline: (ms: number) => string;
};

type PendingConfirm =
  | Readonly<{ kind: 'permanent-delete'; digest: string }>
  | Readonly<{ kind: 'empty-trash' }>
  | null;

function digestLabel(digest: string): string {
  return digest.slice(0, 12);
}

export const TRASH_URGENCY_DAYS = 7;

/** Whole days until purge, floored at zero; drives the deadline chip copy. */
export function trashDeadlineDays(purgeDeadlineAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((purgeDeadlineAt - nowMs) / 86_400_000));
}

/** Urgent rows (< 7 days left) get the amber chip and left edge bar. */
export function isTrashDeadlineUrgent(purgeDeadlineAt: number, nowMs: number): boolean {
  return trashDeadlineDays(purgeDeadlineAt, nowMs) < TRASH_URGENCY_DAYS;
}

export function LibraryTrashScreen({
  listTrashEntries,
  restoreFromTrash,
  permanentlyDeleteFromTrash,
  emptyLibraryTrash,
  formatDeadline,
}: LibraryTrashScreenProps) {
  const { t } = useAppTranslation();
  const colors = useAppThemeColors();
  const [entries, setEntries] = useState<readonly TrashLibraryEntry[]>([]);
  // Captured per refresh: deadline chips only need refresh-level freshness,
  // and render purity forbids Date.now() inside renderItem.
  const [deadlineNow, setDeadlineNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await listTrashEntries());
      setDeadlineNow(Date.now());
    } catch {
      setEntries([]);
    }
  }, [listTrashEntries]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const runAction = useCallback(async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionStatus(null);
    try {
      await action();
      await refresh();
    } catch {
      setActionStatus(t('libraryTrash.actionFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, t]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceSecondary }}>
      {actionStatus ? (
        <Text
          selectable
          accessibilityLiveRegion="polite"
          style={{
            paddingHorizontal: metrics.contentPadding,
            paddingTop: metrics.spacing.medium,
            paddingBottom: metrics.spacing.small,
            color: colors.danger,
            fontSize: 14,
          }}
        >
          {actionStatus}
        </Text>
      ) : null}
      {entries.length > 0 ? (
        <Pressable
          role="button"
          aria-label={t('libraryTrash.emptyTrash')}
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          onPress={() => setConfirm({ kind: 'empty-trash' })}
          style={({ pressed }) => ({
            minHeight: metrics.minimumHitArea,
            marginHorizontal: metrics.contentPadding,
            marginTop: metrics.spacing.medium,
            marginBottom: metrics.spacing.small,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: metrics.radius.medium,
            borderWidth: 1,
            borderColor: colors.danger,
            opacity: busy ? 0.38 : pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ color: colors.danger, fontSize: 15, fontWeight: '600' }}>
            {t('libraryTrash.emptyTrash')}
          </Text>
        </Pressable>
      ) : null}

      <FlatList
        data={[...entries]}
        keyExtractor={(item) => item.plaintextSha256}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: metrics.contentPadding,
          paddingBottom: metrics.spacing.large,
          gap: metrics.spacing.small,
        }}
        ListEmptyComponent={(
          <View
            style={{
              flex: 1,
              minHeight: metrics.stateMinHeight,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: colors.textSecondary, fontSize: 16 }}
            >
              {t('libraryTrash.empty')}
            </Text>
          </View>
        )}
        renderItem={({ item }) => {
          const urgent = isTrashDeadlineUrgent(item.purgeDeadlineAt, deadlineNow);
          const days = trashDeadlineDays(item.purgeDeadlineAt, deadlineNow);
          return (
            <View
              testID={`trash-row-${item.plaintextSha256}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: metrics.spacing.medium,
                paddingVertical: metrics.spacing.medium,
                paddingLeft: urgent ? metrics.spacing.small : 0,
                borderBottomWidth: 1,
                borderBottomColor: colors.hair,
                borderLeftWidth: urgent ? 3 : 0,
                borderLeftColor: colors.warning,
                backgroundColor: urgent ? `${colors.warning}10` : 'transparent',
              }}
            >
              <View
                aria-hidden
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: metrics.radius.medium,
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Trash2 color={colors.textSecondary} size={20} strokeWidth={1.8} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text
                  selectable
                  numberOfLines={1}
                  style={{
                    color: colors.text,
                    fontSize: 13,
                    fontWeight: '700',
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {digestLabel(item.plaintextSha256)}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ color: colors.textSecondary, fontSize: 12 }}
                >
                  {t('libraryTrash.deadline', {
                    date: formatDeadline(item.purgeDeadlineAt),
                  })}
                </Text>
                <View style={{ flexDirection: 'row', gap: metrics.spacing.small, marginTop: 4 }}>
                  <Pressable
                    role="button"
                    aria-label={t('libraryTrash.restore')}
                    disabled={busy}
                    accessibilityState={{ disabled: busy }}
                    onPress={() => {
                      void runAction(async () => {
                        await restoreFromTrash(item.plaintextSha256);
                      });
                    }}
                    style={({ pressed }) => ({
                      minHeight: metrics.minimumHitArea,
                      paddingHorizontal: 16,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: metrics.radius.medium,
                      backgroundColor: colors.saveSoft,
                      opacity: busy ? 0.38 : pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ color: colors.save, fontSize: 13, fontWeight: '700' }}>
                      {t('libraryTrash.restore')}
                    </Text>
                  </Pressable>
                  <Pressable
                    role="button"
                    aria-label={t('libraryTrash.deletePermanently')}
                    disabled={busy}
                    accessibilityState={{ disabled: busy }}
                    onPress={() => setConfirm({
                      kind: 'permanent-delete',
                      digest: item.plaintextSha256,
                    })}
                    style={({ pressed }) => ({
                      minHeight: metrics.minimumHitArea,
                      paddingHorizontal: 16,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: metrics.radius.medium,
                      borderWidth: 1.5,
                      borderColor: colors.danger,
                      opacity: busy ? 0.38 : pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
                      {t('libraryTrash.deletePermanently')}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <View
                testID={`trash-days-${item.plaintextSha256}`}
                style={{
                  minWidth: 44,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: metrics.radius.medium,
                  backgroundColor: urgent ? `${colors.warning}26` : colors.saveSoft,
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    color: urgent ? colors.warning : colors.save,
                    fontSize: 12,
                    fontWeight: '800',
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {days}
                </Text>
              </View>
            </View>
          );
        }}
      />

      <ConfirmModal
        visible={confirm?.kind === 'permanent-delete'}
        title={t('libraryTrash.deletePermanentlyConfirmTitle')}
        message={t('libraryTrash.deletePermanentlyConfirmMessage')}
        confirmLabel={t('libraryTrash.deletePermanentlyConfirmAction')}
        cancelLabel={t('libraryTrash.cancel')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const digest = confirm?.kind === 'permanent-delete'
            ? confirm.digest
            : null;
          setConfirm(null);
          if (digest === null) return;
          void runAction(async () => {
            await permanentlyDeleteFromTrash(digest);
          });
        }}
      />

      <ConfirmModal
        visible={confirm?.kind === 'empty-trash'}
        title={t('libraryTrash.emptyTrashConfirmTitle')}
        message={t('libraryTrash.emptyTrashConfirmMessage')}
        confirmLabel={t('libraryTrash.emptyTrashConfirmAction')}
        cancelLabel={t('libraryTrash.cancel')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null);
          void runAction(async () => {
            await emptyLibraryTrash();
          });
        }}
      />
    </View>
  );
}

function formatTrashDeadline(ms: number, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Direct container. Store builds leave libraryActions null —
 * render an inert empty state and do not navigate here (settings entry is
 * Direct-only via the cloud slot).
 */
export function LibraryTrashScreenContainer() {
  const { t, i18n } = useAppTranslation();
  const {
    libraryActions,
    libraryView,
  } = useAppServices();
  const colors = useAppThemeColors();

  if (
    libraryActions === null
    || libraryView === null
  ) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.surfaceSecondary,
          padding: metrics.contentPadding,
        }}
      >
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: colors.textSecondary, fontSize: 16 }}
        >
          {t('libraryTrash.empty')}
        </Text>
      </View>
    );
  }

  return (
    <LibraryTrashScreen
      listTrashEntries={() => libraryView.model.listTrashEntries()}
      restoreFromTrash={(digest) => libraryActions.restoreFromTrash(digest)}
      permanentlyDeleteFromTrash={(digest) => (
        libraryActions.permanentlyDeleteFromTrash(digest)
      )}
      emptyLibraryTrash={() => libraryActions.emptyLibraryTrash()}
      formatDeadline={(ms) => formatTrashDeadline(ms, i18n.language)}
    />
  );
}
