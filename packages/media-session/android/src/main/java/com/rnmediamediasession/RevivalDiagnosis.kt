package com.rnmediamediasession

/**
 * What to tell the app when a playback resumption is not going the way it
 * should — as pure string arithmetic, with no Android, no media3, no clock and
 * no callback in it.
 *
 * Split out of [RnMediaMediaSessionService] for the reason CLAUDE.md principle 4
 * gives. The interesting part of a resumption watchdog is not that a `Runnable`
 * fired; it is **which of several indistinguishable failures happened and what
 * the app author has to change**, and that is a decision over two booleans. A
 * device is needed to prove the timer fires; nothing but a unit test is needed
 * to prove it says the right thing, and the messages are the entire value of
 * the feature (ARCHITECTURE §27: a silent no-op is a bug).
 *
 * The two entry points are the two moments a resumption can speak:
 * - [notWired] — the **probe**, a few seconds after the JS runtime appears and
 *   long before the deadline. Reported as `playbackResumptionNotWired`.
 * - [abandonReason] — the **deadline**, reported as
 *   `playbackResumptionFailed`. The outcome rather than the cause.
 */
internal object RevivalDiagnosis {

  /**
   * The fix for the commonest wiring mistake there is, in the words the root
   * README and the package README both use.
   *
   * A constant rather than prose inlined twice: the sentence is the deliverable
   * (it is what the app author acts on), and the two places that say it must
   * not be able to drift apart. Asserted verbatim by `RevivalDiagnosisTest`.
   */
  const val ENTRY_IMPORT_FIX = "use a bare `import './src/playback'` in index.js"

  /**
   * The JS runtime is up, no `MediaService.init(...)` has arrived, and the
   * revival is still running.
   *
   * Two arms, because there are exactly two things that could have called
   * `init` in this process and the fix differs by which one was supposed to:
   * - `requestDelivered` — the runtime was already alive, so module scope has
   *   run once and can never run again; `android.onRevivalRequested` was fired
   *   at it and is what has not led anywhere.
   * - otherwise — a genuinely cold boot, where JS module scope is the only
   *   thing that can save the revival, and it did not.
   *
   * @param sinceRuntimeReadyMs how long the probe waited, quoted so the number
   * in the message is the number the code actually used.
   */
  fun notWired(requestDelivered: Boolean, sinceRuntimeReadyMs: Long): String =
    if (requestDelivered) {
      "Playback resumption is not wired up: the JS runtime is alive and was asked to " +
        "re-initialize (android.onRevivalRequested), but MediaService.init(...) has not " +
        "been called $sinceRuntimeReadyMs ms later. That callback must run your init " +
        "path — the same idempotent 'bring the session up' code your module scope runs, " +
        "ending in MediaService.init(...). Still waiting for it."
    } else {
      "Playback resumption is not wired up: the JS runtime is up and MediaService.init(...) " +
        "has not been called $sinceRuntimeReadyMs ms later. A revived runtime loads your " +
        "bundle and renders nothing, so init must run at JS MODULE SCOPE, in a module your " +
        "ENTRY file imports for its side effects — $ENTRY_IMPORT_FIX. Metro's release-mode " +
        "inline requires defer a binding-only import (`import { x } from './m'`) to the " +
        "first use of `x`, which is the first render, which a headless runtime never " +
        "performs — so an init that is merely 'at module scope' of a lazily-required " +
        "module still never runs. Still waiting for it."
    }

  /**
   * The deadline expired. Says *which* half did not happen — the two failures
   * have completely different fixes and are indistinguishable from the outside.
   *
   * @param runtimeReady whether the `ReactContext` ever appeared.
   * @param requestDelivered whether `android.onRevivalRequested` was delivered
   * to a live runtime (only meaningful once [runtimeReady]).
   */
  fun abandonReason(
    runtimeReady: Boolean,
    requestDelivered: Boolean,
    timeoutMs: Long,
  ): String = when {
    !runtimeReady -> "the JS runtime did not start within $timeoutMs ms"

    requestDelivered ->
      "the app was asked to re-initialize (android.onRevivalRequested fired on the " +
        "live runtime) but MediaService.init(...) never followed. That callback must " +
        "run your init path — the same idempotent 'bring the session up' code your " +
        "module scope runs, ending in MediaService.init(...)."

    else ->
      "the JS runtime started but MediaService.init(...) was never called. Two things " +
        "have to be true for a revival to finish: (1) init must run at JS MODULE SCOPE, " +
        "in a module your ENTRY file imports for its side effects " +
        "($ENTRY_IMPORT_FIX) — Metro's release-mode inline requires " +
        "defers a binding-only import (`import { x } from './m'`) to the first render, " +
        "which a headless runtime never performs, so an init that is merely 'at module " +
        "scope' of a lazily-required module still never runs; and (2) if this runtime " +
        "was already alive (a stop-then-resume without process death), module scope " +
        "cannot run twice — set android.onRevivalRequested to your init path so the " +
        "service can ask for it."
  }
}
