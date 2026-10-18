import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesMode, normalizeProviderPayload } from './normalize.mjs';

test('normalizes Waifu.im v7 metadata', () => {
  const result = normalizeProviderPayload('waifu_im', {
    items: [{
      id: 42,
      url: 'https://cdn.waifu.im/42.png',
      source: 'https://www.pixiv.net/artworks/42#fragment',
      width: 1080,
      height: 1920,
      byteSize: 123_456,
      isNsfw: false,
      tags: [{ slug: 'Waifu' }, { slug: 'Blue-Hair' }],
    }],
  });
  assert.equal(result.observations[0].providerId, '42');
  assert.equal(result.observations[0].sourceUrl, 'pixiv:42');
  assert.deepEqual(result.observations[0].tags, ['waifu', 'blue-hair']);
  assert.equal(matchesMode(result.observations[0], 'sfw'), true);
});

test('canonicalizes equivalent source URLs before duplicate statistics', () => {
  const english = normalizeProviderPayload('waifu_im', {
    items: [{
      id: 1,
      url: 'https://cdn.waifu.im/1.png',
      source: 'https://www.pixiv.net/en/artworks/42?lang=en',
      width: 100,
      height: 200,
      byteSize: 1,
      isNsfw: false,
      tags: [],
    }],
  });
  const canonical = normalizeProviderPayload('waifu_im', {
    items: [{
      id: 2,
      url: 'https://cdn.waifu.im/2.png',
      source: 'https://pixiv.net/artworks/42#detail',
      width: 100,
      height: 200,
      byteSize: 1,
      isNsfw: false,
      tags: [],
    }],
  });

  assert.equal(english.observations[0].sourceUrl, 'pixiv:42');
  assert.equal(canonical.observations[0].sourceUrl, 'pixiv:42');
});

test('flags a nominally safe Nekos item when provider tags say NSFW', () => {
  const result = normalizeProviderPayload('nekos_api', {
    id: 'nekos-1',
    url: 'https://cdn.nekosapi.com/image.webp',
    rating: 'safe',
    source_id: 'danbooru-88',
    source_url: null,
    tags: [{ name: 'Exposed breasts', is_nsfw: true }],
  });
  assert.equal(result.observations[0].rawRating, 'safe');
  assert.equal(result.observations[0].sourceId, 'danbooru-88');
  assert.equal(result.observations[0].safety, 'nsfw_unspecified');
  assert.equal(result.observations[0].width, null);
  assert.equal(matchesMode(result.observations[0], 'sfw'), false);
});

test('normalizes Danbooru ratings and dimensions', () => {
  const result = normalizeProviderPayload('danbooru', {
    id: 99,
    image_width: 1200,
    image_height: 1800,
    file_size: 456_789,
    file_ext: 'jpg',
    file_url: 'https://cdn.donmai.us/original/a/b.jpg',
    source: 'https://www.pixiv.net/artworks/99',
    pixiv_id: 99,
    rating: 'q',
    tag_string: '1girl solo',
  });
  assert.equal(result.observations[0].rawRating, 'q');
  assert.equal(result.observations[0].sourceId, '99');
  assert.equal(result.observations[0].safety, 'nsfw_unspecified');
  assert.deepEqual(
    [result.observations[0].width, result.observations[0].height],
    [1200, 1800],
  );
});
