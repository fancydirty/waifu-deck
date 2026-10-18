/**
 * Shared scaffolding for the real-backend WebDAV suites (P12-B, spec §8):
 * the BYOS_WEBDAV_* environment `scripts/run-byos-webdav-gate.mjs` supplies,
 * one binding per run under `<root>/it-<run>/`, and the folder's creation and
 * recursive deletion. Lives outside `*.integration.test.ts` so importing it
 * never registers another copy of a suite.
 */
import type { WebdavBinding } from '@/features/byos/byos-credentials';
import { createWebdavCloudObjectStore, webdavObjectUrl } from '@/features/cloud-store/webdav-cloud-object-store';
import { createNodeDownloadFilePort, createNodeUploadFilePort } from '@/test/node-file-transfer';

export const baseUrl = process.env.BYOS_WEBDAV_BASE_URL ?? '';
export const username = process.env.BYOS_WEBDAV_USERNAME ?? '';
export const password = process.env.BYOS_WEBDAV_PASSWORD ?? '';
export const root = process.env.BYOS_WEBDAV_ROOT ?? '/';
export const label = process.env.BYOS_WEBDAV_LABEL ?? 'webdav';
export const configured = Boolean(baseUrl && username && password);

const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

/** One binding per run under `<root>/it-<run>/`. */
export function bindingFor(run: string): WebdavBinding {
  return { kind: 'webdav', baseUrl, username, password, rootPath: `${root.replace(/\/+$/, '')}/it-${run}/` };
}

/** The `it-<run>/` folder itself (the parent of the adapter's `Waifu Deck/`). */
const runFolderUrl = (binding: WebdavBinding): string =>
  webdavObjectUrl(binding, '').replace(/Waifu%20Deck\/$/, '');

/** Synology answers MKCOL 409 for a missing parent, so the run folder is created before `ensureLayout`. */
export async function createRunFolder(binding: WebdavBinding): Promise<void> {
  await fetch(runFolderUrl(binding), { method: 'MKCOL', headers: { authorization } });
}

/** Recursive DELETE (204 on every measured server), so nothing accumulates on a real account. */
export async function deleteRunFolder(binding: WebdavBinding): Promise<void> {
  await fetch(runFolderUrl(binding), { method: 'DELETE', headers: { authorization } });
}

export function storeFor(binding: WebdavBinding) {
  return createWebdavCloudObjectStore(binding, { fetchImpl: fetch, uploadFile: createNodeUploadFilePort(), downloadFile: createNodeDownloadFilePort() });
}

export const factory = async (run: string) => {
  const binding = bindingFor(run);
  await createRunFolder(binding);
  return { store: storeFor(binding), dispose: () => deleteRunFolder(binding) };
};
