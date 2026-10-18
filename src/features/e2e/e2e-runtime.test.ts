import {
  e2eRuntimeConfigFor,
  normalizeFixtureBaseUrl,
} from '@/features/e2e/e2e-runtime';

describe('E2E runtime configuration', () => {
  it('is disabled unless the explicit build flag is true', () => {
    expect(e2eRuntimeConfigFor(undefined)).toBeNull();
    expect(e2eRuntimeConfigFor({
      e2eTestMode: false,
      e2eFixtureBaseUrl: 'https://fixtures.example',
    })).toBeNull();
    expect(e2eRuntimeConfigFor({
      e2eFixtureBaseUrl: 'https://fixtures.example',
    })).toBeNull();
  });

  it('normalizes an enabled HTTPS fixture endpoint', () => {
    expect(e2eRuntimeConfigFor({
      e2eTestMode: true,
      e2eFixtureBaseUrl: ' https://fixtures.example/root/// ',
    })).toEqual({
      fixtureBaseUrl: 'https://fixtures.example/root',
    });
  });

  it.each([
    '',
    '   ',
    'http://fixtures.example',
    'file:///tmp/fixtures',
    'not a URL',
  ])('rejects an unsafe fixture endpoint: %p', (value) => {
    expect(() => normalizeFixtureBaseUrl(value)).toThrow(
      'E2E fixture base URL must use HTTPS',
    );
  });
});
