export type MigrationPreviewInput = Readonly<{
  localAssets: readonly Readonly<{
    plaintextSha256: string;
    localOriginalUri: string | null;
    missingOriginalSince: number | null;
  }>[];
  alreadyEnrolledDigests: ReadonlySet<string>;
}>;

export type MigrationPreview = Readonly<{
  verifiedLocalOriginals: number;
  pendingOrMissing: number;
  alreadyInAccount: number;
  wouldEnroll: number;
}>;

export function buildMigrationPreview(input: MigrationPreviewInput): MigrationPreview {
  let verifiedLocalOriginals = 0;
  let pendingOrMissing = 0;
  let alreadyInAccount = 0;
  let wouldEnroll = 0;
  for (const asset of input.localAssets) {
    const verified =
      asset.localOriginalUri !== null && asset.missingOriginalSince === null;
    if (verified) verifiedLocalOriginals += 1;
    else pendingOrMissing += 1;
    if (input.alreadyEnrolledDigests.has(asset.plaintextSha256)) {
      alreadyInAccount += 1;
    } else if (verified) {
      wouldEnroll += 1;
    }
  }
  return { verifiedLocalOriginals, pendingOrMissing, alreadyInAccount, wouldEnroll };
}
