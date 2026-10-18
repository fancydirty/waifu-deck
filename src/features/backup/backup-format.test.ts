import {
  BACKUP_APPLICATION_ID,
  BACKUP_FORMAT_VERSION,
  isValidBackupDigest,
  parseBackupManifest,
  restoreFileName,
  restoreImportStageFileName,
  safeBackupExtension,
  sqliteBlob,
} from '@/features/backup/backup-format';
import { asFileUri } from '@/features/backup/backup-service';

const manifestRow = {
  format_version: BACKUP_FORMAT_VERSION,
  application_id: BACKUP_APPLICATION_ID,
  app_version: '1.1.0',
  created_at: 123,
  image_count: 14,
  import_count: 3,
  file_count: 15,
  total_file_bytes: 42_000,
};

describe('backup format', () => {
  it('normalizes native Android database paths for Expo FileSystem', () => {
    expect(asFileUri('/data/user/0/app/files/SQLite/export.waifudeck')).toBe(
      'file:///data/user/0/app/files/SQLite/export.waifudeck',
    );
    expect(asFileUri('file:///data/user/0/app/files/SQLite/export.waifudeck')).toBe(
      'file:///data/user/0/app/files/SQLite/export.waifudeck',
    );
  });

  it('parses a valid v2 manifest and backward-compatible v1 manifest', () => {
    expect(parseBackupManifest(manifestRow)).toEqual({
      formatVersion: 2,
      applicationId: BACKUP_APPLICATION_ID,
      appVersion: '1.1.0',
      createdAt: 123,
      imageCount: 14,
      importCount: 3,
      fileCount: 15,
      totalFileBytes: 42_000,
    });

    const { import_count: _ignored, ...v1Row } = manifestRow;
    expect(parseBackupManifest({
      ...v1Row,
      format_version: 1,
    })).toEqual({
      formatVersion: 1,
      applicationId: BACKUP_APPLICATION_ID,
      appVersion: '1.1.0',
      createdAt: 123,
      imageCount: 14,
      importCount: 0,
      fileCount: 15,
      totalFileBytes: 42_000,
    });
  });

  it('keeps accepting backups created before dual distribution support', () => {
    expect(parseBackupManifest({
      ...manifestRow,
      application_id: 'app.waifudeck.mobile',
    }).applicationId).toBe('app.waifudeck.mobile');
  });

  it('rejects foreign and unsupported backups', () => {
    expect(() => parseBackupManifest({
      ...manifestRow,
      application_id: 'example.other.app',
    })).toThrow('different application');
    expect(() => parseBackupManifest({
      ...manifestRow,
      format_version: 0,
    })).toThrow('Unsupported backup format');
    expect(() => parseBackupManifest({
      ...manifestRow,
      format_version: 3,
    })).toThrow('Unsupported backup format');
  });

  it('rejects malformed counters', () => {
    expect(() => parseBackupManifest({
      ...manifestRow,
      file_count: -1,
    })).toThrow('file count');
    expect(() => parseBackupManifest({
      ...manifestRow,
      import_count: -1,
    })).toThrow('import count');
  });

  it('normalizes binary values, validates import digests, and builds restore filenames', () => {
    const source = Uint8Array.from([1, 2, 3]);
    expect([...sqliteBlob(source.buffer, 'database')]).toEqual([1, 2, 3]);
    expect(safeBackupExtension('.PNG')).toBe('png');
    expect(safeBackupExtension('../../db')).toBe('jpg');
    expect(restoreFileName(123, 9, '.WEBP')).toBe('restore-123-9.webp');

    const digest = 'a'.repeat(64);
    expect(isValidBackupDigest(digest)).toBe(true);
    expect(isValidBackupDigest('A'.repeat(64))).toBe(false);
    expect(isValidBackupDigest('a'.repeat(63))).toBe(false);
    expect(restoreImportStageFileName('restore-stage-1', 123, digest, '.PNG')).toBe(
      `restore-stage-1-restore-import-123-${digest}.png`,
    );
    expect(() => restoreImportStageFileName('restore-stage-1', 123, 'bad', '.png')).toThrow(
      'Invalid backup import digest',
    );
  });
});
