import { S3TransportError } from '@/features/byos/s3-transport-types';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';

/**
 * Maps a transport-level `S3TransportError` onto the design's user-action
 * categories (`LibraryFailureCategory`) so the S3 sync path can reuse the
 * sync engine's existing halting/retry decisions unchanged.
 *
 * `precondition` (412/409, CAS conflict) is deliberately routed to
 * `stale_client` rather than treated as `offline`/`integrity`: it is a
 * documented passthrough. `library-cloud-client-s3.ts`'s own CAS retry loop
 * (`isPreconditionFailure`) already intercepts every precondition failure
 * during its bounded retry attempts and only lets one escape once retries are
 * exhausted or a caller opts out of the loop. `stale_client` tells that
 * caller "reread and retry with a fresh base", which is the correct CAS
 * response — it must not be folded into the blind offline/retry bucket the
 * sync engine uses for transport-level trouble.
 */
export function classifyS3TransportError(
  error: S3TransportError,
): LibraryFailureCategory {
  switch (error.category) {
    case 'credential':
      return 'auth_attention';
    case 'network':
    case 'rate_limited':
    case 'server':
      // All three are retryable transport trouble with no user action
      // available; the sync engine's existing 'offline' handling (bounded
      // backoff, not halting) is exactly what they need.
      return 'offline';
    case 'not_found':
      return 'object_missing';
    case 'precondition':
      return 'stale_client';
    case 'client':
      // Any other 4xx (malformed request, etc.): not transport trouble and
      // not something a retry fixes, so it goes to the same terminal bucket
      // the deleted Worker client's `categorize()` used for its default
      // case.
      return 'integrity';
    default: {
      const exhaustive: never = error.category;
      return exhaustive;
    }
  }
}

/**
 * Adapts an `S3TransportError` into the `LibraryCloudError` shape that
 * `library-sync-engine.ts` already knows how to consume: drain's
 * `submitMutations` catch (checks `error instanceof LibraryCloudError` to
 * pick a category, else falls back to `'offline'`) and `sync()`'s catch
 * (checks `error instanceof LibraryCloudError` to halt with a category, else
 * rethrows). Wrapping every S3TransportError raised from
 * `listAssetStates`/`getAssetState`/`submitMutations` through this function
 * lets that pre-existing logic fire for the S3 transport too, with no
 * changes to the engine's catch blocks.
 *
 * `outcomeKnown` is carried through unchanged from the transport error: a
 * write whose outcome the transport could not confirm (network cut mid-send,
 * or a 5xx/429 that may have been forwarded before failing) must stay
 * unknown here too. `isKnownNotApplied` reads this flag directly, so
 * flattening it to `true` would let a caller wrongly discard durable intent
 * for a mutation that may already have landed.
 */
export function toLibraryCloudError(error: S3TransportError): LibraryCloudError {
  return new LibraryCloudError(
    error.status,
    `s3_${error.category}`,
    classifyS3TransportError(error),
    error.message,
    error.outcomeKnown,
  );
}
