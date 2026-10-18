import { DEFAULT_SETTINGS } from "@/features/settings/settings";
import { DIRECT_DISTRIBUTION_POLICY } from "@/features/distribution/distribution-policy";
import type { AppSettings, ImageCandidate } from "@/features/waifu/types";
import type { SearchRequest } from "@/features/search/types";

import { fetchE621Batch, fetchE621SearchPage } from "./e621-client";

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

// The REAL e621-family API WRAPS its payloads — verified live with curl:
//   GET /posts/random.json -> {"post":{...}}
//   GET /posts.json        -> {"posts":[...]}
// (Danbooru, by contrast, returns both bare.) Every fixture below goes through
// these two helpers so the injected fetcher reproduces the wire shape exactly.
// The original G2a-2 Task 2/3 fixtures fed BARE shapes and were green-but-wrong:
// against the real API every call threw `invalid_response`, so e621/e926
// returned zero images in production until the engine's
// `responseListKey`/`responseSingleKey` unwrap landed.
function randomResponse(body: unknown, status = 200): Response {
  return jsonResponse({ post: body }, status);
}

function listResponse(posts: readonly unknown[], status = 200): Response {
  return jsonResponse({ posts }, status);
}

// A recorded nested e621 `posts.json` element (only the fields the mapping
// consumes). Overrides deep-merge over `file`/`tags`/`flags`.
function post(overrides: Record<string, unknown> = {}) {
  const {
    file: fileOverride,
    tags: tagsOverride,
    flags: flagsOverride,
    ...rest
  } = overrides as {
    file?: Record<string, unknown>;
    tags?: Record<string, unknown>;
    flags?: Record<string, unknown>;
  };
  return {
    id: 4242,
    file: {
      width: 1200,
      height: 1800,
      ext: "jpg",
      size: 456_789,
      md5: "0123456789abcdef0123456789abcdef",
      url: "https://static1.e621.net/data/ab/cd/one.jpg",
      ...fileOverride,
    },
    preview: { url: "https://static1.e621.net/data/preview/ab/cd/one.jpg" },
    sample: { url: "https://static1.e621.net/data/sample/ab/cd/one.jpg" },
    tags: {
      general: ["1girl", "solo"],
      species: ["human"],
      character: ["example_character"],
      copyright: ["example_copyright"],
      artist: ["example_artist"],
      meta: ["highres"],
      lore: ["example_lore"],
      invalid: ["should_not_appear"],
      contributor: ["also_should_not_appear"],
      ...tagsOverride,
    },
    rating: "s",
    flags: { deleted: false, pending: false, flagged: false, ...flagsOverride },
    sources: ["https://www.pixiv.net/en/artworks/998877"],
    ...rest,
  };
}

// Quality filters neutralized so assertions isolate the nested parser.
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

// K7 ⑯: discovery now asks `posts.json?...order:random&limit=N` once, so the
// discovery fixtures below are LIST-shaped. `randomResponse` still describes
// the wire shape of the `posts/random.json` fallback, exercised at the bottom
// of this file.
async function firstCandidate(
  body: unknown,
): Promise<ImageCandidate | undefined> {
  const batch = await fetchE621Batch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(listResponse([body])),
  });
  return batch.items[0];
}

test("maps a nested e621 post and flattens the seven tag namespaces", async () => {
  const candidate = await firstCandidate(post());

  expect(candidate).toMatchObject({
    providerKey: "e621",
    providerItemId: "4242",
    remoteUrl: "https://static1.e621.net/data/ab/cd/one.jpg",
    width: 1200,
    height: 1800,
    byteSize: 456_789,
    extension: ".jpg",
    contentRating: "safe",
    nativeRating: "s",
    isNsfw: false,
    isAnimated: false,
    artistName: "example_artist",
    artistUrl: null,
    sourceUrl: "https://www.pixiv.net/en/artworks/998877",
    canonicalSourceKey: "pixiv:998877",
  });
  expect(candidate?.tags).toEqual([
    "1girl",
    "solo",
    "human",
    "example_character",
    "example_copyright",
    "example_artist",
    "highres",
    "example_lore",
  ]);
});

test("excludes the invalid and contributor namespaces from the tag list", async () => {
  const candidate = await firstCandidate(post());
  expect(candidate?.tags).not.toContain("should_not_appear");
  expect(candidate?.tags).not.toContain("also_should_not_appear");
});

test("reads and lowercases the wrapped file.md5, defaulting to null when absent or empty", async () => {
  // e621's discoveryBatchSize caps the ask at 2 (2 req/s rate limit), so a
  // single fetchBatch call can only observe 2 items here.
  const batch = await fetchE621Batch({
    settings,
    excludedIds: [],
    count: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(listResponse([
      post({ id: 1, file: { md5: "ABCDEF0123456789ABCDEF0123456789" } }),
      post({ id: 2, file: { md5: "" } }),
    ])),
  });

  expect(batch.items.map((item) => item.md5)).toEqual([
    "abcdef0123456789abcdef0123456789",
    null,
  ]);

  const withoutMd5 = await firstCandidate(post({ file: { md5: undefined } }));
  expect(withoutMd5?.md5).toBeNull();
});

test("flags a gif as animated", async () => {
  const candidate = await firstCandidate(
    post({
      file: { ext: "gif", url: "https://static1.e621.net/data/ab/cd/one.gif" },
    }),
  );
  expect(candidate).toMatchObject({ extension: ".gif", isAnimated: true });
});

test("rejects video posts (mp4/webm) as unsupported extensions", async () => {
  const batch = await fetchE621Batch({
    settings,
    excludedIds: [],
    count: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(listResponse([
      post({
        file: {
          ext: "webm",
          url: "https://static1.e621.net/data/ab/cd/one.webm",
        },
      }),
      post({
        id: 4243,
        file: {
          ext: "mp4",
          url: "https://static1.e621.net/data/ab/cd/two.mp4",
        },
      }),
    ])),
  });
  expect(batch.items).toEqual([]);
  // Pre-filter count (G3 spec §4 item 1): both raw posts were seen, both were
  // dropped by the extension guard. 2-seen/0-admitted is the real yield rate —
  // the previous `0` asserted the old post-filter meaning of `totalCount`.
  expect(batch.totalCount).toBe(2);
});

test("rejects deleted, pending, and flagged posts", async () => {
  const batch = await fetchE621Batch({
    settings,
    excludedIds: [],
    count: 3,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(listResponse([
      post({ id: 1, flags: { deleted: true } }),
      post({ id: 2, flags: { pending: true } }),
      post({ id: 3, flags: { flagged: true } }),
    ])),
  });
  expect(batch.items).toEqual([]);
});

// K7 ⑯ rewrote the OUTCOME, not the safety rule: neither post may become a
// candidate. On the one-request page a dirty post is skipped rather than
// failing the whole page (the fan-out could only throw, because one dirty post
// WAS the whole batch there); `totalCount` still counts it as seen.
test("rejects an untrusted image host and an unknown rating", async () => {
  await expect(
    fetchE621Batch({
      settings,
      excludedIds: [],
      count: 1,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest
        .fn()
        .mockResolvedValue(
          listResponse([post({ file: { url: "https://evil.example.com/one.jpg" } })]),
        ),
    }),
  ).resolves.toMatchObject({ items: [], totalCount: 1 });

  await expect(
    fetchE621Batch({
      settings,
      excludedIds: [],
      count: 1,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest.fn().mockResolvedValue(listResponse([post({ rating: "g" })])),
    }),
  ).resolves.toMatchObject({ items: [], totalCount: 1 });
});

describe("fetchE621SearchPage", () => {
  test("sends rating:s under SFW and rating:e under NSFW", async () => {
    const sfwFetcher = jest.fn(async (_url: string) => listResponse([]));
    await fetchE621SearchPage({
      request: { ...searchRequest, nsfwMode: "sfw" },
      fetcher: sfwFetcher,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    });
    expect(
      new URL(sfwFetcher.mock.calls[0]![0]).searchParams
        .get("tags")
        ?.split(" "),
    ).toContain("rating:s");

    const nsfwFetcher = jest.fn(async (_url: string) => listResponse([]));
    await fetchE621SearchPage({
      request: { ...searchRequest, nsfwMode: "nsfw" },
      fetcher: nsfwFetcher,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    });
    expect(
      new URL(nsfwFetcher.mock.calls[0]![0]).searchParams
        .get("tags")
        ?.split(" "),
    ).toContain("rating:e");
  });

  test("prefers preview, then sample, then remoteUrl and paginates by before-id", async () => {
    const fetcher = jest.fn(async (_url: string) =>
      listResponse([
        post({
          id: 300,
          file: { url: "https://static1.e621.net/data/ab/cd/300.jpg" },
          preview: { url: "https://static1.e621.net/data/preview/300.jpg" },
        }),
        post({
          id: 250,
          file: { url: "https://static1.e621.net/data/ab/cd/250.jpg" },
          preview: { url: "https://untrusted.example.com/preview/250.jpg" },
          sample: { url: "https://static1.e621.net/data/sample/250.jpg" },
        }),
        post({
          id: 200,
          file: { url: "https://static1.e621.net/data/ab/cd/200.jpg" },
          preview: { url: "https://untrusted.example.com/preview/200.jpg" },
          sample: { url: "https://untrusted.example.com/sample/200.jpg" },
        }),
      ]),
    );

    const page = await fetchE621SearchPage({
      request: searchRequest,
      cursor: { beforeId: 400 },
      limit: 3,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher,
    });

    const url = new URL(fetcher.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://e621.net/posts.json");
    expect(url.searchParams.get("page")).toBe("b400");
    expect(page.items.map((hit) => hit.previewUrl)).toEqual([
      "https://static1.e621.net/data/preview/300.jpg",
      "https://static1.e621.net/data/sample/250.jpg",
      "https://static1.e621.net/data/ab/cd/200.jpg",
    ]);
    expect(page.nextCursor).toEqual({ beforeId: 200 });
  });

  test("preserves source-native ordering and raw spelling in wrapped e621 search pages", async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(listResponse([post({ id: 100 }), post({ id: 200 })]))
      .mockResolvedValueOnce(listResponse([post({ id: 300 }), post({ id: 400 })]));
    const request = { ...searchRequest, tags: ["福瑞 order:id_asc id:1,2"] };
    const first = await fetchE621SearchPage({ request, fetcher, limit: 2 });
    expect(first.nextCursor).toEqual({ page: 2 });
    const second = await fetchE621SearchPage({
      request, cursor: first.nextCursor, fetcher, limit: 2,
    });

    expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get("page")).toBe("2");
    expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get("tags"))
      .toBe("福瑞 order:id_asc id:1,2");
    expect(second.items.map(({ image }) => image.providerItemId)).toEqual(["300", "400"]);
  });
});

test("R8.18: sample.url becomes the display sampleUrl, else it falls back to remoteUrl", async () => {
  const withSample = await firstCandidate(post());
  expect(withSample?.sampleUrl).toBe("https://static1.e621.net/data/sample/ab/cd/one.jpg");

  const withoutSample = await firstCandidate(post({ sample: undefined }));
  expect(withoutSample?.sampleUrl).toBe("https://static1.e621.net/data/ab/cd/one.jpg");
});

test("K7 ⑯ asks for both cards in one order:random page, and keeps the random.json fallback", async () => {
  const page = jest.fn().mockResolvedValue(listResponse([
    post({ id: 1 }),
    post({ id: 2 }),
  ]));
  const batch = await fetchE621Batch({
    settings,
    excludedIds: [],
    count: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: page,
  });
  expect(page).toHaveBeenCalledTimes(1);
  const url = new URL(page.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe("https://e621.net/posts.json");
  expect(url.searchParams.get("tags")?.split(" ")).toContain("order:random");
  expect(url.searchParams.get("limit")).toBe("2");
  expect(batch.items.map((item) => item.providerItemId)).toEqual(["1", "2"]);

  // A rejected QUERY (4xx) falls back to the single-post endpoint, which for
  // this family is `{"post":{...}}` — the `responseSingleKey` unwrap.
  const rejected = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ message: "nope" }, 422))
    .mockResolvedValue(randomResponse(post({ id: 9 })));
  const fallback = await fetchE621Batch({
    settings,
    excludedIds: [],
    count: 2,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: rejected,
  });
  expect(rejected).toHaveBeenCalledTimes(3);
  expect(new URL(rejected.mock.calls[1]![0]).pathname).toBe("/posts/random.json");
  expect(fallback.items.map((item) => item.providerItemId)).toEqual(["9"]);
});
