package com.rnmediamediasession

import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants
import androidx.media3.session.SessionError
import com.margelo.nitro.rnmediamediasession.BrowseErrorCode
import com.margelo.nitro.rnmediamediasession.BrowseMediaType
import com.margelo.nitro.rnmediamediasession.BrowseStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Everything about the car browse tree that is decided by data rather than by a
 * head unit.
 *
 * The three groups below are the three ways this feature can fail *plausibly*
 * — the ways that produce a working-looking app that does the wrong thing on
 * hardware the developer does not own:
 *
 * - a controller predicate that grants the play-from-browse command to the
 *   wrong caller (or to nobody, which is a tree whose every leaf is dead);
 * - a constant that maps a grid to a list, an "expired session" to "not
 *   supported", or a genre query to an artist one;
 * - the duplicate `play` media3 synthesises after a browse tap, which is
 *   inaudible in a unit test and very audible in a car.
 */
class CarBrowseTest {

  // MARK: - Who may play from the browse tree

  @Test
  fun `the two car packages may set a media item`() {
    assertTrue(CarControllers.carCommands(isAuto = true, isAutomotive = false, isTrusted = false))
    assertTrue(CarControllers.carCommands(isAuto = false, isAutomotive = true, isTrusted = false))
  }

  @Test
  fun `a trusted controller keeps the default it already had`() {
    assertTrue(CarControllers.carCommands(isAuto = false, isAutomotive = false, isTrusted = true))
  }

  @Test
  fun `an untrusted third-party controller may not`() {
    assertFalse(CarControllers.carCommands(isAuto = false, isAutomotive = false, isTrusted = false))
  }

  // MARK: - Which car is connected

  @Test
  fun `only the car packages count as a car connection`() {
    assertEquals(
      CarControllers.ANDROID_AUTO,
      CarControllers.carConnection(isAuto = true, isAutomotive = false),
    )
    assertEquals(
      CarControllers.AUTOMOTIVE_OS,
      CarControllers.carConnection(isAuto = false, isAutomotive = true),
    )
    // A trusted controller is not a car — this is what keeps a System UI bind
    // from booting the app (ARCHITECTURE §30).
    assertNull(CarControllers.carConnection(isAuto = false, isAutomotive = false))
  }

  @Test
  fun `the built-in car wins over the projected one`() {
    assertEquals(
      CarControllers.AUTOMOTIVE_OS,
      CarControllers.strongerConnection(CarControllers.ANDROID_AUTO, CarControllers.AUTOMOTIVE_OS),
    )
    assertEquals(
      CarControllers.ANDROID_AUTO,
      CarControllers.strongerConnection(CarControllers.NONE, CarControllers.ANDROID_AUTO),
    )
    assertEquals(
      CarControllers.NONE,
      CarControllers.strongerConnection(CarControllers.NONE, null),
    )
  }

  // MARK: - Voice focus

  @Test
  fun `each MediaStore focus type becomes its handler kind`() {
    assertEquals("artist", focus("vnd.android.cursor.item/artist").kind)
    assertEquals("album", focus("vnd.android.cursor.item/album").kind)
    assertEquals("title", focus("vnd.android.cursor.item/audio").kind)
    assertEquals("genre", focus("vnd.android.cursor.item/genre").kind)
    assertEquals("playlist", focus("vnd.android.cursor.item/playlist").kind)
  }

  @Test
  fun `an unclassified or absent focus is any, not an error`() {
    assertEquals("any", focus(null).kind)
    assertEquals("any", focus("vnd.android.cursor.item/video").kind)
  }

  @Test
  fun `the extras come through, and empty ones do not`() {
    val parsed = CarControllers.searchFocus(
      focus = "vnd.android.cursor.item/artist",
      artist = "Nina Simone",
      album = "",
      title = null,
      genre = "jazz",
      playlist = null,
    )

    assertEquals("Nina Simone", parsed.artist)
    assertEquals("jazz", parsed.genre)
    // An empty string is what a `Bundle` yields for "the key is there and says
    // nothing"; carrying it into JS would make `focus.album === ''` truthy-ish
    // noise the app has to filter itself.
    assertNull(parsed.album)
    assertNull(parsed.title)
  }

  private fun focus(kind: String?) =
    CarControllers.searchFocus(kind, null, null, null, null, null)

  // MARK: - Constants that produce plausible wrong behaviour

  @Test
  fun `content styles map to Android Auto's four values`() {
    assertEquals(1, BrowseTree.contentStyle(BrowseStyle.LIST))
    assertEquals(2, BrowseTree.contentStyle(BrowseStyle.GRID))
    assertEquals(3, BrowseTree.contentStyle(BrowseStyle.CATEGORYLIST))
    assertEquals(4, BrowseTree.contentStyle(BrowseStyle.CATEGORYGRID))
  }

  @Test
  fun `every media type maps onto a media3 constant, and none collide`() {
    val mapped = BrowseMediaType.entries.map { BrowseTree.mediaType(it) }
    assertEquals(BrowseMediaType.entries.size, mapped.toSet().size)
    assertEquals(MediaMetadata.MEDIA_TYPE_MIXED, BrowseTree.mediaType(BrowseMediaType.MIXED))
    assertEquals(MediaMetadata.MEDIA_TYPE_MUSIC, BrowseTree.mediaType(BrowseMediaType.MUSIC))
    assertEquals(
      MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS,
      BrowseTree.mediaType(BrowseMediaType.FOLDERALBUMS),
    )
    assertEquals(
      MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER,
      BrowseTree.mediaType(BrowseMediaType.AUDIOBOOKCHAPTER),
    )
  }

  @Test
  fun `each browse error maps onto its own SessionError code`() {
    assertEquals(
      SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED,
      BrowseTree.errorCode(BrowseErrorCode.AUTHENTICATIONEXPIRED),
    )
    assertEquals(
      SessionError.ERROR_SESSION_PREMIUM_ACCOUNT_REQUIRED,
      BrowseTree.errorCode(BrowseErrorCode.PREMIUMACCOUNTREQUIRED),
    )
    assertEquals(
      SessionError.ERROR_SESSION_NOT_AVAILABLE_IN_REGION,
      BrowseTree.errorCode(BrowseErrorCode.NOTAVAILABLEINREGION),
    )
    assertEquals(
      SessionError.ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED,
      BrowseTree.errorCode(BrowseErrorCode.PARENTALCONTROLRESTRICTED),
    )
    assertEquals(
      SessionError.ERROR_NOT_SUPPORTED,
      BrowseTree.errorCode(BrowseErrorCode.NOTSUPPORTED),
    )
    assertEquals(
      BrowseErrorCode.entries.size,
      BrowseErrorCode.entries.map { BrowseTree.errorCode(it) }.toSet().size,
    )
  }

  @Test
  fun `completion collapses to Auto's three statuses`() {
    assertEquals(
      MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED,
      BrowseTree.completionStatus(0.0),
    )
    assertEquals(
      MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED,
      BrowseTree.completionStatus(0.4),
    )
    assertEquals(
      MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED,
      BrowseTree.completionStatus(1.0),
    )
  }

  @Test
  fun `only http artwork is rewritten`() {
    assertTrue(BrowseTree.isHttp("https://example.test/a.jpg"))
    assertTrue(BrowseTree.isHttp("HTTP://example.test/a.jpg"))
    assertFalse(BrowseTree.isHttp("content://media/1"))
    assertFalse(BrowseTree.isHttp("file:///sdcard/a.jpg"))
    assertFalse(BrowseTree.isHttp("android.resource://com.example/drawable/a"))
  }

  @Test
  fun `the artwork hash is stable, per URL, and hex`() {
    val a = ArtworkRegistry.sha256("https://example.test/a.jpg")
    val b = ArtworkRegistry.sha256("https://example.test/b.jpg")

    assertEquals(a, ArtworkRegistry.sha256("https://example.test/a.jpg"))
    assertEquals(64, a.length)
    assertTrue(a.matches(Regex("^[0-9a-f]{64}$")))
    assertFalse(a == b)
  }

  // MARK: - The duplicate play after a browse tap

  @Test
  fun `the play media3 synthesises after a media request is swallowed once`() {
    val turns = ArrayDeque<() -> Unit>()
    val latch = MediaRequestLatch { turns.addLast(it) }

    latch.arm()
    assertTrue("the synthesised play is swallowed", latch.consume())
    assertFalse("a second play in the same turn is the user's", latch.consume())
  }

  @Test
  fun `an unconsumed latch does not survive the turn`() {
    val turns = ArrayDeque<() -> Unit>()
    val latch = MediaRequestLatch { turns.addLast(it) }

    // A media request that never reached `play` — a prepare-only controller.
    latch.arm()
    turns.removeFirst().invoke()

    assertFalse("a later play must reach the app", latch.consume())
  }

  @Test
  fun `arming twice in one turn schedules one disarm`() {
    val turns = ArrayDeque<() -> Unit>()
    val latch = MediaRequestLatch { turns.addLast(it) }

    latch.arm()
    latch.arm()

    assertEquals(1, turns.size)
    assertTrue(latch.consume())
  }
}
