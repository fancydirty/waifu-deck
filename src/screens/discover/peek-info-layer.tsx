import { ExternalLink } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  interpolate,
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';

import { providerLabel } from '@/features/providers/provider-label';
import type { WaifuImage } from '@/features/waifu/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { metrics } from '@/theme/metrics';
import { fontFamilies } from '@/theme/typography';

function LedgerRow({ label, value }: { label: string; value: string }) {
  const theme = useAppThemeColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: metrics.spacing.small,
        minHeight: 18,
      }}>
      <Text
        numberOfLines={1}
        style={{
          fontSize: 9,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: theme.textSecondary,
          fontFamily: fontFamilies.sansMedium,
        }}>
        {label}
      </Text>
      <View
        aria-hidden
        style={{
          flex: 1,
          borderBottomWidth: 1,
          borderBottomColor: theme.hair,
          borderStyle: 'dotted',
          alignSelf: 'center',
        }}
      />
      <Text
        numberOfLines={1}
        style={{
          fontSize: 11.5,
          color: theme.text,
          fontFamily: fontFamilies.mono,
        }}>
        {value}
      </Text>
    </View>
  );
}

export function PeekInfoLayer({
  card,
  onOpenSource,
  progress,
}: {
  card: WaifuImage;
  onOpenSource?: () => void;
  progress?: SharedValue<number>;
}) {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();

  const revealStyle = useAnimatedStyle(() => {
    if (progress === undefined) {
      return { opacity: 1, transform: [{ translateY: 0 }] };
    }
    return {
      opacity: interpolate(progress.value, [0, 1], [0, 1]),
      transform: [
        { translateY: interpolate(progress.value, [0, 1], [40, 0]) },
      ],
    };
  });

  return (
    <Animated.View
      aria-label={t('discover.metadata')}
      style={[
        {
          position: 'absolute',
          left: 6,
          right: 6,
          bottom: 4,
          // Above the queued next-card layer (1) so the revealed info is
          // readable, below the active card (3) that slides over it.
          zIndex: 2,
          backgroundColor: theme.surfaceSecondary,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 12,
          borderCurve: 'continuous',
          padding: 13,
          gap: 6,
        },
        revealStyle,
      ]}>
      <LedgerRow
        label={providerLabel(card.providerKey)}
        value={card.artistName ?? t('discover.unknownArtist')}
      />
      <LedgerRow label={`#${card.id}`} value={`${card.width} x ${card.height}`} />
      {onOpenSource ? (
        <Pressable
          role="button"
          aria-label={t('discover.viewSource')}
          onPress={onOpenSource}
          style={({ pressed }) => ({
            minHeight: metrics.minimumHitArea,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            opacity: pressed ? 0.72 : 1,
          })}>
          <ExternalLink color={theme.save} size={14} strokeWidth={2.2} />
          <Text
            numberOfLines={1}
            style={{
              fontSize: 11.5,
              fontFamily: fontFamilies.mono,
              color: theme.save,
            }}>
            {t('discover.source')}
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}
