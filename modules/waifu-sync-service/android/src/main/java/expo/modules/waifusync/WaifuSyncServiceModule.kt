package expo.modules.waifusync

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.io.IOException
import java.nio.charset.StandardCharsets
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody

/**
 * K6-3 / K6-1g. Two responsibilities, both about an upload surviving the
 * moment the user puts the phone down.
 *
 * 1. `start`/`update`/`stop` run a `dataSync` foreground service so Android
 *    stops freezing this process while uploads are in flight. See
 *    [SyncForegroundService] for the measurement that forced it.
 *
 * 2. `uploadFile` is a PUT that streams a file from disk with byte progress.
 *    It exists because `expo-file-system`'s upload task builds its own OkHttp
 *    client via `OkHttpClientProvider.createClientBuilder()` and hardcodes 60 s
 *    connect/read/write timeouts (K7 finding #36, controller-verified). That
 *    bypasses the K6-1d client factory — IPv4-first DNS and a 10-connection,
 *    10-minute pool — and cuts off a slow-but-live upload at 60 s. Here the
 *    client comes from `OkHttpClientProvider.createClient()`, which *is* the
 *    factory-built one, and no timeout is set at all: React Native's builder
 *    defaults to none, and the JS transport already owns stall detection, which
 *    is the only side that knows what "no bytes moved" means for this request.
 *
 * 3. K6-4c: `downloadRanges` fetches one image as several parallel HTTP `Range`
 *    requests. The booru file host serves ~150 KB/s per stream (measured on the
 *    owner's network, 2026-09-14) and advertises `accept-ranges: bytes`, so a
 *    4.25 MB wallpaper costs 29 s on one stream and 9.5 s on four. See
 *    [RangeDownload] for how the windows land in one file.
 */
class WaifuSyncServiceModule : Module() {

  private val calls = ConcurrentHashMap<String, Call>()
  private val backupCopyExecutor = Executors.newSingleThreadExecutor()
  private val fileTaskExecutor = Executors.newFixedThreadPool(4)
  private val taskRegistry = ConcurrentHashMap<String, FileTask>()
  private val imeHeightObserver = ImeHeightObserver { heightDp, visible ->
    sendEvent(
      "onImeHeightChange",
      mapOf("height" to heightDp, "visible" to visible),
    )
  }

  private sealed class FileTask {
    class Range : FileTask() {
      @Volatile
      var download: RangeDownload? = null
    }

    class Stream : FileTask() {
      val cancelled = AtomicBoolean(false)

      @Volatile
      var call: Call? = null
    }

    class Crypto : FileTask() {
      val cancelled = AtomicBoolean(false)
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("WaifuSyncService")

    Events("onUploadProgress", "onDownloadProgress", "onImeHeightChange")

    OnStartObserving("onImeHeightChange") {
      val activity = appContext.currentActivity ?: return@OnStartObserving
      imeHeightObserver.attach(activity)
    }

    OnStopObserving("onImeHeightChange") {
      imeHeightObserver.detach()
    }

    // Module destruction clears JS listeners without stopObserving, which would
    // leave the decor view holding this observer and the module.
    OnDestroy {
      imeHeightObserver.detach()
    }

    AsyncFunction("start") { title: String, text: String ->
      ContextCompat.startForegroundService(
        context,
        serviceIntent(SyncForegroundService.ACTION_START, title, text),
      )
    }

    AsyncFunction("update") { title: String, text: String ->
      ContextCompat.startForegroundService(
        context,
        serviceIntent(SyncForegroundService.ACTION_UPDATE, title, text),
      )
    }

    AsyncFunction("stop") {
      ContextCompat.startForegroundService(
        context,
        serviceIntent(SyncForegroundService.ACTION_STOP, "", ""),
      )
    }

    Function("isBatteryOptimizationIgnored") {
      val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      power.isIgnoringBatteryOptimizations(context.packageName)
    }

    Function("setModalStatusBarStyle") { lightIcons: Boolean ->
      val reactContext = appContext.reactContext as? com.facebook.react.bridge.ReactContext ?: return@Function
      DialogStatusBarAppearance.apply(reactContext, lightIcons)
    }

    Function("getInstalledAppVersion") {
      AppUpdateInstaller.getInstalledAppVersion(context)
    }

    Function("canRequestPackageInstalls") {
      AppUpdateInstaller.canRequestPackageInstalls(context)
    }

    AsyncFunction("openUnknownAppSourcesSettings") {
      AppUpdateInstaller.openUnknownAppSourcesSettings(
        context,
        appContext.activityProvider?.currentActivity,
      )
    }

    AsyncFunction("installUpdateApk") { apkPath: String ->
      AppUpdateInstaller.installUpdateApk(
        context,
        appContext.activityProvider?.currentActivity,
        apkPath,
      )
    }

    AsyncFunction("sweepUpdateApks") { installedVersionCode: Int, promise: Promise ->
      fileTaskExecutor.execute {
        try {
          promise.resolve(AppUpdateInstaller.sweepUpdateApks(context, installedVersionCode))
        } catch (error: Throwable) {
          promise.reject(ERR_LIBRARY_IO, error.message ?: "failed to sweep update APKs", error)
        }
      }
    }

    AsyncFunction("verifyDownloadedApk") {
      apkPath: String,
      expectedVersionCode: Int,
      expectedSizeBytes: Long,
      expectedSha256: String,
      promise: Promise,
      ->
      fileTaskExecutor.execute {
        try {
          promise.resolve(
            AppUpdateInstaller.verifyDownloadedApk(
              context,
              apkPath,
              expectedVersionCode,
              expectedSizeBytes,
              expectedSha256,
            ),
          )
        } catch (error: Throwable) {
          promise.reject(ERR_LIBRARY_IO, error.message ?: "failed to verify update APK", error)
        }
      }
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      fun intentFor(action: String): Intent = Intent(action).apply {
        if (BatterySettingsOrder.needsPackageUri(action)) {
          data = Uri.parse("package:${context.packageName}")
        }
      }
      val pm = context.packageManager
      val action = BatterySettingsOrder.firstResolvable {
        intentFor(it).resolveActivity(pm) != null
      }
      if (action != null) startSettingsActivity(intentFor(action))
    }

    // NON-blocking on purpose. An `AsyncFunction` body runs on the module's
    // single worker queue; a blocking `execute()` there serialises every
    // concurrent `putBlob` (measured on device: three parallel blob PUTs became
    // three sequential ones, 3.6 s -> 9.5 s per image). `enqueue` hands the
    // socket to OkHttp's own dispatcher (64 parallel calls by default) and
    // returns the queue immediately; the Promise settles from the callback.
    AsyncFunction("uploadFile") {
      taskId: String,
      url: String,
      filePath: String,
      headers: Map<String, String>,
      promise: Promise,
      ->
      val file = File(Uri.parse(filePath).path ?: filePath)
      val contentType = headers.entries
        .firstOrNull { it.key.equals("content-type", ignoreCase = true) }
        ?.value
        ?.toMediaTypeOrNull()
      val body = ProgressRequestBody(file, contentType) { sent, total ->
        sendEvent(
          "onUploadProgress",
          bundleOf("taskId" to taskId, "bytesSent" to sent, "totalBytes" to total),
        )
      }
      val builder = Request.Builder().url(url).put(body)
      for ((name, value) in headers) builder.header(name, value)
      val call = OkHttpClientProvider.createClient().newCall(builder.build())
      calls[taskId] = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          calls.remove(taskId)
          promise.reject("ERR_UPLOAD_NETWORK", e.message ?: "upload failed", e)
        }

        override fun onResponse(call: Call, response: Response) {
          calls.remove(taskId)
          try {
            response.use {
              val responseHeaders = mutableMapOf<String, String>()
              for (name in it.headers.names()) {
                responseHeaders[name.lowercase()] = it.headers[name].orEmpty()
              }
              promise.resolve(
                mapOf(
                  "status" to it.code,
                  "headers" to responseHeaders,
                  // Read inside `use`: S3 error bodies are small XML documents the
                  // transport wants for its failure message; the stream dies with
                  // the response.
                  "body" to (it.body?.string() ?: ""),
                ),
              )
            }
          } catch (e: IOException) {
            promise.reject("ERR_UPLOAD_READ", e.message ?: "response read failed", e)
          }
        }
      })
    }

    AsyncFunction("cancelUpload") { taskId: String ->
      // The JS transport aborts on stall (K5). Without this the socket would
      // keep streaming bytes nobody is waiting for while the retry opens a
      // second one.
      calls.remove(taskId)?.cancel()
    }

    AsyncFunction("downloadToFile") {
      taskId: String,
      url: String,
      destPath: String,
      headers: Map<String, String>,
      maxBytes: Long,
      promise: Promise,
      ->
      val streamTask = FileTask.Stream()
      if (taskRegistry.putIfAbsent(taskId, streamTask) != null) {
        promise.reject(ERR_TASK_DUPLICATE, "task id is already registered", null)
        return@AsyncFunction
      }

      val destination = File(Uri.parse(destPath).path ?: destPath)
      try {
        destination.parentFile?.mkdirs()
        if (!destination.createNewFile()) {
          throw IOException("library download destination already exists")
        }
      } catch (error: Throwable) {
        taskRegistry.remove(taskId, streamTask)
        promise.reject(ERR_LIBRARY_IO, "could not create the library download file", error)
        return@AsyncFunction
      }

      val call = try {
        val builder = Request.Builder().url(url).get()
        for ((name, value) in headers) builder.header(name, value)
        OkHttpClientProvider.createClient().newCall(builder.build())
      } catch (error: Throwable) {
        deleteDownloadFile(destination)
        taskRegistry.remove(taskId, streamTask)
        promise.reject(ERR_DOWNLOAD_NETWORK, "could not start the library download", error)
        return@AsyncFunction
      }
      streamTask.call = call
      if (streamTask.cancelled.get()) call.cancel()
      try {
        call.enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) {
          deleteDownloadFile(destination)
          taskRegistry.remove(taskId, streamTask)
          promise.reject(
            if (streamTask.cancelled.get()) ERR_DOWNLOAD_CANCELLED else ERR_DOWNLOAD_NETWORK,
            error.message ?: "library download failed",
            error,
          )
        }

        override fun onResponse(call: Call, response: Response) {
          try {
            response.use {
              val responseHeaders = mutableMapOf<String, String>()
              for (name in it.headers.names()) {
                responseHeaders[name.lowercase()] = it.headers[name].orEmpty()
              }
              val redirected = it.priorResponse != null
              if (it.code !in 200..299) {
                deleteDownloadFile(destination)
                promise.resolve(
                  mapOf(
                    "status" to it.code,
                    "headers" to responseHeaders,
                    "redirected" to redirected,
                    "errorBody" to readErrorBody(it.body),
                    "bytesWritten" to 0L,
                  ),
                )
                return
              }

              val body = it.body ?: throw IOException("library download response had no body")
              val bytesWritten = LibraryStreamCopy.copyToFile(
                body.byteStream(),
                destination,
                maxBytes,
                { bytesReceived ->
                  sendEvent(
                    "onDownloadProgress",
                    bundleOf(
                      "taskId" to taskId,
                      "bytesReceived" to bytesReceived,
                      "totalBytes" to body.contentLength(),
                    ),
                  )
                },
                { streamTask.cancelled.get() },
              )
              promise.resolve(
                mapOf(
                  "status" to it.code,
                  "headers" to responseHeaders,
                  "redirected" to redirected,
                  "errorBody" to "",
                  "bytesWritten" to bytesWritten,
                ),
              )
            }
          } catch (error: LibraryStreamCopy.StreamCopyException) {
            deleteDownloadFile(destination)
            val code = if (streamTask.cancelled.get()) {
              ERR_DOWNLOAD_CANCELLED
            } else {
              downloadErrorCode(error)
            }
            promise.reject(code, error.message ?: "library download failed", error)
          } catch (error: Throwable) {
            deleteDownloadFile(destination)
            promise.reject(ERR_DOWNLOAD_NETWORK, error.message ?: "library download failed", error)
          } finally {
            taskRegistry.remove(taskId, streamTask)
          }
        }
        })
      } catch (error: Throwable) {
        deleteDownloadFile(destination)
        taskRegistry.remove(taskId, streamTask)
        promise.reject(ERR_DOWNLOAD_NETWORK, "could not enqueue the library download", error)
      }
    }

    // Board row 29: keep large copies off this single module queue; native file-to-file
    // bytes avoid JS heap pinning while Hermes waits to collect the BLOB.
    AsyncFunction("copyBackupFile") {
      archiveUri: String,
      imageId: Long,
      destinationUri: String,
      promise: Promise,
      ->
      try {
        backupCopyExecutor.execute {
          try {
            promise.resolve(BackupFileCopy.copy(archiveUri, imageId, destinationUri))
          } catch (e: Throwable) {
            promise.reject(
              "ERR_BACKUP_FILE_COPY",
              e.message ?: "backup file copy failed",
              e,
            )
          }
        }
      } catch (e: Throwable) {
        promise.reject(
          "ERR_BACKUP_FILE_COPY",
          e.message ?: "backup file copy failed",
          e,
        )
      }
    }

    AsyncFunction("copyBackupImportFile") {
      archiveUri: String,
      plaintextSha256: String,
      destinationUri: String,
      promise: Promise,
      ->
      try {
        backupCopyExecutor.execute {
          try {
            val result = BackupFileCopy.copyImport(archiveUri, plaintextSha256, destinationUri)
            promise.resolve(
              mapOf(
                "bytesWritten" to result.bytesWritten,
                "plaintextSha256" to result.plaintextSha256,
              ),
            )
          } catch (e: Throwable) {
            promise.reject(
              "ERR_BACKUP_FILE_COPY",
              e.message ?: "backup import file copy failed",
              e,
            )
          }
        }
      } catch (e: Throwable) {
        promise.reject(
          "ERR_BACKUP_FILE_COPY",
          e.message ?: "backup import file copy failed",
          e,
        )
      }
    }

    AsyncFunction("decryptLibraryObjectToFile") {
      taskId: String,
      sourcePath: String,
      destPath: String,
      masterKey: ByteArray,
      assetId: String,
      scope: String,
      promise: Promise,
      ->
      submitFileTask(taskId, masterKey, promise) { task ->
        val result = LibraryObjectStreamCrypto.decryptToFile(
          File(Uri.parse(sourcePath).path ?: sourcePath),
          File(Uri.parse(destPath).path ?: destPath),
          masterKey,
          assetId,
          scope,
        ) { task.cancelled.get() }
        promise.resolve(
          mapOf(
            "plaintextBytes" to result.plaintextBytes,
            "plaintextSha256" to result.plaintextSha256,
          ),
        )
      }
    }

    AsyncFunction("copyFileToFileWithSha256") {
      taskId: String,
      sourcePath: String,
      destPath: String,
      promise: Promise,
      ->
      submitFileTask(taskId, null, promise) { task ->
        val result = LibraryObjectStreamCrypto.copyWithSha256(
          File(Uri.parse(sourcePath).path ?: sourcePath),
          File(Uri.parse(destPath).path ?: destPath),
        ) { task.cancelled.get() }
        promise.resolve(
          mapOf(
            "plaintextBytes" to result.plaintextBytes,
            "plaintextSha256" to result.plaintextSha256,
          ),
        )
      }
    }

    AsyncFunction("cancelDecrypt") { taskId: String ->
      val task = taskRegistry[taskId]
      if (task is FileTask.Crypto) task.cancelled.set(true)
    }

    AsyncFunction("encryptLibraryObjectToFile") {
      taskId: String,
      sourcePath: String,
      destPath: String,
      masterKey: ByteArray,
      assetId: String,
      scope: String,
      promise: Promise,
      ->
      submitFileTask(taskId, masterKey, promise) { task ->
        val result = LibraryObjectStreamCrypto.encryptToFile(
          File(Uri.parse(sourcePath).path ?: sourcePath),
          File(Uri.parse(destPath).path ?: destPath),
          masterKey,
          assetId,
          scope,
        ) { task.cancelled.get() }
        promise.resolve(
          mapOf(
            "plaintextBytes" to result.plaintextBytes,
            "envelopeBytes" to result.envelopeBytes,
            "plaintextSha256" to result.plaintextSha256,
            "envelopeSha256" to result.envelopeSha256,
          ),
        )
      }
    }

    // K6-4c. One image, `parts` simultaneous `Range` GETs, one pre-sized file.
    // `enqueue` for the same reason `uploadFile` uses it: the module's worker
    // queue is single-threaded, so blocking here would turn the parallel
    // segments this function exists to create back into a sequence.
    AsyncFunction("downloadRanges") {
      taskId: String,
      url: String,
      destPath: String,
      headers: Map<String, String>,
      totalBytes: Int,
      parts: Int,
      promise: Promise,
      ->
      val rangeTask = FileTask.Range()
      if (taskRegistry.putIfAbsent(taskId, rangeTask) != null) {
        promise.reject(ERR_TASK_DUPLICATE, "task id is already registered", null)
        return@AsyncFunction
      }
      val setup = try {
        val destination = File(Uri.parse(destPath).path ?: destPath)
        destination.parentFile?.mkdirs()
        val total = totalBytes.toLong()
        val windows = RangeDownload.windows(total, parts)
        Triple(destination, total, windows)
      } catch (e: Throwable) {
        taskRegistry.remove(taskId, rangeTask)
        promise.reject(ERR_DOWNLOAD_RANGE, e.message ?: "could not open the download file", e)
        return@AsyncFunction
      }
      val destination = setup.first
      val total = setup.second
      val windows = setup.third
      val download = try {
        RangeDownload(
          destination = destination,
          total = total,
          segments = windows.size,
          promise = promise,
          onSettled = { taskRegistry.remove(taskId, rangeTask) },
          onProgress = { received, size ->
            sendEvent(
              "onDownloadProgress",
              bundleOf("taskId" to taskId, "bytesReceived" to received, "totalBytes" to size),
            )
          },
        )
      } catch (e: Throwable) {
        taskRegistry.remove(taskId, rangeTask)
        promise.reject(ERR_DOWNLOAD_RANGE, e.message ?: "could not open the download file", e)
        return@AsyncFunction
      }
      rangeTask.download = download
      val client = OkHttpClientProvider.createClient()
      for (window in windows) {
        val start = window.first
        val builder = Request.Builder().url(url).get()
        for ((name, value) in headers) builder.header(name, value)
        builder.header("Range", "bytes=$start-${window.last}")
        val call = client.newCall(builder.build())
        download.track(call)
        call.enqueue(object : Callback {
          override fun onFailure(call: Call, e: IOException) {
            download.fail(ERR_DOWNLOAD_RANGE, e.message ?: "range request failed", e)
          }

          override fun onResponse(call: Call, response: Response) {
            try {
              response.use {
                // A 200 means the host ignored the window and is streaming the
                // whole body into this segment's offset — the other segments
                // would then be overwritten by it.
                if (it.code != RangeDownload.PARTIAL_CONTENT) {
                  download.fail(ERR_DOWNLOAD_RANGE, "range request returned ${it.code}", null)
                  return
                }
                val body = it.body
                if (body == null) {
                  download.fail(ERR_DOWNLOAD_RANGE, "range response had no body", null)
                  return
                }
                var offset = start
                val buffer = ByteArray(RangeDownload.PROGRESS_INTERVAL_BYTES.toInt())
                body.byteStream().use { stream ->
                  while (true) {
                    val read = stream.read(buffer)
                    if (read <= 0) break
                    download.write(offset, buffer, read)
                    offset += read
                  }
                }
                download.finishSegment()
              }
            } catch (e: IOException) {
              download.fail(ERR_DOWNLOAD_RANGE, e.message ?: "range read failed", e)
            }
          }
        })
      }
    }

    AsyncFunction("cancelDownload") { taskId: String ->
      val task = taskRegistry[taskId]
      if (task is FileTask.Stream && taskRegistry.remove(taskId, task)) {
        task.cancelled.set(true)
        task.call?.cancel()
      } else if (task is FileTask.Range && taskRegistry.remove(taskId, task)) {
        task.download?.fail(ERR_DOWNLOAD_CANCELLED, "download cancelled", null)
      }
    }
  }

  private fun serviceIntent(action: String, title: String, text: String): Intent =
    Intent(context, SyncForegroundService::class.java).apply {
      this.action = action
      putExtra(SyncForegroundService.EXTRA_TITLE, title)
      putExtra(SyncForegroundService.EXTRA_TEXT, text)
    }

  private fun startSettingsActivity(intent: Intent) {
    val activity: Activity? = appContext.activityProvider?.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
      return
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  private fun submitFileTask(
    taskId: String,
    masterKey: ByteArray?,
    promise: Promise,
    work: (FileTask.Crypto) -> Unit,
  ) {
    val task = FileTask.Crypto()
    var submitted = false
    try {
      if (taskRegistry.putIfAbsent(taskId, task) != null) {
        promise.reject(ERR_TASK_DUPLICATE, "task id is already registered", null)
        return
      }
      try {
        fileTaskExecutor.execute {
          try {
            work(task)
          } catch (error: LibraryObjectStreamCrypto.StreamCryptoException) {
            rejectLibraryError(promise, error)
          } catch (error: Throwable) {
            rejectLibraryError(promise, error)
          } finally {
            taskRegistry.remove(taskId, task)
            if (masterKey != null) masterKey.fill(0)
          }
        }
        submitted = true
      } catch (error: Throwable) {
        try {
          promise.reject(ERR_LIBRARY_IO, "library file task could not start", error)
        } finally {
          taskRegistry.remove(taskId, task)
        }
      }
    } finally {
      if (!submitted && masterKey != null) {
        masterKey.fill(0)
      }
    }
  }

  private fun rejectLibraryError(promise: Promise, error: Throwable) {
    val code = libraryErrorCode(error)
    promise.reject(code, libraryErrorMessage(error), error)
  }

  private fun libraryErrorCode(error: Throwable): String {
    if (error is LibraryObjectStreamCrypto.StreamCryptoException) {
      return when (error.code) {
        LibraryObjectStreamCrypto.Code.FORMAT -> ERR_LIBRARY_FORMAT
        LibraryObjectStreamCrypto.Code.INTEGRITY -> ERR_LIBRARY_INTEGRITY
        LibraryObjectStreamCrypto.Code.IO -> ERR_LIBRARY_IO
        LibraryObjectStreamCrypto.Code.CANCELLED -> ERR_LIBRARY_CANCELLED
      }
    }
    return ERR_LIBRARY_IO
  }

  private fun libraryErrorMessage(error: Throwable): String {
    if (error is LibraryObjectStreamCrypto.StreamCryptoException) {
      return when (error.code) {
        LibraryObjectStreamCrypto.Code.FORMAT -> "library object format is invalid"
        LibraryObjectStreamCrypto.Code.INTEGRITY -> "library object integrity check failed"
        LibraryObjectStreamCrypto.Code.IO -> "library object I/O failed"
        LibraryObjectStreamCrypto.Code.CANCELLED -> "library object operation cancelled"
      }
    }
    return "library file operation failed"
  }

  private fun downloadErrorCode(error: LibraryStreamCopy.StreamCopyException): String {
    return when (error.code) {
      LibraryStreamCopy.Code.NETWORK -> ERR_DOWNLOAD_NETWORK
      LibraryStreamCopy.Code.IO -> ERR_LIBRARY_IO
      LibraryStreamCopy.Code.FORMAT -> ERR_LIBRARY_FORMAT
      LibraryStreamCopy.Code.CANCELLED -> ERR_DOWNLOAD_CANCELLED
    }
  }

  private fun deleteDownloadFile(destination: File) {
    try {
      destination.delete()
    } catch (_: Throwable) {
      // The original download error remains the Promise outcome.
    }
  }

  private fun readErrorBody(body: ResponseBody?): String {
    if (body == null) return ""
    val maxBytes = 64 * 1024
    val buffer = ByteArray(8 * 1024)
    val output = ByteArrayOutputStream(maxBytes)
    body.byteStream().use { input ->
      var remaining = maxBytes
      while (remaining > 0) {
        val read = input.read(buffer, 0, minOf(buffer.size, remaining))
        if (read <= 0) break
        output.write(buffer, 0, read)
        remaining -= read
      }
    }
    return output.toString(StandardCharsets.UTF_8.name())
  }

  private companion object {
    const val ERR_DOWNLOAD_NETWORK = "ERR_DOWNLOAD_NETWORK"
    const val ERR_DOWNLOAD_RANGE = "ERR_DOWNLOAD_RANGE"
    const val ERR_DOWNLOAD_CANCELLED = "ERR_DOWNLOAD_CANCELLED"
    const val ERR_LIBRARY_FORMAT = "ERR_LIBRARY_FORMAT"
    const val ERR_LIBRARY_INTEGRITY = "ERR_LIBRARY_INTEGRITY"
    const val ERR_LIBRARY_CANCELLED = "ERR_LIBRARY_CANCELLED"
    const val ERR_LIBRARY_IO = "ERR_LIBRARY_IO"
    const val ERR_TASK_DUPLICATE = "ERR_TASK_DUPLICATE"
  }
}
