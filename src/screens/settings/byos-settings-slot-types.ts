import type { ReactNode } from 'react';
import type { CloudLibraryModel } from './cloud-library-model';
import type {
  LibraryActionsController,
} from '@/features/library/library-actions-service';
import type {
  LibrarySyncController,
} from '@/features/library/library-sync-engine';
import type { LibraryChangeFeed } from '@/features/library/library-change-feed';
import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type {
  LibraryStorageModeControl,
} from '@/features/library/library-integration-types';

/**
 * Existing Settings composition ports. Passive ports are owned by the root
 * ByosCloudLibraryProvider; the slot consumes its shared context snapshot.
 * Keep the current composition signature until Task 3 relocates the section.
 */
export type ByosSettingsSlotProps = {
  byosStatus: ByosStatus;
  actions: LibraryActionsController | null;
  sync: LibrarySyncController | null;
  /**
   * K6-2b: the Direct composition's change feed, the signal the status rows
   * re-read on. The provider binds this feed once for both consumers. Null
   * before a ready library composition exists.
   */
  libraryChanges: LibraryChangeFeed | null;
  /**
   * Board #27 S3b: the composition's 本机存储 control; null on a locked or
   * unconfigured device, where the row is not shown.
   */
  storageMode: LibraryStorageModeControl | null;
  onReload: () => void;
  renderCloudMessage: (model: CloudLibraryModel) => ReactNode;
};
