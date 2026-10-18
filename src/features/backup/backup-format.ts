export const BACKUP_FORMAT_VERSION = 2;
export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1, 2] as const;
export const BACKUP_APPLICATION_ID = 'waifu-deck-backup';
export const LEGACY_BACKUP_APPLICATION_IDS = [
  'app.waifudeck.mobile',
] as const;

const BACKUP_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type BackupManifest = {
  formatVersion: number;
  applicationId: string;
  appVersion: string;
  createdAt: number;
  imageCount: number;
  importCount?: number;
  fileCount: number;
  totalFileBytes: number;
};

type BackupManifestRow = {
  format_version: unknown;
  application_id: unknown;
  app_version: unknown;
  created_at: unknown;
  image_count: unknown;
  import_count?: unknown;
  file_count: unknown;
  total_file_bytes: unknown;
};

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid backup ${field}.`);
  }
  return Number(value);
}

export function isValidBackupDigest(value: unknown): value is string {
  return typeof value === 'string' && BACKUP_DIGEST_PATTERN.test(value);
}

export function parseBackupManifest(row: BackupManifestRow | null): BackupManifest {
  if (row === null) throw new Error('Backup manifest is missing.');

  const formatVersion = nonNegativeInteger(row.format_version, 'format version');
  if (
    !SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(
      formatVersion as typeof SUPPORTED_BACKUP_FORMAT_VERSIONS[number],
    )
  ) {
    throw new Error(`Unsupported backup format version: ${formatVersion}.`);
  }
  const applicationId = row.application_id;
  if (
    typeof applicationId !== 'string'
    || (
      applicationId !== BACKUP_APPLICATION_ID
      && !LEGACY_BACKUP_APPLICATION_IDS.includes(
        applicationId as typeof LEGACY_BACKUP_APPLICATION_IDS[number],
      )
    )
  ) {
    throw new Error('This backup belongs to a different application.');
  }
  if (typeof row.app_version !== 'string' || row.app_version.length === 0) {
    throw new Error('Backup app version is missing.');
  }

  const importCount = formatVersion === 1 && row.import_count === undefined
    ? 0
    : nonNegativeInteger(row.import_count ?? 0, 'import count');

  return {
    formatVersion,
    applicationId,
    appVersion: row.app_version,
    createdAt: nonNegativeInteger(row.created_at, 'creation time'),
    imageCount: nonNegativeInteger(row.image_count, 'image count'),
    importCount,
    fileCount: nonNegativeInteger(row.file_count, 'file count'),
    totalFileBytes: nonNegativeInteger(row.total_file_bytes, 'file size'),
  };
}

export function sqliteBlob(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`Backup ${field} is not binary data.`);
}

export function safeBackupExtension(extension: string): string {
  const normalized = extension.trim().toLowerCase().replace(/^\.+/, '');
  return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(normalized)
    ? normalized
    : 'jpg';
}

export function restoreFileName(
  createdAt: number,
  imageId: number,
  extension: string,
): string {
  return `restore-${createdAt}-${imageId}.${safeBackupExtension(extension)}`;
}

export function restoreImportStageFileName(
  namespace: string,
  createdAt: number,
  plaintextSha256: string,
  extension: string,
): string {
  if (!isValidBackupDigest(plaintextSha256)) {
    throw new Error('Invalid backup import digest.');
  }
  return `${namespace}-restore-import-${createdAt}-${plaintextSha256}.${safeBackupExtension(extension)}`;
}
