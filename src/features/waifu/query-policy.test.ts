import { WaifuApiError } from './waifu-client';
import { NekosApiError } from '../nekos/nekos-client';
import { DanbooruApiError } from '../danbooru/danbooru-client';
import { DiscoveryProviderError } from '../providers/provider-client';
import {
  MAX_WAIFU_RETRIES,
  shouldRetryWaifu,
  waifuRetryDelay,
} from './query-policy';

const timeout = new WaifuApiError('timeout', 'timed out');
const network = new WaifuApiError('network', 'offline');
const rateLimited = new WaifuApiError('rate_limited', 'slow down', {
  status: 429,
  retryAfterMs: 7_000,
});
const serverError = new WaifuApiError('http', 'server error', { status: 503 });

test.each([timeout, network, rateLimited, serverError])(
  'retries transient Waifu errors only within the retry bound',
  (error) => {
    expect(shouldRetryWaifu(0, error)).toBe(true);
    expect(shouldRetryWaifu(MAX_WAIFU_RETRIES - 1, error)).toBe(true);
    expect(shouldRetryWaifu(MAX_WAIFU_RETRIES, error)).toBe(false);
  },
);

test.each([
  new WaifuApiError('invalid_response', 'bad payload'),
  new WaifuApiError('aborted', 'cancelled'),
  new WaifuApiError('http', 'bad request', { status: 400 }),
  new WaifuApiError('http', 'forbidden', { status: 403 }),
])('does not retry a non-transient Waifu error', (error) => {
  expect(shouldRetryWaifu(0, error)).toBe(false);
});

test('retries transient failures from another image provider', () => {
  expect(shouldRetryWaifu(0, new NekosApiError('network', 'offline'))).toBe(true);
  expect(shouldRetryWaifu(0, new DanbooruApiError('network', 'offline'))).toBe(true);
});

test('retries an all-provider network outage', () => {
  const offline = new DiscoveryProviderError([
    { providerKey: 'nekos_api', code: 'network', message: 'offline' },
    { providerKey: 'danbooru', code: 'timeout', message: 'timed out' },
  ]);
  expect(shouldRetryWaifu(0, offline)).toBe(true);
});

test('retries mixed transient provider failures using the longest Retry-After', () => {
  const transient = new DiscoveryProviderError([
    {
      providerKey: 'waifu_im',
      code: 'rate_limited',
      message: 'slow down',
      status: 429,
      retryAfterMs: 2_000,
    },
    {
      providerKey: 'nekos_api',
      code: 'http',
      message: 'upstream unavailable',
      status: 503,
    },
    { providerKey: 'danbooru', code: 'network', message: 'offline' },
  ]);

  expect(shouldRetryWaifu(0, transient)).toBe(true);
  expect(waifuRetryDelay(0, transient)).toBe(2_000);
});

test('does not retry when a permanent provider failure is mixed in', () => {
  const permanent = new DiscoveryProviderError([
    {
      providerKey: 'waifu_im',
      code: 'rate_limited',
      message: 'slow down',
      status: 429,
      retryAfterMs: 2_000,
    },
    {
      providerKey: 'danbooru',
      code: 'invalid_response',
      message: 'invalid payload',
    },
  ]);

  expect(shouldRetryWaifu(0, permanent)).toBe(false);
});

test('prefers Retry-After over the bounded exponential delay', () => {
  expect(waifuRetryDelay(0, rateLimited)).toBe(7_000);
  expect(waifuRetryDelay(2, network)).toBe(4_000);
  expect(waifuRetryDelay(20, network)).toBeLessThanOrEqual(30_000);
});
