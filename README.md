# rn-media

[![Android CI](https://img.shields.io/github/actions/workflow/status/afkcodes/rn-media/android-build.yml?branch=main&label=Android%20CI&logo=android&logoColor=white)](https://github.com/afkcodes/rn-media/actions/workflows/android-build.yml)
[![iOS CI](https://img.shields.io/github/actions/workflow/status/afkcodes/rn-media/ios-build.yml?branch=main&label=iOS%20CI&logo=apple&logoColor=white)](https://github.com/afkcodes/rn-media/actions/workflows/ios-build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![React Native ≥ 0.82](https://img.shields.io/badge/React%20Native-%E2%89%A5%200.82-61dafb?logo=react&logoColor=white)](#requirements)

**React Native audio playback built on [libmpv](https://mpv.io), with a
player-agnostic media-session layer** — lock screen, notification, Bluetooth and
background playback that keep working after the app's UI is gone. Independent
packages, no cross-dependencies: a libmpv player, an audio-focus arbiter, a media
session that drives lock screens for *any* player, and a Chromecast sender.
Powered by [Nitro Modules](https://nitro.margelo.com) — the C++ core binds
libmpv's client API directly, no bridge layer. Lineage: Flutter's
[`audio_service`](https://pub.dev/packages/audio_service) /
[`audio_session`](https://pub.dev/packages/audio_session) / media-kit.

> **Status: v0.1, pre-release — nothing is on npm yet.** The install line below is
> what it will be; today the packages are consumed from this workspace (see
> [Roadmap](#roadmap)). The Android stack is verified end-to-end on a physical
> device — audio output, notification controls round-tripping to JS, playback
> surviving Activity destruction, and the whole session coming back from a process
> the OS had killed. iOS is **built by CI** and its shipped binaries are inspected
> assertion-by-assertion, but it has never run on a device. APIs may still change.

<p align="center">
  <img src="docs/assets/demo.gif" width="330"
       alt="The example app: a live Shoutcast stream with ICY now-playing, the same session in the notification shade and on the lock screen, then seeking, an EQ preset and stop." /><br>
  <sub><a href="apps/example">The example app</a> on a physical Android 16 device — live Shoutcast → notification
  shade → lock screen, whose play button drives the same handler → seek → EQ
  preset → stop. <a href="docs/assets/demo.mp4">Source video</a>.</sub>
</p>

## Quick start

```sh
npm install @rn-media/player @rn-media/audio-session @rn-media/media-session react-native-nitro-modules
cd ios && pod install   # downloads + verifies the pinned libmpv xcframeworks
```

```ts
import { Player } from '@rn-media/player'
import { BaseMediaHandler, MediaService } from '@rn-media/media-session'

const player = await Player.create({ prefetchPlaylist: true })
await player.loadPlaylist([track.url, next.url])   // one mpv playlist — gapless
player.play()                                      // …and that is audio playing

class Handler extends BaseMediaHandler {           // every remote surface lands here
  // onSetRepeatMode, onSetShuffle, onSleepTimer, customAction: all defaulted.
  override async play() { player.play() }
  override async pause() { player.pause() }
  override async seekTo(ms: number) { await player.seekTo(ms / 1000) }
  override async skipToNext() { await player.playlist.next() }
  override async skipToPrevious() { await player.playlist.previous() }
}
const service = await MediaService.init(() => new Handler(), {
  android: { notificationChannelId: 'playback', notificationChannelName: 'Playback' },
})
service.setMediaItem({ id: track.id, title: track.title, duration: track.durationMs })
player.onStateChange((s) => service.setPlaybackState({
  status: s.playing ? 'playing' : 'paused',
  position: { value: player.getPosition() * 1000, at: Date.now(), rate: s.playing ? s.rate : 0 },
  controls: ['skipToPrevious', 'pause', 'skipToNext'],
  capabilities: ['play', 'pause', 'seek', 'skipToNext', 'skipToPrevious'],
}))
```

That is a gapless queue on the lock screen and in the notification shade.
[Setup](#requirements) is one `Info.plist` key on iOS and nothing on Android; in a
component, `usePlayer` + `useProgress` do the create/destroy and the ticking clock
([Lifecycle](#lifecycle-and-loading)). The four packages —
[`player`](packages/player/README.md) · [`audio-session`](packages/audio-session/README.md) ·
[`media-session`](packages/media-session/README.md) · [`cast`](packages/cast/README.md)
— depend on nothing else here, and both session packages accept **any** engine:
the contracts are structural, not nominal, so RNTP, `expo-audio` or a TTS engine
fit them unchanged.

## Why this exists

| | [track-player](https://rntp.dev) | [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/) | [rn-video](https://github.com/TheWidlarzGroup/react-native-video) | [queue-player](https://ghenry22.github.io/react-native-queue-player/) | **rn-media** |
|---|---|---|---|---|---|
| Engine | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | ExoPlayer / AVPlayer | not documented | **libmpv 0.41.0 + FFmpeg 8.1.2 — our own build** |
| One identical engine on both platforms | ❌ two engines | ❌ | ❌ | — | ✅ 103 mpv options a side, **101 identical** (the two that differ are the platform's audio device) |
| Formats | platform codecs | platform codecs | platform codecs | not documented | everything FFmpeg decodes — MP3, AAC/M4A, FLAC, OGG/Opus, HLS, ICY/Icecast, TrueHD, legacy-charset tags |
| Multiple players | ❌ singleton | ✅ | ✅ | ❌ singleton | ✅ one mpv core each |
| Background + media session | ✅ best-in-class | ✅ lock screen + notification | ⚠️ notification controls | ✅ | ✅ media3 `MediaLibraryService`, native-first commands |
| Session layer works with *any* player | ❌ | ❌ | ❌ | ❌ | ✅ (`@rn-media/media-session` is player-agnostic) |
| Gapless queue | ⚠️ | ✅ | ❌ | ✅ | ✅ 25 ms handover, measured on-device |
| Signed / expiring URLs stay gapless | ❌ | ❌ | ❌ | ❌ | ✅ resolver runs at **prefetch** time — our own mpv patch |
| EQ / DSP | ❌ | ❌ | ❌ | ✅ 10-band | ✅ 16 ffmpeg filters, 22 tuned EQ presets |
| Casting (Chromecast / AirPlay) | ❌ (V5, commercial: Chromecast/Android + AirPlay/iOS, platform-split) | ❌ | ❌ app-side | ✅ | ✅ Chromecast, both platforms — session handoff, receiver-side queue, live streams; Android device-verified, iOS CI-verified |
| Android Auto / CarPlay | ✅ | ❌ | ❌ | ✅ | 🚧 next feature ([Roadmap](#roadmap)) |
| DRM (Widevine/FairPlay) | ⚠️ announced | ❌ | ✅ | not documented | ❌ libmpv cannot ([Limitations](#limitations)) |
| Native binary it adds | ≈none (platform codecs) | ≈none | ≈none | — | 3.63 MB downloaded for `arm64-v8a`, ≈7.1 MB for the iOS device slice ([Requirements](#requirements)) |

Those are the rows a chooser weighs; the other seven — headers, pitch, chapters,
sleep timer, visualizer, crossfade, remote volume — and the sourcing for every
cell are in **[docs/comparison.md](docs/comparison.md)**. It adds up to music apps
with **non-DRM audio**: indie catalogs, self-hosted libraries, podcasts, radio,
audiobooks. The row we pay for is the last one.

Different job:
[`react-native-audio-api`](https://github.com/software-mansion/react-native-audio-api)
implements the **Web Audio API**, an audio *graph* for synthesis and per-sample
DSP — a paradigm this library does not attempt, and one that composes with it,
since `@rn-media/media-session` takes any player structurally.

## API

Every signature below is the real one. Depth, caveats and the error taxonomy
live in the [`@rn-media/player` README](packages/player/README.md).

### Lifecycle and loading

| | what it does | notes |
|---|---|---|
| `Player.create(options?: PlayerOptions): Promise<Player>` | Builds one mpv core and initialises it | Options out of mpv's range throw before a core is created |
| `player.destroy(): void` | Terminates the core and frees everything | Idempotent; every method afterwards throws `disposed` |
| `player.destroyed: boolean` | Whether `destroy()` has run | |
| `usePlayer(options?: UsePlayerOptions): { player, error }` | `create` on mount, `destroy` on unmount | `options.setup?: (p: Player) => void \| Promise<void>` runs once, after create |
| `createMpvClient(): MpvClient` | The raw binding, no `Player` wrapper | [docs/engine.md](docs/engine.md#reaching-into-mpv) |

| `load(source: string, options?: LoadOptions): Promise<void>` | Replaces the queue with one entry | `{ autoPlay?, startPosition?, headers?, mpvOptions? }` |
| `loadPlaylist(sources: readonly string[], options?: LoadPlaylistOptions): Promise<void>` | One mpv playlist — this is what gapless *is* | adds `{ startIndex?, shuffle? }`; `shuffle` + `startPosition` together throw |
| `setSourceResolver(resolver: SourceResolver \| null): void` | Install, replace or remove the resolver at any time | `(req: { uri, entryId? }) => string \| Promise<string>` |

Multiple players are first-class — each `Player.create()` is its own mpv core.
Notable `PlayerOptions`: `volume`, `rate`, `loop`, `muted`, `cacheSecs` (30 s,
bounding mpv's readahead against its ~1000-hour ceiling), `prefetchPlaylist`,
`gaplessAudio`, `userAgent` (defaults to `rn-media (libmpv)` because real
Shoutcast hosts 401 the literal `libmpv`), `replayGain`, `networkReconnect`,
`retry`, `sourceResolver`, `mpvOptions`. `headers` is the typed form of mpv's
`http-header-fields`, escaped through both of mpv's list layers and rejecting
CR/LF/NUL/colon — mpv writes those into the request verbatim, which is request
splitting, not formatting — and it belongs to the **entry**, so a resolver
rewriting the URL does not lose it. `.m3u8`/`.m3u` sources force
`demuxer=lavf` (caller-overridable), so mpv's playlist demuxer cannot explode
your queue into segment entries.

### Playback

| | what it does | notes |
|---|---|---|
| `play(): void` / `pause(): void` / `toggle(): void` | | Synchronous — they set mpv's `pause` property |
| `isPlaying(): boolean` | `state.playing` as a method | What makes a `Player` satisfy `audio-session`'s player contract |
| `seekTo(seconds: number): Promise<void>` | Absolute seek | |
| `seekBy(delta: number): Promise<void>` | Relative seek | Immune to projection error — use it for ±15 s buttons |
| `stop(options?: { clearPlaylist?: boolean }): Promise<void>` | Stops playback; **the queue survives** | mpv's own `stop` clears it; we invert that default. `{ clearPlaylist: true }` is the destructive opt-in |
| `setRate(rate: number): void` | Pitch-corrected speed | |
| `setPitch(ratio: number): void` | Transpose, independent of rate | A frequency **ratio**, not semitones: `2 ** (n / 12)` is the twelve-tone version |
| `getVolume(): number` / `setVolume(v: number): void` | `0..1` | |
| `setMuted(muted: boolean): void` | | |
| `setLoop(mode: LoopMode): void` | `'off' \| 'track' \| 'playlist'` | |
| `setAudioChannels(mode: AudioChannelMode): void` | `'auto-safe' \| 'auto' \| 'stereo' \| 'mono'` | Accessibility downmix; `'auto-safe'` restores |
| `setPrefetchPlaylist(enabled: boolean): void` | Open the next entry early, at runtime | Measured: 25 ms handover with it, 644 ms and an audible underrun without |

### Queue — `player.playlist.*`

| | what it does | notes |
|---|---|---|
| `entries(): readonly PlaylistEntry[]` | `{ uri, entryId, current }[]`, read from mpv | Synchronous |
| `add(source: string, options?: PlaylistAddOptions): Promise<void>` | Insert one entry | See the position table below |
| `remove(index: number): Promise<void>` | | |
| `move(from: number, to: number): Promise<void>` | | |
| `jumpTo(index: number, options?: { autoPlay?: boolean }): Promise<void>` | Play that entry | `{ autoPlay: false }` stays paused |
| `next(): Promise<void>` | | |
| `previous(options?: { restartThreshold?: number }): Promise<void>` | The ⏮ button | Past the threshold (3 s) it restarts the track instead of moving back |
| `clear(): Promise<void>` | | |
| `shuffle(): Promise<readonly PlaylistEntry[]>` | mpv `playlist-shuffle` | Returns the new order |
| `unshuffle(): Promise<readonly PlaylistEntry[]>` | Undoes it — **once** | mpv keeps one level of history |

`PlaylistAddOptions` extends the per-source options (`headers`, `startPosition`,
`mpvOptions`) with:

| `position` | where the entry lands |
|---|---|
| omitted | the end of the queue |
| `'next'` | immediately after the current entry |
| `number` | that exact index; outside `0 … count` **throws** rather than clamping |
| plus `play: true` | …and starts it if nothing is playing |

Insertion is one command, not two: `position` compiles onto mpv's own
`insert-next` / `insert-at` load actions, so the queue is never briefly wrong the
way an append-then-move pair leaves it.

### State and metadata

| | what it does | notes |
|---|---|---|
| `player.state: PlayerState` | Immutable snapshot | `status`, `playing`, `duration`, `isLive`, `rate`, `pitch`, `volume`, `loop`, `playlist: { index, count }`, `hasNext`, `hasPrevious`, `chapter`, `bufferingPercent`, `error`, … |
| `onStateChange(fn: (s: PlayerState) => void): Unsubscribe` | Fires only on real changes | |
| `getPosition(): number` | Seconds, **projected locally** | No bridge traffic, no timers |
| `resyncPosition(): number` | Re-reads mpv and re-anchors | For when you suspect drift |
| `clearError(): boolean` | Dismiss `state.error` | Returns whether there was one |
| `getMetadata(): Metadata` | mpv's typed tag map | `Readonly<Record<string, string>>` — no string parsing |
| `getMetadataValue(key: string): string \| undefined` | One tag | `'icy-title'` is how radio now-playing arrives |
| `getCommonMetadata(): CommonMetadata` | The same tags normalised | title/artist/album/trackNumber/year/… |
| `getChapters(): readonly ChapterEntry[]` | `{ title?, start }[]` | Podcasts, m4b audiobooks |
| `setChapter(index: number): void` | | |
| `nextChapter(): Promise<void>` / `previousChapter(): Promise<void>` | | |

**Position is an anchor, never a stream.** State carries `{ value, at, rate }`,
updated only on discontinuities; every surface projects `value + elapsed × rate`
locally, so a scrubber moves with zero bridge traffic. Live streams are honest
too: `isLive: true` and `duration: undefined` — mpv's perpetually-growing cache
length is suppressed rather than broadcast as a duration.

**Hooks** — all of them take `Player | undefined`, so they are safe before
`create()` resolves:

| | returns |
|---|---|
| `usePlayerState(player)` | the whole `PlayerState` |
| `usePlayerState(player, selector, isEqual?)` | one derived slice, re-rendering only when it changes |
| `useProgress(player, intervalMs = 250)` | `{ position, duration, buffered, isLive }` |
| `useMilestones(player, onMilestone, { marks = [25,50,75,90], intervalMs? })` | nothing — calls back at the scrobbling marks. A hook rather than a player timer because JS timers freeze with the screen off, and it says so instead of pretending |
| `usePrefetchStatus(player)` | `{ active: false } \| { active: true, uri, entryId?, at }` |
| `useVisualizer(player, options?, enabled?, pauseWhenInactive?)` | `{ frame, error, active }` |

### Events — `player.on(name, listener): Unsubscribe`

| event | payload |
|---|---|
| `trackChanged` | `{ index: number, previousIndex: number }` |
| `trackEnded` | `{ index: number }` — finished naturally |
| `queueEnded` | *(none)* — playback ran off the end |
| `queueChanged` | `{ count: number, reason: 'resized' \| 'reordered' }` |
| `chapterChanged` | `{ index?: number, previousIndex?: number }` |
| `seekStarted` | `{ reason: 'seek' \| 'auto-advance', from: number }` |
| `seekCompleted` | `{ reason: 'seek' \| 'auto-advance', position: number }` |
| `metadataChanged` | `Metadata` — at most once per native event batch |
| `prefetchStarted` | `{ uri: string, entryId?: number }` |
| `retrying` | `{ index, attempt, maxAttempts, error: PlayerError }` |
| `error` | `(error: PlayerError, info: { attempts: number })` |
| `log` | `{ level, prefix, text }` from mpv itself |

```ts
const off = player.on('trackChanged', ({ index }) => scrobble(index))
player.on('error', (e) => console.log(e.code, e.message))
await player.playlist.add(uri, { position: 'next', headers: { Authorization: token } })
await player.stop()   // playback stops, the queue survives
```

`PlayerError.code` is one of `'network' | 'unsupported-format' | 'load-failed' |
'disposed' | 'invalid-state' | 'unsupported' | 'mpv'` — a real taxonomy, so a
network EOF is not confused with a natural end. The `seekStarted`/`seekCompleted`
pair with its `reason` is what analytics reconstructs listened time from; those
arrive with the screen off, which is exactly when a JS timer would not.

### Audio processing

| | what it does | notes |
|---|---|---|
| `setAudioFilters(filters: readonly AudioFilter[]): void` | Compiles typed descriptors into mpv's `af` grammar | Replaces the whole user chain |
| `clearAudioFilters(): void` | | Leaves the managed loudnorm entry alone |
| `getAudioFilters(): string` | The compiled chain, as mpv sees it | |
| `setReplayGain(options: ReplayGainOptions): void` | `{ mode: 'no' \| 'track' \| 'album', preamp?, clip?, fallback? }` | Volume-domain, from the file's tags; applies to the *playing* track |
| `setLoudnessNormalization(enabled: boolean, options?: LoudnessNormalizationOptions): void` | A managed `loudnorm` entry for files with no tags | `{ targetLufs?, loudnessRange?, truePeakDb?, dualMono? }`. Pick this **or** ReplayGain, never both — the gains stack |
| `getLoudnessNormalization()` | `LoudnessNormalizationOptions \| undefined` | |
| `AudioFilters.*` | `equalizer`, `bass`, `treble`, `lowpass`, `highpass`, `graphicEqualizer`, `crossfeed`, `compressor`, `limiter`, `dynamicNormalizer`, `loudnorm`, `volume`, `custom` | `custom` reaches any ffmpeg audio filter compiled in |
| `EQUALIZER_PRESETS` / `EQUALIZER_PRESET_LIST` | 22 tuned 10-band curves; the list is picker-ordered | |
| `equalizerPresetChain(preset, options?)` | Preset → filter chain **with a computed pre-amp** | So a preset cannot clip |
| `defineEqualizerPreset(id, name, gainsDb)` | Validates a user-designed curve | Exactly 10 gains, one per `EQUALIZER_BANDS` entry |
| `player.visualizer.capabilities` | `{ fft, waveform, maxFps, minFftSize, maxFftSize }` | `fft: false` on binaries without the PCM-tap patch |
| `player.visualizer.subscribe(listener, options?)` | Imperative spectrum, never auto-paused | The hook is what pauses; this is not |

Filters, playback speed and ReplayGain never interact: mpv's speed handling sits
downstream of the user chain, and ReplayGain is volume-domain.

### Escape hatch

`command` · `getPropertyString` / `Number` / `Bool` · `setPropertyString` /
`Number` / `Bool` · `observeProperty(name, 'string' | 'number' | 'bool')` ·
`unobserveProperty` · `getRawHandle(): bigint`. A complete raw mpv client, so
anything mpv can do you can do without waiting for us — with two documented
limits (an extra observed property does not become a `Player` event, and video
stays out): [docs/engine.md](docs/engine.md#reaching-into-mpv).

## Resolve sources at the last moment

Signed CDN links that expire in minutes, transcode sessions created per track:
queues whose entries cannot be written down when the queue is built. Give the
player a resolver and it asks, per entry, moments before mpv opens that entry.

```ts
const player = await Player.create({
  prefetchPlaylist: true,
  sourceResolver: async ({ uri }) => {
    if (!uri.startsWith('library://')) return uri
    const { url } = await api.signPlaybackUrl(uri.slice('library://'.length))
    return url
  },
})
await player.loadPlaylist(['library://a', 'library://b', 'library://c'])
```

**The half that makes it useful: it also runs at *prefetch* time.** Upstream mpv
deliberately runs no hooks there — its manual says resolved URLs "won't" work
with `--prefetch-playlist` — so a URL-rewriting resolver on stock libmpv makes
prefetch *worse* than off. Our fork carries the patch that fires a hook on that
path, so a signed queue keeps the 25 ms handover instead of paying 644 ms for it.

Answers are cached natively and replayed per URI, because mpv reuses a prefetched
stream only when the two URLs are byte-identical: mint one URL per track, not one
per call. [Full contract](packages/player/README.md#dynamic-source-resolution-signed-urls-transcode-sessions).

## Lock screen and background

The wiring is in [Quick start](#quick-start). Three things it does not show.

**`controls` vs `capabilities`.** `controls` are the buttons you want, in order;
`capabilities` are the commands your handler will service, and media3 never
invokes a handler for one you did not declare. **Commands are native-first**: the
pause button acts on the native state machine immediately and your handler hears
about it after, never on the critical path — so nothing changes on any surface
until your next broadcast, and `rate: 0` is how "paused" is expressed.

**Surviving process death.** One wrapper and a restore:

```ts
const service = withPersistence(await MediaService.init(factory, config), storage)
const restored = await restorePersisted(storage)          // next launch
if (restored.status === 'restored') applyPersisted(service, restored.session)
```

Android's foreground service keeps the process — and the JS runtime — alive with
the Activity destroyed, but a paused service is eventually demoted and a demoted
one is killable, so the queue, track and position live in `storage` (anything
with `{ getItem, setItem }`; this package depends on none of them). Broadcasts
are discontinuity-only, so `service.save()` exists for the moments you pick, and
the position always returns **paused** — a saved anchor with a live rate would
claim a position that grew while the process was dead. `playbackResumption: true`
lets Android revive the session after the process is gone, which needs
`MediaService.init(...)` at JS **module scope**: a revived runtime loads your
bundle and mounts nothing.

**The sleep timer is a library feature**, because JS timers freeze in the
background: `setSleepTimer(seconds)` / `setSleepTimerToTrackEnd()` run on a
native timer and pause natively first, the same path a notification press takes.

Repeat and shuffle, the `jumpForwardSeconds` / `jumpBackwardSeconds` pair (15/15,
resolved natively into an absolute seek so there is no jump handler to write) and
`MediaItem`'s long tail all ride the same contract:
[controls vs capabilities](packages/media-session/README.md#controls-vs-capabilities) · [repeat & shuffle](packages/media-session/README.md#repeat-and-shuffle) ·
[jump intervals](packages/media-session/README.md#jump-intervals) · [metadata fields](packages/media-session/README.md#metadata-fields) — a per-field table of
what each platform really renders · [persistence](packages/media-session/README.md#surviving-process-death-withpersistence) ·
[resumption](packages/media-session/README.md#playback-resumption-after-process-death) · [sleep timer](packages/media-session/README.md#sleep-timer-native).

## Cast to a speaker

Casting is a **URL handoff, not an output route**: mpv can never *be* the thing
driving a Chromecast, so `@rn-media/cast` doesn't try — it pauses your player,
hands the receiver the queue as URLs, and lets it fetch and decode them. Every
surface keeps rendering from the same three `media-session` channels, now
mirroring the receiver instead of mpv. No second UI, no new fan-out path.

```ts
const handoff = wireCastHandoff(
  // Structural on both sides — nothing here imports @rn-media/player.
  { play: () => player.play(), pause: () => player.pause(), seekTo: (s) => player.seekTo(s),
    skipToIndex: (i) => player.playlist.jumpTo(i, { autoPlay: false }),
    getPosition: () => player.getPosition(), isPlaying: () => player.state.playing },
  { snapshot: () => ({ items, index: currentIndex, position: player.getPosition(),
                       playWhenReady: player.state.playing }),
    onReceiverState: (s) => publishReceiverState(s),   // an anchor: project, never poll
    onItemsSkipped: (skipped) => showCastNotice(skipped) },
)
await handoff.castTo(devices[0].id)   // or the user taps <CastButton/>, same machine
await handoff.stopCasting()           // back to local, at the receiver's position
```

`<CastButton/>` is the platform's own button as a real native view — on Android
13+ a tap opens the **system** output switcher (observed on an Android 16 device;
13-15 is the SDK's documented behaviour, not something we have run) — and it
hides itself when there is nothing to cast to. `service.setRemotePlayback({ volume })`
declares playback remote, which points the app's volume control — and the
hardware keys while the app is on screen — at the receiver instead of the
phone's own stream. Routing those keys with the **screen off** is
[under investigation](#limitations): it was shipped on the strength of a
measurement taken with injected key events, and a physical press says
otherwise. On iOS the call is a documented no-op, because iOS gives no app the
volume buttons. `wireCastHandoff` lives in
`@rn-media/cast`, not `media-session`, which stays player-agnostic and cast-free
in both directions.

Codec ceilings (`canCastMedia(item)` answers per track) and every device-found
failure mode: [`@rn-media/cast`](packages/cast/README.md) ·
[design doc](docs/design/cast.md) ·
[remote volume](packages/media-session/README.md#remote-playback-hardware-volume-keys-drive-the-other-device).

## Shape the sound

Our libmpv builds carry the same 16 LGPL audio filters on **both** platforms, so
nothing here needs a platform branch.

```ts
player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.rock))
player.setAudioFilters([                             // …or by hand
  AudioFilters.equalizer({ frequency: 60, widthType: 'o', width: 1, gain: 4 }),
  AudioFilters.crossfeed({ strength: 0.3 }),
  AudioFilters.limiter(),
])
player.setReplayGain({ mode: 'album', preamp: -3, fallback: -6 })  // tagged files
player.setLoudnessNormalization(true, { targetLufs: -16 })         // untagged ones
```

[filters and EQ](packages/player/README.md#audio-filters-and-eq) ·
[ReplayGain](packages/player/README.md#replaygain-loudness-normalisation).

## See the sound

A live spectrum of exactly this player's output, on **both platforms**, with no
permission to request and nothing to add to your manifest:

```tsx
const { frame } = useVisualizer(player, { bands: 28 })
// frame.bands — Float32Array in [0, 1], log-spaced and already smoothed
```

The samples come from mpv itself — our forks carry a source patch (`pcm-tap`)
exposing the audio the engine hands to the device, after the filter chain and
after mpv's software gain, so what you draw is what you hear. A native thread
does the FFT; the PCM never crosses into JavaScript and only ~4 KB of spectrum
does, and nothing exists until something subscribes.

**The hook stops itself when nothing can be seen**, and that is correctness, not
politeness: the frames are *native* callbacks, so unlike a JS timer the platform
does not freeze them behind a locked screen — on Android it took `AppState`
**and** the display ANDed to stop a 65-80 %-of-a-core soak. Needs binaries
carrying the patch (Android `v1.1.9-rnmedia.3`+, iOS `v0.7.2-rnmedia.3`+, what
this repo pins); on anything older `visualizer.capabilities.fft` is `false` and
subscribing throws a typed `unsupported` rather than failing quietly.
[Full contract](packages/player/README.md#visualizer-spectrum--waveform).

## Focus and headphones

Duck for navigation prompts, pause for phone calls, resume after, pause when the
headphones come out — one call:

```ts
const unwire = wireAudioSession(player, {
  preset: AudioSessionPresets.music,   // or .speech — pauses instead of ducking
  duckVolume: 0.3,
  resumeAfterInterruption: true,
})
```

It takes anything with `{ play, pause, setVolume, getVolume }`, so it is not
coupled to our `Player`; activating the session before `play()` stays the app's
job. Everything under the helper — `AudioSession.configure` / `activate` /
`deactivate`, and the `interruption`, `becomingNoisy` and `routeChange`
listeners — is public when you want the policy yourself:
[reference](packages/audio-session/README.md#player-integration).

## Requirements

| | |
|---|---|
| React Native | **>= 0.82** (New Architecture); developed against 0.87.0 |
| Peer dependency | [`react-native-nitro-modules`](https://nitro.margelo.com) |
| Android setup | minSdk **24**, compileSdk **36**. Nothing to configure: the `media-session` manifest merges the foreground-service permissions and the `mediaPlayback` service, and `POST_NOTIFICATIONS` is *not* required for media notifications |
| iOS setup | **15.1+** — `@rn-media/cast` raises the floor to **16.0** and needs **Xcode 26+** to build. One `Info.plist` key: `UIBackgroundModes` → `<array><string>audio</string></array>` |
| Expo | Prebuild (managed) workflow, no manual native edits: `"plugins": ["@rn-media/media-session"]` covers the whole library, merges `UIBackgroundModes` idempotently, and installs the notification drawable — the only way a prebuild app can add one. Expo Go cannot load this library; use a development build. [Plugin reference](packages/media-session/README.md#expo-config-plugin) |
| Android binary | 3.63 MB downloaded for `arm64-v8a`; 7,338,952 bytes of stripped `libmpv.so` (the other three ABIs are in the same band) |
| iOS binary | `Mpv.framework`'s device slice is 1,756,424 bytes; ≈7.1 MB across all ten frameworks |
| Google Play services | Casting only — without it `Cast.initialize()` resolves a typed `'unavailable'`, never a crash |
| Binary provenance | Downloaded at build time, pinned by tag **and** SHA-256; a mismatch is a hard build failure. Where the numbers came from: [docs/engine.md](docs/engine.md) |

## Limitations

- **No DRM**, by construction — libmpv has no Widevine/FairPlay. This library
  cannot power a licensed-catalog streaming app.
- **iOS has never been run on a device.** It compiles, links and embeds the
  frameworks in CI, and the shipped binary demonstrably carries the HLS demuxers
  and the filter set — but no on-device playback, background audio or lock-screen
  behaviour has been observed. Expected to work, not proven. (Android is
  device-verified, HLS included.)
- **Force-quitting on iOS kills playback**, and nothing may restart the app for
  audio afterwards — true of every iOS app, and the reason `playbackResumption`
  is Android-only. Relatedly, an iOS sleep timer armed over *silence* may never
  fire, because iOS suspends a backgrounded process once audio stops; armed while
  audio plays — the case that matters — it fires.
- **No crossfade.** Built, listened to on a device, and dropped by owner
  decision: mpv's gapless is an output-buffer guarantee, and the crossfade built
  on top of it was not good enough to ship. A competitor ships crossfade; we do
  not, and would rather say so than pretend the row does not exist.
- **Embedded cover art decodes, but cannot be extracted yet.** The eight
  cover-art decoders are compiled into both binaries and mpv reports an attached
  picture through `track-list/N/albumart` — but there is **no API to get the
  bytes**, because the audio-only core runs `audio-display=no` (mpv then never
  selects the attached-picture track) and the only image-returning client-API
  command, `screenshot-raw`, needs a video output this core deliberately never
  creates. Until it ships, pass artwork from your own library as
  `MediaItem.artworkUri`.
- **Casting has real ceilings.** Android device-verified, iOS CI-verified only;
  receivers decode far less than mpv (no ALAC, hi-res FLAC, WMA, DSD or AC-3), no
  `file://` sources in v1, no header auth without your own Web Receiver, and no
  lock-screen controls during an iOS session. AirPlay-*as-handoff* stays out of
  scope — no sender SDK exists for it from a third-party engine, for anyone, and
  the platform-split workaround a paid competitor ships is exactly what this
  project's parity gate rejects. **AirPlay audio *output* works today with zero
  code**: it is an ordinary iOS system output route.
- **Persistence has two honest edges**: writes happen on broadcasts, so a track
  played straight through saves nothing until you call `service.save()`; and a
  live stream saves position `0`, because an offset into it has nothing to seek
  back to.
- **Hardware volume keys with the screen off, while casting, do not work yet**
  — and the way we learned it is the point. It shipped with a measurement
  behind it, but that measurement used *injected* key events, which do not
  travel the path a physical press takes; a real thumb on the rocker says
  otherwise. In-app volume control and the keys with the app on screen do drive
  the receiver. The routing rules with the screen off are under investigation,
  and this entry stays until a physical press proves it either way.

## Roadmap

The gate that unlocks shipping, in this order: **on-device iOS verification**
(playback, background audio, lock screen, HLS and the EQ chain on real hardware)
→ the naming decision → the first npm publish.

Next in the queue, owner-approved:

1. **React Native 0.87**, inside the two-week currency window the dependency
   policy sets.
2. **Android Auto**, with a CarPlay-symmetric API — a browse tree over the media3
   `MediaLibraryService` already here, fanned into a JS handler the same way
   commands are. The CarPlay half lands when Apple hardware exists.
3. **`@rn-media/downloads`** — offline playback as a *source resolver* (local file
   when downloaded, CDN otherwise), so the player needs no changes at all.
4. LRC lyrics utilities over position projection.
5. Video as an additive plugin package: `VideoView`, its own binaries, zero core changes.

Investigations rather than promises: output-device routing, and the screen-off
volume-key routing in [Limitations](#limitations).

## Licensing

**This library: MIT.** The bundled libmpv/FFmpeg binaries are **LGPL v3** (built
with `--enable-version3`, never `--enable-gpl`) and **dynamically linked** — `.so`
in the APK, embedded dynamic xcframeworks on iOS, the App Store-accepted pattern
that satisfies the relink obligation. Ship your app's licenses screen with the
mpv/FFmpeg notices.

Both binaries come from our public forks of media-kit's build scripts,
[`libmpv-android-audio-build`](https://github.com/afkcodes/libmpv-android-audio-build/releases/tag/v1.1.9-rnmedia.8)
and [`libmpv-darwin-build`](https://github.com/afkcodes/libmpv-darwin-build/releases/tag/v0.7.2-rnmedia.7)
— both mpv 0.41.0 / FFmpeg 8.1.2 / mbedTLS 3.6.7, so the two platforms run one
engine. The delta versus upstream is additive ffmpeg configure flags (the
`hls`/`mpegts` demuxers, which stock audio flavours omit, plus 16 audio filters)
and two source patches; every GPL-gated ffmpeg filter is a *video* filter, so the
LGPL line is untouched. libmpv also links **libplacebo** (LGPL v2.1+, mandatory
for mpv >= 0.37) and, on Android, **GNU libiconv 1.19** (LGPL v2.1+) — both
statically, inside the LGPL libmpv that is itself dynamically linked, so the
relink obligation still holds at that boundary.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the whole loop — setup, per-package
tests, the Gradle tasks CI runs, how to typecheck a README snippet, and what
counts as verification here: device-free for TS logic, and a *physical* device
for any playback claim. Injected input is not a physical device.

[`apps/example`](apps/example) is the reference integration and the on-device test
bed: a queue of live streams and files, focus wiring, EQ presets, pitch and
playback-mode controls, chapters, ±15 s jumps, the native sleep timer in both
modes, and session persistence across process death. It carries one dependency
the library does not (`react-native-mmkv`, purely as the persistence storage) —
exactly the point of the injected-storage contract.

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the living record of every decision and
its evidence; [`PLAN.md`](PLAN.md) holds the analysis, [`docs/specs/`](docs/specs)
the per-package contracts, [`docs/engine.md`](docs/engine.md) the engine we
build. The C++ core binds only `mpv/client.h` — video arrives later as a separate
opt-in plugin package with its own binaries, at zero cost to audio-only users.
