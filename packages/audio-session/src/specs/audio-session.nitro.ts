import type { HybridObject } from 'react-native-nitro-modules'

/* -------------------------------------------------------------------------- */
/*                                    iOS                                     */
/* -------------------------------------------------------------------------- */

/**
 * `AVAudioSession.Category`.
 *
 * Mirrors https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct
 * minus `audioProcessing`, which Apple marks deprecated.
 */
export type IosAudioSessionCategory =
  | 'ambient'
  | 'soloAmbient'
  | 'playback'
  | 'record'
  | 'playAndRecord'
  | 'multiRoute'

/**
 * `AVAudioSession.Mode`.
 *
 * NOTE: `defaultMode` is Apple's `AVAudioSession.Mode.default`. It is NOT
 * spelled `default` because nitrogen turns every union member into a native
 * enumerator — the C++ enumerator would be `DEFAULT` and the generated Swift
 * bridge would emit `case .default:`, which collides with Swift's `default`
 * keyword. Same reasoning as `MpvEndFileReason.endOfFile` in
 * `@rn-media/player`.
 *
 * `dualRoute` and `shortFormVideo` exist in recent SDKs but are deliberately
 * omitted: they would need `if #available` guards below our iOS 15.1
 * deployment target and are irrelevant for audio playback.
 */
export type IosAudioSessionMode =
  | 'defaultMode'
  | 'gameChat'
  | 'measurement'
  | 'moviePlayback'
  | 'spokenAudio'
  | 'videoChat'
  | 'videoRecording'
  | 'voiceChat'
  | 'voicePrompt'

/**
 * `AVAudioSession.CategoryOptions`.
 *
 * `allowBluetooth` is omitted — Apple deprecated it in favour of
 * `allowBluetoothHFP`, which is a recording concern this package does not have.
 */
export type IosAudioSessionCategoryOption =
  | 'mixWithOthers'
  | 'duckOthers'
  | 'allowBluetoothA2DP'
  | 'allowAirPlay'
  | 'defaultToSpeaker'
  | 'interruptSpokenAudioAndMixWithOthers'
  | 'overrideMutedMicrophoneInterruption'

/**
 * `AVAudioSession.RouteSharingPolicy`.
 *
 * `defaultPolicy` is Apple's `.default`, renamed for the reason described on
 * {@link IosAudioSessionMode}.
 */
export type IosRouteSharingPolicy =
  | 'defaultPolicy'
  | 'longFormAudio'
  | 'longFormVideo'
  | 'independent'

/** iOS half of {@link AudioSessionConfig}. Ignored on Android. */
export interface IosAudioSessionConfig {
  category: IosAudioSessionCategory
  mode: IosAudioSessionMode
  categoryOptions: IosAudioSessionCategoryOption[]
  routeSharingPolicy?: IosRouteSharingPolicy
}

/* -------------------------------------------------------------------------- */
/*                                  Android                                   */
/* -------------------------------------------------------------------------- */

/**
 * `AudioAttributes.USAGE_*`.
 *
 * https://developer.android.com/reference/android/media/AudioAttributes
 */
export type AndroidAudioUsage =
  | 'unknown'
  | 'media'
  | 'voiceCommunication'
  | 'alarm'
  | 'notification'
  | 'assistanceAccessibility'
  | 'assistanceNavigationGuidance'
  | 'assistanceSonification'
  | 'game'
  | 'assistant'

/** `AudioAttributes.CONTENT_TYPE_*`. */
export type AndroidAudioContentType =
  | 'unknown'
  | 'speech'
  | 'music'
  | 'movie'
  | 'sonification'

/** `AudioManager.AUDIOFOCUS_GAIN*`, i.e. `AudioFocusRequest.Builder`'s focus gain. */
export type AndroidAudioFocusGain =
  | 'gain'
  | 'gainTransient'
  | 'gainTransientMayDuck'
  | 'gainTransientExclusive'

/** Android half of {@link AudioSessionConfig}. Ignored on iOS. */
export interface AndroidAudioSessionConfig {
  usage: AndroidAudioUsage
  contentType: AndroidAudioContentType
  focusGain: AndroidAudioFocusGain
  /**
   * `AudioFocusRequest.Builder.setWillPauseWhenDucked`.
   *
   * `true` opts out of the system's automatic ducking so we receive
   * `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` ourselves — this is what makes the
   * `speech` preset pause instead of duck.
   */
  willPauseWhenDucked: boolean
}

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

/**
 * Full audio-session configuration. Both halves are optional so a caller can
 * supply only the platform they care about; the other platform then keeps
 * whatever it was last configured with.
 */
export interface AudioSessionConfig {
  ios?: IosAudioSessionConfig
  android?: AndroidAudioSessionConfig
}

/* -------------------------------------------------------------------------- */
/*                                   Events                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the app is being asked to do for the duration of an interruption.
 *
 * - `duck` — Android `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK`. Never emitted on
 *   iOS: AVAudioSession has no "duck me" interruption.
 * - `pause` — Android `AUDIOFOCUS_LOSS` / `AUDIOFOCUS_LOSS_TRANSIENT`, and
 *   every iOS `AVAudioSession.InterruptionType.began`.
 */
export type AudioInterruptionType = 'duck' | 'pause'

/**
 * Unified route-change reason.
 *
 * Values mirror `AVAudioSession.RouteChangeReason`. Android only ever produces
 * `newDeviceAvailable` / `oldDeviceUnavailable` (from `AudioDeviceCallback`).
 *
 * NOTE: `routeOverride` is Apple's `.override`, renamed to keep the generated
 * Swift enumerator (`.override`) away from Swift's `override` modifier.
 */
export type AudioRouteChangeReason =
  | 'unknown'
  | 'newDeviceAvailable'
  | 'oldDeviceUnavailable'
  | 'categoryChange'
  | 'routeOverride'
  | 'wakeFromSleep'
  | 'noSuitableRouteForCategory'
  | 'routeConfigurationChange'

/**
 * Flat interruption payload as it crosses the bridge.
 *
 * It is deliberately NOT a discriminated union of two structs: nitrogen cannot
 * represent a single-member string-literal type as a struct discriminator
 * (`String literal "..." cannot be represented in C++ because it is ambiguous
 * between a string and a discriminating union enum`). The TS facade narrows
 * this into the spec's `AudioSessionInterruptionEvent` union — see
 * `src/types.ts`.
 */
export interface NativeInterruptionEvent {
  /** `true` = interruption started, `false` = interruption ended. */
  begin: boolean
  /** Only meaningful when {@link begin} is `true`. */
  type: AudioInterruptionType
  /**
   * Only meaningful when {@link begin} is `false`.
   *
   * iOS: `AVAudioSession.InterruptionOptions.shouldResume`.
   * Android: `true` for `AUDIOFOCUS_GAIN` after a transient loss.
   */
  shouldResume: boolean
  /**
   * Only meaningful when {@link begin} is `true`. `true` when focus is gone for
   * good (Android `AUDIOFOCUS_LOSS`). Always `false` on iOS, where every
   * interruption may be followed by an `.ended` notification.
   */
  permanent: boolean
}

/** Route-change payload as it crosses the bridge. */
export interface NativeRouteChangeEvent {
  reason: AudioRouteChangeReason
}

/* -------------------------------------------------------------------------- */
/*                               Hybrid Object                                */
/* -------------------------------------------------------------------------- */

/**
 * The single OS audio-session arbiter.
 *
 * Listener registration is id-based rather than "pass the same function to
 * remove": Nitro callbacks are opaque native closures (a Kotlin lambda / Swift
 * closure), so identity comparison across the bridge is not dependable.
 * `add*Listener` returns a monotonically increasing id; feed it back to
 * `remove*Listener`.
 *
 * All callbacks are invoked from whatever thread the OS delivers the event on
 * (Android: the focus-listener `Handler` / a binder thread; iOS: the
 * notification queue). That is safe — Nitro schedules callback invocation onto
 * the JS thread itself ("Their execution is scheduled on the JS Thread […] you
 * can call the callback from any Thread", nitro.margelo.com/docs/types/callbacks).
 */
export interface RnMediaAudioSession
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /**
   * Apply `config` to the OS session.
   *
   * iOS: `setCategory(_:mode:options:)` + `setRouteSharingPolicy`, and installs
   * the interruption/route-change observers.
   * Android: stores the `AudioAttributes` + focus gain used by the next
   * {@link activate}.
   */
  configure(config: AudioSessionConfig): Promise<void>

  /**
   * Request the session.
   *
   * iOS: `setActive(true)` — resolves `false` if the OS refuses.
   * Android: `requestAudioFocus`, resolves `true` only for
   * `AUDIOFOCUS_REQUEST_GRANTED`. Also registers the becoming-noisy receiver
   * and the audio-device callback.
   */
  activate(): Promise<boolean>

  /**
   * Give the session back.
   *
   * iOS: `setActive(false, options: .notifyOthersOnDeactivation)`.
   * Android: `abandonAudioFocusRequest` + unregisters the becoming-noisy
   * receiver and the audio-device callback.
   */
  deactivate(): Promise<void>

  addInterruptionListener(
    listener: (event: NativeInterruptionEvent) => void
  ): number
  removeInterruptionListener(listenerId: number): void

  addBecomingNoisyListener(listener: () => void): number
  removeBecomingNoisyListener(listenerId: number): void

  addRouteChangeListener(
    listener: (event: NativeRouteChangeEvent) => void
  ): number
  removeRouteChangeListener(listenerId: number): void
}
