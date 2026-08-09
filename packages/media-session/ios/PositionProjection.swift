//
//  PositionProjection.swift
//  RnMediaMediaSession
//
//  Wall-clock anchor -> monotonic anchor -> projected position.
//

import Foundation
import QuartzCore

/**
 * The position anchor, translated out of JavaScript's clock and into one that
 * cannot jump.
 *
 * JS can only timestamp with `Date.now()` (wall clock, adjustable by NTP, by
 * the user, and by a timezone daemon). `CACurrentMediaTime()` is
 * `mach_absolute_time`-backed and monotonic while the device is awake, which is
 * what a playback position needs.
 *
 * The conversion happens **once, the instant the broadcast arrives**, so the
 * error is bounded by the JS -> native hop instead of by however long the app
 * stays open:
 *
 * ```
 * age    = wallClockNow - anchor.at      (milliseconds this anchor is stale)
 * origin = CACurrentMediaTime() - age    (the same instant, monotonic)
 * ```
 */
struct PositionProjection {
  /// Position in seconds at ``origin``.
  let valueSeconds: TimeInterval
  /// `CACurrentMediaTime()` value the position was sampled at.
  let origin: CFTimeInterval
  /// Seconds of media per second of wall time. `0` freezes the projection.
  let rate: Double

  /// Anchor meaning "nothing is playing, at zero".
  static let zero = PositionProjection(valueSeconds: 0, origin: CACurrentMediaTime(), rate: 0)

  /**
   * Build from the bridge's `{ value, at, rate }` **at the moment of receipt**.
   * Calling this later than that reintroduces exactly the staleness it exists
   * to remove.
   */
  init(valueMs: Double, atEpochMs: Double, rate: Double, now: CFTimeInterval = CACurrentMediaTime()) {
    let nowEpochMs = Date().timeIntervalSince1970 * 1000
    // A negative age means the JS clock is ahead of ours (clock skew during an
    // NTP step). Clamping to zero keeps the anchor from being projected into
    // the future, which would show a position that runs ahead and then stalls.
    let ageMs = max(0, nowEpochMs - atEpochMs)
    self.valueSeconds = max(0, valueMs / 1000)
    self.origin = now - (ageMs / 1000)
    self.rate = rate
  }

  init(valueSeconds: TimeInterval, origin: CFTimeInterval, rate: Double) {
    self.valueSeconds = valueSeconds
    self.origin = origin
    self.rate = rate
  }

  /**
   * Position now.
   *
   * Used **only** when the now-playing dictionary has to be re-posted for some
   * other reason (artwork finished loading, metadata changed). It is never
   * called on a timer — iOS extrapolates elapsed time itself from the last
   * `MPNowPlayingInfoPropertyElapsedPlaybackTime` and
   * `MPNowPlayingInfoPropertyPlaybackRate` pair ("Elapsed time is automatically
   * calculated, by the system, from the previously provided elapsed time and
   * the playback rate. It isn't necessary to update this property frequently."
   * — developer.apple.com/documentation/mediaplayer/mpnowplayinginfopropertyelapsedplaybacktime).
   *
   * Re-posting *is* mandatory when we re-post at all: handing iOS a stale
   * `elapsed` with a live `rate` would restart its extrapolation from the past
   * and visibly rewind the lock-screen scrubber.
   */
  func projectedSeconds(now: CFTimeInterval = CACurrentMediaTime()) -> TimeInterval {
    guard rate != 0 else { return valueSeconds }
    return max(0, valueSeconds + (now - origin) * rate)
  }
}
