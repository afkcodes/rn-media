//
//  CastMapping.swift
//  RnMediaCast
//
//  Pure translations between GoogleCast's enums and the generated Nitro
//  vocabulary — the iOS mirror of the Android `CastMapping` object. Kept free
//  of any stateful GCK object so the mapping stays trivially reviewable
//  against `CastMappingTest`'s Android pins (the two SDKs share their
//  constant *meanings*, per the Cast protocol).
//

import Foundation
import GoogleCast

enum CastMapping {
  /**
   * `GCKCastState` → connection state. `noDevicesAvailable` and
   * `notConnected` both fold to `idle` — "framework ready, no session".
   * `unavailable` is an initialization verdict and never produced here.
   */
  static func connectionState(_ state: GCKCastState) -> CastConnectionState {
    switch state {
    case .connecting: return .connecting
    case .connected: return .connected
    case .noDevicesAvailable, .notConnected: return .idle
    @unknown default: return .idle
    }
  }

  static func playerState(_ state: GCKMediaPlayerState) -> CastPlayerState {
    switch state {
    case .idle: return .idle
    case .playing: return .playing
    case .paused: return .paused
    case .buffering: return .buffering
    case .loading: return .loading
    case .unknown: return .unknown
    @unknown default: return .unknown
    }
  }

  /// An unknown idle reason folds to `.none`, never `.error` — inventing a
  /// receiver failure would fire the app's error UI for nothing.
  static func idleReason(_ reason: GCKMediaPlayerIdleReason) -> CastIdleReason {
    switch reason {
    case .finished: return .finished
    case .cancelled: return .cancelled
    case .interrupted: return .interrupted
    case .error: return .error
    case .none: return .none
    @unknown default: return .none
    }
  }

  static func repeatMode(_ mode: GCKMediaRepeatMode) -> CastRepeatMode {
    switch mode {
    case .all: return .all
    case .single: return .one
    case .allAndShuffle: return .allandshuffle
    case .off: return .off
    // `.unchanged` is a *request* sentinel, not a state; fold like unknown.
    case .unchanged: return .off
    @unknown default: return .off
    }
  }

  static func toGCKRepeatMode(_ mode: CastRepeatMode) -> GCKMediaRepeatMode {
    switch mode {
    case .off: return .off
    case .all: return .all
    case .one: return .single
    case .allandshuffle: return .allAndShuffle
    }
  }

  static func toGCKResumeState(_ state: CastSeekResumeState) -> GCKMediaResumeState {
    switch state {
    case .unchanged: return .unchanged
    case .play: return .play
    case .pause: return .pause
    }
  }

  /// Public-API seconds sanitised for GCK's `TimeInterval` fields: non-finite
  /// and negative fold to 0 (the Android rule, verbatim).
  static func sanitizeSeconds(_ seconds: Double) -> TimeInterval {
    guard seconds.isFinite, seconds > 0 else { return 0 }
    return seconds
  }

  static func deviceInfo(_ device: GCKDevice) -> CastDeviceInfo {
    CastDeviceInfo(
      id: device.deviceID,
      name: device.friendlyName ?? device.deviceID,
      model: device.modelName
    )
  }
}
