package com.rnmediamediasession

import com.margelo.nitro.rnmediamediasession.SessionErrorCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The session-error channel's decisions, with no Android and no JS runtime.
 *
 * What is worth pinning here is not "does a log line appear" but the three
 * rules that make the channel usable: a configuration mistake is reported once
 * rather than per broadcast, a failure with nobody listening is *held* rather
 * than lost, and a delivery that throws (a Nitro callback whose runtime has
 * been destroyed) cannot become a second failure.
 */
class SessionErrorsTest {

  private class Sink(var alive: Boolean = true, val throwOnDeliver: Boolean = false) {
    val delivered = mutableListOf<Pair<SessionErrorCode, String>>()
    val logs = mutableListOf<Pair<Boolean, String>>()

    fun reporter(): SessionErrorReporter =
      SessionErrorReporter(
        log = { severe, message, _ -> logs.add(severe to message) },
        deliver = { code, message ->
          if (throwOnDeliver) throw IllegalStateException("runtime is gone")
          if (!alive) {
            false
          } else {
            delivered.add(code to message)
            true
          }
        },
      )
  }

  @Test
  fun `a report reaches JavaScript with its code and message`() {
    val sink = Sink()
    val reporter = sink.reporter()

    assertTrue(reporter.report(SessionErrorCode.ARTWORKFAILED, "no cover"))

    assertEquals(listOf(SessionErrorCode.ARTWORKFAILED to "no cover"), sink.delivered)
  }

  @Test
  fun `severe picks the logcat level and nothing else`() {
    val sink = Sink()
    val reporter = sink.reporter()

    reporter.report(SessionErrorCode.BACKGROUNDPLAYBACKUNAVAILABLE, "refused", severe = true)
    reporter.report(SessionErrorCode.ICONNOTFOUND, "missing")

    assertEquals(listOf(true to "refused", false to "missing"), sink.logs)
  }

  @Test
  fun `a de-duplicated key is reported once, however often it recurs`() {
    val sink = Sink()
    val reporter = sink.reporter()

    // `MediaButtons.buttons` re-resolves every custom-action icon on every
    // broadcast; without the key this would be one report per broadcast.
    repeat(5) {
      reporter.report(SessionErrorCode.ICONNOTFOUND, "ic_nope", dedupeKey = "icon:ic_nope")
    }
    reporter.report(SessionErrorCode.ICONNOTFOUND, "ic_other", dedupeKey = "icon:ic_other")

    assertEquals(2, sink.delivered.size)
    assertEquals(2, sink.logs.size)
  }

  @Test
  fun `an un-keyed report is never de-duplicated`() {
    val sink = Sink()
    val reporter = sink.reporter()

    // A refused foreground start is retried by the next `playing` broadcast and
    // may succeed then, so each refusal is a distinct fact.
    repeat(3) {
      reporter.report(SessionErrorCode.BACKGROUNDPLAYBACKUNAVAILABLE, "refused", severe = true)
    }

    assertEquals(3, sink.delivered.size)
  }

  @Test
  fun `a new session may hear a configuration mistake again`() {
    val sink = Sink()
    val reporter = sink.reporter()

    reporter.report(SessionErrorCode.ICONNOTFOUND, "ic_nope", dedupeKey = "icon:ic_nope")
    reporter.onSessionInitialized()
    reporter.report(SessionErrorCode.ICONNOTFOUND, "ic_nope", dedupeKey = "icon:ic_nope")

    assertEquals(2, sink.delivered.size)
  }

  @Test
  fun `a resumption failure with nobody listening is held for the next init`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    // The real shape of this: `stopService()` tore the session down, the System
    // UI's resumption card started the service, and the revival timed out.
    reporter.reportResumptionFailure("Playback resumption abandoned: no init followed.")
    assertTrue(sink.delivered.isEmpty())

    sink.alive = true
    reporter.onSessionInitialized()

    assertEquals(1, sink.delivered.size)
    val (code, message) = sink.delivered.single()
    assertEquals(SessionErrorCode.PLAYBACKRESUMPTIONFAILED, code)
    assertTrue(
      "The held message must say it belongs to the *previous* session: $message",
      message.startsWith("The playback resumption that ran before this session was abandoned:"),
    )
    assertTrue(message.endsWith("Playback resumption abandoned: no init followed."))
  }

  @Test
  fun `a held failure is delivered once, not on every later init`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()
    reporter.reportResumptionFailure("abandoned")

    sink.alive = true
    reporter.onSessionInitialized()
    reporter.onSessionInitialized()

    assertEquals(1, sink.delivered.size)
  }

  @Test
  fun `a teardown drops what nobody was there to hear`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()
    reporter.reportResumptionFailure("abandoned")

    // stopService(): the app deliberately ended the session, so a resumption
    // failure from before it is a closed story.
    reporter.reset()
    sink.alive = true
    reporter.onSessionInitialized()

    assertTrue(sink.delivered.isEmpty())
  }

  /* ------------------------- The early diagnosis -------------------------- */

  @Test
  fun `a diagnosis is logged at once and delivered only if the revival is abandoned`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    reporter.reportResumptionDiagnosis("init has not been called 3000 ms later.")
    // Logged immediately — that is the seven seconds this whole probe buys.
    assertEquals(1, sink.logs.size)
    // …and never delivered on the spot: a listener existing would mean the
    // session it reports missing is not missing.
    assertTrue(sink.delivered.isEmpty())

    reporter.confirmResumptionDiagnosis()
    reporter.reportResumptionFailure("Playback resumption abandoned: no init followed.")

    sink.alive = true
    reporter.onSessionInitialized()

    assertEquals(2, sink.delivered.size)
    // Cause first, consequence second.
    assertEquals(SessionErrorCode.PLAYBACKRESUMPTIONNOTWIRED, sink.delivered[0].first)
    assertEquals(SessionErrorCode.PLAYBACKRESUMPTIONFAILED, sink.delivered[1].first)
    assertTrue(
      sink.delivered[0].second.startsWith(
        "The playback resumption that ran before this session never reached your app:"
      )
    )
    assertTrue(sink.delivered[0].second.endsWith("init has not been called 3000 ms later."))
  }

  @Test
  fun `an initialize that arrives in time disproves the diagnosis`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    // The app's own init path was merely slow: the probe fired, and then the
    // very call it reported missing arrived.
    reporter.reportResumptionDiagnosis("init has not been called 3000 ms later.")
    sink.alive = true
    reporter.onSessionInitialized()

    assertTrue("A slow app must never be accused of an unwired one", sink.delivered.isEmpty())

    // And it stays disproved: a later abandon has nothing to promote.
    reporter.confirmResumptionDiagnosis()
    reporter.onSessionInitialized()
    assertTrue(sink.delivered.isEmpty())
  }

  @Test
  fun `the failure does not clobber the diagnosis that explains it`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    reporter.reportResumptionDiagnosis("the cause")
    reporter.confirmResumptionDiagnosis()
    reporter.reportResumptionFailure("the outcome")

    sink.alive = true
    reporter.onSessionInitialized()

    val codes = sink.delivered.map { it.first }
    assertEquals(
      listOf(
        SessionErrorCode.PLAYBACKRESUMPTIONNOTWIRED,
        SessionErrorCode.PLAYBACKRESUMPTIONFAILED,
      ),
      codes,
    )
  }

  @Test
  fun `a repeated hold of the same code keeps one entry, the newest`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    reporter.reportResumptionFailure("first")
    reporter.reportResumptionFailure("second")

    sink.alive = true
    reporter.onSessionInitialized()

    assertEquals(1, sink.delivered.size)
    assertTrue(sink.delivered.single().second.endsWith("second"))
  }

  @Test
  fun `a teardown drops a diagnosis too, held or on probation`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    reporter.reportResumptionDiagnosis("on probation")
    reporter.reset()
    reporter.confirmResumptionDiagnosis()

    sink.alive = true
    reporter.onSessionInitialized()
    assertTrue(sink.delivered.isEmpty())
  }

  @Test
  fun `a delivery that throws is logged, not propagated`() {
    val sink = Sink(throwOnDeliver = true)
    val reporter = sink.reporter()

    // A Nitro callback whose runtime has been destroyed throws on invocation.
    assertFalse(reporter.report(SessionErrorCode.METADATAMISMATCH, "ids disagree"))

    assertEquals(2, sink.logs.size)
    assertTrue(sink.logs[1].second.startsWith("Could not deliver a session error"))
  }

  @Test
  fun `a failure that could not be delivered is still reported once it can be`() {
    val sink = Sink(alive = false)
    val reporter = sink.reporter()

    // The de-duplication key is claimed by the undelivered attempt, deliberately:
    // the log line went out, and re-reporting on every later broadcast is what
    // the key exists to prevent. A new session clears it.
    reporter.report(SessionErrorCode.ARTWORKFAILED, "no cover", dedupeKey = "artwork:x")
    sink.alive = true
    reporter.report(SessionErrorCode.ARTWORKFAILED, "no cover", dedupeKey = "artwork:x")
    assertTrue(sink.delivered.isEmpty())

    reporter.onSessionInitialized()
    reporter.report(SessionErrorCode.ARTWORKFAILED, "no cover", dedupeKey = "artwork:x")

    assertEquals(1, sink.delivered.size)
  }
}
