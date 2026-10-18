import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// eslint-disable-next-line import/first
import { fetch as expoFetch } from 'expo/fetch';

// eslint-disable-next-line import/first
import { cloudFetch } from './cloud-fetch';
// eslint-disable-next-line import/first
import { createS3Transport, type S3FetchPort } from './s3-transport';

const fetchMock = expoFetch as jest.Mock;
const CACHE_CONTROL = 'no-cache, no-store';

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
});

test('cloudFetch adds no-cache, no-store and keeps the other headers', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const signal = new AbortController().signal;

  await cloudFetch('https://example.test/object', {
    method: 'POST',
    headers: { authorization: 'Bearer fake', 'x-request-id': 'req-1' },
    body: body as unknown as BodyInit,
    signal,
  });

  const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(input).toBe('https://example.test/object');
  expect(init.method).toBe('POST');
  expect(init.body).toBe(body);
  expect(init.signal).toBe(signal);
  expect(init.headers).toEqual({
    authorization: 'Bearer fake',
    'x-request-id': 'req-1',
    'cache-control': CACHE_CONTROL,
  });
});

test("cloudFetch replaces a caller's cache-control", async () => {
  await cloudFetch('https://example.test/object', {
    headers: { 'Cache-Control': 'max-age=3600', authorization: 'Bearer fake' },
  });

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  expect(headers.authorization).toBe('Bearer fake');
  expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'cache-control')).toEqual(['cache-control']);
  expect(headers['cache-control']).toBe(CACHE_CONTROL);
});

test('cloudFetch works with no headers', async () => {
  await cloudFetch('https://example.test/object');

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(init.headers).toEqual({ 'cache-control': CACHE_CONTROL });
});

test("cloudFetch preserves a Headers instance's other entries", async () => {
  const headers = new Headers({ 'x-request-id': 'req-2', 'Cache-Control': 'max-age=1' });

  await cloudFetch('https://example.test/object', { headers });

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const merged = init.headers as Headers;
  expect(merged.get('x-request-id')).toBe('req-2');
  expect(merged.get('cache-control')).toBe(CACHE_CONTROL);
});

test('cloudFetch preserves a header tuple array while replacing cache-control', async () => {
  await cloudFetch('https://example.test/object', {
    headers: [['x-request-id', 'req-3'], ['CACHE-control', 'max-age=1']],
  });

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(init.headers).toEqual([
    ['x-request-id', 'req-3'],
    ['cache-control', CACHE_CONTROL],
  ]);
});

test('the SigV4 signature ignores cache-control', async () => {
  const credentials = {
    endpoint: 'https://s3.example.test', region: 'us-east-1', bucket: 'bucket',
    accessKeyId: 'AKID', secretAccessKey: 'secret',
  };
  const now = () => '20150830T123600Z';
  const directCalls: RequestInit[] = [];
  const directFetch: S3FetchPort = async (_input, init) => {
    directCalls.push(init ?? {});
    return new Response(null, { status: 200, headers: { etag: '"etag"' } });
  };

  await createS3Transport(credentials, { fetchImpl: directFetch, now }).getObject('state.json');

  const wrappedCalls: RequestInit[] = [];
  fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
    wrappedCalls.push(init ?? {});
    return new Response(null, { status: 200, headers: { etag: '"etag"' } });
  });
  await createS3Transport(credentials, { fetchImpl: cloudFetch, now }).getObject('state.json');

  const directHeaders = directCalls[0]!.headers as Record<string, string>;
  const wrappedHeaders = wrappedCalls[0]!.headers as Record<string, string>;
  expect(wrappedHeaders.authorization).toBe(directHeaders.authorization);
  expect(wrappedHeaders['x-amz-content-sha256']).toBe(directHeaders['x-amz-content-sha256']);
  expect(wrappedHeaders['cache-control']).toBe(CACHE_CONTROL);
  expect(wrappedHeaders.authorization).not.toMatch(/SignedHeaders=[^,]*cache-control/);
});

test('every cloud call site uses cloudFetch', () => {
  const roots = ['byos', 'cloud-store', 'library'].map((name) => join(__dirname, '..', name));
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) files.push(path);
    }
  };
  roots.forEach(visit);

  const importsExpoFetch = files.filter((file) => (
    file !== join(__dirname, 'cloud-fetch.ts')
    && /(?:from|require\s*\()\s*['"]expo\/fetch['"]/.test(readFileSync(file, 'utf8'))
  ));
  expect(importsExpoFetch).toEqual([]);
});
