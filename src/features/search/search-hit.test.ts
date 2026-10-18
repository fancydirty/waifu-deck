import type { ImageCandidate, ImageProviderKey } from '@/features/waifu/types';

import { toSearchHit } from './search-hit';

function candidate(
  providerKey: ImageProviderKey,
  providerItemId: string,
  overrides: Partial<ImageCandidate> = {},
): ImageCandidate {
  return {
    providerKey,
    providerItemId,
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl: `https://cdn.example.com/${providerKey}/${providerItemId}.webp`,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width: 768,
    height: 1152,
    byteSize: 100,
    extension: '.webp',
    dominantColor: '#abcdef',
    isNsfw: false,
    isAnimated: false,
    tags: [],
    ...overrides,
  };
}

test('derives a stable key and preview url and preserves the candidate', () => {
  const image = candidate('waifu_im', '42', {
    remoteUrl: 'https://cdn.example.com/original/42.png',
  });

  expect(toSearchHit(image)).toEqual({
    key: 'waifu_im:42',
    previewUrl: 'https://cdn.example.com/original/42.png',
    image,
  });
});

test('previews the provider sample so a tile never fetches a multi-MB original', () => {
  const image = candidate('konachan', '900', {
    remoteUrl: 'https://cdn.example.com/image/900.png',
    sampleUrl: 'https://cdn.example.com/sample/900.jpg',
  });

  expect(toSearchHit(image).previewUrl).toBe('https://cdn.example.com/sample/900.jpg');
});

test('falls back to the original for providers that publish no sample', () => {
  const image = candidate('nekos_api', 'nekos-3', {
    remoteUrl: 'https://cdn.example.com/original/nekos-3.webp',
  });

  expect(toSearchHit(image).previewUrl).toBe('https://cdn.example.com/original/nekos-3.webp');
});
