# Spec: `@rn-media/player` core (C++ binding + TS API)

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

## 3. TS public API (`packages/player/src/`)

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
n6.0 AVOptions, 22 EQ presets with summed-response headroom pre-amp. NOTE: `af`
is a GLOBAL option, not per-entry — filters survive track changes by design.
Requires Android binaries ≥ v1.1.9-rnmedia.2 or iOS binaries ≥ v0.7.2-rnmedia.2
— both pins now carry the identical 16-filter set, so no platform branching. On
binaries older than those, calls fail honestly with `{code:'mpv', errno:-11}`
(documented as the availability probe).

## 4. Acceptance criteria (both tasks)
- `nitrogen` codegen + strict `tsc` pass; TS tests green (reducer, projection,
  coalescing, error mapping — with fixtures, no device).
- No JS-thread blocking calls; no `time-pos` observation anywhere.
- `destroy()` is provably safe: destroy-while-loading and double-destroy covered by tests.
- Public API fully TSDoc'd. No `any`, no non-exhaustive switch on unions.
- Example app can create two players and play both (multi-instance proof) — full
  on-device verification lands with Task 8.
