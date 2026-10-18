import i18n from '@/i18n';
import type { LibraryActionsController } from '@/features/library/library-actions-service';
import { formatCloudLibraryMessage, type CloudLibraryModel } from '@/screens/settings/cloud-library-model';
import { LibraryCloudSlot } from '@/screens/settings/library-cloud-slot-impl';

/** Direct section fixtures use the same message composition as the real page. */
export const renderCloudMessage = (model: CloudLibraryModel) => (
  <LibraryCloudSlot actions={null} message={formatCloudLibraryMessage(model, i18n.t.bind(i18n))} />
);
export function cloudMessageFactory(actions: LibraryActionsController | null) {
  return function renderMessage(model: CloudLibraryModel) {
    return <LibraryCloudSlot actions={actions} message={formatCloudLibraryMessage(model, i18n.t.bind(i18n))} />;
  };
}
