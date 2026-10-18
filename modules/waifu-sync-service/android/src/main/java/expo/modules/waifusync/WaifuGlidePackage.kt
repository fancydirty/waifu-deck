package expo.modules.waifusync

import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import com.bumptech.glide.Glide
import com.bumptech.glide.GlideBuilder
import com.bumptech.glide.load.resource.bitmap.BitmapDrawableEncoder
import com.bumptech.glide.load.resource.bitmap.BitmapEncoder
import com.bumptech.glide.request.RequestOptions
import com.github.penfeizhou.animation.glide.AnimationDecoderOption
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import kotlin.concurrent.thread

/**
 * Board row 46. penfeizhou's animated-AVIF check copies the bytes left to
 * read into a `byte[]` and again into a direct `ByteBuffer`, both on the
 * Java heap on Android, for every decode that reaches that check, e.g. one
 * from Glide's disk cache.
 *
 * Glide is created here with a default request option that skips that check.
 * GIF, APNG and WebP animation are unchanged; their checks read headers and
 * chunks. Static AVIF still decodes through Glide's avif-integration.
 *
 * This is not a `GlideModule`. expo-image's KSP-generated `AppGlideModule`
 * disables manifest parsing and lists only its own classpath's library
 * modules.
 *
 * `Glide.init` runs Glide's shared initialiser with this builder. The
 * generated module still applies its options and its library-module
 * registrations. `init` and `isInitialized` are `@VisibleForTesting`, but
 * public.
 *
 * The listener runs from `Application.onCreate`, before any image load in
 * this app's startup: content providers and earlier lifecycle listeners do
 * not load images. It leaves an existing Glide alone when that instance is
 * already present at the `isInitialized` check. The check and `init` are
 * not atomic, but nothing else initialises Glide during `Application.onCreate`.
 *
 * Board row 47 starts one background thread after that init. The thread
 * prepends encoders that decline ImageLoadTask's disk-cache writes. The
 * comment on the thread says why, including the phone numbers.
 */
class WaifuGlidePackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(GlideDefaultsListener)
}

private object GlideDefaultsListener : ApplicationLifecycleListener {
  override fun onCreate(application: Application) {
    if (Glide.isInitialized()) return
    Glide.init(
      application,
      GlideBuilder().setDefaultRequestOptions(
        RequestOptions().set(AnimationDecoderOption.DISABLE_ANIMATION_AVIF_DECODER, true),
      ),
    )
    // Board row 47. ImageLoadTask has no disk-cache option, so Glide's
    // AUTOMATIC strategy re-encodes its bitmap on the delivering thread.
    // The decode gate's loadAsync runs on every non-GIF save. GIF saves take
    // the first-frame path (library-decode-gate.ts). The detail page's useImage
    // is the other caller. On the owner's phone a 3800x6000 PNG save spent
    // 1316 ms PNG-encoding a 42.5 MB bitmap that nothing reads again, and
    // detail views re-encoded every preview (3-14 MB, 11-35 ms, 15 of 18).
    // Collection tiles are not CENTER_INSIDE, so they keep their entries
    // (JPEG tiles were 2-9 ms): those entries save re-decoding a local original.
    // Decline in encode, not in getEncodeStrategy: reporting NONE under ALL
    // or RESOURCE makes DecodeJob throw "Unknown strategy".
    // registry builds Glide's lazy registry, so this is one background thread
    // rather than more work on the main thread during cold start. A load that
    // already chose the stock encoder keeps it, so a few early loads may still
    // write their entries: at most one early entry per load.
    thread(name = "WaifuLoadTaskEncoders") {
      val glide = Glide.get(application)
      val bitmapEncoder = BitmapEncoder(glide.arrayPool)
      val drawableEncoder = BitmapDrawableEncoder(glide.bitmapPool, bitmapEncoder)
      glide.registry
        .prepend(Bitmap::class.java, LoadTaskSkippingBitmapEncoder(bitmapEncoder))
        .prepend(
          BitmapDrawable::class.java,
          LoadTaskSkippingBitmapDrawableEncoder(drawableEncoder),
        )
    }
  }
}
