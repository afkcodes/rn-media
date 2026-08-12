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
    // Read off the bridge struct here, in the caller's frame: the struct is a
    // view onto C++ memory owned by the call, and reading it after the hop is
    // not something the ownership contract promises.
    let commandConfig = RemoteCommandConfig(config: config)
    let promise = Promise<Void>()
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        promise.resolve(withResult: ())
        return
      }
      if let cacheSize {
        self.artworkCache.setCapacity(cacheSize)
      }
      // Force the lazy timer into existence here, on the main queue, while the
      // `initialize` promise is still unresolved. Its `lazy` is now reachable
      // from two threads (the JS thread for `setSleepTimer`, the main queue for
      // the end-of-track retargeting), and the TS layer's `assertReady` means
      // no public timer call can arrive before this line has run — which turns
      // "the lazy init is not racing anything" from a hope into an ordering.
      _ = self.sleepTimer
      self.handlers = handlers
      self.binding = RemoteCommandBinding(
        actions: self.makeActions(handlers),
        config: commandConfig
      )
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
      self.binding?.applyModes(
        repeatMode: state.repeatMode,
        shuffleEnabled: state.shuffleEnabled
      )
      self.publishNowPlayingInfo()
      self.retargetTrackEndTimer()
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
      // This channel is where a duration usually arrives and where a track
      // change usually shows up first — both move an end-of-track deadline.
      self.retargetTrackEndTimer()
    }
  }

  func setQueue(items: [NativeMediaItem]) throws {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.queue = items
      // Only the queue index/count fields change; still a full re-post, which
      // re-projects the elapsed time rather than replaying a stale one.
      self.publishNowPlayingInfo()
      self.retargetTrackEndTimer()
    }
  }

  /// Android-only, and deliberately not emulated.
  ///
  /// The mirror exists so a *service* created after process death can rebuild a
  /// session with no JavaScript in the process. iOS has no service and nothing
  /// that can restart a terminated app for playback: a force-quit ends
  /// playback, full stop, and `MPNowPlayingInfoCenter` belongs to a process
  /// that has to already be running. Writing the snapshot here would produce a
  /// file nothing on this platform could ever read.
  ///
  /// The app's own `withPersistence` storage still works on iOS exactly as it
  /// does on Android — that is the copy the *next launch* restores from.
  func setResumptionSnapshot(snapshot: String?) throws {
    // No-op by design. See above.
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
      self.clearTrackEndLatch()
      self.artworkGeneration &+= 1
      self.nowPlayingCenter.nowPlayingInfo = nil
      promise.resolve(withResult: ())
    }
    return promise
  }

  // MARK: - Sleep timer

  func setSleepTimer(seconds: Double) throws {
    sleepTimer.arm(seconds: seconds)
    // A countdown is not an end-of-track timer, so the latch goes with it —
    // hopped rather than cleared here, because the latch is main-queue state and
    // hopping is what keeps arm-then-cancel and cancel-then-arm both ordered
    // against the broadcast blocks already queued behind them.
    DispatchQueue.main.async { [weak self] in self?.clearTrackEndLatch() }
  }

  /**
   * Arm the end-of-current-track timer.
   *
   * Two steps, both needed: the timer is marked armed **synchronously** (so a
   * `getSleepTimer()` on the very next line reports it, and so a broadcast
   * racing in is not ignored as "not armed"), and the deadline is computed on
   * the main queue, where the broadcast state lives.
   */
  func setSleepTimerToTrackEnd() throws {
    sleepTimer.armAtTrackEnd()
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      // `nil` here means "armed, nothing latched yet" — arming over silence
      // latches onto the first item to appear rather than firing because the
      // item changed from nothing to something. See ``TrackEndAction/next``.
      self.trackEndItemKey = self.currentItemKey
      self.sleepTimer.scheduleTrackEnd(delaySeconds: self.trackEndDelaySeconds())
    }
  }

  func cancelSleepTimer() throws {
    sleepTimer.cancel()
    DispatchQueue.main.async { [weak self] in self?.clearTrackEndLatch() }
  }

  func getSleepTimerRemaining() throws -> Double? {
    sleepTimer.remainingSeconds()
  }

  func getSleepTimer() throws -> NativeSleepTimerState? {
    sleepTimer.state()
  }

  // MARK: - End-of-track sleep timer

  /**
   * Which item the end-of-track timer is waiting on, as ``currentItemKey``, or
   * `nil` for "not latched / not an end-of-track timer". Main queue only.
   *
   * **The latch is cleared everywhere the timer stops being an end-of-track
   * timer** — when it fires (``onSleepTimerFired()``), when it is cancelled,
   * when a countdown replaces it, and in ``stopService()``. A latch that
   * outlives its timer is not inert: the next `setSleepTimerToTrackEnd` marks
   * the mode armed *synchronously* on the JS thread while the re-latch is only
   * hopped to main, so a broadcast block already queued there can run in
   * between, read a stale key, decide "the item changed" and pause playback at
   * the instant of arming. The synchronous arm is deliberate — it closes the
   * opposite race, where a broadcast would be ignored as "not armed" — so the
   * fix belongs on this side.
   *
   * One benign case remains, benign by construction: re-arming while an
   * end-of-track timer is *still* armed keeps the previous latch for the gap
   * between the sync arm and the hopped re-latch. That latch is necessarily
   * current — had the item changed while the old timer was armed,
   * ``retargetTrackEndTimer()`` would already have fired it and cleared it.
   */
  private var trackEndItemKey: String?

  /// Main queue only.
  private func clearTrackEndLatch() {
    trackEndItemKey = nil
  }

  /// The queue entry at the broadcast index, if the index addresses one.
  private var currentQueueEntry: NativeMediaItem? {
    guard let index = playbackState?.queueIndex, index >= 0, Int(index) < queue.count else {
      return nil
    }
    return queue[Int(index)]
  }

  /**
   * The entry the now-playing surface is currently describing.
   *
   * `setMediaItem` is the more specific statement (the same channel-priority
   * rule Android's `Snapshot.timeline` applies), so it wins; the queue entry at
   * the broadcast index is the fallback for the window before it arrives.
   */
  private var currentItem: NativeMediaItem? {
    mediaItem ?? currentQueueEntry
  }

  /**
   * The duration the timer should count down to, in **milliseconds**, or `nil`
   * when there is none to count to.
   *
   * Merged rather than read off one channel, for the reason
   * `Snapshot.enrichedWith` exists: apps rarely know a duration up front and
   * send it through `setMediaItem` once the track is prepared — but the reverse
   * also happens, a queue built with durations and a `setMediaItem` sent without
   * one. Taking either channel alone loses half of those cases. The queue entry
   * only counts as describing the same track when the ids agree, exactly as on
   * Android; the difference from Android is which side wins on a *mismatch*, and
   * here it is `setMediaItem`, because that is also what iOS is showing on the
   * lock screen.
   *
   * `isLive` (merged the same way) drops the duration entirely — the iOS twin of
   * `NativeMediaItem.effectiveDurationMs`.
   */
  private var currentEffectiveDurationMs: Double? {
    let entry = currentQueueEntry
    guard let item = mediaItem else {
      // Nothing on channel 2 yet: the queue entry is all there is.
      if entry?.isLive == true { return nil }
      return entry?.duration
    }
    // The queue entry fills gaps only when it describes the same track.
    let fallback = entry?.id == item.id ? entry : nil
    if (item.isLive ?? fallback?.isLive) == true { return nil }
    return item.duration ?? fallback?.duration
  }

  /**
   * A stable identity for "the item the end-of-track timer was armed against".
   *
   * Index *and* id, because either alone is wrong: ids legitimately repeat
   * within a queue, and the index alone changes under a queue edit that did not
   * change what is playing.
   */
  private var currentItemKey: String? {
    guard let item = currentItem else { return nil }
    var index = -1
    if let queueIndex = playbackState?.queueIndex { index = Int(queueIndex) }
    return "\(index):\(item.id)"
  }

  /**
   * Seconds until the current item ends, or `nil` when that is not computable.
   *
   * The iOS twin of `Snapshot.trackEndDelayMs`, and deliberately the same three
   * `nil` cases — no duration, explicitly live, or not advancing — each of which
   * means "armed, deadline unknown" rather than "fire now".
   */
  private func trackEndDelaySeconds() -> Double? {
    guard projection.rate > 0 else { return nil }
    guard let durationMs = currentEffectiveDurationMs, durationMs > 0 else { return nil }
    let remaining = durationMs / 1000 - projection.projectedSeconds()
    // Divided by the rate: at 2x a minute of audio arrives in thirty seconds,
    // and a timer that ignores that fires a minute late.
    return max(0, remaining / projection.rate)
  }

  /**
   * Re-aim the end-of-track timer at whatever the broadcast just changed. Main
   * queue only; called from every channel.
   *
   * The whole update mechanism, and deliberately the *existing* one: broadcasts
   * are discontinuity-only, so a seek, a pause, a rate change, a late-arriving
   * duration and a track change are exactly the events that move an
   * end-of-track deadline. There is nothing else to subscribe to and no timer.
   */
  private func retargetTrackEndTimer() {
    guard sleepTimer.mode() == .trackend else { return }

    switch TrackEndAction.next(latched: trackEndItemKey, current: currentItemKey) {
    case .fire:
      // Firing here rather than at a computed deadline is what makes the
      // feature work at all on a live stream or an unknown duration.
      sleepTimer.cancel()
      onSleepTimerFired()
    case .wait(let latchTo):
      if let latchTo { trackEndItemKey = latchTo }
      sleepTimer.scheduleTrackEnd(delaySeconds: trackEndDelaySeconds())
    }
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
    // First, and before anything that can produce a broadcast: the pause below
    // routes through the app and comes back as a `setPlaybackState`, and every
    // later arm reads this field. A fired timer that leaves its latch behind is
    // the defect ``trackEndItemKey`` documents.
    clearTrackEndLatch()

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
        errorMessage: state.errorMessage,
        repeatMode: state.repeatMode,
        shuffleEnabled: state.shuffleEnabled
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
      setRepeatMode: handlers.setRepeatMode,
      setShuffle: handlers.setShuffle,
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
      // iOS has no notion of button *layout*, so a control and its capability
      // are the same statement here — which is why `controls` and
      // `capabilities` are unioned. On Android they differ: the control is what
      // puts the button in the notification.
      case .repeatmode: desired.insert(.changeRepeatMode)
      case .shuffle: desired.insert(.changeShuffleMode)
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
      case .setrepeatmode: desired.insert(.changeRepeatMode)
      case .setshuffle: desired.insert(.changeShuffleMode)
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
    // Extended tags. `AlbumTrackNumber` and `DiscNumber` are both on
    // `MPNowPlayingInfoCenter`'s documented list of supported `MPMediaItem`
    // keys; `AlbumArtist` is NOT, and is sent anyway because the key is real,
    // unknown keys are ignored, and some surfaces do read it — no promise is
    // made that the lock screen shows it.
    if let albumArtist = item.albumArtist {
      info[MPMediaItemPropertyAlbumArtist] = albumArtist
    }
    if let trackNumber = item.trackNumber {
      info[MPMediaItemPropertyAlbumTrackNumber] = NSNumber(value: Int(trackNumber))
    }
    if let discNumber = item.discNumber {
      info[MPMediaItemPropertyDiscNumber] = NSNumber(value: Int(discNumber))
    }
    // `year`, `subtitle` and `extras` are deliberately absent: MediaPlayer has
    // no year key (`MPMediaItemPropertyReleaseDate` is an `NSDate` and is not on
    // the supported list either), no third display line, and no arbitrary-payload
    // key. They are carried through the session and through persistence so an
    // app gets them back; they are not faked into keys that mean other things.
    // `item.id` is deliberately NOT published: the only string-typed identity
    // key MediaPlayer offers is
    // `MPNowPlayingInfoPropertyExternalContentIdentifier`, which is reserved
    // for content shared with external services, and
    // `MPMediaItemPropertyPersistentID` is a `UInt64` our ids are not.

    if let duration = item.duration, item.isLive != true {
      info[MPMediaItemPropertyPlaybackDuration] = duration / 1000
    } else {
      // Two ways to get here and they now say different things. `isLive == true`
      // is the app stating it explicitly, and it wins even when a duration was
      // also sent. No duration at all means "we don't know", which for a remote
      // surface is indistinguishable from live — and marking it live is what
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
