//
//  HybridRnMediaCast.swift
//  RnMediaCast
//
//  The iOS half of `@rn-media/cast`.
//
//  Threading contract
//  ------------------
//  GoogleCast is main-thread-only, so every spec method trampolines onto the
//  main queue before touching it; the `CastCoordinator` is then
//  single-threaded by construction. Listener registries are lock-guarded
//  because `add*/remove*Listener` arrive on the JS thread while emissions
//  come from main. Nitro schedules JS callback invocation onto the JS thread
//  itself (nitro.margelo.com/docs/types/callbacks).
//
//  Init-timing ceiling (documented in the spec): Google's guidance is to call
//  `GCKCastContext.setSharedInstanceWith` in
//  `application(_:didFinishLaunchingWithOptions:)` so the SDK can resume a
//  session the app was killed during. JS-driven `initialize` runs later than
//  that, so post-process-death session resumption may be missed until the
//  first initialize of a launch.
//

import Foundation
import GoogleCast
import NitroModules

final class HybridRnMediaCast: HybridRnMediaCastSpec, CastEmitter {
  /// Main-thread only.
  private var coordinator: CastCoordinator?

  /// The receiver application id the shared `GCKCastContext` was created with.
  /// Main-thread only. Kept so a later, differing `initialize` can say out
  /// loud that iOS cannot honour it (see `initialize`).
  private var activeReceiverApplicationId: String?

  /// Cache read by the synchronous `getCastState`. `.unavailable` until
  /// `initialize` succeeds — before init, casting genuinely is not available.
  private var cachedState: CastConnectionState = .unavailable

  private let lock = NSLock()
  private var nextListenerId: Double = 1
  private var castStateListeners: [Double: (NativeCastStateEvent) -> Void] = [:]
  private var sessionListeners: [Double: (NativeCastSessionEvent) -> Void] = [:]
  private var devicesListeners: [Double: (NativeCastDevicesEvent) -> Void] = [:]
  private var mediaStatusListeners: [Double: (NativeCastMediaStatusEvent) -> Void] = [:]
  private var mediaErrorListeners: [Double: (NativeCastMediaErrorEvent) -> Void] = [:]
  private var queueChangedListeners: [Double: () -> Void] = [:]
  private var deviceVolumeListeners: [Double: (NativeDeviceVolumeEvent) -> Void] = [:]

  // MARK: - Spec: context

  func initialize(receiverApplicationId: String?) throws -> Promise<CastConnectionState> {
    let promise = Promise<CastConnectionState>()
    runOnMain { [self] in
      if let existing = coordinator {
        // Idempotent. CEILING: the GCK shared instance cannot change its
        // receiver app id after creation — GCKCastContext exposes only
        // `+setSharedInstanceWithOptions:` / `+isSharedInstanceInitialized`
        // (GCKCastContext.h, 4.8.6), there is no `setReceiverApplicationId`
        // (Android has one) and no way to swap `GCKDiscoveryCriteria` on the
        // live `GCKDiscoveryManager`. Ignoring a differing id in silence is
        // exactly the failure mode this package refuses, so say so.
        if let requested = receiverApplicationId, requested != activeReceiverApplicationId {
          let active = activeReceiverApplicationId ?? kGCKDefaultMediaReceiverApplicationID
          NSLog(
            "%@",
            "[RnMediaCast] initialize(receiverApplicationId: \"\(requested)\") was " +
              "ignored: iOS fixes the receiver application id at the first initialize " +
              "(currently \"\(active)\") and the Cast SDK offers no way to change it. " +
              "Pass the id on the first call, or set it via the Expo plugin. Android " +
              "honours a later change."
          )
        }
        let state = existing.currentConnectionState()
        withLock { cachedState = state }
        existing.emitCurrentState()
        promise.resolve(withResult: state)
        return
      }
      // `isSharedInstanceInitialized` is a class METHOD in the SDK
      // (`+ (BOOL)isSharedInstanceInitialized;`, GCKCastContext.h:92), not a
      // property — it must be called, not read.
      if !GCKCastContext.isSharedInstanceInitialized() {
        let appId = receiverApplicationId ?? kGCKDefaultMediaReceiverApplicationID
        let criteria = GCKDiscoveryCriteria(applicationID: appId)
        let options = GCKCastOptions(discoveryCriteria: criteria)
        // Failure-mode rule from the design doc (§5 backgrounding): an audio
        // sender must keep its session while backgrounded; the OS-side limits
        // are documented in the README.
        options.suspendSessionsWhenBackgrounded = false
        GCKCastContext.setSharedInstanceWith(options)
      }
      guard GCKCastContext.isSharedInstanceInitialized() else {
        withLock { cachedState = .unavailable }
        promise.resolve(withResult: .unavailable)
        return
      }
      let created = CastCoordinator(context: GCKCastContext.sharedInstance(), emitter: self)
      coordinator = created
      activeReceiverApplicationId =
        receiverApplicationId ?? kGCKDefaultMediaReceiverApplicationID
      let state = created.currentConnectionState()
      withLock { cachedState = state }
      // The SDK may have resumed a session before JS got here, and nothing
      // replays that to a late listener. See CastCoordinator.emitCurrentState.
      created.emitCurrentState()
      promise.resolve(withResult: state)
    }
    return promise
  }

  func getCastState() throws -> CastConnectionState {
    lock.lock()
    defer { lock.unlock() }
    return cachedState
  }

  func startDiscovery() throws -> Promise<Void> {
    withCoordinator { $0.startDiscovery($1) }
  }

  func stopDiscovery() throws -> Promise<Void> {
    withCoordinator { $0.stopDiscovery($1) }
  }

  func getDevices() throws -> Promise<[CastDeviceInfo]> {
    withCoordinator { $0.getDevices($1) }
  }

  func requestSession(deviceId: String) throws -> Promise<Void> {
    withCoordinator { $0.requestSession(deviceId: deviceId, promise: $1) }
  }

  func showCastPicker() throws -> Promise<Void> {
    withCoordinator { $0.showCastPicker($1) }
  }

  func endSession(stopReceiver: Bool) throws -> Promise<Void> {
    withCoordinator { $0.endSession(stopReceiver: stopReceiver, promise: $1) }
  }

  // MARK: - Spec: media + volume

  func load(source: CastMediaSource, options: CastLoadOptions) throws -> Promise<Void> {
    withCoordinator { $0.load(source: source, options: options, promise: $1) }
  }

  func play() throws -> Promise<Void> { withCoordinator { $0.play($1) } }

  func pause() throws -> Promise<Void> { withCoordinator { $0.pause($1) } }

  func stop() throws -> Promise<Void> { withCoordinator { $0.stop($1) } }

  func seek(position: Double, resumeState: CastSeekResumeState) throws -> Promise<Void> {
    withCoordinator { $0.seek(position: position, resumeState: resumeState, promise: $1) }
  }

  func getApproximatePosition() throws -> Promise<Double> {
    withCoordinator { $0.getApproximatePosition($1) }
  }

  func setStreamVolume(volume: Double) throws -> Promise<Void> {
    withCoordinator { $0.setStreamVolume(volume, promise: $1) }
  }

  func setStreamMuted(muted: Bool) throws -> Promise<Void> {
    withCoordinator { $0.setStreamMuted(muted, promise: $1) }
  }

  func setDeviceVolume(volume: Double) throws -> Promise<Void> {
    withCoordinator { $0.setDeviceVolume(volume, promise: $1) }
  }

  func setDeviceMuted(muted: Bool) throws -> Promise<Void> {
    withCoordinator { $0.setDeviceMuted(muted, promise: $1) }
  }

  func getDeviceVolume() throws -> Promise<NativeDeviceVolumeEvent> {
    withCoordinator { $0.getDeviceVolume($1) }
  }

  // MARK: - Spec: receiver queue

  func queueLoad(items: [CastQueueItemInput], options: CastQueueLoadOptions) throws -> Promise<Void> {
    withCoordinator { $0.queueLoad(items: items, options: options, promise: $1) }
  }

  func queueInsert(items: [CastQueueItemInput], beforeItemId: Double?) throws -> Promise<Void> {
    withCoordinator { $0.queueInsert(items: items, beforeItemId: beforeItemId, promise: $1) }
  }

  func queueRemove(itemIds: [Double]) throws -> Promise<Void> {
    withCoordinator { $0.queueRemove(itemIds: itemIds, promise: $1) }
  }

  func queueReorder(itemIds: [Double], beforeItemId: Double?) throws -> Promise<Void> {
    withCoordinator { $0.queueReorder(itemIds: itemIds, beforeItemId: beforeItemId, promise: $1) }
  }

  func queueJumpTo(itemId: Double, position: Double?) throws -> Promise<Void> {
    withCoordinator { $0.queueJumpTo(itemId: itemId, position: position, promise: $1) }
  }

  func queueSetRepeatMode(mode: CastRepeatMode) throws -> Promise<Void> {
    withCoordinator { $0.queueSetRepeatMode(mode, promise: $1) }
  }

  func getQueueItemIds() throws -> Promise<[Double]> {
    withCoordinator { $0.getQueueItemIds($1) }
  }

  func fetchQueueSlice(startIndex: Double, count: Double) throws -> Promise<[CastQueueItemSnapshot]> {
    withCoordinator { $0.fetchQueueSlice(startIndex: startIndex, count: count, promise: $1) }
  }

  // MARK: - Spec: listeners

  func addCastStateListener(listener: @escaping (_ event: NativeCastStateEvent) -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      castStateListeners[id] = listener
      return id
    }
  }

  func removeCastStateListener(listenerId: Double) throws {
    withLock { _ = castStateListeners.removeValue(forKey: listenerId) }
  }

  func addSessionListener(listener: @escaping (_ event: NativeCastSessionEvent) -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      sessionListeners[id] = listener
      return id
    }
  }

  func removeSessionListener(listenerId: Double) throws {
    withLock { _ = sessionListeners.removeValue(forKey: listenerId) }
  }

  func addDevicesListener(listener: @escaping (_ event: NativeCastDevicesEvent) -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      devicesListeners[id] = listener
      return id
    }
  }

  func removeDevicesListener(listenerId: Double) throws {
    withLock { _ = devicesListeners.removeValue(forKey: listenerId) }
  }

  func addMediaStatusListener(listener: @escaping (_ event: NativeCastMediaStatusEvent) -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      mediaStatusListeners[id] = listener
      return id
    }
  }

  func removeMediaStatusListener(listenerId: Double) throws {
    withLock { _ = mediaStatusListeners.removeValue(forKey: listenerId) }
  }

  func addMediaErrorListener(listener: @escaping (_ event: NativeCastMediaErrorEvent) -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      mediaErrorListeners[id] = listener
      return id
    }
  }

  func removeMediaErrorListener(listenerId: Double) throws {
    withLock { _ = mediaErrorListeners.removeValue(forKey: listenerId) }
  }

  func addQueueChangedListener(listener: @escaping () -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      queueChangedListeners[id] = listener
      return id
    }
  }

  func removeQueueChangedListener(listenerId: Double) throws {
    withLock { _ = queueChangedListeners.removeValue(forKey: listenerId) }
  }

  func addDeviceVolumeListener(listener: @escaping (_ event: NativeDeviceVolumeEvent) -> Void) throws -> Double {
    withLock {
      let id = takeListenerId()
      deviceVolumeListeners[id] = listener
      return id
    }
  }

  func removeDeviceVolumeListener(listenerId: Double) throws {
    withLock { _ = deviceVolumeListeners.removeValue(forKey: listenerId) }
  }

  // MARK: - CastEmitter (called on main by the coordinator)

  func onCastState(_ event: NativeCastStateEvent) {
    let listeners = withLock { () -> [(NativeCastStateEvent) -> Void] in
      cachedState = event.state
      return Array(castStateListeners.values)
    }
    for listener in listeners { listener(event) }
  }

  func onSession(_ event: NativeCastSessionEvent) {
    for listener in withLock({ Array(sessionListeners.values) }) { listener(event) }
  }

  func onDevices(_ event: NativeCastDevicesEvent) {
    for listener in withLock({ Array(devicesListeners.values) }) { listener(event) }
  }

  func onMediaStatus(_ event: NativeCastMediaStatusEvent) {
    for listener in withLock({ Array(mediaStatusListeners.values) }) { listener(event) }
  }

  func onMediaError(_ event: NativeCastMediaErrorEvent) {
    for listener in withLock({ Array(mediaErrorListeners.values) }) { listener(event) }
  }

  func onQueueChanged() {
    for listener in withLock({ Array(queueChangedListeners.values) }) { listener() }
  }

  func onDeviceVolume(_ event: NativeDeviceVolumeEvent) {
    for listener in withLock({ Array(deviceVolumeListeners.values) }) { listener(event) }
  }

  // MARK: - Helpers

  private func runOnMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
      block()
    } else {
      DispatchQueue.main.async(execute: block)
    }
  }

  /// Trampoline a coordinator call onto the main thread; before a successful
  /// `initialize` every call is a typed `[unavailable]` rejection.
  private func withCoordinator<T>(
    _ block: @escaping (CastCoordinator, Promise<T>) -> Void
  ) -> Promise<T> {
    let promise = Promise<T>()
    runOnMain { [self] in
      guard let coordinator = self.coordinator else {
        promise.reject(withError: CastBridgeError.message(
          "[unavailable] Cast framework is not initialized — call initialize() first."))
        return
      }
      block(coordinator, promise)
    }
    return promise
  }

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
}
