# The full comparison table

The root [`README.md`](../README.md#why-this-exists) carries the rows a chooser
weighs. This page carries **every** row, plus where each cell came from — so a
reader can check the table rather than trust it.

| | [track-player](https://rntp.dev) | [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/) | [rn-video](https://github.com/TheWidlarzGroup/react-native-video) | [queue-player](https://ghenry22.github.io/react-native-queue-player/) | **timbre** |
|---|---|---|---|---|---|
| Engine | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | not documented | **libmpv 0.41.0 + FFmpeg 8.1.2 — our own build** |
| One identical engine on both platforms | ❌ two engines | ❌ | ❌ | — | ✅ 103 mpv options a side, **101 identical** (the two that differ are the platform's audio device) |
| Formats | platform codecs | platform codecs | platform codecs | not documented | everything FFmpeg decodes — MP3, AAC/M4A, FLAC, OGG/Opus, HLS, ICY/Icecast, TrueHD, embedded cover-art streams (decoded, extraction API planned), legacy-charset tags |
| Multiple players | ❌ singleton | ✅ | ✅ | ❌ singleton | ✅ one mpv core each |
| Background + media session | ✅ best-in-class | ✅ lock screen + notification | ⚠️ notification controls | ✅ | ✅ media3 `MediaLibraryService`, native-first commands |
| Session layer works with *any* player | ❌ | ❌ | ❌ | ❌ | ✅ (`@timbre/media-session` is player-agnostic) |
| Gapless queue | ⚠️ | ✅ | ❌ | ✅ | ✅ 25 ms handover, measured on-device |
| Signed / expiring URLs stay gapless | ❌ | ❌ | ❌ | ❌ | ✅ resolver runs at **prefetch** time — our own mpv patch |
| Per-source HTTP headers | ✅ | ✅ | ✅ | ⚠️ global config only | ✅ typed; CR/LF/colon rejected as request splitting |
| EQ / DSP | ❌ | ❌ | ❌ | ✅ 10-band | ✅ 16 ffmpeg filters, 22 tuned EQ presets |
| Pitch, independent of rate | ❌ correction algorithms only | ❌ | ❌ | ❌ | ✅ `setPitch(ratio)` — mpv's first-class `--pitch` |
| Chapters (read + navigate) | ❌ | ❌ | ⚠️ tvOS, app-supplied marks | ❌ | ✅ `getChapters()`, `state.chapter`, next/previous |
| Sleep timer | ❌ a DIY guide (V5, commercial, ships one) | ❌ | ❌ | ✅ duration / end-of-track, with fade | ✅ native, duration + end-of-track (no fade) |
| Spectrum visualizer | ❌ | ❌ | ❌ | ✅ | ✅ both platforms, no `RECORD_AUDIO` |
| Crossfade | ❌ | ❌ | ❌ | ✅ | ❌ deliberately — built, listened to, dropped ([Limitations](../README.md#limitations)) |
| Casting (Chromecast / AirPlay) | ❌ (V5, commercial: Chromecast/Android + AirPlay/iOS, platform-split) | ❌ | ❌ app-side | ✅ | ✅ Chromecast, both platforms — session handoff, receiver-side queue, live streams; Android device-verified, iOS CI-verified (device pass pending) |
| Remote (receiver) volume from the app | ❌ | ❌ | ❌ | ❌ | ✅ Android `setRemotePlayback`, plus the hardware keys, foreground or screen off. iOS is a documented platform no-op |
| Android Auto / CarPlay | ⚠️ controls only | ❌ | ❌ | ✅ | ✅ browse + voice (Auto), CarPlay templates |
| DRM (Widevine/FairPlay) | ⚠️ announced | ❌ | ✅ | not documented | ❌ libmpv cannot ([Limitations](../README.md#limitations)) |
| Native binary it adds | ≈none (platform codecs) | ≈none | ≈none | — | 3.63 MB downloaded for `arm64-v8a`, ≈7.1 MB for the iOS device slice ([Requirements](../README.md#requirements)) |

## Method

Every cell in the four competitor columns comes from that project's **own
documentation**, read on 2026-08-12/13. Nothing here is inferred from source
code, a benchmark, or a maintainer's reputation; where a project does not
document a capability, the cell says "not documented" rather than "❌".

The Casting row was re-verified on 2026-08-14 against rntp.dev, expo-audio's
docs, react-native-video's own "no, use react-native-google-cast" answer on
their tracker, and doublesymmetry/react-native-track-player's maintainer comment
that cast support "was removed due to issues with React Native itself" and would
return as a separate addon — it never shipped.

## The track-player column is V4

`react-native-track-player` V4 is the **open-source baseline**, and that is the
column. V5 is a commercial rewrite, and where it advertises something V4 lacks
— a sleep timer, a Chromecast/AirPlay split — the cell says so in parentheses
rather than crediting or discrediting the open-source package for it.

## Our own cells

Every ✅ in the `timbre` column is a claim this repo has to be able to prove:

| claim | where the evidence is |
|---|---|
| 103 mpv options a side, 101 identical | [`ARCHITECTURE.md` §11](../ARCHITECTURE.md), and [docs/engine.md](engine.md#one-configuration-not-two) |
| 25 ms gapless handover; 644 ms without prefetch | measured on a physical Poco F4, release build — [docs/engine.md](engine.md#what-it-costs-at-runtime) |
| Resolver runs at prefetch time | our own mpv source patch, proven present in the shipped binary — [docs/engine.md](engine.md#features-upstream-will-not-ship) |
| 16 ffmpeg filters, 22 EQ presets | [`@timbre/player`](../packages/player/README.md#audio-filters-and-eq) |
| Visualizer on both platforms, no `RECORD_AUDIO` | PCM-tap patch — [`@timbre/player`](../packages/player/README.md#visualizer-spectrum--waveform) |
| Casting, Android device-verified / iOS device pass pending | [`@timbre/cast`](../packages/cast/README.md) |
| Remote (receiver) volume from the app; hardware keys, foreground or screen off | [`@timbre/media-session`](../packages/media-session/README.md#remote-playback-hardware-volume-keys-drive-the-other-device) |
| Binary sizes | [Requirements](../README.md#requirements), byte-exact |

The cells that favour a competitor stay in the table on purpose: crossfade
(shipped by queue-player, [deliberately dropped
here](../README.md#limitations)), DRM (react-native-video has it, libmpv cannot),
and the native binary size — a shipped engine costs megabytes that platform
codecs do not.

## Android Auto

A row corrected on 2026-08-27 after reading the sources rather than the READMEs.
`react-native-track-player`'s README says "Android Auto — full support"; its
engine (`KotlinAudio`, `MediaSessionCallback.kt`) handles play / pause / next /
previous / forward / rewind / stop / seek / rating and nothing else — no
`MediaLibraryService`, no browse tree, no `onPlayFromSearch`. That is the car's
Now Playing screen driven by an ordinary media session, which every media3 app
gets; it is not a browsable app. `react-native-queue-player` genuinely ships it
(Nitro-based `BrowseDataProvider` + a full `CarPlay*` Swift set), with a
push-a-static-snapshot design; ours pulls from the handler and caches natively so
dynamic trees work and a cold car connection still answers (ARCHITECTURE §31).

## A different job: `react-native-audio-api`

[`react-native-audio-api`](https://github.com/software-mansion/react-native-audio-api)
is not in the table because it is not an alternative. It implements the **Web
Audio API** — an audio *graph* for synthesis, games and per-sample DSP — a
paradigm this library does not attempt, and the reverse holds for queues, lock
screens and background survival. They compose: `@timbre/media-session` takes
any player structurally, so a Web-Audio app can drive our lock-screen and
background layer.
