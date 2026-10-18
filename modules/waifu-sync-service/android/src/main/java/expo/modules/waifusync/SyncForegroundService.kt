package expo.modules.waifusync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * K6-3. A foreground service that does no work.
 *
 * Measured on the emulator 2026-09-14 02:30: three saves, screen locked 1.5 s
 * later, 0 of 3 uploads finished after 90 s — Android had frozen the app's JS
 * thread. The uploads themselves are perfectly capable of running; the process
 * simply stops being scheduled. A `dataSync` foreground service is the
 * platform's supported way to say "this process has user-visible work in
 * flight", which is exactly true while a save is on its way to the bucket.
 *
 * So this class starts a notification and nothing else. It is not a scheduler,
 * a queue, or a second copy of the sync engine: the JS that was already
 * uploading keeps uploading, because the process it lives in stays awake.
 * Android 15's 6-hour `dataSync` budget applies and is not worked around.
 */
class SyncForegroundService : Service() {

  private var foreground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onTimeout(startId: Int, fgsType: Int) {
    if ((fgsType and ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) == 0) return
    Log.w(TAG, "dataSync foreground service timed out; stopping")
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    foreground = false
    stopSelf(startId)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action

    // Every command, `STOP` included, arrives through `startForegroundService`,
    // so every command owes the platform a `startForeground` within ~5 s. An
    // app whose service stops first is killed (board #28, the 2026-09-28
    // crash: a stray `STOP` reached an instance that was not in the
    // foreground). So an instance that is not in the foreground starts first,
    // whatever the action; a `STOP` then removes the notification again.
    if (!foreground) {
      val stopping = action == ACTION_STOP
      if (!startForegroundSafely(
          startId,
          buildNotification(
            if (stopping) STOP_TITLE else intent?.getStringExtra(EXTRA_TITLE).orEmpty(),
            if (stopping) "" else intent?.getStringExtra(EXTRA_TEXT).orEmpty(),
          ),
        )) return START_NOT_STICKY
      foreground = true
    } else if (action != ACTION_STOP) {
      val notification = buildNotification(
        intent?.getStringExtra(EXTRA_TITLE).orEmpty(),
        intent?.getStringExtra(EXTRA_TEXT).orEmpty(),
      )
      if (action == ACTION_UPDATE) {
        // Only the text changed. `notify` on the same id edits the existing
        // notification in place, which `setOnlyAlertOnce` keeps silent.
        notificationManager().notify(NOTIFICATION_ID, notification)
      } else {
        if (!startForegroundSafely(startId, notification)) return START_NOT_STICKY
      }
    }

    if (action == ACTION_STOP) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      foreground = false
      // `stopSelf(startId)`, not `stopSelf()`: a `START` that reached the
      // system after this `STOP` still owes `startForeground` and must not be
      // torn down by it.
      stopSelf(startId)
    }
    // Not sticky: if the process dies mid-upload there is nothing for a
    // relaunched service to resume — the sync engine's outbox is the durable
    // record, and `expo-background-task` is the after-the-fact catch-up.
    return START_NOT_STICKY
  }

  private fun startForegroundSafely(startId: Int, notification: Notification): Boolean {
    return try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
      true
    } catch (e: Exception) {
      // Logged so a refused start is visible in logcat, not mistaken for a STOP.
      Log.w(TAG, "startForeground refused; ending this instance", e)
      foreground = false
      // Best effort: Android refused (for example Android 15's used-up
      // `dataSync` budget), which should clear its pending requirement.
      stopSelf(startId)
      false
    }
  }

  private fun notificationManager(): NotificationManager =
    getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun buildNotification(title: String, text: String): Notification {
    // Created only when missing: the title is the channel's name, so creating
    // it on every call would rename it (a `STOP` would rename it to the fixed title).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      notificationManager().getNotificationChannel(CHANNEL_ID) == null
    ) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        title.ifEmpty { CHANNEL_ID },
        // Low: the notification has to exist for the service to be legal, but
        // it must never make a sound or peek over what the user is doing.
        NotificationManager.IMPORTANCE_LOW,
      )
      channel.setShowBadge(false)
      notificationManager().createNotificationChannel(channel)
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .build()
  }

  companion object {
    const val ACTION_START = "expo.modules.waifusync.START"
    const val ACTION_UPDATE = "expo.modules.waifusync.UPDATE"
    const val ACTION_STOP = "expo.modules.waifusync.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "waifu-sync"
    private const val NOTIFICATION_ID = 1001
    private const val STOP_TITLE = "Waifu Deck"
    private const val TAG = "WaifuSyncService"
  }
}
