# Contributing to Waifu Deck

Thanks for helping. Bug reports, new image sources and new storage backends are the most useful contributions. For anything larger than a small fix, please open an issue first so we can agree on the approach.

## Setup

You need Node.js 22, JDK 17 and the Android SDK.

```bash
npm ci
npm run android    # generates the native project, builds a debug app and installs it
```

The app is built with [Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/). Expo's APIs change between versions, so check the SDK 56 docs rather than older examples.

## Where things live

| Path | What it holds |
| --- | --- |
| `src/app` | Expo Router routes only. Do not put tests here: the router would bundle them as screens. |
| `src/screens`, `src/components` | Screens and shared UI |
| `src/features/<source>` | One folder per image source (`danbooru`, `gelbooru`, `safebooru`, …) |
| `src/features/discovery`, `src/features/search` | The swipe deck and tag search across sources |
| `src/features/library`, `src/features/byos`, `src/features/cloud-store` | Cloud sync: the sync engine, connection flows, and the S3 / Google Drive / OneDrive / WebDAV stores |
| `src/db` | SQLite schema and migrations |
| `src/i18n` | Copy in four languages: Simplified Chinese, Traditional Chinese, English, Japanese |
| `modules/waifu-sync-service` | Native Android module for background transfers |
| `patches` | `patch-package` patches applied on install |

## Before you send a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run test:audit
```

CI runs the same commands. When you change behaviour, add or update a test that fails without your change.

Cloud sync has integration suites that run against real storage. The MinIO one needs only Docker:

```bash
npm run verify:byos-minio
```

The other `verify:byos-*` scripts run the same suites against R2, Wasabi, Bunny, WebDAV, Google Drive and OneDrive; the top of each script says where it reads credentials from. See [docs/storage-backends.md](docs/storage-backends.md) for what each backend has been measured to do.

## Guidelines

- User-facing text goes through `src/i18n` in all four locales. Keep it short and about what the user can do; leave internals out.
- New image sources must work without an account, or ask for the user's own API key. Respect each source's API rules and rate limits.
- Nothing in the app may send the user's library, keys or usage to a server they did not choose. No analytics, no telemetry.
- Screenshots in issues and pull requests should be safe for work.

## License

By contributing you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of the project.
