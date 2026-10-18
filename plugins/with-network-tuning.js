const { withMainApplication } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const IMPORTS = [
  'import com.facebook.react.modules.network.OkHttpClientProvider',
  'import java.net.Inet4Address',
  'import java.net.InetAddress',
  'import java.util.concurrent.TimeUnit',
  'import okhttp3.ConnectionPool',
  'import okhttp3.Dns',
];

// K6-1d: prefer IPv4 (this network's IPv4 is proxied and stable; IPv6 goes
// direct and stalls) and keep 10 warm connections for 10 minutes so a save
// after a few idle minutes never pays a cold TLS handshake.
// `okhttp3.Dns` is a plain interface (not a Kotlin `fun interface`) in okhttp
// 4.9.2 — the version React Native 0.85 pins — so it needs an object
// expression rather than the SAM-constructor shorthand. `this` inside the
// factory lambda is still MainApplication: Kotlin lambdas do not rebind it.
const FACTORY = `    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(this)
        .dns(object : Dns {
          override fun lookup(hostname: String): List<InetAddress> =
            Dns.SYSTEM.lookup(hostname).sortedBy { if (it is Inet4Address) 0 else 1 }
        })
        .connectionPool(ConnectionPool(10, 10, TimeUnit.MINUTES))
        .build()
    }`;

function injectNetworkTuning(source) {
  let out = source;
  for (const line of IMPORTS) {
    if (!out.includes(line)) out = out.replace(/^(import [^\n]+\n)/m, `${line}\n$1`);
  }
  return mergeContents({
    src: out,
    newSrc: FACTORY,
    anchor: /super\.onCreate\(\)/,
    offset: 1,
    tag: 'waifu-deck-network-tuning',
    comment: '//',
  }).contents;
}

const withNetworkTuning = (config) =>
  withMainApplication(config, (mod) => {
    if (mod.modResults.language !== 'kt') throw new Error('MainApplication must be Kotlin');
    mod.modResults.contents = injectNetworkTuning(mod.modResults.contents);
    return mod;
  });

module.exports = withNetworkTuning;
module.exports.injectNetworkTuning = injectNetworkTuning;
