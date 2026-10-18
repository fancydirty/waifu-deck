import { APP_DISTRIBUTION_POLICY, STORE_DISTRIBUTION_POLICY } from '@/features/distribution/distribution-policy';
import {
  createGelbooruDapiEngine,
  type GelbooruDapiEngineConfig,
} from '@/features/providers/engines/gelbooru-dapi-engine';
import { DEFAULT_SETTINGS } from '@/features/settings/settings';

const CRED = { apiKey: 'testkey', userId: '42' };

const post = (overrides: Record<string, unknown> = {}) => ({
  id: 14827736,
  md5: '8f6c95aed882aff4f99df5dfdc1be2ab',
  width: 1837,
  height: 1602,
  rating: 'general',
  file_url: 'https://img4.gelbooru.com/images/8f/6c/x.jpg',
  preview_url: 'https://img4.gelbooru.com/thumbnails/8f/6c/t.jpg',
  sample_url: 'https://img4.gelbooru.com/samples/8f/6c/s.jpg',
  tags: '1girl solo long_hair',
  source: 'https://x.com/artist/status/1',
  ...overrides,
});

const CONFIG: GelbooruDapiEngineConfig<'gelbooru'> = {
  key: 'gelbooru',
  label: 'Gelbooru',
  apiUrl: 'https://gelbooru.com/index.php',
  trustedCdnHosts: ['gelbooru.com'],
  headers: { 'User-Agent': 'WaifuDeck test' },
  responseListKey: 'post',
  md5Field: 'md5',
  maxLimit: 100,
  discoveryLimitCap: 12,
  dominantColor: '#006ffa',
};

const IMAGE_HEADERS = { Referer: 'https://gelbooru.com/' };

function responseFor(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
) {
  const status = options.status ?? 200;
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function requestFor(
  responseBody: unknown,
  headResponse: Response | null = responseFor(null),
  options: { head?: (url: string, init?: RequestInit) => Promise<Response> } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'HEAD') {
      if (options.head) return options.head(url, init);
      return headResponse!;
    }
    return responseFor(responseBody);
  };
  return { fetcher, calls };
}

function jsonFetcher(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      // The engine reads the body via `.text()` (then `JSON.parse`), not
      // `.json()` directly — see the empty-body handling below. Round-trip
      // through JSON.stringify/parse so this mock exercises the same path a
      // real fetch Response does.
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
  };
  return { fetcher, calls };
}

/** A 200 response with a genuinely empty (0-byte) body — not `[]`, not `""`. */
function emptyBodyFetcher(status = 200) {
  const fetcher = async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => '',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }) as unknown as Response;
  return { fetcher };
}

// The plan's core fixtures are landscape (1837×1602); the default orientation is
// 'portrait', which would silently reject every one and mask the parse/auth
// assertions. 'any' lets these tests exercise what they claim (parse, rating,
// auth) instead of the orientation filter — orientation gets its own coverage in
// candidate-filter's suite, not here.
const sfw = { ...DEFAULT_SETTINGS, orientation: 'any' as const };
const mixed = { ...sfw, nsfwMode: 'mixed' as const, nsfwConfirmed: true };

// --- The security-contract core (plan Task 3 Step 1) ---

test('wrapped response ({post:[...]}) parses into candidates with md5/rating/dims/tags', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ '@attributes': { count: 1 }, post: [post()] });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({
    providerKey: 'gelbooru',
    providerItemId: '14827736',
    md5: '8f6c95aed882aff4f99df5dfdc1be2ab',
    width: 1837,
    height: 1602,
    contentRating: 'safe',
    nativeRating: 'general',
    isNsfw: false,
    tags: ['1girl', 'solo', 'long_hair'],
  });
});

test('bare-array response (the Rule34 shape) parses identically', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher([post()]);
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(1);
});

test("configurable md5Field reads Rule34's `hash` name", async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, md5Field: 'hash' });
  const raw = post({ hash: 'a'.repeat(32) }) as Record<string, unknown>;
  delete raw.md5;
  const { fetcher } = jsonFetcher([raw]);
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items[0]?.md5).toBe('a'.repeat(32));
});

test('credential is appended to the request URL and never to thrown messages', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher, calls } = jsonFetcher({ '@attributes': {}, post: [] });
  await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(calls[0]).toContain('api_key=testkey');
  expect(calls[0]).toContain('user_id=42');
});

test('AUTH GUARD form 1: top-level string body throws typed auth failure, never empty', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher(
    'Missing authentication. Go to api.rule34.xxx for more information',
  );
  await expect(
    engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    }),
  ).rejects.toMatchObject({ code: 'auth' });
});

test('AUTH GUARD form 1: the thrown auth message never leaks the credential', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher('Missing authentication');
  let message = '';
  try {
    await engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    });
    throw new Error('expected an auth failure to be thrown');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toContain('testkey');
  // '42' is the userId; assert against the credential-bearing query fragment so
  // an incidental digit in the label/message can't false-pass this guard.
  expect(message).not.toContain('user_id=42');
});

test('AUTH GUARD form 2: object-wrapped error (unwrap yields non-array) throws, never silent empty', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ error: 'Missing authentication' });
  await expect(
    engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    }),
  ).rejects.toMatchObject({ code: expect.stringMatching(/^(auth|invalid_response)$/) });
});

test('legit-empty ({post:[]}, {"@attributes"-only}, and []) is an empty batch, not a failure', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  for (const body of [
    { '@attributes': {}, post: [] },
    { '@attributes': { count: 0 } }, // real Gelbooru zero-result shape: no `post` key
    [],
  ]) {
    const { fetcher } = jsonFetcher(body);
    const batch = await engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    });
    expect(batch).toMatchObject({ items: [], totalCount: 0 });
  }
});

test('legit-empty: a genuinely empty (0-byte) HTTP-200 body is an empty batch, not invalid_response (G4b task3 finding)', async () => {
  // Live-confirmed on Rule34.xxx 2026-09-05: a zero-result DAPI query (its
  // `general`-rated corpus for a common tag can be empty) returns HTTP 200
  // with a truly empty body — not `[]`, not `{"@attributes":...}`. That body
  // is not valid JSON at all, so a naive `response.json()` throws
  // `SyntaxError: Unexpected end of JSON input`, which the engine previously
  // surfaced as a spurious `invalid_response` failure instead of the
  // legitimate empty batch this case actually is.
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = emptyBodyFetcher();
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch).toMatchObject({ items: [], totalCount: 0 });
});

test('FAIL-SAFE: unknown rating rejects the post — never maps to safe', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ rating: 'brand_new_rating' }), post({ id: 2, rating: 'general' })],
  });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items.map((i) => i.providerItemId)).toEqual(['2']);
});

test('FAIL-SAFE: an unknown rating is dropped even under nsfwMode:all-equivalent (mixed)', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  // Under 'mixed' every mapped rating is admitted; only the fail-safe drop can
  // remove the unknown-rating post. Proves the reject is in the rating map, not
  // an incidental sfw content-mode filter.
  const { fetcher } = jsonFetcher({
    post: [post({ id: 1, rating: 'general' }), post({ id: 2, rating: '??? unmapped' })],
  });
  const batch = await engine.fetchBatch({
    settings: mixed,
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items.map((i) => i.providerItemId)).toEqual(['1']);
});

test('rating vocab maps: general/safe→safe-tier; sensitive/questionable→mid; explicit→explicit; sfw admits only general/safe', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [
      post({ id: 1, rating: 'general' }),
      post({ id: 2, rating: 'safe' }),
      post({ id: 3, rating: 'sensitive' }),
      post({ id: 4, rating: 'questionable' }),
      post({ id: 5, rating: 'explicit' }),
    ],
  });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 10,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items.map((i) => i.providerItemId).sort()).toEqual(['1', '2']);
});

test('rating vocab under mixed: sensitive→suggestive, questionable→nsfw_unspecified, explicit→explicit', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [
      post({ id: 3, rating: 'sensitive' }),
      post({ id: 4, rating: 'questionable' }),
      post({ id: 5, rating: 'explicit' }),
    ],
  });
  const batch = await engine.fetchBatch({
    settings: mixed,
    excludedIds: [],
    count: 10,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  const byId = new Map(batch.items.map((i) => [i.providerItemId, i.contentRating]));
  expect(byId.get('3')).toBe('suggestive');
  expect(byId.get('4')).toBe('nsfw_unspecified');
  expect(byId.get('5')).toBe('explicit');
});

test('works with the Buffer global removed (device-runtime contract)', async () => {
  const saved = (globalThis as { Buffer?: unknown }).Buffer;
  delete (globalThis as { Buffer?: unknown }).Buffer;
  try {
    const engine = createGelbooruDapiEngine(CONFIG);
    const { fetcher } = jsonFetcher({ post: [post()] });
    const batch = await engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    });
    expect(batch.items).toHaveLength(1);
  } finally {
    (globalThis as { Buffer?: unknown }).Buffer = saved;
  }
});

// --- The standing engine-test matrix (ported from safebooru/danbooru idioms) ---

test('keyless call omits the auth params but still builds a valid DAPI query', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher, calls } = jsonFetcher({ '@attributes': {}, post: [] });
  await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(calls[0]).toContain('page=dapi');
  expect(calls[0]).toContain('json=1');
  expect(calls[0]).not.toContain('api_key');
  expect(calls[0]).not.toContain('user_id');
});

test('sfw query uses rating:general (the live tag), not the deprecated rating:safe', () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const url = engine.buildUrl(sfw, 12, APP_DISTRIBUTION_POLICY, 0, CRED);
  const tags = new URL(url).searchParams.get('tags')?.split(' ') ?? [];
  expect(tags).toContain('rating:general');
  expect(tags).not.toContain('rating:safe');
});

test.each(['cosplay', 'photo', 'real_person', 'loli', 'shota'])(
  'drops the hard-exclusion tag %s client-side even when the server returned it',
  async (tag) => {
    const engine = createGelbooruDapiEngine(CONFIG);
    const { fetcher } = jsonFetcher({ post: [post({ tags: `1girl ${tag}` })] });
    const batch = await engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    });
    expect(batch).toMatchObject({ items: [], totalCount: 1 });
  },
);

test('rejects an image URL outside the trusted CDN host', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ post: [post({ file_url: 'https://evil.example/x.jpg' })] });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch).toMatchObject({ items: [], totalCount: 1 });
});

test('accepts CDN subdomains of a trusted host (img4.gelbooru.com under gelbooru.com)', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ file_url: 'https://img3.gelbooru.com/images/aa/bb/y.png' })],
  });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]?.extension).toBe('.png');
});

test('rejects a disallowed image extension', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ file_url: 'https://img4.gelbooru.com/images/8f/6c/x.bmp' })],
  });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch).toMatchObject({ items: [], totalCount: 1 });
});

test('suppresses a post whose id is in excludedIds', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ post: [post({ id: 14827736 })] });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: ['14827736'],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(0);
});

test('clamps an oversized count to the discovery limit cap', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher, calls } = jsonFetcher({ '@attributes': {}, post: [] });
  await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 999,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(new URL(calls[0]!).searchParams.get('limit')).toBe('12');
});

test('a non-safe rating under the Store policy is dropped even on a safe query', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ post: [post({ rating: 'explicit' })] });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: STORE_DISTRIBUTION_POLICY,
  });
  expect(batch).toMatchObject({ items: [], totalCount: 1 });
});

test('a stalled request aborts with a typed timeout error', async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, requestTimeoutMs: 20 });
  const fetcher = () => new Promise<Response>(() => {}); // never resolves
  await expect(
    engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    }),
  ).rejects.toMatchObject({ code: 'timeout' });
});

test('an animated post with no size is probed and takes the Content-Length', async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const { fetcher, calls } = requestFor(
    { post: [post({ id: 701, file_url: 'https://img4.gelbooru.com/images/aa/bb/701.gif' })] },
    responseFor(null, { headers: { 'content-length': '3210' } }),
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items[0]).toMatchObject({ providerItemId: '701', byteSize: 3210 });
  expect(calls.filter(({ init }) => init?.method === 'HEAD')).toEqual([
    expect.objectContaining({
      url: 'https://img4.gelbooru.com/images/aa/bb/701.gif',
      init: { method: 'HEAD', headers: IMAGE_HEADERS, signal: expect.any(AbortSignal) },
    }),
  ]);
});

test("a caller abort during the probes rejects the batch as aborted", async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const caller = new AbortController();
  let signalHeadStarted!: () => void;
  const headStarted = new Promise<void>((resolve) => {
    signalHeadStarted = resolve;
  });
  const { fetcher } = requestFor(
    { post: [post({ id: 709, file_url: 'https://img4.gelbooru.com/images/aa/bb/709.gif' })] },
    responseFor(null),
    {
      head: async (_url, _init) => {
        signalHeadStarted();
        return new Promise<Response>(() => {});
      },
    },
  );
  const batch = engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 3,
    signal: caller.signal,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  await headStarted;
  caller.abort();
  await expect(batch).rejects.toMatchObject({ code: 'aborted' });
});

test("a page's probes run at once", async () => {
  const engine = createGelbooruDapiEngine({
    ...CONFIG,
    imageHeaders: IMAGE_HEADERS,
    probeTimeoutMs: 20,
  });
  let inFlight = 0;
  let peakInFlight = 0;
  let headCount = 0;
  let releaseProbes!: () => void;
  const probesReleased = new Promise<void>((resolve) => {
    releaseProbes = resolve;
  });
  const { fetcher } = requestFor(
    {
      post: [
        post({ id: 710, file_url: 'https://img4.gelbooru.com/images/aa/bb/710.gif' }),
        post({ id: 711, file_url: 'https://img4.gelbooru.com/images/aa/bb/711.gif' }),
      ],
    },
    responseFor(null),
    {
      head: async (url) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        headCount += 1;
        if (headCount === 2) releaseProbes();
        await probesReleased;
        inFlight -= 1;
        return responseFor(null, {
          headers: { 'content-length': url.includes('/710.gif') ? '7100' : '7110' },
        });
      },
    },
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(peakInFlight).toBe(2);
  expect(batch.items.map((item) => item.byteSize)).toEqual([7100, 7110]);
});

test('a still post is not probed when maxBytes is unset', async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const { fetcher, calls } = requestFor({ post: [post({ id: 702 })] });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]?.byteSize).toBe(0);
  expect(calls.some(({ init }) => init?.method === 'HEAD')).toBe(false);
});

test('with maxBytes set, a probed oversize post is filtered from Discover', async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const { fetcher } = requestFor(
    { post: [post({ id: 703 })] },
    responseFor(null, { headers: { 'content-length': '2000001' } }),
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, maxBytes: 2_000_000 },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items).toEqual([]);
});

test('with maxBytes set, a probed oversize post is filtered from search', async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const { fetcher } = requestFor(
    [post({ id: 704 })],
    responseFor(null, { headers: { 'content-length': '2000001' } }),
  );
  const page = await engine.fetchSearchPage({
    request: {
      tags: [],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 2_000_000,
    },
    cursor: { page: 0 },
    limit: 3,
    fetcher,
  });

  expect(page.items).toEqual([]);
});

test.each([
  ['non-2xx', responseFor(null, { status: 503 }), undefined],
  ['missing header', responseFor(null), undefined],
  ['network error', null, new Error('offline')],
] as const)('a failed probe keeps the post with size 0 (%s)', async (_label, head, error) => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const { fetcher } = requestFor(
    { post: [post({ id: 705 })] },
    head ?? responseFor(null),
    error ? { head: async () => Promise.reject(error) } : {},
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, maxBytes: 2_000_000 },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]?.byteSize).toBe(0);
});

test('a non-2xx probe answer never becomes a size even when ok is true', async () => {
  const engine = createGelbooruDapiEngine({ ...CONFIG, imageHeaders: IMAGE_HEADERS });
  const { fetcher } = requestFor(
    { post: [post({ id: 708 })] },
    {
      ok: true,
      status: 503,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '7080' : null },
    } as unknown as Response,
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, maxBytes: 2_000_000 },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]?.byteSize).toBe(0);
});

test('a failed probe keeps the post with size 0 when the probe times out', async () => {
  const engine = createGelbooruDapiEngine({
    ...CONFIG,
    imageHeaders: IMAGE_HEADERS,
    probeTimeoutMs: 10,
  });
  const { fetcher } = requestFor(
    { post: [post({ id: 706 })] },
    responseFor(null),
    { head: async () => new Promise<Response>(() => {}) },
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, maxBytes: 2_000_000 },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]?.byteSize).toBe(0);
});

test('a slow probe does not time out the batch', async () => {
  const engine = createGelbooruDapiEngine({
    ...CONFIG,
    imageHeaders: IMAGE_HEADERS,
    requestTimeoutMs: 10,
    probeTimeoutMs: 100,
  });
  const { fetcher } = requestFor(
    { post: [post({ id: 707 })] },
    responseFor(null, { headers: { 'content-length': '7070' } }),
    { head: async () => new Promise((resolve) => setTimeout(() => resolve(responseFor(null, { headers: { 'content-length': '7070' } })), 25)) },
  );
  const batch = await engine.fetchBatch({
    settings: { ...sfw, maxBytes: 10_000_000 },
    excludedIds: [],
    count: 3,
    fetcher,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });

  expect(batch.items[0]).toMatchObject({ providerItemId: '707', byteSize: 7070 });
});

test('HTTP 429 becomes a rate_limited error carrying retryAfterMs from Retry-After', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const fetcher = async () =>
    ({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
      json: async () => ({}),
    }) as unknown as Response;
  await expect(
    engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 3,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    }),
  ).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 2_000 });
});

test('a 401 is an auth failure without the URL', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ error: 'bad key' }, 401);
  const error = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  }).catch((reason: unknown) => reason);

  expect(error).toMatchObject({ code: 'auth', status: 401 });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain('https://');
  expect((error as Error).message).not.toContain('api_key=testkey');
});

test('a 403 is not a key rejection', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ error: 'forbidden' }, 403);
  const error = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  }).catch((reason: unknown) => reason);

  expect(error).toMatchObject({ code: 'http', status: 403 });
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain('https://');
  expect((error as Error).message).not.toContain('api_key=testkey');
});

test('an mp4 post is dropped', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ id: 1, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.mp4' })],
  });
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toEqual([]);
  expect(batch.totalCount).toBe(1);
});

test('a webm post is dropped', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ id: 2, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.webm' })],
  });
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toEqual([]);
  expect(batch.totalCount).toBe(1);
});

test('a video post is dropped without losing the rest of the batch', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [
      post({ id: 20 }),
      post({ id: 21, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.mp4' }),
      post({ id: 22, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.webm' }),
      post({ id: 23 }),
    ],
  });
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items.map((item) => item.providerItemId)).toEqual(['20', '23']);
  expect(batch.totalCount).toBe(4);
});

test('a gif post is kept and animated', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ id: 3, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.gif' })],
  });
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({ providerItemId: '3', isAnimated: true });
});

test('classifies animation from a gif extension and from a video/animated tag', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const animated = { ...sfw, animationMode: 'include' as const };
  const { fetcher } = jsonFetcher({
    post: [
      post({ id: 4, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.gif' }),
      post({ id: 5, tags: '1girl animated' }),
      post({ id: 6, tags: '1girl video' }),
      post({ id: 7 }), // still image
    ],
  });
  const batch = await engine.fetchBatch({
    settings: animated,
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  const byId = new Map(batch.items.map((i) => [i.providerItemId, i.isAnimated]));
  expect(byId.get('4')).toBe(true);
  expect(byId.get('5')).toBe(true);
  expect(byId.get('6')).toBe(true);
  expect(byId.get('7')).toBe(false);
});

test('a GIF extension is accepted case-insensitively', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({
    post: [post({ id: 8, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.GIF' })],
  });
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({ providerItemId: '8', isAnimated: true });
});

test('an uppercase animation tag still classifies a still image as animated', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ post: [post({ id: 9, tags: '1girl ViDeO' })] });
  const batch = await engine.fetchBatch({
    settings: { ...sfw, animationMode: 'include' },
    excludedIds: [],
    count: 5,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({ providerItemId: '9', isAnimated: true });
});

test('a page of video posts yields no hits but keeps its next cursor', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const page = await engine.fetchSearchPage({
    request: {
      tags: [],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    },
    cursor: { page: 0 },
    limit: 2,
    fetcher: jsonFetcher([
      post({ id: 10, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.mp4' }),
      post({ id: 11, file_url: 'https://img4.gelbooru.com/images/8f/6c/x.webm' }),
    ]).fetcher,
    credential: CRED,
  });
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toEqual({ page: 1 });
});

test('search page: a full page advances the cursor; a short page exhausts it', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const request = {
    tags: [] as string[],
    excludedTags: [] as string[],
    nsfwMode: 'sfw' as const,
    orientation: 'any' as const,
    animationMode: 'include' as const,
    minWidth: 0 as const,
    maxBytes: 0 as const,
  };

  const full = jsonFetcher(
    Array.from({ length: 3 }, (_, index) => post({ id: 100 + index })),
  );
  const fullPage = await engine.fetchSearchPage({
    request,
    cursor: { page: 0 },
    limit: 3,
    fetcher: full.fetcher,
    credential: CRED,
  });
  expect(fullPage.items).toHaveLength(3);
  expect(fullPage.nextCursor).toEqual({ page: 1 });

  const short = jsonFetcher([post({ id: 200 })]);
  const shortPage = await engine.fetchSearchPage({
    request,
    cursor: { page: 1 },
    limit: 3,
    fetcher: short.fetcher,
    credential: CRED,
  });
  expect(shortPage.items).toHaveLength(1);
  expect(shortPage.nextCursor).toBeNull();
});

test('search page passes the credential into the request URL', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher, calls } = jsonFetcher([]);
  await engine.fetchSearchPage({
    request: {
      tags: [],
      excludedTags: [],
      nsfwMode: 'sfw',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    },
    cursor: { page: 0 },
    limit: 5,
    fetcher,
    credential: CRED,
  });
  expect(calls[0]).toContain('api_key=testkey');
  expect(calls[0]).toContain('user_id=42');
});

test('preserves Chinese and source-native query syntax instead of translating or slugifying', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher, calls } = jsonFetcher({ post: [post()] });
  const result = await engine.fetchSearchPage({
    request: {
      tags: ['福瑞 id:1,2 -bar MiXeD-case'],
      excludedTags: [],
      nsfwMode: 'mixed',
      orientation: 'any',
      animationMode: 'include',
      minWidth: 0,
      maxBytes: 0,
    },
    fetcher,
    credential: CRED,
  });

  expect(new URL(calls[0]!).searchParams.get('tags'))
    .toBe('福瑞 id:1,2 -bar MiXeD-case -cosplay -cosplayer -photo -photography -real_life -real_person -loli -shota');
  expect(result.items).toHaveLength(1);
});

test('R8.18: sample_url becomes the display sampleUrl', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher } = jsonFetcher({ '@attributes': { count: 1 }, post: [post()] });
  const batch = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(batch.items[0]?.sampleUrl).toBe('https://img4.gelbooru.com/samples/8f/6c/s.jpg');

  const { fetcher: noSample } = jsonFetcher({
    post: [post({ sample_url: undefined })],
  });
  const fallback = await engine.fetchBatch({
    settings: sfw,
    excludedIds: [],
    count: 3,
    fetcher: noSample,
    credential: CRED,
    distributionPolicy: APP_DISTRIBUTION_POLICY,
  });
  expect(fallback.items[0]?.sampleUrl).toBe('https://img4.gelbooru.com/images/8f/6c/x.jpg');
});

test('R8.24: a search hit previews the sample, falling back to the original', async () => {
  const engine = createGelbooruDapiEngine(CONFIG);
  const request = {
    tags: [],
    excludedTags: [],
    nsfwMode: 'mixed' as const,
    orientation: 'any' as const,
    animationMode: 'include' as const,
    minWidth: 0 as const,
    maxBytes: 0 as const,
  };

  const withSample = jsonFetcher({ post: [post()] });
  const sampled = await engine.fetchSearchPage({
    request,
    cursor: { page: 0 },
    limit: 1,
    fetcher: withSample.fetcher,
    credential: CRED,
  });
  // A grid tile must render the medium sample, never the full-size original.
  expect(sampled.items[0]?.previewUrl).toBe('https://img4.gelbooru.com/samples/8f/6c/s.jpg');

  const withoutSample = jsonFetcher({ post: [post({ sample_url: undefined })] });
  const fallback = await engine.fetchSearchPage({
    request,
    cursor: { page: 0 },
    limit: 1,
    fetcher: withoutSample.fetcher,
    credential: CRED,
  });
  expect(fallback.items[0]?.previewUrl).toBe('https://img4.gelbooru.com/images/8f/6c/x.jpg');
});

// ---------------------------------------------------------------------------
// K7 ㉑ — discovery must be able to reach the corpus, not just its newest page.
// ---------------------------------------------------------------------------

async function discoveryPid(randomValue: number): Promise<number> {
  const engine = createGelbooruDapiEngine(CONFIG);
  const { fetcher, calls } = jsonFetcher([post()]);
  const random = jest.spyOn(Math, 'random').mockReturnValue(randomValue);
  try {
    await engine.fetchBatch({
      settings: sfw,
      excludedIds: [],
      count: 8,
      fetcher,
      credential: CRED,
      distributionPolicy: APP_DISTRIBUTION_POLICY,
    });
  } finally {
    random.mockRestore();
  }
  return Number(new URL(calls[0]!).searchParams.get('pid'));
}

test('K7 ㉑ discovery samples across a thousand pages, not the newest twenty', async () => {
  // With the old span of 20 these would have been 10 and 19 — i.e. never past
  // the ~240 newest posts, which the exclusion list exhausts within a session.
  expect(await discoveryPid(0.5)).toBe(500);
  expect(await discoveryPid(0.999_9)).toBe(999);
  expect(await discoveryPid(0)).toBe(0);
});
