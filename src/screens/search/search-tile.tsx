import { Image } from 'expo-image';
import { EyeOff, Heart } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { useRemoteLoadRetry } from '@/components/use-remote-load-retry';
import { providerImageSource } from '@/features/providers/provider-image-source';
import { providerLabel } from '@/features/providers/provider-label';
import type { SearchHit } from '@/features/search/types';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { metrics } from '@/theme/metrics';

export type SearchTileProps = {
  hit: SearchHit;
  isFavorite: boolean;
  blurNsfwThumbnail: boolean;
  onPress: () => void;
};

export function SearchTile({
  hit,
  isFavorite,
  blurNsfwThumbnail,
  onPress,
}: SearchTileProps) {
  const { t } = useAppTranslation();
  // R8.24: expo-image has no built-in retry, so a single timed-out preview
  // fetch left the tile on its dominant colour forever (owner report: solid
  // Konachan tiles after searching `maid`). The attempt enters the element
  // identity so a bounded backoff actually re-issues the load.
  const { attempt, scheduleRetry } = useRemoteLoadRetry(hit.previewUrl);
  const imageKey = JSON.stringify([hit.key, attempt]);
  const nsfwBlurred = blurNsfwThumbnail && hit.image.isNsfw;
  // A1: Glide never blurs an animated drawable (bitmap transformation only),
  // so a blurred animated hit is covered and its animation held instead. N10
  // (owner ruling 2026-10-13: keep the blur, fix the engine): the blur now runs
  // NoRsBlurTransformation (patches/expo-image*.patch) — wasabeef 4.3.0's
  // RenderScript intrinsic segfaults on Android 16 — and the static blur stays
  // as it always was.
  const coveredAnimated = nsfwBlurred && hit.image.isAnimated;
  const favoriteLabel = t(isFavorite
    ? 'search.tile.saved'
    : 'search.tile.notSaved');
  const safetyLabel = t(hit.image.isNsfw
    ? 'search.tile.sensitive'
    : 'search.tile.standard');

  return (
    <Pressable
      testID={`search-tile-${hit.key}`}
      role="button"
      aria-label={t('search.tile.resultLabel', {
        provider: providerLabel(hit.image.providerKey),
        safety: safetyLabel,
        favorite: favoriteLabel,
      })}
      accessibilityHint={t('search.tile.openGalleryHint')}
      accessibilityState={{ selected: isFavorite }}
      onPress={onPress}
      style={({ pressed }) => ({
        width: '100%',
        aspectRatio: 1,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: hit.image.dominantColor || '#1C1E21',
        opacity: pressed ? 0.72 : 1,
      })}>
      <Image
        key={imageKey}
        accessible={false}
        accessibilityLabel={t('search.tile.thumbnail', { key: hit.key })}
        // R8.28: Gelbooru's preview CDN 302s a Referer-less request to
        // hotlink.php, which is why its hits rendered as solid tiles. A source
        // declaring no headers still gets exactly `{ uri }`.
        source={providerImageSource(hit.previewUrl, hit.image.providerKey)}
        recyclingKey={imageKey}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={0}
        blurRadius={nsfwBlurred ? 24 : 0}
        autoplay={!coveredAnimated}
        onError={scheduleRetry}
        style={{ width: '100%', height: '100%' }}
      />
      {coveredAnimated ? (
        <View
          testID={`search-tile-cover-${hit.key}`}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hit.image.dominantColor || '#1C1E21',
          }}>
          <EyeOff color="#FFFFFF" size={22} />
        </View>
      ) : null}

      <View
        aria-label={favoriteLabel}
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 5,
          right: 5,
          width: 26,
          height: 26,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: metrics.radius.circle,
          backgroundColor: 'rgba(8, 8, 10, 0.72)',
        }}>
        <Heart
          color="#FFFFFF"
          fill={isFavorite ? '#FFFFFF' : 'transparent'}
          size={15}
          strokeWidth={2.2}
        />
      </View>

      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 5,
          bottom: 5,
          maxWidth: '72%',
          paddingHorizontal: 6,
          paddingVertical: 3,
          borderRadius: metrics.radius.small,
          backgroundColor: 'rgba(8, 8, 10, 0.72)',
        }}>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={{ color: '#FFFFFF', fontSize: 10, fontWeight: '700' }}>
          {providerLabel(hit.image.providerKey)}
        </Text>
      </View>
    </Pressable>
  );
}
