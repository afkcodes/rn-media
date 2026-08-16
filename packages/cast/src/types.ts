import type { CastError } from './errors'
import type {
  CastConnectionState,
  CastDeviceInfo,
  CastLoadOptions,
  CastMediaSource,
  CastQueueItemInput,
  CastQueueItemSnapshot,
  CastQueueLoadOptions,
  CastRepeatMode,
  CastSeekResumeState,
  NativeCastMediaStatusEvent,
  NativeCastSessionEvent,
  NativeDeviceVolumeEvent,
} from './specs/cast.nitro'

/** Connection-state change, as the JS layer sees it. */
export interface CastStateEvent {
  readonly state: CastConnectionState
  /** Connected device, or `null` outside a session. */
  readonly device: CastDeviceInfo | null
}

/**
 * Receiver media-status discontinuity. Identical to the bridge struct — the
 * facade re-exposes it under a stable public name so the spec can evolve
 * independently.
 */
export type CastMediaStatus = NativeCastMediaStatusEvent

/** Session lifecycle notification. */
export type CastSessionEvent = NativeCastSessionEvent

/** Physical device volume state. */
export type CastDeviceVolume = NativeDeviceVolumeEvent

/**
 * Payload delivered for each event name. `queueChanged` carries nothing —
 * `void` keeps `() => void` assignable as a listener.
 */
export interface CastEventMap {
  /** The 5-state connection machine moved. */
  castState: CastStateEvent
  /** Raw session lifecycle (finer-grained than `castState`). */
  session: CastSessionEvent
  /** Discovery produced a new device list. */
  devices: ReadonlyArray<CastDeviceInfo>
  /** Receiver status discontinuity — project position locally from here. */
  mediaStatus: CastMediaStatus
  /**
   * A receiver-side failure ({@link CastError} with code
   * `cast-receiver-fetch`), from `idleReason: 'error'` or the SDK's media
   * error callback.
   */
  error: CastError
  /** The sender-side queue mirror changed; re-read any slices you hold. */
  queueChanged: void
  /** Physical device volume moved (the primary volume layer). */
  deviceVolume: CastDeviceVolume
}

export type CastEventName = keyof CastEventMap

/** Removes the listener it was returned from. Idempotent. */
export type Unsubscribe = () => void

export interface CastInitOptions {
  /**
   * Cast receiver application id. Omit for the Default Media Receiver
   * (zero-config; a styled/custom receiver needs registration in the Cast
   * Developer Console). On Android the manifest meta-data (set by the Expo
   * plugin or by hand) is the primary source; this value overrides it at
   * runtime when provided.
   */
  receiverApplicationId?: string
}

export interface EndSessionOptions {
  /**
   * `true` (the transfer-back flow): stop receiver playback — read the last
   * `mediaStatus` position first and resume locally from it. `false`: just
   * disconnect, without transferring playback back to this device.
   *
   * **CEILING on BOTH platforms: `false` cannot leave the receiver
   * *playing* when this phone is the only sender.**
   *
   * Android (cast framework 22.3.1), measured on hardware: every teardown
   * path was tried — `endCurrentSession(false)` with the stop-receiver option
   * on and off, and a raw `MediaRouter.unselect(UNSELECT_REASON_DISCONNECTED)`
   * — and the framework stopped receiver playback on session end every time,
   * even though the receiver itself demonstrably supports last-sender-leave
   * continuation (a bare pychromecast sender's disconnect left the same queue
   * playing).
   *
   * iOS says so in its own header:
   * `-[GCKSessionManager endSessionAndStopCasting:]` documents that the flag
   * *"only applies when multiple sender devices are connected"* and that
   * *"if only one sender device is connected, the receiver app stops casting
   * the media and ignores the `stopCasting` value, even if it's set to
   * `NO`"* (GoogleCast 4.8.6, `GCKSessionManager.h`).
   *
   * What `false` still honestly delivers on both: local playback is not
   * resumed, the receiver app is left to idle out rather than being
   * explicitly stopped, and with *another* sender still attached the receiver
   * does keep playing.
   *
   * @default true
   */
  transferBackToLocal?: boolean
}

/**
 * The public cast surface.
 *
 * Declared as an interface (rather than inferred from the implementation) so
 * tests, and anyone wiring a different backend, can substitute a fake.
 */
export interface CastApi {
  /**
   * Initialize the Cast framework. Resolves the resulting state — a GMS-less
   * Android device resolves `'unavailable'`, it never throws for absence.
   * Idempotent.
   */
  initialize(options?: CastInitOptions): Promise<CastConnectionState>

  /** Last known connection state (cached natively; never blocks). */
  getCastState(): CastConnectionState

  /**
   * Start discovery. Battery-expensive — call when the device picker opens,
   * stop when it closes.
   */
  startDiscovery(): Promise<void>

  /**
   * Stop discovery. Ordering rule: connect (`requestSession`) after the
   * picker closes but *before* calling this — the native side also defers
   * teardown while a session start is in flight, as a belt-and-braces.
   */
  stopDiscovery(): Promise<void>

  /** Snapshot of currently discovered devices. */
  getCastDevices(): Promise<ReadonlyArray<CastDeviceInfo>>

  /**
   * With a `deviceId`: connect to that device; resolves on `started`,
   * rejects with a {@link CastError} (`session-start-failed`) on failure.
   * Without: opens the platform device picker and resolves once it is shown —
   * the user may still cancel, so watch `castState`/`session` events for the
   * outcome.
   */
  requestSession(deviceId?: string): Promise<void>

  /** End the current session. See {@link EndSessionOptions}. */
  endSession(options?: EndSessionOptions): Promise<void>

  /** Load a single item on the receiver. */
  load(source: CastMediaSource, options?: CastLoadOptions): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  /** Stop receiver playback and unload (receiver goes idle). */
  stop(): Promise<void>
  /** Seek to `position` seconds. */
  seek(position: number, resumeState?: CastSeekResumeState): Promise<void>
  /**
   * One approximate-position read (seconds), projected by the SDK from the
   * last status update. Not a stream: project locally between `mediaStatus`
   * events instead of polling this.
   */
  getApproximatePosition(): Promise<number>

  /** Receiver stream volume 0..1 (secondary layer). */
  setStreamVolume(volume: number): Promise<void>
  setStreamMuted(muted: boolean): Promise<void>
  /** Physical device volume 0..1 (primary layer). */
  setDeviceVolume(volume: number): Promise<void>
  setDeviceMuted(muted: boolean): Promise<void>
  getDeviceVolume(): Promise<CastDeviceVolume>

  /** Replace the receiver queue. */
  queueLoad(
    items: ReadonlyArray<CastQueueItemInput>,
    options?: CastQueueLoadOptions
  ): Promise<void>
  /** Insert before `beforeItemId`, or append when omitted. */
  queueInsert(
    items: ReadonlyArray<CastQueueItemInput>,
    beforeItemId?: number
  ): Promise<void>
  queueRemove(itemIds: ReadonlyArray<number>): Promise<void>
  /** Move `itemIds` before `beforeItemId`, or to the end when omitted. */
  queueReorder(
    itemIds: ReadonlyArray<number>,
    beforeItemId?: number
  ): Promise<void>
  queueJumpTo(itemId: number, position?: number): Promise<void>
  queueSetRepeatMode(mode: CastRepeatMode): Promise<void>
  /** All receiver item ids in order (cheap; already cached sender-side). */
  getQueueItemIds(): Promise<ReadonlyArray<number>>
  /**
   * Page the sparse sender-side queue mirror. Unresolved rows
   * (`resolved: false`) trigger one background fetch; re-read after the next
   * `queueChanged` event.
   */
  fetchQueueSlice(
    startIndex: number,
    count: number
  ): Promise<ReadonlyArray<CastQueueItemSnapshot>>

  /** Subscribe to one of the event streams. */
  addListener<K extends CastEventName>(
    event: K,
    listener: (payload: CastEventMap[K]) => void
  ): Unsubscribe
}
