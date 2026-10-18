import type { LibraryCacheEntry } from '@/features/library/library-cache-store';
import type { LibraryTransferFault } from '@/features/library/library-transfer-fault';

export type LibraryRoleFetch =
  | Readonly<{ kind: 'promoted'; uri: string }>
  | Readonly<{ kind: 'cached'; entry: LibraryCacheEntry }>
  | Readonly<{
      kind: 'failed';
      stage: 'transfer' | 'consume';
      fault: LibraryTransferFault;
    }>;

export type LibraryTransferClaim<T> = Readonly<{
  promise: Promise<T>;
  owner: boolean;
}>;

export type LibraryTransferCoalescer<T> = Readonly<{
  run(key: string, task: () => Promise<T>): Promise<T>;
  /** Returns the same in-flight promise and tells the caller whether it owns it. */
  runWithOwnership?(
    key: string,
    task: () => Promise<T>,
  ): LibraryTransferClaim<T>;
}>;

export function runWithOwnership<T>(
  coalescer: LibraryTransferCoalescer<T>,
  key: string,
  task: () => Promise<T>,
): LibraryTransferClaim<T> {
  if (coalescer.runWithOwnership !== undefined) {
    return coalescer.runWithOwnership(key, task);
  }
  return { promise: coalescer.run(key, task), owner: true };
}

export function createTransferCoalescer<T>(): LibraryTransferCoalescer<T> {
  const inFlight = new Map<string, Promise<T>>();

  const runWithOwnership = (
    key: string,
    task: () => Promise<T>,
  ): LibraryTransferClaim<T> => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return { promise: existing, owner: false };

    const promise = Promise.resolve().then(task);
    inFlight.set(key, promise);
    promise.finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }).catch(() => undefined);
    return { promise, owner: true };
  };

  return {
    run(key, task) {
      return runWithOwnership(key, task).promise;
    },
    runWithOwnership,
  };
}
