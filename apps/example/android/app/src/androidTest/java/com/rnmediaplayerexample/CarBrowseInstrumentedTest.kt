package com.rnmediaplayerexample

import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaBrowser
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.SessionError
import androidx.media3.session.SessionToken
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The browse tree, driven by a **real `MediaBrowser`** on a real device.
 *
 * This is the closest thing to Android Auto that can be asserted on. Auto is a
 * legacy `MediaBrowserCompat` client whose taps arrive as
 * `onGetLibraryRoot` → `onGetChildren` → `onSetMediaItems`; a media3
 * `MediaBrowser` walks the same session callbacks over the same binder, and
 * unlike the Desktop Head Unit it produces values instead of pixels.
 *
 * It runs against the **whole stack**: the Activity is launched so React Native
 * boots and `MediaService.init` installs the app's handler, and every
 * assertion below is therefore an answer that came out of JavaScript, crossed
 * Nitro, was converted by `BrowseTree` and came back through media3.
 *
 * Requires Metro (it is a debug build):
 *   adb reverse tcp:8081 tcp:8081 && npm start
 *   ./gradlew :app:connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class CarBrowseInstrumentedTest {

  private fun <T> ListenableFuture<T>.await(seconds: Long = 20): T =
    get(seconds, TimeUnit.SECONDS)

  /**
   * Run on the application thread and wait.
   *
   * `MediaBrowser` is thread-confined — *"MediaController method is called from
   * a wrong thread"* is a hard `IllegalStateException`, not a warning — so
   * every call that touches the browser is issued here while the *awaiting*
   * happens on the instrumentation thread. Awaiting on the main thread instead
   * would deadlock: the future can only be completed by the very looper that
   * would be blocked.
   */
  private fun <T> onMain(block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val latch = CountDownLatch(1)
    var value: Result<T> = Result.failure(IllegalStateException("never ran"))
    Handler(Looper.getMainLooper()).post {
      value = runCatching(block)
      latch.countDown()
    }
    check(latch.await(20, TimeUnit.SECONDS)) { "the application thread did not answer" }
    return value.getOrThrow()
  }

  private fun browser(): MediaBrowser = onMain {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val token = SessionToken(
      context,
      ComponentName(context, "com.rnmediamediasession.RnMediaMediaSessionService"),
    )
    MediaBrowser.Builder(context, token).buildAsync()
  }.await()

  /** One browser call: issued on the application thread, awaited off it. */
  private fun <T> MediaBrowser.call(block: MediaBrowser.() -> ListenableFuture<T>): T =
    onMain { block() }.await()

  private fun <T> withBrowser(block: (MediaBrowser) -> T): T {
    val browser = browser()
    return try {
      block(browser)
    } finally {
      onMain { browser.release() }
    }
  }

  @Test
  fun root_is_the_package_root_and_is_browsable() = withBrowser { browser ->
    val result: LibraryResult<MediaItem> = browser.call { getLibraryRoot(null) }

    assertEquals(LibraryResult.RESULT_SUCCESS, result.resultCode)
    val root = result.value!!
    assertEquals("rn-media-root", root.mediaId)
    assertEquals(true, root.mediaMetadata.isBrowsable)
    assertEquals(false, root.mediaMetadata.isPlayable)
  }

  @Test
  fun root_children_are_the_four_tabs_from_javascript() = withBrowser { browser ->
    val children = browser.call { getChildren("rn-media-root", 0, Int.MAX_VALUE, null) }

    assertEquals(LibraryResult.RESULT_SUCCESS, children.resultCode)
    val ids = children.value!!.map { it.mediaId }
    assertEquals(listOf("library", "albums", "artists", "recent"), ids)
    // The cap the car imposes: four, and every one of them browsable.
    assertTrue(children.value!!.all { it.mediaMetadata.isBrowsable == true })
  }

  @Test
  fun drilling_into_a_tab_returns_playable_tracks_with_content_uri_artwork() =
    withBrowser { browser ->
      val library = browser.call { getChildren("library", 0, Int.MAX_VALUE, null) }

      assertEquals(LibraryResult.RESULT_SUCCESS, library.resultCode)
      val tracks = library.value!!
      assertTrue("expected the demo queue", tracks.size >= 8)
      assertTrue(tracks.all { it.mediaMetadata.isPlayable == true })
      assertTrue(tracks.all { it.mediaId.startsWith("track:") })

      // The artwork rule Android Auto imposes: `content://` only. The app hands
      // the library https URLs; this asserts the rewrite happened.
      val artwork = tracks.mapNotNull { it.mediaMetadata.artworkUri }
      assertTrue("some demo tracks have covers", artwork.isNotEmpty())
      assertTrue(
        "browse artwork must be content://, got $artwork",
        artwork.all { it.scheme == "content" },
      )
      assertTrue(artwork.all { it.authority == "com.rnmediaplayerexample.rnmedia.artwork" })
    }

  @Test
  fun the_artwork_provider_serves_the_bytes_it_advertised() = withBrowser { browser ->
    val tracks = browser.call { getChildren("library", 0, Int.MAX_VALUE, null) }.value!!
    val uri = tracks.firstNotNullOf { it.mediaMetadata.artworkUri }
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    val bytes = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }

    assertTrue("expected a decodable JPEG, got ${bytes.size} bytes", bytes.size > 1000)
    // JPEG SOI.
    assertEquals(0xFF.toByte(), bytes[0])
    assertEquals(0xD8.toByte(), bytes[1])
  }

  @Test
  fun an_unregistered_artwork_id_is_not_served() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val fake = android.net.Uri.parse(
      "content://com.rnmediaplayerexample.rnmedia.artwork/" + "a".repeat(64)
    )

    val opened = runCatching { context.contentResolver.openInputStream(fake) }

    assertTrue(
      "the provider must serve only what the browse tree registered",
      opened.isFailure || opened.getOrNull() == null,
    )
  }

  @Test
  fun paging_is_honoured_rather_than_crashing_the_session() = withBrowser { browser ->
    // media3 throws IllegalStateException on the session's own thread when a
    // result is larger than the requested page, so this is the regression
    // test for a crash, not for a nicety.
    val firstPage = browser.call { getChildren("library", 0, 3, null) }
    val secondPage = browser.call { getChildren("library", 1, 3, null) }

    assertEquals(LibraryResult.RESULT_SUCCESS, firstPage.resultCode)
    assertEquals(3, firstPage.value!!.size)
    assertEquals(3, secondPage.value!!.size)
    assertTrue(firstPage.value!![0].mediaId != secondPage.value!![0].mediaId)
  }

  @Test
  fun getItem_answers_one_node_by_id() = withBrowser { browser ->
    val track = browser.call { getChildren("library", 0, 1, null) }.value!!.single()

    val item = browser.call { getItem(track.mediaId) }

    assertEquals(LibraryResult.RESULT_SUCCESS, item.resultCode)
    assertEquals(track.mediaId, item.value!!.mediaId)
    assertNotNull(item.value!!.mediaMetadata.title)
  }

  @Test
  fun search_round_trips_through_the_app_handler() = withBrowser { browser ->
    val search = browser.call { search("diverse", null) }
    assertEquals(LibraryResult.RESULT_SUCCESS, search.resultCode)

    val results = browser.call { getSearchResult("diverse", 0, Int.MAX_VALUE, null) }

    assertEquals(LibraryResult.RESULT_SUCCESS, results.resultCode)
    assertTrue("expected a match for 'diverse'", results.value!!.isNotEmpty())
    assertTrue(
      results.value!!.all {
        it.mediaMetadata.title.toString().contains("Diverse", ignoreCase = true)
      }
    )
  }

  /**
   * The tap, end to end.
   *
   * A browse tap is not a `play`: Android Auto sends `onPlayFromMediaId`, which
   * media3 turns into `COMMAND_SET_MEDIA_ITEM` → `Callback.onSetMediaItems`.
   * A `MediaController.setMediaItem` walks the identical path, so this asserts
   * the whole A1/A2 chain — the command is granted to this controller, the
   * callback fans it in, and the app's `playFromMediaId` runs — by looking at
   * the one thing only the app can change: the queue index it moves to.
   */
  @Test
  fun a_browse_tap_reaches_the_app_and_moves_playback() = withBrowser { browser ->
    val tracks = browser.call { getChildren("library", 0, Int.MAX_VALUE, null) }.value!!
    val target = tracks[3].mediaId
    val before = onMain { browser.currentMediaItemIndex }

    onMain {
      browser.setMediaItem(MediaItem.Builder().setMediaId(target).build())
    }
    // The acknowledgement is the app's next broadcast, not the call.
    Thread.sleep(3_000)

    val after = onMain { browser.currentMediaItemIndex }
    assertEquals(
      "the tap should have moved the app to queue entry 3 (was $before)",
      3,
      after,
    )
  }

  @Test
  fun an_unknown_parent_is_an_empty_list_and_never_an_error() = withBrowser { browser ->
    val children = browser.call { getChildren("no-such-node", 0, Int.MAX_VALUE, null) }

    assertEquals(LibraryResult.RESULT_SUCCESS, children.resultCode)
    assertEquals(0, children.value!!.size)
  }

  companion object {
    private var scenario: ActivityScenario<MainActivity>? = null

    /**
     * Boot the app once for the whole class: React Native has to be up and
     * `MediaService.init` has to have run, or there is no session to browse and
     * no handler behind it. The extra second is the JS bundle.
     */
    @BeforeClass
    @JvmStatic
    fun launchApp() {
      scenario = ActivityScenario.launch(MainActivity::class.java)
      Thread.sleep(8_000)
    }

    @AfterClass
    @JvmStatic
    fun closeApp() {
      scenario?.close()
    }
  }
}
