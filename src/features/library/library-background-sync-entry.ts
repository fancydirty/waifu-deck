import * as TaskManager from 'expo-task-manager';

import {
  createExpoBackgroundTaskApi,
  createLibraryBackgroundSync,
  LIBRARY_BG_SYNC_TASK,
} from '@/features/library/library-background-sync';
import { getLibraryBackgroundRound } from '@/features/library/library-background-sync-slot';

/**
 * Direct-only. `TaskManager.defineTask` must run in the module's global
 * scope (Expo docs: it cannot be called from a React lifecycle method,
 * because a background wakeup spins up the JS app with no views mounted), so
 * this function's body executes at import time via `src/app/_layout.tsx`'s
 * top-level call — it is not a component and takes no dependencies to inject.
 * The Store variant shadows this module (`.store.ts`) so
 * `expo-task-manager`/`expo-background-task` never enter the Store bundle
 * (BYOS stays Direct-only, same convention as `byos-settings-slot.store.tsx`).
 */
export function defineLibraryBackgroundTask(): void {
  TaskManager.defineTask(LIBRARY_BG_SYNC_TASK, () =>
    createLibraryBackgroundSync({
      api: createExpoBackgroundTaskApi(),
      getRound: getLibraryBackgroundRound,
    }).execute());
}
