import type {
  LibraryLifecycle,
  LibraryProtection,
} from '@/features/library/library-actions-types';
import type { LibraryResidency } from '@/features/library/library-types';

export type LibraryWorldAsset = Readonly<{
  assetId: string;
  generation: number;
  revision: number;
  lifecycle: LibraryLifecycle;
  protection: LibraryProtection;
  originalGenerationId: string | null;
  thumbnailGenerationId: string | null;
  previewGenerationId: string | null;
}>;

export type LibraryWorldDeviceAsset = Readonly<{
  assetId: string;
  generation: number;
  residency: LibraryResidency;
  /** Retained 30-day device-trash bytes still count as a reliable original. */
  deviceTrashed: boolean;
  /** The cloud generation this device proved by decrypt-and-hash, if any. */
  verifiedGenerationId: string | null;
  /** A provider URL is never a substitute for an original. */
  hasProviderUrl: boolean;
}>;

export type LibraryWorld = Readonly<{
  revision: number;
  quotaCharges: number;
  assets: Readonly<Record<string, LibraryWorldAsset>>;
  devices: Readonly<Record<string, Readonly<Record<string, LibraryWorldDeviceAsset>>>>;
  knownRevision: Readonly<Record<string, number>>;
}>;

export type LibraryTransition =
  | Readonly<{ kind: 'collect'; deviceId: string; assetId: string }>
  | Readonly<{
      kind: 'protect-commit';
      deviceId: string;
      assetId: string;
      originalGenerationId: string;
    }>
  | Readonly<{ kind: 'protect-verify'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'protect-fail'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'download'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'stop-protection'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'trash'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'restore'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'permanent-delete'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 're-import'; deviceId: string; assetId: string }>
  | Readonly<{ kind: 'sync'; deviceId: string; assetId?: string }>;

export type LibraryTransitionRejection =
  | 'not_found'
  | 'not_protected'
  | 'not_verified'
  | 'no_safe_local_copy'
  | 'object_missing'
  | 'purged_permanently'
  | 'trash_wins'
  | 'not_trash'
  | 'already_local'
  | 'stale_device';

export type LibraryTransitionResult =
  | Readonly<{ status: 'applied'; world: LibraryWorld }>
  | Readonly<{ status: 'merged'; world: LibraryWorld }>
  | Readonly<{
      status: 'rejected';
      reason: LibraryTransitionRejection;
      world: LibraryWorld;
    }>;

export function initialLibraryWorld(
  deviceIds: readonly string[],
): LibraryWorld {
  const devices: Record<string, Record<string, LibraryWorldDeviceAsset>> = {};
  const knownRevision: Record<string, number> = {};
  for (const deviceId of deviceIds) {
    devices[deviceId] = {};
    knownRevision[deviceId] = 0;
  }
  return {
    revision: 0,
    quotaCharges: 0,
    assets: {},
    devices,
    knownRevision,
  };
}

/**
 * How many independently reliable originals exist for one asset: every device
 * that holds a permanent local original (including retained device trash) plus
 * the Cloud Vault original only when protection is fully verified. Pending
 * commit is not yet reliable. Derived thumbnails, previews, bounded caches,
 * and provider URLs are deliberately excluded.
 */
export function reliableOriginalCount(
  world: LibraryWorld,
  assetId: string,
): number {
  let count = 0;
  const asset = world.assets[assetId];
  if (
    asset !== undefined
    && asset.lifecycle !== 'purged'
    && asset.originalGenerationId !== null
    && asset.protection === 'protected'
  ) {
    count += 1;
  }
  for (const assetsOnDevice of Object.values(world.devices)) {
    const device = assetsOnDevice[assetId];
    if (device !== undefined && device.residency === 'local-original') {
      count += 1;
    }
  }
  return count;
}

function withDeviceAsset(
  world: LibraryWorld,
  deviceId: string,
  assetId: string,
  next: LibraryWorldDeviceAsset | null,
): LibraryWorld {
  const current = { ...(world.devices[deviceId] ?? {}) };
  if (next === null) delete current[assetId];
  else current[assetId] = next;
  return { ...world, devices: { ...world.devices, [deviceId]: current } };
}

function withAsset(
  world: LibraryWorld,
  assetId: string,
  next: LibraryWorldAsset,
  actingDeviceId?: string,
): LibraryWorld {
  const revision = world.revision + 1;
  const knownRevision = { ...world.knownRevision };
  // The device that just wrote the account mutation already knows it; other
  // devices remain stale until they sync.
  if (actingDeviceId !== undefined) {
    knownRevision[actingDeviceId] = revision;
  }
  return {
    ...world,
    revision,
    assets: { ...world.assets, [assetId]: { ...next, revision } },
    knownRevision,
  };
}

function reject(
  world: LibraryWorld,
  reason: LibraryTransitionRejection,
): LibraryTransitionResult {
  return { status: 'rejected', reason, world };
}

export function applyLibraryTransition(
  world: LibraryWorld,
  transition: LibraryTransition,
): LibraryTransitionResult {
  if (transition.kind === 'sync') {
    const synced: LibraryWorld = {
      ...world,
      knownRevision: {
        ...world.knownRevision,
        [transition.deviceId]: world.revision,
      },
    };
    return { status: 'applied', world: synced };
  }

  const { assetId, deviceId } = transition;
  const asset = world.assets[assetId];
  const device = world.devices[deviceId]?.[assetId];
  const stale = (world.knownRevision[deviceId] ?? 0) < (asset?.revision ?? 0);

  if (transition.kind === 'collect') {
    if (asset === undefined) {
      const created = withAsset(
        world,
        assetId,
        {
          assetId,
          generation: 1,
          revision: 0,
          lifecycle: 'active',
          protection: 'unprotected',
          originalGenerationId: null,
          thumbnailGenerationId: null,
          previewGenerationId: null,
        },
        deviceId,
      );
      return {
        status: 'applied',
        world: withDeviceAsset(created, deviceId, assetId, {
          assetId,
          generation: 1,
          residency: 'local-original',
          deviceTrashed: false,
          verifiedGenerationId: null,
          hasProviderUrl: false,
        }),
      };
    }
    if (asset.lifecycle === 'purged') return reject(world, 'purged_permanently');
    if (asset.lifecycle === 'trash') return reject(world, 'trash_wins');
    // Identical bytes collected again: one account asset, both devices may keep
    // a local original, and no second quota charge is ever created.
    return {
      status: 'merged',
      world: withDeviceAsset(world, deviceId, assetId, {
        assetId,
        generation: asset.generation,
        residency: 'local-original',
        deviceTrashed: device?.deviceTrashed ?? false,
        verifiedGenerationId: device?.verifiedGenerationId ?? null,
        hasProviderUrl: device?.hasProviderUrl ?? false,
      }),
    };
  }

  if (asset === undefined) return reject(world, 'not_found');
  if (
    asset.lifecycle === 'purged'
    && transition.kind !== 'permanent-delete'
    && transition.kind !== 're-import'
  ) {
    return reject(world, 'purged_permanently');
  }

  if (transition.kind === 're-import') {
    if (asset.lifecycle !== 'purged') return reject(world, 'not_found');
    // Explicit import of the same bytes is allowed only after a full current
    // sync; otherwise it would resurrect a purge the device has not seen.
    if ((world.knownRevision[deviceId] ?? 0) < world.revision) {
      return reject(world, 'stale_device');
    }
    const generation = asset.generation + 1;
    const imported = withAsset(
      world,
      assetId,
      {
        ...asset,
        generation,
        lifecycle: 'active',
        protection: 'unprotected',
        originalGenerationId: null,
        thumbnailGenerationId: null,
        previewGenerationId: null,
      },
      deviceId,
    );
    return {
      status: 'applied',
      world: withDeviceAsset(imported, deviceId, assetId, {
        assetId,
        generation,
        residency: 'local-original',
        deviceTrashed: false,
        verifiedGenerationId: null,
        hasProviderUrl: false,
      }),
    };
  }

  if (transition.kind === 'protect-commit') {
    if (asset.lifecycle !== 'active') return reject(world, 'trash_wins');
    if (device === undefined || device.residency !== 'local-original') {
      return reject(world, 'no_safe_local_copy');
    }
    // Already verified, or already committed and awaiting verify: idempotent.
    if (asset.protection === 'protected') return { status: 'merged', world };
    if (asset.protection === 'pending' && asset.originalGenerationId !== null) {
      return { status: 'merged', world };
    }
    const charged = asset.originalGenerationId === null
      ? world.quotaCharges + 1
      : world.quotaCharges;
    const committed = withAsset(
      { ...world, quotaCharges: charged },
      assetId,
      {
        ...asset,
        protection: 'pending',
        originalGenerationId: transition.originalGenerationId,
      },
      deviceId,
    );
    return { status: 'applied', world: committed };
  }

  if (transition.kind === 'protect-verify') {
    if (asset.protection !== 'pending' || asset.originalGenerationId === null) {
      return reject(world, 'not_protected');
    }
    if (device === undefined) return reject(world, 'not_found');
    const verified = withAsset(
      world,
      assetId,
      { ...asset, protection: 'protected' },
      deviceId,
    );
    return {
      status: 'applied',
      world: withDeviceAsset(verified, deviceId, assetId, {
        ...device,
        verifiedGenerationId: asset.originalGenerationId,
      }),
    };
  }

  if (transition.kind === 'protect-fail') {
    // Already past decrypt-and-hash proof: leave the verified protected state.
    if (asset.protection === 'protected') return { status: 'merged', world };
    // Pending commit (or unprotected attempt) failed: keep the local original.
    return {
      status: 'applied',
      world: withAsset(
        world,
        assetId,
        { ...asset, protection: 'failed' },
        deviceId,
      ),
    };
  }

  if (transition.kind === 'download') {
    if (asset.protection !== 'protected' || asset.originalGenerationId === null) {
      return reject(world, 'object_missing');
    }
    if (device !== undefined && device.residency === 'local-original') {
      return reject(world, 'already_local');
    }
    return {
      status: 'applied',
      world: withDeviceAsset(world, deviceId, assetId, {
        assetId,
        generation: asset.generation,
        residency: 'local-original',
        deviceTrashed: false,
        verifiedGenerationId: asset.originalGenerationId,
        hasProviderUrl: device?.hasProviderUrl ?? false,
      }),
    };
  }

  if (transition.kind === 'stop-protection') {
    if (asset.protection !== 'protected') return { status: 'merged', world };
    if (
      device === undefined
      || device.residency !== 'local-original'
      || device.verifiedGenerationId !== asset.originalGenerationId
    ) {
      return reject(world, 'no_safe_local_copy');
    }
    return {
      status: 'applied',
      world: withAsset(
        world,
        assetId,
        {
          ...asset,
          protection: 'unprotected',
          originalGenerationId: null,
        },
        deviceId,
      ),
    };
  }

  if (transition.kind === 'trash') {
    if (asset.lifecycle !== 'active') return { status: 'merged', world };
    if (stale) return reject(world, 'stale_device');
    const trashed = withAsset(
      world,
      assetId,
      { ...asset, lifecycle: 'trash' },
      deviceId,
    );
    if (device === undefined) return { status: 'applied', world: trashed };
    // Remove does not evict: an unprotected original is retained in the
    // app-private device trash for the same 30-day window.
    return {
      status: 'applied',
      world: withDeviceAsset(trashed, deviceId, assetId, {
        ...device,
        deviceTrashed:
          asset.protection === 'protected' ? device.deviceTrashed : true,
      }),
    };
  }

  if (transition.kind === 'restore') {
    if (asset.lifecycle !== 'trash') return { status: 'merged', world };
    if (stale) return reject(world, 'stale_device');
    const restored = withAsset(
      world,
      assetId,
      {
        ...asset,
        lifecycle: 'active',
        generation: asset.generation + 1,
      },
      deviceId,
    );
    if (device === undefined) return { status: 'applied', world: restored };
    return {
      status: 'applied',
      world: withDeviceAsset(restored, deviceId, assetId, {
        ...device,
        generation: asset.generation + 1,
        deviceTrashed: false,
      }),
    };
  }

  // permanent-delete: the only intentional destruction of a final original.
  if (asset.lifecycle === 'purged') return { status: 'merged', world };
  if (asset.lifecycle !== 'trash') return reject(world, 'not_trash');
  let purged = withAsset(
    world,
    assetId,
    {
      ...asset,
      lifecycle: 'purged',
      protection: 'unprotected',
      originalGenerationId: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
    },
    deviceId,
  );
  for (const otherDeviceId of Object.keys(world.devices)) {
    purged = withDeviceAsset(purged, otherDeviceId, assetId, null);
  }
  return { status: 'applied', world: purged };
}

/**
 * The design's non-negotiable invariants, expressed over one transition. A
 * non-null result is the violated invariant and fails the test suite.
 */
export function findLibraryInvariantViolation(
  previous: LibraryWorld,
  next: LibraryWorld,
  transition: LibraryTransition,
): string | null {
  const assetIds = new Set([
    ...Object.keys(previous.assets),
    ...Object.keys(next.assets),
  ]);

  for (const assetId of assetIds) {
    const before = reliableOriginalCount(previous, assetId);
    const after = reliableOriginalCount(next, assetId);
    if (before > 0 && after === 0 && transition.kind !== 'permanent-delete') {
      return `invariant 3: ${transition.kind} destroyed the final reliable original of ${assetId}`;
    }
    if (
      next.assets[assetId] !== undefined
      && next.assets[assetId]!.lifecycle !== 'purged'
      && after === 0
      && before > 0
    ) {
      return `invariant 3: ${assetId} has no reliable original while still in the library`;
    }
  }

  for (const [deviceId, assetsOnDevice] of Object.entries(next.devices)) {
    for (const [assetId, device] of Object.entries(assetsOnDevice)) {
      const was = previous.devices[deviceId]?.[assetId];
      if (
        was?.residency === 'local-original'
        && device.residency === 'cloud-only'
      ) {
        const asset = next.assets[assetId];
        if (
          asset === undefined
          || asset.protection !== 'protected'
          || asset.originalGenerationId === null
          || device.verifiedGenerationId !== asset.originalGenerationId
        ) {
          return `invariant 4: ${deviceId} evicted ${assetId} without a committed, verified original`;
        }
      }
    }
  }

  if (transition.kind === 'trash') {
    for (const [deviceId, assetsOnDevice] of Object.entries(previous.devices)) {
      for (const [assetId, device] of Object.entries(assetsOnDevice)) {
        if (device.residency !== 'local-original') continue;
        const after = next.devices[deviceId]?.[assetId];
        if (after === undefined || after.residency !== 'local-original') {
          return `invariant 6: remove deleted ${deviceId}'s local original of ${assetId}`;
        }
      }
    }
  }

  if (next.quotaCharges - previous.quotaCharges > 1) {
    return 'invariant 8: one transition charged quota more than once';
  }

  for (const [assetId, asset] of Object.entries(next.assets)) {
    if (
      asset.protection === 'protected'
      && asset.originalGenerationId === null
    ) {
      return `invariant 9: ${assetId} claims protection from a derived object`;
    }
  }

  for (const assetsOnDevice of Object.values(next.devices)) {
    for (const [assetId, device] of Object.entries(assetsOnDevice)) {
      if (
        device.hasProviderUrl
        && device.residency !== 'local-original'
        && reliableOriginalCount(next, assetId) === 0
        && next.assets[assetId] !== undefined
        && next.assets[assetId]!.lifecycle !== 'purged'
      ) {
        return `invariant 10: a provider URL stood in for the missing original of ${assetId}`;
      }
    }
  }

  return null;
}
