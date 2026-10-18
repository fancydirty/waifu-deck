import {
  createDanbooruEngine,
  type DanbooruEngineConfig,
} from "@/features/providers/engines/danbooru-engine";
import { createE621FamilyConfig } from "@/features/e621/e621-client";

// e926 is e621's SFW-only mirror: same operator, same nested `posts.json`
// schema (`file`/`tags`/`flags`/`sources`), same 3-value `s/q/e` rating
// vocabulary — only the base URLs and CDN host differ. It reuses e621's
// shared parsing logic via {@link createE621FamilyConfig} rather than
// duplicating the ~90-line nested parser (G2a-2 task 3). e926 is SFW-only
// upstream, but the app still sends the same rating query tag the engine
// would send for any nsfwMode — harmless, since e926 only ever has `s`
// posts to return.
const E926_CONFIG: DanbooruEngineConfig<"e926"> = createE621FamilyConfig({
  key: "e926",
  label: "e926",
  postsUrl: "https://e926.net/posts.json",
  randomUrl: "https://e926.net/posts/random.json",
  trustedCdnHosts: ["static1.e926.net"],
});

const e926Engine = createDanbooruEngine(E926_CONFIG);

export const fetchE926Batch = e926Engine.fetchBatch;
export const fetchE926SearchPage = e926Engine.fetchSearchPage;
