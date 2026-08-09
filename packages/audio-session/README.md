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

## Platform notes

- **Android** — `AudioFocusRequest` on API 26+, the documented
  `requestAudioFocus(listener, streamType, durationHint)` path on API 24–25
  (the package's `minSdkVersion` follows `@rn-media/player`). No `androidx.media`
  or media3 dependency. `ACTION_AUDIO_BECOMING_NOISY` and the
  `AudioDeviceCallback` are registered on the *application* context only while
  the session is active, and unregistered on `deactivate()`. The manifest needs
  nothing.
- **iOS** — `AVAudioSession.sharedInstance()`; `setCategory(_:mode:policy:options:)`,
  interruption + route-change observers installed by `configure()`, and
  `setActive(false, options: .notifyOthersOnDeactivation)` on `deactivate()`.
  `oldDeviceUnavailable` route changes are also surfaced as `becomingNoisy` so
  the JS contract is identical on both platforms.

## Development

```sh
npm run codegen    # nitrogen + bob build
npm run typecheck  # tsc --noEmit (strict)
npm test           # vitest
```
