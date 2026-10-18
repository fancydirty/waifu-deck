import { sha256 } from '@noble/hashes/sha2.js';
import { URL as WhatwgURL } from 'whatwg-url-minimum';

import {
  GOOGLE_AUTHORIZE_URL, GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, GOOGLE_REVOKE_URL, GOOGLE_SCOPE, GOOGLE_TOKEN_URL,
  GOOGLE_TOKEN_REQUEST_TIMEOUT_MS,
  GoogleAuthError, buildGoogleAuthorizeUrl, exchangeGoogleCode, newGooglePkce, parseGoogleRedirect, refreshGoogleTokens,
} from './google-oauth';
import { base64Url } from './base64url';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) % 256);

describe('PKCE', () => {
  // RFC 7636 §4.1: a 32-byte verifier base64url-encodes to ceil(32/3)*4 = 44 chars
  // with one '=' pad, so the unpadded verifier is 43 chars. The `state` draw is
  // 16 bytes → 24 chars padded with '==' → 22 unpadded. Same derivation as P12-C.
  test('verifier is 43 chars of base64url from 32 random bytes; challenge is base64url(sha256(verifier)); state is 22 chars from 16 bytes', async () => {
    const pkce = await newGooglePkce(async (n) => bytes(n));
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(base64Url(sha256(new TextEncoder().encode(pkce.verifier))));
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  test('each call draws fresh material', async () => {
    let call = 0;
    const draw = async (n: number) => bytes(n, ++call);
    const a = await newGooglePkce(draw);
    const b = await newGooglePkce(draw);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('buildGoogleAuthorizeUrl', () => {
  test('targets the Google authorization endpoint with every spec parameter and no client secret', () => {
    const url = new URL(buildGoogleAuthorizeUrl({ challenge: 'CH', state: 'ST' }));
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_URL);
    expect(GOOGLE_AUTHORIZE_URL).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    // Task 1 (补裁 14): the iOS-type app client — no secret exists for it at all.
    expect(GOOGLE_CLIENT_ID).toBe('550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec.apps.googleusercontent.com');
    // Google's reverse-client-id redirect: the client id's DNS labels reversed, one slash after the colon.
    expect(GOOGLE_REDIRECT_URI).toBe('com.googleusercontent.apps.550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec:/oauth2redirect');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe(GOOGLE_REDIRECT_URI);
    expect(q.get('scope')).toBe(GOOGLE_SCOPE);
    // 补裁 10: drive.file only. The visible "Waifu Deck" folder is the product
    // requirement (§1 goal 2), so drive.appdata is NOT used and no second scope
    // is requested — the account e-mail comes from Drive's own `about`, not from
    // a profile scope, so there is nothing else to ask the user for.
    expect(GOOGLE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
    expect(q.get('code_challenge')).toBe('CH');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('ST');
    expect(q.has('client_secret')).toBe(false);
    expect(q.has('response_mode')).toBe(false);
    // 补裁 2: installed applications are always issued a refresh token, so
    // access_type must stay absent for the app; prompt=select_account only forces
    // Google's account chooser (P12-C parity — buildAuthorizeUrl does the same for
    // OneDrive) so a reconnect can switch accounts, since disconnect does not
    // revoke Google's own consent.
    expect(q.has('access_type')).toBe(false);
    expect(q.get('prompt')).toBe('select_account');
  });
  test('the Mac gate helper runs on the Web gate client: its client id, its localhost redirect, and offline access', () => {
    const url = new URL(buildGoogleAuthorizeUrl({ challenge: 'c', state: 's', redirectUri: 'http://localhost:53682/callback', clientId: 'gate.apps.googleusercontent.com', offline: true }));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53682/callback');
    expect(url.searchParams.get('client_id')).toBe('gate.apps.googleusercontent.com');
    // 补裁 2: a Web client is issued a refresh token only with access_type=offline,
    // and re-issued one only with prompt=consent.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.has('client_secret')).toBe(false); // a secret never goes in a URL
  });
});

describe('parseGoogleRedirect', () => {
  // The reverse-client-id scheme has a SINGLE slash after the colon
  // (`com.example.app:/oauth2redirect`), which is exactly what Google's redirect
  // table shows and is NOT a valid authority-form URL. WHATWG `new URL` parses it
  // as a hostless path-absolute URL (host '', pathname '/oauth2redirect'), not an
  // "opaque-path" URL, and still exposes `searchParams`, which is all this needs
  // — pinned here (and below, under the on-device URL implementation too) because
  // it is the one non-obvious thing about this scheme.
  const R = `${GOOGLE_REDIRECT_URI}?code=C1&state=ST`;
  test('returns the code when the state matches', () => {
    expect(parseGoogleRedirect(R, 'ST')).toEqual({ ok: true, code: 'C1' });
  });
  test('a state mismatch is refused before any token call (CSRF)', () => {
    expect(parseGoogleRedirect(R, 'OTHER')).toEqual({ ok: false, reason: 'state_mismatch' });
  });
  test('the provider error is surfaced by code', () => {
    expect(parseGoogleRedirect(`${GOOGLE_REDIRECT_URI}?error=access_denied&error_description=User%20denied&state=ST`, 'ST')).toEqual({ ok: false, reason: 'access_denied', description: 'User denied' });
  });
  test('a redirect with neither code nor error is malformed, and so is an unparseable one', () => {
    expect(parseGoogleRedirect(`${GOOGLE_REDIRECT_URI}?state=ST`, 'ST')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseGoogleRedirect('%%%', 'ST')).toEqual({ ok: false, reason: 'malformed' });
  });
  // F3: jest-expo's Jest runtime uses Node's URL, but Expo 56 installs
  // whatwg-url-minimum as the actual on-device global URL — the two are
  // different implementations and this scheme is the one non-obvious case, so
  // it is worth confirming both agree rather than trusting Node's URL alone.
  test('parses the same way under the on-device URL implementation (Expo installs whatwg-url-minimum as the global URL)', () => {
    const RealURL = globalThis.URL;
    try {
      globalThis.URL = WhatwgURL;
      expect(parseGoogleRedirect(`${GOOGLE_REDIRECT_URI}?code=4/0Ab-x&state=ST`, 'ST')).toEqual({ ok: true, code: '4/0Ab-x' });
      expect(parseGoogleRedirect(`${GOOGLE_REDIRECT_URI}?error=access_denied&error_description=User%20denied&state=ST`, 'ST')).toEqual({ ok: false, reason: 'access_denied', description: 'User denied' });
    } finally {
      globalThis.URL = RealURL;
    }
  });
});

describe('token endpoint', () => {
  // 补裁 3: the REFRESH response carries no refresh_token. `tokenOk` therefore
  // models the CODE-EXCHANGE response (which does) and `refreshOk` the refresh
  // response (which does not) — conflating them is how a rotation path nobody
  // needs gets written.
  const tokenOk = { access_token: 'AT', refresh_token: 'RT1', expires_in: 3920, token_type: 'Bearer', scope: GOOGLE_SCOPE };
  const refreshOk = { access_token: 'AT2', expires_in: 3920, token_type: 'Bearer', scope: GOOGLE_SCOPE };
  function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; body: URLSearchParams; init: RequestInit }[] = [];
    return { calls, fetchImpl: async (url: string, init?: RequestInit) => { calls.push({ url, body: new URLSearchParams(String(init?.body)), init: init ?? {} }); return handler(url, init ?? {}); } };
  }

  test('exchangeGoogleCode posts the verifier + redirect as form data and returns the token set', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200, headers: { 'content-type': 'application/json' } }));
    const set = await exchangeGoogleCode(f.fetchImpl, { code: 'C1', verifier: 'V', now: () => 1_000_000 });
    expect(f.calls[0]!.url).toBe(GOOGLE_TOKEN_URL);
    expect(GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect((f.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    // The app body is exactly these five keys — no client_secret: the iOS-type app
    // client has none, and Task 1 measured this body returning 200 + refresh_token.
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({
      client_id: GOOGLE_CLIENT_ID, grant_type: 'authorization_code', code: 'C1',
      redirect_uri: GOOGLE_REDIRECT_URI, code_verifier: 'V',
    });
    // expires_in 3920 is Google's own documented sample value; 1_000_000 + 3920*1000.
    expect(set).toEqual({ accessToken: 'AT', refreshToken: 'RT1', expiresAt: 1_000_000 + 3_920_000 });
  });

  test('exchangeGoogleCode refuses a 200 that carries no refresh token (offline access missing) rather than returning half a session', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify(refreshOk), { status: 200 }));
    await expect(exchangeGoogleCode(f.fetchImpl, { code: 'C1', verifier: 'V' })).rejects.toMatchObject({ name: 'GoogleAuthError', code: 'invalid_request' });
  });

  test('refreshGoogleTokens posts grant_type=refresh_token and KEEPS the input refresh token (Google does not rotate)', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify(refreshOk), { status: 200 }));
    const set = await refreshGoogleTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0 });
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({ client_id: GOOGLE_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'RT1' });
    expect(set).toEqual({ accessToken: 'AT2', refreshToken: 'RT1', expiresAt: 3_920_000 });
    // If Google ever DID return one, honour it rather than silently keeping a dead
    // token — cheap, and it makes the "no rotation" claim a tested observation
    // instead of an assumption baked into the code.
    const g = fakeFetch(() => new Response(JSON.stringify({ ...refreshOk, refresh_token: 'RT2' }), { status: 200 }));
    expect((await refreshGoogleTokens(g.fetchImpl, { refreshToken: 'RT1', now: () => 0 })).refreshToken).toBe('RT2');
  });

  test('gate overrides: the Web gate client sends its client id and client_secret on the exchange AND on every refresh', async () => {
    // Task 1 measured both: without the secret Google answers
    // 400 invalid_request "client_secret is missing." to the exchange and to the refresh.
    const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200 }));
    await exchangeGoogleCode(f.fetchImpl, { code: 'C1', verifier: 'V', redirectUri: 'http://localhost:53682/callback', clientId: 'gate.apps.googleusercontent.com', clientSecret: 'GS', now: () => 0 });
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({
      client_id: 'gate.apps.googleusercontent.com', client_secret: 'GS', grant_type: 'authorization_code', code: 'C1',
      redirect_uri: 'http://localhost:53682/callback', code_verifier: 'V',
    });
    const g = fakeFetch(() => new Response(JSON.stringify(refreshOk), { status: 200 }));
    await refreshGoogleTokens(g.fetchImpl, { refreshToken: 'RT1', clientId: 'gate.apps.googleusercontent.com', clientSecret: 'GS', now: () => 0 });
    expect(Object.fromEntries(g.calls[0]!.body)).toEqual({ client_id: 'gate.apps.googleusercontent.com', client_secret: 'GS', grant_type: 'refresh_token', refresh_token: 'RT1' });
  });

  test('error classification: invalid_grant (revoked / expired / 7-day Testing expiry), other 4xx, 5xx, 429, network, unparseable body', async () => {
    const bad = (status: number, error: string) => fakeFetch(() => new Response(JSON.stringify({ error, error_description: 'Token has been expired or revoked.' }), { status })).fetchImpl;
    await expect(refreshGoogleTokens(bad(400, 'invalid_grant'), { refreshToken: 'R' })).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(refreshGoogleTokens(bad(401, 'invalid_client'), { refreshToken: 'R' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(refreshGoogleTokens(bad(503, 'unavailable'), { refreshToken: 'R' })).rejects.toMatchObject({ code: 'server' });
    // A 429 from the identity host is retryable, NOT a terminal client error.
    // P12-C shipped this backwards and fixed it in a follow-up (685d899); pinned here.
    await expect(refreshGoogleTokens(bad(429, 'rate'), { refreshToken: 'R' })).rejects.toMatchObject({ code: 'server' });
    await expect(refreshGoogleTokens(async () => { throw new TypeError('Network request failed'); }, { refreshToken: 'R' })).rejects.toMatchObject({ code: 'network' });
    // A 200 whose body will not parse (captive portal, truncated read) is transport
    // trouble, not a rejected credential.
    await expect(refreshGoogleTokens(async () => new Response('<html>portal</html>', { status: 200 }), { refreshToken: 'R' })).rejects.toMatchObject({ code: 'network' });
    // F1: a JSON `null` body on a non-2xx response is valid JSON, so it parses
    // without throwing — `body.error` on a bare `null` must not throw a raw
    // TypeError and swallow the retryable/non-retryable classification.
    const nullBody = (status: number) => fakeFetch(() => new Response('null', { status })).fetchImpl;
    await expect(refreshGoogleTokens(nullBody(400), { refreshToken: 'R' })).rejects.toMatchObject({ name: 'GoogleAuthError', code: 'invalid_request' });
    await expect(refreshGoogleTokens(nullBody(503), { refreshToken: 'R' })).rejects.toMatchObject({ name: 'GoogleAuthError', code: 'server' });
    expect(new GoogleAuthError('x', 'network')).toBeInstanceOf(Error);
  });

  test('expires_in is defaulted, not trusted blindly', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ access_token: 'AT2', token_type: 'Bearer' }), { status: 200 }));
    // No expires_in → assume the conservative 3600 s the OAuth spec's examples use,
    // so the 60 s margin still triggers a refresh rather than caching forever.
    expect((await refreshGoogleTokens(f.fetchImpl, { refreshToken: 'R', now: () => 0 })).expiresAt).toBe(3_600_000);
  });

  test('a silent identity host must not hang a refresh forever: every token request is bounded at 30 s', async () => {
    jest.useFakeTimers();
    try {
      // Mirrors microsoft-oauth.ts:75 and its test at microsoft-oauth.test.ts:128–137,
      // which exists because an unbounded token fetch POISONED the P12-C token
      // source (7e1472f): one hung request and every later getAccessToken() joined
      // the same dead in-flight promise.
      let capturedSignal: AbortSignal | null | undefined;
      const never = (_u: string, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      };
      const pending = refreshGoogleTokens(never, { refreshToken: 'R' });
      const settled = jest.fn();
      void pending.catch(settled);
      // Boundary derived from GOOGLE_TOKEN_REQUEST_TIMEOUT_MS: one tick short is
      // still in flight, the tick itself aborts.
      await jest.advanceTimersByTimeAsync(29_999);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      // F4: the race must settle on our own deadline message, not on the
      // AbortError the same abort() call also causes in a real fetch.
      await expect(pending).rejects.toMatchObject({ name: 'GoogleAuthError', code: 'network', message: expect.stringContaining('timed out after 30000 ms') });
      expect(GOOGLE_TOKEN_REQUEST_TIMEOUT_MS).toBe(30_000);
      // A rejected promise alone isn't enough: a leaked hanging request is a real
      // battery/data cost on a phone, so the timeout must actually cancel fetch.
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('body deadline (board #9 T2, spec §5.2): the device fetch has no read timeout, so a stalled body must not hang a refresh', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    // A body stream that never delivers a byte and never closes: `res.json()`
    // on it stays pending forever, exactly like OkHttp with readTimeout(0).
    const stalled = (status: number) => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status });
    function stalledFetch(status: number) {
      const signals: AbortSignal[] = [];
      return { signals, fetchImpl: async (_url: string, init?: RequestInit) => { signals.push(init!.signal!); return stalled(status); } };
    }

    test('a 200 whose body never completes rejects as a network timeout within the re-armed deadline and aborts the request', async () => {
      const f = stalledFetch(200);
      const pending = refreshGoogleTokens(f.fetchImpl, { refreshToken: 'R', timeoutMs: 1000 });
      const settled = jest.fn();
      pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalled();
      await expect(pending).rejects.toMatchObject({ name: 'GoogleAuthError', code: 'network', message: expect.stringContaining('timed out after 1000 ms') });
      expect(f.signals).toHaveLength(1);
      expect(f.signals[0]!.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    }, 5000);

    test('a 400 / 503 whose error body stalls falls back to the status-based code within the deadline and aborts the request', async () => {
      for (const [status, code] of [[400, 'invalid_request'], [503, 'server']] as const) {
        const f = stalledFetch(status);
        const pending = exchangeGoogleCode(f.fetchImpl, { code: 'C', verifier: 'V', timeoutMs: 1000 });
        const settled = jest.fn();
        pending.then(settled, settled);
        await jest.advanceTimersByTimeAsync(1000);
        expect(settled).toHaveBeenCalled();
        await expect(pending).rejects.toMatchObject({ name: 'GoogleAuthError', code });
        expect(f.signals[0]!.aborted).toBe(true);
      }
    }, 5000);
  });

  test('a successful exchange cleans up its timer (no leaked handle)', async () => {
    jest.useFakeTimers();
    try {
      const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200 }));
      await exchangeGoogleCode(f.fetchImpl, { code: 'C1', verifier: 'V', now: () => 0 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the revoke endpoint constant is the documented one (used by the gate teardown, never by the app)', () => {
    expect(GOOGLE_REVOKE_URL).toBe('https://oauth2.googleapis.com/revoke');
  });
});
