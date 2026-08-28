# timbre

[![Android CI](https://img.shields.io/github/actions/workflow/status/afkcodes/timbre/android-build.yml?branch=main&label=Android%20CI&logo=android&logoColor=white)](https://github.com/afkcodes/timbre/actions/workflows/android-build.yml)
[![iOS CI](https://img.shields.io/github/actions/workflow/status/afkcodes/timbre/ios-build.yml?branch=main&label=iOS%20CI&logo=apple&logoColor=white)](https://github.com/afkcodes/timbre/actions/workflows/ios-build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![React Native ≥ 0.82](https://img.shields.io/badge/React%20Native-%E2%89%A5%200.82-61dafb?logo=react&logoColor=white)](#requirements)

React Native audio playback built on [libmpv](https://mpv.io), with a
player-agnostic media-session layer: lock screen, notification, Bluetooth and
background playback that keep working after the app's UI is gone. Four
independent packages with no cross-dependencies — a player, an audio-focus
arbiter, a media session that drives lock screens for *any* player, and a
Chromecast sender. The C++ core binds libmpv's client API through
[Nitro Modules](https://nitro.margelo.com), with no bridge layer.

> **Status: v0.1.0 — published, early, pre-1.0.** The packages are on npm under
> `@afkcodes/timbre-*` and the install line below works. The Android stack is
> device-verified end to end; iOS playback and the media notification are
> device-verified; cast and CarPlay on iOS are not yet. The API may still change
> before 1.0.

<p align="center">
  <img src="docs/assets/demo.gif" width="330"
       alt="The example app: a track playing, a scrub across the timeline, the equaliser morphing its ten-band curve across presets, and the live FFT visualiser reacting to the audio." /><br>
  <sub><a href="apps/example">The example app</a>: play → seek → equaliser
  presets (the curve morphs) → live FFT visualiser.</sub>
</p>

## Install

```sh
npm install @afkcodes/timbre-player @afkcodes/timbre-audio-session @afkcodes/timbre-media-session react-native-nitro-modules
cd ios && pod install   # downloads + verifies the pinned libmpv xcframeworks
```

Setup is one `Info.plist` key on iOS and nothing on Android. See
[Requirements](#requirements).

## Quick start

A gapless music player with a lock screen, a notification and a session that
survives process death.

```ts
// src/playback.ts
import { Player } from '@afkcodes/timbre-player'
import { AudioSession, AudioSessionPresets, wireAudioSession } from '@afkcodes/timbre-audio-session'
import {
  BaseMediaHandler, MediaService, withPersistence,
  type MediaItem, type PersistedMediaService,
} from '@afkcodes/timbre-media-session'
import { storage, type Track } from './library'

let player: Player
let service: PersistedMediaService
let queue: readonly Track[] = []

const toItem = (t: Track): MediaItem => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album,
  artworkUri: t.artworkUri, duration: t.durationMs,
})

class Handler extends BaseMediaHandler {          // every remote surface lands here
  override play(): void { player.play() }
  override pause(): void { player.pause() }
  override async seekTo(ms: number): Promise<void> { await player.seekTo(ms / 1000) }
  override async skipToNext(): Promise<void> { await player.playlist.next() }
  override async skipToPrevious(): Promise<void> { await player.playlist.previous() }
  override onTaskRemoved(): void { service.save() }
}

function broadcast(): void {
  const s = player.state
  service.setPlaybackState({
    status: s.playing ? 'playing' : 'paused',
    position: s.positionAnchorMs,   // an anchor; every surface projects it locally
    controls: ['skipToPrevious', 'pause', 'skipToNext'],
    capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
    queueIndex: s.playlist.index,
  })
}

export async function start(): Promise<void> {
  player = await Player.create({ prefetchPlaylist: true })   // one mpv playlist, gapless
  wireAudioSession(player, { preset: AudioSessionPresets.music })
  service = withPersistence(
    await MediaService.init(() => new Handler(), {
      android: { notificationChannelId: 'playback', notificationChannelName: 'Playback' },
    }),
    storage,
  )
  player.onStateChange(broadcast)
  player.on('trackChanged', ({ index }) => {
    const track = queue[index]
    if (track !== undefined) service.setMediaItem(toItem(track))
  })
}

export async function playAlbum(tracks: readonly Track[]): Promise<void> {
  queue = tracks
  await AudioSession.activate()          // before play(), always
  service.setQueue(tracks.map(toItem))
  await player.loadPlaylist(tracks.map((t) => t.url))
}
```

```js
// index.js — a bare side-effect import, so the module runs at boot
import './src/playback'
import App from './App'
```

## Recipes

Whole apps, not snippets. Each one is code that runs.

| Recipe | What it covers |
|---|---|
| [A music player](docs/recipes/music-player.md) | Queue, gapless, shuffle and repeat, artwork, persistence, an EQ screen |
| [A radio app](docs/recipes/radio.md) | Live streams, ICY now-playing, reconnection, no scrubber |
| [A podcast / audiobook player](docs/recipes/podcast-audiobook.md) | Chapters, speed, ±30 s, a native sleep timer, resume position |
| [A self-hosted library client](docs/recipes/self-hosted-library.md) | Signed and expiring URLs that stay gapless, per-source auth headers |
| [In the car](docs/recipes/in-the-car.md) | Android Auto and CarPlay from one browse handler, plus voice |
| [Cast to a speaker](docs/recipes/cast.md) | Chromecast handoff, receiver-side queue, one set of UI channels |

## Which packages do I need?

Four separate installs with no dependencies on each other. Take the rows that
describe your app and ignore the rest.

| You want | Install |
|---|---|
| Audio playback, a gapless queue, EQ, chapters, a visualizer | [`@afkcodes/timbre-player`](packages/player/README.md) |
| …that keeps playing in the background, on the lock screen and in the notification | **+** [`@afkcodes/timbre-media-session`](packages/media-session/README.md) |
| …that ducks for navigation prompts, pauses for calls and stops when the headphones come out | **+** [`@afkcodes/timbre-audio-session`](packages/audio-session/README.md) |
| …that can hand off to a Chromecast | **+** [`@afkcodes/timbre-cast`](packages/cast/README.md) |
| …that the car can browse — Android Auto tabs, CarPlay templates, voice "play X" | already in `media-session`: implement `getChildren` + `playFromMediaId` |
| A lock screen for a player that is **not** ours — RNTP, `expo-audio`, a TTS engine | `media-session` **alone** |
| Focus / interruption handling for someone else's player | `audio-session` **alone** |

Both session packages take their player through a *structural* interface, so
nothing forces you to adopt the engine to use the session layer, or the reverse.

## Why this exists

| | [track-player](https://rntp.dev) | [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/) | [rn-video](https://github.com/TheWidlarzGroup/react-native-video) | [queue-player](https://ghenry22.github.io/react-native-queue-player/) | **timbre** |
|---|---|---|---|---|---|
| Engine | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | not documented | **libmpv 0.41.0 + FFmpeg 8.1.2 — our own build** |
| One identical engine on both platforms | ❌ two engines | ❌ | ❌ | — | ✅ 103 mpv options a side, **101 identical** (the two that differ are the platform's audio device) |
| Formats | platform codecs | platform codecs | platform codecs | not documented | everything FFmpeg decodes — MP3, AAC/M4A, FLAC, OGG/Opus, HLS, ICY/Icecast, TrueHD, legacy-charset tags |
| Multiple players | ❌ singleton | ✅ | ✅ | ❌ singleton | ✅ one mpv core each |
| Session layer works with *any* player | ❌ | ❌ | ❌ | ❌ | ✅ (`@afkcodes/timbre-media-session` is player-agnostic) |
| Gapless queue | ⚠️ | ✅ | ❌ | ✅ | ✅ 25 ms handover, measured on-device |
| Signed / expiring URLs stay gapless | ❌ | ❌ | ❌ | ❌ | ✅ resolver runs at **prefetch** time — our own mpv patch |
| EQ / DSP | ❌ | ❌ | ❌ | ✅ 10-band | ✅ 16 ffmpeg filters, 22 tuned EQ presets |
| Casting (Chromecast / AirPlay) | ❌ (V5, commercial: Chromecast/Android + AirPlay/iOS, platform-split) | ❌ | ❌ app-side | ✅ | ✅ Chromecast, both platforms — session handoff, receiver-side queue, live streams |
| Android Auto / CarPlay | ⚠️ controls only — no browse tree, no play-from-search ([source](docs/comparison.md#android-auto)) | ❌ | ❌ | ✅ | ✅ browse tree + voice on Auto, CarPlay templates |
| DRM (Widevine/FairPlay) | ⚠️ announced | ❌ | ✅ | not documented | ❌ libmpv cannot ([Limitations](#limitations)) |
| Native binary it adds | ≈none (platform codecs) | ≈none | ≈none | — | 3.63 MB downloaded for `arm64-v8a`, ≈7.1 MB for the iOS device slice ([Requirements](#requirements)) |

The other eight rows — background sessions, headers, pitch, chapters, sleep
timer, visualizer, crossfade, remote volume — the sourcing for every cell, and
where `react-native-audio-api` fits, are in
**[docs/comparison.md](docs/comparison.md)**.

## API

Every export is tabulated in its package README.

| Package | Surface |
|---|---|
| [`@afkcodes/timbre-player`](packages/player/README.md#api) | Lifecycle and loading · playback · queue · state, metadata and chapters · hooks · events · audio processing · escape hatch |
| [`@afkcodes/timbre-media-session`](packages/media-session/README.md#api) | The service and its three channels · handlers and composition · persistence · the car's browse tree · sleep timer |
| [`@afkcodes/timbre-audio-session`](packages/audio-session/README.md#api) | Configure, activate, deactivate · interruption, noisy and route-change listeners · `wireAudioSession` |
| [`@afkcodes/timbre-cast`](packages/cast/README.md#api) | Discovery and sessions · receiver transport and queue · `wireCastHandoff` · `<CastButton/>` and hooks |

## Requirements

| | |
|---|---|
| React Native | **>= 0.82** (New Architecture); developed against 0.87.0 |
| Peer dependency | [`react-native-nitro-modules`](https://nitro.margelo.com) |
| Android | minSdk **24**, compileSdk **36**. Nothing to configure: the `media-session` manifest merges the foreground-service permissions, the `mediaPlayback` service, the Android Auto declaration and the artwork provider. `POST_NOTIFICATIONS` is not required for media notifications |
| iOS | **15.1+**; `@afkcodes/timbre-cast` raises the floor to **16.0** and needs **Xcode 26+** to build. One `Info.plist` key: `UIBackgroundModes` → `audio`. CarPlay adds a scene manifest and the `com.apple.developer.carplay-audio` entitlement |
| Expo | Prebuild workflow, no manual native edits: `"plugins": ["@afkcodes/timbre-media-session"]` covers the whole library. Expo Go cannot load it; use a development build. [Plugin reference](packages/media-session/README.md#expo-config-plugin) |
| Android binary | 3.63 MB downloaded for `arm64-v8a`; 7,338,952 bytes of stripped `libmpv.so`. The other three ABIs are in the same band |
| iOS binary | `Mpv.framework`'s device slice is 1,756,424 bytes; ≈7.1 MB across all ten frameworks |
| Google Play services | Casting only — without it `Cast.initialize()` resolves a typed `'unavailable'`, never a crash |
| Binary provenance | Downloaded at build time, pinned by tag **and** SHA-256; a mismatch is a hard build failure. [docs/engine.md](docs/engine.md) |

## Limitations

- **No DRM.** libmpv has no Widevine or FairPlay, so this cannot power a
  licensed-catalog streaming app.
- **iOS cast and CarPlay are unverified on a device.** iOS playback and the
  media notification are device-tested; `@afkcodes/timbre-cast` and CarPlay have not
  been run on Apple hardware — CI compiles and inspects them, but no session
  has been observed.
- **Force-quitting on iOS kills playback**, and nothing may restart the app for
  audio afterwards — which is why `playbackResumption` is Android-only.
- **An iOS sleep timer armed over silence may never fire**, because iOS suspends
  a backgrounded process once audio stops.
- **No crossfade.** Built, listened to, and dropped by owner decision
  ([ARCHITECTURE](ARCHITECTURE.md#12-defaults-chosen-by-measurement-each-overridable)).
- **Embedded cover art decodes but cannot be extracted yet.** Pass artwork from
  your own library as `MediaItem.artworkUri`
  ([ARCHITECTURE](ARCHITECTURE.md#11-binaries-pinned-forked-lgpl-dynamically-linked)).
- **Casting has real ceilings**: receivers decode far less than mpv, no `file://`
  sources, no header auth without your own Web Receiver, no lock-screen controls
  during an iOS session, and AirPlay-as-handoff is out of scope. AirPlay audio
  *output* works today with no code — it is an ordinary iOS system output route.
- **Persistence has two edges**: the 30 s autosave rides a JS timer that Android
  freezes once the Activity is gone, so add `service.save()` on `AppState`; and a
  live stream saves position `0`.
- **CarPlay has never run.** It compiles on CI and mirrors Android Auto's handler
  contract; no Simulator or head-unit session has been observed.
- **Cold browse from the car needs `android.playbackResumption: true`.** Without
  it the car sees the last cached lists until the app is opened.

## Roadmap

Naming and the first npm publish are done — the four packages are live at
v0.1.0. Next up, owner-approved: `@afkcodes/timbre-downloads` (offline playback
as a source resolver), LRC lyrics, then video as an additive plugin package.
Still to prove on hardware: iOS cast and CarPlay. Full analysis:
[`PLAN.md`](PLAN.md).

## Licensing

**This library: MIT.** The bundled libmpv/FFmpeg binaries are **LGPL v3** (built
with `--enable-version3`, never `--enable-gpl`) and **dynamically linked** — the
App Store-accepted pattern that satisfies the relink obligation. Ship your app's
licenses screen with the mpv/FFmpeg notices. Both binaries come from our public
forks of media-kit's build scripts,
[`libmpv-android-audio-build`](https://github.com/afkcodes/libmpv-android-audio-build/releases/tag/v1.1.9-rnmedia.8)
and [`libmpv-darwin-build`](https://github.com/afkcodes/libmpv-darwin-build/releases/tag/v0.7.2-rnmedia.7),
both mpv 0.41.0 / FFmpeg 8.1.2 / mbedTLS 3.6.7. The full obligation chain:
[docs/engine.md](docs/engine.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the whole loop — setup, per-package
tests, the Gradle tasks CI runs, and what counts as verification here.
[`apps/example`](apps/example) is the reference integration and the on-device
test bed. [`ARCHITECTURE.md`](ARCHITECTURE.md) records every decision and its
evidence, [`PLAN.md`](PLAN.md) the analysis, [`docs/specs/`](docs/specs) the
per-package contracts, [`docs/engine.md`](docs/engine.md) the engine we build.
