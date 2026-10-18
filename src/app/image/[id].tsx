import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ScreenState } from '@/components/screen-state';
import { useAppTranslation } from '@/i18n/use-app-translation';
import {
  ImageDetailScreen,
  parseDetailGalleryQuery,
} from '@/screens/image-detail/image-detail-screen';

export default function ImageDetailRoute() {
  const params = useLocalSearchParams<{
    id: string;
    query?: string;
    field?: string;
    mode?: string;
    provider?: string;
    sort?: string;
  }>();
  const router = useRouter();
  const { t } = useAppTranslation();
  const imageId = Number(params.id);
  return (
    // The viewer is black in both themes: the root bar's scheme-following
    // icons would go dark over it in light mode (N8).
    <>
      <StatusBar style="light" />
      <Stack.Screen options={{ headerShown: false }} />
      {Number.isSafeInteger(imageId) && imageId > 0 ? (
        <ImageDetailScreen
          imageId={imageId}
          galleryQuery={parseDetailGalleryQuery(params)}
        />
      ) : (
        <ScreenState
          kind="error"
          title={t('detail.invalidAddressTitle')}
          message={t('detail.invalidAddressMessage')}
          command={{
            label: t('detail.backToCollection'),
            onPress: () => router.dismissTo('/collection'),
          }}
        />
      )}
    </>
  );
}
