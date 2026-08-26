package com.rnmediamediasession

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Serves browse artwork to Android Auto over `content://`, because that is the
 * only scheme it renders.
 *
 * Read-only and deliberately dumb: it takes a hash, looks it up in
 * [ArtworkRegistry] — which only knows hashes **this app registered while
 * building its own browse tree** — downloads the URL on a miss, downscales it
 * to the browser's requested size, and hands back a file descriptor. There is
 * no path in this class that can be pointed at an arbitrary URL or an arbitrary
 * file, which is the whole reason the registry exists (see its docs).
 *
 * ## Threading
 * `openFile` is called on a binder thread and is allowed to block — that is the
 * documented contract, and the browser shows a placeholder until it returns.
 * The download is therefore synchronous, with a hard [TIMEOUT_MS] so a hung CDN
 * cannot pin a binder thread.
 *
 * Declared in this package's own manifest with `exported="true"` (the browser
 * is another process) and `grantUriPermissions="false"` (nothing here is
 * handed out per-URI; the registry is the gate) — the same shape Google's UAMP
 * sample uses for the identical problem.
 */
class RnMediaArtworkProvider : ContentProvider() {

  override fun onCreate(): Boolean = true

  /**
   * The only method that does anything.
   *
   * @throws FileNotFoundException for an unknown hash, a URL that will not
   * download, or bytes that will not decode — the documented failure for this
   * method, and what makes the browser draw its own placeholder instead of
   * waiting forever.
   */
  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") {
      throw FileNotFoundException("This provider is read-only (asked for mode \"$mode\").")
    }
    val context = context ?: throw FileNotFoundException("No context.")
    val hash = uri.lastPathSegment
    if (hash == null || !hash.matches(HASH)) {
      throw FileNotFoundException("Not an artwork id: $uri")
    }

    val registry = ArtworkRegistry.of(context)
    val file = registry.fileFor(hash)
    if (!file.exists() || file.length() == 0L) {
      val url = registry.urlFor(hash)
        ?: throw FileNotFoundException(
          "No artwork is registered for $uri. Only URLs this app put in its own " +
            "browse tree are served."
        )
      download(url, file, registry.artSizePixels)
    }
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  /**
   * Fetch, decode at a sample size, re-encode as JPEG.
   *
   * Two decodes rather than one: `inJustDecodeBounds` first, so the full
   * bitmap is never allocated at its source resolution. A 3000×3000 press
   * photo decoded whole is 36 MB, and this runs in the app's process, next to
   * a media session that must not be the thing that OOMs.
   */
  private fun download(url: String, target: File, sizePx: Int) {
    val temp = File(target.parentFile, "${target.name}.part")
    try {
      fetch(url, temp)

      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(temp.path, bounds)
      val longest = maxOf(bounds.outWidth, bounds.outHeight)
      if (longest <= 0) throw FileNotFoundException("Artwork at $url did not decode.")

      var sample = 1
      while (longest / (sample * 2) >= sizePx) sample *= 2
      val bitmap = BitmapFactory.decodeFile(
        temp.path,
        BitmapFactory.Options().apply { inSampleSize = sample },
      ) ?: throw FileNotFoundException("Artwork at $url did not decode.")

      try {
        FileOutputStream(target).use { out ->
          bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        }
      } finally {
        bitmap.recycle()
      }
    } catch (error: FileNotFoundException) {
      target.delete()
      throw error
    } catch (error: Exception) {
      target.delete()
      Log.w(RnMediaMediaSessionService.TAG, "Browse artwork $url could not be served.", error)
      throw FileNotFoundException("Artwork at $url could not be fetched: ${error.message}")
    } finally {
      temp.delete()
    }
  }

  private fun fetch(url: String, temp: File) {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = TIMEOUT_MS
    connection.readTimeout = TIMEOUT_MS
    connection.instanceFollowRedirects = true
    try {
      if (connection.responseCode !in 200..299) {
        throw FileNotFoundException("HTTP ${connection.responseCode} for $url")
      }
      connection.inputStream.use { input ->
        FileOutputStream(temp).use { output -> input.copyTo(output) }
      }
    } finally {
      connection.disconnect()
    }
  }

  /* --- Everything else: this is not a database. ---------------------------- */

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String = "image/jpeg"

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  private companion object {
    /** Exactly what [ArtworkRegistry.sha256] produces, and nothing else. */
    val HASH = Regex("^[0-9a-f]{64}$")
    const val TIMEOUT_MS = 10_000
    const val JPEG_QUALITY = 88
  }
}
