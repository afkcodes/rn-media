export { Cast, createCast } from './cast'
export { canCastMedia, castabilityTables } from './can-cast'
export { CastError, errorFromIdleReason, toCastError } from './errors'

export type { CanCastInput, CanCastVerdict } from './can-cast'
export type { CastErrorCode } from './errors'

export type {
  CastApi,
  CastDeviceVolume,
  CastEventMap,
  CastEventName,
  CastInitOptions,
  CastMediaStatus,
  CastSessionEvent,
  CastStateEvent,
  EndSessionOptions,
  Unsubscribe,
} from './types'

export type {
  CastConnectionState,
  CastDeviceInfo,
  CastIdleReason,
  CastLoadOptions,
  CastMediaMetadata,
  CastMediaSource,
  CastPlayerState,
  CastQueueItemInput,
  CastQueueItemSnapshot,
  CastQueueLoadOptions,
  CastRepeatMode,
  CastSeekResumeState,
  CastSessionEventType,
  NativeCastDevicesEvent,
  NativeCastMediaErrorEvent,
  NativeCastMediaStatusEvent,
  NativeCastSessionEvent,
  NativeCastStateEvent,
  NativeDeviceVolumeEvent,
  RnMediaCast,
} from './specs/cast.nitro'
