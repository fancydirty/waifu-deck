function normalizeE2eFixtureBaseUrl(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:'
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
    ) {
      throw new Error('unsafe');
    }
  } catch {
    throw new Error('E2E_FIXTURE_BASE_URL must use HTTPS');
  }
  return candidate.replace(/\/+$/, '');
}

function resolveE2eExtra(env = process.env) {
  if (env.E2E_TEST_MODE !== '1') return {};
  return {
    e2eTestMode: true,
    e2eFixtureBaseUrl: normalizeE2eFixtureBaseUrl(
      env.E2E_FIXTURE_BASE_URL,
    ),
  };
}

module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    'expo-background-task',
    './plugins/with-network-tuning',
    './plugins/with-release-signing',
  ],
  extra: {
    ...config.extra,
    ...resolveE2eExtra(),
  },
});

module.exports.resolveE2eExtra = resolveE2eExtra;
