# Spec — simplify the example app (architect contract)

Owner mandate: **one example app**, made to show "the proper way … the simpler
way of doing everything." Most people avoid complex setup; the example must
model the idiomatic minimal-but-complete wiring a normal app writes — **not** a
maximally-decomposed test harness. Class-based is fine; volume of ceremony is
the problem.

## The problem

`apps/example/src/playback/` is ~4,300 lines across 12 files: `controller`
(658, "owns everything"), `session` (471, fan-out), `cast` (757), `handler`
(304, fan-in), `transport` (237), `queue` (235), `broadcast` (232), `browse`
(276), `engine` (200), plus self-tests. That separation is library-grade
reference, not how an app developer would (or should) wire this. A newcomer
cannot learn the simple path from it.

## Target: the proper simple way

A real app writes roughly this, and the example must read like it:

```
Player.create → wireAudioSession → MediaService.init(one handler) → broadcast on state change
```

### New structure (ONE app, unchanged package deps)

```
apps/example/src/
  playback.ts        THE setup, ~150 lines, heavily but tightly commented — the
                     file people copy. Module-scope singleton started from
                     index.js. Contains: Player.create (with the resolver),
                     wireAudioSession, MediaService.init with ONE class handler
                     built as `withQueueHandling(BaseMediaHandler)` +
                     wrapped in `withPersistence`, and a single `broadcast()`
                     that projects PlayerState → the three channels on every
                     state change. No controller/session/transport/handler
                     split.
  catalogue.ts       the tracks (from data/tracks.ts) + the demo resolver map.
  resolver.ts        keep as-is (99 lines, already idiomatic).
  App.tsx            hooks-first UI (~150 lines): usePlayerState / useProgress
                     for now-playing + a SeekBar, transport row, QueueList. The
                     three feature sections that most apps DO add — EQ, Cast,
                     Sleep timer — stay, each a small self-contained component
                     driven by the same player/service. Nothing reads a
                     "controller".
  components/        keep the good UI (NowPlaying, SeekBar, QueueList,
                     EqualizerSection, CastSection, ErrorBanner). Trim any that
                     only existed to drive the old abstraction.
  advanced/          the genuinely-advanced, teach-by-example demos that are NOT
                     the common path, moved here and clearly labelled as
                     advanced, still reachable from an "Advanced" section:
                     the car browse tree (Android Auto/CarPlay), the content://
                     probe, the cast self-test, output routing, loudness. They
                     keep working; they are just not what a newcomer reads first.
```

### Principles the refactor must hold

1. **Collapse, don't lose behaviour.** Persistence (`withPersistence` + MMKV),
   queue ops (`withQueueHandling` — don't hand-roll skip logic), the source
   resolver, ICY station names, retry/error surfacing, and the anchor-based
   broadcast (position as `positionAnchorMs`, discontinuity-only) all remain —
   just expressed directly in `playback.ts` instead of spread across seven
   files. The point is fewer concepts, not fewer features.
2. **Use the library's own conveniences** so the example teaches them:
   `withQueueHandling(BaseMediaHandler)` (not a hand-written skip handler),
   `withPersistence`, `usePlayerState`/`useProgress`/`useEqualizer` hooks in the
   UI. If the example still needs to hand-roll something the library should
   provide, FLAG it in the report — that is an API-DX finding.
3. **Comments teach, tersely.** Every non-obvious line in `playback.ts` gets a
   one-line why. No essays. This file is the de-facto tutorial.
4. **The advanced split is by "would a first app write this?"** EQ/cast/sleep
   are common enough to stay on the main screen; Auto/CarPlay browse,
   content:// fd, cast self-test, output routing are advanced.
5. **Keep it device-verifiable.** Core playback, queue, lock-screen/notification,
   background, persistence restore, EQ, and cast must still work on the POCO.

## Acceptance

- `apps/example` typechecks; its vitest suite passes (update tests that
  referenced the removed modules — keep the meaningful assertions, e.g. the
  cast projection test, re-pointed at the new module).
- `playback.ts` is the whole common-path setup and reads top-to-bottom as a
  tutorial; total `src/` (excluding `advanced/` and `components/`) is a large
  cut from today (target: the 7 collapsed files → ~250 lines).
- Debug build installs and runs on the POCO F4 (serial 895e7ead): plays, queue
  next/prev, lock-screen controls, background survives, persistence restores,
  EQ audibly changes, and the app does not regress the content:// / cast /
  browse demos (now under Advanced).
- `npm run check:readme` still green (the recipes reference these patterns).
- Private-fixture grep clean; no `@rn-media`/old-brand residue.

## Out of scope

No package/source changes to the four libraries (unless an API-DX finding is
raised for the architect to decide). No second app. No new deps.
