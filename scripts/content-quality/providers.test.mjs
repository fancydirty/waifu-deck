import assert from 'node:assert/strict';
import test from 'node:test';

import { providerRequest, USER_AGENT } from './providers.mjs';

test('builds the exact Waifu.im v7 metadata request', () => {
  const request = providerRequest('waifu_im', 'mixed');
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://api.waifu.im/images');
  assert.equal(url.searchParams.get('IsNsfw'), 'All');
  assert.equal(url.searchParams.get('PageSize'), '1');
  assert.equal(url.searchParams.getAll('IncludedTags')[0], 'waifu');
  assert.equal(request.headers['Accept-Version'], 'v7');
  assert.equal(request.headers['User-Agent'], USER_AGENT);
});

test('uses only Nekos metadata endpoints and maps strict ratings', () => {
  const request = providerRequest('nekos_api', 'nsfw');
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://api.nekosapi.com/v5/images/random');
  assert.deepEqual(url.searchParams.getAll('rating'), ['explicit']);
  assert.equal(url.hostname.startsWith('cdn.'), false);
});

test('matches the existing Danbooru discovery query', () => {
  const request = providerRequest('danbooru', 'sfw');
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, 'https://danbooru.donmai.us/posts/random.json');
  assert.deepEqual(url.searchParams.get('tags').split(' '), [
    '1girl',
    'rating:general',
  ]);
  assert.equal(request.headers.Accept, 'application/json');
});
