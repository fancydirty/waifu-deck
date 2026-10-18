import type { WebdavBinding } from '@/features/byos/byos-credentials';
import { cloudFetch } from '@/features/byos/cloud-fetch';
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';

import { WaifuSyncService } from '../../../modules/waifu-sync-service';

import type { CloudObjectStore } from './cloud-object-store';
import { createWebdavCloudObjectStore } from './webdav-cloud-object-store';

/**
 * The device wiring for the WebDAV adapter: `expo/fetch` (React Native's
 * global fetch mangles binary bodies; this is the supported native client —
 * the same injection the S3 composition uses) and the K6-1g native uploader
 * where the module is linked, `expo-file-system`'s task elsewhere. Kept out of
 * the adapter so unit tests and the Node integration gate inject plain fetch.
 */
export function createProductionWebdavStore(binding: WebdavBinding): CloudObjectStore {
  const downloadFile = selectDownloadFilePort(WaifuSyncService);
  return createWebdavCloudObjectStore(binding, {
    fetchImpl: cloudFetch,
    uploadFile: selectUploadFilePort(WaifuSyncService),
    ...(downloadFile === null ? {} : { downloadFile }),
  });
}
