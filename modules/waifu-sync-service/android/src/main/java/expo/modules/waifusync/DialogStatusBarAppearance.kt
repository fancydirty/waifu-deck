package expo.modules.waifusync

import android.view.View
import android.view.ViewGroup
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.views.modal.ReactModalHostView

/**
 * N8: React Native's [com.facebook.react.modules.statusbar.StatusBarModule]
 * sets `APPEARANCE_LIGHT_STATUS_BARS` only on `currentActivity.window`.
 * [ReactModalHostView] creates its own [android.app.Dialog] window and in
 * `updateSystemAppearance()` copies `activityWindowInsetsController.isAppearanceLightStatusBars`
 * onto the dialog window at `show()` time — before the modal's child
 * `<StatusBar style="light" />` `setImmediate` effect runs. On Android 16
 * (API 36), SystemUI takes status bar icon appearance from the top fullscreen
 * window (the Dialog), so a black modal opened from a light-mode screen stays
 * stuck with `LIGHT_STATUS_BARS` (dark icons on a black status bar).
 *
 * Updating the Dialog's own [WindowInsetsControllerCompat] directly resolves
 * the window-target mismatch without replacing the Modal Dialog container.
 */
object DialogStatusBarAppearance {
  fun apply(reactContext: ReactContext, lightIcons: Boolean) {
    UiThreadUtil.runOnUiThread {
      val root = reactContext.currentActivity?.window?.decorView ?: return@runOnUiThread
      val window = findModalHost(root)?.dialog?.window ?: return@runOnUiThread
      WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars =
        !lightIcons
    }
  }

  private fun findModalHost(view: View): ReactModalHostView? {
    if (view is ReactModalHostView && view.dialog?.isShowing == true) {
      return view
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        val found = findModalHost(view.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }
}
