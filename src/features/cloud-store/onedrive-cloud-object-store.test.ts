import type { CloudGetProgress, CloudObjectStore } from './cloud-object-store';
import { readFile, stat } from 'node:fs/promises';
import { refreshTokens } from './microsoft-oauth';
import { createMicrosoftTokenSource, type MicrosoftTokenSource } from './microsoft-token-source';
import { createOneDriveCloudObjectStore, GRAPH_BASE, onedriveItemUrl } from './onedrive-cloud-object-store';
import { createFakeGraph, type FakeGraph } from '@/test/fake-graph-server';
import { createNodeBlobStaging, createNodeDownloadFilePort, createNodeFileStat, createNodeFragmentReader } from '@/test/node-file-transfer';

function harness(graph: FakeGraph = createFakeGraph(), extra: Record<string, unknown> = {}) {
  const rotated: string[] = [];
  // The real Task 2 refresh over the fake token endpoint: rotation and
  // invalid_grant reach the adapter exactly as they will from Microsoft.
  const tokens: MicrosoftTokenSource = createMicrosoftTokenSource({
    seed: { accessToken: null, refreshToken: graph.issueRefreshToken(), expiresAt: 0 },
    refresh: (rt) => refreshTokens(graph.fetch, { refreshToken: rt }),
    onRotated: (rt) => { rotated.push(rt); },
  });
  const store: CloudObjectStore = createOneDriveCloudObjectStore(graph.ids, { fetchImpl: graph.fetch, uploadFile: graph.uploadFile, statFile: createNodeFileStat(), readFragments: createNodeFragmentReader(), tokens, ...extra });
  return { graph, store, tokens, rotated };
}
const graphCalls = (g: FakeGraph) => g.calls.filter((c) => c.url.startsWith(GRAPH_BASE)).map((c) => `${c.method} ${c.url.slice(GRAPH_BASE.length)}`);

describe('addressing', () => {
  test('id-anchored path addressing with the name percent-encoded; never the literal app-folder path', () => {
    expect(GRAPH_BASE).toBe('https://graph.microsoft.com/v1.0');
    expect(onedriveItemUrl('F0001', 'a b.json')).toBe('https://graph.microsoft.com/v1.0/me/drive/items/F0001:/a%20b.json:');
  });
  test('vault-meta.json lives in the root folder, state/* in state, blobs/* in blobs; any other shape is a client error', async () => {
    const { graph, store } = harness();
    await store.get('vault-meta.json'); await store.get('state/n.json'); await store.get('blobs/g');
    expect(graphCalls(graph)).toEqual([
      `GET /me/drive/items/${graph.ids.rootFolderId}:/vault-meta.json:/content`,
      `GET /me/drive/items/${graph.ids.stateFolderId}:/n.json:/content`,
      `GET /me/drive/items/${graph.ids.blobsFolderId}:/g:/content`,
    ]);
    await expect(store.get('other/x')).rejects.toMatchObject({ category: 'client' });
    await expect(store.get('state/a/b')).rejects.toMatchObject({ category: 'client' });
  });
  test('any slash-free name lives in the root folder, not only vault-meta.json (the contract suite writes other root object names too)', async () => {
    const { graph, store } = harness();
    await store.put('x-root.json', new Uint8Array([9, 8, 7]), 'application/json');
    expect(graphCalls(graph)).toEqual([`PUT /me/drive/items/${graph.ids.rootFolderId}:/x-root.json:/content`]);
    expect(Array.from(graph.fileBytes(graph.ids.rootFolderId, 'x-root.json')!)).toEqual([9, 8, 7]);
    const back = await store.get('x-root.json');
    expect(Array.from(back!)).toEqual([9, 8, 7]);
    expect(await store.list('')).toEqual(expect.arrayContaining([{ name: 'x-root.json', size: 3 }]));
    expect((await store.list('state')).map((e) => e.name)).not.toContain('x-root.json');
    await expect(store.get('')).rejects.toMatchObject({ category: 'client' });
    await expect(store.get('a/b/c')).rejects.toMatchObject({ category: 'client' });
  });
});

describe('auth', () => {
  test('a cold store refreshes once (rotating the refresh token) and reuses the access token across requests', async () => {
    const { graph, store, rotated } = harness();
    await store.get('vault-meta.json'); await store.list('state');
    expect(rotated).toHaveLength(1);
    const bearers = new Set(graph.calls.filter((c) => c.url.startsWith(GRAPH_BASE)).map((c) => c.headers.authorization));
    expect(bearers.size).toBe(1);
  });
  test('a 401 from Graph invalidates the token, refreshes, and retries ONCE; a second 401 is auth', async () => {
    const { graph, store, rotated } = harness();
    graph.failNext(401, { error: { code: 'InvalidAuthenticationToken' } });
    expect(await store.get('vault-meta.json')).toBeNull();
    expect(rotated).toHaveLength(2);
    graph.failNext(401); graph.failNext(401);
    await expect(store.get('vault-meta.json')).rejects.toMatchObject({ status: 401, category: 'auth' });
  });
  test('a revoked refresh token surfaces as auth/reauth_required from any verb', async () => {
    const { graph, store } = harness();
    graph.revokeRefreshTokens();
    await expect(store.list('state')).rejects.toMatchObject({ status: 401, category: 'auth', message: expect.stringContaining('reauth_required') });
  });
});

describe('error map (spec §4.2 补裁 6)', () => {
  test.each([
    [403, { error: { code: 'accessDenied' } }, 'auth', true],
    [409, { error: { code: 'nameAlreadyExists' } }, 'client', true],
    [429, { error: { code: 'activityLimitReached' } }, 'rate_limited', false],
    [503, { error: { code: 'serviceNotAvailable' } }, 'rate_limited', false],
    [500, { error: { code: 'generalException' } }, 'server', false],
    [507, { error: { code: 'insufficientStorage' } }, 'quota_full', true],
    [400, { error: { code: 'invalidRequest' } }, 'client', true],
    // The quota-code override: quotaLimitReached/insufficientStorage → quota_full
    // regardless of status; and a bare 507 stays quota_full via status alone.
    [403, { error: { code: 'quotaLimitReached' } }, 'quota_full', true],
    [507, { error: { code: 'generalException' } }, 'quota_full', true],
  ] as const)('a %s with body %o on a write (delete) → %s (outcomeKnown %s), with the Graph error code in the message', async (status, body, category, known) => {
    const { graph, store } = harness();
    graph.failNext(status, body);
    await expect(store.delete('state/n.json')).rejects.toMatchObject({ status, category, outcomeKnown: known, message: expect.stringContaining((body.error as { code: string }).code) });
  });
  test('429 carries Retry-After in the message and the adapter does not sleep (the call returns at once)', async () => {
    const { graph, store } = harness();
    graph.failNext(429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '11' });
    const t0 = Date.now();
    await expect(store.list('state')).rejects.toMatchObject({ category: 'rate_limited', message: expect.stringContaining('Retry-After 11') });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  test('a fetch that throws is network / outcome unknown', async () => {
    const graph = createFakeGraph();
    const { store } = harness(graph, { fetchImpl: async (url: string, init?: RequestInit) => { if (url.startsWith(GRAPH_BASE)) throw new TypeError('offline'); return graph.fetch(url, init); } });
    await expect(store.delete('state/n.json')).rejects.toMatchObject({ status: 0, category: 'network', outcomeKnown: false });
  });
});

describe('a stalled error body (board #9 T2, spec §5.2)', () => {
  test('a 503 whose body never completes yields the status-based error within stallMs and aborts the request\'s own controller', async () => {
    jest.useFakeTimers();
    try {
      const graph = createFakeGraph();
      const signals: AbortSignal[] = [];
      // Headers arrive, the body never does: the device fetch has no read timeout.
      const fetchImpl = async (url: string, init?: RequestInit) => {
        if (!url.includes(':/g:/content')) return graph.fetch(url, init);
        signals.push(init!.signal!);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
      };
      const { store } = harness(graph, { fetchImpl, stallMs: 1000 });
      const pending = store.get('blobs/g');
      const settled = jest.fn();
      pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalled();
      await expect(pending).rejects.toMatchObject({ name: 'CloudStoreError', status: 503, category: 'rate_limited', outcomeKnown: true });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  }, 5000);
});

describe('ensureLayout = GET the three ids', () => {
  test('all present → resolves with exactly three GETs and no create', async () => {
    const { graph, store } = harness();
    await store.ensureLayout();
    expect(graphCalls(graph)).toEqual([graph.ids.rootFolderId, graph.ids.stateFolderId, graph.ids.blobsFolderId].map((id) => `GET /me/drive/items/${id}?$select=id`));
  });
  test('a missing folder is a client error naming the app folder; it is never recreated', async () => {
    const graph = createFakeGraph();
    const { tokens } = harness(graph);
    const broken = createOneDriveCloudObjectStore({ ...graph.ids, blobsFolderId: 'F-gone' }, { fetchImpl: graph.fetch, uploadFile: graph.uploadFile, statFile: createNodeFileStat(), readFragments: createNodeFragmentReader(), tokens });
    await expect(broken.ensureLayout()).rejects.toMatchObject({ status: 404, category: 'client', outcomeKnown: true, message: expect.stringMatching(/app folder/i) });
    expect(graph.calls.some((c) => c.method === 'POST' && c.url.startsWith(GRAPH_BASE))).toBe(false);
  });
});

describe('get', () => {
  test('404 → null with no progress; 200 (via the followed redirect) streams bytes with sent/total; accept-encoding identity', async () => {
    const { graph, store } = harness();
    const seen: CloudGetProgress[] = [];
    expect(await store.get('blobs/g', (p) => seen.push(p))).toBeNull();
    expect(seen).toEqual([]);
    await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.blobsFolderId}:/g:/content`, { method: 'PUT', headers: { authorization: `Bearer ${graph.issueAccessToken()}` }, body: new Uint8Array([9, 8, 7]) });
    const back = await store.get('blobs/g', (p) => seen.push({ ...p }));
    expect(Array.from(back!)).toEqual([9, 8, 7]);
    expect(seen[seen.length - 1]).toEqual({ sent: 3, total: 3 });
    expect(graph.calls.find((c) => c.url.includes(':/g:/content') && c.method === 'GET')!.headers['accept-encoding']).toBe('identity');
  });
  test('a non-ok read is classified with outcome known (a read applies nothing)', async () => {
    const { graph, store } = harness();
    graph.failNext(500);
    await expect(store.get('blobs/g')).rejects.toMatchObject({ category: 'server', outcomeKnown: true });
  });
});

describe('getToFile', () => {
  test('without a download port the optional method is omitted', () => {
    const { store } = harness();
    expect(Object.prototype.hasOwnProperty.call(store, 'getToFile')).toBe(false);
  });

  async function fileHarness(graph: FakeGraph = createFakeGraph(), extra: Record<string, unknown> = {}) {
    const download = createNodeDownloadFilePort(graph.fetch as unknown as typeof fetch);
    const calls: { headers: Record<string, string>; fileUri: string }[] = [];
    const downloadFile = async (request: Parameters<typeof download>[0]) => {
      calls.push({ headers: { ...request.headers }, fileUri: request.fileUri });
      return download(request);
    };
    const harnessed = harness(graph, { ...extra, downloadFile });
    return { ...harnessed, calls };
  }

  test('401 then 200 refreshes once, keeps the file URI, and sends the old then new bearer', async () => {
    const graph = createFakeGraph();
    const { store, calls } = await fileHarness(graph);
    await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.blobsFolderId}:/g:/content`, {
      method: 'PUT', headers: { authorization: `Bearer ${graph.issueAccessToken()}` }, body: new Uint8Array([4, 5, 6]),
    });
    graph.failNext(401, { error: { code: 'InvalidAuthenticationToken' } }, {}, /:\/g:\/content/);
    const staging = createNodeBlobStaging();
    const fileUri = staging.resolveTemp('onedrive-get.bin');
    await expect(store.getToFile!('blobs/g', fileUri)).resolves.toEqual({ bytesWritten: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fileUri).toBe(calls[1]!.fileUri);
    expect(calls[0]!.headers.authorization).not.toBe(calls[1]!.headers.authorization);
    expect(calls.map((call) => call.headers['accept-encoding'])).toEqual(['identity', 'identity']);
    expect(Array.from(new Uint8Array(await readFile(new URL(fileUri))))).toEqual([4, 5, 6]);
    await staging.delete(fileUri);
  });

  test('401 twice is auth after exactly two native calls', async () => {
    const graph = createFakeGraph();
    graph.failNext(401, { error: { code: 'InvalidAuthenticationToken' } }, {}, /:\/g:\/content/);
    graph.failNext(401, { error: { code: 'InvalidAuthenticationToken' } }, {}, /:\/g:\/content/);
    const { store, calls } = await fileHarness(graph);
    const staging = createNodeBlobStaging();
    await expect(store.getToFile!('blobs/g', staging.resolveTemp('twice.bin'))).rejects.toMatchObject({ status: 401, category: 'auth' });
    expect(calls).toHaveLength(2);
  });

  test('error bodies drive quota, rate-limit, and status-only classifications', async () => {
    const quota = createFakeGraph();
    quota.failNext(403, { error: { code: 'quotaLimitReached' } }, {}, /:\/g:\/content/);
    await expect((await fileHarness(quota)).store.getToFile!('blobs/g', createNodeBlobStaging().resolveTemp('quota.bin'))).rejects.toMatchObject({ category: 'quota_full' });

    const limited = createFakeGraph();
    limited.failNext(429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '7' }, /:\/g:\/content/);
    await expect((await fileHarness(limited)).store.getToFile!('blobs/g', createNodeBlobStaging().resolveTemp('limited.bin'))).rejects.toMatchObject({ category: 'rate_limited', message: expect.stringContaining('Retry-After 7') });

    const nonJson = createFakeGraph();
    const port = async () => ({ status: 500, headers: {}, redirected: false, errorBody: '<html>nope</html>', bytesWritten: 0 });
    const { store } = harness(nonJson, { downloadFile: port });
    await expect(store.getToFile!('blobs/g', createNodeBlobStaging().resolveTemp('non-json.bin'))).rejects.toMatchObject({ status: 500, category: 'server' });
  });

  test('404 is null, leaves no file, and never uses fetchImpl for the blob', async () => {
    const graph = createFakeGraph();
    let blobFetches = 0;
    const { store } = await fileHarness(graph, { fetchImpl: async (url: string, init?: RequestInit) => { if (url.includes('/content')) blobFetches += 1; return graph.fetch(url, init); } });
    const staging = createNodeBlobStaging();
    const fileUri = staging.resolveTemp('missing.bin');
    const progress: CloudGetProgress[] = [];
    await expect(store.getToFile!('blobs/missing', fileUri, (p) => progress.push(p))).resolves.toBeNull();
    await expect(stat(new URL(fileUri))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(progress).toEqual([]);
    expect(blobFetches).toBe(0);
  });
});

describe('list', () => {
  test('state: follows @odata.nextLink to the end and maps name/size; the root listing drops the state/blobs subfolders', async () => {
    const graph = createFakeGraph({ pageSize: 2 });
    const { store } = harness(graph);
    const h = { authorization: `Bearer ${graph.issueAccessToken()}` };
    for (const n of ['a', 'b', 'c']) await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.stateFolderId}:/${n}.json:/content`, { method: 'PUT', headers: h, body: new Uint8Array(n.length + 1) });
    await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.rootFolderId}:/vault-meta.json:/content`, { method: 'PUT', headers: h, body: new Uint8Array(7) });
    expect(await store.list('state')).toEqual([{ name: 'a.json', size: 2 }, { name: 'b.json', size: 2 }, { name: 'c.json', size: 2 }]);
    expect(graphCalls(graph).filter((c) => c.includes('/children')).length).toBe(2);
    expect(await store.list('')).toEqual([{ name: 'vault-meta.json', size: 7 }]);
    expect(graphCalls(graph).some((c) => c.includes('$select=id,name,size,folder') && c.includes('$top=1000'))).toBe(true);
  });
});

describe('delete', () => {
  test('204 and 404 both resolve (idempotent); 403 is auth', async () => {
    const { graph, store } = harness();
    await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.stateFolderId}:/n.json:/content`, { method: 'PUT', headers: { authorization: `Bearer ${graph.issueAccessToken()}` }, body: new Uint8Array(1) });
    await expect(store.delete('state/n.json')).resolves.toBeUndefined();
    expect(graph.fileNames(graph.ids.stateFolderId)).toEqual([]);
    await expect(store.delete('state/n.json')).resolves.toBeUndefined();
    graph.failNext(403, { error: { code: 'accessDenied' } });
    await expect(store.delete('state/n.json')).rejects.toMatchObject({ category: 'auth' });
  });
});

describe('quota', () => {
  test('GET /me/drive?$select=quota → used/total; 401/403 throw auth; any other failure reports no quota', async () => {
    const { graph, store } = harness();
    expect(await store.quota()).toEqual({ usedBytes: 0, totalBytes: 5 * 1024 ** 3 });
    graph.failNext(403, { error: { code: 'accessDenied' } });
    await expect(store.quota()).rejects.toMatchObject({ category: 'auth' });
    graph.failNext(500);
    expect(await store.quota()).toBeNull();
  });
});

const KiB = 1024;
async function staged(bytes: Uint8Array, name = 'f') {
  const staging = createNodeBlobStaging();
  const uri = staging.resolveTemp(name);
  await staging.writeBytes(uri, bytes);
  return uri;
}
const uploadCalls = (g: FakeGraph) => g.calls.filter((c) => c.url.startsWith('https://fake.up.1drv.com'));

describe('put = PUT …:/content (≤ 4 MiB)', () => {
  test('writes the bytes with the content-type; a same-name write overwrites (OneDrive forbids two files of one name); 2xx resolves', async () => {
    const { graph, store } = harness();
    await store.put('state/n.json', new Uint8Array([1, 2]), 'application/json');
    await store.put('state/n.json', new Uint8Array([3]), 'application/json');
    const call = graph.calls.find((c) => c.method === 'PUT')!;
    expect(call.url).toBe(`${GRAPH_BASE}/me/drive/items/${graph.ids.stateFolderId}:/n.json:/content`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(Array.from(graph.fileBytes(graph.ids.stateFolderId, 'n.json')!)).toEqual([3]);
  });
  test('a body of exactly 4 MiB is accepted via one PUT (the boundary belongs to put, not putFromFile)', async () => {
    const { graph, store } = harness();
    await store.put('state/n.json', new Uint8Array(4 * 1024 * 1024), 'application/json');
    expect(graph.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(graph.fileBytes(graph.ids.stateFolderId, 'n.json')!.byteLength).toBe(4 * 1024 * 1024);
  });
  test('a body above 4 MiB is a client error before any request (that size belongs to putFromFile)', async () => {
    const { graph, store } = harness();
    await expect(store.put('state/n.json', new Uint8Array(4 * 1024 * 1024 + 1), 'application/json')).rejects.toMatchObject({ category: 'client' });
    expect(graph.calls.filter((c) => c.url.startsWith(GRAPH_BASE))).toHaveLength(0);
  });
  test('507 → quota_full (outcome known); a fetch throw → network / unknown', async () => {
    const { graph, store } = harness();
    graph.failNext(507, { error: { code: 'insufficientStorage' } });
    await expect(store.put('state/n.json', new Uint8Array(1), 'application/json')).rejects.toMatchObject({ status: 507, category: 'quota_full', outcomeKnown: true });
    const g2 = createFakeGraph();
    const dead = harness(g2, { fetchImpl: async (url: string, init?: RequestInit) => { if (url.includes(':/content')) throw new TypeError('reset'); return g2.fetch(url, init); } });
    await expect(dead.store.put('state/n.json', new Uint8Array(1), 'application/json')).rejects.toMatchObject({ category: 'network', outcomeKnown: false });
  });
});

describe('putFromFile below the single-PUT limit = createUploadSession → ONE native PUT', () => {
  test('session body carries conflictBehavior replace + fileSize; the PUT goes to uploadUrl with Content-Range and no Authorization; progress is forwarded; the bytes land', async () => {
    const { graph, store } = harness();
    const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const uri = await staged(bytes);
    const seen: number[] = [];
    await store.putFromFile('blobs/g', uri, 'application/octet-stream', (sent) => seen.push(sent));
    const session = graph.calls.find((c) => c.url.endsWith(':/g:/createUploadSession'))!;
    expect(session.method).toBe('POST');
    const put = uploadCalls(graph)[0]!;
    expect(put.method).toBe('PUT');
    expect(put.headers['content-range']).toBe('bytes 0-4999/5000');
    expect(put.headers.authorization).toBeUndefined();
    expect(seen[seen.length - 1]).toBe(5000);
    expect(Array.from(graph.fileBytes(graph.ids.blobsFolderId, 'g')!)).toEqual(Array.from(bytes));
    expect(graph.sessions()).toBe(0);
  });
  test('the session request body is exactly {item:{@microsoft.graph.conflictBehavior:"replace"}, fileSize}', async () => {
    const graph = createFakeGraph();
    const bodies: string[] = [];
    const { store } = harness(graph, { fetchImpl: async (url: string, init?: RequestInit) => { if (url.endsWith('/createUploadSession')) bodies.push(String(init?.body)); return graph.fetch(url, init); } });
    await store.putFromFile('blobs/g', await staged(new Uint8Array(10)), 'application/octet-stream');
    expect(JSON.parse(bodies[0]!)).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'replace' }, fileSize: 10 });
  });
  test('a missing or empty staged file is a client error and creates no session', async () => {
    const { graph, store } = harness();
    await expect(store.putFromFile('blobs/g', 'file:///definitely/missing', 'application/octet-stream')).rejects.toMatchObject({ category: 'client', outcomeKnown: true });
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(0)), 'application/octet-stream')).rejects.toMatchObject({ category: 'client' });
    expect(graph.calls.some((c) => c.url.endsWith('/createUploadSession'))).toBe(false);
  });
  test('fileSize over the remaining quota → 507 at session creation → quota_full, nothing uploaded', async () => {
    const graph = createFakeGraph({ quotaTotal: 100 });
    const { store } = harness(graph);
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(200)), 'application/octet-stream')).rejects.toMatchObject({ status: 507, category: 'quota_full', outcomeKnown: true });
    expect(uploadCalls(graph)).toHaveLength(0);
  });
  test('a non-2xx PUT status is classified by status (500 → server/unknown); a 202 after the whole file is a server error (not committed)', async () => {
    const graph = createFakeGraph();
    const a = harness(graph, { uploadFile: async () => ({ status: 500, headers: {} }) });
    await expect(a.store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream')).rejects.toMatchObject({ status: 500, category: 'server', outcomeKnown: false });
    const b = harness(graph, { uploadFile: async () => ({ status: 202, headers: {} }) });
    await expect(b.store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream')).rejects.toMatchObject({ status: 202, category: 'server', outcomeKnown: false });
  });
  test('a 404 from the upload host is an expired/cancelled session (server, retryable), not not_found', async () => {
    const graph = createFakeGraph();
    const { store } = harness(graph, { uploadFile: async () => ({ status: 404, headers: {} }) });
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream')).rejects.toMatchObject({ status: 404, category: 'server', outcomeKnown: false, message: expect.stringContaining('expired or was cancelled') });
  });
  test('an upload whose progress stops for stallMs is aborted as network / unknown (the shared K5 watchdog)', async () => {
    jest.useFakeTimers();
    try {
      const graph = createFakeGraph();
      let aborted = false;
      const uploadFile = (req: { signal?: AbortSignal }) => new Promise<{ status: number; headers: Record<string, string> }>((_, reject) => { req.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
      const { store } = harness(graph, { uploadFile, stallMs: 1500 });
      const p = store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream');
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('stalled') });
      await jest.advanceTimersByTimeAsync(1500);
      await assertion;
      expect(aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

describe('the uploadUrl Graph hands back must be a parseable https URL (no origin allowlist is possible for it)', () => {
  test('a non-https uploadUrl is refused as client before any PUT reaches that host', async () => {
    const graph = createFakeGraph();
    let evilHits = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://evil.example')) { evilHits += 1; return new Response(null, { status: 201 }); }
      const res = await graph.fetch(url, init);
      if (!url.endsWith('/createUploadSession')) return res;
      const body = (await res.clone().json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, uploadUrl: 'http://evil.example/up/1' }), { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream')).rejects.toMatchObject({ category: 'client', message: expect.stringContaining('unusable uploadUrl') });
    expect(evilHits).toBe(0);
  });
  test('an unparseable uploadUrl is refused as client', async () => {
    const graph = createFakeGraph();
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const res = await graph.fetch(url, init);
      if (!url.endsWith('/createUploadSession')) return res;
      const body = (await res.clone().json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, uploadUrl: 'not a url' }), { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream')).rejects.toMatchObject({ category: 'client', message: expect.stringContaining('unusable uploadUrl') });
  });
  test('a session answer with no uploadUrl at all is a server error', async () => {
    const graph = createFakeGraph();
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const res = await graph.fetch(url, init);
      if (!url.endsWith('/createUploadSession')) return res;
      const body = (await res.clone().json()) as Record<string, unknown>;
      delete body.uploadUrl;
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(3)), 'application/octet-stream')).rejects.toMatchObject({ category: 'server', message: expect.stringContaining('no uploadUrl in the answer') });
  });
});

describe('putFromFile at or above the single-PUT limit = sequential fragments over fetch', () => {
  // Graph's real numbers (320 KiB units, 60 MiB limit, 20 MiB fragments) are
  // shrunk on both sides so a "large" file is 10 KiB: the RULES are what is
  // under test, and the fake enforces them (unit multiple, order, no auth).
  const small = () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    // harness returns the same graph it is given, so return it directly (a
    // `{ graph, ...harness(graph) }` spread would duplicate the `graph` key: TS2783).
    return harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB });
  };
  test('a 10 KiB file goes as 4 KiB + 4 KiB + 2 KiB fragments, in order, no Authorization, progress after each; the file lands byte-exact', async () => {
    const { graph, store } = small();
    const bytes = Uint8Array.from({ length: 10 * KiB }, (_, i) => (i * 7) % 256);
    const seen: number[] = [];
    await store.putFromFile('blobs/big', await staged(bytes), 'application/octet-stream', (sent) => seen.push(sent));
    expect(uploadCalls(graph).map((c) => c.headers['content-range'])).toEqual(['bytes 0-4095/10240', 'bytes 4096-8191/10240', 'bytes 8192-10239/10240']);
    expect(uploadCalls(graph).every((c) => c.headers.authorization === undefined)).toBe(true);
    expect(seen).toEqual([4096, 8192, 10240]);
    expect(Array.from(graph.fileBytes(graph.ids.blobsFolderId, 'big')!)).toEqual(Array.from(bytes));
  });
  test('the native upload port is NOT used for fragments (fetch only), and a file exactly at the limit takes the fragment path', async () => {
    const { graph } = small();
    let nativeCalls = 0;
    const s2 = createOneDriveCloudObjectStore(graph.ids, { fetchImpl: graph.fetch, uploadFile: async (r) => { nativeCalls += 1; return graph.uploadFile(r); }, tokens: harness(graph).tokens, statFile: createNodeFileStat(), readFragments: createNodeFragmentReader(), singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB });
    await s2.putFromFile('blobs/edge', await staged(new Uint8Array(8 * KiB)), 'application/octet-stream');
    expect(nativeCalls).toBe(0);
    expect(uploadCalls(graph)).toHaveLength(2);
  });
  test('a rejected middle fragment is classified (server/unknown) and the upload stops there', async () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    let puts = 0;
    const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, fetchImpl: async (url: string, init?: RequestInit) => { if (url.startsWith('https://fake.up.1drv.com') && (puts += 1) === 2) return new Response(JSON.stringify({ error: { code: 'generalException' } }), { status: 500 }); return graph.fetch(url, init); } });
    await expect(store.putFromFile('blobs/big', await staged(new Uint8Array(10 * KiB)), 'application/octet-stream')).rejects.toMatchObject({ status: 500, category: 'server', outcomeKnown: false });
    expect(puts).toBe(2);
  });
  test('a 404 on a fragment PUT is an expired/cancelled session (server, retryable), and the upload stops there', async () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    let puts = 0;
    const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, fetchImpl: async (url: string, init?: RequestInit) => { if (url.startsWith('https://fake.up.1drv.com') && (puts += 1) === 1) return new Response(JSON.stringify({ error: { code: 'uploadSessionNotFound' } }), { status: 404 }); return graph.fetch(url, init); } });
    await expect(store.putFromFile('blobs/big', await staged(new Uint8Array(10 * KiB)), 'application/octet-stream')).rejects.toMatchObject({ status: 404, category: 'server', outcomeKnown: false, message: expect.stringContaining('expired or was cancelled') });
    expect(puts).toBe(1);
  });
  test('a non-final fragment answered 200/201 is a contract violation (server), and the upload stops after exactly one PUT', async () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    let puts = 0;
    const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, fetchImpl: async (url: string, init?: RequestInit) => { if (url.startsWith('https://fake.up.1drv.com') && (puts += 1) === 1) return new Response(JSON.stringify({ id: 'F-early', name: 'big', size: 4096 }), { status: 201 }); return graph.fetch(url, init); } });
    await expect(store.putFromFile('blobs/big', await staged(new Uint8Array(10 * KiB)), 'application/octet-stream')).rejects.toMatchObject({ category: 'server', outcomeKnown: false, message: expect.stringContaining('committed early') });
    expect(puts).toBe(1);
  });
  test('a fragment that takes longer than fragmentMs is aborted as network / unknown', async () => {
    jest.useFakeTimers();
    try {
      const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
      let aborted = false;
      const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, fragmentMs: 2000, fetchImpl: (url: string, init?: RequestInit) => url.startsWith('https://fake.up.1drv.com') ? new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); })) : graph.fetch(url, init) });
      const p = store.putFromFile('blobs/big', await staged(new Uint8Array(10 * KiB)), 'application/octet-stream');
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('timed out') });
      await jest.advanceTimersByTimeAsync(2000);
      await assertion;
      expect(aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
  test('fragmentMs is a PER-FRAGMENT deadline, not cumulative: three fragments at 600 ms each resolve under a 1000 ms budget', async () => {
    jest.useFakeTimers();
    try {
      const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
      const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
        if (!url.startsWith('https://fake.up.1drv.com')) return graph.fetch(url, init);
        return new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => { graph.fetch(url, init).then(resolve, reject); }, 600);
          init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        });
      };
      const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, fragmentMs: 1000, fetchImpl });
      const p = store.putFromFile('blobs/big', await staged(new Uint8Array(10 * KiB)), 'application/octet-stream');
      for (let i = 0; i < 3; i += 1) await jest.advanceTimersByTimeAsync(600);
      await expect(p).resolves.toBeUndefined();
    } finally { jest.useRealTimers(); }
  });
  test('a readFragments port that yields fewer bytes than statFile reported is a client error naming both counts', async () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    async function* short(): AsyncIterable<Uint8Array> { yield new Uint8Array(4 * KiB); }
    const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, statFile: async () => 10 * KiB, readFragments: short });
    await expect(store.putFromFile('blobs/big', 'file:///unused', 'application/octet-stream')).rejects.toMatchObject({ category: 'client', message: expect.stringContaining('yielded 4096 bytes, expected 10240') });
  });
  test('a fragment fetch that throws (not aborts) is network, not an unhandled rejection', async () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => { if (url.startsWith('https://fake.up.1drv.com')) throw new TypeError('network down'); return graph.fetch(url, init); };
    const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, fetchImpl });
    await expect(store.putFromFile('blobs/big', await staged(new Uint8Array(10 * KiB)), 'application/octet-stream')).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('failed before a response') });
  });
  test('a readFragments port that yields more bytes than statFile reported stops at the committed size instead of PUTting the extra', async () => {
    const graph = createFakeGraph({ fragmentUnit: 1 * KiB, singlePutLimit: 8 * KiB });
    async function* grown(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(4 * KiB);
      yield new Uint8Array(4 * KiB);
      yield new Uint8Array(4 * KiB); // the file grew after statFile(): must never be sent
    }
    const { store } = harness(graph, { singlePutLimit: 8 * KiB, fragmentBytes: 4 * KiB, statFile: async () => 8 * KiB, readFragments: grown });
    await expect(store.putFromFile('blobs/big', 'file:///unused', 'application/octet-stream')).resolves.toBeUndefined();
    expect(uploadCalls(graph)).toHaveLength(2);
    expect(graph.fileBytes(graph.ids.blobsFolderId, 'big')!.byteLength).toBe(8 * KiB);
  });
});

describe('a 200 with an unparseable body is a network error, not a raw SyntaxError', () => {
  // The fake's reply() JSON-encodes bodies, so a raw non-JSON 200 needs a wrapping fetchImpl.
  const captive = (graph: FakeGraph, match: (url: string) => boolean) => async (url: string, init?: RequestInit) => (match(url) ? new Response('<html>captive portal</html>', { status: 200 }) : graph.fetch(url, init));
  test('list: a non-JSON children page → network / outcome known (a read applied nothing)', async () => {
    const graph = createFakeGraph();
    const { store } = harness(graph, { fetchImpl: captive(graph, (u) => u.includes('/children')) });
    await expect(store.list('state')).rejects.toMatchObject({ status: 200, category: 'network', outcomeKnown: true, message: expect.stringContaining('could not be parsed') });
  });
  test('quota: a non-JSON drive answer → network / outcome known', async () => {
    const graph = createFakeGraph();
    const { store } = harness(graph, { fetchImpl: captive(graph, (u) => u.includes('/me/drive?')) });
    await expect(store.quota()).rejects.toMatchObject({ status: 200, category: 'network', outcomeKnown: true });
  });
  test('createUploadSession: a non-JSON session answer → network / outcome UNKNOWN (a write may have applied)', async () => {
    const graph = createFakeGraph();
    const { store } = harness(graph, { fetchImpl: captive(graph, (u) => u.endsWith('/createUploadSession')) });
    await expect(store.putFromFile('blobs/g', await staged(new Uint8Array(5)), 'application/octet-stream')).rejects.toMatchObject({ status: 200, category: 'network', outcomeKnown: false, message: expect.stringContaining('could not be parsed') });
  });
});

describe('@odata.nextLink is followed only on graph.microsoft.com and only up to a page bound', () => {
  test('a nextLink rewritten to another origin is refused as client, and no request reaches that origin', async () => {
    const graph = createFakeGraph();
    let evilHits = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://evil.example')) { evilHits += 1; return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
      const res = await graph.fetch(url, init);
      if (!url.includes('/children')) return res;
      const body = (await res.clone().json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, '@odata.nextLink': 'https://evil.example/v1.0/steal' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    await expect(store.list('state')).rejects.toMatchObject({ category: 'client', message: expect.stringContaining('graph.microsoft.com') });
    expect(evilHits).toBe(0);
  });
  test('an unparseable nextLink (relative, or otherwise not an absolute URL) is refused as client, not a raw TypeError', async () => {
    const graph = createFakeGraph();
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const res = await graph.fetch(url, init);
      if (!url.includes('/children')) return res;
      const body = (await res.clone().json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, '@odata.nextLink': 'nextpage?$skip=1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    await expect(store.list('state')).rejects.toMatchObject({ category: 'client', message: expect.stringContaining('unusable nextLink') });
  });
  test('a self-pointing nextLink stops after the 1000-page bound instead of looping forever', async () => {
    const graph = createFakeGraph();
    const selfUrl = `${GRAPH_BASE}/me/drive/items/${graph.ids.stateFolderId}/children?loop=1`;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (!url.includes('/children')) return graph.fetch(url, init);
      const real = await (await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.stateFolderId}/children`, init)).json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...real, value: [], '@odata.nextLink': selfUrl }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    await expect(store.list('state')).rejects.toMatchObject({ category: 'server', message: expect.stringContaining('1000 pages') });
  });
});

describe('read-shape and control details', () => {
  test('a listing entry without a size maps to size null', async () => {
    const graph = createFakeGraph();
    const h = { authorization: `Bearer ${graph.issueAccessToken()}` };
    await graph.fetch(`${GRAPH_BASE}/me/drive/items/${graph.ids.stateFolderId}:/a.json:/content`, { method: 'PUT', headers: h, body: new Uint8Array(3) });
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const res = await graph.fetch(url, init);
      if (!url.includes('/children')) return res;
      const body = (await res.clone().json()) as { value?: Record<string, unknown>[] };
      const value = (body.value ?? []).map((e) => { const clone = { ...e }; delete clone.size; return clone; });
      return new Response(JSON.stringify({ ...body, value }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { store } = harness(graph, { fetchImpl });
    expect(await store.list('state')).toEqual([{ name: 'a.json', size: null }]);
  });
  test('quota without a total → totalBytes null', async () => {
    const graph = createFakeGraph();
    const fetchImpl = async (url: string, init?: RequestInit) => (url.includes('/me/drive?') ? new Response(JSON.stringify({ quota: { used: 42 } }), { status: 200, headers: { 'content-type': 'application/json' } }) : graph.fetch(url, init));
    const { store } = harness(graph, { fetchImpl });
    expect(await store.quota()).toEqual({ usedBytes: 42, totalBytes: null });
  });
  test('locate rejects a folder with no name (state/, blobs/) and the empty path', async () => {
    const { store } = harness();
    for (const bad of ['state/', 'blobs/', '']) {
      await expect(store.delete(bad)).rejects.toMatchObject({ category: 'client' });
    }
  });
  test('ensureLayout stops at the FIRST missing id (no further GETs)', async () => {
    const graph = createFakeGraph();
    const { tokens } = harness(graph);
    const broken = createOneDriveCloudObjectStore({ ...graph.ids, rootFolderId: 'F-gone' }, { fetchImpl: graph.fetch, uploadFile: graph.uploadFile, statFile: createNodeFileStat(), readFragments: createNodeFragmentReader(), tokens });
    await expect(broken.ensureLayout()).rejects.toMatchObject({ status: 404, category: 'client' });
    expect(graphCalls(graph).filter((c) => c.includes('?$select=id')).length).toBe(1);
  });
  test('the 401 retry uses a fresh AbortController (a new signal reaches fetch on the second attempt)', async () => {
    const graph = createFakeGraph();
    const signals = new Set<AbortSignal | undefined>();
    const fetchImpl = async (url: string, init?: RequestInit) => { if (url.startsWith(GRAPH_BASE)) signals.add(init?.signal ?? undefined); return graph.fetch(url, init); };
    const { store } = harness(graph, { fetchImpl });
    graph.failNext(401, { error: { code: 'InvalidAuthenticationToken' } });
    expect(await store.get('vault-meta.json')).toBeNull();
    expect(signals.size).toBe(2);
  });
});
