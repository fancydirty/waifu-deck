import type { GoogleDriveBinding } from '@/features/byos/byos-credentials';
import { cloudFetch } from '@/features/byos/cloud-fetch';
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';

import { WaifuSyncService } from '../../../modules/waifu-sync-service';

import type { CloudObjectStore } from './cloud-object-store';
import { createGoogleDriveCloudObjectStore } from './gdrive-cloud-object-store';
import { refreshGoogleTokens } from './google-oauth';
import { createGoogleTokenSource } from './google-token-source';

/** Production Drive wiring. Google refresh tokens do not rotate, so there is
 * deliberately no credential-store callback or fragment reader here. `seed` is
 * the sign-in's own access token (connect flow, P12-D Task 10), so probe and
 * connect do not spend a refresh before the binding exists; the resolver
 * passes none and refreshes on first use. */
export function createProductionGoogleDriveStore(
  binding: GoogleDriveBinding,
  seed: Readonly<{ accessToken?: string; expiresAt?: number }> = {},
): CloudObjectStore {
  const fetchImpl = cloudFetch;
  const downloadFile = selectDownloadFilePort(WaifuSyncService);
  const tokens = createGoogleTokenSource({
    seed: { accessToken: seed.accessToken ?? null, refreshToken: binding.refreshToken, expiresAt: seed.expiresAt ?? 0 },
    refresh: (refreshToken) => refreshGoogleTokens(fetchImpl, { refreshToken }),
  });
  return createGoogleDriveCloudObjectStore(
    { rootFolderId: binding.rootFolderId, stateFolderId: binding.stateFolderId, blobsFolderId: binding.blobsFolderId },
    {
      tokens,
      fetchImpl,
      uploadFile: selectUploadFilePort(WaifuSyncService),
      ...(downloadFile === null ? {} : { downloadFile }),
      statFile: async (fileUri) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { File } = require('expo-file-system') as typeof import('expo-file-system');
        const file = new File(fileUri);
        return file.exists ? file.size : null;
      },
    },
  );
}
