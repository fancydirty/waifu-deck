import { createFakeGraph, GRAPH_ORIGIN } from '@/test/fake-graph-server';

import { GRAPH_BASE, ONEDRIVE_STALL_TIMEOUT_MS } from './onedrive-cloud-object-store';
import { bootstrapOneDriveLayout } from './onedrive-layout';

describe('bootstrapOneDriveLayout', () => {
  test('first sign-in: approot → create state + blobs (conflictBehavior fail) → ids + the account e-mail from /me', async () => {
    const graph = createFakeGraph();
    // A fresh drive: only the approot exists (the fake pre-creates state/blobs; remove them to model a first sign-in).
    graph.clearFolders();
    const out = await bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken());
    expect(out.accountEmail).toBe('owner@example.com');
    expect(out.ids.rootFolderId).toBe(graph.ids.rootFolderId);
    const posts = graph.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([`${GRAPH_ORIGIN}/v1.0/me/drive/items/${graph.ids.rootFolderId}/children`, `${GRAPH_ORIGIN}/v1.0/me/drive/items/${graph.ids.rootFolderId}/children`]);
    expect(graph.folderNames(graph.ids.rootFolderId)).toEqual(['blobs', 'state']);
    expect(out.ids.stateFolderId).not.toBe(out.ids.blobsFolderId);
  });
  test('second device / re-login: the children already exist → 409 → the existing ids are read from the listing (nothing duplicated)', async () => {
    const graph = createFakeGraph();
    const out = await bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken());
    expect(out.ids).toEqual(graph.ids);
    expect(graph.folderNames(graph.ids.rootFolderId)).toEqual(['blobs', 'state']);
  });
  test('403 (AppFolder still provisioning) is an auth CloudStoreError carrying the Graph code; a network throw is network', async () => {
    const graph = createFakeGraph();
    graph.failNext(403, { error: { code: 'accessDenied', message: 'pending provisioning' } });
    await expect(bootstrapOneDriveLayout(graph.fetch, graph.issueAccessToken())).rejects.toMatchObject({ name: 'CloudStoreError', status: 403, category: 'auth', message: expect.stringContaining('accessDenied') });
    await expect(bootstrapOneDriveLayout(async () => { throw new TypeError('offline'); }, 'AT')).rejects.toMatchObject({ category: 'network' });
  });
  test('creates state/blobs with an exact JSON body pinning conflictBehavior "fail" (never "replace", which could delete another device\'s same-named folder)', async () => {
    const graph = createFakeGraph();
    graph.clearFolders();
    const bodies: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/children') && (init?.method ?? 'GET').toUpperCase() === 'POST') bodies.push(String(init?.body));
      return graph.fetch(url, init);
    };
    await bootstrapOneDriveLayout(fetchImpl, graph.issueAccessToken());
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0]!)).toEqual({ name: 'state', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
    expect(JSON.parse(bodies[1]!)).toEqual({ name: 'blobs', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
  });
  test('409 recovery only accepts an existing FOLDER named "state" — a same-named FILE already at the root is never mistaken for it', async () => {
    const graph = createFakeGraph();
    graph.clearFolders();
    const token = graph.issueAccessToken();
    await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.rootFolderId}:/state:/content`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body: new Uint8Array([1]),
    });
    await expect(bootstrapOneDriveLayout(graph.fetch, token)).rejects.toMatchObject({ name: 'CloudStoreError', category: 'client' });
  });
  test('accountEmail falls back to userPrincipalName when /me has no "mail"', async () => {
    const graph = createFakeGraph();
    const token = graph.issueAccessToken();
    graph.failNext(200, { id: 'user-1', userPrincipalName: 'u@example.com' }, {}, /\/me$/);
    const out = await bootstrapOneDriveLayout(graph.fetch, token);
    expect(out.accountEmail).toBe('u@example.com');
  });
  test('rejects when /me has neither "mail" nor "userPrincipalName" rather than storing a blank account label', async () => {
    const graph = createFakeGraph();
    const token = graph.issueAccessToken();
    graph.failNext(200, {}, {}, /\/me$/);
    await expect(bootstrapOneDriveLayout(graph.fetch, token)).rejects.toMatchObject({ name: 'CloudStoreError', category: 'client', message: expect.stringContaining('no e-mail') });
  });
  test('409 recovery pages through the listing (@odata.nextLink) instead of only checking the first page', async () => {
    const graph = createFakeGraph({ pageSize: 1 });
    graph.clearFolders();
    const token = graph.issueAccessToken();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const rootChildren = `${GRAPH_BASE}/me/drive/items/${graph.ids.rootFolderId}/children`;
    // Three unrelated files sort ahead of "state" alphabetically, pushing it onto a later page.
    for (const name of ['a', 'b', 'c']) {
      await graph.fetch(rootChildren, { method: 'POST', headers, body: JSON.stringify({ name }) });
    }
    const stateRes = await graph.fetch(rootChildren, { method: 'POST', headers, body: JSON.stringify({ name: 'state', folder: {} }) });
    const { id: seededStateId } = (await stateRes.json()) as { id: string };

    const out = await bootstrapOneDriveLayout(graph.fetch, token);

    const listGets = graph.calls.filter((c) => c.method === 'GET' && c.url.includes('/children'));
    expect(listGets).toHaveLength(4); // one page each for a, b, c, then the page holding "state"
    expect(out.ids.stateFolderId).toBe(seededStateId);
    expect(graph.folderNames(graph.ids.rootFolderId).sort()).toEqual(['blobs', 'state']);
  });
  test('rejects when the approot response has no string "id" rather than propagating a wrong-typed id', async () => {
    const graph = createFakeGraph();
    const token = graph.issueAccessToken();
    graph.failNext(200, { id: 42, name: 'Waifu Deck', folder: {} }, {}, /approot$/);
    await expect(bootstrapOneDriveLayout(graph.fetch, token)).rejects.toMatchObject({ name: 'CloudStoreError', category: 'client' });
  });
  test('rejects when a freshly created child folder\'s response has no string "id"', async () => {
    const graph = createFakeGraph();
    graph.clearFolders();
    const token = graph.issueAccessToken();
    graph.failNext(201, { id: 42, name: 'state', folder: {} }, {}, /\/children$/);
    await expect(bootstrapOneDriveLayout(graph.fetch, token)).rejects.toMatchObject({ name: 'CloudStoreError', category: 'client' });
  });
});

describe('a stalled layout error body (board #9 T2)', () => {
  test('a 503 on the approot GET whose body never completes is the status-based error within the stall window, and THAT request is aborted', async () => {
    jest.useFakeTimers();
    try {
      const graph = createFakeGraph();
      const signals: AbortSignal[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
      };
      const pending = bootstrapOneDriveLayout(fetchImpl, graph.issueAccessToken());
      const settled = jest.fn();
      pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(ONEDRIVE_STALL_TIMEOUT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).rejects.toMatchObject({ name: 'CloudStoreError', status: 503 });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  }, 5000);
});
