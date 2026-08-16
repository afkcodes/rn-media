# `@rn-media/audio-session`

The single arbiter of the OS audio session for React Native: category/focus
configuration, interruptions, headphone unplugs and route changes — unified
across `AVAudioSession` (iOS) and `AudioFocusRequest` (Android).

Nitro Module, Kotlin + Swift, no C++ of its own. Zero dependency on
`@rn-media/player` (and vice versa) — integration is an explicit helper, never
ambient coupling.

## Usage

```ts
import {
  AudioSession,
  AudioSessionPresets,
  wireAudioSession,
} from '@rn-media/audio-session'

await AudioSession.configure(AudioSessionPresets.music) // or .speech
const granted = await AudioSession.activate()
if (granted) player.play()

const unsub = AudioSession.addListener('interruption', (event) => {
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

### Presets

| | `music` | `speech` |
|---|---|---|
| iOS mode | `default` | `spokenAudio` |
| Android content type | `CONTENT_TYPE_MUSIC` | `CONTENT_TYPE_SPEECH` |
| `willPauseWhenDucked` | `false` (system ducks us) | `true` (we get told, and pause) |

Ducked speech is unintelligible, which is why `speech` opts out of Android's
automatic ducking.

### Player integration

```ts
const unwire = wireAudioSession(player, {
  preset: AudioSessionPresets.music,
  duckVolume: 0.3,
  resumeAfterInterruption: true,
})
```

`player` is structural — anything with `{ play(); pause(); setVolume(v);
getVolume(): number }` works (our `Player`, RNTP, expo-audio, a test double).

The helper: ducks on a `duck` interruption and restores the exact previous
volume afterwards; pauses on a `pause` interruption and resumes only when the
OS says `shouldResume` and the loss was not permanent; pauses on
`becomingNoisy` and never auto-resumes after one. Activating the session before
`play()` remains the app's job. Everything is event-driven — no timers, no
polling.

## Platform parity

Audio focus (Android) and `AVAudioSession` (iOS) are different models. Every row
below is either identical on both platforms or an honest, cited ceiling — there
is no member that exists on one platform and quietly does nothing on the other.

| Member | Android | iOS | Verdict |
|---|---|---|---|
| `configure()` | stores the `AudioAttributes` + focus gain for the next `activate()` | `setCategory(_:mode:policy:options:)`, applied immediately | **timing differs** — see below |
| `activate()` | `requestAudioFocus`; `true` only for `AUDIOFOCUS_REQUEST_GRANTED` | `setActive(true)`; `false` for the four refusal error codes | same contract |
| `deactivate()` | `abandonAudioFocusRequest`, cannot fail | `setActive(false, .notifyOthersOnDeactivation)`; **rejects with `isBusy` if still playing** | asymmetric failure |
| `interruption` `begin`/`end` | `AUDIOFOCUS_LOSS*` / `AUDIOFOCUS_GAIN` | `.began` / `.ended` | same |
| `type: 'duck'` | `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK` (needs `willPauseWhenDucked`) | **never** | ceiling |
| `permanent: true` | `AUDIOFOCUS_LOSS` | media-services loss/reset only | ceiling |
| `shouldResume` | `AUDIOFOCUS_GAIN` after a transient loss | `.shouldResume` | same |
| `becomingNoisy` | `ACTION_AUDIO_BECOMING_NOISY` | `oldDeviceUnavailable` route change | same |
| `routeChange` reason | `newDeviceAvailable` / `oldDeviceUnavailable` only | all eight | ceiling |
| listener delivery window | from subscription (`becomingNoisy`, `routeChange`); while focus is held (`interruption`) | from subscription | same, except `interruption` |

### The ceilings, with citations

- **`type: 'duck'` is Android-only.** `AVAudioSession.InterruptionType` has
  exactly two cases, `.began` and `.ended`, and AVFAudio posts nothing for "you
  are being ducked". iOS ducking is applied *by the system to your audio* when
  another app activates a session carrying `.duckOthers`; you are not told and
  you do not act. That matches Android's **default** behaviour
  (`willPauseWhenDucked: false`, API 26+, where the platform ducks you silently
  too). What iOS has no equivalent for is Android's opt-*out* — "pause me
  instead of ducking me", which is what the `speech` preset asks for. On iOS the
  `speech` preset is ducked like anything else.
- **`permanent: true` on an ordinary iOS interruption is impossible.**
  `.began` carries no permanence information; whether the interruption was
  recoverable is only knowable later, from `.shouldResume` on `.ended`. iOS does
  set `permanent: true` for one condition — a media-services failure
  (`mediaServicesWereLostNotification` / `mediaServicesWereResetNotification`),
  which destroys the session and has no `.ended` to follow. That is the exact
  analogue of Android's `AUDIOFOCUS_LOSS`, and the session's category is
  re-applied automatically when services come back.
- **Android route changes only ever report a device appearing or
  disappearing.** Android has no route-change notification; the nearest signal
  is [`AudioDeviceCallback`](https://developer.android.com/reference/android/media/AudioDeviceCallback),
  whose whole surface is `onAudioDevicesAdded` / `onAudioDevicesRemoved`. The
  other six `AudioRouteChangeReason` values have no Android source.
- **`configure()` timing.** iOS mutates a live session object. Android has no
  session object: `AudioAttributes` and the focus gain are constructor arguments
  of an [`AudioFocusRequest`](https://developer.android.com/reference/android/media/AudioFocusRequest),
  which only exists as an argument to `requestAudioFocus`. Configure *before*
  activating — what the presets and every example do — and the platforms agree.
- **`interruption` needs focus on Android.** `OnAudioFocusChangeListener` is a
  field of the focus request; before `requestAudioFocus` the system has nobody
  to call. `becomingNoisy` and `routeChange` have no such constraint and are
  delivered from the moment you subscribe on both platforms.
- **`activate()` refusals on iOS** resolve `false` for exactly
  `cannotStartPlaying` (`'!pla'`), `cannotInterruptOthers` (`'!int'` — a
  backgrounded non-mixable app that is not the Now Playing app),
  `insufficientPriority` (`'!pri'` — Phone or another app is controlling audio)
  and `siriIsRecording` (`'siri'`). Everything else rejects: those are
  statements about the call, not a contested resource.

## Implementation notes

- **Android** — `AudioFocusRequest` on API 26+, the documented
  `requestAudioFocus(listener, streamType, durationHint)` path on API 24–25
  (the package's `minSdkVersion` follows `@rn-media/player`). No `androidx.media`
  or media3 dependency. `ACTION_AUDIO_BECOMING_NOISY` and the
  `AudioDeviceCallback` are registered on the *application* context for the
  union of "the session is active" and "something is subscribed", and released
  when neither holds. The manifest needs nothing.
- **iOS** — `AVAudioSession.sharedInstance()`; `setCategory(_:mode:policy:options:)`
  and `setActive(false, options: .notifyOthersOnDeactivation)` on `deactivate()`.
  The notification observers are installed by `configure()`, by `activate()`, and
  by adding any listener, so no ordering of those three leaves a stream silent.
  `oldDeviceUnavailable` route changes are also surfaced as `becomingNoisy` so
  the JS contract is identical on both platforms.

## Errors

There is no typed error taxonomy here (unlike `@rn-media/player`): `configure`,
`activate` and `deactivate` reject with the platform's own error — an `NSError`
in `NSOSStatusErrorDomain` on iOS, a `Throwable` on Android. The
`AVAudioSessionErrorCode` is in `error.code`; the fourcc values are listed in
`CoreAudioTypes.framework/Headers/AudioSessionTypes.h`. Refusals are *not*
errors: `activate()` answers `false`.

## Development

```sh
npm run codegen    # nitrogen + bob build
npm run typecheck  # tsc --noEmit (strict)
npm test           # vitest
```
