/**
 * `@rn-media/player` — a React Native audio player built on libmpv.
 *
 * Two layers, both public:
 *
 * - {@link Player} (plus the `use*` hooks) is the typed, ergonomic API most
 *   apps want. It owns one mpv core, reduces mpv's event stream into an
 *   immutable {@link PlayerState}, and projects playback position locally
 *   instead of streaming it across the bridge.
 * - {@link createMpvClient} is the raw, complete libmpv client binding the
 *   above is built on. Reach for it when mpv can do something this library
 *   has not wrapped yet — it is guaranteed to stay complete.
 */

export { createMpvClient } from './native-client'

export type {
  MpvClient,
  MpvEndFileReason,
  MpvEvent,
  MpvEventKind,
  MpvFormat,
  MpvLogLevel,
  MpvPropertyValue,
} from './specs/mpv-client.nitro'

export { toPlayerEvent, toPlayerEvents } from './events'
export type {
  EndFileEvent,
  LogEvent,
  PlaybackRestartEvent,
  PlayerEvent,
  PropertyEvent,
  SeekEvent,
  ShutdownEvent,
  StartFileEvent,
} from './events'

export {
  PlayerErrorException,
  classifyEndFile,
  disposedError,
  isNetworkUri,
  toPlayerError,
} from './errors'
export type {
  DisposedError,
  EndFileOutcome,
  InvalidStateError,
  LoadFailedError,
  NetworkError,
  PlayerError,
  PlayerErrorCode,
  RawMpvError,
  UnsupportedError,
  UnsupportedFormatError,
} from './errors'

export {
  MPV_VOLUME_SCALE,
  MpvProperty,
  OBSERVED_PROPERTIES,
  isMetadataProperty,
  metadataByKeyProperty,
  metadataKeyProperty,
  metadataValueProperty,
} from './properties'
export type { ObservedProperty } from './properties'

export {
  createInitialState,
  isPositionDiscontinuity,
  projectPosition,
  reducePlayerState,
  withResyncedAnchor,
} from './state'
export type {
  LoopMode,
  LoopRaw,
  PlaylistPosition,
  PlayerState,
  PlayerStatus,
  PositionAnchor,
  ReducerContext,
} from './state'

export { Player } from './player'
export type {
  LoadOptions,
  LoadPlaylistOptions,
  Metadata,
  MpvClientFactory,
  PlayerEventMap,
  PlayerEventName,
  PlayerLogLevel,
  PlayerOptions,
  PlaylistApi,
  ReplayGainMode,
  ReplayGainOptions,
  TrackChangedEvent,
  TrackEndedEvent,
  Unsubscribe,
} from './player'

export { usePlayer } from './hooks/usePlayer'
export type { UsePlayerOptions, UsePlayerResult } from './hooks/usePlayer'
export { usePlayerState } from './hooks/usePlayerState'
export type { PlayerStateSelector } from './hooks/usePlayerState'
export { useProgress } from './hooks/useProgress'
export type { Progress } from './hooks/useProgress'
