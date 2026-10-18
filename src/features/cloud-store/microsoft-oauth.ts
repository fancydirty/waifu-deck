import { sha256 } from '@noble/hashes/sha2.js';
import { getRandomBytesAsync } from 'expo-crypto';

import { base64Url } from './base64url';

export { base64Url };

/** Public identifier of the owner's Azure app registration "Waifu Deck" (spec §4.2 补裁 2). Not a secret. */
export const MICROSOFT_CLIENT_ID = '40d6e21b-ea99-4417-af2c-65b1a290aa0d';
/** Personal Microsoft accounts only: the registration's audience, so the tenant MUST be `consumers`. */
export const MICROSOFT_AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
/** AppFolder-only Graph access + refresh tokens + the account e-mail for the badge. */
export const MICROSOFT_SCOPE = 'Files.ReadWrite.AppFolder offline_access User.Read';
/** Path, not query, distinguishes the purpose: personal-account registrations forbid query strings in redirect URIs. */
export const MICROSOFT_REDIRECT_URI = 'waifudeck://auth/onedrive';

export type MicrosoftAuthErrorCode = 'invalid_grant' | 'invalid_request' | 'server' | 'network';

export class MicrosoftAuthError extends Error {
  constructor(message: string, readonly code: MicrosoftAuthErrorCode) {
    super(message);
    this.name = 'MicrosoftAuthError';
  }
}

export type TokenSet = Readonly<{ accessToken: string; refreshToken: string; expiresAt: number }>;
export type Pkce = Readonly<{ verifier: string; challenge: string; state: string }>;

/** RFC 7636: 32 random bytes → 43-char verifier; S256 challenge; a separate 16-byte `state`. */
export async function newPkce(random: (n: number) => Promise<Uint8Array> = getRandomBytesAsync): Promise<Pkce> {
  const verifier = base64Url(await random(32));
  const challenge = base64Url(sha256(new TextEncoder().encode(verifier)));
  const state = base64Url(await random(16));
  return { verifier, challenge, state };
}

export function buildAuthorizeUrl(input: Readonly<{ challenge: string; state: string; redirectUri?: string }>): string {
  const q = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: input.redirectUri ?? MICROSOFT_REDIRECT_URI,
    response_mode: 'query',
    scope: MICROSOFT_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${MICROSOFT_AUTHORIZE_URL}?${q.toString()}`;
}

/** `reason` is one of the two local refusals (`state_mismatch`, `malformed`) or the provider's `error` code verbatim (e.g. `access_denied`); `description` is the provider's `error_description` when present. */
export type RedirectParse = { ok: true; code: string } | { ok: false; reason: string; description?: string };

/** The redirect the browser session hands back; `state` is checked before anything else (CSRF). */
export function parseRedirect(url: string, expectedState: string): RedirectParse {
  let q: URLSearchParams;
  try {
    q = new URL(url).searchParams;
  } catch {
    // Node's WHATWG URL throws on parse failure; Expo 56 installs whatwg-url-minimum as the on-device global URL (node_modules/expo/src/winter/runtime.native.ts:21), which also throws, so this catch is live in both environments.
    return { ok: false, reason: 'malformed' };
  }
  if (q.get('state') !== expectedState) return { ok: false, reason: 'state_mismatch' };
  const error = q.get('error');
  if (error !== null) return { ok: false, reason: error, description: q.get('error_description') ?? undefined };
  const code = q.get('code');
  return code === null || code === '' ? { ok: false, reason: 'malformed' } : { ok: true, code };
}

/** Every token-endpoint request is bounded: a silent identity host (a captive portal) must not hang a refresh forever, which would poison the memoized token source until the process dies. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function postToken(fetchImpl: FetchLike, form: Record<string, string>, now: () => number, previousRefresh: string | null, timeoutMs: number): Promise<TokenSet> {
  // Deliberate twin of postToken in google-oauth.ts — keep both in lockstep.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let res: Response;
  try {
    // Race the request against a hard deadline: a silent host never rejects on its own, so an unbounded await would hang forever and poison the memoized token source.
    res = await Promise.race([
      fetchImpl(MICROSOFT_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // Reject with our own honest message BEFORE aborting: abort() can
          // synchronously fire a real fetch's own AbortError rejection, and
          // whichever of these two settles this race's promise first wins — a
          // reversed order would let that generic AbortError win and swallow the
          // deadline message.
          reject(new MicrosoftAuthError(`Token request timed out after ${timeoutMs} ms.`, 'network'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof MicrosoftAuthError) throw error;
    throw new MicrosoftAuthError(`Token request failed before a response: ${error instanceof Error ? error.message : String(error)}`, 'network');
  } finally {
    clearTimeout(timer);
  }
  let body: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  // The headers are in, but the device fetch has no read timeout (OkHttp
  // readTimeout(0)), so a body that stalls would hang here exactly like a
  // silent host: re-arm the same deadline for the body on the same controller
  // (board #9, spec §5.2). Same reject-then-abort order as above.
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  const readBody = (): Promise<unknown> => Promise.race([
    res.json(),
    new Promise<never>((_resolve, reject) => {
      bodyTimer = setTimeout(() => {
        reject(new MicrosoftAuthError(`Token response body timed out after ${timeoutMs} ms.`, 'network'));
        controller.abort();
      }, timeoutMs);
    }),
  ]);
  try {
    if (res.ok) {
      // A 200 whose body fails to parse means the connection dropped mid-response: transient, not a permanent rejection.
      try {
        body = ((await readBody()) as typeof body) ?? {};
      } catch (error) {
        if (error instanceof MicrosoftAuthError) throw error;
        throw new MicrosoftAuthError(`Token response body could not be read: ${error instanceof Error ? error.message : String(error)}`, 'network');
      }
    } else {
      // A stalled error body falls back to the status-based code below, like an unparseable one.
      try { body = ((await readBody()) as typeof body) ?? {}; } catch { body = {}; }
    }
  } finally {
    clearTimeout(bodyTimer);
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    const code: MicrosoftAuthErrorCode = res.status >= 500 || res.status === 429 ? 'server' : body.error === 'invalid_grant' ? 'invalid_grant' : 'invalid_request';
    throw new MicrosoftAuthError(`Token endpoint ${res.status}: ${body.error ?? 'no token'} ${body.error_description ?? ''}`.trim(), code);
  }
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : previousRefresh;
  if (refreshToken === null) throw new MicrosoftAuthError('Token endpoint returned no refresh token (offline_access missing?).', 'invalid_request');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return { accessToken: body.access_token, refreshToken, expiresAt: now() + expiresIn * 1000 };
}

export function exchangeCode(fetchImpl: FetchLike, input: Readonly<{ code: string; verifier: string; redirectUri?: string; now?: () => number; timeoutMs?: number }>): Promise<TokenSet> {
  return postToken(fetchImpl, {
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri ?? MICROSOFT_REDIRECT_URI,
    code_verifier: input.verifier,
    scope: MICROSOFT_SCOPE,
  }, input.now ?? Date.now, null, input.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS);
}

/** Personal accounts rotate the refresh token on every refresh: the returned one supersedes the input. */
export function refreshTokens(fetchImpl: FetchLike, input: Readonly<{ refreshToken: string; now?: () => number; timeoutMs?: number }>): Promise<TokenSet> {
  return postToken(fetchImpl, {
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    scope: MICROSOFT_SCOPE,
  }, input.now ?? Date.now, input.refreshToken, input.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS);
}
