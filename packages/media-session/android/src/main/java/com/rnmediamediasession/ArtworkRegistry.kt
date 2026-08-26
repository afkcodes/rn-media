package com.rnmediamediasession

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * The map between an `https://` cover URL and the `content://` URI a car is
 * allowed to ask for.
 *
 * It exists because of one platform rule: Android Auto renders browse artwork
 * from `content://` and `android.resource://` only
 * (…/training/cars/media/create-media-browser/media-artwork). So the browse
 * conversion registers each URL, hands the car
 * `content://<applicationId>.rnmedia.artwork/<sha256>`, and
 * [RnMediaArtworkProvider] serves the bytes.
 *
 * ## Why it is a registry and not "the provider fetches whatever you ask for"
 * The provider is `exported="true"` — it has to be, the browser is another
 * process — so anything on the device can call it. If the URI carried the
 * source URL, this package would be a general-purpose HTTP proxy running with
 * the app's network identity. Instead the URI carries an opaque hash, and only
 * a hash this app registered **while building its own browse tree** resolves to
 * anything at all.
 *
 * ## Persistence, and why clearing it is always safe
 * A car can ask for an icon it cached days ago, in a process that has just
 * started, so the map is mirrored into `SharedPreferences`. It is a *cache of
 * what the browse tree last showed*: every conversion re-registers, so a
 * dropped entry costs one re-registration and never a wrong picture. That is
 * what makes the bound honest — past [MAX_ENTRIES] the whole map is dropped
 * rather than half-evicted by a policy nobody can reason about.
 */
internal class ArtworkRegistry private constructor(
  private val prefs: SharedPreferences,
  private val directory: File,
  private val authority: String,
) {

  private val memory = ConcurrentHashMap<String, String>()

  @Volatile
  private var loaded = false

  /**
   * The size hint the last browser sent in its root hints
   * (`EXTRAS_KEY_MEDIA_ART_SIZE_PIXELS`), or [DEFAULT_ART_SIZE].
   *
   * Read on the binder thread that serves `openFile` and written on the media3
   * application thread that serves the root, hence `@Volatile`. A hint that
   * arrives after an icon was already downscaled applies to the next download —
   * which is why the file name is the hash and not the hash plus a size: a car
   * that changes its mind gets the old size once, not a second copy forever.
   */
  @Volatile
  var artSizePixels: Int = DEFAULT_ART_SIZE
    set(value) {
      if (value in MIN_ART_SIZE..MAX_ART_SIZE) field = value
    }

  /**
   * Register a URL and return the hash the car will ask for.
   *
   * `edit { }` (androidx `core-ktx`) is deliberately not used here or anywhere
   * else in this module: `core-ktx` is not a declared dependency of it, it is
   * only on the classpath transitively, and compiling against a transitive
   * artifact is how a build breaks when something upstream drops it.
   */
  @Suppress("UseKtx")
  fun register(url: String): String {
    val hash = sha256(url)
    if (memory.put(hash, url) == url) return hash
    // Written through immediately: the process can die between building a
    // browse tree and the car asking for the icons in it, and a lost entry is a
    // cover that never appears until the app is opened again.
    val editor = prefs.edit()
    if (memory.size > MAX_ENTRIES) {
      editor.clear()
      memory.keys.retainAll(setOf(hash))
    }
    editor.putString(hash, url).apply()
    return hash
  }

  /** The URL behind a hash, or `null` when this app never registered it. */
  fun urlFor(hash: String): String? {
    memory[hash]?.let { return it }
    loadOnce()
    return memory[hash]
  }

  /** Built rather than parsed — the parts are known, so nothing has to be. */
  fun contentUri(hash: String): Uri = Uri.Builder()
    .scheme("content")
    .authority(authority)
    .appendPath(hash)
    .build()

  /** Where the served, downscaled JPEG lives. */
  fun fileFor(hash: String): File = File(directory.apply { mkdirs() }, hash)

  private fun loadOnce() {
    if (loaded) return
    synchronized(this) {
      if (loaded) return
      for ((key, value) in prefs.all) {
        if (value is String) memory.putIfAbsent(key, value)
      }
      loaded = true
    }
  }

  internal companion object {
    private const val PREFS = "rn-media-artwork"

    /**
     * Past this the map is dropped whole. 512 covers is far more than any
     * browse tree shows at once and small enough that the preferences file
     * stays a few tens of kilobytes.
     */
    private const val MAX_ENTRIES = 512

    const val DEFAULT_ART_SIZE = 256
    private const val MIN_ART_SIZE = 48
    private const val MAX_ART_SIZE = 1024

    @Volatile
    private var instance: ArtworkRegistry? = null

    /**
      * Built from what it actually needs — the preferences, the directory, the
      * authority — and **never from a `Context`**.
      *
      * Not a style choice: this object is held in a static field for the life
      * of the process, and a `Context` field on it is the shape lint calls
      * `StaticFieldLeak`. An application context would in fact be harmless,
      * but "harmless because it happens to be the application context" is a
      * property nothing enforces; holding three inert values enforces it.
      */
    fun of(context: Context): ArtworkRegistry {
      instance?.let { return it }
      val application = context.applicationContext
      return synchronized(this) {
        instance ?: ArtworkRegistry(
          prefs = application.getSharedPreferences(PREFS, Context.MODE_PRIVATE),
          directory = File(application.cacheDir, "rn-media/artwork"),
          authority = authority(application),
        ).also { instance = it }
      }
    }

    /**
     * Must match the `android:authorities` in this package's manifest, where it
     * is written as `${applicationId}.rnmedia.artwork` and merged into the
     * consumer's manifest by AGP.
     */
    fun authority(context: Context): String = "${context.packageName}.rnmedia.artwork"

    fun sha256(value: String): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
      val out = StringBuilder(digest.size * 2)
      for (byte in digest) {
        val int = byte.toInt() and 0xFF
        out.append(HEX[int ushr 4]).append(HEX[int and 0x0F])
      }
      return out.toString()
    }

    private const val HEX = "0123456789abcdef"
  }
}
