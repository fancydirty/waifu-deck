import { cloudFetch } from '@/features/byos/cloud-fetch';
import { createByosCredentialStore, type ByosBinding, type ByosCredentialStore, type OneDriveBinding } from '@/features/byos/byos-credentials';
import { selectDownloadFilePort } from '@/features/byos/s3-file-download';
import { selectUploadFilePort } from '@/features/byos/s3-file-transfer';

import { WaifuSyncService } from '../../../modules/waifu-sync-service';

import type { CloudObjectStore } from './cloud-object-store';
import { refreshTokens } from './microsoft-oauth';
import { createMicrosoftTokenSource } from './microsoft-token-source';
import { createOneDriveCloudObjectStore } from './onedrive-cloud-object-store';

/**
 * P12-C Task 7: writes a rotated personal-account refresh token back over the
 * stored `onedrive` binding, but only when its `rootFolderId` still matches
 * the binding this store was built from. This is a `rootFolderId`-equality
 * check only — it stops a late rotation from an old, abandoned store from
 * clobbering a binding that has since gone missing, switched `kind`, or
 * switched to a different OneDrive app-folder id. It does NOT protect
 * against a re-login to the SAME Microsoft account: that account's
 * `rootFolderId` (its OneDrive app-folder id) is stable across sign-outs and
 * sign-ins, so a same-account re-bind still compares equal and the write
 * still lands — that is a feature here (a token refresh keeps working across
 * a re-login to the same account), not a broader identity guarantee.
 */
export async function persistRotatedToken(
  credentialStore: ByosCredentialStore,
  binding: OneDriveBinding,
  refreshToken: string,
): Promise<void> {
  const current: ByosBinding | null = await credentialStore.loadBinding();
  if (current === null || current.kind !== 'onedrive' || current.rootFolderId !== binding.rootFolderId) return;
  await credentialStore.saveBinding({ ...current, refreshToken });
}

/**
 * Re-slices whatever chunk sizes the producer hands back into exact
 * `fragmentBytes` pieces (the last one shorter), for Graph's upload-session
 * fragments. Every yielded piece is copied out of the internal queue with a
 * fresh `Uint8Array`, never a `subarray` view onto a chunk the producer might
 * still own — `expo-file-system`'s stream is free to reuse its read buffer
 * the moment `read()` is called again.
 */
export async function* fragmentsOf(stream: ReadableStream<Uint8Array>, fragmentBytes: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const pending: Uint8Array[] = [];
  let pendingLength = 0;
  let finished = false;

  function takeFragment(size: number): Uint8Array {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = pending[0]!;
      const need = size - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        pending.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        pending[0] = head.subarray(need);
        filled += need;
      }
    }
    pendingLength -= size;
    return out;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (!done) {
        pending.push(value.slice());
        pendingLength += value.byteLength;
        while (pendingLength >= fragmentBytes) {
          yield takeFragment(fragmentBytes);
        }
      } else {
        finished = true;
        if (pendingLength > 0) yield takeFragment(pendingLength);
        break;
      }
    }
  } finally {
    // The consumer left early (e.g. a `for await...of break`) without
    // draining the stream to `done: true`: release the producer instead of
    // leaving it running unread. Best-effort — a `cancel()` failure here
    // must not shadow whatever the consumer was already doing.
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // Ignored: see comment above.
      }
    }
    reader.releaseLock();
  }
}

/**
 * The device wiring for the OneDrive adapter: `expo/fetch` for Graph and the
 * K6-1g native uploader (or `expo-file-system`'s task where unlinked) for
 * `content` PUTs, an `expo-file-system` `File` for the two file ports a
 * fragmented upload session needs, and a token source that refreshes through
 * the real token endpoint and always persists every rotated refresh token
 * back onto this exact binding at once (personal accounts kill the previous
 * token the moment the new one is issued, so an opt-out here would silently
 * strand the account on the first refresh). Kept out of the adapter so unit
 * and contract tests inject the fake Graph and Node file doubles instead.
 */
export function createProductionOneDriveStore(
  binding: OneDriveBinding,
  opts: Readonly<{ accessToken?: string; expiresAt?: number; credentialStore?: ByosCredentialStore }> = {},
): CloudObjectStore {
  const fetchImpl = cloudFetch;
  const downloadFile = selectDownloadFilePort(WaifuSyncService);
  const credentialStore = opts.credentialStore ?? createByosCredentialStore();
  const tokens = createMicrosoftTokenSource({
    seed: { accessToken: opts.accessToken ?? null, refreshToken: binding.refreshToken, expiresAt: opts.expiresAt ?? 0 },
    refresh: (refreshToken) => refreshTokens(fetchImpl, { refreshToken }),
    onRotated: (refreshToken) => persistRotatedToken(credentialStore, binding, refreshToken),
  });
  return createOneDriveCloudObjectStore(
    { rootFolderId: binding.rootFolderId, stateFolderId: binding.stateFolderId, blobsFolderId: binding.blobsFolderId },
    {
      tokens,
      fetchImpl,
      uploadFile: selectUploadFilePort(WaifuSyncService),
      ...(downloadFile === null ? {} : { downloadFile }),
      statFile: async (fileUri) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { File } = require('expo-file-system') as typeof import('expo-file-system');
        const file = new File(fileUri);
        return file.exists ? file.size : null;
      },
      readFragments: (fileUri, fragmentBytes) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { File } = require('expo-file-system') as typeof import('expo-file-system');
        return fragmentsOf(new File(fileUri).readableStream(), fragmentBytes);
      },
    },
  );
}
