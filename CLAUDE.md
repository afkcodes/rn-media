# rn-media — Project Guide

React Native audio (+ later video-as-plugin) playback library built on **libmpv**,
with a player-agnostic media-session layer inspired by Flutter's `audio_service`.
Read `ARCHITECTURE.md` FIRST — it is the living record of every decision and its
why, plus the platform traps we build around; report contradictions rather than
silently diverging, and any change that alters a decision updates that file in
the same commit. `PLAN.md` holds the full analysis and roadmap. Decisions in
PLAN.md §7.5 (video is additive, never in core) are settled — do not revisit.

## Working model (mandatory)

- The **main session acts as architect + reviewer**: designs interfaces, writes/approves
  specs, and personally reviews every line before it is accepted. The architect does
  not bulk-implement.
- **Implementation is done by Opus subagents**, each given a narrowly scoped task with
  the interface contract, acceptance criteria, and the relevant sections of this file.
- Nothing is "done" until it (a) compiles/passes tests, (b) has been reviewed by the
  architect, and (c) review findings are fixed and re-verified.

## Engineering principles (non-negotiable)

1. **Performance first.** This is a media library; jank is a bug.
   - Never block the JS thread. All libmpv calls run on native threads; events are
     batched/coalesced before crossing into JS.
   - Position/time is never streamed continuously across the bridge — broadcast on
     discontinuities only; clients project position locally.
   - High-frequency data (FFT, PCM) is lazy and opt-in.
   - No per-event allocations in hot paths (event thread, property dispatch).
2. **Modular.** Three independent packages (`player`, `audio-session`, `media-session`)
   with explicit contracts between them. `media-session` must work with ANY player,
   not just ours. Core never links video code (`mpv/client.h` only, never `render.h`).
3. **Clean & maintainable.**
   - TypeScript strict mode; no `any` in public API; exhaustive discriminated unions
     for events/state.
   - C++: RAII everywhere (no naked new/delete), clear ownership (unique_ptr/shared_ptr
     with documented rationale), no raw thread primitives where a helper exists.
   - Small files, one responsibility each. No god objects.
   - Public API documented with TSDoc; native internals commented only where the
     constraint is invisible (threading contracts, mpv quirks/workarounds — always
     cite the upstream issue).
4. **Well tested.**
   - TS layer: unit tests (Vitest/Jest per template) for state reduction, position
     projection, queue logic — everything testable without a device.
   - C++ core: testable logic (state mapping, coalescing) separated from mpv calls
     so it can be unit-tested; mpv interaction covered by the example app + on-device
     checks.
   - Every bug fix lands with a regression test where feasible.
5. **Scalable.** Multi-instance players from day one; no singletons in `player`.
   Singletons only where the OS itself is singular (audio focus, media session).
6. **Honest error handling.** Typed error taxonomy (network EOF vs natural end vs
   unsupported format). No swallowed errors; no `catch {}`.

## Dependency policy (mandatory)

- **Never write a dependency version from model memory.** Before adding or pinning
  anything, resolve the latest stable from the source of truth:
  - npm: `npm view <pkg> version` / `npm view <pkg> dist-tags`
  - GitHub release assets (libmpv builds): query the releases API
  - Pod/Gradle artifacts: check the registry/repo directly
- Same rule for APIs: when using Nitro/media3/AVAudioSession APIs, verify signatures
  against current docs (nitro.margelo.com, developer.android.com, developer.apple.com)
  — not memory. Scaffolds come from the official generators (`create-nitro-module`),
  not hand-written from recollection.
- Prebuilt libmpv binaries: media-kit's `libmpv-android-audio-build` and
  `libmpv-darwin-build` release artifacts, LGPL flavor only (`default`), pinned by
  exact release tag + checksum in one place.

## Architecture snapshot

```
packages/player          Nitro pure-C++ HybridObject over libmpv client API; TS Player class + hooks
packages/audio-session   Kotlin/Swift Nitro module: focus, AVAudioSession, interruptions, noisy
packages/media-session   Player-agnostic handler; media3 MediaSessionService (Android),
                         MPRemoteCommandCenter/MPNowPlayingInfoCenter (iOS); FGS lifecycle
apps/example             Demo app: queue + background + notification; the on-device test bed
```

Key contracts (details in PLAN.md):
- Player exposes `attachVideoOutput/detachVideoOutput` + raw handle for the future
  video plugin; installing the plugin must require zero core changes.
- media-session fan-in: all remote surfaces → one handler interface. Fan-out: three
  broadcast channels (`playbackState`, `mediaItem`, `queue`) are the only state source
  for every surface including the app UI.
- One JS runtime kept alive by platform primitives (FGS on Android, audio background
  mode on iOS). No separate JS context for the "service".

## Environment notes

- Dev machine is Linux: Android builds/tests run locally (SDK+NDK present); iOS code
  is written here but compiled only on CI/macOS — structure iOS work so CI catches it.
- Naming: npm scope placeholder is `@rn-media/*` until the final name is chosen;
  keep the name in as few places as possible to make the rename cheap.
