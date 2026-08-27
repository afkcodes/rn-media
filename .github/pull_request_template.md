<!--
Conventional commit title, scoped by package, e.g.
  feat(media-session): playback resumption after process death (Android)
-->

## What and why

<!--
What changed, and what the alternative was. If you measured something —
latency, a restored position, a test count, a binary delta — put the number
here; that is how this repo keeps its memory (see 33a36ff, 78835dd).
-->

## Verification

<!-- Delete the lines that do not apply, and fill in the ones that do. -->

- [ ] `npm run typecheck` clean
- [ ] `npm test` for every package touched
- [ ] `npm run test:cpp --prefix packages/player` (C++ changes)
- [ ] `./gradlew :app:assembleDebug` + `:timbre_*:lintRelease` (Android changes)
- [ ] New behaviour has a regression test, or a note on why one is not feasible
- [ ] **Verified on a physical Android device** (never an emulator) — say which
      device, OS version, and what you observed:
- [ ] iOS: compiled by CI only, and no claim in this PR goes beyond that

## Docs

- [ ] `ARCHITECTURE.md` updated **in this PR** if a decision changed
- [ ] README / package README updated, and every `ts`/`tsx` snippet I touched
      still typechecks against the workspace (see CONTRIBUTING → *What "tested"
      means here*)
- [ ] Dependency or binary pins resolved from the registry/releases API, not
      from memory (PLAN §6, ARCHITECTURE §11 and §17)
