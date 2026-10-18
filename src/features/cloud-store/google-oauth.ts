import { sha256 } from '@noble/hashes/sha2.js';
import { getRandomBytesAsync } from 'expo-crypto';

import { base64Url } from './base64url';

/** 补裁 2: fetched 2026-09-22 from https://developers.google.com/identity/protocols/oauth2/native-app (spec §4.3) — not "remembered" from training data. */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** 补裁 2: fetched from the same native-app doc as GOOGLE_AUTHORIZE_URL — not "remembered". */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** 补裁 2: fetched from the same native-app doc; used only by the Mac gate helper's teardown (Task 12) — the app never revokes. */
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** 补裁 10: drive.file only — the visible "Waifu Deck" folder is the whole product surface (spec §1 goal 2), so no drive.appdata/profile scope is requested (the account e-mail comes from Drive's own `about`). */
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Public identifier of the "Waifu Deck" iOS-type app OAuth client (Task 1 route A decision, 补裁 14) — like MICROSOFT_CLIENT_ID, not a secret; this client has no secret at all. */
export const GOOGLE_CLIENT_ID = '550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec.apps.googleusercontent.com';
/** 补裁 14: Google's reverse-client-id custom scheme for the iOS-type client (Task 1 route A decision) — the client id's DNS labels reversed, one slash after the colon. */
export const GOOGLE_REDIRECT_URI = 'com.googleusercontent.apps.550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec:/oauth2redirect';

export type GoogleAuthErrorCode = 'invalid_grant' | 'invalid_request' | 'server' | 'network';

export class GoogleAuthError extends Error {
  constructor(message: string, readonly code: GoogleAuthErrorCode) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export type TokenSet = Readonly<{ accessToken: string; refreshToken: string; expiresAt: number }>;
export type Pkce = Readonly<{ verifier: string; challenge: string; state: string }>;

/** RFC 7636: 32 random bytes → 43-char verifier; S256 challenge; a separate 16-byte `state`. */
export async function newGooglePkce(random: (n: number) => Promise<Uint8Array> = getRandomBytesAsync): Promise<Pkce> {
  const verifier = base64Url(await random(32));
  const challenge = base64Url(sha256(new TextEncoder().encode(verifier)));
  const state = base64Url(await random(16));
  return { verifier, challenge, state };
}

export function buildGoogleAuthorizeUrl(input: Readonly<{ challenge: string; state: string; redirectUri?: string; clientId?: string; offline?: boolean }>): string {
  const q = new URLSearchParams({
    client_id: input.clientId ?? GOOGLE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: input.redirectUri ?? GOOGLE_REDIRECT_URI,
    scope: GOOGLE_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  });
  if (input.offline) {
    // 补裁 2: a refresh token is (re-)issued to the Mac gate's Web client (Task 12)
    // only with access_type=offline, and re-issued only with prompt=consent.
    q.set('access_type', 'offline');
    q.set('prompt', 'consent');
  } else {
    // P12-C parity: buildAuthorizeUrl sends select_account for the same reason —
    // Waifu Deck's disconnect does not revoke Google's own consent, so without
    // forcing the account chooser a reconnect would silently reuse whichever
    // Google account is already signed in and the user could never switch.
    // access_type stays absent: installed applications are always issued a
    // refresh token (补裁 2), so there is nothing to opt into.
    q.set('prompt', 'select_account');
  }
  return `${GOOGLE_AUTHORIZE_URL}?${q.toString()}`;
}

/** `reason` is one of the two local refusals (`state_mismatch`, `malformed`) or the provider's `error` code verbatim (e.g. `access_denied`); `description` is the provider's `error_description` when present. */
export type RedirectParse = { ok: true; code: string } | { ok: false; reason: string; description?: string };

/** The redirect the browser session hands back; `state` is checked before anything else (CSRF). */
export function parseGoogleRedirect(url: string, expectedState: string): RedirectParse {
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

/** Every token-endpoint request is bounded: a silent identity host (a captive portal) must not hang a refresh forever, which would poison the memoized token source until the process dies. Mirrors TOKEN_REQUEST_TIMEOUT_MS in microsoft-oauth.ts. */
export const GOOGLE_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function postToken(fetchImpl: FetchLike, form: Record<string, string>, now: () => number, previousRefresh: string | null, timeoutMs: number): Promise<TokenSet> {
  // Deliberate twin of postToken in microsoft-oauth.ts — keep both in lockstep.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let res: Response;
  try {
    // Race the request against a hard deadline: a silent host never rejects on its own, so an unbounded await would hang forever and poison the memoized token source.
    res = await Promise.race([
      fetchImpl(GOOGLE_TOKEN_URL, {
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
          reject(new GoogleAuthError(`Token request timed out after ${timeoutMs} ms.`, 'network'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof GoogleAuthError) throw error;
    throw new GoogleAuthError(`Token request failed before a response: ${error instanceof Error ? error.message : String(error)}`, 'network');
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
        reject(new GoogleAuthError(`Token response body timed out after ${timeoutMs} ms.`, 'network'));
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
        if (error instanceof GoogleAuthError) throw error;
        throw new GoogleAuthError(`Token response body could not be read: ${error instanceof Error ? error.message : String(error)}`, 'network');
      }
    } else {
      // A stalled error body falls back to the status-based code below, like an unparseable one.
      try { body = ((await readBody()) as typeof body) ?? {}; } catch { body = {}; }
    }
  } finally {
    clearTimeout(bodyTimer);
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    const code: GoogleAuthErrorCode = res.status >= 500 || res.status === 429 ? 'server' : body.error === 'invalid_grant' ? 'invalid_grant' : 'invalid_request';
    throw new GoogleAuthError(`Token endpoint ${res.status}: ${body.error ?? 'no token'} ${body.error_description ?? ''}`.trim(), code);
  }
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : previousRefresh;
  if (refreshToken === null) throw new GoogleAuthError('Token endpoint returned no refresh token (offline access missing?).', 'invalid_request');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return { accessToken: body.access_token, refreshToken, expiresAt: now() + expiresIn * 1000 };
}

export function exchangeGoogleCode(fetchImpl: FetchLike, input: Readonly<{ code: string; verifier: string; redirectUri?: string; clientId?: string; clientSecret?: string; now?: () => number; timeoutMs?: number }>): Promise<TokenSet> {
  const form: Record<string, string> = {
    client_id: input.clientId ?? GOOGLE_CLIENT_ID,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri ?? GOOGLE_REDIRECT_URI,
    code_verifier: input.verifier,
  };
  // The app never passes this (spec §1): the iOS-type app client has no secret at
  // all, so a form field is added only for the Mac gate's Web client (Task 12).
  if (input.clientSecret !== undefined) form.client_secret = input.clientSecret;
  return postToken(fetchImpl, form, input.now ?? Date.now, null, input.timeoutMs ?? GOOGLE_TOKEN_REQUEST_TIMEOUT_MS);
}

/** Google does not rotate the refresh token on refresh: the input one is the fallback when the response omits it. */
export function refreshGoogleTokens(fetchImpl: FetchLike, input: Readonly<{ refreshToken: string; clientId?: string; clientSecret?: string; now?: () => number; timeoutMs?: number }>): Promise<TokenSet> {
  const form: Record<string, string> = {
    client_id: input.clientId ?? GOOGLE_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  };
  // Same gate-only exception as exchangeGoogleCode above.
  if (input.clientSecret !== undefined) form.client_secret = input.clientSecret;
  return postToken(fetchImpl, form, input.now ?? Date.now, input.refreshToken, input.timeoutMs ?? GOOGLE_TOKEN_REQUEST_TIMEOUT_MS);
}
