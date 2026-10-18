import { sha256 } from '@noble/hashes/sha2.js';

import { base64Url, MICROSOFT_REDIRECT_URI } from '@/features/cloud-store/microsoft-oauth';
import { createFakeGraph } from '@/test/fake-graph-server';

import { createMicrosoftSignIn } from './microsoft-sign-in';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const random = async (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) % 256);

describe('createMicrosoftSignIn', () => {
  test('opens the consumers authorize URL with the app redirect; a success redirect carrying the right state is exchanged for tokens (PKCE verifier checked by the fake)', async () => {
    const graph = createFakeGraph();
    const opened: string[] = [];
    const signIn = createMicrosoftSignIn({
      fetchImpl: graph.fetch, random,
      openAuthSession: async (url, redirect) => {
        opened.push(url, redirect);
        const q = new URL(url).searchParams;
        const code = graph.authCode(q.get('code_challenge')!);
        return { type: 'success', url: `${MICROSOFT_REDIRECT_URI}?code=${code}&state=${q.get('state')}` };
      },
    });
    const out = await signIn();
    expect(out).toMatchObject({ ok: true, tokens: { accessToken: expect.any(String), refreshToken: expect.any(String) } });
    expect(opened[0]).toMatch(/^https:\/\/login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/authorize\?/);
    expect(opened[1]).toBe('waifudeck://auth/onedrive');
    const q = new URL(opened[0]!).searchParams;
    expect(q.get('code_challenge')).toBe(base64Url(sha256(new TextEncoder().encode(base64Url(await random(32))))));
  });
  test('cancel / dismiss → sign_in_cancelled; access_denied → sign_in_cancelled; a foreign state → credential_rejected (state_mismatch) with no token call', async () => {
    const graph = createFakeGraph();
    for (const type of ['cancel', 'dismiss']) {
      const signIn = createMicrosoftSignIn({ fetchImpl: graph.fetch, random, openAuthSession: async () => ({ type }) });
      expect(await signIn()).toEqual({ ok: false, category: 'sign_in_cancelled', detail: type });
    }
    const denied = createMicrosoftSignIn({ fetchImpl: graph.fetch, random, openAuthSession: async (url) => ({ type: 'success', url: `${MICROSOFT_REDIRECT_URI}?error=access_denied&state=${new URL(url).searchParams.get('state')}` }) });
    expect(await denied()).toMatchObject({ ok: false, category: 'sign_in_cancelled', detail: 'access_denied' });
    const forged = createMicrosoftSignIn({ fetchImpl: graph.fetch, random, openAuthSession: async () => ({ type: 'success', url: `${MICROSOFT_REDIRECT_URI}?code=C&state=NOPE` }) });
    expect(await forged()).toMatchObject({ ok: false, category: 'credential_rejected', detail: 'state_mismatch' });
    expect(graph.calls.filter((c) => c.url.includes('/token'))).toHaveLength(0);
  });
  test('a token endpoint that refuses the code is credential_rejected; a network throw is network; a browser that cannot open is sign_in_cancelled', async () => {
    const graph = createFakeGraph();
    const bad = createMicrosoftSignIn({ fetchImpl: graph.fetch, random, openAuthSession: async (url) => ({ type: 'success', url: `${MICROSOFT_REDIRECT_URI}?code=not-issued&state=${new URL(url).searchParams.get('state')}` }) });
    expect(await bad()).toMatchObject({ ok: false, category: 'credential_rejected' });
    const offline = createMicrosoftSignIn({ fetchImpl: async () => { throw new TypeError('Network request failed'); }, random, openAuthSession: async (url) => ({ type: 'success', url: `${MICROSOFT_REDIRECT_URI}?code=C&state=${new URL(url).searchParams.get('state')}` }) });
    expect(await offline()).toMatchObject({ ok: false, category: 'network' });
    const noBrowser = createMicrosoftSignIn({ fetchImpl: graph.fetch, random, openAuthSession: async () => { throw new Error('No activity found to handle intent'); } });
    expect(await noBrowser()).toMatchObject({ ok: false, category: 'sign_in_cancelled', detail: expect.stringContaining('No activity') });
  });
  test('a transient token-endpoint failure (503) and a transient provider redirect error (temporarily_unavailable) are network, not credential_rejected', async () => {
    const graph = createFakeGraph();
    const busy = createMicrosoftSignIn({
      fetchImpl: async () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } }),
      random,
      openAuthSession: async (url) => ({ type: 'success', url: `${MICROSOFT_REDIRECT_URI}?code=C&state=${new URL(url).searchParams.get('state')}` }),
    });
    expect(await busy()).toMatchObject({ ok: false, category: 'network' });
    const providerBusy = createMicrosoftSignIn({
      fetchImpl: graph.fetch, random,
      openAuthSession: async (url) => ({ type: 'success', url: `${MICROSOFT_REDIRECT_URI}?error=temporarily_unavailable&state=${new URL(url).searchParams.get('state')}` }),
    });
    expect(await providerBusy()).toMatchObject({ ok: false, category: 'network', detail: 'temporarily_unavailable' });
  });
  test('PKCE is generated fresh per call: two sign-ins through the same port carry different state and code_challenge, and both succeed', async () => {
    const graph = createFakeGraph();
    let counter = 0;
    const counterRandom = async (len: number) => {
      counter += 1;
      const seed = counter;
      return Uint8Array.from({ length: len }, (_, i) => (seed * 31 + i) % 256);
    };
    const opened: string[] = [];
    const signIn = createMicrosoftSignIn({
      fetchImpl: graph.fetch, random: counterRandom,
      openAuthSession: async (url) => {
        opened.push(url);
        const q = new URL(url).searchParams;
        const code = graph.authCode(q.get('code_challenge')!);
        return { type: 'success', url: `${MICROSOFT_REDIRECT_URI}?code=${code}&state=${q.get('state')}` };
      },
    });
    expect(await signIn()).toMatchObject({ ok: true });
    expect(await signIn()).toMatchObject({ ok: true });
    const [q1, q2] = opened.map((u) => new URL(u).searchParams);
    expect(q1!.get('state')).not.toBe(q2!.get('state'));
    expect(q1!.get('code_challenge')).not.toBe(q2!.get('code_challenge'));
  });
});
