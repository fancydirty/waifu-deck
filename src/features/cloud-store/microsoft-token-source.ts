import { CloudStoreError } from './cloud-object-store';
import { MicrosoftAuthError, type TokenSet } from './microsoft-oauth';

/** Refresh this long before `expiresAt`: a request sent with 1 s left would 401 in flight. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export type MicrosoftTokenSource = Readonly<{
  /** A bearer token that is valid for at least the margin, refreshing (once, shared) when needed. */
  getAccessToken(): Promise<string>;
  /** A 401 from Graph said the token is bad regardless of `expiresAt`: drop it. */
  invalidate(): void;
}>;

export type MicrosoftTokenSourceDeps = Readonly<{
  seed: Readonly<{ accessToken: string | null; refreshToken: string; expiresAt: number }>;
  refresh: (refreshToken: string) => Promise<TokenSet>;
  /**
   * Personal Microsoft accounts rotate the refresh token on EVERY refresh and
   * the previous one stops working, so whoever holds the binding must persist
   * the new value at once — a crash between refresh and write-back would leave
   * a dead token and force a re-login. Awaited before the access token is
   * handed out; a failure here is swallowed (the next refresh writes again).
   */
  onRotated: (refreshToken: string) => Promise<void> | void;
  now?: () => number;
}>;

export function createMicrosoftTokenSource(deps: MicrosoftTokenSourceDeps): MicrosoftTokenSource {
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
      if (error instanceof MicrosoftAuthError) {
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
            throw new CloudStoreError(400, 'client', `unrecognized Microsoft auth error code: ${exhaustive}`, true);
          }
        }
      }
      throw error;
    }
    const rotated = set.refreshToken !== refreshToken;
    accessToken = set.accessToken;
    refreshToken = set.refreshToken;
    expiresAt = set.expiresAt;
    if (rotated) {
      try { await deps.onRotated(set.refreshToken); } catch { /* next refresh writes again */ }
    }
    return set.accessToken;
  }

  return {
    async getAccessToken() {
      const current = accessToken;
      if (current !== null && now() < expiresAt - TOKEN_REFRESH_MARGIN_MS) return current;
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
