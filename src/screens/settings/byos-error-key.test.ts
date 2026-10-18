import i18n from '@/i18n';
import { errorKey, signInFlowErrorKey, type SignInProvider } from '@/screens/settings/byos-error-key';

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const;
// i18n.exists() falls back to English (fallbackLng: 'en'), so it would report a key
// missing from ja as present. Read each locale's own resource instead.
const definedIn = (lng: string, key: string) => i18n.getResource(lng, 'translation', key) !== undefined;

const CASES: [Parameters<typeof errorKey>[0], string][] = [
  [{ category: 'network' }, 'settings.byos.error.network'],
  [{ category: 'credential_rejected' }, 'settings.byos.error.credentialRejected'],
  [{ category: 'not_s3' }, 'settings.byos.error.notS3'],
  [{ category: 'not_webdav' }, 'settings.byos.error.notWebdav'],
  [{ category: 'not_onedrive' }, 'settings.byos.error.notOnedrive'],
  [{ category: 'not_gdrive' }, 'settings.byos.error.notGdrive'],
  [{ category: 'reauth_required' }, 'settings.byos.error.reauthRequired'],
  [{ category: 'sign_in_cancelled' }, 'settings.byos.error.signInCancelled'],
  [{ category: 'insecure_url' }, 'settings.byos.error.insecureUrl'],
  [{ category: 'meta_corrupt', detail: 'meta_absent' }, 'settings.byos.error.metaAbsent'],
  [{ category: 'meta_corrupt' }, 'settings.byos.error.metaCorrupt'],
  [{ category: 'wrong_password' }, 'settings.byos.error.wrongPassword'],
  [{ category: 'password_mismatch', detail: 'password_required' }, 'settings.byos.error.passwordRequired'],
  [{ category: 'password_mismatch', detail: 'confirmation_mismatch' }, 'settings.byos.error.passwordMismatch'],
];

test.each(CASES)('%o → %s, defined in all four locales', (failure, key) => {
  expect(errorKey(failure)).toBe(key);
  for (const lng of LOCALES) expect(definedIn(lng, key)).toBe(true);
});

// `signInFlowErrorKey` is errorKey's sign-in/reauth-flow sibling, shared by
// both drive providers: a `network` failure there is the provider's sign-in
// page or API (Microsoft's, or Google's), not this device's own vault, so it
// gets per-provider copy naming the provider the user signed in with. Every
// other category passes through to the shared `errorKey` switch unchanged.
const SIGN_IN_CASES: [SignInProvider, Parameters<typeof signInFlowErrorKey>[0], string][] = [
  ['onedrive', { category: 'network' }, 'settings.byos.onedrive.signInNetwork'],
  ['gdrive', { category: 'network' }, 'settings.byos.gdrive.signInNetwork'],
  ['onedrive', { category: 'credential_rejected' }, 'settings.byos.error.credentialRejected'],
  ['gdrive', { category: 'credential_rejected' }, 'settings.byos.error.credentialRejected'],
  ['onedrive', { category: 'reauth_required' }, 'settings.byos.error.reauthRequired'],
  ['gdrive', { category: 'reauth_required' }, 'settings.byos.error.reauthRequired'],
  ['gdrive', { category: 'not_gdrive' }, 'settings.byos.error.notGdrive'],
];

test.each(SIGN_IN_CASES)('signInFlowErrorKey(%s): %o → %s, defined in all four locales', (provider, failure, key) => {
  expect(signInFlowErrorKey(failure, provider)).toBe(key);
  for (const lng of LOCALES) expect(definedIn(lng, key)).toBe(true);
});

// The product rule behind the shared copy (plan Task 8, the reuse check): the
// sentence the user sees names the provider they actually signed in with and
// never the other one. Walked over every category, every locale, rendered.
const MICROSOFT = /OneDrive|Microsoft|微软|微軟|マイクロソフト/;
const GOOGLE = /Google|谷歌|グーグル/;
const WRONG: Record<SignInProvider, RegExp> = { onedrive: GOOGLE, gdrive: MICROSOFT };
const RIGHT: Record<SignInProvider, RegExp> = { onedrive: /Microsoft/, gdrive: /Google/ };
// The one category each flow can never produce: the other provider's own
// "did not answer as expected" (it names that provider by design).
const OTHER_PROVIDER_CATEGORY: Record<SignInProvider, string> = { onedrive: 'not_gdrive', gdrive: 'not_onedrive' };

describe.each(LOCALES)('%s: sign-in copy names the right provider', (lng) => {
  test.each(['onedrive', 'gdrive'] as const)('%s: no sign-in-flow sentence names the other provider', (provider) => {
    for (const [failure] of CASES.filter(([f]) => f.category !== OTHER_PROVIDER_CATEGORY[provider])) {
      expect(i18n.t(signInFlowErrorKey(failure, provider), { lng })).not.toMatch(WRONG[provider]);
    }
  });

  test.each(['onedrive', 'gdrive'] as const)('%s: the sign-in network failure names this provider', (provider) => {
    expect(i18n.t(signInFlowErrorKey({ category: 'network' }, provider), { lng })).toMatch(RIGHT[provider]);
  });

  // Both reauth sentences render where the provider is not known from the
  // lock status (the reauth lock row, the unlock row's shared errorKey), so
  // they name neither; the provider is named by the row's action button.
  test.each(['settings.byos.locked.reauthRequired', 'settings.byos.error.reauthRequired'])('%s names neither provider', (key) => {
    const text = i18n.t(key, { lng });
    expect(text).not.toMatch(MICROSOFT);
    expect(text).not.toMatch(GOOGLE);
  });

  test('the gdrive block never names Microsoft; the onedrive block never names Google', () => {
    for (const [block, wrong] of [['gdrive', MICROSOFT], ['onedrive', GOOGLE]] as const) {
      const leaves = i18n.t(`settings.byos.${block}`, { lng, returnObjects: true }) as Record<string, string>;
      for (const text of Object.values(leaves)) expect(text).not.toMatch(wrong);
    }
  });
});

// Keys the Drive card renders (added in Task 8, before the card existed, so the
// locale static-key scan could not see them; kept as the four-locale check).
// `needsGoogle` is the 补裁 12 caveat and has no OneDrive counterpart.
const GDRIVE_KEYS = ['intro', 'signIn', 'signedInAs', 'probeEmpty', 'reauth', 'needsGoogle', 'signInNetwork'] as const;

test.each(GDRIVE_KEYS)('settings.byos.gdrive.%s is defined in all four locales', (leaf) => {
  for (const lng of LOCALES) expect(definedIn(lng, `settings.byos.gdrive.${leaf}`)).toBe(true);
});

test('settings.byos.onedrive has no needsGoogle-style caveat (OneDrive reachability was measured; P12-C)', () => {
  for (const lng of LOCALES) expect(definedIn(lng, 'settings.byos.onedrive.needsGoogle')).toBe(false);
});

test('the zh-Hans caveat carries the spec sentence 「需要能访问 Google」 (补裁 12)', () => {
  expect(i18n.t('settings.byos.gdrive.needsGoogle', { lng: 'zh-Hans' })).toContain('需要能访问 Google');
});

// The old shared key named Microsoft; it moved into the onedrive block, and
// leaving it behind would invite a Google path to reuse it.
test('settings.byos.error.signInNetwork is gone from all four locales', () => {
  for (const lng of LOCALES) expect(definedIn(lng, 'settings.byos.error.signInNetwork')).toBe(false);
});

// P12-D Task 9 deleted the `backend_unavailable` lock (every binding kind now
// resolves), which orphaned both of its sentences; Task 11 deleted the picker's
// coming-soon row (every card is live), which orphaned `comingSoon`. The locale
// keys are untyped, so only this test notices one left behind.
test.each([
  'settings.byos.locked.backendUnavailable',
  'settings.libraryCloud.lockedReason.backend_unavailable',
  'settings.byos.locations.comingSoon',
])('%s is gone from all four locales', (key) => {
  for (const lng of LOCALES) expect(definedIn(lng, key)).toBe(false);
});
