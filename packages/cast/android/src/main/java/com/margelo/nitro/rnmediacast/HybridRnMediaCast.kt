// NOT a free choice: nitrogen hardcodes the implementation class's JNI
// descriptor as `Lcom/margelo/nitro/<androidNamespace>/<implementationClassName>;`
// (see nitrogen/generated/android/RnMediaCastOnLoad.cpp). Anywhere else and
// `NitroModules.createHybridObject('RnMediaCast')` throws
// ClassNotFoundException at runtime, with nothing failing at build time.
package com.margelo.nitro.rnmediacast

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.google.android.gms.cast.framework.CastContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.rnmediacast.CastController
import com.rnmediacast.CastEmitter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicLong

/**
 * Android half of `@rn-media/cast`.
 *
 * Threading contract
 * ------------------
 * The Cast framework is main-thread-only, so every spec method trampolines
 * onto the main looper before touching it; the [CastController] is then
 * single-threaded by construction. Listener *registries* are concurrent maps
 * because `addXListener`/`removeXListener` arrive on the JS thread while
 * emissions come from main. Nitro schedules JS callback invocation onto the JS
 * thread itself (nitro.margelo.com/docs/types/callbacks).
 *
 * Availability contract
 * ---------------------
 * The framework is a dynamite module loaded from Google Play services at
 * runtime. On a GMS-less device `CastContext.getSharedInstance(Context,
 * Executor)`'s Task fails — that failure is caught and becomes the typed
 * `'unavailable'` state; it must never crash and never reject `initialize`.
 */
class HybridRnMediaCast : HybridRnMediaCastSpec(), CastEmitter {

  private val reactContext: ReactApplicationContext =
    NitroModules.applicationContext
      ?: throw IllegalStateException(
        "[cast] No ReactApplicationContext available. " +
          "Is react-native-nitro-modules installed correctly?"
      )

  /** Application context: this object outlives any Activity. */
  private val appContext: Context = reactContext.applicationContext

  private val handler = Handler(Looper.getMainLooper())
  private val mainExecutor = Executor { runnable -> handler.post(runnable) }

  /** Main-thread only. */
  private var controller: CastController? = null

  /**
   * Cache read by the synchronous [getCastState]. `UNAVAILABLE` until
   * [initialize] succeeds — before init, casting genuinely is not available.
   */
  @Volatile
  private var cachedState: CastConnectionState = CastConnectionState.UNAVAILABLE

  private val nextListenerId = AtomicLong(1)
  private val castStateListeners =
    ConcurrentHashMap<Long, (NativeCastStateEvent) -> Unit>()
  private val sessionListeners =
    ConcurrentHashMap<Long, (NativeCastSessionEvent) -> Unit>()
  private val devicesListeners =
    ConcurrentHashMap<Long, (NativeCastDevicesEvent) -> Unit>()
  private val mediaStatusListeners =
    ConcurrentHashMap<Long, (NativeCastMediaStatusEvent) -> Unit>()
  private val mediaErrorListeners =
    ConcurrentHashMap<Long, (NativeCastMediaErrorEvent) -> Unit>()
  private val queueChangedListeners = ConcurrentHashMap<Long, () -> Unit>()
  private val deviceVolumeListeners =
    ConcurrentHashMap<Long, (NativeDeviceVolumeEvent) -> Unit>()

  // -------------------------------------------------------------------------
  // Spec: context
  // -------------------------------------------------------------------------

  override fun initialize(
    receiverApplicationId: String?
  ): Promise<CastConnectionState> {
    val promise = Promise<CastConnectionState>()
    runOnMain {
      val existing = controller
      if (existing != null) {
        // Idempotent: a second initialize only re-applies the app id.
        receiverApplicationId?.let { existing.setReceiverApplicationId(it) }
        cachedState = existing.currentConnectionState()
        promise.resolve(cachedState)
        return@runOnMain
      }
      try {
        CastContext.getSharedInstance(appContext, mainExecutor)
          .addOnSuccessListener { castContext ->
            val created =
              CastController(
                appContext,
                castContext,
                this,
                handler
              ) { reactContext.currentActivity }
            controller = created
            receiverApplicationId?.let { created.setReceiverApplicationId(it) }
            cachedState = created.currentConnectionState()
            promise.resolve(cachedState)
          }
          .addOnFailureListener { error ->
            // No Play services / dynamite load failure / missing
            // OPTIONS_PROVIDER meta-data. A typed capability answer — logged,
            // never thrown, never swallowed.
            Log.w(TAG, "Cast framework unavailable", error)
            cachedState = CastConnectionState.UNAVAILABLE
            promise.resolve(CastConnectionState.UNAVAILABLE)
          }
      } catch (error: Throwable) {
        Log.w(TAG, "Cast framework unavailable (init threw)", error)
        cachedState = CastConnectionState.UNAVAILABLE
        promise.resolve(CastConnectionState.UNAVAILABLE)
      }
    }
    return promise
  }

  override fun getCastState(): CastConnectionState = cachedState

  override fun startDiscovery(): Promise<Unit> =
    withController { c, promise -> c.startDiscovery(promise) }

  override fun stopDiscovery(): Promise<Unit> =
    withController { c, promise -> c.stopDiscovery(promise) }

  override fun getDevices(): Promise<Array<CastDeviceInfo>> =
    withController { c, promise -> c.getDevices(promise) }

  override fun requestSession(deviceId: String): Promise<Unit> =
    withController { c, promise -> c.requestSession(deviceId, promise) }

  override fun showCastPicker(): Promise<Unit> =
    withController { c, promise -> c.showCastPicker(promise) }

  override fun endSession(stopReceiver: Boolean): Promise<Unit> =
    withController { c, promise -> c.endSession(stopReceiver, promise) }

  // -------------------------------------------------------------------------
  // Spec: media + volume
  // -------------------------------------------------------------------------

  override fun load(
    source: CastMediaSource,
    options: CastLoadOptions
  ): Promise<Unit> = withController { c, promise -> c.load(source, options, promise) }

  override fun play(): Promise<Unit> = withController { c, promise -> c.play(promise) }

  override fun pause(): Promise<Unit> = withController { c, promise -> c.pause(promise) }

  override fun stop(): Promise<Unit> = withController { c, promise -> c.stop(promise) }

  override fun seek(
    position: Double,
    resumeState: CastSeekResumeState
  ): Promise<Unit> = withController { c, promise -> c.seek(position, resumeState, promise) }

  override fun getApproximatePosition(): Promise<Double> =
    withController { c, promise -> c.getApproximatePosition(promise) }

  override fun setStreamVolume(volume: Double): Promise<Unit> =
    withController { c, promise -> c.setStreamVolume(volume, promise) }

  override fun setStreamMuted(muted: Boolean): Promise<Unit> =
    withController { c, promise -> c.setStreamMuted(muted, promise) }

  override fun setDeviceVolume(volume: Double): Promise<Unit> =
    withController { c, promise -> c.setDeviceVolume(volume, promise) }

  override fun setDeviceMuted(muted: Boolean): Promise<Unit> =
    withController { c, promise -> c.setDeviceMuted(muted, promise) }

  override fun getDeviceVolume(): Promise<NativeDeviceVolumeEvent> =
    withController { c, promise -> c.getDeviceVolume(promise) }

  // -------------------------------------------------------------------------
  // Spec: receiver queue
  // -------------------------------------------------------------------------

  override fun queueLoad(
    items: Array<CastQueueItemInput>,
    options: CastQueueLoadOptions
  ): Promise<Unit> = withController { c, promise -> c.queueLoad(items, options, promise) }

  override fun queueInsert(
    items: Array<CastQueueItemInput>,
    beforeItemId: Double?
  ): Promise<Unit> =
    withController { c, promise -> c.queueInsert(items, beforeItemId, promise) }

  override fun queueRemove(itemIds: DoubleArray): Promise<Unit> =
    withController { c, promise -> c.queueRemove(itemIds, promise) }

  override fun queueReorder(
    itemIds: DoubleArray,
    beforeItemId: Double?
  ): Promise<Unit> =
    withController { c, promise -> c.queueReorder(itemIds, beforeItemId, promise) }

  override fun queueJumpTo(itemId: Double, position: Double?): Promise<Unit> =
    withController { c, promise -> c.queueJumpTo(itemId, position, promise) }

  override fun queueSetRepeatMode(mode: CastRepeatMode): Promise<Unit> =
    withController { c, promise -> c.queueSetRepeatMode(mode, promise) }

  override fun getQueueItemIds(): Promise<DoubleArray> =
    withController { c, promise -> c.getQueueItemIds(promise) }

  override fun fetchQueueSlice(
    startIndex: Double,
    count: Double
  ): Promise<Array<CastQueueItemSnapshot>> =
    withController { c, promise -> c.fetchQueueSlice(startIndex, count, promise) }

  // -------------------------------------------------------------------------
  // Spec: listeners
  // -------------------------------------------------------------------------

  override fun addCastStateListener(
    listener: (event: NativeCastStateEvent) -> Unit
  ): Double = register(castStateListeners, listener)

  override fun removeCastStateListener(listenerId: Double) {
    castStateListeners.remove(listenerId.toLong())
  }

  override fun addSessionListener(
    listener: (event: NativeCastSessionEvent) -> Unit
  ): Double = register(sessionListeners, listener)

  override fun removeSessionListener(listenerId: Double) {
    sessionListeners.remove(listenerId.toLong())
  }

  override fun addDevicesListener(
    listener: (event: NativeCastDevicesEvent) -> Unit
  ): Double = register(devicesListeners, listener)

  override fun removeDevicesListener(listenerId: Double) {
    devicesListeners.remove(listenerId.toLong())
  }

  override fun addMediaStatusListener(
    listener: (event: NativeCastMediaStatusEvent) -> Unit
  ): Double = register(mediaStatusListeners, listener)

  override fun removeMediaStatusListener(listenerId: Double) {
    mediaStatusListeners.remove(listenerId.toLong())
  }

  override fun addMediaErrorListener(
    listener: (event: NativeCastMediaErrorEvent) -> Unit
  ): Double = register(mediaErrorListeners, listener)

  override fun removeMediaErrorListener(listenerId: Double) {
    mediaErrorListeners.remove(listenerId.toLong())
  }

  override fun addQueueChangedListener(listener: () -> Unit): Double =
    register(queueChangedListeners, listener)

  override fun removeQueueChangedListener(listenerId: Double) {
    queueChangedListeners.remove(listenerId.toLong())
  }

  override fun addDeviceVolumeListener(
    listener: (event: NativeDeviceVolumeEvent) -> Unit
  ): Double = register(deviceVolumeListeners, listener)

  override fun removeDeviceVolumeListener(listenerId: Double) {
    deviceVolumeListeners.remove(listenerId.toLong())
  }

  // -------------------------------------------------------------------------
  // CastEmitter (called from main by the controller)
  // -------------------------------------------------------------------------

  override fun onCastState(event: NativeCastStateEvent) {
    cachedState = event.state
    castStateListeners.values.forEach { it(event) }
  }

  override fun onSession(event: NativeCastSessionEvent) {
    sessionListeners.values.forEach { it(event) }
  }

  override fun onDevices(event: NativeCastDevicesEvent) {
    devicesListeners.values.forEach { it(event) }
  }

  override fun onMediaStatus(event: NativeCastMediaStatusEvent) {
    mediaStatusListeners.values.forEach { it(event) }
  }

  override fun onMediaError(event: NativeCastMediaErrorEvent) {
    mediaErrorListeners.values.forEach { it(event) }
  }

  override fun onQueueChanged() {
    queueChangedListeners.values.forEach { it() }
  }

  override fun onDeviceVolume(event: NativeDeviceVolumeEvent) {
    deviceVolumeListeners.values.forEach { it(event) }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private fun <T : Any> register(
    into: ConcurrentHashMap<Long, T>,
    listener: T
  ): Double {
    val id = nextListenerId.getAndIncrement()
    into[id] = listener
    return id.toDouble()
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
  }

  /**
   * Trampoline a controller call onto the main thread; before a successful
   * `initialize` every call is a typed `[unavailable]` rejection.
   */
  private fun <T> withController(
    block: (CastController, Promise<T>) -> Unit
  ): Promise<T> {
    val promise = Promise<T>()
    runOnMain {
      val c = controller
      if (c == null) {
        promise.reject(
          IllegalStateException(
            "[unavailable] Cast framework is not initialized — call initialize() " +
              "first (it resolves 'unavailable' on devices without Google Play services)."
          )
        )
        return@runOnMain
      }
      try {
        block(c, promise)
      } catch (error: Throwable) {
        promise.reject(
          IllegalStateException("[native] ${error.message ?: error.javaClass.simpleName}", error)
        )
      }
    }
    return promise
  }

  private companion object {
    const val TAG = "RnMediaCast"
  }
}
