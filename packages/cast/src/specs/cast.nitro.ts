import type { HybridObject } from 'react-native-nitro-modules'

/* -------------------------------------------------------------------------- */
/*                                   State                                    */
/* -------------------------------------------------------------------------- */

/**
 * The cast connection state machine, identical on both platforms.
 *
 * - `unavailable` — the Cast framework cannot run here. Android: Google Play
 *   services is missing or the cast dynamite module failed to load (the
 *   framework is loaded from Play services at runtime; absence is a typed
 *   capability answer, never a crash). iOS: `initialize` has not succeeded.
 * - `idle` — framework ready, no session. Covers both "no devices found" and
 *   "devices found but not connected"; the device list answers which.
 * - `connecting` — a session start is in flight.
 * - `connected` — a cast session is active; media/queue calls are legal.
 * - `transferring` — an output-switcher stream transfer is in progress
 *   (Android 13+ only; iOS has no system transfer surface).
 */
export type CastConnectionState =
  'unavailable' | 'idle' | 'connecting' | 'connected' | 'transferring'

/**
 * Receiver player state, mapped 1:1 from `MediaStatus.PLAYER_STATE_*`
 * (Android) / `GCKMediaPlayerState` (iOS).
 */
export type CastPlayerState =
  'unknown' | 'idle' | 'loading' | 'buffering' | 'paused' | 'playing'

/**
 * Why the receiver went idle. Mapped from `MediaStatus.IDLE_REASON_*` /
 * `GCKMediaPlayerIdleReason`. `error` is the receiver-side failure family —
 * the receiver fetches media itself, so this is distinct from any sender-side
 * network error (`cast-receiver-fetch` in the TS error taxonomy).
 */
export type CastIdleReason =
  'none' | 'finished' | 'cancelled' | 'interrupted' | 'error'

/** Receiver queue repeat mode (`MediaStatus.REPEAT_MODE_*` / `GCKMediaRepeatMode`). */
export type CastRepeatMode = 'off' | 'one' | 'all' | 'allAndShuffle'

/**
 * What the receiver should do after a seek completes.
 * Maps to `MediaSeekOptions.setResumeState` / `GCKMediaSeekOptions.resumeState`.
 */
export type CastSeekResumeState = 'unchanged' | 'play' | 'pause'

/**
 * Session lifecycle notifications, fanned in from
 * `SessionManagerListener<CastSession>` (Android) and
 * `GCKSessionManagerListener` (iOS), plus Android's
 * `SessionTransferCallback` for the output-switcher stream transfer.
 *
 * Parity notes — two members are **Android-only ceilings**:
 * - `transferring` / `transferred` / `transferFailed` come from
 *   `CastContext.addSessionTransferCallback` (play-services-cast-framework
 *   22.3.1), the Android 13+ system output-switcher stream transfer. iOS has
 *   no system transfer surface and `GCKSessionManagerListener`
 *   (GoogleCast 4.8.6, `GCKSessionManager.h`) declares no transfer callback,
 *   so these never fire there — as does the `transferring` connection state.
 * - `startFailed` fires on iOS for a failed session *start*
 *   (`sessionManager:didFailToStartCastSession:withError:`) but not for a
 *   failed session *resume*: 4.8.6 removed the resume-failure callback
 *   entirely (there is no `didFailToResume…` anywhere in the 4.8.6 headers;
 *   Google's own `CastVideos-swift` sample still implements one, which is
 *   exactly the silent no-op this note exists to prevent). Android reports it
 *   via `onSessionResumeFailed`.
 *
 * Everything else fires on both.
 */
export type CastSessionEventType =
  | 'starting'
  | 'started'
  | 'startFailed'
  | 'ending'
  | 'ended'
  | 'resumed'
  | 'suspended'
  | 'transferring'
  | 'transferred'
  | 'transferFailed'

/* -------------------------------------------------------------------------- */
/*                                  Structs                                   */
/* -------------------------------------------------------------------------- */

/** A discovered cast receiver. */
export interface CastDeviceInfo {
  /**
   * Stable device id (`CastDevice.getDeviceId()` / `GCKDevice.deviceID`).
   * This is the id {@link RnMediaCast.requestSession} accepts.
   */
  id: string
  /** Friendly name as configured by the user ("Living Room speaker"). */
  name: string
  /** Hardware model ("Mi Smart Speaker"), when the device reports one. */
  model?: string
}

/**
 * Metadata projected onto the receiver's now-playing surface.
 *
 * The projection names every field it forwards (failure-mode rule from the
 * design doc): title, artist, album title and one artwork URL. Nothing else
 * survives the handoff.
 */
export interface CastMediaMetadata {
  title?: string
  artist?: string
  albumTitle?: string
  /** HTTPS URL the *receiver* fetches — `file://` artwork cannot cast. */
  artworkUrl?: string
}

/** One castable media source. The receiver fetches `url` itself. */
export interface CastMediaSource {
  /** HTTP(S) URL reachable from the receiver's network. */
  url: string
  /** Concrete audio MIME type, e.g. `'audio/mp3'`, `'audio/mp4'`, `'audio/flac'`. */
  mimeType: string
  metadata?: CastMediaMetadata
  /** Known duration in seconds. Omit when unknown. */
  duration?: number
  /** `true` marks a live stream (receiver disables seeking). */
  live?: boolean
}

/** Options for a single-item {@link RnMediaCast.load}. */
export interface CastLoadOptions {
  /** Start playing as soon as the receiver is ready. @default true */
  autoplay?: boolean
  /** Initial position in seconds. @default 0 */
  startPosition?: number
  /** Playback rate forwarded to the receiver. Omit to keep the receiver default. */
  playbackRate?: number
  /**
   * Opaque credentials string forwarded via
   * `MediaLoadRequestData.setCredentials` — only a **custom Web Receiver**
   * ever sees it; the Default Media Receiver ignores it. Per-source auth
   * headers do not travel to receivers at all.
   */
  credentials?: string
  /** Credentials type tag forwarded alongside {@link credentials}. */
  credentialsType?: string
}

/** One receiver-queue entry for {@link RnMediaCast.queueLoad} / inserts. */
export interface CastQueueItemInput {
  source: CastMediaSource
  /**
   * Whether the receiver advances into this item automatically. Receiver-side
   * autoplay is what lets the queue survive the phone sleeping. @default true
   */
  autoplay?: boolean
  /**
   * Seconds before the end of the previous item at which the receiver starts
   * pre-buffering this one. Receiver pre-buffering is a gap *shortener*, not
   * gapless. Omit for the receiver default.
   */
  preloadTime?: number
  /** Position (seconds) at which this item starts when first played. */
  startPosition?: number
}

/** Options for {@link RnMediaCast.queueLoad}. */
export interface CastQueueLoadOptions {
  /** Index into the items array to start from. @default 0 */
  startIndex?: number
  /** Start position (seconds) within the starting item. @default 0 */
  startPosition?: number
  /** @default 'off' */
  repeatMode?: CastRepeatMode
  /** See {@link CastLoadOptions.credentials}. */
  credentials?: string
  /** See {@link CastLoadOptions.credentialsType}. */
  credentialsType?: string
}

/**
 * One row of the sender-side queue mirror.
 *
 * The mirror is sparse by SDK design: the sender caches a window of items and
 * fetches the rest lazily. `resolved: false` means the row is not cached yet —
 * requesting it (via {@link RnMediaCast.fetchQueueSlice}) triggers a
 * background fetch and a later `queueChanged` event when the cache fills.
 */
export interface CastQueueItemSnapshot {
  /** Receiver-assigned item id. Stable for the life of the queue. */
  itemId: number
  /** `true` when the item's media info is in the sender cache. */
  resolved: boolean
  url?: string
  mimeType?: string
  title?: string
  artist?: string
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

/** Connection-state discontinuity. */
export interface NativeCastStateEvent {
  state: CastConnectionState
  /** The connected device while `state` is `connected`/`transferring`. */
  device?: CastDeviceInfo
}

/** Session lifecycle notification. */
export interface NativeCastSessionEvent {
  type: CastSessionEventType
  /**
   * Platform status code accompanying `startFailed`, `suspended`, `ended`
   * (when the end was an error) and `transferFailed`. Android: a
   * `CastStatusCodes` value; iOS: an `NSError` code.
   */
  errorCode?: number
  device?: CastDeviceInfo
}

/** Discovery produced a new device list (already debounced natively). */
export interface NativeCastDevicesEvent {
  devices: CastDeviceInfo[]
}

/**
 * Receiver media-status discontinuity.
 *
 * Emitted only when the receiver reports a status change — position is never
 * streamed (library rule). `position` is the receiver's approximate stream
 * position when the status arrived; clients project locally from there.
 */
export interface NativeCastMediaStatusEvent {
  playerState: CastPlayerState
  /** Meaningful only while `playerState` is `idle`. */
  idleReason: CastIdleReason
  /** Approximate receiver position in seconds at event time. */
  position: number
  /** Stream duration in seconds; absent when unknown or live. */
  duration?: number
  playbackRate: number
  /** Receiver stream volume 0..1 (the app-level layer, not the speaker volume). */
  streamVolume: number
  streamMuted: boolean
  repeatMode: CastRepeatMode
  /** Receiver queue item id currently playing; absent when none. */
  currentItemId?: number
  queueItemCount: number
}

/**
 * Receiver-side media failure. The TS layer folds this into the
 * `cast-receiver-fetch` error family.
 *
 * Fires on **both** platforms, from different sources:
 * - **Android** — the SDK's own out-of-band callback,
 *   `RemoteMediaClient.Callback.onMediaError(MediaError)`, carrying
 *   `getDetailedErrorCode()` and `getReason()`.
 * - **iOS** — synthesized natively from the media status
 *   (`playerState == .idle && idleReason == .error`), once per idle period.
 *
 * **CEILING — the detail fields are Android-only.** GoogleCast 4.8.6 has no
 * media-error callback: `GCKRemoteMediaClientListener`
 * (`GCKRemoteMediaClient.h`) declares ten optional methods and not one of them
 * reports an error, and `GCKMediaStatus` (`GCKMediaStatus.h`) has no error
 * code/reason property — the only error surface the SDK exposes is a failed
 * `GCKRequest`, which is per-request, not out-of-band. So on iOS both fields
 * below are always absent. Branch on the `CastError`'s `code`, never on the
 * presence of these.
 */
export interface NativeCastMediaErrorEvent {
  /** Receiver's detailed error code, when provided. **Android only.** */
  detailedErrorCode?: number
  /** Receiver's error reason string, when provided. **Android only.** */
  reason?: string
}

/** Physical device volume (the primary volume layer while casting). */
export interface NativeDeviceVolumeEvent {
  /** 0..1 */
  volume: number
  muted: boolean
}

/* -------------------------------------------------------------------------- */
/*                               Hybrid Object                                */
/* -------------------------------------------------------------------------- */

/**
 * First-party binding over the official Google Cast sender SDKs
 * (play-services-cast-framework on Android, google-cast-sdk on iOS),
 * audio-scoped.
 *
 * Threading contract
 * ------------------
 * Every `CastContext`/`GCKCastContext` touch happens on the platform main
 * thread — both SDKs require it — via an internal main-thread trampoline; no
 * method here may be assumed to run on the JS thread natively. Promises
 * resolve from the main thread; Nitro schedules JS callbacks onto the JS
 * thread itself (nitro.margelo.com/docs/types/callbacks).
 *
 * Error contract
 * --------------
 * Rejections carry a `[code] message` prefix from the closed set in
 * `src/errors.ts` (`no-session`, `load-failed`, …). The TS facade parses the
 * prefix into a typed `CastError`; nothing in JS should match on prose.
 *
 * Listener registration is id-based (Nitro callbacks are opaque native
 * closures; identity comparison across the bridge is not dependable) — same
 * contract as `@timbre/audio-session`.
 */
export interface RnMediaCast extends HybridObject<{
  ios: 'swift'
  android: 'kotlin'
}> {
  /**
   * Initialize the Cast framework. Idempotent; safe to call again after an
   * `unavailable` answer (e.g. after the user installs Play services).
   *
   * Android: `CastContext.getSharedInstance(Context, Executor)` — the
   * Task-based variant; the framework is a dynamite module fetched from Play
   * services, so a GMS-less device resolves `'unavailable'` instead of
   * crashing. The receiver application id comes from the manifest meta-data
   * our `OptionsProvider` reads; passing `receiverApplicationId` here
   * overrides it at runtime (`CastContext.setReceiverApplicationId`).
   *
   * iOS: `GCKCastContext.setSharedInstanceWith(options)` with
   * `receiverApplicationId` (default: the Default Media Receiver).
   *
   * **CEILING (receiver app id, iOS): the id is fixed at first initialize.**
   * `GCKCastContext` exposes only `+setSharedInstanceWithOptions:` and
   * `+isSharedInstanceInitialized` (GoogleCast 4.8.6, `GCKCastContext.h`) —
   * there is no `setReceiverApplicationId`, no writable `options`, and
   * `GCKDiscoveryManager` has no way to swap its `GCKDiscoveryCriteria`. So a
   * *later* `initialize` with a **different** id is honoured on Android
   * (`CastContext.setReceiverApplicationId`, verified with `javap` against
   * play-services-cast-framework 22.3.1) and cannot be honoured on iOS: the
   * first id wins for the life of the process, and the native side logs a
   * warning rather than failing silently. Pass the id on the first call, or
   * set it in the manifest/plist through the Expo plugin.
   *
   * NOTE (init timing): Google's guidance is to initialize in
   * `application(_:didFinishLaunchingWithOptions:)` so the SDK can resume a
   * session the app was killed during. Calling this from JS is later than
   * that — automatic session *resumption after process death* may be missed
   * until the first initialize of a launch. Documented ceiling, not a bug.
   */
  initialize(receiverApplicationId?: string): Promise<CastConnectionState>

  /**
   * Last known connection state, from the native cache. Never blocks.
   * `'unavailable'` until {@link initialize} has resolved — before init,
   * casting genuinely is not available.
   */
  getCastState(): CastConnectionState

  /**
   * Start device discovery. Discovery is battery-expensive (active mDNS
   * scanning) — scope it to "device picker open", never to app lifetime.
   * Android: `MediaRouter.addCallback` with `CALLBACK_FLAG_REQUEST_DISCOVERY |
   * CALLBACK_FLAG_PERFORM_ACTIVE_SCAN`; iOS: `GCKDiscoveryManager.startDiscovery`.
   */
  startDiscovery(): Promise<void>

  /**
   * Stop device discovery.
   *
   * Ordering rule (hard-won, encoded natively too): connect **after** the
   * picker closes but **before** stopping discovery. If a session start is in
   * flight when this is called, the native side defers the actual teardown
   * until the session start settles, so MediaRouter cannot drop the route
   * mid-handshake even if the JS caller gets the order wrong.
   */
  stopDiscovery(): Promise<void>

  /** Snapshot of currently discovered devices. */
  getDevices(): Promise<CastDeviceInfo[]>

  /**
   * Connect to a device by {@link CastDeviceInfo.id}. Resolves when the
   * session reaches `started`; rejects `[session-start-failed]` when the
   * platform reports failure. Discovery must be running (the id has to come
   * from somewhere) — see {@link stopDiscovery} for the ordering rule.
   */
  requestSession(deviceId: string): Promise<void>

  /**
   * Open the platform's device picker (headless-API path for a cast button).
   *
   * iOS: `GCKCastContext.presentCastDialog()`.
   * Android: the androidx `MediaRouteChooserDialog` over the merged cast
   * selector, from the current Activity. On Android 13+ the *system output
   * switcher* is additionally reachable from any `CastButtonFactory`-wired
   * cast icon (our `CastOptions` enable
   * `setShowSystemOutputSwitcherOnCastIconClick`) and from the media
   * notification — there is no documented public intent for launching the
   * switcher directly, so this method deliberately sticks to documented API.
   *
   * Resolves when the picker is shown (not when a device is picked — watch
   * the session events). Rejects `[invalid-state]` with no foreground
   * Activity (Android).
   *
   * **CEILING (iOS): "shown" is unverifiable.**
   * `-[GCKCastContext presentCastDialog]` returns `void`
   * (GoogleCast 4.8.6, `GCKCastContext+UI.h`) — with no key window the SDK
   * simply does nothing and reports nothing, so iOS always resolves. Android
   * can and does reject. Do not treat a resolved promise as "the user saw a
   * picker" on either platform.
   */
  showCastPicker(): Promise<void>

  /**
   * End the current session.
   *
   * @param stopReceiver `true` stops receiver playback (the transfer-back-to-
   * local flow: snapshot the position from the last media status first);
   * `false` disconnects the sender and leaves the receiver playing.
   * Resolves when the session reaches `ended`.
   */
  endSession(stopReceiver: boolean): Promise<void>

  /* ------------------------------ media ---------------------------------- */

  /**
   * Load a single item (`MediaLoadRequestData` on both platforms — the only
   * non-deprecated load path, and the one that carries credentials).
   * Requires a connected session; rejects `[no-session]` otherwise.
   */
  load(source: CastMediaSource, options: CastLoadOptions): Promise<void>

  play(): Promise<void>
  pause(): Promise<void>
  /** Stops receiver playback and unloads the media (receiver goes `idle`). */
  stop(): Promise<void>

  /** Seek to `position` seconds. */
  seek(position: number, resumeState: CastSeekResumeState): Promise<void>

  /**
   * One approximate-position read, projected by the SDK from the last status
   * update (`RemoteMediaClient.getApproximateStreamPosition` /
   * `GCKRemoteMediaClient.approximateStreamPosition`). This is a *read*, not
   * a stream — position is never polled or streamed across the bridge;
   * clients project locally between `mediaStatus` discontinuities.
   */
  getApproximatePosition(): Promise<number>

  /* ------------------------------ volume --------------------------------- */

  /**
   * Receiver *stream* volume (0..1) — the secondary, app-level layer.
   * Device volume is the primary layer users expect hardware buttons to move.
   */
  setStreamVolume(volume: number): Promise<void>
  setStreamMuted(muted: boolean): Promise<void>

  /**
   * Physical device volume (0..1) — the primary layer. Android:
   * `CastSession.setVolume`; iOS: `GCKCastSession.setDeviceVolume`.
   *
   * **CEILING (iOS): the hardware volume buttons cannot drive it.** The SDK
   * still ships the switch
   * (`GCKCastOptions.physicalVolumeButtonsWillControlDeviceVolume`,
   * `GCKCastOptions.h`, default `NO`), but Google's own iOS sender guide
   * states the behaviour is *"currently not supported for iOS 15+"* because of
   * OS changes
   * (https://developers.google.com/cast/docs/ios_sender/integrate) — so this
   * package deliberately leaves the flag off rather than shipping a switch
   * that does nothing. On Android the cast framework routes the volume keys
   * to the receiver for a connected session. This method is the programmatic
   * path, and on iOS it is the *only* path.
   */
  setDeviceVolume(volume: number): Promise<void>
  setDeviceMuted(muted: boolean): Promise<void>
  getDeviceVolume(): Promise<NativeDeviceVolumeEvent>

  /* ------------------------------ queue ---------------------------------- */

  /**
   * Replace the receiver queue (`MediaLoadRequestData` + `MediaQueueData` on
   * both platforms). Receiver-side advancement (`autoplay` + `preloadTime`
   * per item) is what keeps playback going while the phone sleeps.
   *
   * The receiver queue dies with the session by design; the JS queue stays
   * authoritative and rebuilds it on the next session.
   */
  queueLoad(
    items: CastQueueItemInput[],
    options: CastQueueLoadOptions
  ): Promise<void>

  /** Insert before `beforeItemId`, or append when omitted. */
  queueInsert(items: CastQueueItemInput[], beforeItemId?: number): Promise<void>

  queueRemove(itemIds: number[]): Promise<void>

  /**
   * Reorder `itemIds` (in the given order) to sit before `beforeItemId`, or
   * at the end when omitted.
   */
  queueReorder(itemIds: number[], beforeItemId?: number): Promise<void>

  /** Jump to a queue item, optionally seeking within it. */
  queueJumpTo(itemId: number, position?: number): Promise<void>

  queueSetRepeatMode(mode: CastRepeatMode): Promise<void>

  /** All receiver-assigned item ids, in queue order. Cheap (already cached). */
  getQueueItemIds(): Promise<number[]>

  /**
   * Page `count` rows of the sender-side queue mirror starting at
   * `startIndex`. Resolves immediately with what the cache holds
   * (`resolved: false` rows trigger one background fetch); re-read after the
   * next `queueChanged` event. Deliberately never a chatty per-item RPC.
   */
  fetchQueueSlice(
    startIndex: number,
    count: number
  ): Promise<CastQueueItemSnapshot[]>

  /* ------------------------------ events --------------------------------- */

  addCastStateListener(listener: (event: NativeCastStateEvent) => void): number
  removeCastStateListener(listenerId: number): void

  addSessionListener(listener: (event: NativeCastSessionEvent) => void): number
  removeSessionListener(listenerId: number): void

  addDevicesListener(listener: (event: NativeCastDevicesEvent) => void): number
  removeDevicesListener(listenerId: number): void

  addMediaStatusListener(
    listener: (event: NativeCastMediaStatusEvent) => void
  ): number
  removeMediaStatusListener(listenerId: number): void

  /**
   * Receiver-side media failures. Fires on both platforms — see
   * {@link NativeCastMediaErrorEvent} for how (and for the Android-only
   * detail fields).
   *
   * A single failure reaches JS on two channels (this one and a `mediaStatus`
   * with `idleReason: 'error'`); the `Cast.addListener('error', …)` facade
   * de-duplicates them into one `CastError`. Subscribe to that, not to this,
   * unless you are driving the hybrid object directly.
   */
  addMediaErrorListener(
    listener: (event: NativeCastMediaErrorEvent) => void
  ): number
  removeMediaErrorListener(listenerId: number): void

  addQueueChangedListener(listener: () => void): number
  removeQueueChangedListener(listenerId: number): void

  addDeviceVolumeListener(
    listener: (event: NativeDeviceVolumeEvent) => void
  ): number
  removeDeviceVolumeListener(listenerId: number): void
}
