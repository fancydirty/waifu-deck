import { sha256 } from '@noble/hashes/sha2.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { base64Url, MICROSOFT_TOKEN_URL } from '@/features/cloud-store/microsoft-oauth';

import { createFakeGraph, GRAPH_ORIGIN } from './fake-graph-server';

const KiB = 1024;
const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

describe('token endpoint', () => {
  test('refresh rotates: the old refresh token dies, the new one works; a revoked one is invalid_grant', async () => {
    const g = createFakeGraph();
    const rt1 = g.issueRefreshToken();
    const a = await g.fetch(MICROSOFT_TOKEN_URL, form({ grant_type: 'refresh_token', refresh_token: rt1, client_id: 'x', scope: 's' }));
    const setA = await json(a);
    expect(a.status).toBe(200);
    expect(setA.refresh_token).not.toBe(rt1);
    const again = await g.fetch(MICROSOFT_TOKEN_URL, form({ grant_type: 'refresh_token', refresh_token: rt1, client_id: 'x', scope: 's' }));
    expect(again.status).toBe(400);
    expect((await json(again)).error).toBe('invalid_grant');
    g.revokeRefreshTokens();
    const revoked = await g.fetch(MICROSOFT_TOKEN_URL, form({ grant_type: 'refresh_token', refresh_token: setA.refresh_token as string, client_id: 'x', scope: 's' }));
    expect((await json(revoked)).error).toBe('invalid_grant');
  });
  test('authorization_code exchange needs the verifier whose S256 hash was authorized', async () => {
    const g = createFakeGraph();
    const verifier = 'v'.repeat(43);
    const code = g.authCode(base64Url(sha256(new TextEncoder().encode(verifier))));
    const bad = await g.fetch(MICROSOFT_TOKEN_URL, form({ grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: 'x', redirect_uri: 'r', scope: 's' }));
    expect(bad.status).toBe(400);
    const good = await g.fetch(MICROSOFT_TOKEN_URL, form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'x', redirect_uri: 'r', scope: 's' }));
    expect(good.status).toBe(200);
    expect(typeof (await json(good)).access_token).toBe('string');
  });
});

describe('Graph rules', () => {
  const bearer = (g: ReturnType<typeof createFakeGraph>, ttl?: number) => ({ authorization: `Bearer ${g.issueAccessToken(ttl)}` });
  test('every Graph request needs a live bearer: none → 401, expired → 401', async () => {
    let now = 0;
    const g = createFakeGraph({ now: () => now });
    expect((await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/special/approot`)).status).toBe(401);
    const h = bearer(g, 1000);
    expect((await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/special/approot`, { headers: h })).status).toBe(200);
    now = 1001;
    expect((await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/special/approot`, { headers: h })).status).toBe(401);
  });
  test('approot is pre-created with state/blobs children; creating a duplicate child is 409 nameAlreadyExists', async () => {
    const g = createFakeGraph();
    const h = bearer(g);
    const root = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/special/approot`, { headers: h }));
    expect(root.id).toBe(g.ids.rootFolderId);
    const dup = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.rootFolderId}/children`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'state', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
    expect(dup.status).toBe(409);
    expect(((await json(dup)).error as { code: string }).code).toBe('nameAlreadyExists');
  });
  test('children listing pages at pageSize with @odata.nextLink; files carry size, folders carry `folder`', async () => {
    const g = createFakeGraph({ pageSize: 2 });
    const h = bearer(g);
    for (const n of ['a', 'b', 'c']) await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.stateFolderId}:/${n}.json:/content`, { method: 'PUT', headers: h, body: new Uint8Array([1]) });
    const p1 = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.stateFolderId}/children?$select=id,name,size,folder&$top=1000`, { headers: h }));
    expect((p1.value as unknown[]).length).toBe(2);
    expect(typeof p1['@odata.nextLink']).toBe('string');
    const p2 = await json(await g.fetch(p1['@odata.nextLink'] as string, { headers: h }));
    expect((p2.value as { name: string; size: number }[]).map((v) => v.name)).toEqual(['c.json']);
    expect(p2['@odata.nextLink']).toBeUndefined();
    const root = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.rootFolderId}/children`, { headers: h }));
    expect((root.value as { name: string; folder?: object }[]).filter((v) => v.folder).map((v) => v.name).sort()).toEqual(['blobs', 'state']);
  });
  test('DELETE by id removes the item; a second DELETE is 404; other methods are 405', async () => {
    const g = createFakeGraph();
    const h = bearer(g);
    const created = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/gone:/content`, { method: 'PUT', headers: h, body: new Uint8Array([1, 2, 3]) }));
    const id = created.id as string;
    expect(g.fileNames(g.ids.blobsFolderId)).toEqual(['gone']);
    const del = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${id}`, { method: 'DELETE', headers: h });
    expect(del.status).toBe(204);
    expect(g.fileNames(g.ids.blobsFolderId)).toEqual([]);
    const again = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${id}`, { method: 'DELETE', headers: h });
    expect(again.status).toBe(404);
    expect(((await json(again)).error as { code: string }).code).toBe('itemNotFound');
    const patch = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}`, { method: 'PATCH', headers: h });
    expect(patch.status).toBe(405);
  });
  test('DELETE on a folder recursively deletes its descendants (a non-recursive deleteTree would leave the child behind)', async () => {
    const g = createFakeGraph();
    const h = bearer(g);
    const sub = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}/children`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'sub', folder: {} }) }));
    const subId = sub.id as string;
    await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${subId}:/child.bin:/content`, { method: 'PUT', headers: h, body: new Uint8Array([1, 2, 3, 4]) });
    expect(g.usedBytes()).toBe(4);
    const del = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${subId}`, { method: 'DELETE', headers: h });
    expect(del.status).toBe(204);
    expect(g.fileBytes(subId, 'child.bin')).toBeNull();
    expect(g.usedBytes()).toBe(0);
  });
  test('upload session: fragments must be in order, multiples of the unit unless final, under the single-PUT limit, and NEVER carry Authorization', async () => {
    const g = createFakeGraph({ fragmentUnit: 4 * KiB, singlePutLimit: 32 * KiB });
    const h = bearer(g);
    const size = 10 * KiB;
    const s = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/big:/createUploadSession`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' }, fileSize: size }) }));
    const url = s.uploadUrl as string;
    const put = (start: number, end: number, headers: Record<string, string> = {}) => g.fetch(url, { method: 'PUT', headers: { 'content-range': `bytes ${start}-${end}/${size}`, ...headers }, body: new Uint8Array(end - start + 1).fill(7) });
    expect((await put(0, 4 * KiB - 1, h)).status).toBe(401);
    const notMultiple = await put(0, 3 * KiB - 1);
    expect(notMultiple.status).toBe(400);
    expect(((await json(notMultiple)).error as { code: string }).code).toBe('fragmentNotMultipleOf320KiB');
    expect((await put(4 * KiB, 8 * KiB - 1)).status).toBe(416);
    const mid = await put(0, 4 * KiB - 1);
    expect(mid.status).toBe(202);
    expect((await json(mid)).nextExpectedRanges).toEqual([`${4 * KiB}-`]);
    expect((await put(4 * KiB, 8 * KiB - 1)).status).toBe(202);
    const last = await put(8 * KiB, size - 1);
    expect(last.status).toBe(201);
    expect(g.fileBytes(g.ids.blobsFolderId, 'big')?.byteLength).toBe(size);
    expect(g.sessions()).toBe(0);
    const s2 = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/toobig:/createUploadSession`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ item: {}, fileSize: 40 * KiB }) }));
    const tooBig = await g.fetch(s2.uploadUrl as string, { method: 'PUT', headers: { 'content-range': `bytes 0-${32 * KiB - 1}/${40 * KiB}` }, body: new Uint8Array(32 * KiB).fill(7) });
    expect(tooBig.status).toBe(400);
    expect(((await json(tooBig)).error as { code: string }).code).toBe('fragmentTooLarge');
  });
  test('a session whose fileSize exceeds the remaining quota is refused with 507 before any byte moves', async () => {
    const g = createFakeGraph({ quotaTotal: 1024 });
    const r = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/big:/createUploadSession`, { method: 'POST', headers: { ...bearer(g), 'content-type': 'application/json' }, body: JSON.stringify({ item: {}, fileSize: 2048 }) });
    expect(r.status).toBe(507);
    expect(g.sessions()).toBe(0);
  });
  test('quota on overwrite is computed against the bytes the old same-name file frees, not the old file plus the new one', async () => {
    const g = createFakeGraph({ quotaTotal: 1024 });
    const h = bearer(g);
    await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/big:/content`, { method: 'PUT', headers: h, body: new Uint8Array(1000) });
    const overwritePut = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/big:/content`, { method: 'PUT', headers: h, body: new Uint8Array(100) });
    expect(overwritePut.status).toBe(200);
    expect(g.usedBytes()).toBe(100);
    const session = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/big:/createUploadSession`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ item: {}, fileSize: 1000 }) });
    expect(session.status).toBe(200);
  });
  test('failNext also overrides the upload host, one-shot', async () => {
    const g = createFakeGraph({ fragmentUnit: 4 * KiB, singlePutLimit: 32 * KiB });
    const h = bearer(g);
    const size = 8 * KiB;
    const s = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/staged:/createUploadSession`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ item: {}, fileSize: size }) }));
    const url = s.uploadUrl as string;
    const put = (start: number, end: number) => g.fetch(url, { method: 'PUT', headers: { 'content-range': `bytes ${start}-${end}/${size}` }, body: new Uint8Array(end - start + 1).fill(1) });
    g.failNext(500, { error: { code: 'generalException', message: 'boom' } }, {}, /1drv/);
    const first = await put(0, 4 * KiB - 1);
    expect(first.status).toBe(500);
    const retry = await put(0, 4 * KiB - 1);
    expect(retry.status).toBe(202);
  });
  test('content GET answers the bytes with content-length as a followed redirect; a missing item is 404 itemNotFound; failNext overrides once', async () => {
    const g = createFakeGraph();
    const h = bearer(g);
    await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.rootFolderId}:/vault-meta.json:/content`, { method: 'PUT', headers: h, body: new Uint8Array([1, 2, 3]) });
    const got = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.rootFolderId}:/vault-meta.json:/content`, { headers: h });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-length')).toBe('3');
    expect(got.redirected).toBe(true);
    const missing = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.rootFolderId}:/nope:/content`, { headers: h });
    expect(missing.status).toBe(404);
    g.failNext(429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '7' });
    const throttled = await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive?$select=quota`, { headers: h });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('7');
    expect((await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive?$select=quota`, { headers: h })).status).toBe(200);
  });
  test('/me mail and userPrincipalName are the single accountEmail value', async () => {
    const g = createFakeGraph();
    const me = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me`, { headers: bearer(g) }));
    expect(me.mail).toBe(g.accountEmail);
    expect(me.userPrincipalName).toBe(g.accountEmail);
  });
  test('quota body shape is exactly used/total/remaining/deleted/state', async () => {
    const g = createFakeGraph({ quotaTotal: 1024 });
    await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/x:/content`, { method: 'PUT', headers: bearer(g), body: new Uint8Array(100) });
    const drive = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive`, { headers: bearer(g) }));
    expect(drive.quota).toEqual({ used: 100, total: 1024, remaining: 924, deleted: 0, state: 'normal' });
  });
  test('uploadFile port reads the staged file and PUTs it to the given url with the given headers, reporting progress', async () => {
    const g = createFakeGraph();
    const { writeFileSync, mkdtempSync } = jest.requireActual('node:fs') as typeof import('node:fs');
    const { tmpdir } = jest.requireActual('node:os') as typeof import('node:os');
    const { pathToFileURL } = jest.requireActual('node:url') as typeof import('node:url');
    const dir = mkdtempSync(`${tmpdir()}/fake-graph-`);
    writeFileSync(`${dir}/f`, new Uint8Array(5));
    const s = await json(await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/f:/createUploadSession`, { method: 'POST', headers: { ...bearer(g), 'content-type': 'application/json' }, body: JSON.stringify({ item: {}, fileSize: 5 }) }));
    const seen: number[] = [];
    const r = await g.uploadFile({ url: s.uploadUrl as string, fileUri: pathToFileURL(`${dir}/f`).href, headers: { 'content-range': 'bytes 0-4/5' }, onProgress: (p) => seen.push(p.bytesSent) });
    expect(r.status).toBe(201);
    expect(seen[seen.length - 1]).toBe(5);
    expect(r.headers['content-type']).toBe('application/json');
    await expect(g.uploadFile({ url: s.uploadUrl as string, fileUri: 'file:///definitely/missing', headers: {} })).rejects.toThrow(/ENOENT/);
    await expect(g.uploadFile({ url: s.uploadUrl as string, fileUri: pathToFileURL(dir).href, headers: {} })).rejects.toThrow(/^EISDIR/);
    const seen2: number[] = [];
    const rejected = await g.uploadFile({ url: s.uploadUrl as string, fileUri: pathToFileURL(`${dir}/f`).href, headers: { 'content-range': 'bytes 0-4/5' }, onProgress: (p) => seen2.push(p.bytesSent) });
    expect(rejected.status).toBe(404);
    expect(seen2).toEqual([0]);
  });

  test('downloadFile port writes 2xx bytes exclusively and returns lower-case headers/redirect metadata; a 404 leaves no file', async () => {
    const g = createFakeGraph();
    const h = bearer(g);
    await g.fetch(`${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/f:/content`, { method: 'PUT', headers: h, body: new Uint8Array([7, 8, 9]) });
    const dir = await mkdtemp(join(tmpdir(), 'fake-graph-download-'));
    try {
      const target = pathToFileURL(join(dir, 'out')).href;
      const seen: number[] = [];
      const result = await g.downloadFile({ url: `${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/f:/content`, fileUri: target, headers: h, maxBytes: 64 * 1024, onProgress: (p) => seen.push(p.bytesReceived) });
      expect(result).toMatchObject({ status: 200, redirected: true, bytesWritten: 3 });
      expect(result.headers['content-length']).toBe('3');
      expect(Array.from(new Uint8Array(await readFile(new URL(target))))).toEqual([7, 8, 9]);
      expect(seen.at(-1)).toBe(3);

      const missing = pathToFileURL(join(dir, 'missing')).href;
      const absent = await g.downloadFile({ url: `${GRAPH_ORIGIN}/v1.0/me/drive/items/${g.ids.blobsFolderId}:/gone:/content`, fileUri: missing, headers: h, maxBytes: 64 * 1024 });
      expect(absent).toMatchObject({ status: 404, bytesWritten: 0, errorBody: expect.stringContaining('itemNotFound') });
      await expect(stat(new URL(missing))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
