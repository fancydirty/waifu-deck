# Cloud-only storage copy

The approved wording for the 仅云端 (cloud-only) storage mode, in all four locales.
`src/i18n/locales.test.ts` reads this table, so a string retyped in a locale file fails the test.

### 5.14 Settings UX and copy (S3, all four locales)
| Key | zh-Hans | zh-Hant | en | ja |
|---|---|---|---|---|
| row label | 本机存储 | 本機儲存 | Storage on this phone | この端末の保存方法 |
| mode: both | 本地+云端 | 本機+雲端 | This phone + cloud | 端末+クラウド |
| mode: cloud | 仅云端 | 僅雲端 | Cloud only | クラウドのみ |
| row detail | 仅云端：备份完成后删除本机原图，只留缩略图，看大图时从云端取。 | 僅雲端：備份完成後刪除本機原圖，只留縮圖，看大圖時從雲端取得。 | Cloud only: after backup the originals leave this phone; thumbnails stay and full images load from your cloud library. | クラウドのみ：バックアップ後にこの端末のオリジナルを削除し、サムネイルだけを残します。大きな画像はクラウドから読み込みます。 |
| warn title | 只在云端保存原图？ | 只在雲端保存原圖？ | Keep originals only in the cloud? | オリジナルをクラウドだけに保存しますか？ |
| warn body | 备份完成后，这台手机上的原图会被删除，只保留缩略图。之后图片只存在你的云库里：云库被删除、账号丢失或忘记密码，这些图就找不回来了。离线时只能看缩略图。可以随时切回「本地+云端」，届时会重新下载全部原图。 | 備份完成後，這台手機上的原圖會被刪除，只保留縮圖。之後圖片只存在你的雲端媒體庫：媒體庫被刪除、帳號遺失或忘記密碼，這些圖就無法找回。離線時只能看縮圖。可以隨時切回「本機+雲端」，屆時會重新下載全部原圖。 | After backup, the originals on this phone are deleted and only thumbnails stay. Your images then exist only in your cloud library: if the library is deleted, the account is lost or you forget the password, they cannot be recovered. Offline you can see thumbnails only. You can switch back to “This phone + cloud” at any time; every original is then downloaded again. | バックアップ後、この端末のオリジナルは削除され、サムネイルだけが残ります。以後、画像はクラウドライブラリにしかありません。ライブラリの削除、アカウントの紛失、パスワードの忘れがあると復元できません。オフラインではサムネイルしか見られません。いつでも「端末+クラウド」に戻せます。その場合、すべてのオリジナルを再ダウンロードします。 |
| warn confirm | 开启仅云端 | 開啟僅雲端 | Turn on | オンにする |
| back title | 恢复本地+云端？ | 恢復本機+雲端？ | Keep originals on this phone again? | 端末+クラウドに戻しますか？ |
| back body | 将把 {{count}} 张原图重新下载到这台手机（约 {{size}}）。 | 將把 {{count}} 張原圖重新下載到這台手機（約 {{size}}）。 | {{count}} originals (about {{size}}) will be downloaded to this phone again. | {{count}} 枚のオリジナル（約 {{size}}）をこの端末に再ダウンロードします。 |
| back confirm | 恢复 | 恢復 | Download | 戻す |
| progress (cloud-only) | 仅云端 · 云端 {{inCloud}} 张 · 待上传 {{pending}} 张 | 僅雲端 · 雲端 {{inCloud}} 張 · 待上傳 {{pending}} 張 | Cloud only · {{inCloud}} in the cloud · {{pending}} waiting to upload | クラウドのみ · クラウド {{inCloud}} 枚 · アップロード待ち {{pending}} 枚 |
| disconnect extra | 这台手机上有 {{count}} 张图只在云端。断开后只能看缩略图；重新连接同一个云库即可恢复。 | 這台手機上有 {{count}} 張圖只在雲端。中斷後只能看縮圖；重新連接同一個雲端媒體庫即可恢復。 | {{count}} images on this phone are only in the cloud. After disconnecting you will see thumbnails only; connect the same library again to get them back. | この端末の {{count}} 枚の画像はクラウドにしかありません。切断するとサムネイルしか見られません。同じライブラリに再接続すると元に戻ります。 |
| detail offline note (S4) | 离线，只能看缩略图 | 離線，只能看縮圖 | Offline — showing the thumbnail only | オフラインのためサムネイルのみ表示 |
| detail locked note (S4) | 云库暂时连不上，只能看缩略图 | 雲端媒體庫暫時無法連線，只能看縮圖 | Can’t reach your cloud library — showing the thumbnail only | クラウドライブラリに接続できないためサムネイルのみ表示 |
| tile a11y state (S4) | 仅在云端 | 僅在雲端 | In the cloud only | クラウドのみ |
| share offline (S4) | 这张图只在云端，连网后才能分享或导出。 | 這張圖只在雲端，連網後才能分享或匯出。 | This image is only in your cloud library. Connect to the internet to share or export it. | この画像はクラウドにしかありません。共有や書き出しにはネット接続が必要です。 |
| backup summary (S4) | ，{{count}} 张只在云端，未写入 | ，{{count}} 張只在雲端，未寫入 | , {{count}} only in the cloud (not included) | 、クラウドのみの {{count}} 枚は含まれていません |
| share disconnected (S4) | 这张图只在云库里，重新连接云库后才能分享或导出。 | 這張圖只在雲端媒體庫，重新連接雲端媒體庫後才能分享或匯出。 | This image is only in your cloud library. Connect your cloud library again to share or export it. | この画像はクラウドライブラリにしかありません。共有や書き出しにはクラウドライブラリへの再接続が必要です。 |
| detail disconnected note (S4) | 已断开云库，只能看缩略图 | 已中斷雲端媒體庫，只能看縮圖 | Disconnected from your cloud library — showing the thumbnail only | クラウドライブラリから切断されているためサムネイルのみ表示 |
| missing placeholder (S4) | 原图已不在这台手机上。 | 原圖已不在這台手機上。 | The original is no longer on this phone. | オリジナルはこの端末にありません。 |
| disconnected placeholder (S4) | 已断开云库，重新连接后可查看 | 已中斷雲端媒體庫，重新連接後可查看 | Disconnected from your cloud library — connect it again to view | クラウドライブラリから切断されています。再接続すると表示できます |
| offline placeholder detail (S4) | 此图片只在云库里，连网后即可查看。 | 此圖片只在雲端媒體庫，連網後即可查看。 | This image is only in your cloud library. Connect to the internet to view it. | この画像はクラウドライブラリにしかありません。ネット接続すると表示できます。 |
| no cloud library (S4) | 此设备未连接云库，原图仅保存在本机。 | 此裝置未連接雲端媒體庫，原圖僅保存在本機。 | No cloud library is connected on this device. Originals stay on this device only. | この端末はクラウドライブラリに接続されていません。オリジナルはこの端末だけに保存されます。 |
| trash delete confirm (S4) | 将从云库中永久删除此图片，并同步到你的每一台设备。此操作无法撤销。 | 將從雲端媒體庫中永久刪除此圖片，並同步到你的每一台裝置。此操作無法復原。 | Permanently delete this image from your cloud library on every device? This cannot be undone. | この画像をクラウドライブラリからすべての端末で完全に削除します。この操作は元に戻せません。 |
| disconnect failed (S4) | 未能完全断开此设备，请再试一次。 | 未能完全中斷此裝置，請再試一次。 | This device could not be fully disconnected. Try again. | この端末の切断を完了できませんでした。もう一度お試しください。 |
| delete-all forget label (S4) | 云库图片记录 | 雲端媒體庫圖片紀錄 | the cloud library records | クラウドライブラリの記録 |
| back body (en, one) | — | — | {{count}} original (about {{size}}) will be downloaded to this phone again. | — |
| disconnect extra (en, one) | — | — | {{count}} image on this phone is only in the cloud. After disconnecting you will see thumbnails only; connect the same library again to get it back. | — |

### End
