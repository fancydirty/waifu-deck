import type { S3FetchPort } from '@/features/byos/s3-transport';

import { CloudStoreError } from './cloud-object-store';
import { DRIVE_BASE, DRIVE_FOLDER_MIME, driveFailure, GDRIVE_STALL_TIMEOUT_MS, type GoogleDriveFolderIds } from './gdrive-cloud-object-store';

type FolderRow = { id?: string; name?: string; createdTime?: string };
type ListBody = { files?: FolderRow[]; nextPageToken?: string };

/**
 * Builds the user-visible Drive layout. Drive has no create conflict behavior,
 * so every create is followed by an ordered read and an empty-loser cleanup.
 */
export async function bootstrapGoogleDriveLayout(
  fetchImpl: S3FetchPort,
  accessToken: string,
): Promise<{ ids: GoogleDriveFolderIds; accountEmail: string }> {
  const headers = { authorization: `Bearer ${accessToken}` };

  /** Each request carries its own controller so a stalled error body aborts THAT request (board #9). */
  async function request(url: string, init: RequestInit = {}): Promise<{ response: Response; controller: AbortController }> {
    const controller = new AbortController();
    try {
      const response = await fetchImpl(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: controller.signal });
      return { response, controller };
    } catch (error) {
      throw new CloudStoreError(0, 'network', `Google Drive layout failed before a response: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  async function listFolders(parentId: string | null, name: string, marker: boolean): Promise<FolderRow[]> {
    const clauses = [
      ...(parentId === null ? [] : [`${quote(parentId)} in parents`]),
      `name = ${quote(name)}`,
      `mimeType = ${quote(DRIVE_FOLDER_MIME)}`,
      'trashed = false',
      ...(marker ? [`appProperties has { key = 'waifuDeck' and value = 'root' }`] : []),
    ];
    const rows: FolderRow[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page >= 1000) throw new CloudStoreError(0, 'server', `Google Drive layout listing ${name} did not terminate.`, false);
      // Drive warns that orderBy=createdTime may time out on large collections;
      // layout marker queries are constrained to a handful of folders.
      const params = new URLSearchParams({ q: clauses.join(' and '), orderBy: 'createdTime', fields: 'nextPageToken,files(id,name,createdTime)', pageSize: '1000' });
      if (pageToken !== undefined) params.set('pageToken', pageToken);
      const { response, controller } = await request(`${DRIVE_BASE}/files?${params.toString()}`);
      if (!response.ok) throw await driveFailure(response, controller, GDRIVE_STALL_TIMEOUT_MS, `list ${name}`, false);
      const body = (await response.json()) as ListBody;
      rows.push(...(body.files ?? []));
      if (typeof body.nextPageToken !== 'string') return rows;
      pageToken = body.nextPageToken;
    }
  }

  const earliest = (rows: readonly FolderRow[]): FolderRow | null => rows.reduce<FolderRow | null>((best, row) => {
    if (typeof row.id !== 'string') return best;
    if (best === null) return row;
    const created = row.createdTime ?? '';
    const prior = best.createdTime ?? '';
    return created < prior || (created === prior && row.id < best.id!) ? row : best;
  }, null);

  async function createFolder(parentId: string | null, name: string, marker: boolean): Promise<string> {
    const metadata = { name, mimeType: DRIVE_FOLDER_MIME, ...(parentId === null ? {} : { parents: [parentId] }), ...(marker ? { appProperties: { waifuDeck: 'root' } } : {}) };
    const { response, controller } = await request(DRIVE_BASE + '/files?fields=id,name,createdTime', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify(metadata) });
    if (!response.ok) throw await driveFailure(response, controller, GDRIVE_STALL_TIMEOUT_MS, `create ${name}`, true);
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string') throw new CloudStoreError(200, 'client', `Google Drive create ${name} returned no id.`, true);
    return body.id;
  }

  async function isEmpty(folderId: string): Promise<boolean> {
    const params = new URLSearchParams({ q: `${quote(folderId)} in parents and trashed = false`, fields: 'files(id)', pageSize: '1' });
    const { response } = await request(`${DRIVE_BASE}/files?${params.toString()}`);
    if (!response.ok) return false;
    const body = (await response.json()) as { files?: unknown[] };
    return (body.files ?? []).length === 0;
  }

  async function ensureFolder(parentId: string | null, name: string, marker: boolean): Promise<string> {
    const first = earliest(await listFolders(parentId, name, marker));
    if (first?.id !== undefined) return first.id;
    const createdId = await createFolder(parentId, name, marker);
    const winner = earliest(await listFolders(parentId, name, marker));
    if (winner?.id === undefined) return createdId;
    if (winner.id !== createdId && await isEmpty(createdId)) {
      try {
        const { response: deleted } = await request(`${DRIVE_BASE}/files/${encodeURIComponent(createdId)}`, { method: 'DELETE' });
        // A cleanup race is harmless; all cleanup failures are intentionally ignored.
        void deleted;
      } catch {
        // The loser is unreferenced. A delete failure must not make sign-in fail.
      }
    }
    return winner.id;
  }

  const rootFolderId = await ensureFolder(null, 'Waifu Deck', true);
  const stateFolderId = await ensureFolder(rootFolderId, 'state', false);
  const blobsFolderId = await ensureFolder(rootFolderId, 'blobs', false);
  const { response: about, controller: aboutController } = await request(`${DRIVE_BASE}/about?fields=user(emailAddress)`);
  if (!about.ok) throw await driveFailure(about, aboutController, GDRIVE_STALL_TIMEOUT_MS, 'account e-mail', false);
  const body = (await about.json()) as { user?: { emailAddress?: unknown } };
  if (typeof body.user?.emailAddress !== 'string' || body.user.emailAddress === '') throw new CloudStoreError(200, 'client', 'Google Drive account e-mail is missing.', true);
  return { ids: { rootFolderId, stateFolderId, blobsFolderId }, accountEmail: body.user.emailAddress };
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
