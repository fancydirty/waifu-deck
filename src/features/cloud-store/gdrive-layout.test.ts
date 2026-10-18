import { createFakeDrive } from '@/test/fake-drive-server';

import { CloudStoreError } from './cloud-object-store';
import { GDRIVE_STALL_TIMEOUT_MS } from './gdrive-cloud-object-store';
import { bootstrapGoogleDriveLayout } from './gdrive-layout';

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const auth = (drive: ReturnType<typeof createFakeDrive>) => ({ authorization: `Bearer ${drive.issueAccessToken()}` });

describe('bootstrapGoogleDriveLayout', () => {
  test('empty Drive creates root, state, then blobs and returns the account e-mail', async () => {
    const drive = createFakeDrive({ emptyLayout: true });
    const result = await bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken());
    expect(result.accountEmail).toBe(drive.accountEmail);
    expect(drive.folderNames(result.ids.rootFolderId)).toEqual(['blobs', 'state']);
    const creates = drive.calls.filter((call) => call.method === 'POST' && call.url.includes('/drive/v3/files?'));
    expect(creates).toHaveLength(3);
    expect(result.ids.rootFolderId < result.ids.stateFolderId).toBe(true);
    expect(result.ids.stateFolderId < result.ids.blobsFolderId).toBe(true);
  });

  test('same-named non-folder is ignored by the marker query', async () => {
    const drive = createFakeDrive();
    drive.clearFolders();
    const fileId = await drive.putMultipart(drive.ids.rootFolderId, 'state', new TextEncoder().encode('file'));
    const result = await bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken());
    expect(drive.fileById(result.ids.stateFolderId)?.folder).toBe(true);
    expect(result.ids.stateFolderId).not.toBe(fileId);
  });

  test('existing marked layout creates nothing', async () => {
    const drive = createFakeDrive();
    const before = drive.calls.filter((call) => call.method === 'POST').length;
    const result = await bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken());
    expect(result.ids).toEqual(drive.ids);
    expect(drive.calls.filter((call) => call.method === 'POST')).toHaveLength(before);
  });

  test('adopts the earliest duplicate and deletes its own empty loser', async () => {
    let now = 2_000;
    const drive = createFakeDrive({ emptyLayout: true, now: () => now });
    let ownRoot: string | null = null;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const response = await drive.fetch(url, init);
      if (init.method === 'POST' && url.includes('/drive/v3/files?') && ownRoot === null) {
        ownRoot = String((await json(response.clone())).id);
        now = 1_000;
        await drive.fetch(url, { method: 'POST', headers: auth(drive), body: JSON.stringify({ name: 'Waifu Deck', mimeType: 'application/vnd.google-apps.folder', appProperties: { waifuDeck: 'root' } }) });
        now = 2_000;
      }
      return response;
    };
    const result = await bootstrapGoogleDriveLayout(fetch, drive.issueAccessToken());
    expect(result.ids.rootFolderId).not.toBe(ownRoot);
    expect(ownRoot === null ? null : drive.fileById(ownRoot)).toBeNull();
  });

  test('keeps its own earliest folder and performs no cleanup when it wins', async () => {
    let now = 2_000;
    const drive = createFakeDrive({ emptyLayout: true, now: () => now });
    let ownRoot: string | null = null;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const response = await drive.fetch(url, init);
      if (init.method === 'POST' && url.includes('/drive/v3/files?') && ownRoot === null) {
        ownRoot = String((await json(response.clone())).id);
        now = 3_000;
        await drive.fetch(url, { method: 'POST', headers: auth(drive), body: JSON.stringify({ name: 'Waifu Deck', mimeType: 'application/vnd.google-apps.folder', appProperties: { waifuDeck: 'root' } }) });
        now = 2_000;
      }
      return response;
    };
    const result = await bootstrapGoogleDriveLayout(fetch, drive.issueAccessToken());
    expect(result.ids.rootFolderId).toBe(ownRoot);
    expect(drive.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  test('does not delete a non-empty loser', async () => {
    let now = 2_000;
    const drive = createFakeDrive({ emptyLayout: true, now: () => now });
    let ownRoot: string | null = null;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const response = await drive.fetch(url, init);
      if (init.method === 'POST' && url.includes('/drive/v3/files?') && ownRoot === null) {
        ownRoot = String((await json(response.clone())).id);
        now = 1_000;
        await drive.fetch(url, { method: 'POST', headers: auth(drive), body: JSON.stringify({ name: 'Waifu Deck', mimeType: 'application/vnd.google-apps.folder', appProperties: { waifuDeck: 'root' } }) });
        now = 2_000;
        await drive.putMultipart(ownRoot, 'keep', new TextEncoder().encode('x'));
      }
      return response;
    };
    const result = await bootstrapGoogleDriveLayout(fetch, drive.issueAccessToken());
    expect(result.ids.rootFolderId).not.toBe(ownRoot);
    expect(ownRoot === null ? null : drive.fileById(ownRoot)).not.toBeNull();
    expect(drive.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  test('ignores a cleanup delete failure for an empty loser', async () => {
    let now = 2_000;
    const drive = createFakeDrive({ emptyLayout: true, now: () => now });
    let ownRoot: string | null = null;
    let cleanupAttempts = 0;
    const fetch = async (url: string, init: RequestInit = {}) => {
      const response = await drive.fetch(url, init);
      if (init.method === 'POST' && url.includes('/drive/v3/files?') && ownRoot === null) {
        ownRoot = String((await json(response.clone())).id);
        now = 1_000;
        await drive.fetch(url, { method: 'POST', headers: auth(drive), body: JSON.stringify({ name: 'Waifu Deck', mimeType: 'application/vnd.google-apps.folder', appProperties: { waifuDeck: 'root' } }) });
        now = 2_000;
      }
      if (init.method === 'DELETE' && ownRoot !== null) { cleanupAttempts += 1; throw new Error('cleanup unavailable'); }
      return response;
    };
    const result = await bootstrapGoogleDriveLayout(fetch, drive.issueAccessToken());
    expect(result.ids.rootFolderId).not.toBe(ownRoot);
    expect(cleanupAttempts).toBe(1);
  });

  test('missing account e-mail is a client error', async () => {
    const drive = createFakeDrive();
    const fetch = async (url: string, init: RequestInit = {}) => {
      const response = await drive.fetch(url, init);
      if (url.includes('/drive/v3/about?fields=user(emailAddress)')) return new Response(JSON.stringify({ user: {} }), { status: 200 });
      return response;
    };
    await expect(bootstrapGoogleDriveLayout(fetch, drive.issueAccessToken())).rejects.toMatchObject<Partial<CloudStoreError>>({ category: 'client' });
    expect(drive.calls.filter((call) => call.url.includes('/drive/v3/about?fields=user(emailAddress)'))).toHaveLength(1);
  });

  // 补裁 7's two other query clauses. The parent clause keeps `state` under the adopted root
  // (not a same-named folder under a losing root); the marker keeps an unmarked user folder
  // called "Waifu Deck" from being adopted as the library root.
  const mkFolder = async (drive: ReturnType<typeof createFakeDrive>, body: object) =>
    String((await json(await drive.fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { ...auth(drive), 'content-type': 'application/json' }, body: JSON.stringify({ mimeType: 'application/vnd.google-apps.folder', ...body }) }))).id);

  test('state is looked up under the adopted root, not anywhere in Drive', async () => {
    let now = 1_000;
    const drive = createFakeDrive({ emptyLayout: true, now: () => now });
    const winnerRoot = await mkFolder(drive, { name: 'Waifu Deck', appProperties: { waifuDeck: 'root' } });
    now = 2_000;
    const loserRoot = await mkFolder(drive, { name: 'Waifu Deck', appProperties: { waifuDeck: 'root' } });
    now = 3_000;
    await mkFolder(drive, { name: 'state', parents: [loserRoot] }); // earlier, but under the wrong root
    now = 4_000;
    const state = await mkFolder(drive, { name: 'state', parents: [winnerRoot] });
    const result = await bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken());
    expect(result.ids.rootFolderId).toBe(winnerRoot);
    expect(result.ids.stateFolderId).toBe(state);
  });

  test('an unmarked folder named Waifu Deck is never adopted as the root', async () => {
    let now = 500;
    const drive = createFakeDrive({ emptyLayout: true, now: () => now });
    await mkFolder(drive, { name: 'Waifu Deck' }); // the user's own folder, earlier, no marker
    now = 1_000;
    const marked = await mkFolder(drive, { name: 'Waifu Deck', appProperties: { waifuDeck: 'root' } });
    const result = await bootstrapGoogleDriveLayout(drive.fetch, drive.issueAccessToken());
    expect(result.ids.rootFolderId).toBe(marked);
  });
});

describe('a stalled layout error body (board #9 T2)', () => {
  test('a 503 on the first folder listing whose body never completes is the status-based error within the stall window, and THAT request is aborted', async () => {
    jest.useFakeTimers();
    try {
      const drive = createFakeDrive();
      const signals: AbortSignal[] = [];
      const fetch = async (url: string, init: RequestInit = {}) => {
        signals.push(init.signal!);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
      };
      const pending = bootstrapGoogleDriveLayout(fetch, drive.issueAccessToken());
      const settled = jest.fn();
      pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(GDRIVE_STALL_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject({ name: 'CloudStoreError', status: 503 });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  }, 5000);
});
