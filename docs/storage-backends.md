# Storage backends: measurements and setup notes

Maintainer reference for the optional cloud sync. The user-facing summary is in the [README](../README.md#cloud-sync-bring-your-own-storage). Measurements below are dated and were taken on the maintainer's machines; plan files under `docs/superpowers/plans/` hold the full gate evidence.

Optional sync writes client-side-encrypted objects to storage **you** supply:
a bucket over plain S3 (SigV4, path-style, conditional `PUT`), a folder on any
WebDAV server, or — since 2026-09-20 — your own OneDrive, or — since
2026-09-25 — your own Google Drive (WebDAV, OneDrive and Google Drive all run
the append-only protocol v2, encryption always on). Every row below
is a measurement: the same integration suites
(`npm run verify:byos-<store>`) and, for S3, the same 30-race conditional-write
probe (`scripts/byos-conditional-write-probe.mjs`), run on the dates given.
Details and every failing test are in
`docs/superpowers/plans/2026-09-11-byos-mirror-closeout-ledger.md`,
`docs/superpowers/plans/2026-09-19-p12b-webdav.md`,
`docs/superpowers/plans/2026-09-20-p12c-onedrive.md` and
`docs/superpowers/plans/2026-09-22-p12d-google-drive.md` (the raw logs they
cite are local artifacts on the maintainer's machine, not in the repo).

## S3-compatible

| Store | BYOS suites (8) | Concurrent conditional writes (probe) | Notes |
| --- | --- | --- | --- |
| MinIO (local) | 8/8 pass (2026-09-16) | atomic: 30/30 create and 30/30 CAS races had exactly one winner | Reference backend for every gate. |
| Cloudflare R2 | 8/8 pass (2026-09-13, and again 2026-09-16 evening with this transport). Two earlier 2026-09-16 runs on an office link that was dropping connections passed 4/8 and 5/8: dropped connections, one >500 ms pool stall, one timeout, and one 25-vs-50 count assertion that passed on rerun; in a side-by-side 3-suite control the unchanged baseline build failed the same two suites for the same reasons (dropped connections, pool timing) | atomic: 30/30 and 30/30 (2026-09-16) | The owner's own store, and the one verified on a device with this transport (2026-09-16 emulator gate: 12/12 cloud-only originals re-downloaded byte-exact). |
| Wasabi | 5/8 pass (2026-09-16); failures = the two-device race below and dropped connections. Re-run 2026-09-20 on the unchanged S3 transport: 6/8 suites, 35/37 tests; the two failures were the first-init adoption race below and one pool-timing assertion (a 927 ms stall against a LAN-grade 500 ms ceiling) | **not atomic**: both writers succeeded in 6–7/30 creates and 3–6/30 CAS updates across three probes | ~1 in 25 connections is closed without a response; the app treats it as retryable and finishes on the next sync trigger. |
| Bunny Edge Storage (S3 API) | 4/8 and 5/8 pass across two 2026-09-16 runs after the two transport adaptations; failures = the two-device race below, dropped connections or a read-after-write race, and LAN-grade pool-timing assertions. Re-run 2026-09-20 on the unchanged transport: 6/8 suites, 34/37 tests; failures = the first-init adoption race and two 30 s test timeouts in the ETag-reconciliation suite (Bunny answered, slowly) | **not atomic**: both writers succeeded in 28–29/30 creates and 29–30/30 CAS updates across three probes | Gzips JSON and answers with a weak ETag unless the client asks for `identity`, and lists a zero-size placeholder per "folder"; the transport handles both since 2026-09-16. Occasional connection drops, like Wasabi. |

"Not atomic" only matters when two devices write the **same** object in the
**same instant**: a simultaneous first-time vault creation on two phones, or the
same image's state changed on two phones at once. One phone, or two phones used
seconds apart, behave exactly as on R2. The app cannot detect that race after
the fact and does not add a runtime probe or a verify-after-write round trip for
it (spec decision 2026-08-28, reaffirmed 2026-09-16).

## WebDAV

A WebDAV library never overwrites an object: every change is a new note, the
device that wrote a note is the only one that deletes it (once superseded), and
each device folds the others' notes in on its next sync. The S3 "same instant"
race above therefore does not exist here. The gate is
`npm run verify:byos-webdav -- --backend docker|nas|123` (contract suite +
two-device convergence + a 2 MiB timing line), run 2026-09-20:

| Server | Suites / tests | 2 MiB put / get | Quirks the transport handles |
| --- | --- | --- | --- |
| `hacdias/webdav` v5 (Docker, reference) | 2 / 14 pass | 10–12 ms / 4–7 ms | `MKCOL` on an existing folder answers 405; no quota properties. |
| Synology DSM 7.2 (`mod_dav`) behind a Cloudflare Tunnel, over the maintainer's home uplink | 2 / 14 pass (first run 27/27 while the two suites still double-registered the contract) | 4.0–4.8 s / 11–58 s | `PROPFIND` replies use `lp1:`/`g0:` namespace prefixes and prefixed hrefs; `MKCOL` under a missing parent is 409, so the folder you type must exist; no quota properties. |
| 123 云盘 official WebDAV (`https://webdav.123pan.cn/webdav`) | 2 / 14 pass (first run 24/27: three read-after-write cases) | 3.2–3.5 s / 0.7–0.9 s | `GET` is a 302 to a CDN that lags the origin by about a second after a `PUT` or `DELETE`; a 404 that arrives through that redirect is retried up to 5× at 500 ms, and a delete is treated as eventually visible. `MKCOL` on an existing folder answers 201; no quota properties. |

Device verification of the WebDAV path (emulator and the maintainer's phone,
bound to the Synology server above) is recorded in the P12-B plan's gate
section as it lands.

**Using a WebDAV folder.** In Settings → Cloud sync pick *WebDAV*, enter an
`https://` server address (plain `http://` is refused: the release build does
not allow cleartext traffic), a username, a password — prefer an *app password*
where the service offers one, since a WebDAV password reaches everything under
that account — and optionally a folder. Waifu Deck creates a `Waifu Deck`
folder there and keeps the library inside it, always encrypted with the library
password you set. For 123 云盘: 会员 → 工具 → 第三方挂载 → WebDAV → 添加应用,
then use `https://webdav.123pan.cn/webdav`, your account, and the generated app
password. For a NAS, Nextcloud, or another self-hosted server, use the WebDAV
address and app password it shows; it is reachable away from home only if you
expose it over `https`. More providers are listed in the community-maintained
[awesome-webdav](https://github.com/fstanis/awesome-webdav#cloud-providers).

## OneDrive

Sign-in happens in the system browser (a Custom Tab of your default browser): Microsoft handles
your password and any 2FA there, and the app never sees either — it receives a
one-time authorization code and exchanges it itself (OAuth 2.0 authorization
code + PKCE, self-implemented, no `expo-auth-session`; public client id
`40d6e21b-ea99-4417-af2c-65b1a290aa0d`; personal Microsoft accounts only;
scope `Files.ReadWrite.AppFolder offline_access User.Read`). The app can see
and write only its own app folder, `Apps/Waifu Deck` inside your OneDrive
(addressed by folder id, never by name, so a renamed or localized folder still
resolves) — nothing else in your OneDrive is touched. The signed-in account's
e-mail shows on the ready badge, and refresh tokens live in the device's
secure store and rotate on every refresh, written back at once.

Reachability was measured 2026-09-20: the owner's phone on mainland cellular
reached `login.microsoftonline.com` and `graph.microsoft.com`, and the
official OneDrive app backed up photos over the same link; an office Mac saw
HTTP 200 from those two hosts plus `login.live.com`, 2.9–4.2 s to first byte,
with Graph calls themselves at 0.6–1.7 s. The app carries no VPN caveat.

The gate is `npm run verify:byos-onedrive` against the owner's personal
OneDrive (50 GB plan), two runs (2026-09-20 and 2026-09-21):

| Backend | Suites / tests | 2 MiB put / get | 61 MiB (3 × 20 MiB fragments) | Notes |
| --- | --- | --- | --- | --- |
| OneDrive (Microsoft Graph, personal account) | 2 / 15 pass, both runs | 3033–3838 ms / 7385–14104 ms | 23583–41768 ms total (progress at 20, 41, 61 MiB, then a 1 MiB tail) | Originals under 60 MiB go up as one native streaming `PUT` through an upload session (real progress ring); at or above 60 MiB the app splits into sequential 20 MiB fragments (Graph requires multiples of 320 KiB and under 60 MiB per request). A full drive is refused (507) at session creation, before any byte moves, and shows as 「网盘已满」. |

The fresh OAuth consent did not hit the AppFolder-provisioning 403 some Graph
accounts show on first use — `approot` answered 200 and the folder was
created at once, so no extra scope round-trip was needed. Downloading a
just-uploaded 2 MiB blob ran 2–5× slower than uploading it in both runs
(14.1 s then 7.4 s; the first read of a fresh upload goes through a redirect
to a download host and appears to be served cold) — a one-off per image,
not a throughput ceiling. Device verification (2026-09-21, build `03a71c7`):
an emulator ran create → save → relaunch → fresh-install join →
revoked-consent re-sign-in, and the owner's phone (office Wi-Fi) got three
saves onto OneDrive in 6 s; the evidence is in the P12-C plan's ledger.

**Using OneDrive.** In Settings → Cloud sync pick *OneDrive* and tap 用
Microsoft 登录; the system browser opens for you to sign in, then set the
library password on first use. The app creates its folder under
`Apps/Waifu Deck` in your OneDrive right away. To add another device, pick
OneDrive there too, sign in with the same Microsoft account, and enter the
same library password — the two devices then share the library.

During sign-in Microsoft asks "Are you trying to sign in to Waifu Deck?"
(继续 / Continue), and some browsers (Edge, for one) then ask before they open
the app (打开 / Open) — both are expected. If the system closed Waifu Deck
while you were in the browser, the app simply opens normally afterwards; tap
用 Microsoft 登录 again.

## Google Drive

Sign-in happens in the system browser, as for OneDrive: Google handles your
password and any 2FA there, and the app receives a one-time authorization code
and exchanges it itself (OAuth 2.0 authorization code + PKCE, self-implemented;
scope `https://www.googleapis.com/auth/drive.file` only). The app signs in
through an **iOS-type** OAuth client of the `waifu-deck` Google Cloud project
(`550668815694-769sb0u8q37u6cc8ha4pb00bjs6808ec.apps.googleusercontent.com`,
public, no client secret — none exists for that client type) and receives the
answer on that client's reverse-client-id scheme. This is not an accident:
Google refuses both a custom-scheme and a loopback redirect for an
Android-type client, and a Web-type client would not exchange a code without a
client secret, which an open-source APK cannot keep (measured 2026-09-22; spec
`docs/superpowers/specs/2026-09-18-cloud-drive-library-backends-design.md`
§4.3, items 1 and 14). Google documents custom schemes as deprecated in
general, so this route could need replacing if Google extends the Android
restriction to iOS-type clients. Every sign-in shows Google's account chooser
(`prompt=select_account`), so disconnecting and connecting again lets you pick
a different account. Google does not rotate refresh tokens; the one refresh
token lives in the device's secure store.

**What the app can see.** `drive.file` gives the app access only to files it
created itself. A folder you made by hand in Drive — even one named
`Waifu Deck` — is invisible to it; that is the definition of the scope, not a
bug. The app creates one `Waifu Deck` folder in your Drive (with `state/` and
`blobs/` inside) and from then on addresses it by id, not by name. The folder
**is** visible in your Drive (`drive.appdata`'s hidden area was deliberately
not used): you may back it up or copy it. If you delete it, the app reports
that Google Drive did not answer as expected and asks you to disconnect this
device and connect again;
it never rebuilds the folder silently. If you re-sign in to a locked
connection with a *different* Google account, the app refuses the switch, but
by then it has already created an empty `Waifu Deck` folder in that other
account's Drive; it holds nothing and is safe to delete.

**Reachability.** Google is not reachable from mainland China without a way
around the block. The app does not probe for it; instead the Google Drive card
says so up front (「需要能访问 Google 的网络。」 / "Needs a network that can reach
Google."). The maintainer's office Mac reached `accounts.google.com`,
`oauth2.googleapis.com` and `www.googleapis.com` (2026-09-22); the owner
reports that the office and home networks used for the device gates both
reach Google (through a VPN).

**How long a sign-in lasts.** The OAuth consent screen is published to
**Production** (since 2026-09-22), so there is no 7-day re-login — that expiry
applies only to consent screens left in Testing. Google can still end a
sign-in, and the app then shows 「需要重新登录」 with a 「重新用 Google 登录」 row
(your library, folder and password stay as they are): when you revoke Waifu
Deck's access in your Google account, when the token goes unused for six
months, or when one Google account holds more than 100 refresh tokens for the
same client (Google silently retires the oldest — relevant only if you connect
and disconnect many times).

The gate is `npm run verify:byos-gdrive` against the owner's Google account
(one `it-<run>` folder per store instance, each deleted afterwards).
It signs in once through a separate **Web-type** client of the same Google
Cloud project, whose secret stays on the maintainer's machine; `drive.file`
access belongs to the whole project, so the gate sees exactly what the app
writes. Run 2 (2026-09-25; run 1 passed 14/15, its failure was a Node-harness
artifact, not Drive — the detail is in
`docs/superpowers/plans/2026-09-22-p12d-google-drive.md`):

| Backend | Suites / tests | 2 MiB put / get | 61 MiB upload | Notes |
| --- | --- | --- | --- | --- |
| Google Drive (API v3, personal account) | 2 / 15 pass | 6213 ms / 5172 ms | 27003 ms as **one** resumable-session `PUT` (no fragments) | Small objects (notes, `vault-meta.json`) are created with one multipart `POST` and never overwritten; originals go up through a resumable upload session as a single native streaming `PUT`. `alt=media` downloads were served directly by `www.googleapis.com` — no redirect to a separate download host, unlike OneDrive — in all 9 reads. No 4xx/5xx and no `Retry-After` header in either run; Google's "unverified app" page has not been seen in any sign-in so far (Mac gate logins, emulator and phone; a maintainer observation — the sign-in traces show no extra screen, but no log records its absence directly). |

The 61 MiB **download** time is not published here: on the Mac it measured
the gate harness's Node HTTP client, not Drive, and the app downloads through
a different client on the device. The download path is measured on devices.
The 15 tests are the shared 12-case storage contract, the 2 MiB and 61 MiB
timing lines, and the append-only two-device convergence proof.

Device verification (2026-09-25, final build `b0d0c64`; the same gates had
first passed on the earlier build `aa9fb72`): an emulator ran create → save
(one save on Drive in 6 s) → relaunch → fresh-install join (the restored image
opened full-size) → revoked-access re-sign-in (steps a–e in one run, then f
after the maintainer revoked the app's access; no failure and no manual step),
and the owner's phone got three saves onto Google Drive in 6 s. The phone
created its own new library; two devices sharing one library are proved by the
Mac two-device suite and by the emulator's second fresh install joining the
same library. The upload progress ring, the used/total space line and the
「网盘已满」 status have not been seen on a device — only in unit tests against
a fake Drive. Google's "unverified app" page was not
seen in either (a maintainer observation: each sign-in trace goes account →
continue → back in the app with no extra screen). The evidence is in the P12-D plan's Gates section.

**Using Google Drive.** In Settings → Cloud sync pick *Google Drive* and tap
用 Google 登录; the system browser opens for you to choose an account and allow
access (the consent page reads 「“Waifu Deck”想要访问您的 Google 账号」 in a
Chinese-language browser), then set the library password on first use. The app creates
its `Waifu Deck` folder in your Drive right away. To add another device, pick
Google Drive there too, sign in with the same Google account, and enter the
same library password — the two devices then share the library.
