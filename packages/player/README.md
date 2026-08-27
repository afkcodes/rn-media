# @timbre/player

React Native audio player built on libmpv, powered by Nitro Modules. One mpv
core per `Player`, a gapless queue, a typed filter/EQ chain, a spectrum
visualizer, and a raw escape hatch onto mpv's client API.

[![Version](https://img.shields.io/npm/v/@timbre/player.svg)](https://www.npmjs.com/package/@timbre/player)
[![License](https://img.shields.io/npm/l/@timbre/player.svg)](https://github.com/afkcodes/timbre/blob/main/LICENSE)

## Requirements

| | |
|---|---|
| React Native | **>= 0.82** (New Architecture only); Node >= 18 |
| Android | minSdk 24. This package's manifest merges no permissions — not even `RECORD_AUDIO` |
| iOS | Add `UIBackgroundModes: audio` to your `Info.plist`, or install `@timbre/media-session` and let its Expo plugin merge it. This package configures no `AVAudioSession`. Install [`@timbre/audio-session`](../audio-session/README.md) or write your own session code, or the process default category applies and background audio does not work. Pass `audiounit-skip-session-management=no` in `mpvOptions` to hand the job back to the engine ([ARCHITECTURE §26](../../ARCHITECTURE.md#26-avaudiosession-has-exactly-one-owner-and-it-is-not-the-engine)) |

## Installation

```bash
npm install @timbre/player react-native-nitro-modules
```

## Usage

```tsx
import { Button } from 'react-native';
import { usePlayer, usePlayerState, useProgress } from '@timbre/player';

function Screen() {
  const { player } = usePlayer({ volume: 0.8, setup: p => p.load('https://x/a.flac') });
  const { playing } = usePlayerState(player);
  const { position, duration } = useProgress(player);
  return <Button title={playing ? 'Pause' : 'Play'} onPress={() => player?.toggle()} />;
}
```

Outside React, `await Player.create(options)` gives the same object, and
[the recipes](../../docs/recipes/music-player.md) build whole apps on it.

## API

### Lifecycle and loading

| | what it does | notes |
|---|---|---|
| `Player.create(options?: PlayerOptions): Promise<Player>` | Builds one mpv core and initialises it | Options out of mpv's range throw before a core is created. Multiple players are first-class: one mpv core each |
| `player.destroy(): void` / `player.destroyed: boolean` | Terminates the core and frees everything | Idempotent; every method afterwards throws `disposed` |
| `usePlayer(options?: UsePlayerOptions)` | `create` on mount, `destroy` on unmount | `options.setup?: (p: Player) => void \| Promise<void>` runs once, after create |
| `createMpvClient(): MpvClient` | The raw binding, with no `Player` wrapper | [docs/engine.md](../../docs/engine.md#reaching-into-mpv) |
| `load(source, options?: LoadOptions): Promise<void>` | Replaces the queue with one entry | `{ autoPlay?, startPosition?, headers?, mpvOptions? }`. `startPosition` is applied by mpv at open, so there is no audible jump |
| `loadPlaylist(sources, options?: LoadPlaylistOptions)` | One mpv playlist — this is what gapless *is* | adds `{ startIndex?, shuffle? }`; the two together throw, because after a whole-list shuffle an index no longer identifies the source you passed |
| `setSourceResolver(resolver \| null): void` | Install, replace or remove the resolver at any time | `(req: { uri, entryId? }) => string \| Promise<string>` |
| `setScreenStateSource(source)` / `getScreenStateSource()` | Replace the display-state signal the visualizer gates on | For an external display or a head unit — not for turning the gate off |

`PlayerOptions`:

| option | default | notes |
|---|---|---|
| `volume`, `rate`, `pitch`, `muted`, `loop` | mpv's | `volume` is `0..1` |
| `cacheSecs` | `30` | mpv's own default is ~1000 hours, which on a radio stream downloads for hours even while paused. Startup is unaffected: `cache-pause-initial` is `no` |
| `prefetchPlaylist` | `false` | Opens the next entry as soon as the current one is fully read. 25 ms handover with it; 644 ms and a logged device underrun without |
| `gaplessAudio` | `'weak'` | `'weak'` keeps the device open while the output format matches; `'yes'` always, resampling later entries into the first entry's format; `'no'` never. Pin `--audio-samplerate`/`--audio-format` if you choose `'yes'` |
| `userAgent` | `timbre (libmpv)` | Real Shoutcast hosts reject the literal `libmpv` |
| `replayGain` | off | `{ mode, preamp?, clip?, fallback? }` — see [Audio processing](#audio-processing) |
| `networkReconnect` | on | `{ enabled?, maxDelaySeconds? }` — FFmpeg's own retry, inside libavformat |
| `retry` | `{ maxAttempts: 2 }` | `{ maxAttempts, retryLiveEof? }` — whether the queue moves on |
| `sourceResolver`, `resolverTimeoutMs`, `resolverTtlMs` | none, `10_000`, `600_000` | See [Dynamic source resolution](#dynamic-source-resolution-signed-urls-transcode-sessions) |
| `logLevel`, `mpvOptions` | | Raw `mpvOptions` always win. Precedence at init, weakest first: library defaults, typed options, `mpvOptions`. `profile` and `include` are unsupported there — set them after creation |
| per-source `headers` | none | The typed form of mpv's `http-header-fields`, escaped through both of mpv's list layers and rejecting CR/LF/NUL/colon, which mpv would write into the request verbatim. It belongs to the **entry**, so a resolver rewriting the URL does not lose it. `.m3u8`/`.m3u` sources additionally force a caller-overridable `demuxer=lavf`, so mpv's playlist demuxer cannot explode your queue into segment entries |

### Playback

| | what it does | notes |
|---|---|---|
| `play()` / `pause()` / `toggle()` | | Synchronous — they set mpv's `pause` property |
| `isPlaying(): boolean` | `state.playing` as a method | What makes a `Player` satisfy `audio-session`'s player contract |
| `seekTo(seconds): Promise<void>` | Absolute seek | |
| `seekBy(delta): Promise<void>` | Relative seek | Immune to projection error — use it for ±15 s buttons |
| `stop(options?: { clearPlaylist? }): Promise<void>` | Stops playback; **the queue survives** | mpv's own `stop` clears it; this library inverts that default. `{ clearPlaylist: true }` is the destructive opt-in |
| `setRate(rate): void` | Pitch-corrected speed | mpv's `scaletempo2` sits downstream of the filter chain, so rate, filters and ReplayGain compose freely |
| `setPitch(ratio): void` | Transpose, independent of rate | A frequency **ratio**, not semitones: `2 ** (n / 12)` is the twelve-tone version |
| `getVolume()` / `setVolume(v)` / `setMuted(muted)` | Volume is `0..1` | mpv's own curve is `gain = (volume / 100) ** 3`. Use `setPropertyNumber('volume', …)` for its amplification range |
| `setLoop(mode)` / `setAudioChannels(mode)` | `'off' \| 'track' \| 'playlist'`; `'auto-safe' \| 'auto' \| 'stereo' \| 'mono'` | The second is an accessibility downmix; `'auto-safe'` restores |
| `setPrefetchPlaylist(enabled): void` | The runtime twin of the create option | Takes effect from the next prefetch decision; turning it off does not abort a running opener |

### Queue (`player.playlist.*`)

| | what it does | notes |
|---|---|---|
| `entries(): readonly PlaylistEntry[]` | `{ uri, entryId, current }[]`, read from mpv | One synchronous node read, constant whatever the length. A pull, not a subscription — call it when something says the queue moved |
| `add(source, options?: PlaylistAddOptions)` | Insert one entry | See the position table below |
| `remove(index)` / `move(from, to)` | | `move` has ordinary array semantics |
| `jumpTo(index, options?: { autoPlay? })` | Play that entry | Clears `pause` by default, like `load()`. `{ autoPlay: false }` stays paused |
| `next()` / `previous(options?: { restartThreshold? })` | The ⏭ / ⏮ buttons | Past the threshold (3 s), `previous` restarts the track instead of moving back |
| `clear()` | | Keeps the entry that is playing |
| `shuffle(): Promise<readonly PlaylistEntry[]>` | mpv `playlist-shuffle` | Permutes **every** entry including the playing one, so you get a `trackChanged` for a track that did not change. Returns the new order |
| `unshuffle(): Promise<readonly PlaylistEntry[]>` | Undoes it — **once** | mpv keeps one level of history, and each shuffle overwrites it. To restore a user-visible order after several shuffles, keep it yourself and rebuild with `loadPlaylist` |

`PlaylistAddOptions` adds `position` and `play` to the per-source options:

| `position` | where the entry lands |
|---|---|
| omitted | the end of the queue |
| `'next'` | immediately after the current entry |
| `number` | that exact index; outside `0 … count` it **throws** rather than clamping, because mpv's own behaviour there is to silently append |
| plus `play: true` | mpv's `*-play` variant: start playback *if nothing is currently playing*. Not "play this now" — for that, add the entry and `jumpTo` it |

| Constraint | Detail |
|---|---|
| Insertion is one command, not two | `position` compiles onto mpv's own `insert-next` / `insert-at` load actions, so the queue is never briefly wrong the way an append-then-move pair leaves it. Key your own metadata on `entryId`, never on the array index: an insert renumbers everything after it, and `entryId` is unique for the life of the core |
| `queueChanged.reason` is `'resized'` or `'reordered'` | A reorder issued through the raw `command()` escape hatch is invisible to the event, because a reorder changes no observable mpv property — the price of not streaming the queue across the bridge |
| An insert during an in-flight prefetch is not itself prefetched | The insert is correct; it costs the prefetch in flight, and the boundary opens cold. Insert well before the current track ends |

### State, metadata and chapters

| | what it does | notes |
|---|---|---|
| `player.state: PlayerState` | Immutable snapshot | `status`, `playing`, `duration`, `isLive`, `rate`, `pitch`, `volume`, `muted`, `loop`, `playlist: { index, count }`, `hasNext`, `hasPrevious`, `chapter`, `title`, `seeking`, `seekable`, `bufferedPosition`, `bufferingPercent`, `positionAnchor`, `positionAnchorMs`, `error`, … |
| `onStateChange(fn): Unsubscribe` | Fires only on real changes | |
| `getPosition()` / `resyncPosition()` | Seconds, **projected locally**; the second re-reads mpv and re-anchors | No bridge traffic, no timers |
| `clearError(): boolean` | Dismiss `state.error` | Clears state only — it never suppresses or replays an event |
| `getMetadata()` / `getMetadataValue(key)` / `getCommonMetadata()` | mpv's typed tag map, one case-insensitive tag, or the normalised set | One node read, no string parsing, and the map cannot mix two tag generations. `'icy-title'` is how radio now-playing arrives |
| `getChapters()` · `setChapter(index)` · `nextChapter()` · `previousChapter()` | `{ title?, start }[]` with `start` in seconds, plus navigation | Podcasts, m4b audiobooks; `[]` when there are none, never an error |

**Position is an anchor, never a stream.** `positionAnchor` is
`{ position, timestamp, rate }` in **seconds**, updated only on discontinuities;
every surface projects `position + elapsed × rate` locally. `positionAnchorMs` is
the same fact in `media-session`'s `{ value, at, rate }` milliseconds with
`rate: 0` already applied — broadcast that one
([ARCHITECTURE §7](../../ARCHITECTURE.md#7-position-is-never-streamed--anchors--projection)).

### Hooks

All take `Player | undefined`, so they are safe before `create()` resolves.

| | returns |
|---|---|
| `usePlayer(options?)` | `{ player, error }` |
| `usePlayerState(player)` / `usePlayerState(player, selector, isEqual?)` | the whole `PlayerState`, or one derived slice that re-renders only when it changes |
| `useProgress(player, intervalMs = 250)` | `{ position, duration, buffered, isLive }`; the interval stops whenever playback is not advancing |
| `useMilestones(player, onMilestone, { marks = [25,50,75,90], intervalMs? })` | nothing — calls back at the scrobbling marks. A hook rather than a player timer, because JS timers freeze with the screen off |
| `usePrefetchStatus(player)` | `{ active: false } \| { active: true, uri, entryId?, at }` |
| `useEqualizer(player, options?)` | `Equalizer` — see [below](#audio-filters-and-eq) |
| `useVisualizer(player, options?, enabled?, pauseWhenInactive?)` | `{ frame, error, active }` |

### Events

`player.on(name, listener): Unsubscribe`.

| event | payload |
|---|---|
| `trackChanged` / `trackEnded` | `{ index, previousIndex }` / `{ index }` — the second means finished naturally |
| `queueEnded` | *(none)* — playback ran off the end |
| `queueChanged` / `chapterChanged` | `{ count, reason: 'resized' \| 'reordered' }` / `{ index?, previousIndex? }` |
| `seekStarted` / `seekCompleted` | `{ reason: 'seek' \| 'auto-advance', from }` / `{ …, position }` — the pair analytics reconstructs listened time from, and it arrives with the screen off |
| `metadataChanged` | `Metadata` — at most once per native event batch, and only while something is listening |
| `prefetchStarted` | `{ uri, entryId? }` — fires seconds into the current track, when mpv releases its opener thread. Needs no resolver, and never occurs on a build without the fork's hook |
| `retrying` / `error` | `{ index, attempt, maxAttempts, error }` / `(error: PlayerError, info: { attempts })` |
| `log` | `{ level, prefix, text }` from mpv itself |

### Audio processing

| | what it does | notes |
|---|---|---|
| `setAudioFilters(filters): void` | Compiles typed descriptors into mpv's `af` grammar | Replaces the whole user chain. Rejects a chain carrying an `@rnmedia_…` label, which is reserved for managed entries |
| `clearAudioFilters()` / `getAudioFilters(): string` | Clear the user chain, or read the compiled chain as mpv sees it | `clearAudioFilters` leaves the managed loudnorm entry alone |
| `setAudioFilterParam(filter, param, value)` | mpv's `af-command`: change one value without rebuilding the chain | Needs a labelled entry. `AUDIO_FILTER_RUNTIME_PARAMS` lists what can change this way; `diffAudioFilterParams(from, to)` answers "same graph, different numbers?" |
| `setReplayGain(options): void` / `getReplayGainMode()` | Volume-domain gain from the file's tags: `{ mode: 'no' \| 'track' \| 'album', preamp?` (dB, `-150 … 150`)`, clip?, fallback?` (dB, `-200 … 60`)` }` | Applies to the *playing* track with no gap and no reload. Only the fields you pass are written, and out-of-range values throw instead of being clamped. `clip` means "**allow** clipping": peak limiting is on by default and `clip: true` turns it off. `fallback` replaces the tag logic for untagged files *and* whenever `mode` is `'no'`, so pass `{ mode: 'no', fallback: 0 }` to return to unity gain |
| `setLoudnessNormalization(enabled, options?)` / `getLoudnessNormalization()` | A managed `loudnorm` entry for files with no tags | `{ targetLufs?, loudnessRange?, truePeakDb?, dualMono? }` |
| `AudioFilters.*` | `equalizer`, `bass`, `treble`, `lowpass`, `highpass`, `graphicEqualizer`, `crossfeed`, `compressor`, `limiter`, `dynamicNormalizer`, `loudnorm`, `volume`, `custom` | `custom` reaches any ffmpeg audio filter compiled in; `GRAPHIC_EQUALIZER_BANDS` is the 18-band centre list |
| `EQUALIZER_PRESETS` / `EQUALIZER_PRESET_LIST` / `EQUALIZER_BANDS` | 22 tuned 10-band curves; the list is picker-ordered; the bands are the ISO centres | `EQUALIZER_BAND_COUNT` is 10 |
| `equalizerPresetChain(preset, options?)` | Preset → filter chain with a computed pre-amp | `{ editable: true }` labels every band so `setAudioFilterParam` can find it, and emits all ten bands so the chain's shape never depends on the gains |
| `defineEqualizerPreset(id, name, gainsDb)` | Validates a user-designed curve | Exactly 10 gains |
| `serializeEqualizerSettings` / `parseEqualizerSettings` | The on-disk form `useEqualizer`'s `storage` writes | Parse returns a typed `EqualizerRestoreResult` and never throws |
| `player.visualizer.capabilities` | `{ fft, waveform, maxFps, minFftSize, maxFftSize }` | `fft: false` on binaries without the PCM-tap patch |
| `player.visualizer.subscribe(listener, options?)` | Imperative spectrum | Never auto-paused — the hook is what pauses |

ReplayGain and `setLoudnessNormalization` are **mutually exclusive** and the API
enforces it, because their gains would stack. Enabling either disables the other.

### Escape hatch

`command` · `getPropertyString` / `Number` / `Bool` · `setPropertyString` /
`Number` / `Bool` · `observeProperty` · `unobserveProperty` ·
`getRawHandle(): bigint`. A complete raw mpv client, with two documented limits:
an extra observed property does not become a `Player` event, and video stays out
([docs/engine.md](../../docs/engine.md#reaching-into-mpv)).

## Audio filters and EQ

```ts
import { AudioFilters, EQUALIZER_PRESETS, equalizerBandLabel, equalizerPresetChain } from '@timbre/player'

player.setAudioFilters([AudioFilters.bass({ gain: 4 }), AudioFilters.crossfeed({ strength: 0.3 })])

// A slider commands the running filter instead of rewriting the chain.
const chain = equalizerPresetChain(curve, { editable: true })
player.setAudioFilters(chain)
const band = chain.find((f) => f.label === equalizerBandLabel(5)) // the 1 kHz band
if (band !== undefined) await player.setAudioFilterParam(band, 'g', -3)
```

Each factory validates against the underlying filter's ranges and throws
`invalid-state` rather than letting mpv fail later.

| Constraint | Detail |
|---|---|
| `af` is a global mpv option, not per-entry | A chain survives track changes by design, and unmounting an EQ screen does not clear it. `setEnabled(false)` takes it off |
| A preset's pre-amp comes from the summed magnitude response | Octave-spaced bells overlap and add, so attenuating by the largest slider would still clip. Bands at 0 dB are dropped, and a flat preset compiles to an empty chain |
| Every non-flat curve gets an `alimiter` on the tail | The pre-amp bounds gain in the frequency domain; clipping is a time-domain event, so the limiter is where the guarantee comes from (`{ limiter: false }` opts out). It costs 5 ms of uncompensated look-ahead: 5 ms of silence when the chain is built, and the last 5 ms of the stream is never flushed. ffmpeg's `level` option also scales the result back up to full scale — pass `autoLevel: false` with any ceiling below 1 |
| `setAudioFilters` recreates every entry whose arguments changed | Fine for a settings change, ruinous for a slider. Use `setAudioFilterParam` during a gesture and write the chain once it is over |
| `getAudioFilters()` shows the value an entry was created with | `af-command` deliberately does not rewrite the property, so anything that rebuilds the chain from it puts the old value back |
| The chain order is equaliser → your chain → the managed loudness entry | The pre-amp must attenuate before the boosts it is sized for; the loudness entry must hear everything above it |
| Availability | The filters are in the pinned binaries on both platforms. On an older or overridden binary the call fails with an `mpv` `PlayerError` carrying `errno: -11` |

Design rationale: [ARCHITECTURE §18](../../ARCHITECTURE.md#18-eqdsp-is-a-typed-chain-over-mpvs-af-not-a-native-module).

### `useEqualizer()`

The whole EQ screen on one hook ([worked
example](../../docs/recipes/music-player.md#an-eq-screen-over-the-same-player)).
Returns `{ enabled, bands, gainsDb, gainRangeDb, preset, presets, savedPresets,
error, hydrated }` plus `setEnabled`, `setBandGain`, `setBandGains`,
`applyPreset`, `reset`, `savePreset`, `deletePreset`. Options: `initialPreset`,
`initialEnabled`, `chain`, `gainRangeDb` (±12 dB), `storage`, `storageKey`,
`onStorageError`, and the deprecated `extraFilters`.

| Behaviour | Detail |
|---|---|
| `preset` is derived, not remembered, and there is no change event | `preset` is whichever preset the current gains *are*, and `undefined` is what a UI draws as "Custom". The returned object is the notification: every mutator re-renders with a fresh immutable snapshot |
| A gain-only change is pushed with `af-command` | No chain rebuild and no click, whatever the frame rate of the gesture. A graph change is one `setAudioFilters` |
| 250 ms after the last in-place change, one `setAudioFilters` commits | So the curve survives the next track or device switch. That is the hook's only timer, and it is flushed on unmount |
| The hook owns only its own `@rnmedia_eq_…` entries | Your `setAudioFilters` chain survives a slider drag |
| Gains are clamped; wrong lengths and non-finite values throw | A slider at its stop is not a bug; ten gains that are not ten gains is |
| `storage` is injected, and this package depends on none | A **synchronous** engine is read through synchronously, so the first `af` write is already the restored curve; an **asynchronous** one leaves `hydrated` `false` and writes nothing to mpv until the record arrives |
| Built-in presets are never persisted | So a release that retunes `Rock` takes effect. A corrupt record means "start from the defaults"; a *storage* failure reaches `onStorageError` |
| `savePreset(name)` joins `presets` | Saving twice under one name replaces it; `deletePreset(id)` throws on a built-in id and no-ops on an unknown one |

## Visualizer (spectrum + waveform)

```ts
if (player.visualizer.capabilities.fft) {
  const stop = player.visualizer.subscribe(
    (frame) => paint(frame.bands),  // Float32Array, [0, 1], already smoothed
    { bands: 32, fps: 30, waveform: false }
  )
  stop() // disarms mpv's tap
}
```

`useVisualizer(player, { bands: 28 })` is the React form.

| | Detail |
|---|---|
| A `VisualizerFrame` carries | `bands` (log-spaced, dB-mapped, asymmetrically smoothed), `peaks` (peak-hold caps that snap up, hang for `peakHoldFrames`, then fall under accumulating `peakGravity`), `magnitudes` (raw per-bin linear magnitudes, `fftSize / 2 + 1` long, for your own mel/Bark/chroma mapping), `gainDb`, and — only with `{ waveform: true }` — `waveform`, `peak` and `rms` |
| Both platforms, one code path, no permission | The samples come from mpv itself through a `pcm-tap` patch in both binary forks. There is no `Platform.OS` in the feature and nothing to add to your manifest |
| It taps what you hear, and it needs binaries carrying the patch | The tap sits where mpv hands audio to the device, after the filter chain and after mpv's software gain. On a binary without it, `capabilities.fft` is `false` and `subscribe()` throws a typed `unsupported` error — it never silently does nothing |
| 30 fps by default, 60 available | That is the *delivery* rate; new spectral content arrives no faster than the audio device consumes chunks. `frame.dropped` tells you when painting cannot keep up — measure it in a release build |
| Zero cost when nobody is looking | The tap is disarmed and its write path is one atomic load per device chunk; the first `subscribe()` creates the ring, the FFT tables and the sampler thread, and the last unsubscribe frees them |
| The FFT is native, the optics are yours | PCM never crosses into JavaScript; ~4 KB of spectrum per frame does. Bands, dB window, tilt, auto-gain, smoothing and peak ballistics are TypeScript, per subscriber. `fftSize`, `fps` and `waveform` are the union across live subscribers; everything else is per subscriber |
| `tiltDbPerOctave` and `autoGain` default to off | Faithful by default. Auto-gain is bounded to −6…+18 dB, backs off four times faster than it builds, and holds still below −95 dBFS so it cannot amplify a noise floor |
| The hook pauses itself when nothing can be seen | Frames are native callbacks, so unlike a JS timer they keep arriving behind a locked screen. "Can be seen" is `AppState` **and** the device display state, ANDed, because on Android those are different facts. Resuming is a fresh subscription, so bars rise from zero. Audio is unaffected |

Opt out of the pause with `useVisualizer(player, options, true, false)`, or
subscribe imperatively, which is never `AppState`-gated. The hook re-renders at
the frame rate, so keep it in a small leaf component
([ARCHITECTURE §21](../../ARCHITECTURE.md#21-the-visualizer-taps-mpv-itself--we-patched-libmpv-rather-than-ship-an-android-only-feature)).

## Dynamic source resolution (signed URLs, transcode sessions)

For queues whose entries cannot be written down ahead of time: a signed CDN link
that expires in minutes, a transcode session created per track.

```ts
import { Player, type SourceResolver } from '@timbre/player';

const resolve: SourceResolver = async ({ uri }) => {
  if (!uri.startsWith('library://')) return uri;                    // pass through
  return (await api.signPlaybackUrl(uri.slice('library://'.length))).url;
};
const player = await Player.create({ prefetchPlaylist: true, sourceResolver: resolve });
await player.loadPlaylist(['library://a', 'library://b', 'library://c']);
```

| Constraint | Detail |
|---|---|
| Nothing about the URL changes until you install a resolver | The two mpv load hooks are registered when the core starts, but the handler is disarmed: it reads nothing and continues the hook immediately, so what mpv opens is byte-for-byte the URI you queued |
| Resolution runs ahead | The current and next entries are resolved as the queue moves, read from mpv's own playlist, so it follows `next()`, repeat and shuffle. A resolved entry costs a map lookup and one property write |
| Only a play-time miss holds mpv | For up to `resolverTimeoutMs`; on timeout the original URI is used and mpv fails the load on its own terms, arriving as an ordinary typed `error` |
| Your resolver must be deterministic while an entry is queued | mpv opens each entry twice and reuses the prefetched stream only if the two URLs are byte-identical, so a fresh nonce per call defeats prefetching and the boundary opens cold. One answer per URI is cached and replayed for `resolverTtlMs`: mint once per track, and size the TTL to cover a track while staying inside your signature's lifetime |
| A resolver that throws, rejects or returns a non-string | Emits a typed `load-failed` error, caches nothing, and is retried on the next queue movement |
| The prefetch half needs our forks | Upstream mpv deliberately does not fire a hook there. On a stock libmpv the play-time half still works and prefetched entries open unresolved |

## Two routes to a title, and which one you want

| | `state.title` | `metadataChanged` + `getMetadataValue()` |
| --- | --- | --- |
| shape | one coalesced string | the whole tag map, or one key |
| delivery | in **every snapshot** — rides the state fan-out, and therefore every broadcast channel and the media session | an **event**, and only while something is listening |
| cost | none beyond the snapshot | one node read per batch that touched the tags |
| on a radio stream | the currently-playing **song**, updating on its own | the **station**: `icy-name`, `icy-genre`, `icy-br`, … |

Use `state.title` for the now-playing line: a media session re-broadcasts state
rather than events, so a title delivered only as an event would never reach the
notification. Use `metadataChanged` for specific keys — building the map is a
synchronous read into mpv's core, so it is opt-in.

## Recovering from network failures

Two layers, answering different questions.

**1. FFmpeg reconnection (`networkReconnect`, on by default)** answers "can this
connection be re-made". It runs inside libavformat's read loop with no JavaScript
and no timers — the only kind of retry that works with the screen off. Through
mpv's `stream-lavf-o` it sets `reconnect=1`, `reconnect_on_network_error=1`,
`reconnect_streamed=1` and `reconnect_delay_max=5`; FFmpeg's backoff is
`delay = 1 + 2 * delay` from `0`, so `5` means attempts at 0 s, 1 s and 3 s. Opt
out with `{ enabled: false }`, widen it with `{ maxDelaySeconds: 20 }`.

`reconnect_at_eof` is deliberately not set: FFmpeg does not guard it on whether
the stream is seekable, so on a sized file the natural end of the response *is*
`AVERROR_EOF`, and enabling it turns every clean track end into a retry storm
ending in `EIO`. HTTP status codes are not retried either — that is
`reconnect_on_http_error`, a policy an app chooses for itself. A live-only app
can opt in by replacing the whole list through `mpvOptions['stream-lavf-o']`.

**2. Player-level re-attempt (`retry`, 2 attempts by default, `0` disables)**
answers "should the queue move on?". mpv's own behaviour on a hard failure is to
advance, which is right for a file that will never play and wrong for a stream
that was unlucky.

| Constraint | Detail |
|---|---|
| `error` counts give-ups, not failures | A retryable failure jumps back to the entry, preserves whether it was playing, and emits `retrying`; no `error` is emitted for that attempt |
| There is no delay between attempts | The only way to wait in JavaScript is a timer, and JS timers freeze with the screen off — spaced backoff is layer 1's job. The re-attempt is issued after mpv already started the next entry, so a failure at a queue boundary can produce a brief blip of the following track |
| Attempts are tracked per entry generation | Reset when the entry plays, when a different entry fails, or when the app moves the cursor or edits the queue |
| `retryLiveEof` (off) re-attempts a clean close on a **live** entry | A finite track is never affected. The re-attempt emits `retrying` with a synthesised `network` error and no `trackEnded`; once the budget is spent the end is reported as the `trackEnded` it always was. The budget refills only after 30 s of playback, so a server hanging up every second cannot loop forever |

## Errors

Every `PlayerError` carries `retryable: boolean` — "could repeating the identical
operation plausibly succeed with nothing else changed?". Read that rather than
maintaining a table of codes; it is also what `retry` consumes. `network` is
`true`, and so is `mpv` with `errno: -14` (`AO_INIT_FAILED`), because the audio
device is shared and a route change can lose you one open and not the next.
Everything else is `false`. A natural end of stream is a `trackEnded` event and
never an error; `PlayerErrorException` is the thrown form. `state.error` clears
on a new entry starting, on playback restarting, or on a deliberate stop, and
survives only when the last entry failed and nothing has happened since — which
is what `clearError()` is for.

## Platform parity

Every public member behaves identically on Android and iOS except the rows below.
There is no member that exists on one platform and quietly does nothing on the
other.

| Member | Android | iOS | Verdict |
|---|---|---|---|
| `getScreenStateSource().interactive` and its subscription | `PowerManager.isInteractive()` + `ACTION_SCREEN_ON`/`OFF` | constant `true`, subscription never fires | **ceiling** — locking an iPhone resigns active state, so `AppState` already *is* the display truth, and there is no public API for display power |
| Background playback setup | nothing to add | `UIBackgroundModes: audio` in your `Info.plist` | **setup differs** |
| `content://` sources | `ContentResolver` → mpv `fd://`, transparently | n/a — iOS has no equivalent scheme | **parity** |
| Verification coverage | device-verified | CI build plus shipped-binary inspection, simulator slice only | **coverage differs** |

The surface is symmetric by construction: everything from playback to the error
taxonomy lives in one shared C++ core over libmpv's client API, with no platform
branch and no `ao=` set at all
([ARCHITECTURE §11](../../ARCHITECTURE.md#11-binaries-pinned-forked-lgpl-dynamically-linked)).
`content://` URIs play with nothing to configure: `load()`, `loadPlaylist()` and
`playlist.add()` open them through `ContentResolver` and hand mpv its own `fd://`
protocol, once per URI, for the life of the player
([ARCHITECTURE §32](../../ARCHITECTURE.md#32-content-is-a-binder-call-so-it-becomes-a-file-descriptor)).

| `content://` constraint | Detail |
|---|---|
| Seeking follows the provider | mpv decides seekability by `lseek`-ing the descriptor, so a file-backed URI is seekable and reports a duration while a pipe-backed one surfaces exactly like a live stream |
| The grant is yours to keep | A picker's read permission dies with the process; call `takePersistableUriPermission()` for a URI you store, or the next load fails with a typed `load-failed` |
| Never queue one `content://` URI at two adjacent positions | One descriptor serves one URI, so the playing and prefetched entries would share a file offset |

## Also exported

| Group | Exports |
|---|---|
| Error taxonomy | `PlayerError` — the union `NetworkError \| UnsupportedFormatError \| LoadFailedError \| DisposedError \| InvalidStateError \| UnsupportedError \| RawMpvError`; `PlayerErrorCode`; `PlayerErrorException`; `Retryable`; `toPlayerError(thrown, uri?)`, `isRetryableErrno(errno)`, `isNetworkUri(uri)`; `EndFileOutcome` / `classifyEndFile` |
| Defaults | `DEFAULT_USER_AGENT` = `'timbre (libmpv)'`, `DEFAULT_CACHE_SECS` = `30`, `DEFAULT_RETRY_MAX_ATTEMPTS` = `2`, `DEFAULT_RECONNECT_DELAY_MAX_SECONDS` = `5`, `DEFAULT_RESOLVER_TIMEOUT_MS` = `10_000`, `DEFAULT_RESOLVER_TTL_MS` = `600_000`, `DEFAULT_VISUALIZER_FPS` = `30` |
| Option types | `RetryOptions`, `NetworkReconnectOptions`, `SourceResolverOptions`, `VisualizerOptions`, `VolumeOptions`, `GaplessAudioMode`, `ReplayGainMode`, `HttpHeaders` |
| Equaliser | `EqualizerPreset`, `EqualizerPresetId`, `EqualizerBand`, `EqualizerGainRange`, `EqualizerSettings`, `EqualizerStorage`, `UseEqualizerOptions`, `EQUALIZER_PREAMP_LABEL`, `EQUALIZER_LIMITER_LABEL`, `LOUDNESS_NORMALIZATION_LABEL`, `EQUALIZER_SCHEMA_VERSION`, `DEFAULT_EQUALIZER_STORAGE_KEY` |
| Filters | `CompressorOptions`, `LimiterOptions`, `LoudnormOptions`, `DynamicNormalizerOptions`, `CrossfeedOptions`, `ShelfOptions`, `PassOptions`, `BiquadWidthType`, `assertValidAudioFilters` |
| State and events | `PlayerStatus`, `PositionAnchor`, `PositionAnchorMs`, `Progress`, `Milestone`, `PlaylistApi`, `PlaylistPosition`, `PlayerEvent`, `PlayerEventMap`, `PlayerEventName`, the per-event types (`TrackChangedEvent`, `TrackEndedEvent`, `SeekEvent`, `QueueChangedEvent`, `ChapterChangedEvent`, `PrefetchStartedEvent`, `RetryingEvent`, `LogEvent`, …), `PositionDiscontinuityReason`, `QueueChangeReason` |
| Hooks' result types | `UsePlayerResult`, `UseVisualizerResult`, `PlayerStateSelector` |
| Visualizer | `VisualizerController`, `VisualizerCapabilities`, `VisualizerCapture`, `VisualizerListener`, `VISUALIZER_DEFAULTS` |
| Escape hatch | `MpvEvent`, `MpvEventKind`, `MpvProperty`, `MpvPropertyValue`, `MpvFormat`, `MpvLogLevel`, `MpvEndFileReason`, `OBSERVED_PROPERTIES`, `MpvClientFactory` |
| `content://` (Android) | `isContentUri(uri)`, `ContentUriResolver` (the built-in rewrite), `ContentUriOpener` / `getContentUriOpener()` / `setContentUriOpener(fn)` (override the fd source, e.g. a SAF grant), `CONTENT_URI_SCHEME`, `CONTENT_URI_FD_LIMIT` — see [ARCHITECTURE §32](../../ARCHITECTURE.md#32-content-is-a-binder-call-so-it-becomes-a-file-descriptor) |
| Audio-processing types | `AudioFilter`, `EqualizerPresetChainOptions`, `ReplayGainOptions`, `LoudnessNormalizationOptions`, `AudioChannelMode` (`'auto-safe' \| 'auto' \| 'stereo' \| 'mono'`), `MANAGED_FILTER_LABEL_PREFIX` (the reserved `rnmedia_` prefix `setAudioFilters` rejects) |
| Metadata and chapters | `CommonMetadata`, `ChapterEntry`, `LoopMode` (`'off' \| 'track' \| 'playlist'`) |
| Pure internals, exported for tests — **not API**, and carrying no stability promise | the reducer and its helpers (`createInitialState`, `toPlayerEvent`, `toPlayerEvents`, `ReducerContext`, `withResyncedAnchor`, `isPositionDiscontinuity`, `clearPlayerError`, `disposedError`, `toVisualizerError`, `TrackChangeReads`, `LoopRaw`), the mpv property helpers (`ObservedProperty`, `isMetadataProperty`, `metadataKeyProperty`, `metadataByKeyProperty`, `metadataValueProperty`, `playlistFilenameProperty`, `toCommonMetadata`), filter-string helpers (`escapeAfParam`, `escapeSubparam`, `peakResponseDb`, `compileHttpHeaderFields`, `HTTP_HEADER_FIELDS_OPTION`, `utf8Length`, `AudioFilterOption`, `AudioFilterParamChange`, `EqualizerOptions`, `GraphicEqualizerOptions`), visualizer decoding (`createDecodeState`, `decodeVisualizerFrame`, `resolveVisualizerOptions`, `VisualizerDecodeState`, `VisualizerUnsubscribe`), the raw mpv event types (`StartFileEvent`, `EndFileEvent`, `PlaybackRestartEvent`, `SeekStartedEvent`, `SeekCompletedEvent`, `PropertyEvent`, `ShutdownEvent`), `PrefetchStatus` / `PrefetchIdle` / `PrefetchActive`, `SourceOptions`, `SourceResolutionRequest`, `SourceResolverController`, `PlayerErrorInfo`, `PlayerLogLevel`, and the tuning constants `AGC_SILENCE_DB`, `BUFFERED_POSITION_STEP`, `BUFFERING_PERCENT_STEP`, `DEFAULT_EQUALIZER_GAIN_RANGE_DB`, `DEFAULT_LOUDNESS_TARGET_LUFS`, `DEFAULT_MILESTONES`, `DEFAULT_PROGRESS_INTERVAL_MS`, `DEFAULT_RESTART_THRESHOLD_SECONDS`, `MPV_VOLUME_SCALE` |

## Contributing

See [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Bootstrapped with
[create-nitro-module](https://github.com/patrickkabwe/create-nitro-module).
