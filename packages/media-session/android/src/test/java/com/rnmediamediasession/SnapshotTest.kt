package com.rnmediamediasession

import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The channel-priority merge and the timeline it produces.
 *
 * Pure by design (`Snapshot` deliberately keeps `android.util.Log` out of
 * itself so it stays JVM-testable), and the defect it exists for is invisible
 * from the outside: with the merge missing, a queue-backed timeline never
 * learns the duration the app broadcast through `setMediaItem`, `durationUs`
 * stays `C.TIME_UNSET`, and the lock screen quietly shows no scrubber.
 */
class SnapshotTest {

  private fun item(
    id: String,
    title: String = "Title",
    artist: String? = null,
    album: String? = null,
    artworkUri: String? = null,
    duration: Double? = null,
    genre: String? = null,
  ) = NativeMediaItem(id, title, artist, album, artworkUri, duration, genre)

  private fun snapshot(
    item: NativeMediaItem? = null,
    queue: List<NativeMediaItem> = emptyList(),
    queueIndex: Int = -1,
    capabilities: Set<MediaCapability> = emptySet(),
  ) = Snapshot.EMPTY.copy(
    status = MediaPlaybackStatus.PAUSED,
    item = item,
    queue = queue,
    queueIndex = queueIndex,
    capabilities = capabilities,
  )

  // MARK: - enrichedWith

  @Test
  fun `a field the item carries wins over the queue entry`() {
    val merged = item("a", title = "Queue title", artist = "Queue artist")
      .enrichedWith(item("a", title = "Item title", artist = "Item artist"))

    assertEquals("Item title", merged.title)
    assertEquals("Item artist", merged.artist)
  }

  @Test
  fun `a field the item omits falls back to the queue entry`() {
    val merged = item(
      "a",
      artist = "Queue artist",
      album = "Queue album",
      artworkUri = "queue.jpg",
      duration = 1000.0,
      genre = "Queue genre",
    ).enrichedWith(item("a", title = "Item title"))

    assertEquals("Queue artist", merged.artist)
    assertEquals("Queue album", merged.album)
    assertEquals("queue.jpg", merged.artworkUri)
    assertEquals(1000.0, requireNotNull(merged.duration), 0.0)
    assertEquals("Queue genre", merged.genre)
  }

  @Test
  fun `the duration the app learns late reaches a queue-backed entry`() {
    // The whole reason the merge exists: apps rarely know durations up front,
    // they learn them when the track is prepared and send them via setMediaItem.
    val merged = item("a").enrichedWith(item("a", duration = 240000.0))

    assertEquals(240000.0, requireNotNull(merged.duration), 0.0)
  }

  @Test
  fun `a blank item title is treated as absent, not as an erasure`() {
    // `title` is the one non-nullable field, so "absent" cannot be expressed as
    // null; a blank one would otherwise blank out a perfectly good queue title.
    assertEquals("Queue title", item("a", title = "Queue title").enrichedWith(item("a", title = "   ")).title)
    assertEquals("Queue title", item("a", title = "Queue title").enrichedWith(item("a", title = "")).title)
  }

  @Test
  fun `the queue entry's id stays authoritative`() {
    // Ids are equal by precondition; keeping the receiver's is what makes the
    // merged entry belong to the timeline it was taken from.
    assertEquals("a", item("a").enrichedWith(item("a", title = "Other")).id)
  }

  // MARK: - timeline

  @Test
  fun `only the current entry is enriched`() {
    val queue = listOf(item("a"), item("b"), item("c"))
    val state = snapshot(item = item("b", duration = 5000.0), queue = queue, queueIndex = 1)

    assertEquals(5000.0, requireNotNull(state.timeline[1].duration), 0.0)
    // setMediaItem says nothing about the other entries, so they are passed
    // through by reference rather than rebuilt.
    assertSame(queue[0], state.timeline[0])
    assertSame(queue[2], state.timeline[2])
    assertEquals(1, state.timelineIndex)
  }

  @Test
  fun `a mismatched item leaves the queue standing and is reported`() {
    val queue = listOf(item("a"), item("b"))
    val state = snapshot(item = item("z", duration = 5000.0), queue = queue, queueIndex = 1)

    assertSame(queue, state.timeline)
    assertNotNull(state.itemQueueMismatch)
    assertTrue(requireNotNull(state.itemQueueMismatch).contains("'z'"))
  }

  @Test
  fun `an item with no usable queue position is a one-entry timeline`() {
    val only = item("solo", duration = 1000.0)
    val state = snapshot(item = only, queue = emptyList(), queueIndex = -1)

    assertEquals(listOf(only), state.timeline)
    assertEquals(0, state.timelineIndex)
    // Nothing to merge into: the timeline *is* the item.
    assertNull(state.itemQueueMismatch)
  }

  @Test
  fun `an out-of-range queueIndex falls back to the item`() {
    val state = snapshot(item = item("solo"), queue = listOf(item("a")), queueIndex = 9)

    assertEquals(listOf(item("solo")), state.timeline)
  }

  @Test
  fun `nothing broadcast yet is an empty timeline`() {
    assertTrue(Snapshot.EMPTY.timeline.isEmpty())
    assertNull(Snapshot.EMPTY.itemQueueMismatch)
  }

  @Test
  fun `seekability comes from the capabilities, not from the controls`() {
    assertTrue(snapshot(capabilities = setOf(MediaCapability.SEEK)).isSeekable)
    assertTrue(!snapshot(capabilities = setOf(MediaCapability.PLAY)).isSeekable)
  }
}
