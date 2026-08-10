// NOT a free choice: nitrogen hardcodes the implementation class's JNI
// descriptor as `Lcom/margelo/nitro/<androidNamespace>/<implementationClassName>;`
// (see nitrogen/generated/android/RnMediaMediaSessionOnLoad.cpp). Anywhere else
// and `NitroModules.createHybridObject('RnMediaMediaSession')` throws
// ClassNotFoundException at runtime, with nothing failing at build time.
package com.margelo.nitro.rnmediamediasession

import android.content.Context
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.rnmediamediasession.MediaSessionController

/**
 * The Android bridge head.
 *
 * Intentionally almost empty: every method forwards to [MediaSessionController],
 * which is where the state that has to outlive this object lives. A hybrid
 * object is owned by the JS runtime; a `MediaSessionService` is owned by the OS,
 * and the two lifetimes do not nest in either direction.
 *
 * Threading: these methods are called on the JS thread and all of them return
 * immediately. Nothing here blocks, and nothing here touches media3 — the
 * controller hops to the main looper, which is the only thread
 * `SimpleBasePlayer` tolerates.
 */
class HybridRnMediaMediaSession : HybridRnMediaMediaSessionSpec() {

  private val appContext: Context =
    (NitroModules.applicationContext
      ?: throw IllegalStateException(
        "[media-session] No ReactApplicationContext available. " +
          "Is react-native-nitro-modules installed correctly?"
      ))
      // Always the *application* context: the session outlives every Activity
      // by design, and holding one here would leak it for the life of the app.
      .applicationContext

  override fun initialize(
    config: MediaSessionConfig,
    handlers: MediaSessionHandlers,
  ): Promise<Unit> {
    val promise = Promise<Unit>()
    MediaSessionController.initialize(appContext, config.android, handlers) {
      promise.resolve(Unit)
    }
    return promise
  }

  override fun setPlaybackState(state: NativePlaybackState) {
    MediaSessionController.setPlaybackState(state)
  }

  override fun setMediaItem(item: NativeMediaItem?) {
    MediaSessionController.setMediaItem(item)
  }

  override fun setQueue(items: Array<NativeMediaItem>) {
    MediaSessionController.setQueue(items.toList())
  }

  override fun setResumptionSnapshot(snapshot: String?) {
    MediaSessionController.setResumptionSnapshot(snapshot)
  }

  override fun stopService(): Promise<Unit> {
    val promise = Promise<Unit>()
    MediaSessionController.stop { promise.resolve(Unit) }
    return promise
  }

  override fun setSleepTimer(seconds: Double) {
    MediaSessionController.setSleepTimer(seconds)
  }

  override fun cancelSleepTimer() {
    MediaSessionController.cancelSleepTimer()
  }

  override fun getSleepTimerRemaining(): Double? =
    MediaSessionController.sleepTimerRemaining()
}
