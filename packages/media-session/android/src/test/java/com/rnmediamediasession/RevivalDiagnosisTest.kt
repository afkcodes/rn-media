package com.rnmediamediasession

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sentences a failing playback resumption hands the app author.
 *
 * These are not decoration. A revival that does not finish is invisible from
 * JavaScript by construction — no session exists, so nothing throws and nothing
 * rejects — and the message is the entire remedy the developer gets. Pinning
 * them here is what keeps the two arms from swapping (the fixes are different
 * and each is useless in the other's situation) and keeps the one fix that
 * closes the commonest mistake from drifting away from the two READMEs that
 * print it.
 */
class RevivalDiagnosisTest {

  /* --------------------------------- Probe -------------------------------- */

  @Test
  fun `a cold boot is told to import its playback module from the entry file`() {
    val message = RevivalDiagnosis.notWired(requestDelivered = false, sinceRuntimeReadyMs = 3_000)

    // Verbatim, because this is the string the READMEs' pitfall rows promise.
    assertTrue(
      "The fix must appear word for word: $message",
      message.contains("use a bare `import './src/playback'` in index.js"),
    )
    assertTrue(message.contains("MODULE SCOPE"))
    assertTrue("Inline requires are *why* the bare import is required", message.contains("inline requires"))
    assertTrue("The wait must be quoted from the constant", message.contains("3000 ms"))
    assertFalse(
      "Nothing asked the app to re-initialize, so naming that callback would misdirect",
      message.contains("android.onRevivalRequested"),
    )
  }

  @Test
  fun `a live runtime that was asked to re-init is told about its callback`() {
    val message = RevivalDiagnosis.notWired(requestDelivered = true, sinceRuntimeReadyMs = 3_000)

    assertTrue(message.contains("android.onRevivalRequested"))
    assertTrue(message.contains("MediaService.init(...)"))
    assertFalse(
      "Module scope cannot run twice in a live runtime; that advice would be wrong here",
      message.contains(RevivalDiagnosis.ENTRY_IMPORT_FIX),
    )
  }

  @Test
  fun `the probe says it is still waiting - it is a diagnosis, not the outcome`() {
    for (delivered in listOf(true, false)) {
      val message = RevivalDiagnosis.notWired(delivered, 3_000)
      assertTrue(
        "The probe does not end the revival and must not claim to: $message",
        message.contains("Still waiting"),
      )
      assertFalse(message.contains("abandoned"))
    }
  }

  /* -------------------------------- Deadline ------------------------------- */

  @Test
  fun `a runtime that never started is not blamed on the app's init`() {
    val reason = RevivalDiagnosis.abandonReason(
      runtimeReady = false,
      // Cannot be true without a runtime; asserted anyway, because "the runtime
      // never came up" has to win over any other flag.
      requestDelivered = true,
      timeoutMs = 10_000,
    )

    assertTrue(reason.contains("the JS runtime did not start within 10000 ms"))
    assertFalse(reason.contains("MediaService.init"))
  }

  @Test
  fun `a delivered revival request that led nowhere names the callback`() {
    val reason = RevivalDiagnosis.abandonReason(
      runtimeReady = true,
      requestDelivered = true,
      timeoutMs = 10_000,
    )

    assertTrue(reason.contains("android.onRevivalRequested fired on the live runtime"))
    assertTrue(reason.contains("idempotent"))
    assertFalse(
      "Module scope is not the fix for a runtime that was already alive",
      reason.contains("(1) init must run at JS MODULE SCOPE"),
    )
  }

  @Test
  fun `a cold boot that never initialized gets both requirements, and the fix verbatim`() {
    val reason = RevivalDiagnosis.abandonReason(
      runtimeReady = true,
      requestDelivered = false,
      timeoutMs = 10_000,
    )

    assertTrue(reason.contains("(1) init must run at JS MODULE SCOPE"))
    assertTrue(reason.contains("(2)"))
    assertTrue(reason.contains(RevivalDiagnosis.ENTRY_IMPORT_FIX))
    assertTrue(reason.contains("android.onRevivalRequested"))
  }

  @Test
  fun `every message names something the developer can change`() {
    val all = listOf(
      RevivalDiagnosis.notWired(requestDelivered = false, sinceRuntimeReadyMs = 3_000),
      RevivalDiagnosis.notWired(requestDelivered = true, sinceRuntimeReadyMs = 3_000),
      RevivalDiagnosis.abandonReason(runtimeReady = true, requestDelivered = false, timeoutMs = 10_000),
      RevivalDiagnosis.abandonReason(runtimeReady = true, requestDelivered = true, timeoutMs = 10_000),
    )

    for (message in all) {
      // ARCHITECTURE §27: never a bare fact, always the fix with it.
      assertTrue(
        "A message with no actionable name in it is a log line, not a report: $message",
        message.contains("MediaService.init(...)"),
      )
    }
  }
}
