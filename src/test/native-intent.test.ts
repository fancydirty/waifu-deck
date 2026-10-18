import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GOOGLE_OAUTH_SCHEME, OAUTH_CALLBACK_PREFIXES, redirectSystemPath } from '@/app/+native-intent';
import { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI } from '@/features/cloud-store/google-oauth';
import { MICROSOFT_REDIRECT_URI } from '@/features/cloud-store/microsoft-oauth';

const MICROSOFT_CALLBACK = `${MICROSOFT_REDIRECT_URI}?code=M.C553_SN1.2.U.abc&state=SQ9nYauC5SznLXIC5srq8w`;
// The shape Task 1 captured for route A (evidence a2): state, code, scope.
const GOOGLE_CALLBACK = `${GOOGLE_REDIRECT_URI}?state=Zm9vYmFyYmF6cXV4&code=4/0AVMBsJh-abc&scope=https://www.googleapis.com/auth/drive.file`;

describe('redirectSystemPath', () => {
  it('drops the OneDrive callback when it arrives as a running-app url event', () => {
    expect(redirectSystemPath({ path: MICROSOFT_CALLBACK, initial: false })).toBeNull();
  });

  it('drops the OneDrive callback even on a cold start, since the in-flight sign-in cannot resume', () => {
    expect(redirectSystemPath({ path: MICROSOFT_CALLBACK, initial: true })).toBeNull();
  });

  it('drops the Google (route A) callback as a running-app url event and on a cold start', () => {
    expect(redirectSystemPath({ path: GOOGLE_CALLBACK, initial: false })).toBeNull();
    expect(redirectSystemPath({ path: GOOGLE_CALLBACK, initial: true })).toBeNull();
  });

  it('drops an error callback too, for both providers, since every url under a prefix belongs to the browser polyfill', () => {
    for (const initial of [false, true]) {
      expect(redirectSystemPath({ path: `${MICROSOFT_REDIRECT_URI}?error=access_denied&state=x`, initial })).toBeNull();
      expect(redirectSystemPath({ path: `${GOOGLE_REDIRECT_URI}?error=access_denied&state=x`, initial })).toBeNull();
    }
  });

  it('drops every url under each prefix in the list, for both initial values', () => {
    expect(OAUTH_CALLBACK_PREFIXES.length).toBeGreaterThanOrEqual(2);
    for (const prefix of OAUTH_CALLBACK_PREFIXES) {
      for (const initial of [false, true]) {
        expect(redirectSystemPath({ path: `${prefix}anything?x=1`, initial })).toBeNull();
      }
    }
  });

  it('pins both provider redirects to live under a prefix in OAUTH_CALLBACK_PREFIXES', () => {
    expect(OAUTH_CALLBACK_PREFIXES.some((p) => MICROSOFT_REDIRECT_URI.startsWith(p))).toBe(true);
    expect(OAUTH_CALLBACK_PREFIXES.some((p) => GOOGLE_REDIRECT_URI.startsWith(p))).toBe(true);
  });

  it('passes other app links through unchanged regardless of initial', () => {
    expect(redirectSystemPath({ path: 'waifudeck://image/12', initial: false })).toBe('waifudeck://image/12');
    expect(redirectSystemPath({ path: 'waifudeck://image/12', initial: true })).toBe('waifudeck://image/12');
    expect(redirectSystemPath({ path: '/settings', initial: false })).toBe('/settings');
    expect(redirectSystemPath({ path: '/settings', initial: true })).toBe('/settings');
  });

  it('matches a prefix only at the start of the url, never mid-string — for every prefix in the list', () => {
    const decoys = [
      'waifudeck://image/waifudeck://auth/onedrive',
      `waifudeck://image/${GOOGLE_REDIRECT_URI}`,
      ...OAUTH_CALLBACK_PREFIXES.map((p) => `/settings?next=${p}x`),
    ];
    for (const decoy of decoys) {
      expect(redirectSystemPath({ path: decoy, initial: false })).toBe(decoy);
      expect(redirectSystemPath({ path: decoy, initial: true })).toBe(decoy);
    }
  });

  it('never throws on garbage input and passes it through unchanged', () => {
    for (const initial of [false, true]) {
      expect(redirectSystemPath({ path: '', initial })).toBe('');
      expect(redirectSystemPath({ path: 'not a url', initial })).toBe('not a url');
      for (const junk of [undefined, null, 42, {}, ['waifudeck://auth/x']] as unknown as string[]) {
        expect(() => redirectSystemPath({ path: junk, initial })).not.toThrow();
        expect(redirectSystemPath({ path: junk, initial })).toBe(junk);
      }
    }
  });

  it('is discoverable by Expo Router as the top-level +native-intent module', () => {
    const filePath = join(__dirname, '..', 'app', '+native-intent.ts');
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('route-A app scheme (spec §4.3 补裁 4, 14)', () => {
  // Expo SDK 56 app config: every `scheme` entry must match this
  // (https://docs.expo.dev/versions/v56.0.0/config/app/#scheme).
  const EXPO_SCHEME = /^[a-z][a-z0-9+.-]*$/;

  it('GOOGLE_OAUTH_SCHEME is a legal Expo scheme: all lowercase, letters/digits/+/./- only', () => {
    expect(GOOGLE_OAUTH_SCHEME).toMatch(EXPO_SCHEME);
  });

  it('GOOGLE_OAUTH_SCHEME is the reverse client id of the app client, and it is the scheme of GOOGLE_REDIRECT_URI', () => {
    expect(GOOGLE_OAUTH_SCHEME).toBe(GOOGLE_CLIENT_ID.split('.').reverse().join('.'));
    expect(GOOGLE_OAUTH_SCHEME).toBe('com.googleusercontent.apps.550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec');
    expect(GOOGLE_REDIRECT_URI).toBe(`${GOOGLE_OAUTH_SCHEME}:/oauth2redirect`);
  });

  it('app.json registers exactly the app scheme and the route-A scheme, each a legal Expo scheme, so a typo there fails here rather than at prebuild', () => {
    const appJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'app.json'), 'utf8')) as { expo: { scheme: unknown } };
    expect(appJson.expo.scheme).toEqual(['waifudeck', GOOGLE_OAUTH_SCHEME]);
    for (const scheme of appJson.expo.scheme as string[]) expect(scheme).toMatch(EXPO_SCHEME);
  });
});
