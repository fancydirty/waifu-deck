import type { ImageProviderKey } from '@/features/waifu/types';

import {
  providerImageHeaders,
  providerImageSource,
} from './provider-image-source';

const GELBOORU_REFERER = { Referer: 'https://gelbooru.com/' };

test('gelbooru declares the Referer its image CDN requires', () => {
  expect(providerImageHeaders('gelbooru')).toEqual(GELBOORU_REFERER);
});

test('every other source declares no image request headers', () => {
  const others: ImageProviderKey[] = [
    'waifu_im',
    'nekos_api',
    'danbooru',
    'safebooru',
    'yandere',
    'konachan',
    'e621',
    'e926',
    'rule34',
  ];
  for (const key of others) {
    expect(providerImageHeaders(key)).toBeUndefined();
  }
});

test('an unknown provider key declares no headers instead of throwing', () => {
  expect(providerImageHeaders('nope' as ImageProviderKey)).toBeUndefined();
});

test('a gelbooru image source carries the uri and the Referer header', () => {
  expect(providerImageSource('https://img4.gelbooru.com/samples/a/b/c.jpg', 'gelbooru'))
    .toEqual({
      uri: 'https://img4.gelbooru.com/samples/a/b/c.jpg',
      headers: GELBOORU_REFERER,
    });
});

test('a headerless source produces exactly { uri } — no headers key at all', () => {
  const source = providerImageSource('https://cdn.donmai.us/x.jpg', 'danbooru');
  expect(source).toEqual({ uri: 'https://cdn.donmai.us/x.jpg' });
  expect(Object.keys(source)).toEqual(['uri']);
  expect('headers' in source).toBe(false);
});
