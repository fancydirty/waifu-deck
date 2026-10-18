import type {
  LibraryTransferProgressStore,
} from '@/features/library/library-transfer-progress';

/**
 * K6-3. The reason uploads finish after the user puts the phone down.
 *
 * Measured on the emulator 2026-09-14 02:30: three saves, screen locked 1.5 s
 * later, and 90 s after that the bucket still held nothing. Android had frozen
 * the app's JS thread — the uploads were neither failing nor retrying, they
 * simply were not being scheduled. Owner's bar is 「保存 → 锁屏 → 下次打开已经在
 * 云上」, and nothing in JS can meet it alone: only a foreground service tells
 * the platform this process has user-visible work in flight.
 *
 * So this guard is a translator, not a scheduler. It watches the two facts that
 * are already true and already measured — which digests have bytes moving right
 * now, and how many provider downloads are running — and turns "more than zero"
 * into a live service, "zero" into a stopped one. It starts nothing, retries
 * nothing, queues nothing, and runs no timer. If it ever disagreed with the
 * transfers, the transfers would be right.
 *
 * K6-5 B added the download half. A save is booru → device → bucket, and K6-3
 * only protected the second hop; locking the screen mid-download froze the
 * first one (emulator-proven), so "save → lock → next open it is in the cloud"
 * failed before there was anything to upload.
 */
export type SyncForegroundService = Readonly<{
  start(title: string, text: string): Promise<void>;
  update(title: string, text: string): Promise<void>;
  stop(): Promise<void>;
}>;

export type SyncForegroundGuard = Readonly<{
  dispose(): void;
}>;

export type SyncForegroundGuardDeps = Readonly<{
  service: SyncForegroundService;
  store: LibraryTransferProgressStore;
  t: (key: string, values?: Record<string, unknown>) => string;
  /**
   * POST_NOTIFICATIONS (API 33+). Awaited once, before the first start, so the
   * notification the service is about to post is actually visible. Its answer
   * is not acted on: a denied permission costs the user the notification, not
   * the unfrozen process, and refusing to start would trade the whole point of
   * this guard for a cosmetic detail.
   */
  requestPermission?: () => Promise<boolean>;
  /**
   * K6-5 B: `collectionService.subscribeActiveDownloads`. Absent in
   * compositions that have no collection (and in the older tests), which leaves
   * the guard on cloud transfers alone — exactly its K6-3 behaviour.
   */
  subscribeActiveDownloads?: (listener: (count: number) => void) => () => void;
}>;

export function createSyncForegroundGuard({
  service,
  store,
  t,
  requestPermission,
  subscribeActiveDownloads,
}: SyncForegroundGuardDeps): SyncForegroundGuard {
  let running = false;
  let permissionAsked = false;
  /**
   * Digests this batch has *ever* had in flight, so the notification counts
   * what the user did ("3 images") rather than what the uploader is doing at
   * this instant ("2, because the pool's third lane is free"). Cleared when the
   * batch drains, so the next save starts from 1.
   */
  let batch = new Set<string>();
  // Serializes start/update/stop: the native service is one object with one
  // state, and two overlapping calls could leave a notification up after the
  // last transfer settled. Rejections are swallowed — a device without the
  // module (or one that refused the service) must not fail an upload.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch(() => undefined);
  };

  // The two live inputs. Each subscription writes its own and re-derives the
  // single answer, so neither has to know about the other.
  let inFlightDigests: ReadonlySet<string> = new Set();
  let downloading = 0;

  const refresh = (): void => {
    if (inFlightDigests.size === 0 && downloading === 0) {
      batch = new Set();
      if (!running) return;
      running = false;
      enqueue(() => service.stop());
      return;
    }

    for (const digest of inFlightDigests) batch.add(digest);
    const total = batch.size;
    const done = total - inFlightDigests.size;
    const title = t('sync.notificationTitle');
    const text = downloading > 0
      ? t('sync.notificationBodyDownloading', { downloading, done, total })
      : t('sync.notificationBody', { done, total });

    if (running) {
      enqueue(() => service.update(title, text));
      return;
    }
    running = true;
    enqueue(async () => {
      if (requestPermission !== undefined && !permissionAsked) {
        permissionAsked = true;
        await requestPermission().catch(() => false);
      }
      try {
        await service.start(title, text);
      } catch (error) {
        // A start that threw is a service that is not running. Saying otherwise
        // would make every later batch skip its own start.
        running = false;
        throw error;
      }
    });
  };

  const unsubscribe = store.subscribeInFlight((digests) => {
    inFlightDigests = digests;
    refresh();
  });
  const unsubscribeDownloads = subscribeActiveDownloads?.((count) => {
    downloading = count;
    refresh();
  });

  return {
    dispose() {
      unsubscribe();
      unsubscribeDownloads?.();
      if (!running) return;
      running = false;
      enqueue(() => service.stop());
    },
  };
}
