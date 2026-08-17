package com.rnmediamediasession

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.session.MediaSession
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.margelo.nitro.rnmediamediasession.SessionErrorCode
import java.util.concurrent.CancellationException

/**
 * media3's own artwork loader, with the failures made visible.
 *
 * ## Why this exists
 * Artwork on Android is not loaded by this package: the app broadcasts a URI,
 * media3 turns it into a `Bitmap` for the notification, and a URI that does not
 * resolve produced a cover-less notification and **nothing else** — no log of
 * ours, no callback, nothing an app could ship a check against. iOS reports the
 * same failure from `ArtworkCache`, so leaving Android silent would have made
 * `artworkFailed` a single-platform code (ARCHITECTURE §27, §28).
 *
 * ## Why replacing the loader is safe
 * `MediaSession.BuilderBase.ensureBitmapLoaderIsSizeLimited()` (media3 1.11.0,
 * read from the shipped AAR with `javap -c`) creates a `DataSourceBitmapLoader`
 * **only when the app set none**, and then — for the app-supplied one just the
 * same — wraps whatever it has in `SizeLimitedBitmapLoader`, in
 * `SizeAvoidingBitmapLoader` on API 29, and finally in `CacheBitmapLoader`. So
 * setting this rebuilds media3's default graph exactly, with one decorator
 * added at the bottom where it can see the actual load. The size cap the
 * default constructor applies is replicated in [mediaSessionDefault] for the
 * same reason: it is what keeps a 6000×6000 cover from being decoded in full
 * before the wrapper shrinks it.
 *
 * The `CacheBitmapLoader` above us means a *successful* cover is loaded once;
 * failures are not cached, so the de-duplication is done here, per URI.
 */
@OptIn(UnstableApi::class)
internal class ReportingBitmapLoader(private val delegate: BitmapLoader) : BitmapLoader {

  override fun supportsMimeType(mimeType: String): Boolean =
    delegate.supportsMimeType(mimeType)

  override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> =
    watch(delegate.decodeBitmap(data), "embedded artwork (${data.size} bytes)")

  override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> =
    watch(delegate.loadBitmap(uri), uri.toString())

  // `loadBitmapFromMetadata` is deliberately NOT overridden: its default
  // implementation on this interface dispatches to `decodeBitmap`/`loadBitmap`
  // — i.e. to the two overrides above — so overriding it would report the same
  // failure twice.

  /**
   * Attach a failure report to a load already in flight, and hand the very same
   * future back.
   *
   * `directExecutor` because the callback does no work: it formats a string and
   * hands it to [SessionErrors], which logs and schedules a JS call. Nothing
   * here blocks the thread that completed the future.
   */
  private fun watch(
    future: ListenableFuture<Bitmap>,
    source: String,
  ): ListenableFuture<Bitmap> {
    Futures.addCallback(
      future,
      object : FutureCallback<Bitmap> {
        override fun onSuccess(result: Bitmap?) = Unit

        override fun onFailure(error: Throwable) {
          // A cancelled load is not a failed one: media3 cancels the request for
          // a cover the moment the item changes, which is routine on any skip.
          if (error is CancellationException) return
          SessionErrors.report(
            SessionErrorCode.ARTWORKFAILED,
            "Could not load the artwork for $source; the notification and the lock " +
              "screen will show this item without a cover. " +
              "(${error.javaClass.simpleName}: ${error.message})",
            dedupeKey = "artwork:$source",
            cause = error,
          )
        }
      },
      MoreExecutors.directExecutor(),
    )
    return future
  }

  companion object {
    /**
     * media3 1.11.0's default base loader, reproduced so that decorating it
     * changes nothing but visibility.
     *
     * `maximumOutputDimension = 2 * getBitmapDimensionLimit(context) - 1` is
     * the constant `ensureBitmapLoaderIsSizeLimited` passes when it builds the
     * default itself; both symbols are public (`javap` on the shipped
     * `media3-session`/`media3-datasource` AARs).
     */
    fun mediaSessionDefault(context: Context): BitmapLoader =
      ReportingBitmapLoader(
        DataSourceBitmapLoader.Builder(context)
          .setMaximumOutputDimension(MediaSession.getBitmapDimensionLimit(context) * 2 - 1)
          .build()
      )
  }
}
