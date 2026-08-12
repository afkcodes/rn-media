// NOT a free choice: nitrogen hardcodes the implementation class's JNI
// descriptor as `Lcom/margelo/nitro/<androidNamespace>/<implementationClassName>;`
// (see nitrogen/generated/android/RnMediaPlayerOnLoad.cpp). Anywhere else and
// `NitroModules.createHybridObject('RnMediaScreenState')` throws
// ClassNotFoundException at runtime, with nothing failing at build time.
package com.margelo.nitro.rnmediaplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.margelo.nitro.NitroModules
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Whether the display is on, and a broadcast when that changes.
 *
 * ## Why this is not `AppState`
 * `AppState` answers "is my Activity in the foreground". On Android that is a
 * *different fact* from "can anything be seen", and the two disagree in the
 * field: a screen-off soak on a Poco F4 (MIUI, charging) recorded `AppState`
 * flapping back to `active` while the display stayed off, which un-paused
 * everything gated on it — measured at 65-80 % of a core spent rendering a
 * visualizer nobody could see. `PowerManager.isInteractive()` and the
 * `ACTION_SCREEN_ON`/`ACTION_SCREEN_OFF` broadcasts are the display state
 * itself, so no OEM lifecycle policy can make them lie.
 *
 * Note the vocabulary: *interactive* means the display is on, **not** unlocked.
 * A device showing the lock screen is interactive, and that is correct — a
 * lock-screen surface is presenting frames.
 *
 * ## Threading contract
 * The receiver is registered with the main-looper [Handler], so [onReceive] and
 * every register/unregister runs on the main thread and the pairing needs no
 * locking. Listener *registration* arrives on the JS thread, hence the
 * concurrent map, and the register/unregister decisions it triggers are posted
 * to the main thread rather than taken on the caller's. Nitro callbacks may be
 * invoked from any thread — it schedules the actual JS call onto the JS thread
 * itself (https://nitro.margelo.com/docs/types/callbacks).
 *
 * ## The receiver is derived from the listener set
 * Registered on the first listener, unregistered on the last, exactly like the
 * PCM tap is derived from its subscriber set (ARCHITECTURE §21). A process with
 * nothing observing the display holds no `BroadcastReceiver`, so this costs a
 * player that never draws a spectrum precisely nothing.
 */
class HybridRnMediaScreenState : HybridRnMediaScreenStateSpec() {

  private val appContext: Context =
    (NitroModules.applicationContext
      ?: throw IllegalStateException(
        "[player] No ReactApplicationContext available. " +
          "Is react-native-nitro-modules installed correctly?"
      ))
      // Always the *application* context: this object outlives any Activity and
      // registers a receiver, so holding an Activity here would leak it.
      .applicationContext

  private val powerManager: PowerManager =
    appContext.getSystemService(Context.POWER_SERVICE) as PowerManager

  private val handler = Handler(Looper.getMainLooper())

  private val nextListenerId = AtomicLong(1)
  private val listeners = ConcurrentHashMap<Long, (Boolean) -> Unit>()

  /** Main-thread only. Guards receiver registration symmetry. */
  private var isRegistered = false

  private val screenReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        val next =
          when (intent?.action) {
            Intent.ACTION_SCREEN_ON -> true
            Intent.ACTION_SCREEN_OFF -> false
            // The filter admits nothing else, but a receiver must never assume
            // the intent it was handed is one it asked for.
            else -> return
          }
        for (listener in listeners.values) listener(next)
      }
    }

  override val interactive: Boolean
    get() = powerManager.isInteractive

  override fun addScreenStateListener(onChange: (interactive: Boolean) -> Unit): Double {
    val id = nextListenerId.getAndIncrement()
    listeners[id] = onChange
    handler.post { startListening() }
    return id.toDouble()
  }

  override fun removeScreenStateListener(listenerId: Double) {
    listeners.remove(listenerId.toLong())
    handler.post { if (listeners.isEmpty()) stopListening() }
  }

  private fun startListening() {
    if (isRegistered || listeners.isEmpty()) return
    isRegistered = true
    val filter =
      IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_SCREEN_OFF)
      }
    // Android 13+ requires an explicit export flag. Both actions are protected
    // system broadcasts, so NOT_EXPORTED is both allowed and the tightest
    // choice. (They also cannot be declared in the manifest — the platform only
    // delivers them to receivers registered at runtime, which is why this is a
    // native module rather than a manifest entry.)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      appContext.registerReceiver(screenReceiver, filter, null, handler, Context.RECEIVER_NOT_EXPORTED)
    } else {
      appContext.registerReceiver(screenReceiver, filter, null, handler)
    }
  }

  private fun stopListening() {
    if (!isRegistered) return
    isRegistered = false
    // `unregisterReceiver` throws if the receiver was never registered; the
    // `isRegistered` flag makes the pairing exact, and the catch is a backstop
    // for a context torn down underneath us.
    try {
      appContext.unregisterReceiver(screenReceiver)
    } catch (_: IllegalArgumentException) {
      // Already gone with the context — nothing to release.
    }
  }
}
