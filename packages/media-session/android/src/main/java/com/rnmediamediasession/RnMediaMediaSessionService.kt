package com.rnmediamediasession

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession.ConnectionResult
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
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
import com.google.common.util.concurrent.SettableFuture
import com.margelo.nitro.core.Promise
import com.margelo.nitro.rnmediamediasession.AndroidMediaSessionConfig
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.NativeBrowseItem
import com.margelo.nitro.rnmediamediasession.NativeBrowseResult
import com.margelo.nitro.rnmediamediasession.NativeSearchFocus
import com.margelo.nitro.rnmediamediasession.SessionErrorCode
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
 * With **one** exception, and it is the same one every time: the *first*
 * transition after a start this package (or media3's receiver) asked for.
 * `startForegroundService()` is a promise with an uncatchable penalty, media3
 * only promotes once its predicate holds, and nothing guarantees the predicate
 * still holds by the time media3 looks. So [onStartCommand] keeps that first
 * promise itself — see [keepForegroundPromise] for the warm path,
 * [beginRevival] for the cold one and [stopWithoutEverBecomingForeground] for
 * the one with nothing to serve — and hands every transition after it back to
 * media3.
 *
 * | Edge case | Handled where |
 * |---|---|
 * | `startForegroundService()` promised a `startForeground()` that media3 may never make | [keepForegroundPromise] (warm), [beginRevival] (cold), [stopWithoutEverBecomingForeground] (nothing to serve) |
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
   * Connected controllers media3 classifies as a car, and which kind. Main
   * thread only (media3's application looper is the main looper here).
   *
   * The set — not a boolean — because two can be connected at once (a phone in
   * an Automotive OS car), and because a disconnect must only clear the
   * connection when the *last* car goes.
   */
  private val carControllers = mutableMapOf<MediaSession.ControllerInfo, String>()

  /**
   * Parents that were answered from [BrowseCache] because no JS runtime existed
   * yet, so the browser can be told to ask again once one does. Main thread
   * only; drained by [flushBrowseRevival].
   */
  private val staleBrowseParents = LinkedHashSet<String>()

  /**
   * The root-children cap the *browser* asked for, when it asked for a smaller
   * one than the four the TypeScript layer already enforces
   * (`EXTRAS_KEY_ROOT_CHILDREN_LIMIT`). Main thread only.
   */
  private var rootChildrenLimit = DEFAULT_ROOT_CHILDREN_LIMIT

  /** Distinct request codes for error-resolution `PendingIntent`s. */
  private var resolutionRequestCode = 0

  private val browseCache: BrowseCache by lazy { BrowseCache.of(this) }

  private val artwork: ArtworkRegistry by lazy { ArtworkRegistry.of(this) }

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
    /**
     * `true` when [MediaSessionController.requestRevival] delivered an
     * `onRevivalRequested` to a live runtime. Only read by the watchdog, whose
     * message has to distinguish "the app was asked to re-init and did not"
     * from "nothing could have asked it" — the fixes are different.
     */
    var requestDelivered = false
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
    val icon = config?.notificationIcon
    val iconResId = icon?.let { MediaButtons.drawableResId(this, it) } ?: 0
    if (icon != null && iconResId == 0) {
      // The silent no-op this channel exists for: a typo in a drawable *name*
      // was answered by a different-looking notification and nothing else.
      SessionErrors.report(
        SessionErrorCode.ICONNOTFOUND,
        "android.notificationIcon names \"$icon\", which does not resolve to a drawable or " +
          "mipmap in this app's resources. media3's generic small icon is being used " +
          "instead. The name is the resource file name without its extension " +
          "(res/drawable/ic_notification.xml -> \"ic_notification\").",
        dedupeKey = "icon:$icon",
      )
    }
    // Left at media3's own `media3_notification_small_icon` when the app did
    // not name one, or named one that does not resolve: an unset/invalid
    // small icon makes `Notification` throw, which would take the
    // foreground-service start down with it.
    if (iconResId != 0) defaults.setSmallIcon(iconResId)
    setMediaNotificationProvider(tinted(defaults, config?.notificationColor))
    applyForegroundServiceTimeout(config?.stopForegroundTimeoutMs)

    setListener(object : Listener {
      override fun onForegroundServiceStartNotAllowedException() {
        // Android 12+ refused to promote us. media3 has already given up on the
        // notification; playback (if the app really did start it) is now a
        // background process the OS may kill at any moment. The second of the
        // two refusal sites — the other is `MediaSessionController.startService`,
        // where *our* start is refused rather than media3's promotion — and both
        // carry the same code, because the consequence for the app is the same.
        SessionErrors.report(
          SessionErrorCode.BACKGROUNDPLAYBACKUNAVAILABLE,
          "The system refused to start the media foreground service. Playback was " +
            "started while the app was in the background without an exemption " +
            "(Android 12+ restriction). Start playback from the foreground, or in " +
            "response to a media button.",
          severe = true,
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
      // media3's own default loader with a failure report attached — see
      // `ReportingBitmapLoader` for why supplying one changes nothing else.
      .setBitmapLoader(ReportingBitmapLoader.mediaSessionDefault(this))
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
  internal fun beginRevival(startsPlayback: Boolean, promotes: Boolean = true): Boolean {
    val pending = revival ?: return false

    if (!pending.started) {
      pending.started = true
      pending.startedAtMs = SystemClock.elapsedRealtime()

      // The seeded snapshot is deliberately `stopped` (see `ResumptionStore`),
      // so this path cannot ask [keepForegroundPromise] to decide — it promotes
      // unconditionally, with the mirrored metadata, because the user asked for
      // that track back. The fallback is the same one every other path uses: if
      // the notification could not be built, keep the promise with nothing
      // drawn rather than let the process be killed for it.
      //
      // `promotes = false` is the browse revival (see [onGetChildren]) and is
      // the one path that must NOT promote: it is triggered by a car *binding*
      // the service, and a bind makes no `startForegroundService()` promise to
      // keep. Promoting anyway would be an app starting a foreground service
      // from the background — refused outright on API 31+
      // (`ForegroundServiceStartNotAllowedException`) — to show a playback
      // notification for playback nobody asked for.
      if (promotes && !promoteWithSnapshotNotification(pending.config.android)) {
        promoteThenDemote()
      }

      if (!ReactRuntime.startRuntime(this) { onRuntimeReady() }) {
        abandonRevival("ReactHost.start() could not be issued")
        return false
      }
      main.postDelayed(watchdog, REVIVAL_TIMEOUT_MS)
      Log.i(
        TAG,
        if (promotes) "Playback resumption: foreground held, booting the JS runtime."
        else "Car browse: booting the JS runtime (no foreground service; nothing is playing)."
      )
    }

    if (startsPlayback) MediaSessionController.markResuming()
    return true
  }

  /** The `ReactContext` exists. Main thread (RN's contract for this listener). */
  private fun onRuntimeReady() {
    val pending = revival ?: return
    pending.runtimeReadyAtMs = SystemClock.elapsedRealtime()
    // Two ways an init can now arrive, and this call covers the one a cold
    // boot cannot: a runtime that was ALREADY alive (stop-then-resume in the
    // same process) has run its module scope once and will never run it
    // again, so the app is asked to re-run its init path instead
    // (`android.onRevivalRequested`). In a genuinely cold boot the requester
    // is not registered yet and this is a no-op — module scope is about to
    // call init by itself, and the TS side swallows a request that races an
    // init already in flight, so the two paths cannot double-initialize.
    pending.requestDelivered = MediaSessionController.requestRevival()
    Log.i(
      TAG,
      "Playback resumption: JS runtime up after " +
        "${pending.runtimeReadyAtMs - pending.startedAtMs} ms. " +
        if (pending.requestDelivered) {
          "Asked the live runtime to re-initialize (android.onRevivalRequested); " +
            "waiting for MediaService.init(...)."
        } else {
          "Waiting for the module-scope MediaService.init(...)."
        }
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
    flushBrowseRevival()
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
      when {
        pending.runtimeReadyAtMs == 0L ->
          "the JS runtime did not start within $REVIVAL_TIMEOUT_MS ms"

        pending.requestDelivered ->
          "the app was asked to re-initialize (android.onRevivalRequested fired on the " +
            "live runtime) but MediaService.init(...) never followed. That callback must " +
            "run your init path — the same idempotent 'bring the session up' code your " +
            "module scope runs, ending in MediaService.init(...)."

        else ->
          "the JS runtime started but MediaService.init(...) was never called. Two things " +
            "have to be true for a revival to finish: (1) init must run at JS MODULE SCOPE, " +
            "in a module your ENTRY file imports for its side effects " +
            "(`import './src/playback'` in index.js) — Metro's release-mode inline requires " +
            "defers a binding-only import (`import { x } from './m'`) to the first render, " +
            "which a headless runtime never performs, so an init that is merely 'at module " +
            "scope' of a lazily-required module still never runs; and (2) if this runtime " +
            "was already alive (a stop-then-resume without process death), module scope " +
            "cannot run twice — set android.onRevivalRequested to your init path so the " +
            "service can ask for it."
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
    // Reported, not merely logged — and the delivery is deliberately
    // best-effort, because this is the one code whose failure mode is precisely
    // "there is no session to report to". `reportResumptionFailure` holds it for
    // the next `initialize` when the runtime is alive but stopped, and lets it
    // stand as a log line when the process has no JavaScript at all. See
    // `SessionErrors.reportResumptionFailure`.
    SessionErrors.reportResumptionFailure(
      "Playback resumption abandoned: $reason. Stopping the media service."
    )
    MediaSessionController.discardRevival()
    releaseAndStop()
  }

  /**
   * Become foreground **now**, with a real media notification built from the
   * current snapshot. Returns whether the promise was actually kept.
   *
   * The bridge notification: what the user looks at between the OS creating (or
   * re-starting) this service and media3 taking the notification over. Shared by
   * the two paths that must satisfy the `startForegroundService` contract
   * themselves rather than wait for media3 — [beginRevival] (cold, no JS
   * runtime yet) and [keepForegroundPromise] (warm, playing) — because in both
   * of them the notification the user should see is exactly this one, and
   * posting it is what stops the process being killed.
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
   * foreground it is also not holding us to the promise. `false` then says so,
   * and both callers fall back to [promoteThenDemote] — an unkept promise is
   * the one outcome neither of them may accept.
   */
  @Suppress("DEPRECATION")
  private fun promoteWithSnapshotNotification(config: AndroidMediaSessionConfig): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    val current = session ?: return false
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
      return true
    } catch (error: Throwable) {
      Log.w(TAG, "Could not post the media notification to become foreground.", error)
      return false
    }
  }

  /**
   * Every *started* start of this service — and therefore every
   * `startForeground()` promise it can be held to.
   *
   * The promise is kept here rather than in [onCreate] on purpose: `onCreate`
   * also runs for a plain `bindService` (a `MediaController` connecting, Android
   * Auto looking at the browse tree), where no promise exists and posting a
   * notification would put a foreground service on screen for a bind. This
   * method runs for started services only, which is exactly the set of starts
   * that carry one.
   *
   * `super` is media3's, and it is what turns an `ACTION_MEDIA_BUTTON` intent
   * into a play command on the session — but only *after* this method has made
   * us foreground, which is the ordering the five-second contract requires.
   *
   * A **null** intent while a revival is armed is the system restarting us
   * stickily, with nobody asking for anything. Reviving there would boot the
   * whole app spontaneously, minutes after a kill, for no user-visible reason;
   * so that case stops instead. A resumption is always someone pressing
   * something. (A null intent on the warm path still goes through
   * [keepForegroundPromise]: a sticky restart of a service that had not yet
   * become foreground is restarted with the same obligation, and keeping a
   * promise nobody is holding us to costs one undrawn notification.)
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (revival != null) {
      if (intent == null) {
        abandonRevival("the system restarted the service with no request to resume")
        return START_NOT_STICKY
      }
      beginRevival(startsPlayback = false)
    } else {
      keepForegroundPromise()
    }
    return super.onStartCommand(intent, flags, startId)
  }

  /**
   * Satisfy the `startForegroundService()` contract for a **warm** start — the
   * bug this method exists for, and the only one of the three start paths that
   * had no answer to it.
   *
   * **The crash.** `Context.startForegroundService()` is a promise that the
   * service will call `startForeground()` within the OS window (~10 s on
   * Android 13/14); breaking it earns
   * `RemoteServiceException$ForegroundServiceDidNotStartInTimeException`, which
   * is uncatchable and takes the process down. Reported from a POCO F4 on
   * Android 13, with the stack naming the origin exactly:
   * `MediaSessionController.setPlaybackState` → `startService` →
   * `context.startForegroundService(intent)`.
   *
   * **Why media3 does not always keep it.** media3 promotes from its own
   * notification pass, and only while
   * `MediaNotificationManager.isAnySessionUserEngaged`
   * (`playWhenReady && (STATE_READY || STATE_BUFFERING)`) holds. The broadcast
   * that started us said `playing`; if that has evaporated by the time media3
   * runs — a fast pause, a stop, a track that errors or ends immediately, any
   * state race — media3 never promotes and nobody else does. media3 guards its
   * *own* starts this way (its `MediaButtonReceiver` refuses to start the
   * service for anything but a play-shaped key event, logging "to avoid an
   * `ForegroundServiceDidNotStartInTimeException`", and `stopSelfSafely` posts a
   * shutdown notification purely to keep the promise — both verified by `javap`
   * on the shipped 1.11.0 AAR). An app-initiated start is the app's to keep, and
   * this package is the app.
   *
   * Two outcomes, both of which end with the promise kept:
   * - the snapshot still [wants foreground][Snapshot.wantsForeground] — post the
   *   *real* media notification ([promoteWithSnapshotNotification]) under
   *   media3's own id, so media3's next pass replaces it in place and takes
   *   ownership back with nothing flickering;
   * - it does not (the race already landed) — [promoteThenDemote]: foreground
   *   for a few milliseconds, notification never drawn, and the service stays
   *   *started*, so the next `playing` broadcast re-promotes through media3 as
   *   usual.
   *
   * **Already foreground is left alone — but only on a *positive* answer.** A
   * media button arriving at a live playing service also lands here (media3's
   * receiver starts us with `startForegroundService` too), and there the OS is
   * holding nobody to anything: AOSP `ActiveServices.sendServiceArgsLocked`
   * clears `fgRequired` outright when `r.isForeground` already holds at
   * delivery time ("Service already foreground; no new timeout"). Promoting
   * anyway would hand `startForeground` a *different* notification id, which
   * cancels media3's own notification for no reason. So the skip is worth
   * having — and it is worth having only while the answer is trustworthy, which
   * is why [ForegroundPromise.isServiceForeground] asks ActivityManager on
   * **every** API level and [ForegroundPromise.decide] treats "unknown" as
   * "keep the promise". The previous pre-Q fallback, media3's
   * `isPlaybackOngoing()`, was a latch that reads `true` forever after the
   * first promotion — see [ForegroundPromise.decide] for the `javap` findings.
   *
   * Idempotent on purpose. The cold "nothing to serve" start answers the same
   * promise from `onCreate` ([stopWithoutEverBecomingForeground]) and then
   * arrives here as well; a second promote-and-demote on a service that is
   * already stopping is two binder calls and no user-visible effect, which is a
   * better trade than a piece of state saying which of the two ran.
   */
  private fun keepForegroundPromise() {
    val sdkInt = Build.VERSION.SDK_INT
    val snapshot = MediaSessionController.snapshot()
    val config = MediaSessionController.androidConfig
    val action = ForegroundPromise.decide(
      sdkInt = sdkInt,
      // Not asked below O: there is no promise there for the answer to bear on,
      // and the probe is a binder call.
      alreadyForeground = if (sdkInt >= Build.VERSION_CODES.O) isForegroundAlready() else null,
      wantsForeground = snapshot.wantsForeground,
      canBuildSnapshotNotification = config != null && session != null,
    )
    when (action) {
      PromiseAction.SKIP -> return
      PromiseAction.PROMOTE_WITH_SNAPSHOT ->
        // `config` is non-null here by construction — `canBuildSnapshotNotification`
        // is what put us in this branch.
        if (config != null && promoteWithSnapshotNotification(config)) {
          Log.d(TAG, "Kept the startForeground() promise with the real media notification.")
          return
        }
      PromiseAction.PROMOTE_THEN_DEMOTE -> Unit
    }
    // Either the engagement that started us is already gone, or the real
    // notification could not be built (a Notification the platform rejected).
    // The promise is kept either way; what changes is only whether the user
    // sees anything.
    promoteThenDemote()
    Log.d(TAG, "Kept the startForeground() promise with nothing drawn; the service stays started.")
  }

  /**
   * Is this service *currently* in the foreground? `null` when unknowable.
   *
   * API 29+ reads it off the `Service` itself; below that
   * [ForegroundPromise.isServiceForeground] asks ActivityManager for the same
   * framework bit. Both are a binder round trip — once per *started* start,
   * never in a hot path — and both are documented in [ForegroundPromise].
   */
  private fun isForegroundAlready(): Boolean? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      foregroundServiceType != android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE
    } else {
      ForegroundPromise.isServiceForeground(
        this,
        android.content.ComponentName(this, RnMediaMediaSessionService::class.java),
      )
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
   * (1001) by the same invariant [promoteWithSnapshotNotification] relies on: the
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
   *
   * **The app's broadcast is the whole predicate, and used to not be.** This
   * was `isPlaybackOngoing && playing`, and the extra conjunct was the same
   * misread of the same latch that §30 exists for: `isPlaybackOngoing()` is
   * `MediaNotificationManager.isStartedInForeground()`, set only in *media3's*
   * `startForeground` and never cleared (`javap`, 1.11.0). It therefore reads
   * `false` in exactly the window [keepForegroundPromise] created — where *we*
   * hold the foreground with the real media notification and media3 has not yet
   * taken over — so a task swipe there stopped a service that was playing.
   * Deleting the conjunct restores the rule this doc already stated.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    MediaSessionController.notifyTaskRemoved()

    if (MediaSessionController.snapshot().status == MediaPlaybackStatus.PLAYING) return

    // Also pauses every session's player, which routes back through
    // `handleSetPlayWhenReady` -> the JS `pause` handler, so the app learns it
    // was stopped. That only fires if COMMAND_PLAY_PAUSE is advertised; the
    // service is stopped either way.
    pauseAllPlayersAndStopSelf()
  }

  // MARK: - Session callback

  private inner class LibrarySessionCallback : MediaLibrarySession.Callback {

    /**
     * Grant this controller what it may have — and, for exactly two kinds of
     * controller, the one command that can start playback from a browse id.
     *
     * `COMMAND_SET_MEDIA_ITEM` is what a browse tap becomes
     * (`MediaSessionLegacyStub.handleMediaRequest`, media3 1.11.0), and it is
     * granted **per controller** rather than to everyone: see
     * [CarControllers.carCommands] for who and why. The base set is media3's
     * own default for this controller's trust level, so nothing else about the
     * connection changes — this replaces a default with the same default plus
     * or minus one command.
     */
    override fun onConnectAsync(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<ConnectionResult> {
      val snapshot = MediaSessionController.snapshot()
      val isAuto = session.isAutoCompanionController(controller)
      val isAutomotive = session.isAutomotiveController(controller)

      CarControllers.carConnection(isAuto, isAutomotive)?.let { kind ->
        carControllers[controller] = kind
        refreshCarConnection()
      }

      val base =
        if (controller.isTrusted) ConnectionResult.DEFAULT_PLAYER_COMMANDS
        else ConnectionResult.DEFAULT_UNTRUSTED_PLAYER_COMMANDS
      val playerCommands = Player.Commands.Builder()
        .addAll(base)
        .apply {
          if (CarControllers.carCommands(isAuto, isAutomotive, controller.isTrusted)) {
            add(Player.COMMAND_SET_MEDIA_ITEM)
          } else {
            remove(Player.COMMAND_SET_MEDIA_ITEM)
          }
        }
        .build()

      return Futures.immediateFuture(
        ConnectionResult.AcceptedResultBuilder(session, controller)
          .setAvailableSessionCommands(sessionCommands(snapshot))
          .setAvailablePlayerCommands(playerCommands)
          .setMediaButtonPreferences(MediaButtons.buttons(this@RnMediaMediaSessionService, snapshot))
          .build()
      )
    }

    /** A car unplugged, or any controller went away. */
    override fun onDisconnected(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ) {
      if (carControllers.remove(controller) != null) refreshCarConnection()
    }

    /**
     * **The fan-in for every browse tap and every voice request.**
     *
     * Android Auto's tap on a playable item, Assistant's "play some jazz" and a
     * trusted controller's `setMediaItem` all arrive here — the legacy stub
     * funnels `onPlayFromMediaId` / `onPlayFromSearch` / `onPlayFromUri`
     * through `handleMediaRequest` → `COMMAND_SET_MEDIA_ITEM` →
     * `Callback.onSetMediaItems` (media3 1.11.0).
     *
     * The app is told, and the **current timeline is returned unchanged**. That
     * is the whole design: this package's player has no playlist of its own to
     * set, the app owns the queue, and the acknowledgement is the app's next
     * `setQueue`/`setPlaybackState` broadcast exactly as it is for `play()`
     * (ARCHITECTURE §9). Returning the controller's item instead would let a
     * browse tap rewrite the app's playlist behind its back.
     */
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val request = mediaItems.firstOrNull()
      val query = request?.requestMetadata?.searchQuery
      val mediaId = request?.mediaId.orEmpty()
      val capabilities = MediaSessionController.browseCapabilities

      // Before anything is dispatched: media3 finishes a media request by
      // calling `play()` on the player, which would resume the *previous*
      // track while the app loads the new one. See [MediaRequestLatch].
      MediaSessionController.armMediaRequest()

      when {
        query != null -> {
          if (!capabilities.playFromSearch) {
            return unsupportedRequest(
              "voice playback (\"$query\") — this app's MediaHandler has no playFromSearch"
            )
          }
          val focus = focusFrom(request.requestMetadata.extras)
          MediaSessionController.dispatch(startsPlayback = true) {
            it.playFromSearch(query, focus)
          }
        }

        mediaId.isNotEmpty() && mediaId != MediaItem.DEFAULT_MEDIA_ID -> {
          MediaSessionController.dispatch(startsPlayback = true) {
            it.playFromMediaId(mediaId)
          }
        }

        // `onPlayFromUri`: media3 advertises `ACTION_PLAY_FROM_URI` alongside
        // the other two the moment `COMMAND_SET_MEDIA_ITEM` is available
        // (`convertCommandToPlaybackStateActions`), and there is no handler
        // method for it — a URI is not a browse id and inventing one would be
        // worse than saying no.
        else -> return unsupportedRequest("a play-from-URI request")
      }

      val snapshot = MediaSessionController.snapshot()
      val timeline = snapshot.timeline
      // Nothing queued yet (a car tapping a track in an app that has never
      // played) — there is no current timeline to preserve, so the honest
      // answer is "the session ignored the playlist part". The app has the tap
      // either way, and its broadcast is what starts playback. media3's legacy
      // path treats a failed future as "the session is free to ignore these
      // requests" and does nothing else.
      if (timeline.isEmpty()) {
        return Futures.immediateFailedFuture(
          IllegalStateException("No queue to preserve; the app answers this request itself.")
        )
      }
      return Futures.immediateFuture(
        MediaSession.MediaItemsWithStartPosition(
          timeline.map { it.toMediaItem() },
          snapshot.timelineIndex,
          snapshot.anchor.projectMs(),
        )
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
     * The browse root, plus the two hints that decide how the car draws
     * everything under it.
     *
     * Read *from* the browser (`params.extras`, which media3 fills from the
     * root hints): the recommended artwork size and the maximum number of root
     * children it can show. Written *to* the browser: the default content
     * style for browsable and playable items, which an individual node can
     * still override with `BrowseItem.childStyle`.
     *
     * Never an error, whatever else is wrong. A valid root is what makes Auto
     * and the System UI list the app at all, and `onGetLibraryRoot` is in any
     * case the one library callback media3 exempts from error replication
     * (`MediaLibrarySessionImpl`, 1.11.0) — an error here is invisible *and*
     * costly.
     */
    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      params?.extras?.let { hints ->
        val size = hints.getInt(MediaConstants.EXTRAS_KEY_MEDIA_ART_SIZE_PIXELS, 0)
        if (size > 0) artwork.artSizePixels = size
        val limit = hints.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 0)
        if (limit > 0) rootChildrenLimit = minOf(limit, DEFAULT_ROOT_CHILDREN_LIMIT)
      }
      return Futures.immediateFuture(LibraryResult.ofItem(browseRoot(), rootParams(params)))
    }

    /**
     * One screen of the browse tree.
     *
     * Three cases, in order:
     * 1. **A live runtime** — pull from the app, cache the answer, return it.
     * 2. **No runtime, a car asking** — return the cached answer *now* and boot
     *    the app behind it, then `notifyChildrenChanged` when it arrives. A car
     *    that reconnects to a killed app sees its library immediately instead
     *    of an empty one.
     * 3. **No runtime, anything else** — the cached answer, and nothing is
     *    booted. A System UI bind must never start the app (ARCHITECTURE §30);
     *    that rule is why the revival is gated on
     *    [CarControllers.carConnection] rather than on `isTrusted`.
     *
     * `page`/`pageSize` are ignored on purpose: a legacy browser is served
     * `page = 0, pageSize = Integer.MAX_VALUE` by media3's own stub, and
     * Google's guidance is "don't rely on the page or pageSize parameters".
     * Oversized results are truncated by media3 against the binder limit
     * (`MediaUtils.truncateListBySize`).
     */
    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      val handlers = MediaSessionController.handlers
        ?: return servedFromCache(session, browser, parentId, page, pageSize, params)
      return pull(parentId, page, pageSize, params) { handlers.getChildren(parentId) }
    }

    /**
     * One node by id. Mirrors [onGetChildren], including the cache and the
     * car-only revival.
     *
     * The root answers itself: media3 asks for it by id while building a
     * browser's tree, and a round trip into JavaScript for a constant would be
     * a pointless one.
     */
    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      if (mediaId == ROOT_ID) {
        return Futures.immediateFuture(LibraryResult.ofItem(browseRoot(), null))
      }
      val handlers = MediaSessionController.handlers
        ?: return Futures.immediateFuture(
          cachedItem(mediaId)
            ?.let { LibraryResult.ofItem(it, null) }
            ?: LibraryResult.ofError(SessionError.ERROR_NOT_SUPPORTED)
        )
      val future = SettableFuture.create<LibraryResult<MediaItem>>()
      bridge(
        pull = { handlers.getMediaItem(mediaId) },
        onFailure = { future.set(LibraryResult.ofError(SessionError.ERROR_UNKNOWN)) },
      ) { result ->
        val error = result.error
        val item = result.items.firstOrNull()
        future.set(
          when {
            error != null -> LibraryResult.ofError(
              BrowseTree.sessionError(
                this@RnMediaMediaSessionService,
                error,
                nextResolutionRequestCode(),
              )
            )
            item == null -> LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
            else -> LibraryResult.ofItem(BrowseTree.toMediaItem(item, artwork), null)
          }
        )
      }
      return future
    }

    /**
     * A search from the car's search tab.
     *
     * Two calls by contract: this one answers "I have results" and then
     * `notifySearchResultChanged` tells the browser how many, at which point
     * media3's legacy stub calls [onGetSearchResult] to actually read them
     * (`MediaLibraryService`, `MediaLibraryServiceLegacyStub`, 1.11.0). The
     * results are therefore cached under a search key here and served from the
     * cache there — one pull into JavaScript per query, not two.
     */
    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      if (!MediaSessionController.browseCapabilities.search) {
        return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_NOT_SUPPORTED))
      }
      val handlers = MediaSessionController.handlers
        ?: return Futures.immediateFuture(LibraryResult.ofError(SessionError.ERROR_INVALID_STATE))

      val future = SettableFuture.create<LibraryResult<Void>>()
      bridge(
        pull = { handlers.search(query) },
        onFailure = { future.set(LibraryResult.ofError(SessionError.ERROR_UNKNOWN)) },
      ) { result ->
        val error = result.error
        if (error != null) {
          future.set(
            LibraryResult.ofError(
              BrowseTree.sessionError(
                this@RnMediaMediaSessionService,
                error,
                nextResolutionRequestCode(),
              )
            )
          )
          return@bridge
        }
        // `NativeBrowseResult.items` is a Kotlin `Array` (nitrogen maps a JS
        // array to one); the cache and the converters speak `List`.
        browseCache.put(BrowseCache.searchKey(query), result.items.toList())
        future.set(LibraryResult.ofVoid(params))
        session.notifySearchResultChanged(browser, query, result.items.size, params)
      }
      return future
    }

    /** The results [onSearch] already fetched. */
    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
      Futures.immediateFuture(
        LibraryResult.ofItemList(
          browseCache.get(BrowseCache.searchKey(query)).orEmpty().toMediaItems(page, pageSize),
          params,
        )
      )
  }

  // MARK: - Browse plumbing

  /**
   * Bridge one Nitro browse callback into a completion on the main thread.
   *
   * ## The double promise is not a typo
   * A JS callback that returns a value arrives natively as a promise of the
   * *invocation*, and this one's declared return is itself a `Promise<T>` — so
   * nitrogen emits `Promise<Promise<NativeBrowseResult>>`
   * (`nitrogen/generated/android/kotlin/com/margelo/nitro/rnmediamediasession/
   * MediaSessionHandlers.kt`, and `FunctionType`'s constructor in nitrogen
   * 0.37.0, which wraps every non-void callback return in a `PromiseType`).
   * The outer resolves when the JS function returns; the inner when the promise
   * it returned settles. Both have to be unwrapped, and a rejection of either
   * is the same failure.
   *
   * The hop to [main] is deliberate: Nitro resolves on whichever thread the JS
   * runtime finished on, and everything downstream — the cache, the session's
   * `notifyChildrenChanged`, `LibraryResult` — belongs to the media3
   * application looper.
   */
  private inline fun bridge(
    crossinline pull: () -> Promise<Promise<NativeBrowseResult>>,
    crossinline onFailure: () -> Unit,
    crossinline onResult: (NativeBrowseResult) -> Unit,
  ) {
    val fail = { error: Throwable ->
      Log.w(TAG, "A browse pull into JavaScript failed.", error)
      main.post { onFailure() }
      Unit
    }
    try {
      pull()
        .then { inner ->
          inner
            .then { result -> main.post { onResult(result) } }
            .catch { error -> fail(error) }
          Unit
        }
        .catch { error -> fail(error) }
    } catch (error: Throwable) {
      // The callback itself threw — a runtime torn down between the null check
      // and the call. Same outcome as a rejection.
      fail(error)
    }
  }

  /**
   * A children pull, with the cache write and the root cap.
   *
   * The deadline is the honest limit on how long a browser is made to wait for
   * an app whose handler never answers: past it the cached (or empty) answer is
   * returned, and a later `invalidateBrowse` still corrects it.
   */
  private fun pull(
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
    invoke: () -> Promise<Promise<NativeBrowseResult>>,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
    val timeout = Runnable {
      if (!future.isDone) {
        Log.w(
          TAG,
          "getChildren(\"$parentId\") did not answer within ${BROWSE_TIMEOUT_MS} ms; " +
            "serving the cached list. Browse handlers must answer quickly — a car shows a " +
            "spinner until they do."
        )
        future.set(cachedResult(parentId, page, pageSize, params))
      }
    }
    main.postDelayed(timeout, BROWSE_TIMEOUT_MS)

    bridge(
      pull = invoke,
      onFailure = {
        main.removeCallbacks(timeout)
        future.set(cachedResult(parentId, page, pageSize, params))
      },
    ) { result ->
      main.removeCallbacks(timeout)
      val error = result.error
      if (error != null) {
        // Deliberately not cached: an error is a statement about *now* (signed
        // out, out of region), and caching it would outlive the sign-in.
        future.set(
          LibraryResult.ofError(
            BrowseTree.sessionError(this, error, nextResolutionRequestCode())
          )
        )
        return@bridge
      }
      val pulled = result.items.toList()
      val items = if (parentId == ROOT_ID) cappedRoot(pulled) else pulled
      // The WHOLE list is cached; only the requested window is returned.
      browseCache.put(parentId, items)
      future.set(LibraryResult.ofItemList(items.toMediaItems(page, pageSize), params))
    }
    return future
  }

  /**
   * The root cap the *browser* asked for.
   *
   * The four-tab rule and the browsable-only rule are already applied in
   * TypeScript, once, so both platforms behave identically (`capRootTabs`) and
   * anything dropped is reported to the app there. This is the second, smaller
   * cap: a browser that says it can show fewer
   * (`EXTRAS_KEY_ROOT_CHILDREN_LIMIT`) is describing its own screen, which is
   * not an app bug and is not reported as one.
   */
  private fun cappedRoot(items: List<NativeBrowseItem>): List<NativeBrowseItem> {
    val browsable = items.filter { it.browsable }
    if (browsable.size != items.size) {
      Log.w(
        TAG,
        "Dropped ${items.size - browsable.size} non-browsable root item(s): Android Auto's " +
          "root supports FLAG_BROWSABLE only."
      )
    }
    if (browsable.size <= rootChildrenLimit) return browsable
    Log.i(
      TAG,
      "This browser asked for at most $rootChildrenLimit root children; showing the first " +
        "$rootChildrenLimit of ${browsable.size}."
    )
    return browsable.take(rootChildrenLimit)
  }

  /**
   * Answer from the cache because there is no JavaScript to ask — and, when the
   * asker is a car, start the app so the answer stops being stale.
   */
  private fun servedFromCache(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    // Asked of the session rather than looked up in [carControllers], and that
    // is the point: this decides whether a bind may boot the app, so it must
    // not depend on a map entry that a `ControllerInfo` identity mismatch
    // (media3 substitutes one for the notification controller, and legacy
    // browsers arrive per request) could silently miss. Stateless and total.
    val isCar = CarControllers.carConnection(
      isAuto = session.isAutoCompanionController(browser),
      isAutomotive = session.isAutomotiveController(browser),
    ) != null
    if (isCar) {
      staleBrowseParents.add(parentId)
      // `startsPlayback = false`: a browse is not a play, so nothing is marked
      // as resuming and no foreground service is started (see [beginRevival]).
      beginRevival(startsPlayback = false, promotes = false)
    }
    return Futures.immediateFuture(cachedResult(parentId, page, pageSize, params))
  }

  private fun cachedResult(
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
  ): LibraryResult<ImmutableList<MediaItem>> = LibraryResult.ofItemList(
    // Empty rather than an error, always: "return an empty list for no children
    // rather than using error codes".
    browseCache.get(parentId).orEmpty().toMediaItems(page, pageSize),
    params,
  )

  private fun cachedItem(mediaId: String): MediaItem? {
    for (key in browseCache.keys()) {
      val item = browseCache.get(key)?.firstOrNull { it.id == mediaId } ?: continue
      return BrowseTree.toMediaItem(item, artwork)
    }
    return null
  }

  /**
   * The requested window of a browse list, converted.
   *
   * **Not optional politeness — media3 throws without it.** A result larger
   * than the browser asked for is rejected by
   * `MediaLibrarySessionImpl.verifyResultItems`:
   *
   * ```java
   * if (items.size() > pageSize) {
   *   throw new IllegalStateException("Invalid size=" + items.size() + ", pageSize=" + pageSize);
   * }
   * ```
   *
   * (media3 1.11.0, on the session's application thread, i.e. uncatchable by
   * the app.) Legacy browsers — Android Auto among them — are always served
   * `page = 0, pageSize = Integer.MAX_VALUE` by media3's own stub, so this is
   * inert for them; a modern `MediaBrowser` that pages for real would
   * otherwise take the session down. Google's "don't rely on the page or
   * pageSize parameters" is advice about *content*, not permission to ignore
   * the contract.
   *
   * The whole list is what gets cached; only this window is returned.
   */
  private fun List<NativeBrowseItem>.toMediaItems(
    page: Int,
    pageSize: Int,
  ): ImmutableList<MediaItem> {
    // `Long`, because `page * pageSize` overflows for the `Integer.MAX_VALUE`
    // page size every legacy browser is given.
    val from = page.toLong().coerceAtLeast(0L) * pageSize.toLong().coerceAtLeast(0L)
    if (from >= size) return ImmutableList.of()
    val window = drop(from.toInt()).take(pageSize.coerceAtLeast(0))
    return ImmutableList.copyOf(window.map { BrowseTree.toMediaItem(it, artwork) })
  }

  /**
   * Tell every browser that was served from the cache during a revival to ask
   * again, now that the app is up. Main thread only.
   */
  private fun flushBrowseRevival() {
    if (staleBrowseParents.isEmpty()) return
    val session = session ?: return
    val parents = staleBrowseParents.toList()
    staleBrowseParents.clear()
    for (parent in parents) {
      session.notifyChildrenChanged(parent, browseCache.get(parent)?.size ?: 0, null)
    }
    Log.i(TAG, "Browse: refreshed ${parents.size} parent(s) served from cache during revival.")
  }

  /**
   * The app says something under `parentId` changed. Main thread only.
   *
   * Evicting is the load-bearing half — `notifyChildrenChanged` makes a browser
   * ask again, and it must not be answered from the very cache the app just
   * said was wrong.
   */
  internal fun invalidateBrowse(parentId: String?) {
    if (parentId != null) {
      browseCache.evict(parentId)
      session?.notifyChildrenChanged(parentId, 0, null)
      return
    }
    val keys = browseCache.keys()
    browseCache.clear()
    val session = session ?: return
    for (key in keys) {
      // A search result is not a browse parent; there is no subscription to
      // notify and `notifySearchResultChanged` needs the browser that asked.
      if (BrowseCache.isSearchKey(key)) continue
      session.notifyChildrenChanged(key, 0, null)
    }
    if (!keys.contains(ROOT_ID)) session.notifyChildrenChanged(ROOT_ID, 0, null)
  }

  /** Main thread only. Recomputed from the connected controllers. */
  private fun refreshCarConnection() {
    var kind = CarControllers.NONE
    for (value in carControllers.values) {
      kind = CarControllers.strongerConnection(kind, value)
    }
    MediaSessionController.updateCarConnection(kind)
  }

  private fun nextResolutionRequestCode(): Int {
    resolutionRequestCode += 1
    return resolutionRequestCode
  }

  private fun unsupportedRequest(
    what: String
  ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
    Log.w(TAG, "Refused $what.")
    return Futures.immediateFailedFuture(UnsupportedOperationException(what))
  }

  /**
   * A voice query's focus, read from the extras Assistant sends alongside it.
   *
   * The keys are `MediaStore`'s own; the classification is
   * [CarControllers.searchFocus], which is pure and tested.
   */
  @Suppress("DEPRECATION") // `MediaStore.EXTRA_MEDIA_PLAYLIST`; see below.
  private fun focusFrom(extras: Bundle?): NativeSearchFocus = CarControllers.searchFocus(
    focus = extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS),
    artist = extras?.getString(MediaStore.EXTRA_MEDIA_ARTIST),
    album = extras?.getString(MediaStore.EXTRA_MEDIA_ALBUM),
    title = extras?.getString(MediaStore.EXTRA_MEDIA_TITLE),
    genre = extras?.getString(MediaStore.EXTRA_MEDIA_GENRE),
    // Deprecated along with the `MediaStore.Audio.Playlists` table, and still
    // the key Assistant fills for a playlist query — see `CarControllers`.
    playlist = extras?.getString(MediaStore.EXTRA_MEDIA_PLAYLIST),
  )

  /**
   * The root's `LibraryParams`, carrying the browse defaults for the whole
   * tree.
   *
   * media3 copies these into the browser's root hints
   * (`LegacyConversions.convertToRootHints`), which is how Android Auto learns
   * the app's default content style. A per-node `BrowseItem.childStyle` still
   * wins for that node's children.
   */
  private fun rootParams(request: LibraryParams?): LibraryParams {
    val extras = Bundle()
    extras.putInt(
      MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
      MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
    )
    extras.putInt(
      MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
      MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
    )
    return LibraryParams.Builder()
      .setExtras(extras)
      .setRecent(request?.isRecent == true)
      .setOffline(request?.isOffline == true)
      .setSuggested(request?.isSuggested == true)
      .build()
  }

  // MARK: - Helpers

  /**
   * What a controller may ask the *session* for — and, for browsers, whether
   * search exists at all.
   *
   * Removing `COMMAND_CODE_LIBRARY_SEARCH` is not a refusal, it is the
   * advertisement: media3's legacy stub computes
   * `android.media.browse.SEARCH_SUPPORTED` from exactly this
   * (`isSessionCommandAvailable(controller, COMMAND_CODE_LIBRARY_SEARCH)` in
   * `MediaLibraryServiceLegacyStub.onGetRoot`, 1.11.0), and that key alone is
   * what makes Android Auto draw or hide its search tab. Leaving the command in
   * for an app with no `search` handler would give the car a search box that
   * can only ever return nothing.
   */
  private fun sessionCommands(snapshot: Snapshot): SessionCommands =
    ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
      .apply {
        MediaButtons.sessionCommands(snapshot).forEach { add(it) }
        if (!MediaSessionController.browseCapabilities.search) {
          remove(SessionCommand.COMMAND_CODE_LIBRARY_SEARCH)
        }
      }
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
   * So: post a notification, become foreground, and immediately drop both
   * ([promoteThenDemote]) — then stop. The notification exists for a few
   * milliseconds and is never drawn.
   */
  private fun stopWithoutEverBecomingForeground() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Pre-O there is no startForeground() contract to satisfy —
      // `startForegroundService` itself is API 26+ — and the two-arg
      // `Notification.Builder(Context, String)` [promoteThenDemote] uses does
      // not exist either (lint NewApi). A plain stop is already safe here.
      stopSelf()
      return
    }
    promoteThenDemote()
    stopSelf()
  }

  /**
   * Keep the `startForeground()` promise without ever drawing anything:
   * promote, then demote in the same breath.
   *
   * The shared half of [stopWithoutEverBecomingForeground] — which stops
   * afterwards, because it has nothing to serve — and of
   * [keepForegroundPromise]'s race branch, which deliberately does **not**: a
   * warm service whose play was cancelled a moment ago is still a live session
   * the app will broadcast to again, and the next `playing` re-promotes it
   * through media3 in the ordinary way. Demoted is not stopped.
   *
   * Its own notification id, never media3's: media3's notification (1001) may be
   * on screen as an ordinary posted notification while the service is demoted
   * (`stopForegroundOnPause`, see [cancelMediaNotification]), and
   * `stopForeground(STOP_FOREGROUND_REMOVE)` removes whatever was handed to the
   * most recent `startForeground` — which must therefore be a throwaway of ours
   * and not the user's media notification.
   *
   * `startForeground` can itself refuse (Android 12+ background-start rules).
   * That is caught rather than propagated — if the OS will not let us be
   * foreground it is also not going to hold us to the promise. This is media3's
   * own recipe for the same problem, `MediaSessionService.stopSelfSafely`
   * (`javap`, 1.11.0): shutdown notification →
   * `Util.setForegroundServiceNotification(…, "mediaPlayback")` →
   * `Util.stopForeground(…)`, catching `IllegalStateException`.
   *
   * **Its own channel, never the app's, and the channel does not outlive the
   * call.** Borrowing the app's channel — which this used to do — inherits its
   * importance, and an app is free to configure `IMPORTANCE_DEFAULT`, i.e. a
   * channel that peeks; nothing about a title-less, text-less notification with
   * a lifetime of milliseconds should be able to interrupt anyone. And the
   * fallback it used to have was worse: a channel is permanent and
   * user-visible the moment it is created, so a placeholder made here would sit
   * in the app's notification settings forever, under a name the app never
   * chose, for a notification nobody ever saw.
   *
   * So: this package's own channel, at `IMPORTANCE_LOW` (no sound, no peek),
   * deleted again as soon as the demotion lands.
   *
   * `IMPORTANCE_MIN` would be better still and is not available — the framework
   * refuses it for a foreground-service notification and rewrites the channel:
   * AOSP `NotificationManagerService.enqueueNotificationInternal`,
   * `if (notification.isFgsOrUij()) { … if (r.getImportance() == IMPORTANCE_MIN
   * || … IMPORTANCE_NONE) { channel.setImportance(IMPORTANCE_LOW); … } }`
   * ("Increase the importance of fgs/uij notifications unless the user had an
   * opinion otherwise"). Asking for MIN and being silently upgraded reads as an
   * intention the code does not have, so it asks for what it gets.
   *
   * Deleting is not a data-loss risk: the id is this package's own, and AOSP
   * `PreferencesHelper.createNotificationChannel` *un-deletes* an existing
   * deleted channel and keeps its settings rather than replacing it, so a later
   * re-creation restores anything a user had changed. While deleted it is
   * filtered out of every enumeration Settings uses
   * (`PreferencesHelper.getNotificationChannels`: `includeDeleted || !nc.isDeleted()`).
   *
   * Verified on device (POCO F4, Android 16 / API 36, 2026-08-19): screen
   * recordings taken across this call with the shade open and with it closed
   * show no new shade entry and no new status-bar icon, and afterwards
   * `dumpsys notification` shows the channel present with `mDeleted=true`
   * alongside the app's own untouched `playback`. The platform's own ten-second
   * deferral of foreground-service notifications (Android 12+;
   * `deferred_fgs_notifications_enabled=true` on that device) is what keeps it
   * off screen in the first place — a notification with no actions and no
   * `MediaStyle` is not shown immediately, and this one is gone long before the
   * deferral elapses. One device, one version.
   *
   * Pre-O is a no-op rather than a caller's problem: `startForegroundService`
   * is API 26+, so nothing below it can have made a promise, and the two-arg
   * `Notification.Builder(Context, String)` does not exist there either.
   */
  private fun promoteThenDemote() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channelId = TRANSIENT_CHANNEL_ID
    createNotificationChannel(channelId, TRANSIENT_CHANNEL_NAME)

    try {
      val notification = android.app.Notification.Builder(this, channelId)
        // media3's own small icon: guaranteed to resolve, because this module
        // depends on media3-session. A missing/zero icon makes Notification
        // throw, which would defeat the entire point of this method.
        .setSmallIcon(androidx.media3.session.R.drawable.media3_notification_small_icon)
        .build()

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          TRANSIENT_NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
      } else {
        startForeground(TRANSIENT_NOTIFICATION_ID, notification)
      }
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (error: Throwable) {
      Log.w(TAG, "Could not satisfy the startForeground() contract.", error)
    } finally {
      // Whether or not the promotion landed, nothing about this channel should
      // survive the call. In the `finally` because a channel left behind by a
      // refused `startForeground` is exactly the stray entry this avoids.
      deleteNotificationChannel(channelId)
    }
  }

  /**
   * Create the channel ourselves so the app's configured *name* is used.
   *
   * media3 would otherwise create it from a string resource we cannot supply at
   * runtime. Creating it first wins, because `ensureNotificationChannel`
   * returns early when `getNotificationChannel(channelId) != null` — and that
   * check is also what makes re-creating [promoteThenDemote]'s deleted channel
   * work, because the app-facing `getNotificationChannel(String)` does not
   * return deleted channels.
   *
   * `IMPORTANCE_LOW` for both callers: a media notification must never make a
   * sound or peek — the transport controls are the point, not the alert — and
   * it is also the floor the framework enforces for anything a foreground
   * service posts (see [promoteThenDemote]).
   */
  private fun createNotificationChannel(id: String?, name: String?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (id.isNullOrEmpty() || name.isNullOrEmpty()) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(id) != null) return
    manager.createNotificationChannel(
      android.app.NotificationChannel(id, name, NotificationManager.IMPORTANCE_LOW)
        .apply { setShowBadge(false) }
    )
  }

  /**
   * Remove a channel this class created for its own transient use.
   *
   * Guarded on the id so an app's configured channel can never be deleted by a
   * refactor that widens a caller: [TRANSIENT_CHANNEL_ID] is this package's,
   * nobody else posts to it, and it exists for the few milliseconds
   * [promoteThenDemote] holds the foreground.
   */
  private fun deleteNotificationChannel(id: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (id != TRANSIENT_CHANNEL_ID) return
    runCatching { getSystemService(NotificationManager::class.java)?.deleteNotificationChannel(id) }
  }

  internal companion object {
    const val TAG = "RnMediaMediaSession"
    const val ROOT_ID = "rn-media-root"

    /**
     * Channel + id for [promoteThenDemote]'s throwaway notification — the one
     * that keeps a `startForeground()` promise without ever being drawn.
     *
     * Deliberately **not** the app's channel. Borrowing that one inherits its
     * importance (an app is free to configure `IMPORTANCE_DEFAULT`, which can
     * peek) for a notification with no title, no text and a lifetime measured
     * in milliseconds. This one is `IMPORTANCE_LOW` — the floor the framework
     * enforces for a foreground-service notification whatever is asked for, see
     * [promoteThenDemote] — and is deleted again in the same call, so it
     * neither peeks nor persists in the user's notification settings. The name
     * is written to be honest if a user ever does see it in a system dump.
     *
     * The id is its own too, never media3's 1001: media3's notification may be
     * on screen as an ordinary posted notification while the service is demoted
     * (`stopForegroundOnPause`, see [cancelMediaNotification]), and
     * `stopForeground(STOP_FOREGROUND_REMOVE)` removes whatever the most recent
     * `startForeground` was handed.
     */
    private const val TRANSIENT_CHANNEL_ID = "rn-media-session-transient"
    private const val TRANSIENT_CHANNEL_NAME = "Background playback handover"
    private const val TRANSIENT_NOTIFICATION_ID = 1002

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
     * The four-tab root cap, and the default when a browser sends no
     * `EXTRAS_KEY_ROOT_CHILDREN_LIMIT` hint.
     *
     * Google, on the content hierarchy: *"expect this number to be four"*. The
     * same number is enforced in TypeScript (`capRootTabs`) so CarPlay behaves
     * identically; this is the floor a browser can only lower.
     */
    private const val DEFAULT_ROOT_CHILDREN_LIMIT = 4

    /**
     * How long a browse pull may keep a browser waiting before the cached
     * answer is served instead.
     *
     * Generous next to [BroadcastPlayer]'s 3 s command deadline, because this
     * one covers a real app call — a library query, a network round trip —
     * rather than a state broadcast. Short enough that a car never sits on a
     * spinner: Android Auto's own patience is not documented, and being the
     * thing that gives up first is the only way to control what the user sees.
     */
    private const val BROWSE_TIMEOUT_MS = 5_000L

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
