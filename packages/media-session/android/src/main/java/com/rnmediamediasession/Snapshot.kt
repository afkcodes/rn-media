package com.rnmediamediasession

import android.os.SystemClock
import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaControl
import com.margelo.nitro.rnmediamediasession.MediaCustomAction
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import com.margelo.nitro.rnmediamediasession.NativePlaybackState
import com.margelo.nitro.rnmediamediasession.PositionAnchor

/**
 * The position anchor, translated out of JavaScript's clock into one that cannot
 * jump.
 *
 * JS can only timestamp with `Date.now()` — wall clock, which NTP, the user and
 * a timezone daemon can all move. `SystemClock.elapsedRealtime()` is monotonic
 * and counts through deep sleep, which is what a playback position needs.
 *
 * The conversion happens **once, the instant the broadcast arrives**, so the
 * error is bounded by the JS→native hop rather than by how long the app stays
 * open:
 *
 * ```
 * age    = System.currentTimeMillis() - anchor.at   // ms this anchor is stale
 * origin = SystemClock.elapsedRealtime() - age      // same instant, monotonic
 * ```
 */
internal data class Anchor(
  /** Position in milliseconds at [originMs]. */
  val valueMs: Long,
  /** `SystemClock.elapsedRealtime()` value the position was sampled at. */
  val originMs: Long,
  /** Media-milliseconds per wall-millisecond. `0` freezes the projection. */
  val rate: Float,
) {
  /**
   * Position now.
   *
   * This is what media3's `SimpleBasePlayer.PositionSupplier` calls, on every
   * position read, on the application looper. No JavaScript is involved and no
   * timer exists — the projection is a subtraction.
   */
  fun projectMs(now: Long = SystemClock.elapsedRealtime()): Long =
    if (rate == 0f) valueMs
    else (valueMs + ((now - originMs) * rate).toLong()).coerceAtLeast(0L)

  companion object {
    /**
     * Convert a broadcast anchor **at the moment of receipt**. Calling this
     * later than that reintroduces exactly the staleness it exists to remove.
     */
    fun receive(anchor: PositionAnchor): Anchor {
      // A negative age means the JS clock is ahead of ours (an NTP step landed
      // between the two reads). Clamping keeps the anchor from being projected
      // into the future, which reads as a position that runs ahead and stalls.
      val ageMs = (System.currentTimeMillis() - anchor.at).coerceAtLeast(0.0)
      return Anchor(
        valueMs = anchor.value.toLong().coerceAtLeast(0L),
        originMs = SystemClock.elapsedRealtime() - ageMs.toLong(),
        rate = anchor.rate.toFloat(),
      )
    }

    fun zero(): Anchor = Anchor(0L, SystemClock.elapsedRealtime(), 0f)
  }
}

/**
 * Everything the three broadcast channels have said so far, as one immutable
 * value.
 *
 * Immutable on purpose: `BroadcastPlayer.getState()` is called by media3 at
 * unpredictable moments and must never observe a half-applied update. Each
 * broadcast produces a whole new snapshot which is published in one write.
 */
internal data class Snapshot(
  val status: MediaPlaybackStatus,
  val anchor: Anchor,
  /**
   * Playback speed for `PlaybackParameters`, which rejects `0`. Tracked apart
   * from [Anchor.rate] so that "paused at 1.5×" survives a pause: the anchor
   * rate goes to zero (freezing the projection) while this stays 1.5.
   */
  val speed: Float,
  /** Buffered position in ms, or `null` when the app did not say. */
  val bufferedPositionMs: Long?,
  val controls: List<MediaControl>,
  val capabilities: Set<MediaCapability>,
  val customActions: List<MediaCustomAction>,
  /** Indices into [controls]; already validated to ≤3 and in range by the TS layer. */
  val compactControlIndices: List<Int>,
  /** Index into [queue], or `-1` when playback is not queue-backed. */
  val queueIndex: Int,
  val errorMessage: String?,
  val item: NativeMediaItem?,
  val queue: List<NativeMediaItem>,
) {
  /**
   * The timeline media3 should show, and which entry of it is current.
   *
   * Three cases, in priority order:
   * 1. A valid [queueIndex] into a non-empty [queue] — the normal case; the
   *    whole queue is the timeline so controllers can render it.
   * 2. A media item with no usable queue position — a one-entry timeline. This
   *    covers ad-hoc playback and the window between `setMediaItem` and the
   *    `setPlaybackState` that carries the new index.
   * 3. Nothing at all — an empty timeline, which media3 requires to be paired
   *    with `STATE_IDLE`/`STATE_ENDED`.
   */
  val timeline: List<NativeMediaItem>
    get() = when {
      queueIndex in queue.indices -> queue
      item != null -> listOf(item)
      else -> queue
    }

  val timelineIndex: Int
    get() = when {
      queueIndex in queue.indices -> queueIndex
      item != null -> 0
      else -> 0
    }

  val isSeekable: Boolean
    get() = MediaCapability.SEEK in capabilities

  companion object {
    val EMPTY = Snapshot(
      status = MediaPlaybackStatus.STOPPED,
      anchor = Anchor.zero(),
      speed = 1f,
      bufferedPositionMs = null,
      controls = emptyList(),
      capabilities = emptySet(),
      customActions = emptyList(),
      compactControlIndices = emptyList(),
      queueIndex = -1,
      errorMessage = null,
      item = null,
      queue = emptyList(),
    )
  }
}

/**
 * Fold a `setPlaybackState` broadcast into the previous snapshot.
 *
 * [anchor] is passed in rather than derived from [state] because it must be
 * converted on the receiving thread, before this runs (see [Anchor.receive]).
 */
internal fun Snapshot.withPlaybackState(
  state: NativePlaybackState,
  anchor: Anchor,
): Snapshot = copy(
  status = state.status,
  anchor = anchor,
  speed = if (anchor.rate > 0f) anchor.rate else speed,
  bufferedPositionMs = state.bufferedPosition?.toLong(),
  controls = state.controls.toList(),
  capabilities = state.capabilities.toSet(),
  customActions = state.customActions.toList(),
  compactControlIndices =
    state.compactControlIndices?.map { it.toInt() }
    // No explicit choice: Android's collapsed notification has three slots, so
    // take the first three controls. Matches audio_service's default.
      ?: state.controls.indices.take(MAX_COMPACT_CONTROLS),
  queueIndex = state.queueIndex?.toInt() ?: -1,
  errorMessage = state.errorMessage,
)

internal const val MAX_COMPACT_CONTROLS = 3
