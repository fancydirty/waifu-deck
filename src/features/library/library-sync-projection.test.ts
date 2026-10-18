import type { LibraryAssetStateRecord } from '@/features/library/library-asset-state-codec';
import {
  parseIsoMillis,
  projectAssetStateRecord,
} from '@/features/library/library-sync-projection';

const ASSET_A = 'a'.repeat(64);
const ORIGINAL = '11111111-1111-4111-8111-111111111111';
const THUMBNAIL = '22222222-2222-4222-8222-222222222222';
const PREVIEW = '33333333-3333-4333-8333-333333333333';

function record(
  overrides: Partial<LibraryAssetStateRecord> = {},
): LibraryAssetStateRecord {
  return {
    assetId: ASSET_A,
    revision: 5,
    generation: 1,
    lifecycle: 'active',
    protection: 'unprotected',
    lastMutationId: null,
    trashedAt: null,
    generations: {},
    ...overrides,
  };
}

describe('library sync projection', () => {
  it('parses the record ISO times and tolerates null and garbage', () => {
    expect(parseIsoMillis('2026-07-28T00:00:00.000Z')).toBe(
      Date.UTC(2026, 6, 28),
    );
    expect(parseIsoMillis(null)).toBeNull();
    expect(parseIsoMillis('not-a-time')).toBeNull();
  });

  it('maps every field of one state record onto the projection row', () => {
    expect(projectAssetStateRecord(record({
      revision: 12,
      generation: 3,
      protection: 'protected',
      meta: 'sealed-envelope',
      trashedAt: '2026-07-28T00:00:00.000Z',
      lifecycle: 'trash',
      generations: {
        original: ORIGINAL,
        thumbnail: THUMBNAIL,
        preview: PREVIEW,
      },
    }))).toEqual({
      assetId: ASSET_A,
      revision: 12,
      generation: 3,
      lifecycle: 'trash',
      protection: 'protected',
      encryptedMetadata: 'sealed-envelope',
      trashedAtMs: Date.UTC(2026, 6, 28),
      originalGenerationId: ORIGINAL,
      originalCiphertextBytes: null,
      thumbnailGenerationId: THUMBNAIL,
      previewGenerationId: PREVIEW,
    });
  });

  it('carries the sealed envelope so a second device can materialize', () => {
    // `meta` is the only route by which a device that has never held these
    // bytes learns what the asset is; without it the apply writer counts the
    // row as `skippedUnknownAsset` and the asset stays invisible forever.
    expect(projectAssetStateRecord(record({ meta: 'sealed' }))).toMatchObject({
      encryptedMetadata: 'sealed',
    });
    expect(projectAssetStateRecord(record())).toMatchObject({
      encryptedMetadata: null,
    });
  });

  it('converts trashedAt once, because the trash screen filters on it', () => {
    expect(projectAssetStateRecord(record({
      lifecycle: 'trash',
      trashedAt: '2026-08-01T12:00:00.000Z',
    }))).toMatchObject({
      trashedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    });
  });

  it('adopts generation ids only while the record says protected', () => {
    const generations = {
      original: ORIGINAL,
      thumbnail: THUMBNAIL,
      preview: PREVIEW,
    };
    expect(projectAssetStateRecord(record({
      protection: 'protected',
      generations,
    }))).toMatchObject({
      originalGenerationId: ORIGINAL,
      thumbnailGenerationId: THUMBNAIL,
      previewGenerationId: PREVIEW,
    });
    // Protection ended: the references are no longer this asset's, and the
    // apply writer clears the stored ones on the same transition.
    expect(projectAssetStateRecord(record({
      protection: 'unprotected',
      generations,
    }))).toMatchObject({
      originalGenerationId: null,
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
  });

  it('leaves an absent generation role null rather than undefined', () => {
    expect(projectAssetStateRecord(record({
      protection: 'protected',
      generations: { original: ORIGINAL },
    }))).toMatchObject({
      originalGenerationId: ORIGINAL,
      thumbnailGenerationId: null,
      previewGenerationId: null,
    });
  });

  it('always projects originalCiphertextBytes as null', () => {
    // The BYOS record has no byte count and, with quota deleted, no consumer
    // needs one. A documented ruling, not an oversight.
    expect(projectAssetStateRecord(record({
      protection: 'protected',
      generations: { original: ORIGINAL },
    }))).toMatchObject({ originalCiphertextBytes: null });
  });

  it('projects a purged record as the authoritative tombstone', () => {
    // "Object exists with lifecycle=purged" is the deletion signal, so it is
    // projected like any other record — never inferred from absence.
    expect(projectAssetStateRecord(record({
      lifecycle: 'purged',
      protection: 'unprotected',
      revision: 40,
    }))).toMatchObject({ lifecycle: 'purged', revision: 40 });
  });

  it('skips a record whose lifecycle or protection this build cannot store', () => {
    expect(projectAssetStateRecord(record({
      lifecycle: 'quarantined' as LibraryAssetStateRecord['lifecycle'],
    }))).toBeNull();
    expect(projectAssetStateRecord(record({
      protection: 'sealed' as LibraryAssetStateRecord['protection'],
    }))).toBeNull();
  });
});
