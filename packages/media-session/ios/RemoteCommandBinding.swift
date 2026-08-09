//
//  RemoteCommandBinding.swift
//  RnMediaMediaSession
//
//  MPRemoteCommandCenter target lifecycle.
//

import Foundation
import MediaPlayer

/// The subset of `MPRemoteCommandCenter` this package drives.
enum RemoteCommandKind: CaseIterable {
  case play
  case pause
  case togglePlayPause
  case stop
  case nextTrack
  case previousTrack
  case changePlaybackPosition
  case changePlaybackRate
  case skipForward
  case skipBackward
}

/// What a command does when it fires. Injected so the binding is pure plumbing.
struct RemoteCommandActions {
  let play: () -> Void
  let pause: () -> Void
  let stop: () -> Void
  let skipToNext: () -> Void
  let skipToPrevious: () -> Void
  /// Absolute seek, in **milliseconds** (the bridge's unit).
  let seekTo: (Double) -> Void
  let setRate: (Double) -> Void
  /// `true` while the broadcast status is `playing`. Drives togglePlayPause.
  let isPlaying: () -> Bool
  /// Projected position **in seconds**, for turning skip intervals into seeks.
  let currentPositionSeconds: () -> TimeInterval
}

/**
 * Enables exactly the commands the app advertises, and — the part everyone gets
 * wrong — *removes the targets* of the ones it does not.
 *
 * `MPRemoteCommand.addTarget(handler:)` returns "an opaque object associated
 * with the designated handler" that must be fed back to `removeTarget(_:)`
 * (developer.apple.com/documentation/mediaplayer/mpremotecommand/addtarget(handler:)).
 * Targets accumulate: a binding that only toggles `isEnabled` leaves every
 * handler ever registered attached, so after a few broadcasts one button press
 * runs five stale closures — the endemic "stale handler" bug this class exists
 * to prevent. Every target added here is tracked and removed on the first
 * broadcast that stops advertising its command.
 *
 * Threading: `MPRemoteCommandCenter` is a UI-adjacent singleton and its
 * handlers are delivered on the main thread; every method here must be called
 * on the main queue (`HybridRnMediaMediaSession` guarantees that).
 */
final class RemoteCommandBinding {
  /// Skip interval offered for `fastForward` / `rewind`, in seconds.
  static let skipInterval: TimeInterval = 15
  /// Rates offered to `changePlaybackRateCommand`. Negative rates are not
  /// supported by MediaPlayer, so none are listed.
  static let supportedRates: [NSNumber] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

  private let center = MPRemoteCommandCenter.shared()
  private var targets: [RemoteCommandKind: Any] = [:]
  private let actions: RemoteCommandActions

  init(actions: RemoteCommandActions) {
    self.actions = actions
  }

  deinit {
    // `deinit` may not be on the main thread, but the command center outlives
    // us either way; leaving targets attached would be the real leak.
    removeAll()
  }

  /// Make the enabled set exactly `desired`, adding and removing targets.
  func apply(_ desired: Set<RemoteCommandKind>) {
    for kind in RemoteCommandKind.allCases {
      let command = command(for: kind)
      if desired.contains(kind) {
        guard targets[kind] == nil else { continue }
        configure(kind)
        targets[kind] = command.addTarget { [weak self] event in
          self?.handle(kind, event) ?? .commandFailed
        }
        command.isEnabled = true
      } else {
        guard let token = targets.removeValue(forKey: kind) else {
          command.isEnabled = false
          continue
        }
        command.removeTarget(token)
        command.isEnabled = false
      }
    }
  }

  /// Detach everything. Called on `stopService`.
  func removeAll() {
    apply([])
  }

  // MARK: - Private

  private func command(for kind: RemoteCommandKind) -> MPRemoteCommand {
    switch kind {
    case .play: return center.playCommand
    case .pause: return center.pauseCommand
    case .togglePlayPause: return center.togglePlayPauseCommand
    case .stop: return center.stopCommand
    case .nextTrack: return center.nextTrackCommand
    case .previousTrack: return center.previousTrackCommand
    case .changePlaybackPosition: return center.changePlaybackPositionCommand
    case .changePlaybackRate: return center.changePlaybackRateCommand
    case .skipForward: return center.skipForwardCommand
    case .skipBackward: return center.skipBackwardCommand
    }
  }

  /// Per-command setup that has to happen before the command is enabled.
  private func configure(_ kind: RemoteCommandKind) {
    switch kind {
    case .changePlaybackRate:
      // Without this the rate control has nothing to offer and the system hides
      // it: "The playbackRate property is equal to a value stored in the
      // supportedPlaybackRates array."
      center.changePlaybackRateCommand.supportedPlaybackRates = Self.supportedRates
    case .skipForward:
      center.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipInterval)]
    case .skipBackward:
      center.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipInterval)]
    default:
      break
    }
  }

  private func handle(
    _ kind: RemoteCommandKind,
    _ event: MPRemoteCommandEvent
  ) -> MPRemoteCommandHandlerStatus {
    switch kind {
    case .play:
      actions.play()
    case .pause:
      actions.pause()
    case .stop:
      actions.stop()
    case .togglePlayPause:
      // The headset-button command. It carries no direction, so the broadcast
      // status is the only thing that can decide which way to go.
      if actions.isPlaying() { actions.pause() } else { actions.play() }
    case .nextTrack:
      actions.skipToNext()
    case .previousTrack:
      actions.skipToPrevious()
    case .changePlaybackPosition:
      guard let event = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      actions.seekTo(event.positionTime * 1000)
    case .changePlaybackRate:
      guard let event = event as? MPChangePlaybackRateCommandEvent else {
        return .commandFailed
      }
      actions.setRate(Double(event.playbackRate))
    case .skipForward, .skipBackward:
      // MediaPlayer has no "seek relative" handler contract, and the JS handler
      // interface deliberately has no fastForward/rewind method: relative moves
      // are expressed as an absolute seek off the projected position, exactly
      // as media3's COMMAND_SEEK_FORWARD/COMMAND_SEEK_BACK are on Android.
      let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.skipInterval
      let delta = kind == .skipForward ? interval : -interval
      let target = max(0, actions.currentPositionSeconds() + delta)
      actions.seekTo(target * 1000)
    }
    // Always `.success`: the command was accepted and dispatched to JS. Nitro
    // schedules the JS call on the JS thread and we return immediately, so
    // there is no outcome to report — the acknowledgement the user sees is the
    // app's next `setPlaybackState` broadcast.
    return .success
  }
}
