import type { SqlDatabasePort } from '@/db/sql-port';
import type { LibrarySessionPort } from '@/features/library/library-actions-types';
import { deriveLibraryAssetId } from '@/features/library/library-identity';
import {
  PROTECT_SHORT_CIRCUIT,
} from '@/features/library/library-protect-action';

/**
 * N10 T2: how many uncommitted originals one pass may re-drive. A cap, not a
 * schedule: the next pass (cold start, rebind, resume sweep) picks up the rest,
 * so a backlog left by a crashing build cannot stampede the bucket ahead of
 * everything else the app owes its user.
 */
export const LIBRARY_PROTECT_RESUME_BATCH = 24;

/** Dispatches this pass's candidates oldest first; answers how many. */
export type LibraryProtectResume = () => Promise<number>;

export type LibraryProtectResumeDependencies = Readonly<{
  database: SqlDatabasePort;
  session: LibrarySessionPort;
  /** The composition's own protect action, K6-1c dedupe included. */
  protect: (plaintextSha256: string) => Promise<unknown>;
}>;

/**
 * A local original the missing-original pass has not flagged as vanished —
 * the fields `toLibraryEntry` reads into `hasLocalOriginal`.
 */
const USABLE_LOCAL_ORIGINAL = `
                     a.residency = 'local-original'
                     AND a.local_original_uri IS NOT NULL
                     AND a.missing_original_since IS NULL`;

const SHORT_CIRCUIT_CATEGORIES = [...PROTECT_SHORT_CIRCUIT];
const SHORT_CIRCUIT_PLACEHOLDERS = SHORT_CIRCUIT_CATEGORIES
  .map(() => '?')
  .join(', ');

type ResumeRow = { plaintext_sha256: string };

/**
 * N10 T2: re-drive protect for the assets whose protection the resume chain
 * owns. An ingest-time protect that died (native crash, kill) before its first
 * durable outbox write leaves a local original with an unsatisfied protection
 * row and no outbox row at all — the drain sees nothing, the ingest-time
 * callers never run again, and the row later decays into a permanent 「需修复」
 * once the original vanishes (owner bucket, 2026-10-12: 122 such assets).
 *
 * A candidate is every asset whose bytes are really here
 * (`USABLE_LOCAL_ORIGINAL`), whose account projection is not satisfied
 * (`protected` with a verification stamp), that sits in neither trash, that
 * carries no `PROTECT_SHORT_CIRCUIT` verdict — protect re-reports those
 * without a request, so re-driving them only burns battery — and whose
 * `protect` outbox row is not pending or sending: those belong to the sync
 * engine's drain, which replays them. The outbox is keyed by the derived
 * asset id, so the drain-owned set is checked through the same
 * `deriveLibraryAssetId` derivation `protectOnce` performs before it writes
 * any row.
 *
 * Failures stay in protect's own durable bookkeeping: a blocked protect
 * records its failure row and the next pass re-reads it. Racing a round's
 * mirror-up costs one joined call — protect dedupes a digest that is already
 * uploading — never a second upload.
 */
export function createLibraryProtectResume({
  database,
  session,
  protect,
}: LibraryProtectResumeDependencies): LibraryProtectResume {
  return async () => {
    const context = await session.current();
    if (context === null) return 0;
    const rows = await database.getAll<ResumeRow>(
      `SELECT a.plaintext_sha256 AS plaintext_sha256
         FROM device_library_assets a
         LEFT JOIN library_asset_protection p
           ON p.account_scope = ? AND p.plaintext_sha256 = a.plaintext_sha256
         LEFT JOIN library_device_asset_state d
           ON d.plaintext_sha256 = a.plaintext_sha256
        WHERE ${USABLE_LOCAL_ORIGINAL}
          AND (p.lifecycle IS NULL OR p.lifecycle = 'active')
          AND d.device_trashed_at IS NULL
          AND NOT (p.protection = 'protected' AND p.verified_at IS NOT NULL)
          AND (p.failure_category IS NULL
               OR p.failure_category NOT IN (${SHORT_CIRCUIT_PLACEHOLDERS}))
        ORDER BY a.created_at ASC, a.plaintext_sha256 ASC`,
      [context.accountScope, ...SHORT_CIRCUIT_CATEGORIES],
    );
    if (rows.length === 0) return 0;
    const drainOwned = new Set(
      (
        await database.getAll<{ asset_id: string }>(
          `SELECT asset_id FROM library_outbox
            WHERE account_scope = ? AND kind = 'protect'
              AND state IN ('pending', 'sending')`,
          [context.accountScope],
        )
      ).map((row) => row.asset_id),
    );
    let dispatched = 0;
    for (const row of rows) {
      if (dispatched >= LIBRARY_PROTECT_RESUME_BATCH) break;
      if (drainOwned.has(deriveLibraryAssetId(context.masterKey, row.plaintext_sha256))) {
        continue;
      }
      dispatched += 1;
      // One blocked asset must not starve the rest of this pass; its failure
      // row is durable and the next pass re-reads it.
      await protect(row.plaintext_sha256).catch(() => undefined);
    }
    return dispatched;
  };
}
