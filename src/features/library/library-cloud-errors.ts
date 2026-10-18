import type { LibraryFailureCategory } from '@/features/library/library-actions-types';

/**
 * A category-bearing library sync error. Callers branch on `category` to pick a
 * user-action response and on `outcomeKnown` to decide whether a failed write
 * may already have landed. The S3 transport wraps its own `S3TransportError`
 * into this shape (`library-s3-error-bridge.ts`) so the sync engine's existing
 * `instanceof LibraryCloudError` catch logic classifies both transports the
 * same way.
 */
export class LibraryCloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly category: LibraryFailureCategory,
    message: string,
    /**
     * `true` only when the remote answered and refused the request, so nothing
     * was committed. `false` means the request may already have been applied
     * and the caller must not discard its durable intent.
     */
    readonly outcomeKnown: boolean = true,
  ) {
    super(message);
    this.name = 'LibraryCloudError';
    Object.setPrototypeOf(this, LibraryCloudError.prototype);
  }
}

/** True when the failure proves the account state did not change. */
export function isKnownNotApplied(error: unknown): boolean {
  return error instanceof LibraryCloudError && error.outcomeKnown;
}
