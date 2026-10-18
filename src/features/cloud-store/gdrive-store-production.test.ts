import type { GoogleDriveBinding } from '@/features/byos/byos-credentials';

jest.mock('./gdrive-cloud-object-store', () => ({
  createGoogleDriveCloudObjectStore: jest.fn(() => ({ kind: 'gdrive' })),
}));
jest.mock('./google-token-source', () => ({
  createGoogleTokenSource: jest.fn((deps) => deps),
}));
jest.mock('./google-oauth', () => ({
  refreshGoogleTokens: jest.fn(),
}));
const mockNativeUploader = jest.fn();
const mockNativeDownloader = jest.fn();
jest.mock('@/features/byos/s3-file-transfer', () => ({
  selectUploadFilePort: jest.fn(() => mockNativeUploader),
}));
jest.mock('@/features/byos/s3-file-download', () => ({
  selectDownloadFilePort: jest.fn(() => mockNativeDownloader),
}));
jest.mock('../../../modules/waifu-sync-service', () => ({ WaifuSyncService: { tag: 'native-sync-service' } }));
// The production wrapper's underlying `expo/fetch` is mocked so this wiring test stays native-free.
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system', () => ({
  File: jest.fn((uri: string) => (uri === 'file:///staged.bin' ? { exists: true, size: 4096 } : { exists: false, size: 0 })),
}));

// Imports follow the mocks so the production module observes the test doubles.
// eslint-disable-next-line import/first
import { cloudFetch } from '@/features/byos/cloud-fetch';
// eslint-disable-next-line import/first
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';
// eslint-disable-next-line import/first
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
// eslint-disable-next-line import/first
import { WaifuSyncService } from '../../../modules/waifu-sync-service';
// eslint-disable-next-line import/first
import { createGoogleDriveCloudObjectStore } from './gdrive-cloud-object-store';
// eslint-disable-next-line import/first
import { refreshGoogleTokens } from './google-oauth';
// eslint-disable-next-line import/first
import { createProductionGoogleDriveStore } from './gdrive-store-production';

describe('createProductionGoogleDriveStore', () => {
  test('wires the binding token, native whole-file uploader and downloader, and stat port without rotation or fragments', () => {
    const binding: GoogleDriveBinding = { kind: 'gdrive', refreshToken: 'refresh', accountEmail: 'owner@example.com', rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs' };
    createProductionGoogleDriveStore(binding);
    const create = createGoogleDriveCloudObjectStore as jest.Mock;
    expect(create).toHaveBeenCalledWith({ rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs' }, expect.objectContaining({ tokens: expect.anything(), uploadFile: expect.any(Function), downloadFile: expect.any(Function), statFile: expect.any(Function) }));
    const deps = create.mock.calls[0][1] as Record<string, unknown>;
    expect(deps).not.toHaveProperty('readFragments');
    expect(deps).not.toHaveProperty('onRotated');
    // Production never overrides the stall window: GDRIVE_STALL_TIMEOUT_MS (20 s) applies on the device.
    expect(deps).not.toHaveProperty('stallMs');
    // 补裁 5: blobs go up as one whole-file PUT through the native streaming uploader, over expo/fetch.
    expect(selectUploadFilePort).toHaveBeenCalledWith(WaifuSyncService);
    expect(deps.uploadFile).toBe(mockNativeUploader);
    expect(selectDownloadFilePort).toHaveBeenCalledWith(WaifuSyncService);
    expect(deps.downloadFile).toBe(mockNativeDownloader);
    expect(deps.fetchImpl).toBe(cloudFetch);
    expect(deps.fetchImpl).not.toBe(globalThis.fetch);
  });

  test('omits the downloader when the native module is absent', () => {
    const binding: GoogleDriveBinding = { kind: 'gdrive', refreshToken: 'refresh', accountEmail: 'owner@example.com', rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs' };
    (createGoogleDriveCloudObjectStore as jest.Mock).mockClear();
    (selectDownloadFilePort as jest.Mock).mockReturnValueOnce(null);
    createProductionGoogleDriveStore(binding);
    const deps = (createGoogleDriveCloudObjectStore as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
    expect(deps).not.toHaveProperty('downloadFile');
  });

  test('the token source is seeded from binding.refreshToken and refreshes through refreshGoogleTokens over the same fetch', async () => {
    const binding: GoogleDriveBinding = { kind: 'gdrive', refreshToken: 'refresh-from-binding', accountEmail: 'owner@example.com', rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs' };
    (createGoogleDriveCloudObjectStore as jest.Mock).mockClear();
    createProductionGoogleDriveStore(binding);
    const deps = (createGoogleDriveCloudObjectStore as jest.Mock).mock.calls[0][1] as {
      tokens: { seed: unknown; refresh: (refreshToken: string) => Promise<unknown> };
      fetchImpl: unknown;
      statFile: (fileUri: string) => Promise<number | null>;
    };
    // createGoogleTokenSource is mocked to return its own deps, so `tokens` IS what production passed it.
    expect(deps.tokens.seed).toEqual({ accessToken: null, refreshToken: 'refresh-from-binding', expiresAt: 0 });
    await deps.tokens.refresh('refresh-from-binding');
    expect(refreshGoogleTokens).toHaveBeenCalledWith(deps.fetchImpl, { refreshToken: 'refresh-from-binding' });
    expect(await deps.statFile('file:///staged.bin')).toBe(4096);
    expect(await deps.statFile('file:///missing.bin')).toBeNull();
  });

  test('an optional seed (the sign-in\'s own access token, P12-D Task 10) reaches the token source; without one the seed is empty and the first call refreshes', () => {
    const binding: GoogleDriveBinding = { kind: 'gdrive', refreshToken: 'refresh', accountEmail: 'owner@example.com', rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs' };
    const create = createGoogleDriveCloudObjectStore as jest.Mock;
    create.mockClear();
    createProductionGoogleDriveStore(binding, { accessToken: 'ya29.seed', expiresAt: 1234 });
    createProductionGoogleDriveStore(binding, {});
    const seeds = create.mock.calls.map((call) => (call[1] as { tokens: { seed: unknown } }).tokens.seed);
    expect(seeds).toEqual([
      { accessToken: 'ya29.seed', refreshToken: 'refresh', expiresAt: 1234 },
      { accessToken: null, refreshToken: 'refresh', expiresAt: 0 },
    ]);
  });
});
