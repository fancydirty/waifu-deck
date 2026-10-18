import type { ByosBinding, ByosCredentials, WebdavBinding } from '@/features/byos/byos-credentials';
import type { ByosConnectFailure } from '@/features/byos/byos-connect-flow';
import type {
  ByosSignInProvider,
  ByosStatus,
} from '@/features/byos/byos-context-resolver';
import type { VaultEncryption, VaultMeta } from '@/features/byos/byos-vault-meta';
import type { LibraryMirrorCounts } from '@/features/library/library-protection-repository';
import type { LibraryStorageMode } from '@/features/library/library-storage-mode';

import type {
  CloudFooter,
  CloudIdentity,
  ReadValue,
} from './cloud-library-model';
import {
  deriveCloudActionMessageKey,
  deriveCloudFooter,
  deriveCloudIdentity,
  deriveCloudLibraryModel,
  deriveCloudLockMessageKey,
} from './cloud-library-model';

// The model imports LOCATION_LABEL_KEY from the picker module, whose render
// tree pulls lucide in; nothing here renders, so stub it like the picker's
// own test does.
jest.mock('lucide-react-native', () => {
  const Icon = () => null;
  return { ChevronRight: Icon };
});

const ROUND = 7;

/**
 * Every count is distinct so a mutation that swaps the card's 在云端 to
 * `inCloud`/`backedUp`, or swaps `totalBytes` with `inCloudBytes`, reads the
 * wrong figure. Internally consistent: inCloud = 5−3, pending = 8−1.
 */
const COUNTS: LibraryMirrorCounts = {
  backedUp: 1,
  backedUpTotal: 8,
  downloaded: 3,
  downloadedTotal: 5,
  inCloud: 2,
  inCloudBytes: 567,
  pending: 7,
  totalBytes: 1234,
};

const IDENTITY: CloudIdentity = { kind: 's3', label: 'Cloudflare R2', identity: 'my-bucket' };

const read = <T,>(value: T, options?: { fresh?: boolean; roundId?: number | null }): ReadValue<T> => ({
  state: 'read',
  value,
  fresh: options?.fresh ?? true,
  roundId: options?.roundId === undefined ? ROUND : options.roundId,
});
const unread = <T,>(): ReadValue<T> => ({ state: 'unread', fresh: false, roundId: null });
const pendingRead = <T,>(): ReadValue<T> => ({ state: 'pending', fresh: false, roundId: ROUND });
const errored = <T,>(): ReadValue<T> => ({ state: 'error', fresh: false, roundId: ROUND });

function vaultMeta(encryption: VaultEncryption): VaultMeta {
  return {
    format: 'waifu-deck-byos',
    protocolVersion: 2,
    encryption,
    vaultId: 'vault-1',
    kdf: { algo: 'scrypt', N: 16_384, r: 8, p: 1, saltB64: 'c2FsdA==' },
    keyCheckB64: 'a2V5LWNoZWNr',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const s3Credentials = (endpoint: string): ByosCredentials => ({
  kind: 's3',
  endpoint,
  region: 'auto',
  bucket: 'my-bucket',
  accessKeyId: 'AKIA-test-key',
  secretAccessKey: 'shhh-secret-value',
  prefix: 'waifu-deck/',
});

type ReadyStatus = Extract<ByosStatus, { status: 'ready' }>;

const readyS3 = (endpoint = 'https://abc123.r2.cloudflarestorage.com', encryption: VaultEncryption = 'aes-gcm'): ReadyStatus => ({
  status: 'ready',
  context: {
    kind: 's3',
    credentials: s3Credentials(endpoint),
    meta: vaultMeta(encryption),
    masterKey: encryption === 'aes-gcm' ? new Uint8Array(32) : null,
    deviceId: 'device-1',
  },
});

const webdavBinding = (overrides?: Partial<WebdavBinding>): WebdavBinding => ({
  kind: 'webdav',
  baseUrl: 'https://dav.example.com:5006/dav',
  username: 'me',
  password: 'webdav-password-value',
  rootPath: '/',
  ...overrides,
});

const driveBinding = (kind: 'gdrive' | 'onedrive', email: string): ByosBinding => ({
  kind,
  refreshToken: `refresh-token-${kind}`,
  accountEmail: email,
  rootFolderId: 'root-folder',
  stateFolderId: 'state-folder',
  blobsFolderId: 'blobs-folder',
});

const lock = (status: object): ByosStatus => ({ status: 'locked', ...status } as ByosStatus);
const lockedPassword = lock({ reason: 'password_required' });
const lockedReauth = (provider: ByosSignInProvider) =>
  lock({ reason: 'vault_unreachable', detail: 'reauth_required', provider });
const lockedUnreachable = (
  detail: 'network' | 'credential_rejected' | 'not_s3' | 'not_webdav' | 'not_onedrive' | 'not_gdrive',
) => lock({ reason: 'vault_unreachable', detail });
const lockedCorrupt = (detail: 'meta_absent' | 'malformed' | 'unsupported-version') =>
  lock({ reason: 'meta_corrupt', detail });

const UNCONFIGURED: ByosStatus = { status: 'unconfigured' };

/** Where the translation-function contract is pinned: literal full keys in, labels out. */
const t = (key: string): string => {
  switch (key) {
    case 'settings.byos.locations.s3': return 'S3 兼容存储';
    case 'settings.byos.locations.webdav': return 'WebDAV';
    case 'settings.byos.locations.onedrive': return 'OneDrive';
    case 'settings.byos.locations.gdrive': return 'Google Drive';
    default: throw new Error(`unexpected key ${key}`);
  }
};

function modelInput(overrides?: Partial<Parameters<typeof deriveCloudLibraryModel>[0]>) {
  return {
    byosStatus: readyS3(),
    identity: read<CloudIdentity | null>(IDENTITY),
    counts: read(COUNTS),
    mode: read<LibraryStorageMode>('both', { roundId: null }),
    lastSyncedAt: read<number | null>(1_000),
    quotaFullCount: read(0),
    readRoundId: ROUND,
    ...overrides,
  };
}

const KEY = (suffix: string) => `settings.cloudLibrary.lockMessage.${suffix}`;

describe('deriveCloudLockMessageKey (status → one of the six sentences)', () => {
  it('gives unconfigured and ready no lock message', () => {
    expect(deriveCloudLockMessageKey(UNCONFIGURED)).toBeNull();
    expect(deriveCloudLockMessageKey(readyS3())).toBeNull();
  });

  it('maps every locked reason/detail to exactly one status message', () => {
    expect(deriveCloudLockMessageKey(lockedPassword)).toBe(KEY('unlock'));
    expect(deriveCloudLockMessageKey(lockedReauth('gdrive'))).toBe(KEY('reauth'));
    expect(deriveCloudLockMessageKey(lockedReauth('onedrive'))).toBe(KEY('reauth'));
    expect(deriveCloudLockMessageKey(lockedUnreachable('network'))).toBe(KEY('network'));
    expect(deriveCloudLockMessageKey(lockedUnreachable('credential_rejected')))
      .toBe(KEY('credentialRejected'));
    expect(deriveCloudLockMessageKey(lockedUnreachable('not_s3'))).toBe(KEY('other'));
    expect(deriveCloudLockMessageKey(lockedUnreachable('not_webdav'))).toBe(KEY('other'));
    expect(deriveCloudLockMessageKey(lockedUnreachable('not_onedrive'))).toBe(KEY('other'));
    expect(deriveCloudLockMessageKey(lockedUnreachable('not_gdrive'))).toBe(KEY('other'));
    expect(deriveCloudLockMessageKey(lockedCorrupt('meta_absent'))).toBe(KEY('unreadable'));
    expect(deriveCloudLockMessageKey(lockedCorrupt('malformed'))).toBe(KEY('unreadable'));
    expect(deriveCloudLockMessageKey(lockedCorrupt('unsupported-version'))).toBe(KEY('unreadable'));
  });

  it('never concatenates a raw reason/detail into the key', () => {
    const message = deriveCloudLockMessageKey(lockedUnreachable('credential_rejected'))!;
    expect(message).toBe(KEY('credentialRejected'));
    expect(message.startsWith(KEY('') + 'vault_unreachable')).toBe(false);
  });
});

describe('deriveCloudActionMessageKey (configured unlock/reauth failure → one of four + four reused)', () => {
  const action = (failure: ByosConnectFailure) => deriveCloudActionMessageKey(failure);

  it('maps password failures, splitting password_mismatch on its required tag', () => {
    expect(action({ category: 'wrong_password' })).toBe(KEY('wrongPassword'));
    expect(action({ category: 'password_mismatch', detail: 'password_required' }))
      .toBe(KEY('passwordRequired'));
    expect(action({ category: 'password_mismatch' })).toBe(KEY('wrongPassword'));
    expect(action({ category: 'password_mismatch', detail: 'anything-else' }))
      .toBe(KEY('wrongPassword'));
  });

  it('maps cancelled sign-in and network failures to the action-specific keys', () => {
    expect(action({ category: 'sign_in_cancelled' })).toBe(KEY('signInCancelled'));
    expect(action({ category: 'network' })).toBe(KEY('networkAction'));
  });

  it('reuses the four status sentences for the remaining categories', () => {
    expect(action({ category: 'reauth_required' })).toBe(KEY('reauth'));
    expect(action({ category: 'credential_rejected' })).toBe(KEY('credentialRejected'));
    expect(action({ category: 'meta_corrupt' })).toBe(KEY('unreadable'));
    expect(action({ category: 'meta_corrupt', detail: 'meta_absent' })).toBe(KEY('unreadable'));
    expect(action({ category: 'not_s3' })).toBe(KEY('other'));
    expect(action({ category: 'not_webdav' })).toBe(KEY('other'));
    expect(action({ category: 'not_onedrive' })).toBe(KEY('other'));
    expect(action({ category: 'not_gdrive' })).toBe(KEY('other'));
    expect(action({ category: 'insecure_url' })).toBe(KEY('other'));
  });

  it('never hands an action failure a status-only automatic-recovery sentence', () => {
    // A network action failure (unlock or either drive's reauth) is transient
    // with a manual next step (A5): it must not read as the `network` status,
    // whose copy promises automatic reconnection.
    expect(action({ category: 'network' })).not.toBe(KEY('network'));
    // Neither wrong password nor a wrong backend promises reconnection.
    expect(action({ category: 'wrong_password' })).not.toBe(KEY('network'));
    expect(action({ category: 'not_s3' })).not.toBe(KEY('network'));
  });
});

describe('deriveCloudIdentity', () => {
  it('names R2 and Wasabi endpoints, matching the whole domain boundary', () => {
    expect(deriveCloudIdentity(s3Credentials('https://r2.cloudflarestorage.com'), t))
      .toEqual({ kind: 's3', label: 'Cloudflare R2', identity: 'my-bucket' });
    expect(deriveCloudIdentity(s3Credentials('https://abc123.r2.cloudflarestorage.com'), t).label)
      .toBe('Cloudflare R2');
    expect(deriveCloudIdentity(s3Credentials('https://ABC123.R2.CloudflareStorage.COM'), t).label)
      .toBe('Cloudflare R2');
    expect(deriveCloudIdentity(s3Credentials('https://abc.r2.cloudflarestorage.com:8443'), t).label)
      .toBe('Cloudflare R2');
    expect(deriveCloudIdentity(s3Credentials('https://wasabisys.com'), t).label)
      .toBe('Wasabi');
    expect(deriveCloudIdentity(s3Credentials('https://s3.eu-central-1.wasabisys.com'), t).label)
      .toBe('Wasabi');
    expect(deriveCloudIdentity(s3Credentials('https://sg-s3.storage.bunnycdn.com'), t).label)
      .toBe('Bunny.net');
    expect(deriveCloudIdentity(s3Credentials('https://s3.us-west-004.backblazeb2.com'), t).label)
      .toBe('Backblaze B2');
  });

  it('does not brand lookalikes or attacker suffixes', () => {
    expect(deriveCloudIdentity(s3Credentials('https://evilwasabisys.com'), t).label)
      .toBe('evilwasabisys.com');
    expect(deriveCloudIdentity(s3Credentials('https://r2.cloudflarestorage.com.evil'), t).label)
      .toBe('r2.cloudflarestorage.com.evil');
  });

  it('shows a generic endpoint as its host (port included) and the bucket as the identity', () => {
    expect(deriveCloudIdentity(s3Credentials('https://s3.example.com:9000'), t))
      .toEqual({ kind: 's3', label: 's3.example.com:9000', identity: 'my-bucket' });
  });

  it('strips URL userinfo from parsed endpoints and never emits credentials', () => {
    const identity = deriveCloudIdentity(
      s3Credentials('https://user:secret@abc123.r2.cloudflarestorage.com'),
      t,
    );
    expect(identity.label).toBe('Cloudflare R2');
    expect(JSON.stringify(identity)).not.toContain('user:secret');
    expect(JSON.stringify(identity)).not.toContain('shhh-secret-value');
    expect(JSON.stringify(identity)).not.toContain('AKIA-test-key');
  });

  it('degrades an invalid endpoint without crashing and never shows a credential-shaped address', () => {
    const plain = deriveCloudIdentity(s3Credentials('not-a-url'), t);
    expect(plain.label).toBe('not-a-url');
    expect(plain.identity).toBe('my-bucket');
    const credentialed = deriveCloudIdentity(s3Credentials('user:secret@bad'), t);
    expect(credentialed.label).toBe('S3 兼容存储');
    expect(JSON.stringify(credentialed)).not.toContain('user:secret');
    expect(credentialed.identity).toBe('my-bucket');
  });

  it('never leaks query, fragment or whitespace-bearing raw addresses either', () => {
    const invalid = 'https://nas.example:bad/?password=review-secret';
    const s3 = deriveCloudIdentity(s3Credentials(invalid), t);
    expect(s3.label).toBe('S3 兼容存储');
    expect(JSON.stringify(s3)).not.toContain('review-secret');
    expect(deriveCloudIdentity(s3Credentials('https://bad url'), t).label).toBe('S3 兼容存储');
    expect(deriveCloudIdentity(s3Credentials('bad#frag-secret'), t).label).toBe('S3 兼容存储');
  });

  it('labels WebDAV as WebDAV with host · username, tolerating an empty username', () => {
    expect(deriveCloudIdentity(webdavBinding(), t))
      .toEqual({ kind: 'webdav', label: 'WebDAV', identity: 'dav.example.com:5006 · me' });
    expect(deriveCloudIdentity(webdavBinding({ username: '' }), t).identity)
      .toBe('dav.example.com:5006');
    const leaky = deriveCloudIdentity(webdavBinding(), t);
    expect(JSON.stringify(leaky)).not.toContain('webdav-password-value');
  });

  it('keeps credential-shaped invalid WebDAV addresses out of the identity', () => {
    const invalid = 'https://nas.example:bad/?password=review-secret';
    const withUser = deriveCloudIdentity(webdavBinding({ baseUrl: invalid }), t);
    expect(withUser.identity).toBe('me');
    expect(JSON.stringify(withUser)).not.toContain('review-secret');
    expect(deriveCloudIdentity(webdavBinding({ baseUrl: invalid, username: '' }), t).identity)
      .toBe('');
    // A raw address with no credential shape still degrades to itself.
    expect(deriveCloudIdentity(webdavBinding({ baseUrl: 'nas.example:5006' }), t).identity)
      .toBe('nas.example:5006 · me');
  });

  it('labels the drives by their locale names with the account email as identity', () => {
    expect(deriveCloudIdentity(driveBinding('gdrive', 'me@gmail.com'), t))
      .toEqual({ kind: 'gdrive', label: 'Google Drive', identity: 'me@gmail.com' });
    expect(deriveCloudIdentity(driveBinding('onedrive', 'me@outlook.com'), t))
      .toEqual({ kind: 'onedrive', label: 'OneDrive', identity: 'me@outlook.com' });
    expect(JSON.stringify(deriveCloudIdentity(driveBinding('gdrive', 'me@gmail.com'), t)))
      .not.toContain('refresh-token-gdrive');
  });

  it('projects the same identity while ready and while locked', () => {
    const binding = s3Credentials('https://abc123.r2.cloudflarestorage.com');
    const derived = deriveCloudIdentity(binding, t);
    const ready = deriveCloudLibraryModel(modelInput({
      byosStatus: readyS3(),
      identity: read<CloudIdentity | null>(derived),
    }));
    const locked = deriveCloudLibraryModel(modelInput({
      byosStatus: lockedPassword,
      identity: read<CloudIdentity | null>(derived),
    }));
    expect(ready.identity).toEqual(locked.identity);
    expect(locked.identity).toEqual(derived);
  });
});

describe('deriveCloudLibraryModel — states', () => {
  it('renders unconfigured as bare, ignoring every read', () => {
    const model = deriveCloudLibraryModel(modelInput({ byosStatus: UNCONFIGURED }));
    expect(model).toEqual({
      state: 'unconfigured',
      identity: null,
      tone: null,
      messageKey: null,
      reauthProvider: null,
      stats: null,
      footer: null,
      storageMode: null,
      encryption: null,
    });
  });

  it('shows configured loading while the first identity/count read is pending', () => {
    const identityPending = deriveCloudLibraryModel(modelInput({ identity: pendingRead() }));
    expect(identityPending.state).toBe('loading');
    expect(identityPending.tone).toBeNull();
    expect(identityPending.footer).toBeNull();
    expect(identityPending.stats).toBeNull();

    const countsPending = deriveCloudLibraryModel(modelInput({ counts: pendingRead() }));
    expect(countsPending.state).toBe('loading');
  });

  it('a settled identity with an absent/rejected first counts read is ready with dashes, not loading and not zeros', () => {
    const absent = deriveCloudLibraryModel(modelInput({ counts: unread() }));
    expect(absent.state).toBe('ready');
    expect(absent.stats).toBeNull();

    const rejected = deriveCloudLibraryModel(modelInput({ counts: errored() }));
    expect(rejected.state).toBe('ready');
    expect(rejected.stats).toBeNull();

    const identityFailed = deriveCloudLibraryModel(modelInput({ identity: errored() }));
    expect(identityFailed.state).toBe('ready');
    expect(identityFailed.identity).toBeNull();
  });

  it('a measured zero library renders zero stats, distinct from unread', () => {
    const empty: LibraryMirrorCounts = {
      backedUp: 0, backedUpTotal: 0, downloaded: 0, downloadedTotal: 0,
      inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 0,
    };
    const measured = deriveCloudLibraryModel(modelInput({ counts: read(empty) }));
    expect(measured.state).toBe('ready');
    expect(measured.stats).toEqual({ inCloud: 0, totalBytes: 0, pending: 0 });
    expect(deriveCloudLibraryModel(modelInput({ counts: unread() })).stats).toBeNull();
  });

  it('ready aes-gcm exposes the card stats from downloadedTotal and the stored encryption', () => {
    const model = deriveCloudLibraryModel(modelInput());
    expect(model.state).toBe('ready');
    expect(model.tone).toBe('ok');
    expect(model.messageKey).toBeNull();
    expect(model.reauthProvider).toBeNull();
    expect(model.stats).toEqual({ inCloud: 5, totalBytes: 1234, pending: 7 });
    expect(model.encryption).toBe('aes-gcm');
    expect(model.storageMode).toBe('both');
    expect(model.identity).toEqual(IDENTITY);
  });

  it('ready with encryption none reports none', () => {
    expect(deriveCloudLibraryModel(modelInput({ byosStatus: readyS3(undefined, 'none') })).encryption)
      .toBe('none');
  });

  it('stale counts still supply displayed stats but cannot claim a footer', () => {
    const model = deriveCloudLibraryModel(modelInput({ counts: read(COUNTS, { fresh: false }) }));
    expect(model.state).toBe('ready');
    expect(model.stats).toEqual({ inCloud: 5, totalBytes: 1234, pending: 7 });
    expect(model.footer).toBeNull();
  });

  it('unread mode hides the mode value without touching stats', () => {
    const model = deriveCloudLibraryModel(modelInput({ mode: unread() }));
    expect(model.state).toBe('ready');
    expect(model.storageMode).toBeNull();
    expect(model.stats).toEqual({ inCloud: 5, totalBytes: 1234, pending: 7 });
  });

  it('stale mode is not a readable mode', () => {
    const model = deriveCloudLibraryModel(modelInput({
      mode: read<LibraryStorageMode>('both', { fresh: false, roundId: null }),
    }));
    expect(model.storageMode).toBeNull();
  });

  it('keeps a password lock exactly a password lock, with no stats/mode/encryption guesses', () => {
    const model = deriveCloudLibraryModel(modelInput({ byosStatus: lockedPassword }));
    expect(model).toEqual({
      state: 'password-required',
      identity: IDENTITY,
      tone: 'warn',
      messageKey: KEY('unlock'),
      reauthProvider: null,
      stats: null,
      footer: null,
      storageMode: null,
      encryption: null,
    });
  });

  it('an identity read pending on a lock must not suppress its pill/message or fake unconfigured/loading', () => {
    const model = deriveCloudLibraryModel(modelInput({
      byosStatus: lockedPassword,
      identity: pendingRead(),
    }));
    expect(model.state).toBe('password-required');
    expect(model.messageKey).toBe(KEY('unlock'));
    expect(model.tone).toBe('warn');
  });

  it('maps both reauth providers, carrying the named provider', () => {
    const gdrive = deriveCloudLibraryModel(modelInput({
      byosStatus: lockedReauth('gdrive'),
      identity: pendingRead(),
    }));
    expect(gdrive.state).toBe('reauth-required');
    expect(gdrive.tone).toBe('warn');
    expect(gdrive.messageKey).toBe(KEY('reauth'));
    expect(gdrive.reauthProvider).toBe('gdrive');

    const onedrive = deriveCloudLibraryModel(modelInput({
      byosStatus: lockedReauth('onedrive'),
      identity: unread(),
    }));
    expect(onedrive.reauthProvider).toBe('onedrive');
    expect(onedrive.state).toBe('reauth-required');
  });

  it.each([
    ['network', 'unreachable', KEY('network')],
    ['credential_rejected', 'unreachable', KEY('credentialRejected')],
    ['not_s3', 'unreachable', KEY('other')],
    ['not_gdrive', 'unreachable', KEY('other')],
  ] as const)('vault_unreachable/%s renders %s with the warn pill', (detail, state, message) => {
    const model = deriveCloudLibraryModel(modelInput({
      byosStatus: lockedUnreachable(detail),
      identity: pendingRead(),
    }));
    expect(model.state).toBe(state);
    expect(model.tone).toBe('warn');
    expect(model.messageKey).toBe(message);
    expect(model.stats).toBeNull();
  });

  it.each(['meta_absent', 'malformed', 'unsupported-version'] as const)(
    'meta_corrupt/%s is the one bad-toned unreadable state',
    (detail) => {
      const model = deriveCloudLibraryModel(modelInput({
        byosStatus: lockedCorrupt(detail),
        identity: pendingRead(),
      }));
      expect(model.state).toBe('unreadable');
      expect(model.tone).toBe('bad');
      expect(model.messageKey).toBe(KEY('unreadable'));
    },
  );
});

describe('deriveCloudFooter — first fresh claim wins', () => {
  function footerInput(overrides?: {
    counts?: ReadValue<LibraryMirrorCounts>;
    mode?: ReadValue<LibraryStorageMode>;
    lastSyncedAt?: ReadValue<number | null>;
    quotaFullCount?: ReadValue<number>;
    readRoundId?: number;
  }) {
    const input = modelInput({
      counts: overrides?.counts ?? read(COUNTS),
      mode: overrides?.mode ?? read<LibraryStorageMode>('both', { roundId: null }),
      lastSyncedAt: overrides?.lastSyncedAt ?? read<number | null>(1_000),
      quotaFullCount: overrides?.quotaFullCount ?? read(0),
      readRoundId: overrides?.readRoundId ?? ROUND,
    });
    return input;
  }

  const drained: LibraryMirrorCounts = {
    backedUp: 8, backedUpTotal: 8, downloaded: 5, downloadedTotal: 5,
    inCloud: 0, inCloudBytes: 0, pending: 0, totalBytes: 1234,
  };

  it('quota-full beats pending and downloading', () => {
    const footer = deriveCloudFooter(footerInput({ quotaFullCount: read(2) }));
    expect(footer).toEqual({ kind: 'quota-full', count: 2 });
  });

  it('fresh quota-full > 0 alone can claim quota-full, even over stale counts', () => {
    const footer = deriveCloudFooter(footerInput({
      quotaFullCount: read(3),
      counts: read(COUNTS, { fresh: false }),
    }));
    expect(footer).toEqual({ kind: 'quota-full', count: 3 });
  });

  it('pending beats downloading', () => {
    const footer = deriveCloudFooter(footerInput({ counts: read(COUNTS) }));
    expect(footer).toEqual({ kind: 'pending', count: 7 });
  });

  it('downloading counts missing originals in both mode', () => {
    const almostDone: LibraryMirrorCounts = { ...drained, downloaded: 3, inCloud: 2 };
    const footer = deriveCloudFooter(footerInput({ counts: read(almostDone) }));
    expect(footer).toEqual({ kind: 'downloading', count: 2 });
  });

  it('cloud-only never claims downloading; completion falls through to the sync age', () => {
    const cloudOnly: LibraryMirrorCounts = { ...drained, downloaded: 0 };
    const footer = deriveCloudFooter(footerInput({
      counts: read(cloudOnly),
      mode: read<LibraryStorageMode>('cloud-only', { roundId: null }),
    }));
    expect(footer).toEqual({ kind: 'synced', at: 1_000 });
  });

  it('a fresh timestamp claims synced and a fresh null claims never-synced', () => {
    expect(deriveCloudFooter(footerInput({ counts: read(drained), lastSyncedAt: read<number | null>(4_000) })))
      .toEqual({ kind: 'synced', at: 4_000 });
    expect(deriveCloudFooter(footerInput({ counts: read(drained), lastSyncedAt: read<number | null>(null) })))
      .toEqual({ kind: 'never-synced' });
  });

  it('a stale quota-full read suppresses the whole footer, not just its own claim', () => {
    expect(deriveCloudFooter(footerInput({ quotaFullCount: read(0, { fresh: false }) }))).toBeNull();
  });

  it('a stale positive quota-full count cannot claim drive-full', () => {
    expect(deriveCloudFooter(footerInput({ quotaFullCount: read(3, { fresh: false }) })))
      .toBeNull();
  });

  it('a quota-full read from another round is stale', () => {
    expect(deriveCloudFooter(footerInput({
      quotaFullCount: read(0, { roundId: ROUND + 1 }),
    }))).toBeNull();
  });

  it.each([
    ['counts', (input: Parameters<typeof deriveCloudFooter>[0]) => deriveCloudFooter({
      ...input,
      counts: read(COUNTS, { fresh: false }),
    })],
    ['counts round', (input: Parameters<typeof deriveCloudFooter>[0]) => deriveCloudFooter({
      ...input,
      counts: read(COUNTS, { roundId: ROUND + 1 }),
    })],
  ])('no pending/download claim may use a stale %s', (_name, run) => {
    expect(run(footerInput())).toBeNull();
  });

  it('downloading also needs a fresh mode; stale mode suppresses synced too', () => {
    const staleMode = read<LibraryStorageMode>('both', { fresh: false, roundId: null });
    expect(deriveCloudFooter(footerInput({ counts: read(drained), mode: staleMode }))).toBeNull();
  });

  it('stale mode suppresses the downloading claim itself while downloads remain', () => {
    const almostDone: LibraryMirrorCounts = { ...drained, downloaded: 3, inCloud: 2 };
    const staleMode = read<LibraryStorageMode>('both', { fresh: false, roundId: null });
    expect(deriveCloudFooter(footerInput({ counts: read(almostDone), mode: staleMode })))
      .toBeNull();
  });

  it('completion/never needs a fresh watermark', () => {
    expect(deriveCloudFooter(footerInput({
      counts: read(drained),
      lastSyncedAt: read<number | null>(1_000, { fresh: false }),
    }))).toBeNull();
    expect(deriveCloudFooter(footerInput({
      counts: read(drained),
      lastSyncedAt: read<number | null>(1_000, { roundId: ROUND + 1 }),
    }))).toBeNull();
  });

  it('unread inputs measure nothing', () => {
    expect(deriveCloudFooter(footerInput({ counts: unread() }))).toBeNull();
    expect(deriveCloudFooter(footerInput({ quotaFullCount: unread<number>() }))).toBeNull();
    expect(deriveCloudFooter(footerInput({ counts: read(drained), lastSyncedAt: unread() }))).toBeNull();
  });

  it('the model publishes the footer only while ready', () => {
    const locked = deriveCloudLibraryModel(modelInput({
      byosStatus: lockedUnreachable('network'),
      quotaFullCount: read(4),
    }));
    expect(locked.footer).toBeNull();

    const ready = deriveCloudLibraryModel(modelInput({ quotaFullCount: read(4) }));
    const expected: CloudFooter | null = ready.footer;
    expect(expected).toEqual({ kind: 'quota-full', count: 4 });
  });
});
