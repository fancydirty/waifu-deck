import { describeCloudObjectStoreContract } from './cloud-object-store-contract-test-support';
import { refreshTokens } from './microsoft-oauth';
import { createMicrosoftTokenSource } from './microsoft-token-source';
import { createOneDriveCloudObjectStore } from './onedrive-cloud-object-store';

import { createFakeGraph } from '@/test/fake-graph-server';
import { createNodeFileStat, createNodeFragmentReader } from '@/test/node-file-transfer';

// P12-C Task 7: the same reusable suite the memory store and the WebDAV
// adapter pass, run against the OneDrive adapter over one shared fake Graph.
describeCloudObjectStoreContract('onedrive adapter over an in-memory fake Graph', async () => {
  const graph = createFakeGraph();
  const tokens = createMicrosoftTokenSource({
    seed: { accessToken: null, refreshToken: graph.issueRefreshToken(), expiresAt: 0 },
    refresh: (refreshToken) => refreshTokens(graph.fetch, { refreshToken }),
    onRotated: () => {},
  });
  const store = createOneDriveCloudObjectStore(graph.ids, {
    tokens,
    fetchImpl: graph.fetch,
    uploadFile: graph.uploadFile,
    downloadFile: graph.downloadFile,
    statFile: createNodeFileStat(),
    readFragments: createNodeFragmentReader(),
  });
  return { store, dispose: async () => graph.clearFiles() };
});
