package com.rnmediacast

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * The `OptionsProvider` this package ships. The Cast framework instantiates
 * it reflectively from the app manifest's
 * `com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME`
 * meta-data — added by the Expo plugin, or pasted by hand in bare projects
 * (README). It is deliberately NOT merged in from this library's own
 * manifest: an AAR forcing its provider on every consumer would collide with
 * apps that already have one (manifest-merger conflict), exactly the
 * media-button-receiver reasoning in `@rn-media/media-session`.
 */
class RnMediaCastOptionsProvider : OptionsProvider {

  override fun getCastOptions(context: Context): CastOptions =
    CastOptions.Builder()
      .setReceiverApplicationId(receiverApplicationId(context))
      .setCastMediaOptions(
        CastMediaOptions.Builder()
          // BOTH surfaces off: this library's media-session package is the
          // single owner of the app's MediaSession and notification (the
          // fan-out contract). The framework's built-ins would put a second
          // session + notification on screen for the same playback.
          .setMediaSessionEnabled(false)
          .setNotificationOptions(null)
          .build()
      )
      // Output-switcher trio (developers.google.com/cast/docs/android_sender/
      // output_switcher): stream transfer both directions, plus the Cast
      // 22.3.0 behaviour of the cast icon opening the system switcher on
      // Android 13+. All three are inert without the app-manifest
      // `MediaTransferReceiver` the plugin adds.
      .setRemoteToLocalEnabled(true)
      .setSessionTransferEnabled(true)
      .setShowSystemOutputSwitcherOnCastIconClick(true)
      // Rejoin a live session after the app restarts (the SDK default, stated
      // here because Phase 3's handoff machine depends on resumed sessions
      // arriving via `onSessionResumed`).
      .setResumeSavedSession(true)
      // FALSE, device-proven (POCO F4 → Mi Smart Speaker): with this true,
      // `endCurrentSession(stopCasting = false)` STILL issued stopApplication
      // — the option overrides the parameter, killing "disconnect and keep
      // playing" (logcat: `stopApplication CC1AD845` on a false-parameter
      // end). With it false, the parameter decides; the transfer-back path
      // additionally stops receiver MEDIA explicitly (endSession in
      // CastController), so no path leaks a receiver that should be silent.
      .setStopReceiverApplicationWhenEndingSession(false)
      .build()

  override fun getAdditionalSessionProviders(
    context: Context
  ): MutableList<SessionProvider>? = null

  internal companion object {
    /** App-manifest meta-data key for the receiver application id. */
    const val META_RECEIVER_APP_ID = "com.rnmediacast.RECEIVER_APPLICATION_ID"

    /**
     * Manifest meta-data, falling back to the Default Media Receiver — the
     * zero-config default (a styled/custom receiver needs a Cast Console
     * registration, and then either the meta-data or
     * `initialize({ receiverApplicationId })`).
     */
    fun receiverApplicationId(context: Context): String {
      val metaData =
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.getApplicationInfo(
              context.packageName,
              PackageManager.ApplicationInfoFlags.of(
                PackageManager.GET_META_DATA.toLong()
              )
            )
          } else {
            @Suppress("DEPRECATION")
            context.packageManager.getApplicationInfo(
              context.packageName,
              PackageManager.GET_META_DATA
            )
          }.metaData
        } catch (_: PackageManager.NameNotFoundException) {
          // Own package always exists; this is a defensive impossibility.
          null
        }
      return metaData?.getString(META_RECEIVER_APP_ID)
        ?: CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
    }
  }
}
