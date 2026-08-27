export { logSessionError, MediaSessionError } from './errors'
export type { MediaSessionErrorCode } from './errors'

export { BaseMediaHandler, CompositeMediaHandler } from './handler'

export {
  BROWSE_ROOT,
  BrowseError,
  capRootTabs,
  isBrowseError,
  MAX_ROOT_TABS,
} from './browse'

export { useCarConnection } from './hooks/useCarConnection'

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
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  DEFAULT_PERSISTENCE_KEY,
  MIN_AUTOSAVE_INTERVAL_MS,
  PERSISTENCE_SCHEMA_VERSION,
  restorePersisted,
  withPersistence,
} from './persistence'
export type {
  MediaSessionStorage,
  PersistedMediaService,
  PersistedSession,
  PersistenceAutosaveOptions,
  PersistenceOptions,
  RestoreResult,
} from './persistence'

export {
  DEFAULT_JUMP_SECONDS,
  DEFAULT_PLAYBACK_RESUMPTION,
  DEFAULT_REMOTE_VOLUME_CONTROL,
  DEFAULT_REMOTE_VOLUME_STEPS,
  DEFAULT_REPEAT_MODE,
  DEFAULT_SHUFFLE_ENABLED,
  DEFAULT_STOP_FOREGROUND_ON_PAUSE,
  DEFAULT_SUPPORTED_PLAYBACK_RATES,
  MAX_COMPACT_CONTROLS,
  MAX_STOP_FOREGROUND_TIMEOUT_MS,
  normalizeConfig,
  normalizePlaybackState,
  normalizeRemotePlayback,
  SESSION_ERROR_SEVERITY,
  stepRemoteVolume,
  toSessionError,
  validateAnchor,
  validateMediaItem,
  validateQueue,
  validateSleepTimerSeconds,
} from './validate'

export type {
  BrowseItem,
  BrowseMediaType,
  BrowseStyle,
  CarConnection,
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
  RemotePlayback,
  SearchFocus,
  RemoteVolumeControl,
  RemoteVolumeDirection,
  SessionError,
  SessionErrorCode,
  SessionErrorSeverity,
  SleepTimerMode,
  SleepTimerState,
} from './types'

export type {
  AndroidMediaSessionConfig,
  BrowseErrorCode,
  IosMediaSessionConfig,
  MediaSessionConfig,
  MediaSessionHandlers,
  NativeMediaItem,
  NativePlaybackState,
  NativeRemotePlayback,
  NativeSleepTimerState,
  RnMediaMediaSession,
} from './specs/media-session.nitro'
