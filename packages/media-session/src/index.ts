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
  applyPersisted,
  clearPersisted,
  DEFAULT_PERSISTENCE_KEY,
  PERSISTENCE_SCHEMA_VERSION,
  restorePersisted,
  withPersistence,
} from './persistence'
export type {
  MediaSessionStorage,
  PersistedMediaService,
  PersistedSession,
  PersistenceOptions,
  RestoreResult,
} from './persistence'

export {
  DEFAULT_JUMP_SECONDS,
  DEFAULT_PLAYBACK_RESUMPTION,
  DEFAULT_REPEAT_MODE,
  DEFAULT_SHUFFLE_ENABLED,
  DEFAULT_STOP_FOREGROUND_ON_PAUSE,
  DEFAULT_SUPPORTED_PLAYBACK_RATES,
  MAX_COMPACT_CONTROLS,
  MAX_STOP_FOREGROUND_TIMEOUT_MS,
  normalizeConfig,
  normalizePlaybackState,
  validateAnchor,
  validateMediaItem,
  validateQueue,
  validateSleepTimerSeconds,
} from './validate'

export type {
  MediaCapability,
  MediaControl,
  MediaCustomAction,
  MediaHandler,
  MediaItem,
  MediaPlaybackStatus,
  MediaRepeatMode,
  MediaServiceApi,
  MediaServiceConfig,
  PlaybackState,
  PositionAnchor,
  SleepTimerMode,
  SleepTimerState,
} from './types'

export type {
  AndroidMediaSessionConfig,
  IosMediaSessionConfig,
  MediaSessionConfig,
  MediaSessionHandlers,
  NativeMediaItem,
  NativePlaybackState,
  NativeSleepTimerState,
  RnMediaMediaSession,
} from './specs/media-session.nitro'
