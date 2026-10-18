import type {
  LibraryObjectRole,
  LibraryRenderIntent,
} from '@/features/library/library-actions-types';

export type LibraryRenderTier =
  | 'local-original'
  | 'local-thumbnail'
  | 'cached-thumbnail'
  | 'cloud-thumbnail'
  | 'cached-preview'
  | 'cloud-preview'
  | 'cached-original'
  | 'cloud-original';

/** Everything the decision needs. No database, network, or file access. */
export type LibraryRenderState = Readonly<{
  /** A durable original this device has, not missing, at `local-original`. */
  hasLocalOriginal: boolean;
  /** The device row names a durable thumbnail; its file is checked when the tier is reached. */
  hasLocalThumbnail: boolean;
  thumbnail: string | null;
  preview: string | null;
  original: string | null;
  /** Derived variants of an animated source are a single still frame. */
  animated: boolean;
}>;

/**
 * Design § Viewing And Cache Behavior.
 *
 * `grid` is **thumbnail-only**: a local original, else this device's durable
 * thumbnail, else the thumbnail object. It deliberately lists no `preview`
 * and no `original` tier, because scrolling must never pull screen-sized or
 * full-sized bytes. An asset with no thumbnail object and no durable local
 * thumbnail therefore has no grid tier beyond a local original, and the
 * resolver turns that into the explicit unavailable/placeholder state.
 * Regenerating a missing derived variant is the separate explicit
 * `repairDerived` path.
 *
 * `detail` deliberately does **not** list the cloud original as a fallback
 * for a failed preview fetch. It lists an original tier when a local original
 * is on the device, when no preview object exists at all, or when the source
 * is animated and a still frame would misrepresent the artwork.
 *
 * `local-thumbnail` (board #27 S2, spec §5.9) is this phone's own durable
 * thumbnail: `grid`'s second tier ahead of the cloud, `detail`'s last resort
 * (role `thumbnail`), and never a `full` tier.
 *
 * `placeholder` (board rows 48–49) returns before the `local-original` push.
 * It lists this device's thumbnail, then a cached thumbnail, and nothing else.
 */
export function tiersFor(
  intent: LibraryRenderIntent,
  state: LibraryRenderState,
): readonly LibraryRenderTier[] {
  const tiers: LibraryRenderTier[] = [];
  if (intent === 'placeholder') {
    if (state.hasLocalThumbnail) tiers.push('local-thumbnail');
    if (state.thumbnail !== null) tiers.push('cached-thumbnail');
    return tiers;
  }
  if (state.hasLocalOriginal) tiers.push('local-original');

  if (intent === 'grid') {
    // Spec §5.9: this phone's own thumbnail before any cloud one.
    if (state.hasLocalThumbnail) tiers.push('local-thumbnail');
    // Thumbnail-only. No preview or original tier may appear here: a missing
    // thumbnail object is an explicit placeholder, never a bigger download
    // during a scroll.
    if (state.thumbnail !== null) tiers.push('cached-thumbnail', 'cloud-thumbnail');
    return tiers;
  }

  const preferPreview = intent === 'detail'
    && state.preview !== null
    && !state.animated;
  if (preferPreview) {
    tiers.push('cached-preview', 'cloud-preview');
  } else if (state.original !== null) {
    tiers.push('cached-original', 'cloud-original');
  }
  // Spec §5.9: a detail's last resort, returned as role 'thumbnail'. Never for
  // `full`: a share must never send a thumbnail.
  if (intent === 'detail' && state.hasLocalThumbnail) tiers.push('local-thumbnail');
  return tiers;
}

/** S2: exactly one role's cached and cloud tiers (the role reader). */
export function tiersForRole(
  role: LibraryObjectRole,
  state: LibraryRenderState,
): readonly LibraryRenderTier[] {
  const generation = role === 'thumbnail'
    ? state.thumbnail
    : role === 'preview'
      ? state.preview
      : state.original;
  const cached = `cached-${role}` as const;
  return generation === null ? [cached] : [cached, `cloud-${role}` as const];
}
