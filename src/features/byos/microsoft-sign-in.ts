import { openAuthSessionAsync } from 'expo-web-browser';

import {
  buildAuthorizeUrl, exchangeCode, MICROSOFT_REDIRECT_URI, MicrosoftAuthError, newPkce, parseRedirect, type TokenSet,
} from '@/features/cloud-store/microsoft-oauth';

import type { S3FetchPort } from './s3-transport';
import { cloudFetch } from './cloud-fetch';

export type SignInOutcome =
  | { ok: true; tokens: TokenSet }
  | {
      ok: false;
      category: 'sign_in_cancelled' | 'network' | 'credential_rejected';
      /** Diagnostic only, never shown to the user: may carry the provider's `error_description` verbatim, so never log it as-is — the OneDrive gate script scrubs this same field from its captured output. */
      detail?: string;
    };
export type MicrosoftSignInPort = () => Promise<SignInOutcome>;

export type MicrosoftSignInDeps = Readonly<{
  /** `expo-web-browser`'s auth session by default; tests hand back a redirect. */
  openAuthSession?: (url: string, redirectUrl: string) => Promise<{ type: string; url?: string }>;
  fetchImpl?: S3FetchPort;
  random?: (n: number) => Promise<Uint8Array>;
}>;

/**
 * Spec §4.2 补裁 2: authorization code + PKCE in the system browser (Custom
 * Tab), the code exchanged by the app itself — no `expo-auth-session`, no
 * client secret. The system browser is not a UX choice: Microsoft refuses to
 * host personal-account sign-in inside an embedded webview, and the app must
 * never see the password or the 2FA step. The redirect
 * `waifudeck://auth/onedrive` reopens the running activity (`singleTask`);
 * `openAuthSessionAsync` resolves with its URL. `state` is checked before the
 * code is used (CSRF). Expo Router receives the same url event and would
 * route it to its not-found screen; `src/app/+native-intent.ts` drops every
 * `waifudeck://auth/` URL for the router (owner-phone finding 2026-09-21).
 */
export function createMicrosoftSignIn(deps: MicrosoftSignInDeps = {}): MicrosoftSignInPort {
  const open = deps.openAuthSession ?? ((url: string, redirectUrl: string) => openAuthSessionAsync(url, redirectUrl));
  const fetchImpl = deps.fetchImpl ?? cloudFetch;
  return async () => {
    const pkce = await newPkce(deps.random);
    let result: { type: string; url?: string };
    try {
      result = await open(buildAuthorizeUrl({ challenge: pkce.challenge, state: pkce.state }), MICROSOFT_REDIRECT_URI);
    } catch (error) {
      // No browser able to host the session (rare on a phone): nothing was authorized.
      return { ok: false, category: 'sign_in_cancelled', detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.type !== 'success' || typeof result.url !== 'string') return { ok: false, category: 'sign_in_cancelled', detail: result.type };
    const parsed = parseRedirect(result.url, pkce.state);
    if (!parsed.ok) {
      if (parsed.reason === 'access_denied') return { ok: false, category: 'sign_in_cancelled', detail: parsed.reason };
      // RFC 6749 §4.1.2.1: the authorization endpoint itself was momentarily unavailable — no credential was rejected, so this is retryable like any other transient failure.
      if (parsed.reason === 'server_error' || parsed.reason === 'temporarily_unavailable') return { ok: false, category: 'network', detail: parsed.reason };
      return { ok: false, category: 'credential_rejected', detail: parsed.reason };
    }
    try {
      return { ok: true, tokens: await exchangeCode(fetchImpl, { code: parsed.code, verifier: pkce.verifier }) };
    } catch (error) {
      if (!(error instanceof MicrosoftAuthError)) return { ok: false, category: 'credential_rejected', detail: error instanceof Error ? error.message : String(error) };
      switch (error.code) {
        case 'network':
        case 'server':
          // No network, a timeout, or the identity host's own 5xx/429: transient, not a rejected credential.
          return { ok: false, category: 'network', detail: error.message };
        case 'invalid_grant':
        case 'invalid_request':
          return { ok: false, category: 'credential_rejected', detail: error.message };
        default: {
          const exhaustive: never = error.code;
          return { ok: false, category: 'credential_rejected', detail: `unrecognized Microsoft auth error code: ${exhaustive}` };
        }
      }
    }
  };
}
