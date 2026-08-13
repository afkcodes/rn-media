package com.rnmediamediasession

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession.ConnectionResult
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaNotification
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionCommands
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.margelo.nitro.rnmediamediasession.AndroidMediaSessionConfig
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
 * | Service started after the process was **killed** (playback resumption) | [prepareRevival] / [beginRevival] |
 */
@OptIn(UnstableApi::class)
class RnMediaMediaSessionService : MediaLibraryService() {

  private var session: MediaLibraryService.MediaLibrarySession? = null

  /** Custom-action names last granted to controllers; re-granted only on change. */
  private var grantedCustomActions: List<String> = emptyList()

  private val main = Handler(Looper.getMainLooper())

  /**
   * Non-null from the moment [onCreate] decides this service is a **cold**
   * start that may be revived, until the revival either completes or is
   * abandoned. Main thread only.
   */
  private var revival: Revival? = null

  /**
   * A playback resumption in flight.
   *
   * Just timestamps and two flags — the interesting state lives in
   * [MediaSessionController] (the seeded snapshot and the deferred commands)
   * and in the OS (the foreground service). What this object is really for is
   * the *deadline*: a revival that stalls must end, and end loudly enough that
   * the app author knows which of the two things went wrong.
   */
  private class Revival(val config: MirroredConfig) {
    var started = false
    var startedAtMs = 0L
    /** `0` until the `ReactContext` exists — which of the two stages timed out. */
    var runtimeReadyAtMs = 0L
  }

  override fun onCreate() {
    super.onCreate()

    val controller = MediaSessionController
    val warm = controller.attachService(this)
    if (warm != null) {
      configureNotification(controller.androidConfig)
      openSession(warm)
      refresh(controller.snapshot())
      return
    }

    // Nothing was initialized in this process. Either the app was killed and
    // something wants it back (playback resumption), or there is genuinely
    // nothing to serve.
    val prepared = prepareRevival()
    if (prepared == null) {
      // The OS restarted us (START_STICKY) or a stale media button arrived, but
      // JavaScript never called `MediaService.init` in this process, and
      // playback resumption is off or has nothing to resume. There is no
      // session to serve and no handler to call; going quietly is the only
      // honest option. Staying alive would show a notification whose buttons
      // do nothing.
      Log.w(
        TAG,
        "Started with no initialized media session; stopping. " +
          "JS runtime alive: ${ReactRuntime.isAlive(this)}. " +
          "To have the service come back from this by itself, set " +
          "android.playbackResumption: true, wrap the service in withPersistence(...), " +
          "call MediaService.init(...) at JS module scope, and declare media3's " +
          "MediaButtonReceiver in your manifest."
      )
      stopWithoutEverBecomingForeground()
      return
    }

    val (config, seed) = prepared
    revival = Revival(config)
    configureNotification(config.android)
    openSession(controller.attachRevivedService(this, config, seed))
    refresh(seed)
    Log.i(
      TAG,
      "Playback resumption armed: rebuilt the session from the persisted mirror " +
        "(\"${seed.item?.title ?: seed.queue.getOrNull(seed.queueIndex)?.title}\" @ " +
        "${seed.anchor.valueMs} ms, queue ${seed.queue.size}). No JS runtime yet."
    )
  }

  /**
   * Everything about the media3 notification that comes from configuration.
   *
   * Extracted because a revived service has to do exactly the same thing from a
   * *mirrored* config read out of `SharedPreferences` — the app's real config
   * lives in JavaScript, which is what a cold start does not have.
   */
  private fun configureNotification(config: AndroidMediaSessionConfig?) {
    createNotificationChannel(config?.notificationChannelId, config?.notificationChannelName)

    val defaults = DefaultMediaNotificationProvider.Builder(this)
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
      ?.let(defaults::setSmallIcon)
    setMediaNotificationProvider(tinted(defaults, config?.notificationColor))
    applyForegroundServiceTimeout(config?.stopForegroundTimeoutMs)

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
  }

  /**
   * `notificationColor` → `Notification.color`.
   *
   * A decorator rather than a subclass, and not by preference:
   * `DefaultMediaNotificationProvider.createNotification` and
   * `handleCustomCommand` are both **`final`** in media3 1.11.0 (`javap` on the
   * shipped `media3-session` AAR), and the provider's `Builder` exposes channel
   * id, channel name, notification id and small icon — no colour. So the only
   * public lever is to let media3 build the notification exactly as it always
   * does and set the field on the result. Setting it *after* the build is also
   * what makes it stick: nothing media3 does afterwards rewrites it.
   *
   * `getNotificationChannelInfo()` is delegated rather than reimplemented — it
   * is how media3 knows which channel to create, and answering it ourselves
   * would fork a decision the provider already owns.
   *
   * Returns the provider unchanged when no colour was configured, so an app that
   * does not use this feature has exactly the object graph it had before.
   */
  private fun tinted(
    delegate: MediaNotification.Provider,
    color: Double?,
  ): MediaNotification.Provider {
    // `toLong().toInt()` rather than `toInt()`: an ARGB value with the alpha bit
    // set (0xFF1DB954 = 4_278_202_708) is larger than Int.MAX_VALUE, and
    // `Double.toInt()` saturates at Int.MAX_VALUE — silently turning opaque
    // green into white. Going through Long truncates to the low 32 bits, which
    // is the signed colour int Android wants.
    val argb = color?.toLong()?.toInt() ?: return delegate
    return object : MediaNotification.Provider {
      override fun createNotification(
        mediaSession: MediaSession,
        customLayout: ImmutableList<androidx.media3.session.CommandButton>,
        actionFactory: MediaNotification.ActionFactory,
        onNotificationChangedCallback: MediaNotification.Provider.Callback,
      ): MediaNotification {
        val built = delegate.createNotification(
          mediaSession,
          customLayout,
          actionFactory,
          onNotificationChangedCallback,
        )
        built.notification.color = argb
        return built
      }

      override fun handleCustomCommand(
        session: MediaSession,
        action: String,
        extras: Bundle,
      ): Boolean = delegate.handleCustomCommand(session, action, extras)

      override fun getNotificationChannelInfo(): MediaNotification.Provider.NotificationChannelInfo =
        delegate.notificationChannelInfo
    }
  }

  private fun openSession(player: BroadcastPlayer) {
    val built = MediaLibrarySession.Builder(this, player, LibrarySessionCallback())
      .apply { sessionActivityIntent()?.let(::setSessionActivity) }
      .build()
    session = built
    addSession(built)
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo) = session

  // MARK: - Playback resumption

  /**
   * Can this cold start be turned back into a playing session, and with what?
   *
   * Everything is read **synchronously** from `SharedPreferences` on the main
   * thread, inside `onCreate`, because the caller may be inside the five-second
   * `startForeground` window and there is nothing else to ask: the config and
   * the last session both normally live in JavaScript, which is precisely what
   * this process does not have (see [ResumptionStore]).
   *
   * `null` means "behave exactly as this service did before the feature
   * existed". Four ways to get there, each of them a legitimate configuration
   * rather than an error:
   * - nothing was ever mirrored (the app has never run, or never initialized);
   * - the app did not opt in (`android.playbackResumption` defaults to `false`);
   * - the `Application` is not a `ReactApplication` — a brownfield host owns its
   *   own runtime and this package must not guess at it;
   * - there is no persisted session to resume (no `withPersistence`, or it was
   *   cleared).
   */
  private fun prepareRevival(): Pair<MirroredConfig, Snapshot>? {
    val config = ResumptionStore.readConfig(this) ?: return null
    if (!config.android.playbackResumption) return null

    if (!ReactRuntime.canRevive(this)) {
      // One line, once, and then the pre-existing behaviour. A brownfield app
      // that embeds React Native without `ReactApplication` cannot be revived
      // by us, and crashing on the cast would be a spectacularly bad way to
      // tell it so.
      Log.w(
        TAG,
        "android.playbackResumption is on, but this Application does not implement " +
          "ReactApplication, so there is no ReactHost to start. Playback resumption is " +
          "disabled for this process."
      )
      return null
    }

    val seed = ResumptionStore.readSession(this)
    if (seed == null) {
      Log.i(
        TAG,
        "android.playbackResumption is on, but nothing was mirrored to resume. " +
          "Wrap the service in withPersistence(service, storage) — that is what writes it."
      )
      return null
    }
    return config to seed
  }

  /**
   * Start (or join) a revival. Main thread only. Returns `true` while one is in
   * flight, which is what tells [MediaSessionController] a command is worth
   * holding rather than dropping.
   *
   * The order of the first three steps is the whole design:
   *
   * 1. **Become foreground immediately**, with a real notification built from
   *    the mirrored snapshot. Whoever woke us used `startForegroundService()`
   *    and that call carries a five-second promise whose breach
   *    (`ForegroundServiceDidNotStartInTimeException`) is uncatchable. Waiting
   *    for media3 to promote us cannot work here: media3 promotes on
   *    `playWhenReady && (STATE_READY || STATE_BUFFERING)`, and until the app's
   *    runtime is up `SimpleBasePlayer` is showing an optimistic placeholder
   *    that keeps `STATE_IDLE`. A cold React start is 300 ms–2 s *before* the
   *    app's own JavaScript runs. So this one transition is ours; every later
   *    one goes back to media3 (step 3).
   * 2. **Then** start the runtime — never before, because nothing about JS is
   *    fast enough to be inside a deadline.
   * 3. **Then** flip the session to `buffering`, which hands promotion back to
   *    media3: it posts its own media notification over ours (same id — media3's
   *    `DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID`) and owns
   *    every transition from there.
   *
   * @param startsPlayback `true` when the command that got us here was a
   * request to play. A media-button intent that is *not* a play still revives —
   * the app is being asked for something — but does not claim to be buffering.
   */
  internal fun beginRevival(startsPlayback: Boolean): Boolean {
    val pending = revival ?: return false

    if (!pending.started) {
      pending.started = true
      pending.startedAtMs = SystemClock.elapsedRealtime()

      postResumptionNotification(pending.config.android)

      if (!ReactRuntime.startRuntime(this) { onRuntimeReady() }) {
        abandonRevival("ReactHost.start() could not be issued")
        return false
      }
      main.postDelayed(watchdog, REVIVAL_TIMEOUT_MS)
      Log.i(TAG, "Playback resumption: foreground held, booting the JS runtime.")
    }

    if (startsPlayback) MediaSessionController.markResuming()
    return true
  }

  /** The `ReactContext` exists. Main thread (RN's contract for this listener). */
  private fun onRuntimeReady() {
    val pending = revival ?: return
    pending.runtimeReadyAtMs = SystemClock.elapsedRealtime()
    Log.i(
      TAG,
      "Playback resumption: JS runtime up after " +
        "${pending.runtimeReadyAtMs - pending.startedAtMs} ms. " +
        "Waiting for MediaService.init(...)."
    )
  }

  /**
   * `MediaService.init` ran. Main thread only.
   *
   * @return `true` when this actually ended a revival, which is how
   * [MediaSessionController] knows whether to tell the app's handler
   * `onPlaybackResumption`.
   */
  internal fun onRevivalComplete(): Boolean {
    val pending = revival ?: return false
    revival = null
    main.removeCallbacks(watchdog)
    val now = SystemClock.elapsedRealtime()
    Log.i(
      TAG,
      "Playback resumption complete in ${now - pending.startedAtMs} ms " +
        "(runtime ${pending.runtimeReadyAtMs - pending.startedAtMs} ms, " +
        "init ${now - pending.runtimeReadyAtMs} ms). Handing the session to JavaScript."
    )
    return true
  }

  /**
   * The deadline. Fires only when a revival never finished, and its whole job
   * is to say *which* half did not happen — the two failures have completely
   * different fixes and are indistinguishable from the outside.
   */
  private val watchdog = Runnable {
    val pending = revival ?: return@Runnable
    abandonRevival(
      if (pending.runtimeReadyAtMs == 0L) {
        "the JS runtime did not start within $REVIVAL_TIMEOUT_MS ms"
      } else {
        "the JS runtime started but MediaService.init(...) was never called. Playback " +
          "resumption requires init at JS MODULE SCOPE: a revived runtime loads your bundle " +
          "but mounts no component, so an init inside a React effect or a screen never runs. " +
          "Move it next to your player, at the top level of a module the bundle imports."
      }
    )
  }

  /**
   * Give up, cleanly. Main thread only.
   *
   * "Cleanly" is load-bearing: we are foreground with a notification for audio
   * that is never going to start, so the notification has to go *and* the
   * service has to stop — [releaseAndStop] does both, and it is the same path
   * `stopService()` takes, so there is one shutdown sequence rather than two.
   */
  private fun abandonRevival(reason: String) {
    if (revival == null) return
    revival = null
    main.removeCallbacks(watchdog)
    Log.w(TAG, "Playback resumption abandoned: $reason. Stopping the media service.")
    MediaSessionController.discardRevival()
    releaseAndStop()
  }

  /**
   * The bridge notification: what the user looks at between the OS creating
   * this service and media3 taking the notification over.
   *
   * Three properties, none of them incidental:
   * - **It is a `MediaStyle` notification bound to the real session token.**
   *   That is what exempts it from `POST_NOTIFICATIONS` on Android 13+
   *   ("POST_NOTIFICATIONS permission is not required for media session related
   *   notifications"), and it is why the system draws it with the session's own
   *   transport controls instead of as a bare service notification.
   * - **It carries the persisted metadata**, not a placeholder. The user asked
   *   for a specific track back; showing them an empty notification for two
   *   seconds would be worse than showing nothing.
   * - **It uses media3's own notification id**
   *   (`DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID`), so media3's
   *   first real notification *replaces* it rather than appearing beside it.
   *   The provider is built without `setNotificationId`, so that constant is
   *   the id it will use.
   *
   * `startForeground` can refuse (Android 12+ background-start rules). That is
   * caught rather than propagated, on the same reasoning as
   * [stopWithoutEverBecomingForeground]: if the OS will not let us be
   * foreground it is also not holding us to the promise.
   */
  @Suppress("DEPRECATION")
  private fun postResumptionNotification(config: AndroidMediaSessionConfig) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val current = session ?: return
    val snapshot = MediaSessionController.snapshot()
    val item = snapshot.timeline.getOrNull(snapshot.timelineIndex)

    val icon = config.notificationIcon
      ?.let { MediaButtons.drawableResId(this, it) }
      ?.takeIf { it != 0 }
      ?: androidx.media3.session.R.drawable.media3_notification_small_icon

    try {
      val notification = android.app.Notification.Builder(this, config.notificationChannelId)
        .setSmallIcon(icon)
        .setContentTitle(item?.title ?: applicationInfo.loadLabel(packageManager))
        .setContentText(item?.artist)
        .setOnlyAlertOnce(true)
        .setStyle(
          android.app.Notification.MediaStyle().setMediaSession(current.platformToken)
        )
        .apply { sessionActivityIntent()?.let(::setContentIntent) }
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
      } else {
        startForeground(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID, notification)
      }
    } catch (error: Throwable) {
      Log.w(TAG, "Could not post the playback-resumption notification.", error)
    }
  }

  /**
   * A start request while a revival is armed.
   *
   * `super` is media3's, and it is what turns an `ACTION_MEDIA_BUTTON` intent
   * into a play command on the session — but only *after* this method has made
   * us foreground, which is the ordering the five-second contract requires.
   *
   * A **null** intent is the system restarting us stickily, with nobody asking
   * for anything. Reviving there would boot the whole app spontaneously, minutes
   * after a kill, for no user-visible reason; so that case stops instead. A
   * resumption is always someone pressing something.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (revival != null) {
      if (intent == null) {
        abandonRevival("the system restarted the service with no request to resume")
        return START_NOT_STICKY
      }
      beginRevival(startsPlayback = false)
    }
    return super.onStartCommand(intent, flags, startId)
  }

  /**
   * `MediaService.stopService()` — the only thing that ends background
   * execution (PLAN §5.4). Main thread only.
   *
   * Order matters. The session is released first: media3 documents that "the
   * service will be destroyed when all sessions are released", and releasing it
   * is also what disconnects the internal notification controller so nothing
   * re-posts the notification behind us. `stopForeground(STOP_FOREGROUND_REMOVE)`
   * then removes the notification *if it is still the foreground notification*
   * — and `cancelMediaNotification()` removes it when it is not, which is the
   * common case (see below, and bug #46).
   */
  internal fun releaseAndStop() {
    session?.let {
      removeSession(it)
      it.release()
    }
    session = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    cancelMediaNotification()
    stopSelf()
  }

  /**
   * Cancel the media notification explicitly — `stopForeground` alone cannot.
   *
   * **The trap (#46):** once the service has been *demoted* — media3's
   * `stopForegroundOnPause` behaviour, which runs `notificationManager.notify(id,
   * notification)` followed by `stopForeground(removeNotification = false)`
   * (`MediaNotificationManager.updateNotificationInternal`, media3 1.11.0) —
   * the media notification is an ordinary posted notification that no longer
   * belongs to the foreground service. A later
   * `stopForeground(STOP_FOREGROUND_REMOVE)` is then a no-op on it, and
   * `stopService()` leaves a live-buttoned notification behind (observed on
   * device: stop pressed at 01:01:36, notification still tappable at 01:01:50,
   * 2026-08-13). media3's own removal spells out the recipe this method
   * completes — `MediaNotificationManager.removeNotification`: "To hide the
   * notification on all API levels, we need to call both
   * Service.stopForeground(true) and notificationManagerCompat.cancel(
   * notificationId)" (media3 1.11.0). media3 does run that removal itself when
   * the released session's controller disconnects, but that cleanup is an
   * async future chain racing our `stopSelf()`; this synchronous cancel does
   * not race anything.
   *
   * The id is `DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID`
   * (1001) by the same invariant [postResumptionNotification] relies on: the
   * provider is built without `setNotificationId`, so that constant is the id
   * it uses.
   */
  private fun cancelMediaNotification() {
    getSystemService(NotificationManager::class.java)
      ?.cancel(DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID)
  }

  override fun onDestroy() {
    revival = null
    main.removeCallbacks(watchdog)
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
   * That grace period is now configurable rather than fixed: see
   * [applyForegroundServiceTimeout] and the `stopForegroundTimeoutMs` config
   * option. It is left at media3's default when the app does not set it,
   * because the grace period is what makes a resume-from-notification
   * survivable.
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
   * `stopForegroundTimeoutMs` → `MediaSessionService.setForegroundServiceTimeoutMs`.
   *
   * media3 1.11 does not demote a paused service straight away; it keeps it
   * foreground for a "user engaged" grace period and only then runs
   * [onUpdateNotificationAsync] again. That period is
   * `DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS` = **600 000 ms**, and this setter is
   * the only public lever on it (`MediaNotificationManager.shouldRunInForeground`
   * and `isAnySessionUserEngaged` are both package-private/private).
   *
   * Verified against the shipped 1.11.0 AAR (`javap`:
   * `public final void setForegroundServiceTimeoutMs(long)`, `@UnstableApi`,
   * and `DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS` with `ConstantValue: long
   * 600000l`) and against
   * https://github.com/androidx/media/blob/1.11.0/libraries/session/src/main/java/androidx/media3/session/MediaSessionService.java#L643-L668
   *
   * Three properties of the media3 implementation this code depends on:
   * - **It must be called once the service context exists**, i.e. from
   *   `onCreate` after `super.onCreate()`, on the main thread — the setter
   *   dereferences `getMediaNotificationManager()`, which `checkNotNull`s the
   *   base context.
   * - **It is called after `setMediaNotificationProvider`.** In media3 < 1.6.1
   *   the reverse order force-created the notification manager with the default
   *   provider and silently discarded ours (androidx/media#2305). 1.11.0
   *   contains the fix; the ordering is kept anyway because it costs nothing.
   * - **The value is `Util.constrainValue(v, 0, 600_000)`** — a bigger number is
   *   clamped *down*, a negative one is clamped up to 0 with no complaint. The
   *   TS layer rejects negatives so that clamp is never reached silently; the
   *   `coerceIn` here is belt-and-braces for a value that arrived some other way.
   *
   * Applied when the service is created, which is the first `playing`
   * broadcast — a later `init` with a different value does not retro-fit a
   * running service.
   */
  private fun applyForegroundServiceTimeout(timeoutMs: Double?) {
    val requested = timeoutMs ?: return
    val clamped = requested.toLong().coerceIn(0L, DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)
    setForegroundServiceTimeoutMs(clamped)
    Log.i(
      TAG,
      "Foreground-service timeout set to $clamped ms " +
        "(media3 default ${DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS} ms).",
    )
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
     * "Play something, there is no current item" — the media3 contract behind
     * the System UI resumption card, a Bluetooth reconnect and a headset play
     * after the process is gone.
     *
     * Verified against media3 1.11.0 (`javap` on the shipped AAR:
     * `onPlaybackResumption(MediaSession, ControllerInfo, boolean)`, `@UnstableApi`;
     * the two-argument overload is deprecated in favour of this one) and against
     * `MediaSessionImpl.handleMediaControllerPlayRequestInternal` /
     * `MediaLibrarySessionImpl.getRecentMediaItemAtDeviceBootTime` in
     * https://github.com/androidx/media/blob/1.11.0/.
     *
     * Both call sites are real here and they want different things:
     * - `isForPlayback = false` — the System UI is *populating* its resumption
     *   card and only needs one item with enough metadata to draw it. media3
     *   reaches this only while the player is `STATE_IDLE`, which is exactly why
     *   the mirrored snapshot is seeded as `stopped` (see
     *   `ResumptionStore.readSession`). No playback is being requested and none
     *   is started.
     * - `isForPlayback = true` — a play arrived with no current media item.
     *   Reachable when nothing was mirrored; in the normal case the timeline is
     *   already seeded from the mirror, so media3 takes the shorter
     *   `hasCurrentMediaItem` branch and plays without asking. Answering
     *   correctly anyway costs nothing and keeps the two paths from disagreeing.
     *
     * The position is the *frozen* one from the mirror (ARCHITECTURE §19: a
     * persisted anchor is re-stamped and never projected across the gap), so a
     * card tapped a day later resumes where the user left off rather than a day
     * into the track.
     */
    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      isForPlayback: Boolean,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val snapshot = MediaSessionController.snapshot()
      val timeline = snapshot.timeline
      if (timeline.isEmpty()) {
        // media3 turns a failed future into a warning and plays anyway; an
        // empty list would be turned into ERROR_INVALID_STATE for the card.
        // Either way "there is nothing to resume" is the honest answer.
        return Futures.immediateFailedFuture(
          IllegalStateException("No persisted session to resume.")
        )
      }
      Log.i(
        TAG,
        "onPlaybackResumption(isForPlayback=$isForPlayback): serving " +
          "${timeline.size} item(s) from index ${snapshot.timelineIndex} " +
          "@ ${snapshot.anchor.valueMs} ms."
      )
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(
          timeline.map { it.toMediaItem() },
          snapshot.timelineIndex,
          snapshot.anchor.valueMs,
        )
      )
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
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Pre-O there is no startForeground() contract to satisfy —
      // `startForegroundService` itself is API 26+ — and the two-arg
      // `Notification.Builder(Context, String)` below does not exist either
      // (lint NewApi). A plain stop is already safe here.
      stopSelf()
      return
    }

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
     * How long a playback resumption may hold a foreground service before it is
     * declared a failure.
     *
     * It has to cover a React Native cold start (measured 300 ms–2 s, and worse
     * on a cold page cache) *plus* whatever the app's own module-scope code does
     * before it reaches `MediaService.init`. Ten seconds is several times the
     * worst case observed here, and the cost of being wrong in the generous
     * direction is a notification that lingers a few extra seconds — while
     * being wrong in the strict direction kills a resumption that would have
     * worked. It is not configurable on purpose: an app that needs longer than
     * this has a startup problem no timeout will fix.
     */
    private const val REVIVAL_TIMEOUT_MS = 10_000L

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
