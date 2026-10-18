import {
  CollectionServiceError,
  classifyDownloadFailure,
  issueFromError,
  parseHttpStatus,
} from '@/features/collection/file-repository';

describe('CollectionServiceError.httpStatus', () => {
  test('is null unless a status was actually observed', () => {
    expect(new CollectionServiceError('download_failed', 'x').httpStatus).toBeNull();
  });

  test('carries the status the failing path saw', () => {
    expect(
      new CollectionServiceError('download_failed', 'x', { httpStatus: 404 }).httpStatus,
    ).toBe(404);
  });
});

describe('classifyDownloadFailure', () => {
  test('a 404 or 410 the range probe reported means the source deleted the image', () => {
    expect(classifyDownloadFailure(
      new CollectionServiceError('download_failed', 'x', { httpStatus: 404 }),
    )).toBe('source_gone');
    expect(classifyDownloadFailure(
      new CollectionServiceError('download_failed', 'x', { httpStatus: 410 }),
    )).toBe('source_gone');
  });

  test("reads the status out of expo-file-system's own rejection message", () => {
    expect(classifyDownloadFailure(new Error('Unable to download a file: HTTP 404')))
      .toBe('source_gone');
  });

  test('reads the status out of the cause the file repository wrapped', () => {
    expect(classifyDownloadFailure(new CollectionServiceError(
      'download_failed',
      'This image could not be saved offline.',
      { cause: new Error('Unable to download a file: HTTP 410') },
    ))).toBe('source_gone');
  });

  test('every other status is worth retrying', () => {
    for (const httpStatus of [401, 403, 429, 500, 503]) {
      expect(classifyDownloadFailure(
        new CollectionServiceError('download_failed', 'x', { httpStatus }),
      )).toBe('transient');
    }
  });

  test('a status the failing path observed decides outright, whatever the cause says', () => {
    // The explicit field is the status the transport actually saw. A message
    // underneath it is only ever the fallback for a failure that carried no
    // field at all, so it must not be able to overturn one that did.
    expect(classifyDownloadFailure(new CollectionServiceError('download_failed', 'x', {
      httpStatus: 503,
      cause: new Error('Unable to download a file: HTTP 404'),
    }))).toBe('transient');
    expect(classifyDownloadFailure(new CollectionServiceError('download_failed', 'x', {
      httpStatus: 404,
      cause: new Error('Unable to download a file: HTTP 503'),
    }))).toBe('source_gone');
  });

  test('a failure with no status at all is transient', () => {
    expect(classifyDownloadFailure(new Error('Network request failed'))).toBe('transient');
    expect(classifyDownloadFailure(new CollectionServiceError(
      'download_failed',
      'This image download was cancelled.',
    ))).toBe('transient');
  });

  test('an unrecognisable error shape is transient rather than a guess', () => {
    expect(classifyDownloadFailure(undefined)).toBe('transient');
    expect(classifyDownloadFailure(null)).toBe('transient');
    expect(classifyDownloadFailure('offline')).toBe('transient');
    expect(classifyDownloadFailure({ status: 404 })).toBe('transient');
  });

  test('does not read a 404 out of a longer number', () => {
    expect(classifyDownloadFailure(new Error('Unable to download a file: HTTP 4040')))
      .toBe('transient');
  });
});

describe('parseHttpStatus', () => {
  test('reads the three-digit status expo-file-system puts in its message', () => {
    expect(parseHttpStatus(new Error('Unable to download a file: HTTP 503'))).toBe(503);
  });

  test('reads the status out of a wrapped cause', () => {
    expect(parseHttpStatus(new CollectionServiceError('download_failed', 'wrapped', {
      cause: new Error('Unable to download a file: HTTP 404'),
    }))).toBe(404);
  });

  test('reports nothing when the message carries no status', () => {
    expect(parseHttpStatus(new Error('Network request failed'))).toBeUndefined();
    expect(parseHttpStatus(new Error('Unable to download a file: HTTP 4040'))).toBeUndefined();
    expect(parseHttpStatus(null)).toBeUndefined();
  });
});

describe('issueFromError', () => {
  test('carries the kind on a download failure so the caller can store it', () => {
    expect(issueFromError(
      new CollectionServiceError('download_failed', 'gone', { httpStatus: 410 }),
      'download_failed',
      'This image could not be saved offline.',
    )).toEqual({ code: 'download_failed', message: 'gone', kind: 'source_gone' });
  });

  test('classifies an untyped download failure as transient', () => {
    expect(issueFromError(new Error('offline'), 'download_failed', 'fallback'))
      .toEqual({ code: 'download_failed', message: 'fallback', kind: 'transient' });
  });

  test('leaves the kind off an issue that is not a download failure', () => {
    expect(issueFromError(
      new Error('boom'),
      'delete_failed',
      'The saved file could not be deleted.',
    )).toEqual({
      code: 'delete_failed',
      message: 'The saved file could not be deleted.',
    });
  });
});
