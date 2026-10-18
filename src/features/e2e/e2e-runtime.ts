import Constants from 'expo-constants';

export type E2eRuntimeConfig = Readonly<{
  fixtureBaseUrl: string;
}>;

export function normalizeFixtureBaseUrl(value: unknown): string {
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
    throw new Error('E2E fixture base URL must use HTTPS');
  }
  return candidate.replace(/\/+$/, '');
}

export function e2eRuntimeConfigFor(extra: unknown): E2eRuntimeConfig | null {
  if (
    extra === null
    || typeof extra !== 'object'
    || (extra as Record<string, unknown>).e2eTestMode !== true
  ) {
    return null;
  }
  return {
    fixtureBaseUrl: normalizeFixtureBaseUrl(
      (extra as Record<string, unknown>).e2eFixtureBaseUrl,
    ),
  };
}

export function configuredE2eRuntimeConfig(): E2eRuntimeConfig | null {
  return e2eRuntimeConfigFor(Constants.expoConfig?.extra);
}
