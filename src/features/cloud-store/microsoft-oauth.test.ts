import { sha256 } from '@noble/hashes/sha2.js';

import {
  MICROSOFT_CLIENT_ID, MICROSOFT_REDIRECT_URI, MICROSOFT_SCOPE, MICROSOFT_AUTHORIZE_URL, MICROSOFT_TOKEN_URL, TOKEN_REQUEST_TIMEOUT_MS,
  MicrosoftAuthError, base64Url, buildAuthorizeUrl, exchangeCode, newPkce, parseRedirect, refreshTokens,
} from './microsoft-oauth';

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) % 256);

describe('PKCE', () => {
  test('verifier is 43 chars of base64url from 32 random bytes; challenge is base64url(sha256(verifier))', async () => {
    const pkce = await newPkce(async (n) => bytes(n));
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(base64Url(sha256(new TextEncoder().encode(pkce.verifier))));
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
  test('base64Url has no padding and uses -_', () => {
    expect(base64Url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64Url(new Uint8Array([1]))).toBe('AQ');
  });
  test('newPkce asks its random source for 32 bytes for the verifier and 16 for the state', async () => {
    const requested: number[] = [];
    await newPkce(async (n) => { requested.push(n); return bytes(n); });
    expect(requested).toEqual([32, 16]);
  });
});

describe('buildAuthorizeUrl', () => {
  test('targets the consumers tenant with every spec parameter and no client secret', () => {
    const url = new URL(buildAuthorizeUrl({ challenge: 'CH', state: 'ST' }));
    expect(url.origin + url.pathname).toBe(MICROSOFT_AUTHORIZE_URL);
    expect(MICROSOFT_AUTHORIZE_URL).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(MICROSOFT_CLIENT_ID);
    expect(MICROSOFT_CLIENT_ID).toBe('40d6e21b-ea99-4417-af2c-65b1a290aa0d');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe(MICROSOFT_REDIRECT_URI);
    expect(MICROSOFT_REDIRECT_URI).toBe('waifudeck://auth/onedrive');
    expect(q.get('response_mode')).toBe('query');
    expect(q.get('scope')).toBe(MICROSOFT_SCOPE);
    expect(MICROSOFT_SCOPE).toBe('Files.ReadWrite.AppFolder offline_access User.Read');
    expect(q.get('code_challenge')).toBe('CH');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('ST');
    expect(q.get('prompt')).toBe('select_account');
    expect(q.has('client_secret')).toBe(false);
  });
  test('a custom redirect (the Node login helper) is honoured', () => {
    expect(new URL(buildAuthorizeUrl({ challenge: 'c', state: 's', redirectUri: 'http://localhost:53682/callback' })).searchParams.get('redirect_uri')).toBe('http://localhost:53682/callback');
  });
});

describe('parseRedirect', () => {
  test('returns the code when the state matches', () => {
    expect(parseRedirect('waifudeck://auth/onedrive?code=C1&state=ST', 'ST')).toEqual({ ok: true, code: 'C1' });
  });
  test('a state mismatch is refused before any token call (CSRF)', () => {
    expect(parseRedirect('waifudeck://auth/onedrive?code=C1&state=OTHER', 'ST')).toEqual({ ok: false, reason: 'state_mismatch' });
  });
  test('the provider error is surfaced by code', () => {
    expect(parseRedirect('waifudeck://auth/onedrive?error=access_denied&error_description=User%20cancelled&state=ST', 'ST')).toEqual({ ok: false, reason: 'access_denied', description: 'User cancelled' });
  });
  test('a redirect with neither code nor error is malformed', () => {
    expect(parseRedirect('waifudeck://auth/onedrive?state=ST', 'ST')).toEqual({ ok: false, reason: 'malformed' });
  });
  test('an unparseable URL is refused as malformed, not thrown (Node WHATWG URL and Expo\'s on-device whatwg-url-minimum global both throw on parse)', () => {
    expect(parseRedirect('not a url', 'ST')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('token endpoint', () => {
  const tokenOk = { access_token: 'AT', refresh_token: 'RT2', expires_in: 3599, token_type: 'Bearer', scope: 'x' };
  function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; body: URLSearchParams; init: RequestInit }[] = [];
    return { calls, fetchImpl: async (url: string, init?: RequestInit) => { calls.push({ url, body: new URLSearchParams(String(init?.body)), init: init ?? {} }); return handler(url, init ?? {}); } };
  }
  test('exchangeCode posts the verifier + redirect as form data to the consumers token endpoint and returns the token set', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200, headers: { 'content-type': 'application/json' } }));
    const set = await exchangeCode(f.fetchImpl, { code: 'C1', verifier: 'V', now: () => 1_000_000 });
    expect(f.calls[0]!.url).toBe(MICROSOFT_TOKEN_URL);
    expect(MICROSOFT_TOKEN_URL).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
    expect((f.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'authorization_code', code: 'C1', redirect_uri: MICROSOFT_REDIRECT_URI, code_verifier: 'V', scope: MICROSOFT_SCOPE });
    expect(set).toEqual({ accessToken: 'AT', refreshToken: 'RT2', expiresAt: 1_000_000 + 3599 * 1000 });
  });
  test('refreshTokens posts grant_type=refresh_token and returns the ROTATED refresh token (falls back to the old one when none is returned)', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200 }));
    const set = await refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0 });
    expect(Object.fromEntries(f.calls[0]!.body)).toEqual({ client_id: MICROSOFT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'RT1', scope: MICROSOFT_SCOPE });
    expect(set.refreshToken).toBe('RT2');
    const g = fakeFetch(() => new Response(JSON.stringify({ ...tokenOk, refresh_token: undefined }), { status: 200 }));
    expect((await refreshTokens(g.fetchImpl, { refreshToken: 'RT1', now: () => 0 })).refreshToken).toBe('RT1');
  });
  test('invalid_grant is a MicrosoftAuthError with code invalid_grant (revoked / expired); other 4xx are invalid_request; 5xx server; a throw is network', async () => {
    const bad = (status: number, error: string) => fakeFetch(() => new Response(JSON.stringify({ error, error_description: 'AADSTS70000: ...' }), { status })).fetchImpl;
    await expect(refreshTokens(bad(400, 'invalid_grant'), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ name: 'MicrosoftAuthError', code: 'invalid_grant' });
    await expect(refreshTokens(bad(400, 'invalid_client'), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(refreshTokens(bad(503, 'temporarily_unavailable'), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'server' });
    // A transient 5xx that happens to carry an invalid_grant-shaped body must NOT be classified as a permanent auth failure (status takes precedence over body).
    await expect(refreshTokens(bad(503, 'invalid_grant'), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'server' });
    // 429 (throttling) is retryable, not a permanent client error: it classifies the same as 5xx.
    await expect(refreshTokens(bad(429, 'temporarily_unavailable'), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'server' });
    await expect(refreshTokens(async () => { throw new TypeError('Network request failed'); }, { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'network' });
    // F1: a JSON `null` body on a non-2xx response is valid JSON, so it parses
    // without throwing — `body.error` on a bare `null` must not throw a raw
    // TypeError and swallow the retryable/non-retryable classification.
    const nullBody = (status: number) => fakeFetch(() => new Response('null', { status })).fetchImpl;
    await expect(refreshTokens(nullBody(400), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ name: 'MicrosoftAuthError', code: 'invalid_request' });
    await expect(refreshTokens(nullBody(503), { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ name: 'MicrosoftAuthError', code: 'server' });
    expect(new MicrosoftAuthError('x', 'network')).toBeInstanceOf(Error);
  });
  test('a 200 body without an access_token is rejected as invalid_request', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ token_type: 'Bearer' }), { status: 200 }));
    await expect(refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('no token') });
  });
  test('a literal JSON null 2xx body is rejected as invalid_request, not thrown as a raw TypeError', async () => {
    const f = fakeFetch(() => new Response('null', { status: 200 }));
    await expect(refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  test('a non-JSON 4xx body is rejected as invalid_request without throwing anything else', async () => {
    const f = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 400 }));
    await expect(refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  test('expires_in absent defaults expiresAt to now + 1 hour', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT2' }), { status: 200 }));
    const set = await refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 1_000_000 });
    expect(set.expiresAt).toBe(1_000_000 + 3_600_000);
  });
  test('a truncated 200 body (connection dropped mid-response) is a network error, not a permanent rejection', async () => {
    const f = fakeFetch(() => new Response('{"access_token": "AT"', { status: 200 }));
    await expect(refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0 })).rejects.toMatchObject({ code: 'network' });
  });

  describe('request timeout (a silent identity host must not hang a refresh forever)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    test('the exported default bound is 30 s', () => {
      expect(TOKEN_REQUEST_TIMEOUT_MS).toBe(30_000);
    });
    test('a request that never responds is aborted and rejected as a network timeout', async () => {
      let signal: AbortSignal | undefined;
      const fetchImpl = (_url: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); };
      const pending = refreshTokens(fetchImpl, { refreshToken: 'RT1', now: () => 0, timeoutMs: 1000 });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('timed out') });
      await jest.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(signal?.aborted).toBe(true);
    });
    test('a request that resolves in time leaves no timer to fire (no late abort, no second call)', async () => {
      const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200 }));
      const set = await refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0, timeoutMs: 1000 });
      expect(set.accessToken).toBe('AT');
      await jest.advanceTimersByTimeAsync(5000);
      expect(f.calls).toHaveLength(1);
    });
    test('F4: the timeout message is honest — it names the deadline, not the AbortError the same abort() call also causes in a real fetch', async () => {
      let signal: AbortSignal | undefined;
      const fetchImpl = (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      const pending = refreshTokens(fetchImpl, { refreshToken: 'RT1', now: () => 0 });
      const rejected = expect(pending).rejects.toMatchObject({ name: 'MicrosoftAuthError', code: 'network', message: expect.stringContaining('timed out after 30000 ms') });
      await jest.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(signal?.aborted).toBe(true);
    });
    test('a successful exchangeCode cleans up its timer (no leaked handle)', async () => {
      const f = fakeFetch(() => new Response(JSON.stringify(tokenOk), { status: 200 }));
      await exchangeCode(f.fetchImpl, { code: 'C1', verifier: 'V', now: () => 0 });
      expect(jest.getTimerCount()).toBe(0);
    });
    // Board #9 T2 (spec §5.2): the device fetch has no read timeout, so the body
    // read gets its own deadline. The stream never delivers a byte and never closes.
    const stalled = (status: number) => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status });
    function stalledFetch(status: number) {
      const signals: AbortSignal[] = [];
      return { signals, fetchImpl: async (_url: string, init?: RequestInit) => { signals.push(init!.signal!); return stalled(status); } };
    }
    test('a 200 whose body never completes rejects as a network timeout within the re-armed deadline and aborts the request', async () => {
      const f = stalledFetch(200);
      const pending = refreshTokens(f.fetchImpl, { refreshToken: 'RT1', now: () => 0, timeoutMs: 1000 });
      const settled = jest.fn();
      pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalled();
      await expect(pending).rejects.toMatchObject({ name: 'MicrosoftAuthError', code: 'network', message: expect.stringContaining('timed out after 1000 ms') });
      expect(f.signals).toHaveLength(1);
      expect(f.signals[0]!.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    }, 5000);
    test('a 400 / 503 whose error body stalls falls back to the status-based code within the deadline and aborts the request', async () => {
      for (const [status, code] of [[400, 'invalid_request'], [503, 'server']] as const) {
        const f = stalledFetch(status);
        const pending = exchangeCode(f.fetchImpl, { code: 'C', verifier: 'V', now: () => 0, timeoutMs: 1000 });
        const settled = jest.fn();
        pending.then(settled, settled);
        await jest.advanceTimersByTimeAsync(1000);
        expect(settled).toHaveBeenCalled();
        await expect(pending).rejects.toMatchObject({ name: 'MicrosoftAuthError', code });
        expect(f.signals[0]!.aborted).toBe(true);
      }
    }, 5000);
    test('exchangeCode bounds its request too (a signal reaches fetch)', async () => {
      let signal: AbortSignal | undefined;
      const f = fakeFetch((_url, init) => { signal = init.signal ?? undefined; return new Response(JSON.stringify(tokenOk), { status: 200 }); });
      await exchangeCode(f.fetchImpl, { code: 'C1', verifier: 'V', now: () => 0 });
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });
});
