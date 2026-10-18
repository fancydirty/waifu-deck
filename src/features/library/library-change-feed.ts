/**
 * K6-2b (spec `docs/superpowers/specs/2026-09-13-byos-k6-upload-truth-design.md`
 * §2 G3): the one channel through which "the library changed" reaches a mounted
 * screen.
 *
 * Owner's binding wording (2026-09-14): 「到底是上云了但 UI 过时还是确实还在上，
 * 这是个大事」. Measured on the emulator the same day: a freshly collected image
 * is `protected` in SQLite 4.2 s after the save, and the Collection tile keeps
 * claiming "Available offline" until the user leaves the tab and comes back.
 * The reason was that nothing told the grid: `refreshLibraryEntries()` ran only
 * on focus and on the app-wide `dataRevision`, which startup recovery, delete,
 * delete-all and restore bump — never ingest and never protect. K4b had already
 * solved the same problem for the settings section with the sync trigger's
 * `onRoundComplete`, but since K6-1c the ingest-time protect runs outside the
 * sync round, so a round is not its completion signal either.
 *
 * Deliberately not a store: there is no state here, only the fact that
 * something settled. A subscriber's job is to re-read the database, which is
 * the only authority on what a tile should show.
 *
 * **No timers, no throttling, no polling.** Delivery is synchronous inside
 * `emit`, so a subscriber can start its re-read in the same turn the upload
 * finished in. Coalescing (one re-read at a time, one more if events arrived
 * while it was running) belongs to the subscriber, which is the only side that
 * knows how expensive its read is.
 */
export type LibraryChangeKind =
  /** A new local asset finished ingest (favorite / import). */
  | 'ingested'
  /** An upload committed: the bucket now holds this asset's original. */
  | 'protected'
  /**
   * An upload attempt ended, whichever way — committed, blocked, queued
   * offline, or thrown. Emitted for every settle so a tile leaves its
   * in-flight rendering (the K6-2 percentage ring) even on failure.
   */
  | 'protect-settled'
  /** A `runToEmpty` sync round finished (the K4 mirror pass). */
  | 'round-complete'
  /** An asset moved to the account trash. */
  | 'trashed'
  /** A restore-from-trash intent was accepted. */
  | 'restored'
  /** A cloud-only original arrived on this device. */
  | 'downloaded'
  /** The resume pass found this asset's local original gone. */
  | 'original-missing'
  /**
   * Board #24: a rewound save's library copy left this device (its rows and
   * original). The cloud copy is untouched in stage 1 (row 25).
   */
  | 'purged'
  /**
   * Board #27 S1b (spec §5.5): this saved row's collection file went to the
   * library — the row is now `mirrored` and its bytes are the library
   * original, the one copy on the phone.
   */
  | 'handed-over'
  /** Board #27 S3 (spec §5.10): 仅云端 deleted this phone's original; the asset is `cloud-only` and keeps its local thumbnail. */
  | 'freed';

export type LibraryChange = Readonly<{
  kind: LibraryChangeKind;
  /**
   * The asset the change is about. Absent for whole-library changes
   * (`round-complete`), which name no single asset.
   */
  plaintextSha256?: string;
  /**
   * Board #27 S1b: the `images` row of a `handed-over` change; absent for
   * every other kind.
   */
  imageId?: number;
}>;

export type LibraryChangeListener = (change: LibraryChange) => void;

export type LibraryChangeFeed = Readonly<{
  emit(change: LibraryChange): void;
  /** Returns an unsubscribe function. Safe to call more than once. */
  subscribe(listener: LibraryChangeListener): () => void;
}>;

export function createLibraryChangeFeed(): LibraryChangeFeed {
  const listeners = new Set<LibraryChangeListener>();

  return {
    emit(change) {
      // Copied first: a listener may unsubscribe itself (or another) while
      // being notified, and mutating the live Set mid-iteration would silently
      // skip the next one.
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch {
          // The emitters are the protect action and the sync trigger. A screen
          // that threw while re-reading must never fail an upload, and must
          // never cost the next subscriber its notification.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
