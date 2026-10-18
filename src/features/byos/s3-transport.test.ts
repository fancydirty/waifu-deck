import { S3DownloadError, type S3DownloadFilePort } from './s3-file-download';
import { createS3Transport, decodeXml, parseListXml } from './s3-transport';
import { S3LocalWriteError } from './s3-transport-types';

// The transport's default payload-hash port is `expo-crypto`'s native
// `digest`. Under `jest-expo` the unmocked native module answers it with a
// 32-byte ZERO buffer, which would make a wrong `x-amz-content-sha256` look
// correct here and fail only against a real backend, so map it to the double's
// genuine SHA-256.
jest.mock('expo-crypto', () => require('../../test/expo-crypto-double'));

/** SHA-256 of the empty byte string (AWS's documented empty-payload digest). */
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** SHA-256 of the three bytes 01 02 03. */
const SHA256_OF_123 =
  '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

/** The pre-Task-3b parser, retained as a differential behavior oracle. */
function regexOracle(xml: string): ReturnType<typeof parseListXml> {
  const objects: ReturnType<typeof parseListXml>['objects'][number][] = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentsRe.exec(xml)) !== null) {
    const block = match[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '';
    const rawEtag = /<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] ?? '';
    const etag = decodeXml(rawEtag);
    const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? '';
    const rawSize = /<Size>([\s\S]*?)<\/Size>/.exec(block)?.[1];
    const size = rawSize === undefined ? 0 : Number.parseInt(rawSize, 10);
    const decodedKey = decodeXml(key);
    if (decodedKey.endsWith('/') && (Number.isNaN(size) || size === 0)) continue;
    objects.push({
      key: decodedKey, etag, lastModified,
      size: Number.isNaN(size) ? 0 : size,
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = truncated
    ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
    : undefined;
  return { objects, nextToken };
}

function generatedListing(count: number): string {
  const contents = Array.from({ length: count }, (_, index) =>
    `<Contents><Key>assets/generated-${index}.json</Key>` +
    `<ETag>&quot;etag-${index}&quot;</ETag>` +
    `<LastModified>2026-10-04T00:00:00.000Z</LastModified><Size>${index + 1}</Size></Contents>`,
  ).join('');
  return `<ListBucketResult>${contents}</ListBucketResult>`;
}

const creds = {
  endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'b',
  accessKeyId: 'AKID', secretAccessKey: 'SECRET',
};
const now = () => '20150830T123600Z';

/**
 * A Response-like object whose body streams `count` single-byte chunks spaced
 * `gapMs` apart (driven by setTimeout, so fake timers advance it), then ends.
 * Models a slow-but-steady transfer: each `reader.read()` resolves one chunk
 * after `gapMs`.
 */
function streamingResponse(count: number, gapMs: number): Response {
  let served = 0;
  const reader = {
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        if (served >= count) {
          resolve({ done: true });
          return;
        }
        served += 1;
        setTimeout(() => resolve({ done: false, value: new Uint8Array([served % 256]) }), gapMs);
      }),
    cancel: () => Promise.resolve(),
  };
  return {
    status: 200,
    ok: true,
    headers: new Headers({ etag: '"e"' }),
    body: { getReader: () => reader },
    arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
  } as unknown as Response;
}

test('putObject sends a signed PUT with conditional header and returns etag', async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response(null, { status: 200, headers: { etag: '"abc"' } });
  };
  const t = createS3Transport(creds, { fetchImpl, now });
  const res = await t.putObject('assets/a1/state.json', new Uint8Array([1]), {
    ifNoneMatch: '*', contentType: 'application/json',
  });
  expect(res.etag).toBe('"abc"');
  expect(captured!.url).toBe('https://s3.example.com/b/assets/a1/state.json');
  expect((captured!.init!.headers as Record<string, string>)['if-none-match']).toBe('*');
  expect((captured!.init!.headers as Record<string, string>).authorization)
    .toMatch(/^AWS4-HMAC-SHA256 /);
});

describe('SigV4 payload hashing is delegated, not recomputed in pure JS', () => {
  // K6-1e Task 2 (spec §2's five-second bar). Every signed request used to
  // hash its own body with the pure-JS @noble sha256 inside `signRequest`.
  // On Hermes that is ~1.3 s for a 6 MB blob, paid once per PUT — three times
  // per protected image, on top of the plaintext hash Task 1 deleted. The hash
  // now comes from an injectable port whose production default is
  // `expo-crypto`'s native `digest` (~10 ms/MB).
  const captureFetch = () => {
    const captured: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    };
    return { captured, fetchImpl };
  };
  const headersOf = (entry: { init?: RequestInit }) =>
    entry.init!.headers as Record<string, string>;

  test('putObject hashes the body exactly once, through the injected port', async () => {
    const { captured, fetchImpl } = captureFetch();
    const hashPayload = jest.fn(async () => 'aa'.repeat(32));
    const body = new Uint8Array([1, 2, 3]);
    const t = createS3Transport(creds, { fetchImpl, now, hashPayload });
    await t.putObject('k', body, {});
    expect(hashPayload).toHaveBeenCalledTimes(1);
    expect(hashPayload).toHaveBeenCalledWith(body);
    // The signed digest IS the port's answer: nothing recomputes it.
    expect(headersOf(captured[0]!)['x-amz-content-sha256']).toBe('aa'.repeat(32));
  });

  test('a bodyless request signs the constant empty digest without hashing', async () => {
    const { captured, fetchImpl } = captureFetch();
    const hashPayload = jest.fn(async () => 'bb'.repeat(32));
    const t = createS3Transport(creds, { fetchImpl, now, hashPayload });
    await t.getObject('k');
    await t.deleteObject('k');
    await t.listObjects('assets/', undefined);
    expect(hashPayload).not.toHaveBeenCalled();
    for (const entry of captured) {
      expect(headersOf(entry)['x-amz-content-sha256']).toBe(EMPTY_SHA256);
    }
  });

  test('the default port produces the real SHA-256 of the body', async () => {
    // No injection: this is the production path (`expo-crypto`'s native
    // `digest`, mocked here to the same algorithm). MinIO verifies
    // `x-amz-content-sha256` on every PUT, so the integration gate is where a
    // wrong digest becomes an HTTP 400 rather than a passing unit test.
    const { captured, fetchImpl } = captureFetch();
    const t = createS3Transport(creds, { fetchImpl, now });
    await t.putObject('k', new Uint8Array([1, 2, 3]), {});
    expect(headersOf(captured[0]!)['x-amz-content-sha256']).toBe(SHA256_OF_123);
  });
});

test('putObject maps 412 to a precondition error with outcomeKnown=true', async () => {
  const fetchImpl = async () => new Response('', { status: 412 });
  const t = createS3Transport(creds, { fetchImpl, now });
  await expect(
    t.putObject('k', new Uint8Array(), { ifMatch: '"x"' }),
  ).rejects.toMatchObject({ category: 'precondition', outcomeKnown: true });
});

test('putObject maps a thrown network failure to network error, outcomeKnown=false', async () => {
  const fetchImpl = async () => { throw new TypeError('Network request failed'); };
  const t = createS3Transport(creds, { fetchImpl, now });
  await expect(t.putObject('k', new Uint8Array(), {}))
    .rejects.toMatchObject({ category: 'network', outcomeKnown: false });
});

test('putObject on 503 is rate_limited with outcomeKnown=false', async () => {
  const fetchImpl = async () => new Response('', { status: 503 });
  const t = createS3Transport(creds, { fetchImpl, now });
  await expect(t.putObject('k', new Uint8Array(), {}))
    .rejects.toMatchObject({ category: 'rate_limited', outcomeKnown: false });
});

test('putObject on 500 is a server error with outcomeKnown=false', async () => {
  const fetchImpl = async () => new Response('', { status: 500 });
  const t = createS3Transport(creds, { fetchImpl, now });
  await expect(t.putObject('k', new Uint8Array(), {}))
    .rejects.toMatchObject({ category: 'server', outcomeKnown: false });
});

test('deleteObject treats 404 as an already-absent success', async () => {
  const fetchImpl = async () => new Response('', { status: 404 });
  const t = createS3Transport(creds, { fetchImpl, now });
  await expect(t.deleteObject('k')).resolves.toBeUndefined();
});

test('request headers omit host while SignedHeaders still covers it', async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response(null, { status: 200, headers: { etag: '"abc"' } });
  };
  const t = createS3Transport(creds, { fetchImpl, now });
  await t.putObject('k', new Uint8Array([1]), {});
  const headers = captured!.init!.headers as Record<string, string>;
  expect(Object.keys(headers)).not.toContain('host');
  expect(headers.authorization).toMatch(/SignedHeaders=[^,]*\bhost\b/);
});

test('a key with sub-delimiters is strictly RFC 3986-encoded on the wire', async () => {
  // encodeURIComponent leaves (a*b)!' literal, but SigV4 canonicalizes them to
  // uppercase percent-encoding. The signed canonical URI and the fetch URL must
  // use the identical encoded path, or a real backend answers 403. The `/`
  // separators stay literal (each segment is encoded independently).
  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return new Response(null, { status: 200, headers: { etag: '"e"' } });
  };
  const t = createS3Transport(creds, { fetchImpl, now });
  await t.putObject("(a*b)!'/state.json", new Uint8Array([1]), {});
  expect(captured!.url).toBe(
    "https://s3.example.com/b/%28a%2Ab%29%21%27/state.json",
  );
  // The signature is computed over that same encoded path, so it must be a
  // valid AWS4 header (a mismatch would still be present but wrong — this
  // asserts the path fed to the signer produced a coherent authorization).
  const headers = captured!.init!.headers as Record<string, string>;
  expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
});

test('getObject returns bytes+etag on 200 and null on 404', async () => {
  const okFetch = async () =>
    new Response(new Uint8Array([7, 8]), { status: 200, headers: { etag: '"e"' } });
  const t1 = createS3Transport(creds, { fetchImpl: okFetch, now });
  const got = await t1.getObject('k');
  expect(got && Array.from(got.body)).toEqual([7, 8]);
  expect(got!.etag).toBe('"e"');
  const missFetch = async () => new Response('', { status: 404 });
  const t2 = createS3Transport(creds, { fetchImpl: missFetch, now });
  expect(await t2.getObject('k')).toBeNull();
});

describe('getObjectToFile', () => {
  const response = (overrides: Partial<{
    status: number;
    headers: Record<string, string>;
    redirected: boolean;
    errorBody: string;
    bytesWritten: number;
  }> = {}) => ({
    status: 200,
    headers: { etag: '"e1"' },
    redirected: false,
    errorBody: '',
    bytesWritten: 4,
    ...overrides,
  });

  test('requires an injected download port', async () => {
    const t = createS3Transport(creds, { now });
    await expect(t.getObjectToFile('g1', 'file:///tmp/g1'))
      .rejects.toThrow('requires a download file port');
  });

  test('passes the signed GET and cache control to the file port without reading a response body', async () => {
    const downloadFile = jest.fn<ReturnType<S3DownloadFilePort>, Parameters<S3DownloadFilePort>>(
      async () => response(),
    );
    const fetchImpl = jest.fn(async () => {
      throw new Error('getObject body path must not run');
    });
    const t = createS3Transport(creds, { fetchImpl, now, downloadFile });

    await expect(t.getObjectToFile('blobs/g1', 'file:///tmp/g1'))
      .resolves.toEqual({ etag: '"e1"', bytesWritten: 4 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const request = downloadFile.mock.calls[0]![0]!;
    expect(request.url).toBe('https://s3.example.com/b/blobs/g1');
    expect(request.fileUri).toBe('file:///tmp/g1');
    expect(request.maxBytes).toBe(64 * 1024 * 1024);
    expect(request.headers['cache-control']).toBe('no-cache, no-store');
    expect(request.headers['accept-encoding']).toBe('identity');
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request.headers.authorization).toMatch(/SignedHeaders=[^,]*accept-encoding/);
    expect(request.headers.authorization).not.toMatch(/cache-control/);
  });

  test('returns null for a missing object', async () => {
    const t = createS3Transport(creds, {
      now,
      downloadFile: jest.fn(async () => response({ status: 404, headers: {}, bytesWritten: 0 })),
    });
    await expect(t.getObjectToFile('missing', 'file:///tmp/missing')).resolves.toBeNull();
  });

  test('maps a non-2xx response and includes the capped error body', async () => {
    const t = createS3Transport(creds, {
      now,
      downloadFile: jest.fn(async () => response({
        status: 500,
        errorBody: 'minio failure',
        bytesWritten: 0,
      })),
    });
    await expect(t.getObjectToFile('bad', 'file:///tmp/bad')).rejects.toMatchObject({
      name: 'S3TransportError', status: 500, category: 'server', outcomeKnown: true,
      message: expect.stringContaining('minio failure'),
    });
  });

  test('watchdog waits 30 seconds for first progress and then 20 seconds per progress event', async () => {
    jest.useFakeTimers();
    try {
      let request: Parameters<S3DownloadFilePort>[0] | undefined;
      const downloadFile = jest.fn<ReturnType<S3DownloadFilePort>, Parameters<S3DownloadFilePort>>((input) => {
        request = input;
        return new Promise<ReturnType<typeof response>>(() => {});
      });
      const t = createS3Transport(creds, { now, downloadFile });
      const pending = t.getObjectToFile('stalled', 'file:///tmp/stalled');
      const assertion = expect(pending).rejects.toMatchObject({
        category: 'network', outcomeKnown: false, message: expect.stringContaining('stalled'),
      });
      await jest.advanceTimersByTimeAsync(29_999);
      expect(request?.signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await assertion;
      expect(request?.signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('re-arms the watchdog for 20 seconds after progress, then aborts the port', async () => {
    jest.useFakeTimers();
    try {
      let request: Parameters<S3DownloadFilePort>[0] | undefined;
      const cancelDownload = jest.fn();
      const downloadFile = jest.fn<ReturnType<S3DownloadFilePort>, Parameters<S3DownloadFilePort>>((input) => {
        request = input;
        input.signal?.addEventListener('abort', cancelDownload);
        return new Promise<ReturnType<typeof response>>(() => {});
      });
      const t = createS3Transport(creds, { now, downloadFile });
      const pending = t.getObjectToFile('progress-then-silence', 'file:///tmp/progress-then-silence');
      await Promise.resolve();
      request!.onProgress?.({ bytesReceived: 1, total: 10 });
      const assertion = expect(pending).rejects.toMatchObject({
        category: 'network', outcomeKnown: false, message: expect.stringContaining('stalled'),
      });
      await jest.advanceTimersByTimeAsync(19_900);
      expect(request?.signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect(request?.signal?.aborted).toBe(true);
      await assertion;
      expect(cancelDownload).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('progress every 10 seconds for 60 seconds does not stall', async () => {
    jest.useFakeTimers();
    try {
      let request: Parameters<S3DownloadFilePort>[0] | undefined;
      let resolve!: (value: ReturnType<typeof response>) => void;
      const downloadFile = jest.fn<ReturnType<S3DownloadFilePort>, Parameters<S3DownloadFilePort>>((input) => {
        request = input;
        return new Promise<ReturnType<typeof response>>((done) => { resolve = done; });
      });
      const t = createS3Transport(creds, { now, downloadFile });
      const pending = t.getObjectToFile('moving', 'file:///tmp/moving');
      for (let second = 0; second < 6; second += 1) {
        await jest.advanceTimersByTimeAsync(10_000);
        request!.onProgress?.({ bytesReceived: second + 1, total: 6 });
      }
      resolve(response());
      await expect(pending).resolves.toEqual({ etag: '"e1"', bytesWritten: 4 });
      expect(request?.signal?.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('maps too-large native rejection to the client category', async () => {
    const t = createS3Transport(creds, {
      now,
      downloadFile: jest.fn(async () => {
        throw new S3DownloadError('too_large', 'object too large');
      }),
    });
    await expect(t.getObjectToFile('large', 'file:///tmp/large')).rejects.toMatchObject({
      category: 'client', status: 0, outcomeKnown: true,
    });
  });

  test('maps local write failures to S3LocalWriteError', async () => {
    const t = createS3Transport(creds, {
      now,
      downloadFile: jest.fn(async () => {
        throw new S3DownloadError('local_io', 'disk full');
      }),
    });
    await expect(t.getObjectToFile('full', 'file:///tmp/full'))
      .rejects.toBeInstanceOf(S3LocalWriteError);
  });
});

test('listObjects parses keys, etags, metadata and continuation token', async () => {
  const xml =
    '<?xml version="1.0"?><ListBucketResult>' +
    '<Contents><Key>assets/a1/state.json</Key><ETag>&quot;e1&quot;</ETag>' +
    '<LastModified>2026-08-28T10:00:00.000Z</LastModified><Size>12</Size></Contents>' +
    '<Contents><Key>assets/a2/state.json</Key><ETag>&quot;e2&quot;</ETag>' +
    '<LastModified>2026-08-28T11:30:00.000Z</LastModified><Size>3400</Size></Contents>' +
    '<IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>' +
    '</ListBucketResult>';
  const fetchImpl = async () => new Response(xml, { status: 200 });
  const t = createS3Transport(creds, { fetchImpl, now });
  const page = await t.listObjects('assets/', undefined);
  expect(page.objects).toEqual([
    {
      key: 'assets/a1/state.json', etag: '"e1"',
      lastModified: '2026-08-28T10:00:00.000Z', size: 12,
    },
    {
      key: 'assets/a2/state.json', etag: '"e2"',
      lastModified: '2026-08-28T11:30:00.000Z', size: 3400,
    },
  ]);
  expect(page.nextToken).toBe('tok');
});

test('listObjects decodes numeric XML entities in ETags (MinIO emits &#34;)', async () => {
  // AWS wraps the ETag in &quot;; MinIO uses the decimal numeric entity &#34;
  // for the same double quote. Both must decode to a bare `"..."` so a listing
  // ETag is comparable to the header ETag callers get from putObject/getObject.
  const xml =
    '<?xml version="1.0"?><ListBucketResult>' +
    '<Contents><Key>assets/a1/state.json</Key>' +
    '<ETag>&#34;a0386e7066cd97e6ebe2fd9c8b28292d&#34;</ETag>' +
    '<LastModified>2026-08-29T00:00:00.000Z</LastModified><Size>5</Size></Contents>' +
    '</ListBucketResult>';
  const t = createS3Transport(creds, {
    fetchImpl: async () => new Response(xml, { status: 200 }),
    now,
  });
  const page = await t.listObjects('assets/', undefined);
  expect(page.objects[0].etag).toBe('"a0386e7066cd97e6ebe2fd9c8b28292d"');
});

test('parseListXml matches the regex oracle across listing edge cases', () => {
  const listings = [
    '<?xml version="1.0"?><ListBucketResult>' +
      '<Contents><Key>assets/a1/state.json</Key><ETag>&quot;e1&quot;</ETag>' +
      '<LastModified>2026-08-28T10:00:00.000Z</LastModified><Size>12</Size></Contents>' +
      '<Contents><Key>assets/a2/state.json</Key><ETag>&quot;e2&quot;</ETag>' +
      '<LastModified>2026-08-28T11:30:00.000Z</LastModified><Size>3400</Size></Contents>' +
      '<IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>' +
      '</ListBucketResult>',
    '<?xml version="1.0"?><ListBucketResult>' +
      '<Contents><Key>assets/minio.json</Key>' +
      '<ETag>&#34;minio&#34;</ETag><LastModified>2026-08-29T00:00:00.000Z</LastModified>' +
      '<Size>5</Size></Contents></ListBucketResult>',
    '<ListBucketResult>' +
      '<Contents><Key>key/</Key><ETag>&quot;dir&quot;</ETag>' +
      '<LastModified>2026-10-04T00:00:00.000Z</LastModified><Size>0</Size></Contents>' +
      '<Contents><Key>key/with-size/</Key><ETag>&quot;five&quot;</ETag>' +
      '<LastModified>2026-10-04T00:00:01.000Z</LastModified><Size>5</Size></Contents>' +
      '<Contents><Key>key/real.json</Key><ETag>&quot;real&quot;</ETag>' +
      '<LastModified>2026-10-04T00:00:02.000Z</LastModified><Size>9</Size></Contents>' +
      '</ListBucketResult>',
    '<ListBucketResult><Contents><Key>assets/truncated.json</Key>' +
      '<ETag>&quot;truncated&quot;</ETag><Size>3</Size></Contents>' +
      '<IsTruncated>true</IsTruncated><NextContinuationToken>next-page</NextContinuationToken>' +
      '</ListBucketResult>',
    '<ListBucketResult><Contents><Key>assets/stale-token.json</Key>' +
      '<ETag>&quot;stale&quot;</ETag><Size>3</Size></Contents>' +
      '<IsTruncated>false</IsTruncated><NextContinuationToken>stale-page</NextContinuationToken>' +
      '</ListBucketResult>',
    '<ListBucketResult>' +
      '<Contents><Key>missing-etag</Key><LastModified>t1</LastModified><Size>1</Size></Contents>' +
      '<Contents><Key>missing-size</Key><ETag>e2</ETag><LastModified>t2</LastModified></Contents>' +
      '<Contents><Key>bad-size</Key><ETag>e3</ETag><LastModified>t3</LastModified><Size>abc</Size></Contents>' +
      '<Contents><Key>first-key</Key><Key>last-key</Key><ETag>e4</ETag>' +
      '<LastModified>t4</LastModified><Size>4</Size></Contents>' +
      '<Contents><Key>missing-etag-close</Key><ETag>unterminated' +
      '<LastModified>t5</LastModified><Size>5</Size></Contents>' +
      '</ListBucketResult>',
    '<ListBucketResult><Contents><Key>folder/a&amp;b&lt;c</Key>' +
      '<ETag>&amp;etag&lt;</ETag><LastModified>t</LastModified><Size>4</Size></Contents>' +
      '</ListBucketResult>',
    '<ListBucketResult></ListBucketResult>',
    '<ListBucketResult><Name>Contents</Name><Prefix>Contents</Prefix>' +
      '<contents><Key>ignored-lower</Key><Size>7</Size></contents>' +
      '<Contents attr="ignored"><Key>ignored-attribute</Key><Size>8</Size></Contents>' +
      '<Contents><Key>outside-safe</Key><Size>2</Size></Contents></ListBucketResult>',
    '<ListBucketResult><Contents><Key>complete</Key><Size>1</Size></Contents>' +
      '<Contents><Key>incomplete</Key><Size>2</Size>',
  ];

  for (const xml of listings) {
    expect(parseListXml(xml)).toEqual(regexOracle(xml));
  }
});

test('parseListXml matches the regex oracle on a generated 1,000-entry page', () => {
  const xml = generatedListing(1_000);
  expect(parseListXml(xml)).toEqual(regexOracle(xml));
});

test('parseListXml does not run a whole-document regular expression', () => {
  const xml = generatedListing(1_000);
  const expected = regexOracle(xml);
  const execSpy = jest.spyOn(RegExp.prototype, 'exec');
  const matchSpy = jest.spyOn(RegExp.prototype, Symbol.match);

  let parsed: ReturnType<typeof parseListXml>;
  try {
    parsed = parseListXml(xml);
  } finally {
    const execInputs = execSpy.mock.calls.map(([input]) => input);
    const matchInputs = matchSpy.mock.calls.map(([input]) => input);
    execSpy.mockRestore();
    matchSpy.mockRestore();
    expect(execInputs.some((input) => typeof input === 'string' && input.length === xml.length))
      .toBe(false);
    expect(matchInputs.some((input) => typeof input === 'string' && input.length === xml.length))
      .toBe(false);
  }
  expect(parsed!).toEqual(expected);
});

test('listObjects puts the continuation token on the wire', async () => {
  let captured: string | null = null;
  const fetchImpl = async (url: string) => {
    captured = url;
    return new Response('<ListBucketResult></ListBucketResult>', { status: 200 });
  };
  const t = createS3Transport(creds, { fetchImpl, now });
  await t.listObjects('assets/', 'tok');
  expect(captured!).toContain('continuation-token=tok');
});

test('listObjects strictly RFC 3986-encodes query values and sorts by key', async () => {
  let captured: string | null = null;
  const fetchImpl = async (url: string) => {
    captured = url;
    return new Response('<ListBucketResult></ListBucketResult>', { status: 200 });
  };
  const t = createS3Transport(creds, { fetchImpl, now });
  await t.listObjects("assets/(a*b)/!'", undefined);
  expect(captured!).toBe(
    'https://s3.example.com/b' +
    '?list-type=2&prefix=assets%2F%28a%2Ab%29%2F%21%27',
  );
});

test('getObject that never responds rejects as a connect-phase network timeout', async () => {
  jest.useFakeTimers();
  try {
    const fetchImpl = () => new Promise<Response>(() => {}); // never resolves
    const t = createS3Transport(creds, { fetchImpl, now, connectMs: 1000 });
    const p = t.getObject('k');
    const assertion = expect(p).rejects.toMatchObject({
      category: 'network',
      outcomeKnown: false,
      message: expect.stringContaining('timed out'),
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

test('a streaming body that keeps making progress within the stall window never times out, even past the old fixed deadline', async () => {
  jest.useFakeTimers();
  try {
    // Root cause (spec §1 F4): a slow-but-progressing transfer is healthy; only
    // the flat 60s deadline turned it into a "failure". Seven 10s-spaced chunks
    // (70s total) exceed both the old 60s deadline and the 30s connect bound,
    // yet no single gap reaches the 20s stall window, so the read must survive.
    const fetchImpl = async () => streamingResponse(7, 10_000);
    const t = createS3Transport(creds, { fetchImpl, now }); // default connect 30s / stall 20s
    const p = t.getObject('k');
    for (let n = 0; n < 8; n += 1) {
      await jest.advanceTimersByTimeAsync(10_000);
    }
    const got = await p;
    expect(got).not.toBeNull();
    expect(got!.etag).toBe('"e"');
    expect(got!.body.byteLength).toBe(7);
  } finally {
    jest.useRealTimers();
  }
});

test('a streaming body that stops making progress for longer than the stall window times out', async () => {
  jest.useFakeTimers();
  try {
    // One chunk arrives, then the stream goes silent. abort() alone cannot make
    // a buffered read reject, so the per-chunk stall watchdog is what rescues it.
    let served = false;
    const reader = {
      read: () =>
        new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
          if (served) return; // stalls forever after the first chunk
          served = true;
          setTimeout(() => resolve({ done: false, value: new Uint8Array([1]) }), 1_000);
        }),
      cancel: () => Promise.resolve(),
    };
    const fetchImpl = async () =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ etag: '"e"' }),
        body: { getReader: () => reader },
        arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
      }) as unknown as Response;
    const t = createS3Transport(creds, { fetchImpl, now, stallMs: 5_000 });
    const p = t.getObject('k');
    const assertion = expect(p).rejects.toMatchObject({
      category: 'network',
      outcomeKnown: false,
      message: expect.stringContaining('stalled'),
    });
    await jest.advanceTimersByTimeAsync(1_000); // first chunk → stall timer armed
    await jest.advanceTimersByTimeAsync(5_000); // no more progress → stall fires
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

test('a body read that never makes progress times out on the stall window (buffered fallback)', async () => {
  jest.useFakeTimers();
  try {
    // No stream body (a fake / an environment without getReader): the buffered
    // arrayBuffer() read is wrapped in one stall window instead.
    const hangingBody = {
      status: 200,
      ok: true,
      headers: new Headers({ etag: '"e"' }),
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
    } as unknown as Response;
    const fetchImpl = async () => hangingBody;
    const t = createS3Transport(creds, { fetchImpl, now, stallMs: 1000 });
    const p = t.getObject('k');
    const assertion = expect(p).rejects.toMatchObject({ category: 'network' });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

test('a timed-out request aborts the underlying fetch (best-effort cleanup)', async () => {
  jest.useFakeTimers();
  try {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {}); // never resolves
    };
    const t = createS3Transport(creds, { fetchImpl, now, connectMs: 1000 });
    const p = t.getObject('k');
    const assertion = expect(p).rejects.toMatchObject({ category: 'network' });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(seenSignal?.aborted).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('a fast request clears its timers (no leaked timer)', async () => {
  jest.useFakeTimers();
  try {
    const fetchImpl = async () =>
      new Response(new Uint8Array([1]), { status: 200, headers: { etag: '"e"' } });
    const t = createS3Transport(creds, { fetchImpl, now, connectMs: 1000, stallMs: 1000 });
    await t.getObject('k');
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('listObjects that never responds times out as a network error', async () => {
  jest.useFakeTimers();
  try {
    const fetchImpl = () => new Promise<Response>(() => {});
    const t = createS3Transport(creds, { fetchImpl, now, connectMs: 1000 });
    const p = t.listObjects('assets/', undefined);
    const assertion = expect(p).rejects.toMatchObject({ category: 'network' });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

test('putObject and deleteObject also time out when the request hangs', async () => {
  jest.useFakeTimers();
  try {
    const fetchImpl = () => new Promise<Response>(() => {});
    const t = createS3Transport(creds, { fetchImpl, now, connectMs: 1000 });
    const put = t.putObject('k', new Uint8Array([1]), {});
    const del = t.deleteObject('k');
    const a1 = expect(put).rejects.toMatchObject({ category: 'network', outcomeKnown: false });
    const a2 = expect(del).rejects.toMatchObject({ category: 'network', outcomeKnown: false });
    await jest.advanceTimersByTimeAsync(1000);
    await a1; await a2;
  } finally {
    jest.useRealTimers();
  }
});

test('listObjects whose body read never makes progress times out (buffered fallback)', async () => {
  jest.useFakeTimers();
  try {
    // Mirrors the getObject body-stall discriminator for the LIST path, which
    // has no stream body in this fake: headers arrive, text() never resolves.
    const hangingBody = {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => new Promise<string>(() => {}),
    } as unknown as Response;
    const fetchImpl = async () => hangingBody;
    const t = createS3Transport(creds, { fetchImpl, now, stallMs: 1000 });
    const p = t.listObjects('assets/', undefined);
    const assertion = expect(p).rejects.toMatchObject({ category: 'network' });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  } finally {
    jest.useRealTimers();
  }
});

// --- K6-2: file-backed PUT with real byte progress --------------------------
// `expo/fetch` reports no upload progress, so a blob PUT that must drive the
// owner's percentage ring goes through a native upload task instead. The task
// itself is an injected port here; `s3-file-transfer.test.ts` proves the real
// `expo-file-system` adapter behind it.

type UploadRequest = {
  url: string;
  fileUri: string;
  headers: Record<string, string>;
  onProgress?: (progress: { bytesSent: number; totalBytes: number }) => void;
  signal?: AbortSignal;
};

function recordingUpload(
  respond: (request: UploadRequest) => Promise<{ status: number; headers: Record<string, string> }>,
) {
  const requests: UploadRequest[] = [];
  const uploadFile = async (request: UploadRequest) => {
    requests.push(request);
    return respond(request);
  };
  return { requests, uploadFile };
}

const okUpload = recordingUpload;

test('putObjectFromFile signs the hash it is given and returns the etag', async () => {
  const { requests, uploadFile } = okUpload(async () => ({
    status: 200,
    headers: { etag: '"file-etag"' },
  }));
  const t = createS3Transport(creds, { now, uploadFile });
  const res = await t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
    contentSha256: SHA256_OF_123,
    byteLength: 3,
  });
  expect(res.etag).toBe('"file-etag"');
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('https://s3.example.com/b/blobs/g1');
  expect(requests[0]!.fileUri).toBe('file:///tmp/g1.bin');
  expect(requests[0]!.headers['x-amz-content-sha256']).toBe(SHA256_OF_123);
  expect(requests[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  // fetch derives Host from the URL and WHATWG forbids setting it; the native
  // upload task is the same kind of client, so the signed `host` header must
  // not be replayed on the wire.
  expect(requests[0]!.headers.host).toBeUndefined();
});

test('putObjectFromFile signs exactly what putObject would for the same bytes', async () => {
  // Byte identity between the two write paths is the K6-2 gate: the same key,
  // the same body, the same clock must produce the same Authorization header,
  // or the file path is signing something different from what it uploads.
  let fetched: RequestInit | undefined;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    fetched = init;
    return new Response(null, { status: 200, headers: { etag: '"e"' } });
  };
  const { requests, uploadFile } = okUpload(async () => ({ status: 200, headers: {} }));
  const t = createS3Transport(creds, { now, fetchImpl, uploadFile });
  await t.putObject('blobs/g1', new Uint8Array([1, 2, 3]), {});
  await t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
    contentSha256: await t.hashPayload(new Uint8Array([1, 2, 3])),
    byteLength: 3,
  });
  const viaFetch = fetched!.headers as Record<string, string>;
  expect(requests[0]!.headers.authorization).toBe(viaFetch.authorization);
  expect(requests[0]!.headers['x-amz-content-sha256'])
    .toBe(viaFetch['x-amz-content-sha256']);
});

test('putObjectFromFile forwards content-type into the signed headers', async () => {
  const { requests, uploadFile } = okUpload(async () => ({ status: 200, headers: {} }));
  const t = createS3Transport(creds, { now, uploadFile });
  await t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
    contentSha256: SHA256_OF_123,
    byteLength: 3,
    contentType: 'application/octet-stream',
  });
  expect(requests[0]!.headers['content-type']).toBe('application/octet-stream');
});

test('putObjectFromFile reports the native byte counts unchanged', async () => {
  const seen: { sent: number; total: number }[] = [];
  const { uploadFile } = okUpload(async (request) => {
    request.onProgress?.({ bytesSent: 0, totalBytes: 300 });
    request.onProgress?.({ bytesSent: 120, totalBytes: 300 });
    request.onProgress?.({ bytesSent: 300, totalBytes: 300 });
    return { status: 200, headers: {} };
  });
  const t = createS3Transport(creds, { now, uploadFile });
  await t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
    contentSha256: SHA256_OF_123,
    byteLength: 300,
    onProgress: (progress) => seen.push(progress),
  });
  expect(seen).toEqual([
    { sent: 0, total: 300 },
    { sent: 120, total: 300 },
    { sent: 300, total: 300 },
  ]);
});

test('putObjectFromFile substitutes the known length when the task reports none', async () => {
  const seen: { sent: number; total: number }[] = [];
  const { uploadFile } = okUpload(async (request) => {
    // Android's task reports -1 until it knows the length.
    request.onProgress?.({ bytesSent: 40, totalBytes: -1 });
    request.onProgress?.({ bytesSent: 90, totalBytes: 0 });
    return { status: 200, headers: {} };
  });
  const t = createS3Transport(creds, { now, uploadFile });
  await t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
    contentSha256: SHA256_OF_123,
    byteLength: 300,
    onProgress: (progress) => seen.push(progress),
  });
  expect(seen).toEqual([
    { sent: 40, total: 300 },
    { sent: 90, total: 300 },
  ]);
});

test.each([
  [403, 'credential', true],
  [404, 'not_found', true],
  [412, 'precondition', true],
  [429, 'rate_limited', false],
  [500, 'server', false],
  [400, 'client', true],
])('putObjectFromFile maps %s to the same category putObject would', async (
  status, category, outcomeKnown,
) => {
  const { uploadFile } = okUpload(async () => ({ status, headers: {} }));
  const t = createS3Transport(creds, { now, uploadFile });
  await expect(
    t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
      contentSha256: SHA256_OF_123, byteLength: 3,
    }),
  ).rejects.toMatchObject({ status, category, outcomeKnown });
});

test('putObjectFromFile turns a task rejection into a network S3TransportError', async () => {
  const uploadFile = async () => { throw new Error('socket closed'); };
  const t = createS3Transport(creds, { now, uploadFile });
  await expect(
    t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
      contentSha256: SHA256_OF_123, byteLength: 3,
    }),
  ).rejects.toMatchObject({ status: 0, category: 'network', outcomeKnown: false });
});

test('putObjectFromFile aborts and fails a transfer that stops making progress', async () => {
  jest.useFakeTimers();
  try {
    let aborted = false;
    const uploadFile = async (request: UploadRequest) => {
      request.signal?.addEventListener('abort', () => { aborted = true; });
      request.onProgress?.({ bytesSent: 10, totalBytes: 300 });
      return new Promise<{ status: number; headers: Record<string, string> }>(() => {});
    };
    const t = createS3Transport(creds, { now, uploadFile, stallMs: 1000 });
    const p = t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
      contentSha256: SHA256_OF_123, byteLength: 300,
    });
    const assertion = expect(p).rejects.toMatchObject({
      category: 'network', outcomeKnown: false,
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(aborted).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('a slow but steady upload is never treated as stalled', async () => {
  jest.useFakeTimers();
  try {
    const uploadFile = async (request: UploadRequest) => {
      for (let chunk = 1; chunk <= 5; chunk += 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        request.onProgress?.({ bytesSent: chunk * 60, totalBytes: 300 });
      }
      return { status: 200, headers: { etag: '"slow"' } };
    };
    const t = createS3Transport(creds, { now, uploadFile, stallMs: 1000 });
    const p = t.putObjectFromFile('blobs/g1', 'file:///tmp/g1.bin', {
      contentSha256: SHA256_OF_123, byteLength: 300,
    });
    await jest.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ etag: '"slow"' });
  } finally {
    jest.useRealTimers();
  }
});

test('hashPayload is the transport’s own SHA-256 port', async () => {
  const t = createS3Transport(creds, { now });
  expect(await t.hashPayload(new Uint8Array([1, 2, 3]))).toBe(SHA256_OF_123);
  const injected = createS3Transport(creds, { now, hashPayload: async () => 'deadbeef' });
  expect(await injected.hashPayload(new Uint8Array([1, 2, 3]))).toBe('deadbeef');
});

// --- K6-2: the download half of the ring (spec §2 G5) ----------------------

/** A streamed response whose chunks are delivered immediately, with a length. */
function chunkedResponse(chunks: readonly number[][], contentLength?: number): Response {
  let index = 0;
  const headers = new Headers({ etag: '"e"' });
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength));
  }
  return {
    status: 200,
    ok: true,
    headers,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true };
          const value = new Uint8Array(chunks[index]!);
          index += 1;
          return { done: false, value };
        },
      }),
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

test('getObject reports bytes received against the announced content length', async () => {
  const fetchImpl = async () => chunkedResponse([[1, 2], [3, 4], [5]], 5);
  const t = createS3Transport(creds, { fetchImpl, now });
  const seen: { sent: number; total: number }[] = [];
  const got = await t.getObject('blobs/g1', { onProgress: (p) => seen.push(p) });
  expect(got!.body).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  expect(seen).toEqual([
    { sent: 2, total: 5 },
    { sent: 4, total: 5 },
    { sent: 5, total: 5 },
  ]);
});

test('getObject falls back to bytes received as the total when no length is sent', async () => {
  const fetchImpl = async () => chunkedResponse([[1, 2], [3]]);
  const t = createS3Transport(creds, { fetchImpl, now });
  const seen: { sent: number; total: number }[] = [];
  await t.getObject('blobs/g1', { onProgress: (p) => seen.push(p) });
  // An unknown total must never read as 0 (which would be a divide-by-zero
  // ring) or as a guess: "as much as has arrived" is the only honest answer.
  expect(seen).toEqual([{ sent: 2, total: 2 }, { sent: 3, total: 3 }]);
});

test('getObject without a progress callback behaves exactly as before', async () => {
  const fetchImpl = async () => chunkedResponse([[7, 8]], 2);
  const t = createS3Transport(creds, { fetchImpl, now });
  await expect(t.getObject('blobs/g1')).resolves.toEqual({
    body: new Uint8Array([7, 8]),
    etag: '"e"',
  });
});

test('a missing object reports no progress at all', async () => {
  const fetchImpl = async () => new Response(null, { status: 404 });
  const t = createS3Transport(creds, { fetchImpl, now });
  const seen: unknown[] = [];
  await expect(
    t.getObject('blobs/g1', { onProgress: (p) => seen.push(p) }),
  ).resolves.toBeNull();
  expect(seen).toEqual([]);
});

test('getObject asks for identity encoding, signed, so the ETag it returns is the object ETag', async () => {
  // Bunny (2026-09-16 gate) gzips JSON bodies when the client accepts it and
  // then answers with a WEAK ETag (`W/"…"`) for the encoded representation.
  // That ETag fed into If-Match is refused (412) and never equals the listing
  // ETag, so every CAS overwrite is rejected and every state.json is re-read.
  // Node's fetch and Android's OkHttp both add `Accept-Encoding: gzip` unless
  // the caller sets the header, so the transport must set it — and sign it.
  let captured: { init?: RequestInit } | null = null;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    captured = { init };
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { etag: '"abc"' } });
  };
  const t = createS3Transport(creds, { fetchImpl, now });
  const got = await t.getObject('assets/a1/state.json');
  expect(got?.etag).toBe('"abc"');
  const headers = captured!.init!.headers as Record<string, string>;
  expect(headers['accept-encoding']).toBe('identity');
  expect(headers.authorization).toMatch(/SignedHeaders=[^,]*\baccept-encoding\b/);
});

test('listObjects drops zero-size directory placeholders (Bunny lists `a/b/` beside `a/b/state.json`)', async () => {
  // Bunny's ListObjectsV2 returns a size-0 entry per "folder" with an empty
  // ETag. The protocol never writes a key ending in `/`, so such an entry is
  // never a BYOS object; a listing consumer must see objects only.
  const xml =
    '<?xml version="1.0"?><ListBucketResult>' +
    '<Contents><Key>assets/</Key><ETag></ETag>' +
    '<LastModified>2026-09-16T07:16:25.684246Z</LastModified><Size>0</Size></Contents>' +
    '<Contents><Key>assets/a1/</Key><ETag></ETag>' +
    '<LastModified>2026-09-16T07:16:25.684246Z</LastModified><Size>0</Size></Contents>' +
    '<Contents><Key>assets/a1/state.json</Key><ETag>&quot;e1&quot;</ETag>' +
    '<LastModified>2026-09-16T07:16:26.000Z</LastModified><Size>12</Size></Contents>' +
    '</ListBucketResult>';
  const t = createS3Transport(creds, {
    fetchImpl: async () => new Response(xml, { status: 200 }),
    now,
  });
  const page = await t.listObjects('assets/', undefined);
  expect(page.objects.map((o) => o.key)).toEqual(['assets/a1/state.json']);
});
