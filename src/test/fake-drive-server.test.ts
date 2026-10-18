import { createFakeDrive, DRIVE_ABOUT_URL, DRIVE_FILES_URL, DRIVE_UPLOAD_URL, type FakeDrive } from './fake-drive-server';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const enc = (s: string) => new TextEncoder().encode(s);
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const withBearer = (drive: FakeDrive): RequestInit => ({ headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
/** The HTTP status plus Drive's `error` object, so an assertion pins both at once. */
const refusal = async (res: Response) => ({ status: res.status, error: (await json(res)).error });
/** The double's own loud refusal of something real Drive may do but the double does not model. */
const notModelledAnswer = { status: 400, error: { code: 400, message: expect.stringMatching(/^fake Drive does not model /) } };
const badRequest = { status: 400, error: { code: 400, errors: [{ reason: 'badRequest' }] } };
/** A multipart/related body from [content-type, content] parts, then `end` (the close delimiter unless a test says otherwise). */
const related = (b: string, parts: readonly (readonly [string, string])[], end = `\r\n--${b}--`) =>
  `--${b}${parts.map(([type, content]) => `\r\nContent-Type: ${type}\r\n\r\n${content}`).join(`\r\n--${b}`)}${end}`;
const postMultipart = async (drive: FakeDrive, contentType: string, body: string) =>
  refusal(await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, { method: 'POST', headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': contentType }, body }));
const noteMeta = (drive: FakeDrive) => JSON.stringify({ name: 'n.json', parents: [drive.ids.stateFolderId] });

describe('fake Drive', () => {
  test('emptyLayout models metadata folder POST and permanent folder deletion', async () => {
    const drive = createFakeDrive({ emptyLayout: true });
    const rootRes = await drive.fetch(DRIVE_FILES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Waifu Deck', mimeType: 'application/vnd.google-apps.folder', appProperties: { waifuDeck: 'root' } }),
    });
    expect(rootRes.status).toBe(200);
    const root = (await json(rootRes)).id as string;
    const childRes = await drive.fetch(DRIVE_FILES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'state', mimeType: 'application/vnd.google-apps.folder', parents: [root] }),
    });
    const child = (await json(childRes)).id as string;
    await drive.putMultipart(child, 'note', enc('x'));
    await drive.fetch(`${DRIVE_FILES_URL}/${root}`, { method: 'DELETE', headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
    expect(drive.fileById(root)).toBeNull();
    expect(drive.fileById(child)).toBeNull();
  });

  test('an empty-string parent is a missing parent, never My Drive root; emptyLayout has no ids to hand out', async () => {
    const drive = createFakeDrive({ emptyLayout: true });
    const res = await drive.fetch(DRIVE_FILES_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'state', mimeType: 'application/vnd.google-apps.folder', parents: [''] }),
    });
    expect(await refusal(res)).toMatchObject({ status: 404, error: { errors: [{ reason: 'notFound' }] } });
    expect(drive.fileById('')).toBeNull();
    // A store built from ids that do not exist yet must fail at the test, not write into ''.
    expect(() => drive.ids).toThrow(/emptyLayout/);
  });

  test('metadata-only file creates are refused unless the folder mime type is explicit', async () => {
    const drive = createFakeDrive();
    for (const body of [{ name: 'file.bin' }, { name: 'file.bin', mimeType: 'application/octet-stream' }]) {
      const res = await drive.fetch(DRIVE_FILES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const answer = await refusal(res);
      expect(answer).toMatchObject(notModelledAnswer);
      expect(answer.error).toMatchObject({ errors: [{ reason: 'badRequest' }] });
    }
  });

  test('every Drive request needs a live bearer; the token endpoint issues one and revocation makes refresh answer invalid_grant', async () => {
    const drive = createFakeDrive();
    const anon = await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, {});
    // Measured 2026-09-22 (p12d-route-probe log, "Task 4 fact check"): files.list with no credential is 403 forbidden, not 401.
    expect(await refusal(anon)).toMatchObject({ status: 403, error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } });
    const form = new URLSearchParams({ client_id: 'c', grant_type: 'refresh_token', refresh_token: drive.refreshToken });
    const ok = await json(await drive.fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: form.toString() }));
    expect(typeof ok.access_token).toBe('string');
    // 补裁 3: the refresh answer must NOT carry a refresh_token. If the double
    // returned one, Task 3's "no write-back" design would never be exercised.
    expect(ok.refresh_token).toBeUndefined();
    drive.revoke();
    const dead = await drive.fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: form.toString() });
    expect(dead.status).toBe(400);
    expect((await json(dead)).error).toBe('invalid_grant');
  });

  test('an expired access token is 401 with Drive\'s envelope, not a bare status', async () => {
    let clock = 0;
    const drive = createFakeDrive({ now: () => clock });
    const token = drive.issueAccessToken(1_000);
    clock = 1_001;
    const res = await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toMatchObject({ code: 401 });
  });

  test('a bogus bearer (measured 2026-09-22) and a revoked one (modelled the same way) are 401 authError / UNAUTHENTICATED on files and about', async () => {
    const drive = createFakeDrive();
    const live = drive.issueAccessToken();
    const authError = { status: 401, error: { code: 401, status: 'UNAUTHENTICATED', errors: [{ reason: 'authError' }] } };
    for (const url of [`${DRIVE_FILES_URL}?pageSize=1`, `${DRIVE_ABOUT_URL}?fields=user`]) {
      expect(await refusal(await drive.fetch(url, { headers: { authorization: 'Bearer ya29.bogus' } }))).toMatchObject(authError);
    }
    drive.revoke();
    expect(await refusal(await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, { headers: { authorization: `Bearer ${live}` } }))).toMatchObject(authError);
  });

  test('with no credential only the read methods say 403 forbidden (media in the API-key wording); about, delete and uploads say 401 required (measured 2026-09-22)', async () => {
    const drive = createFakeDrive();
    const id = await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('a'));
    expect(await refusal(await drive.fetch(`${DRIVE_FILES_URL}/${id}?fields=id`))).toMatchObject({ status: 403, error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } });
    const media = await refusal(await drive.fetch(`${DRIVE_FILES_URL}/${id}?alt=media`));
    expect(media).toMatchObject({ status: 403, error: { message: 'The request is missing a valid API key.', errors: [{ reason: 'forbidden' }] } });
    expect(media.error).not.toHaveProperty('status');
    const required = { status: 401, error: { status: 'UNAUTHENTICATED', errors: [{ reason: 'required' }] } };
    for (const [url, method] of [[`${DRIVE_ABOUT_URL}?fields=user`, 'GET'], [`${DRIVE_FILES_URL}/${id}`, 'DELETE'], [`${DRIVE_UPLOAD_URL}?uploadType=multipart`, 'POST'], [`${DRIVE_UPLOAD_URL}?uploadType=resumable`, 'POST']] as const) {
      expect(await refusal(await drive.fetch(url, { method }))).toMatchObject(required);
    }
    // Refused before anything happened: the unauthenticated DELETE left the file alone.
    expect(drive.fileById(id)).not.toBeNull();
  });

  test('multipart create parses BOTH parts and stores the bytes under the named parent', async () => {
    const drive = createFakeDrive();
    const id = await drive.putMultipart(drive.ids.stateFolderId, 'n1.json', enc('{"a":1}'));
    expect(drive.fileNames(drive.ids.stateFolderId)).toEqual(['n1.json']);
    expect(new TextDecoder().decode(drive.fileBytes(drive.ids.stateFolderId, 'n1.json')!)).toBe('{"a":1}');
    expect(drive.fileById(id)!.name).toBe('n1.json');
  });

  test('a malformed multipart body is 400 badRequest (so the adapter cannot pass a body the real API would reject)', async () => {
    const drive = createFakeDrive();
    const res = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart`, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'multipart/related; boundary=bnd' },
      body: 'not multipart at all',
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatchObject({ code: 400 });
  });

  test('resumable: session init answers 200 + Location and NO body; the content PUT commits at exactly the announced length', async () => {
    const drive = createFakeDrive();
    const init = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': '6' },
      body: JSON.stringify({ name: 'b1', parents: [drive.ids.blobsFolderId] }),
    });
    expect(init.status).toBe(200);
    expect((await init.text())).toBe('');
    const session = init.headers.get('location')!;
    expect(session).toContain('upload_id=');
    // The pre-authorized session URL must be usable WITHOUT a bearer — same
    // property Graph's upload host has, and the adapter relies on it.
    const short = await drive.fetch(session, { method: 'PUT', headers: { 'content-length': '3' }, body: enc('abc') });
    expect(short.status).toBe(308);
    expect(short.headers.get('range')).toBe('bytes=0-2');
    const done = await drive.fetch(session, { method: 'PUT', headers: { 'content-length': '6' }, body: enc('abcdef') });
    expect(done.status).toBe(200);
    expect(new TextDecoder().decode(drive.fileBytes(drive.ids.blobsFolderId, 'b1')!)).toBe('abcdef');
  });

  test('a session that has been consumed or never existed is 404 (expired session)', async () => {
    const drive = createFakeDrive();
    const res = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&upload_id=nope`, { method: 'PUT', headers: { 'content-length': '1' }, body: enc('x') });
    expect(res.status).toBe(404);
  });

  test('an unknown upload session answers as Drive does: 404, text/plain, "Not Found" (measured 2026-09-22)', async () => {
    const drive = createFakeDrive();
    const res = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&upload_id=nope`, { method: 'PUT', headers: { 'content-length': '1' }, body: enc('x') });
    expect({ status: res.status, type: res.headers.get('content-type'), body: await res.text() }).toEqual({ status: 404, type: 'text/plain; charset=utf-8', body: 'Not Found' });
  });

  test('q is really parsed: parents, trashed, name, folder mimeType and appProperties all filter', async () => {
    const drive = createFakeDrive();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('a'));
    await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('b'));
    const list = async (q: string) => ((await json(await drive.fetch(
      `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,size,createdTime)&pageSize=1000`,
      { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } },
    ))).files as { name: string; size?: string }[]);
    expect((await list(`'${drive.ids.stateFolderId}' in parents and trashed = false`)).map((f) => f.name)).toEqual(['a.json']);
    expect(await list(`'${drive.ids.blobsFolderId}' in parents and trashed = false and name = 'zzz'`)).toEqual([]);
    const roots = await list(`name = 'Waifu Deck' and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='waifuDeck' and value='root' } and trashed = false`);
    expect(roots.map((f) => f.name)).toEqual(['Waifu Deck']);
    // 补裁 5: File.size is a STRING int64, and folders have no size field at all.
    expect((await list(`'${drive.ids.stateFolderId}' in parents and trashed = false`))[0]!.size).toBe('1');
    expect(roots[0]!.size).toBeUndefined();
  });

  test('paging: pageSize is honoured and nextPageToken walks every row exactly once', async () => {
    const drive = createFakeDrive();
    for (let i = 0; i < 5; i += 1) await drive.putMultipart(drive.ids.stateFolderId, `n${i}.json`, enc('x'));
    const names: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const body = await json(await drive.fetch(
        `${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${drive.ids.stateFolderId}' in parents and trashed = false`)}&fields=nextPageToken,files(id,name,size)&pageSize=2${token === undefined ? '' : `&pageToken=${token}`}`,
        { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } },
      ));
      names.push(...(body.files as { name: string }[]).map((f) => f.name));
      token = body.nextPageToken as string | undefined;
      pages += 1;
    } while (token !== undefined);
    // 5 rows at pageSize 2 → pages of 2, 2, 1 = 3 requests.
    expect(pages).toBe(3);
    expect(names.sort()).toEqual(['n0.json', 'n1.json', 'n2.json', 'n3.json', 'n4.json']);
  });

  test('two files may share a name, with distinct createdTime, and delete removes exactly one id (§3.4)', async () => {
    let clock = 1_700_000_000_000;
    const drive = createFakeDrive({ now: () => (clock += 1_000) });
    const first = await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('1'));
    const second = await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('2'));
    expect(drive.fileNames(drive.ids.rootFolderId).filter((n) => n === 'vault-meta.json')).toHaveLength(2);
    expect(new Date(drive.fileById(first)!.createdTime).getTime()).toBeLessThan(new Date(drive.fileById(second)!.createdTime).getTime());
    const del = await drive.fetch(`${DRIVE_FILES_URL}/${second}`, { method: 'DELETE', headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
    expect(del.status).toBe(204);
    expect(drive.fileById(second)).toBeNull();
    expect(drive.fileById(first)!.name).toBe('vault-meta.json');
  });

  test('deleting a folder removes its descendants (补裁 5), and deleting a missing id is 404', async () => {
    const drive = createFakeDrive();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('a'));
    const del = await drive.fetch(`${DRIVE_FILES_URL}/${drive.ids.rootFolderId}`, { method: 'DELETE', headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
    expect(del.status).toBe(204);
    expect(drive.fileById(drive.ids.stateFolderId)).toBeNull();
    expect((await drive.fetch(`${DRIVE_FILES_URL}/gone`, { method: 'DELETE', headers: { authorization: `Bearer ${drive.issueAccessToken()}` } })).status).toBe(404);
  });

  test('alt=media returns the bytes with a real content-length; a missing id is 404', async () => {
    const drive = createFakeDrive();
    const id = await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('abcdef'));
    const res = await drive.fetch(`${DRIVE_FILES_URL}/${id}?alt=media`, { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
    expect(res.headers.get('content-length')).toBe('6');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(enc('abcdef'));
    expect((await drive.fetch(`${DRIVE_FILES_URL}/gone?alt=media`, { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } })).status).toBe(404);
  });

  test('downloadFile port writes 2xx bytes exclusively and leaves no file for a 404', async () => {
    const drive = createFakeDrive();
    const id = await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('abcdef'));
    const dir = await mkdtemp(join(tmpdir(), 'fake-drive-download-'));
    try {
      const target = pathToFileURL(join(dir, 'out')).href;
      const seen: number[] = [];
      const result = await drive.downloadFile({ url: `${DRIVE_FILES_URL}/${id}?alt=media`, fileUri: target, headers: { authorization: `Bearer ${drive.issueAccessToken()}` }, maxBytes: 64 * 1024, onProgress: (p) => seen.push(p.bytesReceived) });
      expect(result).toMatchObject({ status: 200, redirected: false, bytesWritten: 6 });
      expect(result.headers['content-length']).toBe('6');
      expect(Array.from(new Uint8Array(await readFile(new URL(target))))).toEqual(Array.from(enc('abcdef')));
      expect(seen.at(-1)).toBe(6);

      const missing = pathToFileURL(join(dir, 'missing')).href;
      const absent = await drive.downloadFile({ url: `${DRIVE_FILES_URL}/gone?alt=media`, fileUri: missing, headers: { authorization: `Bearer ${drive.issueAccessToken()}` }, maxBytes: 64 * 1024 });
      expect(absent).toMatchObject({ status: 404, bytesWritten: 0, errorBody: expect.stringContaining('notFound') });
      await expect(stat(new URL(missing))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('about?fields=storageQuota reports string byte counts, and omits limit when the plan is unlimited (补裁 5)', async () => {
    const drive = createFakeDrive({ quotaTotal: 100 });
    await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('abcdef'));
    const q = (await json(await drive.fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } }))).storageQuota as Record<string, string>;
    expect(q).toEqual({ limit: '100', usage: '6', usageInDrive: '6', usageInDriveTrash: '0' });
    const unlimited = createFakeDrive({ quotaTotal: null });
    const uq = (await json(await unlimited.fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: { authorization: `Bearer ${unlimited.issueAccessToken()}` } }))).storageQuota as Record<string, string>;
    expect(uq.limit).toBeUndefined();
    // `fields` is REQUIRED on about.get: a caller that forgets it must not get a
    // convenient default out of the double.
    expect((await unlimited.fetch('https://www.googleapis.com/drive/v3/about', { headers: { authorization: `Bearer ${unlimited.issueAccessToken()}` } })).status).toBe(400);
  });

  test('a content PUT past the quota is 403 storageQuotaExceeded — on the CONTENT request, not at session creation (补裁 9)', async () => {
    const drive = createFakeDrive({ quotaTotal: 4 });
    const init = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': '6' },
      body: JSON.stringify({ name: 'big', parents: [drive.ids.blobsFolderId] }),
    });
    // The real API does NOT pre-check: the session is created happily.
    expect(init.status).toBe(200);
    const res = await drive.fetch(init.headers.get('location')!, { method: 'PUT', headers: { 'content-length': '6' }, body: enc('abcdef') });
    expect(res.status).toBe(403);
    expect(((await json(res)).error as { errors: { reason: string }[] }).errors[0]!.reason).toBe('storageQuotaExceeded');
  });

  test('failNext injects one Drive-shaped failure at the matching URL and then stops', async () => {
    const drive = createFakeDrive();
    drive.failNext(429, { error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }] } }, {}, /\/drive\/v3\/files\?/);
    const first = await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
    expect(first.status).toBe(429);
    expect((await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } })).status).toBe(200);
  });

  test('calls records every request so a suite can assert how many were made', async () => {
    const drive = createFakeDrive();
    await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, { headers: { authorization: `Bearer ${drive.issueAccessToken()}` } });
    expect(drive.calls.filter((c) => c.url.includes('/drive/v3/files?')).length).toBe(1);
  });

  // The knobs and behaviours Step 3 added beyond the suite above, each proven honest before an adapter trusts it.
  test('alwaysFail answers every matching request until the function it returned clears it', async () => {
    const drive = createFakeDrive();
    const clear = drive.alwaysFail(503, undefined, /\/drive\/v3\/files\?/);
    const list = async () => (await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, withBearer(drive))).status;
    expect([await list(), await list(), await list()]).toEqual([503, 503, 503]);
    clear();
    expect(await list()).toBe(200);
  });

  test('neverEndPaging, as an option and as a runtime switch, puts a nextPageToken on every listing answer, even past the end', async () => {
    const page = async (d: FakeDrive, token?: string) => json(await d.fetch(
      `${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${d.ids.stateFolderId}' in parents`)}&fields=nextPageToken,files(id)${token === undefined ? '' : `&pageToken=${token}`}`,
      withBearer(d),
    ));
    const endless = createFakeDrive({ neverEndPaging: true });
    const first = await page(endless);
    expect(first.files).toEqual([]);
    expect(typeof first.nextPageToken).toBe('string');
    expect(typeof (await page(endless, first.nextPageToken as string)).nextPageToken).toBe('string');
    const drive = createFakeDrive();
    expect((await page(drive)).nextPageToken).toBeUndefined();
    drive.neverEndPaging(true);
    expect(typeof (await page(drive)).nextPageToken).toBe('string');
    drive.neverEndPaging(false);
    expect((await page(drive)).nextPageToken).toBeUndefined();
  });

  test("the pageSize option caps every page below the caller's pageSize (Drive may answer a partial page)", async () => {
    const drive = createFakeDrive({ pageSize: 2 });
    for (let i = 0; i < 3; i += 1) await drive.putMultipart(drive.ids.stateFolderId, `n${i}.json`, enc('x'));
    const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${drive.ids.stateFolderId}' in parents`)}&fields=nextPageToken,files(name)&pageSize=1000`;
    const first = await json(await drive.fetch(url, withBearer(drive)));
    expect(first.files).toHaveLength(2);
    const second = await json(await drive.fetch(`${url}&pageToken=${first.nextPageToken as string}`, withBearer(drive)));
    expect(second.files).toHaveLength(1);
    expect(second.nextPageToken).toBeUndefined();
  });

  test('GET files/{id} answers the metadata the caller asked for (a folder has no size), and 404 for a missing id', async () => {
    const drive = createFakeDrive();
    const id = await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('abc'));
    const get = (fileId: string, fields: string) => drive.fetch(`${DRIVE_FILES_URL}/${fileId}?fields=${fields}`, withBearer(drive));
    expect(await json(await get(id, 'id,name,size,trashed'))).toEqual({ id, name: 'a.json', size: '3', trashed: false });
    expect(await json(await get(drive.ids.stateFolderId, 'id,mimeType,size'))).toEqual({ id: drive.ids.stateFolderId, mimeType: 'application/vnd.google-apps.folder' });
    expect((await get('gone', 'id')).status).toBe(404);
  });

  test('orderBy=createdTime lists oldest first; without orderBy, and between equal createdTimes, the double answers newest-first', async () => {
    let clock = 1_700_000_000_000;
    const drive = createFakeDrive({ now: () => clock });
    const oldest = await drive.putMultipart(drive.ids.rootFolderId, 'm.json', enc('1'));
    clock += 1_000;
    const tieA = await drive.putMultipart(drive.ids.rootFolderId, 'm.json', enc('2'));
    const tieB = await drive.putMultipart(drive.ids.rootFolderId, 'm.json', enc('3'));
    const ids = async (orderBy: string) => ((await json(await drive.fetch(
      `${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${drive.ids.rootFolderId}' in parents and name = 'm.json'`)}&fields=files(id)${orderBy}`,
      withBearer(drive),
    ))).files as { id: string }[]).map((f) => f.id);
    // Drive leaves both orders unspecified; newest-first breaks an adapter that relies on either instead of applying §3.4 itself.
    expect(await ids('&orderBy=createdTime')).toEqual([oldest, tieB, tieA]);
    expect(await ids('')).toEqual([tieB, tieA, oldest]);
  });

  test('about?fields=user(emailAddress) reports the account e-mail and nothing else', async () => {
    const drive = createFakeDrive();
    expect(await json(await drive.fetch(`${DRIVE_ABOUT_URL}?fields=user(emailAddress)`, withBearer(drive)))).toEqual({ user: { emailAddress: drive.accountEmail } });
  });

  test('fields is honoured: a field the caller did not ask for is not sent, not even nextPageToken', async () => {
    const drive = createFakeDrive();
    for (let i = 0; i < 3; i += 1) await drive.putMultipart(drive.ids.stateFolderId, `n${i}.json`, enc('x'));
    const body = await json(await drive.fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${drive.ids.stateFolderId}' in parents`)}&pageSize=1&fields=files(id)`, withBearer(drive)));
    // Two more rows exist, yet a caller that left nextPageToken out of `fields` gets none: how Drive silently truncates.
    expect(Object.keys(body)).toEqual(['files']);
    expect(Object.keys((body.files as Record<string, unknown>[])[0]!)).toEqual(['id']);
  });

  test('an unknown q clause is refused with 400 "fake Drive does not model …", never silently ignored', async () => {
    const drive = createFakeDrive();
    const q = `'${drive.ids.stateFolderId}' in parents and modifiedTime > '2020-01-01T00:00:00'`;
    const res = await drive.fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}`, withBearer(drive));
    expect(await refusal(res)).toMatchObject({ status: 400, error: { code: 400, message: expect.stringMatching(/^fake Drive does not model .*modifiedTime/) } });
  });

  // Task 4 spec review: what the double must refuse loudly instead of answering wrongly.
  test('fields is validated up front: a name Drive does not have is 400 invalidParameter even when no row would carry it', async () => {
    const drive = createFakeDrive();
    const emptyFolder = `${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${drive.ids.stateFolderId}' in parents`)}&fields=files(id,sise)`;
    const invalid = (field: string) => ({ status: 400, error: { message: `Invalid field selection ${field}`, errors: [{ reason: 'invalidParameter' }] } });
    expect(await refusal(await drive.fetch(emptyFolder, withBearer(drive)))).toMatchObject(invalid('sise'));
    expect(await refusal(await drive.fetch(`${DRIVE_ABOUT_URL}?fields=storageQuotta`, withBearer(drive)))).toMatchObject(invalid('storageQuotta'));
  });

  test('a field real Drive has but the double does not model (parents, md5Checksum, the files/id form, appInstalled) is refused as not modelled', async () => {
    const drive = createFakeDrive();
    const list = (fields: string) => `${DRIVE_FILES_URL}?q=${encodeURIComponent(`'${drive.ids.stateFolderId}' in parents`)}&fields=${fields}`;
    for (const url of [list('files(id,parents)'), list('files/id'), `${DRIVE_FILES_URL}/${drive.ids.stateFolderId}?fields=md5Checksum`, `${DRIVE_ABOUT_URL}?fields=appInstalled`]) {
      expect(await refusal(await drive.fetch(url, withBearer(drive)))).toMatchObject(notModelledAnswer);
    }
  });

  test('resumable session creation takes its metadata only as application/json; charset=UTF-8 (what the adapter sends)', async () => {
    const drive = createFakeDrive();
    const init = (contentType?: string) => drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'x-upload-content-length': '1', ...(contentType === undefined ? {} : { 'content-type': contentType }) },
      body: JSON.stringify({ name: 'b', parents: [drive.ids.blobsFolderId] }),
    });
    expect((await init('application/json; charset=UTF-8')).status).toBe(200);
    for (const type of ['application/json', 'text/plain; charset=UTF-8', undefined]) expect(await refusal(await init(type))).toMatchObject(notModelledAnswer);
    expect(drive.sessions()).toBe(1);
  });

  test("'root' in parents is refused as not modelled, not answered with a silently empty list", async () => {
    const drive = createFakeDrive();
    const res = await drive.fetch(`${DRIVE_FILES_URL}?q=${encodeURIComponent("'root' in parents and trashed = false")}`, withBearer(drive));
    expect(await refusal(res)).toMatchObject({ status: 400, error: { message: expect.stringMatching(/^fake Drive does not model .*'root' in parents/) } });
  });

  test('a URL the double does not serve (the revoke endpoint, a foreign host) is a loud 400, never a retryable-looking 502', async () => {
    const drive = createFakeDrive();
    for (const url of ['https://oauth2.googleapis.com/revoke?token=x', 'https://example.com/drive/v3/files']) {
      expect(await refusal(await drive.fetch(url, { method: 'POST' }))).toMatchObject(notModelledAnswer);
    }
  });

  test('no answer of any kind carries Retry-After (Drive never sends one, 补裁 8), and a knob cannot add one', async () => {
    const drive = createFakeDrive({ quotaTotal: 0 });
    const rateLimited = (code: number) => ({ error: { code, message: 'Rate Limit Exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }] } });
    drive.failNext(403, rateLimited(403), {}, /googleapis\.com\/drive\/v3\/files\?/);
    drive.alwaysFail(429, rateLimited(429), /\/drive\/v3\/about/);
    const opened = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': '2' },
      body: JSON.stringify({ name: 'b', parents: [drive.ids.blobsFolderId] }),
    });
    const answers = [
      await drive.fetch(`${DRIVE_FILES_URL}?pageSize=1`, withBearer(drive)), // injected 403 rate limit
      await drive.fetch(`${DRIVE_ABOUT_URL}?fields=user`, withBearer(drive)), // injected 429
      await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart`, { method: 'POST', headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'multipart/related; boundary=b' }, body: related('b', [['application/json; charset=UTF-8', noteMeta(drive)], ['application/octet-stream', 'x']]) }), // 403 full Drive
      opened, // session opened: 200 + Location, no body
      await drive.fetch(opened.headers.get('location')!, { method: 'PUT', body: enc('x') }), // 308: one of two bytes
      await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable&upload_id=nope`, { method: 'PUT', body: enc('x') }), // plain-text 404
    ];
    expect(answers.map((r) => [r.status, r.headers.get('retry-after')])).toEqual([[403, null], [429, null], [403, null], [200, null], [308, null], [404, null]]);
    expect(() => drive.failNext(429, rateLimited(429), { 'Retry-After': '5' })).toThrow(/Retry-After/);
  });

  test('multipart create takes only multipart/related: the same body as multipart/mixed is 400 badRequest', async () => {
    const drive = createFakeDrive();
    const body = related('b', [['application/json; charset=UTF-8', noteMeta(drive)], ['application/octet-stream', 'x']]);
    expect((await postMultipart(drive, 'multipart/related; boundary=b', body)).status).toBe(200);
    expect(await postMultipart(drive, 'multipart/mixed; boundary=b', body)).toMatchObject(badRequest);
  });

  test('multipart create refuses a body that never closes with --boundary--', async () => {
    const drive = createFakeDrive();
    const parts = [['application/json; charset=UTF-8', noteMeta(drive)], ['application/octet-stream', 'x']] as const;
    expect((await postMultipart(drive, 'multipart/related; boundary=b', related('b', parts))).status).toBe(200);
    expect(await postMultipart(drive, 'multipart/related; boundary=b', related('b', parts, ''))).toMatchObject(badRequest); // cut off after the media
    expect(await postMultipart(drive, 'multipart/related; boundary=b', related('b', parts, '\r\n--b'))).toMatchObject(badRequest); // a delimiter, not the close one
  });

  test('multipart create takes exactly two parts: a third one is 400 and nothing is stored', async () => {
    const drive = createFakeDrive();
    const three = related('b', [['application/json; charset=UTF-8', noteMeta(drive)], ['application/octet-stream', 'x'], ['application/octet-stream', 'y']]);
    expect(await postMultipart(drive, 'multipart/related; boundary=b', three)).toMatchObject(badRequest);
    expect(drive.fileNames(drive.ids.stateFolderId)).toEqual([]);
  });

  test('multipart create wants the metadata first and as application/json: a text/plain first part is 400 even when it holds JSON', async () => {
    const drive = createFakeDrive();
    const body = related('b', [['text/plain', noteMeta(drive)], ['application/octet-stream', 'x']]);
    expect(await postMultipart(drive, 'multipart/related; boundary=b', body)).toMatchObject(badRequest);
  });

  test('a full Drive answers 403 with domain usageLimits and reason storageQuotaExceeded, on multipart and on the content PUT alike', async () => {
    const drive = createFakeDrive({ quotaTotal: 2 });
    const full = { status: 403, error: { code: 403, errors: [{ domain: 'usageLimits', reason: 'storageQuotaExceeded' }] } };
    expect(await postMultipart(drive, 'multipart/related; boundary=b', related('b', [['application/json; charset=UTF-8', noteMeta(drive)], ['application/octet-stream', 'abc']]))).toMatchObject(full);
    const init = await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
      method: 'POST',
      headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': '3' },
      body: JSON.stringify({ name: 'b', parents: [drive.ids.blobsFolderId] }),
    });
    expect(await refusal(await drive.fetch(init.headers.get('location')!, { method: 'PUT', body: enc('abc') }))).toMatchObject(full);
  });

  const openSession = async (drive: FakeDrive, name: string, length?: number) => (await drive.fetch(`${DRIVE_UPLOAD_URL}?uploadType=resumable`, {
    method: 'POST',
    headers: { authorization: `Bearer ${drive.issueAccessToken()}`, 'content-type': 'application/json; charset=UTF-8', ...(length === undefined ? {} : { 'x-upload-content-length': String(length) }) },
    body: JSON.stringify({ name, parents: [drive.ids.blobsFolderId] }),
  })).headers.get('location')!;

  test('uploadFile PUTs the staged file to the session in ONE request, reports 0 then the total, and surfaces a missing file as the raw ENOENT', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
    const { tmpdir } = jest.requireActual('node:os') as typeof import('node:os');
    const { pathToFileURL } = jest.requireActual('node:url') as typeof import('node:url');
    const dir = mkdtempSync(`${tmpdir()}/fake-drive-`);
    try {
      writeFileSync(`${dir}/b1`, enc('abcdef'));
      const drive = createFakeDrive();
      const session = await openSession(drive, 'b1', 6);
      const seen: number[] = [];
      const res = await drive.uploadFile({ url: session, fileUri: pathToFileURL(`${dir}/b1`).href, headers: { 'content-length': '6' }, onProgress: (p) => seen.push(p.bytesSent) });
      expect(res.status).toBe(200);
      expect(drive.calls.filter((c) => c.url === session).map((c) => c.method)).toEqual(['PUT']);
      expect(seen).toEqual([0, 6]);
      expect(new TextDecoder().decode(drive.fileBytes(drive.ids.blobsFolderId, 'b1')!)).toBe('abcdef');
      // As createNodeUploadFilePort does: the raw fs error, code and message, never a wrapped copy.
      await expect(drive.uploadFile({ url: session, fileUri: pathToFileURL(`${dir}/missing`).href, headers: {} })).rejects.toMatchObject({ code: 'ENOENT', message: expect.stringMatching(/^ENOENT: no such file or directory/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clearFolders deletes state/ and blobs/ with everything in them, and leaves the root folder and its files', async () => {
    const drive = createFakeDrive();
    await drive.putMultipart(drive.ids.stateFolderId, 'n.json', enc('x'));
    await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('m'));
    drive.clearFolders();
    expect([drive.fileById(drive.ids.stateFolderId), drive.fileById(drive.ids.blobsFolderId)]).toEqual([null, null]);
    expect(drive.fileNames(drive.ids.stateFolderId)).toEqual([]);
    expect(drive.folderNames(drive.ids.rootFolderId)).toEqual([]);
    expect(drive.fileNames(drive.ids.rootFolderId)).toEqual(['vault-meta.json']);
  });

  test('clearFiles drops every file and every open upload session, and keeps the folders', async () => {
    const drive = createFakeDrive();
    await drive.putMultipart(drive.ids.stateFolderId, 'n.json', enc('x'));
    await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('y'));
    await openSession(drive, 'c');
    drive.clearFiles();
    expect([...drive.fileNames(drive.ids.stateFolderId), ...drive.fileNames(drive.ids.blobsFolderId)]).toEqual([]);
    expect(drive.sessions()).toBe(0);
    expect(drive.folderNames(drive.ids.rootFolderId)).toEqual(['blobs', 'state']);
  });

  test('usedBytes counts file bytes only (folders are free) and falls when a file is deleted', async () => {
    const drive = createFakeDrive();
    expect(drive.usedBytes()).toBe(0);
    const a = await drive.putMultipart(drive.ids.stateFolderId, 'a', enc('abc'));
    await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('defg'));
    expect(drive.usedBytes()).toBe(7);
    await drive.fetch(`${DRIVE_FILES_URL}/${a}`, { method: 'DELETE', ...withBearer(drive) });
    expect(drive.usedBytes()).toBe(4);
  });

  test('sessions counts open upload sessions: one per init, one fewer once a session commits', async () => {
    const drive = createFakeDrive();
    const first = await openSession(drive, 'a', 1);
    await openSession(drive, 'b', 1);
    expect(drive.sessions()).toBe(2);
    expect((await drive.fetch(first, { method: 'PUT', body: enc('x') })).status).toBe(200);
    expect(drive.sessions()).toBe(1);
  });

  test('folderNames lists only the folders directly under a folder, sorted, never files', async () => {
    const drive = createFakeDrive();
    await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('m'));
    expect(drive.folderNames(drive.ids.rootFolderId)).toEqual(['blobs', 'state']);
    expect(drive.folderNames(drive.ids.stateFolderId)).toEqual([]);
  });
});
