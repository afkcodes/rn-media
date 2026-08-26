//
//  CarPlayBridge.swift
//  RnMediaMediaSession
//
//  The one file that knows about both nitrogen's output and CarPlay.
//

import Foundation
import MediaPlayer
import NitroModules

/**
 * The three browse methods the Nitro spec added.
 *
 * Kept out of `HybridRnMediaMediaSession.swift` because they are the CarPlay
 * feature, not the now-playing one, and because keeping every generated-type ↔
 * CarPlay translation in a single file is what let the rest of `ios/carplay/`
 * be written and reviewed before nitrogen had run.
 */
extension HybridRnMediaMediaSession {
  /**
   * Android-only, and — unlike `setRemotePlayback` — not a platform ceiling so
   * much as a platform *absence*.
   *
   * On Android these two flags decide whether `COMMAND_CODE_LIBRARY_SEARCH`
   * stays in the browser's session commands, which is what makes Auto advertise
   * `SEARCH_SUPPORTED` and offer its search tab (F8/F9). CarPlay **audio** apps
   * have no search template at all — the template vocabulary an audio app is
   * given is list/grid/tab-bar/now-playing/alert, and none of them takes a
   * query — so there is nothing here for a capability to enable or disable, and
   * `handlers.search` is never called on this platform.
   *
   * That is a parity *note*, not a parity gap: the surface does not exist in
   * the car, so neither does the feature. Voice on iOS arrives through
   * `INPlayMediaIntent`, which is a separate Siri integration and a follow-up
   * (spec §3, "Search on CarPlay").
   */
  func setBrowseCapabilities(caps: NativeBrowseCapabilities) throws {
    // No-op by design. See above.
  }

  /// The children of `parentId` changed. Re-fetches every visible template
  /// showing it; `nil` rebuilds the whole tree, tabs included (I5).
  func invalidateBrowse(parentId: String?) throws {
    CarPlayCoordinator.post(.browseInvalidated(parentId: parentId))
  }

  /// `'carPlay'` while a head unit is showing our templates, else `'none'`.
  /// Answered synchronously on the JS thread, which is why ``CarPlayLink``
  /// holds this behind a lock rather than on the main actor.
  func getCarConnection() throws -> String {
    CarPlayLink.shared.connectionKind
  }
}

// MARK: - CarPlayBrowseSource

/**
 * How the car reaches the app.
 *
 * Every member is `@MainActor` (the protocol is), which is the same queue this
 * class confines all of its state to — so these read `handlers`,
 * `playbackState`, `queue` and `nowPlaying` directly and correctly, with no hop
 * and no copy.
 */
extension HybridRnMediaMediaSession: CarPlayBrowseSource {
  /**
   * Ask JavaScript for a node's children.
   *
   * ## The double `await`
   * `getChildren` is declared in the Nitro spec as returning
   * `Promise<NativeBrowseResult>`, and nitrogen renders a *returning* callback
   * as `Promise<Promise<NativeBrowseResult>>` (F10, and see the generated
   * `MediaSessionHandlers.swift`): the outer promise is the callback crossing
   * to the JS thread and coming back, the inner one is the `Promise` the JS
   * function itself returned. Awaiting only the outer would hand this code a
   * pending promise object and a browse list of nothing.
   *
   * ## Why nothing here throws
   * A browse call with no answer leaves the car spinning forever, so every
   * failure becomes a value:
   * - **no handlers** (before `initialize`, after `stopService`) → an empty
   *   list, the same answer Android gives a browser that arrives with no live
   *   runtime, and the same reasoning: "return an empty list for no children
   *   rather than error codes".
   * - **a rejected promise** — the app's `getChildren` threw something that was
   *   not a `BrowseError`, or the runtime died mid-call → the car's alert, with
   *   the message, because a silent empty list would be indistinguishable from
   *   "this folder is empty" (CLAUDE.md principle 6).
   */
  func carPlayChildren(of parentId: String) async -> BrowseAnswer {
    guard let handlers else { return .items([]) }
    do {
      let result = try await handlers.getChildren(parentId).await().await()
      if let error = result.error {
        return .failure(
          BrowseFailure(
            code: error.code.stringValue,
            message: error.message,
            resolutionLabel: error.resolutionLabel,
            resolutionUrl: error.resolutionUrl
          )
        )
      }
      return .items(result.items.map(BrowseNode.init(_:)))
    } catch {
      return .failure(
        BrowseFailure(
          code: "notSupported",
          message: error.localizedDescription,
          resolutionLabel: nil,
          resolutionUrl: nil
        )
      )
    }
  }

  /// Acknowledge-by-broadcast, exactly like `play()`: the app builds its queue
  /// and the next `setQueue`/`setPlaybackState` is the answer.
  func carPlayPlay(mediaId: String) {
    handlers?.playFromMediaId(mediaId)
  }

  func carPlaySkipToQueueItem(index: Int) {
    handlers?.skipToQueueItem(Double(index))
  }

  func carPlayReport(_ code: String, _ message: String) {
    // An unknown code would mean this file and the spec had drifted; log the
    // sentence rather than dropping it, which is what `report` does anyway.
    guard let parsed = SessionErrorCode(fromString: code) else {
      NSLog("%@", "[media-session] \(message)")
      return
    }
    report(parsed, message)
  }

  func carPlayConnectionChanged(connected: Bool) {
    handlers?.onCarConnectionChanged(connected ? "carPlay" : "none")
  }

  /**
   * The Now Playing slice, read in one pass off the main queue's state.
   *
   * `capabilities` is walked with a `switch` rather than `contains(_:)` for the
   * reason `desiredCommands(for:)` does: these are imported C++ enums, and an
   * exhaustive switch is what makes a capability added to the spec later a
   * compile error here instead of a silently missing button.
   */
  var carPlayNowPlaying: CarPlayNowPlayingState {
    var canSetRepeatMode = false
    var canSetShuffle = false
    var canSetRate = false
    for capability in playbackState?.capabilities ?? [] {
      switch capability {
      case .setrepeatmode: canSetRepeatMode = true
      case .setshuffle: canSetShuffle = true
      case .setrate: canSetRate = true
      case .play, .pause, .stop, .seek, .skiptonext, .skiptoprevious, .skiptoqueueitem:
        break
      }
    }

    return CarPlayNowPlayingState(
      currentMediaId: nowPlaying?.item.id,
      queue: queue.map {
        CarPlayQueueEntry(
          id: $0.id,
          title: $0.title,
          subtitle: $0.artist,
          artworkUri: $0.artworkUri
        )
      },
      canSetRepeatMode: canSetRepeatMode,
      canSetShuffle: canSetShuffle,
      canSetRate: canSetRate
    )
  }

  /// See ``CarPlayCycle`` for why CarPlay makes the app do the advancing.
  func carPlayCycleRepeatMode() {
    let current = playbackState?.repeatMode ?? .off
    handlers?.setRepeatMode(MediaRepeatMode(repeatType: CarPlayCycle.next(after: current.repeatType)))
  }

  func carPlayToggleShuffle() {
    handlers?.setShuffle(!(playbackState?.shuffleEnabled ?? false))
  }

  func carPlayCyclePlaybackRate() {
    // Read back off the command centre rather than out of the config: this is
    // the very list `RemoteCommandBinding` published for the lock screen's rate
    // control, so the car and the lock screen cycle through identical speeds by
    // construction, and there is no second copy to keep in step.
    let rates = MPRemoteCommandCenter.shared()
      .changePlaybackRateCommand
      .supportedPlaybackRates
      .map(\.doubleValue)
    let current = playbackState?.position.rate ?? 1
    handlers?.setRate(CarPlayCycle.next(after: current, in: rates))
  }
}

// MARK: - Bridge structs → plain Swift

extension BrowseNode {
  /**
   * Copy a `NativeBrowseItem` out of the bridge, in the frame it arrived in.
   *
   * The generated struct is a view onto C++ memory owned by the call that
   * produced it; a browse list outlives that call by however long the driver
   * looks at it. Every field is read exactly once, here.
   *
   * `childStyle` and `mediaType` are read and dropped: both are Android
   * content-style hints with no CarPlay equivalent (see ``BrowseNode``).
   */
  init(_ item: NativeBrowseItem) {
    self.init(
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      artworkUri: item.artworkUri,
      browsable: item.browsable,
      playable: item.playable,
      group: item.group,
      explicit: item.isExplicit,
      completion: item.completion
    )
  }
}
