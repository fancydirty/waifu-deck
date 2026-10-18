import { DEFAULT_SETTINGS } from "@/features/settings/settings";
import { DIRECT_DISTRIBUTION_POLICY } from "@/features/distribution/distribution-policy";
import type { AppSettings } from "@/features/waifu/types";
import type { SearchRequest } from "@/features/search/types";

import { fetchE926Batch, fetchE926SearchPage } from "./e926-client";

// e926 is the same nested schema as e621 (shared parser via
// createE621FamilyConfig); these tests only cover what differs per config:
// key/label wiring, the e926-specific trusted CDN host, and delegation to
// the shared engine. The nested-post mapping itself is exercised exhaustively
// by e621-client.test.ts.

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

// e926 shares e621's WRAPPED wire shape (verified live with curl):
//   GET /posts.json        -> {"posts":[...]}   (discovery + search, K7 ⑯)
//   GET /posts/random.json -> {"post":{...}}    (the 4xx fallback)
// See the same helpers (and the green-but-wrong-fixture note) in
// `e621-client.test.ts`, which also covers the shared family's fallback — both
// instances are built from the one `createE621FamilyConfig`.
function listResponse(posts: readonly unknown[], status = 200): Response {
  return jsonResponse({ posts }, status);
}

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
    id: 5151,
    file: {
      width: 1200,
      height: 1800,
      ext: "jpg",
      size: 456_789,
      md5: "0123456789abcdef0123456789abcdef",
      url: "https://static1.e926.net/data/ab/cd/one.jpg",
      ...fileOverride,
    },
    preview: { url: "https://static1.e926.net/data/preview/ab/cd/one.jpg" },
    sample: { url: "https://static1.e926.net/data/sample/ab/cd/one.jpg" },
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
    sources: ["https://www.pixiv.net/en/artworks/808"],
    ...rest,
  };
}

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

// K7 ⑯: discovery asks `posts.json?...order:random&limit=N` once, so these
// fixtures are LIST-shaped; `randomResponse` describes the `posts/random.json`
// fallback shape, exercised below.
test("tags candidates with the e926 provider key", async () => {
  const batch = await fetchE926Batch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(listResponse([post()])),
  });

  expect(batch.items[0]).toMatchObject({
    providerKey: "e926",
    providerItemId: "5151",
    remoteUrl: "https://static1.e926.net/data/ab/cd/one.jpg",
  });
});

test("trusts the e926 CDN host but rejects e621's own CDN host", async () => {
  const trusted = await fetchE926Batch({
    settings,
    excludedIds: [],
    count: 1,
    distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
    fetcher: jest.fn().mockResolvedValue(listResponse([post()])),
  });
  expect(trusted.items).toHaveLength(1);

  // K7 ⑯ rewrote the OUTCOME, not the host rule: the cross-host post is still
  // never a candidate — on the one-request page it is skipped rather than
  // failing the page, and still counted as seen.
  await expect(
    fetchE926Batch({
      settings,
      excludedIds: [],
      count: 1,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher: jest.fn().mockResolvedValue(
        listResponse([
          post({ file: { url: "https://static1.e621.net/data/ab/cd/one.jpg" } }),
        ]),
      ),
    }),
  ).resolves.toMatchObject({ items: [], totalCount: 1 });
});

describe("fetchE926SearchPage", () => {
  test("hits the e926 posts endpoint", async () => {
    const fetcher = jest.fn(async (_url: string) => listResponse([]));
    await fetchE926SearchPage({
      request: searchRequest,
      distributionPolicy: DIRECT_DISTRIBUTION_POLICY,
      fetcher,
    });
    const url = new URL(fetcher.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://e926.net/posts.json");
  });

  test("sends rating:s under SFW and rating:e under NSFW", async () => {
    const sfwFetcher = jest.fn(async (_url: string) => listResponse([]));
    await fetchE926SearchPage({
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
    await fetchE926SearchPage({
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
});
