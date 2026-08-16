import { logSessionError } from './errors'
import type {
  MediaHandler,
  MediaItem,
  MediaRepeatMode,
  RemoteVolumeDirection,
  SessionError,
} from './types'

/**
 * No-op implementation of every {@link MediaHandler} method.
 *
 * Subclass and override only what the app supports; the set the app *advertises*
 * is `PlaybackState.capabilities`, so a no-op here is never reachable from a
 * correctly-broadcasting app — it exists so adding a method to the interface is
 * not a breaking change for every consumer.
 */
export class BaseMediaHandler implements MediaHandler {
  play(): void | Promise<void> {}
  pause(): void | Promise<void> {}
  stop(): void | Promise<void> {}
  seekTo(_position: number): void | Promise<void> {}
  skipToNext(): void | Promise<void> {}
  skipToPrevious(): void | Promise<void> {}
  skipToQueueItem(_index: number): void | Promise<void> {}
  setRate(_rate: number): void | Promise<void> {}
  /**
   * Default: nothing — and unlike the transport methods, doing nothing here is
   * *visible*. The remote surface's repeat button will spring back to whatever
   * the app last broadcast, because the state only moves when the app moves it.
   * That is the same acknowledge-by-broadcast contract every other command
   * follows; it is only more noticeable because the control is a toggle.
   */
  onSetRepeatMode(_mode: MediaRepeatMode): void | Promise<void> {}
  /** Default: nothing. See {@link onSetRepeatMode}. */
  onSetShuffle(_enabled: boolean): void | Promise<void> {}
  /**
   * Default: nothing — and unreachable until the app publishes a remote device
   * with `setRemotePlayback`, so an app whose audio never leaves the phone can
   * ignore these three entirely.
   *
   * With the usual `volumeControl: 'absolute'`, this is also where a **hardware
   * volume key** lands: the library turns the notch into a level first (see
   * {@link onAdjustDeviceVolume}), so an absolute backend needs this method and
   * nothing else.
   */
  onSetDeviceVolume(_volume: number): void | Promise<void> {}
  /**
   * Default: nothing. Only ever called for a `volumeControl: 'relative'`
   * device — see {@link MediaHandler.onAdjustDeviceVolume}.
   */
  onAdjustDeviceVolume(
    _direction: RemoteVolumeDirection
  ): void | Promise<void> {}
  /** Default: nothing. See {@link onSetDeviceVolume}. */
  onSetDeviceMuted(_muted: boolean): void | Promise<void> {}
  onTaskRemoved(): void | Promise<void> {}
  customAction(
    _name: string,
    _extras?: Record<string, unknown>
  ): void | Promise<void> {}
  /**
   * Default: nothing.
   *
   * Correct by design — **the pause has already happened natively** by the time
   * this is called (see {@link MediaHandler.onSleepTimer}), so an app that only
   * wants "stop playing after 30 minutes" needs no code here at all.
   */
  onSleepTimer(): void | Promise<void> {}

  /**
   * Default: nothing.
   *
   * Correct by design — by the time this fires the service has already put the
   * persisted track on screen and the user's `play` is queued for replay on
   * this same handler. Resumption works without a line of code here; the hook
   * exists for logging and for work that must happen before that replayed
   * `play()` (refreshing an expired stream token, say).
   */
  onPlaybackResumption(): void | Promise<void> {}

  /**
   * **The one method here that is not a no-op**, and the exception is the
   * point: every other default is silent because the app advertises what it
   * supports, but a silent default on an *error* channel would swallow the very
   * failures the channel was added to stop swallowing (CLAUDE.md principle 6).
   *
   * So the default logs — the same floor the service applies to a handler that
   * does not implement the method at all. Override it to render the failure;
   * call `super.onSessionError(error)` if you want the log as well.
   */
  onSessionError(error: SessionError): void | Promise<void> {
    logSessionError(error)
  }

  /** Reserved for the Android Auto browse tree. Not invoked in v1. */
  getChildren(_parentId: string): Promise<MediaItem[]> {
    return Promise.resolve([])
  }

  /** Reserved for the Android Auto browse tree. Not invoked in v1. */
  getMediaItem(_id: string): Promise<MediaItem | undefined> {
    return Promise.resolve(undefined)
  }
}

/**
 * Delegating base for handler decorators — analytics, persistence, logging.
 *
 * Every method forwards to `inner`, so a decorator overrides one method, does
 * its work, and calls `super`. Written out longhand rather than with a `Proxy`:
 * the method list is the contract, and a `Proxy` would silently forward methods
 * added to `MediaHandler` later without the decorator author noticing.
 *
 * ```ts
 * class LoggingHandler extends CompositeMediaHandler {
 *   override play() { console.log('play'); return super.play() }
 * }
 * ```
 */
export class CompositeMediaHandler implements MediaHandler {
  constructor(protected readonly inner: MediaHandler) {}

  play(): void | Promise<void> {
    return this.inner.play()
  }
  pause(): void | Promise<void> {
    return this.inner.pause()
  }
  stop(): void | Promise<void> {
    return this.inner.stop()
  }
  seekTo(position: number): void | Promise<void> {
    return this.inner.seekTo(position)
  }
  skipToNext(): void | Promise<void> {
    return this.inner.skipToNext()
  }
  skipToPrevious(): void | Promise<void> {
    return this.inner.skipToPrevious()
  }
  skipToQueueItem(index: number): void | Promise<void> {
    return this.inner.skipToQueueItem(index)
  }
  setRate(rate: number): void | Promise<void> {
    return this.inner.setRate(rate)
  }
  onSetRepeatMode(mode: MediaRepeatMode): void | Promise<void> {
    return this.inner.onSetRepeatMode?.(mode)
  }
  onSetShuffle(enabled: boolean): void | Promise<void> {
    return this.inner.onSetShuffle?.(enabled)
  }
  onSetDeviceVolume(volume: number): void | Promise<void> {
    return this.inner.onSetDeviceVolume?.(volume)
  }
  onAdjustDeviceVolume(
    direction: RemoteVolumeDirection
  ): void | Promise<void> {
    return this.inner.onAdjustDeviceVolume?.(direction)
  }
  onSetDeviceMuted(muted: boolean): void | Promise<void> {
    return this.inner.onSetDeviceMuted?.(muted)
  }
  onTaskRemoved(): void | Promise<void> {
    return this.inner.onTaskRemoved()
  }
  customAction(
    name: string,
    extras?: Record<string, unknown>
  ): void | Promise<void> {
    return this.inner.customAction(name, extras)
  }
  onSleepTimer(): void | Promise<void> {
    return this.inner.onSleepTimer?.()
  }
  onPlaybackResumption(): void | Promise<void> {
    return this.inner.onPlaybackResumption?.()
  }
  /**
   * Forwarded — or logged, when `inner` has no `onSessionError`.
   *
   * The `?.()` every other optional method uses would be a swallow here, and a
   * particularly good hiding place: this class *defines* the method, so the
   * service's own console floor sees a handler that implements the channel and
   * steps back, while the decorator quietly drops the error on the way to an
   * inner handler that never implemented it. Decorating a handler must not be
   * able to silence its errors.
   */
  onSessionError(error: SessionError): void | Promise<void> {
    if (this.inner.onSessionError === undefined) {
      logSessionError(error)
      return
    }
    return this.inner.onSessionError(error)
  }
  getChildren(parentId: string): Promise<MediaItem[]> {
    return this.inner.getChildren(parentId)
  }
  getMediaItem(id: string): Promise<MediaItem | undefined> {
    return this.inner.getMediaItem(id)
  }
}
