package expo.modules.waifusync

import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import com.bumptech.glide.load.EncodeStrategy
import com.bumptech.glide.load.Options
import com.bumptech.glide.load.ResourceEncoder
import com.bumptech.glide.load.engine.Resource
import com.bumptech.glide.load.resource.bitmap.BitmapDrawableEncoder
import com.bumptech.glide.load.resource.bitmap.BitmapEncoder
import com.bumptech.glide.load.resource.bitmap.DownsampleStrategy
import java.io.File

/**
 * Resource encoders that decline ImageLoadTask's disk write.
 *
 * encode returns false, and does not touch the file, when the request's
 * downsample option is Glide's CENTER_INSIDE singleton. ImageLoadTask is the
 * only load that sets it. Every other request, including collection tiles,
 * is passed to the stock encoder.
 *
 * getEncodeStrategy returns the delegate's strategy. Decline in encode, not
 * in getEncodeStrategy: reporting NONE under ALL or RESOURCE makes DecodeJob
 * throw "Unknown strategy".
 */
private fun isCenterInsideLoadTask(options: Options): Boolean =
  options.get(DownsampleStrategy.OPTION) === DownsampleStrategy.CENTER_INSIDE

internal class LoadTaskSkippingBitmapEncoder(
  private val delegate: BitmapEncoder,
) : ResourceEncoder<Bitmap> {
  override fun getEncodeStrategy(options: Options): EncodeStrategy {
    return delegate.getEncodeStrategy(options)
  }

  override fun encode(resource: Resource<Bitmap>, file: File, options: Options): Boolean {
    if (isCenterInsideLoadTask(options)) {
      return false
    }
    return delegate.encode(resource, file, options)
  }
}

internal class LoadTaskSkippingBitmapDrawableEncoder(
  private val delegate: BitmapDrawableEncoder,
) : ResourceEncoder<BitmapDrawable> {
  override fun getEncodeStrategy(options: Options): EncodeStrategy {
    return delegate.getEncodeStrategy(options)
  }

  override fun encode(resource: Resource<BitmapDrawable>, file: File, options: Options): Boolean {
    if (isCenterInsideLoadTask(options)) {
      return false
    }
    return delegate.encode(resource, file, options)
  }
}
