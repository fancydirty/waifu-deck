/**
 * Shared scaffolding for the real-Google-Drive suites (P12-D, spec §8; plan
 * Task 12 Step 3): the BYOS_GDRIVE_* environment `scripts/run-byos-gdrive-gate.mjs`
 * supplies, one `it-<run>/{state,blobs}` folder set per run under the user-visible
 * `Waifu Deck` folder, and its deletion — ONE `files.delete` on the run folder
 * removes every descendant (补裁 5). The gate refreshes once up front and hands
 * over a FRESH access token with its expiry, so the suites never refresh
 * mid-run; Google does not rotate refresh tokens (补裁 3), so there is nothing
 * to write back even if one did.
 *
 * `observingFetch` records, as-is, the facts Step 5 must report (补裁 5/8/13):
 * whether `alt=media` was answered through a redirect, whether any response
 * mentioned `acknowledgeAbuse`/`cannotDownloadAbusiveFile`, every 403/429 with
 * its `reason`, and any `Retry-After` header. The resumable session's whole-file
 * PUT goes through the Node upload port, which returns a bare status — its
 * error reasons are not observable without a hook, so they are not recorded.
 */
import { refreshGoogleTokens } from '@/features/cloud-store/google-oauth';
import { createGoogleTokenSource, type GoogleTokenSource } from '@/features/cloud-store/google-token-source';
import { createGoogleDriveCloudObjectStore, DRIVE_BASE, DRIVE_FOLDER_MIME, type GoogleDriveFolderIds } from '@/features/cloud-store/gdrive-cloud-object-store';
import { bootstrapGoogleDriveLayout } from '@/features/cloud-store/gdrive-layout';
import type { S3UploadFilePort } from '@/features/byos/s3-transport';
import { createNodeDownloadFilePort, createNodeFileStat, createNodeUploadFilePort } from '@/test/node-file-transfer';

export const refreshToken = process.env.BYOS_GDRIVE_REFRESH_TOKEN ?? '';
export const accessToken = process.env.BYOS_GDRIVE_ACCESS_TOKEN ?? '';
const expiresAt = Number(process.env.BYOS_GDRIVE_EXPIRES_AT ?? '0');
const clientId = process.env.BYOS_GDRIVE_CLIENT_ID ?? '';
const clientSecret = process.env.BYOS_GDRIVE_CLIENT_SECRET ?? '';
export const label = process.env.BYOS_GDRIVE_LABEL ?? 'owner Google Drive';
export const large = process.env.BYOS_GDRIVE_LARGE === '1';
export const configured = Boolean(refreshToken && accessToken && clientId && clientSecret);

export const observations = {
  mediaGets: 0,
  mediaRedirected: 0,
  mediaFinalHosts: new Set<string>(),
  abuseMentions: 0,
  errorStatuses: [] as string[],
  retryAfter: [] as string[],
  refreshes: 0,
};

export async function observingFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (/[?&]alt=media(&|$)/.test(input)) {
    observations.mediaGets += 1;
    if (res.redirected) observations.mediaRedirected += 1;
    observations.mediaFinalHosts.add(new URL(res.url || input).host);
  }
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter !== null) observations.retryAfter.push(`${res.status} ${retryAfter}`);
  if (res.status >= 400) {
    const text = await res.clone().text().catch(() => '');
    let reason = '';
    try { reason = (JSON.parse(text) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason ?? ''; } catch { /* not JSON */ }
    if (/acknowledgeAbuse|cannotDownloadAbusiveFile/i.test(text)) observations.abuseMentions += 1;
    observations.errorStatuses.push(`${init?.method ?? 'GET'} ${res.status}${reason ? ` ${reason}` : ''}`);
  }
  return res;
}

/** One line per suite so the Step 5 ledger can quote each observation verbatim from the log. */
export function logObservations(suite: string): void {
  const o = observations;
  const hosts = [...o.mediaFinalHosts].join(',') || 'none';
  const errors = o.errorStatuses.length === 0 ? 'none' : o.errorStatuses.join('; ');
  const retry = o.retryAfter.length === 0 ? 'none' : o.retryAfter.join('; ');
  console.log(`[gdrive-observe] ${suite}: alt=media GETs ${o.mediaGets}, answered via redirect ${o.mediaRedirected}, final hosts ${hosts}; acknowledgeAbuse mentions ${o.abuseMentions}; 4xx/5xx ${errors}; Retry-After ${retry}; token refreshes ${o.refreshes}`);
}

export const tokens: GoogleTokenSource = createGoogleTokenSource({
  seed: { accessToken: accessToken || null, refreshToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 },
  refresh: (rt) => {
    observations.refreshes += 1;
    return refreshGoogleTokens(fetch as never, { refreshToken: rt, clientId, clientSecret });
  },
});

async function drive(method: string, url: string, body?: unknown): Promise<Response> {
  return observingFetch(url, { method, headers: { authorization: `Bearer ${await tokens.getAccessToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json; charset=UTF-8' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function mkdir(parentId: string, name: string): Promise<string> {
  const r = await drive('POST', `${DRIVE_BASE}/files?fields=id`, { name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] });
  if (!r.ok) throw new Error(`create ${name}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

/** `Waifu Deck/it-<run>/` with `state`/`blobs`; the run folder is the adapter's root. The `Waifu Deck` folder comes from the production bootstrap. */
export async function createRunLayout(run: string): Promise<GoogleDriveFolderIds & { runFolderId: string }> {
  const { ids } = await bootstrapGoogleDriveLayout(observingFetch, await tokens.getAccessToken());
  const runFolderId = await mkdir(ids.rootFolderId, `it-${run}`);
  return { runFolderId, rootFolderId: runFolderId, stateFolderId: await mkdir(runFolderId, 'state'), blobsFolderId: await mkdir(runFolderId, 'blobs') };
}
/**
 * Runs in each test's `finally`: it must never throw, or a cleanup failure (e.g. a DELETE on a connection the
 * stall watchdog just aborted) replaces the test's real error in the report — which is what hid the 61 MiB
 * `stalled` cause behind a raw `fetch failed` in run 1. It logs instead; a folder left behind is swept by
 * the next run.
 */
export async function deleteRunFolder(runFolderId: string): Promise<void> {
  try {
    const r = await drive('DELETE', `${DRIVE_BASE}/files/${encodeURIComponent(runFolderId)}`);
    console.log(`[gdrive-cleanup] DELETE it-<run> folder ${runFolderId} → ${r.status}`);
  } catch (error) {
    console.log(`[gdrive-cleanup] DELETE it-<run> folder ${runFolderId} FAILED (${error instanceof Error ? error.message : String(error)}) — left behind`);
  }
}
export function storeFor(ids: GoogleDriveFolderIds, uploadFile: S3UploadFilePort = createNodeUploadFilePort(), stallMs?: number) {
  return createGoogleDriveCloudObjectStore(ids, { tokens, fetchImpl: observingFetch, uploadFile, downloadFile: createNodeDownloadFilePort(observingFetch as typeof fetch), statFile: createNodeFileStat(), ...(stallMs === undefined ? {} : { stallMs }) });
}
export const factory = async (run: string) => {
  const ids = await createRunLayout(run);
  return { store: storeFor(ids), dispose: () => deleteRunFolder(ids.runFolderId) };
};
