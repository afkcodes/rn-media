# @rn-media/player

React Native audio player built on libmpv, powered by Nitro Modules.

[![Version](https://img.shields.io/npm/v/@rn-media/player.svg)](https://www.npmjs.com/package/@rn-media/player)
[![Downloads](https://img.shields.io/npm/dm/@rn-media/player.svg)](https://www.npmjs.com/package/@rn-media/player)
[![License](https://img.shields.io/npm/l/@rn-media/player.svg)](https://github.com/afkcodes/rn-media/blob/main/LICENSE)

## Requirements

- React Native **v0.82.0 or higher** (New Architecture only)
- Node 18.0.0 or higher

## Installation

```bash
npm install @rn-media/player react-native-nitro-modules
```

## Usage

```tsx
import { usePlayer, usePlayerState, useProgress } from '@rn-media/player';

function Screen() {
  const { player, error } = usePlayer({
    volume: 0.8,
    setup: p => p.load('https://example.com/track.flac'),
  });
  const state = usePlayerState(player);
  const { position, duration, buffered } = useProgress(player);

  return (
    <Button title={state.playing ? 'Pause' : 'Play'} onPress={() => player?.toggle()} />
  );
}
```

Outside React:

```ts
import { Player } from '@rn-media/player';

const player = await Player.create({ volume: 0.8 });
const unsubscribe = player.onStateChange(state => console.log(state.status));
player.on('trackEnded', ({ index }) => console.log('finished', index));
player.on('error', err => console.error(err.code, err.message));

await player.loadPlaylist([a, b, c], { startIndex: 0 }); // gapless, mpv playlist
player.play();
await player.seekTo(30);
player.setRate(1.5);
player.setVolume(0.5); // 0..1, mapped onto mpv's 0..100
player.getVolume(); // 0..1, read straight back from mpv
player.setLoop('playlist');

player.getPosition(); // projected locally — never polls native

unsubscribe();
player.destroy();
```

### Queue

```ts
await player.loadPlaylist(sources, { startIndex: 2 }); // gapless, mpv playlist
await player.loadPlaylist(sources, { shuffle: true }); // shuffled, starts at the top

await player.playlist.add(uri, { playNow: true });
await player.playlist.remove(3);
await player.playlist.move(0, 4); // ordinary array semantics
await player.playlist.jumpTo(2); // plays it; pass { autoPlay: false } to stay paused
await player.playlist.next();
await player.playlist.previous();
await player.playlist.clear(); // keeps the entry that is playing
await player.playlist.shuffle(); // mpv `playlist-shuffle`
await player.playlist.unshuffle(); // undoes the last shuffle — once
```

**Shuffle.** `playlist.shuffle()` is mpv's `playlist-shuffle`, which permutes
*every* entry, including the one playing. The track keeps playing (mpv tracks the
entry, not the index), but its `playlist-pos` moves — so you get a `trackChanged`
event for a track that did not change. Read `state.playlist.index` and carry on.

`playlist.unshuffle()` is a **one-level undo**, and mpv says so: "Attempt to
revert the previous `playlist-shuffle` command. This works only once (multiple
successive `playlist-unshuffle` commands do nothing)." Each shuffle overwrites
the recorded original order. If you need to restore a user-visible order after
several shuffles, keep it in your app and rebuild with `loadPlaylist`.

`loadPlaylist(sources, { shuffle: true })` shuffles after every entry is
appended and before playback starts, so playback begins at the top of the
shuffled order. **Combining it with `startIndex` throws** an `invalid-state`
`PlayerError`: after a whole-list shuffle an index no longer identifies the
source you passed at that position, and quietly reinterpreting it would be a
coin flip. For "shuffle, but start with *this* track", put that track first
yourself, or load in order and call `playlist.shuffle()` afterwards.

### Audio filters and EQ

```ts
import { AudioFilters, EQUALIZER_PRESETS, equalizerPresetChain } from '@rn-media/player'

player.setAudioFilters(equalizerPresetChain(EQUALIZER_PRESETS.rock))
player.setAudioFilters([
  AudioFilters.equalizer({ frequency: 60, widthType: 'o', width: 1, gain: 4 }),
  AudioFilters.crossfeed({ strength: 0.3 }),
  AudioFilters.limiter(),
])
player.getAudioFilters() // mpv's own `af` string, read back
player.clearAudioFilters()
```

Typed descriptors compile into mpv's `af` grammar — one mpv entry per filter,
escaped exactly the way mpv's own serialiser writes it. Factories:
`equalizer`, `bass`, `treble`, `lowpass`, `highpass`, `graphicEqualizer`
(18-band `superequalizer`), `crossfeed`, `compressor`, `limiter`,
`dynamicNormalizer`, `loudnorm`, `volume`, and `custom` for any other
libavfilter audio filter that is compiled in. Each validates against the
underlying filter's documented ranges and throws `invalid-state` rather than
letting mpv fail later.

**Presets.** `EQUALIZER_PRESETS` holds 22 tuned 10-band curves (ISO octave
centres, nothing beyond ±9 dB); `EQUALIZER_PRESET_LIST` is the same set in
picker order, and `defineEqualizerPreset(id, name, gainsDb)` validates a
user-designed one. Apply them through `equalizerPresetChain`, which computes the
pre-amp from the *summed* magnitude response — octave-spaced bells overlap and
add, so `Loudness` peaks at +8.8 dB from +7 dB sliders and attenuating by the
largest slider would still clip. Bands at 0 dB are dropped, a flat preset
compiles to an empty chain, and an `alimiter` is appended as the inter-sample
safety net (`{ limiter: false }` opts out).

Notes:

- **`af` is a global mpv option, not per-entry** — a chain survives track
  changes by design.
- **Nothing interacts.** mpv's speed handling (`scaletempo2`) sits downstream
  of the user chain, and ReplayGain is volume-domain, so filters, `setRate()`
  and `setReplayGain()` compose freely. Watch total headroom, not ordering.
- **Availability probe.** The filters exist in our pinned binaries on both
  platforms (Android `v1.1.9-rnmedia.2`, iOS `v0.7.2-rnmedia.2`), so no
  platform branching is needed. On an older or overridden binary the call fails
  honestly with a `mpv` `PlayerError` carrying `errno: -11`.

### Visualizer (spectrum + waveform)

```tsx
import { useVisualizer } from '@rn-media/player'

function Bars({ player }) {
  const { frame, error } = useVisualizer(player, { bands: 28 })
  if (error) return <Text>{error.message}</Text>
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
      {Array.from(frame?.bands ?? []).map((value, i) => (
        <View key={i} style={{ width: 6, height: 3 + value * 57 }} />
      ))}
    </View>
  )
}
```

Or imperatively, which is what the hook is built on:

```ts
if (player.visualizer.capabilities.fft) {
  const stop = player.visualizer.subscribe(
    (frame) => paint(frame.bands),  // Float32Array, [0, 1], already smoothed
    { bands: 32, fps: 30, waveform: false }
  )
  stop() // disarms mpv's tap
}
```

A `VisualizerFrame` carries `bands` (log-spaced, dB-mapped, asymmetrically
smoothed — paint them directly and the bounce is already there), `peaks`
(classic peak-hold caps: each snaps up instantly, hangs for `peakHoldFrames`,
then falls under accumulating `peakGravity` — the floating markers above the
bars in a Winamp-style analyser), `magnitudes` (raw per-bin **linear**
magnitudes where `1.0` is a full-scale sinusoid, `fftSize / 2 + 1` long, for
your own mel/Bark/chroma mapping), `gainDb` (what the auto-gain is currently
doing) and — only with `{ waveform: true }` — `waveform`, `peak` and `rms` for
an oscilloscope or VU meter.

**How it works, and what that buys you:**

- **Both platforms, one code path, no permission.** The samples come from mpv
  itself, through two properties (`pcm-tap`, `pcm-tap-frame`) added by this
  project's own libmpv patch — the same patch file in both binary forks. There is
  no `Platform.OS` anywhere in the feature and **nothing to add to your
  manifest**. (The Android-only route through
  `android.media.audiofx.Visualizer` would have required
  `android.permission.RECORD_AUDIO` from every consuming app, capped you at
  ~20 fps and 8-bit data, and had no iOS half at all. See ARCHITECTURE §21.)
- **It taps what you hear.** The tap sits where mpv hands audio to the device —
  after the filter chain and after mpv's software gain — so your EQ, ReplayGain
  and volume are all in the picture.
- **It needs binaries that carry the patch.** Android `v1.1.9-rnmedia.3`+ or iOS
  `v0.7.2-rnmedia.3`+, which is what this package pins. On anything older
  `capabilities.fft` is `false` and `subscribe()` throws a typed `unsupported`
  `PlayerError` — it never silently does nothing.
- **30 fps by default, 60 available and reached.** That is the *delivery* rate.
  New spectral content arrives no faster than the audio device consumes chunks
  (measured at ~20-45 Hz on Android, where `ao_audiotrack` writes one
  `getMinBufferSize() × 2` chunk at a time), and the asymmetric smoothing is what
  turns a stepped target into continuous motion. Measured in a release build of
  `apps/example`: **60 requested, 60.0 delivered, zero dropped.** `frame.dropped`
  tells you when your painting cannot keep up — and note that a *debug* build of
  the same screen managed 24-26, so measure this in release or you will blame the
  wrong layer.
- **Zero cost when nobody is looking.** No sampler thread, no FFT table, no
  ring — mpv's tap is disarmed and its whole write path is a single atomic load
  per device chunk. The first `subscribe()` creates all of it, the last
  unsubscribe frees it. Reading `capabilities` allocates nothing.
- **The FFT is native, the optics are yours.** The PCM never crosses into
  JavaScript: it is downmixed, Hann-windowed and transformed on a native sampler
  thread, and only the spectrum makes the trip (~4 KB per frame). Everything
  above that — bands, dB window, tilt, auto-gain, smoothing, peak ballistics —
  is TypeScript, per subscriber, and unit-tested without a device.
- **Subscribers share one engine.** `fftSize`, `fps` and `waveform` are resolved
  as the union across live subscribers; `bands`, the dB window, `tiltDbPerOctave`
  and the smoothing are per subscriber, so two components can paint the same
  audio with different ballistics.

Two display aids exist — `tiltDbPerOctave` and `autoGain` — and both default to off (faithful-by-default; see ARCHITECTURE).** Music's power falls at roughly 3 dB per octave.
  Drawn literally, the top half of the display barely moves whatever is playing.
  Set `0` for a physically literal spectrum.
- **`autoGain: false`.** A fixed dB window cannot serve both a `-8 LUFS` master
  and a quiet acoustic recording — one pegs every bar, the other never leaves the
  floor. The gain is bounded (`-6`…`+18 dB`), backs off four times faster than it
  builds, and holds still below `-95 dBFS` so it can never amplify a noise floor
  into a full-height display. Set `false` for a calibrated meter whose height
  means one fixed thing.

`useVisualizer(player, options, enabled, pauseWhenInactive)` re-renders at the
frame rate by design, so keep it in a small leaf component. `apps/example` shows
the render pattern worth copying: the coloured column and the LED grid are laid
out once and never touched, and each frame moves **two** Views per band by
`transform` only — no per-frame layout. For anything heavier, subscribe
imperatively and drive an animated value instead of React state.

**The hook pauses itself when your app is not in the foreground**, and takes the
subscription back when it returns (`pauseWhenInactive`, default `true`). This is
not a battery nicety, it is a correctness fix: the frames are **native**
callbacks, so — unlike a JS timer, which the platform freezes for you — they
keep arriving at full rate behind a locked screen. An ungated visualizer would
sit there calling `setState` 60 times a second at a display that cannot present
anything, and the app would have all of that to work through at the moment the
user unlocks. Because the tap is derived from the listener set, pausing the hook
really does stop everything: mpv's ring, the sampler thread and the FFT all go
away for the duration.

- **Audio is unaffected.** Playback, the media session and the notification
  carry on exactly as before; only the picture stops.
- **Resuming is a fresh subscription**, so it re-arms with the same `options`
  but smoothing, peak caps and auto-gain start from rest — `frame` is
  `undefined` for a frame or two and the bars rise from zero rather than
  resuming mid-bounce.
- **On iOS this includes `'inactive'`** (notification centre, incoming call),
  which is a brief state — a glance-away costs a re-subscribe, not a stall.
- **Opt out** — `useVisualizer(player, options, true, false)` — only for a
  surface that genuinely paints while inactive. For a non-UI consumer, use
  `player.visualizer.subscribe()` directly: **the imperative API is never
  `AppState`-gated**, and pausing is entirely a property of the hook.

### ReplayGain (loudness normalisation)

```ts
const player = await Player.create({
  replayGain: { mode: 'album', preamp: -3, fallback: -6 },
});

player.setReplayGain({ mode: 'track' }); // applies to the playing track, no reload
```

| Field      | mpv option             | Range / values         |
| ---------- | ---------------------- | ---------------------- |
| `mode`     | `replaygain`           | `'no' \| 'track' \| 'album'` |
| `preamp`   | `replaygain-preamp`    | dB, `-150 … 150`       |
| `clip`     | `replaygain-clip`      | boolean                |
| `fallback` | `replaygain-fallback`  | dB, `-200 … 60`        |

All four carry mpv's `UPDATE_VOL` flag, so `setReplayGain()` re-runs mpv's gain
computation immediately — no gap, no reload. Only the fields you pass are
written; out-of-range values throw an `invalid-state` `PlayerError` instead of
being silently clamped.

> **`clip` means "allow clipping".** mpv 0.35.1's manual has this backwards
> ("Prevent clipping … Use `--replaygain-clip=no` to disable this"), but the
> code is `if (!rgain_clip) { rgain = MPMIN(rgain, 1.0 / peak); }` and the
> default is off — i.e. peak limiting is on by default and `clip: true` turns it
> **off**. mpv fixed the wording in 0.38.0: "Allow the volume gain to clip
> (default: no)." Leave `clip` alone unless you want the limiter gone.

Files with no ReplayGain tags get `fallback` and nothing else — mpv applies it
*instead of* the tag logic, not on top of it.

### Gapless transitions

A queue is one mpv playlist, and mpv keeps the audio device open across an entry
change, so consecutive tracks join with no device teardown in between. Measured
on a Poco F4 (Android 16, release build) with a 60 s tone cut in half and encoded
twice with identical AAC parameters: **one** `AO: [audiotrack] 44100Hz stereo 2ch
float` line for the whole session covering both files, the handover from one
entry's last decoded audio to the next entry's first taking 26 ms while the audio
device still held 739 ms of the previous track — no reopen, no underrun.

```ts
await Player.create({ gaplessAudio: 'weak' }); // mpv `gapless-audio`, the default
```

The option exists for the case where consecutive entries decode to *different*
output formats:

| | behaviour |
|---|---|
| `'weak'` (default) | Device kept open while the format matches; closed and reopened when it changes — gapless for an album, a short gap across a format change. |
| `'yes'` | Device kept open always, using the **first** entry's format; later entries are resampled into it. |
| `'no'` | Device torn down and reopened between entries. |

This library does not force `'yes'`, because it buys the gap back with silent
resampling: one 22.05 kHz interlude at the head of a queue would degrade
everything after it, with nothing in the state to see it by. If you want `'yes'`,
pin the shared output format too — mpv's own advice is to set
`--audio-samplerate` / `--audio-format` (via `mpvOptions`) so you choose the
format rather than inherit whichever file happened to play first.

Gapless is an *output* guarantee, not a network one. mpv is explicit that it
"relies on audio output device buffering to continue playback while moving from
one file to another. If playback of the new file starts slowly, for example
because it is played from a remote network location […] then the buffered audio
may run out before playback of the new file can start" — which is what the next
section is for.

### Prefetching the next track

```ts
await Player.create({ prefetchPlaylist: true }); // mpv `prefetch-playlist`
```

Opens the next playlist entry's URL as soon as the current one is fully read, so
a gapless transition does not pay for a fresh connection. Off by default, and
mpv is explicit about the assumptions you are buying into:

> This can give subtly wrong results if per-file options are used, or if options
> are changed in the time window between prefetching start and next file played.
> This can occasionally make wrong prefetching decisions. For example, it can't
> predict whether you go backwards in the playlist, and assumes you won't edit
> the playlist.

So if your app mutates the queue (`move`, `remove`, `shuffle`) or steps backwards
while a track is ending, mpv may already have opened the wrong entry. It also
does **not** prefill the cache — only the current entry's data is cached.

**On a network queue this is the difference between gapless and not.** Same
device and build as above, HTTPS AAC/MP4 from a commercial CDN, two runs each,
timestamps taken from mpv's own verbose log in `logcat` (so they include the
native→JS hop; treat them as ±1 batch, not microseconds):

| | handover, decoder EOF → next entry's audio queued | device buffer left | outcome |
|---|---|---|---|
| `prefetchPlaylist: false` (default) | 644 ms / 641 ms | 202 ms / 204 ms | mpv logged `Audio device underrun detected` at the boundary — an audible gap |
| `prefetchPlaylist: true` | 25 ms / 26 ms | 816 ms / 826 ms | no underrun; mpv took its `previous audio still playing; continuing` path |

Off it goes to the network only once the current entry has ended — 568 ms of that
644 ms was waiting for the CDN's response headers, more than the device had
buffered. On it, the next entry was open ~18 s before it was needed. If you play
network queues and do not rewrite the queue mid-track, turn it on.

### Cache tuning

```ts
await Player.create({ cacheSecs: 60 }); // mpv `cache-secs`, default 30 here
```

Finite and `>= 0` (mpv's own range); anything else throws `invalid-state`.
`mpvOptions['cache-secs']` still wins over it. See the note below for why the
library default is 30 s rather than mpv's.

### Metadata

```ts
player.getMetadata(); // { title: '…', artist: '…', 'icy-title': '…' }
player.getMetadataValue('icy-title'); // one tag, one read; case-insensitive

player.on('metadataChanged', metadata => updateNowPlaying(metadata));
```

`getMetadata()` walks mpv's documented scalar sub-properties —
`metadata/list/count`, then `metadata/list/N/key` and `metadata/list/N/value` —
so **no string parsing is involved**. The `metadata` map property is never read
for its content: mpv's manual says "Trying to retrieve this property as a raw
string doesn't work", and a typed API should not rest on behaviour its own
documentation disclaims. The cost is `2N + 1` synchronous reads, which is why
this is a pull rather than a field of `PlayerState`; `getMetadataValue(key)` is a
single read.

`metadataChanged` fires at most once per native event batch, and only while at
least one listener is registered — a player nobody is asking pays nothing. It is
driven by mpv's `metadata` and `media-title` observations, which mpv invalidates
together on `MP_EVENT_METADATA_UPDATE`; ICY now-playing updates on a radio stream
arrive through exactly this path (and also as `state.title`).

### Notes

- **Position is projected, never streamed.** `time-pos` is not observed. The
  player anchors on discontinuities (seek, playback restart, pause/unpause,
  rate change, track change) and extrapolates in JS; `useProgress` re-renders on
  an interval that stops whenever playback is not advancing.
- **Volume is `0..1`.** mpv's own `volume` is a percentage where `100` means no
  attenuation, and its curve is `gain = (volume / 100) ** 3`. Use
  `setPropertyNumber('volume', …)` if you need mpv's amplification range.
- **Errors are typed.** Every failure is a `PlayerError`
  (`network` | `unsupported-format` | `load-failed` | `disposed` |
  `invalid-state` | `unsupported` | `mpv`); a natural end of stream is a
  `trackEnded` event and never an error.
- **Escape hatch.** `player.command()`, `player.getProperty*` /
  `setProperty*` / `observeProperty` reach anything mpv can do, and
  `createMpvClient()` exposes the raw binding directly.
- **Init option order is not preserved** — `profile` and `include` are not
  supported in `mpvOptions`; set them after creation.
- **Jumping plays.** `playlist.jumpTo(i)` clears `pause` by default, like
  `load()`'s `autoPlay`. mpv's `playlist-play-index` restarts the entry but
  leaves the global `pause` property alone, so without this a player loaded
  with `autoPlay: false` would open the entry, fill its cache and stay silent.
  Pass `{ autoPlay: false }` to keep the current pause state.
- **The demuxer cache is bounded to 30 s** (`cache-secs`). mpv's default is
  1000 hours, capped only by the 150 MiB `demuxer-max-bytes` — which on a radio
  stream means downloading for hours, even while paused. Startup is unaffected
  (`cache-pause-initial` is `no`, so playback never waits on the cache).
  Override with the typed `cacheSecs` option, or raw with
  `mpvOptions: { 'cache-secs': '…' }`.
- **Raw `mpvOptions` always win.** Precedence at init, weakest first: this
  library's defaults (`user-agent`, `cache-secs`), then the typed options
  (`userAgent`, `cacheSecs`, `prefetchPlaylist`, `replayGain`), then whatever
  you put in `mpvOptions`.

## Credits

Bootstrapped with [create-nitro-module](https://github.com/patrickkabwe/create-nitro-module).

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
