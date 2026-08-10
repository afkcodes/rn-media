package com.rnmediamediasession

import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.Player
import com.margelo.nitro.rnmediamediasession.AndroidMediaSessionConfig
import com.margelo.nitro.rnmediamediasession.MediaPlaybackStatus
import com.margelo.nitro.rnmediamediasession.MediaSessionHandlers
import com.margelo.nitro.rnmediamediasession.NativeMediaItem
import com.margelo.nitro.rnmediamediasession.NativePlaybackState

/**
 * The process-wide join between JavaScript and the media3 service.
 *
 * A singleton because the two things it joins are singletons themselves: the OS
 * media session, and the one JS runtime. It is deliberately *not* the Nitro
 * hybrid object — the service is created and destroyed by the OS on its own
 * schedule, and may outlive or precede any particular hybrid instance, so the
 * state has to live somewhere neither of them owns.
 *
 * ## Threading
 * - `initialize`/`set*`/`stop` arrive on the JS thread.
 * - [snapshot], [handlers] and [androidConfig] are read from the main thread
 *   (media3 callbacks) and from binder threads (`onCustomCommand`), hence
 *   `@Volatile` on all three.
 * - Everything that touches [BroadcastPlayer] or the service hops to the main
 *   looper first, because `SimpleBasePlayer` is constructed with it and throws
 *   if accessed from anywhere else.
 *
 * The one thing that must NOT wait for the hop is the clock read: the position
 * anchor is converted in the caller's frame (see [Anchor.receive]) so that main
 * thread contention cannot age it.
 */
// `Player.pause()`/`isCommandAvailable` on the media3 facade are `@UnstableApi`,
// like every other media3 surface this package touches (see `BroadcastPlayer`,
// `MediaButtons`, the service). Opting in here rather than at the one call site
// keeps the marker in one place per file.
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal object MediaSessionController : CommandDispatcher {

  private val main = Handler(Looper.getMainLooper())

  @Volatile
  var handlers: MediaSessionHandlers? = null
    private set

  @Volatile
  var androidConfig: AndroidMediaSessionConfig? = null
    private set

  @Volatile
  private var current: Snapshot = Snapshot.EMPTY

  /** Main thread only. */
  private var player: BroadcastPlayer? = null

  /** Main thread only. */
  private var service: RnMediaMediaSessionService? = null

  /**
   * Main thread only. `true` between asking the OS for the service and the
   * service telling us it is gone, so a burst of `playing` broadcasts issues
   * one start, not twenty.
   */
  private var serviceRequested = false

  private var appContext: Context? = null

  /** Handle for the `ReactHost` before-destroy hook; identity matters for removal. */
  private var beforeDestroy: (() -> Unit)? = null

  /**
   * The native sleep timer. Owned here rather than by the service because it
   * must keep counting across the service's own lifecycle — the whole point is
   * that it does not depend on anything the OS can take away short of the
   * process.
   */
  private val sleepTimer = SleepTimer { onSleepTimerFired() }

  /**
   * Commands that arrived before there was anyone to run them. Main thread only.
   *
   * Only reachable during a playback resumption: the media3 session exists (the
   * service built it from the persisted mirror) but the JS runtime is still
   * booting, and a `play` from the notification is precisely the event that
   * started the whole sequence. Dropping it would make the user press play
   * twice; running it against a half-built app would be worse. So it is held
   * here and replayed the instant handlers arrive.
   *
   * Bounded: a remote that keeps hammering buttons while the runtime boots must
   * not build an unbounded backlog that then executes all at once. Past the
   * bound the *oldest* is dropped — the newest intent is the one the user is
   * still waiting for.
   */
  private val deferred = ArrayDeque<(MediaSessionHandlers) -> Unit>()

  /** `true` once [dispatch] has held a command for a runtime that does not exist. */
  private var revivalPending = false

  fun snapshot(): Snapshot = current

  // MARK: - Lifecycle

  /**
   * Install handlers and config. Does **not** start the service — that waits
   * for a play command, per the Android 12+ restriction on starting a
   * foreground service from the background.
   */
  fun initialize(
    context: Context,
    config: AndroidMediaSessionConfig?,
    handlers: MediaSessionHandlers,
    onReady: () -> Unit,
  ) {
    val application = context.applicationContext
    appContext = application
    androidConfig = config
    this.handlers = handlers
    // Mirror the config for a future cold start. A service created with no JS
    // has to build the same notification channel, small icon and grace period
    // this call configured, and it cannot ask JavaScript for them.
    ResumptionStore.putConfig(application, config)
    // Turning the feature off must also forget what it would have resumed:
    // an opted-out app should not leave a session behind for a service created
    // by something else to find.
    if (config?.playbackResumption != true) {
      ResumptionStore.putSession(application, null)
    } else if (!ResumptionStore.hasMediaButtonReceiver(application)) {
      Log.w(
        RnMediaMediaSessionService.TAG,
        "android.playbackResumption is on, but this app declares no receiver for " +
          "android.intent.action.MEDIA_BUTTON. media3 reads that declaration as the app's " +
          "promise that it can resume, and without it the System UI never offers a " +
          "resumption card. Add media3's MediaButtonReceiver to your AndroidManifest.xml:\n" +
          "  <receiver android:name=\"androidx.media3.session.MediaButtonReceiver\" " +
          "android:exported=\"true\">\n" +
          "    <intent-filter>\n" +
          "      <action android:name=\"android.intent.action.MEDIA_BUTTON\" />\n" +
          "    </intent-filter>\n" +
          "  </receiver>",
      )
    }
    // A dev reload destroys the JS runtime and every Nitro callback with it. If
    // that happens while a session is up, the notification would survive with
    // dead buttons — so tear the session down first. See `ReactRuntime`.
    beforeDestroy = ReactRuntime.addBeforeDestroyListener(application) { stop {} }
    main.post {
      // **The handover.** In a playback resumption the service has already
      // built a `BroadcastPlayer` and handed it to a live `MediaLibrarySession`;
      // replacing it here would leave media3 holding a player nothing updates
      // and the notification frozen on the resumed track forever. The player
      // never captured handlers in the first place (it asks `dispatch` per
      // command), so reusing it *is* the handover — there is nothing to
      // transfer.
      if (player == null) player = BroadcastPlayer(this)
      onReady()
      handover(handlers)
    }
  }

  /**
   * Finish a playback resumption, if one was in flight. Main thread only.
   *
   * Order matters and is the mirror image of the sleep timer's (ARCHITECTURE
   * §19): there, JS is told *after* the native pause, because the pause already
   * happened. Here JS is told *before* the replay, because the replay is a real
   * command the app is about to have to service — `onPlaybackResumption` is the
   * app's chance to be ready for it (refresh a token, re-open a file) rather
   * than a post-mortem.
   *
   * The two conditions are deliberately separate. A revival can complete with
   * nothing deferred (the service was woken by a media button that was not a
   * play), and commands can only be deferred during a revival — so
   * "was there a revival" is the service's question and "is there anything to
   * replay" is this object's.
   */
  private fun handover(handlers: MediaSessionHandlers) {
    val revived = service?.onRevivalComplete() ?: false
    if (revived) handlers.onPlaybackResumption()
    if (!revivalPending) return
    revivalPending = false
    val pending = deferred.toList()
    deferred.clear()
    for (command in pending) command(handlers)
  }

  /**
   * End background execution. The ONLY thing that does — `pause()` never does
   * (PLAN §5.4).
   */
  fun stop(onDone: () -> Unit) {
    // Before anything else, and synchronously: this method is also the
    // `ReactHost` before-destroy listener (see [initialize]), so a dev reload
    // arrives here with the runtime about to die. A timer left armed would fire
    // into handlers belonging to a runtime that no longer exists.
    sleepTimer.cancel()
    // Cleared synchronously, before anything is posted: after this point no
    // media3 callback can reach a JS handler the caller is about to discard.
    handlers = null
    current = Snapshot.EMPTY
    beforeDestroy?.let { listener ->
      appContext?.let { ReactRuntime.removeBeforeDestroyListener(it, listener) }
    }
    beforeDestroy = null
    main.post {
      // A command held for a runtime that is being torn down is not a command
      // any more. (`stop` is also the dev-reload hook — see above.)
      deferred.clear()
      revivalPending = false
      player?.releasePending()
      service?.releaseAndStop()
      // `service` is nulled by `detachService` when the OS actually destroys
      // it; clearing the request flag here lets a later `init` + play start a
      // fresh one even if that destruction is still in flight.
      serviceRequested = false
      player = null
      androidConfig = null
      onDone()
    }
  }

  // MARK: - Broadcast channels

  fun setPlaybackState(state: NativePlaybackState) {
    val anchor = Anchor.receive(state.position)
    main.post {
      val next = current.withPlaybackState(state, anchor)
      current = next
      player?.update(next, acknowledgesCommands = true)
      service?.refresh(next)
      // Only a play-shaped broadcast may start the service. `paused` and
      // `stopped` never stop it either: media3 demotes it by itself once
      // playWhenReady goes false, and `stopService()` is the only thing that
      // ends background execution (PLAN §5.4).
      if (next.wantsForeground) startService()
    }
  }

  fun setMediaItem(item: NativeMediaItem?) {
    main.post {
      val next = current.copy(item = item)
      current = next
      player?.update(next, acknowledgesCommands = false)
    }
  }

  fun setQueue(items: List<NativeMediaItem>) {
    main.post {
      val next = current.copy(queue = items)
      current = next
      player?.update(next, acknowledgesCommands = false)
    }
  }

  /**
   * Mirror the persisted session for a future cold start. Called from the JS
   * thread by `withPersistence`; returns immediately (the file write happens on
   * [ResumptionStore]'s own thread).
   *
   * Gated on the opt-in, and not merely as an optimisation: an app that turned
   * playback resumption *off* has said it does not want the OS bringing it back
   * from a snapshot, and leaving a readable one behind would let a service
   * created for some other reason find it.
   */
  fun setResumptionSnapshot(json: String?) {
    val context = appContext ?: return
    if (androidConfig?.playbackResumption != true) return
    ResumptionStore.putSession(context, json)
  }

  // MARK: - Service handshake

  /** Called from `Service.onCreate` on the main thread. `null` = nothing to serve. */
  fun attachService(service: RnMediaMediaSessionService): BroadcastPlayer? {
    val existing = player ?: return null
    this.service = service
    serviceRequested = true
    return existing
  }

  /**
   * Attach a service that found **no initialized session**, seeding it from the
   * persisted mirror. Main thread only, called from `Service.onCreate`.
   *
   * This is the cold half of [attachService]: there is no JS runtime, so there
   * are no handlers, no config from `initialize` and no live snapshot. What
   * there is, is a `Snapshot` read synchronously out of `SharedPreferences` —
   * enough to build a session that shows the right track and answers the System
   * UI's resumption queries, which is all that has to be true before the
   * runtime exists.
   *
   * The config is taken from the mirror too. A later `initialize` with a
   * *different* config does not retro-fit the running service — same rule as
   * `stopForegroundTimeoutMs` (see the service's `applyForegroundServiceTimeout`).
   */
  fun attachRevivedService(
    service: RnMediaMediaSessionService,
    config: AndroidMediaSessionConfig,
    seed: Snapshot,
  ): BroadcastPlayer {
    appContext = service.applicationContext
    androidConfig = config
    current = seed
    this.service = service
    serviceRequested = true
    val facade = player ?: BroadcastPlayer(this).also { player = it }
    facade.update(seed, acknowledgesCommands = false)
    return facade
  }

  /**
   * A transport command resolved by media3. Main thread (media3's application
   * looper). Implements [CommandDispatcher].
   *
   * The normal case is the first line: hand it to the app and return. The rest
   * exists for the window in which a media3 session is alive and JavaScript is
   * not — only reachable during a playback resumption, because that is the only
   * way a session comes into being without an `initialize`.
   */
  override fun dispatch(startsPlayback: Boolean, invoke: (MediaSessionHandlers) -> Unit) {
    val target = handlers
    if (target != null) {
      invoke(target)
      return
    }

    val reviving = service?.beginRevival(startsPlayback) == true
    if (!reviving) {
      // No service, resumption disabled, or nothing to revive into. Dropping is
      // the honest outcome: there is no app to service the command and no
      // prospect of one.
      Log.w(
        RnMediaMediaSessionService.TAG,
        "A transport command arrived with no JavaScript handler and no revival in progress; " +
          "ignoring it.",
      )
      return
    }

    revivalPending = true
    while (deferred.size >= MAX_DEFERRED_COMMANDS) deferred.removeFirst()
    deferred.addLast(invoke)
  }

  /** Called from `Service.onDestroy` on the main thread. */
  fun detachService(service: RnMediaMediaSessionService) {
    if (this.service !== service) return
    this.service = null
    serviceRequested = false
  }

  /**
   * The app's task was swiped out of Recents.
   *
   * Fire-and-forget by design: the native default policy in
   * [RnMediaMediaSessionService.onTaskRemoved] has already been decided by the
   * time this returns, precisely so a wedged JS runtime cannot stop the service
   * from doing the right thing.
   */
  fun notifyTaskRemoved() {
    handlers?.onTaskRemoved()
  }

  // MARK: - Sleep timer

  /** Arm (or re-arm) the sleep timer. Called from the JS thread. */
  fun setSleepTimer(seconds: Double) {
    sleepTimer.arm(seconds)
  }

  /** Disarm. Called from the JS thread. */
  fun cancelSleepTimer() {
    sleepTimer.cancel()
  }

  /** Seconds remaining, or `null`. Called from the JS thread; must not block. */
  fun sleepTimerRemaining(): Double? = sleepTimer.remainingSeconds()

  /**
   * The sleep timer elapsed. Main thread (see [SleepTimer]).
   *
   * **Native-first, exactly like a notification pause** (ARCHITECTURE §9): the
   * facade player is paused through its own public `Player.pause()`, which is
   * the very call a `MediaController` — the notification, the lock screen, a
   * Bluetooth remote — ends up making. So the session, the notification and the
   * scrubber go to paused immediately, `SimpleBasePlayer` shows its optimistic
   * placeholder, and `handleSetPlayWhenReady(false)` dispatches `pause` to JS
   * to actually stop the audio. Reusing that path rather than reimplementing it
   * is what makes "the timer fired" and "the user pressed pause" indistinguish-
   * able to every surface, which is the correct behaviour and also one code
   * path to keep working.
   *
   * Only *then* is JS told the timer fired, fire-and-forget. The ordering is
   * part of the contract: `onSleepTimer` is a notification of something already
   * done, never a request to do it (see `MediaSessionHandlers.onSleepTimer`).
   */
  private fun onSleepTimerFired() {
    val facade = player
    when {
      facade == null ->
        // No session (stopped, or never initialized). Nothing to pause; the JS
        // notification still goes out so an app-level timer UI can clear.
        Log.w(RnMediaMediaSessionService.TAG, "Sleep timer fired with no active session.")

      facade.isCommandAvailable(Player.COMMAND_PLAY_PAUSE) -> facade.pause()

      else -> {
        // `SimpleBasePlayer` silently ignores `pause()` when COMMAND_PLAY_PAUSE
        // is not in `State.availableCommands`, i.e. when the app broadcast no
        // `pause` capability. Falling through to the handler still honours the
        // user's intent — the audio stops — while the session state correctly
        // stays where the app put it.
        Log.w(
          RnMediaMediaSessionService.TAG,
          "Sleep timer fired but the app does not advertise the `pause` capability; " +
            "calling the JS pause handler directly. The session state will not change " +
            "until the app broadcasts it.",
        )
        handlers?.pause()
      }
    }
    handlers?.onSleepTimer()
  }

  // MARK: - Foreground service start/stop

  /**
   * Start the service, if it is not already up. Main thread only.
   *
   * Called exclusively from a broadcast that says playback is starting, which
   * is the Android 12+ contract: an app may start a foreground service while it
   * is itself foreground, or within the exemption window granted by a media
   * button press. media3 then owns every subsequent `startForeground` /
   * `stopForeground` transition.
   *
   * `startForegroundService` rather than `startService`: it is the same call
   * media3 makes internally when it promotes us, it is the one that survives
   * the app being backgrounded a moment later, and it produces the *documented*
   * failure (`ForegroundServiceStartNotAllowedException`) rather than the
   * generic background-service `IllegalStateException`.
   */
  private fun startService() {
    if (serviceRequested) return
    val context = appContext ?: return
    val intent = Intent(context, RnMediaMediaSessionService::class.java)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        // Pre-O there is no foreground-service start and no background-start
        // restriction; a plain start is both sufficient and correct.
        context.startService(intent)
      }
      serviceRequested = true
    } catch (error: IllegalStateException) {
      // API 31+ subclasses IllegalStateException with
      // ForegroundServiceStartNotAllowedException. Both mean the same thing to
      // us: playback was started from a state the OS does not consider
      // startable, so there will be no notification and no protected process.
      val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        error is ForegroundServiceStartNotAllowedException
      Log.e(
        RnMediaMediaSessionService.TAG,
        if (restricted) {
          "Refused to start the media foreground service: playback began while the app " +
            "was in the background with no exemption (Android 12+). The session will " +
            "have no notification until playback is started from the foreground."
        } else {
          "Could not start the media foreground service."
        },
        error,
      )
    }
  }

  private val Snapshot.wantsForeground: Boolean
    get() = status == MediaPlaybackStatus.PLAYING || status == MediaPlaybackStatus.BUFFERING

  // MARK: - Revival

  /**
   * Move the revived session to `buffering`. Main thread only.
   *
   * Called by the service the moment a resumption starts, and it is what makes
   * media3 — not this package — promote the service to the foreground and post
   * the media notification: `MediaNotificationManager.isAnySessionUserEngaged`
   * is `playWhenReady && (STATE_READY || STATE_BUFFERING)`, and `buffering`
   * maps to exactly that (see `BroadcastPlayer.getState`). Handing the
   * transition back to media3 as fast as possible is deliberate — the service's
   * own `startForeground` is a stopgap for the five-second contract, not an
   * ownership claim (ARCHITECTURE, "media3 owns the actual
   * startForeground/stopForeground transitions").
   *
   * `buffering` is also simply true: the audio is not playing, and the thing it
   * is waiting for — a JS runtime — is on its way.
   */
  fun markResuming() {
    // Posted rather than applied inline, and acknowledging: this runs from
    // inside media3's own `play` dispatch, at which point `SimpleBasePlayer`
    // has an operation pending and `invalidateState()` early-returns — the new
    // state would simply not be read. Completing the pending future on the next
    // main-loop turn is the mechanism the class provides for exactly this
    // ("re-reads getState() by itself the moment the future completes"), and it
    // is what gets `buffering` in front of media3 in milliseconds instead of at
    // the 3-second acknowledgement deadline.
    main.post {
      val next = current.copy(status = MediaPlaybackStatus.BUFFERING)
      current = next
      player?.update(next, acknowledgesCommands = true)
    }
  }

  /**
   * Abandon a revival that never completed. Main thread only.
   *
   * Everything the cold start built is dropped, including the facade player:
   * the service is about to release the session that holds it, and a later
   * `initialize` in this same process must build a fresh one rather than reuse
   * a player wired to a dead session.
   */
  fun discardRevival() {
    deferred.clear()
    revivalPending = false
    player?.releasePending()
    player = null
    current = Snapshot.EMPTY
    androidConfig = null
    serviceRequested = false
  }

  /**
   * How many pre-runtime commands are worth keeping. Small on purpose: this
   * queue exists to not lose the `play` that started a resumption, not to
   * become a general-purpose command log.
   */
  private const val MAX_DEFERRED_COMMANDS = 8
}
