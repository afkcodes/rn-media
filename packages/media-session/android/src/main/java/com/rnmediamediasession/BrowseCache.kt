package com.rnmediamediasession

import android.content.Context
import com.margelo.nitro.rnmediamediasession.BrowseMediaType
import com.margelo.nitro.rnmediamediasession.BrowseStyle
import com.margelo.nitro.rnmediamediasession.NativeBrowseItem
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the app last said was under each browse node — in memory, and on disk.
 *
 * ## Why a cache at all
 * A browse pull is a round trip into JavaScript, and there are two moments when
 * JavaScript is not there to answer:
 *
 * 1. **The process was killed.** A car reconnects, binds the service, and asks
 *    for the root before any runtime exists. The honest alternative is an empty
 *    list, i.e. an app that looks broken until it is opened on the phone.
 * 2. **A revival is in flight.** The runtime is booting; the browser is not
 *    going to wait for it.
 *
 * In both cases this is what the browser gets, and the moment the runtime
 * arrives the service calls `notifyChildrenChanged` for everything it served
 * from here — so a stale answer is corrected within the same connection rather
 * than living until the next drive.
 *
 * ## Bounds
 * 64 entries and 2 MB, whichever binds first, evicted least-recently-used. Both
 * numbers are about the *disk*: this is `cacheDir`, which the platform is free
 * to delete under storage pressure, and a browse tree is regenerable data. The
 * memory half is the same 64 entries, which for a browse list is tens of
 * kilobytes.
 *
 * Everything here is filesystem + JSON, so it is unit-tested on the JVM against
 * a temporary directory (`BrowseCacheTest`).
 */
internal class BrowseCache(
  private val directory: File,
  private val maxEntries: Int = MAX_ENTRIES,
  private val maxBytes: Long = MAX_BYTES,
  /**
   * The clock the disk LRU orders by, injectable so a test can order two
   * operations that a real one would perform in the same millisecond.
   *
   * The disk half has to carry its own recency — a file's mtime is the only
   * thing that survives the process — and `File.setLastModified` is what
   * writes it, on both a write and a read.
   */
  private val now: () -> Long = { System.currentTimeMillis() },
) {

  /**
   * Access-ordered so `removeEldestEntry` evicts the least recently *read*, not
   * the least recently written — a car that keeps re-opening one tab should not
   * lose it to a tab it opened once.
   */
  private val memory = object : LinkedHashMap<String, List<NativeBrowseItem>>(
    16,
    0.75f,
    /* accessOrder = */ true,
  ) {
    override fun removeEldestEntry(
      eldest: MutableMap.MutableEntry<String, List<NativeBrowseItem>>?,
    ): Boolean = size > maxEntries
  }

  /** Every key that has an answer, memory or disk. Main use: invalidate-all. */
  @Synchronized
  fun keys(): Set<String> {
    val keys = LinkedHashSet(memory.keys)
    for (file in directory.listFiles().orEmpty()) {
      readKey(file)?.let { keys.add(it) }
    }
    return keys
  }

  @Synchronized
  fun get(key: String): List<NativeBrowseItem>? {
    val file = fileFor(key)
    memory[key]?.let {
      // Touched even on a memory hit, and that is the whole point: the two
      // halves must age together. Without this the disk order records writes
      // only, so the tab a driver keeps re-opening — always answered from
      // memory — looks untouched to [trim] and is the first thing evicted when
      // the process restarts.
      file.setLastModified(now())
      return it
    }
    if (!file.exists()) return null
    val items = runCatching { decode(file.readText(), key) }.getOrNull()
    if (items == null) {
      // A half-written or hand-edited file is not a crash and not a mystery:
      // drop it and behave exactly as if nothing had been cached.
      file.delete()
      return null
    }
    file.setLastModified(now())
    memory[key] = items
    return items
  }

  @Synchronized
  fun put(key: String, items: List<NativeBrowseItem>) {
    memory[key] = items
    runCatching {
      directory.mkdirs()
      val file = fileFor(key)
      file.writeText(encode(key, items))
      file.setLastModified(now())
      trim()
    }
  }

  @Synchronized
  fun evict(key: String) {
    memory.remove(key)
    fileFor(key).delete()
  }

  @Synchronized
  fun clear() {
    memory.clear()
    directory.listFiles()?.forEach { it.delete() }
  }

  /** Delete least-recently-touched files until both bounds hold. */
  private fun trim() {
    val files = directory.listFiles().orEmpty().sortedBy { it.lastModified() }
    var count = files.size
    var bytes = files.sumOf { it.length() }
    for (file in files) {
      if (count <= maxEntries && bytes <= maxBytes) return
      bytes -= file.length()
      count -= 1
      file.delete()
    }
  }

  /**
   * One file per key, named by hash.
   *
   * A browse id is app-defined and may contain `/`, spaces, or 4 KB of JSON;
   * none of that is a filename. The key itself is written *inside* the file so
   * [keys] can recover it without a second index to keep in sync.
   */
  private fun fileFor(key: String): File =
    File(directory, ArtworkRegistry.sha256(key) + ".json")

  private fun readKey(file: File): String? = runCatching {
    JSONObject(file.readText()).optString(FIELD_KEY).ifEmpty { null }
  }.getOrNull()

  private fun encode(key: String, items: List<NativeBrowseItem>): String {
    val array = JSONArray()
    for (item in items) {
      val json = JSONObject()
        .put("id", item.id)
        .put("title", item.title)
        .put("browsable", item.browsable)
        .put("playable", item.playable)
        .put("explicit", item.isExplicit)
        .put("mediaType", item.mediaType.name)
      item.subtitle?.let { json.put("subtitle", it) }
      item.artworkUri?.let { json.put("artworkUri", it) }
      item.childStyle?.let { json.put("childStyle", it.name) }
      item.group?.let { json.put("group", it) }
      item.completion?.let { json.put("completion", it) }
      array.put(json)
    }
    return JSONObject()
      .put(FIELD_VERSION, VERSION)
      .put(FIELD_KEY, key)
      .put(FIELD_ITEMS, array)
      .toString()
  }

  private fun decode(text: String, key: String): List<NativeBrowseItem>? {
    val root = JSONObject(text)
    // A version bump means the shape changed; an old file is not worth a
    // migration for regenerable data, so it reads as "nothing cached".
    if (root.optInt(FIELD_VERSION) != VERSION) return null
    if (root.optString(FIELD_KEY) != key) return null
    val array = root.optJSONArray(FIELD_ITEMS) ?: return null
    val items = ArrayList<NativeBrowseItem>(array.length())
    for (index in 0 until array.length()) {
      val json = array.optJSONObject(index) ?: return null
      val id = json.optString("id").ifEmpty { return null }
      items.add(
        NativeBrowseItem(
          id = id,
          title = json.optString("title"),
          subtitle = json.optStringOrNull("subtitle"),
          artworkUri = json.optStringOrNull("artworkUri"),
          browsable = json.optBoolean("browsable"),
          playable = json.optBoolean("playable"),
          childStyle = json.optStringOrNull("childStyle")?.let { name ->
            BrowseStyle.entries.firstOrNull { it.name == name }
          },
          group = json.optStringOrNull("group"),
          isExplicit = json.optBoolean("explicit"),
          completion = if (json.has("completion")) json.optDouble("completion") else null,
          mediaType = BrowseMediaType.entries
            .firstOrNull { it.name == json.optString("mediaType") }
            ?: BrowseMediaType.MIXED,
        )
      )
    }
    return items
  }

  private fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) optString(name).ifEmpty { null } else null

  internal companion object {
    const val MAX_ENTRIES = 64
    const val MAX_BYTES = 2L * 1024 * 1024

    /** Bumped whenever [encode]'s shape changes. See [decode]. */
    private const val VERSION = 1
    private const val FIELD_VERSION = "v"
    private const val FIELD_KEY = "key"
    private const val FIELD_ITEMS = "items"

    /**
     * The cache key for a search.
     *
     * A prefix rather than a second cache: search results and browse children
     * are the same shape with the same bounds, and one LRU means a heavy
     * searcher and a heavy browser share a budget instead of each having one.
     * The prefix is what keeps `invalidateBrowse()` from calling
     * `notifyChildrenChanged` for a "parent" that is a query.
     */
    fun searchKey(query: String): String = SEARCH_PREFIX + query

    fun isSearchKey(key: String): Boolean = key.startsWith(SEARCH_PREFIX)

    private const val SEARCH_PREFIX = "search:"

    @Volatile
    private var shared: BrowseCache? = null

    /**
     * The process-wide cache, under `cacheDir` — regenerable data the platform
     * is free to reclaim, which is exactly what a browse tree is.
     */
    fun of(context: Context): BrowseCache {
      shared?.let { return it }
      return synchronized(this) {
        shared ?: BrowseCache(
          File(context.applicationContext.cacheDir, "rn-media/browse")
        ).also { shared = it }
      }
    }
  }
}
