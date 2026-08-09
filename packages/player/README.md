# @rn-media/player

React Native audio player built on libmpv, powered by Nitro Modules.

[![Version](https://img.shields.io/npm/v/@rn-media/player.svg)](https://www.npmjs.com/package/@rn-media/player)
[![Downloads](https://img.shields.io/npm/dm/@rn-media/player.svg)](https://www.npmjs.com/package/@rn-media/player)
[![License](https://img.shields.io/npm/l/@rn-media/player.svg)](https://github.com/afkcodes/rn-media/blob/main/LICENSE)

## Requirements

- React Native v0.76.0 or higher
- Node 18.0.0 or higher

> [!IMPORTANT]  
> To Support `Nitro Views` you need to install React Native version v0.78.0 or higher.

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
