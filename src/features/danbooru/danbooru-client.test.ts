import { DEFAULT_SETTINGS } from "@/features/settings/settings";
import type { SearchRequest } from "@/features/search/types";
import { STORE_DISTRIBUTION_POLICY } from "@/features/distribution/distribution-policy";

import {
  buildDanbooruUrl,
  fetchDanbooruBatch,
  fetchDanbooruSearchPage,
} from "./danbooru-client";

function headers(values: Record<string, string>) {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers({}),
    json: async () => body,
  } as Response;
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: 12_345,
    image_width: 1200,
    image_height: 1800,
    file_size: 456_789,
    file_ext: "jpg",
    file_url: "https://cdn.donmai.us/original/ab/cd/one.jpg",
    source: "https://www.pixiv.net/en/artworks/998877",
    pixiv_id: 998_877,
    rating: "g",
    tag_string: "1girl solo blue_hair example_artist",
    tag_string_artist: "example_artist",
    media_asset: { duration: null },
    ...overrides,
  };
}

function searchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    tags: [],
    excludedTags: [],
    nsfwMode: DEFAULT_SETTINGS.nsfwMode,
    orientation: DEFAULT_SETTINGS.orientation,
    animationMode: DEFAULT_SETTINGS.animationMode,
    minWidth: DEFAULT_SETTINGS.minWidth,
    maxBytes: DEFAULT_SETTINGS.maxBytes,
    ...overrides,
  };
}

test.each([
  ["sfw", false, "any", ["1girl", "rating:general"]],
  ["mixed", true, "any", ["1girl"]],
  ["nsfw", true, "any", ["1girl", "is:nsfw"]],
  ["sfw", false, "prefer-3d", ["1girl", "rating:general", "3d"]],
  ["sfw", false, "prefer-2d", ["1girl", "rating:general", "2d"]],
] as const)(
  "builds a provider-compatible %s query",
  (nsfwMode, nsfwConfirmed, stylePreference, expectedTags) => {
    const url = new URL(
      buildDanbooruUrl({
        ...DEFAULT_SETTINGS,
        nsfwMode,
        nsfwConfirmed,
        stylePreference,
        includedTags: ["waifu", "blue_hair"],
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://danbooru.donmai.us/posts/random.json",
    );
    expect(url.searchParams.get("tags")?.split(" ")).toEqual(expectedTags);
  },
);

test("keeps expensive orientation, width, and byte filters local", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    includedTags: ["waifu", "raiden-shogun", "genshin-impact"],
    orientation: "landscape" as const,
    minWidth: 1440 as const,
    maxBytes: 2_000_000 as const,
  };
  const url = new URL(buildDanbooruUrl(settings));

  expect(url.searchParams.get("tags")?.split(" ")).toEqual([
    "1girl",
    "rating:general",
  ]);
});

test("forces Store discovery to general rating and drops unsafe results", async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    nsfwMode: "mixed" as const,
    nsfwConfirmed: true,
  };
  expect(new URL(
    buildDanbooruUrl(settings, STORE_DISTRIBUTION_POLICY),
  ).searchParams.get("tags")?.split(" ")).toEqual([
    "1girl",
    "rating:general",
  ]);

  const fetcher = jest.fn(async (_url: string) =>
    jsonResponse([post({ rating: "s" })]),
  );
  const batch = await fetchDanbooruBatch({
    settings,
    excludedIds: [],
    count: 1,
    fetcher,
    distributionPolicy: STORE_DISTRIBUTION_POLICY,
  });

  expect(
    new URL(fetcher.mock.calls[0]![0]).searchParams.get("tags")?.split(" "),
  ).toContain("rating:general");
  expect(batch.items).toEqual([]);
});

// K7 ⑯ rewrote the transport shape only: two cards now arrive in ONE
// `posts.json?...random:2` page instead of two `posts/random.json` calls. The
// mapping under test is unchanged.
test("maps post metadata to provider identity and preserves Pixiv provenance", async () => {
  const fetcher = jest.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Accept: "application/json",
        "User-Agent": expect.stringContaining("WaifuDeck/1.0"),
      }),
    );
    return jsonResponse([
      post({ id: 12_345, file_url: "https://cdn.donmai.us/original/ab/cd/1.jpg" }),
      post({ id: 12_346, file_url: "https://cdn.donmai.us/original/ab/cd/2.jpg" }),
    ]);
  });

  const result = await fetchDanbooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 2,
    fetcher,
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.items).toHaveLength(2);
  expect(result.items[0]).toMatchObject({
    providerKey: "danbooru",
    providerItemId: "12345",
    canonicalSourceKey: "pixiv:998877",
    sourceUrl: "https://www.pixiv.net/en/artworks/998877",
    artistName: "example artist",
    width: 1200,
    height: 1800,
    byteSize: 456_789,
    extension: ".jpg",
    isNsfw: false,
    isAnimated: false,
  });
  expect(result.items[0]?.artistUrl).toContain("example_artist");
});

test("reads and lowercases the post's bare md5, defaulting to null when absent or empty", async () => {
  const fetcher = jest.fn(async () => jsonResponse([
    post({ id: 1, md5: "ABCDEF0123456789ABCDEF0123456789" }),
    post({ id: 2, md5: "" }),
    post({ id: 3 }),
  ]));

  const result = await fetchDanbooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 3,
    fetcher,
  });

  expect(result.items.map((item) => item.md5)).toEqual([
    "abcdef0123456789abcdef0123456789",
    null,
    null,
  ]);
});

test("treats sensitive and questionable as known non-safe ratings", async () => {
  const fetcher = jest.fn(async () => jsonResponse([
    post({ id: 1, rating: "s" }),
    post({ id: 2, rating: "q" }),
  ]));

  const result = await fetchDanbooruBatch({
    settings: {
      ...DEFAULT_SETTINGS,
      nsfwMode: "mixed",
      nsfwConfirmed: true,
    },
    excludedIds: [],
    count: 2,
    fetcher,
  });

  expect(result.items.map((item) => item.isNsfw)).toEqual([true, true]);
  expect(result.items.map((item) => item.contentRating)).toEqual([
    "suggestive",
    "nsfw_unspecified",
  ]);
});

test("returns a candidate when Waifu is off with a persisted Waifu-only tag", async () => {
  const fetcher = jest.fn(async () => jsonResponse([post()]));

  await expect(
    fetchDanbooruBatch({
      settings: {
        ...DEFAULT_SETTINGS,
        providers: { waifu_im: false, nekos_api: false, danbooru: true, safebooru: false, yandere: false, konachan: false, e621: false, e926: false, gelbooru: false, rule34: false },
        includedTags: ["waifu", "raiden-shogun"],
      },
      excludedIds: [],
      count: 1,
      fetcher,
    }),
  ).resolves.toMatchObject({
    items: [{ providerKey: "danbooru", providerItemId: "12345" }],
  });
});

test("applies local orientation and animation without guessing safety from tags", async () => {
  const fetcher = jest.fn(async () => jsonResponse([
    post({ id: 1, image_width: 1800, image_height: 1200 }),
    post({ id: 2, tag_string: "1girl nipples" }),
    post({ id: 3, file_ext: "gif", file_url: "https://cdn.donmai.us/a/3.gif" }),
  ]));

  await expect(
    fetchDanbooruBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      count: 3,
      fetcher,
    }),
  ).resolves.toMatchObject({
    items: [{ providerItemId: "2", contentRating: "safe", isNsfw: false }],
    // Pre-filter (G3 spec §4 item 1): three raw posts were seen, one survived
    // the orientation/animation filter. The old `1` restated `items.length`.
    totalCount: 3,
  });
});

test("skips excluded IDs and unsupported video posts", async () => {
  const fetcher = jest.fn(async () => jsonResponse([
    post({ id: 12_345 }),
    post({
      id: 12_346,
      file_ext: "webm",
      file_url: "https://cdn.donmai.us/original/ab/cd/two.webm",
    }),
  ]));

  // Pre-filter (G3 spec §4 item 1): both raw posts were seen — one dropped by
  // the exclusion list, one by the extension guard — so `totalCount` is 2, not
  // the old `items.length` restatement.
  await expect(
    fetchDanbooruBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: ["12345"],
      count: 2,
      fetcher,
    }),
  ).resolves.toEqual({ items: [], totalCount: 2 });
});

test("classifies an all-request rate limit for query-level retry", async () => {
  const fetcher = jest.fn(
    async () =>
      ({
        ...jsonResponse({}, 429),
        headers: headers({ "retry-after": "2" }),
      }) as Response,
  );

  await expect(
    fetchDanbooruBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      count: 2,
      fetcher,
    }),
  ).rejects.toMatchObject({
    code: "rate_limited",
    status: 429,
    retryAfterMs: 2_000,
  });
});

// K7 ⑯ rewrote the OUTCOME, not the safety rule: an untrusted CDN URL still
// never becomes a candidate. On the one-request page a dirty post is skipped
// the way `fetchSearchPage` already skipped one, so the other posts in the
// same page survive it; `totalCount` still reports it as seen. The old
// `rejects` was an artefact of one-post-per-request, where the only dirty post
// was also the whole batch.
test("drops an untrusted CDN URL without failing the rest of the page", async () => {
  const fetcher = jest.fn(async () =>
    jsonResponse([
      post({ file_url: "https://example.com/not-danbooru.jpg" }),
      post({ id: 999, file_url: "https://cdn.donmai.us/original/ab/cd/ok.jpg" }),
    ]),
  );

  await expect(
    fetchDanbooruBatch({
      settings: DEFAULT_SETTINGS,
      excludedIds: [],
      count: 2,
      fetcher,
    }),
  ).resolves.toMatchObject({
    items: [{ providerItemId: "999" }],
    totalCount: 2,
  });
});

test("does not expose an unsafe source URL to the UI", async () => {
  const fetcher = jest.fn(async () =>
    jsonResponse([
      post({
        source: "javascript:alert(1)",
        pixiv_id: null,
      }),
    ]),
  );

  const result = await fetchDanbooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher,
  });

  expect(result.items[0]).toMatchObject({
    sourceUrl: null,
    canonicalSourceKey: null,
  });
});

describe("fetchDanbooruSearchPage", () => {
  test("forces Store searches to general rating and rejects unsafe hits", async () => {
    const fetcher = jest.fn(async (_url: string) =>
      jsonResponse([post({ rating: "s" })]),
    );

    const page = await fetchDanbooruSearchPage({
      request: searchRequest({ nsfwMode: "mixed" }),
      fetcher,
      distributionPolicy: STORE_DISTRIBUTION_POLICY,
    });

    expect(
      new URL(fetcher.mock.calls[0]![0]).searchParams.get("tags")?.split(" "),
    ).toContain("rating:general");
    expect(page.items).toEqual([]);
  });

  test.each([
    ["sfw", ["rating:general", "blue", "hair", "solo"]],
    ["mixed", ["blue", "hair", "solo"]],
    ["nsfw", ["is:nsfw", "blue", "hair", "solo"]],
  ] as const)(
    "preserves every raw term in the %s posts query without guessing tag limits",
    async (nsfwMode, expectedTags) => {
      const fetcher = jest.fn(async (_url: string) => jsonResponse([]));

      await fetchDanbooruSearchPage({
        request: searchRequest({
          nsfwMode,
          tags: ["blue hair", "solo"],
          excludedTags: ["male"],
        }),
        limit: 999,
        fetcher,
      });

      const url = new URL(fetcher.mock.calls[0]?.[0] as string);
      expect(url.origin + url.pathname).toBe(
        "https://danbooru.donmai.us/posts.json",
      );
      expect(url.searchParams.get("tags")?.split(" ")).toEqual(expectedTags);
      expect(url.searchParams.get("tags")?.split(" ")).toHaveLength(
        expectedTags.length,
      );
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.has("random")).toBe(false);
    },
  );

  test("reports the provider's tag-limit rejection without dropping query terms", async () => {
    const fetcher = jest.fn(async (_url: string) => jsonResponse({
      success: false,
      error: "PostQuery::TagLimitError",
      message: "You cannot search for more than 2 tags at a time.",
    }, 422));

    const page = await fetchDanbooruSearchPage({
      request: searchRequest({ tags: ["blue_hair solo smile"] }),
      fetcher,
    });

    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get("tags"))
      .toBe("rating:general blue_hair solo smile");
    expect(page).toEqual({
      providerKey: "danbooru",
      items: [],
      nextCursor: null,
      unsupportedQuery: true,
    });
  });

  test.each([
    [401, { success: false, error: "AuthenticationFailure" }],
    [422, { success: false, error: "OtherError" }],
    [500, { success: false, error: "PostQuery::TagLimitError" }],
  ])("does not classify an unrelated %i failure as unsupported", async (status, body) => {
    await expect(fetchDanbooruSearchPage({
      request: searchRequest({ tags: ["blue_hair"] }),
      fetcher: async () => jsonResponse(body, status as number),
    })).rejects.toMatchObject({ code: "http", status });
  });

  test("sends Chinese and native operators unchanged and trusts provider matches", async () => {
    const fetcher = jest.fn(async (_url: string) => jsonResponse([post()]));
    const page = await fetchDanbooruSearchPage({
      request: searchRequest({ nsfwMode: "mixed", tags: ["福瑞 id:1,2 -bar"] }),
      fetcher,
    });

    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get("tags"))
      .toBe("福瑞 id:1,2 -bar");
    expect(page.items).toHaveLength(1);
  });

  test("R8.24: an untrusted preview falls back to the trusted sample before the original", async () => {
    const fetcher = jest.fn(async (_url: string) =>
      jsonResponse([
        post({
          id: 200,
          file_url: "https://cdn.donmai.us/original/ab/cd/200.jpg",
          large_file_url: "https://cdn.donmai.us/sample/ab/cd/200.jpg",
          preview_file_url: "https://example.com/untrusted-preview.jpg",
        }),
      ]),
    );

    const page = await fetchDanbooruSearchPage({
      request: searchRequest({ tags: ["1girl"] }),
      cursor: { beforeId: 400 },
      limit: 1,
      fetcher,
    });

    // The 180x180 preview is untrusted here, but the medium sample is a
    // trusted, smaller image — never hand the grid the original in that case.
    expect(page.items[0]).toMatchObject({
      key: "danbooru:200",
      previewUrl: "https://cdn.donmai.us/sample/ab/cd/200.jpg",
    });
  });

  test("uses a trusted preview and derives before-id pagination from the oldest post", async () => {
    const fetcher = jest.fn(async (_url: string) =>
      jsonResponse([
        post({
          id: 300,
          file_url: "https://cdn.donmai.us/original/ab/cd/300.jpg",
          preview_file_url: "https://cdn.donmai.us/180x180/ab/cd/300.jpg",
        }),
        post({
          id: 250,
          file_url: "https://cdn.donmai.us/original/ab/cd/250.jpg",
          preview_file_url: "https://example.com/untrusted-preview.jpg",
        }),
      ]),
    );

    const page = await fetchDanbooruSearchPage({
      request: searchRequest({ tags: ["1girl"] }),
      cursor: { beforeId: 400 },
      limit: 2,
      fetcher,
    });

    const url = new URL(fetcher.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("page")).toBe("b400");
    expect(page.nextCursor).toEqual({ beforeId: 250 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      key: "danbooru:300",
      previewUrl: "https://cdn.donmai.us/180x180/ab/cd/300.jpg",
      image: { providerKey: "danbooru", providerItemId: "300" },
    });
    expect(page.items[1]).toMatchObject({
      key: "danbooru:250",
      previewUrl: "https://cdn.donmai.us/original/ab/cd/250.jpg",
    });
  });

  test("round-trips the oldest post id into a strictly older next page", async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([post({ id: 300 }), post({ id: 250 })]),
      )
      .mockResolvedValueOnce(
        jsonResponse([post({ id: 249 }), post({ id: 200 })]),
      );
    const request = searchRequest({ tags: ["1girl"] });

    const firstPage = await fetchDanbooruSearchPage({ request, fetcher });
    const secondPage = await fetchDanbooruSearchPage({
      request,
      cursor: firstPage.nextCursor,
      fetcher,
    });

    expect(
      new URL(fetcher.mock.calls[0]?.[0] as string).searchParams.has("page"),
    ).toBe(false);
    expect(
      new URL(fetcher.mock.calls[1]?.[0] as string).searchParams.get("page"),
    ).toBe("b250");
    expect(firstPage.nextCursor).toEqual({ beforeId: 250 });
    expect(secondPage.nextCursor).toEqual({ beforeId: 200 });
  });

  test.each([
    ["repeats the boundary", [post({ id: 300 }), post({ id: 250 })]],
    ["ignores the cursor", [post({ id: 300 }), post({ id: 275 })]],
  ])("rejects a page that %s", async (_case, response) => {
    const fetcher = jest.fn(async () => jsonResponse(response));

    await expect(
      fetchDanbooruSearchPage({
        request: searchRequest({ tags: ["1girl"] }),
        cursor: { beforeId: 250 },
        fetcher,
      }),
    ).rejects.toMatchObject({
      name: "DanbooruApiError",
      code: "invalid_response",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("applies exclusions and quality filters locally after provider search", async () => {
    const fetcher = jest.fn(async () =>
      jsonResponse([
        post({ id: 90, tag_string: "1girl blue_hair solo" }),
        post({ id: 89, tag_string: "1girl blue_hair" }),
        post({ id: 88, tag_string: "1girl blue_hair solo male" }),
        post({
          id: 87,
          tag_string: "1girl blue_hair solo",
          image_width: 1800,
          image_height: 1200,
        }),
        post({
          id: 86,
          tag_string: "1girl blue_hair solo",
          image_width: 800,
        }),
        post({
          id: 85,
          tag_string: "1girl blue_hair solo",
          file_size: 3_000_000,
        }),
        post({
          id: 84,
          tag_string: "1girl blue_hair solo",
          file_ext: "gif",
          file_url: "https://cdn.donmai.us/original/ab/cd/84.gif",
        }),
      ]),
    );

    const page = await fetchDanbooruSearchPage({
      request: searchRequest({
        orientation: "portrait",
        minWidth: 1080,
        maxBytes: 2_000_000,
        tags: ["blue_hair", "solo"],
        excludedTags: ["male"],
      }),
      fetcher,
    });

    expect(page.items.map((hit) => hit.image.providerItemId)).toEqual(["90", "89"]);
    expect(page.nextCursor).toEqual({ beforeId: 84 });
  });

  test("skips malformed items while preserving valid posts and page progress", async () => {
    const fetcher = jest.fn(async () =>
      jsonResponse([null, { id: 70, image_width: "bad" }, post({ id: 69 })]),
    );

    await expect(
      fetchDanbooruSearchPage({
        request: searchRequest({ tags: ["1girl"] }),
        fetcher,
      }),
    ).resolves.toMatchObject({
      providerKey: "danbooru",
      items: [{ key: "danbooru:69" }],
      nextCursor: { beforeId: 69 },
    });
  });

  test("rejects a malformed top-level response", async () => {
    const fetcher = jest.fn(async () => jsonResponse({ posts: [] }));

    await expect(
      fetchDanbooruSearchPage({
        request: searchRequest({ tags: ["1girl"] }),
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("preserves rate-limit metadata for search retries", async () => {
    const fetcher = jest.fn(
      async () =>
        ({
          ...jsonResponse({}, 429),
          headers: headers({ "retry-after": "3" }),
        }) as Response,
    );

    await expect(
      fetchDanbooruSearchPage({
        request: searchRequest({ tags: ["1girl"] }),
        fetcher,
      }),
    ).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterMs: 3_000,
    });
  });

  test("maps caller cancellation to the existing aborted error", async () => {
    const controller = new AbortController();
    const fetcher = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("abort")),
          );
        }),
    );

    const pending = fetchDanbooruSearchPage({
      request: searchRequest({ tags: ["1girl"] }),
      signal: controller.signal,
      fetcher,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  test("returns a terminal page for an empty response without writing anywhere", async () => {
    const fetcher = jest.fn(async (_url: string) => jsonResponse([]));

    await expect(
      fetchDanbooruSearchPage({
        request: searchRequest({ tags: ["1girl"] }),
        cursor: { beforeId: 250 },
        fetcher,
      }),
    ).resolves.toEqual({
      providerKey: "danbooru",
      items: [],
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      new URL(fetcher.mock.calls[0]?.[0] as string).searchParams.get("page"),
    ).toBe("b250");
  });

  test("returns a terminal page for a null cursor without requesting again", async () => {
    const fetcher = jest.fn(async () => jsonResponse([post({ id: 1 })]));

    await expect(
      fetchDanbooruSearchPage({
        request: searchRequest({ tags: ["1girl"] }),
        cursor: null,
        fetcher,
      }),
    ).resolves.toEqual({
      providerKey: "danbooru",
      items: [],
      nextCursor: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

test("R8.18: large_file_url becomes the display sampleUrl, else it falls back to remoteUrl", async () => {
  const withLarge = jest.fn().mockResolvedValue(
    jsonResponse([post({ large_file_url: "https://cdn.donmai.us/sample/ab/cd/one.jpg" })]),
  );
  const large = await fetchDanbooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher: withLarge,
  });
  expect(large.items[0]?.sampleUrl).toBe("https://cdn.donmai.us/sample/ab/cd/one.jpg");

  const noLarge = jest.fn().mockResolvedValue(jsonResponse([post()]));
  const fallback = await fetchDanbooruBatch({
    settings: DEFAULT_SETTINGS,
    excludedIds: [],
    count: 1,
    fetcher: noLarge,
  });
  expect(fallback.items[0]?.sampleUrl).toBe("https://cdn.donmai.us/original/ab/cd/one.jpg");
});
