package com.rnmediacast

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.os.Handler
import androidx.mediarouter.app.MediaRouteChooserDialog
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.Cast
import com.google.android.gms.cast.CastDevice
import com.google.android.gms.cast.CastStatusCodes
import com.google.android.gms.cast.MediaError
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaQueueData
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaSeekOptions
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.CastStateListener
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.SessionTransferCallback
import com.google.android.gms.cast.framework.media.MediaQueue
import com.google.android.gms.cast.framework.media.RemoteMediaClient
import com.google.android.gms.common.api.PendingResult
import com.google.android.gms.common.images.WebImage
import com.margelo.nitro.core.Promise
import com.margelo.nitro.rnmediacast.CastConnectionState
import com.margelo.nitro.rnmediacast.CastDeviceInfo
import com.margelo.nitro.rnmediacast.CastIdleReason
import com.margelo.nitro.rnmediacast.CastLoadOptions
import com.margelo.nitro.rnmediacast.CastMediaSource
import com.margelo.nitro.rnmediacast.CastPlayerState
import com.margelo.nitro.rnmediacast.CastQueueItemInput
import com.margelo.nitro.rnmediacast.CastQueueItemSnapshot
import com.margelo.nitro.rnmediacast.CastQueueLoadOptions
import com.margelo.nitro.rnmediacast.CastRepeatMode
import com.margelo.nitro.rnmediacast.CastSeekResumeState
import com.margelo.nitro.rnmediacast.CastSessionEventType
import com.margelo.nitro.rnmediacast.NativeCastDevicesEvent
import com.margelo.nitro.rnmediacast.NativeCastMediaErrorEvent
import com.margelo.nitro.rnmediacast.NativeCastMediaStatusEvent
import com.margelo.nitro.rnmediacast.NativeCastSessionEvent
import com.margelo.nitro.rnmediacast.NativeCastStateEvent
import com.margelo.nitro.rnmediacast.NativeDeviceVolumeEvent
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Fan-out seam between the controller and the hybrid's listener registries. */
internal interface CastEmitter {
  fun onCastState(event: NativeCastStateEvent)
  fun onSession(event: NativeCastSessionEvent)
  fun onDevices(event: NativeCastDevicesEvent)
  fun onMediaStatus(event: NativeCastMediaStatusEvent)
  fun onMediaError(event: NativeCastMediaErrorEvent)
  fun onQueueChanged()
  fun onDeviceVolume(event: NativeDeviceVolumeEvent)
}

/**
 * Everything after a successful `CastContext` initialization: discovery,
 * session lifecycle, `RemoteMediaClient` transport and the receiver queue.
 *
 * Threading contract
 * ------------------
 * MAIN THREAD ONLY. The Cast framework requires main-thread access, so the
 * hybrid trampolines every call here (and constructs this object) on the main
 * looper; that single-thread discipline is also why the mutable state below
 * needs no locking. Emitter callbacks fire on main; Nitro hops JS callbacks
 * to the JS thread itself.
 */
internal class CastController(
  context: Context,
  private val castContext: CastContext,
  private val emitter: CastEmitter,
  private val handler: Handler,
  private val currentActivity: () -> Activity?,
) {
  private val mediaRouter: MediaRouter = MediaRouter.getInstance(context)

  /** In-flight `requestSession` promise; settled by the session listener. */
  private var pendingStart: Promise<Unit>? = null

  /** In-flight `endSession` promise; settled by `onSessionEnded`. */
  private var pendingEnd: Promise<Unit>? = null

  private var discoveryActive = false

  /**
   * The connect-ordering rule, encoded: `stopDiscovery` during an in-flight
   * session start defers the actual `MediaRouter` teardown until the start
   * settles, so the route cannot be dropped mid-handshake even if the JS
   * caller stops discovery too early.
   */
  private var discoveryStopDeferred = false

  /** Exactly what `attach` registered, so `detach` unregisters exactly it. */
  private var attachedSession: CastSession? = null
  private var attachedRmc: RemoteMediaClient? = null

  /**
   * A real media status has been emitted for the attached session. Gates the
   * synthesized idle in [rmcCallback]: only a real→null transition means "the
   * receiver's media session died"; a null before any status is just a fresh
   * session with nothing loaded yet.
   */
  private var hadMediaStatus = false

  // ---------------------------------------------------------------------
  // Framework callbacks
  // ---------------------------------------------------------------------

  private val castStateListener = CastStateListener { state ->
    emitter.onCastState(
      NativeCastStateEvent(CastMapping.connectionState(state), currentDeviceInfo())
    )
  }

  private val sessionListener =
    object : SessionManagerListener<CastSession> {
      override fun onSessionStarting(session: CastSession) {
        emitSession(CastSessionEventType.STARTING, session)
        emitter.onCastState(
          NativeCastStateEvent(CastConnectionState.CONNECTING, deviceInfo(session))
        )
      }

      override fun onSessionStarted(session: CastSession, sessionId: String) {
        attach(session)
        pendingStart?.resolve(Unit)
        pendingStart = null
        completeDeferredDiscoveryStop()
        emitSession(CastSessionEventType.STARTED, session)
        emitter.onCastState(
          NativeCastStateEvent(CastConnectionState.CONNECTED, deviceInfo(session))
        )
      }

      override fun onSessionStartFailed(session: CastSession, error: Int) {
        pendingStart?.reject(
          IllegalStateException(
            "[session-start-failed] Could not connect to the receiver: " +
              "${CastStatusCodes.getStatusCodeString(error)} (status=$error)"
          )
        )
        pendingStart = null
        completeDeferredDiscoveryStop()
        emitSession(CastSessionEventType.STARTFAILED, session, error)
        emitter.onCastState(NativeCastStateEvent(CastConnectionState.IDLE, null))
      }

      override fun onSessionEnding(session: CastSession) {
        emitSession(CastSessionEventType.ENDING, session)
      }

      override fun onSessionEnded(session: CastSession, error: Int) {
        detach()
        // The end *completed*; a nonzero status is context for the session
        // event, not a reason to fail the endSession() promise.
        pendingEnd?.resolve(Unit)
        pendingEnd = null
        emitSession(CastSessionEventType.ENDED, session, error.takeIf { it != 0 })
        emitter.onCastState(NativeCastStateEvent(CastConnectionState.IDLE, null))
      }

      override fun onSessionResuming(session: CastSession, sessionId: String) {
        emitter.onCastState(
          NativeCastStateEvent(CastConnectionState.CONNECTING, deviceInfo(session))
        )
      }

      override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) {
        attach(session)
        pendingStart?.resolve(Unit)
        pendingStart = null
        emitSession(CastSessionEventType.RESUMED, session)
        emitter.onCastState(
          NativeCastStateEvent(CastConnectionState.CONNECTED, deviceInfo(session))
        )
      }

      override fun onSessionResumeFailed(session: CastSession, error: Int) {
        pendingStart?.reject(
          IllegalStateException(
            "[session-start-failed] Could not resume the receiver session: " +
              "${CastStatusCodes.getStatusCodeString(error)} (status=$error)"
          )
        )
        pendingStart = null
        emitSession(CastSessionEventType.STARTFAILED, session, error)
        emitter.onCastState(NativeCastStateEvent(CastConnectionState.IDLE, null))
      }

      override fun onSessionSuspended(session: CastSession, reason: Int) {
        // Suspension (network blip, app backgrounded on the receiver's terms)
        // is recoverable: the framework tries to resume on its own. The
        // remote client is unusable meanwhile, so detach; `onSessionResumed`
        // re-attaches.
        detach()
        emitSession(CastSessionEventType.SUSPENDED, session, reason)
      }
    }

  private val transferCallback =
    object : SessionTransferCallback() {
      override fun onTransferring(transferType: Int) {
        emitter.onSession(
          NativeCastSessionEvent(CastSessionEventType.TRANSFERRING, null, currentDeviceInfo())
        )
        emitter.onCastState(
          NativeCastStateEvent(CastConnectionState.TRANSFERRING, currentDeviceInfo())
        )
      }

      override fun onTransferred(
        transferType: Int,
        sessionState: com.google.android.gms.cast.SessionState
      ) {
        emitter.onSession(
          NativeCastSessionEvent(CastSessionEventType.TRANSFERRED, null, currentDeviceInfo())
        )
        // The follow-up castState comes from the framework's own
        // CastStateListener once the new topology settles.
      }

      override fun onTransferFailed(transferType: Int, reason: Int) {
        emitter.onSession(
          NativeCastSessionEvent(
            CastSessionEventType.TRANSFERFAILED,
            reason.toDouble(),
            currentDeviceInfo()
          )
        )
      }
    }

  private val rmcCallback =
    object : RemoteMediaClient.Callback() {
      override fun onStatusUpdated() {
        val rmc = attachedRmc ?: return
        val event = statusEvent(rmc)
        if (event != null) {
          hadMediaStatus = true
          emitter.onMediaStatus(event)
          return
        }
        if (hadMediaStatus) {
          // Real → null: the receiver's MEDIA SESSION died with the cast
          // session still up (device-found: a live-stream load the receiver
          // could not start killed it; the phone then showed the last
          // "playing" state for minutes because this update was dropped).
          // Synthesize one idle status so every surface learns playback
          // stopped. `interrupted` is the honest reason — the media went
          // away without finishing; the receiver reported no error. The
          // position is 0 by necessity; the TS machine keeps its projected
          // anchor for idle statuses, so nothing downstream adopts the 0.
          hadMediaStatus = false
          emitter.onMediaStatus(
            NativeCastMediaStatusEvent(
              playerState = CastPlayerState.IDLE,
              idleReason = CastIdleReason.INTERRUPTED,
              position = 0.0,
              duration = null,
              playbackRate = 0.0,
              streamVolume = 0.0,
              streamMuted = false,
              repeatMode = CastRepeatMode.OFF,
              currentItemId = null,
              queueItemCount = 0.0,
            )
          )
        }
      }

      override fun onQueueStatusUpdated() {
        emitter.onQueueChanged()
      }

      override fun onMediaError(error: MediaError) {
        emitter.onMediaError(
          NativeCastMediaErrorEvent(
            error.detailedErrorCode?.toDouble(),
            error.reason
          )
        )
      }
    }

  private val queueCallback =
    object : MediaQueue.Callback() {
      // `mediaQueueChanged` is the framework's own batch signal (fired once
      // after a set of item-level callbacks); `itemsReloaded` is the
      // full-invalidate. Item-level callbacks are deliberately not forwarded
      // — one JS event per batch, never one per item.
      override fun mediaQueueChanged() {
        emitter.onQueueChanged()
      }

      override fun itemsReloaded() {
        emitter.onQueueChanged()
      }
    }

  private val castDeviceListener =
    object : Cast.Listener() {
      override fun onVolumeChanged() {
        val session = attachedSession ?: return
        emitter.onDeviceVolume(
          NativeDeviceVolumeEvent(session.volume, session.isMute)
        )
      }
    }

  private val routeCallback =
    object : MediaRouter.Callback() {
      override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) {
        scheduleDevicesEmit()
      }

      override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) {
        scheduleDevicesEmit()
      }

      override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) {
        scheduleDevicesEmit()
      }
    }

  /** Route churn arrives in bursts during a scan; coalesce to one JS event. */
  private val devicesEmit = Runnable {
    emitter.onDevices(NativeCastDevicesEvent(discoveredDevices()))
  }

  init {
    castContext.addCastStateListener(castStateListener)
    castContext.sessionManager.addSessionManagerListener(
      sessionListener,
      CastSession::class.java
    )
    castContext.addSessionTransferCallback(transferCallback)
    // A session may already be live (framework resumption happens before JS
    // initializes) — attach to it rather than waiting for an event that
    // already fired.
    castContext.sessionManager.currentCastSession
      ?.takeIf { it.isConnected }
      ?.let { attach(it) }
  }

  // ---------------------------------------------------------------------
  // Context / discovery / session
  // ---------------------------------------------------------------------

  fun currentConnectionState(): CastConnectionState =
    CastMapping.connectionState(castContext.castState)

  /**
   * Broadcast the current state as a `castState` event.
   *
   * Called once when `initialize` settles. `CastContext.addCastStateListener`
   * does NOT replay the current state to a new listener, and the framework
   * *resumes an existing session before JS initializes* (device-found: the
   * connected-transition simply never fires for a session that was already
   * up). Without this broadcast, an app that subscribed before `initialize()`
   * resolved would never learn it is already connected — and `<CastButton/>`,
   * which hides itself while the state is `unavailable`, would stay hidden
   * forever.
   */
  fun emitCurrentState() {
    emitter.onCastState(
      NativeCastStateEvent(currentConnectionState(), currentDeviceInfo())
    )
  }

  fun setReceiverApplicationId(receiverApplicationId: String) {
    castContext.setReceiverApplicationId(receiverApplicationId)
  }

  fun startDiscovery(promise: Promise<Unit>) {
    if (!discoveryActive) {
      discoveryActive = true
      mediaRouter.addCallback(
        // Null only when the context has no receiver app id at all; an empty
        // selector then discovers nothing, which is the honest answer.
        castContext.mergedSelector ?: MediaRouteSelector.EMPTY,
        routeCallback,
        MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY or
          MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN
      )
    }
    discoveryStopDeferred = false
    scheduleDevicesEmit()
    promise.resolve(Unit)
  }

  fun stopDiscovery(promise: Promise<Unit>) {
    if (pendingStart != null) {
      // Connect-ordering rule: never drop the route mid-handshake.
      discoveryStopDeferred = true
    } else {
      reallyStopDiscovery()
    }
    promise.resolve(Unit)
  }

  private fun completeDeferredDiscoveryStop() {
    if (discoveryStopDeferred) {
      discoveryStopDeferred = false
      reallyStopDiscovery()
    }
  }

  private fun reallyStopDiscovery() {
    if (!discoveryActive) return
    discoveryActive = false
    handler.removeCallbacks(devicesEmit)
    mediaRouter.removeCallback(routeCallback)
  }

  fun getDevices(promise: Promise<Array<CastDeviceInfo>>) {
    promise.resolve(discoveredDevices())
  }

  fun requestSession(deviceId: String, promise: Promise<Unit>) {
    val current = attachedSession
    if (current != null && current.castDevice?.deviceId == deviceId) {
      promise.resolve(Unit)
      return
    }
    if (pendingStart != null) {
      promise.reject(
        IllegalStateException(
          "[invalid-state] A session request is already in flight."
        )
      )
      return
    }
    // The same physical device can be published by SEVERAL route providers
    // with the same deviceId — device truth (POCO F4, 2026-08-14): this
    // phone runs stock GMS and a microG fork (`app.revanced.android.gms`),
    // and both list the speaker. Only the stock framework's own provider can
    // carry a session for OUR CastContext; selecting the foreign twin made
    // CastService fail at the socket every time ("Cast socket status code
    // 2251/2283", the fork logging `CastMediaRouteController: unimplemented
    // Method: onSelect`) — which twin won `firstOrNull` was a race, so
    // connects were randomly impossible. Prefer the provider that belongs to
    // the same package the cast framework itself lives in; fall back to any
    // match (a microG-only device would never get here — initialize()
    // resolves 'unavailable' without Play services).
    val candidates =
      mediaRouter.routes.filter { route ->
        route.extras?.let(CastDevice::getFromBundle)?.deviceId == deviceId
      }
    val route =
      candidates.firstOrNull { it.provider?.packageName == GMS_PACKAGE }
        ?: candidates.firstOrNull()
    if (route == null) {
      promise.reject(
        IllegalArgumentException(
          "[invalid-argument] No discovered device with id \"$deviceId\". " +
            "Is discovery running? (Connect before stopDiscovery().)"
        )
      )
      return
    }
    pendingStart = promise
    emitter.onCastState(NativeCastStateEvent(CastConnectionState.CONNECTING, null))
    // Selecting the cast route is what starts the session; the framework's
    // session listener settles the promise.
    mediaRouter.selectRoute(route)
  }

  fun showCastPicker(promise: Promise<Unit>) {
    val activity = currentActivity()
    if (activity == null || activity.isFinishing) {
      promise.reject(
        IllegalStateException(
          "[invalid-state] No foreground Activity to present the cast picker from."
        )
      )
      return
    }
    try {
      // The androidx chooser manages its own discovery for the lifetime of
      // the dialog. On Android 13+ the *system output switcher* additionally
      // hangs off any CastButtonFactory-wired cast icon (our CastOptions set
      // setShowSystemOutputSwitcherOnCastIconClick) and the media
      // notification; there is no documented public intent to launch it
      // directly, so this sticks to documented API.
      MediaRouteChooserDialog(activity).apply {
        routeSelector = castContext.mergedSelector ?: MediaRouteSelector.EMPTY
        show()
      }
      promise.resolve(Unit)
    } catch (t: Throwable) {
      promise.reject(
        IllegalStateException("[native] Failed to show the cast picker: ${t.message}", t)
      )
    }
  }

  fun endSession(stopReceiver: Boolean, promise: Promise<Unit>) {
    if (castContext.sessionManager.currentCastSession == null) {
      // Ending nothing is success, not an error — idempotent teardown.
      promise.resolve(Unit)
      return
    }
    if (stopReceiver) {
      // Silence the receiver's MEDIA explicitly before ending. The options
      // provider sets stopReceiverApplicationWhenEndingSession(false) so the
      // keep-playing path survives (device-proven: with it true, even a
      // false `stopCasting` parameter stopped the receiver app), which means
      // the transfer-back path must stop playback itself — a transfer back
      // that leaves the speaker playing would double the audio. Best-effort:
      // the session is being torn down, so a late failure is expected noise.
      attachedRmc?.stop()?.setResultCallback { /* teardown race — fine */ }
    }
    pendingEnd?.resolve(Unit) // an earlier caller is satisfied by the same end
    pendingEnd = promise
    // Honest ceiling, measured on hardware (POCO F4 → Mi Smart Speaker,
    // cast framework 22.3.1): `stopReceiver = false` CANNOT keep the
    // receiver playing on Android. Every teardown path was tried —
    // `endCurrentSession(false)` with the stop-receiver option on and off,
    // and a raw `MediaRouter.unselect(UNSELECT_REASON_DISCONNECTED)` — and
    // the framework stopped receiver playback on session end every time,
    // while the RECEIVER itself demonstrably supports last-sender-leave
    // continuation (a bare pychromecast sender's disconnect left the same
    // queue playing). What `false` still honestly delivers: no local
    // transfer-back, and the receiver APP is left to idle out rather than
    // being explicitly stopped.
    castContext.sessionManager.endCurrentSession(stopReceiver)
  }

  // ---------------------------------------------------------------------
  // RemoteMediaClient: transport
  // ---------------------------------------------------------------------

  fun load(source: CastMediaSource, options: CastLoadOptions, promise: Promise<Unit>) {
    val rmc = requireRmc(promise) ?: return
    val request =
      MediaLoadRequestData.Builder()
        .setMediaInfo(mediaInfo(source))
        .setAutoplay(options.autoplay ?: true)
        // NOTE the framework's unit asymmetry: MediaLoadRequestData times are
        // MILLISECONDS (long); MediaQueueItem times are SECONDS (double).
        .setCurrentTime(CastMapping.secondsToMillis(options.startPosition ?: 0.0))
        .apply {
          options.playbackRate?.takeIf { it > 0 && it.isFinite() }?.let { setPlaybackRate(it) }
          options.credentials?.let { setCredentials(it) }
          options.credentialsType?.let { setCredentialsType(it) }
        }
        .build()
    rmc.load(request).bridge(promise, family = "load-failed", operation = "load")
  }

  fun play(promise: Promise<Unit>) {
    requireRmc(promise)?.play()?.bridge(promise, operation = "play")
  }

  fun pause(promise: Promise<Unit>) {
    requireRmc(promise)?.pause()?.bridge(promise, operation = "pause")
  }

  fun stop(promise: Promise<Unit>) {
    requireRmc(promise)?.stop()?.bridge(promise, operation = "stop")
  }

  fun seek(position: Double, resumeState: CastSeekResumeState, promise: Promise<Unit>) {
    val rmc = requireRmc(promise) ?: return
    val options =
      MediaSeekOptions.Builder()
        .setPosition(CastMapping.secondsToMillis(position))
        .setResumeState(
          when (resumeState) {
            CastSeekResumeState.UNCHANGED -> MediaSeekOptions.RESUME_STATE_UNCHANGED
            CastSeekResumeState.PLAY -> MediaSeekOptions.RESUME_STATE_PLAY
            CastSeekResumeState.PAUSE -> MediaSeekOptions.RESUME_STATE_PAUSE
          }
        )
        .build()
    rmc.seek(options).bridge(promise, operation = "seek")
  }

  fun getApproximatePosition(promise: Promise<Double>) {
    val rmc = requireRmc(promise) ?: return
    promise.resolve(CastMapping.millisToSeconds(rmc.approximateStreamPosition))
  }

  // ---------------------------------------------------------------------
  // Volume: two layers, device volume primary
  // ---------------------------------------------------------------------

  fun setStreamVolume(volume: Double, promise: Promise<Unit>) {
    requireRmc(promise)?.setStreamVolume(volume)?.bridge(promise, operation = "setStreamVolume")
  }

  fun setStreamMuted(muted: Boolean, promise: Promise<Unit>) {
    requireRmc(promise)?.setStreamMute(muted)?.bridge(promise, operation = "setStreamMuted")
  }

  fun setDeviceVolume(volume: Double, promise: Promise<Unit>) {
    val session = requireSession(promise) ?: return
    try {
      session.setVolume(volume)
      promise.resolve(Unit)
    } catch (e: IOException) {
      promise.reject(IllegalStateException("[native] setDeviceVolume failed: ${e.message}", e))
    }
  }

  fun setDeviceMuted(muted: Boolean, promise: Promise<Unit>) {
    val session = requireSession(promise) ?: return
    try {
      session.setMute(muted)
      promise.resolve(Unit)
    } catch (e: IOException) {
      promise.reject(IllegalStateException("[native] setDeviceMuted failed: ${e.message}", e))
    }
  }

  fun getDeviceVolume(promise: Promise<NativeDeviceVolumeEvent>) {
    val session = requireSession(promise) ?: return
    promise.resolve(NativeDeviceVolumeEvent(session.volume, session.isMute))
  }

  // ---------------------------------------------------------------------
  // Receiver queue
  // ---------------------------------------------------------------------

  fun queueLoad(
    items: Array<CastQueueItemInput>,
    options: CastQueueLoadOptions,
    promise: Promise<Unit>,
  ) {
    val rmc = requireRmc(promise) ?: return
    val startIndex = CastMapping.index(options.startIndex ?: 0.0)
    val repeatMode =
      CastMapping.toFrameworkRepeatMode(options.repeatMode ?: CastRepeatMode.OFF)
    val startPosition = options.startPosition ?: 0.0
    if (options.credentials == null && options.credentialsType == null) {
      // The classic queue-load API, NOT MediaLoadRequestData+MediaQueueData.
      // Device-found (POCO F4 → Mi Smart Speaker, Default Media Receiver):
      // `MediaQueueData.Builder.setStartTime` does not deliver a start
      // position — the receiver began at 0:00 every time, whatever unit was
      // written (the wire-level `queueData.startTime` is documented in
      // SECONDS on the Web Receiver while this builder takes a long, and the
      // receiver ignored/clamped what arrived). This overload's
      // `playPosition` is milliseconds and lands exactly — it is the call
      // media3's CastPlayer ships on, which is as production-proven as cast
      // APIs get.
      rmc
        .queueLoad(
          items.map(::queueItem).toTypedArray(),
          startIndex,
          repeatMode,
          CastMapping.secondsToMillis(startPosition),
          null,
        )
        .bridge(promise, family = "load-failed", operation = "queueLoad")
      return
    }
    // Credentials only travel on MediaLoadRequestData, so that path stays for
    // custom receivers that need them. The start position rides ON THE START
    // ITEM (MediaQueueItem times are SECONDS, honored by receivers) because
    // queueData.startTime is broken — see above. Caveat, documented here on
    // purpose: an item-level startTime is sticky, so jumping back to the
    // start item later in the session resumes it at this offset rather
    // than 0.
    val queueData =
      MediaQueueData.Builder()
        .setItems(
          items.mapIndexed { index, input ->
            if (index == startIndex && startPosition > 0) {
              MediaQueueItem.Builder(queueItem(input)).setStartTime(startPosition).build()
            } else {
              queueItem(input)
            }
          }
        )
        .setStartIndex(startIndex)
        .setRepeatMode(repeatMode)
        .build()
    val request =
      MediaLoadRequestData.Builder()
        .setQueueData(queueData)
        .apply {
          options.credentials?.let { setCredentials(it) }
          options.credentialsType?.let { setCredentialsType(it) }
        }
        .build()
    rmc.load(request).bridge(promise, family = "load-failed", operation = "queueLoad")
  }

  fun queueInsert(
    items: Array<CastQueueItemInput>,
    beforeItemId: Double?,
    promise: Promise<Unit>,
  ) {
    val rmc = requireRmc(promise) ?: return
    rmc
      .queueInsertItems(
        items.map(::queueItem).toTypedArray(),
        beforeItemId?.let(CastMapping::queueItemId) ?: MediaQueueItem.INVALID_ITEM_ID,
        null
      )
      .bridge(promise, operation = "queueInsert")
  }

  fun queueRemove(itemIds: DoubleArray, promise: Promise<Unit>) {
    val rmc = requireRmc(promise) ?: return
    rmc
      .queueRemoveItems(IntArray(itemIds.size) { CastMapping.queueItemId(itemIds[it]) }, null)
      .bridge(promise, operation = "queueRemove")
  }

  fun queueReorder(itemIds: DoubleArray, beforeItemId: Double?, promise: Promise<Unit>) {
    val rmc = requireRmc(promise) ?: return
    rmc
      .queueReorderItems(
        IntArray(itemIds.size) { CastMapping.queueItemId(itemIds[it]) },
        beforeItemId?.let(CastMapping::queueItemId) ?: MediaQueueItem.INVALID_ITEM_ID,
        null
      )
      .bridge(promise, operation = "queueReorder")
  }

  fun queueJumpTo(itemId: Double, position: Double?, promise: Promise<Unit>) {
    val rmc = requireRmc(promise) ?: return
    val result =
      if (position != null) {
        rmc.queueJumpToItem(
          CastMapping.queueItemId(itemId),
          CastMapping.secondsToMillis(position),
          null,
        )
      } else {
        rmc.queueJumpToItem(CastMapping.queueItemId(itemId), null)
      }
    result.bridge(promise, operation = "queueJumpTo")
  }

  fun queueSetRepeatMode(mode: CastRepeatMode, promise: Promise<Unit>) {
    val rmc = requireRmc(promise) ?: return
    rmc
      .queueSetRepeatMode(CastMapping.toFrameworkRepeatMode(mode), null)
      .bridge(promise, operation = "queueSetRepeatMode")
  }

  fun getQueueItemIds(promise: Promise<DoubleArray>) {
    val rmc = requireRmc(promise) ?: return
    val ids = rmc.mediaQueue.itemIds
    promise.resolve(DoubleArray(ids.size) { ids[it].toDouble() })
  }

  fun fetchQueueSlice(
    startIndex: Double,
    count: Double,
    promise: Promise<Array<CastQueueItemSnapshot>>,
  ) {
    val rmc = requireRmc(promise) ?: return
    val queue = rmc.mediaQueue
    val start = CastMapping.index(startIndex)
    val end = (start + CastMapping.index(count)).coerceAtMost(queue.itemCount)
    if (start >= end) {
      promise.resolve(emptyArray())
      return
    }
    val slice =
      Array(end - start) { offset ->
        val index = start + offset
        // `fetchIfNeeded = true`: a cache miss returns null AND requests the
        // item; the MediaQueue callback fires `queueChanged` when it lands —
        // the caller re-reads then. One paged call, never per-item RPCs.
        val item = queue.getItemAtIndex(index, true)
        val media = item?.media
        val metadata = media?.metadata
        CastQueueItemSnapshot(
          itemId = queue.itemIdAtIndex(index).toDouble(),
          resolved = item != null,
          url = media?.contentId,
          mimeType = media?.contentType,
          title = metadata?.getString(MediaMetadata.KEY_TITLE),
          artist = metadata?.getString(MediaMetadata.KEY_ARTIST),
        )
      }
    promise.resolve(slice)
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private fun attach(session: CastSession) {
    if (attachedSession === session) return
    detach()
    hadMediaStatus = false
    attachedSession = session
    session.addCastListener(castDeviceListener)
    val rmc = session.remoteMediaClient ?: return
    attachedRmc = rmc
    rmc.registerCallback(rmcCallback)
    rmc.mediaQueue.registerCallback(queueCallback)
    // Prime the media channel. Device-found (POCO F4, rejoined session): a
    // session that REJOINS a running receiver app has no media status yet,
    // and a queueLoad issued in that state never settled — no ack, no error,
    // handoff stuck. media3's CastPlayer issues exactly this requestStatus()
    // when a session becomes available; after it, commands flow. Best-effort
    // by design: on a fresh session there is nothing to report and the
    // result is irrelevant.
    rmc.requestStatus().setResultCallback { /* prime only */ }
  }

  private fun detach() {
    attachedRmc?.let { rmc ->
      rmc.mediaQueue.unregisterCallback(queueCallback)
      rmc.unregisterCallback(rmcCallback)
    }
    attachedRmc = null
    attachedSession?.removeCastListener(castDeviceListener)
    attachedSession = null
    hadMediaStatus = false
  }

  private fun requireRmc(promise: Promise<*>): RemoteMediaClient? {
    val rmc = attachedRmc
    if (rmc == null) {
      promise.reject(
        IllegalStateException(
          "[no-session] No connected cast session. Call requestSession() first."
        )
      )
    }
    return rmc
  }

  private fun requireSession(promise: Promise<*>): CastSession? {
    val session = attachedSession
    if (session == null) {
      promise.reject(
        IllegalStateException(
          "[no-session] No connected cast session. Call requestSession() first."
        )
      )
    }
    return session
  }

  private fun scheduleDevicesEmit() {
    handler.removeCallbacks(devicesEmit)
    handler.postDelayed(devicesEmit, DEVICES_DEBOUNCE_MS)
  }

  private fun discoveredDevices(): Array<CastDeviceInfo> =
    mediaRouter.routes
      .mapNotNull { route -> route.extras?.let(CastDevice::getFromBundle) }
      .distinctBy { it.deviceId }
      .map { device ->
        CastDeviceInfo(
          id = device.deviceId,
          name = device.friendlyName ?: device.deviceId,
          model = device.modelName,
        )
      }
      .toTypedArray()

  private fun deviceInfo(session: CastSession): CastDeviceInfo? =
    session.castDevice?.let { device ->
      CastDeviceInfo(device.deviceId, device.friendlyName ?: device.deviceId, device.modelName)
    }

  private fun currentDeviceInfo(): CastDeviceInfo? =
    castContext.sessionManager.currentCastSession?.let(::deviceInfo)

  private fun emitSession(
    type: CastSessionEventType,
    session: CastSession,
    errorCode: Int? = null,
  ) {
    emitter.onSession(
      NativeCastSessionEvent(type, errorCode?.toDouble(), deviceInfo(session))
    )
  }

  private fun statusEvent(rmc: RemoteMediaClient): NativeCastMediaStatusEvent? {
    val status = rmc.mediaStatus ?: return null
    val durationMs = rmc.streamDuration
    return NativeCastMediaStatusEvent(
      playerState = CastMapping.playerState(status.playerState),
      idleReason = CastMapping.idleReason(status.idleReason),
      position = CastMapping.millisToSeconds(rmc.approximateStreamPosition),
      duration =
        durationMs.takeIf { it != MediaInfo.UNKNOWN_DURATION && it > 0 }
          ?.let(CastMapping::millisToSeconds),
      playbackRate = status.playbackRate,
      streamVolume = status.streamVolume,
      streamMuted = status.isMute,
      repeatMode = CastMapping.repeatMode(status.queueRepeatMode),
      currentItemId =
        status.currentItemId.takeIf { it != MediaQueueItem.INVALID_ITEM_ID }?.toDouble(),
      queueItemCount = status.queueItemCount.toDouble(),
    )
  }

  private fun mediaInfo(source: CastMediaSource): MediaInfo {
    val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_MUSIC_TRACK)
    source.metadata?.let { m ->
      m.title?.let { metadata.putString(MediaMetadata.KEY_TITLE, it) }
      m.artist?.let { metadata.putString(MediaMetadata.KEY_ARTIST, it) }
      m.albumTitle?.let { metadata.putString(MediaMetadata.KEY_ALBUM_TITLE, it) }
      m.artworkUrl?.let { metadata.addImage(WebImage(Uri.parse(it))) }
    }
    return MediaInfo.Builder(source.url)
      .setContentType(source.mimeType)
      .setStreamType(
        if (source.live == true) MediaInfo.STREAM_TYPE_LIVE else MediaInfo.STREAM_TYPE_BUFFERED
      )
      .setMetadata(metadata)
      .apply {
        source.duration?.takeIf { it > 0 && it.isFinite() }?.let {
          setStreamDuration(CastMapping.secondsToMillis(it))
        }
      }
      .build()
  }

  private fun queueItem(input: CastQueueItemInput): MediaQueueItem =
    MediaQueueItem.Builder(mediaInfo(input.source))
      // Receiver-side advancement: autoplay is what lets the queue keep going
      // with the phone asleep.
      .setAutoplay(input.autoplay ?: true)
      .apply {
        // MediaQueueItem times are SECONDS (double) — unlike
        // MediaLoadRequestData/MediaSeekOptions, which are ms. Negative or
        // non-finite values would throw IllegalArgumentException in the
        // builder, so they are dropped rather than forwarded.
        input.preloadTime?.takeIf { it >= 0 && it.isFinite() }?.let { setPreloadTime(it) }
        input.startPosition?.takeIf { it >= 0 && it.isFinite() }?.let { setStartTime(it) }
      }
      .build()

  /**
   * Settle a promise from a framework [PendingResult]. Success/failure comes
   * from the result status; `family` names the error-taxonomy code used on
   * failure (default `native`, the catch-all for transport commands).
   *
   * Bounded on purpose (device-found, POCO F4 → Mi Smart Speaker,
   * 2026-08-14): a command issued while the receiver's media session is
   * dead/dying can leave its PendingResult unsettled indefinitely — a
   * `queueJumpTo` sat pending for FOUR MINUTES and only settled (CANCELED,
   * 2002) when the session itself ended, so every queue tap "silently did
   * nothing". The timeout overload delivers `CastStatusCodes.TIMEOUT` (15)
   * instead: a typed error in seconds, never a silent hang.
   */
  private fun PendingResult<RemoteMediaClient.MediaChannelResult>.bridge(
    promise: Promise<Unit>,
    family: String = "native",
    operation: String,
  ) {
    setResultCallback(
      { result ->
        val status = result.status
        if (status.isSuccess || status.statusCode == CastStatusCodes.REPLACED) {
          // REPLACED (2103) is not a failure: a newer request of the same type
          // superseded this one — the notification's seek bar routinely fires
          // two seeks milliseconds apart (device-observed), and rejecting the
          // first would put a scary error on screen for a seek that landed.
          promise.resolve(Unit)
        } else {
          val hint =
            if (status.statusCode == CastStatusCodes.TIMEOUT) {
              " — no result within ${RESULT_TIMEOUT_MS} ms; the receiver's" +
                " media session may be gone"
            } else {
              ""
            }
          // getStatusCodeString gives the SDK's own name for the code
          // ("CANCELED", "TIMEOUT", …) — a message a human can read without
          // the CastStatusCodes table open.
          promise.reject(
            IllegalStateException(
              "[$family] $operation failed: " +
                "${CastStatusCodes.getStatusCodeString(status.statusCode)} " +
                "(status=${status.statusCode})" +
                (status.statusMessage?.let { " ($it)" } ?: "") + hint
            )
          )
        }
      },
      RESULT_TIMEOUT_MS,
      TimeUnit.MILLISECONDS,
    )
  }

  private companion object {
    const val DEVICES_DEBOUNCE_MS = 250L

    /** The package the cast framework (and its route provider) lives in. */
    const val GMS_PACKAGE = "com.google.android.gms"

    /**
     * Upper bound on any [PendingResult] this controller bridges. A healthy
     * LAN command acks well under a second; ten seconds of silence means the
     * media channel is not answering (see [bridge]'s doc for the measured
     * failure). Comfortably under `wireCastHandoff`'s 15 s handoff bound so
     * a hung queueLoad surfaces natively first, with the sharper message.
     */
    const val RESULT_TIMEOUT_MS = 10_000L
  }
}
