package com.rnmediamediasession

import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    albumArtist: String? = null,
    trackNumber: Double? = null,
    discNumber: Double? = null,
    year: Double? = null,
    subtitle: String? = null,
    isLive: Boolean? = null,
    extras: Map<String, String>? = null,
  ) = NativeMediaItem(
    id,
    title,
    artist,
    album,
    artworkUri,
    duration,
    genre,
    albumArtist,
    trackNumber,
    discNumber,
    year,
    subtitle,
    isLive,
    extras,
  )

  private fun snapshot(
    item: NativeMediaItem? = null,
    queue: List<NativeMediaItem> = emptyList(),
    queueIndex: Int = -1,
    capabilities: Set<MediaCapability> = emptySet(),
    anchor: Anchor = Anchor(valueMs = 0L, originMs = 0L, rate = 0f),
  ) = Snapshot.EMPTY.copy(
    status = MediaPlaybackStatus.PAUSED,
    item = item,
    queue = queue,
    queueIndex = queueIndex,
    capabilities = capabilities,
    anchor = anchor,
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

  /**
   * A queue plus a `queueIndex` and **no** `setMediaItem` is a complete
   * statement: the entry at that index is what the surfaces show.
   *
   * Pinned as a cross-platform contract rather than as an Android detail. iOS
   * used to publish the `setMediaItem` channel and nothing else, so this exact
   * broadcast — which is what `QueueHandler` produces before a track is prepared
   * — left the lock screen blank there while Android showed the entry.
   * `NowPlaying.resolve` is now the twin of this, so the two implementations
   * have to agree about which item is current, and this is the case that says so.
   */
  @Test
  fun `a queue with no setMediaItem still names a current item`() {
    val queue = listOf(item("a", title = "First"), item("b", title = "Second"))
    val state = snapshot(item = null, queue = queue, queueIndex = 1)

    assertSame(queue, state.timeline)
    assertEquals(1, state.timelineIndex)
    assertEquals("Second", state.currentItem?.title)
    assertNull(state.itemQueueMismatch)
  }

  /** …and with no index either, the head of the queue is the honest answer. */
  @Test
  fun `a queue with no index and no item falls back to its first entry`() {
    val queue = listOf(item("a", title = "First"), item("b"))
    val state = snapshot(item = null, queue = queue, queueIndex = -1)

    assertEquals(0, state.timelineIndex)
    assertEquals("First", state.currentItem?.title)
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

  // MARK: - Extended tags (B4)

  @Test
  fun `every extended tag follows the same item-wins, queue-falls-back rule`() {
    val queueEntry = item(
      "a",
      albumArtist = "Queue album artist",
      trackNumber = 1.0,
      discNumber = 1.0,
      year = 1997.0,
      subtitle = "Queue subtitle",
      isLive = false,
      extras = mapOf("source" to "queue"),
    )
    val merged = queueEntry.enrichedWith(
      item("a", trackNumber = 7.0, subtitle = "Item subtitle", extras = mapOf("source" to "item"))
    )

    // Carried by the item → the item wins.
    assertEquals(7.0, requireNotNull(merged.trackNumber), 0.0)
    assertEquals("Item subtitle", merged.subtitle)
    assertEquals(mapOf("source" to "item"), merged.extras)
    // Omitted by the item → the queue entry stands.
    assertEquals("Queue album artist", merged.albumArtist)
    assertEquals(1.0, requireNotNull(merged.discNumber), 0.0)
    assertEquals(1997.0, requireNotNull(merged.year), 0.0)
    assertEquals(false, merged.isLive)
  }

  @Test
  fun `extras are replaced wholesale, never merged key by key`() {
    val merged = item("a", extras = mapOf("a" to "1", "b" to "2"))
      .enrichedWith(item("a", extras = mapOf("c" to "3")))

    // Half of an old payload mixed with half of a new one is a value the app
    // never wrote.
    assertEquals(mapOf("c" to "3"), merged.extras)
  }

  @Test
  fun `isLive drops the duration even when one was also broadcast`() {
    // `isLive` is the explicit statement; before it, "no duration" was the only
    // way to say live, which conflated it with "I don't know it yet". A null
    // effective duration is what drives `isDynamic`, un-seekability and the
    // end-of-track timer, so all three follow from this one property.
    assertNull(item("radio", duration = 600_000.0, isLive = true).effectiveDurationMs)
    assertEquals(600_000L, item("track", duration = 600_000.0).effectiveDurationMs)
    assertEquals(600_000L, item("track", duration = 600_000.0, isLive = false).effectiveDurationMs)
    assertNull(item("unknown").effectiveDurationMs)
  }

  @Test
  fun `one live entry does not un-seek the rest of the queue`() {
    // Seekability is decided per entry from that entry's own effective
    // duration; the snapshot-wide flag stays purely a capability question.
    val state = snapshot(
      queue = listOf(item("radio", duration = 1000.0, isLive = true), item("track", duration = 1000.0)),
      queueIndex = 0,
      capabilities = setOf(MediaCapability.SEEK),
    )

    assertTrue(state.isSeekable)
    assertNull(state.queue[0].effectiveDurationMs)
    assertEquals(1000L, state.queue[1].effectiveDurationMs)
  }

  // MARK: - End-of-track sleep timer arithmetic (B5)

  private fun playing(item: NativeMediaItem, positionMs: Long, rate: Float) = snapshot(
    item = item,
    anchor = Anchor(valueMs = positionMs, originMs = 0L, rate = rate),
  )

  @Test
  fun `the track-end deadline is the remaining time at normal speed`() {
    val state = playing(item("a", duration = 200_000.0), positionMs = 50_000L, rate = 1f)

    assertEquals(150_000L, state.trackEndDelayMs(now = 0L))
  }

  @Test
  fun `the track-end deadline shrinks with the playback rate`() {
    // A minute of audio arrives in thirty seconds at 2x; a timer that ignores
    // the rate fires a minute late.
    val state = playing(item("a", duration = 200_000.0), positionMs = 50_000L, rate = 2f)

    assertEquals(75_000L, state.trackEndDelayMs(now = 0L))
  }

  @Test
  fun `the track-end deadline accounts for time elapsed since the anchor`() {
    val state = playing(item("a", duration = 200_000.0), positionMs = 50_000L, rate = 1f)

    assertEquals(140_000L, state.trackEndDelayMs(now = 10_000L))
  }

  @Test
  fun `a projection past the end is due now, never negative`() {
    val state = playing(item("a", duration = 100_000.0), positionMs = 99_000L, rate = 1f)

    assertEquals(0L, state.trackEndDelayMs(now = 60_000L))
  }

  @Test
  fun `there is no computable deadline without a duration, when live, or when paused`() {
    // Each is "armed, waiting for the item to change" — not "fire now", and not
    // "disarmed". `null` is how that is said.
    assertNull(playing(item("a"), positionMs = 0L, rate = 1f).trackEndDelayMs(0L))
    assertNull(
      playing(item("a", duration = 100_000.0, isLive = true), 0L, 1f).trackEndDelayMs(0L)
    )
    assertNull(playing(item("a", duration = 100_000.0), positionMs = 0L, rate = 0f).trackEndDelayMs(0L))
    assertNull(Snapshot.EMPTY.trackEndDelayMs(0L))
  }

  @Test
  fun `the deadline is taken from the ENRICHED current entry`() {
    // The duration usually arrives on the setMediaItem channel while the
    // timeline comes from the queue; reading the un-merged queue entry would
    // make every queue-backed track look like it had no end.
    val state = snapshot(
      item = item("b", duration = 120_000.0),
      queue = listOf(item("a"), item("b"), item("c")),
      queueIndex = 1,
      anchor = Anchor(valueMs = 20_000L, originMs = 0L, rate = 1f),
    )

    assertEquals(100_000L, state.trackEndDelayMs(now = 0L))
  }

  // MARK: - wantsForeground

  @Test
  fun `only playing and buffering want a foreground service`() {
    // The predicate two pieces of code have to agree on, because a
    // disagreement is a process kill (ARCHITECTURE §30):
    // `MediaSessionController.setPlaybackState` decides whether a broadcast may
    // `startForegroundService()` with it, and the service's `onStartCommand`
    // decides with it whether to keep that promise by posting the real media
    // notification or by promoting and demoting in silence. It is also media3's
    // own `isAnySessionUserEngaged` (`playWhenReady && (STATE_READY ||
    // STATE_BUFFERING)`) restated over the app's broadcasts — see
    // `BroadcastPlayer.getState`, which maps exactly these two onto that pair.
    assertTrue(Snapshot.EMPTY.copy(status = MediaPlaybackStatus.PLAYING).wantsForeground)
    assertTrue(Snapshot.EMPTY.copy(status = MediaPlaybackStatus.BUFFERING).wantsForeground)
    assertFalse(Snapshot.EMPTY.copy(status = MediaPlaybackStatus.PAUSED).wantsForeground)
    assertFalse(Snapshot.EMPTY.copy(status = MediaPlaybackStatus.STOPPED).wantsForeground)
    assertFalse(Snapshot.EMPTY.copy(status = MediaPlaybackStatus.ERROR).wantsForeground)
    // The seed a playback resumption starts from is deliberately `stopped`, so
    // the revival path cannot rely on this predicate and promotes by itself.
    assertFalse(Snapshot.EMPTY.wantsForeground)
  }

  // MARK: - End-of-track latch policy

  @Test
  fun `the ordinary case is to keep waiting on the same item`() {
    // Every broadcast of a track playing out lands here: same item, new
    // position/duration/rate, so only the deadline moves.
    assertEquals(TrackEndAction.Wait(latchTo = null), trackEndAction("0:a", "0:a"))
  }

  @Test
  fun `arming over silence latches onto the first item to appear`() {
    // A null latch means "armed, nothing latched yet". It must not be read as
    // "the item changed from nothing to something" — that would fire the timer
    // the moment playback started.
    assertEquals(TrackEndAction.Wait(latchTo = "0:a"), trackEndAction(null, "0:a"))
    assertEquals(TrackEndAction.Wait(latchTo = null), trackEndAction(null, null))
  }

  @Test
  fun `the item going away fires the timer`() {
    // Advanced, skipped, or the media item was cleared — "after this one" has
    // happened either way, and this is what makes the feature work on a live
    // stream or a track whose duration never arrived.
    assertEquals(TrackEndAction.Fire, trackEndAction("0:a", "1:b"))
    assertEquals(TrackEndAction.Fire, trackEndAction("0:a", null))
  }

  @Test
  fun `a repeated id at a different index is a different item`() {
    assertEquals(TrackEndAction.Fire, trackEndAction("0:a", "1:a"))
    assertEquals(TrackEndAction.Wait(latchTo = null), trackEndAction("1:a", "1:a"))
  }

  @Test
  fun `a cleared latch cannot fire a re-armed timer instantly (regression)`() {
    // THE DEFECT. The latch used to be a key plus a `latched` boolean, reset
    // only in `stop()`. After a timer fired, `latched` stayed true with a stale
    // key: the next `setSleepTimerToTrackEnd` marks the mode armed synchronously
    // on the JS thread while the re-latch is only posted, so a broadcast block
    // already queued on the main looper ran in between, compared the *current*
    // item against an item from the previous session, decided "the item changed"
    // and paused playback at the instant of arming.
    //
    // One nullable field cannot be half-reset, and clearing it is now what every
    // exit from track-end mode does (fire, cancel, a countdown replacing it,
    // stop). A cleared latch re-latches; it never fires.
    val afterReset: String? = null

    assertEquals(TrackEndAction.Wait(latchTo = "3:b"), trackEndAction(afterReset, "3:b"))
  }

  @Test
  fun `the armed-item key distinguishes a repeated id at a different index`() {
    // Ids legitimately repeat in a queue, and an index alone moves under a queue
    // edit that did not change what is playing. The pair changes exactly when
    // the thing playing changes.
    val queue = listOf(item("a"), item("a"))
    assertEquals("0:a", snapshot(queue = queue, queueIndex = 0).currentItemKey)
    assertEquals("1:a", snapshot(queue = queue, queueIndex = 1).currentItemKey)
    assertNull(Snapshot.EMPTY.currentItemKey)
  }
}
