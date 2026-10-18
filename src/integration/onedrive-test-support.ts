/**
 * Shared scaffolding for the real-OneDrive suites (P12-C, spec §8): the
 * BYOS_ONEDRIVE_* environment `scripts/run-byos-onedrive-gate.mjs` supplies,
 * one `it-<run>/{state,blobs}` folder set per run under the app folder, and
 * its deletion. The gate pre-refreshes once and hands over a FRESH access
 * token, so the suites (run in-band) never refresh — and never rotate the
 * stored token — during a run; if they ever do, the rotation is written back
 * to BYOS_ONEDRIVE_TOKEN_FILE so the next run still has a live token.
 */
import { promises as fs } from 'node:fs';

import { refreshTokens } from '@/features/cloud-store/microsoft-oauth';
import { createMicrosoftTokenSource, type MicrosoftTokenSource } from '@/features/cloud-store/microsoft-token-source';
import { createOneDriveCloudObjectStore, GRAPH_BASE, type OneDriveFolderIds } from '@/features/cloud-store/onedrive-cloud-object-store';
import { createNodeDownloadFilePort, createNodeFileStat, createNodeFragmentReader, createNodeUploadFilePort } from '@/test/node-file-transfer';

export const refreshToken = process.env.BYOS_ONEDRIVE_REFRESH_TOKEN ?? '';
export const accessToken = process.env.BYOS_ONEDRIVE_ACCESS_TOKEN ?? '';
const tokenFile = process.env.BYOS_ONEDRIVE_TOKEN_FILE ?? '';
export const label = process.env.BYOS_ONEDRIVE_LABEL ?? 'owner OneDrive (personal)';
export const large = process.env.BYOS_ONEDRIVE_LARGE === '1';
export const configured = Boolean(refreshToken && accessToken);

let current = refreshToken;
export const tokens: MicrosoftTokenSource = createMicrosoftTokenSource({
  seed: { accessToken: accessToken || null, refreshToken, expiresAt: Date.now() + 55 * 60_000 },
  refresh: (rt) => refreshTokens(fetch as never, { refreshToken: rt }),
  onRotated: async (rt) => {
    current = rt;
    if (tokenFile) await fs.writeFile(tokenFile, JSON.stringify({ ...JSON.parse(await fs.readFile(tokenFile, 'utf8')), refreshToken: rt, rotatedAt: new Date().toISOString() }, null, 2));
  },
});
export const currentRefreshToken = (): string => current;

async function graph(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method, headers: { authorization: `Bearer ${await tokens.getAccessToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function mkdir(parentId: string, name: string): Promise<string> {
  const r = await graph('POST', `${GRAPH_BASE}/me/drive/items/${parentId}/children`, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
  if (!r.ok) throw new Error(`create ${name}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

/** `it-<run>/` with `state`/`blobs` under the app folder; returns the ids the adapter addresses. */
export async function createRunLayout(run: string): Promise<OneDriveFolderIds & { runFolderId: string }> {
  const approot = (await (await graph('GET', `${GRAPH_BASE}/me/drive/special/approot`)).json()) as { id: string };
  const runFolderId = await mkdir(approot.id, `it-${run}`);
  return { runFolderId, rootFolderId: runFolderId, stateFolderId: await mkdir(runFolderId, 'state'), blobsFolderId: await mkdir(runFolderId, 'blobs') };
}
export async function deleteRunFolder(runFolderId: string): Promise<void> {
  await graph('DELETE', `${GRAPH_BASE}/me/drive/items/${runFolderId}`);
}
export function storeFor(ids: OneDriveFolderIds) {
  return createOneDriveCloudObjectStore(ids, { tokens, fetchImpl: fetch as never, uploadFile: createNodeUploadFilePort(), downloadFile: createNodeDownloadFilePort(), statFile: createNodeFileStat(), readFragments: createNodeFragmentReader() });
}
export const factory = async (run: string) => {
  const ids = await createRunLayout(run);
  return { store: storeFor(ids), dispose: () => deleteRunFolder(ids.runFolderId) };
};
