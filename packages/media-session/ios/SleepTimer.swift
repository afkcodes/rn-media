//
//  SleepTimer.swift
//  RnMediaMediaSession
//
//  A sleep timer that is not a JavaScript timer.
//

import Foundation

/**
 * Pause playback after N seconds, on a platform timer.
 *
 * ## Why this is native
 * The same reason as on Android, and it is not iOS-specific: React Native's JS
 * timers are not a dependable background clock, and a sleep timer's entire job
 * happens after the user has put the phone down. `DispatchQueue.main.asyncAfter`
 * with a cancellable `DispatchWorkItem` is scheduled by libdispatch, has no
 * relationship to the React runtime, and keeps counting for as long as the
 * process is running.
 *
 * ## The honest iOS caveat
 * "As long as the process is running" is the whole caveat. iOS suspends a
 * backgrounded app shortly after its audio **stops**, and a suspended process
 * runs no timers of any kind. In practice that is exactly the right shape for
 * this feature:
 *
 * - A timer armed while audio is playing *will* fire: playing audio (with
 *   `UIBackgroundModes: audio`) is what keeps the process out of suspension,
 *   and the timer's job — pausing that audio — is done at the instant it fires.
 * - What happens *after* it fires is that audio stops and iOS becomes free to
 *   suspend the process. That is fine; the work is finished.
 * - What cannot be relied on is a timer armed over silence, or still pending
 *   when playback stops for some other reason. There is no supported way to
 *   change that, and `beginBackgroundTask` would only buy ~30 seconds.
 *
 * `DispatchTime` is `mach_absolute_time`-backed, so — like Android's
 * `uptimeMillis` — it does not advance while the device is fully asleep.
 * Playing audio keeps it advancing, which is the window that matters.
 *
 * ## Threading
 * ``arm(seconds:)``, ``cancel()`` and ``remainingSeconds()`` are called from
 * the JS thread; the fire closure runs on the **main queue**, where the rest of
 * this module's state lives. The lock exists only to keep those two worlds from
 * racing over the deadline — it is never held across the fire callback.
 */
/**
 * What a broadcast should do to an **armed** end-of-track sleep timer.
 *
 * The Swift twin of Kotlin's `TrackEndAction` / `trackEndAction(...)`, kept in
 * the same shape on purpose: it is the only branching in the feature, and the
 * two platforms getting it subtly different is precisely the class of bug this
 * package exists to prevent. The Kotlin half is unit-tested on the JVM; this one
 * is verified by inspection and on device (there is no Swift test target here).
 */
enum TrackEndAction: Equatable {
  /**
   * The item the timer was waiting on is gone — it finished and the app
   * advanced, or the user skipped, or the media item was cleared. "After this
   * one" has happened; fire.
   */
  case fire

  /**
   * Keep waiting, and re-aim the deadline.
   *
   * `latchTo` is non-nil when this broadcast is the first to name an item since
   * the timer was armed — arming over silence latches onto whatever turns up
   * rather than firing because the item changed from nothing to something.
   */
  case wait(latchTo: String?)

  /**
   * - Parameter latched: the item key the timer is waiting on, or `nil` for
   *   "armed, nothing latched yet". A single optional rather than a key plus a
   *   `latched` flag, deliberately: the two-field form let the pair drift out of
   *   step, so a fired timer left a stale key behind and the *next* arm could
   *   read "the item changed" against an item from a previous session and pause
   *   playback at the instant of arming. One field cannot be half-reset.
   * - Parameter current: the key of what is playing now, or `nil` for nothing.
   */
  static func next(latched: String?, current: String?) -> TrackEndAction {
    guard let latched else { return .wait(latchTo: current) }
    return current == latched ? .wait(latchTo: nil) : .fire
  }
}

final class SleepTimer {

  private let lock = NSLock()
  private let onFire: () -> Void

  /// Guarded by ``lock``.
  private var workItem: DispatchWorkItem?
  /// `DispatchTime.now().uptimeNanoseconds` the timer is due at. Guarded by ``lock``.
  private var deadlineUptimeNs: UInt64?
  /**
   * Bumped on every arm and cancel. Guarded by ``lock``.
   *
   * `DispatchWorkItem.cancel()` prevents a not-yet-started item from running,
   * but a re-arm that lands while the old item is *already executing* would
   * otherwise let a stale fire through. Comparing the token the item captured
   * against the current one closes that window.
   */
  private var generation: UInt64 = 0

  /**
   * Which shape of timer is armed, or `nil` for none. Guarded by ``lock``.
   *
   * Tracked apart from ``deadlineUptimeNs`` because for an end-of-track timer
   * the two are genuinely independent: it can be armed with **no** deadline (a
   * live stream, a paused player, or a duration the app has not broadcast yet)
   * and still be waiting to fire on the item change. Collapsing them would make
   * that state indistinguishable from "not armed".
   */
  private var armedMode: SleepTimerMode?

  init(onFire: @escaping () -> Void) {
    self.onFire = onFire
  }

  deinit {
    lock.lock()
    workItem?.cancel()
    lock.unlock()
  }

  /// Arm (or re-arm) a countdown. Any pending timer is replaced, never stacked.
  func arm(seconds: Double) {
    schedule(mode: .duration, delaySeconds: max(0, seconds))
  }

  /**
   * Arm the end-of-current-track mode with **no deadline yet**.
   *
   * The deadline is not this object's to know: it comes out of the broadcast
   * channels and moves whenever they do, so `HybridRnMediaMediaSession` follows
   * up with ``scheduleTrackEnd(delaySeconds:)`` on arm and on every broadcast.
   */
  func armAtTrackEnd() {
    schedule(mode: .trackend, delaySeconds: nil)
  }

  /**
   * Move (or clear) the deadline of an already-armed end-of-track timer.
   *
   * Ignored unless a `trackEnd` timer is armed, so a broadcast arriving after a
   * `cancel` cannot resurrect one. `nil` leaves the timer **armed** and waiting
   * for the item to change — a different thing from disarmed, which is
   * ``cancel()``.
   */
  func scheduleTrackEnd(delaySeconds: Double?) {
    lock.lock()
    let armed = armedMode == .trackend
    lock.unlock()
    guard armed else { return }
    schedule(mode: .trackend, delaySeconds: delaySeconds.map { max(0, $0) })
  }

  /// Disarm. A no-op when nothing is armed.
  func cancel() {
    lock.lock()
    workItem?.cancel()
    workItem = nil
    deadlineUptimeNs = nil
    armedMode = nil
    // Also invalidates an item that has already begun executing.
    generation &+= 1
    lock.unlock()
  }

  /// Seconds until the timer fires, or `nil` when there is no deadline. Never negative.
  func remainingSeconds() -> Double? {
    lock.lock()
    defer { lock.unlock() }
    return remainingSecondsLocked()
  }

  /// The armed mode, or `nil` when nothing is armed.
  func mode() -> SleepTimerMode? {
    lock.lock()
    defer { lock.unlock() }
    return armedMode
  }

  /**
   * The structured state `getSleepTimer()` reports.
   *
   * Both halves are read under one lock acquisition: the fire work item clears
   * them on the main queue while this runs on the JS thread, and two separate
   * reads could report a mode whose deadline has just been cleared.
   */
  func state() -> NativeSleepTimerState? {
    lock.lock()
    defer { lock.unlock() }
    guard let armed = armedMode else { return nil }
    return NativeSleepTimerState(mode: armed, remainingSeconds: remainingSecondsLocked())
  }

  // MARK: - Private

  /// Caller must hold ``lock``.
  private func remainingSecondsLocked() -> Double? {
    guard let due = deadlineUptimeNs else { return nil }
    let now = DispatchTime.now().uptimeNanoseconds
    guard due > now else { return 0 }
    return Double(due - now) / 1_000_000_000
  }

  private func schedule(mode: SleepTimerMode, delaySeconds: Double?) {
    lock.lock()
    workItem?.cancel()
    generation &+= 1
    let token = generation
    armedMode = mode

    guard let delay = delaySeconds else {
      // Armed, no deadline. Nothing is posted, so nothing can fire until a
      // later `scheduleTrackEnd` gives it one — or the caller decides the item
      // has changed and fires directly.
      workItem = nil
      deadlineUptimeNs = nil
      lock.unlock()
      return
    }

    deadlineUptimeNs =
      DispatchTime.now().uptimeNanoseconds &+ UInt64((delay * 1_000_000_000).rounded())
    let item = DispatchWorkItem { [weak self] in self?.fire(token) }
    workItem = item
    lock.unlock()

    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }

  /// Main queue.
  private func fire(_ token: UInt64) {
    lock.lock()
    guard token == generation else {
      lock.unlock()
      return
    }
    workItem = nil
    deadlineUptimeNs = nil
    armedMode = nil
    lock.unlock()
    // Never called under the lock: it re-enters this module's main-queue state
    // and may end up back in `cancel()`.
    onFire()
  }
}
