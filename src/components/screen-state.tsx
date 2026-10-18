import {
  ActivityIndicator,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';

export type ScreenStateKind = 'loading' | 'empty' | 'offline' | 'error' | 'exhausted';

const DEFAULT_COPY_KEYS: Record<ScreenStateKind, { title: string; message: string }> = {
  loading: { title: 'state.loadingTitle', message: 'state.loadingMessage' },
  empty: { title: 'state.emptyTitle', message: 'state.emptyMessage' },
  offline: { title: 'state.offlineTitle', message: 'state.offlineMessage' },
  error: { title: 'state.errorTitle', message: 'state.errorMessage' },
  exhausted: { title: 'state.exhaustedTitle', message: 'state.exhaustedMessage' },
};

export type ScreenStateProps = {
  kind: ScreenStateKind;
  compact?: boolean;
  fontScale?: number;
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  command?: { label: string; onPress: () => void; destructive?: boolean };
};

export function ScreenState({
  kind,
  compact = false,
  fontScale: fontScaleOverride,
  title,
  message,
  onRetry,
  retryLabel,
  command,
}: ScreenStateProps) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const { fontScale: windowFontScale } = useWindowDimensions();
  const fontScale = fontScaleOverride ?? windowFontScale;
  const largeCompactText = compact && fontScale >= 1.5;
  const resolvedTitle = title ?? t(DEFAULT_COPY_KEYS[kind].title);
  const resolvedMessage = message ?? t(DEFAULT_COPY_KEYS[kind].message);
  const action = command ?? (onRetry
    ? { label: retryLabel ?? t('common.retry'), onPress: onRetry }
    : undefined);

  return (
    <View
      aria-label={`screen-state-${kind}`}
      style={{
        width: compact ? '100%' : undefined,
        height: compact ? '100%' : undefined,
        minHeight: compact ? 0 : metrics.stateMinHeight,
        flex: compact ? undefined : 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: largeCompactText
          ? metrics.spacing.small / 2
          : compact ? metrics.spacing.small : metrics.spacing.medium,
        padding: largeCompactText
          ? metrics.spacing.small
          : compact ? metrics.spacing.medium : metrics.contentPadding,
        backgroundColor: theme.surface,
      }}>
      {kind === 'loading' ? <ActivityIndicator color={theme.textSecondary} /> : null}
      <Text
        selectable
        numberOfLines={compact ? largeCompactText ? 1 : 2 : undefined}
        adjustsFontSizeToFit={compact}
        style={{ color: theme.text, fontSize: compact ? 16 : 18, fontWeight: '600' }}>
        {resolvedTitle}
      </Text>
      <Text
        selectable
        numberOfLines={compact ? 2 : undefined}
        adjustsFontSizeToFit={compact}
        style={{ color: theme.textSecondary, fontSize: 14, textAlign: 'center' }}>
        {resolvedMessage}
      </Text>
      {action ? (
        <Pressable
          role="button"
          aria-label={action.label}
          onPress={action.onPress}
          style={({ pressed }) => ({
            minWidth: 96,
            minHeight: metrics.minimumHitArea,
            alignItems: 'center',
            justifyContent: 'center',
            maxWidth: '100%',
            paddingHorizontal: largeCompactText
              ? metrics.spacing.medium
              : metrics.spacing.large,
            borderRadius: metrics.radius.large,
            backgroundColor: command?.destructive ? 'transparent' : theme.text,
            borderWidth: command?.destructive ? 1.5 : 0,
            borderColor: command?.destructive ? theme.danger : 'transparent',
            opacity: pressed ? 0.7 : 1,
          })}>
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit={compact}
            style={{
              color: command?.destructive ? theme.danger : theme.surface,
              fontSize: 15,
              fontWeight: '600',
            }}>
            {action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
