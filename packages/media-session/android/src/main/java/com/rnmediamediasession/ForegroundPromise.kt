package com.rnmediamediasession

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.util.Log

/**
 * What a *started* start of the media service owes the OS, and how to find out.
 *
 * Extracted from the service so the **decision** is a pure function with an
 * exhaustive JVM test ([ForegroundPromiseTest]) rather than a branch that can
 * only be exercised on a device. A foreground transition needs hardware; which
 * transition to make does not, and that is the half that has already been wrong
 * once (ARCHITECTURE §30).
 */
internal enum class PromiseAction {
  /**
   * Do nothing. Either no promise can exist (pre-O) or the OS has already
   * released us from it because the service is *currently* foreground —
   * `ActiveServices.sendServiceArgsLocked` clears `fgRequired` outright when
   * `r.isForeground` holds at delivery time ("Service already foreground; no
   * new timeout"), so there is no deadline to meet and interfering would only
   * cost media3 its notification.
   */
  SKIP,

  /**
   * Keep the promise with the **real** media notification, under media3's own
   * `DEFAULT_NOTIFICATION_ID`, so media3's next pass replaces it in place.
   */
  PROMOTE_WITH_SNAPSHOT,

  /**
   * Keep the promise with a throwaway notification that is removed in the same
   * breath: `startForeground` then `stopForeground(STOP_FOREGROUND_REMOVE)`.
   * The service stays *started*.
   */
  PROMOTE_THEN_DEMOTE,
}

internal object ForegroundPromise {

  /**
   * The one rule, in one place.
   *
   * **The asymmetry is total, and it is what shapes every branch below.** A
   * redundant promote-then-demote costs two binder calls and nothing the user
   * can see. A *missed* promise costs the process, uncatchably
   * (`RemoteServiceException$ForegroundServiceDidNotStartInTimeException`), with
   * no notification, no log the app writes and no way to handle it. So the only
   * input that may produce [PromiseAction.SKIP] is a **positive** answer to "is
   * this service foreground right now"; `false` and *unknown* are treated
   * identically, and both keep the promise.
   *
   * That is not hypothetical caution. The signal this function used to be asked
   * for on API 26–28 — media3's `MediaSessionService.isPlaybackOngoing()` — is
   * a **latch**, not a state: `javap` on the shipped 1.11.0 AAR shows
   * `MediaNotificationManager.startedInForeground` written in exactly two
   * places, `false` in the constructor and `true` in
   * `startForeground(MediaNotification)`, while both demotion paths
   * (`updateNotificationInternal`'s `notify` + `Util.stopForeground`, and
   * `removeNotification`) leave it alone. Once media3 has *ever* promoted the
   * service it reads `true` for the life of the process, so on Android 8–9
   * every subsequent start would have skipped — including the one carrying the
   * promise this whole mechanism exists to keep. [isServiceForeground] now
   * answers from ActivityManager on every API level instead.
   *
   * @param sdkInt `Build.VERSION.SDK_INT`.
   * @param alreadyForeground `true`/`false` from the OS, or `null` when it
   * could not be established. `null` and `false` behave identically by design.
   * @param wantsForeground [Snapshot.wantsForeground] — media3's own
   * `isAnySessionUserEngaged` pair, read from the same line the starting side
   * reads.
   * @param canBuildSnapshotNotification whether a real `MediaStyle`
   * notification can be built right now (a live session and an
   * `AndroidMediaSessionConfig` to draw it from).
   */
  fun decide(
    sdkInt: Int,
    alreadyForeground: Boolean?,
    wantsForeground: Boolean,
    canBuildSnapshotNotification: Boolean,
  ): PromiseAction {
    // Pre-O nothing can have made a promise: `startForegroundService` is API
    // 26+, and every starter (`MediaSessionController.startService`, media3's
    // `MediaButtonReceiver`, media3's `MediaNotificationManager.startForeground`)
    // falls back to a plain `startService` below it.
    if (sdkInt < Build.VERSION_CODES.O) return PromiseAction.SKIP
    if (alreadyForeground == true) return PromiseAction.SKIP
    return if (wantsForeground && canBuildSnapshotNotification) {
      PromiseAction.PROMOTE_WITH_SNAPSHOT
    } else {
      PromiseAction.PROMOTE_THEN_DEMOTE
    }
  }

  /**
   * Is `component` running as a foreground service *right now*?
   *
   * `null` means "could not be established", which [decide] treats as "no".
   *
   * Asked of the OS rather than tracked, because media3 promotes and demotes
   * behind us (`onUpdateNotificationAsync`, the `stopForegroundOnPause` grace
   * period of §19) and a local flag would drift — drifting in the "we think we
   * are foreground" direction being exactly the crash §30 exists to remove.
   *
   * Two readings of the *same* framework bit:
   * - **API 29+**: `Service.getForegroundServiceType()`, documented to return
   *   `FOREGROUND_SERVICE_TYPE_NONE` "if the service is not a foreground
   *   service". This package's manifest always declares `mediaPlayback`, so a
   *   promoted service can never read as NONE. Read by the caller, which is the
   *   `Service` itself.
   * - **API 26–28**: `ActivityManager.getRunningServices`, whose deprecation
   *   note is precise about what survived — "As of `Build.VERSION_CODES.O` this
   *   method is no longer available to third party applications. For backwards
   *   compatibility, it will still return **the caller's own services**." AOSP
   *   `ActiveServices.getRunningServiceInfoLocked` implements exactly that
   *   (`allowed || (sr.app != null && sr.app.uid == callingUid)`), and
   *   `makeRunningServiceInfoLocked` fills the field we want with
   *   `info.foreground = r.isForeground`.
   *
   * `r.isForeground` is not merely *a* signal, it is *the* one: the same field
   * decides whether a promise exists at all, in
   * `ActiveServices.sendServiceArgsLocked` —
   * `if (r.fgRequired && !r.fgWaiting) { if (!r.isForeground) scheduleServiceForegroundTransitionTimeoutLocked(r) else r.fgRequired = false }`.
   * Reading it answers the question the framework itself is about to ask.
   *
   * One binder round trip per *started* start, never in a hot path. Every
   * failure — a `SecurityException` from an OEM that tightened the API, an
   * empty list, our record missing because the process is still coming up —
   * returns `null`, i.e. keeps the promise.
   */
  fun isServiceForeground(context: Context, component: ComponentName): Boolean? {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      ?: return null
    return try {
      @Suppress("DEPRECATION")
      manager.getRunningServices(Int.MAX_VALUE)
        ?.firstOrNull { it.service == component }
        ?.foreground
    } catch (error: Throwable) {
      // Never propagated: an unanswerable question must not become a thrown
      // exception inside `onStartCommand`, and `null` already means "assume the
      // promise is live".
      Log.w(TAG, "Could not ask ActivityManager whether $component is foreground.", error)
      null
    }
  }

  private const val TAG = RnMediaMediaSessionService.TAG
}
