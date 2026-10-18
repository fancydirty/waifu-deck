import type { EventSubscription } from 'expo-modules-core';

export type UploadProgressEvent = {
  taskId: string;
  bytesSent: number;
  totalBytes: number;
};

/** K6-4c: bytes landed across every window of one parallel download. */
export type DownloadProgressEvent = {
  taskId: string;
  bytesReceived: number;
  totalBytes: number;
};

/** IME height in dp, the same unit as React Native `keyboardDidShow`. */
export type ImeHeightEvent = {
  height: number;
  visible: boolean;
};

export type NativeUploadResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type NativeRangeDownloadResponse = {
  status: number;
};

export type NativeDownloadResponse = Readonly<{
  status: number;
  headers: Record<string, string>;
  redirected: boolean;
  errorBody: string;
  /** Bytes written to destPath (0 for a non-2xx response). */
  bytesWritten: number;
}>;

export type NativeDecryptResponse = Readonly<{
  plaintextBytes: number;
  /** Lowercase hex, identical to DigestPort and asset plaintextSha256. */
  plaintextSha256: string;
}>;

export type NativeEncryptResponse = Readonly<{
  plaintextBytes: number;
  envelopeBytes: number;
  plaintextSha256: string;
  envelopeSha256: string;
}>;

export type NativeBackupImportCopyResponse = Readonly<{
  bytesWritten: number;
  /** Lowercase hex SHA-256 of the streamed bytes, or empty string when absent. */
  plaintextSha256: string;
}>;

export type InstalledAppVersionInfo = Readonly<{
  versionCode: number;
  versionName: string;
  isDebuggable: boolean;
}>;

export type ApkVerificationFailureReason =
  | 'invalid_path'
  | 'missing_file'
  | 'size_mismatch'
  | 'invalid_expected_sha256'
  | 'sha256_mismatch'
  | 'sha256_read_error'
  | 'invalid_archive'
  | 'package_mismatch'
  | 'version_mismatch';

export type ApkVerificationResponse = Readonly<
  | { valid: true; reason: null }
  | { valid: false; reason: ApkVerificationFailureReason }
>;

export type NativeFileErrorCode =
  | 'ERR_DOWNLOAD_NETWORK'
  | 'ERR_DOWNLOAD_CANCELLED'
  | 'ERR_LIBRARY_FORMAT'
  | 'ERR_LIBRARY_INTEGRITY'
  | 'ERR_LIBRARY_CANCELLED'
  | 'ERR_LIBRARY_IO'
  | 'ERR_TASK_DUPLICATE';

export type LibraryObjectScope = 'original' | 'thumbnail' | 'preview';

/**
 * Declared structurally rather than as `NativeModule<Events>`: exported as a
 * *type*, `NativeModule` resolves to the class itself, so a module object is
 * never assignable to it.
 */
export type WaifuSyncServiceModule = {
  /** Starts (or re-texts) the `dataSync` foreground notification. */
  start(title: string, text: string): Promise<void>;
  update(title: string, text: string): Promise<void>;
  stop(): Promise<void>;
  isBatteryOptimizationIgnored(): boolean;
  setModalStatusBarStyle(lightIcons: boolean): void;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  getInstalledAppVersion(): InstalledAppVersionInfo;
  canRequestPackageInstalls(): boolean;
  openUnknownAppSourcesSettings(): Promise<void>;
  installUpdateApk(apkPath: string): Promise<void>;
  sweepUpdateApks(installedVersionCode: number): Promise<number>;
  verifyDownloadedApk(
    apkPath: string,
    expectedVersionCode: number,
    expectedSizeBytes: number,
    expectedSha256: string,
  ): Promise<ApkVerificationResponse>;
  /**
   * Streaming PUT on the K6-1d tuned OkHttp client, with no timeouts (K7 #36).
   * Resolves for non-2xx too — the status is data, not an exception, so the
   * caller keeps its one status → failure-category mapping.
   */
  uploadFile(
    taskId: string,
    url: string,
    filePath: string,
    headers: Record<string, string>,
  ): Promise<NativeUploadResponse>;
  cancelUpload(taskId: string): Promise<void>;
  copyBackupFile(
    archiveUri: string,
    imageId: number,
    destinationUri: string,
  ): Promise<number>;
  copyBackupImportFile(
    archiveUri: string,
    plaintextSha256: string,
    destinationUri: string,
  ): Promise<NativeBackupImportCopyResponse>;
  /**
   * K6-4c. Fetches `[0, totalBytes - 1]` as `parts` simultaneous `Range` GETs
   * written at their offsets in one pre-sized file at `destPath`.
   *
   * Unlike {@link WaifuSyncServiceModule.uploadFile} this *rejects* on anything
   * but a complete set of 206s (`ERR_DOWNLOAD_RANGE`), having deleted the
   * partial file: a half-written image is not a status the caller could act on,
   * and the only sound response is the single-stream path from a clean slate.
   */
  downloadRanges(
    taskId: string,
    url: string,
    destPath: string,
    headers: Record<string, string>,
    totalBytes: number,
    parts: number,
  ): Promise<NativeRangeDownloadResponse>;
  downloadToFile(
    taskId: string,
    url: string,
    destPath: string,
    headers: Record<string, string>,
    maxBytes: number,
  ): Promise<NativeDownloadResponse>;
  cancelDownload(taskId: string): Promise<void>;
  decryptLibraryObjectToFile(
    taskId: string,
    sourcePath: string,
    destPath: string,
    masterKey: Uint8Array,
    assetId: string,
    scope: 'original' | 'thumbnail' | 'preview',
  ): Promise<NativeDecryptResponse>;
  cancelDecrypt(taskId: string): Promise<void>;
  copyFileToFileWithSha256(
    taskId: string,
    sourcePath: string,
    destPath: string,
  ): Promise<NativeDecryptResponse>;
  encryptLibraryObjectToFile(
    taskId: string,
    sourcePath: string,
    destPath: string,
    masterKey: Uint8Array,
    assetId: string,
    scope: 'original' | 'thumbnail' | 'preview',
  ): Promise<NativeEncryptResponse>;
  addListener(
    eventName: 'onUploadProgress',
    listener: (event: UploadProgressEvent) => void,
  ): EventSubscription;
  addListener(
    eventName: 'onDownloadProgress',
    listener: (event: DownloadProgressEvent) => void,
  ): EventSubscription;
  addListener(
    eventName: 'onImeHeightChange',
    listener: (event: ImeHeightEvent) => void,
  ): EventSubscription;
};
