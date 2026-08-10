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
internal object MediaSessionController {

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
    // A dev reload destroys the JS runtime and every Nitro callback with it. If
    // that happens while a session is up, the notification would survive with
    // dead buttons — so tear the session down first. See `ReactRuntime`.
    beforeDestroy = ReactRuntime.addBeforeDestroyListener(application) { stop {} }
    main.post {
      player = BroadcastPlayer(handlers)
      onReady()
    }
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

  // MARK: - Service handshake

  /** Called from `Service.onCreate` on the main thread. `null` = nothing to serve. */
  fun attachService(service: RnMediaMediaSessionService): BroadcastPlayer? {
    val existing = player ?: return null
    this.service = service
    serviceRequested = true
    return existing
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
}
