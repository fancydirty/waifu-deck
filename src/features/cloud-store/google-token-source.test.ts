import { CloudStoreError } from './cloud-object-store';
import { GoogleAuthError, refreshGoogleTokens, type TokenSet } from './google-oauth';
import { createGoogleTokenSource, GOOGLE_TOKEN_REFRESH_MARGIN_MS } from './google-token-source';

const set = (accessToken: string, expiresAt: number): TokenSet => ({ accessToken, refreshToken: 'RT1', expiresAt });

describe('createGoogleTokenSource', () => {
  test('the margin is 60 s and is two-sided: a token with margin+1 ms left is used, one with exactly the margin left is refreshed', async () => {
    expect(GOOGLE_TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
    let refreshes = 0;
    const make = (expiresAt: number) => createGoogleTokenSource({
      seed: { accessToken: 'SEED', refreshToken: 'RT1', expiresAt },
      refresh: async () => { refreshes += 1; return set('FRESH', 9_000_000); },
      now: () => 1_000_000,
    });
    // now() = 1_000_000. The guard is `now < expiresAt - margin`, so the boundary is
    // expiresAt = 1_060_000: one ms above it (1_060_001) still satisfies the guard and
    // reuses the seed; exactly at it does not and refreshes.
    expect(await make(1_060_001).getAccessToken()).toBe('SEED');
    expect(refreshes).toBe(0);
    expect(await make(1_060_000).getAccessToken()).toBe('FRESH');
    expect(refreshes).toBe(1);
  });

  test('single-flight: N concurrent callers share ONE refresh, and a later call refreshes again', async () => {
    let refreshes = 0;
    let release!: (t: TokenSet) => void;
    const source = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: () => { refreshes += 1; return new Promise<TokenSet>((r) => { release = r; }); },
      now: () => 0,
    });
    const all = Promise.all([source.getAccessToken(), source.getAccessToken(), source.getAccessToken()]);
    expect(refreshes).toBe(1);
    release(set('A1', 9_000_000));
    expect(await all).toEqual(['A1', 'A1', 'A1']);
    expect(refreshes).toBe(1);
    source.invalidate();
    const second = source.getAccessToken();
    release(set('A2', 9_000_000));
    expect(await second).toBe('A2');
    expect(refreshes).toBe(2);
  });

  test('invalidate() drops the cached token even though the clock says it is fine', async () => {
    let refreshes = 0;
    const source = createGoogleTokenSource({
      seed: { accessToken: 'SEED', refreshToken: 'RT1', expiresAt: 9_000_000 },
      refresh: async () => { refreshes += 1; return set('FRESH', 9_000_000); },
      now: () => 0,
    });
    expect(await source.getAccessToken()).toBe('SEED');
    source.invalidate();
    expect(await source.getAccessToken()).toBe('FRESH');
    expect(refreshes).toBe(1);
  });

  test('a refresh does NOT need a write-back: the source keeps working across calls with no persistence port at all', async () => {
    // The whole point of 补裁 3. If a future edit adds an onRotated requirement,
    // this test stops compiling (the deps object has no such field) — which is the
    // signal to go re-read the spec, not to add the field.
    const source = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: async (rt) => { expect(rt).toBe('RT1'); return set('A1', 9_000_000); },
      now: () => 0,
    });
    expect(await source.getAccessToken()).toBe('A1');
    expect(await source.getAccessToken()).toBe('A1');
  });

  test('invalid_grant becomes a 401 auth CloudStoreError whose message carries reauth_required', async () => {
    const source = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'DEAD', expiresAt: 0 },
      refresh: async () => { throw new GoogleAuthError('Token has been expired or revoked.', 'invalid_grant'); },
      now: () => 0,
    });
    const error = await source.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudStoreError);
    expect(error).toMatchObject({ status: 401, category: 'auth', outcomeKnown: true });
    expect((error as CloudStoreError).message).toContain('reauth_required');
  });

  test('the other three auth codes map to their own categories, and a non-GoogleAuthError is rethrown untouched', async () => {
    const via = async (code: 'network' | 'server' | 'invalid_request') => createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: async () => { throw new GoogleAuthError('boom', code); },
      now: () => 0,
    }).getAccessToken().catch((e: unknown) => e as CloudStoreError);
    expect(await via('network')).toMatchObject({ status: 0, category: 'network', outcomeKnown: false });
    expect(await via('server')).toMatchObject({ status: 503, category: 'server', outcomeKnown: false });
    expect(await via('invalid_request')).toMatchObject({ status: 400, category: 'client', outcomeKnown: true });
    const odd = new RangeError('not an auth error');
    await expect(createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: async () => { throw odd; }, now: () => 0,
    }).getAccessToken()).rejects.toBe(odd);
  });

  test('a failed refresh does not poison the source: the next call tries again', async () => {
    let attempt = 0;
    const source = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: async () => { attempt += 1; if (attempt === 1) throw new GoogleAuthError('down', 'server'); return set('A1', 9_000_000); },
      now: () => 0,
    });
    await expect(source.getAccessToken()).rejects.toBeInstanceOf(CloudStoreError);
    expect(await source.getAccessToken()).toBe('A1');
  });

  test('a refreshed token is cached and reused: two calls after a within-margin seed produce exactly one refresh', async () => {
    let refreshes = 0;
    const source = createGoogleTokenSource({
      seed: { accessToken: 'SEED', refreshToken: 'RT1', expiresAt: 0 },
      refresh: async () => { refreshes += 1; return set('FRESH', 9_000_000); },
      now: () => 0,
    });
    expect(await source.getAccessToken()).toBe('FRESH');
    expect(await source.getAccessToken()).toBe('FRESH');
    expect(refreshes).toBe(1);
  });

  test('a refresh token returned by refresh is kept in memory and honoured on the next refresh', async () => {
    const seen: string[] = [];
    const source = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: async (rt) => {
        seen.push(rt);
        return seen.length === 1
          ? { accessToken: 'A1', refreshToken: 'RT2', expiresAt: 0 }
          : set('A2', 9_000_000);
      },
      now: () => 0,
    });
    expect(await source.getAccessToken()).toBe('A1');
    expect(await source.getAccessToken()).toBe('A2');
    expect(seen).toEqual(['RT1', 'RT2']);
  });

  test('invalidate() during an in-flight refresh does not break single flight', async () => {
    let refreshes = 0;
    let release!: (t: TokenSet) => void;
    const source = createGoogleTokenSource({
      seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
      refresh: () => { refreshes += 1; return new Promise<TokenSet>((r) => { release = r; }); },
      now: () => 0,
    });
    const first = source.getAccessToken();
    source.invalidate();
    const second = source.getAccessToken();
    expect(refreshes).toBe(1);
    release(set('A1', 9_000_000));
    expect(await first).toBe('A1');
    expect(await second).toBe('A1');
    expect(refreshes).toBe(1);
  });

  test('board #9 T2: a real refresh whose 200 body stalls rejects as network and does not wedge the source — the next call sends a fresh request', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      // First answer: headers arrive, the body never does (no read timeout on
      // the device). Second answer: a normal token response.
      const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
        return new Response(JSON.stringify({ access_token: 'A2', expires_in: 3600 }), { status: 200 });
      };
      const source = createGoogleTokenSource({
        seed: { accessToken: null, refreshToken: 'RT1', expiresAt: 0 },
        refresh: (rt) => refreshGoogleTokens(fetchImpl, { refreshToken: rt, now: () => 0, timeoutMs: 1000 }),
        now: () => 0,
      });
      const first = source.getAccessToken();
      const rejected = expect(first).rejects.toMatchObject({ name: 'CloudStoreError', category: 'network' });
      await jest.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(await source.getAccessToken()).toBe('A2');
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  }, 5000);
});
