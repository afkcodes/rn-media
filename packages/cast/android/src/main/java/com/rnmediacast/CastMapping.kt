package com.rnmediacast

import com.margelo.nitro.rnmediacast.CastConnectionState
import com.margelo.nitro.rnmediacast.CastIdleReason
import com.margelo.nitro.rnmediacast.CastPlayerState
import com.margelo.nitro.rnmediacast.CastRepeatMode

/**
 * Pure translations between the Cast framework's integer constants and this
 * package's typed vocabulary, plus the seconds↔milliseconds conversions.
 *
 * Deliberately takes/returns plain [Int]s rather than framework classes so
 * every function runs on a plain JVM (the media-session `MappingTest`
 * pattern): these are the places where a wrong constant produces a
 * *plausible* wrong behaviour (repeat-one where the user asked repeat-all, a
 * "finished" that was actually a receiver fetch error) rather than a crash
 * anyone would notice. The constants are pinned by `CastMappingTest` against
 * the values shipped in play-services-cast(-framework) 22.3.1.
 */
internal object CastMapping {

  // `CastState` constants (play-services-cast-framework).
  private const val CAST_STATE_NO_DEVICES_AVAILABLE = 1
  private const val CAST_STATE_NOT_CONNECTED = 2
  private const val CAST_STATE_CONNECTING = 3
  private const val CAST_STATE_CONNECTED = 4

  // `MediaStatus.PLAYER_STATE_*` (play-services-cast).
  private const val PLAYER_STATE_IDLE = 1
  private const val PLAYER_STATE_PLAYING = 2
  private const val PLAYER_STATE_PAUSED = 3
  private const val PLAYER_STATE_BUFFERING = 4
  private const val PLAYER_STATE_LOADING = 5

  // `MediaStatus.IDLE_REASON_*`.
  private const val IDLE_REASON_NONE = 0
  private const val IDLE_REASON_FINISHED = 1
  private const val IDLE_REASON_CANCELED = 2
  private const val IDLE_REASON_INTERRUPTED = 3
  private const val IDLE_REASON_ERROR = 4

  // `MediaStatus.REPEAT_MODE_*`.
  private const val REPEAT_MODE_OFF = 0
  private const val REPEAT_MODE_ALL = 1
  private const val REPEAT_MODE_SINGLE = 2
  private const val REPEAT_MODE_ALL_AND_SHUFFLE = 3

  /**
   * `CastState` → connection state. `NO_DEVICES_AVAILABLE` and
   * `NOT_CONNECTED` both fold to `IDLE` — "framework ready, no session"; the
   * device list answers whether anything was found. `UNAVAILABLE` is never
   * produced here: it is an *initialization* verdict (no Play services), not
   * a `CastState` value, and only `CastContextHolder` may say it.
   */
  fun connectionState(castState: Int): CastConnectionState =
    when (castState) {
      CAST_STATE_CONNECTING -> CastConnectionState.CONNECTING
      CAST_STATE_CONNECTED -> CastConnectionState.CONNECTED
      CAST_STATE_NO_DEVICES_AVAILABLE,
      CAST_STATE_NOT_CONNECTED -> CastConnectionState.IDLE
      // An unknown future constant is still "framework alive, not connected".
      else -> CastConnectionState.IDLE
    }

  fun playerState(playerState: Int): CastPlayerState =
    when (playerState) {
      PLAYER_STATE_IDLE -> CastPlayerState.IDLE
      PLAYER_STATE_PLAYING -> CastPlayerState.PLAYING
      PLAYER_STATE_PAUSED -> CastPlayerState.PAUSED
      PLAYER_STATE_BUFFERING -> CastPlayerState.BUFFERING
      PLAYER_STATE_LOADING -> CastPlayerState.LOADING
      else -> CastPlayerState.UNKNOWN
    }

  /**
   * An unknown idle reason folds to [CastIdleReason.NONE] rather than
   * [CastIdleReason.ERROR]: inventing a receiver failure the receiver never
   * reported would fire the app's error UI for nothing.
   */
  fun idleReason(idleReason: Int): CastIdleReason =
    when (idleReason) {
      IDLE_REASON_FINISHED -> CastIdleReason.FINISHED
      IDLE_REASON_CANCELED -> CastIdleReason.CANCELLED
      IDLE_REASON_INTERRUPTED -> CastIdleReason.INTERRUPTED
      IDLE_REASON_ERROR -> CastIdleReason.ERROR
      IDLE_REASON_NONE -> CastIdleReason.NONE
      else -> CastIdleReason.NONE
    }

  fun repeatMode(repeatMode: Int): CastRepeatMode =
    when (repeatMode) {
      REPEAT_MODE_ALL -> CastRepeatMode.ALL
      REPEAT_MODE_SINGLE -> CastRepeatMode.ONE
      REPEAT_MODE_ALL_AND_SHUFFLE -> CastRepeatMode.ALLANDSHUFFLE
      REPEAT_MODE_OFF -> CastRepeatMode.OFF
      // Unknown folds to OFF — a state the app can render (media-session's
      // repeat-mode rule).
      else -> CastRepeatMode.OFF
    }

  fun toFrameworkRepeatMode(mode: CastRepeatMode): Int =
    when (mode) {
      CastRepeatMode.OFF -> REPEAT_MODE_OFF
      CastRepeatMode.ALL -> REPEAT_MODE_ALL
      CastRepeatMode.ONE -> REPEAT_MODE_SINGLE
      CastRepeatMode.ALLANDSHUFFLE -> REPEAT_MODE_ALL_AND_SHUFFLE
    }

  /**
   * Public-API seconds → framework milliseconds. Non-finite and negative
   * input folds to 0 rather than being forwarded: the framework throws on
   * some negative positions and silently misbehaves on others, and a
   * seek-to-start is the state a user can recover from.
   */
  fun secondsToMillis(seconds: Double): Long =
    if (seconds.isFinite() && seconds > 0) (seconds * 1000.0).toLong() else 0L

  /** Framework milliseconds → public-API seconds. */
  fun millisToSeconds(millis: Long): Double = millis / 1000.0

  /** `MediaQueueItem.INVALID_ITEM_ID` (0), inlined to keep this file GMS-free. */
  private const val INVALID_ITEM_ID = 0

  /**
   * A receiver queue item id, from the [Double] the bridge carries.
   *
   * NaN, infinity and negatives are all expressible from JS and none of them
   * is an id, so they fold to [INVALID_ITEM_ID] — the value both SDKs already
   * define as "no item" — and the SDK answers with a typed rejection. This is
   * the twin of the iOS `CastMapping.queueItemID(_:)`, where the same fold is
   * not a nicety but a crash guard: Swift's `UInt(_: Double)` traps on all
   * three. Kept in lockstep so an id behaves identically on both platforms.
   */
  fun queueItemId(value: Double): Int =
    when {
      !value.isFinite() || value <= 0 -> INVALID_ITEM_ID
      value >= Int.MAX_VALUE.toDouble() -> Int.MAX_VALUE
      else -> value.toInt()
    }

  /** A non-negative array index, with the same rule as [queueItemId]. */
  fun index(value: Double): Int =
    when {
      !value.isFinite() || value <= 0 -> 0
      value >= Int.MAX_VALUE.toDouble() -> Int.MAX_VALUE
      else -> value.toInt()
    }
}
