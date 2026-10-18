import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import type {
  LibraryLocalThumbnails,
  LocalThumbnailResult,
} from '@/features/library/library-local-thumbnails';
import { runTransferPool, type TransferPoolResult } from '@/features/library/library-transfer-pool';

/** Spec §5.11: 8 lanes. A ceiling, not a rate limit. */
export const LIBRARY_THUMBNAIL_PASS_CONCURRENCY = 8;

export type LibraryThumbnailPass = Readonly<{
  /**
   * Board #27 S3 (spec §5.11): a durable thumbnail for every protected,
   * active asset whose original is not on this phone and whose row names
   * none. Rejects only when its candidate read fails.
   */
  run(accountScope: string): Promise<TransferPoolResult>;
}>;

type Row = {
  plaintext_sha256: string;
  thumbnail_generation_id: string | null;
  preview_generation_id: string | null;
  original_generation_id: string;
};

const CANDIDATES_SQL = `
  SELECT a.plaintext_sha256, p.thumbnail_generation_id, p.preview_generation_id,
         p.original_generation_id
    FROM device_library_assets a
    JOIN library_asset_protection p
      ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
    LEFT JOIN library_device_asset_state d ON d.plaintext_sha256 = a.plaintext_sha256
   WHERE (a.residency = 'cloud-only'
          OR (a.residency = 'local-original' AND a.missing_original_since IS NOT NULL))
     AND a.local_thumbnail_uri IS NULL
     AND p.protection = 'protected' AND p.lifecycle = 'active'
     AND p.original_generation_id IS NOT NULL
     AND d.device_trashed_at IS NULL
   ORDER BY a.created_at DESC, a.plaintext_sha256 ASC`;

const PERMANENT_CLOUD: ReadonlySet<LibraryFailureCategory> = new Set([
  'object_missing', 'integrity', 'unsupported_image',
]);

/** A failure the next round cannot change while the asset's cloud objects stay the same. */
function isPermanent(result: Exclude<LocalThumbnailResult, { status: 'ensured' }>): boolean {
  if (result.reason === 'cloud') return PERMANENT_CLOUD.has(result.category);
  return result.reason === 'too-large' || result.reason === 'no-source'
    || result.reason === 'no-asset';
}

const generationsOf = (row: Row): string => (
  `${row.thumbnail_generation_id ?? ''}|${row.preview_generation_id ?? ''}|${row.original_generation_id}`
);

export function createLibraryThumbnailPass({
  database,
  thumbnails,
  concurrency = LIBRARY_THUMBNAIL_PASS_CONCURRENCY,
}: Readonly<{
  database: SqlDatabasePort;
  thumbnails: Pick<LibraryLocalThumbnails, 'ensureLocalThumbnail'>;
  concurrency?: number;
}>): LibraryThumbnailPass {
  /**
   * S2 T4 drift / board #31: digest → the generations it failed for for
   * good. Such an asset is not retried every round (an unresizable original
   * would be re-downloaded each time); new generations (another device
   * filled its roles) or an app restart retry it.
   */
  const skipped = new Map<string, string>();
  return {
    async run(accountScope) {
      const rows = await database.getAll<Row>(CANDIDATES_SQL, [accountScope]);
      const work = rows.filter((row) => skipped.get(row.plaintext_sha256) !== generationsOf(row));
      return runTransferPool(work, async (row) => {
        const result = await thumbnails.ensureLocalThumbnail(row.plaintext_sha256);
        if (result.status === 'ensured') {
          skipped.delete(row.plaintext_sha256);
          return;
        }
        if (isPermanent(result)) skipped.set(row.plaintext_sha256, generationsOf(row));
        throw new Error(`thumbnail ${result.reason}`);
      }, { concurrency });
    },
  };
}
