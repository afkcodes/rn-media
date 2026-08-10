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

  init(onFire: @escaping () -> Void) {
    self.onFire = onFire
  }

  deinit {
    lock.lock()
    workItem?.cancel()
    lock.unlock()
  }

  /// Arm (or re-arm) the timer. Any pending timer is replaced, never stacked.
  func arm(seconds: Double) {
    let delay = max(0, seconds)

    lock.lock()
    workItem?.cancel()
    generation &+= 1
    let token = generation
    deadlineUptimeNs =
      DispatchTime.now().uptimeNanoseconds &+ UInt64((delay * 1_000_000_000).rounded())
    let item = DispatchWorkItem { [weak self] in self?.fire(token) }
    workItem = item
    lock.unlock()

    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }

  /// Disarm. A no-op when nothing is armed.
  func cancel() {
    lock.lock()
    workItem?.cancel()
    workItem = nil
    deadlineUptimeNs = nil
    // Also invalidates an item that has already begun executing.
    generation &+= 1
    lock.unlock()
  }

  /// Seconds until the timer fires, or `nil` when disarmed. Never negative.
  func remainingSeconds() -> Double? {
    lock.lock()
    defer { lock.unlock() }
    guard let due = deadlineUptimeNs else { return nil }
    let now = DispatchTime.now().uptimeNanoseconds
    guard due > now else { return 0 }
    return Double(due - now) / 1_000_000_000
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
    lock.unlock()
    // Never called under the lock: it re-enters this module's main-queue state
    // and may end up back in `cancel()`.
    onFire()
  }
}
