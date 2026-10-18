package expo.modules.waifusync

import android.app.Activity
import android.view.View
import android.view.ViewTreeObserver
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.PixelUtil
import java.lang.ref.WeakReference
import kotlin.math.max

/**
 * Reports IME height while the keyboard stays visible.
 *
 * On API 30+ React Native emits keyboardDidShow only when IME visibility
 * flips. A password field can swap to a taller secure keyboard with no layout
 * pass that sees the keyboard hidden, so no event arrives and the form keeps
 * the shorter height. This listener reads root window insets on each global
 * layout and reports only when visibility or the dp height changes. Hidden
 * reports height 0. It never installs an insets listener or an insets
 * animation callback: those replace the ones React Native already owns.
 */
class ImeHeightObserver(
  private val onChange: (heightDp: Double, visible: Boolean) -> Unit,
) {
  @Volatile
  private var activityRef: WeakReference<Activity>? = null
  private var attachedDecor: View? = null
  private var layoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null
  private var reportedVisible = false
  private var reportedHeightDp = 0.0

  fun attach(activity: Activity) {
    activityRef = WeakReference(activity)
    activity.runOnUiThread {
      val decor = activity.window.decorView
      if (layoutListener != null && attachedDecor === decor) return@runOnUiThread
      removeGlobalLayoutListener()
      val listener = ViewTreeObserver.OnGlobalLayoutListener { publish(decor) }
      decor.viewTreeObserver.addOnGlobalLayoutListener(listener)
      attachedDecor = decor
      layoutListener = listener
      publish(decor)
    }
  }

  fun detach() {
    val activity = activityRef?.get()
    if (activity != null) {
      activity.runOnUiThread { removeGlobalLayoutListener() }
    } else {
      UiThreadUtil.runOnUiThread { removeGlobalLayoutListener() }
    }
  }

  private fun removeGlobalLayoutListener() {
    val listener = layoutListener
    val decor = attachedDecor
    layoutListener = null
    attachedDecor = null
    reportedVisible = false
    reportedHeightDp = 0.0
    if (listener == null || decor == null) return
    val tree = decor.viewTreeObserver
    if (tree.isAlive) tree.removeOnGlobalLayoutListener(listener)
  }

  private fun publish(decor: View) {
    val insets = ViewCompat.getRootWindowInsets(decor)
    val visible = insets?.isVisible(WindowInsetsCompat.Type.ime()) == true
    val imeBottom = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
    val barsBottom = insets?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: 0
    val heightPx = if (visible) max(0, imeBottom - barsBottom) else 0
    val heightDp = PixelUtil.toDIPFromPixel(heightPx.toFloat()).toDouble()
    if (visible == reportedVisible && heightDp == reportedHeightDp) return
    reportedVisible = visible
    reportedHeightDp = heightDp
    onChange(heightDp, visible)
  }
}
