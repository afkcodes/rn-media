# rn-media Architecture

**A living record of how this library is built, what we chose, and why.**
Every entry carries its rationale — most were settled by measurement or by
reading upstream source, and the evidence is noted. When a decision changes,
this file changes in the same commit. Deeper detail lives in
[`PLAN.md`](PLAN.md) (analysis, roadmap) and [`docs/specs/`](docs/specs)
(per-package contracts with as-built addenda).

*Last updated: 2026-08-10.*

## The system in one picture

```
            your app UI ─────────────┐
                                     ▼ (renders from the same broadcasts)
┌────────────────────────────────────────────────────────────────────┐
│ @rn-media/media-session      fan-in: notification · lock screen ·  │
│                              Bluetooth · watch → ONE JS handler    │
│                              fan-out: playbackState/mediaItem/queue│
│   Android: media3 MediaLibraryService + SimpleBasePlayer facade    │
│   iOS: MPRemoteCommandCenter + MPNowPlayingInfoCenter              │
├────────────────────────────────────────────────────────────────────┤
│ @rn-media/audio-session      the single arbiter of audio focus,    │
│                              AVAudioSession, interruptions, noisy  │
├────────────────────────────────────────────────────────────────────┤
│ @rn-media/player             TS Player (state reducer, hooks)      │
│   └─ Nitro pure-C++ HybridObject ── libmpv (mpv_handle per player) │
├────────────────────────────────────────────────────────────────────┤
│ prebuilt libmpv binaries     pinned by SHA-256, built by our forks │
└────────────────────────────────────────────────────────────────────┘
```

## Core decisions

### 1. Engine: libmpv, not ExoPlayer/AVPlayer
Every format ffmpeg decodes, identical behavior on both platforms, native
gapless, and zero ExoPlayer class-conflicts with other libraries. The costs are
accepted consciously: ~3 MB/ABI binaries, no DRM ever (this library targets
non-DRM audio), and we own focus/session/notification ourselves — which is the
product anyway.

### 2. Native tech: Nitro Modules, pure-C++ HybridObject
libmpv is a C API; Nitro lets C++ bind it directly with no Kotlin/Swift relay
(~15× faster calls than TurboModules; validated by react-native-video v7's
rewrite). New Architecture only; peer floor `react-native >= 0.82` — grounded
in RN source: 0.82+ refuses to run old-arch at all.

### 3. Three independent packages (the audio_service lineage)
`player` / `audio-session` / `media-session` mirror Flutter's proven
just_audio / audio_session / audio_service split. The session layers are
**player-agnostic by structural typing** — they must work with any engine.
No cross-package dependencies; integration is explicit (`wireAudioSession`),
never ambient, fixing audio_session's configure-ordering fragility.

### 4. Video is an additive plugin, never in core
Core compiles against `mpv/client.h` only — `render.h` is banned. Audio users
pay zero video cost (binary, permissions, code). The future video package
brings its own binaries + `VideoView`, attaching through reserved hooks
(`attachVideoOutput`/`getRawHandle`) with no core changes. Settled decision
(PLAN §7.5) — do not revisit.

### 5. Thin generic native binding; all typing lives in TS
The HybridObject is a complete, raw mpv client (commands, properties,
observation). The typed Player — reducer, error taxonomy, hooks — is TypeScript
on top. Consequences: the raw escape hatch is free and total (mpv gains
features without native releases), the C++ stays small and stable, and the
whole TS layer is testable device-free by injecting a fake client (the test
suites never import react-native-nitro-modules).

### 6. Event delivery: one thread, one batch in flight, coalesced
One dedicated thread per player runs `mpv_wait_event` (mpv's contract: only
one thread may). Events buffer natively; JS receives **one batched callback at
a time** — the listener's completion promise is the back-pressure clock, so
batch size grows under load instead of queue depth. Property events coalesce
by name keeping the newest value *at the newest position* (causality against
discrete events is preserved). No timers, no polling, no per-event JSI hops.

### 7. Position is never streamed — anchors + projection
`time-pos` is never observed. State carries an anchor
`{position, timestamp, rate}` updated only on discontinuities (seek, pause,
rate change, track change); consumers project `position + elapsed × rate`
locally. On Android the anchor is converted wall→monotonic **once at broadcast
receipt** (NTP-skew clamped) and media3's position supplier projects by pure
subtraction — the lock-screen scrubber advances with zero bridge traffic in
either direction.

### 8. One JS runtime, kept alive by platform primitives — no headless fork
Proven from RN 0.86 sources: destroying the last Activity does *not* tear down
the ReactInstance; the foreground service supplies process residency and Nitro
callbacks are thread-agnostic, so JS handlers keep working with no Activity.
`HeadlessJsTaskService` was deliberately **not** forked — headless tasks don't
pin the runtime, they only keep JS *timers* warm, and this design has no JS
timers (see Platform truths). audio_service tried a second execution context
and abandoned it; we never built one.

### 9. Commands are native-first; JS is notified, never awaited
A notification pause acts on the media3 state machine immediately; the JS
handler is invoked fire-and-forget. media3 gets a `SettableFuture` completed
by the app's *next broadcast* (3 s deadline) — correct use of its placeholder
mechanism, and JS is never on the transport-control critical path (cold-start
JS is 300 ms–2 s; also an unhandled JS throw destroys the runtime, so handler
dispatch is wrapped). RNTP's commercial rewrite reached the same conclusion
independently.

### 10. media3 from day one; SimpleBasePlayer as the facade
audio_service is trapped on deprecated androidx.media because retrofitting
media3's Player-centric design is a rewrite; we started there.
`SimpleBasePlayer`'s State is built from the broadcast channels. Channel
priority is per-entry: for the **current** queue entry, `setMediaItem` merges
field-by-field over the queue entry when ids match (duration usually arrives
only via `setMediaItem` — without the merge, media3 marked queue-backed
timelines unseekable and dropped the scrubber).

### 11. Binaries: pinned, forked, LGPL, dynamically linked
Prebuilt libmpv comes from our forks of media-kit's build repos, and as of
2026-08-09 **both platforms ship rn-media builds** rather than upstream's:
`afkcodes/libmpv-android-audio-build@v1.1.9-rnmedia.1` and
`afkcodes/libmpv-darwin-build@v0.7.2-rnmedia.1`. Each is pinned by exact tag +
SHA-256 (hard build failure on mismatch) and cached for offline builds; the
repo owner is itself a pin field on both platforms, so re-pointing at upstream
is a one-line change. Forking is deliberate: upstream's audio flavor omits the
HLS/mpegts demuxers **by scoping, not oversight** (their video flavor has
them), so we own the configure flags. On both platforms the delta versus the
upstream release is exactly `--enable-demuxer=hls --enable-demuxer=mpegts` —
same source tree, same patches, identical exported symbol set. LGPL v3 (ffmpeg
`--enable-version3`, never `--enable-gpl`), dynamically linked on both
platforms (`.so` in APK, embedded dynamic xcframeworks on iOS) — the
App-Store-accepted pattern that satisfies the relink obligation. Wrapper code
is MIT.

The two forks are **not equally verified**: the Android build is confirmed
playing HLS on a device, the iOS build only compiles, links and embeds in CI.
See §"Platform truths" and the README's Limitations for the exact standing.

### 12. Defaults chosen by measurement (each overridable)
- **User-Agent `rn-media (libmpv)`** — real Shoutcast hosts return 401 for the
  exact string `libmpv` (mpv's default). Found via trace logs on-device.
- **`cache-secs=30`** — mpv's default readahead is ~1000 *hours*; a paused
  radio stream measurably downloaded at full bitrate forever. 30 s bounds data
  with zero startup cost (start is gated by the AO queue, not the cache).
- **`jumpTo` clears `pause`** — mpv's `playlist-play-index` restarts the entry
  but never touches the global pause flag; "buffering forever" was actually
  "started, paused".
- **Audio-only core defaults**: `vid=no`, `force-window=no`, `idle=yes`,
  `audio-display=no`.

### 13. Honest state for live streams
mpv reports a perpetually-growing *cache length* as the duration of unseekable
streams. `seekable === false` is the reliable live discriminator (verified in
every device sample): `isLive: true`, `duration: undefined`, position
projection unclamped. Broadcasting the raw value would have turned the media
session into a ticker.

### 14. HLS URLs get `demuxer=lavf` per-load
mpv's playlist demuxer parses `.m3u8` as a plain playlist and explodes the
queue with variant/segment entries (measured 3→23). The player forces
`demuxer=lavf` for `.m3u8`/`.m3u` sources only, caller-overridable.

### 15. Testing strategy
- TS: everything device-free via injected fakes (player 277, media-session 68,
  audio-session 41 tests). Reducers are pure; fixtures replay real event
  sequences.
- C++: pure logic (batching, lifecycle) split from mpv calls; host-compiled
  tests, ThreadSanitizer-clean.
- Kotlin: standalone Gradle harness (placeholder `:app` required — RN's
  gradle plugin only installs dependency substitution under the application
  plugin) + lint.
- Final authority: a **physical Android device** (user rule: never an
  emulator). iOS compiles on CI only; runtime iOS verification awaits a device.

## Platform truths we build around (learned, verified)

- **JS timers freeze in background** without an Activity (JavaTimerManager
  gates on lifecycle + headless tasks; Samsung freezes them even with one —
  RN #56324). Nothing timing-critical may live in JS; sleep timers must be
  native.
- **An unhandled JS exception destroys the whole runtime** (default
  ReactHostDelegate rethrows). All handler dispatch is wrapped.
- **CocoaPods `exclude_files` applies to *every* attribute including
  `vendored_frameworks`** — a `dir/**/*` guard pattern silently de-linked all
  ten libmpv frameworks. Exclusions must name compilable extensions.
- **nitrogen hardcodes Kotlin hybrid classes' JNI descriptor to
  `com.margelo.nitro.<ns>`** — a wrong package compiles, links, ships, and
  throws ClassNotFoundException at runtime.
- **media3 1.11 keeps a paused media service in the foreground for a 10-minute
  grace period** — "demote on pause" is not immediate, by design.
- **`--enable-protocol=hls` in an ffmpeg build proves nothing** — it's the
  deprecated `hls://` protocol; only the `hls`+`mpegts` *demuxers* matter.
- **mpv 0.35.1's manual documents `replaygain-clip` inverted** vs its own
  code; our API maps to behavior (verified in `player/audio.c`).
- **generator scaffolds contain load-bearing "dead code"**: the ReactPackage
  class is the only trigger of `System.loadLibrary` — deleting it fails only
  at runtime.

## Update policy

This file is owned by the architect session. Any change that alters a decision
above — a new default, a changed dependency, a reversed trade-off — updates
this file in the same commit. Implementation agents read it (it is referenced
from CLAUDE.md) and report contradictions rather than silently diverging.
