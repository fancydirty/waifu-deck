<div align="center">

<img src="docs/images/readme/icon.png" width="96" height="96" alt="Waifu Deck icon" />

# Waifu Deck

**Swipe through anime art from ten sources. Keep the ones you love — on your phone, in your own cloud.**

[![Latest release](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fwaifudeck.app%2Fapi%2Fapp%2Flatest&query=%24.versionName&label=release&color=e35d6a)](https://waifudeck.app/api/app/download)
![Android 7.0+](https://img.shields.io/badge/Android-7.0%2B-3ddc84?logo=android&logoColor=white)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![CI](https://github.com/fancydirty/waifu-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/fancydirty/waifu-deck/actions/workflows/ci.yml)
![No account, no ads, no tracking](https://img.shields.io/badge/no%20account-no%20ads%20%C2%B7%20no%20tracking-8a7f76)

[**Download APK**](https://waifudeck.app/api/app/download) · [Website](https://waifudeck.app) · [Privacy](https://waifudeck.app/privacy) · [简体中文](README.zh-CN.md)

<img src="docs/images/readme/swipe.gif" width="300" alt="Swiping cards in Waifu Deck: left to skip, right to save, rewind to undo" />

</div>

## Why Waifu Deck

Most anime-art apps wrap a single site, want an account, and lose your favorites when that site removes a post. Waifu Deck works the other way round:

- 🃏 **One deck, ten sources.** Danbooru, yande.re, Konachan, Safebooru, waifu.im, Nekos API, Gelbooru, Rule34, e621 and e926 share one swipe feed. No single source floods it, and a picture posted to several sites is usually shown only once.
- ✋ **Right to keep, left to never see again.** Every decision is remembered, so skipped art stays gone after a restart. Changed your mind? Rewind.
- 📁 **Originals, not links.** A saved picture is downloaded at full resolution into the app's private storage. If the source deletes the post, you still have it.
- ☁️ **Optional sync to storage you own.** Cloudflare R2, Backblaze B2, Bunny, any S3 bucket, Google Drive, OneDrive or a WebDAV NAS. Every phone connected to the same storage shows the same library.
- 🔒 **Private by design.** No account, no ads, no analytics, and no server of ours in between.

## Screenshots

<p align="center">
  <img src="docs/images/readme/search.webp" width="200" alt="Tag search with results from several sources" />
  <img src="docs/images/readme/collection.webp" width="200" alt="Collection grid with SFW and NSFW filters" />
  <img src="docs/images/readme/viewer.webp" width="200" alt="Full-screen viewer with tags, source, share and export" />
  <img src="docs/images/readme/cloud.webp" width="200" alt="Settings with a connected, encrypted cloud library" />
</p>
<p align="center"><sub>Search · Collection · Viewer · Cloud library</sub></p>

## Features

**Discover**
- Swipe deck with rewind, plus buttons for save and skip
- Tag search across every enabled source; common Chinese tag names work too
- Content mode: SFW only (the default), Mixed, or NSFW only. Adult content asks you to confirm you are 18 or older first
- Excluded tags, image orientation, animated images on or off

**Collection**
- Instant search, filters by rating and source, sorting by date, resolution or file size
- Import your own pictures from the phone's gallery
- Share, export to the gallery, or open the original post
- Optional blur for NSFW thumbnails

**Keeping it**
- A `.waifudeck` backup file with your settings, history and originals
- In-app update check; a new version installs over the old one and keeps your library
- **Cloud only** mode: the phone keeps thumbnails and fetches full pictures from your storage when you open them

**Languages:** English, 简体中文, 繁體中文 and 日本語, following your device language.

## Install

1. Download the signed APK from **[waifudeck.app](https://waifudeck.app/api/app/download)**.
2. Open it, and allow your browser or file manager to install apps when Android asks.
3. Start swiping. There is nothing to set up and nothing to sign in to.

Needs Android 7.0 or later on a 64-bit ARM phone. Waifu Deck is not on Google Play; the app tells you when a new version is out. The same APK is attached to every [GitHub release](https://github.com/fancydirty/waifu-deck/releases), so you can also follow updates with [Obtainium](https://github.com/ImranR98/Obtainium).

## Image sources

| Source | Content | Notes |
| --- | --- | --- |
| [Danbooru](https://danbooru.donmai.us) | SFW + NSFW | |
| [yande.re](https://yande.re) | SFW + NSFW | High-resolution scans |
| [Konachan](https://konachan.net) | SFW | Wallpaper-sized art |
| [Safebooru](https://safebooru.org) | SFW | |
| [waifu.im](https://www.waifu.im) | SFW + NSFW | |
| [Nekos API](https://nekosapi.com) | SFW + NSFW | |
| [Gelbooru](https://gelbooru.com) | SFW + NSFW | Needs your own free API key |
| [Rule34](https://rule34.xxx) | NSFW only | Needs your own free API key |
| [e621](https://e621.net) | SFW + NSFW | Furry art |
| [e926](https://e926.net) | SFW | Furry art |

Each source can be switched on or off. Pictures are fetched from the sources while you use the app and are never bundled with it. All artwork belongs to its artists; the viewer links back to the original post whenever the source provides one.

## Cloud sync (bring your own storage)

Sync is optional; the app is complete without it.

| Storage | How you connect |
| --- | --- |
| Cloudflare R2, Backblaze B2, Bunny Storage | Paste one API key; the app sets up the rest ([20-second video guides](https://waifudeck.app/en/keys/)) |
| Any other S3-compatible bucket (MinIO, Wasabi, …) | Endpoint, bucket, access key and secret |
| Google Drive, OneDrive | Sign in; the app can only reach its own folder |
| WebDAV (Synology, Nextcloud and other NAS) | `https` address, username and password |

- **Encrypted on your phone.** The library is encrypted before upload with a key derived from your password (scrypt, AES-GCM), so the storage provider only holds unreadable files. Encryption is always on for Google Drive, OneDrive and WebDAV; on your own S3 bucket you may turn it off.
- **No password reset.** Nobody, including us, can recover a forgotten password. Write it down.
- **Several phones, one library.** Connect another phone to the same storage with the same password. Thumbnails arrive first and originals follow in the background.

Per-provider measurements and setup notes are in [docs/storage-backends.md](docs/storage-backends.md).

## Privacy

Waifu Deck has no accounts and no backend. It talks to the image sources you enable and, if you set up sync, to your own storage. Nothing else. Read the full [privacy policy](https://waifudeck.app/privacy).

## FAQ

<details>
<summary><b>Is it really free?</b></summary>

Yes. It is open source under AGPL-3.0, with no ads and no paid tier. There is no server storing your pictures, so there is no bill to pass on.
</details>

<details>
<summary><b>Why is it not on Google Play?</b></summary>

Waifu Deck is distributed directly so that it can offer every source, including adult ones that app stores do not allow. Every release is signed with the same key, so updates install over the previous version.
</details>

<details>
<summary><b>My phone is running out of space.</b></summary>

Connect cloud storage, then set **Settings → This phone** to **Cloud only**. The phone keeps small thumbnails and downloads a full picture only when you open it.
</details>

<details>
<summary><b>Does uninstalling delete my collection?</b></summary>

Uninstalling removes the app's private storage. Export a `.waifudeck` backup or connect cloud storage first; either one brings everything back on a fresh install.
</details>

## Build from source

You need Node.js 24 or newer, JDK 17 and the Android SDK. The app is built with [Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/) and React Native.

```bash
npm ci
npm run android    # generates the native project, builds, and installs on a device or emulator
```

Before sending a change:

```bash
npm test
npm run typecheck
npm run lint
```

Storage backend notes for contributors: [docs/storage-backends.md](docs/storage-backends.md).

## Contributing

Bug reports and pull requests are welcome, and new image sources or storage backends especially so. For larger changes, please open an issue first so we can agree on the approach before you spend time on it.

## License

Waifu Deck is licensed under the [GNU Affero General Public License v3.0](LICENSE).

The license covers the app's source code only. It grants no rights to the images returned by the sources or to the artwork in the screenshots above; those belong to their artists.
