# rn-media Architecture

**A living record of how this library is built, what we chose, and why.**
Every entry carries its rationale — most were settled by measurement or by
reading upstream source, and the evidence is noted. When a decision changes,
this file changes in the same commit. Deeper detail lives in
[`PLAN.md`](PLAN.md) (analysis, roadmap) and [`docs/specs/`](docs/specs)
(per-package contracts with as-built addenda).

*Last updated: 2026-08-11.*

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
accepted consciously: ~8 MB/ABI binaries (it was ~3 MB before the mpv 0.41 /
FFmpeg 8 engine bump — see §11, where the number and the regret are recorded),
no DRM ever (this library targets
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
and abandoned it; we never built one. What that file *did* leave behind is its
cold-start shape — register a `ReactInstanceEventListener`, then `start()`, then
re-check `currentReactContext`, because the listener does not replay for an
instance that already exists — which is exactly how §20 boots a runtime from
inside the service.

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
2026-08-11 **both platforms ship the same engine, from the same sources, for the
first time**: `afkcodes/libmpv-android-audio-build@v1.1.9-rnmedia.7` and
`afkcodes/libmpv-darwin-build@v0.7.2-rnmedia.6`, both mpv **0.41.0**
(`MPV_CLIENT_API_VERSION` 2.5), FFmpeg **8.1.2**, libplacebo **6.338.2**. Each is
pinned by exact tag + SHA-256 (hard build failure on mismatch) and cached for
offline builds; the repo owner is itself a pin field on both platforms, so
re-pointing at upstream is a one-line change. Forking is deliberate: upstream's
audio flavor omits the HLS/mpegts demuxers **by scoping, not oversight** (their
video flavor has them), so we own the configure flags — hls+mpegts demuxers plus
the same 16 LGPL audio filters incl. `aresample` (§18), identical on both
platforms. LGPL v3 (ffmpeg `--enable-version3`, never `--enable-gpl`),
dynamically linked on both platforms (`.so` in APK, embedded dynamic
xcframeworks on iOS) — the App-Store-accepted pattern that satisfies the relink
obligation. Wrapper code is MIT.

That the two platforms are on one mpv is not cosmetic. The vendored
`cpp/third_party/mpv/include/mpv/client.h` used to be the *older* of two headers
(Android 0.35.1/API 2.0 vs iOS 0.36.0/API 2.1) — a lowest-common-denominator
compromise written into the podspec. It is now simply the header of the binary.

**The 0.41 bump is three changes wearing one version number**, and each one is a
trap if taken for a routine bump:

1. **waf is gone.** mpv 0.37 removed it ("waf: remove waf as a build system"),
   so both forks migrated their mpv step to meson. Every flag had to be
   re-spelled, and two of them are not one-to-one: `--enable-lgpl` becomes
   `-Dgpl=false` (opposite polarity, same licence outcome), and
   `--enable-libmpv-shared` needs BOTH `-Dlibmpv=true` and
   `--default-library shared`, because `-Dlibmpv=true` alone controls only
   install/build-by-default and will happily produce a `libmpv.a`.
2. **libplacebo is mandatory and cannot be stripped.** 0.37 replaced the
   `libplacebo` build option with a bare `dependency()`, and mpv reaches it from
   core, non-video translation units (`demux/demux_mkv.c`, `filters/f_lavfi.c`,
   `player/main.c`, `video/mp_image.c`, `video/sws_utils.c`). libass CAN be
   patched out; this cannot. Both forks build it with every GPU backend disabled
   (no Vulkan, OpenGL, D3D11, shader compilers), static, folded into libmpv, so
   the linker keeps only the colour-space objects mpv actually reaches. Version
   **6.338.2** exactly — mpv 0.41's declared minimum, and 7.x drops symbols
   0.41's `csputils.h` still references under mobile cross-files.
   The expensive part of adding it was not the build flags but its **git
   submodules**: a GitHub release tarball carries them empty, and four of the
   five are load-bearing in ways a Linux host hides, because a Linux host has
   the system copy of each installed. Two CI runs were spent finding them one at
   a time, so they are enumerated in the pin (`packages.lock.nix`) with the run
   that proved each: `fast_float` (`src/convert.cc` falls back to
   `std::from_chars` for `double`, which libc++ in Xcode 16.x does not
   implement, and the file `static_assert`s rather than link-failing),
   `jinja` + `markupsafe` (the GLSL preprocessor runs on **every** build, GPU
   backends or not), and `Vulkan-Headers` (`src/vulkan/stubs.c` is compiled
   *because* Vulkan is disabled — it keeps the public Vulkan ABI present as
   no-ops — and it includes `<vulkan/vulkan.h>`). Only `glad` is genuinely
   unused. The general lesson is the same one the `--enable-protocol=hls` trap
   teaches, one layer down: a dependency that builds on the dev box proves
   nothing about the sandbox that ships.
3. **The export list stopped being free.** mpv's waf build generated a linker
   version script from `libmpv/mpv.def`; 0.37 deleted that file and 0.41 relies
   solely on `gnu_symbol_visibility: 'hidden'` plus `MPV_EXPORT` in the public
   headers. That governs mpv's OWN objects and does nothing for anything linked
   into it. On Android, where FFmpeg/mbedTLS/libxml2/zlib are all static, the
   first 0.41 build exported **4020** symbols instead of 55 — every `av_*`, the
   lot. On darwin, where FFmpeg and mbedTLS ship as separate dylibs, nothing
   static had ever entered the link, so 0.36 shipped a clean 53 by accident;
   static libplacebo changes that (its public API is `visibility("default")`
   regardless of `PL_STATIC`). Measured rather than estimated, by building the
   same patched tree on Linux with no export control: **453 `pl_*` symbols**
   land in the library alongside the 54 `mpv_*` ones. Both forks now pin the
   list explicitly — Android with `--version-script` + `--exclude-libs=ALL`,
   darwin with ld64's `-Wl,-exported_symbols_list` **on the `library('mpv', …)`
   target only**, never on the cross file (Platform truths) — and both are
   asserted against the SHIPPED artifact. The counts differ by exactly one and the
   difference is named: **55 on Android, 54 on iOS, the extra being Android's
   own `mpv_lavc_set_java_vm`**. Against v0.7.2/rnmedia.3's 53 the only additions
   are mpv 0.41's own `mpv_del_property` and `mpv_get_time_ns`.
   This is why "the export set is byte-identical" — true across every previous
   fork generation — is now stated as "the export set is exactly this list": an
   invariant that cannot survive an engine bump that adds API has to be replaced
   by one that can.

**FFmpeg 8.1.2 is a deliberate pin, not a lag.** mpv 0.41's own floor is
`libavcodec >= 60.31.102` (FFmpeg 6.1); n9.0 was cut six months *after* mpv
0.41.0 shipped and has no point release. `scripts/check-upstream.mjs` therefore
reports both FFmpeg rows as BEHIND on purpose, and each pin file carries a
machine-read rationale field (`ffmpegPinNote`, `LIBMPV_FFMPEG_PIN_NOTE`) that the
watcher prints verbatim next to the drift, so the row is honest in both
directions.

**The forks carry source patches, not just flags, and that stays priced.**
`004.rn_media_pcm_tap.patch` adds a PCM tap to mpv's client API (§21) — four
source files, no build-system files, which is why the *same file* is
byte-identical between the two forks. A configure flag survives a rebase by
itself; a patch does not, so the procedure is written down:

1. Rebase onto the new upstream tag. Flags either survive or the build fails
   loudly; a patch may fail *quietly* by applying with fuzz. Apply with
   `--fuzz=0` and rebase for real when it rejects — at this bump, FFmpeg's
   `hls-mp4-seek` patch still applied with fuzz onto a tree that already had the
   fix, and the VideoToolbox VP9 patch applied with fuzz and then failed to
   compile (FFmpeg 8 renamed `FF_CODEC_CAP_ALLOCATE_PROGRESS`).
2. Re-check the four anchors named in the tap's header
   (`ao_post_process_data`'s body, `ao_print_devices`'s declaration,
   `struct mpv_global`, `mp_property_audio_params` + the `{"audio-out-params", …}`
   table entry). They have been stable across 0.35 → 0.41.
3. Prove the feature is in the **shipped** artifact by a string only the patched
   code emits — automated as `buildscripts/rn-media-release.sh` on Android, which
   refuses to package a `.so` that lacks any required marker.
4. Bump both pins together and read the export diff against the pinned list.

Patch dispositions at this bump, both forks: `001.audiotrack_threadsafe` and
`005.mpv_dup_node_byte_array` deleted (upstream absorbed both — 0.41 and 0.36
respectively), FFmpeg's `dash-base-url-escape` and `hls-mp4-seek` deleted
(upstream in 8.1.2), `002`/`003`/`004` and darwin's objc/audiounit patches
rebased, and darwin's two VideoToolbox patches rebased *and* gated on the video
variant this repo does not ship.

Added 2026-08-11, both forks, byte-identical:
`006.rn_media_prefetch_hook.patch` fires an `on_prefetch_load` client hook from
mpv's `prefetch-playlist` path and exposes read-only
`prefetch-playlist-entry-id` (valid only while that hook is open). Upstream
never runs hooks on prefetch and says it never will (`options.rst` on
`--prefetch-playlist`: resolved URLs "won't" work) — without the patch, a
URL-rewriting resolver makes prefetch *worse* than off, because
`open_demux_reentrant()` discards the mismatched prefetch by strcmp at the
boundary while blocking the core. Adds no exports (rides
`mpv_hook_add`/`mpv_hook_continue`); marker strings for step 3:
`[rn-media] prefetch hook resolved: `, `on_prefetch_load`,
`prefetch-playlist-entry-id` (all three in `rn-media-release.sh`'s required
list). A device-free regression harness lives in the Android fork
(`buildscripts/tests/`, 21 assertions, runs in its CI); the canonical copy and
its tree-equivalence proof live in `afkcodes/rn-media-engine`
(`patches/004-prefetch-hook`), which is the edit target — fork copies are
synced from it, never edited in place. The client registers the hook at core
start, not on demand (2026-08-12, with `prefetchStarted`): the fork guarantees
stock behaviour only while the hook *name has no client*, so late registration
only moves the behaviour change into mid-session; cost is one immediate
continue per load boundary, measured at parity (333 vs 348 ms boundary,
armed vs disarmed — noise).

**Cost, honestly.** Android `arm64-v8a` grew 6.39 → 8.19 MB stripped (+27 %).
iOS grew the same way and for the same reasons: across all ten frameworks the
device slice went 6 811 280 → 8 048 768 bytes (+18.2 %), and `Mpv.framework`
alone 1 856 352 → 2 675 912 (+44 %) because libplacebo now lives inside it. That
is a real regression against §1's "~3 MB/ABI" framing, accepted deliberately as
the price of currency, and it is the number to attack next.

**…and the number was attacked (THE SIZE RELEASE, 2026-08-12,
`v1.1.9-rnmedia.8`/`v0.7.2-rnmedia.7`).** Android `arm64-v8a`
9 233 464 → **7 338 952 B** stripped (−20.5 %; all four ABIs −19.9…−21.8 %; jar
4.47 → 3.63 MB — the 9.23 MB start point being 8.19 MB plus the parity
release's vendored libiconv, whose ~950 KB of charset tables were ruled the
feature, not the fat). iOS `Mpv.framework` device slice 2 676 512 →
**1 756 424 B** (−34.4 %). Mechanism: canonical dead-subsystem strip
(rn-media-engine `patches/011-strip-mpv-dead`, audio variant only — the GPU
render path was proven already unreachable, `HAVE_GL=0` empties its context
table), dead-flag drops, and `-ffunction-sections`/`--gc-sections` + `-Os` on
mpv's own tree (every hot DSP loop is FFmpeg, untouched — CPU measured at
parity). Zero feature loss enforced by a 62-assertion probe on the shipped
artifacts, a 50-assertion device harness A/B, and a 16 KB-page loader proof
with a negative control. Declined on purpose: unwind-table stripping (−437 KB
more; field crash diagnosis outranks bytes pre-1.0) and LTO (measured +57 KB
BIGGER). ld64 `-dead_strip` on darwin is deferred, size-only. Shipped filter
count note: the artifacts carry **17** audio filters — the 16 this fork added
plus the upstream-inherited `equalizer`; prose that says "16" is counting the
additions.

**The parity release, 2026-08-12** — Android `v1.1.9-rnmedia.7` (`4200e83`) and
iOS `v0.7.2-rnmedia.6` (`96334d4`), cut in lockstep because the iconv work spans
both forks. Same engine as rnmedia.5/.4 (mpv 0.41.0, FFmpeg 8.1.2, libplacebo
6.338.2) and no new rn-media patch; what changed is that the two builds stop
merely sharing a version number. mpv is now configured **exhaustively on both
platforms — 103 options each, 101 identical, the only two differing being
`audiotrack` vs `audiounit`** (Android used to pass 27 and leave ~95 at mpv's
`auto` default, which is the same hazard as the `avfoundation` probe, unclosed);
FFmpeg shares 123 audio flags, and every remaining difference is declared
intentional in the workshop manifest. Capability was aligned **UP, never down**:
iOS gained the 8 cover-art decoders and the TrueHD decoder (it had the demuxer,
so `.thd` demuxed and then failed to decode — a gap shaped like a corrupt file);
Android gained zlib (compressed Matroska heads) and **iconv**. iconv is the
direction statement: bionic has no `iconv(3)` until API 28 and the fork builds at
API 21 to keep Android 5–8 alive, so the cheap fix was to switch iconv off on
iOS and call that parity — the platform-capped compromise CLAUDE.md rejects. It
was reversed by **vendoring GNU libiconv 1.19 statically into `libmpv.so`**
(LGPL-2.1-or-later, no new `DT_NEEDED`, no new file to ship), so both platforms
now convert non-UTF-8 metadata, ICY stream titles, CUE sheets and playlists. The
ceiling was broken, not lowered. Also: mbedTLS **3.6.7** on both (iOS came from
3.4.1, Android from 3.6.1 — one TLS stack now); **libxml2 removed from both**,
because FFmpeg reaches it only from the DASH demuxer neither fork enables, so the
artifacts were linking an XML parser nothing could reach — both pin files record
that absence as the value `none`, which `scripts/check-upstream.mjs` prints as an
`info` row rather than drift; image *encoders* dropped (nothing encodes an
image); dead flags dropped on both, taking the FFmpeg option audit to 190/190
against 8.1.2 *and* master; iOS applies its **whole** patch series at `--fuzz=0
--no-backup-if-mismatch`, closing the fuzz trap this section has warned about
since the 0.41 bump; and every Android source fetch is now commit-asserted or
checksummed. **The iOS Simulator AO fix ships here**: the simulator slice had no
audio output compiled in at all (the meson line gated `-Daudiounit=enabled` on
`os == ios` exactly), and with it patch 007 — found by the first run of the
workshop's `verify-artifacts`, four generations after the fact. Cost: Android
`arm64-v8a` jar 3 885 723 → 4 466 123 B (+14.9 %), the other three ABIs +15.8 %
to +17.3 %, which is libiconv plus zlib stacking on rnmedia.5's +27 % and feeds
the size work in #30; iOS `Avcodec` +27.8 % for the decoders, the simulator slice
+21 632 B for the AO, the device `Mpv` slice +384 B. Flags, pins and patches are
now **canonically owned by `afkcodes/rn-media-engine`** and generated into the
forks — `workshop sync --check` fails on fork drift, `workshop verify-artifacts`
scores the RELEASED binaries (120 cells, 0 FAIL at this pair), and neither reads
a build log.

**The two forks are still not equally verified**: the Android build is confirmed
playing HLS on a device and its PCM tap is confirmed feeding a visualizer on one;
the iOS build is link-verified via CI plus shipped-artifact inspection only, and
runtime playback on an iOS device remains unverified. README → Limitations
carries the exact standing.

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
- **`gapless-audio` left at mpv's `weak`** (exposed as the typed `gaplessAudio`,
  never written unless the caller asks). `weak` keeps the audio device open while
  consecutive entries decode to the same format and reopens it when they do not;
  `yes` keeps it open unconditionally by resampling every later entry into the
  *first* entry's format, which silently degrades a mixed queue with nothing in
  the state to see it by. Verified on-device (Poco F4, Android 16, release): one
  continuous tone split into two identically-encoded AAC files produced exactly
  one `AO: [audiotrack] 44100Hz stereo 2ch float` for the session, a 26 ms
  handover, and 739 ms of device buffer still queued at the switch.
- **`prefetch-playlist` left off, and documented as required for network
  queues.** mpv's gapless is an output-buffer guarantee only. Measured across a
  CDN track boundary (two runs each): off → 644/641 ms handover against 202/204 ms
  of buffered audio and an `Audio device underrun detected` at every boundary;
  on → 25/26 ms handover, 816/826 ms of buffer, no underrun. It stays off by
  default because mpv's own manual disclaims correctness when the queue is
  edited or stepped backwards while a track is ending — that is the app's call,
  not ours to make silently.

- **HTTP reconnection on by default, `reconnect_at_eof` off.** See §22 for the
  four AVOptions and Platform truths for why the fifth is a trap.
- **The queue's *contents* are a pull, never a feed.** `PlayerState.playlist` is
  a cursor; `playlist.entries()` is one `mpv_get_property("playlist", NODE)` on
  demand. Observing the array would put a variable-size payload on the bridge on
  every edit and make the snapshot a second copy of state mpv owns — the same
  trade already refused for position (§7) and metadata. One node read is also the
  only *coherent* answer: an `N + 1` walk of `playlist/N/filename` can interleave
  with a `playlist-move` and return two halves of two different orders. The
  `queueChanged` event is derived from what is genuinely knowable — the observed
  `playlist-count` (`'resized'`) and the library's own move/shuffle/unshuffle
  calls (`'reordered'`, because a reorder changes no observable property at all)
  — and the gap that leaves (a reorder issued through the raw `command()` hatch)
  is documented rather than papered over.

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
- TS: everything device-free via injected fakes (player 277, media-session 141,
  audio-session 41 tests). Reducers are pure; fixtures replay real event
  sequences.
- C++: pure logic (batching, lifecycle) split from mpv calls; host-compiled
  tests, ThreadSanitizer-clean.
- Kotlin: a real JVM unit-test source set in media-session (`src/test`,
  consumer-invisible — proven at the resolved-classpath level), covering
  ResumptionStore's parser, the channel-priority merge, and a schema-version
  sync guard that mutation-tests the TS↔Kotlin constant pair. Runs in CI
  alongside lint for all three library modules (lint was silently absent for
  days — a green pipeline only proves what it runs). The standalone Gradle
  harness pattern (placeholder `:app` required — RN's gradle plugin only
  installs dependency substitution under the application plugin) remains the
  fallback for packages without the example app wired.
- Final authority: a **physical Android device** (user rule: never an
  emulator). iOS compiles on CI only; runtime iOS verification awaits a device.

### 16. Expo support is one config plugin, owned by `media-session`
An Expo prebuild app needs exactly one thing it cannot express for itself:
`UIBackgroundModes: audio` in Info.plist. Android needs nothing — the
media-session manifest already merges the FGS permissions and the service, and
RN 0.86's version catalog (which `expo-root-project` reads) hands a prebuild app
compileSdk 36 / minSdk 24 / Kotlin 2.1.20, exactly what media3 1.11 requires. So:
one plugin, in the package that owns background playback, not the standalone
`packages/expo-plugin` PLAN §7 sketched — Expo resolves a library plugin from
`app.plugin.js` at the *package* root, so a separate package would have to be
installed and listed for no gain (`player`'s stale `files` entry for a
nonexistent `app.plugin.js` is deleted). Authored in TS under `plugin/src`,
compiled to CommonJS `plugin/build`, importing from `expo/config-plugins` (the
`expo` re-export — the app's own SDK version wins, and `expo` stays an *optional*
peer so bare apps are unaffected): Expo's documented library layout, matching
what `@react-native-firebase/app` and `react-native-google-mobile-ads` ship.
The Info.plist mod **merges** rather than assigns — idempotent across repeated
prebuilds, and a sibling mode like `voip` survives — under `createRunOncePlugin`.
Two options exist because prebuild regenerates
`android/`: without it the runtime `android.notificationIcon` is unreachable for
Expo apps and media3 silently falls back to its own icon. Vectors go to
`res/drawable`, rasters to `res/drawable-xxxhdpi` (a raster in unqualified
`drawable/` is read as mdpi and upscaled 4×). Files are copied, never resized —
resizing would mean depending on `@expo/image-utils` for every consumer.

### 17. Dependencies: grouped weekly, except the ones RN pins for us
Dependabot runs weekly (Monday) and emits **one grouped PR per ecosystem** for
minor+patch; majors always arrive alone, because a major deserves its own
changelog read. Patch/minor **dev**-dependency PRs auto-merge on green CI;
production dependencies and all majors stay manual.

The exception that makes this safe: a large class of packages here is not a
dependency but a *pin* — react/react-dom, react-native and its `@react-native/*`
toolchain, `@react-native-community/cli`, `@types/react`, the Gradle wrapper,
AGP, Kotlin, and the RN-template Gemfile bounds (`xcodeproj`,
`concurrent-ruby`) are version-locked to the React Native release we target,
and nitrogen + react-native-nitro-modules are locked to each other (§2, §5 —
the C++/Kotlin bindings are *generated* against one runtime). These are
`ignore`d in `.github/dependabot.yml` with the reason attached; they move only
as part of a deliberate, tested RN-upgrade commit. Babel is capped at 7.x for
the same reason: `@react-native/babel-preset` is a Babel 7 stack.

Not theory — the ignore list is what CI already proved: Gradle 9.7.0 failed
with `:gradle-plugin:settings-plugin:compileKotlin > Internal compiler error`
(RN 0.86's own Gradle plugin does not compile under it), and a lone `react-dom`
bump would have left a mismatched React under the only DOM test environment we
have. **Auto-merge on green requires branch protection with the two build
checks marked required** — without it a PR is mergeable the instant it opens
and auto-merge fires while CI is still running (observed 2026-08-10).

### 18. EQ/DSP is a typed chain over mpv's `af`, not a native module
`Player.setAudioFilters([...])` compiles typed filter descriptors into mpv's own
`af` grammar; the raw property stays settable. No C++ was added — mpv resolves
any filter name it does not implement through `avfilter_get_by_name`, so the
whole ffmpeg audio-filter set is reachable from TS the moment it is *compiled in*
(§5 again). The audit found it was not, **on both platforms and for the same
reason**: the audio flavour disables filters wholesale (`--disable-filters` on
Android, `--disable-all` on darwin) and its allow-list held only `overlay` and
`equalizer`, while `--enable-avfilter` and mpv's lavfi bridge were already
present — `af=` resolved to nothing. Android `v1.1.9-rnmedia.2` and iOS
`v0.7.2-rnmedia.2` add the same 16 LGPL filters (EQ, dynamics, crossfeed;
+104 KB/ABI on Android, +103 KB on the iOS device slice; export sets
byte-identical in both cases); **`aresample` is
among them and is not optional** — libavfilter auto-inserts it whenever two pads
disagree on sample format, and every one of these filters pins a different one.
Every GPL-gated filter in ffmpeg n6.0 is a *video* filter, so the LGPL line
(§11) is untouched. Composition is free: user `af` entries are mpv's
`user_filters`, while speed handling (`scaletempo2`) lives in `post_filters`
downstream, and ReplayGain is volume-domain — filters, speed and RG never
interact. On top sits a **10-band preset layer** (ISO octave centres, one biquad
per band, 22 tuned curves + `defineEqualizerPreset` for custom ones). Its one
non-obvious piece: headroom is computed from the *summed* magnitude response,
not the largest slider — octave-spaced one-octave bells overlap and add, so
`Loudness` peaks at +8.8 dB from +7 dB sliders and attenuating by 7 would clip.
**The two platforms are at parity** as of the pins above, so the API needs no
per-platform branching; on binaries older than them the call fails with a typed
`mpv` error (`errno: -11`), which remains the supported availability probe.

### 19. Background hardening: persistence is injected, the sleep timer is native, the FGS grace period is a knob
Three answers to the same question — *what happens to a paused, demoted,
killable service?* — added to `media-session` and verified on device
(POCO/Android 16, release build, 2026-08-10).

**Persistence is a tee over the broadcast setters, and takes zero dependencies.**
`withPersistence(service, storage)` wraps `MediaServiceApi`; `storage` is
structural `{getItem, setItem}` — the `wireAudioSession` philosophy (§3), so
AsyncStorage, MMKV and a `Map` all fit and none is depended on. Writes are
triggered *only* by a broadcast, which is already discontinuity-only (§7); no
timer was added and none may be. A sync engine is written through synchronously,
an async one gets one write in flight with intermediate snapshots coalescing, so
three channel broadcasts in a tick cost one round trip and a late `setItem`
cannot resurrect stale state. The record is versioned and every bad-data outcome
is a *value* (`empty` / `unsupportedVersion` / `corrupt`), never a throw — only a
failing storage engine rejects — and restored payloads pass through the same
validators a live broadcast does.

The three non-obvious decisions:
1. **The anchor is frozen paused at write time and re-stamped `at` on restore.**
   A persisted `rate: 1` is a lie the moment the process dies (every surface
   projects `value + elapsed × rate`), and a restored `playing` status is worse
   than cosmetic: on Android a `playing` broadcast is precisely what *starts the
   foreground service*, so it would raise a notification for audio that does not
   exist. Status is downgraded to `paused`, and the projection is clamped to a
   known `duration`.
2. **A live entry persists position `0`** — using the package's existing
   live discriminator, a missing `duration` (§13, and what already drives
   `isDynamic`/`MPNowPlayingInfoPropertyIsLiveStream`). A restored offset into a
   live stream has nothing to seek to and measures listening time, not a place
   in the content. Leaving it to implementors would make it a bug in most apps
   instead of a decision in one place.
3. **Discontinuity-only writes have a cost, and it is paid explicitly.** A track
   played straight through produces no broadcast and therefore no write — device
   evidence: a 42 s play restored as `0:00`. The fix is *not* a periodic save
   (that is the per-tick write the whole design forbids, and its JS timer would
   freeze in the background anyway) but `service.save()`, which re-projects and
   writes on demand; the app picks the moment (`AppState` leaving `active`,
   `onTaskRemoved`, before `stopService`). With that, the same test restored
   `0:42` across `am force-stop`. Nothing can checkpoint an un-warned kill; the
   position then restores to the last checkpoint, which is never *wrong*, only
   older.

**The sleep timer is native because our own Platform truth says it must be.**
`setSleepTimer/cancelSleepTimer/getSleepTimerRemaining` + an `onSleepTimer`
handler callback. Android uses a main-looper `Handler.postDelayed`, iOS a
cancellable `DispatchQueue.main.asyncAfter` work item — neither is tied to an
Activity, neither is a JS timer. On fire the pause is **native-first** (§9) and,
on Android, literally the same path a notification pause takes: the facade
player's own `Player.pause()`, so media3's optimistic placeholder, the
notification, the lock screen and the JS `pause` handler all behave exactly as
if the user had pressed the button; `onSleepTimer` is fired afterwards purely as
notification, which is why its default implementation is a no-op. Remaining time
is read from *the same clock the timer was scheduled against*
(`uptimeMillis`/`DispatchTime`) so it cannot disagree with when the pause
happens. Deliberately not `AlarmManager`: it would make every consumer request
`SCHEDULE_EXACT_ALARM` to fix a case (a timer armed over silence) that has no
meaning, since playing audio holds the CPU awake for the entire window that
does. Measured on device with the Activity destroyed: armed 13:23:04.480, JS
`pause` at 13:23:49.482 (+45.002 s), `onSleepTimer` 3 ms later, AudioTrack
`state:paused`, session `PAUSED`, zero Activities alive.

**`stopForegroundTimeoutMs` exposes media3's grace period rather than picking a
side.** `@UnstableApi public final void
MediaSessionService.setForegroundServiceTimeoutMs(long)` (media3 1.11.0 —
verified by `javap` on the shipped AAR, not from memory), called from the
service's `onCreate` after `setMediaNotificationProvider`. Its implementation is
`Util.constrainValue(v, 0, DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)`, so
**600 000 ms is the maximum as well as the default** and a negative is silently
clamped to "demote immediately" — which is why the TS layer rejects negatives
rather than letting that happen quietly. The knob exists because the trade-off
is genuinely two-sided (killability and battery vs. surviving to be resumed from
the notification) and neither side is ours to choose; omitted, media3's default
stands. Device evidence: configured to 15 000 ms, `isForeground` held for 14 s
after the pause and was gone by 16 s.

### 20. Playback resumption: the session is rebuilt natively first, and JavaScript is booted behind it
The last background limitation — *the app was killed; the user presses play* —
is answered, opt-in (`android.playbackResumption`, default `false`), and
verified on device (POCO/Android 16, release build, 2026-08-10).

**The feature is not "Android-only"; the *consumer* is.** §19's persistence is
the cross-platform layer and is identical on both platforms. What differs is who
reads the record: on Android the OS does, automatically, through the resumption
card / Bluetooth / a media button; on iOS the user does, by launching the app,
where `restorePersisted` puts them back on the same track at the same position,
paused. An automatic iOS twin cannot be built — a terminated iOS app stays
terminated, because force-quit is read as user intent and nothing may resurrect a
process for playback. That is platform policy, of the same family as "force-quit
kills playback", so the flag lives in the `android` config namespace and
`IosMediaSessionConfig` documents `ios.playbackResumption` as its home if Apple
ever ships a mechanism — the asymmetry is a recorded decision, not an oversight
for someone to hoist away later.

**The state half was already solved by §19; what was missing was a reader.**
`withPersistence` writes a versioned record into the app's storage engine, and
the app's storage engine is JavaScript — precisely the thing a resumed process
does not have. So the same serialized string is *also* handed to native
(`setResumptionSnapshot`) and kept in this package's own `SharedPreferences`:
survives process death, reads back **synchronously** on the service's main
thread, no bridge. One string, two destinations, so the copies cannot drift.
Written on a private thread with `commit()` rather than `apply()` — `apply()`'s
flush is only guaranteed at lifecycle transitions, and the process this feature
exists for is the one that gets none. Config is mirrored the same way, because a
cold service needs the app's notification channel, icon and grace period before
JavaScript can supply them.

**Ordering is the whole design, and it is dictated by a deadline.** Whoever
wakes the service used `startForegroundService()`, which is a ~5-second promise
whose breach is an uncatchable process kill. media3 cannot keep it here: it
promotes on `playWhenReady && (STATE_READY || STATE_BUFFERING)`, and until the
app's runtime is up `SimpleBasePlayer` shows an optimistic placeholder that
keeps `STATE_IDLE`. So: **(1)** post a real `MediaStyle` notification built from
the mirror, bound to the session's platform token (which is also what exempts it
from `POST_NOTIFICATIONS`) under media3's own notification id
(`DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID`), so media3's first
real notification *replaces* it rather than appearing beside it; **(2)** only
then `ReactHost.start()`; **(3)** flip the seeded snapshot to `buffering`, which
hands promotion back to media3 for every transition after the first. That flip
is *posted*, not applied inline, and acknowledges the pending command: it runs
inside media3's own play dispatch, where `invalidateState()` early-returns while
an operation is pending, so completing the future is the only way to get
`buffering` in front of media3 in milliseconds instead of at the 3-second
acknowledgement deadline.

**The handover is a non-event because the player never owned the handlers.**
`BroadcastPlayer` used to capture a `MediaSessionHandlers`; it now asks a
`CommandDispatcher` per command. The service builds the player and the session
with no JavaScript in the process; `MediaService.init` later installs handlers on
the *same* instance. Commands that arrive in between (the `play` that started the
whole thing) are held — bounded at 8, oldest dropped — and replayed after
`onPlaybackResumption` fires, so the app can be ready for the replay rather than
told about it afterwards. That is the opposite ordering to the sleep timer's, and
for the opposite reason: there the work was already done, here it is about to be.

Four decisions worth the words:
1. **The seeded snapshot is forced to `stopped`, not `paused`.** `paused` maps to
   `STATE_READY`, and media3 shows a notification for any session that is not
   `STATE_IDLE` — which would put one on screen the instant the System UI merely
   *binds* us to look at its resumption card. `stopped` is also what
   `MediaLibrarySessionImpl.onGetChildrenOnHandler` requires before it will ask
   for the full recent item.
2. **A sticky restart is not a resumption.** `am kill` on a started service earns
   `Scheduling restart of crashed service … for start-requested` a second later
   (observed). Reviving there would boot the whole app minutes after a kill with
   nobody asking, so a null start intent abandons and stops. A resumption is
   always someone pressing something.
3. **`MediaButtonReceiver` is not merged in from this library.** media3 reads that
   manifest declaration as the app's promise that it can resume
   (`MediaSessionLegacyStub.canResumePlaybackOnStart` is literally "is there a
   receiver for `ACTION_MEDIA_BUTTON`"), and it changes how media buttons are
   routed for *every* app that installs the package. It stays a documented
   copy-paste for bare RN — or, for Expo prebuild (where a paste cannot
   survive regeneration), the config plugin's opt-in `playbackResumption`
   option, which injects it idempotently — and its absence is a log line at
   `init`.
4. **Failure is bounded and says which half broke.** 10 s covers a React cold
   start several times over; on expiry the log distinguishes "the runtime never
   started" from "the runtime started but `MediaService.init` was never called",
   because the second has one fix: **init must be reachable at JS module scope.**
   A revived runtime loads the bundle and starts no surface, so an `init` inside a
   React effect never runs. Not configurable — an app that needs longer has a
   startup problem no timeout fixes. Brownfield (`Application` is not a
   `ReactApplication`) degrades to the old behaviour with one warning.

Device evidence, two entry points, both from a process the OS had killed:
- **Media button** (the framework's remembered `Last MediaButtonReceiver`):
  FGS start granted `+0 ms` → service `onCreate` `+22` → session rebuilt from the
  mirror `+53` → **`startForeground` `+59 ms`** (1.2 % of the window) → media3
  takes the notification `+63` → `ReactContext` `+84` → `MediaService.init` done
  `+254` → audio playing at the persisted `36 033 ms` by `+377`.
- **System UI resumption card** (screenshot-confirmed for a dead process): process
  start `+0` → **`startForeground` `+184 ms`** → `ReactContext` `+196` →
  handover `+349` → resuming at `109 900 ms` by `+453`.
- With `playbackResumption: false`, byte-for-byte the old behaviour: "Started with
  no initialized media session; stopping". With module-scope `init` removed, the
  watchdog fired at exactly 10.001 s with the actionable message and stopped
  cleanly. No `ForegroundServiceDidNotStartInTimeException` anywhere in the run.

### 21. The visualizer taps mpv itself — we patched libmpv rather than ship an Android-only feature
The research question was where FFT/PCM data can come from at all. The first
answer was "the platform, on Android only"; that answer was built, run on a
device, and then **rejected and replaced**, because parity is not negotiable for
a library whose first architectural claim is one engine and identical behavior.

**libmpv's client API has no PCM tap, in any released version.** That much was
true. What was wrong was the conclusion drawn from it — that the alternative was
a per-platform feature. The one shipped precedent, `mpv_audio_kit` (Flutter,
same engine), reads `mpv_get_property("pcm-tap-frame")` from a **patched**
libmpv; its own source says so, and its patches turned out to be published
(`ales-drnz/libmpv-scripts`, BSD-3). So the route existed and was proven — on
desktop, in a GPL build, with a process-wide singleton ring. We took the idea and
the property name and wrote our own, smaller, per-core version (§11).

**What was rejected, and why it stayed rejected.**
`android.media.audiofx.Visualizer` works, and was fully implemented before this
decision. It loses on four counts, any one of which would have been survivable
and which together are not:
1. **It is Android-only.** iOS has no equivalent, so the type system would have
   had to encode a permanent platform split for a feature that has no reason to
   have one.
2. **It requires `RECORD_AUDIO` from every consuming app** — for *any* audio
   session, not only the device-wide mix (the class documentation is explicit;
   the widely-repeated "only session 0" is wrong). A media library cannot put a
   microphone permission in every consumer's manifest.
3. **It is capped at ~20 Hz** (`getMaxCaptureRate()`) **and 8 bits**. The 8-bit
   quantisation is why the first device build showed a wall of full-height bars:
   one LSB is `20·log10(1/128) ≈ -42 dB`, so there is nothing below that to draw.
4. **It taps the platform mixer, not the player.** Following *this* player's
   output needed an `audiotrack-session-id` handed to mpv before
   `mpv_initialize()` — an always-on cost and an Android-shaped seam through the
   core.

`af-metadata/<label>` (lavfi frame metadata, real and present in mpv 0.41)
remains the third option and is still not taken: it yields *levels*, not bins,
and the filters that export them (`astats`, `ebur128`) are not compiled into our
binaries.

**So the fork carries a source patch now, and that is the real decision.**
`004.rn_media_pcm_tap.patch` adds two properties and nothing else:
`pcm-tap` (int, rw — samples per channel to retain, `0` = off) and
`pcm-tap-frame` (node, ro — `sample_rate`/`channels`/`frames`/`pts_us`/`seq`
plus `samples`, a byte array of interleaved float32). Four source files, no
build-system files, which is why **one patch file has now survived three
different mpv versions across two forks** — it applied to 0.35.1 and 0.36.0 with
only hunk offsets differing, and was re-derived once for 0.41 (where
`ao_post_process_data`'s neighbourhood moved) and is byte-identical between the
two forks again. The
tap sits at the end of `ao_post_process_data()` — the funnel every AO's data
passes through in `buffer.c`'s `read_buffer()` — so it is after the filter chain
and after mpv's software gain, and reports what is *audible*. It hangs off
`mpv_global` rather than a file-static, because this library runs several mpv
cores in one process and each must tap its own audio. The write path runs on the
device thread and never blocks: it `trylock`s and drops the chunk on contention.
**No new exported symbol** — the whole feature is reachable through
`mpv_get_property`/`mpv_set_property`, so it adds nothing to either platform's
export list and the ABI is untouched. (The export *lists* did change at the 0.41
bump, but for reasons that have nothing to do with the tap; §11.) Cost when it
was introduced: +2.6 KB/ABI on Android, +224 B on the iOS device slice.

**The escalation was priced before it was accepted.** A patch is a rebase
liability a configure flag is not; §11 now carries the procedure, and
`rn-media-release.sh` refuses to package a binary that does not contain a string
only the patched code emits.

**One version-specific companion patch, and the bug that earned it — now
deleted.** `005.mpv_dup_node_byte_array.patch` (Android only) backported upstream
mpv's own `dup_node` byte-array arm. Every `MPV_FORMAT_NODE` property is copied
out of its handler through `copy_node()` → `dup_node()`, and mpv 0.35.1's switch
has no `MPV_FORMAT_BYTE_ARRAY` case, so the node was stamped `(mpv_format)-1` —
invalid. On device the map's scalars arrived intact (`channels: 2, frames: 2048,
seq: 1082`) while `samples` came through empty, which reads exactly like a tap
with no audio rather than a copy that dropped a field. mpv gained the arm in
**0.36.0**, which is why the darwin fork never needed it, and the Android fork's
move to 0.41 (§11) retired it exactly as predicted. It is recorded here because
the *failure mode* outlives the patch: a NODE property whose scalars survive and
whose payload does not is a copy bug, not an empty source.

**The FFT is native; every opinion above it is TypeScript.** The PCM never
crosses into JavaScript. A native sampler thread (`PcmTap`) reads the tap on its
own clock, downmixes to mono, applies a Hann window, transforms with a
precomputed radix-2 FFT and hands over ~4 KB of magnitudes — normalised so a
full-scale sinusoid reads exactly `1.0`, which the host-compiled suite asserts
against a real transform. That split is §5 with a performance reason attached: a
2048-point transform is ~135 k float operations, which is nothing in C++ and is
real work in Hermes at 30-60 Hz, and shipping magnitudes instead of samples
quarters the payload. Above the transform, in TypeScript and per subscriber:
band aggregation, the dB window, smoothing, peak ballistics — unit-tested
device-free.

**Sampling on a timer is right here, and §6 still stands.** §6 forbids polling
for *state*, because state changes are discrete and rare so sampling them is both
wasteful and lossy. A spectrum is the opposite: a fixed-rate render of a
continuous signal, where "30 frames per second" *is* the requirement. The timer
is a native thread because a JS timer would be on the thread we must not block
and would freeze outright in the background (Platform truths). Back-pressure is
§6's, with one deliberate difference: events accumulate and coalesce while JS is
busy because an unseen property change still has to be applied, whereas a
spectrum that arrived while JS was busy is a picture of the past — so ticks are
**dropped and counted** (`frame.dropped`), never queued.

**Delivery rate is not information rate, and the docs say so.** New spectral
content arrives only when the audio device consumes a chunk: `ao_audiotrack`
writes one `getMinBufferSize() * 2` chunk at a time under `WRITE_BLOCKING`, which
measures ~20-45 Hz. Delivering at 30 is still worth doing — the asymmetric EMA is
what turns a stepped target into motion, and it can only do that on frames it is
given. Ticks that find an unchanged `seq` re-send the cached spectrum instead of
recomputing an identical FFT; a `seq` that stands still for 300 ms is a pause,
and the tap reports silence so the display decays to rest instead of freezing
mid-bounce.

**The default is the audio, not a flattering picture of it.** Bands aggregate by
**power** (the sum of squared magnitudes over the band's bins), not by their
loudest bin, so a band responds to how much energy it holds rather than to
whichever bin spiked. Two display aids exist and **both default to off**:
`tiltDbPerOctave` (music's power falls ~3 dB/octave, so a tilt makes the top of
the display as busy as the bottom — and is a deliberate lie about the audio) and
`autoGain` (a bounded, asymmetric tracker that keeps quiet material on screen at
the cost of bar height no longer meaning a level). What a default subscription
draws is the measured spectrum: a dB axis, a smoothing filter, nothing else. The
one unavoidable choice is where that axis starts, and it was set by measurement
rather than taste — on a modern commercial master the quiet bands sit near
-35 dBFS and the loud ones near -17, so the window is -40…-10 dBFS.

**Laziness is enforced by the shape of the API, not by discipline.** The
primitive is `subscribe()`, not `start()`/`stop()`: the sampler thread, the FFT
tables and mpv's ring are *derived from* the listener set, so they cannot be
leaked by forgetting to stop them. There is deliberately no free-standing
`start()` — it could only mean "hold the tap open with nobody looking". Disarmed,
mpv's write path is a single atomic load per device chunk and nothing is
allocated — and as of 2026-08-12 that is literally true on our side too: the last
unsubscribe *frees* the `PcmTap` (tables, Hann window, PCM/mono/real/imag scratch
and both magnitude buffers — ~75 KB at the default 2048-point transform, ~600 KB
at the 16384 ceiling, per player) instead of merely stopping its thread. Reading
`capabilities` allocates nothing either, because the
capability probe is one property read (`pcm-tap` exists ⇒ this binary carries the
patch), which is the same code on both platforms and needs no `Platform.OS`.

**The example is the reference render pattern.** A grid of segment Views — 320
of them changing style 30 times a second — is a layout storm that would break
this library's own performance rule from the UI side regardless of how good the
data is. `apps/example` draws each bar as a static colour column with an opaque
mask slid over it and a peak cap above: **two Views per band, both moving by
`transform` only**, so a frame costs a commit and a draw and no measure pass. The
LED segmentation is one grid drawn over all the bars, laid out once.

Device evidence (POCO/Android 16, 2026-08-11, `v1.1.9-rnmedia.4`): a live
Shoutcast AAC+ stream and a finite AAC/MP4 track both drive a 20-band display at
48 kHz from 2048-frame windows, `gain 0.0 dB` (auto-gain off), with per-band
structure that tracks the music and a natural high-frequency roll-off. **Release
build: 60 fps requested, 60.0 measured at the JS listener, zero dropped.** The
same code in a *debug* build measured 24-26 fps with occasional drops — worth
recording, because it is the one number here that says more about Hermes running
unoptimised JS than about the engine, and measuring a visualizer in a debug
build is how you conclude the wrong thing about where the ceiling is.

### 22. Recovery from a failed entry is two layers, and only one of them may wait
mpv advances past an entry that fails hard. That is right for a file that will
never play and wrong for a stream that was unlucky, and nothing in mpv separates
the two — so the separation is ours, made from the typed taxonomy's new
`PlayerError.retryable` flag.

**Layer 1 is FFmpeg's own HTTP reconnection**, wired through mpv's
`stream-lavf-o` (applied by `mp_setup_av_network_options()` *last*, so it beats
mpv's derived options, and applied from both `stream_lavf.c:407` and
`demux_lavf.c:1024` — the top-level connection *and* an `AVFMT_NOFILE` demuxer's
own fetches, which is how HLS segments are covered by one value). It runs inside
libavformat's read loop with no timers and no JavaScript, which is the only
place a *delay* is allowed to exist at all (see Platform truths: JS timers
freeze with the screen off). Defaults, verified against the shipped
`libmpv.so`'s strings and that FFmpeg tree's `libavformat/http.c`, not from
memory: `reconnect=1`, `reconnect_on_network_error=1`, `reconnect_streamed=1`,
`reconnect_delay_max=5`. FFmpeg's own defaults are all-off / 120 s, so this is
opt-out (`networkReconnect: { enabled: false }`).

**Layer 2 is the player's bounded re-attempt** (`retry`, 2 attempts by default),
which answers the one question layer 1 cannot see: *should the queue move on?*
On an `end-file` error whose classified error is `retryable`, the player jumps
back to the same entry with playback intent preserved, emits a typed `retrying`
event, and emits **no** `error` — nothing has finally failed yet. When the budget
is spent the advance mpv already performed is left alone and `error` fires with
the attempt count. Attempts are tracked per entry generation and reset on
success (a `playbackRestart`), on a different entry failing, and on any app
cursor move or queue edit — a user who skips during a retry has said what they
want.

**There is deliberately no delay in layer 2**, and that is the load-bearing
constraint rather than an omission: the only way to wait in JavaScript is a
timer, so a backoff written there would silently become "retry when the user
next unlocks the phone" — a bug invisible to every test that runs with the
display on. Spaced, backed-off retrying belongs to the layer that is native.
The cost of acting immediately is that a re-attempt is issued a moment after mpv
has already started the next entry, so a boundary failure can produce a brief
blip of the following track; that is the honest trade and it is documented on
the option.

**The clean close is layer 2's, on request** (`retry.retryLiveEof`, default
off). A radio server that hangs up *politely* produces `MPV_END_FILE_REASON_EOF`
— no error number, no error string — so neither of the two layers above sees a
failure at all: FFmpeg does not act on it (`reconnect_at_eof` is deliberately
not set, because `http.c:1871` does not guard it on `is_streamed` and it would
turn every finite track's natural end into a reconnect storm), and layer 2's
gate is `PlayerError.retryable`, which a clean end never reaches. With the flag
on, an `eof` on an entry whose state was `isLive` — mpv's `seekable = no`, so a
finite file can never qualify — takes the same bounded per-entry budget,
immediately and with no timers, emitting `retrying` with a *synthesised*
`network` error (`errors.ts:liveEofError`; `raw` carries the end-file reason
because there is no mpv error string to carry). When the budget is spent the end
is reported as the `trackEnded` it always was — never as an `error`, because a
clean end is not a failure and giving up on re-attempting it does not make it
one.

Its reset rule is the one part that could not be inherited: the ordinary budget
resets on the first `playbackRestart`, which here would mean a server that hangs
up after one second refills its budget on every reconnect and re-attempts
forever. So a live-`eof` generation resets only after
`LIVE_EOF_BUDGET_RESET_SECONDS` (30 s, the same number as `cache-secs`: the
entry played for longer than the audio the player is willing to hold) of
wall-clock playback since the restart. Bounded either way — a broadcast that has
genuinely ended is re-attempted `maxAttempts` times and then the queue moves on,
which is the documented cost of recovering the station that had not.

## Platform truths we build around (learned, verified)

- **JS timers freeze in background** without an Activity (JavaTimerManager
  gates on lifecycle + headless tasks; Samsung freezes them even with one —
  RN #56324). Nothing timing-critical may live in JS. The consequence is not
  advice to consumers but a shipped feature: `media-session` provides the sleep
  timer natively (§19), because an app that built one on `setTimeout` would ship
  a bug that only appears with the screen off.
- **An unhandled JS exception destroys the whole runtime** (default
  ReactHostDelegate rethrows). All handler dispatch is wrapped.
- **CocoaPods `exclude_files` applies to *every* attribute including
  `vendored_frameworks`** — a `dir/**/*` guard pattern silently de-linked all
  ten libmpv frameworks. Exclusions must name compilable extensions.
- **nitrogen hardcodes Kotlin hybrid classes' JNI descriptor to
  `com.margelo.nitro.<ns>`** — a wrong package compiles, links, ships, and
  throws ClassNotFoundException at runtime.
- **media3 1.11 keeps a paused media service in the foreground for a 10-minute
  grace period** — "demote on pause" is not immediate, by design. That 10
  minutes (`DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS`) is simultaneously the
  **ceiling**: `setForegroundServiceTimeoutMs` runs its argument through
  `Util.constrainValue(v, 0, 600_000)`, so a larger value is clamped down and a
  negative is clamped up to "demote now" without a word. There is no SDK-level
  branch in the logic — the grace period is identical on every API level.
- **`am kill` and `am force-stop` are not the same kill.** `am kill` leaves the
  System UI resumption card in place (SystemUI logs `Converting … to resume`) and
  earns a START_STICKY service restart a second later; `force-stop` removes the
  card outright (screenshot-confirmed) *but* — measured on Android 16, contrary
  to the usual folklore — the framework still holds the app's
  `Last MediaButtonReceiver`, so a headset play still revives it. Only `am kill`
  reproduces the scenario users actually hit.
- **The OS, not the app, grants the FGS start for a resumption.** Both entry
  points arrive with `code:TEMP_ALLOWED_WHILE_IN_USE;
  tempAllowListReason:<…,reasonCode:MEDIA_SESSION_CALLBACK,duration:10000>` —
  a 10-second allowlist (`media_button_receiver_fgs_allowlist_duration_ms`).
  That window, not the 5-second `startForeground` promise, is the real budget for
  everything before the notification is up.
- **FFmpeg's `reconnect_at_eof` is not guarded on `is_streamed`, so it cannot be
  a global default** (verified 2026-08-12 against the exact tree the shipped
  engine is built from, FFmpeg `n8.1.2`). It is the option that makes a live
  stream reconnect when the server simply closes the connection — the obvious
  thing to want for radio — but `http.c`'s read loop tests
  `!(reconnect && is_premature) && !(reconnect_at_eof && read_ret ==
  AVERROR_EOF)` with no seekability term above it. On an ordinary sized file the
  natural end of the response *is* `AVERROR_EOF` and `is_premature` is false, so
  enabling it makes every clean track end reconnect on the backoff schedule until
  `reconnect_delay_max` is exceeded and then return `AVERROR(EIO)` — turning "the
  song finished" into "the song failed", i.e. destroying the `trackEnded`-vs-
  `error` distinction the whole taxonomy rests on. Shipped defaults therefore
  omit it, and the consequence is stated rather than hidden: a *live* stream's
  mid-play drop is recovered by §22's layer 2 (re-open the entry), not by
  FFmpeg. A live-only app can opt in through the raw
  `mpvOptions['stream-lavf-o']`, which replaces the list wholesale. The general
  lesson is the recurring one: read the option's *use site*, not its description
  — the help string ("auto reconnect at EOF") says nothing about which streams it
  is safe for.
- **`--enable-protocol=hls` in an ffmpeg build proves nothing** — it's the
  deprecated `hls://` protocol; only the `hls`+`mpegts` *demuxers* matter.
- **Nor does the string `aresample` in libavfilter** — same family, found while
  verifying the iOS filter build. `libavfilter/formats.c:339` stores
  `.conversion_filter = "aresample"`, the name the graph *looks up* when two
  pads disagree, so the literal is in the binary whether or not the filter was
  compiled. Proof of registration has to come from something only the filter's
  own object file emits (here `af_aresample.c:164`'s log format).
- **~~mpv's manual documents `replaygain-clip` inverted~~ — RETIRED at the 0.41
  engine bump.** It was true of 0.35.1 ("prevent clipping"), and our API was
  mapped to the *behaviour* verified in `player/audio.c` rather than to the
  prose. mpv 0.41's `options.rst` now reads "Allow the volume gain to clip
  (default: no)", which is what the code always did, so the two agree and our
  mapping is unchanged. Kept as a retired entry because the API shape it
  produced is still in the public surface, and a reader who finds the current
  manual correct should not conclude the API is backwards.
- **mpv's waf did not relink `libmpv.so` when ffmpeg's static libs changed** —
  a rebuilt `libavfilter.a` next to a stale `.so` looked like a successful build
  and silently shipped the old binary (`./build.sh --clean -n mpv` forced it).
  **Re-tested after the meson migration (mpv 0.41): it does NOT reproduce** —
  ninja tracks the archives as link inputs and relinks. The trap is gone; the
  *lesson* is not, and it is the same one the `--enable-protocol=hls` flag
  teaches: always verify flags/symbols in the **shipped** artifact, never in the
  build log.
- **Native callbacks do not freeze in the background — only JS timers do.**
  The visualizer's frames come from a native sampler, so backgrounding stops
  nothing by itself: measured on device (release, 20 bands @ 60 fps), the JS
  thread burned **39% of a core with the display asleep**, rendering commits
  nobody could see — and unlock delivered the backlog as a freeze. The mirror
  image of the sleep-timer trap (§19): there JS was frozen when it needed to
  run; here it ran when it needed to stop. Native-callback→JS feeds need an
  explicit gate — `useVisualizer`'s `pauseWhenInactive` (default on) drops the
  subscription, so the lazy rule disarms the tap for free (fixed: JS thread 0%
  with screen off, audio pipeline untouched).
- **`AppState` is not the display state on Android, and the difference is
  measurable** (2026-08-12). The gate above was `AppState`-only, and a screen-off
  soak on a Poco F4 (MIUI, charging) caught it flapping: subscribed 11:25 →
  paused 11:36 ("not in the foreground") → **re-subscribed 11:43, screen still
  off** → paused 11:53. In the window it was wrongly awake the visualizer ran at
  **65-80% of a core**, against steady screen-off playback of 3.8%. `AppState`
  answers "is my Activity foreground", which OEM lifecycle policy (a resumed
  Activity behind the keyguard, a charging/doze overlay) can make true with
  nothing on screen; `PowerManager.isInteractive()` +
  `ACTION_SCREEN_ON`/`ACTION_SCREEN_OFF` *is* the display state and cannot
  disagree with itself. The gate is now the AND of the two — either says
  inactive → pause, both must say active → resume — with the display signal as a
  small Kotlin HybridObject in `@rn-media/player` (`RnMediaScreenState`) whose
  receiver is derived from its listener set. iOS needs no second signal and gets
  a constant `true`: locking the device resigns the app's active state and
  backgrounds it, and there is no iOS state where the app is foreground-active
  with the display off, so there `AppState` already *is* the display truth. **Any
  native-callback→JS feed gated on `AppState` alone on Android has this bug**, so
  the rule is the pair, not the convenience.
- **meson feeds the built-in `*_link_args` to compiler *checks*, not just to
  targets.** Putting `-Wl,-exported_symbols_list` on the darwin cross file — the
  obvious place, since `-Dc_link_args=` would *replace* the cross file's
  `-arch/-isysroot/-version-min` triple rather than append to it — applied a list
  naming only `_mpv_*` to every two-line probe meson links, and
  `dependency('appleframeworks', modules: ['Foundation','AudioToolbox'])` is a
  link probe. Result: `Run-time dependency appleframeworks found: NO` and the
  AudioUnit AO gone. It failed loudly only because our option is
  `-Daudiounit=enabled`; at meson's default `auto` the probe would have failed
  identically and the build would have SUCCEEDED with no audio output in it. Link
  flags meant for one artifact belong on that artifact's target.
- **A green CI checkmark is not an artifact** (2026-08-12). Four intermediate
  commits on the Android fork's `rn-media-hls` branch reported a green build
  while producing no engine at all: `bundle.sh` had no `set -e`, so a failed mpv
  configure left the `libmpv.so` copy failing too, `zip` packed whatever was on
  disk, and the job exited 0 with 480 KB jars where a real build is ~15 MB.
  Nothing in the pipeline was reading that number, so the only signal anyone had
  was the exit code, and the exit code was lying. Guarded three ways now:
  `set -euo pipefail` in the bundler, a per-jar assertion that
  `lib/<abi>/libmpv.so` is actually present, and an independent size check in the
  workflow itself. **The rule: a release gate asserts artifact CONTENT and SIZE,
  never an exit code.** This is the same lesson as "verify flags in the shipped
  artifact, never the build log", escalated one level — there the log was merely
  uninformative, here the *job status* was actively reassuring. Cross-platform
  enforcement is `workshop verify-artifacts` in `afkcodes/rn-media-engine`, which
  downloads the RELEASED assets of both forks and scores every slice against
  every category (12 x 10 = 120 cells at the rnmedia.7/.6 pair, 0 FAIL); its very
  first run is what found the iOS simulator slice shipping with no audio output
  compiled in, four generations after the fact.
- **generator scaffolds contain load-bearing "dead code"**: the ReactPackage
  class is the only trigger of `System.loadLibrary` — deleting it fails only
  at runtime.
- **mpv 0.35.1 silently destroys a byte array inside a NODE property** (no
  longer reachable — both forks ship 0.41 — but the failure shape is the point).
  Every
  `MPV_FORMAT_NODE` property is copied out of its handler through
  `copy_node()` -> `dup_node()`, whose switch had no `MPV_FORMAT_BYTE_ARRAY` arm
  until mpv **0.36.0** — the node falls into `default:` and is stamped
  `(mpv_format)-1`. The failure is maximally misleading: the map's scalars
  arrive intact and only the payload is gone, so it reads as "no data yet"
  rather than "the copy dropped it". Upstream's own fix was backported as
  `005.mpv_dup_node_byte_array.patch` and deleted at the 0.41 bump (§21).
- **The audio device consumes chunks at ~20-45 Hz, so that is the rate new
  spectral content actually appears at** — `ao_audiotrack` writes one
  `AudioTrack.getMinBufferSize() * 2` chunk per iteration under
  `WRITE_BLOCKING`. A visualizer's *delivery* rate can and should be higher; the
  asymmetric smoothing is what fills the gap, and a tap read that finds an
  unchanged `seq` must re-send the cached spectrum rather than recompute it or
  blank the display.
- **`android.media.audiofx.Visualizer` requires `RECORD_AUDIO` even on your own
  audio session.** The widely-repeated "only session 0 needs the permission" is
  wrong: the class documentation gates *the use of the visualizer* on
  `RECORD_AUDIO`, and `MODIFY_AUDIO_SETTINGS` is the *additional* requirement
  for session 0. There is no same-app exemption. Recorded because it is what
  disqualified that entire route (§21), not because anything here depends on it.
- **`Visualizer` is 8-bit, and it shows.** One LSB is
  `20·log10(1/128) ≈ -42 dB`, so a Web-Audio-style -100 dB floor maps the
  quantisation noise itself to a tall bar and the display saturates into a flat
  wall (observed on device before the mpv tap replaced it). Its ~20 Hz
  `getMaxCaptureRate()` ceiling was the other half of why it went.
- **mpv marks `af-metadata` changed on `MPV_EVENT_TICK`, and for audio-only
  playback `handle_dummy_ticks` fires that every 50 ms** (`player/playloop.c`)
  — so a lavfi metadata observation is a 20 Hz feed, not a per-frame one, and
  `match_property`'s compare-to-the-first-slash means observing
  `af-metadata/<label>/<key>` inherits that mask.
- **An observed mpv property is re-emitted only on an *unequal* value, and
  observers are walked in *registration* order — so a property is not
  guaranteed to be republished after a track change.**
  `player/client.c`: `send_client_property_changes()` compares the new value
  against the last one delivered to that observer and skips the event when they
  are equal, and `gen_property_change_event()` walks a client's observer list in
  the order the observations were made. Both bite at a gapless boundary:
  `OBSERVED_PROPERTIES` registers `duration` before `playlist-pos`, so the *new*
  entry's `duration` is delivered in the same batch **before** the cursor change
  — and two consecutive tracks of equal length produce no `duration` event at
  all. Diagnosed on-device 2026-08-11: the state layer used to drop
  `duration`/`seekable`/`title` on a `playlist-pos` change and wait for mpv to
  republish them, and after a gapless transition they stayed `undefined` for the
  rest of the entry (no duration, no seek bar, no title). Reordering the
  observation table fixes nothing — the equal-value rule is independent of
  order. **The state layer therefore never relies on post-transition
  republication: the Player one-shot-reads `duration`, `seekable` and
  `media-title` when a batch moves the cursor** and injects them into the
  reducer through `ReducerContext.trackChange`, exactly as it already did for
  `time-pos` on a position discontinuity (at most one read of each, per batch,
  only when the cursor moved). A read that comes back unavailable means
  *honestly unknown* — the field is dropped and mpv will emit it once it knows,
  because `none → value` compares unequal.
- **The RN Gradle plugin's bundle task does not track monorepo workspace
  sources, so a green `assembleRelease` can package a stale JS bundle.**
  `BundleHermesCTask` declares exactly one source input — a file tree rooted at
  `react.root` (here `apps/example`) that excludes `**/node_modules/**` — while
  Metro resolves `@rn-media/*` from *source* (`"react-native": "src/index"`)
  through the `node_modules/@rn-media/*` symlinks. Every line of library code in
  the bundle is therefore invisible to the up-to-date check. Bit us 2026-08-11:
  bundle written 12:11, fix in `packages/player/src` written 12:25, the 12:33
  build reported `createBundleReleaseJsAndAssets UP-TO-DATE` and shipped the
  12:11 bundle — the rebuilt, reinstalled APK ran the old JS and *false-verified
  a fix as still broken*. It cleared only after deleting
  `app/build/generated/assets/react` and `intermediates/assets/release` by hand.
  This is the on-device equivalent of the "verify the shipped artifact, never the
  build log" rule above, one layer up: here the build log was not merely
  uninformative, it was actively reassuring. Guarded in
  `apps/example/android/app/build.gradle`, which declares the three
  `packages/*/src` trees as explicit inputs of every `createBundle*JsAndAssets`
  task (matched by name pattern, so new variants inherit it; debug loads from
  Metro and has no bundle task). Note when reproducing: Gradle fingerprints file
  *content*, so `touch` alone proves nothing — the input has to actually change.

## Update policy

This file is owned by the architect session. Any change that alters a decision
above — a new default, a changed dependency, a reversed trade-off — updates
this file in the same commit. Implementation agents read it (it is referenced
from CLAUDE.md) and report contradictions rather than silently diverging.
