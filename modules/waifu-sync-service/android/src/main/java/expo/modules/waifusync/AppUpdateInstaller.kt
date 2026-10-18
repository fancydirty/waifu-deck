package expo.modules.waifusync

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import java.io.File

/**
 * Ledger N11: Android package metadata lookup, APK archive verification,
 * unknown-sources permission check, FileProvider installer handoff, and
 * cold-start APK cache cleanup.
 */
internal object AppUpdateInstaller {
  private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
  private const val UPDATE_CACHE_DIR = "app-updates"

  private fun updateDir(context: Context): File = File(context.cacheDir, UPDATE_CACHE_DIR)

  fun getInstalledAppVersion(context: Context): Map<String, Any> {
    val pm = context.packageManager
    val pkgInfo = pm.getPackageInfo(context.packageName, 0)
    val versionCode = PackageInfoCompat.getLongVersionCode(pkgInfo).toInt()
    val versionName = pkgInfo.versionName ?: "1.0.0"
    val isDebuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    return mapOf(
      "versionCode" to versionCode,
      "versionName" to versionName,
      "isDebuggable" to isDebuggable,
    )
  }

  fun verifyDownloadedApk(
    context: Context,
    apkPath: String,
    expectedVersionCode: Int,
    expectedSizeBytes: Long,
    expectedSha256: String,
  ): Map<String, Any?> {
    val file = File(Uri.parse(apkPath).path ?: apkPath)
    val pm = context.packageManager
    val result = AppUpdateHelper.verifyFileAndArchive(
      updateDir(context),
      file,
      expectedVersionCode,
      expectedSizeBytes,
      expectedSha256,
      context.packageName,
    ) { target ->
      val archiveInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageArchiveInfo(target.absolutePath, PackageManager.PackageInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageArchiveInfo(target.absolutePath, 0)
      } ?: return@verifyFileAndArchive null
      AppUpdateHelper.ArchiveMetadata(
        archiveInfo.packageName,
        PackageInfoCompat.getLongVersionCode(archiveInfo).toInt(),
      )
    }
    return mapOf(
      "valid" to result.isValid,
      "reason" to result.reason,
    )
  }

  fun canRequestPackageInstalls(context: Context): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.packageManager.canRequestPackageInstalls()
    } else {
      true
    }
  }

  fun openUnknownAppSourcesSettings(context: Context, currentActivity: Activity?) {
    fun intentFor(action: String): Intent = Intent(action).apply {
      if (AppUpdateHelper.unknownSourcesActionNeedsPackageUri(action)) {
        data = Uri.parse("package:${context.packageName}")
      }
    }
    val pm = context.packageManager
    val action = AppUpdateHelper.firstResolvableUnknownSourcesAction {
      intentFor(it).resolveActivity(pm) != null
    } ?: return
    val targetIntent = intentFor(action)
    if (currentActivity != null) {
      currentActivity.startActivity(targetIntent)
    } else {
      targetIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(targetIntent)
    }
  }

  fun installUpdateApk(context: Context, currentActivity: Activity?, apkPath: String) {
    val dir = updateDir(context)
    val rawFile = File(Uri.parse(apkPath).path ?: apkPath)
    if (!AppUpdateHelper.isContainedInUpdateDir(dir, rawFile)) {
      throw IllegalArgumentException("Update APK must reside inside ${dir.absolutePath}")
    }
    val file = rawFile.canonicalFile
    if (AppUpdateHelper.parseApkVersionCode(file.name) <= 0) {
      throw IllegalArgumentException("Update APK has non-canonical filename: ${file.name}")
    }
    if (!file.exists() || !file.isFile) {
      throw IllegalArgumentException("Update APK file does not exist: ${file.absolutePath}")
    }
    val authority = "${context.packageName}.FileSystemFileProvider"
    val contentUri = FileProvider.getUriForFile(context, authority, file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(contentUri, APK_MIME_TYPE)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    if (currentActivity != null) {
      currentActivity.startActivity(intent)
    } else {
      context.startActivity(intent)
    }
  }

  fun sweepUpdateApks(context: Context, installedVersionCode: Int): Int {
    return AppUpdateHelper.sweepDirectory(updateDir(context), installedVersionCode)
  }
}
