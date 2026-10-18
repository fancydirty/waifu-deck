import type { ByosBinding } from '@/features/byos/byos-credentials';
import type { ByosConnectFailure } from '@/features/byos/byos-connect-flow';
import type { ByosSignInProvider, ByosStatus } from '@/features/byos/byos-context-resolver';
import type { VaultEncryption } from '@/features/byos/byos-vault-meta';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';

import { LOCATION_LABEL_KEY } from './storage-location-picker';

/**
 * Display-only derivation for the Settings cloud card and 云库 page
 * (spec §4.2; plan N4 CD 3–6, CD 13). Everything here is pure: BYOS and
 * library imports are type-only, no credential/transport is constructed, and
 * the clock always arrives as an argument. The async reader that feeds these
 * functions is Task 2's `useCloudLibraryData`; rendering is Task 3/4.
 */

/**
 * One async read's lifecycle. Grouped local reads (counts, watermark,
 * quota-full) carry the round id they belong to; generation-scoped reads
 * (identity, storage mode) use `roundId: null`.
 */
export type ReadValue<T> =
  | Readonly<{ state: 'unread' | 'pending' | 'error'; fresh: false; roundId: number | null }>
  | Readonly<{ state: 'read'; value: T; fresh: boolean; roundId: number | null }>;

/** The six status sentences. Home shows only these; derivation emits only these. */
export type CloudLockMessage = 'unlock' | 'reauth' | 'network'
  | 'credentialRejected' | 'unreadable' | 'other';

/**
 * Page feedback for a failed configured unlock/reauth: the four action-specific
 * suffixes plus four reused status sentences. Status-only `unlock`/`network`
 * are excluded — neither may answer an action failure (plan N4 A5/A6).
 */
export type CloudActionMessage = 'wrongPassword' | 'passwordRequired'
  | 'signInCancelled' | 'networkAction'
  | 'reauth' | 'credentialRejected' | 'unreadable' | 'other';

export type CloudLockMessageKey = `settings.cloudLibrary.lockMessage.${CloudLockMessage}`;
export type CloudActionMessageKey = `settings.cloudLibrary.lockMessage.${CloudActionMessage}`;

export type CloudIdentity = Readonly<{
  kind: ByosBinding['kind']; label: string; identity: string;
}>;

export type CloudCardState = 'unconfigured' | 'loading' | 'ready'
  | 'password-required' | 'reauth-required' | 'unreachable' | 'unreadable';

export type CloudFooter =
  | Readonly<{ kind: 'quota-full' | 'pending' | 'downloading'; count: number }>
  | Readonly<{ kind: 'synced'; at: number }>
  | Readonly<{ kind: 'never-synced' }>;

export type CloudLibraryModel = Readonly<{
  state: CloudCardState;
  identity: CloudIdentity | null;
  tone: 'ok' | 'warn' | 'bad' | null;
  messageKey: CloudLockMessageKey | CloudActionMessageKey | null;
  reauthProvider: ByosSignInProvider | null;
  stats: Readonly<{ inCloud: number; totalBytes: number; pending: number }> | null;
  footer: CloudFooter | null;
  storageMode: LibraryStorageMode | null;
  encryption: VaultEncryption | null;
}>;

type CloudTranslate = (key: string) => string;

/**
 * Whether a stored address that `new URL` rejected may still be shown as
 * itself. Anything credential-shaped (`@`), addressable past the authority
 * (`?`, `#`) or containing whitespace is never user-facing text (CD 5); such
 * addresses degrade to the generic provider label instead.
 */
function displayableAddress(raw: string): boolean {
  return raw !== '' && !/[@?#\s]/.test(raw);
}

type LockPresentation = Readonly<{
  state: 'password-required' | 'reauth-required' | 'unreachable' | 'unreadable';
  tone: 'warn' | 'bad';
  messageKey: CloudLockMessageKey;
  reauthProvider: ByosSignInProvider | null;
}>;

/**
 * CD 13's exhaustive status mapping. Every `ByosStatus.locked` reason/detail
 * selects exactly one of the six sentences, returned as a literal full key —
 * a new reason/detail fails to compile instead of rendering a raw key.
 */
function lockPresentation(status: Extract<ByosStatus, { status: 'locked' }>): LockPresentation {
  switch (status.reason) {
    case 'password_required':
      return {
        state: 'password-required', tone: 'warn',
        messageKey: 'settings.cloudLibrary.lockMessage.unlock', reauthProvider: null,
      };
    case 'vault_unreachable': {
      if (status.detail === 'reauth_required') {
        return {
          state: 'reauth-required', tone: 'warn',
          messageKey: 'settings.cloudLibrary.lockMessage.reauth', reauthProvider: status.provider,
        };
      }
      switch (status.detail) {
        case 'network':
          return {
            state: 'unreachable', tone: 'warn',
            messageKey: 'settings.cloudLibrary.lockMessage.network', reauthProvider: null,
          };
        case 'credential_rejected':
          return {
            state: 'unreachable', tone: 'warn',
            messageKey: 'settings.cloudLibrary.lockMessage.credentialRejected', reauthProvider: null,
          };
        case 'not_s3':
        case 'not_webdav':
        case 'not_onedrive':
        case 'not_gdrive':
          return {
            state: 'unreachable', tone: 'warn',
            messageKey: 'settings.cloudLibrary.lockMessage.other', reauthProvider: null,
          };
      }
      break;
    }
    case 'meta_corrupt':
      return {
        state: 'unreadable', tone: 'bad',
        messageKey: 'settings.cloudLibrary.lockMessage.unreadable', reauthProvider: null,
      };
  }
}

/** One of the six status sentences, or none for unconfigured/ready. */
export function deriveCloudLockMessageKey(status: ByosStatus): CloudLockMessageKey | null {
  if (status.status !== 'locked') return null;
  return lockPresentation(status).messageKey;
}

/** The one status/hero sentence used by the page-side cloud section. */
export function formatCloudLibraryMessage(
  model: CloudLibraryModel,
  t: CloudTranslate,
): string | undefined {
  if (model.state === 'unconfigured') return t('settings.cloudLibrary.heroDetail');
  return model.messageKey === null ? undefined : t(model.messageKey);
}

/**
 * CD 13's exhaustive mapping for a failed configured unlock/reauth action,
 * over the shared `ByosConnectFailure` vocabulary. `password_mismatch` splits
 * on its `password_required` detail tag. A network action failure is
 * `networkAction` (manual next step, no automatic-recovery promise) — never
 * the status `network` sentence. Literal full keys throughout.
 */
export function deriveCloudActionMessageKey(failure: ByosConnectFailure): CloudActionMessageKey {
  switch (failure.category) {
    case 'wrong_password': return 'settings.cloudLibrary.lockMessage.wrongPassword';
    case 'password_mismatch':
      return failure.detail === 'password_required'
        ? 'settings.cloudLibrary.lockMessage.passwordRequired'
        : 'settings.cloudLibrary.lockMessage.wrongPassword';
    case 'sign_in_cancelled': return 'settings.cloudLibrary.lockMessage.signInCancelled';
    case 'network': return 'settings.cloudLibrary.lockMessage.networkAction';
    case 'reauth_required': return 'settings.cloudLibrary.lockMessage.reauth';
    case 'credential_rejected': return 'settings.cloudLibrary.lockMessage.credentialRejected';
    case 'meta_corrupt': return 'settings.cloudLibrary.lockMessage.unreadable';
    case 'not_s3':
    case 'not_webdav':
    case 'not_onedrive':
    case 'not_gdrive':
    case 'insecure_url': return 'settings.cloudLibrary.lockMessage.other';
  }
}

/**
 * CD 5. The stored binding is display-safe to project: S3 shows bucket (with
 * the endpoint host branded R2/Wasabi on a whole-domain suffix match),
 * WebDAV shows `host · username`, drives show the localized provider name and
 * the account email. A stored URL is validated only as a string, so parsing
 * degrades instead of throwing; an address in credential form is never shown.
 */
export function deriveCloudIdentity(binding: ByosBinding, t: CloudTranslate): CloudIdentity {
  switch (binding.kind) {
    case 's3': {
      let parsed: URL | null = null;
      try {
        parsed = new URL(binding.endpoint);
      } catch {
        parsed = null;
      }
      // Brand matching compares the lowercase hostname — no port, and a
      // hostname can never carry userinfo. A URL without a host (e.g.
      // `user:secret@bad`, which parses as a non-special scheme) is not an
      // endpoint and falls to the raw-address handling.
      const hostname = parsed !== null && parsed.hostname !== ''
        ? parsed.hostname.toLowerCase()
        : null;
      if (parsed !== null && hostname !== null) {
        // The displayed address for any other provider is the port-bearing
        // host, so a `:9000` endpoint keeps its full storage identity.
        const label = hostname === 'r2.cloudflarestorage.com'
          || hostname.endsWith('.r2.cloudflarestorage.com')
          ? 'Cloudflare R2'
          : hostname === 'storage.bunnycdn.com' || hostname.endsWith('.storage.bunnycdn.com')
            ? 'Bunny.net'
            : hostname === 'backblazeb2.com' || hostname.endsWith('.backblazeb2.com')
              ? 'Backblaze B2'
              : hostname === 'wasabisys.com' || hostname.endsWith('.wasabisys.com')
                ? 'Wasabi'
                : parsed.host;
        return { kind: 's3', label, identity: binding.bucket };
      }
      const raw = binding.endpoint.trim();
      const label = displayableAddress(raw) ? raw : t(LOCATION_LABEL_KEY.s3);
      return { kind: 's3', label, identity: binding.bucket };
    }
    case 'webdav': {
      let host: string | null = null;
      try {
        // A parse without a host (e.g. `nas.example:5006`, which reads as a
        // non-special scheme) is no WebDAV base either and falls to the
        // raw-address handling.
        const parsed = new URL(binding.baseUrl);
        host = parsed.host === '' ? null : parsed.host;
      } catch {
        host = null;
      }
      if (host === null) {
        const raw = binding.baseUrl.trim();
        host = displayableAddress(raw) ? raw : '';
      }
      const identity = binding.username === ''
        ? host
        : host === '' ? binding.username : `${host} · ${binding.username}`;
      return { kind: 'webdav', label: 'WebDAV', identity };
    }
    case 'onedrive':
      return {
        kind: 'onedrive', label: t(LOCATION_LABEL_KEY.onedrive), identity: binding.accountEmail,
      };
    case 'gdrive':
      return {
        kind: 'gdrive', label: t(LOCATION_LABEL_KEY.gdrive), identity: binding.accountEmail,
      };
  }
}

export type CloudFooterInput = Readonly<{
  counts: ReadValue<LibraryMirrorCounts>;
  mode: ReadValue<LibraryStorageMode>;
  lastSyncedAt: ReadValue<number | null>;
  quotaFullCount: ReadValue<number>;
  readRoundId: number;
}>;

function current<T>(
  value: ReadValue<T>,
  readRoundId: number,
): value is Extract<ReadValue<T>, { state: 'read' }> & { fresh: true; roundId: number } {
  return value.state === 'read' && value.fresh && value.roundId === readRoundId;
}

/**
 * CD 6's footer priority, first matching claim wins. Every input a claim
 * needs — including the exclusion of higher-priority claims — must be a fresh
 * value from the current round; a stale prerequisite suppresses the footer
 * entirely while stale stats remain displayed. `mode` is generation-scoped, so
 * only its freshness is required. In cloud-only mode not-downloaded originals
 * are intentional and never claim downloading.
 */
export function deriveCloudFooter(input: CloudFooterInput): CloudFooter | null {
  const { counts, mode, lastSyncedAt, quotaFullCount, readRoundId } = input;
  if (!current(quotaFullCount, readRoundId)) return null;
  if (quotaFullCount.value > 0) return { kind: 'quota-full', count: quotaFullCount.value };
  if (!current(counts, readRoundId)) return null;
  if (counts.value.pending > 0) return { kind: 'pending', count: counts.value.pending };
  if (!(mode.state === 'read' && mode.fresh)) return null;
  if (mode.value === 'both' && counts.value.downloadedTotal > counts.value.downloaded) {
    return { kind: 'downloading', count: counts.value.downloadedTotal - counts.value.downloaded };
  }
  if (!current(lastSyncedAt, readRoundId)) return null;
  return lastSyncedAt.value === null
    ? { kind: 'never-synced' }
    : { kind: 'synced', at: lastSyncedAt.value };
}

export type CloudLibraryModelInput = Readonly<{
  byosStatus: ByosStatus;
  identity: ReadValue<CloudIdentity | null>;
  counts: ReadValue<LibraryMirrorCounts>;
  mode: ReadValue<LibraryStorageMode>;
  lastSyncedAt: ReadValue<number | null>;
  quotaFullCount: ReadValue<number>;
  readRoundId: number;
}>;

function readIdentity(value: ReadValue<CloudIdentity | null>): CloudIdentity | null {
  return value.state === 'read' ? value.value : null;
}

/**
 * Derives the whole card model. State precedence is unconfigured, then the
 * exact locked variant, then ready/loading. Loading is only the view state
 * while the first configured reads are in flight — an absent or rejected
 * counts read is a settled answer that renders as 「—」, never as placeholders
 * or zeros. Locks carry no stats/mode/encryption guesses and never degrade
 * into unconfigured; a pending identity does not suppress a lock's pill.
 */
export function deriveCloudLibraryModel(input: CloudLibraryModelInput): CloudLibraryModel {
  const { byosStatus: status } = input;
  if (status.status === 'unconfigured') {
    return {
      state: 'unconfigured', identity: null, tone: null, messageKey: null,
      reauthProvider: null, stats: null, footer: null, storageMode: null, encryption: null,
    };
  }
  if (status.status === 'locked') {
    const { state, tone, messageKey, reauthProvider } = lockPresentation(status);
    return {
      state, tone, messageKey, reauthProvider,
      identity: readIdentity(input.identity),
      stats: null, footer: null, storageMode: null, encryption: null,
    };
  }
  const identity = readIdentity(input.identity);
  if (input.identity.state === 'unread' || input.identity.state === 'pending'
    || input.counts.state === 'pending') {
    return {
      state: 'loading', identity, tone: null, messageKey: null,
      reauthProvider: null, stats: null, footer: null, storageMode: null, encryption: null,
    };
  }
  return {
    state: 'ready',
    tone: 'ok',
    messageKey: null,
    reauthProvider: null,
    identity,
    // The UI stat 在云端 is `downloadedTotal`; the repository's `inCloud` keeps
    // its different missing-local-original meaning (CD 3).
    stats: input.counts.state === 'read'
      ? {
          inCloud: input.counts.value.downloadedTotal,
          totalBytes: input.counts.value.totalBytes,
          pending: input.counts.value.pending,
        }
      : null,
    footer: deriveCloudFooter(input),
    storageMode: input.mode.state === 'read' && input.mode.fresh ? input.mode.value : null,
    encryption: status.context.meta.encryption,
  };
}
