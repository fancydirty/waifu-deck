import { openAuthSessionAsync } from 'expo-web-browser';

import {
  buildGoogleAuthorizeUrl, exchangeGoogleCode, GOOGLE_REDIRECT_URI, GoogleAuthError, newGooglePkce, parseGoogleRedirect,
  type TokenSet,
} from '@/features/cloud-store/google-oauth';

import type { S3FetchPort } from './s3-transport';
import { cloudFetch } from './cloud-fetch';

export type GoogleSignInOutcome =
  | { ok: true; tokens: TokenSet }
  | {
      ok: false;
      category: 'sign_in_cancelled' | 'network' | 'credential_rejected';
      /** Diagnostic only, never shown to the user: may carry Google's `error_description` verbatim, so never log it as-is — the Drive gate script scrubs this same field from its captured output. */
      detail?: string;
    };
export type GoogleSignInPort = () => Promise<GoogleSignInOutcome>;

export type GoogleSignInDeps = Readonly<{
  /** `expo-web-browser`'s auth session by default; tests hand back a redirect. */
  openAuthSession?: (url: string, redirectUrl: string) => Promise<{ type: string; url?: string }>;
  fetchImpl?: S3FetchPort;
  random?: (n: number) => Promise<Uint8Array>;
}>;

/**
 * Deliberate twin of `createMicrosoftSignIn` (spec §4.3, 补裁 14 route A):
 * authorization code + PKCE in the system browser (Custom Tab), the code
 * exchanged by the app itself with the iOS-type client, which has no secret.
 * The redirect `com.googleusercontent.apps.…:/oauth2redirect` is the app's
 * second scheme (app.json); `openAuthSessionAsync` resolves with its URL, and
 * `src/app/+native-intent.ts` drops that URL for Expo Router. `state` is
 * checked before the code is used (CSRF).
 *
 * One code, one exchange attempt: Task 1 measured (evidence c7) that a token
 * request which timed out can still have consumed the single-use code — the
 * retry of the same code answered `invalid_grant`. So a failed exchange ends
 * the attempt (`network` for a transient failure) and the user starts a fresh
 * sign-in; this port never re-posts a code.
 */
export function createGoogleSignIn(deps: GoogleSignInDeps = {}): GoogleSignInPort {
  const open = deps.openAuthSession ?? ((url: string, redirectUrl: string) => openAuthSessionAsync(url, redirectUrl));
  const fetchImpl = deps.fetchImpl ?? cloudFetch;
  return async () => {
    const pkce = await newGooglePkce(deps.random);
    let result: { type: string; url?: string };
    try {
      result = await open(buildGoogleAuthorizeUrl({ challenge: pkce.challenge, state: pkce.state }), GOOGLE_REDIRECT_URI);
    } catch (error) {
      // No browser able to host the session (rare on a phone): nothing was authorized.
      return { ok: false, category: 'sign_in_cancelled', detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.type !== 'success' || typeof result.url !== 'string') return { ok: false, category: 'sign_in_cancelled', detail: result.type };
    const parsed = parseGoogleRedirect(result.url, pkce.state);
    if (!parsed.ok) {
      if (parsed.reason === 'access_denied') return { ok: false, category: 'sign_in_cancelled', detail: parsed.reason };
      // RFC 6749 §4.1.2.1: the authorization endpoint itself was momentarily unavailable — no credential was rejected, so this is retryable like any other transient failure.
      if (parsed.reason === 'server_error' || parsed.reason === 'temporarily_unavailable') return { ok: false, category: 'network', detail: parsed.reason };
      return { ok: false, category: 'credential_rejected', detail: parsed.reason };
    }
    try {
      return { ok: true, tokens: await exchangeGoogleCode(fetchImpl, { code: parsed.code, verifier: pkce.verifier }) };
    } catch (error) {
      if (!(error instanceof GoogleAuthError)) return { ok: false, category: 'credential_rejected', detail: error instanceof Error ? error.message : String(error) };
      switch (error.code) {
        case 'network':
        case 'server':
          // No network, a timeout, or the identity host's own 5xx/429: transient, not a rejected credential — but the code may already be spent, so no retry.
          return { ok: false, category: 'network', detail: error.message };
        case 'invalid_grant':
        case 'invalid_request':
          return { ok: false, category: 'credential_rejected', detail: error.message };
        default: {
          const exhaustive: never = error.code;
          return { ok: false, category: 'credential_rejected', detail: `unrecognized Google auth error code: ${exhaustive}` };
        }
      }
    }
  };
}
