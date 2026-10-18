package expo.modules.waifusync

import expo.modules.kotlin.Promise
import java.io.File
import java.io.RandomAccessFile
import okhttp3.Call

/**
 * K6-4c. The shared state of one image downloaded as several parallel HTTP
 * `Range` requests.
 *
 * Measured on the owner's network (2026-09-14): the booru file host serves
 * ~150 KB/s *per stream* and advertises `accept-ranges: bytes`, so a 4.25 MB
 * wallpaper takes 29 s on one stream and 9.5 s split across four. Splitting is
 * the only app-side move that lowers the latency of a single large save; the
 * per-stream cap is not an IP cap, and Cloudflare serves each window from the
 * same cache HIT.
 *
 * The segments write into one file that is pre-sized with [RandomAccessFile.setLength]
 * and seek to their own offset, so there is nothing to concatenate afterwards
 * and a completed download is already the finished file. Writes are serialised
 * on [lock] because `seek` + `write` is two calls on shared state that several
 * OkHttp threads reach at once.
 *
 * The whole download settles exactly once: the first failure cancels its
 * siblings, closes and deletes the half-written file, and rejects, so the JS
 * caller can fall back to the single-stream path from a clean slate rather than
 * committing a corrupt image to the collection.
 */
class RangeDownload(
  private val destination: File,
  private val total: Long,
  segments: Int,
  private val promise: Promise,
  private val onSettled: () -> Unit,
  private val onProgress: (bytesReceived: Long, totalBytes: Long) -> Unit,
) {

  private val lock = Any()
  private val file = RandomAccessFile(destination, "rw")
  private val calls = mutableListOf<Call>()
  private var remaining = segments
  private var settled = false
  private var received = 0L
  private var reported = 0L

  init {
    // Pre-sizing is what makes an offset write legal before the earlier
    // segments have arrived; without it the last segment's seek would extend a
    // sparse file whose gaps are never filled if a sibling fails silently.
    file.setLength(total)
  }

  /** Registers a segment's call so a failure elsewhere can cancel it. */
  fun track(call: Call) {
    val cancelImmediately = synchronized(lock) {
      if (!settled) calls.add(call)
      settled
    }
    if (cancelImmediately) call.cancel()
  }

  /**
   * Writes one buffer at its absolute offset. Progress is emitted at most once
   * per [PROGRESS_INTERVAL_BYTES] and outside the lock, so the event never
   * stalls another segment's write.
   */
  fun write(offset: Long, buffer: ByteArray, length: Int) {
    var progress = -1L
    synchronized(lock) {
      if (settled) return
      file.seek(offset)
      file.write(buffer, 0, length)
      received += length
      if (received - reported >= PROGRESS_INTERVAL_BYTES || received >= total) {
        reported = received
        progress = received
      }
    }
    if (progress >= 0L) onProgress(progress, total)
  }

  /** Marks one segment finished; the last one resolves the download. */
  fun finishSegment() {
    synchronized(lock) {
      if (settled) return
      remaining -= 1
      if (remaining > 0) return
      settled = true
    }
    closeQuietly()
    onSettled()
    promise.resolve(mapOf("status" to PARTIAL_CONTENT))
  }

  /**
   * Settles the download as failed: cancel the siblings, drop the partial file,
   * reject once. Called for a transport error, a non-206 status (the host
   * ignored the window and is about to overwrite someone else's bytes), and for
   * an explicit cancel from JS.
   */
  fun fail(code: String, message: String, cause: Throwable?) {
    val pending: List<Call>
    synchronized(lock) {
      if (settled) return
      settled = true
      pending = calls.toList()
    }
    for (call in pending) call.cancel()
    closeQuietly()
    destination.delete()
    onSettled()
    promise.reject(code, message, cause)
  }

  private fun closeQuietly() {
    try {
      file.close()
    } catch (_: Throwable) {
      // The transfer's outcome is already decided; a failed close only affects
      // this file handle.
    }
  }

  companion object {
    const val PARTIAL_CONTENT = 206
    const val PROGRESS_INTERVAL_BYTES = 64 * 1024L

    /**
     * Splits `[0, total - 1]` into `segments` contiguous windows, the last one
     * carrying the remainder. Mirrors `planRanges` in
     * `src/features/collection/range-download.ts`, which decides how many.
     */
    fun windows(total: Long, segments: Int): List<LongRange> {
      val count = segments.coerceAtLeast(1)
      val size = total / count
      return (0 until count).map { index ->
        val start = index * size
        val end = if (index == count - 1) total - 1 else start + size - 1
        start..end
      }
    }
  }
}
