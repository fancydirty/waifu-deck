import { danbooruContentRating } from "@/features/content/content-taxonomy";
import { DIRECT_DISTRIBUTION_POLICY } from "@/features/distribution/distribution-policy";
import { DEFAULT_SETTINGS } from "@/features/settings/settings";
import type { SearchRequest } from "@/features/search/types";
import type { AppSettings, ImageCandidate } from "@/features/waifu/types";

import {
  createDanbooruEngine,
  DanbooruApiError,
  trustedImageUrl,
  type DanbooruEngineConfig,
  type DanbooruParseContext,
} from "./danbooru-engine";

// A test-only Danbooru-family instance. A fake host/label proves the engine is
// driven entirely by its config (URLs, headers, rating vocab, retryable set,
// and the flat parseCandidate hook), not by any hard-coded Danbooru constant.
// The key stays 'danbooru' so it maps to a real provider union member (no
// governor is injected, so the governor key is never exercised).
const TEST_CDN_HOST = "cdn.example-booru.test";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A flat post-schema mapping mirroring Danbooru's shape: throws for missing
// fields, returns 'reject' for a disallowed extension (skip signal), and reads
// media_asset.duration to flag animation. Reads its trusted hosts, allowed
// extensions, and rating vocabulary from the engine-supplied `ctx`, proving the
// config surface is genuinely threaded rather than captured from a constant.
function testParseCandidate(
  value: unknown,
  ctx: DanbooruParseContext,
): ImageCandidate | "reject" | null {
  if (!isRecord(value)) {
    throw new DanbooruApiError("invalid_response", "Example-Booru bad post");
  }
  const id = value.id;
  const width = value.image_width;
  const height = value.image_height;
  const byteSize = value.file_size;
  const extension =
    typeof value.file_ext === "string" ? value.file_ext.toLowerCase() : null;
  const remoteUrl = trustedImageUrl(value.file_url, ctx.trustedCdnHosts);
  const rating = typeof value.rating === "string" ? value.rating : null;
  if (
    typeof id !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    typeof byteSize !== "number" ||
    extension === null ||
    remoteUrl === null ||
    rating === null ||
    !ctx.ratingAllowed(rating)
  ) {
    throw new DanbooruApiError("invalid_response", "Example-Booru incomplete");
  }
  if (!ctx.allowedExtensions.has(extension)) return "reject";
  const duration =
    isRecord(value.media_asset) &&
    typeof value.media_asset.duration === "number"
      ? value.media_asset.duration
      : 0;
  const contentRating = ctx.toContentRating(rating);
  return {
    providerKey: "danbooru",
    providerItemId: String(id),
    canonicalSourceKey: null,
    perceptualHash: null,
    md5: null,
    remoteUrl,
    sourceUrl: null,
    artistName: null,
    artistUrl: null,
    width,
    height,
    byteSize,
    extension: `.${extension}`,
    dominantColor: "#123456",
    contentRating,
    nativeRating: rating,
    isNsfw: contentRating !== "safe",
    isAnimated: extension === "gif" || duration > 0,
    tags: (typeof value.tag_string === "string" ? value.tag_string : "")
      .split(/\s+/)
      .filter(Boolean),
  };
}

const TEST_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "png",
  "gif",
]);
const TEST_RATING_VOCAB = {
  allowed: new Set<string>(["g", "s", "q", "e"]),
  toContentRating: (rating: string) =>
    danbooruContentRating(rating as "g" | "s" | "q" | "e"),
  sfwQueryTag: "rating:general",
  nsfwQueryTag: "is:nsfw",
};

const TEST_CONFIG: DanbooruEngineConfig<"danbooru"> = {
  key: "danbooru",
  label: "Example-Booru",
  postsUrl: "https://example-booru.test/posts.json",
  randomUrl: "https://example-booru.test/posts/random.json",
  trustedCdnHosts: [TEST_CDN_HOST],
  headers: { Accept: "application/json" },
  allowedExtensions: TEST_ALLOWED_EXTENSIONS,
  ratingVocab: TEST_RATING_VOCAB,
  parseCandidate: testParseCandidate,
  parsePreviewUrl: (raw, candidate, ctx) =>
    isRecord(raw)
      ? (trustedImageUrl(raw.preview_file_url, ctx.trustedCdnHosts) ??
        candidate.remoteUrl)
      : candidate.remoteUrl,
  // 503 alongside 429 proves requestJson maps a config-supplied retryable status,
  // not a hard-coded 429, to `rate_limited`.
  retryableStatuses: new Set([429, 503]),
};

const engine = createDanbooruEngine(TEST_CONFIG);

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers({}),
    json: async () => body,
  } as unknown as Response;
}

// A recorded flat `posts.json` element (only the fields the mapping consumes).
function recordedPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    image_width: 1000,
    image_height: 1500,
    file_size: 250_000,
    file_ext: "png",
    file_url: `https://${TEST_CDN_HOST}/original/ab/cd/a.png`,
    rating: "g",
    tag_string: "1girl solo blue_hair",
    media_asset: { duration: null },
    ...overrides,
  };
}

// Quality filters neutralized so assertions isolate engine parse/pagination/
// rating behaviour rather than settings filtering.
const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  nsfwMode: "mixed",
  nsfwConfirmed: true,
  orientation: "any",
  animationMode: "include",
  minWidth: 0,
  maxBytes: 0,
  includedTags: [],
  excludedTags: [],
};

const searchRequest: SearchRequest = {
  tags: [],
  excludedTags: [],
  nsfwMode: "mixed",
  orientation: "any",
  animationMode: "include",
  minWidth: 0,
  maxBytes: 0,
};

test("parses a recorded flat post into an ImageCandidate via config.parseCandidate", async () => {
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(jsonResponse(recordedPost())),
  });

  expect(batch.totalCount).toBe(1);
  expect(batch.items[0]).toMatchObject({
    providerKey: "danbooru",
    providerItemId: "42",
    remoteUrl: `https://${TEST_CDN_HOST}/original/ab/cd/a.png`,
    width: 1000,
    height: 1500,
    byteSize: 250_000,
    extension: ".png",
    contentRating: "safe",
    nativeRating: "g",
    isNsfw: false,
    isAnimated: false,
    tags: ["1girl", "solo", "blue_hair"],
  });
});

test("targets config.randomUrl and injects config.ratingVocab.sfwQueryTag under SFW mode", async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse(recordedPost()));
  await engine.fetchBatch({
    settings: { ...settings, nsfwMode: "sfw" },
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe(
    "https://example-booru.test/posts/random.json",
  );
  expect(url.searchParams.get("tags")?.split(" ")).toContain("rating:general");
});

test("maps every native rating through config.ratingVocab.toContentRating", async () => {
  for (const [rating, contentRating] of [
    ["g", "safe"],
    ["s", "suggestive"],
    ["q", "nsfw_unspecified"],
    ["e", "explicit"],
  ] as const) {
    const batch = await engine.fetchBatch({
      settings,
      excludedIds: [],
      count: 1,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest
        .fn()
        .mockResolvedValue(jsonResponse(recordedPost({ rating }))),
    });
    expect(batch.items[0]).toMatchObject({ nativeRating: rating, contentRating });
  }
});

test("treats a config.parseCandidate 'reject' (disallowed extension) as a silent skip", async () => {
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(
      jsonResponse(
        recordedPost({
          file_ext: "webm",
          file_url: `https://${TEST_CDN_HOST}/original/ab/cd/a.webm`,
        }),
      ),
    ),
  });
  expect(batch.items).toEqual([]);
  // `totalCount` is pre-filter (G3 spec §4 item 1): one raw post was seen and
  // then dropped by the extension guard. 1-seen/0-admitted is the yield signal;
  // asserting 0 here would be asserting the old post-filter meaning.
  expect(batch.totalCount).toBe(1);
});

test("derives the keyset cursor from the oldest post and sends page=b{beforeId}", async () => {
  const fetcher = jest.fn().mockResolvedValue(
    jsonResponse([
      recordedPost({
        id: 300,
        file_url: `https://${TEST_CDN_HOST}/original/ab/cd/300.png`,
        preview_file_url: `https://${TEST_CDN_HOST}/180x180/ab/cd/300.png`,
      }),
      recordedPost({
        id: 250,
        file_url: `https://${TEST_CDN_HOST}/original/ab/cd/250.png`,
        preview_file_url: "https://example.com/untrusted-preview.png",
      }),
    ]),
  );

  const page = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: { beforeId: 400 },
    limit: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });

  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe("https://example-booru.test/posts.json");
  expect(url.searchParams.get("page")).toBe("b400");
  expect(page.providerKey).toBe("danbooru");
  expect(page.items.map((hit) => hit.key)).toEqual([
    "danbooru:300",
    "danbooru:250",
  ]);
  // Trusted preview kept; untrusted preview falls back to the candidate remoteUrl.
  expect(page.items[0]?.previewUrl).toBe(
    `https://${TEST_CDN_HOST}/180x180/ab/cd/300.png`,
  );
  expect(page.items[1]?.previewUrl).toBe(
    `https://${TEST_CDN_HOST}/original/ab/cd/250.png`,
  );
  expect(page.nextCursor).toEqual({ beforeId: 250 });
});

test.each(["order:score", "order:id_asc", "ordfav:example", "ordpool:123"])(
  "keeps %s ordering across pages instead of forcing id-descending keysets",
  async (order) => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse([recordedPost({ id: 100 }), recordedPost({ id: 300 })]))
      .mockResolvedValueOnce(jsonResponse([recordedPost({ id: 400 }), recordedPost({ id: 200 })]))
      .mockResolvedValueOnce(jsonResponse([]));
    const request = { ...searchRequest, tags: [`blue_hair ${order}`] };
    const first = await engine.fetchSearchPage({ request, limit: 2, fetcher });
    expect(first.nextCursor).toEqual({ page: 2 });

    const second = await engine.fetchSearchPage({
      request, cursor: first.nextCursor, limit: 2, fetcher,
    });
    expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get("page")).toBe("2");
    expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get("tags"))
      .toBe(`blue_hair ${order}`);
    expect(second.items.map(({ image }) => image.providerItemId)).toEqual(["400", "200"]);
    expect(second.nextCursor).toEqual({ page: 3 });

    const last = await engine.fetchSearchPage({
      request, cursor: second.nextCursor, limit: 2, fetcher,
    });
    expect(last.nextCursor).toBeNull();
  },
);

test("rejects an invalid numbered cursor without sending a different page", async () => {
  await expect(engine.fetchSearchPage({
    request: { ...searchRequest, tags: ["order:score"] },
    cursor: { page: 0 },
    fetcher: async () => jsonResponse([]),
  })).rejects.toMatchObject({ code: "invalid_response" });
});

test("rejects a search page whose oldest id does not advance past the cursor", async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValue(
      jsonResponse([recordedPost({ id: 300 }), recordedPost({ id: 250 })]),
    );

  await expect(
    engine.fetchSearchPage({
      request: searchRequest,
      cursor: { beforeId: 250 },
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher,
    }),
  ).rejects.toMatchObject({
    name: "DanbooruApiError",
    code: "invalid_response",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("maps a config-supplied retryable status (503) to rate_limited with retry metadata", async () => {
  const fetcher = jest.fn().mockResolvedValue({
    ...jsonResponse({}, 503),
    headers: headers({ "retry-after": "5" }),
  } as Response);

  await expect(
    engine.fetchSearchPage({
      request: searchRequest,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher,
    }),
  ).rejects.toMatchObject({
    code: "rate_limited",
    status: 503,
    retryAfterMs: 5_000,
  });
});

test("exposes DanbooruApiError and throws it on a non-array search payload", async () => {
  expect(engine.ApiError).toBe(DanbooruApiError);
  await expect(
    engine.fetchSearchPage({
      request: searchRequest,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest.fn().mockResolvedValue(jsonResponse({ posts: [] })),
    }),
  ).rejects.toBeInstanceOf(DanbooruApiError);
});

test("short-circuits a null search cursor to an exhausted page without fetching", async () => {
  const fetcher = jest.fn();
  const page = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: null,
    fetcher,
  });
  expect(page).toEqual({ providerKey: "danbooru", items: [], nextCursor: null });
  expect(fetcher).not.toHaveBeenCalled();
});

// --- Wrapped-response instances (responseListKey / responseSingleKey) --------
//
// Danbooru returns `posts.json` as a BARE array and `posts/random.json` as a
// BARE object. The e621 family WRAPS both (`{"posts":[...]}` /
// `{"post":{...}}`), which the G2a-2 Task 4 real-API gate caught: without an
// unwrap every live e621/e926 call threw `invalid_response`, so both sources
// returned zero images in production. These tests pin the unwrap on a wrapped
// config AND pin that a config declaring neither key still behaves exactly as
// before (the Danbooru regression net — `engine`/TEST_CONFIG above sets
// neither, so every test in this file already exercises the bare path).

const wrappedEngine = createDanbooruEngine({
  ...TEST_CONFIG,
  responseListKey: "posts",
  responseSingleKey: "post",
});

test("unwraps a wrapped random post via config.responseSingleKey", async () => {
  const batch = await wrappedEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest
      .fn()
      .mockResolvedValue(jsonResponse({ post: recordedPost({ id: 77 }) })),
  });

  expect(batch.totalCount).toBe(1);
  expect(batch.items[0]).toMatchObject({ providerItemId: "77" });
});

test("unwraps a wrapped search list via config.responseListKey and still paginates", async () => {
  const page = await wrappedEngine.fetchSearchPage({
    request: searchRequest,
    cursor: { beforeId: 400 },
    limit: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(
      jsonResponse({
        posts: [
          recordedPost({
            id: 300,
            file_url: `https://${TEST_CDN_HOST}/original/ab/cd/300.png`,
          }),
          recordedPost({
            id: 250,
            file_url: `https://${TEST_CDN_HOST}/original/ab/cd/250.png`,
          }),
        ],
      }),
    ),
  });

  expect(page.items.map((hit) => hit.key)).toEqual([
    "danbooru:300",
    "danbooru:250",
  ]);
  expect(page.nextCursor).toEqual({ beforeId: 250 });
});

test("a wrapped instance still rejects a payload missing its list key", async () => {
  await expect(
    wrappedEngine.fetchSearchPage({
      request: searchRequest,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest.fn().mockResolvedValue(jsonResponse({ results: [] })),
    }),
  ).rejects.toMatchObject({
    name: "DanbooruApiError",
    code: "invalid_response",
  });
});

test("an unwrapped (Danbooru) instance keeps consuming BARE payloads and never unwraps", async () => {
  // Bare array search payload: accepted unchanged.
  const page = await engine.fetchSearchPage({
    request: searchRequest,
    cursor: { beforeId: 400 },
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest
      .fn()
      .mockResolvedValue(jsonResponse([recordedPost({ id: 300 })])),
  });
  expect(page.items.map((hit) => hit.key)).toEqual(["danbooru:300"]);

  // Bare random payload: accepted unchanged.
  const batch = await engine.fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest
      .fn()
      .mockResolvedValue(jsonResponse(recordedPost({ id: 88 }))),
  });
  expect(batch.items[0]).toMatchObject({ providerItemId: "88" });

  // A WRAPPED payload must NOT be silently unwrapped by a config that declares
  // no keys — it stays an invalid response, exactly as before this change.
  await expect(
    engine.fetchSearchPage({
      request: searchRequest,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest
        .fn()
        .mockResolvedValue(jsonResponse({ posts: [recordedPost()] })),
    }),
  ).rejects.toMatchObject({
    name: "DanbooruApiError",
    code: "invalid_response",
  });
});

// ---------------------------------------------------------------------------
// K7 ⑯ — N random posts must cost ONE request, not N.
// ---------------------------------------------------------------------------

const randomTagEngine = createDanbooruEngine({
  ...TEST_CONFIG,
  randomSampling: "random-tag",
});

const orderRandomEngine = createDanbooruEngine({
  ...TEST_CONFIG,
  randomSampling: "order-random",
});

function randomPage(count: number): Response {
  return jsonResponse(
    Array.from({ length: count }, (_unused, index) =>
      recordedPost({
        id: index + 1,
        file_url: `https://${TEST_CDN_HOST}/original/ab/cd/${index + 1}.png`,
      }),
    ),
  );
}

test("K7 ⑯ asks for four random posts in ONE posts.json request (random:N)", async () => {
  const fetcher = jest.fn().mockResolvedValue(randomPage(4));

  const batch = await randomTagEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 4,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(fetcher.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe("https://example-booru.test/posts.json");
  expect(url.searchParams.get("tags")?.split(" ")).toContain("random:4");
  expect(url.searchParams.get("limit")).toBe("4");
  expect(batch.items.map((item) => item.providerItemId)).toEqual([
    "1",
    "2",
    "3",
    "4",
  ]);
  expect(batch.totalCount).toBe(4);
});

test("K7 ⑯ an e621-shaped instance asks with order:random and one limit", async () => {
  const fetcher = jest.fn().mockResolvedValue(randomPage(2));

  await orderRandomEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(fetcher.mock.calls[0]![0]);
  const tags = url.searchParams.get("tags")?.split(" ");
  expect(tags).toContain("order:random");
  expect(tags?.some((tag) => tag.startsWith("random:"))).toBe(false);
  expect(url.searchParams.get("limit")).toBe("2");
});

test("K7 ⑯ honours excludedIds and the settings filter on the single request", async () => {
  const fetcher = jest.fn().mockResolvedValue(randomPage(4));

  const batch = await randomTagEngine.fetchBatch({
    settings,
    excludedIds: ["2", "3"],
    count: 4,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });

  expect(batch.items.map((item) => item.providerItemId)).toEqual(["1", "4"]);
  // Pre-filter, exactly as the fan-out path reports it (G3 spec §4 item 1).
  expect(batch.totalCount).toBe(4);
});

test("K7 ⑯ falls back to the single-post fan-out when the query is rejected", async () => {
  const fetcher = jest.fn()
    .mockResolvedValueOnce(
      jsonResponse({ success: false, error: "PostQuery::TagLimitError" }, 422),
    )
    .mockResolvedValue(jsonResponse(recordedPost()));

  const batch = await randomTagEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 4,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledTimes(5);
  expect(new URL(fetcher.mock.calls[0]![0]).pathname).toBe("/posts.json");
  for (const call of fetcher.mock.calls.slice(1)) {
    expect(new URL(call[0]).pathname).toBe("/posts/random.json");
  }
  expect(batch.items.map((item) => item.providerItemId)).toEqual(["42"]);
});

test("K7 ⑯ does NOT spend a fan-out on a 5xx — that is the source failing", async () => {
  const fetcher = jest.fn().mockResolvedValue(jsonResponse({}, 500));

  await expect(randomTagEngine.fetchBatch({
    settings,
    excludedIds: [],
    count: 4,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  })).rejects.toMatchObject({ code: "http", status: 500 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("K7 ⑯ unwraps the random page via config.responseListKey", async () => {
  const fetcher = jest.fn().mockResolvedValue(
    jsonResponse({ posts: [recordedPost({ id: 7 })] }),
  );

  const batch = await createDanbooruEngine({
    ...TEST_CONFIG,
    randomSampling: "order-random",
    responseListKey: "posts",
  }).fetchBatch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(batch.items.map((item) => item.providerItemId)).toEqual(["7"]);
});
