import { STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import type { DistributionPolicy } from '@/features/distribution/distribution-policy';
import type {
  ContentRating,
  ImageCandidate,
  ImageProviderKey,
} from '@/features/waifu/types';

type AdmissionAdapter<Fixture> = (
  fixture: Fixture,
  distributionPolicy?: DistributionPolicy,
) => Promise<ImageCandidate | null>;

type RatingCase<Fixture> = {
  label?: string;
  nativeRating: string;
  fixture: Fixture;
  canonicalRating: ContentRating;
};

type NativeRatingDomain = Readonly<Record<string, true>>;

export type ProviderAdmissionContract<Fixture> = {
  providerKey: ImageProviderKey;
  adapt: AdmissionAdapter<Fixture>;
  identity: {
    fixture: Fixture;
    expectedItemId: string;
  };
  nativeRatings: NativeRatingDomain;
  ratings: readonly RatingCase<Fixture>[];
  attribution: {
    fixture: Fixture;
  };
  /**
   * The MD5 the `identity.fixture` should produce on `ImageCandidate.md5`,
   * lowercased — or `null` for sources that don't expose one (waifu_im,
   * nekos_api). Required so every source explicitly declares reality rather
   * than silently inheriting `undefined` (G2b task2).
   */
  md5: string | null;
};

type AnyProviderAdmissionContract = ProviderAdmissionContract<any>;

export type ProviderAdmissionRegistry = {
  [ProviderKey in ImageProviderKey]: AnyProviderAdmissionContract & {
    providerKey: ProviderKey;
  };
};

async function requireCandidate<Fixture>(
  adapt: AdmissionAdapter<Fixture>,
  fixture: Fixture,
): Promise<ImageCandidate> {
  const candidate = await adapt(fixture);
  expect(candidate).not.toBeNull();
  return candidate!;
}

const ATTRIBUTION_FIELDS = [
  'canonicalSourceKey',
  'sourceUrl',
  'artistName',
  'artistUrl',
] as const;

export function validateProviderAdmissionContract<Fixture>({
  providerKey,
  nativeRatings,
  ratings,
}: ProviderAdmissionContract<Fixture>): void {
  const nativeRatingValues = Object.keys(nativeRatings);
  if (nativeRatingValues.length === 0) {
    throw new Error(`${providerKey} must declare its native rating domain`);
  }

  for (const nativeRating of nativeRatingValues) {
    if (!ratings.some((ratingCase) => ratingCase.nativeRating === nativeRating)) {
      throw new Error(`${providerKey} is missing a mapping case for ${nativeRating}`);
    }
  }
  for (const ratingCase of ratings) {
    if (!(ratingCase.nativeRating in nativeRatings)) {
      throw new Error(`${providerKey} maps undeclared native rating ${ratingCase.nativeRating}`);
    }
  }
  if (!ratings.some(({ canonicalRating }) => canonicalRating !== 'safe')) {
    throw new Error(`${providerKey} must prove at least one non-safe Store rejection`);
  }
}

export function defineProviderAdmissionTests<Fixture>({
  providerKey,
  adapt,
  identity,
  nativeRatings,
  ratings,
  attribution,
  md5,
}: ProviderAdmissionContract<Fixture>): void {
  describe(`${providerKey} provider admission`, () => {
    test('covers the exhaustive native rating domain', () => {
      expect(() =>
        validateProviderAdmissionContract({
          providerKey,
          adapt,
          identity,
          nativeRatings,
          ratings,
          attribution,
          md5,
        })).not.toThrow();
    });

    test('derives the same stable identity from the same native item', async () => {
      const first = await requireCandidate(adapt, identity.fixture);
      const second = await requireCandidate(adapt, identity.fixture);

      expect(first.providerKey).toBe(providerKey);
      expect(first.providerItemId).toBe(identity.expectedItemId);
      expect(`${first.providerKey}:${first.providerItemId}`).toBe(
        `${second.providerKey}:${second.providerItemId}`,
      );
    });

    test.each(ratings)(
      'maps $nativeRating ($label) to $canonicalRating',
      async ({ nativeRating, fixture, canonicalRating }) => {
        const candidate = await requireCandidate(adapt, fixture);

        expect(candidate.nativeRating).toBe(nativeRating);
        expect(candidate.contentRating).toBe(canonicalRating);
        expect(candidate.isNsfw).toBe(canonicalRating !== 'safe');
      },
    );

    test.each(ratings.filter(({ canonicalRating }) => canonicalRating !== 'safe'))(
      'rejects $nativeRating ($label) under the Store distribution policy',
      async ({ fixture }) => {
        await expect(adapt(fixture, STORE_DISTRIBUTION_POLICY)).resolves.toBeNull();
      },
    );

    test('emits every attribution field as a value or explicit null', async () => {
      const candidate = await requireCandidate(adapt, attribution.fixture);

      for (const field of ATTRIBUTION_FIELDS) {
        expect(Object.hasOwn(candidate, field)).toBe(true);
        expect(candidate[field] === null || typeof candidate[field] === 'string').toBe(true);
      }
    });

    test('normalizes md5 to match this source\'s reality', async () => {
      const candidate = await requireCandidate(adapt, identity.fixture);
      expect(candidate.md5).toBe(md5);
    });
  });
}

export function defineProviderAdmissionRegistryTests(
  registry: ProviderAdmissionRegistry,
): void {
  const entries = Object.entries(registry) as [
    ImageProviderKey,
    AnyProviderAdmissionContract,
  ][];

  describe('provider admission registry', () => {
    test('contains exactly one matching contract per provider key', () => {
      expect(new Set(entries.map(([, contract]) => contract.providerKey)).size).toBe(
        entries.length,
      );
      for (const [providerKey, contract] of entries) {
        expect(contract.providerKey).toBe(providerKey);
      }
    });
  });

  for (const [, contract] of entries) {
    defineProviderAdmissionTests(contract);
  }
}
