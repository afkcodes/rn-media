import { MediaSessionError } from './errors'
import { getNativeMediaSession } from './native'
import {
  normalizeConfig,
  normalizePlaybackState,
  validateMediaItem,
  validateQueue,
  validateSleepTimerSeconds,
} from './validate'
import type {
  MediaSessionHandlers,
  RnMediaMediaSession,
} from './specs/media-session.nitro'
import type {
  MediaHandler,
  MediaItem,
  MediaServiceApi,
  MediaServiceConfig,
  PlaybackState,
} from './types'

/** {@link MediaServiceApi} plus the one-time wiring call. */
export interface MediaServiceController extends MediaServiceApi {
  /**
   * Wire `handlerFactory()` to every remote surface and configure the platform.
   *
   * The handler is created *by* the service (rather than passed in) so an app
   * can build it against resources that only exist once the session does —
   * audio_service's `AudioServiceInitializer` shape.
   *
   * @throws {MediaSessionError} `alreadyInitialized` if called twice without an
   * intervening {@link MediaServiceApi.stopService}.
   */
  init(
    handlerFactory: () => MediaHandler,
    config?: MediaServiceConfig
  ): Promise<MediaServiceApi>
}

type LifecycleState = 'idle' | 'initializing' | 'ready'

function defaultOnHandlerError(
  method: keyof MediaHandler,
  error: unknown
): void {
  // eslint-disable-next-line no-console
  console.error(`[media-session] handler.${String(method)}() failed:`, error)
}

/**
 * Build a media service over a native hybrid object.
 *
 * Exported (rather than only the singleton) so the entire fan-in/fan-out
 * pipeline can be exercised against a fake `RnMediaMediaSession` with no
 * device — the same pattern `@rn-media/audio-session` uses.
 */
export function createMediaService(
  native: RnMediaMediaSession
): MediaServiceController {
  let state: LifecycleState = 'idle'
  let handler: MediaHandler | undefined
  let onHandlerError = defaultOnHandlerError

  /**
   * Invoke a handler method and return *now*.
   *
   * The whole point: a remote command must never wait on JS. On Android the
   * caller is a binder/looper thread inside `MediaSessionService` (waiting is
   * an ANR); on iOS it is an `MPRemoteCommandCenter` target (waiting drops the
   * command). The acknowledgement is the app's next `setPlaybackState`.
   */
  function dispatch(
    method: keyof MediaHandler,
    run: (target: MediaHandler) => void | Promise<void>
  ): void {
    const target = handler
    if (target === undefined) return
    try {
      const result = run(target)
      if (result != null && typeof result.then === 'function') {
        result.then(undefined, (error: unknown) => {
          onHandlerError(method, error)
        })
      }
    } catch (error) {
      onHandlerError(method, error)
    }
  }

  /**
   * `extras` crosses the bridge as a JSON object string (see
   * `MediaSessionHandlers.customAction`). Anything that is not a JSON object
   * is a bug on the native side, so it is reported rather than coerced.
   */
  function parseExtras(raw: string): Record<string, unknown> | undefined {
    if (raw === '' || raw === '{}') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      onHandlerError('customAction', error)
      return undefined
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      onHandlerError(
        'customAction',
        new Error(`extras must be a JSON object, got ${raw}`)
      )
      return undefined
    }
    return parsed as Record<string, unknown>
  }

  const handlers: MediaSessionHandlers = {
    play: () => dispatch('play', (h) => h.play()),
    pause: () => dispatch('pause', (h) => h.pause()),
    stop: () => dispatch('stop', (h) => h.stop()),
    seekTo: (position) => dispatch('seekTo', (h) => h.seekTo(position)),
    skipToNext: () => dispatch('skipToNext', (h) => h.skipToNext()),
    skipToPrevious: () => dispatch('skipToPrevious', (h) => h.skipToPrevious()),
    skipToQueueItem: (index) =>
      dispatch('skipToQueueItem', (h) => h.skipToQueueItem(index)),
    setRate: (rate) => dispatch('setRate', (h) => h.setRate(rate)),
    onTaskRemoved: () => dispatch('onTaskRemoved', (h) => h.onTaskRemoved()),
    customAction: (name, extras) => {
      const parsed = parseExtras(extras)
      dispatch('customAction', (h) => h.customAction(name, parsed))
    },
    onSleepTimer: () => dispatch('onSleepTimer', (h) => h.onSleepTimer?.()),
  }

  function assertReady(call: string): void {
    if (state !== 'ready') {
      throw new MediaSessionError(
        'notInitialized',
        `${call} was called before init() resolved. Await MediaService.init(...) first.`
      )
    }
  }

  const api: MediaServiceApi = {
    setPlaybackState(playbackState: PlaybackState): void {
      assertReady('setPlaybackState()')
      native.setPlaybackState(normalizePlaybackState(playbackState))
    },

    setMediaItem(item?: MediaItem): void {
      assertReady('setMediaItem()')
      native.setMediaItem(item === undefined ? undefined : validateMediaItem(item))
    },

    setQueue(items: MediaItem[]): void {
      assertReady('setQueue()')
      native.setQueue(validateQueue(items))
    },

    setSleepTimer(seconds: number): void {
      assertReady('setSleepTimer()')
      native.setSleepTimer(validateSleepTimerSeconds(seconds))
    },

    cancelSleepTimer(): void {
      assertReady('cancelSleepTimer()')
      native.cancelSleepTimer()
    },

    getSleepTimerRemaining(): number | undefined {
      assertReady('getSleepTimerRemaining()')
      return native.getSleepTimerRemaining()
    },

    async stopService(): Promise<void> {
      assertReady('stopService()')
      await native.stopService()
      // Only now: a failed stop leaves the session up, and pretending otherwise
      // would let `init()` build a second one on top of it.
      state = 'idle'
      handler = undefined
      onHandlerError = defaultOnHandlerError
    },
  }

  return {
    ...api,

    async init(
      handlerFactory: () => MediaHandler,
      config: MediaServiceConfig = {}
    ): Promise<MediaServiceApi> {
      if (state !== 'idle') {
        throw new MediaSessionError(
          'alreadyInitialized',
          'init() was already called. Call stopService() before initializing again.'
        )
      }
      // Set synchronously, before the first `await`, so two concurrent init()
      // calls cannot both get past the guard.
      state = 'initializing'
      try {
        const nativeConfig = normalizeConfig(config)
        onHandlerError = config.onHandlerError ?? defaultOnHandlerError
        handler = handlerFactory()
        await native.initialize(nativeConfig, handlers)
        state = 'ready'
        return api
      } catch (error) {
        state = 'idle'
        handler = undefined
        onHandlerError = defaultOnHandlerError
        throw error
      }
    },
  }
}

let singleton: MediaServiceController | undefined

function resolveSingleton(): MediaServiceController {
  singleton ??= createMediaService(getNativeMediaSession())
  return singleton
}

/**
 * The process-wide media session.
 *
 * A singleton because the OS media session is singular — the documented
 * exception to CLAUDE.md principle 5, same as `AudioSession`.
 */
export const MediaService: MediaServiceController = {
  init: (handlerFactory, config) =>
    resolveSingleton().init(handlerFactory, config),
  setPlaybackState: (state) => resolveSingleton().setPlaybackState(state),
  setMediaItem: (item) => resolveSingleton().setMediaItem(item),
  setQueue: (items) => resolveSingleton().setQueue(items),
  setSleepTimer: (seconds) => resolveSingleton().setSleepTimer(seconds),
  cancelSleepTimer: () => resolveSingleton().cancelSleepTimer(),
  getSleepTimerRemaining: () => resolveSingleton().getSleepTimerRemaining(),
  stopService: () => resolveSingleton().stopService(),
}
