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

Two consequences that are API decisions rather than implementation details.
**Discontinuities are events** (`seekStarted`/`seekCompleted`, carrying
`reason: 'seek' | 'auto-advance'`), derived from mpv's `MPV_EVENT_SEEK` and the
`playlist-pos` change against the `playbackRestart` that lands them — no new
native signal, and they are what makes accurate listening analytics possible
without polling: everything between two of them was heard in real time. And
**playback milestones (25/50/75/90 %) are a hook, not a `Player` feature**
(`useMilestones`), because a mid-track time event needs a tick and this design
has none: a timer inside the player would freeze with the screen off (see
Platform truths) and fire a burst on unlock, while a discontinuity-only check
would fire every mark at once at the track's end. The hook rides `useProgress`'s
existing tick and adds no timer; the honest cost — no mounted UI, no
milestones — is documented on it rather than hidden.

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
- **`stop()` keeps the queue; clearing is the opt-in.** mpv's bare `stop`
  "stops playback and clears playlist" (input.rst) — `Player.stop()` instead
  sends `stop keep-playlist` and reserves the full clear for
  `stop({ clearPlaylist: true })`. The default is judged against the RN
  ecosystem, not mpv's CLI: react-native-track-player's `stop()` keeps the
  queue (clearing is its separate `reset()`), so a migrator's `stop()`
  silently destroying a queue is data loss, while the reverse surprise — the
  queue still being there — is benign. Destructive stays opt-in, like
  everywhere else in the API. After `stop()` mpv leaves no entry "current"
  (`playlist-pos` −1, so `hasNext`/`hasPrevious` read false): the way back
  into the kept queue is `playlist.jumpTo(i)`, not `play()`.
- **Audio-only core defaults**: `vid=no`, `force-window=no`, `idle=yes`,
  `audio-display=no`. The cost, stated because the README's formats row used to
  imply otherwise: under `audio-display=no` mpv never *selects* the
  attached-picture track (`player/loadfile.c:617`), and the only image-returning
  command in the client API (`screenshot-raw`) needs a configured video output
  this core never creates — so embedded cover art **decodes** (eight decoders
  are compiled) but cannot be **extracted**. Detection survives
  (`track-list/N/albumart`); extraction is native work, not a wrapper.
- **Every `loadfile` per-file option is escaped with mpv's own quoting.** The
  option list is `opt1=v1,opt2=v2`, parsed by `parse_keyvalue_list()` →
  `read_subparam()` — the *same* function the `af` chain goes through — so the
  same rule applies: anything outside mpv's `NAMECH` alphabet is written
  `%<bytes>%<value>` (`subparam.ts`, shared with `filters.ts`). Unescaped, any
  value containing a comma truncated the list and shifted every option after
  it; the case that made it a real bug rather than a latent one is
  `http-header-fields`, itself a comma-separated list, i.e. exactly the option
  an authenticated library needs. Headers therefore get **two** layers: `\,`
  inside the list item (mpv's string-list rule, `get_nextsep()`), `%n%` around
  the whole value.
- **`startPosition` on a queue belongs to one entry.** `loadPlaylist` attaches
  `start=` to the entry at `startIndex` only. Applied to every appended entry —
  as it was until 0.1.0 — the natural session-restore call
  (`{ startIndex: 5, startPosition: 120 }`) silently made *every* track begin
  two minutes in, and per-file options publish nothing observable to notice it
  by. Combining it with `shuffle` throws, for the same reason `startIndex` +
  `shuffle` does: after mpv permutes the queue no index identifies the source
  the offset was meant for.
- **The current entry's URI is read at the boundary, not remembered from the
  load.** Error classification (network vs load-failed, and therefore
  `retryable`, and therefore §22's whole retry decision) is keyed on the URI of
  the entry that failed. That used to be whatever `load()`/`loadPlaylist()` was
  last told, so after one `playlist.next()` every failure was judged against a
  track that finished minutes ago. It is now `playlist/<new index>/filename`,
  read in the same already-paid one-shot batch as `duration`/`seekable`/
  `media-title` (a fourth read on cursor-change batches, worst case six per
  batch) and adopted *after* the fan-out, so an `end-file` in the same batch is
  still classified against the entry that ended.
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
Every GPL-gated filter in ffmpeg is a *video* filter, so the LGPL line
(§11) is untouched — re-checked at n8.1.2 on 2026-08-14 (#51): all 33
`*_filter_deps="…gpl…"` entries in `configure` are video filters or video
sources, and none is audio. Composition is free: user `af` entries are mpv's
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

**A slider commands the running filter; it does not rewrite the chain**
(2026-08-17, the fix for the EQ fader bank shipped in `c1918ac`). Writing `af`
is a *rebuild*: mpv keeps only the entries whose arguments are byte-identical
and destroys and recreates the rest, losing what they had buffered
(`filters/f_output_chain.c:535-593`), then compares the chain's measured delay
before and after and issues an exact refresh seek if it dropped by ≥0.2 s
(`player/audio.c:107-125`) — and the write is synchronous, so the JS thread
waits for all of it. One write is a settings change; sixty a second is a
destroyed stream, which is exactly what a `PanResponder` produces and exactly
what the owner heard. The answer is mpv's `af-command`, which reaches into the
live filter: `Player.setAudioFilterParam(filter, param, value)`. ffmpeg's
biquads flag `frequency`/`width_type`/`width`/`gain` as
`AV_OPT_FLAG_RUNTIME_PARAM` and their `process_command` recomputes the
coefficients with `config_filter(outlink, **0**)` — `reset = 0`, so the filter's
own state survives and a gain *sweeps* (n8.1.2 `af_biquads.c:1410-1420,1444,
1522-1533,1028-1031`); `volume` does the same for its gain expression
(`af_volume.c:64,66-68,307-321`). Two traps, both found the hard way:
**(1) mpv's `<target>` argument defaults to `all`, and `all` is silently
wrong** — every `af` entry is its own libavfilter graph with an `abuffer` and an
`abuffersink` around the real filter, `avfilter_graph_send_command` overwrites
its result on every matching filter and returns the *last* one
(`avfiltergraph.c:1470-1481`), and the sink answers `ENOSYS`
(`avfilter.c:610-629`) — so the gain lands and mpv reports failure, our fallback
rewrites the chain, and the bug reappears wearing a different hat. We send the
filter's own name as the target, which is why the API takes an `AudioFilter`
rather than a label. **(2) `af-command` needs a labelled entry and a chain whose
*shape* does not move with its values**, or a band crossing 0 dB becomes a
rebuild mid-drag: `equalizerPresetChain(curve, { editable: true })` emits all
ten bands, labelled (`@rnmedia_eq_<hz>`), pre-amp and limiter included — a flat
curve still compiles to nothing at all. The residue is honest: `af` now lags the
running chain, so `useEqualizer` commits the property once, 250 ms after the
last change (its only timer, flushed on unmount), and a player that refuses the
commands degrades to *commit-only* rather than back to per-frame writes.
Device-verified (POCO F4, release, live stream and seekable file): a 3 s drag
costs **0 AudioTrack underruns and 0 flushes** with the position advancing
3001 ms; the same gesture on the broken-target build cost 32 640 underrun frames
and 198 865 flushed frames.

**The tail limiter stays on, because the pre-amp bounds the wrong thing**
(2026-08-17, reviewed after the EQ fix). `equalizerPresetChain` appends
`alimiter` to every non-flat curve, which reads like belt-and-braces next to a
pre-amp that already computes exact headroom — until you notice the two bound
different quantities. `peakResponseDb` is `max |H(f)|`: a *frequency-domain*
guarantee that no steady sine leaves above unity. Clipping is a time-domain
event, and the tight bound on a filter's sample-peak gain is `‖h‖₁`, which is
strictly larger. Measured over our own curves at 48 kHz (RBJ coefficients per
`af_biquads.c:826-828,850-857`, impulse response summed): `Rock` after its
−4.8 dB pre-amp still has **+4.9 dB** of worst-case peak gain, `Loudness` after
−8.8 dB has +5.2 dB, and `Bass Reducer` — pure cuts, so `-max(0, peak)` is
**0 dB and no pre-amp entry is emitted at all** — has +5.7 dB. Even a single
band at +0.1 dB has +0.03 dB. So the honest predicate for "this curve cannot
clip" is false for every curve that does anything, and making the limiter
conditional on it would compile to exactly today's `bands.length > 0`; the
tempting *wrong* predicate (post-pre-amp `max |H(f)|`, which is ≈0 dB by
construction) would remove the limiter everywhere and restore the clipping.
**Verified against `af_alimiter.c` n8.1.2 rather than assumed**, because "a
limiter with auto-level" sounds like it touches the programme and it does not:
`level` is not automatic levelling but the single constant `1 / limit`
(`:140,289`), so at our default ceiling of 1 it multiplies by exactly 1 —
it cannot raise quiet material; and the gain reduction is a running scalar that
starts at 1 and is only ever moved by a sample above the ceiling (`:102,180,236,
239,269-275`), so below full scale the output is sample-identical to the input.
The one real cost is honest and now documented: `latency` defaults to off
(`:376-379`), so the 5 ms look-ahead is uncompensated — the chain emits 5 ms of
silence when it is built and never flushes the last 5 ms of the stream. The
same `level` semantics are a live trap for hand-built chains
(`limiter({ limit: 0.891 })` limits to −1 dBFS and then scales back to 0), so
`LimiterOptions.autoLevel` says so in as many words.

**Loudness normalization is a *managed entry* of this same chain, not a second
mechanism** (2026-08-13). `Player.setLoudnessNormalization(enabled, options?)`
owns exactly one labelled entry — `@rnmedia_loudnorm:loudnorm=…` — appended
after the user half; `setAudioFilters` owns everything before it. The player
tracks the user half in TS and every call from either side recompiles the whole
`af` property, so EQ presets and normalization compose without either
clobbering the other; the label is reserved and user chains carrying it are
rejected (two owners of one mpv label would silently overwrite each other).
Tail position is deliberate: the normalizer must hear the EQ's output, and its
built-in true-peak limiter then guards the chain's sum. Bookkeeping commits
only *after* the property write succeeds, so a chain mpv rejected can never be
re-applied later from stale state. The semantics were verified against the
FFmpeg 8.1.2 tree the binaries build from, not remembered: one-pass `loudnorm`
is always the **dynamic** mode (the linear mode gates on all four `measured_*`
inputs from a prior analysis pass, `af_loudnorm.c:820-825` — unobtainable
live), it pins the chain to 192 kHz in that mode (`af_loudnorm.c:740,752`;
`doc/filters.texi`), and it buffers 3 s of lookahead (`af_loudnorm.c:697,775`)
— so the TSDoc sells it as a dynamics processor with real CPU cost, not free
loudness. The default target is −16 LUFS (AES TD1008.1.21-9, Table 1:
track-normalized music −16 LUFS), overriding ffmpeg's broadcast-derived −24,
which reads whisper-quiet on phones; TP stays at ffmpeg's −2 dBTP. ReplayGain
and loudnorm level the same thing by different means and their gains stack if
both are on; both APIs' TSDoc says choose one (tagged files → ReplayGain at
zero DSP cost, untagged → loudnorm).

### 19. Background hardening: persistence is injected, the sleep timer is native, the FGS grace period is a knob
Three answers to the same question — *what happens to a paused, demoted,
killable service?* — added to `media-session` and verified on device
(POCO/Android 16, release build, 2026-08-10).

**Persistence is a tee over the broadcast setters, and takes zero dependencies.**
`withPersistence(service, storage)` wraps `MediaServiceApi`; `storage` is
structural `{getItem, setItem}` — the `wireAudioSession` philosophy (§3), so
AsyncStorage, MMKV and a `Map` all fit and none is depended on. Writes are
triggered by a broadcast, which is already discontinuity-only (§7), and — since
2026-08-27, see decision 3 below — by one JS-side checkpoint per 30 s of
playback. A sync engine is written through synchronously,
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
3. **Discontinuity-only writes have a cost, and it is now paid by a bounded
   timer plus an explicit `save()` — not by `save()` alone.** A track played
   straight through produces no broadcast and therefore no write — device
   evidence: a 42 s play restored as `0:00`.

   **Reversed 2026-08-27.** The original ruling here was "no timer was added and
   none may be", with `service.save()` as the whole answer. That made the
   library's *default* save nothing for the length of a track, which is not a
   defensible default however well documented — the app has to write code before
   the feature works at all. The rule it was defending is narrower than it was
   applied: §7 forbids **streaming position across the bridge** and per-tick
   *native* work. A JS-side checkpoint does neither. `PersistenceOptions.autosave`
   (`{intervalMs?} | false`, default 30 000 ms) re-arms one `setTimeout` while
   the last broadcast said `playing` with a live rate; each tick re-projects the
   anchor the app already broadcast (`value + (now − at) × rate`) in JavaScript
   and writes it. Nothing is read from a player, nothing crosses the bridge —
   the native resumption mirror is deliberately **not** refreshed on a tick, for
   exactly that reason, so it holds the last broadcast's position and is
   refreshed by the next broadcast or `save()`. Cost: one `setItem` per
   interval, two a minute, against at most 30 s of lost position. Intervals
   below 1 s are rejected rather than clamped — below that it *is* the per-tick
   write §7 forbids. Unit-tested with fake timers, including an assertion that a
   tick makes **zero** calls on the native hybrid object.

   What the reversal does not change: **`service.save()` is still required**, and
   for the reason the original ruling half-named. Android stops JS timers once
   the Activity is gone (`JavaTimerManager.onHostPause`), so autosave covers the
   foreground and nothing more. The app still picks the background moments
   (`AppState` leaving `active` — the exact instant the timer stops —
   `onTaskRemoved`, before `stopService`). With `save()` alone the device test
   restored `0:42` across `am force-stop`; autosave is what makes the *foreground*
   case work with no app code at all. Nothing can checkpoint an un-warned kill;
   the position then restores to the last checkpoint, which is never *wrong*,
   only older — and now at most one interval older.

**The sleep timer is native because our own Platform truth says it must be.**
`setSleepTimer/cancelSleepTimer/getSleepTimerRemaining` + an `onSleepTimer`
handler callback. (It later grew `setSleepTimerToTrackEnd()` and a structured
`getSleepTimer()`; both are native for the same reason and are described in §23.) Android uses a main-looper `Handler.postDelayed`, iOS a
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

Six decisions worth the words:
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
4. **Failure is bounded, says which half broke, and no longer waits for the
   deadline to say it.** 10 s covers a React cold start several times over; on
   expiry the report distinguishes "the runtime never started" from "the runtime
   started but `MediaService.init` was never called" — and, since #47, splits
   the second into "the live runtime was asked to re-init and did not" versus
   "nothing could have asked it", because the fixes differ (see decisions 5 and
   6). Not configurable — an app that needs longer has a startup problem no
   timeout fixes. Brownfield (`Application` is not a `ReactApplication`) degrades
   to the old behaviour with one warning.

   **Amended 2026-08-27: the silence in between is itself the bug.** A
   misconfigured resumption used to produce *nothing at all* for ten seconds and
   then a log line, and that log line was the only artefact — the failure was
   reported as `playbackResumptionFailed`, whose delivery is best-effort by
   nature. Two changes. First, a **probe** at `runtimeReady + 3 s` raises a new
   code, `playbackResumptionNotWired` (fatal, Android-raised, present in the
   generated enum on both platforms per the parity gate). That instant is the
   earliest the answer is *knowable*, not merely the earliest it is convenient:
   a `ReactContext` cannot exist before the bundle has been evaluated, so
   module scope has already run and `init` has either been called or never will
   be; 3 s is ~18× the 170 ms the device measurement below spends between
   runtime-ready and `init` complete, and is an allowance for the app's own
   prologue, nothing else. Second, delivery: a handler existing *is* an
   initialized session, which is the very thing whose absence these codes
   report, so neither can ever be delivered at the moment it is raised. Both are
   logged immediately and **held for the next `initialize`**, diagnosis before
   outcome, in a list rather than the single slot that previously existed (which
   would have dropped the diagnosis in favour of the failure). The diagnosis is
   held *on probation*: an `initialize` that arrives before the deadline
   **disproves** it — the call whose absence it reports has just happened — so
   it is discarded rather than delivered, and an app whose own init path is
   merely slow is never accused of not having one. The message decision is a
   pure function (`RevivalDiagnosis`), unit-tested on both arms, including the
   fix string verbatim; the watchdog's existing prose moved there unchanged.
5. **"Module scope" is not enough — init must be reachable through a bare
   side-effect import from the entry file** (bug #47, diagnosed on device
   2026-08-13). Metro's release-mode inline requires (`inlineRequires: true`,
   the RN default since 0.64) rewrites every *binding* import — `import { x }
   from './m'` — into a `require` at the first **use** of `x`; for a binding
   used only inside a component that first use is the first render, which a
   headless revived runtime never performs. The example regressed exactly this
   way: while the playback layer lived at `App.tsx` module scope the entry's
   own import chain kept it eager and §20's timings were real; the card-less
   redesign moved it into `src/playback/` behind `import { usePlayback }`, and
   every cold revival silently became a 10-second watchdog timeout (probe
   bisect: in the revived process only `index.js` executed; the app's module
   graph ran on first render, minutes later, when an Activity finally
   arrived). The fix shape is one line — `import './src/playback'` in
   `index.js` — because a side-effect import has no bindings to defer. The
   watchdog message, the option TSDoc and the README recipe all now state the
   entry-file requirement instead of the weaker "module scope".
6. **A revival into a process that is still alive needs the app's help, and
   `android.onRevivalRequested` is how it asks** (bug #47's second half —
   the owner-reported symptom). `stopService()` ends background execution but
   deliberately keeps the persisted session ("stop is not forget": the record
   outlives the stop by design, §19), so the System UI keeps offering its
   resumption card. Tapping play starts the service into a process whose JS
   runtime is alive — `ReactHost.start()` resolves in ~15 ms — but whose module
   scope, the thing that saves a *cold* revival, already ran and can never run
   again; before #47 the revival then sat silent for 10 s and abandoned
   ("MediaService.init(...) was never called", observed same-pid on device).
   The mechanism: the handlers struct grew `onRevivalRequested`, the one Nitro
   callback `MediaSessionController` retains **across `stop()`** (it exists
   precisely for the after-stop window; every other callback is cleared there
   so nothing can reach a discarded handler). `onRuntimeReady` invokes it; the
   TS layer routes it to the app's `config.android.onRevivalRequested` and
   swallows it unless init is truly idle, so a cold boot whose module-scope
   init is already in flight cannot double-initialize. It dies with the
   runtime (the before-destroy hook clears it by hand — `stop`, which that
   hook also calls, deliberately does not). No auto-re-init fallback from
   memoized `init` args, considered and rejected: every resumption-capable app
   wraps the returned api (`withPersistence` is requirement #2), and a
   library-internal re-init would leave the app's wrapper pointing at nothing
   — the app's own idempotent init path is the only correct re-entry.

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

### 23. Remote-surface parity: one jump interval, repeat/shuffle on both sides, and an honest metadata table
Four `media-session` additions that share one premise — *a knob that behaves
differently per platform is a defect, and a field the OS cannot render is a
gap to state rather than to fake.*

**Jump intervals are one cross-platform option, and fixing them was a bug fix.**
`RemoteCommandBinding.swift` pinned `skipInterval = 15` in both directions while
Android never called `setSeekBackIncrementMs`/`setSeekForwardIncrementMs` and
therefore inherited media3's `C.DEFAULT_SEEK_BACK_INCREMENT_MS = 5_000` /
`DEFAULT_SEEK_FORWARD_INCREMENT_MS = 15_000` (1.11.0, `javap` on the shipped
AAR). The same JS call skipped back 5 s on Android and 15 s on iOS — a
parity-gate violation, not a missing knob. `jumpForwardSeconds` /
`jumpBackwardSeconds` therefore sit at the **top level** of `MediaServiceConfig`,
not under a platform namespace, and default to **15/15** — RNTP V4's and V5's
default, and what the platform where the value was deliberate already did.
Android applies them through `SimpleBasePlayer.State.Builder`, iOS through
`MPSkipIntervalCommand.preferredIntervals`; both platforms still resolve the
increment natively and deliver an absolute `seekTo`, so the handler interface
stays free of relative-seek methods (§the `MediaControl` doc comment). They are
mirrored into `ResumptionStore` too, because a revived service builds its facade
player before any JavaScript exists and that player's increments are what a
notification's fast-forward button resolves against.

**Repeat and shuffle are a capability *and* a control, and the difference is
load-bearing.** `MediaCapability.setRepeatMode`/`setShuffle` put
`COMMAND_SET_REPEAT_MODE` (15) / `COMMAND_SET_SHUFFLE_MODE` (14) on the facade,
which is what makes `SimpleBasePlayer` dispatch
`handleSetRepeatMode`/`handleSetShuffleModeEnabled` at all and what lights up
Android Auto, Wear and third-party controllers. That alone does **not** put a
button in the phone's shade: `DefaultMediaNotificationProvider` draws previous /
play-pause / next and nothing else. So `MediaControl.repeatMode`/`shuffle` were
added as well, drawn with media3's state-dependent icons
(`ICON_REPEAT_OFF/_ONE/_ALL`, `ICON_SHUFFLE_ON/_OFF`) in the *secondary* slots —
never central or back/forward, which belong to transport. The control is spelled
`repeatMode` because a union member becomes a native enumerator verbatim and
`repeat` is a Swift keyword; the same constraint that produced `defaultMode` in
`@rn-media/audio-session`. State rides the existing `playbackState` channel as
two additive, defaulted fields (`'off'` / `false`), and a press is a *request*:
`onSetRepeatMode`/`onSetShuffle` are called and nothing moves until the app
broadcasts — the acknowledge-by-broadcast contract (§9) that also completes
media3's pending-operation future. Both handler methods are optional for the
reason `onSleepTimer` is: this interface is the player-agnostic contract.
iOS uses `changeRepeatModeCommand`/`changeShuffleModeCommand`, whose
`currentRepeatType`/`currentShuffleType` are pushed on every broadcast (both are
`assign`, i.e. readwrite, in `MPRemoteCommand.h` — Apple's docs file them under a
"Retrieving…" heading that reads as read-only and is not).
`MPShuffleType.collections` has no cross-platform twin and is read as "on".

**The sleep timer grew a second mode, and it is still native-first.**
`setSleepTimerToTrackEnd()` is a separate method rather than an option object,
because the two modes take different arguments. A package with no playback engine
can still compute the deadline —
`(duration − projectedPosition) / rate`, both halves already on the broadcast
channels — so it is computed natively and **re-armed on every broadcast**. That
is not a new subscription: broadcasts are discontinuity-only (§7), which means a
seek, a pause, a rate change and a late-arriving duration are exactly the events
that move the deadline. Nothing polls; nothing new crosses the bridge. Two cases
have no computable deadline (live, or a duration not yet broadcast) and one has
no deadline at all (paused); all three leave the timer **armed** and waiting for
the *current item to change*, which fires it — the honest reading of "stop after
this one" and the only thing that makes the feature work on a live stream. The
item is identified by `index:id`, because ids legitimately repeat in a queue and
an index alone moves under a queue edit. `getSleepTimer(): {mode,
remainingSeconds?}` exists because `getSleepTimerRemaining()` cannot distinguish
"armed, deadline unknown" from "not armed", and a timer badge that vanishes is a
bug the old shape made unavoidable.

The latch is **one nullable key, cleared at every exit from track-end mode**
(fire, cancel, a countdown replacing it, `stop`), and both of those words were
paid for. It was first written as a key *plus* a `latched` boolean reset only in
`stop()`, which let the pair drift: a fired timer left `latched = true` with a
stale key, and because `armAtTrackEnd()` marks the mode armed **synchronously**
on the JS thread while the re-latch is only posted to main, a broadcast block
already queued on the looper could run in between, compare the current item
against an item from the previous session, read "the item changed" and pause
playback *at the instant of arming*. The synchronous arm stays — it closes the
opposite race, where a broadcast racing an arm would be ignored as "not armed" —
so the fix is on the stale side, and collapsing two fields into one makes
half-reset unrepresentable rather than merely unlikely. The decision itself
(`trackEndAction(latchedKey, currentKey) -> Fire | Wait(latchTo)`) is a pure
function in `Snapshot.kt`, unit-tested on the JVM including that regression;
what stays in the controller is a `Handler` post and a `when`, which is the part
that genuinely needs a device. iOS mirrors it as `TrackEndAction.next(latched:
current:)` in the same shape, deliberately, because the two platforms diverging
on the one branchy part of the feature is the bug class this package exists to
prevent. One case is left alone and is benign by construction: re-arming while a
track-end timer is *still* armed keeps the old latch for the gap, and that latch
is necessarily current — had the item changed, the retarget would already have
fired and cleared it.

**Metadata gained seven fields and one honest table.** `albumArtist`,
`trackNumber`, `discNumber`, `year`, `subtitle`, `isLive` and `extras` map onto
media3 `MediaMetadata` in full. iOS renders three of them:
`MPNowPlayingInfoCenter` documents a *subset* of `MPMediaItem` keys, and while
`AlbumTrackNumber` and `DiscNumber` are on it, **there is no year key at all**
(the only date-shaped key is an `NSDate` and is not on the list), **no third
display line**, and **no arbitrary-payload key**. Those three are carried through
the session and through persistence — the app gets them back — and are simply not
published, rather than being folded into `artist`/`album` the way the ecosystem
usually does, which would corrupt two fields the app also sets. `albumArtist` is
sent despite being off the documented list, because the key is real, unknown keys
are ignored, and some surfaces read it — with no promise attached. `extras` is
string→string precisely because its two destinations are an Android `Bundle`
crossing a binder and a JSON round trip.

**`notificationColor` needed a provider decorator, not a builder call.**
`DefaultMediaNotificationProvider.createNotification` is `final` in media3 1.11
and its `Builder` offers channel id, channel name, notification id and small icon
— no colour. A `MediaNotification.Provider` that delegates and then sets
`Notification.color` on the result is the only public lever, and setting it after
the build is what makes it stick. Stated as a *hint*: Android 12+ media
notifications derive their palette from the artwork and may ignore it.

**`ios.supportedPlaybackRates` is namespaced, and the asymmetry was checked.**
`MPChangePlaybackRateCommand.supportedPlaybackRates` is a fixed list iOS snaps
the user's choice to. Nothing on the Android side takes a list: media3's speed
lever is `COMMAND_SET_SPEED_AND_PITCH` → an arbitrary float, its notification
draws no rate control, and `javap` over the shipped 1.11.0 AARs finds no
supported-rates API anywhere. So this is a platform fact, not a missing mapping,
and it lives under `ios` for the same reason `playbackResumption` lives under
`android` — the shape of the config should say which platform can honour it.

**The persisted schema went to 2.** Both channels gained fields, and the reader
that matters is `ResumptionStore` in a process with no JavaScript, which can only
check the version. `unsupportedVersion` — "I will not guess" — costs one
session's resumption card, which the next broadcast rewrites, and buys never
silently restoring a session with shuffle off because the record could not say
otherwise. `SchemaVersionSyncTest` still fails the Android build if the TS writer
and the Kotlin reader drift.

### 24. Prefetch status is a hook, and its clearing set is closed over existing events
`usePrefetchStatus(player)` (2026-08-13) reduces the discrete `prefetchStarted`
event into renderable state — `{ active: false }` or
`{ active: true, uri, entryId?, at }`, a discriminated union so `uri` only
exists where it means something. Deliberately **not** a `PlayerState` field:
only debug/status surfaces read it, and a snapshot field would drag its
clearing rules into the reducer and onto every subscriber. The clearing set is
exactly three existing events, chosen for what they mean and written down so
nobody "fixes" them: `trackChanged` (the boundary arrived — the prefetch was
either consumed gaplessly or dropped by a queue edit, and `stop()` lands here
too via the cursor moving to −1), `error` (the player gave up), and
`queueEnded` (a natural end with nothing following, the one boundary
`trackChanged` does not cover). Deliberately *not* cleared on `seekStarted` — a
scrub within the current track does not invalidate the next entry's open
demuxer — and not on `retrying`, because the warm next entry survives a
re-attempt of the current one. No native surface was added: the hook rides
`Player.on`, and on binaries without the fork's prefetch hook it simply never
leaves idle — the same "an event that does not happen is not a failure" honesty
the event itself documents. The example app's banner now consumes this hook;
the hand-rolled engine→controller→UI plumbing it replaced is gone, which is the
point of the example.

### 25. Casting is a URL handoff behind the existing fan-out — and the handoff lives in `@rn-media/cast`, not media-session

**The decision** (2026-08-13, design in `docs/design/cast.md` — this section
records what shipped and why it is shaped this way). Cast receivers fetch and
decode URLs themselves; mpv's pipeline is invisible to every OS casting hook,
so casting can never be an *output route* for our engine. It is a **handoff**:
pause mpv, hand the receiver a URL queue, mirror the receiver's state, and
take playback back at the receiver's position when the session ends. The old
PLAN deferral ("CastPlayer abandons our engine") died on exactly this
reframing — nothing is abandoned; the engine is paused.

**The state machine** (cast.md §3, implemented verbatim as a pure reducer —
`reduceCastHandoff` in `packages/cast/src/handoff-machine.ts`):

```
LOCAL → CONNECTING → HANDOFF_TO_CAST → CAST_ACTIVE → HANDOFF_TO_LOCAL → LOCAL
                     (pause mpv · snapshot {queue,index,position,playWhenReady}
                      · load receiver queue at index/position)
any → error → typed error + fall back to LOCAL at last known position
```

The reducer is pure — `(state, event) → {state, effects}`, no clock (events
carry timestamps), no promises — which is what makes every transition and
every error fallback unit-testable without a receiver on the LAN; it is the
best-tested code in the package on purpose (the handoff *is* the hard 20% of
cast). `wireCastHandoff` executes the effects against the `CastApi` and a
structural local player, and feeds completions back in as events. Both the
in-app path (`castTo(deviceId)`) and the platform paths (cast dialog, Android
13+ system output switcher) funnel into the same machine: a session appearing
from anywhere triggers the same handoff.

**Where it lives, and why.** In `@rn-media/cast` — **`media-session` is
cast-free in both directions.** The media-session package's value is that it
works with ANY player; teaching it about cast would have coupled it to one
remote backend and doubled its test surface. Instead the handoff takes
structural interfaces (the `AudioSessionPlayerLike` discipline): a local-player
write surface (`play/pause/seekTo/skipToIndex/getPosition/isPlaying`), a
queue-snapshot provider, and event outputs the app routes into its own
broadcasts. media3's `CastPlayer.Builder().setLocalPlayer(...)` wrapper was
declined for the same reason it was declined in the design doc: it would put
the handoff inside media3 on Android while iOS needs our machine anyway — two
architectures to keep in parity, and `transferState` would have to write into
`BroadcastPlayer`, which is a broadcast facade, not a stateful player.

**The channel contract while casting (§3 of the design, the load-bearing
part).** During CAST_ACTIVE the app's broadcasts carry the **receiver's**
state through the same three channels (`playbackState`, `mediaItem`, `queue`)
that feed every surface — notification, lock screen, watch, the app's own UI.
Zero new fan-out paths: the example's `SessionBridge.publishCast` maps the
handoff's receiver snapshot into `setPlaybackState`/`setMediaItem` and
suppresses local publishes for the session (the local player is deliberately
paused; its snapshot is not news). Position obeys the library-wide rule
unchanged: a cast `mediaStatus` is a discontinuity broadcast carrying an
anchor `{position, at, rate}`; everything projects locally; nothing polls.
**Position ownership is exclusive** — exactly one backend owns the clock at
any time, and the two `castTransfer` events (`toCast`, `toLocal`) are the
discontinuities where ownership moves. Fan-in mirrors fan-out: the example's
controller forwards every transport command to whichever backend owns
playback, so a notification button steers the receiver with no extra wiring.

**Queue: JS is the source of truth; the receiver holds a projection.**
The handoff filters the queue through `canCastMedia` (receiver codec table +
local-file + header-auth rules), loads the castable projection with
receiver-side advancement (`autoplay` per item — the queue survives the phone
sleeping), and surfaces every skipped item with a typed reason — never
silently. Every `mediaStatus` is reconciled back to a JS index through the
`itemIds ↔ jsIndices` mapping the machine owns; queue edits while casting
reload the projection anchored at the receiver's current item and projected
position (`syncQueue`). The receiver queue dying with the session is fine —
it is rebuilt from the JS queue on the next handoff. Signed-URL expiry
mid-session is the same seam as the player's source resolver: a
`cast-receiver-fetch` error → re-resolve the URL into the snapshot →
`syncQueue()` (the example implements the recipe, bounded to one automatic
attempt per track).

**Platform truths (Android, found on hardware — POCO F4 (AOSP custom ROM) +
Mi Smart Speaker, device rounds 2026-08-13; every item below was measured,
not read about):**

- **`MediaQueueData.Builder.setStartTime` does not deliver a start
  position.** Whatever was written there, the receiver began at 0:00 — the
  owner-reported "starts from the beginning" bug. The wire-level
  `queueData.startTime` is documented in *seconds* on the Web Receiver while
  the builder takes a `long`, and the Default Media Receiver
  ignored/clamped everything we sent through it. The fix is the classic
  `RemoteMediaClient.queueLoad(items, startIndex, repeatMode,
  playPositionMs, customData)` — milliseconds, honored exactly, and the
  call media3's `CastPlayer` ships on. (When credentials force the
  `MediaLoadRequestData` path, the start position rides on the start ITEM —
  `MediaQueueItem` times are seconds — with the documented stickiness
  caveat.)
- **The receiver's first non-idle status arrives before it applies the start
  position** (buffering at 0.0 s for a 42 s handoff). The machine floors the
  completing anchor/transfer at the projection's `startPosition` for the
  start item; later statuses carry real clocks and correct it within one
  update.
- **The sender-side `MediaQueue` mirror populates *after* the `queueLoad`
  ack.** Item ids read together with the ack are routinely empty, which
  killed the itemId↔JS-index mapping: every receiver jump rejected
  `invalid-argument` while playback ran fine. The fix is structural, not a
  sleep: the orchestrator re-reads the ids on every native `queueChanged`
  and the machine adopts any non-empty read (`queueItemIds` event); an empty
  read never clears known ids.
- **A `queueLoad` issued against a just-REJOINED session can hang forever** —
  PendingResult never settles, no error, machine stuck in `handoff-to-cast`.
  Two-part fix: `attach()` primes the media channel with `requestStatus()`
  (exactly what media3's CastPlayer does on session-available), and
  `wireCastHandoff` bounds the phase with `handoffTimeoutMs` (default 15 s)
  → typed `load-failed` → fallback to LOCAL at the pre-handoff snapshot. An
  honest error, never a hang.
- **`setStopReceiverApplicationWhenEndingSession(true)` overrides
  `endCurrentSession(stopCasting = false)`** — logcat showed
  `stopApplication` on a false-parameter end. Deeper ceiling underneath:
  with the option false, and even via
  `MediaRouter.unselect(UNSELECT_REASON_DISCONNECTED)`, **the GMS sender
  stack still stops receiver playback whenever its session ends** — while
  the same receiver demonstrably keeps playing when a bare CastV2 sender
  (pychromecast control test) disconnects. "Disconnect and keep playing" is
  therefore not achievable through play-services-cast-framework 22.3.1; the
  API documents what `transferBackToLocal: false` still honestly delivers
  (no local resume; receiver app left to idle out).
- **The transfer-back restore has an mpv race** (example-layer truth): a
  `playlist.jumpTo` resolves when the command is ACCEPTED, not when the
  entry is open, so a seek issued against the still-`ready` pre-jump
  snapshot is rejected mid-reload (`error running command`) and the whole
  restore used to land paused at 0:00. Rules that fix it structurally:
  never reload the entry already current; after a real jump, wait until the
  state SHOWS the target open (`index === target` + settled status); retry
  a rejected seek once on a FRESH state change only.
- **Kotlin `Promise.reject(Throwable)` reaches JS class-prefixed**
  (`"java.lang.IllegalStateException: [no-session] …"`) — an anchored
  `^\[code\]` match silently reclassified every typed native rejection as
  `native` and broke the `no-session` filters. `toCastError` matches the
  marker anywhere in the message.
- **`REPLACED` (2103) is not a failure.** The notification's seek bar fires
  two seeks milliseconds apart; the older command's `PendingResult` fails
  with REPLACED even though the seek landed. The Kotlin bridge resolves it.
- **Hardware volume keys drive the receiver through
  `MediaService.setRemotePlayback`, which is a media-session feature with no
  idea cast exists — always in the foreground, and with the screen off only
  while no system-uid sound has played since our last local audio**
  (2026-08-14; corrected 2026-08-15 by bug #53, whose entry below states the
  platform rule precisely. This replaces the foreground-only `dispatchKeyEvent`
  workaround that used to be documented here, and the workaround is deleted —
  restoring it would not help, because the foreground path is the one that
  already works.)

  The starting point was real: this library disables the Cast framework's own
  MediaSession (the media-session package owns the app's session — the fan-out
  contract), and that framework session is exactly what would otherwise have
  carried volume keys to the receiver. The fix is not to re-enable it but to
  make **our** session the one the platform routes to.

  The mechanism, verified against the shipped media3 1.11.0 AARs and the
  platform source rather than remembered:
  - The app publishes `setRemotePlayback({ volume, muted })` — normalised
    `0..1`, plus an optional `steps` (default 20, media3's own
    `RemoteCastPlayer.MAX_VOLUME`) and `volumeControl`
    (`absolute`/`relative`/`fixed`).
  - `BroadcastPlayer` turns that into `SimpleBasePlayer.State`'s
    `setDeviceInfo(PLAYBACK_TYPE_REMOTE, max = steps)` + `setDeviceVolume` +
    `setIsDeviceMuted`, and advertises `COMMAND_GET_DEVICE_VOLUME` plus the
    set/adjust commands the control type implies.
  - media3's `MediaSessionLegacyStub.ControllerLegacyCbForBroadcast
    .onDeviceInfoChanged` rebuilds a `VolumeProviderCompat` from those
    commands and calls `MediaSessionCompat.setPlaybackToRemote(provider)`
    (`createVolumeProviderCompat` returns `null` — and the stub calls
    `setPlaybackToLocal` — for a `PLAYBACK_TYPE_LOCAL` `DeviceInfo`, which is
    why an app that never publishes a remote device is untouched).
  - The platform's own contract is the whole feature:
    `android.media.session.MediaSession.setPlaybackToRemote` — *"Configure
    this session to use remote volume handling. This must be called to receive
    volume button events, otherwise the system will adjust the appropriate
    stream volume for this session."* Because it is on the **session**, it
    works with no Activity alive.
  - A key press arrives as `VolumeProvider.onAdjustVolume(±1)` →
    `Player.increase/decreaseDeviceVolume(flags)` →
    `handleIncrease/DecreaseDeviceVolume` → the TS layer, which converts the
    notch to a level for an `absolute` backend (`onSetDeviceVolume`) or passes
    the direction through for a `relative` one (`onAdjustDeviceVolume`). The
    routing is decided by the app's declared `volumeControl`, **never** by
    which handler methods happen to be defined — every app that extends
    `BaseMediaHandler` inherits both, so presence-sniffing would have made the
    keys silently dead for the common case.
  - Going back to local needs no undo: publishing nothing restores
    `State.Builder`'s own `DeviceInfo.UNKNOWN`, media3 calls
    `setPlaybackToLocal`, and the keys move the phone's stream again. Measured:
    no stuck remote volume.

  **Device evidence** (POCO F4 on its AOSP ROM — Android 16 / API 36 — and a
  Mi Smart Speaker). Every row states **how it was verified**, because bug #53
  was shipped on the strength of a row that did not say so. The vocabulary:

  - *injected* — `adb shell input keyevent`. For the **screen-off** case this
    is a valid probe of the platform's routing *decision*: measured on this
    device, an injected key and the owner's physical press produce the same
    `MediaSessionService: dispatchVolumeKeyEvent … pkg=android, uid=1000,
    musicOnly=true` line, because with the screen off both are delivered by
    `PhoneWindowManager`, not by a window. It is **not** valid for the
    foreground case, where a real press is passed to the focused window and an
    injected one is not.
  - *physically measured* — a human pressed the rocker and the effect was read
    out of `dumpsys`/logcat afterwards.
  - *owner-observed* — a human pressed the rocker and listened. No instrument.

  The instrumented readouts are: the phone's own level from `dumpsys audio`'s
  `STREAM_MUSIC streamVolume`; the receiver's level from the session's
  `volumeType=REMOTE … current=` in `dumpsys media_session`, which is fed by
  the receiver's own `deviceVolume` events, so it is the receiver talking, not
  us echoing ourselves.

  | case | phone stream | receiver | JS handler | how verified |
  | --- | --- | --- | --- | --- |
  | casting, **foreground**, physical press | unchanged | moves | — | *owner-observed* (2026-08-14) — and it is the one case that cannot break, see the rule below |
  | casting, app backgrounded, 3× VOL_UP | 5/25 → **5/25** | 5/20 → **8/20** | `onSetDeviceVolume(0.30, 0.35, 0.40)` | *injected* (2026-08-14) |
  | casting, screen off, 3× VOL_DOWN | 5/25 → **5/25** | 8/20 → **5/20** | `onSetDeviceVolume(0.35, 0.30, 0.25)` | *injected* (2026-08-14) — **true only when the precondition below holds; this row is what made #53 look fixed** |
  | casting, screen off, physical press, session REMOTE + PLAYING | 5/25 → **5/25** | 8/20 → **5/20** | — | *physically measured* (2026-08-15, owner's press): `Adjusting com.rnmediaplayerexample/…/767 by -1 … preferSuggestedStream=false` |
  | casting, screen off, **after a system-uid sound** | unchanged | **unchanged** | **never called** | *injected* (2026-08-15), 3 consecutive: `Ignoring session=…/767 and adjusting suggestedStream=-2147483648 instead` → `Nothing is playing on the music stream. Skipping volume event` |
  | after transfer back, backgrounded, 3× VOL_UP | 5/25 → **8/25** | session is `volumeType=LOCAL` | none | *injected* (2026-08-14) |

  **The rule the platform actually implements** (`android16-release`,
  `MediaSessionService.dispatchAdjustVolumeLocked`, the single site that logs
  `Ignoring session=`; byte-identical in `android15-release` and `main`):

  ```java
  if (session != null && session.getUid() != uid
          && mAudioPlayerStateMonitor.hasUidPlayedAudioLast(uid)) {
      if (Flags.adjustVolumeForForegroundAppPlayingAudioWithoutMediaSession()) {
          // The app in the foreground has been the last app to play media locally.
          // Therefore, We ignore the chosen session so that volume events affect the
          // local music stream instead. See b/275185436 for details.
          session = null;
  ```

  With the screen off the caller is `PhoneWindowManager`, so `uid` is **1000
  (system_server)** — logcat says `pkg=android, uid=1000` for both injected and
  physical presses. The guard therefore reduces to *"was a **system** sound the
  last locally-played audio?"*. If yes, our correctly-selected remote session is
  discarded; the fallback then runs with `musicOnly=true`, and because a cast
  plays nothing on the local `STREAM_MUSIC`
  (`AudioSystem.isStreamActive(STREAM_MUSIC, 0) == false` — a Cast session opens
  no local output), the key is **dropped entirely**: the receiver does not move
  and neither does the phone. Silent, total, and exactly the owner's report.

  Three source facts make it stick rather than flicker
  (`AudioPlayerStateMonitor`, byte-identical across 15/16/`main`):

  - `hasUidPlayedAudioLast(uid)` is `uid == mSortedAudioPlaybackClientUids.get(0)`,
    and `dump()` prints that exact list — so **the first `uid=` line under
    "Audio playback (lastly played comes first)" in `dumpsys media_session` is
    the value the guard compares against.** That is the one-command diagnostic.
  - `cleanUpAudioPlaybackUids()` walks from the tail and `break`s at the media
    button session's uid, so it can **never** remove index 0.
  - A casting app registers no local `AudioPlaybackConfiguration`, so it can
    never displace the head by playing.

  Which is why **the foreground case cannot break**: `PhoneWindow` routes a
  press through `dispatchVolumeKeyEventToSessionAsSystemService(event, token)`,
  which targets the session *by token* and never reaches this heuristic. The
  asymmetry the owner reported — foreground fine, screen off dead — is the
  shape of this bug, not a coincidence.

  The escape hatch is in the same file, and is what we shipped: when the head
  uid goes **inactive**, `onPlaybackConfigChanged` promotes the first
  still-**active** uid to index 0. An app that keeps a local audio player
  active for the duration of the handoff therefore reclaims the head on its own
  as soon as the interfering sound ends. Nothing else in the public API moves
  that list.

  **The fix: `RemotePlayback.holdLocalAudioSlot`, opt-in and OFF by default**
  (owner decision, 2026-08-15). `LocalAudioSlot` holds a silent, looping,
  zero-filled `AudioTrack` (`USAGE_MEDIA`, `MODE_STATIC` with
  `setLoopPoints(…, -1)` so there is no writer thread and no periodic wakeup,
  `PERFORMANCE_MODE_POWER_SAVING`) for exactly as long as a remote device is
  published — started in the same `setRemotePlayback` hop that publishes it,
  released in the hop that clears it and in every session teardown, so it can
  never outlive the cast. It takes **no audio focus** (an `AudioTrack` never
  requests any) and never touches the engine: mpv stays paused through the
  handoff exactly as §25 has always said.

  It is off by default for three reasons worth recording, because the easy
  choice was to default it on:
  - It keeps a real output — and the audio HAL — awake for the whole remote
    session. That is measurable battery for a feature the user only notices
    when they reach for the rocker.
  - It contradicts this section's own "the engine is paused, nothing is
    producing audio" framing. An app should opt into that contradiction
    knowingly rather than inherit it.
  - We refused the equivalent silent-audio trick on iOS. Shipping it on by
    default here would be an inconsistency we would have to defend.

  And it *changes* the residual failure mode rather than only removing one:
  with the slot held, `isStreamActive(STREAM_MUSIC)` is true, so if the session
  is discarded for the other documented reason (playback not PLAYING) the key
  now moves the **phone's** volume instead of doing nothing. Both behaviours
  are documented on the option. The example app opts in, because it exists to
  demonstrate the library at full capability.

  **What #53 teaches about evidence.** The screen-off row above was true when
  it was measured and false an hour later, and nothing about the measurement
  said which. The methodological fix is the "how verified" column, plus this:
  *a single sample never establishes an intermittent property.* The failing
  runs here were found only because a probe kept pressing while unrelated state
  moved underneath it.

  **Closed 2026-08-27 by the only evidence that settles it.** The owner pressed
  the physical rocker with the screen off during a cast session on the POCO F4
  and the receiver's volume moved. The README's "under investigation" entry is
  gone; the rows above stand as the record of how an injected key almost made
  a working feature look broken and a broken measurement look like proof.

  **Platform truth found on the way, worth recording because it reads exactly
  like a failure: Android only routes volume keys to a session that is
  actually PLAYING.** A first attempt looked like the feature was broken —
  `MediaSessionService: Adjusting … session=null` in logcat and the phone's
  stream moving — while `dumpsys media_session` showed our session correctly
  as `volumeType=REMOTE, controlType=ABSOLUTE, max=20`. The receiver had gone
  to PAUSED. With playback live the same dispatch logs
  `Adjusting com.rnmediaplayerexample/androidx.media3.session.id./702 by 1`.
  So the remote routing is conditional on playback being active, not on the
  session merely existing.

  **Second truth, an app-layer one the example now encodes:** the Cast
  framework **resumes** an existing session at `CastContext` init, so the
  `castState → connected` transition — where the example primed its volume
  readout — never fires, and the `deviceVolume` stream only reports *changes*.
  The session then sat at `volumeType=LOCAL` for the whole cast. The example's
  `#publishRemote` now reads the level on demand (once, guarded) whenever
  ownership moves and the volume is unknown.

  **iOS is a genuine ceiling, and stays one.** `setRemotePlayback` is accepted
  and does nothing there. iOS gives an app no way to take over the hardware
  volume buttons: `MPRemoteCommandCenter` has no volume command,
  `AVAudioSession.outputVolume` is read-only (and observing it can neither
  suppress the system HUD nor stop the phone's own volume moving),
  `MPVolumeView` renders the *system* slider, and `AVRoutePickerView` is
  AirPlay — a mechanism the OS owns precisely because an AirPlay target is a
  *route*, which a Cast receiver is not. Google's own SDK says the same about
  its own hook: *"Due to changes in iOS, controlling the volume of a Cast
  session using the physical volume buttons is currently not supported for
  iOS 15+. We are exploring alternatives to restore this functionality in a
  future release."*
  (https://developers.google.com/cast/docs/ios_sender/integrate, read
  2026-08-14; the 4.7.0 release note that says the feature was "restored" is
  older than that sentence). The honest iOS answer is the in-app slider, which
  is what Google's own iOS cast apps do — so this is a platform asymmetry we
  state rather than a fake symmetry we ship.
- **The receiver pushes a media status roughly every 3 s while playing.**
  Each is a genuine position-anchor discontinuity and flows through
  `setPlaybackState`; the `mediaItem` channel is signature-gated in
  `publishCast` so metadata/artwork are not re-broadcast per status.
- **mpv normalises `file://` URIs to bare paths** before handing them back
  through the playlist — any app joining queue rows by URI must compare with
  the scheme stripped (the example's `matchTrack` does now).

**Live-casting truths (device round 2026-08-14 — the "casting a live station
loads forever" bug, plus "every queue tap fails", both owner-reported and
reproduced on the same hardware):**

- **A nonzero start position wedges an unseekable live stream receiver-side.**
  `queueLoad` with `playPosition = 29 000 ms` against the Icecast entry left
  the Default Media Receiver BUFFERING at 29.0 s forever (control-tested with
  a bare CastV2 sender: same URL with no position → PLAYING in under two
  seconds; with `currentTime=29` → wedged). HLS live self-corrects eventually
  (the receiver clamped a 29 s request to the live window — after flapping
  through the wrong queue item first). mpv's clock on a live stream is a
  stream-timeline offset anyway (FIP reported ~95 000 s), so the number was
  never a resumable position. The machine's rule: **a live start item always
  loads with `startPosition 0`** (`projectCastQueue` + the resync anchor),
  which is "join the live edge" — the only correct live semantics.
- **A live transfer-back must not seek mpv.** The receiver's live position is
  that same timeline offset; the old restore seeked FIP to 95 520 s and mpv
  answered `Cannot seek in this stream` (twice — the retry). The `restoreLocal`
  effect now carries `live`; the wire skips the seek and reopening at the live
  edge IS the resume. The `castTransfer` event still reports the projected
  clock — a truthful discontinuity, just not a seek target.
- **The Default Media Receiver never starts an HLS playlist URL that answers
  with a 302.** The Vividh Bharati entry's host redirects every path under its
  prefix to the playlist's CloudFront URL; casting it left the receiver IDLE
  forever, while handing it the redirect *target* played immediately. mpv
  follows the redirect fine — the asymmetry is the receiver's. Resolving
  redirects into receiver-playable URLs is the sender's job, at the same seam
  where a real app resolves signed URLs (`castUrlOf`'s override map in the
  example).
- **MIME and segment format were NOT the problem** (worth recording because
  they are the usual suspects): `audio/aacp` plays the Shoutcast stream as-is
  and `application/x-mpegurl` plays both HLS entries (TS/AAC segments) with no
  `hlsSegmentFormat` hint — all control-tested on the receiver directly. The
  22.3.1 AAR does ship `MediaInfo.Builder.setHlsSegmentFormat` +
  `HlsSegmentFormat` (`aac|ac3|e-ac3|fmp4|mp3|ts|ts_aac`, javap-verified) if a
  future stream needs it; the binding deliberately doesn't surface what no
  entry needs.
- **A command against a dead receiver media session hangs its PendingResult
  indefinitely.** A `queueJumpTo` into the redirecting live entry killed the
  receiver's media session; the jump's PendingResult settled — CANCELED
  (2002) — only when the session ended FOUR MINUTES later, so every queue tap
  "silently did nothing" until a burst of stale errors at disconnect (the
  owner's exact screenshot). Every bridged `PendingResult` is now bounded at
  10 s via `setResultCallback(callback, timeout, unit)`; the timeout delivers
  `CastStatusCodes.TIMEOUT` (15) → a typed error in seconds, never a silent
  hang.
- **The real→null media-status transition used to be dropped.** When the
  receiver's media session dies, `onStatusUpdated` fires with a null
  `MediaStatus`; the bridge emitted nothing and the phone showed the last
  "playing" anchor for minutes. The controller now synthesizes one
  `idle`/`interrupted` status for exactly that transition (gated on a real
  status having been seen — a fresh session's null is just "nothing loaded
  yet"). Machine-side rule that pairs with it: **a non-`finished` idle keeps
  the projected anchor** rather than adopting the zeroed clock, so the
  broadcast and a later transfer-back keep the position playback actually
  died at.

- A session can exist before JS wires anything (framework session resumption
  runs at `CastContext` init). The handoff deliberately does NOT auto-cast
  over it — destructive at app launch — and reuses it on the next `castTo`.
- This phone carries TWO cast route providers (stock GMS and a
  `app.revanced.android.gms` microG fork), and their route churn can end a
  session unsolicited — observed correlated with screen-off. The machine's
  design absorbs it: unsolicited `sessionEnded` restores LOCAL at the
  projected receiver position, and the framework's `resumed` event re-runs
  the handoff from the restored snapshot, so a flap costs a beat of silence,
  not the listening position.
- **Both providers publish the SAME device with the SAME deviceId — and
  selecting the foreign twin makes every connect fail at the socket**
  (2026-08-14, the day casting "just stopped working"). `requestSession`'s
  route lookup matched by deviceId with `firstOrNull`, so which provider's
  route won was an enumeration race: when the microG twin won, stock
  CastService failed with "Cast socket status code 2251/2283" on every
  attempt (the fork logs `CastMediaRouteController: unimplemented Method:
  onSelect`) while ReVanced YouTube — which rides the microG stack — cast
  happily to the same speaker, a perfectly misleading symptom. Fixed in
  `CastController.requestSession`: among deviceId matches, prefer the route
  whose provider package is `com.google.android.gms` (the package the
  framework itself lives in); fall back to any match. Environmental red
  herrings eliminated on the way, recorded so nobody chases them again: a
  full speaker reboot, a GMS force-stop and the `NEARBY_WIFI_DEVICES` appop
  all changed nothing; the route preference fixed it on the first try.
- The connect-ordering rule (connect after the picker closes, *before*
  `stopDiscovery`, or MediaRouter drops the route mid-handshake) is encoded
  natively (deferred discovery teardown while a start is in flight) AND kept
  visible in the example's `connect()`.
- Cast on GMS-less Android is a typed `'unavailable'`, never a crash; the
  example's Cast section renders that state honestly with zero dead controls.
- The example carries a deliberate `file://` queue entry: mpv plays it, no
  receiver ever can (receivers fetch URLs themselves) — the on-device truth
  behind `canCastMedia`'s `local-file` verdict and the skip-notice path. Its
  broken-URL sibling (`https://127.0.0.1:9/...`) is *castable on paper* and
  fails on the receiver — the live demo that the receiver's network is not
  the phone's (`cast-receiver-fetch` is its own error family for exactly
  this).

#### `<CastButton/>` is a real native view, because the switcher is unreachable otherwise

The headless `requestSession()` path is complete and stays supported (apps
with their own picker are a first-class story). The **view** exists for one
thing the headless path cannot do: on Android,
`CastOptions.setShowSystemOutputSwitcherOnCastIconClick(true)` is only
consulted from a `MediaRouteButton` that `CastButtonFactory` set up. Verified
in the shipped artifacts rather than the docs —
`MediaRouteButton.showDialog()` branches on
`MediaRouterParams.isOutputSwitcherEnabled() && MediaRouter.isMediaTransferEnabled()`
into `SystemOutputSwitcherDialogController.showDialog(context)`, else into
the in-app `MediaRouteChooserDialogFragment`. So the button is what turns
"cast" from an in-app dialog into the sheet users already know. On iOS the
equivalent is `GCKUICastButton` with its default
`triggersDefaultCastDialog`, which is also the SDK's local-network permission
choreography (discovery starts on first tap, never earlier).

- **Nitro Views, not classic Fabric codegen.** `react-native-nitro-modules`
  0.36.5 ships `HybridView`/`getHostComponent` and nitrogen generates the
  ShadowNode, ViewManager and `.mm` component; the floor is RN 0.78 + new
  arch (we are on 0.87.0, new-arch-only) and the cast module's CMakeLists
  already carried the required `-DRN_SERIALIZABLE_STATE=1`. Choosing Fabric
  codegen instead would have meant a second, parallel codegen story inside
  one package for no capability gained.
- **The button hides itself while `castState === 'unavailable'`**, because
  `MediaRouteButton` no longer hides itself: `setAlwaysVisible` is a no-op in
  mediarouter 1.8.0-beta01 and no code path in the class touches visibility.
  The Design Checklist rule therefore has to be ours, and it is automatic
  rather than a prop every app would forget.
- **`tintColor` reaches parity by painting, not by theme.** iOS sets the
  button's `tintColor`. Android's `MediaRouteButton` reads `mediaRouteButtonTint`
  from the theme once in its constructor and exposes no per-instance setter,
  and `setRemoteIndicatorDrawable` would mean shipping our own copy of
  Google's icon (losing the connecting animation, and breaking the checklist's
  "use the standard icon"). So the subclass draws `super.onDraw` into an
  offscreen layer and paints the tint through it with `SRC_IN` — the
  framework's own icon, in the app's colour, on both platforms.
- **Not a `RecyclableView`**: a recycled button would keep its
  `MediaRouteButton` bound to the Activity of its first surface, and that
  Activity is what the pre-Android-13 chooser is shown from.
- Device-verified end to end (POCO F4, Android 16, framework 22.3.1): the
  button renders and tints, a tap opens the system output switcher (logcat:
  `MediaRouterProxy: media transfer = true, session transfer = true, transfer
  to local = true, in-app output switcher = true`), and picking the Bedroom
  speaker starts a session the `wireCastHandoff` machine runs on its own —
  the example's transfer note reported the round trip with no app code
  involved in starting it.

### 26. `AVAudioSession` has exactly one owner, and it is not the engine

`@rn-media/player` sets **`audiounit-skip-session-management=yes`** on Apple
platforms (`MpvClient::initialize`, `kAppleOnlyDefaults`), so `ao_audiounit`
never touches the process-wide `AVAudioSession`. Ownership belongs to
`@rn-media/audio-session` — categories, modes, route sharing policy,
activation, interruptions, route changes — which is the same split Android
already has, where this player requests no audio focus and `audio-session`
requests all of it. iOS was the odd one out only because mpv did it silently.

**The option is ours and always was.** Our fork's patch 007
(rn-media-engine `patches/007-mpv-audiounit-shared-session`) added
`--audiounit-skip-session-management` for exactly this, and its own docs name
`packages/audio-session` as the intended owner: "two owners is worse than
either… The option lets the engine defer to it." We shipped the mechanism four
generations ago and never turned it on. Nothing in the engine needed changing;
the defect was entirely on this side of the pin.

**What two owners actually cost.** Stock `ao_audiounit` configures the session
in `init()` — category, mode, active state, preferred channel count — and
`init()` runs on **every AO open**, i.e. at every playback start, not once. So
the engine always configures *last* and the host always loses. Worse, mpv calls
`setCategory:withOptions:error:`, the variant that cannot carry a route sharing
policy, so the `.longFormAudio` policy `audio-session` sets is reset to
`.default`, and the mode is forced to `.moviePlayback`. Read off the shipped
`Mpv.framework` rather than from source: `nm -u` lists
`_AVAudioSessionCategoryPlayback` and `_AVAudioSessionModeMoviePlayback`, the
selectors present are `setCategory:withOptions:error:`, `setMode:error:`,
`setActive:error:`, and the policy-carrying setter appears **zero** times.

**The symptom that found it.** No Lock Screen / Control Center card on iOS,
with `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` both provably
correct — MediaRemote logs show `nowPlayingInfo` arriving with real metadata and
`PlaybackRate = 1`, commands bound, and
`MRMediaRemoteSetCanBeNowPlayingForPlayer … set to YES` — while CoreAudio
refused the output client on every audio start:
`AQIONode.cpp:693 … is NOT Now Playing eligible`. This is also the first defect
found by an actual on-device iOS run (2026-08-16); CI never plays audio, which
is precisely why four generations of shipped-artifact verification did not
surface it.

**Honest verification status.** The ownership defect and the clobber mechanism
are proven from the shipped binary and are fixed here. That mpv's session
configuration is the *sole* cause of the missing now-playing card is NOT yet
proven: the iOS Simulator's `AVAudioSession` is a shim
(`AVAudioSessionImpl_Simulator.mm`) and reports the client ineligible whether or
not the option is set, so the simulator cannot confirm it. Device confirmation
is required before this section may claim the card is fixed.

**Consequence for consumers.** An app using `@rn-media/player` on iOS *without*
`@rn-media/audio-session` (or its own session code) now gets the process default
category rather than mpv's `.playback` — the same position it has always been in
on Android. That is the ownership contract, not a regression, and an app that
wants the old behaviour can pass `audiounit-skip-session-management=no` through
the player's own options, which are applied after these defaults.

### 27. The parity audit, and the bug class it is named after

Parity is a gate, so on 2026-08-16 every public member of all four packages was
read against **the actual Kotlin and the actual Swift** — one audit per surface.
The rule was that TSDoc is a claim, not evidence, and that a "ceiling" without a
citation is not a ceiling but an uninvestigated gap. Eight defects fell out, and
they share a shape worth naming.

**The silent no-op**: an API that exists in the TS surface, compiles on both
platforms, and does nothing on one. It passes typecheck, passes CI, passes
review, and is invisible until someone runs the app on the platform that does
not implement it. It has now appeared in three of four packages:

- **audio-session, iOS** — `installObservers()` was reachable only from
  `configure()`, so `wireAudioSession(player)` with no preset (a call the TSDoc
  explicitly invites) registered *zero* notification observers: no
  interruptions, no route changes, no headphone unplug, forever. Observers are
  now derived from interest — `configure`, `activate`, or any `add*Listener`.
- **audio-session, Android** — the mirror image: the becoming-noisy receiver and
  `AudioDeviceCallback` lived strictly between `activate()` and `deactivate()`,
  and the `AUDIOFOCUS_LOSS` handler tore them down permanently, so after one
  permanent loss an app never heard a headphone unplug again. Registration is
  now the union of "we hold focus" and "somebody subscribed".
- **media-session, iOS** — `publishNowPlayingInfo` bailed out when there was no
  `setMediaItem`, so the queue was never consulted. A `setQueue` + `queueIndex`
  broadcast (what `QueueHandler` emits before a track is prepared) produced a
  blank lock screen on iOS and a correct notification on Android, and a sparse
  item over a rich queue entry dropped the artist and artwork on iOS only.
  **Our own TSDoc had documented the merge as the contract: the documentation
  was true on one platform.** `ios/NowPlayingItem.swift` is now a line-for-line
  twin of the Kotlin resolver, mismatch rule included, and the JVM test table
  is what pins the two together.
- **media-session, iOS** — media3 answers both the on-screen fast-forward button
  and an accessory's FF key from one command; MediaPlayer splits them into a
  drawn button and an accessory scan, and only the button was bound. The
  Bluetooth/car-head-unit key was dead on iOS and live on Android.
- **cast, iOS** — `addMediaErrorListener` was registered and unfirable, because
  `GCKRemoteMediaClientListener` reports no errors at all.

Two more were *not* no-ops but genuine divergences of the same family, and both
are worse than a missing feature:

- **A crash.** Kotlin's `Double.toInt()` is total; Swift's `UInt(_: Double)`
  **traps** on NaN, infinity and negatives. Every queue id and index originates
  in JS, where all three are expressible, so `queueJumpTo(NaN)` was a typed
  rejection on Android and a process crash on iOS. Both sides now fold nonsense
  to the invalid-item id the SDKs already define, and clamp finite overflow
  rather than wrapping onto a different, real queue item.
- **A hang.** Android bounds every `PendingResult` at 10 s; `GCKRequest` has no
  timeout at all, so the same call could hang forever on iOS where Android
  surfaces a typed `TIMEOUT`.

And one bug was found *by* the audit rather than in it: cast's error latch was
set but never checked on Android, so a status-then-callback ordering emitted two
`error` events for one failure — which, in the `handoff-to-cast` phase, is two
fallbacks to local. The de-dupe now lives in one place with first-wins
semantics, re-armed when playback leaves idle.

**What the audit did not change is as important.** The player came out clean:
there is no `#if defined(__APPLE__)` in `cpp/`, no `Platform.OS` in `src/`, and
the core sets no `ao=` at all — each fork compiles exactly one audio output, so
mpv picks the only one present. Parity there is a property of the build, not of
vigilance, which is precisely why it held. Every ceiling that survived carries
its citation, and each is stated on the member a caller will actually reach —
because the failure mode this whole exercise is about is discovering a no-op at
runtime.

### 28. Failures with no caller get a channel, not a log line

Principle 6 says no swallowed errors. The half of this package that runs where
**no JS call is waiting** — a media3 service callback, an `MPRemoteCommandCenter`
target, an artwork future — had no way to honour it: there is no promise to
reject, so every failure ended at `Log.e`/`NSLog`. §27 found the worst of them
(a refused foreground service: playback continues with no notification and an
unprotected process, and JS is never told) and deliberately left it, because the
obvious patch would have created an Android-only member and traded an invisible
asymmetry for a visible one.

`MediaHandler.onSessionError(error)` is the designed version. **The channel is
cross-platform and the type enumerates what both platforms can produce**: three
codes have emitters on both sides, and two of those took engineering rather than
prose. iOS gained a `UIBackgroundModes: audio` check — the honest twin of a
refused FGS, since either way the OS will not keep this app alive to play — and
Android gained a `BitmapLoader` decorator, so a failed cover is as visible there
as it already was on iOS. Replacing media3's loader is safe because
`MediaSession.BuilderBase.ensureBitmapLoaderIsSizeLimited` (1.11.0, read from
the AAR) applies the same size-limiting and caching wrappers to an app-supplied
loader as to its own default; the object graph is media3's plus one decorator.
The five Android-only codes each belong to a feature that is *already*
Android-only under a documented ceiling (resumption ×3, `holdLocalAudioSlot`,
drawable-named icons). There is no iOS-only code, and that is stated in the
TSDoc and the README rather than hidden. "Android-only" means *raised* by
Android only: every code exists in the generated Swift and C++ enums too, which
is what keeps an OTA'd bundle and a fixed binary from disagreeing about the
taxonomy.

Three properties are load-bearing:

- **Severity is graded once, in TypeScript** (`SESSION_ERROR_SEVERITY`), because
  a Kotlin copy and a Swift copy is precisely the drift §27 is about. A JVM test
  reads that table out of `validate.ts` and compares it to the generated enum —
  the `SchemaVersionSyncTest` technique.
- **The floor is explicit.** No handler, an implementor written before the method
  existed, or a decorator over one: all three reach `console.error`. An optional
  *error* channel that can be silently absent would be a worse bug than the ones
  it reports.
- **Best-effort delivery is admitted rather than faked.** An abandoned playback
  resumption happens, by definition, when no session exists, so the reason is
  held and flushed to the next `initialize` — the stop-then-resumption-card case,
  where the runtime is alive. After a true process death it stays a log line,
  because replaying it into a later launch would attribute a stale error to the
  wrong run. Since 2026-08-27 the hold is a small list, because one abandoned
  revival now produces two reports (§20 decision 4: the `playbackResumptionNotWired`
  diagnosis at 3 s and the `playbackResumptionFailed` outcome at 10 s), and a
  single slot would have dropped the more useful of them. The diagnosis is held
  conditionally — an `initialize` arriving before the deadline is a *disproof*,
  not a delivery cue, and discards it.

Two sites stay log-only by ruling rather than by omission: a sleep timer that
fires with no session, and one that fires with no `pause` capability advertised.
In both the app is told the timer fired at that same instant, and the state
discrepancy follows from its own capability list — a second, redundant error
would be noise, not honesty.

### 29. React Native 0.87: the bump is an AGP 9 bump wearing an RN badge

RN 0.87.0 (2026-08-11) was evaluated and taken on 2026-08-17, inside the
currency rule's two-week window. The JavaScript half of the release is almost
free for us; the Android toolchain half is the whole job.

**AGP 8.12.0 → 9.2.1 is the actual change.** `@react-native/gradle-plugin`'s
`gradle/libs.versions.toml` is the source of truth for it, and 0.87 is the first
RN release that builds on AGP 9. It drags Gradle 9.3.1 → 9.4.1, Kotlin
2.1.20 → 2.2.0, and compileSdk/buildTools 36 → 37, and it needs two opt-outs in
`gradle.properties` (`android.builtInKotlin=false`, `android.newDsl=false`)
without which AGP 9's own Kotlin plugin collides with the
`org.jetbrains.kotlin.android` plugin our library modules already apply. AGP 10
removes those opt-outs, so the new DSL migration is a scheduled debt, not a
choice. JDK 17 remains the floor, so CI's `setup-java` is untouched.

**AGP 9 deletes `testReleaseUnitTest`.** Unit-test tasks are now created only
for `testBuildType` (default `debug`), so the CI step that named the release
task failed with "task not found in project" — a *hard* failure, which is the
good outcome; the dangerous version of this change would have been a silently
skipped suite. Renamed to `testDebugUnitTest`, with no coverage lost: these are
pure-JVM tests over parsers and constant maps, and unit tests never saw R8.
`lintRelease` is unaffected and still runs.

**Two source-level breaks, both from the Strict TypeScript API becoming the
default.** `StatusBar`'s `backgroundColor` prop is gone (it was already a no-op
under the edge-to-edge that Android 15+ forces at targetSdk 35+), and
`AppState.currentState` is now honestly typed `null | undefined | string`
rather than narrowed to `AppStateStatus` — the Flow source always said `?string`,
so the old hand-maintained types were the lie. `useVisualizer`'s `isForeground`
widened to match. We were otherwise clean because we already had no deep imports
into `react-native/Libraries/*` and every iOS header import was already
`<React/…>`-namespaced — which is what made 0.87's new headers XCFramework a
non-event here.

**The template's `edgeToEdgeEnabled=true` was deliberately not taken.** The flag
is still read by the Gradle plugin in 0.87; flipping it is a layout change to
the demo UI, not a 0.87 requirement, and it does not belong in a dependency bump.

**The trap worth remembering is npm, not Gradle.** `npm install` alone produced
a workspace with *two* React Natives: `@expo/cli` declares
`peerOptional react-native@"*"`, the stale lockfile kept that satisfied with the
old 0.86.2 copy at the root, and the example app got 0.87.0 nested under itself.
`apps/example/android/settings.gradle` includes the **root**
`node_modules/@react-native/gradle-plugin`, so the build would have compiled the
entire app with the 0.86.2 plugin (AGP 8.12.0) while every `package.json` in the
repo claimed 0.87.0 — green, and wrong. Regenerating the lockfile collapses it
back to a single hoisted 0.87.0. A React Native bump in this monorepo is not
done until `node_modules/react-native` and `apps/example/node_modules` agree,
because the Gradle build reads the hoisted copy and the Podfile resolves from
the app.

Expo is the one consumer that stays behind on purpose: SDK 57 targets RN 0.86,
so `expo-root-project`'s catalog still hands a prebuild app compileSdk 36 /
Kotlin 2.1.20 (§16). That is fine and needs no shim — our modules read the
*root* project's ext, the per-package `gradle.properties` values are only the
standalone fallback, and media3 1.11's `minCompileSdk=36` is the real floor a
consumer must clear. compileSdk 37 is what we build against, not what we demand.

### 30. The foreground promise is kept by whoever made it — including on the warm path

A user-reported crash (POCO F4, Android 13, release build) named the hole
precisely:

```
android.app.RemoteServiceException$ForegroundServiceDidNotStartInTimeException:
Context.startForegroundService() did not then call Service.startForeground()
  at com.rnmediamediasession.MediaSessionController.startService(MediaSessionController.kt:686)
  at com.rnmediamediasession.MediaSessionController.setPlaybackState$lambda$8
```

**`startForegroundService()` is a promise with an uncatchable penalty, and it is
made by the caller, not by media3.** A `playing` broadcast starts the service
(`setPlaybackState` → `startService`); the OS then requires a `startForeground()`
within its window (~10 s on 13/14) or it kills the process — no exception the app
can catch, no notification, no log the app writes. Until now the warm path simply
*hoped* media3 would promote in time. media3 promotes from its own notification
pass and only while `MediaNotificationManager.isAnySessionUserEngaged`
(`playWhenReady && (STATE_READY || STATE_BUFFERING)`) holds; if the engagement
that started us has evaporated by the time that pass runs — a fast pause, a stop,
a track that errors or ends immediately, any state race — media3 never promotes,
and by design nobody else did either. §20's *cold* path already knew this
(it posts a real notification itself) and `stopWithoutEverBecomingForeground`
already knew it for the "nothing to serve" path. The warm path, the common one,
was the one without an answer.

**media3 guards its own starts the same way, which is the tell.** Verified by
`javap` on the shipped 1.11.0 AAR: `MediaButtonReceiver` refuses to start the
service on API 26+ for any key event that is not `PLAY`/`PLAY_PAUSE`/
`HEADSETHOOK`, logging *"Ignore key event that is not a `play` command on API 26
or above to avoid an `ForegroundServiceDidNotStartInTimeException`"*, and
`MediaSessionService.stopSelfSafely` builds a shutdown notification purely so it
can `startForeground` → `stopForeground` → `stopSelf`. An app-initiated start is
the app's promise to keep, and for a consumer of this library, this library is
the app.

**The fix lives in `onStartCommand`, not `onCreate`.** `onCreate` also runs for a
plain `bindService` — a `MediaController` connecting, Android Auto reading the
browse tree — where no promise exists and posting a notification would put a
foreground service on screen for a bind. `onStartCommand` runs for *started*
services, which is exactly the set of starts that can carry one. Three outcomes,
all of which end with the promise kept:

| Start | Behaviour |
|---|---|
| Bind only (no start) | untouched — no promise, no notification |
| Warm, snapshot still `playing`/`buffering` | the **real** media notification via `startForeground`, under media3's own `DEFAULT_NOTIFICATION_ID`, so media3's next pass replaces it in place (the same mechanism §20 uses — one method, `promoteWithSnapshotNotification`, now shared by both) |
| Warm, the race already landed (paused/stopped/error) | `startForeground` + `stopForeground(STOP_FOREGROUND_REMOVE)` on a throwaway id — promise kept, nothing drawn, and the service stays **started** so the next `playing` re-promotes through media3 |
| Media button into a foreground service | skipped: nobody is being held to anything |
| Revival | unchanged (§20) — promotes with the mirrored metadata, now with the same demote-in-silence fallback if that notification cannot be built |
| Cold start with nothing to serve | unchanged — `stopWithoutEverBecomingForeground`, which is now that same promote-then-demote plus `stopSelf` |

**"Already foreground?" is asked of ActivityManager, on every API level.** The
skip is worth having: AOSP `ActiveServices.sendServiceArgsLocked` clears
`fgRequired` outright when the record is already foreground at delivery time
(`if (r.fgRequired && !r.fgWaiting) { if (!r.isForeground) scheduleServiceForegroundTransitionTimeoutLocked(r); else r.fgRequired = false; }`
— "Service already foreground; no new timeout"), so there is genuinely no
deadline to meet, and promoting anyway would hand `startForeground` a *different*
notification id and cancel media3's own notification for nothing. Two readings of
that same `r.isForeground` bit:

- **API 29+**: `Service.getForegroundServiceType()`, documented to return
  `FOREGROUND_SERVICE_TYPE_NONE` "if the service is not a foreground service";
  this package's manifest always declares `mediaPlayback`, so a promoted service
  can never read as NONE.
- **API 26–28**: `ActivityManager.getRunningServices`, whose deprecation note is
  precise about what survived — "no longer available to third party
  applications. For backwards compatibility, it will still return the caller's
  own services" — implemented in `ActiveServices.getRunningServiceInfoLocked`
  (`allowed || (sr.app != null && sr.app.uid == callingUid)`), with
  `makeRunningServiceInfoLocked` filling `info.foreground = r.isForeground`.

**This replaced a real hole, source-verified only (no 8/9 hardware here).** The
pre-Q fallback used to be media3's `isPlaybackOngoing()`, on the reasoning that
it "errs towards not interfering". It does not: it is a **latch** (see the
platform-truths entry below), `true` for the life of the process after media3's
first promotion. On Android 8–9 the sequence media3 promotes → media3 demotes →
a fresh `startForegroundService` arrives would therefore have read "already
foreground", skipped, and left the promise unkept — the exact crash this section
exists to remove, on versions that enforce it. The rule is now stated once, in
`ForegroundPromise.decide`, and it is the asymmetry rather than a guess: **only
a positive answer may skip; `false` and *unknown* are identical and both keep the
promise**, because a redundant promote-then-demote is two binder calls and a
missed one is an uncatchable process kill. Every failure of the probe — a
`SecurityException` from an OEM that tightened the API, an empty list, our record
missing — returns "unknown".

A locally tracked boolean was rejected for the same reason it always was: media3
promotes and demotes behind us (`stopForegroundOnPause`, the grace period of
§19), so a flag of ours would drift, and drifting in the "we think we are
foreground" direction is the crash.

**The decision is a pure function with an exhaustive JVM test.** A foreground
*transition* needs a device; deciding *which* transition to make does not, and
that is the half that has now shipped wrong twice. `ForegroundPromise.decide`
takes `(sdkInt, alreadyForeground: Boolean?, wantsForeground,
canBuildSnapshotNotification)` and returns `SKIP` /
`PROMOTE_WITH_SNAPSHOT` / `PROMOTE_THEN_DEMOTE`; `ForegroundPromiseTest` sweeps
the whole table and asserts the invariant directly — *on API 26+, no input other
than a positive already-foreground may produce `SKIP`*. The same file guards the
other half of the original mistake: the set of files in this package that call
`startForegroundService` is pinned (`MediaSessionController.kt`, and only it), so
a fourth start path cannot be added without naming its keeper in the same commit.
The bug existed because two of three paths had an answer and nobody checked the
third; that is now a failing test rather than a phone call.

**Audit of every path that can make the promise** (the AAR half by `javap`,
1.11.0):

| Who calls `startForegroundService` | Keeper | Verdict |
|---|---|---|
| `MediaSessionController.startService` (the reported stack) | `onStartCommand` → `keepForegroundPromise` | kept |
| media3 `MediaButtonReceiver.onReceive` (play-shaped key events only, and it says so: *"Ignore key event that is not a `play` command on API 26 or above to avoid an `ForegroundServiceDidNotStartInTimeException`"* — observed on device in this package's logcat) | same `onStartCommand` | kept |
| media3 `MediaNotificationManager.startForeground` | itself, synchronously: `ContextCompat.startForegroundService` then `Util.setForegroundServiceNotification(…, "mediaPlayback")` in the same method | self-kept; our `onStartCommand` then sees a foreground service and skips |
| media3 `MediaSessionService.stopSelfSafely` | itself: shutdown notification → `startForeground` → `stopForeground` → `stopSelf` | self-kept |
| The framework restarting us stickily, or `am start-foreground-service` | same `onStartCommand` | kept |
| Notification action `PendingIntent`s (media3 uses `startForegroundService` for `Play`, plain `startService` for the rest — visible in `dumpsys notification`) | same `onStartCommand` | kept |

**The predicate is now one property, `Snapshot.wantsForeground`.** It used to be a
private extension inside `MediaSessionController`; the service needs the same
answer, and the two disagreeing is a process kill, so it moved onto `Snapshot`
with a JVM test (`SnapshotTest`) pinning it to media3's `isAnySessionUserEngaged`
pair. The starting side and the promise-keeping side now read the same line.

**Same bug class, audited while in there: `serviceRequested`.** It gates
`startService`, so a stuck `true` is a permanent, silent loss of background
playback. Every exit now clears it in exactly one place each — `detachService`
(destroyed), `stop` (session ended), `discardRevival` (resumption abandoned) and
`attachService` when there is nothing to serve. That last one was the gap: a
service that never becomes *this* object's service is declined by
`detachService`'s identity check on the way out, so nothing would have cleared a
flag set for it.

**Same latch, second misuse, fixed here too: `onTaskRemoved`.** Its predicate was
`isPlaybackOngoing && playing`, while its own comment said the truth it trusts is
the app's last broadcast. The conjunct reads `false` in precisely the window
`keepForegroundPromise` creates — *we* hold the foreground with the real media
notification and media3 has not taken over yet — so a task swipe there stopped a
service that was playing. It is now the broadcast alone.

**The throwaway notification does not touch the app's channel.**
`promoteThenDemote` used to borrow the app's configured channel, falling back to
a placeholder named "Playback" when there was none. Both are wrong in small ways:
a channel is permanent and user-visible the moment it is created, so the
placeholder would sit in the app's notification settings forever — under a name
the app never chose, next to the app's own channel of the same name — for a
notification nobody ever saw; and borrowing the app's channel inherits its
importance, which an app is free to set to `IMPORTANCE_DEFAULT`, i.e. peekable.
It now always uses its own `rn-media-session-transient` channel at
`IMPORTANCE_LOW` (no sound, no peek, whatever the app configured) and **deletes
it again in the same call**, in a `finally` so a refused `startForeground` cannot
leave one behind. `IMPORTANCE_MIN` is not on the table and the device said so
before the docs did: it comes back out of `dumpsys notification` as
`mImportance=2`, because AOSP
`NotificationManagerService.enqueueNotificationInternal` rewrites the channel for
anything a foreground service posts — `if (notification.isFgsOrUij()) { … if
(r.getImportance() == IMPORTANCE_MIN || … IMPORTANCE_NONE) {
channel.setImportance(IMPORTANCE_LOW); … } }`. Asking for a value the framework
always overrides would read as an intention the code does not have, so it asks
for what it gets. Deleting is not destructive: the id is this package's, AOSP
`PreferencesHelper.createNotificationChannel` un-deletes rather than replaces if
it is ever created again, and while deleted the channel is filtered out of the
enumerations Settings uses (`includeDeleted || !nc.isDeleted()`).

### On-device verification (POCO F4, Android 16 / API 36, 2026-08-19)

No unit test can cover a foreground transition, so these are device facts.

**The timeout is not ~10 s everywhere.** `adb shell dumpsys activity settings` on
that device reports `service_start_foreground_timeout_ms=30000` and
`service_start_foreground_anr_delay_ms=10000` — the AOSP default is 10 s, the
device ships 30. Anything that waits for the crash must wait longer than the
device says, not longer than the docs say.

**The natural race cannot be won from `adb` on this hardware, and that is worth
recording rather than hiding.** With a warm process, media3's promotion follows
the service start by ~15 ms (measured: `Background started FGS` → first
`isForeground=true`); under a 12-way CPU load it stretches to ~90–300 ms, but a
`pause` dispatched into that window is overwritten a moment later by the async
`play` still resolving, and media3 promotes anyway. Airplane mode does not help:
the app's reconnect loop re-enters `BUFFERING`, which re-engages media3. So
play-then-pause is the *shape* of the bug, not a usable repro here.

**What is a usable repro** is the same promise with the timing collapsed out of
it — a started start whose engagement is not `playing`:

```
adb shell am stopservice <pkg>/com.rnmediamediasession.RnMediaMediaSessionService
adb shell dumpsys activity services <pkg>            # must print (nothing)
adb shell am start-foreground-service -n <pkg>/com.rnmediamediasession.RnMediaMediaSessionService
```

with the app's runtime already up (so this is the warm path, not §20's revival).
Pre-fix, at exactly +30 s:

```
W ActivityManager: Bringing down service while still waiting for start foreground: ServiceRecord{… RnMediaMediaSessionService …}
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: android.app.RemoteServiceException$ForegroundServiceDidNotStartInTimeException:
    Context.startForegroundService() did not then call Service.startForeground()
I Process: Sending signal. PID: 12755 SIG: 9
```

Post-fix, the identical sequence leaves `startForegroundCount=1` with no
`isForeground` line — the promise kept, nothing drawn, the service still started
— and the process alive at +50 s. The next play then promotes normally:
`isForeground=true foregroundId=1001`, a single notification in
`dumpsys notification` (`id=1001`, `groupKey=media3_group_key`, `actions=5`,
`category=transport` — media3's own, not a placeholder), and
`startForegroundCount` still `1` at +7 s, which is how "replaced in place" reads
in `dumpsys`: `ServiceRecord.startForegroundCount` only counts a not-foreground →
foreground transition.

**Nothing flashes.** Screen recordings taken across `promoteThenDemote` with the
shade open and with it closed show no new shade entry and no new status-bar icon
(diffing every encoded frame of the status bar strip: 4 frames in 6 s, all
clock-sized deltas). The mechanism is the platform's own ten-second deferral of
foreground-service notifications (Android 12+; `deferred_fgs_notifications_enabled=true`
on this device) — a notification with no actions and no `MediaStyle` is not shown
at once, and this one is gone in milliseconds. One device, one version; the
`IMPORTANCE_MIN` channel above is the belt to that braces.

**No stray channel.** After a full session of this testing the example app's
channel list reads exactly:

```
mId='rn-media-session-transient', mName=Background playback handover, mImportance=2, … mDeleted=true
mId='playback',                   mName=Playback,                     mImportance=2, … mDeleted=false
```

— the app's own channel untouched, and ours already gone from everything the
user can see.

### 31. The car is a browser that taps: one handler, a per-controller door, and a cache that outlives JS

Android Auto and CarPlay are the same feature seen twice (`docs/specs/car.md`):
a **tree** the car browses (`getChildren(parentId)`, `getMediaItem(id)`,
`search(query)`) and a **tap** that starts playback (`playFromMediaId(id)`,
`playFromSearch(query, focus)`). One `MediaHandler`, one `BrowseItem`, both
platforms — parity by construction rather than by two feature flags.

**The tap arrives through the door we kept shut, so the door became per-controller.**
Android Auto is a *legacy* `MediaBrowserCompat` client. Its tap is
`onPlayFromMediaId` → `MediaSessionLegacyStub.handleMediaRequest` →
`dispatchSessionTaskWithPlayerCommand(COMMAND_SET_MEDIA_ITEM, …)` →
`MediaSession.Callback.onSetMediaItems` carrying only a `mediaId` (voice: the
same path with `requestMetadata.searchQuery`) — media3 1.11.0 source, not
javadoc. The media-session spec's rule that `COMMAND_SET_MEDIA_ITEM` is never
advertised (a stray controller must not replace the app's playlist) stays true
for strays: `onConnectAsync` grants it only when
`session.isAutoCompanionController` (`com.google.android.projection.gearhead`),
`session.isAutomotiveController` (`com.android.car.media` / `.carlauncher`) or
`ControllerInfo.isTrusted()` says so, and *removes* it otherwise
(`CarControllers.carCommands`, a pure predicate with a JVM test). Two things the
implementation found that the design had not: the grant is inert unless the
**player** also advertises the command (`ConnectedControllersManager.
isPlayerCommandAvailable` ANDs the two), so `MediaButtons.addAlways` now carries
it and the per-controller step is a *removal*; and `onSetMediaItems` answers
with the **current** timeline unchanged — the app's next broadcast is the
acknowledgement (§9), and `SimpleBasePlayer.handleSetMediaItems` is never
reached with foreign items (asserted).

**media3 synthesises a `play()` after the tap, and for a facade that means
"resume the wrong song".** `handleMediaRequest` runs `setMediaItems → prepare →
play` inline once `onSetMediaItems` resolves. A real player plays what was just
set; this player's `play()` is `handlers.play()`, i.e. resume the *previous*
track while the app is still loading the tapped one — a fraction of a second of
the wrong song on a car stereo. `MediaRequestLatch` swallows exactly that call:
armed in `onSetMediaItems`, disarmed on the next looper turn (the whole media3
sequence runs inside one message, so the window is "the rest of this turn", not
a duration). Consuming, not peeking — a second `play` in the same turn is a
real gesture and reaches the app.

**Browse is a pull with a native cache, not a pushed snapshot.** The obvious
design (and queue-player's) pushes a whole static tree into native so a cold car
connection answers without JS. Ours asks the handler through Nitro's
value-returning callbacks and writes every answer to `BrowseCache` (memory +
disk JSON, 64 entries / 2 MB, LRU). A car binding a dead process gets the cache
(or an empty list — "return an empty list rather than error codes") immediately,
a revival starts **only for a car controller** (a SystemUI bind must not boot
the app, §30), and `notifyChildrenChanged` fires for every parent served stale
once JS answers. Dynamic trees, and it works when JS is dead. A pull that does
not answer within 5 s serves the cache and logs; the car never spins forever.
Consequence worth stating plainly: the browse revival passes `promotes = false`
— a bind makes no `startForegroundService()` promise and promoting would be a
background FGS start on API 31+ — so **cold browse requires
`android.playbackResumption: true`**; a browse-only session is the follow-up.

**Nitro's returning callback is a promise of a promise.** A handler declared
`(parentId) => Promise<NativeBrowseResult>` is generated as
`Promise<Promise<NativeBrowseResult>>` on both platforms (the outer schedules
onto the JS thread, the inner is the JS promise). Unwrap twice; the TS
declaration stays as it is because that is what lets an async handler typecheck.
Found by the iOS lane in the generated Swift, forwarded to Android before it
cost a debugging round.

**Car artwork cannot be a URL.** Google: browse artwork is `content://` or
`android.resource://` only; bitmaps in results are banned (AAOS, 1 MB binder).
`RnMediaArtworkProvider` (exported, read-only — UAMP's precedent) serves
`cacheDir/rn-media/artwork/<sha256(url)>`, downloading on miss at the browser's
`MEDIA_ART_SIZE_PIXELS` hint, and **only for URLs the browse path registered**
(`ArtworkRegistry`); it is not a general fetch endpoint. The manifest merges the
car `<meta-data>` and `automotive_app_desc.xml` from the library — Android is
zero-config.

**Errors reach the car's screen only for two codes.** `LibraryResult` errors are
replicated to the platform state for legacy browsers only when the code is
`ERROR_SESSION_AUTHENTICATION_EXPIRED` or
`ERROR_SESSION_PARENTAL_CONTROL_RESTRICTED`
(`MediaLibrarySessionImpl.isReplicationErrorCode`; `onGetLibraryRoot` exempt;
mode `NON_FATAL` by default since 1.9.0). The architect's spec said
`PREMIUM_ACCOUNT_REQUIRED` from a summarised javadoc; Lane A corrected it from
source — the evidence rule at work. `BrowseError` carries an optional
`resolution` (label + deep link) that becomes the
`ERROR_RESOLUTION_ACTION_LABEL/_INTENT` extras behind Auto's "Sign in" button.
Legacy string keys are copied with their source cited because media3's own copy
(`androidx.media3.session.legacy.MediaConstants`) is `@RestrictTo(LIBRARY)`.

**Root tabs are four, browsable-only, and the drop is reported.** The car's
root hint says so; extras and playable roots are dropped by the TS layer (and
again natively at the browser's smaller hint) and surface once on the
sessionError channel as `browseRootRejected` — never silently (§27).

**CarPlay needs a UIScene app; RN 0.87 is not one.** The scene entrypoint
(`startReactNativeWithModuleName:inWindow:connectionOptions:`) exists on RN
`main` (→ 0.88) and is absent in 0.87.1 (both headers read). So the pod ships
two `@objc` bare-name delegates the app's `Info.plist` names:
`RnMediaCarPlaySceneDelegate` and `RnMediaWindowSceneDelegate`, the latter a
phone-window shim that re-parents RN's root view under the live `UIWindowScene`
(react-native-carplay and queue-player do the same) with a written expiry: it is
deleted when the app adopts 0.88's entrypoint. Templates come from the same
handler — `CPTabBarTemplate` of lazily-filled `CPListTemplate`s, playable taps
push `CPNowPlayingTemplate.shared`, which our `MPNowPlayingInfoCenter` already
feeds; repeat/shuffle/rate buttons cycle through the same handlers as the lock
screen. `search`/`playFromSearch` are never called on iOS because a CarPlay
audio app has no search template — a platform absence recorded in the table,
not a gap. The Expo plugin's `carPlay: true` writes the scene manifest and the
`com.apple.developer.carplay-audio` entitlement (Apple-approved; the Simulator
needs only the key).

**One C++ keyword.** `explicit` is a C++ keyword, so the bridge field is
`NativeBrowseItem.isExplicit`; the public `BrowseItem.explicit` is unchanged. It
surfaced at `:app:assembleDebug`, after every TS gate was green.

Rejected alternatives, for the record: granting `SET_MEDIA_ITEM` globally
(reintroduces the playlist-replacement hole); pushing a static snapshot
(dies with the service, static only); serving HTTPS artwork and hoping (Auto
shows nothing); waiting for RN 0.88 (parity is a gate, and the shim has an
expiry).

### On-device verification (POCO F4, Android 16 / API 36, 2026-08-27)

**The Desktop Head Unit needs one config key that none of its sample files
carry.** DHU 2.0 (build 2022-03-30) connects to Android Auto 17.3.662854,
completes the TLS handshake and then draws nothing — `screenshot` says
`Don't have video focus - nothing to screenshot`. The receiver never asks for
*video focus* unless `~/.android/headunit.ini` sets `startupfocus = true`; the
key exists in the binary and in no shipped `.ini`. With it, the DHU renders.
Three more notes for the next person: a stale `gearhead:car` session holds the
head-unit server (force-stop Android Auto and restart the server before each
connect, or the link dies right after `connected.`); `-c config/default_720p.ini`
breaks the handshake (the default 800×480 negotiates); and the DHU's stdin must
be held open or it exits at once. The first diagnosis — "a 2022 receiver
against a 2026 Android Auto" — was wrong, and is kept here because it is the
conclusion a stalled handshake invites.

**What the car draws (DHU, 2026-08-27, screenshots reviewed by the architect):**
the app in the car launcher (the merged `com.google.android.gms.car.application`
meta-data); the browse root as four tabs *Library · Albums · Artists · Recent*
with the search icon (`SEARCH_SUPPORTED` from the session-command gating);
Library rows with title, subtitle and artwork rendering through
`content://com.rnmediaplayerexample.rnmedia.artwork/<sha256>`, the one track
without a cover correctly blank; **Albums as a grid** (`childStyle: 'grid'`
honoured end to end); a real car tap → `playFromMediaId(track:fip-hls)` →
`track 0 → 1` and Now Playing switching from Diverse FM to FIP, with **no
`remote command: play`** after it — `MediaRequestLatch` proven through an actual
head unit. With the sign-in simulation on *while playback is active*, the root
shows "No items" rather than the sign-in screen, consistent with non-fatal
replication (§31, errors) — the idle-state sign-in screen is still to be
photographed.

**So the tree was verified by the client Android Auto actually is.** Auto is a
legacy `MediaBrowserCompat` browser; a media3 `MediaBrowser` walks the same
session callbacks over the same binder and, unlike the DHU, produces values.
`apps/example/android/app/src/androidTest/…/CarBrowseInstrumentedTest.kt`
(10 tests, `./gradlew :app:connectedDebugAndroidTest`) boots the whole stack —
Activity → RN → `MediaService.init` — and covers the root, the four tabs in
order, drilling in, `content://` artwork (fetches the bytes through the
provider and asserts an unregistered hash is refused), paging, `getItem`,
search, the empty-list-never-error rule, and a browse tap end to end. Run twice
on the device — once by the implementation lane, once by the architect:

```
Finished 10 tests on 22021211RI - 16
BUILD SUCCESSFUL in 1m 35s
ReactNativeJS: [example] remote command: getChildren(rn-media-root)
ReactNativeJS: [example] remote command: getChildren(library)
ReactNativeJS: [example] remote command: playFromMediaId(track:mp3-test)
ReactNativeJS: [example] track 0 → 3
ReactNativeJS: [example] remote command: getMediaItem(track:diverse-fm)
ReactNativeJS: [example] remote command: search("diverse")
```

No `remote command: play` follows `playFromMediaId` — that line's absence is
`MediaRequestLatch` swallowing media3's synthesised `play()` on hardware.
`dumpsys media_session` reports `actions=2616839`, which decodes to include
`ACTION_PLAY_FROM_MEDIA_ID` and `ACTION_PLAY_FROM_SEARCH` — absent before this
change. Android Auto's own app list on the phone shows the example app: the
car `<meta-data>` merged from the library.

**Found by the lane's own review, before any device run:**
`MediaLibrarySessionImpl.verifyResultItems` *throws* `IllegalStateException(
"Invalid size=…, pageSize=…")` on the application thread when a result exceeds
the requested page. Returning the whole cached list would have been fine for
Auto (`pageSize = MAX_VALUE`) and fatal for a modern `MediaBrowser`; results
are now windowed (`Long` arithmetic — `page * Integer.MAX_VALUE` overflows) and
`paging_is_honoured_rather_than_crashing_the_session` pins it.

**A false positive the car exposed in the library.** A car tap produced
`metadataMismatch: item id 'diverse-fm' vs queue[1] id 'fip-hls'` from an app
whose every broadcast was self-consistent. An app describes one moment with two
calls (`setMediaItem`, then `setPlaybackState`) and each hops to the main
thread on its own, so for one looper turn the session holds half the statement
and `getState()` judged an invariant on a state the app never published.
`MismatchReporter` defers the check by one turn — both writes are already
queued when the first runs, so a check posted from inside it lands after all
of them. A mismatch the app genuinely publishes still reports; three
consecutive track jumps on the device now report zero (was one per jump).

**Still pending:** the idle-state sign-in screen photograph, and CarPlay, which
is CI-compiled only until Apple hardware exists (the cast precedent, #48).

## Platform truths we build around (learned, verified)

- **`UInt(_: Double)` traps in Swift where `Double.toInt()` is total in
  Kotlin.** NaN, infinity and negatives all reach native code from JS, so the
  same argument that yields a typed rejection on Android crashes the process on
  iOS. Any `Double` crossing the bridge into an unsigned native type needs an
  explicit fold, not a cast (§27).
- **`GCKRequest` has no timeout**, while media3's `PendingResult` accepts one.
  An unbounded request is a hang on one platform and a typed error on the other
  (§27).
- **JS timers freeze in background** without an Activity (JavaTimerManager
  gates on lifecycle + headless tasks; Samsung freezes them even with one —
  RN #56324). Nothing timing-critical may live in JS. The consequence is not
  advice to consumers but a shipped feature: `media-session` provides the sleep
  timer natively (§19), because an app that built one on `setTimeout` would ship
  a bug that only appears with the screen off.
- **An unhandled JS exception destroys the whole runtime** (default
  ReactHostDelegate rethrows). All handler dispatch is wrapped.
- **`locationX`/`locationY` are relative to the *touch target*, not to the view
  whose `PanResponder` received the event.** The target is the deepest
  hit-testable view under the finger (`TouchesHelper.kt:61-65`), so
  `pageX - locationX` — the only way to learn a `View`'s page origin without an
  async `measure` — yields the *child's* origin unless the responder is the only
  thing that can be hit. Two traps compound it: every RN `View` is
  `clipChildren = false` (`ReactViewGroup.kt:170`), and a parent's overflow
  inset extends hit-testing to children drawn outside its bounds
  (`TouchTargetHelper.kt:189-210`), so a 4 px-tall track happily hands the touch
  to a 14 px thumb hanging off it. The rule for every gesture surface in this
  repo: **`pointerEvents="none"` on everything inside the responder**, and fold
  the drawn element's own `onLayout` offset back in rather than assuming it
  shares an edge with the hit area. This has now been the same bug three times
  — twice in the EQ fader bank (`c1918ac`) and once in the seek bar, where
  grabbing the thumb resolved to the thumb's origin and seeked to 0:00. Both
  live under test as `fader-geometry.ts` / `seek-geometry.ts`, because the
  mistake is arithmetic and arithmetic does not need a device.
- **iOS replaces pause with STOP for anything marked live**, whatever the app
  advertises. Setting `MPNowPlayingInfoPropertyIsLiveStream` — which
  `publishNowPlayingInfo` does for every item with no duration, not just an
  explicit `isLive` — makes the system draw a stop button in the pause slot on
  the Lock Screen, in Control Center and on CarPlay's `NowPlayingTemplate`,
  "even when configured for play and pause button only" (Apple DTS, forums
  thread 663795). It is deliberate: a live stream cannot be paused. The
  consequence is a trap rather than a cosmetic difference — on a live entry
  **`MediaHandler.stop` is the only transport a remote surface can reach**, so
  a `stop` wired to teardown is a one-way door. iOS has no resumption card to
  come back through (§26 and `setResumptionSnapshot`'s "Android-only, and
  deliberately not emulated"), so the now-playing card simply vanishes. This is
  why `MediaHandler.stop` is documented as "Release resources. Does NOT end
  background execution — call `stopService()` for that": an app that routes it
  to `stopService()` ships a dead lock screen on every radio station. The
  example app did exactly that until 2026-08-16; its remote stop now unloads via
  `player.stop()` (queue kept) and its `play` re-enters with `jumpTo`, because
  a stopped mpv reports `playlist.index === -1` and `play()` alone cannot
  resume from there. Regression test:
  `apps/example/src/playback/__tests__/transport.test.ts`.
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
- **media3's `isPlaybackOngoing()` is a latch, not a state.** It returns
  `MediaNotificationManager.isStartedInForeground()`, and that field is written
  in exactly two places (`javap`, 1.11.0): `false` in the constructor and `true`
  in `startForeground(MediaNotification)`. The demotion path
  (`updateNotificationInternal`'s `notify` + `Util.stopForeground`) and
  `removeNotification()` both leave it alone. Re-verified 2026-08-19 against the
  shipped AAR at the bytecode level: `putfield startedInForeground` appears at
  exactly two offsets, `iconst_0` in `<init>` and `iconst_1` at the end of
  `private void startForeground(MediaNotification)` (right after
  `Util.setForegroundServiceNotification`), while `updateNotificationInternal`'s
  demotion arm (`NotificationManager.notify` + `Util.stopForeground(service,
  false)`) and `removeNotification` (`Util.stopForeground(service, true)` +
  `cancel`) touch neither. So it means "media3 has taken the foreground
  transitions over", never "the service is foreground right now".

  **This package therefore consults it nowhere.** Both former callers are gone:
  §30's pre-Q "already foreground?" — which the latch would have answered `true`
  forever, skipping the promise-keeping on Android 8–9 for the very crash §30
  exists to remove — and `onTaskRemoved`'s `isPlaybackOngoing && playing`, which
  it answers `false` for exactly the window where §30 holds the foreground
  itself. For "is this service foreground right now" the framework is the only
  honest source: `Service.getForegroundServiceType()` on API 29+, and
  `ActivityManager.getRunningServices` → `RunningServiceInfo.foreground` below
  it, which is the same `ServiceRecord.isForeground` the framework itself checks
  before deciding whether to hold us to a promise at all.
- **`am kill` and `am force-stop` are not the same kill.** `am kill` leaves the
  System UI resumption card in place (SystemUI logs `Converting … to resume`) and
  earns a START_STICKY service restart a second later; `force-stop` removes the
  card outright (screenshot-confirmed) *but* — measured on Android 16, contrary
  to the usual folklore — the framework still holds the app's
  `Last MediaButtonReceiver`, so a headset play still revives it. Only `am kill`
  reproduces the scenario users actually hit.
- **Metro inline requires makes "module scope" a lie for headless boots.** With
  `inlineRequires: true` (the RN default), a binding import used only inside a
  component is required at first *render* — so in a revived process only the
  entry file (and whatever it imports for side effects) executes at bundle
  load. Code that must run with no surface (`MediaService.init` for playback
  resumption) needs a bare `import './x'` in `index.js`; anything weaker
  executes minutes later, when an Activity finally starts a surface (probe-
  bisected on device, 2026-08-13, bug #47). Corollary for diagnosis: this
  release template also emits **no `ReactNativeJS` logcat output at all**, so
  headless JS execution must be probed via native calls, not `console.log`.
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
  verifying the iOS filter build. `libavfilter/formats.c:387` stores
  `.conversion_filter = "aresample"`, the name the graph *looks up* when two
  pads disagree, so the literal is in the binary whether or not the filter was
  compiled. Proof of registration has to come from something only the filter's
  own object file emits (here `af_aresample.c:205`'s log format,
  `"ch:%d chl:%s fmt:%s r:%dHz -> …"`). Line numbers re-verified at n8.1.2 on
  2026-08-14 (#51); they were n6.0's.
- **~~mpv's manual documents `replaygain-clip` inverted~~ — RETIRED at the 0.41
  engine bump.** It was true of 0.35.1 ("prevent clipping"), and our API was
  mapped to the *behaviour* verified in `player/audio.c` rather than to the
  prose. mpv 0.41's `options.rst` now reads "Allow the volume gain to clip
  (default: no)", which is what the code always did, so the two agree and our
  mapping is unchanged. Kept as a retired entry because the API shape it
  produced is still in the public surface, and a reader who finds the current
  manual correct should not conclude the API is backwards.
- **`replaygain-fallback` applies even with `replaygain=no`** (task #43,
  owner-reported: switching ReplayGain off did not restore the original
  loudness). In mpv 0.41.0's `compute_replaygain()` (`player/audio.c:142-168`)
  the fallback branch is the `else` of `if (opts->rgain_mode && rg)` — it runs
  for an untagged file *and* whenever the mode is `no`, which the manual states
  ("always applied if the replaygain logic is somehow inactive") but every
  intuition misses. Measured on mpv 0.41.0 (`--ao=pcm` capture, tagged −10 dB
  file): mode `track` → gain 0.316228 (−10 dB); mode set to `no` with a stale
  `fallback=-6` → gain 0.501187 (−6.02 dB in the PCM), **not** unity; only
  `fallback=0` returns the RMS to the baseline exactly. All four `replaygain*`
  options carry `UPDATE_VOL` (`options/options.c:764-773`), so writes do apply
  live via `audio_update_volume()` → `ao_set_gain()` — the deferred-to-next-file
  theory is false; the trap is purely the mode-independent fallback. Turning
  ReplayGain off for real is `{ mode: 'no', fallback: 0 }`; the example's
  toggle and the `ReplayGainOptions.fallback` TSDoc both spell this out.
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
- **Focus/interruption events are delivered to the focus *holder* regardless of
  whether it is playing — so "interruption ended, shouldResume" never means
  "you were playing".** Both platforms: Android delivers the full
  `AUDIOFOCUS_LOSS_TRANSIENT`/`AUDIOFOCUS_GAIN` cycle to a paused app that kept
  its focus request (which it should, across a short pause), and AVAudioSession
  sends `began`/`ended(.shouldResume)` to an active session whose player sits
  paused. Resuming on the end-event alone therefore restarts music the user
  explicitly stopped — bug #45, observed 2026-08-13: owner paused via the
  notification, watched Instagram reels (transient focus steals, request/abandon
  cycles as fast as 14 ms apart per `dumpsys audio`), and playback started by
  itself on the reel's focus abandon. The native layers are player-agnostic and
  *cannot* carry a was-playing bit; the latch lives in `wireAudioSession`, which
  consults the player through two optional structural members —
  `isPlaying()` for the answer and `onStateChange()` for its freshness (a
  resume the wire itself issued is stale in `isPlaying()` until the mpv
  property round-trips, and interruptions really do land inside that window —
  hence the wire's resume-pending flag, cleared by the player's next report).
  A user pause is sacred: no claim is taken on an already-paused player, so no
  resume is ever owed for it. Players exposing neither member keep the old
  resume-always behaviour, documented on `AudioSessionPlayerLike`.
- **`stopForeground(STOP_FOREGROUND_REMOVE)` cannot remove a media3
  notification once the service has been demoted.** media3's
  `stopForegroundOnPause` demotion posts the notification with
  `NotificationManager.notify(id, …)` *then* calls
  `stopForeground(removeNotification = false)`
  (`MediaNotificationManager.updateNotificationInternal`, 1.11.0) — after which
  the notification is an ordinary posted notification the foreground-service
  API no longer owns. media3's own removal spells this out
  (`MediaNotificationManager.removeNotification`: both `stopForeground(true)`
  *and* `cancel(notificationId)` are required), and while media3 does run that
  removal when a released session's notification controller disconnects, it is
  an async future chain racing the service's own `stopSelf()`. Bug #46,
  observed 2026-08-13: "stop & dismiss" ended playback but the notification
  survived 14 s with live buttons (the owner's tap on its play button is in the
  logcat as a `MEDIA_SESSION_CALLBACK` FGS grant). `releaseAndStop()` therefore
  cancels `DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID` (1001 —
  ours by the same no-`setNotificationId` invariant the resumption bridge
  notification relies on) synchronously, right after `stopForeground`.
- **Tests prove the code works, not that it ships. A missing workspace link is
  not a build error — it is a smaller APK.** Bug #51, 2026-08-14:
  `@rn-media/cast` passed 121 unit tests, ESLint, `tsc`, `lintRelease` and
  `assembleRelease`, was installed on a device, and was simply not in the app.
  Its `node_modules` link was missing, React Native's autolinking therefore
  enumerated three native modules instead of four, Gradle never configured the
  fourth, and the build SUCCEEDED — there is no step in the Android toolchain
  whose job is to notice that a package it was never told about is absent. The
  released APK carried `libRnMediaPlayer.so`, `libRnMediaAudioSession.so` and
  `libRnMediaMediaSession.so`, and no `libRnMediaCast.so`. Every gate we owned
  was green because every gate we owned inspects the *source*.
  `scripts/check-workspace-links.mjs` is the answer, and it asks both halves of
  the question: (1) does every `packages/*` resolve from `apps/example` — via
  Node's own resolver, since npm hoists workspace links to the root and
  `readdir`-ing `apps/example/node_modules` would be the wrong question — and
  to the in-repo copy rather than a same-named registry package; (2) given
  `--apk`, is each package's `lib/<abi>/lib<PACKAGE_NAME>.so` (name parsed from
  that package's own `android/CMakeLists.txt`) actually inside the built
  artifact. The second check is the one that bit us and is deliberately a zip
  central-directory lookup: `lib/` entries are never renamed by R8, so unlike a
  dex-symbol probe it cannot go flaky under minification, and it needs no SDK
  tooling. Both run in `android-build.yml` — links before the build, APK
  contents after it. Verified against the incident artifact itself: the guard
  fails on the 2026-08-11 debug APK and passes on the post-fix release one.

## Update policy

This file is owned by the architect session. Any change that alters a decision
above — a new default, a changed dependency, a reversed trade-off — updates
this file in the same commit. Implementation agents read it (it is referenced
from CLAUDE.md) and report contradictions rather than silently diverging.
