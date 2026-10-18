import type { ByosStatus } from '@/features/byos/byos-context-resolver';
import type { LibraryFailureCategory } from '@/features/library/library-actions-types';

/**
 * Board #27 S4 (spec §5.2, §5.12): where this composition's cloud library
 * stands. A render result cannot tell offline from locked (both answer the
 * local thumbnail), so the viewer's note and the unavailable words read this.
 */
export type LibraryAccess = 'ready' | 'offline' | 'locked' | 'disconnected';

/** The "offline" rule is `localUnavailableCategoryFor`'s. Undefined only in test doubles. */
export function libraryAccessFor(status: ByosStatus | undefined): LibraryAccess {
  if (status === undefined || status.status === 'ready') return 'ready';
  if (status.status === 'unconfigured') return 'disconnected';
  return status.reason === 'vault_unreachable' && status.detail === 'network' ? 'offline' : 'locked';
}

export type LibraryUnavailableCopy = Readonly<{
  /** The testID segment (`gallery-image-<kind>-<id>`, `library-asset-<kind>-<sha>`); unchanged since K3. */
  kind: 'offline' | 'locked' | 'unavailable';
  title:
    | 'libraryView.offlineTitle'
    | 'libraryView.lockedTitle'
    | 'libraryView.disconnectedTitle'
    | 'libraryView.missingMessage'
    | 'libraryView.integrityMessage';
  detail: 'libraryView.offlineMessage' | null;
}>;

export function unavailableCopyFor(
  category: LibraryFailureCategory,
  access: LibraryAccess,
): LibraryUnavailableCopy {
  if (category === 'offline') {
    return { kind: 'offline', title: 'libraryView.offlineTitle', detail: 'libraryView.offlineMessage' };
  }
  if (category === 'auth_attention') {
    // Spec §5.2: a disconnected phone has nothing to unlock; reconnecting brings the image back.
    return {
      kind: 'locked',
      title: access === 'disconnected' ? 'libraryView.disconnectedTitle' : 'libraryView.lockedTitle',
      detail: null,
    };
  }
  // Spec §5.2: no cloud original is known, so only the source can bring it back (修复).
  if (category === 'object_missing') return { kind: 'unavailable', title: 'libraryView.missingMessage', detail: null };
  return { kind: 'unavailable', title: 'libraryView.integrityMessage', detail: null };
}

export type LibraryThumbnailNoteKey =
  | 'libraryView.thumbnailNote.offline'
  | 'libraryView.thumbnailNote.locked'
  | 'libraryView.thumbnailNote.disconnected';

/**
 * Spec §5.12 (O2): the line under a detail page that shows the local thumbnail.
 * A ready composition serves it only after the cloud tiers failed, which the
 * locked words ("can't reach your cloud library") describe truthfully.
 */
export function thumbnailNoteKey(access: LibraryAccess): LibraryThumbnailNoteKey {
  if (access === 'offline') return 'libraryView.thumbnailNote.offline';
  if (access === 'disconnected') return 'libraryView.thumbnailNote.disconnected';
  return 'libraryView.thumbnailNote.locked';
}
