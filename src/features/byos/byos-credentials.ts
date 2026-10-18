import * as SecureStore from 'expo-secure-store';

import type { S3Credentials } from './s3-transport-types';

/** The S3 binding as every module before board #12 knew it (plus `kind`). */
export type ByosCredentials = S3Credentials & { readonly prefix: string; readonly kind: 's3' };

export type WebdavBinding = Readonly<{
  kind: 'webdav';
  /** `https://host/path` — the WebDAV base the "Waifu Deck" folder lives under. */
  baseUrl: string;
  username: string;
  password: string;
  /** Folder under `baseUrl`, default `/`. */
  rootPath: string;
}>;

export type DriveFolderBinding = Readonly<{
  refreshToken: string;
  accountEmail: string;
  rootFolderId: string;
  stateFolderId: string;
  blobsFolderId: string;
}>;

export type OneDriveBinding = DriveFolderBinding & Readonly<{ kind: 'onedrive' }>;
export type GoogleDriveBinding = DriveFolderBinding & Readonly<{ kind: 'gdrive' }>;

/**
 * Board #12 (spec §5): one library binds ONE storage location. The stored
 * JSON is discriminated by `kind`; a JSON with no `kind` is an S3 binding
 * written before #12 and is read as one without being rewritten (zero
 * migration risk for the already-accepted S3 path).
 */
export type ByosBinding = ByosCredentials | WebdavBinding | OneDriveBinding | GoogleDriveBinding;

export type SecureStorePort = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

// expo-secure-store keys must match /^[\w.-]+$/ (no slashes) — see
// node_modules/expo-secure-store/build/SecureStore.js:145-151.
export const BYOS_CREDENTIALS_KEY = 'waifu-deck.byos.credentials.v1';

const defaultPort: SecureStorePort = {
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (k, v) => SecureStore.setItemAsync(k, v),
  deleteItemAsync: SecureStore.deleteItemAsync,
};

export type ByosCredentialStore = {
  /** The S3-shaped view; `null` when nothing is stored OR the binding is not S3. */
  load(): Promise<ByosCredentials | null>;
  save(credentials: Omit<ByosCredentials, 'kind'> | ByosCredentials): Promise<void>;
  clear(): Promise<void>;
  loadBinding(): Promise<ByosBinding | null>;
  saveBinding(binding: ByosBinding): Promise<void>;
};

const isString = (v: unknown): v is string => typeof v === 'string';

function isS3(v: Record<string, unknown>): v is Omit<ByosCredentials, 'kind'> {
  return isString(v.endpoint) && isString(v.region) && isString(v.bucket) && isString(v.accessKeyId)
    && isString(v.secretAccessKey) && isString(v.prefix);
}
function isWebdav(v: Record<string, unknown>): v is Omit<WebdavBinding, 'kind'> {
  return isString(v.baseUrl) && isString(v.username) && isString(v.password) && isString(v.rootPath);
}
function isDriveFolder(v: Record<string, unknown>): v is DriveFolderBinding {
  return isString(v.refreshToken) && isString(v.accountEmail) && isString(v.rootFolderId)
    && isString(v.stateFolderId) && isString(v.blobsFolderId);
}

export function parseBinding(raw: unknown): ByosBinding | null {
  if (raw === null || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const kind = v.kind === undefined ? 's3' : v.kind;
  switch (kind) {
    // Pick the six known fields explicitly: the type guard narrows `v`, so an
    // unknown key in the stored JSON never leaks into a `ByosBinding`.
    case 's3': return isS3(v) ? {
      kind: 's3',
      endpoint: v.endpoint,
      region: v.region,
      bucket: v.bucket,
      accessKeyId: v.accessKeyId,
      secretAccessKey: v.secretAccessKey,
      prefix: v.prefix,
    } : null;
    case 'webdav': return isWebdav(v) ? { ...v, kind: 'webdav' as const } : null;
    case 'onedrive': return isDriveFolder(v) ? { ...v, kind: 'onedrive' as const } : null;
    case 'gdrive': return isDriveFolder(v) ? { ...v, kind: 'gdrive' as const } : null;
    default: return null;
  }
}

export function createByosCredentialStore(
  port: SecureStorePort = defaultPort,
): ByosCredentialStore {
  async function loadBinding(): Promise<ByosBinding | null> {
    const stored = await port.getItemAsync(BYOS_CREDENTIALS_KEY);
    if (stored === null) return null;
    try {
      return parseBinding(JSON.parse(stored));
    } catch {
      return null;
    }
  }
  return {
    loadBinding,
    async saveBinding(binding) {
      await port.setItemAsync(BYOS_CREDENTIALS_KEY, JSON.stringify(binding));
    },
    async load() {
      const binding = await loadBinding();
      return binding !== null && binding.kind === 's3' ? binding : null;
    },
    async save(credentials) {
      await port.setItemAsync(BYOS_CREDENTIALS_KEY, JSON.stringify({ ...credentials, kind: 's3' }));
    },
    async clear() {
      await port.deleteItemAsync(BYOS_CREDENTIALS_KEY);
    },
  };
}
