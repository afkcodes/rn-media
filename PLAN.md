# rn-media — Analysis & Plan

A React Native audio + video playback library built on **libmpv**, with an
**audio_service-style service layer** that hooks into *any* player — not just its own.

*Status: planning. Written 2026-08-09 from research into audio_service, audio_session,
mpv_audio_kit, media-kit, mpv-android, MPVKit, react-native-track-player,
react-native-video v7, expo-video, and Nitro Modules.*

---

## 1. Why this should exist (gap analysis)

| Library | Audio | Video | Background / media session | Engine | Notes |
|---|---|---|---|---|---|
| react-native-track-player | ✅ excellent | ❌ explicitly out of scope | ✅ best-in-class (FGS + headless JS) | ExoPlayer / AVPlayer | Singleton only; conflicts with RNV's ExoPlayer |
| react-native-video v6/v7 | ⚠️ as side effect | ✅ | ⚠️ weak, view-bound (v6); v7 improving | media3 / AVPlayer | v7 = Nitro rewrite, player/view split |
| expo-video / expo-audio | ✅ | ✅ | ⚠️ basic (`showNowPlayingNotification`) | media3 / AVPlayer | SharedObject player/view split; Expo Modules runtime |
| Prior RN×mpv art | — | Android-only or abandoned | ❌ | libmpv | Dusk-Labs (dead 2023), pigeonmal (Android-only, no Nitro) |

**The niche is genuinely open**: no maintained cross-platform RN libmpv library exists,
and *no* RN library combines RNTP-grade background/media-session robustness with video.

What libmpv buys over ExoPlayer/AVPlayer:
- Every format/codec/container FFmpeg knows (mkv, flac, opus, ape, module formats, obscure streams), HLS/DASH, network protocols.
- One engine, one behavior across platforms (no ExoPlayer-vs-AVPlayer divergence bugs).
- Gapless playback, A-B loop, sample-accurate seek, playback speed/pitch (rubberband), ReplayGain, 87+ typed DSP filters (superequalizer, compressor, crossfeed…), FFT/PCM taps for visualizers, mpv hooks for lazy URL resolution and per-file HTTP headers.
- No ExoPlayer class conflicts with other libraries.

What it costs: binary size (~3 MB/ABI audio-only, ~6 MB/ABI video, LGPL flavor),
no Widevine/FairPlay DRM, and we own audio focus / media session / notifications
ourselves (mpv provides none of it — which is fine, that's exactly the layer we're
building anyway).

---

## 2. Core architecture: the three-layer split

Borrowed directly from the Flutter trio (just_audio / audio_session / audio_service),
which proved the separation. **Each layer is a separate npm package; the service layer
is player-agnostic by design** — that's the audio_service idea and the headline feature.

```
┌───────────────────────────────────────────────────────────────┐
│  @mpvkit/media-session        (the audio_service analog)      │
│  MediaHandler interface · media3 MediaSessionService ·        │
│  notification · lock screen · MPRemoteCommandCenter ·         │
│  MPNowPlayingInfoCenter · Android Auto browse tree            │
│  ── hooks into ANY player: ours, RNTP-style, expo-audio, TTS ─│
├───────────────────────────────────────────────────────────────┤
│  @mpvkit/audio-session        (the audio_session analog)      │
│  AVAudioSession config · AudioFocusRequest · interruptions ·  │
│  becoming-noisy · route/device changes                        │
├───────────────────────────────────────────────────────────────┤
│  @mpvkit/player               (the just_audio/media-kit analog)│
│  Nitro C++ HybridObject binding libmpv directly ·             │
│  multi-instance Player objects · VideoView (Nitro HybridView) │
├───────────────────────────────────────────────────────────────┤
│  @mpvkit/libmpv-android  /  @mpvkit/libmpv-ios   (binaries)   │
│  audio & video flavors, LGPL builds, prebuilt per release     │
└───────────────────────────────────────────────────────────────┘
```

(Package names are placeholders — see Open Questions.)

### Why the split matters

- Apps that only need a better player take `@mpvkit/player` (no service ceremony).
- Apps that already have a player (RNTP, expo-audio, even a WebView or TTS engine)
  can adopt `@mpvkit/media-session` alone — the same "hooks into any audio playback"
  pitch that made audio_service the standard in Flutter.
- Multiple audio libraries in one app stop fighting over AVAudioSession/AudioFocus
  because `@mpvkit/audio-session` is the single arbiter (audio_session's exact
  raison d'être).

---

## 3. Layer 1 — `player` (libmpv binding)

### Module tech: Nitro Modules

- **Pure C++ HybridObject** binds libmpv's C client API directly — no Kotlin/Swift
  bridge layer for playback control. Android links `libmpv.so` via CMake; iOS vendors
  an xcframework via podspec with Swift↔C++ interop.
- Validated choice: react-native-video v7 rewrote on Nitro for exactly this domain;
  ~15× faster calls than TurboModules; works old+new arch for modules.
- **Nitro HybridViews** (for `VideoView`) require RN ≥ 0.78 + New Architecture —
  acceptable floor for a new library in 2026.

### Player object model (expo-video / RNV v7 convention)

```ts
const player = createPlayer({ flavor: 'audio' });   // or useMpvPlayer(source) hook
await player.load({ uri, headers, startPosition });
player.play();
player.observe('time-pos');        // typed property streams
player.setProperty('speed', 1.5);
player.command(['loadfile', uri, 'append-play']);   // raw escape hatch, always

// video: view attaches to a player, not the other way round
<MpvVideoView player={player} style={...} />
```

- **Multi-instance from day one** (RNTP's singleton is its most-cursed limitation).
  libmpv supports multiple cores; `--ao=audiounit` multi-instance was fixed in
  libmpv-darwin-build v0.7.2 (June 2026).
- **State model** copied from media-kit/mpv_audio_kit: immutable `player.state`
  snapshot + typed event subscriptions, seeded by `mpv_observe_property`'s guaranteed
  initial notification.
- **Escape hatches always exposed**: `command()`, `getProperty()`, `setProperty()`,
  mpv hooks (`beforeStartFile` etc. → lazy source resolvers, the Plex/Jellyfin
  use case mpv_audio_kit nailed).

### Threading (the part that must be right)

- One dedicated native thread per player runs `mpv_wait_event(handle, -1)` — the
  only thread allowed to (libmpv rule). All other calls are thread-safe.
- Events marshal to JS via Nitro callbacks — **batched/coalesced**, never one JSI
  hop per `time-pos` tick.
- **Position is not streamed** (audio_service's deliberate design): broadcast position
  only on discontinuities (seek/pause/speed change); ship a `useProgress()` hook that
  *projects* position client-side from `updateTime + elapsed × speed`. Near-zero
  bridge traffic during steady playback.

### Video rendering

- **Android**: the `--wid` Surface path (mpv-android / media-kit pattern), not the
  render API. Hand libmpv an `ANativeWindow` from a `SurfaceView` (TextureView
  fallback option, per expo-video's SurfaceView overlap bug); `vo=gpu`,
  `gpu-context=android`, `hwdec=auto-safe`. Encode the known workarounds from
  media-kit's source: set `vo=null` before changing `wid`; reinit after
  `--android-surface-size`; force software decode on emulators; expect the
  "BufferQueueProducer already connected" mediacodec playlist-transition bug and
  handle surface release properly.
- **iOS**: libmpv **render API** (`vo=libmpv`) → OpenGL-ES into CVPixelBuffer/
  IOSurface-backed textures (media-kit's proven path), or evaluate MPVKit's
  libplacebo/Metal-adjacent variants. This is the fiddliest single component —
  hence video ships in a later phase (see roadmap).
- Backgrounding video: detach surface / `vid=no` on background (audio keeps playing),
  reattach on foreground.

## 4. Layer 2 — `audio-session`

Small, boring, essential. API is a direct port of audio_session:

```ts
await AudioSession.configure(AudioSessionPresets.music);  // or .speech — duck vs pause
const granted = await AudioSession.activate();            // focus request; play only if true
AudioSession.addListener('interruption', ({ begin, type }) => { /* duck | pause */ });
AudioSession.addListener('becomingNoisy', () => player.pause());
```

- iOS: AVAudioSession category/mode/options wrapper + interruption & route-change
  notifications. Android: AudioAttributes + AudioFocusRequest + ACTION_AUDIO_BECOMING_NOISY.
- `player` consumes it by default (opt-out, like just_audio's `handleInterruptions: false`)
  so the simple case needs zero code, but apps can own the policy.
- Fix audio_session's known fragility: config is an explicit injected dependency of
  players, not ambient "configure after all plugins load" convention.

## 5. Layer 3 — `media-session` (the audio_service analog)

The differentiator. Player-agnostic by contract:

```ts
class MyHandler extends BaseMediaHandler {
  async play()             { this.player.play(); }
  async pause()            { this.player.pause(); }
  async seekTo(pos)        { this.player.seek(pos); }
  async skipToNext()       { /* your queue logic — resolve URLs lazily, anything */ }
  async customAction(name, extras) { ... }
}

const handler = await MediaService.init(() => new MyHandler(), {
  android: { notificationChannelId: '...', stopForegroundOnPause: true },
});

// broadcast — the ONLY state source for notification, lock screen, watch, Auto, and your own UI:
handler.setMediaItem({ id, title, artist, artworkUri, duration });
handler.setPlaybackState({ playing: true, controls: [Control.pause, Control.next], position, speed });
handler.setQueue([...]);
```

Design decisions (each one a lesson from audio_service's history):

1. **Uniform callback fan-in**: remote commands from notification, lock screen,
   Bluetooth, headset clicks, watch, Android Auto, and the app's own UI all funnel
   through one handler interface. State fans out from three broadcast channels
   (`playbackState` / `mediaItem` / `queue`) to every surface.
2. **media3 from day one** (`MediaSessionService`/`MediaLibraryService`) — audio_service
   is still trapped on deprecated androidx.media because retrofitting media3's
   Player-centric design is a rewrite. We start there: implement a **facade
   `androidx.media3.common.Player`** whose methods proxy to the JS handler and whose
   state mirrors the broadcast `playbackState`. media3 then gives us the notification,
   session, and Auto integration "for free" and future-proofs the Android side.
3. **One JS runtime, kept alive by platform primitives** (audio_service 0.18's hard-won
   lesson: they shipped a two-isolate model and killed it). Android: foreground service
   (`foregroundServiceType="mediaPlayback"`) holds the RN host alive — RNTP proves this
   works, including surviving app-swipe-kill via the headless mechanism. iOS: the
   `audio` background mode keeps the process (and JS) alive while audio plays. No
   separate "playback service JS context" — the handler runs in the main runtime.
4. **stop-vs-pause semantics named unambiguously** (recurring audio_service FAQ):
   `handler.stopService()` ends background execution; `pause()` never does. Document
   the Android reality that a paused, demoted service is killable → provide an
   optional persistence decorator.
5. **Handler composition**: `CompositeMediaHandler` wrappers for analytics/persistence,
   `QueueHandler`-style mixin with default next/previous/skipTo logic over the queue.
6. **Android FGS edge cases budgeted for up front** (RNTP's scar tissue):
   `ForegroundServiceStartNotAllowedException` on Android 12+ (can't start FGS from
   background), Android 13 notification redesign (stop/ff/rewind become custom
   actions), Android 14 FGS type enforcement, notification-swipe-dismiss handling,
   `onTaskRemoved` forwarded to JS so the app decides keep-playing vs stop.
7. **Android Auto / CarPlay** via `getChildren`/`getMediaItem`/`search` handler
   callbacks (media3 MediaLibraryService browse tree) — later phase, but the handler
   interface reserves the methods now.

## 6. Binaries & licensing

- **Reuse, don't rebuild**: media-kit's build repos are the most valuable assets in
  this whole space and are separate from media-kit's (now limited-maintenance) Dart code:
  - Android: `libmpv-android-audio-build` / `libmpv-android-video-build` (lineage:
    mpv-android buildscripts). Audio default ≈ 3 MB/ABI, video default ≈ 6 MB/ABI (compressed).
  - iOS: `libmpv-darwin-build` (audio-default ≈ 2.5 MB, video-default ≈ 6 MB compressed)
    or MPVKit (heavier, SwiftPM, includes libplacebo/Dolby Vision; GPL variant adds smbclient).
  - Fork them into the org for supply-chain control; CI (GitHub Actions) attaches
    artifacts to releases; Gradle/CocoaPods download at build time (media-kit pattern).
- **Two flavors**: `audio` (slim, for RNTP-replacement use cases) and `video`.
  Consumers pick via the binary package they install.
- **Licensing rules** (non-negotiable for adoptability):
  - Build FFmpeg **without** `--enable-gpl` (no x264/libsmbclient) → bundle stays LGPL.
    CORRECTION (2026-08-09, verified from the shipped binaries' configure line): the
    darwin builds carry `--enable-version3`, so the effective license is **LGPL v3**,
    not v2.1+. Same obligations model (dynamic linking + relink ability + source
    offer); README licensing section must say LGPL v3.
  - Cross-platform pin policy: Android and iOS binaries may pin different mpv
    versions (today: Android 0.35.1 / API 2.0, iOS 0.36.0 / API 2.1). The vendored
    headers in `cpp/third_party/mpv` MUST track the OLDER of the two (API floor);
    newer-only symbols (e.g. `mpv_del_property`) are off-limits to shared C++.
  - **Dynamic linking on both platforms**: `.so` in APK (inherently dynamic); embedded
    dynamic xcframework on iOS (the App Store-accepted pattern — VLC/mpv-ios precedent).
  - Publish build scripts (satisfies LGPL relink obligation); ship license texts;
    document consumer obligations in the README.
  - Wrapper code MIT.

## 7. Monorepo layout

```
rn-media/
├── packages/
│   ├── player/            # Nitro module: C++ libmpv binding + VideoView
│   │   ├── cpp/           #   MpvPlayer HybridObject, event thread, render glue
│   │   ├── android/       #   CMakeLists, Surface glue, emulator detection
│   │   ├── ios/           #   podspec, render-API/pixel-buffer glue
│   │   └── src/           #   TS: Player class, hooks, .nitro.ts specs
│   ├── audio-session/     # focus / AVAudioSession / interruptions
│   ├── media-session/     # handler, media3 service, MPRemoteCommandCenter
│   ├── libmpv-binaries/   # gradle/pod glue that fetches prebuilt libmpv (audio|video)
│   └── expo-plugin/       # config plugin: Info.plist background mode, manifest FGS perms
├── apps/
│   └── example/           # audio queue + video + background demo app
└── build/                 # forked libmpv build scripts / CI
```

Tooling: create-nitro-module / nitrogen codegen, TypeScript strict, Turborepo or
plain workspaces, example app on RN latest.

## 7.5 DECISION (2026-08-09): video is an additive plugin, not part of core

The core product is the **audio module** (player + audio-session + media-session),
built fully for Android and iOS. Video ships later as a separate opt-in package.

Architectural consequences, enforced from day one:

- **Core never links video code**: the C++ core uses only `mpv/client.h` (never
  `render.h`), core binaries are the audio-flavor builds (~3 MB/ABI, no libass),
  and mpv cores are created with `vid=no`/`--vo=null` defaults.
- **`@rn-media/video` plugin contract**: the Player HybridObject exposes a narrow
  native attachment surface (`attachVideoOutput(...)` / `detachVideoOutput()` +
  the raw handle for plugin-side render setup). The video plugin brings its own
  `VideoView` HybridView, its own video-flavor binaries, and swaps the binary
  dependency (gradle flavor / pod subspec) — installing it must not require any
  change to core code.
- Apps without the plugin pay zero video cost (binary size, permissions, code).

## 7.9 IMPLEMENTATION STATUS (2026-08-09)

**Phases 0–3 are COMPLETE and device-verified** (physical Android 16 device;
iOS is code-complete and CI-built — it compiles, links and embeds the libmpv
xcframeworks — but has never been run on a device; Expo config plugin from
Phase 3 deferred).
Phase 4 (video plugin) not started; Phase 5 backlogged. Shipped and proven:

- `@rn-media/player` — multi-instance libmpv Player; typed state/reducer;
  position projection; gapless playlists; typed errors; live-stream detection
  (`isLive`, honest duration); HLS playlist-demuxer guard; default HTTP
  user-agent (`rn-media (libmpv)` — mpv's bare `libmpv` UA is 401-blocklisted
  by real Shoutcast hosts, found on-device); log-level name mapping; raw mpv
  escape hatches; `usePlayer`/`usePlayerState`/`useProgress`. 224 TS + 26 C++
  tests.
- `@rn-media/audio-session` — focus/AVAudioSession arbiter, interruption/
  noisy/route events, music/speech presets, `wireAudioSession`. 41 tests.
- `@rn-media/media-session` — media3 1.11 MediaLibraryService +
  SimpleBasePlayer facade; monotonic position anchors (zero bridge traffic);
  native-first commands; FGS lifecycle incl. Android 12/13/14 edge cases;
  channel-priority merge (setMediaItem over current queue entry);
  `onTaskRemoved`; dev-reload teardown; iOS MPRemoteCommandCenter/NowPlaying
  with tracked target removal + artwork cache. 68 tests.
- Example app = reference integration: queue, in-app seekbar + notification
  scrubber, dark theme, focus wiring, media handler, Shoutcast AAC+ live radio
  (Diverse FM), typed-error demo (HLS entry).
- On-device proven: audiotrack output via `mpv_lavc_set_java_vm`;
  notification/lock-screen fan-in to JS; activity-death + swipe-kill survival;
  lock-screen seek; live-vs-finite display.
- Infra: SHA-256-pinned binaries both platforms; CI workflows; monorepo;
  phase-wise git history; root README.

## 8. Roadmap

**Phase 0 — Spike (de-risk)**
Nitro C++ HybridObject that creates an mpv core and plays an audio URL on Android +
iOS using prebuilt binaries. Proves: CMake link, xcframework link, event thread → JS
callback, Swift↔C++ interop. *Go/no-go gate.*

**Phase 1 — Audio player core**
Player object model, typed property observation, state snapshot, load/play/pause/seek/
speed, playlist/gapless, error taxonomy (network EOF vs natural end), raw command
escape hatch, `useProgress()` projection hook, multi-instance.

**Phase 2 — audio-session**
Presets, activate/focus, interruption + becoming-noisy events, default wiring into
Player (opt-out).

**Phase 3 — media-session** ← the differentiator; ship a credible v1 here
Handler interface + broadcast state, media3 MediaSessionService + facade Player,
notification + lock screen + MPRemoteCommandCenter/MPNowPlayingInfoCenter, foreground
service lifecycle incl. Android 12/13/14 edge cases, `onTaskRemoved`, Expo config
plugin. **v1.0 = phases 1–3, audio-first.**

**Phase 4 — Video**
`MpvVideoView` HybridView: Android Surface/`--wid` path with known workarounds, iOS
render-API path, fullscreen, background detach/reattach, track selection, subtitles
(needs libass → video binary flavor).

**Phase 5 — Power features**
Typed DSP/EQ API (subset of mpv_audio_kit's 87 filters), FFT/PCM visualizer streams,
mpv hooks/source resolvers, Android Auto + CarPlay browse, casting story (out of
scope for mpv itself — document), persistence decorator.

## 8.5 Music-app feature coverage (added 2026-08-09, "Spotify-class" audit)

Covered in v1: gapless playlist/queue, metadata→system UI, custom actions+icons
(Android), live/ICY streams, background+focus, pitch-corrected speed,
loop modes, all ffmpeg formats the binaries enable.

**HLS — DONE on both platforms (2026-08-09).** media-kit's stock
*audio* binaries do NOT include ffmpeg's `hls`/`mpegts` demuxers (verified from
the configure line embedded in libmpv.so, and reproduced on-device as a clean
`unsupported-format`); `--enable-protocol=hls` is present but that is the
deprecated `hls://` protocol and is useless without the demuxer. Fixed by
forking the build scripts as §6 always planned:
`afkcodes/libmpv-android-audio-build`, branch `rn-media-hls` off `v1.1.9`,
released as **`v1.1.9-rnmedia.1`** (now superseded by `v1.1.9-rnmedia.2`, which adds the audio-filter set — see ARCHITECTURE §18) and pinned in
`packages/player/android/libmpv.gradle` (owner is now a pin field). The delta
versus the shipped v1.1.9 binaries is exactly
`--enable-demuxer=hls --enable-demuxer=mpegts` — same mpv 0.35.1 / ffmpeg n6.0
source tree, same patches (incl. `mpv_lavc_set_java_vm`), identical exported
symbol set, +54 KB/ABI, still LGPLv3. Everything else HLS needs was already in
the allow-list and was checked rather than assumed: `mov` (fMP4 segments),
`ac3`/`aac*`/`mpegaudio` parsers, the `crypto` protocol for AES-128
(`CONFIG_CRYPTO_PROTOCOL 1` in the generated config, not just on the command
line), and id3v2 (compiled unconditionally by libavformat).
**iOS now has the same treatment**, via the same recipe:
`afkcodes/libmpv-darwin-build`, branch `rn-media-hls` off `v0.7.2`, released as
**`v0.7.2-rnmedia.1`** and pinned in `packages/player/ios/libmpv.pin` (repo
owner is a pin field there too). The delta versus upstream v0.7.2 is again
exactly `--enable-demuxer=hls --enable-demuxer=mpegts` — same mpv 0.36.0 /
ffmpeg 6.0 / mbedTLS 3.4.1, still LGPLv3. Verified from the released asset on
Linux rather than assumed: the configure-line diff is exactly +2 flags / -0;
the demuxers are genuinely compiled in (HLS's `m3u8_hold_counters` AVOption and
mpegts's `resync_size` / `skip_unknown_pmt` / `fix_teletext_pts` /
`merge_pmt_versions` are present and all absent upstream); `Mpv`'s defined
export set is byte-identical (53 symbols), as are Avcodec/Avfilter/Avutil/
Mbed*/Swresample/Swscale; only libavformat grew (+67 KB on the device slice),
adding three `avpriv_mpegts_parse_*` symbols and imports of
`avpriv_ac3_parse_header` / `avpriv_adts_header_parse` / `avcodec_get_type` /
`av_buffer_pool_*` — ffmpeg's documented `hls_demuxer_select` chain and nothing
else. The fork's CI was also trimmed to build just the one
`ios-universal-audio-default` target (6.5 min instead of the ~40-archive
matrix).

**The two platforms are not equally proven.** Android HLS was reproduced
playing on a device; iOS is **link-verified via CI only** — the frameworks
fetch, pod-install, link and embed, and the demuxers are demonstrably in the
shipped binary, but **runtime playback on an iOS device remains unverified**.
That on-device check is now the top iOS task.

Also: mpv's playlist demuxer parses `.m3u8` as a plain playlist (queue
explosion) unless `demuxer=lavf` is forced for HLS URIs — guard shipped in the
player.

**Backlog A — typed-API gaps (mpv already capable, raw escape hatch works today):**
- shuffle (`playlist-shuffle`/`playlist-unshuffle`)
- stream metadata OUT: typed `metadata` map + ICY `icy-title` updates (radio now-playing)
- ReplayGain / loudness normalization options
- network cache tuning + `prefetch-playlist` (next-track preload)
- `isLive` detection surfaced in PlayerState

**Backlog B — designed-for, deferred (Phase 5):** FFT/PCM visualizer
taps, Android Auto/CarPlay browse, crossfade (two
Player instances + volume ramp — multi-instance makes this possible).

*Shipped out of Backlog B since:* typed EQ/DSP (ARCHITECTURE §18); the
queue/position persistence decorator and the native sleep timer, plus the
`stopForegroundTimeoutMs` knob (ARCHITECTURE §19); and **app-killed →
media-button/System-UI playback resumption** (ARCHITECTURE §20), which persistence
had already half-solved — the missing piece was a *native-readable* mirror of the
snapshot, since the app's storage engine is JavaScript and JavaScript is exactly
what a resumed process lacks. Opt-in (`android.playbackResumption`), Android only,
device-verified 2026-08-10.

**Fundamental limits (document, don't fight):** no DRM (Widevine/FairPlay) — mpv
cannot; target audience is non-DRM audio (indie/self-hosted/Plex/Jellyfin/
Subsonic/podcasts/radio/audiobooks). Chromecast = Cast SDK, app-level (same as
every RN player). AirPlay audio works via iOS system routing.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| iOS video render path (GL deprecated, pixel-buffer interop fiddly) | High | Audio-first v1; copy media-kit's working path; evaluate MPVKit variants |
| Android mediacodec/Surface lifecycle bugs | Medium | Known workarounds already documented in media-kit source; encode them from day one |
| media3 facade-Player impedance (the thing audio_service couldn't retrofit) | Medium | Prototype in Phase 3 early; fallback is platform MediaSessionCompat like RNTP |
| FGS restrictions (Android 12–15) | Medium | RNTP's issue history is the test plan |
| Binary size objections | Low | Audio flavor ≈ 3 MB/ABI + ABI splits; document honestly |
| LGPL FUD from consumers | Low | Dynamic linking + published scripts + clear README section |
| New Arch / RN 0.78 floor | Low | Fine for a 2026 greenfield lib; modules (non-view) still work on old arch |
| Bus factor (mpv_audio_kit's and media-kit's shared weakness) | Medium | Small core, three focused packages, contributor docs early |

## 10. Open questions

1. **Naming** — working title `rn-media`; npm scope? (`@mpvkit/*` clashes with iOS MPVKit; maybe `@rn-media/*`, `react-native-mpv-*`, or a brandable name.)
2. **v1 scope** — recommendation above is audio-first (phases 1–3) with video in 4; confirm.
3. **Expo support level** — config plugin only (recommended), or also an Expo Modules wrapper?
4. **Queue ownership** — JS-owned queue with handler callbacks (audio_service model, maximum flexibility, needs JS alive) vs optional native queue fallback for post-kill resilience. **Settled:** JS-owned, and the post-kill case no longer argues against it — ARCHITECTURE §20's native snapshot mirror gives the service a readable queue with no JS alive, without moving queue *ownership* out of JavaScript.
5. **Windows/macOS/TV** — libmpv supports them all; out of scope for v1, keep the C++ core portable.
