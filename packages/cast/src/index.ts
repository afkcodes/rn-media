export { Cast, createCast } from './cast'
export { CastButton } from './cast-button'
export { canCastMedia, castabilityTables } from './can-cast'
export { CastError, errorFromIdleReason, toCastError } from './errors'
export {
  initialCastHandoffState,
  projectCastQueue,
  projectReceiverPosition,
  reduceCastHandoff,
} from './handoff-machine'
export { wireCastHandoff } from './handoff'

export type { CanCastInput, CanCastVerdict } from './can-cast'
export type { CastButtonProps } from './cast-button'
export type { CastErrorCode } from './errors'
export type {
  CastHandoffEffect,
  CastHandoffEvent,
  CastHandoffPhase,
  CastHandoffQueueItem,
  CastHandoffQueueSnapshot,
  CastHandoffState,
  CastHandoffTransition,
  CastQueueProjection,
  CastReceiverSnapshot,
  CastTransferEvent,
  SkippedCastItem,
} from './handoff-machine'
export type {
  CastHandoff,
  CastHandoffLocalPlayer,
  WireCastHandoffOptions,
} from './handoff'

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

export type {
  RnMediaCastButton,
  RnMediaCastButtonProps,
} from './specs/cast-button.nitro'
