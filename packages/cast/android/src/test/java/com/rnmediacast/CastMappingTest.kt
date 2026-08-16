package com.rnmediacast

import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaStatus
import com.google.android.gms.cast.framework.CastState
import com.margelo.nitro.rnmediacast.CastConnectionState
import com.margelo.nitro.rnmediacast.CastIdleReason
import com.margelo.nitro.rnmediacast.CastPlayerState
import com.margelo.nitro.rnmediacast.CastRepeatMode
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins `CastMapping` against the constants shipped in
 * play-services-cast(-framework) 22.3.1 — the media-session `MappingTest`
 * pattern. These are pure integer translations where a wrong constant
 * produces a *plausible* wrong behaviour (a receiver fetch failure read as a
 * natural end would silently kill the error taxonomy) rather than a crash.
 *
 * The framework constants referenced here are `public static final int`s, so
 * they are folded at compile time — the tests run on a plain JVM with no
 * Android framework and no GMS runtime.
 */
class CastMappingTest {

  // MARK: - Connection state

  @Test
  fun `framework cast states map onto the connection machine`() {
    assertEquals(
      CastConnectionState.IDLE,
      CastMapping.connectionState(CastState.NO_DEVICES_AVAILABLE)
    )
    assertEquals(
      CastConnectionState.IDLE,
      CastMapping.connectionState(CastState.NOT_CONNECTED)
    )
    assertEquals(
      CastConnectionState.CONNECTING,
      CastMapping.connectionState(CastState.CONNECTING)
    )
    assertEquals(
      CastConnectionState.CONNECTED,
      CastMapping.connectionState(CastState.CONNECTED)
    )
  }

  @Test
  fun `an unknown cast state folds to idle, never to unavailable`() {
    // `unavailable` is an initialization verdict (no Play services). If the
    // framework is alive enough to deliver a state at all, folding an unknown
    // constant to `unavailable` would tell apps to hide the cast button
    // mid-session.
    assertEquals(CastConnectionState.IDLE, CastMapping.connectionState(99))
    assertEquals(CastConnectionState.IDLE, CastMapping.connectionState(-1))
  }

  // MARK: - Player state

  @Test
  fun `every framework player state maps onto its typed value`() {
    assertEquals(
      CastPlayerState.IDLE,
      CastMapping.playerState(MediaStatus.PLAYER_STATE_IDLE)
    )
    assertEquals(
      CastPlayerState.PLAYING,
      CastMapping.playerState(MediaStatus.PLAYER_STATE_PLAYING)
    )
    assertEquals(
      CastPlayerState.PAUSED,
      CastMapping.playerState(MediaStatus.PLAYER_STATE_PAUSED)
    )
    assertEquals(
      CastPlayerState.BUFFERING,
      CastMapping.playerState(MediaStatus.PLAYER_STATE_BUFFERING)
    )
    assertEquals(
      CastPlayerState.LOADING,
      CastMapping.playerState(MediaStatus.PLAYER_STATE_LOADING)
    )
    assertEquals(
      CastPlayerState.UNKNOWN,
      CastMapping.playerState(MediaStatus.PLAYER_STATE_UNKNOWN)
    )
  }

  @Test
  fun `an unknown player state folds to unknown`() {
    assertEquals(CastPlayerState.UNKNOWN, CastMapping.playerState(42))
  }

  // MARK: - Idle reason

  @Test
  fun `every framework idle reason maps onto its typed value`() {
    assertEquals(
      CastIdleReason.NONE,
      CastMapping.idleReason(MediaStatus.IDLE_REASON_NONE)
    )
    assertEquals(
      CastIdleReason.FINISHED,
      CastMapping.idleReason(MediaStatus.IDLE_REASON_FINISHED)
    )
    assertEquals(
      CastIdleReason.CANCELLED,
      CastMapping.idleReason(MediaStatus.IDLE_REASON_CANCELED)
    )
    assertEquals(
      CastIdleReason.INTERRUPTED,
      CastMapping.idleReason(MediaStatus.IDLE_REASON_INTERRUPTED)
    )
    assertEquals(
      CastIdleReason.ERROR,
      CastMapping.idleReason(MediaStatus.IDLE_REASON_ERROR)
    )
  }

  @Test
  fun `an unknown idle reason folds to none, never to error`() {
    // Inventing a receiver failure the receiver never reported would fire the
    // app's error UI (and the cast-receiver-fetch taxonomy family) for
    // nothing.
    assertEquals(CastIdleReason.NONE, CastMapping.idleReason(77))
  }

  // MARK: - Repeat mode

  @Test
  fun `every framework repeat mode maps onto its typed value`() {
    assertEquals(
      CastRepeatMode.OFF,
      CastMapping.repeatMode(MediaStatus.REPEAT_MODE_REPEAT_OFF)
    )
    assertEquals(
      CastRepeatMode.ALL,
      CastMapping.repeatMode(MediaStatus.REPEAT_MODE_REPEAT_ALL)
    )
    assertEquals(
      CastRepeatMode.ONE,
      CastMapping.repeatMode(MediaStatus.REPEAT_MODE_REPEAT_SINGLE)
    )
    assertEquals(
      CastRepeatMode.ALLANDSHUFFLE,
      CastMapping.repeatMode(MediaStatus.REPEAT_MODE_REPEAT_ALL_AND_SHUFFLE)
    )
  }

  @Test
  fun `the repeat modes round trip through the framework constants`() {
    for (mode in CastRepeatMode.entries) {
      assertEquals(mode, CastMapping.repeatMode(CastMapping.toFrameworkRepeatMode(mode)))
    }
  }

  @Test
  fun `an unknown repeat mode folds to off rather than being dropped`() {
    assertEquals(CastRepeatMode.OFF, CastMapping.repeatMode(9))
    assertEquals(CastRepeatMode.OFF, CastMapping.repeatMode(-1))
  }

  // MARK: - Time conversion

  @Test
  fun `seconds become milliseconds`() {
    assertEquals(15_000L, CastMapping.secondsToMillis(15.0))
    assertEquals(500L, CastMapping.secondsToMillis(0.5))
    assertEquals(0L, CastMapping.secondsToMillis(0.0))
  }

  @Test
  fun `nonsensical positions fold to zero, never to a negative seek`() {
    // The framework throws on some negative positions and misbehaves on
    // others; seek-to-start is the recoverable answer.
    assertEquals(0L, CastMapping.secondsToMillis(-3.0))
    assertEquals(0L, CastMapping.secondsToMillis(Double.NaN))
    assertEquals(0L, CastMapping.secondsToMillis(Double.POSITIVE_INFINITY))
  }

  @Test
  fun `milliseconds become seconds`() {
    assertEquals(1.5, CastMapping.millisToSeconds(1_500L), 0.0)
    assertEquals(0.0, CastMapping.millisToSeconds(0L), 0.0)
  }

  // MARK: - Queue ids and indices (iOS parity)

  @Test
  fun `a real item id survives the double round trip`() {
    assertEquals(7, CastMapping.queueItemId(7.0))
    assertEquals(1, CastMapping.queueItemId(1.0))
    // Bridge doubles are not always exact integers.
    assertEquals(7, CastMapping.queueItemId(7.4))
  }

  @Test
  fun `nonsensical item ids fold to INVALID_ITEM_ID, never to a wrong item`() {
    // Same values, same answer as the iOS `CastMapping.queueItemID(_:)`, where
    // the fold also stops `UInt(_: Double)` from TRAPPING. `MediaQueueItem
    // .INVALID_ITEM_ID` and `kGCKMediaQueueInvalidItemID` are both 0, so the
    // SDK rejects the request with a typed error on both platforms.
    assertEquals(MediaQueueItem.INVALID_ITEM_ID, CastMapping.queueItemId(Double.NaN))
    assertEquals(
      MediaQueueItem.INVALID_ITEM_ID,
      CastMapping.queueItemId(Double.NEGATIVE_INFINITY)
    )
    assertEquals(MediaQueueItem.INVALID_ITEM_ID, CastMapping.queueItemId(-4.0))
    assertEquals(MediaQueueItem.INVALID_ITEM_ID, CastMapping.queueItemId(0.0))
    // Infinity is nonsense, not "very large" — the `secondsToMillis` rule.
    assertEquals(
      MediaQueueItem.INVALID_ITEM_ID,
      CastMapping.queueItemId(Double.POSITIVE_INFINITY)
    )
  }

  @Test
  fun `a finite but out-of-range item id clamps instead of wrapping`() {
    // A silent Int wrap would address a DIFFERENT, real queue item; on iOS the
    // same value would trap the `UInt` initializer outright.
    assertEquals(Int.MAX_VALUE, CastMapping.queueItemId(1e30))
  }

  @Test
  fun `indices are non-negative and never nonsense`() {
    assertEquals(0, CastMapping.index(0.0))
    assertEquals(3, CastMapping.index(3.0))
    assertEquals(0, CastMapping.index(-1.0))
    assertEquals(0, CastMapping.index(Double.NaN))
    assertEquals(0, CastMapping.index(Double.POSITIVE_INFINITY))
    assertEquals(Int.MAX_VALUE, CastMapping.index(1e30))
  }
}
