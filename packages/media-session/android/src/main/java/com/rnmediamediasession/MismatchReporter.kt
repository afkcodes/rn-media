package com.rnmediamediasession

/**
 * Reports an item/queue mismatch **only once the broadcast has settled**.
 *
 * ## The false positive this exists for
 * An app describes one moment with two calls — `setMediaItem` then
 * `setPlaybackState` — and each one hops to the main thread on its own
 * (`MediaSessionController`). So between the two there is a main-loop turn in
 * which the session holds *half* of the app's statement: the new item with the
 * old `queueIndex`, or the new index with the old item. Checking the invariant
 * there reports a disagreement the app never made and has already fixed by the
 * time anyone could act on it.
 *
 * Observed on a device (2026-08-27): a car tap moved playback from queue entry
 * 0 to 1 and the console showed
 * `metadataMismatch: … item id 'diverse-fm' vs queue[1] id 'fip-hls'`, from an
 * app whose every individual broadcast was self-consistent.
 *
 * ## Why the next turn is the right moment
 * Both channel writes are already queued on the same looper when the first one
 * runs, so a check posted from inside the first lands *after* the second — and
 * after every other write of the same broadcast. What survives that is a
 * mismatch the app is actually publishing, which is what the channel was added
 * to report (ARCHITECTURE §27: a wrong broadcast must not be silent).
 *
 * Pure, and unit-tested by running the turns by hand.
 *
 * @param current re-read at report time, never captured: the whole point is to
 * judge the settled state rather than the one that triggered the check.
 */
internal class MismatchReporter(
  private val postToNextTurn: (() -> Unit) -> Unit,
  private val current: () -> String?,
  private val report: (String) -> Unit,
) {

  private var scheduled = false

  /**
   * Last value actually reported.
   *
   * Only advanced when something is reported, so a mismatch that resolves and
   * later recurs identically stays quiet — mismatches are sticky in practice
   * (they persist until the app fixes its broadcast) and a flip-flop between
   * two *different* mismatches is worth hearing twice.
   */
  private var reported: String? = null

  /** Called from `getState()`, which runs many times per broadcast. */
  fun observe(mismatch: String?) {
    if (mismatch == null || scheduled) return
    scheduled = true
    postToNextTurn {
      scheduled = false
      val settled = current() ?: return@postToNextTurn
      if (settled == reported) return@postToNextTurn
      reported = settled
      report(settled)
    }
  }
}
