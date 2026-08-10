package com.rnmediamediasession

import android.os.Handler
import android.os.Looper
import android.os.SystemClock

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
   * One instance, reused: `removeCallbacks` matches by identity, so a fresh
   * lambda per arm would leave the previous one queued and fire twice.
   */
  private val task = Runnable {
    dueAtUptimeMs = null
    onFire()
  }

  /**
   * Arm (or re-arm) the timer.
   *
   * @param seconds strictly positive — validated in TS before it gets here.
   * Re-arming replaces any pending timer rather than stacking a second one.
   */
  fun arm(seconds: Double) {
    handler.removeCallbacks(task)
    val delayMs = (seconds * 1000.0).toLong().coerceAtLeast(0L)
    dueAtUptimeMs = SystemClock.uptimeMillis() + delayMs
    handler.postDelayed(task, delayMs)
  }

  /** Disarm. A no-op when nothing is armed. */
  fun cancel() {
    dueAtUptimeMs = null
    handler.removeCallbacks(task)
  }

  /** Seconds until the timer fires, or `null` when disarmed. Never negative. */
  fun remainingSeconds(): Double? {
    val due = dueAtUptimeMs ?: return null
    return ((due - SystemClock.uptimeMillis()).coerceAtLeast(0L)) / 1000.0
  }
}
