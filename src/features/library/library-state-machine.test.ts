import {
  applyLibraryTransition,
  findLibraryInvariantViolation,
  initialLibraryWorld,
  reliableOriginalCount,
  type LibraryTransition,
  type LibraryWorld,
} from '@/features/library/library-state-machine';

const ASSET = 'a'.repeat(64);
const GENERATION_ID = '11111111-1111-4111-8111-111111111111';

function run(
  world: LibraryWorld,
  transitions: readonly LibraryTransition[],
): LibraryWorld {
  let current = world;
  for (const transition of transitions) {
    const result = applyLibraryTransition(current, transition);
    const violation = findLibraryInvariantViolation(
      current,
      result.world,
      transition,
    );
    expect(violation).toBeNull();
    current = result.world;
  }
  return current;
}

const collectOnA: LibraryTransition = {
  kind: 'collect',
  deviceId: 'A',
  assetId: ASSET,
};
const protectCommitOnA: LibraryTransition = {
  kind: 'protect-commit',
  deviceId: 'A',
  assetId: ASSET,
  originalGenerationId: GENERATION_ID,
};
const verifyOnA: LibraryTransition = {
  kind: 'protect-verify',
  deviceId: 'A',
  assetId: ASSET,
};

describe('library state machine', () => {
  it('marks protect-fail as failed after commit without counting the cloud original', () => {
    const committed = run(initialLibraryWorld(['A']), [
      collectOnA,
      protectCommitOnA,
    ]);
    expect(committed.assets[ASSET]?.protection).toBe('pending');
    expect(committed.devices.A[ASSET]?.residency).toBe('local-original');

    const failed = applyLibraryTransition(committed, {
      kind: 'protect-fail',
      deviceId: 'A',
      assetId: ASSET,
    });
    expect(failed.status).toBe('applied');
    expect(failed.world.assets[ASSET]?.protection).toBe('failed');
    expect(failed.world.devices.A[ASSET]?.residency).toBe('local-original');
    // Local original only — pending/failed cloud commit is not reliable.
    expect(reliableOriginalCount(failed.world, ASSET)).toBe(1);
  });

  it('treats remove as trash, and keeps the local original', () => {
    const world = run(initialLibraryWorld(['A']), [collectOnA]);
    const trashed = applyLibraryTransition(world, {
      kind: 'trash',
      deviceId: 'A',
      assetId: ASSET,
    });
    expect(trashed.status).toBe('applied');
    expect(trashed.world.assets[ASSET]?.lifecycle).toBe('trash');
    expect(trashed.world.devices.A[ASSET]?.residency).toBe('local-original');
    expect(trashed.world.devices.A[ASSET]?.deviceTrashed).toBe(true);
    expect(reliableOriginalCount(trashed.world, ASSET)).toBe(1);
  });

  it('requires a proved local copy before stopping protection', () => {
    const verified = run(initialLibraryWorld(['A', 'B']), [
      collectOnA,
      protectCommitOnA,
      verifyOnA,
    ]);
    // C4b deleted the `free-space` transition, so the cloud-only device state
    // it used to reach is built directly here. The rule under test is
    // unchanged: a device holding no local original cannot stop protection.
    const world: LibraryWorld = {
      ...verified,
      devices: {
        ...verified.devices,
        A: {
          ...verified.devices.A,
          [ASSET]: {
            ...verified.devices.A[ASSET]!,
            residency: 'cloud-only',
          },
        },
      },
    };
    expect(
      applyLibraryTransition(world, {
        kind: 'stop-protection',
        deviceId: 'A',
        assetId: ASSET,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'no_safe_local_copy' });

    const downloaded = run(world, [
      { kind: 'download', deviceId: 'A', assetId: ASSET },
    ]);
    const stopped = applyLibraryTransition(downloaded, {
      kind: 'stop-protection',
      deviceId: 'A',
      assetId: ASSET,
    });
    expect(stopped.status).toBe('applied');
    expect(stopped.world.assets[ASSET]?.protection).toBe('unprotected');
    expect(stopped.world.assets[ASSET]?.originalGenerationId).toBeNull();
    expect(reliableOriginalCount(stopped.world, ASSET)).toBe(1);
  });

  it('never accepts a derived object or a provider URL as the original', () => {
    let world = run(initialLibraryWorld(['A', 'B']), [collectOnA]);
    world = {
      ...world,
      assets: {
        ...world.assets,
        [ASSET]: {
          ...world.assets[ASSET]!,
          protection: 'protected',
          originalGenerationId: null,
          thumbnailGenerationId: GENERATION_ID,
          previewGenerationId: GENERATION_ID,
        },
      },
      devices: {
        ...world.devices,
        B: {
          ...world.devices.B,
          [ASSET]: {
            assetId: ASSET,
            generation: 1,
            residency: 'cloud-only',
            deviceTrashed: false,
            verifiedGenerationId: null,
            hasProviderUrl: true,
          },
        },
      },
    };
    expect(
      applyLibraryTransition(world, {
        kind: 'download',
        deviceId: 'B',
        assetId: ASSET,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'object_missing' });
    expect(reliableOriginalCount(world, ASSET)).toBe(1);
  });

  it('stops a stale device from resurrecting a purged asset', () => {
    let world = run(initialLibraryWorld(['A', 'B']), [
      collectOnA,
      { kind: 'trash', deviceId: 'A', assetId: ASSET },
      { kind: 'permanent-delete', deviceId: 'A', assetId: ASSET },
    ]);
    expect(world.assets[ASSET]?.lifecycle).toBe('purged');
    expect(reliableOriginalCount(world, ASSET)).toBe(0);
    world = { ...world, devices: { ...world.devices, B: { ...world.devices.B } } };
    expect(
      applyLibraryTransition(world, {
        kind: 'collect',
        deviceId: 'B',
        assetId: ASSET,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'purged_permanently' });
    expect(
      applyLibraryTransition(world, {
        kind: 'restore',
        deviceId: 'B',
        assetId: ASSET,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'purged_permanently' });
    expect(
      applyLibraryTransition(world, {
        kind: 're-import',
        deviceId: 'B',
        assetId: ASSET,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'stale_device' });
  });

  it('allows explicit re-import of a purged asset after a full current sync', () => {
    const purged = run(initialLibraryWorld(['A', 'B']), [
      collectOnA,
      { kind: 'trash', deviceId: 'A', assetId: ASSET },
      { kind: 'permanent-delete', deviceId: 'A', assetId: ASSET },
    ]);
    expect(purged.assets[ASSET]?.lifecycle).toBe('purged');
    const previousGeneration = purged.assets[ASSET]!.generation;

    // Ordinary collect stays blocked even after the device syncs.
    const synced = run(purged, [{ kind: 'sync', deviceId: 'B' }]);
    expect(
      applyLibraryTransition(synced, {
        kind: 'collect',
        deviceId: 'B',
        assetId: ASSET,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'purged_permanently' });

    const imported = applyLibraryTransition(synced, {
      kind: 're-import',
      deviceId: 'B',
      assetId: ASSET,
    });
    expect(imported.status).toBe('applied');
    expect(imported.world.assets[ASSET]?.lifecycle).toBe('active');
    expect(imported.world.assets[ASSET]?.protection).toBe('unprotected');
    expect(imported.world.assets[ASSET]?.generation).toBe(previousGeneration + 1);
    expect(imported.world.assets[ASSET]?.originalGenerationId).toBeNull();
    expect(imported.world.devices.B[ASSET]?.residency).toBe('local-original');
    expect(imported.world.devices.B[ASSET]?.generation).toBe(
      previousGeneration + 1,
    );
    expect(imported.world.knownRevision.B).toBe(imported.world.revision);
    expect(reliableOriginalCount(imported.world, ASSET)).toBe(1);
  });

  it('charges quota once no matter how many times protect is replayed', () => {
    const world = run(initialLibraryWorld(['A', 'B']), [
      collectOnA,
      { kind: 'collect', deviceId: 'B', assetId: ASSET },
      protectCommitOnA,
      protectCommitOnA,
      { kind: 'protect-commit', deviceId: 'B', assetId: ASSET, originalGenerationId: GENERATION_ID },
    ]);
    expect(world.quotaCharges).toBe(1);
    expect(Object.keys(world.assets)).toEqual([ASSET]);
  });

  it('keeps every invariant across randomised multi-device sequences', () => {
    const kinds: LibraryTransition['kind'][] = [
      'collect',
      'protect-commit',
      'protect-verify',
      'protect-fail',
      'download',
      'stop-protection',
      'trash',
      'restore',
      'permanent-delete',
      're-import',
      'sync',
    ];
    const assets = [ASSET, 'b'.repeat(64), 'c'.repeat(64)];
    const devices = ['A', 'B', 'C'];
    let seed = 20260728;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let round = 0; round < 400; round += 1) {
      let world = initialLibraryWorld(devices);
      for (let step = 0; step < 24; step += 1) {
        const kind = kinds[next(kinds.length)]!;
        const transition = {
          kind,
          deviceId: devices[next(devices.length)]!,
          assetId: assets[next(assets.length)]!,
          originalGenerationId: GENERATION_ID,
        } as LibraryTransition;
        const result = applyLibraryTransition(world, transition);
        if (result.status === 'rejected') {
          expect(result.world).toBe(world);
          continue;
        }
        const violation = findLibraryInvariantViolation(
          world,
          result.world,
          transition,
        );
        if (violation !== null) {
          throw new Error(
            `round ${round} step ${step} ${kind}: ${violation}`,
          );
        }
        world = result.world;
      }
    }
  });
});
