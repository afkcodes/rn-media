package com.rnmediamediasession

import android.util.Log
import com.margelo.nitro.rnmediamediasession.SessionErrorCode
import java.util.Collections

/**
 * The de-duplication, the holding and the delivery decision — with no Android
 * and no Nitro in it.
 *
 * Split from [SessionErrors] for the reason CLAUDE.md principle 4 gives: the
 * interesting part of this channel is *when* a failure is reported, held or
 * dropped, and that is decided by data. Wiring it to `Log` and to a callback
 * that may belong to a dead JS runtime is the part a device has to prove.
 *
 * Thread-safe: reports arrive from the main looper (media3 callbacks), the JS
 * thread (`initialize`) and [ResumptionStore]'s writer thread.
 *
 * @param log severity is *not* decided here — `severe` picks a logcat level and
 * nothing else. The grading an app sees lives once, in `src/validate.ts`, for
 * both platforms (ARCHITECTURE §27's drift rule). The `cause` is for logcat
 * alone: a stack trace is what makes an unexpected `IllegalStateException`
 * diagnosable on a device, and it is not something to push across the bridge —
 * JavaScript gets the sentence.
 * @param deliver hand the report to JavaScript; `false` when there is nobody to
 * hand it to.
 */
internal class SessionErrorReporter(
  private val log: (severe: Boolean, message: String, cause: Throwable?) -> Unit,
  private val deliver: (SessionErrorCode, String) -> Boolean,
) {

  /**
   * Keys already reported in this session, for the codes that would otherwise
   * repeat.
   *
   * A missing icon is re-resolved on every notification rebuild and a failing
   * cover on every broadcast that names it; reporting each attempt would turn a
   * one-line configuration mistake into a log flood and an app-side rate
   * limiter. Cleared when a session starts or ends, so a fixed config (or a dev
   * reload) is reported again rather than remembered forever.
   *
   * Deliberately unused by `backgroundPlaybackUnavailable`: each refusal is a
   * fresh attempt at a foreground start that may well succeed next time (the
   * app may be in the foreground by then), so every one of them is news.
   */
  private val reported = Collections.synchronizedSet(mutableSetOf<String>())

  /**
   * Reports about a resumption that happened while no handler existed, held for
   * the next [onSessionInitialized] in the order they were raised.
   *
   * The window is real and is the *normal* case for these codes: a revival is
   * abandoned precisely when no session is initialized. Two sub-cases —
   * - the process died and came back with no JavaScript: nothing is held,
   *   because this object died with it. Only the log remains, and that is
   *   honest — reporting it into some later launch would be a stale error
   *   attributed to the wrong run.
   * - `stopService()` then a resumption card in the *same* process: the runtime
   *   is alive, the app brings the session back up seconds later, and this is
   *   what makes the reason reach it when it does.
   *
   * A list rather than one slot because one abandoned revival now produces
   * **two** reports — the diagnosis ([reportResumptionDiagnosis], raised
   * seconds earlier and naming the cause) and the outcome
   * ([reportResumptionFailure]) — and a single slot would silently drop the
   * first, which is the useful one. At most one entry per code: a repeat is the
   * same story told again, not news.
   */
  private val held = mutableListOf<Pair<SessionErrorCode, String>>()

  /**
   * A "your init never arrived" diagnosis raised **while the revival was still
   * running**, and therefore not yet proven.
   *
   * It is deliberately not a report yet. The condition it describes — the JS
   * runtime is up and `MediaService.init(...)` has not been called — is read a
   * few seconds after the runtime appears, which is early enough to be useful
   * and early enough to be wrong about an app whose own init path is simply
   * slow. So it waits for one of two answers:
   * - the revival is abandoned ([confirmResumptionDiagnosis]) — it was right,
   *   and it becomes a held report;
   * - an `initialize` arrives ([onSessionInitialized]) — it was wrong, and it
   *   is dropped without ever reaching the app.
   *
   * `@Volatile`: written from the main looper (the service's probe), read on
   * the JS thread (`initialize`).
   */
  @Volatile
  private var provisionalDiagnosis: String? = null

  /**
   * Report [code] with [message], and say whether JavaScript actually got it.
   *
   * @param dedupeKey when non-null, the same key is reported at most once per
   * session. See [reported].
   */
  fun report(
    code: SessionErrorCode,
    message: String,
    severe: Boolean = false,
    dedupeKey: String? = null,
    cause: Throwable? = null,
  ): Boolean {
    if (dedupeKey != null && !reported.add(dedupeKey)) return false
    log(severe, message, cause)
    return try {
      deliver(code, message)
    } catch (error: Throwable) {
      // A Nitro function whose runtime has been destroyed throws. Reporting a
      // failure must never become one — and the log line has already gone out.
      log(false, "Could not deliver a session error to JavaScript.", error)
      false
    }
  }

  /**
   * Report a resumption failure now, or hold it for the next
   * [onSessionInitialized].
   *
   * Called from `RnMediaMediaSessionService.abandonRevival`, where "no handler"
   * is the expected state rather than the exception.
   */
  fun reportResumptionFailure(message: String) {
    if (report(SessionErrorCode.PLAYBACKRESUMPTIONFAILED, message, severe = true)) return
    hold(SessionErrorCode.PLAYBACKRESUMPTIONFAILED, message)
  }

  /**
   * The runtime is up and `MediaService.init(...)` has not followed. Logged
   * **now** — that is the whole point, it is seconds ahead of the deadline —
   * and held on probation until [confirmResumptionDiagnosis] or
   * [onSessionInitialized] settles it.
   *
   * Never delivered on the spot, and not for want of trying: a handler existing
   * *is* an initialized session, which is precisely the thing whose absence
   * this reports. Delivering it to one would be reporting a problem to the
   * proof that there is none. See [provisionalDiagnosis].
   */
  fun reportResumptionDiagnosis(message: String) {
    log(false, message, null)
    provisionalDiagnosis = message
  }

  /**
   * The revival was abandoned, so a diagnosis raised while it ran was right
   * after all: promote it to a held report, ahead of the failure that follows
   * it.
   *
   * Call before [reportResumptionFailure] — the cause reads first, then the
   * consequence.
   */
  fun confirmResumptionDiagnosis() {
    val message = provisionalDiagnosis ?: return
    provisionalDiagnosis = null
    hold(SessionErrorCode.PLAYBACKRESUMPTIONNOTWIRED, message)
  }

  private fun hold(code: SessionErrorCode, message: String) {
    synchronized(held) {
      held.removeAll { it.first == code }
      held.add(code to message)
    }
  }

  /**
   * A session was just initialized: start the de-duplication over, then deliver
   * anything held while there was nobody to deliver it to.
   *
   * An `initialize` also **disproves** an unsettled diagnosis, in the most
   * direct way there is: the call whose absence it reports has just happened.
   * That is what keeps an app whose own init path takes longer than the probe
   * from ever being accused of not having one.
   *
   * Held messages are prefixed rather than replayed verbatim: by the time they
   * arrive the app is starting a *new* session, and an unqualified "playback
   * resumption abandoned" would read as a failure of the one it is starting.
   */
  fun onSessionInitialized() {
    reported.clear()
    provisionalDiagnosis = null
    val pending = synchronized(held) {
      val copy = held.toList()
      held.clear()
      copy
    }
    for ((code, message) in pending) {
      report(code, "${prefixFor(code)} $message", severe = true)
    }
  }

  /**
   * Forget what has been reported, and anything held or on probation. Called
   * when a session is torn down.
   *
   * Held failures are dropped rather than carried across the teardown: a
   * resumption failure nobody was there to hear, followed by an explicit
   * `stopService()`, is a closed story.
   */
  fun reset() {
    reported.clear()
    provisionalDiagnosis = null
    synchronized(held) { held.clear() }
  }

  private companion object {
    fun prefixFor(code: SessionErrorCode): String = when (code) {
      SessionErrorCode.PLAYBACKRESUMPTIONNOTWIRED ->
        "The playback resumption that ran before this session never reached your app:"

      else -> "The playback resumption that ran before this session was abandoned:"
    }
  }
}

/**
 * The one way this package tells JavaScript that something failed with **no
 * call waiting to be rejected**.
 *
 * Every site that funnels through here used to end at `Log.e`/`Log.w` and
 * nothing else: the OS refusing a foreground service, a drawable name that does
 * not resolve, a resumption that never completed, a cover that never
 * downloaded. All of them happen on a media3 callback, a background writer
 * thread or a future's completion — where there is no promise to fail — so
 * without this channel an app could only learn about them from a cable
 * (CLAUDE.md principle 6, ARCHITECTURE §28).
 *
 * This object is only the wiring; the behaviour is [SessionErrorReporter],
 * which is unit-tested.
 */
internal object SessionErrors {

  private val reporter = SessionErrorReporter(
    log = { severe, message, cause ->
      // Four-argument `Log.e`/`Log.w` when there is a cause, so the stack trace
      // stays in logcat exactly as it did before this channel existed.
      when {
        severe && cause != null -> Log.e(RnMediaMediaSessionService.TAG, message, cause)
        severe -> Log.e(RnMediaMediaSessionService.TAG, message)
        cause != null -> Log.w(RnMediaMediaSessionService.TAG, message, cause)
        else -> Log.w(RnMediaMediaSessionService.TAG, message)
      }
    },
    deliver = { code, message ->
      val handlers = MediaSessionController.handlers
      if (handlers == null) {
        false
      } else {
        handlers.onSessionError(code, message)
        true
      }
    },
  )

  fun report(
    code: SessionErrorCode,
    message: String,
    severe: Boolean = false,
    dedupeKey: String? = null,
    cause: Throwable? = null,
  ): Boolean = reporter.report(code, message, severe, dedupeKey, cause)

  fun reportResumptionFailure(message: String) = reporter.reportResumptionFailure(message)

  fun reportResumptionDiagnosis(message: String) = reporter.reportResumptionDiagnosis(message)

  fun confirmResumptionDiagnosis() = reporter.confirmResumptionDiagnosis()

  fun onSessionInitialized() = reporter.onSessionInitialized()

  fun reset() = reporter.reset()
}
