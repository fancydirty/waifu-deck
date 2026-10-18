import {
  normalizeFixtureBaseUrl,
  type E2eRuntimeConfig,
} from '@/features/e2e/e2e-runtime';
import type {
  DiscoveryProviderFetcher,
} from '@/features/providers/provider-client';
import type { ImageCandidate } from '@/features/waifu/types';

const FIXTURE_COUNT = 16;
const FIXTURE_COLORS = [
  '#335C67',
  '#E09F3E',
  '#9E2A2B',
  '#540B0E',
  '#3D5A80',
  '#EE6C4D',
  '#293241',
  '#2A9D8F',
  '#E76F51',
  '#264653',
  '#6D597A',
  '#B56576',
  '#355070',
  '#588157',
  '#BC6C25',
  '#7F5539',
] as const;

function abortedFixtureRequest(): Error & { code: 'aborted' } {
  const error = Object.assign(new Error('Fixture discovery was aborted'), {
    code: 'aborted' as const,
  });
  error.name = 'AbortError';
  return error;
}

function fixtureCandidate(
  fixtureBaseUrl: string,
  index: number,
): ImageCandidate {
  const suffix = String(index + 1).padStart(2, '0');
  const remoteUrl = `${fixtureBaseUrl}/images/fixture-${suffix}.png`;
  return {
    providerKey: 'waifu_im',
    providerItemId: `e2e-fixture-${suffix}`,
    canonicalSourceKey: `e2e-fixture:${suffix}`,
    perceptualHash: null,
    md5: null,
    remoteUrl,
    sourceUrl: remoteUrl,
    artistName: 'Waifu Deck Test Fixture',
    artistUrl: null,
    width: 720,
    height: 1280,
    byteSize: 0,
    extension: 'png',
    dominantColor: FIXTURE_COLORS[index],
    contentRating: 'safe',
    nativeRating: 'synthetic-sfw',
    isNsfw: false,
    isAnimated: false,
    tags: ['waifu', 'e2e-fixture', `fixture-${suffix}`],
  };
}

export function createFixtureDiscoveryFetcher(
  config: E2eRuntimeConfig,
): DiscoveryProviderFetcher {
  const fixtureBaseUrl = normalizeFixtureBaseUrl(config.fixtureBaseUrl);
  const candidates = Array.from(
    { length: FIXTURE_COUNT },
    (_, index) => fixtureCandidate(fixtureBaseUrl, index),
  );

  return async ({ excludedProviderIds, desiredCount, signal }) => {
    if (signal?.aborted) throw abortedFixtureRequest();
    const excluded = new Set(excludedProviderIds.waifu_im ?? []);
    const available = candidates.filter(
      (candidate) => !excluded.has(candidate.providerItemId),
    );
    const limit = desiredCount === undefined
      ? available.length
      : Math.max(0, Math.min(available.length, Math.trunc(desiredCount)));
    return {
      items: available.slice(0, limit),
      totalCount: FIXTURE_COUNT,
    };
  };
}
