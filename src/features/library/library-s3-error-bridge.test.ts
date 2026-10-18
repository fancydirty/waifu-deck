import { S3TransportError } from '@/features/byos/s3-transport-types';
import { isKnownNotApplied, LibraryCloudError } from '@/features/library/library-cloud-errors';
import {
  classifyS3TransportError,
  toLibraryCloudError,
} from '@/features/library/library-s3-error-bridge';
import { isHaltingErrorCode } from '@/features/library/library-sync-outbox';

describe('classifyS3TransportError', () => {
  const cases: readonly [
    label: string,
    error: S3TransportError,
    expected: ReturnType<typeof classifyS3TransportError>,
  ][] = [
    ['credential/401', new S3TransportError(401, 'credential', 'unauthorized'), 'auth_attention'],
    ['credential/403', new S3TransportError(403, 'credential', 'forbidden'), 'auth_attention'],
    ['network/0 (no response)', new S3TransportError(0, 'network', 'offline', false), 'offline'],
    ['rate_limited/429', new S3TransportError(429, 'rate_limited', 'slow down'), 'offline'],
    ['rate_limited/503', new S3TransportError(503, 'rate_limited', 'unavailable'), 'offline'],
    ['server/500', new S3TransportError(500, 'server', 'internal'), 'offline'],
    ['server/502', new S3TransportError(502, 'server', 'bad gateway'), 'offline'],
    ['not_found/404', new S3TransportError(404, 'not_found', 'missing'), 'object_missing'],
    ['precondition/412', new S3TransportError(412, 'precondition', 'cas lost'), 'stale_client'],
    ['precondition/409', new S3TransportError(409, 'precondition', 'conflict'), 'stale_client'],
    ['client/400', new S3TransportError(400, 'client', 'bad request'), 'integrity'],
  ];

  it.each(cases)('%s -> %s', (_label, error, expected) => {
    expect(classifyS3TransportError(error)).toBe(expected);
  });

  // Load-bearing: a credential failure must map to a halting category, not a
  // retryable one, or a bad key/secret would retry forever instead of
  // stopping for the user to fix their bucket config.
  it('classifies credential/403 as the halting-capable auth_attention category', () => {
    const category = classifyS3TransportError(
      new S3TransportError(403, 'credential', 'forbidden'),
    );
    expect(category).toBe('auth_attention');
    expect(isHaltingErrorCode(category)).toBe(true);
  });
});

describe('toLibraryCloudError', () => {
  it('produces a LibraryCloudError the engine\'s instanceof checks accept', () => {
    const source = new S3TransportError(403, 'credential', 'forbidden');
    const adapted = toLibraryCloudError(source);
    expect(adapted).toBeInstanceOf(LibraryCloudError);
    expect(adapted.status).toBe(403);
    expect(adapted.category).toBe('auth_attention');
    expect(adapted.message).toBe('forbidden');
  });

  it('preserves outcomeKnown:true for a refused (nothing-written) write', () => {
    const source = new S3TransportError(412, 'precondition', 'cas lost', true);
    const adapted = toLibraryCloudError(source);
    expect(adapted.outcomeKnown).toBe(true);
    expect(isKnownNotApplied(adapted)).toBe(true);
  });

  // Load-bearing: a write whose transport outcome is unknown (e.g. a 5xx or
  // a network cut that may have landed before failing) must not be treated
  // as "known not applied" after the bridge — otherwise a caller could
  // discard durable intent for a mutation that actually committed.
  it('keeps an outcomeKnown:false write failure retryable, not known-not-applied', () => {
    const source = new S3TransportError(500, 'server', 'internal', false);
    const adapted = toLibraryCloudError(source);
    expect(adapted.category).toBe('offline');
    expect(adapted.outcomeKnown).toBe(false);
    expect(isKnownNotApplied(adapted)).toBe(false);
  });

  it('keeps a network-cut-before-response failure outcomeKnown:false', () => {
    const source = new S3TransportError(0, 'network', 'no response', false);
    const adapted = toLibraryCloudError(source);
    expect(adapted.outcomeKnown).toBe(false);
    expect(isKnownNotApplied(adapted)).toBe(false);
  });
});
