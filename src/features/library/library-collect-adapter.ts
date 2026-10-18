import type { LibraryIngestService } from '@/features/library/library-ingest';
import type { LibraryIngestOutcome } from '@/features/library/library-types';

export type LibraryCollectEvent = Readonly<{
  imageId: number;
  localUri: string;
}>;

export type LibraryCollectAdapter = Readonly<{
  onOriginalReady(event: LibraryCollectEvent): void;
  drain(): Promise<void>;
  /**
   * Board #24 (spec §5.4.2 step 1): resolves once nothing is queued or running
   * for this image — at once when that is already true. The purge of a
   * rewound save waits on it, so an ingest already under way commits first and
   * is purged next instead of landing afterwards. Never waits on other ids.
   */
  settled(imageId: number): Promise<void>;
  /**
   * Board #27 S1b Task 8 (spec R26): while refused, `onOriginalReady` drops
   * each new event, which is then neither queued nor pending; answers an
   * idempotent release.
   */
  refuse(): () => void;
}>;

export type LibraryCollectAdapterDependencies = Readonly<{
  ingest: LibraryIngestService;
  onFailure?: (event: LibraryCollectEvent, error: unknown) => void;
  /**
   * K6-5 C: the ingest for this event finished — the asset is in the library
   * (freshly ingested or already there). The composition uses it to clear a
   * previously recorded `images.library_error`, so a row that failed once and
   * succeeded on a later pass stops showing 「入库失败」. Board #27 S1b: the
   * ingest's outcome comes with it, for the hand-over (spec §5.5).
   */
  onSuccess?: (
    event: LibraryCollectEvent,
    outcome: LibraryIngestOutcome,
  ) => void;
  /**
   * Maximum number of ingests allowed to run at once. A ceiling on parallelism,
   * not a rate limit: there is no sleep between items. K6-4a replaced the old
   * single tail chain with this bounded pool so a rapid burst of saves fans out
   * instead of draining one-file-at-a-time (owner G0: each save ≤ 5 s). The
   * bound is also a memory guard (K7 first-principles): unbounded fan-out would
   * OOM on wallpaper-sized batches. Injectable for tests; defaults to
   * `LIBRARY_INGEST_CONCURRENCY`.
   */
  concurrency?: number;
}>;

/**
 * Default ingest lanes. Peak ingest memory ≈ 6 × one decoded image, well below
 * the serial-era observed pressure; 6 lanes already fan out faster than a
 * normal uplink, so the network — not the code — is the ceiling.
 */
export const LIBRARY_INGEST_CONCURRENCY = 6;

export function createLibraryCollectAdapter({
  ingest,
  onFailure = () => undefined,
  onSuccess = () => undefined,
  concurrency = LIBRARY_INGEST_CONCURRENCY,
}: LibraryCollectAdapterDependencies): LibraryCollectAdapter {
  const lanes = Math.max(1, concurrency);
  const queue: LibraryCollectEvent[] = [];
  // Ids currently queued or in flight. A repeated id merges into the pending
  // work rather than ingesting twice; it is cleared when the ingest settles,
  // so a genuine later re-collect of the same id ingests again.
  const pending = new Set<number>();
  // Board #24: callers of `settled(id)`, released when that id leaves `pending`.
  const settledWaiters = new Map<number, (() => void)[]>();
  let refusals = 0;
  let active = 0;
  let drainWaiters: (() => void)[] = [];

  const settleDrainIfIdle = (): void => {
    if (active !== 0 || queue.length !== 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const run = (event: LibraryCollectEvent): void => {
    active += 1;
    void (async () => {
      try {
        const ingestOutcome = await ingest.ingestUri({
          sourceUri: event.localUri,
          origin: 'provider',
          sourceImageId: event.imageId,
        });
        try {
          onSuccess(event, ingestOutcome);
        } catch {
          // A reporting failure must not break the pool.
        }
      } catch (error) {
        try {
          onFailure(event, error);
        } catch {
          // A reporting failure must not break the pool.
        }
      } finally {
        active -= 1;
        pending.delete(event.imageId);
        const waiters = settledWaiters.get(event.imageId) ?? [];
        settledWaiters.delete(event.imageId);
        for (const resolve of waiters) resolve();
        pump();
      }
    })();
  };

  const pump = (): void => {
    while (active < lanes && queue.length > 0) {
      run(queue.shift()!);
    }
    settleDrainIfIdle();
  };

  return {
    onOriginalReady(event) {
      if (refusals > 0) return;
      if (pending.has(event.imageId)) return;
      pending.add(event.imageId);
      queue.push(event);
      pump();
    },
    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
    settled(imageId) {
      if (!pending.has(imageId)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = settledWaiters.get(imageId) ?? [];
        waiters.push(resolve);
        settledWaiters.set(imageId, waiters);
      });
    },
    refuse() {
      refusals += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refusals -= 1;
      };
    },
  };
}
