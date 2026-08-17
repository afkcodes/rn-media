# @rn-media/player

React Native audio player built on libmpv, powered by Nitro Modules.

[![Version](https://img.shields.io/npm/v/@rn-media/player.svg)](https://www.npmjs.com/package/@rn-media/player)
[![Downloads](https://img.shields.io/npm/dm/@rn-media/player.svg)](https://www.npmjs.com/package/@rn-media/player)
[![License](https://img.shields.io/npm/l/@rn-media/player.svg)](https://github.com/afkcodes/rn-media/blob/main/LICENSE)

## Requirements

- React Native **v0.82.0 or higher** (New Architecture only)
- Node 18.0.0 or higher

> **iOS: this player does not configure `AVAudioSession`, on purpose.** The
> session is a process-wide singleton, and it belongs to
> [`@rn-media/audio-session`](../audio-session/README.md) — the same split as
> Android, where this player requests no audio focus and that package requests
> all of it. The engine is told to keep its hands off
> (`audiounit-skip-session-management`), because stock mpv reconfigures the
> session on *every* playback start and would otherwise always win: it resets
> the route-sharing policy and forces `.moviePlayback`, after which CoreAudio
> refuses the output client and iOS shows **no Lock Screen or Control Center
> card at all** (ARCHITECTURE §26).
>
> The practical consequence: an app that uses this package **without**
> `@rn-media/audio-session` (or its own session code) gets the process default
> category rather than `.playback`, which on iOS is the difference between
> playing in the background and not. Configure a session, or pass
> `audiounit-skip-session-management=no` in `Player.create`'s options to hand
> the job back to the engine — caller options are applied after these defaults.

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

await player.playlist.add(uri); // append
await player.playlist.add(uri, { position: 'next' }); // after the current entry
await player.playlist.add(uri, { position: 2 }); // exact index
await player.playlist.add(uri, { play: true }); // …and start if nothing is playing
await player.playlist.remove(3);
await player.playlist.move(0, 4); // ordinary array semantics
await player.playlist.jumpTo(2); // plays it; pass { autoPlay: false } to stay paused
await player.playlist.next();
await player.playlist.previous();
await player.playlist.clear(); // keeps the entry that is playing
await player.playlist.shuffle(); // mpv `playlist-shuffle`, RETURNS the new order
await player.playlist.unshuffle(); // undoes the last shuffle — once

player.playlist.entries(); // [{ uri, entryId, current }, …] — the contents
player.on('queueChanged', ({ count, reason }) => refreshQueueUi());
```

**Reading the queue back.** `PlayerState.playlist` is a *cursor* (index and
count); `playlist.entries()` is the contents. It is **one** synchronous native
call — a single `mpv_get_property("playlist", MPV_FORMAT_NODE)`, constant
whatever the queue length — and it is a pull, not a subscription, on purpose.
Observing the playlist would put a variable-size array on the bridge every time
the queue is touched and make `PlayerState` a second copy of state mpv already
owns; that is the same trade this library refuses for position (anchored and
projected, never streamed) and for metadata (pulled, never pushed). One node read
is also the only *coherent* answer: a walk of `playlist/N/filename` can
interleave with a `playlist-move` and hand you two halves of two different
orders.

Call it when something says the queue moved — not on a timer, and not per render.

**`queueChanged` tells you when, and is honest about what it knows.**

| `reason` | fires when | how it is known |
| --- | --- | --- |
| `'resized'` | add / remove / clear / a fresh `loadPlaylist` | `playlist-count` is observed, so this rides the ordinary event batch |
| `'reordered'` | `move` / `shuffle` / `unshuffle` | emitted by those methods — a reorder changes **no** observable mpv property, so nothing else could report it |

The gap that leaves, stated rather than papered over: a reorder issued through
the raw `player.command()` escape hatch is invisible to this event. That is the
price of not streaming the queue across the bridge.

**Key on `entryId`, not on the array index.** An insert renumbers everything
after it, so any app-side `index → metadata` map is silently one row off from
the next `playlist.add(uri, { position: 'next' })` onwards — the queue is
correct, the labels are wrong, and it shows up later as the wrong artwork on the
wrong song. mpv's `entryId` is "unique for the entire life time of the current
mpv core instance" and survives inserts, removes, moves and shuffles:

```ts
const byUri = new Map(myTracks.map(t => [t.uri, t]));
const rows = player.playlist.entries().map(e => ({ ...e, track: byUri.get(e.uri) }));
```

**Insertion is one command, and it is validated.** `position` compiles straight
onto mpv 0.38+'s `loadfile` insert actions — `insert-next` / `insert-next-play`
for `'next'`, `insert-at` / `insert-at-play` plus the index argument for a
number — so the queue is never briefly wrong the way an `append` + `playlist-move`
pair would leave it. A numeric `position` outside `0 … playlist.count` **throws**
rather than being clamped: mpv's own behaviour there is to silently append, which
turns an off-by-one into a track at the wrong end of the queue.

`play: true` is mpv's `*-play` variant, and it means exactly what mpv means: start
playback *if nothing is currently playing*. It is not "play this now" — for that,
add the entry and `jumpTo` it.

**Caveat with `prefetchPlaylist`.** An entry inserted while mpv is already
prefetching the *old* next entry is not prefetched itself (`prefetch_next()`
returns early while an opener is active), and at the boundary mpv drops the
now-wrong prefetch and opens cold. The insert is correct; it costs the prefetch
that was in flight. Insert well before the current track ends and nothing is lost.

**Shuffle.** `playlist.shuffle()` is mpv's `playlist-shuffle`, which permutes
*every* entry, including the one playing. The track keeps playing (mpv tracks the
entry, not the index), but its `playlist-pos` moves — so you get a `trackChanged`
event for a track that did not change. Read `state.playlist.index` and carry on.

`shuffle()` and `unshuffle()` **return the resulting order** (the same value
`entries()` would give). mpv reports nothing about the permutation it performed,
so before this an app's only options were to re-read the playlist itself or to
guess; the read happens once, after the command, where it cannot be missed.

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

// A slider does NOT rewrite the chain: it commands the running filter.
const chain = equalizerPresetChain(curve, { editable: true }) // labelled bands
player.setAudioFilters(chain)
await player.setAudioFilterParam(chain[6], 'g', -3) // mpv's `af-command`
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

**Changing a value without rebuilding the chain.** `setAudioFilters` writes the
whole `af` property, and mpv answers that by destroying and recreating every
entry whose arguments changed — fine for a settings change, ruinous sixty times
a second, which is what a slider is. `setAudioFilterParam(filter, param, value)`
sends mpv's `af-command` instead: the biquad's coefficients are recomputed with
its state left alone, so a gain sweeps rather than clicks, and nothing in the
chain is torn down. It needs an entry with a **label**, which is what
`equalizerPresetChain(curve, { editable: true })` produces (and that chain also
emits all ten bands, so its *shape* never depends on the gains). The options
that can be changed this way are listed, with their FFmpeg citations, in
`AUDIO_FILTER_RUNTIME_PARAMS`; `diffAudioFilterParams(from, to)` answers "is
this a new graph, or the same graph with different numbers?" and returns the
commands when it is the latter. `useEqualizer` is built on exactly this.

Two consequences worth knowing: mpv's `af` property is deliberately *not*
rewritten, so `getAudioFilters()` keeps showing the value the entry was created
with until you write the chain again — and anything that rebuilds the chain from
that property (a new file, an audio-device switch) puts the old value back. Write
the chain once the gesture is over. The library's own bookkeeping is kept in
step, so `setLoudnessNormalization` never reverts a commanded value.

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

### `useEqualizer()` — the whole EQ screen, on one hook

The pieces above are the primitives. This is them assembled: the curve, the
preset bank, the persistence, and the one `af` write that puts it on the
signal.

```tsx
import { useEqualizer } from '@rn-media/player'

function EqualizerScreen({ player }: { player: Player | undefined }) {
  const eq = useEqualizer(player)

  return (
    <>
      {eq.presets.map(preset => (
        <Chip
          key={preset.id}
          label={preset.name}
          active={preset.id === eq.preset?.id}
          onPress={() => eq.applyPreset(preset)}
        />
      ))}
      {eq.bands.map((band, index) => (
        <Slider
          key={band.frequency}
          value={band.gainDb}
          minimumValue={eq.gainRangeDb.min}
          maximumValue={eq.gainRangeDb.max}
          onValueChange={db => eq.setBandGain(index, db)}
        />
      ))}
      <Chip label="Reset" onPress={() => eq.reset()} />
    </>
  )
}
```

The returned object is `{ enabled, bands, gainsDb, gainRangeDb, preset,
presets, savedPresets, error, hydrated }` plus `setEnabled`, `setBandGain`,
`setBandGains`, `applyPreset`, `reset`, `savePreset`, `deletePreset`.

- **`preset` is derived, not remembered.** It is whichever preset the current
  gains *are*, so dragging away from `Rock` and back onto it re-selects `Rock`,
  and no sequence of edits can leave a chip highlighted on a curve that is not
  playing. `undefined` is what a UI draws as "Custom".
- **There is no `onBandChange`/`onPresetChange` event, on purpose.** The
  returned object *is* the notification — every mutator re-renders, and the
  value is a fresh immutable snapshot. An event carrying the same fact would be
  a second source of truth to fall out of sync with.
- **Built to be dragged.** Nothing is written unless the compiled chain would
  actually differ, and *how* it is written depends on what changed. A gain-only
  change — the slider case — is pushed into the running filters with
  `af-command`: no chain rebuild, no blocked JS thread, no click, whatever the
  frame rate of the gesture. A change to the graph (EQ toggled, `extraFilters`
  or `chain` options changed, the curve leaving or returning to flat) is one
  `setAudioFilters`. Then, 250 ms after the last in-place change, one more
  `setAudioFilters` makes mpv's `af` property agree with the running chain
  again, so the curve survives the next track or device switch; until it lands,
  `player.getAudioFilters()` still shows the pre-drag string. That commit is the
  hook's only timer, and it is flushed on unmount. An engine that refuses the
  commands degrades to commit-only — the curve then lands when the gesture
  settles rather than following the finger, which is honest; going back to
  rewriting the chain per frame is what wrecks playback, and it never does that.
- **It owns `setAudioFilters` while mounted.** That method replaces the whole
  user chain, so the rest of *your* chain goes in `extraFilters` and is appended
  after the EQ bands:

  ```ts
  useEqualizer(player, {
    extraFilters: [AudioFilters.crossfeed({ strength: 0.3 })],
    chain: { limiter: false }, // EqualizerPresetChainOptions
  })
  ```

  `setLoudnessNormalization` needs no such care either way — it is a separately
  managed, labelled entry that composes with whatever the user half holds.
- **Unmounting does not clear the chain.** `af` survives track changes by
  design, and an EQ screen closing is not a reason to stop equalising. Call
  `setEnabled(false)` to take it off.
- **Gains are clamped, lengths and non-finite values throw.** A slider at its
  stop is not a bug; ten gains that are not ten gains is.

#### Saved curves, and where they are kept

`savePreset(name)` turns the current curve into a preset that joins
`presets`; saving twice under the same name replaces it, which is what "Save
as…" means everywhere else. `deletePreset(id)` removes one (built-in ids
throw; an unknown id is an idempotent no-op).

Persistence is **injected, and there is no storage dependency in this
package** — the same structural two-method interface
`@rn-media/media-session` takes, so one engine can serve both:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage'

const eq = useEqualizer(player, {
  storage: AsyncStorage, // or any { getItem, setItem }
  onStorageError: cause => console.warn(cause),
})
```

Omit `storage` and the preset bank is in-memory for the session. With it, the
saved curves *and* the live setting (`enabled` + `gainsDb`) are written on
every effective change and read back on mount. A **synchronous** engine (MMKV)
is read through synchronously, so the first `af` write is already the restored
curve; an **asynchronous** one leaves `eq.hydrated` `false` until the record
arrives and **nothing is written to mpv** in the meantime — either way the
saved curve is applied once, never flat first and the real curve a tick later.
The built-in presets are never persisted, so a release that retunes `Rock`
takes effect instead of being pinned by an old record.

The record is versioned and its reader is exported for anyone who wants to
inspect or migrate it: `serializeEqualizerSettings`, `parseEqualizerSettings`
(a typed `EqualizerRestoreResult` — `restored` | `empty` | `unsupportedVersion`
| `corrupt`, never a throw), `EQUALIZER_SCHEMA_VERSION`,
`DEFAULT_EQUALIZER_STORAGE_KEY`. A corrupt or unreadable record means "start
from the defaults"; a *storage* failure is a broken dependency and reaches
`onStorageError`.

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

**The hook pauses itself when nothing can be seen**, and takes the subscription
back when something can (`pauseWhenInactive`, default `true`). This is not a
battery nicety, it is a correctness fix: the frames are **native** callbacks, so
— unlike a JS timer, which the platform freezes for you — they keep arriving at
full rate behind a locked screen. An ungated visualizer would sit there calling
`setState` 60 times a second at a display that cannot present anything, and the
app would have all of that to work through at the moment the user unlocks.
Because the tap is derived from the listener set, pausing the hook really does
stop everything: mpv's ring, the sampler thread and the FFT tables are all
released for the duration.

"Can be seen" is **two** signals ANDed together, because on Android one is not
enough: `AppState` (is the app foreground) *and* the device's display state
(`PowerManager.isInteractive()` + `ACTION_SCREEN_ON`/`OFF`, via this package's
own `RnMediaScreenState` native object). A screen-off soak on a Poco F4 (MIUI)
caught `AppState` reporting the app active again **with the display still off**,
and the visualizer ran at 65-80 % of a core in that window. Either signal saying
"inactive" pauses; both must say "active" to resume. On iOS the display signal is
a constant `true`, and correctly so — locking an iPhone resigns the app's active
state and backgrounds it, and no iOS app is foreground-active with the display
off, so there `AppState` already *is* the display truth.
Presenting somewhere other than the phone's screen (an external display, a head
unit)? Replace the signal with `setScreenStateSource(yourSource)` rather than
turning the gate off.

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
*instead of* the tag logic, not on top of it. The same branch runs when `mode`
is `'no'`: mpv's manual calls `replaygain-fallback` "always applied if the
replaygain logic is somehow inactive", so `setReplayGain({ mode: 'no' })` does
**not** silence a non-zero fallback written earlier — pass
`{ mode: 'no', fallback: 0 }` to return to unity gain.

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
buffered. On, mpv opens the next entry as soon as the current one is fully read
into cache, which for a normal audio file is seconds after it *starts* (in the
measured runs the next entry had been open for ~18 s by the boundary, and that
was a short track — there is no fixed lead time; the trigger is demuxer EOF, not
proximity to the end). If you play network queues and do not rewrite the queue
mid-track, turn it on.

### Dynamic source resolution (signed URLs, transcode sessions)

Queues whose entries cannot be written down ahead of time — a signed CDN link
that expires in minutes, a transcode session that has to be created per track —
do not have to be resolved when the queue is built. Give the player a resolver
and it asks, per entry, moments before mpv opens it:

```ts
const player = await Player.create({
  prefetchPlaylist: true,
  sourceResolver: async ({ uri }) => {
    if (!uri.startsWith('library://')) return uri; // nothing to do
    const { url } = await api.signPlaybackUrl(uri.slice('library://'.length));
    return url;
  },
});

await player.loadPlaylist(['library://a', 'library://b', 'library://c']);
```

Install or replace it later with `player.setSourceResolver(fn)`, and remove it
with `player.setSourceResolver(null)`.

**Nothing about the URL changes until you install one.** The two mpv load hooks
are registered when the core starts, always, but the handler is disarmed until a
resolver arrives: it reads nothing, rewrites nothing, and continues the hook
immediately, so what mpv opens is byte-for-byte the URI you queued. Registering
up front rather than on demand is deliberate — the fork's "identical to stock
mpv" guarantee holds only while the hook name has *no* client, so a late
registration would not preserve stock behaviour, it would just move the moment
behaviour changes into the middle of a session. The cost is one immediate
`mpv_hook_continue` per load boundary, and it is what makes `prefetchStarted`
(below) available to players that never resolve anything.

**Resolution happens ahead of time.** The current and next entries are resolved
as soon as the queue moves — read from mpv's own playlist, so it follows
`playlist.next()`, repeat and shuffle rather than guessing — and the answers are
pushed into a native cache. When mpv reaches an entry that is already resolved,
the whole thing costs a map lookup and one property write, with no JavaScript
anywhere near mpv's core. If it reaches one that is not, mpv is held for up to
`resolverTimeoutMs` (default 10 s) while the resolver answers; on timeout the
original URI is used and mpv fails the load on its own terms, which arrives as an
ordinary typed `error` event.

**Your resolver must be deterministic while an entry is queued.** mpv opens each
entry twice — once speculatively on the prefetch path, once for real — and reuses
the prefetched stream only if the two URLs are byte-identical
(`open_demux_reentrant`, mpv 0.41.0 `player/loadfile.c:1223`). A resolver that
mints a fresh nonce per call therefore *defeats* prefetching: mpv drops the
prefetched stream, joins the opener thread on its core thread at the boundary,
and opens cold. The library removes most of that hazard for you by caching the
first answer per URI and replaying it, so in practice: mint once per track, not
once per call, and size `resolverTtlMs` (default 10 min) so it covers a track but
stays inside your signature's lifetime.

| option | default | meaning |
|---|---|---|
| `sourceResolver` | none | the resolver; also settable via `setSourceResolver` |
| `resolverTimeoutMs` | `10_000` | how long a *play-time* miss may hold mpv. `0` = never hold |
| `resolverTtlMs` | `600_000` | how long one resolution is replayed before being recomputed |

A resolver that throws (or rejects, or returns a non-string) emits a typed
`load-failed` error on `player.on('error', …)`, caches nothing, and is retried on
the next queue movement.

> Requires a libmpv built from the rn-media forks for the *prefetch* half: our
> patch fires an `on_prefetch_load` hook that upstream mpv deliberately does not
> ("This does not work with URLs resolved by the youtube-dl wrapper, and it
> won't" — mpv's own manual, on `--prefetch-playlist`). On a stock libmpv the
> play-time half still works; prefetched entries simply open unresolved.

### Knowing when a prefetch starts

```ts
const player = await Player.create({ prefetchPlaylist: true });

player.on('prefetchStarted', ({ uri, entryId }) =>
  console.log('opening ahead:', uri, entryId),
);
```

Fires once per prefetched entry, at the instant mpv releases its opener thread on
it — which is seconds *into* the current track (mpv arms the prefetch on the first
cache poll after the current file is fully read), not near the boundary. It needs
no resolver.

Two conditions, both of them honest: `prefetchPlaylist` has to be on (it is off by
default), and the linked libmpv has to carry the `on_prefetch_load` hook — Android
`v1.1.9-rnmedia.5`+ / iOS `v0.7.2-rnmedia.4`+. On any other build mpv accepts the
hook registration and never raises it ("if the name is unknown, the hook event
will simply be never raised" — `mpv/client.h`), so the event simply never occurs.
There is no error and no capability flag: an event that does not happen is not a
failure. `entryId` is mpv's playlist *entry id* — stable across `playlist-move`
and `playlist-remove`, unlike an index — and is absent on binaries that predate
the `prefetch-playlist-entry-id` property.

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

`getMetadata()` is **one** read: mpv's `metadata` fetched as an
`MPV_FORMAT_NODE` map and converted natively, so **no string parsing is
involved** anywhere (the manual's "Trying to retrieve this property as a raw
string doesn't work" is about the *string* format; the node read is the
documented way, and it is atomic — the map cannot mix two tag generations). It
walked `metadata/list/count` + `metadata/list/N/key` + `metadata/list/N/value`
until 2026-08-12, which cost `2N + 1` blocking round-trips into mpv's core — 41
of them for a 20-tag FLAC, issued at a track boundary. It is still a pull rather
than a field of `PlayerState`, but a cheap one; `getMetadataValue(key)` remains a
single read of one tag.

`metadataChanged` fires at most once per native event batch, and only while at
least one listener is registered — a player nobody is asking pays nothing. It is
driven by mpv's `metadata` and `media-title` observations, which mpv invalidates
together on `MP_EVENT_METADATA_UPDATE`.

#### Two routes to a title, and which one you want

ICY now-playing (and every other tag) is reachable two ways. They are not
redundant — each one exists because the other cannot do its job.

| | `state.title` | `metadataChanged` + `getMetadataValue()` |
| --- | --- | --- |
| shape | one coalesced string | the whole tag map, or one key |
| delivery | in **every snapshot** — rides the state fan-out, and therefore every broadcast channel and the media session | an **event**, and only while something is listening |
| cost | none beyond the snapshot | one node read per batch that touched the tags |
| on a radio stream | the currently-playing **song**, updating on its own | the **station**: `icy-name`, `icy-genre`, `icy-br`, … |

**Use `state.title` for the now-playing line.** mpv folds `icy-title` into
`media-title` and invalidates both on the same event, so it *is* the song, and
it changes every few minutes on a live stream with no track change. It has to be
a state field: a media session re-broadcasts state, not events, so a title
delivered only as an event would never reach the notification.

**Use `metadataChanged` + `getMetadataValue()` for specific keys.** The map
cannot be a state field — building it is a synchronous read into mpv's core and
most apps never look at it — so it is opt-in, and pays nothing when nobody
subscribes.

```ts
// The song, for free, everywhere:
const song = player.state.title;
// The station, only if you asked for it:
player.on('metadataChanged', tags => setStation(tags['icy-name']));
```

### Recovering from network failures

Two layers, and they answer different questions.

**1. FFmpeg reconnection (`networkReconnect`, on by default).** Native, inside
libavformat's read loop, with no JavaScript and no timers — which is the only
kind of retry that works with the screen off, because
[JS timers freeze in the background](../../ARCHITECTURE.md). It is wired through
mpv's `stream-lavf-o` and sets exactly four AVOptions:

```text
reconnect=1                   premature end of a sized response
reconnect_on_network_error=1  DNS / refused TCP / TLS failure at connect
reconnect_streamed=1          allows mid-read retry on a non-seekable stream
reconnect_delay_max=5         give up once the next backoff step exceeds this
```

FFmpeg's backoff is `delay = 1 + 2 * delay` from `0`, so `5` means attempts at
0 s, 1 s and 3 s — about four seconds of trying. FFmpeg's own defaults are
off / `120 s`, which is why this is opt-*out*:
`networkReconnect: { enabled: false }`, or `{ maxDelaySeconds: 20 }` to widen it.

**`reconnect_at_eof` is deliberately not set**, and that is worth knowing if
your queue is only live streams. It is the option that makes a live stream
reconnect when the server simply closes the connection — but FFmpeg does not
guard it on "is this stream seekable" (`http.c`), so on an ordinary sized file
the natural end of the response *is* `AVERROR_EOF` and enabling it turns every
clean track end into a `maxDelaySeconds`-long retry storm that finishes with
`EIO`. That would convert "the song finished" into "the song failed" — the exact
distinction this library is built on. A live-only app can opt in through the raw
escape hatch, which replaces the whole list:

```ts
mpvOptions: {
  'stream-lavf-o':
    'reconnect=1,reconnect_on_network_error=1,reconnect_streamed=1,' +
    'reconnect_delay_max=5,reconnect_at_eof=1',
}
```

HTTP status codes (`404`, `503`) are not retried either; that is
`reconnect_on_http_error`, a policy decision an app should make for itself.

**2. Player-level re-attempt (`retry`, 2 attempts by default).** This is the
layer FFmpeg cannot be: it answers *"should the queue move on?"*. mpv's own
behaviour on a hard failure is to advance to the next entry, which is right for
a file that will never play and wrong for a stream that was unlucky.

```ts
const player = await Player.create({ retry: { maxAttempts: 2 } }); // 0 disables

player.on('retrying', ({ index, attempt, maxAttempts }) =>
  showBanner(`Reconnecting… ${attempt}/${maxAttempts}`)
);
player.on('error', (error, { attempts }) =>
  showBanner(`Gave up after ${attempts} attempts: ${error.message}`)
);
```

When an entry fails with a `retryable` error, the player jumps **back** to it,
preserving whether it was playing, and emits `retrying`. **No `error` event is
emitted for that attempt** — nothing has finally failed yet. When the budget is
spent, the advance mpv already performed stands and `error` fires with the
count. So `error` counts *give-ups*, not failures.

**There is no delay between attempts, on purpose.** The only way to wait in
JavaScript is a timer, and JS timers freeze with the screen off — a backoff
written here would silently become "retry when the user next unlocks the phone",
a bug invisible to every test that runs with the display on. Spaced, backed-off
retrying is layer 1's job. The consequence: a re-attempt is issued a moment
*after* mpv has already started the next entry, so a failure at a queue boundary
can produce a brief blip of the following track.

Attempts are tracked per **entry generation** and reset when the entry plays,
when a different entry fails, or when the app moves the cursor or edits the
queue (`jumpTo`, `next`, `previous`, `load`, `loadPlaylist`, `add`, `remove`,
`move`, `clear`, `shuffle`, `unshuffle`). A user who skips during a retry has
said what they want, and the player stops arguing.

**Live streams: the clean close (`retryLiveEof`, off by default).** A radio
server that hangs up *politely* is not a failure at any layer — FFmpeg does not
reconnect on it (`reconnect_at_eof` is unsafe as a default, see above) and mpv
reports a clean `eof`, so the queue moves on. Opt in and an `eof` on an entry
that was **live** (`state.isLive`, i.e. mpv's `seekable = no`) is re-attempted
under the same bounded budget:

```ts
const player = await Player.create({
  retry: { maxAttempts: 2, retryLiveEof: true }, // radio app
});
```

A finite track is never affected, whatever this is set to. The re-attempt emits
`retrying` with a synthesised `network` error and no `trackEnded`; once the
budget is spent the end is reported as the `trackEnded` it always was — never as
an `error`. The budget refills only after `LIVE_EOF_BUDGET_RESET_SECONDS` (30 s)
of playback, so a server that hangs up after one second cannot loop forever. The
trade, stated plainly: a broadcast that has genuinely ended is re-attempted
`maxAttempts` times before the queue moves on.

### Errors: `retryable`, and dismissing one

Every `PlayerError` carries `retryable: boolean` — "could repeating the
identical operation plausibly succeed with nothing else changed?". Read that
field instead of maintaining a table of codes, which is how such tables go
stale. It is also what `retry` consumes.

| code | `retryable` |
| --- | --- |
| `network` | `true` |
| `mpv` with `errno: -14` (`AO_INIT_FAILED`) | `true` — the audio device is shared, and another app or a route change can lose you one open and not the next |
| everything else | `false` |

`load-failed` is `false`, and that is a fact about the classifier rather than a
policy: failures are split on whether the URI is a network scheme, so every
network source became `network` and what is left in `load-failed` is a local
path (or an unknown one). Neither improves by being asked twice.

`state.error` clears itself three ways — a new entry starting, playback
restarting, or a deliberate stop. It survives in exactly one case: the last
entry failed and nothing has happened since. `player.clearError()` is the button
for that (a user dismissing a banner). It clears **state only** — it never
suppresses, replays or undoes an event.

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
  `invalid-state` | `unsupported` | `mpv`), each carrying `retryable`; a natural
  end of stream is a `trackEnded` event and never an error.
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
- **Prefetching is runtime-settable.** `player.setPrefetchPlaylist(enabled)` is
  the twin of the `prefetchPlaylist` create option, with every one of its
  caveats plus one: flipping it takes effect from the *next* prefetch decision,
  so turning it off does not abort an opener that is already running.
- **Raw `mpvOptions` always win.** Precedence at init, weakest first: this
  library's defaults (`user-agent`, `cache-secs`, `stream-lavf-o`), then the
  typed options (`userAgent`, `cacheSecs`, `prefetchPlaylist`, `replayGain`,
  `networkReconnect`), then whatever you put in `mpvOptions`.

## Platform parity

Every public member of this package behaves identically on Android and iOS
except the three rows below. There is no member that exists on one platform and
quietly does nothing on the other — where a platform genuinely cannot, it is
named here and in the TSDoc.

**Why the surface is symmetric by construction.** Playback, the queue, filters,
EQ, ReplayGain, prefetch, the source resolver, the visualizer and the whole
error taxonomy live in one shared C++ core over libmpv's client API. There is
no `#if defined(__APPLE__)`, no `#ifdef __ANDROID__` and no `Platform.OS` in the
playback path, and the core sets no `ao=` at all — each platform's libmpv has
exactly one audio output compiled in (`audiotrack` on Android, `audiounit` on
iOS), so mpv picks the only one there is. The two binary forks are configured
against each other on every release: **103 mpv options each, 101 identical, and
the only two that differ are those audio outputs**; the 17 audio filters the EQ
and loudness APIs compile to, the PCM-tap patch the visualizer needs and the
prefetch-hook patch `prefetchStarted` needs are the same patch files in both
(see `android/libmpv.gradle` and `ios/libmpv.pin`, which carry the pinned tags
and SHA-256s, and ARCHITECTURE §11).

| Member | Android | iOS | Verdict |
|---|---|---|---|
| `getScreenStateSource().interactive` and its subscription | `PowerManager.isInteractive()` + `ACTION_SCREEN_ON`/`OFF` | constant `true`, subscription never fires | **ceiling** |
| Background playback setup | nothing to add | `UIBackgroundModes: audio` in your `Info.plist` | **setup differs** |
| `content://` sources | not playable | n/a (iOS has no equivalent scheme) | **gap** |

- **The display-state signal has no iOS half, and answering `true` is the
  honest implementation.** It exists because on Android `AppState` and "is the
  display on" are different facts — a measured MIUI soak flapped `AppState` back
  to `active` with the screen off and burned 65-80 % of a core drawing a
  spectrum nobody could see. On iOS the two are the same fact by construction:
  locking the device resigns active state and moves the app to the background,
  which `AppState` already reports, and there is no public API for the display's
  power state (`UIScreen` exposes `brightness`, not on/off). So
  `useVisualizer` ANDs `AppState` with this signal on both platforms, and on iOS
  the second input is a constant that changes nothing. Nothing else in the
  package reads it. See `src/specs/screen-state.nitro.ts`.
- **Background audio is an iOS-only setup step.** Neither package touches your
  `Info.plist`; add the `audio` background mode yourself, or install
  `@rn-media/media-session`, whose Expo plugin merges it. On Android this
  package's `AndroidManifest.xml` is deliberately empty: it merges **no**
  permissions into your app — in particular no `RECORD_AUDIO`, because the
  visualizer taps mpv rather than `android.media.audiofx.Visualizer`. The one
  permission network playback needs, `android.permission.INTERNET`, is yours to
  declare; the React Native app template already does, so this only bites a
  manifest someone has trimmed.
- **`content://` URIs are not playable.** Android's storage picker hands back a
  `content://` URI, and neither libmpv nor FFmpeg has a handler for that scheme,
  so `load()` fails with a typed `load-failed` — an honest failure, not a silent
  one, but a real gap against iOS, where a document picker hands back a file URL
  that plays. Copy the file, or resolve it to a path, until this is closed.
  Everything else — `https://`, `file://` and absolute paths — behaves the same
  on both platforms.
- **Verification is not symmetric either.** The Android engine and player are
  device-verified (Poco F4, AOSP); the iOS half is verified by CI plus
  inspection of the shipped `Mpv.xcframework`, and CI builds the simulator slice
  only. See ARCHITECTURE §11.

## Credits

Bootstrapped with [create-nitro-module](https://github.com/patrickkabwe/create-nitro-module).

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
