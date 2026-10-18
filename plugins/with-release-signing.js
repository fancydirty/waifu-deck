const { withAppBuildGradle } = require('@expo/config-plugins');

// Board #13 (2026-09-18): every APK this project had ever built was signed with
// the Expo prebuild template's `debug.keystore` — a key every Expo project in the
// world ships with (CN=Android Debug, SHA-1 5E:8F:16:06:…). The template's
// `release { signingConfig signingConfigs.debug }` is the reason. A public app
// signed with that key can be "updated" by anyone (same package + same
// certificate = same app, same uid, same private data), and registering its
// SHA-1 with Google would let any template-signed app impersonate Waifu Deck.
//
// This plugin rewrites the generated android/app/build.gradle so release builds
// sign with a key ONLY the owner holds, read from a properties file kept
// OUTSIDE the repository:
//
//   ~/.config/waifu-deck/signing/release.properties   (0600)
//     storeFile=/absolute/path/to/release.keystore
//     storePassword=…
//     keyAlias=…
//     keyPassword=…
//
// `WAIFU_DECK_RELEASE_SIGNING=/other/path.properties` relocates it. When the
// file is absent the release build is left UNSIGNED (Gradle writes
// app-release-unsigned.apk) — never silently debug-signed. Forks must create
// their own key; the debug key stays what it always was for debug builds.
const RELEASE_SIGNING_ENV = 'WAIFU_DECK_RELEASE_SIGNING';
const RELEASE_SIGNING_DEFAULT_PATH = '.config/waifu-deck/signing/release.properties';
const TAG = 'waifu-deck-release-signing';

const SIGNING_CONFIG_ANCHOR = /^    signingConfigs \{\n        debug \{\n/mu;
const RELEASE_DEBUG_ANCHOR = /^(        release \{\n(?:            \/\/[^\n]*\n)*)            signingConfig signingConfigs\.debug\n/mu;

const RELEASE_SIGNING_BLOCK = `        // @${TAG}: see plugins/with-release-signing.js. The owner's private key,
        // never the world-shared template debug.keystore. Missing file ⇒ unsigned.
        release {
            def waifuSigningPath = System.getenv('${RELEASE_SIGNING_ENV}')
                ?: "\${System.getProperty('user.home')}/${RELEASE_SIGNING_DEFAULT_PATH}"
            def waifuSigningFile = file(waifuSigningPath)
            if (waifuSigningFile.exists()) {
                def waifuSigning = new Properties()
                waifuSigningFile.withInputStream { waifuSigning.load(it) }
                storeFile file(waifuSigning.getProperty('storeFile'))
                storePassword waifuSigning.getProperty('storePassword')
                keyAlias waifuSigning.getProperty('keyAlias')
                keyPassword waifuSigning.getProperty('keyPassword')
            }
        }
`;

const RELEASE_BUILD_TYPE_LINES = `            // @${TAG}: release is signed by the owner's key or left unsigned;
            // it is never signed by the template debug key (board #13).
            signingConfig file(System.getenv('${RELEASE_SIGNING_ENV}')
                ?: "\${System.getProperty('user.home')}/${RELEASE_SIGNING_DEFAULT_PATH}").exists()
                ? signingConfigs.release
                : null
`;

function transformBuildGradle(source) {
  if (source.includes(`@${TAG}`)) return source;

  if (!SIGNING_CONFIG_ANCHOR.test(source)) {
    throw new Error(
      `with-release-signing: signingConfigs anchor not found in app/build.gradle — `
        + 'the Expo template changed; refusing to build a possibly debug-signed release.',
    );
  }
  if (!RELEASE_DEBUG_ANCHOR.test(source)) {
    throw new Error(
      `with-release-signing: release signing anchor not found in app/build.gradle — `
        + 'the Expo template changed; refusing to build a possibly debug-signed release.',
    );
  }

  const withSigningConfig = source.replace(
    SIGNING_CONFIG_ANCHOR,
    (match) => `${match.slice(0, '    signingConfigs {\n'.length)}${RELEASE_SIGNING_BLOCK}${match.slice('    signingConfigs {\n'.length)}`,
  );
  return withSigningConfig.replace(
    RELEASE_DEBUG_ANCHOR,
    (_match, head) => `${head}${RELEASE_BUILD_TYPE_LINES}`,
  );
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('with-release-signing: app/build.gradle must be Groovy');
    }
    mod.modResults.contents = transformBuildGradle(mod.modResults.contents);
    return mod;
  });

module.exports = withReleaseSigning;
module.exports.transformBuildGradle = transformBuildGradle;
module.exports.RELEASE_SIGNING_ENV = RELEASE_SIGNING_ENV;
module.exports.RELEASE_SIGNING_DEFAULT_PATH = RELEASE_SIGNING_DEFAULT_PATH;
