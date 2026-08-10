import type { MediaHandler, MediaItem } from './types'

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
  getChildren(parentId: string): Promise<MediaItem[]> {
    return this.inner.getChildren(parentId)
  }
  getMediaItem(id: string): Promise<MediaItem | undefined> {
    return this.inner.getMediaItem(id)
  }
}
