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
  /**
   * `MPRemoteCommandCenter.seekForwardCommand` — an accessory's **press-and-hold
   * scan**, which is a different surface from ``skipForward``.
   *
   * `skipForwardCommand` is the ±N-seconds button a UI draws (CarPlay, the
   * lock screen); `seekForwardCommand` is what a Bluetooth remote, a car head
   * unit or a wired inline control sends for its FF/RW key. Binding only the
   * first left that key **dead on iOS while it worked on Android**, where
   * media3's `MediaSessionLegacyStub.onFastForward()` dispatches
   * `COMMAND_SEEK_FORWARD` → `Player.seekForward()` (media3 1.11.0,
   * `MediaSessionLegacyStub.java:720-735`) and lands on the app's handler as an
   * absolute seek. See ``RemoteCommandBinding/handle(_:_:)``.
   */
  case seekForward
  /** `seekBackwardCommand`. See ``seekForward``. */
  case seekBackward
  case changeRepeatMode
  case changeShuffleMode
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
  let setRepeatMode: (MediaRepeatMode) -> Void
  let setShuffle: (Bool) -> Void
  /// `true` while the broadcast status is `playing`. Drives togglePlayPause.
  let isPlaying: () -> Bool
  /// Projected position **in seconds**, for turning skip intervals into seeks.
  let currentPositionSeconds: () -> TimeInterval
}

/**
 * The configurable parts of the command centre.
 *
 * Built once from `MediaSessionConfig` and handed in, rather than read from
 * static constants the way these values used to be. The jump intervals in
 * particular are *not* an iOS preference: they are the cross-platform option
 * that exists because pinning 15 s here while Android inherited media3's 5 s /
 * 15 s defaults meant the same JS call behaved differently per platform.
 */
struct RemoteCommandConfig {
  /// `MPSkipIntervalCommand.preferredIntervals` for `skipForwardCommand`, in seconds.
  let jumpForwardSeconds: TimeInterval
  /// …and for `skipBackwardCommand`.
  let jumpBackwardSeconds: TimeInterval
  /// `MPChangePlaybackRateCommand.supportedPlaybackRates`.
  let supportedPlaybackRates: [NSNumber]

  /// The shared cross-platform default. Must equal `DEFAULT_JUMP_SECONDS` in `validate.ts`.
  static let defaultJumpSeconds: TimeInterval = 15

  /// Unchanged from the constant this replaced, so configuring nothing changes nothing.
  static let defaultPlaybackRates: [NSNumber] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

  static let `default` = RemoteCommandConfig(
    jumpForwardSeconds: defaultJumpSeconds,
    jumpBackwardSeconds: defaultJumpSeconds,
    supportedPlaybackRates: defaultPlaybackRates
  )

  /// Build from the bridge config, falling back per field.
  init(config: MediaSessionConfig) {
    // The TS layer validates and defaults both, so a non-positive value here
    // means the struct arrived some other way. A zero-length jump is a button
    // that looks broken, so it falls back rather than being honoured.
    let forward = config.jumpForwardSeconds
    let backward = config.jumpBackwardSeconds
    self.jumpForwardSeconds =
      forward.isFinite && forward > 0 ? forward : Self.defaultJumpSeconds
    self.jumpBackwardSeconds =
      backward.isFinite && backward > 0 ? backward : Self.defaultJumpSeconds

    if let rates = config.ios?.supportedPlaybackRates, !rates.isEmpty {
      self.supportedPlaybackRates = rates.map { NSNumber(value: $0) }
    } else {
      self.supportedPlaybackRates = Self.defaultPlaybackRates
    }
  }

  init(
    jumpForwardSeconds: TimeInterval,
    jumpBackwardSeconds: TimeInterval,
    supportedPlaybackRates: [NSNumber]
  ) {
    self.jumpForwardSeconds = jumpForwardSeconds
    self.jumpBackwardSeconds = jumpBackwardSeconds
    self.supportedPlaybackRates = supportedPlaybackRates
  }
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
  private let center = MPRemoteCommandCenter.shared()
  private var targets: [RemoteCommandKind: Any] = [:]
  private let actions: RemoteCommandActions
  private let config: RemoteCommandConfig

  init(actions: RemoteCommandActions, config: RemoteCommandConfig = .default) {
    self.actions = actions
    self.config = config
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
    case .seekForward: return center.seekForwardCommand
    case .seekBackward: return center.seekBackwardCommand
    case .changeRepeatMode: return center.changeRepeatModeCommand
    case .changeShuffleMode: return center.changeShuffleModeCommand
    }
  }

  /// Per-command setup that has to happen before the command is enabled.
  private func configure(_ kind: RemoteCommandKind) {
    switch kind {
    case .changePlaybackRate:
      // Without this the rate control has nothing to offer and the system hides
      // it: "The playbackRate property is equal to a value stored in the
      // supportedPlaybackRates array."
      center.changePlaybackRateCommand.supportedPlaybackRates = config.supportedPlaybackRates
    case .skipForward:
      center.skipForwardCommand.preferredIntervals =
        [NSNumber(value: config.jumpForwardSeconds)]
    case .skipBackward:
      center.skipBackwardCommand.preferredIntervals =
        [NSNumber(value: config.jumpBackwardSeconds)]
    default:
      break
    }
  }

  /**
   * Push the broadcast repeat/shuffle state onto the two toggle commands.
   *
   * Separate from ``apply(_:)`` because it is *state*, not availability: the
   * commands stay enabled while the mode changes underneath them, and the
   * system draws the control from `currentRepeatType` / `currentShuffleType`.
   * Both are read/write (`MPChangeRepeatModeCommand.currentRepeatType`,
   * `MPChangeShuffleModeCommand.currentShuffleType`; verified against the
   * iOS SDK's `MPRemoteCommand.h`, which declares both `assign`, i.e.
   * readwrite — Apple's docs group them under a "Retrieving…" heading that
   * reads as read-only and is not).
   *
   * Written unconditionally rather than only when the command is enabled: an
   * app can broadcast a repeat mode it does not offer to change, and the lock
   * screen should still show the truth.
   */
  func applyModes(repeatMode: MediaRepeatMode, shuffleEnabled: Bool) {
    center.changeRepeatModeCommand.currentRepeatType = repeatMode.repeatType
    center.changeShuffleModeCommand.currentShuffleType = shuffleEnabled ? .items : .off
  }

  /**
   * A relative move, delivered as the absolute seek the handler interface
   * speaks. Negative jumps backwards; the result is clamped at the start of the
   * track, because MediaPlayer will happily hand us a negative position and no
   * player wants one.
   */
  private func jump(by seconds: TimeInterval) {
    let target = max(0, actions.currentPositionSeconds() + seconds)
    actions.seekTo(target * 1000)
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
      //
      // The event's own interval wins when the system supplies one — it is the
      // value the user's control was drawn with — and the configured interval is
      // the fallback for the direction being asked for. Falling back to a single
      // shared constant, as this used to, would silently use the forward
      // interval for a backward skip once the two could differ.
      let fallback = kind == .skipForward
        ? config.jumpForwardSeconds
        : config.jumpBackwardSeconds
      let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? fallback
      jump(by: kind == .skipForward ? interval : -interval)

    case .seekForward, .seekBackward:
      // The accessory FF/RW key (AVRCP, a car head unit, an inline remote), which
      // MediaPlayer models as a *scan*: `MPSeekCommandEvent.type` is
      // `.beginSeeking` on press and `.endSeeking` on release
      // (developer.apple.com/documentation/mediaplayer/mpseekcommandeventtype).
      //
      // Android answers the same key with **one discrete jump per press** —
      // `MediaSessionLegacyStub.onFastForward()` → `Player.seekForward()`, which
      // resolves the seek-forward increment and arrives at the app as a single
      // absolute seek. So only `.beginSeeking` acts, and it moves by the same
      // configured interval the skip buttons use, which makes one press mean the
      // same thing on both platforms. A continuous scan has no twin on Android
      // and no handler method here to express it, so inventing one would create
      // the asymmetry rather than remove it.
      //
      // `.endSeeking` is accepted and ignored: returning `.commandFailed` for
      // the release half of a press the system already honoured would tell the
      // accessory the command failed.
      guard let seek = event as? MPSeekCommandEvent else { return .commandFailed }
      guard seek.type == .beginSeeking else { return .success }
      jump(
        by: kind == .seekForward
          ? config.jumpForwardSeconds
          : -config.jumpBackwardSeconds
      )
    case .changeRepeatMode:
      guard let event = event as? MPChangeRepeatModeCommandEvent else {
        return .commandFailed
      }
      // A request, not a fact: the mode changes when the app changes it and
      // broadcasts the new state, exactly like play/pause. `currentRepeatType`
      // is therefore NOT written here — writing it would show the user a state
      // the app has not agreed to.
      actions.setRepeatMode(MediaRepeatMode(repeatType: event.repeatType))
    case .changeShuffleMode:
      guard let event = event as? MPChangeShuffleModeCommandEvent else {
        return .commandFailed
      }
      // `MPShuffleType` has three members — `.off`, `.items`, `.collections` —
      // and this package's model is a boolean, matching media3's
      // `shuffleModeEnabled`. `.collections` (shuffle albums, keep tracks in
      // order) has no cross-platform twin, so it is read as "on" rather than
      // being dropped: the user asked for shuffle and gets shuffle.
      actions.setShuffle(event.shuffleType != .off)
    }
    // Always `.success`: the command was accepted and dispatched to JS. Nitro
    // schedules the JS call on the JS thread and we return immediately, so
    // there is no outcome to report — the acknowledgement the user sees is the
    // app's next `setPlaybackState` broadcast.
    return .success
  }
}

/**
 * The two repeat vocabularies, which happen to line up member for member.
 *
 * `MPRepeatType` is `.off` / `.one` / `.all` (`MPRemoteControlTypes.h`,
 * `NS_ENUM(NSInteger, …)` with implicit 0/1/2) and so is ours — but the mapping
 * is written out rather than done by raw value, for the same reason the Kotlin
 * side does not use ordinals: a coincidence of numbering is not a contract.
 */
extension MediaRepeatMode {
  var repeatType: MPRepeatType {
    switch self {
    case .off: return .off
    case .one: return .one
    case .all: return .all
    }
  }

  init(repeatType: MPRepeatType) {
    switch repeatType {
    case .one: self = .one
    case .all: self = .all
    // `.off` is folded into the default rather than listed. `MPRepeatType` is an
    // imported Obj-C `NS_ENUM` and Swift's exhaustiveness rules for those have
    // moved more than once; a `default` that is reachable for a case Swift knows
    // about cannot draw either "add @unknown default" or "will never be
    // executed", whichever way the compiler is feeling. It also happens to be
    // the right behaviour: a value Apple adds later becomes `off`, a mode the
    // app can render, rather than a dead control.
    default: self = .off
    }
  }
}
