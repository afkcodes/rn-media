//
//  CarPlayLink.swift
//  RnMediaMediaSession
//
//  The seam between the media session and the CarPlay scene, which the system
//  may connect at any moment — including before the app's JavaScript has run.
//

import Foundation

/**
 * What CarPlay needs from the media session, expressed without a single
 * generated type.
 *
 * ## Why a protocol at all
 * The CarPlay scene is created by the system, not by us: it can connect before
 * `initialize` has ever been called (the user plugs the phone in and *then*
 * launches the app from the car) and it outlives `stopService`. So the scene
 * cannot own the session, and the session cannot own the scene; they find each
 * other through ``CarPlayLink``.
 *
 * The second reason is the lane split this shipped under: everything on the
 * CarPlay side of this protocol compiles with no knowledge of nitrogen's
 * output, and exactly one file — `CarPlayBridge.swift` — knows about both.
 *
 * ## Threading contract
 * `@MainActor`, and that annotation is load-bearing three times over. Every
 * CarPlay class is main-actor-isolated, so a coordinator that can call these
 * members freely must be isolated too. `HybridRnMediaMediaSession` confines all
 * of its state to the main queue, which *is* the main actor, so this is also
 * the honest description of where these may be read. And a `nonisolated async`
 * requirement would be worse than merely undocumented: Swift runs those on the
 * generic executor, so `carPlayChildren` would resume off the main queue and
 * read that confined state from the wrong thread.
 *
 * The implementor is a plain (non-isolated) class with main-actor members,
 * which is exactly what a queue-confined object is.
 */
@MainActor
protocol CarPlayBrowseSource: AnyObject {
  /**
   * Children of `parentId`, or ``BrowseRules/rootId`` for the tabs.
   *
   * `async` rather than a completion handler because the thing on the other
   * side of it is a Nitro `Promise<NativeBrowseResult>` and `await()` is how
   * that is consumed (F10). A failure of the *bridge* — a rejected promise, a
   * dead runtime — is answered as `.failure`, never thrown: a browse call with
   * no answer would leave the car showing a spinner forever.
   */
  func carPlayChildren(of parentId: String) async -> BrowseAnswer

  /// The car tapped a playable node. Acknowledge-by-broadcast, like `play()`.
  func carPlayPlay(mediaId: String)

  /// The car tapped a row of the Up Next list.
  func carPlaySkipToQueueItem(index: Int)

  /**
   * The Now Playing screen's repeat / shuffle / rate buttons were tapped.
   *
   * Three methods rather than one `setX` pair because CarPlay hands us a bare
   * "it was tapped" and expects the app to advance the value itself (see
   * ``CarPlayCycle``), whereas the lock screen delivers the new value. The
   * *next* value is computed by ``CarPlayCycle``; the implementor's job is to
   * read the current one out of the broadcast state and route the result to the
   * same `setRepeatMode`/`setShuffle`/`setRate` handler the lock screen uses.
   */
  func carPlayCycleRepeatMode()
  func carPlayToggleShuffle()
  func carPlayCyclePlaybackRate()

  /// Report something that failed with no call waiting to be rejected.
  func carPlayReport(_ code: String, _ message: String)

  /// The head unit connected or went away (I5).
  func carPlayConnectionChanged(connected: Bool)

  /// Everything the Now Playing template is configured from (I3).
  var carPlayNowPlaying: CarPlayNowPlayingState { get }
}

/**
 * The slice of the broadcast state CarPlay's Now Playing screen needs.
 *
 * A value rather than a set of accessors so it is read once, on the main queue,
 * in the frame that asked — and so the template builder can be handed something
 * it cannot accidentally hold a session reference through.
 */
struct CarPlayNowPlayingState: Equatable, Sendable {
  /// `mediaItem.id` of the entry playing now, for `CPListItem.isPlaying`.
  let currentMediaId: String?
  /// Titles/subtitles of the broadcast queue, for the Up Next list.
  let queue: [CarPlayQueueEntry]
  let canSetRepeatMode: Bool
  let canSetShuffle: Bool
  let canSetRate: Bool

  static let empty = CarPlayNowPlayingState(
    currentMediaId: nil,
    queue: [],
    canSetRepeatMode: false,
    canSetShuffle: false,
    canSetRate: false
  )
}

/// One row of the Up Next list.
struct CarPlayQueueEntry: Equatable, Sendable {
  let id: String
  let title: String
  let subtitle: String?
  let artworkUri: String?
}

/// What CarPlay reports back to JavaScript, as `SessionErrorCode` raw values.
enum CarPlayErrorCode {
  /// A root child that could not be a tab (F4). Same code as Android's.
  static let browseRootRejected = "browseRootRejected"
}

/**
 * The one place the CarPlay scene and the media session find each other.
 *
 * Deliberately **not** `@MainActor`: `HybridRnMediaMediaSession` registers from
 * the JS thread during `initialize`, and `getCarConnection()` is answered on
 * the JS thread too — both would otherwise need a hop, and a hop cannot answer
 * a synchronous getter. A lock is the cheap, obvious tool for two words of
 * state written a handful of times per app launch.
 *
 * A singleton because the thing it models is singular: iOS gives an app exactly
 * one CarPlay scene (CLAUDE.md principle 5 — singletons only where the OS is).
 *
 * The source is held **weakly**: `stopService` drops the hybrid object, and a
 * strong reference here would keep a dead session — and its handlers, and the
 * JS objects behind them — alive for the lifetime of the process.
 */
final class CarPlayLink: @unchecked Sendable {
  static let shared = CarPlayLink()

  private let lock = NSLock()
  private weak var storedSource: (any CarPlayBrowseSource)?
  private var connected = false

  private init() {}

  /// The live session, or `nil` before `initialize` and after `stopService`.
  var source: (any CarPlayBrowseSource)? {
    lock.lock()
    defer { lock.unlock() }
    return storedSource
  }

  /// Is a head unit showing our templates right now?
  var isConnected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return connected
  }

  /**
   * Publish (or, with `nil`, retract) the session. Any thread.
   *
   * Wakes the coordinator afterwards so a scene that connected first — the
   * phone was already plugged in when the app launched — stops showing its
   * placeholder and builds the real tabs.
   */
  func register(_ source: (any CarPlayBrowseSource)?) {
    lock.lock()
    storedSource = source
    lock.unlock()
    CarPlayCoordinator.post(.sourceChanged)
  }

  /// Main queue only (``CarPlayCoordinator`` owns the transitions).
  func setConnected(_ value: Bool) {
    lock.lock()
    connected = value
    lock.unlock()
  }

  /// The value `getCarConnection()` answers with, as the TS `CarConnection.kind`.
  var connectionKind: String {
    isConnected ? "carPlay" : "none"
  }
}
