# Contributing to timbre

Three independent packages over libmpv, plus one example app that doubles as
the on-device test bed. Everything below is a command that runs today; if one
of them fails on a clean checkout, that is a bug worth an issue.

## Architecture first

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the living record of every decision and
the evidence behind it — read it before writing code. Two rules follow from
that:

- **If your change contradicts a decision, say so.** Open an issue or lead the
  PR description with it. Silent divergence is the one thing this repo does not
  absorb.
- **A change that alters a decision updates `ARCHITECTURE.md` in the same
  commit.** Not a follow-up — the record and the behaviour ship together
  (`b1b27ce`, `8c2dee8`).

[`PLAN.md`](PLAN.md) holds the original analysis and roadmap; §7.5 (video is an
additive plugin, never in core) is settled and not up for revisit.
[`docs/specs/`](docs/specs) carries the per-package contracts.

## Setup

```sh
npm install          # workspace root — installs all packages + the example app
```

Android needs the SDK + NDK (`ANDROID_HOME` set) and JDK 17. iOS needs macOS;
if you are on Linux, write the Swift and let CI compile it — that is how the
iOS side is maintained today.

## The loop

```sh
npm run typecheck                          # every package, strict, no emit
npm run check:readme                       # every README ```ts block, same types
npm --prefix packages/player run test      # vitest, device-free
npm --prefix packages/audio-session run test
npm --prefix packages/media-session run test
npm run test:cpp --prefix packages/player  # host C++ tests (EventBatch, ClientState)
```

The Android side of the loop runs from the example app's Gradle project, which
is where the library modules are composed:

```sh
cd apps/example/android
./gradlew :app:assembleDebug
./gradlew :afkcodes_timbre-media-session:testReleaseUnitTest   # JVM half of media-session
./gradlew :afkcodes_timbre-player:lintRelease \
          :afkcodes_timbre-audio-session:lintRelease \
          :afkcodes_timbre-media-session:lintRelease
```

Those last two are exactly what `Build Android` runs in CI — a lint failure
that only appears on the runner wastes a round trip.

## Running the example app

`apps/example` is the reference integration: a five-entry queue (Shoutcast,
two HLS shapes, a short MP3, a full-length AAC/MP4), focus wiring, the EQ
presets, the native sleep timer, and session persistence across process death.

```sh
npm --prefix apps/example run start                    # Metro
npm --prefix apps/example run android                  # build + install + launch
# or, against a device you already have attached:
cd apps/example/android && ./gradlew :app:installDebug
```

Native changes (C++, Kotlin, Swift, or anything under `nitrogen/generated/`)
need a rebuild, not a Metro reload. If you touched a Nitro spec, regenerate
first: `npm run codegen --prefix packages/<pkg>`.

## What "tested" means here

- **TS logic is tested without a device.** State reduction, position
  projection, queue arithmetic, persistence encoding, the filter/EQ grammar —
  all of it is pure and reachable from vitest with injected fakes. If a change
  needs a device to be tested, look again at where the seam should be.
- **C++ keeps logic separate from mpv calls** so the logic half is host-testable
  (`npm run test:cpp`); mpv interaction is covered by the example app.
- **Playback claims are verified on a physical Android device — never an
  emulator.** "It builds" is not evidence that audio came out, that the
  notification round-tripped, or that the session survived
  `adb shell am force-stop`. Claims of that kind belong in the commit message
  with the measurement attached (see `33a36ff`: notification up at +59 ms,
  audio at +377 ms, from a killed process).
- **iOS is CI-verified only.** It compiles, links, and embeds the frameworks;
  no on-device run has happened. Do not upgrade an iOS claim past what CI
  actually proves — `8c2dee8` exists because that line was crossed once.
- **Every README code sample typechecks**, and one command proves it:

  ```sh
  npm run check:readme      # extracts every ```ts / ```tsx block, tsc --noEmit
  ```

  It reads the five shipped READMEs (root + the four packages) and the recipes
  in `docs/recipes/`, writes each block to a gitignored `.readme-samples/` as a
  standalone module with
  `@afkcodes/timbre-*` mapped at the packages' `src`, and reports failures at
  `README.md:LINE` — the README's line, not the generated file's. Fix the
  sample; never the check. A block that is deliberately partial (an options
  object quoted on its own) opts out with ` ```ts fragment `, and the summary
  prints how many did, so the count stays honest. The small list of ambient
  declarations a sample may lean on — the `station` the prose introduced, the
  `player` an earlier block created — lives in `AMBIENTS` in
  `scripts/check-readme-samples.mjs`, per README, and is meant to stay small.

  This is not ceremony: the sweep in `ff6cadc` caught three invalid
  `MediaControl` names and a seconds-vs-milliseconds anchor that would have put
  a copy-paster's lock-screen scrubber off by 1000×.
- **Bug fixes land with a regression test** wherever one is feasible.

## Dependencies and binaries

Never write a version from memory. Resolve it from the source of truth —
`npm view <pkg> version` for npm, the releases API for GitHub artifacts, the
registry for Pod/Gradle coordinates — and the same goes for API signatures
(nitro.margelo.com, developer.android.com, developer.apple.com). Dependabot
handles routine bumps under the policy in `ARCHITECTURE.md` §17.

The prebuilt libmpv binaries are ours, pinned by exact tag **and** SHA-256, and
a mismatch is a hard build failure. Changing a pin means changing the fork, and
the fork's delta is deliberately additive configure flags only, LGPL flavour,
never `--enable-gpl`. Read [`PLAN.md`](PLAN.md) §6 and
[`ARCHITECTURE.md`](ARCHITECTURE.md) §11 before touching either.

## Docs: a README states what is true now

Three files, three jobs, and they do not overlap:

| File | Answers | Never contains |
|---|---|---|
| `README.md` (root and per package) | What it is, how to install and use it, what it needs, what it cannot do | dates, history, how something was verified, who found what, device names, rationale longer than one sentence |
| `ARCHITECTURE.md` | Why it is built this way, and the evidence | — |
| `PLAN.md` | What is next and why | — |

When you write a paragraph for a README, give it one of three fates before it
lands: a **constraint the caller must know** becomes one sentence in the
table's notes column; a **design rationale** becomes a link to the
ARCHITECTURE section that already holds it in full; **history** is deleted.
"We used to", "was corrected", "verified on the POCO" are ARCHITECTURE
sentences. Limitations are one line each.

Budgets, so the shape holds: root README ≈ 250 lines with one inline recipe
(the rest live in `docs/recipes/`); a package README ≈ 300–400. Every code
block still passes `npm run check:readme`.

## Commits and PRs

Conventional commits, scoped by package:

```
feat(media-session): playback resumption after process death (Android)
fix(player): ...
docs(architecture): §11 reflects the rnmedia.2 Android pin and filter delta
chore(deps): group Dependabot updates weekly; ignore template-pinned deps
```

The body is where this repo keeps its memory. State what changed, why the
alternative was rejected, and what you measured — including the numbers that
made you change course. `78835dd` records why the sleep timer is a native
`Handler` and not `AlarmManager`, and that it fired at +45.002 s with zero
Activities alive. `33a36ff` records a deviation from its own design brief, with
the reason. That is the bar: a reader six months out should not have to
re-derive your reasoning.

Open PRs against `main`. The checklist in the PR template is the same standard
as this file — tests, docs, and `ARCHITECTURE.md` when a decision moved.
