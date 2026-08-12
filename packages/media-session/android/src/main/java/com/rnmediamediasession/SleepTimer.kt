package com.rnmediamediasession

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.margelo.nitro.rnmediamediasession.NativeSleepTimerState
import com.margelo.nitro.rnmediamediasession.SleepTimerMode

/**
 * A sleep timer that is not a JavaScript timer.
 *
 * ## Why this cannot live in JS
 * React Native's `JavaTimerManager` gates `setTimeout` on the Activity
 * lifecycle plus any running headless task: with the Activity destroyed the
 * timer queue is idled, and on Samsung builds it is frozen even *with* an
 * Activity (RN #56324). A sleep timer's entire job happens after the user has
 * put the phone down — i.e. exactly when JS timers do not run — so an app that
 * builds one on `setTimeout` ships a bug it will only hear about in reviews.
 * `Handler.postDelayed` on the main looper is owned by the OS, has no
 * relationship to any Activity, and keeps counting for as long as the process
 * lives (which, during playback, is what the foreground service guarantees).
 *
 * ## Clock, stated precisely
 * `Handler.postDelayed` schedules against `SystemClock.uptimeMillis()`, which
 * **does not advance while the device is in deep sleep**. That is the right
 * trade here rather than a defect: the timer only means anything while audio is
 * playing, and audio playback holds the CPU awake, so uptime and wall time
 * advance together for the whole window that matters. The alternative —
 * `AlarmManager` with an exact alarm — would make this library demand
 * `SCHEDULE_EXACT_ALARM` from every consumer to solve a case (a sleep timer
 * armed over silence) that has no meaning.
 *
 * [remainingSeconds] is therefore read from the *same* clock the post was made
 * against, so it can never disagree with when the timer will actually fire.
 *
 * ## Threading
 * [arm] and [cancel] are called from the JS thread; `Handler` is thread-safe
 * for posting and removing. [onFire] runs on the **main thread**, which is what
 * [BroadcastPlayer] requires. [remainingSeconds] is read from the JS thread,
 * hence `@Volatile`.
 */
internal class SleepTimer(private val onFire: () -> Unit) {

  private val handler = Handler(Looper.getMainLooper())

  /** `SystemClock.uptimeMillis()` the timer is due at, or `null` when disarmed. */
  @Volatile
  private var dueAtUptimeMs: Long? = null

  /**
   * Which shape of timer is armed, or `null` for none.
   *
   * Tracked separately from [dueAtUptimeMs] because the two are genuinely
   * independent for an end-of-track timer: it can be *armed with no deadline*
   * (a live stream, a paused player, or a duration the app has not broadcast
   * yet) and still be waiting to fire on the item change. Collapsing the two
   * into "is there a deadline" is what would make that state indistinguishable
   * from "not armed", which is the reporting bug `getSleepTimer` exists to fix.
   */
  @Volatile
  private var mode: SleepTimerMode? = null

  /**
   * One instance, reused: `removeCallbacks` matches by identity, so a fresh
   * lambda per arm would leave the previous one queued and fire twice.
   */
  private val task = Runnable {
    dueAtUptimeMs = null
    mode = null
    onFire()
  }

  /**
   * Arm (or re-arm) a countdown.
   *
   * @param seconds strictly positive — validated in TS before it gets here.
   * Re-arming replaces any pending timer rather than stacking a second one.
   */
  fun arm(seconds: Double) {
    handler.removeCallbacks(task)
    val delayMs = (seconds * 1000.0).toLong().coerceAtLeast(0L)
    mode = SleepTimerMode.DURATION
    dueAtUptimeMs = SystemClock.uptimeMillis() + delayMs
    handler.postDelayed(task, delayMs)
  }

  /**
   * Arm the end-of-current-track mode with **no deadline yet**.
   *
   * The deadline is not the caller's to know: it comes out of the broadcast
   * channels and moves whenever they do, so [MediaSessionController] follows up
   * with [scheduleTrackEnd] on arm and on every subsequent broadcast.
   */
  fun armAtTrackEnd() {
    handler.removeCallbacks(task)
    mode = SleepTimerMode.TRACKEND
    dueAtUptimeMs = null
  }

  /**
   * Move (or clear) the deadline of an already-armed end-of-track timer.
   *
   * Ignored unless a `trackEnd` timer is armed, so a stray broadcast arriving
   * after a `cancel` cannot resurrect one. `null` means "no computable
   * deadline" and leaves the timer armed and waiting for the item to change —
   * not disarmed, which is a different thing and is what `cancel` is for.
   */
  fun scheduleTrackEnd(delayMs: Long?) {
    if (mode != SleepTimerMode.TRACKEND) return
    handler.removeCallbacks(task)
    if (delayMs == null) {
      dueAtUptimeMs = null
      return
    }
    val bounded = delayMs.coerceAtLeast(0L)
    dueAtUptimeMs = SystemClock.uptimeMillis() + bounded
    handler.postDelayed(task, bounded)
  }

  /** Disarm. A no-op when nothing is armed. */
  fun cancel() {
    dueAtUptimeMs = null
    mode = null
    handler.removeCallbacks(task)
  }

  /** Seconds until the timer fires, or `null` when there is no deadline. Never negative. */
  fun remainingSeconds(): Double? {
    val due = dueAtUptimeMs ?: return null
    return ((due - SystemClock.uptimeMillis()).coerceAtLeast(0L)) / 1000.0
  }

  /** The armed mode, or `null` when nothing is armed. */
  fun mode(): SleepTimerMode? = mode

  /** The structured state `getSleepTimer()` reports. */
  fun state(): NativeSleepTimerState? {
    // Read once: `mode` and `dueAtUptimeMs` are cleared by the fire task on the
    // main thread while this runs on the JS thread, and reading `mode` twice
    // could report a mode with a deadline that has just been cleared.
    val armed = mode ?: return null
    return NativeSleepTimerState(armed, remainingSeconds())
  }
}
