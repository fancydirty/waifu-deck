import { CloudStoreError } from './cloud-object-store';
import { GoogleAuthError, type TokenSet } from './google-oauth';

/**
 * Deliberate twin of microsoft-token-source.ts, minus the `onRotated` write-back:
 * Google does not rotate refresh tokens (spec 补裁 3), so there is nothing to
 * persist after a refresh — the refresh token is kept in memory only. Change
 * both sources together.
 */

/** Refresh this long before `expiresAt`: a request sent with 1 s left would 401 in flight. */
export const GOOGLE_TOKEN_REFRESH_MARGIN_MS = 60_000;

export type GoogleTokenSource = Readonly<{
  /** A bearer token that is valid for at least the margin, refreshing (once, shared) when needed. */
  getAccessToken(): Promise<string>;
  /** A 401 from Drive said the token is bad regardless of `expiresAt`: drop it. */
  invalidate(): void;
}>;

export type GoogleTokenSourceDeps = Readonly<{
  seed: Readonly<{ accessToken: string | null; refreshToken: string; expiresAt: number }>;
  refresh: (refreshToken: string) => Promise<TokenSet>;
  now?: () => number;
}>;

export function createGoogleTokenSource(deps: GoogleTokenSourceDeps): GoogleTokenSource {
  const now = deps.now ?? Date.now;
  let accessToken = deps.seed.accessToken;
  let refreshToken = deps.seed.refreshToken;
  let expiresAt = deps.seed.expiresAt;
  let inFlight: Promise<string> | null = null;

  async function refreshNow(): Promise<string> {
    let set: TokenSet;
    try {
      set = await deps.refresh(refreshToken);
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        switch (error.code) {
          case 'invalid_grant':
            // The saved sign-in is gone (revoked, expired, password changed). Only
            // the user can fix it: the resolver turns this message into the
            // `reauth_required` lock and the settings page offers 「重新登录」.
            throw new CloudStoreError(401, 'auth', `reauth_required: ${error.message}`, true);
          case 'network':
            throw new CloudStoreError(0, 'network', error.message, false);
          case 'server':
            throw new CloudStoreError(503, 'server', error.message, false);
          case 'invalid_request':
            throw new CloudStoreError(400, 'client', error.message, true);
          default: {
            const exhaustive: never = error.code;
            throw new CloudStoreError(400, 'client', `unrecognized Google auth error code: ${exhaustive}`, true);
          }
        }
      }
      throw error;
    }
    accessToken = set.accessToken;
    refreshToken = set.refreshToken;
    expiresAt = set.expiresAt;
    return set.accessToken;
  }

  return {
    async getAccessToken() {
      const current = accessToken;
      if (current !== null && now() < expiresAt - GOOGLE_TOKEN_REFRESH_MARGIN_MS) return current;
      if (inFlight === null) {
        inFlight = refreshNow().finally(() => { inFlight = null; });
      }
      return inFlight;
    },
    invalidate() {
      accessToken = null;
    },
  };
}
