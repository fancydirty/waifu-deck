import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const appConfig = require(path.join(root, 'app.config.js'));

function evaluateAppConfig(overrides) {
  const saved = {
    APP_VARIANT: process.env.APP_VARIANT,
    E2E_TEST_MODE: process.env.E2E_TEST_MODE,
  };
  delete process.env.APP_VARIANT;
  delete process.env.E2E_TEST_MODE;
  Object.assign(process.env, overrides);
  try {
    const base = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
    const build = require(path.join(root, 'app.config.js'));
    return build({ config: base });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertFullDistribution(config) {
  assert.equal(config.name, 'Waifu Deck');
  // P12-D Task 10 (spec §4.3 补裁 4, 14 route A): the Google OAuth redirect is
  // the iOS app client's reverse client id, registered as a second scheme.
  assert.deepEqual(config.scheme, [
    'waifudeck',
    'com.googleusercontent.apps.550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec',
  ]);
  assert.equal(config.android.package, 'app.waifudeck.mobile');
  assert.equal(config.ios.bundleIdentifier, 'app.waifudeck.mobile');
  assert.ok(
    config.plugins.includes('expo-background-task'),
    'expo-background-task must always be configured',
  );
  assert.ok(
    config.plugins.includes('./plugins/with-network-tuning'),
    'K6-1d: the IPv4-first warm-pool OkHttp factory must always be configured',
  );
  assert.ok(
    config.plugins.includes('./plugins/with-release-signing'),
    '#13: release builds must sign with the owner key, never the Expo template debug key',
  );
  assert.equal('distributionVariant' in (config.extra ?? {}), false);
}

test('D6a: app.config yields the single full distribution with no environment variable', () => {
  assertFullDistribution(evaluateAppConfig({}));
});

test('D6a: a stale APP_VARIANT=store no longer changes the identity', () => {
  assertFullDistribution(evaluateAppConfig({ APP_VARIANT: 'store' }));
});

test('fixture config is omitted from ordinary builds', () => {
  assert.deepEqual(appConfig.resolveE2eExtra({}), {});
  assert.deepEqual(appConfig.resolveE2eExtra({
    E2E_FIXTURE_BASE_URL: 'https://fixtures.example',
  }), {});
});

test('fixture config is normalized for explicit test builds', () => {
  assert.deepEqual(appConfig.resolveE2eExtra({
    E2E_TEST_MODE: '1',
    E2E_FIXTURE_BASE_URL: ' https://fixtures.example/root/// ',
  }), {
    e2eTestMode: true,
    e2eFixtureBaseUrl: 'https://fixtures.example/root',
  });
});

test('fixture test builds require an HTTPS endpoint', () => {
  assert.throws(
    () => appConfig.resolveE2eExtra({
      E2E_TEST_MODE: '1',
      E2E_FIXTURE_BASE_URL: 'http://fixtures.example',
    }),
    /E2E_FIXTURE_BASE_URL must use HTTPS/,
  );
});
