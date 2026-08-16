// NOT a free choice: nitrogen hardcodes the implementation class's JNI
// descriptor as `Lcom/margelo/nitro/<androidNamespace>/<implementationClassName>;`
// (see nitrogen/generated/android/RnMediaAudioSessionOnLoad.cpp). Anywhere else
// and `NitroModules.createHybridObject('RnMediaAudioSession')` throws
// ClassNotFoundException at runtime, with nothing failing at build time.
package com.margelo.nitro.rnmediaaudiosession

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Android audio focus + becoming-noisy + device-route arbiter.
 *
 * Threading contract
 * ------------------
 * `AudioManager` calls the focus listener and the device callback on the
 * [Handler] we hand it — here, always the main looper, so all focus-state
 * mutation happens on one thread and needs no extra locking. The becoming-noisy
 * receiver is likewise registered with that handler. Listener *registries* are
 * still concurrent maps because `addXListener`/`removeXListener` arrive on the
 * JS thread.
 *
 * Nitro callbacks may be invoked from any thread — Nitro schedules the actual
 * JS call onto the JS thread itself
 * (https://nitro.margelo.com/docs/types/callbacks).
 */
class HybridRnMediaAudioSession : HybridRnMediaAudioSessionSpec() {

  private val appContext: Context =
    (NitroModules.applicationContext
      ?: throw IllegalStateException(
        "[audio-session] No ReactApplicationContext available. " +
          "Is react-native-nitro-modules installed correctly?"
      ))
      // Always the *application* context: this object outlives any Activity and
      // registers receivers, so holding an Activity here would leak it.
      .applicationContext

  private val audioManager: AudioManager =
    appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val handler = Handler(Looper.getMainLooper())

  private val nextListenerId = AtomicLong(1)
  private val interruptionListeners =
    ConcurrentHashMap<Long, (NativeInterruptionEvent) -> Unit>()
  private val becomingNoisyListeners = ConcurrentHashMap<Long, () -> Unit>()
  private val routeChangeListeners =
    ConcurrentHashMap<Long, (NativeRouteChangeEvent) -> Unit>()

  /** Last applied config; `activate()` builds its focus request from this. */
  @Volatile
  private var config: AndroidAudioSessionConfig = DEFAULT_CONFIG

  /** Main-thread only. */
  private var focusRequest: FocusRequest? = null

  /** Main-thread only. `true` between a transient loss and the matching gain. */
  private var lostFocusTransiently = false

  /** Main-thread only. `true` while we hold (or believe we hold) audio focus. */
  private var isActive = false

  /** Main-thread only. Guards receiver/callback registration symmetry. */
  private var isListeningToRoute = false

  private val focusListener =
    AudioManager.OnAudioFocusChangeListener { focusChange ->
      when (focusChange) {
        // Permanent loss. The system will not give focus back on its own; we
        // are expected to have abandoned it. Never resumable.
        AudioManager.AUDIOFOCUS_LOSS -> {
          lostFocusTransiently = false
          // Focus is gone for good, so the session is no longer "active" in any
          // meaningful sense. `focusRequest` is kept so an explicit
          // `deactivate()` still abandons cleanly; both paths are idempotent.
          // The route listeners are *not* torn down here if anything is still
          // subscribed — they are derived from the listener set (see
          // [syncRouteListening]), the same as on iOS, where a permanent
          // interruption does not silence `becomingNoisy` either.
          isActive = false
          syncRouteListening()
          emitInterruption(begin = true, type = AudioInterruptionType.PAUSE, permanent = true)
        }
        // Transient loss (a call, a nav prompt with exclusive focus, ...).
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
          lostFocusTransiently = true
          emitInterruption(begin = true, type = AudioInterruptionType.PAUSE, permanent = false)
        }
        // Only delivered when the request set `setWillPauseWhenDucked(true)`;
        // otherwise the platform ducks us without telling us (API 26+).
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
          lostFocusTransiently = true
          emitInterruption(begin = true, type = AudioInterruptionType.DUCK, permanent = false)
        }
        // NOTE: focus events are delivered to the focus *holder* regardless of
        // whether it is actually playing — a paused app that kept its focus
        // request (as it should across a short pause) still receives the full
        // LOSS_TRANSIENT/GAIN cycle when another app borrows focus. So
        // `shouldResume` below can only mean "the system permits resuming
        // after a transient loss", never "you were playing". This layer is
        // player-agnostic and cannot know; the was-it-playing latch lives in
        // `wireAudioSession` (see AudioSessionPlayerLike.isPlaying), which is
        // the layer that can ask the player. (#45)
        AudioManager.AUDIOFOCUS_GAIN -> {
          val shouldResume = lostFocusTransiently
          lostFocusTransiently = false
          emitInterruption(begin = false, shouldResume = shouldResume)
        }
        else -> Unit
      }
    }

  /**
   * Registered while the session is active **or** anything is subscribed — see
   * [syncRouteListening]. `ACTION_AUDIO_BECOMING_NOISY` is sticky-free and
   * cheap, but a forgotten receiver on a long-lived application context is a
   * leak, so registration stays strictly derived from that pair of facts.
   */
  private val becomingNoisyReceiver =
    object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
        becomingNoisyListeners.values.forEach { it() }
      }
    }

  /**
   * Android has no `AVAudioSession.routeChangeNotification`; the closest
   * event-driven equivalent is [AudioDeviceCallback] (API 23+), which reports
   * output devices appearing/disappearing.
   */
  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
        if (addedDevices.isNullOrEmpty()) return
        emitRouteChange(AudioRouteChangeReason.NEWDEVICEAVAILABLE)
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
        if (removedDevices.isNullOrEmpty()) return
        emitRouteChange(AudioRouteChangeReason.OLDDEVICEUNAVAILABLE)
      }
    }

  // -------------------------------------------------------------------------
  // Spec
  // -------------------------------------------------------------------------

  override fun configure(config: AudioSessionConfig): Promise<Unit> {
    // Nothing here can fail or block, but the signature is a Promise so iOS can
    // reject on `setCategory` errors. Resolve immediately.
    //
    // An iOS-only config leaves the Android side exactly as it was — the halves
    // of `AudioSessionConfig` are independent, not a full replacement.
    config.android?.let { this.config = it }
    return Promise.resolved(Unit)
  }

  override fun activate(): Promise<Boolean> {
    val promise = Promise<Boolean>()
    runOnMain {
      try {
        val request = buildFocusRequest(config)
        focusRequest = request
        val result =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.requestAudioFocus(request.platformRequest!!)
          } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
              focusListener,
              AudioManager.STREAM_MUSIC,
              request.legacyDurationHint
            )
          }
        val granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        isActive = granted
        syncRouteListening()
        promise.resolve(granted)
      } catch (error: Throwable) {
        promise.reject(error)
      }
    }
    return promise
  }

  override fun deactivate(): Promise<Unit> {
    val promise = Promise<Unit>()
    runOnMain {
      try {
        isActive = false
        syncRouteListening()
        lostFocusTransiently = false
        val request = focusRequest
        if (request != null) {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.abandonAudioFocusRequest(request.platformRequest!!)
          } else {
            @Suppress("DEPRECATION") audioManager.abandonAudioFocus(focusListener)
          }
          focusRequest = null
        }
        promise.resolve(Unit)
      } catch (error: Throwable) {
        promise.reject(error)
      }
    }
    return promise
  }

  override fun addInterruptionListener(
    listener: (event: NativeInterruptionEvent) -> Unit
  ): Double = register(interruptionListeners, listener)

  override fun removeInterruptionListener(listenerId: Double) {
    interruptionListeners.remove(listenerId.toLong())
  }

  override fun addBecomingNoisyListener(listener: () -> Unit): Double {
    val id = register(becomingNoisyListeners, listener)
    // The receiver is derived from the listener set, not from `activate()`:
    // subscribing must be enough to be told, exactly as it is on iOS, where the
    // `AVAudioSession` route-change observer is not gated on activation either.
    runOnMain { syncRouteListening() }
    return id
  }

  override fun removeBecomingNoisyListener(listenerId: Double) {
    becomingNoisyListeners.remove(listenerId.toLong())
    runOnMain { syncRouteListening() }
  }

  override fun addRouteChangeListener(
    listener: (event: NativeRouteChangeEvent) -> Unit
  ): Double {
    val id = register(routeChangeListeners, listener)
    runOnMain { syncRouteListening() }
    return id
  }

  override fun removeRouteChangeListener(listenerId: Double) {
    routeChangeListeners.remove(listenerId.toLong())
    runOnMain { syncRouteListening() }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private fun <T : Any> register(into: ConcurrentHashMap<Long, T>, listener: T): Double {
    val id = nextListenerId.getAndIncrement()
    into[id] = listener
    return id.toDouble()
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
  }

  /**
   * Register (or release) the becoming-noisy receiver and the device callback
   * so that their lifetime is the union of "we hold focus" and "somebody is
   * subscribed".
   *
   * The listener half is what makes the JS contract identical on both
   * platforms: on iOS these events come from the `AVAudioSession`
   * route-change notification, which fires whether or not the session was ever
   * activated, so an Android build that only listened between `activate()` and
   * `deactivate()` was a silent no-op for anyone who subscribed first — and
   * went permanently silent after an `AUDIOFOCUS_LOSS`. The `isActive` half is
   * kept so an app that subscribes *after* activating (the common order in a
   * player) is still covered without depending on subscription order.
   *
   * Main-thread only.
   */
  private fun syncRouteListening() {
    val wanted =
      isActive || becomingNoisyListeners.isNotEmpty() || routeChangeListeners.isNotEmpty()
    if (wanted) startListeningToRoute() else stopListeningToRoute()
  }

  private fun startListeningToRoute() {
    if (isListeningToRoute) return
    isListeningToRoute = true
    val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
    // Android 13+ requires an explicit export flag. `ACTION_AUDIO_BECOMING_NOISY`
    // is a protected system broadcast, so NOT_EXPORTED is both allowed and the
    // tightest choice.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      appContext.registerReceiver(
        becomingNoisyReceiver,
        filter,
        null,
        handler,
        Context.RECEIVER_NOT_EXPORTED
      )
    } else {
      appContext.registerReceiver(becomingNoisyReceiver, filter, null, handler)
    }
    audioManager.registerAudioDeviceCallback(deviceCallback, handler)
  }

  private fun stopListeningToRoute() {
    if (!isListeningToRoute) return
    isListeningToRoute = false
    // `unregisterReceiver` throws if the receiver was never registered; the
    // `isListeningToRoute` flag makes the pairing exact, and the try/catch is a
    // backstop for a context torn down underneath us.
    try {
      appContext.unregisterReceiver(becomingNoisyReceiver)
    } catch (_: IllegalArgumentException) {
      // Already gone with the context — nothing to release.
    }
    audioManager.unregisterAudioDeviceCallback(deviceCallback)
  }

  private fun emitInterruption(
    begin: Boolean,
    type: AudioInterruptionType = AudioInterruptionType.PAUSE,
    shouldResume: Boolean = false,
    permanent: Boolean = false
  ) {
    if (interruptionListeners.isEmpty()) return
    val event = NativeInterruptionEvent(begin, type, shouldResume, permanent)
    interruptionListeners.values.forEach { it(event) }
  }

  private fun emitRouteChange(reason: AudioRouteChangeReason) {
    if (routeChangeListeners.isEmpty()) return
    val event = NativeRouteChangeEvent(reason)
    routeChangeListeners.values.forEach { it(event) }
  }

  /**
   * A focus request plus the pre-API-26 duration hint that expresses the same
   * thing.
   *
   * [AudioFocusRequest] is API 26+. This package's `minSdkVersion` is 24 (it
   * follows `@rn-media/player`), so API 24/25 falls back to
   * `requestAudioFocus(listener, streamType, durationHint)` — the API Google
   * documents for "Android 7.1 (API level 25) and lower"
   * (https://developer.android.com/media/optimize/audio-focus).
   *
   * We deliberately do NOT pull in `androidx.media`'s `AudioFocusRequestCompat`
   * / `AudioManagerCompat`: media3 1.6.0 superseded those
   * ("Add `AudioManagerCompat` and `AudioFocusRequestCompat` to replace the
   * equivalent classes in `androidx.media`" — androidx/media RELEASENOTES 1.6.0),
   * and depending on media3 here would couple this package to the media3
   * version that `@rn-media/media-session` picks. Two SDK levels of `if` is
   * cheaper than a shared dependency.
   */
  private class FocusRequest(
    val platformRequest: AudioFocusRequest?,
    val legacyDurationHint: Int
  )

  private fun buildFocusRequest(config: AndroidAudioSessionConfig): FocusRequest {
    val durationHint =
      when (config.focusGain) {
        AndroidAudioFocusGain.GAIN -> AudioManager.AUDIOFOCUS_GAIN
        AndroidAudioFocusGain.GAINTRANSIENT -> AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        AndroidAudioFocusGain.GAINTRANSIENTMAYDUCK ->
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        AndroidAudioFocusGain.GAINTRANSIENTEXCLUSIVE ->
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
      }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return FocusRequest(null, durationHint)
    }

    val attributes =
      AudioAttributes.Builder()
        .setUsage(config.usage.toPlatformUsage())
        .setContentType(config.contentType.toPlatformContentType())
        .build()

    val native =
      AudioFocusRequest.Builder(durationHint)
        .setAudioAttributes(attributes)
        .setWillPauseWhenDucked(config.willPauseWhenDucked)
        .setOnAudioFocusChangeListener(focusListener, handler)
        .build()

    return FocusRequest(native, durationHint)
  }

  private companion object {
    val DEFAULT_CONFIG =
      AndroidAudioSessionConfig(
        AndroidAudioUsage.MEDIA,
        AndroidAudioContentType.MUSIC,
        AndroidAudioFocusGain.GAIN,
        false
      )

    /** `USAGE_ASSISTANT` is API 26; every caller is already inside an O guard. */
    @RequiresApi(Build.VERSION_CODES.O)
    fun AndroidAudioUsage.toPlatformUsage(): Int =
      when (this) {
        AndroidAudioUsage.UNKNOWN -> AudioAttributes.USAGE_UNKNOWN
        AndroidAudioUsage.MEDIA -> AudioAttributes.USAGE_MEDIA
        AndroidAudioUsage.VOICECOMMUNICATION -> AudioAttributes.USAGE_VOICE_COMMUNICATION
        AndroidAudioUsage.ALARM -> AudioAttributes.USAGE_ALARM
        AndroidAudioUsage.NOTIFICATION -> AudioAttributes.USAGE_NOTIFICATION
        AndroidAudioUsage.ASSISTANCEACCESSIBILITY ->
          AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY
        AndroidAudioUsage.ASSISTANCENAVIGATIONGUIDANCE ->
          AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
        AndroidAudioUsage.ASSISTANCESONIFICATION ->
          AudioAttributes.USAGE_ASSISTANCE_SONIFICATION
        AndroidAudioUsage.GAME -> AudioAttributes.USAGE_GAME
        AndroidAudioUsage.ASSISTANT -> AudioAttributes.USAGE_ASSISTANT
      }

    fun AndroidAudioContentType.toPlatformContentType(): Int =
      when (this) {
        AndroidAudioContentType.UNKNOWN -> AudioAttributes.CONTENT_TYPE_UNKNOWN
        AndroidAudioContentType.SPEECH -> AudioAttributes.CONTENT_TYPE_SPEECH
        AndroidAudioContentType.MUSIC -> AudioAttributes.CONTENT_TYPE_MUSIC
        AndroidAudioContentType.MOVIE -> AudioAttributes.CONTENT_TYPE_MOVIE
        AndroidAudioContentType.SONIFICATION -> AudioAttributes.CONTENT_TYPE_SONIFICATION
      }
  }
}
