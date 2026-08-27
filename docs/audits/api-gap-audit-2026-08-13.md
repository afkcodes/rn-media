# rn-media public API gap audit

Repo state read at HEAD `6ca2753`. READ-ONLY audit.

**Excluded by instruction** (already being implemented): queue entries view,
`setPrefetchPlaylist`, retryable errors + bounded retry, `clearError`,
id/ICY/insert doc contracts, audio-device selection (roadmap #38), casting,
Android Auto/CarPlay browse (roadmap #2), downloads (roadmap #3),
`setLoudnessNormalization` / LRC lyrics / `usePrefetchStatus` (roadmap #4),
pitch investigation (roadmap #5).

---

## 0. Inventory of what we ship today

### `@afkcodes/timbre-player`

**`Player`** — `create(PlayerOptions)`, `load(src, LoadOptions)`,
`loadPlaylist(sources, LoadPlaylistOptions)`, `play` / `pause` / `toggle`,
`seekTo(seconds)`, `setRate`, `getVolume` / `setVolume` / `setMuted`,
`setLoop(LoopMode)`, `setReplayGain`, `setAudioFilters` / `clearAudioFilters` /
`getAudioFilters`, `getMetadata` / `getMetadataValue`, `getPosition` /
`resyncPosition`, `setSourceResolver`, `on` / `onStateChange`, `state`,
`destroy`, `destroyed`, `visualizer`, and the raw escape hatch
(`command`, `getProperty{String,Number,Bool}`, `setProperty{…}`,
`observeProperty` / `unobserveProperty`, `getRawHandle`).

**`Player.playlist`** — `add(source, {position:'next'|number, play})`,
`remove`, `move`, `jumpTo`, `next`, `previous`, `clear`, `shuffle`, `unshuffle`.

**`PlayerState`** — `status` (idle/loading/buffering/ready/ended/error),
`playing`, `duration?`, `positionAnchor`, `bufferedPosition?`, `rate`, `volume`,
`muted`, `loop`, `loopRaw`, `playlist{index,count}`, `error?`, `title?`,
`seeking`, `seekable?`, `isLive`, `coreIdle`, `idleActive`, `eofReached`.

**Events** (`PlayerEventMap`) — `trackEnded`, `trackChanged`, `metadataChanged`,
`prefetchStarted`, `error`, `log`.

**`PlayerOptions`** — `mpvOptions`, `logLevel`, `userAgent`, `cacheSecs`,
`prefetchPlaylist`, `gaplessAudio`, `replayGain`, `volume`, `muted`, `rate`,
`loop`, `sourceResolver`, `resolverTimeoutMs`, `resolverTtlMs`, `createClient`,
`now`.

**`LoadOptions`** — `autoPlay`, `startPosition`, `mpvOptions`.
**`LoadPlaylistOptions`** — `+ startIndex`, `shuffle`.

**Hooks** — `usePlayer`, `usePlayerState`, `useProgress`, `useVisualizer`.

**DSP** — `AudioFilters.{equalizer,bass,treble,lowpass,highpass,
graphicEqualizer,crossfeed,compressor,limiter,dynamicNormalizer,loudnorm,
volume,custom}`, `EQUALIZER_PRESETS` (22), `defineEqualizerPreset`,
`equalizerPresetChain`, `peakResponseDb`.

**Engine filter allow-list actually compiled in (17)** — `aresample aformat
anull volume bass treble lowpass highpass anequalizer superequalizer
firequalizer acompressor alimiter dynaudnorm loudnorm crossfeed` + upstream
`equalizer`. Notably **absent**: `pan`, `silenceremove`, `atempo`, `asetrate`,
`afade`, `astats`, `ebur128`, `adelay`, `compand`, `agate`, `speechnorm`,
`stereotools`/`extrastereo`, `bs2b`.

### `@afkcodes/timbre-audio-session`
`AudioSession` / `createAudioSession`, `AudioSessionPresets` (music, speech, …),
`wireAudioSession({duckVolume, resumeAfterInterruption})`; `configure`,
`activate`, `deactivate`, `addListener('interruption'|'becomingNoisy'|
'routeChange')`.

### `@afkcodes/timbre-media-session`
`MediaService.init` / `createMediaService`, `setPlaybackState` / `setMediaItem` /
`setQueue`, `stopService`, `setSleepTimer` / `cancelSleepTimer` /
`getSleepTimerRemaining`, `setResumptionSnapshot`; `BaseMediaHandler`,
`CompositeMediaHandler`, `QueueHandler` / `withQueueHandling`,
`withPersistence` / `restorePersisted` / `applyPersisted` / `clearPersisted`,
validators.
`MediaControl` = play|pause|stop|skipToNext|skipToPrevious|fastForward|rewind.
`MediaCapability` = play|pause|stop|seek|skipToNext|skipToPrevious|
skipToQueueItem|setRate.
`MediaItem` = id, title, artist?, album?, artworkUri?, duration?, genre?.

---

## Confirmed-from-repo facts that anchor the gaps below

- **`Player` has no `stop()`.** `command(['stop'])` is used internally by
  `loadPlaylist` only. Every competitor has stop/reset.
- **No typed per-source HTTP headers.** `PlayerOptions.userAgent` is global;
  headers are only reachable through `LoadOptions.mpvOptions` /
  raw `http-header-fields`. `PlaylistAddOptions` has **no** `mpvOptions` at all,
  so a queued entry cannot carry auth headers, a start offset, or a demuxer
  hint.
- **`PlayerEventMap` has no `seeked` / `queueEnded` / `stateChanged` events**;
  `SeekEvent` exists in the raw `PlayerEvent` union but never reaches
  `player.on(...)`.
- **`PlayerState` exposes no buffering percentage** — only `bufferedPosition`
  (second-quantised) and a derived `buffering` status.
- **`PlayerErrorCode`** has no `timeout` / `not-found` / `auth` members.
- **Media-session jump intervals are hardcoded and DIVERGENT**:
  `RemoteCommandBinding.swift:60` pins `skipInterval = 15` seconds both ways;
  Android never calls `setSeekBackIncrementMs` / `setSeekForwardIncrementMs`, so
  media3's `SimpleBasePlayer` defaults apply (**5 s back / 15 s forward**).
  Same app, two behaviours. This is a parity-gate violation, not just a gap.
- **`MediaCapability` has no repeat / shuffle / rating / like-dislike members**,
  though media3 (`COMMAND_SET_REPEAT_MODE` / `COMMAND_SET_SHUFFLE_MODE`) and
  `MPRemoteCommandCenter` (`changeRepeatModeCommand`, `changeShuffleModeCommand`,
  `likeCommand`, `dislikeCommand`, `ratingCommand`) both support them.
- **`MediaItem` is 6 fields.** No `albumArtist`, `trackNumber`, `discNumber`,
  `year`, `description`, `isLive`, `mediaType`, `rating`, `extras`,
  `artworkData`.
- **No embedded cover-art extraction anywhere** in the repo — the README's
  "cover art" claim is a decode-format claim only. An audio-only mpv build runs
  `audio-display=no`, so the attached-picture stream is never decoded and the
  bytes are unreachable from the client API.
- **No `color` in `AndroidMediaSessionConfig`** (notification accent).
- **Persistence stores exactly one global session** — no per-item resume points
  / bookmarks.
- **Engine filter set excludes** `pan` (balance / mono downmix),
  `silenceremove` (skip-silence), `atempo` / `asetrate` (pitch),
  `afade` (fade in/out), `astats` / `ebur128` (loudness + peak metering).

## Competitor landscape correction (material, read from live docs)

- **react-native-track-player has forked.** V4 (`react-native-track-player@4.1.2`,
  Apache-2.0) is **frozen** on branch `v4`; **V5 (`@rntp/player`, up to v5.7.0) is
  dual-licensed / commercial** — free only for personal + educational use, source
  not public, and rntp.dev now serves V5 docs exclusively (old V4 doc URLs 404).
  Strategically: the free/OSS bar in the ecosystem is now RNTP V4 (frozen) +
  expo-audio, and **V5's feature set under an OSS license is the parity target
  worth aiming at**. The README table's "track-player" column should say which.
- **react-native-queue-player is not a thin library.** It is Nitro-based
  (Swift/Kotlin), and ships EQ + visualizer + crossfade + ReplayGain + sleep
  timer + CarPlay/Android Auto/Siri browse & voice + a lookahead disk cache +
  AirPlay2/Chromecast/DLNA/Sonos casting with a bundled AirPlay2 C
  implementation. It is the closest thing to a direct competitor we have, and
  several of the gaps below come from it alone.
- **expo-audio** now has `useAudioPlaylist` (native gapless playlist object),
  preload APIs, and PCM sampling (`useAudioSampleListener`).

---

## 1. TIER A — cheap and obvious (TS-only, over properties/commands we already have)

Everything here is pure TypeScript over an mpv property or command the binding
already reaches. No native code, no engine flag, no new package.

| # | Gap | Exposed by | Cost | Verdict |
|---|---|---|---|---|
| A1 | **`Player.stop()`** — unload the current file, keep the player alive (`command(['stop'])`). We use it internally in `loadPlaylist` but never expose it. Every competitor has stop/reset. | RNTP V4+V5, just_audio, queue-player, expo | TS-only | **Add now** |
| A2 | **`Player.seekBy(deltaSeconds)`** — relative seek (mpv `seek <n> relative`). Currently every app re-derives `getPosition() + delta`, which races the projection. | RNTP V4 `seekBy` / V5 `seekBy`, audio-pro `seekForward/seekBack` | TS-only | **Add now** |
| A3 | **`skipToPrevious` semantics: restart-or-previous.** The universal music-app convention (press ⏮ → restart if >~3 s into the track, else previous). We only have `playlist.previous()`, which always moves. Example app confirms no restart path. | RNTP V5 (`skipToPrevious` restarts past ~3 s), queue-player `skipToPreviousBehavior` | TS-only (option on `playlist.previous({ restartThreshold })`) | **Add now** |
| A4 | **`hasNext` / `hasPrevious` / `canSkipNext` / `canSkipPrevious`** on `PlayerState`, computed atomically from `playlist{index,count}` + `loop`. Apps currently recompute and get it wrong under loop modes. queue-player ships `getSkipCapability()` as an *atomic pair* specifically to avoid torn reads. | just_audio (`hasNext`, `nextIndex`, `previousIndex`), queue-player | TS-only | **Add now** |
| A5 | **`queueEnded` event.** We have `trackEnded` per entry and a sticky `ended` status, but no "the whole queue finished" signal — the single most common hook for autoplay/radio-mode/recommendations. | RNTP V4 `PlaybackQueueEnded`, queue-player `onQueueEnd` | TS-only (reducer already knows) | **Add now** |
| A6 | **`seeked` / position-discontinuity event with a reason.** `SeekEvent` exists in the raw `PlayerEvent` union and `isPositionDiscontinuity()` is exported, but `PlayerEventMap` has no member — so an app cannot observe a seek or a gapless auto-advance without polling. just_audio's `positionDiscontinuityStream` carries `reason: seek \| autoAdvance` plus before/after events; that is exactly the shape analytics needs. | just_audio | TS-only | **Add now** |
| A7 | **Typed common metadata.** `getMetadata()` returns a raw tag map, so every app writes its own `title ?? TITLE ?? icy-title` normalizer across FLAC/Vorbis/ID3/MP4/ICY key spellings. A `getCommonMetadata(): CommonMetadata` (title, artist, album, albumArtist, trackNumber, discNumber, year, genre, composer, comment, station) over the same single node read is pure TS and removes the most-copied snippet in the ecosystem. | RNTP `AudioCommonMetadata`, just_audio tag convention | TS-only | **Add now** |
| A8 | **Playback milestones** — `onPlaybackMilestone(25 \| 50 \| 75 \| 90)`, forward-only, once per playthrough, seek-past consumed silently. This is scrobbling (Last.fm / "mark as played" / podcast completion) and it is pure arithmetic over the position projection we already have. Nobody else in RN has it except queue-player. | queue-player | TS-only | **Add now** |
| A9 | **Emit-current-value-on-subscribe.** queue-player's state-ish events (`onSkipCapabilityChange`, `onSleepTimerChange`, `onBufferStateChange`, …) all fire once at subscribe time, which kills the seed-then-subscribe race. Our `player.on()` never does; `onStateChange` doesn't either. A one-line `{ emitCurrent: true }` option. | queue-player | TS-only | **Add now** |
| A10 | **`MediaItem.extras: Record<string, unknown>`** — an opaque, app-owned payload round-tripped through the session (and through persistence). Every competitor has it; we force apps to keep a side-table keyed by `id`. | RNTP V5 `extras`, queue-player `TrackItem.extras` | TS + one nitro field (JSON string, same trick already used for `customAction` extras) | **Add now** |
| A11 | **Non-destructive shuffle mode.** `playlist.shuffle()/unshuffle()` mutate mpv's playlist. There is no `shuffleEnabled` flag, no `shuffleIndices`/`effectiveIndices` view, so "shuffle on, then turn it off and be where you were" is app-implemented. | just_audio (`setShuffleModeEnabled`, `shuffleIndices`, `effectiveIndices`), RNTP V5 (`setShuffleEnabled`/`isShuffleEnabled`) | TS-only (order table over mpv playlist) | **Add now** |
| A12 | **`PlayerErrorCode` depth.** 7 codes today, none of which separates `timeout` / `not-found` / `auth (401/403)` / `cleartext-blocked` / `http-error`. queue-player ships 12 and every one of them changes what a UI should say. Adjacent to the retry work already in flight — retry policy *needs* this discrimination (never retry a 403). | queue-player `PlaybackErrorCode` | TS-only (parse mpv's error string + `mpv_error`) | **Add now** |
| A14 | **`playlist.add()` accepts no per-entry options at all.** Confirmed in source: it calls `formatFileOptions(undefined, undefined, source)`, so a queued entry cannot carry `startPosition`, `mpvOptions`, headers, or a demuxer hint — while `load()` supports all of them. `buildLoadfileArgs` already threads a file-options string, so this is a pure widening of `PlaylistAddOptions`. An asymmetry no user would predict. | our own surface | TS-only | **Add now** |
| A13 | **Repeat count.** `LoopMode` is `off \| track \| playlist`; mpv's `loop-file`/`loop-playlist` take an integer count and we already keep `loopRaw`. Exposing "repeat this track 3×" is a type widening. | mpv | TS-only | Roadmap (low demand) |

## 2. TIER B — media-session gaps (native surface exists on both platforms)

| # | Gap | Exposed by | Cost | Verdict |
|---|---|---|---|---|
| B1 | **Jump intervals are hardcoded AND divergent.** `RemoteCommandBinding.swift:60` pins `skipInterval = 15` for both directions; Android never calls `setSeekForwardIncrementMs`/`setSeekBackIncrementMs`, so media3's defaults apply — `C.DEFAULT_SEEK_BACK_INCREMENT_MS = 5_000`, `C.DEFAULT_SEEK_FORWARD_INCREMENT_MS = 15_000` (verified in media3 1.11.0 `C.java`). So the same app skips back 5 s on Android and 15 s on iOS, and neither is configurable. Podcast/audiobook apps need 30 s. **This is a parity-gate violation, not merely a missing knob.** | RNTP V4 `forwardJumpInterval`/`backwardJumpInterval`, RNTP V5 `forwardInterval`/`backwardInterval` (both default 15), queue-player `setRemoteControls` | Native both sides (small) | **Add now — and it is a bug** |
| B2 | **No repeat / shuffle capability on remote surfaces.** `MediaCapability` has 8 members, none of them repeat or shuffle, though media3 has `COMMAND_SET_REPEAT_MODE` / `COMMAND_SET_SHUFFLE_MODE` and iOS has `MPRemoteCommandCenter.changeRepeatModeCommand` / `changeShuffleModeCommand`. Every notification-shade music player on Android shows these two buttons. | RNTP V5, queue-player, media3/MPRemoteCommandCenter | Native both sides + 2 handler methods + 2 state fields | **Add now** |
| B3 | **No rating / like / dislike / bookmark.** `MPRemoteCommandCenter` has `likeCommand`/`dislikeCommand`/`bookmarkCommand`/`ratingCommand`; media3 supports custom-command thumbs. RNTP V4 has `RatingType` (Heart, ThumbsUpDown, Three/Four/FiveStars, Percentage) + `FeedbackOptions`. We can only fake it with `customActions` (Android-only icons, no iOS semantics). | RNTP V4 | Native both sides | Roadmap (after B1/B2) |
| B4 | **`MediaItem` is 6 fields.** Missing `albumArtist`, `trackNumber`, `discNumber`, `year`/`date`, `description`/`subtitle`, `isLive`, `mediaType` (media3 `MediaMetadata.MEDIA_TYPE_*` — load-bearing for Android Auto browse and for the system distinguishing podcast/audiobook/music), `rating`, `extras` (A10), `artworkData`. media3 and `MPNowPlayingInfoCenter` both accept most of these today. | RNTP `AudioCommonMetadata`, media3, MPNowPlayingInfo | Nitro struct fields + native mapping | **Add now** (fields), roadmap (`mediaType`, `rating`) |
| B5 | **Sleep timer is one-shape.** `setSleepTimer(seconds)` only. No **fade-out** (queue-player fades 10 s then pauses; RNTP V5 takes `fadeOutSeconds`), no **"sleep at end of current track"** (`setSleepTimerToTrackEnd` / `sleepAfterMediaItemAtIndex`), no structured `getSleepTimer()` state (we return a bare number), no "defer if <60 s left". End-of-track is the mode most sleep-timer users actually want. | RNTP V5, queue-player | Native (timer already native); fade needs a volume ramp | **Add now** (end-of-track + structured state); fade = roadmap |
| B6 | **No notification accent `color`.** RNTP V4 has `color`; just_audio_background has `notificationColor`. We expose `notificationIcon` only. | RNTP V4, just_audio_background | One Android config field | **Add now** (trivial) |
| B7 | **No per-control icon overrides** (`playIcon`, `pauseIcon`, `nextIcon`, …). Our `customActions` carry icons but built-in controls do not. | RNTP V4 | Android config fields | Roadmap (low) |
| B8 | **No `placeholderArtworkUri`** for entries with no artwork — currently the lock screen just goes blank mid-queue. | queue-player | One config field | Roadmap (trivial, bundle with B6) |
| B9 | **`taskRemovedBehavior` is not configurable.** The native default policy (keep playing if playing, else stop) is fixed; `onTaskRemoved` is a side-effect hook, not a policy switch. RNTP exposes 3 behaviours (V4 `AppKilledPlaybackBehavior`) / 2 (V5). | RNTP V4+V5 | One Android config field | Roadmap |
| B10 | **Persistence stores exactly one global session.** No per-item resume points — the audiobook/podcast staple ("resume each book where I left it"). `PersistedSession` is `{playbackState, mediaItem, queue}`. | requirements sweep | TS-only decorator over the same storage interface | Roadmap (real demand, cheap) |
| B12 | **Lock-screen speed presets are hardcoded.** `RemoteCommandBinding.swift:130` sets `changePlaybackRateCommand.supportedPlaybackRates = Self.supportedRates`, a fixed constant. An audiobook app that offers 1.0/1.25/1.5/1.75/2.0/3.0 cannot say so to the OS. Same shape of bug as B1. | requirements sweep | One config field + native | **Add now** (bundle with B1) |
| B11 | **No `stateChangeReason`.** queue-player's `onStateChange(state, reason)` distinguishes user / system / error / interruption / route-change / queue-end / sleep-timer. We can already *derive* most of it (audio-session + media-session know) but nothing joins them. | queue-player | TS-only across packages | Roadmap |

**Feasibility verified, not assumed** (Tier B):
- `javap` on the shipped `media3-common-1.11.0-api.jar` confirms
  `protected ListenableFuture<?> handleSetRepeatMode(int)` and
  `handleSetShuffleModeEnabled(boolean)` on `SimpleBasePlayer` → **B2 Android
  side is a drop-in on the facade player we already own.**
- `SimpleBasePlayer.State.Builder` has `setSeekBackIncrementMs(long)` /
  `setSeekForwardIncrementMs(long)` → **B1 Android side is one State field.**
- `C.java` (media3 1.11.0): `DEFAULT_SEEK_BACK_INCREMENT_MS = 5_000`,
  `DEFAULT_SEEK_FORWARD_INCREMENT_MS = 15_000` — the source of the divergence.
- iOS side of B1/B2/B3 is `MPRemoteCommandCenter` (`skipForwardCommand`/
  `skipBackwardCommand.preferredIntervals` already used;
  `changeRepeatModeCommand`/`changeShuffleModeCommand`/`likeCommand`/
  `dislikeCommand`/`ratingCommand` are the additions). Apple's docs are
  JS-rendered and could not be quote-verified from this Linux box — **verify the
  exact symbol names and `MPRepeatType`/`MPShuffleType` enums against the SDK on
  the macOS CI box before implementing.**

## 3. TIER C — audio-session gaps

| # | Gap | Exposed by | Cost | Verdict |
|---|---|---|---|---|
| C1 | **No current-route introspection.** We emit `routeChange` with a `reason` and nothing else. Apps cannot render "Playing on AirPods" / "Playing on Bluetooth speaker" — a standard now-playing UI element — and cannot tell speaker from headphones to decide whether to auto-enable crossfeed. iOS `AVAudioSession.currentRoute` and Android `AudioManager.getDevices(GET_DEVICES_OUTPUTS)` + `AudioDeviceInfo.type` both provide it. | requirements sweep, queue-player `getCurrentAudioRoute`/`onAudioRouteChange` | Native both sides (read-only, small) | **Add now** |
| C2 | **No system-volume read/observe.** Music apps that draw a volume slider (or a "volume is at zero, that's why you hear nothing" hint) need it. | requirements sweep | Native both sides | Roadmap |
| C3 | **`AudioSessionPresets` has no `podcast`/`audiobook` variant** distinct from `speech`, and no preset documenting the `mixWithOthers` (background-ambience) case. | requirements sweep | TS-only | Roadmap (trivial) |
| C4 | **No `androidAudioSessionId`.** just_audio exposes it so apps can attach platform `AudioEffect`s / the platform visualizer. We have our own EQ and visualizer, so the need is much weaker — but third-party effect integrations are impossible without it. | just_audio | Native (Android only) → fails parity gate as a *feature*; fine as an Android-namespaced escape hatch | Roadmap, Android-namespaced |
| C5 | **No Wi-Fi lock for streaming.** `ARCHITECTURE.md:528` correctly notes playing audio holds the CPU awake, but nothing holds a `WifiLock`; RNTP exposes `wakeMode: 'none'\|'local'\|'network'` for exactly this. Screen-off HLS radio is device-verified, so this may already be a non-issue — but it is unverified and undocumented. | RNTP V5 | Investigation → maybe one Android line | Roadmap (investigate + document) |

## 4. TIER D — deliberate-no (stated, not silent)

| Gap | Why not |
|---|---|
| **DRM (Widevine / FairPlay)** | libmpv has no CDM integration and never will. Already documented in README Limitations. Correct call; keep it stated. |
| **Casting (Chromecast / AirPlay send)** | Already deferred with a reason (media3 `CastPlayer` replaces our engine; no AirPlay-out of mpv). queue-player's answer — a *bundled AirPlay2 C implementation* (libraop/ALAC/curve25519/pair_ap/openssl/libsodium) — shows what it actually costs: a second engine and a large native surface. Fails the parity gate and the size budget. Keep as deliberate-no; the README row is honest. |
| **Recording / microphone** (expo-audio `AudioRecorder`, `AudioStream`, nitro-sound) | Different product. This is a *playback* library; recording would drag in permissions, encoders and a whole second lifecycle. Deliberate-no. |
| **Server-side progress sync** (RNTP V5 `progressSync` HTTP POST) | App-level concern with an opinionated wire format baked into a player. Our `positionAnchor` + milestones (A8) give apps everything they need to do it themselves. Deliberate-no. |
| **Crossfade** | Already built, listened to, and scrapped by owner decision. Stated in README. |
| **Offline waveform / peaks extraction** (whole-file analysis for a static waveform) | Not a playback-time concern; needs a decode-faster-than-realtime path libmpv's client API does not offer. Belongs in `@afkcodes/timbre-downloads` or a separate tool. Deliberate-no *for `player`*; note as a downloads-package candidate. |
| **EQ / speed / settings persistence** | App storage is the app's. `defineEqualizerPreset` + a plain object is enough; a storage opinion in a player package is a liability. Deliberate-no. |
| **`setAllowsExternalPlayback` (iOS)** | An AVPlayer knob with no mpv equivalent; iOS system routing already handles AirPlay audio. Deliberate-no. |
| **`SilenceAudioSource` / `StreamAudioSource`-style app-supplied byte ranges** | The source-resolver + (future) downloads package cover the real use cases without inventing a stream protocol across the bridge. Deliberate-no for now. |

## 4b. Bugs / sharp edges found while auditing (not gaps — defects)

1. **`LoadPlaylistOptions.startPosition` is applied to EVERY queue entry.**
   `loadPlaylist` loops over `sources` and calls
   `formatFileOptions(options.mpvOptions, options.startPosition, source)` inside
   the loop, so `start=` is attached to every appended entry. The natural
   session-restore call —
   `loadPlaylist(tracks, { startIndex: 5, startPosition: 120 })` — therefore
   makes *every* track in the queue begin 120 s in. `LoadOptions.startPosition`
   is documented as "Start position in seconds"; `LoadPlaylistOptions` inherits
   it and says nothing. This directly undermines the persistence/resumption
   story the repo ships. Fix: apply `startPosition` only to the entry at
   `startIndex` (and document it), which the per-entry file-options path already
   supports.
2. **Jump intervals differ per platform** — see B1. 5 s back on Android,
   15 s back on iOS, from the same JS call.
3. **`playlist.add()` silently drops the options `load()` accepts** — see A14.
4. **`LoadOptions.mpvOptions` values are not escaped.** `formatFileOptions`
   builds `key=value` pairs and joins them with `,`, with no quoting:
   ```ts
   for (const [key, value] of Object.entries(options ?? {})) {
     parts.push(`${key}=${value}`)
   }
   return parts.length > 0 ? parts.join(',') : undefined
   ```
   Any value containing a comma corrupts the whole option list — and
   `http-header-fields`, the option an app would reach for to send an
   `Authorization` or a multi-valued header, is *itself* a comma-separated
   list. So the documented workaround for per-source headers ("use
   `mpvOptions`") is unsafe in exactly the case people need it. This is the
   strongest argument for a typed `headers` API (E-tier) rather than leaving it
   to the escape hatch — and the existing escape hatch should escape values
   regardless (mpv supports length-prefixed `%n%` quoting for option values).
   The sibling helper `escapeAfParam` in `filters.ts` shows the project already
   knows this class of bug; the loadfile path just never got the same treatment.

## 5. Music-app requirements sweep — coverage matrix

What a real app wires, and whether we cover it.

| Requirement | Covered? | Where |
|---|---|---|
| Now-playing: title/artist/album/artwork | ✅ | `getMetadata` + `setMediaItem` |
| Now-playing: **output device name** ("on AirPods") | ❌ | C1 |
| Now-playing: **format badge** (FLAC 24/96, bitrate, channels) | ❌ | E-tier (`audio-codec-name`, `audio-params`, `audio-bitrate`) |
| Now-playing: live/ICY radio title | ✅ | `metadataChanged` (+ ICY doc contract in flight) |
| Seek bar with buffered fill | ✅ | `bufferedPosition` / `useProgress` |
| Seek bar: **buffering %** while stalled | ❌ | E-tier (`cache-buffering-state`, `paused-for-cache`) |
| Seek: **relative jump buttons** | ⚠️ app-derived | A2 |
| Seek: **precision control** (fast keyframe scrub vs exact) | ❌ | E-tier |
| Queue: view / reorder / insert-next / clear | ✅ (view in flight) | `playlist.*` |
| Queue: **shuffle mode (non-destructive)** | ❌ | A11 |
| Queue: repeat off/one/all | ✅ | `setLoop` |
| Queue: **repeat/shuffle on the notification** | ❌ | B2 |
| Queue: **end-of-queue signal** | ❌ | A5 |
| Settings: playback speed (+ persistence) | ✅ / app-owned | `setRate` |
| Settings: **pitch correction toggle** | ❌ | E-tier (`audio-pitch-correction`) |
| Settings: **skip silence** | ❌ | E-tier — engine flag (`silenceremove` not compiled) |
| Settings: **mono downmix / balance** | ❌ | E-tier — `--audio-channels=mono` may cover mono; balance needs `pan` (not compiled) |
| Settings: EQ + presets | ✅ (best in class) | `AudioFilters`, 22 presets |
| Settings: EQ preset persistence | ❌ deliberate | Tier D — app storage |
| Settings: ReplayGain / loudness normalization | ✅ | `setReplayGain`; `loudnorm` on roadmap #4 |
| Headphones: pause on unplug | ✅ | `becomingNoisy` |
| Headphones: **crossfeed for headphone listening** | ✅ | `AudioFilters.crossfeed` |
| Interruptions: duck / pause / resume | ✅ | `wireAudioSession` |
| **A-B loop** | ❌ | E-tier |
| **Chapters** (audiobook m4b, podcast chapters) | ❌ | E-tier — this is the biggest single content-vertical gap |
| **Bookmarks / per-track resume** | ❌ | B10 |
| **Playback statistics / scrobbling** | ❌ | A8 |
| Sleep timer | ⚠️ partial | B5 (no fade, no end-of-track) |
| Audio device info / selection | ❌ | roadmap #38 (excluded) |
| Waveform / peaks (offline) | ❌ deliberate | Tier D |
| Live spectrum visualizer | ✅ (best in class) | `player.visualizer` |
| Casting | ❌ deliberate | Tier D |
| Offline / downloads | 🚧 | roadmap #3 (excluded) |
| Android Auto / CarPlay | 🚧 | roadmap #2 (excluded) |
| **Per-source HTTP headers (auth'd libraries: Jellyfin/Plex/Subsonic/Navidrome)** | ❌ | E-tier — **the single most surprising gap for our stated target audience** |

## 6. TIER E — mpv capabilities we ship but never typed

**Method note:** every claim below is verified against the *actual* mpv 0.41.0
manual sources (`DOCS/man/input.rst`, `DOCS/man/options.rst` at tag `v0.41.0`),
downloaded and grepped locally — not from model memory and not from a summary.

**The decisive fact for cost estimation**, `input.rst` "Property list" preamble:

> *"Most options can be set at runtime via properties as well. Just remove the
> leading `--` from the option name."*

So `ab-loop-a`, `ab-loop-b`, `ab-loop-count`, `audio-delay`,
`audio-pitch-correction`, `hls-bitrate`, `network-timeout`, `hr-seek`,
`audio-channels`, `volume-gain`, `keep-open` are all reachable **today** through
the `setProperty*` binding we already ship. Almost all of Tier E is TS-only.

| # | Gap | mpv facts (verified) | Cost | Verdict |
|---|---|---|---|---|
| E1 | **Per-source HTTP headers, typed and escaped.** Our target audience is explicitly Jellyfin / Plex / Subsonic / Navidrome / self-hosted — every one of which needs an `Authorization` or token header. Today headers are only reachable via `LoadOptions.mpvOptions`, which is **unescaped** (bug #4) and unavailable on `playlist.add()` at all (A14). | `--http-header-fields=<field1,field2>` — *"Set custom HTTP fields when accessing HTTP stream… This is a string list option"*. Also `--user-agent`, `--referrer`, `--http-proxy`, `--cookies`/`--cookies-file`, `--tls-verify`, `--network-timeout=<seconds>` (default 60). | TS-only (typed `headers` + correct list escaping) | **Add now — highest value in the audit** |
| E2 | **Chapters.** Audiobooks (m4b), podcasts and DJ mixes are core to our non-DRM target audience and we expose nothing. | `chapter` (RW) *"Current chapter number… first chapter is 0… Setting this property results in an absolute seek to the start of the chapter"*; `chapters` (count); `chapter-list` (RW) with scalar sub-properties `chapter-list/count`, `chapter-list/N/title`, `chapter-list/N/time` (*"Chapter start time in seconds as float"*); `chapter-metadata`; `--chapters-file=<filename>` for external chapters; and `--start='#2' --end='#4'` plays chapters 2–3. The scalar sub-properties mean **no `getPropertyMap` extension is needed** — `getPropertyString`/`getPropertyNumber` already reach every field. | TS-only | **Add now** |
| E3 | **Clipping: `end` / `length` per entry.** We ship `start` only. just_audio has `ClippingAudioSource` + `setClip()`; we cannot express "play 0:30–1:00" at all. | `--end=<relative time>` *"Stop at given time"*; `--length=<relative time>` *"Stop after a given time relative to the start time"*; both accept `[+\|-][[hh:]mm:]ss[.ms]`, `pp%`, `#c` chapter form. Both are per-file `loadfile` options, exactly like the `start` we already thread. | TS-only (extend `formatFileOptions`) | **Add now** |
| E4 | **A-B loop.** Language learners, musicians practising a passage, DJs. Nobody in RN has it. | `--ab-loop-a=<time>`, `--ab-loop-b=<time>` *"Set loop points. If playback passes the `b` timestamp, it will seek to the `a` timestamp"*; `--ab-loop-count=<N\|inf>` (default `inf`; `0` disables); `ab-loop` command cycles A→B→off; `remaining-ab-loops` property. `no`/unset disables. Fully audio-applicable. | TS-only | **Add now** |
| E5 | **Buffering percentage + honest stall state.** `PlayerState.status: 'buffering'` is derived from `core-idle`; there is no percentage and no way to distinguish "stalled on the network" from "paused". | `cache-buffering-state` — *"The percentage (0-100) of the cache fill status until the player will unpause"*; `paused-for-cache` — *"Whether playback is paused because of waiting for the cache"*. Both plain scalars, observable with the binding we have. Richer detail in `demuxer-cache-state` (`seekable-ranges` with `start`/`end`, `bof-cached`/`eof-cached` — *"If both … are true, and there's only 1 cache range, the entire stream is cached"* = a correct `isFullyBuffered()`, `fw-bytes`, `raw-input-rate`, `file-cache-bytes`). | TS-only (2 observed properties) | **Add now** |
| E6 | **Now-playing format introspection** ("FLAC 24-bit / 96 kHz", "AAC 256 kbps"). A visible differentiator for an audiophile-facing library, and queue-player ships it (`getNowPlayingFormat`). | `audio-params` sub-properties `format`, `samplerate`, `channels`, `channel-count`, `hr-channels`; `audio-out-params` (what the device actually got — the pair proves whether a downmix/resample happened); `audio-bitrate`; `file-format`; `track-list/N/codec` + `codec-desc` + `codec-profile`. All scalars. | TS-only | **Add now** |
| E7 | **Multiple audio tracks in one file + selection.** Commentary tracks, multi-language audiobooks, alternate mixes. We type nothing. | `track-list` with scalar sub-properties `track-list/count`, `/N/id`, `/N/type`, `/N/title`, `/N/lang`, `/N/codec`, `/N/default`, `/N/forced`, `/N/external`, `/N/hls-bitrate`, `/N/program-id`, **`/N/albumart`** (*"yes if this is an image embedded in an audio file or external cover art"*); `aid` property / `--aid=<ID\|auto\|no>`; `--alang`; `current-tracks/…`. | TS-only | Roadmap (real, lower demand than E1–E5) |
| E8 | **Pitch-correction toggle.** RNTP has `PitchAlgorithm`, expo has `shouldCorrectPitch`, queue-player has `setPitchCorrectionMode`. We hardcode mpv's default. | `--audio-pitch-correction=<yes\|no>` — *"If this is enabled (default), playing with a speed different from normal automatically inserts the `scaletempo2` audio filter."* Turning it off gives varispeed (tape-style) playback. Turning it off is varispeed; it is the companion to — not a substitute for — the real `pitch` property in E17. | TS-only | **Add now** (trivial; closes an RNTP/expo row honestly) |
| E9 | **Seek precision control.** `seekTo` always takes mpv's default. Scrubbing a 3-hour podcast wants fast keyframe seeks; the final drop wants exact. | `seek <target> [<flags>]` — flags `relative` (default), `absolute`, `absolute-percent`, `relative-percent`, `keyframes` (*"Always restart playback at keyframe boundaries (fast)"*), `exact` (*"Always do exact/hr/precise seeks (slow)"*), combinable with `+`. Default: `exact` for absolute seeks. Also `--hr-seek` default is `default` = *"Like absolute, but enable hr-seeks in audio-only cases"* — so our current behaviour is already exact; the gap is the **fast** option, not correctness. | TS-only | **Add now** (bundle with A2 `seekBy`) |
| E10 | **HLS variant selection.** just_audio has `setPreferredPeakBitRate`; we always take mpv's default (highest). On metered mobile data that is a user-visible cost. | `--hls-bitrate=<no\|min\|max\|<rate>>`, default `max`; a numeric value picks *"the stream with the highest rate equal or below the option value"*. | TS-only | **Add now** (trivial) |
| E11 | **Network/buffer tuning knobs.** We expose `cacheSecs` only. RNTP V4 exposes `minBuffer`/`maxBuffer`/`backBuffer`/`playBuffer`/`maxCacheSize`; queue-player exposes `networkTimeoutMs`. | `--network-timeout=<seconds>` (default 60; `0` = FFmpeg defaults; **ignored on RTSP by design**), `--demuxer-max-bytes` (150 MiB), `--demuxer-readahead-secs` (1), `--force-seekable`, `--stream-lavf-o`, `--cache-pause-wait` (1 s) / `--cache-pause-initial`. **And the one worth calling out for a mobile library: `--demuxer-hysteresis-secs`** (default 0 = off) — *"This can provide significant power savings and reduce load by making the demuxer only buffer ahead in chunks at a time rather than buffering ahead nonstop… A value of 10 seconds probably works well for most usecases."* A battery win we are leaving on the table on a project that measures screen-off CPU. Note also `--cache-secs` is documented as *only useful for limiting* readahead — real depth tuning goes through `--demuxer-max-bytes`. | TS-only | **Add now** (`networkTimeout` + `demuxerHysteresisSecs` at minimum) |
| E12 | **Disk-backed cache.** Partial answer to queue-player's lookahead cache. **Be honest about what it is:** `--cache-on-disk` — *"Write packet data to a temporary file, instead of keeping them in memory… The cache file is deleted when playback is closed."* Append-only, non-persistent. It relieves memory pressure on long streams; it is **not** offline playback. | `--cache-on-disk=<yes\|no>` (requires `--cache`), `--cache-dir`. | TS-only | Roadmap — and note in docs that real offline is `@afkcodes/timbre-downloads` |
| E13 | **`audio-delay`.** Bluetooth latency compensation; standard in every serious audio app's settings screen. | `--audio-delay=<sec>` — *"Audio delay in seconds (positive or negative float value)"*, settable at runtime as the `audio-delay` property. | TS-only | Roadmap (cheap, bundle with a settings release) |
| E14 | **Mono downmix.** Accessibility feature (single-sided hearing loss) present in both OS accessibility menus and in several music apps. | `--audio-channels=<auto-safe\|auto\|layouts>` explicitly supports *"`--audio-channels=<stereo\|mono>` — Force a downmix to stereo or mono."* **No filter needed, no engine flag needed.** | TS-only | **Add now** (trivial, real accessibility win) |
| E15 | **Balance / pan.** The sibling of E14 and the other half of the accessibility story. | Needs the `pan` filter, which is **NOT** in our compiled allow-list (`aresample aformat anull volume bass treble lowpass highpass anequalizer superequalizer firequalizer acompressor alimiter dynaudnorm loudnorm crossfeed` + `equalizer`). | **Engine flag** (`--enable-filter=pan`, +KB, LGPL-clean — `pan` is not GPL-gated) | Roadmap — bundle into the next engine flags release |
| E16 | **Skip silence.** just_audio has `setSkipSilenceEnabled`; RNTP V5 has `skipSilenceEnabled`. Valuable for podcasts/audiobooks. | Needs `silenceremove`, **NOT** compiled in. `scaletempo2` is the speed filter and is unrelated. | **Engine flag** (`--enable-filter=silenceremove`) | Roadmap — bundle with E15 into one flags release |
| **E17** | **TRUE PITCH SHIFT — and roadmap #5's premise is obsolete.** PLAN §8.1 item 5 records pitch as an *investigation* needing "an LGPL filter path (rubberband is GPL — banned; needs asetrate/atempo flags = a cheap workshop flags release)". **That is no longer true on the engine we already ship.** mpv gained a first-class `--pitch` option in 0.40, and we run **0.41.0**. | `--pitch=<0.01-100>` (verified at `options.rst:237`) — *"Raise or lower the audio's pitch by the factor given as parameter. **Does not affect playback speed.** Playing with an altered pitch automatically inserts the `scaletempo2` audio filter."* `scaletempo2` is mpv's own built-in (it already runs in `post_filters` for our speed handling — ARCHITECTURE §18), so **no ffmpeg filter, no engine flag, no GPL exposure**. Semitones are `pitch = 2^(semitones/12)`; the manual gives `--pitch=1.498307` = a perfect fifth. Range is bounded in practice by `scaletempo2`'s `min-speed`/`max-speed` (0.25/8.0) — the manual: *"a `min-speed` of 0.25 limits the highest pitch factor to 4"*. **And note the same limits mute audio outside `[0.25, 8]×` speed** — worth clamping `setRate` too. | **TS-only — one property write** | **Add now. Close roadmap #5's pitch line as already-shipped-capability.** |
| E21 | **Event-queue overflow is logged, never actioned.** `MpvClient.cpp:820` handles `MPV_EVENT_QUEUE_OVERFLOW` by pushing a `Warn` log line whose own comment says *"state derived from the stream may now be stale"* — and then nothing resyncs and no typed signal reaches JS. An app cannot react, and `PlayerState` can stay silently wrong. The honest fix is to re-read the observed property set on overflow (the machinery for that already exists — `resyncPosition` and the track-change reads do exactly this shape of thing). | `MPV_EVENT_QUEUE_OVERFLOW` = 24 in client API 2.5 | TS + a few lines of C++ | **Add now** (correctness, not a feature) |
| E18 | **Embedded cover art bytes.** README claims "cover art" as a supported format, but nothing in the repo extracts it — and an audio-only mpv runs `audio-display=no`, so the attached-picture stream is never decoded. mpv *tells you it exists* (`track-list/N/albumart`) but the client API gives no path to the pixels. Local-library apps need this. | `track-list/N/albumart` (detection only) | **Native or engine work** — no client-API path exists | Roadmap, and **soften the README claim** until it ships |
| E19 | **`keep-open` / end-of-queue behaviour.** We keep mpv's default and derive `ended`; there is no way to say "hold the last frame paused at EOF" (which is what makes an `ended` state stable and replayable). | `--keep-open=<yes\|no\|always>`, `--keep-open-pause=<yes\|no>` | TS-only | Roadmap (low) |
| E20 | **Volume above 100% / preamp.** `setVolume` maps `0..1` onto mpv's `0..100`, so mpv's own headroom is unreachable. | `--volume-max=<100.0-1000.0>` (*default 130*), `--volume-gain=<db>` with `--volume-gain-max`/`-min` (default +12/−96 dB). | TS-only | Roadmap (low — `AudioFilters.volume` already covers the use case) |

**Engine-flag consolidation:** with E17 removed from the list (it needs no
flag at all), the engine work collapses to **two filters in one allow-list edit**
— `pan` (E15) and `silenceremove` (E16) — in `rn-media-engine`. The project
already runs this playbook (rnmedia.2 added 16 filters for +104 KB/ABI), so it
is one small release that closes "skip silence" (a row both RNTP V5 and
just_audio have) and the balance half of the accessibility story. Both are
LGPL-clean: every GPL-gated ffmpeg filter is a *video* filter (ARCHITECTURE §18).

### Corrections to make against mpv 0.41 while doing this work

Verified from the 0.41.0 manual and header; each is a trap that will otherwise
bite a typed API:

- **`audio-codec-name` / `audio-codec` are undocumented aliases** (`command.c`:
  `M_PROPERTY_ALIAS("audio-codec-name", "current-tracks/audio/codec")`). Type
  the documented targets `current-tracks/audio/codec` and `.../codec-desc`
  instead — an undocumented alias is exactly what breaks on an engine bump (E6).
- **`cache-buffering-state` is not a general buffer gauge.** It is *"the
  percentage (0-100) of the cache fill status **until the player will
  unpause**"* — meaningful only while `paused-for-cache` is true. For a seek-bar
  buffered overlay use `demuxer-cache-state/seekable-ranges` (unordered, may
  overlap — merge them), not `demuxer-cache-duration`, which the manual calls
  *"very unreliable, and often … not be available at all"* (E5).
- **`--loop-file=N` counts seeks-to-start, not playthroughs** — the manual:
  *"This means `--loop-file=1` will end up playing the file twice."*
  `--loop-playlist` has no such quirk and counts playthroughs. Any
  `repeatCount` API must not paper over the asymmetry (A13).
- **`add chapter -1` is not `chapter = chapter - 1`.** Per
  `--chapter-seek-threshold` (default 5.0 s), a backward chapter seek restarts
  the *current* chapter unless you are within the threshold of its start. That
  is exactly the restart-or-previous semantic A3 wants — for chapters, mpv has
  already implemented it (E2).
- **`mute` is `yes|no` only** — there is no `auto` value.
- **`--audio-exclusive` is a no-op on Android** (the manual lists wasapi,
  coreaudio, pipewire, audiounit; `audiotrack`/`opensles` are absent). Do not
  advertise it cross-platform.
- **`--reset-on-next-file` defaults to resetting nothing**, so a user's `speed`,
  `pitch` and `volume` persist across queue advances. Deliberate or not, it
  should be a documented, typed choice.
- **`playlist/N/id` is the only stable queue key** — *"unique for the entire
  life time of the current mpv core instance"* — and it is what `start-file` /
  `end-file` carry. Indices shift under `playlist-move`/`playlist-remove`.
  Relevant to the queue-entries work already in flight.
- **The `[libmpv]` profile in `etc/builtin.conf` overrides several documented
  "defaults"** (`idle=yes`, `config=no`, `terminal=no`, `osc=no`,
  `input-*=no`, `media-controls=no`). Anyone reading the manual literally will
  get this wrong; worth an ARCHITECTURE platform-trap entry.
- **Good news, checked and clean:** `--prefetch-playlist`'s default flipped to
  `no` in 0.41, and our `prefetchPlaylist` is already opt-in and already quotes
  the 0.41 text — no silent regression on the engine move.

---

## 7. Architect summary — the five highest-value adds

**One:** **typed, escaped per-source HTTP headers (E1 + A14 + bug #4).** Our
stated target audience is non-DRM self-hosted audio — Jellyfin, Plex, Subsonic,
Navidrome, podcasts behind private feeds — and essentially all of it is
authenticated. Today the only route is `LoadOptions.mpvOptions`, which
`formatFileOptions` joins with commas *without escaping*, so the very header a
token needs can corrupt the option list; and `playlist.add()` accepts no options
at all, so a queued track cannot carry auth even unsafely. RNTP has `headers` on
every track and just_audio has it on every source. This is TS-only, it is a
correctness fix as much as a feature, and it is the single largest hole in the
audit.

**Two:** **chapters (E2).** Audiobooks and podcasts are precisely the content our
LGPL/no-DRM positioning targets, and mpv hands us the entire feature as scalar
sub-properties (`chapter`, `chapters`, `chapter-list/N/{title,time}`) that our
existing binding already reads — plus `--start='#2'` chapter clipping for free.
No competitor in React Native has chapters. It is a headline README row for a
few hundred lines of TypeScript.

**Three:** **fix the media-session parity and configurability defects (B1, B2,
B12).** Jump intervals are hardcoded at 15 s on iOS and inherit media3's 5 s
back / 15 s forward on Android — the same JS call behaves differently per
platform, which fails the project's own parity gate; and repeat/shuffle, the two
buttons every notification-shade music player shows, cannot be offered at all
even though `javap` on the shipped media3 AAR confirms `handleSetRepeatMode` and
`handleSetShuffleModeEnabled` sit on the facade player we already own. These are
small native changes with an outsized credibility cost if left.

**Four:** **the cheap-tier ergonomics bundle (A1–A9, E5–E6, E8–E10, E14).**
`stop()`, `seekBy()`, restart-or-previous, `hasNext`/`hasPrevious`,
`queueEnded`, a seek/discontinuity event, typed common metadata, playback
milestones for scrobbling, buffering percentage, a now-playing format badge,
pitch-correction toggle, HLS bitrate cap, mono downmix. Individually trivial;
together they are the difference between "powerful engine" and "the library
people reach for", and every one is TypeScript over a property or command we
already ship. `stop()` and `seekBy()` in particular are table stakes that every
single competitor has and we do not.

**Five:** **pitch shift — ship it now, because we already can (E17).** PLAN §8.1
carries pitch as an open *investigation* blocked on "an LGPL filter path
(rubberband is GPL — banned; needs asetrate/atempo flags)". That premise is
stale: mpv added a first-class `--pitch` option in 0.40 and **we run 0.41.0**.
It is a property write in the range `0.01–100`, it explicitly *"does not affect
playback speed"*, and it drives `scaletempo2` — mpv's own built-in, already in
our filter chain for speed. No engine flag, no ffmpeg filter, no GPL exposure,
no new binary. A feature currently sitting behind a "needs an engine release"
label is actually a one-line property write plus a `2^(semitones/12)` helper,
and no React Native audio library has independent pitch control. Verify quality
on device (that was always the honest gate), then take the scoreboard row. The
residual engine work shrinks to one small flags release for `pan` + skip-silence
(E15/E16).

**Three things to correct in the README/PLAN while doing the above:** the "cover
art" formats claim is not backed by any extraction path (E18); the
"track-player" comparison column should say **which** track-player — V4 is
frozen and Apache-2.0, V5 is commercial and is where the feature set now lives,
which is also the strongest positioning argument this project has; and PLAN
§8.1 item 5's pitch investigation should be rewritten, because its blocking
premise no longer matches the engine we ship.

---

## Appendix — how each claim was verified

- **Our surface**: read at HEAD `6ca2753` via `git show` — all three `index.ts`,
  `player.ts`, `state.ts`, `properties.ts`, `filters.ts`, `errors.ts`,
  `events.ts`, the three nitro specs, `queue-handler.ts`, `persistence.ts`,
  `wire.ts`, `presets.ts`, `MpvClient.cpp`, `BroadcastPlayer.kt`,
  `RemoteCommandBinding.swift`, plus README / PLAN / ARCHITECTURE / specs.
- **mpv**: `DOCS/man/input.rst` and `DOCS/man/options.rst` downloaded at tag
  **`v0.41.0`** and grepped locally — every mpv quote in this document is from
  those files, not from memory. (Copies left in the scratchpad next to this
  report.)
- **media3**: `javap` on the *shipped* `media3-common-1.11.0-api.jar` from the
  local Gradle cache for `handleSetRepeatMode` / `handleSetShuffleModeEnabled`;
  `C.java` at tag `1.11.0` for the seek-increment defaults.
- **Competitors**: live documentation — rntp.dev (V5) and the frozen `v4` branch
  source, pub.dev dartdoc for just_audio 0.10.6, docs.expo.dev + the shipped
  `expo-audio@57.0.3` typings, and the react-native-queue-player package.
- **Not verified, flagged as such**: the exact iOS `MPRemoteCommandCenter`
  symbols for repeat/shuffle/rating (Apple's docs are JS-rendered and could not
  be quote-checked from this Linux box) — confirm on the macOS CI box before
  implementing B2/B3.

