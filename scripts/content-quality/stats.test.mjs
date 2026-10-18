import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateProvider, aggregateTotals, percentile } from './stats.mjs';

const observations = [
  {
    provider: 'waifu_im', providerId: '1', sourceId: null, sourceUrl: 'https://pixiv.test/10',
    width: 800, height: 1200, rawRating: 'sfw', safety: 'safe', tags: ['waifu'],
    hasNsfwTag: false,
  },
  {
    provider: 'waifu_im', providerId: '1', sourceId: null, sourceUrl: 'https://pixiv.test/10',
    width: 1000, height: 1600, rawRating: 'sfw', safety: 'safe', tags: [],
    hasNsfwTag: false,
  },
  {
    provider: 'nekos_api', providerId: 'a', sourceId: '10', sourceUrl: 'https://pixiv.test/10',
    width: null, height: null, rawRating: 'explicit', safety: 'explicit', tags: ['girl', 'nude'],
    hasNsfwTag: true,
  },
  {
    provider: 'danbooru', providerId: '7', sourceId: '7', sourceUrl: null,
    width: 1200, height: 1800, rawRating: 'g', safety: 'safe', tags: ['1girl', 'solo'],
    hasNsfwTag: false,
  },
];

test('uses nearest-rank percentiles', () => {
  assert.equal(percentile([40, 10, 30, 20], 50), 20);
  assert.equal(percentile([40, 10, 30, 20], 95), 40);
  assert.equal(percentile([], 50), null);
});

test('aggregates deterministic fixture statistics and duplicates', () => {
  const result = aggregateProvider({
    provider: 'waifu_im',
    targetSamples: 4,
    requests: [10, 20, 30, 40].map((latencyMs) => ({ ok: latencyMs !== 30, latencyMs })),
    observations,
    accepted: 3,
    rejections: ['mode_mismatch', 'invalid_metadata'],
  });
  assert.deepEqual(result.requests, {
    attempts: 4,
    successes: 3,
    failures: 1,
    latencyMs: { p50: 20, p95: 40, p99: 40 },
  });
  assert.deepEqual(result.dimensions, {
    known: 3,
    missing: 1,
    min: { width: 800, height: 1200 },
    median: { width: 1000, height: 1600 },
  });
  assert.equal(result.tagCoverage.coveragePercent, 75);
  assert.equal(result.duplicates.providerIds.duplicateRecords, 1);
  assert.equal(result.duplicates.sourceUrls.duplicateRecords, 2);
  assert.deepEqual(result.rejectionReasons, { invalid_metadata: 1, mode_mismatch: 1 });
});

test('finds cross-provider duplicate source URLs in totals', () => {
  const inputs = observations.map((record) => ({
    provider: record.provider,
    targetSamples: 1,
    requests: [{ ok: true, latencyMs: 5 }],
    observations: [record],
    accepted: 1,
    rejections: [],
  }));
  assert.equal(aggregateTotals(inputs).duplicates.sourceUrls.duplicateRecords, 2);
});
