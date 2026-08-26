//
//  CarPlayNowPlaying.swift
//  RnMediaMediaSession
//
//  The car's Now Playing screen: which extra buttons it gets, what a tap on one
//  means, and the Up Next list behind them.
//

import CarPlay
import Foundation
import MediaPlayer

/**
 * The three optional buttons `CPNowPlayingTemplate` can carry, named by the
 * broadcast capability that earns each one rather than by Apple's class.
 *
 * A separate vocabulary because the mapping is the decision worth testing: the
 * car's Now Playing screen already draws play/pause/skip/scrubber from
 * `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`, which are already ours
 * (I3 — there is nothing new to feed it), so the *only* thing this package
 * chooses is which of these three appear.
 */
enum CarPlayNowPlayingButtonKind: Equatable, Sendable {
  case repeatMode
  case shuffle
  case playbackRate
}

extension CarPlayNowPlayingButtonKind {
  /**
   * The buttons to show for a broadcast state. Pure; the whole of I3's rule.
   *
   * Order is fixed rather than derived from a set, because it is a layout:
   * repeat and shuffle are the pair users reach for and they sit together, with
   * the rate button — which most apps never enable — last. A `Set` would render
   * in whatever order hashing produced and would move the buttons under the
   * driver's finger between tracks.
   *
   * Capability, not control: iOS has no notion of button *layout*, so the
   * distinction that matters on Android collapses here exactly as it does in
   * `HybridRnMediaMediaSession.desiredCommands(for:)`. A capability the app has
   * not claimed produces no button, because a button routing to a
   * `setRepeatMode` the app ignores is a dead control in a moving car.
   */
  static func buttons(for state: CarPlayNowPlayingState) -> [CarPlayNowPlayingButtonKind] {
    var kinds: [CarPlayNowPlayingButtonKind] = []
    if state.canSetRepeatMode { kinds.append(.repeatMode) }
    if state.canSetShuffle { kinds.append(.shuffle) }
    if state.canSetRate { kinds.append(.playbackRate) }
    return kinds
  }

  /**
   * Is the Up Next button worth showing?
   *
   * More than one entry, because a "queue" of exactly the track that is playing
   * is not a queue — the button would open a list containing only the thing
   * already on screen. This is the iOS reading of I3's `queue.length > 1`.
   */
  static func showsUpNext(for state: CarPlayNowPlayingState) -> Bool {
    state.queue.count > 1
  }
}

/**
 * What a tap on one of the three buttons changes the value to.
 *
 * These are the only pieces of *behaviour* CarPlay adds that the lock screen
 * does not already have, and the reason is structural: `MPRemoteCommandCenter`
 * hands the lock screen's repeat control a `currentRepeatType` and lets the
 * system compute the next one, while `CPNowPlayingRepeatButton` gives us a bare
 * handler and expects the app to cycle ("invoke your existing functionality for
 * cycling through repeat modes",
 * developer.apple.com/documentation/carplay/cpnowplayingrepeatbutton, read
 * 2026-08-26). So the cycle lives here — pure, and expressed in MediaPlayer's
 * own vocabulary so it needs nothing generated to be read or tested.
 *
 * The result is *requested*, never assumed: the caller routes it to the app's
 * `setRepeatMode`/`setShuffle`/`setRate` handler and waits for the next
 * broadcast to redraw, exactly as every other remote command does
 * (acknowledge-by-broadcast). A button that flipped itself and then disagreed
 * with the app would be worse than one that waits a frame.
 */
enum CarPlayCycle {
  /// `off → all → one → off`, matching the order the lock-screen control
  /// advances in and media3's `REPEAT_MODE_OFF/ALL/ONE`.
  static func next(after current: MPRepeatType) -> MPRepeatType {
    switch current {
    case .off: return .all
    case .all: return .one
    case .one: return .off
    @unknown default: return .off
    }
  }

  /**
   * The next rate in `rates`, wrapping around.
   *
   * `rates` is the app's own `ios.supportedPlaybackRates` (or this package's
   * default ladder) — the same list `MPChangePlaybackRateCommand` is given, so
   * the car and the lock screen offer the same speeds.
   *
   * The current rate is matched with a tolerance rather than by equality: it
   * arrives as a `double` that has been through JSON and a C++ struct, and
   * `1.25` is not necessarily `1.25`. An unrecognised rate (or an empty ladder)
   * starts the cycle at the beginning rather than sticking.
   */
  static func next(after current: Double, in rates: [Double]) -> Double {
    guard let first = rates.first else { return current }
    guard let index = rates.firstIndex(where: { abs($0 - current) < 0.001 }) else {
      return first
    }
    return rates[(index + 1) % rates.count]
  }
}

/**
 * Builders for the Now Playing template's buttons.
 *
 * Split from the pure rules above so those stay testable without CarPlay and
 * these stay a one-line translation each. Every handler routes back through
 * ``CarPlayBrowseSource``, i.e. through the same app handler the lock screen
 * reaches — the app cannot tell a car's repeat tap from a lock screen's, which
 * is the entire point of the media-session layer.
 */
@MainActor
enum CarPlayNowPlayingButtons {
  static func make(
    _ kind: CarPlayNowPlayingButtonKind,
    source: @escaping () -> (any CarPlayBrowseSource)?
  ) -> CPNowPlayingButton {
    switch kind {
    case .repeatMode:
      return CPNowPlayingRepeatButton { _ in source()?.carPlayCycleRepeatMode() }
    case .shuffle:
      return CPNowPlayingShuffleButton { _ in source()?.carPlayToggleShuffle() }
    case .playbackRate:
      return CPNowPlayingPlaybackRateButton { _ in source()?.carPlayCyclePlaybackRate() }
    }
  }
}
