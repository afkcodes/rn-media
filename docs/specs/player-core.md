# Spec: `@afkcodes/timbre-player` core (C++ binding + TS API)

Architect-owned interface contract for Tasks 2 & 5. Implementation agents: follow this
spec; where Nitro syntax specifics are needed, verify against current nitro.margelo.com
docs — do not write Nitro API shapes from memory. Same for mpv: verify against
`mpv/client.h` in the vendored headers, not recollection.

## Design stance

The native HybridObject is a **thin, complete, generic libmpv client binding**.
All typed convenience (play/pause semantics, state objects, queue API) lives in
TypeScript on top of it. Rationale:

- The raw escape hatch (`command`, properties, observation) falls out for free and is
  guaranteed complete — mpv gains features without native releases.
- The C++ surface stays small, stable, and reviewable; the TS layer is cheap to iterate.
- Native code adds value only where TS cannot: threading, event batching/coalescing,
  lifecycle safety, (later) surface attachment and JVM wiring.

## 1. Native HybridObject: `MpvClient` (spec file `MpvClient.nitro.ts`)

One instance = one `mpv_create()` core. Multi-instance is mandatory.

### Lifecycle
- Created via Nitro factory; constructor takes no args. `initialize(options: Record<string, string>): void`
  applies pre-init options (`mpv_set_option_string`) then `mpv_initialize()`.
  Audio-only defaults are applied natively before user options: `vid=no`,
  `force-window=no`, `idle=yes`, `audio-display=no`, plus log level request.
- `destroy(): void` — idempotent. Stops the event loop, cancels callbacks, then
  `mpv_terminate_destroy` **on a background thread** (it blocks; never on JS thread).
  Every other method after destroy throws a typed `disposed` error (never crashes).
- TS finalizer/dispose pattern per current Nitro guidance; explicit `destroy()` is
  the contract, GC is the backstop.

### Commands & properties (all thread-safe per mpv docs; called from any thread)
- `command(args: string[]): Promise<void>` — `mpv_command_async`; promise resolves on
  `MPV_EVENT_COMMAND_REPLY`, rejects with mpv error string on failure.
- `getPropertyString/Number/Bool(name): T | undefined` — sync (Nitro sync calls are
  cheap); undefined when `MPV_ERROR_PROPERTY_UNAVAILABLE`, throw on other errors.
- `setPropertyString/Number/Bool(name, value): void` — sync set (`mpv_set_property`),
  throws typed error on failure. (Async variant not exposed until profiling shows need.)
- `observeProperty(name: string, format: 'string'|'number'|'bool'): void` /
  `unobserveProperty(name: string): void`

### Event delivery (the performance-critical part)
- One dedicated native thread per instance runs `mpv_wait_event` (the only thread
  allowed to, per mpv contract).
- Native thread pushes into a lock-guarded batch buffer; a scheduled flush delivers
  **one batched callback** to JS: `onEventBatch(events: MpvEvent[])`.
  - Flush trigger: first event schedules a flush on the JS thread (via Nitro callback
    dispatch); everything queued until the flush executes rides the same batch. No
    timers, no polling.
  - **Coalescing:** within a pending batch, property-change events for the same
    property keep only the latest value. Discrete events (`end-file`, `start-file`,
    `seek`, `playback-restart`, `idle`, `log`) are never coalesced.
- `MpvEvent` is a discriminated union (Nitro variant/union support — verify current
  syntax): `{ kind: 'property', name, value } | { kind: 'endFile', reason, error? } |
  { kind: 'startFile' } | { kind: 'seek' } | { kind: 'playbackRestart' } |
  { kind: 'log', level, prefix, text } | { kind: 'shutdown' }`.
- No per-event heap allocation on the event thread beyond the queued value itself;
  reserve/reuse buffers.

### Reserved for future plugins (declare now, implement minimally)
- `attachVideoOutput(handle: bigint): void` / `detachVideoOutput(): void` — no-op
  stubs in core (throw `unsupported` with message pointing to the video plugin).
- `getRawHandle(): bigint` — the `mpv_handle*` as uintptr for the video plugin.

## 2. C++ internal structure (packages/player/cpp/)

```
MpvClient.hpp/.cpp      RAII owner: mpv_handle, event thread, batch buffer.
                        No Nitro types included — pure mpv + std.
EventBatch.hpp          Batch buffer + coalescing logic. Header-only, unit-testable
                        without mpv (values as std::variant).
HybridMpvClient.hpp/.cpp  Nitro glue only: converts, forwards, owns MpvClient.
```
- Threading contract documented at the top of MpvClient.hpp.
- `EventBatch` coalescing gets host unit tests (plain C++ test or via TS tests against
  a mock — implementer's choice, but it must be tested without a device).

## 2.5 AS-BUILT ADDENDUM (2026-08-09, architect-reviewed and accepted)

The native layer is implemented; §1's shapes were adjusted where Nitro forced it.
**Task 5 builds against the real spec in `src/specs/mpv-client.nitro.ts`, with:**

- `MpvEvent` is a FLAT struct with `kind: MpvEventKind` (Nitro rejects literal
  discriminators). Task 5 MUST map it to a proper TS discriminated union at the
  reducer input boundary and switch exhaustively on it.
- Enum renames (C macro collisions): end-file reason `'endOfFile'` (not `'eof'`),
  log level `'debugging'` (not `'debug'`). The Player-level API may expose nicer
  names; the mapping lives in one place.
- Event delivery: `setEventBatchListener(cb: (events: MpvEvent[]) => boolean)` —
  the boolean return is a back-pressure signal (`true` = keep listening); Nitro
  turns it into a `Promise<bool>` completion clock giving exactly-one-batch-in-
  flight. The Player class returns `true` unless destroyed.
- `getRawHandle(): UInt64` (Nitro has no bare bigint).
- Errors from native carry message prefixes `[mpv:disposed]`, `[mpv:invalid-state]`,
  `[mpv:unsupported]`, `[mpv:<errno>]` — Task 5's error mapper keys off these.
- `initialize(options)` consumes a reserved `log-level` key (default `warn`).
- Known limitation (accepted): init options are unordered — document that
  `profile`/`include` ordering is unsupported.
- Deprecated mpv `idle` event is not forwarded; observe `core-idle` instead.

AS-BUILT ADDENDUM (2026-08-11): source resolution. Six methods on the spec —
`installSourceResolver(timeoutMs)` / `uninstallSourceResolver()` /
`setResolvedSource(logical, resolved, ttlMs)` / `clearResolvedSources()` /
`completeResolution(logical, resolvedOrNull)` /
`setResolutionRequestListener(cb: (request: SourceResolutionRequest) => void)`,
where `SourceResolutionRequest` is `{ uri: string; entryId?: number }`.
Deliberately a separate callback channel, NOT a new `MpvEventKind`: a
core-blocking resolution request must not queue behind the event batch's
one-in-flight back-pressure clock, and the enum stays clear of the JNI/macro
traps above. Hook handling (mpv `on_load` + our fork's `on_prefetch_load`)
lives on the existing event thread; cache hits are synchronous native lookups;
the bounded play-time hold is `ResolutionGate` in `cpp/SourceResolution.hpp`
(unit-tested host-side). Hooks can never be unregistered (mpv has no API for it)
— an uninstalled resolver leaves a pass-through handler that continues
immediately. **Registration was lazy at first and is not any more; see the
2026-08-12 addendum.**

AS-BUILT ADDENDUM (2026-08-12): queue insertion + `prefetchStarted`.

**`playlist.add(source, { position, play })`.** `position` is `'next'` or a
0-based index; `play` is mpv's `*-play` variant ("start playback if nothing is
currently playing" — not "play now"). The 2×3 table compiles to exactly one
`loadfile` per add: `append` / `append-play` / `insert-next` /
`insert-next-play` / `insert-at` / `insert-at-play`, with the index in
`loadfile`'s third argument (mpv 0.38+; `buildLoadfileArgs` writes the `-1`
placeholder only when the fourth argument is needed and the third is not). No
`append` + `playlist-move` pair anywhere — that is two mutations with a window
where the queue is wrong, readable by observers and by mpv's own prefetch. A
numeric `position` is **rejected**, not clamped, when it is not an integer in
`0 … playlist-count` (read from mpv at call time, snapshot as fallback): mpv
silently appends an out-of-range index, which hides an off-by-one. Documented
caveat, from the #25 research and re-verified against 0.41.0 source: an entry
inserted while an opener is already running is not prefetched
(`prefetch_next()` returns early on `mpctx->open_active`, `loadfile.c:1278`) and
the in-flight prefetch is dropped by URL comparison at the boundary
(`open_demux_reentrant`, `loadfile.c:1223`).

**`player.on('prefetchStarted', cb)`** with payload `{ uri, entryId? }`.
Transport: a **third dedicated Nitro channel**
(`setPrefetchStartedListener` + the `PrefetchStartedEvent` struct), NOT a new
`MpvEventKind`. Reasons, in order of weight: (a) it is produced inside
`handleHook`, and hook-derived messages deliberately never enter the event batch
— the batch is delivered one at a time behind a completion promise, so a timing
signal riding one becomes arbitrarily late exactly when the system is busy;
(b) the batch's `MpvEvent` has no field for a URL or an entry id, so the batch
route means overloading `name` (already property-name-or-log-prefix) with a URL
and `value` with an id; (c) `MpvEventKind` feeds the `PlayerEvent` union that
`reducePlayerState` switches on exhaustively, and this event reduces to nothing
— a state union should not grow a non-state member; (d) it keeps the enum clear
of the macro/JNI traps recorded above. The channel returns `void` and carries no
back-pressure, because the hook has already been continued when it fires and
nothing in mpv is waiting.

**Hook registration moved from `installSourceResolver` to `initialize`, always.**
The fork patch guarantees stock behaviour only while the hook *name* has no
client at all ("With no client registered the added cost is one
`mp_hook_exists()` call […] and nothing else", `006.rn_media_prefetch_hook.patch`
§THREADING AND COST), so registering late does not buy stock behaviour — it only
moves the instant behaviour changes into the middle of a session. Accepted cost:
one immediate `mpv_hook_continue` per load boundary on every player, resolver or
not. This supersedes the "registered lazily on first install" line above, and the
"Cost when not installed. Zero, and that is enforced by construction" wording in
`Player.setSourceResolver`'s TSDoc and in the package README (both rewritten).
ARCHITECTURE.md carries no lazy-registration claim, so nothing there is stale;
ARCHITECTURE §11's prefetch-patch paragraph is unaffected.

AS-BUILT ADDENDUM (2026-08-12): the play-time hold parks the event thread, and
three hot-path costs that were measured rather than reasoned about.

**The play-time resolution hold blocks command replies, not just mpv.** The
`ResolutionGate` wait is taken *on the event thread* (`MpvClient.cpp`,
`handleHook`), which is the only thread calling `mpv_wait_event`. For its
duration — up to `resolverTimeoutMs`, default 10 s — no property change and no
`MPV_EVENT_COMMAND_REPLY` reaches JavaScript, so a `seekTo()`/`play()`/
`command()` Promise issued during an unresolved play-time load stays pending
until the hold ends. Bounded, never lost, and it also risks
`MPV_EVENT_QUEUE_OVERFLOW` on a long hold with a busy core. **Kept as designed**,
documented at `PlayerOptions.resolverTimeoutMs` and on
`DEFAULT_RESOLVER_TIMEOUT_MS`: resolve-ahead answers the current and next entry
as the queue moves, so the play-time path should be cold, and `0` disables
holding entirely for an app that would rather fail fast. The alternative —
parking a dedicated waiter so `mpv_wait_event` keeps draining — was considered
and deferred: a second synchronisation object plus a hook continuation issued
from a thread that never received the hook, to improve a path the design already
makes rare.

**A second HybridObject in this package: `RnMediaScreenState`** (`android:
kotlin`, `ios: c++`, singleton by nature — one display per device). `interactive`
is `PowerManager.isInteractive()`; `addScreenStateListener` registers an
`ACTION_SCREEN_ON`/`ACTION_SCREEN_OFF` receiver *derived from the listener set*,
so a process with nothing observing holds no receiver. The iOS side is a
constant `true` in C++ — locking an iPhone backgrounds the app and no iOS app is
foreground-active with the display off, so `AppState` is already the display
truth there, and a constant does not justify introducing Swift into the pod. It lives in `@afkcodes/timbre-player`, not
in `@afkcodes/timbre-audio-session`, because its only consumer is this package's
visualizer and a player-only install must not have to add a second native module
to stop burning battery; the display is also not an audio-session concern.
Consumed through the `ScreenStateSource` interface (`src/screen-state.ts`), which
is replaceable via `setScreenStateSource()` for tests and for surfaces that are
not the device display.

**`getMetadata()` is one node read, not `2N + 1` scalar reads.** New spec method
`getPropertyMap(name): Record<string, string> | undefined` — one
`mpv_get_property(MPV_FORMAT_NODE)` converted natively through the existing
`MpvClient::getPropertyNodeMap` visitor (the same primitive the PCM tap uses),
with non-string members skipped rather than coerced. The `metadata/list/…` walk
it replaces cost 41 blocking round-trips for a 20-tag FLAC, issued from inside
the event-batch handler at a track boundary. `metadataKeyProperty` /
`metadataValueProperty` / `metadata/list/count` stay public — they are still the
only way to ask for one entry *by position* — but nothing in the library walks
them any more.

**Synchronous reads per event batch are now budgeted at 5, worst case**
(`time-pos` 1 + track-change 3 + `metadata` 1), down from `6 + 2N`. Resolve-ahead
no longer runs inline from `#handleBatch`: it is dispatched with
`queueMicrotask`, so its two `playlist/N/filename` reads leave the reducer's turn
while still running before any timer or native callback — "resolved as soon as
the queue moves", the only ordering the `SourceResolver` docs promise, is
unchanged.

**`bufferedPosition` is second-granular.** `demuxer-cache-time` arrives ~4-6 Hz
in steady playback (and keeps arriving while paused), and each accepted value
minted a `PlayerState` plus a full listener fan-out — the one property that made
"state changes only on discontinuities" untrue for a whole session. The reducer
now adopts a value only when it moved ≥ `BUFFERED_POSITION_STEP` (1 s) or when
it crosses the current `duration`, the latter so "fully buffered" is always
observable exactly. The value itself is still mpv's, unrounded; what is
quantised is how often it changes.

```ts
const player = await Player.create({ /* typed options + raw mpv overrides */ });

await player.load('https://…/track.flac');          // single source
await player.loadPlaylist(sources, { startIndex });  // gapless via mpv playlist
player.play(); player.pause(); player.toggle();
await player.seekTo(seconds);                        // absolute; exact seek
player.setRate(1.5); player.setVolume(0.8); player.setMuted(true);
player.setLoop('off' | 'track' | 'playlist');
player.playlist.add/remove/move/jumpTo(...);

player.state;                                        // PlayerState snapshot (see below)
const unsub = player.onStateChange(listener);        // whole-state subscription
player.on('trackEnded' | 'error' | 'trackChanged', cb); // discrete events
player.getPosition();                                // PROJECTED locally — see contract
await player.command(['loadfile', uri, 'append']);   // raw escape hatches
player.destroy();
```

### PlayerState (single immutable snapshot, discriminated `status`)

> **AS-BUILT NOTE (2026-08-09):** the snippet below is the original design sketch
> and is no longer normative — the authoritative shape is `src/state.ts`
> (`PlayerState`), which additionally carries `loopRaw`, `title`, `seeking`,
> `coreIdle`, `idleActive`, `eofReached`, `seekable?` (tri-state), and `isLive`
> (derived `seekable === false && !idleActive`; while live, `duration` is
> suppressed as `undefined` — mpv reports growing cache length there, proven
> on-device). HLS-looking URIs (`.m3u8`/`.m3u`) get `demuxer=lavf` per-load
> unless the caller overrides, to defeat mpv's playlist-demuxer queue explosion.
```ts
type PlayerStatus = 'idle' | 'loading' | 'buffering' | 'ready' | 'ended' | 'error';
interface PlayerState {
  status: PlayerStatus;
  playing: boolean;          // intent (pause property inverse)
  duration?: number;
  positionAnchor: { position: number; timestamp: number; rate: number }; // for projection
  bufferedPosition?: number;
  rate: number; volume: number; muted: boolean;
  loop: LoopMode;
  playlist: { index: number; count: number };
  error?: PlayerError;       // present iff status === 'error'
}
```
- Built by a **pure reducer**: `(state, MpvEvent) → state`. This reducer is where
  observed mpv properties (`pause`, `duration`, `seeking`, `core-idle`,
  `eof-reached`, `playlist-pos`, `playlist-count`, `demuxer-cache-time`, `speed`,
  `volume`, `mute`) map to PlayerState. Fully unit-tested with recorded event fixtures.

### Position projection contract (never poll natively)
- `time-pos` is **not** observed. `positionAnchor` updates only on discontinuities:
  seek/playback-restart, pause/unpause, rate change, track change (these arrive as
  events already).
- `getPosition() = anchor.position + (playing ? (now - anchor.timestamp) * rate : 0)`,
  clamped to duration.
- `useProgress(player, intervalMs = 250)` hook re-renders on that projection; a
  one-shot precise resync (`getPropertyNumber('time-pos')`) runs on subscribe.

### Error taxonomy
```ts
type PlayerError =
  | { code: 'network'; ... }       // end-file error during network playback (premature EOF)
  | { code: 'unsupported-format'; ... }
  | { code: 'load-failed'; ... }
  | { code: 'disposed' }
  | { code: 'mpv'; raw: string };  // anything unmapped, with mpv's error string
```
- `trackEnded` (natural eof) and `error` (premature/failed) are **distinct events**;
  mapping from mpv `end-file` reason + error code, unit-tested.

### Hooks (`src/hooks/`)
- `usePlayer(setup?)` — creates on mount, destroys on unmount.
- `usePlayerState(player, selector?)` — subscription with selector to limit re-renders.
- `useProgress(player, intervalMs?)`.

### AS-BUILT (2026-08-10): audio filters
`setAudioFilters(filters)` / `clearAudioFilters()` / `getAudioFilters()` — typed
chain over mpv's `af` property (one mpv entry per filter, mpv's own serializer
incl. `%N%` UTF-8 byte-count escaping), factories range-validated against ffmpeg
n8.1.2 AVOptions (re-audited bound-for-bound 2026-08-14, #51 — originally taken
from n6.0, which the engine has not shipped since the `rnmedia.5`/`.4` move; no
wrapped range actually moved), 22 EQ presets with summed-response headroom
pre-amp. NOTE: `af`
is a GLOBAL option, not per-entry — filters survive track changes by design.
Requires Android binaries ≥ v1.1.9-rnmedia.2 or iOS binaries ≥ v0.7.2-rnmedia.2
— both pins now carry the identical 16-filter set, so no platform branching. On
binaries older than those, calls fail honestly with `{code:'mpv', errno:-11}`
(documented as the availability probe).

### AS-BUILT (2026-08-11): visualizer

`player.visualizer.subscribe(listener, options?) → unsubscribe`, plus
`player.visualizer.capabilities` / `.active` and the
`useVisualizer(player, options?, enabled?)` hook. **Both platforms, one code
path, no permission** (ARCHITECTURE §21): the samples come from mpv itself
through two properties added by this project's libmpv patch — the same patch
file in both binary forks. `capabilities.fft` is `false` only when the linked
libmpv predates it, and `subscribe()` then throws a typed `unsupported` error.

Deviations from the task sketch, with reasons:

- **The engine changed after it was built.** The first implementation used
  `android.media.audiofx.Visualizer` and shipped as far as a device before being
  rejected: Android-only, `RECORD_AUDIO` from every consumer, ~20 Hz, 8-bit.
  Patching libmpv replaced all four problems with one rebase liability, priced in
  §11. The Kotlin `AudioVisualizer` HybridObject, its spec, its fake and the
  `permission-denied` error member were all deleted; `MpvClient` remains this
  package's only hybrid, and it is still pure C++ (§2).
- **`subscribe()` is the primitive; there is no `start(opts)`/`stop()` pair.**
  The sampler thread and mpv's ring are derived from the listener set, so they
  cannot be leaked. A free-standing `start()` could only mean "hold the tap open
  with nobody looking".
- **No `visualizerFrame` entry on `player.on(...)`.** The event map is for
  discrete, always-on events with no per-listener configuration; a
  high-frequency stream whose *cost* depends on subscription needs its own
  refcounted channel, or `player.on` becomes the one API where adding a listener
  allocates a thread.
- **The FFT is native, the optics are TypeScript.** PCM never crosses the
  bridge: `PcmTap` (C++) downmixes, Hann-windows and transforms on its own
  thread and delivers ~4 KB of linear magnitudes per frame, calibrated so a
  full-scale sinusoid reads `1.0`. Bands, dB window, smoothing and peak
  ballistics stay in TS, per subscriber, and are unit-tested device-free.
- **Back-pressure drops rather than queues.** Events coalesce because an unseen
  property change still has to be applied; a spectrum that arrived while JS was
  busy is a picture of the past. Skipped ticks are counted in `frame.dropped`.
- **Defaults represent the audio.** `tiltDbPerOctave` and `autoGain` both
  default to **off**; the dB window (-40…-10 dBFS) was set by measuring real
  material on a device, not chosen for looks.

New native surface, all on the existing `MpvClient` spec: `startVisualizer`,
`stopVisualizer`, `setVisualizerListener` and the `VisualizerCapture` struct
(the first use of Nitro `ArrayBuffer` in this package, verified against
`react-native-nitro-modules@0.36.5`). Below it, `MpvClient` gained one genuinely
generic primitive — `getPropertyNodeMap(name, visit)`, a zero-copy visitor over
any `MPV_FORMAT_NODE_MAP` property including its byte-array members — plus two
thin typed wrappers over the patch's properties. New host-compiled C++ suites:
`FftTests` and `PcmTapTests` (22 cases, ThreadSanitizer-clean).

## 4. Acceptance criteria (both tasks)
- `nitrogen` codegen + strict `tsc` pass; TS tests green (reducer, projection,
  coalescing, error mapping — with fixtures, no device).
- No JS-thread blocking calls; no `time-pos` observation anywhere.
- `destroy()` is provably safe: destroy-while-loading and double-destroy covered by tests.
- Public API fully TSDoc'd. No `any`, no non-exhaustive switch on unions.
- Example app can create two players and play both (multi-instance proof) — full
  on-device verification lands with Task 8.
