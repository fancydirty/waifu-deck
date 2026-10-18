const VERSION_NAME_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LATEST_RELEASE_URL = 'https://waifudeck.app/api/app/latest';
export const MAX_APK_DOWNLOAD_BYTES = 250 * 1024 * 1024; // 250 MiB ceiling

export type AppRelease = Readonly<{
  versionCode: number;
  versionName: string;
  publishedAt: string;
  sizeBytes: number;
  sha256: string;
  notes: string;
  downloadUrl: string;
}>;

export type UpdateOffer = Readonly<{
  release: AppRelease;
  shouldAutoPopup: boolean;
}>;

/**
 * Parses and validates an `AppRelease` JSON payload from `/api/app/latest` or
 * persisted cache. Returns `null` if any required field is invalid or if
 * `downloadUrl` does not use `https://`.
 */
export function parseAppRelease(raw: unknown): AppRelease | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const versionCode = candidate.versionCode;
  const versionName = candidate.versionName;
  const publishedAt = candidate.publishedAt;
  const sizeBytes = candidate.sizeBytes;
  const sha256 =
    typeof candidate.sha256 === 'string' ? candidate.sha256.trim().toLowerCase() : '';
  const downloadUrl = candidate.downloadUrl;
  const notes = typeof candidate.notes === 'string' ? candidate.notes.trim() : '';

  if (
    typeof versionCode !== 'number' ||
    !Number.isInteger(versionCode) ||
    versionCode <= 0 ||
    typeof versionName !== 'string' ||
    !VERSION_NAME_PATTERN.test(versionName) ||
    typeof publishedAt !== 'string' ||
    publishedAt.length === 0 ||
    typeof sizeBytes !== 'number' ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_APK_DOWNLOAD_BYTES ||
    !SHA256_HEX_PATTERN.test(sha256) ||
    typeof downloadUrl !== 'string' ||
    !downloadUrl.startsWith('https://')
  ) {
    return null;
  }

  return {
    versionCode,
    versionName,
    publishedAt,
    sizeBytes,
    sha256,
    notes,
    downloadUrl,
  };
}

/**
 * Returns true when automatic update checking is enabled and either 24h have
 * elapsed since `lastCheckAtMs` or the device clock moved backward.
 */
export function shouldAutoCheck(
  autoCheckEnabled: boolean,
  lastCheckAtMs: number,
  nowMs: number,
): boolean {
  if (!autoCheckEnabled) return false;
  return nowMs < lastCheckAtMs || nowMs - lastCheckAtMs >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Computes whether a newer release is available and whether the automatic modal
 * should pop up (`release.versionCode > dismissedVersionCode`).
 */
export function computeUpdateOffer(
  installedVersionCode: number,
  cachedRelease: AppRelease | null,
  dismissedVersionCode: number,
): UpdateOffer | null {
  if (cachedRelease === null || cachedRelease.versionCode <= installedVersionCode) {
    return null;
  }
  return {
    release: cachedRelease,
    shouldAutoPopup: cachedRelease.versionCode > dismissedVersionCode,
  };
}
