import { MicrosoftAuthError, refreshTokens, type TokenSet } from './microsoft-oauth';
import { createMicrosoftTokenSource, TOKEN_REFRESH_MARGIN_MS } from './microsoft-token-source';

function harness(seed: { accessToken?: string | null; refreshToken: string; expiresAt?: number }) {
  let now = 1_000_000;
  const refreshCalls: string[] = [];
  const rotated: string[] = [];
  let nextSet: () => Promise<TokenSet> = async () => ({ accessToken: `AT-${refreshCalls.length}`, refreshToken: `RT-${refreshCalls.length}`, expiresAt: now + 3600_000 });
  const source = createMicrosoftTokenSource({
    seed: { accessToken: seed.accessToken ?? null, refreshToken: seed.refreshToken, expiresAt: seed.expiresAt ?? 0 },
    refresh: async (rt) => { refreshCalls.push(rt); return nextSet(); },
    onRotated: async (rt) => { rotated.push(rt); },
    now: () => now,
  });
  return { source, refreshCalls, rotated, advance: (ms: number) => { now += ms; }, setNext: (f: typeof nextSet) => { nextSet = f; } };
}

describe('createMicrosoftTokenSource', () => {
  test('serves the seeded access token while it is fresh, without refreshing', async () => {
    const h = harness({ accessToken: 'SEED', refreshToken: 'RT0', expiresAt: 1_000_000 + 3600_000 });
    expect(await h.source.getAccessToken()).toBe('SEED');
    expect(h.refreshCalls).toEqual([]);
  });
  test('refreshes when within the 60 s margin, and reports the ROTATED refresh token before resolving', async () => {
    const h = harness({ accessToken: 'SEED', refreshToken: 'RT0', expiresAt: 1_000_000 + TOKEN_REFRESH_MARGIN_MS - 1 });
    expect(TOKEN_REFRESH_MARGIN_MS).toBe(60_000);
    expect(await h.source.getAccessToken()).toBe('AT-1');
    expect(h.refreshCalls).toEqual(['RT0']);
    expect(h.rotated).toEqual(['RT-1']);
    h.advance(3600_000 - TOKEN_REFRESH_MARGIN_MS - 1); // expiresAt - margin - 1 ms: still fresh
    expect(await h.source.getAccessToken()).toBe('AT-1');
    expect(h.refreshCalls).toEqual(['RT0']);
    h.advance(1); // exactly at expiresAt - margin: must refresh
    expect(await h.source.getAccessToken()).toBe('AT-2');
    expect(h.refreshCalls).toEqual(['RT0', 'RT-1']);
  });
  test('the rotated token is written back BEFORE the access token is handed out', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rotated: string[] = [];
    const source = createMicrosoftTokenSource({
      seed: { accessToken: null, refreshToken: 'RT0', expiresAt: 0 },
      refresh: async () => ({ accessToken: 'AT-1', refreshToken: 'RT-1', expiresAt: 3600_000 }),
      onRotated: (rt) => gate.then(() => { rotated.push(rt); }),
      now: () => 0,
    });
    let settled = false;
    const pending = source.getAccessToken().then((t) => { settled = true; return t; });
    await new Promise((r) => setTimeout(r, 0)); // drain every microtask
    expect(settled).toBe(false); // a fire-and-forget write-back would already be true
    release();
    expect(await pending).toBe('AT-1');
    expect(rotated).toEqual(['RT-1']);
  });
  test('concurrent callers share ONE refresh (single-flight)', async () => {
    const h = harness({ accessToken: null, refreshToken: 'RT0' });
    const tokens = await Promise.all([h.source.getAccessToken(), h.source.getAccessToken(), h.source.getAccessToken()]);
    expect(tokens).toEqual(['AT-1', 'AT-1', 'AT-1']);
    expect(h.refreshCalls).toEqual(['RT0']);
  });
  test('invalidate() forces the next call to refresh even if the token looks fresh (a 401 said otherwise)', async () => {
    const h = harness({ accessToken: 'SEED', refreshToken: 'RT0', expiresAt: 1_000_000 + 3600_000 });
    h.source.invalidate();
    expect(await h.source.getAccessToken()).toBe('AT-1');
  });
  test('invalid_grant becomes CloudStoreError 401/auth whose message names reauth_required; the source stays usable after a later successful refresh', async () => {
    const h = harness({ accessToken: null, refreshToken: 'RT0' });
    h.setNext(async () => { throw new MicrosoftAuthError('AADSTS70000 revoked', 'invalid_grant'); });
    await expect(h.source.getAccessToken()).rejects.toMatchObject({ status: 401, category: 'auth', message: expect.stringContaining('reauth_required') });
    expect(h.rotated).toEqual([]);
    h.setNext(async () => ({ accessToken: 'AT-x', refreshToken: 'RT-x', expiresAt: 9_000_000 }));
    expect(await h.source.getAccessToken()).toBe('AT-x');
  });
  test('network / server refresh failures are CloudStoreError network / server (retryable), never auth', async () => {
    const h = harness({ accessToken: null, refreshToken: 'RT0' });
    h.setNext(async () => { throw new MicrosoftAuthError('down', 'server'); });
    await expect(h.source.getAccessToken()).rejects.toMatchObject({ category: 'server' });
    h.setNext(async () => { throw new MicrosoftAuthError('offline', 'network'); });
    await expect(h.source.getAccessToken()).rejects.toMatchObject({ category: 'network' });
  });
  test('an onRotated failure does not lose the token (logged by the caller; the next refresh writes again)', async () => {
    let now = 0;
    const seen: string[] = [];
    const source = createMicrosoftTokenSource({
      seed: { accessToken: null, refreshToken: 'RT0', expiresAt: 0 },
      refresh: async (rt) => { seen.push(rt); return { accessToken: 'AT', refreshToken: 'RT1', expiresAt: 100_000 }; },
      onRotated: async () => { throw new Error('keychain busy'); },
      now: () => now,
    });
    expect(await source.getAccessToken()).toBe('AT');
    source.invalidate();
    expect(await source.getAccessToken()).toBe('AT');
    // If a failed write-back reverted the in-memory refresh token, this second
    // refresh would replay 'RT0' (already dead server-side) instead of 'RT1'.
    expect(seen).toEqual(['RT0', 'RT1']);
  });
  test('a refresh that returns the SAME refresh token does not call onRotated; the next refresh reuses the rotated token', async () => {
    const h = harness({ accessToken: null, refreshToken: 'RT0' });
    h.setNext(async () => ({ accessToken: 'AT-same', refreshToken: 'RT0', expiresAt: 1_000_000 + 10 }));
    expect(await h.source.getAccessToken()).toBe('AT-same');
    expect(h.rotated).toEqual([]);
    h.advance(1000);
    h.setNext(async () => ({ accessToken: 'AT-2', refreshToken: 'RT-2', expiresAt: 5_000_000 }));
    expect(await h.source.getAccessToken()).toBe('AT-2');
    expect(h.refreshCalls).toEqual(['RT0', 'RT0']);
    h.source.invalidate();
    await h.source.getAccessToken();
    expect(h.refreshCalls[2]).toBe('RT-2');
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
        return new Response(JSON.stringify({ access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600 }), { status: 200 });
      };
      const source = createMicrosoftTokenSource({
        seed: { accessToken: null, refreshToken: 'RT0', expiresAt: 0 },
        refresh: (rt) => refreshTokens(fetchImpl, { refreshToken: rt, now: () => 0, timeoutMs: 1000 }),
        onRotated: () => {},
        now: () => 0,
      });
      const first = source.getAccessToken();
      const rejected = expect(first).rejects.toMatchObject({ name: 'CloudStoreError', category: 'network' });
      await jest.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(await source.getAccessToken()).toBe('AT-2');
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  }, 5000);
});
