import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibrarySessionPort } from '@/features/library/library-actions-types';

/**
 * N10 T1: the saved `mirrored` rows whose original bytes exist nowhere.
 *
 * A row reaches `mirrored` only through the library's hand-over, but the
 * bytes it handed over can later vanish — a crash before the first `protect`
 * outbox row landed, a lost original — and the manual repair loop
 * (`repairDownload`: reclaim → provider re-download → re-ingest → re-protect)
 * already heals them one button press at a time. This module is the resume
 * sweep's selector for the same rows, so the repair runs without the presses.
 *
 * The rule is the collection badge's own no-resolve branch
 * (`isOriginalUnrecoverable`: no usable local original, no committed cloud
 * original generation) lifted to whole images, and deliberately narrower
 * where the two could disagree: an image whose every asset is account- or
 * device-trashed is skipped — the trash sweeps own those rows and their
 * bytes still exist — and an image with one dead and one usable asset is
 * left alone, the two-copies-safe rule `library-collect-backfill.ts` uses.
 * A booru 404 during the repair re-classifies the row as 「源站已删除」 and
 * the sweep then stops retrying it, so the steady state is one query that
 * returns nothing.
 */

/**
 * A local original the missing-original pass has not flagged as vanished —
 * the fields `toLibraryEntry` reads into `hasLocalOriginal`.
 */
const USABLE_LOCAL_ORIGINAL = `
                     a.residency = 'local-original'
                     AND a.local_original_uri IS NOT NULL
                     AND a.missing_original_since IS NULL`;

type MirrorDeadRow = { id: number };

const ASSET_LINKS_IMAGE = `(
  a.source_image_id = i.id
  OR EXISTS (
    SELECT 1 FROM library_provider_image_assets m
     WHERE m.image_id = i.id AND m.plaintext_sha256 = a.plaintext_sha256
  )
)`;

/**
 * Vault core: every dead mirrored row under this account scope, oldest
 * first. The protection join is `LIBRARY_ENTRY_SELECT`'s own, so a committed
 * cloud original generation makes an asset usable exactly the way the badge
 * judges it, and the account-trashed lifecycle never does.
 */
export async function listMirrorDeadSavedImageIds(
  database: SqlDatabasePort,
  accountScope: string,
): Promise<readonly number[]> {
  const rows = await database.getAll<MirrorDeadRow>(
    `SELECT i.id AS id
       FROM images i
      WHERE i.decision = 'saved'
        AND i.download_state = 'mirrored'
        AND EXISTS (
              SELECT 1 FROM device_library_assets a
               WHERE ${ASSET_LINKS_IMAGE}
             )
        AND EXISTS (
              SELECT 1
                FROM device_library_assets a
                LEFT JOIN library_asset_protection p
                  ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
                LEFT JOIN library_device_asset_state d
                  ON d.plaintext_sha256 = a.plaintext_sha256
               WHERE ${ASSET_LINKS_IMAGE}
                 AND (p.lifecycle IS NULL OR p.lifecycle = 'active')
                 AND d.device_trashed_at IS NULL
             )
        AND NOT EXISTS (
              SELECT 1
                FROM device_library_assets a
                LEFT JOIN library_asset_protection p
                  ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
                LEFT JOIN library_device_asset_state d
                  ON d.plaintext_sha256 = a.plaintext_sha256
               WHERE ${ASSET_LINKS_IMAGE}
                 AND (p.lifecycle IS NULL OR p.lifecycle = 'active')
                 AND d.device_trashed_at IS NULL
                 AND (
                   ${USABLE_LOCAL_ORIGINAL}
                   OR p.original_generation_id IS NOT NULL
                 )
             )
      ORDER BY i.id`,
    [accountScope, accountScope],
  );
  return rows.map((row) => row.id);
}

/**
 * Local core: the same selector with the cloud half removed — no account
 * projection is read, so a mirrored row with no usable local original is
 * equally dead there and equally repairable by re-download.
 */
export async function listLocalMirrorDeadSavedImageIds(
  database: SqlDatabasePort,
): Promise<readonly number[]> {
  const rows = await database.getAll<MirrorDeadRow>(
    `SELECT i.id AS id
       FROM images i
      WHERE i.decision = 'saved'
        AND i.download_state = 'mirrored'
        AND EXISTS (
              SELECT 1 FROM device_library_assets a
               WHERE ${ASSET_LINKS_IMAGE}
             )
        AND EXISTS (
              SELECT 1
                FROM device_library_assets a
                LEFT JOIN library_device_asset_state d
                  ON d.plaintext_sha256 = a.plaintext_sha256
               WHERE ${ASSET_LINKS_IMAGE}
                 AND d.device_trashed_at IS NULL
             )
        AND NOT EXISTS (
              SELECT 1
                FROM device_library_assets a
                LEFT JOIN library_device_asset_state d
                  ON d.plaintext_sha256 = a.plaintext_sha256
               WHERE ${ASSET_LINKS_IMAGE}
                 AND d.device_trashed_at IS NULL
                 AND (${USABLE_LOCAL_ORIGINAL})
             )
      ORDER BY i.id`,
  );
  return rows.map((row) => row.id);
}

/**
 * The sweep's one dead-row query; `[]` while no session is held.
 */
export type MirrorDeadSavedImageIds = () => Promise<readonly number[]>;

export type MirrorDeadSavedImageIdsDependencies = Readonly<{
  database: SqlDatabasePort;
  session: LibrarySessionPort;
}>;

/**
 * The vault controller's member: the account scope comes from the session,
 * and a session-less answer is an empty list — never the local query, which
 * would ignore committed cloud originals.
 */
export function createMirrorDeadSavedImageIds({
  database,
  session,
}: MirrorDeadSavedImageIdsDependencies): MirrorDeadSavedImageIds {
  return async () => {
    const context = await session.current();
    if (context === null) return [];
    return listMirrorDeadSavedImageIds(database, context.accountScope);
  };
}
