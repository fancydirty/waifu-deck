import { sha256 } from '@noble/hashes/sha2.js';

import { base64Url } from '@/features/cloud-store/base64url';
import {
  GOOGLE_AUTHORIZE_URL, GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, GOOGLE_SCOPE, GOOGLE_TOKEN_REQUEST_TIMEOUT_MS, GOOGLE_TOKEN_URL,
} from '@/features/cloud-store/google-oauth';
import i18n from '@/i18n';
import { signInFlowErrorKey } from '@/screens/settings/byos-error-key';

import type { S3FetchPort } from './s3-transport';
import { createGoogleSignIn, type GoogleSignInOutcome } from './google-sign-in';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const random = async (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) % 256);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Google's token endpoint for the authorization_code grant, as Task 1 measured
 * it for the iOS-type app client (evidence a2): no secret, PKCE verified, and
 * a code is single-use (evidence c7: a reused code answers invalid_grant).
 */
function fakeGoogleTokenEndpoint() {
  const codes = new Map<string, { challenge: string; used: boolean }>();
  const calls: { url: string; form: URLSearchParams }[] = [];
  let seq = 0;
  const fetch: S3FetchPort = async (url, init) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, form });
    if (url !== GOOGLE_TOKEN_URL) return json(404, { error: 'not_found' });
    if (form.get('client_id') !== GOOGLE_CLIENT_ID || form.has('client_secret')) return json(401, { error: 'invalid_client' });
    if (form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== GOOGLE_REDIRECT_URI) return json(400, { error: 'invalid_request', error_description: 'bad grant or redirect' });
    const issued = codes.get(form.get('code') ?? '');
    if (issued === undefined || issued.used) return json(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' });
    issued.used = true;
    if (base64Url(sha256(new TextEncoder().encode(form.get('code_verifier') ?? ''))) !== issued.challenge) return json(400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' });
    seq += 1;
    return json(200, { access_token: `ya29.at-${seq}`, refresh_token: `1//rt-${seq}`, expires_in: 3599, scope: GOOGLE_SCOPE, token_type: 'Bearer' });
  };
  return {
    fetch,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === GOOGLE_TOKEN_URL).length,
    authCode(challenge: string) {
      seq += 1;
      const code = `4/0A-code-${seq}`;
      codes.set(code, { challenge, used: false });
      return code;
    },
  };
}

/** A browser session that "signs in" and hands back the redirect Google would send, carrying the authorize URL's own state. */
const redirectWith = (query: (q: URLSearchParams) => string) => async (url: string) => ({
  type: 'success',
  url: `${GOOGLE_REDIRECT_URI}?${query(new URL(url).searchParams)}`,
});

describe('createGoogleSignIn', () => {
  test('opens Google\'s authorize URL with the route-A redirect; a success redirect with the right state is exchanged for tokens (PKCE verifier checked by the fake, no secret sent)', async () => {
    const google = fakeGoogleTokenEndpoint();
    const opened: string[] = [];
    const signIn = createGoogleSignIn({
      fetchImpl: google.fetch, random,
      openAuthSession: async (url, redirect) => {
        opened.push(url, redirect);
        const q = new URL(url).searchParams;
        return { type: 'success', url: `${GOOGLE_REDIRECT_URI}?state=${q.get('state')}&code=${google.authCode(q.get('code_challenge')!)}&scope=${encodeURIComponent(GOOGLE_SCOPE)}` };
      },
    });
    const out = await signIn();
    expect(out).toEqual({ ok: true, tokens: { accessToken: expect.stringMatching(/^ya29\./), refreshToken: expect.stringMatching(/^1\/\//), expiresAt: expect.any(Number) } });
    const url = new URL(opened[0]!);
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_URL);
    expect(opened[1]).toBe(GOOGLE_REDIRECT_URI);
    expect(opened[1]).toBe('com.googleusercontent.apps.550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec:/oauth2redirect');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(GOOGLE_REDIRECT_URI);
    // Route A (Task 1): the app client authorizes with neither access_type nor a consent prompt, only the account chooser.
    expect(q.get('prompt')).toBe('select_account');
    expect(q.has('access_type')).toBe(false);
    expect(q.get('code_challenge')).toBe(base64Url(sha256(new TextEncoder().encode(base64Url(await random(32))))));
    expect(google.calls.every((c) => !c.form.has('client_secret'))).toBe(true);
  });

  test('CSRF: a redirect whose state is not this attempt\'s is credential_rejected/state_mismatch, and its code is never sent to the token endpoint — even when it also carries an error', async () => {
    const google = fakeGoogleTokenEndpoint();
    const code = google.authCode('any');
    const forged = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: async () => ({ type: 'success', url: `${GOOGLE_REDIRECT_URI}?state=FORGED&code=${code}` }) });
    expect(await forged()).toEqual({ ok: false, category: 'credential_rejected', detail: 'state_mismatch' });
    const forgedDenied = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: async () => ({ type: 'success', url: `${GOOGLE_REDIRECT_URI}?state=FORGED&error=access_denied` }) });
    expect(await forgedDenied()).toEqual({ ok: false, category: 'credential_rejected', detail: 'state_mismatch' });
    const noState = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: async () => ({ type: 'success', url: `${GOOGLE_REDIRECT_URI}?code=${code}` }) });
    expect(await noState()).toEqual({ ok: false, category: 'credential_rejected', detail: 'state_mismatch' });
    expect(google.tokenCalls()).toBe(0);
  });

  test.each(['cancel', 'dismiss', 'opened', 'locked'])('a browser session that ends as %s (not success) is sign_in_cancelled with no token call', async (type) => {
    const google = fakeGoogleTokenEndpoint();
    const signIn = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: async () => ({ type }) });
    expect(await signIn()).toEqual({ ok: false, category: 'sign_in_cancelled', detail: type });
    expect(google.tokenCalls()).toBe(0);
  });

  test('a success result without a url, and a browser that cannot open at all, are sign_in_cancelled', async () => {
    const google = fakeGoogleTokenEndpoint();
    const noUrl = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: async () => ({ type: 'success' }) });
    expect(await noUrl()).toMatchObject({ ok: false, category: 'sign_in_cancelled' });
    const noBrowser = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: async () => { throw new Error('No activity found to handle intent'); } });
    expect(await noBrowser()).toMatchObject({ ok: false, category: 'sign_in_cancelled', detail: expect.stringContaining('No activity') });
    expect(google.tokenCalls()).toBe(0);
  });

  test('redirect errors: access_denied → sign_in_cancelled; server_error / temporarily_unavailable → network (RFC 6749 §4.1.2.1: nothing was rejected); any other provider error → credential_rejected', async () => {
    const cases = [
      ['access_denied', 'sign_in_cancelled'],
      ['server_error', 'network'],
      ['temporarily_unavailable', 'network'],
      ['invalid_scope', 'credential_rejected'],
      ['unauthorized_client', 'credential_rejected'],
    ] as const;
    for (const [error, category] of cases) {
      const google = fakeGoogleTokenEndpoint();
      const signIn = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&error=${error}`) });
      expect(await signIn()).toEqual({ ok: false, category, detail: error });
      expect(google.tokenCalls()).toBe(0);
    }
  });

  test('token endpoint: invalid_grant / invalid_request → credential_rejected; a 5xx or 429 (GoogleAuthError server) and a throw before a response (network) → network', async () => {
    const google = fakeGoogleTokenEndpoint();
    // A code the endpoint never issued: invalid_grant.
    const badCode = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=never-issued`) });
    expect(await badCode()).toMatchObject({ ok: false, category: 'credential_rejected', detail: expect.stringContaining('invalid_grant') });
    for (const [status, body, category] of [
      [400, { error: 'invalid_request', error_description: 'Missing code verifier.' }, 'credential_rejected'],
      [401, { error: 'invalid_client' }, 'credential_rejected'],
      [503, { error: 'backendError' }, 'network'],
      [500, {}, 'network'],
      [429, { error: 'rate_limit' }, 'network'],
    ] as const) {
      const signIn = createGoogleSignIn({ fetchImpl: async () => json(status, body), random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
      expect(await signIn()).toMatchObject({ ok: false, category });
    }
    const offline = createGoogleSignIn({ fetchImpl: async () => { throw new TypeError('Network request failed'); }, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
    expect(await offline()).toMatchObject({ ok: false, category: 'network', detail: expect.stringContaining('Network request failed') });
  });

  describe('one code, one exchange attempt (Task 1 evidence c7: a timed-out exchange can still consume the code)', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('success: the token endpoint is called exactly once for the redirect', async () => {
      const google = fakeGoogleTokenEndpoint();
      const signIn = createGoogleSignIn({ fetchImpl: google.fetch, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=${google.authCode(q.get('code_challenge')!)}`) });
      expect(await signIn()).toMatchObject({ ok: true });
      expect(google.tokenCalls()).toBe(1);
    });

    test('a network failure ends the attempt with network after ONE exchange — the code is never re-posted', async () => {
      let tokenCalls = 0;
      const fetchImpl: S3FetchPort = async () => { tokenCalls += 1; throw new TypeError('Network request failed'); };
      const signIn = createGoogleSignIn({ fetchImpl, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
      expect(await signIn()).toMatchObject({ ok: false, category: 'network' });
      expect(tokenCalls).toBe(1);
    });

    test('a 5xx ends the attempt with network after ONE exchange', async () => {
      let tokenCalls = 0;
      const fetchImpl: S3FetchPort = async () => { tokenCalls += 1; return json(503, { error: 'backendError' }); };
      const signIn = createGoogleSignIn({ fetchImpl, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
      expect(await signIn()).toMatchObject({ ok: false, category: 'network' });
      expect(tokenCalls).toBe(1);
    });

    test('a token request that never answers times out as network, and nothing re-posts the code afterwards', async () => {
      jest.useFakeTimers();
      let tokenCalls = 0;
      const fetchImpl: S3FetchPort = () => { tokenCalls += 1; return new Promise<Response>(() => {}); };
      const signIn = createGoogleSignIn({ fetchImpl, random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
      const pending = signIn();
      await jest.advanceTimersByTimeAsync(GOOGLE_TOKEN_REQUEST_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, category: 'network', detail: expect.stringContaining('timed out') });
      await jest.advanceTimersByTimeAsync(10 * GOOGLE_TOKEN_REQUEST_TIMEOUT_MS);
      expect(tokenCalls).toBe(1);
    });
  });

  test('PKCE is generated fresh per call: two sign-ins through the same port carry different state and code_challenge, and both succeed', async () => {
    const google = fakeGoogleTokenEndpoint();
    let counter = 0;
    const counterRandom = async (len: number) => {
      counter += 1;
      const seed = counter;
      return Uint8Array.from({ length: len }, (_, i) => (seed * 31 + i) % 256);
    };
    const opened: string[] = [];
    const signIn = createGoogleSignIn({
      fetchImpl: google.fetch, random: counterRandom,
      openAuthSession: async (url) => {
        opened.push(url);
        const q = new URL(url).searchParams;
        return { type: 'success', url: `${GOOGLE_REDIRECT_URI}?state=${q.get('state')}&code=${google.authCode(q.get('code_challenge')!)}` };
      },
    });
    expect(await signIn()).toMatchObject({ ok: true });
    expect(await signIn()).toMatchObject({ ok: true });
    const [q1, q2] = opened.map((u) => new URL(u).searchParams);
    expect(q1!.get('state')).not.toBe(q2!.get('state'));
    expect(q1!.get('code_challenge')).not.toBe(q2!.get('code_challenge'));
  });

  test('`detail` is diagnostic only: it can carry Google\'s error_description verbatim, but the rendered sign-in copy never depends on it or contains it, in any locale', async () => {
    const MARKER = 'PROVIDER-SAYS-zz9-secret-ish';
    const outcomes: GoogleSignInOutcome[] = [];
    const tokenFailure = createGoogleSignIn({ fetchImpl: async () => json(400, { error: 'invalid_grant', error_description: MARKER }), random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
    outcomes.push(await tokenFailure());
    const serverFailure = createGoogleSignIn({ fetchImpl: async () => json(503, { error: 'x', error_description: MARKER }), random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&code=C`) });
    outcomes.push(await serverFailure());
    const redirectFailure = createGoogleSignIn({ fetchImpl: async () => json(500, {}), random, openAuthSession: redirectWith((q) => `state=${q.get('state')}&error=access_denied&error_description=${MARKER}`) });
    outcomes.push(await redirectFailure());
    expect(outcomes[0]).toMatchObject({ ok: false, detail: expect.stringContaining(MARKER) });
    for (const outcome of outcomes) {
      if (outcome.ok) throw new Error('expected a failure');
      const key = signInFlowErrorKey(outcome, 'gdrive');
      expect(key).toBe(signInFlowErrorKey({ category: outcome.category }, 'gdrive'));
      for (const lng of ['en', 'zh-Hans', 'zh-Hant', 'ja']) {
        const text = i18n.t(key, { lng });
        expect(text).not.toBe(key);
        expect(text).not.toContain(MARKER);
      }
    }
  });
});
