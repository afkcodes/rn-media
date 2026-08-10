package com.rnmediamediasession

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactContext
import java.util.concurrent.atomic.AtomicBoolean

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
 * 1. **Process death loses everything — unless the app opted into playback
 *    resumption.** If Android kills the process (paused + demoted service, or
 *    memory pressure), the runtime and the app's handler are gone. What happens
 *    next is now a choice the app makes:
 *    - `android.playbackResumption: false` (the default): a later media button
 *      restarts the service into a process with no initialized session, and
 *      `RnMediaMediaSessionService.onCreate` stops early and quietly. This is
 *      the behaviour that shipped before the feature existed, unchanged.
 *    - `android.playbackResumption: true`: the service rebuilds the session
 *      from the native mirror (`ResumptionStore`), satisfies the
 *      `startForeground` contract from it, and *then* boots the runtime through
 *      [startRuntime]. The two caveats that made this a deferred item are
 *      handled explicitly rather than wished away — the 5-second window is
 *      satisfied before any JavaScript is asked for, and the "only works if the
 *      app calls `MediaService.init` at module scope" limitation is now a
 *      documented requirement with a bounded wait and an actionable log when it
 *      is not met.
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

  /**
   * `true` when this application can host a JS runtime at all.
   *
   * The brownfield case: an `Application` that does not implement
   * `ReactApplication` (React Native embedded in a native app that owns its own
   * `ReactHost`, or none). Nothing here can find a runtime to boot, so playback
   * resumption degrades to the pre-existing "stop quietly" behaviour rather
   * than crashing on a cast that was never going to succeed.
   */
  fun canRevive(context: Context): Boolean = host(context) != null

  /**
   * Boot the JS runtime, and call [onInstance] once a `ReactContext` exists.
   *
   * ## The race this is shaped around
   * `addReactInstanceEventListener` does **not** replay for an instance that
   * already exists (`ReactHostImpl.addReactInstanceEventListener` just appends
   * to a list; the only call site is the one-shot notification inside instance
   * creation). And `start()` is asynchronous — it hands `getOrCreateStartTask`
   * to a background executor (`ReactHostImpl.start` is
   * `Task.call({ getOrCreateStartTask() }, bgExecutor)`), so between "is there a
   * context?" and "start it" the answer can change.
   *
   * So the order is the one `HeadlessJsTaskService` uses and the only one with
   * no hole in it: **register first, start second, re-check third.** Registering
   * first means an instance created by `start()` cannot slip past us;
   * re-checking after means an instance that already existed (or was created
   * between the two calls) is not waited for forever. [onInstance] is fired
   * exactly once either way — whichever path gets there first wins the
   * [AtomicBoolean] — and the listener is unregistered as soon as it does.
   *
   * `start()` is safe to call redundantly: `getOrCreateStartTask` is
   * memoised and the implementation is documented thread-safe.
   *
   * @return `false` when there is no `ReactHost` (see [canRevive]); [onInstance]
   * is then never called.
   */
  fun startRuntime(context: Context, onInstance: () -> Unit): Boolean {
    val host = host(context) ?: return false
    val fired = AtomicBoolean(false)

    // Declared before it is registered so the listener can unregister itself.
    lateinit var listener: ReactInstanceEventListener
    val deliver = {
      if (fired.compareAndSet(false, true)) {
        host.removeReactInstanceEventListener(listener)
        onInstance()
      }
    }
    listener = object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) = deliver()
    }

    host.addReactInstanceEventListener(listener)
    try {
      host.start()
    } catch (error: Throwable) {
      // A ReactHost that refuses to start is not something this package can
      // fix, and it must not take the service down with it.
      host.removeReactInstanceEventListener(listener)
      Log.e(RnMediaMediaSessionService.TAG, "ReactHost.start() failed; cannot revive.", error)
      return false
    }
    if (host.currentReactContext != null) deliver()
    return true
  }
}
