# Spec: `@rn-media/audio-session`

Architect-owned contract. The audio_session (Flutter) analog: the **single arbiter** of
OS audio session config, focus, and interruption events. Small, boring, essential.
Implementers: verify all platform API shapes against current developer.android.com /
developer.apple.com docs and current Nitro docs — never from memory.

## Shape

- Nitro module, langs **kotlin + swift** (no C++ — this is pure platform API).
- Package `packages/audio-session`, npm `@rn-media/audio-session`.
- **Singleton** JS API (the OS session/focus is singular — CLAUDE.md principle 5 exception).
- Zero dependency on `@rn-media/player` and vice versa. Integration is an explicit
  helper (below), not ambient coupling — this fixes audio_session's "configure after
  all plugins load" ordering fragility (PLAN.md §4).

## TS API

```ts
import { AudioSession } from '@rn-media/audio-session';

await AudioSession.configure(AudioSessionPresets.music);   // or .speech, or full config
const granted = await AudioSession.activate();              // request focus / set active
if (granted) player.play();
await AudioSession.deactivate();

const unsub = AudioSession.addListener('interruption', (e) => {
  // e: { begin: true, type: 'duck' | 'pause' } | { begin: false, shouldResume: boolean }
});
AudioSession.addListener('becomingNoisy', () => { /* headphones unplugged → pause */ });
AudioSession.addListener('routeChange', (e) => { /* devices added/removed */ });
```

- `AudioSessionConfig`: iOS `{ category, categoryOptions, mode, routeSharingPolicy? }`
  (typed unions mirroring AVAudioSession constants); Android `{ usage, contentType,
  focusGain: 'gain' | 'gainTransient' | 'gainTransientMayDuck', willPauseWhenDucked }`.
- Presets encode the duck-vs-pause distinction: `music` (media usage, ducks),
  `speech` (podcast/audiobook: pauses instead of ducking).
- Events unify: iOS interruption notifications ↔ Android `OnAudioFocusChangeListener`
  (`AUDIOFOCUS_LOSS` → `{begin:true,type:'pause'}` + permanent flag,
  `LOSS_TRANSIENT` → pause, `LOSS_TRANSIENT_CAN_DUCK` → duck,
  `AUDIOFOCUS_GAIN` after transient loss → `{begin:false, shouldResume:true}`).

## Platform notes

- **Android**: `AudioFocusRequest` (API 26+ path; minSdk follows the player package),
  `AudioAttributes` from config; `ACTION_AUDIO_BECOMING_NOISY` receiver registered
  only while active (register/unregister with activate/deactivate — no leaked
  receivers); focus loss delivered even when app is backgrounded (service context).
- **iOS**: `AVAudioSession.sharedInstance()` setCategory/setActive; interruption +
  routeChange notification observers; `setActive(false, notifyOthersOnDeactivation:)`
  on deactivate.
- Thread: all listeners dispatch to JS via Nitro callbacks; no main-thread blocking.

## Player integration helper (lives in THIS package)

```ts
import { wireAudioSession } from '@rn-media/audio-session';
const unwire = wireAudioSession(player, {   // player: structural interface, NOT our Player type
  preset: AudioSessionPresets.music,
  duckVolume: 0.3,          // duck by volume attenuation
  resumeAfterInterruption: true,
});
```
- Accepts any object matching `{ play(); pause(); setVolume(v); getVolume(); }` —
  works with our Player, RNTP, expo-audio, anything (media-session-style
  player-agnosticism, applied here too).
- Default behavior: activate before play is the app's job (or the wire helper hooks
  play); on duck → attenuate; on pause-type interruption → pause, resume if
  `shouldResume && resumeAfterInterruption`; on becomingNoisy → pause.
- Fully unit-testable with a fake player + fake native module.

## Acceptance criteria
- nitrogen + strict tsc + TS unit tests for the wire-helper state machine (fixtures
  for every interruption sequence: transient→resume, permanent, duck→restore).
- Android: real `AudioFocusRequest` path verified compiling; manifest needs nothing.
- iOS: compiles on CI only (Linux dev box) — structure accordingly.
- No polling, no timers. Event-driven only.
