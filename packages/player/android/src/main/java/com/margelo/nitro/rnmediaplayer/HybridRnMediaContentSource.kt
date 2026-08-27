// NOT a free choice: nitrogen hardcodes the implementation class's JNI
// descriptor as `Lcom/margelo/nitro/<androidNamespace>/<implementationClassName>;`
// (see nitrogen/generated/android/RnMediaPlayerOnLoad.cpp). Anywhere else and
// `NitroModules.createHybridObject('RnMediaContentSource')` throws
// ClassNotFoundException at runtime, with nothing failing at build time.
package com.margelo.nitro.rnmediaplayer

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import com.margelo.nitro.NitroModules
import java.io.FileNotFoundException

/**
 * `content://` → file descriptor, so libmpv can read what Android's storage
 * picker hands back.
 *
 * ## Why the player cannot do this itself
 * A `content://` URI is a row in another app's `ContentProvider`, reachable
 * only through a Binder call that this process is authorised to make. There is
 * no path to open and no bytes to fetch over a socket, so no amount of work
 * inside libmpv or FFmpeg could ever add a handler for the scheme — the
 * resolution is an Android IPC, and it has to happen in Kotlin. What crosses
 * back is the one thing a Binder-opened file can be reduced to: a descriptor,
 * which mpv reads through its own `fd://` protocol
 * (mpv 0.41.0 `stream/stream_file.c:298-313`).
 *
 * ## Ownership: `detachFd`, and why this class also closes
 * [android.os.ParcelFileDescriptor.detachFd] takes the descriptor out of the
 * `ParcelFileDescriptor`'s hands, so neither the finalizer nor a `close()`
 * anywhere in Android will shut it: whoever holds the number owns it. That is
 * deliberate. mpv's `fdclose://` variant would close the descriptor when the
 * stream ends, which breaks the moment the same playlist entry is opened twice
 * — a replay, a loop, a prefetch mpv decided to drop — and the URL a source
 * resolver returns has to be *stable* per entry, so it will be opened twice.
 * The TypeScript side keeps one descriptor per URI and calls [closeContentFd]
 * when the player is destroyed.
 *
 * ## Threading
 * Nothing here holds state, and [openContentUri] is a blocking Binder call —
 * it is invoked from the JavaScript thread only at load time, where the caller
 * is already awaiting a load, and never from mpv's event thread. There is no
 * receiver, no handler and nothing to synchronise; the object is stateless by
 * design so that it can stay that way.
 */
class HybridRnMediaContentSource : HybridRnMediaContentSourceSpec() {

  private val appContext: Context =
    (NitroModules.applicationContext
      ?: throw IllegalStateException(
        "[player] No ReactApplicationContext available. " +
          "Is react-native-nitro-modules installed correctly?"
      ))
      // The *application* context: this object outlives any Activity, and a
      // URI permission grant is held by the process, not by a screen.
      .applicationContext

  private val resolver: ContentResolver
    get() = appContext.contentResolver

  override fun openContentUri(uri: String): Double {
    val parsed =
      try {
        Uri.parse(uri)
      } catch (cause: Throwable) {
        throw IllegalArgumentException("[player] Not a parsable URI: $uri", cause)
      }
    if (parsed.scheme != ContentResolver.SCHEME_CONTENT) {
      throw IllegalArgumentException(
        "[player] openContentUri expects a content:// URI, got '$uri'."
      )
    }

    // "r" and never "rw": a player reads. Some providers reject a mode they
    // cannot honour outright, so asking for less is also asking for fewer
    // failures.
    val descriptor =
      try {
        resolver.openFileDescriptor(parsed, "r")
      } catch (cause: FileNotFoundException) {
        // The row is gone, or this process never had (or no longer has) the
        // grant. Both arrive here and both mean the same thing to a caller.
        throw FileNotFoundException(
          "[player] Cannot open $uri: ${cause.message ?: "no such document, or the read grant has lapsed"}"
        )
      } catch (cause: SecurityException) {
        throw SecurityException(
          "[player] Not permitted to read $uri: ${cause.message ?: "no read grant for this process"}. " +
            "A content:// URI from a picker is readable only while the grant lasts — take a persistable " +
            "grant with ContentResolver.takePersistableUriPermission() if you are storing the URI."
        )
      } catch (cause: IllegalArgumentException) {
        // Thrown by ContentResolver when no provider is registered for the
        // authority — a URI from an app that has since been uninstalled.
        throw IllegalArgumentException(
          "[player] No content provider for $uri: ${cause.message ?: "unknown authority"}"
        )
      }
        ?: throw FileNotFoundException(
          "[player] The provider for $uri returned no file descriptor."
        )

    // `detachFd` rather than `fd`: mpv is going to hold this for the life of
    // the playlist entry, and a `ParcelFileDescriptor` collected in the
    // meantime would close a descriptor mpv is reading. See the class doc.
    return descriptor.detachFd().toDouble()
  }

  override fun closeContentFd(fd: Double) {
    val raw = fd.toInt()
    if (raw < 0) return
    // `adoptFd` wraps the bare descriptor back up so that `close()` releases
    // it through the same API that produced it. `ParcelFileDescriptor.close()`
    // on a descriptor that is already gone throws, and a player being torn
    // down twice is not worth propagating.
    try {
      android.os.ParcelFileDescriptor.adoptFd(raw).close()
    } catch (_: Throwable) {
      // Already closed, or never valid. Nothing left to release.
    }
  }
}
