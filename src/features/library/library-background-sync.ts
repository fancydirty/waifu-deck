import { acquireLibrarySyncLease } from '@/features/library/library-background-sync-slot';
import {
  runToEmpty,
  type SyncRoundResult,
} from '@/features/library/library-sync-run-to-empty';

export const LIBRARY_BG_SYNC_TASK = 'waifu-deck.library.sync';

export type BackgroundTaskApi = Readonly<{
  registerTaskAsync(
    name: string,
    options: { minimumInterval: number },
  ): Promise<void>;
  unregisterTaskAsync(name: string): Promise<void>;
  isTaskRegisteredAsync(name: string): Promise<boolean>;
  BackgroundTaskResult: Readonly<{ Success: number; Failed: number }>;
}>;

export type LibraryBackgroundSync = Readonly<{
  ensureRegistered(): Promise<void>;
  ensureUnregistered(): Promise<void>;
  execute(): Promise<number>;
}>;

/**
 * Android WorkManager floor (spec §4.5). The system treats this as a minimum,
 * not a schedule — actual runs are inexact and may be much less frequent.
 */
const MINIMUM_INTERVAL_MINUTES = 15;

export function createLibraryBackgroundSync({
  api,
  getRound,
  maxRounds = 3,
  acquireLease = acquireLibrarySyncLease,
}: {
  api: BackgroundTaskApi;
  getRound: () => (() => Promise<SyncRoundResult>) | null;
  acquireLease?: () => (() => void) | null;
  maxRounds?: number;
}): LibraryBackgroundSync {
  return {
    async ensureRegistered() {
      if (await api.isTaskRegisteredAsync(LIBRARY_BG_SYNC_TASK)) return;
      await api.registerTaskAsync(LIBRARY_BG_SYNC_TASK, {
        minimumInterval: MINIMUM_INTERVAL_MINUTES,
      });
    },
    async ensureUnregistered() {
      if (!(await api.isTaskRegisteredAsync(LIBRARY_BG_SYNC_TASK))) return;
      await api.unregisterTaskAsync(LIBRARY_BG_SYNC_TASK);
    },
    async execute() {
      const round = getRound();
      if (round === null) return api.BackgroundTaskResult.Success;
      // #6: never overlap a foreground round. Held ⇒ the foreground is already
      // draining; report Success so WorkManager simply reschedules.
      const release = acquireLease();
      if (release === null) return api.BackgroundTaskResult.Success;
      try {
        // Bounded: the background window is short (WorkManager ~10min soft
        // limit), so a partial run defers the rest to the next wakeup or a
        // foreground residue timer rather than trying to finish here.
        await runToEmpty(round, { maxRounds });
        return api.BackgroundTaskResult.Success;
      } catch {
        return api.BackgroundTaskResult.Failed;
      } finally {
        release();
      }
    },
  };
}

/** Real-module adapter. Lazy `require` so tests and the Store bundle never load native code. */
export function createExpoBackgroundTaskApi(): BackgroundTaskApi {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BT = require('expo-background-task') as typeof import('expo-background-task');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TM = require('expo-task-manager') as typeof import('expo-task-manager');
  return {
    registerTaskAsync: BT.registerTaskAsync,
    unregisterTaskAsync: BT.unregisterTaskAsync,
    isTaskRegisteredAsync: TM.isTaskRegisteredAsync,
    BackgroundTaskResult: BT.BackgroundTaskResult,
  };
}
