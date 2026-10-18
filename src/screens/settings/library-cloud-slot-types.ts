import type { LibraryActionsController } from '@/features/library/library-actions-service';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';

export type LibraryCloudSlotProps = {
  actions: LibraryActionsController | null;
  byosStatus?: ByosStatus;
  message?: string;
};
