# The engine: why we build it, what it costs

Both libmpv binaries are ours. This page is the *why* and the receipts;
[`ARCHITECTURE.md` §11](../ARCHITECTURE.md) is the decision record behind it,
and [Licensing](../README.md#licensing) covers the LGPL obligations.

## We own the engine

Both libmpv binaries are built from forks of media-kit's build scripts, and
their flags, pins and patches are **generated** from one workshop repo —
[`afkcodes/rn-media-engine`](https://github.com/afkcodes/rn-media-engine). Edits
happen there; `workshop sync --check` fails when a fork drifts, and `workshop
verify-artifacts` scores the **released** binaries of both platforms rather than
a build log — 12 slices × 10 categories = 120 cells, scored 0 FAIL on the parity
release, and its very first run is what caught the iOS simulator slice shipping
with no audio output compiled into it at all, four generations after the fact.

That machinery buys three things a wrapper around two platform players cannot.

### One configuration, not two

mpv 0.41.0, FFmpeg 8.1.2 and mbedTLS 3.6.7 on both platforms, configured
exhaustively: **103 mpv options a side, 101 identical**, the only two that
differ being the platform's own audio device (`audiotrack` / `audiounit`).

Parity is aligned *up*, never down. iOS gained the eight cover-art decoders and
the TrueHD decoder (it had the demuxer, so a `.thd` demuxed cleanly and then
failed to decode, which reads like a corrupt file rather than a missing
feature); Android gained zlib for compressed Matroska headers and, because
bionic has no `iconv(3)` before API 28 while the fork targets API 21, a
**statically vendored GNU libiconv 1.19** — so an ICY title or an old tag in
CP1251 or Shift-JIS decodes on both platforms instead of on iOS only. Switching
iconv *off* on iOS would have been the cheap parity, and it was reversed.

### Features upstream will not ship

Two source patches, byte-identical between the forks: the PCM tap behind the
[visualizer](../packages/player/README.md#visualizer-spectrum--waveform), and the
prefetch hook behind
[resolver-at-prefetch-time](../packages/player/README.md#dynamic-source-resolution-signed-urls-transcode-sessions).
Both are proven present in the *shipped* artifact by strings only the patched
code emits, and the release script refuses to package a binary that lacks one.

### Size, attacked rather than excused

The 0.41 engine bump cost +27 % on Android and was written down as a regression;
the size release then took back **−20.5 % on Android** (arm64 `libmpv.so`
9,233,464 → 7,338,952 bytes stripped, all four ABIs −19.9…−21.8 %) and
**−34.4 % off the iOS `Mpv` slice** (2,676,512 → 1,756,424 bytes), with zero
feature loss proven rather than argued: 62 assertions against the shipped jars,
a 50-assertion on-device engine harness A/B'd against the previous release, and
the same 50 on an emulated 16 KB-page system *with* a negative control — remove
the alignment flag and `dlopen` refuses the library, so the flag is observed
load-bearing rather than assumed. Stripping unwind tables (−437 KB more) was
declined on purpose: field crash diagnosis outranks bytes before 1.0.

## What it costs at runtime

Measured on a Poco F4 (Android 16), release build:

| | |
|---|---|
| Live HLS radio, screen off | **3.8 %** of one core |
| Cold start to a restored queue | **~1 s** |
| Gapless handover, identically encoded pair | **25 ms**, audio device never reopened |
| Network track boundary, prefetch on / off | **25 ms** / 644 ms plus an underrun |
| Synchronous mpv reads per event batch, worst case | **5**, flat (was 47 on a 20-tag FLAC) |
| Periodic bridge traffic while playing | none — position is projected, not streamed |

No iOS runtime numbers appear here, on purpose: nothing has run on an iOS device.

## Reaching into mpv

The C++ binding is a complete, raw mpv client and the typed `Player` is
TypeScript on top of it — so anything mpv can do, you can do, without waiting
for us. Nothing here is a private API: `Player` itself is written against these
same calls.

```ts
await player.command(['loadfile', uri, 'append-play'])
player.setPropertyString('af', 'loudnorm')             // any mpv option or filter string
player.observeProperty('demuxer-cache-time', 'number') // 'string' | 'number' | 'bool'
player.unobserveProperty('demuxer-cache-time')
player.getPropertyNumber('demuxer-cache-duration')
player.getPropertyString('audio-codec-name')
player.getRawHandle()                                  // the mpv_handle, as a bigint
```

`getRawHandle()` is reserved for the future video plugin: it hands out the
`mpv_handle` so a separate package can attach a render context without the core
ever linking `mpv/render.h`.

`createMpvClient()` hands you the binding with no `Player` wrapper at all —
`initialize()`, `command`, `getProperty*`/`setProperty*`, `observeProperty`, and
the batched event listener. Reach for it when you want mpv's semantics
unmediated; reach for `Player` when you want a state machine, position
projection and a typed error taxonomy over them.

Two things the escape hatch does **not** get you, and they are deliberate:

- **An extra observed property does not become a `Player` event.** mpv delivers
  it in the native batch, but the built-in reducer ignores names outside
  `OBSERVED_PROPERTIES` — so read the property when you need it, or take the raw
  event stream from `createMpvClient()`. (`player.state` likewise only tracks
  the observed set, which is why the typed methods are preferable to
  `setProperty*` wherever one exists.)
- **Video stays out.** The core runs `vid=no`, `force-window=no` and
  `audio-display=no`. Turning them on through the escape hatch does not produce
  video, because no render context exists — see
  [Limitations](../README.md#limitations) on cover-art extraction for what that
  costs.
