import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const withNetworkTuning = require(path.join(root, 'plugins/with-network-tuning.js'));
const { injectNetworkTuning } = withNetworkTuning;

const MAIN_APPLICATION_KT = `package app.waifudeck.mobile

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication

import expo.modules.ApplicationLifecycleDispatcher

class MainApplication : Application(), ReactApplication {

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
`;

const REQUIRED_IMPORTS = [
  'import com.facebook.react.modules.network.OkHttpClientProvider',
  'import java.net.Inet4Address',
  'import java.util.concurrent.TimeUnit',
  'import okhttp3.ConnectionPool',
  'import okhttp3.Dns',
];

test('K6-1d: the OkHttp factory is installed into MainApplication.onCreate', () => {
  const out = injectNetworkTuning(MAIN_APPLICATION_KT);

  assert.ok(
    out.includes('OkHttpClientProvider.setOkHttpClientFactory'),
    'the global RN OkHttp factory hook must be installed',
  );
  assert.ok(
    // Asserting the whole expression, not just the `Inet4Address` token: the
    // token also appears in the import block, so a weaker assertion survives
    // deleting the sort.
    out.includes('.sortedBy { if (it is Inet4Address) 0 else 1 }'),
    'DNS results must be ordered by address family so IPv4 is tried first',
  );
  assert.ok(
    out.includes('Dns.SYSTEM.lookup(hostname)'),
    'the custom DNS must delegate to the system resolver, not replace it',
  );
  assert.ok(
    out.includes('ConnectionPool(10, 10, TimeUnit.MINUTES)'),
    'the connection pool must keep 10 connections warm for 10 minutes',
  );

  const factoryLine = out.indexOf('OkHttpClientProvider.setOkHttpClientFactory');
  const superOnCreate = out.indexOf('super.onCreate()');
  assert.ok(superOnCreate !== -1 && factoryLine > superOnCreate, 'the factory is installed after super.onCreate()');
  assert.ok(
    factoryLine < out.indexOf('override fun onConfigurationChanged'),
    'the factory is installed inside onCreate, not a later method',
  );
});

test('K6-1d: the imports the injected factory needs are added once', () => {
  const out = injectNetworkTuning(MAIN_APPLICATION_KT);

  for (const line of REQUIRED_IMPORTS) {
    const occurrences = out.split(`${line}\n`).length - 1;
    assert.equal(occurrences, 1, `${line} must appear exactly once`);
  }
  assert.ok(out.startsWith('package app.waifudeck.mobile\n'), 'the package declaration stays first');
});

test('K6-1d: injection is idempotent across repeated prebuilds', () => {
  const once = injectNetworkTuning(MAIN_APPLICATION_KT);
  const twice = injectNetworkTuning(once);

  assert.equal(twice, once, 'a second run must not insert the block or imports again');
  assert.equal(
    twice.split('OkHttpClientProvider.setOkHttpClientFactory').length - 1,
    1,
    'the factory block must not be duplicated',
  );
});

test('K6-1d: a non-Kotlin MainApplication is a hard failure, not a silent skip', async () => {
  const captured = [];
  const config = await withNetworkTuning({ name: 'Waifu Deck', slug: 'waifu-deck' });
  const mainApplicationMod = config.mods?.android?.mainApplication;
  assert.equal(typeof mainApplicationMod, 'function', 'the plugin registers an android mainApplication mod');

  await assert.rejects(
    async () => mainApplicationMod({
      modResults: { language: 'java', contents: 'class MainApplication {}' },
      modRequest: {},
    }),
    /Kotlin/,
    'a Java MainApplication must throw instead of shipping an untuned client',
  );
  assert.deepEqual(captured, []);
});

// okhttp3.Dns is a plain `interface` (not a Kotlin `fun interface`) in okhttp
// 4.9.2, which React Native 0.85 pins, and still in 4.12.0. The SAM-constructor
// shorthand `Dns { hostname -> ... }` therefore does not compile; the injected
// Kotlin must use an explicit object expression. Nothing in the JS test suite
// compiles Kotlin, so this guard is the only thing standing between a plan
// typo and a broken `expo prebuild` + Gradle run.
test('K6-1d: the Dns override uses an object expression, not a fun-interface lambda', () => {
  const out = injectNetworkTuning(MAIN_APPLICATION_KT);

  assert.ok(
    out.includes('object : Dns'),
    'okhttp3.Dns is not a fun interface in 4.9.2/4.12.0; it needs an object expression',
  );
  assert.ok(
    !/(?<!:\s)\bDns\s*\{/.test(out),
    'the `Dns { ... }` SAM-constructor shorthand does not compile against okhttp 4.9.2',
  );
  assert.ok(
    out.includes('override fun lookup(hostname: String): List<InetAddress>'),
    'the override must match okhttp3.Dns.lookup exactly',
  );
  assert.ok(
    out.includes('import java.net.InetAddress\n'),
    'the lookup return type needs java.net.InetAddress imported',
  );
});
