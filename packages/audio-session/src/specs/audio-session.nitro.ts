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
  'defaultPolicy' | 'longFormAudio' | 'longFormVideo' | 'independent'

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
  'unknown' | 'speech' | 'music' | 'movie' | 'sonification'

/** `AudioManager.AUDIOFOCUS_GAIN*`, i.e. `AudioFocusRequest.Builder`'s focus gain. */
export type AndroidAudioFocusGain =
  'gain' | 'gainTransient' | 'gainTransientMayDuck' | 'gainTransientExclusive'

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
   *
   * **No iOS equivalent exists** — see {@link AudioInterruptionType}. On iOS the
   * `speech` preset is ducked by the system like any other audio.
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
 * - `duck` — Android `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK`, and only when the
 *   config sets {@link AndroidAudioSessionConfig.willPauseWhenDucked}.
 * - `pause` — Android `AUDIOFOCUS_LOSS` / `AUDIOFOCUS_LOSS_TRANSIENT`, and
 *   every iOS `AVAudioSession.InterruptionType.began`.
 *
 * **Platform asymmetry — `duck` is never emitted on iOS.** This is a platform
 * ceiling, not a gap: `AVAudioSession.InterruptionType` has exactly two cases,
 * `.began` and `.ended`
 * (https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptiontype),
 * and there is no notification anywhere in AVFAudio for "another session is
 * ducking you". Ducking on iOS is applied *by the system, to your audio*, when
 * another app activates a session carrying `.duckOthers` — your app is not told
 * and does not act. The audible outcome therefore matches Android's default
 * (`willPauseWhenDucked: false`, where the platform also ducks you without a
 * callback, API 26+); what iOS cannot offer is Android's *opt-out*, i.e. "tell
 * me instead so I can pause". An app whose content is speech gets the pause
 * behaviour on Android and system ducking on iOS.
 */
export type AudioInterruptionType = 'duck' | 'pause'

/**
 * Unified route-change reason.
 *
 * Values mirror `AVAudioSession.RouteChangeReason`.
 *
 * **Platform asymmetry — Android only ever produces `newDeviceAvailable` /
 * `oldDeviceUnavailable`.** A ceiling, not a gap: Android has no
 * route-change notification. The nearest platform signal is
 * `AudioManager.registerAudioDeviceCallback`, whose entire surface is
 * `onAudioDevicesAdded` / `onAudioDevicesRemoved`
 * (https://developer.android.com/reference/android/media/AudioDeviceCallback),
 * so the other six reasons have no source to come from. `categoryChange`,
 * `routeOverride`, `wakeFromSleep`, `noSuitableRouteForCategory` and
 * `routeConfigurationChange` are iOS-only values; `unknown` is reachable on iOS
 * only (an `AVAudioSession.RouteChangeReason` this build does not recognise).
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
   *
   * On both platforms this means "the system permits resuming", never "you were
   * playing" — see `AudioSessionPlayerLike.isPlaying` in `src/wire.ts`.
   */
  shouldResume: boolean
  /**
   * Only meaningful when {@link begin} is `true`. `true` when the session is
   * gone for good and no `begin: false` event is coming.
   *
   * - Android: `AUDIOFOCUS_LOSS`.
   * - iOS: a media-services failure
   *   (`AVAudioSession.mediaServicesWereLostNotification` /
   *   `mediaServicesWereResetNotification`), which destroys the session's
   *   configuration and is the one iOS condition with no `.ended` to follow.
   *
   * **Platform asymmetry — an ordinary iOS interruption is never `permanent`.**
   * A ceiling: `AVAudioSession.InterruptionType.began` carries no permanence
   * information at all, and whether the interruption is recoverable is only
   * knowable later, from `.shouldResume` on the `.ended` notification. Android
   * says so up front; iOS cannot.
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
export interface RnMediaAudioSession extends HybridObject<{
  ios: 'swift'
  android: 'kotlin'
}> {
  /**
   * Apply `config` to the OS session.
   *
   * iOS: `setCategory(_:mode:options:)` (or the `policy:` overload when
   * {@link IosAudioSessionConfig.routeSharingPolicy} is set) — **applied
   * immediately**, and remembered so it can be replayed after a media-services
   * reset.
   * Android: stores the `AudioAttributes` + focus gain used by the *next*
   * {@link activate}.
   *
   * **Platform asymmetry — when the config takes effect.** On iOS the category
   * is a property of the session and changing it is a live operation. On
   * Android there is no session object to mutate: `AudioAttributes` and the
   * focus gain are constructor arguments of an `AudioFocusRequest`, which only
   * exists as an argument to `requestAudioFocus`
   * (https://developer.android.com/reference/android/media/AudioFocusRequest).
   * So calling `configure()` while already active changes the live session on
   * iOS and takes effect on the next `activate()` on Android. Configure before
   * activating — which both presets and every example do — and the two agree.
   *
   * Rejects on iOS if `setCategory` fails (a category/mode/option combination
   * the device does not support). Cannot reject on Android: nothing is called.
   */
  configure(config: AudioSessionConfig): Promise<void>

  /**
   * Request the session.
   *
   * Resolves `true` when the app may start playing and `false` when the OS
   * refused. It never resolves `false` for a programming error — those reject.
   *
   * - Android: `requestAudioFocus`; `true` only for
   *   `AUDIOFOCUS_REQUEST_GRANTED`.
   * - iOS: `setActive(true)`; `false` for the four `AVAudioSessionErrorCode`s
   *   that mean "the system declined" — `cannotStartPlaying` (`'!pla'`),
   *   `cannotInterruptOthers` (`'!int'`, a backgrounded non-mixable app that is
   *   not the Now Playing app), `insufficientPriority` (`'!pri'`, another app
   *   such as Phone is controlling audio) and `siriIsRecording` (`'siri'`).
   *   Everything else (`badParam`, `incompatibleCategory`,
   *   `missingEntitlement`, `mediaServicesFailed`, …) rejects.
   *
   * Also arms the platform listeners: on Android the focus listener, the
   * becoming-noisy receiver and the audio-device callback; on iOS the
   * `AVAudioSession` notification observers (which are also armed by
   * {@link configure} and by adding any listener).
   */
  activate(): Promise<boolean>

  /**
   * Give the session back.
   *
   * iOS: `setActive(false, options: .notifyOthersOnDeactivation)`.
   * Android: `abandonAudioFocusRequest`.
   *
   * Listeners are **not** removed: subscriptions outlive activation on both
   * platforms (see {@link addBecomingNoisyListener}).
   *
   * **Platform asymmetry — this can reject on iOS and cannot on Android.**
   * `setActive(false)` fails with `AVAudioSessionErrorCode.isBusy` (`'!act'`)
   * when the app "attempted to set its audio session inactive … but it is still
   * actively playing and/or recording"
   * (`CoreAudioTypes.framework/Headers/AudioSessionTypes.h`). Stop the player
   * first. `AudioManager.abandonAudioFocusRequest` has no comparable failure.
   */
  deactivate(): Promise<void>

  /**
   * Observe interruptions.
   *
   * **Delivery window.** iOS delivers from the moment the observer exists —
   * adding a listener installs it — whether or not the session was ever
   * activated. Android delivers only while a focus request is outstanding,
   * because `AudioManager.OnAudioFocusChangeListener` is a field of the
   * `AudioFocusRequest` and the system has nobody to call before
   * `requestAudioFocus`
   * (https://developer.android.com/media/optimize/audio-focus). In practice
   * every app activates before it plays, and no interruption is meaningful to
   * an app that holds no focus.
   */
  addInterruptionListener(
    listener: (event: NativeInterruptionEvent) => void
  ): number
  removeInterruptionListener(listenerId: number): void

  /**
   * Observe "the output the user was listening on went away" — Android's
   * `ACTION_AUDIO_BECOMING_NOISY`, iOS's `oldDeviceUnavailable` route change.
   *
   * Delivered from the moment the listener is added on both platforms: the
   * Android `BroadcastReceiver` and the iOS notification observer are derived
   * from the listener set, not from {@link activate}.
   */
  addBecomingNoisyListener(listener: () => void): number
  removeBecomingNoisyListener(listenerId: number): void

  /**
   * Observe output-route changes. Same delivery window as
   * {@link addBecomingNoisyListener}; see {@link AudioRouteChangeReason} for
   * which reasons each platform can produce.
   */
  addRouteChangeListener(
    listener: (event: NativeRouteChangeEvent) => void
  ): number
  removeRouteChangeListener(listenerId: number): void
}
