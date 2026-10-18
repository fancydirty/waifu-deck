import { createFakeDrive } from '@/test/fake-drive-server';

import { CloudStoreError } from './cloud-object-store';
import { createGoogleDriveCloudObjectStore, DRIVE_UPLOAD_BASE, GDRIVE_MULTIPART_LIMIT, GDRIVE_STALL_TIMEOUT_MS, multipartBody } from './gdrive-cloud-object-store';
import { createGoogleTokenSource } from './google-token-source';
import { createNodeBlobStaging, createNodeDownloadFilePort, createNodeFileStat } from '@/test/node-file-transfer';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(options: Parameters<typeof createFakeDrive>[0] = {}, extra: Record<string, unknown> = {}) {
  const drive = createFakeDrive(options);
  const requests: { method: string; url: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    requests.push({
      method: init.method ?? 'GET',
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(init.body === undefined ? {} : { body: new Uint8Array(await new Response(init.body).arrayBuffer()) }),
    });
    return drive.fetch(url, init);
  };
  const tokens = createGoogleTokenSource({
    seed: { accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 },
    refresh: async () => ({ accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 }),
  });
  const store = createGoogleDriveCloudObjectStore(drive.ids, { tokens, fetchImpl, uploadFile: drive.uploadFile, statFile: async () => 0, ...extra });
  /** Only the Drive REST calls, never the token POST — P12-C's a69fe48 was exactly this off-by-one. */
  const restCalls = (fragment: string) => drive.calls.filter((c) => c.url.includes(fragment));
  return { drive, store, tokens, restCalls, requests };
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
  outer: for (let i = start; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function parseMultipart(body: Uint8Array, boundary: string) {
  const delimiter = enc(`--${boundary}`);
  const separator = enc('\r\n\r\n');
  const parts: { headers: Record<string, string>; body: Uint8Array }[] = [];
  let cursor = delimiter.length + 2;
  while (cursor < body.length) {
    const headerEnd = findBytes(body, separator, cursor);
    if (headerEnd < 0) throw new Error('missing multipart header separator');
    const next = findBytes(body, enc(`\r\n--${boundary}`), headerEnd + separator.length);
    if (next < 0) throw new Error('missing multipart delimiter');
    const headers = Object.fromEntries(dec(body.subarray(cursor, headerEnd)).split('\r\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
    }));
    parts.push({ headers, body: body.slice(headerEnd + separator.length, next) });
    cursor = next + 2 + delimiter.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) {
      cursor += 2;
      if (cursor !== body.length) throw new Error('bytes after multipart close delimiter');
      return parts;
    }
    if (body[cursor] !== 13 || body[cursor + 1] !== 10) throw new Error('malformed multipart delimiter');
    cursor += 2;
  }
  throw new Error('missing multipart close delimiter');
}

describe('get', () => {
  test('returns the bytes, and a missing name is null with no progress reported', async () => {
    const { drive, store } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    const seen: unknown[] = [];
    expect(dec((await store.get('state/a.json', (p) => seen.push(p)))!)).toBe('hello');
    // 'hello' is 5 bytes and the double sets a real content-length, so the LAST
    // report is the full length and `total` is that same 5 — never 0, never a guess.
    expect(seen.at(-1)).toEqual({ sent: 5, total: 5 });
    const missing: unknown[] = [];
    expect(await store.get('state/nope.json', (p) => missing.push(p))).toBeNull();
    expect(missing).toEqual([]);
  });

  test('sends accept-encoding: identity so content-length describes the real bytes (the Bunny lesson)', async () => {
    const { drive, store, restCalls } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    await store.get('state/a.json');
    expect(restCalls('alt=media')[0]!.headers['accept-encoding']).toBe('identity');
  });
});

describe('getToFile', () => {
  test('without a download port the optional method is omitted', () => {
    const { store } = harness();
    expect(Object.prototype.hasOwnProperty.call(store, 'getToFile')).toBe(false);
  });

  async function fileHarness(options: Parameters<typeof createFakeDrive>[0] = {}, extra: Record<string, unknown> = {}) {
    const drive = createFakeDrive(options);
    const download = createNodeDownloadFilePort(drive.fetch as unknown as typeof fetch);
    const calls: { headers: Record<string, string>; fileUri: string }[] = [];
    const downloadFile = async (request: Parameters<typeof download>[0]) => {
      calls.push({ headers: { ...request.headers }, fileUri: request.fileUri });
      return download(request);
    };
    const requests: { method: string; url: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      requests.push({ method: init.method ?? 'GET', url, headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.body === undefined ? {} : { body: new Uint8Array(await new Response(init.body).arrayBuffer()) }) });
      return drive.fetch(url, init);
    };
    const tokens = createGoogleTokenSource({
      seed: { accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 },
      refresh: async () => ({ accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 }),
    });
    const store = createGoogleDriveCloudObjectStore(drive.ids, { tokens, fetchImpl, uploadFile: drive.uploadFile, statFile: async () => 0, downloadFile, ...extra });
    return { drive, store, calls, requests };
  }

  test.each([
    ['storageQuotaExceeded', 'quota_full'],
    ['rateLimitExceeded', 'rate_limited'],
    ['forbidden', 'auth'],
  ])('403 %s error body maps to %s', async (reason, category) => {
    const { drive, store } = await fileHarness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    drive.failNext(403, { error: { code: 403, message: reason, errors: [{ reason }] } }, {}, /alt=media/);
    await expect(store.getToFile!('state/a.json', (await createNodeBlobStaging()).resolveTemp(`${reason}.bin`))).rejects.toMatchObject({ status: 403, category });
  });

  test('401 then 200 refreshes exactly once and carries bearer plus identity encoding', async () => {
    const { drive, store, calls } = await fileHarness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    drive.failNext(401, { error: { code: 401, message: 'Invalid Credentials' } }, {}, /alt=media/);
    const staging = createNodeBlobStaging();
    await expect(store.getToFile!('state/a.json', staging.resolveTemp('refresh.bin'))).resolves.toEqual({ bytesWritten: 5 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fileUri).toBe(calls[1]!.fileUri);
    expect(calls[0]!.headers.authorization).not.toBe(calls[1]!.headers.authorization);
    expect(calls.map((call) => call.headers['accept-encoding'])).toEqual(['identity', 'identity']);
  });

  test('404 returns null, evicts the cached id, and resolves it again next time', async () => {
    const { drive, store } = await fileHarness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    const staging = createNodeBlobStaging();
    await store.getToFile!('state/a.json', staging.resolveTemp('warm.bin'));
    const before = drive.calls.filter((call) => call.url.includes('/drive/v3/files?q=')).length;
    drive.failNext(404, { error: { code: 404, message: 'File not found', errors: [{ reason: 'notFound' }] } }, {}, /alt=media/);
    await expect(store.getToFile!('state/a.json', staging.resolveTemp('gone.bin'))).resolves.toBeNull();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('again'));
    await expect(store.getToFile!('state/a.json', staging.resolveTemp('again.bin'))).resolves.toEqual({ bytesWritten: 5 });
    expect(drive.calls.filter((call) => call.url.includes('/drive/v3/files?q=')).length).toBe(before + 1);
  });

  test('a missing name returns null without calling the media port', async () => {
    const { store, calls } = await fileHarness();
    await expect(store.getToFile!('state/missing.json', createNodeBlobStaging().resolveTemp('missing.bin'))).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('a stalled error body (board #9 T2, spec §5.2)', () => {
  test('a 503 whose body never completes yields the status-based error within stallMs and aborts the request\'s own controller', async () => {
    jest.useFakeTimers();
    try {
      const drive = createFakeDrive();
      await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
      const signals: AbortSignal[] = [];
      // Headers arrive, the body never does: the device fetch has no read timeout.
      const fetchImpl = async (url: string, init?: RequestInit) => {
        if (!url.includes('alt=media')) return drive.fetch(url, init);
        signals.push(init!.signal!);
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
      };
      const tokens = createGoogleTokenSource({
        seed: { accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 },
        refresh: async () => ({ accessToken: drive.issueAccessToken(), refreshToken: drive.refreshToken, expiresAt: Date.now() + 3_600_000 }),
      });
      const store = createGoogleDriveCloudObjectStore(drive.ids, { tokens, fetchImpl, uploadFile: drive.uploadFile, statFile: async () => 0, stallMs: 1000 });
      const pending = store.get('state/a.json');
      const settled = jest.fn();
      pending.then(settled, settled);
      await jest.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalled();
      await expect(pending).rejects.toMatchObject({ name: 'CloudStoreError', status: 503, category: 'server' });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  }, 5000);
});

describe('the name→id cache is positive-only (补裁 6)', () => {
  test('a repeated get resolves the id once but fetches the media each time', async () => {
    const { drive, store, restCalls } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    await store.get('state/a.json');
    await store.get('state/a.json');
    // Derived: one `files?q=` lookup is cached and reused; each get still fetches
    // its own body. Counted by URL fragment so the token POST cannot inflate it.
    expect(restCalls('/drive/v3/files?q=').length).toBe(1);
    expect(restCalls('alt=media').length).toBe(2);
  });

  test('an absent name is NEVER cached: a later write is found', async () => {
    const { drive, store } = harness();
    // This is the one that matters for protocol v2: reconciliation is driven by
    // "a state/ name that has newly appeared", so a cached negative would make
    // every new note permanently invisible to this device.
    expect(await store.get('state/late.json')).toBeNull();
    await drive.putMultipart(drive.ids.stateFolderId, 'late.json', enc('arrived'));
    expect(dec((await store.get('state/late.json'))!)).toBe('arrived');
  });

  test('delete evicts the entry, so a re-created name reads the NEW bytes', async () => {
    const { drive, store } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('old'));
    await store.get('state/a.json');
    await store.delete('state/a.json');
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('new'));
    expect(dec((await store.get('state/a.json'))!)).toBe('new');
  });

  test('a duplicated name resolves to the earliest createdTime, and an exact tie to the smallest file id (§3.4)', async () => {
    let clock = 1_700_000_000_000;
    const { drive, store } = harness({ now: () => (clock += 1_000) });
    await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('first'));
    await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('second'));
    expect(dec((await store.get('vault-meta.json'))!)).toBe('first');
    // Tie: freeze the clock so both rows carry the same createdTime; the rule then
    // falls back to the lexicographically smallest file id (§3.4's P12-A ruling).
    const frozen = harness({ now: () => 1_800_000_000_000 });
    const a = await frozen.drive.putMultipart(frozen.drive.ids.rootFolderId, 'tie.json', enc('A'));
    const b = await frozen.drive.putMultipart(frozen.drive.ids.rootFolderId, 'tie.json', enc('B'));
    const winner = [a, b].sort()[0] === a ? 'A' : 'B';
    expect(dec((await frozen.store.get('tie.json'))!)).toBe(winner);
  });
});

describe('list', () => {
  test('reports names with sizes as NUMBERS parsed from Drive strings, pages, and never reports folders', async () => {
    // pageSize 2 over 3 notes → pages of 2 and 1 = 2 list requests (derived from
    // the double's own pageSize knob, not from Drive's real 1000).
    const { drive, store, restCalls } = harness({ pageSize: 2 });
    await drive.putMultipart(drive.ids.stateFolderId, 'n1.json', enc('x'));
    await drive.putMultipart(drive.ids.stateFolderId, 'n2.json', enc('yy'));
    await drive.putMultipart(drive.ids.stateFolderId, 'n3.json', enc('zzz'));
    const rows = await store.list('state');
    expect(rows.map((r) => r.name).sort()).toEqual(['n1.json', 'n2.json', 'n3.json']);
    expect(rows.map((r) => r.size).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3]);
    expect(restCalls('/drive/v3/files?q=').length).toBe(2);
  });

  test("list('') reports root files only — state/ and blobs/ are layout, not objects", async () => {
    const { drive, store } = harness();
    await drive.putMultipart(drive.ids.rootFolderId, 'vault-meta.json', enc('m'));
    await drive.putMultipart(drive.ids.stateFolderId, 'n1.json', enc('x'));
    const names = (await store.list('')).map((r) => r.name);
    expect(names).toEqual(['vault-meta.json']);
    expect(names).not.toContain('state');
    expect(names).not.toContain('blobs');
  });

  test('a pageToken loop that never terminates fails loudly instead of hanging', async () => {
    const { drive, store } = harness({ pageSize: 1, neverEndPaging: true });
    await drive.putMultipart(drive.ids.stateFolderId, 'n1.json', enc('x'));
    // Bounded like the OneDrive adapter. Drive pages by token on the SAME URL, so
    // unlike Graph's absolute @odata.nextLink there is no off-host risk and no
    // origin guard is needed — the implementation says so in a comment rather
    // than copying a guard that would guard nothing.
    await expect(store.list('state')).rejects.toMatchObject({ category: 'server' });
  });
});

describe('ensureLayout, delete, quota', () => {
  test('ensureLayout checks the three ids and creates nothing; a 404 tells the user to reconnect', async () => {
    const { drive, store, restCalls } = harness();
    await store.ensureLayout();
    expect(restCalls('/upload/drive/v3/files').length).toBe(0);
    expect(restCalls('/drive/v3/files?q=').length).toBe(0);
    drive.clearFolders();
    const error = await store.ensureLayout().catch((e: unknown) => e as CloudStoreError);
    // The user deleted the folder in Drive. Recreating it behind their back would
    // silently overwrite their decision (the OneDrive rule, same product reason).
    expect(error).toMatchObject({ category: 'client' });
    expect((error as CloudStoreError).message).toMatch(/disconnect/i);
  });

  test('delete treats 404 as success — including a stale cached id (补裁 5)', async () => {
    const { drive, store } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('x'));
    await store.get('state/a.json');
    drive.failNext(404, { error: { code: 404, message: 'File not found', errors: [{ domain: 'global', reason: 'notFound', message: 'File not found' }] } }, {}, /\/drive\/v3\/files\//);
    await expect(store.delete('state/a.json')).resolves.toBeUndefined();
  });

  test('delete is idempotent: deleting a name that is not there succeeds', async () => {
    const { store } = harness();
    await expect(store.delete('state/never-existed.json')).resolves.toBeUndefined();
  });

  test('quota parses the string counts; an absent limit means unlimited, not zero', async () => {
    const { drive, store } = harness({ quotaTotal: 100 });
    await drive.putMultipart(drive.ids.blobsFolderId, 'b', enc('abcdef'));
    expect(await store.quota()).toEqual({ usedBytes: 6, totalBytes: 100 });
    const unlimited = harness({ quotaTotal: null });
    expect(await unlimited.store.quota()).toEqual({ usedBytes: 0, totalBytes: null });
  });

  test('quota THROWS on 401/403 rather than reporting "this backend has no quota"', async () => {
    const { drive, store } = harness();
    drive.failNext(403, { error: { code: 403, message: 'Forbidden', errors: [{ domain: 'global', reason: 'forbidden', message: 'Forbidden' }] } }, {}, /\/drive\/v3\/about/);
    // Reporting null here would draw an empty capacity line for an auth problem —
    // the UI would look healthy while the vault was unreachable.
    await expect(store.quota()).rejects.toMatchObject({ category: 'auth' });
  });

  test('quota THROWS a Drive rate-limit response instead of reporting no quota', async () => {
    const { drive, store } = harness();
    drive.failNext(429, { error: { code: 429, message: 'Rate limit exceeded', errors: [{ domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate limit exceeded' }] } }, {}, /\/drive\/v3\/about/);
    await expect(store.quota()).rejects.toMatchObject({ status: 429, category: 'rate_limited', outcomeKnown: false });
  });

  test('quota THROWS a Drive backend error instead of reporting no quota', async () => {
    const { drive, store } = harness();
    drive.failNext(500, { error: { code: 500, message: 'Backend error', errors: [{ domain: 'global', reason: 'backendError', message: 'Backend error' }] } }, {}, /\/drive\/v3\/about/);
    await expect(store.quota()).rejects.toMatchObject({ status: 500, category: 'server', outcomeKnown: false });
  });
});

describe('error map (补裁 8)', () => {
  const body = (code: number, reason: string) => ({ error: { code, message: reason, errors: [{ domain: 'usageLimits', reason, message: reason }] } });
  test.each([
    [403, 'storageQuotaExceeded', 'quota_full', true],
    [403, 'rateLimitExceeded', 'rate_limited', false],
    [403, 'userRateLimitExceeded', 'rate_limited', false],
    [429, 'rateLimitExceeded', 'rate_limited', false],
    [403, 'forbidden', 'auth', true],
    // NO 404 row here: the port says `get` RESOLVES TO NULL for an absent object
    // rather than throwing (`cloud-object-store.ts`), and both siblings do exactly
    // that (`onedrive-cloud-object-store.ts:335`, the WebDAV adapter ~:284). The
    // 404 → not_found mapping still exists for `delete` (where it is an idempotent
    // success, 补裁 5) and is asserted in its own test below.
    [400, 'badRequest', 'client', true],
    [500, 'backendError', 'server', false],
    [503, 'backendError', 'server', false],
  ])('a %i %s classifies %s with outcomeKnown=%s', async (status, reason, category, outcomeKnown) => {
    const { drive, store } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('x'));
    await store.get('state/a.json'); // warm the id cache so the failure lands on alt=media
    drive.failNext(status, body(status, reason), {}, /alt=media/);
    // outcomeKnown comes from the port's table: network/server/rate_limited are
    // "unknown" because the request may have been applied before the answer.
    await expect(store.get('state/a.json')).rejects.toMatchObject({ status, category, outcomeKnown });
  });

  test('a stale cached id (the file was deleted by another device) reads as ABSENT, not as an error', async () => {
    const { drive, store } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    await store.get('state/a.json'); // warms the cache with this file's id
    drive.failNext(404, { error: { code: 404, message: 'File not found', errors: [{ domain: 'global', reason: 'notFound', message: 'File not found' }] } }, {}, /alt=media/);
    // Protocol v2 deletes superseded notes constantly, so another device removing
    // the object under a cached id is ORDINARY, not a fault: `get` must answer the
    // way it answers for any absent object, or reconciliation turns a normal race
    // into `object_missing`.
    expect(await store.get('state/a.json')).toBeNull();
    // `failNext` is a response override, so model the other device's actual
    // deletion with the fake's existing clearFiles hook before recreating it.
    drive.clearFiles();
    // ...and the dead id must not be reused: a name written again is found.
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('again'));
    expect(dec((await store.get('state/a.json'))!)).toBe('again');
  });

  test('no Retry-After is read or required — Drive documents none, it documents exponential backoff', async () => {
    const { drive, store } = harness();
    drive.failNext(429, body(429, 'rateLimitExceeded'), {}, /\/drive\/v3\/files\?q=/);
    const error = await store.list('state').catch((e: unknown) => e as CloudStoreError);
    expect(error).toMatchObject({ category: 'rate_limited' });
    // The adapter never sleeps: pacing is the engine's existing offline behaviour.
    expect((error as CloudStoreError).message).not.toMatch(/Retry-After/i);
  });

  test('a 2xx whose body will not parse is network trouble, not a raw SyntaxError', async () => {
    const { drive, store } = harness();
    drive.failNext(200, '<html>captive portal</html>', { 'content-type': 'text/html' }, /\/drive\/v3\/files\?q=/);
    await expect(store.list('state')).rejects.toMatchObject({ category: 'network' });
  });
});

describe('put = multipart create-only', () => {
  test('sends metadata first and media second in a parsed RFC 2387 multipart body', async () => {
    const { drive, store, requests } = harness();
    const payload = new Uint8Array([0, 1, 2, 255]);
    await store.put('state/note.json', payload, 'application/vnd.waifu.note');
    const request = requests.find((r) => r.url.startsWith(DRIVE_UPLOAD_BASE))!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${DRIVE_UPLOAD_BASE}?uploadType=multipart&fields=id`);
    const boundary = /^multipart\/related; boundary=(.+)$/.exec(request.headers['content-type'] ?? '')?.[1];
    expect(boundary).toBeTruthy();
    const parts = parseMultipart(request.body!, boundary!);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.headers['content-type']).toBe('application/json; charset=UTF-8');
    expect(JSON.parse(dec(parts[0]!.body))).toEqual({ name: 'note.json', parents: [drive.ids.stateFolderId] });
    expect(parts[1]!.headers['content-type']).toBe('application/vnd.waifu.note');
    expect(parts[1]!.body).toEqual(payload);
    expect(dec((await store.get('state/note.json'))!)).toBe(dec(payload));
  });

  test('chooses a boundary absent from payload bytes and round-trips a payload containing a fixed boundary candidate', async () => {
    const { store } = harness();
    const candidate = 'gdrive-boundary-fixed-candidate';
    const bytes = enc(`payload\r\n--${candidate}\r\ninside`);
    await store.put('state/boundary.json', bytes, 'application/octet-stream');
    expect(dec((await store.get('state/boundary.json'))!)).toBe(dec(bytes));
    const built = multipartBody({ name: 'x', parents: ['folder'] }, bytes, 'application/octet-stream');
    expect(dec(bytes)).toContain(candidate);
    expect(dec(built.body)).not.toContain(`--${built.boundary}\r\ninside`);
    const collidingPayload = enc(`bytes--${built.boundary}inside`);
    const collisionSafe = multipartBody({ name: 'x', parents: ['folder'] }, collidingPayload, 'application/octet-stream');
    expect(collisionSafe.boundary).not.toBe(built.boundary);
    expect(parseMultipart(collisionSafe.body, collisionSafe.boundary)[1]!.body).toEqual(collidingPayload);
  });

  test('creates duplicate names without PATCH and reads the earliest duplicate (§3.4)', async () => {
    let clock = 1_700_000_000_000;
    const { drive, store, requests } = harness({ now: () => (clock += 1000) });
    await store.put('vault-meta.json', enc('first'), 'application/json');
    await store.put('vault-meta.json', enc('second'), 'application/json');
    expect(drive.fileNames(drive.ids.rootFolderId)).toEqual(['vault-meta.json', 'vault-meta.json']);
    expect(dec((await store.get('vault-meta.json'))!)).toBe('first');
    expect(requests.filter((r) => r.url.startsWith(DRIVE_UPLOAD_BASE)).map((r) => r.method)).toEqual(['POST', 'POST']);
    // This is the protocol's single duplicate-tolerant object; notes have ULID names.
  });

  test('rejects a body over Drive multipart limit and directs blob writes to putFromFile', async () => {
    const { store } = harness();
    expect(GDRIVE_MULTIPART_LIMIT).toBe(5 * 1024 * 1024);
    // The production stall window, the value the device uses (the 61 MiB integration test widens it for the Node
    // harness only, which has no upload progress): pinned so a harness change can never quietly move it.
    expect(GDRIVE_STALL_TIMEOUT_MS).toBe(20_000);
    await expect(store.put('state/too-large', new Uint8Array(GDRIVE_MULTIPART_LIMIT + 1), 'application/octet-stream'))
      .rejects.toMatchObject({ category: 'client', message: expect.stringContaining('putFromFile') });
  });
});

describe('putFromFile = one whole-file resumable session PUT', () => {
  async function staged(bytes: Uint8Array) {
    const staging = createNodeBlobStaging();
    const uri = staging.resolveTemp('gdrive-upload.bin');
    await staging.writeBytes(uri, bytes);
    return uri;
  }

  test('posts metadata, then makes one pre-authorized whole-file PUT with length and no content-range', async () => {
    const bytes = enc('whole file');
    const uri = await staged(bytes);
    const { drive, store, requests } = harness({}, { statFile: createNodeFileStat() });
    const progress: number[] = [];
    await store.putFromFile('blobs/blob', uri, 'application/octet-stream', (n: number) => progress.push(n));
    const session = requests.find((r) => r.url === `${DRIVE_UPLOAD_BASE}?uploadType=resumable`)!;
    expect(session.method).toBe('POST');
    expect(session.headers['content-type']).toBe('application/json; charset=UTF-8');
    expect(session.headers['x-upload-content-length']).toBe(String(bytes.length));
    expect(session.headers['x-upload-content-type']).toBe('application/octet-stream');
    expect(JSON.parse(dec(session.body!))).toEqual({ name: 'blob', parents: [drive.ids.blobsFolderId] });
    const upload = drive.calls.filter((c) => c.method === 'PUT' && c.url.includes('upload_id='));
    expect(upload).toHaveLength(1);
    expect(upload[0]!.headers['content-length']).toBe(String(bytes.length));
    expect(upload[0]!.headers['content-range']).toBeUndefined();
    expect(upload[0]!.headers.authorization).toBeUndefined();
    expect(progress).toEqual([0, bytes.length]);
    expect(Array.from(drive.fileBytes(drive.ids.blobsFolderId, 'blob')!)).toEqual(Array.from(bytes));
  });

  test('validates the session Location before sending staged bytes', async () => {
    const bytes = enc('sensitive');
    const uri = await staged(bytes);
    const { drive, store } = harness({}, {
      statFile: createNodeFileStat(),
      fetchImpl: async (url: string, init?: RequestInit) => {
        const response = await drive.fetch(url, init);
        if (url === `${DRIVE_UPLOAD_BASE}?uploadType=resumable`) return new Response(null, { status: 200, headers: { location: 'http://untrusted.example/session' } });
        return response;
      },
    });
    await expect(store.putFromFile('blobs/blob', uri, 'application/octet-stream')).rejects.toMatchObject({ category: 'client' });
    expect(drive.calls.filter((c) => c.method === 'PUT' && c.url.includes('upload_id=')).length).toBe(0);
  });

  test('rejects an unparseable session Location before sending staged bytes', async () => {
    const uri = await staged(enc('sensitive'));
    const { drive, store } = harness({}, {
      statFile: createNodeFileStat(),
      fetchImpl: async (url: string, init?: RequestInit) => {
        await drive.fetch(url, init);
        if (url === `${DRIVE_UPLOAD_BASE}?uploadType=resumable`) return new Response(null, { status: 200, headers: { location: '://bad url' } });
        return new Response(null, { status: 500 });
      },
    });
    await expect(store.putFromFile('blobs/bad-location', uri, 'application/octet-stream')).rejects.toMatchObject({ category: 'client' });
    expect(drive.calls.filter((c) => c.method === 'PUT' && c.url.includes('upload_id=')).length).toBe(0);
  });

  test('rejects a missing or empty local file before creating a session', async () => {
    const missing = harness({}, { statFile: async () => null });
    await expect(missing.store.putFromFile('blobs/missing', 'file:///missing', 'application/octet-stream'))
      .rejects.toMatchObject({ category: 'client', message: expect.stringContaining('cannot read') });
    const empty = harness({}, { statFile: async () => 0 });
    await expect(empty.store.putFromFile('blobs/empty', 'file:///empty', 'application/octet-stream'))
      .rejects.toMatchObject({ category: 'client', message: expect.stringContaining('empty') });
    expect(missing.requests.filter((r) => r.url.includes('uploadType=resumable'))).toHaveLength(0);
    expect(empty.requests.filter((r) => r.url.includes('uploadType=resumable'))).toHaveLength(0);
  });

  test('treats a 308 as incomplete and retryable, and a 404 as an expired session', async () => {
    const bytes = enc('body');
    const uri = await staged(bytes);
    const incomplete = harness({}, { statFile: async () => bytes.length + 1 });
    await expect(incomplete.store.putFromFile('blobs/partial', uri, 'application/octet-stream'))
      .rejects.toMatchObject({ status: 308, category: 'server', outcomeKnown: false, message: expect.stringMatching(/incomplete/i) });
    expect(incomplete.restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(0);
    const expired = harness({}, { statFile: createNodeFileStat() });
    expired.drive.failNext(404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8' }, /upload_id=/);
    await expect(expired.store.putFromFile('blobs/expired', uri, 'application/octet-stream'))
      .rejects.toMatchObject({ status: 404, category: 'server', outcomeKnown: false, message: expect.stringMatching(/expired/i) });
    expect(expired.restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(0);
  });

  test.each([null, 0])('does not probe quota for staged-file size %s (invalid local file)', async (size) => {
    const { store, restCalls } = harness({}, { statFile: async () => size });
    await expect(store.putFromFile('blobs/x', 'file:///x', 'application/octet-stream')).rejects.toMatchObject({ category: 'client' });
    expect(restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(0);
  });

  test('on a whole-file 403, reports quota_full when usage already equals limit', async () => {
    const bytes = enc('x');
    const uri = await staged(bytes);
    const { drive, store, restCalls } = harness({ quotaTotal: 1 }, { statFile: createNodeFileStat() });
    await drive.putMultipart(drive.ids.blobsFolderId, 'existing', bytes);
    await expect(store.putFromFile('blobs/x', uri, 'application/octet-stream')).rejects.toMatchObject({ status: 403, category: 'quota_full', outcomeKnown: true });
    expect(restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(1);
  });

  test('on a whole-file 403, reports quota_full when this file does not fit', async () => {
    const bytes = enc('xx');
    const uri = await staged(bytes);
    const { drive, store, restCalls } = harness({ quotaTotal: 2 }, { statFile: createNodeFileStat() });
    await drive.putMultipart(drive.ids.blobsFolderId, 'existing', enc('x'));
    await expect(store.putFromFile('blobs/x', uri, 'application/octet-stream')).rejects.toMatchObject({ status: 403, category: 'quota_full', outcomeKnown: true });
    expect(restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(1);
  });

  test('on a whole-file 403, reports auth when quota has room for this file', async () => {
    const bytes = enc('x');
    const uri = await staged(bytes);
    const { drive, store, restCalls } = harness({ quotaTotal: 10 }, { statFile: createNodeFileStat() });
    drive.failNext(403, { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden', message: 'Forbidden' }] } }, {}, /upload_id=/);
    await expect(store.putFromFile('blobs/x', uri, 'application/octet-stream')).rejects.toMatchObject({ status: 403, category: 'auth', outcomeKnown: true });
    expect(restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(1);
  });

  test('if the quota probe fails after upload 403, reports auth and probes once', async () => {
    const bytes = enc('x');
    const uri = await staged(bytes);
    const { drive, store, restCalls } = harness({ quotaTotal: 10 }, { statFile: createNodeFileStat() });
    drive.failNext(403, { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden', message: 'Forbidden' }] } }, {}, /upload_id=/);
    drive.failNext(500, { error: { code: 500, message: 'Backend error', errors: [{ reason: 'backendError', message: 'Backend error' }] } }, {}, /about/);
    await expect(store.putFromFile('blobs/x', uri, 'application/octet-stream')).rejects.toMatchObject({ status: 403, category: 'auth', outcomeKnown: true });
    expect(restCalls('/drive/v3/about?fields=storageQuota')).toHaveLength(1);
  });

  test('forwards native progress and names the object when the upload goes silent', async () => {
    const started = deferred<void>();
    const { store } = harness({}, {
      statFile: async () => 1,
      stallMs: 15,
      uploadFile: async ({ onProgress }: { onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void }) => {
        onProgress?.({ bytesSent: 1, totalBytes: 1 });
        started.resolve();
        return new Promise(() => {});
      },
    });
    const pending = store.putFromFile('blobs/silent', 'file:///staged', 'application/octet-stream');
    await started.promise;
    await expect(pending).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('blobs/silent') });
  });
});

describe('401 handling', () => {
  test('one 401 is refreshed and retried exactly once; a second 401 is an auth failure', async () => {
    const { drive, store, restCalls } = harness();
    await drive.putMultipart(drive.ids.stateFolderId, 'a.json', enc('hello'));
    await store.get('state/a.json');
    const before = restCalls('alt=media').length;
    drive.failNext(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ domain: 'global', reason: 'authError', message: 'Invalid Credentials' }] } }, {}, /alt=media/);
    expect(dec((await store.get('state/a.json'))!)).toBe('hello');
    // One rejected attempt + one successful retry = 2 more media calls.
    expect(restCalls('alt=media').length).toBe(before + 2);

    const twice = harness();
    await twice.drive.putMultipart(twice.drive.ids.stateFolderId, 'a.json', enc('x'));
    await twice.store.get('state/a.json');
    const base = twice.restCalls('alt=media').length;
    twice.drive.alwaysFail(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ domain: 'global', reason: 'authError', message: 'Invalid Credentials' }] } }, /alt=media/);
    await expect(twice.store.get('state/a.json')).rejects.toMatchObject({ status: 401, category: 'auth' });
    // Exactly two attempts, never a third: a retry loop against a dead token
    // burns the user's quota for nothing.
    expect(twice.restCalls('alt=media').length).toBe(base + 2);
  });
});
