//
//  CastCoordinator.swift
//  RnMediaCast
//
//  Everything after a successful `GCKCastContext` initialization: discovery,
//  session lifecycle, `GCKRemoteMediaClient` transport and the receiver
//  queue — the iOS mirror of the Android `CastController`.
//
//  Threading contract
//  ------------------
//  MAIN THREAD ONLY. GoogleCast requires main-thread access; the hybrid
//  trampolines every call (and construction) onto the main queue, so the
//  mutable state below needs no locking. Emitter callbacks fire on main;
//  Nitro hops JS callbacks to the JS thread itself.
//

import Foundation
import GoogleCast
import NitroModules

/// Fan-out seam between the coordinator and the hybrid's listener registries.
protocol CastEmitter: AnyObject {
  func onCastState(_ event: NativeCastStateEvent)
  func onSession(_ event: NativeCastSessionEvent)
  func onDevices(_ event: NativeCastDevicesEvent)
  func onMediaStatus(_ event: NativeCastMediaStatusEvent)
  func onMediaError(_ event: NativeCastMediaErrorEvent)
  func onQueueChanged()
  func onDeviceVolume(_ event: NativeDeviceVolumeEvent)
}

final class CastCoordinator: NSObject {
  private let context: GCKCastContext
  private weak var emitter: CastEmitter?

  /// In-flight `requestSession` promise; settled by the session listener.
  private var pendingStart: Promise<Void>?

  /// In-flight `endSession` promise; settled by `didEnd`.
  private var pendingEnd: Promise<Void>?

  private var discoveryActive = false

  /// The connect-ordering rule, encoded: `stopDiscovery` during an in-flight
  /// session start defers teardown until the start settles (Android mirror).
  private var discoveryStopDeferred = false

  /// Exactly what `attach` registered, so `detach` unregisters exactly it.
  private var attachedSession: GCKCastSession?
  private var attachedClient: GCKRemoteMediaClient?

  /// GCKRequest delegates retained until their request settles.
  private var inFlightRequests: Set<RequestBridge> = []

  init(context: GCKCastContext, emitter: CastEmitter) {
    self.context = context
    self.emitter = emitter
    super.init()

    context.sessionManager.add(self)
    context.discoveryManager.add(self)
    // The SDK exports `kGCKCastStateDidChangeNotification` as a plain
    // `extern NSString *const` whose name ends in "Notification", so Swift's
    // ClangImporter rewrites it into `NSNotification.Name` (drop the leading
    // `k`, drop the "Notification" suffix, lowercase the initialism). The
    // Obj-C spelling is NOT in scope from Swift — this is the only spelling
    // that compiles, and it is what Google's own Swift sample uses.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(castStateDidChange),
      name: .gckCastStateDidChange,
      object: nil
    )
    // A session may already be live (SDK-side resumption happens before JS
    // initializes) — attach rather than waiting for an event that already
    // fired.
    if let session = context.sessionManager.currentCastSession,
       session.connectionState == .connected {
      attach(session)
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Context / discovery / session

  func currentConnectionState() -> CastConnectionState {
    CastMapping.connectionState(context.castState)
  }

  func startDiscovery(_ promise: Promise<Void>) {
    discoveryActive = true
    discoveryStopDeferred = false
    context.discoveryManager.startDiscovery()
    emitDevices()
    promise.resolve(withResult: ())
  }

  func stopDiscovery(_ promise: Promise<Void>) {
    if pendingStart != nil {
      // Connect-ordering rule: never drop discovery mid-handshake.
      discoveryStopDeferred = true
    } else {
      reallyStopDiscovery()
    }
    promise.resolve(withResult: ())
  }

  private func completeDeferredDiscoveryStop() {
    if discoveryStopDeferred {
      discoveryStopDeferred = false
      reallyStopDiscovery()
    }
  }

  private func reallyStopDiscovery() {
    guard discoveryActive else { return }
    discoveryActive = false
    context.discoveryManager.stopDiscovery()
  }

  func getDevices(_ promise: Promise<[CastDeviceInfo]>) {
    promise.resolve(withResult: discoveredDevices())
  }

  func requestSession(deviceId: String, promise: Promise<Void>) {
    if let current = attachedSession, current.device.deviceID == deviceId {
      promise.resolve(withResult: ())
      return
    }
    guard pendingStart == nil else {
      promise.reject(withError: CastBridgeError.message(
        "[invalid-state] A session request is already in flight."))
      return
    }
    guard let device = findDevice(deviceId) else {
      promise.reject(withError: CastBridgeError.message(
        "[invalid-argument] No discovered device with id \"\(deviceId)\". " +
          "Is discovery running? (Connect before stopDiscovery().)"))
      return
    }
    pendingStart = promise
    emitter?.onCastState(NativeCastStateEvent(state: .connecting, device: nil))
    if !context.sessionManager.startSession(with: device) {
      pendingStart = nil
      promise.reject(withError: CastBridgeError.message(
        "[session-start-failed] The SDK refused to start a session " +
          "(is another session still ending?)"))
    }
  }

  func showCastPicker(_ promise: Promise<Void>) {
    // The GCK dialog manages its own discovery while open. First presentation
    // is also what triggers the iOS local-network permission prompt — the OS
    // rule is "on first use", which is exactly here.
    context.presentCastDialog()
    promise.resolve(withResult: ())
  }

  func endSession(stopReceiver: Bool, promise: Promise<Void>) {
    guard context.sessionManager.currentCastSession != nil else {
      // Ending nothing is success, not an error — idempotent teardown.
      promise.resolve(withResult: ())
      return
    }
    pendingEnd?.resolve(withResult: ())
    pendingEnd = promise
    if !context.sessionManager.endSessionAndStopCasting(stopReceiver) {
      pendingEnd = nil
      promise.resolve(withResult: ()) // nothing to end after all
    }
  }

  // MARK: - RemoteMediaClient: transport

  func load(source: CastMediaSource, options: CastLoadOptions, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    guard let mediaInformation = mediaInfo(source, promise: promise) else { return }
    let builder = GCKMediaLoadRequestDataBuilder()
    builder.mediaInformation = mediaInformation
    builder.autoplay = NSNumber(value: options.autoplay ?? true)
    builder.startTime = CastMapping.sanitizeSeconds(options.startPosition ?? 0)
    if let rate = options.playbackRate, rate.isFinite, rate > 0 {
      builder.playbackRate = Float(rate)
    }
    builder.credentials = options.credentials
    builder.credentialsType = options.credentialsType
    bridge(client.loadMedia(with: builder.build()), promise, family: "load-failed", operation: "load")
  }

  func play(_ promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(client.play(), promise, operation: "play")
  }

  func pause(_ promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(client.pause(), promise, operation: "pause")
  }

  func stop(_ promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(client.stop(), promise, operation: "stop")
  }

  func seek(position: Double, resumeState: CastSeekResumeState, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    let options = GCKMediaSeekOptions()
    options.interval = CastMapping.sanitizeSeconds(position)
    options.resumeState = CastMapping.toGCKResumeState(resumeState)
    bridge(client.seek(with: options), promise, operation: "seek")
  }

  func getApproximatePosition(_ promise: Promise<Double>) {
    guard let client = requireClient(promise) else { return }
    promise.resolve(withResult: client.approximateStreamPosition())
  }

  // MARK: - Volume (device volume primary)

  func setStreamVolume(_ volume: Double, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(client.setStreamVolume(Float(volume)), promise, operation: "setStreamVolume")
  }

  func setStreamMuted(_ muted: Bool, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(client.setStreamMuted(muted), promise, operation: "setStreamMuted")
  }

  func setDeviceVolume(_ volume: Double, promise: Promise<Void>) {
    guard let session = requireSession(promise) else { return }
    bridge(session.setDeviceVolume(Float(volume)), promise, operation: "setDeviceVolume")
  }

  func setDeviceMuted(_ muted: Bool, promise: Promise<Void>) {
    guard let session = requireSession(promise) else { return }
    bridge(session.setDeviceMuted(muted), promise, operation: "setDeviceMuted")
  }

  func getDeviceVolume(_ promise: Promise<NativeDeviceVolumeEvent>) {
    guard let session = requireSession(promise) else { return }
    promise.resolve(withResult: NativeDeviceVolumeEvent(
      volume: Double(session.currentDeviceVolume),
      muted: session.currentDeviceMuted
    ))
  }

  // MARK: - Receiver queue

  func queueLoad(items: [CastQueueItemInput], options: CastQueueLoadOptions, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    var queueItems: [GCKMediaQueueItem] = []
    queueItems.reserveCapacity(items.count)
    for item in items {
      guard let built = queueItem(item, promise: promise) else { return }
      queueItems.append(built)
    }
    let queueBuilder = GCKMediaQueueDataBuilder(queueType: .generic)
    queueBuilder.items = queueItems
    queueBuilder.startIndex = UInt(max(0, Int(options.startIndex ?? 0)))
    queueBuilder.startTime = CastMapping.sanitizeSeconds(options.startPosition ?? 0)
    queueBuilder.repeatMode = CastMapping.toGCKRepeatMode(options.repeatMode ?? .off)
    let builder = GCKMediaLoadRequestDataBuilder()
    builder.queueData = queueBuilder.build()
    builder.credentials = options.credentials
    builder.credentialsType = options.credentialsType
    bridge(client.loadMedia(with: builder.build()), promise, family: "load-failed", operation: "queueLoad")
  }

  func queueInsert(items: [CastQueueItemInput], beforeItemId: Double?, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    var queueItems: [GCKMediaQueueItem] = []
    queueItems.reserveCapacity(items.count)
    for item in items {
      guard let built = queueItem(item, promise: promise) else { return }
      queueItems.append(built)
    }
    let beforeID = beforeItemId.map { UInt($0) } ?? kGCKMediaQueueInvalidItemID
    bridge(
      client.queueInsert(queueItems, beforeItemWithID: beforeID),
      promise,
      operation: "queueInsert"
    )
  }

  func queueRemove(itemIds: [Double], promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(
      client.queueRemoveItems(withIDs: itemIds.map { NSNumber(value: UInt($0)) }),
      promise,
      operation: "queueRemove"
    )
  }

  func queueReorder(itemIds: [Double], beforeItemId: Double?, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    let beforeID = beforeItemId.map { UInt($0) } ?? kGCKMediaQueueInvalidItemID
    bridge(
      client.queueReorderItems(
        withIDs: itemIds.map { NSNumber(value: UInt($0)) },
        insertBeforeItemWithID: beforeID
      ),
      promise,
      operation: "queueReorder"
    )
  }

  func queueJumpTo(itemId: Double, position: Double?, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    let request: GCKRequest
    if let position {
      // Verified against GCKRemoteMediaClient.h (4.8.6):
      // queueJumpToItemWithID:playPosition:customData:.
      request = client.queueJumpToItem(
        withID: UInt(itemId),
        playPosition: CastMapping.sanitizeSeconds(position),
        customData: nil
      )
    } else {
      request = client.queueJumpToItem(withID: UInt(itemId))
    }
    bridge(request, promise, operation: "queueJumpTo")
  }

  func queueSetRepeatMode(_ mode: CastRepeatMode, promise: Promise<Void>) {
    guard let client = requireClient(promise) else { return }
    bridge(
      client.queueSetRepeatMode(CastMapping.toGCKRepeatMode(mode)),
      promise,
      operation: "queueSetRepeatMode"
    )
  }

  func getQueueItemIds(_ promise: Promise<[Double]>) {
    guard let client = requireClient(promise) else { return }
    let queue = client.mediaQueue
    let count = Int(queue.itemCount)
    promise.resolve(withResult: (0..<count).map { Double(queue.itemID(at: UInt($0))) })
  }

  func fetchQueueSlice(startIndex: Double, count: Double, promise: Promise<[CastQueueItemSnapshot]>) {
    guard let client = requireClient(promise) else { return }
    let queue = client.mediaQueue
    let total = Int(queue.itemCount)
    let start = max(0, Int(startIndex))
    let end = min(start + max(0, Int(count)), total)
    guard start < end else {
      promise.resolve(withResult: [])
      return
    }
    var slice: [CastQueueItemSnapshot] = []
    slice.reserveCapacity(end - start)
    for index in start..<end {
      // `fetchIfNeeded: true`: a cache miss returns nil AND requests the
      // item; the GCKMediaQueueDelegate fires `queueChanged` when it lands —
      // the caller re-reads then. One paged call, never per-item RPCs.
      let item = queue.item(at: UInt(index), fetchIfNeeded: true)
      let media = item?.mediaInformation
      slice.append(CastQueueItemSnapshot(
        itemId: Double(queue.itemID(at: UInt(index))),
        resolved: item != nil,
        url: media?.contentURL?.absoluteString,
        mimeType: media?.contentType,
        title: media?.metadata?.string(forKey: kGCKMetadataKeyTitle),
        artist: media?.metadata?.string(forKey: kGCKMetadataKeyArtist)
      ))
    }
    promise.resolve(withResult: slice)
  }

  // MARK: - Internals

  private func attach(_ session: GCKCastSession) {
    guard attachedSession !== session else { return }
    detach()
    attachedSession = session
    let client = session.remoteMediaClient
    attachedClient = client
    client?.add(self)
    // `mediaQueue` is non-nullable on GCKRemoteMediaClient (GCKRemoteMediaClient.h).
    client?.mediaQueue.add(self)
  }

  private func detach() {
    attachedClient?.mediaQueue.remove(self)
    attachedClient?.remove(self)
    attachedClient = nil
    attachedSession = nil
  }

  private func requireClient<T>(_ promise: Promise<T>) -> GCKRemoteMediaClient? {
    guard let client = attachedClient else {
      promise.reject(withError: CastBridgeError.message(
        "[no-session] No connected cast session. Call requestSession() first."))
      return nil
    }
    return client
  }

  private func requireSession<T>(_ promise: Promise<T>) -> GCKCastSession? {
    guard let session = attachedSession else {
      promise.reject(withError: CastBridgeError.message(
        "[no-session] No connected cast session. Call requestSession() first."))
      return nil
    }
    return session
  }

  private func findDevice(_ deviceId: String) -> GCKDevice? {
    let manager = context.discoveryManager
    for index in 0..<manager.deviceCount {
      let device = manager.device(at: index)
      if device.deviceID == deviceId { return device }
    }
    return nil
  }

  private func discoveredDevices() -> [CastDeviceInfo] {
    let manager = context.discoveryManager
    return (0..<manager.deviceCount).map { CastMapping.deviceInfo(manager.device(at: $0)) }
  }

  private func emitDevices() {
    emitter?.onDevices(NativeCastDevicesEvent(devices: discoveredDevices()))
  }

  private func currentDeviceInfo() -> CastDeviceInfo? {
    (context.sessionManager.currentCastSession?.device).map(CastMapping.deviceInfo)
  }

  private func emitSession(
    _ type: CastSessionEventType,
    _ session: GCKCastSession?,
    errorCode: Double? = nil
  ) {
    emitter?.onSession(NativeCastSessionEvent(
      type: type,
      errorCode: errorCode,
      device: (session?.device).map(CastMapping.deviceInfo)
    ))
  }

  private func statusEvent(_ client: GCKRemoteMediaClient, _ status: GCKMediaStatus) -> NativeCastMediaStatusEvent {
    let duration = status.mediaInformation?.streamDuration
    let currentItemID = status.currentItemID
    return NativeCastMediaStatusEvent(
      playerState: CastMapping.playerState(status.playerState),
      idleReason: CastMapping.idleReason(status.idleReason),
      position: client.approximateStreamPosition(),
      duration: (duration?.isFinite == true && duration! > 0) ? duration : nil,
      playbackRate: Double(status.playbackRate),
      streamVolume: Double(status.volume),
      streamMuted: status.isMuted,
      repeatMode: CastMapping.repeatMode(status.queueRepeatMode),
      currentItemId: currentItemID == kGCKMediaQueueInvalidItemID ? nil : Double(currentItemID),
      queueItemCount: Double(status.queueItemCount)
    )
  }

  private func mediaInfo<T>(_ source: CastMediaSource, promise: Promise<T>) -> GCKMediaInformation? {
    guard let url = URL(string: source.url) else {
      promise.reject(withError: CastBridgeError.message(
        "[invalid-argument] \"\(source.url)\" is not a valid URL."))
      return nil
    }
    let metadata = GCKMediaMetadata(metadataType: .musicTrack)
    if let m = source.metadata {
      if let title = m.title { metadata.setString(title, forKey: kGCKMetadataKeyTitle) }
      if let artist = m.artist { metadata.setString(artist, forKey: kGCKMetadataKeyArtist) }
      if let album = m.albumTitle { metadata.setString(album, forKey: kGCKMetadataKeyAlbumTitle) }
      if let artwork = m.artworkUrl, let artworkURL = URL(string: artwork) {
        metadata.addImage(GCKImage(url: artworkURL, width: 512, height: 512))
      }
    }
    let builder = GCKMediaInformationBuilder(contentURL: url)
    builder.contentType = source.mimeType
    builder.streamType = source.live == true ? .live : .buffered
    builder.metadata = metadata
    if let duration = source.duration, duration.isFinite, duration > 0 {
      builder.streamDuration = duration
    }
    return builder.build()
  }

  private func queueItem<T>(_ input: CastQueueItemInput, promise: Promise<T>) -> GCKMediaQueueItem? {
    guard let media = mediaInfo(input.source, promise: promise) else { return nil }
    let builder = GCKMediaQueueItemBuilder()
    builder.mediaInformation = media
    // Receiver-side advancement: autoplay is what lets the queue keep going
    // with the phone asleep.
    builder.autoplay = input.autoplay ?? true
    if let preload = input.preloadTime, preload.isFinite, preload >= 0 {
      builder.preloadTime = preload
    }
    if let start = input.startPosition, start.isFinite, start >= 0 {
      builder.startTime = start
    }
    return builder.build()
  }

  /// Settle a promise from a `GCKRequest`. The delegate object retains itself
  /// in `inFlightRequests` until the request completes or fails.
  private func bridge(
    _ request: GCKRequest,
    _ promise: Promise<Void>,
    family: String = "native",
    operation: String
  ) {
    let box = RequestBridge(promise: promise, family: family, operation: operation) { [weak self] bridge in
      self?.inFlightRequests.remove(bridge)
    }
    inFlightRequests.insert(box)
    request.delegate = box
  }

  @objc private func castStateDidChange() {
    emitter?.onCastState(NativeCastStateEvent(
      state: CastMapping.connectionState(context.castState),
      device: currentDeviceInfo()
    ))
  }
}

// MARK: - GCKSessionManagerListener

extension CastCoordinator: GCKSessionManagerListener {
  func sessionManager(_ sessionManager: GCKSessionManager, willStart session: GCKCastSession) {
    emitSession(.starting, session)
    emitter?.onCastState(NativeCastStateEvent(
      state: .connecting, device: CastMapping.deviceInfo(session.device)))
  }

  func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) {
    attach(session)
    pendingStart?.resolve(withResult: ())
    pendingStart = nil
    completeDeferredDiscoveryStop()
    emitSession(.started, session)
    emitter?.onCastState(NativeCastStateEvent(
      state: .connected, device: CastMapping.deviceInfo(session.device)))
  }

  func sessionManager(
    _ sessionManager: GCKSessionManager,
    didFailToStart session: GCKCastSession,
    withError error: Error
  ) {
    let code = (error as NSError).code
    pendingStart?.reject(withError: CastBridgeError.message(
      "[session-start-failed] The platform reported a session start failure, status=\(code)"))
    pendingStart = nil
    completeDeferredDiscoveryStop()
    emitSession(.startfailed, session, errorCode: Double(code))
    emitter?.onCastState(NativeCastStateEvent(state: .idle, device: nil))
  }

  func sessionManager(_ sessionManager: GCKSessionManager, willEnd session: GCKCastSession) {
    emitSession(.ending, session)
  }

  func sessionManager(
    _ sessionManager: GCKSessionManager,
    didEnd session: GCKCastSession,
    withError error: Error?
  ) {
    detach()
    // The end *completed*; an error is context for the session event, not a
    // reason to fail the endSession() promise.
    pendingEnd?.resolve(withResult: ())
    pendingEnd = nil
    emitSession(.ended, session, errorCode: error.map { Double(($0 as NSError).code) })
    emitter?.onCastState(NativeCastStateEvent(state: .idle, device: nil))
  }

  func sessionManager(_ sessionManager: GCKSessionManager, didResumeCastSession session: GCKCastSession) {
    attach(session)
    pendingStart?.resolve(withResult: ())
    pendingStart = nil
    emitSession(.resumed, session)
    emitter?.onCastState(NativeCastStateEvent(
      state: .connected, device: CastMapping.deviceInfo(session.device)))
  }

  func sessionManager(
    _ sessionManager: GCKSessionManager,
    didSuspend session: GCKCastSession,
    with reason: GCKConnectionSuspendReason
  ) {
    // Recoverable (network blip / backgrounding); the SDK resumes on its own.
    // The remote client is unusable meanwhile.
    detach()
    emitSession(.suspended, session, errorCode: Double(reason.rawValue))
  }

  func sessionManager(
    _ sessionManager: GCKSessionManager,
    castSession session: GCKCastSession,
    didReceiveDeviceVolume volume: Float,
    muted: Bool
  ) {
    emitter?.onDeviceVolume(NativeDeviceVolumeEvent(volume: Double(volume), muted: muted))
  }
}

// MARK: - GCKDiscoveryManagerListener

extension CastCoordinator: GCKDiscoveryManagerListener {
  // `didUpdateDeviceList` is the SDK's own batch signal, fired once after a
  // burst of insert/update/remove callbacks — the coalescing the Android side
  // does with a Handler comes for free here.
  func didUpdateDeviceList() {
    emitDevices()
  }
}

// MARK: - GCKRemoteMediaClientListener

extension CastCoordinator: GCKRemoteMediaClientListener {
  func remoteMediaClient(_ client: GCKRemoteMediaClient, didUpdate mediaStatus: GCKMediaStatus?) {
    guard let status = mediaStatus else { return }
    emitter?.onMediaStatus(statusEvent(client, status))
  }

  func remoteMediaClientDidUpdateQueue(_ client: GCKRemoteMediaClient) {
    emitter?.onQueueChanged()
  }
}

// MARK: - GCKMediaQueueDelegate

extension CastCoordinator: GCKMediaQueueDelegate {
  func mediaQueueDidChange(_ queue: GCKMediaQueue) {
    emitter?.onQueueChanged()
  }

  func mediaQueueDidReloadItems(_ queue: GCKMediaQueue) {
    emitter?.onQueueChanged()
  }
}

// MARK: - Request bridging

/// A typed error whose message carries the `[code]` prefix the TS facade
/// parses — Swift's `Error` bridging preserves `localizedDescription`.
enum CastBridgeError: LocalizedError {
  case message(String)

  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    }
  }
}

/// Settles one promise from one `GCKRequest`'s delegate callbacks, then
/// releases itself via `onSettled`.
final class RequestBridge: NSObject, GCKRequestDelegate {
  private let promise: Promise<Void>
  private let family: String
  private let operation: String
  private let onSettled: (RequestBridge) -> Void

  init(
    promise: Promise<Void>,
    family: String,
    operation: String,
    onSettled: @escaping (RequestBridge) -> Void
  ) {
    self.promise = promise
    self.family = family
    self.operation = operation
    self.onSettled = onSettled
    super.init()
  }

  func requestDidComplete(_ request: GCKRequest) {
    promise.resolve(withResult: ())
    onSettled(self)
  }

  func request(_ request: GCKRequest, didFailWithError error: GCKError) {
    promise.reject(withError: CastBridgeError.message(
      "[\(family)] \(operation) failed, status=\(error.code) (\(error.localizedDescription))"))
    onSettled(self)
  }

  func request(_ request: GCKRequest, didAbortWith abortReason: GCKRequestAbortReason) {
    // Replaced by a newer request (e.g. two rapid seeks). Not a failure the
    // caller can act on — the newer request's outcome is the truth.
    promise.resolve(withResult: ())
    onSettled(self)
  }
}
