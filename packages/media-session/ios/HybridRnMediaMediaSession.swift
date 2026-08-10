//
//  HybridRnMediaMediaSession.swift
//  RnMediaMediaSession
//
//  The iOS half of `@rn-media/media-session`.
//

import Foundation
import MediaPlayer
import NitroModules
import QuartzCore
import UIKit

/**
 * `MPRemoteCommandCenter` + `MPNowPlayingInfoCenter` driver.
 *
 * ## Platform contract (there is no "service" on iOS)
 * iOS has no foreground service and no equivalent of `MediaSessionService`.
 * What keeps the app — and therefore the JS runtime and this object — alive in
 * the background is the `audio` value in the consumer app's
 * `UIBackgroundModes`, plus an *actually playing* `AVAudioSession`. Declaring
 * the background mode is the app's (or its config plugin's) job, not this
 * package's: a library cannot merge Info.plist keys the way an Android library
 * merges a manifest.
 *
 * Consequences to plan for, none of which this package can fix:
 * - Playback that stops for long enough gets the process suspended. Remote
 *   commands then arrive only after the system wakes the app, or not at all.
 * - Force-quitting from the app switcher terminates everything, immediately.
 *   iOS treats that as "the user meant it"; there is no restart path.
 * - `stopService()` here only tears down our now-playing/command state. It
 *   cannot end background execution, because it never granted any.
 *
 * ## Threading contract
 * Every field below is main-queue-confined; `MPRemoteCommandCenter` targets are
 * delivered on the main thread and mutating the command center off it races
 * with the system's reads. The bridge methods are called on the JS thread, so
 * each hops with `DispatchQueue.main.async` — never `.sync`, which would block
 * JS behind the main thread and can deadlock.
 *
 * The one thing that must NOT wait for the hop is reading the clock: the
 * position anchor is converted to a monotonic origin in the caller's frame (see
 * ``PositionProjection``) before the hop, so queueing delay cannot age it.
 *
 * Nitro callbacks may be invoked from any thread — Nitro schedules the JS call
 * onto the JS thread itself (https://nitro.margelo.com/docs/types/callbacks).
 */
final class HybridRnMediaMediaSession: HybridRnMediaMediaSessionSpec {

  // MARK: - Main-queue-confined state

  private var handlers: MediaSessionHandlers?
  private var binding: RemoteCommandBinding?
  private let artworkCache = ArtworkCache()

  private var playbackState: NativePlaybackState?
  private var projection = PositionProjection.zero
  private var mediaItem: NativeMediaItem?
  private var queue: [NativeMediaItem] = []

  /// Bumped on every metadata change so a slow artwork download that lands
  /// after the user skipped cannot paint the previous track's cover.
  private var artworkGeneration = 0

  private var nowPlayingCenter: MPNowPlayingInfoCenter { .default() }

  /**
   * The native sleep timer. `lazy` rather than a stored `let` only because it
   * captures `self`; every method that touches it (`setSleepTimer`,
   * `cancelSleepTimer`, `getSleepTimerRemaining`) is called by Nitro on the JS
   * thread, so the lazy initialisation is not racing anything.
   */
  private lazy var sleepTimer = SleepTimer { [weak self] in
    self?.onSleepTimerFired()
  }

  // MARK: - Spec

  func initialize(
    config: MediaSessionConfig,
    handlers: MediaSessionHandlers
  ) throws -> Promise<Void> {
    let cacheSize = config.ios?.artworkCacheSize.map { Int($0) }
    let promise = Promise<Void>()
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        promise.resolve(withResult: ())
        return
      }
      if let cacheSize {
        self.artworkCache.setCapacity(cacheSize)
      }
      self.handlers = handlers
      self.binding = RemoteCommandBinding(actions: self.makeActions(handlers))
      // Nothing is enabled yet, on purpose: the enabled set is derived from the
      // first `setPlaybackState` broadcast. Advertising commands the app has
      // not claimed would show dead buttons on the lock screen.
      self.binding?.apply([])
      promise.resolve(withResult: ())
    }
    return promise
  }

  func setPlaybackState(state: NativePlaybackState) throws {
    // Converted HERE, in the caller's frame — see the threading note above.
    let projection = PositionProjection(
      valueMs: state.position.value,
      atEpochMs: state.position.at,
      // A non-playing status with a live rate is contradictory; trusting the
      // status keeps the lock-screen scrubber from creeping while buffering.
      rate: state.status == .playing ? state.position.rate : 0
    )
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.playbackState = state
      self.projection = projection
      self.binding?.apply(Self.desiredCommands(for: state))
      self.publishNowPlayingInfo()
    }
  }

  func setMediaItem(item: NativeMediaItem?) throws {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let changed = self.mediaItem?.artworkUri != item?.artworkUri
      self.mediaItem = item
      if changed {
        self.artworkGeneration &+= 1
      }
      self.publishNowPlayingInfo()
    }
  }

  func setQueue(items: [NativeMediaItem]) throws {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.queue = items
      // Only the queue index/count fields change; still a full re-post, which
      // re-projects the elapsed time rather than replaying a stale one.
      self.publishNowPlayingInfo()
    }
  }

  func stopService() throws -> Promise<Void> {
    // Synchronously, before the hop: `stopService` discards the handlers, and a
    // timer left armed would fire into them.
    sleepTimer.cancel()
    let promise = Promise<Void>()
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        promise.resolve(withResult: ())
        return
      }
      self.binding?.removeAll()
      self.binding = nil
      self.handlers = nil
      self.playbackState = nil
      self.mediaItem = nil
      self.queue = []
      self.projection = .zero
      self.artworkGeneration &+= 1
      self.nowPlayingCenter.nowPlayingInfo = nil
      promise.resolve(withResult: ())
    }
    return promise
  }

  // MARK: - Sleep timer

  func setSleepTimer(seconds: Double) throws {
    sleepTimer.arm(seconds: seconds)
  }

  func cancelSleepTimer() throws {
    sleepTimer.cancel()
  }

  func getSleepTimerRemaining() throws -> Double? {
    sleepTimer.remainingSeconds()
  }

  /**
   * The sleep timer elapsed. Main queue (see ``SleepTimer``).
   *
   * **Native-first**, the same contract as Android's — but reached differently,
   * because iOS has no facade `Player` to drive. There the timer pauses media3's
   * player and media3 routes that back out to the JS `pause` handler; here the
   * two halves are done explicitly and in the same order:
   *
   * 1. The now-playing state is moved to `paused` *locally*, so the lock screen,
   *    Control Center and any connected accessory stop the scrubber immediately
   *    rather than at the app's next broadcast. This is also what keeps a
   *    headset `togglePlayPause` (which reads ``isPlaying``) from being deaf to
   *    a pause the app has not confirmed yet.
   * 2. The app's `pause` handler is invoked to actually stop the audio.
   *
   * Only then is `onSleepTimer` fired. As on Android, it is a notification of
   * something already done. The app's next `setPlaybackState` supersedes the
   * local state, exactly like any other command.
   */
  private func onSleepTimerFired() {
    if let state = playbackState {
      // The struct's properties are read-only projections of a C++ struct, so
      // "paused" is expressed by rebuilding it rather than mutating it.
      playbackState = NativePlaybackState(
        status: .paused,
        position: state.position,
        bufferedPosition: state.bufferedPosition,
        controls: state.controls,
        capabilities: state.capabilities,
        customActions: state.customActions,
        compactControlIndices: state.compactControlIndices,
        queueIndex: state.queueIndex,
        errorMessage: state.errorMessage
      )
      // Freeze the projection where it had actually reached, so re-posting does
      // not rewind the scrubber (see ``PositionProjection``).
      projection = PositionProjection(
        valueSeconds: projection.projectedSeconds(),
        origin: CACurrentMediaTime(),
        rate: 0
      )
      publishNowPlayingInfo()
    }
    handlers?.pause()
    handlers?.onSleepTimer()
  }

  // MARK: - Command wiring

  private func makeActions(_ handlers: MediaSessionHandlers) -> RemoteCommandActions {
    RemoteCommandActions(
      play: handlers.play,
      pause: handlers.pause,
      stop: handlers.stop,
      skipToNext: handlers.skipToNext,
      skipToPrevious: handlers.skipToPrevious,
      seekTo: handlers.seekTo,
      setRate: handlers.setRate,
      isPlaying: { [weak self] in self?.playbackState?.status == .playing },
      currentPositionSeconds: { [weak self] in
        self?.projection.projectedSeconds() ?? 0
      }
    )
  }

  /**
   * `controls ∪ capabilities`, mapped onto MediaPlayer's commands.
   *
   * iOS has no notion of button *layout*, so the split that matters on Android
   * (which buttons, in which compact slots) collapses to a single enabled set
   * here — exactly as the spec prescribes.
   *
   * Deliberately unmapped:
   * - `skipToQueueItem` — MediaPlayer exposes no queue-jump command. The
   *   handler method still exists because Android Auto and the app's own UI use
   *   it; it is simply unreachable from iOS remote surfaces.
   * - custom actions — `MPRemoteCommandCenter` has a fixed command set. There
   *   is no iOS surface for them at all (`likeCommand`/`ratingCommand` are
   *   semantically specific and out of scope for v1).
   */
  private static func desiredCommands(
    for state: NativePlaybackState
  ) -> Set<RemoteCommandKind> {
    var desired = Set<RemoteCommandKind>()

    for control in state.controls {
      switch control {
      case .play: desired.insert(.play)
      case .pause: desired.insert(.pause)
      case .stop: desired.insert(.stop)
      case .skiptonext: desired.insert(.nextTrack)
      case .skiptoprevious: desired.insert(.previousTrack)
      case .fastforward: desired.insert(.skipForward)
      case .rewind: desired.insert(.skipBackward)
      }
    }

    for capability in state.capabilities {
      switch capability {
      case .play: desired.insert(.play)
      case .pause: desired.insert(.pause)
      case .stop: desired.insert(.stop)
      case .seek: desired.insert(.changePlaybackPosition)
      case .skiptonext: desired.insert(.nextTrack)
      case .skiptoprevious: desired.insert(.previousTrack)
      case .setrate: desired.insert(.changePlaybackRate)
      case .skiptoqueueitem: break
      }
    }

    // Wired whenever either direction is available: a wired-headset click and
    // most Bluetooth remotes send `togglePlayPause` and nothing else, so an app
    // that advertises only play+pause would otherwise be deaf to them.
    if desired.contains(.play) || desired.contains(.pause) {
      desired.insert(.togglePlayPause)
    }
    return desired
  }

  // MARK: - Now playing

  /// Main queue only.
  private func publishNowPlayingInfo() {
    guard let item = mediaItem else {
      nowPlayingCenter.nowPlayingInfo = nil
      return
    }

    var info: [String: Any] = [
      MPMediaItemPropertyTitle: item.title,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    // Assigned through `if let` rather than `info[key] = item.artist`: the
    // dictionary's value type is `Any`, so an `Optional<String>` would be
    // *boxed* rather than treated as "absent", and the lock screen would render
    // the literal string "nil".
    if let artist = item.artist { info[MPMediaItemPropertyArtist] = artist }
    if let album = item.album { info[MPMediaItemPropertyAlbumTitle] = album }
    if let genre = item.genre { info[MPMediaItemPropertyGenre] = genre }
    // `item.id` is deliberately NOT published: the only string-typed identity
    // key MediaPlayer offers is
    // `MPNowPlayingInfoPropertyExternalContentIdentifier`, which is reserved
    // for content shared with external services, and
    // `MPMediaItemPropertyPersistentID` is a `UInt64` our ids are not.

    if let duration = item.duration {
      info[MPMediaItemPropertyPlaybackDuration] = duration / 1000
    } else {
      // No duration means "we don't know", which for a remote surface is
      // indistinguishable from a live stream — and marking it live is what
      // stops iOS from drawing a scrubber it cannot honour.
      info[MPNowPlayingInfoPropertyIsLiveStream] = true
    }

    // The anchor. Re-projected on every post (never on a timer): iOS
    // extrapolates from the last elapsed/rate pair, so re-posting a stale
    // `elapsed` would rewind the scrubber. See `PositionProjection`.
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = projection.projectedSeconds()
    info[MPNowPlayingInfoPropertyPlaybackRate] = projection.rate
    info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0

    if let index = playbackState?.queueIndex, index >= 0, !queue.isEmpty {
      info[MPNowPlayingInfoPropertyPlaybackQueueIndex] = Int(index)
      info[MPNowPlayingInfoPropertyPlaybackQueueCount] = queue.count
    }

    if let uri = item.artworkUri, let cached = artworkCache.cached(uri) {
      info[MPMediaItemPropertyArtwork] = ArtworkCache.artwork(from: cached)
    }

    nowPlayingCenter.nowPlayingInfo = info

    if let uri = item.artworkUri, artworkCache.cached(uri) == nil {
      loadArtwork(uri)
    }
  }

  /// Main queue only.
  private func loadArtwork(_ uri: String) {
    let generation = artworkGeneration
    artworkCache.load(uri) { [weak self] image in
      guard image != nil else { return }
      DispatchQueue.main.async {
        guard let self, self.artworkGeneration == generation else { return }
        // Re-publish rather than patching `nowPlayingInfo` in place: patching
        // would leave the previously-posted `elapsed` untouched while the
        // system keeps extrapolating from it, and a full re-post re-anchors.
        self.publishNowPlayingInfo()
      }
    }
  }
}
