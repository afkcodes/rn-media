package com.rnmediamediasession

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.DeviceInfo
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
import com.margelo.nitro.rnmediamediasession.MediaRepeatMode
import com.margelo.nitro.rnmediamediasession.MediaSessionHandlers
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import com.margelo.nitro.rnmediamediasession.SessionErrorCode

/**
 * The facade `Player`.
 *
 * There is no playback engine behind this object. Its `State` is a projection of
 * the three broadcast channels, and every `handle*` method forwards to the JS
 * handler and returns. That is the whole point of the package: media3 gets a
 * `Player` — and therefore hands us the session, the notification, Android Auto
 * and Bluetooth for free — while the actual audio is produced by whatever the
 * app uses (`@afkcodes/timbre-player`, RNTP, a TTS engine, anything).
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
/**
 * A broadcast item as a plain media3 `MediaItem`.
 *
 * Shared by the timeline ([BroadcastPlayer.getState]) and by
 * `MediaSession.Callback.onPlaybackResumption`, which has to answer the System
 * UI's resumption query with items rather than with player state. One
 * conversion so the resumption card and the notification can never describe the
 * same track differently.
 */
@OptIn(UnstableApi::class)
internal fun NativeMediaItem.toMediaItem(): MediaItem =
  MediaItem.Builder()
    .setMediaId(id)
    .setMediaMetadata(
      MediaMetadata.Builder()
        .setTitle(title)
        .setArtist(artist)
        .setAlbumTitle(album)
        .setGenre(genre)
        .setArtworkUri(artworkUri?.let(Uri::parse))
        .setDurationMs(duration?.toLong())
        .setAlbumArtist(albumArtist)
        // `setSubtitle` is the field media3's own notification reads through
        // `DefaultMediaNotificationProvider.getNotificationContentText`, which is
        // why the extended-metadata field is named `subtitle` rather than
        // `description` — `setDescription` exists too and is not rendered there.
        .setSubtitle(subtitle)
        // Integer setters; the bridge carries every number as a Double.
        .setTrackNumber(trackNumber?.toInt())
        .setDiscNumber(discNumber?.toInt())
        // `setReleaseYear`, not `setRecordingYear`: tag formats mostly carry one
        // year and "the year on the cover" is the release year. Filling both
        // from one number would invent a recording date we were never told.
        .setReleaseYear(year?.toInt())
        .setExtras(extras?.toBundle())
        .setIsBrowsable(false)
        .setIsPlayable(true)
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .build()
    )
    .build()

/**
 * `extras` as the `Bundle` `MediaMetadata` wants.
 *
 * String values only, which is the contract the TS layer enforces
 * (`NativeMediaItem.extras`): this `Bundle` crosses a binder to third-party
 * `MediaController`s and is the same payload `withPersistence` puts through
 * JSON, and a string map is what survives both unchanged.
 */
private fun Map<String, String>.toBundle(): Bundle =
  Bundle(size).also { bundle -> forEach { (key, value) -> bundle.putString(key, value) } }

/**
 * The broadcast repeat mode as media3's `@Player.RepeatMode` constant.
 *
 * The two vocabularies line up exactly — `REPEAT_MODE_OFF/_ONE/_ALL` are 0/1/2
 * (`javap` on media3-common 1.11.0) and so are our three members — but the
 * mapping is written out rather than done by ordinal, because an ordinal
 * coincidence is not a contract and a member added to either side would turn it
 * into a silent mis-mapping.
 */
internal fun MediaRepeatMode.toMedia3(): @Player.RepeatMode Int = when (this) {
  MediaRepeatMode.OFF -> Player.REPEAT_MODE_OFF
  MediaRepeatMode.ONE -> Player.REPEAT_MODE_ONE
  MediaRepeatMode.ALL -> Player.REPEAT_MODE_ALL
}

/** The inverse of [toMedia3]. Unknown constants fold to `OFF` — see `handleSetRepeatMode`. */
internal fun Int.toRepeatMode(): MediaRepeatMode = when (this) {
  Player.REPEAT_MODE_ONE -> MediaRepeatMode.ONE
  Player.REPEAT_MODE_ALL -> MediaRepeatMode.ALL
  else -> MediaRepeatMode.OFF
}

/**
 * Where a transport command goes once media3 has resolved it.
 *
 * An indirection with exactly one reason to exist: **the player can outlive the
 * handlers, and can also precede them.** In a playback resumption the media3
 * session — and therefore this `Player` — is built by the service before any
 * JavaScript exists, and the app's handlers are installed seconds later when
 * the runtime finishes booting. Capturing a `MediaSessionHandlers` in the
 * constructor (as this class used to) makes that impossible to express; asking
 * for one per command makes the handover a non-event.
 *
 * Implemented by [MediaSessionController], which is the only thing that knows
 * whether handlers exist yet and what to do when they do not.
 */
internal fun interface CommandDispatcher {
  /**
   * @param startsPlayback `true` when this command is a request to *begin*
   * playback. The only thing that can legitimately arrive before the app is
   * alive, and the trigger for reviving it.
   * @param invoke the call to make on the handlers, once there are any.
   */
  fun dispatch(startsPlayback: Boolean, invoke: (MediaSessionHandlers) -> Unit)
}

@OptIn(UnstableApi::class)
internal class BroadcastPlayer(
  private val commands: CommandDispatcher,
  seekForwardIncrementMs: Long,
  seekBackIncrementMs: Long,
) : SimpleBasePlayer(Looper.getMainLooper()) {

  private val mainHandler = Handler(Looper.getMainLooper())

  /**
   * The browse-tap guard. See [MediaRequestLatch] — armed by the session
   * callback, consumed by [handleSetPlayWhenReady].
   */
  private val mediaRequest = MediaRequestLatch { disarm -> mainHandler.post(disarm) }

  /** Called from `MediaSession.Callback.onSetMediaItems`. Main thread only. */
  fun armMediaRequest() {
    mediaRequest.arm()
  }

  /**
   * What `COMMAND_SEEK_FORWARD` / `COMMAND_SEEK_BACK` resolve against before
   * media3 hands us an absolute position in [handleSeek].
   *
   * Held here rather than captured from the config at construction because the
   * player outlives a single `initialize` — in a playback resumption it is built
   * by the service and re-used when JavaScript arrives with the app's real
   * configuration (see `MediaSessionController.initialize`). Main-thread
   * confined like everything else in this class.
   *
   * Setting them at all is the fix for a parity defect: media3 defaults to
   * `C.DEFAULT_SEEK_BACK_INCREMENT_MS` (5 s) and
   * `C.DEFAULT_SEEK_FORWARD_INCREMENT_MS` (15 s), while iOS pinned 15 s both
   * ways — the same JS call, two behaviours.
   */
  private var seekForwardIncrementMs: Long = seekForwardIncrementMs
  private var seekBackIncrementMs: Long = seekBackIncrementMs

  /** Main thread only. Re-publishes so a controller sees the new increments. */
  fun setSeekIncrements(forwardMs: Long, backMs: Long) {
    if (forwardMs == seekForwardIncrementMs && backMs == seekBackIncrementMs) return
    seekForwardIncrementMs = forwardMs
    seekBackIncrementMs = backMs
    invalidateState()
  }

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
   * The same thing for device-volume commands, kept in its own list because
   * they are acknowledged by a different broadcast.
   *
   * A `setPlaybackState` says what playback is doing and completes a transport
   * command; a `setRemotePlayback` says what the remote device's volume is and
   * completes a volume command. Sharing one list would let a status update
   * arriving mid-press collapse the optimistic "+1" back to the old number for
   * the ~200 ms until the backend reports the new one — visible as a volume
   * panel that jumps backwards under the user's thumb.
   */
  private val pendingVolume = mutableListOf<SettableFuture<Any?>>()

  /**
   * The item/queue disagreement channel, deferred by a turn so that the gap
   * between an app's `setMediaItem` and its `setPlaybackState` is not mistaken
   * for one. See [MismatchReporter].
   */
  private val mismatchReporter = MismatchReporter(
    postToNextTurn = { mainHandler.post(it) },
    current = { snapshot.itemQueueMismatch },
    report = { mismatch ->
      // Reported as well as logged, with the same wording the iOS twin uses.
      SessionErrors.report(
        SessionErrorCode.METADATAMISMATCH,
        "setMediaItem does not describe the current queue entry ($mismatch); the queue " +
          "entry wins and the item's fields — including its duration — are ignored. " +
          "Broadcast the matching queueIndex, or an item whose id matches it.",
      )
    },
  )

  /**
   * Everything [getState] derives from a snapshot that is not the snapshot
   * itself — cached, because media3 calls `getState()` many times per broadcast
   * (see [warnOnce]) and every call used to rebuild all of it.
   *
   * The cost this removes is per *entry*: a `MediaItem.Builder` + a
   * `MediaMetadata.Builder` + a `Uri.parse` + a `MediaItemData.Builder` each,
   * so a 500-track queue allocated 500 of each, several times per broadcast, on
   * the main thread. A snapshot is immutable and replaced wholesale, so
   * identity is a sound cache key and the result cannot go stale.
   *
   * Main-thread confined like the rest of this class — `SimpleBasePlayer`
   * requires its application looper — hence no synchronisation.
   */
  private class Rendered(
    val snapshot: Snapshot,
    val commands: Player.Commands,
    val playlist: List<MediaItemData>,
    /** `null` while playback is local — `State.Builder` already defaults to it. */
    val deviceInfo: DeviceInfo?,
  )

  private var rendered: Rendered? = null

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
      // Completing the futures is what triggers media3's automatic re-read of
      // getState(); calling invalidateState() here as well would be a no-op at
      // best (it early-returns while operations are pending) and confusing.
      complete(pending)
      return
    }
    invalidateState()
  }

  /**
   * Publish a new remote-output state. Main thread only.
   *
   * The `setRemotePlayback` twin of [update]: it acknowledges device-volume
   * commands and nothing else. Note that media3 only re-reads `getState()` once
   * *every* pending operation has completed
   * (`SimpleBasePlayer.updateStateForPendingOperation`), so a volume publish
   * landing while a transport command is still in flight is shown at the
   * transport command's acknowledgement — which is a beat later, never lost.
   */
  fun updateRemotePlayback(next: Snapshot) {
    snapshot = next
    if (pendingVolume.isNotEmpty()) {
      complete(pendingVolume)
      return
    }
    invalidateState()
  }

  /** Drop pending acks without publishing state. Used when the session ends. */
  fun releasePending() {
    complete(pending)
    complete(pendingVolume)
  }

  private fun complete(futures: MutableList<SettableFuture<Any?>>) {
    if (futures.isEmpty()) return
    val acknowledged = futures.toList()
    futures.clear()
    for (future in acknowledged) future.set(null)
  }

  // MARK: - State

  override fun getState(): State {
    val current = snapshot
    val derived = renderedFor(current)
    val builder = State.Builder()
      .setAvailableCommands(derived.commands)
      // Applied before the empty-timeline branch below, because a controller
      // reads them from the state regardless of whether anything is queued.
      .setSeekForwardIncrementMs(seekForwardIncrementMs)
      .setSeekBackIncrementMs(seekBackIncrementMs)
      .setRepeatMode(current.repeatMode.toMedia3())
      .setShuffleModeEnabled(current.shuffleEnabled)

    // Applied before the empty-timeline branch for the same reason the seek
    // increments are: which device the audio comes out of is true whether or
    // not anything is queued, and media3 diffs `DeviceInfo` out of whatever
    // state it last read.
    derived.deviceInfo?.let { info ->
      val remote = current.remote ?: return@let
      builder
        .setDeviceInfo(info)
        .setDeviceVolume(remote.volume)
        .setIsDeviceMuted(remote.muted)
    }

    mismatchReporter.observe(current.itemQueueMismatch)

    val timeline = derived.playlist
    if (timeline.isEmpty()) {
      // media3 asserts this pairing: "If the playlist is empty, the state must
      // be either STATE_IDLE or STATE_ENDED."
      return builder
        .setPlaybackState(Player.STATE_IDLE)
        .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        .build()
    }

    builder
      .setPlaylist(timeline)
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

  /**
   * The cached derivation for [current], rebuilt only when the snapshot itself
   * changed. See [Rendered].
   */
  private fun renderedFor(current: Snapshot): Rendered {
    val cached = rendered
    if (cached != null && cached.snapshot === current) return cached
    // `Snapshot.timeline` already carries the `setMediaItem` overlay on the
    // current entry (see `Snapshot.timeline` / `enrichedWith`), and is itself
    // computed once per snapshot.
    val next =
      Rendered(
        snapshot = current,
        commands = MediaButtons.commands(current),
        playlist = current.timeline.mapIndexed { index, item -> mediaItemData(item, index, current) },
        deviceInfo = current.remote?.toDeviceInfo(),
      )
    rendered = next
    return next
  }

  /**
   * The published output as media3's `DeviceInfo`.
   *
   * `PLAYBACK_TYPE_REMOTE` is the whole point: `MediaSessionLegacyStub`
   * rebuilds its `VolumeProviderCompat` on every `onDeviceInfoChanged` and, for
   * a remote type, calls `MediaSessionCompat.setPlaybackToRemote(provider)`.
   * The platform documents that call as the thing that routes volume keys —
   * "This must be called to receive volume button events, otherwise the system
   * will adjust the appropriate stream volume for this session"
   * (`android.media.session.MediaSession.setPlaybackToRemote`) — and it is on
   * the *session*, so it works with no Activity and with the screen locked.
   *
   * Going back to local needs no undo: publishing no remote device leaves
   * `State.Builder`'s own `DeviceInfo.UNKNOWN` (`PLAYBACK_TYPE_LOCAL`) in
   * place, media3 sees the change and calls `setPlaybackToLocal`, and the keys
   * move the phone's stream again.
   *
   * `setRoutingControllerId` only when the app knows one: it is what lets the
   * system output switcher tie its slider to the route that is playing, and a
   * wrong id would tie it to the wrong one.
   */
  private fun RemoteDevice.toDeviceInfo(): DeviceInfo =
    DeviceInfo.Builder(DeviceInfo.PLAYBACK_TYPE_REMOTE)
      .setMinVolume(0)
      .setMaxVolume(maxVolume)
      .apply { routingControllerId?.let(::setRoutingControllerId) }
      .build()

  private fun mediaItemData(item: NativeMediaItem, index: Int, snapshot: Snapshot): MediaItemData {
    // Per entry, not per snapshot: `effectiveDurationMs` folds in that entry's
    // own `isLive`, so one live track in a queue does not make the rest of the
    // queue un-seekable.
    val durationMs = item.effectiveDurationMs

    return MediaItemData.Builder(
      // media3 rejects duplicate uids in a playlist, and the same track legitimately
      // appears twice in a queue — so the index, not the id, carries identity.
      /* uid = */ "$index:${item.id}"
    )
      .setMediaItem(item.toMediaItem())
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

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    // The `play` media3 synthesises at the end of a browse tap is already
    // implied by the `playFromMediaId` the app was handed a moment ago, and
    // forwarding it would resume the *previous* track. See [MediaRequestLatch].
    // The future is still created and armed exactly as for a real command, so
    // the optimistic "playing" the surfaces show holds until the app's next
    // broadcast — the acknowledgement is unchanged, only the duplicate call is
    // dropped.
    if (playWhenReady && mediaRequest.consume()) return awaitBroadcast(pending)
    return dispatch(startsPlayback = playWhenReady) {
      if (playWhenReady) it.play() else it.pause()
    }
  }

  /**
   * Reached only as part of a browse tap or a controller's `setMediaItem`, and
   * only ever with **this player's own current timeline**: every route to it
   * goes through `MediaSession.Callback.onSetMediaItems`, which answers with
   * `snapshot.timeline` unchanged and never with the item the controller sent
   * (see `RnMediaMediaSessionService.onSetMediaItems`). So there is nothing to
   * apply — the app decides what plays, through `playFromMediaId`, and says so
   * with its next broadcast.
   *
   * Implemented rather than left to `SimpleBasePlayer`, whose default throws
   * `IllegalStateException("Missing implementation to handle COMMAND_SET_MEDIA_ITEM")`
   * the moment the command is advertised.
   */
  override fun handleSetMediaItems(
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<*> {
    val timeline = snapshot.timeline
    val foreign = mediaItems.filterNot { item ->
      timeline.any { it.id == item.mediaId }
    }
    if (foreign.isNotEmpty()) {
      // Never expected, and loud rather than silent if the invariant above ever
      // stops holding: applying it would replace the app's playlist behind its
      // back, which is the exact thing `onSetMediaItems` exists to prevent.
      Log.w(
        RnMediaMediaSessionService.TAG,
        "Ignoring setMediaItems carrying ${foreign.size} item(s) that are not in the " +
          "broadcast queue (first id: ${foreign.first().mediaId}). The app's queue is " +
          "changed by the app, never by a controller.",
      )
    }
    return Futures.immediateVoidFuture()
  }

  override fun handleStop(): ListenableFuture<*> = dispatch { it.stop() }

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
  ): ListenableFuture<*> = dispatch { it.setRate(playbackParameters.speed.toDouble()) }

  /**
   * The notification's repeat button.
   *
   * Reached only when `COMMAND_SET_REPEAT_MODE` is in `State.availableCommands`
   * — `SimpleBasePlayer` returns from `setRepeatMode()` before dispatching
   * otherwise (see [MediaButtons]). Like every other command here it is
   * forwarded and *not* applied locally: the mode changes when the app says it
   * changed, and that broadcast is what completes the returned future.
   *
   * An unknown constant is folded to `off` rather than dropped. media3's
   * `@RepeatMode` IntDef has exactly three members today; if a fourth ever
   * arrives, telling the app "off" is a state it can render, whereas silently
   * ignoring the press is a dead button.
   */
  override fun handleSetRepeatMode(repeatMode: Int): ListenableFuture<*> =
    dispatch { it.setRepeatMode(repeatMode.toRepeatMode()) }

  /** The notification's shuffle button. Same contract as [handleSetRepeatMode]. */
  override fun handleSetShuffleModeEnabled(shuffleModeEnabled: Boolean): ListenableFuture<*> =
    dispatch { it.setShuffle(shuffleModeEnabled) }

  /* ------------------------------ Remote volume ----------------------------- */

  /*
   * Reachable only while the app has published a remote device — the four
   * commands behind these live in `MediaButtons.addRemoteVolume` and are absent
   * otherwise, and `SimpleBasePlayer` returns from the corresponding public
   * setter before dispatching when a command is missing.
   *
   * The `flags` argument (`C.VolumeFlags`, e.g. `FLAG_SHOW_UI`) is deliberately
   * dropped rather than forwarded: it asks the *phone* to draw its volume
   * panel, which media3 has already handled by the time we are called, and it
   * has no meaning to a backend on the other side of the network.
   */

  /** The system's remote volume slider, or a `MediaController`. Absolute level. */
  override fun handleSetDeviceVolume(deviceVolume: Int, flags: Int): ListenableFuture<*> {
    val remote = snapshot.remote ?: return Futures.immediateVoidFuture()
    val level = remote.levelOf(deviceVolume)
    return dispatchVolume { it.setDeviceVolume(level) }
  }

  /**
   * **A hardware volume key press, with the app backgrounded or the screen
   * locked.** The whole reason the remote `DeviceInfo` exists.
   *
   * The platform delivers `VolumeProvider.onAdjustVolume(+1)`, media3 turns it
   * into `Player.increaseDeviceVolume(flags)`, and it lands here. Which JS
   * handler it becomes is decided in the TS layer from the app's declared
   * `volumeControl` — a level for an absolute backend, a bare nudge for a
   * relative one — because that declaration is unambiguous where sniffing which
   * methods an app happens to have defined is not.
   */
  override fun handleIncreaseDeviceVolume(flags: Int): ListenableFuture<*> =
    dispatchVolume { it.increaseDeviceVolume() }

  /** One notch quieter. See [handleIncreaseDeviceVolume]. */
  override fun handleDecreaseDeviceVolume(flags: Int): ListenableFuture<*> =
    dispatchVolume { it.decreaseDeviceVolume() }

  /**
   * Mute/unmute the remote device.
   *
   * media3 gates this on `COMMAND_ADJUST_DEVICE_VOLUME`, not on a mute command
   * of its own, so it rides along with the keys — including the platform's
   * `ADJUST_TOGGLE_MUTE`, which a headset or a car head unit can send.
   */
  override fun handleSetDeviceMuted(muted: Boolean, flags: Int): ListenableFuture<*> =
    dispatchVolume { it.setDeviceMuted(muted) }

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
    -> dispatch { it.skipToNext() }

    Player.COMMAND_SEEK_TO_PREVIOUS,
    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
    -> dispatch { it.skipToPrevious() }

    Player.COMMAND_SEEK_TO_MEDIA_ITEM,
    Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
    -> {
      val current = snapshot
      if (mediaItemIndex != C.INDEX_UNSET && mediaItemIndex != current.timelineIndex) {
        dispatch { it.skipToQueueItem(mediaItemIndex.toDouble()) }
      } else {
        dispatch { it.seekTo(positionMs.orZeroIfUnset()) }
      }
    }

    // COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_SEEK_BACK, COMMAND_SEEK_FORWARD.
    else -> dispatch { it.seekTo(positionMs.orZeroIfUnset()) }
  }

  private fun Long.orZeroIfUnset(): Double =
    if (this == C.TIME_UNSET) 0.0 else this.toDouble().coerceAtLeast(0.0)

  /**
   * Hand the command to [CommandDispatcher] and give media3 a future the app's
   * next broadcast will complete.
   *
   * Nitro schedules the JS invocation onto the JS thread itself, so calling
   * from this (main) thread neither blocks nor risks an ANR
   * (https://nitro.margelo.com/docs/types/callbacks).
   *
   * The future is created and armed identically whether or not a JS handler
   * exists right now. During a playback resumption there is none — the command
   * is held and replayed when the runtime arrives — and the optimistic
   * placeholder `SimpleBasePlayer` shows in the meantime is exactly the right
   * thing for the user to see, with [ACK_TIMEOUT_MS] as the honest limit on how
   * long we will pretend.
   */
  private fun dispatch(
    startsPlayback: Boolean = false,
    invoke: (MediaSessionHandlers) -> Unit,
  ): ListenableFuture<*> = dispatch(pending, startsPlayback, invoke)

  /**
   * A device-volume command: same mechanism, acknowledged by the app's next
   * `setRemotePlayback` instead of by its next `setPlaybackState`. See
   * [pendingVolume].
   */
  private fun dispatchVolume(invoke: (MediaSessionHandlers) -> Unit): ListenableFuture<*> =
    dispatch(pendingVolume, startsPlayback = false, invoke)

  private fun dispatch(
    awaiting: MutableList<SettableFuture<Any?>>,
    startsPlayback: Boolean,
    invoke: (MediaSessionHandlers) -> Unit,
  ): ListenableFuture<*> {
    commands.dispatch(startsPlayback, invoke)
    return awaitBroadcast(awaiting)
  }

  /**
   * The acknowledgement half of [dispatch], on its own so a command that is
   * deliberately *not* forwarded (the browse tap's duplicate `play`) still gets
   * the optimistic state and the same deadline.
   */
  private fun awaitBroadcast(
    awaiting: MutableList<SettableFuture<Any?>>,
  ): ListenableFuture<*> {
    val future = SettableFuture.create<Any?>()
    awaiting.add(future)
    // Without a deadline a JS handler that never broadcasts would wedge the
    // player forever: `invalidateState()` early-returns while any operation is
    // pending, so every later broadcast would be ignored too.
    mainHandler.postDelayed(
      { if (awaiting.remove(future)) future.set(null) },
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
