/**
 * Expo Router deep-link filter (docs: /router/advanced/native-intent).
 *
 * P12-C (2026-09-21, owner-phone gate): Microsoft's OAuth redirect
 * `waifudeck://auth/onedrive?code=…&state=…` is delivered to the running
 * activity as a `Linking` url event. `expo-web-browser`'s auth-session
 * polyfill resolves `openAuthSessionAsync` from that event; without this
 * file Expo Router ALSO routed it and, finding no `/auth/onedrive` route,
 * pushed its "Unmatched Route" screen on top of the settings form. Every
 * URL under a callback prefix belongs to the browser polyfill, never to
 * navigation, so the router is told to drop it (`null`). On a cold start
 * through the redirect (`initial: true`) the in-flight sign-in is already
 * lost — the PKCE verifier and `state` live only in memory — so the app
 * simply starts normally and the user signs in again.
 *
 * P12-D (spec §4.3 补裁 4, 14 route A): Google's redirect arrives the same
 * way on the app's second scheme, the reverse client id of the iOS-type app
 * client, so the prefixes are a list.
 *
 * Must never throw: the router calls this with whatever the OS handed it.
 */

/** The reverse-client-id scheme app.json registers beside `waifudeck`; equals the scheme of `GOOGLE_REDIRECT_URI`. */
export const GOOGLE_OAUTH_SCHEME = 'com.googleusercontent.apps.550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec';

export const OAUTH_CALLBACK_PREFIXES: readonly string[] = [
  'waifudeck://auth/',
  `${GOOGLE_OAUTH_SCHEME}:/oauth2redirect`,
];

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  return typeof path === 'string' && OAUTH_CALLBACK_PREFIXES.some((prefix) => path.startsWith(prefix)) ? null : path;
}
