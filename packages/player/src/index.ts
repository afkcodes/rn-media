/**
 * `@afkcodes/timbre-player` — a React Native audio player built on libmpv.
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

export { getScreenStateSource, setScreenStateSource } from './screen-state'
export type { ScreenStateSource } from './screen-state'
export type { RnMediaScreenState } from './specs/screen-state.nitro'

export {
  CONTENT_URI_FD_LIMIT,
  CONTENT_URI_SCHEME,
  ContentUriResolver,
  getContentUriOpener,
  isContentUri,
  setContentUriOpener,
} from './content-uri'
export type { ContentUriOpener } from './content-uri'
export type { RnMediaContentSource } from './specs/content-source.nitro'

export type {
  ChapterEntry,
  MpvClient,
  MpvEndFileReason,
  MpvEvent,
  MpvEventKind,
  MpvFormat,
  MpvLogLevel,
  MpvPropertyValue,
  PlaylistEntry,
  PrefetchStartedEvent,
  SourceResolutionRequest,
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
  isRetryableErrno,
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
  Retryable,
  UnsupportedError,
  UnsupportedFormatError,
} from './errors'

export { toCommonMetadata } from './common-metadata'
export type { CommonMetadata } from './common-metadata'

export { HTTP_HEADER_FIELDS_OPTION, compileHttpHeaderFields } from './headers'
export type { HttpHeaders } from './headers'

export { escapeSubparam, utf8Length } from './subparam'

export {
  EQUALIZER_BANDS,
  EQUALIZER_BAND_COUNT,
  EQUALIZER_LIMITER_LABEL,
  EQUALIZER_PREAMP_LABEL,
  EQUALIZER_PRESETS,
  EQUALIZER_PRESET_LIST,
  defineEqualizerPreset,
  equalizerBandLabel,
  equalizerPresetChain,
  peakResponseDb,
} from './equalizer-presets'
export type {
  EqualizerPreset,
  EqualizerPresetChainOptions,
  EqualizerPresetId,
} from './equalizer-presets'

export {
  DEFAULT_EQUALIZER_STORAGE_KEY,
  EQUALIZER_SCHEMA_VERSION,
  parseEqualizerSettings,
  serializeEqualizerSettings,
} from './equalizer-storage'
export type {
  EqualizerRestoreResult,
  EqualizerSettings,
  EqualizerStorage,
} from './equalizer-storage'

export {
  AUDIO_FILTER_RUNTIME_PARAMS,
  AudioFilters,
  GRAPHIC_EQUALIZER_BANDS,
  assertValidAudioFilters,
  compileAudioFilters,
  diffAudioFilterParams,
  escapeAfParam,
} from './filters'
export type {
  AudioFilter,
  AudioFilterOption,
  AudioFilterParamChange,
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
  playlistFilenameProperty,
} from './properties'
export type { ObservedProperty } from './properties'

export {
  DEFAULT_RESOLVER_TIMEOUT_MS,
  DEFAULT_RESOLVER_TTL_MS,
  SourceResolverController,
} from './source-resolver'
export type {
  BuiltInSourceRewrite,
  SourceResolver,
  SourceResolverOptions,
} from './source-resolver'

export {
  BUFFERED_POSITION_STEP,
  BUFFERING_PERCENT_STEP,
  clearPlayerError,
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
  PositionAnchorMs,
  ReducerContext,
  TrackChangeReads,
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

export {
  DEFAULT_CACHE_SECS,
  DEFAULT_LOUDNESS_TARGET_LUFS,
  DEFAULT_RECONNECT_DELAY_MAX_SECONDS,
  DEFAULT_RESTART_THRESHOLD_SECONDS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_USER_AGENT,
  LIVE_EOF_BUDGET_RESET_SECONDS,
  LOUDNESS_NORMALIZATION_LABEL,
  MANAGED_FILTER_LABEL_PREFIX,
  Player,
} from './player'
export type {
  AudioChannelMode,
  ChapterChangedEvent,
  GaplessAudioMode,
  LoadOptions,
  LoadPlaylistOptions,
  LoudnessNormalizationOptions,
  Metadata,
  MpvClientFactory,
  NetworkReconnectOptions,
  PlayerErrorInfo,
  PlayerEventMap,
  PlayerEventName,
  PlayerLogLevel,
  PlayerOptions,
  PlaylistAddOptions,
  PlaylistApi,
  PositionDiscontinuityReason,
  QueueChangeReason,
  QueueChangedEvent,
  ReplayGainMode,
  ReplayGainOptions,
  RetryOptions,
  RetryingEvent,
  SeekCompletedEvent,
  SeekStartedEvent,
  SourceOptions,
  TrackChangedEvent,
  TrackEndedEvent,
  Unsubscribe,
} from './player'

export { usePlayer } from './hooks/usePlayer'
export type { UsePlayerOptions, UsePlayerResult } from './hooks/usePlayer'
export { usePlayerState } from './hooks/usePlayerState'
export type { PlayerStateSelector } from './hooks/usePlayerState'
export { DEFAULT_PROGRESS_INTERVAL_MS, useProgress } from './hooks/useProgress'
export type { Progress } from './hooks/useProgress'
export { DEFAULT_MILESTONES, useMilestones } from './hooks/useMilestones'
export type { Milestone } from './hooks/useMilestones'
export { usePrefetchStatus } from './hooks/usePrefetchStatus'
export type {
  PrefetchActive,
  PrefetchIdle,
  PrefetchStatus,
} from './hooks/usePrefetchStatus'
export {
  DEFAULT_EQUALIZER_GAIN_RANGE_DB,
  useEqualizer,
} from './hooks/useEqualizer'
export type {
  Equalizer,
  EqualizerBand,
  EqualizerGainRange,
  UseEqualizerOptions,
} from './hooks/useEqualizer'
export { useVisualizer } from './hooks/useVisualizer'
export type { UseVisualizerResult } from './hooks/useVisualizer'
