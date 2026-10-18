import type { S3FetchPort } from '@/features/byos/s3-transport';

import { CloudStoreError } from './cloud-object-store';
import { GRAPH_BASE, GRAPH_ORIGIN, graphFailure, ONEDRIVE_STALL_TIMEOUT_MS, type OneDriveFolderIds } from './onedrive-cloud-object-store';

/**
 * P12-C Task 7: first-sign-in (and every re-login) bootstrap for the OneDrive
 * binding. Resolves the three folder ids `createOneDriveCloudObjectStore`
 * needs, id-anchored so the localized "Apps/应用" special-folder path name is
 * never spelled anywhere. `state`/`blobs` are created with
 * `conflictBehavior: 'fail'` so a second device (or a re-login after losing
 * the binding) never silently duplicates them: a 409 means they already
 * exist, and their ids are read back from the parent listing instead — a
 * FILE sharing the name is never mistaken for it, only an actual folder.
 */
export async function bootstrapOneDriveLayout(
  fetchImpl: S3FetchPort,
  accessToken: string,
): Promise<{ ids: OneDriveFolderIds; accountEmail: string }> {
  const headers = { authorization: `Bearer ${accessToken}` };

  async function get(url: string, label: string): Promise<Response> {
    // Its own controller so a stalled error body aborts THIS request (board #9).
    const controller = new AbortController();
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: controller.signal });
    } catch (error) {
      throw new CloudStoreError(0, 'network', `OneDrive ${label} failed before a response: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    if (!res.ok) throw await graphFailure(res, controller, ONEDRIVE_STALL_TIMEOUT_MS, label, false);
    return res;
  }

  // Pages through the parent's children (Graph's default page is far smaller
  // than a folder can hold) looking for an existing FOLDER with this name —
  // never a same-named file. Bounded and origin-checked like the adapter's
  // own `listChildren`: a rewritten `@odata.nextLink` must stay on
  // graph.microsoft.com, and a server that pages forever fails loudly
  // instead of hanging.
  async function existingChildId(parentId: string, name: string): Promise<string> {
    let next: string | null = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(parentId)}/children?$select=id,name,folder&$top=1000`;
    for (let page = 1; next !== null; page += 1) {
      let nextOrigin: string;
      try {
        nextOrigin = new URL(next).origin;
      } catch {
        throw new CloudStoreError(0, 'client', `OneDrive list ${parentId}: unusable nextLink (not a parseable absolute URL): ${next}.`, true);
      }
      if (nextOrigin !== GRAPH_ORIGIN) throw new CloudStoreError(0, 'client', `OneDrive list ${parentId}: refusing to follow a nextLink off graph.microsoft.com (${next}).`, true);
      if (page > 1000) throw new CloudStoreError(0, 'server', `OneDrive list ${parentId}: paging did not terminate after 1000 pages.`, false);
      const list = await get(next, `list ${parentId}`);
      const body = (await list.json()) as { value: { id?: unknown; name: string; folder?: unknown }[]; '@odata.nextLink'?: string };
      const existing = body.value.find((item) => item.name === name && item.folder !== undefined);
      if (existing !== undefined) {
        if (typeof existing.id !== 'string') {
          throw new CloudStoreError(0, 'client', `OneDrive list ${parentId}: "${name}" response had no string "id".`, true);
        }
        return existing.id;
      }
      next = typeof body['@odata.nextLink'] === 'string' ? body['@odata.nextLink'] : null;
    }
    throw new CloudStoreError(409, 'client', `OneDrive: "${name}" already exists under the app folder but is not itself a folder, or was not found in its listing.`, true);
  }

  async function ensureChildFolder(parentId: string, name: string): Promise<string> {
    const url = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(parentId)}/children`;
    const controller = new AbortController();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudStoreError(0, 'network', `OneDrive create "${name}" failed before a response: ${error instanceof Error ? error.message : String(error)}`, false);
    }
    if (res.status === 409) return existingChildId(parentId, name);
    if (!res.ok) throw await graphFailure(res, controller, ONEDRIVE_STALL_TIMEOUT_MS, `create "${name}"`, true);
    const body = (await res.json()) as { id?: unknown };
    if (typeof body.id !== 'string') {
      throw new CloudStoreError(0, 'client', `OneDrive create "${name}": response had no string "id".`, true);
    }
    return body.id;
  }

  const me = await get(`${GRAPH_BASE}/me`, 'me');
  const meBody = (await me.json()) as { mail?: string | null; userPrincipalName?: string };
  const accountEmail = meBody.mail ?? meBody.userPrincipalName ?? '';
  if (accountEmail === '') {
    throw new CloudStoreError(0, 'client', 'OneDrive GET /me returned no e-mail for the account.', true);
  }

  const root = await get(`${GRAPH_BASE}/me/drive/special/approot`, 'approot');
  const rootBody = (await root.json()) as { id?: unknown };
  if (typeof rootBody.id !== 'string') {
    throw new CloudStoreError(0, 'client', 'OneDrive approot: response had no string "id".', true);
  }

  // Sequential, not Promise.all: `blobs` must never be created before `state`
  // exists (a caller that observes a half-built layout should always see
  // `state` first), and it keeps the one-shot 409 deterministic to reason about.
  const stateFolderId = await ensureChildFolder(rootBody.id, 'state');
  const blobsFolderId = await ensureChildFolder(rootBody.id, 'blobs');

  return {
    ids: { rootFolderId: rootBody.id, stateFolderId, blobsFolderId },
    accountEmail,
  };
}
