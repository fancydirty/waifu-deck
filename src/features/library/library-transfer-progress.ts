import { useCallback, useSyncExternalStore } from 'react';

/**
 * K6-2 (spec `docs/superpowers/specs/2026-09-13-byos-k6-upload-truth-design.md`
 * §2 G3/G5): the one place a tile learns how much of an asset is actually on
 * the server right now.
 *
 * Owner's binding wording: 「不是假百分比，必须得是实际的真实百分比」. So this
 * store only ever holds BYTE COUNTS reported by the transfer itself —
 * `bytesSent` from the native upload task, summed across the three role blobs,
 * over the total ciphertext length. Nothing here estimates, animates,
 * interpolates, or advances on a timer. A digest with no entry has no transfer
 * in flight and renders no ring at all.
 *
 * Keyed by `plaintextSha256` because that is the identity a grid tile has in
 * hand (`LibraryEntry.plaintextSha256` / the collection row's library entry);
 * generation ids are minted per upload attempt and would not survive a retry.
 *
 * In-process and deliberately not persisted: a transfer that did not finish
 * before the process died is not in flight any more, and resurrecting its last
 * byte count on the next launch would be exactly the fake percentage the owner
 * rejected.
 */
export type LibraryTransferBytes = Readonly<{
  /** Bytes the transfer reports as handed to (or received from) the server. */
  sent: number;
  /**
   * Total bytes this transfer will move. Ciphertext length, not plaintext.
   * `null` when the source did not announce a length (P12-B: a WebDAV `GET`
   * with no `Content-Length`) — there is no honest percentage to show, so the
   * UI draws an indeterminate spinner instead of guessing one.
   */
  total: number | null;
}>;

export type LibraryTransferProgressStore = Readonly<{
  set(digest: string, bytes: LibraryTransferBytes): void;
  clear(digest: string): void;
  get(digest: string): LibraryTransferBytes | null;
  /** Returns an unsubscribe function. */
  subscribe(digest: string, listener: () => void): () => void;
  /**
   * K6-3: every digest with a transfer in flight, announced whenever that set
   * changes or one of its members reports bytes.
   *
   * The per-digest `subscribe` above is for a tile, which only cares about its
   * own image. The foreground guard cares about the opposite question — "is
   * *anything* uploading right now, and how far along is the batch" — and that
   * has no digest to key on.
   */
  subscribeInFlight(listener: (digests: ReadonlySet<string>) => void): () => void;
}>;

export function createLibraryTransferProgress(): LibraryTransferProgressStore {
  const entries = new Map<string, LibraryTransferBytes>();
  const listeners = new Map<string, Set<() => void>>();
  const inFlightListeners = new Set<(digests: ReadonlySet<string>) => void>();

  const notify = (digest: string): void => {
    const bucket = listeners.get(digest);
    if (bucket === undefined) return;
    // Copy first: a listener may unsubscribe itself while being notified.
    for (const listener of [...bucket]) listener();
  };

  const notifyInFlight = (): void => {
    if (inFlightListeners.size === 0) return;
    const digests = new Set(entries.keys());
    for (const listener of [...inFlightListeners]) listener(digests);
  };

  return {
    set(digest, bytes) {
      const joined = !entries.has(digest);
      // Frozen so `get`'s identity is stable between sets — `useSyncExternalStore`
      // treats a fresh object every read as a changed snapshot and would loop.
      entries.set(digest, Object.freeze({ sent: bytes.sent, total: bytes.total }));
      notify(digest);
      // Membership only: the foreground-service guard posts a notification per
      // in-flight callback, and firing on every 64 KiB progress report made
      // Android rate-shed the notifications on device (K6-3).
      if (joined) notifyInFlight();
    },
    clear(digest) {
      if (!entries.delete(digest)) return;
      notify(digest);
      notifyInFlight();
    },
    get(digest) {
      return entries.get(digest) ?? null;
    },
    subscribe(digest, listener) {
      const bucket = listeners.get(digest) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(digest, bucket);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(digest);
      };
    },
    subscribeInFlight(listener) {
      inFlightListeners.add(listener);
      return () => {
        inFlightListeners.delete(listener);
      };
    },
  };
}

/**
 * The process-wide instance. A module singleton rather than a React context
 * because the producers (the protect action, the transport) live entirely
 * outside the tree and are constructed by `library-integration-impl.ts` long
 * before any screen mounts.
 */
export const libraryTransferProgress = createLibraryTransferProgress();

const noop = (): void => {};

/**
 * What a tile draws for one transfer: `0`–`1` when the length is known,
 * `'indeterminate'` when the source never announced one (P12-B). "Nothing in
 * flight" is the hook's `null`, deliberately outside this type.
 */
export type TransferProgressView = number | 'indeterminate';

/**
 * `0`–`1` while this digest has a transfer in flight with a known length,
 * `'indeterminate'` while it is in flight with an unknown length, `null`
 * otherwise.
 *
 * The fraction is `sent / total` — clamped to `[0, 1]` so a server that reports
 * slightly more than the announced length (or a `total` of 0) can never render
 * a nonsensical arc, and never producing `NaN`. It is not smoothed: it moves
 * exactly when a byte report arrives.
 */
export function useTransferProgress(
  digest: string | null,
  store: LibraryTransferProgressStore = libraryTransferProgress,
): TransferProgressView | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      (digest === null ? noop : store.subscribe(digest, listener)),
    [digest, store],
  );
  const getSnapshot = useCallback(
    () => (digest === null ? null : store.get(digest)),
    [digest, store],
  );
  const bytes = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (bytes === null) return null;
  if (bytes.total === null) return 'indeterminate';
  if (!(bytes.total > 0)) return 0;
  return Math.max(0, Math.min(1, bytes.sent / bytes.total));
}
