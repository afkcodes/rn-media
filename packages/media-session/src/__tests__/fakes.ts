import type {
  MediaSessionConfig,
  MediaSessionHandlers,
  NativeMediaItem,
  NativePlaybackState,
  RnMediaMediaSession,
} from '../specs/media-session.nitro'
import type { MediaHandler, MediaItem, PlaybackState } from '../types'

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

  initialize(
    config: MediaSessionConfig,
    handlers: MediaSessionHandlers
  ): Promise<void> {
    this.configs.push(config)
    if (this.initializeError != null) {
      return Promise.reject(this.initializeError)
    }
    this.handlers = handlers
    return Promise.resolve()
  }

  setPlaybackState(state: NativePlaybackState): void {
    this.playbackStates.push(state)
  }

  setMediaItem(item?: NativeMediaItem): void {
    this.mediaItems.push(item)
  }

  setQueue(items: NativeMediaItem[]): void {
    this.queues.push(items)
  }

  stopService(): Promise<void> {
    this.stopServiceCalls += 1
    if (this.stopServiceError != null) {
      return Promise.reject(this.stopServiceError)
    }
    this.handlers = undefined
    return Promise.resolve()
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
}

/** Records every handler call, in order, with its arguments. */
export class RecordingHandler implements MediaHandler {
  readonly calls: string[] = []

  /** When set, every method returns a promise rejecting with it. */
  rejectWith: Error | undefined
  /** When set, every method throws it synchronously. */
  throwWith: Error | undefined

  private record(call: string): void | Promise<void> {
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
  onTaskRemoved() {
    return this.record('onTaskRemoved')
  }
  customAction(name: string, extras?: Record<string, unknown>) {
    return this.record(`customAction(${name},${JSON.stringify(extras) ?? 'undefined'})`)
  }
  getChildren(parentId: string): Promise<MediaItem[]> {
    this.calls.push(`getChildren(${parentId})`)
    return Promise.resolve([])
  }
  getMediaItem(id: string): Promise<MediaItem | undefined> {
    this.calls.push(`getMediaItem(${id})`)
    return Promise.resolve(undefined)
  }
}

/** A valid minimal media item. */
export function item(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
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
