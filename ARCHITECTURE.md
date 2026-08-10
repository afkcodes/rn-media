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
`afkcodes/libmpv-android-audio-build@v1.1.9-rnmedia.2` and
`afkcodes/libmpv-darwin-build@v0.7.2-rnmedia.2`. Each is pinned by exact tag +
SHA-256 (hard build failure on mismatch) and cached for offline builds; the
repo owner is itself a pin field on both platforms, so re-pointing at upstream
is a one-line change. Forking is deliberate: upstream's audio flavor omits the
HLS/mpegts demuxers **by scoping, not oversight** (their video flavor has
them), so we own the configure flags. The delta versus upstream is additive
configure flags only, and **the two platforms now carry the identical delta**:
hls+mpegts demuxers, plus the same 16 LGPL audio filters incl. aresample (§18)
— same source tree, same patches, and no change to the libmpv ABI we link
(Android's `libmpv.so` and iOS's `Mpv.framework` both export exactly what
upstream did). On iOS, where ffmpeg ships as separate dylibs, exactly two of
the ten grow and the export tries of all ten are byte-identical to upstream's:
`libavformat` gains the mpegts demuxer's three `avpriv_mpegts_parse_*` entry
points and imports the `hls_demuxer_select` chain, and `libavfilter` gains
+103 KB (device slice) of filter objects plus imports of already-exported
libavutil surface (`av_tx_*`, `av_fifo_*`, `av_expr_parse_and_eval`). LGPL v3 (ffmpeg
`--enable-version3`, never `--enable-gpl`), dynamically linked on both
platforms (`.so` in APK, embedded dynamic xcframeworks on iOS) — the
App-Store-accepted pattern that satisfies the relink obligation. Wrapper code
is MIT.

The two forks are **not equally verified**: the Android build is confirmed
playing HLS on a device; the iOS build is link-verified via CI only, and
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
- Kotlin: standalone Gradle harness (placeholder `:app` required — RN's
  gradle plugin only installs dependency substitution under the application
  plugin) + lint.
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
One option, `androidNotificationIcon`, exists because prebuild regenerates
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
- **`--enable-protocol=hls` in an ffmpeg build proves nothing** — it's the
  deprecated `hls://` protocol; only the `hls`+`mpegts` *demuxers* matter.
- **Nor does the string `aresample` in libavfilter** — same family, found while
  verifying the iOS filter build. `libavfilter/formats.c:339` stores
  `.conversion_filter = "aresample"`, the name the graph *looks up* when two
  pads disagree, so the literal is in the binary whether or not the filter was
  compiled. Proof of registration has to come from something only the filter's
  own object file emits (here `af_aresample.c:164`'s log format).
- **mpv 0.35.1's manual documents `replaygain-clip` inverted** vs its own
  code; our API maps to behavior (verified in `player/audio.c`).
- **mpv's waf does not relink `libmpv.so` when ffmpeg's static libs change** —
  a rebuilt `libavfilter.a` next to a stale `.so` looks like a successful build
  and silently ships the old binary (`./build.sh --clean -n mpv` forces it).
  Same false-evidence shape as the `--enable-protocol=hls` trap: always verify
  flags/symbols in the *shipped* artifact, never trust the build log.
- **generator scaffolds contain load-bearing "dead code"**: the ReactPackage
  class is the only trigger of `System.loadLibrary` — deleting it fails only
  at runtime.

## Update policy

This file is owned by the architect session. Any change that alters a decision
above — a new default, a changed dependency, a reversed trade-off — updates
this file in the same commit. Implementation agents read it (it is referenced
from CLAUDE.md) and report contradictions rather than silently diverging.
