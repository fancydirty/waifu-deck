import type { OneDriveBinding } from '@/features/byos/byos-credentials';

const mockNativeUploader = jest.fn();
const mockNativeDownloader = jest.fn();
jest.mock('./onedrive-cloud-object-store', () => ({
  createOneDriveCloudObjectStore: jest.fn(() => ({ kind: 'onedrive' })),
}));
jest.mock('./microsoft-token-source', () => ({
  createMicrosoftTokenSource: jest.fn((deps) => deps),
}));
jest.mock('./microsoft-oauth', () => ({ refreshTokens: jest.fn() }));
jest.mock('@/features/byos/s3-file-transfer', () => ({
  selectUploadFilePort: jest.fn(() => mockNativeUploader),
}));
jest.mock('@/features/byos/s3-file-download', () => ({
  selectDownloadFilePort: jest.fn(() => mockNativeDownloader),
}));
jest.mock('../../../modules/waifu-sync-service', () => ({ WaifuSyncService: { tag: 'native-sync-service' } }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system', () => ({
  File: jest.fn((uri: string) => (uri === 'file:///staged.bin' ? { exists: true, size: 4096 } : { exists: false, size: 0 })),
}));

// eslint-disable-next-line import/first
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
// eslint-disable-next-line import/first
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';
// eslint-disable-next-line import/first
import { WaifuSyncService } from '../../../modules/waifu-sync-service';
// eslint-disable-next-line import/first
import { createOneDriveCloudObjectStore } from './onedrive-cloud-object-store';
// eslint-disable-next-line import/first
import { createProductionOneDriveStore } from './onedrive-store-production';

describe('createProductionOneDriveStore download wiring', () => {
  const binding: OneDriveBinding = {
    kind: 'onedrive', refreshToken: 'refresh', accountEmail: 'owner@example.com',
    rootFolderId: 'root', stateFolderId: 'state', blobsFolderId: 'blobs',
  };

  test('passes the native download port when the module is present', () => {
    createProductionOneDriveStore(binding);
    const create = createOneDriveCloudObjectStore as jest.Mock;
    const deps = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(selectUploadFilePort).toHaveBeenCalledWith(WaifuSyncService);
    expect(selectDownloadFilePort).toHaveBeenCalledWith(WaifuSyncService);
    expect(deps.uploadFile).toBe(mockNativeUploader);
    expect(deps.downloadFile).toBe(mockNativeDownloader);
  });

  test('omits the download port when the native module is absent', () => {
    (createOneDriveCloudObjectStore as jest.Mock).mockClear();
    (selectDownloadFilePort as jest.Mock).mockReturnValueOnce(null);
    createProductionOneDriveStore(binding);
    const deps = (createOneDriveCloudObjectStore as jest.Mock).mock.calls[0]![1] as Record<string, unknown>;
    expect(deps).not.toHaveProperty('downloadFile');
  });
});
