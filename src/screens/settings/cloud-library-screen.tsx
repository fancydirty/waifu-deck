import type { ReactElement } from 'react';
import { View } from 'react-native';
import { useAppServices } from '@/providers/app-services';
import { useAppTranslation } from '@/i18n/use-app-translation';
import { useAppThemeColors } from '@/theme/colors';
import { ByosSettingsSlot } from './byos-settings-slot';
import { formatCloudLibraryMessage } from './cloud-library-model';
import { LibraryCloudSlot } from './library-cloud-slot';
import { CloudLibraryScroll } from './cloud-library-scroll';

/** Final page layouts consume the root-owned snapshot and existing flows. */
export function CloudLibraryScreen(): ReactElement {
  const theme = useAppThemeColors();
  const { t } = useAppTranslation();
  const { byosStatus, libraryActions, librarySync, libraryChanges,
    libraryStorageMode, reloadAppServices } = useAppServices();
  return (
    <View testID="screen-settings-cloud" style={{ flex: 1, backgroundColor: theme.surface }}>
      <CloudLibraryScroll>
        <ByosSettingsSlot byosStatus={byosStatus} actions={libraryActions} sync={librarySync}
          libraryChanges={libraryChanges} storageMode={libraryStorageMode} onReload={reloadAppServices}
          renderCloudMessage={(model) => <LibraryCloudSlot actions={libraryActions} byosStatus={byosStatus}
            message={formatCloudLibraryMessage(model, t)} />} />
      </CloudLibraryScroll>
    </View>
  );
}
