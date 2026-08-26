import { logSessionError } from './errors'
import { toSessionError } from './validate'
import type {
  BrowseItem,
  MediaHandler,
  MediaRepeatMode,
  RemoteVolumeDirection,
  SearchFocus,
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

  /**
   * Default: an empty tree.
   *
   * Correct by construction rather than by luck: an empty list is what Google
   * asks a browse node with no children to return, so an app that never
   * implements this shows a car an app with nothing in it — not an error, not a
   * crash, and not a browse entry that does nothing when tapped.
   */
  getChildren(_parentId: string): Promise<BrowseItem[]> {
    return Promise.resolve([])
  }

  /** Default: no such item. See {@link getChildren}. */
  getMediaItem(_id: string): Promise<BrowseItem | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * **The second method here that is not a no-op**, and for the same reason
   * {@link onSessionError} is the first: the default that would be silent is
   * the bug.
   *
   * A handler that overrides `getChildren` and forgets this one hands a car a
   * full browse tree in which every single leaf does nothing when tapped —
   * no error, no log, no playback (ARCHITECTURE §27). There is nothing this
   * class can play on the app's behalf, so it says so on the channel the app
   * already reads.
   *
   * Overriding it silences the report, which is the point: implementing the
   * method *is* the fix.
   */
  playFromMediaId(id: string): void | Promise<void> {
    return this.onSessionError(
      toSessionError(
        'playFromMediaIdUnhandled',
        `A car or voice assistant asked to play browse item "${id}", but this ` +
          'MediaHandler does not implement playFromMediaId(id), so the tap did ' +
          'nothing. Implement it: build the queue around that id, broadcast it, ' +
          'and start playback.'
      )
    )
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
  /**
   * Present **iff the wrapped handler has it** — properties rather than
   * methods, and assigned in the constructor, for a reason that is invisible
   * until a car is in front of you.
   *
   * These two are *capability declarations*: `MediaService.init` reads the
   * decorated handler to decide whether the session advertises a search tab
   * (`COMMAND_CODE_LIBRARY_SEARCH`, which is the only thing that sets Android
   * Auto's `SEARCH_SUPPORTED`) and whether voice playback is answerable. A
   * decorator that *defined* them the way it defines `play` would advertise a
   * search the app underneath cannot answer, and the car would draw an empty
   * search tab instead of no search tab. A method declaration cannot be
   * conditional; a property assignment can.
   */
  readonly playFromSearch?: (
    query: string,
    focus: SearchFocus
  ) => void | Promise<void>
  /** See {@link playFromSearch}. */
  readonly search?: (query: string) => Promise<BrowseItem[]>

  constructor(protected readonly inner: MediaHandler) {
    const playFromSearch = inner.playFromSearch
    if (playFromSearch !== undefined) {
      this.playFromSearch = (query, focus) =>
        playFromSearch.call(inner, query, focus)
    }
    const search = inner.search
    if (search !== undefined) {
      this.search = (query) => search.call(inner, query)
    }
  }

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
  getChildren(parentId: string): Promise<BrowseItem[]> {
    return this.inner.getChildren(parentId)
  }
  getMediaItem(id: string): Promise<BrowseItem | undefined> {
    return this.inner.getMediaItem(id)
  }
  playFromMediaId(id: string): void | Promise<void> {
    return this.inner.playFromMediaId(id)
  }
}
