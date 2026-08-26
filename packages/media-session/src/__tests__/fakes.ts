import type {
  MediaSessionConfig,
  MediaSessionHandlers,
  NativeBrowseCapabilities,
  NativeMediaItem,
  NativePlaybackState,
  NativeRemotePlayback,
  NativeSleepTimerState,
  RnMediaMediaSession,
  SessionErrorCode,
  SleepTimerMode,
} from '../specs/media-session.nitro'
import type {
  BrowseItem,
  MediaHandler,
  MediaItem,
  MediaRepeatMode,
  PlaybackState,
  RemoteVolumeDirection,
  SessionError,
} from '../types'

/**
 * In-memory stand-in for the Kotlin/Swift hybrid object.
 *
 * Mirrors the real contract exactly, including the fire-and-forget callback
 * struct, so a test that passes here exercises the wiring that ships. `emit*`
 * plays the part of a notification button / lock-screen press.
 */
export class FakeNativeMediaSession implements RnMediaMediaSession {
  readonly name = 'RnMediaMediaSession'

  readonly configs: MediaSessionConfig[] = []
  readonly playbackStates: NativePlaybackState[] = []
  readonly mediaItems: (NativeMediaItem | undefined)[] = []
  readonly queues: NativeMediaItem[][] = []
  stopServiceCalls = 0

  /** When set, `initialize()` rejects with it. */
  initializeError: Error | undefined
  /** When set, `stopService()` rejects with it. */
  stopServiceError: Error | undefined

  handlers: MediaSessionHandlers | undefined

  /**
   * The one callback the real native side retains **across `stopService`** —
   * mirrors `MediaSessionController.revivalRequester`, which exists precisely
   * for the after-stop window (see the spec's `onRevivalRequested`).
   */
  revivalRequester: (() => void) | undefined

  /** Every `setBrowseCapabilities`, in order. */
  readonly browseCapabilities: NativeBrowseCapabilities[] = []
  /** Every `invalidateBrowse` argument, in order (`undefined` = everything). */
  readonly invalidations: (string | undefined)[] = []
  /** What `getCarConnection()` answers. Set it, then `emitCarConnection`. */
  carConnection = 'none'

  setBrowseCapabilities(caps: NativeBrowseCapabilities): void {
    this.browseCapabilities.push(caps)
  }

  invalidateBrowse(parentId?: string): void {
    this.invalidations.push(parentId)
  }

  getCarConnection(): string {
    return this.carConnection
  }

  /** Play the part of a head unit plugging in or out. */
  emitCarConnection(kind: string): void {
    this.carConnection = kind
    this.emit().onCarConnectionChanged(kind)
  }

  initialize(
    config: MediaSessionConfig,
    handlers: MediaSessionHandlers
  ): Promise<void> {
    this.configs.push(config)
    if (this.initializeError != null) {
      return Promise.reject(this.initializeError)
    }
    this.handlers = handlers
    // Captured like the Kotlin controller captures it: at initialize, before
    // anything async, and independently of `handlers`' own lifetime.
    this.revivalRequester = handlers.onRevivalRequested
    return Promise.resolve()
  }

  setPlaybackState(state: NativePlaybackState): void {
    this.playbackStates.push(state)
  }

  setMediaItem(mediaItem?: NativeMediaItem): void {
    this.mediaItems.push(mediaItem)
  }

  setQueue(items: NativeMediaItem[]): void {
    this.queues.push(items)
  }

  /** Every `setResumptionSnapshot` payload, in order — the native mirror. */
  readonly resumptionSnapshots: (string | undefined)[] = []

  setResumptionSnapshot(snapshot?: string): void {
    this.resumptionSnapshots.push(snapshot)
  }

  /** Every `setRemotePlayback` payload, in order. `undefined` = back to local. */
  readonly remotePlaybacks: (NativeRemotePlayback | undefined)[] = []

  setRemotePlayback(remote?: NativeRemotePlayback): void {
    this.remotePlaybacks.push(remote)
  }

  /* --- Sleep timer: a fake platform timer, driven by `fireSleepTimer()` --- */

  /** Every `setSleepTimer` argument, in order. */
  readonly sleepTimers: number[] = []
  setSleepTimerToTrackEndCalls = 0
  cancelSleepTimerCalls = 0
  /** What `getSleepTimerRemaining()` reports. Armed by `setSleepTimer`. */
  private remaining: number | undefined
  private mode: SleepTimerMode | undefined

  setSleepTimer(seconds: number): void {
    this.sleepTimers.push(seconds)
    this.remaining = seconds
    this.mode = 'duration'
  }

  /**
   * The fake stands in for a native timer that computes its own deadline from
   * the broadcasts, so it arms with *no* remaining — which is also the case the
   * structured `getSleepTimer()` exists to make expressible. Tests that want a
   * deadline set {@link trackEndRemaining}.
   */
  setSleepTimerToTrackEnd(): void {
    this.setSleepTimerToTrackEndCalls += 1
    this.remaining = this.trackEndRemaining
    this.mode = 'trackEnd'
  }

  /** What a `trackEnd` timer reports as remaining, if anything. */
  trackEndRemaining: number | undefined

  cancelSleepTimer(): void {
    this.cancelSleepTimerCalls += 1
    this.remaining = undefined
    this.mode = undefined
  }

  getSleepTimerRemaining(): number | undefined {
    return this.remaining
  }

  getSleepTimer(): NativeSleepTimerState | undefined {
    if (this.mode === undefined) return undefined
    return { mode: this.mode, remainingSeconds: this.remaining }
  }

  /** Test driver: "the platform timer elapsed". Mirrors the native ordering. */
  fireSleepTimer(): void {
    this.remaining = undefined
    this.mode = undefined
    this.emit().onSleepTimer()
  }

  stopService(): Promise<void> {
    this.stopServiceCalls += 1
    if (this.stopServiceError != null) {
      return Promise.reject(this.stopServiceError)
    }
    // `revivalRequester` deliberately survives — same as the Kotlin side.
    this.handlers = undefined
    return Promise.resolve()
  }

  /**
   * Play the part of `RnMediaMediaSessionService.onRuntimeReady`: a revival
   * began and the service is asking the (still-alive) runtime to re-init.
   * Legal after `stopService()` — that is the whole point.
   */
  emitRevivalRequested(): void {
    const requester = this.revivalRequester
    if (requester === undefined) {
      throw new Error('[test] emitRevivalRequested() before initialize().')
    }
    requester()
  }

  // --- HybridObject surface (unused by this package, present for the type) ---

  toString(): string {
    return '[HybridObject RnMediaMediaSession]'
  }

  equals(other: RnMediaMediaSession): boolean {
    return this === other
  }

  dispose(): void {
    this.handlers = undefined
  }

  // --- Test drivers: "the user pressed a button on a remote surface" ---

  get last(): {
    playbackState: NativePlaybackState | undefined
    mediaItem: NativeMediaItem | undefined
    queue: NativeMediaItem[] | undefined
  } {
    return {
      playbackState: this.playbackStates.at(-1),
      mediaItem: this.mediaItems.at(-1),
      queue: this.queues.at(-1),
    }
  }

  emit(): MediaSessionHandlers {
    if (this.handlers === undefined) {
      throw new Error('[test] emit() before initialize() resolved.')
    }
    return this.handlers
  }

  /**
   * Play the part of native reporting a failure nobody was waiting on — a
   * refused foreground service, an artwork download that came back empty.
   */
  emitSessionError(code: SessionErrorCode, message = 'something failed'): void {
    this.emit().onSessionError(code, message)
  }
}

/** Records every handler call, in order, with its arguments. */
export class RecordingHandler implements MediaHandler {
  readonly calls: string[] = []

  /** When set, every method returns a promise rejecting with it. */
  rejectWith: Error | undefined
  /** When set, every method throws it synchronously. */
  throwWith: Error | undefined

  protected record(call: string): void | Promise<void> {
    this.calls.push(call)
    if (this.throwWith != null) throw this.throwWith
    if (this.rejectWith != null) return Promise.reject(this.rejectWith)
  }

  play() {
    return this.record('play')
  }
  pause() {
    return this.record('pause')
  }
  stop() {
    return this.record('stop')
  }
  seekTo(position: number) {
    return this.record(`seekTo(${position})`)
  }
  skipToNext() {
    return this.record('skipToNext')
  }
  skipToPrevious() {
    return this.record('skipToPrevious')
  }
  skipToQueueItem(index: number) {
    return this.record(`skipToQueueItem(${index})`)
  }
  setRate(rate: number) {
    return this.record(`setRate(${rate})`)
  }
  onSetRepeatMode(mode: MediaRepeatMode) {
    return this.record(`onSetRepeatMode(${mode})`)
  }
  onSetShuffle(enabled: boolean) {
    return this.record(`onSetShuffle(${enabled})`)
  }
  onSetDeviceVolume(volume: number) {
    return this.record(`onSetDeviceVolume(${volume})`)
  }
  onAdjustDeviceVolume(direction: RemoteVolumeDirection) {
    return this.record(`onAdjustDeviceVolume(${direction})`)
  }
  onSetDeviceMuted(muted: boolean) {
    return this.record(`onSetDeviceMuted(${muted})`)
  }
  onTaskRemoved() {
    return this.record('onTaskRemoved')
  }
  onSleepTimer() {
    return this.record('onSleepTimer')
  }
  onPlaybackResumption() {
    return this.record('onPlaybackResumption')
  }
  /** Every session error, in order — the payload, not just the call. */
  readonly sessionErrors: SessionError[] = []
  onSessionError(error: SessionError) {
    this.sessionErrors.push(error)
    return this.record(`onSessionError(${error.code})`)
  }
  customAction(name: string, extras?: Record<string, unknown>) {
    return this.record(
      `customAction(${name},${JSON.stringify(extras) ?? 'undefined'})`
    )
  }
  /** What {@link getChildren} answers, keyed by parent id. */
  readonly children = new Map<string, BrowseItem[]>()
  /** When set, every browse method rejects with it. */
  browseRejectWith: unknown

  getChildren(parentId: string): Promise<BrowseItem[]> {
    this.calls.push(`getChildren(${parentId})`)
    if (this.browseRejectWith != null) {
      return Promise.reject(this.browseRejectWith)
    }
    return Promise.resolve(this.children.get(parentId) ?? [])
  }
  getMediaItem(id: string): Promise<BrowseItem | undefined> {
    this.calls.push(`getMediaItem(${id})`)
    if (this.browseRejectWith != null) {
      return Promise.reject(this.browseRejectWith)
    }
    return Promise.resolve(
      [...this.children.values()].flat().find((child) => child.id === id)
    )
  }
  playFromMediaId(id: string) {
    return this.record(`playFromMediaId(${id})`)
  }
}

/**
 * A handler that also answers voice and search — separate from
 * {@link RecordingHandler} because the *absence* of these two methods is what
 * the capability declaration is made of, and one class cannot demonstrate both.
 */
export class SearchingHandler extends RecordingHandler {
  readonly results: BrowseItem[] = []

  playFromSearch(query: string, focus: { kind: string }) {
    return this.record(`playFromSearch(${query},${focus.kind})`)
  }
  search(query: string): Promise<BrowseItem[]> {
    this.calls.push(`search(${query})`)
    if (this.browseRejectWith != null) {
      return Promise.reject(this.browseRejectWith)
    }
    return Promise.resolve(this.results)
  }
}

/** A valid minimal browse node. */
export function browseItem(
  id: string,
  overrides: Partial<BrowseItem> = {}
): BrowseItem {
  return { id, title: `Node ${id}`, ...overrides }
}

/** A valid minimal media item. */
export function item(
  id: string,
  overrides: Partial<MediaItem> = {}
): MediaItem {
  return { id, title: `Title ${id}`, ...overrides }
}

/** A valid minimal playback state, anchored at a fixed instant. */
export function playbackState(
  overrides: Partial<PlaybackState> = {}
): PlaybackState {
  return {
    status: 'playing',
    position: { value: 1000, at: 1_700_000_000_000, rate: 1 },
    ...overrides,
  }
}
