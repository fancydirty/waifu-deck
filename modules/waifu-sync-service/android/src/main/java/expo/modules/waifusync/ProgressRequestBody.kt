package expo.modules.waifusync

import java.io.File
import okhttp3.MediaType
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source

/**
 * A streaming `RequestBody` over a file on disk that reports how many bytes it
 * has actually handed to the socket.
 *
 * The bytes are read in 64 KiB slices and flushed after each one, so `onWrite`
 * fires while the upload is in flight rather than once at the end. The counter
 * is the only honest source for the owner's percentage ring (「不是假百分比」):
 * it counts what was written to the connection, not what was queued.
 *
 * The file is never loaded into memory — a multi-megabyte original has to
 * stream, and `contentLength` is declared up front so OkHttp sends a real
 * `Content-Length` instead of chunked encoding, which S3 will not accept for a
 * SigV4-signed PUT.
 */
class ProgressRequestBody(
  private val file: File,
  private val contentType: MediaType?,
  private val onProgress: (bytesSent: Long, totalBytes: Long) -> Unit,
) : RequestBody() {

  override fun contentType(): MediaType? = contentType

  override fun contentLength(): Long = file.length()

  override fun writeTo(sink: BufferedSink) {
    val total = contentLength()
    var sent = 0L
    file.inputStream().source().use { source ->
      while (true) {
        val read = source.read(sink.buffer, SEGMENT_BYTES)
        if (read == -1L) break
        sent += read
        sink.flush()
        onProgress(sent, total)
      }
    }
  }

  private companion object {
    const val SEGMENT_BYTES = 64L * 1024L
  }
}
