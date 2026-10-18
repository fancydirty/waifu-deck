import type {
  LibraryLifecycle,
  LibraryProtection,
} from '@/features/library/library-actions-types';
import type { LibraryAssetStateGenerations } from '@/features/library/library-asset-state-codec';
import type { LibraryChangeKind } from '@/features/library/library-sync-types';

/**
 * BYOS S3 per-asset state (one `assets/<id>/state.json` per asset, no
 * account-wide row). Deliberately narrower than the Worker-REST
 * `LibraryRemoteAssetState` that the deleted `library-cloud-client.ts`
 * exported: this shape drops the thumbnail/preview/original generation-id
 * triad and the committed-ciphertext-byte quota accounting, which were
 * Cloud-Vault-Worker concepts BYOS never had (P3C decisions #1 and the BYOS
 * pivot spec — no quota, no entitlement). Same name, intentionally different —
 * the wide Worker shape was mandatory-field-incompatible with this one (see
 * library-mutation-decision fidelity notes in the P3C-1 plan Task 1 report).
 */
export type LibraryRemoteAssetState = Readonly<{
  assetId: string;
  revision: number;
  generation: number;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
}>;

/**
 * BYOS mutation intent for a single asset. Narrower than the Worker-REST
 * `LibraryRemoteMutation` (drops mutationId/reservationId/encryptedMetadata/
 * object-role generation ids, which are outbox- and Worker-transport-owned,
 * not decision inputs) for the same reason as `LibraryRemoteAssetState`
 * above.
 */
export type LibraryRemoteMutation = Readonly<{
  assetId: string;
  kind:
    | 'collect'
    | 'protect'
    | 'trash'
    | 'restore'
    | 'stop-protection'
    | 'permanent-delete';
  baseRevision: number | null;
  observedGeneration: number | null;
  originalGenerationId: string | null;
  /**
   * K7 ⑨: the object-role references this mutation intends to fold into the
   * asset's `generations`. The transport owns the merge (see
   * `library-cloud-client-s3.ts`'s `buildNextRecord`, which also documents the
   * caller's blob-durable-before-state obligation); this table reads it for
   * exactly ONE question — see the `protect` branch below — and ignores it
   * everywhere else.
   *
   * Optional, and every pre-existing producer omits it or names `original`,
   * so the table's answers for them are unchanged.
   */
  generationsPatch?: LibraryAssetStateGenerations;
}>;

/**
 * The rejection reasons the decision table can return for a mutation that the
 * remote refused. Relocated here from the deleted Worker `library-cloud-client`
 * (P3C-2 Task 10): the decision table is the sole producer, and the S3 client's
 * `S3LibraryRemoteRejectionReason` widens this union off `LibraryMutationDecision`.
 */
export type LibraryRemoteRejection =
  | 'resync_required'
  | 'stale_base_revision'
  | 'trash_wins'
  | 'generation_conflict'
  | 'purged_permanently'
  | 'not_found'
  | 'quota_exhausted'
  | 'reservation_required'
  | 'object_missing'
  | 'not_protected'
  | 'not_trash';

/**
 * The outcome of running one mutation against one asset's remote state.
 * Renamed from the test fake's `FakeDecision` (library-actions-test-
 * support.ts) now that this is the production decision table.
 */
export type LibraryMutationDecision =
  | Readonly<{
      outcome: 'applied';
      changeKind: LibraryChangeKind;
      generation: number;
      lifecycle: LibraryLifecycle;
      protection: LibraryProtection;
    }>
  | Readonly<{ outcome: 'merged' }>
  | Readonly<{ outcome: 'rejected'; reason: LibraryRemoteRejection }>;

/**
 * K7 ⑨: does this patch add ONLY derived (thumbnail/preview) references?
 *
 * `library-protect-action.ts` commits `protected` as soon as the ORIGINAL blob
 * is durable and folds the derived references in afterwards, so the follow-up
 * it submits is a `protect` against an asset that is already protected. That
 * combination used to be `merged` — correct for "should this become
 * protected?", but it writes nothing, and the derived references would never
 * reach the bucket for a second device to read.
 *
 * The predicate is deliberately narrow. A patch that names `original` is a
 * real protect (the inline commit, and the sync engine's crash replay, both
 * always name it), so those keep merging and a device that never uploads a
 * derived role is never rejected or made to rewrite state.json. An explicitly
 * `undefined` role is "no change to that role" — the same rule
 * `compactGenerations` applies on the write side — so it is not a patch
 * either.
 */
function isDerivedOnlyGenerationsPatch(
  patch: LibraryAssetStateGenerations | undefined,
): boolean {
  if (patch === undefined) return false;
  if (patch.original !== undefined) return false;
  return patch.thumbnail !== undefined || patch.preview !== undefined;
}

/**
 * Worker-verified conflict-resolution table for one library mutation
 * against one asset's remote state. Promoted from `decideStrict` in
 * `library-actions-test-support.ts`, diffed branch-by-branch against the
 * real Worker's `decideLibraryMutation` (`cloudflare/vault/src/index.ts`,
 * ~line 6057) per P3C decision #4.
 *
 * Two resolved points where this module intentionally does not mirror the
 * raw Worker function line-for-line (see the P3C-1 Task 1 report for the
 * full diff):
 *
 * 1. `permanent-delete` applied outcome: the raw Worker function returns an
 *    intermediate `lifecycle: 'trash'` here (its return type explicitly
 *    excludes `'purged'`) because the Worker splits "authorize" (this
 *    function) from "finalize" (a separate `purgeLibraryAsset` call that
 *    does the real R2 delete and writes `lifecycle = 'purged',
 *    protection = 'unprotected'` to D1). BYOS has no second finalize phase
 *    — this function's return value is what gets written straight into
 *    `assets/<id>/state.json` — so it returns the fully-materialized
 *    terminal state (`lifecycle: 'purged'`, `protection: 'unprotected'`)
 *    that the Worker system converges to end-to-end, matching the fake and
 *    the plan's Step 2 test.
 * 2. Bookkeeping fields the raw Worker function echoes into its decision
 *    object (`collectedAt`, `trashedAt`, `purgeAfter`, `encryptedMetadata`)
 *    are pure pass-through values never used in any branch/outcome
 *    decision. They are D1-column and Worker-retention concerns with no
 *    BYOS state.json equivalent decided here; a caller (the S3 CAS write
 *    path) computes them itself from the mutation and current time.
 *
 * 3. K7 ⑨ adds ONE branch the Worker table never had, because BYOS has a
 *    producer the Worker never had: a `protect` whose `generationsPatch`
 *    names only derived roles, against an asset that is already protected,
 *    applies instead of merging (see `isDerivedOnlyGenerationsPatch` above and
 *    the `protect` branch below). Nothing else about `protect` changed, and no
 *    pre-existing producer can reach it — the inline commit and the sync
 *    engine's replay both always name `original`.
 *
 * Every outcome, rejection reason, and changeKind/generation/lifecycle/
 * protection value below is otherwise identical to the real Worker table.
 *
 * `minBaseCursor` keeps the Worker's parameter name and comparison
 * (`mutation.baseRevision < minBaseCursor` -> `resync_required`), but its
 * BYOS semantics are per-asset (P3C decisions #3/#5): there is no
 * account-wide cursor, so callers always pass `0` and this branch is a
 * structural no-op in production. It stays wired so a corrupted/malformed
 * baseRevision is still rejected instead of silently misapplied, and so the
 * table remains a faithful transcription of the Worker logic it was
 * verified against.
 */
export function decideLibraryMutation(
  asset: LibraryRemoteAssetState | null,
  mutation: LibraryRemoteMutation,
  minBaseCursor: number,
): LibraryMutationDecision {
  if (
    mutation.baseRevision !== null &&
    mutation.baseRevision < minBaseCursor
  ) {
    return { outcome: 'rejected', reason: 'resync_required' };
  }
  const seesLatest =
    asset !== null &&
    mutation.baseRevision !== null &&
    mutation.baseRevision >= asset.revision;
  const generationMatches =
    asset !== null &&
    (mutation.observedGeneration === null ||
      mutation.observedGeneration === asset.generation);

  if (mutation.kind === 'collect') {
    if (asset === null) {
      return {
        outcome: 'applied',
        changeKind: 'collect',
        generation: 1,
        lifecycle: 'active',
        protection: 'unprotected',
      };
    }
    if (asset.lifecycle === 'active') return { outcome: 'merged' };
    if (asset.lifecycle === 'trash') {
      return { outcome: 'rejected', reason: 'trash_wins' };
    }
    if (!seesLatest) {
      return { outcome: 'rejected', reason: 'stale_base_revision' };
    }
    // A deliberate re-import of a permanently deleted asset is a new
    // generation.
    return {
      outcome: 'applied',
      changeKind: 'collect',
      generation: asset.generation + 1,
      lifecycle: 'active',
      protection: 'unprotected',
    };
  }

  if (asset === null) return { outcome: 'rejected', reason: 'not_found' };

  if (mutation.kind === 'trash') {
    if (asset.lifecycle !== 'active') return { outcome: 'merged' };
    if (!generationMatches) {
      return { outcome: 'rejected', reason: 'generation_conflict' };
    }
    return {
      outcome: 'applied',
      changeKind: 'trash',
      generation: asset.generation,
      lifecycle: 'trash',
      protection: asset.protection,
    };
  }

  if (mutation.kind === 'protect') {
    if (asset.lifecycle === 'purged') {
      return { outcome: 'rejected', reason: 'purged_permanently' };
    }
    if (asset.lifecycle === 'trash') {
      return { outcome: 'rejected', reason: 'trash_wins' };
    }
    if (asset.protection === 'protected' && generationMatches) {
      // K7 ⑨: an already-protected asset plus a derived-ONLY patch is the
      // follow-up that carries the thumbnail/preview references the inline
      // commit deliberately did not wait for. It changes no lifecycle and no
      // protection and keeps the same generation — only `generations` and the
      // revision move (the transport bumps the revision when it writes). Every
      // other protect against a protected asset still merges.
      //
      // `lifecycle: 'active'` is the only possibility here: `purged` and
      // `trash` were both rejected above.
      if (isDerivedOnlyGenerationsPatch(mutation.generationsPatch)) {
        return {
          outcome: 'applied',
          changeKind: 'protect',
          generation: asset.generation,
          lifecycle: 'active',
          protection: 'protected',
        };
      }
      return { outcome: 'merged' };
    }
    if (!seesLatest || !generationMatches) {
      return {
        outcome: 'rejected',
        reason: !seesLatest ? 'stale_base_revision' : 'generation_conflict',
      };
    }
    if (mutation.originalGenerationId === null) {
      return { outcome: 'rejected', reason: 'object_missing' };
    }
    return {
      outcome: 'applied',
      changeKind: 'protect',
      generation: asset.generation,
      lifecycle: 'active',
      protection: 'protected',
    };
  }

  if (mutation.kind === 'stop-protection') {
    if (asset.lifecycle === 'purged') {
      return { outcome: 'rejected', reason: 'purged_permanently' };
    }
    if (asset.protection !== 'protected') return { outcome: 'merged' };
    if (!seesLatest || !generationMatches) {
      return {
        outcome: 'rejected',
        reason: !seesLatest ? 'stale_base_revision' : 'generation_conflict',
      };
    }
    return {
      outcome: 'applied',
      changeKind: 'stop-protection',
      generation: asset.generation,
      lifecycle: asset.lifecycle === 'trash' ? 'trash' : 'active',
      protection: 'unprotected',
    };
  }

  if (mutation.kind === 'permanent-delete') {
    if (asset.lifecycle === 'purged') return { outcome: 'merged' };
    if (asset.lifecycle !== 'trash') {
      return { outcome: 'rejected', reason: 'not_trash' };
    }
    if (!generationMatches) {
      return { outcome: 'rejected', reason: 'generation_conflict' };
    }
    // Terminal materialized state (see the "resolved points" note above):
    // BYOS has no separate purge-finalization phase, so this is the state
    // written straight to state.json.
    return {
      outcome: 'applied',
      changeKind: 'purge',
      generation: asset.generation,
      lifecycle: 'purged',
      protection: 'unprotected',
    };
  }

  // mutation.kind === 'restore'
  if (asset.lifecycle === 'purged') {
    return { outcome: 'rejected', reason: 'purged_permanently' };
  }
  if (asset.lifecycle === 'active') return { outcome: 'merged' };
  if (!seesLatest) {
    return { outcome: 'rejected', reason: 'stale_base_revision' };
  }
  if (!generationMatches) {
    return { outcome: 'rejected', reason: 'generation_conflict' };
  }
  // An explicit restore is a new generation, so an in-flight edit against
  // the trashed generation can never be mistaken for an edit against this
  // one.
  return {
    outcome: 'applied',
    changeKind: 'restore',
    generation: asset.generation + 1,
    lifecycle: 'active',
    protection: asset.protection,
  };
}
