import type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  NativeMediaItem,
  PositionAnchor,
} from './specs/media-session.nitro'

/**
 * Metadata for one playable thing.
 *
 * Structurally identical to the bridge struct — there is nothing to narrow, so
 * aliasing beats maintaining a parallel type.
 */
export type MediaItem = NativeMediaItem

/**
 * The broadcast playback state, as the app writes it.
 *
 * Differs from the bridge's `NativePlaybackState` only in optionality:
 * `controls`, `capabilities` and `customActions` default to empty here, because
 * "no buttons" is a perfectly ordinary state and `[]` is noise at the call
 * site. {@link normalizePlaybackState} fills them in.
 */
export interface PlaybackState {
  status: MediaPlaybackStatus
  /**
   * Position anchor — `{ value, at, rate }`. Broadcast on discontinuities only;
   * every surface projects locally. See {@link PositionAnchor}.
   */
  position: PositionAnchor
  /** Buffered position in ms; omit when unknown. */
  bufferedPosition?: number
  /** Buttons to offer, in order. @default [] */
  controls?: MediaControl[]
  /** Commands to accept. @default [] */
  capabilities?: MediaCapability[]
  /** @default [] */
  customActions?: MediaCustomAction[]
  /**
   * Android: which of {@link controls} occupy the ≤3 collapsed notification
   * slots. Omit to take the first three.
   */
  compactControlIndices?: number[]
  /** Index into the last broadcast queue, or `-1`/omitted when not queue-backed. */
  queueIndex?: number
  /** Only meaningful when `status === 'error'`. */
  errorMessage?: string
}

/**
 * The fan-in interface. Every remote surface — notification, lock screen,
 * Bluetooth, headset, watch, Android Auto, Control Center, and the app's own
 * UI — arrives here.
 *
 * Every method may return a promise; the session dispatches and returns
 * immediately, so a slow handler can never ANR the OS. A rejected promise is
 * reported through `MediaServiceConfig.onHandlerError`, never swallowed.
 */
export interface MediaHandler {
  play(): void | Promise<void>
  pause(): void | Promise<void>
  /** Release resources. Does NOT end background execution — call `stopService()` for that. */
  stop(): void | Promise<void>
  /** @param position milliseconds */
  seekTo(position: number): void | Promise<void>
  skipToNext(): void | Promise<void>
  skipToPrevious(): void | Promise<void>
  /** @param index index into the last broadcast queue */
  skipToQueueItem(index: number): void | Promise<void>
  setRate(rate: number): void | Promise<void>
  /**
   * Android only: the app's task was swiped out of Recents.
   *
   * The native default policy (keep playing if playing, otherwise stop the
   * service) has already been decided by the time this runs — overriding this
   * method is for side effects (persistence, analytics), not for changing that
   * decision. Call `stopService()` here to force a stop.
   */
  onTaskRemoved(): void | Promise<void>
  customAction(
    name: string,
    extras?: Record<string, unknown>
  ): void | Promise<void>

  /* --- Android Auto / CarPlay browse: reserved, not wired to native in v1 --- */

  /**
   * Reserved for the media3 browse tree (`MediaLibraryService`). Not invoked in
   * v1 — the native `MediaLibrarySession.Callback` returns an empty root.
   */
  getChildren(parentId: string): Promise<MediaItem[]>
  /** Reserved. See {@link getChildren}. */
  getMediaItem(id: string): Promise<MediaItem | undefined>
}

/** Configuration accepted by `MediaService.init`. */
export interface MediaServiceConfig {
  android?: {
    notificationChannelId: string
    notificationChannelName: string
    /** Drawable resource name in the consumer app, e.g. `'ic_notification'`. */
    notificationIcon?: string
    /**
     * `stopForeground(STOP_FOREGROUND_DETACH)` on pause: notification survives,
     * service is demoted and therefore killable.
     *
     * @default true
     */
    stopForegroundOnPause?: boolean
  }
  ios?: {
    /** Decoded-artwork cache capacity. @default 8 */
    artworkCacheSize?: number
  }
  /**
   * Called when a handler method throws or rejects. Defaults to `console.error`.
   * There is no other place for the error to go — handler invocations are
   * fire-and-forget by design.
   */
  onHandlerError?: (method: keyof MediaHandler, error: unknown) => void
}

/** The broadcast + lifecycle surface returned by `MediaService.init`. */
export interface MediaServiceApi {
  /** Broadcast channel 1 of 3. */
  setPlaybackState(state: PlaybackState): void
  /** Broadcast channel 2 of 3. Omit `item` to clear the metadata. */
  setMediaItem(item?: MediaItem): void
  /** Broadcast channel 3 of 3. */
  setQueue(items: MediaItem[]): void
  /**
   * End background execution. The ONLY thing that does — `pause()` never does
   * (PLAN §5.4). After this resolves, `init` may be called again.
   */
  stopService(): Promise<void>
}

export type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  PositionAnchor,
}
