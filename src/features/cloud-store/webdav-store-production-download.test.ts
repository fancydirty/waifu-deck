import type { WebdavBinding } from '@/features/byos/byos-credentials';

const mockNativeUploader = jest.fn();
const mockNativeDownloader = jest.fn();
jest.mock('./webdav-cloud-object-store', () => ({
  createWebdavCloudObjectStore: jest.fn(() => ({ kind: 'webdav' })),
}));
jest.mock('@/features/byos/s3-file-transfer', () => ({
  selectUploadFilePort: jest.fn(() => mockNativeUploader),
}));
jest.mock('@/features/byos/s3-file-download', () => ({
  selectDownloadFilePort: jest.fn(() => mockNativeDownloader),
}));
jest.mock('../../../modules/waifu-sync-service', () => ({ WaifuSyncService: { tag: 'native-sync-service' } }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// eslint-disable-next-line import/first
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
// eslint-disable-next-line import/first
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';
// eslint-disable-next-line import/first
import { WaifuSyncService } from '../../../modules/waifu-sync-service';
// eslint-disable-next-line import/first
import { createWebdavCloudObjectStore } from './webdav-cloud-object-store';
// eslint-disable-next-line import/first
import { createProductionWebdavStore } from './webdav-store-production';

describe('createProductionWebdavStore download wiring', () => {
  const binding: WebdavBinding = {
    kind: 'webdav', baseUrl: 'https://dav.example', username: 'u', password: 'p', rootPath: '/',
  };

  test('passes the native download port when the module is present', () => {
    createProductionWebdavStore(binding);
    const deps = (createWebdavCloudObjectStore as jest.Mock).mock.calls[0]![1] as Record<string, unknown>;
    expect(selectUploadFilePort).toHaveBeenCalledWith(WaifuSyncService);
    expect(selectDownloadFilePort).toHaveBeenCalledWith(WaifuSyncService);
    expect(deps.uploadFile).toBe(mockNativeUploader);
    expect(deps.downloadFile).toBe(mockNativeDownloader);
  });

  test('omits the download port when the native module is absent', () => {
    (createWebdavCloudObjectStore as jest.Mock).mockClear();
    (selectDownloadFilePort as jest.Mock).mockReturnValueOnce(null);
    createProductionWebdavStore(binding);
    const deps = (createWebdavCloudObjectStore as jest.Mock).mock.calls[0]![1] as Record<string, unknown>;
    expect(deps).not.toHaveProperty('downloadFile');
  });
});
