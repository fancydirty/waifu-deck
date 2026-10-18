package expo.modules.waifusync;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure JVM helper for Ledger N11 in-app APK verification, unknown-sources
 * settings intent resolution, and cache sweeping.
 * Tested directly under JUnit (`AppUpdateInstallerTest`) and invoked by
 * `AppUpdateInstaller.kt`.
 */
public final class AppUpdateHelper {
  private static final Pattern APK_NAME_PATTERN = Pattern.compile("^waifudeck-(\\d{1,9})\\.apk$");
  private static final int BUFFER_SIZE = 64 * 1024;
  private static final Object LOCK = new Object();

  public static final String ACTION_MANAGE_UNKNOWN_APP_SOURCES =
      "android.settings.MANAGE_UNKNOWN_APP_SOURCES";
  public static final String ACTION_SECURITY_SETTINGS =
      "android.settings.SECURITY_SETTINGS";
  public static final String ACTION_APPLICATION_DETAILS_SETTINGS =
      "android.settings.APPLICATION_DETAILS_SETTINGS";

  public static final List<String> UNKNOWN_SOURCES_ACTIONS =
      Collections.unmodifiableList(
          Arrays.asList(
              ACTION_MANAGE_UNKNOWN_APP_SOURCES,
              ACTION_SECURITY_SETTINGS,
              ACTION_APPLICATION_DETAILS_SETTINGS));

  private AppUpdateHelper() {}

  public static String firstResolvableUnknownSourcesAction(Predicate<String> resolves) {
    if (resolves == null) return null;
    for (String action : UNKNOWN_SOURCES_ACTIONS) {
      if (resolves.test(action)) return action;
    }
    return null;
  }

  public static boolean unknownSourcesActionNeedsPackageUri(String action) {
    return ACTION_MANAGE_UNKNOWN_APP_SOURCES.equals(action)
        || ACTION_APPLICATION_DETAILS_SETTINGS.equals(action);
  }

  public static final class ArchiveMetadata {
    private final String packageName;
    private final int versionCode;

    public ArchiveMetadata(String packageName, int versionCode) {
      this.packageName = packageName;
      this.versionCode = versionCode;
    }

    public String getPackageName() {
      return packageName;
    }

    public int getVersionCode() {
      return versionCode;
    }
  }

  public interface ArchiveInspector {
    ArchiveMetadata inspect(File apkFile);
  }

  public static final class VerificationResult {
    private final boolean valid;
    private final String reason;

    private VerificationResult(boolean valid, String reason) {
      this.valid = valid;
      this.reason = reason;
    }

    public static VerificationResult ok() {
      return new VerificationResult(true, null);
    }

    public static VerificationResult fail(String reason) {
      return new VerificationResult(false, reason);
    }

    public boolean isValid() {
      return valid;
    }

    public String getReason() {
      return reason;
    }
  }

  /**
   * Parses `versionCode` from a canonical `waifudeck-<versionCode>.apk` file name,
   * or returns `-1` for `.part` or non-matching names.
   */
  public static int parseApkVersionCode(String fileName) {
    if (fileName == null) return -1;
    Matcher matcher = APK_NAME_PATTERN.matcher(fileName);
    if (!matcher.matches()) return -1;
    try {
      int code = Integer.parseInt(matcher.group(1));
      return code > 0 ? code : -1;
    } catch (NumberFormatException ignored) {
      return -1;
    }
  }

  /**
   * Returns true iff `targetFile` resolves canonically inside `updateDir`.
   * Prevents any accidental or malformed path outside `cache/app-updates/` from
   * being deleted during verification or exposed via FileProvider during install.
   */
  public static boolean isContainedInUpdateDir(File updateDir, File targetFile) {
    if (updateDir == null || targetFile == null) return false;
    try {
      File canonicalDir = updateDir.getCanonicalFile();
      File canonicalFile = targetFile.getCanonicalFile();
      File parent = canonicalFile.getParentFile();
      return parent != null && parent.equals(canonicalDir);
    } catch (IOException ignored) {
      return false;
    }
  }

  /**
   * Sweeps `updateDir` (`cache/app-updates/`):
   * - deletes all `.part` or unrecognized files;
   * - deletes any `waifudeck-<code >.apk` whose `code <= installedVersionCode`;
   * - preserves only `waifudeck-<code >.apk` where `code > installedVersionCode`.
   */
  public static int sweepDirectory(File updateDir, int installedVersionCode) {
    synchronized (LOCK) {
      if (updateDir == null || !updateDir.exists() || !updateDir.isDirectory()) {
        return 0;
      }
      File[] files = updateDir.listFiles();
      if (files == null) return 0;
      int deleted = 0;
      for (File file : files) {
        int code = file.isFile() ? parseApkVersionCode(file.getName()) : -1;
        if (code <= 0 || code <= installedVersionCode) {
          if (deleteRecursively(file)) {
            deleted += 1;
          }
        }
      }
      return deleted;
    }
  }

  private static boolean deleteRecursively(File target) {
    if (target.isDirectory()) {
      File[] children = target.listFiles();
      if (children != null) {
        for (File child : children) {
          deleteRecursively(child);
        }
      }
    }
    return target.delete();
  }

  /**
   * Computes lowercase 64-char hex SHA-256 of `file` in 64 KiB streaming chunks.
   */
  public static String computeFileSha256Hex(File file) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    byte[] buffer = new byte[BUFFER_SIZE];
    try (InputStream in = new FileInputStream(file)) {
      int read;
      while ((read = in.read(buffer)) != -1) {
        if (read > 0) {
          digest.update(buffer, 0, read);
        }
      }
    }
    byte[] raw = digest.digest();
    StringBuilder hex = new StringBuilder(64);
    for (byte b : raw) {
      hex.append(String.format(Locale.US, "%02x", b & 0xff));
    }
    return hex.toString();
  }

  /**
   * Verifies `apkFile` against containment inside `updateDir`, expected byte size,
   * SHA-256 digest, package name, and versionCode. Deletes `apkFile` immediately
   * if any content check fails (only after confirming `isContainedInUpdateDir`).
   */
  public static VerificationResult verifyFileAndArchive(
      File updateDir,
      File apkFile,
      int expectedVersionCode,
      long expectedSizeBytes,
      String expectedSha256,
      String expectedPackageName,
      ArchiveInspector inspector
  ) {
    synchronized (LOCK) {
      if (!isContainedInUpdateDir(updateDir, apkFile)) {
        return VerificationResult.fail("invalid_path");
      }
      if (!apkFile.exists() || !apkFile.isFile()) {
        return VerificationResult.fail("missing_file");
      }
      if (expectedSizeBytes <= 0 || apkFile.length() != expectedSizeBytes) {
        apkFile.delete();
        return VerificationResult.fail("size_mismatch");
      }
      String normalizedExpectedSha =
          expectedSha256 == null ? "" : expectedSha256.trim().toLowerCase(Locale.US);
      if (!BackupImportStreamHelper.isValidSha256Hex(normalizedExpectedSha)) {
        apkFile.delete();
        return VerificationResult.fail("invalid_expected_sha256");
      }
      try {
        String actualSha = computeFileSha256Hex(apkFile);
        if (!actualSha.equals(normalizedExpectedSha)) {
          apkFile.delete();
          return VerificationResult.fail("sha256_mismatch");
        }
      } catch (Throwable error) {
        apkFile.delete();
        return VerificationResult.fail("sha256_read_error");
      }

      ArchiveMetadata meta;
      try {
        meta = inspector == null ? null : inspector.inspect(apkFile);
      } catch (Throwable error) {
        meta = null;
      }
      if (meta == null || meta.getPackageName() == null) {
        apkFile.delete();
        return VerificationResult.fail("invalid_archive");
      }
      if (!meta.getPackageName().equals(expectedPackageName)) {
        apkFile.delete();
        return VerificationResult.fail("package_mismatch");
      }
      if (meta.getVersionCode() != expectedVersionCode) {
        apkFile.delete();
        return VerificationResult.fail("version_mismatch");
      }
      return VerificationResult.ok();
    }
  }
}
