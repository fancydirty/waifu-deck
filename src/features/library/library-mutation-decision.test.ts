import {
  decideLibraryMutation,
  type LibraryRemoteAssetState,
  type LibraryRemoteMutation,
} from './library-mutation-decision';

function asset(
  over: Partial<LibraryRemoteAssetState> = {},
): LibraryRemoteAssetState {
  return {
    assetId: 'a1',
    revision: 3,
    generation: 1,
    lifecycle: 'active',
    protection: 'unprotected',
    ...over,
  };
}
function mut(over: Partial<LibraryRemoteMutation> = {}): LibraryRemoteMutation {
  return {
    assetId: 'a1',
    kind: 'collect',
    baseRevision: 3,
    observedGeneration: 1,
    originalGenerationId: null,
    ...over,
  };
}

describe('decideLibraryMutation (production)', () => {
  it('collect on empty applies as generation 1 active', () => {
    expect(decideLibraryMutation(null, mut({ kind: 'collect' }), 0)).toMatchObject({
      outcome: 'applied',
      changeKind: 'collect',
      generation: 1,
      lifecycle: 'active',
    });
  });
  it('collect on active merges', () => {
    expect(decideLibraryMutation(asset(), mut({ kind: 'collect' }), 0)).toEqual({
      outcome: 'merged',
    });
  });
  it('collect on trash is rejected trash_wins', () => {
    expect(
      decideLibraryMutation(
        asset({ lifecycle: 'trash' }),
        mut({ kind: 'collect' }),
        0,
      ),
    ).toEqual({ outcome: 'rejected', reason: 'trash_wins' });
  });
  it('trash on active applies', () => {
    expect(decideLibraryMutation(asset(), mut({ kind: 'trash' }), 0)).toMatchObject({
      outcome: 'applied',
      changeKind: 'trash',
      lifecycle: 'trash',
    });
  });
  it('protect without original object is rejected object_missing', () => {
    expect(
      decideLibraryMutation(
        asset(),
        mut({ kind: 'protect', originalGenerationId: null }),
        0,
      ),
    ).toMatchObject({ outcome: 'rejected', reason: 'object_missing' });
  });
  it('protect with original applies protected', () => {
    expect(
      decideLibraryMutation(
        asset(),
        mut({ kind: 'protect', originalGenerationId: 'g9' }),
        0,
      ),
    ).toMatchObject({
      outcome: 'applied',
      changeKind: 'protect',
      protection: 'protected',
    });
  });
  it('protect on an already-protected asset merges — nothing is rewritten', () => {
    expect(
      decideLibraryMutation(
        asset({ protection: 'protected' }),
        mut({ kind: 'protect', originalGenerationId: 'g9' }),
        0,
      ),
    ).toEqual({ outcome: 'merged' });
  });

  describe('K7 ⑨ derived-only generations patch', () => {
    // `library-protect-action.ts` now commits `protected` the moment the
    // ORIGINAL blob is durable, and folds the thumbnail/preview references in
    // afterwards with one follow-up mutation. That follow-up is a `protect`
    // against an asset that is already protected, which the table above
    // answers `merged` — it would write nothing, and the second device would
    // never learn where the derived blobs are. A patch that carries ONLY
    // derived roles is therefore an applied no-lifecycle-change write.

    it('applies a patch that carries only derived roles, at the same generation', () => {
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected' }),
          mut({
            kind: 'protect',
            originalGenerationId: 'g9',
            generationsPatch: { thumbnail: 'g-t', preview: 'g-p' },
          }),
          0,
        ),
      ).toEqual({
        outcome: 'applied',
        changeKind: 'protect',
        generation: 1,
        lifecycle: 'active',
        protection: 'protected',
      });
    });

    it('applies a thumbnail-only patch (a preview upload that failed is not a blocker)', () => {
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected' }),
          mut({
            kind: 'protect',
            originalGenerationId: 'g9',
            generationsPatch: { thumbnail: 'g-t' },
          }),
          0,
        ),
      ).toMatchObject({ outcome: 'applied', protection: 'protected' });
    });

    it('still merges a protect replay that names the original — the drain path is untouched', () => {
      // `library-sync-engine.ts`'s crash replay ALWAYS carries
      // `{ original, ... }`. A device that never uploads a derived role must
      // keep merging, or a two-device library would rewrite state.json on
      // every round.
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected' }),
          mut({
            kind: 'protect',
            originalGenerationId: 'g9',
            generationsPatch: { original: 'g9', thumbnail: 'g-t', preview: 'g-p' },
          }),
          0,
        ),
      ).toEqual({ outcome: 'merged' });
    });

    it('still merges when the patch is empty or absent', () => {
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected' }),
          mut({ kind: 'protect', originalGenerationId: 'g9', generationsPatch: {} }),
          0,
        ),
      ).toEqual({ outcome: 'merged' });
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected' }),
          mut({ kind: 'protect', originalGenerationId: 'g9' }),
          0,
        ),
      ).toEqual({ outcome: 'merged' });
    });

    it('treats an explicitly undefined role as absent, not as a derived patch', () => {
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected' }),
          mut({
            kind: 'protect',
            originalGenerationId: 'g9',
            generationsPatch: { thumbnail: undefined, preview: undefined },
          }),
          0,
        ),
      ).toEqual({ outcome: 'merged' });
    });

    it('rejects a derived patch against a different generation', () => {
      // The derived blobs belong to the generation that produced them. A
      // restore on another device bumped the generation, so this patch is
      // stale and must not be folded in.
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected', generation: 2 }),
          mut({
            kind: 'protect',
            observedGeneration: 1,
            originalGenerationId: 'g9',
            generationsPatch: { thumbnail: 'g-t' },
          }),
          0,
        ),
      ).toEqual({ outcome: 'rejected', reason: 'generation_conflict' });
    });

    it('never resurrects a trashed or purged asset', () => {
      const patch = {
        kind: 'protect' as const,
        originalGenerationId: 'g9',
        generationsPatch: { thumbnail: 'g-t' },
      };
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected', lifecycle: 'trash' }),
          mut(patch),
          0,
        ),
      ).toEqual({ outcome: 'rejected', reason: 'trash_wins' });
      expect(
        decideLibraryMutation(
          asset({ protection: 'protected', lifecycle: 'purged' }),
          mut(patch),
          0,
        ),
      ).toEqual({ outcome: 'rejected', reason: 'purged_permanently' });
    });

    it('does not turn an UNPROTECTED asset protected by a derived-only patch', () => {
      // Only a real protect (one that names the original it uploaded) may
      // flip protection on. A derived-only patch against an unprotected asset
      // falls through to the ordinary protect branch, where the missing
      // original is what decides.
      expect(
        decideLibraryMutation(
          asset(),
          mut({
            kind: 'protect',
            originalGenerationId: null,
            generationsPatch: { thumbnail: 'g-t' },
          }),
          0,
        ),
      ).toEqual({ outcome: 'rejected', reason: 'object_missing' });
    });
  });

  it('permanent-delete on trash purges', () => {
    expect(
      decideLibraryMutation(
        asset({ lifecycle: 'trash' }),
        mut({ kind: 'permanent-delete' }),
        0,
      ),
    ).toMatchObject({
      outcome: 'applied',
      changeKind: 'purge',
      lifecycle: 'purged',
    });
  });
  it('permanent-delete on active is rejected not_trash', () => {
    expect(
      decideLibraryMutation(asset(), mut({ kind: 'permanent-delete' }), 0),
    ).toEqual({ outcome: 'rejected', reason: 'not_trash' });
  });
  it('restore on trash applies as a new generation', () => {
    expect(
      decideLibraryMutation(
        asset({ lifecycle: 'trash' }),
        mut({ kind: 'restore', baseRevision: 3 }),
        0,
      ),
    ).toMatchObject({
      outcome: 'applied',
      changeKind: 'restore',
      generation: 2,
      lifecycle: 'active',
    });
  });
  it('stale baseRevision below minBaseCursor is rejected resync_required', () => {
    expect(
      decideLibraryMutation(asset(), mut({ kind: 'trash', baseRevision: 1 }), 2),
    ).toMatchObject({ outcome: 'rejected', reason: 'resync_required' });
  });
});
