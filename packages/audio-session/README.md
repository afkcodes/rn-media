# `@afkcodes/timbre-audio-session`

The single arbiter of the OS audio session for React Native: category and focus
configuration, interruptions, headphone unplugs and route changes, unified across
`AVAudioSession` (iOS) and `AudioFocusRequest` (Android). Nitro Module, Kotlin +
Swift, no C++ of its own, and zero dependency on `@afkcodes/timbre-player` in either
direction — integration is an explicit helper, never ambient coupling
([ARCHITECTURE §26](../../ARCHITECTURE.md#26-avaudiosession-has-exactly-one-owner-and-it-is-not-the-engine)).

## Installation

```sh
npm install @afkcodes/timbre-audio-session react-native-nitro-modules
```

The Android manifest needs nothing.

## Usage

```ts
import { AudioSession, AudioSessionPresets } from '@afkcodes/timbre-audio-session'

await AudioSession.configure(AudioSessionPresets.music) // or .speech
const granted = await AudioSession.activate()
if (granted) player.play()

AudioSession.addListener('interruption', (event) => {
  if (event.begin) {
    // event.type: 'duck' | 'pause', event.permanent: boolean
  } else {
    // event.shouldResume: boolean
  }
})
AudioSession.addListener('becomingNoisy', () => player.pause())
AudioSession.addListener('routeChange', (e) => console.log(e.reason))

await AudioSession.deactivate()
```

Or hand the whole policy to `wireAudioSession`:

```ts
import { AudioSessionPresets, wireAudioSession } from '@afkcodes/timbre-audio-session'

const unwire = wireAudioSession(player, {
  preset: AudioSessionPresets.music,
  duckVolume: 0.3,
  resumeAfterInterruption: true,
})
```

It ducks on a `duck` interruption and restores the exact previous volume
afterwards; pauses on a `pause` interruption and resumes only when the OS says
`shouldResume` and the loss was not permanent; pauses on `becomingNoisy` and
never auto-resumes after one. Everything is event-driven — no timers, no polling.
Activating the session before `play()` stays the app's job.

## API

| | what it does | notes |
|---|---|---|
| `AudioSession.configure(config): Promise<void>` | `AVAudioSession` category / Android `AudioAttributes` | On Android it is stored for the next `activate()` |
| `AudioSession.activate(): Promise<boolean>` | Requests focus | `false` is a refusal, not an error |
| `AudioSession.deactivate(): Promise<void>` | Releases it | Rejects with `isBusy` on iOS if still playing |
| `AudioSession.addListener(event, fn): Unsubscribe` | `'interruption' \| 'becomingNoisy' \| 'routeChange'` | `interruption` is `{ begin, type: 'duck' \| 'pause', permanent, shouldResume }` |
| `AudioSessionPresets.music` / `.speech` | Ready-made configs | `speech` pauses instead of ducking, because ducked speech is unintelligible |
| `wireAudioSession(player, options?): Unsubscribe` | Duck / pause / resume / stop-on-unplug, in one call | `{ preset?, duckVolume? (0.3), resumeAfterInterruption? (true), session?, onError? }` |

`player` is structural — anything with `{ play, pause, setVolume, getVolume }`,
optionally `isPlaying` and `onStateChange`. Implementing `isPlaying` is what keeps
a *user's* pause sacred across an interruption.

| Preset | `music` | `speech` |
|---|---|---|
| iOS mode | `default` | `spokenAudio` |
| Android content type | `CONTENT_TYPE_MUSIC` | `CONTENT_TYPE_SPEECH` |
| `willPauseWhenDucked` | `false` (the system ducks us) | `true` (we are told, and pause) |

There is no typed error taxonomy here: `configure`, `activate` and `deactivate`
reject with the platform's own error — an `NSError` in `NSOSStatusErrorDomain` on
iOS, a `Throwable` on Android. Refusals are *not* errors; `activate()` answers
`false`.

## Platform parity

Audio focus (Android) and `AVAudioSession` (iOS) are different models. Every row
below is either identical on both platforms or a cited ceiling. There is no
member that exists on one platform and quietly does nothing on the other.

| Member | Android | iOS | Verdict |
|---|---|---|---|
| `configure()` | stores the `AudioAttributes` + focus gain for the next `activate()` | `setCategory(_:mode:policy:options:)`, applied immediately | **timing differs** — Android has no session object, since both are constructor arguments of an `AudioFocusRequest` that exists only as an argument to `requestAudioFocus`. Configure *before* activating and the platforms agree |
| `activate()` | `requestAudioFocus`; `true` only for `AUDIOFOCUS_REQUEST_GRANTED` | `setActive(true)`; `false` for exactly `cannotStartPlaying`, `cannotInterruptOthers`, `insufficientPriority` and `siriIsRecording` | **same contract** — everything else rejects, because those are statements about the call, not a contested resource |
| `deactivate()` | `abandonAudioFocusRequest`, cannot fail | `setActive(false, .notifyOthersOnDeactivation)` | **asymmetric failure** — iOS rejects with `isBusy` if still playing |
| `interruption` `begin` / `end` | `AUDIOFOCUS_LOSS*` / `AUDIOFOCUS_GAIN` | `.began` / `.ended` | **parity** |
| `type: 'duck'` | `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` (needs `willPauseWhenDucked`) | **never** | **ceiling** — `AVAudioSession.InterruptionType` has two cases and AVFAudio posts nothing for "you are being ducked". iOS ducking is applied *to* your audio and you are not told, which matches Android's default; what iOS has no equivalent for is the opt-*out* the `speech` preset asks for |
| `permanent: true` | `AUDIOFOCUS_LOSS` | media-services loss/reset only | **ceiling** — `.began` carries no permanence, which is knowable only later from `.shouldResume`. The one iOS condition that does set it is a media-services failure, which destroys the session and has no `.ended`; the category is re-applied automatically when services return |
| `shouldResume` | `AUDIOFOCUS_GAIN` after a transient loss | `.shouldResume` | **parity** |
| `becomingNoisy` | `ACTION_AUDIO_BECOMING_NOISY` | `oldDeviceUnavailable` route change | **parity** |
| `routeChange` reason | `newDeviceAvailable` / `oldDeviceUnavailable` only | all eight | **ceiling** — Android has no route-change notification; the nearest signal is [`AudioDeviceCallback`](https://developer.android.com/reference/android/media/AudioDeviceCallback), whose whole surface is devices added and removed |
| listener delivery window | from subscription for `becomingNoisy` and `routeChange`; while focus is held for `interruption` | from subscription | **`interruption` differs** — `OnAudioFocusChangeListener` is a field of the focus request, so before `requestAudioFocus` the system has nobody to call |

## Implementation notes

- **Android** — `AudioFocusRequest` on API 26+, the documented
  `requestAudioFocus(listener, streamType, durationHint)` path on API 24–25. No
  `androidx.media` or media3 dependency. `ACTION_AUDIO_BECOMING_NOISY` and the
  `AudioDeviceCallback` are registered on the *application* context for the union
  of "the session is active" and "something is subscribed", and released when
  neither holds.
- **iOS** — `AVAudioSession.sharedInstance()`, with
  `setActive(false, options: .notifyOthersOnDeactivation)` on `deactivate()`. The
  notification observers are installed by `configure()`, by `activate()` and by
  adding any listener, so no ordering of the three leaves a stream silent.
  `oldDeviceUnavailable` route changes are also surfaced as `becomingNoisy`, so
  the JS contract is identical on both platforms.

## Also exported

| Group | Exports |
|---|---|
| Config | `AudioSessionConfig`, `IosAudioSessionConfig`, `AndroidAudioSessionConfig`; the iOS unions `IosAudioSessionCategory`, `IosAudioSessionMode`, `IosAudioSessionCategoryOption`, `IosRouteSharingPolicy`; the Android unions `AndroidAudioUsage`, `AndroidAudioContentType`, `AndroidAudioFocusGain` — every member is the platform constant's own name, so the platform documentation applies verbatim |
| Events | `AudioSessionEventMap`, `AudioSessionEventName`, `AudioSessionInterruptionEvent`, `AudioSessionRouteChangeEvent`, `AudioInterruptionType` — `'duck' \| 'pause'` |
| Wiring | `WireAudioSessionOptions`, `AudioSessionPlayerLike` (the structural player the wiring accepts), `AudioSessionApi` |
| Native layer | `RnMediaAudioSession`, `NativeInterruptionEvent`, `NativeRouteChangeEvent` |
| Factory and route reasons | `createAudioSession` (the factory `AudioSession` wraps), `AudioRouteChangeReason` |

## Development

```sh
npm run codegen    # nitrogen + bob build
npm run typecheck  # tsc --noEmit (strict)
npm test           # vitest
```
