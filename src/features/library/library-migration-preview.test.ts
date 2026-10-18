import { buildMigrationPreview } from '@/features/library/library-migration-preview';

describe('buildMigrationPreview', () => {
  it('counts verified locals, pending/missing, and existing account assets', () => {
    expect(buildMigrationPreview({
      localAssets: [
        { plaintextSha256: 'a'.repeat(64), localOriginalUri: 'file://a', missingOriginalSince: null },
        { plaintextSha256: 'b'.repeat(64), localOriginalUri: null, missingOriginalSince: 1 },
        { plaintextSha256: 'c'.repeat(64), localOriginalUri: 'file://c', missingOriginalSince: null },
      ],
      alreadyEnrolledDigests: new Set(['c'.repeat(64)]),
    })).toEqual({
      verifiedLocalOriginals: 2,
      pendingOrMissing: 1,
      alreadyInAccount: 1,
      wouldEnroll: 1, // verified local not yet enrolled
    });
  });
});
