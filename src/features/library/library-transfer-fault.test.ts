import { S3TransportError } from '@/features/byos/s3-transport-types';
import { LibraryCloudError } from '@/features/library/library-cloud-errors';
import { LibraryLocalStorageError } from '@/features/library/library-file-decryptor';
import {
  downloadCategoryFor,
  transferFaultFor,
  viewFailureFor,
} from '@/features/library/library-transfer-fault';

describe('library transfer fault', () => {
  it('classifies a thrown transfer error by its cause', () => {
    expect(transferFaultFor(new S3TransportError(503, 'rate_limited', 'slow down', true)))
      .toEqual({ kind: 'cloud', category: 'offline' });
    expect(transferFaultFor(new S3TransportError(400, 'client', 'bad request', true)))
      .toEqual({ kind: 'cloud', category: 'integrity' });
    expect(transferFaultFor(new LibraryCloudError(0, 's3_local_write', 'local_space', 'disk full', true)))
      .toEqual({ kind: 'cloud', category: 'local_space' });
    expect(transferFaultFor(new LibraryCloudError(0, 's3_retry', 'retryable_transfer', 'again', false)))
      .toEqual({ kind: 'cloud', category: 'retryable_transfer' });
    expect(transferFaultFor(new LibraryLocalStorageError('disk full')))
      .toEqual({ kind: 'local-storage' });
    expect(transferFaultFor(new Error('dropped body')))
      .toEqual({ kind: 'unexpected' });
  });

  it('maps each fault into the download vocabulary and the view vocabulary', () => {
    const cases = [
      {
        fault: { kind: 'cloud' as const, category: 'local_space' as const },
        download: 'local_space' as const,
        view: { category: 'local_space' as const },
      },
      {
        fault: { kind: 'cloud' as const, category: 'retryable_transfer' as const },
        download: 'retryable_transfer' as const,
        view: { category: 'retryable_transfer' as const },
      },
      {
        fault: { kind: 'cloud' as const, category: 'offline' as const },
        download: 'offline' as const,
        view: { category: 'offline' as const },
      },
      {
        fault: { kind: 'local-storage' as const },
        download: 'local_space' as const,
        view: { category: 'retryable_transfer' as const },
      },
      {
        fault: { kind: 'missing' as const },
        download: 'object_missing' as const,
        view: { category: 'object_missing' as const },
      },
      {
        fault: { kind: 'integrity' as const, role: 'original' as const },
        download: 'integrity' as const,
        view: { category: 'integrity' as const, role: 'original' as const },
      },
      {
        fault: { kind: 'unexpected' as const },
        download: 'integrity' as const,
        view: { category: 'retryable_transfer' as const },
      },
    ];

    for (const entry of cases) {
      expect(downloadCategoryFor(entry.fault)).toBe(entry.download);
      expect(viewFailureFor(entry.fault)).toEqual(entry.view);
    }
  });
});
