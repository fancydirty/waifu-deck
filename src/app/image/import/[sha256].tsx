import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { ScreenState } from '@/components/screen-state';
import { useAppTranslation } from '@/i18n/use-app-translation';
import {
  ImageDetailScreen,
  isValidImportSha256,
  parseDetailGalleryQuery,
} from '@/screens/image-detail/image-detail-screen';

export default function ImportedImageDetailRoute() {
  const params = useLocalSearchParams<{
    sha256: string;
    query?: string;
    field?: string;
    mode?: string;
    provider?: string;
    sort?: string;
  }>();
  const router = useRouter();
  const { t } = useAppTranslation();
  const sha256 = typeof params.sha256 === 'string' ? params.sha256 : '';
  return (
    <>
      <StatusBar style="light" />
      <Stack.Screen options={{ headerShown: false }} />
      {isValidImportSha256(sha256) ? (
        <ImageDetailScreen
          importSha256={sha256}
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
