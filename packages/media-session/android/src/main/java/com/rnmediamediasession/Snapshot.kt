package com.rnmediamediasession

import android.os.SystemClock
import com.margelo.nitro.rnmediamediasession.MediaCapability
import com.margelo.nitro.rnmediamediasession.MediaControl
import com.margelo.nitro.rnmediamediasession.MediaCustomAction
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.MediaRepeatMode
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import com.margelo.nitro.rnmediamediasession.NativePlaybackState
import com.margelo.nitro.rnmediamediasession.NativeRemotePlayback
import com.margelo.nitro.rnmediamediasession.PositionAnchor
import com.margelo.nitro.rnmediamediasession.RemoteVolumeControl

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
 * The remote output the app has published, in the *platform's* vocabulary.
 *
 * The bridge carries a normalised `0..1` level plus a step count, because that
 * is what an app (and every remote backend) speaks. Android needs integers: a
 * `DeviceInfo` with a min/max range and an int `deviceVolume`, which is what the
 * platform's `VolumeProvider` reports and what one hardware key press moves by
 * exactly 1. Converting once, here, keeps the arithmetic in one testable place
 * instead of inside `getState()` — which media3 calls many times per broadcast.
 */
internal data class RemoteDevice(
  /** `0..maxVolume`. */
  val volume: Int,
  val maxVolume: Int,
  val muted: Boolean,
  val volumeControl: RemoteVolumeControl,
  val routingControllerId: String?,
)

/**
 * Bridge struct → [RemoteDevice]. Pure; no Android types; unit-tested on a JVM.
 *
 * `steps` is floored at 1 and the level is clamped into the resulting range.
 * The TS layer already rejects anything else, so this is not validation — it is
 * the guarantee that a value arriving some other way (a future bridge, a bug)
 * cannot produce a `DeviceInfo` with `maxVolume = 0`, which would render as a
 * dead volume slider rather than as an error anybody would notice.
 */
internal fun NativeRemotePlayback.toDevice(): RemoteDevice {
  val maxVolume = if (steps.isFinite()) steps.toInt().coerceAtLeast(1) else 1
  val level = if (volume.isFinite()) volume else 0.0
  return RemoteDevice(
    volume = Math.round(level * maxVolume).toInt().coerceIn(0, maxVolume),
    maxVolume = maxVolume,
    muted = muted,
    volumeControl = volumeControl,
    routingControllerId = routingControllerId,
  )
}

/**
 * An integer device volume media3 handed us, back as the normalised `0..1`
 * level the JS handler speaks.
 *
 * The inverse of [toDevice]'s quantisation, so a drag on the system's remote
 * volume slider round-trips to exactly the notch it was dropped on.
 */
internal fun RemoteDevice.levelOf(deviceVolume: Int): Double =
  if (maxVolume <= 0) 0.0
  else deviceVolume.coerceIn(0, maxVolume).toDouble() / maxVolume

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
  /** Repeat mode as last broadcast. Drives `State.Builder.setRepeatMode`. */
  val repeatMode: MediaRepeatMode,
  /** Shuffle state as last broadcast. Drives `State.Builder.setShuffleModeEnabled`. */
  val shuffleEnabled: Boolean,
  val item: NativeMediaItem?,
  val queue: List<NativeMediaItem>,
  /**
   * The device the audio is coming out of, or `null` for "the phone" — which is
   * the default, and where every session that never calls `setRemotePlayback`
   * stays forever.
   *
   * Not fed by any of the three broadcast channels and deliberately **sticky**:
   * it is a statement about the output, not about playback, so a
   * `setPlaybackState` neither carries it nor clears it. It is what turns the
   * facade into a `PLAYBACK_TYPE_REMOTE` player, which is what routes hardware
   * volume keys to the app instead of to the phone's music stream.
   */
  val remote: RemoteDevice? = null,
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
    // Capability-only, and deliberately still snapshot-wide: whether a *given*
    // entry is seekable additionally depends on that entry's own
    // [effectiveDurationMs], which `BroadcastPlayer.mediaItemData` applies
    // per-entry. Folding the current item's liveness in here would make one live
    // track in a queue un-seek every other track in it.
    get() = MediaCapability.SEEK in capabilities

  /** The entry the timeline is currently on, already enriched. */
  val currentItem: NativeMediaItem?
    get() = timeline.getOrNull(timelineIndex)

  /**
   * Milliseconds until the current item ends, or `null` when that is not
   * computable from what has been broadcast.
   *
   * The whole of the end-of-track sleep timer's arithmetic, kept pure so it can
   * be unit-tested on a plain JVM: given a snapshot and a monotonic `now`, when
   * does the thing that is playing run out?
   *
   * `null` — "armed, deadline unknown" rather than "fire now" — in three cases,
   * each of which is a real state and none of which is an error:
   * - **no duration**: a live stream, or a track whose duration the app has not
   *   broadcast yet (which is the normal window right after a track change);
   * - **explicitly live**: `isLive` says there is no end to wait for;
   * - **not advancing**: the anchor's rate is `0` (paused, buffering, stopped),
   *   so the end is not approaching and any number would be a guess about when
   *   the user presses play.
   *
   * Never negative: a projection that has already run past the duration means
   * the end is due now, and `0` is how that is said.
   */
  fun trackEndDelayMs(now: Long): Long? {
    if (anchor.rate <= 0f) return null
    val item = currentItem ?: return null
    val durationMs = item.effectiveDurationMs ?: return null
    if (durationMs <= 0L) return null
    val remaining = durationMs - anchor.projectMs(now)
    // Divided by the rate: at 2× a minute of audio arrives in thirty seconds,
    // and a sleep timer that ignores that fires a minute late.
    return (remaining / anchor.rate).toLong().coerceAtLeast(0L)
  }

  /**
   * A stable identity for "the item the end-of-track timer was armed against".
   *
   * Index *and* id, because either alone is wrong: ids legitimately repeat
   * within a queue (see `NativeMediaItem.id`), and the index alone changes under
   * a queue edit that did not change what is playing. The pair changes exactly
   * when the thing playing changes, which is the event the timer is waiting for.
   */
  val currentItemKey: String?
    get() = currentItem?.let { "$timelineIndex:${it.id}" }

  /** Convenience for [trackEndDelayMs] on the process's monotonic clock. */
  fun trackEndDelayMs(): Long? = trackEndDelayMs(SystemClock.elapsedRealtime())

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
      repeatMode = MediaRepeatMode.OFF,
      shuffleEnabled = false,
      item = null,
      queue = emptyList(),
    )
  }
}

/* -------------------------------------------------------------------------- */
/*                        End-of-track timer: the policy                      */
/* -------------------------------------------------------------------------- */

/**
 * What a broadcast should do to an **armed** end-of-track sleep timer.
 *
 * Extracted from [MediaSessionController] so the decision — the only part of the
 * feature with any branching in it — is a pure function of two nullable strings
 * and can be unit-tested on a plain JVM. What is left behind in the controller
 * is a `Handler` post and a `when`, which is exactly the part that needs a
 * device.
 */
internal sealed interface TrackEndAction {
  /**
   * The item the timer was waiting on is gone — it finished and the app
   * advanced, or the user skipped, or the media item was cleared. "After this
   * one" has happened; fire.
   */
  object Fire : TrackEndAction

  /**
   * Keep waiting, and re-aim the deadline.
   *
   * @param latchTo non-null when this broadcast is the first to name an item
   * since the timer was armed — arming over silence latches onto whatever turns
   * up rather than firing because "the item changed" from nothing to something.
   */
  data class Wait(val latchTo: String?) : TrackEndAction
}

/**
 * The end-of-track timer's whole decision, as a pure function.
 *
 * @param latchedKey the [Snapshot.currentItemKey] the timer is waiting on, or
 * `null` for "armed, nothing latched yet". A single nullable field rather than a
 * key plus a `latched` boolean, deliberately: the two-field form let the pair
 * drift out of step — a fired timer used to leave `latched = true` with a stale
 * key behind it, so the *next* arm could see "the item changed" against an item
 * from a previous session and pause playback at the instant of arming. One field
 * cannot be half-reset.
 * @param currentKey the key of what is playing now, or `null` for nothing.
 */
internal fun trackEndAction(latchedKey: String?, currentKey: String?): TrackEndAction = when {
  // Armed over silence (or before the first broadcast): latch onto the first
  // item to appear, and keep waiting when there still is none.
  latchedKey == null -> TrackEndAction.Wait(latchTo = currentKey)
  // Same item, including "same item, new duration/position/rate" — the ordinary
  // case, and the one that happens on every broadcast of a track playing out.
  currentKey == latchedKey -> TrackEndAction.Wait(latchTo = null)
  else -> TrackEndAction.Fire
}

/**
 * The duration to act on, in milliseconds, or `null` when there is none.
 *
 * `isLive` wins over a duration the app also sent. Until it existed, "no
 * duration" was the only way to say live — which conflated "this is live" with
 * "I don't know it yet" — so an app that knows both facts can now state them
 * both, and everything downstream (timeline `isDynamic`, seekability, the
 * end-of-track sleep timer) reads this one property rather than re-deciding.
 */
internal val NativeMediaItem.effectiveDurationMs: Long?
  get() = if (isLive == true) null else duration?.toLong()

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
    // Same field-by-field rule for every extended tag: what the item carries
    // wins, what it omits falls back. Listed explicitly rather than reflected
    // over so that adding a field to the struct is a compile error here — this
    // merge silently dropping a new field is exactly the defect the merge was
    // introduced to fix.
    albumArtist = item.albumArtist ?: albumArtist,
    trackNumber = item.trackNumber ?: trackNumber,
    discNumber = item.discNumber ?: discNumber,
    year = item.year ?: year,
    subtitle = item.subtitle ?: subtitle,
    isLive = item.isLive ?: isLive,
    // Replaced wholesale, not merged key-by-key: `extras` is one opaque payload
    // belonging to the app, and half of an old payload mixed with half of a new
    // one is a value the app never wrote.
    extras = item.extras ?: extras,
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
  repeatMode = state.repeatMode,
  shuffleEnabled = state.shuffleEnabled,
)

internal const val MAX_COMPACT_CONTROLS = 3
