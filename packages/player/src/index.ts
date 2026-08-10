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
  VisualizerCapture,
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
  toVisualizerError,
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
  EQUALIZER_BANDS,
  EQUALIZER_BAND_COUNT,
  EQUALIZER_PRESETS,
  EQUALIZER_PRESET_LIST,
  defineEqualizerPreset,
  equalizerPresetChain,
  peakResponseDb,
} from './equalizer-presets'
export type {
  EqualizerPreset,
  EqualizerPresetChainOptions,
  EqualizerPresetId,
} from './equalizer-presets'

export {
  AudioFilters,
  GRAPHIC_EQUALIZER_BANDS,
  assertValidAudioFilters,
  compileAudioFilters,
  escapeAfParam,
} from './filters'
export type {
  AudioFilter,
  AudioFilterOption,
  BiquadWidthType,
  CompressorOptions,
  CrossfeedOptions,
  DynamicNormalizerOptions,
  EqualizerOptions,
  GraphicEqualizerOptions,
  LimiterOptions,
  LoudnormOptions,
  PassOptions,
  ShelfOptions,
  VolumeOptions,
} from './filters'

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

export {
  DEFAULT_VISUALIZER_FPS,
  VISUALIZER_DEFAULTS,
  createDecodeState,
  decodeVisualizerFrame,
  resolveVisualizerOptions,
} from './visualizer'
export type {
  VisualizerCapabilities,
  VisualizerDecodeState,
  VisualizerFrame,
  VisualizerOptions,
} from './visualizer'
export { AGC_SILENCE_DB } from './visualizer'

export { VisualizerController } from './visualizer-controller'
export type {
  VisualizerListener,
  VisualizerUnsubscribe,
} from './visualizer-controller'

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
export { useVisualizer } from './hooks/useVisualizer'
export type { UseVisualizerResult } from './hooks/useVisualizer'
