import type {
  CastConnectionState,
  CastLoadOptions,
  CastMediaSource,
  CastQueueItemInput,
  CastQueueItemSnapshot,
  CastQueueLoadOptions,
  CastRepeatMode,
  CastSeekResumeState,
  CastDeviceInfo,
  NativeCastDevicesEvent,
  NativeCastMediaErrorEvent,
  NativeCastMediaStatusEvent,
  NativeCastSessionEvent,
  NativeCastStateEvent,
  NativeDeviceVolumeEvent,
  RnMediaCast,
} from '../specs/cast.nitro'

/**
 * In-memory stand-in for the Kotlin/Swift hybrid object.
 *
 * Mirrors the real contract exactly — id-based listener registration, the
 * `[code] message` rejection prefix, the lot — so a test that passes here is
 * testing the same wiring that ships.
 */
export class FakeNativeCast implements RnMediaCast {
  readonly name = 'RnMediaCast'

  /** Call log: `[methodName, ...args]` in call order. */
  readonly calls: Array<[string, ...unknown[]]> = []

  initializeResult: CastConnectionState = 'idle'
  castState: CastConnectionState = 'idle'
  devices: CastDeviceInfo[] = []
  approximatePosition = 0
  deviceVolume: NativeDeviceVolumeEvent = { volume: 0.5, muted: false }
  queueItemIds: number[] = []
  queueSlice: CastQueueItemSnapshot[] = []
  /** When set, every command method rejects with `Error(rejectWith)`. */
  rejectWith: string | undefined
  /** When set, the named command's promise never settles (hung PendingResult). */
  hangCommand: string | undefined

  private nextId = 1
  private readonly castStateListeners = new Map<
    number,
    (event: NativeCastStateEvent) => void
  >()
  private readonly sessionListeners = new Map<
    number,
    (event: NativeCastSessionEvent) => void
  >()
  private readonly devicesListeners = new Map<
    number,
    (event: NativeCastDevicesEvent) => void
  >()
  private readonly mediaStatusListeners = new Map<
    number,
    (event: NativeCastMediaStatusEvent) => void
  >()
  private readonly mediaErrorListeners = new Map<
    number,
    (event: NativeCastMediaErrorEvent) => void
  >()
  private readonly queueChangedListeners = new Map<number, () => void>()
  private readonly deviceVolumeListeners = new Map<
    number,
    (event: NativeDeviceVolumeEvent) => void
  >()

  // ---- emit helpers for tests ----

  emitCastState(event: NativeCastStateEvent): void {
    this.castStateListeners.forEach((cb) => cb(event))
  }
  emitSession(event: NativeCastSessionEvent): void {
    this.sessionListeners.forEach((cb) => cb(event))
  }
  emitDevices(event: NativeCastDevicesEvent): void {
    this.devicesListeners.forEach((cb) => cb(event))
  }
  emitMediaStatus(event: NativeCastMediaStatusEvent): void {
    this.mediaStatusListeners.forEach((cb) => cb(event))
  }
  emitMediaError(event: NativeCastMediaErrorEvent): void {
    this.mediaErrorListeners.forEach((cb) => cb(event))
  }
  emitQueueChanged(): void {
    this.queueChangedListeners.forEach((cb) => cb())
  }
  emitDeviceVolume(event: NativeDeviceVolumeEvent): void {
    this.deviceVolumeListeners.forEach((cb) => cb(event))
  }

  listenerCounts(): Record<string, number> {
    return {
      castState: this.castStateListeners.size,
      session: this.sessionListeners.size,
      devices: this.devicesListeners.size,
      mediaStatus: this.mediaStatusListeners.size,
      mediaError: this.mediaErrorListeners.size,
      queueChanged: this.queueChangedListeners.size,
      deviceVolume: this.deviceVolumeListeners.size,
    }
  }

  // ---- spec ----

  initialize(receiverApplicationId?: string): Promise<CastConnectionState> {
    this.calls.push(['initialize', receiverApplicationId])
    return Promise.resolve(this.initializeResult)
  }

  getCastState(): CastConnectionState {
    return this.castState
  }

  startDiscovery(): Promise<void> {
    return this.command('startDiscovery')
  }
  stopDiscovery(): Promise<void> {
    return this.command('stopDiscovery')
  }
  getDevices(): Promise<CastDeviceInfo[]> {
    this.calls.push(['getDevices'])
    return Promise.resolve(this.devices)
  }
  requestSession(deviceId: string): Promise<void> {
    return this.command('requestSession', deviceId)
  }
  showCastPicker(): Promise<void> {
    return this.command('showCastPicker')
  }
  endSession(stopReceiver: boolean): Promise<void> {
    return this.command('endSession', stopReceiver)
  }

  load(source: CastMediaSource, options: CastLoadOptions): Promise<void> {
    return this.command('load', source, options)
  }
  play(): Promise<void> {
    return this.command('play')
  }
  pause(): Promise<void> {
    return this.command('pause')
  }
  stop(): Promise<void> {
    return this.command('stop')
  }
  seek(position: number, resumeState: CastSeekResumeState): Promise<void> {
    return this.command('seek', position, resumeState)
  }
  getApproximatePosition(): Promise<number> {
    this.calls.push(['getApproximatePosition'])
    return Promise.resolve(this.approximatePosition)
  }

  setStreamVolume(volume: number): Promise<void> {
    return this.command('setStreamVolume', volume)
  }
  setStreamMuted(muted: boolean): Promise<void> {
    return this.command('setStreamMuted', muted)
  }
  setDeviceVolume(volume: number): Promise<void> {
    return this.command('setDeviceVolume', volume)
  }
  setDeviceMuted(muted: boolean): Promise<void> {
    return this.command('setDeviceMuted', muted)
  }
  getDeviceVolume(): Promise<NativeDeviceVolumeEvent> {
    this.calls.push(['getDeviceVolume'])
    return Promise.resolve(this.deviceVolume)
  }

  queueLoad(
    items: CastQueueItemInput[],
    options: CastQueueLoadOptions
  ): Promise<void> {
    return this.command('queueLoad', items, options)
  }
  queueInsert(
    items: CastQueueItemInput[],
    beforeItemId?: number
  ): Promise<void> {
    return this.command('queueInsert', items, beforeItemId)
  }
  queueRemove(itemIds: number[]): Promise<void> {
    return this.command('queueRemove', itemIds)
  }
  queueReorder(itemIds: number[], beforeItemId?: number): Promise<void> {
    return this.command('queueReorder', itemIds, beforeItemId)
  }
  queueJumpTo(itemId: number, position?: number): Promise<void> {
    return this.command('queueJumpTo', itemId, position)
  }
  queueSetRepeatMode(mode: CastRepeatMode): Promise<void> {
    return this.command('queueSetRepeatMode', mode)
  }
  getQueueItemIds(): Promise<number[]> {
    this.calls.push(['getQueueItemIds'])
    return Promise.resolve(this.queueItemIds)
  }
  fetchQueueSlice(
    startIndex: number,
    count: number
  ): Promise<CastQueueItemSnapshot[]> {
    this.calls.push(['fetchQueueSlice', startIndex, count])
    return Promise.resolve(this.queueSlice)
  }

  addCastStateListener(
    listener: (event: NativeCastStateEvent) => void
  ): number {
    return this.register(this.castStateListeners, listener)
  }
  removeCastStateListener(listenerId: number): void {
    this.castStateListeners.delete(listenerId)
  }
  addSessionListener(
    listener: (event: NativeCastSessionEvent) => void
  ): number {
    return this.register(this.sessionListeners, listener)
  }
  removeSessionListener(listenerId: number): void {
    this.sessionListeners.delete(listenerId)
  }
  addDevicesListener(
    listener: (event: NativeCastDevicesEvent) => void
  ): number {
    return this.register(this.devicesListeners, listener)
  }
  removeDevicesListener(listenerId: number): void {
    this.devicesListeners.delete(listenerId)
  }
  addMediaStatusListener(
    listener: (event: NativeCastMediaStatusEvent) => void
  ): number {
    return this.register(this.mediaStatusListeners, listener)
  }
  removeMediaStatusListener(listenerId: number): void {
    this.mediaStatusListeners.delete(listenerId)
  }
  addMediaErrorListener(
    listener: (event: NativeCastMediaErrorEvent) => void
  ): number {
    return this.register(this.mediaErrorListeners, listener)
  }
  removeMediaErrorListener(listenerId: number): void {
    this.mediaErrorListeners.delete(listenerId)
  }
  addQueueChangedListener(listener: () => void): number {
    return this.register(this.queueChangedListeners, listener)
  }
  removeQueueChangedListener(listenerId: number): void {
    this.queueChangedListeners.delete(listenerId)
  }
  addDeviceVolumeListener(
    listener: (event: NativeDeviceVolumeEvent) => void
  ): number {
    return this.register(this.deviceVolumeListeners, listener)
  }
  removeDeviceVolumeListener(listenerId: number): void {
    this.deviceVolumeListeners.delete(listenerId)
  }

  // ---- HybridObject housekeeping ----

  equals(other: RnMediaCast): boolean {
    return this === other
  }

  dispose(): void {
    // Nothing native to release.
  }

  // ---- internals ----

  private register<T>(into: Map<number, T>, listener: T): number {
    const id = this.nextId++
    into.set(id, listener)
    return id
  }

  private command(name: string, ...args: unknown[]): Promise<void> {
    this.calls.push([name, ...args])
    if (this.hangCommand === name) {
      // A PendingResult that never settles — the device-observed shape of a
      // queueLoad issued against a just-rejoined session.
      return new Promise<void>(() => undefined)
    }
    return this.rejectWith != null
      ? Promise.reject(new Error(this.rejectWith))
      : Promise.resolve()
  }
}

/** A plausible playing status; spread-and-override in tests. */
export function playingStatus(
  overrides: Partial<NativeCastMediaStatusEvent> = {}
): NativeCastMediaStatusEvent {
  return {
    playerState: 'playing',
    idleReason: 'none',
    position: 12.5,
    duration: 180,
    playbackRate: 1,
    streamVolume: 0.8,
    streamMuted: false,
    repeatMode: 'off',
    currentItemId: 3,
    queueItemCount: 5,
    ...overrides,
  }
}
