export type TransferPoolResult = Readonly<{ total: number; done: number; failed: number }>;

/**
 * Run `worker` over every item with at most `concurrency` in flight at once.
 * A ceiling on parallelism, NOT a rate limit: there is no sleep or delay
 * between items (owner mirror ruling: no throttling). A worker rejection is
 * counted as `failed` and never aborts the other lanes.
 */
export async function runTransferPool<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  { concurrency }: Readonly<{ concurrency: number }>,
): Promise<TransferPoolResult> {
  const total = items.length;
  if (total === 0) return { total: 0, done: 0, failed: 0 };
  const lanes = Math.max(1, Math.min(concurrency, total));
  let next = 0;
  let done = 0;
  let failed = 0;
  const runLane = async (): Promise<void> => {
    while (next < total) {
      const index = next;
      next += 1;
      try {
        await worker(items[index]!);
        done += 1;
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: lanes }, () => runLane()));
  return { total, done, failed };
}
