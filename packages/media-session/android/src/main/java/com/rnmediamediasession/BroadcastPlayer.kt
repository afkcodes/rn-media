package com.rnmediamediasession

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.MediaSessionHandlers
import com.margelo.nitro.rnmediamediasession.NativeMediaItem

/**
 * The facade `Player`.
 *
 * There is no playback engine behind this object. Its `State` is a projection of
 * the three broadcast channels, and every `handle*` method forwards to the JS
 * handler and returns. That is the whole point of the package: media3 gets a
 * `Player` — and therefore hands us the session, the notification, Android Auto
 * and Bluetooth for free — while the actual audio is produced by whatever the
 * app uses (`@rn-media/player`, RNTP, a TTS engine, anything).
 *
 * ## Position: no JS traffic, no timer
 * `State.setContentPositionMs(PositionSupplier)` takes a supplier that media3
 * calls whenever any surface wants the position. Ours projects from [Anchor],
 * so the seekbar advances on the lock screen, in Auto and in the notification
 * with zero bridge crossings and zero timers.
 *
 * We supply our own rather than `PositionSupplier.getExtrapolating(pos, speed)`
 * because that helper captures `SystemClock.elapsedRealtime()` *at the moment
 * the supplier is created* — i.e. at every `getState()` call. Rebuilding the
 * state for an unrelated reason (metadata arrived, a button changed) would
 * re-anchor the extrapolation and quantise away the elapsed time. Projecting
 * from the anchor's own origin is immune to that.
 *
 * ## Available commands are load-bearing
 * `SimpleBasePlayer` returns from its public setters *before* dispatching when
 * the corresponding `Player.Command` is missing from `State.availableCommands`
 * ("Only functionality that is declared as available needs to be implemented.
 * Other methods are automatically ignored."). A missing command is therefore a
 * silently dead button, not a crash. See [MediaButtons.commands].
 *
 * ## Threading
 * Constructed with the main looper, which media3 requires for
 * `MediaSessionService.pauseAllPlayersAndStopSelf()` ("throws
 * IllegalStateException if the application looper of the player is not the
 * looper of the main thread"). Every method here — including [update] — must
 * therefore run on the main thread; [MediaSessionController] guarantees it.
 */
@OptIn(UnstableApi::class)
internal class BroadcastPlayer(
  private val handlers: MediaSessionHandlers,
) : SimpleBasePlayer(Looper.getMainLooper()) {

  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile
  private var snapshot: Snapshot = Snapshot.EMPTY

  /**
   * Commands dispatched to JS that have not yet been acknowledged by a
   * `setPlaybackState` broadcast.
   *
   * This is what makes a notification button feel instant. While a returned
   * future is pending, `SimpleBasePlayer` shows an optimistic *placeholder*
   * state — "the most likely outcome to ensure the user-visible state changes
   * look like synchronous operations" — and re-reads `getState()` by itself the
   * moment the future completes. Resolving these on the app's next broadcast
   * makes the app's own state the thing that confirms the command, which is
   * exactly the fan-out contract.
   */
  private val pending = mutableListOf<SettableFuture<Any?>>()

  /**
   * Publish a new snapshot. Main thread only.
   *
   * @param acknowledgesCommands `true` for a `setPlaybackState` broadcast,
   * which is the app telling us what actually happened and therefore completes
   * any pending command. `setMediaItem`/`setQueue` do not acknowledge: they
   * usually arrive *before* the state that goes with them, and acking on them
   * would collapse the placeholder early and flicker the transport controls.
   */
  fun update(next: Snapshot, acknowledgesCommands: Boolean) {
    snapshot = next
    if (acknowledgesCommands && pending.isNotEmpty()) {
      val acknowledged = pending.toList()
      pending.clear()
      // Completing the futures is what triggers media3's automatic re-read of
      // getState(); calling invalidateState() here as well would be a no-op at
      // best (it early-returns while operations are pending) and confusing.
      for (future in acknowledged) future.set(null)
      return
    }
    invalidateState()
  }

  /** Drop pending acks without publishing state. Used when the session ends. */
  fun releasePending() {
    val abandoned = pending.toList()
    pending.clear()
    for (future in abandoned) future.set(null)
  }

  // MARK: - State

  override fun getState(): State {
    val current = snapshot
    val builder = State.Builder().setAvailableCommands(MediaButtons.commands(current))

    val timeline = current.timeline
    if (timeline.isEmpty()) {
      // media3 asserts this pairing: "If the playlist is empty, the state must
      // be either STATE_IDLE or STATE_ENDED."
      return builder
        .setPlaybackState(Player.STATE_IDLE)
        .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        .build()
    }

    builder
      .setPlaylist(timeline.mapIndexed { index, item -> mediaItemData(item, index, current) })
      .setCurrentMediaItemIndex(current.timelineIndex)
      .setContentPositionMs(PositionSupplier { current.anchor.projectMs() })
      .setPlaybackParameters(PlaybackParameters(current.speed))
      .setIsLoading(current.status == MediaPlaybackStatus.BUFFERING)

    current.bufferedPositionMs?.let {
      builder.setContentBufferedPositionMs(PositionSupplier.getConstant(it))
    }

    val reason = Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
    when (current.status) {
      MediaPlaybackStatus.PLAYING ->
        builder.setPlaybackState(Player.STATE_READY).setPlayWhenReady(true, reason)

      // playWhenReady stays true while buffering on purpose: media3 keeps the
      // service in the foreground only while
      // `playWhenReady && (STATE_READY || STATE_BUFFERING)`, so flipping it
      // during a stall would demote the foreground service mid-track.
      MediaPlaybackStatus.BUFFERING ->
        builder.setPlaybackState(Player.STATE_BUFFERING).setPlayWhenReady(true, reason)

      MediaPlaybackStatus.PAUSED ->
        builder.setPlaybackState(Player.STATE_READY).setPlayWhenReady(false, reason)

      MediaPlaybackStatus.STOPPED ->
        builder.setPlaybackState(Player.STATE_IDLE).setPlayWhenReady(false, reason)

      MediaPlaybackStatus.ERROR ->
        builder
          // media3 enforces this: "Player error only allowed in STATE_IDLE".
          .setPlaybackState(Player.STATE_IDLE)
          .setPlayWhenReady(false, reason)
          .setPlayerError(
            PlaybackException(
              current.errorMessage ?: "Playback failed",
              /* cause = */ null,
              // The app's taxonomy does not map onto media3's error codes and
              // guessing one would be worse than admitting we do not know.
              PlaybackException.ERROR_CODE_UNSPECIFIED,
            )
          )
    }

    return builder.build()
  }

  private fun mediaItemData(item: NativeMediaItem, index: Int, snapshot: Snapshot): MediaItemData {
    val durationMs = item.duration?.toLong()
    val metadata = MediaMetadata.Builder()
      .setTitle(item.title)
      .setArtist(item.artist)
      .setAlbumTitle(item.album)
      .setGenre(item.genre)
      .setArtworkUri(item.artworkUri?.let(Uri::parse))
      .setDurationMs(durationMs)
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
      .build()

    return MediaItemData.Builder(
      // media3 rejects duplicate uids in a playlist, and the same track legitimately
      // appears twice in a queue — so the index, not the id, carries identity.
      /* uid = */ "$index:${item.id}"
    )
      .setMediaItem(
        MediaItem.Builder().setMediaId(item.id).setMediaMetadata(metadata).build()
      )
      // Microseconds. C.TIME_UNSET for live/unknown.
      .setDurationUs(durationMs?.times(1000L) ?: C.TIME_UNSET)
      // `isSeekable` defaults to false, and a false here greys out the seekbar
      // even when COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM is available. Seeking into
      // an unknown duration is meaningless, hence the duration check.
      .setIsSeekable(snapshot.isSeekable && durationMs != null)
      .setIsDynamic(durationMs == null)
      .build()
  }

  // MARK: - Commands in

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> =
    dispatch { if (playWhenReady) handlers.play() else handlers.pause() }

  override fun handleStop(): ListenableFuture<*> = dispatch { handlers.stop() }

  /**
   * Nothing to prepare — the app owns the playback engine. Declared only so
   * `MediaController.prepare()` (System UI playback resumption) is not rejected.
   */
  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  /**
   * Unreachable in practice: `COMMAND_RELEASE` is deliberately not advertised
   * (see [MediaButtons]). Implemented anyway so that adding the command later
   * cannot resurrect `SimpleBasePlayer`'s default, which throws.
   */
  override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleSetPlaybackParameters(
    playbackParameters: PlaybackParameters
  ): ListenableFuture<*> = dispatch { handlers.setRate(playbackParameters.speed.toDouble()) }

  /**
   * Every seek-shaped command funnels here; `seekCommand` says which one.
   *
   * media3 has already resolved the *implied* target: "If the original seek
   * operation did not directly specify an index, this is the most likely
   * implied index based on the available player state." That is what lets
   * `fastForward`/`rewind` (`COMMAND_SEEK_FORWARD`/`_BACK`) collapse into a
   * plain absolute `seekTo` — the increment arithmetic is already done, and the
   * JS handler interface stays free of relative-seek methods.
   */
  override fun handleSeek(
    mediaItemIndex: Int,
    positionMs: Long,
    seekCommand: Int,
  ): ListenableFuture<*> = when (seekCommand) {
    Player.COMMAND_SEEK_TO_NEXT,
    Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
    -> dispatch { handlers.skipToNext() }

    Player.COMMAND_SEEK_TO_PREVIOUS,
    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
    -> dispatch { handlers.skipToPrevious() }

    Player.COMMAND_SEEK_TO_MEDIA_ITEM,
    Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
    -> {
      val current = snapshot
      if (mediaItemIndex != C.INDEX_UNSET && mediaItemIndex != current.timelineIndex) {
        dispatch { handlers.skipToQueueItem(mediaItemIndex.toDouble()) }
      } else {
        dispatch { handlers.seekTo(positionMs.orZeroIfUnset()) }
      }
    }

    // COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_SEEK_BACK, COMMAND_SEEK_FORWARD.
    else -> dispatch { handlers.seekTo(positionMs.orZeroIfUnset()) }
  }

  private fun Long.orZeroIfUnset(): Double =
    if (this == C.TIME_UNSET) 0.0 else this.toDouble().coerceAtLeast(0.0)

  /**
   * Fire the JS callback and hand media3 a future the app's next broadcast will
   * complete.
   *
   * Nitro schedules the JS invocation onto the JS thread itself, so calling
   * from this (main) thread neither blocks nor risks an ANR
   * (https://nitro.margelo.com/docs/types/callbacks).
   */
  private fun dispatch(invoke: () -> Unit): ListenableFuture<*> {
    invoke()
    val future = SettableFuture.create<Any?>()
    pending.add(future)
    // Without a deadline a JS handler that never broadcasts would wedge the
    // player forever: `invalidateState()` early-returns while any operation is
    // pending, so every later broadcast would be ignored too.
    mainHandler.postDelayed(
      { if (pending.remove(future)) future.set(null) },
      ACK_TIMEOUT_MS,
    )
    return future
  }

  private companion object {
    /**
     * How long a command may stay optimistic before we give up on the app
     * confirming it. Long enough to cover a cold JS runtime start, short enough
     * that a stuck handler does not leave the notification lying.
     */
    const val ACK_TIMEOUT_MS = 3_000L
  }
}
