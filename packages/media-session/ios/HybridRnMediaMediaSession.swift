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

  /// Bumped on every artwork change so a slow download that lands after the
  /// user skipped cannot paint the previous track's cover.
  private var artworkGeneration = 0

  /**
   * The artwork URI the last published now-playing info was built with. Main
   * queue only; drives ``artworkGeneration``.
   *
   * Tracked on the **resolved** item rather than on the `setMediaItem` channel,
   * because since the queue merge landed the cover can change from any of the
   * three channels — a `setQueue` that re-points the current entry moves it just
   * as surely as a `setMediaItem` does.
   */
  private var publishedArtworkUri: String?

  /// Last value passed to ``warnOnce(_:)``; see it for why only one is kept.
  private var warnedMismatch: String?

  /**
   * The last artwork URI reported as unloadable. Main queue only.
   *
   * `publishNowPlayingInfo` re-requests the cover on every broadcast that names
   * it, and a failure — unlike a success — is not cached, so without this a
   * dead URL would produce one report per broadcast. The Android twin is
   * `SessionErrorReporter`'s `dedupeKey`; one URI is enough here because a
   * change of cover is what makes the previous failure old news.
   */
  private var reportedArtworkFailure: String?

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
      self.reportedArtworkFailure = nil
      self.checkBackgroundAudioMode()
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
      self.mediaItem = item
      // The artwork generation is bumped by `publishNowPlayingInfo` off the
      // *resolved* item, not here: the cover the surface shows is now the merge
      // of this channel and the queue, so this channel alone cannot say whether
      // it changed.
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
      // A full re-post, and not only for the queue index/count fields: since
      // the channel merge landed, the entry at `queueIndex` is the *base* of
      // everything the surface shows, so a queue edit can change the title, the
      // artist and the cover. Re-posting also re-projects the elapsed time
      // rather than replaying a stale one.
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

  /// Android-only, and a **platform ceiling** rather than an omission.
  ///
  /// On Android this call makes the media session advertise
  /// `DeviceInfo.PLAYBACK_TYPE_REMOTE`, which puts the platform session into
  /// remote volume handling and routes the hardware volume keys to the app —
  /// including with the screen locked. iOS has no equivalent, and not for want
  /// of looking:
  ///
  /// - There is no remote-playback mode on `MPNowPlayingInfoCenter` or
  ///   `MPRemoteCommandCenter`. The command centre's vocabulary is transport
  ///   (play/pause/seek/skip/rating/like); volume is not in it, and Apple
  ///   removed `MPRemoteCommandCenter`'s only volume-adjacent hook long ago.
  /// - `AVAudioSession.outputVolume` is **read-only**, and observing it to
  ///   "detect" a button press is the trick App Review has rejected for years —
  ///   it also cannot suppress the system HUD or stop the phone's own volume
  ///   from moving, so it would change the speaker *and* the phone.
  /// - `MPVolumeView` renders the **system** volume slider; it drives the
  ///   device's own output, not a remote one, and its private slider subview is
  ///   not API. `AVRoutePickerView` picks AirPlay routes, which is a different
  ///   mechanism (AirPlay volume is handled by the OS because the OS owns the
  ///   route — a Cast receiver is not a route).
  /// - Google's own Cast SDK cannot do it either, and says so where its
  ///   `GCKCastOptions.physicalVolumeButtonsWillControlDeviceVolume` flag is
  ///   explained (https://developers.google.com/cast/docs/ios_sender/integrate,
  ///   read 2026-08-14): "Due to changes in iOS, controlling the volume of a
  ///   Cast session using the physical volume buttons is currently not
  ///   supported for iOS 15+. We are exploring alternatives to restore this
  ///   functionality in a future release." (The 4.7.0 release note from 2021
  ///   that says the feature was "restored" is older than that sentence; the
  ///   integration guide is the current statement, and the flag is still
  ///   shipped.) The same page's answer for iOS is the software slider:
  ///   `GCKUIDeviceVolumeController`.
  ///
  /// So the honest behaviour is to accept the call and change nothing, rather
  /// than to ship a fake symmetry. The same app code runs on both platforms;
  /// it is load-bearing on Android and free here. On iOS the in-app volume
  /// control remains the way to drive a remote device's volume — which is also
  /// what Google's own iOS cast apps do.
  func setRemotePlayback(remote: NativeRemotePlayback?) throws {
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
      // Drops any artwork download still in flight, and lets the next session
      // start from a clean "nothing published yet".
      self.trackArtwork(nil)
      self.warnedMismatch = nil
      self.reportedArtworkFailure = nil
      self.nowPlayingCenter.nowPlayingInfo = nil
      promise.resolve(withResult: ())
    }
    return promise
  }

  // MARK: - Session errors

  /**
   * Tell JavaScript about something that failed with **no call waiting to be
   * rejected**. Main queue only.
   *
   * The iOS half of the channel `SessionErrors` is on Android, and it exists for
   * the same reason: an artwork download that completes long after the
   * broadcast that asked for it, and a metadata mismatch discovered while
   * rendering, have no promise to fail. Both used to be an `NSLog` at best
   * (CLAUDE.md principle 6, ARCHITECTURE §28).
   *
   * The log line goes out **before** the callback and regardless of whether
   * there is one: with the handlers gone (after `stopService`, or before
   * `initialize`) the console is still better than nothing, and it keeps the
   * device-side evidence identical to what shipped before this channel existed.
   *
   * `%@` with the whole message as the single argument: it is built by
   * interpolation and must never be read as a format string itself.
   */
  private func report(_ code: SessionErrorCode, _ message: String) {
    NSLog("%@", "[media-session] \(message)")
    handlers?.onSessionError(code, message)
  }

  /**
   * Is this app allowed to keep running to play audio at all? Main queue only,
   * once per ``initialize(config:handlers:)``.
   *
   * The honest iOS counterpart of Android's refused foreground service, and the
   * one thing on this platform that decides whether background playback can work
   * at all: without `audio` in the app's `UIBackgroundModes`, iOS suspends the
   * process as soon as it leaves the foreground — the audio stops, the lock
   * screen goes with it, and no amount of correct `MPNowPlayingInfoCenter` use
   * changes that. A library cannot merge `Info.plist` keys the way an Android
   * library merges a manifest (see this class's platform contract), so the app
   * (or this package's Expo config plugin, `withBackgroundAudio`) has to do it —
   * and until now getting it wrong was invisible from here.
   *
   * Read from the main bundle's Info.plist, which is the same dictionary the
   * system reads; there is no API that asks the OS "am I permitted to run in the
   * background for audio", and there is nothing to ask, because the key *is* the
   * permission.
   */
  private func checkBackgroundAudioMode() {
    let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String]
    guard modes?.contains("audio") != true else { return }
    report(
      .backgroundplaybackunavailable,
      "This app's Info.plist does not list \"audio\" in UIBackgroundModes, so iOS will "
        + "suspend the process as soon as it leaves the foreground: playback stops and the "
        + "lock screen controls go with it. Add UIBackgroundModes -> audio (the Expo plugin "
        + "in this package does it for you), or ignore this if the app is deliberately "
        + "foreground-only."
    )
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

  /**
   * The entry the now-playing surface is describing, with both metadata
   * channels merged onto it. `nil` when nothing has been broadcast.
   *
   * The whole rule lives in ``NowPlaying/resolve(item:queue:queueIndex:)``,
   * which is the twin of Kotlin's `Snapshot.timeline` / `enrichedWith` — the
   * queue entry at the broadcast index is the base, `setMediaItem` is overlaid
   * field by field, and on an id mismatch the queue entry wins. Computed rather
   * than stored: it is read a handful of times per broadcast (never on a timer,
   * never on a hot path) and a stored copy is one more thing three channels
   * would each have to remember to refresh.
   */
  private var nowPlaying: NowPlaying? {
    // Narrowed to an `Int` here rather than inside the resolver so the resolver
    // stays free of the bridge's `Double`. `Int(_: Double)` traps on NaN and on
    // anything outside `Int`'s range, so the conversion happens only for a value
    // that already addresses the queue; everything else — including NaN, whose
    // comparisons are all false — becomes the "no usable queue position" -1 the
    // resolver already handles.
    let raw = playbackState?.queueIndex ?? -1
    let index = raw >= 0 && raw < Double(queue.count) ? Int(raw) : -1
    return NowPlaying.resolve(item: mediaItem, queue: queue, queueIndex: index)
  }

  /**
   * A stable identity for "the item the end-of-track timer was armed against":
   * timeline index *and* id, because either alone is wrong (ids legitimately
   * repeat within a queue; the index alone moves under a queue edit that did not
   * change what is playing).
   */
  private var currentItemKey: String? {
    nowPlaying?.key
  }

  /**
   * Report a `setMediaItem`/queue disagreement once per distinct combination.
   * Main queue only.
   *
   * The iOS twin of `BroadcastPlayer.warnOnce`, and it exists for the same
   * reason: a mismatch means everything the item carries — typically the
   * duration, and with it the scrubber — is being dropped rather than merged,
   * which is invisible from the outside. Android has logged this since the merge
   * landed; iOS staying silent about the same defect would just move the blind
   * spot to the other platform.
   *
   * Only the last reported combination is remembered: mismatches are sticky in
   * practice, and a genuine flip-flop between two of them is worth seeing twice.
   */
  private func warnOnce(_ mismatch: String?) {
    guard let mismatch, mismatch != warnedMismatch else { return }
    warnedMismatch = mismatch
    // Reported as well as logged, with the wording the Kotlin twin uses
    // (`BroadcastPlayer.warnOnce`) — the same defect deserves the same sentence
    // on both platforms. The de-duplication stays here rather than in the
    // reporter: this field holds the *value* that changed, and a flip-flop
    // between two mismatches is worth hearing twice.
    report(
      .metadatamismatch,
      "setMediaItem does not describe the current queue entry "
        + "(\(mismatch)); the queue entry wins and the item's fields — including its "
        + "duration — are ignored. Broadcast the matching queueIndex, or an item whose "
        + "id matches it."
    )
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
    guard let durationMs = nowPlaying?.item.effectiveDurationMs, durationMs > 0 else {
      return nil
    }
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
   * Unmapped, and each of these is a platform ceiling rather than a TODO. The
   * command centre's full property list was read to be sure
   * (developer.apple.com/documentation/mediaplayer/mpremotecommandcenter,
   * 2026-08-16): play, pause, stop, togglePlayPause, nextTrack, previousTrack,
   * changeRepeatMode, changeShuffleMode, changePlaybackRate, seekForward,
   * seekBackward, skipForward, skipBackward, changePlaybackPosition, rating,
   * like, dislike, bookmark, enableLanguageOption, disableLanguageOption. That
   * is the entire set; it is fixed and an app cannot add to it.
   *
   * - `skipToQueueItem` — **there is no queue-jump command in that list.** The
   *   handler method still exists because Android Auto, Android's own
   *   notification queue and the app's UI all use it; it is simply unreachable
   *   from an iOS remote surface.
   * - custom actions — nothing in that list carries an app-defined identifier.
   *   `likeCommand`/`dislikeCommand`/`bookmarkCommand` are `MPFeedbackCommand`s
   *   with fixed system semantics and system-drawn heart/thumb icons, and
   *   `ratingCommand` is a star rating; re-purposing one of them as a generic
   *   "custom action" would draw the user a heart for "Add to playlist". A wrong
   *   button is worse than a missing one, so there is none.
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
      // Two commands per control, because MediaPlayer splits one Android
      // concept in half: `skipForwardCommand` is the ±N-seconds button a UI
      // draws, `seekForwardCommand` is the FF key on a Bluetooth remote or a car
      // head unit. media3 answers both from the single `COMMAND_SEEK_FORWARD`
      // this control maps to, so enabling only the first made the accessory key
      // a silent no-op on iOS. See `RemoteCommandKind.seekForward`.
      case .fastforward:
        desired.insert(.skipForward)
        desired.insert(.seekForward)
      case .rewind:
        desired.insert(.skipBackward)
        desired.insert(.seekBackward)
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
    guard let current = nowPlaying else {
      trackArtwork(nil)
      nowPlayingCenter.nowPlayingInfo = nil
      return
    }
    warnOnce(current.mismatch)
    let item = current.item
    trackArtwork(item.artworkUri)

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
    // Extended tags. All three keys are real `MPMediaItemProperty*` constants
    // (`MPMediaItemPropertyAlbumTrackNumber` and `MPMediaItemPropertyDiscNumber`
    // under MPMediaItem's "General media item property keys",
    // `MPMediaItemPropertyAlbumArtist` under "Filterable property keys";
    // developer.apple.com/documentation/mediaplayer/mpmediaitem, read
    // 2026-08-16). Apple no longer publishes a "supported subset" for
    // `nowPlayingInfo` — the property's own Discussion says only "To clear the
    // now playing info center dictionary, set it to nil" — so what the lock
    // screen actually renders is not something Apple documents. Unknown keys are
    // ignored, so sending them is free; no promise is made that they are drawn.
    if let albumArtist = item.albumArtist {
      info[MPMediaItemPropertyAlbumArtist] = albumArtist
    }
    if let trackNumber = item.trackNumber {
      info[MPMediaItemPropertyAlbumTrackNumber] = NSNumber(value: Int(trackNumber))
    }
    if let discNumber = item.discNumber {
      info[MPMediaItemPropertyDiscNumber] = NSNumber(value: Int(discNumber))
    }
    // `year`, `subtitle` and `extras` are deliberately absent, and the whole key
    // space was enumerated to be sure (MPMediaItem's two key lists plus
    // MPNowPlayingInfoCenter's "Accessing Now Playing metadata properties",
    // read 2026-08-16): there is no year key at all — `MPMediaItemPropertyReleaseDate`
    // is an `NSDate`, and a bare year is not a date — no third display line, and
    // no arbitrary-payload key. They are carried through the session and through
    // persistence so an app gets them back; they are not faked into keys that
    // mean other things.
    // `item.id` is deliberately NOT published: the only string-typed identity
    // key MediaPlayer offers is
    // `MPNowPlayingInfoPropertyExternalContentIdentifier`, which is reserved
    // for content shared with external services, and
    // `MPMediaItemPropertyPersistentID` is a `UInt64` our ids are not.

    if let duration = item.effectiveDurationMs {
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

  /**
   * Note which cover the surface is now showing, and invalidate any download
   * still in flight for a different one. Main queue only.
   *
   * Called from ``publishNowPlayingInfo()`` on the **resolved** artwork URI, so
   * a cover that changes because the queue moved is caught as surely as one that
   * changes because `setMediaItem` did. Re-publishing for the *same* URI — which
   * is exactly what ``loadArtwork(_:)``'s completion does — leaves the
   * generation alone, so a finished download never invalidates itself.
   */
  private func trackArtwork(_ uri: String?) {
    guard uri != publishedArtworkUri else { return }
    publishedArtworkUri = uri
    artworkGeneration &+= 1
  }

  /// Main queue only.
  private func loadArtwork(_ uri: String) {
    let generation = artworkGeneration
    artworkCache.load(uri) { [weak self] image, failure in
      DispatchQueue.main.async {
        guard let self, self.artworkGeneration == generation else { return }
        guard image != nil else {
          // The failure this whole channel is about: before it, a cover that
          // 404'd, timed out, or arrived as bytes `UIImage` could not decode
          // produced a bare lock screen and *silence* — the completion's
          // `guard image != nil else { return }` was the swallow.
          self.reportArtworkFailure(uri, failure)
          return
        }
        // Re-publish rather than patching `nowPlayingInfo` in place: patching
        // would leave the previously-posted `elapsed` untouched while the
        // system keeps extrapolating from it, and a full re-post re-anchors.
        self.publishNowPlayingInfo()
      }
    }
  }

  /// Main queue only. See ``reportedArtworkFailure`` for the de-duplication.
  private func reportArtworkFailure(_ uri: String, _ failure: String?) {
    guard uri != reportedArtworkFailure else { return }
    reportedArtworkFailure = uri
    report(
      .artworkfailed,
      "Could not load the artwork at \(uri): \(failure ?? "no image came back"). "
        + "The lock screen and Control Center will show this item without a cover."
    )
  }
}
