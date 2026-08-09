package com.rnmediamediasession

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession.ConnectionResult
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import org.json.JSONObject

/**
 * The foreground service that owns the media3 session.
 *
 * Nothing here decides *what* plays. It exists to hold: the `MediaLibrarySession`
 * (which is what the notification, lock screen, Bluetooth, Wear and Android Auto
 * all talk to), the foreground-service lifecycle, and the notification
 * configuration. Playback state comes from [MediaSessionController], commands go
 * back out through it.
 *
 * ## Foreground-service lifecycle (PLAN §5.6 — the RNTP scar-tissue list)
 *
 * media3 owns the actual `startForeground`/`stopForeground` transitions and has
 * since 1.x; hand-rolling them is how apps end up with
 * `ForegroundServiceDidNotStartInTimeException`. The relevant internal rule is
 * `MediaNotificationManager.isAnySessionUserEngaged`:
 * `playWhenReady && (STATE_READY || STATE_BUFFERING)`. Everything below is
 * expressed in terms of nudging that predicate rather than fighting it.
 *
 * | Edge case | Handled where |
 * |---|---|
 * | Android 12+ `ForegroundServiceStartNotAllowedException` (can't start an FGS from the background) | [MediaSessionController.startService] only starts from a play command, and [onForegroundServiceStartNotAllowedException] below reports the loss when the OS refuses anyway |
 * | Android 14 FGS type enforcement | `foregroundServiceType="mediaPlayback"` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` in this package's manifest; media3 passes the matching runtime type |
 * | Android 13+ notification redesign (controls derive from the session) | media button preferences, rebuilt on every broadcast — see [refresh] |
 * | `stopForegroundOnPause` | [onUpdateNotificationAsync] |
 * | Notification swipe-dismiss | media3's `setDeleteIntent(createNotificationDismissalIntent(...))`; the service is already demoted by then, so a dismiss stops it |
 * | Task removal (app swiped away) | [onTaskRemoved] |
 * | Service restarted by the OS with no JS runtime | [onCreate]'s `stopSelf` guard |
 */
@OptIn(UnstableApi::class)
class RnMediaMediaSessionService : MediaLibraryService() {

  private var session: MediaLibraryService.MediaLibrarySession? = null

  /** Custom-action names last granted to controllers; re-granted only on change. */
  private var grantedCustomActions: List<String> = emptyList()

  override fun onCreate() {
    super.onCreate()

    val controller = MediaSessionController
    val player = controller.attachService(this)
    if (player == null) {
      // The OS restarted us (START_STICKY) or a stale media button arrived, but
      // JavaScript never called `MediaService.init` in this process. There is
      // no session to serve and no handler to call; going quietly is the only
      // honest option. Staying alive would show a notification whose buttons
      // do nothing.
      Log.w(
        TAG,
        "Started with no initialized media session; stopping. " +
          "JS runtime alive: ${ReactRuntime.isAlive(this)}. " +
          "If this happened after the app was killed, the app must call " +
          "MediaService.init(...) again before playback can resume — reviving a " +
          "session across process death is not a v1 feature (see ReactRuntime)."
      )
      stopWithoutEverBecomingForeground()
      return
    }

    val config = controller.androidConfig
    createNotificationChannel(config?.notificationChannelId, config?.notificationChannelName)

    val provider = DefaultMediaNotificationProvider.Builder(this)
      .apply { config?.notificationChannelId?.let { setChannelId(it) } }
      .build()
    // `setChannelName` takes a *string resource id*, which a runtime-configured
    // name cannot be. Instead the channel is pre-created above with the app's
    // name; media3's `Util.ensureNotificationChannel` is documented to return
    // early when the channel already exists, so its default name is never used.
    config?.notificationIcon
      ?.let { MediaButtons.drawableResId(this, it) }
      ?.takeIf { it != 0 }
      // Left at media3's own `media3_notification_small_icon` when the app did
      // not name one, or named one that does not resolve: an unset/invalid
      // small icon makes `Notification` throw, which would take the
      // foreground-service start down with it.
      ?.let(provider::setSmallIcon)
    setMediaNotificationProvider(provider)

    setListener(object : Listener {
      override fun onForegroundServiceStartNotAllowedException() {
        // Android 12+ refused to promote us. media3 has already given up on the
        // notification; playback (if the app really did start it) is now a
        // background process the OS may kill at any moment.
        Log.e(
          TAG,
          "The system refused to start the media foreground service. Playback was " +
            "started while the app was in the background without an exemption " +
            "(Android 12+ restriction). Start playback from the foreground, or in " +
            "response to a media button."
        )
      }
    })

    val built = MediaLibrarySession.Builder(this, player, LibrarySessionCallback())
      .apply { sessionActivityIntent()?.let(::setSessionActivity) }
      .build()
    session = built
    addSession(built)
    refresh(controller.snapshot())
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

  /**
   * `MediaService.stopService()` — the only thing that ends background
   * execution (PLAN §5.4). Main thread only.
   *
   * Order matters. The session is released first: media3 documents that "the
   * service will be destroyed when all sessions are released", and releasing it
   * is also what disconnects the internal notification controller so nothing
   * re-posts the notification behind us. `stopForeground(STOP_FOREGROUND_REMOVE)`
   * then guarantees the notification is gone even if the service outlives this
   * call because something is still bound to it.
   */
  internal fun releaseAndStop() {
    session?.let {
      removeSession(it)
      it.release()
    }
    session = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    session?.let {
      removeSession(it)
      it.release()
    }
    session = null
    MediaSessionController.detachService(this)
    super.onDestroy()
  }

  /**
   * Push the current broadcast onto the session. Main thread only.
   *
   * Media button preferences carry both the transport buttons and the custom
   * actions; the custom actions additionally have to be *granted* as session
   * commands or media3 renders them disabled ("The `CommandButton.isEnabled`
   * flag is set according to the available commands of the controller and
   * overrides a value that may have been set by the app").
   */
  internal fun refresh(snapshot: Snapshot) {
    val current = session ?: return
    val customActions = snapshot.customActions.map { it.name }
    if (customActions != grantedCustomActions) {
      grantedCustomActions = customActions
      val commands = sessionCommands(snapshot)
      for (controller in current.connectedControllers) {
        current.setAvailableCommands(controller, commands, ConnectionResult.DEFAULT_PLAYER_COMMANDS)
      }
    }
    current.setMediaButtonPreferences(MediaButtons.buttons(this, snapshot))
  }

  /**
   * `stopForegroundOnPause`.
   *
   * `true` (the default, and audio_service's) is media3's own behaviour: on
   * pause it eventually calls `stopForeground(removeNotification = false)`, so
   * the notification survives but the service is demoted — and a demoted
   * service is killable. That is the documented trade-off; a persistence
   * decorator on the JS side is the mitigation (PLAN §5.4).
   *
   * MEASURED on media3 1.11 (device: Android 16, 2026-08-09): the demotion is
   * **not immediate**. `MediaNotificationManager.shouldRunInForeground` keeps
   * the service foreground for a "user engaged" grace period after the pause —
   * `MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`, i.e. 10
   * minutes — and only then posts the demotion. `dumpsys activity services`
   * therefore still shows `isForeground=true` immediately after a pause; that
   * is media3's Android 14+ behaviour, not a missing transition here.
   * `setForegroundServiceTimeoutMs(0)` would restore instant demotion; whether
   * this package should do that is an open decision, because the grace period
   * is what makes a resume-from-notification survivable.
   *
   * `false` forces `startInForegroundRequired`, keeping the service in the
   * foreground while paused. More robust, at the cost of an ongoing
   * notification the user cannot dismiss. Note that forcing it can itself throw
   * `ForegroundServiceStartNotAllowedException` if the pause happened while the
   * app was in the background — media3 catches that and routes it to the
   * listener installed in [onCreate].
   */
  override fun onUpdateNotificationAsync(
    session: MediaSession,
    startInForegroundRequired: Boolean,
  ): ListenableFuture<Void?> {
    val stopOnPause = MediaSessionController.androidConfig?.stopForegroundOnPause ?: true
    return super.onUpdateNotificationAsync(session, startInForegroundRequired || !stopOnPause)
  }

  /**
   * The app was swiped out of Recents.
   *
   * Two things happen, in this order and deliberately independent:
   *
   * 1. The JS handler is told. It is fire-and-forget — the app may want to
   *    persist state or log, and it may call `stopService()` itself. It must
   *    not be able to *block* the decision below, because at this moment the JS
   *    runtime is the least trustworthy thing in the process.
   * 2. The default policy runs natively: keep playing if we really are playing,
   *    otherwise stop. This is audio_service's behaviour and, as of 1.10, also
   *    media3's own default. It is restated here rather than delegated to
   *    `super` because `super` decides with a private `isAnySessionPlaying()`
   *    over the media3 player, while the truth we trust is the app's last
   *    broadcast.
   *
   * media3's warning applies and is why the `else` branch is unconditional:
   * "if playback is not ongoing, the service must be terminated otherwise the
   * service will be crashed and restarted by the system."
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    MediaSessionController.notifyTaskRemoved()

    val playing = MediaSessionController.snapshot().status == MediaPlaybackStatus.PLAYING
    if (isPlaybackOngoing && playing) return

    // Also pauses every session's player, which routes back through
    // `handleSetPlayWhenReady` -> the JS `pause` handler, so the app learns it
    // was stopped. That only fires if COMMAND_PLAY_PAUSE is advertised; the
    // service is stopped either way.
    pauseAllPlayersAndStopSelf()
  }

  // MARK: - Session callback

  private inner class LibrarySessionCallback : MediaLibrarySession.Callback {

    override fun onConnectAsync(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<ConnectionResult> {
      val snapshot = MediaSessionController.snapshot()
      return Futures.immediateFuture(
        ConnectionResult.AcceptedResultBuilder(session, controller)
          .setAvailableSessionCommands(sessionCommands(snapshot))
          .setMediaButtonPreferences(MediaButtons.buttons(this@RnMediaMediaSessionService, snapshot))
          .build()
      )
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      val handlers = MediaSessionController.handlers
        ?: return Futures.immediateFuture(SessionResult(SessionError.ERROR_INVALID_STATE))
      handlers.customAction(customCommand.customAction, bundleToJson(args))
      // Accepted and dispatched. As everywhere else in this package, the
      // acknowledgement the user sees is the app's next broadcast, not this.
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }

    /**
     * Android Auto / Wear browse root.
     *
     * v1 serves an empty but *valid* tree rather than `ERROR_NOT_SUPPORTED`:
     * a valid root is what makes Auto and the System UI resumption surface list
     * the app at all, and returning an error there is indistinguishable from a
     * crash to the user. The handler methods that would fill it in
     * (`getChildren`/`getMediaItem`) are reserved on the JS side and not yet
     * wired — see the spec's "explicitly out of scope for v1".
     */
    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> =
      Futures.immediateFuture(LibraryResult.ofItem(browseRoot(), params))

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
      // "Return an empty list for no children rather than using error codes."
      Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.of(), params))

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> =
      if (mediaId == ROOT_ID) {
        Futures.immediateFuture(LibraryResult.ofItem(browseRoot(), null))
      } else {
        Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_NOT_SUPPORTED))
      }
  }

  // MARK: - Helpers

  private fun sessionCommands(snapshot: Snapshot): SessionCommands =
    ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
      .apply { MediaButtons.sessionCommands(snapshot).forEach { add(it) } }
      .build()

  private fun browseRoot(): MediaItem =
    MediaItem.Builder()
      .setMediaId(ROOT_ID)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(applicationInfo.loadLabel(packageManager))
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .build()
      )
      .build()

  /**
   * Tapping the notification should open the app. Resolved from the consumer's
   * own launcher activity so this package never has to know its class name.
   */
  private fun sessionActivityIntent(): PendingIntent? {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      /* requestCode = */ 0,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /**
   * Create the channel ourselves so the app's configured *name* is used.
   *
   * media3 would otherwise create it from a string resource we cannot supply at
   * runtime. Creating it first wins, because `ensureNotificationChannel`
   * returns early when `getNotificationChannel(channelId) != null`.
   */
  /**
   * Leave, without tripping the foreground-service contract.
   *
   * A plain `stopSelf()` here is a process kill, not a clean exit. Whoever woke
   * us — a media button, playback resumption, `START_STICKY` — did it with
   * `startForegroundService()`, and that call carries a promise: this service
   * *will* call `startForeground()` within ~5 s. Breaking the promise earns
   * `RemoteServiceException$ForegroundServiceDidNotStartInTimeException`, which
   * is not catchable and takes the whole process down. Reproduced on Android 16
   * (2026-08-09) by starting the service with no `MediaService.init` in the
   * process, which is exactly the after-process-death media-button path this
   * branch exists to handle.
   *
   * So: post a notification, become foreground, and immediately drop both. The
   * notification exists for a few milliseconds and is never drawn.
   *
   * `startForeground` can itself refuse (Android 12+ background-start rules).
   * That is caught rather than propagated — if the OS will not let us be
   * foreground it is also not going to hold us to the promise, and there is
   * nothing useful left to do but stop.
   */
  private fun stopWithoutEverBecomingForeground() {
    val channelId = MediaSessionController.androidConfig?.notificationChannelId
      ?: PLACEHOLDER_CHANNEL_ID
    createNotificationChannel(
      channelId,
      MediaSessionController.androidConfig?.notificationChannelName
        ?: PLACEHOLDER_CHANNEL_NAME,
    )

    try {
      val notification = android.app.Notification.Builder(this, channelId)
        // media3's own small icon: guaranteed to resolve, because this module
        // depends on media3-session. A missing/zero icon makes Notification
        // throw, which would defeat the entire point of this method.
        .setSmallIcon(androidx.media3.session.R.drawable.media3_notification_small_icon)
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          PLACEHOLDER_NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
      } else {
        startForeground(PLACEHOLDER_NOTIFICATION_ID, notification)
      }
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (error: Throwable) {
      Log.w(TAG, "Could not satisfy the startForeground() contract before stopping.", error)
    }

    stopSelf()
  }

  private fun createNotificationChannel(id: String?, name: String?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (id.isNullOrEmpty() || name.isNullOrEmpty()) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(id) != null) return
    manager.createNotificationChannel(
      android.app.NotificationChannel(
        id,
        name,
        // LOW: a media notification must never make a sound or peek. The
        // transport controls are the point, not the alert.
        NotificationManager.IMPORTANCE_LOW,
      ).apply { setShowBadge(false) }
    )
  }

  internal companion object {
    const val TAG = "RnMediaMediaSession"
    const val ROOT_ID = "rn-media-root"

    /**
     * Channel + id for the throwaway notification in
     * [stopWithoutEverBecomingForeground]. Only used when the service was woken
     * with no configuration to borrow, i.e. after process death.
     */
    private const val PLACEHOLDER_CHANNEL_ID = "rn-media-session-transient"
    private const val PLACEHOLDER_CHANNEL_NAME = "Playback"
    private const val PLACEHOLDER_NOTIFICATION_ID = 1002

    /**
     * Flatten a `Bundle` into a JSON object string for the JS `customAction`
     * handler.
     *
     * Only scalars and strings survive. A `Bundle` from a third-party
     * `MediaController` can contain `Parcelable`s that have no JSON shape at
     * all; those are rendered with `toString()` rather than silently dropped,
     * so the app can at least see that something arrived.
     */
    fun bundleToJson(bundle: Bundle): String {
      if (bundle.isEmpty) return "{}"
      val json = JSONObject()
      for (key in bundle.keySet()) {
        when (val value = @Suppress("DEPRECATION") bundle.get(key)) {
          null -> json.put(key, JSONObject.NULL)
          is String, is Boolean, is Int, is Long, is Double -> json.put(key, value)
          is Float -> json.put(key, value.toDouble())
          is Short -> json.put(key, value.toInt())
          is Byte -> json.put(key, value.toInt())
          else -> json.put(key, value.toString())
        }
      }
      return json.toString()
    }
  }
}
