# rn-media

**React Native audio playback built on [libmpv](https://mpv.io), with a
player-agnostic media-session layer** — lock screen, notification, Bluetooth,
and background playback that keep working after the app's UI is gone.

Inspired by Flutter's [`audio_service`](https://pub.dev/packages/audio_service) /
[`audio_session`](https://pub.dev/packages/audio_session) / media-kit trio, and
powered by [Nitro Modules](https://nitro.margelo.com) (the C++ core binds
libmpv's client API directly — no bridge layer).

> **Status: v0.1, pre-release.** The full Android stack is verified end-to-end
> on a physical device (audio output, notification controls round-tripping to
> JS, playback surviving activity destruction and swipe-from-recents). iOS code
> is complete but has not yet been compiled by CI. APIs may still change.

## Why this exists

| | react-native-track-player | react-native-video / expo-video | **rn-media** |
|---|---|---|---|
| Engine | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | **libmpv (ffmpeg)** |
| Formats | Platform codecs | Platform codecs | Everything ffmpeg decodes — MP3, AAC/M4A, FLAC, OGG/Opus, and more |
| Multiple players | ❌ singleton | ✅ | ✅ |
| Background + media session | ✅ best-in-class | ⚠️ basic | ✅ media3 `MediaLibraryService`, native-first commands |
| Session layer works with *any* player | ❌ | ❌ | ✅ (`@rn-media/media-session` is player-agnostic) |
| Gapless playlists | ⚠️ | ❌ | ✅ (mpv native) |
| DRM (Widevine/FairPlay) | ❌ | ✅ | ❌ (libmpv cannot — see Limitations) |

The sweet spot: music apps with **non-DRM audio** — indie catalogs, self-hosted
libraries (Plex / Jellyfin / Subsonic), podcasts, radio, audiobooks.

## Packages

```
@rn-media/player          libmpv playback engine: Player class, state, hooks
@rn-media/audio-session   audio focus / AVAudioSession arbiter: interruptions, ducking
@rn-media/media-session   lock screen, notification, remote commands, background service
```

They are independent. Use `player` alone for foreground playback; add
`audio-session` for focus handling; add `media-session` for lock screen +
background. `media-session` and `audio-session` work with **any** playback
engine (ours, or your own) — the contracts are structural, not nominal.

## Requirements

- React Native **>= 0.82** (New Architecture; tested on 0.86)
- [`react-native-nitro-modules`](https://nitro.margelo.com)
- Android: minSdk **24**, compileSdk 36. iOS: **15.1+**
- Prebuilt libmpv binaries are downloaded automatically at build time
  (Gradle task on Android, podspec script on iOS), pinned by SHA-256.
  Audio-only builds: ~3 MB per Android ABI, ~2.5 MB compressed on iOS.

## Installation

```sh
npm install @rn-media/player @rn-media/audio-session @rn-media/media-session react-native-nitro-modules
cd ios && pod install   # downloads + verifies the pinned libmpv xcframeworks
```

**Android** — nothing to configure. The media-session library manifest merges
the foreground-service permissions and the `mediaPlayback` service into your
app. `POST_NOTIFICATIONS` is *not* required for media notifications.

**iOS** — add the background audio mode to `Info.plist`:

```xml
<key>UIBackgroundModes</key>
<array><string>audio</string></array>
```

### Expo

Works with the prebuild (managed) workflow — no manual native edits. Add the
config plugin, which `@rn-media/media-session` ships, and prebuild:

```json
{
  "expo": {
    "plugins": ["@rn-media/media-session"]
  }
}
```

```sh
npx expo prebuild --clean
npx expo run:ios    # or run:android / an EAS build
```

The plugin merges `UIBackgroundModes: audio` into `Info.plist` (idempotently,
preserving any other modes). Android needs no plugin work — the library manifest
already merges the permissions and the service. The other two packages need no
plugin at all. To brand the Android notification, pass
`{ "androidNotificationIcon": "./assets/ic_notification.xml" }` as plugin
options — see the
[media-session README](packages/media-session/README.md#expo-config-plugin).

Expo Go cannot load this library (it has native code); a development build is
required.

## Quick start: just play something

```tsx
import { usePlayer, useProgress } from '@rn-media/player';

function MiniPlayer() {
  const { player } = usePlayer();                    // created on mount, destroyed on unmount
  const { position, duration, isLive } = useProgress(player);

  return (
    <>
      <Button title="Load" onPress={() => player?.load('https://example.com/track.flac')} />
      <Button title="Play/Pause" onPress={() => player?.toggle()} />
      <Text>{format(position)} / {isLive ? 'live' : format(duration)}</Text>
    </>
  );
}
```

Or imperatively, outside React:

```ts
import { Player } from '@rn-media/player';

const player = await Player.create({ volume: 0.8 });
await player.loadPlaylist(
  ['https://…/1.mp3', 'https://…/2.flac', 'https://…/3.opus'],
  { startIndex: 0 },
);
player.play();
player.on('trackChanged', ({ index }) => console.log('now on', index));
player.on('trackEnded', () => console.log('finished naturally'));
player.on('error', (e) => console.log(e.code, e.message)); // typed: network | unsupported-format | …
// later:
player.destroy();
```

### The Player API at a glance

```ts
player.play(); player.pause(); player.toggle();
await player.seekTo(seconds);
player.setRate(1.5);            // pitch-corrected
player.setVolume(0.5);          // 0..1
player.setMuted(true);
player.setLoop('off' | 'track' | 'playlist');

player.playlist.add(uri); player.playlist.remove(i);
player.playlist.move(from, to); player.playlist.jumpTo(i);
player.playlist.next(); player.playlist.previous(); player.playlist.clear();

player.state;                   // immutable snapshot (status, playing, duration, isLive, …)
player.onStateChange(s => …);   // fires only when state actually changed
player.getPosition();           // projected locally — no bridge traffic, no timers

// Raw mpv escape hatches — the full mpv surface is always available:
await player.command(['loadfile', uri, 'append-play']);
player.setPropertyString('af', 'loudnorm');       // any mpv filter/option
player.observeProperty('demuxer-cache-time', 'number');
```

**Design notes you'll feel:** position is *never* streamed across the bridge —
it's projected client-side from an anchor and only resyncs on discontinuities.
Multiple `Player` instances are first-class (each is its own mpv core). Live
streams report `isLive: true` and `duration: undefined` (mpv's growing cache
length is deliberately suppressed).

## Audio focus: `@rn-media/audio-session`

One line for the common case — duck on navigation prompts, pause on phone
calls, resume after, pause when headphones unplug:

```ts
import { wireAudioSession, AudioSessionPresets } from '@rn-media/audio-session';

const unwire = wireAudioSession(player, {
  preset: AudioSessionPresets.music,   // or .speech: pauses instead of ducking
  duckVolume: 0.3,
  resumeAfterInterruption: true,
});
```

Or take manual control:

```ts
import { AudioSession, AudioSessionPresets } from '@rn-media/audio-session';

await AudioSession.configure(AudioSessionPresets.music);
const granted = await AudioSession.activate();   // requests focus; only play if true
if (granted) player.play();

AudioSession.addListener('interruption', (e) => {
  if (e.begin) e.type === 'duck' ? player.setVolume(0.3) : player.pause();
  else if (e.shouldResume) player.play();
});
AudioSession.addListener('becomingNoisy', () => player.pause());
```

`wireAudioSession` accepts anything with `{ play, pause, setVolume, getVolume }`
— it is not coupled to our Player.

## Lock screen & background: `@rn-media/media-session`

The [`audio_service`](https://pub.dev/packages/audio_service) model: every
command surface (notification, lock screen, Bluetooth, headset, watch) funnels
into **one handler you implement**; you broadcast state through three channels,
and every surface — including your own UI — renders from them.

```ts
import { BaseMediaHandler, MediaService } from '@rn-media/media-session';

class PlaybackHandler extends BaseMediaHandler {
  async play()            { player.play(); }
  async pause()           { player.pause(); }
  async stop()            { player.pause(); await MediaService.stopService(); }
  async seekTo(pos)       { await player.seekTo(pos); }
  async skipToNext()      { /* your queue logic — resolve URLs lazily, anything */ }
  async skipToPrevious()  { /* … */ }
  async onTaskRemoved()   { /* app swiped away — default keeps playing if playing */ }
}

const service = await MediaService.init(() => new PlaybackHandler(), {
  android: {
    notificationChannelId: 'playback',
    notificationChannelName: 'Playback',
    notificationIcon: 'ic_notification',   // a drawable in your app
  },
});
```

Broadcast state whenever it changes (typically from `player.onStateChange`):

```ts
service.setMediaItem({
  id: track.id, title: track.title, artist: track.artist,
  artworkUri: track.art, duration: state.duration,
});
service.setPlaybackState({
  status: state.playing ? 'playing' : 'paused',
  position: { value: player.getPosition(), at: Date.now(), rate: state.rate },
  controls: ['previous', 'playPause', 'next'],
  capabilities: ['seek', 'setRate'],
});
service.setQueue(tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist })));
```

The position anchor is converted to the monotonic clock **once** on the native
side and projected from there — the lock-screen scrubber advances with zero
JS involvement.

**How background playback works (and its honest limits):**

- Commands are handled **native-first**: the notification's pause button acts
  immediately; your JS handler is notified after, never on the critical path.
- On Android, the media3 foreground service keeps the process — and with it
  the JS runtime — alive. Your handlers keep working after the Activity is
  destroyed. Verified on-device.
- **JS timers freeze in the background** (an RN platform behavior). Handlers,
  promises, and network callbacks work; `setTimeout`-based logic does not.
  Keep timing on the native side (this library already does).
- An unhandled exception in a JS handler can take down the whole JS runtime
  mid-playback — `MediaService` wraps handler dispatch and reports errors
  instead of letting them propagate.
- iOS keeps the process alive while audio plays (`UIBackgroundModes: audio`).
  Force-quit kills playback — true of every iOS app.

### Composition

```ts
class WithAnalytics extends CompositeMediaHandler {
  async play() { analytics.log('play'); await super.play(); }
}
MediaService.init(() => new WithAnalytics(new PlaybackHandler()), config);
```

`QueueHandler` (mixin) provides default `skipToNext`/`skipToPrevious`/
`skipToQueueItem` over the broadcast queue with optional wraparound.

## The example app

[`apps/example`](apps/example) is the reference integration — a queue of live
streams and files with transport controls, focus wiring, and full media-session
integration. One structural lesson it encodes: **keep the player and session at
module scope, not inside a React component** — component-owned playback dies
with the Activity.

```sh
npm install
cd apps/example/android && ./gradlew :app:assembleDebug   # or: npm run android
```

## Limitations (current, honest)

- **HLS: both platforms — but verified to different depths.** Both platforms
  now ship our own libmpv builds, each of which is the matching media-kit
  release plus two ffmpeg flags (`--enable-demuxer=hls`,
  `--enable-demuxer=mpegts`); stock media-kit *audio* binaries omit both, so
  `.m3u8` used to fail with a clean `unsupported-format` error.
  - Android — [`afkcodes/libmpv-android-audio-build@v1.1.9-rnmedia.2`](https://github.com/afkcodes/libmpv-android-audio-build/releases/tag/v1.1.9-rnmedia.2)
    — **device-verified**: HLS confirmed playing on real hardware.
  - iOS — [`afkcodes/libmpv-darwin-build@v0.7.2-rnmedia.2`](https://github.com/afkcodes/libmpv-darwin-build/releases/tag/v0.7.2-rnmedia.2)
    — **link-verified via CI only**. The demuxers are present in the shipped
    binary and the frameworks compile, link and embed, but **runtime HLS
    playback on an iOS device remains unverified**. Treat iOS HLS as expected
    to work, not as proven.

  HTTPS, ICY/Icecast, and direct files work on both. (On both platforms the
  player forces `demuxer=lavf` for `.m3u8`/`.m3u` so mpv's playlist demuxer
  can't explode your queue with segment entries.)
- **EQ/DSP: both platforms, identical filter set.** The same two pins also add
  16 LGPL audio filters (`volume`, the biquads, `anequalizer` /
  `superequalizer` / `firequalizer`, `acompressor`, `alimiter`, `dynaudnorm`,
  `loudnorm`, `crossfeed`, plus the non-optional `aresample`) — stock
  media-kit audio builds compile in only `overlay` and `equalizer`, so `af=`
  resolved to nothing. `setAudioFilters` needs no platform branching. On an
  older or overridden binary the call fails honestly with `{ code: 'mpv',
  errno: -11 }`, which is the supported availability probe. Verified in the
  shipped iOS binary; like HLS, not yet exercised on an iOS device.
- **No DRM**, by construction — libmpv has no Widevine/FairPlay. This library
  cannot power a licensed-catalog streaming app.
- **iOS is code-complete and CI-built, but never run on a device** — it
  compiles, links and embeds the frameworks in CI; no on-device playback,
  background-audio or lock-screen behaviour has been observed yet.
- Chromecast is out of scope (use the Cast SDK app-side); AirPlay audio works
  through normal iOS routing.
- App-killed → media-button playback resumption is not implemented in v1.

## Licensing

- **This library: MIT.**
- The bundled libmpv/FFmpeg binaries are **LGPL v3** (built without GPL
  components, `--enable-version3`). They are **dynamically linked** (`.so` in
  the APK, embedded dynamic xcframeworks on iOS — the App Store-accepted
  pattern), which is what the LGPL's relink requirement needs. Ship your app's
  licenses screen with the mpv/FFmpeg notices. Both platforms' binaries are
  built by our forks of media-kit's build scripts —
  [`libmpv-android-audio-build`](https://github.com/afkcodes/libmpv-android-audio-build/tree/rn-media-hls)
  and
  [`libmpv-darwin-build`](https://github.com/afkcodes/libmpv-darwin-build/tree/rn-media-hls)
  — and in each the only change is the same set of additive ffmpeg configure
  flags (two demuxers + 16 audio filters; every GPL-gated ffmpeg filter is a
  *video* filter, so the LGPL line is untouched). Both forks are public and
  both are forks of public upstreams, which covers the source + relink
  obligations.

## Development

```sh
npm install                # workspace root
npm test                   # per-package: cd packages/<p> && npm test
npm run test:cpp --prefix packages/player   # host C++ tests (EventBatch, lifecycle)
npm run typecheck --prefix packages/player
```

Monorepo layout, architecture decisions, and the roadmap live in
[`PLAN.md`](PLAN.md); per-package contracts in [`docs/specs/`](docs/specs).
The C++ core binds only `mpv/client.h` — video support is designed to arrive
later as a separate opt-in plugin package with its own binaries, at zero cost
to audio-only users.

## Roadmap (next)

1. **On-device iOS verification** — HLS- and filter-capable binaries now ship
   on both platforms (`v0.7.2-rnmedia.2` for iOS, `v1.1.9-rnmedia.2` for
   Android), but iOS has only ever been compiled and linked, never run: actual
   playback, background audio, lock-screen controls and the EQ chain are still
   unobserved.
2. Typed shuffle, ICY now-playing metadata, ReplayGain, prefetch controls
3. iOS CI verification + first published release
4. Android Auto / CarPlay browse trees; typed EQ/DSP; FFT visualizer taps
5. Expo config plugin
