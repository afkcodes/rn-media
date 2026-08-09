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
   * The timeline before the `setMediaItem` channel is overlaid onto it.
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
  private val baseTimeline: List<NativeMediaItem>
    get() = when {
      queueIndex in queue.indices -> queue
      item != null -> listOf(item)
      else -> queue
    }

  /**
   * The timeline media3 should show — [baseTimeline] with the **current** entry
   * enriched by the `setMediaItem` channel (see [enrichedWith] for the rule and
   * the defect that motivates it).
   *
   * Only the current entry is touched: `setMediaItem` describes what is playing
   * now and says nothing about the rest of the queue, so every other entry is
   * passed through untouched (and by reference — the list is only copied when
   * an overlay actually applies).
   *
   * Computed once per snapshot. Snapshots are immutable and `getState()` is
   * called at media3's discretion, so caching keeps the overlay off a path that
   * runs on the main thread.
   */
  val timeline: List<NativeMediaItem> by lazy(LazyThreadSafetyMode.PUBLICATION) {
    val base = baseTimeline
    val override = item ?: return@lazy base
    val current = base.getOrNull(timelineIndex) ?: return@lazy base
    when {
      // Case 2 above: the timeline *is* the item, nothing to merge into.
      current === override -> base
      // Ids differ — the item describes something that is not at the current
      // queue position, so the queue entry stands. See [itemQueueMismatch].
      current.id != override.id -> base
      else -> base.toMutableList().apply { this[timelineIndex] = current.enrichedWith(override) }
    }
  }

  val timelineIndex: Int
    get() = when {
      queueIndex in queue.indices -> queueIndex
      item != null -> 0
      else -> 0
    }

  /**
   * A stable, human-readable key describing a `setMediaItem`/queue disagreement,
   * or `null` when the two channels agree (the normal case).
   *
   * Non-null means the app has broadcast an item whose id is not the id at
   * [timelineIndex], so everything the item carries — typically the duration —
   * is being dropped rather than merged. That is almost always an app bug (a
   * `setMediaItem` and the `setPlaybackState` carrying the matching `queueIndex`
   * got out of step), and it is invisible from the outside: the notification
   * simply shows the wrong metadata and no scrubber.
   *
   * Reported as data rather than logged here so this class stays free of
   * `android.util.Log` and therefore unit-testable on a plain JVM. The caller
   * ([BroadcastPlayer]) logs it once per distinct value.
   */
  val itemQueueMismatch: String?
    get() {
      val override = item ?: return null
      val current = baseTimeline.getOrNull(timelineIndex) ?: return null
      return if (current === override || current.id == override.id) null
      else "item id '${override.id}' vs queue[$timelineIndex] id '${current.id}'"
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
 * Overlay the `setMediaItem` channel onto the queue entry describing the same
 * track: **a field the item carries wins; a field the item omits falls back to
 * the queue entry.** Pure — same inputs, same output, no Android types.
 *
 * ## The channel-priority rule
 * The three broadcast channels are not ranked as a whole; they are ranked
 * per-entry. For the entry that is *currently playing*, `setMediaItem` is the
 * more specific statement — it is what the app sends when it knows something
 * concrete about the track it just started — so it takes priority over the same
 * track's queue entry. Every other queue entry is untouched: `setMediaItem`
 * says nothing about them. The receiver is the queue entry (the base), the
 * argument is the item (the override).
 *
 * ## The defect this fixes
 * Before this existed, a broadcast queue with a valid `queueIndex` made the
 * timeline *purely* queue-derived, and everything `setMediaItem` carried was
 * silently dropped. Apps rarely know durations for queue items up front — they
 * learn the duration when the track is prepared and send it through
 * `setMediaItem` — so in the common case duration reached the queue-backed
 * timeline through no channel at all. `durationUs` stayed `C.TIME_UNSET`,
 * `setIsSeekable(false)` followed, and the notification and lock screen showed
 * no scrubber even though the app had broadcast a complete current track.
 *
 * The caller must check id equality first; merging across different ids would
 * paste one track's metadata onto another. See [Snapshot.itemQueueMismatch].
 */
internal fun NativeMediaItem.enrichedWith(item: NativeMediaItem): NativeMediaItem =
  NativeMediaItem(
    // Equal by precondition; taking the receiver's keeps the queue's identity
    // authoritative for the timeline it belongs to.
    id = id,
    // `title` is the one non-nullable field, so "absent" cannot be expressed as
    // null. A blank title is not information — it would blank out a perfectly
    // good queue title — so it is treated as absent.
    title = item.title.ifBlank { title },
    artist = item.artist ?: artist,
    album = item.album ?: album,
    artworkUri = item.artworkUri ?: artworkUri,
    duration = item.duration ?: duration,
    genre = item.genre ?: genre,
  )

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
