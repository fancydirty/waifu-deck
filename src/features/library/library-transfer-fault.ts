import { S3TransportError } from '@/features/byos/s3-transport-types';
import type {
  LibraryFailureCategory,
  LibraryObjectRole,
} from '@/features/library/library-actions-types';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import { LibraryLocalStorageError } from '@/features/library/library-file-decryptor';
import { toLibraryCloudError } from '@/features/library/library-s3-error-bridge';

/** Why a shared transfer failed; each side maps it with its own vocabulary. */
export type LibraryTransferFault =
  | Readonly<{ kind: 'cloud'; category: LibraryFailureCategory }>
  | Readonly<{ kind: 'local-storage' }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'integrity'; role: LibraryObjectRole }>
  | Readonly<{ kind: 'unexpected' }>;

export function transferFaultFor(error: unknown): LibraryTransferFault {
  const bridged = error instanceof S3TransportError ? toLibraryCloudError(error) : error;
  if (bridged instanceof LibraryCloudError) {
    return { kind: 'cloud', category: bridged.category };
  }
  if (bridged instanceof LibraryLocalStorageError) return { kind: 'local-storage' };
  return { kind: 'unexpected' };
}

export function downloadCategoryFor(fault: LibraryTransferFault): LibraryFailureCategory {
  switch (fault.kind) {
    case 'cloud':
      return fault.category;
    case 'local-storage':
      return 'local_space';
    case 'missing':
      return 'object_missing';
    case 'integrity':
      return 'integrity';
    case 'unexpected':
      return 'integrity';
    default: {
      const exhaustive: never = fault;
      return exhaustive;
    }
  }
}

export function viewFailureFor(
  fault: LibraryTransferFault,
): Readonly<{ category: LibraryFailureCategory; role?: LibraryObjectRole }> {
  switch (fault.kind) {
    case 'cloud':
      return { category: fault.category };
    case 'local-storage':
      return { category: 'retryable_transfer' };
    case 'missing':
      return { category: 'object_missing' };
    case 'integrity':
      return { category: 'integrity', role: fault.role };
    case 'unexpected':
      return { category: 'retryable_transfer' };
    default: {
      const exhaustive: never = fault;
      return exhaustive;
    }
  }
}
