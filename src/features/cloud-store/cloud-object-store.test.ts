import { LibraryCloudError } from '@/features/library/library-cloud-errors';

import {
  CloudStoreError,
  toLibraryCloudErrorFromStore,
  type CloudStoreFailureCategory,
} from './cloud-object-store';

describe('CloudStoreError → LibraryCloudError bridge (spec §4)', () => {
  test.each<[CloudStoreFailureCategory, string, number]>([
    ['auth', 'auth_attention', 401],
    ['network', 'offline', 0],
    ['rate_limited', 'offline', 429],
    ['server', 'offline', 500],
    ['not_found', 'object_missing', 404],
    ['client', 'integrity', 400],
    ['quota_full', 'quota_full', 507],
  ])('%s maps to %s', (category, expected, status) => {
    const bridged = toLibraryCloudErrorFromStore(
      new CloudStoreError(status, category, 'boom', true),
    );
    expect(bridged).toBeInstanceOf(LibraryCloudError);
    expect(bridged.category).toBe(expected);
    expect(bridged.code).toBe(`store_${category}`);
    expect(bridged.status).toBe(status);
  });

  test('outcomeKnown travels through unchanged (a mid-send cut must not read as "not applied")', () => {
    expect(
      toLibraryCloudErrorFromStore(
        new CloudStoreError(0, 'network', 'cut', false),
      ).outcomeKnown,
    ).toBe(false);
    expect(
      toLibraryCloudErrorFromStore(new CloudStoreError(401, 'auth', 'nope'))
        .outcomeKnown,
    ).toBe(true);
  });

  test('CloudStoreError is a real Error with a stable name', () => {
    const error = new CloudStoreError(429, 'rate_limited', 'slow down');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CloudStoreError');
    expect(error.message).toBe('slow down');
  });

  /**
   * Three hand-written adapters will throw these. A forgotten 4th argument
   * must fail SAFE — claiming "the remote refused, nothing landed" about a
   * request that may already have been applied is what lets a caller discard
   * durable intent for a write that actually happened.
   */
  describe('outcomeKnown defaults by category', () => {
    test.each<CloudStoreFailureCategory>(['network', 'server', 'rate_limited'])(
      '%s defaults to unknown: the request may have been applied before it failed',
      (category) => {
        expect(new CloudStoreError(0, category, 'x').outcomeKnown).toBe(false);
      },
    );

    test.each<CloudStoreFailureCategory>(
      ['auth', 'not_found', 'client', 'quota_full'],
    )('%s defaults to known: the remote answered and refused', (category) => {
      expect(new CloudStoreError(507, category, 'x').outcomeKnown).toBe(true);
    });

    test('an explicit argument still wins over the default', () => {
      expect(
        new CloudStoreError(0, 'network', 'x', true).outcomeKnown,
      ).toBe(true);
      expect(
        new CloudStoreError(401, 'auth', 'x', false).outcomeKnown,
      ).toBe(false);
    });
  });
});
