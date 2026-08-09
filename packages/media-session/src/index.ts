export { MediaSessionError } from './errors'
export type { MediaSessionErrorCode } from './errors'

export { BaseMediaHandler, CompositeMediaHandler } from './handler'

export { QueueHandler, withQueueHandling } from './queue-handler'
export type {
  QueueBroadcaster,
  QueueHandlerMethods,
  QueueHandlerOptions,
} from './queue-handler'

export { createMediaService, MediaService } from './media-service'
export type { MediaServiceController } from './media-service'

export {
  DEFAULT_STOP_FOREGROUND_ON_PAUSE,
  MAX_COMPACT_CONTROLS,
  normalizeConfig,
  normalizePlaybackState,
  validateAnchor,
  validateMediaItem,
  validateQueue,
} from './validate'

export type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaHandler,
  MediaItem,
  MediaPlaybackStatus,
  MediaServiceApi,
  MediaServiceConfig,
  PlaybackState,
  PositionAnchor,
} from './types'

export type {
  AndroidMediaSessionConfig,
  IosMediaSessionConfig,
  MediaSessionConfig,
  MediaSessionHandlers,
  NativeMediaItem,
  NativePlaybackState,
  RnMediaMediaSession,
} from './specs/media-session.nitro'
