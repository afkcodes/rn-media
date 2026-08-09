package com.rnmediamediasession

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost

/**
 * What this package knows about the JavaScript runtime's lifetime, and why the
 * media3 service is allowed to call into it with no Activity alive.
 *
 * ## The guarantee, from the React Native 0.86 sources
 *
 * On the New Architecture (bridgeless) the JS runtime is owned by a `ReactHost`
 * held by the `Application`, not by any Activity:
 *
 * - `ReactApplication.reactHost` is an application-scoped `ReactHost?`
 *   (`ReactApplication.kt:26-28`).
 * - The template's Activity teardown path is
 *   `ReactActivityDelegate.onDestroy` → `ReactDelegate.onHostDestroy`
 *   (`ReactActivityDelegate.java:207`, `ReactDelegate.kt:164-175`) →
 *   `ReactHost.onHostDestroy(activity)` (`ReactHost.kt:81`).
 * - That implementation is `ReactHostImpl.onHostDestroy(activity)`
 *   (`runtime/ReactHostImpl.kt:313-323`), which calls only
 *   `moveToHostDestroy(...)` — and `moveToHostDestroy`
 *   (`runtime/ReactHostImpl.kt:904-908`) does exactly three things: move the
 *   lifecycle state, null the current Activity, and clear the frame-timings
 *   window. **It does not touch the ReactInstance.**
 * - The only things that tear the runtime down are the explicit
 *   `ReactHost.destroy(...)` (`ReactHost.kt:126`, `:148`) and
 *   `ReactHost.invalidate()` (`ReactHost.kt:166`), which the app calls
 *   deliberately — on a dev reload, or at process teardown.
 *
 * So: **the JS runtime, and with it every Nitro callback the app registered,
 * survives Activity destruction by construction.** What it does not survive is
 * *process* death. That is what the foreground service is for — it is the
 * platform primitive that keeps the process resident (PLAN §5.3, "one JS
 * runtime, kept alive by platform primitives").
 *
 * ## Why there is no HeadlessJsTaskService here
 *
 * RNTP v4 forked `HeadlessJsTaskService` to keep JS alive. Reading what that
 * mechanism actually does in 0.86, it buys this package nothing:
 *
 * - `HeadlessJsTaskContext.startTask` (`jstasks/HeadlessJsTaskContext.kt:70-100`)
 *   calls `AppRegistry.startHeadlessTask` and tracks the task id. It has no
 *   effect on `ReactHost`'s lifecycle and cannot prevent a `destroy()`.
 * - It requires the app to register a JS task key — integration burden for a
 *   guarantee we already have.
 * - Its usual purpose is keeping JS *timers* running in the background. This
 *   package deliberately has no background JS timers: the position anchor is
 *   projected natively (see `Anchor`), which is the whole point of the
 *   fan-out design.
 *
 * The one thing worth borrowing from `HeadlessJsTaskService` is its cold-start
 * shape (`HeadlessJsTaskService.kt:140-162`): register a
 * `ReactInstanceEventListener`, then call `reactHost.start()`. It is not used
 * here — see the limits below.
 *
 * ## Limits, stated honestly
 *
 * 1. **Process death loses everything.** If Android kills the process (paused +
 *    demoted service, or memory pressure), the runtime and the app's handler
 *    are gone. A later media button restarts the service into a process with no
 *    initialized session; media3 handles that safely by refusing the session
 *    and calling `stopSelfSafely()`, and
 *    `RnMediaMediaSessionService.onCreate` stops early for the same reason.
 *    Booting a runtime from inside the service is deliberately NOT attempted:
 *    it would race media3's own shutdown path and the 5-second
 *    `startForeground` window, and it would only work for apps that call
 *    `MediaService.init` at JS module scope. Reviving after process death is a
 *    separate feature (playback resumption), not a v1 promise.
 * 2. **A dev reload destroys the runtime while the session is up.** Handled:
 *    [addBeforeDestroyListener] tears the session down first, so the
 *    notification cannot outlive the callbacks behind its buttons.
 * 3. Everything above is read out of the RN sources; only a device can prove
 *    the process actually survives on a given OEM build. See the on-device
 *    checklist in the package README/handover notes.
 */
internal object ReactRuntime {

  private fun host(context: Context): ReactHost? =
    (context.applicationContext as? ReactApplication)?.reactHost

  /**
   * `true` when a JS runtime exists right now.
   *
   * Diagnostic only — never used to gate a command. A command that arrives
   * while this is `false` has nothing to be dispatched to anyway, and Nitro
   * callbacks captured from a dead runtime are not callable.
   */
  fun isAlive(context: Context): Boolean = host(context)?.currentReactContext != null

  /**
   * Run [listener] just before the app tears the JS runtime down.
   *
   * The case this exists for is Fast Refresh / a dev reload: `ReactHost.destroy`
   * replaces the runtime, which silently invalidates every Nitro callback the
   * old one registered. Without this hook the notification would survive with
   * buttons wired to a dead runtime — the classic "reload, then the pause
   * button does nothing" bug.
   *
   * @return the listener, to be handed back to [removeBeforeDestroyListener]
   * (`ReactHostImpl` compares by identity), or `null` when there is no
   * `ReactHost` — e.g. an app that is not a `ReactApplication`.
   */
  fun addBeforeDestroyListener(context: Context, listener: () -> Unit): (() -> Unit)? {
    val host = host(context) ?: return null
    host.addBeforeDestroyListener(listener)
    return listener
  }

  fun removeBeforeDestroyListener(context: Context, listener: () -> Unit) {
    host(context)?.removeBeforeDestroyListener(listener)
  }
}
