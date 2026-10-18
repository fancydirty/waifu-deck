import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const withReleaseSigning = require(path.join(root, 'plugins/with-release-signing.js'));
const {
  RELEASE_SIGNING_ENV,
  RELEASE_SIGNING_DEFAULT_PATH,
  transformBuildGradle,
} = withReleaseSigning;

// The signing/buildTypes region of the `expo prebuild` template for Expo 56 /
// RN 0.85, byte-for-byte (captured 2026-09-18 from a generated
// android/app/build.gradle). The plugin anchors on these lines, so template
// drift must surface as a loud failure, never as a silently debug-signed APK.
const TEMPLATE = `android {
    namespace 'app.waifudeck.mobile'
    defaultConfig {
        applicationId 'app.waifudeck.mobile'
        versionCode 4
        versionName "1.2.0"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }
}
`;

// A named block inside a top-level region (`signingConfigs` or `buildTypes`),
// so the buildTypes.release block is never confused with signingConfigs.release.
function section(source, region, name) {
  const regionStart = source.indexOf(`    ${region} {`);
  assert.notEqual(regionStart, -1, `${region} region present`);
  const start = source.indexOf(`        ${name} {`, regionStart);
  assert.notEqual(start, -1, `${region}.${name} block present`);
  const end = source.indexOf('\n        }\n', start);
  return source.slice(start, end);
}

test('#13: release builds sign with the owner key read from a properties file outside the repo', () => {
  const out = transformBuildGradle(TEMPLATE);

  assert.equal(RELEASE_SIGNING_ENV, 'WAIFU_DECK_RELEASE_SIGNING');
  assert.equal(
    RELEASE_SIGNING_DEFAULT_PATH,
    '.config/waifu-deck/signing/release.properties',
  );
  // The env var and the default path both appear in the generated gradle, so a
  // build machine can relocate the secret without editing the checked-in plugin.
  assert.ok(out.includes(`System.getenv('${RELEASE_SIGNING_ENV}')`));
  assert.ok(out.includes(RELEASE_SIGNING_DEFAULT_PATH));

  const release = section(out, 'buildTypes', 'release');
  // The signingConfig assignment resolves to signingConfigs.release (or null
  // when the properties file is absent); formatting is free, the target is not.
  assert.ok(/signingConfig\b[\s\S]*?signingConfigs\.release/u.test(release), 'release → signingConfigs.release');
  assert.ok(!/signingConfigs\.debug/u.test(release), 'release never falls back to the debug key');
  assert.ok(!release.includes("'android'"), 'no template password in the release block');
  assert.ok(!release.includes('androiddebugkey'), 'no template alias in the release block');

  // A release signing config exists inside signingConfigs, with all four
  // fields sourced from the properties file, never from literals.
  const configs = out.slice(out.indexOf('    signingConfigs {'), out.indexOf('    buildTypes {'));
  assert.ok(/\n        release \{/u.test(configs), 'signingConfigs.release declared');
  for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
    assert.ok(
      new RegExp(`release \\{[\\s\\S]*?${field} `, 'u').test(configs),
      `${field} configured for release`,
    );
  }
  // The signingConfigs.release block itself carries no template literal.
  const releaseSigning = section(out, 'signingConfigs', 'release');
  assert.ok(!releaseSigning.includes("'android'"), 'no template password in signingConfigs.release');
  assert.ok(!releaseSigning.includes('androiddebugkey'), 'no template alias in signingConfigs.release');

  // Debug stays exactly what the template shipped.
  const debug = section(out, 'buildTypes', 'debug');
  assert.ok(debug.includes('signingConfig signingConfigs.debug'));
});

test('#13: a missing properties file leaves the release UNSIGNED rather than debug-signed', () => {
  const out = transformBuildGradle(TEMPLATE);
  // The gradle only attaches the release signing config when the properties
  // file exists; otherwise `signingConfig` is null and Gradle emits
  // app-release-unsigned.apk. Nothing installable is ever produced by accident
  // with the world-shared debug certificate.
  const release = section(out, 'buildTypes', 'release');
  assert.ok(/exists\(\)/u.test(release), 'presence of the properties file is checked');
  assert.ok(/\?\s*signingConfigs\.release\s*:\s*null/u.test(release), 'signed with release, else null (unsigned) — never debug');
});

test('#13: the transform is idempotent', () => {
  const once = transformBuildGradle(TEMPLATE);
  assert.equal(transformBuildGradle(once), once);
});

test('#13: template drift fails loudly instead of silently debug-signing', () => {
  const drifted = TEMPLATE.replace('signingConfig signingConfigs.debug\n            def enableShrinkResources', 'def enableShrinkResources');
  assert.throws(() => transformBuildGradle(drifted), /release signing anchor/u);
  assert.throws(() => transformBuildGradle('android {\n}\n'), /release signing anchor|signingConfigs anchor/u);
});
