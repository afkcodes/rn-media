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
  /**
   * The native sleep timer elapsed.
   *
   * **Playback is already paused when this runs.** The timer fires on a
   * platform timer (`Handler.postDelayed` / `DispatchQueue.main.asyncAfter`),
   * pauses natively on the same path a notification pause takes, and only then
   * calls this — the ordering is deliberate and is the reason the feature is
   * native at all: your `setTimeout` would not have fired (see the README's
   * background-playback limits).
   *
   * So this is where a timer *badge* is cleared, an analytics event is logged,
   * or `stopService()` is called if you would rather end background execution
   * than sit paused. Pausing again here is harmless but redundant.
   *
   * Optional: the pause has already happened natively by the time this fires,
   * so a handler with nothing to add can simply omit it — structural
   * implementors of this interface (the player-agnostic contract) must not
   * break when the library grows an informational callback.
   */
  onSleepTimer?(): void | Promise<void>

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
    /**
     * How long a paused service stays foreground before media3 demotes it, in
     * milliseconds. Omit for media3's default of 10 minutes; `0` demotes
     * immediately.
     *
     * Maps to `MediaSessionService.setForegroundServiceTimeoutMs`. Must be
     * `>= 0`; media3 clamps anything above 600 000 back down to 600 000, so
     * that is the real ceiling. Shorter = the process (and your JS handler)
     * becomes reclaimable sooner after a pause; longer = a resume from the
     * notification is more likely to find everything still alive. Pair a short
     * timeout with `withPersistence`.
     */
    stopForegroundTimeoutMs?: number
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
  /**
   * Broadcast channel 2 of 3: **what is playing right now**. Omit `item` to
   * clear the metadata.
   *
   * ## Channel priority
   * When a queue is in play, this channel and {@link setQueue} both describe the
   * current track, and this one is the more specific statement — it is what you
   * send once the track is actually prepared. So for the **current entry only**,
   * and only when `item.id` matches the id at the broadcast `queueIndex`, this
   * item is merged over the queue entry field by field: a field you set here
   * wins, a field you omit falls back to the queue entry. Every other queue
   * entry is untouched.
   *
   * In practice this is how `duration` reaches the lock screen and the
   * notification: apps rarely know durations for queue items up front, so
   * `setQueue` carries none and the real duration arrives here. Without a
   * duration Android cannot draw a scrubber and iOS treats the track as a live
   * stream.
   *
   * If `item.id` does **not** match the current queue entry, the queue entry
   * wins unchanged (and Android logs a warning) — that combination means the
   * two broadcasts have got out of step.
   */
  setMediaItem(item?: MediaItem): void
  /**
   * Broadcast channel 3 of 3: the whole queue, for controllers that render one.
   *
   * Pair it with `queueIndex` on {@link setPlaybackState} to say which entry is
   * current. Queue entries may be sparse — id and title are usually enough;
   * see {@link setMediaItem} for how the current entry gets enriched.
   */
  setQueue(items: MediaItem[]): void
  /**
   * End background execution. The ONLY thing that does — `pause()` never does
   * (PLAN §5.4). After this resolves, `init` may be called again.
   */
  stopService(): Promise<void>

  /**
   * Pause playback in `seconds`, on a **native** timer. Re-arming replaces any
   * timer already set.
   *
   * Do not build this on `setTimeout`: JS timers freeze once the Activity is
   * gone (and on Samsung even before that), which is precisely when a sleep
   * timer has to work. This one is a main-looper `Handler.postDelayed` on
   * Android and a `DispatchQueue.main.asyncAfter` work item on iOS, so it is
   * unaffected by the React lifecycle.
   *
   * When it fires, playback is paused natively — the same path a notification
   * pause takes — and then {@link MediaHandler.onSleepTimer} is called. The
   * timer does not survive process death, and is cancelled by
   * {@link stopService} and by a dev reload.
   *
   * @param seconds strictly positive and finite.
   * @throws {MediaSessionError} `invalidArgument` for `0`, negatives, `NaN`,
   * `Infinity` or a non-number.
   */
  setSleepTimer(seconds: number): void
  /** Disarm the sleep timer. A no-op when none is armed. */
  cancelSleepTimer(): void
  /**
   * Seconds until the sleep timer fires, or `undefined` when none is armed.
   *
   * Synchronous and cheap — meant to be polled by a visible UI, which is the
   * one place JS timers do work. Read from the platform's own timer clock, so
   * it cannot disagree with when the pause will actually happen.
   */
  getSleepTimerRemaining(): number | undefined
}

export type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaPlaybackStatus,
  PositionAnchor,
}
