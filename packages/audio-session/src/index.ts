export { AudioSession, createAudioSession } from './audio-session'
export { AudioSessionPresets } from './presets'
export { wireAudioSession } from './wire'

export type { AudioSessionPlayerLike, WireAudioSessionOptions } from './wire'

export type {
  AudioSessionApi,
  AudioSessionEventMap,
  AudioSessionEventName,
  AudioSessionInterruptionEvent,
  AudioSessionRouteChangeEvent,
  Unsubscribe,
} from './types'

export type {
  AndroidAudioContentType,
  AndroidAudioFocusGain,
  AndroidAudioSessionConfig,
  AndroidAudioUsage,
  AudioInterruptionType,
  AudioRouteChangeReason,
  AudioSessionConfig,
  IosAudioSessionCategory,
  IosAudioSessionCategoryOption,
  IosAudioSessionConfig,
  IosAudioSessionMode,
  IosRouteSharingPolicy,
  NativeInterruptionEvent,
  NativeRouteChangeEvent,
  RnMediaAudioSession,
} from './specs/audio-session.nitro'
