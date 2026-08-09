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
  Override with `mpvOptions: { 'cache-secs': '…' }`.

## Credits

Bootstrapped with [create-nitro-module](https://github.com/patrickkabwe/create-nitro-module).

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
