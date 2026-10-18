import type { ByosCredentialStore, GoogleDriveBinding, OneDriveBinding, WebdavBinding } from '@/features/byos/byos-credentials';

const mockNativeUploader = jest.fn();
const mockNativeDownloader = jest.fn();
jest.mock('@/features/byos/s3-file-transfer', () => ({
  selectUploadFilePort: jest.fn(() => mockNativeUploader),
}));
jest.mock('@/features/byos/s3-file-download', () => ({
  selectDownloadFilePort: jest.fn(() => mockNativeDownloader),
}));
jest.mock('../../../modules/waifu-sync-service', () => ({ WaifuSyncService: { tag: 'native-sync-service' } }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system', () => ({
  File: jest.fn(() => ({ exists: false, size: 0, readableStream: () => new ReadableStream() })),
}));

// The adapter modules are intentionally real in this file. Only native edges
// and the factory's token/file plumbing are mocked, so these assertions inspect
// the returned adapter object rather than a constructor's dependency bag.
// eslint-disable-next-line import/first
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
// eslint-disable-next-line import/first
import { createProductionGoogleDriveStore } from './gdrive-store-production';
// eslint-disable-next-line import/first
import { createProductionOneDriveStore } from './onedrive-store-production';
// eslint-disable-next-line import/first
import { createProductionWebdavStore } from './webdav-store-production';

const webdavBinding: WebdavBinding = {
  kind: 'webdav', baseUrl: 'https://dav.example', username: 'u', password: 'p', rootPath: '/',
};
const oneDriveBinding: OneDriveBinding = {
  kind: 'onedrive', refreshToken: 'refresh', accountEmail: 'owner@example.com',
  rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs',
};
const googleDriveBinding: GoogleDriveBinding = {
  kind: 'gdrive', refreshToken: 'refresh', accountEmail: 'owner@example.com',
  rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs',
};
const credentialStore: ByosCredentialStore = {
  load: async () => null,
  save: async () => {},
  clear: async () => {},
  loadBinding: async () => null,
  saveBinding: async () => {},
};

function createOneDriveStore() {
  return createProductionOneDriveStore(oneDriveBinding, {
    accessToken: 'seed',
    expiresAt: Date.now() + 120_000,
    credentialStore,
  });
}

describe('production stores expose the real adapter getToFile contract', () => {
  beforeEach(() => {
    (selectDownloadFilePort as jest.Mock).mockReturnValue(mockNativeDownloader);
  });

  test.each([
    ['WebDAV', () => createProductionWebdavStore(webdavBinding)],
    ['OneDrive', createOneDriveStore],
    ['Google Drive', () => createProductionGoogleDriveStore(googleDriveBinding, { accessToken: 'seed', expiresAt: Date.now() + 120_000 })],
  ])('%s includes getToFile when the native downloader is present', (_label, createStore) => {
    const store = createStore();
    expect(typeof store.getToFile).toBe('function');
  });

  test.each([
    ['WebDAV', () => createProductionWebdavStore(webdavBinding)],
    ['OneDrive', createOneDriveStore],
    ['Google Drive', () => createProductionGoogleDriveStore(googleDriveBinding, { accessToken: 'seed', expiresAt: Date.now() + 120_000 })],
  ])('%s omits getToFile when the native downloader is absent', (_label, createStore) => {
    (selectDownloadFilePort as jest.Mock).mockReturnValueOnce(null);
    const store = createStore();
    expect('getToFile' in store).toBe(false);
  });
});
