import { type CloudGetProgress, type CloudObjectStore } from './cloud-object-store';
import { describeCloudObjectStoreContract } from './cloud-object-store-contract-test-support';
import { createWebdavCloudObjectStore, parsePropfindListing, webdavObjectUrl } from './webdav-cloud-object-store';

/**
 * P12-B (spec §4.1): the WebDAV adapter, pinned against the shapes three real
 * servers answered on 2026-09-19 — hacdias/webdav (Docker), Synology DSM 7.2
 * Apache mod_dav behind cloudflared, and 123 云盘's official WebDAV. Every
 * literal XML body and status below is one of those servers' actual answers.
 */

const BINDING = { kind: 'webdav' as const, baseUrl: 'https://dav.example.com', username: 'alice', password: 'p@ss:word', rootPath: '/photos/' };
type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => { calls.push({ url, init: init ?? {} }); return handler(url, init ?? {}); };
  return { calls, fetchImpl };
}
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];
const ok = (status = 200, body: BodyInit | null = null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
/** A Response as fetch hands it back after following a 302: `redirected` is a getter, so it is redefined rather than assigned. */
const viaRedirect = (res: Response): Response => Object.defineProperty(res, 'redirected', { value: true });
const withFinalUrl = (res: Response, url: string): Response => Object.defineProperty(res, 'url', { value: url });
const make = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}): CloudObjectStore =>
  createWebdavCloudObjectStore(BINDING, { fetchImpl, ...extra });

describe('URL + auth', () => {
  test('objects live under <base><rootPath>Waifu Deck/, each segment percent-encoded; "" is the bind root', () => {
    expect(webdavObjectUrl(BINDING, 'state/a b.json')).toBe('https://dav.example.com/photos/Waifu%20Deck/state/a%20b.json');
    expect(webdavObjectUrl(BINDING, '')).toBe('https://dav.example.com/photos/Waifu%20Deck/');
    expect(webdavObjectUrl({ ...BINDING, baseUrl: 'https://h/dav/', rootPath: 'sub' }, 'vault-meta.json')).toBe('https://h/dav/sub/Waifu%20Deck/vault-meta.json');
    expect(webdavObjectUrl({ ...BINDING, rootPath: '/' }, 'blobs/g')).toBe('https://dav.example.com/Waifu%20Deck/blobs/g');
  });
  test('every request carries Basic base64(user:pass) — colons in the password survive', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok(404));
    await make(fetchImpl).get('state/x.json');
    expect(header(calls[0]!.init, 'authorization')).toBe(`Basic ${Buffer.from('alice:p@ss:word').toString('base64')}`);
  });
});

describe('ensureLayout = MKCOL ×3', () => {
  test.each([201, 405, 301, 200, 204])('%s on every MKCOL is success', async (status) => {
    const { calls, fetchImpl } = fakeFetch(() => ok(status));
    await make(fetchImpl).ensureLayout();
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['MKCOL', 'https://dav.example.com/photos/Waifu%20Deck/'],
      ['MKCOL', 'https://dav.example.com/photos/Waifu%20Deck/state/'],
      ['MKCOL', 'https://dav.example.com/photos/Waifu%20Deck/blobs/'],
    ]);
  });
  test('409 (parent missing) is a client error naming the root path; 401 is auth', async () => {
    await expect(make(fakeFetch(() => ok(409)).fetchImpl).ensureLayout())
      .rejects.toMatchObject({ name: 'CloudStoreError', status: 409, category: 'client', message: expect.stringContaining('/photos/') });
    await expect(make(fakeFetch(() => ok(401)).fetchImpl).ensureLayout())
      .rejects.toMatchObject({ category: 'auth', outcomeKnown: true });
  });
});

describe('put / delete', () => {
  test('put is a PUT with the bytes and content-type; 2xx resolves', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok(201));
    await make(fetchImpl).put('state/n.json', new Uint8Array([1, 2]), 'application/json');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(header(calls[0]!.init, 'content-type')).toBe('application/json');
    expect(Array.from(calls[0]!.init.body as Uint8Array)).toEqual([1, 2]);
  });
  test.each([[507, 'quota_full', true], [401, 'auth', true], [403, 'auth', true], [429, 'rate_limited', false], [503, 'rate_limited', false], [500, 'server', false], [400, 'client', true]] as const)(
    'put %s → %s (outcomeKnown %s)', async (status, category, known) => {
      await expect(make(fakeFetch(() => ok(status)).fetchImpl).put('state/n.json', new Uint8Array(1), 'application/json'))
        .rejects.toMatchObject({ status, category, outcomeKnown: known });
    });
  test('a fetch that throws is network / outcome unknown', async () => {
    await expect(make(async () => { throw new TypeError('offline'); }).put('state/n.json', new Uint8Array(1), 'application/json'))
      .rejects.toMatchObject({ status: 0, category: 'network', outcomeKnown: false });
  });
  test('delete: 204 and 404 both resolve; 403 is auth', async () => {
    await expect(make(fakeFetch(() => ok(204)).fetchImpl).delete('state/n.json')).resolves.toBeUndefined();
    await expect(make(fakeFetch(() => ok(404)).fetchImpl).delete('state/n.json')).resolves.toBeUndefined();
    await expect(make(fakeFetch(() => ok(403)).fetchImpl).delete('state/n.json')).rejects.toMatchObject({ category: 'auth' });
  });
});

describe('get', () => {
  test('404 → null with no progress; 200 streams bytes, reporting sent/total from content-length; accept-encoding is identity', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok(200, new Uint8Array([9, 8, 7]), { 'content-length': '3' }));
    const seen: CloudGetProgress[] = [];
    const back = await make(fetchImpl).get('blobs/g', (p) => seen.push({ ...p }));
    expect(Array.from(back!)).toEqual([9, 8, 7]);
    expect(seen[seen.length - 1]).toEqual({ sent: 3, total: 3 });
    expect(header(calls[0]!.init, 'accept-encoding')).toBe('identity');
    const none: CloudGetProgress[] = [];
    expect(await make(fakeFetch(() => ok(404, 'not here')).fetchImpl).get('blobs/none', (p) => none.push(p))).toBeNull();
    expect(none).toEqual([]);
  });
  test('no content-length → total is null on every report (the spinner case), and the bytes are still complete', async () => {
    const { fetchImpl } = fakeFetch(() => ok(200, new Uint8Array(5000)));
    const seen: CloudGetProgress[] = [];
    const back = await make(fetchImpl).get('blobs/g', (p) => seen.push({ ...p }));
    expect(back!.byteLength).toBe(5000);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((p) => p.total === null)).toBe(true);
    expect(seen[seen.length - 1]!.sent).toBe(5000);
  });
  test('a 404 reached THROUGH a redirect is a CDN propagation miss, not absence: retried briefly, then the bytes (123 云盘, measured 2026-09-20)', async () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      const fetchImpl = async () => {
        attempts += 1;
        if (attempts < 3) return viaRedirect(ok(404, 'not yet'));
        return viaRedirect(ok(200, new Uint8Array([4, 2]), { 'content-length': '2' }));
      };
      const p = make(fetchImpl, { redirectRetryMs: 100 }).get('blobs/g');
      await jest.advanceTimersByTimeAsync(300);
      expect(Array.from((await p)!)).toEqual([4, 2]);
      expect(attempts).toBe(3);
    } finally { jest.useRealTimers(); }
  });
  test('a 404 reached through a redirect that never resolves gives up as null after the bounded retries', async () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      const fetchImpl = async () => { attempts += 1; return viaRedirect(ok(404, 'gone')); };
      const p = make(fetchImpl, { redirectRetryMs: 100 }).get('blobs/g');
      await jest.advanceTimersByTimeAsync(2000);
      expect(await p).toBeNull();
      expect(attempts).toBe(5);
    } finally { jest.useRealTimers(); }
  });
  test('a 404 reached through a cross-host redirect is retried even when the response does not say redirected', async () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      const fetchImpl = async () => {
        attempts += 1;
        if (attempts === 1) return withFinalUrl(ok(404, 'not yet'), 'https://cdn.example.test/blobs/g');
        return ok(200, new Uint8Array([4, 2]), { 'content-length': '2' });
      };
      const p = make(fetchImpl, { redirectRetryMs: 100 }).get('blobs/g');
      await jest.advanceTimersByTimeAsync(100);
      expect(Array.from((await p)!)).toEqual([4, 2]);
      expect(attempts).toBe(2);
    } finally { jest.useRealTimers(); }
  });
  test('a same-origin 404 is believed at once even when the final URL differs in path', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return withFinalUrl(ok(404), 'https://dav.example.com/another/path');
    };
    expect(await make(fetchImpl).get('blobs/g')).toBeNull();
    expect(attempts).toBe(1);
  });
  test.each(['', 'not a url'])('an empty or unparsable final URL is treated as the same origin (%s)', async (finalUrl) => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return withFinalUrl(ok(404), finalUrl);
    };
    expect(await make(fetchImpl).get('blobs/g')).toBeNull();
    expect(attempts).toBe(1);
  });
  test('a plain 404 (no redirect) is answered at once as null — the server itself said the object is absent', async () => {
    let attempts = 0;
    expect(await make(async () => { attempts += 1; return ok(404); }).get('blobs/g')).toBeNull();
    expect(attempts).toBe(1);
  });
  test('a 500 on GET is server / outcome known (a read cannot have applied anything)', async () => {
    await expect(make(fakeFetch(() => ok(500)).fetchImpl).get('blobs/g')).rejects.toMatchObject({ status: 500, category: 'server', outcomeKnown: true });
  });
  test('a body that stops arriving for stallMs is network / outcome unknown', async () => {
    jest.useFakeTimers();
    try {
      const reader = { read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}), cancel: async () => {} };
      const fetchImpl = async () => ({ status: 200, ok: true, headers: new Headers(), body: { getReader: () => reader }, arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }) as unknown as Response;
      const p = make(fetchImpl, { stallMs: 1000 }).get('blobs/g');
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('stalled') });
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally { jest.useRealTimers(); }
  });
  test('a request that never gets headers times out on connectMs', async () => {
    jest.useFakeTimers();
    try {
      const p = make(async () => new Promise<Response>(() => {}), { connectMs: 2000 }).get('blobs/g');
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('timed out') });
      await jest.advanceTimersByTimeAsync(2000);
      await assertion;
    } finally { jest.useRealTimers(); }
  });
});

describe('getToFile = native download GET with Basic auth', () => {
  type DownloadReq = {
    url: string;
    fileUri: string;
    headers: Record<string, string>;
    maxBytes: number;
    signal?: AbortSignal;
    onProgress?: (progress: { bytesReceived: number; total: number | null }) => void;
  };
  const downloadResponse = (status: number, redirected = false, bytesWritten = 0) => ({
    status,
    headers: {},
    redirected,
    errorBody: status >= 400 ? `status ${status}` : '',
    bytesWritten,
  });

  test('passes the exact URL, file URI and headers to the port without calling fetch', async () => {
    const fetch = fakeFetch(() => ok(500));
    const requests: DownloadReq[] = [];
    const downloadFile = async (request: DownloadReq) => {
      requests.push(request);
      return downloadResponse(200, false, 12);
    };
    const store = make(fetch.fetchImpl, { downloadFile });
    await expect(store.getToFile?.('blobs/g', 'file:///cache/g')).resolves.toEqual({ bytesWritten: 12 });
    expect(fetch.calls).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://dav.example.com/photos/Waifu%20Deck/blobs/g',
      fileUri: 'file:///cache/g',
      headers: {
        authorization: `Basic ${Buffer.from('alice:p@ss:word').toString('base64')}`,
        'accept-encoding': 'identity',
      },
    });
    expect(Object.keys(requests[0]!.headers).sort()).toEqual(['accept-encoding', 'authorization']);
  });

  test('retries redirected 404s up to five attempts, preserving the same file URI', async () => {
    jest.useFakeTimers();
    try {
      let attempts = 0;
      const fileUris: string[] = [];
      const downloadFile = async (request: DownloadReq) => {
        attempts += 1;
        fileUris.push(request.fileUri);
        return attempts < 5 ? downloadResponse(404, true) : downloadResponse(200, true, 9);
      };
      const promise = make(fakeFetch(() => ok(500)).fetchImpl, { downloadFile, redirectRetryMs: 100 }).getToFile?.('blobs/g', 'file:///cache/g');
      await jest.advanceTimersByTimeAsync(400);
      await expect(promise).resolves.toEqual({ bytesWritten: 9 });
      expect(attempts).toBe(5);
      expect(fileUris).toEqual(Array(5).fill('file:///cache/g'));
    } finally { jest.useRealTimers(); }
  });

  test('a non-redirected 404 is null, and five redirected 404s are null after four pauses', async () => {
    let attempts = 0;
    const plain = make(fakeFetch(() => ok(500)).fetchImpl, { downloadFile: async () => { attempts += 1; return downloadResponse(404, false); } });
    await expect(plain.getToFile?.('blobs/missing', 'file:///cache/missing')).resolves.toBeNull();
    expect(attempts).toBe(1);

    jest.useFakeTimers();
    try {
      attempts = 0;
      const redirected = make(fakeFetch(() => ok(500)).fetchImpl, { downloadFile: async () => { attempts += 1; return downloadResponse(404, true); }, redirectRetryMs: 100 });
      const promise = redirected.getToFile?.('blobs/missing', 'file:///cache/missing');
      await jest.advanceTimersByTimeAsync(400);
      await expect(promise).resolves.toBeNull();
      expect(attempts).toBe(5);
    } finally { jest.useRealTimers(); }
  });

  test('maps a non-2xx response and forwards unknown-length progress', async () => {
    const seen: CloudGetProgress[] = [];
    const success = make(fakeFetch(() => ok(500)).fetchImpl, {
      downloadFile: async (request: DownloadReq) => {
        request.onProgress?.({ bytesReceived: 7, total: null });
        return downloadResponse(200, false, 7);
      },
    });
    await expect(success.getToFile?.('blobs/g', 'file:///cache/g', (progress) => seen.push(progress))).resolves.toEqual({ bytesWritten: 7 });
    expect(seen).toEqual([{ sent: 7, total: null }]);
    const failure = make(fakeFetch(() => ok(500)).fetchImpl, { downloadFile: async () => downloadResponse(500) });
    await expect(failure.getToFile?.('blobs/g', 'file:///cache/g')).rejects.toMatchObject({ status: 500, category: 'server', message: 'WebDAV GET blobs/g failed (500).', outcomeKnown: true });
  });

  test('does not define getToFile without a download port', () => {
    expect('getToFile' in make(fakeFetch(() => ok(500)).fetchImpl)).toBe(false);
  });
});

describe('list = PROPFIND Depth:1', () => {
  const HACDIAS = `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/photos/Waifu%20Deck/state/</D:href><D:propstat><D:prop><D:resourcetype><D:collection xmlns:D="DAV:"/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:getcontentlength></D:getcontentlength></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response><D:response><D:href>/photos/Waifu%20Deck/state/a.json</D:href><D:propstat><D:prop><D:resourcetype></D:resourcetype><D:getcontentlength>5</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
  const SYNOLOGY = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">\n<D:response xmlns:lp1="DAV:" xmlns:g0="DAV:">\n<D:href>/waifu-deck/photos/Waifu%20Deck/state/</D:href>\n<D:propstat>\n<D:prop>\n<lp1:resourcetype><D:collection/></lp1:resourcetype>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n<D:propstat>\n<D:prop>\n<g0:getcontentlength/>\n</D:prop>\n<D:status>HTTP/1.1 404 Not Found</D:status>\n</D:propstat>\n</D:response>\n<D:response xmlns:lp1="DAV:" xmlns:lp2="http://apache.org/dav/props/">\n<D:href>/waifu-deck/photos/Waifu%20Deck/state/b%26c.json</D:href>\n<D:propstat>\n<D:prop>\n<lp1:resourcetype/>\n<lp1:getcontentlength>12</lp1:getcontentlength>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n<D:response>\n<D:href>/waifu-deck/photos/Waifu%20Deck/state/sub/</D:href>\n<D:propstat><D:prop><lp1:resourcetype xmlns:lp1="DAV:"><D:collection/></lp1:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>\n</D:response>\n</D:multistatus>`;
  const PAN123 = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/webdav/Waifu%20Deck/state/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response><D:response><D:href>/webdav/Waifu%20Deck/state/n.json</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>7</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

  test('parses hacdias, Synology (lp1: prefix, share-prefixed hrefs, XML entities) and 123 shapes to the same rows; skips self and sub-collections', () => {
    expect(parsePropfindListing(HACDIAS)).toEqual([{ name: 'a.json', size: 5 }]);
    expect(parsePropfindListing(SYNOLOGY)).toEqual([{ name: 'b&c.json', size: 12 }]);
    expect(parsePropfindListing(PAN123)).toEqual([{ name: 'n.json', size: 7 }]);
  });
  test('XML entities in an href are decoded — named and numeric — before the percent-decoding (an object named with & must not vanish from sync)', () => {
    const named = HACDIAS.replace('<D:href>/photos/Waifu%20Deck/state/a.json</D:href>', '<D:href>/photos/Waifu%20Deck/state/a&amp;b.json</D:href>');
    expect(parsePropfindListing(named)).toEqual([{ name: 'a&b.json', size: 5 }]);
    const numeric = HACDIAS.replace('<D:href>/photos/Waifu%20Deck/state/a.json</D:href>', '<D:href>/photos/Waifu%20Deck/state/a&#38;b&#x2B;c.json</D:href>');
    expect(parsePropfindListing(numeric)).toEqual([{ name: 'a&b+c.json', size: 5 }]);
  });
  test('a foreign name that is not valid percent-encoding is listed raw instead of killing the whole listing', () => {
    const stray = HACDIAS.replace('<D:href>/photos/Waifu%20Deck/state/a.json</D:href>', '<D:href>/photos/Waifu%20Deck/state/100%off.txt</D:href>');
    expect(parsePropfindListing(stray)).toEqual([{ name: '100%off.txt', size: 5 }]);
  });
  test('a row without getcontentlength has size null; an absolute-URL href still yields the last segment', () => {
    expect(parsePropfindListing(HACDIAS.replace('<D:getcontentlength>5</D:getcontentlength>', ''))).toEqual([{ name: 'a.json', size: null }]);
    expect(parsePropfindListing(HACDIAS.replace('<D:href>/photos/Waifu%20Deck/state/a.json</D:href>', '<D:href>https://dav.example.com/photos/Waifu%20Deck/state/a.json</D:href>'))).toEqual([{ name: 'a.json', size: 5 }]);
  });
  test('list sends Depth:1 with a propfind body to the folder URL, and a 404 folder is not_found', async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok(207, HACDIAS, { 'content-type': 'application/xml' }));
    const rows = await make(fetchImpl).list('state');
    expect(rows).toEqual([{ name: 'a.json', size: 5 }]);
    expect(calls[0]!.init.method).toBe('PROPFIND');
    expect(header(calls[0]!.init, 'depth')).toBe('1');
    expect(String(calls[0]!.init.body)).toContain('<D:propfind');
    expect(calls[0]!.url).toBe('https://dav.example.com/photos/Waifu%20Deck/state/');
    await expect(make(fakeFetch(() => ok(404)).fetchImpl).list('state')).rejects.toMatchObject({ category: 'not_found' });
  });
  test("list('') lists the bind root", async () => {
    const { calls, fetchImpl } = fakeFetch(() => ok(207, HACDIAS.replaceAll('/state/', '/').replace('a.json', 'vault-meta.json')));
    const rows = await make(fetchImpl).list('');
    expect(calls[0]!.url).toBe('https://dav.example.com/photos/Waifu%20Deck/');
    expect(rows).toEqual([{ name: 'vault-meta.json', size: 5 }]);
  });
});

describe('quota = PROPFIND Depth:0 (RFC 4331)', () => {
  test('404 propstat for the quota props → null', async () => {
    const body = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/photos/Waifu%20Deck/</D:href><D:propstat><D:prop><D:quota-available-bytes></D:quota-available-bytes><D:quota-used-bytes></D:quota-used-bytes></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`;
    const { calls, fetchImpl } = fakeFetch(() => ok(207, body));
    expect(await make(fetchImpl).quota()).toBeNull();
    expect(header(calls[0]!.init, 'depth')).toBe('0');
  });
  test('used + available → used / total; used alone → total null; a 200 propstat with a stray 404 sibling still counts', async () => {
    const both = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/x/</D:href><D:propstat><D:prop><lp1:quota-used-bytes xmlns:lp1="DAV:">100</lp1:quota-used-bytes><D:quota-available-bytes>900</D:quota-available-bytes></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:foo/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`;
    expect(await make(fakeFetch(() => ok(207, both)).fetchImpl).quota()).toEqual({ usedBytes: 100, totalBytes: 1000 });
    const usedOnly = both.replace('<D:quota-available-bytes>900</D:quota-available-bytes>', '');
    expect(await make(fakeFetch(() => ok(207, usedOnly)).fetchImpl).quota()).toEqual({ usedBytes: 100, totalBytes: null });
  });
  test('a server that refuses PROPFIND on the root (405) reports no quota rather than throwing', async () => {
    expect(await make(fakeFetch(() => ok(405)).fetchImpl).quota()).toBeNull();
  });
  test('a negative quota-available-bytes (Nextcloud\'s -3 = unlimited) means no capacity, never a total below the usage', async () => {
    const unlimited = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/x/</D:href><D:propstat><D:prop><D:quota-used-bytes>100</D:quota-used-bytes><D:quota-available-bytes>-3</D:quota-available-bytes></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    expect(await make(fakeFetch(() => ok(207, unlimited)).fetchImpl).quota()).toEqual({ usedBytes: 100, totalBytes: null });
  });
  test('rejected credentials on the quota PROPFIND are an auth error, not "no quota" (a settings refresh must say reconnect)', async () => {
    await expect(make(fakeFetch(() => ok(401)).fetchImpl).quota()).rejects.toMatchObject({ status: 401, category: 'auth', outcomeKnown: true });
  });
});

describe('putFromFile = native upload PUT with Basic auth', () => {
  type UploadReq = { url: string; fileUri: string; headers: Record<string, string>; signal?: AbortSignal; onProgress?: (p: { bytesSent: number; totalBytes: number }) => void };
  test('hands url/headers/file to the upload port, forwards bytesSent, classifies the status', async () => {
    const seen: number[] = [];
    const requests: unknown[] = [];
    const uploadFile = async (req: UploadReq) => {
      requests.push({ url: req.url, fileUri: req.fileUri, ct: req.headers['content-type'], auth: req.headers.authorization?.slice(0, 6) });
      req.onProgress?.({ bytesSent: 10, totalBytes: 20 }); req.onProgress?.({ bytesSent: 20, totalBytes: 20 });
      return { status: 201, headers: {} };
    };
    await make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile }).putFromFile('blobs/g', 'file:///cache/g', 'application/octet-stream', (sent) => seen.push(sent));
    expect(requests).toEqual([{ url: 'https://dav.example.com/photos/Waifu%20Deck/blobs/g', fileUri: 'file:///cache/g', ct: 'application/octet-stream', auth: 'Basic ' }]);
    expect(seen).toEqual([10, 20]);
    await expect(make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile: async () => ({ status: 507, headers: {} }) }).putFromFile('blobs/g', 'file:///cache/g', 'application/octet-stream'))
      .rejects.toMatchObject({ status: 507, category: 'quota_full', outcomeKnown: true });
    await expect(make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile: async () => ({ status: 500, headers: {} }) }).putFromFile('blobs/g', 'file:///cache/g', 'application/octet-stream'))
      .rejects.toMatchObject({ status: 500, category: 'server', outcomeKnown: false });
  });
  test('an unreadable staging file is a client error (the contract: putFromFile of a missing file rejects client)', async () => {
    const missing = make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile: async () => { throw new Error('ENOENT: no such file or directory, open /missing'); } });
    await expect(missing.putFromFile('blobs/g', 'file:///missing', 'application/octet-stream')).rejects.toMatchObject({ category: 'client', outcomeKnown: true });
  });
  test('an upload port that rejects for any other reason is network / outcome unknown', async () => {
    const dead = make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile: async () => { throw new Error('socket hang up'); } });
    await expect(dead.putFromFile('blobs/g', 'file:///cache/g', 'application/octet-stream')).rejects.toMatchObject({ category: 'network', outcomeKnown: false });
  });
  test('an upload whose progress stops for stallMs is aborted as network / outcome unknown', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const uploadFile = (req: UploadReq) => new Promise<{ status: number; headers: Record<string, string> }>((_, reject) => { req.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }); });
      const p = make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile, stallMs: 1500 }).putFromFile('blobs/g', 'file:///cache/g', 'application/octet-stream');
      const assertion = expect(p).rejects.toMatchObject({ category: 'network', outcomeKnown: false, message: expect.stringContaining('stalled') });
      await jest.advanceTimersByTimeAsync(1500);
      await assertion;
      expect(aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
  test('a progress event that arrives after the stall watchdog aborted the upload is dropped (a late report would repopulate a cleared ring)', async () => {
    jest.useFakeTimers();
    try {
      const seen: number[] = [];
      let late: (() => void) | null = null;
      const uploadFile = (req: UploadReq) => new Promise<{ status: number; headers: Record<string, string> }>((_, reject) => {
        late = () => req.onProgress?.({ bytesSent: 999, totalBytes: 1000 });
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      const p = make(fakeFetch(() => ok(500)).fetchImpl, { uploadFile, stallMs: 1000 }).putFromFile('blobs/g', 'file:///cache/g', 'application/octet-stream', (sent) => seen.push(sent));
      const assertion = expect(p).rejects.toMatchObject({ category: 'network' });
      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
      late!();
      expect(seen).toEqual([]);
    } finally { jest.useRealTimers(); }
  });
  test('kind is webdav', () => { expect(make(fakeFetch(() => ok()).fetchImpl).kind).toBe('webdav'); });
});

describe('the reusable contract suite runs against this adapter over an in-memory fake WebDAV server', () => {
  // Proves the adapter satisfies the same suite the memory store passes, with
  // no network: a tiny WebDAV server in a Map (MKCOL 405 on an existing
  // collection like hacdias/Synology; PROPFIND lists only direct children).
  const objects = new Map<string, Uint8Array>();
  const collections = new Set<string>();
  const fakeServer = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = decodeURIComponent(new URL(url).pathname);
    const method = init?.method ?? 'GET';
    if (method === 'MKCOL') { if (collections.has(path)) return new Response(null, { status: 405 }); collections.add(path); return new Response(null, { status: 201 }); }
    if (method === 'PUT') { objects.set(path, new Uint8Array(init!.body as unknown as Uint8Array)); return new Response(null, { status: 201 }); }
    if (method === 'GET') { const b = objects.get(path); return b ? new Response(b as unknown as BodyInit, { status: 200, headers: { 'content-length': String(b.byteLength) } }) : new Response(null, { status: 404 }); }
    if (method === 'DELETE') { return new Response(null, { status: objects.delete(path) ? 204 : 404 }); }
    if (method === 'PROPFIND') {
      if (!collections.has(path)) return new Response(null, { status: 404 });
      const rows = [...objects.entries()].filter(([k]) => k.startsWith(path) && !k.slice(path.length).includes('/'))
        .map(([k, v]) => `<D:response><D:href>${encodeURI(k)}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>${v.byteLength}</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
      const subs = [...collections].filter((c) => c !== path && c.startsWith(path) && !c.slice(path.length, -1).includes('/'))
        .map((c) => `<D:response><D:href>${encodeURI(c)}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('');
      return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${encodeURI(path)}</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>${subs}${rows}</D:multistatus>`, { status: 207 });
    }
    return new Response(null, { status: 405 });
  };
  const uploadFile = async (req: { url: string; fileUri: string; headers: Record<string, string>; onProgress?: (p: { bytesSent: number; totalBytes: number }) => void }) => {
    const { readFileSync } = jest.requireActual('node:fs') as typeof import('node:fs');
    const { fileURLToPath } = jest.requireActual('node:url') as typeof import('node:url');
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(fileURLToPath(req.fileUri))); } catch (e) { throw new Error(`ENOENT: ${String(e)}`); }
    const r = await fakeServer(req.url, { method: 'PUT', body: bytes as unknown as BodyInit, headers: req.headers });
    req.onProgress?.({ bytesSent: bytes.byteLength, totalBytes: bytes.byteLength });
    return { status: r.status, headers: {} };
  };
  describeCloudObjectStoreContract('webdav adapter over an in-memory fake server', async () => ({
    store: createWebdavCloudObjectStore(BINDING, { fetchImpl: fakeServer, uploadFile }),
    dispose: async () => { objects.clear(); collections.clear(); },
  }));
});
