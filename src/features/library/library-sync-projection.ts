import type {
  LibraryLifecycle,
  LibraryProtection,
} from '@/features/library/library-actions-types';
import {
  readAssetStateKey,
  type LibraryAssetStateRecord,
} from '@/features/library/library-asset-state-codec';
import type { LibraryProjectedAsset } from '@/features/library/library-sync-types';

const LIFECYCLES: readonly string[] = ['active', 'trash', 'purged'];
const PROTECTIONS: readonly string[] = [
  'unprotected',
  'pending',
  'protected',
  'failed',
];

/** `state.json` times are ISO-8601 strings; the local schema stores epoch millis. */
export function parseIsoMillis(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The one mapping between the BYOS wire record (`assets/<id>/state.json`, via
 * `LibraryReconciliationPort` or a mutation result) and the local projection
 * row. Both of the sync engine's producers — reconcile and drain — go through
 * here, so a listed record and a just-written one can never be projected two
 * different ways.
 *
 * Returns `null` for a record whose `lifecycle` or `protection` this build
 * does not understand. A newer writer's value must never be coerced into a
 * row the local schema would misread; the record simply stays unprojected and
 * a later build reconciles it (protocol spec's version fail-safe, applied to
 * the read side).
 *
 * Field notes:
 * - `meta` -> `encryptedMetadata`. This is the whole point of Task 1: it is
 *   the only route by which a device materializes an asset it has never held
 *   locally (`library-sync-apply.ts` skips a row with no envelope and no
 *   local digest mapping).
 * - `trashedAt` (ISO) -> `trashedAtMs`. Required, not cosmetic: the trash
 *   screen filters on `trashed_at` and computes each item's purge deadline
 *   from it.
 * - `originalCiphertextBytes` is always `null`. The BYOS record has no
 *   equivalent field and, with quota deleted, no consumer needs one — the two
 *   readers that remain (`library-protect-action.ts`,
 *   `library-account-actions.ts`) only pass the value through. Recorded as a
 *   deliberate ruling, not an oversight.
 * - The three generation ids are adopted **only** while the record says
 *   `protected`, matching the apply writer's UPSERT, which clears stored
 *   references the moment protection ends.
 */
export function projectAssetStateRecord(
  record: LibraryAssetStateRecord,
): LibraryProjectedAsset | null {
  if (
    !LIFECYCLES.includes(record.lifecycle)
    || !PROTECTIONS.includes(record.protection)
  ) {
    return null;
  }
  const protectedNow = record.protection === 'protected';
  const stateKey = readAssetStateKey(record);
  return {
    assetId: record.assetId,
    revision: record.revision,
    generation: record.generation,
    lifecycle: record.lifecycle as LibraryLifecycle,
    protection: record.protection as LibraryProtection,
    encryptedMetadata: record.meta ?? null,
    trashedAtMs: parseIsoMillis(record.trashedAt),
    originalGenerationId: protectedNow
      ? record.generations.original ?? null
      : null,
    originalCiphertextBytes: null,
    thumbnailGenerationId: protectedNow
      ? record.generations.thumbnail ?? null
      : null,
    previewGenerationId: protectedNow
      ? record.generations.preview ?? null
      : null,
    ...(stateKey !== null ? { stateKey } : {}),
  };
}
