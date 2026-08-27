//
//  HybridRnMediaAudioSession.swift
//  RnMediaAudioSession
//
//  The iOS half of `@timbre/audio-session`.
//

// `AVAudioSession` lives in AVFAudio, which AVFoundation re-exports. Importing
// the umbrella keeps us on the framework the podspec links (`s.frameworks`).
import AVFoundation
import Foundation
import NitroModules

/**
 * `AVAudioSession` arbiter.
 *
 * Threading contract
 * ------------------
 * The interruption and route-change observers are registered on a dedicated
 * serial `OperationQueue`, so notification handling never lands on the main
 * thread and never blocks it. Listener registries are guarded by `lock`
 * because `add*Listener`/`remove*Listener` arrive on the JS thread while
 * notifications arrive on that queue.
 *
 * Nitro callbacks may be invoked from any thread — Nitro hops to the JS thread
 * itself (https://nitro.margelo.com/docs/types/callbacks), so no dispatch of
 * our own is needed (or wanted) here.
 */
final class HybridRnMediaAudioSession: HybridRnMediaAudioSessionSpec {
  private let session = AVAudioSession.sharedInstance()

  private let lock = NSLock()
  private var nextListenerId: Double = 1
  private var interruptionListeners: [Double: (NativeInterruptionEvent) -> Void] = [:]
  private var becomingNoisyListeners: [Double: () -> Void] = [:]
  private var routeChangeListeners: [Double: (NativeRouteChangeEvent) -> Void] = [:]

  /// Serial queue the notification centre delivers on. Not the main queue.
  private let notificationQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "com.rnmedia.audio-session.notifications"
    queue.maxConcurrentOperationCount = 1
    return queue
  }()

  private var observers: [NSObjectProtocol] = []

  /// The last iOS half of `configure()`, replayed after a media-services reset
  /// (which destroys the session's category/mode/options). `nil` until the app
  /// configures an iOS half at least once. Guarded by `lock`.
  private var lastIosConfig: IosAudioSessionConfig?

  /// `setCategory`/`setActive` can block for tens of milliseconds; never run
  /// them on the calling (JS) thread.
  private let workQueue = DispatchQueue(label: "com.rnmedia.audio-session.work")

  deinit {
    removeObservers()
  }

  // MARK: - Spec

  func configure(config: AudioSessionConfig) throws -> Promise<Void> {
    guard let ios = config.ios else {
      // Android-only config: nothing to apply, but still make sure we are
      // listening so `configure({ android: ... })` behaves the same on both
      // platforms.
      installObservers()
      return Promise.resolved(withResult: ())
    }

    withLock { lastIosConfig = ios }

    let promise = Promise<Void>()
    workQueue.async { [weak self] in
      guard let self else { return promise.resolve(withResult: ()) }
      do {
        try self.applyCategory(ios)
        self.installObservers()
        promise.resolve(withResult: ())
      } catch {
        promise.reject(withError: error)
      }
    }
    return promise
  }

  func activate() throws -> Promise<Bool> {
    // Not only in `configure()`: an app that adds listeners and calls
    // `activate()` without ever configuring a category must still be told about
    // interruptions and route changes, because that is exactly what it gets on
    // Android (where `activate()` is what installs the focus listener and the
    // becoming-noisy receiver). Installing here is idempotent.
    installObservers()

    let promise = Promise<Bool>()
    workQueue.async { [weak self] in
      guard let self else { return promise.resolve(withResult: false) }
      do {
        try self.session.setActive(true)
        promise.resolve(withResult: true)
      } catch let error as NSError where Self.isActivationRefusal(error) {
        // The OS refused. That is Android's `AUDIOFOCUS_REQUEST_FAILED`, not a
        // programming error — report it as "not granted". Everything else is a
        // real failure and is surfaced as a rejection.
        promise.resolve(withResult: false)
      } catch {
        promise.reject(withError: error)
      }
    }
    return promise
  }

  /// The `AVAudioSessionErrorCode`s that mean "the system declined to give you
  /// the session", as opposed to "you called this wrong".
  ///
  /// Android collapses every non-`AUDIOFOCUS_REQUEST_GRANTED` result of
  /// `requestAudioFocus` into `activate() -> false`; this is the iOS half of
  /// that same contract. Each row is quoted from the SDK's own documentation
  /// (`CoreAudioTypes.framework/Headers/AudioSessionTypes.h`, `AVAudioSessionErrorCode`):
  ///
  /// - `cannotStartPlaying` (`'!pla'`) — "The app is not allowed to start
  ///   recording and/or playing, usually because of a lack of audio key in its
  ///   `Info.plist`. This could also happen if the app has this key but uses a
  ///   category that can't record and/or play in the background".
  /// - `cannotInterruptOthers` (`'!int'`) — "The app's audio session is
  ///   non-mixable and trying to go active while in the background. This is
  ///   allowed only when the app is the NowPlaying app." **The common one**: a
  ///   backgrounded app that is not Now Playing. Before this list existed it
  ///   rejected the promise on iOS while Android answered `false`.
  /// - `insufficientPriority` (`'!pri'`) — "The app was not allowed to set the
  ///   audio category because another app (Phone, etc.) is controlling it."
  /// - `siriIsRecording` (`'siri'`) — "The app tried to do something with the
  ///   audio session that is not allowed while Siri is recording."
  ///
  /// Everything else (`badParam`, `incompatibleCategory`, `missingEntitlement`,
  /// `mediaServicesFailed`, `expiredSession`, …) stays a rejection: those are
  /// statements about the call or about a broken process, not a contested
  /// resource, and swallowing them into `false` would hide a bug.
  private static func isActivationRefusal(_ error: NSError) -> Bool {
    guard error.domain == NSOSStatusErrorDomain else { return false }
    let refusals: [AVAudioSession.ErrorCode] = [
      .cannotStartPlaying,
      .cannotInterruptOthers,
      .insufficientPriority,
      .siriIsRecording,
    ]
    return refusals.contains { error.code == Int($0.rawValue) }
  }

  /// Caller must be on `workQueue`.
  private func applyCategory(_ ios: IosAudioSessionConfig) throws {
    let category = Self.avCategory(ios.category)
    let mode = Self.avMode(ios.mode)
    let options = Self.avOptions(ios.categoryOptions)
    if let policy = ios.routeSharingPolicy.map(Self.avRouteSharingPolicy) {
      try session.setCategory(category, mode: mode, policy: policy, options: options)
    } else {
      try session.setCategory(category, mode: mode, options: options)
    }
  }

  func deactivate() throws -> Promise<Void> {
    let promise = Promise<Void>()
    workQueue.async { [weak self] in
      guard let self else { return promise.resolve(withResult: ()) }
      do {
        // `notifyOthersOnDeactivation` is what lets the app we interrupted
        // resume; Apple asks for it whenever a session is torn down.
        try self.session.setActive(false, options: .notifyOthersOnDeactivation)
        promise.resolve(withResult: ())
      } catch {
        promise.reject(withError: error)
      }
    }
    return promise
  }

  func addInterruptionListener(
    listener: @escaping (_ event: NativeInterruptionEvent) -> Void
  ) throws -> Double {
    // Observers are derived from interest, not from `configure()`. A listener
    // added before the app ever configures a category used to be a silent
    // no-op — the notification observers only existed once `configure()` ran.
    installObservers()
    return withLock {
      let id = takeListenerId()
      interruptionListeners[id] = listener
      return id
    }
  }

  func removeInterruptionListener(listenerId: Double) throws {
    withLock { _ = interruptionListeners.removeValue(forKey: listenerId) }
  }

  func addBecomingNoisyListener(listener: @escaping () -> Void) throws -> Double {
    installObservers()
    return withLock {
      let id = takeListenerId()
      becomingNoisyListeners[id] = listener
      return id
    }
  }

  func removeBecomingNoisyListener(listenerId: Double) throws {
    withLock { _ = becomingNoisyListeners.removeValue(forKey: listenerId) }
  }

  func addRouteChangeListener(
    listener: @escaping (_ event: NativeRouteChangeEvent) -> Void
  ) throws -> Double {
    installObservers()
    return withLock {
      let id = takeListenerId()
      routeChangeListeners[id] = listener
      return id
    }
  }

  func removeRouteChangeListener(listenerId: Double) throws {
    withLock { _ = routeChangeListeners.removeValue(forKey: listenerId) }
  }

  // MARK: - Observers

  private func installObservers() {
    lock.lock()
    let alreadyInstalled = !observers.isEmpty
    lock.unlock()
    if alreadyInstalled { return }

    let center = NotificationCenter.default
    let interruption = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: session,
      queue: notificationQueue
    ) { [weak self] notification in
      self?.handleInterruption(notification)
    }
    let routeChange = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: session,
      queue: notificationQueue
    ) { [weak self] notification in
      self?.handleRouteChange(notification)
    }
    // `object: nil` on purpose for the two media-services notifications: unlike
    // the interruption/route ones, Apple's own sample code observes these
    // without an object, and a session that has just been destroyed and rebuilt
    // is precisely the case where filtering on the old object could drop the
    // notification. There is exactly one `AVAudioSession` per process, so a nil
    // object filter cannot pick up anyone else's.
    let servicesLost = center.addObserver(
      forName: AVAudioSession.mediaServicesWereLostNotification,
      object: nil,
      queue: notificationQueue
    ) { [weak self] _ in
      self?.handleMediaServicesLost()
    }
    let servicesReset = center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: nil,
      queue: notificationQueue
    ) { [weak self] _ in
      self?.handleMediaServicesReset()
    }

    lock.lock()
    observers = [interruption, routeChange, servicesLost, servicesReset]
    lock.unlock()
  }

  private func removeObservers() {
    lock.lock()
    let current = observers
    observers = []
    lock.unlock()
    for observer in current {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  private func handleInterruption(_ notification: Notification) {
    guard
      let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      // NOTE: `AVAudioSession.InterruptionType` is deprecated as of iOS 27 in
      // favour of `didBecomeInactiveNotification` /
      // `resumptionRecommendationNotification`. It still works, and it is the
      // only path available below iOS 27 (our deployment target is 15.1).
      // Revisit when the floor moves.
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }

    switch type {
    case .began:
      // AVAudioSession never asks us to duck — an interruption always means
      // "stop". `permanent` is Android-only; iOS may always send `.ended`.
      emitInterruption(
        NativeInterruptionEvent(
          begin: true,
          type: .pause,
          shouldResume: false,
          permanent: false
        )
      )
    case .ended:
      // NOTE: `.shouldResume` means "the system permits resuming" — never
      // "you were playing". An *active* AVAudioSession receives the full
      // began/ended cycle even while the app's player sits user-paused, so
      // resuming on this flag alone restarts audio the user explicitly
      // stopped. This layer cannot know what the player was doing; the
      // was-it-playing latch lives in `wireAudioSession` (see
      // AudioSessionPlayerLike.isPlaying), same as on Android. (#45)
      let optionsRaw =
        notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
        .contains(.shouldResume)
      emitInterruption(
        NativeInterruptionEvent(
          begin: false,
          type: .pause,
          shouldResume: shouldResume,
          permanent: false
        )
      )
    @unknown default:
      return
    }
  }

  private func handleRouteChange(_ notification: Notification) {
    let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
    let reason = AVAudioSession.RouteChangeReason(rawValue: raw) ?? .unknown

    if reason == .oldDeviceUnavailable {
      // The iOS equivalent of Android's ACTION_AUDIO_BECOMING_NOISY: the route
      // we were playing to (headphones, Bluetooth) went away.
      let listeners = withLock { Array(becomingNoisyListeners.values) }
      for listener in listeners { listener() }
    }

    let event = NativeRouteChangeEvent(reason: Self.routeChangeReason(reason))
    let listeners = withLock { Array(routeChangeListeners.values) }
    for listener in listeners { listener(event) }
  }

  /// The media server died. Everything the session held is gone and no
  /// `.ended` interruption is coming, so this is reported exactly the way
  /// Android reports the same fact (`AUDIOFOCUS_LOSS`): a permanent pause.
  ///
  /// SDK header, `AVAudioSessionErrorCodeMediaServicesFailed`: "The app
  /// attempted to use the audio session during or after a Media Services
  /// failure. App should wait for a `AVAudioSessionMediaServicesWereReset`
  /// notification and then rebuild all its state."
  private func handleMediaServicesLost() {
    emitPermanentInterruption()
  }

  /// The media server came back. The session object survives but its category,
  /// mode and options do not — replay the last `configure()` so an app that
  /// simply calls `activate()` again lands in the same session it asked for,
  /// then report the loss (idempotent if `…WereLost` already did).
  private func handleMediaServicesReset() {
    let config = withLock { lastIosConfig }
    if let config {
      workQueue.async { [weak self] in
        guard let self else { return }
        do {
          try self.applyCategory(config)
        } catch {
          // There is no promise left to reject — `configure()` resolved long
          // ago and this replay is our idea, not the app's. Not swallowed
          // either: it is logged, and the app finds out for real on its next
          // `activate()`, which is the call that can answer.
          NSLog(
            "[audio-session] re-applying the category after a media-services reset failed: %@",
            String(describing: error))
        }
      }
    }
    emitPermanentInterruption()
  }

  private func emitPermanentInterruption() {
    emitInterruption(
      NativeInterruptionEvent(
        begin: true,
        type: .pause,
        shouldResume: false,
        permanent: true
      )
    )
  }

  private func emitInterruption(_ event: NativeInterruptionEvent) {
    let listeners = withLock { Array(interruptionListeners.values) }
    for listener in listeners { listener(event) }
  }

  // MARK: - Helpers

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  /// Caller must hold `lock`.
  private func takeListenerId() -> Double {
    let id = nextListenerId
    nextListenerId += 1
    return id
  }

  // MARK: - Enum mapping
  //
  // The generated Swift enum cases are the all-lowercase form of the TS union
  // member (nitrogen upper-cases for C++ and lower-cases for Swift), which is
  // why these read as `.soloambient` rather than `.soloAmbient`.

  private static func avCategory(_ value: IosAudioSessionCategory) -> AVAudioSession.Category {
    switch value {
    case .ambient: return .ambient
    case .soloambient: return .soloAmbient
    case .playback: return .playback
    case .record: return .record
    case .playandrecord: return .playAndRecord
    case .multiroute: return .multiRoute
    }
  }

  private static func avMode(_ value: IosAudioSessionMode) -> AVAudioSession.Mode {
    switch value {
    case .defaultmode: return .default
    case .gamechat: return .gameChat
    case .measurement: return .measurement
    case .movieplayback: return .moviePlayback
    case .spokenaudio: return .spokenAudio
    case .videochat: return .videoChat
    case .videorecording: return .videoRecording
    case .voicechat: return .voiceChat
    case .voiceprompt: return .voicePrompt
    }
  }

  private static func avOptions(
    _ values: [IosAudioSessionCategoryOption]
  ) -> AVAudioSession.CategoryOptions {
    var options: AVAudioSession.CategoryOptions = []
    for value in values {
      switch value {
      case .mixwithothers: options.insert(.mixWithOthers)
      case .duckothers: options.insert(.duckOthers)
      case .allowbluetootha2dp: options.insert(.allowBluetoothA2DP)
      case .allowairplay: options.insert(.allowAirPlay)
      case .defaulttospeaker: options.insert(.defaultToSpeaker)
      case .interruptspokenaudioandmixwithothers:
        options.insert(.interruptSpokenAudioAndMixWithOthers)
      case .overridemutedmicrophoneinterruption:
        options.insert(.overrideMutedMicrophoneInterruption)
      }
    }
    return options
  }

  private static func avRouteSharingPolicy(
    _ value: IosRouteSharingPolicy
  ) -> AVAudioSession.RouteSharingPolicy {
    switch value {
    case .defaultpolicy: return .default
    case .longformaudio: return .longFormAudio
    case .longformvideo: return .longFormVideo
    case .independent: return .independent
    }
  }

  private static func routeChangeReason(
    _ value: AVAudioSession.RouteChangeReason
  ) -> AudioRouteChangeReason {
    switch value {
    case .unknown: return .unknown
    case .newDeviceAvailable: return .newdeviceavailable
    case .oldDeviceUnavailable: return .olddeviceunavailable
    case .categoryChange: return .categorychange
    case .override: return .routeoverride
    case .wakeFromSleep: return .wakefromsleep
    case .noSuitableRouteForCategory: return .nosuitablerouteforcategory
    case .routeConfigurationChange: return .routeconfigurationchange
    @unknown default: return .unknown
    }
  }
}
