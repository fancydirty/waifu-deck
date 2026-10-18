package expo.modules.waifusync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import org.junit.Test;

public final class AppUpdateInstallerTest {
  private static String sha256Hex(byte[] bytes) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
    StringBuilder sb = new StringBuilder(64);
    for (byte b : digest) {
      sb.append(String.format("%02x", b & 0xff));
    }
    return sb.toString();
  }

  @Test
  public void parseApkVersionCodeExtractsCodeFromCanonicalFilenameOnly() {
    assertEquals(1002000, AppUpdateHelper.parseApkVersionCode("waifudeck-1002000.apk"));
    assertEquals(1002001, AppUpdateHelper.parseApkVersionCode("waifudeck-1002001.apk"));
    assertEquals(-1, AppUpdateHelper.parseApkVersionCode("waifudeck-1002001.apk.part"));
    assertEquals(-1, AppUpdateHelper.parseApkVersionCode("other-1002001.apk"));
    assertEquals(-1, AppUpdateHelper.parseApkVersionCode("waifudeck-abc.apk"));
    assertEquals(-1, AppUpdateHelper.parseApkVersionCode(null));
  }

  @Test
  public void firstResolvableUnknownSourcesActionWalksFallbackChainAndPackageUriRule() {
    assertEquals(
        AppUpdateHelper.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        AppUpdateHelper.firstResolvableUnknownSourcesAction(action -> true));
    assertEquals(
        AppUpdateHelper.ACTION_SECURITY_SETTINGS,
        AppUpdateHelper.firstResolvableUnknownSourcesAction(
            action -> !AppUpdateHelper.ACTION_MANAGE_UNKNOWN_APP_SOURCES.equals(action)));
    assertEquals(
        AppUpdateHelper.ACTION_APPLICATION_DETAILS_SETTINGS,
        AppUpdateHelper.firstResolvableUnknownSourcesAction(
            AppUpdateHelper.ACTION_APPLICATION_DETAILS_SETTINGS::equals));
    assertNull(AppUpdateHelper.firstResolvableUnknownSourcesAction(action -> false));

    assertTrue(
        AppUpdateHelper.unknownSourcesActionNeedsPackageUri(
            AppUpdateHelper.ACTION_MANAGE_UNKNOWN_APP_SOURCES));
    assertFalse(
        AppUpdateHelper.unknownSourcesActionNeedsPackageUri(
            AppUpdateHelper.ACTION_SECURITY_SETTINGS));
    assertTrue(
        AppUpdateHelper.unknownSourcesActionNeedsPackageUri(
            AppUpdateHelper.ACTION_APPLICATION_DETAILS_SETTINGS));
  }

  @Test
  public void isContainedInUpdateDirRejectsOutsideOrTraversalPathsWithoutDeletingThem() throws Exception {
    File root = Files.createTempDirectory("wd-update-containment").toFile();
    File updateDir = new File(root, "app-updates");
    updateDir.mkdirs();
    File outsideFile = new File(root, "waifu-deck.db");
    try (FileOutputStream out = new FileOutputStream(outsideFile)) {
      out.write("db-bytes".getBytes(StandardCharsets.UTF_8));
    }
    try {
      File insideFile = new File(updateDir, "waifudeck-1002001.apk");
      File traversalFile = new File(updateDir, "../waifu-deck.db");
      assertTrue(AppUpdateHelper.isContainedInUpdateDir(updateDir, insideFile));
      assertFalse(AppUpdateHelper.isContainedInUpdateDir(updateDir, outsideFile));
      assertFalse(AppUpdateHelper.isContainedInUpdateDir(updateDir, traversalFile));

      AppUpdateHelper.VerificationResult res = AppUpdateHelper.verifyFileAndArchive(
          updateDir,
          traversalFile,
          1002001,
          999L,
          "0".repeat(64),
          "app.waifudeck.mobile",
          f -> new AppUpdateHelper.ArchiveMetadata("app.waifudeck.mobile", 1002001));
      assertFalse(res.isValid());
      assertEquals("invalid_path", res.getReason());
      // Must NOT delete files outside updateDir!
      assertTrue(outsideFile.exists());
    } finally {
      outsideFile.delete();
      updateDir.delete();
      root.delete();
    }
  }

  @Test
  public void sweepUpdateDirectoryDeletesPartFilesAndInstalledOrOlderApksWhilePreservingNewerApk() throws Exception {
    File dir = Files.createTempDirectory("wd-update-sweep").toFile();
    try {
      File oldApk = new File(dir, "waifudeck-4.apk");
      File currentApk = new File(dir, "waifudeck-1002000.apk");
      File newerApk = new File(dir, "waifudeck-1002001.apk");
      File partFile = new File(dir, "waifudeck-1002001.apk.part");
      File unknownFile = new File(dir, "stray.tmp");
      for (File f : Arrays.asList(oldApk, currentApk, newerApk, partFile, unknownFile)) {
        try (FileOutputStream out = new FileOutputStream(f)) {
          out.write("apk".getBytes(StandardCharsets.UTF_8));
        }
      }

      int deleted = AppUpdateHelper.sweepDirectory(dir, 1002000);
      assertEquals(4, deleted);
      assertFalse(oldApk.exists());
      assertFalse(currentApk.exists());
      assertFalse(partFile.exists());
      assertFalse(unknownFile.exists());
      assertTrue(newerApk.exists());
    } finally {
      File[] remaining = dir.listFiles();
      if (remaining != null) {
        for (File f : remaining) f.delete();
      }
      dir.delete();
    }
  }

  @Test
  public void verifyApkFileBytesAndArchiveAcceptsExactMatchAndDeletesOnMismatch() throws Exception {
    File dir = Files.createTempDirectory("wd-update-verify").toFile();
    try {
      byte[] payload = "synthetic-apk-payload-for-n11".getBytes(StandardCharsets.UTF_8);
      String expectedSha = sha256Hex(payload);

      File validFile = new File(dir, "waifudeck-1002001.apk");
      try (FileOutputStream out = new FileOutputStream(validFile)) {
        out.write(payload);
      }

      AppUpdateHelper.VerificationResult ok = AppUpdateHelper.verifyFileAndArchive(
          dir,
          validFile,
          1002001,
          payload.length,
          expectedSha,
          "app.waifudeck.mobile",
          new AppUpdateHelper.ArchiveInspector() {
            @Override
            public AppUpdateHelper.ArchiveMetadata inspect(File apkFile) {
              return new AppUpdateHelper.ArchiveMetadata("app.waifudeck.mobile", 1002001);
            }
          });
      assertTrue(ok.isValid());
      assertNull(ok.getReason());
      assertTrue(validFile.exists());

      // Size mismatch deletes file
      File badSizeFile = new File(dir, "bad-size.apk");
      try (FileOutputStream out = new FileOutputStream(badSizeFile)) {
        out.write(payload);
      }
      AppUpdateHelper.VerificationResult sizeFail = AppUpdateHelper.verifyFileAndArchive(
          dir,
          badSizeFile,
          1002001,
          payload.length + 1,
          expectedSha,
          "app.waifudeck.mobile",
          f -> new AppUpdateHelper.ArchiveMetadata("app.waifudeck.mobile", 1002001));
      assertFalse(sizeFail.isValid());
      assertEquals("size_mismatch", sizeFail.getReason());
      assertFalse(badSizeFile.exists());

      // SHA-256 mismatch deletes file
      File badShaFile = new File(dir, "bad-sha.apk");
      try (FileOutputStream out = new FileOutputStream(badShaFile)) {
        out.write(payload);
      }
      AppUpdateHelper.VerificationResult shaFail = AppUpdateHelper.verifyFileAndArchive(
          dir,
          badShaFile,
          1002001,
          payload.length,
          "0".repeat(64),
          "app.waifudeck.mobile",
          f -> new AppUpdateHelper.ArchiveMetadata("app.waifudeck.mobile", 1002001));
      assertFalse(shaFail.isValid());
      assertEquals("sha256_mismatch", shaFail.getReason());
      assertFalse(badShaFile.exists());

      // Package name mismatch deletes file
      File badPkgFile = new File(dir, "bad-pkg.apk");
      try (FileOutputStream out = new FileOutputStream(badPkgFile)) {
        out.write(payload);
      }
      AppUpdateHelper.VerificationResult pkgFail = AppUpdateHelper.verifyFileAndArchive(
          dir,
          badPkgFile,
          1002001,
          payload.length,
          expectedSha,
          "app.waifudeck.mobile",
          f -> new AppUpdateHelper.ArchiveMetadata("com.other.app", 1002001));
      assertFalse(pkgFail.isValid());
      assertEquals("package_mismatch", pkgFail.getReason());
      assertFalse(badPkgFile.exists());

      // Version code mismatch deletes file
      File badVerFile = new File(dir, "bad-ver.apk");
      try (FileOutputStream out = new FileOutputStream(badVerFile)) {
        out.write(payload);
      }
      AppUpdateHelper.VerificationResult verFail = AppUpdateHelper.verifyFileAndArchive(
          dir,
          badVerFile,
          1002001,
          payload.length,
          expectedSha,
          "app.waifudeck.mobile",
          f -> new AppUpdateHelper.ArchiveMetadata("app.waifudeck.mobile", 1002000));
      assertFalse(verFail.isValid());
      assertEquals("version_mismatch", verFail.getReason());
      assertFalse(badVerFile.exists());
    } finally {
      File[] remaining = dir.listFiles();
      if (remaining != null) {
        for (File f : remaining) f.delete();
      }
      dir.delete();
    }
  }
}
