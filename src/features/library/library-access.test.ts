import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import {
  libraryAccessFor,
  thumbnailNoteKey,
  unavailableCopyFor,
  type LibraryAccess,
} from '@/features/library/library-access';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';
import { localUnavailableCategoryFor } from '@/features/library/library-local-view';

const READY = { status: 'ready', context: {} } as unknown as ByosStatus;
const STATUSES: readonly (readonly [string, ByosStatus | undefined, LibraryAccess])[] = [
  ['ready', READY, 'ready'],
  ['unconfigured', { status: 'unconfigured' }, 'disconnected'],
  [
    'locked / vault_unreachable / network',
    { status: 'locked', reason: 'vault_unreachable', detail: 'network' },
    'offline',
  ],
  [
    'locked / vault_unreachable / credential_rejected',
    { status: 'locked', reason: 'vault_unreachable', detail: 'credential_rejected' },
    'locked',
  ],
  [
    'locked / vault_unreachable / reauth_required',
    {
      status: 'locked',
      reason: 'vault_unreachable',
      detail: 'reauth_required',
      provider: 'google',
    } as unknown as ByosStatus,
    'locked',
  ],
  [
    'locked / meta_corrupt',
    { status: 'locked', reason: 'meta_corrupt', detail: 'invalid' } as unknown as ByosStatus,
    'locked',
  ],
  [
    'locked / password_required',
    { status: 'locked', reason: 'password_required' } as unknown as ByosStatus,
    'locked',
  ],
  ['undefined', undefined, 'ready'],
];

describe('libraryAccessFor', () => {
  test.each(STATUSES)('access per status: %s', (_name, status, expected) => {
    expect(libraryAccessFor(status)).toBe(expected);
  });

  test.each(STATUSES)('offline agrees with the local category: %s', (_name, status) => {
    expect(libraryAccessFor(status) === 'offline')
      .toBe(localUnavailableCategoryFor(status) === 'offline');
  });
});

describe('unavailableCopyFor', () => {
  const ACCESSES: readonly LibraryAccess[] = ['ready', 'offline', 'locked', 'disconnected'];

  test.each(ACCESSES)('offline says offline whatever the access (%s)', (access) => {
    expect(unavailableCopyFor('offline', access)).toEqual({
      kind: 'offline',
      title: 'libraryView.offlineTitle',
      detail: 'libraryView.offlineMessage',
    });
  });

  test('a disconnected phone is told to reconnect, not to unlock', () => {
    expect(unavailableCopyFor('auth_attention', 'disconnected')).toEqual({
      kind: 'locked',
      title: 'libraryView.disconnectedTitle',
      detail: null,
    });
  });

  test.each(['locked', 'ready', 'offline'] as const)(
    'auth_attention keeps the locked words when the access is %s',
    (access) => {
      expect(unavailableCopyFor('auth_attention', access)).toEqual({
        kind: 'locked',
        title: 'libraryView.lockedTitle',
        detail: null,
      });
    },
  );

  test('object_missing says the original is gone', () => {
    expect(unavailableCopyFor('object_missing', 'ready')).toEqual({
      kind: 'unavailable',
      title: 'libraryView.missingMessage',
      detail: null,
    });
  });

  test.each(['integrity', 'retryable_transfer'] as LibraryFailureCategory[])(
    '%s keeps the integrity words',
    (category) => {
      expect(unavailableCopyFor(category, 'ready')).toEqual({
        kind: 'unavailable',
        title: 'libraryView.integrityMessage',
        detail: null,
      });
    },
  );
});

describe('thumbnailNoteKey', () => {
  test.each([
    ['offline', 'libraryView.thumbnailNote.offline'],
    ['disconnected', 'libraryView.thumbnailNote.disconnected'],
    ['ready', 'libraryView.thumbnailNote.locked'],
    ['locked', 'libraryView.thumbnailNote.locked'],
  ] as const)('note per access: %s', (access, key) => {
    expect(thumbnailNoteKey(access)).toBe(key);
  });
});
