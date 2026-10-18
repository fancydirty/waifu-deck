import { createFakeDrive } from '@/test/fake-drive-server';

import { createGoogleDriveCloudObjectStore } from './gdrive-cloud-object-store';
import { createGoogleTokenSource } from './google-token-source';
import { describeCloudObjectStoreContract } from './cloud-object-store-contract-test-support';

describeCloudObjectStoreContract('Google Drive (fake)', async (run) => {
  const drive = createFakeDrive();
  const tokens = createGoogleTokenSource({
    seed: { accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 },
    refresh: async () => ({ accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 }),
  });
  const store = createGoogleDriveCloudObjectStore(drive.ids, { tokens, fetchImpl: drive.fetch, uploadFile: drive.uploadFile, downloadFile: drive.downloadFile, statFile: async () => null });
  return { store, dispose: async () => { void run; } };
}, { samePathBehavior: 'append' });
