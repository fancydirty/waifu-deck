import type { SqlDatabasePort } from '@/db/sql-port';
import type { ImageRepository } from '@/features/images/image-repository';
import type { LibraryCollectEvent } from '@/features/library/library-collect-adapter';
import {
  libraryIngestErrorCode,
  type LibraryIngestErrorCode,
} from '@/features/library/library-types';

/**
 * Ingest verdicts that are about the bytes themselves rather than about the
 * moment they were read. `unreadable_source`, `empty_file`, `storage_failed`
 * and `database_failed` all describe a bad moment — a staged copy that raced a
 * concurrent write, a full disk, a busy database — so they are always worth
 * another try. These two describe the file, and retrying them forever would be
 * work that can never succeed.
 */
export const TERMINAL_LIBRARY_INGEST_ERRORS: readonly LibraryIngestErrorCode[] = [
  'unsupported_format',
  'decode_failed',
];

/**
 * How many times one of the above may be recorded before the row is left
 * alone. Not one: with six ingest lanes against wallpaper-sized images, a
 * decode can fail under memory pressure on a file that decodes perfectly the
 * next time (owner phone 2026-09-14, a 1064x1216 JPEG after ~40 swipes). Two
 * separate verdicts on the same bytes is a property of the file.
 */
export const LIBRARY_INGEST_TERMINAL_ATTEMPTS = 2;

export type LibraryCollectBackfill = Readonly<{
  /** Dispatches every re-ingestable row and answers how many it dispatched. */
  run(): Promise<number>;
}>;

export type LibraryCollectBackfillDependencies = Readonly<{
  database: SqlDatabasePort;
  /** `collectAdapter.onOriginalReady` — the same six-lane pool a save uses. */
  collect: (event: LibraryCollectEvent) => void;
}>;

type BackfillRow = {
  id: number;
  local_uri: string;
};

/**
 * K6-5 C: re-ingest the collected originals the private library never got.
 *
 * A save is download -> `onOriginalReady` -> `ingest.ingestUri`, and that
 * ingest can throw. Before K6-5 nothing recorded or retried it: the row stayed
 * `ready` with its file on disk, the library had no asset for it, and the tile
 * rendered an ordinary offline image with no badge and no way to act (owner
 * phone 2026-09-14 21:30 — 82 saved in the grid, 42 in the bucket).
 *
 * This is the repair, and it is deliberately not a mechanism of its own: it
 * runs only at the two moments the app is already walking this data (the
 * startup/resume sweep and a completed sync round), it hands every row to the
 * pool a fresh save already uses, and it holds no queue, no timer, and no
 * state. Rows the library already covers are excluded by the join, and the
 * two byte-level verdicts stop retrying after a second try, so a steady state
 * is one query that returns nothing.
 *
 * Board #27 S1b (spec §5.3, "K6-5 backfill"; §5.6): the ingest now heals an
 * asset with no usable original, so "covered" means a library row usable by
 * its fields (`local-original`, a uri, no missing flag) or a device-trashed
 * (`cached`) one, which the ingest never adopts. A row is dispatched when it
 * has neither — "no row at all" is the empty case — or when its last ingest
 * failed, because then its bytes may not be the library row's; the terminal
 * rule still applies. A vanished or foreign original is caught by its flag:
 * the resume pass flags before it runs this. An image with one usable row and
 * another unusable one is left alone (two copies, safe) rather than
 * re-ingested on every pass and round, and an ingest's success clears
 * `library_error`, so a healed or re-hashed row leaves the set. Two shapes
 * are dispatched on every pass and round, because the ingest of their
 * collection file lands on another image's row and so never covers them: an
 * image with no row of its own whose bytes another image's row holds (spec
 * R12, the same bytes saved twice; unchanged, it matches "no row at all"),
 * and — new with this rule, and extremely rare — an image whose only row is
 * unusable (flagged or cloud-only, digest S) while its collection file now
 * hashes to S′, which another image's row holds (a re-download whose changed
 * bytes match another saved image). The heal can never fix that image's own
 * row.
 */
export function createLibraryCollectBackfill({
  database,
  collect,
}: LibraryCollectBackfillDependencies): LibraryCollectBackfill {
  const terminalPlaceholders = TERMINAL_LIBRARY_INGEST_ERRORS.map(() => '?').join(', ');

  return {
    async run() {
      const rows = await database.getAll<BackfillRow>(
        `SELECT i.id AS id, i.local_uri AS local_uri
           FROM images i
          WHERE i.decision = 'saved'
            AND i.download_state = 'ready'
            AND i.local_uri IS NOT NULL
            AND (
              NOT EXISTS (
                SELECT 1 FROM device_library_assets a
                 WHERE (
                   a.source_image_id = i.id
                   OR EXISTS (
                     SELECT 1 FROM library_provider_image_assets m
                      WHERE m.image_id = i.id AND m.plaintext_sha256 = a.plaintext_sha256
                   )
                 )
                   AND (
                     a.residency = 'cached'
                     OR (
                       a.residency = 'local-original'
                       AND a.local_original_uri IS NOT NULL
                       AND a.missing_original_since IS NULL
                     )
                   )
              )
              OR i.library_error IS NOT NULL
            )
            AND (
              i.library_error IS NULL
              OR i.library_error NOT IN (${terminalPlaceholders})
              OR i.library_error_attempts < ?
            )
          ORDER BY i.id`,
        [...TERMINAL_LIBRARY_INGEST_ERRORS, LIBRARY_INGEST_TERMINAL_ATTEMPTS],
      );

      for (const row of rows) {
        collect({ imageId: row.id, localUri: row.local_uri });
      }
      return rows.length;
    },
  };
}

export type LibraryIngestOutcomeRecorder = Readonly<{
  onSuccess(event: LibraryCollectEvent): void;
  onFailure(event: LibraryCollectEvent, error: unknown): void;
}>;

/**
 * K6-5 C: the other half of the same bookkeeping — what the backfill query
 * above reads is what this writes.
 *
 * The collect adapter's `onFailure` used to default to a no-op, so an ingest
 * that threw was not recorded, not shown, and not retried: the row stayed
 * `ready` with its file on disk and the save was gone. Both hooks are
 * fire-and-forget by design — the durable local original and the collection row
 * are already committed, and a bookkeeping write must never be able to undo
 * them or fail the ingest pool.
 *
 * `images` is optional because a bare test bundle (and any composition without
 * a collection) has no repository to write to; there the recorder is inert.
 */
export function createLibraryIngestOutcomeRecorder(
  images: ImageRepository | undefined,
): LibraryIngestOutcomeRecorder {
  return {
    onSuccess(event) {
      // The asset is in the library now, so any earlier verdict is history —
      // otherwise a row repaired on a later pass would keep its 「入库失败」 badge.
      void images?.clearLibraryIngestError(event.imageId).catch(() => undefined);
    },
    onFailure(event, error) {
      void images
        ?.recordLibraryIngestFailure(event.imageId, libraryIngestErrorCode(error))
        .catch(() => undefined);
    },
  };
}
