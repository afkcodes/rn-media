package com.rnmediamediasession

import com.margelo.nitro.rnmediamediasession.AndroidMediaSessionConfig
import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaControl
import com.margelo.nitro.rnmediamediasession.MediaCustomAction
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The resumption record parser, off-device.
 *
 * This is the one piece of this package that runs **before any JavaScript
 * exists in the process** and is fed bytes that crossed a process death, so
 * every branch of it is a "what happens when the input is wrong" branch. On a
 * device only the happy path is reachable — the malformed inputs would have to
 * be written by a version of the TS layer that does not exist yet — which is
 * exactly why they belong here.
 *
 * ## The storage keys are written out literally, on purpose
 * `KEY_SESSION`/`KEY_CONFIG` stay private and the tests spell the strings
 * instead of importing them. A test that reads the constant agrees with any
 * rename; these fail on one, which is the correct answer, because the name is a
 * compatibility contract with every already-installed copy of the app.
 */
class ResumptionStoreTest {

  private companion object {
    const val KEY_SESSION = "resumption.session.v1"
    const val KEY_CONFIG = "resumption.config.v1"

    /**
     * A complete record in the shape `persistence.ts` serializes
     * (`PersistedRecord` → `withPersistence`'s `serialize()`), already frozen
     * paused at write time the way the TS side leaves it.
     */
    val FULL_RECORD = """
      {
        "v": 1,
        "savedAt": 1770000000000,
        "playbackState": {
          "status": "paused",
          "position": { "value": 36033, "at": 1770000000000, "rate": 0 },
          "controls": ["play", "pause", "skipToNext"],
          "capabilities": ["play", "pause", "seek", "skipToNext"],
          "customActions": [{ "name": "like", "title": "Like", "icon": "ic_like" }],
          "compactControlIndices": [0, 1, 2],
          "queueIndex": 1
        },
        "mediaItem": {
          "id": "track-2",
          "title": "Second",
          "artist": "Artist",
          "album": "Album",
          "artworkUri": "https://example.test/2.jpg",
          "duration": 240000,
          "genre": "Ambient"
        },
        "queue": [
          { "id": "track-1", "title": "First" },
          { "id": "track-2", "title": "Second", "duration": 240000 }
        ]
      }
    """.trimIndent()
  }

  private fun readSession(json: String?) =
    ResumptionStore.readSession(
      FakeContext(if (json == null) emptyMap() else mapOf(KEY_SESSION to json))
    )

  private fun readConfig(json: String?) =
    ResumptionStore.readConfig(
      FakeContext(if (json == null) emptyMap() else mapOf(KEY_CONFIG to json))
    )

  // MARK: - Round trip

  @Test
  fun `parses every field of a complete record`() {
    val snapshot = requireNotNull(readSession(FULL_RECORD))

    assertEquals(36033L, snapshot.anchor.valueMs)
    assertEquals(1, snapshot.queueIndex)
    assertEquals(
      listOf(MediaControl.PLAY, MediaControl.PAUSE, MediaControl.SKIPTONEXT),
      snapshot.controls,
    )
    assertEquals(
      setOf(
        MediaCapability.PLAY,
        MediaCapability.PAUSE,
        MediaCapability.SEEK,
        MediaCapability.SKIPTONEXT,
      ),
      snapshot.capabilities,
    )
    assertEquals(listOf(MediaCustomAction("like", "Like", "ic_like")), snapshot.customActions)
    assertEquals(listOf(0, 1, 2), snapshot.compactControlIndices)
    assertEquals(listOf("track-1", "track-2"), snapshot.queue.map { it.id })

    val item = requireNotNull(snapshot.item)
    assertEquals("track-2", item.id)
    assertEquals("Second", item.title)
    assertEquals("Artist", item.artist)
    assertEquals("Album", item.album)
    assertEquals("https://example.test/2.jpg", item.artworkUri)
    assertEquals(240000.0, requireNotNull(item.duration), 0.0)
    assertEquals("Ambient", item.genre)
  }

  @Test
  fun `the timeline the facade will serve is the enriched queue`() {
    val snapshot = requireNotNull(readSession(FULL_RECORD))

    // The record's `mediaItem` carries the artwork the queue entry lacks, and
    // the ids match, so the current entry is merged — the same channel-priority
    // rule a live broadcast follows (ARCHITECTURE §10).
    assertNull(snapshot.itemQueueMismatch)
    assertEquals("https://example.test/2.jpg", snapshot.timeline[1].artworkUri)
    assertNull(snapshot.timeline[0].artworkUri)
  }

  // MARK: - The seeding rule

  @Test
  fun `a paused record is seeded stopped, never paused`() {
    // `paused` maps to STATE_READY, and media3 shows a notification for any
    // session that is not STATE_IDLE — which would put one on screen the moment
    // the System UI merely binds to look at its resumption card.
    assertEquals(MediaPlaybackStatus.STOPPED, requireNotNull(readSession(FULL_RECORD)).status)
  }

  @Test
  fun `a record that somehow says playing is still seeded stopped`() {
    val playing = FULL_RECORD.replace("\"status\": \"paused\"", "\"status\": \"playing\"")

    assertEquals(MediaPlaybackStatus.STOPPED, requireNotNull(readSession(playing)).status)
  }

  @Test
  fun `the anchor is frozen, so the position cannot project forward`() {
    val snapshot = requireNotNull(readSession(FULL_RECORD))

    assertEquals(0f, snapshot.anchor.rate, 0f)
    // Asserted against the projection rather than the origin: the origin is
    // this process's `elapsedRealtime`, and what matters is that no amount of
    // elapsed time moves the position.
    assertEquals(36033L, snapshot.anchor.projectMs(now = 999_999L))
    assertEquals(1f, snapshot.speed, 0f)
  }

  @Test
  fun `a negative persisted position is clamped to zero`() {
    val negative = FULL_RECORD.replace("\"value\": 36033", "\"value\": -5000")

    assertEquals(0L, requireNotNull(readSession(negative)).anchor.valueMs)
  }

  // MARK: - Nothing to resume

  @Test
  fun `no stored record at all`() {
    assertNull(readSession(null))
  }

  @Test
  fun `the clearPersisted tombstone is not a resumption`() {
    // What `clearPersisted` writes: current version, no channels.
    assertNull(readSession("""{ "v": 1, "savedAt": 1770000000000 }"""))
  }

  @Test
  fun `a record with an empty queue and no item is not a resumption`() {
    assertNull(readSession("""{ "v": 1, "savedAt": 1, "queue": [] }"""))
  }

  @Test
  fun `a storage engine that throws degrades to no resumption`() {
    assertNull(ResumptionStore.readSession(FakeContext(failing = true)))
    assertNull(ResumptionStore.readConfig(FakeContext(failing = true)))
  }

  // MARK: - Malformed payloads

  @Test
  fun `a truncated payload is ignored`() {
    assertNull(readSession(FULL_RECORD.substring(0, FULL_RECORD.length / 2)))
  }

  @Test
  fun `a payload that is not JSON at all is ignored`() {
    assertNull(readSession("not json"))
    assertNull(readSession(""))
  }

  @Test
  fun `a payload that is a JSON array is ignored`() {
    assertNull(readSession("""[{ "v": 1 }]"""))
  }

  @Test
  fun `a future schema version is ignored`() {
    assertNull(readSession(FULL_RECORD.replace("\"v\": 1", "\"v\": 2")))
  }

  @Test
  fun `a missing schema version is ignored`() {
    assertNull(readSession(FULL_RECORD.replace("\"v\": 1,", "")))
  }

  @Test
  fun `a non-numeric schema version is ignored`() {
    assertNull(readSession(FULL_RECORD.replace("\"v\": 1", "\"v\": \"one\"")))
  }

  @Test
  fun `an item missing its required fields is dropped`() {
    // `id` and `title` are the two non-nullable fields of `NativeMediaItem`;
    // there is no honest value to invent for either.
    assertNull(readSession("""{ "v": 1, "mediaItem": { "title": "No id" } }"""))
    assertNull(readSession("""{ "v": 1, "mediaItem": { "id": "no-title" } }"""))
  }

  @Test
  fun `unusable queue entries are dropped without losing the usable ones`() {
    val snapshot = requireNotNull(
      readSession(
        """
        {
          "v": 1,
          "queue": [
            { "id": "ok-1", "title": "Fine" },
            null,
            "a string",
            { "title": "no id" },
            { "id": "ok-2", "title": "Also fine" }
          ]
        }
        """.trimIndent()
      )
    )

    assertEquals(listOf("ok-1", "ok-2"), snapshot.queue.map { it.id })
  }

  @Test
  fun `a type mismatch in an optional field reads as absent`() {
    val snapshot = requireNotNull(
      readSession(
        """
        {
          "v": 1,
          "mediaItem": {
            "id": "t", "title": "T",
            "duration": "not a number",
            "artist": null,
            "artworkUri": ""
          }
        }
        """.trimIndent()
      )
    )

    val item = requireNotNull(snapshot.item)
    assertNull(item.duration)
    assertNull(item.artist)
    // An empty string is not a URI; treating it as absent keeps the artwork
    // loader from being handed something it can only fail on.
    assertNull(item.artworkUri)
  }

  @Test
  fun `a non-numeric position reads as zero rather than NaN`() {
    val snapshot = requireNotNull(
      readSession(
        """
        {
          "v": 1,
          "mediaItem": { "id": "t", "title": "T" },
          "playbackState": { "position": { "value": "somewhere" } }
        }
        """.trimIndent()
      )
    )

    assertEquals(0L, snapshot.anchor.valueMs)
  }

  @Test
  fun `a record with no playbackState still resumes the metadata`() {
    val snapshot = requireNotNull(
      readSession("""{ "v": 1, "mediaItem": { "id": "t", "title": "T" } }""")
    )

    assertEquals(0L, snapshot.anchor.valueMs)
    assertEquals(-1, snapshot.queueIndex)
    assertTrue(snapshot.controls.isEmpty())
    assertTrue(snapshot.capabilities.isEmpty())
    assertTrue(snapshot.customActions.isEmpty())
    assertTrue(snapshot.compactControlIndices.isEmpty())
  }

  @Test
  fun `a queueIndex outside the queue is discarded`() {
    val outOfRange = FULL_RECORD.replace("\"queueIndex\": 1", "\"queueIndex\": 7")

    assertEquals(-1, requireNotNull(readSession(outOfRange)).queueIndex)
  }

  @Test
  fun `unknown control and capability names are dropped, known ones survive`() {
    // The union is a TS type; a record written by a newer app can legitimately
    // carry a name this build has never heard of. Dropping it is the only
    // non-lossy option available (there is nothing to map it to) and must not
    // take the rest of the record with it.
    val snapshot = requireNotNull(
      readSession(
        """
        {
          "v": 1,
          "mediaItem": { "id": "t", "title": "T" },
          "playbackState": {
            "position": { "value": 0 },
            "controls": ["play", "teleport", "", "skipToPrevious"],
            "capabilities": ["seek", "timeTravel"]
          }
        }
        """.trimIndent()
      )
    )

    assertEquals(listOf(MediaControl.PLAY, MediaControl.SKIPTOPREVIOUS), snapshot.controls)
    assertEquals(setOf(MediaCapability.SEEK), snapshot.capabilities)
  }

  @Test
  fun `a custom action missing a name or title is dropped`() {
    val snapshot = requireNotNull(
      readSession(
        """
        {
          "v": 1,
          "mediaItem": { "id": "t", "title": "T" },
          "playbackState": {
            "position": { "value": 0 },
            "customActions": [
              { "title": "No name" },
              { "name": "no-title" },
              { "name": "keep", "title": "Keep" }
            ]
          }
        }
        """.trimIndent()
      )
    )

    assertEquals(listOf(MediaCustomAction("keep", "Keep", null)), snapshot.customActions)
  }

  // MARK: - Config mirror

  @Test
  fun `the config mirror survives an encode-decode round trip`() {
    val config = AndroidMediaSessionConfig(
      notificationChannelId = "playback",
      notificationChannelName = "Playback",
      notificationIcon = "ic_notification",
      stopForegroundOnPause = false,
      stopForegroundTimeoutMs = 15000.0,
      playbackResumption = true,
    )

    val decoded = requireNotNull(readConfig(ResumptionStore.encodeConfig(config)))

    assertEquals("playback", decoded.notificationChannelId)
    assertEquals("Playback", decoded.notificationChannelName)
    assertEquals("ic_notification", decoded.notificationIcon)
    assertEquals(false, decoded.stopForegroundOnPause)
    assertEquals(15000.0, requireNotNull(decoded.stopForegroundTimeoutMs), 0.0)
    assertEquals(true, decoded.playbackResumption)
  }

  @Test
  fun `optional config fields round trip as absent`() {
    val config = AndroidMediaSessionConfig(
      notificationChannelId = "playback",
      notificationChannelName = "Playback",
      notificationIcon = null,
      stopForegroundOnPause = true,
      stopForegroundTimeoutMs = null,
      playbackResumption = false,
    )

    val decoded = requireNotNull(readConfig(ResumptionStore.encodeConfig(config)))

    assertNull(decoded.notificationIcon)
    assertNull(decoded.stopForegroundTimeoutMs)
    assertEquals(true, decoded.stopForegroundOnPause)
    assertEquals(false, decoded.playbackResumption)
  }

  @Test
  fun `a config with no channel is unusable`() {
    // A notification channel is not optional on any API level this package
    // supports, and inventing one would put the notification somewhere the user
    // cannot find in settings.
    assertNull(readConfig("""{ "channelName": "Playback" }"""))
    assertNull(readConfig("""{ "channelId": "playback" }"""))
    assertNull(readConfig("""{ "channelId": "", "channelName": "Playback" }"""))
  }

  @Test
  fun `an unreadable config is ignored`() {
    assertNull(readConfig(null))
    assertNull(readConfig("not json"))
    assertNull(readConfig("[]"))
  }

  @Test
  fun `config defaults match the ones a live initialize would carry`() {
    val decoded = requireNotNull(
      readConfig("""{ "channelId": "playback", "channelName": "Playback" }""")
    )

    // `stopForegroundOnPause` defaults on, `playbackResumption` defaults off —
    // resumption starts a foreground service in a process the user did not
    // open, so a config that predates the flag must never turn it on.
    assertEquals(true, decoded.stopForegroundOnPause)
    assertEquals(false, decoded.playbackResumption)
    assertNull(decoded.stopForegroundTimeoutMs)
  }
}
