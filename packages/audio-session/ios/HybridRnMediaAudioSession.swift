//
//  HybridRnMediaAudioSession.swift
//  RnMediaAudioSession
//
//  The iOS half of `@rn-media/audio-session`.
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

    let category = Self.avCategory(ios.category)
    let mode = Self.avMode(ios.mode)
    let options = Self.avOptions(ios.categoryOptions)
    let policy = ios.routeSharingPolicy.map(Self.avRouteSharingPolicy)

    let promise = Promise<Void>()
    workQueue.async { [weak self] in
      guard let self else { return promise.resolve(withResult: ()) }
      do {
        if let policy {
          try self.session.setCategory(
            category, mode: mode, policy: policy, options: options)
        } else {
          try self.session.setCategory(category, mode: mode, options: options)
        }
        self.installObservers()
        promise.resolve(withResult: ())
      } catch {
        promise.reject(withError: error)
      }
    }
    return promise
  }

  func activate() throws -> Promise<Bool> {
    let promise = Promise<Bool>()
    workQueue.async { [weak self] in
      guard let self else { return promise.resolve(withResult: false) }
      do {
        try self.session.setActive(true)
        promise.resolve(withResult: true)
      } catch let error as NSError
        where error.domain == NSOSStatusErrorDomain
          && error.code == Int(AVAudioSession.ErrorCode.cannotStartPlaying.rawValue)
      {
        // The OS refused (backgrounded with a category that forbids it, an
        // extension, ...). That is Android's `AUDIOFOCUS_REQUEST_FAILED`, not a
        // programming error — report it as "not granted". Everything else is a
        // real failure and is surfaced as a rejection.
        promise.resolve(withResult: false)
      } catch {
        promise.reject(withError: error)
      }
    }
    return promise
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

    lock.lock()
    observers = [interruption, routeChange]
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
