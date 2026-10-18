import type { SqlDatabasePort } from '@/db/sql-port';
import {
  candidateContentRating,
  matchesContentMode,
} from '@/features/content/content-taxonomy';
import type {
  AppSettings,
  ImageCandidate,
  NsfwMode,
} from '@/features/waifu/types';

export type DistributionVariant = 'store' | 'direct';

export type DistributionPolicy = Readonly<{
  variant: DistributionVariant;
  allowsAdultContent: boolean;
}>;

export const STORE_DISTRIBUTION_POLICY: DistributionPolicy = Object.freeze({
  variant: 'store',
  allowsAdultContent: false,
});

export const DIRECT_DISTRIBUTION_POLICY: DistributionPolicy = Object.freeze({
  variant: 'direct',
  allowsAdultContent: true,
});

export function distributionPolicyFor(value: unknown): DistributionPolicy {
  return value === 'direct'
    ? DIRECT_DISTRIBUTION_POLICY
    : STORE_DISTRIBUTION_POLICY;
}

/**
 * D6 (2026-08-30 owner decision): Waifu Deck ships as one open-source
 * distribution that allows adult content behind the user's own 18+ gate. The
 * policy is a constant, never read from the embedded Expo config, so a build
 * with no environment variable can never fall back to an SFW-only bundle.
 */
export const APP_DISTRIBUTION_POLICY: DistributionPolicy = DIRECT_DISTRIBUTION_POLICY;

export function allowedNsfwMode(
  mode: NsfwMode,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): NsfwMode {
  return policy.allowsAdultContent ? mode : 'sfw';
}

export function applyDistributionToSettings(
  settings: AppSettings,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): AppSettings {
  if (policy.allowsAdultContent) return settings;
  return {
    ...settings,
    nsfwMode: 'sfw',
    nsfwConfirmed: false,
    blurNsfwThumbnails: true,
  };
}

export function applyDistributionToSearchRequest<
  T extends { nsfwMode: NsfwMode },
>(
  request: T,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): T {
  const nsfwMode = allowedNsfwMode(request.nsfwMode, policy);
  return nsfwMode === request.nsfwMode ? request : { ...request, nsfwMode };
}

export function isImageAllowedByDistribution(
  image: Pick<ImageCandidate, 'contentRating' | 'isNsfw' | 'tags'>,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): boolean {
  return policy.allowsAdultContent
    || (
      !image.isNsfw
      && matchesContentMode(candidateContentRating(image), 'sfw')
    );
}

export async function sanitizeImageDatabaseForDistribution(
  database: Pick<SqlDatabasePort, 'run'>,
  policy: DistributionPolicy = APP_DISTRIBUTION_POLICY,
): Promise<number> {
  if (policy.allowsAdultContent) return 0;
  const result = await database.run(`
    DELETE FROM images
    WHERE is_nsfw <> 0
       OR content_rating IS NULL
       OR content_rating <> 'safe'
  `);
  return result.changes;
}
