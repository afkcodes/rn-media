import {
  BROWSE_ROOT,
  capRootTabs,
  errorToNativeBrowseResult,
  rootRejectionMessage,
  toCarConnection,
  toNativeBrowseItem,
  toNativeBrowseResult,
  toSearchFocus,
} from './browse'
import { logSessionError, MediaSessionError } from './errors'
import { getNativeMediaSession } from './native'
import {
  normalizeConfig,
  normalizePlaybackState,
  normalizeRemotePlayback,
  stepRemoteVolume,
  toSessionError,
  validateMediaItem,
  validateQueue,
  validateSleepTimerSeconds,
} from './validate'
import type {
  MediaSessionHandlers,
  NativeBrowseResult,
  NativeRemotePlayback,
  RnMediaMediaSession,
  SessionErrorCode,
} from './specs/media-session.nitro'
import type {
  BrowseItem,
  CarConnection,
  MediaHandler,
  MediaItem,
  MediaServiceApi,
  MediaServiceConfig,
  PlaybackState,
  RemotePlayback,
  RemoteVolumeDirection,
  SleepTimerState,
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

  /**
   * Call `listener` whenever {@link MediaServiceApi.getCarConnection} would
   * start returning something different. Returns the unsubscribe.
   *
   * On the controller rather than in {@link MediaServiceApi} because it is not
   * a session command: it is the plumbing behind the `useCarConnection()` hook,
   * and it deliberately outlives `init`/`stopService` so a component mounted
   * before the session exists still hears the first connection.
   */
  subscribeCarConnection(listener: () => void): () => void
}

type LifecycleState = 'idle' | 'initializing' | 'ready'

function defaultOnHandlerError(
  method: keyof MediaHandler,
  error: unknown
): void {
  console.error(`[media-session] handler.${String(method)}() failed:`, error)
}

/**
 * Build a media service over a native hybrid object.
 *
 * Exported (rather than only the singleton) so the entire fan-in/fan-out
 * pipeline can be exercised against a fake `RnMediaMediaSession` with no
 * device — the same pattern `@afkcodes/timbre-audio-session` uses.
 */
export function createMediaService(
  native: RnMediaMediaSession
): MediaServiceController {
  let state: LifecycleState = 'idle'
  let handler: MediaHandler | undefined
  let onHandlerError = defaultOnHandlerError
  /**
   * The app's `android.onRevivalRequested` callback.
   *
   * Deliberately **not** cleared by `stopService()`: the one moment it exists
   * for is *after* a stop, when the media service was started again (System UI
   * resumption card, media button) into a runtime whose module scope already
   * ran — see the native `MediaSessionHandlers.onRevivalRequested` docs.
   * Replaced by the next `init`; dies with the runtime.
   */
  let revivalCallback: (() => void) | undefined

  /**
   * The remote device last published through `setRemotePlayback`, normalised —
   * or `undefined` while playback is local (the default, and what every app
   * that never calls it stays at forever).
   *
   * Kept here rather than only natively for one reason: it is the base the
   * "adjust" fallback steps from (see {@link adjust}). Holding it in JS keeps
   * that arithmetic pure and unit-testable, and it is a single small value the
   * app just handed us — not state we invented.
   */
  let remotePlayback: NativeRemotePlayback | undefined

  /**
   * The last car-connection state native reported, held as **one object whose
   * identity only changes when the value does**.
   *
   * Not a pass-through to `native.getCarConnection()` on every read, and that
   * is a correctness requirement rather than an optimisation: `useCarConnection`
   * is a `useSyncExternalStore`, whose `getSnapshot` must return a referentially
   * stable value or React re-renders forever. Reading a fresh string from the
   * bridge and widening it into a fresh object would do exactly that.
   */
  let carConnection: CarConnection = { kind: 'none' }

  /**
   * Subscribers to {@link carConnection}. Never cleared by `stopService()`: a
   * screen that mounted before the session existed must still be told when a
   * car arrives, and the listener belongs to the component, not to the session.
   */
  const carListeners = new Set<() => void>()

  function setCarConnection(next: CarConnection): void {
    if (next.kind === carConnection.kind) return
    carConnection = next
    for (const listener of carListeners) {
      try {
        listener()
      } catch (error) {
        // A subscriber that throws must not stop the others from hearing it,
        // and there is no caller to reject to. Same floor as everywhere else.
        console.error('[media-session] car-connection listener threw:', error)
      }
    }
  }

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
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      onHandlerError(
        'customAction',
        new Error(`extras must be a JSON object, got ${raw}`)
      )
      return undefined
    }
    return parsed as Record<string, unknown>
  }

  /**
   * One hardware-key notch, routed by **what the app said its backend is** —
   * `remotePlayback.volumeControl` — and never by which methods happen to be
   * defined on the handler.
   *
   * Presence-sniffing was the obvious implementation and is a trap: every app
   * that extends `BaseMediaHandler` inherits *both* methods, so "does it have
   * `onAdjustDeviceVolume`?" answers yes for a handler that only meant to
   * implement `onSetDeviceVolume`, and the volume keys silently do nothing.
   * The declaration the app already made is unambiguous and total instead:
   *
   * - `absolute` — the backend takes a level, so the notch is turned into one
   *   here (`stepRemoteVolume`, against the last published volume) and
   *   delivered as `onSetDeviceVolume`. Cast, UPnP, essentially everything.
   * - `relative` — the backend only nudges, so the direction goes through
   *   untouched as `onAdjustDeviceVolume`. There is no level to send.
   * - `fixed` — nothing is dispatched. The command is not advertised to media3
   *   either, so this arm should be unreachable; it is written out so that a
   *   surface finding some other way in cannot move a volume the app said it
   *   does not control.
   */
  function adjust(direction: RemoteVolumeDirection): void {
    // Undefined means playback is local, in which case Android is not routing
    // volume keys here at all. Defensive, not expected.
    const remote = remotePlayback
    if (remote === undefined || remote.volumeControl === 'fixed') return
    if (remote.volumeControl === 'relative') {
      dispatch('onAdjustDeviceVolume', (h) =>
        h.onAdjustDeviceVolume?.(direction)
      )
      return
    }
    const next = stepRemoteVolume(
      remote.volume,
      remote.steps,
      direction === 'up' ? 1 : -1
    )
    dispatch('onSetDeviceVolume', (h) => h.onSetDeviceVolume?.(next))
  }

  /**
   * A native failure that had no caller to reject to.
   *
   * Not routed through {@link dispatch} unchanged, for one reason: `dispatch`
   * returns silently when there is no handler, and an *error* channel that goes
   * quiet exactly when the app has torn its session down would re-create the
   * bug this whole channel exists to fix. So the floor is explicit — no
   * handler, or a handler that did not implement the optional method, and it
   * goes to the console (see `logSessionError`).
   *
   * When there *is* a method it goes through `dispatch` like every other
   * command, so a throwing implementation lands on `onHandlerError` and cannot
   * take the session down. `onHandlerError` is not this channel, so the two
   * cannot loop.
   */
  function reportSessionError(code: SessionErrorCode, message: string): void {
    const error = toSessionError(code, message)
    if (handler?.onSessionError === undefined) {
      logSessionError(error)
      return
    }
    dispatch('onSessionError', (h) => h.onSessionError?.(error))
  }

  /**
   * Run one browse pull and turn *any* outcome into a `NativeBrowseResult`.
   *
   * This is the one place in the fan-in that awaits JavaScript, so it is also
   * the one place that can be left hanging by it. It never rejects: a rejection
   * would surface to the car as an unspecified failure, and the honest answers
   * are already enumerated — the items, a {@link BrowseError} the car can draw,
   * or an empty list plus a report on `onHandlerError` for anything else
   * (Google: "return an empty list for no children rather than error codes").
   */
  async function browse(
    method: keyof MediaHandler,
    run: (target: MediaHandler) => Promise<BrowseItem[]>
  ): Promise<NativeBrowseResult> {
    const target = handler
    // No handler: the session is being torn down, or a browser reached a
    // service whose runtime has not initialized yet. An empty tree, never an
    // error — the car retries when `invalidateBrowse`/`notifyChildrenChanged`
    // says there is something to see.
    if (target === undefined) return { items: [] }
    try {
      return toNativeBrowseResult(await run(target))
    } catch (error) {
      const mapped = errorToNativeBrowseResult(error)
      if (mapped !== undefined) return mapped
      onHandlerError(method, error)
      return { items: [] }
    }
  }

  /**
   * The root pull, with the cap both platforms share applied **here** rather
   * than in each native half — see `capRootTabs`. Anything dropped is reported
   * on the session-error channel, never swallowed.
   */
  async function browseRoot(target: MediaHandler): Promise<BrowseItem[]> {
    const { tabs, rejected } = capRootTabs(await target.getChildren(BROWSE_ROOT))
    if (rejected.length > 0) {
      reportSessionError('browseRootRejected', rootRejectionMessage(rejected))
    }
    return tabs
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
    setRepeatMode: (mode) =>
      dispatch('onSetRepeatMode', (h) => h.onSetRepeatMode?.(mode)),
    setShuffle: (enabled) =>
      dispatch('onSetShuffle', (h) => h.onSetShuffle?.(enabled)),
    setDeviceVolume: (volume) =>
      dispatch('onSetDeviceVolume', (h) => h.onSetDeviceVolume?.(volume)),
    increaseDeviceVolume: () => adjust('up'),
    decreaseDeviceVolume: () => adjust('down'),
    setDeviceMuted: (muted) =>
      dispatch('onSetDeviceMuted', (h) => h.onSetDeviceMuted?.(muted)),
    onTaskRemoved: () => dispatch('onTaskRemoved', (h) => h.onTaskRemoved()),
    customAction: (name, extras) => {
      const parsed = parseExtras(extras)
      dispatch('customAction', (h) => h.customAction(name, parsed))
    },
    onSleepTimer: () => dispatch('onSleepTimer', (h) => h.onSleepTimer?.()),
    onPlaybackResumption: () =>
      dispatch('onPlaybackResumption', (h) => h.onPlaybackResumption?.()),
    onRevivalRequested: () => {
      // Only a torn-down session has anything to revive into. `initializing`
      // means a module-scope (cold-boot) init is already racing this signal and
      // will complete the revival by itself; `ready` means there is nothing to
      // do. Both are normal, not errors.
      if (state !== 'idle') return
      const target = revivalCallback
      if (target === undefined) return
      try {
        target()
      } catch (error) {
        // Not routed through `onHandlerError`: that channel is typed to
        // `keyof MediaHandler` and this is a config callback, not a handler —
        // widening the union would break apps that annotated the parameter.
        // Fire-and-forget has no caller left to reject to, so the console is
        // the honest floor (never swallowed).
        console.error(
          '[media-session] android.onRevivalRequested threw:',
          error
        )
      }
    },
    onSessionError: (code, message) => reportSessionError(code, message),

    getChildren: (parentId) =>
      browse('getChildren', (h) =>
        parentId === BROWSE_ROOT ? browseRoot(h) : h.getChildren(parentId)
      ),
    getMediaItem: async (id) => {
      const target = handler
      if (target === undefined) return { items: [] }
      try {
        const item = await target.getMediaItem(id)
        // Zero or one, which is what the bridge's one result shape means here.
        return { items: item === undefined ? [] : [toNativeBrowseItem(item)] }
      } catch (error) {
        const mapped = errorToNativeBrowseResult(error)
        if (mapped !== undefined) return mapped
        onHandlerError('getMediaItem', error)
        return { items: [] }
      }
    },
    search: (query) =>
      // Native only calls this when `setBrowseCapabilities` said the handler
      // has it; the `?? []` covers a handler swapped between the two.
      browse('search', async (h) => (await h.search?.(query)) ?? []),
    playFromMediaId: (id) =>
      dispatch('playFromMediaId', (h) => h.playFromMediaId(id)),
    playFromSearch: (query, focus) =>
      dispatch('playFromSearch', (h) =>
        h.playFromSearch?.(query, toSearchFocus(focus))
      ),
    onCarConnectionChanged: (kind) => setCarConnection(toCarConnection(kind)),
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
      native.setMediaItem(
        item === undefined ? undefined : validateMediaItem(item)
      )
    },

    setQueue(items: MediaItem[]): void {
      assertReady('setQueue()')
      native.setQueue(validateQueue(items))
    },

    setResumptionSnapshot(snapshot?: string): void {
      assertReady('setResumptionSnapshot()')
      // Deliberately unvalidated: the only caller is `withPersistence`, and the
      // string it passes is the record it just serialized. Re-parsing it here
      // to "check" it would cost a JSON round trip on every broadcast to prove
      // something this package produced a line earlier. The native parser is
      // the one that treats it as untrusted, because it reads it back across a
      // process death.
      native.setResumptionSnapshot(snapshot)
    },

    setRemotePlayback(remote?: RemotePlayback): void {
      assertReady('setRemotePlayback()')
      const normalized =
        remote === undefined ? undefined : normalizeRemotePlayback(remote)
      // Only after validation: a rejected call must leave the base the adjust
      // fallback steps from exactly as it was.
      remotePlayback = normalized
      native.setRemotePlayback(normalized)
    },

    setSleepTimer(seconds: number): void {
      assertReady('setSleepTimer()')
      native.setSleepTimer(validateSleepTimerSeconds(seconds))
    },

    setSleepTimerToTrackEnd(): void {
      assertReady('setSleepTimerToTrackEnd()')
      native.setSleepTimerToTrackEnd()
    },

    cancelSleepTimer(): void {
      assertReady('cancelSleepTimer()')
      native.cancelSleepTimer()
    },

    getSleepTimerRemaining(): number | undefined {
      assertReady('getSleepTimerRemaining()')
      return native.getSleepTimerRemaining()
    },

    getSleepTimer(): SleepTimerState | undefined {
      assertReady('getSleepTimer()')
      const timer = native.getSleepTimer()
      if (timer === undefined) return undefined
      // Widened into the discriminated union by hand rather than cast: the
      // bridge struct has an optional `remainingSeconds` for *both* modes
      // because a nitro struct cannot be a union, and the `duration` arm's
      // number is not optional in the API this package publishes.
      return timer.mode === 'duration'
        ? { mode: 'duration', remainingSeconds: timer.remainingSeconds ?? 0 }
        : { mode: 'trackEnd', remainingSeconds: timer.remainingSeconds }
    },

    invalidateBrowse(parentId?: string): void {
      assertReady('invalidateBrowse()')
      native.invalidateBrowse(parentId)
    },

    getCarConnection(): CarConnection {
      // No `assertReady`: this is a question, not a command, and it has an
      // obviously correct answer before `init` — nothing is connected to a
      // session that does not exist yet. Throwing here would make the reactive
      // twin throw during the first render of any screen that uses it.
      return carConnection
    },

    async stopService(): Promise<void> {
      assertReady('stopService()')
      await native.stopService()
      // Only now: a failed stop leaves the session up, and pretending otherwise
      // would let `init()` build a second one on top of it.
      state = 'idle'
      handler = undefined
      onHandlerError = defaultOnHandlerError
      // The session that was routed to a remote device is gone; a later init
      // starts local, exactly like a fresh process.
      remotePlayback = undefined
      // With no session there is nothing for a car to be connected *to*, and
      // native stops reporting. Saying `none` is the honest snapshot; the
      // subscribers stay, because they belong to components, not to sessions.
      setCarConnection({ kind: 'none' })
    },
  }

  return {
    ...api,

    subscribeCarConnection(listener: () => void): () => void {
      carListeners.add(listener)
      return () => carListeners.delete(listener)
    },

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
        // Registered (or replaced) before the native call, and never cleared
        // by `stopService()` — see its declaration for why it must outlive
        // the session it was registered with.
        revivalCallback = config.android?.onRevivalRequested
        remotePlayback = undefined
        const target = handlerFactory()
        handler = target
        // Before `initialize`, deliberately: the session is built inside that
        // call and starts accepting controller connections the moment it
        // exists, and what a browser is granted (`COMMAND_CODE_LIBRARY_SEARCH`,
        // which is the only thing that sets Android Auto's `SEARCH_SUPPORTED`)
        // is decided per connection. Declaring after would race the first
        // browser to connect.
        native.setBrowseCapabilities({
          search: target.search !== undefined,
          playFromSearch: target.playFromSearch !== undefined,
        })
        await native.initialize(nativeConfig, handlers)
        // A car can already be connected when a session is (re)created — an
        // app started from the car, or an `init` after `stopService()` with the
        // head unit still plugged in. Native knows; ask once rather than wait
        // for a transition that has already happened.
        setCarConnection(toCarConnection(native.getCarConnection()))
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
  setResumptionSnapshot: (snapshot) =>
    resolveSingleton().setResumptionSnapshot(snapshot),
  setRemotePlayback: (remote) => resolveSingleton().setRemotePlayback(remote),
  setSleepTimer: (seconds) => resolveSingleton().setSleepTimer(seconds),
  setSleepTimerToTrackEnd: () => resolveSingleton().setSleepTimerToTrackEnd(),
  cancelSleepTimer: () => resolveSingleton().cancelSleepTimer(),
  getSleepTimerRemaining: () => resolveSingleton().getSleepTimerRemaining(),
  getSleepTimer: () => resolveSingleton().getSleepTimer(),
  invalidateBrowse: (parentId) => resolveSingleton().invalidateBrowse(parentId),
  getCarConnection: () => resolveSingleton().getCarConnection(),
  subscribeCarConnection: (listener) =>
    resolveSingleton().subscribeCarConnection(listener),
  stopService: () => resolveSingleton().stopService(),
}
