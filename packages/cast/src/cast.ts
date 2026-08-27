import { NitroModules } from 'react-native-nitro-modules'

import {
  CastError,
  errorFromIdleReason,
  receiverFetchError,
  toCastError,
} from './errors'
import type {
  CastConnectionState,
  CastLoadOptions,
  CastMediaSource,
  CastQueueItemInput,
  CastQueueLoadOptions,
  CastRepeatMode,
  CastSeekResumeState,
  NativeCastMediaErrorEvent,
  NativeCastMediaStatusEvent,
  RnMediaCast,
} from './specs/cast.nitro'
import type {
  CastApi,
  CastEventMap,
  CastEventName,
  CastInitOptions,
  EndSessionOptions,
  Unsubscribe,
} from './types'

/**
 * Build a {@link CastApi} on top of a native hybrid object.
 *
 * Exposed (rather than only the singleton) so the whole facade can be
 * exercised against a fake `RnMediaCast` without a device.
 */
export function createCast(native: RnMediaCast): CastApi {
  /**
   * De-dupes the two native surfaces a single receiver failure arrives on:
   * a `mediaStatus` with `idleReason: 'error'` **and** a media-error callback.
   * Both platforms now produce both — Android's callback is the SDK's own
   * (`RemoteMediaClient.Callback.onMediaError`), iOS's is synthesized natively
   * from the same idle status because `GCKRemoteMediaClientListener` has no
   * media-error callback at all (GoogleCast 4.8.6, `GCKRemoteMediaClient.h`).
   *
   * Contract: **at most one `error` event per idle period, whichever channel
   * arrives first**, reset by any status whose player state is not `idle` (so
   * a retry that fails again is reported again). First-wins is deliberate —
   * emitting twice for one failure would fall the handoff machine back to
   * local twice; the loss is only Android's optional `reason`/`statusCode`
   * detail when the status happens to win the race, and no caller may branch
   * on that detail (see `receiverFetchError`).
   */
  let errorEmittedForCurrentIdle = false

  function deriveError(status: NativeCastMediaStatusEvent): CastError | null {
    if (status.playerState !== 'idle') {
      errorEmittedForCurrentIdle = false
      return null
    }
    if (errorEmittedForCurrentIdle) return null
    const error = errorFromIdleReason(status.idleReason)
    if (error !== null) errorEmittedForCurrentIdle = true
    return error
  }

  function mediaErrorToCastError(
    event: NativeCastMediaErrorEvent
  ): CastError | null {
    if (errorEmittedForCurrentIdle) return null
    errorEmittedForCurrentIdle = true
    return receiverFetchError({
      reason: event.reason,
      statusCode: event.detailedErrorCode,
    })
  }

  function addListener<K extends CastEventName>(
    event: K,
    listener: (payload: CastEventMap[K]) => void
  ): Unsubscribe {
    switch (event) {
      case 'castState': {
        const cb = listener as (payload: CastEventMap['castState']) => void
        const id = native.addCastStateListener((e) => {
          cb({ state: e.state, device: e.device ?? null })
        })
        return once(() => native.removeCastStateListener(id))
      }
      case 'session': {
        const cb = listener as (payload: CastEventMap['session']) => void
        const id = native.addSessionListener((e) => {
          cb(e)
        })
        return once(() => native.removeSessionListener(id))
      }
      case 'devices': {
        const cb = listener as (payload: CastEventMap['devices']) => void
        const id = native.addDevicesListener((e) => {
          cb(e.devices)
        })
        return once(() => native.removeDevicesListener(id))
      }
      case 'mediaStatus': {
        const cb = listener as (payload: CastEventMap['mediaStatus']) => void
        const id = native.addMediaStatusListener((e) => {
          cb(e)
        })
        return once(() => native.removeMediaStatusListener(id))
      }
      case 'error': {
        const cb = listener as (payload: CastEventMap['error']) => void
        // A receiver failure surfaces on two native channels; both feed the
        // one JS event, de-duplicated by `deriveError`'s idle-period latch.
        const statusId = native.addMediaStatusListener((e) => {
          const error = deriveError(e)
          if (error !== null) cb(error)
        })
        const errorId = native.addMediaErrorListener((e) => {
          const error = mediaErrorToCastError(e)
          if (error !== null) cb(error)
        })
        return once(() => {
          native.removeMediaStatusListener(statusId)
          native.removeMediaErrorListener(errorId)
        })
      }
      case 'queueChanged': {
        const cb = listener as () => void
        const id = native.addQueueChangedListener(() => {
          cb()
        })
        return once(() => native.removeQueueChangedListener(id))
      }
      case 'deviceVolume': {
        const cb = listener as (payload: CastEventMap['deviceVolume']) => void
        const id = native.addDeviceVolumeListener((e) => {
          cb(e)
        })
        return once(() => native.removeDeviceVolumeListener(id))
      }
      default:
        // `event` is `never` here — this only fires if a caller from plain JS
        // passes an unknown name. Fail loudly rather than silently no-op.
        throw new CastError(
          'invalid-argument',
          `Unknown event "${String(event)}". Expected one of: castState, ` +
            'session, devices, mediaStatus, error, queueChanged, deviceVolume.'
        )
    }
  }

  /** Route every native rejection through the one error classifier. */
  function wrap<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((error: unknown) => {
      throw toCastError(error)
    })
  }

  return {
    initialize(options?: CastInitOptions): Promise<CastConnectionState> {
      return wrap(native.initialize(options?.receiverApplicationId))
    },
    getCastState(): CastConnectionState {
      return native.getCastState()
    },
    startDiscovery(): Promise<void> {
      return wrap(native.startDiscovery())
    },
    stopDiscovery(): Promise<void> {
      return wrap(native.stopDiscovery())
    },
    getCastDevices() {
      return wrap(native.getDevices())
    },
    requestSession(deviceId?: string): Promise<void> {
      return deviceId === undefined
        ? wrap(native.showCastPicker())
        : wrap(native.requestSession(deviceId))
    },
    endSession(options?: EndSessionOptions): Promise<void> {
      return wrap(native.endSession(options?.transferBackToLocal !== false))
    },

    load(source: CastMediaSource, options?: CastLoadOptions): Promise<void> {
      return wrap(native.load(source, options ?? {}))
    },
    play: () => wrap(native.play()),
    pause: () => wrap(native.pause()),
    stop: () => wrap(native.stop()),
    seek(position: number, resumeState?: CastSeekResumeState): Promise<void> {
      return wrap(native.seek(position, resumeState ?? 'unchanged'))
    },
    getApproximatePosition: () => wrap(native.getApproximatePosition()),

    setStreamVolume: (volume: number) =>
      wrap(native.setStreamVolume(clampVolume(volume))),
    setStreamMuted: (muted: boolean) => wrap(native.setStreamMuted(muted)),
    setDeviceVolume: (volume: number) =>
      wrap(native.setDeviceVolume(clampVolume(volume))),
    setDeviceMuted: (muted: boolean) => wrap(native.setDeviceMuted(muted)),
    getDeviceVolume: () => wrap(native.getDeviceVolume()),

    queueLoad(
      items: ReadonlyArray<CastQueueItemInput>,
      options?: CastQueueLoadOptions
    ): Promise<void> {
      if (items.length === 0) {
        return Promise.reject(
          new CastError(
            'invalid-argument',
            'queueLoad needs at least one item.'
          )
        )
      }
      return wrap(native.queueLoad([...items], options ?? {}))
    },
    queueInsert(
      items: ReadonlyArray<CastQueueItemInput>,
      beforeItemId?: number
    ): Promise<void> {
      if (items.length === 0) {
        return Promise.reject(
          new CastError(
            'invalid-argument',
            'queueInsert needs at least one item.'
          )
        )
      }
      return wrap(native.queueInsert([...items], beforeItemId))
    },
    queueRemove: (itemIds: ReadonlyArray<number>) =>
      wrap(native.queueRemove([...itemIds])),
    queueReorder: (itemIds: ReadonlyArray<number>, beforeItemId?: number) =>
      wrap(native.queueReorder([...itemIds], beforeItemId)),
    queueJumpTo: (itemId: number, position?: number) =>
      wrap(native.queueJumpTo(itemId, position)),
    queueSetRepeatMode: (mode: CastRepeatMode) =>
      wrap(native.queueSetRepeatMode(mode)),
    getQueueItemIds: () => wrap(native.getQueueItemIds()),
    fetchQueueSlice: (startIndex: number, count: number) =>
      wrap(native.fetchQueueSlice(startIndex, count)),

    addListener,
  }
}

/** Volume layers are 0..1 on both platforms; out-of-range is a caller bug we fix rather than forward. */
function clampVolume(volume: number): number {
  if (Number.isNaN(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

/** Makes an unsubscribe function safe to call more than once. */
function once(fn: () => void): Unsubscribe {
  let called = false
  return () => {
    if (called) return
    called = true
    fn()
  }
}

let instance: CastApi | undefined

/**
 * The process-wide cast surface.
 *
 * The native hybrid object is created on first use, not at import time — this
 * keeps `import '@afkcodes/timbre-cast'` free of native side effects (and keeps the
 * module importable in a plain Node/vitest process).
 *
 * A singleton is the deliberate exception to CLAUDE.md principle 5: the OS
 * cast framework (`CastContext` / `GCKCastContext`) is itself a process
 * singleton on both platforms.
 */
export const Cast: CastApi = {
  initialize: (options) => resolveInstance().initialize(options),
  getCastState: () => resolveInstance().getCastState(),
  startDiscovery: () => resolveInstance().startDiscovery(),
  stopDiscovery: () => resolveInstance().stopDiscovery(),
  getCastDevices: () => resolveInstance().getCastDevices(),
  requestSession: (deviceId) => resolveInstance().requestSession(deviceId),
  endSession: (options) => resolveInstance().endSession(options),
  load: (source, options) => resolveInstance().load(source, options),
  play: () => resolveInstance().play(),
  pause: () => resolveInstance().pause(),
  stop: () => resolveInstance().stop(),
  seek: (position, resumeState) =>
    resolveInstance().seek(position, resumeState),
  getApproximatePosition: () => resolveInstance().getApproximatePosition(),
  setStreamVolume: (volume) => resolveInstance().setStreamVolume(volume),
  setStreamMuted: (muted) => resolveInstance().setStreamMuted(muted),
  setDeviceVolume: (volume) => resolveInstance().setDeviceVolume(volume),
  setDeviceMuted: (muted) => resolveInstance().setDeviceMuted(muted),
  getDeviceVolume: () => resolveInstance().getDeviceVolume(),
  queueLoad: (items, options) => resolveInstance().queueLoad(items, options),
  queueInsert: (items, beforeItemId) =>
    resolveInstance().queueInsert(items, beforeItemId),
  queueRemove: (itemIds) => resolveInstance().queueRemove(itemIds),
  queueReorder: (itemIds, beforeItemId) =>
    resolveInstance().queueReorder(itemIds, beforeItemId),
  queueJumpTo: (itemId, position) =>
    resolveInstance().queueJumpTo(itemId, position),
  queueSetRepeatMode: (mode) => resolveInstance().queueSetRepeatMode(mode),
  getQueueItemIds: () => resolveInstance().getQueueItemIds(),
  fetchQueueSlice: (startIndex, count) =>
    resolveInstance().fetchQueueSlice(startIndex, count),
  addListener: (event, listener) =>
    resolveInstance().addListener(event, listener),
}

function resolveInstance(): CastApi {
  instance ??= createCast(
    NitroModules.createHybridObject<RnMediaCast>('RnMediaCast')
  )
  return instance
}
