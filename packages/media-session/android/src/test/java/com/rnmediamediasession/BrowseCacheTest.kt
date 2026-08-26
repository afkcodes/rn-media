package com.rnmediamediasession

import com.margelo.nitro.rnmediamediasession.BrowseMediaType
import com.margelo.nitro.rnmediamediasession.BrowseStyle
import com.margelo.nitro.rnmediamediasession.NativeBrowseItem
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The answer a car gets when there is no JavaScript to ask.
 *
 * Worth testing on a JVM rather than on a phone because the moment it exists
 * for — a car reconnecting to an app the OS killed — is the hardest one to
 * reproduce on a device and the easiest one to get subtly wrong: a round trip
 * that drops a field, a bound that never evicts, a half-written file that
 * throws on the media3 application thread.
 *
 * It is `cacheDir`, so a `@Rule`-free temp directory is the whole environment.
 */
class BrowseCacheTest {

  private val directory: File = File(
    System.getProperty("java.io.tmpdir"),
    "rn-media-browse-test-${System.nanoTime()}",
  )

  @After
  fun tearDown() {
    directory.deleteRecursively()
  }

  /**
   * A controllable clock: two cache operations in a real test happen inside one
   * millisecond, and the disk LRU orders by file mtime.
   */
  private var clock = 1_000_000L

  private fun cache(maxEntries: Int = 64, maxBytes: Long = 2L * 1024 * 1024) =
    BrowseCache(directory, maxEntries, maxBytes) { clock }

  private fun item(
    id: String,
    overrides: NativeBrowseItem.() -> NativeBrowseItem = { this },
  ): NativeBrowseItem = NativeBrowseItem(
    id = id,
    title = "Node $id",
    subtitle = null,
    artworkUri = null,
    browsable = false,
    playable = true,
    childStyle = null,
    group = null,
    isExplicit = false,
    completion = null,
    mediaType = BrowseMediaType.MIXED,
  ).overrides()

  @Test
  fun `every field survives the round trip`() {
    val rich = item("album:1") {
      copy(
        title = "Kind of Blue",
        subtitle = "Miles Davis",
        artworkUri = "https://example.test/a.jpg",
        browsable = true,
        playable = true,
        childStyle = BrowseStyle.GRID,
        group = "Recently played",
        isExplicit = true,
        completion = 0.25,
        mediaType = BrowseMediaType.FOLDERALBUMS,
      )
    }

    cache().put("albums", listOf(rich))

    // A *second* instance, so nothing is answered from the memory half — this
    // is the process-death path.
    assertEquals(listOf(rich), cache().get("albums"))
  }

  @Test
  fun `an id that is not a filename is still a key`() {
    val awkward = "album/2024?q=a b#1"
    cache().put(awkward, listOf(item("x")))

    assertEquals(1, cache().get(awkward)?.size)
    assertTrue(cache().keys().contains(awkward))
  }

  @Test
  fun `an unknown key is null, not empty`() {
    // The distinction is load-bearing: `null` lets the service decide (revive,
    // serve empty), while an empty list would look like a node the app really
    // said has nothing in it.
    assertNull(cache().get("nothing"))
  }

  @Test
  fun `evict removes one entry from both halves`() {
    val instance = cache()
    instance.put("albums", listOf(item("a")))
    instance.put("artists", listOf(item("b")))

    instance.evict("albums")

    assertNull(instance.get("albums"))
    assertNull(cache().get("albums"))
    assertNotNull(instance.get("artists"))
  }

  @Test
  fun `clear removes everything, including what is only on disk`() {
    cache().put("albums", listOf(item("a")))

    val instance = cache()
    instance.clear()

    assertNull(instance.get("albums"))
    assertEquals(emptySet<String>(), instance.keys())
  }

  @Test
  fun `keys sees what a previous process wrote`() {
    cache().put("albums", listOf(item("a")))
    cache().put(BrowseCache.searchKey("jazz"), listOf(item("b")))

    assertEquals(setOf("albums", "search:jazz"), cache().keys())
  }

  @Test
  fun `a search key is recognisable and cannot collide with a parent`() {
    assertTrue(BrowseCache.isSearchKey(BrowseCache.searchKey("jazz")))
    assertTrue(!BrowseCache.isSearchKey("albums"))
  }

  @Test
  fun `the entry bound evicts the least recently used`() {
    val instance = cache(maxEntries = 2)
    instance.put("a", listOf(item("a")))
    clock += 1_000
    instance.put("b", listOf(item("b")))
    // Touch "a" so "b" becomes the least recently used.
    clock += 1_000
    instance.get("a")
    clock += 1_000
    instance.put("c", listOf(item("c")))

    assertEquals(setOf("a", "c"), cache().keys())
  }

  @Test
  fun `the byte bound evicts too, even when the entry count is fine`() {
    val instance = cache(maxEntries = 64, maxBytes = 400)
    val fat = (1..10).map { item("track:$it") { copy(title = "T".repeat(40)) } }

    instance.put("a", fat)
    clock += 1_000
    instance.put("b", fat)

    val remaining = cache().keys()
    assertTrue("one fat entry should have been evicted", remaining.size < 2)
  }

  @Test
  fun `a corrupt file reads as nothing cached and is deleted`() {
    val instance = cache()
    instance.put("albums", listOf(item("a")))
    val file = directory.listFiles()!!.single()
    file.writeText("{ this is not json")

    assertNull(cache().get("albums"))
    assertTrue("the unusable file is cleaned up", !file.exists())
  }

  @Test
  fun `a file written for another key is not served`() {
    // Belt and braces against a hash collision or a hand-copied file: the key
    // is inside the payload, and a mismatch reads as nothing cached.
    val instance = cache()
    instance.put("albums", listOf(item("a")))
    val file = directory.listFiles()!!.single()
    file.writeText(file.readText().replace("\"key\":\"albums\"", "\"key\":\"artists\""))

    assertNull(cache().get("albums"))
  }
}
