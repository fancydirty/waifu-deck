import type { ByosConnectFailure } from '@/features/byos/byos-connect-flow';
import type { ByosBinding } from '@/features/byos/byos-credentials';

/**
 * i18n key for a connect/probe/unlock failure category (D7). `password_mismatch`
 * splits on its `detail` tag; `meta_corrupt` on `meta_absent`. Shared by the
 * section and every connect form so the switch is exhaustive in
 * exactly one place. Keys are built here, so the locale static-key scan
 * cannot see them — `byos-error-key.test.ts` pins every one in all four locales.
 */
export function errorKey(failure: ByosConnectFailure): string {
  switch (failure.category) {
    case 'network': return 'settings.byos.error.network';
    case 'credential_rejected': return 'settings.byos.error.credentialRejected';
    case 'not_s3': return 'settings.byos.error.notS3';
    case 'not_webdav': return 'settings.byos.error.notWebdav';
    case 'not_onedrive': return 'settings.byos.error.notOnedrive';
    case 'not_gdrive': return 'settings.byos.error.notGdrive';
    case 'reauth_required': return 'settings.byos.error.reauthRequired';
    case 'sign_in_cancelled': return 'settings.byos.error.signInCancelled';
    case 'insecure_url': return 'settings.byos.error.insecureUrl';
    case 'meta_corrupt': return failure.detail === 'meta_absent' ? 'settings.byos.error.metaAbsent' : 'settings.byos.error.metaCorrupt';
    case 'wrong_password': return 'settings.byos.error.wrongPassword';
    case 'password_mismatch': return failure.detail === 'password_required' ? 'settings.byos.error.passwordRequired' : 'settings.byos.error.passwordMismatch';
  }
}

/** The two browser sign-in providers; each drive form knows which it is. Derived
 * from the binding kinds because the locale block is named after the kind
 * (`settings.byos.${kind}.signInNetwork`): renaming a kind must break this. */
export type SignInProvider = Extract<ByosBinding['kind'], 'onedrive' | 'gdrive'>;

/**
 * `errorKey`'s one blind spot for the drive sign-in/reauth flows: a `network`
 * failure there means the provider's sign-in page or API (Microsoft's, or
 * Google's) did not answer, not this device's own vault —
 * `settings.byos.error.network` ("Could not reach that address") would
 * misname the party that failed. That sentence is per provider (P12-D Task
 * 8) because it must name the provider the user actually signed in with and
 * never the other one; `provider` is the flow's own, never guessed. Every
 * other category is unchanged from the shared switch. Used by both drive
 * connect forms and by the section's `reauth_required` lock row. The WebDAV
 * and S3 forms keep plain `errorKey`: their `network` is the server itself.
 */
export function signInFlowErrorKey(failure: ByosConnectFailure, provider: SignInProvider): string {
  return failure.category === 'network' ? `settings.byos.${provider}.signInNetwork` : errorKey(failure);
}
